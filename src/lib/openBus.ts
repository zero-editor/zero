/**
 * "Open this file in that project" — the hand-off between the App, which
 * decides which project a path belongs to, and the Workspace, which owns the
 * editor tabs it would open in.
 *
 * A queue rather than a call, because the project may not exist yet: a file
 * dropped on the Launcher opens its repository first, and the Workspace for it
 * mounts a frame later. Requests wait per root until that workspace
 * subscribes, then drain in the order they arrived.
 */

const waiting = new Map<string, string[]>();
const subs = new Map<string, (abs: string) => void>();

export function openInProject(root: string, abs: string) {
  const fn = subs.get(root);
  if (fn) fn(abs);
  else waiting.set(root, [...(waiting.get(root) ?? []), abs]);
}

export function onProjectOpen(root: string, fn: (abs: string) => void): () => void {
  subs.set(root, fn);
  const queued = waiting.get(root);
  waiting.delete(root);
  queued?.forEach(fn);
  return () => {
    // another subscriber may have replaced this one already — a re-render
    // resubscribing must not tear the newer listener down
    if (subs.get(root) === fn) subs.delete(root);
  };
}
