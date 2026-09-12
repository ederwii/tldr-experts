/**
 * `tldrx run questions set <stage>:<policy> --note "…"` — the signed upgrade path for
 * a run's frozen `questions_policy` (gh #251), built on `run gates set`'s engine
 * (`setStagePolicy.ts`) so the two verbs cannot drift: one stage per invocation, the
 * policy named outright, a required note, a no-op refused, one
 * `questions.policy_changed` event carrying actor, moment, note and old→new.
 *
 * Why it exists at all: `run new --questions` freezes the map, and a run opened
 * before the flag existed — or opened `human` and then measured to be parking on
 * picks the asker had already written — has no other door. `run.yml` is
 * hand-edit-forbidden (spec §1).
 *
 * It changes who ANSWERS from now on. A question already answered is not re-opened
 * by moving the policy, and a question already parked on is answered on the loop's
 * NEXT look at it (`runAuto`'s awaiting-human branch), not by this command — this
 * signs a policy and writes nothing into any questions file.
 */
import { setStagePolicy, type SetStagePolicyOptions, type SetStagePolicyOutcome } from "./setStagePolicy.ts";
import {
  QUESTION_POLICIES, isQuestionPolicy, questionsPolicyFor, type QuestionPolicy,
} from "./questionsPolicy.ts";

export type SetQuestionsPolicyOptions = SetStagePolicyOptions;
export type SetQuestionsPolicyOutcome = SetStagePolicyOutcome;

export function setQuestionsPolicy(options: SetQuestionsPolicyOptions): SetQuestionsPolicyOutcome {
  return setStagePolicy<QuestionPolicy>(options, {
    verb: "run questions set",
    flag: "questions",
    field: "questions_policy",
    policies: QUESTION_POLICIES,
    isPolicy: isQuestionPolicy,
    policyFor: (run, stageId) => questionsPolicyFor(run.questions_policy, stageId),
    withPolicy: (run, next) => ({ ...run, questions_policy: next }),
    eventType: "questions.policy_changed",
    qualifiedExample: "recommended",
    defaultPolicy: "human",
    noun: "questions",
    noteHint: "why this stage's questions may now be answered that way",
    policyGlossary: "`human` parks the loop and waits for `tldrx answer`; `recommended` lets the loop take a "
      + "question's own `Recommended:` option — never one tagged `irreversible:` or `money:`, and never one "
      + "with no recommendation.",
    subject: (stageId) => `\`${stageId}\` questions policy`,
    nowPhrase: "questions policy is now",
    describe: (policy) => (policy === "human"
      ? ["  it now waits for `tldrx answer` on every open question."]
      : [
        "  the loop may now answer a question that carries its own `Recommended:` line, recording the fact "
          + "as `decided_by: agent-default` with the alternatives beside it and telling the owner through "
          + "`question.auto_answered`; a question with no recommendation, or tagged `irreversible: true` / "
          + "`money: true`, still waits for a person.",
      ]),
    reach: "it changes who may ANSWER this stage's questions from now on; questions already answered are untouched.",
    whereToRead: () => "`run.yml`'s `questions_policy:` is the record; `tldrx run status` does not print it.",
  });
}
