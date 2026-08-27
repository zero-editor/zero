import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "./api";

// Files dragged in from Finder never reach the terminal on their own. Tauri
// takes the OS drag before the webview sees it — that's `dragDropEnabled`,
// which is on by default — so no HTML drop event fires anywhere in the page
// and xterm's textarea, which would otherwise paste what it was given, hears
// nothing. The paths arrive here instead, on the webview's own event, and this
// is what puts them in the pane they were aimed at.

/** Everything outside this set gets a backslash, which is the escaping a
 *  terminal does when you drop a file on it. One path with spaces in it stays
 *  one argument, to a shell and to Claude Code alike. */
const NEEDS_ESCAPE = /[^A-Za-z0-9_+=:,.@%/-]/g;

function escapePath(path: string): string {
  return path.replace(NEEDS_ESCAPE, "\\$&");
}

// The event's position is typed `PhysicalPosition`, and on macOS it isn't one.
// wry reads it from `NSDraggingInfo.draggingLocation` and passes the AppKit
// point straight through, so what arrives is points within the webview's frame
// — off from CSS pixels by the page zoom, and off from physical pixels by the
// display's backing scale. Dividing by devicePixelRatio, which is what the
// name invites, lands the hit test in the top-left quarter of the window and
// finds no pane at all.
//
// So measure the two coordinate spaces against each other instead of naming a
// factor: the frame the points are in and the viewport CSS pixels are in are
// the same rectangle, so their widths give the ratio between them, whatever
// the zoom and whatever the display.
let toCss = 1;
let measuring: Promise<void> | null = null;

function measure(): Promise<void> {
  const done = (async () => {
    const win = getCurrentWindow();
    const [size, scale] = await Promise.all([win.innerSize(), win.scaleFactor()]);
    const points = size.width / scale;
    if (points > 0 && window.innerWidth > 0) toCss = window.innerWidth / points;
  })()
    .catch(() => {})
    .then(() => {
      if (measuring === done) measuring = null;
    });
  measuring = done;
  return done;
}

/** the terminal pane under a drop point, if the point is over one at all */
function paneAt(pos: { x: number; y: number }): HTMLElement | null {
  const el = document.elementFromPoint(pos.x * toCss, pos.y * toCss);
  return el?.closest<HTMLElement>("[data-term-id]") ?? null;
}

/** the pane currently lit up as the drop target */
let hovered: HTMLElement | null = null;

function highlight(pane: HTMLElement | null) {
  if (pane === hovered) return;
  hovered?.classList.remove("term-drop");
  pane?.classList.add("term-drop");
  hovered = pane;
}

/**
 * Where a drop lands when it isn't aimed at a terminal: folders open as
 * projects, files as editor tabs. Registered by App rather than imported from
 * it, because this module must not depend on a component. One opener for the
 * window, like the one listener below.
 */
let opener: ((paths: string[]) => void) | null = null;

export function setDropOpener(fn: (paths: string[]) => void) {
  opener = fn;
}

let started = false;

/** Idempotent, and never torn down: one listener serves every pane in every
 *  project, since it finds its target in the DOM rather than being told. */
export function watchFileDrops() {
  if (started) return;
  started = true;
  measure();
  getCurrentWebview()
    .onDragDropEvent(async ({ payload }) => {
      if (payload.type === "leave") {
        highlight(null);
        return;
      }
      // a drag begins with `enter`, which is the moment to re-measure: the
      // window may have been resized or the UI zoomed since the last one
      if (payload.type === "enter") measure();
      if (measuring) await measuring;

      const pane = paneAt(payload.position);
      if (payload.type !== "drop") {
        // lighting the pane as it's dragged over says where the path will go,
        // which is the only feedback there is before letting go
        highlight(pane);
        return;
      }
      highlight(null);
      if (payload.paths.length === 0) return;
      const id = pane?.dataset.termId;
      if (!id) {
        // not aimed at a terminal, so it's an open: the Launcher, the file
        // tree, an editor tab — anywhere in the window means "open this"
        opener?.(payload.paths);
        return;
      }
      // trailing space so a second file, or whatever gets typed next, doesn't
      // run into the path
      const text = payload.paths.map(escapePath).join(" ") + " ";
      api.ptyWrite(id, text).catch((e) => console.warn(`drop: ${e}`));
      // the drop is where you were looking, so put the caret there too
      pane.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")?.focus();
    })
    .catch((e) => console.warn(`drop: ${e}`));
}
