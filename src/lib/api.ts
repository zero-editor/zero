import { invoke } from "@tauri-apps/api/core";
import type { ResolvedPath } from "./termLinks";

export interface RecentProject {
  path: string;
  name: string;
}

export interface Worktree {
  path: string;
  branch: string;
  is_main: boolean;
}

export interface FileChange {
  path: string;
  status: string;
  staged: boolean;
  /** the other end of a move: where a deletion went, or where an arrival came
      from. Null for the rows that are only what they look like. */
  moved: string | null;
}

export interface BranchInfo {
  branch: string;
  upstream: boolean;
  ahead: number;
  behind: number;
}

export interface Baseline {
  content: string;
  /** false when HEAD has no such file — a new file, which gets no change bars */
  tracked: boolean;
}

export interface DirEntry {
  name: string;
  is_dir: boolean;
  /** the repository ignores it — shown greyed out */
  ignored: boolean;
}

/** a path handed to the app from outside, placed — see src-tauri/src/opens.rs */
export interface OpenTarget {
  path: string;
  dir: boolean;
  /** the project it belongs under: itself for a folder, the enclosing git
      repository for a file, or its parent folder outside one */
  root: string;
}

/** the coding agents the daemon recognises under a shell */
export type Agent = "claude" | "codex" | "pi" | "omp";

export interface AgentStat {
  /** the pty id the pane spawned it under. Missing from a daemon older
      than the field, which the app goes on joining across an update. */
  id?: string;
  cwd: string;
  running: boolean;
  /** which agent is running. Missing from a daemon older than the field,
      which said only whether it was Codex — see `codex`. */
  agent?: Agent;
  /** the older daemon's word: a Codex process is present */
  codex?: boolean;
  quiet_ms: number;
  burst_ms: number;
  /** the agent's own terminal title: true mid-task, false waiting on you,
      null when no title with a state in it has been seen and only the
      timing fields are left to guess from */
  title_working: boolean | null;
}

export interface SearchQuery {
  text: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  /** comma-separated globs; empty means every file */
  include: string;
  exclude: string;
}

export interface SearchSpan {
  /** offsets into `SearchLine.text`, in the units a JS string is indexed by */
  start: number;
  end: number;
  /** which match this is within its line — names one match to replace */
  nth: number;
}

export interface SearchLine {
  line: number;
  /** the line as shown: indentation dropped, long lines cut */
  text: string;
  spans: SearchSpan[];
}

export interface SearchFile {
  path: string;
  /** every match in the file, which can be more than `lines` lists */
  count: number;
  lines: SearchLine[];
}

export interface SearchResult {
  files: SearchFile[];
  matches: number;
  truncated: boolean;
}

/** a whole file when `line` is absent, one match when it isn't */
export interface ReplaceTarget {
  path: string;
  line?: number;
  nth?: number;
}

/** whether this machine can do memos at all — the OS is too old, or the helper
 *  binary was never built. `message` is written for the panel to show verbatim. */
export interface MemoProbe {
  supported: boolean;
  message: string | null;
}

/** One name per checkpoint in the pipeline. The two `_failed` ones are the only
 *  states that wait for a person; every other stalled state resumes itself. */
export type MemoStatus =
  | "recording"
  | "recorded"
  | "transcribing"
  | "transcribed"
  | "cleaning"
  | "ready"
  | "transcribe_failed"
  | "cleanup_failed";

export interface Memo {
  /** the filename stem — audio, raw transcript, cleaned memo and json share it */
  id: string;
  /** the cleaned memo's first line, once there is a cleaned memo */
  title: string | null;
  created: string;
  duration_s: number;
  status: MemoStatus;
  /** the audio's filename: m4a normally, caf when conversion failed */
  audio: string | null;
  /** waiting its turn in the one global job queue — never written to disk */
  queued: boolean;
  /** how many follow-ups have been recorded on top of it, 0 for a memo said
   *  once. Names the newest take's files, and says `merging…` for `cleaning…` */
  takes: number;
  /** While `recording`, when *this* recording started — the memo's own
   *  `created` for a first one, the take's for a follow-up; null otherwise.
   *  The elapsed timer counts from here, because a take's row would otherwise
   *  count from the memo's age. */
  recording_since: string | null;
  /** The mic is held but not listening. Only meaningful while `recording`.
   *  `recording_since` stays where it was for the length of a pause and the
   *  backend rebases it on resume, so `now - recording_since` is always the
   *  honest recorded time and never counts the silence — which is why this
   *  side only has to stop the clock rather than keep books on it. */
  paused: boolean;
  error: string | null;
  /** the error is claude saying it has no usable login — the one failure a
   *  button can fix, by opening a terminal on `claude /login` */
  needs_login: boolean;
}

