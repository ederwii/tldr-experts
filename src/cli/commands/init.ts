/** `tldrx init` — Detect the workspace, build the code map, interview the gaps
 *
 * Concept §4, spec §3. Deterministic and offline: filesystem + git only, no LLM
 * and no network. Writes `.tldrx/workspace.yml`, `.tldrx/map/**`, the init
 * handoff, the interview, seeded experts, conventions and `process.yml`, plus a
 * marked block in `.gitignore` and `CLAUDE.md`.
 *
 * It also SAYS SO WHILE IT WORKS. Until 2026-08-30 it printed nothing until it
 * was finished, which on a five-repo workspace is 36.0 s of a terminal that
 * looks hung (`--provider auto`; the same workspace is 1.3 s with
 * `--provider static`, so nearly all of it is `graphify update`, once per repo).
 * The live view is `core/ui/steps.ts` and it obeys the same `--ui` /
 * `TLDRX_UI` / `NO_COLOR` / `CI` rules as the agent view, on stderr, so
 * `tldrx init > report.txt` and a CI log are exactly what they were.
 *
 * Exit 0 on success, 1 on a usage or validation error (spec §3).
 */
import { resolve } from "node:path";
import type { Command } from "../Command.ts";
import { EXIT_FAILED, EXIT_OK } from "../exitCodes.ts";
import { SpawnCommandRunner } from "../../core/detect/CommandRunner.ts";
import { frameworkVersion } from "../../core/frameworkVersion.ts";
import { runInit } from "../../core/init/runInit.ts";
import { isMethodology, isProviderPreference, type InitOptions, type ProviderPreference } from "../../core/init/InitOptions.ts";
import { parseStackFlag } from "../../core/init/stackChoices.ts";
import { isUiModeFlag, UI_MODES } from "../../core/ui/mode.ts";
import { startSteps, silentSteps, type StepReporter } from "../../core/ui/steps.ts";
import { colorEnabled, palette, type Palette } from "../../core/ui/color.ts";
import type { Methodology } from "../../core/schemas/process.ts";
import type { Confidence } from "../../core/detect/types.ts";
import type { InitReport } from "../../core/init/runInit.ts";

/** Default terminal geometry when stderr will not say — a plain 80x24. */
const FALLBACK_COLS = 80;
const FALLBACK_ROWS = 24;

/**
 * `InitOptions` plus the two flags that decide who is watching. They are not on
 * `InitOptions` because `runInit` must not know: it is handed a reporter, and a
 * reporter that renders nothing is a legal reporter.
 */
export interface InitCliOptions extends InitOptions {
  /** `--ui <mode>`; undefined when the flag was not passed. */
  readonly ui: string | undefined;
  /** `--quiet`: no live progress. The report at the end is still printed. */
  readonly quiet: boolean;
}

export const initCommand: Command = {
  name: "init",
  summary: "Detect the workspace, build the code map, interview the gaps",
  usage: "tldrx init [--root <path>] [--out <path>] [--no-interview] [--process <scrum|kanban|shape-up|none>]\n"
    + "                  [--stack <ts,dotnet,python,go,rust,…>] [--mcp] [--provider <auto|graphify|static>]\n"
    + "                  [--ui scene|compact|plain|off] [--quiet]",
  subcommands: [],
  implemented: true,
  async run(argv: readonly string[]): Promise<number> {
    let options: InitCliOptions;
    try {
      options = parseInitArgs(argv);
    } catch (error) {
      process.stderr.write(`tldrx init: ${message(error)}\n${this.usage}\n`);
      return EXIT_FAILED;
    }

    const steps = startInitSteps(options);
    try {
      const report = await runInit(options, {
        runner: new SpawnCommandRunner(),
        cliVersion: await frameworkVersion(),
        now: new Date(),
        steps,
      });
      // Before a single byte of the report is written, so the live line never
      // sits half-drawn under it — and on the throw path too.
      steps.stop();
      process.stdout.write(renderReport(report, options, stdoutPalette()));
      return EXIT_OK;
    } catch (error) {
      steps.stop();
      process.stderr.write(`tldrx init: ${message(error)}\n`);
      return EXIT_FAILED;
    } finally {
      steps.stop();
    }
  },
};

/**
 * The live view for this invocation, or a handle that renders nothing.
 *
 * The environment is read HERE and passed down, so `resolveUiMode` stays a pure
 * function and every mode is testable without a terminal.
 */
export function startInitSteps(options: InitCliOptions): StepReporter {
  if (options.quiet) return silentSteps();
  return startSteps({
    root: options.root,
    flag: options.ui,
    env: process.env,
    isTty: process.stderr.isTTY === true,
    cols: process.stderr.columns ?? FALLBACK_COLS,
    rows: process.stderr.rows ?? FALLBACK_ROWS,
  });
}

/**
 * The report's palette comes from STDOUT, not from the view's stderr.
 *
 * `tldrx init > report.txt` on a terminal has a piped stdout and a TTY stderr:
 * the live lines are still worth colouring and the file must still be plain
 * text.
 */
function stdoutPalette(): Palette {
  return palette(colorEnabled({ isTty: process.stdout.isTTY === true, env: process.env }));
}

