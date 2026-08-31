/**
 * Recording an answer — the ONE implementation.
 *
 * Spec §2.7 defines this for the `answer-capture` hook, and spec §3 gives the
 * terminal the same job under `tldrx answer`. Two implementations would drift, and
 * the drift would be silent: a fact written one way in Claude Code and another way
 * from a shell. So both callers land here.
 *
 * A block is answered iff its metadata says `status: open` AND the `[Answer]:` line
 * has a non-empty capture. For each such block this writes: the answer footer, a
 * `facts.yml` row (`kind: answer`, `confidence: stated`, `source.q`), a
 * `question.answered` event and a `fact.added` event.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { EventLog } from "../events/EventLog.ts";
import { FactsStore } from "../facts/FactsStore.ts";
import { isRetired, MAX_FACT_CHARS } from "../facts/Fact.ts";
import {
  detectAnswered, parseQuestions, recordAnswer, recordSupersession, replaceBlock,
  serializeQuestions, type QuestionsDoc,
} from "../text/questions.ts";
import { factsPath } from "../../hooks/lib/workspace.ts";

export class AnswerError extends Error {}

export interface CaptureContext {
  /** Workspace root — where `.tldrx/memory/facts.yml` lives. */
  readonly root: string;
  /** `tldrx-work/<run>/` — where events.jsonl lives. */
  readonly runDir: string;
  readonly run: string;
  readonly actor: string;
  readonly at: string;
}

export interface CapturedAnswer {
  readonly q: string;
  readonly fact: string;
  readonly answer: string;
  readonly area: string;
}

/** What one `--supersede` did, for the caller to print. */
export interface SupersededAnswer {
  readonly q: string;
  /** The fact the new answer wrote. */
  readonly fact: string;
  /** The fact it replaced — the head of the chain the block's footer names. */
  readonly supersedes: string;
  readonly answer: string;
  readonly area: string;
}

/**
 * What a cut fact ends with, so "there is more of this" is readable and not
 * inferred from the text stopping mid-word.
 */
export const TRUNCATION_MARK = " …";

/**
 * `[assumption]` (inherited from the hook) — the spec stores the answer verbatim
 * but does not say what the fact reads. Taken: "<question> — <answer>", so the fact
 * carries the tokens a later re-ask is matched against.
 *
 * Over `MAX_FACT_CHARS` the text is cut and marked. It used to be cut silently, at
 * 300, and a reader could not tell a short answer from a beheaded one: on the
 * aparece run of 2026-08-30 four of six facts ended mid-clause and the clause that
 * went missing was the one naming the ADR they settle.
 */
export function factTextFor(title: string, answer: string): string {
  const whole = `${title} — ${answer}`;
  if (whole.length <= MAX_FACT_CHARS) return whole;
  return `${whole.slice(0, MAX_FACT_CHARS - TRUNCATION_MARK.length)}${TRUNCATION_MARK}`;
}

/** Whether `factTextFor` had to cut — written onto the row as `truncated: true`. */
export function factWasTruncated(title: string, answer: string): boolean {
  return `${title} — ${answer}`.length > MAX_FACT_CHARS;
}

export function captureAnswers(questionsPath: string, ctx: CaptureContext): readonly CapturedAnswer[] {
  if (!existsSync(questionsPath)) return [];
  let doc: QuestionsDoc = parseQuestions(readFileSync(questionsPath, "utf8"));
  const answered = detectAnswered(doc.blocks);
  if (answered.length === 0) return [];

  const log = EventLog.forRun(ctx.runDir);
  const captured: CapturedAnswer[] = [];

  // Load, append and save inside ONE workspace lock. `nextId()` is `max(id) + 1`
  // off the file, so two `answer` commands racing each other used to mint the
  // same `F001` and the second write erased the first fact (measured 2026-08-29).
  FactsStore.update(factsPath(ctx.root), (store) => {
    for (const block of answered) {
      const area = block.metadata?.area ?? "unscoped";
      const truncated = factWasTruncated(block.title, block.answer);
      const fact = store.append({
        fact: factTextFor(block.title, block.answer),
        ...(truncated ? { truncated: true as const } : {}),
        area,
        repos: [],
        kind: "answer",
        confidence: "stated",
        source: { who: ctx.actor, when: ctx.at, run: ctx.run, q: block.id },
      });
      doc = replaceBlock(doc, recordAnswer(block, { answered_by: ctx.actor, answered_at: ctx.at, fact: fact.id }));
      log.tryAppend({
        ts: ctx.at,
        run: ctx.run,
        stage: null,
        type: "question.answered",
        actor: ctx.actor,
        cost_usd: 0,
        payload: { q: block.id, answer: block.answer, fact: fact.id },
      });
      log.tryAppend({
        ts: ctx.at,
        run: ctx.run,
        stage: null,
        type: "fact.added",
        actor: ctx.actor,
        cost_usd: 0,
        payload: { fact: fact.id, area: fact.area, kind: fact.kind, q: block.id },
      });
      captured.push({ q: block.id, fact: fact.id, answer: block.answer, area });
    }
  });
  writeFileSync(questionsPath, serializeQuestions(doc), "utf8");
  return captured;
}

