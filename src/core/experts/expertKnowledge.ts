/**
 * What TRAINING contributes to a stage prompt.
 *
 * Before this module, nothing did. Measured 2026-08-29 on a fixture workspace
 * whose `product` expert had a validated `knowledge/loyalty.md` and a level-3 area:
 * `tldrx next --prepare` produced a 1,493-byte prompt containing three `expert.md`
 * bodies, zero occurrences of the string "knowledge", zero stars, and zero of the
 * expert's 646 bytes of findings. Every `tldrx expert train` run in the product's
 * history was therefore invisible at the only moment it was supposed to pay —
 * training wrote a level, and the level was never read by the thing doing the work.
 *
 * So each loaded expert now carries, after its `expert.md` body:
 *
 *   1. its star chart, one line per area (spec §2.6 — computed, never self-declared)
 *   2. its knowledge files, most-recently-trained area first
 *
 * under a per-expert byte budget. Truncation cuts at an H2 boundary — never
 * mid-finding, because half a bullet is a claim with its citation torn off — and
 * says on the page how many findings were left behind and where they live.
 *
 * The `[src: …]` tokens in those bullets are the point. They were resolved against
 * real files when `tldrx expert train` accepted the knowledge (§2.6, "a knowledge
 * file is accepted or rejected whole"), so the sub-agent may reuse them verbatim
 * instead of re-opening files it is not allowed to open. The prompt says so.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_FRAMEWORK_DIR } from "../paths.ts";
import { splitFrontMatter } from "./expertDocument.ts";
import { expertDir, EXPERTS_DIRNAME } from "./loadExperts.ts";
import { starChart } from "./starChart.ts";
import type { ExpertRecord } from "./ExpertRecord.ts";

export const KNOWLEDGE_DIRNAME = "knowledge";

/**
 * `[assumption]` 64 KB per expert. The Build executor already inlines "≤24 files,
 * ≤64 KB" of story context per sub-agent (spec §5), and an expert's accumulated
 * findings are the same kind of thing: reference material the agent reads once.
 * Overridable per stage — see `expert_knowledge_bytes` in `stage.yml` (§2.3).
 */
export const DEFAULT_EXPERT_KNOWLEDGE_BYTES = 64 * 1024;

export interface KnowledgeFileView {
  /** `loyalty` — the area the file was trained for. */
  readonly area: string;
  /** Workspace-relative, e.g. `.tldrx/experts/product/knowledge/loyalty.md`. */
  readonly path: string;
  readonly totalBytes: number;
  readonly inlinedBytes: number;
  readonly findings: number;
  readonly findingsInlined: number;
  readonly truncated: boolean;
  /** `trained_at:` from the file's front matter; null when it carries none. */
  readonly trainedAt: string | null;
}

export interface ExpertKnowledge {
  readonly files: readonly KnowledgeFileView[];
  /** The rendered block, ready to append after the `expert.md` body. `""` when there is nothing. */
  readonly text: string;
  /** Bytes of knowledge-FILE content actually inlined (the prose around it is not counted). */
  readonly inlinedBytes: number;
  readonly truncated: boolean;
}

interface RawKnowledgeFile {
  readonly area: string;
  readonly path: string;
  readonly relPath: string;
  /** The file BODY — its front matter is stripped and re-rendered as one header line. */
  readonly text: string;
  readonly trainedAt: string | null;
}

/**
 * Every `knowledge/*.md` an expert has, most-recently-trained first.
 *
 * The order comes from the file's own `trained_at:` front matter, not from an
 * mtime: a checkout, a copy or a `git clone` rewrites every mtime in the tree, and
 * an order that changes when you clone the repo is not an order. Files with no
 * `trained_at` sort last, by name, so the sequence is total and deterministic.
 */
export function readKnowledgeFiles(root: string, name: string): readonly RawKnowledgeFile[] {
  const dir = join(expertDir(root, name), KNOWLEDGE_DIRNAME);
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const files: RawKnowledgeFile[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".md") || entry.endsWith(".rejected.md")) continue;
    const path = join(dir, entry);
    try {
      if (!statSync(path).isFile()) continue;
    } catch {
      continue;
    }
    // The front matter is dropped and its `trained_at` moved to the header comment:
    // a `---` fence inside the prompt reads as one of `buildPrompt`'s own expert
    // separators, and a boundary that means two things is not a boundary.
    const { frontMatter, body } = splitFrontMatter(readFileSync(path, "utf8"));
    files.push({
      area: entry.replace(/\.md$/, ""),
      path,
      relPath: [PROJECT_FRAMEWORK_DIR, EXPERTS_DIRNAME, name, KNOWLEDGE_DIRNAME, entry].join("/"),
      text: body.trimStart(),
      trainedAt: frontMatter.get("trained_at") ?? null,
    });
  }

  return [...files].sort((a, b) => {
    if (a.trainedAt === b.trainedAt) return a.area < b.area ? -1 : a.area > b.area ? 1 : 0;
    if (a.trainedAt === null) return 1;
    if (b.trainedAt === null) return -1;
    return a.trainedAt < b.trainedAt ? 1 : -1;
  });
}

