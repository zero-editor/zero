import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import {
  EditorSelection,
  EditorState,
  Extension,
  Facet,
  Line,
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
type Grid = { head: string[]; align: Align[]; rows: string[][] };

/**
 * A pipe table drawn as a table, in place of its lines, whenever the cursor
 * is somewhere else. Built by hand from the tree's own rows and cells rather
 * than through React — a widget is made inside the editor's update, and a
 * render that lands a tick later would leave the editor measuring an empty
 * box. Cells are text: a `**` or a backtick inside one stays as typed. Click
 * anywhere on it and the cursor goes to the source, which is the table's
 * edit mode; ⌘-click a link in it and the link opens.
 */
class TableWidget extends WidgetType {
  constructor(readonly grid: Grid, readonly key: string) {
    super();
  }
  eq(other: TableWidget) {
    return other.key === this.key;
  }
  toDOM(view: EditorView) {
    const el = document.createElement("div");
    el.className = "nl-tablewrap";
    const table = document.createElement("table");
    const row = (cells: string[], tag: "th" | "td") => {
      const tr = document.createElement("tr");
      cells.forEach((text, n) => {
        const cell = document.createElement(tag);
        cell.textContent = text;
        const a = this.grid.align[n];
        if (a) cell.style.textAlign = a;
        tr.appendChild(cell);
      });
      return tr;
    };
    const thead = document.createElement("thead");
    thead.appendChild(row(this.grid.head, "th"));
    table.appendChild(thead);
    if (this.grid.rows.length) {
      const tbody = document.createElement("tbody");
      for (const r of this.grid.rows) tbody.appendChild(row(r, "td"));
      table.appendChild(tbody);
    }
    el.appendChild(table);
    el.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const pos = view.posAtDOM(el);
      view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
      view.focus();
    });
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

/** the rows and cells of a Table node, as the tree already has them: a
 *  TableHeader, a TableDelimiter that carries the alignments, and TableRows,
 *  each of TableCells. Short rows gain empty cells and long ones lose the
 *  extra, the same forgiveness a hand-written table gets everywhere else. */
function grid(node: SyntaxNode, doc: Text): Grid | null {
  const cellsOf = (row: SyntaxNode) => {
    const out: string[] = [];
    for (let c = row.firstChild; c; c = c.nextSibling)
      if (c.name === "TableCell") out.push(doc.sliceString(c.from, c.to).trim());
    return out;
  };
  let head: string[] | null = null;
  const align: Align[] = [];
  const rows: string[][] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "TableHeader") head = cellsOf(child);
    else if (child.name === "TableDelimiter") {
      for (const cell of doc.sliceString(child.from, child.to).split("|")) {
        const t = cell.trim();
        if (!t) continue;
        const l = t.startsWith(":");
        const r = t.endsWith(":");
        align.push(l && r ? "center" : r ? "right" : l ? "left" : null);
      }
    } else if (child.name === "TableRow") rows.push(cellsOf(child));
  }
  if (!head) return null;
  return { head, align, rows: rows.map((r) => head!.map((_, n) => r[n] ?? "")) };
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
          case "Table": {
            // drawn as a table by the `tables` field below, which is where a
            // block-sized replacement is allowed to come from — a plugin may
            // not change the vertical layout, and one that tries is switched
            // off along with everything else it draws. Here only the case
            // where it is being edited: pipes only line up in a monospaced
            // face. Never into its cells either way — a hidden `**` in one
            // row would knock its column out of line with the others.
            const [first, last] = tableLines(node.node, doc);
            if (cursorIn(sel, first, last))
              for (let n = first.number; n <= last.number; n++)
                out.push(line("nl-table").range(doc.line(n).from));
            return false;
          }
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

/** whole lines, first to last — a block widget has to stand in for complete
 *  lines, and a Table node's end can sit on the line break */
function tableLines(node: SyntaxNode, doc: Text) {
  return [doc.lineAt(node.from), doc.lineAt(Math.max(node.from, node.to - 1))] as const;
}

const cursorIn = (
  sel: { empty: boolean; head: number },
  first: { from: number },
  last: { to: number },
) => sel.empty && sel.head >= first.from && sel.head <= last.to;

/**
 * The tables, as a state field rather than part of the plugin: a decoration
 * that replaces whole lines changes the height of the document, and CodeMirror
 * only takes those from state, where they are known before layout. Computed
 * over the whole document rather than the viewport — a document has few
 * tables, and the tree is the same one the plugin reads.
 */
function buildTables(state: EditorState): DecorationSet {
  const doc = state.doc;
  const sel = state.selection.main;
  const out: Range<Decoration>[] = [];
  parsedTo(state, doc.length).iterate({
    enter: (node) => {
      if (node.name !== "Table") return;
      const [first, last] = tableLines(node.node, doc);
      if (!cursorIn(sel, first, last)) {
        const g = grid(node.node, doc);
        if (g) {
          const widget = new TableWidget(g, doc.sliceString(first.from, last.to));
          out.push(Decoration.replace({ widget, block: true }).range(first.from, last.to));
        }
      }
      return false;
    },
  });
  return Decoration.set(out, true);
}

const tables = StateField.define<DecorationSet>({
  create: buildTables,
  update(set, tr) {
    if (tr.docChanged || tr.selection || syntaxTree(tr.state) !== syntaxTree(tr.startState))
      return buildTables(tr.state);
    return set;
  },
  provide: (f) => EditorView.decorations.from(f),
});

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
 * Selection-only transactions, because after an edit the cursor is already
 * where the edit put it — and reading the tree of the document a transaction
 * is about to produce means building its state inside a filter, which is the
 * one thing a filter is asked not to do.
 */
const cursorPastMarkup = EditorState.transactionFilter.of((tr) => {
  if (!tr.selection || tr.docChanged) return tr;
  const state = tr.startState;
  const was = state.selection.main.head;
  let moved = false;
  const ranges = tr.selection.ranges.map((r) => {
    if (!r.empty) return r;
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
  return [plugin, tables, cursorPastMarkup, openLinks, copyWhatYouSee];
}
