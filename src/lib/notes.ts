/**
 * What makes a file a note, and how to ask the one that's open to make room.
 *
 * A note is an ordinary markdown file — that is the whole design. ⌘⌥N opens
 * `.zero/notes/scratch.md` in a normal editor tab, `⌘S` saves it, the file tree
 * can reopen it, and every other feature that works on a file works on it. The
 * one thing a note does that a file doesn't is tidy what you paste, and that
 * is decided by where the file lives rather than by what opened it — so a note
 * opened from the tree behaves exactly like a note opened by the shortcut, and
 * nothing anywhere has to remember which tab is the special one.
 */

/** where `notes.rs` puts them; the two halves of the path have to agree */
const NOTES = "/.zero/notes/";

/**
 * Whether this file is one of the project's notes.
 *
 * A prefix test rather than an equality one against `scratch.md`: the folder is
 * the feature. Anything a person puts in there is a note and gets the paste, and
 * a second note — kept by hand, one per topic — needs no code to work.
 */
export function isNote(absPath: string, root: string): boolean {
  return absPath.startsWith(root + NOTES) && absPath.endsWith(".md");
}

/**
 * "Put the cursor at the end of that note."
 *
 * ⌘⌥N means *somewhere to put this*, and it has to mean it on the second press
 * as much as the first — but the second press opens nothing, because the tab is
 * already there. So the shortcut asks here, and the editor holding that file
 * answers.
 *
 * The request is latched, not fired and lost: on the first press the editor
 * doesn't exist yet, and its document arrives an IPC round trip after that. A
 * request with nobody listening waits for the listener rather than falling on
 * the floor — the same reason `openBus` queues.
 */
const subs = new Map<string, () => void>();
const waiting = new Set<string>();

export function goToNoteEnd(absPath: string) {
  const fn = subs.get(absPath);
  if (fn) fn();
  else waiting.add(absPath);
}

export function onNoteEnd(absPath: string, fn: () => void): () => void {
  subs.set(absPath, fn);
  if (waiting.delete(absPath)) fn();
  return () => {
    // a re-render resubscribing must not tear the newer listener down
    if (subs.get(absPath) === fn) subs.delete(absPath);
  };
}
