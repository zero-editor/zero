import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import type { Project } from "../App";
import type { View } from "./Workspace";
import { api, type LinearCycle, type LinearIssue } from "../lib/api";
import { Chevron } from "./Chevron";
import { contextMenu } from "../lib/contextMenu";
import { projectSession, saveProject } from "../lib/session";
import { focusTerm, targetTerm } from "../lib/termFocus";
import {
  DEFAULT_ISSUE_PROMPT,
  ISSUE,
  ISSUES,
  bootCommand,
  composeIssuePrompt,
  composePrompt,
  defaultPrompt,
  inlineCommand,
  issuePromptOf,
  pasteKeys,
} from "../lib/issuePrompt";

/** How often the list is refetched while you're looking at it. A Linear query
 *  is one request of a few kilobytes against a 2500/hour budget, so this could
 *  be far shorter; what stops it is that nothing here changes on a keystroke.
 *  An issue moves when a person moves it, and a minute-old answer to that is
 *  not a stale one. Coming back to the window refetches regardless. */
const POLL_MS = 60_000;

/** Which kinds of state come first. Linear's `position` orders states within a
 *  type but the types themselves have no order in the API, and the one that
 *  matters isn't Linear's anyway: what's underway, then what's waiting, then
 *  what's already gone by. */
const TYPE_ORDER = [
  "started",
  "triage",
  "unstarted",
  "backlog",
  "completed",
  "canceled",
  "duplicate",
];

/** Where a state's kind sorts. Anything Linear adds later lands at the end
 *  rather than at the front, which is what `indexOf` alone would do with its
 *  -1 — a new state type would have silently jumped the queue above "In
 *  Progress". `duplicate` is in the list above because it already did. */
const typeRank = (t: string) => {
  const i = TYPE_ORDER.indexOf(t);
  return i === -1 ? TYPE_ORDER.length : i;
};

/** Grouped by the state itself, not by its kind. "In Progress" and "In Review"
 *  are both `started`, and rolling them into one heading meant a row had to
 *  carry a dot to say which — a column of dots explaining a heading that could
 *  simply have been accurate. Named states are also what Linear's own sidebar
 *  shows, so the two read the same way. */
function group(issues: LinearIssue[]) {
  const by = new Map<string, LinearIssue[]>();
  for (const i of issues) {
    const rows = by.get(i.state);
    if (rows) rows.push(i);
    else by.set(i.state, [i]);
  }
  return [...by]
    .map(([title, rows]) => ({ title, rows, first: rows[0] }))
    .sort(
      (a, b) =>
        typeRank(a.first.stateType) - typeRank(b.first.stateType) ||
        a.first.statePosition - b.first.statePosition ||
        a.title.localeCompare(b.title),
    )
    .map((g) => ({
      title: g.title,
      /** the group's kind, kept for the run button: what a state is *for* is
       *  what its default prompt is written against */
      stateType: g.first.stateType,
      // By urgency, which is what a person means: urgent, high, medium, low,
      // then everything unprioritised. Ties break on most recently touched.
      rows: g.rows.sort(
        (a, b) => URGENCY(a.priority) - URGENCY(b.priority) || b.updatedAt.localeCompare(a.updatedAt),
      ),
    }));
}

// ─── glyphs ──────────────────────────────────────────────────────────────────
// All drawn to the 16px / 1.2-stroke grid the sidebar's own icons use, so a row
// of them reads as one alphabet with the rest of the app.

/** a branch: the same shape as the activity rail's scm icon, minus one node,
 *  because here it means "a branch exists" rather than "source control" */
const BRANCH = (
  <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4">
    <circle cx="5" cy="3.6" r="1.5" />
    <circle cx="5" cy="12.4" r="1.5" />
    <circle cx="11.4" cy="3.6" r="1.5" />
    <path d="M5 5.1v5.8" strokeLinecap="round" />
    <path d="M11.4 5.1c0 3-2.6 3.6-4.9 4" strokeLinecap="round" />
  </svg>
);

/** an open door rather than a folder: a worktree is somewhere you can be, and
 *  the folder glyph is already spoken for by the files tab */
const WORKTREE = (
  <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4">
    <path d="M3.4 13.2V4.3l6-1.5v10.4l-6-1.5Z" strokeLinejoin="round" />
    <path d="M9.4 3.4h3.2v9.2H9.4" strokeLinejoin="round" />
  </svg>
);

/** the pull request arrow — a branch that lands, which is the whole difference
 *  between this and BRANCH above */
