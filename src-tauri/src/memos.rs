//! Voice memos — talk through a thought, get it back tidy.
//!
//! One memo is four files in `<project>/.zero/memos/` and a status that walks
//! through them:
//!
//! ```text
//! record ──▶ recorded ──▶ transcribing ──▶ transcribed ──▶ cleaning ──▶ ready
//!  (mic)      (m4a)       (zero-voice)      (raw.txt)      (claude -p)   (md)
//! ```
//!
//! Every arrow is retryable from its checkpoint, and no arrow destroys the
//! artifact behind it — a cleanup that fails still leaves you a transcript to
//! copy, which is why cleanup is allowed to be the flakiest part.
//!
//! The first arrow is the only one somebody is standing inside while it
//! happens, so it is the only one with transport controls. A recording can be
//! held and picked back up, which costs its duration nothing because the length
//! is counted in frames and a paused mic writes none; or cancelled, which is
//! the one operation in this file that destroys an artifact, and is allowed to
//! because the artifact is a recording somebody is asking to be rid of.
//!
//! A memo that came back can be talked over again. Pressing ＋ on a finished
//! row records a *take*: the same three arrows, ending in a merge rather than a
//! cleanup, so the `.md` becomes the document as it now stands with the
//! follow-up folded into it. Takes are numbered from 2 and carry the number in
//! their filenames — the base recording is take 1 and wears the plain stem,
//! which is what keeps a memo nobody iterated on identical to one from before
//! any of this existed. Nothing a take does can cost you the previous outcome:
//! its files sit beside the memo's rather than over them, and the merged
//! document is written through a temp file and a rename.
//!
//! Two kinds of thread do the work, both of them ours rather than Tauri's. A
//! recording gets a reader thread per invocation that turns the helper's NDJSON
//! into `app.emit` (the `pty.rs` pattern). Transcription and cleanup share a
//! single global FIFO worker, because memos arrive at dictation pace and
//! running one job at a time deletes every question about how many `claude`
//! processes or speech models can be alive at once.
//!
//! The commands are all `async` for the reason spelled out at the top of
//! `git.rs`: a synchronous Tauri command runs on the main thread, and every
//! one of these touches the filesystem or spawns something. The bodies stay
//! blocking; it's the thread they block that matters.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager};

// ── the statuses, spelled once ───────────────────────────────────────────────

const RECORDING: &str = "recording";
const RECORDED: &str = "recorded";
const TRANSCRIBING: &str = "transcribing";
const TRANSCRIBED: &str = "transcribed";
const CLEANING: &str = "cleaning";
const READY: &str = "ready";
const TRANSCRIBE_FAILED: &str = "transcribe_failed";
const CLEANUP_FAILED: &str = "cleanup_failed";

/// What a memo is called when there was nothing to hear. Set instead of
/// spending an LLM call on silence.
const NO_SPEECH: &str = "(no speech detected)";

/// Shorter than this, in characters, and there is nothing to clean up.
const MIN_TRANSCRIPT: usize = 10;

const HELPER_MISSING: &str = "helper not built — run scripts/build-helper.sh";
const NEEDS_MACOS_26: &str =
    "memos needs macOS 26 — it uses the system's on-device speech transcription.";

/// A 15-minute memo transcribes in tens of seconds; ten minutes means
/// something is wedged.
const TRANSCRIBE_TIMEOUT: Duration = Duration::from_secs(600);
/// Four minutes of `claude -p`. A cleanup that hasn't answered by then won't.
const CLEANUP_TIMEOUT: Duration = Duration::from_secs(240);
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);

/// How long `memo_record_start` waits for the helper to say capture is live
/// before answering anyway. Long enough that a helper which can't start at all
/// (no microphone, wrong OS) fails the command instead of leaving a row that
/// records nothing; short enough that a slow permission prompt doesn't hold
/// the button down.
const START_GRACE: Duration = Duration::from_millis(800);

/// Level events arrive at ≤8 Hz already; this only stops a chatty helper from
/// flooding the webview.
const LEVEL_INTERVAL: Duration = Duration::from_millis(80);

const POLL_INTERVAL: Duration = Duration::from_millis(60);
/// After a child exits its pipe still has bytes in it; the reader thread hangs
/// up once it hits EOF, which is what actually ends the drain.
const DRAIN_GRACE: Duration = Duration::from_millis(250);

// ── what crosses the wire ────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
pub struct MemoProbe {
    pub supported: bool,
    pub message: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct Memo {
    id: String,
    title: Option<String>,
    created: String,
    duration_s: f64,
    status: String,
    audio: Option<String>,
    /// waiting in the FIFO. In-memory only — there is nothing to persist about
    /// a queue that dies with the process.
    queued: bool,
    /// the mic is open on this memo and holding still. In-memory only for the
    /// same reason `queued` is: a pause cannot outlive the process holding the
    /// recording open, and a relaunch finds either audio or nothing.
    paused: bool,
    /// how many follow-ups have been recorded on top of this memo. A count is
    /// all the panel needs: it names the newest take's files, and it is what
    /// says `merging…` instead of `cleaning…`.
    takes: usize,
    /// While `recording`, the moment *this* recording started — the memo's own
    /// `created` for a first one, the take's for a follow-up. The panel runs
    /// its elapsed timer off this, and off nothing else: a take's row would
    /// otherwise count up from the memo's age.
    recording_since: Option<String>,
    /// the human half of the on-disk error; the stage and code stay behind,
    /// for the log and for a future that wants to tell failures apart —
    /// except the one code the panel can act on, which crosses as the flag
    /// below.
    error: Option<String>,
    /// the error is claude saying it has no usable login — the one failure a
    /// button can fix, by opening a terminal on `claude /login`
    needs_login: bool,
}

#[derive(Serialize, Clone)]
struct UpdateEvent {
    root: String,
    memo: Memo,
}

#[derive(Serialize, Clone)]
struct LevelEvent {
    root: String,
    rms: f64,
}

#[derive(Serialize, Clone)]
struct NoticeEvent {
    root: String,
    message: String,
}

// ── what lives on disk ───────────────────────────────────────────────────────

/// `<stem>.json`. Richer than [`Memo`]: the frontend never needs to know how
/// many times a stage has been tried, but the auto-advance guard does, and it
/// has to survive a relaunch to mean anything.
#[derive(Serialize, Deserialize, Clone, PartialEq)]
struct MemoFile {
    id: String,
    #[serde(default)]
    title: Option<String>,
    created: String,
    #[serde(default)]
    duration_s: f64,
    status: String,
    #[serde(default)]
    audio: Option<String>,
    /// the app died with the mic open; the audio is whatever had landed
    #[serde(default)]
    interrupted: bool,
    /// the follow-ups recorded on top of this memo, oldest first. Skipped when
    /// empty, so a memo nobody iterated on carries no field about iteration —
    /// the json stays the shape it was, and a plain memo says nothing
    /// speculative about itself.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    takes: Vec<Take>,
    #[serde(default)]
    attempts: Attempts,
    #[serde(default)]
    error: Option<MemoError>,
}

/// One follow-up recording. Its own audio and its own transcript, both named
/// after the memo they belong to; the document they end up in is the memo's.
///
/// Appended the moment the take starts rather than when it finishes, because
/// the frontend needs `created` while the recording is still running — it is
/// what the timer counts from. `duration_s` is 0.0 until the helper says
/// otherwise, which is the same 0.0 a memo wears for the length of its own
/// first recording.
#[derive(Serialize, Deserialize, Clone, PartialEq)]
struct Take {
    audio: String,
    raw: String,
    created: String,
    #[serde(default)]
    duration_s: f64,
}

#[derive(Serialize, Deserialize, Clone, Default, PartialEq)]
struct Attempts {
    transcribe: u32,
    cleanup: u32,
}

#[derive(Serialize, Deserialize, Clone, PartialEq)]
struct MemoError {
    stage: String,
    /// the helper's own code where there is one (`mic_denied`, `asset_missing`,
    /// …); nothing reads it yet, but a message is for a person and a code is
    /// for the next version of this file
    code: String,
    message: String,
}

/// What the manager knows about a memo that its json cannot: whether it is
/// waiting in the FIFO, and — while it is *the* recording — where the panel's
/// elapsed timer counts from and whether that timer is running at all.
///
/// Both halves are the same kind of fact, so they are fetched under one lock
/// and travel together: neither survives the process, and neither is ever
/// written down.
#[derive(Default, Clone, Copy)]
struct Live {
    queued: bool,
    /// unix seconds, and only for the one recording there is. `None` falls the
    /// timer back to what the files say, which is what every memo nobody is
    /// recording has always been drawn from.
    since: Option<i64>,
    paused: bool,
}

fn wire(memo: &MemoFile, live: Live) -> Memo {
    Memo {
        id: memo.id.clone(),
        title: memo.title.clone(),
        created: memo.created.clone(),
        duration_s: memo.duration_s,
        status: memo.status.clone(),
        audio: memo.audio.clone(),
        queued: live.queued,
        paused: live.paused,
        takes: memo.takes.len(),
        // The manager's answer first: a recording that has been paused counts
        // from `now` minus the audio it actually captured, so that the panel's
        // `now - recording_since` stays the length of the recording rather than
        // the length of the sitting. Where there is no manager to ask — a list
        // of finished memos, a reconstruction — the live recording is the last
        // take when there is one, and the memo itself when there isn't.
        recording_since: (memo.status == RECORDING).then(|| match live.since {
            Some(secs) => iso(secs),
            None => match memo.takes.last() {
                Some(take) => take.created.clone(),
                None => memo.created.clone(),
            },
        }),
        error: memo.error.as_ref().map(|e| e.message.clone()),
        needs_login: memo.error.as_ref().is_some_and(|e| e.code == NEEDS_LOGIN),
    }
}

// ── manager state ────────────────────────────────────────────────────────────

/// The mic is one resource and the queue is one queue, so all of this is
/// global on purpose. It lives behind an `Arc` rather than in the `Mutex`
/// Tauri hands out, because the worker thread outlives every command that
/// talks to it.
#[derive(Default)]
pub struct MemoManager(Arc<Shared>);

#[derive(Default)]
struct Shared {
    state: Mutex<State>,
    /// the worker sleeps on this rather than polling an empty queue
    wake: Condvar,
}

#[derive(Default)]
struct State {
    recording: Option<Recording>,
    queue: VecDeque<Job>,
    running: Option<RunningJob>,
    /// the FIFO worker is started by the first job and then never stops
    worker_started: bool,
}

struct Recording {
    root: String,
    id: String,
    /// `stop\n` goes here. Taken on stop so the pipe closes too: the helper
    /// treats EOF and the word identically, and one of them always arrives.
    /// The transport verbs go through it as well and leave it exactly where it
    /// is — a recording that was only paused still has to be able to hear what
    /// happens next.
    stdin: Option<ChildStdin>,
    child: Arc<ChildSlot>,
    /// the mic is open and holding still
    paused: bool,
    /// unix seconds the elapsed timer counts from: when the press happened,
    /// moved forward on every resume by however long the pause lasted
    since: i64,
    /// seconds of audio banked before the current pause. Only meaningful while
    /// `paused` — a resume folds it straight back into `since`.
    recorded: i64,
}

/// The pause clock, which exists because the panel is told a moment and
/// subtracts it from `now`. Nothing else about a paused recording changes: the
/// helper holds the same file open, the memo on disk still says `recording`,
/// and the duration that eventually lands is counted from frames the mic was
/// not producing. So the only thing that could lie is that one moment, and this
/// is where it is kept honest.
impl Recording {
    /// Bank what has been recorded so far and stop the clock. Idempotent for
    /// the same reason the helper's verb is: a second `paused` must not bank
    /// the same seconds twice.
    fn pause(&mut self, now: i64) {
        if self.paused {
            return;
        }
        // a clock that went backwards under us is worth a zero, not a negative
        // length
        self.recorded = (now - self.since).max(0);
        self.paused = true;
    }

    /// Start it again where it stopped — by moving the origin forward rather
    /// than by carrying an offset around, so that everything downstream can go
    /// on subtracting two numbers and never learns there was a pause.
    fn resume(&mut self, now: i64) {
        if !self.paused {
            return;
        }
        self.since = now - self.recorded;
        self.paused = false;
    }

