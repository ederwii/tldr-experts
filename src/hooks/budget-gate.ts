#!/usr/bin/env bun
/**
 * tldrx hook: budget-gate
 * PreToolUse (Bash) — the spawn itself is the thing being refused.
 *
 * Spec §4: trigger on `tool_input.command` matching `^(claude -p|tldrx next)`;
 * deny when `spent + estimate > phase ceiling` (or run ceiling) and
 * `on_exceed: block`; append `budget.blocked`.
 *
 * Concept §1.5: "the facilitator refuses to start work it cannot afford" — this is
 * the refusal, placed where the money is actually spent rather than where it is
 * reported.
 *
 * Fails OPEN: an unreadable budget never blocks a command.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { runHook, deny, allow } from "./lib/decide.ts";
import { readPayload, toolInput } from "./lib/payload.ts";
import { findWorkspaceRoot, locateWork, stageYamlPath } from "./lib/workspace.ts";
import {
  loadRunView, newestActiveRun, cursorStage, hostTokensIn, isAttendedByHostView,
  renderRunEconomies, runSpend, type RunView,
} from "./lib/runFile.ts";
import { budgetGateDeny } from "./lib/messages.ts";
import { currentActor, nowRfc3339 } from "./lib/actor.ts";
import { loadRunBudget } from "../core/budget/loadBudget.ts";
import { economyFor, isHostTokens } from "../core/budget/RunBudget.ts";
import { remainingWork } from "../core/budget/remainingWork.ts";
import { wouldExceed, wouldExceedHostTokens } from "../core/budget/wouldExceed.ts";
import { raiseCommand, shortBy } from "../core/budget/budgetView.ts";
import { applyRebalance, describeRebalance, planRebalance, REBALANCE_SOURCE } from "../core/budget/rebalance.ts";
import { raiseGrantVerdict } from "../core/budget/raiseBudget.ts";
import type { RunBudget } from "../core/budget/RunBudget.ts";
import type { RunFile } from "../core/run/RunFile.ts";
import { EventLog } from "../core/events/EventLog.ts";
import { parseYaml } from "../core/yaml.ts";
import { PROJECT_WORK_DIR } from "../core/paths.ts";
import { buildStageDefaults } from "../core/run/workflowPreset.ts";

/**
 * Every command that can spend money, not just the two the spec first listed.
 *
 * The 2026-08-29 audit measured the gap: `^(claude -p|tldrx next)` covered the
 * single-stage spawn and nothing else, so `tldrx run auto` (a loop of up to 96
 * stages), `tldrx expert train` ($2.00 a call) and `tldrx seed triage --propose`
 * ($1.00) walked straight past a gate whose whole job is refusing work the run
 * cannot afford. `run auto` is the worst of the three: the one command that can
 * spend an entire run's budget in one invocation was the one nothing checked.
 */
const SPAWN_RE = /^(claude -p|tldrx next|tldrx run auto|tldrx expert train|tldrx seed triage)\b/;
const RUN_ARG_RE = /--run[= ]([\w.-]+)/;
const RUN_AUTO_RE = /^tldrx run auto\b/;
const NO_REBALANCE_RE = /(?:^|\s)--no-rebalance-finished(?:[\s=]|$)/;

/**
 * The default ceiling each non-`next` spender uses when it is given no flag.
 *
 * `expert train` has TWO, because full mode costs what two sub-agents cost
 * (`core/training/Training.ts`, #96). Duplicated here rather than imported: this
 * hook runs as its own process off a PreToolUse payload and must not drag the
 * training module's filesystem imports in. The tests pin the two files together.
 */
const DEFAULT_TRAIN_USD = 2.0;
const DEFAULT_FULL_TRAIN_USD = 3.0;
const DEFAULT_TRIAGE_USD = 1.0;
const FULL_MODE_RE = /--mode[= ]full\b/;
const MAX_USD_RE = /--max-usd[= ]([0-9]+(?:\.[0-9]+)?)/;
const MAX_BUDGET_RE = /--max-budget-usd[= ]([0-9]+(?:\.[0-9]+)?)/;

