//! The pty daemon: the process that actually owns the shells.
//!
//! It is the same binary as the app, re-executed as `zero --ptyd <socket>`.
//! A separate crate would have meant a second build, an `externalBin` entry, a
//! CI step and another Mach-O to sign and notarize — all to ship code that is
//! already inside the binary sitting next to it.
//!
//! Its whole promise fits in a sentence: **quitting zero takes its terminals
//! with it, restarting zero does not.** That is the expectation people already
//! hold about applications — a dev server outliving the editor that started it
//! is the surprising behaviour, not the helpful one — and everything here is
//! in service of the second half of it.
//!
//! A client that goes away does not end its sessions; it starts a clock
//! (`GRACE_MS`). An app that comes back inside that window is handed each
//! shell exactly where it left off, screen and all, and cannot tell the
//! difference from having spawned it. An app that never comes back loses them
//! to the reaper, which is the same outcome quitting always had.

use crate::ptyd::proto;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};

struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    // false once pty_kill ran: suppresses the reader thread's pty-exit so a
    // deliberate kill can't be mistaken for the shell exiting on its own
    alive: Arc<AtomicBool>,
    cwd: String,
    shell_pid: Option<u32>,
    // ms since the epoch of the last byte this shell printed that wasn't a
    // reaction to typing, and of the last keystroke sent to it
    last_output: Arc<AtomicU64>,
    last_input: Arc<AtomicU64>,
    // when the current run of output began; a run ends after BURST_GAP_MS of
    // silence. Lets a one-off redraw be told apart from sustained work.
    burst_start: Arc<AtomicU64>,
    // what the terminal title last said about Claude: TITLE_* below
    claude_title: Arc<AtomicU8>,
    /// A headless terminal fed everything this shell prints, so the daemon
    /// knows what the screen *looks like* and not merely what crossed it.
    /// Replaying raw bytes from an arbitrary point cannot work — attach in the
    /// middle of Claude's TUI and you replay a fragment into a terminal with
    /// no idea which mode it is in. This can be asked for the screen instead.
    parser: Arc<Mutex<vt100::Parser>>,
}

/// No title seen yet, or the last one wasn't Claude's — fall back to guessing
/// from output activity.
const TITLE_UNKNOWN: u8 = 0;
/// Claude's title starts with a spinner glyph: mid-task.
const TITLE_WORKING: u8 = 1;
/// Claude's title starts with ✳: waiting on you — finished, or sitting on a
/// permission prompt.
const TITLE_IDLE: u8 = 2;

/// Reads Claude Code's state out of the terminal titles it sets, which beats
/// inferring it from output timing: Claude retitles the terminal through
/// OSC 0 the moment it starts and the moment it stops, while its drawn UI can
/// go quiet mid-task (a silent tool call, a slow API turn) and flicker the
/// activity heuristic.
///
/// Measured against Claude Code 2.1.234: `ESC ] 0 ; <glyph> <topic> BEL`,
/// where the glyph is ✳ when idle and an animated ◐/◑ while working —
/// retitled to ✳ during a permission prompt too, which is right, since that
/// *is* waiting on you. Any other title (the shell's own, say) means Claude
/// isn't speaking, and the caller falls back to the timing heuristic.
struct TitleScanner {
    state: TitleScan,
    buf: Vec<u8>,
}

enum TitleScan {
    Ground,
    Esc,
    Osc,
    /// ESC seen inside the OSC — either the start of the ST terminator or a
    /// mangled sequence.
    OscEsc,
}

/// Longest title worth keeping. Anything bigger isn't a title, so the
/// sequence is abandoned rather than buffered without bound.
const TITLE_MAX: usize = 512;

impl TitleScanner {
    fn new() -> Self {
        Self { state: TitleScan::Ground, buf: Vec::new() }
    }

    /// Feed one chunk of pty output; sequences may split anywhere across
    /// chunks. Returns the classification of the last complete title, if any.
    fn feed(&mut self, bytes: &[u8]) -> Option<u8> {
        let mut latest = None;
        for &b in bytes {
            if let Some(t) = self.step(b) {
                latest = Some(t);
            }
        }
        latest
    }

    fn step(&mut self, b: u8) -> Option<u8> {
        match self.state {
            TitleScan::Ground => {
                if b == 0x1b {
                    self.state = TitleScan::Esc;
                }
                None
            }
            TitleScan::Esc => {
                self.state = match b {
                    b']' => {
                        self.buf.clear();
                        TitleScan::Osc
                    }
                    0x1b => TitleScan::Esc,
                    _ => TitleScan::Ground,
                };
                None
            }
            TitleScan::Osc => match b {
                0x07 => {
                    self.state = TitleScan::Ground;
                    self.classify()
                }
                0x1b => {
                    self.state = TitleScan::OscEsc;
                    None
                }
                _ if self.buf.len() >= TITLE_MAX => {
                    self.state = TitleScan::Ground;
                    None
                }
                _ => {
                    self.buf.push(b);
                    None
                }
            },
            TitleScan::OscEsc => {
                if b == b'\\' {
                    self.state = TitleScan::Ground;
                    self.classify()
                } else {
                    // not ST — abandon the sequence, but the ESC may open a
                    // new one, so replay this byte through the Esc state
                    self.state = TitleScan::Esc;
                    self.step(b)
                }
            }
        }
    }

    /// None for an OSC that isn't a title at all (hyperlinks, colors) — those
    /// say nothing about Claude. A real title that isn't Claude's is
    /// Some(TITLE_UNKNOWN): the shell has retitled, Claude no longer speaks.
    fn classify(&self) -> Option<u8> {
        // OSC 0 sets icon and title, 1 and 2 each half; Claude uses 0 today
        let title = [b"0;".as_slice(), b"1;", b"2;"]
            .iter()
            .find_map(|p| self.buf.strip_prefix(*p))?;
        Some(match String::from_utf8_lossy(title).chars().next() {
            Some('✳') => TITLE_IDLE,
            // the full half-circle family, though only ◐ and ◑ were observed
            Some('◐'..='◓') => TITLE_WORKING,
            _ => TITLE_UNKNOWN,
        })
    }
}

/// Output arriving within this long after a keystroke is echo / input-box
/// redraw, not Claude doing work.
const ECHO_WINDOW_MS: u64 = 350;

