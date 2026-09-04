import { useCallback, useEffect, useRef, useState } from "react";
import { api, ReplaceTarget, SearchQuery, SearchResult } from "./api";
import { labels } from "./folders";

/**
 * The search panel's state, held by the workspace rather than the panel.
 *
 * The sidebar renders one tab at a time, so a panel that owned this would
 * throw away a result list every time you looked at the file tree and ran the
 * whole search again on the way back. Living a level up, it survives that — and
 * survives the terminal being focused, which is where you go to act on what you
 * found.
 */

/** how long typing settles before a search runs */
const DEBOUNCE_MS = 120;

/**
 * Past this many matches the result list arrives folded to its filenames.
 *
 * Not a rendering trick — the search itself is done by then. It's that a few
 * thousand rows is more than the panel can lay out in a frame and more than
 * anyone reads, and the first letters of a query always produce them on the way
 * to something narrower. Opening a file is one click either way.
 */
const AUTO_COLLAPSE = 300;

export interface SearchParams extends SearchQuery {
  replacement: string;
}

const BLANK: SearchParams = {
  text: "",
  replacement: "",
  caseSensitive: false,
  wholeWord: false,
  include: "",
  exclude: "",
};

const queryOf = (p: SearchParams): SearchQuery => ({
  text: p.text,
  caseSensitive: p.caseSensitive,
  wholeWord: p.wholeWord,
  include: p.include,
  exclude: p.exclude,
});

export interface Search {
  params: SearchParams;
  set: (patch: Partial<SearchParams>) => void;
  result: SearchResult | null;
  busy: boolean;
  error: string | null;
  /** files whose hits are folded away, by path */
  collapsed: Set<string>;
  toggleFile: (path: string) => void;
  showReplace: boolean;
  setShowReplace: (v: boolean) => void;
  showFilters: boolean;
  setShowFilters: (v: boolean) => void;
  /** bumped to ask the panel to focus its input, whoever it was that asked */
  focusNonce: number;
  focus: (withReplace?: boolean) => void;
  replace: (targets: ReplaceTarget[]) => Promise<void>;
  /**
   * A result row's path made absolute.
   *
   * Rows are no longer relative to one folder: with several, each carries the
   * label of the folder it came from, and only this knows how to undo that.
   * The panel asks rather than joining strings itself, which is also what
   * keeps it from having to know how many folders there are.
   */
  abs: (path: string) => string;
  /** the folder a row belongs to — what its file menu treats as the project */
  owner: (path: string) => string;
}

