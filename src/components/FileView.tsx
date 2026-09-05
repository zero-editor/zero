import { useEffect, useRef, useState } from "react";
import { basicSetup } from "codemirror";
import { EditorView, keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { Compartment, Prec, Text } from "@codemirror/state";
import { editorTheme } from "../lib/cmTheme";
import { api } from "../lib/api";
import { langFor, lazyLangFor, lazyLangForShebang, overrideFor } from "../lib/lang";
import { onSettingsChange } from "../lib/settings";
import { modClick } from "../lib/modClick";
import { changeGutter, setBaseline } from "../lib/changeGutter";
import { pokeGit } from "../lib/gitStatus";
import { minimalChange } from "../lib/minimalChange";
import { notePaste } from "../lib/notePaste";
import { onNoteEnd } from "../lib/notes";
import { miniMarkdown, type MdOptions } from "../lib/miniMarkdown";

/**
 * A note has two faces, like a markdown file on GitHub: the source, and what
 * it says. The source is where you type and paste; the rendering is where the
 * todo list lives — `- [ ]` is a checkbox there, and ticking it edits the line
 * it came from, so the two faces are one file and never disagree.
 *
 * Which face a note was showing is remembered for as long as the app runs,
 * keyed by path: a list you keep coming back to tick things off should open
 * on the list, and one you were writing should open on the text.
 */
type Mode = "edit" | "preview";
const lastMode = new Map<string, Mode>();

/** a note is typed markdown, so everything a developer would expect to render
 *  does — the same set the Linear panel switches on, plus the checkboxes */
const NOTE_MD: Omit<MdOptions, "tasks"> = { code: true, tables: true, links: true };

/** `- [ ] ` or `- [x] ` at the front of a line: the mark, so it can be flipped */
const TASK_MARK = /^(\s*(?:[-*]|\d+[.)])\s+\[)([ xX])\]/;