    /// The moment the timer counts from. Recomputed against `now` while paused,
    /// so that a panel listing mid-pause is told the length the recording has
    /// stopped at rather than one still climbing.
    fn timer_since(&self, now: i64) -> i64 {
        if self.paused {
            now - self.recorded
        } else {
            self.since
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Stage {
    Transcribe,
    Cleanup,
}

#[derive(Clone)]
struct Job {
    root: String,
    id: String,
    stage: Stage,
}

struct RunningJob {
    root: String,
    id: String,
    stage: Stage,
    child: Arc<ChildSlot>,
    /// set when the memo is deleted mid-job: the worker then writes nothing,
    /// so a delete can't be undone by the job it interrupted
    cancelled: Arc<AtomicBool>,
}

/// Where a running child is parked so another thread can kill it. The lock is
/// only ever held for a `try_wait` or a `kill`, never for a blocking `wait`.
type ChildSlot = Mutex<Option<Child>>;

// ── paths and other small change ─────────────────────────────────────────────

fn memos_dir(root: &str) -> PathBuf {
    Path::new(root).join(".zero").join("memos")
}

fn project_name(root: &str) -> String {
    Path::new(root)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| root.to_string())
}

/// launchd hands GUI apps a minimal PATH and neither `git` nor `claude` is on
/// it. Same repair, and the same reason, as `git_base` in `git.rs` — plus the
/// two homes claude's own installers use, which no brew or system dir covers:
/// `~/.local/bin` is the native installer (and where npm installs have been
/// migrating themselves), `~/.claude/local` the per-user install it replaced.
fn repaired_path() -> String {
    let path = std::env::var("PATH").unwrap_or_default();
    let repaired = format!("/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:{path}");
    match std::env::var("HOME") {
        Ok(home) => format!("{home}/.local/bin:{home}/.claude/local:{repaired}"),
        Err(_) => repaired,
    }
}

/// The error code for a cleanup that failed because `claude` has no usable
/// login — the one failure the panel offers to fix rather than just retry.
const NEEDS_LOGIN: &str = "needs_login";

/// Whether a failure is claude asking for a login, in every phrasing it has
/// used: the OAuth pair when a session expires or a refresh is refused, and
/// the /login hint when there are no credentials at all.
fn login_needed(text: &str) -> bool {
    let t = text.to_ascii_lowercase();
    ["authenticate", "oauth", "/login", "api key"].iter().any(|needle| t.contains(needle))
}

/// The first few lines of a failure, which is where a CLI puts the reason.
/// Flattened to one line because that's the shape the panel shows it in.
fn first_lines(text: &str, n: usize) -> String {
    let joined = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .take(n)
        .collect::<Vec<_>>()
        .join(" ");
    joined.chars().take(300).collect()
}

/// The title is the md's `# ` line — which is also the first line of the file
/// the user opens, so it stays in the document rather than being lifted out.
fn title_from_md(text: &str) -> Option<String> {
    text.lines()
        .find(|l| !l.trim().is_empty())
        .map(|l| l.trim().trim_start_matches('#').trim())
        .filter(|t| !t.is_empty())
        .map(|t| t.chars().take(80).collect())
}

// ── time ─────────────────────────────────────────────────────────────────────

/// Seconds east of UTC as the system currently has it.
///
/// A memo recorded at 14:32 must not be filed as 12:32, and std has no
/// timezone database at all — so the one authority within reach is `date`.
/// Asked once per launch: a session that straddles a daylight-saving change
/// misnames one memo by an hour, which costs nothing, because the stem is a
/// key rather than a claim.
fn local_offset() -> i64 {
    static OFFSET: OnceLock<i64> = OnceLock::new();
    *OFFSET.get_or_init(|| {
        let Ok(out) = Command::new("/bin/date").arg("+%z").output() else {
            return 0;
        };
        parse_offset(String::from_utf8_lossy(&out.stdout).trim())
    })
}

/// `+0200` → 7200. Anything else is UTC, which is wrong by hours at worst.
fn parse_offset(text: &str) -> i64 {
    let sign = match text.chars().next() {
        Some('+') => 1,
        Some('-') => -1,
        _ => return 0,
    };
    let digits = &text[1..];
    if digits.len() != 4 || !digits.chars().all(|c| c.is_ascii_digit()) {
        return 0;
    }
    let hours: i64 = digits[..2].parse().unwrap_or(0);
    let minutes: i64 = digits[2..].parse().unwrap_or(0);
    sign * (hours * 3600 + minutes * 60)
}

/// Civil time from a unix timestamp: Howard Hinnant's `civil_from_days`, the
/// algorithm every date library is built on, because pulling in a date library
/// for two format strings isn't a trade worth making.
fn civil(secs: i64) -> (i64, i64, i64, i64, i64, i64) {
    let days = secs.div_euclid(86_400);
    let rest = secs.rem_euclid(86_400);
    let (hour, minute, second) = (rest / 3600, (rest % 3600) / 60, rest % 60);

    // shift the epoch to 0000-03-01, which puts the leap day last and makes
    // the whole thing arithmetic
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day, hour, minute, second)
}

/// `2026-08-13T14:32:11Z` — the `created` field, always UTC.
fn iso(secs: i64) -> String {
    let (y, mo, d, h, mi, s) = civil(secs);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

/// `2026-08-13-1432` — the front of a stem, always local, because the filename
/// is the one part of this a person reads with their own clock in mind.
fn stamp(secs: i64) -> String {
    let (y, mo, d, h, mi, _) = civil(secs);
    format!("{y:04}-{mo:02}-{d:02}-{h:02}{mi:02}")
}

fn epoch_secs(t: SystemTime) -> i64 {
    t.duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn now_secs() -> i64 {
    epoch_secs(SystemTime::now())
}

/// Four hex characters of nothing in particular. Two memos started in the same
/// minute need different names; that's the whole requirement, and a hash of
/// the clock, the pid and a counter meets it without a dependency. The counter
/// is what actually separates two calls in the same clock tick — an `elapsed()`
/// of a fresh `Instant` used to stand here, and it hashed the same ~0 every
/// time.
fn hex4() -> String {
    use std::hash::{Hash, Hasher};
    static COUNTER: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    SystemTime::now().hash(&mut hasher);
    std::process::id().hash(&mut hasher);
    COUNTER.fetch_add(1, Ordering::Relaxed).hash(&mut hasher);
    format!("{:04x}", hasher.finish() & 0xffff)
}

/// Ids come back out of `memo_list`, but they arrive over IPC and go straight
/// into filenames, so they're checked rather than trusted — a stem is digits,
/// dashes and hex, none of which can walk out of the memos directory.
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 40 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// Is this a stem [`new_stem`] could have minted — `YYYY-MM-DD-HHMM-hhhh`?
///
/// The reconciler asks before it sweeps. A `notes.md` someone dropped into the
/// memos directory classifies as a memo with no audio, which is the shape of a
/// stub — and a stub gets erased. Files are only ever swept under names this
/// program invented; anything else in the directory is somebody's and stays.
fn stem_is_ours(stem: &str) -> bool {
    let b = stem.as_bytes();
    b.len() == 20
        && b.iter().enumerate().all(|(i, c)| match i {
            4 | 7 | 10 | 15 => *c == b'-',
            16.. => c.is_ascii_hexdigit(),
            _ => c.is_ascii_digit(),
        })
}

/// A stem no file in `dir` is using yet. The caf is a recording's first file
/// and the m4a an import's only one, so those two and the json are the names
/// that can already be claiming a stem.
fn new_stem(dir: &Path) -> String {
    let front = stamp(now_secs() + local_offset());
    for _ in 0..64 {
        let stem = format!("{front}-{}", hex4());
        if ["json", "caf", "m4a"].iter().all(|ext| !dir.join(format!("{stem}.{ext}")).exists()) {
            return stem;
        }
    }
    format!("{front}-{}", hex4())
}

// ── memo.json ────────────────────────────────────────────────────────────────

/// Written alongside and renamed over. A rename is atomic, so a crash mid-save
/// leaves the previous file rather than half of the new one — the `cli.rs`
/// precedent, and the reason a `.md` can never be truncated by a failed retry.
fn write_atomic(path: &Path, body: &str) -> Result<(), String> {
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let tmp = path.with_file_name(format!(".{name}.tmp"));
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

fn json_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.json"))
}

/// `None` for both "no such memo" and "the json is unreadable" — the caller
/// treats them the same, rebuilding from whichever files are actually there.
fn load_memo(dir: &Path, id: &str) -> Option<MemoFile> {
    let text = std::fs::read_to_string(json_path(dir, id)).ok()?;
    serde_json::from_str(&text).ok()
}

fn save_memo(dir: &Path, memo: &MemoFile) -> Result<(), String> {
    let body = serde_json::to_string_pretty(memo).map_err(|e| e.to_string())?;
    write_atomic(&json_path(dir, &memo.id), &body)
}

// ── takes ────────────────────────────────────────────────────────────────────

/// Take numbers start at 2: the base recording is take 1 and wears the plain
/// stem. So the take at index `i` of the list is take `i + 2`.
fn take_no(index: usize) -> usize {
    index + 2
}

/// The number of the take a memo is currently on, if it is on one.
fn last_take_no(memo: &MemoFile) -> Option<usize> {
    (!memo.takes.is_empty()).then(|| take_no(memo.takes.len() - 1))
}

/// The stem a take's own files share — `<id>.<n>`, which is the memo's stem
/// with the take number on the end. Everything else about a take's filenames
/// follows from that: `.caf`, `.m4a`, `.raw.txt`, exactly as for take 1.
fn take_stem(id: &str, n: usize) -> String {
    format!("{id}.{n}")
}

fn take_raw_name(id: &str, n: usize) -> String {
    format!("{}.raw.txt", take_stem(id, n))
}

/// `2026-08-13-1432-ab12.3` → `("2026-08-13-1432-ab12", 3)`, and `None` for a
/// plain stem. A memo id is digits, dashes and hex — never a dot — so a dot in
/// a stem can only be a take number.
fn split_take(stem: &str) -> Option<(&str, usize)> {
    let (base, number) = stem.rsplit_once('.')?;
    let n: usize = number.parse().ok()?;
    (n >= 2 && !base.is_empty()).then_some((base, n))
}

// ── the document, take by take ───────────────────────────────────────────────

/// `<id>.<n>.md` — the document as take n left it.
///
/// The `.md` is the memo, and a merge replaces it; these are what it said at
/// every step on the way, so that a memo can be read as the exchange it was
/// rather than as its last answer. Written after every successful pass and never
/// read again by this file: nothing in the pipeline consults a version, and
/// nothing about a memo is decided by one.
///
/// Numbered by take rather than by pass, so the base cleanup writes `<id>.1.md`.
/// Take 1's *recording* wears the plain stem everywhere else — but its document
/// can't, because `<id>.md` is already the current one.
fn version_name(id: &str, n: usize) -> String {
    format!("{id}.{n}.md")
}

/// `2026-08-13-1432-ab12.1` → `("2026-08-13-1432-ab12", 1)`. [`split_take`] with
/// its floor one lower, for the reason spelled out above.
fn split_version(stem: &str) -> Option<(&str, usize)> {
    let (base, number) = stem.rsplit_once('.')?;
    let n: usize = number.parse().ok()?;
    (n >= 1 && !base.is_empty()).then_some((base, n))
}

/// Copy the document that was just written to the version its take wears.
///
/// A copy of the file rather than a second write of the same text: the thing
/// that must never be half-written is the document, and the rename that
/// protected it has already happened. A version is a display artifact — a memo
/// whose snapshot never landed shows one turn fewer and is otherwise itself — so
/// a failure here is logged and nothing more, exactly like a json that wouldn't
/// write.
fn snapshot(dir: &Path, id: &str, n: usize) {
    let current = dir.join(format!("{id}.md"));
    if let Err(e) = std::fs::copy(current, dir.join(version_name(id, n))) {
        println!("[memos] could not keep {id} take {n}'s document: {e}");
    }
}

/// The stem and kind of a file in the memos directory, or `None` for a name
/// that is none of ours. One place, because [`scan`] and [`remove_all`] have to
/// agree about what belongs to a memo down to the last take.
///
/// The stem is the file's own — `x.2` for `x.2.raw.txt` — with one exception. A
/// numbered `.md` is a *version*, the document as one take left it, and it comes
/// back under the plain stem of the memo it is a version of. That is what keeps
/// it out of the way of everything that reads a number as a recording: a
/// snapshot is drawn from a memo's files, and a memo with a snapshot for take 4
/// has not thereby recorded four takes. The record of the call behind a take,
/// `x.4.claude.sh`, is numbered the same way and comes back the same way, for
/// the same reason.
fn classify(name: &str) -> Option<(&str, &'static str)> {
    if let Some(stem) = name.strip_suffix(".raw.txt") {
        Some((stem, "raw"))
    } else if let Some(stem) = name.strip_suffix(".json") {
        Some((stem, "json"))
    } else if let Some(stem) = name.strip_suffix(".claude.sh") {
        // an unnumbered one is nobody's — there is no call behind a memo as a
        // whole, only behind each of its takes
        split_version(stem).map(|(base, _)| (base, "invocation"))
    } else if let Some(stem) = name.strip_suffix(".md") {
        match split_version(stem) {
            Some((base, _)) => Some((base, "version")),
            None => Some((stem, "md")),
        }
    } else if let Some(stem) = name.strip_suffix(".m4a").or_else(|| name.strip_suffix(".caf")) {
        Some((stem, "audio"))
    } else {
        None
    }
}

/// Which memo a file in the memos directory belongs to, or `None` for a name
/// that is none of ours.
///
/// The numbered files — a take's recording, a take's transcript, the document a
/// take left behind — all answer with the memo's own stem, because a memo is the
/// only thing a sweep can be asked about.
fn owning_memo(name: &str) -> Option<&str> {
    let (stem, kind) = classify(name)?;
    // a version, and the call that left it, already came back under the memo's
    // stem; everything else wears its own, which for a take is the numbered one
    Some(match kind {
        "version" | "invocation" => stem,
        _ => split_take(stem).map_or(stem, |(base, _)| base),
    })
}

/// Every file a memo can own, takes and versions included. Used by delete, and
/// by the reconciler when it finds a stub that never became a recording.
///
/// The numbered ones are found by reading the directory rather than by counting
/// from a json, because this also runs when there is no readable json left: a
/// delete that missed them would leave recordings of yours on disk under a name
/// nothing lists any more.
fn remove_all(dir: &Path, id: &str) {
    // `m4a.part` is the conversion's scratch name; a crash mid-encode is the
    // only way one outlives the helper, and this is where such dust goes
    for ext in ["json", "caf", "m4a", "m4a.part", "raw.txt", "md"] {
        let _ = std::fs::remove_file(dir.join(format!("{id}.{ext}")));
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.filter_map(|e| e.ok()) {
        let name = entry.file_name().to_string_lossy().to_string();
        if owning_memo(&name) == Some(id) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// One take's files, and nothing else.
fn remove_take_files(dir: &Path, id: &str, n: usize) {
    for ext in ["caf", "m4a", "m4a.part", "raw.txt"] {
        let _ = std::fs::remove_file(dir.join(format!("{}.{ext}", take_stem(id, n))));
    }
    // and the document that take left, on the one path where there could be
    // one. A take that reached a merge is never dropped, so this is nearly
    // always a name that isn't there — but a take number does come back after a
    // drop, and the number that comes back must not inherit a document, nor
    // the record of the call that made it.
    let _ = std::fs::remove_file(dir.join(version_name(id, n)));
    let _ = std::fs::remove_file(dir.join(invocation_name(id, n)));
}

/// Take the last take back out — its entry and its files.
///
/// The memo behind it is left exactly as it was: the same document, the same
/// title, the same base recording. That is the promise the whole feature rests
/// on, so every path that abandons a take comes through here rather than
/// improvising its own retreat.
fn drop_take(dir: &Path, memo: &mut MemoFile) {
    let Some(n) = last_take_no(memo) else { return };
    memo.takes.pop();
    remove_take_files(dir, &memo.id, n);
}

/// Everything the manager knows about one memo, under one lock, because
/// [`wire`] wants all of it at once and none of it is worth two.
fn live_of(shared: &Shared, root: &str, id: &str) -> Live {
    let st = shared.state.lock().unwrap();
    let recording = st.recording.as_ref().filter(|r| r.root == root && r.id == id);
    Live {
        queued: st.queue.iter().any(|j| j.root == root && j.id == id),
        since: recording.map(|r| r.timer_since(now_secs())),
        paused: recording.is_some_and(|r| r.paused),
    }
}

/// Persist a memo and tell the window about it. Every status change in this
/// file goes through here, so nothing can change on disk without the panel
/// hearing it.
fn publish(app: &tauri::AppHandle, shared: &Shared, root: &str, dir: &Path, memo: &MemoFile) {
    if let Err(e) = save_memo(dir, memo) {
        println!("[memos] could not write {}.json: {e}", memo.id);
    }
    let live = live_of(shared, root, &memo.id);
    let _ = app.emit(
        "memo-update",
        UpdateEvent { root: root.to_string(), memo: wire(memo, live) },
    );
}

fn notice(app: &tauri::AppHandle, root: &str, message: &str) {
    let _ = app.emit(
        "memo-notice",
        NoticeEvent { root: root.to_string(), message: message.to_string() },
    );
}

// ── ZERO.md ──────────────────────────────────────────────────────────────────

/// `<project>/ZERO.md` — one setup file per project, at its root, the way a
/// CLAUDE.md is one per project. It holds exactly one thing so far, this
/// project's transcription vocabulary; the reason it isn't called
/// `vocabulary.md` is that the next thing zero needs told about a project
/// belongs in the same file rather than in a second one nobody knows about.
fn zero_md_path(root: &str) -> PathBuf {
    Path::new(root).join("ZERO.md")
}

/// Where the vocabulary lived for the hours before ZERO.md existed.
fn legacy_vocabulary_path(root: &str) -> PathBuf {
    Path::new(root).join(".zero").join("vocabulary.md")
}

/// The vocabulary's path, moving the file up out of `.zero/` if it's still
/// down there.
///
/// Every reader and writer goes through here, so the move happens on whichever
/// of them touches the project first and nothing else has to know there was
/// ever another location. Silent, because this is zero's own file being
/// carried by zero from one of its own paths to another. A rename that can't
/// happen — a read-only checkout — hands back the old path instead, so the
/// worst case is a vocabulary that goes on working from where it already is.
fn vocabulary_path(root: &str) -> PathBuf {
    let path = zero_md_path(root);
    let legacy = legacy_vocabulary_path(root);
    if path.exists() || !legacy.exists() {
        return path;
    }
    match std::fs::rename(&legacy, &path) {
        Ok(()) => path,
        Err(_) => legacy,
    }
}

/// What a fresh ZERO.md says.
///
/// The project's own name and nothing else: a wrong auto-seed is creepier than
/// an empty file, and the name is the one term we can be certain about.
/// Everything above that floor arrives afterwards — from the README once
/// [`derive_seed`] gets back, and from cleanup as it meets words it had to fix.
fn vocabulary_seed(project: &str) -> String {
    format!(
        "<!-- ZERO.md — zero's setup file for this project, one per repository,\n\
         \x20    the way a CLAUDE.md is. It holds one thing so far: the vocabulary\n\
         \x20    this project's voice memos are transcribed and cleaned up against.\n\
         \x20    One term per line: \"- Term — notes about how transcription mangles it\".\n\
         \x20    The term is fed to speech recognition; the whole line guides cleanup.\n\
         \x20    Meant to be committed, so the project's words travel with the repo. -->\n\
         - {project} — this project's name; restore it exactly as written here if the transcription mangles it.\n"
    )
}

struct Vocabulary {
    /// the whole file, verbatim, for the cleanup prompt — the model needs no
    /// parser, and every note the user wrote is a hint worth passing on
    body: String,
    /// just the terms, for speech recognition's contextual strings
    terms: Vec<String>,
    locale: String,
}

/// Longer than this isn't a proper noun, and the contextual-strings API is
/// happier for the ceiling.
const MAX_TERM: usize = 64;
const MAX_TERMS: usize = 200;
const DEFAULT_LOCALE: &str = "en-US";

/// The term one glossary line names, or `None` for a line that isn't one.
///
/// The single rule for what an entry is, so the hand-edited file, the README
/// seed and cleanup's suggestions are all held to the same one.
fn entry_term(line: &str) -> Option<&str> {
    let rest = line.strip_prefix('-')?;
    if !rest.starts_with(char::is_whitespace) {
        return None;
    }
    let entry = rest.trim();
    // the term is what comes before the note; an em dash is what the seed
    // teaches, a hyphen is what people type instead
    let cut = [" — ", " - "]
        .iter()
        .filter_map(|sep| entry.find(sep))
        .min()
        .unwrap_or(entry.len());
    let term = entry[..cut].trim();
    (!term.is_empty() && term.chars().count() <= MAX_TERM).then_some(term)
}

/// Loose glossary lines that cannot break the pipeline: a line that isn't an
/// entry simply isn't a term, and a file that's all prose still reaches the
/// cleanup prompt intact.
fn parse_vocabulary(body: &str) -> Vocabulary {
    let mut terms: Vec<String> = Vec::new();
    let mut locale = DEFAULT_LOCALE.to_string();

    for line in body.lines() {
        if let Some(value) = line.trim().strip_prefix("locale:") {
            let value = value.trim();
            let plausible = value.len() >= 2
                && value.len() <= 16
                && value.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
            if plausible {
                locale = value.to_string();
            }
            continue;
        }
        let Some(term) = entry_term(line) else { continue };
        if !terms.iter().any(|t| t == term) {
            terms.push(term.to_string());
        }
    }
    terms.truncate(MAX_TERMS);
    Vocabulary { body: body.to_string(), terms, locale }
}

/// Read fresh at every use — the file is edited in zero's own editor, and
/// nothing watches it.
fn read_vocabulary(root: &str) -> Vocabulary {
    parse_vocabulary(&std::fs::read_to_string(vocabulary_path(root)).unwrap_or_default())
}

/// Suggestions per memo. Cleanup is a suggestion box, not a bulk importer: a
/// file that grows faster than it's read is a file nobody prunes.
const MAX_SUGGESTIONS: usize = 5;

/// The glossary lines out of whatever an LLM said, capped. Anything that isn't
/// an entry — a preamble, a code fence, an apology for having none — simply
/// isn't a line, which is the same forgiveness [`parse_vocabulary`] gives the
/// file a person edits by hand.
fn glossary_lines(text: &str, cap: usize) -> Vec<String> {
    text.lines()
        .map(str::trim)
        .filter(|line| entry_term(line).is_some())
        .take(cap)
        .map(str::to_string)
        .collect()
}

/// Append glossary lines to ZERO.md, skipping every term it already has.
/// Returns how many lines actually landed.
///
/// Read-modify-write through [`write_atomic`] rather than an append handle:
/// the file is small, this happens at most once per memo, and it is open in an
/// editor as often as not. The comparison is case-insensitive and on the term
/// alone, so a line only lands when the word itself is new — a second opinion
/// about how an existing term gets misheard is not a new term. A file that has
/// been deleted stops the whole thing: deleting it is a decision, and writing
/// a headerless one back is not ours to make.
fn append_terms(path: &Path, lines: &[String]) -> usize {
    // Two writers can genuinely meet here — the README seed on its detached
    // thread and a harvest on the worker, in a project's first minute — and
    // read-modify-write under both means the slower one unwrites the faster
    // one's lines. One lock for every append; the file is small and so is the
    // wait.
    static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());
    let _guard = ONE_AT_A_TIME.lock().unwrap();
    let Ok(mut body) = std::fs::read_to_string(path) else { return 0 };
    let mut known: HashSet<String> =
        body.lines().filter_map(entry_term).map(str::to_lowercase).collect();

    let mut added = 0;
    for line in lines {
        let Some(term) = entry_term(line) else { continue };
        if !known.insert(term.to_lowercase()) {
            continue;
        }
        if !body.is_empty() && !body.ends_with('\n') {
            body.push('\n');
        }
        body.push_str(line);
        body.push('\n');
        added += 1;
    }
    if added == 0 || write_atomic(path, &body).is_err() {
        return 0;
    }
    added
}

/// Projects whose ZERO.md this process has just created and is deriving a seed
/// for. Pressing record and clicking the ZERO.md link a second apart must not
/// send the same README twice.
fn seeding() -> &'static Mutex<HashSet<String>> {
    static SEEDING: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    SEEDING.get_or_init(Mutex::default)
}

/// Make sure the project has a ZERO.md, and hand back its path.
///
/// Creating it writes the header and the project's name at once — that is the
/// file, complete and usable, before this returns. Only then, and only when
/// there's a README to read, does one detached thread go and ask what else
/// belongs in it. Both creation sites come through here: pressing record,
/// where the derivation runs alongside the recording and is finished before
/// the transcription that wants it, and the panel's ZERO.md link.
///
/// This never creates `.zero/` and never touches `.gitignore`. ZERO.md is a
/// file for the repository; the ignore line belongs to the directory that
/// holds the private things.
fn ensure_zero_md(app: &tauri::AppHandle, root: &str) -> Result<PathBuf, String> {
    // one lock around look-then-create: two presses in the same second must
    // not both find the file missing, and the slower of them must not write
    // the bare seed back over what the faster one's derivation appended
    let mut claimed = seeding().lock().unwrap();
    let path = vocabulary_path(root);
    if path.exists() {
        return Ok(path);
    }
    write_atomic(&path, &vocabulary_seed(&project_name(root)))?;

    let readme = Path::new(root).join("README.md");
    let derive = readme.is_file() && claimed.insert(root.to_string());
    drop(claimed);
    if derive {
        let (app, project, file) = (app.clone(), root.to_string(), path.clone());
        std::thread::spawn(move || {
            derive_seed(&app, &project, &file, &readme);
            seeding().lock().unwrap().remove(&project);
        });
    }
    Ok(path)
}

/// Ask what this project's words are, once, from the one document that says.
///
/// A README is a person explaining their project in prose, so it holds exactly
/// the terms a transcriber mangles and very little else — no manifest mining,
/// no dependency lists, no symbol scraping, nothing deeper than the file the
/// project already keeps for the same purpose.
///
/// Every failure here is silent: no `claude` on the machine, a timeout, an
/// answer that came back as prose. The name-only seed is already on disk and
/// already works, so this is a convenience and never a blocker — least of all
/// for the recording it is running beside.
///
/// It takes no turn in the FIFO worker either. That queue exists so one memo's
/// stages happen one at a time; this is not a memo's stage, and it has to
/// finish while the user is still talking, which is exactly when the queue is
/// busy with the memo before it.
fn derive_seed(app: &tauri::AppHandle, root: &str, file: &Path, readme: &Path) {
    let Ok(body) = std::fs::read_to_string(readme) else { return };
    let slot: Arc<ChildSlot> = Arc::new(Mutex::new(None));
    // the call's record is dropped here: it has no take to sit beside, and
    // the thread is the only place one is offered
    let derived = run_claude(ClaudeRun {
        prompt: seed_prompt(&body),
        cwd: neutral_dir(app),
        slot: &slot,
        timeout: SEED_TIMEOUT,
        timed_out: "the README scan gave up after two minutes",
    });
    let Ok(out) = derived.text else { return };
    if append_terms(file, &glossary_lines(&out, MAX_SEED_TERMS)) > 0 {
        notice(app, root, "vocabulary seeded from the README — see ZERO.md");
    }
}

// ── the first write into someone else's project ──────────────────────────────

/// Offer `.zero/memos/` to `.gitignore`, once.
///
/// The recordings and transcripts are what has no business in a repository;
/// ZERO.md is deliberately outside the line, because a project's own words are
/// worth committing. Returns whether it appended. `check-ignore` answers 0 for
/// already-ignored — which is also how a project carrying the older, wider
/// `.zero/` line is left exactly as it is — and 128 for not-a-repository, both
/// of which mean leave it alone; only a plain 1, a repository that would track
/// this, earns the two lines. A hardened `git` isn't needed here the way it is
/// in `git.rs`: `check-ignore` consults no filter, hook or fsmonitor.
fn ensure_memos_ignored(root: &Path) -> bool {
    let checked = Command::new("git")
        .current_dir(root)
        .env("PATH", repaired_path())
        .args(["check-ignore", "-q", ".zero/memos/"])
        // the exit code is the whole answer; "fatal: not a git repository" is
        // git telling us something we asked about on purpose
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let Ok(status) = checked else { return false };
    if status.code() != Some(1) {
        return false;
    }

    let path = root.join(".gitignore");
    let mut body = std::fs::read_to_string(&path).unwrap_or_default();
    if !body.is_empty() && !body.ends_with('\n') {
        body.push('\n');
    }
    body.push_str("# zero: local voice memos\n.zero/memos/\n");
    // atomically, like every other write — this one file is *theirs*, and a
    // truncate-then-write that dies halfway would take their ignore rules with
    // it, which is a worse trade than any memo is worth
    write_atomic(&path, &body).is_ok()
}

/// Make `<root>/.zero/memos/`, and — only if it wasn't there a moment ago — do
/// the gitignore step.
///
/// The one place either of those happens, which is pressing record: the gate
/// is the directory itself rather than a flag of ours, so deleting the line
/// afterwards is a decision that sticks — zero never creates that directory
/// for the first time twice.
fn create_memos_dir(app: &tauri::AppHandle, root: &str) -> Result<PathBuf, String> {
    let dir = memos_dir(root);
    let fresh = !dir.exists();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    if fresh && ensure_memos_ignored(Path::new(root)) {
        notice(app, root, "added .zero/memos/ to .gitignore");
    }
    Ok(dir)
}

// ── the helper ───────────────────────────────────────────────────────────────

/// Tauri puts a sidecar next to the app binary, in the bundle and in dev. The
/// debug fallback is for a `cargo test`/`cargo run` that never went through
/// Tauri at all.
fn helper_path() -> Option<PathBuf> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let beside = dir.join("zero-voice");
            if beside.is_file() {
                return Some(beside);
            }
        }
    }
    #[cfg(debug_assertions)]
    {
        let built = PathBuf::from(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/binaries/zero-voice-aarch64-apple-darwin"
        ));
        if built.is_file() {
            return Some(built);
        }
    }
    None
}

/// Start a subcommand and hand it its one request line. stdin stays open —
/// `record` needs it, and everyone else drops it to signal EOF.
fn helper_spawn(sub: &str, request: &serde_json::Value) -> Result<Child, String> {
    let bin = helper_path().ok_or(HELPER_MISSING)?;
    let mut child = Command::new(bin)
        .arg(sub)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        // Piped for the short subcommands, whose stderr is read after they
        // exit and becomes their error message. Not for `record`: nothing
        // reads that pipe for the possibly-half-hour life of a recording, and
        // CoreAudio chatter filling a 64 KB buffer nobody drains would block
        // the helper mid-take. Its protocol carries errors on stdout.
        .stderr(if sub == "record" { Stdio::null() } else { Stdio::piped() })
        .spawn()
        .map_err(|e| e.to_string())?;
    {
        let stdin = child.stdin.as_mut().ok_or("helper has no stdin")?;
        stdin
            .write_all(format!("{request}\n").as_bytes())
            .and_then(|()| stdin.flush())
            .map_err(|e| e.to_string())?;
    }
    Ok(child)
}

/// Can this machine do any of it?
///
/// Cached for the life of the process — but only the answers that are about
/// the machine: the helper's own verdict, and a helper that was never built.
/// Everything else a probe can return is a bad moment rather than a bad Mac.
/// A spawn that failed, the twenty-second timeout a cold speech-asset XPC can
/// spend before it answers, a run that exited saying nothing: cache one of
/// those and the whole feature is dark until relaunch on a machine that could
/// have done it. So those are reported and forgotten, and the next press asks
/// again. Building the helper afterwards still needs a relaunch to be
/// noticed, which is the same deal as any other part of the bundle.
fn probe() -> MemoProbe {
    static CACHE: Mutex<Option<MemoProbe>> = Mutex::new(None);
    if let Some(cached) = CACHE.lock().unwrap().clone() {
        return cached;
    }
    // deliberately not holding the lock across the run: two panels asking at
    // once would rather spawn one extra helper than queue behind a call that
    // is allowed to take twenty seconds
    let (verdict, definitive) = probe_once();
    if definitive {
        *CACHE.lock().unwrap() = Some(verdict.clone());
    }
    verdict
}

/// One probe run: what it decided, and whether that's worth remembering.
fn probe_once() -> (MemoProbe, bool) {
    let request = serde_json::json!({ "locale": DEFAULT_LOCALE });
    let mut child = match helper_spawn("probe", &request) {
        Ok(child) => child,
        Err(e) => {
            let missing = e == HELPER_MISSING;
            return (
                MemoProbe {
                    supported: false,
                    message: Some(if missing { e } else { format!("voice helper: {e}") }),
                },
                // a helper that isn't in the bundle won't appear in one
                missing,
            );
        }
    };
    drop(child.stdin.take());

    let mut verdict: Option<MemoProbe> = None;
    // true only for the helper's own `probe` event: that one is a statement
    // about this Mac, where an `error` event is a statement about this attempt
    let mut definitive = false;
    let slot: Arc<ChildSlot> = Arc::new(Mutex::new(None));
    let run = run_child(&slot, child, PROBE_TIMEOUT, |line| {
        let Ok(event) = serde_json::from_str::<serde_json::Value>(line) else { return None };
        match event["event"].as_str() {
            Some("probe") => {
                let supported = event["supported"].as_bool().unwrap_or(false);
                verdict = Some(MemoProbe {
                    supported,
                    message: (!supported).then(|| NEEDS_MACOS_26.to_string()),
                });
                definitive = true;
            }
            Some("error") => {
                verdict = Some(MemoProbe {
                    supported: false,
                    message: Some(event_message(&event, NEEDS_MACOS_26)),
                });
                definitive = false;
            }
            _ => {}
        }
        None
    });
    match (verdict, run) {
        (Some(verdict), _) => (verdict, definitive),
        (None, Ok(run)) => (
            MemoProbe {
                supported: false,
                // On a Mac older than the helper's `minos`, the spawn succeeds
                // and dyld aborts it on the way up — stderr full of missing
                // symbols, which is the right verdict wearing the wrong words.
                message: Some(if run.stderr.trim().is_empty() || run.stderr.contains("dyld") {
                    NEEDS_MACOS_26.to_string()
                } else {
                    first_lines(&run.stderr, 3)
                }),
            },
            false,
        ),
        (None, Err(e)) => (MemoProbe { supported: false, message: Some(e) }, false),
    }
}

/// The human half of an `error` event, falling back when the helper sends one
/// without a message.
fn event_message(event: &serde_json::Value, fallback: &str) -> String {
    event["message"]
        .as_str()
        .filter(|m| !m.trim().is_empty())
        .unwrap_or(fallback)
        .to_string()
}

fn event_code(event: &serde_json::Value) -> String {
    event["code"].as_str().unwrap_or("error").to_string()
}

// ── running a child without leaving one behind ───────────────────────────────

struct Run {
    ok: bool,
    timed_out: bool,
    /// the exit code, when the child exited rather than being killed — for the
    /// record a call leaves behind, which should say `exit 1` where `ok` only
    /// says no
    code: Option<i32>,
    stderr: String,
}

/// Run a child to completion, handing every stdout line to `on_line`, and
/// killing it if it outstays `timeout`.
///
/// The child is parked in `slot` rather than owned here so `memo_delete` can
/// reach in and kill it mid-job; that's also why the wait is a `try_wait` poll
/// rather than a blocking `wait`, which would hold the slot's lock for the
/// whole run and make the delete wait for the thing it's cancelling.
///
/// Either way the child is collected before this returns. An uncollected child
/// is a zombie, and `Child` has no `Drop` that does it for you — the rules are
/// written out at `pty.rs::reap`.
/// `on_line` may answer a line with a `Duration`, which restarts the clock:
/// the deadline becomes that far from *now*. It exists for the one line that
/// changes what the wait is — a helper announcing the OS is downloading its
/// speech model is not a wedged transcription, and killing it mid-download
/// punishes a slow connection for being honest about it.
fn run_child(
    slot: &Arc<ChildSlot>,
    mut child: Child,
    timeout: Duration,
    mut on_line: impl FnMut(&str) -> Option<Duration>,
) -> Result<Run, String> {
    let stdout = child.stdout.take().ok_or("child has no stdout")?;
    let stderr = child.stderr.take();

    // read on a thread and hand lines over: reading here would mean choosing
    // between a blocking read and a timeout, and we need both
    let (tx, rx) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    // stderr is read on its own thread too, and handed back through a channel
    // rather than a join, for a sharper reason than stdout's: `kill` signals
    // the direct child and nothing else, so a grandchild that inherited this
    // pipe's write end — `claude -p` spawns some — keeps it open after its
    // parent is gone. `read_to_string` would never see EOF, and joining on it
    // would wedge the one global FIFO worker for the life of the app. Bounded
    // the same way, then, and the thread is abandoned if it never finishes.
    let (etx, erx) = mpsc::channel::<String>();
    match stderr {
        Some(pipe) => {
            std::thread::spawn(move || {
                let mut buf = String::new();
                let _ = BufReader::new(pipe).read_to_string(&mut buf);
                let _ = etx.send(buf);
            });
        }
        // no pipe, no sender: the receive below fails at once instead of
        // spending the grace period on a thread that was never started
        None => drop(etx),
    }
    *slot.lock().unwrap() = Some(child);

    let mut deadline = Instant::now() + timeout;
    let exit = loop {
        while let Ok(line) = rx.try_recv() {
            if let Some(more) = on_line(&line) {
                deadline = Instant::now() + more;
            }
        }
        // try_wait collects the child itself when it reports one has exited
        let exited = slot.lock().unwrap().as_mut().and_then(|c| c.try_wait().ok().flatten());
        if let Some(status) = exited {
            break Some(status);
        }
        if Instant::now() >= deadline {
            break None;
        }
        std::thread::sleep(POLL_INTERVAL);
    };

    let mut child = slot.lock().unwrap().take();
    if exit.is_none() {
        if let Some(child) = child.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    // whatever was still in the pipe; the reader hangs up at EOF, which is
    // what ends this loop. Nothing here can buy time any more — the child has
    // already exited or been killed — so the answer is read and dropped.
    while let Ok(line) = rx.recv_timeout(DRAIN_GRACE) {
        let _ = on_line(&line);
    }
    let stderr = erx.recv_timeout(DRAIN_GRACE).unwrap_or_default();
    Ok(Run {
        ok: exit.as_ref().is_some_and(|s| s.success()),
        timed_out: exit.is_none(),
        code: exit.as_ref().and_then(|s| s.code()),
        stderr,
    })
}

// ── the queue ────────────────────────────────────────────────────────────────

fn same_job(job: &Job, root: &str, id: &str, stage: Stage) -> bool {
    job.root == root && job.id == id && job.stage == stage
}

/// Put a stage in the FIFO unless it's already in it, or already running.
fn enqueue(shared: &Arc<Shared>, app: &tauri::AppHandle, root: &str, id: &str, stage: Stage) {
    let start_worker = {
        let mut st = shared.state.lock().unwrap();
        if st.queue.iter().any(|j| same_job(j, root, id, stage)) {
            return;
        }
        // by stage, not by memo: a transcribe that has just finished enqueues
        // the cleanup while it is itself still the running job
        if st
            .running
            .as_ref()
            .is_some_and(|r| r.root == root && r.id == id && r.stage == stage)
        {
            return;
        }
        st.queue.push_back(Job { root: root.to_string(), id: id.to_string(), stage });
        !std::mem::replace(&mut st.worker_started, true)
    };
    shared.wake.notify_all();
    if start_worker {
        let shared = shared.clone();
        let app = app.clone();
        std::thread::spawn(move || worker(shared, app));
    }
}

/// Which stage a memo walks on to by itself — one free retry each, then it
/// waits for a person.
///
/// The guard reads the *persisted* attempts, so a deterministic crasher can't
/// loop: each run increments the count before it can crash, and a relaunch
/// finds it where it left it. A `*_failed` status never matches here at all —
/// no silent token burning.
fn next_stage(memo: &MemoFile) -> Option<Stage> {
    match memo.status.as_str() {
        RECORDED if memo.attempts.transcribe < 2 => Some(Stage::Transcribe),
        TRANSCRIBED if memo.attempts.cleanup < 2 => Some(Stage::Cleanup),
        _ => None,
    }
}

fn auto_advance(shared: &Arc<Shared>, app: &tauri::AppHandle, root: &str, memo: &MemoFile) {
    if let Some(stage) = next_stage(memo) {
        enqueue(shared, app, root, &memo.id, stage);
    }
}

struct JobCtx<'a> {
    app: &'a tauri::AppHandle,
    shared: &'a Arc<Shared>,
    slot: &'a Arc<ChildSlot>,
    cancelled: &'a AtomicBool,
}

impl JobCtx<'_> {
    fn gone(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
    }

