import { EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { Extension, Text } from "@codemirror/state";
import { getChunks } from "@codemirror/merge";

/**
 * The lane down the right edge of an editor that maps the whole file: the
 * gutter tells you about the screen, this tells you about the document. Click
 * or drag anywhere in it and the editor scrolls there — the affordance Cursor
 * and VS Code both put in this strip, and the reason it's worth having is that
 * a change you can *see* in the ruler is otherwise still a scroll hunt away.
 *
 * The lane sits just left of the scrollbar rather than over it, so dragging
 * the thumb still works and the two do different jobs: the thumb moves you by
 * where you are, this moves you by what's in the file.
 */

export type TickKind = "add" | "mod" | "del";

/** A run of changed lines, in the ruler's own fraction-of-the-document terms. */
export interface Tick {
  kind: TickKind;
  top: number;
  bottom: number;
}

/** the shortest thumb worth grabbing, the same floor a scrollbar keeps */
const MIN_THUMB_PX = 24;

const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);

/**
 * @param ticks   what to paint, recomputed whenever the layout or document moves
 * @param dirty   extra reasons to repaint, for tick sources that live in a
 *                state field the view doesn't otherwise notice changing
 */
export function scrollRuler(
  ticks: (view: EditorView) => Tick[],
  dirty?: (u: ViewUpdate) => boolean
): Extension {
  return ViewPlugin.fromClass(
    class {
      dom: HTMLElement;
      thumb: HTMLElement;
      scrollEl: HTMLElement;
      isDiff = false;
      dragging = false;
      destroyed = false;
      /** what the strip currently shows; null until the first draw */
      lastKey: string | null = null;

      constructor(readonly view: EditorView) {
        this.dom = document.createElement("div");
        this.dom.className = "cm-changeRuler";
        // where you are in the file, over the marks of what's in it — only in
        // diffs, where the ruler covers the place a scrollbar would be. A
        // plain editor still has its scrollbar for this.
        this.thumb = document.createElement("div");
        this.thumb.className = "cm-changeRulerThumb";
        this.scrollEl = view.scrollDOM;
        this.dom.addEventListener("pointerdown", this.onDown);
        this.dom.addEventListener("pointermove", this.onMove);
        this.dom.addEventListener("pointerup", this.onUp);
        this.dom.addEventListener("pointercancel", this.onUp);
        // Mounted outside whatever scrolls, because it maps the whole
        // document and must not move when the document does. For a plain
        // editor that means on the editor itself, which scrolls inside. A
        // merge editor can't hold it: its pane grows to the whole document
        // and the .cm-mergeView wrapper does the scrolling, so anything in
        // the pane is document-tall and rides away — there it mounts on the
        // host around the wrapper, the box that stands still, and drags move
        // the wrapper. Deferred a microtask because this runs mid-way through
        // the MergeView constructor, when the wrapper exists but hangs
        // parentless until that constructor's last line attaches it.
        queueMicrotask(() => {
          if (this.destroyed) return;
          const wrap = view.dom.closest(".cm-mergeView") as HTMLElement | null;
          this.scrollEl = wrap ?? view.scrollDOM;
          this.isDiff = wrap !== null;
          (wrap?.parentElement ?? view.dom).appendChild(this.dom);
          if (this.isDiff) this.scrollEl.addEventListener("scroll", this.onScroll, { passive: true });
          this.draw();
        });
      }

      update(u: ViewUpdate) {
        // Change marks use logical line positions, not lazily measured pixel
        // geometry, so scrolling and the height corrections it triggers must
        // not redraw (or subtly move) them.
        if (u.docChanged || dirty?.(u)) this.draw();
      }

      draw() {
        const ts = ticks(this.view);
        // same marks in the same places: leave the DOM alone
        const key = ts.map((t) => `${t.kind} ${t.top.toFixed(4)} ${t.bottom.toFixed(4)}`).join("\n");
        if (key !== this.lastKey) {
          this.lastKey = key;
          const next = document.createDocumentFragment();
          for (const t of ts) {
            const el = document.createElement("div");
            el.className = `cm-changeTick cm-change-${t.kind}`;
            el.style.top = `${t.top * 100}%`;
            el.style.height = `${(t.bottom - t.top) * 100}%`;
            next.appendChild(el);
          }
          // last, so it paints over the marks it locates you among
          if (this.isDiff) next.appendChild(this.thumb);
          this.dom.replaceChildren(next);
        }
        this.placeThumb();
      }

      /** The scrollbar-thumb identity: height is the visible fraction of
       *  the file, the way the scrollbar it replaces draws it, with only
       *  the minimum every scrollbar has so it stays grabbable in a file
       *  long enough to shrink it to a sliver. When the minimum applies the
       *  thumb can't sit at the scrolled fraction — it would hang past the
       *  end — so it travels the way every scrollbar with a minimum thumb
       *  does: progress through the file maps to progress through the room
       *  the thumb has left. A file that fits entirely spans the whole
       *  strip rather than disappearing. */
      placeThumb() {
        if (!this.isDiff) return;
        const s = this.scrollEl;
        const visible = s.scrollHeight ? Math.min(s.clientHeight / s.scrollHeight, 1) : 1;
        const strip = this.dom.clientHeight;
        const minH = strip ? Math.min(MIN_THUMB_PX / strip, 1) : 0;
        const h = Math.max(visible, minH);
        const span = s.scrollHeight - s.clientHeight;
        const progress = span > 0 ? s.scrollTop / span : 0;
        this.thumb.style.top = `${progress * (1 - h) * 100}%`;
        this.thumb.style.height = `${h * 100}%`;
      }

      onScroll = () => this.placeThumb();

      /** put the point of the file this Y maps to in the middle of the screen */
      scrollTo(clientY: number) {
        const rect = this.dom.getBoundingClientRect();
        if (!rect.height) return;
        const scroller = this.scrollEl;
        const span = scroller.scrollHeight - scroller.clientHeight;
        if (span <= 0) return;
        const f = clamp((clientY - rect.top) / rect.height, 0, 1);
        scroller.scrollTop = clamp(f * scroller.scrollHeight - scroller.clientHeight / 2, 0, span);
      }

      onDown = (e: PointerEvent) => {
        if (e.button !== 0) return;
        // the ruler is over the editor: a press here must not also put the
        // caret somewhere or start a selection
        e.preventDefault();
        this.dragging = true;
        this.dom.setPointerCapture(e.pointerId);
        this.scrollTo(e.clientY);
      };

      onMove = (e: PointerEvent) => {
        if (this.dragging) this.scrollTo(e.clientY);
      };

      onUp = (e: PointerEvent) => {
        this.dragging = false;
        if (this.dom.hasPointerCapture(e.pointerId)) this.dom.releasePointerCapture(e.pointerId);
      };

      destroy() {
        this.destroyed = true;
        if (this.isDiff) this.scrollEl.removeEventListener("scroll", this.onScroll);
        this.dom.remove();
      }
    }
  );
}

