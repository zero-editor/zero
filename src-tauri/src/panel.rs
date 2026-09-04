//! The open, file and save panels — ours, rather than the dialog plugin's.
//!
//! **Why this file exists.** tauri's dialog plugin goes through `rfd`, and
//! `rfd` 0.16 does this whenever the dialog has a parent window, which the
//! plugin always sets:
//!
//! ```text
//! if let Some(parent) = self.parent.clone() {
//!     self.panel.beginSheetModalForWindow_completionHandler(&parent, &completion)
//! }
//! unsafe { self.panel.runModal() }
//! ```
//!
//! It begins a sheet and then runs the *same panel* app-modally. That is not a
//! supported sequence, and on macOS 26 the modal returns with no selection —
//! so `panel.URL().unwrap()` finds nil and panics, inside an ObjC callback,
//! which takes the process with it. Importing a voice memo quit 0.37.0; the
//! `+` in the titlebar quit 0.38.2. Both were this.
//!
//! **Why not osascript.** It was the first way around it, and it works, but a
//! panel hosted by another process is not free: osascript is not a foreground
//! app, so the panel opens behind zero and without focus unless osascript is
//! activated first — which costs an app launch, visibly — and when it closes,
//! the front goes to whoever held it before, not back to zero. `rfd` has a
//! whole `FocusManager` for that last part. None of it is a problem worth
//! having when the panel can simply be ours.
//!
//! **These are sheets.** `beginSheetModalForWindow:completionHandler:` and
//! nothing else — no `runModal`, which is the bug above and would also freeze
//! the window while it was open. A frozen window here is not a still picture:
//! the terminals stop drawing, and one of them is usually a Claude session
//! mid-answer. The sheet slides out of zero's own titlebar, leaves everything
//! behind it running, and hands focus back itself because it never left the
//! app.

use std::ffi::{c_char, CStr, CString};
use std::sync::mpsc::SyncSender;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{class, msg_send};
use tauri::Manager;

/// `NSModalResponseOK`. The only response that carries a path; everything else
/// — cancel, or a sheet dismissed some other way — is a decision, not a
/// failure, and comes back as `None`.
const OK: isize = 1;

/// Which panel, and the parts of it that differ.
pub enum Kind {
    Directory,
    /// Bare extensions, as the plugin's filters took them. Empty means no
    /// filter rather than nothing selectable.
    File { extensions: Vec<String> },
    /// Where to put a new file: the folder to open in, and the name to offer.
    Save { directory: String, name: String },
}

/// Show one panel and wait for it.
///
/// The panel is built on the main thread — every AppKit object here belongs to
/// it — and the answer comes back over a channel from the completion handler.
/// The `usize` is the window pointer: a raw pointer is not `Send`, and the
/// closure has to cross a thread to reach the main one.
pub async fn run(
    app: &tauri::AppHandle,
    title: String,
    kind: Kind,
) -> Result<Option<String>, String> {
    let window = app.get_webview_window("main").ok_or("no window to hang a sheet on")?;
    let ns = window.ns_window().map_err(|e| e.to_string())?;
    if ns.is_null() {
        return Err("no window to hang a sheet on".into());
    }
    let handle = ns as usize;

    let (tx, rx) = std::sync::mpsc::sync_channel::<Option<String>>(1);
    app.run_on_main_thread(move || unsafe { present(handle, &title, kind, tx) })
        .map_err(|e| e.to_string())?;

    // The sheet is open for as long as someone is looking at it, so this waits
    // on a blocking thread rather than on the async runtime's. A send that
    // never comes — the completion dropped without firing — reads as a cancel,
    // which is the harmless way to be wrong about it.
    Ok(crate::git::blocking(move || rx.recv().unwrap_or(None)).await)
}

/// `NSString` from a Rust string. Interior NUL is the one input `CString`
/// refuses, and a filename holding one could not have come from a filesystem.
unsafe fn nsstring(s: &str) -> Option<Retained<AnyObject>> {
    let c = CString::new(s).ok()?;
    let obj: Option<Retained<AnyObject>> =
        msg_send![class!(NSString), stringWithUTF8String: c.as_ptr()];
    obj
}

