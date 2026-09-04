import { useEffect, useState } from "react";
import { api, FileChange, Worktree } from "./api";

export interface WorktreeChanges extends Worktree {
  changes: FileChange[];
  /** which of the project's folders this worktree was found from. Set only by
   *  `useGitStatusMany`, where several folders' worktrees share one list and
   *  "the main worktree" is no longer a question with one answer. */
  owner?: string;
}

export interface GitSnapshot {
  worktrees: WorktreeChanges[];
  error: string | null;
  /** bumped per completed sweep, so "nothing has changed" is distinguishable
      from "nobody has looked yet" */
  epoch: number;
}

const EMPTY: GitSnapshot = { worktrees: [], error: null, epoch: 0 };

/**
 * How much of the clock git is allowed. A sweep is one `git worktree list` plus
 * a `git status` per worktree; on this repository that's about 20ms and the
 * floor below decides, on a monorepo it can be half a second and this is what
 * keeps the panel from spending its life in git.
 */
const DUTY = 15;
/** Fast enough that an edit lands in the panel before you've looked at it. */
const MIN_INTERVAL = 900;
const MAX_INTERVAL = 8000;

const snapshots = new Map<string, GitSnapshot>();
const listeners = new Map<string, Set<() => void>>();
const timers = new Map<string, number>();
const running = new Set<string>();
/** roots poked while their sweep was in flight — owed a fresh one after */
const stale = new Set<string>();

function emit(root: string) {
  listeners.get(root)?.forEach((fn) => fn());
}

/** The same answer as last time, field for field. Publishing it again would
    only make every subscriber — the changes panel, the file tree, Workspace's
    tab tints — re-render a few hundred rows to draw what is already drawn,
    which is where sidebar scrolling went to die on repos with many changes. */
function unchanged(a: WorktreeChanges[], b: WorktreeChanges[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x.path !== y.path || x.branch !== y.branch || x.is_main !== y.is_main) return false;
    if (x.changes.length !== y.changes.length) return false;
    for (let j = 0; j < x.changes.length; j++) {
      const c = x.changes[j], d = y.changes[j];
      if (c.path !== d.path || c.status !== d.status || c.staged !== d.staged || c.moved !== d.moved)
        return false;
    }
  }
  return true;
}

async function sweep(root: string) {
  // A sweep already in flight is a sweep already about to deliver; a second
  // one would only queue more git processes behind the first. But its answer
  // predates whatever prompted this call — a worktree removed while its
  // neighbours were being read stays on screen if the poke just vanishes — so
  // the debt is remembered rather than dropped.
  if (running.has(root)) {
    stale.add(root);
    return;
  }
  running.add(root);
  const started = performance.now();
  let publish = true;
  try {
    const wts = await api.worktrees(root);
    const withChanges = await Promise.all(
      wts.map(async (wt) => ({
        ...wt,
        changes: await api.gitStatus(wt.path).catch(() => [] as FileChange[]),
      }))
    );
    // main worktree first, then by branch name
    withChanges.sort(
      (a, b) => Number(b.is_main) - Number(a.is_main) || a.branch.localeCompare(b.branch)
    );
    const prev = snapshots.get(root) ?? EMPTY;
    if (prev.epoch > 0 && !prev.error && unchanged(prev.worktrees, withChanges)) {
      publish = false;
    } else {
      snapshots.set(root, { worktrees: withChanges, error: null, epoch: prev.epoch + 1 });
    }
  } catch (e) {
    const prev = snapshots.get(root) ?? EMPTY;
    if (prev.epoch > 0 && prev.error === String(e)) {
      publish = false;
    } else {
      snapshots.set(root, { ...prev, error: String(e), epoch: prev.epoch + 1 });
    }
  } finally {
    running.delete(root);
  }
  if (publish) emit(root);
  if (!listeners.get(root)?.size) return;
  if (stale.delete(root)) {
    void sweep(root);
  } else {
    schedule(root, performance.now() - started);
  }
}

function schedule(root: string, took: number) {
  window.clearTimeout(timers.get(root));
  const wait = Math.min(Math.max(took * DUTY, MIN_INTERVAL), MAX_INTERVAL);
  timers.set(root, window.setTimeout(() => sweep(root), wait));
}

/** Re-read now, everywhere someone is watching — for the moments we know the
    working tree just changed, rather than waiting to find out. */
export function pokeGit() {
  for (const root of listeners.keys()) {
    window.clearTimeout(timers.get(root));
    void sweep(root);
  }
}

// a save in another app, a commit in another terminal: coming back to the
// window is the one moment we know the answer might be stale
window.addEventListener("focus", pokeGit);

/**
 * git state for a project, shared. The changes panel and the file tree both
 * want it and only one of them is ever on screen, so holding it here means
 * switching between them costs nothing and shows the answer immediately.
 */
