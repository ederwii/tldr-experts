/**
 * `tldrx expert` — list, create, and print a training prompt.
 *
 * Concept §6. Experts are files. `list` recomputes every level from evidence
 * before printing it (spec §2.6), `create` refuses to overwrite one, and `train`
 * prints the prompt rather than pretending to run training, which is v1.1.
 */
import { join } from "node:path";
import type { Command } from "../Command.ts";
import { EXIT_FAILED, EXIT_NOT_IMPLEMENTED, EXIT_OK } from "../exitCodes.ts";
import { PROJECT_FRAMEWORK_DIR } from "../../core/paths.ts";
import { loadWorkspaceFile } from "../../core/init/loadWorkspaceFile.ts";
import {
  createExpert, expertListJson, isTrainMode, loadExpert, loadExperts,
  readExpertDocument, renderExpertList, renderTrainPrompt, resolveWorkspaceRoot,
  type TrainRepo,
} from "../../core/experts/index.ts";

const USAGE = [
  "Usage:",
  "  tldrx expert list [--root <path>] [--json]",
  "  tldrx expert create <name> [--domain <slug>] [--stack <lang>] [--root <path>]",
  "  tldrx expert train <name> --area <area> [--mode light|full] --print-prompt [--root <path>]",
].join("\n");

export const expertCommand: Command = {
  name: "expert",
  summary: "Manage the expert files",
  usage: "tldrx expert <list|create|train> [name]",
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

async function train(argv: readonly string[]): Promise<number> {
  if (!argv.includes("--print-prompt")) {
    process.stderr.write(
      "tldrx expert train: running training is v1.1 — use --print-prompt to get the prompt to paste\n",
    );
    return EXIT_NOT_IMPLEMENTED;
  }

  const name = positional(argv);
  const areaId = option(argv, "--area");
  if (name === null || areaId === null) {
    process.stderr.write(`tldrx expert train: a name and --area are required\n${USAGE}\n`);
    return EXIT_FAILED;
  }
  const modeArg = option(argv, "--mode") ?? "light";
  if (!isTrainMode(modeArg)) {
    process.stderr.write(`tldrx expert train: --mode must be light or full, got '${modeArg}'\n`);
    return EXIT_FAILED;
  }

  const root = resolveWorkspaceRoot(option(argv, "--root"));
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

  process.stdout.write(renderTrainPrompt({
    expert,
    document: readExpertDocument(root, name),
    area,
    mode: modeArg,
    repos: await repos(root),
  }));
  return EXIT_OK;
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
