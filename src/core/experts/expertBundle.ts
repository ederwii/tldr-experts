/**
 * One expert, as a stage prompt sees it: who it is (`expert.md`), what it has
 * learned (`knowledge/*.md`), how far (`competencies.yml`), and how many bytes of
 * each actually made it into the prompt.
 *
 * This is the single entry point every prompt-assembling call site uses — the
 * default `next` path, the Watch executor, the Build executor and `expert train`
 * — so "what an expert contributes" is one answer in one place rather than four
 * copies that drift.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EXPERT_FILE, expertDir, loadExpert } from "./loadExperts.ts";
import { selectExperts, type ExpertReason, type SelectExpertsInput } from "./selectExperts.ts";
import type { ExpertRecord } from "./ExpertRecord.ts";
import {
  byteLength, DEFAULT_KNOWLEDGE_MAX_BYTES, loadExpertKnowledge, type KnowledgeFileView,
} from "./expertKnowledge.ts";
import { splitFrontMatter } from "./expertDocument.ts";
import { composePackBody, readOverlayFiles } from "./packSections.ts";
import { readStackPacks } from "./stackPacks.ts";

/**
 * What `--prepare` says when a stage file still names `domain` or `stack`.
 *
 * Deliberately not phrased as a warning: nothing is wrong and nothing was
 * dropped. The stage asked for something by a name, and the answer is that the
 * framework decides that one by rule instead.
 */
export const LEGACY_NOTE =
  "experts: domain/stack are selected by rule, not by name";

export interface ExpertBundle {
  readonly name: string;
  readonly reason: ExpertReason;
  /** What a `domain` selection matched on. */
  readonly match?: string;
  /** Bytes of the shared knowledge budget this expert was given. */
  readonly knowledgeAllowance: number;
  /**
   * `expert.md`, verbatim — or, for a `kind: stack` expert with stack packs on, that
   * body composed with its inlined overlays (see `overlays`/`notInlined`). Every
   * renderer prints this one field, which is what makes composing here reach all of
   * them without a change of their own.
   */
  readonly body: string;
  /** Bytes of `body` — `expertMdBytes + overlayBytes`, always. */
  readonly bodyBytes: number;
  /**
   * `expert.md`'s own bytes on disk, before any pack composition. UNAFFECTED by
   * the stack-packs switch — this is the number `pending.json`'s `expert_md_bytes`
   * must keep meaning (AGENTS.md §7: a `version: 1` field never changes meaning).
   */
  readonly expertMdBytes: number;
  /**
   * Bytes `body` carries beyond `expert.md` itself: inlined overlays plus
   * composition overhead. `0` when packs are off, the expert isn't `kind: stack`,
   * or nothing was inlined.
   */
  readonly overlayBytes: number;
  /** Overlay ids inlined into `body` (stack packs, switch on and `kind: stack` only). Empty otherwise. */
  readonly overlays: readonly string[];
  /**
   * Overlay ids the 24 KiB pack cap left OUT of `body` whole (never cut) — named so
   * an operator sees what did not fit instead of a bundle that quietly said less
   * than the repo declared. Empty when packs are off or nothing was left out.
   */
  readonly notInlined: readonly string[];
  /**
   * True only when the pack cap cut the BODY ITSELF (`ComposedPack.truncated`,
   * `packSections.ts`) — the defensive case that only matters for a body larger
   * than the whole 24 KiB cap. Distinct from `truncated` below, which is about
   * KNOWLEDGE only; overloading one flag for two different cuts would make a real
   * knowledge truncation and a body truncation indistinguishable to a caller.
   */
  readonly packBodyTruncated: boolean;
  /** The rendered star chart + knowledge block, appended after the body. `""` when empty. */
  readonly knowledge: string;
  /** Bytes of knowledge-FILE content inlined (not the framing prose). */
  readonly knowledgeBytes: number;
  readonly files: readonly KnowledgeFileView[];
  readonly truncated: boolean;
  /** False when every area of `competencies.yml` holds zero evidence rows. */
  readonly hasEvidence: boolean;
  /** `tldrx expert train <name> --area <area>` for its first area, or null. */
  readonly trainPrompt: string | null;
}

export interface ExpertBundleSet {
  readonly experts: readonly ExpertBundle[];
  /** Names a stage file declares that have no folder on disk. */
  readonly missing: readonly string[];
  /** Domain experts that matched but fell past `MAX_DOMAIN_SELECTED`. */
  readonly overflow: readonly string[];
  /** Retired placeholder names a stage file still lists (`LEGACY_STAGE_EXPERTS`). */
  readonly legacy: readonly string[];
}