export interface KnowledgeOptions {
  readonly root: string;
  readonly name: string;
  /** The expert's record, for the star chart. Omitted ⇒ no chart is rendered. */
  readonly record?: ExpertRecord | null;
  readonly budgetBytes?: number;
}

export function loadExpertKnowledge(options: KnowledgeOptions): ExpertKnowledge {
  const budget = Math.max(0, options.budgetBytes ?? DEFAULT_EXPERT_KNOWLEDGE_BYTES);
  const raw = readKnowledgeFiles(options.root, options.name);
  const chart = chartLines(options.record ?? null);

  if (raw.length === 0) {
    return { files: [], text: chart.length === 0 ? "" : renderBlock(chart, []), inlinedBytes: 0, truncated: false };
  }

  const views: KnowledgeFileView[] = [];
  const chunks: string[] = [];
  let used = 0;

  for (const file of raw) {
    const totalBytes = byteLength(file.text);
    const findings = countFindings(file.text);
    const room = budget - used;
    const cut = room <= 0 ? "" : truncateAtHeading(file.text, room);
    const header = `${file.relPath}${file.trainedAt === null ? "" : ` · trained ${file.trainedAt}`}`;
    const inlinedBytes = byteLength(cut);

    if (cut === "") {
      views.push({
        area: file.area, path: file.relPath, totalBytes, inlinedBytes: 0,
        findings, findingsInlined: 0, truncated: true, trainedAt: file.trainedAt,
      });
      chunks.push(notInlinedMarker(header, file.relPath, findings, totalBytes));
      continue;
    }

    const findingsInlined = countFindings(cut);
    const truncated = inlinedBytes < totalBytes;
    used += inlinedBytes;
    views.push({
      area: file.area, path: file.relPath, totalBytes, inlinedBytes,
      findings, findingsInlined, truncated, trainedAt: file.trainedAt,
    });
    chunks.push(renderFile(header, file.relPath, cut, truncated ? findings - findingsInlined : 0));
  }

  return {
    files: views,
    text: renderBlock(chart, chunks),
    inlinedBytes: used,
    truncated: views.some((view) => view.truncated),
  };
}

/** One star-chart line per area — `starChart` already renders exactly §2.6's shape. */
export function chartLines(record: ExpertRecord | null): readonly string[] {
  if (record === null || record.error !== null || record.areas.length === 0) return [];
  return starChart(record.areas);
}

/**
 * The largest prefix of `text` that fits in `limit` bytes AND ends at an H2
 * boundary (the line before a `## `), or the whole text when it already fits.
 *
 * `""` means "not one section fits" — the caller emits a marker instead of a
 * prefix. Cutting mid-section is not offered: a knowledge file's sections are
 * `## Invariants`, `## Gotchas` and the like, and half a section reads as a
 * complete one to whatever comes next.
 */
export function truncateAtHeading(text: string, limit: number): string {
  if (limit <= 0) return "";
  if (byteLength(text) <= limit) return text;

  const lines = text.split("\n");
  let best = "";
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (i > 0 && line.startsWith("## ")) {
      const candidate = text.slice(0, offset).replace(/\n+$/, "\n");
      if (byteLength(candidate) > limit) break;
      best = candidate;
    }
    offset += line.length + 1;
  }
  return best;
}

/** A finding is a list item. Front matter and prose are neither cited nor counted. */
export function countFindings(text: string): number {
  let count = 0;
  for (const line of text.split("\n")) {
    if (/^\s*[-*]\s+\S/.test(line)) count++;
  }
  return count;
}

function renderBlock(chart: readonly string[], chunks: readonly string[]): string {
  const out: string[] = [];
  if (chart.length > 0) {
    out.push(
      "### Competencies",
      "",
      "Computed from evidence, never self-declared (spec §2.6):",
      "",
      ...chart.map((line) => `    ${line}`),
      "",
    );
  }
  if (chunks.length > 0) {
    out.push(
      "### Trained knowledge",
      "",
      "Written by `tldrx expert train` and validated off disk: every bullet below carries a",
      "`[src: …]` token that RESOLVED against a real file when the knowledge was accepted.",
      "**Reuse those tokens verbatim in your own output** — they are evidence, and re-citing",
      "one costs you nothing. Do not open the files they point at: they are not your declared",
      "inputs, and the citation is already proof.",
      "",
      ...chunks,
    );
  }
  return out.join("\n").trimEnd();
}

function renderFile(header: string, relPath: string, body: string, moreFindings: number): string {
  const out = [`<!-- knowledge: ${header} -->`, body.trimEnd()];
  if (moreFindings > 0) {
    out.push("", `… ${String(moreFindings)} more findings in ${relPath}`);
  }
  out.push("");
  return out.join("\n");
}

function notInlinedMarker(header: string, relPath: string, findings: number, totalBytes: number): string {
  return [
    `<!-- knowledge: ${header} (not inlined) -->`,
    `… ${String(findings)} more findings in ${relPath} `
      + `(${String(totalBytes)} bytes, past this stage's expert knowledge budget)`,
    "",
  ].join("\n");
}

export function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}
