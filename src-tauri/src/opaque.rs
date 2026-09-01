//! The window's opacity flag, handed to the frontend's glass toggle.
//!
//! `transparent: true` in tauri.conf.json is a promise to WindowServer that
//! any pixel of this window may need blending against whatever is behind it —
//! and WindowServer then blends every frame the window repaints, forever,
//! whether or not anything translucent is on screen. With Liquid Glass on
//! that cost is the point. With it off, every surface paints a solid color
//! and the promise only costs: a terminal cursor blinking in a "solid"
//! window was enough to keep WindowServer warm.
//!
//! The config flag is fixed at build time, so the correction happens here at
//! runtime: App.tsx calls this alongside the glass effect — non-opaque just
//! before the glass pane goes in, opaque again after it is gone. `isOpaque`
//! is the one bit WindowServer trusts over the config, and the background
//! color goes with it because an opaque window with a clear background
//! flashes black where the webview hasn't painted yet (live resize).

#[tauri::command]
pub fn set_opaque(window: tauri::Window, opaque: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let win = window.clone();
        window
            .run_on_main_thread(move || {
                let Ok(ns) = win.ns_window() else { return };
                if ns.is_null() {
                    return;
                }
                use objc2::runtime::{AnyObject, Bool};
                use objc2::{class, msg_send};
                unsafe {
                    let window: *mut AnyObject = ns.cast();
                    let _: () = msg_send![window, setOpaque: Bool::new(opaque)];
                    // windowBackgroundColor, not a hardcoded tone: it follows
                    // the appearance the window was already set to, so light
                    // mode's resize edges don't flash dark.
                    let color: *mut AnyObject = if opaque {
                        msg_send![class!(NSColor), windowBackgroundColor]
                    } else {
                        msg_send![class!(NSColor), clearColor]
                    };
                    let _: () = msg_send![window, setBackgroundColor: color];
                }
            })
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (window, opaque);
    Ok(())
}
