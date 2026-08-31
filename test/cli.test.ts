import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMANDS, lookup } from "../src/cli/index.ts";
import { flagNames } from "../src/cli/argv.ts";
import { EXIT_FAILED, EXIT_NOT_IMPLEMENTED, EXIT_OK, EXIT_USAGE } from "../src/cli/exitCodes.ts";
import {
  declaredFlags, EXIT_MEANINGS, helpFor, HELP_ENTRIES, scopeValues, supportsJson,
} from "../src/cli/helpText.ts";
import { EFFORT_LEVELS } from "../src/core/schemas/stage.ts";
import { UI_MODES } from "../src/core/ui/index.ts";
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
    expect(run.stdout).toContain("Subcommands: new, attend, status");
  });
});

describe("unknown commands", () => {
  // Exit 1, not 64: a word that was never a command is a usage error. 64 means
  // "on the roadmap, not built", which a typo has no business claiming.
  test("exit 1 and point at --help", async () => {
    const run = await tldrx("definitely-not-a-command");
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.stderr).toContain("unknown command 'definitely-not-a-command'");
    expect(run.stdout).toBe("");
  });

  test("64 is reserved: no command in this build is a stub, so nothing returns it", () => {
    expect(COMMANDS.filter((command) => !command.implemented)).toEqual([]);
    expect(EXIT_NOT_IMPLEMENTED).toBe(64);
  });
});

// --- the help registry -------------------------------------------------------

