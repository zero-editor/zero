import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType, keymap } from "@codemirror/view";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import {
  EditorSelection,
  EditorState,
  Extension,
  Facet,
  Line,
  Prec,
  Range,
  StateField,
  Text,
} from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import { api } from "./api";

/**
 * A note read as a note, without leaving the editor.
 *
 * The obvious way to render markdown is a second view — a preview — and the
 * first version of this had one. It was a picture: you could tick a box in it,
 * and nothing else. You couldn't paste into it, which for a scratch note is
 * the whole job. This does what Obsidian's live preview does instead: the
 * editor stays the editor, and decorations hide the markup and draw the
 * result in its place. A `# ` disappears and its line grows; `**bold**` loses
 * its stars; `- [ ]` becomes a checkbox you can click; a link shows its text
 * and opens on ⌘-click. Paste, undo, autosave and ⌘⌥N are the editor's and
 * need nothing from here.
 *
 * **The markup never comes back.** The first version did what Obsidian does
 * — the line the cursor is on shows its marks — and that is the thing that
 * makes those editors feel wonky: clicking a line moves every word in it
 * sideways, and the line you aimed at jumps out from under the pointer. A
 * `#` you can only see by landing on the line it opens isn't worth what it
 * costs to look at, so the marks stay gone and are reached by deleting them
 * instead: the cursor steps over a hidden mark rather than into it, the head
 * of a line is its first visible character, and one backspace there takes
 * the whole of a `## ` or a `- [ ] ` off at once. Typing them *makes* them —
 * `## ` is a heading by the time the space lands, and the mark is gone the
 * moment it means something.
 *
 * Two kinds of line keep their marks, and both because the line *is* the
 * mark: a fence and a `---`. Nothing moves sideways when those come back,
 * and a fence is the only handle on a code block and on the language it
 * names. A link's target is the one thing hiding really takes away, since a
 * note has no Source face to read it in — so the link carries it as a
 * tooltip, and ⌘-click still opens it.
 *
 * A copy gives you the text you can see: the hidden marks are left out of
 * the clipboard, and so are the fence lines around a code block, so a
 * command copied out of a note is the command and not three backticks with
 * a command inside.
 *
 * Everything here is derived from the syntax tree the markdown mode already
 * builds, and rebuilt for the visible lines on every edit, selection move or
 * scroll. Nothing is stored: the document is the markdown, always.
 *
 * One thing the tree is not: finished when the editor first paints. The
 * language parses the first 3000 characters up front and the rest in an idle
 * callback a hundred milliseconds or more later — and a note opens with the
 * cursor at its end, which on a note of any age is past that line. So the
 * first frame showed the tail as raw markdown and the next one drew it
 * properly: headings grew, dashes turned into boxes, the lines above shifted
 * to make room. `parsedTo` asks for the tree to reach the lines being drawn
 * before drawing them. Markdown is cheap to parse — a whole 50 KB note takes
 * under 10 ms — and a note is small, so the wait is never felt; the budget
 * is there for the file this is put in front of that isn't a note.
 */

/** the tree, parsed at least up to `to` when that is affordable */
function parsedTo(state: EditorState, to: number) {
  return ensureSyntaxTree(state, to, 20) ?? syntaxTree(state);
}

/** the one thing that is interactive: a real checkbox in place of `[ ]` */
class Checkbox extends WidgetType {
  constructor(readonly done: boolean) {
    super();
  }
  eq(other: Checkbox) {
    return other.done === this.done;
  }
  toDOM(view: EditorView) {
    // the box rides in a wrapper exactly one line tall that centres what it
    // holds — so it is centred on the line by construction, not by a nudge
    // tuned to one font's metrics (see .nl-task-box)
    const el = document.createElement("span");
    el.className = "nl-task-box";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = this.done;
    box.className = "nl-check";
    box.tabIndex = -1;
    el.appendChild(box);
    // mousedown, not click: the editor would otherwise take the press as a
    // cursor placement first. The position is asked for at the time of the
    // press rather than stored, so a box drawn before an edit above it still
    // finds its own brackets.
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const pos = view.posAtDOM(el);
      const mark = view.state.doc.sliceString(pos, pos + 3);
      if (!/^\[[ xX]\]$/.test(mark)) return;
      view.dispatch({
        changes: { from: pos + 1, to: pos + 2, insert: mark[1] === " " ? "x" : " " },
      });
    });
    return el;
  }
}

/** `- ` drawn as the dot it means */
class Bullet extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "nl-bullet";
    el.textContent = "•";
    return el;
  }
}

/** `---` drawn as the line it means */
class Rule extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "nl-rule";
    return el;
  }
}

type Align = "left" | "center" | "right" | null;

