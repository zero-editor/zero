use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Manager;

/// The window's layout, owned by this side rather than by the webview.
///
/// It used to live in localStorage, and the reason it no longer does is the
/// way zero ends: `AppHandle::exit` finishes in `std::process::exit`, so the
/// page is never unloaded and `beforeunload` never fires. Anything the webview
/// was still holding — the debounce, and whatever WebKit hadn't yet synced out
/// of its in-memory store into localstorage.sqlite3 — went with it. That is a
/// layout change made shortly before ⌘Q simply not being there next launch,
/// and it is invisible: nothing errors, you just get an older window back.
///
/// So the frontend hands the whole blob over on every change and this writes
/// it immediately. The blob is opaque here on purpose — its shape is the
/// frontend's business and changes with it, and a Rust mirror of that shape
/// would be a second place to update and a second place to get it wrong.
#[derive(Default)]
pub struct SessionStore {
    /// the newest snapshot handed to us, written or not
    latest: Mutex<Option<String>>,
    /// what the file holds, so an unchanged snapshot costs nothing
    on_disk: Mutex<Option<String>>,
}

/// Keyed to which copy of zero this is, the way the daemon's socket is, and
/// for the same reason: `tauri dev` and the installed app run side by side all
/// day here, and one file for the two of them means the layout you are working
/// on is whichever copy wrote last. localStorage gave them a copy each for
/// free — the origins differ — and losing that quietly is not a trade worth
/// making for a prettier filename. An update replaces the binary at the same
/// path, so it keeps reading its own file.
fn store_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(format!("session-{:016x}.json", crate::pty::exe_key())))
}

/// Write beside, then rename. A truncating write that fails halfway leaves a
/// file that parses as nothing, which costs the layout of every project at
/// once — the one failure this store exists to avoid.
fn write_atomic(path: &PathBuf, body: &str) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, body).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// Put the newest snapshot on disk.
///
/// Whoever holds the write lock writes whatever is newest at that moment
/// rather than the payload it arrived with, so two saves racing can't land
/// out of order — the loser writes the winner's blob a second time, or
/// nothing, and never an older one over a newer one.
pub fn commit(app: &tauri::AppHandle) -> Result<(), String> {
    let store = app.state::<SessionStore>();
    let mut on_disk = store.on_disk.lock().unwrap();
    let want = store.latest.lock().unwrap().clone();
    let Some(want) = want else { return Ok(()) };
    if on_disk.as_deref() == Some(want.as_str()) {
        return Ok(());
    }
    write_atomic(&store_path(app)?, &want)?;
    *on_disk = Some(want);
    Ok(())
}

/// The stored session, or `None` when there genuinely isn't one yet.
///
/// The two are worth the extra type. A shell now outlives the app and is kept
/// only while some restored layout still claims it, so "nothing is stored" is
/// an instruction to end every session there is — and answering an unreadable
/// config directory with it would do exactly that over a transient failure.
/// Anything that isn't a plainly absent file is an error, and the caller
/// declines to speak for what's running (see `claimedPaneIds`).
#[tauri::command]
pub fn session_load(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let path = store_path(&app)?;
    match fs::read_to_string(&path) {
        Ok(body) => {
            // remember what we read, so the first save of an unchanged session
            // is a comparison rather than a write
            *app.state::<SessionStore>().on_disk.lock().unwrap() = Some(body.clone());
            Ok(Some(body))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Async so the write lands on the runtime's pool rather than on the main
/// thread: this is called on every layout change, and a window that stutters
/// when you let go of a divider would be a poor trade for durability.
#[tauri::command]
pub async fn session_save(app: tauri::AppHandle, json: String) -> Result<(), String> {
    *app.state::<SessionStore>().latest.lock().unwrap() = Some(json);
    commit(&app)
}
