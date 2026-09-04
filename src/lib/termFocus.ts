/**
 * Which terminal was last typed in — not which one has the keyboard now.
 *
 * The difference is the whole point. Anything that sends text to a terminal is
 * a control somewhere else: a button in an editor tab, a menu item, a sidebar
 * row. Clicking it *takes* the focus off the terminal, so by the time the
 * handler runs there is no focused pane and a "send to the focused terminal"
 * finds nothing. What the person meant was the one they were last working in,
 * which is what this remembers.
 *
 * A module-level value rather than context: the writers are terminal panes and
 * the readers are views that have no relationship to them, and threading a
 * provider between the two would be a lot of plumbing for one string.
 *
 * Per window, and deliberately not persisted. On a fresh launch nothing has
 * been typed in yet, and guessing at the last session's pane would be a guess
 * about a shell that may not exist any more.
 */

let last: string | null = null;

/** Called by the terminal grid whenever focus lands on a pane. */
export function setFocusedTerm(id: string | null) {
  if (id) last = id;
}

/** Forget a pane that has gone away, so a closed terminal is never the target.
 *  Only clears when it is the one being remembered — closing some other pane
 *  must not lose the answer. */
export function forgetTerm(id: string) {
  if (last === id) last = null;
}

/**
 * The terminal to send to, or null when there isn't one worth guessing at.
 *
 * Checked against the DOM rather than trusted: a remembered pane may have been
 * closed, split away, or belong to a project window that is no longer on
 * screen, and writing a prompt into a pty nobody is looking at is worse than
 * saying there is nowhere to send it.
 *
 * Falls back to the only terminal there is, when there is exactly one — with
 * one pane open, "the last one you used" and "the only one" are the same
 * answer, and requiring a click into it first would be pedantry. It does not
 * fall back beyond that: picking an arbitrary one of six shells is how a
 * prompt lands in the middle of someone else's session.
 */
export function targetTerm(): string | null {
  const has = (id: string) => !!document.querySelector(`[data-term-id="${CSS.escape(id)}"]`);
  if (last && has(last)) return last;
  const all = document.querySelectorAll<HTMLElement>("[data-term-id]");
  return all.length === 1 ? (all[0].dataset.termId ?? null) : null;
}

/**
 * Put the keyboard in a terminal, given its pane id.
 *
 * xterm listens on a hidden textarea rather than on the element you can see,
 * so focusing the pane itself does nothing — this reaches for the textarea the
 * same way the file-drop handler does after a drop, which is the other place
 * in the app that puts text into a terminal from outside it.
 *
 * Also records the pane as the last focused one. Nothing else would: the
 * terminal grid only hears about focus that arrives through its own panes, and
 * a programmatic focus does not go that way.
 */
export function focusTerm(id: string) {
  const pane = document.querySelector<HTMLElement>(`[data-term-id="${CSS.escape(id)}"]`);
  const ta = pane?.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
  if (!ta) return;
  ta.focus();
  last = id;
}
