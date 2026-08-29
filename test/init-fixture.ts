/**
 * Fixture workspaces for the init / map / detect tests.
 *
 * Real directories with real git repos: detection reads `.git`, `git log` and
 * `git symbolic-ref`, so faking the filesystem would test the mock instead of
 * the code. Every fixture is created under the OS temp dir and removed by the
 * test that made it.
 */
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResult, CommandRunner } from "../src/core/detect/CommandRunner.ts";

export interface Fixture {
  /** Absolute workspace root. */
  readonly root: string;
  cleanup(): Promise<void>;
}

/** A multi-repo workspace: one npm/TypeScript repo, one .NET repo. */
export async function multiRepoFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "tldrx-multi-"));
  await gitInit(root);
  await Bun.write(join(root, "README.md"), "# workspace\n");
  await commitAll(root, "root");

  await makeNodeRepo(join(root, "lab"));
  await makeDotnetRepo(join(root, "Api.Service"));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** A single-repo workspace: the root itself is the only git repo. */
export async function singleRepoFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "tldrx-single-"));
  await makeNodeRepo(root);
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** A workspace root that is not a git repo and holds no git repos. */
export async function emptyFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "tldrx-empty-"));
  await Bun.write(join(root, "notes.txt"), "nothing here\n");
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

export async function makeNodeRepo(dir: string): Promise<void> {
  await mkdir(join(dir, "src", "features"), { recursive: true });
  await Bun.write(join(dir, "package.json"), JSON.stringify({
    name: "lab",
    version: "1.0.0",
    scripts: {
      build: "vite build",
      test: "vitest run",
      lint: "eslint .",
      typecheck: "tsc --noEmit",
      dev: "vite",
    },
    dependencies: { react: "^19.0.0" },
    devDependencies: { typescript: "^5.0.0", vite: "^5.0.0" },
  }, null, 2) + "\n");
  await Bun.write(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }, null, 2) + "\n");
  await Bun.write(join(dir, ".eslintrc.json"), JSON.stringify({ root: true }, null, 2) + "\n");
  await Bun.write(join(dir, "src", "index.ts"), "// TODO: wire the router\nexport const start = (): void => {};\n");
  await Bun.write(join(dir, "src", "features", "hunts.ts"), "export const hunts = [];\n");
  await mkdir(join(dir, ".github", "workflows"), { recursive: true });
  await Bun.write(join(dir, ".github", "workflows", "ci.yml"), "name: ci\n");
  await gitInit(dir);
  await commitAll(dir, "feat: initial lab");
}

export async function makeDotnetRepo(dir: string): Promise<void> {
  await mkdir(join(dir, "src", "Api"), { recursive: true });
  await mkdir(join(dir, "tests", "Api.Tests"), { recursive: true });
  await Bun.write(join(dir, "Api.sln"), "Microsoft Visual Studio Solution File\n");
  await Bun.write(join(dir, "src", "Api", "Api.csproj"), "<Project Sdk=\"Microsoft.NET.Sdk.Web\" />\n");
  await Bun.write(join(dir, "tests", "Api.Tests", "Api.Tests.csproj"), "<Project Sdk=\"Microsoft.NET.Sdk\" />\n");
  await Bun.write(join(dir, "src", "Api", "Program.cs"), "// FIXME: move startup out of Program\npublic class Program { }\n");
  await Bun.write(join(dir, ".editorconfig"), "root = true\n");
  await gitInit(dir);
  await commitAll(dir, "fix: initial api");
}

/** A CommandRunner that answers from a table — no process is ever spawned. */
export function fakeRunner(
  responses: ReadonlyMap<string, CommandResult>,
  fallback: CommandResult = { exitCode: 127, stdout: "", stderr: "not stubbed" },
): CommandRunner & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async run(argv: readonly string[]): Promise<CommandResult> {
      const key = argv.join(" ");
      calls.push(key);
      for (const [prefix, response] of responses) {
        if (key.startsWith(prefix)) return response;
      }
      return fallback;
    },
  };
}

export function okResult(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

async function gitInit(dir: string): Promise<void> {
  await run(["git", "init", "-b", "main"], dir);
  await run(["git", "config", "user.email", "fixture@example.com"], dir);
  await run(["git", "config", "user.name", "Fixture"], dir);
}

async function commitAll(dir: string, message: string): Promise<void> {
  await run(["git", "add", "-A"], dir);
  await run(["git", "commit", "-m", message, "--no-gpg-sign"], dir);
}

async function run(argv: readonly string[], cwd: string): Promise<void> {
  const [command, ...args] = argv;
  if (command === undefined) return;
  const proc = Bun.spawn([command, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  await new Response(proc.stdout).text();
  await new Response(proc.stderr).text();
  await proc.exited;
}
