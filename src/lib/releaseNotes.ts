/**
 * The release notes an update is carrying — every version between the one
 * running and the one staged, so a jump over three releases reads as three,
 * not as the last one's notes standing in for the lot.
 *
 * One unauthenticated GET of the releases list off GitHub's API, the same
 * host the updater already talks to (allowed by `connect-src` in
 * tauri.conf.json). Sixty of these an hour is the anonymous limit and one
 * per staged update is the spend, so the limit is not a number this will
 * ever meet.
 *
 * The notes are written for exactly this reader — CLAUDE.md's rule is "write
 * for someone deciding whether to update" — but they open with two lines that
 * aren't: the signing preamble and the sha256 the Homebrew cask reads. Those
 * are stripped here rather than asked out of the notes, because the cask's
 * `awk '/sha256/{print $2}'` needs them exactly where they are.
 */

export interface ReleaseNote {
  /** without the leading v */
  version: string;
  /** the release's published date, already worded for the header */
  date: string;
  /** the body, boilerplate removed — may be empty for a note-less release */
  body: string;
}

/** `1.2.3` against `1.2.4`, numerically — string order would put 0.10 before
 *  0.9. Missing parts count as zero, so `1.2` and `1.2.0` tie. */
const numbers = (v: string) => v.replace(/^v/, "").split(".").map(Number);
function older(a: string, b: string): boolean {
  const [x, y] = [numbers(a), numbers(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d < 0;
  }
  return false;
}

/** What a release body says once the parts addressed to machines are gone:
 *  the signing line, the indented sha256 the cask greps for, the generated
 *  changelog link, and the "What's Changed" heading that would repeat under
 *  every version header the dialog already draws. */
function clean(body: string): string {
  return body
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter(
      (line) =>
        !/^Apple Silicon\. Signed and notarized/.test(line.trim()) &&
        !/^\s*sha256\s+[0-9a-f]{16,}/.test(line) &&
        !/^\*\*Full Changelog\*\*/.test(line.trim()) &&
        !/^#{1,3}\s+What'?s Changed\s*$/i.test(line.trim()),
    )
    .join("\n")
    .trim();
}

/** the fields read out of GitHub's release objects; everything else ignored */
interface GhRelease {
  tag_name: string;
  body?: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string;
}

/**
 * The notes for every release after `from` up to and including `to`, newest
 * first — the order someone catching up reads in. Null when GitHub couldn't
 * be reached or answered strangely; the caller decides what silence looks
 * like. One page of 100 covers years of this project's releases, and a jump
 * long enough to fall off it is a reinstall, not an update.
 *
 * Answered once per jump: the fetch starts the moment an update is staged
 * (see [`prefetchReleaseNotes`]) and the dialog, opened any time after,
 * reads the same promise instead of watching a spinner for a round trip to
 * GitHub. A failed fetch is forgotten rather than kept, so the next ask
 * tries again — an offline moment at staging time shouldn't blank the
 * dialog for the days the update might sit there.
 */
export function releaseNotesBetween(from: string, to: string): Promise<ReleaseNote[] | null> {
  const key = `${from}\u0000${to}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const p = fetchBetween(from, to).then((got) => {
    if (got === null) cache.delete(key);
    return got;
  });
  cache.set(key, p);
  return p;
}

/** start fetching now, for a dialog that may open later; the result is
 *  whatever [`releaseNotesBetween`] would answer with */
export function prefetchReleaseNotes(from: string, to: string): void {
  void releaseNotesBetween(from, to);
}

const cache = new Map<string, Promise<ReleaseNote[] | null>>();

async function fetchBetween(from: string, to: string): Promise<ReleaseNote[] | null> {
  try {
    const res = await fetch(
      "https://api.github.com/repos/zero-editor/zero/releases?per_page=100",
      { headers: { Accept: "application/vnd.github+json" } },
    );
    if (!res.ok) return null;
    const all = (await res.json()) as GhRelease[];
    return all
      .filter((r) => !r.draft && !r.prerelease)
      .filter((r) => older(from, r.tag_name) && !older(to, r.tag_name))
      .sort((a, b) => (older(a.tag_name, b.tag_name) ? 1 : -1))
      .map((r) => ({
        version: r.tag_name.replace(/^v/, ""),
        date: new Date(r.published_at).toLocaleDateString(undefined, {
          day: "numeric",
          month: "short",
          year: "numeric",
        }),
        body: clean(r.body ?? ""),
      }));
  } catch {
    return null;
  }
}
