import type { CSSProperties, ReactNode } from "react";

/**
 * Enough Markdown to read a memo by, and not one construct more.
 *
 * A memo document is written by one prompt for one purpose: a `# ` title, some
 * paragraphs, some bullets, the occasional bold. So this renders exactly that —
 * three heading levels, both kinds of list with one level of nesting, bold,
 * italic, inline code, blockquotes, rules and paragraphs — and lets everything
 * else fall through as the text it is. A pipeline table stays a line of pipes,
 * a code fence stays three backticks, a link stays `[text](url)`, and none of
 * them is wrong on screen so much as plain.
 *
 * What it deliberately doesn't do is the reason it exists at all: this codebase
 * has no markdown dependency, and adding one to draw six tags would be the
 * largest thing in the app by weight. It also never touches `innerHTML` — every
 * node here is a React element with text children, so the escaping isn't a step
 * that could be forgotten, it's the only thing that can happen.
 *
 * The opt-ins are what keep that default honest rather than merely
 * stubborn. A memo is transcribed speech: a line of pipes there is far likelier
 * to be somebody saying the word than a table nobody spoke, and drawing one
 * would be this file guessing at what a person meant. A Linear issue is typed
 * by a developer into a box that advertises Markdown, so its fences, tables and
 * links are exactly what they look like and rendering them flat is the only
 * wrong answer. Same renderer, two audiences, and the difference between them
 * is three booleans the caller passes rather than a judgement made here. The
 * fourth opt-in, `tasks`, is a note's: `- [ ]` becomes a checkbox that flips
 * the line it came from. With `opts` left off nothing behaves differently than
 * it did before any of them existed, which is the promise the memo half is
 * owed.
 */

export type MdOptions = {
  code?: boolean;
  tables?: boolean;
  links?: boolean;
  /**
   * `- [ ] a` and `- [x] a` drawn as a checkbox rather than as the brackets,
   * and the callback is what makes it a todo list rather than a picture of
   * one: it is handed the zero-based line the item sits on, and the caller
   * flips that line's mark in the source it rendered from. A note is the one
   * caller so far. Without it the brackets stay text, which for a memo is the
   * right answer — "[x]" is a thing people say.
   */
  tasks?: (line: number) => void;
};

/** the memo, and the default: everything below asks `opts.x` and gets nothing */
const PLAIN: MdOptions = {};

/** `**bold**`, `*italic*`, `` `code` `` — split on, so the text between the
 *  matches survives as itself. The double-star alternative comes first, or
 *  `**a**` is read as an italic `*a*` wearing extra stars. */
const INLINE = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;

/** the same three, plus `[text](url)` and a bare url. Written out again rather
 *  than assembled from pieces, so that the flags-off path runs the exact regex
 *  it always ran — "a link in a memo stays `[text](url)`" is a promise about
 *  literal text, and a promise about literal text is the easiest kind to break
 *  by refactoring. The link alternative sits ahead of the bare-url one: at a
 *  `[` only the first can match, so a titled link is one match rather than a
 *  stray bracket standing next to a url. The bare url may not end on sentence
 *  punctuation, which is how "see https://x.com." keeps its full stop out of
 *  the href without any of this needing to know about sentences.
 *
 *  The label is capped at 200 characters, which is a performance bound and not
 *  a taste one: unbounded, every `[` in a line starts a scan to the end of it
 *  looking for a `]`, and a line of nothing but brackets — an unfenced json
 *  array, a paste gone wrong — costs the square of its length. Measured, 20k
 *  brackets took 185ms of the render thread that way and 8ms with the cap. No
 *  real link label is longer, and one that is stays text.
 *
 *  The leading `!` is matched *into* the link alternative on purpose, so that
 *  an image is one part rather than a `!` standing next to a link. Without it
 *  `![alt](url)` renders as a stray exclamation mark followed by a working
 *  anchor — which is worse than the flags-off behaviour it replaced, because
 *  it looks like a link that is merely broken. Linear descriptions carry
 *  pasted screenshots, and their urls are authenticated uploads an `<img>`
 *  could not load anyway, so an image stays the literal text it always was. */
