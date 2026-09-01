/**
 * The throwaway world `tldrx learn` teaches in.
 *
 * Everything the tutorial does, it does for real — `tldrx init` really detects,
 * `tldrx next` really spawns, `tldrx answer` really writes a fact. The only thing
 * that is not real is WHERE, and WHO the sub-agent is. This module builds both:
 *
 *   <sandbox>/                 learn's own state, outside the workspace on purpose
 *     progress.json            which chapters are done (files-as-state, like everything)
 *     agent-script.json        what the stand-in agent will say (agentScript.ts)
 *     bin/claude               the stand-in itself, a shell shim
 *     inventory/               THE TOY REPO — the workspace every chapter acts on
 *
 * `progress.json` and the script live BESIDE the workspace rather than in it
 * because chapter 1 runs `tldrx init` over that directory: state of ours sitting
 * inside it would land in the code map, in `.gitignore`, and in the very
 * `workspace.yml` table the chapter asks the learner to read.
 *
 * **The real `claude` is unreachable by construction, not by convention.** The
 * sandbox writes a `claude` shim and then closes both doors onto it:
 * `TLDRX_CLAUDE_BIN` names the shim (which is what `spawnAgent` executes), and
 * `<sandbox>/bin` is PREPENDED to the child's PATH (which is what anything
 * resolving the name `claude` — a `Bash(claude …)` grant, a hook, a script — would
 * find first). One of those would be a policy; both of them is a property.
 * `test/learn-sandbox.test.ts` proves it by planting a `claude` on PATH that
 * writes a marker file, playing the chapters, and asserting the marker never
 * appears.
 */
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { runtime } from "../runtime/index.ts";
import { PROJECT_FRAMEWORK_DIR } from "../paths.ts";
import { LEARN_AGENT_ARGV0, SCRIPT_ENV } from "./learnAgent.ts";
import { EMPTY_SCRIPT, stringifyScript, type AgentScript } from "./agentScript.ts";

/** Where the sandbox goes when nobody says otherwise. Stable, so `learn` can resume. */
export function defaultSandboxRoot(home: string = homedir()): string {
  return join(home, ".tldrx-learn");
}

/** The toy repo's name — it is what `workspace.yml`'s repo table will say. */
export const TOY_REPO_NAME = "inventory";

export interface Sandbox {
  /** `<sandbox>` — learn's own directory. Nothing is ever written outside it. */
  readonly root: string;
  /** `<sandbox>/inventory` — the workspace every chapter's command runs in. */
  readonly workspace: string;
  /** `<sandbox>/bin` — holds the stand-in `claude`. Prepended to every child's PATH. */
  readonly binDir: string;
  /** `<sandbox>/bin/claude` — what `TLDRX_CLAUDE_BIN` names. */
  readonly claudeBin: string;
  /** `<sandbox>/agent-script.json`. */
  readonly scriptPath: string;
  /** `<sandbox>/progress.json`. */
  readonly progressPath: string;
}

export interface SandboxOptions {
  /** `<sandbox>`. Defaults to `~/.tldrx-learn`. */
  readonly root?: string;
  /**
   * How to re-enter this CLI: `[interpreter, entry script]`.
   *
   * Defaults to the pair that is running right now, which is correct from source
   * (`bun bin/tldrx.ts`) and from the Node build (`node dist/tldrx.js`) without
   * either one being guessed at. Injected by tests, which run in-process and
   * whose `process.argv[1]` is the test runner.
   */
  readonly selfCommand?: readonly [string, string];
  /** Delete and rebuild an existing sandbox (`--reset`). */
  readonly reset?: boolean;
}

export class SandboxError extends Error {}

/**
 * Build (or re-open) the sandbox, and return the handles a chapter needs.
 *
 * Idempotent: a second call over an existing sandbox re-writes the shim — whose
 * baked-in paths a `bun`/`node` upgrade can invalidate — and leaves the toy repo
 * and the progress file alone, which is what makes `learn` resumable.
 */
