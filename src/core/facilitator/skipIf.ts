/**
 * `workflows/<scope>.yml` `stages[].skip_if` (spec §2.4).
 *
 * The grammar is deliberately tiny — `^(stories|repos|questions)(<=|>=|==|<|>)\d{1,4}$` —
 * because a scope preset is data, and data that can express arbitrary conditions
 * is a scripting language nobody agreed to ship. Anything outside the grammar is
 * a schema error, not a "false".
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openBlocks, parseQuestions } from "../text/questions.ts";
import type { RunFile } from "../run/RunFile.ts";

export const SKIP_IF_RE = /^(stories|repos|questions)(<=|>=|==|<|>)(\d{1,4})$/;

export class SkipIfError extends Error {}

export interface SkipCounts {
  readonly stories: number;
  readonly repos: number;
  readonly questions: number;
}

export function evaluateSkipIf(expression: string, counts: SkipCounts): boolean {
  const match = SKIP_IF_RE.exec(expression.trim());
  if (match === null) {
    throw new SkipIfError(
      `skip_if '${expression}' does not match ^(stories|repos|questions)(<=|>=|==|<|>)\\d{1,4}$`,
    );
  }
  const left = counts[match[1] as keyof SkipCounts];
  const right = Number(match[3]);
  switch (match[2]) {
    case "<=": return left <= right;
    case ">=": return left >= right;
    case "==": return left === right;
    case "<": return left < right;
    case ">": return left > right;
    default: throw new SkipIfError(`unreachable operator '${match[2] ?? ""}'`);
  }
}

/**
 * `[assumption]` — the spec names the three variables but not where they are
 * counted from. Taken, in each case, the only place the number actually exists:
 *   stories   = `*.md` under `<run>/03-plan/stories/`
 *   repos     = `run.repos.length`
 *   questions = OPEN question blocks across every phase folder of the run
 */
export function countSkipInputs(runDir: string, run: RunFile): SkipCounts {
  return {
    stories: countStories(runDir),
    repos: run.repos.length,
    questions: countOpenQuestions(runDir),
  };
}

function countStories(runDir: string): number {
  const dir = join(runDir, "03-plan", "stories");
  if (!existsSync(dir)) return 0;
  try {
    return readdirSync(dir).filter((name) => name.endsWith(".md")).length;
  } catch {
    return 0;
  }
}

function countOpenQuestions(runDir: string): number {
  let total = 0;
  for (const phase of phaseDirs(runDir)) {
    total += openQuestionIds(join(runDir, phase, "questions.md")).length;
  }
  return total;
}

export function phaseDirs(runDir: string): readonly string[] {
  try {
    return readdirSync(runDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^0[1-9]-/.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** Open question ids in one questions.md. A file that will not parse has none. */
export function openQuestionIds(path: string): readonly string[] {
  if (!existsSync(path)) return [];
  try {
    return openBlocks(parseQuestions(readFileSync(path, "utf8")).blocks).map((block) => block.id);
  } catch {
    return [];
  }
}
