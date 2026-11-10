import { useEffect, useRef, useState } from "react";
import type { Project } from "../App";
import { api } from "../lib/api";
import { useAgentStatus } from "../lib/agentStatus";
import { contextMenu, fileEntries } from "../lib/contextMenu";
import { identicon, useProjectIcons } from "../lib/projectIcon";
import { useTabReorder } from "../lib/tabReorder";
import { useUpdate } from "../lib/update";
import { WhatsNew } from "./WhatsNew";
import { arrivalNotesFrom } from "../lib/releaseNotes";
import { useSettings } from "../lib/settings";
import type { Agent } from "../lib/api";

const sameSet = (a: Set<string>, b: Set<string>) =>
  a.size === b.size && [...a].every((v) => b.has(v));

/** One agent of a project's round, as drawn: finished and already seen,
 *  finished since you last looked, or still working — and whose it is, so
 *  each piece wears its own agent's colour. */
type Piece = { kind: "seen" | "fresh" | "working"; agent: Agent };
const ORDER = { seen: 0, fresh: 1, working: 2 } as const;

const agentLabel = (pieces: Piece[]) => {
  const done = pieces.filter((p) => p.kind !== "working").length;
  const fresh = pieces.filter((p) => p.kind === "fresh").length;
  return (
    `${done} of ${pieces.length} agent${pieces.length === 1 ? "" : "s"} finished` +
    (fresh ? ` · ${fresh} new` : "")
  );
};

/** the ring, cut one arc per agent — for a project with more than one agent
 *  and not all of them finished. 10px across, the same box as the ring. */
function AgentSegments({ pieces }: { pieces: Piece[] }) {
  const list = pieces;
  const C = 5;
  const R = 4.3;
  const gap = 0;
  const step = (2 * Math.PI) / list.length;
  const at = (a: number) => `${(C + R * Math.cos(a)).toFixed(3)} ${(C + R * Math.sin(a)).toFixed(3)}`;
  return (
    <svg className="agent-segs" viewBox="0 0 10 10" aria-hidden="true">
      {list.map(({ kind, agent }, i) => {
        const a0 = -Math.PI / 2 + i * step + gap / 2;
        const a1 = a0 + step - gap;
        const d = `M${at(a0)}A${R} ${R} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${at(a1)}`;
        return kind === "working" ? (
          <g key={i} className={`agent-lamp agent-${agent}`}>
            <path d={d} className="agent-seg working" />
            <path
              d={d}
              className="agent-seg sweep"
              pathLength={100}
              style={{ animationDelay: `${-i * 0.2}s` }}
            />
          </g>
        ) : (
          <path key={i} d={d} className={`agent-seg agent-lamp agent-${agent} ${kind}`} />
        );
      })}
    </svg>
  );
}

/** the same pieces as a 2px line along the foot of the tab */
function AgentLine({ pieces }: { pieces: Piece[] }) {
  return (
    <span className="agent-line" aria-hidden="true">
      {pieces.map(({ kind, agent }, i) => (
        <span key={i} className={`agent-line-seg agent-lamp agent-${agent} ${kind}`} style={{ animationDelay: `${-i * 0.35}s` }} />
      ))}
    </span>
  );
}


