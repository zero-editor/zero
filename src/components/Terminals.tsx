import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import { api } from "../lib/api";
import { onSettingsChange, resolvedAppearance, useSettings } from "../lib/settings";
import { ptyBus } from "../lib/ptyBus";
import { watchFileDrops } from "../lib/fileDrop";
import { attachSmoothScroll } from "../lib/smoothTermScroll";
import { pathLinkProvider, pathTextAt, resolveOne } from "../lib/termLinks";
import { contextMenuAt, fileEntries } from "../lib/contextMenu";
import { takeBoot, type LayoutTree, type Rect } from "../lib/layout";

/** A clicked link leaves the app entirely — the Rust side vets the scheme */
function openLink(uri: string) {
  api.openUrl(uri).catch((e) => console.warn(`link: ${e}`));
}

/** every live pane's terminal and search addon, keyed the way the tree keys
 *  panes — the find bar lives outside the pane that owns the terminal, and
 *  this is how it reaches in */
const searchers = new Map<string, { term: Terminal; search: SearchAddon }>();

/** #RRGGBB only — the addon parses these itself and takes no alpha */
function findColors() {
  return resolvedAppearance() === "light"
    ? { match: "#ffdf5d", active: "#ff9632" }
    : { match: "#515c6a", active: "#ff9632" };
}

/**
 * The find bar for one terminal pane — ⌘F while the terminal has the keyboard.
 *
 * It searches the pane that was focused when it opened and follows nothing:
 * clicking a different pane closes it (see the effect in Terminals), because
 * a bar that jumps panes steals the focus its input needs from the terminal
 * that was just clicked.
 *
 * `ping` counts ⌘F presses. A press while the bar is already up should hand
 * the keyboard back to the field with the query selected — state that moves
 * on every press is what an effect can watch for that.
 */
function TermFind({ id, ping, onClose }: { id: string; ping: number; onClose: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [hits, setHits] = useState<{ index: number; count: number } | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [id, ping]);

  // separate from the focus effect: this one's cleanup wipes the highlights,
  // which should happen when the bar goes, not on every repeated ⌘F
  useEffect(() => {
    const entry = searchers.get(id);
    const sub = entry?.search.onDidChangeResults((e) =>
      setHits({ index: e.resultIndex, count: e.resultCount })
    );
    return () => {
      sub?.dispose();
      entry?.search.clearDecorations();
      setHits(null);
    };
  }, [id]);

  const find = (dir: "next" | "prev", incremental = false) => {
    const entry = searchers.get(id);
    if (!entry) return;
    const q = inputRef.current?.value ?? "";
    if (!q) {
      entry.search.clearDecorations();
      setHits(null);
      return;
    }
    const c = findColors();
    const decorations = {
      matchBackground: c.match,
      matchOverviewRuler: c.match,
      activeMatchBackground: c.active,
      activeMatchColorOverviewRuler: c.active,
    };
    if (dir === "next") entry.search.findNext(q, { incremental, decorations });
    else entry.search.findPrevious(q, { decorations });
  };

  // buttons hand the keyboard straight back — the bar's whole flow is typed
  const button = (dir: "next" | "prev") => () => {
    find(dir);
    inputRef.current?.focus();
  };

  return (
    <div className="term-find">
      <input
        ref={inputRef}
        className="term-find-input"
        placeholder="find"
        spellCheck={false}
        onInput={() => find("next", true)}
        // every key in here is this field's — the workspace's window handler
        // sits above and would answer ⌘W by closing an editor tab
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") find(e.shiftKey ? "prev" : "next");
          else if (e.key === "Escape") onClose();
          else if (e.metaKey && e.key.toLowerCase() === "f") {
            e.preventDefault();
            e.currentTarget.select();
          }
        }}
      />
      <span className="term-find-count">
        {hits ? (hits.count === 0 ? "0" : hits.index >= 0 ? `${hits.index + 1}/${hits.count}` : `${hits.count}`) : ""}
      </span>
      <button title="previous match (⇧↩)" onClick={button("prev")}>
        ‹
      </button>
      <button title="next match (↩)" onClick={button("next")}>
        ›
      </button>
      <button title="close (⎋)" onClick={onClose}>
        ✕
      </button>
    </div>
  );
}

