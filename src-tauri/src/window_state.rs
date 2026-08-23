//! Where the window was, so a restart puts it back.
//!
//! Tauri builds the window from tauri.conf.json on every launch, which means
//! 1440×900 in the middle of the main display however the last one was left.
//! That was survivable while a launch was something you did once a day; the
//! update button in the titlebar makes it something the app asks you to do,
//! and an app that answers "restart to update" by throwing away the window
//! you had is one you stop restarting.
//!
//! Fullscreen is the half that shows: a fullscreen zero comes back as a
//! window, on a different Space, behind whatever else was open. The frame is
//! the half you only notice on the second display.
//!
//! Written debounced rather than at exit: `relaunch()` reaches `exit(0)` by a
//! path that owes no promises about which exit hooks ran, and a geometry file
//! that is only correct when the app was closed politely is one that is wrong
//! exactly when it matters.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use tauri::{LogicalPosition, LogicalSize, Manager, WebviewWindow, WindowEvent};

/// Logical points, not pixels: the same window moved to a display of another
/// scale factor should come back the size it looked, not the size it measured.
///
/// Filling the screen is two different states and they are not each other. The
/// green button *zooms*: same desktop, same Space, a frame the size of the
/// screen. ⌃⌘F goes *fullscreen*: its own Space, the menu bar gone. Restoring
/// a zoomed window as a fullscreen one is the more annoying of the two
/// mistakes, since it moves the window to a Space you weren't on — so both are
/// recorded, and the frame under them is the one to come back out into.
#[derive(Serialize, Deserialize, Clone, Copy)]
struct Geometry {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    fullscreen: bool,
    /// absent in files written before the two were told apart
    #[serde(default)]
    maximized: bool,
}

fn store_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("window.json"))
}

fn read(app: &tauri::AppHandle) -> Option<Geometry> {
    let path = store_path(app).ok()?;
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

fn measure(window: &WebviewWindow) -> Option<Geometry> {
    let scale = window.scale_factor().ok()?;
    let at = window.outer_position().ok()?.to_logical::<f64>(scale);
    let size = window.outer_size().ok()?.to_logical::<f64>(scale);
    Some(Geometry {
        x: at.x,
        y: at.y,
        w: size.width,
        h: size.height,
        fullscreen: window.is_fullscreen().unwrap_or(false),
        maximized: window.is_maximized().unwrap_or(false),
    })
}

/// Is there still a display that would show this? Monitors come and go — a
/// window last closed on a desk monitor is otherwise restored to coordinates
/// that exist on nobody's screen, which looks exactly like the app failing to
/// launch. Asks for the titlebar specifically: a frame whose top bar is off
/// the top of a display is one that can't be dragged back.
fn on_a_screen(window: &WebviewWindow, g: &Geometry) -> bool {
    let Ok(monitors) = window.available_monitors() else {
        return false;
    };
    monitors.iter().any(|m| {
        let scale = m.scale_factor();
        let at = m.position().to_logical::<f64>(scale);
        let size = m.size().to_logical::<f64>(scale);
        // 60pt of titlebar has to land inside, in both axes
        g.x + g.w > at.x + 60.0
            && g.x < at.x + size.width - 60.0
            && g.y + 60.0 > at.y
            && g.y < at.y + size.height - 60.0
    })
}

/// Put the window back before it is looked at. Every step is optional and
/// none of them is worth a failed launch: a geometry that can't be applied
/// leaves the one tauri.conf.json asked for.
pub fn restore(window: &WebviewWindow) {
    let Some(g) = read(window.app_handle()) else {
        return;
    };
    // the config's own minimums; a smaller number in the file is a file to
    // disbelieve rather than a window to build
    if g.w >= 800.0 && g.h >= 500.0 {
        let _ = window.set_size(LogicalSize::new(g.w, g.h));
    }
    if on_a_screen(window, &g) {
        let _ = window.set_position(LogicalPosition::new(g.x, g.y));
    }
    // in that order: the frame first, so the green button has somewhere to
    // put the window back down when it is un-zoomed
    if g.maximized {
        let _ = window.maximize();
    }
    if g.fullscreen {
        let _ = window.set_fullscreen(true);
    }
}

/// Remember where it is put from here on. The write is debounced behind a
/// thread: `Moved` and `Resized` arrive every frame of a live drag, and the
/// file only has to be right by the time the app is next launched.
pub fn watch(window: &WebviewWindow) {
    // Start from the file rather than from the window. Restoring is
    // asynchronous — the size, the position and the zoom all land a frame or
    // two later — so measuring here reads whatever tauri.conf.json asked for,
    // and a window that comes back zoomed then never sees an un-zoomed frame
    // to record would have that default written over the frame it should
    // un-zoom into.
    let Some(start) = read(window.app_handle()).or_else(|| measure(window)) else {
        return;
    };
    let state = Arc::new(Mutex::new(start));
    let (tx, rx) = mpsc::channel::<()>();

    let app = window.app_handle().clone();
    let writing = state.clone();
    std::thread::spawn(move || {
        while rx.recv().is_ok() {
            // drain the rest of the gesture before touching the disk
            while rx.recv_timeout(Duration::from_millis(400)).is_ok() {}
            // copied out, never written under: the lock is held for the read
            // and nothing else
            let g = *writing.lock().unwrap_or_else(|e| e.into_inner());
            if let (Ok(path), Ok(json)) = (store_path(&app), serde_json::to_string(&g)) {
                let _ = fs::write(path, json);
            }
        }
    });

    let win = window.clone();
    window.on_window_event(move |event| {
        if !matches!(event, WindowEvent::Moved(_) | WindowEvent::Resized(_)) {
            return;
        }
        let Some(now) = measure(&win) else { return };
        {
            let mut slot = state.lock().unwrap_or_else(|e| e.into_inner());
            if now.fullscreen {
                // filled either way, the frame on screen is the screen's and
                // not the window's, so only the flag is news — the frame
                // already recorded is the one to come back out into
                slot.fullscreen = true;
            } else if now.maximized {
                slot.fullscreen = false;
                slot.maximized = true;
            } else {
                *slot = now;
            }
        }
        let _ = tx.send(());
    });
}
