import { useCallback, useEffect, useRef, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { message } from "@tauri-apps/plugin-dialog";

/**
 * In-app updates, in two halves that are deliberately far apart in time.
 *
 * The fetch is automatic and silent: by the time anything appears in the
 * titlebar the new version is already on disk, so the button is a restart and
 * not a download. The restart is never automatic — the shells survive it now
 * that the daemon holds them, but the window someone is working in is still
 * theirs to interrupt — which is why nothing in this file calls relaunch() on
 * its own.
 *
 * A failed check is not worth a word to anyone. Offline is the usual reason,
 * and the app's own version is not news the user is waiting on.
 *
 * zero → Check for Updates… is the same check with the opposite manners. Asked
 * for, it has to answer — silence reads as a broken menu item — so it says so
 * when there is nothing, and says why when it couldn't tell. Only the outcomes
 * that leave nothing on screen are worth a dialog: finding one puts the pill
 * in the titlebar, and a modal saying the same thing would be one more click
 * for no news. The states in between are the pill's job too (`busy`), and only
 * while someone is waiting on them — the six-hourly check flashing "checking…"
 * at nobody is exactly the noise the silent half exists to avoid.
 */

/** how often to look, once the first check has been and gone */
const EVERY_MS = 6 * 60 * 60 * 1000;

/** what a look ended in, for the caller who asked for it */
type Outcome =
  /** checked, nothing newer */
  | "none"
  /** found one, and it is downloaded and staged */
  | "downloaded"
  /** one was already staged before this look */
  | "ready"
  /** couldn't tell — offline, usually */
  | "failed";

/** the part of a look that is visible while it runs, or null between them */
export type Busy = "checking" | "downloading";

export interface UpdateState {
  /** version string once it's downloaded and ready to install, else null */
  ready: string | null;
  /** a check someone is waiting on, and how far along it is */
  busy: Busy | null;
  /** install and relaunch — the caller has already asked */
  restart: () => Promise<void>;
}

/** what the menu item answers with; a dialog that fails to open is not worth
 *  a second one about it */
const say = (text: string, bad = false) =>
  message(text, { title: "Check for Updates", kind: bad ? "warning" : "info" }).catch(() => {});

export function useUpdate(): UpdateState {
  const [ready, setReady] = useState<string | null>(null);
  // how far along a look is, and whether anyone asked for this one. Tracked
  // apart because every look has a phase and only an asked-for one is shown.
  const [phase, setPhase] = useState<Busy | null>(null);
  const [watched, setWatched] = useState(false);

  // The staged update, and whether a look is in flight, in refs rather than
  // state: the poll reads both to know it has nothing to do, and reading them
  // must not be a reason to tear the timer down and start it again.
  const staged = useRef<Update | null>(null);
  const inflight = useRef<Promise<Outcome> | null>(null);
  const live = useRef(true);

  /**
   * One look, shared. Two callers overlapping — the six-hourly poll and the
   * menu item, on the same second — get the same promise and the same answer
   * rather than two checks racing to stage two bundles over each other.
   *
   * `loud` only decides who sees it happening, and it is a property of the
   * look rather than of the caller: a silent poll already downloading becomes
   * the visible one the moment the menu asks it the same question. What it
   * finds is the same either way.
   */
  const look = useCallback((loud: boolean): Promise<Outcome> => {
    if (staged.current) return Promise.resolve<Outcome>("ready");
    if (loud) setWatched(true);
    if (!inflight.current) {
      const run = async (): Promise<Outcome> => {
        try {
          setPhase("checking");
          const found = await check();
          if (!found?.available) return "none";
          setPhase("downloading");
          // downloadAndInstall stages the new bundle; on macOS the swap
          // happens here and the running app carries on out of the copy it
          // already has, which is why this is safe to do without asking and
          // the restart isn't
          await found.downloadAndInstall();
          staged.current = found;
          if (live.current) setReady(found.version);
          return "downloaded";
        } catch {
          return "failed";
        } finally {
          inflight.current = null;
          if (live.current) {
            setPhase(null);
            setWatched(false);
          }
        }
      };
      inflight.current = run();
    }
    return inflight.current;
  }, []);

  useEffect(() => {
    live.current = true;
    void look(false);
    const iv = window.setInterval(() => void look(false), EVERY_MS);
    return () => {
      live.current = false;
      window.clearInterval(iv);
    };
  }, [look]);

  // zero → Check for Updates… in the menu bar; see src-tauri/src/lib.rs
  const asking = useRef(false);
  useEffect(() => {
    const stop = listen("check-for-updates", async () => {
      // the menu stays clickable while the answer is still on screen, and a
      // second dialog behind the first is not a second answer
      if (asking.current) return;
      asking.current = true;
      try {
        const found = await look(true);
        if (found === "none") {
          const now = await getVersion().catch(() => null);
          await say(now ? `zero ${now} is the latest version.` : "zero is up to date.");
        } else if (found === "failed") {
          await say("Couldn't reach the update server. Check your connection and try again.", true);
        } else if (found === "ready") {
          // downloaded on an earlier look, so the pill has been sitting in the
          // titlebar saying so — point at it rather than repeat it
          await say(
            `zero ${staged.current?.version} is downloaded. Use the update button in the titlebar to restart into it.`
          );
        }
        // "downloaded" says itself: the pill was showing the download and is
        // now showing the version, which is the answer, where it belongs
      } finally {
        asking.current = false;
      }
    });
    return () => {
      stop.then((off) => off()).catch(() => {});
    };
  }, [look]);

  const restart = useCallback(async () => {
    await relaunch();
  }, []);

  return { ready, busy: watched ? phase : null, restart };
}
