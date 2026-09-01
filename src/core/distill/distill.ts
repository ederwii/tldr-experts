/**
 * `tldrx run new --from <aidlc-intent-dir>` — the distill (spec §6).
 *
 * Read-only over the source folder, deterministic, and offline: no LLM decides
 * what survives. What survives is a claim that (a) sits under a heading in a file
 * on the read list, or is an answered question, and (b) does not contradict a
 * non-retired fact. Everything else is counted as dropped and named in the report,
 * because a silent drop is indistinguishable from a bug.
 */
import { readFileSync } from "node:fs";
import { findDuplicate, type DuplicateHit } from "../facts/findDuplicate.ts";
import type { Fact, NewFact } from "../facts/Fact.ts";
import { areaOf, collectReadFiles, slugify } from "./readList.ts";
import { extractProseClaims } from "./markdownClaims.ts";
import { answerText, isAnswered, parseAidlcQuestions } from "./aidlcQuestions.ts";

export const CONFLICT_THRESHOLD = 0.6;

export interface ImportedClaim {
  readonly text: string;
  readonly area: string;
  /** The `[src: …]` token body, e.g. `aidlc:ideation/x/intent-statement.md:12`. */
  readonly src: string;
  /** Source file, relative to the intent dir. */
  readonly file: string;
  /** The AI-DLC question id when this claim came from an answer, else null. */
  readonly q: string | null;
  /**
   * What the conflict check compares — the QUESTION for an answer, the claim
   * itself for prose.
   *
   * Split from `text` when answers stopped being stored as a bare letter (gh #18).
   * `findDuplicate` is Jaccard over ≥4-char tokens, so it is length-sensitive:
   * against a recorded fact, "… backend? — B, a separate service" scored 0.78
   * while the same answer written out in full scored ~0.22 and the contradiction
   * went undetected. The question is what the two facts disagree ABOUT, and it is
   * what `hooks/no-reask.ts:54` already matches on.
   */
  readonly match: string;
}

export interface Conflict {
  readonly claim: ImportedClaim;
  readonly factId: string;
  readonly factText: string;
  readonly score: number;
}

export interface DistillContext {
  readonly run: string;
  readonly actor: string;
  readonly at: string;
  /** Non-retired facts the import is checked against. */
  readonly facts: readonly Fact[];
}

export interface DistillResult {
  readonly intentDir: string;
  readonly filesRead: readonly string[];
  /** Everything imported, in read order. */
  readonly claims: readonly ImportedClaim[];
  /** Facts to append, one per imported answer (spec §6). Parallel to `answerClaims`. */
  readonly facts: readonly NewFact[];
  readonly conflicts: readonly Conflict[];
  readonly droppedUnanswered: number;
  readonly droppedConflicting: number;
  /** Relative file -> how many claims it contributed. */
  readonly perFile: ReadonlyMap<string, number>;
}

export function distill(intentDir: string, ctx: DistillContext): DistillResult {
  const files = collectReadFiles(intentDir);
  const claims: ImportedClaim[] = [];
  const facts: NewFact[] = [];
  const conflicts: Conflict[] = [];
  const perFile = new Map<string, number>();
  let droppedUnanswered = 0;
  let droppedConflicting = 0;

  const keep = (claim: ImportedClaim): boolean => {
    const hit = conflictOf(claim, ctx.facts);
    if (hit === null) return true;
    conflicts.push({ claim, factId: hit.fact.id, factText: hit.fact.fact, score: hit.score });
    droppedConflicting++;
    return false;
  };

  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file.abs, "utf8");
    } catch {
      continue;
    }
    let kept = 0;

    if (file.kind === "questions") {
      for (const question of parseAidlcQuestions(text)) {
        if (!isAnswered(question)) {
          droppedUnanswered++;
          continue;
        }
        const claim: ImportedClaim = {
          // `answerText`, not `question.answer`: a bare option letter is a pointer
          // into a file this import does not own, and the fact outlives it (gh #18).
          text: `${question.title} — ${answerText(question)}`,
          area: areaOf(file.rel),
          src: `aidlc:${file.rel}#${question.id}`,
          file: file.rel,
          q: question.id,
          match: question.title,
        };
        if (!keep(claim)) continue;
        claims.push(claim);
        kept++;
        facts.push({
          fact: claim.text,
          area: claim.area,
          repos: [],
          kind: "answer",
          confidence: "stated",
          source: { who: ctx.actor, when: ctx.at, run: ctx.run, q: question.id },
        });
      }
    } else {
      for (const prose of extractProseClaims(text)) {
        const claim: ImportedClaim = {
          text: prose.text,
          area: slugify(prose.heading),
          src: `aidlc:${file.rel}:${prose.line}`,
          file: file.rel,
          q: null,
          match: prose.text,
        };
        if (!keep(claim)) continue;
        claims.push(claim);
        kept++;
      }
    }
    perFile.set(file.rel, kept);
  }

  return {
    intentDir,
    filesRead: files.map((f) => f.rel),
    claims,
    facts,
    conflicts,
    droppedUnanswered,
    droppedConflicting,
    perFile,
  };
}

/**
 * A claim contradicts a fact when they are about the same `area`, overlap at
 * Jaccard ≥ 0.6, and are not the same sentence (spec §6 / §4's re-ask rule reused).
 * Identical text is agreement, not contradiction — it is imported and left alone.
 */
export function conflictOf(claim: ImportedClaim, facts: readonly Fact[]): DuplicateHit | null {
  const hit = findDuplicate(claim.match, claim.area, facts, CONFLICT_THRESHOLD);
  if (hit === null) return null;
  return hit.fact.fact.trim() === claim.text.trim() ? null : hit;
}

export function claimsFrom(result: DistillResult, files: readonly string[]): readonly ImportedClaim[] {
  const wanted = new Set(files);
  return result.claims.filter((c) => wanted.has(basenameOf(c.file)));
}

function basenameOf(rel: string): string {
  return rel.split("/").pop() ?? rel;
}
