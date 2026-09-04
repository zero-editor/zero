import type { LinearIssue } from "./api";

/**
 * The prompts behind the Issues panel's run buttons — the play on a state
 * group ("triage all of these") and the play on a single row ("start on this
 * one"). Both end up as a Claude session; what differs is the subject.
 *
 * The panel already knows which issues it is showing, so a run doesn't have to
 * start by asking Linear what you meant: the placeholders are filled from the
 * rows on screen, and what the agent receives names them. That is the whole
 * reason these are buttons rather than something you type — the list is the
 * part nobody wants to retype, and it is the part the panel is holding anyway.
 */

/** What a group's template fills with the issues in it. */
export const ISSUES = "{issues}";

/* What a single issue's template fills. Three rather than one because they do
   different jobs: `{issue}` is what the agent should read, `{identifier}` is
   what it should write in a commit or a PR title, and `{branch}` is Linear's
   own suggested branch name — the thing that makes Linear attach the pull
   request back to the issue, which is what puts the PR glyph on the row. Use
   that branch and the loop closes itself. */
export const ISSUE = "{issue}";
export const IDENTIFIER = "{identifier}";
export const BRANCH = "{branch}";

/**
 * The prompt a group starts life with — a first draft, not a fixed one. Every
 * group gets a button and every button gets a template, so the fallback has to
 * say something sensible about a state nobody anticipated; triage and review
 * are singled out only because they are the two with an obvious verb.
 *
 * Matched on the state's *name* as well as its type because Linear's types are
 * too coarse for this: "In Progress" and "In Review" are both `started`, and
 * only one of them means "read the diff". The name is what the workspace
 * actually calls it, which is also what the person pressing the button reads.
 *
 * Written without contractions, which is not a style choice: every apostrophe
 * becomes `'\''` in the shell command these end up inside, and a triage prompt
 * full of "it's" and "won't" turns the line you are meant to be able to read in
 * the scrollback into punctuation. The escaping is correct either way — there
 * is a test for it — this is only about what it looks like.
 *
 * Both of the named ones name their deliverable and say where it lands. "Review
 * it" is an activity and an agent can always claim to have done one; "post a
 * verdict on the PR" either happened or it didn't. The first drafts here said
 * the former, and the reviews went into a terminal nobody else reads.
 */
export function defaultPrompt(state: string, stateType: string): string {
  const name = state.toLowerCase();
  if (stateType === "triage" || name.includes("triage"))
    return [
      "Triage each of these. For each: read it, try to reproduce it or confirm it against the",
      "codebase, and leave a comment saying what you found. Then route it — Todo with a priority",
      "if it is real and actionable; Canceled if it is not a bug or will not be done; Duplicate",
      "if it already exists, naming which. Assign to [names]. Do not fix anything: triage is",
      "deciding, not doing. End with one line per issue.",
      "",
      ISSUES,
    ].join("\n");
  if (name.includes("review"))
    return [
      "Review each of these. Find its pull request (attached to the issue), read the whole diff",
      "against what the issue actually asked for, run whatever tests exist, and look for what is",
      "missing as hard as what is wrong. Give a verdict per issue — ready to merge, or what has",
      "to change first — and post it as a review on the PR. If an issue has no PR, say so and",
      "move on.",
      "",
      ISSUES,
    ].join("\n");
  return [`Here are the Linear issues in ${state}. Read each one and tell me what you find.`, "", ISSUES].join(
    "\n",
  );
}

/**
 * The prompt behind an issue row's own button — one template for every issue,
 * not one per issue: what changes between two issues is the issue, which is
 * what the placeholders are for.
 *
 * **It is a prompt about deciding whether to start, not about starting.** The
 * stop condition is spelled out and given a test — a question you would want a
 * person to answer — because "if anything is unclear, ask" reads to an agent as
 * permission to guess, and the failure mode of this button is a confident hour
 * spent on a misreading of a two-line issue.
 */
export const DEFAULT_ISSUE_PROMPT = [
  `Start on ${ISSUE}. Read it in full, comments included, and check the problem is real in this`,
  "codebase before touching anything. If the scope or the approach has a genuine open question —",
  "one you would want a person to answer before committing to it — ask it and stop there.",
  `Otherwise: move it to In Progress, work on branch ${BRANCH}, keep commits small, and open a`,
  `pull request that references ${IDENTIFIER}. Finish by saying what you verified, what you`,
  "changed, and what you left alone.",
].join("\n");

