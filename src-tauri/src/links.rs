//! Clicking things in the terminal.
//!
//! Everything printed into a terminal is untrusted — it's whatever a program,
//! or a repository, decided to emit. So the rule here is that the frontend
//! never gets to name a program or a scheme: it can ask for an http(s) page, or
//! for a path that already exists to be shown in Finder, and nothing else.

use serde::Serialize;
use std::path::{Path, PathBuf};

/// Hand a link to the default browser.
///
/// http and https only. `open` will launch an application for any scheme
/// registered on the machine, so a wider list would mean a click on terminal
/// output could start an arbitrary app — and `file://` would hand it any path
/// on disk. Control and whitespace characters are refused too: a URL carrying a
/// newline isn't one.
///
/// No shell is involved (`Command` execs directly), and the scheme check means
/// the argument can never begin with `-` and be read as a flag.
#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    if !is_web_url(&url) {
        return Err(format!("refusing to open {url}"));
    }
    spawn_open(&["-u", &url])
}

/// Split out from the command so it can be tested without a browser opening.
fn is_web_url(url: &str) -> bool {
    (url.starts_with("http://") || url.starts_with("https://"))
        && !url.chars().any(|c| c.is_control() || c.is_whitespace())
}

/// Show a file in Finder — for paths that exist but sit outside the project,
/// and for the right-click menu, which offers this on every file the app names.
///
/// Canonicalised first, so what gets revealed is a real path rather than
/// whatever `../..` walk the terminal printed, and it always starts with `/`
/// and so can't be read as a flag.
#[tauri::command]
pub fn reveal_path(path: String) -> Result<(), String> {
    let abs = nearest_existing(Path::new(&path)).ok_or_else(|| format!("no such path: {path}"))?;
    let abs = abs.to_str().ok_or("path is not valid UTF-8")?;
    spawn_open(&["-R", abs])
}

/// The path itself when it's there, and otherwise the closest folder above it
/// that is.
///
/// The right-click menu is offered on rows that name files which have since
/// gone — a deleted file in the changes panel is the everyday one — and "open
/// file location" still has an answer for those: the folder it was in. Without
/// this the menu item is one that silently does nothing, which is worse than
/// one that lands a directory away.
///
/// Still only ever a Finder reveal: the ancestor is canonicalised the same way,
/// so what reaches `open -R` is absolute either way.
fn nearest_existing(path: &Path) -> Option<PathBuf> {
    let mut at = Some(path);
    while let Some(p) = at {
        if let Ok(abs) = std::fs::canonicalize(p) {
            return Some(abs);
        }
        at = p.parent();
    }
    None
}