const PR = (
  <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4">
    <circle cx="4.6" cy="3.8" r="1.5" />
    <circle cx="4.6" cy="12.2" r="1.5" />
    <path d="M4.6 5.3v5.4" strokeLinecap="round" />
    <path d="M11.4 12.2V6.4a2 2 0 0 0-2-2H7.4" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M9 2.6 7 4.4l2 1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Where a PR's state is a colour rather than a word — the strip has room for
 *  one glyph, not for "merged". The words live in the row's tooltip and in the
 *  issue view, which has the room.
 *
 *  `inReview` is Linear's word and it is the common one here, not `open`; both
 *  mean a pull request that is still going somewhere, so both read green. A
 *  word not in this map keeps the strip's default grey rather than borrowing
 *  a colour that would claim something about it. */
const PR_TONE: Record<string, string> = {
  open: "open",
  inReview: "open",
  draft: "draft",
  merged: "merged",
  closed: "closed",
};

/** the mark on a filter that is on. Drawn rather than a ✓ character, whose
 *  weight and baseline come from whatever font resolves it. */
const TICK = (
  <svg viewBox="0 0 16 16" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3.4 8.6 6.4 11.6 12.6 5.2" />
  </svg>
);

/** play: the run button on a state group. A triangle rather than a spark or a
 *  robot, because what the button promises is "this runs now" — which agent it
 *  reaches is the terminal's business, and the prompt it runs is right there to
 *  be read. Filled, uniquely among these: the others describe a row, this one
 *  does something to it, and an outline at 12px reads as another status mark. */
const RUN = (
  <svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor">
    <path d="M5.4 3.5a.6.6 0 0 1 .92-.5l6.1 4.2a.6.6 0 0 1 0 1l-6.1 4.3a.6.6 0 0 1-.92-.5V3.5Z" />
  </svg>
);

/** Linear's priority scale is 0-for-none rather than 0-for-highest, so sorting
 *  on the raw number puts unprioritised issues above urgent ones. This is the
 *  order a person means by "by urgency". */
const URGENCY = (p: number) => (p === 0 ? 99 : p);

const PRIORITY_NAME = ["No priority", "Urgent", "High", "Medium", "Low"];

/** Three bars, filled from the left, the way Linear draws priority — plus a
 *  filled square for Urgent, which in Linear is a different mark rather than a
 *  fourth bar, because "drop what you are doing" is not the top of a scale.
 *  Unprioritised is three empty bars: present, so the column never collapses
 *  and the identifiers stay in one line down the panel. */
function Priority({ p }: { p: number }) {
  if (p === 1)
    return (
      <span className="li-pri urgent" title={PRIORITY_NAME[1]}>
        <svg viewBox="0 0 16 16" width="11" height="11">
          <rect x="1.5" y="1.5" width="13" height="13" rx="3" fill="currentColor" />
          <rect x="7.1" y="4" width="1.8" height="5.2" rx="0.9" fill="var(--bg)" />
          <rect x="7.1" y="10.6" width="1.8" height="1.9" rx="0.9" fill="var(--bg)" />
        </svg>
      </span>
    );
  // 2 High fills three, 3 Medium two, 4 Low one, 0 none fills none
  const filled = p === 2 ? 3 : p === 3 ? 2 : p === 4 ? 1 : 0;
  return (
    <span className={`li-pri ${filled ? "set" : "none"}`} title={PRIORITY_NAME[p] ?? ""}>
      <svg viewBox="0 0 16 16" width="11" height="11">
        {[
          { x: 1.6, y: 9.4, h: 5.2 },
          { x: 6.4, y: 6.2, h: 8.4 },
          { x: 11.2, y: 3, h: 11.6 },
        ].map((b, i) => (
          <rect
            key={i}
            x={b.x}
            y={b.y}
            width={3.2}
            height={b.h}
            rx={1}
            fill="currentColor"
            opacity={i < filled ? 1 : 0.22}
          />
        ))}
      </svg>
    </span>
  );
}

/** Who it's assigned to, the way Linear shows it: their picture when they have
 *  one, their initials when they don't.
 *
 *  The initials come from Linear rather than from splitting the name here, so
 *  they are spelled the same in both places — "amishkoli123" is AK in Linear
 *  and would be AM if this guessed. The tint behind them is derived from the
 *  name, so one person is one colour without a table of people to maintain.
 *
 *  A picture that fails to load falls back to the initials rather than to a
 *  broken image: these are remote URLs on Linear's CDN, and the network they
 *  need is not the network the panel needed to get this far. */
function Assignee({ issue }: { issue: LinearIssue }) {
  const [broken, setBroken] = useState(false);
  const name = issue.assignee;
  if (!name) return <span className="li-who empty" title="unassigned" />;

  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  const initials = issue.assigneeInitials ?? name.slice(0, 2).toUpperCase();

  if (issue.assigneeAvatar && !broken)
    return (
      <img
        className="li-who"
        src={issue.assigneeAvatar}
        alt={name}
        title={name}
        loading="lazy"
        onError={() => setBroken(true)}
      />
    );
  return (
    <span
      className="li-who"
      title={name}
      style={{ background: `oklch(0.45 0.09 ${h} / 0.5)`, color: `oklch(0.92 0.05 ${h})` }}
    >
      {initials}
    </span>
  );
}

// ─── rows ────────────────────────────────────────────────────────────────────

function IssueRow({
  issue,
  activeKey,
  onOpen,
  onStart,
  onStartMenu,
}: {
  issue: LinearIssue;
  activeKey: string | null;
  onOpen: (i: LinearIssue) => void;
  /** start work on this one in a fresh session */
  onStart: () => void;
  onStartMenu: (e: MouseEvent) => void;
}) {
  const pr = issue.prs[0];
  const local = issue.local;
  // What the checkout says, spelled out — the glyphs are a summary and this is
  // the sentence they summarise, which is what a tooltip is for.
  const said = [
    issue.state,
    issue.assignee ? `assigned to ${issue.assignee}` : "unassigned",
    local.branch ? `branch ${local.branch}` : "no local branch",
    local.worktree ? `worktree ${local.worktree.split("/").pop()}` : null,
    pr ? `${pr.repo}#${pr.number} ${pr.status}${pr.hasConflicts ? ", conflicts" : ""}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    // A row rather than one big button, because the pull request inside it is
    // its own destination: a button cannot legally contain another, and the
    // PR mark needs to be clickable without opening the issue behind it.
    <div
      className={`li-row ${activeKey === `issue:${issue.id}` ? "active" : ""}`}
      title={`${issue.identifier} — ${issue.title}\n${said}`}
      onContextMenu={(e) =>
        contextMenu(e, [
          { text: "Open Issue", run: () => onOpen(issue) },
          { text: "Open in Linear", run: () => api.openUrl(issue.url) },
          pr && { text: `Open ${pr.repo}#${pr.number} on GitHub`, run: () => api.openUrl(pr.url) },
          "sep",
          {
            text: "Copy Branch Name",
            run: () => void navigator.clipboard.writeText(issue.branchName).catch(() => {}),
          },
          {
            text: "Copy Identifier",
            run: () => void navigator.clipboard.writeText(issue.identifier).catch(() => {}),
          },
        ])
      }
    >
      {/* Urgency on the left, the way Linear puts it. The state dot that used
          to sit here is gone: rows are grouped by state and the group's own
          header names it, so the dot was saying a second time what the heading
          already said — and it was spending the one position in the row that
          is read first. */}
      <button className="li-open" onClick={() => onOpen(issue)}>
        <Priority p={issue.priority} />
        <span className="li-id">{issue.identifier}</span>
        <span className="li-title">{issue.title}</span>
      </button>
      {/* Sized to what it holds rather than to a reserved width. It used to
          reserve 46px on every row for marks that, on a repository not using
          Linear's branch names, essentially never appear — so every title in
          the panel was cut short to leave room for nothing. */}
      {(local.branch || pr) && (
        <span className="li-marks">
          {local.worktree ? (
            <span className={`li-mark ${local.current ? "here" : ""}`} title={local.worktree}>
              {WORKTREE}
            </span>
          ) : local.branch ? (
            <span className="li-mark" title={local.branch}>
              {BRANCH}
            </span>
          ) : null}
          {pr && (
            <button
              className={`li-mark pr ${PR_TONE[pr.status] ?? ""}`}
              title={`${pr.repo}#${pr.number} ${pr.status} — open on GitHub`}
              onClick={() => void api.openUrl(pr.url)}
            >
              {PR}
              <span className="li-pr-num">{pr.number}</span>
            </button>
          )}
        </span>
      )}
      {/* Fixed width whether or not anyone is assigned, so the avatars line up
          down the right edge instead of stepping in and out with each row. */}
      <Assignee issue={issue} />
      {/* Over the avatar rather than beside it. The row is ~180px in a default
          sidebar and every pixel of it is spoken for — a button that took its
          own column would come out of the title, on every row, for a control
          that is only ever wanted on the one you are pointing at. So it sits
          in the avatar's place while you hover, and the avatar steps aside;
          who it is assigned to is in the row's own tooltip, and the layout
          does not move. */}
      <button className="li-play" title={`start ${issue.identifier} in a new terminal`} onClick={onStart} onContextMenu={onStartMenu}>
        {RUN}
      </button>
    </div>
  );
}