export async function makeSandbox(options: SandboxOptions = {}): Promise<Sandbox> {
  const root = resolve(options.root ?? defaultSandboxRoot());
  assertOutsideAnyWorkspace(root);

  if (options.reset === true) rmSync(root, { recursive: true, force: true });

  const sandbox: Sandbox = {
    root,
    workspace: join(root, TOY_REPO_NAME),
    binDir: join(root, "bin"),
    claudeBin: join(root, "bin", "claude"),
    scriptPath: join(root, "agent-script.json"),
    progressPath: join(root, "progress.json"),
  };

  mkdirSync(sandbox.binDir, { recursive: true });
  writeClaudeShim(sandbox, options.selfCommand ?? selfCommand());
  if (!existsSync(sandbox.scriptPath)) writeScript(sandbox, EMPTY_SCRIPT);
  if (!existsSync(join(sandbox.workspace, "package.json"))) await makeToyRepo(sandbox.workspace);
  // Re-applied on every open, like the shim: an identity is cheap to write and a
  // sandbox made by an older build does not have one.
  await setLocalGitIdentity(sandbox.workspace);
  return sandbox;
}

/**
 * Give the toy repo its OWN committer, in its own `.git/config`.
 *
 * The tutorial does not only commit from `prepare()` — chapter 4's Build spawns a
 * developer in a worktree and then commits what it left, and that commit runs
 * with whatever identity the machine has. A box with no `user.email` in its
 * global config is a normal box (a fresh laptop, a container, a CI runner), and
 * there `git commit` fails with `Author identity unknown` and chapter 4 dies
 * three commands in. Measured 2026-09-01 on `ubuntu-latest`.
 *
 * Repo-local rather than per-command, because the commits that need it are made
 * by the framework's own executor, which has no reason to know it is being run by
 * a tutorial. A linked worktree reads the same config, so the story worktrees get
 * it too. `commit.gpgsign` goes off for the same reason: a learner who signs every
 * commit has no key set up for a throwaway repo under `~/.tldrx-learn`.
 */
export async function setLocalGitIdentity(dir: string): Promise<void> {
  if (!existsSync(join(dir, ".git"))) return;
  for (const [key, value] of [
    ["user.email", "learn@tldrx.invalid"],
    ["user.name", "tldrx learn"],
    ["commit.gpgsign", "false"],
  ] as const) {
    await runtime.spawn("git", ["config", key, value], { cwd: dir });
  }
}

/**
 * Refuse to put the sandbox inside a real workspace.
 *
 * The chapters run `tldrx init`, `tldrx run new` and a Build that cuts git
 * branches. Doing that anywhere near somebody's actual project is the one failure
 * this command must not have, so it is checked before a byte is written and the
 * refusal names the way out.
 *
 * Ancestors only. The sandbox's OWN `.tldrx/` is the thing chapter 1 creates.
 */