export function TerminalPanes({
  tree,
  panes,
  active,
  locked,
  draggingId,
  onPaneDragStart,
  onOpenFile,
}: {
  tree: LayoutTree;
  /** every terminal leaf, in an order that never changes with the layout; a
   *  null rect is a hidden pane (⌘J), which keeps its element — and its
   *  shell — alive at display:none. `shift` is the drag preview riding over
   *  the frozen rect — a transform, so the pane slides without ever being
   *  laid out again */
  panes: { id: string; rect: Rect | null; shift?: string }[];
  active: boolean;
  /** the titlebar's layout lock — the grab pill never arms under it */
  locked: boolean;
  /** the pane being carried, for its card's lift and its pill's light */
  draggingId: string | null;
  /** the workspace owns every drag now — a terminal is a peer of the sidebar
   *  and the editor there, and the drop targets span all of them */
  onPaneDragStart: (e: ReactMouseEvent, id: string) => void;
  /** a ⌘-clicked path that belongs to this project */
  onOpenFile: (abs: string, line?: number) => void;
}) {
  // whether the panes wear the shared card or go plain — a live setting,
  // so flipping it in ⌘, restyles every open terminal on the spot
  const { termStyle } = useSettings();
  // The pane toolbar only exists near the top edge of a pane, so working in
  // the middle of a session never puts chrome on screen.
  const [armed, setArmed] = useState<string | null>(null);
  const [grabArmed, setGrabArmed] = useState<string | null>(null);
  // locking while a pill happens to be lit must put it out — the mousemove
  // that armed it computes `grab` as false from then on, but only if it fires
  useEffect(() => {
    if (locked) setGrabArmed(null);
  }, [locked]);

  // ⌘F presses so far, 0 while the bar is closed — a count rather than a
  // flag so a press with the bar already up still reaches it (see TermFind)
  const [finding, setFinding] = useState(0);

  // app-wide rather than per-pane, and started from here because the panes
  // are what it delivers to; calling it again is a no-op
  useEffect(watchFileDrops, []);

  // the bar searches the pane it opened on; a click that moves focus to
  // another pane is a return to that session, so the bar goes with it
  useEffect(() => {
    setFinding(0);
  }, [tree.focusedId]);

  // ⌘F, but only when the keyboard is already the terminal's — the editor's
  // ⌘F is CodeMirror's and never passes through here. Listening on the window
  // rather than the pane because xterm's textarea answers keydowns itself.
  // Membership is asked of the element: the panes are scattered through the
  // workspace now, so there is no one box to test containment against.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.shiftKey || e.altKey || e.ctrlKey) return;
      if (e.key.toLowerCase() !== "f") return;
      if (!(e.target instanceof Element) || !e.target.closest(".term-abs")) return;
      e.preventDefault();
      setFinding((n) => n + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);

  return (
    <>
      {panes.map(({ id, rect, shift }) => (
        <div
          key={id}
          className={`pane-abs term-abs ${termStyle === "plain" ? "plain" : ""} ${
            draggingId === id ? "moving" : ""
          }`}
          data-pane-id={id}
          // how a dropped file finds the pty it was dropped on
          data-term-id={id}
          style={
            rect
              ? {
                  left: `${rect.x}%`,
                  top: `${rect.y}%`,
                  width: `${rect.w}%`,
                  height: `${rect.h}%`,
                  transform: shift,
                }
              : { display: "none" }
          }
          onMouseMove={(e) => {
            if (draggingId) return;
            const r = e.currentTarget.getBoundingClientRect();
            // the top fifth, floored so a short pane still has a strip you
            // can actually aim at
            const zone = Math.max(r.height * 0.2, 28);
            const near = e.clientY - r.top < zone;
            setArmed((cur) => (near ? id : cur === id ? null : cur));
            // the move pill's reach: the top strip of the card, centre only
            // — beside the pane actions, over nothing else. Armed by
            // proximity rather than :hover so that at rest it never takes
            // the pointer from the text under it.
            const grab =
              !locked && e.clientY - r.top < 14 && Math.abs(e.clientX - (r.left + r.width / 2)) < 32;
            setGrabArmed((cur) => (grab ? id : cur === id ? null : cur));
          }}
          onMouseLeave={() => {
            setArmed((cur) => (cur === id ? null : cur));
            setGrabArmed((cur) => (cur === id ? null : cur));
          }}
        >
          <div
            className={`pane-grab ${grabArmed === id ? "armed" : ""} ${
              draggingId === id ? "live" : ""
            }`}
            title="move terminal"
            onMouseDown={(e) => onPaneDragStart(e, id)}
          />
          {finding > 0 && tree.focusedId === id && (
            <TermFind
              id={id}
              ping={finding}
              onClose={() => {
                setFinding(0);
                searchers.get(id)?.term.focus();
              }}
            />
          )}
          {/* same corner as the find bar, so the actions yield while it's up */}
          <div
            className={`pane-actions ${
              armed === id && !(finding > 0 && tree.focusedId === id) ? "visible" : ""
            }`}
          >
            <button title="add terminal left" onClick={() => tree.splitPane(id, "left")}>
              ◧
            </button>
            <button title="add terminal above" onClick={() => tree.splitPane(id, "up")}>
              ⬒
            </button>
            <button title="add terminal below" onClick={() => tree.splitPane(id, "down")}>
              ⬓
            </button>
            <button title="add terminal right" onClick={() => tree.splitPane(id, "right")}>
              ◨
            </button>
            <button className="pane-close" title="close terminal" onClick={() => tree.removePane(id)}>
              ✕
            </button>
          </div>
          <TerminalPane
            id={id}
            cwd={tree.cwd}
            focused={tree.focusedId === id}
            active={active && rect !== null}
            onFocus={tree.setFocused}
            onExit={tree.removePane}
            onOpenFile={onOpenFile}
          />
        </div>
      ))}
    </>
  );
}

