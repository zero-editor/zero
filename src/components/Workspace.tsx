import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Project } from "../App";
import { closeSeq } from "../lib/closeOrder";
import { Sidebar, SidebarTab } from "./Sidebar";
import type { Reveal } from "./FileTree";
import { EditorPane } from "./EditorPane";
import { TerminalPanes } from "./Terminals";
import { QuickOpen } from "./QuickOpen";
import {
  EDITOR,
  SIDEBAR,
  collectRects,
  isEditorPane,
  isTerm,
  leafIds,
  parentDirOf,
  precedes,
  nodeAt,
  seatedLeaf,
  seatedLeafAtRoot,
  sizesOf,
  pathOf,
  useLayoutTree,
  withSizes,
  type Divider,
  type LayoutNode,
  type Rect,
  type Side,
} from "../lib/layout";
import { flushSync } from "react-dom";
import { moveItem, movedIndex } from "../lib/tabReorder";
import { onPathMoved, under } from "../lib/fileEvents";
import { onProjectOpen } from "../lib/openBus";
import { getSettings } from "../lib/settings";
import { projectSession, saveProject, type DocPane } from "../lib/session";
import { decorations, useGitStatus, type GitMark } from "../lib/gitStatus";
import { useSearch } from "../lib/search";
import { useMemos } from "../lib/memos";
import { api } from "../lib/api";
import { goToNoteEnd } from "../lib/notes";

export type View =
  // `staged` picks which of git's two diffs this is: HEAD→index when set, and
  // index→working tree when not. Optional because sessions written before it
  // existed have no such field, and the working-tree diff is what they were.
  // `from` is the path this file had before it was moved, when it was. The
  // staged side of a rename is HEAD, and HEAD has never heard of the new path
  // — asked for it, it answers with nothing and the diff reads as a brand new
  // file rather than as the same one, one folder over.
  | {
      kind: "diff";
      key: string;
      worktree: string;
      relPath: string;
      staged?: boolean;
      from?: string;
    }
  | { kind: "file"; key: string; absPath: string; line?: number }
  | { kind: "new"; key: string; name: string }
  // A memo, opened as the thread it is rather than as the file it also is. No
  // root on it: views belong to the workspace that holds them, and that
  // workspace is the project the memo was recorded in. The files are still
  // reachable — ⌥ on the row opens the raw as a file view, and the breadcrumb
  // over the thread opens the document — which is what keeps this a reading of
  // a memo rather than a second place it lives.
  | { kind: "memo"; key: string; id: string }
  // A Linear issue, read where the code is. `identifier` rides along with the
  // uuid the API wants because the tab has to be able to say ECL-99 before the
  // fetch that would tell it that comes back — a tab restored from a session
  // draws before the network does.
  | { kind: "issue"; key: string; id: string; identifier: string };

const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);

/** the whole field, in the percentages every rect in here is expressed in */
const FIELD: Rect = { x: 0, y: 0, w: 100, h: 100 };

/* A seam, addressed and placed. Both are written twice — once by the render
   and once by a live divider drag, which paints the seams itself rather than
   going through React for every frame (see startDividerResize) — so they live
   out here where the two can't drift apart. The key holds nothing a resize
   changes, which is what lets the drag find the same element every frame. */
const seamKey = (d: Divider) => `${d.path.join(".")}:${d.li}`;
const seamStyle = (d: Divider): React.CSSProperties =>
  d.dir === "row"
    ? { left: `${d.host.x + d.host.w * d.at}%`, top: `${d.host.y}%`, height: `${d.host.h}%` }
    : { top: `${d.host.y + d.host.h * d.at}%`, left: `${d.host.x}%`, width: `${d.host.w}%` };

/* ----- the drag's numbers -----
   Every threshold the gesture answers to, gathered here to be tuned from.
   Distances are CSS px. Direct-sibling swaps stay instant on entry — if that
   ever proves twitchy on small panes, an entry buffer belongs in this list.
   The share clamps a seat may take live with the tree ops, in layout.ts. */
/** travel before a press becomes a carry — a click with a shake in it stays a click */
const DRAG_START = 5;
/** the window-edge band that aims a drop at the root rather than at any pane */
const EDGE_STRIP = 22;
/** a split band's share of the extent it crosses… */
const SPLIT_BAND = 0.25;
/** …never thinner than this, so a short pane still offers one */
const SPLIT_BAND_MIN = 28;
/** …and never wider, so a tall pane doesn't become mostly band */
const SPLIT_BAND_MAX = 90;
/** crosswise travel before split bands arm at all — a level slide never splits */
const CROSS_ARM = 24;
/** how near a seam has to come to another running the same way before it
 *  takes its line exactly (⌥ during the drag passes on the offer) */
const SEAM_SNAP = 7;

/**
 * Everything in this window that a keystroke might belong to instead of to us.
 *
 * Every other shortcut here carries ⌘ or ⌃ and can be read off the key alone.
 * The recording keys carry nothing — ⎋ and space, because a hand that is
 * talking into a mic is not on a modifier — and a bare space is a letter to
 * every text surface in the app: the commit message, the search fields, the
 * quick-open box, CodeMirror's editor (which is a contenteditable), and the
 * terminal, where it is also a letter to whatever is running in it. So the gate
 * is the target rather than the key: if the event started anywhere you can
 * type, the key was never ours. `contenteditable` is matched by presence
 * rather than by `="true"`, because the attribute has several truthy spellings
 * and only one false one.
 */
const TEXT_SURFACES = 'input, textarea, [contenteditable]:not([contenteditable="false"]), .xterm';

const typing = (e: KeyboardEvent) =>
  e.target instanceof Element && e.target.closest(TEXT_SURFACES) !== null;