export interface LoadBundlesInput extends SelectExpertsInput {
  /**
   * The TOTAL trained-knowledge ceiling shared by every loaded expert
   * (§2.3 `knowledge_max_bytes`). Defaults to `DEFAULT_KNOWLEDGE_MAX_BYTES`.
   */
  readonly knowledgeBytes?: number;
}

/**
 * How the shared knowledge budget is split (wave N).
 *
 * Weights are harmonic in RANK — `1/(i+1)`, normalised — so the expert the run's
 * cited paths actually point at gets the largest slice and the ninth one gets a
 * ninth of the first's. Whatever an expert does not spend carries FORWARD to the
 * next, so a top-ranked expert with 2 KB of knowledge does not strand the budget.
 *
 * An expert with a relevance score of zero — nothing it declares intersects
 * anything this stage cites — gets NO knowledge at all, only its `expert.md`
 * body. That is the measured problem this exists for: on `~/aparece-v2`, eight of
 * nine experts loaded because they shared a repo with the run, and 52% of a
 * 159,575-byte prompt was their knowledge.
 */
export function knowledgeShares(
  eligible: readonly boolean[],
  totalBytes: number,
): readonly number[] {
  const ranks: number[] = [];
  eligible.forEach((ok, i) => { if (ok) ranks.push(i); });
  if (ranks.length === 0 || totalBytes <= 0) return eligible.map(() => 0);
  const weights = ranks.map((_, position) => 1 / (position + 1));
  const sum = weights.reduce((total, w) => total + w, 0);
  const shares = eligible.map(() => 0);
  ranks.forEach((index, position) => {
    shares[index] = Math.floor((totalBytes * (weights[position] ?? 0)) / sum);
  });
  return shares;
}

export function loadExpertBundles(input: LoadBundlesInput): ExpertBundleSet {
  const selection = selectExperts(input);
  const total = input.knowledgeBytes ?? DEFAULT_KNOWLEDGE_MAX_BYTES;
  const shares = knowledgeShares(
    selection.experts.map((chosen) => chosen.relevant !== false),
    total,
  );
  const experts: ExpertBundle[] = [];
  // Carried forward, never re-divided: the arithmetic stays one pass and the
  // result does not depend on how many experts happened to be cheap.
  let carry = 0;
  // Read once: the switch is one fact about the workspace, not one per expert.
  const packs = readStackPacks(input.root);

  for (const [index, chosen] of selection.experts.entries()) {
    const path = join(expertDir(input.root, chosen.name), EXPERT_FILE);
    if (!existsSync(path)) continue;
    const raw = readFileSync(path, "utf8");
    const expertMdBytes = byteLength(raw);
    // Packs live inside the stack expert (design decision 5): with the switch on, a
    // `kind: stack` body carries its overlays, and every renderer that prints `body`
    // — stage prompts, the developer — gets them without a change of its own.
    const isStackExpert = packs.enabled && splitFrontMatter(raw).frontMatter.get("kind") === "stack";
    const overlayFiles = isStackExpert ? readOverlayFiles(expertDir(input.root, chosen.name)) : [];
    const composed = isStackExpert ? composePackBody(raw, overlayFiles) : null;
    // Short-circuit on zero overlays with nothing to cut (ruled-in latent bug, fix round
    // 2): `composePackBody` always trims the body's trailing blank lines to one, even
    // with nothing to append — so a stack expert with no overlays, routed through it
    // anyway, got `body !== raw` and could send `overlayBytes` (`bodyBytes -
    // expertMdBytes`) negative. `composed.truncated` is kept as the escape hatch: a body
    // alone over the pack cap must still go through `truncateAtHeading` (the defensive
    // case `packSections.ts` documents), which is the one case zero overlays still needs
    // `composed.text` instead of `raw`.
    const body = composed === null || (overlayFiles.length === 0 && !composed.truncated)
      ? raw
      : composed.text;
    const bodyBytes = byteLength(body);
    const record = loadExpert(input.root, chosen.name);
    const allowance = (shares[index] ?? 0) + carry;
    const knowledge = loadExpertKnowledge({
      root: input.root,
      name: chosen.name,
      record,
      budgetBytes: allowance,
    });
    carry = Math.max(0, allowance - knowledge.inlinedBytes);
    experts.push({
      name: chosen.name,
      reason: chosen.reason,
      ...(chosen.match === undefined ? {} : { match: chosen.match }),
      knowledgeAllowance: allowance,
      body,
      bodyBytes,
      expertMdBytes,
      overlayBytes: composed === null ? 0 : bodyBytes - expertMdBytes,
      overlays: composed === null ? [] : composed.inlined,
      notInlined: composed === null ? [] : composed.notInlined,
      packBodyTruncated: composed !== null && composed.truncated,
      knowledge: knowledge.text,
      knowledgeBytes: knowledge.inlinedBytes,
      files: knowledge.files,
      truncated: knowledge.truncated,
      hasEvidence: record.areas.some((area) => area.evidence.length > 0),
      trainPrompt: trainPromptFor(record),
    });
  }

  return {
    experts,
    missing: selection.missing,
    overflow: selection.overflow,
    legacy: selection.legacy,
  };
}

