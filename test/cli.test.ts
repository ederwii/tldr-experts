import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMANDS, lookup } from "../src/cli/index.ts";
import type { Command } from "../src/cli/Command.ts";
import { flagNames } from "../src/cli/argv.ts";
import { EXIT_FAILED, EXIT_NOT_FOUND, EXIT_NOT_IMPLEMENTED, EXIT_OK, EXIT_USAGE } from "../src/cli/exitCodes.ts";
import {
  declaredFlags, EXIT_MEANINGS, helpFor, HELP_ENTRIES, scopeValues, supportsJson,
} from "../src/cli/helpText.ts";
import { EFFORT_LEVELS } from "../src/core/schemas/stage.ts";
import { UI_MODES } from "../src/core/ui/index.ts";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";
import { noSpawnEnv } from "./fixtures/noSpawnPath.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

// Every test in this file spawns a REAL process — git, `bun`, the CLI. Process cost is a
// property of the machine, not of the code, so bun's fixed 5000 ms default measures the box:
// on an untouched tree, tests here timed out while the same files passed alone (#43). The
// budget scales with measured load; the assertions are untouched, and a hang is still caught.
setDefaultTimeout(spawnTestTimeout());

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
        expect(run.stdout).toContain(EXIT_MEANINGS.get(code) ?? "\0");
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

  /**
   * #54: the page described seven of `run`'s eight subcommands, and the missing one
   * was `gates set` — the ONLY sanctioned way to move a `gates_policy` that
   * `run new` froze, which is a thing an operator hits mid-run and searches the docs
   * for. The alternative they found was "abandon the run".
   *
   * #55 widened it to `plan`. At `7ac298c` the page had no `## tldrx plan` heading
   * at all, so `sync-dod` — the one repair for a story whose dod block a
   * `workspace.yml` edit orphaned — was undocumented in the same way and for the
   * same reason. The scoped list is what makes the gap a red test rather than a
   * note: it is widened one command at a time, as each one's section is written.
   *
   * Still NOT generalised over every command, and the reasons are measured at
   * `28d4a56`: `hook`'s seven scripts are documented as the one `<script>` slot
   * that USAGE_SPELLINGS already records as a deliberate spelling, and `note` and
   * `ship` have no section on this page either (the same gap as #55, filed
   * separately). A generalised assertion would go red for those three and say
   * nothing about the two it is here to hold.
   */
  const DOCUMENTED_SUBCOMMANDS = ["run", "plan"] as const;

  test("the CLI reference documents every subcommand of `run` and `plan` (#54, #55)", () => {
    const reference = readFileSync(join(FRAMEWORK_ROOT, "docs/guide/08-cli-reference.md"), "utf8");
    for (const name of DOCUMENTED_SUBCOMMANDS) {
      const command = COMMANDS.find((entry) => entry.name === name);
      expect(command).toBeDefined();
      if (command === undefined) continue;
      // A heading, not a passing mention: the page is navigated by its `##` list.
      expect(reference).toContain(`## \`tldrx ${name}\``);
      expect(command.subcommands.filter((sub) => !reference.includes(`tldrx ${name} ${sub}`))).toEqual([]);
    }
    // The audit trail is the half a reader cannot infer from the usage line: a
    // mandatory --note, and one event carrying who moved the policy and why.
    expect(reference).toContain("gate.policy_changed");
    // `plan sync-dod`'s equivalent: the four per-line outcomes are the whole
    // behaviour, and the flagged one — the line no workspace.yml ever declared —
    // is the case an operator has to act on themselves.
    expect(reference).toContain(".md.bak");
  });
});

/**
 * The other direction, and the one #25 and #51 were both about.
 *
 * `usage` is what a BAD invocation prints — `gate.ts:44`, `run.ts:85`,
 * `questions.ts:38`, `tickets.ts:60`, `seed.ts:55`, `story.ts:35` and `plan.ts:41`
 * all write `<cmd>.usage` to stderr — so it is the string an operator reads at the
 * exact moment they got the invocation wrong. A usage line narrower than the same
 * command's `--help` hides a flag the code does accept, from the one reader who
 * most needs it, and nothing went red when it drifted.
 *
 * Subcommand-aware ON PURPOSE, and that is not gold-plating. A plain
 * `usage.includes("--run")` calls `run` CLEAN: `run gates set` names `--run` on its
 * own line, which is enough to satisfy a substring test while `run attend`,
 * `run status`, `run estimate`, `run auto`, `run unlock` and `run cancel` still show
 * only `[<run>]`. Measured at 7a29fab: the naive check saw one of run's seven gaps.
 * So a flag that declares a `sub:` is looked for in THAT subcommand's block.
 */