/**
 * A pipe table is drawn on its own lines rather than in place of them. The
 * first version swapped the lines for a drawn table and swapped them back,
 * monospaced, while the cursor was anywhere in it — so clicking a cell moved
 * every cell, and the one aimed at was somewhere else by the time it was
 * reached. Now the pipes are hidden like any other mark and each cell is a
 * box as wide as its column: the cursor goes into the cell it lands on and
 * nothing around it moves. The delimiter row is folded into the header line,
 * where its rule is the header's underline.
 *
 * A column is as wide as its widest cell, measured rather than laid out —
 * the lines of a table are separate lines, and nothing in CSS lines up boxes
 * across them, so the widths have to be known before the lines are drawn.
 * The table then fills the width of the editor: extra room goes to the
 * columns in proportion to what they hold, and a table too wide to fit gives
 * it back from the columns with room to spare first, wrapping text inside
 * its cells, the way a browser lays out a table at 100%. Both are arithmetic
 * on the editor's width, so they are written as CSS against it (`cqw`) and
 * follow a resize without anything here being told about one.
 *
 * Cells are text, as they always were: a `**` or a backtick in one stays as
 * typed, because a hidden mark would make a cell narrower than it measures.
 */

/** a cell's right padding (`.nl-cell`), plus two pixels so a width a hair
 *  short of the drawn text never wraps its last letter */
const CELL_PAD = 14 + 2;
/** a long word wraps rather than hold a column this wide when the table has
 *  to shrink — a url shouldn't decide how narrow the others get */
const WORD_CAP = 96;
/** the width a table has: the line's reading margin (20px) and CodeMirror's
 *  right padding (2px) off the editor's, and two to spare for rounding */
const AVAIL = "(100cqw - 24px)";

/**
 * Text widths as WebKit sets them. A canvas measures this face a few percent
 * narrow — nine pixels on a sentence, enough to wrap the last word of the
 * cell a column was sized to — so the text is set in the page instead, off
 * screen in the cells' own face and size (`.nl-ruler`): every string a build
 * hasn't seen before in one layout, and each remembered after that, so a
 * keystroke in a cell costs one string.
 */
const measured = new Map<string, number>();
let ruler: HTMLElement | null = null;
const key = (text: string, bold: boolean) => (bold ? "b" : "r") + text;

function measureAll(texts: Iterable<[string, boolean]>) {
  const todo = new Map<string, [string, boolean]>();
  for (const [t, b] of texts) if (t && !measured.has(key(t, b))) todo.set(key(t, b), [t, b]);
  if (!todo.size) return;
  if (measured.size > 4000) measured.clear();
  if (!ruler) {
    ruler = document.createElement("div");
    ruler.className = "nl-ruler";
    ruler.setAttribute("aria-hidden", "true");
    document.body.appendChild(ruler);
  }
  const spans = [...todo.values()].map(([t, b]) => {
    const el = document.createElement("span");
    el.textContent = t;
    if (b) el.className = "nl-ruler-b";
    return el;
  });
  ruler.replaceChildren(...spans);
  [...todo.keys()].forEach((k, i) => measured.set(k, spans[i].getBoundingClientRect().width));
  ruler.replaceChildren();
}

const widthOf = (text: string, bold: boolean) => (text ? (measured.get(key(text, bold)) ?? 0) : 0);

/**
 * One cell of a row, as positions: `from`–`to` is what it shows and `end` is
 * where it stops, at the next pipe. A cell with text shows the text, trimmed;
 * one without shows the whitespace it has, so there is somewhere in it to
 * click and type.
 */
type Slot = { from: number; to: number; end: number; empty: boolean };

/** the cells of a TableHeader or TableRow, read off its TableCells and pipes.
 *  A leading or trailing pipe opens or closes a row without making a cell;
 *  two pipes with nothing between them do make one, an empty one. */
function slots(row: SyntaxNode): Slot[] {
  const out: Slot[] = [];
  let start = row.from;
  let cell: SyntaxNode | null = null;
  let opened = false;
  for (let c = row.firstChild; c; c = c.nextSibling) {
    if (c.name === "TableCell") cell = c;
    else if (c.name === "TableDelimiter") {
      if (cell) out.push({ from: cell.from, to: cell.to, end: c.from, empty: false });
      else if (opened) out.push({ from: start, to: c.from, end: c.from, empty: true });
      opened = true;
      cell = null;
      start = c.to;
    }
  }
  if (cell) out.push({ from: cell.from, to: cell.to, end: row.to, empty: false });
  return out;
}

