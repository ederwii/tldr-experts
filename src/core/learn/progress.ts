/**
 * Which chapters the learner has finished — as a file in the sandbox, because
 * everything in this framework is a file and a tutorial about that should not be
 * the exception.
 *
 * `<sandbox>/progress.json`, and nowhere else. Deleting the sandbox is how you
 * start over (`--reset` does exactly that), and a `learn` that resumes is a
 * `learn` that read this file.
 *
 * Fail-soft on read, on purpose: a corrupt progress file means the learner
 * replays a chapter, which costs two minutes and nothing else. Fail-CLOSED would
 * mean a tutorial that refuses to start because of its own bookkeeping.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface Progress {
  readonly version: 1;
  /** Chapter numbers that have been completed, ascending, without duplicates. */
  readonly completed: readonly number[];
  /** ISO-8601, or null before anything has been finished. */
  readonly updatedAt: string | null;
}

export const NO_PROGRESS: Progress = { version: 1, completed: [], updatedAt: null };

export function readProgress(path: string): Progress {
  if (!existsSync(path)) return NO_PROGRESS;
  try {
    const doc: unknown = JSON.parse(readFileSync(path, "utf8"));
    const completed = (doc as { completed?: unknown }).completed;
    if (!Array.isArray(completed)) return NO_PROGRESS;
    const numbers = completed.filter((n): n is number => typeof n === "number" && Number.isFinite(n));
    const updatedAt = (doc as { updatedAt?: unknown }).updatedAt;
    return {
      version: 1,
      completed: sortUnique(numbers),
      updatedAt: typeof updatedAt === "string" ? updatedAt : null,
    };
  } catch {
    return NO_PROGRESS;
  }
}

export function writeProgress(path: string, progress: Progress): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(progress, null, 2)}\n`, "utf8");
}

/** Record a finished chapter. Idempotent — replaying chapter 2 does not add it twice. */
export function markComplete(progress: Progress, chapter: number, at: string): Progress {
  return {
    version: 1,
    completed: sortUnique([...progress.completed, chapter]),
    updatedAt: at,
  };
}

export function isComplete(progress: Progress, chapter: number): boolean {
  return progress.completed.includes(chapter);
}

/**
 * Where `learn` picks up: the lowest chapter number that is not finished, or null
 * when they all are.
 *
 * Lowest-unfinished rather than highest-finished-plus-one, so a learner who
 * jumped ahead with `--chapter 6` and then ran a bare `learn` is taken back to
 * the gap rather than past it.
 */
export function resumeAt(progress: Progress, chapters: readonly number[]): number | null {
  for (const n of chapters) if (!isComplete(progress, n)) return n;
  return null;
}

function sortUnique(numbers: readonly number[]): readonly number[] {
  return [...new Set(numbers)].sort((a, b) => a - b);
}
