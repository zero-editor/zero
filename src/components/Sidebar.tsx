import type { ReactElement } from "react";
import type { Project } from "../App";
import type { View } from "./Workspace";
import { WorktreePanel } from "./WorktreePanel";
import { FileTree, type Reveal } from "./FileTree";
import { SearchPanel } from "./SearchPanel";
import { MemoPanel } from "./MemoPanel";
import { api } from "../lib/api";
import { goToNoteEnd } from "../lib/notes";
import type { Search } from "../lib/search";
import type { Memos } from "../lib/memos";

export type SidebarTab = "scm" | "files" | "search" | "memos";

// activity-bar glyphs, drawn to the same 16px / 1.2-stroke grid
const ICONS: Record<SidebarTab, ReactElement> = {
  scm: (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.2">
      <circle cx="4.5" cy="3.2" r="1.7" />
      <circle cx="4.5" cy="12.8" r="1.7" />
      <circle cx="11.5" cy="6" r="1.7" />
      <path d="M4.5 4.9v6.2" />
      <path d="M11.5 7.7c0 2.4-2.3 3.2-4.6 3.6" strokeLinecap="round" />
    </svg>
  ),
  // a folder, not VS Code's two stacked pages — at 16px that codicon reads as
  // a copy/duplicate glyph, and it sat next to a branch icon that also has two
  // of something
  files: (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.2">
      <path
        d="M2.3 11.8V4.5a.9.9 0 0 1 .9-.9h2.5l1.5 1.7h5.6a.9.9 0 0 1 .9.9v5.6a.9.9 0 0 1-.9.9H3.2a.9.9 0 0 1-.9-.9Z"
        strokeLinejoin="round"
      />
    </svg>
  ),
  search: (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.2">
      <circle cx="7" cy="7" r="4.2" />
      <path d="M10.1 10.1 13.5 13.5" strokeLinecap="round" />
    </svg>
  ),
  // capsule, cradle, stem — no base foot, and no waveform bars, which would
  // promise playback this doesn't have. The cradle is a true semicircle so the
  // glyph fills the same 1.5–14.5 the branch does; a mic is narrower than the
  // other three by nature and pretending otherwise makes it a cartoon.
  memos: (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.2">
      <rect x="6.3" y="2.1" width="3.4" height="6.4" rx="1.7" />
      <path d="M4 7.4v1.1a4 4 0 0 0 8 0V7.4" strokeLinecap="round" />
      <path d="M8 12.5v1.4" strokeLinecap="round" />
    </svg>
  ),
};

/* The note, and the only thing in this run that is not a tab.
 *
 * A clipboard, because what the button is for is not that a file exists — a
 * page glyph would say that, and would be the folder above it with lines in it
 * — but that whatever is on the clipboard has somewhere to land. The clip is
 * the whole tell at 16px, so it is a closed shape over a board with a gap left
 * for it rather than a notch in one outline, which closes up at this size. */
const NOTE = (
  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5.4 3.6H4.5a1.3 1.3 0 0 0-1.3 1.3v7.4a1.3 1.3 0 0 0 1.3 1.3h7a1.3 1.3 0 0 0 1.3-1.3V4.9a1.3 1.3 0 0 0-1.3-1.3h-.9" />
    <path d="M5.4 4.5V3.3a.9.9 0 0 1 .9-.9h3.4a.9.9 0 0 1 .9.9v1.2Z" />
    <path d="M5.7 7.9h4.6" />
    <path d="M5.7 10.5h3" />
  </svg>
);

// a chevron pointing at the edge the panel folds towards, drawn on the
// same grid as the tabs so the two read as one run
const FOLD = (
  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.2">
    <path d="M9.5 4 5.5 8l4 4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const UNFOLD = (
  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.2">
    <path d="M6.5 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const TABS: { id: SidebarTab; title: string }[] = [
  { id: "files", title: "files (⌘⇧E)" },
  { id: "search", title: "search (⌘⇧F)" },
  { id: "scm", title: "changes (⌃⇧G)" },
  { id: "memos", title: "memos (⌘⇧M)" },
];