/** the alignments the delimiter row asks for, one per column */
function alignments(delim: SyntaxNode, doc: Text): Align[] {
  const out: Align[] = [];
  for (const cell of doc.sliceString(delim.from, delim.to).split("|")) {
    const t = cell.trim();
    if (!t) continue;
    const l = t.startsWith(":");
    const r = t.endsWith(":");
    out.push(l && r ? "center" : r ? "right" : l ? "left" : null);
  }
  return out;
}

/**
 * Each column's width, as CSS. `max` is the widest cell and `min` the longest
 * word (capped), both with the cell's padding. With room to spare every
 * column grows in proportion to `max`; short of room, each gives up the
 * share of its `max - min` that the shortfall needs — linear in the
 * editor's width either way, which is what lets it be one `calc`.
 */
function columnWidths(max: number[], min: number[]): string[] {
  const sMax = max.reduce((a, b) => a + b, 0);
  const sMin = min.reduce((a, b) => a + b, 0);
  const n = (x: number) => +x.toFixed(4);
  return max.map((hi, i) => {
    const lo = min[i];
    const b = sMax > sMin ? (hi - lo) / (sMax - sMin) : 0;
    const shrink = b
      ? `clamp(${n(lo)}px, calc(${n(lo - b * sMin)}px + ${n(b)} * ${AVAIL}), ${n(hi)}px)`
      : `${n(hi)}px`;
    const grow = `max(0px, calc(${n(hi / sMax)} * ${AVAIL} - ${n(hi)}px))`;
    return `calc(${shrink} + ${grow})`;
  });
}

/** a cell with no characters at all — `||` — still has a box */
class EmptyCell extends WidgetType {
  constructor(readonly style: string) {
    super();
  }
  eq(other: EmptyCell) {
    return other.style === this.style;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "nl-cell";
    el.setAttribute("style", this.style);
    return el;
  }
}

const hide = Decoration.replace({});
/** the same nothing, for a task's dash — kept apart so a copy can tell the two
 *  hidden things apart: a `**` leaves the clipboard, a `- ` before a `[ ]` stays,
 *  because a task list pasted elsewhere should still be one */
const hideDash = Decoration.replace({});
const bullet = Decoration.replace({ widget: new Bullet() });
const rule = Decoration.replace({ widget: new Rule() });
const checked = Decoration.replace({ widget: new Checkbox(true) });
const unchecked = Decoration.replace({ widget: new Checkbox(false) });
const codeMark = Decoration.mark({ class: "nl-code" });
/** a fence line's marks, shown — on the cursor line — and hidden everywhere
 *  else. Two decorations rather than one so a copy can drop the line whole
 *  either way: a fence is never content, seen or unseen */
const fenceMark = Decoration.mark({ class: "nl-fence" });
const hideFence = Decoration.replace({});
const line = (cls: string) => Decoration.line({ class: cls });
/** the `](…)` is hidden like every other mark, so the target lives in the
 *  tooltip — the only place left in a note that can say where a link goes */
const link = (href: string) =>
  Decoration.mark({ class: "nl-link", attributes: { "data-href": href, title: href } });
const issueLink = (id: string) =>
  Decoration.mark({ class: "nl-link nl-issue", attributes: { "data-issue": id } });

/**
 * Bare Linear identifiers — `ECL-141` — drawn as links and opened, on
 * ⌘-click, as the issue tab the sidebar would open. Off unless the project is
 * connected to Linear, and then only for that workspace's own team keys, so
 * `UTF-8` and `SHA-256` never light up: a false link in a note is worse than
 * no link, since the note is the one place the text is meant to be trusted.
 * Nothing is written into the markdown — the identifier stays the plain
 * token it was, and reads as one anywhere else.
 */
export type IssueLinks = { keys: string[]; open: (identifier: string) => void };
export const issueLinks = Facet.define<IssueLinks, IssueLinks | null>({
  combine: (v) => v.find((x) => x.keys.length > 0) ?? null,
});

/** the identifiers to look for, as one pattern, or nothing when there are no keys */
export function issuePattern(links: IssueLinks | null | undefined): RegExp | null {
  if (!links?.keys.length) return null;
  const alt = links.keys.map((k) => k.replace(/[^A-Za-z0-9]/g, "\\$&")).join("|");
  return new RegExp(`(?<![A-Za-z0-9-])(?:${alt})-\\d+(?![A-Za-z0-9-])`, "g");
}

/** inside code, or already inside a link: the token there is not one */
const NO_LINK = /^(?:InlineCode|CodeText|FencedCode|CodeBlock|URL|Link|Autolink|HTMLTag|HTMLBlock)$/;

const HEADING = /^ATXHeading([1-6])$/;
const TASK = /^\[[ xX]\]$/;

/** a mark and, when one follows it, the single space that separates it from
 *  what it marks — hiding `#` and leaving its space indents the line */
