import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMANDS, lookup } from "../src/cli/index.ts";
import { EXIT_FAILED, EXIT_NOT_IMPLEMENTED, EXIT_OK } from "../src/cli/exitCodes.ts";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";
import { noSpawnEnv } from "./fixtures/noSpawnPath.ts";

const BIN = join(FRAMEWORK_ROOT, "bin", "tldrx.ts");

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function tldrxIn(cwd: string, ...args: string[]): Promise<Run> {
  const proc = Bun.spawn(["bun", BIN, ...args], { stdout: "pipe", stderr: "pipe", cwd, env: noSpawnEnv() });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

async function tldrx(...args: string[]): Promise<Run> {
  return tldrxIn(FRAMEWORK_ROOT, ...args);
}

describe("tldrx --version", () => {
  test("prints the package.json version and exits 0", async () => {
    const run = await tldrx("--version");
    expect(run.code).toBe(EXIT_OK);
    expect(run.stdout.trim()).toBe(JSON.parse(await Bun.file(new URL("../package.json", import.meta.url)).text()).version);
  });

  test("`version` and `-v` are the same command", () => {
    expect(lookup("version")).toBe(lookup("--version"));
    expect(lookup("-v")).toBe(lookup("--version"));
  });
});

describe("tldrx --help", () => {
  test("exits 0 and lists every command", async () => {
    const run = await tldrx("--help");
    expect(run.code).toBe(EXIT_OK);
    for (const command of COMMANDS) expect(run.stdout).toContain(command.name);
  });

  // The `*` marker and its legend travel together: printing the legend over a
  // list that carries no `*` is itself a false claim about the CLI.
  test("the stub marker and its legend appear together, or not at all", async () => {
    const run = await tldrx("--help");
    const stubs = COMMANDS.filter((c) => !c.implemented);
    expect(run.stdout.includes("* = not implemented yet")).toBe(stubs.length > 0);
    for (const command of COMMANDS.filter((c) => c.implemented)) {
      expect(run.stdout).not.toContain(`* ${command.name}`);
    }
  });

  test("every command's one-line summary is the one it declares", async () => {
    const run = await tldrx("--help");
    for (const command of COMMANDS) expect(run.stdout).toContain(command.summary);
  });

  test("bare invocation prints help rather than pretending to work", async () => {
    const run = await tldrx();
    expect(run.code).toBe(EXIT_OK);
    expect(run.stdout).toContain("Usage: tldrx <command>");
  });
});

describe("stub commands", () => {
  const stubs = COMMANDS.filter((c) => !c.implemented);

  // v0 ships every command implemented; the generic stub list may be empty.
  // What must hold: `doctor` is never a stub, and any stub that does exist
  // honours the exit-64 contract (looped below).
  test("doctor is never a stub", () => {
    expect(stubs.map((c) => c.name)).not.toContain("doctor");
  });

  for (const command of stubs) {
    test(`\`tldrx ${command.name}\` exits 64 with the standard notice`, async () => {
      const run = await tldrx(command.name);
      expect(run.code).toBe(EXIT_NOT_IMPLEMENTED);
      expect(run.stderr.trim()).toBe(`tldrx ${command.name}: not implemented yet (v0 roadmap)`);
      // A stub must never print anything that could be read as success.
      expect(run.stdout).toBe("");
    });
  }

  // `expert train` without --print-prompt is a v1.1 stub by design (spec §6),
  // so it is the stable example of a subcommand that exits 64.
  // `expert train` is implemented since wave 7, so this checks the message
  // PREFIX on the error it now gives for an expert that does not exist — the
  // property this test has always been about.
  test("a subcommand is named in the notice", async () => {
    const run = await tldrx("expert", "train", "foo", "--area", "bar");
    expect(run.code).toBe(EXIT_FAILED);
    expect(run.stderr.trim().startsWith("tldrx expert train:")).toBe(true);
  });

  // `map --check` used to live here, then `dashboard --static`; both are
  // implemented now, so this uses a command that is still a stub.
  test("a flag is not mistaken for a subcommand", async () => {
    const run = await tldrx("expert", "train", "foo", "--area", "bar", "--mode", "light");
    expect(run.stderr.trim().startsWith("tldrx expert train:")).toBe(true);
    expect(run.stderr).not.toContain("--mode");
  });
});

describe("<command> --help", () => {
  // `--help` is a question about the CLI, not about a project: it must answer
  // from a directory that has no workspace at all.
  const foreign = mkdtempSync(join(tmpdir(), "tldrx-nohelp-"));

  afterAll(() => rmSync(foreign, { recursive: true, force: true }));

  for (const name of ["next", "run", "answer", "approve", "reject", "retro"]) {
    test(`\`tldrx ${name} --help\` prints usage and exits 0 with no .tldrx`, async () => {
      const run = await tldrxIn(foreign, name, "--help");
      expect(run.stderr).toBe("");
      expect(run.code).toBe(EXIT_OK);
      expect(run.stdout).toContain(`tldrx ${name} —`);
      expect(run.stdout).toContain("Usage:");
      expect(run.stdout).not.toContain("run `tldrx init` first");
    });
  }

  test("-h is the same as --help", async () => {
    const run = await tldrxIn(foreign, "next", "-h");
    expect(run.code).toBe(EXIT_OK);
    expect(run.stdout).toContain("tldrx next —");
  });

  test("subcommands are listed when the command takes them", async () => {
    const run = await tldrxIn(foreign, "run", "--help");
    expect(run.stdout).toContain("Subcommands: new, status");
  });
});

describe("unknown commands", () => {
  test("exit 64 and point at --help", async () => {
    const run = await tldrx("definitely-not-a-command");
    expect(run.code).toBe(EXIT_NOT_IMPLEMENTED);
    expect(run.stderr).toContain("unknown command 'definitely-not-a-command'");
    expect(run.stdout).toBe("");
  });
});
