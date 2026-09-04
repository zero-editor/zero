import type { Project } from "../App";

/**
 * A project is one folder, or several.
 *
 * Several is for a codebase split across repositories that aren't siblings on
 * disk — open the parent folder when they are, and none of this is needed.
 * The extras live in `Project.folders`; `root` stays the project's identity
 * and is not one of them, because everything keyed on a project is keyed on
 * that string: its stored session, its notes, its Linear config, the cwd its
 * terminals open in. A project that could change which folder it *is* would
 * lose all four.
 */
export function folders(p: Project): string[] {
  return p.folders?.length ? [p.root, ...p.folders] : [p.root];
}

/** More than one folder is what makes the tree grow headers and the changes
 *  panel name its groups — a one-folder project looks exactly as it did. */
export const isMulti = (p: Project): boolean => (p.folders?.length ?? 0) > 0;

/** The last path segment, which is what a folder is called. */
export const baseName = (path: string): string => path.split("/").filter(Boolean).pop() ?? path;

/**
 * Why a folder can't join a project, or null if it can.
 *
 * Nesting is refused rather than merely discouraged. Two roots where one
 * contains the other would draw the same files twice — and since the tree
 * renders every row into one flat list, the same absolute path twice is the
 * same React key twice, which is a corrupted tree rather than a redundant one.
 */
export function rejects(have: string[], dir: string): string | null {
  for (const f of have) {
    if (f === dir) return "That folder is already in this project.";
    if (dir.startsWith(f + "/")) return `${baseName(dir)} is already inside ${baseName(f)}.`;
    if (f.startsWith(dir + "/")) return `${baseName(dir)} contains ${baseName(f)}, which is already in this project.`;
  }
  return null;
}

/** The project a path belongs to, looking at every folder rather than just
 *  the root — a file dropped from an added folder belongs here, not in a new
 *  project of its own. */
export function holding(projects: Project[], path: string): Project | undefined {
  return projects.find((p) => folders(p).some((f) => path === f || path.startsWith(f + "/")));
}

/**
 * A short, unique name for each folder — what quick open and search put in
 * front of a path so `src/main.ts` from three repositories reads as three
 * different files.
 *
 * The last segment when that already tells them apart, and more of the path
 * when it doesn't: two checkouts both called `web`, under different parents,
 * are exactly the case a bare basename would collapse into one. They all grow
 * together rather than only the colliding pair, because a list where some rows
 * carry two segments and others one reads as noise.
 */
export function labels(roots: string[]): string[] {
  const parts = roots.map((r) => r.split("/").filter(Boolean));
  let depth = 1;
  let out = parts.map((p) => p.slice(-depth).join("/"));
  while (new Set(out).size !== out.length && depth < 8) {
    depth += 1;
    out = parts.map((p) => p.slice(-depth).join("/"));
  }
  return out;
}
