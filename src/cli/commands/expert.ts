/**
 * `tldrx expert` — list, create, and train.
 *
 * Concept §6. Experts are files. `list` recomputes every level from evidence
 * before printing it (spec §2.6), `create` refuses to overwrite one, and `train`
 * RUNS: a deterministic pre-pass, one sub-agent, a knowledge file validated off
 * disk, and only then a level that moved because a file was cited.
 *
 * `--print-prompt` is unchanged and still costs nothing: it prints the
 * copy-paste prompt and spawns nothing, for a human who would rather drive the
 * session themselves.
 */
import { join } from "node:path";
import type { Command } from "../Command.ts";
import { EXIT_FAILED, EXIT_OK } from "../exitCodes.ts";
import { boolFlag, numberFlag, parseArgs, stringFlag, UsageError, type ParsedArgs } from "../argv.ts";
import { currentActor, nowRfc3339 } from "../../hooks/lib/actor.ts";
import { isTrainingMode, runTraining, type TrainingRunMode } from "../../core/training/index.ts";
import { PROJECT_FRAMEWORK_DIR } from "../../core/paths.ts";
import { loadWorkspaceFile } from "../../core/init/loadWorkspaceFile.ts";
import {
  createExpert, expertListJson, loadExpert, loadExperts,
  readExpertDocument, renderExpertList, renderTrainPrompt, resolveWorkspaceRoot,
  type TrainRepo,
} from "../../core/experts/index.ts";

const USAGE = [
  "Usage:",
  "  tldrx expert list [--root <path>] [--json]",
  "  tldrx expert create <name> [--domain <slug>] [--stack <lang>] [--root <path>]",
  "  tldrx expert train <name> --area <area> [--mode light|full] [--max-usd <n>]",
  "                                          [--model <m>] [--prepare|--commit] [--yolo] [--root <path>]",
  "  tldrx expert train <name> --area <area> [--mode light|full] --print-prompt [--root <path>]",
].join("\n");

export const expertCommand: Command = {
  name: "expert",
  summary: "List or create experts, or print a training prompt",
  usage: "tldrx expert list [--root <path>] [--json]\n" +
    "       tldrx expert create <name> [--domain <slug>] [--stack <lang>] [--root <path>]\n" +
    "       tldrx expert train <name> --area <area> [--mode light|full] [--max-usd <n>] [--model <m>]\n" +
    "                                               [--prepare|--commit] [--yolo] [--print-prompt] [--root <path>]",
  subcommands: ["list", "create", "train"],
  implemented: true,
  async run(argv: readonly string[]): Promise<number> {
    const [sub, ...rest] = argv;
    switch (sub) {
      case "list": return listExperts(rest);
      case "create": return create(rest);
      case "train": return train(rest);
      default:
        process.stderr.write(`tldrx expert: expected list, create or train\n${USAGE}\n`);
        return EXIT_FAILED;
    }
  },
};

function listExperts(argv: readonly string[]): number {
  const root = resolveWorkspaceRoot(option(argv, "--root"));
  const experts = loadExperts(root);
  const output = argv.includes("--json") ? expertListJson(experts) : renderExpertList(experts);
  process.stdout.write(`${output}\n`);
  return EXIT_OK;
}

async function create(argv: readonly string[]): Promise<number> {
  const name = positional(argv);
  if (name === null) {
    process.stderr.write(`tldrx expert create: a name is required\n${USAGE}\n`);
    return EXIT_FAILED;
  }
  const root = resolveWorkspaceRoot(option(argv, "--root"));
  try {
    const created = await createExpert({
      root,
      name,
      domain: option(argv, "--domain"),
      stack: option(argv, "--stack"),
      createdAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    });
    const areas = created.areas.length === 0
      ? "no areas — every level starts at 0 because there is no evidence yet"
      : `areas: ${created.areas.join(", ")} (level 0 until training gives them evidence)`;
    process.stdout.write(`created ${created.dir}\n  ${areas}\n`);
    return EXIT_OK;
  } catch (error) {
    process.stderr.write(`tldrx expert create: ${message(error)}\n`);
    return EXIT_FAILED;
  }
}

const TRAIN_VALUE_FLAGS = ["root", "area", "mode", "max-usd", "model"] as const;

