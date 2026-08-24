import { useCallback, useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { listen } from "@tauri-apps/api/event";
import { api } from "./lib/api";
import { Launcher } from "./components/Launcher";
import { Prompt } from "./components/Prompt";
import { LanguagePick } from "./components/LanguagePick";
import { Settings } from "./components/Settings";
import { Titlebar } from "./components/Titlebar";
import { Workspace } from "./components/Workspace";
import { moveItem, movedIndex } from "./lib/tabReorder";
import {
  claimedPaneIds,
  projectSession,
  restoreSession,
  saveProject,
  saveProjects,
} from "./lib/session";
import type { ProjectSession } from "./lib/session";
import { closeSeq } from "./lib/closeOrder";
import { resolvedAppearance, useSettings } from "./lib/settings";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isGlassSupported, setLiquidGlassEffect, GlassMaterialVariant } from "tauri-plugin-liquid-glass-api";
import "./App.css";

export interface Project {
  root: string;
  name: string;
}

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);

  // Liquid Glass sits behind the whole webview, not behind any one element —
  // the CSS under `html.glass` turns every surface's background translucent
  // so the one pane shows through everywhere. The class and the pane move
  // together, in the order that never leaves a see-through frame: pane first
  // when enabling, class off first when disabling. On macOS < 26 (and
  // everywhere else) `isGlassSupported` says no and the setting is inert.
  const { glass, appearance } = useSettings();

  // Appearance is two changes that must agree: the `light` class drives every
  // CSS token, and the NSWindow's own theme drives what CSS can't reach — the
  // titlebar, the traffic lights, and which way the glass material renders.
  // `resolved` is read each render because a macOS flip under `system`
  // re-renders without changing `appearance`.
  const resolved = resolvedAppearance();
  useEffect(() => {
    document.documentElement.classList.toggle("light", resolved === "light");
    getCurrentWindow()
      .setTheme(appearance === "system" ? null : appearance)
      .catch(() => {});
  }, [appearance, resolved]);

  useEffect(() => {
    let live = true;
    isGlassSupported()
      .then(async (ok) => {
        if (!ok || !live) return;
        if (glass) {
          await setLiquidGlassEffect({ variant: GlassMaterialVariant.Regular });
          if (live) document.documentElement.classList.add("glass");
        } else {
          document.documentElement.classList.remove("glass");
          await setLiquidGlassEffect({ enabled: false });
        }
      })
      .catch((e) => api.debugLog(`[glass] failed: ${e}`).catch(() => {}));
    return () => {
      live = false;
    };
  }, [glass]);

  // Nothing renders until this has settled, and the ordering is the reason.
  // The reap ends every session no restored layout claims, and React runs
  // child effects before parent ones — so restoring the projects in the same
  // commit would have each pane ask for its shell before the daemon had been
  // told which shells are still wanted.
  //
  // This used to be `ptyKillAll`, and the swap is the whole of session
  // persistence from up here. A shell now outlives the app, so arriving at a
  // fresh boot no longer means "whatever is still running is wreckage": the
  // layout being restored is the same layout that was saved, so it claims the
  // same pane ids, and `ptySpawn` hands each one back the shell it already
  // had. What no layout claims — a project closed last week, a pane deleted
  // before the quit — is what goes.
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    let live = true;
    restoreSession()
      .then((s) => {
        // Fired, not awaited. The reap only ever ends sessions that no
        // restored layout claims, and the ids the panes are about to claim
        // come from that same layout — so a pane spawning while this is in
        // flight cannot be caught by it. Awaiting it put a wedged daemon's
        // whole reply timeout between launching zero and seeing a window.
        //
        // The list is the pruned one: a project whose directory has since
        // gone does not get to keep its shells.
        //
        // Skipped entirely when the session couldn't be read, which is not the
        // same as one that claims nothing: the layout lives in a file now, and
        // a file has ways to be unreadable that don't mean "there is nothing
        // here". Reaping on that answer would end every live Claude session
        // over a transient read — the one mistake here that can't be undone by
        // relaunching. A skipped reap leaves orphans, and the next clean boot
        // collects them.
        const claims = claimedPaneIds();
        if (claims) api.ptyReap(claims).catch(() => {});
        return s;
      })
      .then((s) => {
        if (!live) return;
        setProjects(s.projects);
        setActiveIdx(s.activeIdx);
      })
      .catch(() => {})
      .finally(() => {
        if (live) setRestored(true);
      });
    return () => {
      live = false;
    };
  }, []);

  // guarded on `restored` so the empty state we start with can't overwrite a
  // stored session before it has been read back
  useEffect(() => {
    if (restored) saveProjects(projects, activeIdx);
  }, [restored, projects, activeIdx]);

  const openProject = useCallback((root: string) => {
    const name = root.split("/").filter(Boolean).pop() ?? root;
    api.addRecent(root).catch(() => {});
    setProjects((prev) => {
      const existing = prev.findIndex((p) => p.root === root);
      if (existing >= 0) {
        setActiveIdx(existing);
        return prev;
      }
      setActiveIdx(prev.length);
      return [...prev, { root, name }];
    });
  }, []);

  // `zero <dir>` in a shell: the command leaves the directory for the app to
  // pick up and the Rust side emits it here, whether zero was already running
  // or has just started up because of it
  useEffect(() => {
    const stop = listen<string>("open-project", (e) => openProject(e.payload));
    return () => {
      stop.then((off) => off()).catch(() => {});
    };
  }, [openProject]);

  // Two pickers for one gesture, and only because of where they run: the dev
  // build is an unbundled binary, which macOS 26 will not open an NSOpenPanel
  // for, and tauri's dialog plugin panics on the NULL rather than returning
  // it — "open project" quit zero. The shipped app is bundled and uses the
  // real thing; dev asks osascript, which is bundled, for the same panel.
  const pickProject = useCallback(async () => {
    const dir = import.meta.env.DEV
      ? await api.pickDirectory("Open project")
      : await open({ directory: true, multiple: false, title: "Open project" });
    if (typeof dir === "string") openProject(dir);
  }, [openProject]);

  const reorderProjects = useCallback((from: number, to: number) => {
    setProjects((prev) => {
      if (from === to || from < 0 || to < 0 || from >= prev.length || to >= prev.length) return prev;
      // the active project is an index, so it has to travel with the move
      setActiveIdx((cur) => movedIndex(cur, from, to));
      return moveItem(prev, from, to);
    });
  }, []);

  /**
   * Projects closed this run, newest last: what ⌘⇧T puts back.
   *
   * Each entry carries the project's session as well as its name, because
   * closing one throws its layout away (see `saveProjects`) — and a reopen
   * that handed back the project with its panes, terminals and open files
   * forgotten would undo the accident in name only. The stack is the one
   * place that still holds it between the close and the undo.
   *
   * Not persisted, deliberately: this undoes a misplaced click, and a
   * misplaced click from two launches ago is not one you are still trying to
   * take back. Bounded for the same reason the tab stack is.
   */
  const [closedProjects, setClosedProjects] = useState<
    { project: Project; idx: number; seq: number; session: Partial<ProjectSession> }[]
  >([]);

  const closeProject = useCallback((idx: number) => {
    setProjects((prev) => {
      const gone = prev[idx];
      if (gone) {
        // read here rather than in the reopen: the effect above prunes this
        // project's layout out of the store the moment it leaves the list
        const session = projectSession(gone.root);
        setClosedProjects((stack) =>
          [...stack, { project: gone, idx, seq: closeSeq(), session }].slice(-10)
        );
      }
      const next = prev.filter((_, i) => i !== idx);
      setActiveIdx((cur) => Math.min(cur > idx ? cur - 1 : cur, Math.max(next.length - 1, 0)));
      return next;
    });
  }, []);

  /** The stamp of the newest closed project that isn't open again already —
      what a workspace weighs its own closed tabs against. Entries reopened by
      hand are skipped rather than counted, or ⌘⇧T would weigh a project that
      is already in front of you and then appear to do nothing. */
  const lastClosedProject = useMemo(() => {
    for (let i = closedProjects.length - 1; i >= 0; i--) {
      if (!projects.some((p) => p.root === closedProjects[i].project.root)) {
        return closedProjects[i].seq;
      }
    }
    return null;
  }, [closedProjects, projects]);

  const reopenProject = useCallback(() => {
    setClosedProjects((stack) => {
      const rest = [...stack];
      let entry = rest.pop();
      while (entry && projects.some((p) => p.root === entry!.project.root)) entry = rest.pop();
      if (!entry) return rest;
      const back = entry;
      // before the workspace mounts: it reads the session once, on mount
      saveProject(back.project.root, back.session);
      api.addRecent(back.project.root).catch(() => {});
      setProjects((prev) => {
        // back into the slot it was closed from, clamped — the tabs to its
        // right may have gone since, the same way a reopened editor tab is
        const at = Math.min(back.idx, prev.length);
        setActiveIdx(at);
        return [...prev.slice(0, at), back.project, ...prev.slice(at)];
      });
      return rest;
    });
  }, [projects]);

  // UI zoom, cmd+/- like Cursor
  const [zoom, setZoom] = useState(() => {
    const v = parseFloat(localStorage.getItem("zero-zoom") ?? "");
    return Number.isFinite(v) ? v : 1;
  });
  useEffect(() => {
    // native webview zoom, not CSS `zoom`: the CSS one scales layout but not
    // the mouse coordinates JS sees, which threw off xterm's selection maths
    // and every drag handle by exactly the zoom factor
    getCurrentWebview().setZoom(zoom).catch(() => {});
    localStorage.setItem("zero-zoom", String(zoom));
    // The traffic lights are the window's, not the page's: they stay 14pt
    // tall and 63pt wide whatever the zoom does. Their height is answered by
    // moving them onto the bar's new axis (below), but sideways they can't be
    // moved out of the tabs' way, so the inset that clears them is grown back
    // by what the zoom took off. See --chrome in styles/theme.css.
    document.documentElement.style.setProperty("--chrome", String(1 / Math.min(zoom, 1)));
  }, [zoom]);

  const [showSettings, setShowSettings] = useState(false);

  /**
   * Whether the pane layout is locked in place. Locked, nothing can be
   * picked up and carried — the grab pills never arm, and a press on one is
   * a press on the card under it — while everything that doesn't rearrange
   * the furniture stays: splits still open, dividers still resize. One flag
   * for the window rather than per project, because it says whether the
   * furniture is fixed, not what any project holds; and it survives a
   * launch, because a lock that quietly unlocked itself overnight would
   * not be one.
   */
  const [layoutLocked, setLayoutLocked] = useState(
    () => localStorage.getItem("zero-layout-lock") === "1"
  );
  useEffect(() => {
    localStorage.setItem("zero-layout-lock", layoutLocked ? "1" : "0");
  }, [layoutLocked]);

  // zero → Preferences… in the menu bar; the keyboard path is ⌘, below
  useEffect(() => {
    const stop = listen("open-settings", () => setShowSettings(true));
    return () => {
      stop.then((off) => off()).catch(() => {});
    };
  }, []);

  // Global keys: cmd+` / cmd+shift+` cycle projects, cmd+shift+O / cmd+shift+N
  // open a project, cmd+/-/0 zoom, cmd+, settings
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey) return;
      if (e.key === ",") {
        e.preventDefault();
        setShowSettings((s) => !s);
      } else if (e.code === "Backquote") {
        e.preventDefault();
        if (projects.length > 1) {
          setActiveIdx((i) => (i + (e.shiftKey ? projects.length - 1 : 1)) % projects.length);
        }
      } else if (e.shiftKey && (e.key.toLowerCase() === "o" || e.key.toLowerCase() === "n")) {
        e.preventDefault();
        pickProject();
      } else if (e.shiftKey && e.key.toLowerCase() === "t") {
        // Normally the active workspace owns this key — it weighs its own
        // closed tabs against the closed projects and picks the newer. With
        // no project open there is no workspace to do that, and nothing but
        // projects can have been closed anyway, so it lands here instead.
        // Guarded rather than unconditional: both listeners are on the window,
        // and handling it in both would undo two closes for one press.
        if (projects.length === 0) {
          e.preventDefault();
          reopenProject();
        }
      } else if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        setZoom((z) => Math.min(Math.round((z + 0.1) * 10) / 10, 2));
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        setZoom((z) => Math.max(Math.round((z - 0.1) * 10) / 10, 0.5));
      } else if (e.key === "0") {
        e.preventDefault();
        setZoom(1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [projects.length, pickProject, reopenProject]);

  // one IPC round trip, and showing the launcher for that frame would mean a
  // flash of it every launch on the way to the projects that were already open
  if (!restored) return null;

  // Rendered in both branches: ⌘, should work from the launcher too, and the
  // launcher's recents have a right-click menu of their own. `Prompt` is empty
  // until a menu item asks for a name — it costs a null render otherwise.
  const overlays = (
    <>
      {showSettings ? <Settings onClose={() => setShowSettings(false)} /> : null}
      <Prompt />
      <LanguagePick />
    </>
  );

  if (projects.length === 0) {
    return (
      <>
        <Launcher onOpen={openProject} onPick={pickProject} />
        {overlays}
      </>
    );
  }

  return (
    <div className="app">
      <Titlebar
        zoom={zoom}
        projects={projects}
        activeIdx={activeIdx}
        onSwitch={setActiveIdx}
        onClose={closeProject}
        onReorder={reorderProjects}
        onPick={pickProject}
        onSettings={() => setShowSettings(true)}
        locked={layoutLocked}
        onLocked={setLayoutLocked}
      />
      <div className="workspaces">
        {projects.map((p, i) => (
          <Workspace
            key={p.root}
            project={p}
            active={i === activeIdx}
            locked={layoutLocked}
            lastClosedProject={lastClosedProject}
            onReopenProject={reopenProject}
          />
        ))}
      </div>
      {overlays}
    </div>
  );
}
