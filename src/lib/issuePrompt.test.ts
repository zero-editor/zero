import {
  BRANCH,
  DEFAULT_ISSUE_PROMPTS,
  IDENTIFIER,
  ISSUE,
  ISSUES,
  bootCommand,
  composeIssuePrompt,
  inlineCommand,
  issueKind,
  issuePromptOf,
  composePrompt,
  defaultPrompt,
  pasteKeys,
} from "./issuePrompt";
import type { LinearIssue } from "./api";

/**
 * The tests for `issuePrompt`, in the shape `miniMarkdown.test.tsx` set: plain
 * assertions and a non-zero exit, no runner under them. There still isn't one
 * in this repo, and this file needs less than that one does — no JSX, no DOM.
 * From the repository root:
 *
 *   node_modules/.bin/esbuild src/lib/issuePrompt.test.ts --bundle \
 *     --format=cjs --platform=node --outfile=/tmp/ip.cjs && node /tmp/ip.cjs
 *
 * What is worth testing here is the quoting and nothing else. The prompts
 * themselves are prose that will be rewritten by whoever presses the button;
 * the shell string around them is the part where a wrong character stops being
 * a prompt and starts being a command.
 */

/** only the two fields a prompt reads — the rest of a LinearIssue would date
 *  the test without testing anything */
const iss = (identifier: string, title: string) => ({ identifier, title }) as LinearIssue;

const rows = [iss("ECL-12", "Fix the login redirect"), iss("ECL-14", `It's "quoted"`)];

/** the row button's subject carries a branch too */
const one = {
  identifier: "ECL-12",
  title: "Fix the login redirect",
  branchName: "vid/ecl-12-fix-the-login-redirect",
} as LinearIssue;

let failures = 0;
function is(name: string, got: unknown, want: unknown) {
  if (got === want) return;
  failures++;
  console.error(`FAIL ${name}\n  want ${String(want)}\n  got  ${String(got)}`);
}

// ---------------------------------------------------------------------------
// defaults. Every state group gets a button, so the fallback has to say
// something about a state this code has never heard of.

is(
  "triage is known by its type",
  defaultPrompt("Triage", "triage").includes("Triage each of these"),
  true,
);
is(
  "review is known by its name, since its type is only `started`",
  defaultPrompt("In Review", "started").includes("Find its pull request"),
  true,
);
is(
  "anything else names the state it is about",
  defaultPrompt("In Progress", "started").includes("In Progress"),
  true,
);

// Both named prompts have to say where their output goes. "Review it" is an
// activity an agent can always claim to have done; "post it on the PR" is a
// thing that either happened or did not, and the first drafts of these said
// the former.
is(
  "triage says where its decision is recorded",
  defaultPrompt("Triage", "triage").includes("comment"),
  true,
);
is(
  "review says where the verdict goes",
  defaultPrompt("In Review", "started").includes("post it as a review on the PR"),
  true,
);
is(
  "starting an issue has a stop condition, not just a start",
  DEFAULT_ISSUE_PROMPTS.todo.includes("ask it and stop there"),
  true,
);
is("triaging one says where its decision goes", DEFAULT_ISSUE_PROMPTS.triage.includes("comment"), true);
is(
  "reviewing one says where the verdict goes",
  DEFAULT_ISSUE_PROMPTS.review.includes("post it as a review on the PR"),
  true,
);

// ---------------------------------------------------------------------------
// which rows get a start button at all. Three kinds start something; a state
// already underway or already over gets no button, and Backlog is not Todo.

is("triage by type", issueKind("Triage", "triage"), "triage");
is("todo by type", issueKind("Todo", "unstarted"), "todo");
is("review by name, since its type is only `started`", issueKind("In Review", "started"), "review");
is("in progress gets nothing", issueKind("In Progress", "started"), null);
is("done gets nothing", issueKind("Done", "completed"), null);
is("canceled gets nothing", issueKind("Canceled", "canceled"), null);
is("backlog gets nothing", issueKind("Backlog", "backlog"), null);

