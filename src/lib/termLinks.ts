import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import { api } from "./api";

/**
 * Links that aren't declared as links: bare URLs, file paths, and the short
 * references — `#732`, `ECL-260` — sitting in ordinary output. (OSC 8
 * hyperlinks are a different mechanism — the terminal parses those itself and
 * hands them to `linkHandler`.)
 *
 * Paths are confirmed against the disk before they light up. Any heuristic
 * loose enough to catch `src/lib/api.ts` also catches `e.g.` and `v1.2`, so
 * matching is only a first pass — existing is what makes it a link.
 */

/** trailing punctuation belongs to the sentence, not the URL */
const TRAILING = /[.,;:!?)\]}'"]+$/;

const URL_RE = /\bhttps?:\/\/[^\s"'`<>]+/g;

/**
 * Something path-shaped, with an optional `:line` or `:line:col` suffix. Needs
 * either a slash or a dotted extension, which is what keeps ordinary prose out
 * — everything surviving that still has to exist on disk.
 */
const PATH_RE = /(?:~|\.{1,2})?[\w@.\-+/]*[/\\][\w@.\-+]+(?::\d+(?::\d+)?)?|\b[\w@\-+]+\.[A-Za-z][\w]{0,9}(?::\d+(?::\d+)?)?/g;

interface Span {
  text: string;
  start: number;
  end: number;
}

/** a line of the buffer flattened to a string, with each character's column */
interface Flat {
  text: string;
  /** xs[i] / ys[i] are the 0-based cell coordinates of text[i] */
  xs: number[];
  ys: number[];
}

/**
 * Read the whole wrapped run containing `y`, cell by cell.
 *
 * Deliberately not `translateToString`: a double-width character occupies two
 * columns but contributes one character to that string, so string offsets stop
 * agreeing with columns the moment any CJK or emoji appears earlier on the line
 * — and Claude's output is full of both. Walking cells keeps the mapping exact.
 */
function flatten(term: Terminal, y: number): Flat {
  const buf = term.buffer.active;
  let start = y;
  while (start > 0 && buf.getLine(start)?.isWrapped) start--;
  let end = y;
  while (end + 1 < buf.length && buf.getLine(end + 1)?.isWrapped) end++;

  const text: string[] = [];
  const xs: number[] = [];
  const ys: number[] = [];
  for (let row = start; row <= end; row++) {
    const line = buf.getLine(row);
    if (!line) continue;
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x);
      if (!cell) continue;
      // the second half of a double-width character: no character of its own
      if (cell.getWidth() === 0) continue;
      const chars = cell.getChars() || " ";
      for (const ch of chars) {
        text.push(ch);
        xs.push(x);
        ys.push(row);
      }
    }
  }
  return { text: text.join(""), xs, ys };
}

function findAll(text: string, re: RegExp): Span[] {
  const out: Span[] = [];
  re.lastIndex = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    let value = m[0];
    const trimmed = value.replace(TRAILING, "");
    // a run of pure punctuation isn't a candidate
    if (!trimmed) continue;
    value = trimmed;
    out.push({ text: value, start: m.index, end: m.index + value.length });
  }
  return out;
}

/** 1-based range, as xterm counts them */
function rangeOf(flat: Flat, span: Span) {
  const last = span.end - 1;
  return {
    start: { x: flat.xs[span.start] + 1, y: flat.ys[span.start] + 1 },
    end: { x: flat.xs[last] + 1, y: flat.ys[last] + 1 },
  };
}

/** `path:12:5` — the suffix is a destination, not part of the name */
function splitLineNumber(raw: string): { path: string; line?: number } {
  const m = /^(.*?):(\d+)(?::\d+)?$/.exec(raw);
  return m ? { path: m[1], line: parseInt(m[2], 10) } : { path: raw };
}

export interface ResolvedPath {
  raw: string;
  abs: string;
  /** under the project root, so it can open here instead of in Finder */
  inside: boolean;
}