/// Silence longer than this starts a new run of output.
const BURST_GAP_MS: u64 = 400;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// zsh has no way to set the prompt from the environment: macOS's `/etc/zshrc`
/// assigns the stock `%n@%m %1~ %#` and only files zsh loads afterwards can
/// change it. The way round that — the same one VS Code and Warp use — is to
/// point ZDOTDIR at a directory of our own whose startup files source the
/// user's, then add ours at the end.
///
/// Every file is guarded, so a missing or broken user config still yields a
/// working shell, and the prompt is only replaced when it is still the stock
/// one: the moment you set PROMPT yourself, zero stops touching it.
///
/// Returns the directory to hand to zsh as ZDOTDIR, or None if anything about
/// writing it fails — in which case the shell simply starts as it always did.
fn zsh_dotdir(home: &str) -> Option<String> {
    // sourced with ZDOTDIR pointing at the user's directory, then put back, so
    // zsh keeps reading the rest of its startup files from ours
    const RELAY: &str = r#"# Written by zero. Loads your own zsh config, unchanged.
zero_here=$ZDOTDIR
ZDOTDIR=${ZERO_ZDOTDIR:-$HOME}
[[ -f "$ZDOTDIR/FILE" ]] && source "$ZDOTDIR/FILE"
ZDOTDIR=$zero_here
unset zero_here
"#;

    let dir = std::path::Path::new(home)
        .join("Library/Application Support/zero/zsh");
    std::fs::create_dir_all(&dir).ok()?;

    for name in [".zshenv", ".zprofile"] {
        std::fs::write(dir.join(name), RELAY.replace("FILE", name)).ok()?;
    }
    // last of ours to run: hand ZDOTDIR back for good, so anything later (and
    // any zsh started from this one) reads the user's files directly
    let zshrc = format!(
        "{}\n\
         # only the directory — user@host is the same in every pane and says\n\
         # nothing you don't already know. Skipped if you set your own prompt.\n\
         [[ \"$PROMPT\" == '%n@%m %1~ %# ' ]] && PROMPT='%1~ %# '\n\
         ZDOTDIR=${{ZERO_ZDOTDIR:-$HOME}}\n",
        RELAY.replace("FILE", ".zshrc")
    );
    std::fs::write(dir.join(".zshrc"), zshrc).ok()?;

    Some(dir.to_string_lossy().to_string())
}


// ── the client's end of the socket, whoever the client is now ────────────────

/// Where frames go, indirected through an `Option` because the app on the
/// other end is no longer a fixed thing. It quits, it is updated, it crashes
/// and comes back; the shells do not. Every session's reader thread holds a
/// clone of this and keeps writing into it across all of that — into nothing
/// while detached, into the new socket once someone reattaches.
///
/// The lock is not about the stream being thread-safe. It is what stops one
/// frame landing in the middle of another, which desyncs the stream with no
/// way back.
/// Say something, and never die for it.
///
/// The daemon inherits whatever stdio it was born with, and a parent that
/// piped its stderr can exit and leave that pipe with no reader. `eprintln!`
/// *panics* on a broken pipe — and a panic in a thread holding the session map
/// poisons the mutex, which turns one lost log line into a daemon that accepts
/// connections and answers none of them. The shells keep running, the screens
/// keep being kept, and every pane says the daemon did not answer.
///
/// So: never `eprintln!` in here, and never hold a lock across this call.
fn log(msg: &str) {
    use std::io::Write;
    let _ = writeln!(std::io::stderr(), "zero-ptyd: {msg}");
}

/// Lock, and keep going even if a previous holder panicked.
///
/// Poisoning is the right default for data that a panic may have left half
/// written. This map is not that: its entries are whole or absent, and the
/// cost of refusing to touch it is every terminal in the app going dark. The
/// daemon would rather carry on.
fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Clone)]
pub struct Out(Arc<Mutex<Attached>>);

#[derive(Default)]
struct Attached {
    /// The queue, not the socket. Frames are handed to a writer thread that
    /// owns the stream, so `send` never performs I/O and therefore never
    /// blocks — which is what makes it safe to call while holding a lock.
    ///
    /// It was not always safe. `send` used to write to the socket directly,
    /// under this mutex, from whichever thread produced the frame; a client
    /// that stopped draining would block that thread mid-write, and if the
    /// thread happened to be holding the session map — the replay path did —
    /// every other terminal in the app stalled behind it.
    ///
    /// Dropping the sender is what stops the writer thread, so `detach` needs
    /// to do nothing else.
    tx: Option<std::sync::mpsc::Sender<(u8, Vec<u8>)>>,
    /// Bumped on every attach, and the reason this is not just an `Option`.
    ///
    /// A restart puts two app connections on this daemon at once: the new one
    /// arrives before the old one's EOF has been noticed, because the old app
    /// being gone is *why* the new one is here. Both then run their teardown,
    /// and without a way to tell whose slot this is the departing connection
    /// clears the arriving one's — after which every reply and every byte of
    /// output is dropped, the app's spawns time out, and the panes come up
    /// saying the daemon did not answer.
    generation: u64,
}

impl Out {
    fn new() -> Self {
        Out(Arc::new(Mutex::new(Attached::default())))
    }

    /// Take the slot, and return the ticket needed to give it back.
    fn attach(&self, stream: UnixStream) -> u64 {
        let (tx, rx) = std::sync::mpsc::channel::<(u8, Vec<u8>)>();
        std::thread::spawn(move || {
            let mut stream = stream;
            // ends when the sender is dropped, i.e. on detach or replacement
            while let Ok((tag, body)) = rx.recv() {
                if proto::write_frame(&mut stream, tag, &body).is_err() {
                    break;
                }
            }
        });
        let mut slot = lock(&self.0);
        slot.generation += 1;
        slot.tx = Some(tx);
        slot.generation
    }

    /// Give the slot back, but only if it is still ours. Returns whether it
    /// was — which is also the answer to "should the grace clock start", since
    /// a connection that has already been replaced never really left.
    fn detach(&self, generation: u64) -> bool {
        let mut slot = lock(&self.0);
        if slot.generation != generation {
            return false;
        }
        slot.tx = None;
        true
    }