/**
 * The usage lines for `<cmd> <sub>`: its own `tldrx …` line plus the indented
 * continuations under it.
 *
 * `sub:` in the registry means two different things, and only one of them is a
 * subcommand. `run --json {sub: "status"}` is `tldrx run status`, a word in argv.
 * `dashboard --out {sub: "static"}` is a MODE selected by `--static`, and there is
 * no `tldrx dashboard static` line for it to live under — scoping that one would
 * report a gap that is not there (it did, on the first draft of this guard). So
 * `command.subcommands` decides: a real subcommand is scoped, a mode is checked
 * against the whole usage.
 */
function usageBlock(command: Command, sub: string | undefined): string {
  if (sub === undefined || !command.subcommands.includes(sub)) return command.usage;
  const opens = new RegExp(`^\\s*tldrx\\s+${command.name}\\s+${sub}\\b`);
  const block: string[] = [];
  let inside = false;
  for (const line of command.usage.split("\n")) {
    if (/^\s*tldrx\s/.test(line)) inside = opens.test(line);
    if (inside) block.push(line);
  }
  return block.join("\n");
}

/**
 * The declared things a usage line is allowed NOT to spell the registry's way,
 * each with the reason. Two kinds live here and only two:
 *
 *  - a usage line that says the SAME thing more specifically (the enum written out,
 *    the quotes a shell needs, the seven script names) — the registry's `<script>`
 *    is the general name, the usage is the better one, and neither is wrong;
 *  - `tickets --dry-run`, which is absent from that usage DELIBERATELY. `tickets
 *    sync` previews by default and `--apply` is the write; advertising `--dry-run`
 *    would imply the opposite. `test/money-safety.test.ts` asserts its absence, so
 *    this entry records a decision rather than papering over a gap.
 *
 * Anything else belongs in the usage string, not in here.
 */
const USAGE_SPELLINGS: ReadonlyMap<string, string> = new Map([
  ["run <stage>:<policy>", "usage writes the enum out: `<stage>:<human|auto|agent>`"],
  ["seed <Qid> <text>", 'usage quotes the second word: `<Qid> "<text>"`'],
  ["hook <script>", "usage enumerates the runnable scripts instead of naming the slot"],
  ["tickets --dry-run", "deliberately absent — preview is the default and --apply is the write (money-safety.test.ts)"],
]);

