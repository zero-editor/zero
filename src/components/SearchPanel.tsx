import { useEffect, useRef, useState } from "react";
import type { ReplaceTarget, SearchFile, SearchLine, SearchSpan } from "../lib/api";
import type { Search } from "../lib/search";
import type { View } from "./Workspace";
import { contextMenu, fileEntries } from "../lib/contextMenu";
import { Chevron } from "./Chevron";

/**
 * Search and replace across the project, in the shape Cursor's is.
 *
 * One row per match rather than per line, which is why `Span.nth` exists: a
 * line with three hits appears three times, each with its own hit lit and its
 * own replace button, and there is never a question of which one a button
 * means.
 */

/** an arrow going into what it replaces — one bar for one match, two for all */
function ReplaceIcon({ all }: { all?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.2">
      <path d="M2 5.5h6M5.5 3 8 5.5 5.5 8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10.5 11.5h3.5" strokeLinecap="round" />
      {all && <path d="M10.5 14h3.5" strokeLinecap="round" />}
      <path d="M2 11.5h5.5" strokeLinecap="round" />
    </svg>
  );
}

const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const baseOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** matches this file got a row for. Fewer than `count` when the file had more
 *  matching lines than the backend lists, or a line too long to show whole. */
const shown = (f: SearchFile) => f.lines.reduce((n, l) => n + l.spans.length, 0);

/** the line with one span lit — the others are text like any other text */
function HitText({ line, span }: { line: SearchLine; span: SearchSpan }) {
  return (
    <>
      <span>{line.text.slice(0, span.start)}</span>
      <span className="search-mark">{line.text.slice(span.start, span.end)}</span>
      <span>{line.text.slice(span.end)}</span>
    </>
  );
}

