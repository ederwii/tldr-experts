/** `tldrx budget` — What the run may still spend, and the one way to change it.
 *
 * `show` puts remaining and the next stage's own estimate on the same line, so
 * "will `next` run?" is answerable without opening two files. `raise` is the only
 * sanctioned edit to `budget.yml`, and it validates before it writes: the §2.11
 * rule (Σ phase ceilings ≤ run ceiling) holds on the way out, and a `--take-from`
 * phase can never be cut below what it has already spent.
 *
 * `grant` is the third verb (#170) and it writes a NUMBER where the framework
 * used to have prose: `tldrx budget grant 20 --fact F031` records that the owner
 * authorized $20 and which decision said so, and `raise` then checks the ceiling
 * it is about to write against it.
 *
 * TWO EXIT FAMILIES, and they are two conditions rather than one split across
 * two. **1** is "you asked for something impossible": a bad amount, an unknown
 * phase, a `--fact` naming no live fact, a `--on-exceed` value that is not one of
 * `ON_GRANT_EXCEED`. **2** (`EXIT_GATE_REFUSED`) is "the owner forbade this
 * ceiling": the ceiling a raise would write is above the recorded grant and the
 * file says `on_grant_exceed: block`. Nothing in the first family ever returns 2,
 * and the second is never anything else.
 *
 * None of the three runs an agent, and none advances the run.
 */
import type { Command } from "../Command.ts";
import { EXIT_GATE_REFUSED, EXIT_OK, EXIT_USAGE } from "../exitCodes.ts";
import { boolFlag, parseArgs, stringFlag, UsageError, type ParsedArgs } from "../argv.ts";
import { workspaceRootFrom } from "../workspace.ts";
import { fail } from "../report.ts";
import { isResolved, resolveRunOrExplain, type RunOrExit } from "../resolveRun.ts";
import { buildBudgetView, renderBudget } from "../../core/budget/budgetView.ts";
import { round2 } from "../../core/build/caps.ts";
import type { RunFile } from "../../core/run/RunFile.ts";
import { describeRaise, raiseBudget, raiseGrantVerdict, raisedPayload } from "../../core/budget/raiseBudget.ts";
import { wouldExceedGrant } from "../../core/budget/grant.ts";
import { ON_GRANT_EXCEED, type OnGrantExceed } from "../../core/budget/RunBudget.ts";
import { FactsStore } from "../../core/facts/FactsStore.ts";
import { isLive } from "../../core/facts/Fact.ts";
import { factsPath } from "../../hooks/lib/workspace.ts";
import { currentActor, nowRfc3339 } from "../../hooks/lib/actor.ts";

const VALUE_FLAGS = ["run", "root", "take-from", "note", "fact", "phase", "on-exceed", "stage"];

export const budgetCommand: Command = {
  name: "budget",
  summary: "Show what the run may still spend, raise a phase ceiling, or record what the owner authorized",
  usage:
    "tldrx budget show [<run>] [--run <id>] [--json] [--root <path>]\n" +
    "       tldrx budget raise <phase> <usd> [--stage <id>] [--run <id>] [--take-from <phase>] [--note <text>] [--root <path>]\n" +
    "       tldrx budget grant <usd> --fact <F> [--phase <p>] [--on-exceed <warn|block>] [--note <text>] [--run <id>] [--root <path>]",
  implemented: true,
  async run(argv: readonly string[]): Promise<number> {
    const [sub, ...rest] = argv;
    switch (sub) {
      case "show":
        return budgetShow(rest);
      case "raise":
        return budgetRaise(rest);
      case "grant":
        return budgetGrant(rest);
      default:
        process.stderr.write(`tldrx budget: expected \`show\`, \`raise\` or \`grant\`\n${budgetCommand.usage}\n`);
        return EXIT_USAGE;
    }
  },
};

