/** `tldrx init` — Detect the workspace, build the code map, interview the gaps
 *
 * Concept §4, spec §3. Deterministic and offline: filesystem + git only, no LLM
 * and no network. Writes `.tldrx/workspace.yml`, `.tldrx/map/**`, the init
 * handoff, the interview, seeded experts, conventions and `process.yml`, plus a
 * marked block in `.gitignore` and `CLAUDE.md`.
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
import type { Methodology } from "../../core/schemas/process.ts";
import type { InitReport } from "../../core/init/runInit.ts";

export const initCommand: Command = {
  name: "init",
  summary: "Detect the workspace, build the code map, interview the gaps",
  usage: "tldrx init [--root <path>] [--out <path>] [--no-interview] [--process <scrum|kanban|shape-up|none>] [--mcp] [--provider <auto|graphify|static>]",
  subcommands: [],
  implemented: true,
  async run(argv: readonly string[]): Promise<number> {
    let options: InitOptions;
    try {
      options = parseInitArgs(argv);
    } catch (error) {
      process.stderr.write(`tldrx init: ${message(error)}\n${this.usage}\n`);
      return EXIT_FAILED;
    }

    try {
      const report = await runInit(options, {
        runner: new SpawnCommandRunner(),
        cliVersion: await frameworkVersion(),
        now: new Date(),
      });
      process.stdout.write(renderReport(report, options));
      return EXIT_OK;
    } catch (error) {
      process.stderr.write(`tldrx init: ${message(error)}\n`);
      return EXIT_FAILED;
    }
  },
};

export function parseInitArgs(argv: readonly string[]): InitOptions {
  let root = process.cwd();
  let out: string | null = null;
  let interview = true;
  let methodology: Methodology | null = null;
  let mcp = false;
  let provider: ProviderPreference = "auto";

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    switch (arg) {
      case "--root": root = requireValue(argv, ++i, "--root"); break;
      case "--out": out = requireValue(argv, ++i, "--out"); break;
      case "--no-interview": interview = false; break;
      case "--mcp": mcp = true; break;
      case "--process": {
        const value = requireValue(argv, ++i, "--process");
        if (!isMethodology(value)) throw new Error(`--process expects scrum|kanban|shape-up|none, got '${value}'`);
        methodology = value;
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
  return { root: resolve(root), out: resolve(out ?? root), interview, methodology, mcp, provider };
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
  return value;
}

function renderReport(report: InitReport, options: InitOptions): string {
  const lines: string[] = [
    `tldrx init — ${report.workspace.mode}, ${report.workspace.repos.length} repo(s) under ${options.root}`,
    "",
  ];
  for (const repo of report.workspace.repos) {
    const stack = repo.stack.length > 0 ? repo.stack.join(", ") : "stack unknown";
    lines.push(`  ${repo.name.padEnd(20)} ${stack} · confidence ${repo.confidence} · branch ${repo.defaultBranch}`);
  }
  lines.push(
    "",
    `  map        ${report.map.files.length} documents via ${report.map.providers.join(", ") || "no provider"}`,
    `  experts    ${report.experts.length} seeded at level 0`,
    `  questions  ${options.interview ? `${report.questions.length} written to .tldrx/init-questions.md` : "skipped (--no-interview)"}`,
    "",
  );
  for (const path of report.created) lines.push(`  created  ${path}`);
  for (const path of report.kept) lines.push(`  kept     ${path}`);
  lines.push("", "Next: read .tldrx/init-handoff.md, then answer .tldrx/init-questions.md.", "");
  return lines.join("\n");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
