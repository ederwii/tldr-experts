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
