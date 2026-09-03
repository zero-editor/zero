//! The `zero` shell command.
//!
//! Installed by the app itself on every launch, so putting zero.app in place
//! is the whole installation — there's no second step to forget. The command
//! hands a directory over through a file the app watches, rather than through
//! argv: `open -a` doesn't pass arguments, and launching the binary directly
//! would start a second instance with its own set of shells.
//!
//! `--sessions` and `--kill-sessions` are the exception, and go straight to
//! the binary. They speak to the terminal daemon and print — no window is
//! wanted, and the whole reason they exist is the case where starting one
//! isn't working.

use std::path::PathBuf;
use std::time::Duration;
use tauri::{Emitter, Manager};

/// Where the CLI leaves a directory for the app to pick up. Written by the
/// script below and by nothing else, so the name is a private detail — but it
/// has to be spelled out in both places, hence the constant.
const REQUEST_FILE: &str = "open-request";

/// A request older than this was meant for a session that never read it —
/// opening it now would be a surprise, not a convenience.
const REQUEST_TTL: Duration = Duration::from_secs(90);

const SCRIPT: &str = r#"#!/bin/sh
# zero — open a project in zero.
# Installed by zero itself on launch; local edits are overwritten.
set -e

APP="/Applications/zero.app"
[ -d "$APP" ] || { printf 'zero: %s is not installed\n' "$APP" >&2; exit 1; }

if [ "$#" -gt 0 ]; then
  case "$1" in
    -h|--help)
      printf 'usage: zero [directory]\n'
      printf '       zero --sessions        list terminals still running\n'
      printf '       zero --kill-sessions   end them all\n'
      exit 0 ;;
    # Straight to the binary, not through `open`: these talk to the terminal
    # daemon and print, and must work when the app is not running or will not
    # start -- which is the case they exist for.
    --sessions|--kill-sessions)
      exec "$APP/Contents/MacOS/zero" "$1" ;;
  esac
  dir=$(cd -- "$1" 2>/dev/null && pwd) || {
    printf 'zero: not a directory: %s\n' "$1" >&2
    exit 1
  }
  store="$HOME/Library/Application Support/com.vidtopolovec.zero"
  mkdir -p "$store"
  printf '%s' "$dir" > "$store/open-request"
fi

exec open -a "$APP"
"#;

fn bin_path() -> Option<PathBuf> {
    Some(PathBuf::from(std::env::var("HOME").ok()?).join(".local/bin/zero"))
}

/// Write `~/.local/bin/zero` unless it's already exactly this script. Returns
/// what happened, for the launch log; every failure is just a missing command,
/// never a broken app, so nothing here is fatal.
pub fn install_command() -> Result<&'static str, String> {
    let path = bin_path().ok_or("no HOME")?;
    // A symlink at this path isn't ours, and writing to one writes straight
    // through it — pointed at something of yours, that file would be replaced
    // by this script on every launch. So a link is always replaced, never
    // followed, and the skip-if-unchanged check doesn't apply to one.
    let linked = std::fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink());
    if !linked && std::fs::read_to_string(&path).is_ok_and(|cur| cur == SCRIPT) {
        return Ok("already current");
    }
    let dir = path.parent().ok_or("no parent dir")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;

    // write alongside and rename over: rename replaces the link itself, and
    // there's never a moment where `zero` exists but isn't yet executable
    let tmp = dir.join(".zero.install");
    std::fs::write(&tmp, SCRIPT).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })?;
    Ok(if linked { "replaced a symlink" } else { "installed" })
}

/// Take a pending request, if there is a fresh one. Consuming it is the point:
/// the same directory must not be opened twice.
fn take(app: &tauri::AppHandle) -> Option<String> {
    let path = app.path().app_config_dir().ok()?.join(REQUEST_FILE);
    let age = std::fs::metadata(&path).ok()?.modified().ok()?.elapsed().ok()?;
    let dir = std::fs::read_to_string(&path).ok()?;
    let _ = std::fs::remove_file(&path);
    let dir = dir.trim().to_string();
    if age > REQUEST_TTL || !PathBuf::from(&dir).is_dir() {
        return None;
    }
    Some(dir)
}

/// Poll for requests in the background.
///
/// Polling rather than reacting to window focus, because the most likely place
/// to type `zero .` is a terminal inside zero — where the window is already
/// frontmost and no focus event ever arrives. A stat of one file is cheap
/// enough to do on a timer, and it costs the frontend nothing: it only hears
/// about it when there's something to open.
pub fn watch(app: tauri::AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(600));
        if let Some(dir) = take(&app) {
            let _ = app.emit("open-project", dir);
        }
    });
}

/// The folder picker, asked for by a process that is allowed to open one.
///
/// `NSOpenPanel` is hosted out of process, and macOS 26 refuses that
/// connection to an executable that isn't inside an `.app` bundle — which is
/// precisely what `tauri dev` runs. The panel comes back NULL, objc2 panics on
/// it, and the window goes with it: in this repository "open project" has been
/// a way to quit the dev build, and nothing about the failure says so.
///
/// osascript *is* bundled, and `choose folder` is the same AppKit panel, so
/// asking it instead costs one subprocess and works. Only the dev build takes
/// this route — a bundled zero has no reason to.
#[tauri::command]
pub async fn pick_directory(title: String) -> Result<Option<String>, String> {
    // the prompt is ours, but it is still going into a script: a quote in it
    // would end the string and everything after it would be AppleScript
    let prompt = title.replace(['"', '\\', '\n'], " ");
    let out = std::process::Command::new("/usr/bin/osascript")
        .arg("-e")
        .arg(format!("POSIX path of (choose folder with prompt \"{prompt}\")"))
        .output()
        .map_err(|e| e.to_string())?;

    // cancelling is -128 and is not a failure to report, and telling it apart
    // from a real error would only change a message nobody sees
    if !out.status.success() {
        return Ok(None);
    }
    // `POSIX path of` ends a directory with a slash; every root elsewhere in
    // zero is stored without one, and the same project under two spellings is
    // two tabs
    let dir = String::from_utf8_lossy(&out.stdout).trim().trim_end_matches('/').to_string();
    Ok((!dir.is_empty()).then_some(dir))
}

/// The file picker, for the same reason and by the same route.
///
/// See `pick_directory`: an unbundled `tauri dev` binary gets NULL back from
/// `NSOpenPanel` and the plugin panics on it, so importing a voice memo was
/// another way to quit the dev build. `choose file` is that panel, asked for
/// by a process macOS will open one for.
///
/// `extensions` narrows it the way the plugin's filters do. AppleScript's
/// `of type` takes bare extensions as well as UTIs, and an empty list means
/// no filter rather than nothing selectable.
#[tauri::command]
pub async fn pick_file(title: String, extensions: Vec<String>) -> Result<Option<String>, String> {
    // as in `pick_directory`, everything interpolated is going into a script
    let clean = |s: &str| s.replace(['"', '\\', '\n'], " ");
    let prompt = clean(&title);
    let of_type = if extensions.is_empty() {
        String::new()
    } else {
        let list =
            extensions.iter().map(|e| format!("\"{}\"", clean(e))).collect::<Vec<_>>().join(", ");
        format!(" of type {{{list}}}")
    };
    let out = std::process::Command::new("/usr/bin/osascript")
        .arg("-e")
        .arg(format!("POSIX path of (choose file with prompt \"{prompt}\"{of_type})"))
        .output()
        .map_err(|e| e.to_string())?;

    // cancelling is -128, and is a decision rather than something to report
    if !out.status.success() {
        return Ok(None);
    }
    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Ok((!path.is_empty()).then_some(path))
}