/**
 * This hook is the one exception to spec §4's "every hook but DoD-gate fails
 * OPEN", and the exception is deliberate.
 *
 * It used to `return` — allow — on every unreadable thing: no run, no budget.yml,
 * no cursor, an estimate it could not compute (`budget-gate.ts:14,31`). That is
 * fail-open on the one hook whose entire job is refusing to SPEND, so the failure
 * mode was "cannot read the budget ⇒ spend anyway". Now, once a command has been
 * identified as a spender inside a tldrx workspace, an unreadable budget DENIES
 * and says which file it could not read.
 *
 * It still allows when the command is not a spender, or when there is no `.tldrx/`
 * at all — those are not failures, they are correct negatives.
 */
await runHook("budget-gate", async () => {
  const payload = await readPayload();
  if (payload.tool_name !== "Bash") return;
  const command = (toolInput(payload).command ?? "").trim();
  if (!SPAWN_RE.test(command)) return;

  const cwd = payload.cwd ?? process.cwd();
  const root = findWorkspaceRoot(cwd);
  if (root === null) return; // not a tldrx workspace; nothing to gate against

  // From here the hook is committed: this command spends, inside a tldrx
  // workspace. Any throw below is a budget it could not read, and that DENIES.
  let view: RunView | null;
  try {
    view = resolveRun(root, cwd, command);
  } catch (error) {
    failClosed(command, error instanceof Error ? error.message : String(error));
  }
  if (view === null) {
    // `expert train` and `seed triage` legitimately run with no run open: they
    // spend against no phase ceiling and there is nothing here to check them
    // against. Say so on stderr rather than pretending a check happened.
    if (/^tldrx (expert train|seed triage)\b/.test(command)) {
      process.stderr.write(
        "tldrx hook budget-gate: no run to charge this against — "
        + `\`${command.slice(0, 60)}\` spends outside any run's budget.yml\n`,
      );
      return;
    }
    failClosed(command, `no readable run under ${PROJECT_WORK_DIR}/`);
  }
  if (view.cursor === null) failClosed(command, `${view.dir}/run.yml has no cursor`);

  let budget;
  try {
    budget = loadRunBudget(view.dir);
  } catch (error) {
    failClosed(command, error instanceof Error ? error.message : String(error));
  }
  if (budget === null) failClosed(command, `${view.dir}/budget.yml is missing or unreadable`);

  // Read before the estimate: an attended run's developer turns are paid by the
  // host session, so they are not in the number this gate reasons about (#22 (c)).
  const attended = isAttendedByHostView(view);
  const stage = cursorStage(view);
  const declared = stage?.budget_usd ?? stageBudgetFromLibrary(root, view.cursor.stage);
  // The cursor stage's own tuning (gh #214, gh #333), resolved the way `tldrx
  // next`'s brake resolves it. TOLERANT — an unreadable preset gives the shipped
  // defaults — and already on a PreToolUse path: `dod-gate` resolves the same
  // function.
  const tuning = buildStageDefaults(root, view.scope, view.cursor.stage);
  const attempts = tuning.attempts;
  // Not the stage's price — what is LEFT to dispatch under it. On a Build stage
  // whose plan is on disk this shrinks as stories settle; everywhere else it IS
  // the declared price and this hook behaves exactly as it did (design §E.2).
  // Reading files is safe here: `remainingWork` is TOTAL — an unreadable plan
  // comes back as the declared price, which is what this hook used before.
  const work = declared === null ? null : remainingWork({
    runDir: view.dir,
    phaseId: view.cursor.phase,
    stageBudgetUsd: declared,
    stageSpentUsd: stage?.cost_usd ?? 0,
    perAgentMaxUsd: budget.per_agent_max_usd,
    maxUsd: null,
    economy: economyFor(budget, view.cursor.phase),
    attended,
    attempts,
    // gh #333: `reviewer_share`, `story_cap_multiplier` and `story_cap_floor_usd`
    // used to be defaulted here even when the stage declared its own, which
    // over-priced (or under-priced) exactly the way `attempts` did before #214 —
    // denying a `tldrx next` the brake itself allows.
    reviewerShare: tuning.reviewerShare,
    storyCapMultiplier: tuning.storyCapMultiplier,
    storyCapFloorUsd: tuning.storyCapFloorUsd,
  });
  const estimate = estimateFor(command, work === null ? null : work.usd);
  if (estimate <= 0) return; // nothing declared to spend; nothing to refuse

  // Both economies, and who is driving, said out loud before any decision
  // (issue #22). This changes no verdict — it is the data a verdict is read
  // against, and it used to be invisible: `tasks[]` was never parsed, so a run
  // whose turns a host session paid for reported `$0.00` and nothing else.
  const economies = renderRunEconomies(view);
  const spend = runSpend(view);

  // A ceiling that is not in dollars cannot deny a dollar spend (design §E.2).
  // The hook says so on stderr and allows: the refusal that matters for a
  // `host-tokens` phase is `tldrx next`'s own, which stops the spawn outright
  // rather than measuring it against the wrong unit.
  if (isHostTokens(budget, view.cursor.phase)) {
    // ONE comparison in this file has the same unit on both sides: declared
    // `tokens:` against a ceiling that IS a token allowance (issue #22, owner
    // decision 2026-09-01, policy (b)). It warns. It stops only when the operator
    // asked for that with `on_host_tokens_exceed: block`, and never on an attended
    // run, whose spawns this framework does not make (policy (a)).
    const tokens = wouldExceedHostTokens(budget, view.cursor.phase, hostTokensIn(view, view.cursor.phase));
    const over = tokens !== null && tokens.over
      ? ` ${view.cursor.phase} is OVER its host-token ceiling: `
        + `${String(tokens.spent)} declared of ${String(tokens.ceiling)} allowed.`
      : "";
    const stops = tokens !== null && tokens.blocked && !attended;
    if (over !== "") {
      recordBudgetEvent(view, view.cursor.stage, stops ? "budget.blocked" : "budget.warned", {
        phase: view.cursor.phase,
        scope: tokens?.scope ?? "phase",
        economy: "host-tokens",
        attended_by: view.attended_by,
        host_tokens: tokens?.spent ?? 0,
        ceiling_tokens: tokens?.ceiling ?? 0,
        estimate_usd: estimate,
        metered_usd: spend.meteredUsd,
        unmetered_tasks: spend.unmeteredTasks,
      });
    }
    if (stops && tokens !== null) {
      // No `budget raise` here: that command moves DOLLARS, and offering it for a
      // token ceiling would send the operator to fix the wrong number.
      deny(
        `[tldrx] budget-gate: refusing to start stage "${view.cursor.stage}" — phase ${view.cursor.phase} is `
        + `priced in \`host-tokens\` and has declared ${String(tokens.spent)} of ${String(tokens.ceiling)} `
        + "allowed. Raise that phase's ceiling in budget.yml (under this economy the number is a TOKEN "
        + "allowance), or set `on_host_tokens_exceed: warn` to go back to a note."
        + `${economies === null ? "" : `\n${economies}`}`,
      );
    }
    process.stderr.write(
      `tldrx hook budget-gate: ${view.cursor.phase} is priced in \`host-tokens\` — `
      + "no dollar ceiling to enforce here; `tldrx next` refuses a headless spawn on it."
      + over
      + `${economies === null ? "" : ` ${economies}`}\n`,
    );
    return;
  }

  // Priced with the stage's own `attempts` (gh #214). Asked with the shipped 2,
  // an `attempts: 1` stage was reserved a developer turn and a reviewer nobody
  // dispatches, and this gate DENIED a `tldrx next` the brake itself allows.
  const decision = wouldExceed(budget, view.cursor.phase, estimate, attempts);
  if (!decision.blocked) return;

  // `tldrx next` on an `attended_by: host` run exits 4 and spawns nothing, so the
  // dollars this refusal is measured in are spend that provably will not happen
  // (issue #22, owner decision 2026-09-01, policy (a)). The gate INFORMS — every
  // number it would have refused with, plus both economies — and allows. The event
  // says `warned`, not `blocked`, because nothing was blocked.
  if (attended) {
    recordBudgetEvent(view, view.cursor.stage, "budget.warned", {
      phase: view.cursor.phase,
      scope: decision.scope,
      remaining_usd: decision.remaining,
      ceiling_usd: decision.ceiling,
      estimate_usd: decision.estimate,
      economy: economyFor(budget, view.cursor.phase),
      attended_by: view.attended_by,
      metered_usd: spend.meteredUsd,
      host_tokens: spend.hostTokens,
      unmetered_tasks: spend.unmeteredTasks,
    });
    process.stderr.write(
      `tldrx hook budget-gate: ${view.cursor.phase} has $${decision.remaining.toFixed(2)} left of `
      + `$${decision.ceiling.toFixed(2)} and the stage estimate is $${estimate.toFixed(2)} — NOT refusing, `
      + "because this run is attended_by: host and the framework spawns nothing on it."
      + `${economies === null ? "" : ` ${economies}`}\n`,
    );
    return;
  }

  // gh #321: `tldrx run auto` rebalances finished phases IN-PROCESS before it refuses, by
  // default since #330 — so denying its spawn on a phase that move would fund refuses the
  // very launch that fixes it, and the move never gets the chance to run. When the finished
  // phases cover the WHOLE shortfall, under the same rules the loop applies (the donor rules
  // and exact-shortfall-or-nothing of `planRebalance`, `raiseBudget --take-from`'s validation,
  // never past a recorded grant), the gate allows and says why. The hook moves nothing: the
  // move, and its `budget.raised`, are the loop's. Phase scope only — a rebalance never grows
  // the run ceiling. `tldrx next` and `--no-rebalance-finished` are refused exactly as before.
  if (decision.scope === "phase" && RUN_AUTO_RE.test(command) && !NO_REBALANCE_RE.test(command)) {
    const short = shortBy(estimate, decision.remaining);
    const covered = finishedPhasesCover(view.dir, budget, view.cursor.phase, short);
    if (covered !== null) {
      process.stderr.write(
        `tldrx hook budget-gate: ${view.cursor.phase} has $${decision.remaining.toFixed(2)} left of `
        + `$${decision.ceiling.toFixed(2)} and the stage estimate is $${estimate.toFixed(2)} — NOT refusing: `
        + `\`run auto\` rebalances finished phases before it refuses, and ${covered}, which covers the `
        + `$${short.toFixed(2)} shortfall. The loop makes that move on its own record (\`budget.raised\`, `
        + `source: ${REBALANCE_SOURCE}); launch with --no-rebalance-finished to be refused here instead.`
        + `${economies === null ? "" : ` ${economies}`}\n`,
      );
      return;
    }
  }

  new EventLog(join(view.dir, "events.jsonl")).tryAppend({
    ts: nowRfc3339(),
    run: view.run,
    stage: view.cursor.stage,
    type: "budget.blocked",
    actor: `hook:budget-gate`,
    cost_usd: 0,
    payload: {
      phase: view.cursor.phase,
      scope: decision.scope,
      remaining_usd: decision.remaining,
      ceiling_usd: decision.ceiling,
      estimate_usd: decision.estimate,
      blocked_by: currentActor(),
      // What the decision was made against, in both currencies (issue #22). The
      // event is the audit trail, and an audit trail that records only the half
      // of the spend denominated in dollars is how a ledger came to read "$0.00"
      // after real work had been done.
      economy: economyFor(budget, view.cursor.phase),
      attended_by: view.attended_by,
      metered_usd: spend.meteredUsd,
      host_tokens: spend.hostTokens,
      unmetered_tasks: spend.unmeteredTasks,
    },
  });

  deny(budgetGateDeny(
    view.cursor.stage, view.cursor.phase, decision.remaining, decision.ceiling, estimate,
    raiseCommand(view.run, view.cursor.phase, shortBy(estimate, decision.remaining)),
  // Appended only when there IS a second currency or an uncosted turn, so the
  // refusal a plain metered run gets is byte-identical to what it always was.
  ) + (economies === null ? "" : `\n${economies}`));
});

