import type { ReactElement } from "react";
import { LINEAR_PATH } from "./Avatar";
import type { Project } from "../App";
import type { View } from "./Workspace";
import { IssuesPanel } from "./IssuesPanel";
import { WorktreePanel } from "./WorktreePanel";
import { FileTree, type Reveal } from "./FileTree";
import { SearchPanel } from "./SearchPanel";
import { MemoPanel } from "./MemoPanel";
import { api } from "../lib/api";
import { goToNoteEnd } from "../lib/notes";
import type { Search } from "../lib/search";
import type { Memos } from "../lib/memos";
import { updateSettings, useSettings } from "../lib/settings";
import type { Settings } from "../lib/settings";
import { folders } from "../lib/folders";
import { contextMenu } from "../lib/contextMenu";

export type SidebarTab = "scm" | "files" | "search" | "issues" | "memos";

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
  // Linear's own logomark, not a glyph of our own. Every other icon in this
  // run says what its panel *shows*; this one says where the contents come
  // from, because that is the thing worth knowing about a panel whose rows are
  // somebody else's records and whose state lives on their server.
  //
  // It is the only filled mark in a run of stroked ones, and that is inherent
  // to the logo rather than a decision available to us. What is a decision is
  // the size: the drawn glyphs occupy about 81% of their 16px box, and this
  // mark fills its own viewBox edge to edge, so the box is padded out to
  // 29.6 units to land the two at the same visual weight. It takes
  // `currentColor` like the rest, so it dims and lights with its neighbours
  // rather than sitting in brand purple while they respond to hover.
  issues: (
    <svg viewBox="-2.8 -2.8 29.6 29.6" width="16" height="16" fill="currentColor">
      <path d={LINEAR_PATH} />
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
  { id: "issues", title: "issues (⌃⇧I)" },
  { id: "memos", title: "memos (⌘⇧M)" },
];

/** The rail, minus anything switched off in Preferences. Filtered rather than
 *  hidden with CSS so the tabs keep dividing the strip evenly between however
 *  many there are. */
const railTabs = (on: { linear: boolean; memos: boolean }) =>
  TABS.filter((t) => (t.id !== "issues" || on.linear) && (t.id !== "memos" || on.memos));

/** The rail's own way to switch one of these off, on the icon itself.
 *
 *  Preferences is where they all live and where they come back from, but the
 *  moment you want an icon gone is the moment you are looking at it — and a
 *  right-click there is a shorter sentence than ⌘, and a pane. Only the
 *  optional ones appear here; the tabs that are the editor have nothing to
 *  offer a right-click, and `files` answers with something else entirely. */
const TURN_OFF: Partial<Record<SidebarTab, { text: string; patch: Partial<Settings> }>> = {
  issues: { text: "Turn Off Linear", patch: { linear: false } },
  memos: { text: "Turn Off Voice Memos", patch: { memos: false } },
};

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
  onAddFolder,
  onRemoveFolder,
  onOpenTerminalOn,
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
  /** put another folder in this project — the picker lives up in App */
  onAddFolder: () => void;
  onRemoveFolder: (dir: string) => void;
  /** open a terminal already running a command — the issues panel's run
   *  buttons, whose terminals the workspace owns */
  onOpenTerminalOn: (boot: string) => void;
}) {
  // which of the optional three this rail has any icons for
  const { linear, memos: memosOn, notes: notesOn } = useSettings();

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
        {railTabs({ linear, memos: memosOn }).map((t) => (
          <button
            key={t.id}
            className={`sidebar-tab ${tab === t.id ? "active" : ""}`}
            title={t.title}
            onClick={() => onTab(t.id)}
            // Two kinds of right-click, and no third: the files icon stands
            // for a thing rather than a view — it is the project's folders —
            // and the optional tabs offer the way out of being in the rail at
            // all. `scm` and `search` have nothing to say that clicking them
            // doesn't already do, and get the webview's own menu.
            onContextMenu={(e) => {
              if (t.id === "files") {
                onTab("files");
                contextMenu(e, [{ text: "Add Folder to Project…", run: onAddFolder }]);
                return;
              }
              const off = TURN_OFF[t.id];
              if (off) contextMenu(e, [{ text: off.text, run: () => updateSettings(off.patch) }]);
            }}
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
        {notesOn && (
          <button
            className="sidebar-tab"
            title="paste & auto tidy (⌘⌥N)"
            onClick={openNote}
            onContextMenu={(e) =>
              contextMenu(e, [
                { text: "Turn Off Notes", run: () => updateSettings({ notes: false }) },
              ])
            }
          >
            {NOTE}
          </button>
        )}
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
            onRemoveFolder={onRemoveFolder}
            active={active}
            activeKey={activeKey}
          />
        )}
        <div hidden={tab !== "files"}>
          <FileTree
            roots={folders(project)}
            active={active && tab === "files" && !collapsed}
            reveal={reveal}
            onOpenView={onOpenView}
            onAddFolder={onAddFolder}
            onRemoveFolder={onRemoveFolder}
          />
        </div>
        {tab === "search" && (
          <SearchPanel
            search={search}
            onOpenView={onOpenView}
            onRevealInTree={onRevealInTree}
          />
        )}
        {linear && tab === "issues" && (
          <IssuesPanel
            project={project}
            active={active && tab === "issues" && !collapsed}
            activeKey={activeKey}
            onOpenView={onOpenView}
            onOpenTerminalOn={onOpenTerminalOn}
          />
        )}
        {memosOn && tab === "memos" && (
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

