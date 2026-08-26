import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { confirm } from "@tauri-apps/plugin-dialog";
import { Memo } from "../lib/api";
import { contextMenu, fileEntries } from "../lib/contextMenu";
import {
  clock,
  failed,
  memoPaths,
  memoRaw,
  memoWork,
  projectName,
  stamp,
  useMemoLevel,
  type Memos,
} from "../lib/memos";
import type { View } from "./Workspace";

/**
 * Press record, ramble, press stop. The list above is what came back.
 *
 * A click opens the memo as its thread — what you said and what came back, take
 * by take — and ⌥ opens the raw transcript as an ordinary file view, which is
 * the escape hatch to the files this is all made of. The row says only what a
 * list has to say: what the pipeline is doing to the memo, if anything, and
 * whether it's the one you're reading. Copying a memo and talking over one are
 * the thread's verbs now — both of them are about a single memo, and the thread
 * is where a single memo is.
 *
 * The button that starts all of it sits on the floor of the panel rather than
 * over the list, where it was tried first and read as one more line of chrome
 * between you and the memos. A compose bar, in the place everything that takes
 * dictation puts one, with the door to ZERO.md under it.
 */

/** The helper's RMS, curved for the eye: speech sits around 0.05–0.2 on a 0–1
 *  scale, and mapped straight through, the bars look dead through an ordinary
 *  sentence — which is the one thing they must never look like when they
 *  aren't. One curve rather than one per indicator, so that anything drawn from
 *  the mic agrees with everything else about how loud the room is. */
const glow = (rms: number) => Math.min(1, Math.sqrt(Math.max(0, rms)) * 1.7);

/* ---------- the panel's glyphs ----------
   Every word that was doing an icon's job, drawn on the rail's grid: a 16-unit
   box, hairline strokes, round ends. They are smaller than the rail's because
   they sit inside controls rather than being controls — 13px is the size at
   which a 1.2 stroke is still a line and not a smudge, and one size for all of
   them is most of what this pass was for.

   Each is defined once here and used wherever it belongs; the thread imports
   the four it shares with the panel, so a play triangle is the same triangle
   on a take card as on the mic. */

/** the number every glyph in this feature is drawn at */
const GLYPH = 13;

/** The invariant half of a glyph, stated once. `aria-hidden` because the button
 *  around it carries the name — a control with a label and a titled icon
 *  announces itself twice. */
function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg
      className="memo-glyph"
      width={GLYPH}
      height={GLYPH}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/* The transport pair, which is never seen as a pair: one of them is always what
   the other one isn't. Both are 8.6 units tall so the control doesn't change
   weight when it flips. */

/** Filled, and the only one that is — an outlined triangle at 13px is a ring
 *  with a bruise in the middle, and the apex the outline blunts is the whole of
 *  what says "play". Stroked as well as filled, so its corners are as round as
 *  everything else here; the centroid sits on 8, which is where a triangle has
 *  to sit to look centred in a square. */
const PlayGlyph = () => (
  <Glyph>
    <path d="M6 4.3 12.1 8 6 11.7Z" fill="currentColor" />
  </Glyph>
);

/** Two bars, 4.2 apart, which is the gap that still reads as two at this size. */
const PauseGlyph = () => (
  <Glyph>
    <path d="M5.9 4.2v7.6" />
    <path d="M10.1 4.2v7.6" />
  </Glyph>
);

/** The ✕ that undoes things, at last drawn rather than typed: the character was
 *  seven pixels of glyph in a box nobody could hit, and its weight had nothing
 *  to do with the icons around it. Same 8.6 diagonal as the bars are tall. */
const CrossGlyph = () => (
  <Glyph>
    <path d="M4.3 4.3 11.7 11.7" />
    <path d="M11.7 4.3 4.3 11.7" />
  </Glyph>
);

/** Two sheets, the front one whole and the back one only where it shows — an
 *  overlap drawn as two full rectangles has a line through the middle of it
 *  that no piece of paper ever had. */
