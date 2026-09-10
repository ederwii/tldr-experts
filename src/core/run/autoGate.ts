/**
 * The seven conditions an `auto` gate must satisfy before the facilitator closes
 * it (spec §5, "auto gates").
 *
 * The point of an auto gate is NOT to skip the gate. The stage still ends at one,
 * `gate.requested` is still appended, and the approval still goes through
 * `gates.ts` — what changes is that the harness signs it when, and only when, it
 * can show its work. Every condition is measured off files that already exist:
 *
 *   1. `checks`        — the stage's declared checks, as `next` just ran them
 *   2. `questions`     — open blocks in this phase's questions.md (a stage that
 *                        raises none is silent by right; see `questionsCondition`)
 *   3. `budget`        — the stage's own spend against its ceiling, and the phase's
 *   4. `status`        — the stage did not end `failed`
 *   5. `claim-sources` — the §2.8 handoff validator, run whether or not the stage
 *                        declared it as a check
 *   6. `stories`       — for a Build stage: every story in the plan reached `done`
 *   7. `boundary`      — for a Build stage: the epic branch changed nothing the
 *                        run did not declare it would touch
 *
 * (5) overlaps (1) deliberately. `claim-sources` is the one validator that decides
 * whether the artefact a human would have READ is sourced at all, and a stage file
 * that forgot to list it must not thereby buy itself a cheaper gate.
 *
 * (6) and (7) are the two that ask about the WORK rather than the artefact: did
 * it finish, and was it the work we scoped. Both are `n/a` outside Build, where
 * there is no plan to have finished and no epic branch to diff.
 *
 * Every condition is evaluated even after one fails: the note records all seven
 * with their values, because "which of the seven stopped it" is the first
 * question anybody asks and a short-circuit would answer it with silence.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isAdvisory, openBlocks, parseQuestions, unreadableQuestionHeadings } from "../text/questions.ts";
import { isHostTokens, type RunBudget } from "../budget/RunBudget.ts";
import { epicOnlyCount, notedCount, runCheck, runChecks, unverifiedCount, type CheckOutcome } from "./checks.ts";
import { BUILD_PHASE } from "./buildProgress.ts";
import { storiesView } from "./runOutcome.ts";
import { evaluateBoundary } from "./boundary.ts";
import { loadWorkflowPreset, PresetError, type PlannedStage } from "./workflowPreset.ts";
import type { RunFile, RunStage } from "./RunFile.ts";

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
  /** The note recorded on the gate: all seven conditions and their values. */
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
    storiesCondition(input),
    await boundaryCondition(input),
  ];
  const failed = conditions.filter((condition) => !condition.ok);
  return {
    ok: failed.length === 0,
    conditions,
    note: `auto-gate: ${conditions.map(render).join("; ")}`,
    why: failed.map(render).join("; "),
  };
}

/**
 * The ids of the conditions that did NOT hold, in evaluation order — what the
 * `gate.requested` event carries as `held_by` (gh #203).
 *
 * Ids, not sentences: `why` already carries the measured sentences, and a consumer
 * that wants to branch on WHICH condition held a gate should not have to parse
 * English to do it. The two travel together and are derived from the one verdict, so
 * they cannot disagree.
 */
export function heldBy(verdict: AutoGateVerdict): readonly string[] {
  return verdict.conditions.filter((condition) => !condition.ok).map((condition) => condition.id);
}

/**
 * The same seven conditions, re-measured for a gate that is ALREADY pending (gh #203).
 *
 * `evaluateAutoGate` is handed everything by `tldrx next`, which has just run the
 * stage and still holds its plan and the check outcomes it took moments ago. A poller
 * has none of that — and an `auto` gate held only by open questions used to degrade
 * permanently into a `human` one because nothing ever asked the question again once
 * the answers landed. This rebuilds the input off disk, exactly the way `approve`
 * rebuilds its own: the run's frozen scope resolves the preset, and the stage's
 * declared checks are re-run against what is on disk right now.
 *
 * Null — never a pass — when the preset, the phase or the stage cannot be resolved. A
 * verdict nobody could measure is absent with a reason, and the caller keeps waiting
 * for a person.
 */
