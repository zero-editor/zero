import {
  BRANCH,
  DEFAULT_ISSUE_PROMPT,
  IDENTIFIER,
  ISSUE,
  ISSUES,
  bootCommand,
  composeIssuePrompt,
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
  DEFAULT_ISSUE_PROMPT.includes("ask it and stop there"),
  true,
);

// ---------------------------------------------------------------------------
// composition

is(
  "the placeholder becomes identifiers and titles",
  composePrompt(`do it:\n\n${ISSUES}`, rows),
  `do it:\n\nECL-12 "Fix the login redirect"; ECL-14 "It's \"quoted\""`,
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
is("nothing saved means the default", issuePromptOf(undefined), DEFAULT_ISSUE_PROMPT);
is("and a reset — stored as empty — means it too", issuePromptOf(""), DEFAULT_ISSUE_PROMPT);
is("an edited one is kept", issuePromptOf("just do it"), "just do it");

// ---------------------------------------------------------------------------
// the shell. An apostrophe in an issue title is ordinary — "It's broken" — and
// an unescaped one closes the string and hands the rest of the prompt to the
// shell as commands. This is the assertion the file exists for.

const cmd = bootCommand(composePrompt(ISSUES, rows));
is("the command opens a quoted string", cmd.startsWith("claude '"), true);
is("and closes it", cmd.endsWith("'"), true);
is(
  "every quote inside is escaped, so the string never ends early",
  cmd.slice("claude '".length, -1).split(`'\\''`).join("").includes("'"),
  false,
);
is(
  "the command is one line, so no shell answers it with a continuation prompt",
  bootCommand("a\n\nb  c"),
  "claude 'a b c'",
);

// ---------------------------------------------------------------------------
// the paste path, where there is no shell and the newlines survive

is("a paste is bracketed", pasteKeys("a\nb"), "\x1b[200~a\nb\x1b[201~");
is("and is never submitted", pasteKeys("a\nb").endsWith("\r"), false);

if (failures) throw new Error(`${failures} failing`);
console.log("issuePrompt: all tests passed");
