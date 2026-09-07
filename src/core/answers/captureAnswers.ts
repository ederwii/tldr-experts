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
import { isRetired, MAX_FACT_CHARS, type FactDecider } from "../facts/Fact.ts";
import {
  detectAnswered, parseQuestions, recordAnswer, recordSupersession, replaceBlock,
  serializeQuestions, type QuestionBlock, type QuestionsDoc,
} from "../text/questions.ts";
import { factsPath } from "../../hooks/lib/workspace.ts";
import { declaredAffects, stampSuperseded } from "./stampSuperseded.ts";
import { reposFromAffects } from "./reposFromAffects.ts";

export class AnswerError extends Error {}

/**
 * Provenance the INVOCATION named, for ONE question.
 *
 * Per-question and never per-context, because `captureAnswers` sweeps every
 * answered-but-uncaptured block in the file (`detectAnswered`, the loop below) —
 * including one a human filled in by hand before the command ran. Stamping those
 * with what the operator said about a different question is the same lie the
 * flags exist to prevent.
 */
export interface AnswerOverride {
  readonly decidedBy?: FactDecider;
  /** Explicit `--repo` values. Wins over the question's `affects:`. */
  readonly repos?: readonly string[];
}

/**
 * What one block's provenance comes to — the ONE place the three signals are combined.
 *
 * Extracted in fix round 1 because the triple (the `overrides` lookup, the
 * `affects:` resolution, the conditional `decided_by`) stood twice, at the capture
 * loop and again in `supersedeAnswer`, and the next change to this file adds a
 * FOURTH field to both. Written once, it is written once.
 *
 * DATA in, per AGENTS §12 — a block, two lookup tables and the repos to fall back
 * on. No `ctx`, no session, nothing mutable: the caller owns the state and passes
 * the values.
 */
export interface AnswerProvenance {
  /** What the fact binds to: `--repo`, else the question's `affects:`, else `fallbackRepos`. */
  readonly repos: readonly string[];
  /** `affects:` entries shaped `repo:path` whose prefix names no workspace repo. */
  readonly unresolved: readonly string[];
  /**
   * Spread into a `FactSource`. `{}` when the invocation stated nothing — absence
   * is recorded as absence, and means "not stated", never "owner" (`Fact.ts:36`).
   */
  readonly source: { readonly decided_by?: FactDecider };
}

export function answerProvenance(
  block: QuestionBlock,
  overrides: ReadonlyMap<string, AnswerOverride> | undefined,
  repoNames: ReadonlySet<string> | undefined,
  fallbackRepos: readonly string[],
): AnswerProvenance {
  const override = overrides?.get(block.id);
  const named = reposFromAffects(declaredAffects(block), repoNames ?? new Set());
  // Precedence, most specific first: what THIS invocation said, then what the
  // question itself declares, then whatever the caller says to fall back on
  // (nothing on the capture path; the superseded fact's own repos on the other).
  const repos = override?.repos
    ?? (named.repos.length > 0 ? named.repos : fallbackRepos);
  return {
    repos,
    unresolved: named.unresolved,
    source: override?.decidedBy === undefined ? {} : { decided_by: override.decidedBy },
  };
}

export interface CaptureContext {
  /** Workspace root — where `.tldrx/memory/facts.yml` lives. */
  readonly root: string;
  /** `tldrx-work/<run>/` — where events.jsonl lives. */
  readonly runDir: string;
  readonly run: string;
  readonly actor: string;
  readonly at: string;
  /**
   * Keyed by question id. A block not in the map is recorded exactly as it was
   * before this key existed — which is what the `answer-capture` hook passes,
   * because it cannot tell an agent's Write from a human's edit.
   */
  readonly overrides?: ReadonlyMap<string, AnswerOverride>;
  /**
   * Declared workspace repo names, for resolving a question's `affects:`.
   * Absent means no `affects:` entry can be resolved, so `repos` stays `[]` —
   * exactly today's behaviour, and it hides nothing.
   */
  readonly repoNames?: ReadonlySet<string>;
}

export interface CapturedAnswer {
  readonly q: string;
  readonly fact: string;
  readonly answer: string;
  readonly area: string;
  /** `affects:` entries shaped `repo:path` whose prefix names no workspace repo. */
  readonly unresolvedAffects: readonly string[];
}

/**
 * `"<Qid>: affects: <entry> names no repo in this workspace — it scoped nothing"`
 * for every unresolved entry across every captured block.
 *
 * ONE rendering with two callers — `tldrx answer` prints it on stdout, and the
 * `answer-capture` hook says the same thing through `postContext`, which is its
 * only channel to the operator. A second spelling would be the only bug either
 * could have. It lives here, in the module that owns `CapturedAnswer`, rather
 * than in the command: a hook reaching into `src/cli/` for a sentence would put
 * the whole command surface in the hook bundle.
 *
 * Structurally typed on purpose — it takes anything carrying `q` and
 * `unresolvedAffects`, which is both `CapturedAnswer` and `SupersededAnswer`.
 */
