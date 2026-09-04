import { renderToStaticMarkup } from "react-dom/server";
import { miniMarkdown, type MdOptions } from "./miniMarkdown";

/**
 * The tests for `miniMarkdown`, and no test runner under them.
 *
 * There isn't one in this repo to follow — the Rust half tests with `#[test]`
 * and the TypeScript half has never had a framework — and a renderer whose
 * whole contract is "this exact string of HTML" doesn't need one: it needs a
 * comparison and a non-zero exit. So this file is both, in about fifteen lines,
 * and stays runnable the day someone does add vitest by being nothing but
 * assertions underneath. From the repository root:
 *
 *   node_modules/.bin/esbuild src/lib/miniMarkdown.test.tsx --bundle \
 *     --format=cjs --platform=node --jsx=automatic --outfile=/tmp/mm.cjs \
 *     && node /tmp/mm.cjs
 *
 * esbuild is already here as vite's own dependency, so that adds nothing to
 * `package.json`. cjs rather than esm because react-dom's server build reaches
 * for `require("util")` and an esm bundle has no `require` to give it.
 *
 * The expectations for the flags-off cases were recorded from the renderer as
 * it stood before any of the opt-ins existed, which is the only way that half
 * means anything: they are not what the code should print, they are what it
 * did print, and a memo is owed exactly that and nothing newer.
 */

const html = (src: string, opts?: MdOptions) =>
  renderToStaticMarkup(<>{miniMarkdown(src, opts)}</>);

let failures = 0;
function is(name: string, got: string, want: string) {
  if (got === want) return;
  failures++;
  console.error(`FAIL ${name}\n  want ${want}\n  got  ${got}`);
}

// ---------------------------------------------------------------------------
// flags off. the regression that matters most: a memo is transcribed speech,
// and every one of these has to stay the literal text it always was.

is(
  "off: a fence is three backticks",
  html("before\n```js\nconst a = 1;\n\nconst b = 2;\n```\nafter"),
  "<p>before ```js const a = 1;</p><p>const b = 2; ``` after</p>",
);
is(
  "off: a table is a line of pipes",
  html("Results:\n| a | b |\n| :-- | --: |\n| 1 | 2 |\nafter"),
  "<p>Results: | a | b | | :-- | --: | | 1 | 2 | after</p>",
);
is(
  "off: a link is [text](url)",
  html("see [docs](https://example.com) now"),
  "<p>see [docs](https://example.com) now</p>",
);
is(
  "off: a bare url is a bare url",
  html("visit https://example.com. ok"),
  "<p>visit https://example.com. ok</p>",
);
is(
  "off: everything that did work still does",
  html("# Head [a](https://b.co)\n\n- one **bold**\n  - deep\n\n> quoted\n\n---\n\npara `code`"),
  "<h1>Head [a](https://b.co)</h1><ul><li>one <strong>bold</strong>" +
    "<ul><li>deep</li></ul></li></ul><blockquote>quoted</blockquote>" +
    "<hr/><p>para <code>code</code></p>",
);
is(
  "off: opts present but false changes nothing",
  html("```\nx\n```\n\n| a |\n| - |\n\n[t](https://u.co)", {
    code: false,
    tables: false,
    links: false,
  }),
  html("```\nx\n```\n\n| a |\n| - |\n\n[t](https://u.co)"),
);

// ---------------------------------------------------------------------------
// code

const CODE: MdOptions = { code: true };

is(
  "code: with a language",
  html("```js\nconst a = 1;\n```", CODE),
  '<pre class="md-code" data-lang="js"><code>const a = 1;</code></pre>',
);
is(
  "code: without one",
  html("```\nplain\n```", CODE),
  '<pre class="md-code"><code>plain</code></pre>',
);
is(
  "code: tildes fence too",
  html("~~~py\nx = 1\n~~~", CODE),
  '<pre class="md-code" data-lang="py"><code>x = 1</code></pre>',
);
is(
  "code: unterminated runs to the end rather than vanishing",
  html("```py\nx = 1\ny = 2", CODE),
  '<pre class="md-code" data-lang="py"><code>x = 1\ny = 2</code></pre>',
);
is(
  "code: blank lines inside survive",
  html("```\na\n\nb\n```", CODE),
  '<pre class="md-code"><code>a\n\nb</code></pre>',
);
is(
  "code: nothing inside is markdown",
  html("```\n# not a heading\n- not a list\n**not bold**\n```", CODE),
  '<pre class="md-code"><code>' +
    "# not a heading\n- not a list\n**not bold**</code></pre>",
);
is(
  "code: a paragraph above it keeps its hands off",
  html("Here:\n```\nx\n```\nAfter", CODE),
  '<p>Here:</p><pre class="md-code"><code>x</code></pre><p>After</p>',
);
is(
  "code: the inner mark is content, not the end",
  html("~~~\n```\n~~~", CODE),
  '<pre class="md-code"><code>```</code></pre>',
);