/**
 * One budget event, written the way the deny path writes its own.
 *
 * A separate writer rather than a flag on the existing one: the two callers below
 * record decisions that did NOT stop anything, and the `budget.blocked` payload
 * carries `blocked_by` — the actor a refusal is attributed to. Putting a
 * `blocked_by` on a turn nobody blocked is exactly the kind of ledger entry
 * issue #22 was filed about.
 */
function recordBudgetEvent(
  view: RunView,
  stage: string,
  type: "budget.blocked" | "budget.warned",
  payload: Record<string, unknown>,
): void {
  new EventLog(join(view.dir, "events.jsonl")).tryAppend({
    ts: nowRfc3339(),
    run: view.run,
    stage,
    type,
    actor: "hook:budget-gate",
    cost_usd: 0,
    payload,
  });
}

/**
 * What this invocation could spend, by command.
 *
 * `next` is one stage's ceiling — what it always was. The three the gate could not
 * see before have their own numbers: `run auto` is bounded by `--max-usd` when the
 * operator gave one and otherwise by the WHOLE run ceiling (it is a loop of up to
 * 96 stages), and `expert train` / `seed triage` have documented per-call defaults
 * their own flags override.
 */
function estimateFor(command: string, stageBudget: number | null): number {
  const flagged = Number(MAX_USD_RE.exec(command)?.[1] ?? MAX_BUDGET_RE.exec(command)?.[1] ?? NaN);
  if (/^tldrx run auto\b/.test(command)) {
    return Number.isFinite(flagged) ? flagged : (stageBudget ?? 0);
  }
  if (/^tldrx expert train\b/.test(command)) {
    if (Number.isFinite(flagged)) return flagged;
    return FULL_MODE_RE.test(command) ? DEFAULT_FULL_TRAIN_USD : DEFAULT_TRAIN_USD;
  }
  if (/^tldrx seed triage\b/.test(command)) {
    return Number.isFinite(flagged) ? flagged : DEFAULT_TRIAGE_USD;
  }
  return stageBudget ?? 0;
}

