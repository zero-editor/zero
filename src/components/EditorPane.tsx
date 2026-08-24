import { useEffect } from "react";
import type { View } from "./Workspace";
import { DiffView } from "./DiffView";
import { ImageDiffView } from "./ImageDiffView";
import { FileView } from "./FileView";
import { ImageView } from "./ImageView";
import { MemoThread } from "./MemoThread";
import { NewFileView } from "./NewFileView";
import { isImage } from "../lib/imageFile";
import { contextMenu, fileEntries, type Entry } from "../lib/contextMenu";
import { overrideFor, setLanguageOverride } from "../lib/lang";
import { pickLanguage } from "../lib/langPick";
import { FileIconSpan } from "./FileIcon";
import { memoLabel, memoPaths, type Memos } from "../lib/memos";
import { STATUS_NAME, type GitMark } from "../lib/gitStatus";
import { useTabReorder } from "../lib/tabReorder";
import type { Side } from "../lib/layout";

function viewLabel(v: View, memos: Memos): string {
  if (v.kind === "new") return v.name;
  // The memo's own title, live: a merge renames it, and the tab is where that
  // name is said — the thread below draws no title of its own, precisely so
  // this one isn't a second copy of it. Gone from the list and it is down to
  // the id, which is still what its files are called.
  if (v.kind === "memo")
    return memoLabel(
      memos.memos.find((m) => m.id === v.id),
      v.id,
    );
  const p = v.kind === "diff" ? v.relPath : v.absPath;
  return p.split("/").pop() ?? p;
}

function viewAbs(v: View, root: string): string {
  if (v.kind === "new") return v.name;
  // a thread is a reading of a file, and this is the file — which is worth
  // saying in the one line of chrome that says where you are
  if (v.kind === "memo") return memoPaths(root, v.id).md;
  return v.kind === "diff" ? `${v.worktree}/${v.relPath}` : v.absPath;
}

/** the file a view is of, and null for the one kind that isn't on disk yet —
 *  an untitled buffer has a name but nowhere to be revealed */
function viewFile(v: View, root: string): string | null {
  return v.kind === "new" ? null : viewAbs(v, root);
}