const INLINE_LINKED =
  /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|!?\[[^\]\n]{0,200}\]\([^()\s]*\)|https?:\/\/[^\s<>()[\]"']*[^\s<>()[\]"'.,;:!?])/g;

const HEADING = /^(#{1,3})\s+(.*)$/;
const RULE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;
const BULLET = /^(\s*)[-*]\s+(.*)$/;
const NUMBER = /^(\s*)\d+[.)]\s+(.*)$/;
/** the front of an item's text: `[ ] ` or `[x] `, the text optional so that a
 *  task just started — the marker typed, nothing after it yet — is still one */
const TASK = /^\[([ xX])\](?:\s+(.*))?$/;

const MD_LINK = /^\[([^\]\n]*)\]\(([^()\s]*)\)$/;
const BARE_URL = /^https?:\/\//i;

/** The whole allowlist, and the one place in this file where being wrong is a
 *  security bug rather than an ugly line. So it is a positive match on the
 *  three schemes that are safe to hand an `href`, not a list of the bad ones —
 *  a blocklist has to think of `javascript:`, and of `data:`, and of whatever
 *  the next one turns out to be, and it only has to forget once. Anything else
 *  isn't a broken link; it isn't a link, and renders as the text it was. */
const SAFE = /^(?:https?:\/\/|mailto:)/i;

