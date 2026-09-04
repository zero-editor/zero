mod cli;
mod files;
mod git;
mod linear;
mod links;
#[cfg(target_os = "macos")]
mod high_refresh;
mod memos;
mod notes;
mod opaque;
mod opens;
// macOS-only by nature: it is AppKit panels, and the objc2 crates it needs are
// target-gated in Cargo.toml
#[cfg(target_os = "macos")]
mod panel;
mod pty;
mod ptyd;
mod recents;
mod search;
mod session;
mod traffic_lights;
mod window_state;

use pty::PtyManager;

/// The webview console isn't forwarded to the terminal running `tauri dev`,
/// which makes frontend state invisible while debugging. This puts it on stdout.
#[tauri::command]
fn debug_log(msg: String) {
    println!("[web] {msg}");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // `zero --ptyd <socket>` is not the app at all: it is the process that
    // owns the shells, and it is this same binary because a second crate would
    // have meant a second build, an `externalBin` entry, a CI step and another
    // Mach-O to sign — all to ship code already sitting in this one. Handled
    // here, before anything of Tauri's is touched, so the daemon has no
    // NSApplication, no menu and no window.
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some("--ptyd") => match args.next() {
            Some(socket) => ptyd::server::run(&socket),
            None => {
                eprintln!("zero: --ptyd needs a socket path");
                std::process::exit(2);
            }
        },
        // The way out when the app is the thing that is broken. Deliberately
        // reachable without starting a window, because "restart zero" stopped
        // being a fix the moment the shells started outliving it.
        Some("--sessions") => pty::cli(false),
        Some("--kill-sessions") => pty::cli(true),
        _ => {}
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_liquid_glass::init())
        // in-app updates. The updater fetches and verifies; `process` is what
        // relaunches afterwards, and the two are separate plugins because
        // relaunching is the part that costs something here — see the restart
        // button in Titlebar, which never fires it without asking.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(PtyManager::default())
        .manage(memos::MemoManager::default())
        .manage(opens::PendingOpens::default())
        .manage(session::SessionStore::default())
        .setup(|_app| {
            // zero → Preferences… and zero → Check for Updates…, the mouse
            // paths to the settings overlay and the updater. The menu is the
            // stock one with the two of them slotted into Apple's spot for
            // preferences — under About and its separator — and everything
            // else in the default is already right. The accelerator shown on
            // Preferences is ⌘,, but the webview's own keydown handler
            // consumes that press before it reaches the menu; here it is the
            // printed hint, and clicking is what emits.
            //
            // The check carries a native icon because everything around it
            // does: macOS 26 draws a symbol beside About, Services, Hide and
            // Quit on its own, and a bare row in that column reads as an item
            // that hasn't finished loading. Refresh is the system's own image
            // for looking again, so it is the one that matches rather than
            // resembles.
            {
                use tauri::menu::{IconMenuItem, Menu, MenuItem, NativeIcon, PredefinedMenuItem};
                let handle = _app.handle();
                let menu = Menu::default(handle)?;
                if let Some(app_menu) = menu.items()?.first().and_then(|i| i.as_submenu().cloned())
                {
                    let prefs = MenuItem::with_id(
                        handle,
                        "preferences",
                        "Preferences…",
                        true,
                        Some("Cmd+,"),
                    )?;
                    let updates = IconMenuItem::with_id_and_native_icon(
                        handle,
                        "check-for-updates",
                        "Check for Updates…",
                        true,
                        Some(NativeIcon::Refresh),
                        None::<&str>,
                    )?;
                    // the default opens About, separator, Services…, so 2 is
                    // under that separator and above Services
                    app_menu.insert_items(
                        &[&prefs, &updates, &PredefinedMenuItem::separator(handle)?],
                        2,
                    )?;
                }
                _app.set_menu(menu)?;
                _app.on_menu_event(|app, event| {
                    use tauri::Emitter;
                    match event.id().as_ref() {
                        "preferences" => {
                            let _ = app.emit("open-settings", ());
                        }
                        // the frontend owns the updater — it is the half that
                        // can say what it found, and it already holds the
                        // check the app runs on its own every six hours
                        "check-for-updates" => {
                            let _ = app.emit("check-for-updates", ());
                        }
                        _ => {}
                    }
                });
            }

            // the shells, in their own process. First, because the webview
            // asks for one the moment it has laid a pane out.
            match pty::start(_app.handle()) {
                Ok(()) => println!("[pty] daemon up"),
                Err(e) => println!("[pty] no daemon, terminals will not start: {e}"),
            }

            // the `zero` shell command comes with the app, so installing the
            // app is the whole install
            match cli::install_command() {
                Ok(what) => println!("[cli] ~/.local/bin/zero {what}"),
                Err(e) => println!("[cli] no shell command: {e}"),
            }
            cli::watch(_app.handle().clone());

            #[cfg(target_os = "macos")]
            {
                use tauri::Manager;
                if let Some(window) = _app.get_webview_window("main") {
                    let _ = window.with_webview(|webview| {
                        match high_refresh::unlock(webview.inner()) {
                            Ok(()) => println!("[fps] display-rate rendering unlocked"),
                            Err(e) => println!("[fps] still clamped to 60: {e}"),
                        }
                    });

                    // A relaunched copy is spawned by the copy that is
                    // exiting, which is not a launch macOS gives the front of
                    // the stack to: without this the new zero comes up behind
                    // every other app, which is exactly the moment — right
                    // after you asked it to restart — when it is being looked
                    // for. Done before the window is put back, since entering
                    // fullscreen wants an active window.
                    let _ = window.set_focus();
                    // and put back where the last one was left, fullscreen
                    // included. See window_state.rs for why this isn't saved
                    // at exit.
                    window_state::restore(&window);
                    window_state::watch(&window);

                    // The traffic lights go on the bar's axis before the
                    // window is on screen, at the height the bar has at zoom
                    // 1 — the frontend sends the real one as soon as it has
                    // measured itself, which is a frame or two later and only
                    // a different number if the UI is zoomed in.
                    if let Ok(ns) = window.ns_window() {
                        let _ = traffic_lights::centre(ns, 40.0);
                    }
                    // and stay there: AppKit puts them back at its own
                    // default every time it lays the titlebar out, which is
                    // every frame of a live resize
                    if let Ok(ns) = window.ns_window() {
                        if let Err(e) = traffic_lights::watch(ns) {
                            println!("[titlebar] traffic lights left to macOS: {e}");
                        }
                    }
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            debug_log,
            traffic_lights::titlebar_height,
            opaque::set_opaque,
            links::open_url,
            links::reveal_path,
            links::resolve_paths,
            files::create_entry,
            files::rename_entry,
            files::duplicate_entry,
            files::trash_entry,
            recents::get_recents,
            recents::add_recent,
            recents::remove_recent,
            recents::existing_dirs,
            session::session_load,
            session::session_save,
            cli::pick_directory,
            cli::pick_file,
            cli::pick_save_path,
            opens::classify_opens,
            opens::take_open_paths,
            git::git_worktrees,
            git::git_worktree_remove,
            pty::agent_status,
            git::git_status,
            git::git_stage,
            git::git_unstage,
            git::git_discard,
            git::git_commit,
            git::git_push,
            git::git_branch_info,
            linear::linear_connected,
            linear::linear_connect,
            linear::linear_disconnect,
            linear::linear_connections,
            linear::linear_issues,
            linear::linear_issue,
            linear::linear_save_description,
            git::git_head_file,
            git::git_index_file,
            git::git_show_binary,
            git::git_baseline,
            git::list_dir,
            git::list_project_files,
            git::read_file,
            git::read_binary,
            git::write_file,
            search::search_project,
            search::replace_matches,
            pty::pty_kill_all,
            pty::pty_reap,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            memos::memo_probe,
            memos::memo_list,
            memos::memo_record_start,
            memos::memo_import,
            memos::memo_record_stop,
            memos::memo_record_pause,
            memos::memo_record_resume,
            memos::memo_record_cancel,
            memos::memo_retry,
            memos::memo_delete,
            memos::memo_vocabulary_path,
            notes::note_open,
            notes::note_format,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        // The last word on the window's layout.
        //
        // Quitting ends in `std::process::exit`, which never unloads the page
        // — so the webview gets no chance to save on the way out, and this is
        // the only place left that can. `commit` writes whatever the frontend
        // handed over last and skips a snapshot already on disk, so the usual
        // case (nothing changed since the last save) costs a string compare.
        .run(|app, event| {
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                let _ = session::commit(app);
            }
            // Finder handing files over — "Open With", a drop on the Dock
            // icon. It can fire before the webview has a listener (a cold
            // launch by double-clicked file), which is why these are queued
            // and drained rather than emitted with a payload; see opens.rs.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = &event {
                let paths = urls
                    .iter()
                    .filter_map(|u| u.to_file_path().ok())
                    .filter_map(|p| p.to_str().map(String::from))
                    .collect();
                opens::queue(app, paths);
            }
        });
}
