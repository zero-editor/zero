import { useState } from "react";
import { confirm } from "@tauri-apps/plugin-dialog";
import { api, FileChange } from "../lib/api";
import { contextMenu, fileEntries } from "../lib/contextMenu";
import { FileIconSpan } from "./FileIcon";
import { Chevron } from "./Chevron";
import { pokeGit, STATUS_NAME, useGitStatusMany, WorktreeChanges } from "../lib/gitStatus";
import { baseName, folders, isMulti } from "../lib/folders";
import type { Project } from "../App";
import type { View } from "./Workspace";

type WtState = WorktreeChanges;

/* Small, SF Symbols-inspired action marks. They share the same 14pt optical
   box and rounded hairline stroke, but not the same forced silhouette: undo is
   allowed its broad, calm curve and Open File is a document rather than the
   ambiguous "launch elsewhere" arrow it used to be. */
type ActionIcon = "plus" | "minus" | "revert" | "open";

function Icon({ name }: { name: ActionIcon }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.15"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {name === "plus" && <path d="M7 2v10M2 7h10" />}
      {name === "minus" && <path d="M2 7h10" />}
      {name === "revert" && (
        <g transform="translate(0 -0.45)">
          <path d="M3.15 5.25h4.2a3.6 3.6 0 1 1-3.1 5.42" />
          <path d="m5.65 2.75-2.5 2.5 2.5 2.5" />
        </g>
      )}
      {name === "open" && (
        <>
          <path d="M3.2 2h4.6l3 3v7H3.2z" />
          <path d="M7.8 2v3h3" />
        </>
      )}
    </svg>
  );
}

const STATUS_CLASS: Record<string, string> = {
  M: "mod",
  A: "add",
  U: "add",
  D: "del",
  R: "mod",
};

/**
 * The name to show, and the folder under it. Not every entry names a file:
 * git reports an untracked *directory* it won't descend into — a nested
 * repository — as "nested/", trailing slash and nothing else. Splitting that
 * on the last slash leaves the name empty and the whole path in the folder
 * column, so the trailing slash comes off before the split.
 */
function splitPath(path: string): { name: string; dir: string } {
  const p = path.endsWith("/") ? path.slice(0, -1) : path;
  const cut = p.lastIndexOf("/");
  return cut === -1 ? { name: p, dir: "" } : { name: p.slice(cut + 1), dir: p.slice(0, cut) };
}

