/**
 * A dod command that CANCELS the run it is running inside — the collision
 * gh #305's review named: `tldrx run cancel --force` typed while a Build stage
 * holds the run. Walks up from its cwd (a story worktree, under the workspace
 * root) to the workspace, then calls the same `cancelRun` the CLI calls, forced,
 * because the live `.lock` would otherwise refuse it. Exits 0 so the story's DoD
 * is green and the executor carries on to its next spawn — which is the thing
 * under test.
 */
import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { cancelRun } from "../../../src/core/run/rescue.ts";
import { PROJECT_FRAMEWORK_DIR } from "../../../src/core/paths.ts";

const cwd = process.cwd();
let root = cwd;
while (!existsSync(join(root, ".tldrx", "workspace.yml"))) {
  const parent = dirname(root);
  if (parent === root) {
    process.stderr.write("cancelFromDod: no workspace above cwd\n");
    process.exit(3);
  }
  root = parent;
}
// The Build's BASE pre-flight runs the same command on the repo checkout before
// any spawn (`build/dodRunner.ts`); only a STORY's dod runs in a worktree under
// `<root>/.tldrx/`. Green there, so the cancel lands AFTER a developer has run —
// the mid-fan-out collision the test is about — and not before the first spawn.
if (!relative(root, cwd).startsWith(PROJECT_FRAMEWORK_DIR)) process.exit(0);
const outcome = cancelRun({
  root, note: "operator cancel from a dod command", force: true, actor: "alan", at: "2026-09-14T06:35:00Z",
});
process.stdout.write(`${outcome.lines.join("\n")}\n`);
process.exit(outcome.code === 0 ? 0 : 4);
