import type { WorktreeChanges } from "./gitStatus";

type Target = Pick<WorktreeChanges, "path" | "owner" | "is_main">;
export type WorktreeRemovalFailure = { path: string; message: string };

export function remainingRemovalFailures(failures: WorktreeRemovalFailure[], worktrees: Target[]) {
  const remaining = new Set(worktrees.map((wt) => wt.path));
  return failures.filter((failure) => remaining.has(failure.path));
}

type Remove = (root: string, path: string, force: boolean) => Promise<unknown>;

export function deletableWorktrees<T extends Target>(worktrees: T[]): T[] {
  // A repository can also be opened through one of its linked worktrees.
  // Such a project lists the same checkout under more than one folder.
  return [...new Map(worktrees.filter((wt) => !wt.is_main).map((wt) => [wt.path, wt])).values()];
}

export function removeWorktree(wt: Target, fallbackRoot: string, force: boolean, remove: Remove) {
  return remove(wt.owner ?? fallbackRoot, wt.path, force);
}

export async function removeWorktrees(
  worktrees: Target[],
  fallbackRoot: string,
  remove: Remove,
  progress: (done: number, total: number) => void,
): Promise<WorktreeRemovalFailure[]> {
  const targets = deletableWorktrees(worktrees);
  const failures: WorktreeRemovalFailure[] = [];
  // Finish the other repositories even if one worktree is locked or missing.
  for (const [i, wt] of targets.entries()) {
    progress(i, targets.length);
    try {
      await removeWorktree(wt, fallbackRoot, true, remove);
    } catch (e) {
      failures.push({ path: wt.path, message: String(e) });
    }
  }
  return failures;
}
