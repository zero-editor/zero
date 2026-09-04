import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, Memo, MemoProbe } from "./api";

/**
 * The memos tab's state, held by the workspace rather than the panel.
 *
 * The same reason the search panel's state lives up there: the sidebar renders
 * one tab at a time, so a panel that owned this would drop the list — and the
 * elapsed timer, and the badge — every time you looked at the file tree, and
 * ⌘B would do it again. The recording itself is Rust's and survives all of
 * that regardless; what would go dark is everything you'd want to see about
 * it, which is worse than losing a list.
 *
 * The mic level is the exception, and it goes the other way: it's module state
 * with a subscription of its own, because a value that changes ten times a
 * second has no business re-rendering a workspace. See `useMemoLevel`.
 */

/**
 * Where a memo's artifacts live, all of them sharing the id as their stem.
 *
 * `takes` is how many follow-ups were recorded on top of it, and it moves the
 * raw transcript: take n's words are in `<id>.<n>.raw.txt`, and the take that
 * matters is the newest one. That's the right default rather than a choice —
 * ⌥ asks for the raw exactly when the cleaned version reads wrong, and after a
 * merge the recording you distrust is the one that just landed on it. The `.md`
 * doesn't move: there is one document, and every take is folded into it.
 */
export const memoPaths = (root: string, id: string, takes = 0) => ({
  md: `${root}/.zero/memos/${id}.md`,
  raw: memoTakeRaw(root, id, takes + 1),
});

/**
 * Take k's own transcript — the plain stem for the base recording, the numbered
 * one after it. Takes are counted from 1 here, unlike the filenames: the base
 * recording *is* take 1, it simply wears no number, and a thread that walks a
 * memo from its first word has no use for an off-by-one it has to remember.
 */
export const memoTakeRaw = (root: string, id: string, take: number) =>
  `${root}/.zero/memos/${take <= 1 ? id : `${id}.${take}`}.raw.txt`;

/**
 * Take k's recording, numbered exactly as its transcript is.
 *
 * Derived rather than read: the wire carries one audio filename per memo, and a
 * thread wants one per take. The `.m4a` in it is the assumption — the recorder
 * writes m4a and only falls back to `.caf` when the conversion failed, and a
 * `.caf` is a container WebKit will not play. That needs no test of its own:
 * the derived path isn't there, the read fails, and whatever offered to play it
 * stops offering.
 */
export const memoTakeAudio = (root: string, id: string, take: number) =>
  `${root}/.zero/memos/${take <= 1 ? id : `${id}.${take}`}.m4a`;

/**
 * The document as take k left it. Rust copies one of these beside the `.md`
 * after every successful pass, which is what makes a memo readable as an
 * exchange rather than as its latest answer.
 *
 * Numbered from 1 including the base pass, because `<id>.md` is the current
 * document and can't also be the first one. Nothing derives these from the wire
 * — there is no field for them — so the take count is the whole index: a memo
 * with n takes has versions 1…n+1, and the last of them is the `.md` itself.
 */
export const memoVersion = (root: string, id: string, take: number) =>
  `${root}/.zero/memos/${id}.${take}.md`;

/**
 * The `claude` call behind take k's document, as Rust left it: a shell script
 * that runs the same call again — every argument and the whole of stdin,
 * verbatim. Numbered exactly as the version it sits beside, and written on
 * every outcome, so a take that failed has one too. A memo from before the
 * record was kept simply has none, and the thread offers nothing for it.
 */
export const memoCall = (root: string, id: string, take: number) =>
  `${root}/.zero/memos/${id}.${take}.claude.sh`;

/** The title the pipeline gives a memo it found no words in. It's `ready` and
 *  it has a raw transcript, but no cleaned `.md` — nothing was worth an LLM
 *  call — so its thread is a turn of silence and nothing came back. */
const NO_SPEECH = "(no speech detected)";

/** transcription is done and left something on disk to look at */
const transcribed = (m: Memo) =>
  m.status === "transcribed" ||
  m.status === "cleaning" ||
  m.status === "ready" ||
  m.status === "cleanup_failed";

export const failed = (m: Memo) =>
  m.status === "transcribe_failed" || m.status === "cleanup_failed";

