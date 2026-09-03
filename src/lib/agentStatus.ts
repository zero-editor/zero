import { useEffect, useState } from "react";
import { api } from "./api";
import type { Agent, AgentStat } from "./api";

export interface ProjectAgents {
  /** agent sessions that are still printing, i.e. mid-task */
  working: number;
  /** agent sessions that have gone quiet — done, waiting on you */
  done: number;
  /** whose the ring is: the one agent behind the count that shows — the
   *  working ones while any is, the finished ones otherwise. Null when
   *  there is none, or when they are of different kinds, which has no one
   *  colour and falls back to the default. */
  agent: Agent | null;
}

// Claude Code and omp say which state they're in themselves: each retitles
// the terminal (OSC 0) with a spinner glyph while working and a mark of its
// own once it's waiting on you — a permission prompt included. The backend
// reads that out of the pty stream, and when it has been seen it is believed
// outright. The two thresholds below are the fallback for a session that
// never set a title — Codex and pi never do — guessing from output activity:
// a guess that flickers, since an agent can go quiet mid-task (a silent tool
// call, a slow API turn) for longer than any threshold that still feels
// responsive.
const QUIET_MS = 1500;

// Focus changes and resizes make Claude repaint its UI, which is a single
// short burst of output. Real work keeps the output coming, so a run has to
// last this long before it counts as working.
const MIN_BURST_MS = 600;

// How long "working" outlives the reading that said so.
//
// Both readings above flicker, and for the same reason: work is bursty. A tool
// call, a slow API turn, a pause between paragraphs — each is a silence long
// enough to pass QUIET_MS, and burst_ms restarts at zero the moment output
// resumes, so a session that never stopped working reads as finished again on
// the way back up. The title is steadier but not steady: it is None for any
// title that isn't Claude's, which is what a subcommand retitling the terminal
// looks like, and None falls straight back to the guess.
//
// Untreated that puts several working→done→working round trips in a single
// task, and the tab strip strobes for the length of it. So working latches: a
// project that reads as working keeps that reading until it has read otherwise
// for this long. Only one of the two transitions is ever waited on — finishing
// — and being three seconds late on that is cheaper than a flicker throughout.
const WORKING_HOLD_MS = 3000;

const sameStatus = (a: Record<string, ProjectAgents>, b: Record<string, ProjectAgents>) => {
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every(
      (k) => b[k] && a[k].working === b[k].working && a[k].done === b[k].done && a[k].agent === b[k].agent
    )
  );
};

/** which agent a row holds, read the way the daemon that wrote it meant:
 *  one from before rows named their agent knew Codex from Claude and
 *  nothing else */
export const agentOf = (s: AgentStat): Agent | null =>
  s.agent ?? (s.codex ? "codex" : s.running ? "claude" : null);

/** the agents that say what they are doing in their own terminal title;
 *  the rest are read from output activity alone */
const TITLED: readonly (Agent | null)[] = ["claude", "omp"];

/** whether one row reads as mid-task: the agent's own title when it has set
 *  one, the output-activity guess otherwise. Codex and pi never set a title
 *  with a state in it, so even if a previous Claude run left one behind
 *  their panes are classified from their output. */
const isWorking = (s: AgentStat) => {
  const active = s.quiet_ms < QUIET_MS && s.burst_ms >= MIN_BURST_MS;
  return TITLED.includes(agentOf(s)) ? (s.title_working ?? active) : active;
};

const isSpinner = (c: string) => c >= "\u2800" && c <= "\u28ff";

/** What a terminal title says about the agent that set it — the same
 *  reading the daemon makes (ptyd/server.rs, `classify_title`), for the
 *  pane that gets its titles straight from xterm. ✳ is Claude idle at its
 *  prompt and the half-circle family its spinner; omp puts its state in
 *  the separator after its brand, `π ⠋ label` working and `π > label` or
 *  `π ! label` waiting on you; a leading braille frame is a spinner from
 *  anyone (pi's titlebar extension). Any other title — the shell's own, a
 *  subcommand's — means no agent to speak of. */
export function titleState(title: string): PaneAgent | null {
  const t = title.trimStart();
  const c = t[0];
  if (c === undefined) return null;
  if (c === "✳") return "done";
  if ((c >= "◐" && c <= "◓") || isSpinner(c)) return "working";
  if (c === "π" && t[1] === " ") {
    const sep = t[2];
    if (sep === ">" || sep === "!") return "done";
    if (sep !== undefined && isSpinner(sep)) return "working";
  }
  return null;
}