// ---------------------------------------------------------------------------
// composition

is(
  "the placeholder becomes identifiers and titles, one per line",
  composePrompt(`do it:\n\n${ISSUES}`, rows),
  `do it:\n\nECL-12 "Fix the login redirect"\nECL-14 "It's \"quoted\""`,
);
is(
  "a template with the placeholder edited away still names its issues",
  composePrompt("just do it", rows).includes('ECL-12 "Fix the login redirect"'),
  true,
);

// ---------------------------------------------------------------------------
// one issue. `{branch}` is the load-bearing one: a PR opened on Linear's own
// suggested branch is what makes Linear attach it back to the issue, which is
// what puts the PR glyph on the row.

const started = composeIssuePrompt(
  `read ${ISSUE}, branch ${BRANCH}, reference ${IDENTIFIER}`,
  one,
);
is(
  "all three placeholders are filled",
  started,
  'read ECL-12 "Fix the login redirect", branch vid/ecl-12-fix-the-login-redirect, reference ECL-12',
);
is(
  "and a template naming none of them is left alone",
  composeIssuePrompt("just start something", one),
  "just start something",
);

// The bug this exists to prevent: "reset to default" is stored as an empty
// string, and `??` hands an empty string back as the prompt. Two readers, one
// helper, so they cannot disagree.
is("nothing saved means the default", issuePromptOf(undefined, "todo"), DEFAULT_ISSUE_PROMPTS.todo);
is(
  "and a reset — stored as empty — means it too",
  issuePromptOf({ todo: "" }, "todo"),
  DEFAULT_ISSUE_PROMPTS.todo,
);
is("an edited one is kept", issuePromptOf({ review: "just do it" }, "review"), "just do it");
is(
  "and editing one kind leaves the others on their defaults",
  issuePromptOf({ review: "just do it" }, "triage"),
  DEFAULT_ISSUE_PROMPTS.triage,
);

// ---------------------------------------------------------------------------
// the command line. The prompt lives in a file now, so what the shell carries
// is a path — the reason being that it used to carry the prompt, and a triage
// run over six issues was two thousand characters echoed above a session about
// to print the same text again.

is(
  "the boot command reads the prompt out of its file",
  bootCommand("/w/.zero/prompts/triage.txt"),
  `claude "$(cat '/w/.zero/prompts/triage.txt')"`,
);
is(
  "and quotes the path, since a project can live under a space",
  bootCommand("/My Projects/x/.zero/prompts/ecl-12.txt"),
  `claude "$(cat '/My Projects/x/.zero/prompts/ecl-12.txt')"`,
);

// The fallback, for when the file cannot be written: a read-only checkout
// should cost a tidy command line, not the button. Its escaping is the part
// that bites — apostrophes in issue titles are ordinary, and an unescaped one
// ends the string and hands the rest of the prompt to the shell as commands.

const cmd = inlineCommand(composePrompt(ISSUES, rows));
is("the inline command opens a quoted string", cmd.startsWith("claude '"), true);
is("and closes it", cmd.endsWith("'"), true);
is(
  "every quote inside is escaped, so the string never ends early",
  cmd.slice("claude '".length, -1).split(`'\\''`).join("").includes("'"),
  false,
);
is(
  "and it is one line, so no shell answers it with a continuation prompt",
  inlineCommand("a\n\nb  c"),
  "claude 'a b c'",
);

// ---------------------------------------------------------------------------
// the paste path, where there is no shell and the newlines survive

is("a paste is bracketed", pasteKeys("a\nb"), "\x1b[200~a\nb\x1b[201~");
is("and is never submitted", pasteKeys("a\nb").endsWith("\r"), false);

if (failures) throw new Error(`${failures} failing`);
console.log("issuePrompt: all tests passed");