const CopyGlyph = () => (
  <Glyph>
    <path d="M10 6V3.9a1.3 1.3 0 0 0-1.3-1.3H3.9a1.3 1.3 0 0 0-1.3 1.3v4.8a1.3 1.3 0 0 0 1.3 1.3H6" />
    <rect x="6" y="6" width="7.4" height="7.4" rx="1.3" />
  </Glyph>
);

/** The rail's mic, small: the same capsule, the same semicircle cradle, the
 *  same stem — with the cradle's lips and the stem lengthened by the couple of
 *  tenths they need to survive being drawn three pixels shorter. A miniature
 *  keeps a silhouette; it doesn't keep detail that stops resolving. */
const MicGlyph = () => (
  <Glyph>
    <rect x="6.3" y="2.1" width="3.4" height="6.4" rx="1.7" />
    <path d="M4 7.2v1.3a4 4 0 0 0 8 0V7.2" />
    <path d="M8 12.5v1.6" />
  </Glyph>
);

/** ZERO.md, as the thing it is: a book held open. Two pages meeting at a spine,
 *  the outer corners lifted, which is the shallow V that tells it apart from a
 *  document at any size. Tried as a page-with-lines first and it was the file
 *  tree's icon with fewer lines — this project's words are not one more file. */
const BookGlyph = () => (
  <Glyph>
    <path d="M8 4.6C6.7 3.6 5 3.1 2.9 3.1a.7.7 0 0 0-.7.7v6.9a.7.7 0 0 0 .7.7c2.1 0 3.8.5 5.1 1.5" />
    <path d="M8 4.6c1.3-1 3-1.5 5.1-1.5a.7.7 0 0 1 .7.7v6.9a.7.7 0 0 1-.7.7c-2.1 0-3.8.5-5.1 1.5" />
    <path d="M8 4.6v8.3" />
  </Glyph>
);

/** A file arriving: an arrow settling into a tray. The tray is the bottom half
 *  of the copy glyph's geometry and the arrow the size everything else here is,
 *  so it reads as one more member of the set rather than a visitor from a
 *  toolbar. It means "bring a recording in from outside" in both places it
 *  appears — beside the mic on the panel's floor, and beside the follow-up
 *  button at the foot of a thread. */
const ImportGlyph = () => (
  <Glyph>
    <path d="M8 2.4v6.8" />
    <path d="M5.3 6.5 8 9.2l2.7-2.7" />
    <path d="M2.9 10.6v1.7a1.3 1.3 0 0 0 1.3 1.3h7.6a1.3 1.3 0 0 0 1.3-1.3v-1.7" />
  </Glyph>
);

export { PlayGlyph, PauseGlyph, CopyGlyph, MicGlyph, ImportGlyph };

/**
 * The dot, and nothing but the dot: a mic is on.
 *
 * It used to draw the level too, and subscribed to it — which meant a span
 * re-rendering ten times a second for the length of every recording, and a
 * hook, and a curve, to say a thing the bars two inches away were already
 * saying better. It says the one thing they don't: that this is a recording at
 * all. So it went back to being a light on the front of a machine — a slow red
 * pulse, entirely CSS, re-rendered when the state changes and at no other
 * time — and the bars kept the room.
 *
 * Paused, it holds still. A blinking record light means tape is moving.
 */
function MemoDot({ live, paused }: { live: boolean; paused?: boolean }) {
  return <span className={`memo-dot ${live ? "live" : ""} ${paused ? "paused" : ""}`} />;
}

/**
 * Three bars that move with the room, at the far end of the stop button.
 *
 * The dot says the mic is on, and has said it since tape decks. This says how
 * loud you are, which is the thing actually worth knowing before talking for
 * four minutes into an input nothing is reaching — and it is now the only thing
 * in the app that reads the level at all. A leaf under a discipline of its own:
 * one subscription, one element redrawn per level event, and nothing above it
 * in the tree hearing about the mic. It travels wherever the cluster does, so
 * it no longer needs exporting to follow the thread's button around.
 *
 * No canvas and no animation loop — the level events *are* the frames, 8–12 a
 * second, and the ~120ms transition in the stylesheet is the whole animation.
 * Each bar takes the same number through a gain of its own, the middle one
 * tallest, so three bars fed one reading read as three bars rather than as one
 * bar drawn three times.
 */
