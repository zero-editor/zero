import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { api, type Memo } from "../lib/api";
import {
  clock,
  failed,
  memoCall,
  memoPaths,
  memoTakeAudio,
  memoTakeRaw,
  memoVersion,
  memoWaveOf,
  memoWork,
  projectName,
  stamp,
  subscribeMemos,
  WAVE_BARS,
  type Memos,
} from "../lib/memos";
import { miniMarkdown } from "../lib/miniMarkdown";
import { useSettings } from "../lib/settings";
import {
  CopyGlyph,
  ImportGlyph,
  MemoControls,
  MicGlyph,
  PauseGlyph,
  PlayGlyph,
  SendGlyph,
} from "./MemoPanel";

/**
 * A memo as the exchange it actually is: what you said, what came back, take by
 * take, oldest at the top.
 *
 * The files stay the source of truth and this view stays a reading of them —
 * every turn on screen is a file in `.zero/memos/`, re-read rather than cached
 * anywhere, and the breadcrumb above opens the document as the file it also is.
 * Nothing here writes a file itself: it plays a take back, it works the mic —
 * start, stop, pause, throw away — and it takes words typed or pasted into the
 * box at its foot, which become a take like a recording would. All of those
 * are the panel's verbs, done through the panel's hook so that the mic stays
 * one resource with one owner and a written take follows the same path.
 *
 * It draws no title of its own. The tab says what this memo is called and the
 * document's own `# ` heading says it again a line below; a third copy in
 * between was three names for one thing and an inch of the window.
 *
 * The last turn is the exception that makes the rest honest: it always shows the
 * current `<id>.md` rather than the snapshot that produced it, so a document
 * someone edited by hand reads as what it now says, not as what the merge left.
 */

/**
 * Everything the thread draws, off disk. Both arrays are `takes + 1` long —
 * take 1 is the memo's own recording — and a null is a file that isn't there: a
 * transcript the pipeline hasn't written yet, or a document from a memo made
 * before per-take documents were kept, which simply shows one turn fewer.
 */
interface Thread {
  raws: (string | null)[];
  docs: (string | null)[];
  /** whether the call behind take k is on disk — only asked after in
   *  developer mode, and all false outside it, since nothing else reads it */
  calls: boolean[];
}

const readText = (path: string) => api.readFile(path).catch(() => null);

/**
 * One document turn, parsed once per text rather than once per render. The
 * thread re-renders on every whole second of playback and every half-second of
 * a recording's timer, and re-walking every turn's markdown each time to build
 * the same elements was the largest cost in it — the parser is cheap, but not
 * four-times-a-second-for-every-turn cheap.
 */
const MemoDoc = memo(function MemoDoc({ text }: { text: string }) {
  return <div className="memo-turn doc">{miniMarkdown(text)}</div>;
});

/**
 * Everything about listening to a take, on one line under its header: the
 * triangle, two dozen bars, and the clock — which is the arrangement every
 * voice message has worn since voice messages, and for the reason they wear it.
 * The bars are the envelope of what was said, brightening left to right as it
 * plays.
 *
 * It used to live in the header line, where it shared a row with the take's
 * number, its date and its length and pushed all three into a second line the
 * moment the pane got narrow. A header is what a thing is called; this is what
 * you do to it. They are not the same line.
 *
 * Still a picture and a play button and nothing in between — no scrubber, no
 * speed, no seek. What the shape adds is where the silences were, which is how
 * you find the sentence you are looking for in a four-minute ramble without
 * listening to the four minutes. Both halves are the same switch, so the bars
 * take a click too.
 *
 * Decoded once per file per session and drawn from cached numbers after that
 * (`memoWaveOf`), lazily: a thread of five takes reads five files on the way to
 * its first paint, and never again. A take that can't be decoded draws nothing
 * — not the bars and, now that they are one element, not the triangle either,
 * which is the rule the buttons already followed and the shape it should always
 * have had: the `.caf` fallback is a container WebKit will not open, and an
 * apology for it is worse than its absence.
 *
 * No tooltip on any of it. `hear this take as it was said` was a sentence
 * explaining a play triangle, which is the one glyph on earth that needs none;
 * the button keeps an `aria-label` and nothing hovers.
 */