    /// Queue one frame. Dropped silently when nobody is attached, which is not
    /// a failure but the normal state of a session whose window is closed —
    /// the screen is being kept in `parser` regardless, so nothing said into
    /// the void is actually lost.
    fn send(&self, tag: u8, body: &[u8]) {
        let slot = lock(&self.0);
        if let Some(tx) = slot.tx.as_ref() {
            let _ = tx.send((tag, body.to_vec()));
        }
    }
}

/// `0` while a client is attached, otherwise the moment the last one left.
/// Every session detaches at once because there is only ever one client, which
/// is what lets the grace window be a single number rather than bookkeeping
/// per session.
#[derive(Default)]
struct Detached(AtomicU64);

#[derive(Default)]
struct Sessions(Mutex<HashMap<String, PtySession>>);

// ── what is running inside them ──────────────────────────────────────────────

#[derive(Serialize)]
pub struct AgentStat {
    /// the session's own id — the one the pane spawned it under — so a pane
    /// can find its row, not only a project its total
    pub id: String,
    pub cwd: String,
    /// a `claude` or `codex` process is running under this shell
    pub running: bool,
    /// Codex does not publish Claude's terminal-title state, so callers use
    /// the output-activity fallback whenever this is the agent in the pane.
    pub codex: bool,
    /// ms since that shell last printed anything — Claude Code animates while
    /// it works, so silence means it's finished and waiting on you
    pub quiet_ms: u64,
    /// how long the current unbroken run of output has lasted. A redraw
    /// triggered by focus or resize is a blip; real work sustains.
    pub burst_ms: u64,
    /// what Claude's own terminal title says — Some(true) mid-task,
    /// Some(false) waiting on you, None when no Claude title has been seen
    /// and the caller has only quiet_ms/burst_ms to go on
    pub title_working: Option<bool>,
}

/// One `ps` sweep of the whole machine, as a map from parent to children.
///
/// In the app this had to be async and go through the blocking pool: a
/// once-a-second `ps` on the main thread was a visible hitch, a tab drag
/// twitching in time with the poll. Out here there is no main thread to
/// protect and no command slot to park, so it is an ordinary blocking call —
/// one of the things that got simpler purely by leaving the UI process.
fn ps_children() -> HashMap<u32, Vec<(u32, String)>> {
        let out = std::process::Command::new("/bin/ps")
            .args(["-axo", "pid=,ppid=,comm="])
            .output();
        let mut children: HashMap<u32, Vec<(u32, String)>> = HashMap::new();
        if let Ok(out) = out {
            for line in String::from_utf8_lossy(&out.stdout).lines() {
                // ps pads its columns ("  1609  1257 claude"), so split on
                // runs of whitespace — splitn on single chars yields empty
                // fields here
                let mut it = line.split_whitespace();
                let (Some(pid), Some(ppid), Some(comm)) = (it.next(), it.next(), it.next())
                else {
                    continue;
                };
                if let (Ok(pid), Ok(ppid)) = (pid.parse::<u32>(), ppid.parse::<u32>()) {
                    let name = comm.rsplit('/').next().unwrap_or("").to_string();
                    children.entry(ppid).or_default().push((pid, name));
                }
            }
        }
        children
}

fn agents(children: &HashMap<u32, Vec<(u32, String)>>, pid: u32, depth: u8) -> (bool, bool) {
    if depth > 6 {
        return (false, false);
    }
    let mut found = (false, false);
    for (cpid, name) in children.get(&pid).into_iter().flatten() {
        found.0 |= name.starts_with("claude");
        found.1 |= name.starts_with("codex");
        let nested = agents(children, *cpid, depth + 1);
        found.0 |= nested.0;
        found.1 |= nested.1;
    }
    found
}

fn status(sessions: &Sessions) -> Vec<AgentStat> {
    let children = ps_children();
    let now = now_ms();
    let stats = sessions
        .0
        .lock()
        .unwrap()
        .iter()
        .map(|(id, s)| {
            let last = s.last_output.load(Ordering::Relaxed);
            let (claude, codex) = s
                .shell_pid
                .map_or((false, false), |p| agents(&children, p, 0));
            let running = claude || codex;
            if !running {
                // don't let a dead session's last title speak for the next
                // one: a claude that exits mid-work leaves ◐ behind, and a
                // later launch would wear it until its own first retitle
                s.claude_title.store(TITLE_UNKNOWN, Ordering::Relaxed);
            }
            AgentStat {
                id: id.clone(),
                cwd: s.cwd.clone(),
                running,
                codex,
                quiet_ms: now.saturating_sub(last),
                burst_ms: last.saturating_sub(s.burst_start.load(Ordering::Relaxed)),
                title_working: match s.claude_title.load(Ordering::Relaxed) {
                    TITLE_WORKING => Some(true),
                    TITLE_IDLE => Some(false),
                    _ => None,
                },
            }
        })
        .collect();
    stats
}

// ── how long a shell outlives the window it was in ───────────────────────────

/// How long a detached session is kept — a restart, and nothing longer.
///
/// This began as three windows scaled by what was running: 90s for an idle
/// prompt, 30 minutes for a dev server, 8 hours for a Claude session. The
/// 8 hours was the tell. A `claude` process is about 600 MB resident, and an
/// afternoon of a forgotten one costs more than the session was worth.
///
/// Shortening them took the classification with it, which is the better half
/// of the change. Scaling the window by contents only made sense while the
/// windows were long enough to differ; at this length there is nothing to
/// choose between them, and a single number says what the feature actually
/// promises. It also means the reaper no longer sweeps `ps` on every tick to
/// decide — it compares two integers.
///
/// The promise is the one people already hold about applications: quitting an
/// app takes its terminals with it, the same way quitting Terminal.app or a
/// VS Code window does. A dev server outliving the editor that started it is
/// the surprising behaviour, not the helpful one. What zero adds is only that
/// *restarting* is not quitting — updates, crashes, and a quit you took back
/// all land inside this window, and a real quit lands outside it.
///
/// Two minutes rather than one because the slowest restart anyone actually
/// performs is a `tauri dev` rebuild, which is roughly that — and whoever is
/// working on zero is doing it inside zero.
const GRACE_MS: u64 = 2 * 60_000;