/**
 * Hovering re-asks for the same line constantly and resolution is a filesystem
 * round trip, so the answers are remembered — but only for a while.
 *
 * The miss is the answer that goes stale, and it goes stale on exactly the
 * paths that matter. Claude names a file before it exists: `⏺ Write(~/…)` is on
 * screen while the write is still happening, and the sentence pointing at a
 * script is often printed a moment before the script lands. A miss kept forever
 * leaves that path dead for the life of the window — and dead in a way that
 * reads as a matching bug rather than a caching one, because the *same file*
 * named a different way still lights up, its spelling never having been asked
 * about too early.
 *
 * Hits expire too, more slowly: a file deleted since should stop underlining
 * eventually, and being wrong for a minute costs a Finder reveal of the folder
 * it was in.
 */
const MISS_MS = 4_000;
const HIT_MS = 60_000;
/** hovering prose invents keys endlessly, so there is a ceiling */
const CACHE_MAX = 4_000;

interface Cached {
  at: number;
  value: ResolvedPath | null;
}

const resolved = new Map<string, Cached>();

const ttl = (c: Cached) => (c.value ? HIT_MS : MISS_MS);

function recall(key: string): Cached | undefined {
  const hit = resolved.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at < ttl(hit)) return hit;
  resolved.delete(key);
  return undefined;
}

function remember(key: string, value: ResolvedPath | null): void {
  if (resolved.size >= CACHE_MAX) {
    const now = Date.now();
    for (const [k, c] of resolved) if (now - c.at >= ttl(c)) resolved.delete(k);
    // all of it still fresh: this is a cache, and dropping it costs a stat
    if (resolved.size >= CACHE_MAX) resolved.clear();
  }
  resolved.set(key, { at: Date.now(), value });
}

async function resolve(cwd: string, raws: string[]): Promise<Map<string, ResolvedPath>> {
  const found = new Map<string, ResolvedPath>();
  const ask: string[] = [];
  for (const raw of raws) {
    const hit = recall(`${cwd}\0${raw}`);
    if (!hit) ask.push(raw);
    else if (hit.value) found.set(raw, hit.value);
  }
  if (ask.length) {
    const rows = await api.resolvePaths(cwd, ask).catch(() => [] as ResolvedPath[]);
    for (const row of rows) found.set(row.raw, row);
    for (const raw of ask) remember(`${cwd}\0${raw}`, found.get(raw) ?? null);
  }
  return found;
}

/**
 * The path-shaped run of text under the pointer, with any `:line:col` stripped
 * — the same candidates the link provider lights up, found the same way.
 *
 * Synchronous, and that is the point: a right-click has to be taken away from
 * the webview's own menu in the handler itself, before anything can wait for
 * the disk. So this answers "is the pointer on something path-shaped", which is
 * cheap and enough to decide with, and `resolveOne` below answers "and is it
 * really there" afterwards. Text that only looked like a path costs a
 * suppressed menu and nothing else.
 *
 * The cell under the pointer is worked out from the screen element rather than
 * from font metrics: it is exactly `cols × rows` on screen, whatever transform
 * the pane has put on it, so a ratio of its box is the cell either way.
 */
export function pathTextAt(term: Terminal, e: MouseEvent): string | null {
  const screen = term.element?.querySelector<HTMLElement>(".xterm-screen");
  if (!screen) return null;
  const box = screen.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) return null;

  const col = Math.floor(((e.clientX - box.left) / box.width) * term.cols);
  const row = Math.floor(((e.clientY - box.top) / box.height) * term.rows);
  if (col < 0 || row < 0 || col >= term.cols || row >= term.rows) return null;
  const y = term.buffer.active.viewportY + row;

  const flat = flatten(term, y);
  if (!flat.text.trim()) return null;
  // the flattened run spans several buffer lines, so the cell is a (row, col)
  // pair rather than an offset
  const at = flat.ys.findIndex((yy, i) => yy === y && flat.xs[i] === col);
  if (at < 0) return null;

  const urls = findAll(flat.text, URL_RE);
  const inUrl = (s: Span) => urls.some((u) => s.start < u.end && u.start < s.end);
  const span = findAll(flat.text, PATH_RE).find(
    (s) => at >= s.start && at < s.end && !inUrl(s)
  );
  return span ? splitLineNumber(span.text).path : null;
}

