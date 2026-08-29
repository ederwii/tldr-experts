/**
 * `tldrx hook <name>` and `tldrx statusline` — one stable name per hook script.
 *
 * Before this, wiring a hook meant an absolute path: `bun
 * /Users/somebody/tldr-experts/src/hooks/claim-sources.ts`. That is fine inside the
 * plugin, where Claude Code computes `${CLAUDE_PLUGIN_ROOT}` for you, and useless
 * in a `.claude/settings.json` that gets committed and cloned onto another machine.
 * A subcommand fixes it: `tldrx hook claim-sources` resolves the script the same
 * way `tldrx` itself was resolved, wherever that is.
 *
 * Everything is passed through unchanged — stdin in, stdout and stderr out, the
 * child's exit code as ours. Hooks are a request/response over stdin (read it all,
 * print one JSON decision, exit), so reading stdin fully and forwarding it loses
 * nothing; there is no interactive hook to stream for.
 *
 * Which file runs: `dist/hooks/<name>.js` when this CLI is itself running out of
 * `dist/`, `src/hooks/<name>.ts` when it is running from source. Source wins in a
 * dev checkout even if a stale `dist/` is lying around, because the thing you just
 * edited is the thing you meant to run.
 */
import { existsSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "../Command.ts";
import { EXIT_FAILED, EXIT_OK } from "../exitCodes.ts";
import { parseArgs, UsageError } from "../argv.ts";
import { fail } from "../report.ts";
import { FRAMEWORK_ROOT } from "../../core/paths.ts";
import { RUNNABLE_SCRIPTS, STATUSLINE_SCRIPT } from "../../core/install/managedEntries.ts";
import { runtime } from "../../core/runtime/index.ts";

export const hookCommand: Command = {
  name: "hook",
  summary: "Run one tldrx hook script (stdin in, decision out)",
  usage: `tldrx hook <${RUNNABLE_SCRIPTS.join("|")}>`,
  subcommands: [...RUNNABLE_SCRIPTS],
  implemented: true,
  async run(argv: readonly string[]): Promise<number> {
    try {
      const args = parseArgs(argv);
      const [name, ...rest] = args.positionals;
      if (name === undefined || name === "") {
        throw new UsageError(`hook needs a script name — one of ${RUNNABLE_SCRIPTS.join(", ")}`);
      }
      if (!RUNNABLE_SCRIPTS.includes(name)) {
        process.stderr.write(
          `tldrx hook: no hook '${name}' — the scripts are ${RUNNABLE_SCRIPTS.join(", ")}\n`,
        );
        return EXIT_FAILED;
      }
      return await runHookScript(name, rest);
    } catch (error) {
      return fail("hook", error);
    }
  },
};

export const statuslineCommand: Command = {
  name: "statusline",
  summary: "Render the tldrx status line (for the statusLine settings key)",
  usage: "tldrx statusline",
  subcommands: [],
  implemented: true,
  async run(argv: readonly string[]): Promise<number> {
    try {
      return await runHookScript(STATUSLINE_SCRIPT, argv);
    } catch (error) {
      return fail("statusline", error);
    }
  },
};

/**
 * Spawn one hook script and forward everything. Never throws for a hook that
 * merely failed — the exit code is the report.
 */
export async function runHookScript(name: string, argv: readonly string[]): Promise<number> {
  const script = resolveHookScript(name);
  if (script === null) {
    process.stderr.write(
      `tldrx hook ${name}: no script found at dist/hooks/${name}.js or src/hooks/${name}.ts`
      + ` under ${FRAMEWORK_ROOT} — run \`bun run build\` in a source checkout.\n`,
    );
    return EXIT_FAILED;
  }
  // A hook is always invoked with a payload on a pipe. Reading a TTY would block
  // forever under Bun, so an interactive invocation gets an empty payload instead —
  // which every hook handles by allowing.
  const stdin = process.stdin.isTTY === true ? "" : await runtime.readStdin();
  const result = await runtime.spawn(process.execPath, [script, ...argv], {
    stdin,
    cwd: process.cwd(),
    env: process.env,
  });
  if (result.stdout !== "") process.stdout.write(result.stdout);
  if (result.stderr !== "") process.stderr.write(result.stderr);
  return result.exitCode === 0 ? EXIT_OK : result.exitCode;
}

/** The built hook when we are running built code, the source when we are not. */
export function resolveHookScript(name: string): string | null {
  const built = join(FRAMEWORK_ROOT, "dist", "hooks", `${name}.js`);
  const source = join(FRAMEWORK_ROOT, "src", "hooks", `${name}.ts`);
  const order = runningFromDist() ? [built, source] : [source, built];
  return order.find((path) => existsSync(path)) ?? null;
}

function runningFromDist(): boolean {
  try {
    return fileURLToPath(import.meta.url).includes(`${sep}dist${sep}`);
  } catch {
    return false;
  }
}
