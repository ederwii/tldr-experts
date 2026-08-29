/** `tldrx run` — Create or inspect a piece of work
 *
 * Spec §3. `run new` seeds `tldrx-work/<yymmdd>-<slug>/` from a scope preset and
 * its stage files; `--from` distills an AI-DLC intent folder into `01-what/` first
 * (§6). `run status` renders the execution path. Both are deterministic: no LLM,
 * no network, nothing that can invent a result.
 */
import { basename } from "node:path";
import type { Command } from "../Command.ts";
import { EXIT_NOT_FOUND, EXIT_OK, EXIT_USAGE } from "../exitCodes.ts";
import { listFlag, numberFlag, parseArgs, stringFlag, UsageError, boolFlag } from "../argv.ts";
import { workspaceRootFrom } from "../workspace.ts";
import { fail } from "../report.ts";
import { createRun } from "../../core/run/newRun.ts";
import { RunStore } from "../../core/run/RunStore.ts";
import { buildStatus, renderStatus } from "../../core/run/runStatus.ts";
import { currentActor } from "../../hooks/lib/actor.ts";
import { PROJECT_WORK_DIR } from "../../core/paths.ts";

const VALUE_FLAGS = ["title", "scope", "budget", "repos", "from", "run", "root"];

export const runCommand: Command = {
  name: "run",
  summary: "Create or inspect a piece of work",
  usage: "tldrx run new <slug> [--title <t>] [--scope <s>] [--budget <usd>] [--repos a,b] [--from <path>] [--root <path>]\n" +
    "       tldrx run status [<run>] [--json] [--root <path>]",
  subcommands: ["new", "status"],
  implemented: true,
  async run(argv: readonly string[]): Promise<number> {
    const [sub, ...rest] = argv;
    switch (sub) {
      case "new":
        return runNew(rest);
      case "status":
        return runStatus(rest);
      default:
        process.stderr.write(`tldrx run: expected \`new\` or \`status\`\n${runCommand.usage}\n`);
        return EXIT_USAGE;
    }
  },
};

function runNew(argv: readonly string[]): number {
  try {
    const args = parseArgs(argv, VALUE_FLAGS);
    const slug = args.positionals[0];
    if (slug === undefined) throw new UsageError("run new needs a slug: `tldrx run new <slug>`");

    const root = workspaceRootFrom(args);
    const outcome = createRun({
      root,
      slug,
      title: stringFlag(args, "title"),
      scope: stringFlag(args, "scope") ?? "feature",
      budgetUsd: numberFlag(args, "budget"),
      repos: listFlag(args, "repos"),
      from: stringFlag(args, "from"),
      actor: currentActor(),
      now: new Date(),
    });

    const lines = [
      `created ${PROJECT_WORK_DIR}/${outcome.runId} — scope ${outcome.preset.name} ` +
        `(${basename(outcome.preset.source)}), ${outcome.stageCount} stage(s), ` +
        `$${outcome.ceilingUsd.toFixed(2)} ceiling`,
    ];
    for (const file of outcome.files) lines.push(`  ${file}`);
    const result = outcome.distill;
    if (result !== null) {
      lines.push(
        `distilled ${result.filesRead.length} file(s) from ${result.intentDir}: ` +
          `${result.claims.length} finding(s), ${result.facts.length} fact(s), ` +
          `${result.conflicts.length} question(s), ` +
          `${result.droppedUnanswered + result.droppedConflicting} dropped ` +
          `(${result.droppedUnanswered} unanswered, ${result.droppedConflicting} conflicting)`,
      );
    }
    lines.push(`next: tldrx run status ${outcome.runId}`);
    process.stdout.write(`${lines.join("\n")}\n`);
    return EXIT_OK;
  } catch (error) {
    return fail("run new", error);
  }
}

function runStatus(argv: readonly string[]): number {
  try {
    const args = parseArgs(argv, VALUE_FLAGS);
    const root = workspaceRootFrom(args);
    const wanted = args.positionals[0] ?? stringFlag(args, "run");
    const store = RunStore.find(root, wanted);
    if (store === null) {
      process.stderr.write(
        wanted === undefined
          ? `tldrx run status: no non-terminal run in ${PROJECT_WORK_DIR}/\n`
          : `tldrx run status: no run '${wanted}' in ${PROJECT_WORK_DIR}/\n`,
      );
      return EXIT_NOT_FOUND;
    }
    const view = buildStatus(store.run, store.budget, store.runDir);
    process.stdout.write(
      boolFlag(args, "json") ? `${JSON.stringify(view, null, 2)}\n` : `${renderStatus(view)}\n`,
    );
    return EXIT_OK;
  } catch (error) {
    return fail("run status", error);
  }
}