export function unresolvedEntries(
  captured: readonly { readonly q: string; readonly unresolvedAffects: readonly string[] }[],
): readonly string[] {
  return captured.flatMap((c) => c.unresolvedAffects.map(
    (entry) => `${c.q}: affects: ${entry} names no repo in this workspace — it scoped nothing`,
  ));
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
  /** `affects:` entries shaped `repo:path` whose prefix names no workspace repo. */
  readonly unresolvedAffects: readonly string[];
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
  // Blocks paired with the fact they wrote, so the earlier phase documents each
  // one overtakes can be stamped once the facts file is closed (gh #104).
  const recorded: { block: QuestionBlock; fact: string }[] = [];

  // Load, append and save inside ONE workspace lock. `nextId()` is `max(id) + 1`
  // off the file, so two `answer` commands racing each other used to mint the
  // same `F001` and the second write erased the first fact (measured 2026-08-29).
  FactsStore.update(factsPath(ctx.root), (store) => {
    for (const block of answered) {
      const area = block.metadata?.area ?? "unscoped";
      const truncated = factWasTruncated(block.title, block.answer);
      // Nothing to fall back on here: a first answer binds to what was stated or
      // to nothing, and `[]` means "no repo was named", never the run's repos.
      const prov = answerProvenance(block, ctx.overrides, ctx.repoNames, []);
      const fact = store.append({
        fact: factTextFor(block.title, block.answer),
        ...(truncated ? { truncated: true as const } : {}),
        area,
        repos: prov.repos,
        kind: "answer",
        confidence: "stated",
        source: { who: ctx.actor, when: ctx.at, run: ctx.run, q: block.id, ...prov.source },
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
      captured.push({
        q: block.id, fact: fact.id, answer: block.answer, area,
        unresolvedAffects: prov.unresolved,
      });
      recorded.push({ block, fact: fact.id });
    }
  });
  writeFileSync(questionsPath, serializeQuestions(doc), "utf8");
  for (const item of recorded) {
    markSuperseded(log, ctx, questionsPath, item.block, item.fact);
  }
  return captured;
}

/**
 * Stamp the earlier-phase documents this answer overtook, and say so in the log
 * (gh #104).
 *
 * Outside the facts lock on purpose: the write is append-only and touches nothing
 * `FactsStore` owns, and holding a workspace-wide lock across an arbitrary number
 * of document writes would serialise far more than it protects.
 *
 * A failure here never fails the answer. The fact is recorded, the question is
 * closed, the events are written — an unwritable phase document is a worse
 * document, not a lost decision, and throwing would strand the questions file
 * half-processed. It is not silent either: `stamp.failed` is not an event type, so
 * the honest place for it is `error`, which `tldrx replay` renders.
 */
function markSuperseded(
  log: EventLog,
  ctx: CaptureContext,
  questionsPath: string,
  block: QuestionBlock,
  fact: string,
): void {
  try {
    for (const doc of stampSuperseded(ctx.runDir, questionsPath, block, fact, ctx.at)) {
      log.tryAppend({
        ts: ctx.at,
        run: ctx.run,
        stage: null,
        type: "doc.superseded",
        actor: ctx.actor,
        cost_usd: 0,
        payload: { doc: doc.rel, fact, q: block.id, by: doc.by },
      });
    }
  } catch (error) {
    log.tryAppend({
      ts: ctx.at,
      run: ctx.run,
      stage: null,
      type: "error",
      actor: ctx.actor,
      cost_usd: 0,
      payload: {
        message: `could not stamp the documents ${block.id} supersedes: `
          + (error instanceof Error ? error.message : String(error)),
        q: block.id,
        fact,
      },
    });
  }
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
    // A supersession is a NEW decision and may legitimately rescope, so it takes
    // the same precedence as a first answer — `--repo`, else the question's own
    // `affects:` — and only falls back to inheriting what the fact it replaces
    // bound to. Inheritance is the floor, not the rule: until fix round 1 the
    // `affects:` half was computed here and thrown away, so a question that said
    // which repo it was about was ignored the moment its answer was reversed.
    const prov = answerProvenance(block, ctx.overrides, ctx.repoNames, head.repos);
    const fact = store.supersede(head.id, {
      fact: factTextFor(block.title, answer),
      ...(truncated ? { truncated: true as const } : {}),
      area,
      repos: [...prov.repos],
      kind: "answer",
      confidence: "stated",
      source: { who: ctx.actor, when: ctx.at, run: ctx.run, q: block.id, ...prov.source },
    });
    return {
      q: block.id, fact: fact.id, supersedes: head.id, answer, area,
      unresolvedAffects: prov.unresolved,
    };
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
  // A reversal overtakes the same earlier documents an answer does — more of them,
  // if anything, since by now those documents have been built on (gh #104).
  markSuperseded(log, ctx, questionsPath, block, result.fact);
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