/**
 * `--fact`, `--phase` and `--on-exceed` belong to `grant` and to nothing else.
 *
 * `VALUE_FLAGS` is one list for all three subcommands and `flagRefusal`
 * (`cli/index.ts`) judges flags per COMMAND, not per subcommand — so without this
 * `budget raise --on-exceed block` parses, exits 0, raises the ceiling and writes
 * no policy at all. A flag that reads like a policy switch on the very command
 * the policy governs, and changes nothing, is worse than an unknown flag: the
 * unknown one at least says so. Refused rather than wired, because a raise does
 * not set policy — recording one is `grant`'s whole job.
 */
const GRANT_ONLY_FLAGS = ["fact", "phase", "on-exceed"] as const;

/**
 * `--stage` belongs to `raise` and to nothing else, for the reason
 * `GRANT_ONLY_FLAGS` exists: `flagRefusal` judges flags per COMMAND, so without
 * this `budget show --stage build` would parse, exit 0 and mean nothing. A flag
 * that names the one knob an operator came here to move, and moves it silently
 * nowhere, is worse than an unknown flag.
 */
const RAISE_ONLY_FLAGS = ["stage"] as const;

function refuseRaiseFlags(args: ParsedArgs, verb: string): void {
  for (const flag of RAISE_ONLY_FLAGS) {
    if (!boolFlag(args, flag)) continue;
    throw new UsageError(
      `--${flag} is \`budget raise\`'s flag, not \`budget ${verb}\`'s — ` +
        "raise a stage's own ceiling with `tldrx budget raise <phase> <usd> --stage <id>`",
    );
  }
}

function refuseGrantFlags(args: ParsedArgs, verb: string): void {
  for (const flag of GRANT_ONLY_FLAGS) {
    if (!boolFlag(args, flag)) continue;
    throw new UsageError(
      `--${flag} is \`budget grant\`'s flag, not \`budget ${verb}\`'s — ` +
        "record an authorization with `tldrx budget grant <usd> --fact <F> [--phase <p>] " +
        "[--on-exceed <warn|block>]`",
    );
  }
}

function budgetShow(argv: readonly string[]): number {
  try {
    const args = parseArgs(argv, VALUE_FLAGS);
    refuseGrantFlags(args, "show");
    refuseRaiseFlags(args, "show");
    const resolved = openRun(args.positionals[0] ?? stringFlag(args, "run"), workspaceRootFrom(args));
    if (!isResolved(resolved)) return resolved.exit;
    const store = resolved.store;

    const view = buildBudgetView(store.run, store.budget, store.runDir);
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
    refuseGrantFlags(args, "raise");
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

    // Resolved BEFORE anything is computed, so an unknown stage refuses with both
    // files byte-identical (the usage family: exit 1, nothing behind it).
    const stageId = stringFlag(args, "stage") ?? null;
    if (stageId !== null) requireStageBudget(store.run, phaseId, stageId);

    const outcome = raiseBudget(store.budget, {
      phaseId,
      amountUsd,
      takeFrom: stringFlag(args, "take-from") ?? null,
    });

    // The RESULTING ceiling, against what the owner authorized (#170) — checked
    // before anything is written, so a refusal leaves budget.yml byte-identical.
    // `raiseGrantVerdict` owns which grant governs (phase vs run); `run auto
    // --rebalance-finished` asks the same function (gh #314).
    const verdict = raiseGrantVerdict(store.budget, outcome);
    // 2, not 1: this is the owner forbidding a ceiling, not the operator typing
    // something impossible. See this file's header on the two families.
    if (verdict.blocked) {
      process.stderr.write(`tldrx budget raise: ${verdict.sentence ?? ""}\n`);
      return EXIT_GATE_REFUSED;
    }

    // budget.yml ONLY. Until #236 this also wrote `outcome.runCeilingAfter` into
    // run.yml's `budget.ceiling_usd`, which looked like keeping the mirror honest
    // and was really a second synchroniser for a figure that already had an owner
    // — and concurrency defeated it: any long-lived `RunStore` saving afterwards
    // carried its own loaded copy back over the raise (`RunStore.rollUp`), and
    // `run status` then read a ceiling smaller than its own remainder. §7 says one
    // implementation per derivation; the answer is one COPY, not a better sync.
    store.mutateBudget(() => outcome.budget);

    // gh #244: the STAGE's own `budget_usd` — the only one of the three knobs
    // that sets a spawn ceiling. Written here and nowhere else, because run.yml
    // OWNS this figure: #236's lesson was about a second copy of a number whose
    // owner was budget.yml, and this is the opposite case — mirroring it into
    // budget.yml is what would repeat that mistake.
    const stageBefore = stageId === null ? null : requireStageBudget(store.run, phaseId, stageId);
    if (stageId !== null) {
      store.mutate((run) => ({
        ...run,
        phases: run.phases.map((phase) => phase.id !== phaseId ? phase : {
          ...phase,
          stages: phase.stages.map((stage) => stage.id !== stageId ? stage : {
            ...stage,
            budget_usd: round2(stage.budget_usd + amountUsd),
          }),
        }),
      }));
    }

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
      payload: raisedPayload(outcome, {
        // ADDITIVE (gh #244), and omitted on every raise that named no stage —
        // absent means what it has always meant: no spawn ceiling moved.
        ...(stageId === null || stageBefore === null ? {} : {
          stage: stageId,
          stage_budget_before: stageBefore,
          stage_budget_after: round2(stageBefore + amountUsd),
        }),
        note: stringFlag(args, "note") ?? "",
      }),
    });
    store.save();

    const view = buildBudgetView(store.run, store.budget, store.runDir);
    const lines = [describeRaise(outcome), ...stageRaiseLines(phaseId, stageId, stageBefore, amountUsd)];
    // The `warn` half of #170: the ceiling was written, and the sentence names
    // the grant, the fact behind it and the figure — so the operator reads what
    // they just went past rather than finding out in a retro.
    if (verdict.sentence !== null) lines.push(verdict.sentence);
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

