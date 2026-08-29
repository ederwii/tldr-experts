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
import {
  byteLength, DEFAULT_EXPERT_KNOWLEDGE_BYTES, loadExpertKnowledge, type KnowledgeFileView,
} from "./expertKnowledge.ts";

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
  /** `expert.md`, verbatim. */
  readonly body: string;
  readonly bodyBytes: number;
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
  /** Per-expert knowledge ceiling. Defaults to `DEFAULT_EXPERT_KNOWLEDGE_BYTES`. */
  readonly knowledgeBytes?: number;
}

export function loadExpertBundles(input: LoadBundlesInput): ExpertBundleSet {
  const selection = selectExperts(input);
  const budget = input.knowledgeBytes ?? DEFAULT_EXPERT_KNOWLEDGE_BYTES;
  const experts: ExpertBundle[] = [];

  for (const chosen of selection.experts) {
    const path = join(expertDir(input.root, chosen.name), EXPERT_FILE);
    if (!existsSync(path)) continue;
    const body = readFileSync(path, "utf8");
    const record = loadExpert(input.root, chosen.name);
    const knowledge = loadExpertKnowledge({
      root: input.root,
      name: chosen.name,
      record,
      budgetBytes: budget,
    });
    experts.push({
      name: chosen.name,
      reason: chosen.reason,
      ...(chosen.match === undefined ? {} : { match: chosen.match }),
      body,
      bodyBytes: byteLength(body),
      knowledge: knowledge.text,
      knowledgeBytes: knowledge.inlinedBytes,
      files: knowledge.files,
      truncated: knowledge.truncated,
      hasEvidence: record.areas.some((area) => area.evidence.length > 0),
      trainPrompt: trainPromptFor(record.name, record.areas[0]?.id ?? null),
    });
  }

  return {
    experts,
    missing: selection.missing,
    overflow: selection.overflow,
    legacy: selection.legacy,
  };
}

function trainPromptFor(name: string, area: string | null): string | null {
  return area === null ? null : `tldrx expert train ${name} --area ${area}`;
}

/** One line per expert for `--prepare` / `--dry-run`, so the operator sees what was loaded. */
export function describeBundles(set: ExpertBundleSet): readonly string[] {
  const lines: string[] = [];
  if (set.experts.length === 0) lines.push("experts: none loaded");
  for (const expert of set.experts) {
    const files = expert.files.length === 0
      ? "no knowledge"
      : `knowledge ${bytes(expert.knowledgeBytes)} over ${plural(expert.files.length, "area")}`;
    lines.push(
      `expert ${expert.name} (${expert.reason}${expert.match === undefined ? "" : `: ${expert.match}`})`
      + ` — expert.md ${bytes(expert.bodyBytes)}, ${files}${expert.truncated ? ", truncated" : ""}`,
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
