import { _test } from "./termLinks";
import type { Terminal } from "@xterm/xterm";

// Run with esbuild --bundle --platform=node --format=esm, then node.
const { flatten, findAll, URL_RE, URL_CONT, PATH_RE, PATH_CONT } = _test;

function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

/** rows as printed: a space is an empty cell, `wrapped` marks soft wraps */
function fakeTerm(cols: number, rows: (string | { text: string; wrapped: true })[]): Terminal {
  const lines = rows.map((r) => {
    const text = typeof r === "string" ? r : r.text;
    const isWrapped = typeof r !== "string";
    return {
      isWrapped,
      length: cols,
      getCell: (x: number) => {
        const ch = text[x];
        return { getChars: () => (ch && ch !== " " ? ch : ""), getWidth: () => 1 };
      },
    };
  });
  return {
    cols,
    buffer: { active: { length: lines.length, getLine: (y: number) => lines[y] } },
  } as unknown as Terminal;
}

const urls = (t: Terminal, y: number) => findAll(flatten(t, y).text, URL_RE, URL_CONT).map((s) => s.text);

// What Claude Code printed at 70 columns (measured): the row is filled to the
// last column, then a newline and a two-column indent.
const head = "  see https://github.com/zero-editor/zero/pull/1234567890/files/abcdef";
equal(head.length, 70);
const claude = fakeTerm(70, [head, "  ghijklmnopqrstuvwxyz0123456789/commits/deadbeefcafebabe         ok", ""]);
const whole =
  "https://github.com/zero-editor/zero/pull/1234567890/files/abcdefghijklmnopqrstuvwxyz0123456789/commits/deadbeefcafebabe";
equal(urls(claude, 0), [whole]);
// hovering the second row finds the same link
equal(urls(claude, 1), [whole]);

// …and its range runs from the first row into the second
{
  const flat = flatten(claude, 1);
  const [span] = findAll(flat.text, URL_RE, URL_CONT);
  equal([flat.xs[span.start], flat.ys[span.start]], [6, 0]);
  equal([flat.xs[span.end - 1], flat.ys[span.end - 1]], [56, 1]);
}

// a URL that ends short of the edge is not continued
equal(urls(fakeTerm(70, ["  see https://example.com/a and more", "  next line"]), 0), ["https://example.com/a"]);

// a URL ending a sentence at the edge is not continued
{
  const row = "  ok: https://example.com/".padEnd(69, "a") + ".";
  equal(row.length, 70);
  equal(urls(fakeTerm(70, [row, "  Then more"]), 0), [row.slice(6, 69)]);
}

// a URL starting the next row is its own link
{
  const row = "  https://example.com/".padEnd(70, "a");
  equal(urls(fakeTerm(70, [row, "  https://other.com/x"]), 0), [row.slice(2), "https://other.com/x"]);
}

// a TUI gutter glyph is not part of the link
{
  const row = "  https://example.com/".padEnd(70, "a");
  equal(urls(fakeTerm(70, [row, "│ more"]), 0), [row.slice(2)]);
}

// soft wraps still join as before
{
  const row = "https://example.com/".padEnd(20, "b");
  equal(urls(fakeTerm(20, [row, { text: "cdef tail", wrapped: true }]), 0), [row + "cdef"]);
}

// a path broken across rows keeps the part above as a fallback
{
  const row = "  wrote ".padEnd(60, " ") + "src/lib/te";
  const [span] = findAll(flatten(fakeTerm(70, [row, "  rmLinks.ts:12 done"]), 0).text, PATH_RE, PATH_CONT);
  equal(span.text, "src/lib/termLinks.ts:12");
  equal(span.head?.text, "src/lib/te");
}

console.log("termLinks ok");
