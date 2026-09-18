/**
 * A mechanical, local repair for an over-cap `acceptance`/`test_plan` item on a
 * story file (gh #352, part of the #345 family).
 *
 * `checkPlan` (`run/checks.ts`) runs this BEFORE `validatePlan` judges the plan,
 * exactly where Watch's own #345 repair runs before `parseWatcherCard` judges a
 * card — the same "before spending" pass, over a different artefact. A story
 * whose only defect is one prose item longer than `MAX_ITEM_CHARS` is split at a
 * sentence boundary (`splitOverCapItem`, `text/listSplit.ts`) and, ONLY when
 * every resulting piece re-validates, rewritten to disk — never a partial
 * write, never a guess: an item that cannot be safely split is left exactly as
 * it was, and today's refusal stands.
 *
 * Scoped to `acceptance` and `test_plan` deliberately — the two PROSE lists
 * `story.ts` requires non-empty with no `pattern`. `touches`, `depends_on`,
 * `repos` and `stories` are identifiers and paths: splitting one at a sentence
 * boundary would corrupt it, not repair it.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FENCE, splitFrontMatter } from "../schemas/frontMatter.ts";
import { MAX_ITEM_CHARS, requireStringList } from "../schemas/planCommon.ts";
import type { ValidationIssue } from "../schemas/validation.ts";
import { quote } from "../build/storyFile.ts";
import { parseYaml } from "../yaml.ts";
import { diagnoseSrcToken, hasSrcMarker } from "../text/srcToken.ts";
import { splitOverCapItem } from "../text/listSplit.ts";
import { STORIES_DIR } from "./validatePlan.ts";

/** The only two fields this repair ever touches — see the module doc. */
const REPAIRABLE_FIELDS = ["acceptance", "test_plan"] as const;
type RepairableField = (typeof REPAIRABLE_FIELDS)[number];

export interface OverCapRepair {
  /** Relative to the phase dir, e.g. `stories/S8.md` — matches `PlanIssue.file`. */
  readonly file: string;
  readonly field: RepairableField;
  /** 0-based, into the field's list BEFORE the split. */
  readonly index: number;
  readonly before: number;
  readonly pieces: number;
}

/**
 * Split every over-cap `acceptance`/`test_plan` item this repair CAN safely
 * split, across every story file in `<planDir>/stories/`, writing repaired
 * files back to disk. Returns one `OverCapRepair` per item actually split —
 * empty when there was nothing to do, or nothing safe to do.
 */
export function repairOverCapItems(planDir: string): readonly OverCapRepair[] {
  const dir = join(planDir, STORIES_DIR);
  if (!existsSync(dir)) return [];
  const repairs: OverCapRepair[] = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".md")).sort()) {
    const abs = join(dir, name);
    const before = readFileSync(abs, "utf8");
    const result = repairStoryText(before);
    if (result === null) continue;
    writeFileSync(abs, result.text, "utf8");
    for (const repair of result.repairs) repairs.push({ file: `${STORIES_DIR}/${name}`, ...repair });
  }
  return repairs;
}

type FileRepair = Omit<OverCapRepair, "file">;

function repairStoryText(text: string): { readonly text: string; readonly repairs: readonly FileRepair[] } | null {
  const split = splitFrontMatter(text);
  if (!split.present) return null;
  let doc: unknown;
  try {
    doc = parseYaml(split.raw);
  } catch {
    return null;
  }
  if (typeof doc !== "object" || doc === null) return null;
  const record = doc as Record<string, unknown>;

  let lines = split.raw.split("\n");
  const repairs: FileRepair[] = [];
  for (const field of REPAIRABLE_FIELDS) {
    const list = record[field];
    if (!Array.isArray(list)) continue;
    // Reverse order: a splice at a HIGHER index never shifts a lower one still
    // to be processed, so re-scanning `lines` from scratch each time (below)
    // stays correct without tracking an offset.
    for (let index = list.length - 1; index >= 0; index--) {
      const item = list[index];
      if (typeof item !== "string" || item.length <= MAX_ITEM_CHARS) continue;
      const pieces = splitOverCapItem(item, MAX_ITEM_CHARS);
      if (pieces === null || !pieces.every(pieceValidates)) continue;
      const rewritten = spliceListField(lines, field, index, pieces);
      if (rewritten === null) continue;
      lines = rewritten;
      repairs.push({ field, index, before: item.length, pieces: pieces.length });
    }
  }
  if (repairs.length === 0) return null;
  return { text: [FENCE, ...lines, FENCE, split.body].join("\n"), repairs: repairs.reverse() };
}

/**
 * The SAME validator `requireStringList` refuses the original item with, plus —
 * only when the original line tried to cite something — the SAME grammar
 * `repairSrcSyntax` verifies a repair against. A repair this cannot verify is
 * not offered (mirrors `repairSrcTokenLine`, `srcToken.ts`).
 */
function pieceValidates(piece: string): boolean {
  const issues: ValidationIssue[] = [];
  requireStringList([piece], "item", issues, {});
  if (issues.length > 0) return false;
  return !hasSrcMarker(piece) || diagnoseSrcToken(piece) === null;
}

const LIST_ITEM_RE = /^\s+-\s/;

/**
 * Rewrite `field`'s list, in place, replacing the item at `index` with
 * `pieces` — surgically, over the raw front-matter LINES, never a full YAML
 * round-trip (that would reflow every OTHER key's quoting and style, exactly
 * the thing `build/storyFile.ts`'s own surgical writer avoids — one derivation
 * of "edit only what changed").
 *
 * Handles both shapes a story's `acceptance:`/`test_plan:` is seen in: a single
 * FLOW line (`key: ["a", "b"]`, what `schemaContract.ts` instructs) and a BLOCK
 * list (`key:` then one `  - "…"` line per item, what the fixtures/templates
 * predating that instruction still carry). `null` when the field cannot be
 * found or parsed in either shape — the caller leaves the file untouched.
 */
function spliceListField(
  lines: readonly string[],
  field: string,
  index: number,
  pieces: readonly string[],
): string[] | null {
  const keyRe = new RegExp(`^${field}\\s*:`);
  const at = lines.findIndex((line) => keyRe.test(line));
  if (at === -1) return null;
  const keyLine = lines[at] ?? "";
  const afterColon = keyLine.slice(keyLine.indexOf(":") + 1).trim();
  const out = [...lines];

  if (afterColon.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = parseYaml(`x: ${afterColon}`);
    } catch {
      return null;
    }
    const arr = (parsed as { x?: unknown } | null)?.x;
    if (!Array.isArray(arr) || index >= arr.length) return null;
    const next = [...arr.slice(0, index), ...pieces, ...arr.slice(index + 1)];
    out[at] = `${field}: [${next.map((v) => quote(String(v))).join(", ")}]`;
    return out;
  }

  let end = at + 1;
  const itemLines: number[] = [];
  while (end < out.length && LIST_ITEM_RE.test(out[end] ?? "")) {
    itemLines.push(end);
    end++;
  }
  const target = itemLines[index];
  if (target === undefined) return null;
  out.splice(target, 1, ...pieces.map((piece) => `  - ${quote(piece)}`));
  return out;
}

/** One report/event line per repair, or `null` when there is nothing to say. */
export function describeOverCapRepairs(repairs: readonly OverCapRepair[]): readonly string[] | null {
  if (repairs.length === 0) return null;
  return repairs.map((r) =>
    `\`${r.file}\`: ${r.field}[${String(r.index)}] was ${String(r.before)} characters (cap ${String(MAX_ITEM_CHARS)}) `
      + `— mechanically split into ${String(r.pieces)} pieces before validating`);
}
