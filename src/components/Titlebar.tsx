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

const sameSet = (a: Set<string>, b: Set<string>) =>
  a.size === b.size && [...a].every((v) => b.has(v));


export function Titlebar({
  zoom,
  projects,
  activeIdx,
  onSwitch,
  onClose,
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

  // "finished" is an unread badge: being in the project reads it, and only a
  // session starting work again makes it unread once more. A project the strip
  // is meeting for the first time starts read — after a restart the daemon
  // hands back sessions that finished long ago, and a badge for those would
  // announce news that isn't; only a finish this instance watched happen is.
  const [seen, setSeen] = useState<Set<string>>(new Set());
  const known = useRef<Set<string>>(new Set());
  useEffect(() => {
    setSeen((prev) => {
      const next = new Set(prev);
      for (const p of projects) {
        if (!known.current.has(p.root)) {
          known.current.add(p.root);
          next.add(p.root);
        }
        if (p.root === activeRoot) next.add(p.root);
        else if ((agents[p.root]?.working ?? 0) > 0) next.delete(p.root);
      }
      return sameSet(prev, next) ? prev : next;
    });
  }, [agents, projects, activeRoot]);

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
            // The project's own folder. Nothing here writes: closing a project
            // is a thing you do to the window, and a project you could trash
            // from its tab is a project one slip away from the Trash.
            onContextMenu={(e) =>
              contextMenu(e, [
                { text: "Close Project", run: () => onClose(i) },
                "sep",
                ...fileEntries(p.root, { isDir: true, writes: "none" }),
              ])
            }
            title={p.root}
          >
            {/* always rendered, even empty: the slot is the same fixed square
                as the close button, so a tab never changes width when a
                session starts and the row never shuffles under the cursor */}
            <span className="titlebar-tab-status">
              {(() => {
                const c = agents[p.root];
                const working = c?.working ?? 0;
                // Working shows on every tab, the one you're on included:
                // switching to a project isn't the same as its work being
                // over, and a spinner that vanished when you looked at it made
                // the tab strip disagree with the terminal underneath it.
                // Finished is the one that's genuinely about you — it clears
                // by being read, which is what `seen` tracks.
                const done = seen.has(p.root) ? 0 : (c?.done ?? 0);
                // Nothing to say is the project's own icon, the way a browser
                // tab reads. The ring takes the square while there is
                // something to say and hands it back when there isn't —
                // never both at once, since a spinner drawn over a logo is
                // two marks fighting over 10px.
                if (!working && !done)
                  return icons[p.root] ? (
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
                return (
                  <span
                    // the agent's own colour, where the theme gives it one
                    // (subzero.css) and where there is one agent to name
                    className={`agent-ring ${working ? "working" : "done"} ${c?.agent ? `agent-${c.agent}` : ""}`}
                    title={
                      working
                        ? `${working} agent${working === 1 ? "" : "s"} working`
                        : `${done} agent${done === 1 ? "" : "s"} finished — waiting for you`
                    }
                  />
                );
              })()}
            </span>
            <span className="titlebar-tab-name">{p.name}</span>
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