export function useGitStatus(root: string, active: boolean): GitSnapshot {
  const [, bump] = useState(0);

  useEffect(() => {
    if (!active) return;
    const onChange = () => bump((n) => n + 1);
    let set = listeners.get(root);
    if (!set) listeners.set(root, (set = new Set()));
    set.add(onChange);
    void sweep(root);
    return () => {
      set!.delete(onChange);
      if (set!.size === 0) {
        listeners.delete(root);
        window.clearTimeout(timers.get(root));
        timers.delete(root);
        stale.delete(root);
      }
    };
  }, [root, active]);

  return snapshots.get(root) ?? EMPTY;
}

/**
 * The same, for a project holding more than one folder.
 *
 * Each folder keeps its own sweep — its own timer, its own duty cycle, its own
 * cached snapshot — and this only joins the answers. A monorepo next to a
 * two-file repo would otherwise pace them both at the slow one's rate, and a
 * folder shown in two projects would be swept twice.
 *
 * Order is the folders' own, and inside a folder whatever `sweep` sorted: main
 * worktree first, then by branch. So the panel's groups follow the tree's, and
 * neither reshuffles when a branch is created.
 */
export function useGitStatusMany(roots: string[], active: boolean): GitSnapshot {
  const [, bump] = useState(0);
  // the array identity changes every render; its contents rarely do
  const key = roots.join("\n");

  useEffect(() => {
    if (!active) return;
    const onChange = () => bump((n) => n + 1);
    const mine = key ? key.split("\n") : [];
    for (const root of mine) {
      let set = listeners.get(root);
      if (!set) listeners.set(root, (set = new Set()));
      set.add(onChange);
      void sweep(root);
    }
    return () => {
      for (const root of mine) {
        const set = listeners.get(root);
        if (!set) continue;
        set.delete(onChange);
        if (set.size === 0) {
          listeners.delete(root);
          window.clearTimeout(timers.get(root));
          timers.delete(root);
          stale.delete(root);
        }
      }
    };
  }, [key, active]);

  const mine = key ? key.split("\n") : [];
  const parts = mine.map((r) => snapshots.get(r) ?? EMPTY);
  return {
    worktrees: parts.flatMap((p, i) => p.worktrees.map((w) => ({ ...w, owner: mine[i] }))),
    // One unreadable folder is not the whole panel's answer: the others still
    // have something to show, so the error rides along beside them rather than
    // replacing them.
    error: parts.find((p) => p.error)?.error ?? null,
    // any folder moving moves the whole, which is what memos off `epoch` want
    epoch: parts.reduce((n, p) => n + p.epoch, 0),
  };
}

/** the words behind git's letters — one tooltip vocabulary for every place a
    letter shows, so the tree's badge and the panel's never need translating */
export const STATUS_NAME: Record<string, string> = {
  M: "modified",
  A: "added",
  D: "deleted",
  U: "untracked",
  R: "renamed",
  C: "copied",
};

export type GitMark = "modified" | "added" | "deleted";

export interface Decorations {
  /** absolute path → how it differs from HEAD */
  files: Map<string, { mark: GitMark; letter: string }>;
  /** absolute directory path → the strongest thing that changed inside it */
  dirs: Map<string, GitMark>;
}

function markOf(status: string): GitMark {
  if (status === "U" || status === "A") return "added";
  if (status === "D") return "deleted";
  return "modified";
}

/** A directory takes the colour of the most substantial change under it: a
    folder holding only new files is new, anything else edited it. */
const WEIGHT: Record<GitMark, number> = { added: 1, deleted: 2, modified: 2 };

export function decorations(root: string, changes: FileChange[]): Decorations {
  const files = new Map<string, { mark: GitMark; letter: string }>();
  const dirs = new Map<string, GitMark>();

  for (const c of changes) {
    // not every entry is a file: an untracked directory git declines to look
    // inside — a nested repository — arrives as "nested/", and belongs in the
    // folder badges rather than as a file that no path in the tree matches
    const isDir = c.path.endsWith("/");
    const abs = `${root}/${isDir ? c.path.slice(0, -1) : c.path}`;
    const mark = markOf(c.status);
    if (isDir) {
      const at = dirs.get(abs);
      if (!at || WEIGHT[mark] > WEIGHT[at]) dirs.set(abs, mark);
    } else {
      // "MM" — staged and edited again — arrives as two entries for one file;
      // the working-tree one is the one you can see, so it wins
      const prev = files.get(abs);
      if (!prev || WEIGHT[mark] >= WEIGHT[prev.mark]) {
        files.set(abs, { mark, letter: c.status === "U" ? "U" : c.status });
      }
    }

    // every folder between the project and the file carries the badge too, so
    // a change is visible without opening anything
    let dir = abs.slice(0, abs.lastIndexOf("/"));
    while (dir.length > root.length) {
      const at = dirs.get(dir);
      if (!at || WEIGHT[mark] > WEIGHT[at]) dirs.set(dir, mark);
      dir = dir.slice(0, dir.lastIndexOf("/"));
    }
  }
  return { files, dirs };
}
