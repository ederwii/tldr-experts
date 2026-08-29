/**
 * Command detection: the only commands the DoD gate and the map are allowed to
 * run (spec §2.1).
 *
 * `null` means "not found", which is NOT the same as "there is none" — the
 * handoff and the interview say which. A command is only recorded when a file on
 * disk declares it; nothing here is conventional wisdom about a stack.
 */
import { join } from "node:path";
import { lineOf } from "./lineOf.ts";
import { walkFiles } from "./walk.ts";
import { runtime } from "../runtime/index.ts";
import { COMMAND_SLOTS, type CommandSlot, type Evidence, type RepoCommands } from "./types.ts";
import type { StackDetection } from "./stack.ts";

/** Script names accepted for each slot, in preference order. */
const SCRIPT_ALIASES: Readonly<Record<CommandSlot, readonly string[]>> = {
  build: ["build"],
  test: ["test"],
  lint: ["lint"],
  typecheck: ["typecheck", "type-check", "tsc"],
  run: ["dev", "start"],
};

/** Shell metacharacters banned by spec §2.1: a command must be a single argv. */
const SHELL_METACHARACTERS = /[&;|>`]/;

export interface DetectedCommands {
  readonly commands: RepoCommands;
  readonly evidence: readonly Evidence[];
  /** Slots no file on disk declared. */
  readonly missing: readonly CommandSlot[];
}

export function isSingleArgvCommand(command: string): boolean {
  return command.trim() !== "" && !SHELL_METACHARACTERS.test(command);
}

export async function detectCommands(repoDir: string, stack: StackDetection): Promise<DetectedCommands> {
  const found = new Map<CommandSlot, { command: string; evidence: Evidence }>();

  addPackageScripts(found, stack);
  await addDotnet(found, repoDir, stack);
  await addPython(found, repoDir, stack);
  addGoAndRust(found, stack);
  await addMakefile(found, repoDir);

  const commands: Record<CommandSlot, string | null> = {
    build: null, test: null, lint: null, typecheck: null, run: null,
  };
  const evidence: Evidence[] = [];
  const missing: CommandSlot[] = [];

  for (const slot of COMMAND_SLOTS) {
    const hit = found.get(slot);
    if (hit === undefined || !isSingleArgvCommand(hit.command)) {
      missing.push(slot);
      continue;
    }
    commands[slot] = hit.command;
    evidence.push(hit.evidence);
  }
  return { commands, evidence, missing };
}

type Found = Map<CommandSlot, { command: string; evidence: Evidence }>;

function record(found: Found, slot: CommandSlot, command: string, evidence: Evidence): void {
  if (found.has(slot)) return; // first source wins; detection order is the preference order
  found.set(slot, { command, evidence });
}

function addPackageScripts(found: Found, stack: StackDetection): void {
  const pkg = stack.packageJson;
  if (pkg === null) return;
  const runner = stack.packageManager ?? "npm";
  for (const slot of COMMAND_SLOTS) {
    for (const alias of SCRIPT_ALIASES[slot]) {
      if (!(alias in pkg.scripts)) continue;
      record(found, slot, `${runner} run ${alias}`, {
        claim: `\`${slot}\` runs \`${runner} run ${alias}\``,
        src: `${pkg.path}:${lineOf(pkg.text, `"${alias}"`)}`,
      });
      break;
    }
  }
}

async function addDotnet(found: Found, repoDir: string, stack: StackDetection): Promise<void> {
  if (!stack.languages.includes("dotnet")) return;
  const files = await walkFiles(repoDir, { maxDepth: 4, maxFiles: 8000 });
  const projects = files.filter((file) => file.path.endsWith(".csproj")).map((file) => file.path);
  const solution = files.find((file) => file.path.endsWith(".sln"))?.path;
  const anchor = solution ?? projects[0];
  if (anchor === undefined) return;

  record(found, "build", "dotnet build", { claim: "`build` runs `dotnet build`", src: `${anchor}:1` });
  record(found, "lint", "dotnet format --verify-no-changes", {
    claim: "`lint` runs `dotnet format --verify-no-changes`", src: `${anchor}:1`,
  });

  const testProject = projects.find((path) => /test/i.test(path));
  if (testProject !== undefined) {
    record(found, "test", "dotnet test", { claim: "`test` runs `dotnet test`", src: `${testProject}:1` });
  }
  const runnable = projects.filter((path) => !/test/i.test(path));
  const only = runnable.length === 1 ? runnable[0] : undefined;
  if (only !== undefined) {
    record(found, "run", `dotnet run --project ${only}`, {
      claim: `\`run\` starts the only non-test project`, src: `${only}:1`,
    });
  }
}

async function addPython(found: Found, repoDir: string, stack: StackDetection): Promise<void> {
  if (!stack.languages.includes("python")) return;
  for (const manifest of ["pyproject.toml", "requirements.txt"]) {
    const path = join(repoDir, manifest);
    if (!(await runtime.exists(path))) continue;
    const text = await runtime.readText(path);
    for (const [needle, slot, command] of [
      ["pytest", "test", "pytest"],
      ["ruff", "lint", "ruff check ."],
      ["mypy", "typecheck", "mypy ."],
    ] as const) {
      if (!text.includes(needle)) continue;
      record(found, slot, command, {
        claim: `\`${slot}\` runs \`${command}\``, src: `${manifest}:${lineOf(text, needle)}`,
      });
    }
  }
}

function addGoAndRust(found: Found, stack: StackDetection): void {
  if (stack.languages.includes("go")) {
    record(found, "build", "go build ./...", { claim: "`build` runs `go build ./...`", src: "go.mod:1" });
    record(found, "test", "go test ./...", { claim: "`test` runs `go test ./...`", src: "go.mod:1" });
  }
  if (stack.languages.includes("rust")) {
    record(found, "build", "cargo build", { claim: "`build` runs `cargo build`", src: "Cargo.toml:1" });
    record(found, "test", "cargo test", { claim: "`test` runs `cargo test`", src: "Cargo.toml:1" });
  }
}

const MAKE_TARGET = /^([A-Za-z0-9_.-]+):(?!=)/;

async function addMakefile(found: Found, repoDir: string): Promise<void> {
  const path = join(repoDir, "Makefile");
  if (!(await runtime.exists(path))) return;
  const text = await runtime.readText(path);
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) continue;
    const match = MAKE_TARGET.exec(line);
    const target = match?.[1];
    if (target === undefined) continue;
    if (!isCommandSlot(target)) continue;
    record(found, target, `make ${target}`, {
      claim: `\`${target}\` runs \`make ${target}\``, src: `Makefile:${i + 1}`,
    });
  }
}

function isCommandSlot(value: string): value is CommandSlot {
  return (COMMAND_SLOTS as readonly string[]).includes(value);
}