const withSpace = (doc: Text, to: number) => (doc.sliceString(to, to + 1) === " " ? to + 1 : to);

/** what the plugin draws, and where the cursor may not go */
type Built = { decorations: DecorationSet; atoms: DecorationSet };

function build(view: EditorView): Built {
  const { state } = view;
  const doc = state.doc;
  const sel = state.selection.main;
  const cursorLine = sel.empty ? doc.lineAt(sel.head) : null;
  /** whether the line holding `pos` is the one the cursor is on — a cursor,
   *  not a selection: see the note above about copying */
  const onCursorLine = (pos: number) =>
    cursorLine !== null && pos >= cursorLine.from && pos <= cursorLine.to;

  const out: Range<Decoration>[] = [];
  const atoms: [number, number][] = [];
  /** a mark drawn as nothing (or as a box, or a dot) and, over the same text,
   *  taken out of the cursor's way. The two go together — what cannot be seen
   *  must not be stepped into, or the cursor sits in pixels it does not
   *  occupy and a keystroke un-makes the heading. It is also what keeps the
   *  crossing cheap: one press steps over a hidden `](https://…)` however
   *  long it is. `reach` is how far the atom runs when that is further than
   *  the decoration: a bullet's dot replaces the `-` alone, but the space
   *  after it belongs to the marker, and `- ` comes off in one backspace. */
  const hidden = (deco: Decoration, from: number, to: number, reach = to) => {
    out.push(deco.range(from, to));
    atoms.push([from, reach]);
  };
  const ranges = view.visibleRanges;
  const tree = parsedTo(state, ranges.length ? ranges[ranges.length - 1].to : 0);

  for (const { from, to } of ranges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name;
        const active = onCursorLine(node.from);
        const heading = HEADING.exec(name);
        if (heading) {
          out.push(line(`nl-h${heading[1]}`).range(doc.lineAt(node.from).from));
          return;
        }
        switch (name) {
          case "HeaderMark":
            hidden(hide, node.from, withSpace(doc, node.to));
            return;
          case "EmphasisMark":
          case "StrikethroughMark":
            hidden(hide, node.from, node.to);
            return;
          case "InlineCode":
            out.push(codeMark.range(node.from, node.to));
            return;
          case "CodeMark": {
            // a fence is a line of its own: showing it moves no text, and it
            // is the only handle on the block and on the language it names
            if (node.node.parent?.name === "InlineCode") hidden(hide, node.from, node.to);
            else out.push((active ? fenceMark : hideFence).range(node.from, node.to));
            return;
          }
          case "CodeInfo":
            // hidden, the fence line is an empty tinted line — the block's
            // own padding, top and bottom
            out.push((active ? fenceMark : hideFence).range(node.from, node.to));
            return;
          case "FencedCode": {
            // every line of the block wears the background, fences included,
            // so the block reads as one thing rather than striped
            const first = doc.lineAt(node.from).number;
            const last = doc.lineAt(node.to).number;
            for (let n = first; n <= last; n++) out.push(line("nl-codeblock").range(doc.line(n).from));
            return;
          }
          case "Table":
            // drawn by the `tables` field below: folding the delimiter row
            // into the header line changes the vertical layout, which only
            // state may do — a plugin that tries is switched off along with
            // everything else it draws. Never into the cells: a hidden `**`
            // would leave a cell narrower than it was measured.
            return false;
          case "QuoteMark":
            out.push(line("nl-quote").range(doc.lineAt(node.from).from));
            hidden(hide, node.from, withSpace(doc, node.to));
            return;
          case "HorizontalRule":
            if (!active) out.push(rule.range(node.from, node.to));
            return;
          case "ListMark": {
            const item = node.node.parent;
            const task = node.node.nextSibling;
            // the checkbox is the marker and the dash would be a second one
            if (task?.name === "Task") hidden(hideDash, node.from, withSpace(doc, node.to));
            else if (item?.parent?.name === "BulletList")
              hidden(bullet, node.from, node.to, withSpace(doc, node.to));
            return;
          }
          case "TaskMarker": {
            const mark = doc.sliceString(node.from, node.to);
            if (!TASK.test(mark)) return;
            const done = mark[1] !== " ";
            out.push(line(done ? "nl-task nl-done" : "nl-task").range(doc.lineAt(node.from).from));
            hidden(done ? checked : unchecked, node.from, node.to, withSpace(doc, node.to));
            return;
          }
          case "Link": {
            const url = node.node.getChild("URL");
            if (url) out.push(link(doc.sliceString(url.from, url.to)).range(node.from, node.to));
            return;
          }
          case "LinkMark":
          case "LinkTitle":
            hidden(hide, node.from, node.to);
            return;
          case "URL":
            if (node.node.parent?.name === "Link") {
              hidden(hide, node.from, node.to);
            } else {
              // a bare url: its own text is the link
              out.push(link(doc.sliceString(node.from, node.to)).range(node.from, node.to));
            }
            return;
        }
      },
    });
  }
  const pattern = issuePattern(state.facet(issueLinks));
  if (pattern) {
    for (const { from, to } of ranges) {
      const text = doc.sliceString(from, to);
      for (const m of text.matchAll(pattern)) {
        const start = from + m.index;
        let node: SyntaxNode | null = tree.resolveInner(start, 1);
        for (; node; node = node.parent) if (NO_LINK.test(node.name)) break;
        if (node) continue;
        out.push(issueLink(m[0]).range(start, start + m[0].length));
      }
    }
  }
  return { decorations: Decoration.set(out, true), atoms: atomSet(atoms) };
}

