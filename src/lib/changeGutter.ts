import { EditorView, GutterMarker, ViewPlugin, ViewUpdate, gutter } from "@codemirror/view";
import { Extension, RangeSet, RangeSetBuilder, StateEffect, StateField, Text } from "@codemirror/state";
import { Chunk } from "@codemirror/merge";
import { Tick, scrollRuler } from "./scrollRuler";

/**
 * VS Code's "dirty diff": a bar in the gutter against every line that differs
 * from the committed file, and the same marks again in a ruler down the right
 * edge so a change you've scrolled past is still findable — and clickable, so
 * finding it is one press rather than a scroll hunt. See scrollRuler.ts.
 *
 * The diff is against HEAD rather than the index, so staging a file doesn't
 * make its bars disappear — the changes panel goes on listing a staged file,
 * and the two should agree about what "changed" means.
 */

/** The committed file. Null switches the bars off — see below for when. */
export const setBaseline = StateEffect.define<Text | null>();

const setMarks = StateEffect.define<RangeSet<GutterMarker>>();

const baseline = StateField.define<Text | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setBaseline)) return e.value;
    return value;
  },
});

type Kind = "add" | "mod" | "del";

class ChangeMarker extends GutterMarker {
  elementClass: string;
  constructor(readonly kind: Kind) {
    super();
    this.elementClass = `cm-change cm-change-${kind}`;
  }
  eq(other: GutterMarker) {
    return other instanceof ChangeMarker && other.kind === this.kind;
  }
}

const ADD = new ChangeMarker("add");
const MOD = new ChangeMarker("mod");
const DEL = new ChangeMarker("del");

const marks = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setMarks)) return e.value;
    // typing moves the marks it hasn't invalidated yet; the recompute below
    // lands a beat later and replaces the lot
    return tr.docChanged ? value.map(tr.changes) : value;
  },
});

/**
 * Past this a diff costs more than the bars are worth, and the file is one
 * nobody reads by eye anyway. Minified bundles and lock files are what
 * actually hit it.
 */
const MAX_DIFF_CHARS = 2_000_000;

function computeMarks(base: Text, doc: Text): RangeSet<GutterMarker> {
  if (base.length > MAX_DIFF_CHARS || doc.length > MAX_DIFF_CHARS) return RangeSet.empty;
  const builder = new RangeSetBuilder<GutterMarker>();
  // the builder wants strictly increasing positions, and two chunks can land
  // on one line: a deletion whose seam is the last line of the edit above it.
  // One mark per line, first claim wins.
  let last = -1;
  const at = (from: number, marker: GutterMarker) => {
    if (from <= last) return;
    last = from;
    builder.add(from, from, marker);
  };

  for (const chunk of Chunk.build(base, doc)) {
    // nothing on this side: lines were removed and none put back. There's no
    // line to paint, so the mark goes on the line the gap closed over — the
    // wedge VS Code draws between two lines.
    if (chunk.fromB >= chunk.toB) {
      at(doc.lineAt(Math.min(chunk.fromB, doc.length)).from, DEL);
      continue;
    }
    const kind = chunk.fromA >= chunk.toA ? ADD : MOD;
    const end = Math.min(chunk.endB, doc.length);
    for (let pos = chunk.fromB; ; ) {
      const line = doc.lineAt(pos);
      at(line.from, kind);
      if (line.to >= end) break;
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

/** Long enough that a held key doesn't diff the file per character, short
    enough that the bars feel like they belong to the keystroke. */
const SETTLE = 180;

const recompute = ViewPlugin.fromClass(
  class {
    timer = 0;
    constructor(readonly view: EditorView) {
      this.schedule(0);
    }
    update(u: ViewUpdate) {
      const rebased = u.transactions.some((tr) =>
        tr.effects.some((e) => e.is(setBaseline))
      );
      if (u.docChanged || rebased) this.schedule(rebased ? 0 : SETTLE);
    }
    schedule(ms: number) {
      window.clearTimeout(this.timer);
      this.timer = window.setTimeout(() => {
        const base = this.view.state.field(baseline);
        this.view.dispatch({
          effects: setMarks.of(
            base ? computeMarks(base, this.view.state.doc) : RangeSet.empty
          ),
        });
      }, ms);
    }
    destroy() {
      window.clearTimeout(this.timer);
    }
  }
);

const changeGutterExt = gutter({
  class: "cm-changeGutter",
  markers: (view) => view.state.field(marks),
});

/** Enough to map a file; past it the ruler is a solid block anyway and the
    only thing more ticks buy is DOM. */
const MAX_TICKS = 400;

function ticks(view: EditorView): Tick[] {
  const set = view.state.field(marks);
  const doc = view.state.doc;
  const total = doc.lines;
  const out: Tick[] = [];
  for (let it = set.iter(); it.value; it.next()) {
    const kind = (it.value as ChangeMarker).kind;
    const line = doc.lineAt(Math.min(it.from, doc.length)).number;
    const top = (line - 1) / total;
    const bottom = line / total;
    // consecutive changed lines are one change; drawing them as one div is
    // both what it looks like and a lot less DOM
    const last = out[out.length - 1];
    if (last && last.kind === kind && bottom > last.bottom && top <= last.bottom + 0.001) {
      last.bottom = bottom;
    } else {
      if (out.length >= MAX_TICKS) break;
      out.push({ kind, top, bottom });
    }
  }
  return out;
}

const ruler = scrollRuler(ticks, (u) =>
  u.transactions.some((tr) => tr.effects.some((e) => e.is(setMarks)))
);

export function changeGutter(): Extension {
  return [baseline, marks, changeGutterExt, recompute, ruler];
}
