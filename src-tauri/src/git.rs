use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::process::{Command, Output};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

// Every command here is `async` on purpose, and every body runs through
// `blocking` on purpose — the two halves of the same fix. Tauri runs a
// *synchronous* command on the main thread, so a `git status` sweep — let
// alone `worktree remove`, which can take seconds — froze the whole window
// while it ran. But `async` alone only moves the block onto tokio's worker
// pool, and that pool is one thread per core: a slow removal, plus the status
// sweep the panel runs per worktree, plus the claude poll, could park every
// worker at once — and then each command in the app, down to opening a file,
// queues behind a deletion. The bodies stay blocking; `blocking` hands them
// the pool that's allowed to be blocked.

/// A repository can name programs for git to run in its own `.git/config`, and
/// several of them fire on plain reads: `core.fsmonitor` and a
/// `filter.<name>.clean` selected by the repo's own `.gitattributes` both run
/// during `git status`. Since the worktree panel is the default sidebar tab and
/// polls status every three seconds, opening a repository that arrived with a
/// `.git` directory already in it — an archive, say — would be enough to run
/// someone else's command. So the automatic, read-only commands blank any local
/// config key that names a program.
///
/// Only keys set *in the repository* are blanked, never the user's own global
/// config: overriding that would quietly disable tools they chose to install.
/// And only the drive-by commands are hardened — staging, committing and
/// pushing leave config alone, because a clean filter that's been blanked would
/// stage the wrong bytes, and hooks are the whole point of committing. Those
/// are deliberate acts on a repository you've already decided to work in; the
/// hardened ones run whether you asked or not.
const EXEC_KEY_SUFFIX: &[&str] = &[
    "command", "hook", "hookspath", "helper", "pager", "editor", "program",
    "driver", "textconv", "clean", "smudge", "process", "fsmonitor",
    "external", "uploadpack", "receivepack",
];

/// Re-reading a repository's config on every poll would double the git
/// processes the panel spawns, so the answer is cached briefly. Config changes
/// mid-session are picked up within this long.
const OVERRIDE_TTL: Duration = Duration::from_secs(10);

type OverrideCache = Mutex<HashMap<String, (Instant, Arc<Vec<String>>)>>;

fn git_base(cwd: &str) -> Command {
    // launchd hands GUI apps a minimal PATH; git's helpers (ssh, credential
    // helpers, hooks) live in the usual places, so put them back
    let path = std::env::var("PATH").unwrap_or_default();
    let augmented = format!("/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:{}", path);
    let mut cmd = Command::new("git");
    cmd.current_dir(cwd).env("PATH", augmented);
    // No terminal is attached, so a credential prompt could only hang: fail
    // instead, and let the caller report it.
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd
}

fn finish(out: Output) -> Result<String, String> {
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
        return Err(if err.is_empty() { stdout } else { err });
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// `-c key=` for every program-naming key the repository sets. Listing config
/// executes nothing, which is what makes this safe to do first.
fn exec_key_overrides(cwd: &str) -> Arc<Vec<String>> {
    static CACHE: OnceLock<OverrideCache> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);

    if let Some((at, args)) = cache.lock().unwrap().get(cwd) {
        if at.elapsed() < OVERRIDE_TTL {
            return args.clone();
        }
    }

    let mut keys: HashSet<String> = HashSet::new();
    // --worktree falls back to --local unless extensions.worktreeConfig is on,
    // so the two together cover both without needing to ask which is in use
    for scope in ["--local", "--worktree"] {
        let Ok(out) = git_base(cwd)
            .args(["config", scope, "--list", "--name-only", "-z"])
            .output()
        else {
            continue;
        };
        if !out.status.success() {
            continue;
        }
        for key in String::from_utf8_lossy(&out.stdout).split('\0') {
            let key = key.trim();
            // git lowercases section and key, but not the subsection between
            let last = key.rsplit('.').next().unwrap_or_default().to_ascii_lowercase();
            if !key.is_empty() && EXEC_KEY_SUFFIX.iter().any(|s| last.ends_with(s)) {
                keys.insert(key.to_string());
            }
        }
    }

    let mut args = Vec::with_capacity(keys.len() * 2);
    for key in keys {
        args.push("-c".to_string());
        args.push(format!("{key}="));
    }
    let args = Arc::new(args);
    cache.lock().unwrap().insert(cwd.to_string(), (Instant::now(), args.clone()));
    args
}

/// For commands that run on their own — everything the panel polls. Neutralises
/// the repository's program-naming config first; see [`EXEC_KEY_SUFFIX`].
pub(crate) fn run_git(cwd: &str, args: &[&str]) -> Result<String, String> {
    let overrides = exec_key_overrides(cwd);
    let out = git_base(cwd)
        .args(overrides.iter())
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    finish(out)
}

/// For commands only ever run because you asked for them, where the
/// repository's own filters, hooks and credential helpers have to work.
fn run_git_trusted(cwd: &str, args: &[&str]) -> Result<String, String> {
    let out = git_base(cwd).args(args).output().map_err(|e| e.to_string())?;
    finish(out)
}