// ─── the panel ───────────────────────────────────────────────────────────────

type Gate = "loading" | "no-token" | "ready";

/** Which prompt box is open. A group's is that group's alone; an issue's is
 *  the one template every row shares, opened under whichever row asked for it
 *  — so the note in the box has to say that it is shared, or editing it from
 *  one row reads as editing that row. */
type Editing = { kind: "group"; title: string } | { kind: "issue"; id: string };

/** The axes you can narrow by. Not a scope stored anywhere and not a query
 *  sent anywhere: the panel already holds every issue in the window, so a
 *  filter is a predicate over what is on screen. It costs no request, it can
 *  be changed while you read, and it cannot disagree with the list because it
 *  *is* the list. */
interface Filter {
  cycles: string[];
  projects: string[];
  teams: string[];
  people: string[];
  labels: string[];
}

const NO_FILTER: Filter = { cycles: [], projects: [], teams: [], people: [], labels: [] };

const filterCount = (f: Filter) =>
  f.cycles.length + f.projects.length + f.teams.length + f.people.length + f.labels.length;

const UNASSIGNED = "\u2014 unassigned";
const NO_PROJECT = "\u2014 no project";
const NO_CYCLE = "\u2014 no cycle";

/** What the filter calls a cycle: Linear's name for it when someone has given
 *  it one, its number when nobody has — which is the usual case. */