// path shown in the breadcrumb: relative to the project when it lives inside it
function viewPath(v: View, root: string): string {
  const abs = viewAbs(v, root);
  if (v.kind === "new") return abs;
  if (abs.startsWith(root + "/")) return abs.slice(root.length + 1);
  return abs.replace(/^\/Users\/[^/]+\//, "~/");
}

function Breadcrumb({
  view,
  root,
  onOpenFile,
  onRevealInTree,
}: {
  view: View;
  root: string;
  onOpenFile: (abs: string) => void;
  onRevealInTree: (abs: string) => void;
}) {
  const abs = viewAbs(view, root);
  const parts = viewPath(view, root).split("/");
  const name = parts.pop() ?? "";
  // A thread is a reading of a file, and this line is the one place that says
  // which file — so it is also the way to it. Every other view already *is* its
  // file, and a path that opened the tab you are standing on would be a click
  // that does nothing. Coming back is the thread's own tab, still open.
  const open = view.kind === "memo" ? () => onOpenFile(abs) : undefined;
  return (
    <div
      className={`editor-path ${open ? "opens" : ""}`}
      title={open ? `${abs} — open the file itself` : abs}
      onClick={open}
      // the line already says where the file is; this is the same line saying
      // what can be done about it. No Close here — the tab is where a tab is
      // closed, and this line belongs to the file rather than to the tab
      onContextMenu={(e) => {
        const file = viewFile(view, root);
        if (!file) return;
        contextMenu(e, [
          { text: "Reveal in Sidebar", run: () => onRevealInTree(file) },
          "sep",
          ...fileEntries(file, { root, writes: view.kind === "memo" ? "none" : "all" }),
        ]);
      }}
    >
      {parts.map((p, i) => (
        <span key={i} className="crumb">
          {p}
          <span className="crumb-sep">›</span>
        </span>
      ))}
      <span className="crumb file">
        <FileIconSpan name={name} />
        {name}
      </span>
    </div>
  );
}

export function EditorPane({
  views,
  activeView,
  focused,
  panes,
  onSelect,
  onClose,
  onCloseOthers,
  onReplace,
  onOpenFile,
  onRevealInTree,
  onReorder,
  onMoveToNewPane,
  onMoveToNextPane,
  root,
  gitMarks,
  memos,
}: {
  views: View[];
  activeView: number;
  /** whether this is the pane opens land in — the one whose active tab wears
   *  the full accent, and the one the tab-cycling keys walk */
  focused: boolean;
  /** how many document panes the window holds — one means "Move to Next
   *  Pane" has nowhere to go and stays off the menu */
  panes: number;
  onSelect: (i: number) => void;
  onClose: (i: number) => void;
  onCloseOthers: (keep: number) => void;
  onReplace: (i: number, v: View) => void;
  onOpenFile: (abs: string, line?: number) => void;
  onRevealInTree: (abs: string) => void;
  onReorder: (from: number, to: number) => void;
  /** carry this tab into a fresh pane split off this one's `side` */
  onMoveToNewPane: (i: number, side: Side) => void;
  /** carry this tab to the next pane along, wrapping */
  onMoveToNextPane: (i: number) => void;
  root: string;
  /** absolute path → how it differs from HEAD, for the git tint a tab wears
   *  the way Cursor's do — built by the workspace off the shared sweep */
  gitMarks: Map<string, { mark: GitMark; letter: string }>;
  /** this project's memos — a memo tab reads its title, its status and its
   *  record button off the same object the panel does */
  memos: Memos;
}) {
  const {
    stripRef,
    drag,
    start: startDrag,
    shift,
  } = useTabReorder(".editor-tab", onReorder);

  /**
   * A tab's menu: what to do with the tab, then what to do with its file.
   *
   * An untitled buffer has a name and no file, so it gets the first half and
   * nothing else — there is nowhere to reveal it and nothing to rename. A memo
   * tab has a file, but one whose name the pipeline reads: renaming `<id>.md`
   * out from under it would orphan the recording and both transcripts, so its
   * document is shown and copied and otherwise left alone.
   */
  const tabEntries = (v: View, i: number): Entry[] => {
    const file = viewFile(v, root);
    return [
      { text: "Close", run: () => onClose(i) },
      views.length > 1 && { text: "Close Others", run: () => onCloseOthers(i) },
      "sep",
      // The moves. A lone tab can't leave for a new pane — the pane it left
      // would follow it out, a shuffle wearing a split's name — but it can
      // move to a pane that already exists. Both land the tab selected, in a
      // pane that opens then land in: moving a tab somewhere is going there.
      views.length > 1 && { text: "Move to New Pane Right", run: () => onMoveToNewPane(i, "right") },
      views.length > 1 && { text: "Move to New Pane Below", run: () => onMoveToNewPane(i, "down") },
      panes > 1 && { text: "Move to Next Pane", run: () => onMoveToNextPane(i) },
      (views.length > 1 || panes > 1) && ("sep" as const),
      ...(file
        ? [
            { text: "Reveal in Sidebar", run: () => onRevealInTree(file) },
            // the file's language is an editor question, so it lives with the
            // editor's half of the menu — but only where there is an editor:
            // a memo reads as markdown and an image isn't text at all
            (v.kind === "file" || v.kind === "diff") && {
              text: "Language…",
              run: async () => {
                const name = file.split("/").pop() ?? file;
                const pick = await pickLanguage({ fileName: name, current: overrideFor(name) });
                if (pick !== null) setLanguageOverride(name, pick === "auto" ? null : pick);
              },
            },
            "sep" as const,
            ...fileEntries(file, { root, writes: v.kind === "memo" ? "none" : "all" }),
          ]
        : []),
    ];
  };

  // The strip scrolls, and most of what activates a tab is somewhere else: a
  // memo row, a search hit, ⌘P, a memo that came back and opened itself. With
  // enough tabs open the one being activated sits past the right-hand edge, and
  // a click that changes nothing you can see is a click that did nothing —
  // which is exactly how "it doesn't take you to that tab" was reported.
  //
  // Not while dragging: mid-gesture the tabs are translated rather than moved,
  // so their boxes lie about where they are, and a scroll would fight the hand.
  useEffect(() => {
    if (drag) return;
    stripRef.current
      ?.querySelector(".editor-tab.active")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeView, drag, stripRef]);

  if (views.length === 0) {
    return (
      <div className={`editor-pane empty ${focused ? "focused" : ""}`}>
        <div className="editor-empty">
          <div className="editor-empty-hint">zero</div>
          {/* the same place the launcher puts it — under the mark, not in a
              corner — so the one screen with nothing on it says which zero
              this is. A self-updated copy is a different number by the time
              anyone looks again, and this is where they'd look. */}
          <div className="editor-empty-version">{__APP_VERSION__}</div>
        </div>
      </div>
    );
  }

  return (
    <div className={`editor-pane ${focused ? "focused" : ""}`}>
      {/* The strip is the card's own top row now, the way the sidebar's tab
          strip is — it used to lie outside on the window, with the active tab
          wearing the page's tone flush into the page, and that construction
          can't survive the card having an edge: a hairline across the top of
          the page severs the tab from it, and a tab outside the border is
          outside the panel it names. */}
      <div className="editor-card">
        <div className={`editor-tabs ${drag ? "reordering" : ""}`} ref={stripRef}>
          {views.map((v, i) => {
            // the tab's git face — only for tabs that are a file in git's
            // sense; a memo or an untitled buffer has no HEAD to differ from
            const mark =
              v.kind === "file" || v.kind === "diff" ? gitMarks.get(viewAbs(v, root)) : undefined;
            return (
            <div
              key={v.key}
              className={`editor-tab ${i === activeView ? "active" : ""} ${
                drag?.from === i ? "dragging" : ""
              }`}
              style={{ transform: shift(i) }}
              onMouseDown={(e) => {
                if (e.button === 1) onClose(i);
                else if (e.button === 0) {
                  onSelect(i);
                  startDrag(e, i);
                }
              }}
              onContextMenu={(e) => contextMenu(e, tabEntries(v, i))}
            >
              <button
                className="editor-tab-name"
                onClick={() => onSelect(i)}
                title={v.key}
              >
                {/* the file's own icon, from the same seti set the tree uses.
                    Taken from the path rather than the label because a memo's
                    label is its title — the path is what names a file there. */}
                <FileIconSpan name={viewPath(v, root).split("/").pop() ?? ""} />
                <span className={`editor-tab-label ${mark ? `git-${mark.mark}` : ""}`}>
                  {viewLabel(v, memos)}
                </span>
                {/* the two diffs of one file are two tabs, so the label has to
                    tell them apart — spelled out the way Cursor spells it. The
                    glyphs this replaced read as decoration: ✓ said "saved",
                    not "the staged half", and ± said nothing at all */}
                {v.kind === "diff" && (
                  <span
                    className="editor-tab-desc"
                    title={
                      v.staged
                        ? "the staged diff — what committing now would record"
                        : "the unstaged diff — the working tree against the index"
                    }
                  >
                    {v.staged ? "(Index)" : "(Working Tree)"}
                  </span>
                )}
                {/* the letter, the same one the tree and the panel show */}
                {mark && (
                  <span
                    className={`editor-tab-letter git-${mark.mark}`}
                    title={STATUS_NAME[mark.letter] ?? mark.letter}
                  >
                    {mark.letter}
                  </span>
                )}
              </button>
              <button
                className="editor-tab-close"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => onClose(i)}
              >
                ×
              </button>
            </div>
            );
          })}
        </div>
        {/* The path line, on every view again. It went away for a while as the
            file's name said twice — once in the tab and once here — but the
            crumbs before that name are the part nothing else says: which of
            four index.ts you are looking at is a fact about the folders above
            it. The name stays on the end of them because a trail that stops
            short of its file reads as unfinished, and because a file at the
            project's root has no folders at all and the bar would come up
            empty. A thread's line is still the one that also opens something —
            see the click handler. */}
        {views[activeView] && (
          <Breadcrumb
            view={views[activeView]}
            root={root}
            onOpenFile={onOpenFile}
            onRevealInTree={onRevealInTree}
          />
        )}
        <div className="editor-body">
          {views.map((v, i) => (
            <div
              key={v.key}
              className="editor-view"
              style={{ display: i === activeView ? "block" : "none" }}
            >
              {v.kind === "diff" ? (
                // a picture's diff is two pictures; the merge view would show
                // you its bytes as characters
                isImage(v.relPath) ? (
                  <ImageDiffView
                    worktree={v.worktree}
                    relPath={v.relPath}
                    staged={v.staged}
                    from={v.from}
                    visible={i === activeView}
                  />
                ) : (
                  <DiffView
                    worktree={v.worktree}
                    relPath={v.relPath}
                    staged={v.staged}
                    from={v.from}
                    visible={i === activeView}
                  />
                )
              ) : v.kind === "memo" ? (
                <MemoThread
                  root={root}
                  id={v.id}
                  memos={memos}
                  visible={i === activeView}
                  onOpenFile={onOpenFile}
                />
              ) : v.kind === "new" ? (
                <NewFileView
                  root={root}
                  onSaved={(absPath) =>
                    onReplace(i, {
                      kind: "file",
                      key: `file:${absPath}`,
                      absPath,
                    })
                  }
                />
              ) : isImage(v.absPath) ? (
                <ImageView absPath={v.absPath} />
              ) : (
                <FileView
                  absPath={v.absPath}
                  line={v.line}
                  visible={i === activeView}
                  onOpenFile={onOpenFile}
                />
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