function MemoPlayRow({
  path,
  /** sounding right now — the glyph is the only thing that says so */
  playing,
  /** how many bars the playhead has passed, 0 when this take isn't the one held */
  played,
  /** `0:12 / 4:07`, or null when this take isn't the one the speaker is holding */
  time,
  onToggle,
}: {
  path: string;
  playing: boolean;
  played: number;
  time: string | null;
  onToggle: () => void;
}) {
  const [bars, setBars] = useState<number[] | null>(null);
  useEffect(() => {
    let live = true;
    void memoWaveOf(path).then((b) => {
      if (live) setBars(b);
    });
    return () => {
      live = false;
    };
  }, [path]);
  if (!bars) return null;
  return (
    <div className="memo-play-row">
      <button
        className="memo-icon-btn memo-play"
        aria-label={playing ? "pause" : "play"}
        onClick={onToggle}
      >
        {playing ? <PauseGlyph /> : <PlayGlyph />}
      </button>
      <span className="memo-wave" onClick={onToggle}>
        {bars.map((v, i) => (
          <span
            key={i}
            className={i < played ? "on" : ""}
            style={{ "--v": v } as CSSProperties}
          />
        ))}
      </span>
      {time && <span className="memo-elapsed">{time}</span>}
    </div>
  );
}

/**
 * Which take the current `<id>.md` is the answer to.
 *
 * The last one that finished, which is the newest take only when the memo is
 * `ready`: while a follow-up is being recorded, transcribed or merged, the
 * document on disk is still the one the take before it produced — that is the
 * promise the pipeline makes, and drawing the take in flight with a document
 * under it would show the same text twice and credit it to the wrong words.
 * A memo the list doesn't have says nothing about what is running, and nothing
 * is: its files are as finished as they will get.
 */
const answeredTake = (m: Memo | null, takes: number) =>
  m && m.status !== "ready" ? takes : takes + 1;

/** One read of all of it. The answered take's document is the `.md` itself
 *  rather than its snapshot — the snapshot is what the pass wrote, the file is
 *  what it says now, and the difference between them is a hand edit. */
async function readThread(
  root: string,
  id: string,
  takes: number,
  answered: number,
  developer: boolean
): Promise<Thread> {
  const ks = Array.from({ length: takes + 1 }, (_, i) => i + 1);
  const documentOf = (k: number) => {
    // a take that hasn't been answered yet has no document, and no file to go
    // looking for one in
    if (k > answered) return null;
    return readText(k === answered ? memoPaths(root, id).md : memoVersion(root, id, k));
  };
  // The record is a few kilobytes, so a read is the existence check: there is
  // no stat over the wire, and a button that opens nothing is worse than no
  // button. Not asked after outside developer mode — those reads would be IPC
  // spent on a file nobody is about to be shown.
  const callOf = (k: number) =>
    developer ? readText(memoCall(root, id, k)).then((t) => t !== null) : Promise.resolve(false);
  const [raws, docs, calls] = await Promise.all([
    Promise.all(ks.map((k) => readText(memoTakeRaw(root, id, k)))),
    Promise.all(ks.map(documentOf)),
    Promise.all(ks.map(callOf)),
  ]);
  return { raws, docs, calls };
}

