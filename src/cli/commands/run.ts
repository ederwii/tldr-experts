/** `tldrx run` — Create or inspect a piece of work
 *
 * Spec §3. `run new` seeds `tldrx-work/<yymmdd>-<slug>/` from a scope preset and
 * its stage files; `--from` distills an AI-DLC intent folder into `01-what/` first
 * (§6) and `--seed` imports any Markdown/plain-text document or directory of them
 * (§6.1). `run status` renders the execution path. All of it is deterministic: no
 * LLM, no network, nothing that can invent a result.
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
import { openRunRows, renderOpenRuns } from "../../core/run/openRuns.ts";
import { notFound } from "../resolveRun.ts";
import { currentActor } from "../../hooks/lib/actor.ts";
import { PROJECT_WORK_DIR } from "../../core/paths.ts";

const VALUE_FLAGS = ["title", "scope", "budget", "repos", "from", "seed", "run", "root"];

export const runCommand: Command = {
  name: "run",
  summary: "Create or inspect a piece of work",
  usage: "tldrx run new <slug> [--title <t>] [--scope <s>] [--budget <usd>] [--repos a,b]\n" +
    "                  [--from <aidlc-intent-dir> | --seed <file|dir>] [--root <path>]\n" +
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
      seed: stringFlag(args, "seed"),
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
          `${result.claims.length} finding(s), ${outcome.factsAppended} new fact(s), ` +
          `${outcome.factsReused} already known, ` +
          `${result.conflicts.length} question(s), ` +
          `${result.droppedUnanswered + result.droppedConflicting} dropped ` +
          `(${result.droppedUnanswered} unanswered, ${result.droppedConflicting} conflicting)`,
      );
    }
    const seed = outcome.seed;
    if (seed !== null) {
      lines.push(
        `seeded from ${seed.source}: ${seed.documents.length} document(s), ` +
          `${seed.documents.reduce((sum, document) => sum + document.lines, 0)} line(s), ` +
          `${seed.skipped.length} skipped`,
      );
      for (const warning of seed.warnings) lines.push(`  warning: ${warning}`);
    }
    lines.push(`next: tldrx run status ${outcome.runId}`);
    process.stdout.write(`${lines.join("\n")}\n`);

    // Several open runs stay legal — each has its own budget.yml, events.jsonl
    // and epic branch. What is no longer legal is guessing between them, so say
    // so at the moment the second one appears rather than at the first refusal.
    const others = RunStore.findOpen(root).filter((store) => store.runId !== outcome.runId).length;
    if (others > 0) {
      process.stderr.write(
        `note: ${String(others)} other run(s) open — pass a run id to next/answer/approve/… from now on\n`,
      );
    }
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
    const json = boolFlag(args, "json");
    const resolution = RunStore.resolve(root, wanted);

    if (resolution.kind === "none") {
      process.stderr.write(`tldrx run status: ${notFound(wanted)} in ${PROJECT_WORK_DIR}/\n`);
      return EXIT_NOT_FOUND;
    }

    // Several runs open and no id: SHOW them rather than refuse. `run status` is
    // the screen you read to find out which id to pass to everything else, so a
    // refusal here would be a locked door with the key behind it. Exit 0 — this
    // is a complete answer, not a degraded one.
    if (resolution.kind === "ambiguous") {
      const views = resolution.open.map((store) => buildStatus(store.run, store.budget, store.runDir));
      process.stdout.write(
        json
          ? `${JSON.stringify({ runs: views }, null, 2)}\n`
          : `${renderOpenRuns(openRunRows(resolution.open))}\n`,
      );
      return EXIT_OK;
    }

    const store = resolution.store;
    const view = buildStatus(store.run, store.budget, store.runDir);
    process.stdout.write(json ? `${JSON.stringify(view, null, 2)}\n` : `${renderStatus(view)}\n`);
    return EXIT_OK;
  } catch (error) {
    return fail("run status", error);
  }
}