// ---------------------------------------------------------------------------
// tables

const TABLES: MdOptions = { tables: true };

is(
  "tables: alignments come off the delimiter row",
  html("| l | c | r | n |\n| :-- | :-: | --: | --- |\n| 1 | 2 | 3 | 4 |", TABLES),
  '<table class="md-table"><thead><tr>' +
    '<th style="text-align:left">l</th><th style="text-align:center">c</th>' +
    '<th style="text-align:right">r</th><th>n</th></tr></thead><tbody><tr>' +
    '<td style="text-align:left">1</td><td style="text-align:center">2</td>' +
    '<td style="text-align:right">3</td><td>4</td></tr></tbody></table>',
);
is(
  "tables: no delimiter row is not a table",
  html("| a | b |\nnot a delimiter\n| 1 | 2 |", TABLES),
  "<p>| a | b | not a delimiter | 1 | 2 |</p>",
);
is(
  "tables: a delimiter of the wrong width is not one either",
  html("| a | b |\n| --- |\n| 1 | 2 |", TABLES),
  "<p>| a | b | | --- | | 1 | 2 |</p>",
);
is(
  "tables: ragged rows are padded and trimmed, not thrown over",
  html("| a | b |\n| - | - |\n| 1 |\n| 1 | 2 | 3 |", TABLES),
  '<table class="md-table"><thead><tr><th>a</th><th>b</th></tr></thead>' +
    "<tbody><tr><td>1</td><td></td></tr><tr><td>1</td><td>2</td></tr>" +
    "</tbody></table>",
);
is(
  "tables: header only still draws",
  html("| a | b |\n| - | - |", TABLES),
  '<table class="md-table"><thead><tr><th>a</th><th>b</th></tr></thead></table>',
);
is(
  "tables: cells get the inline parser",
  html("| a | b |\n| - | - |\n| **x** | `y` |", TABLES),
  '<table class="md-table"><thead><tr><th>a</th><th>b</th></tr></thead>' +
    "<tbody><tr><td><strong>x</strong></td><td><code>y</code></td></tr>" +
    "</tbody></table>",
);
is(
  "tables: an escaped pipe stays in its cell",
  html("| a | b |\n| - | - |\n| x \\| y | z |", TABLES),
  '<table class="md-table"><thead><tr><th>a</th><th>b</th></tr></thead>' +
    "<tbody><tr><td>x | y</td><td>z</td></tr></tbody></table>",
);
is(
  "tables: a genuinely empty last cell is kept, the outer pipe is not",
  html("| a | b |\n| - | - |\n| x |  |", TABLES),
  '<table class="md-table"><thead><tr><th>a</th><th>b</th></tr></thead>' +
    "<tbody><tr><td>x</td><td></td></tr></tbody></table>",
);
is(
  "tables: outer pipes are optional",
  html("a | b\n--- | ---\n1 | 2", TABLES),
  '<table class="md-table"><thead><tr><th>a</th><th>b</th></tr></thead>' +
    "<tbody><tr><td>1</td><td>2</td></tr></tbody></table>",
);
is(
  "tables: a paragraph above it keeps its hands off",
  html("Results:\n| a |\n| - |\n| 1 |", TABLES),
  '<p>Results:</p><table class="md-table"><thead><tr><th>a</th></tr></thead>' +
    "<tbody><tr><td>1</td></tr></tbody></table>",
);

// ---------------------------------------------------------------------------
// links, and the scheme allowlist that is the only security boundary here

const LINKS: MdOptions = { links: true };