/**
 * The row button's template for a project: what was saved, or the default.
 *
 * `||`, never `??`. "Reset to default" is stored as an empty string rather
 * than by deleting the key — the same trick the group prompts use, so that a
 * project running the default keeps running it when the default changes — and
 * `??` would hand that empty string straight back as the prompt. Two places
 * read this (the panel at mount, the issue view at click), and a helper is
 * cheaper than the two of them agreeing by hand.
 */
export const issuePromptOf = (saved: string | undefined): string => saved || DEFAULT_ISSUE_PROMPT;

/** One issue, as the agent reads it: the identifier it can look up, and the
 *  title so it doesn't have to in order to know what it's holding. */
const line = (i: LinearIssue) => `${i.identifier} "${i.title}"`;

/**
 * The template with its issues in it.
 *
 * A template that has lost its `{issues}` still gets the list, appended. The
 * alternative is a run that names nothing and quietly becomes "whatever Claude
 * guesses I meant" — which looks exactly like a working button until you read
 * what it did. Editing the prompt is meant to change the instruction, not to
 * be a way to silently remove the subject.
 */
export function composePrompt(template: string, rows: LinearIssue[]): string {
  const list = rows.map(line).join("; ");
  const body = template.trim();
  return body.includes(ISSUES) ? body.split(ISSUES).join(list) : `${body}\n\n${list}`;
}

/**
 * A single issue's template, with the issue in it.
 *
 * No appending when a placeholder is missing, unlike the group's: a template
 * that says "start on the issue I have open" and nothing else is a coherent
 * thing to want, and the row's own prompt is short enough to read at a glance
 * — the failure the group's rule guards against, a run that silently names
 * nothing, isn't reachable from here without meaning it.
 */
export function composeIssuePrompt(template: string, issue: LinearIssue): string {
  return template
    .trim()
    .split(ISSUE)
    .join(line(issue))
    .split(IDENTIFIER)
    .join(issue.identifier)
    .split(BRANCH)
    .join(issue.branchName);
}

/**
 * A prompt as one shell word.
 *
 * `'\''` for an embedded quote is the portable form — it closes the string,
 * escapes a literal quote outside it, and opens a new one — and reads the same
 * to zsh, bash and fish, which is as far as this needs to travel.
 */
const quoted = (s: string) => `'${s.split("'").join(`'\\''`)}'`;

/**
 * The command a new terminal is opened on.
 *
 * **One line, so the newlines go.** A quoted multi-line string is valid in
 * every shell here and looks it: zsh answers each embedded newline with a
 * `quote>` continuation prompt, so a five-line prompt lands as five lines of
 * shell bookkeeping above the session it started. The paragraph breaks are
 * doing nothing for the agent that a space doesn't, and the boot command is
 * meant to be readable in the scrollback — it is typed rather than run behind
 * the scenes precisely so it can be read and run again (see Terminals.tsx).
 *
 * The prompt goes as an argument rather than being typed into a running
 * `claude`, which would be a race against its own startup: the TUI takes the
 * terminal over some milliseconds after the shell hands it off, and keystrokes
 * that arrive during that are swallowed, or worse, half-swallowed.
 */
export function bootCommand(prompt: string): string {
  return `claude ${quoted(prompt.replace(/\s+/g, " ").trim())}`;
}

/**
 * The same prompt as keystrokes for a session that is already running.
 *
 * Wrapped in bracketed paste, which is what keeps a multi-line prompt from
 * submitting itself at the first newline — the receiving TUI reads the whole
 * run as one paste rather than as typing with Returns in it. Here the newlines
 * survive, since nothing is going through a shell.
 *
 * **It stops short of Return.** The prompt lands in the input box and waits
 * for you. What the agent-status poll can tell us is whether a session is
 * quiet, not *why*: a Claude sitting on a permission dialog reads exactly like
 * a Claude sitting at its prompt, and a submitted paste into the first one
 * answers a question you never saw. Leaving the Return to the person makes
 * the bad case a visible mess instead of a silent one.
 */
export function pasteKeys(prompt: string): string {
  return `\x1b[200~${prompt.replace(/\r/g, "")}\x1b[201~`;
}
