/**
 * Marking a phase document that a later answer overtook (gh #104).
 *
 * A phase document is a point-in-time snapshot. It is written, gated, and then the
 * run carries on — and when an owner answers a question three phases later that
 * flips the design, the document keeps asserting the old one with nothing on the
 * page to say so. Measured on `260830-ordering-inventory`: `03-plan/stories/S4.md`
 * still promised a test named `EveryTransitionPair_ReturnsNone` proving an inert
 * default, after F021 had established Restock for 5 of 64 pairs and the shipped
 * test was a different one; `02-how/design.md` still said "no order_number column
 * is created" after F022 had ordered one. Both flips were in `questions.md`,
 * `facts.yml` and `retro.md`. Neither was in the file a reader opens. The
 * auditor's conclusion — "read 04-build/ rather than 03-plan/ for what actually
 * shipped" — is exactly the kind of tribal knowledge a file-based framework exists
 * to abolish.
 *
 * **This does not reconcile anything, and must not pretend to.** It appends an
 * honest marker: a machine-readable HTML comment naming the fact, and one
 * blockquote line telling a human where the current answer lives. Rewriting the
 * stale sentence would need to know which sentence, and guessing that is how a
 * framework starts inventing content — the thing §2.8 exists to refuse.
 *
 * ## Which documents get stamped, and why that set
 *
 * The question already names the document. §2.7 REQUIRES `Why asked:` to end with
 * a `[src: …]` token proving the gap is real, and a question raised mid-Build about
 * a plan claim cites that plan claim — that is what the citation is FOR. So the
 * affected set is derived from data the grammar already makes mandatory: no new
 * schema, no new agent behaviour, nothing for anyone to remember to do.
 *
 * Two rules narrow it:
 *
 * 1. **A cited document is stamped only when it lives in an EARLIER phase than the
 *    question.** "Superseded" means an earlier phase's claim was overtaken. A
 *    question raised in `02-how` citing `02-how/design.md` is an author reading
 *    their own half-written page, and stamping it would be noise on every run.
 * 2. **`affects:` in the block's metadata is honoured wherever it points** (inside
 *    the run). The §2.7 metadata comment already carries unknown keys through
 *    `QuestionMetadata.extra`, so naming the documents explicitly costs no schema
 *    change — and when the honest citation is a source file rather than a phase
 *    doc, explicit is the only way to say it. Explicit intent is not second-guessed
 *    by rule 1.
 *
 * Nothing else is stamped. A fact that overtakes a document neither cited nor
 * named stays unmarked, and that is the accepted cost of not spraying every
 * earlier document in the run with a footer per answer.
 *
 * ## Idempotency
 *
 * The marker carries the fact id, and a document already carrying that id is
 * skipped. Recording the same answer twice — the `answer-capture` hook firing on
 * a Write and again on a FileChanged for the same edit — stamps once.
 */
import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { PHASE_ID_RE } from "../run/RunFile.ts";
import type { QuestionBlock } from "../text/questions.ts";

/**
 * The machine half of the stamp. It is the idempotency key and the thing a later
 * reader greps for, so it is one token and it never changes.
 */
export const STAMP_MARKER = "tldrx:superseded";

/** The metadata key that names affected documents explicitly (§2.7 `extra`). */
export const AFFECTS_KEY = "affects";

/** One document an answer overtook. */
export interface AffectedDoc {
  /** Path relative to the run dir, POSIX-separated — what the stamp and the event carry. */
  readonly rel: string;
  readonly abs: string;
  /** How it was found: the question's own `Why asked:` citation, or `affects:`. */
  readonly by: "cited" | "affects";
}

/** True when `text` already carries a stamp for `fact`. */
export function isStamped(text: string, fact: string): boolean {
  return text.includes(`${STAMP_MARKER} ${fact} `);
}

/**
 * The stamp itself.
 *
 * Deliberately NOT a list item and deliberately carrying no `[src: …]` token: a
 * bullet appended to a `handoff.md` would land inside one of the four §2.8
 * sections, where every list item must be sourced, and `claim-sources` would
 * refuse the very document this is trying to make honest. A blockquote is prose to
 * `parseHandoff`, `parseItems` and `validateCitations` alike, so a stamped handoff
 * validates exactly as it did before the stamp.
 */