const FENCE = /^\s*(`{3,}|~{3,})\s*(\S*)/;
const DELIM = /^:?-+:?$/;

function inline(text: string, opts: MdOptions = PLAIN): ReactNode[] {
  return text
    .split(opts.links ? INLINE_LINKED : INLINE)
    .filter(Boolean)
    .map((part, i) => {
      if (part.length > 4 && part.startsWith("**") && part.endsWith("**"))
        return <strong key={i}>{part.slice(2, -2)}</strong>;
      if (part.length > 2 && part.startsWith("`") && part.endsWith("`"))
        return <code key={i}>{part.slice(1, -1)}</code>;
      if (part.length > 2 && part.startsWith("*") && part.endsWith("*"))
        return <em key={i}>{part.slice(1, -1)}</em>;
      if (opts.links) {
        // an image: matched here only so that it arrives whole, and then left
        // exactly as it was written — see the note above INLINE_LINKED
        if (part.startsWith("![")) return part;
        const link = MD_LINK.exec(part);
        if (link) {
          if (!SAFE.test(link[2])) return part;
          // the label is parsed with links switched back off: its own text can
          // hold a bare url, and an `<a>` inside an `<a>` is not a thing
          return (
            <a key={i} href={link[2]}>
              {inline(link[1], { ...opts, links: false })}
            </a>
          );
        }
        if (BARE_URL.test(part))
          return (
            <a key={i} href={part}>
              {part}
            </a>
          );
      }
      return part;
    });
}

/** `- a`, `* a`, `1. a` — how deep it is, which kind it is, and what it says.
 *  Two spaces is a nesting level; the exact number people type varies and the
 *  distinction between two and four isn't one a memo ever means. */
function item(line: string) {
  const bullet = BULLET.exec(line);
  const m = bullet ?? NUMBER.exec(line);
  if (!m) return null;
  return { deep: m[1].length >= 2, ordered: !bullet, text: m[2] };
}

/** `| a | b |` → `["a", "b"]`. The outer pipes are optional in the format and
 *  shed here either way, and a `\|` is a pipe someone wanted inside a cell
 *  rather than a boundary between two.
 *
 *  Walked a character at a time instead of split on a lookbehind, which is what
 *  this wanted to be: esbuild can't lower `(?<!\\)` into anything older, so it
 *  rewrites the literal as a `new RegExp` — one built afresh on every cell of
 *  every row, and still a runtime throw on any engine that lacks the feature.
 *  A loop is cheaper than that and can't be lowered into a surprise. */
function cells(line: string): string[] {
  const body = line.trim();
  const out: string[] = [];
  let cell = "";
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "\\" && body[i + 1] === "|") {
      cell += "|";
      i++;
    } else if (body[i] === "|") {
      out.push(cell);
      cell = "";
    } else cell += body[i];
  }
  out.push(cell);
  // the pipes on the ends are optional, so drop the empty cells they leave —
  // and only those, or a row that genuinely ends in an empty cell loses it
  if (out.length > 1 && body.startsWith("|") && !out[0].trim()) out.shift();
  if (out.length > 1 && body.endsWith("|") && !out[out.length - 1].trim()) out.pop();
  return out.map((c) => c.trim());
}

/** Header and delimiter, or nothing. The delimiter row is the whole test: it is
 *  what separates a table from a paragraph that happens to mention pipes, and
 *  it has to have a cell for every header cell — that count is the format's own
 *  rule, and keeping it is what lets prose full of pipes stay prose. */
function header(lines: string[], i: number): [string[], string[]] | null {
  if (i + 1 >= lines.length || !lines[i].includes("|")) return null;
  const head = cells(lines[i]);
  const rule = cells(lines[i + 1]);
  if (rule.length !== head.length || !rule.every((cell) => DELIM.test(cell)))
    return null;
  return [head, rule];
}

/** Whether line `i` starts a block of its own, which is the question a running
 *  paragraph asks about every line it is about to swallow. The two opt-in
 *  blocks have to be in here as well as in the loop below, or a fence one line
 *  under a sentence is read as more sentence. */
function opens(lines: string[], i: number, opts: MdOptions) {
  const line = lines[i];
  return (
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    item(line) !== null ||
    (!!opts.code && FENCE.test(line)) ||
    (!!opts.tables && header(lines, i) !== null)
  );
}

/** One list, from `from` to wherever it stops, and the line it stopped on.
 *  Indented items belong to the item above them; a second level of indent is
 *  folded into the first, because a memo that needs three is a document. */
function list(
  lines: string[],
  from: number,
  key: number,
  opts: MdOptions,
): [ReactNode, number] {
  const top = item(lines[from])!;
  // each row remembers its line: a task that is ticked has to say which line
  // of the source to change, and the text alone could name two
  const rows: (Item & { kids: Item[] })[] = [];
  let i = from;
  while (i < lines.length) {
    const it = item(lines[i]);
    if (!it) break;
    if (it.deep && rows.length) rows[rows.length - 1].kids.push({ text: it.text, line: i });
    // the other kind of list starting at this level is a new list, not a row
    else if (it.ordered !== top.ordered) break;
    else rows.push({ text: it.text, line: i, kids: [] });
    i++;
  }
  const Tag = top.ordered ? "ol" : "ul";
  return [
    <Tag key={key}>
      {rows.map((row, n) => (
        <li key={n} {...taskAttrs(row, opts)}>
          {taskBody(row, opts)}
          {/* a nested list is drawn as a list; which kind it was is a
              distinction one level down doesn't earn */}
          {row.kids.length > 0 && (
            <ul>
              {row.kids.map((kid, j) => (
                <li key={j} {...taskAttrs(kid, opts)}>
                  {taskBody(kid, opts)}
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </Tag>,
    i,
  ];
}

type Item = { text: string; line: number };

/** `- [x] a` → done, and the text after the mark; anything else → null. Only
 *  ever asked with tasks switched on, so the flags-off path never sees it. */
function task(it: Item, opts: MdOptions) {
  if (!opts.tasks) return null;
  const m = TASK.exec(it.text);
  return m ? { done: m[1] !== " ", text: m[2] ?? "" } : null;
}

/** the class goes on the `<li>` so the stylesheet can take the bullet away —
 *  a checkbox with a dot in front of it is two markers for one item */
function taskAttrs(it: Item, opts: MdOptions) {
  const t = task(it, opts);
  return t ? { className: t.done ? "md-task md-done" : "md-task" } : {};
}

/** The checkbox is real — it is a todo list, not a drawing of one. Toggling it
 *  tells the caller which line to flip; the caller re-renders from the changed
 *  source, so `checked` is never state this file keeps. The label is the
 *  click target too, since a 13px box is a mean thing to have to hit. */
function taskBody(it: Item, opts: MdOptions): ReactNode {
  const t = task(it, opts);
  if (!t) return inline(it.text, opts);
  return (
    <label>
      <input type="checkbox" checked={t.done} onChange={() => opts.tasks!(it.line)} />
      <span>{inline(t.text, opts)}</span>
    </label>
  );
}

/** One fenced block, taken verbatim. Nothing inside is markdown — that is the
 *  entire point of having asked for a fence — so the lines go in as they are,
 *  blanks included, and the info string becomes `data-lang` on the `<pre>` for
 *  whatever the stylesheet wants to do with the name of a language. A fence
 *  nobody closed runs to the end of the document rather than being dropped:
 *  half a code block on screen beats a paragraph that silently vanished. */
function fence(lines: string[], from: number, key: number): [ReactNode, number] {
  const open = FENCE.exec(lines[from])!;
  // it closes on its own mark, at least as long as it opened and alone on the
  // line — so a run of backticks inside a tilde fence is content, not an end
  const closed = new RegExp(`^\\s*[${open[1][0]}]{${open[1].length},}\\s*$`);
  const body: string[] = [];
  let i = from + 1;
  while (i < lines.length && !closed.test(lines[i])) {
    body.push(lines[i]);
    i++;
  }
  return [
    <pre className="md-code" data-lang={open[2] || undefined} key={key}>
      <code>{body.join("\n")}</code>
    </pre>,
    Math.min(i + 1, lines.length),
  ];
}

/** One pipe table. The delimiter row is read twice — once by `header` to decide
 *  this is a table at all, and once here for the alignments it also carries. */
function table(
  lines: string[],
  from: number,
  key: number,
  opts: MdOptions,
): [ReactNode, number] {
  const [head, rule] = header(lines, from)!;
  const align: CSSProperties["textAlign"][] = rule.map((cell) =>
    cell.startsWith(":") && cell.endsWith(":")
      ? "center"
      : cell.endsWith(":")
        ? "right"
        : cell.startsWith(":")
          ? "left"
          : undefined,
  );
  const at = (n: number) => (align[n] ? { textAlign: align[n] } : undefined);

  const rows: string[][] = [];
  let i = from + 2;
  while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
    const row = cells(lines[i]);
    // a hand-written table is ragged more often than not, and a missing cell is
    // not worth refusing to draw the table over: short rows gain empty cells,
    // long ones lose the ones the header has no column for
    rows.push(head.map((_, n) => row[n] ?? ""));
    i++;
  }

  return [
    <table className="md-table" key={key}>
      <thead>
        <tr>
          {head.map((cell, n) => (
            <th key={n} style={at(n)}>
              {inline(cell, opts)}
            </th>
          ))}
        </tr>
      </thead>
      {rows.length > 0 && (
        <tbody>
          {rows.map((row, r) => (
            <tr key={r}>
              {row.map((cell, n) => (
                <td key={n} style={at(n)}>
                  {inline(cell, opts)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      )}
    </table>,
    i,
  ];
}

/** The blocks of one document, ready to drop into a container. */
export function miniMarkdown(text: string, opts: MdOptions = PLAIN): ReactNode[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    // the two opt-ins go first because both are recognised by a line the rest
    // of this loop would otherwise read as prose
    if (opts.code && FENCE.test(line)) {
      const [node, next] = fence(lines, i, out.length);
      out.push(node);
      i = next;
      continue;
    }
    if (opts.tables && header(lines, i)) {
      const [node, next] = table(lines, i, out.length, opts);
      out.push(node);
      i = next;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const Tag = (["h1", "h2", "h3"] as const)[heading[1].length - 1];
      out.push(<Tag key={out.length}>{inline(heading[2].trim(), opts)}</Tag>);
      i++;
    } else if (RULE.test(line)) {
      out.push(<hr key={out.length} />);
      i++;
    } else if (QUOTE.test(line)) {
      const said: string[] = [];
      while (i < lines.length) {
        const quoted = QUOTE.exec(lines[i]);
        if (!quoted) break;
        said.push(quoted[1]);
        i++;
      }
      out.push(
        <blockquote key={out.length}>{inline(said.join(" "), opts)}</blockquote>,
      );
    } else if (item(line)) {
      const [node, next] = list(lines, i, out.length, opts);
      out.push(node);
      i = next;
    } else {
      // a paragraph runs to the next blank line, or to the next line that is
      // the start of something — which is what makes an unfenced anything
      // degrade into readable prose rather than swallow the rest of the memo
      const para: string[] = [];
      while (i < lines.length && lines[i].trim() && !opens(lines, i, opts)) {
        para.push(lines[i].trim());
        i++;
      }
      out.push(<p key={out.length}>{inline(para.join(" "), opts)}</p>);
    }
  }
  return out;
}
