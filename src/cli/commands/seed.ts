/** `tldrx seed` — Triage a big seed into several runs
 *
 * Spec §6.2. Three things, in the order you do them:
 *
 *   tldrx seed triage <path>            count it — free, deterministic, no model
 *   tldrx seed triage <path> --propose  ONE cheap model pass → split.yml
 *   tldrx seed apply <split.yml>        the human gate: create the runs
 *
 * `--propose` is the only one that spends anything, and it never creates a run.
 * `apply` is the only one that creates runs, and it never asks a model. Keeping
 * them apart is the whole point: "the model proposed it" and "we are doing it"
 * must not be the same event.
 */
import type { Command } from "../Command.ts";
import {
  EXIT_AGENT_FAILED, EXIT_GATE_REFUSED, EXIT_NOT_FOUND, EXIT_OK, EXIT_USAGE,
} from "../exitCodes.ts";
import { boolFlag, numberFlag, parseArgs, stringFlag, UsageError } from "../argv.ts";
import { workspaceRootFrom } from "../workspace.ts";
import { effortFlag } from "../effort.ts";
import { startUi } from "../ui.ts";
import { fail } from "../report.ts";
import { runTriage, type TriageMode } from "../../core/seed/runTriage.ts";
import { applySplit } from "../../core/seed/applySplit.ts";
import { answerSplitQuestion } from "../../core/seed/answerSplitQuestion.ts";
import { SeedError } from "../../core/seed/collectSeed.ts";
import { currentActor, nowRfc3339 } from "../../hooks/lib/actor.ts";

const VALUE_FLAGS = ["out", "threshold-tokens", "model", "effort", "max-usd", "root", "ui"];

/** Codes whose report belongs on stdout: the command did what it said it would. */
const INFORMATIONAL: readonly number[] = [EXIT_OK];

export const seedCommand: Command = {
  name: "seed",
  summary: "Triage a big seed into several runs, then create them",
  usage: "tldrx seed triage <path> [--out <dir>] [--json] [--threshold-tokens <n>] [--root <path>]\n" +
    "       tldrx seed triage <path> --propose [--model <m>] [--effort <level>] [--max-usd <n>]\n" +
    "                                          [--ui scene|compact|plain|off] [--prepare|--commit]\n" +
    "                                          [--yolo] [--out <dir>] [--root <path>]\n" +
    "       tldrx seed answer <split.yml> <Qid> \"<text>\" [--root <path>]\n" +
    "       tldrx seed apply <split.yml> [--dry-run] [--root <path>]",
  subcommands: ["triage", "answer", "apply"],
  implemented: true,
  async run(argv: readonly string[]): Promise<number> {
    const [sub, ...rest] = argv;
    switch (sub) {
      case "triage":
        return triage(rest);
      case "answer":
        return answer(rest);
      case "apply":
        return apply(rest);
      default:
        process.stderr.write(`tldrx seed: expected \`triage\`, \`answer\` or \`apply\`\n${seedCommand.usage}\n`);
        return EXIT_USAGE;
    }
  },
};

async function triage(argv: readonly string[]): Promise<number> {
  try {
    const args = parseArgs(argv, VALUE_FLAGS);
    const seedPath = args.positionals[0];
    if (seedPath === undefined) {
      throw new UsageError("seed triage needs a path: `tldrx seed triage <file|dir>`");
    }
    const root = workspaceRootFrom(args);
    const propose = boolFlag(args, "propose");
    const mode = resolveMode(boolFlag(args, "prepare"), boolFlag(args, "commit"));
    if (!propose && mode !== "headless") {
      throw new UsageError("--prepare/--commit only mean something with --propose (the free pass spawns nothing)");
    }

    // Only `--propose` in headless mode spawns anything; the free counting pass
    // and the `--prepare`/`--commit` halves get an inert handle.
    const ui = startUi(args, { root, title: `triage ${seedPath}`, spawns: propose && mode === "headless" });
    let outcome;
    try {
      outcome = await runTriage({
        root,
        seedPath,
        out: stringFlag(args, "out"),
        json: boolFlag(args, "json"),
        thresholdTokens: numberFlag(args, "threshold-tokens"),
        propose,
        mode,
        model: stringFlag(args, "model") ?? null,
        effort: effortFlag(args),
        maxUsd: numberFlag(args, "max-usd"),
        yolo: boolFlag(args, "yolo"),
        at: nowRfc3339(),
        now: new Date(),
      });
    } finally {
      ui.stop();
    }

    const text = `${outcome.lines.join("\n")}\n`;
    if (INFORMATIONAL.includes(outcome.code)) process.stdout.write(text);
    else process.stderr.write(prefix("seed triage", text));
    return outcome.code;
  } catch (error) {
    if (error instanceof UsageError) return fail("seed triage", error, EXIT_USAGE);
    if (error instanceof SeedError) return fail("seed triage", error, EXIT_USAGE);
    return fail("seed triage", error, codeFor(error));
  }
}