export function WorktreePanel({
  project,
  onOpenView,
  onRevealInTree,
  onRemoveFolder,
  active,
  activeKey,
}: {
  project: Project;
  onOpenView: (v: View) => void;
  onRevealInTree: (abs: string) => void;
  /** drop one of the project's own folders — never a worktree of one */
  onRemoveFolder: (dir: string) => void;
  active: boolean;
  /** the shown view's key — the row it belongs to marks itself */
  activeKey: string | null;
}) {
  // the same sweeps the file tree reads, so switching sidebar tabs doesn't
  // cost a fresh round of git processes — and so the two never disagree
  const mine = folders(project);
  const multi = isMulti(project);
  const git = useGitStatusMany(mine, active);
  const worktrees = git.worktrees;
  const [failed, setFailed] = useState<string | null>(null);
  const error = failed ?? git.error;
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [messages, setMessages] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<{ done: number; total: number } | null>(null);

  const toggleCollapsed = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  // through run() like every other action, so the row shows it's working —
  // a remove walks the whole checkout off the disk, which on a big worktree
  // is seconds, and a ✕ that does nothing visible for seconds reads as a hang
  const removeWt = (wt: WtState) =>
    run(`remove:${wt.path}`, async () => {
      try {
        await api.worktreeRemove(project.root, wt.path, false);
      } catch (e) {
        const force = await confirm(
          `Worktree has uncommitted changes:\n${e}\n\nForce delete? Changes will be lost.`,
          { title: "Delete worktree", kind: "warning" }
        );
        if (!force) return;
        await api.worktreeRemove(project.root, wt.path, true);
      }
    });

  const deletable = worktrees.filter((w) => !w.is_main);

  const removeAll = async () => {
    const ok = await confirm(
      `Delete all ${deletable.length} worktree${deletable.length === 1 ? "" : "s"}? Uncommitted changes will be lost.`,
      { title: "Delete all worktrees", kind: "warning" }
    );
    if (!ok) return;
    // one at a time — git serialises writes to the repo's worktree list
    // anyway — but with a running count, so a slow delete looks like work
    // rather than a hang
    for (let i = 0; i < deletable.length; i++) {
      setDeleting({ done: i, total: deletable.length });
      try {
        await api.worktreeRemove(project.root, deletable[i].path, true);
      } catch (e) {
        setFailed(String(e));
        setDeleting(null);
        return;
      }
    }
    setDeleting(null);
    pokeGit();
  };

  // every git action ends the same way: surface failures, then re-read state
  const run = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key);
    setNotice(null);
    try {
      await fn();
      if (ok) setNotice(ok);
    } catch (e) {
      setNotice(String(e).split("\n").slice(0, 3).join(" "));
    } finally {
      setBusy(null);
      pokeGit();
    }
  };

  const stage = (wt: WtState, paths: string[]) => run(`stage:${wt.path}`, () => api.gitStage(wt.path, paths));
  // the sweep that follows sees HEAD move and tells the file tree which
  // folders to read again — the pull itself has nothing to say on success
  const pull = (wt: WtState) => run(`pull:${wt.path}`, () => api.gitPull(wt.path));
  const unstage = (wt: WtState, paths: string[]) =>
    run(`unstage:${wt.path}`, () => api.gitUnstage(wt.path, paths));

  // the one action in this panel that destroys work, so it is also the one
  // that asks first — and for untracked files "discard" means delete, which
  // the question says outright rather than leaving to be discovered
  const discard = async (wt: WtState, files: FileChange[]) => {
    const untracked = files.filter((c) => c.status === "U").map((c) => c.path);
    const tracked = files.filter((c) => c.status !== "U").map((c) => c.path);
    const what =
      files.length === 1
        ? untracked.length
          ? `Delete untracked file ${files[0].path}?`
          : `Discard changes to ${files[0].path}?`
        : `Discard all changes to ${files.length} files?` +
          (untracked.length
            ? ` ${untracked.length} untracked file${untracked.length === 1 ? "" : "s"} will be deleted.`
            : "");
    const ok = await confirm(`${what}\n\nThis cannot be undone.`, {
      title: "Discard changes",
      kind: "warning",
    });
    if (!ok) return;
    run(`discard:${wt.path}`, () => api.gitDiscard(wt.path, tracked, untracked));
  };

  const commit = async (wt: WtState, staged: FileChange[], unstaged: FileChange[]) => {
    const msg = (messages[wt.path] ?? "").trim();
    if (!msg) return;
    await run(
      `commit:${wt.path}`,
      async () => {
        // nothing staged: commit everything, the way ⌘↵ does in Cursor
        if (staged.length === 0) {
          await api.gitStage(wt.path, unstaged.map((c) => c.path));
        }
        await api.gitCommit(wt.path, msg);
        setMessages((m) => ({ ...m, [wt.path]: "" }));
      },
      "committed"
    );
  };

  // With one folder an error is the whole answer. With several it is one
  // folder's answer, and blanking the panel would hide the two that are fine —
  // so it only takes the panel when nothing came back at all.
  if (error && worktrees.length === 0)
    return <div className="panel-error">not a git repo?<br />{error}</div>;

  const fileRow = (wt: WtState, c: FileChange, staged: boolean) => {
    const fileKey = `file:${wt.path}/${c.path}`;
    const diffKey = staged ? `diff:staged:${wt.path}:${c.path}` : `diff:${wt.path}:${c.path}`;
    const abs = `${wt.path}/${c.path}`;
    // lit whichever way it was opened — its diff, or the file via ↗
    const on = activeKey !== null && (activeKey === diffKey || activeKey === fileKey);
    // A deleted row names a file that isn't there any more. Its diff still
    // reads (both sides come out of git), and its reveal still lands on the
    // folder it was in — but there is nothing to open, duplicate or rename.
    const gone = c.status === "D";
    const { name, dir } = splitPath(c.path);
    // One end of a move says so, and says which end it is: a file that left
    // this folder points on, one that arrived points back. Both are drawn as
    // changes rather than as a loss and a stranger — the strikethrough on a
    // path whose contents are sitting one folder over reads as damage.
    const other = c.moved ? splitPath(c.moved).dir : null;
    const place = other === null ? dir : gone ? `${dir} → ${other}` : `${other} → ${dir}`;
    const tone = c.moved ? "mov" : STATUS_CLASS[c.status] ?? "mod";
    return (
    <div
      key={`${wt.path}:${staged ? "s" : "w"}:${c.path}`}
      className={`wt-file ${on ? "on" : ""} ${staged ? "" : "wt-file-unstaged"}`}
      onContextMenu={(e) =>
        contextMenu(e, [
          {
            text: "Open File",
            enabled: !gone,
            run: () => onOpenView({ kind: "file", key: fileKey, absPath: abs }),
          },
          c.status !== "U" && {
            text: staged ? "Open Staged Diff" : "Open Diff",
            run: () =>
              onOpenView({
                kind: "diff",
                key: diffKey,
                worktree: wt.path,
                relPath: c.path,
                staged,
                // a moved file's HEAD side lives at the path it moved from
                from: gone ? undefined : c.moved ?? undefined,
              }),
          },
          { text: "Reveal in Sidebar", run: () => onRevealInTree(abs) },
          "sep",
          staged
            ? { text: "Unstage", run: () => unstage(wt, [c.path]) }
            : { text: "Stage", run: () => stage(wt, [c.path]) },
          !staged && {
            text: c.status === "U" ? "Delete Untracked File" : "Discard Changes",
            run: () => discard(wt, [c]),
          },
          "sep",
          ...fileEntries(abs, { root: wt.path, writes: gone ? "none" : "all" }),
        ])
      }
    >
      <button
        className="wt-file-name"
        title={c.moved ? (gone ? `${c.path} → ${c.moved}` : `${c.moved} → ${c.path}`) : c.path}
        onClick={() =>
          // untracked files have no HEAD side — a diff would just be an
          // all-green copy of the file, so open the file itself like Cursor
          c.status === "U"
            ? onOpenView({
                kind: "file",
                key: fileKey,
                absPath: `${wt.path}/${c.path}`,
              })
            : onOpenView({
                // the two sides are two views of one file, so two tabs — a
                // staged row shows what's staged, a changes row what isn't
                kind: "diff",
                key: diffKey,
                worktree: wt.path,
                relPath: c.path,
                staged,
                // a moved file's HEAD side lives at the path it moved from
                from: gone ? undefined : c.moved ?? undefined,
              })
        }
      >
        <FileIconSpan name={name} />
        <span className={`wt-file-base ${tone}`}>{name}</span>
        <span className="wt-file-dir">{place}</span>
      </button>
      {/* the letter git itself uses, at the row's far end the way Cursor keeps
          it — the same vocabulary as the tree's badge, so the panel and the
          tree say one thing about one file */}
      <span className={`wt-file-letter ${tone}`} title={STATUS_NAME[c.status] ?? c.status}>
        {c.status}
      </span>
      {!staged && (
        <button
          className="wt-file-act wt-file-discard"
          title={c.status === "U" ? "discard (deletes the untracked file)" : "discard changes"}
          onClick={() => discard(wt, [c])}
        >
          <Icon name="revert" />
        </button>
      )}
      <button
        className="wt-file-act"
        title={staged ? "unstage" : "stage"}
        onClick={() => (staged ? unstage(wt, [c.path]) : stage(wt, [c.path]))}
      >
        <Icon name={staged ? "minus" : "plus"} />
      </button>
      <button
        className="wt-file-open"
        title="open file"
        onClick={() =>
          onOpenView({
            kind: "file",
            key: `file:${wt.path}/${c.path}`,
            absPath: `${wt.path}/${c.path}`,
          })
        }
      >
        <Icon name="open" />
      </button>
    </div>
    );
  };

  return (
    <div className="wt-panel">
      {worktrees.map((wt) => {
        const staged = wt.changes.filter((c) => c.staged);
        const unstaged = wt.changes.filter((c) => !c.staged);
        const msg = messages[wt.path] ?? "";
        const open = !collapsed.has(wt.path);
        return (
          <div key={wt.path} className="wt-group">
            <div
              className="wt-header"
              title={wt.path}
              onClick={() => toggleCollapsed(wt.path)}
              // The branch's own checkout — the one folder this group is
              // about. No writing verbs on it: git owns whether a worktree
              // exists, and the ✕ on this row is how it stops existing.
              onContextMenu={(e) =>
                contextMenu(e, [
                  wt.changes.some((c) => !c.staged) && {
                    text: "Stage All Changes",
                    run: () => stage(wt, wt.changes.filter((c) => !c.staged).map((c) => c.path)),
                  },
                  wt.changes.some((c) => c.staged) && {
                    text: "Unstage All",
                    run: () => unstage(wt, wt.changes.filter((c) => c.staged).map((c) => c.path)),
                  },
                  !wt.is_main && {
                    text: "Delete Worktree",
                    enabled: busy !== `remove:${wt.path}`,
                    run: () => removeWt(wt),
                  },
                  // Only on a folder the project was given, and never on the
                  // root — this drops it from the project, which is nothing
                  // like the Delete Worktree above it that walks a checkout
                  // off the disk.
                  wt.path !== project.root &&
                    mine.includes(wt.path) && {
                      text: "Remove from Project",
                      run: () => onRemoveFolder(wt.path),
                    },
                  "sep",
                  ...fileEntries(wt.path, { root: project.root, isDir: true, writes: "none" }),
                ])
              }
            >
              <Chevron open={open} className="wt-chevron" />
              {/* The folder's own name, and only when there is more than one
                  to tell apart: three repositories all sitting on `main` are
                  three rows that otherwise read identically. A one-folder
                  project shows the branch alone, exactly as it always has. */}
              {multi && <span className="wt-folder">{baseName(wt.path)}</span>}
              <span className="wt-branch">{wt.branch || "(no branch)"}</span>
              <span className="wt-count">{wt.changes.length || ""}</span>
              {/* How far the upstream has moved on, and the way to catch up.
                  Only when there is something to catch up on: a row that is
                  level with its remote says nothing, which is most rows most
                  of the time. */}
              {wt.behind > 0 && (
                <button
                  className={`wt-behind ${busy === `pull:${wt.path}` ? "busy" : ""}`}
                  title={`${wt.behind} commit${wt.behind === 1 ? "" : "s"} behind upstream — pull`}
                  disabled={busy === `pull:${wt.path}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    pull(wt);
                  }}
                >
                  {busy === `pull:${wt.path}` ? "…" : `↓${wt.behind}`}
                </button>
              )}
              {!wt.is_main && (
                <button
                  className={`wt-delete ${busy === `remove:${wt.path}` ? "busy" : ""}`}
                  title="delete worktree"
                  disabled={busy === `remove:${wt.path}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    removeWt(wt);
                  }}
                >
                  {busy === `remove:${wt.path}` ? "…" : "✕"}
                </button>
              )}
            </div>

            {open && wt.changes.length > 0 && (
              <div className="wt-commit">
                <textarea
                  className="wt-msg"
                  rows={1}
                  placeholder={`message (⌘↵ to commit on ${wt.branch || "HEAD"})`}
                  value={msg}
                  onChange={(e) => setMessages((m) => ({ ...m, [wt.path]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      commit(wt, staged, unstaged);
                    }
                  }}
                />
                <button
                  className="wt-commit-btn"
                  disabled={!msg.trim() || busy === `commit:${wt.path}`}
                  onClick={() => commit(wt, staged, unstaged)}
                >
                  {staged.length > 0 ? `commit ${staged.length}` : "commit all"}
                </button>
              </div>
            )}

            {open && staged.length > 0 && (
              <>
                <div className="wt-section">
                  <span>staged</span>
                  <button
                    className="wt-section-all"
                    title={`unstage all ${staged.length}`}
                    onClick={() => unstage(wt, staged.map((c) => c.path))}
                  >
                    <Icon name="minus" />
                  </button>
                </div>
                {staged.map((c) => fileRow(wt, c, true))}
              </>
            )}

            {open && unstaged.length > 0 && (
              <>
                {/* the header carries stage-all, so it shows whenever there is
                    anything to stage — not only once something already is */}
                <div className="wt-section">
                  <span>changes</span>
                  <button
                    className="wt-section-all"
                    title={`discard all ${unstaged.length}`}
                    onClick={() => discard(wt, unstaged)}
                  >
                    <Icon name="revert" />
                  </button>
                  <button
                    className="wt-section-all"
                    title={`stage all ${unstaged.length}`}
                    onClick={() => stage(wt, unstaged.map((c) => c.path))}
                  >
                    <Icon name="plus" />
                  </button>
                </div>
                {unstaged.map((c) => fileRow(wt, c, false))}
              </>
            )}
          </div>
        );
      })}
      {notice && (
        <div className="wt-notice" onClick={() => setNotice(null)}>
          {notice}
        </div>
      )}
      {deletable.length > 0 && (
        <button
          className={`wt-delete-all ${deleting ? "busy" : ""}`}
          disabled={deleting !== null}
          title={`delete all ${deletable.length} worktrees`}
          onClick={removeAll}
        >
          {deleting ? `deleting ${deleting.done + 1}/${deleting.total}…` : "delete all"}
        </button>
      )}
    </div>
  );
}
