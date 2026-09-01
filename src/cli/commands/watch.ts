/**
 * `tldrx watch list [--run <id>]` and `tldrx watch check [<feature>]` — read-only.
 *
 * `list` is the one screen that answers "what is watched, and what only looks
 * watched". `check` answers the question that matters *after* the run closes: it
 * re-resolves the cards' citations, and — since issue #65 — prints the card's
 * Signal items as the post-merge checklist a person actually works through, with
 * the repo that owns each one. A feature id scopes it to one card; without one,
 * every card in the run is checked, which is the shape a CI job wants.
 *
 * `--execute` is the single exception to "writes nothing": it re-runs the
 * `$ <cmd> → exit <n>` sources the cards recorded, through the same allowlist and
 * the same argv-never-a-shell rule the stage checks use. Opt-in, never default.
 */
import type { Command } from "../Command.ts";
import { EXIT_FAILED, EXIT_GATE_REFUSED, EXIT_NOT_FOUND, EXIT_OK, EXIT_USAGE } from "../exitCodes.ts";
import { boolFlag, parseArgs, stringFlag, UsageError, type ParsedArgs } from "../argv.ts";
import { workspaceRootFrom } from "../workspace.ts";
import { fail } from "../report.ts";
import { RunStore } from "../../core/run/RunStore.ts";
import { notFound, renderAmbiguous } from "../resolveRun.ts";
import { listRunDirs, loadWorkspace, toSrcContext } from "../../hooks/lib/workspace.ts";
import {
  cardChecklist, checklistOk, executeSignals, loadCards, nothingToCheck, renderChecklist,
  renderWatchList, watchListJson, type CardChecklist, type LoadedCard, type SignalRuns,
} from "../../core/watch/index.ts";
import { PROJECT_WORK_DIR } from "../../core/paths.ts";
import type { SrcContext } from "../../core/text/srcToken.ts";

const VALUE_FLAGS = ["run", "root"] as const;

export const watchCommand: Command = {
  name: "watch",
  summary: "List the watcher cards a run produced, or work through them as a checklist",
  usage: "tldrx watch list [--json] [--run <id>] [--root <path>]\n"
    + "       tldrx watch check [<feature>] [--execute] [--run <id>] [--root <path>]",
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
          return await check(args, rest);
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
  process.stdout.write(
    boolFlag(args, "json")
      ? `${watchListJson(loaded.runId, loaded.cards)}\n`
      : renderWatchList(loaded.runId, loaded.cards),
  );
  return EXIT_OK;
}

/**
 * The post-merge checklist, plus the citation re-check that was here before it.
 *
 * Exit 1, not 0, when a card no longer validates or a re-run disagrees with what
 * the card recorded: `watch check` is a check, and a check that reports rot on
 * stdout and exits 0 is invisible to the CI job that is the only reason anyone
 * would run it unattended.
 *
 * Exit 3 for "there is nothing to check". Not 0 — a green that means "I looked at
 * no cards" is the exact lie this command exists to stop — and not 1, because a
 * run that never reached Watch is not a rotten card.
 */
async function check(args: ParsedArgs, rest: readonly string[]): Promise<number> {
  const feature = rest[0];
  if (rest.length > 1) throw new UsageError(`watch check takes ONE feature id, got '${rest.join(" ")}'`);
  const loaded = open(args);
  if ("exit" in loaded) return loaded.exit;

  const refusal = nothingToCheck(loaded.runDir, loaded.runId, loaded.cards);
  if (refusal !== null) {
    process.stderr.write(`tldrx watch: ${refusal}\n`);
    return EXIT_NOT_FOUND;
  }

  let cards = loaded.cards;
  if (feature !== undefined) {
    cards = loaded.cards.filter((card) => card.id === feature);
    if (cards.length === 0) {
      const known = loaded.cards.map((c) => c.id).join(", ");
      process.stderr.write(
        `tldrx watch: no watcher card '${feature}' in run ${loaded.runId}`
        + `${known === "" ? "" : ` — this run has: ${known}`}\n`,
      );
      return EXIT_NOT_FOUND;
    }
  }

  const lists: readonly CardChecklist[] = cards.map((card) => cardChecklist(card, loaded.ctx));
  const runs: SignalRuns = boolFlag(args, "execute")
    ? await executeSignals(loaded.root, lists)
    : new Map();
  process.stdout.write(renderChecklist(loaded.runId, lists, runs));
  return checklistOk(lists, runs) ? EXIT_OK : EXIT_FAILED;
}

interface OpenedRun {
  readonly runId: string;
  /** Absolute `tldrx-work/<run>/` — what tells "no Watch stage" from "no cards". */
  readonly runDir: string;
  /** Workspace root — where `--execute` runs a card's recorded command. */
  readonly root: string;
  readonly ctx: SrcContext;
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
  return { runId: store.runId, runDir: store.runDir, root, ctx, cards: loadCards(store.runDir, ctx) };
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