    /// Nothing is written for a memo that was deleted while its job ran —
    /// otherwise the job would put the json back after the delete removed it.
    fn publish(&self, root: &str, dir: &Path, memo: &MemoFile) {
        if self.gone() {
            return;
        }
        publish(self.app, self.shared, root, dir, memo);
    }
}

/// One job at a time, forever, across every project. Memos arrive at dictation
/// pace, so sequential costs nothing and answers every question about how many
/// of these may run at once.
fn worker(shared: Arc<Shared>, app: tauri::AppHandle) {
    loop {
        let (job, slot, cancelled) = {
            let mut st = shared.state.lock().unwrap();
            let job = loop {
                if let Some(job) = st.queue.pop_front() {
                    break job;
                }
                st = shared.wake.wait(st).unwrap();
            };
            let slot: Arc<ChildSlot> = Arc::new(Mutex::new(None));
            let cancelled = Arc::new(AtomicBool::new(false));
            // claimed under the same lock it was popped under, so there's no
            // instant where a job is in neither the queue nor the running slot
            st.running = Some(RunningJob {
                root: job.root.clone(),
                id: job.id.clone(),
                stage: job.stage,
                child: slot.clone(),
                cancelled: cancelled.clone(),
            });
            (job, slot, cancelled)
        };

        let ctx = JobCtx { app: &app, shared: &shared, slot: &slot, cancelled: &cancelled };
        // A panicking job must not take the thread with it: this is the one
        // worker there is, `worker_started` says it exists, and its death would
        // leave a `running` entry nothing will clear — the queue dead for the
        // rest of the session, silently. The memo itself is safe either way;
        // its checkpoints are on disk, and the panic is worth no more than a
        // failed stage was.
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| match job.stage {
            Stage::Transcribe => transcribe_job(&ctx, &job.root, &job.id),
            Stage::Cleanup => cleanup_job(&ctx, &job.root, &job.id),
        }));
        if outcome.is_err() {
            println!("[memos] a {:?} job panicked; the queue lives on", job.stage);
        }
        shared.state.lock().unwrap().running = None;
    }
}

fn transcribe_job(ctx: &JobCtx, root: &str, id: &str) {
    let dir = memos_dir(root);
    let Some(mut memo) = load_memo(&dir, id) else { return };
    // the world moved while this waited its turn
    if memo.status != RECORDED {
        return;
    }
    // Which recording this job is for. A take is transcribed exactly like the
    // base one, to a raw file of its own; the last take having no transcript on
    // disk yet is the whole of what says the follow-up is the one waiting.
    let take = memo.takes.last().filter(|t| !dir.join(&t.raw).exists()).cloned();
    let (audio, out) = match &take {
        Some(take) => (Some(take.audio.clone()), dir.join(&take.raw)),
        None => (memo.audio.clone(), dir.join(format!("{id}.raw.txt"))),
    };
    let Some(audio) = audio else {
        memo.status = TRANSCRIBE_FAILED.to_string();
        memo.error = Some(MemoError {
            stage: "transcribe".into(),
            code: "no_audio".into(),
            message: "the audio for this memo is missing".into(),
        });
        ctx.publish(root, &dir, &memo);
        return;
    };

    memo.attempts.transcribe += 1;
    memo.status = TRANSCRIBING.to_string();
    memo.error = None;
    ctx.publish(root, &dir, &memo);

    let vocabulary = read_vocabulary(root);
    let request = serde_json::json!({
        "audio": dir.join(&audio).to_string_lossy(),
        "locale": vocabulary.locale,
        "contextual": vocabulary.terms,
        "out": out.to_string_lossy(),
    });

    let mut failure: Option<MemoError> = None;
    let outcome = match helper_spawn("transcribe", &request) {
        Ok(mut child) => {
            drop(child.stdin.take());
            run_child(ctx.slot, child, TRANSCRIBE_TIMEOUT, |line| {
                let Ok(event) = serde_json::from_str::<serde_json::Value>(line) else { return None };
                match event["event"].as_str() {
                    // Apple's models are OS-managed and usually already there;
                    // when they aren't, the wait needs a reason attached — and
                    // a fresh clock: the helper starts its own ten minutes
                    // *after* the download on purpose, and a parent counting
                    // the download against that same budget would kill the one
                    // first run that was going to make every later one work.
                    // Ten minutes to fetch, ten more to transcribe.
                    Some("assets_installing") => {
                        notice(
                            ctx.app,
                            root,
                            "downloading the system speech model — this happens once",
                        );
                        return Some(TRANSCRIBE_TIMEOUT);
                    }
                    Some("assets_installed") => return Some(TRANSCRIBE_TIMEOUT),
                    Some("error") => {
                        failure = Some(MemoError {
                            stage: "transcribe".into(),
                            code: event_code(&event),
                            message: event_message(&event, "transcription failed"),
                        })
                    }
                    _ => {}
                }
                None
            })
        }
        Err(e) => Err(e),
    };
    if ctx.gone() {
        return;
    }

    let failure = match (failure, outcome) {
        (Some(err), _) => Some(err),
        (None, Err(e)) => Some(MemoError {
            stage: "transcribe".into(),
            code: "spawn_failed".into(),
            message: e,
        }),
        (None, Ok(run)) if run.timed_out => Some(MemoError {
            stage: "transcribe".into(),
            code: "timeout".into(),
            message: "transcription gave up after ten minutes".into(),
        }),
        (None, Ok(run)) if !run.ok => Some(MemoError {
            stage: "transcribe".into(),
            code: "exit".into(),
            message: if run.stderr.trim().is_empty() {
                "transcription failed".into()
            } else {
                first_lines(&run.stderr, 3)
            },
        }),
        (None, Ok(_)) => None,
    };

    match failure {
        Some(err) => {
            memo.status = TRANSCRIBE_FAILED.to_string();
            memo.error = Some(err);
            ctx.publish(root, &dir, &memo);
        }
        None => {
            // silence is not an error, but a missing file would look like one
            // to the reconciler and cost a needless second pass
            if !out.exists() {
                let _ = std::fs::write(&out, "");
            }
            memo.status = TRANSCRIBED.to_string();
            memo.error = None;
            ctx.publish(root, &dir, &memo);
            auto_advance(ctx.shared, ctx.app, root, &memo);
        }
    }
}

fn cleanup_job(ctx: &JobCtx, root: &str, id: &str) {
    let dir = memos_dir(root);
    let Some(mut memo) = load_memo(&dir, id) else { return };
    if memo.status != TRANSCRIBED {
        return;
    }

    // A memo that has takes is sitting at `transcribed` for exactly one reason:
    // the follow-up it just recorded has a transcript and no home yet. So this
    // pass is a merge, and the words it reads are the take's — the memo's own
    // transcript was folded into the document one pass ago.
    let take = memo.takes.last().cloned();
    let raw = match &take {
        Some(take) => dir.join(&take.raw),
        None => dir.join(format!("{id}.raw.txt")),
    };
    // An unreadable transcript is not a silent one. Silence has consequences —
    // it files a base memo as `(no speech detected)` and it *deletes* a
    // follow-up's recording — and an I/O error must not be allowed to spend
    // them. `unwrap_or_default` stood here once and would have.
    let transcript = match std::fs::read_to_string(&raw) {
        Ok(text) => text,
        Err(e) => {
            memo.status = CLEANUP_FAILED.to_string();
            memo.error = Some(MemoError {
                stage: "cleanup".into(),
                code: "raw_unreadable".into(),
                message: format!("could not read the transcript: {e}"),
            });
            ctx.publish(root, &dir, &memo);
            return;
        }
    };

    // nobody said anything: there is nothing for an LLM to be concise about,
    // and the call would cost tokens to produce an empty document
    if transcript.trim().chars().count() < MIN_TRANSCRIPT {
        match take {
            // A follow-up nobody spoke into is not a memo of silence, because
            // there is already a memo here. The take goes — files and entry —
            // and what is on screen goes back to being what it was a minute
            // ago, which is the outcome that was never at risk.
            Some(_) => {
                drop_take(&dir, &mut memo);
                memo.status = READY.to_string();
                memo.error = None;
                ctx.publish(root, &dir, &memo);
                notice(ctx.app, root, "no speech in the follow-up — memo unchanged");
            }
            None => {
                memo.status = READY.to_string();
                memo.title = Some(NO_SPEECH.to_string());
                memo.error = None;
                ctx.publish(root, &dir, &memo);
            }
        }
        return;
    }

    memo.attempts.cleanup += 1;
    memo.status = CLEANING.to_string();
    memo.error = None;
    ctx.publish(root, &dir, &memo);

    let vocabulary = read_vocabulary(root);
    // read fresh: the document is a file in the user's editor between passes,
    // and what they left in it is what the follow-up is revising
    let document = std::fs::read_to_string(dir.join(format!("{id}.md"))).unwrap_or_default();
    let prompt = match (&take, document.trim()) {
        (Some(_), document) if !document.is_empty() => {
            merge_prompt(&vocabulary.body, document, &transcript)
        }
        // A take on a memo with no document to revise — one that came back
        // silent, or whose `.md` was deleted — is cleaned rather than merged:
        // talking again is also how you rescue a memo that came back empty, and
        // a merge against nothing is just a cleanup with extra words in it.
        _ => cleanup_prompt(&vocabulary.body, &transcript),
    };
    let request = CleanupRequest { prompt, cwd: neutral_dir(ctx.app), slot: ctx.slot };
    let answered = clean_transcript(request);
    if ctx.gone() {
        return;
    }

    // The call itself, beside the document it is about — or would have been:
    // it is kept before the answer is judged, because the call that came back
    // with nothing is the one somebody will want to read. `unwrap_or(1)`: a
    // memo with no takes was distilled from its own recording, which is take 1.
    let n = last_take_no(&memo).unwrap_or(1);
    keep_invocation(&dir, id, n, &answered.invocation);

    // the memo is everything before the vocabulary marker, and what follows it
    // is for ZERO.md and never for the document — the `.md` stays a pure paste
    // payload, which is the one thing the whole pipeline is for
    let cleaned = answered.text.and_then(|out| {
        let (text, suggested) = split_suggestions(&out);
        let text = text.trim();
        if text.is_empty() {
            // all vocabulary and no memo: the same nothing `run_claude` would
            // have refused, arriving one layer down
            return Err("claude returned nothing".to_string());
        }
        Ok((format!("{text}\n"), glossary_lines(suggested, MAX_SUGGESTIONS)))
    });

    match cleaned {
        Ok((text, suggested)) => {
            // Alongside and renamed over, which is what makes iterating safe:
            // every way a merge can go wrong — a refusal, a timeout, a killed
            // child, a full disk — ends here with the previous document still
            // whole on disk. A memo is never worth less after being talked to
            // than it was before.
            match write_atomic(&dir.join(format!("{id}.md")), &text) {
                Ok(()) => {
                    // and a copy under the take that produced it. The `.md` is
                    // the document as it now stands; these are what it stood as
                    // at each step, which is the only reason the next merge
                    // isn't the end of what this one said.
                    snapshot(&dir, id, n);
                    memo.title = title_from_md(&text);
                    memo.status = READY.to_string();
                    memo.error = None;
                    harvest(ctx.app, root, &suggested);
                }
                Err(e) => {
                    memo.status = CLEANUP_FAILED.to_string();
                    memo.error = Some(MemoError {
                        stage: "cleanup".into(),
                        code: "write_failed".into(),
                        message: e,
                    });
                }
            }
        }
        Err(message) => {
            memo.status = CLEANUP_FAILED.to_string();
            let code = if login_needed(&message) { NEEDS_LOGIN } else { "engine" };
            memo.error = Some(MemoError { stage: "cleanup".into(), code: code.into(), message });
        }
    }
    ctx.publish(root, &dir, &memo);
}

/// Put the terms cleanup noticed into ZERO.md, and say so.
///
/// After the memo is safely on disk and never in its way: a suggestion that
/// doesn't land costs nothing, where a memo that doesn't land costs the whole
/// recording. Surfaced rather than silent — the notice is this feature's only
/// surface, and a bad suggestion is pruned by deleting its line, which is the
/// editing loop the file already had.
fn harvest(app: &tauri::AppHandle, root: &str, suggested: &[String]) {
    if suggested.is_empty() {
        return;
    }
    // tagged, so a line a machine wrote is one you can see you didn't
    let tagged: Vec<String> = suggested.iter().map(|line| format!("{line} (suggested)")).collect();
    let added = append_terms(&vocabulary_path(root), &tagged);
    if added == 0 {
        return;
    }
    // never the word "model" in here: the panel reads one in a notice as the
    // OS fetching its speech assets, and then says so on every transcribing row
    let s = if added == 1 { "" } else { "s" };
    notice(app, root, &format!("{added} word{s} suggested for the vocabulary — see ZERO.md"));
}

/// Somewhere with no `CLAUDE.md` in it. The project root would load one, which
/// is both a style pollution for a pure-text task and an injection surface for
/// a prompt that carries someone's dictation.
fn neutral_dir(app: &tauri::AppHandle) -> PathBuf {
    let dir = app.path().app_config_dir().unwrap_or_else(|_| std::env::temp_dir());
    let _ = std::fs::create_dir_all(&dir);
    dir
}

struct CleanupRequest<'a> {
    prompt: Prompt,
    cwd: PathBuf,
    slot: &'a Arc<ChildSlot>,
}

/// The cleanup engine, and the only place that knows there is one.
///
/// v1 shells out to `claude -p`, which is definitionally installed — zero
/// exists to run it — so there's no API key to store and no network code in
/// this binary. An `ApiEngine` that posts to the Messages API instead would
/// replace this function and [`run_claude`] beneath it and nothing else;
/// that's the entire reason it's a function and not five lines inside
/// [`cleanup_job`]. A [`Prompt`] is already the shape such an engine would
/// post — a system string and a user message — so the seam is the same two
/// halves on either side of it.
fn clean_transcript(req: CleanupRequest) -> ClaudeAnswer {
    run_claude(ClaudeRun {
        prompt: req.prompt,
        cwd: req.cwd,
        slot: req.slot,
        timeout: CLEANUP_TIMEOUT,
        timed_out: "cleanup gave up after four minutes",
    })
}

struct ClaudeRun<'a> {
    prompt: Prompt,
    cwd: PathBuf,
    slot: &'a Arc<ChildSlot>,
    timeout: Duration,
    /// what to say when the timeout is what ended it — the one failure whose
    /// wording is the caller's business, because "gave up" needs a subject
    timed_out: &'static str,
}

/// One `claude -p`: a prompt in, everything it printed out.
///
/// Shared by the cleanup pass and the README seed, so both get the same flags,
/// the same repaired PATH, the same neutral cwd, and the same promise that no
/// child of ours outlives its timeout.
///
/// The two halves of the prompt travel differently, and the difference is the
/// point. The system prompt goes on argv, as `--system-prompt`: the
/// instructions, which are text fixed at compile time, and the project
/// vocabulary, which is not — argv is what `ps` shows every other process on
/// the machine for as long as the call runs, and the vocabulary is the one
/// piece of the user's that is put there, knowingly: a project's own proper
/// nouns, short, and the same for every memo. The message goes on stdin,
/// never argv: it's a transcript of whatever somebody said, or a whole README,
/// and argv is neither large enough nor private enough for either. The flag
/// *replaces* the CLI's own system prompt rather than adding to it, and for a
/// text-in, text-out task that is the right way round — the same reason the
/// cwd is [`neutral_dir`]: none of the agent's instructions to itself have any
/// business near a memo.
///
/// A `claude` too old to know the flag refuses it before doing anything else
/// — `error: unknown option`, exit 1, no model call — and then the halves go
/// the way they always went, as one message on stdin. Decided per call and
/// never remembered: the second node start-up is the whole cost, and nothing
/// is left believing an upgrade hasn't happened.
fn run_claude(req: ClaudeRun) -> ClaudeAnswer {
    let ClaudeRun { prompt, cwd, slot, timeout, timed_out } = req;
    let started = Instant::now();
    // the PATH and the words are made once and go two ways — to the process,
    // and into the record of what the process got — so the record cannot
    // describe a call other than the one that ran
    let path = repaired_path();
    let system = prompt.system();
    let mut args = claude_args(Some(&system));
    let mut stdin = prompt.message.clone();
    let mut refused = None;
    let mut spawned = spawn_claude(&cwd, &path, slot, timeout, &args, stdin.clone());
    if let Ok((_, run)) = &spawned {
        if !run.ok && !run.timed_out && lacks_system_prompt_flag(&run.stderr) {
            refused = Some(first_lines(&run.stderr, 1));
            args = claude_args(None);
            stdin = prompt.combined();
            spawned = spawn_claude(&cwd, &path, slot, timeout, &args, stdin.clone());
        }
    }
    let secs = started.elapsed().as_secs_f64();

    let (text, outcome) = match spawned {
        Err(e) => (Err(e.clone()), format!("never started: {e}")),
        Ok((out, run)) => {
            let outcome = if run.timed_out {
                format!("killed by zero after {secs:.1} s, its timeout")
            } else if let Some(code) = run.code {
                format!("exit {code} after {secs:.1} s")
            } else {
                format!("killed after {secs:.1} s")
            };
            (answer_of(out, run, timed_out), outcome)
        }
    };
    let invocation = Invocation {
        instructions: prompt.instructions,
        cwd,
        path,
        args,
        stdin,
        refused,
        outcome,
    };
    ClaudeAnswer { text, invocation }
}