/// How often the reaper looks. Nothing here is precise enough for the tick to
/// matter, and the whole of a tick is now two integer comparisons.
const REAP_TICK: std::time::Duration = std::time::Duration::from_secs(5);

/// Ends the sessions whose window is not coming back.
///
/// Every session on the same clock, because the window is short enough that
/// nothing it could be running would change the answer. That is what removed
/// the `ps` sweep this used to run on every tick to classify them — the sweep
/// walks every process on the machine, and it was by far the most expensive
/// thing the daemon did while nobody was even watching.
fn reaper(sessions: Arc<Sessions>, detached: Arc<Detached>, socket: std::path::PathBuf) {
    loop {
        std::thread::sleep(REAP_TICK);
        let since = detached.0.load(Ordering::Relaxed);
        if since == 0 {
            continue; // somebody is watching
        }
        let gone = now_ms().saturating_sub(since);
        if gone <= GRACE_MS {
            continue;
        }
        let expired: Vec<String> = lock(&sessions.0).keys().cloned().collect();
        for id in expired {
            log(&format!("reaping {id} after {}s detached", gone / 1000));
            kill(&sessions, &id);
        }

        // Nothing left to hold and nobody to hold it for. A daemon with no
        // sessions is not doing anything a fresh one could not do, and a
        // background process that outlives its last reason to exist is how
        // you end up with a machine full of them. The same clause is what
        // cleans up a daemon the app never managed to connect to at all.
        if lock(&sessions.0).is_empty() {
            log("nothing left to hold, exiting");
            let _ = std::fs::remove_file(&socket);
            std::process::exit(0);
        }
    }
}

// ── starting a shell, or handing back the one already running ────────────────

/// How much history the headless screen keeps behind the visible rows, and so
/// how far back a reattached pane can scroll.
///
/// It was zero until people restarted with Claude open and found the
/// conversation gone: `state_formatted` reproduces the *visible* screen, and
/// with nothing held behind it the pane came back as one screenful with an
/// empty buffer above — nothing broken about scrolling, nothing to scroll to.
///
/// The cost is a row of `vt100::Cell` per line, 32 bytes a cell, allocated
/// only as lines actually scroll off: about 7 MB for a session that fills
/// this at 120 columns, and nothing at all for a shell sitting at a prompt.
/// The frontend keeps 10000 rows per pane in xterm already, which is the
/// larger of the two and the reason this one doesn't need to match it.
const SCROLLBACK: usize = 2000;

/// The bytes that put a reattaching pane back the way it was, history first.
///
/// Three pieces, in this order and each for a reason:
///
/// - **The scrollback, printed as ordinary lines.** Not restored as history —
///   there is no escape sequence for "here is what scrolled off" — but printed
///   the way the shell first printed it, so the receiving terminal scrolls it
///   off into its own buffer itself. Only row 0 of each position is taken:
///   within one row the formatter's moves are relative (a column advance, an
///   erase to end of line), so a row is safe to print as a line, while a
///   screenful at once would carry absolute cursor positions that mean
///   nothing in a stream.
/// - **`rows - 1` newlines.** The lines just printed that are still on the
///   visible screen are about to be painted over by the screen state, not
///   scrolled — so they have to be pushed up first, or the newest screenful of
///   history is the one part lost. One too few loses a line; one too many puts
///   a blank row in the history.
/// - **The screen itself**, exactly as before.
///
/// On the alternate screen there is no history to hand back — vt100 gives that
/// grid no scrollback — so a TUI session skips to the third piece and gets
/// what it always got.
fn replay(parser: &mut vt100::Parser, cols: u16, rows: u16) -> Vec<u8> {
    let mut out = Vec::new();

    // `set_scrollback` clamps to what is actually held and `scrollback` reads
    // the offset back, so asking for more than could exist is how you find out
    // how much there is.
    parser.screen_mut().set_scrollback(usize::MAX);
    let held = parser.screen().scrollback();

    if held > 0 {
        // A no-op on the freshly mounted pane this is written for, and here so
        // that what follows is true of any screen rather than only that one.
        out.extend_from_slice(b"\x1b[H\x1b[J");

        // At offset k the top visible row is the k-th from the end of the
        // history, so counting k down walks it oldest to newest.
        for k in (1..=held).rev() {
            parser.screen_mut().set_scrollback(k);
            if let Some(row) = parser.screen().rows_formatted(0, cols).next() {
                out.extend_from_slice(&row);
            }
            // Each row is formatted as a diff from *default* attributes, so
            // the row before it has to leave them that way — otherwise one
            // line ending mid-colour tints everything under it. It also keeps
            // the colour out of the blank line the scroll inserts.
            out.extend_from_slice(b"\x1b[m\r\n");
        }

        for _ in 1..rows {
            out.extend_from_slice(b"\r\n");
        }
    }

    // Back to the live screen before reading it: `state_formatted` renders
    // whatever the offset above is pointing at.
    parser.screen_mut().set_scrollback(0);

    // `state_formatted` restores the cursor keys, the keypad, bracketed
    // paste and the mouse protocol — but not the alternate screen, which
    // vt100 tracks and simply never emits. Without this prefix a TUI's
    // last frame is painted onto the *normal* screen of the terminal
    // reattaching: it looks right, and then the TUI exits, `?1049l`
    // restores a normal screen that was never saved, and the frame it
    // drew is left behind in the scrollback instead of disappearing.
    //
    // Claude Code lives on the alternate screen, so this line is the
    // difference between reattaching to a Claude session and reattaching
    // to a picture of one. The receiving terminal is always freshly
    // mounted and therefore on the normal screen, so there is no matching
    // `?1049l` to emit for the other case.
    if parser.screen().alternate_screen() {
        out.extend_from_slice(b"\x1b[?1049h");
    }
    out.extend_from_slice(&parser.screen().state_formatted());
    out
}