export function useSearch(roots: string[]): Search {
  // `roots` is a new array each render; its contents almost never change
  const key = roots.join("\n");
  const [params, setParams] = useState<SearchParams>(BLANK);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [showReplace, setShowReplace] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [focusNonce, setFocusNonce] = useState(0);

  const set = useCallback((patch: Partial<SearchParams>) => {
    setParams((p) => ({ ...p, ...patch }));
  }, []);

  const toggleFile = useCallback((path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  }, []);

  const focus = useCallback((withReplace = false) => {
    if (withReplace) setShowReplace(true);
    setFocusNonce((n) => n + 1);
  }, []);

  // A search is slower than typing, so answers can arrive out of order. Only
  // the newest request is allowed to write, which also covers the case where
  // clearing the box would otherwise be overwritten by an in-flight result.
  const seq = useRef(0);
  /** result row → the folder it came from and its path inside it. Rebuilt with
   *  every result, and the only thing that can turn a shown path back into a
   *  real one once the rows carry folder labels. */
  const homes = useRef(new Map<string, { root: string; rel: string }>());
  const run = useCallback(
    async (q: SearchQuery) => {
      const mine = ++seq.current;
      if (!q.text) {
        setResult(null);
        setError(null);
        setBusy(false);
        return;
      }
      setBusy(true);
      // One search per folder, run together. Each is its own ripgrep-shaped
      // sweep of its own tree, and merging afterwards keeps the Rust side
      // knowing nothing about projects that hold more than one.
      const mineRoots = key ? key.split("\n") : [];
      const names = labels(mineRoots);
      const multi = mineRoots.length > 1;
      try {
        const parts = await Promise.all(
          mineRoots.map((r, i) =>
            api
              .searchProject(r, q)
              .then((res) => ({ root: r, name: names[i], res, error: null as string | null }))
              // a folder that can't be searched — moved, or not readable — is
              // one folder's answer, not the whole search's
              .catch((e) => ({ root: r, name: names[i], res: null, error: String(e) }))
          )
        );
        if (seq.current !== mine) return;

        const home = new Map<string, { root: string; rel: string }>();
        const merged: SearchResult = { files: [], matches: 0, truncated: false };
        for (const p of parts) {
          if (!p.res) continue;
          for (const f of p.res.files) {
            const shown = multi ? `${p.name}/${f.path}` : f.path;
            home.set(shown, { root: p.root, rel: f.path });
            merged.files.push({ ...f, path: shown });
          }
          merged.matches += p.res.matches;
          merged.truncated ||= p.res.truncated;
        }
        homes.current = home;
        setResult(merged);
        // each result decides its own starting fold, so a narrowing query opens
        // back up on its own instead of staying shut from the wide one before it
        setCollapsed(
          merged.matches > AUTO_COLLAPSE ? new Set(merged.files.map((f) => f.path)) : new Set()
        );
        // every folder failing is a failed search; some of them failing is a
        // shorter list, and saying so above the results people can see would be
        // louder than it is worth
        const failed = parts.filter((p) => p.error);
        setError(failed.length === parts.length ? failed[0].error : null);
      } catch (e) {
        if (seq.current !== mine) return;
        setResult(null);
        setError(String(e));
      } finally {
        if (seq.current === mine) setBusy(false);
      }
    },
    [key]
  );

  // destructured so the effect depends on the five fields that change a search
  // rather than on the object holding them — `replacement` lives in the same
  // state, and typing one shouldn't re-run anything
  const { text, caseSensitive, wholeWord, include, exclude } = params;
  useEffect(() => {
    const q = { text, caseSensitive, wholeWord, include, exclude };
    const t = window.setTimeout(() => run(q), DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [run, text, caseSensitive, wholeWord, include, exclude]);

  const replace = useCallback(
    async (targets: ReplaceTarget[]) => {
      const q = queryOf(params);
      // Targets name shown paths, and a replace runs against one folder — so
      // they are sorted back into the folders they came from and each folder
      // is asked separately. Grouped rather than done one file at a time: a
      // replace-all across a repository is one call, as it always was.
      const byRoot = new Map<string, ReplaceTarget[]>();
      for (const t of targets) {
        const at = homes.current.get(t.path);
        if (!at) continue;
        const list = byRoot.get(at.root) ?? [];
        list.push({ ...t, path: at.rel });
        byRoot.set(at.root, list);
      }
      try {
        await Promise.all(
          [...byRoot].map(([r, list]) => api.replaceMatches(r, q, params.replacement, list))
        );
      } catch (e) {
        setError(String(e));
        return;
      }
      // re-run rather than editing the list in place: the file on disk is what
      // the next result should describe, and it just changed
      await run(q);
    },
    [params, run]
  );

  const abs = useCallback((path: string) => {
    const at = homes.current.get(path);
    return at ? `${at.root}/${at.rel}` : path;
  }, []);

  const owner = useCallback(
    (path: string) => homes.current.get(path)?.root ?? (key ? key.split("\n")[0] : ""),
    [key]
  );

  return {
    params,
    set,
    result,
    busy,
    error,
    collapsed,
    toggleFile,
    showReplace,
    setShowReplace,
    showFilters,
    setShowFilters,
    focusNonce,
    focus,
    replace,
    abs,
    owner,
  };
}