/// What one finished call amounts to: the text, or the reason there is none.
fn answer_of(out: String, run: Run, timed_out: &'static str) -> Result<String, String> {
    if run.timed_out {
        return Err(timed_out.into());
    }
    if !run.ok {
        // claude puts most of its refusals on stdout, not stderr — an expired
        // login says "Failed to authenticate" there and nothing anywhere else
        let said = if run.stderr.trim().is_empty() { &out } else { &run.stderr };
        return Err(if said.trim().is_empty() {
            "claude exited without saying why".into()
        } else {
            first_lines(said, 3)
        });
    }
    if out.trim().is_empty() {
        return Err("claude returned nothing".into());
    }
    Ok(out)
}

/// What came back from one `claude -p`, and what went in to get it.
///
/// The two travel together because the second is only ever wanted about the
/// first: a developer reading a turn of a memo and asking what, exactly,
/// produced it.
struct ClaudeAnswer {
    /// everything claude printed, or why there is nothing
    text: Result<String, String>,
    invocation: Invocation,
}

/// One `claude -p` call as the operating system saw it: where it ran, with
/// what PATH, every argument, the whole of stdin, and how it ended. Kept for
/// the developer and written beside the document it produced, as a shell
/// script that runs the same call again — [`invocation_script`] is the shape.
///
/// Taken from the vector the process was given, never re-described from the
/// prompt — see [`claude_args`] — which is what lets the file claim to be
/// verbatim.
struct Invocation {
    instructions: Instructions,
    cwd: PathBuf,
    path: String,
    /// the words after `claude`, exactly as `Command::args` got them
    args: Vec<String>,
    stdin: String,
    /// what an older claude said when it refused `--system-prompt`; the call
    /// recorded is then the second one, which sent both halves as one message
    refused: Option<String>,
    /// how it ended, in the record's own words: an exit code and a duration,
    /// or the kill, or the reason it never started
    outcome: String,
}

/// The words after `claude`, for every call: print mode, plain text back, no
/// tools, and the system prompt when there is one. One function, because
/// [`Invocation`] keeps the vector this returns and the process gets the same
/// vector — two lists would be two chances to record something other than
/// what ran.
fn claude_args(system: Option<&str>) -> Vec<String> {
    let mut args: Vec<String> = [
        "-p",
        "--output-format",
        "text",
        // belt and braces: these are text-in, text-out tasks, and the cwd
        // is ours, but neither of them has any business reading or writing
        // anything at all
        "--disallowedTools",
        "Bash,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch,Task,TodoWrite,NotebookEdit",
    ]
    .map(String::from)
    .into();
    if let Some(system) = system {
        // its own argument, not `--system-prompt=…`: the text is readable in
        // `ps` either way, and this way it is readable by a person
        args.push("--system-prompt".to_string());
        args.push(system.to_string());
    }
    args
}

/// Whether a failure is an older `claude` refusing `--system-prompt` — the one
/// failure [`run_claude`] answers by trying again instead of reporting. Both
/// halves of the test matter: commander says "unknown option" for any flag it
/// has never heard of, and naming ours is what keeps a killed child or an
/// expired login from ever passing for one.
fn lacks_system_prompt_flag(stderr: &str) -> bool {
    stderr.contains("unknown option") && stderr.contains("--system-prompt")
}

/// One spawn of `claude -p` and the wait for it: the words, the PATH, `stdin`
/// written from its own thread, and whatever came back. What to make of the
/// answer — a retry, an error, a memo — is [`run_claude`]'s business, because
/// it may ask twice.
fn spawn_claude(
    cwd: &Path,
    path: &str,
    slot: &Arc<ChildSlot>,
    timeout: Duration,
    args: &[String],
    stdin: String,
) -> Result<(String, Run), String> {
    let mut child = Command::new("claude")
        .args(args)
        .current_dir(cwd)
        .env("PATH", path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "claude isn't installed — the raw transcript is already yours".to_string()
            } else {
                e.to_string()
            }
        })?;

    // written from its own thread: a long transcript can fill the pipe before
    // claude has read any of it, and then both sides sit waiting for the other
    // (the same trap `ignored_names` in git.rs steps around)
    if let Some(mut sink) = child.stdin.take() {
        std::thread::spawn(move || {
            let _ = sink.write_all(stdin.as_bytes());
        });
    }

    let mut out = String::new();
    let run = run_child(slot, child, timeout, |line| {
        out.push_str(line);
        out.push('\n');
        None
    })?;
    Ok((out, run))
}

// ── the record of a call ─────────────────────────────────────────────────────

/// `<id>.<n>.claude.sh` — the call behind take n, numbered as the document it
/// left is, so the two sit together in a listing.
fn invocation_name(id: &str, n: usize) -> String {
    format!("{id}.{n}.claude.sh")
}

/// Write the call behind take `n` beside its document.
///
/// Same standing as a version: a display artifact for someone reading the
/// thread, never consulted by the pipeline, so a failure here is logged and
/// nothing more. Written on every outcome and not only success — the call that
/// came back with nothing is the one a developer most wants to read — and
/// written over on a retry, because the record is of the call that answered.
fn keep_invocation(dir: &Path, id: &str, n: usize, inv: &Invocation) {
    let what = format!("zero's {}, take {n} of {id}", inv.instructions.pass());
    let script = invocation_script(inv, &iso(now_secs()), &what);
    if let Err(e) = write_atomic(&dir.join(invocation_name(id, n)), &script) {
        println!("[memos] could not keep the call behind {id} take {n}: {e}");
    }
}

/// The call as a shell script: runnable as it is, and exact. Every word of
/// argv is single-quoted — inside single quotes sh reads everything literally,
/// newlines included, and only the quote itself has to be spelled, as `'\''` —
/// stdin is a quoted heredoc, and the cwd and PATH are the ones the process
/// had. Exact in both directions is the point: a developer who wants to know
/// what zero sends can read it, and one who wants to try a change can edit it
/// and run it.
///
/// `what` names the pass and the memo and `when` the time, for the header —
/// the one part of the file that is description rather than record.
fn invocation_script(inv: &Invocation, when: &str, what: &str) -> String {
    let mut s = String::from("#!/bin/sh\n");
    s.push_str(&format!(
        "# {what}: the claude call, verbatim — every argument and the whole of stdin,\n\
         # exactly as zero handed them over. Runs as it is; the answer comes back on stdout.\n\
         # Ran {when}; {}.\n",
        inv.outcome
    ));
    if let Some(said) = &inv.refused {
        s.push_str(&format!(
            "# This claude refused --system-prompt ({said}), so zero sent the two halves\n\
             # of the prompt as one message — the call below is that second one.\n"
        ));
    }
    s.push_str(&format!("cd {} || exit 1\n", sh_word(&inv.cwd.to_string_lossy())));
    s.push_str(&format!("export PATH={}\n", sh_word(&inv.path)));
    s.push_str("claude");
    for arg in &inv.args {
        s.push_str(" \\\n  ");
        s.push_str(&sh_word(arg));
    }
    // A heredoc ends at a line end, so a message that doesn't end with one is
    // recorded one newline longer than it was. Every message zero writes ends
    // with one — the prompt tests say so — so this is a rule, not a case.
    let tag = heredoc_tag(&inv.stdin);
    s.push_str(&format!(" \\\n  <<'{tag}'\n"));
    s.push_str(&inv.stdin);
    if !inv.stdin.ends_with('\n') {
        s.push('\n');
    }
    s.push_str(&tag);
    s.push('\n');
    s
}

/// One word of a shell command: bare when it is plain enough that no shell
/// would touch it, single-quoted otherwise. Single quotes are the whole of the
/// escaping, because inside them sh reads everything literally except another
/// single quote, which is spelled `'\''` — close, escaped quote, reopen.
fn sh_word(word: &str) -> String {
    let plain = !word.is_empty()
        && word.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_./=:".contains(&b));
    if plain {
        word.to_string()
    } else {
        format!("'{}'", word.replace('\'', "'\\''"))
    }
}

/// A delimiter the text does not contain as a line of its own. `ZERO_STDIN`,
/// unless the memo is about this very file and quotes it — the same case
/// [`split_suggestions`] makes for the vocabulary marker — in which event a
/// number goes on the end until the line is nowhere in the text.
fn heredoc_tag(body: &str) -> String {
    let mut tag = "ZERO_STDIN".to_string();
    let mut n = 1;
    while body.lines().any(|line| line == tag) {
        n += 1;
        tag = format!("ZERO_STDIN_{n}");
    }
    tag
}

// ── the prompts ──────────────────────────────────────────────────────────────

/// Which of the three jobs a [`Prompt`] is for — distilling a recording,
/// merging a follow-up into the document it was recorded onto, reading a
/// README for a vocabulary — and, through [`Instructions::text`], the system
/// prompt for it. Three and not one because they are three jobs with three
/// output contracts: a seed that answered in the cleanup's shape would put a
/// title into someone's glossary.
///
/// An enum over three `const`s rather than a `&'static str` field: the
/// instructions are fixed at compile time, and a closed choice between them
/// has no slot a runtime string can reach — where a `'static` str *field*
/// would be a convention, since `String::leak` mints one from anything. What
/// can reach the system prompt is decided one field over, in [`Prompt`], and
/// it is the vocabulary and nothing else.
#[derive(Clone, Copy, PartialEq, Debug)]
enum Instructions {
    Cleanup,
    Merge,
    Seed,
}

impl Instructions {
    fn text(self) -> &'static str {
        match self {
            Instructions::Cleanup => CLEANUP_SYSTEM,
            Instructions::Merge => MERGE_SYSTEM,
            Instructions::Seed => SEED_SYSTEM,
        }
    }

    /// The pass by the name the rest of the feature calls it, for the header
    /// of the record a call leaves behind.
    fn pass(self) -> &'static str {
        match self {
            Instructions::Cleanup => "cleanup",
            Instructions::Merge => "merge",
            Instructions::Seed => "README seed",
        }
    }
}

/// A prompt in the two halves `claude` takes them: the system prompt — the
/// instructions, and after them the project vocabulary under a heading of its
/// own — and the message, which is the transcript, or the document and the
/// follow-up, or the README, and goes on stdin.
///
/// The vocabulary rides with the instructions rather than with the words it
/// corrects, by decision: it is the reference the instructions are about, it
/// is short, and it is the same for every memo in a project. It is also the
/// one thing of the user's that goes on argv — see [`run_claude`] for what
/// that costs — and it is named here as exactly that, so that the transcript,
/// the document and the README, which have no field on this side, still
/// cannot follow it.
struct Prompt {
    instructions: Instructions,
    /// the project's own words, already passed through [`vocabulary_or_none`];
    /// `None` for the one pass that has no use for them, the README seed
    vocabulary: Option<String>,
    message: String,
}

impl Prompt {
    /// The instructions, and the vocabulary appended as the last section, so
    /// that "the `## Project vocabulary` section below" in the instructions is
    /// true of the system prompt on its own and of [`combined`] alike.
    fn system(&self) -> String {
        match &self.vocabulary {
            Some(vocabulary) => {
                format!("{}\n\n## Project vocabulary\n\n{vocabulary}", self.instructions.text())
            }
            None => self.instructions.text().to_string(),
        }
    }

    /// Both halves as the one message they used to be, for a `claude` too old
    /// to take a system prompt. Derived from the halves rather than kept as a
    /// second copy of the words: two copies is two things that can drift, and
    /// the one that drifted would be the one nobody runs.
    fn combined(&self) -> String {
        format!("{}\n\n{}", self.system(), self.message)
    }
}

/// What the vocabulary is and what to do with it. Shared by both prompts,
/// because there is one answer to that and it should not drift into two.
///
/// A macro rather than a `const`, here and for the trailer below it: the
/// system prompts are assembled by `concat!`, which takes literals and nothing
/// else, and a macro that expands to a literal is how a literal gets a name.
macro_rules! vocabulary_rule {
    () => {
        "The `## Project vocabulary` section below lists the correct spellings of proper nouns the transcription likely mangled — \
restore them based on meaning, not blind find-and-replace: \
an entry's mishearing may also occur as the ordinary word it sounds like, and only context tells them apart."
    };
}

/// The trailer both prompts end with: the marker, the shape of a line behind
/// it, and silence when there is nothing to say. Shared for a sharper reason
/// than the rule above — [`split_suggestions`] parses exactly this contract,
/// and a second copy of it is a second thing that can stop matching the parser.
macro_rules! vocabulary_trailer {
    () => {
        "Then, and only if there were any: after the memo, list the proper nouns you corrected — or are confident should have been \
corrected and could not be — that are not already in the project vocabulary. \
Write a line containing exactly `---vocabulary---`, then one line per term in the vocabulary's own shape, \
`- Term — misheard as: X`. \
Ordinary dictionary words are never vocabulary and never go there. \
When there are no such terms, output nothing at all after the memo: no marker, no empty section."
    };
}

/// The same two as values, for the tests that hold every prompt to them; the
/// prompts themselves take the literals.
#[cfg(test)]
const VOCABULARY_RULE: &str = vocabulary_rule!();
#[cfg(test)]
const VOCABULARY_TRAILER: &str = vocabulary_trailer!();

/// A vocabulary section always ends the system prompt, even when the file is
/// empty, so the model is never left guessing whether one was meant to be there.
fn vocabulary_or_none(vocabulary: &str) -> &str {
    if vocabulary.trim().is_empty() {
        "(none provided)"
    } else {
        vocabulary.trim()
    }
}

/// The cleanup instructions. Assembled at compile time so the exact words are
/// in one place and a test can hold them to it — and so that nothing assembled
/// at run time can be in them.
const CLEANUP_SYSTEM: &str = concat!(
    "Clean up the voice-memo transcript in the message's `## Transcript` section.\n\
\n\
The transcript was produced by speech-to-text and contains recognition errors. ",
    vocabulary_rule!(),
    "\n\
\n\
The speaker is thinking out loud: they reason with themselves, change their mind, and correct \
themselves as they go — a later statement often supersedes an earlier one. \
First work out, silently, where the memo actually landed: which decisions survived the \
self-corrections, which directions were abandoned, and what was left genuinely open. \
Then write the distilled outcome, not a play-by-play: compact, in the speaker's first-person voice, \
keeping every decision, name, number, constraint, and instruction that still stands at the end. \
Where the speaker overruled themselves, keep only the final position, not the journey. \
List anything they explicitly left unresolved as open questions. \
Do not add content, opinions, or structure that is not in the memo. \
If a span is too garbled to interpret, mark it [unclear].\n\
\n\
Output Markdown. The first line must be `# ` followed by a 3–6 word title naming what the memo is about. \
Then the distilled memo. No preamble, no commentary, no code fences around the whole output.\n\
\n",
    vocabulary_trailer!()
);

/// The cleanup prompt: [`CLEANUP_SYSTEM`] with the vocabulary behind it, and a
/// message that is the transcript under the heading those instructions name.
/// One function, so a test can hold both halves' shape to it.
fn cleanup_prompt(vocabulary: &str, transcript: &str) -> Prompt {
    Prompt {
        instructions: Instructions::Cleanup,
        vocabulary: Some(vocabulary_or_none(vocabulary).to_string()),
        message: format!("## Transcript\n\n{transcript}\n"),
    }
}

/// The other half of the pipeline's second stage: the same pass, run on a memo
/// that already has a document, with a follow-up recorded on top of it.
///
/// Same rule as [`CLEANUP_SYSTEM`] — the exact words live in one place and a
/// test holds them to it — and the same two contracts at the end, because the
/// answer is parsed by exactly the same code. What differs is what the model is
/// being asked for: not a distillation of one recording, but the document as it
/// now stands, with the follow-up treated as instructions for revising it.
const MERGE_SYSTEM: &str = concat!(
    "Revise the current document with the follow-up voice memo recorded on top of it.\n\
\n\
The follow-up transcript was produced by speech-to-text and contains recognition errors. ",
    vocabulary_rule!(),
    "\n\
\n\
The message's `## Current document` section is the document distilled from this memo so far, and \
`## Follow-up transcript` is the transcript of a follow-up recording made on top of it. \
The follow-up is a spec for revising the document: work out, silently, what it adds, \
changes, answers, or withdraws. Where it conflicts with the document, the follow-up wins. \
Statements in it resolve the document's open questions where they do; questions that remain stay open. \
The follow-up is itself someone thinking out loud — they reason with themselves and correct themselves as they go — \
so apply the same rule to it: only its final positions count.\n\
\n\
Then output the complete revised document — not a delta, not a changelog, not commentary on what changed: \
the document as it now stands, compact, in the speaker's first-person voice, \
keeping every decision, name, number, constraint, and instruction currently in force. \
Do not add content that is in neither the document nor the follow-up. \
If a span is too garbled to interpret, mark it [unclear]. \
Keep the existing title unless the subject has genuinely moved.\n\
\n\
Output Markdown. The first line must be `# ` followed by the title, 3–6 words naming what the memo is about. \
Then the revised document. No preamble, no commentary, no code fences around the whole output.\n\
\n",
    vocabulary_trailer!()
);

/// The merge prompt: [`MERGE_SYSTEM`] with the vocabulary behind it, and a
/// message carrying the document as the user left it and the follow-up's
/// transcript, each under the heading the instructions call it by.
fn merge_prompt(vocabulary: &str, document: &str, transcript: &str) -> Prompt {
    Prompt {
        instructions: Instructions::Merge,
        vocabulary: Some(vocabulary_or_none(vocabulary).to_string()),
        message: format!("## Current document\n\n{document}\n\n## Follow-up transcript\n\n{transcript}\n"),
    }
}

/// How much README the seed prompt carries. A file that hasn't named the
/// project's own words in its first twenty-odd kilobytes was never going to,
/// and the whole of a long one is a lot of tokens for one glossary.
const MAX_README: usize = 24 * 1024;
/// Two minutes of `claude -p` over a README. It runs beside a recording and
/// nothing waits on it, so the ceiling is only there to stop a wedged call
/// from keeping a process alive for the afternoon.
const SEED_TIMEOUT: Duration = Duration::from_secs(120);
/// A seed derived from a README is a starting point, not an index of the
/// project. A macro for the reason the rule and the trailer are: the seed
/// instructions quote the number, and `concat!` will take it from a literal
/// and from nothing else.
macro_rules! max_seed_terms {
    () => {
        20
    };
}
const MAX_SEED_TERMS: usize = max_seed_terms!();

/// The seed instructions. Same rule as [`CLEANUP_SYSTEM`]: the exact words
/// live in one place, and a test holds them to it.
const SEED_SYSTEM: &str = concat!(
    "From the README in the message's `## README` section, list the proper nouns and project-specific terms \
that a speech transcriber would plausibly mangle.\n\
\n\
Product, company, library and tool names; people's names; invented words; unusual spellings or capitalisation; \
anything a dictation engine would hear as the ordinary word it sounds like. \
Skip ordinary dictionary words — a term earns a line only because getting it wrong would be noticeable.\n\
\n\
Output one term per line, exactly: `- Term — one short hint about how it is likely to be misheard`. \
At most ",
    max_seed_terms!(),
    " lines, the most distinctive first. \
Output only those lines: no preamble, no heading, no commentary, no code fences. \
If the README names nothing worth listing, output nothing at all."
);

/// The seed prompt: [`SEED_SYSTEM`], and a message that is the README — the
/// first [`MAX_README`] bytes of it — under the one heading it names.
fn seed_prompt(readme: &str) -> Prompt {
    let readme = head(readme, MAX_README);
    // no vocabulary: this is the pass that writes the first one
    Prompt { instructions: Instructions::Seed, vocabulary: None, message: format!("## README\n\n{readme}\n") }
}

/// The first `max` bytes of `text`, cut where a character ends rather than
/// through the middle of one.
fn head(text: &str, max: usize) -> &str {
    if text.len() <= max {
        return text;
    }
    let mut cut = max;
    while cut > 0 && !text.is_char_boundary(cut) {
        cut -= 1;
    }
    &text[..cut]
}

/// The line cleanup puts between the memo and the words it wants adding.
const VOCABULARY_MARKER: &str = "---vocabulary---";

/// Split cleanup's output into the memo and the glossary lines behind it.
///
/// The *last* marker line wins. A memo about this feature will quote the
/// marker — this file's own author dictates about this file — and the one the
/// prompt asks for is always the final one. No marker at all means the whole
/// output is the memo, which is every memo that had nothing to suggest.
fn split_suggestions(out: &str) -> (&str, &str) {
    let mut cut: Option<(usize, usize)> = None;
    let mut at = 0;
    for line in out.split_inclusive('\n') {
        if line.trim() == VOCABULARY_MARKER {
            cut = Some((at, at + line.len()));
        }
        at += line.len();
    }
    match cut {
        Some((start, end)) => (&out[..start], &out[end..]),
        None => (out, ""),
    }
}

// ── reconciliation ───────────────────────────────────────────────────────────

/// What a stem actually has on disk. The json is a claim; this is the fact.
#[derive(Default, PartialEq, Debug)]
struct Artifacts {
    /// filename, and only when it has bytes in it — a zero-length recording is
    /// the same as none
    audio: Option<String>,
    raw: bool,
    raw_len: u64,
    /// existence only — the title is read on demand, see [`md_title`]
    md: bool,
    json: bool,
    /// the oldest mtime among them — the audio, in practice — for a memo whose
    /// `created` has to be invented
    mtime: i64,
    /// the take files found beside this stem, by take number. Folded in here
    /// rather than standing as stems of their own: `<id>.2.m4a` is this memo's
    /// second recording, not a memo called `<id>.2`, and treating it as one
    /// would put a phantom row in the list for every follow-up ever recorded.
    takes: BTreeMap<usize, TakeArt>,
}

/// What one take has on disk. Two things, because a take has only two files —
/// no json and no `.md` of its own, since the memo's document *is* the merged
/// outcome and there is nothing separate for a take to own.
#[derive(Default, PartialEq, Debug)]
struct TakeArt {
    /// filename, and only when it has bytes in it, exactly as above
    audio: Option<String>,
    raw: bool,
}

impl TakeArt {
    /// Is there anything here worth calling a take? A numbered file with no
    /// bytes in it is a recording that never started, not a take.
    fn real(&self) -> bool {
        self.audio.is_some() || self.raw
    }
}

impl Artifacts {
    /// How far the files themselves say this memo got. A memo can never claim
    /// more than this — a `ready` whose `.md` was deleted is a `transcribed`.
    fn level(&self) -> u8 {
        if self.audio.is_none() {
            return 0;
        }
        if !self.raw {
            return 1;
        }
        // a transcript of silence is finished: there is no `.md` coming, and
        // demoting it would re-run the pipeline forever
        if self.md || self.raw_len < MIN_TRANSCRIPT as u64 {
            3
        } else {
            2
        }
    }
}