function MemoBars({ root, live }: { root: string; live: boolean }) {
  const level = useMemoLevel(root);
  // A mic that isn't listening has no level to show, and a resting set of stubs
  // beside an idle button is exactly the false light this indicator exists to
  // prevent. A paused recording is the one case where resting is the truth and
  // the bars stay: the level is zeroed the moment the pause lands, so they sit
  // on their bases for the length of it and stand up again when you resume.
  // Hooks first, then nothing: the subscription costs nothing while the stored
  // level is a flat zero.
  if (!live) return null;
  return (
    <span className="memo-bars" style={{ "--level": glow(level) } as CSSProperties}>
      <span />
      <span />
      <span />
    </span>
  );
}

/**
 * The mic while it's live: stop, pause, and throw away.
 *
 * One cluster in two places — the floor of the panel, and the foot of the
 * thread when the recording being made is that memo's follow-up — because
 * these are three verbs about one mic and there is only ever one mic. The wide
 * one keeps the width, the position and the dot the record button had, so
 * nothing moves out from under a finger already reaching for it; it is also the
 * only one of the three that means *done, now do something with it*, which is
 * what the whole feature is pressed into motion for — and so that is what it
 * says. `stop` was the tape word for it and it stops nothing: the recording
 * ends and four other things start.
 *
 * The label slot is the state slot, as it has always been — it says `stopping…`
 * rather than a verb while the stop is in flight — so `paused` goes there too.
 *
 * The two beside it are icons on identical squares. They were a bordered word
 * and a bare ✕, which made one of them look like a decision and the other like
 * a typo, when they are peers: both undo something about the recording, neither
 * is what you came to press. Same footprint, same chip, same weight — the only
 * difference left is the one that matters, which is that the ✕ goes red.
 */
export function MemoControls({
  root,
  memos,
  /** seconds, already frozen by the hook if this recording is paused */
  elapsed,
}: {
  root: string;
  memos: Memos;
  elapsed: number;
}) {
  const paused = memos.recording?.paused ?? false;
  return (
    <div className="memo-controls">
      <button
        className="memo-stop"
        title="stop and transcribe"
        disabled={memos.busy}
        onClick={memos.stop}
      >
        <MemoDot live paused={paused} />
        <span className="memo-record-label">
          {memos.doing === "stop" ? "stopping…" : paused ? "paused" : "done"}
        </span>
        <span className="memo-elapsed">{clock(elapsed)}</span>
        <MemoBars root={root} live />
      </button>

      {/* The verb is in the glyph and the sentence is in the tooltip; the
          `aria-label` keeps the plain word, because a screen reader is owed a
          verb and not a description of a mic. */}
      <button
        className="memo-icon-btn"
        title={paused ? "pick it up where it stopped" : "stop listening without ending the recording"}
        aria-label={paused ? "resume" : "pause"}
        disabled={memos.busy}
        onClick={() => (paused ? memos.resume() : memos.pause())}
      >
        {paused ? <PlayGlyph /> : <PauseGlyph />}
      </button>

      {/* The quiet third: the one that undoes the last thirty seconds. It asks
          nothing before doing it — see `cancel` in the hook for why — and ⎋ does
          the same thing without the aim. Red is what keeps it apart from its
          twin now that the two are the same size. */}
      <button
        className="memo-icon-btn scrap"
        title="throw this recording away (⎋)"
        aria-label="throw this recording away"
        disabled={memos.busy}
        onClick={memos.cancel}
      >
        <CrossGlyph />
      </button>
    </div>
  );
}

