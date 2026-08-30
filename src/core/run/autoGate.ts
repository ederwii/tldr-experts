/**
 * The five conditions an `auto` gate must satisfy before the facilitator closes it
 * (spec §5, "auto gates").
 *
 * The point of an auto gate is NOT to skip the gate. The stage still ends at one,
 * `gate.requested` is still appended, and the approval still goes through
 * `gates.ts` — what changes is that the harness signs it when, and only when, it
 * can show its work. Every condition is measured off files that already exist:
 *
 *   1. `checks`        — the stage's declared checks, as `next` just ran them
 *   2. `questions`     — open blocks in this phase's questions.md
 *   3. `budget`        — the stage's own spend against its ceiling, and the phase's
 *   4. `status`        — the stage did not end `failed`
 *   5. `claim-sources` — the §2.8 handoff validator, run whether or not the stage
 *                        declared it as a check
 *
 * (5) overlaps (1) deliberately. `claim-sources` is the one validator that decides
 * whether the artefact a human would have READ is sourced at all, and a stage file
 * that forgot to list it must not thereby buy itself a cheaper gate.
 *
 * Every condition is evaluated even after one fails: the note records all five
 * with their values, because "which of the five stopped it" is the first question
 * anybody asks and a short-circuit would answer it with silence.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openBlocks, parseQuestions, unreadableQuestionHeadings } from "../text/questions.ts";
import type { RunBudget } from "../budget/RunBudget.ts";
import { runCheck, unverifiedCount, type CheckOutcome } from "./checks.ts";
import type { PlannedStage } from "./workflowPreset.ts";
import type { RunStage } from "./RunFile.ts";

/** The actor an auto-approved gate is recorded under, in `by:` and in the event. */
export const AUTO_GATE_ACTOR = "auto";

export interface AutoGateCondition {
  readonly id: string;
  readonly ok: boolean;
  /** The measured value, always — a passing condition names its number too. */
  readonly detail: string;
}

export interface AutoGateVerdict {
  readonly ok: boolean;
  readonly conditions: readonly AutoGateCondition[];
  /** The note recorded on the gate: all five conditions and their values. */
  readonly note: string;
  /** Only the conditions that failed, for the "why not" line. Empty when `ok`. */
  readonly why: string;
}

export interface AutoGateInput {
  readonly root: string;
  readonly runDir: string;
  readonly phaseId: string;
  readonly stage: RunStage;
  readonly planned: PlannedStage;
  readonly budget: RunBudget;
  /** The checks `next` ran on this stage, moments ago, off the same disk. */
  readonly checks: readonly CheckOutcome[];
}

export async function evaluateAutoGate(input: AutoGateInput): Promise<AutoGateVerdict> {
  const conditions: AutoGateCondition[] = [
    checksCondition(input.checks),
    questionsCondition(input.runDir, input.phaseId, input.planned),
    budgetCondition(input),
    statusCondition(input.stage),
    await claimSourcesCondition(input),
  ];
  const failed = conditions.filter((condition) => !condition.ok);
  return {
    ok: failed.length === 0,
    conditions,
    note: `auto-gate: ${conditions.map(render).join("; ")}`,
    why: failed.map(render).join("; "),
  };
}

function render(condition: AutoGateCondition): string {
  return `${condition.id}=${condition.detail}`;
}

function checksCondition(checks: readonly CheckOutcome[]): AutoGateCondition {
  if (checks.length === 0) {
    return { id: "checks", ok: true, detail: "none declared" };
  }
  const failed = checks.filter((check) => check.status === "failed");
  return {
    id: "checks",
    ok: failed.length === 0,
    detail: checks.map((check) => `${check.id}:${check.status}`).join(","),
  };
}

/**
 * The reason an auto gate falls to a human when the stage was told to write
 * questions and wrote a file the parser cannot read. Verbatim, because it is what
 * the operator sees and what the tests assert.
 */
export const NO_PARSEABLE_QUESTIONS =
  "questions.md has no parseable question (expected `## Qn · …` + metadata line) — see template";

/**
 * Zero open questions is only an ANSWER when the file could be read.
 *
 * Measured 2026-08-29: a stage that declares `questions.md` as an output wrote
 * `### Q1 — …` with a `**Answer:**` line, following the shipped template rather
 * than the parser's §2.7 grammar. The parser found zero blocks, "0 open" was
 * recorded as satisfied, and the gate closed over four unanswered questions. An
 * empty parse of a file the stage was told to write is silence, not consent.
 */
