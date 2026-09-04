import { api } from "./api";
import type { Project } from "../App";
import type { LayoutNode } from "./layout";
import type { SidebarTab } from "../components/Sidebar";
import type { View } from "../components/Workspace";

/**
 * What the window looked like last time, so reopening zero puts it back.
 *
 * Layout only — but since the shells moved into the daemon it is load-bearing
 * twice over. A restored pane asks for its old id and is handed back the shell
 * that id already had, and the ids no restored layout mentions are the ones
 * the daemon is told to end (see `claimedPaneIds` and the boot note in App).
 * So a layout that comes back wrong doesn't just cost you the arrangement any
 * more; a pane it forgets is a Claude session reaped.
 *
 * This used to be localStorage, and the reason it isn't any more is the way
 * zero ends. Quitting finishes in `std::process::exit` on the Rust side, which
 * never unloads the page: `beforeunload` doesn't fire, so a debounced write
 * never happens, and WebKit's own in-memory store never syncs out to
 * localstorage.sqlite3. Both losses are silent — you simply get an older
 * window back, with no way to tell which changes didn't make it. So the blob
 * now goes to the Rust side, which writes it at once and writes it again on
 * the way out (src-tauri/src/session.rs).
 *
 * What that costs is the synchronous read localStorage gave us. Nothing, as it
 * turns out: App already waits on this before its first render, because the
 * projects have to be checked for existence anyway.
 */

/** the localStorage key this lived under before it became a file — read once,
 *  to carry a session across the upgrade, and dropped as soon as the file has
 *  it instead */
const LEGACY_KEY = "zero-session";

/** one document pane's open tabs and which of them is up */
export interface DocPane {
  views: View[];
  activeView: number;
}

export interface ProjectSession {
  /** the whole window's split tree — sidebar, document panes and terminals
   *  as leaves */
  layout: LayoutNode | null;
  /** the terminal region's own tree from before the one-tree layout — read
   *  once by the migration, never written again */
  term: LayoutNode | null;
  focusedId: string | null;
  sidebarTab: SidebarTab;
  sidebarVisible: boolean;
  /** shown, but folded to its rail of icons: still a leaf of the tree, held
   *  at the rail's pixel width by the workspace */
  sidebarCollapsed: boolean;
  /** the share of its split the sidebar had before it folded, to hand back
   *  when it unfolds */
  sidebarShare: number | null;
  terminalVisible: boolean;
  /** the era of the single document pane — read once by the migration into
   *  `docPanes`, never written again */
  views: View[];
  activeView: number;
  /** every document pane's tabs, keyed the way the tree keys its leaves */
  docPanes: Record<string, DocPane>;
  /** the pane an open lands in */
  activePane: string;
  /** what the Issues panel's run buttons say, by the state group they sit on —
   *  only the ones edited away from their default, which is why a fresh project
   *  has none. Per project because the assignees and repositories a prompt
   *  names belong to the workspace its token opens, the same way the token
   *  itself does. */
  linearPrompts: Record<string, string>;
  /** what an issue row's own run button says — one template for every row, so
   *  a string rather than a map. Absent until edited, same as the above. */
  linearIssuePrompt: string;
}

interface Session {
  projects: Project[];
  activeIdx: number;
  byProject: Record<string, Partial<ProjectSession>>;
}

const empty = (): Session => ({ projects: [], activeIdx: 0, byProject: {} });

/* ---------- validation ----------
   Everything below treats the stored blob as untrusted: it survives across
   versions of zero, so a shape this build has never seen is normal, not
   exceptional. Anything unrecognised is dropped rather than defaulted, and a
   tree that can't be salvaged becomes null — which just means "fresh shell". */

