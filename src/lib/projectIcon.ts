import { useEffect, useState } from "react";
import { api } from "./api";
import { imageType } from "./imageFile";

/**
 * The picture a repository already has of itself.
 *
 * A browser tab shows the site's favicon, and a project tab can show the same
 * thing for the same reason: at four tabs the names are enough, at ten a shape
 * is found faster than a word. Nothing here fetches anything — the icon is a
 * file the repository already ships, so it works offline, costs one read, and
 * is the icon the project's own authors chose rather than one we invented.
 *
 * Only source directories are looked in. `dist`, `out`, `.next` and `.vercel`
 * hold copies of the same icons, and a build output is a place a name can be
 * hashed or a file left behind by a build from a month ago.
 */
const DIRS = [
  "public",
  "static",
  "app",
  "src/app",
  "src-tauri/icons",
  "assets",
  "src/assets",
  "resources",
  "www",
  "design",
  // the repository root last: a `logo.png` sitting loose at the top is usually
  // a README's header image rather than the project's mark
  "",
];

/** what the file is called, without its extension, most icon-like first */
const NAMES: Record<string, number> = {
  favicon: 6,
  // tauri's bundle, where `icon.png` beside it is the 1024px master
  "128x128": 6,
  icon: 5,
  "apple-touch-icon": 4,
  logo: 3,
  "32x32": 2,
};

/** ties are broken on format: vector first, then the ones that scale down well */
const EXTS: Record<string, number> = { svg: 5, png: 4, webp: 3, ico: 2, gif: 1, jpg: 1, jpeg: 1 };

/** an icon we'd have to hold megabytes of to draw at 13px isn't one */
const MAX_BYTES = 4 * 1024 * 1024;

/** resolved once per root and kept: the answer can't change while zero is open
 *  without someone adding a favicon to a checkout mid-session */
const cache = new Map<string, Promise<string | null>>();

/**
 * Where to look, best first. A monorepo keeps its site under `apps/<name>/`,
 * so a repository that moved there — `public/` becoming `apps/web/public/` —
 * would otherwise lose its icon overnight. Those come after the root's own
 * source directories and before the bare root; `packages/*` are libraries,
 * whose icons are rarely the project's. An app called `web` goes first,
 * being the usual home of the favicon when there are several.
 */
async function searchDirs(root: string): Promise<string[]> {
  const apps = (await api.listDir(`${root}/apps`).catch(() => []))
    .filter((e) => e.is_dir && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort((a, b) => Number(b === "web") - Number(a === "web") || a.localeCompare(b));
  const own = DIRS.filter(Boolean);
  return [
    ...own.map((d) => `${root}/${d}`),
    ...apps.flatMap((app) => own.map((d) => `${root}/apps/${app}/${d}`)),
    root,
  ];
}

async function findIcon(root: string): Promise<string | null> {
  let best: { path: string; score: number } | null = null;

  const dirs = await searchDirs(root);
  for (let d = 0; d < dirs.length; d++) {
    const dir = dirs[d];
    const entries = await api.listDir(dir).catch(() => []);
    for (const e of entries) {
      if (e.is_dir) continue;
      const dot = e.name.lastIndexOf(".");
      if (dot <= 0) continue;
      const name = NAMES[e.name.slice(0, dot).toLowerCase()];
      const ext = EXTS[e.name.slice(dot + 1).toLowerCase()];
      if (!name || !ext) continue;
      // The name outranks the directory, because it is the better evidence
      // of shape: a favicon is square by definition, and a `logo.png` is
      // usually a wordmark — at 13px a smear, whichever folder it was in.
      const score = name * 1e6 + (dirs.length - d) * 100 + ext;
      if (!best || score > best.score) best = { path: `${dir}/${e.name}`, score };
    }
  }
  if (!best) return null;

  const buf = await api.readBinary(best.path).catch(() => null);
  if (!buf || buf.byteLength === 0 || buf.byteLength > MAX_BYTES) return null;

  // a data URL rather than an object URL: one icon per project lives as long
  // as the window does, and a string needs no revoking to not leak
  const bytes = new Uint8Array(buf);
  let bin = "";
  // in chunks — String.fromCharCode(...bytes) overflows the stack somewhere
  // around a hundred thousand of them, which a .ico can reach
  for (let i = 0; i < bytes.length; i += 8192)
    bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return `data:${imageType(best.path) ?? "image/png"};base64,${btoa(bin)}`;
}

export function projectIcon(root: string): Promise<string | null> {
  let hit = cache.get(root);
  if (!hit) {
    hit = findIcon(root).catch(() => null);
    cache.set(root, hit);
  }
  return hit;
}

/** roots that have an icon, mapped to it; the rest are simply absent */
export function useProjectIcons(roots: string[]): Record<string, string> {
  const [icons, setIcons] = useState<Record<string, string>>({});
  const key = roots.join(" ");

  useEffect(() => {
    let stop = false;
    for (const root of key ? key.split(" ") : []) {
      projectIcon(root).then((url) => {
        if (stop || !url) return;
        setIcons((prev) =>
          prev[root] === url ? prev : { ...prev, [root]: url },
        );
      });
    }
    return () => {
      stop = true;
    };
  }, [key]);

  return icons;
}

/**
 * The mark for a project that ships no icon of its own.
 *
 * A repository with nothing in `public/` would otherwise be the one tab with
 * an empty square, and "some tabs have a picture" is worse than either "all
 * do" or "none do". So it gets one drawn from its own path: the same 5×5
 * mirrored grid GitHub gives an account with no avatar, which is a shape you
 * come to recognise without ever being able to read it.
 *
 * Monochrome, and drawn in `currentColor` by the caller, because a coloured
 * blob would be the loudest thing on a bar whose own indicator is a white
 * hairline ring. It inherits the tab name's three brightnesses that way, and
 * being flat grey geometry it never passes for a favicon a project chose.
 *
 * Seeded on the absolute path rather than the remote: it costs no git call,
 * and two worktrees of one repository reading as two marks is right — they
 * are two tabs you need to tell apart.
 */
export function identicon(seed: string): boolean[] {
  // FNV-1a, then xorshift per cell: taking 15 adjacent bits of one hash puts
  // neighbouring cells on neighbouring bits, and near-identical paths — which
  // is what a directory of checkouts is — then differ by one square
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }

  const cells = new Array<boolean>(25).fill(false);
  let filled = 0;
  // the left three columns; the right two are their mirror, which is what
  // makes a random grid read as a thing rather than as noise
  for (let c = 0; c < 3; c++) {
    for (let r = 0; r < 5; r++) {
      h ^= h << 13;
      h ^= h >>> 17;
      h ^= h << 5;
      h |= 0;
      if ((h & 1) === 0) continue;
      cells[r * 5 + c] = true;
      cells[r * 5 + (4 - c)] = true;
      filled++;
    }
  }
  // one path in 32768 hashes to nothing at all, and an empty square is the
  // thing this function exists to prevent
  if (!filled) for (let r = 0; r < 5; r += 2) cells[r * 5 + 2] = true;
  return cells;
}
