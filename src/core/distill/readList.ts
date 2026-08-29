/**
 * What a `--from` distill is allowed to read (spec §6).
 *
 * The read list is closed on purpose. An AI-DLC intent folder holds a lot of
 * ceremony — audit shards, engine state, per-stage diaries — and importing it
 * wholesale would drown the What phase in process artefacts instead of claims.
 * Anything not named here is ignored, silently and by design.
 */
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Spec §6 "Read". */
export const PROSE_FILES: readonly string[] = [
  "intent-statement.md",
  "scope-document.md",
  "feasibility-assessment.md",
  "constraint-register.md",
  "raid-log.md",
  "wireframes.md",
  "user-flow.md",
];

/**
 * Spec §6 "Ignored": the ceremony stages. `[assumption]` — the spec ignores these
 * three stages' ceremony while also reading "every answered `*-questions.md`
 * block"; taken here as directory-level, so their question files go too.
 */
export const IGNORED_DIRS: readonly string[] = ["market-research", "team-formation", "approval-handoff", "audit"];

/** Spec §6 "Ignored", by name. */
export const IGNORED_FILES: readonly string[] = ["aidlc-state.md", "memory.md"];

const QUESTIONS_SUFFIX = "-questions.md";

export type ReadKind = "prose" | "questions";

export interface ReadFile {
  /** Path relative to the intent directory, POSIX-separated — this is the `src` tag. */
  readonly rel: string;
  readonly abs: string;
  readonly kind: ReadKind;
}

export function classify(name: string): ReadKind | null {
  if (IGNORED_FILES.includes(name)) return null;
  if (PROSE_FILES.includes(name)) return "prose";
  if (name.endsWith(QUESTIONS_SUFFIX)) return "questions";
  return null;
}

/**
 * Every file in the read list, deterministically ordered (sorted by relative path)
 * so two distills of the same folder produce byte-identical output.
 */
export function collectReadFiles(intentDir: string): readonly ReadFile[] {
  const found: ReadFile[] = [];
  walk(intentDir, intentDir, found, 0);
  return found.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

function walk(dir: string, root: string, out: ReadFile[], depth: number): void {
  if (depth > 8) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const abs = join(dir, name);
    let isDir = false;
    try {
      isDir = statSync(abs).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      if (IGNORED_DIRS.includes(name)) continue;
      walk(abs, root, out, depth + 1);
      continue;
    }
    const kind = classify(name);
    if (kind === null) continue;
    out.push({ rel: relative(root, abs).split(sep).join("/"), abs, kind });
  }
}

/** The AI-DLC stage folder a file sits in — used as the imported claim's `area`. */
export function areaOf(rel: string): string {
  const parts = rel.split("/");
  const dir = parts.length >= 2 ? parts[parts.length - 2] : null;
  return dir === undefined || dir === null || dir === "" ? "imported" : slugify(dir);
}

export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug === "" ? "imported" : slug;
}