export function Titlebar({
  zoom,
  projects,
  activeIdx,
  onSwitch,
  onClose,
  onRename,
  onAddFolder,
  onReorder,
  onPick,
  onSettings,
  locked,
  onLocked,
}: {
  /** the UI zoom, only to say the bar's height in the window's points rather
   *  than the page's — the traffic lights live in the window */
  zoom: number;
  projects: Project[];
  /** rename the tab — the name is the project's, not the folder's, the moment
   *  a project holds more than one folder */
  onRename: (i: number) => void;
  onAddFolder: (i: number) => void;
  activeIdx: number;
  onSwitch: (i: number) => void;
  onClose: (i: number) => void;
  onReorder: (from: number, to: number) => void;
  onPick: () => void;
  onSettings: () => void;
  /** the layout lock — on, panes cannot be picked up and carried */
  locked: boolean;
  onLocked: (on: boolean) => void;
}) {
  const agents = useAgentStatus(projects.map((p) => p.root));
  const icons = useProjectIcons(projects.map((p) => p.root));
  const activeRoot = projects[activeIdx]?.root;
  const { agentMark } = useSettings();

  // "finished" is unread, per agent: the sessions whose finish you have
  // seen, by being in the project. Those draw dim; any finished since draw
  // lit. A finish you were there for is seen as it happens, and a session
  // that starts working again stops being seen, so its next finish is news.
  // A project the strip is meeting for the first time starts read — after a
  // restart the daemon hands back sessions that finished long ago, and a
  // badge for those would announce news that isn't; only a finish this
  // instance watched happen is. "Meeting" is the first poll that names it,
  // not the first render, which comes before any counts at all.
  const [seen, setSeen] = useState<Set<string>>(new Set());
  const known = useRef<Set<string>>(new Set());
  useEffect(() => {
    setSeen((prev) => {
      const next = new Set<string>();
      for (const p of projects) {
        const c = agents[p.root];
        if (!c) continue;
        const all = !known.current.has(p.root) || p.root === activeRoot;
        known.current.add(p.root);
        for (const m of c.members) if (!m.working && (all || prev.has(m.key))) next.add(m.key);
      }
      return sameSet(prev, next) ? prev : next;
    });
  }, [agents, projects, activeRoot]);

  /** what a project's tab has to show, or null for nothing — no agents, or
   *  every one finished and seen */
  const piecesOf = (root: string): Piece[] | null => {
    const c = agents[root];
    if (!c) return null;
    const pieces: Piece[] = c.members.map((m) => ({
      kind: m.working ? "working" : seen.has(m.key) ? "seen" : "fresh",
      agent: m.agent,
    }));
    if (!pieces.some((p) => p.kind !== "seen")) return null;
    return pieces.sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
  };

  const { stripRef, drag, start: startDrag, shift } = useTabReorder(".titlebar-tab", onReorder);

  // Where the bar's middle is, for macOS to put the traffic lights on — see
  // src-tauri/src/traffic_lights.rs. Measured, not computed: styles/frame.css
  // owns the height and a second copy of it here would be a second thing to
  // change.
  // Reported from the element itself rather than on a render App happens to
  // be sure of, because it is only sure of the wrong ones: `restored` and the
  // restored projects land in separate commits, so there is a render where
  // there are projects and still no bar in the document. Asking the element
  // can't be early, and the observer covers every later reason the height
  // moves. Points, not CSS pixels: the zoom is the difference between them.
  //
  // Only when the number changes, though. The observer watches a box, not a
  // height, and the bar's width changes on every frame of a window drag — so
  // reporting each time it fires puts an IPC round trip per frame against
  // buttons that AppKit is already fighting us for, and the traffic lights
  // jitter for the length of the drag. It is the same two-writers-per-frame
  // this was written to end; the guard is what keeps the drag silent.
  const barRef = useRef<HTMLDivElement>(null);
  const said = useRef(0);
  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const report = () => {
      const height = bar.getBoundingClientRect().height * zoom;
      if (Math.abs(height - said.current) < 0.5) return;
      said.current = height;
      // a call that never landed was never said, or the next real change
      // would be the one that stays unsaid
      api.titlebarHeight(height).catch(() => {
        said.current = 0;
      });
    };
    report();
    const watch = new ResizeObserver(report);
    watch.observe(bar);
    return () => watch.disconnect();
  }, [zoom]);

  const { ready, busy, restart } = useUpdate();
  // the update pill's dialog — what the staged version is carrying, with the
  // restart at the bottom of it
  const [notesOpen, setNotesOpen] = useState(false);

  /* The same notes from the other side. An update installs on the way out —
     restart, ⌘Q and reopen, `brew upgrade` — so the reader can perfectly well
     arrive on a new version having never seen the pill that described it, and
     by then there is no staged update left for anything to hang off. So the
     launch asks the question itself: is this newer than the last version whose
     notes were on screen? Only then, and only once, since opening this marks
     it read (see releaseNotes.ts) — which is also why reading them at the pill
     before restarting leaves this silent. */
  const [arrivedFrom, setArrivedFrom] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void arrivalNotesFrom(__APP_VERSION__).then((from) => {
      if (live) setArrivedFrom(from);
    });
    return () => {
      live = false;
    };
  }, []);

  return (
    <div className="titlebar" ref={barRef} data-tauri-drag-region>
      <div className="titlebar-spacer" data-tauri-drag-region />
      <div className={`titlebar-tabs ${drag ? "reordering" : ""}`} ref={stripRef}>
        {projects.map((p, i) => (
          <div
            key={p.root}
            className={`titlebar-tab ${i === activeIdx ? "active" : ""} ${
              drag?.from === i ? "dragging" : ""
            }`}
            style={{ transform: shift(i) }}
            onMouseDown={(e) => {
              // middle-click closes, left click switches and may start a drag
              if (e.button === 1) onClose(i);
              else if (e.button === 0) {
                onSwitch(i);
                startDrag(e, i);
              }
            }}
            // The project's own folder. Nothing here touches the disk: closing
            // a project is a thing you do to the window, renaming one is a
            // thing you do to the tab, and a project you could trash from its
            // tab is a project one slip away from the Trash.
            onContextMenu={(e) =>
              contextMenu(e, [
                { text: "Rename Project…", run: () => void onRename(i) },
                { text: "Add Folder to Project…", run: () => void onAddFolder(i) },
                "sep",
                { text: "Close Project", run: () => onClose(i) },
                "sep",
                ...fileEntries(p.root, { isDir: true, writes: "none" }),
              ])
            }
            title={p.root}
          >
            {/* always rendered, even empty: the fixed-width slot holds either
                the project icon or the activity ring without resizing the tab */}
            <span className="titlebar-tab-status">
              {(() => {
                const c = agents[p.root];
                const pieces = piecesOf(p.root);
                const icon = icons[p.root] ? (
                  <img className="titlebar-tab-icon" src={icons[p.root]} alt="" />
                ) : (
                  // no icon in the repository: one drawn from its path, so
                  // the square is never the odd empty one out
                  <svg className="titlebar-tab-mark" width="13" height="13" viewBox="0 0 5 5">
                    {identicon(p.root).map(
                      (on, n) =>
                        on && (
                          <rect
                            key={n}
                            x={(n % 5) + 0.06}
                            y={Math.floor(n / 5) + 0.06}
                            width="0.88"
                            height="0.88"
                          />
                        ),
                    )}
                  </svg>
                );
                if (!pieces || agentMark === "line") return icon;
                const working = pieces.filter((x) => x.kind === "working").length;
                const total = pieces.length;
                const label = agentLabel(pieces);
                // one agent, or none left working: the whole ring says it —
                // spinning, or closed with the check
                if (total === 1 || working === 0)
                  return (
                    <span className="titlebar-tab-fraction" role="img" aria-label={label} title={label}>
                      <span
                        // the agent's own colour, where the theme gives it one
                        // (subzero.css) and where there is one agent to name
                        className={`agent-ring ${working ? "working" : "done"} ${c?.agent ? `agent-${c.agent}` : ""}`}
                      >
                        {!working && (
                          <svg className="agent-ring-check" viewBox="0 0 10 10" aria-hidden="true">
                            <path
                              d="M2 5.2 4.1 7.2 8 3"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.35"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        )}
                      </span>
                    </span>
                  );
                return (
                  <span className="titlebar-tab-fraction" role="img" aria-label={label} title={label}>
                    <AgentSegments pieces={pieces} />
                  </span>
                );
              })()}
            </span>
            <span className="titlebar-tab-name">{p.name}</span>
            {agentMark === "line" &&
              (() => {
                const pieces = piecesOf(p.root);
                return pieces && <AgentLine pieces={pieces} />;
              })()}
            <button
              className="titlebar-tab-close"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => onClose(i)}
              title="close project"
            >
              {/* drawn rather than the × glyph, which sits off-centre in its
                  em box and never lines up with the status dot. 7 of the
                  viewBox's 9, with the stroke scaled back up so the mark is
                  smaller and not fainter: 1.55 × 7/9 is the 1.2 it drew at
                  full size */}
              <svg width="7" height="7" viewBox="0 0 9 9">
                <path
                  d="M1 1 L8 8 M8 1 L1 8"
                  stroke="currentColor"
                  strokeWidth="1.55"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>
        ))}
      </div>
      {/* the right spacer is empty and still has to be here: it is what
          balances the left one, and two equal spacers are the whole of what
          keeps the tab strip on the window's axis */}
      <div className="titlebar-spacer" data-tauri-drag-region />
      {/* Every control the bar owns, in one cluster pinned to the right inset
          — the 78px the tabs never enter. Out of the flex flow entirely, so
          none of their widths joins the centring math; in flow with each
          other, so they sit in a row and the ＋ can't land on the update pill
          the way two separately pinned buttons could. */}
      <div className="titlebar-right">
        {/* Once there's a version here the wait is already over — the pill
          is a restart and not a download. It looks like the buttons beside
          it and not like an alert, because that is what it is: the update is
          on disk either way, and the only thing being asked is when.

          The click opens the what's-new dialog — every release note between
          this version and the staged one — with the restart at its foot. It
          restarted on the spot for a while, and before that it armed and
          wanted a second click; this is the second click given something to
          be: the first shows what the restart buys, the second takes it.

          Before that it is only ever here for a check someone asked for from
          zero → Check for Updates…, where it is the running commentary a menu
          item owes and not a button — the app's own six-hourly check puts
          nothing here at all. */}
        {(ready || busy) && (
          <button
            className={`titlebar-update ${ready ? "" : "waiting"}`}
            disabled={!ready}
            title={ready ? `what's new in zero ${ready}` : "checking for a newer zero"}
            onClick={() => setNotesOpen(true)}
          >
            {ready && (
              /* an arrow into a tray: the same drawn-not-glyph mark as the
                 tab ✕, at the weight the lock and the ＋ are drawn in */
              <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
                <path
                  d="M6 1.5 L6 7.5 M3.4 5.1 L6 7.7 L8.6 5.1 M2 9.6 L10 9.6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )}
            <span>
              {!ready ? (busy === "downloading" ? "downloading…" : "checking…") : ready}
            </span>
          </button>
        )}
        {/* The layout lock. On, the furniture is fixed: grab pills never arm
            and no pane can be picked up and carried — while everything that
            doesn't rearrange the window stays, splits and divider resizes
            included. It lives here rather than in preferences because a
            state the window can be in has to be readable from wherever you
            are in it: filled means locked. */}
        <button
          className={`titlebar-lock ${locked ? "on" : ""}`}
          title={locked ? "unlock layout" : "lock layout"}
          aria-pressed={locked}
          onClick={() => onLocked(!locked)}
        >
          {/* the window as the tree sees it: one split, drawn on the gear's
              grid at the gear's weight so the three read as one cluster */}
          <svg width="16" height="16" viewBox="0 0 14 14">
            <rect
              x="2.1"
              y="2.6"
              width="9.8"
              height="8.8"
              rx="1.6"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.2"
            />
            <path d="M5.9 2.6 V11.4" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </button>
        <button className="titlebar-add" title="open project (⌘⇧N / ⌘⇧O)" onClick={onPick}>
          {/* drawn on the gear's own 16/14 grid, at the gear's stroke weight,
              for the reason the gear gives below: a ＋ from a font sits where
              its em box puts it, which is not where a drawn glyph's centre
              is, and no amount of centring the button fixes a mark that is
              off-centre inside it */}
          <svg width="16" height="16" viewBox="0 0 14 14">
            <path
              d="M7 2.6 V11.4 M2.6 7 H11.4"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="round"
            />
          </svg>
        </button>
        <button className="titlebar-gear" title="preferences (⌘,)" onClick={onSettings}>
          {/* drawn like the tab close ×: a cog glyph from a font sits
              off-centre in its em box and half of them render as emoji */}
          <svg width="16" height="16" viewBox="0 0 14 14">
            <circle cx="7" cy="7" r="2.8" fill="none" stroke="currentColor" strokeWidth="1.2" />
            <path
              d="M7 2.4 V4.2 M7 9.8 V11.6 M2.4 7 H4.2 M9.8 7 H11.6 M5 5 L3.7 3.7 M9 5 L10.3 3.7 M9 9 L10.3 10.3 M5 9 L3.7 10.3"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>
      {notesOpen && ready && (
        <WhatsNew
          from={__APP_VERSION__}
          to={ready}
          onClose={() => setNotesOpen(false)}
          onRestart={() => void restart()}
        />
      )}
      {/* the catch-up, and never over the top of the pill's own dialog */}
      {arrivedFrom && !(notesOpen && ready) && (
        <WhatsNew
          from={arrivedFrom}
          to={__APP_VERSION__}
          onClose={() => setArrivedFrom(null)}
        />
      )}
    </div>
  );
}
