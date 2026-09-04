use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

#[derive(Serialize, Deserialize, Clone)]
pub struct RecentProject {
    pub path: String,
    pub name: String,
    /// The folders beyond `path`, for a project split across repositories.
    ///
    /// `default` because every recents.json written before this field existed
    /// is missing it, and a recents list that failed to parse would be a
    /// launcher with nothing on it.
    ///
    /// The session file is what restores a project you never closed; this is
    /// what restores one you did. Without it, reopening a three-folder project
    /// from the launcher would quietly hand back one folder.
    #[serde(default)]
    pub folders: Vec<String>,
}

fn store_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("recents.json"))
}

fn load(app: &tauri::AppHandle) -> Vec<RecentProject> {
    store_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save(app: &tauri::AppHandle, list: &[RecentProject]) -> Result<(), String> {
    let p = store_path(app)?;
    fs::write(p, serde_json::to_string_pretty(list).unwrap()).map_err(|e| e.to_string())
}

/// A main worktree has a .git *directory*; linked worktrees have a .git file.
fn is_main_worktree(path: &str) -> bool {
    PathBuf::from(path).join(".git").is_dir()
}

#[tauri::command]
pub fn get_recents(app: tauri::AppHandle) -> Vec<RecentProject> {
    load(&app)
        .into_iter()
        .filter(|r| is_main_worktree(&r.path))
        .collect()
}

/// Which of these directories are still there. Used when restoring a session:
/// a project that has been moved or deleted since last launch would otherwise
/// come back as a tab whose shell can't start and whose tree won't list.
///
/// Deliberately only asks "is it a directory", not `is_main_worktree` — a
/// linked worktree is a perfectly good thing to have open as a project, it
/// just never makes it into the recents list.
#[tauri::command]
pub fn existing_dirs(paths: Vec<String>) -> Vec<String> {
    paths
        .into_iter()
        .filter(|p| PathBuf::from(p).is_dir())
        .collect()
}

#[tauri::command]
pub fn add_recent(
    app: tauri::AppHandle,
    path: String,
    name: Option<String>,
    folders: Option<Vec<String>>,
) -> Result<(), String> {
    if !is_main_worktree(&path) {
        return Err("not a main git worktree".into());
    }
    // The name is the project's own once it has been renamed, and the folder's
    // otherwise — a project called something else in the tab strip and its
    // directory name in the launcher would be two names for one thing.
    let name = name.filter(|n| !n.trim().is_empty()).unwrap_or_else(|| {
        PathBuf::from(&path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| path.clone())
    });
    let mut list = load(&app);
    list.retain(|r| r.path != path);
    list.insert(0, RecentProject { path, name, folders: folders.unwrap_or_default() });
    list.truncate(30);
    save(&app, &list)
}

#[tauri::command]
pub fn remove_recent(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let mut list = load(&app);
    list.retain(|r| r.path != path);
    save(&app, &list)
}