/**
 * What finished phases hold, as `describeRebalance` says it, when `run auto`'s in-process
 * rebalance (gh #314) would cover `shortUsd` for `phaseId` — or null when it would not.
 *
 * Composed from the loop's own pieces rather than re-derived, so the gate and the loop
 * cannot disagree about a donor: `planRebalance` (finished, not stale, metered-usd, no
 * unmetered turn, the whole shortfall or no moves), `applyRebalance` (`raiseBudget
 * --take-from`'s validation) and `raiseGrantVerdict` (no move past a grant, under either
 * `on_grant_exceed`). It reads the FULL run.yml, because a donor's `stale` mark is not in the
 * hooks' tolerant view. Anything unreadable or refused is null, and null DENIES as before:
 * this path may only ever turn a refusal into an allow on evidence it could read.
 */
function finishedPhasesCover(runDir: string, budget: RunBudget, phaseId: string, shortUsd: number): string | null {
  try {
    const doc = parseYaml(readFileSync(join(runDir, "run.yml"), "utf8")) as { phases?: unknown } | null;
    if (doc === null || !Array.isArray(doc.phases)) return null;
    const plan = planRebalance(budget, doc as Pick<RunFile, "phases">, phaseId, shortUsd);
    if (plan.moves.length === 0) return null;
    const applied = applyRebalance(budget, plan);
    if (applied.outcomes.some((outcome) => raiseGrantVerdict(budget, outcome).exceeds)) return null;
    return describeRebalance(plan);
  } catch {
    return null;
  }
}