/// [`run_git`] with the bytes left alone.
///
/// `finish` decodes stdout as UTF-8 and replaces whatever isn't, which is right
/// for everything git prints and fatal for a blob that is a picture: every byte
/// a PNG has that UTF-8 doesn't would come back as U+FFFD, and the image would
/// be re-encoded garbage rather than the file that was committed.
fn run_git_bytes(cwd: &str, args: &[&str]) -> Result<Vec<u8>, String> {
    let overrides = exec_key_overrides(cwd);
    let out = git_base(cwd)
        .args(overrides.iter())
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(out.stdout)
}

/// A blocking body, run where blocking is free: tokio's blocking pool, which
/// grows into the hundreds of threads rather than stopping at the core count.
/// See the note at the top of this file for why `async fn` isn't enough.
pub(crate) async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .expect("blocking task panicked")
}

#[derive(Serialize)]
pub struct Worktree {
    pub path: String,
    pub branch: String,
    pub is_main: bool,
    /// the commit checked out — the one thing that moves when a pull, a
    /// checkout or a commit happens in a terminal, and so what the file tree
    /// watches to learn it should look again
    pub head: String,
}

#[tauri::command]
pub async fn git_worktrees(root: String) -> Result<Vec<Worktree>, String> {
    blocking(move || {
        let out = run_git(&root, &["worktree", "list", "--porcelain"])?;
        let mut result = Vec::new();
        let mut path = String::new();
        let mut branch = String::new();
        let mut head = String::new();
        let mut initializing = false;
        for line in out.lines().chain(std::iter::once("")) {
            if line.is_empty() {
                // `git worktree add` registers the worktree before the checkout
                // that fills it, and marks it `locked initializing` for the
                // duration. A status of that half-checkout reports every not-
                // yet-written file as deleted — thousands of rows that flash
                // through the panel and vanish — so the worktree joins the list
                // only once git unlocks it.
                if !path.is_empty() && !initializing {
                    let is_main = Path::new(&path).join(".git").is_dir();
                    result.push(Worktree {
                        path: path.clone(),
                        branch: branch.clone(),
                        is_main,
                        head: head.clone(),
                    });
                }
                path.clear();
                branch.clear();
                head.clear();
                initializing = false;
            } else if let Some(p) = line.strip_prefix("worktree ") {
                path = p.to_string();
            } else if let Some(h) = line.strip_prefix("HEAD ") {
                head = h.to_string();
            } else if let Some(b) = line.strip_prefix("branch refs/heads/") {
                branch = b.to_string();
            } else if line == "detached" {
                branch = "(detached)".to_string();
            } else if line.strip_prefix("locked").is_some_and(|r| r.trim() == "initializing") {
                initializing = true;
            }
        }
        Ok(result)
    })
    .await
}

#[tauri::command]
pub async fn git_worktree_remove(root: String, path: String, force: bool) -> Result<(), String> {
    blocking(move || {
        // `git worktree remove` unlinks the checkout one file at a time —
        // seconds on a real worktree, with every status sweep watching the
        // files half-gone. Renaming the directory into `.git` instead is one
        // syscall: the worktree vanishes from the panel and the disk walk
        // happens after the answer, where nobody is watching. `.git` because
        // status never looks inside it, and because it is on the worktree's
        // own volume more often than any tmpdir is — a rename only works
        // within one.
        let dot_git = Path::new(&path).join(".git");
        if dot_git.is_dir() {
            return Err("refusing to remove the main worktree".into());
        }
        if !force {
            // the same refusal `git worktree remove` gives, priced at one
            // status instead of git's own scan plus ours
            let status = run_git(&path, &["status", "--porcelain=v1"])?;
            if !status.is_empty() {
                return Err(format!(
                    "'{path}' contains modified or untracked files, use --force to delete it"
                ));
            }
        }
        // a locked worktree survives `worktree prune`, so the rename would
        // orphan its registration forever; git refuses these too
        let admin = std::fs::read_to_string(&dot_git)
            .ok()
            .and_then(|s| s.trim().strip_prefix("gitdir: ").map(str::to_string));
        if let Some(admin) = &admin {
            if Path::new(admin).join("locked").exists() {
                return Err(format!("'{path}' is locked; unlock it first (git worktree unlock)"));
            }
        }
        let common = run_git(&root, &["rev-parse", "--path-format=absolute", "--git-common-dir"])?;
        let trash_dir = Path::new(common.trim()).join("zero-trash");
        let name = format!(
            "wt-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default()
        );
        let trash = trash_dir.join(name);
        let renamed = std::fs::create_dir_all(&trash_dir).is_ok()
            && std::fs::rename(&path, &trash).is_ok();
        if renamed {
            // unregister before returning, so the next sweep never lists a
            // worktree whose directory is gone
            run_git(&root, &["worktree", "prune"])?;
            std::thread::spawn(move || {
                // the whole trash dir, so a deletion a crash left behind
                // goes with this one
                let _ = std::fs::remove_dir_all(&trash_dir);
            });
            return Ok(());
        }
        // rename failed — worktree on another volume, most likely — so pay for
        // git's own removal. The check above already ran, hence --force.
        // `--` so a worktree whose path begins with a dash isn't read as an option
        run_git_trusted(&root, &["worktree", "remove", "--force", "--", &path])?;
        Ok(())
    })
    .await
}

