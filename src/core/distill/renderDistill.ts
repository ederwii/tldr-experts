/**
 * The four files a distill writes into `01-what/` (spec §6).
 *
 *   intent.md    distilled prose about WHY and WHAT, every bullet tagged
 *   scope.md     distilled prose about the boundary, every bullet tagged
 *   handoff.md   §2.8 shape: Findings = imported claims, Unknowns = detected gaps
 *   questions.md §2.7 shape, one block per conflict with a non-retired fact
 *
 * Nothing here invents a sentence. Every bullet is a claim that was in the source
 * folder, carrying the tag that says where it was.
 */
import { HANDOFF_SECTIONS, MAX_BULLETS } from "../text/handoff.ts";
import type { Conflict, DistillResult, ImportedClaim } from "./distill.ts";

/** `[assumption]` — spec §6 names the two prose outputs but not which source feeds which. */
const SCOPE_FILES: readonly string[] = ["scope-document.md", "wireframes.md", "user-flow.md"];
const SCOPE_DIRS: readonly string[] = ["scope-definition", "rough-mockups"];

/** Process artefacts, not content: their absence is not a gap worth reporting. */
const NON_CONTENT_OUTPUTS: readonly string[] = ["handoff.md", "questions.md"];

export type ProseTarget = "intent" | "scope";

export function targetOf(rel: string): ProseTarget {
  const parts = rel.split("/");
  const name = parts[parts.length - 1] ?? rel;
  const dir = parts.length >= 2 ? parts[parts.length - 2] ?? "" : "";
  if (SCOPE_FILES.includes(name)) return "scope";
  if (name.endsWith("-questions.md") && SCOPE_DIRS.includes(dir)) return "scope";
  return "intent";
}

export function bullet(claim: ImportedClaim): string {
  return `- ${claim.text} [src: ${claim.src}]`;
}

export function renderProse(
  title: string,
  runId: string,
  intentDir: string,
  claims: readonly ImportedClaim[],
): string {
  const lines = [
    `# ${title} — run ${runId}`,
    `Imported by \`tldrx run new --from\` from \`${intentDir}\`. Not authored — distilled.`,
    "",
  ];
  if (claims.length === 0) {
    lines.push("_Nothing in the AI-DLC intent folder mapped to this file._", "");
    return `${lines.join("\n")}\n`;
  }
  let heading: string | null = null;
  for (const claim of claims) {
    if (claim.file !== heading) {
      heading = claim.file;
      lines.push(`## ${claim.file}`, "");
    }
    lines.push(bullet(claim));
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export interface HandoffInput {
  readonly runId: string;
  readonly stageId: string;
  readonly phase: string;
  readonly at: string;
  readonly result: DistillResult;
  /** Declared outputs of the What stage, relative to the run dir. */
  readonly declaredOutputs: readonly string[];
  /** Which of those the distill actually wrote. */
  readonly writtenOutputs: readonly string[];
}

export function renderHandoff(input: HandoffInput): string {
  const { result } = input;
  const unknowns = detectGaps(input.declaredOutputs, input.writtenOutputs);
  const ledger = [...result.perFile.entries()].map(
    ([file, count]) => `- Read ${file} — ${count} claim(s) imported [src: aidlc:${file}:1]`,
  );

  // Spec §2.8 caps a handoff at 200 bullets. Findings yield first; the full set
  // always lives in intent.md / scope.md, so nothing imported is actually lost.
  const room = Math.max(0, MAX_BULLETS - unknowns.length - ledger.length);
  const shown = result.claims.slice(0, room);
  const hidden = result.claims.length - shown.length;

  const lines = [
    `# Handoff — ${input.phase} / ${input.stageId} — run ${input.runId}`,
    `Stage: ${input.stageId} · Expert: distill · Model: none · Cost: $0.00 · ${input.at}`,
    "",
    `## ${HANDOFF_SECTIONS[0]}`,
  ];
  if (shown.length === 0) lines.push("_No claims were imported._");
  for (const claim of shown) lines.push(bullet(claim));
  if (hidden > 0) {
    lines.push("", `_${hidden} further imported claim(s) are in 01-what/intent.md and 01-what/scope.md._`);
  }

  lines.push("", `## ${HANDOFF_SECTIONS[1]}`);
  lines.push("_The distill copies claims; it decides nothing. Decisions belong to the What stage._");

  lines.push("", `## ${HANDOFF_SECTIONS[2]}`);
  if (unknowns.length === 0) lines.push("_Every declared What output has imported content._");
  for (const gap of unknowns) lines.push(gap);

  lines.push("", `## ${HANDOFF_SECTIONS[3]}`);
  if (ledger.length === 0) lines.push("_No file on the §6 read list was present._");
  for (const entry of ledger) lines.push(entry);
  if (result.droppedUnanswered > 0 || result.droppedConflicting > 0) {
    lines.push(
      "",
      `_Dropped: ${result.droppedUnanswered} unanswered question block(s), ` +
        `${result.droppedConflicting} claim(s) contradicting a non-retired fact._`,
    );
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

/** A declared What output with no imported content is a gap the What stage must fill. */
export function detectGaps(declared: readonly string[], written: readonly string[]): readonly string[] {
  const have = new Set(written);
  const gaps: string[] = [];
  for (const output of declared) {
    const name = output.split("/").pop() ?? output;
    if (NON_CONTENT_OUTPUTS.includes(name)) continue;
    if (have.has(output)) continue;
    gaps.push(`- Nothing in the AI-DLC intent folder produced ${output} [src: absent:${output}]`);
  }
  return gaps;
}

const MAX_QUESTION_TITLE = 96;

export function renderQuestions(
  runId: string,
  phase: string,
  at: string,
  conflicts: readonly Conflict[],
): string {
  const lines = [`# Questions — ${phase} — run ${runId}`, ""];
  conflicts.forEach((conflict, i) => {
    const id = `Q${i + 1}`;
    const excerpt = truncate(conflict.claim.text, MAX_QUESTION_TITLE);
    lines.push(
      `## ${id} · Which is right about ${conflict.claim.area}: the imported claim or ${conflict.factId}?`,
      `<!-- id: ${id} | status: open | area: ${conflict.claim.area} | asked_by: distill | asked_at: ${at} -->`,
      `Why asked: an imported claim overlaps this fact at Jaccard ${conflict.score.toFixed(2)} ` +
        `and says something different — imported: "${excerpt}" [src: ${conflict.factId}]`,
      "",
      `- A) The imported claim is right — retire ${conflict.factId} and keep the import`,
      `- B) ${conflict.factId} is right — drop the imported claim`,
      "- C) Both are partly right — write the correction below",
      "",
      "[Answer]:",
      "",
    );
  });
  return `${lines.join("\n")}\n`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}
