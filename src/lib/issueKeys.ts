import { useEffect, useState } from "react";
import { api } from "./api";

/**
 * The team keys of the Linear workspace a project is connected to — `ECL`,
 * `ZERO` — which is what lets `ECL-141` in a note be a link and `UTF-8` stay
 * text. One fetch per project, shared by every editor in it, and empty when
 * Linear isn't connected: with no keys nothing anywhere is decorated, so a
 * project without Linear never sees a false positive, or any positive.
 *
 * Refreshed on connect and disconnect by the panel that does those, since
 * that is the only time the answer changes.
 */

const keys = new Map<string, string[]>();
const subs = new Map<string, Set<(k: string[]) => void>>();
const inflight = new Map<string, Promise<void>>();

function fetchKeys(root: string): Promise<void> {
  let p = inflight.get(root);
  if (p) return p;
  p = (async () => {
    let next: string[] = [];
    try {
      if (await api.linearConnected(root)) next = await api.linearTeams(root);
    } catch {
      next = [];
    }
    keys.set(root, next);
    subs.get(root)?.forEach((fn) => fn(next));
  })().finally(() => inflight.delete(root));
  inflight.set(root, p);
  return p;
}

/** Linear was connected or disconnected here — ask again */
export function refreshIssueKeys(root: string) {
  void fetchKeys(root);
}

const NONE: string[] = [];

export function useIssueKeys(root: string): string[] {
  const [value, setValue] = useState(() => keys.get(root) ?? NONE);
  useEffect(() => {
    let set = subs.get(root);
    if (!set) subs.set(root, (set = new Set()));
    set.add(setValue);
    const known = keys.get(root);
    if (known) setValue(known);
    else void fetchKeys(root);
    return () => {
      set!.delete(setValue);
    };
  }, [root]);
  return value;
}