/**
 * `tldrx budget grant <usd> --fact <F> [--phase <p>]` — record what the owner
 * AUTHORIZED, as a number, in the one money ledger (#170).
 *
 * Recording a grant never rewrites a ceiling and never refuses one. If the
 * current ceiling is already above the grant it says so and records anyway:
 * the money is already committed, there is nothing left to refuse, and a
 * decision that arrives late is still a decision. The refusal — 2, under
 * `on_grant_exceed: block` — belongs to `raise`, which is where a ceiling is
 * actually written.
 *
 * Every refusal HERE is 1: a bad amount, an unknown phase, an unknown
 * `--on-exceed`, a `--fact` naming no live fact. All four are "you asked for
 * something impossible", which is the family the exit table gives 1.
 */
function budgetGrant(argv: readonly string[]): number {
  try {
    const args = parseArgs(argv, VALUE_FLAGS);
    refuseRaiseFlags(args, "grant");
    const amountText = args.positionals[0];
    if (amountText === undefined) {
      throw new UsageError("budget grant needs an amount: `tldrx budget grant 20 --fact F031`");
    }
    const amountUsd = Number(amountText.replace(/^\$/, ""));
    if (!Number.isFinite(amountUsd)) {
      throw new UsageError(`the amount must be a number of dollars, got '${amountText}'`);
    }
    // Neither a negative nor a zero authorization is a small one. A negative
    // figure has no meaning at all; a $0 one is far likelier to be a typo or an
    // unset shell variable than an owner deciding the run may spend nothing —
    // and under `on_grant_exceed: block` it would refuse every later raise.
    // Absence already says "no grant recorded"; "authorized, and the answer is
    // no" is a sentence to write in a FACT, not a number to slip in through an
    // amount argument.
    if (amountUsd <= 0) {
      throw new UsageError(
        `a grant must be more than $0.00, got '${amountText}' — if the owner authorized nothing, ` +
          "record that as a fact and leave budget.yml with no grant",
      );
    }
    // REQUIRED, and this is the whole point of the verb: a grant that cannot
    // name the decision behind it is a number nobody said. `--fact` must name a
    // LIVE fact — a retired or superseded one is a decision that has since been
    // taken back, and citing it would record an authorization that no longer
    // stands.
    const factId = stringFlag(args, "fact");
    if (factId === undefined || factId === "") {
      throw new UsageError(
        "budget grant needs --fact <F>: a grant with no decision behind it is a number nobody said",
      );
    }
    const policyText = stringFlag(args, "on-exceed");
    if (policyText !== undefined && !(ON_GRANT_EXCEED as readonly string[]).includes(policyText)) {
      throw new UsageError(`--on-exceed expects ${ON_GRANT_EXCEED.join(" or ")}, got '${policyText}'`);
    }
    const policy = policyText as OnGrantExceed | undefined;

    const root = workspaceRootFrom(args);
    const fact = FactsStore.loadOrEmpty(factsPath(root)).get(factId);
    if (fact === undefined || !isLive(fact)) {
      throw new UsageError(
        `no live fact \`${factId}\` in .tldrx/memory/facts.yml — a grant with no decision behind it ` +
          "is a number nobody said. Record the decision first (`tldrx facts add …`)",
      );
    }

    const resolved = openRun(stringFlag(args, "run"), root);
    if (!isResolved(resolved)) return resolved.exit;
    const store = resolved.store;

    const phaseId = stringFlag(args, "phase") ?? null;
    if (phaseId !== null && !store.budget.phases.some((p) => p.id === phaseId)) {
      throw new UsageError(
        `no phase \`${phaseId}\` in budget.yml — it has ${store.budget.phases.map((p) => p.id).join(", ")}`,
      );
    }

    // What this grant REPLACES, read before the mutation. Replacement is the rule
    // — a later decision supersedes an earlier one, and an owner may reduce as
    // well as raise — but it may not change the ledger's number in silence, so
    // the figure goes on the event and into the sentence. Null on the first
    // grant, which is a different fact from "replaced $0".
    const previousUsd = phaseId === null
      ? store.budget.authorized_usd
      : store.budget.phases.find((p) => p.id === phaseId)?.authorized_usd ?? null;

    const at = nowRfc3339();
    store.mutateBudget((budget) => ({
      ...budget,
      // `--phase` scopes the AMOUNT, never the citation: `authorized_by` and
      // `authorized_at` are written at the run level either way, because
      // `grantFor`'s phase branch reads `phase.authorized_usd != null &&
      // budget.authorized_by !== null`. A phase amount with no fact id beside it
      // would be a recorded number that silently governs nothing.
      ...(phaseId === null ? { authorized_usd: amountUsd } : {}),
      authorized_by: factId,
      authorized_at: at,
      // Absent leaves the policy where it was — a second grant is not a place to
      // silently downgrade an operator's `block` back to `warn`.
      on_grant_exceed: policy ?? budget.on_grant_exceed,
      phases: phaseId === null
        ? budget.phases
        : budget.phases.map((p) => (p.id === phaseId ? { ...p, authorized_usd: amountUsd } : p)),
    }));

    const note = stringFlag(args, "note") ?? "";
    // Appended BEFORE the save, exactly as `budget raise` does, so a grant that
    // fails validation leaves no event claiming it happened.
    store.append({
      ts: at,
      run: store.runId,
      stage: null,
      type: "budget.granted",
      actor: currentActor(),
      cost_usd: 0,
      payload: {
        amount_usd: amountUsd,
        fact: factId,
        phase: phaseId,
        note,
        ceiling_usd: store.budget.ceiling_usd,
        previous_usd: previousUsd,
      },
    });
    store.save();

    const scope = phaseId === null ? "the run" : phaseId;
    const replaces = previousUsd === null
      ? ""
      : ` — replaces ${money(previousUsd)} → ${money(amountUsd)}`;
    const lines = [
      `recorded: ${factId} authorizes ${money(amountUsd)} for ${scope} ` +
        `(on_grant_exceed: ${store.budget.on_grant_exceed})${replaces}.`,
    ];
    // The ceiling this grant is measured against — the phase's own when the grant
    // names one, the run's otherwise. Same two branches `raise` uses, and for the
    // same reason: they are two different questions.
    const current = phaseId === null
      ? store.budget.ceiling_usd
      : store.budget.phases.find((p) => p.id === phaseId)?.ceiling_usd ?? store.budget.ceiling_usd;
    const verdict = wouldExceedGrant(store.budget, phaseId, current);
    // Said, never refused, and the wording is deliberately not `raise`'s: there
    // is nothing to refuse here, because the money is already committed.
    if (verdict.exceeds) {
      lines.push(
        `NOTE: the ceiling already on disk for ${scope} is ${money(current)}, above the ` +
          `${money(amountUsd)} just authorized. Nothing was rewritten — a grant records a ` +
          "decision, it does not move money.",
      );
    }
    process.stdout.write(`${lines.join("\n")}\n`);
    return EXIT_OK;
  } catch (error) {
    return fail("budget grant", error);
  }
}