fn spawn_open(args: &[&str]) -> Result<(), String> {
    std::process::Command::new("/usr/bin/open")
        .args(args)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct ResolvedPath {
    /// echoed back so the frontend can match it to what it asked about
    pub raw: String,
    pub abs: String,
    /// under `cwd`, so the app can open it itself instead of leaving
    pub inside: bool,
}

/// Which of these strings name a file that actually exists.
///
/// The frontend matches anything path-shaped, which necessarily also matches
/// `e.g.` and `v1.2`; this is the pass that decides what was really a path.
/// Directories are excluded, having nothing useful to open.
///
/// Existing is the only test. There's no boundary on where a path may lead,
/// because neither thing a link can do needs one: `inside` is what gates
/// opening a file here, and it's true only under the project root, while
/// everything else is handed to Finder, which reveals but doesn't read.
#[tauri::command]
pub fn resolve_paths(cwd: String, paths: Vec<String>) -> Vec<ResolvedPath> {
    let root = std::fs::canonicalize(&cwd).unwrap_or_else(|_| PathBuf::from(&cwd));
    let home = std::env::var("HOME").ok().map(PathBuf::from);

    paths
        .into_iter()
        .filter_map(|raw| {
            let expanded = expand(&raw, home.as_deref())?;
            let joined = if expanded.is_absolute() {
                expanded
            } else {
                root.join(expanded)
            };
            let abs = std::fs::canonicalize(&joined).ok()?;
            if !abs.is_file() {
                return None;
            }
            let inside = abs.starts_with(&root);
            Some(ResolvedPath {
                raw,
                abs: abs.to_str()?.to_string(),
                inside,
            })
        })
        .collect()
}

// ─── short references ────────────────────────────────────────────────────────

/// Where the short references a terminal prints point.
///
/// `PR #732`, `#732` and `ECL-260` are how agents and status lines name things,
/// and they arrive as plain text: Claude Code strips OSC 8 hyperlinks from its
/// status line (measured — the sequence goes in, the label comes out bare), so
/// a label can only become a link if the terminal already knows where such
/// labels lead. This is that knowledge, for one project.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProjectLinks {
    /// `https://github.com/owner/repo`, from the `origin` remote. None when
    /// there is no remote or it isn't GitHub — numbers then stay plain text.
    pub repo: Option<String>,
    /// the connected Linear workspace, or None: issue keys light up only for
    /// team keys the workspace actually has, so `UTF-8` never does.
    pub linear: Option<LinearRefs>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearRefs {
    /// the workspace slug in `https://linear.app/<slug>/issue/ECL-260`
    pub url_key: String,
    pub teams: Vec<String>,
}

#[tauri::command]
pub async fn project_links(app: tauri::AppHandle, root: String) -> ProjectLinks {
    let r = root.clone();
    let repo = tauri::async_runtime::spawn_blocking(move || crate::git::origin_url(&r))
        .await
        .ok()
        .flatten()
        .and_then(|url| github_repo(&url));
    let linear = crate::linear::refs(&app, &root).await;
    ProjectLinks { repo, linear }
}

/// `https://github.com/owner/repo` for any of the ways a GitHub remote is
/// written — scp-style, ssh://, https://, with or without `.git` — and None for
/// anything else, since a number is only a PR where GitHub is the host.
fn github_repo(remote: &str) -> Option<String> {
    let rest = remote
        .trim()
        .trim_start_matches("ssh://")
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_start_matches("git@")
        .trim_start_matches("git://");
    let path = rest
        .strip_prefix("github.com/")
        .or_else(|| rest.strip_prefix("github.com:"))?;
    let path = path.trim_end_matches('/').trim_end_matches(".git");
    let mut parts = path.split('/');
    let (owner, repo) = (parts.next()?, parts.next()?);
    let ok = |s: &str| {
        !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    };
    if !ok(owner) || !ok(repo) || parts.next().is_some() {
        return None;
    }
    Some(format!("https://github.com/{owner}/{repo}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The filter that decides what lights up. Over-match and prose grows
    /// links; under-match and real paths quietly stay dead — neither shows up
    /// as an error anywhere.
    #[test]
    fn resolve_paths_keeps_files_and_places_them() {
        let base = std::env::temp_dir().join("zero-links-test");
        let root = base.join("repo");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/api.ts"), "x").unwrap();
        std::fs::write(base.join("outside.txt"), "x").unwrap();

        let cwd = root.to_string_lossy().to_string();
        let ask = |p: &str| resolve_paths(cwd.clone(), vec![p.to_string()]);

        let hit = ask("src/api.ts");
        assert_eq!(hit.len(), 1, "a file under the root should resolve");
        assert!(hit[0].inside, "it should open in the editor, not Finder");

        let hit = ask("../outside.txt");
        assert_eq!(hit.len(), 1, "a real file outside the root still resolves");
        assert!(!hit[0].inside, "but it belongs to Finder");

        assert!(ask("src").is_empty(), "a directory has nothing to open");
        assert!(ask("e.g.").is_empty(), "prose that merely looks path-shaped");
        assert!(ask("v1.2").is_empty(), "nor a version number");

        // an absolute path is taken as given rather than joined to the root
        let abs = root.join("src/api.ts").to_string_lossy().to_string();
        assert_eq!(ask(&abs).len(), 1);

        std::fs::remove_dir_all(&base).unwrap();
    }

    /// What the right-click menu leans on: a file that isn't there any more
    /// still has a location, and it's the folder it was in.
    #[test]
    fn reveal_falls_back_to_the_folder() {
        let base = std::env::temp_dir().join("zero-reveal-test");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("src")).unwrap();
        std::fs::write(base.join("src/api.ts"), "x").unwrap();

        let here = nearest_existing(&base.join("src/api.ts")).unwrap();
        assert!(here.ends_with("src/api.ts"), "a file that exists is itself");

        let gone = nearest_existing(&base.join("src/deleted.ts")).unwrap();
        assert_eq!(gone, std::fs::canonicalize(base.join("src")).unwrap());

        // relative and nowhere near anything: `/` is the last ancestor, and
        // walking past it is what would return nothing
        assert!(nearest_existing(Path::new("no-such-file")).is_none());

        std::fs::remove_dir_all(&base).unwrap();
    }

    /// The security boundary: `open` starts an application for whatever scheme
    /// is registered, and terminal output is untrusted.
    #[test]
    fn open_url_takes_http_and_nothing_else() {
        assert!(is_web_url("https://example.com/pr/1"));
        assert!(is_web_url("http://localhost:1420/"));

        for bad in [
            "file:///etc/passwd",
            "vnc://host",
            "javascript:alert(1)",
            "HTTPS://example.com", // scheme match is exact, not case-folded
            "https://example.com/\na",
            "https://exa mple.com",
        ] {
            assert!(!is_web_url(bad), "{bad} should never reach /usr/bin/open");
        }
    }

    #[test]
    fn github_remotes_in_every_spelling() {
        for r in [
            "git@github.com:zero-editor/zero.git",
            "https://github.com/zero-editor/zero.git",
            "https://github.com/zero-editor/zero",
            "ssh://git@github.com/zero-editor/zero.git",
            "git://github.com/zero-editor/zero.git/",
        ] {
            assert_eq!(github_repo(r).as_deref(), Some("https://github.com/zero-editor/zero"), "{r}");
        }
        for r in [
            "git@gitlab.com:zero-editor/zero.git",
            "https://github.com/zero-editor",
            "https://github.com/zero-editor/zero/extra",
            "https://github.com/zero-editor/ze ro",
            "",
        ] {
            assert_eq!(github_repo(r), None, "{r}");
        }
    }
}

fn expand(raw: &str, home: Option<&Path>) -> Option<PathBuf> {
    if raw.is_empty() || raw.contains('\0') {
        return None;
    }
    match raw.strip_prefix("~/") {
        Some(rest) => home.map(|h| h.join(rest)),
        None if raw == "~" => None,
        None => Some(PathBuf::from(raw)),
    }
}
