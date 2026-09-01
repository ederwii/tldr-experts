/**
 * `tldrx plan` — operator verbs that act on a run's `03-plan/` artefacts.
 *
 * Two subcommands. `sync-dod` carries an edited `.tldrx/workspace.yml`
 * into the ```dod blocks of stories that are already approved, mechanically, and
 * it is the only sanctioned way to do that — the story files are the state
 * (spec §1), and hand-editing an artefact an agent signed is a provenance smell
 * the framework should not be forcing on anyone.
 *
 * Deliberately not a flag on `story`. `story reopen` is about ONE story's
 * attempts; this is about the whole plan's relationship to the workspace, it
 * spends nothing, spawns nothing and moves no cursor.
 *
 * `schema` prints the story/epic/waves contract (#71). Since #48 deleted
 * `templates/story.md` and `templates/epic.md` — rightly: nothing read them, so
 * nothing kept them honest — the generated contract's only reader has been the
 * Plan stage's prompt, which is to say the shape existed for the agent and not
 * for the person writing or reviewing a story by hand. This subcommand renders
 * the SAME bytes that prompt is given, so it cannot become the second copy the
 * templates were.
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
import { planContractExamples, renderPlanSchemaContract } from "../../core/plan/schemaContract.ts";

const VALUE_FLAGS = ["run", "root"];

export const planCommand: Command = {
  name: "plan",
  summary: "Resync approved story dod blocks with workspace.yml, or print the plan schema",
  usage: "tldrx plan sync-dod [--dry-run] [--run <id>] [--root <path>]\ntldrx plan schema [--story | --epic | --waves]",
  subcommands: ["sync-dod", "schema"],
  implemented: true,
  async run(argv: readonly string[]): Promise<number> {
    const [sub, ...rest] = argv;
    if (sub === "sync-dod") return await syncDod(rest);
    if (sub === "schema") return schema(rest);
    process.stderr.write(`tldrx plan: expected \`sync-dod\` or \`schema\`\n${planCommand.usage}\n`);
    return EXIT_USAGE;
  },
};

/** The three things `--story`, `--epic` and `--waves` select, in usage order. */
const EXAMPLES = ["story", "epic", "waves"] as const;

/**
 * Print the contract, or one example from it. Exit 0, or 1 for an ambiguous ask.
 *
 * Deliberately the one verb in `plan` that resolves nothing: no workspace, no run,
 * no cursor, no disk. The question it answers — "what shape is a story file?" — is
 * asked BEFORE any of that exists, and often from outside a workspace entirely.
 */
function schema(argv: readonly string[]): number {
  try {
    const args = parseArgs(argv, []);
    const picked = EXAMPLES.filter((name) => boolFlag(args, name));
    if (picked.length > 1) {
      process.stderr.write(
        `tldrx plan schema: pass at most one of ${EXAMPLES.map((n) => `--${n}`).join(", ")}`
        + ` — got ${picked.map((n) => `--${n}`).join(" ")}. Without one, the whole contract is printed.\n`,
      );
      return EXIT_USAGE;
    }
    const only = picked[0];
    // `renderPlanSchemaContract()` verbatim: the same bytes `checkContracts.ts`
    // splices into the Plan prompt, minus the `## ` heading that file owns.
    const text = only === undefined ? renderPlanSchemaContract() : planContractExamples()[only].trimEnd();
    process.stdout.write(`${text}\n`);
    return EXIT_OK;
  } catch (error) {
    return fail("plan schema", error);
  }
}

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