/// Phase 2 in one function.
///
/// The frontend calls this for every pane it restores, exactly as it always
/// has, and cannot tell the two outcomes apart. A pane whose shell is still
/// running is resized to the new window and handed its screen back as ordinary
/// output, down the very path live bytes take — so the attach needed no new
/// verb in the frontend, and no second code path in xterm.js.
///
/// Returns whether it attached rather than spawned, which only the log cares
/// about.
fn spawn_or_attach(
    sessions: &Sessions,
    out: &Out,
    id: String,
    cwd: String,
    cols: u16,
    rows: u16,
) -> Result<bool, String> {
    // Is there a session under this id, is it still alive, and what is its
    // screen? Everything that needs the session map happens here, and the
    // guard is gone before a single byte is sent — the replay used to go out
    // with the map still locked, which stalled every other pane's keystrokes
    // behind one slow client.
    let existing = {
        let mut map = lock(&sessions.0);

        // A shell that exited while nobody was attached is a corpse, not a
        // session. Its `pty-exit` was dropped on the floor at the time — there
        // was no client to send it to — so nothing has removed it, and
        // reattaching would resize a dead pty, replay its last screen and hand
        // back a pane that looks alive and swallows every keystroke. Take it
        // out, and fall through to spawning a real one.
        let dead = map
            .get_mut(&id)
            .is_some_and(|s| matches!(s.child.try_wait(), Ok(Some(_))));
        if dead {
            if let Some(corpse) = map.remove(&id) {
                log(&format!("{id} exited while detached, spawning fresh"));
                reap(corpse.child);
            }
            None
        } else {
            map.get(&id).map(|session| {
                // The window this shell comes back to is rarely the size it
                // left. Resize first, then replay, so what is handed over
                // already fits — and the shell's own SIGWINCH redraw lands on
                // top of a screen that is the right shape rather than
                // correcting one that isn't.
                let _ = session.master.resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                });
                session.parser.clone()
            })
        }
    };

    if let Some(parser) = existing {
        // Held across the send, deliberately. The reader thread takes this
        // same lock around *its* process-and-send, so the two can no longer
        // interleave: bytes are either inside this snapshot or arrive after it
        // as live output, never both. Safe to hold because `send` only queues.
        let mut parser = lock(&parser);
        parser.screen_mut().set_size(rows, cols);
        let bytes = replay(&mut parser, cols, rows);
        out.send(proto::D_OUTPUT, &proto::encode_bytes(&id, &bytes));
        return Ok(true);
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let mut cmd = CommandBuilder::new(&shell);
    cmd.arg("-l");
    cmd.cwd(&cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    // This shell belongs to zero, not to whatever launched zero. Started from a
    // terminal, the parent's own identity comes along with it — and on macOS
    // that means TERM_SESSION_ID, which switches on /etc/zshrc_Apple_Terminal:
    // every new pty then opens with "Restored session: <date>" and starts
    // saving history into ~/.zsh_sessions for a window that has nothing to do
    // with us. Naming ourselves is also the hook a shell config needs to tell
    // it's running in here, the same way VS Code sets TERM_PROGRAM=vscode.
    cmd.env("TERM_PROGRAM", "zero");
    cmd.env_remove("TERM_SESSION_ID");
    cmd.env("SHELL_SESSIONS_DISABLE", "1");
    // Spotlight/Dock-launched apps get launchd's minimal environment, not the
    // user's shell env — ensure the usual tool locations are on PATH.
    let mut path = std::env::var("PATH").unwrap_or_default();
    if path.is_empty() {
        path = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin".to_string();
    }
    for p in ["/usr/local/bin", "/opt/homebrew/sbin", "/opt/homebrew/bin"] {
        if !path.split(':').any(|seg| seg == p) {
            path = format!("{p}:{path}");
        }
    }
    cmd.env("PATH", path);

    // zsh only: bash and fish read none of these files
    if shell.rsplit('/').next() == Some("zsh") {
        if let Ok(home) = std::env::var("HOME") {
            if let Some(dir) = zsh_dotdir(&home) {
                // where the user's own config lives, for our files to source
                cmd.env("ZERO_ZDOTDIR", std::env::var("ZDOTDIR").unwrap_or(home));
                cmd.env("ZDOTDIR", dir);
            }
        }
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);
    let shell_pid = child.process_id();

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let alive = Arc::new(AtomicBool::new(true));
    let last_output = Arc::new(AtomicU64::new(now_ms()));
    let last_input = Arc::new(AtomicU64::new(0));
    let burst_start = Arc::new(AtomicU64::new(now_ms()));
    let claude_title = Arc::new(AtomicU8::new(TITLE_UNKNOWN));
    let reader_last = last_output.clone();
    let reader_input = last_input.clone();
    let reader_burst = burst_start.clone();
    let reader_title = claude_title.clone();
    let reader_alive = alive.clone();
    let reader_id = id.clone();
    let parser = Arc::new(Mutex::new(vt100::Parser::new(rows, cols, SCROLLBACK)));
    let reader_parser = parser.clone();
    let out = out.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut titles = TitleScanner::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if !reader_alive.load(Ordering::Relaxed) {
                        break;
                    }
                    // The screen is kept whether or not anyone is watching —
                    // this is what makes a detached session worth reattaching
                    // to rather than merely still alive.
                    //
                    // Updated and sent under one lock, because an attach that
                    // snapshots the screen between the two would put these
                    // bytes in the snapshot *and* send them again as live
                    // output, painting them twice on a pane that is mid-draw.
                    {
                        let mut parser = lock(&reader_parser);
                        parser.process(&buf[..n]);
                        out.send(proto::D_OUTPUT, &proto::encode_bytes(&reader_id, &buf[..n]));
                    }
                    if let Some(t) = titles.feed(&buf[..n]) {
                        reader_title.store(t, Ordering::Relaxed);
                    }
                    // echo of what you just typed isn't Claude working
                    let t = now_ms();
                    if t.saturating_sub(reader_input.load(Ordering::Relaxed)) > ECHO_WINDOW_MS {
                        let prev = reader_last.swap(t, Ordering::Relaxed);
                        if t.saturating_sub(prev) > BURST_GAP_MS {
                            reader_burst.store(t, Ordering::Relaxed);
                        }
                    }
                }
            }
        }
        if reader_alive.load(Ordering::Relaxed) {
            out.send(
                proto::D_EXIT,
                serde_json::json!({ "id": reader_id }).to_string().as_bytes(),
            );
        }
    });

    lock(&sessions.0).insert(
        id,
        PtySession {
            master: pair.master,
            writer,
            child,
            alive,
            cwd,
            shell_pid,
            last_output,
            last_input,
            burst_start,
            claude_title,
            parser,
        },
    );
    Ok(false)
}