export function stampText(fact: string, q: string, questionsRel: string, at: string): string {
  return `<!-- ${STAMP_MARKER} ${fact} | q: ${q} | at: ${at} | see: ${questionsRel} -->\n`
    + `> **Superseded in part by ${fact}** — ${q} was answered after this document was written; `
    + `the answer is in \`${questionsRel}\` and \`.tldrx/memory/facts.yml\`. `
    + "This document was not reconciled: where the two disagree, the fact is what the workspace believes.\n";
}

/** The documents `block` names that an answer to it would overtake. */
export function affectedDocs(
  runDir: string,
  questionsPath: string,
  block: QuestionBlock,
): readonly AffectedDoc[] {
  const self = runRelative(runDir, questionsPath);
  const askedIn = self === null ? null : phaseIdOf(self);
  const found = new Map<string, AffectedDoc>();

  const consider = (raw: string, by: AffectedDoc["by"]): void => {
    const rel = resolveInRun(runDir, raw);
    if (rel === null || rel === self || !rel.endsWith(".md")) return;
    const phase = phaseIdOf(rel);
    if (phase === null) return;
    // Rule 1 — a derived hit must be an EARLIER phase's document. An explicit
    // `affects:` is a request, and a request is not second-guessed.
    if (by === "cited" && (askedIn === null || !isEarlier(phase, askedIn))) return;
    if (!found.has(rel)) found.set(rel, { rel, abs: join(runDir, rel), by });
  };

  for (const ref of block.whySrc?.refs ?? []) {
    if (ref.kind === "file") consider(ref.path, "cited");
  }
  for (const raw of declaredAffects(block)) consider(raw, "affects");
  return [...found.values()];
}

/**
 * Append the stamp to every document `block` names, skipping the ones already
 * stamped for `fact`. Returns what was actually written, for the caller to log.
 *
 * Append-only by construction: `appendFileSync`, never a read-modify-write, so a
 * document's existing bytes cannot be lost by this path even if it is being
 * edited concurrently.
 */
export function stampSuperseded(
  runDir: string,
  questionsPath: string,
  block: QuestionBlock,
  fact: string,
  at: string,
): readonly AffectedDoc[] {
  const questionsRel = runRelative(runDir, questionsPath) ?? "questions.md";
  const stamped: AffectedDoc[] = [];
  for (const doc of affectedDocs(runDir, questionsPath, block)) {
    const text = readFileSync(doc.abs, "utf8");
    if (isStamped(text, fact)) continue;
    const lead = text === "" ? "" : text.endsWith("\n") ? "\n" : "\n\n";
    appendFileSync(doc.abs, lead + stampText(fact, block.id, questionsRel, at), "utf8");
    stamped.push(doc);
  }
  return stamped;
}

/** `affects: a.md, b.md` off the block's §2.7 metadata, or nothing. */
function declaredAffects(block: QuestionBlock): readonly string[] {
  const raw = block.metadata?.extra.find(([key]) => key === AFFECTS_KEY)?.[1] ?? "";
  return raw.split(/[,\s]+/).map((part) => part.trim()).filter((part) => part !== "");
}

/**
 * `raw` as a path inside the run dir, or null.
 *
 * A `[src: …]` file path resolves against the workspace root first and the run dir
 * second (`pathBases` in `text/srcToken.ts`), and both spellings are written in
 * practice — `03-plan/stories/S4.md` and `tldrx-work/<run>/03-plan/stories/S4.md`.
 * Both are accepted; anything that lands outside the run dir, or on nothing, is
 * not a phase document and is refused.
 */
function resolveInRun(runDir: string, raw: string): string | null {
  if (raw === "" || isAbsolute(raw)) return null;
  const root = join(runDir, "..", "..");
  for (const candidate of [join(runDir, raw), join(root, raw)]) {
    const rel = runRelative(runDir, candidate);
    if (rel === null) continue;
    if (!existsSync(candidate) || !statSync(candidate).isFile()) continue;
    return rel;
  }
  return null;
}

/** `path` relative to the run dir, POSIX-separated — null when it escapes. */
function runRelative(runDir: string, path: string): string | null {
  const rel = relative(runDir, path);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(/[\\/]/).join("/");
}

/** The `0N-name` segment a run-relative path sits under, or null. */
function phaseIdOf(rel: string): string | null {
  const first = rel.split("/")[0] ?? "";
  return PHASE_ID_RE.test(first) ? first : null;
}

/** Phase ids are `0[1-5]-…` (§2.2), so the two leading digits ARE the order. */
function isEarlier(phase: string, than: string): boolean {
  return Number(phase.slice(0, 2)) < Number(than.slice(0, 2));
}