/**
 * The ruler for a side-by-side diff, drawn from the merge view's own chunks.
 *
 * The file view measures against HEAD itself (see changeGutter.ts); here the
 * other pane *is* the baseline, so there's nothing to compute — the chunks the
 * merge view already tints the lines with are the ticks.
 *
 * `other` fetches the opposite pane's document, the same late binding charDiff
 * uses and for the same reason: the MergeView doesn't exist yet while its
 * editors are being built. It sizes the red half of a modified chunk — see
 * [`chunkTicks`].
 */
export function diffRuler(other: () => Text | null): Extension {
  return scrollRuler(
    (view) => chunkTicks(view, other),
    (u) => getChunks(u.state)?.chunks !== getChunks(u.startState)?.chunks
  );
}

function chunkTicks(view: EditorView, other: () => Text | null): Tick[] {
  const info = getChunks(view.state);
  if (!info) return [];
  const doc = view.state.doc;
  const otherDoc = other();
  const isA = info.side === "a";
  // The merge view aligns the two panes: where the other side has lines this
  // one lost, this pane gets a spacer as tall as them, and that is what
  // scrolls. The ruler maps that aligned layout, not this document alone —
  // a hundred deleted lines are a hundred rows of red you can scroll to, the
  // way Cursor draws them, not a hairline on the seam where they used to be.
  // Row counts stand in for spacer heights: CodeMirror only measures wrapped
  // off-screen lines as they approach the viewport, so pixel positions shift
  // while scrolling, and line-based ones don't.
  type Span = { kind: TickKind; from: number; to: number };
  const spans: Span[] = [];
  let extra = 0; // aligned rows added by spacers before the current chunk
  const lines = (d: Text, from: number, to: number, end: number) => {
    if (from >= to) return { first: d.lineAt(Math.min(from, d.length)).number, count: 0 };
    const first = d.lineAt(Math.min(from, d.length)).number;
    const last = d.lineAt(Math.min(Math.max(end, from), d.length)).number;
    return { first, count: last - first + 1 };
  };
  for (const chunk of info.chunks) {
    const own = isA
      ? lines(doc, chunk.fromA, chunk.toA, chunk.endA)
      : lines(doc, chunk.fromB, chunk.toB, chunk.endB);
    const across = otherDoc
      ? isA
        ? lines(otherDoc, chunk.fromB, chunk.toB, chunk.endB)
        : lines(otherDoc, chunk.fromA, chunk.toA, chunk.endA)
      : { first: 1, count: own.count ? own.count : 1 };
    const kept = own.count;
    const lost = across.count;
    // an empty own range sits *before* the line its position names; a
    // non-empty one starts on it
    const row = own.first - 1 + extra;
    if (kept) spans.push({ kind: "add", from: row, to: row + kept });
    // A modified chunk is two claims, and they need not be the same size:
    // green for every line standing on this side, red for what the other
    // side lost. One line rewritten into twenty is one line of red beside
    // twenty of green — a red half as tall as the green would say twenty
    // lines died here, and they didn't.
    if (lost) spans.push({ kind: "del", from: row, to: row + lost });
    extra += Math.max(0, lost - kept);
  }
  const total = doc.lines + extra;
  return spans.map((s) => ({ kind: s.kind, top: s.from / total, bottom: s.to / total }));
}