// ── talking to them, and ending them ─────────────────────────────────────────

fn write(sessions: &Sessions, id: &str, bytes: &[u8]) {
    let mut map = lock(&sessions.0);
    let Some(session) = map.get_mut(id) else { return };
    session.last_input.store(now_ms(), Ordering::Relaxed);
    let _ = session.writer.write_all(bytes);
}

fn resize(sessions: &Sessions, id: &str, cols: u16, rows: u16) {
    let map = lock(&sessions.0);
    let Some(session) = map.get(id) else { return };
    let _ = session.master.resize(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    });
    // the headless screen tracks the real one, or the next replay would be
    // the wrong shape
    lock(&session.parser).screen_mut().set_size(rows, cols);
}

/// Signal a shell and then collect it.
///
/// Until someone calls `wait`, the kernel keeps a dead child in the process
/// table so its exit status can still be read — a zombie — and
/// `std::process::Child` has no `Drop` that does it for you.
///
/// portable_pty's `kill` half-handles this, which is what made the leak so
/// quiet. It sends SIGHUP, then spends about 200 ms calling `try_wait`; a shell
/// that dies in that window *is* collected and leaves nothing behind. Only the
/// ones still alive at the end of the grace period get SIGKILLed — and those it
/// abandons. So an idle pane closed cleanly and a pane running an agent left a
/// zombie, which is why they accumulated slowly rather than one per close.
///
/// On its own thread because `wait` blocks and a synchronous Tauri command runs
/// on the main thread: waiting there would hang the window for as long as the
/// shell took to die. A thread that outlives its usefulness is the cheaper
/// failure of the two.
fn reap(mut child: Box<dyn Child + Send + Sync>) {
    std::thread::spawn(move || {
        let _ = child.kill();
        let _ = child.wait();
    });
}

/// End one session, by id.
///
/// Storing `alive = false` before reaping is what stops the reader thread from
/// reporting the death as a `pty-exit` — the shell did not exit, it was ended,
/// and the caller already knows. `kill_all` is where that turns out to have a
/// caller it does not hold for.
fn kill(sessions: &Sessions, id: &str) {
    if let Some(session) = lock(&sessions.0).remove(id) {
        session.alive.store(false, Ordering::Relaxed);
        reap(session.child);
    }
}

/// End everything, and say so.
///
/// The `alive = false` in `kill` deliberately suppresses the reader thread's
/// `pty-exit`, because the only caller used to be a pane closing itself —
/// which already knows. That is no longer the only caller: `C_KILL_ALL`
/// arrives from a *control* connection, `zero --kill-sessions`, and can land
/// while a window is attached and watching. Without an explicit exit per
/// session the panes sit there looking live, swallowing keystrokes, with their
/// shells already gone — the escape hatch leaving the app in a lying state.
fn kill_all(sessions: &Sessions, out: &Out) {
    let ids: Vec<String> = lock(&sessions.0).keys().cloned().collect();
    for id in ids {
        kill(sessions, &id);
        out.send(
            proto::D_EXIT,
            serde_json::json!({ "id": id }).to_string().as_bytes(),
        );
    }
}

/// Kill everything the app did *not* just claim.
///
/// This is what replaced the unconditional reap the frontend used to run on
/// boot. A session survives only if some restored layout still points at it,
/// which makes "stuck" a category that can only mean "belongs to a project I
/// have not opened lately" — never "orphaned by something the UI did".
fn reap_except(sessions: &Sessions, keep: &[String]) {
    let orphans: Vec<String> = sessions
        .0
        .lock()
        .unwrap()
        .keys()
        .filter(|id| !keep.iter().any(|k| k == *id))
        .cloned()
        .collect();
    for id in orphans {
        log(&format!("reaping {id}, no layout claims it"));
        kill(sessions, &id);
    }
}

// ── the serve loop ───────────────────────────────────────────────────────────

/// Reply to whichever request carried `req`. `error` is null on success and
/// `status` is only there for `C_STATUS`; one shape for both saves the app a
/// second reply tag to demultiplex.
fn reply(out: &Out, req: u64, error: Option<String>, status: Option<Vec<AgentStat>>) {
    let body = serde_json::json!({ "req": req, "error": error, "status": status });
    out.send(proto::D_REPLY, body.to_string().as_bytes());
}

fn num(v: &serde_json::Value, key: &str) -> u64 {
    v.get(key).and_then(|n| n.as_u64()).unwrap_or(0)
}

fn text(v: &serde_json::Value, key: &str) -> String {
    v.get(key).and_then(|s| s.as_str()).unwrap_or_default().to_string()
}

