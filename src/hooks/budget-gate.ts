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
import { loadRunView, newestActiveRun, cursorStage, type RunView } from "./lib/runFile.ts";
import { budgetGateDeny } from "./lib/messages.ts";
import { currentActor, nowRfc3339 } from "./lib/actor.ts";
import { loadRunBudget } from "../core/budget/loadBudget.ts";
import { economyFor, isHostTokens } from "../core/budget/RunBudget.ts";
import { remainingWork } from "../core/budget/remainingWork.ts";
import { wouldExceed } from "../core/budget/wouldExceed.ts";
import { raiseCommand, shortBy } from "../core/budget/budgetView.ts";
import { EventLog } from "../core/events/EventLog.ts";
import { parseYaml } from "../core/yaml.ts";
import { PROJECT_WORK_DIR } from "../core/paths.ts";

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

/** The default ceiling each non-`next` spender uses when it is given no flag. */
const DEFAULT_TRAIN_USD = 2.0;
const DEFAULT_TRIAGE_USD = 1.0;
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

  const stage = cursorStage(view);
  const declared = stage?.budget_usd ?? stageBudgetFromLibrary(root, view.cursor.stage);
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
  });
  const estimate = estimateFor(command, work === null ? null : work.usd);
  if (estimate <= 0) return; // nothing declared to spend; nothing to refuse

  // A ceiling that is not in dollars cannot deny a dollar spend (design §E.2).
  // The hook says so on stderr and allows: the refusal that matters for a
  // `host-tokens` phase is `tldrx next`'s own, which stops the spawn outright
  // rather than measuring it against the wrong unit.
  if (isHostTokens(budget, view.cursor.phase)) {
    process.stderr.write(
      `tldrx hook budget-gate: ${view.cursor.phase} is priced in \`host-tokens\` — `
      + "no dollar ceiling to enforce here; `tldrx next` refuses a headless spawn on it.\n",
    );
    return;
  }

  const decision = wouldExceed(budget, view.cursor.phase, estimate);
  if (!decision.blocked) return;

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
    },
  });

  deny(budgetGateDeny(
    view.cursor.stage, view.cursor.phase, decision.remaining, decision.ceiling, estimate,
    raiseCommand(view.run, view.cursor.phase, shortBy(estimate, decision.remaining)),
  ));
});

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
    return Number.isFinite(flagged) ? flagged : DEFAULT_TRAIN_USD;
  }
  if (/^tldrx seed triage\b/.test(command)) {
    return Number.isFinite(flagged) ? flagged : DEFAULT_TRIAGE_USD;
  }
  return stageBudget ?? 0;
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