/** the hidden runs as one range set, adjacent ones joined: `- [ ] ` is four
 *  decorations and one marker, and one backspace at the head of the text is
 *  what takes a task back to a line of prose */
function atomSet(atoms: [number, number][]): DecorationSet {
  atoms.sort((a, b) => a[0] - b[0]);
  const out: Range<Decoration>[] = [];
  let run: [number, number] | null = null;
  for (const [from, to] of atoms) {
    if (run && from <= run[1]) run[1] = Math.max(run[1], to);
    else {
      if (run) out.push(hide.range(run[0], run[1]));
      run = [from, to];
    }
  }
  if (run) out.push(hide.range(run[0], run[1]));
  return Decoration.set(out);
}

/** where a table row is and where in it the cursor may rest: `from`–`to` is
 *  the whole line (the header's takes the folded delimiter row with it), and
 *  `head`–`tail` runs from its first cell to the end of its last */
type RowSpan = { from: number; to: number; head: number; tail: number };
type Tables = { decorations: DecorationSet; cells: DecorationSet; atoms: DecorationSet; rows: RowSpan[] };

/**
 * A table's pipes and the space around them, drawn as nothing — and a nothing
 * of its own, apart from `hide`, so a copy keeps them: a table copied out is
 * still a table.
 *
 * The one thing it does is say where a cursor beside it goes. CodeMirror
 * draws a cursor at the end of a cell against whatever follows it, and what
 * follows is this, sitting at the next column's edge — so the cursor at the
 * end of a word, or after a space just typed, was drawn at the start of the
 * next cell. It goes against the cell's text instead.
 */
class Pipes extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    return document.createElement("span");
  }
  get isHidden() {
    return true;
  }
  coordsAt(dom: HTMLElement, pos: number) {
    return besideCell(dom, pos === 0 ? -1 : 1);
  }
}

/** the caret at the end of the cell before `dom` (-1) or the start of the one
 *  after it (1); null at the ends of a row, where there is no cell */
function besideCell(dom: HTMLElement, dir: -1 | 1) {
  const step = (n: Node | null) => (dir < 0 ? n?.previousSibling : n?.nextSibling) ?? null;
  let cell = step(dom);
  while (cell?.nodeName === "IMG") cell = step(cell); // cm-widgetBuffer
  if (!(cell instanceof HTMLElement) || !cell.classList.contains("nl-cell")) return null;
  let text: globalThis.Text | null = null;
  const walk = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (!n.nodeValue) continue;
    text = n as globalThis.Text;
    if (dir > 0) break;
  }
  if (!text) {
    // an empty cell: its left edge, a line tall
    const box = cell.getBoundingClientRect();
    const cs = getComputedStyle(cell);
    const top = box.top + parseFloat(cs.paddingTop);
    return { left: box.left, right: box.left, top, bottom: box.bottom - parseFloat(cs.paddingBottom) };
  }
  const len = text.nodeValue!.length;
  const range = document.createRange();
  if (dir < 0) {
    const low = /[\udc00-\udfff]/.test(text.nodeValue![len - 1]) && len > 1;
    range.setStart(text, len - (low ? 2 : 1));
    range.setEnd(text, len);
  } else {
    range.setStart(text, 0);
    range.setEnd(text, /[\ud800-\udbff]/.test(text.nodeValue![0]) && len > 1 ? 2 : 1);
  }
  const rects = range.getClientRects();
  const r = rects[dir < 0 ? rects.length - 1 : 0];
  if (!r) return null;
  const x = dir < 0 ? r.right : r.left;
  return { left: x, right: x, top: r.top, bottom: r.bottom };
}

const hidePipe = Decoration.replace({ widget: new Pipes() });

/**
 * The tables, as a state field rather than part of the plugin: folding the
 * delimiter row into the header line changes the height of the document,
 * and CodeMirror only takes that from state, where it is known before
 * layout. Computed over the whole document rather than the viewport — a
 * column is as wide as its widest cell, wherever that cell is scrolled to.
 */