const cycleName = (c: LinearCycle) => c.name || `Cycle ${c.number}`;

/** Where a cycle stands right now — 0 running, 1 still to come, 2 over.
 *
 *  Decided here, from the dates, rather than taken from a flag set when the
 *  list was fetched. The panel holds a list across polls and across a laptop
 *  being shut for a week, and "current" is the one thing about a cycle that
 *  stops being true while nobody is looking. Cycles are per team, so several
 *  can be running at once and each is judged on its own dates.
 */
function cyclePhase(c: LinearCycle, now: number): 0 | 1 | 2 {
  if (now < Date.parse(c.startsAt)) return 1;
  return now < Date.parse(c.endsAt) ? 0 : 2;
}

const PHASE_NOTE = ["current", "upcoming", ""];

function matches(i: LinearIssue, f: Filter, q: string): boolean {
  if (f.cycles.length && !f.cycles.includes(i.cycle ? cycleName(i.cycle) : NO_CYCLE)) return false;
  if (f.projects.length && !f.projects.includes(i.project ?? NO_PROJECT)) return false;
  if (f.teams.length && !f.teams.includes(i.team)) return false;
  if (f.people.length && !f.people.includes(i.assignee ?? UNASSIGNED)) return false;
  if (f.labels.length && !i.labels.some((l) => f.labels.includes(l.name))) return false;
  if (q) {
    const hay = `${i.identifier} ${i.title} ${i.assignee ?? ""}`.toLowerCase();
    // every word, anywhere — so "kraken fund" finds a title that has them
    // apart, which is how people actually half-remember an issue
    if (!q.split(/\s+/).every((w) => hay.includes(w))) return false;
  }
  return true;
}

/** The options one axis offers, with how many issues each would leave. Built
 *  from the issues on screen rather than from a list fetched off Linear, so
 *  the menu can never offer something that matches nothing. */