/**
 * Deny, naming what could not be read. Never called before the command has been
 * identified as a spender inside a tldrx workspace.
 */
function failClosed(command: string, why: string): never {
  deny(
    `[tldrx] budget-gate: refusing \`${command.slice(0, 80)}\` — this gate could not read the budget `
    + `it is supposed to enforce (${why}).\n`
    + "It fails CLOSED: a spend nothing can check is exactly the one that must not start. Fix the run's "
    + "budget.yml, or pass `--run <id>` so the gate knows which run to charge.",
  );
}

/** `--run <id>`, else the run the cwd sits inside, else the newest non-terminal one. */
function resolveRun(root: string, cwd: string, command: string): RunView | null {
  const named = RUN_ARG_RE.exec(command)?.[1];
  if (named !== undefined) {
    const dir = join(root, PROJECT_WORK_DIR, named);
    if (existsSync(dir) && statSync(dir).isDirectory()) return loadRunView(dir);
  }
  const here = locateWork(cwd);
  if (here !== null) {
    const view = loadRunView(here.runDir);
    if (view !== null) return view;
  }
  return newestActiveRun(root);
}

/** `.tldrx/stages/<slug>/stage.yml` `budget_usd`, when run.yml does not carry it. */
function stageBudgetFromLibrary(root: string, stage: string): number | null {
  const path = stageYamlPath(root, stage);
  if (!existsSync(path)) return null;
  try {
    const doc = parseYaml(readFileSync(path, "utf8"));
    const value = (doc as { budget_usd?: unknown } | null)?.budget_usd;
    return typeof value === "number" ? value : null;
  } catch {
    return null;
  }
}

allow();
