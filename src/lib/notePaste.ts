import { Decoration, DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { Extension, StateEffect, StateField } from "@codemirror/state";
import { api } from "./api";

/**
 * The one thing a note does that a file doesn't: what you paste into it arrives
 * tidied.
 *
 * Text copied out of a terminal is damaged in ways that have nothing to do with
 * what it says — a table loses the borders that were holding its columns apart,
 * a paragraph keeps the width the terminal wrapped it to, a command comes back
 * broken across two lines and won't run. Every one of those is mechanical, and
 * fixing them by hand is the sort of work nobody should be doing at eleven at
 * night. `notes.rs` sends the passage to `claude -p --model haiku` and the
 * answer lands where the paste would have.
 *
 * **Nothing is inserted until the answer comes back.** The alternative — raw
 * text first, swapped a second later — was considered and is worse: the swap
 * lands under a cursor that has usually moved, and a paste that visibly rewrites
 * itself is unsettling in a way a short wait is not. So the spot holds a mark
 * saying what it is waiting for, and the text arrives once.
 *
 * **Every failure keeps the paste.** No `claude` on the machine, an expired
 * login, a timeout, a passage too big to be worth sending: all of them insert
 * exactly what was on the clipboard and say, for a few seconds, why it wasn't
 * touched. The worst outcome of asking is the outcome of never having asked,
 * one round trip later — which is what makes it safe to ask every time.
 */

/** Mirrors `MAX_PASTE` in `notes.rs`. Both copies decide; this one only saves
 *  the round trip that the other would refuse. */
const MAX_PASTE = 100_000;

/**
 * Whether a paste is worth a round trip.
 *
 * A single short line — a path, a branch name, a hash — has no shape to repair
 * and would pay a second's wait for nothing, so it goes in untouched. Anything
 * with a line break might be a wrapped paragraph, a mangled table or a command
 * cut in half, which is the whole population this feature exists for; and a
 * single line long enough to have been wrapped somewhere is worth a look too.
 */
const worthFormatting = (text: string) =>
  text.trim().length > 0 && text.length <= MAX_PASTE && (text.includes("\n") || text.length > 400);

/** the mark that holds the spot, and the note left when a paste was kept raw */
const addMark = StateEffect.define<{ id: number; pos: number; reason: string | null }>();
const dropMark = StateEffect.define<number>();

class NoteMark extends WidgetType {
  constructor(
    readonly id: number,
    /** null while it is still being tidied; why it wasn't, once it isn't */
    readonly reason: string | null
  ) {
    super();
  }
  eq(other: NoteMark) {
    return other.id === this.id && other.reason === this.reason;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = this.reason === null ? "note-mark note-mark-busy" : "note-mark note-mark-kept";
    el.textContent = this.reason === null ? "formatting…" : `kept as pasted — ${this.reason}`;
    return el;
  }
  /** it is a status line, not part of the document: clicks belong to the text
   *  under it and the cursor should never be able to sit inside it */
  ignoreEvent() {
    return true;
  }
}

const marks = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(set, tr) {
    // through the edits first: the answer may land after the cursor has moved
    // on and typed a paragraph above the spot being held
    set = set.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(addMark)) {
        const deco = Decoration.widget({
          widget: new NoteMark(e.value.id, e.value.reason),
          side: 1,
        });
        set = set.update({ add: [deco.range(e.value.pos)] });
      } else if (e.is(dropMark)) {
        set = set.update({ filter: (_from, _to, value) => widgetId(value) !== e.value });
      }
    }
    return set;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const widgetId = (value: unknown): number | null => {
  const widget = (value as { spec?: { widget?: unknown } })?.spec?.widget;
  return widget instanceof NoteMark ? widget.id : null;
};

/** Where the mark for this paste is now — or null, because the document was
 *  reloaded from disk under it, or the tab was closed and reopened. */
function markPos(view: EditorView, id: number): number | null {
  let found: number | null = null;
  view.state.field(marks).between(0, view.state.doc.length, (from, _to, value) => {
    if (widgetId(value) !== id) return;
    found = from;
    return false;
  });
  return found;
}

let seq = 0;

export function notePaste(root: string): Extension {
  /**
   * Whether the next paste is to go in exactly as it is.
   *
   * ⌘⇧V is the escape hatch, and it has to be read from the keystroke rather
   * than from the paste: a `paste` event carries the clipboard and no modifiers
   * at all, so by the time the text is in hand there is no way left to ask how
   * it was asked for. Set on the way down, spent by the paste that follows, and
   * cleared by any other key — a ⌘⇧V that lands somewhere else must not make
   * the next ordinary paste raw.
   */
  let rawNext = false;

  const finish = (view: EditorView, id: number, text: string, reason: string | null) => {
    const pos = markPos(view, id);
    if (pos === null) return;
    const effects: StateEffect<unknown>[] = [dropMark.of(id)];
    if (reason !== null) {
      // the note goes after the text it is about, and takes itself away
      const at = pos + text.length;
      const kept = ++seq;
      effects.push(addMark.of({ id: kept, pos: at, reason }));
      window.setTimeout(() => view.dispatch({ effects: dropMark.of(kept) }), 4000);
    }
    view.dispatch({
      changes: { from: pos, insert: text },
      selection: { anchor: pos + text.length },
      effects,
      scrollIntoView: true,
    });
  };

  return [
    marks,
    EditorView.domEventHandlers({
      keydown(event) {
        rawNext = (event.metaKey || event.ctrlKey) && event.shiftKey && event.code === "KeyV";
        return false;
      },
      paste(event, view) {
        const text = event.clipboardData?.getData("text/plain") ?? "";
        const raw = rawNext;
        rawNext = false;
        // false hands it back to CodeMirror, which pastes it the ordinary way
        if (raw || !worthFormatting(text)) return false;
        event.preventDefault();

        const id = ++seq;
        const { from, to } = view.state.selection.main;
        // the selection a paste replaces goes now, so the mark sits exactly
        // where the text will
        view.dispatch({
          changes: { from, to, insert: "" },
          selection: { anchor: from },
          effects: addMark.of({ id, pos: from, reason: null }),
        });

        api.noteFormat(root, text).then(
          (clean) => finish(view, id, clean, null),
          (err) => finish(view, id, text, String(err).replace(/^Error:\s*/, ""))
        );
        return true;
      },
    }),
  ];
}