export const api = {
  /** print to the stdout of `tauri dev` — the webview console isn't forwarded */
  debugLog: (msg: string) => invoke<void>("debug_log", { msg }),
  agentStatus: () => invoke<AgentStat[]>("agent_status"),
  /** how tall the top bar is in window points, so macOS's traffic lights can
   *  be put on its axis — see src-tauri/src/traffic_lights.rs */
  titlebarHeight: (height: number) => invoke<void>("titlebar_height", { height }),
  /** tell WindowServer whether this window still needs per-frame blending —
   *  opaque whenever glass is off, see src-tauri/src/opaque.rs */
  setOpaque: (opaque: boolean) => invoke<void>("set_opaque", { opaque }),
  getRecents: () => invoke<RecentProject[]>("get_recents"),
  addRecent: (path: string) => invoke<void>("add_recent", { path }),
  removeRecent: (path: string) => invoke<void>("remove_recent", { path }),
  existingDirs: (paths: string[]) => invoke<string[]>("existing_dirs", { paths }),
  /* The window's layout, held as a file by the Rust side rather than in
     localStorage — see src-tauri/src/session.rs for why that matters at ⌘Q.
     The blob is JSON this side wrote and this side parses; nothing over there
     looks inside it. */
  sessionLoad: () => invoke<string | null>("session_load"),
  sessionSave: (json: string) => invoke<void>("session_save", { json }),
  openUrl: (url: string) => invoke<void>("open_url", { url }),
  revealPath: (path: string) => invoke<void>("reveal_path", { path }),
  resolvePaths: (cwd: string, paths: string[]) =>
    invoke<ResolvedPath[]>("resolve_paths", { cwd, paths }),
  /* The four verbs the right-click menu adds. Each resolves with the path it
     made, so the caller can open what it just asked for; each rejects rather
     than overwriting anything, with a message written to be shown as-is. */
  createEntry: (dir: string, name: string, folder: boolean) =>
    invoke<string>("create_entry", { dir, name, folder }),
  /** within the folder it's already in — `name` is one component, not a path */
  renameEntry: (path: string, name: string) => invoke<string>("rename_entry", { path, name }),
  duplicateEntry: (path: string) => invoke<string>("duplicate_entry", { path }),
  /** the real Trash, so Finder can Put Back what this took away */
  trashEntry: (path: string) => invoke<void>("trash_entry", { path }),
  worktrees: (root: string) => invoke<Worktree[]>("git_worktrees", { root }),
  worktreeRemove: (root: string, path: string, force: boolean) =>
    invoke<void>("git_worktree_remove", { root, path, force }),
  gitStatus: (worktree: string) => invoke<FileChange[]>("git_status", { worktree }),
  gitStage: (worktree: string, paths: string[]) => invoke<void>("git_stage", { worktree, paths }),
  gitUnstage: (worktree: string, paths: string[]) => invoke<void>("git_unstage", { worktree, paths }),
  /** tracked paths return to the index's copy; untracked ones are deleted */
  gitDiscard: (worktree: string, tracked: string[], untracked: string[]) =>
    invoke<void>("git_discard", { worktree, tracked, untracked }),
  gitCommit: (worktree: string, message: string) =>
    invoke<string>("git_commit", { worktree, message }),
  gitPush: (worktree: string) => invoke<string>("git_push", { worktree }),
  branchInfo: (worktree: string) => invoke<BranchInfo>("git_branch_info", { worktree }),
  headFile: (worktree: string, path: string) => invoke<string>("git_head_file", { worktree, path }),
  /** the staged copy — the base a working-tree diff is measured against */
  indexFile: (worktree: string, path: string) => invoke<string>("git_index_file", { worktree, path }),
  /** either side of a diff as raw bytes, for the files the two above would
   *  hand back as replacement characters — `rev` is "HEAD" or "" for the index */
  showBinary: (worktree: string, rev: "HEAD" | "", path: string) =>
    invoke<ArrayBuffer>("git_show_binary", { worktree, rev, path }),
  gitBaseline: (path: string) => invoke<Baseline>("git_baseline", { path }),
  listDir: (path: string) => invoke<DirEntry[]>("list_dir", { path }),
  /** the folder picker the dev build has to use — see `pick_directory` */
  pickDirectory: (title: string) => invoke<string | null>("pick_directory", { title }),
  /** the file picker the dev build has to use, for the same reason */
  pickFile: (title: string, extensions: string[]) =>
    invoke<string | null>("pick_file", { title, extensions }),
  /** what each path is and which project it belongs to; missing paths dropped */
  classifyOpens: (paths: string[]) => invoke<OpenTarget[]>("classify_opens", { paths }),
  /** drain the files macOS has handed over since the last drain */
  takeOpenPaths: () => invoke<string[]>("take_open_paths"),
  projectFiles: (root: string) => invoke<string[]>("list_project_files", { root }),
  searchProject: (root: string, query: SearchQuery) =>
    invoke<SearchResult>("search_project", { root, query }),
  replaceMatches: (root: string, query: SearchQuery, replacement: string, targets: ReplaceTarget[]) =>
    invoke<number>("replace_matches", { root, query, replacement, targets }),
  readFile: (path: string) => invoke<string>("read_file", { path }),
  /** raw bytes, for files that aren't text — arrives as an ArrayBuffer */
  readBinary: (path: string) => invoke<ArrayBuffer>("read_binary", { path }),
  writeFile: (path: string, content: string) => invoke<void>("write_file", { path, content }),
  memoProbe: () => invoke<MemoProbe>("memo_probe"),
  /** also reconciles what's on disk and restarts any pipeline that stalled */
  memoList: (root: string) => invoke<Memo[]>("memo_list", { root }),
  /** resolves with the memo's id; the mic is one resource, so this fails while
   *  any project is recording. `into` is a finished memo to record a follow-up
   *  onto — the id that comes back is then that memo's, because a take is
   *  another recording of it rather than a memo of its own */
  memoRecordStart: (root: string, into?: string) =>
    invoke<string>("memo_record_start", { root, into: into ?? null }),
  memoRecordStop: () => invoke<void>("memo_record_stop"),
  /** Copies an audio file recorded somewhere else into the pipeline — as a new
   *  memo, or with `into` as a follow-up onto a finished one — and resolves
   *  with the memo's id, exactly as `memoRecordStart` does. Converted to m4a on
   *  the way in; a file that isn't audio fails here with the converter's
   *  reason. The source file is never touched. */
  memoImport: (root: string, path: string, into?: string) =>
    invoke<string>("memo_import", { root, path, into: into ?? null }),
  /* The mic is one resource, so the three below take no arguments: there is one
     recording to act on and the backend already knows which it is. Same shape
     as `memoRecordStop`, for the same reason. */
  memoRecordPause: () => invoke<void>("memo_record_pause"),
  memoRecordResume: () => invoke<void>("memo_record_resume"),
  /** Throws the recording away: a first one goes with it, a follow-up leaves
   *  the memo it was being said onto exactly as `ready` as it was. */
  memoRecordCancel: () => invoke<void>("memo_record_cancel"),
  /** re-runs exactly the stage that failed, from its surviving checkpoint */
  memoRetry: (root: string, id: string) => invoke<void>("memo_retry", { root, id }),
  memoDelete: (root: string, id: string) => invoke<void>("memo_delete", { root, id }),
  /** creates the file with its seed if it isn't there yet */
  memoVocabularyPath: (root: string) => invoke<string>("memo_vocabulary_path", { root }),
  /** the project's scratch note, made on the first ask along with the
   *  `FORMAT.md` beside it; resolves with its absolute path */
  noteOpen: (root: string) => invoke<string>("note_open", { root }),
  /** One pasted passage, tidied. Rejects with the reason for every failure —
   *  no claude, a timeout, a paste too big — and the caller answers all of
   *  them the same way, by keeping what was pasted. */
  noteFormat: (root: string, text: string) => invoke<string>("note_format", { root, text }),
  ptyKillAll: () => invoke<void>("pty_kill_all"),
  /** end every session no restored layout claims — the boot sweep */
  ptyReap: (keep: string[]) => invoke<void>("pty_reap", { keep }),
  ptySpawn: (id: string, cwd: string, cols: number, rows: number) =>
    invoke<void>("pty_spawn", { id, cwd, cols, rows }),
  ptyWrite: (id: string, data: string) => invoke<void>("pty_write", { id, data }),
  ptyResize: (id: string, cols: number, rows: number) => invoke<void>("pty_resize", { id, cols, rows }),
  ptyKill: (id: string) => invoke<void>("pty_kill", { id }),
};
