/**
 * `tldrx next --commit --check` — would this `result.json` be read, or refused?
 *
 * The measurement it exists for, taken on a real workspace this week: two reviews
 * were REFUSED at `tldrx next --commit --review` because a `[src: …]` citation in
 * a `refuted` finding was not the last thing on its line. Both refusals were
 * correct and both arrived AFTER the turn had been spent. The host's answer was
 * to ban `refuted` from the next thirty briefs — a protocol feature switched off
 * to dodge a late validator, which is the worst outcome available.
 *
 * The reviewer cannot validate itself: `REVIEWER_TOOLS` is `Read`, `Grep`, `Glob`
 * and `Bash(git diff *)`, so it holds no door to run a checker through, and the
 * grammar it must satisfy is already spelled out in its prompt with a refused and
 * an accepted example per rule (`renderSrcGrammarContract`). What was missing was
 * not the STATEMENT of the rule; it was a way for the author to ask the framework
 * "is this envelope readable?" before saying it is done. That question belongs to
 * the host, and this is it.
 *
 * Everything here READS. There is no write path in this file, no event, no
 * status: `--check` is the one door into `next` that cannot move the run, and the
 * tests assert `run.yml`, the story file and `events.jsonl` byte-identical either
 * side of it.
 *
 * And it validates through the SAME functions `--commit` does — `readResultObject`
 * for "is this a JSON object at all", `parseReview` for a reviewer envelope — so
 * a check that passes and a commit that refuses cannot drift apart. Nothing about
 * the grammar, the dispositions or the verdict enum is restated here.
 */
import { relative } from "node:path";

import { agentDir } from "../facilitator/paths.ts";
import { isResultStringElement, PendingError, readResultObject } from "../facilitator/pending.ts";
import { preparedBundles, reviewBundles } from "../run/prepared.ts";
import { parseReview } from "./review.ts";

/** One bundle `--check` was pointed at, and which contract applies to it. */
export interface BundleUnderCheck {
  /** The `pending.json`'s directory, as `agentDir` keys it (`<stage>[/<story>][/review]`). */
  readonly key: string;
  readonly role: "developer" | "reviewer";
}

export interface ResultCheck {
  /** Would `--commit` read this envelope? False is exit 1 and a printed reason. */
  readonly ok: boolean;
  readonly lines: readonly string[];
}

/**
 * Every bundle of this stage `--check` should look at, in directory order.
 *
 * Discovery is by PRESENCE of a `pending.json`, which is the rule the rest of the
 * framework already encodes — `reviewBundleOut`'s "its presence IS the state" —
 * and both walkers are the ones `preparedRefusal` and `run/waiting.ts` use, called
 * rather than copied. `--parallel N` can leave several developer bundles out at
 * once; all of them are checked, because "which one did you mean" is not a
 * question a read-only command needs to ask.
 */
export function bundlesToCheck(
  runDir: string, stageId: string, review: boolean,
): readonly BundleUnderCheck[] {
  const dirs = review ? reviewBundles(runDir, stageId) : preparedBundles(runDir, stageId);
  const root = agentDir(runDir, "");
  return dirs.map((dir) => ({ key: relative(root, dir), role: review ? "reviewer" : "developer" }));
}

/**
 * The verdict on one bundle's `result.json`.
 *
 * `where` is the bundle directory as the operator will type it — printed on every
 * line, because a `--parallel` run has more than one bundle out and a refusal that
 * does not name its file is a refusal somebody has to go looking for.
 */
export function checkBundleResult(
  runDir: string, bundle: BundleUnderCheck, where: string,
): ResultCheck {
  let envelope: Record<string, unknown>;
  try {
    envelope = readResultObject(runDir, bundle.key);
  } catch (error) {
    if (error instanceof PendingError) return { ok: false, lines: [`${where}: ${error.message}`] };
    throw error;
  }
  return bundle.role === "reviewer"
    ? checkReviewer(envelope, where)
    : checkDeveloper(envelope, where);
}

