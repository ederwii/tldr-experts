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
import { EXIT_NOT_FOUND, EXIT_OK, EXIT_USAGE } from "../exitCodes.ts";
import { boolFlag, parseArgs, stringFlag, UsageError } from "../argv.ts";
import { workspaceRootFrom } from "../workspace.ts";
import { fail } from "../report.ts";
import { RunStore } from "../../core/run/RunStore.ts";
import { buildBudgetView, renderBudget } from "../../core/budget/budgetView.ts";
import { describeRaise, raiseBudget } from "../../core/budget/raiseBudget.ts";
import { PROJECT_WORK_DIR } from "../../core/paths.ts";

const VALUE_FLAGS = ["run", "root", "take-from"];

export const budgetCommand: Command = {
  name: "budget",
  summary: "Show what the run may still spend, or raise a phase ceiling",
  usage:
    "tldrx budget show [--run <id>] [--json] [--root <path>]\n" +
    "       tldrx budget raise <phase> <usd> [--run <id>] [--take-from <phase>] [--root <path>]",
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
    const store = openRun(args.positionals[0] ?? stringFlag(args, "run"), workspaceRootFrom(args));
    if (store === null) return EXIT_NOT_FOUND;

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
    const store = openRun(stringFlag(args, "run"), workspaceRootFrom(args));
    if (store === null) return EXIT_NOT_FOUND;

    const outcome = raiseBudget(store.budget, {
      phaseId,
      amountUsd,
      takeFrom: stringFlag(args, "take-from") ?? null,
    });
    store.mutateBudget(() => outcome.budget);
    store.mutate((run) => ({ ...run, budget: { ...run.budget, ceiling_usd: outcome.runCeilingAfter } }));
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

function openRun(wanted: string | undefined, root: string): RunStore | null {
  const store = RunStore.find(root, wanted);
  if (store !== null) return store;
  process.stderr.write(
    wanted === undefined
      ? `tldrx budget: no non-terminal run in ${PROJECT_WORK_DIR}/\n`
      : `tldrx budget: no run '${wanted}' in ${PROJECT_WORK_DIR}/\n`,
  );
  return null;
}
