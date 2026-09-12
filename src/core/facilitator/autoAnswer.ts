/**
 * The loop answering a question ITSELF, under `questions_policy: recommended` (gh #251).
 *
 * Measured 2026-09-12, two headless runs at 0.16.1: ten owner questions, nine carrying a
 * `Recommended:` line the asking agent had written. The loop parked on every one, sent a
 * `question.raised`, and the stage waited until a person typed `tldrx answer` — 22 h and
 * 2.5 h of the runs' clocks, with the agents' clock stopped. The pick was on disk, parsed
 * (`RECOMMENDED_RE`), on the decision card and in the notification payload. Nothing acted
 * on it, by design: `waitForAnswers` "reads and does nothing else". This is the one place
 * that does something else, and it is gated three ways — by the run's frozen policy for
 * the CURSOR stage, by the block carrying a pick that names one of its own options, and by
 * the block not being tagged `irreversible:` / `money:`.
 *
 * ## The same door a person uses
 *
 * The answer is `writeAnswerSlot` + `captureAnswers` — literally `tldrx answer`'s path
 * (`src/cli/commands/answer.ts`), so the footer, the fact, `question.answered` and
 * `fact.added` are the bytes a person's answer writes. What differs is on the FACT, where
 * the difference belongs: `decided_by: agent-default` (a third value, never `owner`), the
 * `alternatives` not taken, and the asker's `recommended_why`. A reader of facts.yml alone
 * can see a machine chose, what it chose against, and why it was told to.
 *
 * ## What it refuses to do
 *
 * It never invents a pick: no line, a line naming no option, a pinned block — each is
 * escalated exactly as today, `question.raised` and all. It writes the answer text as the
 * OPTION (`B) drop them — …`), never a bare letter, so the fact carries the words a later
 * re-ask is matched against. And it answers only BLOCKING blocks: an `advisory: true`
 * question was never what the run was parked on.
 *
 * DATA in, per AGENTS §12 — no `ctx`, no session. The caller owns the run and passes the
 * values; this returns what it did, for the loop to say and to notify.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { captureAnswers, writeAnswerSlot, type AnswerOverride } from "../answers/captureAnswers.ts";
import { QUESTION_PHASES } from "../run/questionCards.ts";
import {
  isAdvisory, openBlocks, parseQuestions, pinnedToPerson, recommendedPick, type RecommendedPick,
} from "../text/questions.ts";

/** The decider every auto-answered fact carries (`Fact.ts`, `FACT_DECIDERS`). */
export const AGENT_DEFAULT_DECIDER = "agent-default" as const;

export interface AutoAnswerContext {
  readonly root: string;
  readonly runDir: string;
  readonly runId: string;
  /** Who is running the loop — `source.who` and `answered_by`, as on any `tldrx answer`. */
  readonly actor: string;
  readonly at: string;
  /** Declared workspace repo names, for resolving a question's `affects:`. */
  readonly repoNames: ReadonlySet<string>;
}

/** One question the loop answered, for the stdout line and the notification. */
export interface AutoAnswered {
  readonly q: string;
  readonly title: string;
  /** Run-relative path of the questions file it lives in. */
  readonly file: string;
  readonly pick: RecommendedPick;
  /** The fact id the answer wrote. */
  readonly fact: string;
}

/** A block the loop looked at and left for a person, with why — so the transcript says so. */
export interface AutoEscalated {
  readonly q: string;
  readonly reason: "no recommendation" | "recommendation names no option" | "pinned to a person";
}

export interface AutoAnswerOutcome {
  readonly answered: readonly AutoAnswered[];
  readonly escalated: readonly AutoEscalated[];
}

/**
 * Answer every blocking open question that carries a takeable recommendation, across
 * every phase file of the run, and name the ones left for a person.
 *
 * One file at a time, one block at a time, re-reading the file between blocks: each
 * `captureAnswers` rewrites the whole file, and a second block answered off a stale parse
 * would write over the first block's footer.
 */
export function answerRecommended(ctx: AutoAnswerContext): AutoAnswerOutcome {
  const answered: AutoAnswered[] = [];
  const escalated: AutoEscalated[] = [];
  for (const phase of QUESTION_PHASES) {
    const rel = `${phase}/questions.md`;
    const path = join(ctx.runDir, phase, "questions.md");
    if (!existsSync(path)) continue;
    const ids = blockingIds(path);
    for (const id of ids) {
      // Re-read per block: the previous iteration rewrote this file.
      const block = openBlocks(parseQuestions(readFileSync(path, "utf8")).blocks).find((b) => b.id === id);
      if (block === undefined) continue;
      if (pinnedToPerson(block)) {
        escalated.push({ q: id, reason: "pinned to a person" });
        continue;
      }
      const pick = recommendedPick(block);
      if (pick === null) {
        escalated.push({
          q: id,
          reason: block.recommended === null ? "no recommendation" : "recommendation names no option",
        });
        continue;
      }
      const override: AnswerOverride = {
        decidedBy: AGENT_DEFAULT_DECIDER,
        alternatives: pick.alternatives,
        ...(pick.why === "" ? {} : { recommendedWhy: pick.why }),
      };
      writeAnswerSlot(path, id, `${pick.letter}) ${pick.text}`);
      const captured = captureAnswers(path, {
        root: ctx.root,
        runDir: ctx.runDir,
        run: ctx.runId,
        actor: ctx.actor,
        at: ctx.at,
        overrides: new Map([[id, override]]),
        repoNames: ctx.repoNames,
      });
      const recorded = captured.find((c) => c.q === id);
      // Written but not captured is `tldrx answer`'s own "check the file" case; here it
      // is named as an escalation rather than thrown, so the loop still parks on it
      // and a person sees a block whose slot is filled and whose status is open.
      if (recorded === undefined) {
        escalated.push({ q: id, reason: "recommendation names no option" });
        continue;
      }
      answered.push({ q: id, title: block.title, file: rel, pick, fact: recorded.fact });
    }
  }
  return { answered, escalated };
}

/** The blocking open ids of one file — `blockingQuestionIds`'s rule, on a parsed doc. */
function blockingIds(path: string): readonly string[] {
  try {
    return openBlocks(parseQuestions(readFileSync(path, "utf8")).blocks)
      .filter((block) => !isAdvisory(block))
      .map((block) => block.id);
  } catch {
    return [];
  }
}
