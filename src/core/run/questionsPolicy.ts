/**
 * Who answers a stage's open questions when `run auto` parks on them: a person, or
 * the asker's own recommendation (spec §2.2 `questions_policy`, gh #251).
 *
 * `gates_policy` says who CLOSES a gate; this says who ANSWERS a question, and it is
 * built the same way — a closed pair of words, resolved per stage at `run new` from
 * `--questions` and frozen into `run.yml`, so a run keeps the policy it was opened
 * with. `tldrx run questions set` is the signed way to move it afterwards.
 *
 * `human` is today's behaviour and the default everywhere: the loop parks, sends
 * `question.raised`, and waits for `tldrx answer`. `recommended` lets the loop take
 * the answer path ITSELF — but only for a block that carries a `Recommended:` line
 * naming one of its own options, and never for one tagged `irreversible: true` or
 * `money: true` (`questions.ts`, `pinnedToPerson`). Everything else escalates exactly
 * as under `human`. The measurement that asked for it: 9 of 10 owner stops across two
 * headless runs, 2026-09-12, were over a pick the asker had already written down.
 *
 * Absence means `human`, everywhere: a `run.yml` written before this key existed, a
 * run opened without the flag, a stage the map does not name. The safe default is the
 * one that stops.
 */
import type { ValidationIssue } from "../schemas/validation.ts";
import { parseStagePolicyFlag, validateStagePolicy } from "./stagePolicy.ts";

export const QUESTION_POLICIES = ["human", "recommended"] as const;
export type QuestionPolicy = (typeof QUESTION_POLICIES)[number];

/** Stage id -> who answers its questions. */
export type QuestionsPolicy = Readonly<Record<string, QuestionPolicy>>;

export class QuestionsPolicyError extends Error {}

export function isQuestionPolicy(value: unknown): value is QuestionPolicy {
  return typeof value === "string" && (QUESTION_POLICIES as readonly string[]).includes(value);
}

/**
 * `--questions <entry,entry|all|none>` — the LIST is the stages a PERSON answers.
 *
 * `--gates`' grammar exactly (`stagePolicy.ts`): a bare entry (`plan`) is `human`, a
 * qualified one (`plan:recommended`) names the policy outright, `all` is every stage
 * human (the default, spelled out) and `none` is every stage recommended. An empty
 * value is refused rather than read as `none`, for the same reason `--gates ""` is:
 * a shell variable that did not expand must not remove every person from the loop.
 */
export function parseQuestionsFlag(raw: string, stageIds: readonly string[]): QuestionsPolicy {
  return parseStagePolicyFlag(raw, stageIds, {
    flag: "questions",
    policies: QUESTION_POLICIES,
    bare: "human",
    all: "human",
    none: "recommended",
    emptyHint: "a comma-separated list of the stages a PERSON answers (`plan`) or of qualified "
      + "entries (`plan:recommended`), or `all`, or `none`",
    error: QuestionsPolicyError,
  });
}

/** Who answers this stage's questions. Absent policy, absent stage: a human. */
export function questionsPolicyFor(policy: QuestionsPolicy | undefined, stageId: string): QuestionPolicy {
  return policy?.[stageId] ?? "human";
}

/** `run.yml`'s optional `questions_policy:` block (spec §2.2). */
export function validateQuestionsPolicy(
  value: unknown,
  stageIds: readonly string[],
  issues: ValidationIssue[],
): void {
  validateStagePolicy(value, stageIds, issues, { field: "questions_policy", policies: QUESTION_POLICIES });
}