function questionsCondition(runDir: string, phaseId: string, planned: PlannedStage): AutoGateCondition {
  const path = join(runDir, phaseId, "questions.md");
  if (declaresQuestions(planned)) {
    const unreadable = unreadableHeadings(path);
    if (unreadable.length > 0) {
      return { id: "questions", ok: false, detail: `${NO_PARSEABLE_QUESTIONS} (${unreadable.join(", ")})` };
    }
    if (!existsSync(path) || parsedBlocks(path) === 0) {
      return { id: "questions", ok: false, detail: NO_PARSEABLE_QUESTIONS };
    }
  }
  const open = openQuestions(path);
  return {
    id: "questions",
    ok: open.length === 0,
    detail: open.length === 0 ? "0 open" : `${String(open.length)} open (${open.join(", ")})`,
  };
}

/**
 * True when `stage.yml outputs:` names a questions.md — i.e. the stage was told to
 * PRODUCE one. Deliberately not `questions:`, which only caps how many a stage may
 * ask: a stage that is merely allowed to ask and asks nothing is silent by right,
 * while a stage told to write the file and writing one nothing can read is not.
 */
export function declaresQuestions(planned: PlannedStage): boolean {
  return planned.outputs.some((path) => path.endsWith("questions.md"));
}

/** `## Qn` headings the §2.7 parser cannot read — wrong marker, wrong separator. */
export function unreadableHeadings(path: string): readonly string[] {
  if (!existsSync(path)) return [];
  try {
    return unreadableQuestionHeadings(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
}

function parsedBlocks(path: string): number {
  try {
    return parseQuestions(readFileSync(path, "utf8")).blocks.length;
  } catch {
    return 0;
  }
}

/**
 * Two ceilings, because two exist and they can disagree: the stage's own
 * `budget_usd` (run.yml's scaled mirror of the plan) and the phase ceiling in
 * budget.yml. A stage that came in under its own share but tipped its phase over
 * is not a gate the machine gets to close.
 */
function budgetCondition(input: AutoGateInput): AutoGateCondition {
  const spent = round2(input.stage.tasks.reduce((sum, task) => sum + task.cost_usd, 0));
  const phase = input.budget.phases.find((entry) => entry.id === input.phaseId);
  const phaseSpent = phase === undefined ? 0 : phase.spent_usd;
  const phaseCeiling = phase === undefined ? 0 : phase.ceiling_usd;
  const stageOk = spent <= input.stage.budget_usd + 0.001;
  const phaseOk = phase === undefined || phaseSpent <= phaseCeiling + 0.001;
  const phasePart = phase === undefined
    ? `phase ${input.phaseId} not in budget.yml`
    : `phase ${input.phaseId} $${phaseSpent.toFixed(2)} of $${phaseCeiling.toFixed(2)}`;
  return {
    id: "budget",
    ok: stageOk && phaseOk,
    detail: `$${spent.toFixed(2)} of $${input.stage.budget_usd.toFixed(2)} stage, ${phasePart}`,
  };
}

function statusCondition(stage: RunStage): AutoGateCondition {
  return { id: "status", ok: stage.status !== "failed", detail: stage.status };
}

/**
 * The §2.8 validator, run here whether or not the stage listed it under `checks:`.
 * `skipped` (the stage declares no handoff.md) is a pass — there is no claim to
 * source — and is reported as `skipped` rather than laundered into `passed`.
 */
async function claimSourcesCondition(input: AutoGateInput): Promise<AutoGateCondition> {
  const outcome = await runCheck(
    { id: "claim-sources", on: "post-write", repo: null, command: null, expect_exit: 0 },
    { root: input.root, runDir: input.runDir, stage: input.planned },
  );
  if (outcome.status === "failed") {
    return { id: "claim-sources", ok: false, detail: `failed: ${outcome.detail}` };
  }
  // Zero refused AND zero unverified. A citation nothing could check is exactly
  // the one a person should look at, and it is the only thing standing between
  // an unfetched URL and an automatic signature.
  const unchecked = unverifiedCount(outcome);
  if (unchecked > 0) {
    return {
      id: "claim-sources",
      ok: false,
      detail: `${String(unchecked)} unverified citation(s) — ${outcome.detail}`,
    };
  }
  return {
    id: "claim-sources",
    ok: true,
    detail: outcome.status === "passed" ? "passed" : `${outcome.status}: ${outcome.detail}`,
  };
}

function openQuestions(path: string): readonly string[] {
  if (!existsSync(path)) return [];
  try {
    return openBlocks(parseQuestions(readFileSync(path, "utf8")).blocks).map((block) => block.id);
  } catch {
    // An unparseable questions.md is not "no open questions" — it is a file nobody
    // can read, and that is exactly when a person should look at it.
    return ["(questions.md does not parse)"];
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