/**
 * A reviewer envelope, through `parseReview` — the same call `commitReview` makes.
 *
 * `formatProblems` is the index of every refusal that faults the envelope's FORM,
 * and `fixlistProblems` the reasons a DECLARED `fixlist` fell back to `changes`.
 * Both are printed verbatim: each one already names the rule it enforced and, for
 * a citation, quotes the offending line and shows a corrected one (gh #77). This
 * file adding its own wording on top would be the second copy that work abolished.
 */
function checkReviewer(envelope: Record<string, unknown>, where: string): ResultCheck {
  const review = parseReview(envelope, "");
  // `formatProblems` already contains `verdictProblem` when there is one, so the
  // union is deduped: one fault must not read as two.
  const problems = [...new Set([...review.formatProblems, ...review.fixlistProblems])];
  if (problems.length === 0) {
    return {
      ok: true,
      lines: [
        `${where}: reads as \`${review.verdict}\` — \`tldrx next --commit --review\` would accept it`,
      ],
    };
  }
  return {
    ok: false,
    lines: [
      `${where}: this envelope would be REFUSED on its FORM — the judgement in it never`,
      "  reaches the story. What the check said, verbatim:",
      ...problems.map((problem) => `  - ${problem}`),
    ],
  };
}

/**
 * A developer envelope, against what `--commit` actually reads back.
 *
 * The honest answer here is narrower than the reviewer's, and saying so is the
 * point. `readResult` is TOLERANT: absent, unparseable or not-an-object is the
 * only refusal on this path (`readResultObject`, above), and everything after it
 * is coerced — a missing `outputs` reads as `[]`, a non-string `notes` as `""`.
 * So this exits 0 for a coercible file and NAMES what is about to be coerced,
 * rather than inventing a refusal `--commit` would not make. The keys are the ones
 * `readResult` reads, in its own order.
 *
 * The coercion that hides best is the one INSIDE an array. `outputs` and
 * `questions_asked` are declared `items: {type: "string"}`, and the reader's
 * `strings()` FILTERS every element that is not one — so
 * `["good", 42, null, "also-good"]` is an array, satisfies "is it an array", and
 * still reaches the run as two entries. Whole-field typing could not see that, so
 * each surviving element is named here by index and by the JSON of its value,
 * through `isResultStringElement` — the same predicate `strings()` filters on,
 * called rather than restated, so the check cannot name a set the reader does not
 * drop. Exit stays 0: the reader accepts the file, and `--check` names, it never
 * invents a refusal. Nothing citable is lost either — a dropped element is by
 * definition not a string, and a `[src: …]` citation is a token inside a string.
 *
 * `--check` is about the result ENVELOPE, not about the gate behind it: the
 * declared outputs are re-read off disk at `--commit` and the stage's checks run
 * there. A clean check is not a promise the stage will pass.
 */
function checkDeveloper(envelope: Record<string, unknown>, where: string): ResultCheck {
  const coerced: string[] = [];
  for (const field of ["outputs", "questions_asked"] as const) {
    const value = envelope[field];
    if (!Array.isArray(value)) {
      coerced.push(`\`${field}\` is missing or not an array — read as \`[]\``);
      continue;
    }
    for (const [index, element] of (value as unknown[]).entries()) {
      if (isResultStringElement(element)) continue;
      const shown = JSON.stringify(element) ?? "undefined";
      coerced.push(`\`${field}[${index}]\` is not a string (\`${shown}\`) — dropped by the reader`);
    }
  }
  if (typeof envelope.notes !== "string") coerced.push("`notes` is missing or not a string — read as `\"\"`");
  if (envelope.cost_usd !== undefined && typeof envelope.cost_usd !== "number") {
    coerced.push("`cost_usd` is not a number — read as undeclared (`metered: false`), not as $0.00");
  }
  return {
    ok: true,
    lines: coerced.length === 0
      ? [`${where}: reads as a developer envelope — \`tldrx next --commit\` would accept it`]
      : [
        `${where}: \`tldrx next --commit\` would accept this — its reader coerces rather than`,
        "  refuses — but these parts of `result_schema` are not satisfied, so each is read as",
        "  its empty value, or dropped from the array it is in:",
        ...coerced.map((said) => `  - ${said}`),
      ],
  };
}