/// One client, served until it hangs up — and then the next one.
///
/// Frames are handled in order on this thread, and that ordering is a
/// guarantee the app relies on rather than an implementation detail: the boot
/// command a pane is opened with is written the moment its spawn is answered,
/// and a write that overtook its own spawn would be typed into nothing.
///
/// `C_STATUS` is the one exception, handed to a thread of its own. It runs a
/// `ps` sweep over every process on the machine, and a keystroke waiting
/// behind that is a keystroke you can feel.
fn serve(stream: UnixStream, sessions: Arc<Sessions>, out: Out, detached: Arc<Detached>) {
    let sessions = &sessions;
    let out = &out;
    // Until it says otherwise a connection is a control client: it can ask
    // and it can kill, but it does not receive output and its leaving does
    // not start the grace clock. Only the app declares itself, and it has to
    // — the alternative is a `zero --sessions` silently stealing the output
    // stream from the running window.
    let mut is_app = false;
    // Where *this* connection's replies go. Distinct from `out`, which is
    // where session output goes: a control client asking for status must be
    // answered on its own socket, not have its answer posted through the
    // window's. For the app the two become the same `Out` — deliberately the
    // same one, sharing its lock, because two `Out`s over one socket would
    // interleave a reply into the middle of an output frame.
    let mut conn = Out::new();
    let Ok(mine) = stream.try_clone() else { return };
    conn.attach(mine);
    // Some(ticket) once this connection has claimed the output slot
    let mut claimed: Option<u64> = None;
    let mut r = stream;

    loop {
        let Ok((tag, body)) = proto::read_frame(&mut r) else { break };
        let json = || serde_json::from_slice::<serde_json::Value>(&body).unwrap_or_default();
        match tag {
            proto::C_HELLO => {
                let v = json();
                if v["app"].as_bool() == Some(true) {
                    let Ok(write_half) = r.try_clone() else { break };
                    is_app = true;
                    claimed = Some(out.attach(write_half));
                    // Reply down the shared queue, not this connection's own:
                    // two writer threads on one socket would interleave their
                    // frames, and a desynced stream never recovers.
                    conn = out.clone();
                    detached.0.store(0, Ordering::Relaxed);
                }
                // Answered either way, so the app can tell a daemon that is
                // serving from one that is merely still listening.
                reply(&conn, num(&v, "req"), None, None);
            }
            proto::C_SPAWN => {
                let v = json();
                let id = text(&v, "id");
                let res = spawn_or_attach(
                    sessions,
                    out,
                    id.clone(),
                    text(&v, "cwd"),
                    num(&v, "cols") as u16,
                    num(&v, "rows") as u16,
                );
                if let Ok(true) = res {
                    log(&format!("reattached {id}"));
                }
                reply(&conn, num(&v, "req"), res.err(), None);
            }
            proto::C_WRITE => {
                if let Some((id, bytes)) = proto::decode_bytes(&body) {
                    write(sessions, &id, bytes);
                }
            }
            proto::C_RESIZE => {
                let v = json();
                resize(sessions, &text(&v, "id"), num(&v, "cols") as u16, num(&v, "rows") as u16);
            }
            proto::C_KILL => kill(sessions, &text(&json(), "id")),
            proto::C_KILL_ALL => kill_all(sessions, out),
            proto::C_REAP => {
                let v = json();
                let keep: Vec<String> = v["keep"]
                    .as_array()
                    .map(|a| a.iter().filter_map(|s| s.as_str().map(String::from)).collect())
                    .unwrap_or_default();
                reap_except(sessions, &keep);
                reply(&conn, num(&v, "req"), None, None);
            }
            proto::C_STATUS => {
                let req = num(&json(), "req");
                let (sessions, conn) = (sessions.clone(), conn.clone());
                std::thread::spawn(move || reply(&conn, req, None, Some(status(&sessions))));
            }
            _ => {}
        }
    }

    // A control client leaving is a non-event; only the app going starts the
    // clock. Where Phase 1 killed everything here, this now just stops
    // writing: the shells keep running and their screens keep being kept.
    // ...and only if the slot is still ours. A connection that was already
    // replaced by the app that restarted into it has nothing to hand back.
    if let Some(ticket) = claimed {
        if out.detach(ticket) {
            detached.0.store(now_ms(), Ordering::Relaxed);
            // the count is read and the guard dropped *before* the log call:
            // holding it across one was how the mutex got poisoned
            let held = lock(&sessions.0).len();
            log(&format!("app detached, {held} session(s) held"));
        } else {
            log("old connection closed, newer app already attached");
        }
    }
    let _ = is_app;
}

/// `zero --ptyd <socket>`. Never returns to the caller: `main` hands over here
/// long before Tauri is initialised, so there is no window, no menu and no
/// NSApplication in this process — only shells.
pub fn run(socket: &str) -> ! {
    let path = std::path::Path::new(socket);
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }

    // The socket path is stable now, which is the whole point — a relaunched
    // app has to be able to find its way back to it. That makes an existing
    // file ambiguous in a way it never was in Phase 1, so ask it: a socket
    // that accepts a connection belongs to a daemon that is already doing this
    // job, and two daemons is the one outcome worth ruling out. Only a socket
    // nobody answers is stale enough to remove.
    if UnixStream::connect(path).is_ok() {
        log(&format!("another daemon already holds {socket}"));
        std::process::exit(0);
    }
    let _ = std::fs::remove_file(path);

    let listener = match UnixListener::bind(path) {
        Ok(l) => l,
        Err(e) => {
            log(&format!("bind {socket}: {e}"));
            std::process::exit(1);
        }
    };

    let sessions = Arc::new(Sessions::default());
    let out = Out::new();
    // detached from birth, which is also what makes a daemon nobody ever
    // connects to clean itself up rather than linger
    let detached = Arc::new(Detached(AtomicU64::new(now_ms())));
    {
        let (sessions, detached) = (sessions.clone(), detached.clone());
        let path = path.to_path_buf();
        std::thread::spawn(move || reaper(sessions, detached, path));
    }

    for stream in listener.incoming().flatten() {
        // A thread each, because the app is not the only thing that connects:
        // `zero --sessions` has to be answerable *while* a window is attached,
        // which is most of the point of it. For the app itself, newest wins —
        // a second one connecting means the first is gone, or is about to be,
        // and these are its shells either way.
        let (sessions, out, detached) = (sessions.clone(), out.clone(), detached.clone());
        std::thread::spawn(move || serve(stream, sessions, out, detached));
    }
    let _ = std::fs::remove_file(path);
    std::process::exit(0)
}
#[cfg(test)]
mod tests {
    use super::*;

    fn feed(scanner: &mut TitleScanner, s: &str) -> Option<u8> {
        scanner.feed(s.as_bytes())
    }

    // ── the replay a reattaching pane is handed ──────────────────────────────

    const ROWS: u16 = 5;
    const COLS: u16 = 20;

    /// The visible screen, and the history behind it, as plain text — the two
    /// things a reattach has to reproduce.
    fn screen_and_history(parser: &mut vt100::Parser) -> (Vec<String>, Vec<String>) {
        let visible = parser.screen().rows(0, COLS).collect();
        parser.screen_mut().set_scrollback(usize::MAX);
        let held = parser.screen().scrollback();
        let mut history = Vec::new();
        for k in (1..=held).rev() {
            parser.screen_mut().set_scrollback(k);
            history.push(parser.screen().rows(0, COLS).next().unwrap());
        }
        parser.screen_mut().set_scrollback(0);
        (visible, history)
    }

