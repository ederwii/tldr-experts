/** `tldrx map` — Build, refresh or drift-check the code knowledge base
 *
 * Concept §4.2, spec §3.
 *   `--refresh` re-detects the workspace and rewrites `.tldrx/map/**`.
 *   `--check`   resolves every `[src: <repo:>path:line]` citation in the map and
 *               the init handoff against the filesystem. Exit 1 lists the ones
 *               that no longer land — a map whose citations rot is a map that
 *               lies.
 */
import { resolve } from "node:path";
import type { Command } from "../Command.ts";
import { EXIT_FAILED, EXIT_OK } from "../exitCodes.ts";
import { SpawnCommandRunner } from "../../core/detect/CommandRunner.ts";
import { detectWorkspace } from "../../core/detect/detectWorkspace.ts";
import { buildMap } from "../../core/map/buildMap.ts";
import { checkCitations } from "../../core/map/checkCitations.ts";
import { chooseProviders } from "../../core/init/runInit.ts";
import { loadWorkspaceFile } from "../../core/init/loadWorkspaceFile.ts";
import { isProviderPreference, type ProviderPreference } from "../../core/init/InitOptions.ts";

interface MapArgs {
  readonly mode: "refresh" | "check";
  readonly workspaceDir: string;
  readonly provider: ProviderPreference;
}

export const mapCommand: Command = {
  name: "map",
  summary: "Build, refresh or drift-check the code knowledge base",
  usage: "tldrx map <--refresh|--check> [--root <path>] [--provider <auto|graphify|static>]",
  subcommands: ["--refresh", "--check"],
  implemented: true,
  async run(argv: readonly string[]): Promise<number> {
    let args: MapArgs;
    try {
      args = parseMapArgs(argv);
    } catch (error) {
      process.stderr.write(`tldrx map: ${message(error)}\n${this.usage}\n`);
      return EXIT_FAILED;
    }
    try {
      return args.mode === "refresh" ? await refresh(args) : await check(args);
    } catch (error) {
      process.stderr.write(`tldrx map: ${message(error)}\n`);
      return EXIT_FAILED;
    }
  },
};

export function parseMapArgs(argv: readonly string[]): MapArgs {
  let mode: "refresh" | "check" | null = null;
  let workspaceDir = process.cwd();
  let provider: ProviderPreference = "auto";

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    switch (arg) {
      case "--refresh": mode = "refresh"; break;
      case "--check": mode = "check"; break;
      case "--root": {
        const value = argv[++i];
        if (value === undefined || value.startsWith("--")) throw new Error("--root needs a value");
        workspaceDir = value;
        break;
      }
      case "--provider": {
        const value = argv[++i];
        if (value === undefined || !isProviderPreference(value)) {
          throw new Error("--provider expects auto|graphify|static");
        }
        provider = value;
        break;
      }
      default: throw new Error(`unknown option '${arg}'`);
    }
  }
  if (mode === null) throw new Error("one of --refresh or --check is required");
  return { mode, workspaceDir: resolve(workspaceDir), provider };
}

async function refresh(args: MapArgs): Promise<number> {
  const loaded = await loadWorkspaceFile(args.workspaceDir);
  const runner = new SpawnCommandRunner();
  const workspace = await detectWorkspace(loaded.root, runner);
  const result = await buildMap({
    workspace,
    workspaceDir: args.workspaceDir,
    providers: chooseProviders(
      { root: loaded.root, out: args.workspaceDir, interview: false, methodology: null, mcp: false, stack: [], provider: args.provider },
      runner,
    ),
  });
  process.stdout.write(
    `tldrx map --refresh — ${result.files.length} documents via ${result.providers.join(", ") || "no provider"}\n`
    + result.files.map((file) => `  ${file}\n`).join(""),
  );
  return EXIT_OK;
}

async function check(args: MapArgs): Promise<number> {
  const loaded = await loadWorkspaceFile(args.workspaceDir);
  const result = await checkCitations({
    workspaceDir: args.workspaceDir,
    root: loaded.root,
    repos: loaded.repos,
  });

  if (result.problems.length === 0) {
    process.stdout.write(
      `tldrx map --check — ${result.checked} file citations in ${result.documents} documents all resolve\n`,
    );
    return EXIT_OK;
  }
  const lines = result.problems.map((problem) =>
    `  ${problem.file}:${problem.line}  ${problem.src === "" ? "(no token)" : problem.src}  — ${problem.reason}`);
  process.stderr.write(
    `tldrx map --check — ${result.problems.length} of ${result.checked} citations do not resolve:\n`
    + lines.join("\n") + "\n",
  );
  return EXIT_FAILED;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