#[derive(Serialize)]
pub struct FileChange {
    pub path: String,
    pub status: String,
    pub staged: bool,
    /// The other end of a move, when this row is one end of one: where a
    /// deletion went, or where an arrival came from. `None` for everything
    /// else, which is most rows.
    pub moved: Option<String>,
}

/// How many arriving files are worth hashing to look for moves. A move of
/// more than this in one go is not a thing anyone does by hand, and the point
/// of the cap is the repository where it isn't a move at all — a few hundred
/// untracked files that happen to share a name with something deleted.
const MOVE_SCAN_LIMIT: usize = 500;

/// The blob each deleted path held, read out of a diff that already knows it.
/// `--raw` prints `:<mode> <mode> <src-oid> <dst-oid> <status>\t<path>`, so
/// the content of a file git is about to forget costs no extra hashing.
fn deleted_oids(worktree: &str, args: &[&str], out: &mut HashMap<String, String>) {
    let Ok(text) = run_git(worktree, args) else { return };
    for line in text.lines() {
        let Some((meta, path)) = line.split_once('\t') else { continue };
        let f: Vec<&str> = meta.split_whitespace().collect();
        if f.len() < 5 || !f[4].starts_with('D') {
            continue;
        }
        out.insert(path.to_string(), f[2].to_string());
    }
}

/// Pair deletions with arrivals that are the same file somewhere else.
///
/// git pairs a rename itself, but only once both halves are in the index. Move
/// a file in a shell or an editor and you get a deletion on one side and an
/// *untracked* arrival on the other, which git has no reason to connect —
/// rename detection runs between two things it already tracks. The panel then
/// draws a column of struck-through losses next to a column of unrelated new
/// files, which is the one reading of a move that looks like a catastrophe.
///
/// Deliberately conservative, because a wrong pairing is worse than none:
/// identical content, identical filename, and exactly one candidate at each
/// end. Content alone would marry every empty file in the tree to every other,
/// and a filename alone would pair two unrelated `index.ts`.
///
/// Both rows are kept and annotated rather than merged into one. The deletion
/// may be staged while the arrival is not — which is exactly the state a move
/// lands in — and folding them into a single row would have to claim one
/// staging state for both, hiding from the staged list a deletion that a
/// commit would really include.
fn detect_moves(worktree: &str, result: &mut [FileChange]) {
    fn basename(p: &str) -> &str {
        p.rsplit('/').next().unwrap_or(p)
    }

    let deleted: Vec<String> = {
        let mut v: Vec<String> = result
            .iter()
            .filter(|c| c.status == "D")
            .map(|c| c.path.clone())
            .collect();
        v.sort();
        v.dedup();
        v
    };
    if deleted.is_empty() {
        return;
    }

    let names: HashSet<&str> = deleted.iter().map(|p| basename(p)).collect();
    let arrivals: Vec<usize> = (0..result.len())
        .filter(|&i| {
            let c = &result[i];
            // a trailing slash is an untracked directory, not a file to hash
            c.status == "U" && !c.path.ends_with('/') && !c.path.contains('\n')
                && names.contains(basename(&c.path))
        })
        .take(MOVE_SCAN_LIMIT)
        .collect();
    if arrivals.is_empty() {
        return;
    }

    let paths: Vec<String> = arrivals.iter().map(|&i| result[i].path.clone()).collect();
    let mut args: Vec<&str> = vec!["hash-object", "--"];
    args.extend(paths.iter().map(|s| s.as_str()));
    let Ok(text) = run_git(worktree, &args) else { return };
    let hashes: Vec<&str> = text.lines().collect();
    if hashes.len() != arrivals.len() {
        return;
    }

    let mut oids: HashMap<String, String> = HashMap::new();
    // --no-abbrev, or these come back as seven characters and never match the
    // full-length hashes `hash-object` just gave us
    deleted_oids(worktree, &["diff", "--cached", "--raw", "--no-abbrev"], &mut oids);
    deleted_oids(worktree, &["diff", "--raw", "--no-abbrev"], &mut oids);

    let mut pairs: Vec<(usize, &str)> = Vec::new();
    for (k, &i) in arrivals.iter().enumerate() {
        for gone in &deleted {
            if basename(gone) == basename(&result[i].path)
                && oids.get(gone).map(|o| o == hashes[k]).unwrap_or(false)
            {
                pairs.push((i, gone.as_str()));
            }
        }
    }

    // only where neither end had a second candidate
    let mut per_arrival: HashMap<usize, usize> = HashMap::new();
    let mut per_deletion: HashMap<&str, usize> = HashMap::new();
    for &(i, gone) in &pairs {
        *per_arrival.entry(i).or_default() += 1;
        *per_deletion.entry(gone).or_default() += 1;
    }
    let settled: Vec<(usize, String)> = pairs
        .into_iter()
        .filter(|&(i, gone)| per_arrival[&i] == 1 && per_deletion[gone] == 1)
        .map(|(i, gone)| (i, gone.to_string()))
        .collect();

    for (i, gone) in settled {
        let arrived = result[i].path.clone();
        result[i].moved = Some(gone.clone());
        // a path can hold two rows — staged and not — and both are that move
        for c in result.iter_mut() {
            if c.status == "D" && c.path == gone {
                c.moved = Some(arrived.clone());
            }
        }
    }
}