function buildTables(state: EditorState): Tables {
  const doc = state.doc;
  type Row = { node: SyntaxNode; header: boolean; cells: Slot[]; texts: string[] };
  const found: { rows: Row[]; delim: SyntaxNode | null }[] = [];
  parsedTo(state, doc.length).iterate({
    enter: (node) => {
      if (node.name !== "Table") return;
      const rows: Row[] = [];
      let delim: SyntaxNode | null = null;
      for (let c = node.node.firstChild; c; c = c.nextSibling) {
        if (c.name === "TableHeader" || c.name === "TableRow") {
          const cells = slots(c);
          const texts = cells.map((s) => (s.empty ? "" : doc.sliceString(s.from, s.to)));
          rows.push({ node: c, header: c.name === "TableHeader", cells, texts });
        } else if (c.name === "TableDelimiter") delim = c;
      }
      found.push({ rows, delim });
      return false;
    },
  });
  // every cell and every word in one, before any of them is read
  const words = (text: string) => text.split(/\s+/);
  measureAll(
    found.flatMap(({ rows }) =>
      rows.flatMap((r) => r.texts.flatMap((t) => [t, ...words(t)].map((x): [string, boolean] => [x, r.header]))),
    ),
  );

  const sel = state.selection.main;
  // a space typed at the end of a cell shows while the cursor is past it —
  // nothing moves, the box is as wide either way — and goes back to being
  // padding when the cursor leaves
  const cursor = sel.empty ? sel.head : -1;
  const decos: Range<Decoration>[] = [];
  const cells: Range<Decoration>[] = [];
  const atoms: Range<Decoration>[] = [];
  const spans: RowSpan[] = [];
  for (const { rows, delim } of found) {
    const max: number[] = [];
    const min: number[] = [];
    for (const r of rows)
      r.texts.forEach((text, i) => {
        const word = Math.max(0, ...words(text).map((w) => widthOf(w, r.header)));
        max[i] = Math.max(max[i] ?? 0, widthOf(text, r.header) + CELL_PAD);
        min[i] = Math.max(min[i] ?? 0, Math.min(word, WORD_CAP) + CELL_PAD);
      });
    const align = delim ? alignments(delim, doc) : [];
    const cols = columnWidths(max, min).map((width, i) => {
      const style = `width: ${width}` + (align[i] ? `; text-align: ${align[i]}` : "");
      return { style, mark: Decoration.mark({ class: "nl-cell", attributes: { style } }) };
    });

    rows.forEach((r, n) => {
      const ln = doc.lineAt(r.node.from);
      // the header line takes the delimiter row with it: the row's rule is
      // the header's underline, and it holds nothing to put a cursor in
      const end = r.header && delim ? doc.lineAt(delim.from).to : ln.to;
      // an indent goes with the leading pipe; a `> ` is the quote's own
      let pos = doc.sliceString(ln.from, r.node.from).trim() ? r.node.from : ln.from;
      const cls = ["nl-trow", r.header && "nl-thead", n === 0 && "nl-tfirst", n === rows.length - 1 && "nl-tlast"];
      decos.push(line(cls.filter(Boolean).join(" ")).range(ln.from));
      const gap = (to: number) => {
        if (to <= pos) return;
        decos.push(hidePipe.range(pos, to));
        atoms.push(hidePipe.range(pos, to));
      };
      const head = r.cells.length ? r.cells[0].from : pos;
      for (const [i, c] of r.cells.entries()) {
        const to = !c.empty && cursor > c.to && cursor <= c.end ? cursor : c.to;
        gap(c.from);
        if (to > c.from) cells.push(cols[i].mark.range(c.from, to));
        else cells.push(Decoration.widget({ widget: new EmptyCell(cols[i].style) }).range(c.from));
        pos = to;
      }
      const tail = pos;
      gap(end);
      spans.push({ from: ln.from, to: end, head, tail });
    });
  }
  return {
    decorations: Decoration.set(decos, true),
    cells: Decoration.set(cells, true),
    atoms: Decoration.set(atoms, true),
    rows: spans,
  };
}

const tables = StateField.define<Tables>({
  create: buildTables,
  update(value, tr) {
    if (tr.docChanged || syntaxTree(tr.state) !== syntaxTree(tr.startState)) return buildTables(tr.state);
    // the cursor only changes what a table draws while it is in one
    if (tr.selection && (rowAt(value.rows, tr.startState.selection.main.head) || rowAt(value.rows, tr.selection.main.head)))
      return buildTables(tr.state);
    return value;
  },
  provide: (f) => [
    EditorView.decorations.from(f, (v) => v.decorations),
    // a cell wraps around every other mark rather than being split by one —
    // the highlighter's `**`, a search match running over a pipe — since a
    // split cell is two boxes, each a column wide
    EditorView.outerDecorations.from(f, (v) => v.cells),
    // the pipes are stepped over like any other hidden mark: a press at the
    // end of one cell lands at the start of the next
    EditorView.atomicRanges.of((view) => view.state.field(f, false)?.atoms ?? Decoration.none),
  ],
});