async function train(argv: readonly string[]): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv, [...TRAIN_VALUE_FLAGS]);
  } catch (error) {
    process.stderr.write(`tldrx expert train: ${message(error)}\n`);
    return EXIT_FAILED;
  }

  const name = args.positionals[0];
  const areaId = stringFlag(args, "area");
  if (name === undefined || areaId === undefined) {
    process.stderr.write(`tldrx expert train: a name and --area are required\n${USAGE}\n`);
    return EXIT_FAILED;
  }
  const modeArg = stringFlag(args, "mode") ?? "light";
  if (!isTrainingMode(modeArg)) {
    process.stderr.write(`tldrx expert train: --mode must be light or full, got '${modeArg}'\n`);
    return EXIT_FAILED;
  }

  const root = resolveWorkspaceRoot(stringFlag(args, "root") ?? null);
  const expert = loadExpert(root, name);
  if (expert.error !== null) {
    process.stderr.write(`tldrx expert train: ${name}: ${expert.error}\n`);
    return EXIT_FAILED;
  }
  const area = expert.areas.find((candidate) => candidate.id === areaId);
  if (area === undefined) {
    const known = expert.areas.map((candidate) => candidate.id).join(", ") || "none";
    process.stderr.write(`tldrx expert train: ${name} has no area '${areaId}' (areas: ${known})\n`);
    return EXIT_FAILED;
  }

  // `--print-prompt` is the v0 behaviour, kept byte-identical: print and spawn
  // nothing. It is not a dry run of the real path — it is the prompt a human
  // pastes into their own session.
  if (boolFlag(args, "print-prompt")) {
    process.stdout.write(renderTrainPrompt({
      expert,
      document: readExpertDocument(root, name),
      area,
      mode: modeArg,
      repos: await repos(root),
    }));
    return EXIT_OK;
  }

  let runMode: TrainingRunMode;
  try {
    runMode = resolveRunMode(boolFlag(args, "prepare"), boolFlag(args, "commit"));
  } catch (error) {
    process.stderr.write(`tldrx expert train: ${message(error)}\n`);
    return EXIT_FAILED;
  }

  let maxUsd: number | undefined;
  try {
    maxUsd = numberFlag(args, "max-usd");
  } catch (error) {
    process.stderr.write(`tldrx expert train: ${message(error)}\n`);
    return EXIT_FAILED;
  }

  const outcome = await runTraining({
    root,
    expert: name,
    area: areaId,
    mode: modeArg,
    run: runMode,
    maxUsd,
    model: stringFlag(args, "model") ?? null,
    yolo: boolFlag(args, "yolo"),
    actor: currentActor(),
    at: nowRfc3339(),
  });

  const text = `${outcome.lines.join("\n")}\n`;
  if (outcome.code === EXIT_OK) process.stdout.write(text);
  else process.stderr.write(prefix(text));
  return outcome.code;
}

function resolveRunMode(prepare: boolean, commit: boolean): TrainingRunMode {
  if (prepare && commit) {
    throw new UsageError("--prepare and --commit are two halves of one handshake, not both at once");
  }
  if (prepare) return "prepare";
  if (commit) return "commit";
  return "headless";
}

function prefix(text: string): string {
  return text
    .split("\n")
    .map((line, i) => (line === "" ? line : i === 0 ? `tldrx expert train: ${line}` : `  ${line}`))
    .join("\n");
}

async function repos(root: string): Promise<readonly TrainRepo[]> {
  try {
    const workspace = await loadWorkspaceFile(join(root, PROJECT_FRAMEWORK_DIR));
    return workspace.repos.map((repo) => ({ name: repo.name, path: repo.path }));
  } catch {
    return [];
  }
}

/** The first argument that is neither a flag nor a flag's value. */
function positional(argv: readonly string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const current = argv[i] ?? "";
    if (current.startsWith("--")) {
      if (TAKES_VALUE.has(current)) i += 1;
      continue;
    }
    return current;
  }
  return null;
}

const TAKES_VALUE = new Set(["--root", "--domain", "--stack", "--area", "--mode"]);

function option(argv: readonly string[], name: string): string | null {
  const at = argv.indexOf(name);
  if (at === -1) return null;
  const value = argv[at + 1];
  return value === undefined || value.startsWith("--") ? null : value;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
