import type { MouseEvent } from "react";
import { Menu } from "@tauri-apps/api/menu";
import { message } from "@tauri-apps/plugin-dialog";
import { api } from "./api";
import { pokeGit } from "./gitStatus";
import { parentOf, pokeFiles, pokeMoved } from "./fileEvents";
import { ask } from "./prompt";

/**
 * Right-click, on everything in the app that names a file.
 *
 * A real macOS menu rather than a drawn one. Everything else in zero's chrome
 * is hand-drawn precisely because the system has no opinion about it — a
 * context menu is the opposite case: the system has a very specific one, down
 * to the corner radius and the way it flips near a screen edge, and a div that
 * gets it nearly right is a div that reads as nearly right.
 *
 * Each surface builds its own list, because the useful verbs differ: a changes
 * row can stage, a tab can close, a memo can be listened to again. What they
 * share is `fileEntries` — reveal, copy, and the three that change the file —
 * so the bottom of every one of these menus is the same bottom.
 *
 * The paths handed in are the app's own model of the project, never anything a
 * program printed. The commands behind them refuse rather than overwrite, and
 * a rename is one path component by construction, so a typo can't move a file
 * somewhere you weren't looking.
 */

export interface Item {
  text: string;
  run: () => void | Promise<void>;
  enabled?: boolean;
}

/** A separator, or nothing at all — so a caller can write `cond && item` and
 *  have the gap it would have left close up with it. */
export type Entry = Item | "sep" | null | false | undefined;

/** The menu that is up. tauri's handle owns the native menu, so a collected
 *  handle would take its items' actions with it; this holds the live one until
 *  the next right-click replaces it, and frees that one then rather than on
 *  dismissal — the action arrives as an event, after the popup has returned. */
let live: Menu | null = null;

/**
 * Put these items up where the pointer is.
 *
 * An empty list — every entry conditional, none of them true — leaves the
 * event alone, so the webview's own menu keeps the click rather than a blank
 * panel appearing.
 */
export function contextMenu(e: MouseEvent, entries: Entry[]) {
  if (!entries.some((x) => x && x !== "sep")) return;
  // the browser's own menu, and any handler on a row further out: a right-click
  // belongs to the innermost thing that names a file
  e.preventDefault();
  e.stopPropagation();
  void contextMenuAt(entries);
}

/**
 * The same menu without an event to hang it on — for the terminal, where what
 * was clicked is a run of characters rather than an element, and knowing
 * whether it is a file at all takes a look at the disk first.
 */
export async function contextMenuAt(entries: Entry[]) {
  const items = trim(entries);
  if (!items.length) return;
  try {
    const menu = await Menu.new({
      items: items.map((entry, i) =>
        entry === "sep"
          ? { item: "Separator" as const }
          : {
              id: `i${i}`,
              text: entry.text,
              enabled: entry.enabled ?? true,
              action: () => void run(entry),
            }
      ),
    });
    live?.close().catch(() => {});
    live = menu;
    await menu.popup();
  } catch (err) {
    api.debugLog(`[menu] ${err}`).catch(() => {});
  }
}

/**
 * Drop the falsy entries, then the separators that no longer divide anything.
 *
 * Without the second half, a list whose conditional middle section is absent
 * shows two rules with nothing between them — every menu here is assembled from
 * pieces that may not apply, so leading, trailing and doubled separators are
 * the normal case rather than a mistake to catch in review.
 */
function trim(entries: Entry[]): (Item | "sep")[] {
  const kept = entries.filter((x): x is Item | "sep" => Boolean(x));
  const out: (Item | "sep")[] = [];
  for (const entry of kept) {
    if (entry === "sep" && (out.length === 0 || out[out.length - 1] === "sep")) continue;
    out.push(entry);
  }
  if (out[out.length - 1] === "sep") out.pop();
  return out;
}

/** Anything a menu item does can fail — a rename onto a name taken since the
 *  menu opened, a trash of something another process has locked. The backend
 *  writes those messages to be read, so this shows them rather than a code. */
async function run(item: Item) {
  try {
    await item.run();
  } catch (err) {
    await message(String(err), { title: item.text.replace(/…$/, ""), kind: "error" }).catch(
      () => {}
    );
  }
}

/* ---------- the items every file gets ---------- */

const copy = (text: string) => navigator.clipboard.writeText(text).catch(() => {});

/** what to say after a write: both panels that watch the project, at once */
function changed(dir: string) {
  pokeFiles(dir);
  pokeGit();
}

