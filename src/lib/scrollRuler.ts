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
      /** the document height the ticks were last computed against */
      lastHeight = -1;
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
        // geometryChanged fires on every scroll frame of a long wrapped file —
        // CodeMirror measures lines as they come into view and corrects its
        // estimates — and redrawing the strip inside those frames is exactly
        // the work that makes the scroll stutter. The ticks only move when the
        // document's height does, so that is the signal to redraw on.
        if (
          u.docChanged ||
          dirty?.(u) ||
          (u.geometryChanged && this.view.contentHeight !== this.lastHeight)
        )
          this.draw();
      }

      draw() {
        this.lastHeight = this.view.contentHeight;
        const ts = ticks(this.view);
        // same marks in the same places: leave the DOM alone. Height
        // corrections land here constantly while a long file is first
        // scrolled, and almost none of them move a tick a visible amount.
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

      /** The scrollbar-thumb identity, at double weight: height is twice the
       *  visible fraction of the file (capped at the whole strip), which
       *  keeps it legible in files long enough to shrink an honest thumb to
       *  a sliver. A thumb taller than the true fraction can't sit at the
       *  scrolled fraction — it would hang past the end — so it travels the
       *  way every scrollbar with a minimum thumb does: progress through the
       *  file maps to progress through the room the thumb has left. A file
       *  that fits entirely spans the whole strip rather than disappearing. */
      placeThumb() {
        if (!this.isDiff) return;
        const s = this.scrollEl;
        const visible = s.scrollHeight ? Math.min(s.clientHeight / s.scrollHeight, 1) : 1;
        const h = Math.min(visible * 2, 1);
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
  const total = view.contentHeight;
  if (!info || !total) return [];
  const doc = view.state.doc;
  const len = doc.length;
  const otherDoc = other();
  const isA = info.side === "a";
  const out: Tick[] = [];
  for (const chunk of info.chunks) {
    const own = isA
      ? { from: chunk.fromA, to: chunk.toA, end: chunk.endA }
      : { from: chunk.fromB, to: chunk.toB, end: chunk.endB };
    const across = isA
      ? { from: chunk.fromB, to: chunk.toB, end: chunk.endB }
      : { from: chunk.fromA, to: chunk.toA, end: chunk.endA };
    const start = view.lineBlockAt(Math.min(own.from, len));
    const last = view.lineBlockAt(Math.min(Math.max(own.end, own.from), len));
    const top = start.top / total;
    const bottom = (last.top + last.height) / total;
    if (own.from >= own.to) {
      // nothing on this side: lines were removed and none put back, so the mark
      // goes on the seam they closed over rather than down a line that isn't there
      out.push({ kind: "del", top, bottom });
    } else if (across.from >= across.to) {
      out.push({ kind: "add", top, bottom });
    } else {
      // A modified chunk is two claims, and they need not be the same size:
      // green for every line standing on this side, red for what the other
      // side lost. One line rewritten into twenty is one line of red beside
      // twenty of green — a red half as tall as the green would say twenty
      // lines died here, and they didn't.
      out.push({ kind: "add", top, bottom });
      let delBottom = bottom;
      if (otherDoc) {
        const oLen = otherDoc.length;
        const lost =
          otherDoc.lineAt(Math.min(Math.max(across.end, across.from), oLen)).number -
          otherDoc.lineAt(Math.min(across.from, oLen)).number +
          1;
        const first = doc.lineAt(Math.min(own.from, len)).number;
        const kept = doc.lineAt(Math.min(Math.max(own.end, own.from), len)).number - first + 1;
        if (lost < kept) {
          const block = view.lineBlockAt(doc.line(first + lost - 1).from);
          delBottom = (block.top + block.height) / total;
        }
      }
      out.push({ kind: "del", top, bottom: delBottom });
    }
  }
  return out;
}
