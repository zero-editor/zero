import {
  KeyboardEvent,
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api, DirEntry } from "../lib/api";
import { contextMenu, fileEntries, renameTo, selectStem } from "../lib/contextMenu";
import { onFilesChanged } from "../lib/fileEvents";
import { FileIconSpan } from "./FileIcon";
import { Chevron } from "./Chevron";
import { decorations, Decorations, GitMark, STATUS_NAME, useGitStatusMany } from "../lib/gitStatus";
import { baseName } from "../lib/folders";
import type { View } from "./Workspace";

/** Audio goes to Finder rather than to the editor: QuickLook plays these with
 *  a space bar, and the editor would open a memo as a wall of bytes. */
const AUDIO = /\.(m4a|caf|wav|aiff|mp3)$/i;

/** a file to walk to and light up — ⌘E. The counter is what makes pressing it
    twice work: the path alone wouldn't have changed. */
export interface Reveal {
  path: string;
  n: number;
}

export function FileTree({
  roots,
  active,
  reveal,
  onOpenView,
  onAddFolder,
  onRemoveFolder,
}: {
  /** the project's folders, primary first. Usually one; several when a
   *  codebase is split across repositories that aren't siblings on disk. */
  roots: string[];
  active: boolean;
  reveal: Reveal | null;
  onOpenView: (v: View) => void;
  onAddFolder: () => void;
  /** never called for `roots[0]` — that folder is the project's identity */
  onRemoveFolder: (dir: string) => void;
}) {
  // A joined string, because `roots` is a fresh array on every render and an
  // effect keyed on it would re-read the whole tree each time.
  const key = roots.join("\n");
  const multi = roots.length > 1;
  /** which folder a path is under — the one whose menus and git marks it
   *  answers to. Longest match, so a folder inside another still resolves to
   *  itself if one ever slips past the nesting check. */
  const owner = (path: string): string =>
    roots
      .filter((r) => path === r || path.startsWith(r + "/"))
      .sort((a, b) => b.length - a.length)[0] ?? roots[0];
  // expansion lives here rather than in each row: revealing a file means
  // opening every folder above it at once, which a row can't do to its parents
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [kids, setKids] = useState<Record<string, DirEntry[]>>({});
  const [selected, setSelected] = useState<string | null>(null);
  /** the row whose name is a field right now — Finder renames in place, and a
   *  tree is the one surface where "in place" is a row that already exists */
  const [editing, setEditing] = useState<string | null>(null);

  const kidsRef = useRef<Record<string, DirEntry[]>>({});
  const pending = useRef(new Map<string, Promise<DirEntry[]>>());
  const selRef = useRef<HTMLButtonElement | null>(null);
  const wantScroll = useRef(false);
  /** a row to hand the keyboard back to once it exists under its new name —
   *  renaming replaces the element, and a second Return has to find something */
  const wantFocus = useRef<string | null>(null);
  /** ⎋ was pressed, so the blur that follows is a cancellation rather than the
   *  commit every other way out of the field is */
  const abandoned = useRef(false);

  const git = useGitStatusMany(roots, active);
  // One map for the whole tree, merged from each folder's own. The keys are
  // absolute paths, so folders can't collide — and a folder is only ever
  // matched against the worktrees of its own sweep, since "the main worktree"
  // stops being a question with one answer once there are several.
  const marks = useMemo(() => {
    const files: Decorations["files"] = new Map();
    const dirs: Map<string, GitMark> = new Map();
    for (const r of roots) {
      const own = git.worktrees.filter((w) => w.owner === undefined || w.owner === r);
      const wt = own.find((w) => w.path === r) ?? own.find((w) => w.is_main);
      const d = decorations(r, wt?.changes ?? []);
      d.files.forEach((v, k) => files.set(k, v));
      d.dirs.forEach((v, k) => dirs.set(k, v));
    }
    return { files, dirs };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [git.epoch, key]);

  /** a directory's children, read once and remembered */
  const load = useCallback((dir: string): Promise<DirEntry[]> => {
    const have = kidsRef.current[dir];
    if (have) return Promise.resolve(have);
    let p = pending.current.get(dir);
    if (!p) {
      p = api
        .listDir(dir)
        .catch(() => [] as DirEntry[])
        .then((entries) => {
          kidsRef.current = { ...kidsRef.current, [dir]: entries };
          setKids(kidsRef.current);
          pending.current.delete(dir);
          return entries;
        });
      pending.current.set(dir, p);
    }
    return p;
  }, []);

  useEffect(() => {
    kidsRef.current = {};
    pending.current.clear();
    setKids({});
    // Every folder starts open. With one folder that is invisible — its header
    // isn't drawn and its children are the top level, exactly as before. With
    // several, a project that opened onto three collapsed rows would be hiding
    // the thing it was just asked to show.
    setOpen(new Set(roots));
    for (const r of roots) void load(r);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, load]);

  /**
   * A folder was written to — forget what we knew of it and ask again.
   *
   * The tree reads a directory once and remembers, which is what keeps it from
   * walking the project on a timer; the cost is that a rename from anywhere
   * else in the app leaves a row saying the old name. `null` is "no idea
   * which", and drops the lot — every open folder then reloads as it is drawn.
   */
  useEffect(
    () =>
      onFilesChanged((dir) => {
        if (dir === null) {
          kidsRef.current = {};
          pending.current.clear();
          setKids({});
          for (const r of roots) void load(r);
          return;
        }
        if (!(dir in kidsRef.current)) return;
        const next = { ...kidsRef.current };
        delete next[dir];
        // the ref only — `kids` keeps the old rows until the new ones arrive,
        // which is a folder that doesn't blink every time you rename in it
        kidsRef.current = next;
        pending.current.delete(dir);
        void load(dir);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, load]
  );

  useEffect(() => {
    if (!reveal) return;
    // whichever folder holds it, rather than the first one
    const base = roots.find((r) => reveal.path.startsWith(r + "/"));
    if (!base) return;
    let cancelled = false;

    (async () => {
      const parts = reveal.path.slice(base.length + 1).split("/");
      const folders: string[] = [base];
      let dir = base;
      for (let i = 0; i < parts.length - 1; i++) {
        dir = `${dir}/${parts[i]}`;
        folders.push(dir);
      }
      // one level at a time: a folder's children are how the next level down
      // is reached, so they have to have arrived before we ask for it
      await load(base);
      for (const f of folders) {
        if (cancelled) return;
        await load(f);
      }
      if (cancelled) return;
      setOpen((prev) => {
        const next = new Set(prev);
        folders.forEach((f) => next.add(f));
        return next;
      });
      setSelected(reveal.path);
      wantScroll.current = true;
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal, key, load]);

  // after the folders have opened and the row exists
  useEffect(() => {
    if (wantScroll.current && selRef.current) {
      selRef.current.scrollIntoView({ block: "nearest" });
      wantScroll.current = false;
    }
  });

  const toggle = (dir: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else {
        next.add(dir);
        void load(dir);
      }
      return next;
    });

  /**
   * Every row's element, wanted for two unrelated reasons: ⌘E scrolls to the
   * one it selected, and a row renamed from the keyboard comes back as a new
   * element that has to take the focus its predecessor had.
   */
  const rowRef = (full: string, isSel: boolean) => (el: HTMLButtonElement | null) => {
    if (isSel) selRef.current = el;
    if (el && wantFocus.current === full) {
      wantFocus.current = null;
      el.focus();
    }
  };

  /**
   * Return renames, which is what that key does in Finder.
   *
   * A row is a `<button>`, so without the preventDefault the browser turns the
   * key into a click and Return means "open this again" — the reason nothing
   * appeared to happen. The keyboard is on the row because clicking it puts it
   * there: WebKit doesn't focus a button on click the way other engines do.
   */
  const onRowKey = (e: KeyboardEvent<HTMLButtonElement>, full: string) => {
    if (e.key !== "Enter" || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    e.preventDefault();
    e.stopPropagation();
    setEditing(full);
  };

  /**
   * Leaving the field is what commits — Return blurs it, and so does clicking
   * away, which is the pair Finder commits on. ⎋ leaves through `abandoned`
   * instead, and an unchanged or empty name is `renameTo`'s no-op.
   *
   * Either way the keyboard comes back to the row: it was on the row before
   * the field replaced it, and after a rename it is a different element with
   * the same place in the tree.
   */
  const commit = async (full: string, isDir: boolean, typed: string) => {
    // the old name first, and before the field goes: the row that replaces it
    // is drawn on this render, while the write below is still an IPC away, and
    // a rename that fails or changes nothing has to leave the keyboard where
    // it was rather than on the body
    wantFocus.current = full;
    setEditing(null);
    if (abandoned.current) {
      abandoned.current = false;
      return;
    }
    const abs = await renameTo(full, typed);
    if (!abs) return;
    // a folder's highlight isn't ours to set — only files are ever selected
    if (!isDir && selected === full) setSelected(abs);
    wantFocus.current = abs;
  };

  /** the row, while its name is being typed. Same class list, so it sits at
   *  the same indent with the same icon and nothing shifts under the caret. */
  const editRow = (full: string, entry: DirEntry, pad: object) => (
    <div key={full} className={`tree-item ${entry.is_dir ? "dir" : "file"} editing`} style={pad}>
      {entry.is_dir ? (
        <Chevron open={open.has(full)} className="tree-arrow" />
      ) : (
        <FileIconSpan name={entry.name} />
      )}
      <input
        className="tree-rename"
        defaultValue={entry.name}
        spellCheck={false}
        // on the element rather than in an effect: the field is mounted and
        // gone inside one row's lifetime, and the guard is what keeps a
        // re-render from re-selecting the stem out from under your typing
        ref={(el) => {
          if (el && document.activeElement !== el) {
            el.focus();
            selectStem(el, entry.name, !entry.is_dir);
          }
        }}
        // every key in here is this field's, the way the overlay's is —
        // otherwise ⌘W closes the tab behind the name you are typing
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            e.preventDefault();
            abandoned.current = true;
            setEditing(null);
          }
        }}
        onBlur={(e) => void commit(full, entry.is_dir, e.currentTarget.value)}
      />
    </div>
  );

  /** what a click on a file row does, and what the menu's "Open" does too */
  const openFile = (full: string, name = full.slice(full.lastIndexOf("/") + 1)) => {
    setSelected(full);
    // audio goes to Finder, where QuickLook plays it with a space bar; the
    // editor would open a memo as a wall of bytes
    if (AUDIO.test(name)) {
      api.revealPath(full).catch(() => {});
      return;
    }
    onOpenView({ kind: "file", key: `file:${full}`, absPath: full });
  };

  const rows = (dir: string, depth: number): ReactNode[] =>
    (kids[dir] ?? []).flatMap((entry) => {
      const full = `${dir}/${entry.name}`;
      const isSel = selected === full;
      const pad = { paddingLeft: depth * 14 + 8 };

      // the field stands in for the row, and an open folder keeps its children
      // underneath — renaming a folder shouldn't collapse what's inside it
      if (editing === full) {
        return [
          editRow(full, entry, pad),
          ...(entry.is_dir && open.has(full) ? rows(full, depth + 1) : []),
        ];
      }

      if (!entry.is_dir) {
        const mark = marks.files.get(full);
        return [
          <button
            key={full}
            ref={rowRef(full, isSel)}
            className={`tree-item file ${entry.ignored ? "ignored" : ""} ${
              isSel ? "selected" : ""
            } ${mark ? `git-${mark.mark}` : ""}`}
            style={pad}
            onClick={(e) => {
              e.currentTarget.focus();
              openFile(full, entry.name);
            }}
            onKeyDown={(e) => onRowKey(e, full)}
            // the row the menu is about lights up while it's open, the way a
            // right-click in Finder selects what it landed on
            onContextMenu={(e) => {
              setSelected(full);
              contextMenu(e, [
                { text: "Open", run: () => openFile(full, entry.name) },
                ...fileEntries(full, {
                  root: owner(full),
                  after: (made) => openFile(made),
                  onRename: () => setEditing(full),
                }),
              ]);
            }}
          >
            <FileIconSpan name={entry.name} />
            <span className="tree-name">{entry.name}</span>
            {mark && (
              <span className="tree-badge" title={STATUS_NAME[mark.letter] ?? mark.letter}>
                {mark.letter}
              </span>
            )}
          </button>,
        ];
      }

      const isOpen = open.has(full);
      const dirMark = marks.dirs.get(full);
      return [
        <button
          key={full}
          ref={rowRef(full, false)}
          className={`tree-item dir ${entry.ignored ? "ignored" : ""} ${
            dirMark ? `git-${dirMark}` : ""
          }`}
          style={pad}
          onClick={(e) => {
            e.currentTarget.focus();
            toggle(full);
          }}
          onKeyDown={(e) => onRowKey(e, full)}
          onContextMenu={(e) =>
            contextMenu(e, [
              // a new file lands in the folder you asked from, so open it —
              // otherwise the row appears under a chevron still pointing right
              ...fileEntries(full, {
                root: owner(full),
                isDir: true,
                onRename: () => setEditing(full),
                after: (made) => {
                  // the same pair `toggle` does: opening a folder and reading
                  // it are two things, and a folder nobody had opened yet has
                  // no children loaded for the new row to appear among
                  setOpen((prev) => (prev.has(full) ? prev : new Set(prev).add(full)));
                  void load(full);
                  openFile(made);
                },
              }),
            ])
          }
        >
          <Chevron open={isOpen} className="tree-arrow" />
          <span className="tree-name">{entry.name}</span>
        </button>,
        ...(isOpen ? rows(full, depth + 1) : []),
      ];
    });

  /**
   * A folder's own row, drawn only when the project has more than one.
   *
   * With a single folder the tree opens straight onto its contents, which is
   * how it has always looked and is one less row between you and the files.
   * The header earns its line only when there is something to tell apart.
   */
  const rootRow = (dir: string): ReactNode => (
    <button
      key={dir}
      className={`tree-item dir tree-root ${open.has(dir) ? "" : "closed"}`}
      style={{ paddingLeft: 8 }}
      title={dir}
      onClick={(e) => {
        e.currentTarget.focus();
        toggle(dir);
      }}
      onContextMenu={(e) =>
        contextMenu(e, [
          // The project's first folder is what everything about the project is
          // keyed on — its stored layout, its notes, the cwd its terminals open
          // in — so it is shown here without the verb that would take it away.
          dir === roots[0]
            ? { text: "Remove from Project", enabled: false, run: () => {} }
            : { text: "Remove from Project", run: () => onRemoveFolder(dir) },
          { text: "Add Folder to Project…", run: onAddFolder },
          "sep",
          ...fileEntries(dir, { root: dir, isDir: true, writes: "inside", after: openFile }),
        ])
      }
    >
      <Chevron open={open.has(dir)} className="tree-arrow" />
      <span className="tree-name">{baseName(dir)}</span>
    </button>
  );

  // The container's own menu, which only ever fires on the space below the last
  // row — every row stops the event. That space is the project itself, so what
  // it offers is what you can put *in* the project, plus the one thing that is
  // about the project rather than about a file. A folder is not one of the
  // project's entries and has no business being renamed or trashed from here.
  return (
    <div
      className="file-tree"
      onContextMenu={(e) =>
        contextMenu(e, [
          { text: "Add Folder to Project…", run: onAddFolder },
          "sep",
          ...fileEntries(roots[0], {
            root: roots[0],
            isDir: true,
            writes: "inside",
            after: openFile,
          }),
        ])
      }
    >
      {multi
        ? roots.flatMap((r) => [rootRow(r), ...(open.has(r) ? rows(r, 1) : [])])
        : rows(roots[0], 0)}
      {/* Quiet, and last, and always there — including for a project with one
          folder, which is the only place anyone would find out this can be
          done. It sits below the tree rather than in the rail because the rail
          is tabs, and because the folders are the thing it adds to. */}
      <button className="tree-add" onClick={onAddFolder}>
        + add folder
      </button>
    </div>
  );
}