export interface FileOptions {
  /** the project, so "Copy Relative Path" has something to be relative to */
  root?: string | null;
  /** this row is a folder: it can hold new things, and duplicating it copies
   *  what's inside */
  isDir?: boolean;
  /** what was made, once it exists — the caller usually opens it */
  after?: (path: string) => void;
  /** rename this row your own way rather than through the overlay — the file
   *  tree has a field in the row itself, and the menu item should reach the
   *  same place the key does */
  onRename?: () => void;
  /**
   * Which of the writing verbs this row gets.
   *
   * - `all` (the default) — new, duplicate, rename, trash
   * - `inside` — only the two that make something *in* it. The project root is
   *   this: you can add to it, but it isn't one of the project's own entries
   *   and "Move to Trash" on it is not an offer to make
   * - `none` — rows naming a file whose name the app depends on (a memo's
   *   document) or whose life something else owns (a worktree's checkout)
   */
  writes?: "all" | "inside" | "none";
}

/**
 * The rename itself: the write, and everyone who has to hear about it.
 *
 * Where the new name was typed is the caller's business — the overlay below,
 * or a field the file tree puts in the row, which is where macOS types it. A
 * name that didn't change, or that is nothing at all, is not a rename and is
 * the ordinary way out of both. Failures are shown here rather than thrown,
 * because half the callers are keystrokes with nobody to catch them.
 */
export async function renameTo(path: string, to: string): Promise<string | null> {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const want = to.trim();
  if (!want || want === name) return null;
  try {
    const abs = await api.renameEntry(path, want);
    changed(parentOf(path));
    pokeMoved(path, abs);
    return abs;
  } catch (err) {
    await message(String(err), { title: "Rename", kind: "error" }).catch(() => {});
    return null;
  }
}

/** What is selected when a name is offered for editing: everything up to the
 *  extension, the way macOS does it, since the dot and what follows is rarely
 *  what changes. A leading dot is the name — `.gitignore` selects whole — and
 *  so is a folder's, which is what `stem: false` is for. */
export function selectStem(el: HTMLInputElement, name: string, stem = true) {
  const dot = stem ? name.lastIndexOf(".") : -1;
  if (dot > 0) el.setSelectionRange(0, dot);
  else el.select();
}

/**
 * Reveal, copy, and the verbs that change the file — the tail every one of
 * these menus ends with, in the order macOS puts them: where it is, what it's
 * called, then what you can do to it, then the one that takes it away.
 */
export function fileEntries(path: string, o: FileOptions = {}): Entry[] {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const up = parentOf(path);
  const inside = !!o.root && path.startsWith(o.root + "/");
  const writes = o.writes ?? "all";

  return [
    { text: "Reveal in Finder", run: () => api.revealPath(path) },
    "sep",
    { text: "Copy Path", run: () => copy(path) },
    inside && { text: "Copy Relative Path", run: () => copy(path.slice(o.root!.length + 1)) },
    "sep",

    o.isDir &&
      writes !== "none" && {
        text: "New File…",
        run: async () => {
          const made = await ask({ title: `new file in ${name}`, value: "", ok: "create" });
          if (!made) return;
          const abs = await api.createEntry(path, made, false);
          changed(path);
          o.after?.(abs);
        },
      },
    o.isDir &&
      writes !== "none" && {
        text: "New Folder…",
        run: async () => {
          const made = await ask({ title: `new folder in ${name}`, value: "", ok: "create" });
          if (!made) return;
          await api.createEntry(path, made, true);
          changed(path);
        },
      },

    writes === "all" && {
      text: "Duplicate",
      run: async () => {
        const abs = await api.duplicateEntry(path);
        changed(up);
        // opening the copy is the point of making one; a copied folder has
        // nothing to open, and the tree already shows it
        if (!o.isDir) o.after?.(abs);
      },
    },
    writes === "all" && {
      text: "Rename…",
      run: async () => {
        if (o.onRename) return o.onRename();
        const to = await ask({
          title: `rename ${name}`,
          value: name,
          ok: "rename",
          // a folder's dot isn't an extension, so select the lot
          stem: !o.isDir,
        });
        if (to) await renameTo(path, to);
      },
    },
    "sep",
    // No confirmation, deliberately: this is the real Trash, Finder can Put
    // Back what it took, and Finder's own contextual menu doesn't ask either.
    // The things in this app that do ask — discard, delete a memo — are the
    // ones nothing can undo.
    writes === "all" && {
      text: "Move to Trash",
      run: async () => {
        await api.trashEntry(path);
        changed(up);
        pokeMoved(path, null);
      },
    },
  ];
}