fn level_status(level: u8) -> &'static str {
    match level {
        3 => READY,
        2 => TRANSCRIBED,
        _ => RECORDED,
    }
}

/// How far a status claims to have got, for statuses that are standing still.
/// A failure ranks at its checkpoint: `cleanup_failed` still has a transcript.
fn status_level(status: &str) -> u8 {
    match status {
        READY => 3,
        TRANSCRIBED | CLEANUP_FAILED => 2,
        _ => 1,
    }
}

/// Read a directory into one [`Artifacts`] per stem.
fn scan(dir: &Path) -> BTreeMap<String, Artifacts> {
    let mut found: BTreeMap<String, Artifacts> = BTreeMap::new();
    let Ok(entries) = std::fs::read_dir(dir) else { return found };

    for entry in entries.filter_map(|e| e.ok()) {
        let name = entry.file_name().to_string_lossy().to_string();
        // our own temp files are dotted, and so is anything else that isn't ours
        if name.starts_with('.') {
            continue;
        }
        let meta = entry.metadata().ok();
        let mtime = meta
            .as_ref()
            .and_then(|m| m.modified().ok())
            .map(epoch_secs)
            .unwrap_or_else(now_secs);
        let len = meta.as_ref().map(|m| m.len()).unwrap_or(0);

        let Some((stem, kind)) = classify(&name) else { continue };

        // a numbered file is take n of the memo whose stem it is built on, and
        // everything it says is said about that memo
        if let Some((base, n)) = split_take(stem) {
            let art = found.entry(base.to_string()).or_default();
            let take = art.takes.entry(n).or_default();
            match kind {
                "raw" => take.raw = true,
                // m4a over caf, the same trade as below
                "audio" if len > 0 && (take.audio.is_none() || name.ends_with(".m4a")) => {
                    take.audio = Some(name.clone());
                }
                _ => {}
            }
            continue;
        }

        let art = found.entry(stem.to_string()).or_default();
        art.mtime = if art.mtime == 0 { mtime } else { art.mtime.min(mtime) };
        match kind {
            "raw" => {
                art.raw = true;
                art.raw_len = len;
            }
            "json" => art.json = true,
            // the existence bit is what level() and the demotion rule need;
            // the title lives in the json cleanup already wrote, so reading
            // the document here would be re-reading every memo in the project
            // on every list — and the frontend lists after every action
            "md" => art.md = true,
            // A version is the document as some take left it: a record of the
            // exchange, and evidence of nothing. It is not the `.md` the level
            // rule asks after — a memo whose document was deleted by hand is
            // demoted with its snapshots sitting right there — and it is not a
            // recording, so it can never be the reason a take exists. The
            // record of the call behind a take is the same kind of thing.
            "version" | "invocation" => {}
            // m4a wins over caf: conversion succeeded and the caf is a leftover
            _ if len > 0 && (art.audio.is_none() || name.ends_with(".m4a")) => {
                art.audio = Some(name.clone());
            }
            _ => {}
        }
    }
    found
}

/// The title out of `<stem>.md`, read only as far as it has to be.
///
/// Reconciliation wants this in two places, both of them rare — an orphan with
/// no usable json, and a json that lost its title — so it's a lazy read rather
/// than something [`scan`] does to every memo it passes. Line by line, and it
/// stops at the first non-blank one: `title_from_md` skips leading blanks, so
/// this has to reach past them too, and a cleaned memo is otherwise pages of
/// bytes read for one heading.
fn md_title(dir: &Path, stem: &str) -> Option<String> {
    let file = std::fs::File::open(dir.join(format!("{stem}.md"))).ok()?;
    BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .find(|line| !line.trim().is_empty())
        .and_then(|line| title_from_md(&line))
}

/// Give a memo the takes its files have and its json doesn't, and let the files
/// correct the names of the ones it does.
///
/// Two ways a numbered file can outlive the entry that named it: a json rebuilt
/// from scratch knows nothing about takes at all, and a take's entry is written
/// in the same breath as its first byte, so a crash can land between them.
/// Either way the recording is folded in rather than swept up — audio is the
/// one thing here that cannot be made again, and the cost of keeping it is a
/// duration of zero in a tooltip.
fn fold_takes(memo: &mut MemoFile, art: &Artifacts) {
    // the names first: a conversion that finished after the crash which stopped
    // the json being written leaves an m4a where the entry still says caf
    for (i, take) in memo.takes.iter_mut().enumerate() {
        if let Some(found) = art.takes.get(&take_no(i)).and_then(|t| t.audio.as_ref()) {
            if take.audio != *found {
                take.audio = found.clone();
            }
        }
    }

    let Some(highest) = art.takes.iter().filter(|(_, t)| t.real()).map(|(n, _)| *n).max() else {
        return;
    };
    // `unwrap_or(1)`: with no takes at all the memo is on take 1, its own
    while last_take_no(memo).unwrap_or(1) < highest {
        let n = take_no(memo.takes.len());
        let audio = art
            .takes
            .get(&n)
            .and_then(|t| t.audio.clone())
            .unwrap_or_else(|| format!("{}.caf", take_stem(&memo.id, n)));
        memo.takes.push(Take {
            audio,
            raw: take_raw_name(&memo.id, n),
            // the memo's own clock is the closest thing to a truth here; the
            // one place this shows is a field the panel doesn't draw
            created: iso(art.mtime),
            duration_s: 0.0,
        });
    }
}

/// What a memo should be, given what's on disk and the fact that nothing is
/// working on it. `None` means there's nothing here worth keeping.
///
/// All but pure — the one thing it reads is the first line of a `.md`, and
/// only when it has no title from anywhere else — so the whole matrix
/// (crashed mid-recording, crashed mid-transcribe, corrupt json, orphan
/// files, a `.md` deleted by hand) is a table in the tests rather than a
/// guess.
fn reconcile_one(
    dir: &Path,
    stem: &str,
    art: &Artifacts,
    existing: Option<MemoFile>,
) -> Option<MemoFile> {
    let level = art.level();
    if level == 0 {
        // a stub whose recording never produced a byte, or a json alone: the
        // audio is the memo, and there isn't one
        return None;
    }

    let mut memo = match existing {
        Some(memo) => memo,
        None => MemoFile {
            id: stem.to_string(),
            title: art
                .md
                .then(|| md_title(dir, stem))
                .flatten()
                .or_else(|| {
                    (art.raw && art.raw_len < MIN_TRANSCRIPT as u64).then(|| NO_SPEECH.to_string())
                }),
            created: iso(art.mtime),
            duration_s: 0.0,
            status: level_status(level).to_string(),
            audio: art.audio.clone(),
            interrupted: false,
            takes: Vec::new(),
            attempts: Attempts::default(),
            error: None,
        },
    };

    // the filename is the identity; a json that disagrees would have every
    // later write land next to the memo instead of on it
    memo.id = stem.to_string();
    fold_takes(&mut memo, art);

    // An in-flight status with nobody flying it is a crash: fall back to the
    // checkpoint behind it and let auto-advance pick the pipeline up again.
    // Where there are takes the crash is the last take's, and the fallback is
    // that take's — the memo's own outcome finished passes ago and is sitting
    // on disk, so there is never anything behind it to fall back to.
    match memo.status.as_str() {
        RECORDING => match last_take_no(&memo) {
            // A follow-up that captured no bytes is taken back out, files and
            // entry, and the memo goes back to being the finished thing it was
            // before the press. The alternative — leaving it at `recording`, or
            // marching it into a transcribe of an empty file — spends a failure
            // on a document that is perfectly fine.
            Some(n) if !art.takes.get(&n).is_some_and(|t| t.audio.is_some()) => {
                drop_take(dir, &mut memo);
                memo.status = READY.to_string();
            }
            _ => {
                memo.status = RECORDED.to_string();
                memo.interrupted = true;
            }
        },
        TRANSCRIBING => memo.status = RECORDED.to_string(),
        CLEANING => memo.status = TRANSCRIBED.to_string(),
        _ => {}
    }
    // A memo nobody said anything into is finished exactly like this: `ready`,
    // the sentinel title, a raw transcript, and no `.md` — cleanup files it
    // that way rather than spending a call on silence. The files alone can't
    // tell it from a `.md` someone deleted by hand, and the byte count doesn't
    // settle it either: cleanup measures trimmed characters, so "so, um \n\n\n"
    // is ten bytes and six characters and lands here looking like a level 2.
    // The title is what says which it is. Without this exception the demotion
    // below sends it back to `transcribed`, auto-advance re-enqueues cleanup,
    // cleanup's silence path returns before it can increment the attempts that
    // would stop it, and the memo churns for as long as the app is open.
    let silence_is_the_end = memo.status == READY && art.raw && memo.title.as_deref() == Some(NO_SPEECH);

    // A memo that has been iterated on is finished for a different reason than
    // its base stem can show. Its `.md` is the merged current document rather
    // than that first recording's cleanup, and a take's transcript sitting on
    // disk beside the base one is the normal, finished shape — not a memo
    // caught halfway. Demoting it would re-clean the first recording over the
    // top of the document every follow-up went into.
    let iterated = memo.status == READY && !memo.takes.is_empty();

    // never claim more than the files support. Only downwards: a half-written
    // transcript on disk is not a reason to skip transcribing.
    if !silence_is_the_end && !iterated && status_level(&memo.status) > level {
        memo.status = level_status(level).to_string();
    }
    if memo.status == READY && memo.title.is_none() {
        memo.title = art.md.then(|| md_title(dir, stem)).flatten();
    }
    if memo.audio != art.audio {
        memo.audio = art.audio.clone();
    }
    Some(memo)
}

/// Reconcile a whole memos directory, writing back whatever changed.
///
/// `live` names the memos something is currently doing — a recording in
/// progress, a job on the worker — which are the only ones whose in-flight
/// status is telling the truth.
fn reconcile_dir(dir: &Path, live: &HashSet<String>) -> Vec<MemoFile> {
    let mut memos = Vec::new();
    for (stem, art) in scan(dir) {
        let existing = art.json.then(|| load_memo(dir, &stem)).flatten();
        if live.contains(&stem) {
            if let Some(memo) = existing {
                memos.push(memo);
            }
            continue;
        }
        match reconcile_one(dir, &stem, &art, existing.clone()) {
            Some(memo) => {
                if existing.as_ref() != Some(&memo) {
                    if let Err(e) = save_memo(dir, &memo) {
                        println!("[memos] could not repair {stem}.json: {e}");
                    }
                }
                memos.push(memo);
            }
            // only names this program minted are its to sweep — a foreign file
            // that classified as an audioless stub is left exactly where it is
            None if stem_is_ours(&stem) => remove_all(dir, &stem),
            None => {}
        }
    }
    memos
}

// ── commands ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn memo_probe() -> Result<MemoProbe, String> {
    Ok(probe())
}

#[tauri::command]
pub async fn memo_list(
    app: tauri::AppHandle,
    state: tauri::State<'_, MemoManager>,
    root: String,
) -> Result<Vec<Memo>, String> {
    let dir = memos_dir(&root);
    if !dir.is_dir() {
        // listing must never be what creates `.zero/` — that write belongs to
        // pressing record, where it's something the user asked for
        return Ok(Vec::new());
    }
    let shared = state.0.clone();

    let live: HashSet<String> = {
        let st = shared.state.lock().unwrap();
        st.recording
            .iter()
            .filter(|r| r.root == root)
            .map(|r| r.id.clone())
            .chain(st.running.iter().filter(|j| j.root == root).map(|j| j.id.clone()))
            .collect()
    };

    let memos = reconcile_dir(&dir, &live);
    for memo in &memos {
        auto_advance(&shared, &app, &root, memo);
    }

    let mut list: Vec<Memo> = memos
        .iter()
        .map(|m| wire(m, live_of(&shared, &root, &m.id)))
        .collect();
    list.sort_by(|a, b| b.created.cmp(&a.created).then(b.id.cmp(&a.id)));
    Ok(list)
}

/// The stub a fresh memo records into: the directory, the ignore line, the
/// vocabulary, a stem nothing else owns, and a json that says `recording`.
fn begin_memo(app: &tauri::AppHandle, root: &str) -> Result<(PathBuf, MemoFile), String> {
    let dir = create_memos_dir(app, root)?;
    // the vocabulary this recording will be transcribed against, made now so
    // that a project's first derivation from its README runs while the user is
    // still talking and is waiting by the time transcription asks for it. A
    // root that won't take the file is not a reason to refuse a recording.
    let _ = ensure_zero_md(app, root);
    let memo = MemoFile {
        id: new_stem(&dir),
        title: None,
        created: iso(now_secs()),
        duration_s: 0.0,
        status: RECORDING.to_string(),
        audio: None,
        interrupted: false,
        takes: Vec::new(),
        attempts: Attempts::default(),
        error: None,
    };
    save_memo(&dir, &memo)?;
    Ok((dir, memo))
}

/// The same, for a follow-up recorded on top of a memo that already came back.
///
/// Only a finished memo can take one: everything else is either still moving
/// through the pipeline, where a second recording would race the first, or
/// waiting for a person to decide about a failure — and the answer to a failure
/// is the retry, not more words.
///
/// The take is appended before a byte of it exists, because the panel needs its
/// start time to run the timer over a row that is recording. The attempts go
/// back to zero for both stages at the same moment: that guard exists to stop
/// the machine retrying the same broken run, and this is a new run.
fn begin_take(app: &tauri::AppHandle, root: &str, id: &str) -> Result<(PathBuf, MemoFile), String> {
    if !valid_id(id) {
        return Err("not a memo id".into());
    }
    let dir = memos_dir(root);
    let mut memo = load_memo(&dir, id).ok_or("no such memo")?;
    if memo.status != READY {
        return Err(format!("can only re-record a finished memo — this one is {}", memo.status));
    }
    let _ = ensure_zero_md(app, root);

    let n = take_no(memo.takes.len());
    memo.takes.push(Take {
        // the caf is what the helper opens; the stopped event says what it
        // finally became, exactly as it does for a memo's first recording
        audio: format!("{}.caf", take_stem(id, n)),
        raw: take_raw_name(id, n),
        created: iso(now_secs()),
        duration_s: 0.0,
    });
    memo.attempts = Attempts::default();
    memo.status = RECORDING.to_string();
    memo.error = None;
    save_memo(&dir, &memo)?;
    Ok((dir, memo))
}

/// Undo a start that never became a recording.
///
/// A memo of its own leaves nothing behind — there was no memo a moment ago and
/// there is none now. A take takes only itself out, and the finished memo it
/// was recorded onto is put back exactly as it was found: it was never at risk,
/// and a press that failed must not be the thing that changes it.
fn unwind_start(dir: &Path, id: &str, take: bool) {
    if !take {
        remove_all(dir, id);
        return;
    }
    let Some(mut memo) = load_memo(dir, id) else { return };
    drop_take(dir, &mut memo);
    memo.status = READY.to_string();
    let _ = save_memo(dir, &memo);
}

// ── importing a file ─────────────────────────────────────────────────────────

/// The system's audio converter and its info tool. Absolute for the reason
/// `/bin/date` is above: a GUI app's PATH is not a promise, and both ship with
/// every macOS.
const AFCONVERT: &str = "/usr/bin/afconvert";
const AFINFO: &str = "/usr/bin/afinfo";

/// Bring an audio file recorded somewhere else into the memos directory as
/// `<stem>.m4a` — which is the whole trick of importing: once the file wears
/// the name and container a recording ends in, every contract downstream
/// (the scan, the sweep, the transcribe job, the thread's playback path) holds
/// without knowing the mic was never involved.
///
/// An m4a is copied as it is; everything else goes through `afconvert`, which
/// reads what Core Audio reads — wav, mp3, aiff, caf, flac — and is also the
/// gate: a file that isn't audio fails here, at the press, with the converter's
/// reason, rather than three stages later as a transcription mystery. Either
/// way the bytes land under the `.part` scratch name and are renamed only once
/// whole — the helper's own kill-safe encode, and the same dust `remove_all`
/// already sweeps. The source file is read and never touched.
fn import_audio(src: &Path, m4a: &Path) -> Result<(), String> {
    let name = m4a.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let part = m4a.with_file_name(format!("{name}.part"));
    let keep = src.extension().is_some_and(|e| e.eq_ignore_ascii_case("m4a"));
    if keep {
        std::fs::copy(src, &part).map_err(|e| format!("could not copy the file: {e}"))?;
    } else {
        // the helper's own encode settings: AAC, 64 kbps — speech, not mastering
        let converted = Command::new(AFCONVERT)
            .args(["-f", "m4af", "-d", "aac", "-b", "64000"])
            .arg(src)
            .arg(&part)
            .output()
            .map_err(|e| format!("could not run the audio converter: {e}"))?;
        if !converted.status.success() {
            let _ = std::fs::remove_file(&part);
            // afconvert says why on stderr, prefixed "Error:", which the
            // sentence below already says; a converter that said nothing
            // still owes the person one
            let said = String::from_utf8_lossy(&converted.stderr);
            let why = first_lines(&said, 1).trim_start_matches("Error:").trim().to_string();
            return Err(if why.is_empty() {
                "the file could not be read as audio".to_string()
            } else {
                format!("the file could not be read as audio — {why}")
            });
        }
    }
    std::fs::rename(&part, m4a).map_err(|e| {
        let _ = std::fs::remove_file(&part);
        e.to_string()
    })
}

/// How long an audio file plays for, in seconds, by asking `afinfo`. Zero when
/// it won't say — the length a memo wears until its recording ends, and the
/// panel already omits a zero rather than drawing it.
fn audio_duration(path: &Path) -> f64 {
    let Ok(out) = Command::new(AFINFO).arg(path).output() else { return 0.0 };
    parse_afinfo_duration(&String::from_utf8_lossy(&out.stdout))
}

/// `estimated duration: 2.320000 sec` → 2.32, out of everything else afinfo
/// prints. Its own function so the test can hold the parse to the real output.
fn parse_afinfo_duration(text: &str) -> f64 {
    text.lines()
        .find_map(|l| l.trim().strip_prefix("estimated duration:"))
        .and_then(|rest| rest.trim().strip_suffix("sec"))
        .and_then(|n| n.trim().parse::<f64>().ok())
        .filter(|d| d.is_finite() && *d >= 0.0)
        .unwrap_or(0.0)
}

/// Bring a recording made somewhere else into the pipeline — as a memo of its
/// own, or as a follow-up onto the finished memo `into` names.
///
/// The file is converted into place, written down as `recorded`, and from that
/// checkpoint on it is a recording like any other: the same transcribe, the
/// same cleanup or merge, the same retries from the same checkpoints. The mic
/// is never involved, so nothing here asks whether it is free — a memo can be
/// imported while another project is mid-ramble.
///
/// Resolves with the memo's id, exactly as `memo_record_start` does, so the
/// frontend's follow machinery lights the row and opens the thread when it
/// comes back without learning a second shape.
#[tauri::command]
pub async fn memo_import(
    app: tauri::AppHandle,
    state: tauri::State<'_, MemoManager>,
    root: String,
    path: String,
    into: Option<String>,
) -> Result<String, String> {
    // same gate as pressing record: an import ends in the same transcriber
    let probe = probe();
    if !probe.supported {
        return Err(probe.message.unwrap_or_else(|| NEEDS_MACOS_26.to_string()));
    }
    let src = PathBuf::from(&path);
    if !src.is_absolute() || !src.is_file() {
        return Err("that isn't a file".into());
    }
    if std::fs::metadata(&src).map(|m| m.len()).unwrap_or(0) == 0 {
        return Err("that file is empty — there is nothing to transcribe".into());
    }
    let shared = state.0.clone();

    match into {
        // a memo of its own: the same first write pressing record makes — the
        // directory, the ignore line, the vocabulary — with the file where the
        // recording would have ended up
        None => {
            let dir = create_memos_dir(&app, &root)?;
            let _ = ensure_zero_md(&app, &root);
            let id = new_stem(&dir);
            let audio = format!("{id}.m4a");
            import_audio(&src, &dir.join(&audio))?;
            let memo = MemoFile {
                id: id.clone(),
                title: None,
                created: iso(now_secs()),
                duration_s: audio_duration(&dir.join(&audio)),
                status: RECORDED.to_string(),
                audio: Some(audio),
                interrupted: false,
                takes: Vec::new(),
                attempts: Attempts::default(),
                error: None,
            };
            publish(&app, &shared, &root, &dir, &memo);
            auto_advance(&shared, &app, &root, &memo);
            Ok(id)
        }
        // a follow-up: `begin_take`'s rules — only a finished memo takes one,
        // and the attempts reset because this is a new run — with the take
        // appended after its audio is safely in place rather than before,
        // since there is no helper filling the file whose start needs
        // announcing, and a conversion that fails must leave the memo exactly
        // the finished thing it was.
        Some(id) => {
            if !valid_id(&id) {
                return Err("not a memo id".into());
            }
            let dir = memos_dir(&root);
            let mut memo = load_memo(&dir, &id).ok_or("no such memo")?;
            if memo.status != READY {
                return Err(format!(
                    "can only add to a finished memo — this one is {}",
                    memo.status
                ));
            }
            let _ = ensure_zero_md(&app, &root);
            let n = take_no(memo.takes.len());
            let audio = format!("{}.m4a", take_stem(&id, n));
            import_audio(&src, &dir.join(&audio))?;
            let duration_s = audio_duration(&dir.join(&audio));
            memo.takes.push(Take {
                audio,
                raw: take_raw_name(&id, n),
                created: iso(now_secs()),
                duration_s,
            });
            memo.attempts = Attempts::default();
            memo.status = RECORDED.to_string();
            memo.error = None;
            publish(&app, &shared, &root, &dir, &memo);
            auto_advance(&shared, &app, &root, &memo);
            Ok(id)
        }
    }
}

