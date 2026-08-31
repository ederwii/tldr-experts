/**
 * Is there a `--prepare` bundle sitting in this stage's `.agent/` folder?
 *
 * The one cut with no `.lock` behind it (2026-08-29 audit, §A): `tldrx next
 * --prepare` writes `prompt.md` + `pending.json`, marks the stage `running`, and
 * RELEASES the lock — the host session is meant to run the prompt and come back
 * through `--commit`. Kill the session there and the run is left `running` with
 * no lock, which every reader called `ready` and `tldrx next` answered by
 * spawning the stage again — throwing away work that was already paid for.
 *
 * So both readers ask the same question here: `run/waiting.ts` to say what the
 * run is waiting on, and `facilitator/runNext.ts` to refuse the re-spawn.
 *
 * Two shapes, because the Build executor bundles per story rather than per stage:
 *   `.agent/<stage>/pending.json`            one sub-agent for the stage
 *   `.agent/<stage>/<story>/pending.json`    one per story
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const PENDING_JSON = "pending.json";

/** Directories holding a `pending.json` for this stage, run-dir relative order. */
export function preparedBundles(runDir: string, stageId: string): readonly string[] {
  const dir = join(runDir, ".agent", stageId);
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  if (existsSync(join(dir, PENDING_JSON))) found.push(dir);
  let entries: readonly string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return found;
  }
  for (const entry of entries) {
    const child = join(dir, entry);
    try {
      if (!statSync(child).isDirectory()) continue;
    } catch {
      continue;
    }
    if (existsSync(join(child, PENDING_JSON))) found.push(child);
  }
  return found;
}

export function hasPreparedBundle(runDir: string, stageId: string): boolean {
  return preparedBundles(runDir, stageId).length > 0;
}

/**
 * `.agent/<stage>/<story>/review/` — the REVIEWER half of the Build handshake
 * (design §B.3).
 *
 * Deliberately one level below what `preparedBundles` walks, and that is not an
 * accident of layout: a review bundle is not a `--prepare` bundle waiting for a
 * developer's `result.json`, and `preparedRefusal` must never read one as if it
 * were. Nesting it keeps the two shapes apart with no flag to get wrong.
 *
 * Its presence IS the state, the way every other file here is: it is written when
 * the framework hands a review to the host, and removed when `--commit --review`
 * settles the verdict. So "is this story waiting on a host review?" is one
 * `existsSync`, answerable by a fresh process with no ledger arithmetic.
 */
export const REVIEW_DIR = "review";

/** Story dirs of this stage holding a reviewer bundle, in directory order. */
export function reviewBundles(runDir: string, stageId: string): readonly string[] {
  const dir = join(runDir, ".agent", stageId);
  if (!existsSync(dir)) return [];
  let entries: readonly string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    const review = join(dir, entry, REVIEW_DIR);
    if (existsSync(join(review, PENDING_JSON))) found.push(review);
  }
  return found;
}

/** True when any story of this stage has a reviewer bundle out. */
export function hasReviewBundle(runDir: string, stageId: string): boolean {
  return reviewBundles(runDir, stageId).length > 0;
}