/** the table row whose line holds `pos`, if there is one */
function rowAt(rows: readonly RowSpan[], pos: number): RowSpan | null {
  let lo = 0;
  let hi = rows.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = rows[mid];
    if (pos < r.from) hi = mid - 1;
    else if (pos > r.to) lo = mid + 1;
    else return r;
  }
  return null;
}

const plugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    atoms: DecorationSet;
    constructor(view: EditorView) {
      ({ decorations: this.decorations, atoms: this.atoms } = build(view));
    }
    update(u: ViewUpdate) {
      if (
        u.docChanged ||
        u.selectionSet ||
        u.viewportChanged ||
        u.state.facet(issueLinks) !== u.startState.facet(issueLinks) ||
        syntaxTree(u.state) !== syntaxTree(u.startState)
      )
        ({ decorations: this.decorations, atoms: this.atoms } = build(u.view));
    }
  },
  {
    decorations: (v) => v.decorations,
    // cursor motion and deletion step over the markup a line opens with
    // rather than into it — see `hidden` in build()
    provide: (p) => EditorView.atomicRanges.of((view) => view.plugin(p)?.atoms ?? Decoration.none),
  },
);

/**
 * The head of a line is its first visible character.
 *
 * `# ` is drawn as nothing, so the place in front of it and the place after
 * it are the same pixels — and a keystroke in the first one un-makes the
 * heading, which is the jump all of this exists to prevent. ⌘←, a click in
 * the margin and an arrow down onto the line all land there, so arriving at
 * a line puts the cursor past the markup instead. The one exception is the
 * far side of it: a step left off the first character is a deliberate walk
 * out of the line, and the step after that one reaches the line above.
 *
 * A table row has the same thing at both ends — a leading pipe in front of
 * its first cell, a trailing one after its last, and text typed beyond
 * either is a new column — so a row keeps the cursor between them the same
 * way, and only a second step past an end leaves it. A click is never a
 * step: it lands in the cell nearest to it.
 *
 * Selection-only transactions, because after an edit the cursor is already
 * where the edit put it — and reading the tree of the document a transaction
 * is about to produce means building its state inside a filter, which is the
 * one thing a filter is asked not to do.
 */
const cursorPastMarkup = EditorState.transactionFilter.of((tr) => {
  if (!tr.selection || tr.docChanged) return tr;
  const state = tr.startState;
  const was = state.selection.main.head;
  const rows = state.field(tables, false)?.rows ?? [];
  const click = tr.isUserEvent("select.pointer");
  let moved = false;
  const ranges = tr.selection.ranges.map((r) => {
    if (!r.empty) return r;
    const row = rowAt(rows, r.head);
    if (row) {
      if (r.head >= row.head && r.head <= row.tail) return r;
      if (!click && ((r.head === row.from && was === row.head) || (r.head === row.to && was === row.tail)))
        return r;
      moved = true;
      return r.head < row.head ? EditorSelection.cursor(row.head, 1) : EditorSelection.cursor(row.tail, -1);
    }
    const line = state.doc.lineAt(r.head);
    const head = lineHead(state, line);
    // the far side of the run is a place to be — it is the start of the line,
    // and the next step left leaves the line. Inside it is not.
    if (r.head >= head || (r.head === line.from && was >= line.from && was <= head)) return r;
    moved = true;
    return EditorSelection.cursor(head, -1);
  });
  return moved ? [tr, { selection: EditorSelection.create(ranges, tr.selection.mainIndex) }] : tr;
});

/**
 * Where a line's hidden markup ends — the same run `build` hides, read off
 * the same tree, and only what `build` actually hides: an ordered list's
 * `1. ` and a fence are left on the page, so the cursor is left able to
 * reach them. A line the parser has not got to yet has no markup, which is
 * the right answer for a line nothing has been drawn on either.
 */