/**
 * The one control at the foot of a thread: a chat box. Words go in at the top —
 * typed as a reply, or a transcript made somewhere else pasted whole — and
 * everything else a memo can be given sits on the box's own bottom edge, the
 * way every chat app arranges it: a recording from a file on the left, and on
 * the right the mic beside the arrow that sends. Enter sends and ⇧Enter breaks
 * the line.
 *
 * There used to be a box above a bar of buttons, which was two controls for
 * one act — adding the next turn — and read as a form. One box says what this
 * is: the place the next thing you say goes, whichever way you say it.
 *
 * While a recording is live here, the box *is* the recording: the text gives
 * way to the mic's controls, the same cluster the panel's floor grows, until
 * the recording ends. The words that were in it are kept, not thrown away.
 *
 * It grows with what is in it up to a limit and scrolls past that — a pasted
 * ten-minute transcript is a normal thing to put here, and it must not push the
 * thread off the top of the pane.
 *
 * Typing is never what's blocked. A memo still merging can't take another turn
 * yet, and the box says why in its placeholder while it's empty — but the next
 * thing can be drafted while the last one comes back, and only the send waits.
 * What was typed is cleared once the backend has it and not before: a send
 * that failed leaves the words where they were, with the reason under them.
 */
function MemoComposer({
  placeholder,
  blocked,
  notice,
  autoFocus,
  onSend,
  tools,
  mic,
  live,
}: {
  placeholder: string;
  /** why a send can't happen right now, or null when it can */
  blocked: string | null;
  /** the hook's notice, which is where a failed send's reason lands */
  notice: string | null;
  autoFocus?: boolean;
  /** true once the words are the pipeline's */
  onSend: (text: string) => Promise<boolean>;
  /** the left end of the box's edge */
  tools?: ReactNode;
  /** the right end, beside send */
  mic?: ReactNode;
  /** a recording in progress here: drawn in place of everything else */
  live?: ReactNode;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [failedSend, setFailedSend] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  // `auto` first, so a box that was grown by a paste shrinks again when it's
  // emptied; the stylesheet's max-height is where growing stops
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text, live]);

  const ready = blocked === null && !sending && text.trim() !== "";
  const send = async () => {
    if (!ready) return;
    setSending(true);
    setFailedSend(false);
    const ok = await onSend(text);
    setSending(false);
    if (ok) setText("");
    else setFailedSend(true);
  };

  return (
    <>
      <div
        className={`memo-compose ${live ? "live" : ""}`}
        // the whole box is the target, as it is in every chat: a click on its
        // padding or its empty edge puts the cursor in the text
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) {
            e.preventDefault();
            ref.current?.focus();
          }
        }}
      >
        {live ? (
          live
        ) : (
          <>
            <textarea
              ref={ref}
              rows={1}
              value={text}
              autoFocus={autoFocus}
              placeholder={blocked ?? placeholder}
              readOnly={sending}
              onChange={(e) => {
                setText(e.target.value);
                setFailedSend(false);
              }}
              onKeyDown={(e) => {
                // an IME mid-word uses Enter to commit the word, not the message
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <div className="memo-compose-edge">
              {tools}
              <span className="memo-compose-gap" />
              {mic}
              <button
                className={`memo-icon-btn memo-send ${ready ? "ready" : ""}`}
                title={blocked ?? "send (↵)"}
                aria-label="send"
                disabled={!ready}
                onClick={() => void send()}
              >
                <SendGlyph />
              </button>
            </div>
          </>
        )}
      </div>
      {failedSend && notice && <div className="memo-compose-err">{notice}</div>}
    </>
  );
}

/**
 * A memo before it has any words: an empty thread and the box at its foot,
 * opened from the pencil on the panel's floor. What is sent from here is the
 * new memo's first take, and the tab becomes that memo's thread the moment it
 * exists — the same tab, so the place you were typing in is the place the
 * answer arrives.
 *
 * The box is the thread's box, mic and file included, so a memo begun here can
 * still be said rather than written: those make a memo exactly as the floor's
 * buttons do, and hand this tab over to it the same way.
 */