export function Sidebar({
  project,
  tab,
  onTab,
  onOpenView,
  active,
  search,
  memos,
  activeMemo,
  activeKey,
  reveal,
  onRevealInTree,
  collapsed,
  onCollapse,
  onExpand,
}: {
  project: Project;
  tab: SidebarTab;
  onTab: (t: SidebarTab) => void;
  onOpenView: (v: View) => void;
  active: boolean;
  search: Search;
  memos: Memos;
  /** the memo whose thread is the view on screen, so its row can say so —
   *  passed straight through, since the sidebar knows nothing about tabs */
  activeMemo: string | null;
  /** the shown view's key, for the same reason: the changes row whose diff or
   *  file is on screen marks itself */
  activeKey: string | null;
  reveal: Reveal | null;
  /** walk the file tree open to a path and light its row — ⌘E's other half,
   *  offered as a menu item by the panels that name files they didn't find */
  onRevealInTree: (abs: string) => void;
  /** folded to its run of icons — the body is gone, the run stays, and
   *  picking an icon or the chevron unfolds it (Workspace holds the width) */
  collapsed: boolean;
  onCollapse: () => void;
  onExpand: () => void;
}) {
  // The memos tab is the only one that has anything to say while you're not
  // looking at it, and this dot is all of it — no titlebar presence, no
  // notifications, no sound. Red beats everything because a live mic may never
  // be invisible; then work in progress; then a memo that came back unread.
  const dot = memos.recording
    ? "rec"
    : memos.working
      ? "busy"
      : memos.unseenReady
        ? "ready"
        : "";

  /** Exactly what ⌘⌥N does, cursor included: a button and a shortcut that left
   *  you in different places would be two features wearing one name. */
  const openNote = async () => {
    const abs = await api.noteOpen(project.root).catch(() => null);
    if (!abs) return;
    onOpenView({ kind: "file", key: `file:${abs}`, absPath: abs });
    goToNoteEnd(abs);
  };

  return (
    <div className={`sidebar ${collapsed ? "collapsed" : ""}`}>
      <div className="sidebar-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`sidebar-tab ${tab === t.id ? "active" : ""}`}
            title={t.title}
            onClick={() => onTab(t.id)}
          >
            {ICONS[t.id]}
            {t.id === "memos" && dot && <span className={`memo-tab-dot ${dot}`} />}
          </button>
        ))}
        {/* Under the tabs, and not one of them: it opens a document rather
            than swapping the panel, so it never takes the active mark and the
            panel you were reading stays where it was. Same square and same
            grid, because it belongs to the run — the difference it has to
            carry is only that nothing here stays pressed. */}
        <button className="sidebar-tab" title="paste & auto tidy (⌘⌥N)" onClick={openNote}>
          {NOTE}
        </button>
        {collapsed ? (
          <button className="sidebar-fold" title="expand sidebar (⌘B)" onClick={onExpand}>
            {UNFOLD}
          </button>
        ) : (
          <button className="sidebar-fold" title="collapse sidebar" onClick={onCollapse}>
            {FOLD}
          </button>
        )}
      </div>
      {/* The tree stays mounted behind the other panels and through a fold,
          hidden rather than gone: its open folders and scroll position are
          state it holds itself, and unmounting it on every tab switch threw
          them away. The others are cheap to rebuild and are built on demand
          as before. */}
      <div className="sidebar-body" hidden={collapsed}>
        {tab === "scm" && (
          <WorktreePanel
            project={project}
            onOpenView={onOpenView}
            onRevealInTree={onRevealInTree}
            active={active}
            activeKey={activeKey}
          />
        )}
        <div hidden={tab !== "files"}>
          <FileTree
            root={project.root}
            active={active && tab === "files" && !collapsed}
            reveal={reveal}
            onOpenView={onOpenView}
          />
        </div>
        {tab === "search" && (
          <SearchPanel
            root={project.root}
            search={search}
            onOpenView={onOpenView}
            onRevealInTree={onRevealInTree}
          />
        )}
        {tab === "memos" && (
          <MemoPanel
            root={project.root}
            memos={memos}
            activeMemo={activeMemo}
            onOpenView={onOpenView}
          />
        )}
      </div>
    </div>
  );
}