/** Whether that candidate is a file, and where. Shares the link provider's
 *  cache, so hovering the line — which is how the pointer got there — has
 *  usually already paid for this. */
export async function resolveOne(cwd: string, raw: string): Promise<ResolvedPath | null> {
  return (await resolve(cwd, [raw])).get(raw) ?? null;
}

// ─── short references ────────────────────────────────────────────────────────

/** Mirrors src-tauri/src/links.rs. */
export interface ProjectLinks {
  /** `https://github.com/owner/repo`, or null when origin isn't GitHub */
  repo: string | null;
  /** the connected Linear workspace; null when the project has none */
  linear: { urlKey: string; teams: string[] } | null;
}

/**
 * `PR #732`, `#732`, `ECL-260` — the way agents and status lines name things.
 *
 * They arrive as text. Claude Code strips OSC 8 hyperlinks from its status
 * line (measured: the sequence goes in, a bare label comes out), so a label
 * is a link only if the terminal already knows where labels like it lead —
 * the project's GitHub remote for numbers, its Linear workspace for keys. A
 * number is never a link in a project with no GitHub remote, and a key only
 * when it names a team the workspace actually has, so `UTF-8` stays prose.
 */
const REF_TTL_MS = 10 * 60_000;
const projectLinks = new Map<string, { at: number; value: Promise<ProjectLinks> }>();
const NO_LINKS: ProjectLinks = { repo: null, linear: null };

function linksFor(cwd: string): Promise<ProjectLinks> {
  const hit = projectLinks.get(cwd);
  if (hit && Date.now() - hit.at < REF_TTL_MS) return hit.value;
  const value = api.projectLinks(cwd).catch(() => NO_LINKS);
  projectLinks.set(cwd, { at: Date.now(), value });
  return value;
}

/** a Linear key: the team's letters, a dash, the number */
const ISSUE_RE = /\b([A-Z][A-Z0-9]{1,9})-(\d{1,6})\b/g;

/**
 * A pull request or issue number. `PR #732`, `PR 732`, `pull request 732`,
 * `issue #9`, a bare `#732` not glued to a word (so `C#12` and `&#39;` stay
 * out), or `owner/repo#732` for one in another repository.
 */
const NUMBER_RE =
  /\b(?:PR|pull request|pull|issue)\s?#?(\d{1,7})\b|(?<![\w#&/.:])#(\d{1,7})\b|\b([\w.-]+\/[\w.-]+)#(\d{1,7})\b/g;

interface Ref {
  span: Span;
  url: string;
}

function findRefs(text: string, links: ProjectLinks): Ref[] {
  const refs: Ref[] = [];
  if (links.linear) {
    const { urlKey, teams } = links.linear;
    for (const m of text.matchAll(ISSUE_RE)) {
      if (!teams.includes(m[1])) continue;
      refs.push({
        span: { text: m[0], start: m.index, end: m.index + m[0].length },
        url: `https://linear.app/${urlKey}/issue/${m[1]}-${m[2]}`,
      });
    }
  }
  if (links.repo) {
    for (const m of text.matchAll(NUMBER_RE)) {
      const n = m[1] ?? m[2] ?? m[4];
      // `/pull/N` is also how GitHub reaches an issue: it redirects
      const repo = m[3] ? `https://github.com/${m[3]}` : links.repo;
      refs.push({
        span: { text: m[0], start: m.index, end: m.index + m[0].length },
        url: `${repo}/pull/${n}`,
      });
    }
  }
  return refs;
}

