/**
 * `<out>/inventory.md` and `<out>/inventory.json` (spec §6.2).
 *
 * The Markdown is what a human reads before deciding whether to pay for a model
 * pass; the JSON is the same numbers for anything that would otherwise parse the
 * Markdown. Both come from one `SeedInventory`, so they cannot disagree.
 */
import type { SeedInventory, InventoryDocument } from "./triageInventory.ts";
import { formatTokens, verdictLine } from "./triageInventory.ts";

export const INVENTORY_MD = "inventory.md";
export const INVENTORY_JSON = "inventory.json";

export function renderInventory(inventory: SeedInventory, seedPath: string, at: string): string {
  const lines = [
    `# Seed inventory — ${inventory.source}`,
    "",
    `Written by \`tldrx seed triage ${seedPath}\` at ${at}. Deterministic: no model was asked,`,
    "nothing was copied, and every row below is a count taken off the file it names.",
    "",
    verdictLine(inventory, seedPath),
    "",
    `Totals: ${String(inventory.files)} document(s), ${String(inventory.bytes)} bytes, `
      + `${formatTokens(inventory.tokens)} tokens · threshold ${String(inventory.thresholdTokens)} tokens`,
    "",
    "| # | Document | Bytes | ~Tokens | H1/H2 | Refs | Status | Open | Code-derived |",
    "|---|----------|-------|---------|-------|------|--------|------|--------------|",
  ];
  inventory.documents.forEach((document, index) => {
    lines.push(
      `| ${String(index + 1)} | \`${document.rel}\` | ${String(document.bytes)} | `
      + `${String(document.tokens)} | ${String(document.h1.length)}/${String(document.h2.length)} | `
      + `${String(document.references.length)} | ${document.adrStatus ?? "—"} | `
      + `${String(document.openMarkers)} | ${codeCell(document)} |`,
    );
  });
  lines.push("");

  for (const document of inventory.documents) {
    lines.push(`## \`${document.rel}\``, "");
    lines.push(
      `- ${String(document.bytes)} bytes, ${String(document.lines)} line(s), `
      + `${formatTokens(document.tokens)} tokens`,
    );
    if (document.adrStatus !== null) lines.push(`- status: ${document.adrStatus}`);
    lines.push(`- open markers (TODO/TBD/open question/??): ${String(document.openMarkers)}`);
    lines.push(
      `- code-derived: ${document.codeDerived.likely ? "likely" : "no"} — `
      + `${String(document.codeDerived.resolved)} of ${String(document.codeDerived.cited)} cited path(s) `
      + `resolve to a real file`
      + (document.codeDerived.examples.length === 0
        ? ""
        : ` (e.g. ${document.codeDerived.examples.map((path) => `\`${path}\``).join(", ")})`),
    );
    lines.push(document.references.length === 0
      ? "- references: none"
      : `- references: ${document.references.map((rel) => `\`${rel}\``).join(", ")}`);
    if (document.h1.length > 0) lines.push(`- H1: ${document.h1.map(quote).join(", ")}`);
    if (document.h2.length > 0) lines.push(`- H2: ${document.h2.map(quote).join(", ")}`);
    lines.push("");
  }

  if (inventory.skipped.length > 0) {
    lines.push("## Skipped", "");
    for (const entry of inventory.skipped) {
      lines.push(`- \`${entry.rel}\` (${String(entry.bytes)} bytes) — ${entry.reason}`);
    }
    lines.push("");
  }
  if (inventory.warnings.length > 0) {
    lines.push("## Warnings", "");
    for (const warning of inventory.warnings) lines.push(`- ${warning}`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

export function inventoryJson(inventory: SeedInventory, seedPath: string, at: string): string {
  return `${JSON.stringify({
    version: 1,
    source: inventory.source,
    sources: inventory.sources,
    seed_path: seedPath,
    created_at: at,
    threshold_tokens: inventory.thresholdTokens,
    over_threshold: inventory.overThreshold,
    code_path_min: inventory.codePathMin,
    totals: { files: inventory.files, bytes: inventory.bytes, tokens: inventory.tokens },
    verdict: verdictLine(inventory, seedPath),
    documents: inventory.documents.map((document) => ({
      rel: document.rel,
      bytes: document.bytes,
      tokens: document.tokens,
      lines: document.lines,
      h1: document.h1,
      h2: document.h2,
      references: document.references,
      status: document.adrStatus,
      open_markers: document.openMarkers,
      code_derived: {
        likely: document.codeDerived.likely,
        cited: document.codeDerived.cited,
        resolved: document.codeDerived.resolved,
        examples: document.codeDerived.examples,
      },
    })),
    skipped: inventory.skipped,
    warnings: inventory.warnings,
  }, null, 2)}\n`;
}

function codeCell(document: InventoryDocument): string {
  return document.codeDerived.likely
    ? `likely (${String(document.codeDerived.resolved)})`
    : `no (${String(document.codeDerived.resolved)})`;
}

function quote(text: string): string {
  return `"${text.replace(/"/g, "'")}"`;
}