is(
  "links: [text](url)",
  html("see [docs](https://example.com) now", LINKS),
  '<p>see <a href="https://example.com">docs</a> now</p>',
);
is(
  "links: http and mailto are allowed too",
  html("[a](http://x.co) [b](mailto:me@x.co)", LINKS),
  '<p><a href="http://x.co">a</a> <a href="mailto:me@x.co">b</a></p>',
);
is(
  "links: javascript: is text, not an anchor",
  html("[x](javascript:alert)", LINKS),
  "<p>[x](javascript:alert)</p>",
);
is(
  "links: so is JaVaScRiPt:",
  html("[x](JaVaScRiPt:alert)", LINKS),
  "<p>[x](JaVaScRiPt:alert)</p>",
);
is(
  "links: data: is text, not an anchor",
  html("[y](data:text/html,hi)", LINKS),
  "<p>[y](data:text/html,hi)</p>",
);
is(
  "links: a relative path is text too",
  html("[z](/etc/passwd)", LINKS),
  "<p>[z](/etc/passwd)</p>",
);
is(
  "links: a bare url is linkified without its full stop",
  html("visit https://example.com. ok", LINKS),
  '<p>visit <a href="https://example.com">https://example.com</a>. ok</p>',
);
is(
  "links: emphasis in a label survives, nested anchors do not",
  html("[**bold** https://inner.co](https://outer.co)", LINKS),
  '<p><a href="https://outer.co"><strong>bold</strong> https://inner.co</a></p>',
);
is(
  "links: a url inside inline code is code",
  html("`https://example.com`", LINKS),
  "<p><code>https://example.com</code></p>",
);
is(
  "links: in a heading",
  html("# See [docs](https://x.co)", LINKS),
  '<h1>See <a href="https://x.co">docs</a></h1>',
);
is(
  "links: in a list item",
  html("- see [docs](https://x.co)", LINKS),
  '<ul><li>see <a href="https://x.co">docs</a></li></ul>',
);
is(
  "links: in a table cell",
  html("| a |\n| - |\n| [docs](https://x.co) |", { tables: true, links: true }),
  '<table class="md-table"><thead><tr><th>a</th></tr></thead><tbody><tr>' +
    '<td><a href="https://x.co">docs</a></td></tr></tbody></table>',
);
is(
  "links: no target or rel, the app handles the click",
  html("[a](https://x.co)", LINKS),
  '<p><a href="https://x.co">a</a></p>',
);
is(
  "links: a label at the 200-char cap still links",
  html(`[${"x".repeat(200)}](https://x.co)`, LINKS),
  `<p><a href="https://x.co">${"x".repeat(200)}</a></p>`,
);
is(
  // the label loses its link, but the url in the brackets is still a url and
  // the bare-url branch picks it up — which is the better of the two failures
  "links: one character over it is text around a bare url",
  html(`[${"x".repeat(201)}](https://x.co)`, LINKS),
  `<p>[${"x".repeat(201)}](<a href="https://x.co">https://x.co</a>)</p>`,
);

// ---------------------------------------------------------------------------

const ALL: MdOptions = { code: true, tables: true, links: true };
is(
  "all three at once, which is how an issue arrives",
  html("# Bug\n\nSee [the log](https://x.co):\n\n```sh\nzero --sessions\n```\n\n| env | ok |\n| --- | :-: |\n| dev | no |", ALL),
  "<h1>Bug</h1><p>See <a href=\"https://x.co\">the log</a>:</p>" +
    '<pre class="md-code" data-lang="sh"><code>zero --sessions</code></pre>' +
    '<table class="md-table"><thead><tr><th>env</th>' +
    '<th style="text-align:center">ok</th></tr></thead><tbody><tr>' +
    '<td>dev</td><td style="text-align:center">no</td></tr></tbody></table>',
);

// ---------------------------------------------------------------------------
// images. An image is not a link, and with `links` on it must not become one:
// the failure mode is a stray "!" beside a working anchor, which reads as a
// link that is merely broken rather than as the literal text it should be.
// Linear descriptions carry pasted screenshots, so this is a real line.

is(
  "an image stays literal text with links on",
  html("![alt](https://x.co/a.png)", LINKS),
  "<p>![alt](https://x.co/a.png)</p>",
);
is(
  "an image renders the same with links on as with them off",
  html("![alt](https://x.co/a.png)", LINKS),
  html("![alt](https://x.co/a.png)"),
);
is(
  "a real link beside an image still links",
  html("see [the doc](https://x.co) and ![img](https://x.co/a.png)", LINKS),
  '<p>see <a href="https://x.co">the doc</a> and ![img](https://x.co/a.png)</p>',
);
is(
  "an image with an empty label stays text",
  html("![](https://x.co/a.png)", LINKS),
  "<p>![](https://x.co/a.png)</p>",
);
is(
  "an exclamation mark that is not an image still lets its link through",
  html("wow! [doc](https://x.co)", LINKS),
  '<p>wow! <a href="https://x.co">doc</a></p>',
);

if (failures) throw new Error(`${failures} failing`);
console.log("miniMarkdown: all tests passed");