export function MemoPanel({
  root,
  memos,
  activeMemo,
  onOpenView,
}: {
  root: string;
  memos: Memos;
  /** the memo whose thread is the editor's current view, or null when what's on
   *  screen isn't a memo — the list's selection, worked out by the workspace
   *  and handed down rather than guessed at here */
  activeMemo: string | null;
  onOpenView: (v: View) => void;
}) {
  const { probe, recording, elsewhere } = memos;

  // The timer is derived from when the recording started rather than counted
  // up from a mount, so switching tabs and coming back doesn't restart it —
  // this component is unmounted for most of a long memo.
  const [now, setNow] = useState(() => Date.now());
  const recId = recording?.id;
  // When this recording began, which for a follow-up is the take's own clock:
  // a take shares its memo's `created`, so counting from that would show the
  // age of the memo being talked over rather than how long you've been talking.
  const since = recording ? (recording.recording_since ?? recording.created) : null;
  // A paused recording has nothing to tick: the hook holds the instant the
  // clock stopped at, and the seconds resume from a `recording_since` the
  // backend has rebased — which arrives here as a new `since` and restarts
  // this effect on its own.
  const frozen = memos.frozen;
  useEffect(() => {
    if (!recId || frozen) return;
    setNow(Date.now());
    // twice a second, so the displayed second is never a whole one behind
    const iv = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(iv);
  }, [recId, since, frozen]);

  if (probe === null) return null; // one IPC round trip, not worth a flash of panel
  if (!probe.supported) {
    return <div className="panel-error">{probe.message ?? "memos aren't available on this Mac."}</div>;
  }

  // A row opens the memo, and a memo is a thread: the recording, the document
  // it came back as, and every follow-up since. ⌥ still asks for the words as
  // they were heard, and that stays a file view — the transcript is a file and
  // has nothing to be a thread about.
  const open = (m: Memo, raw: boolean) => {
    if (!raw) {
      onOpenView({ kind: "memo", key: `memo:${m.id}`, id: m.id });
      return;
    }
    const abs = memoRaw(root, m);
    if (!abs) return;
    onOpenView({ kind: "file", key: `file:${abs}`, absPath: abs });
  };

  // speech is unrecoverable, so this is the one thing in the panel that asks
  const remove = async (m: Memo) => {
    const ok = await confirm(
      `Delete "${m.title ?? stamp(m.created)}"?\n\nThe recording and both transcripts go with it.`,
      { title: "Delete memo", kind: "warning" }
    );
    if (ok) memos.remove(m.id);
  };

  const openVocabulary = async () => {
    const abs = await memos.vocabularyPath();
    if (abs) onOpenView({ kind: "file", key: `file:${abs}`, absPath: abs });
  };

  const elapsed = since ? ((frozen ?? now) - Date.parse(since)) / 1000 : 0;
  // What the button says before there is anything to stop. The live words moved
  // into the cluster, which is the only thing that draws them now.
  const recordLabel =
    memos.doing === "start"
      ? "starting…"
      : elsewhere
        ? `recording in ${projectName(elsewhere)}`
        : "record";

  // A first recording is its own row while it's live: the button on the floor
  // of the panel, with its label and its timer and its bars, is a better place
  // for it than a line in a list of finished things. A follow-up is the
  // opposite — it belongs to a memo already in the list, and very likely the
  // one whose thread is open and selected, so pulling it out for the length of
  // a recording would be the list losing the memo you are talking to.
  const rows = memos.memos.filter((m) => m.status !== "recording" || m.takes > 0);

  return (
    <div className="memo-panel">
      <div className="memo-list">
        {rows.length === 0 && !recording && (
          <div className="memo-empty">press record, ramble, press stop.</div>
        )}

        {rows.map((m) => {
          const busy = m.status === "transcribing" || m.status === "cleaning";
          // What the pipeline is doing to this memo, and nothing when the
          // answer is nothing — a finished memo has no news, and a row that
          // says none is a title with the width of the panel to be legible in.
          const work = memoWork(m, memos.downloading);
          return (
            <div
              key={m.id}
              className={`memo-row ${activeMemo === m.id ? "active" : ""} ${
                memos.followed === m.id ? "followed" : ""
              }`}
              // ⌥ asks for the words as they were heard, which is what you want
              // exactly when the cleaned version reads wrong
              onClick={(e) => open(m, e.altKey)}
              // The memo's document — and `.zero/memos`, where its recording
              // and both transcripts sit beside it, for a memo that hasn't got
              // one yet. Nothing here renames it: the pipeline finds all four
              // files by the memo's id, so a renamed `.md` is a memo whose
              // recording it can no longer find. Delete is the memo's own verb
              // below, and it takes the whole set.
              onContextMenu={(e) =>
                contextMenu(e, [
                  { text: "Open Thread", run: () => open(m, false) },
                  { text: "Open Raw Transcript", enabled: !!memoRaw(root, m), run: () => open(m, true) },
                  failed(m) && { text: "Retry", run: () => memos.retry(m.id) },
                  m.needs_login &&
                    !!memos.signIn && { text: "Sign In to Claude", run: () => memos.signIn?.() },
                  "sep",
                  ...fileEntries(memoPaths(root, m.id).md, { root, writes: "none" }),
                  "sep",
                  { text: "Delete Memo", run: () => remove(m) },
                ])
              }
            >
              {/* what's being done to this memo, or nothing at all — which is
                  what a finished one has to report */}
              <span className="memo-slot">
                {busy ? (
                  <span className="memo-ring" />
                ) : failed(m) ? (
                  <span className="memo-mark" />
                ) : null}
              </span>

              <span className={`memo-title ${m.title ? "" : "stamp"}`}>
                {m.title ?? stamp(m.created)}
              </span>

              {failed(m) ? (
                <button
                  className="memo-meta fail"
                  title={m.error ?? "run this stage again"}
                  onClick={(e) => {
                    e.stopPropagation();
                    memos.retry(m.id);
                  }}
                >
                  failed — retry
                </button>
              ) : (
                work && <span className="memo-meta work">{work}</span>
              )}

              <span className="memo-acts">
                <button
                  className="memo-icon-btn scrap"
                  title="delete this memo"
                  aria-label="delete this memo"
                  onClick={(e) => {
                    e.stopPropagation();
                    remove(m);
                  }}
                >
                  <CrossGlyph />
                </button>
              </span>
            </div>
          );
        })}
      </div>

      {/* The floor of the panel: the thing you press, and at the end of it the
          door to the words this project insists on. Pinned, with the list
          scrolling behind — a record button that scrolls away is one you have to
          go and find, and the top of the list was somewhere it demonstrably
          wasn't looked for. The notice rides here too, above the button, because
          what it almost always has to report is what just happened when that
          button was pressed.

          One row, not two. ZERO.md spent a line of its own on a word, which is
          a lot of floor for a door nobody opens twice a week; as a glyph on the
          end of the record row it is exactly as reachable and costs nothing.
          While the mic is live the cluster grows into the same row and the book
          stays put at the far right — it is small, and the cluster's flex
          absorbs everything else. */}
      <div className="memo-foot">
        {memos.notice && (
          <div className="memo-notice" onClick={memos.dismissNotice}>
            {memos.notice}
          </div>
        )}

        <div className="memo-record-row">
          {/* One thing in one place for both states. Idle it is the button you
              press; live it grows the two controls a recording needs beside the
              one that ends it — and the one that ends it keeps the position and
              most of the width, so nothing moves out from under a finger that's
              already reaching for it. */}
          {recording ? (
            <MemoControls root={root} memos={memos} elapsed={elapsed} />
          ) : (
            <button
              className="memo-record"
              title="record a voice memo"
              disabled={memos.busy || elsewhere !== null}
              onClick={memos.start}
            >
              <MemoDot live={false} />
              <span className="memo-record-label">{recordLabel}</span>
            </button>
          )}

          {/* The other way a recording arrives: made somewhere else, picked as
              a file. It rides beside the mic in both states — the mic is never
              involved, so a live recording elsewhere is no reason to grey it —
              and the memo it makes walks the same pipeline from the same
              `recorded` checkpoint on. */}
          <button
            className="memo-icon-btn"
            title="import an audio file — it becomes a memo like any recording"
            aria-label="import an audio file"
            disabled={memos.busy}
            onClick={() => memos.importMemo()}
          >
            <ImportGlyph />
          </button>

          <button
            className="memo-icon-btn"
            title="ZERO.md — the words this project needs transcription to get right"
            aria-label="ZERO.md"
            onClick={openVocabulary}
          >
            <BookGlyph />
          </button>
        </div>
      </div>
    </div>
  );
}