/**
 * `tldrx seed answer <split.yml> <Qid> "<text>"`.
 *
 * The answer is a positional, not a `--text` flag, so it reads the way
 * `tldrx answer Q1 "…"` already does. Everything after the id is joined, so an
 * unquoted multi-word answer records what was typed rather than its first word.
 */
function answer(argv: readonly string[]): number {
  try {
    const args = parseArgs(argv, VALUE_FLAGS);
    const [splitPath, id, ...rest] = args.positionals;
    if (splitPath === undefined || id === undefined || rest.length === 0) {
      throw new UsageError('seed answer needs three things: `tldrx seed answer <split.yml> <Qid> "<text>"`');
    }
    const outcome = answerSplitQuestion({
      root: workspaceRootFrom(args),
      splitPath,
      id,
      text: rest.join(" "),
    });
    const text = `${outcome.lines.join("\n")}\n`;
    if (INFORMATIONAL.includes(outcome.code)) process.stdout.write(text);
    else process.stderr.write(prefix("seed answer", text));
    return outcome.code;
  } catch (error) {
    if (error instanceof UsageError) return fail("seed answer", error, EXIT_USAGE);
    return fail("seed answer", error, EXIT_USAGE);
  }
}

function apply(argv: readonly string[]): number {
  try {
    const args = parseArgs(argv, VALUE_FLAGS);
    const splitPath = args.positionals[0];
    if (splitPath === undefined) {
      throw new UsageError("seed apply needs a split file: `tldrx seed apply <split.yml>`");
    }
    const root = workspaceRootFrom(args);
    const outcome = applySplit({
      root,
      splitPath,
      dryRun: boolFlag(args, "dry-run"),
      actor: currentActor(),
      now: new Date(),
    });

    const text = `${outcome.lines.join("\n")}\n`;
    if (INFORMATIONAL.includes(outcome.code)) process.stdout.write(text);
    else process.stderr.write(prefix("seed apply", text));
    for (const note of outcome.notes) process.stderr.write(`${note}\n`);
    return outcome.code;
  } catch (error) {
    if (error instanceof UsageError) return fail("seed apply", error, EXIT_USAGE);
    return fail("seed apply", error, EXIT_USAGE);
  }
}

function resolveMode(prepare: boolean, commit: boolean): TriageMode {
  if (prepare && commit) {
    throw new UsageError("--prepare and --commit are two halves of one handshake, not both at once");
  }
  if (prepare) return "prepare";
  if (commit) return "commit";
  return "headless";
}

function prefix(command: string, text: string): string {
  return text
    .split("\n")
    .map((line, i) => (line === "" ? line : i === 0 ? `tldrx ${command}: ${line}` : `  ${line}`))
    .join("\n");
}

/** Only the codes §6.2 lists come back deliberately; anything else lands on 1. */
function codeFor(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("no such file or directory")) return EXIT_NOT_FOUND;
  if (message.includes("refusing")) return EXIT_GATE_REFUSED;
  if (message.includes("sub-agent")) return EXIT_AGENT_FAILED;
  return EXIT_USAGE;
}