/** breathing room around a terminal, before the sub-row remainder is added */

// Dark Modern (VS Code / Cursor) — panel bg + default terminal ANSI palette
const TERM_THEME = {
  background: "#181818",
  foreground: "#cccccc",
  cursor: "#cccccc",
  selectionBackground: "#264f78",
  black: "#000000",
  red: "#cd3131",
  green: "#0dbc79",
  yellow: "#e5e510",
  blue: "#2472c8",
  magenta: "#bc3fbc",
  cyan: "#11a8cd",
  white: "#e5e5e5",
  brightBlack: "#666666",
  brightRed: "#f14c4c",
  brightGreen: "#23d18b",
  brightYellow: "#f5f543",
  brightBlue: "#3b8eea",
  brightMagenta: "#d670d6",
  brightCyan: "#29b8db",
  brightWhite: "#e5e5e5",
};

// the same palette from VS Code's light theme — panel bg to match --bg-panel
const TERM_THEME_LIGHT = {
  background: "#f8f8f8",
  foreground: "#3b3b3b",
  cursor: "#3b3b3b",
  selectionBackground: "#add6ff",
  black: "#000000",
  red: "#cd3131",
  green: "#00bc00",
  yellow: "#949800",
  blue: "#0451a5",
  magenta: "#bc05bc",
  cyan: "#0598bc",
  white: "#555555",
  brightBlack: "#666666",
  brightRed: "#cd3131",
  brightGreen: "#14ce14",
  brightYellow: "#b5ba00",
  brightBlue: "#0451a5",
  brightMagenta: "#bc05bc",
  brightCyan: "#0598bc",
  brightWhite: "#a5a5a5",
};

/* Appearance picks the palette; the background is blanked in all of them.
   Whatever is behind the text — the panel's own card, the window's field when
   the terminal is set plain, or glass — is painted by the panel, so a
   background here would be xterm painting a second pane over the one that
   already carries the tone. The palette keeps its own background value for
   the cases that derive from it (xterm inverts it for the selection and the
   cursor), which is why this blanks the alpha rather than dropping the key.
   Read from the settings store, not the DOM: store listeners fire before
   React has moved the html classes, and the store is never behind. */
function termTheme() {
  const base = resolvedAppearance() === "light" ? TERM_THEME_LIGHT : TERM_THEME;
  return { ...base, background: `${base.background}00` };
}

