import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorState, Extension, Range, StateField, Text } from "@codemirror/state";
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
 * The rule that makes it editable: **the line the cursor is on shows its
 * markup.** Everything hidden comes back the moment you move onto it, so a
 * heading is still `# heading` when you want to change the `#`, and a hidden
 * `**` never has to be found by feel. Tasks are the one exception — the box
 * stays a box, and the dash in front of it stays gone, until the cursor is
 * actually inside the `- [ ]`, because ticking the item you are typing next
 * to is what people do and a dash beside a checkbox is two markers.
 *
 * A *selection* reveals nothing. Selecting is the first half of copying, and
 * what a copy gives you is the text you can see — the hidden marks are left
 * out of the clipboard, and so are the fence lines around a code block, so a
 * command copied out of a note is the command and not three backticks with a
 * command inside. Revealing the marks while you select would make the words
 * move under the drag and would put the marks back into the copy.
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
const link = (href: string) => Decoration.mark({ class: "nl-link", attributes: { "data-href": href } });

const HEADING = /^ATXHeading([1-6])$/;
const TASK = /^\[[ xX]\]$/;

function build(view: EditorView): DecorationSet {
  const { state } = view;
  const doc = state.doc;
  const sel = state.selection.main;
  const cursorLine = sel.empty ? doc.lineAt(sel.head) : null;
  /** whether the line holding `pos` is the one the cursor is on — a cursor,
   *  not a selection: see the note above about copying */
  const onCursorLine = (pos: number) =>
    cursorLine !== null && pos >= cursorLine.from && pos <= cursorLine.to;
  /** a mark and, when one follows it, the single space that separates it
   *  from what it marks — hiding `#` and leaving its space indents the line */
  const withSpace = (to: number) => (doc.sliceString(to, to + 1) === " " ? to + 1 : to);

  const out: Range<Decoration>[] = [];
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
            if (!active) out.push(hide.range(node.from, withSpace(node.to)));
            return;
          case "EmphasisMark":
          case "StrikethroughMark":
            if (!active) out.push(hide.range(node.from, node.to));
            return;
          case "InlineCode":
            out.push(codeMark.range(node.from, node.to));
            return;
          case "CodeMark": {
            const parent = node.node.parent?.name;
            if (parent === "InlineCode") {
              if (!active) out.push(hide.range(node.from, node.to));
            } else out.push((active ? fenceMark : hideFence).range(node.from, node.to));
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
            if (!active) out.push(hide.range(node.from, withSpace(node.to)));
            return;
          case "HorizontalRule":
            if (!active) out.push(rule.range(node.from, node.to));
            return;
          case "ListMark": {
            const item = node.node.parent;
            const task = node.node.nextSibling;
            if (task?.name === "Task") {
              // the checkbox is the marker and the dash would be a second one,
              // so it follows the checkbox's rule rather than the line's: gone
              // until the selection is inside the `- [ ]` itself
              const marker = task.getChild("TaskMarker");
              const end = marker?.to ?? node.to;
              const inside = sel.empty && sel.head >= node.from && sel.head <= end;
              if (!inside) out.push(hideDash.range(node.from, withSpace(node.to)));
            } else if (item?.parent?.name === "BulletList" && !active) {
              out.push(bullet.range(node.from, node.to));
            }
            return;
          }
          case "TaskMarker": {
            const mark = doc.sliceString(node.from, node.to);
            if (!TASK.test(mark)) return;
            const done = mark[1] !== " ";
            out.push(line(done ? "nl-task nl-done" : "nl-task").range(doc.lineAt(node.from).from));
            // a box until the cursor is inside the brackets themselves
            const inside = sel.empty && sel.head >= node.from && sel.head <= node.to;
            if (!inside) out.push((done ? checked : unchecked).range(node.from, node.to));
            return;
          }
          case "Link": {
            const url = node.node.getChild("URL");
            if (url) out.push(link(doc.sliceString(url.from, url.to)).range(node.from, node.to));
            return;
          }
          case "LinkMark":
          case "LinkTitle":
            if (!active) out.push(hide.range(node.from, node.to));
            return;
          case "URL":
            if (node.node.parent?.name === "Link") {
              if (!active) out.push(hide.range(node.from, node.to));
            } else {
              // a bare url: its own text is the link
              out.push(link(doc.sliceString(node.from, node.to)).range(node.from, node.to));
            }
            return;
        }
      },
    });
  }
  return Decoration.set(out, true);
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
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(u: ViewUpdate) {
      if (
        u.docChanged ||
        u.selectionSet ||
        u.viewportChanged ||
        syntaxTree(u.state) !== syntaxTree(u.startState)
      )
        this.decorations = build(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

/** ⌘-click on a link opens it in the browser; a plain click puts the cursor
 *  in it, because this is still an editor and the text is still editable */
const openLinks = EditorView.domEventHandlers({
  mousedown(event) {
    if (!event.metaKey || event.button !== 0) return false;
    const a = (event.target as HTMLElement).closest?.(".nl-link");
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
  return [plugin, tables, openLinks, copyWhatYouSee];
}