export function MemoDraft({
  memos,
  onCreated,
}: {
  memos: Memos;
  /** the memo this draft turned into, to be shown in its place */
  onCreated: (id: string) => void;
}) {
  const other = memos.recording;
  const holder = memos.elsewhere;
  // the thread's rule for the mic: somebody else's recording is a reason, and
  // it is said rather than left as a dead button
  const micBlocked = other
    ? other.title
      ? `recording ${other.title}…`
      : "the mic is busy"
    : holder
      ? `recording in ${projectName(holder)}`
      : null;
  const handOver = (id: string | null) => {
    if (id) onCreated(id);
    return id !== null;
  };

  return (
    <div className="memo-thread">
      <div className="memo-thread-scroll">
        <div className="memo-thread-col memo-draft">
          <p>Write it, or paste a transcript you already have.</p>
          <p>It comes back distilled, the way a recording does — and you can keep going from there, in words or out loud.</p>
        </div>
      </div>
      <div className="memo-thread-foot">
        <MemoComposer
          placeholder="write or paste a memo…"
          blocked={null}
          notice={memos.notice}
          autoFocus
          onSend={async (text) => handOver(await memos.write(text))}
          tools={
            <button
              className="memo-icon-btn"
              title="import an audio file — it becomes a memo like any recording"
              aria-label="import an audio file"
              disabled={memos.busy}
              onClick={async () => void handOver(await memos.importMemo())}
            >
              <ImportGlyph />
            </button>
          }
          mic={
            <button
              className="memo-icon-btn"
              title={micBlocked ?? "record this memo instead"}
              aria-label="record"
              disabled={memos.busy || micBlocked !== null}
              onClick={async () => void handOver(await memos.start())}
            >
              <MicGlyph />
            </button>
          }
        />
      </div>
    </div>
  );
}