// ─── the hover ───────────────────────────────────────────────────────────────

/**
 * Where a link goes, shown while the pointer is on it — a terminal has no
 * status bar, and a label like `PR #732` says nothing about which repository.
 * The `xterm-hover` class is xterm's own: mouse events over the element don't
 * fall through and re-trigger the link under it. It sits above the pointer so
 * it never ends up under it.
 */
export function showLinkTip(term: Terminal, e: MouseEvent, url: string): void {
  const host = term.element;
  if (!host) return;
  hideLinkTip(term);
  const tip = document.createElement("div");
  tip.className = "term-link-tip xterm-hover";
  tip.textContent = url;
  const box = host.getBoundingClientRect();
  tip.style.left = `${Math.max(0, e.clientX - box.left)}px`;
  tip.style.top = `${e.clientY - box.top}px`;
  host.appendChild(tip);
  // keep it inside the pane when the link sits at the right edge
  const over = tip.getBoundingClientRect().right - box.right;
  if (over > 0) tip.style.left = `${Math.max(0, e.clientX - box.left - over - 4)}px`;
}

export function hideLinkTip(term: Terminal): void {
  term.element?.querySelectorAll(".term-link-tip").forEach((el) => el.remove());
}

/** the decorations and hover every link here shares */
function linkChrome(term: Terminal, url: string): Pick<ILink, "decorations" | "hover" | "leave"> {
  return {
    decorations: { pointerCursor: true, underline: true },
    hover: (e) => showLinkTip(term, e, url),
    leave: () => hideLinkTip(term),
  };
}

/**
 * @param cwd    the project root — where relative paths are resolved from
 * @param onFile a file inside the project: open it here rather than leaving
 */
export function pathLinkProvider(
  term: Terminal,
  cwd: string,
  onFile: (abs: string, line?: number) => void
): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      const flat = flatten(term, bufferLineNumber - 1);
      if (!flat.text.trim()) return callback(undefined);

      const urls = findAll(flat.text, URL_RE);
      const open = (url: string) => api.openUrl(url).catch((err) => console.warn(`link: ${err}`));
      const links: ILink[] = urls.map((span) => ({
        range: rangeOf(flat, span),
        text: span.text,
        ...linkChrome(term, span.text),
        activate: (e, uri) => {
          if (e.metaKey) open(uri);
        },
      }));

      // a path candidate inside a URL is part of the URL
      const covered = (s: Span) => urls.some((u) => s.start < u.end && u.start < s.end);
      const candidates = findAll(flat.text, PATH_RE).filter((s) => !covered(s));

      const byRaw = new Map(candidates.map((s) => [splitLineNumber(s.text).path, s]));
      const paths = byRaw.size ? resolve(cwd, [...byRaw.keys()]) : Promise.resolve(new Map());
      Promise.all([paths, linksFor(cwd)])
        .then(([hits, project]) => {
          for (const [raw, span] of byRaw) {
            const hit = hits.get(raw);
            if (!hit) continue;
            const { line } = splitLineNumber(span.text);
            links.push({
              range: rangeOf(flat, span),
              text: span.text,
              ...linkChrome(term, hit.abs),
              activate: (e) => {
                if (!e.metaKey) return;
                if (hit.inside) onFile(hit.abs, line);
                else api.revealPath(hit.abs).catch((err) => console.warn(`reveal: ${err}`));
              },
            });
          }
          for (const ref of findRefs(flat.text, project)) {
            if (covered(ref.span)) continue;
            links.push({
              range: rangeOf(flat, ref.span),
              text: ref.span.text,
              ...linkChrome(term, ref.url),
              activate: (e) => {
                if (e.metaKey) open(ref.url);
              },
            });
          }
          callback(links.length ? links : undefined);
        })
        .catch(() => callback(links.length ? links : undefined));
    },
  };
}
