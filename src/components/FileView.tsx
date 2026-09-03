import { useEffect, useRef } from "react";
import { basicSetup } from "codemirror";
import { EditorView, keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { Compartment, Text } from "@codemirror/state";
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
          }),
          ...(note ? [notePaste(note)] : []),
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
      if (line) jumpToLine(viewRef.current, line);
      // ⌘⌥N means "somewhere to put this", which has to be true of the second
      // press as much as the first — and the second press opens nothing,
      // because the tab is already here. So the shortcut asks and this answers;
      // the jump below is the first press, whose request arrived before there
      // was anything to receive it.
      if (note) {
        goToEnd(viewRef.current);
        offEnd = onNoteEnd(absPath, () => {
          if (viewRef.current) goToEnd(viewRef.current);
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

  return <div className="cm-host" ref={hostRef} />;
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
