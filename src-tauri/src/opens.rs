//! Files and folders handed to the app from outside — Finder's "Open With",
//! a drop on the window, `open -a zero something.md`.
//!
//! Two halves. `classify_opens` answers the question every hand-off raises:
//! is this a project or a file, and if a file, *whose* project? The frontend
//! can't stat a path, so the answer has to come from here. `queue` /
//! `take_open_paths` is the mailbox for macOS's open events, which arrive
//! whenever macOS likes — including before the webview has a listener — so
//! they are held rather than emitted and the frontend drains them when ready.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{Emitter, Manager};

#[derive(Serialize)]
pub struct OpenTarget {
    /// canonicalised, so the same file dropped twice is the same tab
    pub path: String,
    pub dir: bool,
    /// the project to open it under: the path itself for a directory, the
    /// enclosing git repository for a file, or its parent folder outside one
    pub root: String,
}

/// What each of these paths is, and where it belongs. Paths that don't exist
/// are dropped rather than errored: a stale open event names nothing worth
/// interrupting anyone about.
#[tauri::command]
pub fn classify_opens(paths: Vec<String>) -> Vec<OpenTarget> {
    paths
        .into_iter()
        .filter_map(|p| classify(Path::new(&p)))
        .collect()
}

fn classify(path: &Path) -> Option<OpenTarget> {
    let abs = std::fs::canonicalize(path).ok()?;
    let dir = abs.is_dir();
    let root = if dir {
        abs.clone()
    } else {
        let parent = abs.parent()?.to_path_buf();
        git_root(&parent).unwrap_or(parent)
    };
    Some(OpenTarget {
        path: abs.to_str()?.to_string(),
        dir,
        root: root.to_str()?.to_string(),
    })
}

/// The repository this folder sits in, if it sits in one. `.git` is matched by
/// existence rather than by being a directory — in a linked worktree it's a
/// plain file pointing home, and that worktree is still the project.
fn git_root(from: &Path) -> Option<PathBuf> {
    let mut at = Some(from);
    while let Some(p) = at {
        if p.join(".git").exists() {
            return Some(p.to_path_buf());
        }
        at = p.parent();
    }
    None
}

#[derive(Default)]
pub struct PendingOpens(Mutex<Vec<String>>);

/// Hold what macOS handed over and nudge the frontend. The nudge carries no
/// payload on purpose: whoever hears it drains the mailbox, and a launch that
/// missed the nudge entirely still finds the paths waiting when it drains on
/// startup — nothing is lost to timing, at worst something is taken twice as
/// an empty list.
pub fn queue(app: &tauri::AppHandle, paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }
    let state = app.state::<PendingOpens>();
    state
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .extend(paths);
    let _ = app.emit("open-paths", ());
}

#[tauri::command]
pub fn take_open_paths(state: tauri::State<PendingOpens>) -> Vec<String> {
    std::mem::take(&mut *state.0.lock().unwrap_or_else(|e| e.into_inner()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_places_files_and_folders() {
        let base = std::env::temp_dir().join("zero-opens-test");
        let repo = base.join("repo");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        std::fs::create_dir_all(repo.join("docs")).unwrap();
        std::fs::write(repo.join("docs/notes.md"), "x").unwrap();
        std::fs::write(base.join("loose.md"), "x").unwrap();

        let s = |p: &Path| p.to_string_lossy().to_string();
        let ask = |p: PathBuf| classify_opens(vec![s(&p)]);

        // canonicalise the expectations too — /tmp is a symlink on macOS
        let repo_abs = std::fs::canonicalize(&repo).unwrap();
        let base_abs = std::fs::canonicalize(&base).unwrap();

        let hit = ask(repo.clone());
        assert!(hit[0].dir, "a folder is a project");
        assert_eq!(hit[0].root, s(&repo_abs), "and is its own root");

        let hit = ask(repo.join("docs/notes.md"));
        assert!(!hit[0].dir);
        assert_eq!(hit[0].root, s(&repo_abs), "a file in a repo opens the repo");

        let hit = ask(base.join("loose.md"));
        assert_eq!(hit[0].root, s(&base_abs), "outside one, its parent folder");

        assert!(ask(base.join("gone.md")).is_empty(), "missing paths are dropped");

        std::fs::remove_dir_all(&base).unwrap();
    }
}