describe("every usage line is as wide as its own --help (#25, #51)", () => {
  test("no declared flag is missing from the usage of the subcommand that takes it", () => {
    const missing: string[] = [];
    for (const command of COMMANDS) {
      for (const flag of helpFor(command.name)?.flags ?? []) {
        const key = `${command.name} --${flag.name}`;
        if (USAGE_SPELLINGS.has(key)) continue;
        if (usageBlock(command, flag.sub).includes(`--${flag.name}`)) continue;
        missing.push(flag.sub === undefined ? key : `${key} (${command.name} ${flag.sub})`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("no declared positional is missing from the usage", () => {
    const missing: string[] = [];
    for (const command of COMMANDS) {
      for (const arg of helpFor(command.name)?.args ?? []) {
        const key = `${command.name} ${arg.name}`;
        if (USAGE_SPELLINGS.has(key)) continue;
        if (command.usage.includes(arg.name)) continue;
        missing.push(key);
      }
    }
    expect(missing).toEqual([]);
  });

  /**
   * An allowlist nobody re-reads is how the first copy went stale. Every entry must
   * still name a real declared flag or arg, so a rename or a deletion turns the
   * exemption into a red build rather than into silence.
   */
  test("every allowlisted spelling still points at something the registry declares", () => {
    const declared = new Set<string>();
    for (const command of COMMANDS) {
      const help = helpFor(command.name);
      for (const flag of help?.flags ?? []) declared.add(`${command.name} --${flag.name}`);
      for (const arg of help?.args ?? []) declared.add(`${command.name} ${arg.name}`);
    }
    expect([...USAGE_SPELLINGS.keys()].filter((key) => !declared.has(key))).toEqual([]);
  });

  /**
   * The guard can only see a gap it is capable of seeing. `run --run` is the case
   * that broke the naive version, so it is asserted directly: the whole usage names
   * `--run` (on the `gates set` line), and `run status`'s own block does too.
   */
  test("the check is subcommand-aware — the case a substring test gets wrong", () => {
    const run = COMMANDS.find((command) => command.name === "run");
    expect(run).toBeDefined();
    if (run === undefined) return;
    expect(run.usage).toContain("--run");
    expect(usageBlock(run, "status")).toContain("tldrx run status");
    expect(usageBlock(run, "status")).toContain("--run");
    expect(usageBlock(run, "status")).not.toContain("tldrx run cancel");
  });

  /** The other half of that: a `sub:` that is a MODE, not a word in argv, is not scoped. */
  test("a flag-selected mode is checked against the whole usage, not a phantom block", () => {
    const dashboard = COMMANDS.find((command) => command.name === "dashboard");
    expect(dashboard).toBeDefined();
    if (dashboard === undefined) return;
    expect(dashboard.subcommands).not.toContain("static");
    expect(usageBlock(dashboard, "static")).toBe(dashboard.usage);
  });
});

/**
 * The third axis, and the one neither guard above can see: the REGISTRY narrower
 * than the CODE.
 *
 * `tickets sync`, `tickets status` and `budget show` all resolve a run from
 * `stringFlag(args, "run") ?? args.positionals[0]` (`tickets.ts:246`,
 * `budget.ts:48`), so a bare run id has always worked — and neither the usage line
 * nor `helpFor(…).args` said so (#53). The two guards above compare the registry to
 * the usage; where BOTH are silent they are both green, and they were.
 *
 * Nothing derives a positional from source, so the list is written by hand. The
 * behavioural half is what keeps each entry from being a restatement of the
 * registry: it goes red if the capability is REMOVED as well as if the declaration
 * is, which is the direction a tidy-up of the arg parsing would break it in.
 */
const RUN_POSITIONAL: readonly (readonly [string, readonly string[]])[] = [
  ["tickets", ["sync", "status"]],
  ["budget", ["show"]],
];

describe("a run id the code takes as a positional is declared (#53)", () => {
  // A `.tldrx/` marker is needed or every command exits 1 at "run `tldrx init` first"
  // before any argv is read, and a configured `ticket_tool` is needed or `tickets sync`
  // returns 0 at "kind is none — a no-op" before it resolves anything. `tldrx-work/` is
  // left absent on purpose, so the probe id misses because no run has it rather than
  // because this box happens to have one open. Nothing reaches GitHub: the run is
  // resolved, and refused, before a provider is ever built.
  const foreign = mkdtempSync(join(tmpdir(), "tldrx-positional-"));
  mkdirSync(join(foreign, ".tldrx"));
  writeFileSync(
    join(foreign, ".tldrx", "process.yml"),
    "version: 1\nticket_tool: {kind: github, project: acme/lab, sync: one-way}\n",
  );

  afterAll(() => rmSync(foreign, { recursive: true, force: true }));

  for (const [name, subs] of RUN_POSITIONAL) {
    test(`\`tldrx ${name}\` declares [<run>] in both its --help and its usage`, () => {
      const command = COMMANDS.find((candidate) => candidate.name === name);
      expect(command).toBeDefined();
      if (command === undefined) return;
      expect((helpFor(name)?.args ?? []).map((arg) => arg.name)).toContain("[<run>]");
      for (const sub of subs) expect(usageBlock(command, sub)).toContain("[<run>]");
    });

    for (const sub of subs) {
      test(`\`tldrx ${name} ${sub} <run>\` reaches the run resolver`, async () => {
        const run = await tldrxIn(foreign, name, sub, "zzz-positional-probe");
        expect(run.code).toBe(EXIT_NOT_FOUND);
        expect(run.stderr).toContain("no run 'zzz-positional-probe'");
      });
    }
  }
});
