import { deletableWorktrees, remainingRemovalFailures, removeWorktree, removeWorktrees } from "./worktreeRemoval";

// Run with esbuild --bundle --platform=node --format=esm, then node.
function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
const main = (path: string) => ({ path, owner: path, is_main: true });
const linked = (owner: string, path: string) => ({ path, owner, is_main: false });
const bot = linked("/bot", "/trees/bot-173");
const backend = linked("/backend", "/trees/backend-173");
const ui = linked("/ui", "/trees/ui-173");
const worktrees = [main("/ui"), ui, main("/bot"), bot, main("/backend"), backend, bot];

equal(deletableWorktrees(worktrees), [ui, bot, backend]);
const calls: unknown[] = [];
const progress: unknown[] = [];
const failures = await removeWorktrees(worktrees, "/ui", async (root, path, force) => {
  calls.push([root, path, force]);
  if (path === bot.path) throw new Error("locked");
}, (done, total) => progress.push([done, total]));
equal(calls, [["/ui", ui.path, true], ["/bot", bot.path, true], ["/backend", backend.path, true]]);
equal(failures, [{ path: bot.path, message: "Error: locked" }]);
// A later refresh or successful single delete resolves only the missing paths.
equal(remainingRemovalFailures(failures, [main("/bot"), bot]), failures);
equal(remainingRemovalFailures(failures, [main("/bot"), ui]), []);
equal(remainingRemovalFailures(failures, []), []);
equal(remainingRemovalFailures([...failures, { path: ui.path, message: "busy" }], [ui]),
  [{ path: ui.path, message: "busy" }]);
equal(progress, [[0, 3], [1, 3], [2, 3]]);

// Both the normal single deletion and its force retry must use the owner.
calls.length = 0;
for (const force of [false, true]) {
  await removeWorktree(backend, "/ui", force, async (...args) => { calls.push(args); });
}
await removeWorktree({ path: "/legacy-tree", is_main: false }, "/legacy", false,
  async (...args) => { calls.push(args); });
equal(calls, [["/backend", backend.path, false], ["/backend", backend.path, true],
  ["/legacy", "/legacy-tree", false]]);

equal(await removeWorktrees([main("/ui")], "/ui", async () => {
  throw new Error("Main checkouts must never be deleted");
}, () => { throw new Error("No deletion should start"); }), []);
console.log("worktree removal tests passed");