    /// What the pane on the other end makes of the bytes: a terminal of the
    /// same shape, with a scrollback of its own to catch what scrolls off.
    fn reattach(bytes: &[u8]) -> vt100::Parser {
        let mut parser = vt100::Parser::new(ROWS, COLS, SCROLLBACK);
        parser.process(bytes);
        parser
    }

    #[test]
    fn reattach_carries_the_scrollback() {
        let mut source = vt100::Parser::new(ROWS, COLS, SCROLLBACK);
        for i in 1..=12 {
            source.process(format!("line {i}\r\n").as_bytes());
        }
        source.process(b"prompt$ ");

        let bytes = replay(&mut source, COLS, ROWS);
        let mut reattached = reattach(&bytes);

        assert_eq!(
            screen_and_history(&mut reattached),
            screen_and_history(&mut source)
        );
        let (visible, history) = screen_and_history(&mut reattached);
        // the boundary the newline padding exists for: the newest line that
        // scrolled off is history, not something the screen state painted over
        assert_eq!(history.last().unwrap(), "line 8");
        assert_eq!(visible[4], "prompt$ ");
    }

    #[test]
    fn history_shorter_than_the_screen_is_not_padded_with_blanks() {
        let mut source = vt100::Parser::new(ROWS, COLS, SCROLLBACK);
        for i in 1..=6 {
            source.process(format!("line {i}\r\n").as_bytes());
        }
        let bytes = replay(&mut source, COLS, ROWS);
        let (_, history) = screen_and_history(&mut reattach(&bytes));
        assert_eq!(history, vec!["line 1", "line 2"]);
    }

    #[test]
    fn colour_does_not_bleed_down_the_history() {
        let mut source = vt100::Parser::new(ROWS, COLS, SCROLLBACK);
        source.process(b"\x1b[31mred\x1b[m\r\n");
        for i in 1..=8 {
            source.process(format!("line {i}\r\n").as_bytes());
        }
        let bytes = replay(&mut source, COLS, ROWS);
        let mut reattached = reattach(&bytes);

        reattached.screen_mut().set_scrollback(usize::MAX);
        let top = reattached.screen();
        assert_eq!(top.rows(0, COLS).next().unwrap(), "red");
        assert_eq!(top.cell(0, 0).unwrap().fgcolor(), vt100::Color::Idx(1));
        assert_eq!(top.cell(1, 0).unwrap().fgcolor(), vt100::Color::Default);
    }

    #[test]
    fn an_alternate_screen_session_replays_only_its_screen() {
        let mut source = vt100::Parser::new(ROWS, COLS, SCROLLBACK);
        for i in 1..=8 {
            source.process(format!("line {i}\r\n").as_bytes());
        }
        source.process(b"\x1b[?1049hTUI");

        let bytes = replay(&mut source, COLS, ROWS);
        assert!(bytes.starts_with(b"\x1b[?1049h"));
        let (visible, history) = screen_and_history(&mut reattach(&bytes));
        assert_eq!(visible[0], "TUI");
        assert!(history.is_empty());
    }

    #[test]
    fn claude_titles_classify() {
        let mut s = TitleScanner::new();
        assert_eq!(feed(&mut s, "\x1b]0;✳ Claude Code\x07"), Some(TITLE_IDLE));
        assert_eq!(feed(&mut s, "\x1b]0;◐ Fix the bug\x07"), Some(TITLE_WORKING));
        assert_eq!(feed(&mut s, "\x1b]0;◑ Fix the bug\x07"), Some(TITLE_WORKING));
    }

    #[test]
    fn coding_agents_are_found_anywhere_below_the_shell() {
        let children = HashMap::from([
            (1, vec![(2, "zsh".to_string()), (3, "other".to_string())]),
            (2, vec![(4, "codex-aarch64-apple-darwin".to_string())]),
            (3, vec![(5, "claude".to_string())]),
        ]);
        assert_eq!(agents(&children, 1, 0), (true, true));
        assert_eq!(agents(&children, 2, 0), (false, true));
        assert_eq!(agents(&children, 99, 0), (false, false));
    }

    #[test]
    fn last_title_in_chunk_wins() {
        let mut s = TitleScanner::new();
        assert_eq!(
            feed(&mut s, "\x1b]0;◐ working\x07 …output… \x1b]0;✳ done\x07"),
            Some(TITLE_IDLE)
        );
    }

    #[test]
    fn sequence_split_across_reads() {
        let mut s = TitleScanner::new();
        assert_eq!(feed(&mut s, "\x1b]0;◐ Fix"), None);
        // the glyph itself can split mid-UTF-8 too
        let bytes = "\x1b]0;✳ hi\x07".as_bytes();
        assert_eq!(feed(&mut s, " it\x07"), Some(TITLE_WORKING));
        assert_eq!(s.feed(&bytes[..6]), None);
        assert_eq!(s.feed(&bytes[6..]), Some(TITLE_IDLE));
    }

    #[test]
    fn st_terminator_and_osc2() {
        let mut s = TitleScanner::new();
        assert_eq!(feed(&mut s, "\x1b]2;◐ via osc2\x1b\\"), Some(TITLE_WORKING));
    }

    #[test]
    fn foreign_titles_reset_to_unknown() {
        let mut s = TitleScanner::new();
        // the shell retitling after claude exits must clear claude's state
        assert_eq!(feed(&mut s, "\x1b]0;~/Projects/zero\x07"), Some(TITLE_UNKNOWN));
        // other OSC codes (hyperlinks, colors) say nothing at all
        assert_eq!(feed(&mut s, "\x1b]8;;http://x\x07"), None);
        assert_eq!(feed(&mut s, "\x1b]10;?\x07"), None);
    }

    #[test]
    fn oversize_sequence_is_abandoned() {
        let mut s = TitleScanner::new();
        let long = format!("\x1b]0;{}\x07\x1b]0;✳ ok\x07", "x".repeat(4096));
        assert_eq!(feed(&mut s, &long), Some(TITLE_IDLE));
    }

    #[test]
    fn esc_inside_osc_that_is_not_st() {
        let mut s = TitleScanner::new();
        // a mangled sequence is dropped, and the stray ESC can still open
        // a fresh one
        assert_eq!(feed(&mut s, "\x1b]0;junk\x1b]0;✳ ok\x07"), Some(TITLE_IDLE));
    }
}