// One poll for everyone who reads it. Each poll is a `ps` sweep in the
// daemon, so two readers — the tab strip and the panes — share the interval
// rather than each running their own; it runs while anyone is subscribed.
type Listener = (stats: AgentStat[]) => void;
const listeners = new Set<Listener>();
let timer: number | null = null;

const poll = async () => {
  const stats = await api.agentStatus().catch(() => []);
  for (const fn of listeners) fn(stats);
};

function subscribe(fn: Listener) {
  listeners.add(fn);
  if (listeners.size === 1) {
    poll();
    timer = window.setInterval(poll, 1000);
  }
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0 && timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
  };
}

export function useAgentStatus(roots: string[]): Record<string, ProjectAgents> {
  const [byRoot, setByRoot] = useState<Record<string, ProjectAgents>>({});
  const key = roots.join("\0");

  useEffect(() => {
    // the latch: per project, the last reading that said working and when it
    // landed. Local to the effect, so a change to the project list starts
    // everyone clean rather than holding a reading on behalf of a project that
    // has moved.
    const held: Record<string, { at: number; stat: ProjectAgents }> = {};
    return subscribe((stats) => {
      const next: Record<string, ProjectAgents> = {};
      // which agents are behind each count, to name the one when it is one
      const by: Record<string, { working: Set<Agent>; done: Set<Agent> }> = {};
      for (const root of key ? key.split("\0") : []) {
        next[root] = { working: 0, done: 0, agent: null };
        by[root] = { working: new Set(), done: new Set() };
      }
      for (const s of stats) {
        const slot = next[s.cwd];
        const agent = agentOf(s);
        if (!slot || !agent || !s.running) continue;
        if (isWorking(s)) {
          slot.working++;
          by[s.cwd].working.add(agent);
        } else {
          slot.done++;
          by[s.cwd].done.add(agent);
        }
      }
      const now = Date.now();
      for (const [root, slot] of Object.entries(next)) {
        const who = slot.working > 0 ? by[root].working : by[root].done;
        if (who.size === 1) slot.agent = who.values().next().value ?? null;
        if (slot.working > 0) held[root] = { at: now, stat: slot };
        // A quiet agent is held; a closed one isn't. The hold covers the gap
        // between two bursts, and a session that has gone away has no next
        // burst — so it drops the moment the count does.
        else if (slot.done > 0 && held[root] && now - held[root].at < WORKING_HOLD_MS)
          next[root] = held[root].stat;
        else delete held[root];
      }
      // Same counts, same object. This polls once a second, and every fresh
      // object was a re-render of the whole tab strip — plus the seen-badge
      // effect hanging off it — for a second in which nothing had changed.
      setByRoot((prev) => (sameStatus(prev, next) ? prev : next));
    });
  }, [key]);

  return byRoot;
}

export type PaneAgent = "working" | "done";

export interface AgentPane {
  agent: Agent;
  /** what the poll reads the agent as doing — only for the agents that
   *  never set a title with a state in it; null for the ones that do,
   *  whose pane reads the title itself */
  state: PaneAgent | null;
}

const samePanes = (a: Record<string, AgentPane>, b: Record<string, AgentPane>) => {
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((k) => b[k] && a[k].agent === b[k].agent && a[k].state === b[k].state)
  );
};

/** The panes holding an agent, by pty id: which agent, and — for Codex and
 *  pi, which have no title to read — what it is doing, read the way the
 *  strip reads them: the activity guess, held through the gaps the same
 *  way. Claude and omp panes carry no state here: they say what they are
 *  doing in their own title, which xterm hands each pane directly (see
 *  Terminals), and that is both sooner and steadier than a poll. A daemon
 *  from before the rows carried ids reports nothing here. */
export function useAgentPanes(): Record<string, AgentPane> {
  const [panes, setPanes] = useState<Record<string, AgentPane>>({});
  useEffect(() => {
    // when each pane last read as working — the latch
    const held: Record<string, number> = {};
    return subscribe((stats) => {
      const now = Date.now();
      const next: Record<string, AgentPane> = {};
      for (const s of stats) {
        const agent = agentOf(s);
        if (!s.id || !agent || !s.running) continue;
        if (TITLED.includes(agent)) {
          next[s.id] = { agent, state: null };
          continue;
        }
        if (isWorking(s)) held[s.id] = now;
        else if (!(held[s.id] && now - held[s.id] < WORKING_HOLD_MS)) delete held[s.id];
        next[s.id] = { agent, state: held[s.id] ? "working" : "done" };
      }
      for (const id of Object.keys(held)) if (!next[id]?.state) delete held[id];
      setPanes((prev) => (samePanes(prev, next) ? prev : next));
    });
  }, []);
  return panes;
}
