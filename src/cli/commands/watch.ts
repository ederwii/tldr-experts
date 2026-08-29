/**
 * `tldrx watch list [--run <id>]` and `tldrx watch check <feature>` — read-only.
 *
 * Neither subcommand runs a stage, spawns anything or writes a byte. `list` is the
 * one screen that answers "what is watched, and what only looks watched"; `check`
 * re-resolves one card's citations, which is the question that matters *after* the
 * run closes, when the code the card points at has moved.
 */
import type { Command } from "../Command.ts";
import { EXIT_FAILED, EXIT_GATE_REFUSED, EXIT_NOT_FOUND, EXIT_OK, EXIT_USAGE } from "../exitCodes.ts";
import { parseArgs, stringFlag, UsageError, type ParsedArgs } from "../argv.ts";
import { workspaceRootFrom } from "../workspace.ts";
import { fail } from "../report.ts";
import { RunStore } from "../../core/run/RunStore.ts";
import { notFound, renderAmbiguous } from "../resolveRun.ts";
import { listRunDirs, loadWorkspace, toSrcContext } from "../../hooks/lib/workspace.ts";
import { checkCard, loadCards, renderWatchList, type LoadedCard } from "../../core/watch/index.ts";
import { PROJECT_WORK_DIR } from "../../core/paths.ts";

const VALUE_FLAGS = ["run", "root"] as const;

export const watchCommand: Command = {
  name: "watch",
  summary: "List and re-check the watcher cards a run produced",
  usage: "tldrx watch <list|check> [<feature>] [--run <id>] [--root <path>]",
  subcommands: ["list", "check"],
  implemented: true,
  async run(argv: readonly string[]): Promise<number> {
    try {
      const args = parseArgs(argv, [...VALUE_FLAGS]);
      const [sub, ...rest] = args.positionals;
      switch (sub) {
        case "list":
          return list(args, rest);
        case "check":
          return check(args, rest);
        case undefined:
          throw new UsageError(`expected a subcommand — ${watchCommand.usage}`);
        default:
          throw new UsageError(`unknown subcommand '${sub}' — ${watchCommand.usage}`);
      }
    } catch (error) {
      return fail("watch", error, EXIT_USAGE);
    }
  },
};

function list(args: ParsedArgs, rest: readonly string[]): number {
  if (rest.length > 0) throw new UsageError(`watch list takes no positional argument, got '${rest[0] ?? ""}'`);
  const loaded = open(args);
  if ("exit" in loaded) return loaded.exit;
  process.stdout.write(renderWatchList(loaded.runId, loaded.cards));
  return EXIT_OK;
}

/**
 * Exit 1, not 0, when a card no longer validates: `watch check` is a check, and a
 * check that reports a dead citation on stdout and exits 0 is invisible to CI.
 */
function check(args: ParsedArgs, rest: readonly string[]): number {
  const feature = rest[0];
  if (feature === undefined) throw new UsageError("watch check needs a feature id — `tldrx watch check <feature>`");
  const loaded = open(args);
  if ("exit" in loaded) return loaded.exit;

  const card = loaded.cards.find((c) => c.id === feature);
  if (card === undefined) {
    const known = loaded.cards.map((c) => c.id).join(", ");
    process.stderr.write(
      `tldrx watch: no watcher card '${feature}' in run ${loaded.runId}`
      + `${known === "" ? "" : ` — this run has: ${known}`}\n`,
    );
    return EXIT_NOT_FOUND;
  }
  const report = checkCard(card);
  process.stdout.write(`${report.lines.join("\n")}\n`);
  return report.ok ? EXIT_OK : EXIT_FAILED;
}

interface OpenedRun {
  readonly runId: string;
  readonly cards: readonly LoadedCard[];
}

/** The cards to render, or the exit code the subcommand must return. */
type OpenedOrExit = OpenedRun | { readonly exit: number };

/** The named run, or the newest unfinished one — the same resolution `next` uses. */
function open(args: ParsedArgs): OpenedOrExit {
  const root = workspaceRootFrom(args);
  const runId = stringFlag(args, "run");
  // A run whose Watch stage produced cards is usually FINISHED, so falling back to
  // the newest unfinished run would answer "no run" to the one person reading
  // watchers. Named run first, then THE open run, then newest run of any status.
  // Several open runs and no `--run` is a refusal, not a guess.
  const resolution = RunStore.resolve(root, runId);
  if (resolution.kind === "ambiguous") {
    process.stderr.write(renderAmbiguous("tldrx watch", resolution.open));
    return { exit: EXIT_GATE_REFUSED };
  }
  const store = resolution.kind === "one" ? resolution.store : runId === undefined ? newest(root) : null;
  if (store === null) {
    process.stderr.write(`tldrx watch: ${notFound(runId)} in ${PROJECT_WORK_DIR}/\n`);
    return { exit: EXIT_NOT_FOUND };
  }
  const ctx = toSrcContext(loadWorkspace(root), store.runDir);
  return { runId: store.runId, cards: loadCards(store.runDir, ctx) };
}

function newest(root: string): RunStore | null {
  for (const dir of listRunDirs(root)) {
    try {
      return RunStore.open(dir);
    } catch {
      continue;
    }
  }
  return null;
}
