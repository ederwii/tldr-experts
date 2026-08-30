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
import { listFlag, numberFlag, parseArgs, repeatedFlag, stringFlag, UsageError, boolFlag } from "../argv.ts";
import { workspaceRootFrom } from "../workspace.ts";
import { startUi } from "../ui.ts";
import { effortFlag } from "../effort.ts";
import { fail } from "../report.ts";
import { runAuto } from "../../core/facilitator/runAuto.ts";
import { nowRfc3339 } from "../../hooks/lib/actor.ts";
import { createRun } from "../../core/run/newRun.ts";
import { RunStore } from "../../core/run/RunStore.ts";
import { buildStatus, renderStatus } from "../../core/run/runStatus.ts";
import { openRunRows, renderOpenRuns } from "../../core/run/openRuns.ts";
import { notFound } from "../resolveRun.ts";
import { currentActor } from "../../hooks/lib/actor.ts";
import { PROJECT_WORK_DIR } from "../../core/paths.ts";
import { loadWorkspace } from "../../hooks/lib/workspace.ts";
import { estimateTokens, formatTokens, DEFAULT_THRESHOLD_TOKENS } from "../../core/seed/triageInventory.ts";

/**
 * Spec §6.2: over this many documents a seed is worth triaging even when it is
 * small, because "50 files" is a shape problem, not a size problem. `[assumption]`
 */
const HINT_FILE_COUNT = 10;

const VALUE_FLAGS = [
  "title", "scope", "budget", "repos", "from", "seed", "gates", "run", "root",
  "max-usd", "until", "model", "effort", "ui",
];

export const runCommand: Command = {
  name: "run",
  summary: "Create, inspect or auto-run a piece of work",
  usage: "tldrx run new <slug> [--title <t>] [--scope <s>] [--budget <usd>] [--repos a,b]\n" +
    "                  [--from <aidlc-intent-dir> | --seed <file|dir> ...] [--gates <a,b|all|none>]\n" +
    "                  [--root <path>]\n" +
    "       tldrx run status [<run>] [--json] [--root <path>]\n" +
    "       tldrx run auto [<run>] [--max-usd <n>] [--until <stage>] [--model <m>] [--effort <level>]\n" +
    "                  [--yolo] [--ui scene|compact|plain|off] [--root <path>]",
  subcommands: ["new", "status", "auto"],
  implemented: true,
  async run(argv: readonly string[]): Promise<number> {
    const [sub, ...rest] = argv;
    switch (sub) {
      case "new":
        return runNew(rest);
      case "status":
        return runStatus(rest);
      case "auto":
        return await runAutoLoop(rest);
      default:
        process.stderr.write(`tldrx run: expected \`new\`, \`status\` or \`auto\`\n${runCommand.usage}\n`);
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
    // `--seed` is repeatable (spec §6.2). One occurrence is the string form and is
    // byte-for-byte what it always was; several are merged, deduped and re-sorted.
    const seeds = repeatedFlag(args, "seed");
    const outcome = createRun({
      root,
      slug,
      title: stringFlag(args, "title"),
      scope: stringFlag(args, "scope") ?? "feature",
      budgetUsd: numberFlag(args, "budget"),
      repos: listFlag(args, "repos"),
      from: stringFlag(args, "from"),
      seed: seeds.length === 0 ? undefined : seeds.length === 1 ? seeds[0] : seeds,
      gates: stringFlag(args, "gates"),
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

    // The seed is bigger than one run should carry: say so, once, on STDERR.
    // stdout is parsed by the chat bridge and by `--json` consumers downstream,
    // and a note is not a result. It is a note, not a refusal — a big seed in one
    // run still works, it is just more expensive than it needs to be.
    for (const line of seedHint(root, seed, seeds)) process.stderr.write(`${line}\n`);

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

/**
 * The one-line nudge toward `tldrx seed triage` (spec §6.2, F4).
 *
 * Two triggers, either alone is enough: over the token threshold (this is a big
 * document set and one run will pay for all of it at every stage) or over ten
 * files (this is several pieces of work wearing one folder). Silent otherwise.
 */
function seedHint(
  root: string,
  seed: { readonly documents: readonly { readonly bytes: number }[]; readonly sources: readonly string[] } | null,
  seeds: readonly string[],
): readonly string[] {
  if (seed === null || seeds.length === 0) return [];
  const bytes = seed.documents.reduce((sum, document) => sum + document.bytes, 0);
  const tokens = estimateTokens(bytes);
  const threshold = loadWorkspace(root).seedTriageThresholdTokens ?? DEFAULT_THRESHOLD_TOKENS;
  if (tokens <= threshold && seed.documents.length <= HINT_FILE_COUNT) return [];
  return [
    `note: seed is ${String(seed.documents.length)} files / ${formatTokens(tokens)} tokens — `
    + `\`tldrx seed triage ${seed.sources[0] ?? seeds[0] ?? ""}\` can propose a split`,
  ];
}

/**
 * Every line goes to stdout as it happens — it is a progress log, and a loop that
 * printed nothing for twenty minutes would be indistinguishable from a hang. The
 * stop reason is the last line and the exit code carries it; nothing is repeated
 * on stderr, so `run auto | tee` is the whole record.
 */
async function runAutoLoop(argv: readonly string[]): Promise<number> {
  try {
    const args = parseArgs(argv, VALUE_FLAGS);
    const root = workspaceRootFrom(args);
    // The scene persists across the whole loop; `runNext` re-titles the
    // blackboard at each stage boundary.
    const ui = startUi(args, { root, title: "run auto" });
    try {
      const outcome = await runAuto({
        root,
        runId: args.positionals[0] ?? stringFlag(args, "run"),
        maxUsd: numberFlag(args, "max-usd"),
        until: stringFlag(args, "until"),
        model: stringFlag(args, "model"),
        effort: effortFlag(args),
        yolo: boolFlag(args, "yolo"),
        actor: currentActor(),
        at: nowRfc3339(),
        // Erase the view, let the stage line scroll past on stdout, repaint. A
        // progress view that let stdout tear through it would lose both.
        onLine: (line) => ui.log(() => process.stdout.write(`${line}\n`)),
      });
      return outcome.code;
    } finally {
      ui.stop();
    }
  } catch (error) {
    return fail("run auto", error);
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