function validTree(n: unknown, seen: Set<string>): LayoutNode | null {
  if (!n || typeof n !== "object") return null;
  const node = n as LayoutNode;

  if (node.type === "leaf") {
    // duplicate ids would collide as React keys and, worse, as pty ids
    if (typeof node.id !== "string" || !node.id || seen.has(node.id)) return null;
    seen.add(node.id);
    return { type: "leaf", id: node.id };
  }
  if (node.type !== "split") return null;
  if (node.dir !== "row" && node.dir !== "col") return null;
  if (!Array.isArray(node.children)) return null;

  // each child's own share travels with it, so a child that doesn't survive
  // costs its share and nothing else. Dropping the whole array instead — which
  // is what "sizes must describe these children exactly" used to mean — turned
  // one bad leaf into an even split of every pane beside it, which reads as
  // the layout not being restored at all.
  const stored = Array.isArray(node.sizes) ? node.sizes : [];
  const children: LayoutNode[] = [];
  const shares: (number | undefined)[] = [];
  node.children.forEach((c, i) => {
    const next = validTree(c, seen);
    if (next === null) return;
    children.push(next);
    const s = stored[i];
    shares.push(typeof s === "number" && Number.isFinite(s) && s > 0 ? s : undefined);
  });
  if (children.length === 0) return null;
  // a split that lost all but one child is just that child
  if (children.length === 1) return children[0];

  // an even split is the fallback for a split nothing usable was stored for,
  // not for one where a single number went bad: there, the shares that are
  // still good are kept and renormalised, and the rest are dealt the average
  // of them so no pane can come back with no room at all
  const known = shares.filter((s): s is number => s !== undefined);
  let sizes: number[] | undefined;
  if (known.length) {
    const mean = known.reduce((a, b) => a + b, 0) / known.length;
    const filled = shares.map((s) => s ?? mean);
    const total = filled.reduce((a, b) => a + b, 0);
    sizes = filled.map((s) => s / total);
  }
  return { type: "split", dir: node.dir, children, sizes };
}

/** Untitled buffers are deliberately not restorable: their contents live only
 *  in the editor, so a restored one would be an empty tab wearing its name.
 *
 *  Every other kind has to be named here, and the trap is that forgetting one
 *  looks like nothing: a shape this function doesn't recognise is dropped in
 *  silence, so the only symptom is a tab that stops surviving relaunches. A new
 *  kind in `View` is a new line in here. */
function validViews(v: unknown): View[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is View => {
    if (!x || typeof x !== "object") return false;
    const view = x as View;
    if (typeof view.key !== "string") return false;
    if (view.kind === "file") return typeof view.absPath === "string";
    // `staged` may be absent — sessions predating it are working-tree diffs,
    // which is what `undefined` already means
    if (view.kind === "diff")
      return (
        typeof view.worktree === "string" &&
        typeof view.relPath === "string" &&
        (view.staged === undefined || typeof view.staged === "boolean") &&
        // likewise `from`: absent on every session written before moves were
        // paired, and absent on every row that isn't one end of one
        (view.from === undefined || typeof view.from === "string")
      );
    // a memo thread is an id and the project it was stored under; whether that
    // memo still exists is the thread's own business, and it says so quietly
    if (view.kind === "memo") return typeof view.id === "string";
    if (view.kind === "issue")
      return typeof view.id === "string" && typeof view.identifier === "string";
    return false;
  });
}

/** each pane's list goes through the same sieve the single list always did */
function validDocPanes(v: unknown): Record<string, DocPane> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<string, DocPane> = {};
  for (const [id, dp] of Object.entries(v as Record<string, unknown>)) {
    if (!id || !dp || typeof dp !== "object") continue;
    const views = validViews((dp as DocPane).views);
    const raw = (dp as DocPane).activeView;
    out[id] = {
      views,
      activeView:
        typeof raw === "number" ? Math.min(Math.max(raw, 0), Math.max(views.length - 1, 0)) : 0,
    };
  }
  return out;
}

/** The run buttons' prompts. Both halves are the user's own text — a state's
 *  name on one side, whatever they typed on the other — so there is nothing to
 *  check beyond the shape, and an entry that isn't two strings is dropped. */
function validPrompts(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [state, body] of Object.entries(v as Record<string, unknown>)) {
    if (state && typeof body === "string") out[state] = body;
  }
  return out;
}