function options(issues: LinearIssue[], of: (i: LinearIssue) => string[]): [string, number][] {
  const n = new Map<string, number>();
  for (const i of issues) for (const v of of(i)) n.set(v, (n.get(v) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** One axis of the filter. The counts that used to sit beside each option are
 *  gone: they were answering "what would this show?", which mattered when the
 *  choice was saved config you had to get right up front. As a live filter you
 *  just click it and look. */
function FilterGroup({
  title,
  rows,
  on,
  toggle,
  note,
}: {
  title: string;
  rows: [string, number][];
  on: string[];
  toggle: (v: string) => void;
  /** a word after an option that the option's own name can't carry — which
   *  cycle is the one running, and which has yet to start. Dim, and never a
   *  second thing to click. */
  note?: (v: string) => string;
}) {
  // One option is not a choice: every issue on screen already has it, so the
  // row would filter nothing and the heading would name an axis that does no
  // work. This is what keeps "Linear project" out of the menu on a workspace
  // with no projects, and "Team" out of it on a workspace with one team,
  // without either being special-cased.
  if (rows.length < 2) return null;
  return (
    <div className="li-axis-group">
      <div className="li-axis">{title}</div>
      <div className="li-axis-rows">
        {rows.map(([v]) => (
          <button
            key={v}
            className={`li-opt ${on.includes(v) ? "on" : ""}`}
            onClick={() => toggle(v)}
          >
            <span className="li-opt-tick">{TICK}</span>
            <span className="li-opt-name">{v}</span>
            {note?.(v) && <span className="li-opt-note">{note(v)}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * A prompt open for editing — a state group's, or the one every issue row runs.
 *
 * In the panel rather than in Preferences, under the thing it belongs to. What
 * you are editing is a sentence about issues you are looking at, and `note` is
 * load-bearing: it says what the placeholder is about to become. For a group
 * that is a count, and it is the *filtered* count, which is how the filter
 * became half the feature. In a settings dialog neither could be shown.
 *
 * The note comes from the caller because the two subjects differ in a way no
 * flag would capture: a group's box is that group's, while a row's box is one
 * template shared by every row, opened under whichever one asked. Saying so is
 * the note's job, and getting it wrong would read as editing one issue.
 *
 * Empty means default. A prompt you have blanked is one you have no opinion
 * about any more, and the alternative — a saved empty string that quietly
 * neuters the button — has no use worth the confusion.
 */
function PromptEditor({
  value,
  note,
  onChange,
  onCancel,
  onSave,
  onRun,
}: {
  value: string;
  /** what the placeholder becomes, in the caller's own words */
  note: ReactNode;
  onChange: (v: string) => void;
  onCancel: () => void;
  onSave: (body: string) => void;
  onRun: (body: string) => void;
}) {
  return (
    <div className="li-prompt">
      <textarea
        className="li-prompt-box"
        value={value}
        autoFocus
        spellCheck={false}
        rows={9}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onCancel();
          } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onRun(value);
          }
        }}
      />
      {/* Stacked, not a footer row. This is a sidebar: at its default width
          there is room for a line of small text or for three buttons, never
          for both, and side by side the note wrapped to five lines while the
          buttons ran off the edge. */}
      <p className="li-prompt-note">{note}</p>
      <div className="li-prompt-acts">
        <button className="li-btn flat" onClick={onCancel}>
          Cancel
        </button>
        <button className="li-btn" onClick={() => onSave(value)}>
          Save
        </button>
        <button className="li-btn go" onClick={() => onRun(value)} title="save and run · ⌘⏎">
          Run
        </button>
      </div>
    </div>
  );
}

export function IssuesPanel({
  project,
  active,
  activeKey,
  onOpenView,
  onOpenTerminalOn,
}: {
  project: Project;
  active: boolean;
  activeKey: string | null;
  onOpenView: (v: View) => void;
  /** open a terminal already running a command — the workspace owns them */
  onOpenTerminalOn: (boot: string) => void;
}) {
  const root = project.root;
  const [gate, setGate] = useState<Gate>("loading");
  const [issues, setIssues] = useState<LinearIssue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [shut, setShut] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>(NO_FILTER);
  const [filtering, setFiltering] = useState(false);
  const [token, setToken] = useState("");
  /** the run buttons' prompts, by state group — only the edited ones, so a
   *  group missing from here is one still running its default */
  const [prompts, setPrompts] = useState<Record<string, string>>(
    () => projectSession(root).linearPrompts ?? {},
  );
  /** the row's own run button, one template for every issue in the panel */
  const [issuePrompt, setIssuePrompt] = useState<string>(
    () => issuePromptOf(projectSession(root).linearIssuePrompt),
  );
  /** which prompt is open for editing — a state group's, or the shared one an
   *  issue row runs. One at a time, so the panel never has two boxes open
   *  disagreeing about which is the prompt you are looking at. */
  const [editing, setEditing] = useState<Editing | null>(null);
  const [draft, setDraft] = useState("");
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    if (!(await api.linearConnected(root))) {
      if (live.current) setGate("no-token");
      return;
    }
    setBusy(true);
    try {
      const list = await api.linearIssues(root);
      if (!live.current) return;
      setIssues(list);
      setError(null);
      setGate("ready");
    } catch (e) {
      if (live.current) {
        setError(String(e));
        setGate("ready");
      }
    } finally {
      if (live.current) setBusy(false);
    }
  }, [root]);

  useEffect(() => {
    void load();
  }, [load]);

  // Only worth polling while it is the panel on screen. Coming back to the
  // window refetches whatever the interval missed, which is the case that
  // actually matters: a laptop shut for an hour.
  useEffect(() => {
    if (gate !== "ready" || !active) return;
    const t = window.setInterval(() => void load(), POLL_MS);
    const wake = () => void load();
    window.addEventListener("focus", wake);
    return () => {
      window.clearInterval(t);
      window.removeEventListener("focus", wake);
    };
  }, [gate, active, load]);

  const connect = async () => {
    setError(null);
    setBusy(true);
    try {
      await api.linearConnect(root, token.trim());
      setToken("");
      setGate("loading");
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  if (gate === "no-token") {
    return (
      <div className="li-panel">
        <div className="li-empty">
          <p>
            Connect <b>{project.name}</b> to Linear.
          </p>
          <ol className="li-steps">
            <li>
              In Linear, open{" "}
              <button
                className="li-inline"
                onClick={() => void api.openUrl("https://linear.app/settings/account/security")}
              >
                Settings → Security &amp; access
              </button>
            </li>
            <li>Under Personal API keys, create a key</li>
            <li>Paste it below</li>
          </ol>
          <input
            className="li-token"
            type="password"
            placeholder="lin_api_…"
            value={token}
            spellCheck={false}
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && token.trim() && void connect()}
          />
          <div className="li-actions">
            <button className="li-btn" disabled={!token.trim() || busy} onClick={() => void connect()}>
              {busy ? "Checking…" : "Connect"}
            </button>
          </div>
          {error && <p className="li-error">{error}</p>}
        </div>
      </div>
    );
  }

  if (gate === "loading") {
    return (
      <div className="li-panel">
        <div className="li-empty">
          {error ? <p className="li-error">{error}</p> : <p>Loading…</p>}
        </div>
      </div>
    );
  }

  const shown = issues.filter((i) => matches(i, filter, query.trim().toLowerCase()));
  const groups = group(shown);
  const active_n = filterCount(filter);

  /* ---------- the run buttons ----------
     Everything below works on `g.rows`, which is the *filtered* list — so the
     filter is half the feature rather than something the button ignores.
     "Review what's in review and assigned to me" is the assignee axis and this
     button, and no prompt had to know the word "me" for it to work. The
     tooltip and the editor both say "shown" for that reason. */

  type Group = (typeof groups)[number];

  const promptFor = (g: Group) => prompts[g.title] ?? defaultPrompt(g.title, g.stateType);

  /**
   * Open a terminal on a prompt — via a file, so the shell carries a path
   * rather than the prompt itself.
   *
   * `name` becomes the filename, so the command in the scrollback still says
   * which button ran it and re-running is the same line. A failure to write
   * falls back to the prompt inline: a read-only checkout should cost a tidy
   * command line, not the button.
   */
  const launch = async (name: string, prompt: string) => {
    const path = await api.linearPromptFile(root, name, prompt).catch(() => null);
    onOpenTerminalOn(path ? bootCommand(path) : inlineCommand(prompt));
  };

  /** A fresh session, every time — never a paste into whatever is focused.
   *  The status poll cannot tell a Claude waiting at its prompt from one
   *  waiting on a permission dialog (see agentStatus), and a whole triage
   *  instruction typed into a yes/no dialog is a bad afternoon. A run this
   *  size also wants its own scrollback. Pasting is still on the menu, where
   *  choosing it is the person saying they know which session they mean. */
  const runGroup = (g: Group) => void launch(g.title, composePrompt(promptFor(g), g.rows));

  /** Into a session already going, for when the context is loaded and starting
   *  over would be the expensive part. Not submitted — same rule as the issue
   *  view's send button: the last word before an agent starts belongs to the
   *  person. */
  const pasteGroup = (g: Group) => {
    const term = targetTerm();
    if (!term) return;
    api
      .ptyWrite(term, pasteKeys(composePrompt(promptFor(g), g.rows)))
      .then(() => focusTerm(term))
      .catch(() => {});
  };

  const editGroup = (g: Group) => {
    setDraft(promptFor(g));
    setEditing({ kind: "group", title: g.title });
  };

  /** Back to no entry at all rather than to a copy of today's default: a group
   *  running the default should keep running it when the default changes. */
  const savePrompt = (g: Group, body: string) => {
    const next = { ...prompts };
    const clean = body.trim();
    if (!clean || clean === defaultPrompt(g.title, g.stateType).trim()) delete next[g.title];
    else next[g.title] = clean;
    setPrompts(next);
    saveProject(root, { linearPrompts: next });
    setEditing(null);
  };

  /* ---------- the same three verbs, for one row ---------- */

  const runIssue = (i: LinearIssue) =>
    void launch(i.identifier, composeIssuePrompt(issuePrompt, i));

  const pasteIssue = (i: LinearIssue) => {
    const term = targetTerm();
    if (!term) return;
    api
      .ptyWrite(term, pasteKeys(composeIssuePrompt(issuePrompt, i)))
      .then(() => focusTerm(term))
      .catch(() => {});
  };

  /** Back to the default on empty, the same way a group's does. */
  const saveIssuePrompt = (body: string) => {
    const clean = body.trim() || DEFAULT_ISSUE_PROMPT;
    setIssuePrompt(clean);
    saveProject(root, { linearIssuePrompt: clean === DEFAULT_ISSUE_PROMPT ? "" : clean });
    setEditing(null);
  };

  const issueMenu = (e: MouseEvent, i: LinearIssue) =>
    contextMenu(e, [
      { text: "Start in New Terminal", run: () => runIssue(i) },
      // not "Paste into Terminal": the issue view has a button of that name
      // which pastes a reference, and this pastes a whole instruction
      { text: "Paste Start Prompt", run: () => pasteIssue(i), enabled: !!targetTerm() },
      "sep",
      {
        text: "Edit Start Prompt…",
        run: () => {
          setDraft(issuePrompt);
          setEditing({ kind: "issue", id: i.id });
        },
      },
      issuePrompt !== DEFAULT_ISSUE_PROMPT && {
        text: "Reset to Default",
        run: () => saveIssuePrompt(""),
      },
    ]);

  const runMenu = (e: MouseEvent, g: Group) =>
    contextMenu(e, [
      { text: "Run in New Terminal", run: () => runGroup(g) },
      { text: "Paste into Terminal", run: () => pasteGroup(g), enabled: !!targetTerm() },
      "sep",
      { text: "Edit Prompt…", run: () => editGroup(g) },
      prompts[g.title] !== undefined && {
        text: "Reset to Default",
        run: () => savePrompt(g, ""),
      },
    ]);

  const toggle = (axis: keyof Filter) => (v: string) =>
    setFilter((f) => ({
      ...f,
      [axis]: f[axis].includes(v) ? f[axis].filter((x) => x !== v) : [...f[axis], v],
    }));

  // The cycles on screen, by the name the filter uses for them, so the axis
  // can say which one is running without going back to the issues for it.
  const now = Date.now();
  const cycles = new Map<string, LinearCycle>();
  for (const i of issues) if (i.cycle) cycles.set(cycleName(i.cycle), i.cycle);
  const cycleNote = (v: string) => {
    const c = cycles.get(v);
    return c ? PHASE_NOTE[cyclePhase(c, now)] : "";
  };

  // The five axes, each with the options it actually offers. Built once so the
  // groups and the "nothing to filter by" test read the same rows.
  //
  // Cycle first, and not by count: it is the only axis whose answer changes on
  // its own, and "what are we doing this week" is the question people arrive
  // with. Its rows are ordered the way Linear's own sidebar orders them —
  // what's running, what's next, what's been and gone, then everything in no
  // cycle at all — rather than by how many issues each holds, which would put
  // the uncycled backlog on top of the cycle you came for.
  const cycleRows = options(issues, (i) => [i.cycle ? cycleName(i.cycle) : NO_CYCLE]).sort(
    (a, b) => {
      const ca = cycles.get(a[0]);
      const cb = cycles.get(b[0]);
      if (!ca || !cb) return ca ? -1 : cb ? 1 : 0;
      const pa = cyclePhase(ca, now);
      const pb = cyclePhase(cb, now);
      if (pa !== pb) return pa - pb;
      // the soonest of what's coming, the most recent of what's gone
      return pa === 1
        ? Date.parse(ca.startsAt) - Date.parse(cb.startsAt)
        : Date.parse(cb.startsAt) - Date.parse(ca.startsAt);
    },
  );

  const axes: {
    title: string;
    rows: [string, number][];
    key: keyof Filter;
    note?: (v: string) => string;
  }[] = [
    { title: "Cycle", rows: cycleRows, key: "cycles", note: cycleNote },
    { title: "Linear project", rows: options(issues, (i) => [i.project ?? NO_PROJECT]), key: "projects" },
    { title: "Team", rows: options(issues, (i) => [i.team]), key: "teams" },
    { title: "Assignee", rows: options(issues, (i) => [i.assignee ?? UNASSIGNED]), key: "people" },
    { title: "Label", rows: options(issues, (i) => i.labels.map((l) => l.name)), key: "labels" },
  ];

  return (
    <div className="li-panel">
      {/* The search tab's own controls, classes and all, rather than a second
          field built to look like it. Same box, same 8px left column, same
          4px radius — and it stays that way when search.css changes, which a
          copy would not. The chevron does here what it does there: folds the
          extra controls out from under the field. */}
      <div className="search-controls">
        <button
          className={`search-expand ${active_n ? "on" : ""}`}
          title={
            active_n ? `${active_n} filter${active_n > 1 ? "s" : ""} — click to change` : "filter"
          }
          onClick={() => setFiltering((v) => !v)}
        >
          <Chevron open={filtering} />
        </button>
        <div className="search-fields">
          <div className="search-field">
            <input
              className="search-input"
              placeholder={`search ${issues.length} issues`}
              value={query}
              spellCheck={false}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setQuery("")}
            />
            {/* where the search tab keeps Aa and .* — what is narrowing the
                list, and the way to drop it */}
            {active_n > 0 && (
              <div className="search-opts">
                <button
                  className="search-opt on"
                  title={`clear ${active_n} filter${active_n > 1 ? "s" : ""}`}
                  onClick={() => setFilter(NO_FILTER)}
                >
                  {active_n} ✕
                </button>
              </div>
            )}
          </div>

          {/* Under the field and inside its column, which is where the search
              tab puts replace — so the two line up on the left edge by
              construction rather than by a padding chosen to match. */}
          {filtering && (
            <div className="li-filters">
              {axes.map((a) => (
                <FilterGroup
                  key={a.title}
                  title={a.title}
                  rows={a.rows}
                  on={filter[a.key]}
                  toggle={toggle(a.key)}
                  note={a.note}
                />
              ))}
              {!axes.some((a) => a.rows.length > 1) && (
                <p className="li-axis-empty">Nothing to filter by yet.</p>
              )}
            </div>
          )}
        </div>
      </div>

      {error && <p className="li-error">{error}</p>}

      {!groups.length && !error && (
        <div className="li-empty">
          <p>{query || active_n ? "Nothing matches." : "No open issues."}</p>
        </div>
      )}

      {groups.map((g) => (
        <div className="li-group" key={g.title}>
          {/* Two buttons, not one with a button in it: the header folds the
              group and the play runs it, and nesting the second inside the
              first is invalid and behaves like it. The play sits over the
              count the way a row's sits over its avatar — the row is what
              hovers, and nothing moves when it does. */}
          <div className="li-head-row">
            <button
              className="li-head"
              onClick={() =>
                setShut((s) => {
                  const n = new Set(s);
                  if (n.has(g.title)) n.delete(g.title);
                  else n.add(g.title);
                  return n;
                })
              }
            >
              <Chevron open={!shut.has(g.title)} />
              <span className="li-head-title">{g.title}</span>
              <span className="li-count">{g.rows.length}</span>
            </button>
            <button
              className="li-play"
              title={`run this prompt on the ${g.rows.length} issue${
                g.rows.length > 1 ? "s" : ""
              } shown — right-click to edit it`}
              onClick={() => runGroup(g)}
              onContextMenu={(e) => runMenu(e, g)}
            >
              {RUN}
            </button>
          </div>
          {editing?.kind === "group" && editing.title === g.title && (
            <PromptEditor
              value={draft}
              note={
                <>
                  <code>{ISSUES}</code> becomes {g.rows.length} shown
                  {prompts[g.title] === undefined ? " · default" : ""}
                </>
              }
              onChange={setDraft}
              onCancel={() => setEditing(null)}
              onSave={(body) => savePrompt(g, body)}
              onRun={(body) => {
                savePrompt(g, body);
                // an emptied box means "back to the default", and running is
                // then running that rather than running nothing
                const eff = body.trim() || defaultPrompt(g.title, g.stateType);
                void launch(g.title, composePrompt(eff, g.rows));
              }}
            />
          )}
          {!shut.has(g.title) &&
            g.rows.map((i) => (
              <Fragment key={i.id}>
                <IssueRow
                  issue={i}
                  activeKey={activeKey}
                  onOpen={(x) =>
                    onOpenView({
                      kind: "issue",
                      key: `issue:${x.id}`,
                      id: x.id,
                      identifier: x.identifier,
                    })
                  }
                  onStart={() => runIssue(i)}
                  onStartMenu={(e) => issueMenu(e, i)}
                />
                {editing?.kind === "issue" && editing.id === i.id && (
                  <PromptEditor
                    value={draft}
                    note={
                      <>
                        <code>{ISSUE}</code> becomes {i.identifier} · one prompt for every issue
                      </>
                    }
                    onChange={setDraft}
                    onCancel={() => setEditing(null)}
                    onSave={saveIssuePrompt}
                    onRun={(body) => {
                      saveIssuePrompt(body);
                      const eff = body.trim() || DEFAULT_ISSUE_PROMPT;
                      void launch(i.identifier, composeIssuePrompt(eff, i));
                    }}
                  />
                )}
              </Fragment>
            ))}
        </div>
      ))}
    </div>
  );
}