/// The other direction, for the path the panel hands back.
unsafe fn string(ns: &AnyObject) -> Option<String> {
    let ptr: *const c_char = msg_send![ns, UTF8String];
    if ptr.is_null() {
        return None;
    }
    Some(CStr::from_ptr(ptr).to_string_lossy().into_owned())
}

/// Build the panel and hang it off the window. Returns immediately — the sheet
/// is not modal to us, and the answer arrives in the completion handler.
unsafe fn present(handle: usize, title: &str, kind: Kind, tx: SyncSender<Option<String>>) {
    let window: *mut AnyObject = handle as *mut AnyObject;

    let saving = matches!(kind, Kind::Save { .. });
    let panel: Retained<AnyObject> = if saving {
        msg_send![class!(NSSavePanel), savePanel]
    } else {
        msg_send![class!(NSOpenPanel), openPanel]
    };

    if let Some(msg) = nsstring(title) {
        let _: () = msg_send![&*panel, setMessage: &*msg];
    }
    // A folder you are about to save into, or add to a project, may well not
    // exist yet. Both panels offer the New Folder button.
    let _: () = msg_send![&*panel, setCanCreateDirectories: true];

    match &kind {
        Kind::Directory => {
            let _: () = msg_send![&*panel, setCanChooseDirectories: true];
            let _: () = msg_send![&*panel, setCanChooseFiles: false];
            let _: () = msg_send![&*panel, setAllowsMultipleSelection: false];
        }
        Kind::File { extensions } => {
            let _: () = msg_send![&*panel, setCanChooseDirectories: false];
            let _: () = msg_send![&*panel, setCanChooseFiles: true];
            let _: () = msg_send![&*panel, setAllowsMultipleSelection: false];
            if !extensions.is_empty() {
                // `setAllowedFileTypes:` has been deprecated since macOS 12 in
                // favour of `setAllowedContentTypes:`, which takes `UTType`s
                // and would mean linking UniformTypeIdentifiers for a list of
                // audio extensions. It still works, and an extension list that
                // stopped filtering would be a wider panel rather than a
                // broken one — the failure this file exists for was not that
                // kind.
                let mut types: Vec<Retained<AnyObject>> = Vec::new();
                for e in extensions {
                    if let Some(s) = nsstring(e) {
                        types.push(s);
                    }
                }
                let refs: Vec<*const AnyObject> = types.iter().map(|t| &**t as *const _).collect();
                let array: Option<Retained<AnyObject>> = msg_send![
                    class!(NSArray),
                    arrayWithObjects: refs.as_ptr(),
                    count: refs.len()
                ];
                if let Some(array) = array {
                    let _: () = msg_send![&*panel, setAllowedFileTypes: &*array];
                }
            }
        }
        Kind::Save { directory, name } => {
            if !name.is_empty() {
                if let Some(n) = nsstring(name) {
                    let _: () = msg_send![&*panel, setNameFieldStringValue: &*n];
                }
            }
            // Only if it is really there: `fileURLWithPath:` on a directory
            // that has moved gives the panel a location it cannot open, and it
            // opens nowhere rather than somewhere sensible.
            if std::path::Path::new(directory).is_dir() {
                if let Some(d) = nsstring(directory) {
                    let url: Option<Retained<AnyObject>> = msg_send![
                        class!(NSURL),
                        fileURLWithPath: &*d,
                        isDirectory: true
                    ];
                    if let Some(url) = url {
                        let _: () = msg_send![&*panel, setDirectoryURL: &*url];
                    }
                }
            }
        }
    }

    // The panel is captured by the block, which is what keeps it alive until
    // the sheet ends: nothing else holds it once `present` returns.
    let held = panel.clone();
    let completion = RcBlock::new(move |response: isize| {
        let mut picked = None;
        if response == OK {
            let url: Option<Retained<AnyObject>> = msg_send![&*held, URL];
            if let Some(url) = url {
                let path: Option<Retained<AnyObject>> = msg_send![&*url, path];
                if let Some(path) = path {
                    picked = string(&path);
                }
            }
        }
        let _ = tx.send(picked);
    });

    let _: () = msg_send![
        &*panel,
        beginSheetModalForWindow: window,
        completionHandler: &*completion
    ];
}