// memoised: switching projects changes `active` on exactly two of them, and
// without this every other open project re-renders its whole tree for nothing
export const Workspace = memo(function Workspace({
  project,
  active,
  locked,
  lastClosedProject,
  onReopenProject,
}: {
  project: Project;
  active: boolean;
  /** the titlebar's layout lock. On, panes cannot be picked up: the grab
   *  pills never arm and startPaneDrag is inert — only the carrying is
   *  locked, so splits and divider resizes go on working. */
  locked: boolean;
  /** the close-order stamp of the newest project waiting to be reopened, or
   *  null if none is — what ⌘⇧T weighs this project's closed tabs against */
  lastClosedProject: number | null;
  onReopenProject: () => void;
}) {
  // last session's layout for this project. Read once: the component is keyed
  // by root, so a mount is always a project arriving, never one changing.
  const [saved] = useState(() => projectSession(project.root));
  // files, not scm: a first open lands on the project's contents, the way
  // every other editor arrives — a clean repo's git tab reads as "empty"
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>(saved.sidebarTab ?? "files");
  const [sidebarVisible, setSidebarVisible] = useState(saved.sidebarVisible ?? true);
  // Folded to its rail: the same leaf of the tree, held at the width of its
  // run of icons. Kept in the tree rather than taken out the way ⌘B takes
  // it, because the tree is what keeps everything else still — a fold that
  // hid the leaf and stood a strip beside the field moved every pane over
  // by the strip's width, terminals along the floor included. In the tree,
  // the editor beside it takes the room and nothing else moves. The width
  // is pinned in pixels (see pinSidebar): a share would scale with the
  // window, and a rail that is 40px at one width is 30px at another. Any
  // reason to show the sidebar unfolds it too: a reveal that landed in a
  // rail would have revealed nothing.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(saved.sidebarCollapsed ?? false);
  const sidebarShare = useRef<number | null>(saved.sidebarShare ?? null);
  const showSidebar = useCallback(() => {
    setSidebarVisible(true);
    setSidebarCollapsed(false);
  }, []);
  const [terminalVisible, setTerminalVisible] = useState(saved.terminalVisible ?? true);
  const [quickOpen, setQuickOpen] = useState(false);
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const revealCount = useRef(0);
  const untitledRef = useRef(0);
  const tree = useLayoutTree(project.root, saved);
  /**
   * Every document pane's tabs, keyed the way the tree keys its leaves. The
   * tree says where the panes stand; this says what each one is holding —
   * two facts about the same ids, reconciled only where a pane appears or
   * goes (see the effect below the movers).
   */
  const [docPanes, setDocPanes] = useState<Record<string, DocPane>>(() => {
    // the pre-pane era stored one list; it becomes the original pane's
    const stored = saved.docPanes ?? {
      [EDITOR]: { views: saved.views ?? [], activeView: saved.activeView ?? 0 },
    };
    const live = leafIds(tree.root).filter(isEditorPane);
    const out: Record<string, DocPane> = {};
    const orphans: View[] = [];
    for (const [id, dp] of Object.entries(stored)) {
      if (live.includes(id)) out[id] = dp;
      else orphans.push(...dp.views);
    }
    // tabs whose pane didn't survive the tree's own validation land in the
    // first pane rather than nowhere — a mangled layout shouldn't cost tabs
    if (orphans.length && live[0]) {
      const dp = out[live[0]] ?? { views: [], activeView: 0 };
      const open = new Set(Object.values(out).flatMap((d) => d.views.map((v) => v.key)));
      out[live[0]] = { ...dp, views: [...dp.views, ...orphans.filter((v) => !open.has(v.key))] };
    }
    return out;
  });
  /**
   * The panes the restore handed back with nothing in them.
   *
   * A pane can arrive empty even though it was full at quit: untitled buffers
   * deliberately don't survive a relaunch (see validViews), so a pane holding
   * only those comes back as a pane with no tabs. It is still a pane you
   * built, and the reaper below — which exists to let a pane follow its *last
   * tab* out — would otherwise take it and its place in the layout with it,
   * one pane per launch, with nothing to say it had happened.
   *
   * So these are spared until something opens in them, at which point they
   * become ordinary panes with an ordinary last tab to lose.
   */
  const [bornEmpty] = useState(
    () =>
      new Set(
        leafIds(tree.root)
          .filter(isEditorPane)
          .filter((id) => !docPanes[id]?.views.length)
      )
  );
  /** the pane opens land in — held as a preference rather than reconciled:
   *  if the pane it names has gone, `currentPane` below answers with the
   *  first one the tree still holds */
  const [activePane, setActivePane] = useState<string>(saved.activePane ?? EDITOR);

  const paneIds = leafIds(tree.root).filter(isEditorPane);
  const currentPane = paneIds.includes(activePane) ? activePane : (paneIds[0] ?? EDITOR);
  const paneDocs = (id: string): DocPane => docPanes[id] ?? { views: [], activeView: 0 };
  // held here rather than in the panel so a result list survives a look at the
  // file tree — the sidebar renders one tab at a time
  const search = useSearch(project.root);
  // up here for the same reason, plus one of its own: the rail's dot is drawn
  // by a tab you aren't on, about a recording that outlives every panel
  const memos = useMemos(
    project.root,
    active && sidebarVisible && sidebarTab === "memos",
    // a memo recorded here lands in the editor the moment it comes back ready,
    // as the same thread its row opens
    (id) => openView({ kind: "memo", key: `memo:${id}`, id }),
    // a cleanup that failed for want of a login is fixed in a terminal, and
    // the terminals are this component's to open
    () => {
      setTerminalVisible(true);
      tree.newTerminal("claude /login");
    }
  );

  // everything this project should look like next launch. The store debounces,
  // so a divider drag firing this per mousemove costs one write at the end.
  useEffect(() => {
    saveProject(project.root, {
      layout: tree.root,
      focusedId: tree.focusedId,
      sidebarTab,
      sidebarVisible,
      sidebarCollapsed,
      sidebarShare: sidebarShare.current,
      terminalVisible,
      docPanes,
      activePane: currentPane,
    });
  }, [
    project.root,
    tree.root,
    tree.focusedId,
    sidebarTab,
    sidebarVisible,
    sidebarCollapsed,
    terminalVisible,
    docPanes,
    currentPane,
  ]);

  /**
   * Open a view in the pane opens land in — unless it is already open in
   * some pane, in which case that pane comes forward and its tab is
   * selected instead. One tab per document across the whole window: two
   * live copies of one file would be two editors with two undo histories,
   * each blind to the other's keystrokes.
   */
  const openView = useCallback((v: View) => {
    setDocPanes((prev) => {
      for (const pid of paneIdsRef.current) {
        const dp = prev[pid];
        const idx = dp ? dp.views.findIndex((x) => x.key === v.key) : -1;
        if (dp && idx >= 0) {
          setActivePane(pid);
          // refresh in place — a search jump carries a new line target
          const views = [...dp.views];
          views[idx] = v;
          return { ...prev, [pid]: { views, activeView: idx } };
        }
      }
      const pid = currentPaneRef.current;
      setActivePane(pid);
      const dp = prev[pid] ?? { views: [], activeView: 0 };
      return { ...prev, [pid]: { views: [...dp.views, v], activeView: dp.views.length } };
    });
  }, []);

  // an untitled buffer turns into a real file view once it's saved somewhere
  const replaceView = useCallback((paneId: string, idx: number, v: View) => {
    setDocPanes((prev) => {
      const dp = prev[paneId];
      if (!dp) return prev;
      return {
        ...prev,
        [paneId]: { ...dp, views: dp.views.map((old, i) => (i === idx ? v : old)) },
      };
    });
  }, []);

  /**
   * A file a tab is holding open was renamed, or thrown away.
   *
   * Renaming something you have open is an ordinary thing to do, and without
   * this the tab keeps the old path: it goes on showing the file's last
   * contents and fails the next time anything reads it, which is a bug that
   * only surfaces minutes later. So the views follow the file — including the
   * ones under a renamed *folder*, which is why this is a prefix test and not
   * an equality one. Trashed, and the tab goes with it; there is nothing left
   * for it to be a view of.
   *
   * Diffs are addressed by worktree plus relative path, so a rename inside the
   * worktree is the same rewrite with the root put back on afterwards.
   */
  useEffect(
    () =>
      onPathMoved((from, to) => {
        setDocPanes((prev) => {
          let touchedAny = false;
          const nextPanes: Record<string, DocPane> = {};
          for (const [pid, dp] of Object.entries(prev)) {
            let touched = false;
            const next: View[] = [];
            for (const v of dp.views) {
              if (v.kind === "file" && under(v.absPath, from)) {
                touched = true;
                if (to === null) continue;
                const moved = to + v.absPath.slice(from.length);
                next.push({ ...v, key: `file:${moved}`, absPath: moved });
              } else if (v.kind === "diff" && under(`${v.worktree}/${v.relPath}`, from)) {
                touched = true;
                if (to === null) continue;
                const moved = to + `${v.worktree}/${v.relPath}`.slice(from.length);
                // the same key the changes panel builds, or the tab would keep
                // an identity naming a path it no longer points at — and a
                // second click on that row would open a duplicate of it
                const rel = moved.slice(v.worktree.length + 1);
                const key = v.staged
                  ? `diff:staged:${v.worktree}:${rel}`
                  : `diff:${v.worktree}:${rel}`;
                next.push({ ...v, key, relPath: rel });
              } else {
                next.push(v);
              }
            }
            nextPanes[pid] = touched
              ? { views: next, activeView: Math.min(dp.activeView, Math.max(next.length - 1, 0)) }
              : dp;
            touchedAny ||= touched;
          }
          return touchedAny ? nextPanes : prev;
        });
      }),
    []
  );

  /**
   * Keep the diff tabs telling the truth about git.
   *
   * A file's two diffs are two tabs, and git actions move the file between
   * them: stage it and the unstaged diff empties in place — the A and B sides
   * now agree — while what you were reading moved to the staged diff, which
   * isn't open. So the tabs follow the file, on the same sweep the panel
   * reads (which is why the panel's rows never lead these tabs by a beat):
   *
   * - a diff whose file crossed to the other list becomes the other diff, in
   *   the same slot — unless that tab is already open, in which case the one
   *   now showing nothing closes and the live one is where the reading went;
   * - a diff whose file left the list entirely — committed, discarded, its
   *   worktree deleted — closes rather than sitting in the strip as a blank
   *   editor with a filename on it.
   *
   * The sweep only runs while a tab that reads git is open — a diff for the
   * reconciling, a file for its tab's tint below — and asks nothing the rest
   * of the time. Retargeting rewrites the view in place, so the active index
   * never moves under the cursor.
   */
  const hasGitTabs = Object.values(docPanes).some((dp) =>
    dp.views.some((v) => v.kind === "diff" || v.kind === "file")
  );
  const git = useGitStatus(project.root, active && hasGitTabs);

  // Cursor colours the tab of a modified-but-uncommitted file too — the same
  // hue and letter the tree's badge wears, read off the same sweep. Gathered
  // across every worktree, because a tab can hold a file from any of them.
  const tabMarks = useMemo(() => {
    const m = new Map<string, { mark: GitMark; letter: string }>();
    for (const wt of git.worktrees) {
      for (const [abs, v] of decorations(wt.path, wt.changes).files) m.set(abs, v);
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [git.epoch]);
  useEffect(() => {
    // epoch 0 is "nobody has looked yet", and an errored sweep is not a
    // statement that the files are gone — neither is grounds to close tabs
    if (git.epoch === 0 || git.error) return;
    const byWt = new Map(git.worktrees.map((w) => [w.path, w.changes]));
    setDocPanes((prev) => {
      const open = new Set(Object.values(prev).flatMap((d) => d.views.map((v) => v.key)));
      let touchedAny = false;
      const out: Record<string, DocPane> = {};
      for (const [pid, dp] of Object.entries(prev)) {
        let touched = false;
        let removedBefore = 0;
        const views: View[] = [];
        dp.views.forEach((v, i) => {
          if (v.kind !== "diff") {
            views.push(v);
            return;
          }
          const changes = byWt.get(v.worktree);
          // untracked entries don't count as a side: an untracked file has no
          // diff — it opens as a file — so a tab can neither stay for one nor
          // be carried onto one
          const side = (staged: boolean) =>
            changes?.find((c) => c.path === v.relPath && c.staged === staged && c.status !== "U");
          if (side(!!v.staged)) {
            views.push(v);
            return;
          }
          touched = true;
          const other = side(!v.staged);
          const key = v.staged
            ? `diff:${v.worktree}:${v.relPath}`
            : `diff:staged:${v.worktree}:${v.relPath}`;
          if (other && !open.has(key)) {
            open.delete(v.key);
            open.add(key);
            views.push({
              ...v,
              key,
              staged: !v.staged,
              // same rule as the panel's rows: a deletion has no origin to
              // point at, a move's HEAD side lives at the path it came from
              from: other.status === "D" ? undefined : other.moved ?? undefined,
            });
            return;
          }
          if (i < dp.activeView) removedBefore++;
        });
        out[pid] = touched
          ? {
              views,
              activeView: Math.min(
                Math.max(dp.activeView - removedBefore, 0),
                Math.max(views.length - 1, 0)
              ),
            }
          : dp;
        touchedAny ||= touched;
      }
      return touchedAny ? out : prev;
    });
  }, [git]);

  // ⌘E's second half, on its own so the right-click menus can reach it: walk
  // the tree open to this file and light its row. The keystroke works out
  // *which* file from the active tab; a menu already knows.
  const revealInTree = useCallback((abs: string) => {
    showSidebar();
    setSidebarTab("files");
    setReveal({ path: abs, n: revealCount.current++ });
  }, [showSidebar]);

  // a resolved path from a ⌘-click, in the terminal or in the editor
  const openFile = useCallback(
    (abs: string, line?: number) =>
      openView({ kind: "file", key: `file:${abs}`, absPath: abs, line }),
    [openView]
  );

  // files handed over from outside — dropped on the window, or opened with
  // zero from Finder. The App decided they belong to this project; queued
  // requests from before this mount drain on subscribe.
  useEffect(() => onProjectOpen(project.root, openFile), [project.root, openFile]);

  const reorderViews = useCallback((paneId: string, from: number, to: number) => {
    setDocPanes((prev) => {
      const dp = prev[paneId];
      if (!dp) return prev;
      if (from === to || from < 0 || to < 0 || from >= dp.views.length || to >= dp.views.length)
        return prev;
      return {
        ...prev,
        [paneId]: {
          views: moveItem(dp.views, from, to),
          activeView: movedIndex(dp.activeView, from, to),
        },
      };
    });
  }, []);

  /** a tab selected is a pane chosen: clicking a tab also makes its pane the
   *  one opens land in */
  const selectView = useCallback((paneId: string, i: number) => {
    setActivePane(paneId);
    setDocPanes((prev) =>
      prev[paneId] && prev[paneId].activeView !== i
        ? { ...prev, [paneId]: { ...prev[paneId], activeView: i } }
        : prev
    );
  }, []);

  /**
   * Carry one tab to another pane — the move the tab's menu offers. The tab
   * leaves one strip and lands selected at the end of the other, and the
   * pane it lands in becomes the one opens land in: moving a tab somewhere
   * is going there. A pane emptied by the move follows its last tab out
   * (the effect below).
   */
  const moveViewToPane = useCallback((fromPane: string, idx: number, toPane: string) => {
    if (fromPane === toPane || !docPanesRef.current[fromPane]?.views[idx]) return;
    setActivePane(toPane);
    setDocPanes((prev) => {
      const from = prev[fromPane];
      const view = from?.views[idx];
      if (!from || !view) return prev;
      const to = prev[toPane] ?? { views: [], activeView: 0 };
      const remaining = from.views.filter((_, i) => i !== idx);
      return {
        ...prev,
        [fromPane]: {
          views: remaining,
          activeView: Math.min(
            from.activeView > idx ? from.activeView - 1 : from.activeView,
            Math.max(remaining.length - 1, 0)
          ),
        },
        [toPane]: { views: [...to.views, view], activeView: to.views.length },
      };
    });
  }, []);

  /** a fresh pane split off this one, with this tab carried into it. Guarded
   *  behind a second tab — splitting a lone tab into a new pane would only
   *  close the pane it left, a shuffle wearing a split's name. */
  const openInNewPane = useCallback(
    (fromPane: string, idx: number, side: Side) => {
      if ((docPanesRef.current[fromPane]?.views.length ?? 0) < 2) return;
      moveViewToPane(fromPane, idx, tree.splitEditorPane(fromPane, side));
    },
    [moveViewToPane, tree.splitEditorPane]
  );

  /** where "Move to Next Pane" sends a tab: the pane after this one in tree
   *  order, wrapping */
  const moveViewToNextPane = useCallback(
    (fromPane: string, idx: number) => {
      const ids = paneIdsRef.current;
      const next = ids[(ids.indexOf(fromPane) + 1) % ids.length];
      if (next && next !== fromPane) moveViewToPane(fromPane, idx, next);
    },
    [moveViewToPane]
  );

  // A document pane follows its last tab out — closed, moved away, or its
  // file trashed from under it, the answer is the same, so it is given once
  // here rather than at every remover. Never the last pane standing: an
  // empty editor is the app's opening state, not a bug. One removal per
  // pass; the effect re-runs on the state it just changed.
  useEffect(() => {
    // a spared pane stops being spared the moment it holds something: from
    // here on it has a last tab, and losing it means the same as anywhere else
    for (const pid of bornEmpty) {
      if (docPanes[pid]?.views.length) bornEmpty.delete(pid);
    }
    if (paneIds.length < 2) return;
    const empty = paneIds.find(
      (pid) => (docPanes[pid]?.views.length ?? 0) === 0 && !bornEmpty.has(pid)
    );
    if (!empty) return;
    tree.removeEditorPane(empty);
    setDocPanes(({ [empty]: _gone, ...rest }) => rest);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docPanes, tree.root, tree.removeEditorPane]);

  // Closed tabs, newest last, with the slot — and now the pane — each one
  // held. Kept in a ref rather than in state: nothing renders from it, and a
  // stack that triggered a re-render on every close would re-render the whole
  // workspace to record something nobody is looking at. Bounded, because it
  // costs a View apiece and the twentieth undo of a close is not a thing
  // anyone reaches for.
  const closedRef = useRef<{ view: View; idx: number; paneId: string; seq: number }[]>([]);

  const closeView = useCallback((paneId: string, idx: number) => {
    setDocPanes((prev) => {
      const dp = prev[paneId];
      const gone = dp?.views[idx];
      if (!dp || !gone) return prev;
      closedRef.current.push({ view: gone, idx, paneId, seq: closeSeq() });
      if (closedRef.current.length > 20) closedRef.current.shift();
      const views = dp.views.filter((_, i) => i !== idx);
      return {
        ...prev,
        [paneId]: {
          views,
          activeView: Math.min(
            dp.activeView > idx ? dp.activeView - 1 : dp.activeView,
            Math.max(views.length - 1, 0)
          ),
        },
      };
    });
  }, []);

  /**
   * "Close Others" — everything but one, in one go, and all of it reopenable.
   *
   * Pushed onto the same stack in the order they were closed, so ⌘⇧T walks
   * back through them one at a time rather than treating the lot as one event.
   * That's the behaviour the stack already has for a run of ⌘W presses, and a
   * menu item is no different to a fast hand.
   */
  const closeOthers = useCallback((paneId: string, keep: number) => {
    setDocPanes((prev) => {
      const dp = prev[paneId];
      if (!dp || dp.views.length < 2) return prev;
      dp.views.forEach((view, i) => {
        if (i === keep) return;
        closedRef.current.push({ view, idx: i, paneId, seq: closeSeq() });
        if (closedRef.current.length > 20) closedRef.current.shift();
      });
      return { ...prev, [paneId]: { views: dp.views.filter((_, i) => i === keep), activeView: 0 } };
    });
  }, []);

  /**
   * ⌘⇧T — put back the tab you just closed, in the slot it was closed from.
   *
   * The slot rather than the end, because reopening is undoing: a tab that
   * comes back three places to the right of where it was is a second thing to
   * fix. It is clamped to the current length, since the tabs on its right may
   * have gone too.
   *
   * Anything already open is skipped rather than duplicated — reopen a file by
   * hand and its entry in the stack is spent, or ⌘⇧T would hand you the tab
   * you are standing on and look like it did nothing.
   */
  const peekClosed = useCallback(() => {
    const open = new Set(
      Object.values(docPanesRef.current).flatMap((d) => d.views.map((v) => v.key))
    );
    while (closedRef.current.length) {
      const top = closedRef.current[closedRef.current.length - 1];
      if (!open.has(top.view.key)) return top;
      closedRef.current.pop();
    }
    return null;
  }, []);

  const reopenClosed = useCallback(() => {
    const entry = peekClosed();
    if (!entry) return;
    closedRef.current.pop();
    // back into the pane it was closed from, while that pane still stands —
    // a tab whose pane went with it comes back to wherever opens land now
    const pid = paneIdsRef.current.includes(entry.paneId)
      ? entry.paneId
      : currentPaneRef.current;
    setActivePane(pid);
    setDocPanes((prev) => {
      const dp = prev[pid] ?? { views: [], activeView: 0 };
      const at = Math.min(entry.idx, dp.views.length);
      return {
        ...prev,
        [pid]: {
          views: [...dp.views.slice(0, at), entry.view, ...dp.views.slice(at)],
          activeView: at,
        },
      };
    });
  }, [peekClosed]);

  /**
   * ⌘⇧T undoes the last close, and a closed project is one of them.
   *
   * The two are remembered apart — tabs here, projects in the app above — so
   * they are compared by the ordinal both stamp their entries with and the
   * newer one wins. Without that the key would always drain this project's
   * tabs first, and a project shut by accident would sit behind however many
   * tabs you happened to have closed before it: the one close you actually
   * wanted back, reachable only by undoing a dozen you didn't.
   */
  const undoClose = useCallback(() => {
    const view = peekClosed();
    const project = lastClosedProjectRef.current;
    if (project !== null && (!view || project > view.seq)) onReopenProject();
    else reopenClosed();
  }, [peekClosed, reopenClosed, onReopenProject]);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey;
      const ctrl = e.ctrlKey;
      // The two keys that only exist while this project holds the mic: ⎋ throws
      // the recording away, space stops and starts the listening. Nothing else
      // in the app answers to either of them unmodified, and they last for the
      // length of a recording — which is the only window in which reaching for
      // a modifier is the wrong thing to ask of someone who is mid-sentence.
      // `preventDefault` matters twice here: it keeps space from scrolling a
      // panel, and it keeps space from pressing whichever of these buttons was
      // clicked last and still has focus, which would otherwise toggle twice.
      const rec = memosRef.current.recording;
      if (rec && !meta && !ctrl && !e.altKey && !typing(e)) {
        if (e.key === "Escape") {
          e.preventDefault();
          memosRef.current.cancel();
          return;
        }
        if (e.code === "Space") {
          e.preventDefault();
          if (rec.paused) memosRef.current.resume();
          else memosRef.current.pause();
          return;
        }
      }
      if (meta && !e.shiftKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        // a folded sidebar is shown, not hidden — ⌘B on it unfolds it
        if (sidebarCollapsed) showSidebar();
        else setSidebarVisible((v) => !v);
      } else if ((meta && e.key.toLowerCase() === "j" && !e.shiftKey) || (ctrl && e.code === "Backquote" && !e.shiftKey)) {
        e.preventDefault();
        setTerminalVisible((v) => !v);
      } else if (meta && !e.shiftKey && e.key.toLowerCase() === "w") {
        e.preventDefault();
        // ⌘W closes what the keyboard is in: a terminal when one has focus —
        // the undo for one ⌘T too many — and the active tab otherwise
        const termEl = e.target instanceof Element ? e.target.closest("[data-term-id]") : null;
        const termId = termEl?.getAttribute("data-term-id");
        if (termId) {
          tree.removePane(termId);
          return;
        }
        const pid = currentPaneRef.current;
        closeView(pid, docPanesRef.current[pid]?.activeView ?? 0);
      } else if (
        (meta && e.shiftKey && (e.code === "BracketLeft" || e.code === "BracketRight")) ||
        (ctrl && !meta && !e.altKey && e.code === "Tab")
      ) {
        // walk the active pane's tabs, wrapping at either end. By code, not
        // key: with shift held the character is { or }, and on plenty of
        // layouts not even that — the same reason Backquote and Backslash
        // below are matched this way. ⌃Tab and ⌃⇧Tab do the same walk — and
        // inside a terminal they walk the terminal panes instead, the same
        // gesture pointed at the thing the keyboard is already in.
        e.preventDefault();
        const termEl = e.target instanceof Element ? e.target.closest("[data-term-id]") : null;
        if (termEl && e.code === "Tab") {
          const cur = termEl.getAttribute("data-term-id") ?? "";
          const terms = leafIds(treeRef.current.root).filter(isTerm);
          if (terms.length > 1) {
            const dir = e.shiftKey ? -1 : 1;
            treeRef.current.setFocused(
              terms[(terms.indexOf(cur) + dir + terms.length) % terms.length]
            );
          }
          return;
        }
        const pid = currentPaneRef.current;
        const dp = docPanesRef.current[pid];
        if (dp && dp.views.length > 1) {
          const dir = e.code === "Tab" ? (e.shiftKey ? -1 : 1) : e.code === "BracketRight" ? 1 : -1;
          const at = (dp.activeView + dir + dp.views.length) % dp.views.length;
          setDocPanes((prev) =>
            prev[pid] ? { ...prev, [pid]: { ...prev[pid], activeView: at } } : prev
          );
        }
      } else if (meta && e.shiftKey && e.key.toLowerCase() === "t") {
        // ⌘⇧T, the way Cursor and VS Code spell it — and not ⌘⇧Tab, which
        // never arrives: macOS keeps that one for walking the app switcher
        // backwards and the window is never told it was pressed.
        e.preventDefault();
        undoClose();
      } else if (meta && e.key.toLowerCase() === "e") {
        // the tree opens on the file you're looking at, folders and all —
        // ⌘⇧E does it too, since that's the one people arrive with
        e.preventDefault();
        showSidebar();
        setSidebarTab("files");
        const dp = docPanesRef.current[currentPaneRef.current];
        const v = dp?.views[dp.activeView];
        const abs =
          v?.kind === "file" ? v.absPath : v?.kind === "diff" ? `${v.worktree}/${v.relPath}` : null;
        if (abs) revealInTree(abs);
      } else if (meta && e.shiftKey && (e.key.toLowerCase() === "f" || e.key.toLowerCase() === "h")) {
        // ⌘⇧F searches, ⌘⇧H arrives with the replace field already open — the
        // same split VS Code and Cursor make
        e.preventDefault();
        showSidebar();
        setSidebarTab("search");
        search.focus(e.key.toLowerCase() === "h");
      } else if (ctrl && e.shiftKey && e.key.toLowerCase() === "g") {
        e.preventDefault();
        showSidebar();
        setSidebarTab("scm");
      } else if (ctrl && e.shiftKey && e.key.toLowerCase() === "i") {
        // ⌃⇧I rather than ⌘⇧I: the ⌘ pair is the webview's own inspector, and
        // taking it would mean giving up devtools in the editor being built.
        // Silent when the integration is off, rather than opening a tab that
        // isn't in the rail.
        if (!getSettings().linear) return;
        e.preventDefault();
        showSidebar();
        setSidebarTab("issues");
      } else if (meta && e.shiftKey && e.key.toLowerCase() === "m") {
        e.preventDefault();
        showSidebar();
        setSidebarTab("memos");
      } else if ((ctrl && e.shiftKey && e.code === "Backquote") || (meta && !e.shiftKey && e.key.toLowerCase() === "t")) {
        e.preventDefault();
        setTerminalVisible(true);
        tree.newTerminal();
      } else if (meta && e.altKey && !e.shiftKey && e.code === "KeyN") {
        // The project's scratch note, opened at the end of whatever is already
        // in it — one note per project rather than one per press, because a
        // document you keep pasting into is the thing that was wanted and a
        // folder of `note-14.md` is the thing that gets abandoned.
        //
        // `code` and not `key`, like the Backquote and Backslash branches: ⌥N
        // is a dead key for the tilde, so `e.key` here is "Dead" and matching
        // on "n" would never fire.
        e.preventDefault();
        void api.noteOpen(project.root).then((abs) => {
          openView({ kind: "file", key: `file:${abs}`, absPath: abs });
          // the tab may have been open already, in which case opening it did
          // nothing and this is the whole of what the press meant
          goToNoteEnd(abs);
        });
      } else if (meta && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        untitledRef.current += 1;
        const n = untitledRef.current;
        openView({ kind: "new", key: `new:${project.root}:${n}`, name: `untitled-${n}` });
      } else if (meta && !e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setQuickOpen((v) => !v);
        // `code`, not `key`: with shift held the character is `|`, so matching
        // on `e.key === "\\"` skipped the whole branch and split-down never
        // fired. Same reason the terminal toggle above matches Backquote.
      } else if (meta && e.code === "Backslash") {
        e.preventDefault();
        setTerminalVisible(true);
        tree.splitFocused(e.shiftKey ? "col" : "row");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    active,
    closeView,
    undoClose,
    openView,
    project.root,
    search.focus,
    tree.newTerminal,
    tree.splitFocused,
    tree.removePane,
    sidebarCollapsed,
    showSidebar,
  ]);

  // ref-like holders so the key handler and the open/move callbacks don't
  // rebind on every keystroke's worth of state
  const docPanesRef = useStateRef(docPanes);
  const paneIdsRef = useStateRef(paneIds);
  const treeRef = useStateRef(tree);
  const currentPaneRef = useStateRef(currentPane);
  const lastClosedProjectRef = useStateRef(lastClosedProject);
  // and one for the memos, for a stronger version of the same reason: this
  // object is rebuilt on every tick of the elapsed timer, so a handler that
  // closed over it would be torn down and rebound twice a second for the whole
  // of a recording — during the one gesture that has to stay responsive
  const memosRef = useStateRef(memos);

  // Which memo the list should draw as selected. Derived here rather than in the
  // panel because "selected" means "this is the thread you are reading", and
  // what you are reading is a fact about the editor's tabs — which the workspace
  // owns and the sidebar has never been told about. The alternative was handing
  // the panel the view list so it could work out the same answer, which is a
  // panel that knows what a tab is in order to draw a background. With panes
  // plural, "reading" means the active pane's active tab — a thread visible in
  // an unfocused pane is on screen, but it isn't where you are.
  const shownDocs = paneDocs(currentPane);
  const shown = shownDocs.views[shownDocs.activeView];
  const activeMemo = shown?.kind === "memo" ? shown.id : null;

  const rootRef = useRef<HTMLDivElement>(null);

  // ----- the fold, held in pixels -----
  // The folded sidebar's card: 4px, the 28px run of icons, and no room on the
  // right — the float gap alone is the right-hand margin, which is what
  // reads as even against the page's own inset beside it.
  // Its slot is this plus the float gap, and the share written into the
  // tree is whatever that comes to at the split's current width.
  const RAIL_PX = 32;
  const treeRootRef = useRef(tree.root);
  treeRootRef.current = tree.root;
  /** what the last render hid, for the pin to draw the tree the same way */
  const hiddenIdsRef = useRef<Set<string>>(new Set());
  /** the split the sidebar sits in, and where in it */
  const sidebarSplit = useCallback(() => {
    const path = pathOf(treeRootRef.current, SIDEBAR);
    if (!path || path.length === 0) return null;
    const parentPath = path.slice(0, -1);
    const parent = nodeAt(treeRootRef.current, parentPath);
    if (!parent || parent.type !== "split") return null;
    return { parentPath, parent, idx: path[path.length - 1], sizes: sizesOf(parent) };
  }, []);
  /** give the sidebar this share of its split; its siblings scale to fit */
  const setSidebarShare = useCallback(
    (want: number) => {
      const sp = sidebarSplit();
      if (!sp) return;
      const { parentPath, idx, sizes } = sp;
      if (Math.abs(sizes[idx] - want) < 0.0005) return;
      const rest = 1 - sizes[idx];
      const next = sizes.map((v, i) =>
        i === idx ? want : rest > 0 ? (v * (1 - want)) / rest : (1 - want) / (sizes.length - 1)
      );
      tree.setSizes(parentPath, next);
    },
    [sidebarSplit, tree.setSizes]
  );
  /** Hold the folded sidebar at RAIL_PX, whatever the window is doing.
   *  Read off the rects the tree draws rather than the tree's raw shares:
   *  a share is renormalised among the *visible* siblings when drawn (see
   *  collectRects), so a hidden terminal in the same split stretches the
   *  sidebar past whatever share a calculation handed it. The drawn rect
   *  says how far off it is, and the share is scaled by that — one step,
   *  since the mapping is linear. Not read off the DOM: panes glide to
   *  their seats over 160ms, and a width measured mid-glide fed back into
   *  the share is a loop that runs the sidebar down to nothing. */
  const pinSidebar = useCallback(() => {
    const root = rootRef.current;
    const sp = sidebarSplit();
    if (!root || !sp) return;
    const drawn: { id: string; rect: Rect }[] = [];
    collectRects(treeRootRef.current, FIELD, [], hiddenIdsRef.current, drawn, []);
    const r = drawn.find((p) => p.id === SIDEBAR)?.rect;
    if (!r) return;
    const rr = root.getBoundingClientRect();
    const actual = sp.parent.dir === "row" ? (rr.width * r.w) / 100 : (rr.height * r.h) / 100;
    const gap = parseFloat(getComputedStyle(root).getPropertyValue("--float-gap")) || 8;
    const target = RAIL_PX + gap;
    if (!(actual > 0) || Math.abs(actual - target) < 0.5) return;
    setSidebarShare(Math.min(Math.max(sp.sizes[sp.idx] * (target / actual), 0.01), 0.5));
  }, [sidebarSplit, setSidebarShare]);
  // the fold remembers the share it took, so the unfold can give it back
  const foldSidebar = useCallback(() => {
    const sp = sidebarSplit();
    if (sp) sidebarShare.current = sp.sizes[sp.idx];
    setSidebarCollapsed(true);
  }, [sidebarSplit]);
  const wasCollapsed = useRef(sidebarCollapsed);
  useEffect(() => {
    if (sidebarCollapsed) pinSidebar();
    else if (wasCollapsed.current) {
      // a remembered share, or a usable one if the fold never got to
      // remember it — an unfold to a sliver is not an unfold
      const back = sidebarShare.current;
      setSidebarShare(back != null && back >= 0.05 ? back : 0.2);
    }
    wasCollapsed.current = sidebarCollapsed;
  }, [sidebarCollapsed, pinSidebar, setSidebarShare]);
  // a share is a fraction of the window; the rail is not, so every resize
  // re-pins it — and so does every change to the tree or to what is hidden
  // in it, since either moves the renormalisation the pin corrects for
  useEffect(() => {
    const root = rootRef.current;
    if (!sidebarCollapsed || !root) return;
    pinSidebar();
    const watch = new ResizeObserver(() => pinSidebar());
    watch.observe(root);
    return () => watch.disconnect();
  }, [sidebarCollapsed, pinSidebar, terminalVisible]);

  // ----- carrying a pane -----
  // Same gesture for every pane — a terminal, the editor, the sidebar: pick
  // it up by the pill at its top and carry it. The feedback is the drop's own
  // nature, the way the Claude app does it. Aiming a re-seat — a drop along
  // the axis of the split the target already lives in — slides the other
  // panes into the layout the drop would make, live and animated: the gap
  // that opens is the seat. Aiming a true split — a drop across that axis —
  // draws a single accent line along the edge it would cut, and nothing
  // moves until release. ⎋ puts everything back.

  const [draggingId, setDraggingId] = useState<string | null>(null);
  /** the tree as the drop would leave it, worn live while a re-seat is
   *  aimed — the preview and the drop are the same computation. Every pane's
   *  committed rect stays frozen for the length of the drag; this tree shows
   *  itself as per-pane transforms over them (previewShift below), so a
   *  frame of preview costs the compositor a slide and the layout engine
   *  nothing at all — no reflow, no terminal refit, no repaint of text. */
  const [previewRoot, setPreviewRoot] = useState<LayoutNode | null>(null);
  /** the line a split shows, along the edge of the pane it would cut */
  const [splitHint, setSplitHint] = useState<{ rect: Rect; side: Side } | null>(null);
  /** the pill under the pointer, for the panes that arm here — the sidebar
   *  and every document pane (terminals arm their own). Armed by proximity
   *  rather than :hover so the pill never takes the pointer at rest from
   *  the tabs and icons it floats over. */
  const [grabArmed, setGrabArmed] = useState<string | null>(null);
  // locking while a pill happens to be lit must put it out — the mousemove
  // that armed it is gated from then on and would never disarm it
  useEffect(() => {
    if (locked) setGrabArmed(null);
  }, [locked]);

  /** the live divider drag's painter, while one is in hand (see
   *  startDividerResize) — re-run after every render, because a render that
   *  lands mid-drag writes the committed sizes back over the ones the hand is
   *  holding, and a hand that has stopped moving sends nothing to correct it */
  const livePaint = useRef<(() => void) | null>(null);
  useEffect(() => {
    livePaint.current?.();
  });

  // ----- the layout, drawn -----
  // One tree, one absolute field. Hidden panes stay leaves — the sidebar
  // toggled away, every terminal while ⌘J holds — and simply get no rect:
  // their siblings renormalise into the room, and everything comes back to
  // its own seat because nothing ever left the tree. The rects always come
  // from the committed tree — a drag freezes them by never committing until
  // the drop — and an aimed re-seat rides on top as transforms.
  const hiddenIds = new Set<string>();
  if (!sidebarVisible) hiddenIds.add(SIDEBAR);
  hiddenIdsRef.current = hiddenIds;
  const termIds = leafIds(tree.root).filter(isTerm);
  if (!terminalVisible) for (const id of termIds) hiddenIds.add(id);

  const panes: { id: string; rect: Rect }[] = [];
  const dividers: Divider[] = [];
  collectRects(tree.root, FIELD, [], hiddenIds, panes, dividers);
  const rectOf = (id: string) => panes.find((p) => p.id === id)?.rect ?? null;
  /** where the aimed drop would put each pane, while one is aimed */
  const previewPanes: { id: string; rect: Rect }[] | null = previewRoot ? [] : null;
  if (previewRoot && previewPanes)
    collectRects(previewRoot, FIELD, [], hiddenIds, previewPanes, []);
  /**
   * The preview, worn as a slide: the distance from a pane's frozen rect to
   * its place in the aimed layout, as a translate in percentages of the
   * pane's own box — so nothing is ever measured back off the DOM. Same-axis
   * re-seats preserve every size, so for them this slide is the exact
   * layout; a seat in a foreign split only approximates until the drop
   * (sizes stay pinned mid-drag, so a target giving ground may overlap its
   * neighbour a little while the gap opens). The carried card is never
   * shifted — it rides the pointer, and its seat is the gap the others leave.
   */
  const previewShift = (id: string): string | undefined => {
    if (!previewPanes || id === draggingId) return undefined;
    const at = rectOf(id);
    const to = previewPanes.find((p) => p.id === id)?.rect;
    if (!at || !to) return undefined;
    const tx = ((to.x - at.x) / at.w) * 100;
    const ty = ((to.y - at.y) / at.h) * 100;
    if (Math.abs(tx) < 0.01 && Math.abs(ty) < 0.01) return undefined;
    return `translate(${tx}%, ${ty}%)`;
  };
  // `--px` … `--ph` are the slot's rect as bare numbers, for the one thing
  // inside a pane that places itself against the window rather than the
  // pane: the empty editor's mark (see .editor-empty in main-column.css)
  const paneStyle = (rect: Rect | null, shift?: string): React.CSSProperties =>
    rect
      ? ({
          left: `${rect.x}%`,
          top: `${rect.y}%`,
          width: `${rect.w}%`,
          height: `${rect.h}%`,
          transform: shift,
          "--px": rect.x,
          "--py": rect.y,
          "--pw": rect.w,
          "--ph": rect.h,
        } as React.CSSProperties)
      : { display: "none" };
  // stable order, never tree order: re-seating a pane must not reorder the
  // keyed siblings, or React would move live terminal DOM around the tree
  const termPanes = [...termIds]
    .sort()
    .map((id) => ({ id, rect: rectOf(id), shift: previewShift(id) }));

  /**
   * What a drop at this point would do. Targets are measured against the
   * layout as it stood when the card was picked up — never against the
   * preview sliding under the pointer, which would chase its own feedback.
   *
   * Re-seats answer early: hovering a direct sibling swaps across it the
   * moment the pointer arrives (which side of it you came from already says
   * where you're going), and a foreign pane seats by its midline. True
   * splits — drops across the target's own axis — live in narrow bands
   * along the crossing edges, so they are asked for deliberately rather
   * than tripped over. Window-edge strips aim at the root.
   */
  const targetAt = (
    cx: number,
    cy: number,
    dragged: string,
    dRect: Rect,
    base: { id: string; rect: Rect }[],
    travelX: number,
    travelY: number
  ):
    | { op: "pane"; targetId: string; side: Side; seat: boolean; ratio: number; rect: Rect }
    | { op: "root"; side: Side; seat: boolean; extent: number; rect: Rect }
    | null => {
    const root = rootRef.current;
    if (!root) return null;
    const rr = root.getBoundingClientRect();
    const fx = clamp(cx - rr.left, 0, rr.width);
    const fy = clamp(cy - rr.top, 0, rr.height);
    const whole: Rect = { x: 0, y: 0, w: 100, h: 100 };
    const edge = Math.min(fx, rr.width - fx, fy, rr.height - fy);
    if (edge < EDGE_STRIP) {
      const side: Side =
        edge === fx ? "left" : edge === rr.width - fx ? "right" : edge === fy ? "up" : "down";
      const axis = side === "left" || side === "right" ? "row" : "col";
      const seat = tree.root.type === "split" && tree.root.dir === axis;
      const extent = (axis === "row" ? dRect.w : dRect.h) / 100;
      return { op: "root", side, seat, extent, rect: whole };
    }
    const px = (fx / rr.width) * 100;
    const py = (fy / rr.height) * 100;
    const hit = base.find(
      (p) =>
        p.id !== dragged &&
        px >= p.rect.x &&
        px < p.rect.x + p.rect.w &&
        py >= p.rect.y &&
        py < p.rect.y + p.rect.h
    );
    if (!hit) return null;
    const pdir = parentDirOf(tree.root, hit.id);
    // pixel geometry of the hovered pane, for bands and midlines
    const wPx = (hit.rect.w / 100) * rr.width;
    const hPx = (hit.rect.h / 100) * rr.height;
    const inX = fx - (hit.rect.x / 100) * rr.width;
    const inY = fy - (hit.rect.y / 100) * rr.height;
    if (!pdir) {
      // a lone pane: there is nothing to seat beside, every edge is a split
      const m = Math.min(inX, wPx - inX, inY, hPx - inY);
      const side: Side =
        m === inX ? "left" : m === wPx - inX ? "right" : m === inY ? "up" : "down";
      return { op: "pane", targetId: hit.id, side, seat: false, ratio: 0.5, rect: hit.rect };
    }
    // Split bands arm only once the hand has actually travelled across the
    // axis. Every drag starts at a pane's top pill, so a level slide into a
    // neighbour skims its top band the whole way — and a level slide means
    // reorder, not split. Real splits arrive crosswise, and those get the
    // bands at full size.
    const band = (cross: number) =>
      Math.min(Math.max(cross * SPLIT_BAND, SPLIT_BAND_MIN), SPLIT_BAND_MAX);
    if (pdir === "row") {
      const b = Math.abs(travelY) > CROSS_ARM ? band(hPx) : 0;
      if (b > 0 && (inY < b || inY > hPx - b)) {
        const side: Side = inY < b ? "up" : "down";
        return { op: "pane", targetId: hit.id, side, seat: false, ratio: 0.5, rect: hit.rect };
      }
      const pre = precedes(tree.root, dragged, hit.id);
      const side: Side = pre === true ? "right" : pre === false ? "left" : inX < wPx / 2 ? "left" : "right";
      return {
        op: "pane",
        targetId: hit.id,
        side,
        seat: true,
        ratio: dRect.w / (dRect.w + hit.rect.w),
        rect: hit.rect,
      };
    }
    const b = Math.abs(travelX) > CROSS_ARM ? band(wPx) : 0;
    if (b > 0 && (inX < b || inX > wPx - b)) {
      const side: Side = inX < b ? "left" : "right";
      return { op: "pane", targetId: hit.id, side, seat: false, ratio: 0.5, rect: hit.rect };
    }
    const pre = precedes(tree.root, dragged, hit.id);
    const side: Side = pre === true ? "down" : pre === false ? "up" : inY < hPx / 2 ? "up" : "down";
    return {
      op: "pane",
      targetId: hit.id,
      side,
      seat: true,
      ratio: dRect.h / (dRect.h + hit.rect.h),
      rect: hit.rect,
    };
  };

  const startPaneDrag = (e: React.MouseEvent, id: string) => {
    if (e.button !== 0 || locked) return;
    e.preventDefault();
    const root = rootRef.current;
    const card = root?.querySelector<HTMLElement>(`[data-pane-id="${id}"]`);
    if (!root || !card) return;
    // the zones and the pin come from the settled layout, before any preview
    const base: { id: string; rect: Rect }[] = [];
    collectRects(tree.root, FIELD, [], hiddenIds, base, []);
    const pin = base.find((p) => p.id === id)?.rect ?? null;
    if (!pin) return;
    const sx = e.clientX;
    const sy = e.clientY;
    // nothing happens until the pointer has clearly left the press — a click
    // with a shake in it must not send a card an inch into the air
    let live = false;
    let target: ReturnType<typeof targetAt> = null;
    let lastKey = "";

    const move = (ev: MouseEvent) => {
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      if (!live) {
        if (Math.hypot(dx, dy) < DRAG_START) return;
        live = true;
        document.body.classList.add("dragging-panel");
        setDraggingId(id);
      }
      card.style.transform = `translate(${dx}px, ${dy}px)`;
      target = targetAt(ev.clientX, ev.clientY, id, pin, base, dx, dy);
      const key = target
        ? `${target.op}:${target.op === "pane" ? target.targetId : ""}:${target.side}:${target.seat}`
        : "";
      if (key === lastKey) return;
      lastKey = key;
      if (!target) {
        setPreviewRoot(null);
        setSplitHint(null);
      } else if (target.seat) {
        setSplitHint(null);
        setPreviewRoot(
          target.op === "pane"
            ? seatedLeaf(tree.root, id, target.targetId, target.side, target.ratio)
            : seatedLeafAtRoot(tree.root, id, target.side, target.extent)
        );
      } else {
        setPreviewRoot(null);
        setSplitHint({ rect: target.rect, side: target.side });
      }
    };
    const finish = (apply: boolean) => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      window.removeEventListener("keydown", key, true);
      document.body.classList.remove("dragging-panel");
      const from = live ? card.getBoundingClientRect() : null;
      // every other pane's visual rect too, read before the tree commits:
      // the preview slides are mid-glide, and where a pane is seen is where
      // its landing has to start from
      const others: [HTMLElement, DOMRect][] = from
        ? Array.from(root.querySelectorAll<HTMLElement>("[data-pane-id]"))
            .filter((el) => el !== card)
            .map((el) => [el, el.getBoundingClientRect()])
        : [];
      // one synchronous commit: the tree, the preview and the class all
      // land before the next paint, so there is no frame where the card is
      // half one thing and half the other
      flushSync(() => {
        setDraggingId(null);
        setPreviewRoot(null);
        setSplitHint(null);
        if (apply && live && target) {
          if (target.op === "pane") {
            if (target.seat) tree.seatLeaf(id, target.targetId, target.side, target.ratio);
            else tree.moveLeaf(id, target.targetId, target.side);
          } else if (target.seat) {
            tree.seatLeafAtRoot(id, target.side, target.extent);
          } else {
            tree.moveLeafToRoot(id, target.side);
          }
        }
      });
      // Land everything from exactly where it was seen. The DOM now wears
      // the committed rects — that one commit is the drop's only layout —
      // and each pane replays its visual position over its new seat (FLIP)
      // and releases, so the whole landing is a set of transform glides the
      // layout engine never hears about. The card that settles is the card
      // that was carried — one glide, no swap of a ghost for an original.
      if (from) {
        card.style.transition = "none";
        card.style.transform = "";
        for (const [el] of others) el.style.transition = "none";
        const to = card.getBoundingClientRect();
        const flips: [HTMLElement, number, number][] = [];
        for (const [el, was] of others) {
          const now = el.getBoundingClientRect();
          const dx = was.left - now.left;
          const dy = was.top - now.top;
          if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) flips.push([el, dx, dy]);
        }
        card.style.transform = `translate(${from.left - to.left}px, ${from.top - to.top}px)`;
        for (const [el, dx, dy] of flips) el.style.transform = `translate(${dx}px, ${dy}px)`;
        const resized = Math.abs(from.width - to.width) > 1 || Math.abs(from.height - to.height) > 1;
        const pw = card.style.width;
        const ph = card.style.height;
        if (resized) {
          // the one landing that is a resize glides between its two sizes
          // as itself; its terminal's refit waits at the far end (the
          // .landing gate in Terminals), so the text holds still and the
          // card clips until it settles
          card.classList.add("landing");
          card.style.width = `${from.width}px`;
          card.style.height = `${from.height}px`;
        }
        void card.offsetWidth;
        card.style.transition = "";
        card.style.transform = "";
        for (const [el] of others) el.style.transition = "";
        for (const [el] of flips) el.style.transform = "";
        if (resized) {
          card.style.width = `${to.width}px`;
          card.style.height = `${to.height}px`;
          // back to the layout's own percentages once the glide is done
          window.setTimeout(() => {
            card.style.width = pw;
            card.style.height = ph;
            card.classList.remove("landing");
          }, 200);
        }
      } else {
        card.style.transform = "";
      }
    };
    const up = () => finish(true);
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      finish(false);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    window.addEventListener("keydown", key, true);
  };

  /**
   * Drag a seam to change how two visible neighbours share their split.
   * Shares are recomputed from the sizes captured at mousedown, so a long
   * gesture can't accumulate rounding drift. Everything is stored shares of
   * the full split — hidden siblings keep holding theirs — so the pointer's
   * travel across the visible span converts through visSum on the way in.
   */
  const startDividerResize = (e: React.MouseEvent, d: Divider) => {
    const root = rootRef.current;
    const node = nodeAt(tree.root, d.path);
    if (!root || !node || node.type !== "split") return;
    e.preventDefault();
    // only the divider in hand lights
    const handle = e.currentTarget as HTMLElement;
    handle.classList.add("live");
    const base = sizesOf(node);
    const rr = root.getBoundingClientRect();
    const span = d.dir === "row" ? (rr.width * d.host.w) / 100 : (rr.height * d.host.h) / 100;
    if (span <= 0) return;
    // neither side may be squeezed below a usable pane
    const min = Math.min(0.15, 60 / span) * d.visSum;
    const start = d.dir === "row" ? e.clientX : e.clientY;
    const axis = d.dir === "row" ? rr.width : rr.height;

    const sizesFor = (step: number) => {
      const next = [...base];
      next[d.li] = base[d.li] + step;
      next[d.ri] = base[d.ri] - step;
      return next;
    };

    /*
      ----- seams snap into line -----

      A seam brought within SEAM_SNAP px of another seam running the same way
      takes its line exactly: drag the bottom terminals' top edge near the
      split in the column beside them and the two become one rule across the
      window rather than two a few pixels apart.

      Both seams are usually moving. Raising the floor shortens the column the
      other seam divides, so that seam rises too — at its own rate, which is
      why "move it by the gap" would overshoot. Every seam's position is affine
      in the step (the sizes are, and collectRects is a linear pass over them),
      so one probe step gives the rate the gap closes at and the meeting point
      is solved for rather than hunted for. Out of reach of the clamps, or a
      partner keeping perfect pace, and there is nothing to take.
    */
    const seamPos = (step: number) => {
      const rects: { id: string; rect: Rect }[] = [];
      const seams: Divider[] = [];
      collectRects(withSizes(tree.root, d.path, sizesFor(step)), FIELD, [], hiddenIds, rects, seams);
      const out = new Map<string, number>();
      for (const s of seams) {
        if (s.dir !== d.dir) continue;
        const at = s.dir === "row" ? s.host.x + s.host.w * s.at : s.host.y + s.host.h * s.at;
        out.set(seamKey(s), (at / 100) * axis);
      }
      return out;
    };
    const me = seamKey(d);
    const probe = d.visSum / span; // a step worth one pixel of travel
    const snap = (step: number, lo: number, hi: number) => {
      const here = seamPos(step);
      const mine = here.get(me);
      if (mine === undefined) return { step, onto: null as string | null };
      let key: string | null = null;
      let gap = SEAM_SNAP;
      for (const [k, p] of here) {
        if (k === me || Math.abs(p - mine) > Math.abs(gap)) continue;
        key = k;
        gap = p - mine;
      }
      if (key === null) return { step, onto: null as string | null };
      const then = seamPos(step + probe);
      const rate = ((then.get(key) ?? 0) - (then.get(me) ?? 0) - gap) / probe;
      const want = step - gap / rate;
      if (!Number.isFinite(want) || want < lo || want > hi) return { step, onto: null as string | null };
      return { step: want, onto: key };
    };
    /** the partner's own handle lights too, so which line was taken is
     *  visible rather than inferred from the panes */
    let onto: string | null = null;
    const mark = (next: string | null) => {
      if (next === onto) return;
      const pill = (k: string | null) =>
        k ? root.querySelector<HTMLElement>(`[data-seam="${CSS.escape(k)}"]`) : null;
      pill(onto)?.classList.remove("aligned");
      pill(next)?.classList.add("aligned");
      handle.classList.toggle("snapped", next !== null);
      onto = next;
    };

    /*
      The gesture paints itself, and the tree hears about it once.

      Going through setSizes per mousemove re-rendered the entire workspace —
      the sidebar's file tree, every editor's tab strip, every terminal card —
      and a trackpad sends moves faster than the display can show them, so some
      frames paid for that two and three times over. Yet a resize can only ever
      change where the pane boxes and the seams sit: the rects are a pure
      function of the tree (collectRects, the same call the render makes), and
      nothing else in the render reads sizes at all. So the drag writes those
      boxes directly and calls setSizes on mouseup, where one render hands the
      numbers back to React — the same numbers, so nothing moves at the
      handover.
    */
    let sizes = base;
    let raf = 0;
    const paint = () => {
      raf = 0;
      const rects: { id: string; rect: Rect }[] = [];
      const seams: Divider[] = [];
      collectRects(withSizes(tree.root, d.path, sizes), FIELD, [], hiddenIds, rects, seams);
      for (const { id, rect } of rects) {
        const box = root.querySelector<HTMLElement>(`[data-pane-id="${CSS.escape(id)}"]`);
        if (!box) continue;
        box.style.left = `${rect.x}%`;
        box.style.top = `${rect.y}%`;
        box.style.width = `${rect.w}%`;
        box.style.height = `${rect.h}%`;
      }
      for (const s of seams) {
        const seam = root.querySelector<HTMLElement>(`[data-seam="${CSS.escape(seamKey(s))}"]`);
        if (seam) Object.assign(seam.style, seamStyle(s));
      }
    };
    // a render landing mid-drag — a terminal taking focus, a status poll —
    // would write the committed sizes back over the ones the hand is holding,
    // and with the mouse standing still nothing would put them right again
    livePaint.current = paint;

    const move = (ev: MouseEvent) => {
      const travelled = (d.dir === "row" ? ev.clientX : ev.clientY) - start;
      const delta = (travelled / span) * d.visSum;
      // floored at zero, because a pane already narrower than the minimum
      // makes its side's room negative — and a negative floor inverts the
      // clamp, forcing a step the other pane can't pay for. That wrote a share
      // of zero or less, which the next launch reads as a size it can't trust
      // (see validTree) and answers by resizing the panes around it too.
      const room = { back: Math.max(base[d.li] - min, 0), fwd: Math.max(base[d.ri] - min, 0) };
      const step = Math.max(-room.back, Math.min(room.fwd, delta));
      // ⌥ hands over the raw step: the one gesture snapping can't be asked
      // to stay out of the way for is landing just shy of another seam
      const taken = ev.altKey ? { step, onto: null } : snap(step, -room.back, room.fwd);
      mark(taken.onto);
      sizes = sizesFor(taken.step);
      // one paint per frame, however many moves the mouse crowds into it
      if (!raf) raf = window.requestAnimationFrame(paint);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      if (raf) window.cancelAnimationFrame(raf);
      livePaint.current = null;
      mark(null);
      handle.classList.remove("live");
      document.body.classList.remove("dragging-col", "dragging-row");
      if (sizes !== base) tree.setSizes(d.path, sizes);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    document.body.classList.add(d.dir === "row" ? "dragging-col" : "dragging-row");
  };

  /** the arming mousemove for a wrapper whose pill lives here — the
   *  sidebar's and each document pane's; `reach` ducks under whatever chrome
   *  the card keeps at its top (a document pane's tabs sit lower than the
   *  sidebar's icon strip) */
  const armWrapper = (kind: string, reach: number) => (e: React.MouseEvent) => {
    if (draggingId || locked) return;
    const r = e.currentTarget.getBoundingClientRect();
    const grab = e.clientY - r.top < reach && Math.abs(e.clientX - (r.left + r.width / 2)) < 32;
    setGrabArmed((cur) => (grab ? kind : cur === kind ? null : cur));
  };
  const disarmWrapper = (kind: string) => () =>
    setGrabArmed((cur) => (cur === kind ? null : cur));

  return (
    <div ref={rootRef} className={`workspace ${active ? "" : "inactive"}`}>
      {sidebarVisible && (
        <div
          className={`pane-abs ${draggingId === SIDEBAR ? "moving" : ""}`}
          data-pane-id={SIDEBAR}
          style={paneStyle(rectOf(SIDEBAR), previewShift(SIDEBAR))}
          onMouseMove={armWrapper("sidebar", 14)}
          onMouseLeave={disarmWrapper("sidebar")}
        >
          <div
            className={`pane-grab ${grabArmed === "sidebar" ? "armed" : ""} ${
              draggingId === SIDEBAR ? "live" : ""
            }`}
            title="move sidebar"
            onMouseDown={(e) => startPaneDrag(e, SIDEBAR)}
          />
          <Sidebar
            project={project}
            tab={sidebarTab}
            onTab={(t) => {
              setSidebarTab(t);
              // an icon on the folded rail is a request for its panel
              if (sidebarCollapsed) showSidebar();
            }}
            collapsed={sidebarCollapsed}
            onOpenView={openView}
            active={active}
            search={search}
            memos={memos}
            activeMemo={activeMemo}
            activeKey={shown?.key ?? null}
            reveal={reveal}
            onRevealInTree={revealInTree}
            onCollapse={foldSidebar}
            onExpand={showSidebar}
          />
        </div>
      )}
      {/* every document pane, rendered in an order that never changes with
          the layout — the terminals' own rule — so re-seating panes never
          walks live editor DOM around the tree. A mousedown anywhere in a
          pane makes it the one opens land in; capture, so the choosing isn't
          at the mercy of what was clicked. */}
      {[...paneIds].sort().map((pid) => (
        <div
          key={pid}
          className={`pane-abs main-col ${draggingId === pid ? "moving" : ""}`}
          data-pane-id={pid}
          style={paneStyle(rectOf(pid), previewShift(pid))}
          onMouseMove={armWrapper(pid, 12)}
          onMouseLeave={disarmWrapper(pid)}
          onMouseDownCapture={() => setActivePane(pid)}
        >
          <div
            className={`pane-grab ${grabArmed === pid ? "armed" : ""} ${
              draggingId === pid ? "live" : ""
            }`}
            title="move editor"
            onMouseDown={(e) => startPaneDrag(e, pid)}
          />
          <EditorPane
            views={paneDocs(pid).views}
            activeView={paneDocs(pid).activeView}
            focused={pid === currentPane}
            panes={paneIds.length}
            onSelect={(i) => selectView(pid, i)}
            onClose={(i) => closeView(pid, i)}
            onCloseOthers={(i) => closeOthers(pid, i)}
            onReplace={(i, v) => replaceView(pid, i, v)}
            onReorder={(from, to) => reorderViews(pid, from, to)}
            onMoveToNewPane={(i, side) => openInNewPane(pid, i, side)}
            onMoveToNextPane={(i) => moveViewToNextPane(pid, i)}
            onOpenFile={openFile}
            onRevealInTree={revealInTree}
            root={project.root}
            gitMarks={tabMarks}
            // a memo tab draws its own live title and records its own
            // follow-ups, both of which are this object
            memos={memos}
          />
        </div>
      ))}
      <TerminalPanes
        tree={tree}
        panes={termPanes}
        active={active}
        locked={locked}
        draggingId={draggingId}
        onPaneDragStart={startPaneDrag}
        onOpenFile={openFile}
      />
      {/* one divider per visible seam of the tree */}
      {dividers.map((d) => (
        <div
          key={seamKey(d)}
          data-seam={seamKey(d)}
          className={`term-divider ${d.dir}`}
          style={seamStyle(d)}
          onMouseDown={(e) => startDividerResize(e, d)}
        />
      ))}
      {/* the line a true split shows, along the edge it would cut — re-seats
          need no mark: the layout itself rearranges live under the hand */}
      {splitHint && <div className={`split-hint ${splitHint.side}`} style={paneStyle(splitHint.rect)} />}
      {quickOpen && (
        <QuickOpen
          root={project.root}
          onClose={() => setQuickOpen(false)}
          onPick={(rel) => {
            setQuickOpen(false);
            openView({ kind: "file", key: `file:${project.root}/${rel}`, absPath: `${project.root}/${rel}` });
          }}
        />
      )}
    </div>
  );
});

function useStateRef<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