export function MemoThread({
  root,
  id,
  memos,
  visible,
  onOpenFile,
}: {
  root: string;
  id: string;
  memos: Memos;
  visible: boolean;
  /** open a file as a tab — the one way out of the thread that isn't the
   *  breadcrumb, used for the record of a call in developer mode */
  onOpenFile: (abs: string) => void;
}) {
  const memo = memos.memos.find((m) => m.id === id) ?? null;
  const takes = memo?.takes ?? 0;
  const answered = answeredTake(memo, takes);
  const present = memo !== null;
  // developer mode: the thread also reads, for every take, whether the call
  // behind it is on disk, and offers it under the turn
  const developer = useSettings().developer;

  // null until the first read lands: an empty thread and a thread nobody has
  // read yet look identical on screen, and only one of them is worth saying
  // something about
  const [thread, setThread] = useState<Thread | null>(null);

  useEffect(() => {
    let disposed = false;
    // Loads overlap — one per memo-update, and the pipeline publishes in
    // bursts — so each one takes a number, and only the newest is believed:
    // a slow read from before a take landed must not overwrite the read that
    // saw it land.
    let gen = 0;
    const load = async () => {
      const g = ++gen;
      const next = await readThread(root, id, takes, answered, developer);
      if (!disposed && g === gen) setThread(next);
    };
    void load();
    // every step of the pipeline publishes, and every step is a file landing —
    // the transcript of a take, the document it merged into
    const stop = subscribeMemos(root, () => void load());
    return () => {
      disposed = true;
      stop();
    };
    // `takes` adds a turn, `answered` moves the document from one to the next,
    // `present` is the memo leaving the list — a delete emits no update of its
    // own, so this is what notices one — and `developer` is the one setting
    // that changes what the thread reads
  }, [root, id, takes, answered, present, developer]);

  // The document is also a file in the editor, and Claude Code edits files
  // while we watch. Same 2s poll as FileView, same guards — but the interval
  // itself only exists while the tab is on screen, so a hidden thread costs
  // nothing at all rather than a no-op tick. Only the current `.md` is polled:
  // a snapshot is written once and never again, so re-reading the whole thread
  // on a timer would be IPC spent on files that cannot change.
  useEffect(() => {
    if (!visible || answered < 1) return;
    let disposed = false;
    const iv = window.setInterval(async () => {
      if (document.hidden) return;
      const md = await readText(memoPaths(root, id).md);
      if (disposed) return;
      setThread((prev) => {
        // a read that failed is a bad moment, not a blank document — the last
        // turn must not flash empty for two seconds over one
        if (!prev || md === null || prev.docs[answered - 1] === md) return prev;
        const docs = [...prev.docs];
        docs[answered - 1] = md;
        return { ...prev, docs };
      });
    }, 2000);
    return () => {
      disposed = true;
      window.clearInterval(iv);
    };
  }, [visible, root, id, answered]);

  // The elapsed timer, derived from when this recording started rather than
  // counted from a mount — the panel's rule, for the panel's reason: this
  // component is unmounted for most of a long memo.
  const mine = memos.recording?.id === id ? memos.recording : null;
  const since = mine ? (mine.recording_since ?? mine.created) : null;
  const [now, setNow] = useState(() => Date.now());
  // and the panel's pause rule for the same reason: while the hook is holding
  // an instant, that instant is the clock
  const frozen = memos.frozen;
  useEffect(() => {
    if (!since || frozen) return;
    setNow(Date.now());
    const iv = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(iv);
  }, [since, frozen]);
  const elapsed = since ? ((frozen ?? now) - Date.parse(since)) / 1000 : 0;

  // A word beside the copy glyph for a beat, saying what happened — and which
  // turn it happened to, now that every answer has a copy of its own.
  const [flash, setFlash] = useState<{ k: number; word: string } | null>(null);
  useEffect(() => {
    if (!flash) return;
    const t = window.setTimeout(() => setFlash(null), 1400);
    return () => window.clearTimeout(t);
  }, [flash]);

  /* ---------- playing a take back ----------
     One <audio> for the whole thread, held in a ref rather than at module
     scope: the mic is one resource for the app, but a speaker is one per memo
     you are reading, and two threads open in two windows are two things to
     listen to. Starting a take stops whichever one was sounding, because two
     recordings of the same memo talking over each other is never what pressing
     play meant.

     The bytes arrive over IPC with no name on them — the same problem the image
     view has, and the same answer: the Blob's declared type is the only thing
     telling WebKit how to decode them. `audio/mp4` is that answer for every
     take there is one for; the `.caf` the recorder falls back to when
     conversion fails is a container WebKit won't play at all, and it needs no
     branch of its own, since the derived `.m4a` isn't on disk, the read fails,
     and the control stops being offered for that take. */
  const audioRef = useRef<HTMLAudioElement>(null);
  const urlRef = useRef<string | null>(null);
  /** which take the speaker is holding — playing or stopped mid-listen — and
   *  null when it is holding none. The take card draws its clock and its played
   *  bars from this, so both survive a pause instead of being thrown away by
   *  it. */
  const [heard, setHeard] = useState<number | null>(null);
  /** and whether that take is actually moving, which is the whole of what the
   *  triangle-or-bars decision is made from */
  const [sounding, setSounding] = useState(false);
  const [at, setAt] = useState(0);
  const [len, setLen] = useState(0);
  /** how far into the waveform the playhead is, counted in bars rather than in
   *  seconds — 24 steps for the length of a take however long it is, which is
   *  what keeps a moving picture from re-rendering the thread on every frame */
  const [step, setStep] = useState(0);
  /** takes with nothing to play — a read that failed is the only way to know */
  const [silent, setSilent] = useState<number[]>([]);

  // the object URL pins the bytes in memory until it's revoked, so the last
  // take's go the moment another one is asked for, and on the way out
  useEffect(() => {
    return () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    };
  }, []);

  // which call to `hear` is the newest — a read or a play() that settles after
  // another take has taken the speaker must not speak for it
  const hearGen = useRef(0);
  const hear = useCallback(
    async (k: number) => {
      const el = audioRef.current;
      if (!el) return;
      const gen = ++hearGen.current;
      // The take already in the speaker is a pause and a resume rather than a
      // stop and a reload: the playhead stays where the ear left it, the bars
      // stay lit up to it, and the clock goes on saying where in the take you
      // are. That difference is the whole of what a pause glyph promises, and
      // the button wore the word for it while doing the other thing.
      if (heard === k) {
        if (el.paused) {
          try {
            await el.play();
            setSounding(true);
          } catch {
            setSounding(false);
          }
        } else {
          el.pause();
          setSounding(false);
        }
        return;
      }
      el.pause();
      let buf: ArrayBuffer;
      try {
        buf = await api.readBinary(memoTakeAudio(root, id, k));
      } catch {
        // No file, which is the one verdict that outlives the click: the
        // button was a promise this take can't keep, so it stops making it.
        // Only the read earns that — the old shape caught the play() below in
        // the same net, and a take whose playback was merely interrupted by
        // clicking the next one lost its play row for the session.
        if (gen === hearGen.current) {
          setSilent((prev) => (prev.includes(k) ? prev : [...prev, k]));
          setHeard(null);
          setSounding(false);
        }
        return;
      }
      // a newer click took the speaker while the bytes were in flight; the
      // element is theirs now
      if (gen !== hearGen.current) return;
      const next = URL.createObjectURL(new Blob([buf], { type: "audio/mp4" }));
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = next;
      el.src = next;
      setAt(0);
      setLen(0);
      setStep(0);
      try {
        await el.play();
        if (gen === hearGen.current) {
          setHeard(k);
          setSounding(true);
        }
      } catch {
        // an interrupted or refused play is a moment, not a verdict — the take
        // stays offered
        if (gen === hearGen.current) {
          setHeard(null);
          setSounding(false);
        }
      }
    },
    [heard, id, root]
  );

  // Copy lives under each answer, the way it does in every chat: the document
  // as that take left it is a paste payload in its own right, and the newest
  // one — the memo as it now stands — is simply the last of them. A transcript
  // is copied the ordinary way, by selecting it.
  const copy = useCallback(async (k: number, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setFlash({ k, word: "copied" });
    } catch {
      setFlash({ k, word: "couldn't copy" });
    }
  }, []);

  // Bottom is where the newest turn is, so that's where a thread opens — and
  // where it stays as things land, unless you have scrolled up to read
  // something, which is the one moment being pulled back down is worse than
  // being left alone.
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const onScroll = () => {
    const el = scrollRef.current;
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  // what's on screen, in one cheap string: how many turns, how long each of
  // them is, and what the pipeline is doing. New content changes it; a
  // re-render for any other reason doesn't.
  const mark = [
    thread?.raws.map((r) => r?.length ?? -1).join(),
    thread?.docs.map((d) => d?.length ?? -1).join(),
    memo?.status,
  ].join("|");
  useEffect(() => {
    const el = scrollRef.current;
    // a pane that isn't on screen has no height to scroll, so this waits for
    // the tab rather than firing into nothing
    if (!el || !visible || !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [visible, mark]);

  // A memo whose files have all gone and whose id has left the list was deleted
  // — from this thread, or from the panel, or by hand. Both halves are needed:
  // the files go first, and a list that hasn't arrived yet isn't evidence.
  const nothing = thread !== null && ![...thread.raws, ...thread.docs].some((t) => t?.trim());
  if (nothing && !memo) {
    return (
      <div className="memo-thread">
        <div className="memo-thread-empty">this memo is gone</div>
      </div>
    );
  }

  const work = memo ? memoWork(memo, memos.downloading) : null;
  const wrong = memo && failed(memo) ? (memo.error ?? "that stage failed") : null;

  const holder = memos.elsewhere;
  /** the mic, held in this project by a memo that isn't this one */
  const other = mine ? null : memos.recording;

  /**
   * Why a follow-up can't start, in words, or null when it can.
   *
   * Every state this button sits out had to earn a sentence. The one that
   * hadn't was a memo still in the pipeline, where the button simply wasn't
   * drawn — and a feature that isn't there reads as a feature that broke, which
   * is exactly how it was read.
   */
  const why = (): string | null => {
    if (mine) return null;
    // The mic before the pipeline: it is the scarcer of the two and the only
    // one you can do something about — "stop the other one" is an action,
    // "wait for this one" is a wait. A follow-up onto a memo that has a name
    // can say whose turn it is stealing; a first recording has no name yet,
    // since the title is the cleanup's and the cleanup hasn't run, so it says
    // the plain thing instead of an id nobody has seen.
    if (other) return other.title ? `recording ${other.title}…` : "the mic is busy";
    if (holder) return `recording in ${projectName(holder)}`;
    if (!memo || memo.status === "ready") return null;
    // the pipeline's own word for what it's doing, and something for the two
    // states it has none for: a failure, whose answer is the retry a line
    // above rather than more words, and the hand-off between stages, which
    // lasts about a second
    if (wrong) return "retry first";
    return work ?? "working…";
  };
  const blocked = why();

  /**
   * Why a written follow-up can't be sent, or null when it can. The mic's
   * reasons are not this box's: somebody recording in another project has
   * nothing to do with typing here. What is left is this memo itself — the
   * recording being made onto it, or the pipeline that still has it.
   */
  const textBlocked = (): string | null => {
    if (mine) return "recording a follow-up…";
    if (!memo || memo.status === "ready") return null;
    if (wrong) return "retry first";
    return work ?? "working…";
  };

  return (
    <div className="memo-thread">
      {/* No strip above the column. What this memo is called is the tab's job
          and the document's own heading's, the take count is said better by the
          turns themselves — each one labelled with its own number — and the one
          verb that used to justify the line has gone to the bar at the bottom,
          where the other verb already was. */}
      <div className="memo-thread-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="memo-thread-col">
          {thread?.raws.map((raw, i) => {
            const k = i + 1;
            const said = raw?.trim();
            const answer = thread.docs[i]?.trim();
            // a take still being recorded or transcribed has neither half yet,
            // and the pending turn below is already saying so
            if (!said && !answer) return null;
            // What the wire carries about this take, and nothing invented:
            // order always, and for the first one the memo's own clock and the
            // length of the recording that made it. The takes after it have
            // neither on the wire, so they say neither.
            const head = [
              `take ${k}`,
              ...(k === 1 && memo
                ? [stamp(memo.created), ...(memo.duration_s > 0 ? [clock(memo.duration_s)] : [])]
                : []),
            ].join(" · ");
            return (
              <div className="memo-exchange" key={k}>
                {said && (
                  <div className="memo-turn said">
                    {/* What this take is called, and only that: one line, and
                        an ellipsis rather than a second line if the pane is too
                        narrow for the date. Everything that used to share it
                        moved a line down — a header that wraps because it is
                        carrying a button and a waveform and a clock is a header
                        being asked to be a toolbar. */}
                    <div className="memo-turn-head">{head}</div>
                    {/* Still no scrubber and no speed — a memo is checked
                        against its recording rather than listened to as one —
                        but the shape earns its hundred pixels: it says where
                        the silences are, which is how you find the part you
                        meant to check. */}
                    {!silent.includes(k) && (
                      <MemoPlayRow
                        path={memoTakeAudio(root, id, k)}
                        playing={heard === k && sounding}
                        played={heard === k ? step : 0}
                        time={heard === k ? `${clock(at)} / ${clock(len)}` : null}
                        onToggle={() => void hear(k)}
                      />
                    )}
                    <div className="memo-said">{said}</div>
                  </div>
                )}
                {answer && <MemoDoc text={answer} />}
                {/* What can be done with an answer, on the line under it:
                    copy it, and in developer mode open the call that produced
                    it — every argument and the whole of stdin, runnable —
                    as the file it is. The call is offered only when it is on
                    disk: a memo from before the record was kept has no such
                    file, and a button that opens nothing is a promise the
                    thread can't keep. */}
                {answer && (
                  <div className="memo-turn-acts">
                    <button
                      className="memo-icon-btn"
                      title="copy this document"
                      aria-label="copy this document"
                      onClick={() => void copy(k, thread.docs[i] ?? answer)}
                    >
                      <CopyGlyph />
                    </button>
                    {flash?.k === k && <span className="memo-turn-flash">{flash.word}</span>}
                    {developer && thread.calls[i] && (
                      <button
                        className="memo-thread-act"
                        title="open the exact claude call that produced this turn"
                        onClick={() => onOpenFile(memoCall(root, id, k))}
                      >
                        claude call
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {/* the pipeline as the turn it is: something is being said back, and
              this is how far it has got */}
          {wrong ? (
            <div className="memo-turn pending fail">
              <span className="memo-thread-why">{wrong}</span>
              {/* the one failure a retry alone can't fix: claude wants a
                  login, and the login lives in a terminal */}
              {memo?.needs_login && memos.signIn && (
                <button
                  className="memo-thread-act"
                  title="open a terminal on claude /login"
                  onClick={memos.signIn}
                >
                  sign in
                </button>
              )}
              <button
                className="memo-thread-act"
                title="run this stage again"
                onClick={() => memos.retry(id)}
              >
                retry
              </button>
              {/* and, in developer mode, the call that failed — the one a
                  developer most wants to read. The take in flight is the one
                  after the last answered, so its record is at index `takes`. */}
              {developer && thread?.calls[takes] && (
                <button
                  className="memo-thread-act"
                  title="open the exact claude call that failed"
                  onClick={() => onOpenFile(memoCall(root, id, takes + 1))}
                >
                  claude call
                </button>
              )}
            </div>
          ) : (
            work && (
              <div className="memo-turn pending">
                {memo?.status !== "recording" && <span className="memo-ring" />}
                <span>{work}</span>
                {since && <span className="memo-elapsed">{clock(elapsed)}</span>}
              </div>
            )
          )}
        </div>
      </div>

      {/* The one element every take is played through. It draws nothing — an
          <audio> without controls isn't rendered at all — and the two words in
          each take's header line are the whole of its interface. */}
      {/* Whole seconds, because whole seconds are what gets drawn. `timeupdate`
          lands about four times a second, and three of those four would
          re-render every turn in the thread — markdown and all — to show the
          same two digits; rounded, React sees the same number and stops. The
          waveform's playhead is floored the same way and for the same reason,
          in the unit it is actually drawn in: bars, of which there are 24 in a
          take whether the take is eight seconds or four minutes. */}
      <audio
        ref={audioRef}
        onTimeUpdate={(e) => {
          const el = e.currentTarget;
          setAt(Math.floor(el.currentTime));
          setStep(el.duration > 0 ? Math.floor((WAVE_BARS * el.currentTime) / el.duration) : 0);
        }}
        onLoadedMetadata={(e) => setLen(Math.floor(e.currentTarget.duration))}
        onEnded={() => {
          setHeard(null);
          setSounding(false);
          setStep(0);
        }}
      />

      {/* The box every next turn goes in by — typed, pasted, said into the
          mic or brought in as a file — or, while this memo is the one being
          recorded, the mic's controls in its place. Only for a memo the list
          still has: one whose row has gone can be read and copied from, but
          not talked to. */}
      {memo && (
        <div className="memo-thread-foot">
          <MemoComposer
            placeholder="reply to this memo…"
            blocked={textBlocked()}
            notice={memos.notice}
            onSend={async (text) => (await memos.write(text, id)) !== null}
            live={mine ? <MemoControls root={root} memos={memos} elapsed={elapsed} /> : undefined}
            tools={
              // a follow-up said somewhere else, arriving as a file — gated
              // only on the memo being finished, since the mic is not involved
              <button
                className="memo-icon-btn"
                title="import an audio file as a follow-up — it revises this memo"
                aria-label="import an audio file as a follow-up"
                disabled={memos.busy || memo.status !== "ready"}
                onClick={() => void memos.importMemo(id)}
              >
                <ImportGlyph />
              </button>
            }
            mic={
              // the reason it can't be pressed, when there is one, is its
              // tooltip — and, for the pipeline's reasons, the box's placeholder
              <button
                className="memo-icon-btn"
                title={
                  memos.doing === "start"
                    ? "starting…"
                    : (blocked ?? "record a follow-up — it revises this memo")
                }
                aria-label="record a follow-up"
                disabled={memos.busy || blocked !== null}
                onClick={() => memos.startTake(id)}
              >
                <MicGlyph />
              </button>
            }
          />
        </div>
      )}
    </div>
  );
}