export async function reevaluateAutoGate(input: {
  readonly root: string;
  readonly runDir: string;
  readonly run: RunFile;
  readonly budget: RunBudget;
  readonly stageId: string;
}): Promise<AutoGateVerdict | null> {
  const phase = input.run.phases.find((entry) => entry.stages.some((stage) => stage.id === input.stageId));
  const stage = phase?.stages.find((entry) => entry.id === input.stageId);
  if (phase === undefined || stage === undefined) return null;
  let planned: PlannedStage | undefined;
  try {
    planned = loadWorkflowPreset(input.root, input.run.scope).stages.find((entry) => entry.id === input.stageId);
  } catch (error) {
    if (error instanceof PresetError) return null;
    throw error;
  }
  if (planned === undefined) return null;
  const checks = await runChecks(planned.checks, {
    root: input.root,
    runDir: input.runDir,
    stage: planned,
  });
  return await evaluateAutoGate({
    root: input.root,
    runDir: input.runDir,
    phaseId: phase.id,
    stage,
    planned,
    budget: input.budget,
    checks,
  });
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
 * The reason an auto gate falls to a human when the stage was told to write
 * questions and wrote no file at all. A separate sentence from
 * `NO_PARSEABLE_QUESTIONS` because the two are opposite mistakes with opposite
 * fixes, and telling a stage that raised nothing to "see template" sent the
 * unattended driver of 260902-discovery-pipeline-map hunting for a grammar error
 * in a file that did not exist.
 */
export const MISSING_QUESTIONS =
  "questions.md is a declared output of this stage and was never written — an absent file is not an answer";

/**
 * Zero open questions is an ANSWER, unless the file is unreadable or missing.
 *
 * THREE states, not two (gh #109). Zero parsed blocks used to mean one thing here
 * and it is really three:
 *
 *   **unreadable** — measured 2026-08-29: a stage wrote `### Q1 — …` with a
 *   `**Answer:**` line, following the shipped template rather than the parser's
 *   §2.7 grammar. Zero blocks parsed, "0 open" was recorded as satisfied, and the
 *   gate closed over four unanswered questions. Still refused, by id.
 *
 *   **missing** — the stage was told to write the file and did not. Still
 *   refused: a declared output nobody wrote is not an answer.
 *
 *   **present, readable, and empty of questions** — the GOOD case, and the one
 *   this used to punish. Measured 2026-09-02 on run 260902-discovery-pipeline-map:
 *   a stage that had nothing to ask could never satisfy the condition, so every
 *   clean stage paid for the 2026-08-29 failure. An empty questions.md, or one
 *   holding "none", is a stage saying it needs no decision — which is exactly what
 *   an auto gate exists to close over.
 */
function questionsCondition(runDir: string, phaseId: string, planned: PlannedStage): AutoGateCondition {
  const path = join(runDir, phaseId, "questions.md");
  if (declaresQuestions(planned)) {
    if (!existsSync(path)) {
      return { id: "questions", ok: false, detail: MISSING_QUESTIONS };
    }
    const unreadable = unreadableHeadings(path);
    if (unreadable.length > 0) {
      return { id: "questions", ok: false, detail: `${NO_PARSEABLE_QUESTIONS} (${unreadable.join(", ")})` };
    }
    if (parsedBlocks(path) === 0) {
      return { id: "questions", ok: true, detail: "0 open (questions.md written, none raised)" };
    }
  }
  const open = openQuestions(path);
  // ADVISORY blocks do not count (#169). They are minted by `tldrx answer`'s
  // contradiction check, which is lexical and whose false-positive rate is
  // unmeasured — stopping an unattended run on one would be the very deadlock
  // that check refuses to cause by refusing the answer. Skipped is not hidden:
  // the detail names them, and the run close lists them like any other question.
  const skipped = open.advisory.length === 0
    ? ""
    : ` · ${String(open.advisory.length)} advisory not counted (${open.advisory.join(", ")})`;
  return {
    id: "questions",
    ok: open.blocking.length === 0,
    detail: (open.blocking.length === 0
      ? "0 open"
      : `${String(open.blocking.length)} open (${open.blocking.join(", ")})`) + skipped,
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
  // A phase priced in `host-tokens` has no dollar ceiling for this to check
  // against, and the honest answer is `n/a` — not a comparison between a spend
  // in dollars and a ceiling in tokens, which would be true or false for reasons
  // that have nothing to do with money (design §E.2). The label is what the note
  // records, so a reader can see WHY the condition abstained.
  if (isHostTokens(input.budget, input.phaseId)) {
    return { id: "budget", ok: true, detail: "n/a (host-tokens economy)" };
  }
  const spent = round2(input.stage.tasks.reduce((sum, task) => sum + (task.cost_usd ?? 0), 0));
  const unmetered = input.stage.tasks.filter((task) => task.cost_usd === null).length;
  const phase = input.budget.phases.find((entry) => entry.id === input.phaseId);
  const phaseSpent = phase === undefined ? 0 : phase.spent_usd;
  const phaseCeiling = phase === undefined ? 0 : phase.ceiling_usd;
  const stageOk = spent <= input.stage.budget_usd + 0.001;
  const phaseOk = phase === undefined || phaseSpent <= phaseCeiling + 0.001;
  const phasePart = phase === undefined
    ? `phase ${input.phaseId} not in budget.yml`
    : `phase ${input.phaseId} $${phaseSpent.toFixed(2)} of $${phaseCeiling.toFixed(2)}`;
  // An unmetered turn is NAMED in the note and does not, on its own, refuse the
  // gate. Deliberate, and documented in spec §5: in-session is the mode where the
  // host is already watching its own spend, and blocking every auto gate on the
  // absence of a number the host chose not to pass would make `--commit`
  // unusable. What it must never do is read as "$0.00 — under ceiling, verified".
  const meterPart = unmetered === 0 ? "" : `, ${String(unmetered)} unmetered task(s) not counted`;
  return {
    id: "budget",
    ok: stageOk && phaseOk,
    detail: `$${spent.toFixed(2)} of $${input.stage.budget_usd.toFixed(2)} stage, ${phasePart}${meterPart}`,
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
  // An UNCHECKED ABSENCE is not one of those (gh #110). `absent:` over a path that
  // exists with content is `noted`, not `unverified`: it is the framework's own
  // spelling of "I looked and there is nothing recorded", and blocking on it
  // penalised exactly the state-the-negative-case discipline the mandate asks
  // for. It does not refuse the gate — and it is carried into the gate note by
  // name, so `claim-sources` and this condition say the same words about the same
  // file instead of one waving it through while the other refuses it.
  const absences = notedCount(outcome);
  // The same rule for the same reason, one category over (gh #140): a `file`
  // citation that resolves ONLY on this run's unmerged epic ref is `ok` and does
  // not refuse the gate, and the branch it resolved on is carried into the note
  // by name. Reading only `absences` here is how the first pass at #140 left the
  // annotation in the check's detail and out of the sentence a person actually
  // reads when a stage signs itself: `claim-sources=passed`, in full.
  const unmerged = epicOnlyCount(outcome);
  if (outcome.status === "passed") {
    return {
      id: "claim-sources",
      ok: true,
      detail: absences === 0 && unmerged === 0 ? "passed" : `passed, ${outcome.detail}`,
    };
  }
  return { id: "claim-sources", ok: true, detail: `${outcome.status}: ${outcome.detail}` };
}

/**
 * The line a Build stage's auto gate is refused on, verbatim. It is what the
 * operator reads and what the tests assert.
 */
export const UNFINISHED_STORIES =
  "a build stage self-signs only when every story is `done` — a human decides whether to ship over these";

/** At most this many story ids are named before the detail says "+N more". */
const NAMED_STORIES = 8;

/**
 * A Build stage does not sign its own gate over stories that are not `done`.
 *
 * The other five conditions are all about the ARTEFACT: are its citations real,
 * are its questions answered, did it stay inside its money. None of them looks at
 * what the stage was for. Measured 2026-08-30 on run
 * `260830-tenancy-identity-customers`: six of seven stories settled `blocked`
 * with zero commits between them, the epic tip carried one story's work, and the
 * auto gate signed the stage — twice, re-signing after a human revoked it —
 * because `claim-sources` passed, `questions` was empty and the spend was under
 * the ceiling. Every measured condition was true and the stage had not been built.
 *
 * A HUMAN may still approve over blocked stories; that is a judgement about what
 * is worth shipping, and it is theirs. The machine has no basis for it.
 *
 * Read where the state actually lives — the story files, via `buildProgress` —
 * and only for the Build phase: `03-plan/waves.yml` exists while the PLAN stage
 * is gating too, and every story is `todo` at that moment by design.
 */
function storiesCondition(input: AutoGateInput): AutoGateCondition {
  if (input.phaseId !== BUILD_PHASE) return { id: "stories", ok: true, detail: "n/a (not a build stage)" };
  // ONE derivation (§7). This condition used to count the stories itself, and it
  // was the only thing in the framework that did — which is exactly why a
  // `human` Build gate carried no counts at all and an owner approved two runs
  // that delivered nothing (#210). The counting now lives in `runOutcome.ts`,
  // where the gate event, the notification, `run.yml`'s `outcome:` and the ship
  // refusal all read it too; the WORDS below are still this condition's own.
  const view = storiesView(input.runDir);
  if (view === null) return { id: "stories", ok: true, detail: "n/a (no plan to build)" };

  const counted = `${String(view.counts.done)} of ${String(view.counts.total)} done`;
  if (view.unfinished.length === 0) return { id: "stories", ok: true, detail: counted };

  const named = view.unfinished.slice(0, NAMED_STORIES).map((story) => `${story.id}:${story.status}`);
  const rest = view.unfinished.length - named.length;
  return {
    id: "stories",
    ok: false,
    detail: `${counted} — ${named.join(", ")}${rest > 0 ? `, +${String(rest)} more` : ""}; ${UNFINISHED_STORIES}`,
  };
}

/**
 * Condition 7 — the work stayed inside the surface the run declared.
 *
 * The derivation, the diff and every honest `n/a` live in `boundary.ts`; this is
 * the adapter that gives the verdict an `id`. Kept thin on purpose: the shape of
 * a condition is this file's business and how a boundary is measured is not.
 */
async function boundaryCondition(input: AutoGateInput): Promise<AutoGateCondition> {
  const verdict = await evaluateBoundary({
    root: input.root,
    runDir: input.runDir,
    phaseId: input.phaseId,
  });
  return { id: "boundary", ...verdict };
}

/**
 * Open question ids, split into the ones that BLOCK this gate and the ones that
 * were raised as advisory (#169).
 *
 * Both halves come back, because the gate has to say what it did not count: a
 * condition reporting "0 open" over a question that exists on disk would be the
 * quiet kind of pass this file was rewritten to stop producing (#109).
 */
function openQuestions(path: string): { blocking: readonly string[]; advisory: readonly string[] } {
  if (!existsSync(path)) return { blocking: [], advisory: [] };
  try {
    const open = openBlocks(parseQuestions(readFileSync(path, "utf8")).blocks);
    return {
      blocking: open.filter((block) => !isAdvisory(block)).map((block) => block.id),
      advisory: open.filter((block) => isAdvisory(block)).map((block) => block.id),
    };
  } catch {
    // An unparseable questions.md is not "no open questions" — it is a file nobody
    // can read, and that is exactly when a person should look at it.
    return { blocking: ["(questions.md does not parse)"], advisory: [] };
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