#[tauri::command]
pub async fn git_status(worktree: String) -> Result<Vec<FileChange>, String> {
    blocking(move || {
        // -uall, because git's default stops at the first untracked *directory*
        // and reports the whole thing as one entry. A move into a new folder
        // then shows as a column of deletions with no sign of where the files
        // went — the arrivals are all hiding behind a single nameless row.
        let out = run_git(&worktree, &["status", "--porcelain=v1", "-uall"])?;
        let mut result = Vec::new();
        for line in out.lines() {
            if line.len() < 4 {
                continue;
            }
            let x = line.chars().next().unwrap();
            let y = line.chars().nth(1).unwrap();
            let mut path = line[3..].to_string();
            // renames come as "old -> new": the new path is the row, the old
            // one is where it came from — which is the whole of what makes it
            // read as a move rather than as a file appearing from nowhere
            let mut moved = None;
            if let Some(idx) = path.find(" -> ") {
                moved = Some(path[..idx].to_string());
                path = path[idx + 4..].to_string();
            }
            if x == '?' {
                result.push(FileChange { path, status: "U".into(), staged: false, moved: None });
                continue;
            }
            // a file can be in both lists at once ("MM" = staged edit + newer edit)
            if x != ' ' {
                result.push(FileChange {
                    path: path.clone(),
                    status: x.to_string(),
                    staged: true,
                    moved: moved.clone(),
                });
            }
            if y != ' ' {
                result.push(FileChange { path, status: y.to_string(), staged: false, moved });
            }
        }
        // the half-staged move git won't pair on its own
        detect_moves(&worktree, &mut result);
        Ok(result)
    })
    .await
}

