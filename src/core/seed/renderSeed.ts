/**
 * The two files a `--seed` import writes into `01-what/`.
 *
 *   seed-index.md   what was read, how big it was, and what was skipped
 *   handoff.md      §2.8 shape: Findings = the distilled documents,
 *                   Unknowns = the What outputs no seed heading covers
 *
 * Nothing here invents a sentence. Every Finding is a line that exists in a file
 * on disk, carrying the token that says which line of which file.
 */
import { HANDOFF_SECTIONS, MAX_BULLETS, noneBullet } from "../text/handoff.ts";
import { uncoveredSections, coveringHeading, EXPECTED_SECTIONS } from "./seedCoverage.ts";
import type { SeedClaim, SeedHeading } from "./seedClaims.ts";
import type { SeedSet } from "./collectSeed.ts";

export const SEED_INDEX = "seed-index.md";

export function renderSeedIndex(runId: string, seed: SeedSet, phase: string): string {
  const lines = [
    `# Seed documents — ${phase} — run ${runId}`,
    "",
    `Imported by \`tldrx run new ${seed.sources.map((path) => `--seed ${path}`).join(" ")}\`. The documents are NOT copied:`,
    "each row points at the file where the team already keeps it, and every Finding in",
    "`handoff.md` cites it as `[src: <path>:<line>]`.",
    "",
    "| # | Document | Bytes | Lines |",
    "|---|----------|-------|-------|",
  ];
  seed.documents.forEach((document, index) => {
    lines.push(`| ${index + 1} | \`${document.rel}\` | ${document.bytes} | ${document.lines} |`);
  });
  lines.push("");

  if (seed.skipped.length > 0) {
    lines.push("## Skipped", "");
    for (const entry of seed.skipped) {
      lines.push(`- \`${entry.rel}\` (${entry.bytes} bytes) — ${entry.reason}`);
    }
    lines.push("");
  }
  if (seed.warnings.length > 0) {
    lines.push("## Warnings", "");
    for (const warning of seed.warnings) lines.push(`- ${warning}`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

export interface SeedHandoffInput {
  readonly runId: string;
  readonly stageId: string;
  readonly phase: string;
  readonly at: string;
  readonly seed: SeedSet;
  readonly claims: readonly SeedClaim[];
  readonly headings: readonly SeedHeading[];
}

export function renderSeedHandoff(input: SeedHandoffInput): string {
  const { seed } = input;
  const indexPath = `${input.phase}/${SEED_INDEX}`;
  const uncovered = uncoveredSections(input.headings);

  const unknowns = uncovered.map((section) =>
    `- The seed has no heading about ${section.label}, so \`${section.output}\` has nothing to start from `
    + `[src: absent:${input.phase}/${section.output}]`);
  if (unknowns.length === 0) {
    unknowns.push(
      `- Every What output has at least one matching seed heading; whether the content is SUFFICIENT is not measurable here `
      + `[src: ${indexPath}:1]`,
    );
  }

  const ledger = seed.documents.map((document) =>
    `- Read \`${document.rel}\` — ${document.lines} line(s), `
    + `${input.claims.filter((claim) => claim.file === document.rel).length} claim(s) imported `
    + `[src: ${document.rel}:1]`);
  for (const entry of seed.skipped) {
    ledger.push(`- Skipped \`${entry.rel}\` — ${entry.reason} [src: ${indexPath}:1]`);
  }

  const decisions = EXPECTED_SECTIONS.flatMap((section) => {
    const heading = coveringHeading(section, input.headings);
    if (heading === null) return [];
    return [
      `- **measured** the seed covers ${section.label} under "${heading.text}" `
      + `[src: ${heading.file}:${heading.line}]`,
    ];
  });
  if (decisions.length === 0) {
    decisions.push(
      `- **measured** the seed matched none of the four What outputs by heading — everything is an unknown `
      + `[src: ${indexPath}:1]`,
    );
  }

  // Spec §2.8 caps a handoff at 200 bullets. Findings yield first; the documents
  // themselves are the full record and are inlined into the stage prompt anyway.
  const room = Math.max(0, MAX_BULLETS - unknowns.length - ledger.length - decisions.length);
  const shown = input.claims.slice(0, room);
  const hidden = input.claims.length - shown.length;

  const lines = [
    `# Handoff — ${input.phase} / ${input.stageId} — run ${input.runId}`,
    `Stage: ${input.stageId} · Expert: seed · Model: none · Cost: $0.00 · ${input.at}`,
    "",
    `## ${HANDOFF_SECTIONS[0]}`,
  ];
  // Spec §2.8: a checked section holds at least one list item, so "nothing here"
  // is an item naming what was read — not a paragraph the checker cannot check.
  if (shown.length === 0) {
    lines.push(`- none — the seed documents hold no heading, bullet or paragraph [src: absent:${indexPath}]`);
  }
  for (const claim of shown) lines.push(`- ${claim.text} [src: ${claim.src}]`);
  if (hidden > 0) {
    lines.push("", `_${hidden} further seed claim(s) were not listed; the documents are inlined into this stage's prompt._`);
  }

  lines.push("", `## ${HANDOFF_SECTIONS[1]}`, ...decisions);
  lines.push("", `## ${HANDOFF_SECTIONS[2]}`, ...unknowns);
  if (ledger.length === 0) ledger.push(noneBullet(indexPath));
  lines.push("", `## ${HANDOFF_SECTIONS[3]}`, ...ledger);
  if (seed.warnings.length > 0) {
    lines.push("", `_${seed.warnings.length} warning(s) from the import are listed in ${indexPath}._`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}
