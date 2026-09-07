/**
 * Command detection: the only commands the DoD gate and the map are allowed to
 * run (spec §2.1).
 *
 * `null` means "not found", which is NOT the same as "there is none" — the
 * handoff and the interview say which.
 *
 * A command comes from one of TWO places and this file now says which (#168). Most
 * are DECLARED: a `package.json` script, a `Makefile` target — a line on disk a
 * reader can open. The rest are SYNTHESISED from the language id alone —
 * `go build ./...`, `cargo test`, `dotnet build`, and python's tools from a mention
 * in a manifest, which proves the tool is named, not that it runs. Those are
 * conventional wisdom about a stack, this header used to claim there was none of it
 * here, and the claim was the thing that was false. `synthesised` is the flag that
 * makes the difference readable, and `detect/probeCommands.ts` is what turns it into
 * a record instead of a hope.
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
  /**
   * Slots whose command was inferred from the language id rather than read from a
   * declaration — the convention half of this file, named so nothing downstream has
   * to guess which half it is holding.
   */
  readonly synthesised: ReadonlySet<CommandSlot>;
}

export function isSingleArgvCommand(command: string): boolean {
  return command.trim() !== "" && !SHELL_METACHARACTERS.test(command);
}

export async function detectCommands(repoDir: string, stack: StackDetection): Promise<DetectedCommands> {
  const found: Found = new Map();

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
  const synthesised = new Set<CommandSlot>();

  for (const slot of COMMAND_SLOTS) {
    const hit = found.get(slot);
    if (hit === undefined || !isSingleArgvCommand(hit.command)) {
      missing.push(slot);
      continue;
    }
    commands[slot] = hit.command;
    evidence.push(hit.evidence);
    if (hit.synthesised) synthesised.add(slot);
  }
  return { commands, evidence, missing, synthesised };
}

type Found = Map<CommandSlot, { command: string; evidence: Evidence; synthesised: boolean }>;

/**
 * `synthesised` is a fourth ARGUMENT rather than a second map on purpose: a slot's
 * origin is a property of the row that won, and two containers would let them drift
 * the moment "first source wins" picks a different source.
 */
function record(
  found: Found, slot: CommandSlot, command: string, evidence: Evidence, synthesised = false,
): void {
  if (found.has(slot)) return; // first source wins; detection order is the preference order
  found.set(slot, { command, evidence, synthesised });
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

  // Synthesised: a `.sln`/`.csproj` proves a .NET project exists, not that `dotnet
  // build` is how this team builds it.
  record(found, "build", "dotnet build", { claim: "`build` runs `dotnet build`", src: `${anchor}:1` }, true);
  record(found, "lint", "dotnet format --verify-no-changes", {
    claim: "`lint` runs `dotnet format --verify-no-changes`", src: `${anchor}:1`,
  }, true);

  const testProject = projects.find((path) => /test/i.test(path));
  if (testProject !== undefined) {
    record(found, "test", "dotnet test", { claim: "`test` runs `dotnet test`", src: `${testProject}:1` }, true);
  }
  const runnable = projects.filter((path) => !/test/i.test(path));
  const only = runnable.length === 1 ? runnable[0] : undefined;
  if (only !== undefined) {
    record(found, "run", `dotnet run --project ${only}`, {
      claim: `\`run\` starts the only non-test project`, src: `${only}:1`,
    }, true);
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
      // Synthesised: `pytest` appearing in `requirements.txt` proves the package is a
      // dependency. It does not prove `pytest` runs, or that it is how tests are run here.
      record(found, slot, command, {
        claim: `\`${slot}\` runs \`${command}\``, src: `${manifest}:${lineOf(text, needle)}`,
      }, true);
    }
  }
}

/**
 * The most synthesised of all: nothing is read but the language id. `go.mod:1` and
 * `Cargo.toml:1` cite the manifest's existence, not a line that declares a command.
 */
function addGoAndRust(found: Found, stack: StackDetection): void {
  if (stack.languages.includes("go")) {
    record(found, "build", "go build ./...", { claim: "`build` runs `go build ./...`", src: "go.mod:1" }, true);
    record(found, "test", "go test ./...", { claim: "`test` runs `go test ./...`", src: "go.mod:1" }, true);
  }
  if (stack.languages.includes("rust")) {
    record(found, "build", "cargo build", { claim: "`build` runs `cargo build`", src: "Cargo.toml:1" }, true);
    record(found, "test", "cargo test", { claim: "`test` runs `cargo test`", src: "Cargo.toml:1" }, true);
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