describe("helpText registry", () => {
  test("every dispatchable command has an entry", () => {
    for (const command of [...COMMANDS, lookup("version"), lookup("help")]) {
      expect(helpFor(command?.name ?? "")).toBeDefined();
    }
  });

  test("every entry declares at least exit 0, and only documented codes", () => {
    for (const entry of HELP_ENTRIES) {
      expect(entry.exits).toContain(0);
      for (const code of entry.exits) expect(EXIT_MEANINGS.has(code)).toBe(true);
    }
  });

  /**
   * The invariant that keeps the guard honest: a flag the code READS but the
   * registry does not declare would be rejected before the command ever saw it.
   * So the flags are re-derived from the source — every `boolFlag`/`stringFlag`/…
   * call, every `parseArgs` value list, every `argv.includes("--x")` — and each
   * one must appear in the registry.
   */
  test("every flag a command reads is declared", () => {
    const missing: string[] = [];
    for (const [command, files] of SOURCE_OF) {
      const declared = declaredFlags(command);
      for (const flag of flagsReadBy(files)) {
        if (!declared.has(flag)) missing.push(`${command}: --${flag}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("--scope lists the workflow stems on disk, not a hard-coded list", () => {
    const stems = readdirSync(join(FRAMEWORK_ROOT, "workflows"))
      .filter((entry) => entry.endsWith(".yml"))
      .map((entry) => entry.slice(0, -4))
      .sort();
    expect(scopeValues(FRAMEWORK_ROOT)).toEqual(stems);
    expect(stems.length).toBeGreaterThan(0);
  });
});

/** Which source files a command's flags can be read in. `hook.ts` holds two. */
const SOURCE_OF: ReadonlyMap<string, readonly string[]> = new Map([
  ...COMMANDS.filter((command) => command.name !== "statusline" && command.name !== "hook")
    .map((command) => [command.name, [`${command.name}.ts`]] as const),
  ["hook", ["hook.ts"]] as const,
  ["statusline", ["hook.ts"]] as const,
]);

/**
 * Every flag name the given command sources read, however they read it: through
 * `argv.ts`'s accessors, through a `parseArgs` value list, through a bare
 * `argv.includes("--x")`, through a `case "--x":`, and through the three shared
 * helpers that read a fixed flag of their own (`workspaceRootFrom` → `--root`,
 * `effortFlag` → `--effort`, `startUi` → `--ui`).
 */
function flagsReadBy(files: readonly string[]): ReadonlySet<string> {
  const found = new Set<string>();
  for (const file of files) {
    const source = readFileSync(join(FRAMEWORK_ROOT, "src", "cli", "commands", file), "utf8");
    for (const pattern of [
      /(?:boolFlag|stringFlag|numberFlag|listFlag|repeatedFlag)\(\s*args\s*,\s*"([a-z0-9-]+)"/g,
      /args\.flags\.(?:has|get)\("([a-z0-9-]+)"\)/g,
      /(?:argv\.includes|option)\(\s*(?:argv,\s*)?"--([a-z0-9-]+)"/g,
      /case "--([a-z0-9-]+)"/g,
    ]) {
      for (const match of source.matchAll(pattern)) if (match[1] !== undefined) found.add(match[1]);
    }
    // `parseArgs(argv, [...])` and the `VALUE_FLAGS` constants it is given.
    for (const pattern of [
      /parseArgs\(\s*\w+\s*,\s*\[([^\]]*)\]/g,
      /VALUE_FLAGS\s*(?::[^=]*)?=\s*\[([^\]]*)\]/g,
    ]) {
      for (const match of source.matchAll(pattern)) {
        for (const literal of (match[1] ?? "").matchAll(/"([a-z0-9-]+)"/g)) {
          if (literal[1] !== undefined) found.add(literal[1]);
        }
      }
    }
    if (source.includes("workspaceRootFrom(")) found.add("root");
    if (source.includes("effortFlag(")) found.add("effort");
    if (source.includes("startUi(")) found.add("ui");
  }
  return found;
}

// --- unknown flags -----------------------------------------------------------

describe("unknown flags", () => {
  test("`tldrx status --nope` is refused, and says where to look", async () => {
    const run = await tldrx("status", "--nope");
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.stderr).toContain("unknown flag --nope (see `tldrx status --help`)");
    expect(run.stdout).toBe("");
  });

  // The guard scans argv the same way `parseArgs` does, or it would refuse a
  // VALUE that happens to look like a flag. Asserted directly, because the CLI
  // path cannot distinguish "read the same way" from "happened to agree".
  test("the scan mirrors parseArgs exactly", () => {
    const takesValue = new Set(["root", "note"]);
    expect(flagNames(["--root", "sub/dir", "--json"], takesValue)).toEqual(["root", "json"]);
    expect(flagNames(["--note", "ship it", "Q1"], takesValue)).toEqual(["note"]);
    expect(flagNames(["--root=sub/dir"], takesValue)).toEqual(["root"]);
    // `parseArgs` refuses to swallow a value that starts with `--`, so a bare
    // `--root --json` is two flags there and two flags here.
    expect(flagNames(["--root", "--json"], takesValue)).toEqual(["root", "json"]);
    expect(flagNames(["--", "positional"], takesValue)).toEqual([]);
  });

  test("`--flag=value` is checked by its name", async () => {
    const run = await tldrx("status", "--nope=1");
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.stderr).toContain("unknown flag --nope");
  });

  test("`hook` forwards its argv, so the guard does not judge it", async () => {
    const run = await tldrx("hook", "not-a-hook", "--whatever");
    // Refused for the hook NAME, not for the flag.
    expect(run.stderr).toContain("no hook 'not-a-hook'");
    expect(run.stderr).not.toContain("unknown flag");
  });

  test("every command answers --help rather than refusing a flag", async () => {
    for (const command of COMMANDS) {
      const run = await tldrx(command.name, "--help");
      expect(run.code).toBe(EXIT_OK);
      expect(run.stderr).toBe("");
    }
  });
});

// --- --json is supported or it is an error -----------------------------------

describe("--json", () => {
  const unsupported = COMMANDS.filter(
    (command) => !supportsJson(command.name) && helpFor(command.name)?.passthrough !== true,
  );

  test("there is at least one of each kind, or this suite proves nothing", () => {
    expect(unsupported.length).toBeGreaterThan(0);
    expect(COMMANDS.some((command) => supportsJson(command.name))).toBe(true);
  });

  for (const command of unsupported) {
    test(`\`tldrx ${command.name} --json\` is refused rather than ignored`, async () => {
      const run = await tldrx(command.name, "--json");
      expect(run.code).toBe(EXIT_USAGE);
      expect(run.stderr).toContain(`--json is not supported by ${command.name}`);
      expect(run.stdout).toBe("");
    });

    test(`\`tldrx ${command.name} --help\` says so`, async () => {
      const run = await tldrx(command.name, "--help");
      expect(run.stdout).toContain(`Not supported by \`${command.name}\``);
    });
  }
});

// --- what <command> --help now carries ---------------------------------------

describe("<command> --help carries flags, values, examples and exit codes", () => {
  test("`run --help` names every flag, its meaning and the 13 scopes", async () => {
    const run = await tldrx("run", "--help");
    expect(run.code).toBe(EXIT_OK);
    for (const flag of ["--title", "--scope", "--budget", "--repos", "--from", "--seed", "--gates", "--until", "--yolo"]) {
      expect(run.stdout).toContain(flag);
    }
    for (const scope of scopeValues(FRAMEWORK_ROOT)) expect(run.stdout).toContain(scope);
    expect(run.stdout).toContain("Examples:");
    expect(run.stdout).toContain("Exit codes:");
    expect(run.stdout).toContain("4   awaiting a human");
  });

  test("`next --help` lists the effort and ui values the validators enforce", async () => {
    const run = await tldrx("next", "--help");
    expect(run.stdout).toContain(`one of: ${EFFORT_LEVELS.join(", ")}`);
    expect(run.stdout).toContain(`one of: ${UI_MODES.join(", ")}`);
  });

  test("`expert --help` gives --mode its two values", async () => {
    const run = await tldrx("expert", "--help");
    expect(run.stdout).toContain("one of: light, full");
  });

  test("every command's help lists an exit table and every code in it is explained", async () => {
    for (const command of COMMANDS) {
      const run = await tldrx(command.name, "--help");
      expect(run.stdout).toContain("Exit codes:");
      for (const code of helpFor(command.name)?.exits ?? []) {
        expect(run.stdout).toContain(EXIT_MEANINGS.get(code) ?? " ");
      }
    }
  });

  test("`tldrx --help` carries the exit-code legend", async () => {
    const run = await tldrx("--help");
    expect(run.stdout).toContain("Exit codes:");
    for (const [code, meaning] of EXIT_MEANINGS) {
      expect(run.stdout).toContain(`${String(code).padEnd(2)}  ${meaning}`);
    }
  });

  // The written table is the same table. It rots the moment they are two.
  // It lives in docs/guide/08-cli-reference.md, which is the page a reader lands
  // on from the README; the README itself carries no second copy to drift from.
  test("the CLI reference's exit table is the one `exitCodes.ts` defines", () => {
    const reference = readFileSync(join(FRAMEWORK_ROOT, "docs/guide/08-cli-reference.md"), "utf8");
    for (const [code, meaning] of EXIT_MEANINGS) {
      expect(reference).toContain(`| \`${String(code)}\` | ${meaning} |`);
    }
  });
});
