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
import { attendRun } from "../../core/run/attend.ts";
import { ATTENDED_BY, type AttendedBy } from "../../core/run/RunFile.ts";
import { parallelFlag } from "./next.ts";
import { cancelRun, unlockRun } from "../../core/run/rescue.ts";
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
import { estimateNextStage, renderEstimate, EstimateError } from "../../core/budget/estimateView.ts";

/**
 * Spec §6.2: over this many documents a seed is worth triaging even when it is
 * small, because "50 files" is a shape problem, not a size problem. `[assumption]`
 */
const HINT_FILE_COUNT = 10;

const VALUE_FLAGS = [
  "title", "scope", "budget", "repos", "from", "seed", "gates", "run", "root",
  "max-usd", "until", "model", "effort", "ui", "note", "parallel", "attended-by",
];

export const runCommand: Command = {
  name: "run",
  summary: "Create, inspect or auto-run a piece of work",
  usage: "tldrx run new <slug> [--title <t>] [--scope <s>] [--budget <usd>] [--repos a,b]\n" +
    "                  [--from <aidlc-intent-dir> | --seed <file|dir> ...] [--gates <a,b|all|none>]\n" +
    "                  [--attended-by host] [--root <path>]\n" +
    "       tldrx run attend <host|--none> [<run>] [--root <path>]\n" +
    "       tldrx run status [<run>] [--json] [--root <path>]\n" +
    "       tldrx run estimate [<run>] [--json] [--root <path>]\n" +
    "       tldrx run auto [<run>] [--max-usd <n>] [--until <stage>] [--model <m>] [--effort <level>]\n" +
    "                  [--yolo] [--parallel <n>] [--ui scene|compact|plain|off] [--root <path>]\n" +
    "       tldrx run unlock [<run>] [--force] [--root <path>]\n" +
    "       tldrx run cancel [<run>] --note <text> [--force] [--root <path>]",
  subcommands: ["new", "attend", "status", "estimate", "auto", "unlock", "cancel"],
  implemented: true,
  async run(argv: readonly string[]): Promise<number> {
    const [sub, ...rest] = argv;
    switch (sub) {
      case "new":
        return runNew(rest);
      case "attend":
        return runAttend(rest);
      case "status":
        return runStatus(rest);
      case "estimate":
        return runEstimate(rest);
      case "auto":
        return await runAutoLoop(rest);
      case "unlock":
        return runUnlock(rest);
      case "cancel":
        return runCancel(rest);
      default:
        process.stderr.write(
          `tldrx run: expected \`new\`, \`attend\`, \`status\`, \`estimate\`, \`auto\`, \`unlock\` or \`cancel\`\n`
            + `${runCommand.usage}\n`,
        );
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
      attendedBy: attendedByFlag(args),
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
 * `--attended-by <value>` — refused rather than coerced when it is not `host`.
 *
 * One legal value today (§2.2), and a typo that silently opened an ORDINARY run
 * would be the worst possible failure of this flag: the operator would think
 * nothing spawns, and everything would.
 */
function attendedByFlag(args: Parameters<typeof stringFlag>[0]): AttendedBy | undefined {
  const value = stringFlag(args, "attended-by");
  if (value === undefined) return undefined;
  if (!(ATTENDED_BY as readonly string[]).includes(value)) {
    throw new UsageError(`--attended-by must be one of ${ATTENDED_BY.join(" | ")} (got '${value}')`);
  }
  return value as AttendedBy;
}

/**
 * `tldrx run attend host|none [<run>]`, with `--none` accepted in place of the
 * word because that is how the design spells it.
 *
 * The direction is a REQUIRED positional rather than a flag-or-default: "attend"
 * with nothing after it could plausibly mean either direction, and guessing which
 * would be guessing about whether a run is allowed to spend money.
 */
function runAttend(argv: readonly string[]): number {
  try {
    const args = parseArgs(argv, VALUE_FLAGS);
    const none = boolFlag(args, "none");
    const word = args.positionals[0];
    let attendedBy: AttendedBy | null;
    let positionalRun: string | undefined;
    if (none) {
      if (word === "host") {
        throw new UsageError("run attend: `host` and `--none` are opposite directions — pass one");
      }
      attendedBy = null;
      positionalRun = word === "none" ? args.positionals[1] : word;
    } else if (word === "host") {
      attendedBy = "host";
      positionalRun = args.positionals[1];
    } else if (word === "none") {
      attendedBy = null;
      positionalRun = args.positionals[1];
    } else {
      throw new UsageError(
        "run attend needs a direction: `tldrx run attend host` hands the run to a host session, "
        + "`tldrx run attend --none` hands it back to the framework",
      );
    }
    return report("run attend", attendRun({
      root: workspaceRootFrom(args),
      runId: positionalRun ?? stringFlag(args, "run"),
      attendedBy,
      actor: currentActor(),
      at: nowRfc3339(),
    }));
  } catch (error) {
    return fail("run attend", error);
  }
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
        parallel: parallelFlag(args),
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

/**
 * `tldrx run estimate` — what the NEXT stage is likely to cost.
 *
 * Separate from `tldrx cost` on purpose, and separate from `budget show`: one
 * reports what WAS charged, one reports what a ceiling ALLOWS, and this one is
 * the only one of the three that guesses. It says so in its own output.
 */
function runEstimate(argv: readonly string[]): number {
  try {
    const args = parseArgs(argv, VALUE_FLAGS);
    const root = workspaceRootFrom(args);
    const estimate = estimateNextStage(root, args.positionals[0] ?? stringFlag(args, "run"));
    process.stdout.write(
      boolFlag(args, "json")
        ? `${JSON.stringify(estimate, null, 2)}\n`
        : `${renderEstimate(estimate)}\n`,
    );
    return EXIT_OK;
  } catch (error) {
    if (error instanceof EstimateError) {
      process.stderr.write(`tldrx run estimate: ${error.message}\n`);
      return EXIT_NOT_FOUND;
    }
    return fail("run estimate", error);
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

/**
 * Both rescue commands print to stdout on success and stderr on refusal, the
 * same way `next` does — a refusal is not a result, and a script that pipes
 * stdout should not have to filter one out of the other.
 */
function report(name: string, outcome: { code: number; lines: readonly string[] }): number {
  const text = `${outcome.lines.join("\n")}\n`;
  if (outcome.code === EXIT_OK) process.stdout.write(text);
  else process.stderr.write(`tldrx ${name}: ${text}`);
  return outcome.code;
}

function runUnlock(argv: readonly string[]): number {
  try {
    const args = parseArgs(argv, VALUE_FLAGS);
    return report("run unlock", unlockRun({
      root: workspaceRootFrom(args),
      runId: args.positionals[0] ?? stringFlag(args, "run"),
      force: boolFlag(args, "force"),
      actor: currentActor(),
      at: nowRfc3339(),
    }));
  } catch (error) {
    return fail("run unlock", error);
  }
}

function runCancel(argv: readonly string[]): number {
  try {
    const args = parseArgs(argv, VALUE_FLAGS);
    return report("run cancel", cancelRun({
      root: workspaceRootFrom(args),
      runId: args.positionals[0] ?? stringFlag(args, "run"),
      note: stringFlag(args, "note") ?? "",
      force: boolFlag(args, "force"),
      actor: currentActor(),
      at: nowRfc3339(),
    }));
  } catch (error) {
    return fail("run cancel", error);
  }
}