function validProjectSession(v: unknown): Partial<ProjectSession> {
  if (!v || typeof v !== "object") return {};
  const p = v as Partial<ProjectSession>;
  const views = validViews(p.views);
  return {
    layout: validTree(p.layout, new Set()),
    term: validTree(p.term, new Set()),
    focusedId: typeof p.focusedId === "string" ? p.focusedId : null,
    sidebarTab:
      p.sidebarTab === "files" ||
      p.sidebarTab === "scm" ||
      p.sidebarTab === "search" ||
      p.sidebarTab === "issues" ||
      p.sidebarTab === "memos"
        ? p.sidebarTab
        : undefined,
    sidebarVisible: typeof p.sidebarVisible === "boolean" ? p.sidebarVisible : undefined,
    sidebarCollapsed: typeof p.sidebarCollapsed === "boolean" ? p.sidebarCollapsed : undefined,
    sidebarShare: typeof p.sidebarShare === "number" ? p.sidebarShare : undefined,
    terminalVisible: typeof p.terminalVisible === "boolean" ? p.terminalVisible : undefined,
    views,
    // dropped untitled tabs can leave the index past the end — and can empty
    // the list altogether, where the clamp's own ceiling would be -1
    activeView:
      typeof p.activeView === "number"
        ? Math.min(Math.max(p.activeView, 0), Math.max(views.length - 1, 0))
        : 0,
    docPanes: validDocPanes(p.docPanes),
    activePane: typeof p.activePane === "string" ? p.activePane : undefined,
    linearPrompts: validPrompts(p.linearPrompts),
    linearIssuePrompt:
      typeof p.linearIssuePrompt === "string" ? p.linearIssuePrompt : undefined,
  };
}

function parse(raw: string | null): Session {
  if (!raw) return empty();
  let blob: Partial<Session>;
  try {
    blob = JSON.parse(raw) as Partial<Session>;
  } catch {
    // a blob we can't read is not a session that claims nothing — see `legible`
    legible = false;
    return empty();
  }

  const seenRoots = new Set<string>();
  const projects = (Array.isArray(blob.projects) ? blob.projects : [])
    .filter(
      (p): p is Project =>
        !!p &&
        typeof p.root === "string" &&
        !!p.root &&
        typeof p.name === "string" &&
        !seenRoots.has(p.root) &&
        !!seenRoots.add(p.root)
    )
    // The extra folders of a multi-folder project. Sieved rather than trusted
    // like everything else here, and dropped to `undefined` when there are
    // none left — a project with an empty array is a project with one folder,
    // and the two should not be two shapes in the stored blob.
    .map((p) => {
      const seen = new Set([p.root]);
      const extra = (Array.isArray(p.folders) ? p.folders : []).filter(
        (f): f is string => typeof f === "string" && !!f && !seen.has(f) && !!seen.add(f)
      );
      return extra.length ? { ...p, folders: extra } : { root: p.root, name: p.name };
    });

  const byProject: Session["byProject"] = {};
  for (const p of projects) {
    byProject[p.root] = validProjectSession((blob.byProject ?? {})[p.root]);
  }

  const activeIdx =
    typeof blob.activeIdx === "number" && blob.activeIdx >= 0 && blob.activeIdx < projects.length
      ? blob.activeIdx
      : 0;

  return { projects, activeIdx, byProject };
}

/* ---------- the live copy ---------- */

// One in-memory object that App and every Workspace patch independently, so
// their writes merge instead of racing through a read-modify-write each.
let current: Session = empty();
/** whether the session we are holding came out of the retired localStorage
 *  key, so it can be cleared once the file has it instead */
let adopted = false;
/**
 * Whether the stored session could be read at all.
 *
 * "Nothing is stored" and "I could not find out what is stored" used to be the
 * same answer, and with localStorage they were nearly the same event. A file
 * can fail in ways a synchronous read of an in-process map cannot — an
 * unreadable config directory, a truncated blob — and since the reap ends
 * every session no restored layout claims, answering one of those with an
 * empty list would end every shell on the machine. So the two are told apart,
 * and only the first of them gets to speak for what is running.
 */
let legible = true;
let queued = false;

/**
 * Hand the whole session over, once per commit.
 *
 * There is no debounce here and no timer to lose: the microtask lands after
 * React has run every effect in the commit, so a change that touches several
 * workspaces at once is still one write, and a change is never sitting in a
 * queue waiting for a deadline that ⌘Q won't let arrive. The Rust side takes
 * it from there — it writes immediately, skips a snapshot it already holds,
 * and writes once more as the app exits.
 */
function schedule() {
  if (queued) return;
  queued = true;
  queueMicrotask(() => {
    queued = false;
    api
      .sessionSave(JSON.stringify(current))
      .then(() => {
        if (!adopted) return;
        adopted = false;
        try {
          localStorage.removeItem(LEGACY_KEY);
        } catch {
          // it staying behind costs nothing: the file is what gets read now
        }
      })
      .catch(() => {
        // an unwritable config dir costs you the layout, nothing else
      });
  });
}

/**
 * Read the stored session and drop any project that has since moved or been
 * deleted. Everything the first render needs is parsed by the time this
 * resolves, and App holds the launcher back until it does.
 */