/**
 * The file ⌥ opens: the words as they were heard, which is what you want
 * exactly when the cleaned version reads wrong — and nothing at all before
 * transcription has produced anything worth a tab.
 *
 * Which transcript that is moves while a follow-up goes through the pipeline:
 * the newest take has none until it has one, so this falls back to the take
 * behind it rather than to a path with nothing at the end of it. A memo with
 * takes always has one, because it came back once already.
 *
 * The other half of this — which file *is* the memo — was a question the panel
 * had to answer while a click opened a file. A click opens the thread now, and
 * the thread reads every one of them.
 */
export function memoRaw(root: string, m: Memo): string | null {
  const landed = transcribed(m);
  if (!landed && m.takes === 0) return null;
  return memoPaths(root, m.id, landed ? m.takes : m.takes - 1).raw;
}

/* ---------- how a memo reads ----------
   The words a memo is described in, in one place, now that two things draw the
   same memo: the row in the panel and the thread the row opens. A phrase that
   lived in only one of them would drift the first time the other was edited —
   and `merging…` meaning "a follow-up is being folded in" is the sort of thing
   that has to say the same in both places or say nothing. */

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** what a memo is called before the cleanup has given it a name */
export function stamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "memo";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${hh}:${mm}`;
}

/** m:ss — a memo long enough to need an hours field is a forgotten mic, and
 *  the recorder stops itself before that */
export function clock(seconds: number): string {
  if (!Number.isFinite(seconds)) return "0:00";
  const t = Math.max(0, Math.round(seconds));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

/* `· 2 takes` used to live here, for the row's tooltip and the thread's header
   strip. Both are gone: the thread hangs a numbered header over every take it
   draws, which counts them by showing them, and the row said it in a tooltip
   nobody hovers long enough to read. */

/** a project by the name its own row calls it — the last segment of its root */
export const projectName = (path: string) => path.split("/").filter(Boolean).pop() ?? path;

/**
 * What the pipeline is doing to this memo, or null when the answer is nothing —
 * which is when there is a length to show instead, or a document to read.
 */
export function memoWork(m: Memo, downloading: boolean): string | null {
  // A paused mic is holding the recording open and hearing nothing, which is
  // not what `recording…` says. The word belongs here rather than in the
  // buttons for this section's reason: the row, the thread's pending turn and
  // the control cluster all have to call the same state the same thing.
  if (m.status === "recording") return m.paused ? "paused" : "recording…";
  if (m.queued) return "waiting";
  if (m.status === "transcribing") return downloading ? "downloading speech model…" : "transcribing…";
  // the same `claude -p`, but what it's doing to a memo that has takes is
  // folding the new words into the document rather than distilling one
  if (m.status === "cleaning") return m.takes > 0 ? "merging…" : "cleaning…";
  return null;
}

/** What a memo is called on a tab and at the top of its thread: the title the
 *  cleanup gave it, the timestamp it wore before that, and — for a memo the
 *  list no longer has — the id, which is still the name of its files. */
export const memoLabel = (m: Memo | null | undefined, id: string) =>
  m ? (m.title ?? stamp(m.created)) : id;

/* ---------- how a take sounds ----------
   The envelope of a recording, in the number of bars a voice message has worn
   since voice messages: enough to tell a sentence from a silence at a glance,
   too few to be mistaken for a scrubber. Which is the whole claim it makes —
   the thread plays a take back to check it against its transcript, and this is
   the shape of the thing being checked, not an editor for it. */

/** how many bars a take is drawn as, and the unit its progress steps in */
export const WAVE_BARS = 24;

/**
 * One decode per audio file per session, shared by every thread that draws it.
 *
 * The promise is what's cached rather than the answer: two take cards
 * mounting in the same frame would otherwise both read the file and both
 * decode it. A resolved `null` is a real answer and stays cached — a `.caf`
 * fallback WebKit can't open, or a file that isn't there — so a take with
 * nothing to draw is asked about once and then simply draws nothing.
 */
const waves = new Map<string, Promise<number[] | null>>();

/** RMS per bucket, normalised to the loudest one: a quiet recording is drawn
 *  as loudly as a shouted one, because what the shape is for is finding the
 *  silences and the sentences in it, and an absolute scale hides both. */
async function decodeWave(path: string): Promise<number[] | null> {
  // The read first, and a failed read forgotten rather than cached: the decode
  // verdict below is about the bytes and deserves its permanence, but a read
  // can fail for reasons of the moment, and one bad moment shouldn't cost a
  // take its waveform for the rest of the session.
  let bytes: ArrayBuffer;
  try {
    bytes = await api.readBinary(path);
  } catch {
    waves.delete(path);
    return null;
  }
  // A context per decode, closed the moment it has answered. WebAudio is here
  // to read a file, not to play one — playback is an <audio> element, and an
  // open context left behind for every take in a thread is a hardware voice
  // held for a picture. Opened only once there are bytes: a file that isn't
  // there costs no context at all, and a webview that refuses to give us one
  // more is an answer of `null` like any other rather than a rejection nothing
  // is waiting to catch.
  let ctx: AudioContext | null = null;
  try {
    ctx = new AudioContext();
    const audio = await ctx.decodeAudioData(bytes);
    const pcm = audio.getChannelData(0); // one voice, one mic: channel 0 is all of it
    const per = Math.max(1, Math.floor(pcm.length / WAVE_BARS));
    const buckets: number[] = [];
    for (let b = 0; b < WAVE_BARS; b++) {
      const from = b * per;
      const to = Math.min(from + per, pcm.length);
      let sum = 0;
      for (let i = from; i < to; i++) sum += pcm[i] * pcm[i];
      buckets.push(to > from ? Math.sqrt(sum / (to - from)) : 0);
    }
    const loudest = Math.max(...buckets);
    return loudest > 0 ? buckets.map((v) => v / loudest) : buckets;
  } catch {
    // unreadable, undecodable, or gone. The same rule the play button follows:
    // an offer this take can't keep stops being made.
    return null;
  } finally {
    void ctx?.close();
  }
}

export const memoWaveOf = (path: string): Promise<number[] | null> => {
  const had = waves.get(path);
  if (had) return had;
  const next = decodeWave(path);
  waves.set(path, next);
  return next;
};

/* ---------- the event bus ----------
   Rust emits to the window, not to a panel, so every project's events arrive
   everywhere. One lazily-started listener per event name, dispatched by root —
   the ptyBus arrangement, for the same reason: N panels shouldn't each
   deserialize a level event that belongs to one of them. */

interface Sink {
  update: (m: Memo) => void;
  notice: (message: string) => void;
}

const sinks = new Map<string, Sink>();

/**
 * Which project holds the mic, and which memo it's filling.
 *
 * Module state because the mic is one resource for the whole app: a panel has
 * to be able to say "recording in <somewhere else>" about a memo that will
 * never appear in its own list. Fed by every update, ours or not.
 */
let holder: { root: string; id: string } | null = null;
const watchers = new Set<() => void>();

/** every panel that isn't getting this event still has to hear about it */
const tellWatchers = () => {
  for (const w of watchers) w();
};

/* ---------- the views' subscription ----------
   The sink above is the panel's, and there is one panel per project. A thread
   view is not that: several can be open at once, none of them owns the list,
   and the only thing any of them wants to know is "something happened to a memo
   here, go and read the files again". So they get a set of their own, fed by
   the same listener — the sink mechanism is left exactly as it was rather than
   grown a second subscriber shape. */

const viewers = new Map<string, Set<() => void>>();

/**
 * Called after every `memo-update` for `root`, once per open view. Returns the
 * unsubscribe, so an effect can hand it straight back.
 */
export function subscribeMemos(root: string, cb: () => void): () => void {
  // a thread view can outlive the panel that opened it — a memos tab you
  // switched away from is unmounted, and its listener would go with it
  ensureStarted();
  const subs = viewers.get(root) ?? new Set<() => void>();
  viewers.set(root, subs);
  subs.add(cb);
  return () => {
    subs.delete(cb);
    if (!subs.size) viewers.delete(root);
  };
}

/* ---------- the mic level ----------
   A level event lands 8–12 times a second for the whole of a recording, and
   the only thing in the app that draws one is a single dot. Held here rather
   than in `useMemos`'s state because that hook lives in the workspace: state
   there would re-render the entire subtree at that rate, panel open or not.
   An event for a root nobody is watching is a map write and nothing else. */

const levels = new Map<string, number>();
const levelWatchers = new Map<string, Set<() => void>>();

function setLevel(root: string, rms: number) {
  if (levels.get(root) === rms) return;
  levels.set(root, rms);
  const subs = levelWatchers.get(root);
  if (subs) for (const s of subs) s();
}

/**
 * The newest mic level for a project, 0–1 exactly as the helper measured it.
 *
 * A hook of its own so the thing that reads it can be a leaf that renders the
 * dot and nothing else — which is the whole point of keeping the level out of
 * the workspace's state.
 */
export function useMemoLevel(root: string): number {
  const subscribe = useCallback(
    (fn: () => void) => {
      const subs = levelWatchers.get(root) ?? new Set<() => void>();
      levelWatchers.set(root, subs);
      subs.add(fn);
      return () => {
        subs.delete(fn);
        if (!subs.size) levelWatchers.delete(root);
      };
    },
    [root]
  );
  return useSyncExternalStore(subscribe, () => levels.get(root) ?? 0);
}

let started = false;

function ensureStarted() {
  if (started) return;
  started = true;
  listen<{ root: string; memo: Memo }>("memo-update", (e) => {
    const { root, memo } = e.payload;
    const before = holder?.root ?? null;
    // A recording that starts or ends leaves no glow behind it either way —
    // and neither does one that pauses, which arrives here as a `recording`
    // update like any other. That is what rests the bars: level events stop
    // for the length of a pause, and without this they would hold whatever
    // syllable they were drawing when the mic stopped.
    if (memo.status === "recording") {
      holder = { root, id: memo.id };
      setLevel(root, 0);
    } else if (holder?.id === memo.id) {
      holder = null;
      setLevel(root, 0);
    }
    // only the panels that aren't getting this event need telling
    if ((holder?.root ?? null) !== before) tellWatchers();
    sinks.get(root)?.update(memo);
    // and every thread view of this project, because a memo that moved is a
    // file that may have appeared underneath it
    const views = viewers.get(root);
    if (views) for (const v of views) v();
  });
  // straight to the level store rather than through a sink: the map is worth
  // writing even for a project whose panel nobody has open
  listen<{ root: string; rms: number }>("memo-level", (e) => {
    setLevel(e.payload.root, e.payload.rms);
  });
  listen<{ root: string; message: string }>("memo-notice", (e) => {
    sinks.get(e.payload.root)?.notice(e.payload.message);
  });
}

/* ---------- the unseen ledger ----------
   A memo that came back while you were elsewhere is the one thing this feature
   has to tell you about, and it stops being news the moment you look at the
   tab. The ledger is module-level so that reading it survives the panel — and
   the whole project tab — being closed and opened again in the same session. */

const seen = new Set<string>();
/** ids are unique inside a project by construction, not across them. The
 *  separator is a NUL as an escape rather than as itself: a raw one in the
 *  source makes grep call this whole file binary and refuse to print a line
 *  of it, which is a strange price to pay for a byte no path can contain. */
const seenKey = (root: string, id: string) => `${root}\u0000${id}`;

/** Decide whether a finished memo counts as news, and record the decision. */
function note(
  root: string,
  m: Memo,
  history: boolean,
  viewing: boolean,
  mark: (id: string) => void
) {
  if (m.status !== "ready") return;
  const key = seenKey(root, m.id);
  if (seen.has(key)) return;
  // Everything already finished the first time a project is listed is history,
  // not news — opening a project after a week of memos shouldn't arrive lit —
  // and so is anything that finishes while you're watching it happen.
  if (history || viewing) seen.add(key);
  else mark(m.id);
}

/* ---------- failures ---------- */

/**
 * The one error worth rewriting. The system's own words for a denied mic say
 * nothing about where to go and undo it, and zero can't take you there either:
 * the microphone pane is an `x-apple.systempreferences:` URL and `open_url`
 * speaks http(s) only. So the path is written out and you walk it.
 */
const MIC_DENIED =
  "mic access is off for zero — System Settings → Privacy & Security → Microphone, then press record again.";

function explain(e: unknown): string {
  const text = String(e).split("\n").slice(0, 3).join(" ").trim();
  return /mic_denied|microphone|mic access/i.test(text) ? MIC_DENIED : text;
}

/**
 * The probe is about the machine, not the project, so every panel shares one
 * answer.
 *
 * Shares a *yes*, at least. A no can be the Mac — macOS 25, no helper in the
 * bundle — or it can be a bad moment: a helper that failed to spawn, a probe
 * that timed out waiting for the speech assets to wake up. Rust stopped
 * caching the second kind, and this side must not cache it either, or the
 * feature stays dark for the rest of the webview session on a machine that
 * could have done it. So a false answer is handed to whoever is waiting and
 * then forgotten, and the next panel mount asks again.
 */
let probing: Promise<MemoProbe> | null = null;
const probeOnce = () =>
  (probing ??= api
    .memoProbe()
    .catch((e): MemoProbe => ({ supported: false, message: explain(e) }))
    .then((p) => {
      if (!p.supported) probing = null;
      return p;
    }));

/**
 * The verb an action is in flight for, which is what the button doing it says
 * while it waits.
 *
 * `busy` was one flag for all of them, and one flag has one word: with four
 * verbs on the bar at once, pressing pause made the stop button next to it read
 * `stopping…` for the length of a round trip. The flag is still here — nothing
 * may be pressed twice while the mic is being told something — but the word is
 * now the one that was actually asked for.
 */
export type MemoAction = "start" | "stop" | "pause" | "resume" | "cancel" | "import";

/** What the import picker offers: the formats Core Audio reads, because that
 *  is what the backend converts through. Anything else fails at the press with
 *  the converter's reason rather than dying later in the pipeline. */
const AUDIO_EXTENSIONS = ["m4a", "mp3", "wav", "aiff", "aif", "caf", "flac", "aac", "mp4"];

export interface Memos {
  /** newest first, the order `memo_list` returns */
  memos: Memo[];
  /** null until the probe answers; an unsupported one is the panel's whole body */
  probe: MemoProbe | null;
  /** this project's live recording, when the mic is here */
  recording: Memo | null;
  /** the root of the project holding the mic, when it isn't this one */
  elsewhere: string | null;
  /** the memo just recorded here: lit in the list while the pipeline has it,
   *  and opened in the editor the moment it comes back ready */
  followed: string | null;
  notice: string | null;
  dismissNotice: () => void;
  /** the OS looks to be fetching its speech model, as far as a notice can say */
  downloading: boolean;
  /** something in this project is transcribing, cleaning, or waiting to */
  working: boolean;
  /** a memo came back while you were looking somewhere else */
  unseenReady: boolean;
  /** an action is in flight — the record row can't be pressed twice */
  busy: boolean;
  /** which one it is, for the button that has to say so */
  doing: MemoAction | null;
  /**
   * The instant the clock stopped at, while the recording is paused; null the
   * rest of the time. Read in place of `now` by everything that draws the
   * elapsed timer.
   *
   * Held here rather than in the two components that show a timer, because
   * both of them are unmounted routinely — a tab switch closes the panel, and
   * another editor tab hides the thread — and a pause outlives either. Coming
   * back to a paused recording has to show the second it stopped on, not the
   * age of a `recording_since` that has been sitting still since.
   */
  frozen: number | null;
  start: () => void;
  /** record a follow-up onto a finished memo: the same mic, the same stop
   *  button, and a merge at the end instead of a cleanup */
  startTake: (id: string) => void;
  /** Pick an audio file recorded somewhere else and put it through the same
   *  pipeline — as a new memo, or with `into` as a follow-up onto a finished
   *  one. The mic is never involved, so this works while it's busy. */
  importMemo: (into?: string) => void;
  stop: () => void;
  /** hold the recording open with the mic switched off; `resume` picks it up
   *  where it stopped, with no silence recorded in between */
  pause: () => void;
  resume: () => void;
  /** throw the recording away — the whole memo if it was a first recording,
   *  only the take if it was a follow-up */
  cancel: () => void;
  retry: (id: string) => void;
  /** open a terminal on `claude /login`, for the one failure that is fixed by
   *  logging in rather than by trying again. The workspace supplies it,
   *  because the terminals are the workspace's. */
  signIn?: () => void;
  remove: (id: string) => void;
  /** absolute path, creating the file if it's missing; null if that failed */
  vocabularyPath: () => Promise<string | null>;
  refresh: () => void;
}

/** `enabled` = the feature is switched on in Preferences. Off is not a hidden
 *  panel: nothing below subscribes, nothing lists, and the hook returns the
 *  same shape saying there is nothing here — so a project with memos off pays
 *  neither the `memo_list` it opens with nor the listener behind it. It stays
 *  a hook either way, because a hook that isn't called is a hook that can't be
 *  turned back on without remounting the workspace under it.
 *
 *  `viewing` = the memos tab is on screen for this project, which is what reads
 *  the badge. It is not what keeps anything alive: the pipeline is Rust's.
 *  `onReady` is handed the id of a memo recorded here the moment it finishes,
 *  so the workspace can open its thread — the ramble ends in reading. The id
 *  rather than the path it used to be: a thread is opened by memo, and the
 *  files it reads are its own business. */
export function useMemos(
  root: string,
  enabled: boolean,
  viewing: boolean,
  onReady?: (id: string) => void,
  onSignIn?: () => void
): Memos {
  const [memos, setMemos] = useState<Memo[]>([]);
  const [probe, setProbe] = useState<MemoProbe | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [doing, setDoing] = useState<MemoAction | null>(null);
  const [unseen, setUnseen] = useState<Set<string>>(new Set());

  // read inside callbacks that must not be rebuilt every time the tab changes
  const viewingRef = useRef(viewing);
  viewingRef.current = viewing;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  // The memo whose pipeline the user is waiting on: the one they just recorded
  // here. A ref beside the state because the event sink reads it without
  // wanting to re-subscribe every time it changes.
  const [followed, setFollowed] = useState<string | null>(null);
  const followRef = useRef<string | null>(null);
  const follow = useCallback((id: string | null) => {
    followRef.current = id;
    setFollowed(id);
  }, []);

  const mark = useCallback(
    (id: string) => setUnseen((prev) => (prev.has(id) ? prev : new Set(prev).add(id))),
    []
  );

  // `memo_list` is also the reconcile-and-resume call, so every action ends in
  // one: whatever the Rust side did about a stalled pipeline lands here
  const list = useCallback(
    async (history: boolean) => {
      try {
        const found = await api.memoList(root);
        setMemos(found);
        // A recording can end without a terminal update to end it with: a mic
        // denial that arrives after the row did, or within the 800ms the start
        // command waits, and a delete of the memo being recorded. Nothing then
        // clears the mic holder, and every other project spends the rest of
        // the session saying "recording in <here>" with its record button
        // disabled. Every one of those routes ends in a list — the notice
        // handler re-lists, and so does every action's `finally` — so this is
        // where it heals: we say we hold the mic, the list says otherwise, and
        // the list is the one that just came from Rust.
        const held = holder;
        if (held?.root === root && !found.some((m) => m.id === held.id && m.status === "recording")) {
          holder = null;
          setLevel(root, 0);
          tellWatchers();
        }
        // a followed memo that vanished — deleted, or its recording failed —
        // has nothing left to open
        if (followRef.current && !found.some((m) => m.id === followRef.current)) follow(null);
        for (const m of found) note(root, m, history, viewingRef.current, mark);
      } catch (e) {
        setNotice(explain(e));
      }
    },
    [root, mark]
  );

  // The list is what launch actually needs: the badge, and the reconcile-and-
  // resume pass that picks a pipeline back up where the last quit dropped it —
  // one IPC call that early-outs when the project has never recorded anything.
  // The probe is neither of those. It spawns the helper, and a process at
  // every cold open to answer a question only the panel's body asks is launch
  // time spent on a tab that may never be looked at. So it waits for the tab.
  useEffect(() => {
    if (!enabled) {
      // Switched off. The list goes, and so does the recording if this project
      // is the one holding the mic: a live microphone behind a switch that
      // says off is the one outcome this must not have, and there is nowhere
      // left to show a red dot. It is thrown away rather than finished,
      // because the pipeline it would run into is the part being turned off.
      setMemos([]);
      follow(null);
      if (holder?.root === root) void api.memoRecordCancel().catch(() => {});
      return;
    }
    void list(true);
  }, [list, enabled, root, follow]);

  useEffect(() => {
    if (!enabled || !viewing || probe) return;
    let live = true;
    probeOnce().then((p) => {
      if (live) setProbe(p);
    });
    return () => {
      live = false;
    };
  }, [enabled, viewing, probe]);

  useEffect(() => {
    if (!enabled) return;
    ensureStarted();
    const sink: Sink = {
      update: (m) => {
        // a memo that arrives by event is always the newest there is, so
        // prepending keeps the list in the order `memo_list` hands it over in
        setMemos((prev) =>
          prev.some((x) => x.id === m.id) ? prev.map((x) => (x.id === m.id ? m : x)) : [m, ...prev]
        );
        note(root, m, false, viewingRef.current, mark);
        // The memo the user just recorded opens itself the moment it's ready —
        // reading it is what the whole pipeline was pressed into motion for.
        // A silent one has nothing worth a tab, and a failed one keeps its lit
        // place in the list so the retry sits exactly where the wait was.
        if (m.id === followRef.current && m.status === "ready") {
          follow(null);
          seen.add(seenKey(root, m.id));
          setUnseen((prev) => {
            if (!prev.has(m.id)) return prev;
            const next = new Set(prev);
            next.delete(m.id);
            return next;
          });
          if (m.title !== NO_SPEECH) onReadyRef.current?.(m.id);
        }
      },
      // A notice can be the only trace of a memo the backend gave up on — a
      // mic denial after the row appeared deletes the stub, and there is no
      // removal event to carry that — so hearing one also re-reads the list.
      notice: (message) => {
        setNotice(message);
        void list(false);
      },
    };
    sinks.set(root, sink);
    return () => {
      if (sinks.get(root) === sink) sinks.delete(root);
    };
  }, [enabled, root, mark, list, follow]);

  // Who holds the mic is module state rather than React's, so a change there
  // has to re-render the panels it wasn't addressed to.
  const [, sync] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const w = () => sync((n) => n + 1);
    watchers.add(w);
    return () => {
      watchers.delete(w);
    };
  }, [enabled]);

  // Looking at the tab reads the badge — including memos that land while you're
  // already there. Keyed on the ids rather than the array so that a re-render
  // for some other reason doesn't re-run it.
  const readyIds = memos
    .filter((m) => m.status === "ready")
    .map((m) => m.id)
    .join(" ");
  useEffect(() => {
    if (!viewing) return;
    for (const id of readyIds ? readyIds.split(" ") : []) seen.add(seenKey(root, id));
    setUnseen((prev) => (prev.size ? new Set() : prev));
  }, [viewing, readyIds, root]);

  /** every action ends the same way: surface the failure, then re-read the list.
   *  `what` is only there to be said out loud by the button that is waiting. */
  const run = useCallback(
    async (what: MemoAction | null, fn: () => Promise<unknown>) => {
      setDoing(what);
      setNotice(null);
      try {
        await fn();
      } catch (e) {
        setNotice(explain(e));
      } finally {
        setDoing(null);
        void list(false);
      }
    },
    [list]
  );

  const start = useCallback(() => {
    setLevel(root, 0); // no stale reading from the last recording on the new dot
    void run("start", async () => {
      // this recording becomes the one being waited on, from here to ready
      follow(await api.memoRecordStart(root));
    });
  }, [run, root, follow]);

  // The same shape as `start`, and deliberately so: a take is a recording like
  // any other. Following the id it comes back with — the memo's own — is what
  // lights the row from the first second and opens the revised document when
  // the merge lands, both of which the followed machinery already does.
  const startTake = useCallback(
    (id: string) => {
      setLevel(root, 0);
      void run("start", async () => follow(await api.memoRecordStart(root, id)));
    },
    [run, root, follow]
  );

  // The same follow as the two above, minus the mic: a memo made of somebody
  // else's recording is still the memo being waited on, from the press to
  // ready. A dismissed picker is a decision, not an error, so it runs the
  // action to its quiet end rather than throwing something for the notice.
  const importMemo = useCallback(
    (into?: string) => {
      void run("import", async () => {
        const title = into ? "import a follow-up recording" : "import a voice recording";
        // Never the dialog plugin, in any build. Its file panel takes zero
        // down: macOS 26 hands back a NULL `NSOpenPanel` and objc2 panics on
        // the NULL rather than returning it, so pressing import was a way to
        // quit the app — in the dev build and in released 0.37.0 alike, where
        // it was reported and reproduced.
        //
        // Note what is *not* the explanation, because the obvious one is
        // wrong: this is not about the unbundled binary `tauri dev` runs.
        // `pickProject` calls the same plugin for a *folder* in the shipped
        // app and works. The file panel is the one that dies, and until that
        // is understood it does not get called here.
        //
        // osascript is asked for the same panel instead — bundled, and the
        // route "open project" already takes in dev. `choose file` takes the
        // extensions the plugin's filters would have.
        const path = await api.pickFile(title, AUDIO_EXTENSIONS);
        if (typeof path !== "string") return;
        follow(await api.memoImport(root, path, into));
      });
    },
    [run, root, follow]
  );

  const stop = useCallback(() => void run("stop", () => api.memoRecordStop()), [run]);

  // The level is zeroed here as well as on the update that comes back, and for
  // the same reason `start` zeroes it: the bars must not be left holding the
  // last syllable the mic heard before it stopped listening. Belt and braces —
  // the update is what normally does it, and this is a paused meter that reads
  // right even if it never arrives.
  const pause = useCallback(() => {
    setLevel(root, 0);
    void run("pause", () => api.memoRecordPause());
  }, [run, root]);

  const resume = useCallback(() => void run("resume", () => api.memoRecordResume()), [run]);

  // No confirmation. What this throws away is seconds old and can be said
  // again — the delete in the panel asks because the memo it deletes may be
  // weeks of thinking, and speech is unrecoverable; a recording you are still
  // in the middle of is neither. The dialog would also be the wrong shape: the
  // mic goes on running underneath it while you read.
  const cancel = useCallback(() => {
    // and it is no longer the recording being waited on — a memo that was
    // thrown away has nothing to open when it comes back, because it won't
    follow(null);
    void run("cancel", () => api.memoRecordCancel());
  }, [run, follow]);

  const retry = useCallback(
    (id: string) => {
      const why = memos.find((m) => m.id === id)?.error;
      void run(null, async () => {
        await api.memoRetry(root, id);
        // the row had room for the word "failed" and nothing else; pressing it
        // is where the reason gets said out loud
        if (why) setNotice(why);
      });
    },
    [memos, root, run]
  );

  const remove = useCallback(
    (id: string) => void run(null, () => api.memoDelete(root, id)),
    [run, root]
  );

  const vocabularyPath = useCallback(async () => {
    try {
      return await api.memoVocabularyPath(root);
    } catch (e) {
      setNotice(explain(e));
      return null;
    }
  }, [root]);

  const dismissNotice = useCallback(() => setNotice(null), []);
  const refresh = useCallback(() => void list(false), [list]);

  const recording = memos.find((m) => m.status === "recording") ?? null;

  // The clock stops the moment the pause is *seen*, which is the honest reading
  // of it: `recording_since` stays where it was for the whole pause, so a timer
  // left counting from it would count the silence too. Nothing needs to be
  // stored when it resumes — the backend rebases `recording_since` and the
  // subtraction is true again on its own.
  const held = recording?.paused ?? false;
  const [frozen, setFrozen] = useState<number | null>(null);
  useEffect(() => {
    setFrozen(held ? Date.now() : null);
  }, [held, recording?.id]);

  return {
    memos,
    probe,
    recording,
    elsewhere: holder && holder.root !== root ? holder.root : null,
    followed,
    notice,
    dismissNotice,
    // The one-time speech-model download surfaces as a notice and nowhere else,
    // so the row waiting on it borrows the notice to say what it's waiting for.
    // If that wording ever changes the row just says `transcribing…` again —
    // the detail is what's lost, not the feature.
    downloading:
      notice !== null && /model/i.test(notice) && memos.some((m) => m.status === "transcribing"),
    working: memos.some((m) => m.queued || m.status === "transcribing" || m.status === "cleaning"),
    unseenReady: memos.some((m) => unseen.has(m.id)),
    busy: doing !== null,
    doing,
    frozen,
    start,
    startTake,
    importMemo,
    stop,
    pause,
    resume,
    cancel,
    retry,
    signIn: onSignIn,
    remove,
    vocabularyPath,
    refresh,
  };
}