function money(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/** The store, or the exit code to return — 3 for no run, 2 when several are open. */
function openRun(wanted: string | undefined, root: string): RunOrExit {
  return resolveRunOrExplain("tldrx budget", root, wanted);
}

/**
 * The stage's `budget_usd` as it stands, or a usage refusal naming what the
 * phase actually has (gh #244).
 *
 * A stage id nobody can resolve is the same family as an unknown phase — "you
 * asked for something impossible", exit 1, nothing written — and the refusal
 * lists the stages rather than saying no, because the operator typing this has
 * just been told by another refusal to move a ceiling and does not have run.yml
 * open.
 */
function requireStageBudget(run: RunFile, phaseId: string, stageId: string): number {
  const phase = run.phases.find((entry) => entry.id === phaseId);
  if (phase === undefined) throw new UsageError(`no phase \`${phaseId}\` in this run`);
  const stage = phase.stages.find((entry) => entry.id === stageId);
  if (stage === undefined) {
    const known = phase.stages.map((entry) => entry.id).join(", ");
    throw new UsageError(
      `no stage \`${stageId}\` in ${phaseId} — this phase has: ${known === "" ? "none" : known}`,
    );
  }
  return stage.budget_usd;
}

/**
 * What the raise did — or did NOT do — to the knob that caps a spawn (gh #244).
 *
 * The measurement behind this sentence (the session running two live unattended
 * runs; their measurement, not this file's): raising the stage `budget_usd`
 * alone, 16.20 → 60, moved a developer ceiling 5.97 → 22.11 on the next spawn,
 * while raising `per_agent_max_usd` AND the phase ceiling without touching the
 * stage moved it by nothing. A phase ceiling takes part in the economy refusal
 * ("remaining work > left") and sets no cap; `per_agent_max_usd` only caps from
 * above. So a raise that named no stage has to SAY that every sub-agent will be
 * dispatched under exactly the ceiling it had before — otherwise the operator
 * raises, re-runs, dies on the same cap, and buys one turn per retry, which is
 * the loop gh #244 and gh #289 were both filed out of.
 */
function stageRaiseLines(
  phaseId: string, stageId: string | null, before: number | null, amountUsd: number,
): readonly string[] {
  if (stageId === null || before === null) {
    return [
      "No spawn ceiling moved: per-story and reviewer caps come from the STAGE's own "
        + `budget_usd, not from this phase ceiling. Move that too with \`--stage <id>\` `
        + `(\`tldrx budget show\` names the stage ${phaseId} would run next).`,
    ];
  }
  return [
    `${phaseId}/${stageId} budget_usd $${before.toFixed(2)} → $${round2(before + amountUsd).toFixed(2)} `
      + `(+$${amountUsd.toFixed(2)}) — every per-story and reviewer cap is derived from this figure.`,
  ];
}