/// Start recording — a memo of its own, or a follow-up onto `into`.
///
/// `into` names the finished memo this recording revises, when it revises one;
/// the frontend always sends the key, null and all, so nothing here depends on
/// a missing argument meaning anything.
///
/// Both paths meet at the claim below and are the same recording from there on:
/// one mic, one reader thread, one set of events, and a take number that only
/// changes which files the bytes land in.
#[tauri::command]
pub async fn memo_record_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, MemoManager>,
    root: String,
    into: Option<String>,
) -> Result<String, String> {
    let probe = probe();
    if !probe.supported {
        return Err(probe.message.unwrap_or_else(|| NEEDS_MACOS_26.to_string()));
    }
    let shared = state.0.clone();

    // Claim, then work, then claim again. The mic is one resource, so two
    // presses must never both decide it's free — but the work in between is
    // `git check-ignore` run to completion, a rewritten `.gitignore`, a ZERO.md
    // and the thread that fills it in, a stat per candidate stem and a json,
    // and holding the state lock across all of that stops every other memo
    // command and every worker publish for as long as git takes. So the lock is
    // taken twice: once to see the mic free, once to install the recording.
    // Only the second decides, and a press that loses the race there takes its
    // own stub files back out.
    if let Some(current) = &shared.state.lock().unwrap().recording {
        return Err(format!("already recording in {}", project_name(&current.root)));
    }

    // A take is a number and nothing else from here down: the same files under
    // a longer stem, the same reader, the same events.
    let (dir, memo, take) = match &into {
        Some(id) => {
            let (dir, memo) = begin_take(&app, &root, id)?;
            let n = last_take_no(&memo);
            (dir, memo, n)
        }
        None => {
            let (dir, memo) = begin_memo(&app, &root)?;
            (dir, memo, None)
        }
    };
    let id = memo.id.clone();
    let stem = match take {
        Some(n) => take_stem(&id, n),
        None => id.clone(),
    };

    let first_rx = {
        let mut st = shared.state.lock().unwrap();
        // the other press got here first; this one leaves no trace behind
        if let Some(current) = &st.recording {
            let message = format!("already recording in {}", project_name(&current.root));
            unwind_start(&dir, &id, take.is_some());
            return Err(message);
        }

        let request = serde_json::json!({ "out": dir.join(format!("{stem}.caf")).to_string_lossy() });
        let mut child = match helper_spawn("record", &request) {
            Ok(child) => child,
            Err(e) => {
                unwind_start(&dir, &id, take.is_some());
                return Err(e);
            }
        };
        let stdout = match child.stdout.take() {
            Some(stdout) => stdout,
            None => {
                let _ = child.kill();
                let _ = child.wait();
                unwind_start(&dir, &id, take.is_some());
                return Err("recorder has no stdout".into());
            }
        };
        let stdin = child.stdin.take();
        let slot: Arc<ChildSlot> = Arc::new(Mutex::new(Some(child)));

        let (first_tx, first_rx) = mpsc::channel::<Result<(), String>>();
        let reader = RecordReader {
            app: app.clone(),
            shared: shared.clone(),
            root: root.clone(),
            id: id.clone(),
            take,
            dir: dir.clone(),
            slot: slot.clone(),
        };
        std::thread::spawn(move || reader.run(stdout, first_tx));

        let started = now_secs();
        st.recording = Some(Recording {
            root: root.clone(),
            id: id.clone(),
            stdin,
            child: slot,
            paused: false,
            since: started,
            recorded: 0,
        });
        let _ = app.emit(
            "memo-update",
            UpdateEvent {
                root: root.clone(),
                // assembled by hand rather than through `live_of`, which would
                // want the lock this is still holding — and both answers are
                // right here anyway: nothing is queued, and a recording one
                // line old has been running since it started.
                memo: wire(&memo, Live { queued: false, since: Some(started), paused: false }),
            },
        );
        first_rx
    };

    // outside the lock: a helper waiting on a permission prompt can take as
    // long as the person does, and nothing else should wait with it.
    // A failure this early never captured anything — the reader thread has
    // already taken the stub away, and this is the command's error to report
    // rather than a memo that went wrong.
    match first_rx.recv_timeout(START_GRACE) {
        Ok(Err(message)) => Err(message),
        _ => Ok(id),
    }
}

/// The reader thread for one recording: helper NDJSON in, Tauri events and a
/// memo.json out.
struct RecordReader {
    app: tauri::AppHandle,
    shared: Arc<Shared>,
    root: String,
    id: String,
    /// which recording of this memo it is: `None` for the first, the take
    /// number for a follow-up. The only thing that differs between them here is
    /// where the bytes and the duration are written down.
    take: Option<usize>,
    dir: PathBuf,
    slot: Arc<ChildSlot>,
}

impl RecordReader {
    fn run(self, stdout: std::process::ChildStdout, first: mpsc::Sender<Result<(), String>>) {
        let mut first = Some(first);
        let mut last_level = Instant::now() - LEVEL_INTERVAL;
        let mut finished = false;

        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            let Ok(event) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
            match event["event"].as_str() {
                Some("recording") => {
                    if let Some(tx) = first.take() {
                        let _ = tx.send(Ok(()));
                    }
                }
                Some("level") => {
                    if last_level.elapsed() >= LEVEL_INTERVAL {
                        last_level = Instant::now();
                        let rms = event["rms"].as_f64().unwrap_or(0.0);
                        let _ = self.app.emit(
                            "memo-level",
                            LevelEvent { root: self.root.clone(), rms },
                        );
                    }
                }
                Some("paused") => self.holding(true),
                Some("resumed") => self.holding(false),
                Some("stopped") => {
                    self.stopped(&event);
                    finished = true;
                }
                // the helper threw the audio away and said so; there is nothing
                // left on disk for the loop to resolve at EOF
                Some("cancelled") => {
                    self.cancelled();
                    finished = true;
                }
                Some("error") => {
                    let message = event_message(&event, "recording failed");
                    self.failed(&mut first, &message);
                    finished = true;
                }
                _ => {}
            }
        }

        // stdout closed. If nothing decisive came through it, the helper died
        // on the way up and the memo has to be resolved from its files.
        if !finished {
            if self.disowned() {
                // Deleting a live recording kills the child and removes the
                // files, and this is the thread that then wakes at EOF with
                // nothing decisive read. Left to itself it would write the
                // json straight back — the memo returns from the dead, auto-
                // advance queues a transcribe of audio that no longer exists,
                // and it reappears as `transcribe_failed` — or, in the commoner
                // ordering, it announces that the recorder captured nothing
                // about a memo the user threw away on purpose. Same rule as
                // `JobCtx::gone` on the queue side: nothing is written for a
                // memo that was deleted while its work was still running.
            } else if self.audio_on_disk().is_some() {
                self.interrupted();
            } else {
                self.failed(&mut first, "the recorder stopped before it captured anything");
            }
        }
        // still ours to reap either way: `memo_delete` kills the child but
        // leaves the collecting to whoever was reading it
        self.release();
    }

    /// Has someone taken the mic off the books under us? `memo_record_stop`
    /// only closes the pipe and leaves the slot alone, and `release` runs after
    /// this — so the one thing that clears it while this thread is still
    /// reading is a delete of the memo being recorded.
    fn disowned(&self) -> bool {
        let st = self.shared.state.lock().unwrap();
        !st.recording.as_ref().is_some_and(|r| r.id == self.id)
    }

    /// Take the recorder off the books and collect it. Never killed: on quit
    /// the app's death closes its stdin, the helper reads EOF and finalises
    /// itself, which is the whole reason stop is a pipe and not a signal.
    fn release(&self) {
        let mut st = self.shared.state.lock().unwrap();
        if st.recording.as_ref().is_some_and(|r| r.id == self.id) {
            st.recording = None;
        }
        drop(st);
        let child = self.slot.lock().unwrap().take();
        if let Some(mut child) = child {
            let _ = child.wait();
        }
    }

    /// The stem this recording's own files wear: the memo's for a first
    /// recording, the numbered one for a take.
    fn stem(&self) -> String {
        match self.take {
            Some(n) => take_stem(&self.id, n),
            None => self.id.clone(),
        }
    }

    fn audio_on_disk(&self) -> Option<String> {
        let stem = self.stem();
        ["m4a", "caf"].iter().find_map(|ext| {
            let name = format!("{stem}.{ext}");
            let big_enough = std::fs::metadata(self.dir.join(&name)).is_ok_and(|m| m.len() > 0);
            big_enough.then_some(name)
        })
    }

    /// Write down what this recording turned out to be — its audio and its
    /// length — on the memo or on the take, and hand the pipeline the same
    /// `recorded` either way.
    fn landed(&self, memo: &mut MemoFile, audio: Option<String>, duration: Option<f64>) {
        match self.take {
            Some(n) => {
                // the take this thread was started for, and only that one
                if last_take_no(memo) != Some(n) {
                    return;
                }
                let Some(take) = memo.takes.last_mut() else { return };
                if let Some(audio) = audio {
                    take.audio = audio;
                }
                take.duration_s = duration.unwrap_or(take.duration_s);
                // the memo's own `duration_s` stays the length of the recording
                // that made it, which is what its row has always shown
            }
            None => {
                memo.audio = audio;
                memo.duration_s = duration.unwrap_or(memo.duration_s);
            }
        }
        memo.status = RECORDED.to_string();
    }

    /// The mic stopped, or started again.
    ///
    /// Nothing on disk changes: the memo is still `recording` and still this
    /// recording, and the audio is still one file the helper has open. What
    /// changes is the moment the panel's timer counts from, so this is the
    /// bookkeeping and then a publish — the row has to hear that its clock is
    /// standing still, and it has no other way to.
    fn holding(&self, paused: bool) {
        {
            let mut st = self.shared.state.lock().unwrap();
            // the disown guard, spelled as the lookup it already needs: a
            // recording that is no longer on the books was deleted out from
            // under us and has no timer left to keep
            let Some(recording) = st.recording.as_mut().filter(|r| r.id == self.id) else {
                return;
            };
            match paused {
                true => recording.pause(now_secs()),
                false => recording.resume(now_secs()),
            }
        }
        // and outside that lock, because publishing takes it again to ask what
        // was just written here
        let Some(memo) = load_memo(&self.dir, &self.id) else { return };
        publish(&self.app, &self.shared, &self.root, &self.dir, &memo);
    }

    fn stopped(&self, event: &serde_json::Value) {
        // the same disown guard as `cancelled`, for the same race: a delete
        // that landed between the stop and this event already took the files,
        // and writing the memo back would raise it from the dead
        if self.disowned() {
            return;
        }
        let Some(mut memo) = load_memo(&self.dir, &self.id) else { return };
        let audio = event["audio"]
            .as_str()
            .and_then(|p| Path::new(p).file_name().map(|n| n.to_string_lossy().to_string()))
            .or_else(|| self.audio_on_disk());
        self.landed(&mut memo, audio, event["duration_s"].as_f64());
        memo.error = None;
        publish(&self.app, &self.shared, &self.root, &self.dir, &memo);
        auto_advance(&self.shared, &self.app, &self.root, &memo);
    }

    /// The helper vanished with audio already on disk — a crash, a force-quit,
    /// a disk that filled. Whatever landed is still a memo.
    fn interrupted(&self) {
        let Some(mut memo) = load_memo(&self.dir, &self.id) else { return };
        let audio = self.audio_on_disk();
        self.landed(&mut memo, audio, None);
        memo.interrupted = true;
        publish(&self.app, &self.shared, &self.root, &self.dir, &memo);
        auto_advance(&self.shared, &self.app, &self.root, &memo);
    }

    /// Take this recording back out again — the stub memo it was starting, or
    /// the take it was adding to a finished one.
    ///
    /// A memo of its own leaves nothing behind: there was no memo a minute ago
    /// and there is none now, so there is no row to publish and the panel
    /// re-lists rather than being told about one that never existed.
    ///
    /// For a take there *is* a memo to keep, and it is the one that was on
    /// screen before the press: the take goes, the document stays, and the row
    /// is published back to `ready` so it stops claiming to be recording. Every
    /// path that abandons a recording comes through here, so a cancel and a
    /// microphone that never opened leave the directory in exactly the same
    /// state — the difference between them is only whether anybody is told why.
    fn unwind(&self) {
        match self.take {
            Some(_) => {
                if let Some(mut memo) = load_memo(&self.dir, &self.id) {
                    drop_take(&self.dir, &mut memo);
                    memo.status = READY.to_string();
                    publish(&self.app, &self.shared, &self.root, &self.dir, &memo);
                }
            }
            None => remove_all(&self.dir, &self.id),
        }
    }

    /// No audio at all: a denied microphone, a missing device. There's no
    /// recording to keep, so it is taken back out and the reason is reported —
    /// to the command if it's still waiting, and to the panel as a notice if it
    /// isn't.
    fn failed(&self, first: &mut Option<mpsc::Sender<Result<(), String>>>, message: &str) {
        self.unwind();
        let told = match first.take() {
            Some(tx) => tx.send(Err(message.to_string())).is_ok(),
            None => false,
        };
        if !told {
            notice(&self.app, &self.root, message);
        }
    }

    /// The recording was thrown away on purpose: the helper has already deleted
    /// the audio and said so, which leaves nothing on disk to keep, to convert,
    /// or for reconciliation to find later and rebuild a memo out of.
    ///
    /// The same retreat as a recording that captured nothing, minus the part
    /// where somebody is told why — they know, they asked. And the same disown
    /// guard as every other path that resolves a recording nobody finished: a
    /// delete that landed between the verb and the event has taken the files
    /// already, and writing the memo back here would raise it from the dead
    /// exactly as it would at EOF.
    fn cancelled(&self) {
        if self.disowned() {
            return;
        }
        self.unwind();
    }
}

#[tauri::command]
pub async fn memo_record_stop(state: tauri::State<'_, MemoManager>) -> Result<(), String> {
    let shared = state.0.clone();
    let mut st = shared.state.lock().unwrap();
    let Some(recording) = st.recording.as_mut() else {
        // stop is a button, and a button can be pressed twice
        return Ok(());
    };
    // dropped as well as written to: the helper treats the word and the EOF
    // identically, so this way one of them always gets through
    if let Some(mut stdin) = recording.stdin.take() {
        let _ = stdin.write_all(b"stop\n");
        let _ = stdin.flush();
    }
    Ok(())
}

/// One transport verb into the helper's stdin, for the one recording there is.
///
/// Global like [`memo_record_stop`] and for the same reason: the mic is a
/// single resource, so there is never a question about which recording is
/// meant, and a panel that has to name one would only be able to name this one.
/// Unlike stop, the pipe is left open — the helper reads EOF as "finalise what
/// you have", which is the opposite of what two of these three words mean, and
/// the third gets its answer back as an event rather than as a closed pipe.
fn tell_recorder(shared: &Shared, verb: &str) -> Result<(), String> {
    let mut st = shared.state.lock().unwrap();
    // no stdin left means stop already took it: the mic is off and the audio is
    // being finalised, which from here is the same as there being nothing to
    // talk to
    let stdin = st
        .recording
        .as_mut()
        .and_then(|r| r.stdin.as_mut())
        .ok_or("nothing is recording")?;
    stdin
        .write_all(format!("{verb}\n").as_bytes())
        .and_then(|()| stdin.flush())
        .map_err(|e| e.to_string())
}

/// Hold the recording where it is. The mic stops, the file stays open, and the
/// pause costs the memo's duration nothing — the helper counts frames, and a
/// paused mic writes none.
///
/// The bookkeeping behind the panel's timer is not done here but in the reader,
/// when the helper's `paused` comes back. A verb that was sent is not a mic
/// that stopped, and the timer follows what actually happened.
#[tauri::command]
pub async fn memo_record_pause(state: tauri::State<'_, MemoManager>) -> Result<(), String> {
    let shared = state.0.clone();
    tell_recorder(&shared, "pause")
}

/// Carry on into the same file, where the last buffer left off.
#[tauri::command]
pub async fn memo_record_resume(state: tauri::State<'_, MemoManager>) -> Result<(), String> {
    let shared = state.0.clone();
    tell_recorder(&shared, "resume")
}

/// Throw the recording away: no audio, no memo, no row — the state the project
/// was in before the press. The helper deletes what it wrote and answers with
/// `cancelled`, and the reader takes the stub or the take back out from there;
/// nothing is removed here, because the audio is the helper's to delete while
/// it still has the file open.
#[tauri::command]
pub async fn memo_record_cancel(state: tauri::State<'_, MemoManager>) -> Result<(), String> {
    let shared = state.0.clone();
    tell_recorder(&shared, "cancel")
}

#[tauri::command]
pub async fn memo_retry(
    app: tauri::AppHandle,
    state: tauri::State<'_, MemoManager>,
    root: String,
    id: String,
) -> Result<(), String> {
    if !valid_id(&id) {
        return Err("not a memo id".into());
    }
    let dir = memos_dir(&root);
    let mut memo = load_memo(&dir, &id).ok_or("no such memo")?;
    let shared = state.0.clone();

    // exactly the stage that failed, from the checkpoint it failed at. Asked
    // for by a person, so the attempts guard doesn't apply — that guard is
    // there to stop the machine retrying, not you.
    let stage = match memo.status.as_str() {
        TRANSCRIBE_FAILED | RECORDED => {
            memo.status = RECORDED.to_string();
            Stage::Transcribe
        }
        CLEANUP_FAILED | TRANSCRIBED => {
            memo.status = TRANSCRIBED.to_string();
            Stage::Cleanup
        }
        other => return Err(format!("nothing to retry — this memo is {other}")),
    };
    memo.error = None;
    // the checkpoint has to be on disk before the worker can pop the job: it
    // reads the status back to decide whether the job is still wanted
    save_memo(&dir, &memo)?;
    enqueue(&shared, &app, &root, &id, stage);
    publish(&app, &shared, &root, &dir, &memo);
    Ok(())
}

#[tauri::command]
pub async fn memo_delete(
    state: tauri::State<'_, MemoManager>,
    root: String,
    id: String,
) -> Result<(), String> {
    if !valid_id(&id) {
        return Err("not a memo id".into());
    }
    let shared = state.0.clone();
    {
        let mut st = shared.state.lock().unwrap();
        st.queue.retain(|j| !(j.root == root && j.id == id));

        // a job that's already running gets its child killed and its writes
        // disowned, so it can't put the json back after we remove it
        if let Some(job) = st.running.as_ref().filter(|j| j.root == root && j.id == id) {
            job.cancelled.store(true, Ordering::Relaxed);
            if let Some(child) = job.child.lock().unwrap().as_mut() {
                let _ = child.kill();
            }
        }
        // deleting the recording in progress: killed rather than stopped,
        // because there's no point finalising audio we're about to remove
        if st.recording.as_ref().is_some_and(|r| r.root == root && r.id == id) {
            if let Some(recording) = st.recording.take() {
                drop(recording.stdin);
                if let Some(child) = recording.child.lock().unwrap().as_mut() {
                    let _ = child.kill();
                }
            }
        }
    }
    remove_all(&memos_dir(&root), &id);
    Ok(())
}