export async function restoreSession(): Promise<{ projects: Project[]; activeIdx: number }> {
  let raw: string | null = null;
  try {
    raw = await api.sessionLoad();
  } catch {
    raw = null;
    legible = false;
  }
  if (raw === null) {
    // first launch after the upgrade: take what localStorage still holds, and
    // let the first save move it to the file
    raw = localStorage.getItem(LEGACY_KEY);
    adopted = raw !== null;
  }
  current = parse(raw);
  if (adopted) schedule();
  if (current.projects.length === 0) return { projects: [], activeIdx: 0 };

  // every folder of every project, not just the roots — an added folder that
  // has been moved or deleted since would otherwise come back as a tree branch
  // that lists nothing and a changes group that only ever says "not a git repo"
  const roots = current.projects.flatMap((p) => [p.root, ...(p.folders ?? [])]);
  let alive: string[];
  try {
    alive = await api.existingDirs(roots);
  } catch {
    alive = roots; // can't check: better a stale tab than an empty window
  }

  const live = new Set(alive);
  const activeRoot = current.projects[current.activeIdx]?.root;
  current.projects = current.projects
    .filter((p) => live.has(p.root))
    .map((p) => {
      // A project loses a folder that has gone, but never itself over one:
      // losing the root is what closes the tab, and the tab is where the
      // terminals are.
      const kept = (p.folders ?? []).filter((f) => live.has(f));
      return kept.length ? { ...p, folders: kept } : { root: p.root, name: p.name };
    });
  for (const root of Object.keys(current.byProject)) {
    if (!live.has(root)) delete current.byProject[root];
  }
  // keep whichever project was in front, unless it's one of the ones that went
  const idx = current.projects.findIndex((p) => p.root === activeRoot);
  current.activeIdx = idx >= 0 ? idx : 0;

  return { projects: current.projects, activeIdx: current.activeIdx };
}

/**
 * Every pane id the restored session still points at.
 *
 * The list the daemon is handed on boot, and the whole basis on which a shell
 * is allowed to outlive the app: a session survives only while some layout
 * still claims it. That makes an unclaimed session an unambiguous orphan
 * rather than a judgement call, and it means "stuck somewhere" can only ever
 * mean "belongs to a project I haven't opened lately" — never "left behind by
 * something the UI did".
 *
 * Document panes are in here too. Their ids can never collide with a
 * terminal's (see the note on SIDEBAR/EDITOR in layout.ts), so claiming them
 * costs nothing and telling them apart would cost a second kind of walk.
 *
 * Null when the stored session couldn't be read — a different answer from a
 * session that claims nothing, and the only one this can give that isn't safe
 * to act on. An empty list is an instruction to end every shell there is; a
 * failed read has no idea what is running and must not be allowed to say so.
 */
export function claimedPaneIds(): string[] | null {
  if (!legible) return null;
  const ids: string[] = [];
  const walk = (n: LayoutNode | null | undefined) => {
    if (!n) return;
    if (n.type === "leaf") ids.push(n.id);
    else n.children.forEach(walk);
  };
  for (const state of Object.values(current.byProject)) {
    walk(state.layout);
    // the pre-one-tree terminal region: still the live layout for a session
    // written by an older zero and not yet migrated
    walk(state.term);
  }
  return ids;
}

/** Read once, at mount. Workspaces are keyed by root, so this never goes stale. */
export function projectSession(root: string): Partial<ProjectSession> {
  return current.byProject[root] ?? {};
}

export function saveProjects(projects: Project[], activeIdx: number) {
  current.projects = projects;
  current.activeIdx = activeIdx;
  // a closed project takes its layout with it
  const live = new Set(projects.map((p) => p.root));
  for (const root of Object.keys(current.byProject)) {
    if (!live.has(root)) delete current.byProject[root];
  }
  schedule();
}

export function saveProject(root: string, state: Partial<ProjectSession>) {
  const next: Partial<ProjectSession> = { ...current.byProject[root], ...state };
  // A field the migration has read is a field nobody will read again — but
  // merging kept re-serialising it forever, so every session still carried a
  // duplicate of its tab list and a terminal tree from two layouts ago. They
  // go the moment the thing that replaced them arrives, which is the only
  // moment we can be sure the migration is behind us.
  if (state.docPanes) {
    delete next.views;
    delete next.activeView;
  }
  if (state.layout) delete next.term;
  current.byProject[root] = next;
  schedule();
}