export function SearchPanel({
  search,
  onOpenView,
  onRevealInTree,
}: {
  // no `root`: a result row names the folder it came from, and only the search
  // itself can turn that back into a path — see `Search.abs`
  search: Search;
  onOpenView: (v: View) => void;
  onRevealInTree: (abs: string) => void;
}) {
  const { params, set, result, busy, error, collapsed, showReplace, showFilters } = search;
  const inputRef = useRef<HTMLInputElement>(null);

  // ⌘⇧F from anywhere in the workspace lands here. Selecting the old query is
  // what every editor does, so a second ⌘⇧F is a fresh search rather than an
  // append.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [search.focusNonce]);

  // Replacing everything is the one action here that rewrites files you haven't
  // looked at, so it asks — as a second click on the same button rather than a
  // dialog, which keeps the count in view while you decide.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = window.setTimeout(() => setArmed(false), 4000);
    return () => window.clearTimeout(t);
  }, [armed]);
  useEffect(() => setArmed(false), [params.text, params.replacement, result]);

  const files = result?.files ?? [];
  const total = result?.matches ?? 0;

  const openAt = (file: SearchFile, line: number) =>
    onOpenView({
      kind: "file",
      key: `file:${search.abs(file.path)}`,
      absPath: search.abs(file.path),
      line,
    });

  const replace = (targets: ReplaceTarget[]) => search.replace(targets);

  const replaceAll = () => {
    if (!armed) {
      setArmed(true);
      return;
    }
    setArmed(false);
    replace(files.map((f) => ({ path: f.path })));
  };

  return (
    <div className="search-panel">
      <div className="search-controls">
        <button
          className="search-expand"
          title={showReplace ? "hide replace" : "show replace"}
          onClick={() => search.setShowReplace(!showReplace)}
        >
          <Chevron open={showReplace} />
        </button>

        <div className="search-fields">
          <div className="search-field">
            <input
              ref={inputRef}
              className="search-input"
              placeholder="search"
              value={params.text}
              onChange={(e) => set({ text: e.target.value })}
              spellCheck={false}
            />
            <div className="search-opts">
              <button
                className={`search-opt ${params.caseSensitive ? "on" : ""}`}
                title="match case"
                onClick={() => set({ caseSensitive: !params.caseSensitive })}
              >
                Aa
              </button>
              <button
                className={`search-opt word ${params.wholeWord ? "on" : ""}`}
                title="match whole word"
                onClick={() => set({ wholeWord: !params.wholeWord })}
              >
                ab
              </button>
            </div>
          </div>

          {showReplace && (
            <div className="search-field">
              <input
                className="search-input"
                placeholder="replace"
                value={params.replacement}
                onChange={(e) => set({ replacement: e.target.value })}
                spellCheck={false}
              />
              <div className="search-opts">
                <button
                  className={`search-opt icon ${armed ? "armed" : ""}`}
                  title={armed ? `replace all ${total}?` : "replace all"}
                  disabled={!total}
                  onClick={replaceAll}
                >
                  <ReplaceIcon all />
                </button>
              </div>
            </div>
          )}
        </div>

        <button
          className={`search-more ${showFilters ? "on" : ""}`}
          title="files to include and exclude"
          onClick={() => search.setShowFilters(!showFilters)}
        >
          ⋯
        </button>
      </div>

      {showFilters && (
        <div className="search-filters">
          <input
            className="search-input filter"
            placeholder="files to include"
            value={params.include}
            onChange={(e) => set({ include: e.target.value })}
            spellCheck={false}
          />
          <input
            className="search-input filter"
            placeholder="files to exclude"
            value={params.exclude}
            onChange={(e) => set({ exclude: e.target.value })}
            spellCheck={false}
          />
        </div>
      )}

      {error && <div className="panel-error">{error}</div>}

      {params.text && !error && (
        <div className="search-summary">
          {busy && !result
            ? "searching…"
            : total === 0
              ? "no results"
              : `${total} result${total === 1 ? "" : "s"} in ${files.length} file${
                  files.length === 1 ? "" : "s"
                }${result?.truncated ? " — narrow the search to see the rest" : ""}`}
          {armed && total > 0 && <span className="search-armed">click again to replace all</span>}
        </div>
      )}

      <div className="search-results">
        {files.map((f) => {
          const open = !collapsed.has(f.path);
          const dir = dirOf(f.path);
          return (
            // the group and every hit in it are the same file, so the menu
            // hangs off the group and each row inherits it
            <div
              key={f.path}
              className="search-group"
              onContextMenu={(e) =>
                contextMenu(e, [
                  { text: "Open", run: () => openAt(f, f.lines[0]?.line ?? 1) },
                  { text: "Reveal in Sidebar", run: () => onRevealInTree(search.abs(f.path)) },
                  showReplace && {
                    text: `Replace ${f.count} in This File`,
                    run: () => replace([{ path: f.path }]),
                  },
                  "sep",
                  ...fileEntries(search.abs(f.path), { root: search.owner(f.path) }),
                ])
              }
            >
              <div
                className="search-file"
                title={f.path}
                onClick={() => search.toggleFile(f.path)}
              >
                <Chevron open={open} />
                <span className="search-file-base">{baseOf(f.path)}</span>
                {dir && <span className="search-file-dir">{dir}</span>}
                <span className="search-file-count">{f.count}</span>
                {showReplace && (
                  <button
                    className="search-file-act"
                    title={`replace ${f.count} in this file`}
                    onClick={(e) => {
                      e.stopPropagation();
                      replace([{ path: f.path }]);
                    }}
                  >
                    <ReplaceIcon all />
                  </button>
                )}
              </div>

              {open &&
                f.lines.map((l) =>
                  l.spans.map((s) => (
                    <div
                      className="search-row"
                      key={`${l.line}:${s.nth}`}
                      // its own, rather than the group's: a hit is a line, and
                      // "Open" here should land on that line and not the file's
                      // first match
                      onContextMenu={(e) =>
                        contextMenu(e, [
                          { text: `Open at Line ${l.line}`, run: () => openAt(f, l.line) },
                          {
                            text: "Reveal in Sidebar",
                            run: () => onRevealInTree(search.abs(f.path)),
                          },
                          showReplace && {
                            text: "Replace This One",
                            run: () => replace([{ path: f.path, line: l.line, nth: s.nth }]),
                          },
                          "sep",
                          ...fileEntries(search.abs(f.path), { root: search.owner(f.path) }),
                        ])
                      }
                    >
                      <button className="search-hit" onClick={() => openAt(f, l.line)}>
                        <span className="search-line">{l.line}</span>
                        <span className="search-text">
                          <HitText line={l} span={s} />
                        </span>
                      </button>
                      {showReplace && (
                        <button
                          className="search-row-act"
                          title="replace this one"
                          onClick={() => replace([{ path: f.path, line: l.line, nth: s.nth }])}
                        >
                          <ReplaceIcon />
                        </button>
                      )}
                    </div>
                  ))
                )}

              {open && shown(f) < f.count && (
                <div className="search-row-more">{f.count - shown(f)} more in this file</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