export function FileView({
  absPath,
  line,
  visible,
  note,
  onOpenFile,
}: {
  absPath: string;
  line?: number;
  visible: boolean;
  /** The project root, when this file is one of its notes — see `isNote`.
   *  Three things follow from it and from nothing else: what you paste is
   *  tidied on the way in, ⌘⌥N can put the cursor at the end of it, and it
   *  saves itself. Every other file behaves exactly as it always has. */
  note?: string;
  /** ⌘-click resolved to a definition somewhere */
  onOpenFile: (abs: string, line?: number) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [mode, setMode] = useState<Mode>(() => (note && lastMode.get(absPath)) || "edit");
  // the rendered face is drawn from this; kept only for a note, because it is
  // the whole document as a string on every keystroke
  const [docText, setDocText] = useState("");
  // ⌘⌥N while the rendering is up: switch faces first, put the cursor at the
  // end once the editor is visible enough to take it
  const pendingEndRef = useRef(false);
  const dirtyRef = useRef(false);
  const lastLoadedRef = useRef("");
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  // the editor is built once per file; the callback is new every render
  const onOpenFileRef = useRef(onOpenFile);
  onOpenFileRef.current = onOpenFile;

  useEffect(() => {
    let disposed = false;
    let offEnd: (() => void) | null = null;

    /**
     * A note saves itself a moment after it stops changing.
     *
     * Notes only, and the exception is the point: every other file in this
     * editor is somebody's source, and ⌘S is where the decision to change one
     * belongs. A note is scratch paper — and scratch paper you have to remember
     * to save is scratch paper you lose, which would take the pasted text with
     * it and make the whole feature something you cannot trust to catch things.
     */
    let saveTimer = 0;
    const autosave = () => {
      if (!note) return;
      window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => {
        const view = viewRef.current;
        if (disposed || !view) return;
        const text = view.state.doc.toString();
        if (text === lastLoadedRef.current) return;
        api.writeFile(absPath, text).then(() => {
          if (disposed) return;
          // both, or the refresh below reads the file it just wrote as somebody
          // else's change and dispatches it back over the cursor
          dirtyRef.current = false;
          lastLoadedRef.current = text;
        });
      }, 700);
    };
    // the language sits in a compartment so a mode that has to be fetched can
    // drop in later without rebuilding the editor under the cursor
    const lang = new Compartment();
    // started now, applied after the view exists — the two races otherwise
    const langLater = lazyLangFor(absPath);

    // what the change bars are measured against. Re-read on a timer as well as
    // at open, because HEAD moves under us: a commit in the terminal should
    // clear the bars for what it just committed. But HEAD mostly *hasn't*
    // moved, and dispatching the same baseline again re-diffs the whole file
    // and redraws the bars for nothing — a hitch every five seconds, felt as
    // a stutter when it lands mid-scroll — so an unchanged answer stays quiet.
    let lastBaseline: string | null | undefined;
    const readBaseline = async () => {
      const b = await api.gitBaseline(absPath).catch(() => null);
      if (disposed || !viewRef.current) return;
      const next = b?.tracked ? b.content : null;
      if (next === lastBaseline) return;
      lastBaseline = next;
      viewRef.current.dispatch({
        effects: setBaseline.of(next === null ? null : Text.of(next.split("\n"))),
      });
    };

    api.readFile(absPath).then((content) => {
      if (disposed || !hostRef.current) return;
      lastLoadedRef.current = content;
      viewRef.current = new EditorView({
        parent: hostRef.current,
        doc: content,
        extensions: [
          basicSetup,
          editorTheme(),
          EditorView.lineWrapping,
          changeGutter(),
          lang.of(langFor(absPath)),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged) return;
            dirtyRef.current = true;
            autosave();
            if (note) setDocText(u.state.doc.toString());
          }),
          ...(note ? [notePaste(note), noteKeys()] : []),
          modClick(
            () => absPath,
            (abs, ln) => onOpenFileRef.current(abs, ln)
          ),
          // basicSetup deliberately leaves Tab for focus traversal; in an
          // editor you want it indenting, like Cursor
          keymap.of([
            indentWithTab,
            {
              key: "Mod-s",
              run: (view) => {
                const text = view.state.doc.toString();
                api.writeFile(absPath, text).then(() => {
                  dirtyRef.current = false;
                  lastLoadedRef.current = text;
                  // the file just changed on disk, so the panel is wrong until
                  // it looks again — this is the one moment we know that
                  pokeGit();
                });
                return true;
              },
            },
          ]),
        ],
      });
      if (note) setDocText(content);
      if (line) jumpToLine(viewRef.current, line);
      // ⌘⌥N means "somewhere to put this", which has to be true of the second
      // press as much as the first — and the second press opens nothing,
      // because the tab is already here. So the shortcut asks and this answers;
      // the jump below is the first press, whose request arrived before there
      // was anything to receive it.
      if (note) {
        goToEnd(viewRef.current);
        offEnd = onNoteEnd(absPath, () => {
          // the editor may be hidden behind the rendering, and a hidden editor
          // can't take focus — so ask for the face first and finish in the
          // effect below, once it is showing
          pendingEndRef.current = true;
          setMode("edit");
          flushEnd();
        });
      }
      void readBaseline();

      langLater.then(async (ext) => {
        // a name that said nothing might still open with #!/bin/bash
        const mode =
          ext ?? (langFor(absPath).length ? null : await lazyLangForShebang(content));
        if (disposed || !mode || !viewRef.current) return;
        viewRef.current.dispatch({ effects: lang.reconfigure(mode) });
      });
    });

    // live refresh unless the user has unsaved edits — and never for a tab
    // that isn't on screen
    const iv = window.setInterval(async () => {
      if (!viewRef.current || dirtyRef.current || document.hidden || !visibleRef.current) return;
      const content = await api.readFile(absPath).catch(() => null);
      if (disposed || content === null || !viewRef.current) return;
      if (content !== lastLoadedRef.current) {
        const old = lastLoadedRef.current;
        lastLoadedRef.current = content;
        // the smallest edit, not the whole file — a full replace drops the
        // syntax tree and the scroll mapping every time an agent saves
        viewRef.current.dispatch({ changes: minimalChange(old, content) });
        // after the dispatch: the doc-changed listener above just marked the
        // refresh itself as an unsaved edit, which would wedge every later one
        dirtyRef.current = false;
      }
    }, 2000);

    const baselineIv = window.setInterval(() => {
      if (!viewRef.current || document.hidden || !visibleRef.current) return;
      void readBaseline();
    }, 5000);

    // the tab's menu can re-answer what language this file is; when that
    // answer changes — and only then, the settings store also carries themes —
    // resolve again and swap the compartment under the live editor
    let lastChoice = overrideFor(absPath);
    const offSettings = onSettingsChange(() => {
      const choice = overrideFor(absPath);
      if (choice === lastChoice) return;
      lastChoice = choice;
      void lazyLangFor(absPath).then(async (ext) => {
        const view = viewRef.current;
        if (disposed || !view) return;
        const mode =
          ext ??
          (langFor(absPath).length
            ? langFor(absPath)
            : ((await lazyLangForShebang(view.state.doc.toString())) ?? []));
        if (disposed || !viewRef.current) return;
        viewRef.current.dispatch({ effects: lang.reconfigure(mode) });
      });
    });

    return () => {
      disposed = true;
      offEnd?.();
      window.clearTimeout(saveTimer);
      offSettings();
      window.clearInterval(iv);
      window.clearInterval(baselineIv);
      viewRef.current?.destroy();
      viewRef.current = null;
    };
  }, [absPath, note]);

  // search jump on an already-open file
  useEffect(() => {
    if (line && viewRef.current) jumpToLine(viewRef.current, line);
  }, [line]);

  /** the second half of ⌘⌥N: runs once the editor is the visible face */
  const flushEnd = () => {
    const view = viewRef.current;
    if (!view || !pendingEndRef.current || view.dom.offsetParent === null) return;
    pendingEndRef.current = false;
    goToEnd(view);
  };
  useEffect(() => {
    if (!note) return;
    lastMode.set(absPath, mode);
    if (mode === "edit") {
      flushEnd();
      viewRef.current?.focus();
    }
  }, [mode, note, absPath]);

  if (!note) return <div className="cm-host" ref={hostRef} />;

  /** a checkbox in the rendering flips the mark on its line of the source —
   *  through the editor, so it is one undo step and the autosave sees it */
  const toggleTask = (line: number) => {
    const view = viewRef.current;
    if (!view || line >= view.state.doc.lines) return;
    const ln = view.state.doc.line(line + 1);
    const m = TASK_MARK.exec(ln.text);
    if (!m) return;
    const at = ln.from + m[1].length;
    view.dispatch({ changes: { from: at, to: at + 1, insert: m[2] === " " ? "x" : " " } });
  };

  return (
    <div
      className={`note-view note-${mode}`}
      onKeyDown={(e) => {
        // ⌘⇧P flips faces from either side — GitHub's key for the same thing
        if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.code === "KeyP") {
          e.preventDefault();
          setMode(mode === "edit" ? "preview" : "edit");
        }
      }}
    >
      <div className="note-modes" role="tablist">
        {(["edit", "preview"] as const).map((m) => (
          <button
            key={m}
            role="tab"
            aria-selected={mode === m}
            className={`note-mode${mode === m ? " active" : ""}`}
            onClick={() => setMode(m)}
          >
            {m === "edit" ? "Edit" : "Preview"}
          </button>
        ))}
      </div>
      {/* the editor stays mounted behind the rendering: it owns the document,
          the cursor and the undo history, and a hidden editor keeps all three */}
      <div className="cm-host" ref={hostRef} hidden={mode !== "edit"} />
      {mode === "preview" && (
        <div
          className="note-preview iv-md"
          tabIndex={0}
          onClick={(e) => {
            // a link opens in the browser, never in the webview — see IssueView
            const a = (e.target as HTMLElement).closest("a");
            const href = a?.getAttribute("href");
            if (!href) return;
            e.preventDefault();
            void api.openUrl(href);
          }}
        >
          {docText.trim() ? (
            miniMarkdown(docText, { ...NOTE_MD, tasks: toggleTask })
          ) : (
            <p className="note-empty">Nothing here yet — write something under Edit.</p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The one key a todo list wants in the editor: ⌘⏎ ticks or unticks the task
 * under the cursor, or makes the line one when it isn't yet. Enter after
 * `- [ ] a` already continues with a fresh `- [ ] `; that comes with the
 * markdown mode. ⌘⇧P isn't bound here on purpose — the editor doesn't know
 * it, so it bubbles to the note's own handler, which is the one place both
 * faces share. High precedence so the markdown keymap underneath never gets
 * ⌘⏎ first.
 */
function noteKeys() {
  return Prec.high(
    keymap.of([
      {
        key: "Mod-Enter",
        run: (view) => {
          const ln = view.state.doc.lineAt(view.state.selection.main.head);
          const m = TASK_MARK.exec(ln.text);
          if (m) {
            const at = ln.from + m[1].length;
            view.dispatch({ changes: { from: at, to: at + 1, insert: m[2] === " " ? "x" : " " } });
            return true;
          }
          // not a task: make it one, keeping any bullet it already has
          const bullet = /^(\s*)(?:[-*]\s+)?/.exec(ln.text)!;
          view.dispatch({
            changes: { from: ln.from, to: ln.from + bullet[0].length, insert: `${bullet[1]}- [ ] ` },
          });
          return true;
        },
      },
    ]),
  );
}

/** the cursor after everything already written, where the next paste goes */
function goToEnd(view: EditorView) {
  const pos = view.state.doc.length;
  view.dispatch({
    selection: { anchor: pos },
    effects: EditorView.scrollIntoView(pos, { y: "end" }),
  });
  view.focus();
}

function jumpToLine(view: EditorView, line: number) {
  const ln = Math.min(line, view.state.doc.lines);
  const pos = view.state.doc.line(ln).from;
  view.dispatch({
    selection: { anchor: pos },
    effects: EditorView.scrollIntoView(pos, { y: "center" }),
  });
  view.focus();
}
