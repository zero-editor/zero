/**
 * Path matching for quick open.
 *
 * The query is words. Each word must appear in the path as a contiguous
 * substring, in order — `app cont dev bas` finds
 * `app/controllers/api/device/base_controller.rb`, the way Atom's finder did,
 * with no typo tolerance to second-guess what was typed. Ranking is about
 * where a word landed rather than that it landed: the start of a path segment
 * beats the middle of one, the filename beats the directories leading to it,
 * and among equally good matches the shorter path is nearly always the one
 * meant.
 *
 * A single word that appears nowhere as a substring falls back to the older
 * letters-in-order fuzzy match, so `wsp` still finds `Workspace.tsx` — the
 * abbreviation habit and the substring habit don't have to fight.
 */

const WORD_BREAK = /[/\\\-_. ]/;

function isUpper(ch: string) {
  return ch >= "A" && ch <= "Z";
}

function isLower(ch: string) {
  return ch >= "a" && ch <= "z";
}

interface Match {
  score: number;
  /** character indices the query matched, for underlining them in the list */
  indices: Set<number>;
}

/** What one occurrence of a word is worth, before anything after it. */
function occPoints(path: string, start: number, len: number, baseAt: number): number {
  let points = len * 2; // longer words are more said, so worth more landed
  if (start >= baseAt) points += 6; // in the filename, not the path to it
  if (start === baseAt) points += 8; // the filename's first letter
  const prev = start > 0 ? path[start - 1] : "/";
  if (WORD_BREAK.test(prev)) points += 6; // the start of a word
  else if (isLower(prev) && isUpper(path[start])) points += 4; // camelCase hump
  return points;
}

/** Every place `word` occurs in `hay` (both already lowercased). */
function occurrences(hay: string, word: string): number[] {
  const at: number[] = [];
  for (let i = hay.indexOf(word); i >= 0; i = hay.indexOf(word, i + 1)) at.push(i);
  return at;
}

/**
 * Best placement of the words along the path: each word at one of its
 * occurrences, in order and non-overlapping, maximizing the summed points.
 * Walked back to front so each occurrence can ask "and the best the rest can
 * do from here" of the word after it.
 */
function placeWords(path: string, hay: string, words: string[]): Match | null {
  const baseAt = path.lastIndexOf("/") + 1;
  const occs = words.map((w) => occurrences(hay, w));
  if (occs.some((o) => o.length === 0)) return null;

  // best[w][k] = the best total from word w placed at its k-th occurrence on,
  // with next[w][k] naming the following word's occurrence that total used
  const best: number[][] = words.map(() => []);
  const next: number[][] = words.map(() => []);
  for (let w = words.length - 1; w >= 0; w--) {
    for (let k = 0; k < occs[w].length; k++) {
      const start = occs[w][k];
      const own = occPoints(path, start, words[w].length, baseAt);
      if (w === words.length - 1) {
        best[w][k] = own;
        next[w][k] = -1;
        continue;
      }
      // the following word must begin after this one ends
      const from = start + words[w].length;
      let bestRest = -Infinity;
      let bestAt = -1;
      for (let j = 0; j < occs[w + 1].length; j++) {
        if (occs[w + 1][j] < from) continue;
        if (best[w + 1][j] > bestRest) {
          bestRest = best[w + 1][j];
          bestAt = j;
        }
      }
      best[w][k] = bestAt < 0 ? -Infinity : own + bestRest;
      next[w][k] = bestAt;
    }
  }

  let head = 0;
  for (let k = 1; k < occs[0].length; k++) if (best[0][k] > best[0][head]) head = k;
  if (!isFinite(best[0][head])) return null; // occurrences exist but not in order

  const indices = new Set<number>();
  for (let w = 0, k = head; w < words.length && k >= 0; k = next[w][k], w++) {
    for (let i = 0; i < words[w].length; i++) indices.add(occs[w][k] + i);
  }
  return { score: best[0][head] - path.length * 0.05, indices };
}

/** The old letters-in-order match, kept as the single-word fallback. */
function scattered(path: string, hay: string, needle: string): Match | null {
  const baseAt = path.lastIndexOf("/") + 1;
  const indices = new Set<number>();
  let qi = 0;
  let total = 0;
  let run = 0;
  for (let i = 0; i < hay.length && qi < needle.length; i++) {
    if (hay[i] !== needle[qi]) {
      run = 0;
      continue;
    }
    let points = 1;
    if (i >= baseAt) points += 3;
    if (i === baseAt) points += 5;
    const prev = i > 0 ? path[i - 1] : "/";
    if (WORD_BREAK.test(prev)) points += 4;
    else if (isLower(prev) && isUpper(path[i])) points += 3;
    run += 1;
    points += run * 2; // consecutive letters are what "looks right"
    total += points;
    indices.add(i);
    qi += 1;
  }
  if (qi < needle.length) return null;
  return { score: total - path.length * 0.05, indices };
}

function matchPath(path: string, query: string): Match | null {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { score: 0, indices: new Set() };
  const hay = path.toLowerCase();
  const placed = placeWords(path, hay, words);
  if (placed) return placed;
  // several words are several statements about substrings; only a lone one is
  // ambiguous enough to read as an abbreviation
  return words.length === 1 ? scattered(path, hay, words[0]) : null;
}

/** Higher is better. `null` means the query doesn't match at all. */
export function fuzzyScore(path: string, query: string): number | null {
  return matchPath(path, query)?.score ?? null;
}

export interface Ranked {
  path: string;
  score: number;
}

export function rankPaths(paths: string[], query: string, limit: number): Ranked[] {
  if (!query.trim()) return paths.slice(0, limit).map((path) => ({ path, score: 0 }));
  const out: Ranked[] = [];
  for (const path of paths) {
    const score = fuzzyScore(path, query);
    if (score !== null) out.push({ path, score });
  }
  out.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
  return out.slice(0, limit);
}

/** The indices the query matched, for underlining them in the list. */
export function matchedIndices(path: string, query: string): Set<number> {
  return matchPath(path, query)?.indices ?? new Set();
}