function TerminalPane({
  id,
  cwd,
  focused,
  active,
  onFocus,
  onExit,
  onOpenFile,
}: {
  id: string;
  cwd: string;
  focused: boolean;
  active: boolean;
  onFocus: (id: string) => void;
  onExit: (id: string) => void;
  onOpenFile: (abs: string, line?: number) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  // the link provider is registered once, for the life of the pane, but the
  // callback it closes over is a fresh function every render
  const onOpenFileRef = useRef(onOpenFile);
  onOpenFileRef.current = onOpenFile;

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;

    const term = new Terminal({
      theme: termTheme(),
      allowTransparency: true,
      fontFamily: '"SF Mono", "Menlo", "Monaco", monospace',
      fontSize: 12.5,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 10000,
      allowProposedApi: true,
      // wheel scrolling is ours now (see attachSmoothScroll) so sensitivity
      // lives there; 0 duration still matters — it keeps the scrollLines calls
      // we make immediate rather than easing towards the target
      smoothScrollDuration: 0,
      // OSC 8 hyperlinks — the escape sequence that carries a URI behind text
      // that reads as something else ("PR #9422"). xterm parses them either
      // way; without a handler they're simply inert, which is why clicking one
      // did nothing.
      linkHandler: {
        activate: (_e, uri) => openLink(uri),
      },
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    const search = new SearchAddon();
    term.loadAddon(search);
    searchers.set(id, { term, search });
    term.open(el);

    // bare URLs and file paths in ordinary output. OSC 8 links are separate —
    // the terminal parses those itself and calls linkHandler above.
    const links = term.registerLinkProvider(
      pathLinkProvider(term, cwd, (abs, line) => onOpenFileRef.current(abs, line))
    );

    // Right-click on one of those paths. The terminal is where most of the
    // filenames in this app come from — Claude prints them by the dozen — and
    // it is the one surface where what was clicked is a run of characters
    // rather than an element, so the hit test is ours to do.
    //
    // Only path-shaped text takes the click: anywhere else the webview's own
    // menu keeps it, which is what still offers Copy over a selection.
    const onMenu = (ev: MouseEvent) => {
      const raw = pathTextAt(term, ev);
      if (!raw) return;
      ev.preventDefault();
      void resolveOne(cwd, raw).then((hit) => {
        if (!hit) return;
        void contextMenuAt([
          // only what's inside the project opens here; ⌘-click follows the
          // same rule, and a file from somewhere else is Finder's
          hit.inside && {
            text: "Open",
            run: () => onOpenFileRef.current(hit.abs),
          },
          "sep",
          ...fileEntries(hit.abs, { root: cwd }),
        ]);
      });
    };
    el.addEventListener("contextmenu", onMenu);

    // DOM renderer on purpose. WebGL: WKWebView drops the contexts (frozen
    // panes, webview crashes). Canvas: the only build that exists is compiled
    // against xterm 5 internals and renders nothing on xterm 6 — tried it,
    // terminal came up blank. CSS-painted cells it is. Note the renderer has
    // nothing to do with scroll smoothness; that's handled below.
    fit.fit();

    // A terminal holds a whole number of rows, so a pane almost never divides
    // evenly and something has to absorb the remainder. Putting it in the
    // padding — above the first row, below the last, or split between them —
    // moves the text as the pane resizes, because the remainder sweeps a whole
    // row while you drag. Every version of that was visible and annoying.
    //
    // So the remainder goes above the first row and the block hangs from the
    // bottom edge instead: `bottom: 0` and an explicit height of exactly the
    // rows it holds, never `top: 0` and a stretch. That difference is the
    // whole thing. Stretched, the block's top edge is the clip's top edge, so
    // the instant the divider drag makes the panel a row taller every line of
    // text rides up with it — a plain layout change, no JS, nothing to be in
    // time for — and then drops back one frame later, when the ResizeObserver
    // finally gets us to term.resize() and the buffer scrolls a row down to
    // fill the new one. Up, then down, once per row crossed, which is the
    // bounce; drag the other way and it is down, then up. Hanging from the
    // bottom, the top edge moves only when the height does, and the height
    // moves only where it is set below.
    //
    // The other half is timing, and it is worth knowing which way round it
    // goes, because the plausible guess is backwards: xterm rewrites the row
    // text *synchronously* inside term.resize() — the buffer scrolls, the row
    // elements are added or removed, and the new text is in the DOM before the
    // call returns. Nothing waits for the next repaint. So the height has to
    // be set in the same breath as the resize, and deferring it to onRender
    // (or to a rAF) buys exactly the bounce it was meant to remove, one frame
    // later and in the other direction. Measured, both ways round, per frame.
    //
    // The gap this leaves at the top is one row at most, and only while a drag
    // is between snap points — the divider snaps to whole rows (see startDrag
    // in Workspace), so at rest it is usually nothing. `floor`, not `ceil`:
    // `ceil` closes the gap but pays for it by slicing the top row where the
    // clip cuts it, and a half-visible first line is worse than an uneven gap,
    // as anyone who has lost the top of a "Restored session" line will tell
    // you. So the sides stay a flat 6px and the top runs to a row more.
    let painted = 0;

    /** a divider is under the mouse — the body class both drag handlers set */
    const dragging = () =>
      document.body.classList.contains("dragging-row") ||
      document.body.classList.contains("dragging-col") ||
      // a carried pane counts too, and so does this pane still gliding into
      // a seat that resized it (the .landing the drop pins on): the program
      // on the other end should hear one SIGWINCH once everything is still,
      // not a redraw per animation frame — and applySize should measure the
      // settled card, never a size caught mid-glide
      document.body.classList.contains("dragging-panel") ||
      el.closest(".pane-abs.landing") !== null;

    /**
     * How many rows the terminal can give up without losing anything.
     *
     * xterm makes room for a shrink by deleting lines *below the cursor*, so
     * what a lost row costs depends entirely on what is down there. A session
     * that hasn't filled the pane yet is all blanks below its last line, and
     * those are free. A session that has is Claude Code's mode and status
     * lines, drawn under an input box that holds the cursor — and under those,
     * one blank row that is just as much part of the layout as the rest of it.
     * Counting the blanks alone tells the two apart, but it hands over that
     * last row: the status line ends up flush against the bottom edge for the
     * length of the drag, a row lower than it sits at rest.
     *
     * So the question isn't how many blanks there are, it's whose they are.
     * Anything written below the cursor means a full-screen program drew the
     * bottom of this pane, and the blank rows under it are its spacing, not
     * our slack. A shell never writes below its cursor, so this costs it
     * nothing.
     */
    const spareRows = () => {
      const buf = term.buffer.active;
      const cursor = buf.baseY + buf.cursorY;
      let n = 0;
      for (let y = buf.baseY + term.rows - 1; y > cursor; y--) {
        if (buf.getLine(y)?.translateToString(true).trim()) return 0;
        n++;
      }
      return n;
    };

    /**
     * xterm's own buffer, which `term.buffer.active` is only a reader for.
     * Undefined if the internals ever move; every caller falls back.
     */
    const coreBuffer = () =>
      (
        term as unknown as {
          _core?: { buffers?: { active?: { y: number; ybase: number; lines: { length: number } } } };
        }
      )._core?.buffers?.active;

    /**
     * term.resize(), except that growing reveals scrollback instead of
     * pushing the screen up.
     *
     * Given a taller viewport xterm fills the new rows one of two ways. It
     * pulls a line back out of scrollback — `ybase--` — which leaves every
     * line already on screen exactly where it was and brings history down into
     * the space that opened above them. Or it pushes a blank line onto the end
     * of the buffer, which slides the whole screen up a row against a block
     * hanging from the bottom edge. It chooses by asking whether anything is
     * written below the cursor (Buffer.resize), and for a shell nothing ever
     * is, so the first is the behaviour anyone has seen. Claude Code parks its
     * cursor in the input box with its status line beneath, so it always gets
     * the second: drag a pane taller and the session climbs with the divider
     * instead of standing still while its own transcript comes back.
     *
     * That condition reads the cursor and nothing else, so the cursor is the
     * one thing to lie about. Put it on the last row for the length of the
     * call and xterm takes the scrollback path — the same path, the same code,
     * that a shell in the same pane would get — then put it back afterwards,
     * moved down by however many lines were really pulled, which is precisely
     * what xterm does to a real cursor on that path. The absolute line the
     * cursor sits on never changes, which is all the program on the other end
     * knows about. Nothing repaints in between either: row text is rendered
     * from the buffer on the next animation frame, and by then the buffer
     * holds the truth again.
     *
     * When the scrollback runs out xterm goes back to pushing blanks by itself
     * and the session does climb — which is the right answer, because at that
     * point there is nothing left above it to reveal.
     *
     * Skipped when the width changes too: a reflow reads the cursor for real,
     * and a vertical drag never changes cols anyway. Skipped on the alternate
     * screen for the plainer reason that it has no scrollback to pull from.
     */
    const resizeTerm = (cols: number, rows: number) => {
      const buf = coreBuffer();
      if (
        !buf ||
        rows <= term.rows ||
        cols !== term.cols ||
        term.buffer.active.type !== "normal" ||
        // nothing below the cursor: xterm already does the right thing
        buf.lines.length <= buf.ybase + buf.y + 1
      ) {
        term.resize(cols, rows);
        return;
      }
      const y = buf.y;
      const base = buf.ybase;
      buf.y = term.rows - 1;
      try {
        term.resize(cols, rows);
      } finally {
        buf.y = Math.min(rows - 1, y + (base - buf.ybase));
      }
    };

    /**
     * The cell box, taken off the renderer instead of measured back out of
     * the DOM.
     *
     * The DOM renderer sets every row element's height to
     * `dimensions.css.cell.height` itself (_refreshRowDimensions), so a
     * getBoundingClientRect on a row returns exactly this number — at the
     * price of a synchronous layout, once per terminal per frame of a drag,
     * interleaved with the writes applySize is making a few lines further
     * down. The width is the other half of what fit.proposeDimensions() spends
     * two getComputedStyle calls to work out. Reading both straight off the
     * render service is a property lookup and cannot force a layout.
     *
     * Undefined if the internals ever move; both callers fall back to
     * measuring, which is only ever what this code did before.
     */
    const cellBox = () =>
      (
        term as unknown as {
          _core?: {
            _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } };
          };
        }
      )._core?._renderService?.dimensions?.css?.cell;

    const cellHeight = () => {
      const h = cellBox()?.height ?? 0;
      if (h > 1) return h;
      const row = el.querySelector<HTMLElement>(".xterm-rows > div");
      return row?.getBoundingClientRect().height ?? 0;
    };

    /**
     * The width the columns don't get: the terminal element's own padding,
     * plus the strip xterm reserves for the overview ruler (14px, its default,
     * and nothing here sets another). Both are constants that only a stylesheet
     * could move, and re-reading them is the *first* of proposeDimensions'
     * two getComputedStyle calls — so this is read once and the settle refit
     * checks the answer (see applySize).
     */
    let reserveW = 0;
    const measureReserve = () => {
      const box = term.element;
      if (!box) return;
      const s = window.getComputedStyle(box);
      const ruler = term.options.scrollback === 0 ? 0 : 14;
      reserveW = (parseFloat(s.paddingLeft) || 0) + (parseFloat(s.paddingRight) || 0) + ruler;
    };
    measureReserve();

    const applyBlock = () => {
      // the cell's own height, never the block's height divided by term.rows:
      // that height is the thing this is about to set, so dividing the old one
      // by the new count is circular and comes out short
      const cell = cellHeight();
      if (!(cell > 1)) return;
      painted = term.rows;
      // `top` has to go: with all three of top, height and bottom set, CSS
      // drops `bottom` and the block is top-anchored again — the very thing
      // this is here to avoid
      el.style.top = "auto";
      el.style.height = `${painted * cell}px`;
    };

    /**
     * `live` is the clip's content box as the ResizeObserver already measured
     * it, and passing it is what keeps a drag frame free of forced layout: the
     * observer's number arrives without asking the DOM anything, where
     * clientWidth here would flush the styles React and applyBlock just wrote.
     * Called without one — the settle refit, a mount — this measures for
     * itself and takes the columns from fit.proposeDimensions(), so whatever
     * the cheap arithmetic below got wrong is corrected the moment the drag
     * ends. Returns whether the terminal actually changed size.
     */
    const applySize = (live?: { w: number; h: number }): boolean => {
      const clip = el.parentElement;
      const cell = cellBox();
      // before the first paint the renderer has no cell to offer. Hand the
      // stretch back for that one case: fit() sizes the terminal from the
      // host, and a host already holding an explicit height would just
      // re-propose the row count it was given and freeze there
      if (!clip || !cell || !(cell.height > 1) || !(cell.width > 0)) {
        el.style.top = "0";
        el.style.height = "auto";
        fit.fit();
        return true;
      }
      // measured against the clip, never the host: the host's own height is
      // what this sets, and reading it back would be that same feedback loop
      const w = live?.w ?? clip.clientWidth;
      const h = live?.h ?? clip.clientHeight;
      const cols = live
        ? Math.max(2, Math.floor((w - reserveW) / cell.width))
        : (fit.proposeDimensions()?.cols ?? term.cols);
      const rows = Math.max(1, Math.floor(h / cell.height));
      // Grow with the drag; shrink only as far as it costs nothing, and leave
      // the rest until the mouse comes up. Losing a row is not the mirror
      // image of gaining one — a new row is filled from scrollback (see
      // resizeTerm, which is what makes that true here), but room for a lost
      // one is made by deleting a line below the cursor (see spareRows) — and
      // the two ends of that behave differently on purpose:
      //
      // - a session with room to spare gives up its blank rows, so the text
      //   stays where it is against the pane's top edge and follows the drag
      //   down, the space underneath closing as it goes;
      // - a session that has run out stops. The block then overhangs the top
      //   of the clip by the rows that no longer fit, which get clipped rather
      //   than deleted, and Claude Code's status lines stay pinned to the
      //   bottom edge where they were.
      //
      // The changeover happens exactly when the content reaches the bottom of
      // the pane, because that is the same moment the blanks run out.
      const held = dragging();
      const next = held && rows < term.rows ? Math.max(rows, term.rows - spareRows()) : rows;
      // Columns don't move while a drag is live, and that is the whole of the
      // difference between a divider that tracks the hand and one that
      // stutters. A column change is a reflow of the entire scrollback —
      // 10,000 lines rewrapped, every line object rebuilt — and a horizontal
      // drag crosses a cell boundary every seven pixels or so, which is dozens
      // of full reflows a second for a text width nobody has settled on yet.
      // So the pane clips instead, exactly as a carried card does: the text
      // holds still, the seam moves, and the one reflow lands when the mouse
      // comes up (notifyPty's applySize, the call with no `live` in it, which
      // is also the one that re-reads the column count properly).
      const wide = held ? term.cols : cols;
      if (term.cols !== wide || term.rows !== next) {
        resizeTerm(wide, next);
        // in the same frame as the text the resize just moved, never after it
        applyBlock();
        return true;
      }
      if (painted !== term.rows) applyBlock();
      return false;
    };

    // only for the resize that lands before the first paint, when there is no
    // row to measure a height against and applyBlock() above did nothing
    const rendered = term.onRender(() => {
      if (painted !== term.rows) applyBlock();
    });

    applySize();
    // once more after the first paint, for the case where the renderer hasn't
    // put any rows in the DOM yet at this point
    const sizeRaf = window.requestAnimationFrame(() => applySize());

    const smooth = attachSmoothScroll(term, { host: el });

    // subscribe before spawning: the shell's first prompt can land before an
    // awaited spawn resolves, and there is no replay
    const decoder = { current: null as null | TextDecoder };
    ptyBus.onOutput(id, (bytes) => term.write(bytes));
    ptyBus.onExit(id, () => onExit(id));

    api.ptySpawn(id, cwd, term.cols || 80, term.rows || 24).then(
      () => {
        // the command this pane was opened to run, if it was opened to run
        // one: typed rather than executed behind the scenes, so it lands in
        // the user's own shell, in front of them, editable and re-runnable
        const boot = takeBoot(id);
        if (!boot) return;
        api.ptyWrite(id, `${boot}\r`).catch(() => {});
      },
      (e) => {
        term.write(`\r\n\x1b[31mzero: failed to start shell: ${e}\x1b[0m\r\n`);
      }
    );
    term.onData((data) =>
      api.ptyWrite(id, data).catch((e) => {
        term.write(`\r\n\x1b[31mzero: shell unreachable: ${e}\x1b[0m\r\n`);
      })
    );

    // macOS editing keys, Cursor-style: ⌥⌫ word-delete, ⌘⌫ kill line,
    // ⌥←/→ word-jump, ⌘←/→ line start/end — translated to readline codes
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown") return true;
      const send = (s: string) => {
        api.ptyWrite(id, s).catch(() => {});
        return false;
      };
      if (ev.metaKey && !ev.altKey && !ev.ctrlKey) {
        if (ev.key === "Backspace") return send("\x15");
        if (ev.key === "ArrowLeft") return send("\x01");
        if (ev.key === "ArrowRight") return send("\x05");
        // ⌘K the way Terminal.app means it: this display clears, the shell is
        // not consulted — so it works mid-program, not just at a prompt. The
        // daemon's copy of the scrollback is untouched; a reattach after a
        // restart brings the history back, which is the lesser surprise.
        if (!ev.shiftKey && ev.key.toLowerCase() === "k") {
          term.clear();
          return false;
        }
      }
      if (ev.altKey && !ev.metaKey && !ev.ctrlKey) {
        if (ev.key === "Backspace") return send("\x1b\x7f");
        if (ev.key === "ArrowLeft") return send("\x1bb");
        if (ev.key === "ArrowRight") return send("\x1bf");
      }
      return true;
    });
    void decoder;

    // Two kinds of drag, two opposite needs. A divider drag really resizes
    // this pane per frame, so it refits visually every frame (debouncing
    // leaves the exposed strip showing the cleared canvas = black flash);
    // only the pty notify is debounced. A panel drag never resizes anything
    // until the drop — the preview is transforms — so any resize that lands
    // while one runs (and the carried card's own landing glide, which eases
    // width for real) skips the refit entirely: the card clips, the text
    // holds still, and one settle refit arrives through notifyPty when
    // everything is down. That single refit is most of what 120fps cost.
    //
    // The pty notify waits for the mouse to come up, not just for 50ms of
    // quiet.
    // Telling the pty is a SIGWINCH, and a full-screen program answers one by
    // redrawing everything it has on screen — for Claude Code that is its
    // whole UI. A drag pauses longer than 50ms between snap points more often
    // than not, so a debounce alone hands it one redraw per row, and every one
    // of them moves the text. Whatever the drag is worth seeing, ten reflows
    // of someone else's layout is not it: the size the shell is told is the
    // size you let go at. The rows on screen are still right the whole way —
    // only the program's idea of them lags, and only until you release.
    let resizeTimer = 0;
    let resizeRaf = 0;
    const notifyPty = () => {
      if (dragging()) {
        resizeTimer = window.setTimeout(notifyPty, 30);
        return;
      }
      // everything held back while the mouse was down, back to back: the
      // scroll offset that now describes the wrong geometry, the refit a
      // panel drag skipped (or the shrink a divider drag held), and the
      // SIGWINCH that tells the program to redraw for it
      smooth.reset();
      applySize();
      if (term.cols > 0 && term.rows > 0) {
        api.ptyResize(id, term.cols, term.rows).catch(() => {});
      }
    };
    // the clip's size as the observer measured it — the one number in this
    // path that costs nothing, since the observer took it before the frame
    // started rather than by asking the DOM in the middle of one
    let live: { w: number; h: number } | null = null;
    const observer = new ResizeObserver((entries) => {
      const box = entries[entries.length - 1]?.contentRect;
      if (box) live = { w: box.width, h: box.height };
      if (resizeRaf) return;
      resizeRaf = window.requestAnimationFrame(() => {
        resizeRaf = 0;
        if (!live || live.w === 0 || live.h === 0) return;
        // a panel in flight: no refit now — notifyPty below re-arms until
        // the drag and the landing are over, then applySize()s once
        if (
          document.body.classList.contains("dragging-panel") ||
          el.closest(".pane-abs.landing") !== null
        ) {
          window.clearTimeout(resizeTimer);
          resizeTimer = window.setTimeout(notifyPty, 50);
          return;
        }
        smooth.reset();
        // only when a row or a column really moved. A drag crosses a whole
        // cell every few frames at most, and the rest of them used to pay for
        // a refresh anyway — with the DOM renderer that is every row element
        // in the pane rebuilt out of the buffer to arrive at the pixels
        // already on screen.
        if (applySize(live) && term.rows > 0) term.refresh(0, term.rows - 1);
        window.clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(notifyPty, 50);
      });
    });
    // watch the clip, not the host: applySize() resizes the host, and observing
    // what you resize is a feedback loop
    observer.observe(el.parentElement ?? el);

    const onFocusIn = () => onFocus(id);
    el.addEventListener("focusin", onFocusIn);
    term.focus();

    // live theme: appearance and glass both arrive as settings-store events
    const unTheme = onSettingsChange(() => {
      term.options.theme = termTheme();
    });

    return () => {
      unTheme();
      el.removeEventListener("contextmenu", onMenu);
      el.removeEventListener("focusin", onFocusIn);
      observer.disconnect();
      window.clearTimeout(resizeTimer);
      window.cancelAnimationFrame(resizeRaf);
      window.cancelAnimationFrame(sizeRaf);
      smooth.dispose();
      rendered.dispose();
      links.dispose();
      ptyBus.off(id);
      api.ptyKill(id).catch(() => {});
      searchers.delete(id);
      termRef.current = null;
      // the search addon goes down with the terminal — no dispose of its own
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, cwd]);

  // switching projects no longer unmounts anything, so the outgoing project's
  // terminal would keep the caret and swallow keystrokes — hand it over
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    if (focused && active) term.focus();
    else if (!active) term.blur();
  }, [focused, active]);

  // three levels on purpose: the pane holds the padding, the clip bounds the
  // sub-row transform, and the host is what xterm opens on
  return (
    <div className={`term-pane ${focused ? "focused" : ""}`}>
      <div className="term-clip">
        <div ref={hostRef} className="term-scroll" />
      </div>
    </div>
  );
}