/// The panel's ZERO.md link: the file, made if it isn't there, as a path the
/// editor can open. Creating it here writes no `.zero/` and no `.gitignore`
/// line — opening your own project's setup file is not the same event as
/// recording into it.
#[tauri::command]
pub async fn memo_vocabulary_path(app: tauri::AppHandle, root: String) -> Result<String, String> {
    Ok(ensure_zero_md(&app, &root)?.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("zero-memos-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(dir: &Path, name: &str, body: &str) {
        std::fs::write(dir.join(name), body).unwrap();
    }

    fn memo(id: &str, status: &str) -> MemoFile {
        MemoFile {
            id: id.to_string(),
            title: None,
            created: "2026-08-13T14:32:11Z".to_string(),
            duration_s: 12.0,
            status: status.to_string(),
            audio: Some(format!("{id}.m4a")),
            interrupted: false,
            takes: Vec::new(),
            attempts: Attempts::default(),
            error: None,
        }
    }

    /// A memo with `n` follow-ups recorded on top of it, each with the files it
    /// would have on disk by the time it was finished with.
    fn with_takes(id: &str, status: &str, n: usize) -> MemoFile {
        let mut memo = memo(id, status);
        for i in 0..n {
            let take = take_no(i);
            memo.takes.push(Take {
                audio: format!("{}.m4a", take_stem(id, take)),
                raw: take_raw_name(id, take),
                created: "2026-08-13T15:02:44Z".to_string(),
                duration_s: 7.0,
            });
        }
        memo
    }

    /// The names are keys: they have to be sortable, unique, and readable by
    /// the person whose clock they were made on.
    #[test]
    fn stems_and_timestamps_are_the_pinned_shape() {
        // 2026-08-13T14:32:11Z, the example the contract is written around
        assert_eq!(iso(1_786_631_531), "2026-08-13T14:32:11Z");
        assert_eq!(stamp(1_786_631_531), "2026-08-13-1432");
        // and the edges the civil-date arithmetic is easy to get wrong at
        assert_eq!(iso(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso(1_000_000_000), "2001-09-09T01:46:40Z");
        assert_eq!(iso(4_102_444_800), "2100-01-01T00:00:00Z");

        assert_eq!(parse_offset("+0200"), 7200);
        assert_eq!(parse_offset("-0530"), -19_800);
        assert_eq!(parse_offset("nonsense"), 0, "a broken offset is UTC, not a panic");

        let dir = temp("stem");
        let stem = new_stem(&dir);
        let (front, hex) = stem.rsplit_once('-').unwrap();
        assert_eq!(front.len(), 15, "YYYY-MM-DD-HHMM: {stem}");
        assert_eq!(hex.len(), 4);
        assert!(
            hex.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
            "four lowercase hex: {stem}"
        );
        // a stem already taken is not handed out again
        write(&dir, &format!("{stem}.json"), "{}");
        assert_ne!(new_stem(&dir), stem);
        // two stems minted in the same clock tick still differ — the counter's
        // whole job
        assert_ne!(hex4(), hex4());

        // what the sweep recognises as a name of ours: exactly what new_stem
        // mints, and none of the things a person would call their own files
        assert!(stem_is_ours(&stem));
        assert!(stem_is_ours("2026-08-13-1432-ab12"));
        for foreign in ["notes", "stub-empty", "2026-08-13-1432-ab1", "2026-08-13-1432-ab123", "aaaa-bb-cc-ddee-ffff"] {
            assert!(!stem_is_ours(foreign), "{foreign} is not a minted name");
        }

        // ids come back over IPC and become filenames, so retry and delete
        // check them rather than believing them
        assert!(valid_id(&stem));
        for bad in ["", "../../etc/passwd", "a/b", "a.json", &"x".repeat(41)] {
            assert!(!valid_id(bad), "{bad} should never reach a path");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The one line of afinfo an import reads, held to afinfo's real output —
    /// and to the silences and nonsense a system tool is allowed to produce,
    /// all of which are a zero, which the panel draws as nothing.
    #[test]
    fn afinfo_duration_parses_the_real_output_and_nothing_else() {
        let real = "Data format:     1 ch,  22050 Hz, aac\nestimated duration: 2.320000 sec\nformat list:\n";
        assert_eq!(parse_afinfo_duration(real), 2.32);
        assert_eq!(parse_afinfo_duration("estimated duration: 901.5 sec"), 901.5);
        for silent in ["", "no duration here", "estimated duration: sec", "estimated duration: -3 sec", "estimated duration: inf sec"] {
            assert_eq!(parse_afinfo_duration(silent), 0.0, "{silent:?} is not a length");
        }
    }

    /// The file is edited by hand, in a text editor, by someone mid-thought.
    /// Nothing they can type may break the pipeline — the worst outcome
    /// allowed is that a line simply isn't a term.
    #[test]
    fn vocabulary_takes_terms_and_survives_anything() {
        let body = "\
<!-- a comment mentioning \"- Term — notes\" -->
- TRMNL — pronounced \"terminal\"; misheard as: terminal.
- zero - this project's name, lowercase word.
- Anthropic
-  spaced  — leading and trailing space around the term
- TRMNL — a second line for the same term
locale: de-DE
-not-an-entry, no space after the dash
-
* bullets of another kind
plain prose, which is fine";
        let vocab = parse_vocabulary(body);

        assert_eq!(
            vocab.terms,
            vec!["TRMNL", "zero", "Anthropic", "spaced"],
            "em dash, hyphen, bare term, trimmed — and deduped"
        );
        assert_eq!(vocab.locale, "de-DE");
        assert_eq!(vocab.body, body, "the prompt gets the file, not the parse");

        // the default when nobody says otherwise, and the seed parses as one
        let seed = vocabulary_seed("zero");
        let seeded = parse_vocabulary(&seed);
        assert_eq!(seeded.locale, DEFAULT_LOCALE);
        assert_eq!(seeded.terms, vec!["zero"], "the comment block is not a term");
        // and the header introduces the file it is at the top of
        assert!(seed.starts_with("<!-- ZERO.md — zero's setup file for this project"));
        assert!(seed.contains("Meant to be committed"));

        // a malformed locale is ignored rather than passed to the recogniser
        assert_eq!(parse_vocabulary("locale: ").locale, DEFAULT_LOCALE);
        assert_eq!(parse_vocabulary("locale: en US!").locale, DEFAULT_LOCALE);

        // the caps, both of them
        let long = format!("- {}\n", "x".repeat(65));
        assert!(parse_vocabulary(&long).terms.is_empty(), "64 characters is not a proper noun");
        let many: String = (0..250).map(|i| format!("- term{i}\n")).collect();
        assert_eq!(parse_vocabulary(&many).terms.len(), MAX_TERMS);
    }

    /// The prompt is the feature: it is the only thing that knows this project
    /// is called zero, and the only layer that can fix a mishearing which is
    /// also a real word. It comes in two halves — the system prompt, which is
    /// the instructions and then the vocabulary, and the message, which is the
    /// transcript — so each is held to its own shape, and the seam between
    /// them to the blob it replaced.
    #[test]
    fn prompt_carries_the_vocabulary_and_the_transcript() {
        let prompt = cleanup_prompt("- TRMNL — misheard as: terminal", "so the terminal firmware");
        let system = prompt.system();

        assert!(system.starts_with(
            "Clean up the voice-memo transcript in the message's `## Transcript` section.\n"
        ));
        assert!(system.contains("not blind find-and-replace"));
        // the distillation contract: self-corrections resolve to where they landed
        assert!(system.contains("keep only the final position"));
        assert!(system.contains("mark it [unclear]"));
        assert!(system.contains("3–6 word title"));
        // the trailing section: what cleanup noticed and the vocabulary lacks
        assert!(system.contains("Write a line containing exactly `---vocabulary---`"));
        assert!(system.contains("Ordinary dictionary words are never vocabulary"));
        assert!(system.contains("no marker, no empty section"));
        // the instructions name the sections rather than pointing at them — and
        // the one they call "below" is below, at the end of the same text
        assert!(system.contains("`## Project vocabulary` section below"));
        assert!(system.contains("`## Transcript` section"));
        assert!(
            system.ends_with(&format!("{VOCABULARY_TRAILER}\n\n## Project vocabulary\n\n- TRMNL — misheard as: terminal")),
            "the vocabulary is the last section of the system prompt, after the trailer"
        );
        // the vocabulary section always exists, even empty, so the model is
        // never left guessing whether one was meant to be there
        assert!(cleanup_prompt("   ", "hello").system().ends_with("## Project vocabulary\n\n(none provided)"));

        // the message is the transcript under its heading, and only that
        assert_eq!(prompt.message, "## Transcript\n\nso the terminal firmware\n");
        // and the transcript is nowhere in the half that travels on argv
        assert!(!system.contains("terminal firmware"));

        // the fallback blob is the two halves and nothing else, in the order
        // they were always in: the instructions, the vocabulary, the transcript
        let combined = prompt.combined();
        assert!(combined.starts_with(&system));
        assert!(combined.ends_with(&prompt.message));
        assert_eq!(combined, format!("{system}\n\n{}", prompt.message));
        assert!(combined.contains("## Project vocabulary\n\n- TRMNL — misheard as: terminal\n\n## Transcript\n\n"));

        assert_eq!(title_from_md("# Voice memos in zero\n\nbody").as_deref(), Some("Voice memos in zero"));
        assert_eq!(title_from_md("\n\n#  spaced  \n").as_deref(), Some("spaced"));
        assert_eq!(title_from_md("   \n"), None);
    }

    /// The merge is the whole of iterating: a document, a follow-up, and one
    /// pass that has to come back with the document as it now stands. What it
    /// must never come back with is a diff, a summary of the changes, or the
    /// follow-up on its own.
    #[test]
    fn merge_prompt_asks_for_the_document_as_it_now_stands() {
        let prompt = merge_prompt(
            "- TRMNL — misheard as: terminal",
            "# The panel\n\n- one row per memo\n\nOpen: where the button goes.",
            "actually put the button at the bottom",
        );
        let system = prompt.system();

        assert!(system.starts_with("Revise the current document with the follow-up voice memo"));
        // the follow-up is a spec, and it outranks what it was recorded onto
        assert!(system.contains("The follow-up is a spec for revising the document"));
        assert!(system.contains("Where it conflicts with the document, the follow-up wins"));
        assert!(system.contains("resolve the document's open questions"));
        // and it is a ramble too, so it gets the ramble rule
        assert!(system.contains("only its final positions count"));
        // the output is the whole thing, not the difference
        assert!(system.contains("not a delta, not a changelog, not commentary on what changed"));
        assert!(system.contains("currently in force"));
        assert!(system.contains("Do not add content that is in neither the document nor the follow-up"));
        assert!(system.contains("Keep the existing title unless the subject has genuinely moved"));
        assert!(system.contains("mark it [unclear]"));
        // it says which section is which by name, since it can't point
        assert!(system.contains("`## Current document` section is the document distilled from this memo so far"));
        assert!(system.contains("`## Follow-up transcript` is the transcript of a follow-up recording"));

        // both halves are in the message, under headings that say which is
        // which; the vocabulary is the system prompt's last section, as for cleanup
        assert_eq!(
            prompt.message,
            "## Current document\n\n# The panel\n\n- one row per memo\n\nOpen: where the button goes.\n\n\
             ## Follow-up transcript\n\nactually put the button at the bottom\n"
        );
        assert!(system.ends_with("\n\n## Project vocabulary\n\n- TRMNL — misheard as: terminal"));
        assert!(merge_prompt("  ", "# A doc", "words").system().ends_with("## Project vocabulary\n\n(none provided)"));
        assert_eq!(prompt.combined(), format!("{system}\n\n{}", prompt.message));

        // The two prompts answer in the same shape, because one parser reads
        // both answers: the `# ` line, then the memo, then the marker and the
        // words it wants adding. Shared strings rather than two copies that
        // drift — a trailer that stopped matching `split_suggestions` would put
        // a glossary in someone's document.
        let cleanup = cleanup_prompt("- TRMNL — misheard as: terminal", "so the terminal firmware");
        for shared in [VOCABULARY_RULE, VOCABULARY_TRAILER] {
            assert!(system.contains(shared));
            assert!(cleanup.system().contains(shared));
        }
        assert!(system.contains("The first line must be `# `"));
        assert!(system.contains("No preamble, no commentary, no code fences"));
    }

    /// One sentence of the instructions is not prose but a contract:
    /// [`split_suggestions`] cuts the answer on the marker it names. So the
    /// sentence is pinned to that marker, byte for byte, in both prompts whose
    /// answers are parsed that way — and kept out of the one whose answer isn't.
    #[test]
    fn the_marker_contract_is_one_sentence_in_both_prompts() {
        let contract = format!(
            "Write a line containing exactly `{VOCABULARY_MARKER}`, then one line per term in the vocabulary's own shape, \
             `- Term — misheard as: X`."
        );
        assert!(VOCABULARY_TRAILER.contains(&contract));
        for parsed in [Instructions::Cleanup, Instructions::Merge] {
            assert!(parsed.text().contains(&contract), "{parsed:?}");
        }
        assert!(!Instructions::Seed.text().contains(VOCABULARY_MARKER), "a glossary has no memo to come after");
    }

    /// An older `claude` refuses the flag before it does anything else, and
    /// that refusal — and only that — is what sends the prompt the old way.
    #[test]
    fn an_old_cli_that_lacks_the_flag_is_recognised() {
        // what commander prints, verbatim, for a flag it has never heard of
        assert!(lacks_system_prompt_flag("error: unknown option '--system-prompt'\n"));
        assert!(!lacks_system_prompt_flag(""));
        assert!(!lacks_system_prompt_flag("Failed to authenticate. Please run /login."));
        // some other flag going missing is a bug in this file, not an old CLI
        assert!(!lacks_system_prompt_flag("error: unknown option '--disallowedTools'\n"));
    }

    /// The record of a call is the call: run the script and the same words and
    /// the same stdin arrive, byte for byte — quotes, newlines, `$HOME` left
    /// alone, a line that looks like the heredoc's own delimiter. A shim
    /// `claude` on the script's PATH writes down what it was given.
    #[test]
    fn the_record_of_a_call_runs_the_same_call() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp("invocation");
        let bin = dir.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let shim = bin.join("claude");
        std::fs::write(
            &shim,
            "#!/bin/sh\nfor a in \"$@\"; do printf '%s\\0' \"$a\"; done > \"$ZERO_SHIM_OUT/argv\"\n\
             cat > \"$ZERO_SHIM_OUT/stdin\"\n",
        )
        .unwrap();
        std::fs::set_permissions(&shim, std::fs::Permissions::from_mode(0o755)).unwrap();

        let stdin = "## Project vocabulary\n\n- TRMNL — misheard as: terminal\n\nZERO_STDIN\n\
                     ## Transcript\n\nit's 'quoted', and $HOME stays `literal`\n";
        let inv = Invocation {
            instructions: Instructions::Cleanup,
            cwd: dir.clone(),
            // the shim first, then enough of a PATH for `cat`
            path: format!("{}:/bin:/usr/bin", bin.to_string_lossy()),
            args: claude_args(Some("it's a system prompt\n\nwith a blank line and a `tick`")),
            stdin: stdin.to_string(),
            refused: Some("error: unknown option '--system-prompt'".into()),
            outcome: "exit 0 after 1.2 s".into(),
        };
        let script = invocation_script(&inv, "2026-08-22T04:12:33+02:00", "zero's cleanup, take 1 of x");

        // the header says what it is; the body is the quoting rule
        assert!(script.starts_with("#!/bin/sh\n# zero's cleanup, take 1 of x: the claude call, verbatim"));
        assert!(script.contains("# Ran 2026-08-22T04:12:33+02:00; exit 0 after 1.2 s.\n"));
        assert!(script.contains("# This claude refused --system-prompt (error: unknown option '--system-prompt')"));
        assert!(
            script.contains("\n  --system-prompt \\\n  'it'\\''s a system prompt\n\nwith a blank line and a `tick`' \\\n"),
            "a quote is spelled, a newline is kept, a backtick is nothing special"
        );
        assert!(script.contains(" \\\n  <<'ZERO_STDIN_2'\n"), "the message quotes the usual delimiter, so another is picked");
        assert!(script.ends_with("`literal`\nZERO_STDIN_2\n"));
        assert_eq!(heredoc_tag("plain\n"), "ZERO_STDIN");
        assert_eq!(sh_word("-p"), "-p");
        assert_eq!(sh_word("--output-format"), "--output-format");
        assert_eq!(sh_word("a,b"), "'a,b'");
        assert_eq!(sh_word(""), "''");

        // and it runs: the shim gets exactly the words and the stdin
        let path = dir.join("x.1.claude.sh");
        std::fs::write(&path, &script).unwrap();
        let status = Command::new("/bin/sh").arg(&path).env("ZERO_SHIM_OUT", &dir).status().unwrap();
        assert!(status.success(), "the script runs as it is");
        let argv = std::fs::read(dir.join("argv")).unwrap();
        let words: Vec<&str> = argv
            .split(|b| *b == 0)
            .filter(|w| !w.is_empty())
            .map(|w| std::str::from_utf8(w).unwrap())
            .collect();
        assert_eq!(words, inv.args, "every argument, verbatim");
        assert_eq!(std::fs::read_to_string(dir.join("stdin")).unwrap(), stdin, "and the whole of stdin");

        let _ = std::fs::remove_dir_all(dir);
    }

    /// The seed asks for a glossary and nothing else — a preamble would be a
    /// line nobody wrote into their own vocabulary.
    #[test]
    fn seed_prompt_asks_the_readme_for_lines_and_nothing_else() {
        let prompt = seed_prompt("# zero\n\nA terminal by Anthropic, sort of.\n");
        let system = prompt.system();

        assert!(system.starts_with("From the README in the message's `## README` section, list the proper nouns"));
        assert!(system.contains("a speech transcriber would plausibly mangle"));
        assert!(system.contains("Skip ordinary dictionary words"));
        assert!(system.contains("`- Term — one short hint"));
        assert!(system.contains(&format!("At most {MAX_SEED_TERMS} lines")), "the cap the parser also applies");
        assert!(system.contains("no preamble, no heading, no commentary, no code fences"));
        assert_eq!(prompt.message, "## README\n\n# zero\n\nA terminal by Anthropic, sort of.\n\n");
        assert_eq!(prompt.combined(), format!("{system}\n\n{}", prompt.message));
        // the one pass with no vocabulary section: it is the pass that writes the first one
        assert!(!system.contains("## Project vocabulary"));

        // a README past the cap is cut, and cut between characters rather than
        // through one — a truncated é is not a string
        assert_eq!(head("short enough", 64), "short enough");
        let huge = format!("x{}", "é".repeat(MAX_README));
        assert_eq!(head(&huge, MAX_README).len(), MAX_README - 1);
        assert!(seed_prompt(&huge).message.len() < huge.len());
    }

    /// Cleanup answers with a memo and, sometimes, the words it had to fix.
    /// The `.md` is a paste payload, so none of the second part may reach it.
    #[test]
    fn the_vocabulary_section_splits_off_the_end_of_the_memo() {
        // no marker: the whole answer is the memo, exactly as before there was
        // a second part to answer with
        let plain = "# A title\n\nbody, with a --- rule in it\n";
        assert_eq!(split_suggestions(plain), (plain, ""));

        let (memo, extra) =
            split_suggestions("# A title\n\nbody\n---vocabulary---\n- Kranz — misheard as: Krantz\n");
        assert_eq!(memo, "# A title\n\nbody\n");
        assert_eq!(glossary_lines(extra, MAX_SUGGESTIONS), ["- Kranz — misheard as: Krantz"]);

        // a memo *about* the marker, and then the real one: the last wins
        let (memo, extra) = split_suggestions(
            "# The marker\n\nthe model is asked for this line:\n\n---vocabulary---\n\nand then it stops.\n\
             ---vocabulary---\n  - Kranz — misheard as: Krantz\n",
        );
        assert!(memo.ends_with("and then it stops.\n"), "the quoted one stays in the memo");
        assert_eq!(memo.matches(VOCABULARY_MARKER).count(), 1);
        assert_eq!(
            glossary_lines(extra, MAX_SUGGESTIONS),
            ["- Kranz — misheard as: Krantz"],
            "and an indented line is still a line"
        );

        // a marker with nothing usable behind it suggests nothing
        let (_, extra) = split_suggestions("# A title\n\nbody\n---vocabulary---\nNone, actually.\n");
        assert!(glossary_lines(extra, MAX_SUGGESTIONS).is_empty());
    }

    /// The harvest only ever appends, only words the file lacks, and says on
    /// the line itself that nobody typed it.
    #[test]
    fn suggested_terms_land_once_and_admit_where_they_came_from() {
        let dir = temp("suggestions");
        let file = dir.join("ZERO.md");
        std::fs::write(&file, vocabulary_seed("zero")).unwrap();

        let out = "\
Here are the terms I corrected:
- Kranz — misheard as: Krantz
- zero — misheard as: hero
- TRMNL — misheard as: terminal
- SpeechAnalyzer — misheard as: speech analyser
- Tauri — misheard as: Tory
- Hinnant — misheard as: hint at
";
        let lines = glossary_lines(out, MAX_SUGGESTIONS);
        assert_eq!(lines.len(), MAX_SUGGESTIONS, "the preamble is not a line, and five is the cap");

        let tagged: Vec<String> = lines.iter().map(|l| format!("{l} (suggested)")).collect();
        assert_eq!(append_terms(&file, &tagged), 4, "zero was already in the file");

        let body = std::fs::read_to_string(&file).unwrap();
        assert!(body.starts_with("<!-- ZERO.md"), "the header stays where it is");
        assert!(body.contains("- Kranz — misheard as: Krantz (suggested)\n"));
        assert_eq!(body.matches("- zero —").count(), 1, "and the term it knew is untouched");
        assert_eq!(parse_vocabulary(&body).terms.len(), 5);

        // the same words again, in whatever case they come back in, add nothing
        let shouted: Vec<String> = tagged.iter().map(|l| l.to_uppercase()).collect();
        assert_eq!(append_terms(&file, &shouted), 0);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), body);

        // and a file somebody deleted is not written back into existence
        std::fs::remove_file(&file).unwrap();
        assert_eq!(append_terms(&file, &tagged), 0);
        assert!(!file.exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The vocabulary moved to the project root after v1 shipped, so zero
    /// carries its own file up rather than leaving it where it can't be seen.
    #[test]
    fn the_vocabulary_moves_itself_up_to_zero_md() {
        let dir = temp("zero-md");
        let root = dir.to_string_lossy().to_string();
        assert_eq!(vocabulary_path(&root), dir.join("ZERO.md"), "the new home, even empty");

        std::fs::create_dir_all(dir.join(".zero")).unwrap();
        std::fs::write(dir.join(".zero").join("vocabulary.md"), "- TRMNL — misheard as: terminal\n")
            .unwrap();
        assert_eq!(vocabulary_path(&root), dir.join("ZERO.md"));
        assert!(!dir.join(".zero").join("vocabulary.md").exists(), "moved, not copied");
        assert_eq!(read_vocabulary(&root).terms, vec!["TRMNL"], "and readable from there");

        // a ZERO.md that already exists wins; the old file is left alone
        std::fs::write(dir.join(".zero").join("vocabulary.md"), "- Stale — from before\n").unwrap();
        assert_eq!(read_vocabulary(&root).terms, vec!["TRMNL"]);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Every way a memo can be found in a state nobody is maintaining: killed
    /// mid-stage, half-written, edited by hand, or missing its json entirely.
    #[test]
    fn reconciliation_believes_the_files() {
        let dir = temp("reconcile");
        let none = HashSet::new();
        let save = |m: &MemoFile| save_memo(&dir, m).unwrap();
        let audio = |id: &str| write(&dir, &format!("{id}.m4a"), "\0\0audio");

        // orphans: no json at all, one memo per level of completeness
        audio("orphan-a");
        audio("orphan-b");
        write(&dir, "orphan-b.raw.txt", "a transcript long enough to count");
        audio("orphan-c");
        write(&dir, "orphan-c.raw.txt", "a transcript long enough to count");
        write(&dir, "orphan-c.md", "# A rebuilt title\n\nbody");

        // crashes: an in-flight status with nobody flying it
        audio("crash-record");
        save(&memo("crash-record", RECORDING));
        audio("crash-transcribe");
        save(&memo("crash-transcribe", TRANSCRIBING));
        audio("crash-clean");
        write(&dir, "crash-clean.raw.txt", "a transcript long enough to count");
        save(&memo("crash-clean", CLEANING));

        // A recording that captured nothing, and a json with no files at all.
        // Both wear the minted shape, because the sweep now checks: only names
        // this program invented are its to delete.
        save(&memo("2026-01-02-0930-aaaa", RECORDING));
        write(&dir, "2026-01-02-0930-aaaa.caf", "");
        save(&memo("2026-01-02-0930-bbbb", RECORDED));

        // and the same audioless shape under a name that is somebody's, not
        // ours — dropped into the directory by hand, and not ours to sweep
        write(&dir, "notes.md", "# a person's notes, not a memo\n");

        // corrupt json, and a `.md` deleted by hand afterwards
        audio("corrupt");
        write(&dir, "corrupt.raw.txt", "a transcript long enough to count");
        write(&dir, "corrupt.json", "{ this is not json");
        audio("demote");
        write(&dir, "demote.raw.txt", "a transcript long enough to count");
        let mut ready = memo("demote", READY);
        ready.title = Some("gone with the md".into());
        save(&ready);

        // silence: ready with no `.md`, which must not look like a demotion
        audio("silent");
        write(&dir, "silent.raw.txt", "");
        let mut silent = memo("silent", READY);
        silent.title = Some(NO_SPEECH.into());
        save(&silent);

        // and the shape the byte count can't see: ten bytes of raw, six
        // characters once trimmed, which is what cleanup measured before it
        // filed this as silence. Demoting it would have auto-advance re-queue
        // a cleanup that returns without incrementing anything, forever.
        audio("mumble");
        write(&dir, "mumble.raw.txt", "so, um \n\n\n");
        let mut mumble = memo("mumble", READY);
        mumble.title = Some(NO_SPEECH.into());
        save(&mumble);

        // a failure stays failed — auto-advance must never see it as a
        // checkpoint to walk on from
        audio("failed");
        write(&dir, "failed.raw.txt", "a transcript long enough to count");
        save(&memo("failed", CLEANUP_FAILED));

        // The per-take documents a thread view reads. They are a record of what
        // was said, and evidence of nothing: a finished memo is no more finished
        // for having them, and one whose `.md` was deleted by hand is demoted
        // with its snapshots sitting right there — the document is the `.md`,
        // and a copy of what it used to say is not a copy of it.
        audio("versioned");
        write(&dir, "versioned.raw.txt", "a transcript long enough to count");
        write(&dir, "versioned.md", "# The document\n\nbody");
        write(&dir, "versioned.1.md", "# The document\n\nbody");
        save(&memo("versioned", READY));

        audio("version-only");
        write(&dir, "version-only.raw.txt", "a transcript long enough to count");
        write(&dir, "version-only.1.md", "# What the first pass wrote\n\nbody");
        let mut lost = memo("version-only", READY);
        lost.title = Some("gone with the md".into());
        save(&lost);

        let found: BTreeMap<String, MemoFile> = reconcile_dir(&dir, &none)
            .into_iter()
            .map(|m| (m.id.clone(), m))
            .collect();
        let status = |id: &str| found.get(id).map(|m| m.status.as_str());

        assert_eq!(status("orphan-a"), Some(RECORDED));
        assert_eq!(status("orphan-b"), Some(TRANSCRIBED));
        assert_eq!(status("orphan-c"), Some(READY));
        assert_eq!(found["orphan-c"].title.as_deref(), Some("A rebuilt title"));
        assert!(dir.join("orphan-a.json").exists(), "a rebuilt memo is written back");

        assert_eq!(status("crash-record"), Some(RECORDED));
        assert!(found["crash-record"].interrupted, "and says so");
        assert_eq!(status("crash-transcribe"), Some(RECORDED));
        assert_eq!(status("crash-clean"), Some(TRANSCRIBED));

        assert_eq!(status("2026-01-02-0930-aaaa"), None, "a recording of nothing is not a memo");
        assert!(!dir.join("2026-01-02-0930-aaaa.json").exists(), "and its files go with it");
        assert_eq!(status("2026-01-02-0930-bbbb"), None);
        assert_eq!(status("notes"), None, "a foreign file is nobody's memo");
        assert!(dir.join("notes.md").exists(), "and nobody's to sweep");

        assert_eq!(status("corrupt"), Some(TRANSCRIBED), "rebuilt from the files");
        assert_eq!(status("demote"), Some(TRANSCRIBED), "ready is a claim the md has to back");
        assert_eq!(status("silent"), Some(READY), "silence is finished, not unfinished");
        assert_eq!(found["silent"].title.as_deref(), Some(NO_SPEECH));
        assert_eq!(status("mumble"), Some(READY), "ten bytes of it is still silence");
        assert_eq!(next_stage(&found["mumble"]), None, "so nothing enqueues it again");
        assert!(!dir.join("mumble.md").exists(), "and no .md was ever coming");
        assert_eq!(status("failed"), Some(CLEANUP_FAILED));

        assert_eq!(status("versioned"), Some(READY), "a snapshot beside the document changes nothing");
        assert_eq!(found["versioned"].takes.len(), 0, "and is not a recording of anything");
        assert_eq!(status("version-only"), Some(TRANSCRIBED), "a snapshot is not the document");
        for stem in ["versioned.1", "version-only.1"] {
            assert!(!found.contains_key(stem), "{stem} is not a memo of its own");
        }
        assert!(dir.join("versioned.1.md").exists(), "and nothing sweeps one up");
        assert!(dir.join("version-only.1.md").exists());

        // a memo something is actually working on is left exactly as it is
        audio("live");
        save(&memo("live", TRANSCRIBING));
        let live = HashSet::from(["live".to_string()]);
        let kept = reconcile_dir(&dir, &live);
        assert_eq!(
            kept.iter().find(|m| m.id == "live").map(|m| m.status.as_str()),
            Some(TRANSCRIBING)
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A take's files are the memo's files with a number in them, and that
    /// number is the only thing telling one recording of a memo from another.
    /// It starts at 2 so that a memo nobody has iterated on is byte-for-byte
    /// the memo it was before takes existed.
    #[test]
    fn takes_are_numbered_from_two_and_named_after_their_memo() {
        assert_eq!(take_no(0), 2, "the first follow-up is take 2");
        assert_eq!(take_stem("2026-08-13-1432-ab12", 2), "2026-08-13-1432-ab12.2");
        assert_eq!(take_raw_name("2026-08-13-1432-ab12", 3), "2026-08-13-1432-ab12.3.raw.txt");
        assert_eq!(last_take_no(&with_takes("x", READY, 0)), None);
        assert_eq!(last_take_no(&with_takes("x", READY, 3)), Some(4));

        assert_eq!(split_take("2026-08-13-1432-ab12.2"), Some(("2026-08-13-1432-ab12", 2)));
        assert_eq!(split_take("2026-08-13-1432-ab12"), None, "a memo id has no dots in it");
        assert_eq!(split_take("x.1"), None, "take 1 is the base recording and wears no number");
        assert_eq!(split_take("x.0"), None);
        assert_eq!(split_take("x.notanumber"), None);
        assert_eq!(split_take(".2"), None);

        // and the file kinds a take can have, from the same one place the
        // scanner and the delete both read
        assert_eq!(classify("x.2.raw.txt"), Some(("x.2", "raw")));
        assert_eq!(classify("x.2.m4a"), Some(("x.2", "audio")));
        assert_eq!(classify("x.md"), Some(("x", "md")));
        assert_eq!(classify("notes.txt"), None);

        // The documents, which are numbered from one — take 1's recording wears
        // the plain stem, but its document can't, because `<id>.md` is the
        // current one. A version answers with the memo's stem and a kind of its
        // own: it is neither that memo's document nor any take's file.
        assert_eq!(version_name("2026-08-13-1432-ab12", 1), "2026-08-13-1432-ab12.1.md");
        assert_eq!(version_name("2026-08-13-1432-ab12", 4), "2026-08-13-1432-ab12.4.md");
        assert_eq!(classify("x.1.md"), Some(("x", "version")));
        assert_eq!(classify("x.4.md"), Some(("x", "version")));
        // and the call behind a take, numbered and filed the same way; one
        // without a number is no take's and so nobody's
        assert_eq!(invocation_name("2026-08-13-1432-ab12", 2), "2026-08-13-1432-ab12.2.claude.sh");
        assert_eq!(classify("x.1.claude.sh"), Some(("x", "invocation")));
        assert_eq!(owning_memo("x.3.claude.sh"), Some("x"));
        assert_eq!(classify("x.claude.sh"), None);
        assert_eq!(split_version("x.1"), Some(("x", 1)));
        assert_eq!(split_version("x.2"), Some(("x", 2)));
        assert_eq!(split_version("x"), None, "the memo's own document is not a version of it");
        assert_eq!(split_version("x.0"), None);
        assert_eq!(split_version(".1"), None);

        // a plain memo's json says nothing at all about takes — no field for a
        // feature it hasn't used — and one written before takes existed loads
        let plain = serde_json::to_string(&memo("x", READY)).unwrap();
        assert!(!plain.contains("takes"), "no speculative field on a memo recorded once");
        assert!(serde_json::from_str::<MemoFile>(&plain).unwrap().takes.is_empty());
        assert!(serde_json::to_string(&with_takes("x", READY, 1)).unwrap().contains("\"takes\""));

        // the wire's timer field with nobody live to ask: the moment *this*
        // recording started, which for a take is the take's own clock and never
        // the memo's age
        let live = with_takes("x", RECORDING, 1);
        assert_eq!(wire(&live, Live::default()).recording_since.as_deref(), Some("2026-08-13T15:02:44Z"));
        assert_eq!(wire(&live, Live::default()).takes, 1);
        assert_eq!(
            wire(&memo("x", RECORDING), Live::default()).recording_since.as_deref(),
            Some("2026-08-13T14:32:11Z")
        );
        assert_eq!(
            wire(&with_takes("x", READY, 2), Live::default()).recording_since,
            None,
            "only while recording"
        );

        // deleting a memo takes every recording of it and every document it
        // ever had, however many there were
        let deleting = temp("takes-delete");
        for name in [
            "x.json", "x.m4a", "x.raw.txt", "x.md", "x.1.md", "x.2.caf", "x.2.raw.txt", "x.2.md",
            "x.3.m4a", "x.1.claude.sh", "x.3.claude.sh",
        ] {
            write(&deleting, name, "bytes");
        }
        write(&deleting, "y.2.m4a", "someone else's follow-up");
        write(&deleting, "y.1.md", "someone else's first pass");
        write(&deleting, "y.1.claude.sh", "someone else's call");
        remove_all(&deleting, "x");
        let mut left: Vec<String> = std::fs::read_dir(&deleting)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        left.sort();
        assert_eq!(
            left,
            ["y.1.claude.sh", "y.1.md", "y.2.m4a"],
            "every numbered file went with it, and only its own"
        );

        // and abandoning one take leaves the memo — and its other takes, and
        // the documents they produced — alone
        let dropping = temp("takes-drop");
        for name in [
            "x.m4a", "x.md", "x.1.md", "x.2.m4a", "x.2.raw.txt", "x.2.md", "x.2.claude.sh", "x.3.caf",
            "x.3.md", "x.3.claude.sh",
        ] {
            write(&dropping, name, "bytes");
        }
        let mut memo = with_takes("x", RECORDING, 2);
        drop_take(&dropping, &mut memo);
        assert_eq!(memo.takes.len(), 1, "the last one, and no further");
        assert!(!dropping.join("x.3.caf").exists());
        assert!(!dropping.join("x.3.md").exists(), "a number that comes back inherits nothing");
        assert!(!dropping.join("x.3.claude.sh").exists(), "not even the call that made it");
        assert!(dropping.join("x.2.m4a").exists() && dropping.join("x.md").exists(), "the outcome stands");
        assert!(dropping.join("x.1.md").exists() && dropping.join("x.2.md").exists(), "and so does its record");
        assert!(dropping.join("x.2.claude.sh").exists());

        for dir in [deleting, dropping] {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    /// The other half of reconciliation, and the careful half: numbered files
    /// belong to the memo whose name they carry, an unfinished take falls back
    /// to *itself*, and a memo that has been iterated on is never sent back
    /// through the pipeline that already produced its document.
    #[test]
    fn reconciliation_folds_takes_into_the_memo_they_belong_to() {
        let dir = temp("reconcile-takes");
        let none = HashSet::new();
        let save = |m: &MemoFile| save_memo(&dir, m).unwrap();
        let audio = |name: &str| write(&dir, &format!("{name}.m4a"), "\0\0audio");
        let raw = |name: &str| write(&dir, &format!("{name}.raw.txt"), "a transcript long enough to count");

        // the ordinary finished shape: a memo, one follow-up, a merged document
        audio("iterated");
        raw("iterated");
        write(&dir, "iterated.md", "# The merged document\n\nbody");
        audio("iterated.2");
        raw("iterated.2");
        save(&with_takes("iterated", READY, 1));

        // the same, with the `.md` deleted by hand. The base artifacts say
        // `transcribed`, but the document a demotion would rebuild is the first
        // recording's — not the one every follow-up went into — so a memo with
        // takes is left where it is.
        audio("no-md");
        raw("no-md");
        audio("no-md.2");
        raw("no-md.2");
        save(&with_takes("no-md", READY, 1));

        // crashes, each of which falls back to the take rather than the memo
        audio("crash-take");
        raw("crash-take");
        write(&dir, "crash-take.md", "# Still here\n\nbody");
        write(&dir, "crash-take.2.caf", "\0\0audio");
        save(&with_takes("crash-take", RECORDING, 1));

        audio("empty-take");
        raw("empty-take");
        write(&dir, "empty-take.md", "# Untouched\n\nbody");
        write(&dir, "empty-take.2.caf", "");
        save(&with_takes("empty-take", RECORDING, 1));

        audio("take-transcribing");
        raw("take-transcribing");
        write(&dir, "take-transcribing.md", "# A document\n\nbody");
        audio("take-transcribing.2");
        save(&with_takes("take-transcribing", TRANSCRIBING, 1));

        // mid-merge, and the entry still says caf because the crash landed
        // between the conversion and the json write
        audio("take-cleaning");
        raw("take-cleaning");
        write(&dir, "take-cleaning.md", "# A document\n\nbody");
        audio("take-cleaning.2");
        raw("take-cleaning.2");
        let mut cleaning = with_takes("take-cleaning", CLEANING, 1);
        cleaning.takes[0].audio = "take-cleaning.2.caf".to_string();
        save(&cleaning);

        // numbered files with no entry naming them: a json that predates them,
        // and one that can't be read at all
        audio("orphan-take");
        raw("orphan-take");
        write(&dir, "orphan-take.md", "# A document\n\nbody");
        audio("orphan-take.2");
        raw("orphan-take.2");
        save(&memo("orphan-take", READY));

        audio("corrupt-take");
        raw("corrupt-take");
        write(&dir, "corrupt-take.json", "{ this is not json");
        audio("corrupt-take.2");
        raw("corrupt-take.2");

        // the ordinary finished shape once documents are kept: one per take,
        // beside the current one. None of them is a take and none of them is
        // the `.md`, so the memo is exactly what it would be without them.
        audio("versioned-take");
        raw("versioned-take");
        write(&dir, "versioned-take.md", "# The merged document\n\nbody");
        write(&dir, "versioned-take.1.md", "# What the first pass wrote\n\nbody");
        write(&dir, "versioned-take.2.md", "# The merged document\n\nbody");
        audio("versioned-take.2");
        raw("versioned-take.2");
        save(&with_takes("versioned-take", READY, 1));

        // and a document whose take isn't there: a follow-up taken back out
        // after a merge that never happened, or a file copied by hand. A
        // document is not a recording, so it cannot conjure the take that would
        // have made one — which is the whole reason `classify` folds these into
        // the memo's stem rather than leaving them looking like take files.
        audio("stale-version");
        raw("stale-version");
        write(&dir, "stale-version.md", "# A document\n\nbody");
        write(&dir, "stale-version.1.md", "# A document\n\nbody");
        write(&dir, "stale-version.2.md", "# A document that outlived its take\n\nbody");
        save(&memo("stale-version", READY));

        // takes with no memo left to belong to are not a memo of their own —
        // under the minted shape, since a sweep only touches names it minted
        save(&memo("2026-01-03-1200-dddd", READY));
        audio("2026-01-03-1200-dddd.2");
        raw("2026-01-03-1200-dddd.2");
        write(&dir, "2026-01-03-1200-dddd.1.md", "# A document with no memo\n\nbody");

        let found: BTreeMap<String, MemoFile> = reconcile_dir(&dir, &none)
            .into_iter()
            .map(|m| (m.id.clone(), m))
            .collect();
        let status = |id: &str| found.get(id).map(|m| m.status.as_str());
        let takes = |id: &str| found.get(id).map(|m| m.takes.len());

        assert_eq!(status("iterated"), Some(READY));
        assert_eq!(takes("iterated"), Some(1));
        assert_eq!(next_stage(&found["iterated"]), None, "a finished memo stays finished");
        assert!(!found.contains_key("iterated.2"), "a take is never a memo of its own");

        assert_eq!(status("no-md"), Some(READY), "the base files are not evidence against it");
        assert_eq!(takes("no-md"), Some(1));

        assert_eq!(status("crash-take"), Some(RECORDED), "the follow-up got as far as bytes");
        assert!(found["crash-take"].interrupted);
        assert_eq!(takes("crash-take"), Some(1));

        assert_eq!(status("empty-take"), Some(READY), "and the memo is what it was before the press");
        assert_eq!(takes("empty-take"), Some(0));
        assert!(!dir.join("empty-take.2.caf").exists(), "the stub goes with the entry");
        assert_eq!(found["empty-take"].title.as_deref(), Some("Untouched"), "the document stands");
        assert_eq!(next_stage(&found["empty-take"]), None, "and nothing is queued over it");

        assert_eq!(status("take-transcribing"), Some(RECORDED));
        assert_eq!(next_stage(&found["take-transcribing"]), Some(Stage::Transcribe));

        assert_eq!(status("take-cleaning"), Some(TRANSCRIBED));
        assert_eq!(next_stage(&found["take-cleaning"]), Some(Stage::Cleanup), "which is the merge");
        assert_eq!(
            found["take-cleaning"].takes[0].audio, "take-cleaning.2.m4a",
            "the files correct a name the json never got to update"
        );

        assert_eq!(takes("orphan-take"), Some(1), "kept, not swept — audio can't be made again");
        assert_eq!(found["orphan-take"].takes[0].raw, "orphan-take.2.raw.txt");
        assert_eq!(found["orphan-take"].takes[0].duration_s, 0.0, "a length nobody recorded is zero");
        assert_eq!(status("orphan-take"), Some(READY));

        assert_eq!(status("corrupt-take"), Some(TRANSCRIBED), "rebuilt from the files");
        assert_eq!(takes("corrupt-take"), Some(1));

        assert_eq!(status("versioned-take"), Some(READY), "two documents, one follow-up");
        assert_eq!(takes("versioned-take"), Some(1));
        assert_eq!(next_stage(&found["versioned-take"]), None, "and nothing to re-run over it");
        assert!(!found.contains_key("versioned-take.2"));

        assert_eq!(status("stale-version"), Some(READY));
        assert_eq!(takes("stale-version"), Some(0), "a document never spawns the take it names");
        assert!(dir.join("stale-version.2.md").exists(), "and is left exactly where it is");

        assert_eq!(status("2026-01-03-1200-dddd"), None);
        assert!(!dir.join("2026-01-03-1200-dddd.2.m4a").exists(), "and the orphaned takes go too");
        assert!(!dir.join("2026-01-03-1200-dddd.2.raw.txt").exists());
        assert!(
            !dir.join("2026-01-03-1200-dddd.1.md").exists(),
            "with the documents nobody can reach any more"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A pause has to cost the timer exactly what it costs the recording, which
    /// is nothing. The panel is told a moment and subtracts it from `now`, so
    /// the only place that can be made true is the moment it subtracts.
    #[test]
    fn a_pause_moves_the_timer_rather_than_stopping_it() {
        let recording = || Recording {
            root: "/project".to_string(),
            id: "x".to_string(),
            stdin: None,
            child: Arc::new(Mutex::new(None)),
            paused: false,
            since: 1_000,
            recorded: 0,
        };

        // running: the origin is the press, and nothing recomputes it
        let mut rec = recording();
        assert_eq!(rec.timer_since(1_030), 1_000, "thirty seconds in, and counting");

        // paused thirty seconds in, for as long as anybody likes
        rec.pause(1_030);
        assert!(rec.paused);
        assert_eq!(1_030 - rec.timer_since(1_030), 30);
        assert_eq!(1_200 - rec.timer_since(1_200), 30, "a pause freezes the length it froze at");
        rec.pause(1_500);
        assert_eq!(1_500 - rec.timer_since(1_500), 30, "and pressing it again banks nothing more");

        // resumed nearly eight minutes later: the recording is still thirty
        // seconds long, and the minute after this one is its thirty-first
        // through its ninetieth
        rec.resume(1_500);
        assert!(!rec.paused);
        assert_eq!(1_500 - rec.timer_since(1_500), 30);
        assert_eq!(1_560 - rec.timer_since(1_560), 90);
        rec.resume(1_600);
        assert_eq!(1_600 - rec.timer_since(1_600), 130, "and a resume with nothing to resume moves nothing");

        // a clock that went backwards is worth a zero, never a negative memo
        let mut backwards = recording();
        backwards.pause(900);
        assert_eq!(backwards.recorded, 0);

        // and the wire carries the manager's moment rather than the json's, so
        // that `created` can go on saying when the memo was made
        let wired = wire(
            &memo("x", RECORDING),
            Live { queued: false, since: Some(1_786_631_591), paused: true },
        );
        assert_eq!(wired.recording_since.as_deref(), Some("2026-08-13T14:33:11Z"));
        assert_eq!(wired.created, "2026-08-13T14:32:11Z", "a minute earlier, and unmoved");
        assert!(wired.paused);
        assert_eq!(wired.status, RECORDING, "a paused row is still a recording one");
        assert!(!wire(&memo("x", RECORDING), Live::default()).paused, "and nothing else is paused");
    }

    /// Cancelling is the one ending that keeps nothing, so what it leaves
    /// behind has to be exactly what was there before the press: no memo at
    /// all, or the finished one the follow-up was recorded onto, untouched.
    ///
    /// Driven through the file paths the reader calls rather than through the
    /// reader, which needs a live helper and a Tauri app handle to reach at
    /// all. What is being tested is the state the two of them leave on disk,
    /// and that is all here.
    #[test]
    fn a_cancelled_recording_leaves_nothing_to_reconcile() {
        // a cancelled memo of its own: the helper has taken the audio, and the
        // stub it was recording into goes with it
        let base = temp("cancel-base");
        write(&base, "x.json", "{}");
        write(&base, "x.caf", "\0\0audio the helper had not got to yet");
        write(&base, "x.m4a", "\0\0nor this");
        remove_all(&base, "x");
        assert!(std::fs::read_dir(&base).unwrap().next().is_none(), "not a byte of it stays");
        assert!(
            reconcile_dir(&base, &HashSet::new()).is_empty(),
            "so there is nothing left to reconcile, and no row to publish about"
        );

        // a cancelled follow-up: the take goes, and the memo underneath it is
        // the finished thing it was a minute ago
        let take = temp("cancel-take");
        write(&take, "x.m4a", "\0\0audio");
        write(&take, "x.raw.txt", "a transcript long enough to count");
        write(&take, "x.md", "# The document\n\nbody");
        write(&take, "x.1.md", "# The document\n\nbody");
        write(&take, "x.2.caf", "\0\0a follow-up, cancelled mid-sentence");
        let mut memo = with_takes("x", RECORDING, 1);
        memo.title = Some("The document".to_string());
        drop_take(&take, &mut memo);
        memo.status = READY.to_string();
        save_memo(&take, &memo).unwrap();

        assert_eq!(memo.takes.len(), 0, "the entry goes with the recording");
        assert!(!take.join("x.2.caf").exists(), "and so do its bytes");
        assert!(take.join("x.md").exists(), "the document it was recorded onto stands");
        assert!(take.join("x.1.md").exists(), "and so does the record of how it got there");
        assert_eq!(next_stage(&memo), None, "and nothing walks it back into the pipeline");

        let found = reconcile_dir(&take, &HashSet::new());
        assert_eq!(found.len(), 1, "one memo, and no phantom take beside it");
        assert_eq!(found[0].status, READY);
        assert_eq!(found[0].takes.len(), 0);
        assert_eq!(found[0].title.as_deref(), Some("The document"));

        for dir in [base, take] {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    /// The pipeline resumes on its own, twice at most, and never past a
    /// failure — a stage that failed is a decision for a person, because the
    /// one that burns tokens is a stage away.
    #[test]
    fn auto_advance_stops_where_it_should() {
        let staged = |status: &str, transcribe: u32, cleanup: u32| {
            let mut m = memo("x", status);
            m.attempts = Attempts { transcribe, cleanup };
            next_stage(&m)
        };

        assert_eq!(staged(RECORDED, 0, 0), Some(Stage::Transcribe));
        assert_eq!(staged(RECORDED, 1, 0), Some(Stage::Transcribe), "one free retry");
        assert_eq!(staged(RECORDED, 2, 0), None, "and then it waits");
        assert_eq!(staged(TRANSCRIBED, 1, 0), Some(Stage::Cleanup));
        assert_eq!(staged(TRANSCRIBED, 1, 2), None);

        for settled in [RECORDING, TRANSCRIBING, CLEANING, READY, TRANSCRIBE_FAILED, CLEANUP_FAILED] {
            assert_eq!(staged(settled, 0, 0), None, "{settled} is nobody's cue");
        }
    }

    /// The app's first write into someone else's repository. It happens once,
    /// it says who did it, and deleting the line is a decision that sticks.
    #[test]
    fn gitignore_gets_one_line_and_only_one() {
        let dir = temp("gitignore");
        let git = |args: &[&str]| {
            Command::new("git")
                .current_dir(&dir)
                .env("PATH", repaired_path())
                .args(args)
                .output()
                .unwrap();
        };
        git(&["init", "-q", "."]);
        std::fs::write(dir.join(".gitignore"), "target/").unwrap();

        assert!(ensure_memos_ignored(&dir), "unignored recordings earn the line");
        let body = std::fs::read_to_string(dir.join(".gitignore")).unwrap();
        assert_eq!(body, "target/\n# zero: local voice memos\n.zero/memos/\n", "no run-on line");
        assert!(!body.contains("\n.zero/\n"), "ZERO.md at the root is not covered by it");

        assert!(!ensure_memos_ignored(&dir), "check-ignore now says it's covered");
        assert_eq!(body.matches(".zero/memos/").count(), 1);
        assert_eq!(std::fs::read_to_string(dir.join(".gitignore")).unwrap(), body);

        // a repository that already ignores it another way is left alone —
        // including every project that got v1's wider line
        let init = |at: &Path| {
            Command::new("git")
                .current_dir(at)
                .env("PATH", repaired_path())
                .args(["init", "-q", "."])
                .output()
                .unwrap();
        };
        let wide = temp("gitignore-wide");
        init(&wide);
        std::fs::write(wide.join(".gitignore"), ".z*\n").unwrap();
        assert!(!ensure_memos_ignored(&wide));

        let legacy = temp("gitignore-legacy");
        init(&legacy);
        std::fs::write(legacy.join(".gitignore"), "# zero: local voice memos\n.zero/\n").unwrap();
        assert!(!ensure_memos_ignored(&legacy), "the old line already covers the new path");

        // and somewhere that isn't a repository gets no .gitignore invented
        let bare = temp("gitignore-none");
        assert!(!ensure_memos_ignored(&bare));
        assert!(!bare.join(".gitignore").exists());

        for dir in [dir, wide, legacy, bare] {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}