export function parseInitArgs(argv: readonly string[]): InitCliOptions {
  let root = process.cwd();
  let out: string | null = null;
  let interview = true;
  let methodology: Methodology | null = null;
  let mcp = false;
  let stack: string[] = [];
  let provider: ProviderPreference = "auto";
  let ui: string | undefined;
  let quiet = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    switch (arg) {
      case "--root": root = requireValue(argv, ++i, "--root"); break;
      case "--out": out = requireValue(argv, ++i, "--out"); break;
      case "--no-interview": interview = false; break;
      case "--mcp": mcp = true; break;
      case "--quiet": quiet = true; break;
      case "--ui": {
        const value = requireValue(argv, ++i, "--ui");
        // Refused here rather than inside the view: a bad `--ui` is a usage
        // error like any other and belongs before the command does any work.
        if (!isUiModeFlag(value)) throw new Error(`--ui expects ${UI_MODES.join("|")}, got '${value}'`);
        ui = value;
        break;
      }
      case "--process": {
        const value = requireValue(argv, ++i, "--process");
        if (!isMethodology(value)) throw new Error(`--process expects scrum|kanban|shape-up|none, got '${value}'`);
        methodology = value;
        break;
      }
      case "--stack": {
        const value = requireValue(argv, ++i, "--stack");
        const parsed = parseStackFlag(value);
        if (parsed.length === 0) throw new Error(`--stack expects a comma-separated list, got '${value}'`);
        stack = [...stack, ...parsed.filter((entry) => !stack.includes(entry))];
        break;
      }
      case "--provider": {
        const value = requireValue(argv, ++i, "--provider");
        if (!isProviderPreference(value)) throw new Error(`--provider expects auto|graphify|static, got '${value}'`);
        provider = value;
        break;
      }
      default: throw new Error(`unknown option '${arg}'`);
    }
  }
  return { root: resolve(root), out: resolve(out ?? root), interview, methodology, mcp, stack, provider, ui, quiet };
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
  return value;
}

/** high is a fact, low is a warning, and the colour says which without a word. */
export function confidenceInk(confidence: Confidence, ink: Palette): string {
  if (confidence === "high") return ink.green(confidence);
  if (confidence === "medium") return ink.yellow(confidence);
  return ink.red(confidence);
}

export function renderReport(report: InitReport, options: InitOptions, ink: Palette): string {
  const lines: string[] = [
    `${ink.bold("tldrx init")} — ${report.greenfield ? "greenfield" : report.workspace.mode}, `
      + `${ink.bold(String(report.workspace.repos.length))} repo(s) under ${ink.gray(options.root)}`,
    "",
  ];
  if (report.greenfield) {
    lines.push(
      "  greenfield: no code file exists yet, so workspace.yml records `mode: greenfield`",
      `  stack: ${options.stack.length > 0 ? options.stack.join(", ") + " (--stack)" : "not declared — see the interview"}`,
      "",
    );
  }
  for (const repo of report.workspace.repos) {
    const stack = repo.stack.length > 0 ? repo.stack.join(", ") : "stack unknown";
    lines.push(
      `  ${ink.cyan(repo.name.padEnd(20))} ${stack} · confidence ${confidenceInk(repo.confidence, ink)} `
      + `· branch ${ink.gray(repo.defaultBranch)}`,
    );
  }
  lines.push(
    "",
    `  ${ink.dim("map")}        ${ink.bold(String(report.map.files.length))} documents via ${report.map.providers.join(", ") || "no provider"}`,
    `  ${ink.dim("experts")}    ${ink.bold(String(report.experts.length))} seeded at level 0`,
    `  ${ink.dim("questions")}  ${options.interview ? `${ink.bold(String(report.questions.length))} written to .tldrx/init-questions.md` : "skipped (--no-interview)"}`,
    // The roll-up the per-file list below cannot give at a glance: how much of
    // this run was regenerated, how much is new, and how much was YOURS and left
    // alone. `kept` is the number a re-run is judged by.
    `  ${ink.dim("files")}      ${ink.bold(String(report.written.length))} written · `
      + `${ink.green(String(report.created.length))} created · ${ink.yellow(String(report.kept.length))} kept`,
    "",
  );
  for (const path of report.created) lines.push(`  ${ink.green("created")}  ${path}`);
  for (const path of report.kept) lines.push(`  ${ink.yellow("kept")}     ${path}`);
  // The COMMAND, not the file. Filling `[Answer]:` in `.tldrx/init-questions.md`
  // by hand records nothing: the `answer-capture` hook only fires on a path under
  // `tldrx-work/` (`answer-capture.ts:27`, `locateWork` in `hooks/lib/workspace.ts:29`),
  // and `--init` additionally writes `.tldrx/process.yml` from the two process
  // answers (`interview.ts:101-112`). An editor gets neither.
  lines.push(
    "",
    options.interview
      ? `${ink.bold("Next:")} read ${ink.cyan(".tldrx/init-handoff.md")}, then run `
        + `${ink.cyan("`tldrx interview --init`")} to answer the setup questions.`
      : `${ink.bold("Next:")} read ${ink.cyan(".tldrx/init-handoff.md")}. No questions were written (--no-interview).`,
    "",
  );
  return lines.join("\n");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