#[tauri::command]
pub async fn git_stage(worktree: String, paths: Vec<String>) -> Result<(), String> {
    blocking(move || {
        let mut args = vec!["add", "--"];
        args.extend(paths.iter().map(|s| s.as_str()));
        run_git_trusted(&worktree, &args)?;
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn git_unstage(worktree: String, paths: Vec<String>) -> Result<(), String> {
    blocking(move || {
        let mut args = vec!["restore", "--staged", "--"];
        args.extend(paths.iter().map(|s| s.as_str()));
        // repos without a commit yet have no HEAD to restore from
        if run_git_trusted(&worktree, &args).is_err() {
            let mut fallback = vec!["rm", "--cached", "-r", "-q", "--"];
            fallback.extend(paths.iter().map(|s| s.as_str()));
            run_git_trusted(&worktree, &fallback)?;
        }
        Ok(())
    })
    .await
}

/// Discard working-tree changes. Tracked paths go back to what the *index*
/// holds — the same base the "changes" diff is measured against — and
/// untracked paths, which have no earlier self to restore, are deleted.
/// `git clean` rather than a plain remove because an untracked *directory* is
/// one status entry, and clean is the tool that knows what's inside it is
/// also untracked. The frontend confirms before calling; nothing here asks.
#[tauri::command]
pub async fn git_discard(
    worktree: String,
    tracked: Vec<String>,
    untracked: Vec<String>,
) -> Result<(), String> {
    blocking(move || {
        if !tracked.is_empty() {
            let mut args = vec!["restore", "--worktree", "--"];
            args.extend(tracked.iter().map(|s| s.as_str()));
            run_git_trusted(&worktree, &args)?;
        }
        if !untracked.is_empty() {
            let mut args = vec!["clean", "-fdq", "--"];
            args.extend(untracked.iter().map(|s| s.as_str()));
            run_git_trusted(&worktree, &args)?;
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn git_commit(worktree: String, message: String) -> Result<String, String> {
    blocking(move || {
        if message.trim().is_empty() {
            return Err("empty commit message".into());
        }
        run_git_trusted(&worktree, &["commit", "-m", &message])
    })
    .await
}

#[tauri::command]
pub async fn git_push(worktree: String) -> Result<String, String> {
    blocking(move || {
        // no upstream yet: publish the branch instead of failing
        match run_git_trusted(&worktree, &["push"]) {
            Ok(out) => Ok(out),
            Err(e) if e.contains("no upstream") || e.contains("--set-upstream") => {
                run_git_trusted(&worktree, &["push", "--set-upstream", "origin", "HEAD"])
            }
            Err(e) => Err(e),
        }
    })
    .await
}

/// Bring the remote's refs up to date, so "behind" means something. Errors
/// are the caller's to ignore: no remote, no network, and a credential helper
/// that wanted a terminal all land here, and none of them is news worth a
/// notice every few minutes.
#[tauri::command]
pub async fn git_fetch(worktree: String) -> Result<(), String> {
    blocking(move || run_git_trusted(&worktree, &["fetch", "--quiet"]).map(|_| ())).await
}

/// `git pull` as the user has it configured — merge or rebase is their
/// `pull.rebase`, not ours to decide. A merge commit's message is taken as git
/// proposes it, since there is no editor here to hand it to.
#[tauri::command]
pub async fn git_pull(worktree: String) -> Result<String, String> {
    blocking(move || {
        let out = git_base(&worktree)
            .env("GIT_EDITOR", "true")
            .args(["pull"])
            .output()
            .map_err(|e| e.to_string())?;
        finish(out)
    })
    .await
}

/// The directories whose entries differ between two commits, relative to the
/// worktree — every ancestor of a path that was added, deleted or renamed.
/// A modified file changes nothing about which names a folder holds, so it is
/// left out; that is what lets a commit made from the panel, where HEAD moves
/// but no file appears or vanishes, leave the tree alone.
#[tauri::command]
pub async fn git_head_delta(worktree: String, from: String, to: String) -> Result<Vec<String>, String> {
    blocking(move || {
        let out = run_git(&worktree, &["diff", "--name-status", "-M", "-z", &from, &to])?;
        let mut dirs: HashSet<String> = HashSet::new();
        let mut fields = out.split('\0').filter(|f| !f.is_empty());
        while let Some(status) = fields.next() {
            let Some(path) = fields.next() else { break };
            let kind = status.chars().next().unwrap_or('M');
            let mut touched = vec![];
            match kind {
                'A' | 'D' => touched.push(path),
                'R' | 'C' => {
                    touched.push(path);
                    if let Some(new) = fields.next() {
                        touched.push(new);
                    }
                }
                _ => {}
            }
            for p in touched {
                let mut dir = p;
                loop {
                    dir = match dir.rfind('/') {
                        Some(i) => &dir[..i],
                        None => "",
                    };
                    if !dirs.insert(dir.to_string()) || dir.is_empty() {
                        break;
                    }
                }
            }
        }
        Ok(dirs.into_iter().collect())
    })
    .await
}

#[derive(Serialize)]
pub struct BranchInfo {
    pub branch: String,
    pub upstream: bool,
    pub ahead: u32,
    pub behind: u32,
}

#[tauri::command]
pub async fn git_branch_info(worktree: String) -> Result<BranchInfo, String> {
    blocking(move || {
        let branch = run_git(&worktree, &["rev-parse", "--abbrev-ref", "HEAD"])
            .unwrap_or_default()
            .trim()
            .to_string();
        // "<behind>\t<ahead>" relative to the upstream, or an error when unset
        match run_git(&worktree, &["rev-list", "--left-right", "--count", "@{u}...HEAD"]) {
            Ok(counts) => {
                let mut it = counts.split_whitespace();
                let behind = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
                let ahead = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
                Ok(BranchInfo { branch, upstream: true, ahead, behind })
            }
            Err(_) => {
                let ahead = run_git(&worktree, &["rev-list", "--count", "HEAD"])
                    .ok()
                    .and_then(|s| s.trim().parse().ok())
                    .unwrap_or(0);
                Ok(BranchInfo { branch, upstream: false, ahead, behind: 0 })
            }
        }
    })
    .await
}

/// File content at HEAD; empty string for files that don't exist there (new files).
#[tauri::command]
pub async fn git_head_file(worktree: String, path: String) -> String {
    blocking(move || {
        run_git(&worktree, &["show", &format!("HEAD:{}", path)]).unwrap_or_default()
    })
    .await
}

/// File content on the index side — what a commit right now would record.
///
/// This is the base a working-tree diff has to be measured against, not HEAD:
/// once part of a file is staged, HEAD is two edits behind and the diff shows
/// the staged hunks over again. For a file with nothing staged the index and
/// HEAD hold the same bytes, so this is the right base either way.
///
/// Empty for a path the index doesn't have — never added, or staged as a
/// deletion — which is the same all-added diff a new file gets.
#[tauri::command]
pub async fn git_index_file(worktree: String, path: String) -> String {
    blocking(move || {
        run_git(&worktree, &["show", &format!(":{}", path)]).unwrap_or_default()
    })
    .await
}

/// The two sides of an image diff, as bytes.
///
/// [`git_head_file`] and [`git_index_file`] answer the same question for text
/// and cannot answer it for a picture — see [`run_git_bytes`]. `rev` is the
/// prefix git names a side by: `HEAD` for the commit, empty for the index,
/// which is the same pair the text commands hard-code one each of.
///
/// Empty bytes for a side that doesn't have the path — a new file's HEAD, a
/// deleted file's index — which is the "one side of this is nothing" the text
/// pair says with an empty string, and what the view draws as an addition or a
/// deletion rather than as an error.
#[tauri::command]
pub async fn git_show_binary(
    worktree: String,
    rev: String,
    path: String,
) -> Result<tauri::ipc::Response, String> {
    blocking(move || {
        // `HEAD` and the index are the only two this is ever asked for, and
        // spelling them out here is what keeps a rev off the IPC boundary
        let spec = match rev.as_str() {
            "HEAD" => format!("HEAD:{path}"),
            "" => format!(":{path}"),
            other => return Err(format!("not a side of a diff: {other}")),
        };
        Ok(tauri::ipc::Response::new(
            run_git_bytes(&worktree, &["show", &spec]).unwrap_or_default(),
        ))
    })
    .await
}

#[derive(Serialize)]
pub struct Baseline {
    /// the file as it was committed
    pub content: String,
    /// false when HEAD has no such file. A new file gets no change bars at all
    /// rather than every one of its lines marked as added — the same call VS
    /// Code makes, and the file tree is where "this is new" gets said instead.
    pub tracked: bool,
}

/// The committed version of a file, found without being told which repository
/// it belongs to.
///
/// The editor opens files from anywhere — another worktree, a path outside the
/// project entirely — so the caller genuinely doesn't know the repository root.
/// `HEAD:./name` resolves relative to git's own working directory, which turns
/// the whole question into "run it in the file's folder": no root to find, no
/// path arithmetic, and none of the ways that arithmetic goes wrong when a
/// path arrives through a symlink.
#[tauri::command]
pub async fn git_baseline(path: String) -> Baseline {
    blocking(move || {
        let untracked = || Baseline { content: String::new(), tracked: false };
        let p = Path::new(&path);
        let (Some(dir), Some(name)) = (p.parent(), p.file_name()) else {
            return untracked();
        };
        match run_git(
            &dir.to_string_lossy(),
            &["show", &format!("HEAD:./{}", name.to_string_lossy())],
        ) {
            Ok(content) => Baseline { content, tracked: true },
            Err(_) => untracked(),
        }
    })
    .await
}

#[derive(Serialize)]
pub struct DirEntry {
    pub name: String,
    pub is_dir: bool,
    /// the repository ignores this, so the tree can grey it out
    pub ignored: bool,
}

/// Which of these names the repository ignores.
///
/// One `git check-ignore` for the whole directory rather than one per entry —
/// the tree lists a directory at a time, so this costs one extra process per
/// folder you open, not one per file in it.
fn ignored_names(dir: &str, entries: &[(String, bool)]) -> HashSet<String> {
    use std::io::Write;
    use std::process::Stdio;

    if entries.is_empty() {
        return HashSet::new();
    }
    let mut payload = Vec::new();
    for (name, is_dir) in entries {
        payload.extend_from_slice(name.as_bytes());
        // the trailing slash tells git it's a directory, without which a
        // directory-only pattern like `build/` wouldn't match
        if *is_dir {
            payload.push(b'/');
        }
        payload.push(0);
    }

    let Ok(mut child) = git_base(dir)
        .args(exec_key_overrides(dir).iter())
        .args(["check-ignore", "-z", "--stdin"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        // not a repository, or no git: nothing is ignored
        return HashSet::new();
    };
    // written from its own thread: a large directory can fill the pipe before
    // git has read any of it, and then both sides sit waiting for the other
    if let Some(mut sink) = child.stdin.take() {
        std::thread::spawn(move || {
            let _ = sink.write_all(&payload);
        });
    }
    let Ok(out) = child.wait_with_output() else {
        return HashSet::new();
    };
    // check-ignore echoes back only the paths it matched, as we sent them
    String::from_utf8_lossy(&out.stdout)
        .split('\0')
        .filter(|s| !s.is_empty())
        .map(|s| s.trim_end_matches('/').to_string())
        .collect()
}

#[tauri::command]
pub async fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    blocking(move || {
        let mut entries: Vec<(String, bool)> = std::fs::read_dir(&path)
            .map_err(|e| e.to_string())?
            .filter_map(|e| e.ok())
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                if name == ".git" {
                    return None;
                }
                let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
                Some((name, is_dir))
            })
            .collect();
        entries.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.to_lowercase().cmp(&b.0.to_lowercase())));

        let ignored = ignored_names(&path, &entries);
        Ok(entries
            .into_iter()
            .map(|(name, is_dir)| DirEntry {
                ignored: ignored.contains(&name),
                name,
                is_dir,
            })
            .collect())
    })
    .await
}

/// Past this, the list is more than anyone scrolls and the filter starts to
/// cost more than it returns.
const MAX_PROJECT_FILES: usize = 20_000;

/// Every file in the project worth opening: tracked, plus anything new that
/// isn't ignored. The same set `git grep` searches, and the same set VS Code's
/// quick open offers — which is why neither needs to read .gitignore itself.
pub fn project_files(root: &str) -> Result<Vec<String>, String> {
    let out = run_git(
        root,
        &["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    )?;
    let mut seen = std::collections::HashSet::new();
    Ok(out
        .split('\0')
        .filter(|p| !p.is_empty())
        .filter(|p| seen.insert(p.to_string()))
        .take(MAX_PROJECT_FILES)
        .map(str::to_string)
        .collect())
}

#[tauri::command]
pub async fn list_project_files(root: String) -> Result<Vec<String>, String> {
    blocking(move || {
        project_files(&root)
    })
    .await
}

/// A file as bytes rather than text, for the things that aren't text.
///
/// `tauri::ipc::Response` puts the bytes on the IPC channel raw. Returning a
/// `Vec<u8>` would have serialised a megabyte image as a JSON array of a
/// million numbers, and encoding it as a data: URI instead would still cost a
/// third again in base64 — this way the frontend gets an ArrayBuffer it can
/// wrap in a Blob directly.
#[tauri::command]
pub async fn read_binary(path: String) -> Result<tauri::ipc::Response, String> {
    blocking(move || {
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        Ok(tauri::ipc::Response::new(bytes))
    })
    .await
}

#[tauri::command]
pub async fn read_file(path: String) -> Result<String, String> {
    blocking(move || {
        std::fs::read_to_string(&path).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn write_file(path: String, content: String) -> Result<(), String> {
    blocking(move || {
        std::fs::write(&path, content).map_err(|e| e.to_string())
    })
    .await
}


#[cfg(test)]
mod tests {
    use super::*;

    /// A repository that tries to run a command when its status is read. Both
    /// of these fire under plain `git status`: fsmonitor directly, and the
    /// clean filter because .gitattributes points every file at it.
    fn hostile_repo(dir: &Path, marker: &Path) {
        let git = |args: &[&str]| {
            git_base(&dir.to_string_lossy()).args(args).output().unwrap();
        };
        std::fs::create_dir_all(dir).unwrap();
        git(&["init", "-q", "."]);
        std::fs::write(dir.join(".gitattributes"), "* filter=trap\n").unwrap();
        std::fs::write(dir.join("f.txt"), "one\n").unwrap();
        git(&["add", "-A"]);
        git(&["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
        // a change to make status consult the filter
        std::fs::write(dir.join("f.txt"), "two\n").unwrap();

        let touch = format!("touch {}", marker.display());
        git(&["config", "core.fsmonitor", &touch]);
        git(&["config", "filter.trap.clean", &format!("sh -c '{touch}; cat'")]);
    }

    /// Directories are the case that breaks: a `build/` pattern only matches a
    /// path git believes is a directory, which it can only know from the
    /// trailing slash we send.
    #[test]
    fn ignored_names_covers_files_and_directories() {
        let dir = std::env::temp_dir().join("zero-ignore-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("build")).unwrap();
        std::fs::create_dir_all(dir.join("src")).unwrap();
        let cwd = dir.to_string_lossy().to_string();
        git_base(&cwd).args(["init", "-q", "."]).output().unwrap();
        std::fs::write(dir.join(".gitignore"), "build/\n*.log\n").unwrap();
        std::fs::write(dir.join("keep.txt"), "").unwrap();
        std::fs::write(dir.join("noise.log"), "").unwrap();

        let entries = vec![
            ("build".to_string(), true),
            ("src".to_string(), true),
            ("keep.txt".to_string(), false),
            ("noise.log".to_string(), false),
        ];
        let ignored = ignored_names(&cwd, &entries);

        assert!(ignored.contains("build"), "directory-only pattern missed: {ignored:?}");
        assert!(ignored.contains("noise.log"), "file pattern missed: {ignored:?}");
        assert!(!ignored.contains("src"), "plain directory marked ignored: {ignored:?}");
        assert!(!ignored.contains("keep.txt"), "plain file marked ignored: {ignored:?}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Moving files into a folder that doesn't exist in HEAD yet is the case
    /// that misleads: git's default untracked mode stops at the new directory
    /// and reports it as one entry, so the panel showed a column of deletions
    /// and no sign that the files had landed anywhere.
    #[test]
    fn status_lists_files_inside_a_new_untracked_directory() {
        let dir = std::env::temp_dir().join("zero-untracked-dir-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("pub/about")).unwrap();
        let cwd = dir.to_string_lossy().to_string();
        let git = |args: &[&str]| {
            git_base(&cwd).args(args).output().unwrap();
        };
        git(&["init", "-q", "."]);
        std::fs::write(dir.join("pub/about/page.tsx"), "hi\n").unwrap();
        git(&["add", "-A"]);
        git(&["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);

        // the move: out of about/, into a route group that HEAD has never seen
        std::fs::create_dir_all(dir.join("pub/(marketing)/about")).unwrap();
        std::fs::rename(dir.join("pub/about/page.tsx"), dir.join("pub/(marketing)/about/page.tsx"))
            .unwrap();
        std::fs::remove_dir(dir.join("pub/about")).unwrap();

        let changes = tauri::async_runtime::block_on(git_status(cwd)).unwrap();
        let paths: Vec<&str> = changes.iter().map(|c| c.path.as_str()).collect();

        assert!(
            paths.contains(&"pub/(marketing)/about/page.tsx"),
            "the arriving file is hidden behind its directory: {paths:?}"
        );
        assert!(
            !paths.contains(&"pub/(marketing)/"),
            "the directory was reported instead of its contents: {paths:?}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The half-staged move: a deletion git has been told about and an arrival
    /// it hasn't. git pairs neither, so the panel has to.
    #[test]
    fn a_move_is_paired_even_while_half_of_it_is_untracked() {
        let dir = std::env::temp_dir().join("zero-move-pairing-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("pub/about")).unwrap();
        let cwd = dir.to_string_lossy().to_string();
        let git = |args: &[&str]| {
            git_base(&cwd).args(args).output().unwrap();
        };
        git(&["init", "-q", "."]);
        std::fs::write(dir.join("pub/about/page.tsx"), "the about page\n").unwrap();
        // a second file with content of its own, so the pairing has to be about
        // more than "something was deleted and something arrived"
        std::fs::write(dir.join("pub/about/other.tsx"), "another\n").unwrap();
        git(&["add", "-A"]);
        git(&["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);

        std::fs::create_dir_all(dir.join("pub/(marketing)/about")).unwrap();
        for f in ["page.tsx", "other.tsx"] {
            std::fs::rename(
                dir.join("pub/about").join(f),
                dir.join("pub/(marketing)/about").join(f),
            )
            .unwrap();
        }
        std::fs::remove_dir(dir.join("pub/about")).unwrap();
        // the deletions staged, the arrivals not — what `git add -A` on the old
        // path alone leaves behind, and what the panel showed as pure loss
        git(&["add", "-A", "--", "pub/about"]);

        let changes = tauri::async_runtime::block_on(git_status(cwd)).unwrap();
        let moved = |path: &str| {
            changes
                .iter()
                .find(|c| c.path == path)
                .unwrap_or_else(|| panic!("no row for {path}"))
                .moved
                .clone()
        };

        assert_eq!(
            moved("pub/about/page.tsx").as_deref(),
            Some("pub/(marketing)/about/page.tsx"),
            "the deletion doesn't say where the file went"
        );
        assert_eq!(
            moved("pub/(marketing)/about/page.tsx").as_deref(),
            Some("pub/about/page.tsx"),
            "the arrival doesn't say where it came from"
        );
        // and the two files were not crossed with each other
        assert_eq!(
            moved("pub/(marketing)/about/other.tsx").as_deref(),
            Some("pub/about/other.tsx")
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Two empty files are identical without being the same file. Content
    /// alone would pair them; the name and the one-candidate rule are what
    /// stop it.
    #[test]
    fn identical_but_unrelated_files_are_not_called_a_move() {
        let dir = std::env::temp_dir().join("zero-move-falsepos-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("a")).unwrap();
        std::fs::create_dir_all(dir.join("b")).unwrap();
        let cwd = dir.to_string_lossy().to_string();
        let git = |args: &[&str]| {
            git_base(&cwd).args(args).output().unwrap();
        };
        git(&["init", "-q", "."]);
        std::fs::write(dir.join("a/keep.ts"), "").unwrap();
        git(&["add", "-A"]);
        git(&["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);

        std::fs::remove_file(dir.join("a/keep.ts")).unwrap();
        // same (empty) content, different name: not the file that just went
        std::fs::write(dir.join("b/unrelated.ts"), "").unwrap();

        let changes = tauri::async_runtime::block_on(git_status(cwd)).unwrap();
        for c in &changes {
            assert!(c.moved.is_none(), "{} was called a move: {:?}", c.path, c.moved);
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn status_does_not_run_the_repositorys_commands() {
        let dir = std::env::temp_dir().join("zero-git-hardening-test");
        let marker = std::env::temp_dir().join("zero-git-hardening-marker");
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_file(&marker);
        hostile_repo(&dir, &marker);
        let cwd = dir.to_string_lossy().to_string();

        // the hardened path must not let either one run
        run_git(&cwd, &["status", "--porcelain=v1"]).unwrap();
        assert!(!marker.exists(), "repository config was executed by git status");

        // and the guard has to be doing it — without the overrides it fires,
        // which is what makes the assertion above meaningful
        run_git_trusted(&cwd, &["status", "--porcelain=v1"]).unwrap();
        assert!(marker.exists(), "test no longer reproduces the original issue");

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_file(&marker);
    }
}