function lineHead(state: EditorState, line: Line): number {
  const doc = state.doc;
  let head = line.from;
  syntaxTree(state).iterate({
    from: line.from,
    to: line.to,
    // nothing but the indent may stand between one mark and the next: past
    // that, the line has started and nothing in it is hidden
    enter: (node) => {
      if (node.from > head && doc.sliceString(head, node.from).trim()) return false;
      switch (node.name) {
        case "HeaderMark":
        case "QuoteMark":
        case "TaskMarker":
          head = Math.max(head, withSpace(doc, node.to));
          return false;
        // a line can open with inline markup too — `**Note:** …` — and the
        // place in front of that is as invisible as any other
        case "EmphasisMark":
        case "StrikethroughMark":
        case "LinkMark":
          head = Math.max(head, node.to);
          return false;
        case "CodeMark":
          if (node.node.parent?.name === "InlineCode") head = Math.max(head, node.to);
          return false;
        case "ListMark": {
          const item = node.node.parent;
          if (node.node.nextSibling?.name === "Task" || item?.parent?.name === "BulletList")
            head = Math.max(head, withSpace(doc, node.to));
          return false;
        }
      }
    },
  });
  return head;
}

/**
 * Backspace at the start of a cell, and Delete at the end of one, stop there.
 * Past the edge is a hidden pipe, and taking it merges two cells into one —
 * or, past the first or last, joins the row to the line beside it. The mark
 * a line opens with comes off in one backspace because that is how a heading
 * is unmade; a cell is not unmade that way, so here the press does nothing.
 */
function atCellEdge(view: EditorView, dir: -1 | 1): boolean {
  const { state } = view;
  const field = state.field(tables, false);
  const sel = state.selection;
  if (!field || sel.ranges.length > 1 || !sel.main.empty) return false;
  const at = sel.main.head;
  if (!rowAt(field.rows, at)) return false;
  let edge = false;
  field.atoms.between(at - 1, at + 1, (from, to) => {
    if (dir < 0 ? to === at && from < at : from === at && to > at) edge = true;
  });
  return edge;
}

const cellEdges = Prec.high(
  keymap.of([
    { key: "Backspace", run: (view) => atCellEdge(view, -1) },
    { key: "Delete", run: (view) => atCellEdge(view, 1) },
  ]),
);

/** ⌘-click on a link opens it in the browser, and on an identifier opens the
 *  issue; a plain click puts the cursor in it, because this is still an editor
 *  and the text is still editable */
const openLinks = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (!event.metaKey || event.button !== 0) return false;
    const a = (event.target as HTMLElement).closest?.(".nl-link");
    const issue = a?.getAttribute("data-issue");
    if (issue) {
      event.preventDefault();
      view.state.facet(issueLinks)?.open(issue);
      return true;
    }
    const href = a?.getAttribute("data-href");
    if (!href || !/^(?:https?:\/\/|mailto:)/i.test(href)) return false;
    event.preventDefault();
    void api.openUrl(href);
    return true;
  },
});

/**
 * The selected text as it is seen: the document's text with the hidden marks
 * taken out and the fence lines of a code block dropped whole. Only the
 * decorations that exist are consulted, and they exist for the visible lines,
 * which for a note is the note.
 */
function visibleText(view: EditorView, from: number, to: number): string {
  const doc = view.state.doc;
  const decos = view.plugin(plugin)?.decorations;
  if (!decos) return doc.sliceString(from, to);
  const cuts: [number, number][] = [];
  decos.between(from, to, (f, t, deco) => {
    if (deco === hide) cuts.push([Math.max(f, from), Math.min(t, to)]);
    else if (deco === fenceMark || deco === hideFence) {
      // the whole fence line, and the line break after it, so the code
      // arrives as the lines it is and not with a blank where the fence was
      const ln = doc.lineAt(f);
      cuts.push([Math.max(ln.from, from), Math.min(Math.min(ln.to + 1, doc.length), to)]);
    }
  });
  cuts.sort((a, b) => a[0] - b[0]);
  let out = "";
  let pos = from;
  for (const [f, t] of cuts) {
    if (f > pos) out += doc.sliceString(pos, f);
    pos = Math.max(pos, t);
  }
  return out + doc.sliceString(pos, to);
}

function copyVisible(event: ClipboardEvent, view: EditorView, cut: boolean) {
  const ranges = view.state.selection.ranges.filter((r) => !r.empty);
  // nothing selected: the editor's own line-wise copy is the right one
  if (!ranges.length || !event.clipboardData) return false;
  const text = ranges.map((r) => visibleText(view, r.from, r.to)).join(view.state.lineBreak);
  event.clipboardData.setData("text/plain", text);
  event.preventDefault();
  if (cut) view.dispatch(view.state.replaceSelection(""), { userEvent: "delete.cut" });
  return true;
}

const copyWhatYouSee = EditorView.domEventHandlers({
  copy: (event, view) => copyVisible(event, view, false),
  cut: (event, view) => copyVisible(event, view, true),
});

export function noteLive(): Extension {
  return [plugin, tables, cursorPastMarkup, cellEdges, openLinks, copyWhatYouSee];
}
