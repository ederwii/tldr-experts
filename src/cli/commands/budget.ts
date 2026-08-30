/** `tldrx budget` — What the run may still spend, and the one way to change it.
 *
 * `show` puts remaining and the next stage's own estimate on the same line, so
 * "will `next` run?" is answerable without opening two files. `raise` is the only
 * sanctioned edit to `budget.yml`, and it validates before it writes: the §2.11
 * rule (Σ phase ceilings ≤ run ceiling) holds on the way out, and a `--take-from`
 * phase can never be cut below what it has already spent.
 *
 * Neither subcommand runs an agent, and neither advances the run.
 */
import type { Command } from "../Command.ts";
import { EXIT_OK, EXIT_USAGE } from "../exitCodes.ts";
import { boolFlag, parseArgs, stringFlag, UsageError } from "../argv.ts";
import { workspaceRootFrom } from "../workspace.ts";
import { fail } from "../report.ts";
import { isResolved, resolveRunOrExplain, type RunOrExit } from "../resolveRun.ts";
import { buildBudgetView, renderBudget } from "../../core/budget/budgetView.ts";
import { describeRaise, raiseBudget } from "../../core/budget/raiseBudget.ts";
import { currentActor, nowRfc3339 } from "../../hooks/lib/actor.ts";

const VALUE_FLAGS = ["run", "root", "take-from", "note"];

export const budgetCommand: Command = {
  name: "budget",
  summary: "Show what the run may still spend, or raise a phase ceiling",
  usage:
    "tldrx budget show [--run <id>] [--json] [--root <path>]\n" +
    "       tldrx budget raise <phase> <usd> [--run <id>] [--take-from <phase>] [--note <text>] [--root <path>]",
  subcommands: ["show", "raise"],
  implemented: true,
  async run(argv: readonly string[]): Promise<number> {
    const [sub, ...rest] = argv;
    switch (sub) {
      case "show":
        return budgetShow(rest);
      case "raise":
        return budgetRaise(rest);
      default:
        process.stderr.write(`tldrx budget: expected \`show\` or \`raise\`\n${budgetCommand.usage}\n`);
        return EXIT_USAGE;
    }
  },
};

function budgetShow(argv: readonly string[]): number {
  try {
    const args = parseArgs(argv, VALUE_FLAGS);
    const resolved = openRun(args.positionals[0] ?? stringFlag(args, "run"), workspaceRootFrom(args));
    if (!isResolved(resolved)) return resolved.exit;
    const store = resolved.store;

    const view = buildBudgetView(store.run, store.budget);
    process.stdout.write(
      boolFlag(args, "json") ? `${JSON.stringify(view, null, 2)}\n` : `${renderBudget(view)}\n`,
    );
    return EXIT_OK;
  } catch (error) {
    return fail("budget show", error);
  }
}

function budgetRaise(argv: readonly string[]): number {
  try {
    const args = parseArgs(argv, VALUE_FLAGS);
    const phaseId = args.positionals[0];
    const amountText = args.positionals[1];
    if (phaseId === undefined || amountText === undefined) {
      throw new UsageError("budget raise needs a phase and an amount: `tldrx budget raise 02-how 3.00`");
    }
    const amountUsd = Number(amountText.replace(/^\$/, ""));
    if (!Number.isFinite(amountUsd)) {
      throw new UsageError(`the amount must be a number of dollars, got '${amountText}'`);
    }
    const resolved = openRun(stringFlag(args, "run"), workspaceRootFrom(args));
    if (!isResolved(resolved)) return resolved.exit;
    const store = resolved.store;

    const outcome = raiseBudget(store.budget, {
      phaseId,
      amountUsd,
      takeFrom: stringFlag(args, "take-from") ?? null,
    });
    store.mutateBudget(() => outcome.budget);
    store.mutate((run) => ({ ...run, budget: { ...run.budget, ceiling_usd: outcome.runCeilingAfter } }));

    // Before/after, who, and why — appended BEFORE the save, so a raise that
    // fails validation leaves no event claiming it happened. Until 2026-08-29
    // `budget raise` rewrote budget.yml and appended nothing at all (audit §E):
    // the one sanctioned way to move a ceiling was the one act with no record.
    store.append({
      ts: nowRfc3339(),
      run: store.runId,
      stage: null,
      type: "budget.raised",
      actor: currentActor(),
      cost_usd: 0,
      payload: {
        phase: outcome.phaseId,
        amount_usd: outcome.amountUsd,
        take_from: outcome.takeFrom,
        phase_ceiling_before: outcome.phaseCeilingBefore,
        phase_ceiling_after: outcome.phaseCeilingAfter,
        run_ceiling_before: outcome.runCeilingBefore,
        run_ceiling_after: outcome.runCeilingAfter,
        note: stringFlag(args, "note") ?? "",
      },
    });
    store.save();

    const view = buildBudgetView(store.run, store.budget);
    const lines = [describeRaise(outcome)];
    lines.push(
      view.blocked === null
        ? "`tldrx next` is now affordable in every phase that still has a stage to run."
        : `still BLOCKED in ${view.blocked.id} — ${view.fix_command ?? ""}`,
    );
    process.stdout.write(`${lines.join("\n")}\n`);
    return EXIT_OK;
  } catch (error) {
    return fail("budget raise", error);
  }
}

/** The store, or the exit code to return — 3 for no run, 2 when several are open. */
function openRun(wanted: string | undefined, root: string): RunOrExit {
  return resolveRunOrExplain("tldrx budget", root, wanted);
}
