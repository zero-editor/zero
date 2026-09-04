import { useCallback, useEffect, useRef, useState } from "react";
import { basicSetup } from "codemirror";
import { EditorView, keymap } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { api, type LinearIssueDetail } from "../lib/api";
import { miniMarkdown } from "../lib/miniMarkdown";
import { editorTheme } from "../lib/cmTheme";
import { focusTerm, targetTerm } from "../lib/termFocus";

/** Linear descriptions are written in a browser, where fences, tables and
 *  links all render — so unlike a voice memo, this text needs the parts
 *  `miniMarkdown` leaves alone by default. */
const MD = { code: true, tables: true, links: true } as const;

/** Linear's status spellings, said the way a person would. Anything not here
 *  is printed as it arrived — a new word from Linear should look unfamiliar
 *  rather than be quietly rounded to the nearest one we know. */
const PR_WORD: Record<string, string> = {
  open: "open",
  inReview: "in review",
  draft: "draft",
  merged: "merged",
  closed: "closed",
};

/** the confirmation, drawn rather than a ✓ character: the character's weight
 *  and baseline come from whatever font resolves it, and next to a 12px label
 *  it lands either spindly or huge */
const TICK = (
  <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3.2 8.6 6.3 11.7 12.8 5.2" />
  </svg>
);

/** Linear's priority scale, which is 0-for-none rather than 0-for-highest and
 *  reads wrong every time it isn't spelled out. */
const PRIORITY = ["", "Urgent", "High", "Medium", "Low"];

/** the same four tones the sidebar row uses, so one pull request is one colour
 *  wherever it is drawn */
const PR_TONE: Record<string, string> = {
  open: "open",
  inReview: "open",
  draft: "draft",
  merged: "merged",
  closed: "closed",
};

function when(iso: string): string {
  const then = new Date(iso).getTime();
  if (!then) return "";
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

/** Markdown that opens its links in the browser rather than navigating the app
 *  out of existence — a webview has no back button, so an unhandled click on
 *  an external link is unrecoverable. */
function Markdown({ text }: { text: string }) {
  return (
    <div
      className="iv-md"
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest("a");
        const href = a?.getAttribute("href");
        if (!href) return;
        e.preventDefault();
        void api.openUrl(href);
      }}
    >
      {miniMarkdown(text, MD)}
    </div>
  );
}

/** The description, editable in place. CodeMirror rather than a textarea
 *  because these run to hundreds of lines of markdown with code in them, and
 *  because it is the editor the rest of the app already is. */
function DescriptionEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial: string;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  // Held in refs so the editor is built exactly once: rebuilding it on a
  // re-render would throw away the cursor mid-sentence.
  const save = useRef(onSave);
  const cancel = useRef(onCancel);
  save.current = onSave;
  cancel.current = onCancel;

  useEffect(() => {
    if (!host.current) return;
    const v = new EditorView({
      parent: host.current,
      doc: initial,
      extensions: [
        basicSetup,
        editorTheme(),
        EditorView.lineWrapping,
        markdown(),
        keymap.of([
          {
            key: "Mod-s",
            run: (ed) => {
              save.current(ed.state.doc.toString());
              return true;
            },
          },
          { key: "Escape", run: () => (cancel.current(), true) },
        ]),
      ],
    });
    view.current = v;
    v.focus();
    return () => v.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="iv-edit">
      <div className="iv-cm" ref={host} />
      <div className="iv-edit-bar">
        <span className="iv-hint">⌘S saves to Linear · esc cancels</span>
        <button className="iv-btn" onClick={() => save.current(view.current?.state.doc.toString() ?? "")}>
          Save
        </button>
        <button className="iv-btn flat" onClick={() => cancel.current()}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function IssueView({
  root,
  id,
  identifier,
  visible,
}: {
  root: string;
  id: string;
  identifier: string;
  visible: boolean;
}) {
  const [issue, setIssue] = useState<LinearIssueDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  // Success is the tick on the button and nothing else. A failure still needs
  // words — "no terminal open to send to" is not something a glyph can say.
  const [sent, setSent] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const d = await api.linearIssue(root, id);
      if (live.current) {
        setIssue(d);
        setError(null);
      }
    } catch (e) {
      if (live.current) setError(String(e));
    }
  }, [root, id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Coming back to a tab that has been sitting open for an hour should not
  // show an hour-old issue. Editing suspends it, so a refetch can't overwrite
  // what is being typed.
  useEffect(() => {
    if (!visible || editing) return;
    const wake = () => void load();
    window.addEventListener("focus", wake);
    return () => window.removeEventListener("focus", wake);
  }, [visible, editing, load]);

  const saveDescription = async (text: string) => {
    if (!issue) return;
    setSaving(true);
    try {
      await api.linearSaveDescription(root, issue.id, text);
      if (!live.current) return;
      setIssue({ ...issue, description: text });
      setEditing(false);
      setError(null);
    } catch (e) {
      if (live.current) setError(String(e));
    } finally {
      if (live.current) setSaving(false);
    }
  };

  /** The whole point of having the issue in the editor: hand it to the agent
   *  in the terminal without a browser and a clipboard in between.
   *
   *  One line by default. A description here runs to hundreds of lines of
   *  markdown with tables in it, and pasting that as a prompt buries whatever
   *  you actually wanted to say about it — you end up deleting most of it to
   *  get to your own sentence. The identifier and title are what a person
   *  types when they mean "do this one", and the link is there for an agent
   *  that can follow it. Hold ⌥ for the whole thing, on the rare occasion the
   *  spec is the point.
   *
   *  Never submitted either way: the last word before an agent starts work
   *  belongs to the person. */
  const sendToTerminal = (full: boolean) => {
    if (!issue) return;
    const term = targetTerm();
    if (!term) {
      setSendError("No terminal open to send to.");
      return;
    }
    const text = full
      ? [
          `${issue.identifier}: ${issue.title}`,
          "",
          issue.description || "(no description)",
          "",
          issue.url,
        ].join("\n")
      : `${issue.identifier}: ${issue.title} — ${issue.url} `;
    // Bracketed paste, so a multi-line prompt arrives as one paste rather than
    // as a hundred Enter presses — which in a Claude session would submit the
    // first line and then send ninety-nine more prompts.
    api
      .ptyWrite(term, full ? `\x1b[200~${text}\x1b[201~` : text)
      .then(() => {
        setSent(true);
        setSendError(null);
        // Put the caret where the text landed. Sending a prompt is the first
        // half of typing one, and leaving the keyboard in the editor means the
        // next thing typed goes into the issue instead of after the prompt.
        focusTerm(term);
      })
      .catch((e) => setSendError(String(e)));
  };

  // Long enough to be read as an answer to the click, short enough that the
  // button is back to saying what it does before you next look at it.
  useEffect(() => {
    if (!sent) return;
    const t = window.setTimeout(() => setSent(false), 2200);
    return () => window.clearTimeout(t);
  }, [sent]);

  useEffect(() => {
    if (!sendError) return;
    const t = window.setTimeout(() => setSendError(null), 5000);
    return () => window.clearTimeout(t);
  }, [sendError]);

  if (error && !issue) {
    return (
      <div className="issue-view">
        <p className="iv-error">{error}</p>
        <button className="iv-btn" onClick={() => void load()}>
          Retry
        </button>
      </div>
    );
  }

  if (!issue) {
    return (
      <div className="issue-view">
        <p className="iv-dim">Loading {identifier}…</p>
      </div>
    );
  }

  const pr = issue.prs[0];

  return (
    <div className="issue-view">
      <div className="iv-head">
        <span className="iv-dot" style={{ background: issue.stateColor }} />
        <button className="iv-id" title="open in Linear" onClick={() => void api.openUrl(issue.url)}>
          {issue.identifier}
        </button>
        <span className="iv-state">{issue.state}</span>
        <span className="iv-sep">·</span>
        <span className="iv-dim">{issue.assignee ?? "unassigned"}</span>
        {issue.priority > 0 && (
          <>
            <span className="iv-sep">·</span>
            <span className="iv-dim">{PRIORITY[issue.priority] ?? ""}</span>
          </>
        )}
        <span className="iv-gap" />
        {/* Both labels live in the same grid cell, so the button is always as
            wide as the wider of the two and swapping them moves nothing. The
            alternative — measuring the idle width and pinning it — is the same
            idea with a number in it that goes stale when the font changes. */}
        <button
          className={`iv-btn flat iv-send ${sent ? "sent" : ""}`}
          title="the identifier, title and link — hold ⌥ to send the description too"
          onClick={(e) => sendToTerminal(e.altKey)}
        >
          <span className="iv-send-face">Send to terminal</span>
          <span className="iv-send-face tick" aria-hidden={!sent}>
            {TICK}
            Sent
          </span>
        </button>
      </div>

      <h1 className="iv-title">{issue.title}</h1>

      {issue.labels.length > 0 && (
        <div className="iv-labels">
          {issue.labels.map((l) => (
            <span className="iv-label" key={l.name}>
              <span className="iv-dot sm" style={{ background: l.color }} />
              {l.name}
            </span>
          ))}
        </div>
      )}

      {/* The cross-reference, and the reason this is in an editor rather than a
          browser tab: what Linear believes, next to what the checkout can
          prove. */}
      <div className="iv-local">
        <div className="iv-local-row">
          <span className="iv-key">branch</span>
          {issue.local.branch ? (
            <span className="iv-val">
              {issue.local.branch}
              {issue.local.worktree && (
                <span className="iv-dim">
                  {" "}
                  · checked out in {issue.local.worktree.split("/").pop()}
                  {issue.local.current ? " (this window)" : ""}
                </span>
              )}
            </span>
          ) : (
            <span className="iv-val dim">
              none here —{" "}
              <button
                className="iv-inline"
                title="copy Linear's suggested branch name"
                onClick={() => void navigator.clipboard.writeText(issue.branchName).catch(() => {})}
              >
                copy {issue.branchName}
              </button>
            </span>
          )}
        </div>
        <div className="iv-local-row">
          <span className="iv-key">pull request</span>
          {pr ? (
            <span className="iv-val">
              <button
                className={`iv-inline ${PR_TONE[pr.status] ?? ""}`}
                onClick={() => void api.openUrl(pr.url)}
              >
                {pr.repo}#{pr.number}
              </button>
              <span className="iv-dim">
                {" "}
                {PR_WORD[pr.status] ?? pr.status} → {pr.targetBranch}
                {pr.hasConflicts ? " · conflicts" : ""}
              </span>
              {issue.prs.length > 1 && (
                <span className="iv-dim"> · {issue.prs.length - 1} more</span>
              )}
            </span>
          ) : (
            <span className="iv-val dim">none</span>
          )}
        </div>
      </div>

      {sendError && <p className="iv-error">{sendError}</p>}
      {error && <p className="iv-error">{error}</p>}

      <div className="iv-section">
        <span className="iv-section-title">Description</span>
        {!editing && (
          <button className="iv-quiet" onClick={() => setEditing(true)}>
            edit
          </button>
        )}
        {saving && <span className="iv-dim">saving…</span>}
      </div>

      {editing ? (
        <DescriptionEditor
          initial={issue.description}
          onSave={(t) => void saveDescription(t)}
          onCancel={() => setEditing(false)}
        />
      ) : issue.description ? (
        <Markdown text={issue.description} />
      ) : (
        <p className="iv-dim">No description.</p>
      )}

      {issue.comments.length > 0 && (
        <>
          <div className="iv-section">
            <span className="iv-section-title">
              {issue.comments.length} comment{issue.comments.length > 1 ? "s" : ""}
            </span>
          </div>
          {issue.comments.map((c) => (
            <div className="iv-comment" key={c.id}>
              <div className="iv-comment-head">
                <span className="iv-who">{c.author}</span>
                <span className="iv-dim">{when(c.createdAt)}</span>
              </div>
              <Markdown text={c.body} />
            </div>
          ))}
        </>
      )}

      <div className="iv-foot">
        <span className="iv-dim">updated {when(issue.updatedAt)}</span>
      </div>
    </div>
  );
}