/**
 * Reverse a decision this question already recorded (spec §2.5's supersede link).
 *
 * The gap this closes, measured 2026-08-31 on a live run: an owner reversed an
 * answered decision after the risk behind it was refuted, `tldrx answer` refused
 * ("Q1 is not an open question"), and `superseded_by` — in the schema since the
 * first draft — had no command that wrote it. The only way through was a hand
 * edit, and a hand edit that left `superseded_by: null` would have left the stale
 * decision in `FactsStore.active`, where facts are never-re-ask truth: every
 * later stage would have reinstated the call the owner had just reversed.
 *
 * Nothing is erased. The old fact keeps its text and gains `superseded_by`; the
 * `[Answer]:` slot keeps the words typed the first time and the block gains a
 * footer; the log gains `fact.added` for the new row and `fact.superseded` for
 * the reversal.
 *
 * The block's footer names the fact the FIRST answer wrote, so the chain is
 * walked to its head before superseding — a second reversal supersedes the
 * second answer, not the first.
 */
export function supersedeAnswer(
  questionsPath: string,
  qid: string,
  text: string,
  ctx: CaptureContext,
): SupersededAnswer {
  if (!existsSync(questionsPath)) throw new AnswerError(`no questions file at ${questionsPath}`);
  const answer = text.trim();
  if (answer === "") throw new AnswerError("a superseding answer cannot be empty");

  const doc = parseQuestions(readFileSync(questionsPath, "utf8"));
  const block = doc.blocks.find((b) => b.id === qid);
  if (block === undefined) throw new AnswerError(`${qid} is not in ${questionsPath}`);
  if (block.metadata?.status !== "answered") {
    throw new AnswerError(
      `${qid} is \`${block.metadata?.status ?? "unknown"}\`, not answered — nothing to supersede. `
      + "Answer it normally: `tldrx answer " + qid + ' "…"`',
    );
  }
  const recorded = block.footer?.fact ?? "";
  if (recorded === "") {
    throw new AnswerError(
      `${qid} is answered but its footer names no fact, so there is nothing to supersede. `
      + "Record the reversal in `.tldrx/memory/facts.yml` by hand, or re-run the stage.",
    );
  }

  const area = block.metadata.area === "" ? "unscoped" : block.metadata.area;
  const truncated = factWasTruncated(block.title, answer);

  const result = FactsStore.update(factsPath(ctx.root), (store): SupersededAnswer => {
    const head = store.headOf(recorded);
    if (head === undefined) {
      throw new AnswerError(`${qid} names fact ${recorded}, which is not in .tldrx/memory/facts.yml`);
    }
    if (isRetired(head)) {
      throw new AnswerError(`${head.id} is retired; a retired fact is not superseded`);
    }
    const fact = store.supersede(head.id, {
      fact: factTextFor(block.title, answer),
      ...(truncated ? { truncated: true as const } : {}),
      area,
      repos: [...head.repos],
      kind: "answer",
      confidence: "stated",
      source: { who: ctx.actor, when: ctx.at, run: ctx.run, q: block.id },
    });
    return { q: block.id, fact: fact.id, supersedes: head.id, answer, area };
  });

  const updated = replaceBlock(doc, recordSupersession(block, answer, {
    reanswered_by: ctx.actor,
    reanswered_at: ctx.at,
    fact: result.fact,
    supersedes: result.supersedes,
  }));
  writeFileSync(questionsPath, serializeQuestions(updated), "utf8");

  const log = EventLog.forRun(ctx.runDir);
  log.tryAppend({
    ts: ctx.at, run: ctx.run, stage: null, type: "fact.added", actor: ctx.actor, cost_usd: 0,
    payload: { fact: result.fact, area: result.area, kind: "answer", q: block.id },
  });
  log.tryAppend({
    ts: ctx.at, run: ctx.run, stage: null, type: "fact.superseded", actor: ctx.actor, cost_usd: 0,
    payload: { q: block.id, fact: result.fact, supersedes: result.supersedes, answer },
  });
  return result;
}

/**
 * Fill one `[Answer]:` slot from the terminal, then let `captureAnswers` do the
 * rest — the CLI writes the same bytes a human editing the file would.
 */
export function writeAnswerSlot(questionsPath: string, qid: string, text: string): void {
  if (!existsSync(questionsPath)) throw new AnswerError(`no questions file at ${questionsPath}`);
  if (text.trim() === "") throw new AnswerError("an answer cannot be empty");

  const doc = parseQuestions(readFileSync(questionsPath, "utf8"));
  const block = doc.blocks.find((b) => b.id === qid);
  if (block === undefined) throw new AnswerError(`${qid} is not in ${questionsPath}`);
  if (block.metadata?.status !== "open") {
    throw new AnswerError(`${qid} is \`${block.metadata?.status ?? "unknown"}\`, not open — answers are recorded once`);
  }
  if (block.answerIndex === -1) throw new AnswerError(`${qid} has no [Answer]: slot`);

  const lines = [...block.lines];
  lines[block.answerIndex] = `[Answer]: ${text.trim()}`;
  writeFileSync(questionsPath, serializeQuestions(replaceBlock(doc, { ...block, lines, answer: text.trim() })), "utf8");
}