export function assertOutsideAnyWorkspace(root: string): void {
  let current = dirname(resolve(root));
  for (let i = 0; i < 64; i++) {
    if (existsSync(join(current, PROJECT_FRAMEWORK_DIR))) {
      throw new SandboxError(
        `${root} is inside a tldrx workspace (${current} has ${PROJECT_FRAMEWORK_DIR}/). `
        + `The tutorial writes freely and must not do that near real work — `
        + `pass \`--sandbox <path>\` somewhere outside it.`,
      );
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

/** The interpreter and entry script running right now. */
export function selfCommand(): readonly [string, string] {
  return [process.execPath, process.argv[1] ?? ""];
}

/**
 * The stand-in `claude`, as a POSIX shell script.
 *
 * `exec`s the interpreter that is running this process on the entry script that
 * is running this process, with `__learn-agent` in front of `claude`'s own argv.
 * Nothing is looked up on a PATH and no runtime is assumed to exist: the pair is
 * measured (`process.execPath`, `process.argv[1]`) and baked in.
 */
export function claudeShimScript(
  selfCmd: readonly [string, string],
  scriptPath: string,
): string {
  const [interpreter, entry] = selfCmd;
  return [
    "#!/bin/sh",
    "# The tutorial's stand-in for `claude`, written by `tldrx learn`.",
    "# It is not the real CLI, it never reaches a network, and it never costs anything.",
    `${SCRIPT_ENV}=${shellQuote(scriptPath)}`,
    `export ${SCRIPT_ENV}`,
    `exec ${shellQuote(interpreter)} ${shellQuote(entry)} ${LEARN_AGENT_ARGV0} "$@"`,
    "",
  ].join("\n");
}

function writeClaudeShim(sandbox: Sandbox, selfCmd: readonly [string, string]): void {
  writeFileSync(sandbox.claudeBin, claudeShimScript(selfCmd, sandbox.scriptPath), "utf8");
  chmodSync(sandbox.claudeBin, 0o755);
}

/** Single-quote for `sh`, the only quoting that is safe for an arbitrary path. */
export function shellQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/** Replace the sandbox's agent script (and forget how often its turns have played). */
export function writeScript(sandbox: Sandbox, script: AgentScript): void {
  writeFileSync(sandbox.scriptPath, stringifyScript(script), "utf8");
  rmSync(`${sandbox.scriptPath}.tally.json`, { force: true });
}

/**
 * The child environment for every command a chapter runs.
 *
 * Three things, and each one is load-bearing:
 *   `TLDRX_CLAUDE_BIN`  what `spawnAgent` executes (`facilitator/spawnAgent.ts`)
 *   `PATH`              what anything ELSE resolving the name `claude` finds
 *   `<SCRIPT_ENV>`      what the stand-in reads, also baked into the shim itself
 */
export function sandboxEnv(
  sandbox: Sandbox,
  base: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) if (value !== undefined) env[key] = value;
  env.TLDRX_CLAUDE_BIN = sandbox.claudeBin;
  env.PATH = `${sandbox.binDir}:${base.PATH ?? ""}`;
  env[SCRIPT_ENV] = sandbox.scriptPath;
  return env;
}

/** The three source files, the README and the package.json the chapters detect and change. */
export const TOY_FILES: Readonly<Record<string, string>> = {
  "package.json": `${JSON.stringify({
    name: "toy-inventory",
    version: "0.1.0",
    private: true,
    type: "module",
    scripts: { test: "exit 0", build: "exit 0", lint: "exit 0", typecheck: "exit 0" },
  }, null, 2)}\n`,
  "README.md": [
    "# toy-inventory",
    "",
    "A four-file stock ledger. It exists so `tldrx learn` has something real to",
    "detect, plan against and change. Nothing here is shipped anywhere.",
    "",
  ].join("\n"),
  "src/index.ts": [
    "import { addItem, removeItem } from \"./stock.ts\";",
    "import { priceOf } from \"./pricing.ts\";",
    "",
    "export { addItem, removeItem, priceOf };",
    "",
  ].join("\n"),
  "src/stock.ts": [
    "export interface Item { readonly sku: string; readonly count: number; }",
    "",
    "export function addItem(items: readonly Item[], sku: string, count: number): Item[] {",
    "  return [...items, { sku, count }];",
    "}",
    "",
    "export function removeItem(items: readonly Item[], sku: string): Item[] {",
    "  return items.filter((item) => item.sku !== sku);",
    "}",
    "",
  ].join("\n"),
  "src/pricing.ts": [
    "/** Cents, always. A price that is a float is a bug waiting for a rounding. */",
    "export function priceOf(sku: string): number {",
    "  return sku.startsWith(\"BULK-\") ? 500 : 1200;",
    "}",
    "",
  ].join("\n"),
};

/**
 * A git repo with four files and a `test` script that exits 0.
 *
 * Committed, on `main`, with an identity written into the repo's own config AND
 * passed per-command: a box with no `user.email` in its global config is a normal
 * box, and a tutorial that fails there fails for the reader who most needed it.
 * The repo-local copy is what carries the framework's OWN commits later — see
 * `setLocalGitIdentity`.
 */
export async function makeToyRepo(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(TOY_FILES)) {
    const path = join(dir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
  }
  await git(dir, ["init", "-q"]);
  // Not `init -b main`: that flag is git >= 2.28, and this one works everywhere
  // and needs no commit to exist yet.
  await git(dir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  await setLocalGitIdentity(dir);
  await git(dir, ["add", "-A"]);
  await git(dir, [
    "-c", "user.email=learn@tldrx.invalid",
    "-c", "user.name=tldrx learn",
    "-c", "commit.gpgsign=false",
    "commit", "-q", "-m", "the toy repo, before the tutorial touches it",
  ]);
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  const result = await runtime.spawn("git", args, { cwd });
  if (result.exitCode !== 0) {
    throw new SandboxError(`git ${args.join(" ")} failed (${String(result.exitCode)}): ${result.stderr.trim()}`);
  }
}
