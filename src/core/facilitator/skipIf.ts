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
import { isAdvisory, openBlocks, parseQuestions } from "../text/questions.ts";
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
 *   questions = BLOCKING open question blocks across every phase folder of the
 *               run — `advisory: true` ones do not count (#169, fix round 2)
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
    total += blockingQuestionIds(join(runDir, phase, "questions.md")).length;
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

/**
 * EVERY open question id in one questions.md. A file that will not parse has none.
 *
 * Unfiltered on purpose: this is what the surfaces that LIST questions read — the
 * status line and the session-start nudge (`statusline/runSnapshot.ts`) — and
 * declining to STOP for an advisory question is not the same as hiding it. The
 * readers that COUNT take `blockingQuestionIds` below.
 */
export function openQuestionIds(path: string): readonly string[] {
  if (!existsSync(path)) return [];
  try {
    return openBlocks(parseQuestions(readFileSync(path, "utf8")).blocks).map((block) => block.id);
  } catch {
    return [];
  }
}

/**
 * The open question ids that actually BLOCK — every `status: open` block except
 * the ones marked `advisory: true` (#169, fix round 2).
 *
 * The ONE place the counting readers go through: `runNext`'s `awaiting_answer`
 * branch, the `skip_if: questions<=N` counter above, and `waiting.ts`'s cursor
 * view. `autoGate` applies the same `isAdvisory` predicate directly rather than
 * calling this, because it must also NAME the blocks it skipped and so needs both
 * halves back — one predicate, two shapes, never two definitions of advisory.
 *
 * A file that will not parse has none HERE too, exactly as before: this function
 * changes which open blocks count, never what an unreadable file means. The auto
 * gate is the reader that turns an unparseable questions.md into a refusal, and
 * it still does.
 */
export function blockingQuestionIds(path: string): readonly string[] {
  if (!existsSync(path)) return [];
  try {
    return openBlocks(parseQuestions(readFileSync(path, "utf8")).blocks)
      .filter((block) => !isAdvisory(block))
      .map((block) => block.id);
  } catch {
    return [];
  }
}