/**
 * The command the stderr nudge tells an operator to run.
 *
 * Taken from `competencies.yml`'s own `train_prompt` when the file has one,
 * because that string already carries the `--mode` this area needs — `full` for a
 * role expert, whose light mode is refused (`training/roleTraining.ts`). Composing
 * one here would drop the mode and hand the operator a command that exits 1.
 */
function trainPromptFor(record: ExpertRecord): string | null {
  const area = record.areas[0];
  if (area === undefined) return null;
  return area.trainPrompt !== ""
    ? area.trainPrompt
    : `tldrx expert train ${record.name} --area ${area.id}`;
}

/** One line per expert for `--prepare` / `--dry-run`, so the operator sees what was loaded. */
export function describeBundles(set: ExpertBundleSet): readonly string[] {
  const lines: string[] = [];
  if (set.experts.length === 0) lines.push("experts: none loaded");
  for (const expert of set.experts) {
    const files = expert.knowledgeAllowance === 0
      ? "no knowledge (body only — nothing it declares intersects this stage)"
      : expert.files.length === 0
        ? "no knowledge"
        : `knowledge ${bytes(expert.knowledgeBytes)} of ${bytes(expert.knowledgeAllowance)}`
          + ` over ${plural(expert.files.length, "area")}`;
    const notInlinedNote = expert.notInlined.length === 0
      ? ""
      : `, ${plural(expert.notInlined.length, "overlay")} not inlined: ${expert.notInlined.join(", ")}`;
    const packTruncatedNote = expert.packBodyTruncated ? ", pack body truncated" : "";
    // The `expert.md` label names `expert.md`, so it gets `expertMdBytes` and never
    // `bodyBytes` — which became the COMPOSED total the moment a stack body started
    // carrying its overlays, leaving the label naming one file and the number naming
    // several. The composed extra is its own term, off the field the bundle already
    // computed; nothing here re-derives a byte count. Same condition as the id list, so
    // the size and the ids appear together or not at all — and with the switch off
    // `expertMdBytes === bodyBytes`, so the line is byte-identical to what it always was.
    const overlayNote = expert.overlays.length === 0
      ? ""
      : ` + overlays ${bytes(expert.overlayBytes)} (overlays: ${expert.overlays.join(", ")})`;
    lines.push(
      `expert ${expert.name} (${expert.reason}${expert.match === undefined ? "" : `: ${expert.match}`})`
      + ` — expert.md ${bytes(expert.expertMdBytes)}${overlayNote}, ${files}${expert.truncated ? ", truncated" : ""}${notInlinedNote}${packTruncatedNote}`,
    );
  }
  for (const name of set.missing) {
    lines.push(`expert ${name} — NOT LOADED: no .tldrx/experts/${name}/ in this workspace`);
  }
  // One line however many of the two a forked stage file lists: it is one fact
  // about the stage file, not a complaint per name.
  if (set.legacy.length > 0) {
    lines.push(LEGACY_NOTE);
  }
  if (set.overflow.length > 0) {
    lines.push(`experts not loaded (past the domain cap): ${set.overflow.join(", ")}`);
  }
  return lines;
}

/**
 * The stderr nudge (never a block): an expert with no evidence anywhere is a
 * stub, and a stub in a prompt reads exactly like a trained expert to the model.
 */
export function untrainedNotes(set: ExpertBundleSet): readonly string[] {
  return set.experts
    .filter((expert) => !expert.hasEvidence)
    .map((expert) =>
      `note: expert ${expert.name} has no evidence — \`${expert.trainPrompt
        ?? `tldrx expert train ${expert.name} --area <area>`}\` before this stage would help`,
    );
}

function bytes(count: number): string {
  return count < 1024 ? `${String(count)} B` : `${(count / 1024).toFixed(1)} KB`;
}

function plural(count: number, word: string): string {
  return `${String(count)} ${word}${count === 1 ? "" : "s"}`;
}
