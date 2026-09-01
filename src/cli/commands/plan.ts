/**
 * `tldrx plan` — operator verbs that act on a run's `03-plan/` artefacts.
 *
 * One subcommand today: `sync-dod`. It carries an edited `.tldrx/workspace.yml`
 * into the ```dod blocks of stories that are already approved, mechanically, and
 * it is the only sanctioned way to do that — the story files are the state
 * (spec §1), and hand-editing an artefact an agent signed is a provenance smell
 * the framework should not be forcing on anyone.
 *
 * Deliberately not a flag on `story`. `story reopen` is about ONE story's
 * attempts; this is about the whole plan's relationship to the workspace, it
 * spends nothing, spawns nothing and moves no cursor.
 *
 * The work is in `core/plan/syncDod.ts` and `core/plan/workspaceHistory.ts`;
 * this file is argv, writes and exit codes.
 */
import { join } from "node:path";
import type { Command } from "../Command.ts";
import { EXIT_GATE_REFUSED, EXIT_OK, EXIT_USAGE } from "../exitCodes.ts";
import { boolFlag, parseArgs, stringFlag } from "../argv.ts";
import { workspaceRootFrom } from "../workspace.ts";
import { fail } from "../report.ts";
import { isResolved, resolveRunOrExplain } from "../resolveRun.ts";
import { loadWorkspace } from "../../hooks/lib/workspace.ts";
import { writeAtomic } from "../../core/fs/writeAtomic.ts";
import { PLAN_PHASE } from "../../core/build/plan.ts";
import { planSyncDod, renderSyncReport } from "../../core/plan/syncDod.ts";
import { readWorkspaceHistory } from "../../core/plan/workspaceHistory.ts";

const VALUE_FLAGS = ["run", "root"];

export const planCommand: Command = {
  name: "plan",
  summary: "Resync approved story dod blocks with an edited workspace.yml",
  usage: "tldrx plan sync-dod [--dry-run] [--run <id>] [--root <path>]",
  subcommands: ["sync-dod"],
  implemented: true,
  async run(argv: readonly string[]): Promise<number> {
    const [sub, ...rest] = argv;
    if (sub === "sync-dod") return await syncDod(rest);
    process.stderr.write(`tldrx plan: expected \`sync-dod\`\n${planCommand.usage}\n`);
    return EXIT_USAGE;
  },
};

/**
 * Exit 0 when every dod line was either already current or had an ancestor to
 * follow; exit 2 when one did not.
 *
 * 2 rather than 1 for the same reason `resolveRun` uses it: the command is well
 * formed and the files all exist — it is DECLINING to rewrite a line whose
 * ancestry it cannot show. The stories it could sync are still synced, because
 * one undecidable line in one story is not a reason to leave the other seven
 * broken.
 */
async function syncDod(argv: readonly string[]): Promise<number> {
  try {
    const args = parseArgs(argv, VALUE_FLAGS);
    const root = workspaceRootFrom(args);
    const resolved = resolveRunOrExplain("tldrx plan sync-dod", root, stringFlag(args, "run"));
    if (!isResolved(resolved)) return resolved.exit;

    const dryRun = boolFlag(args, "dry-run");
    const workspace = loadWorkspace(root);
    const reading = await readWorkspaceHistory(root);
    const report = planSyncDod({
      planDir: join(resolved.store.runDir, PLAN_PHASE),
      current: workspace.commandRoles,
      history: reading.history,
    });
    if (!dryRun) {
      // `writeAtomic`, not `writeFileSync`: these are approved artefacts and it
      // keeps the previous version at `<story>.md.bak`, so a mechanical rewrite
      // of somebody's signed plan is always exactly one step back.
      for (const story of report.changed) {
        if (story.text !== null) writeAtomic(story.path, story.text);
      }
    }

    const lines = [...renderSyncReport(report, dryRun)];
    if (reading.unavailable !== null) {
      lines.push(
        `note: ${reading.unavailable}. Without it a line the current workspace.yml does not declare has no `
        + "ancestor to follow, so it is flagged rather than rewritten.",
      );
    }
    process.stdout.write(`${lines.join("\n")}\n`);
    return report.flagged.length > 0 ? EXIT_GATE_REFUSED : EXIT_OK;
  } catch (error) {
    return fail("plan sync-dod", error);
  }
}
