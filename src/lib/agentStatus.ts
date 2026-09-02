import { useEffect, useState } from "react";
import { api } from "./api";
import type { AgentStat } from "./api";

export interface ProjectAgents {
  /** agent sessions that are still printing, i.e. mid-task */
  working: number;
  /** agent sessions that have gone quiet — done, waiting on you */
  done: number;
}

// Claude Code says which state it's in itself: it retitles the terminal
// (OSC 0) with a spinner glyph while working and ✳ once it's waiting on you
// — a permission prompt included. The backend reads that out of the pty
// stream, and when it has been seen it is believed outright. The two
// thresholds below are the fallback for a session that never set a title,
// guessing from output activity — a guess that flickers, since Claude can go
// quiet mid-task (a silent tool call, a slow API turn) for longer than any
// threshold that still feels responsive.
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
    keys.every((k) => b[k] && a[k].working === b[k].working && a[k].done === b[k].done)
  );
};

/** whether one row reads as mid-task: Claude's own title when it has set
 *  one, the output-activity guess otherwise. Codex does not set Claude's OSC
 *  title, so even if a previous Claude run left one behind a Codex pane is
 *  classified from Codex's output. */
const isWorking = (s: AgentStat) => {
  const active = s.quiet_ms < QUIET_MS && s.burst_ms >= MIN_BURST_MS;
  return s.codex ? active : (s.title_working ?? active);
};

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
      for (const root of key ? key.split("\0") : []) next[root] = { working: 0, done: 0 };
      for (const s of stats) {
        const slot = next[s.cwd];
        if (!slot || !s.running) continue;
        if (isWorking(s)) slot.working++;
        else slot.done++;
      }
      const now = Date.now();
      for (const [root, slot] of Object.entries(next)) {
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

const samePanes = (a: Record<string, PaneAgent>, b: Record<string, PaneAgent>) => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
};

/** The Codex panes, by pty id, each read the way the strip reads them — the
 *  activity guess, held through the gaps the same way. Claude panes are not
 *  here: they say what they are doing in their own title, which xterm hands
 *  each pane directly (see Terminals), and that is both sooner and steadier
 *  than a poll. Codex has no title to read, so the poll is all there is. A
 *  daemon from before the rows carried ids reports nothing here. */
export function useCodexPanes(): Record<string, PaneAgent> {
  const [panes, setPanes] = useState<Record<string, PaneAgent>>({});
  useEffect(() => {
    // when each pane last read as working — the latch
    const held: Record<string, number> = {};
    return subscribe((stats) => {
      const now = Date.now();
      const next: Record<string, PaneAgent> = {};
      for (const s of stats) {
        if (!s.id || !s.codex || !s.running) continue;
        if (isWorking(s)) held[s.id] = now;
        else if (!(held[s.id] && now - held[s.id] < WORKING_HOLD_MS)) delete held[s.id];
        next[s.id] = held[s.id] ? "working" : "done";
      }
      for (const id of Object.keys(held)) if (!next[id]) delete held[id];
      setPanes((prev) => (samePanes(prev, next) ? prev : next));
    });
  }, []);
  return panes;
}
