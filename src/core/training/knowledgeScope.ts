/**
 * What one expert is allowed to speak for, assembled off disk.
 *
 * Two facts, both already written down by `tldrx init` and both editable by the
 * team, and neither of them guessed:
 *
 *   - the expert's own `## Domain` bullets (`expertDomain.ts`), which say which
 *     folders it owns. A citation outside them is not a lie — it is knowledge
 *     filed under the wrong name, and the fix is to train the expert that DOES
 *     own the folder, so the warning names it when one matches;
 *   - every `src` already on record in this expert's OTHER areas, so one reading
 *     cannot be sold twice by moving it to a second area.
 *
 * Measured 2026-08-29 on `~/aparece-v2`: 29% / 55% / 22% of the three trained
 * experts' citations were outside their own declared `## Domain`, and 16 files
 * were cited by two experts each. The domain declarations were right; nothing was
 * reading them.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { readExpertDomain } from "../experts/expertDomain.ts";
import { expertsDir } from "../experts/loadExperts.ts";
import type { ExpertRecord } from "../experts/ExpertRecord.ts";
import type { KnowledgeScope } from "./knowledgeFile.ts";

/** Every expert folder's declared `## Domain` paths, by name. */
export function allExpertDomains(root: string): ReadonlyMap<string, readonly string[]> {
  const out = new Map<string, readonly string[]>();
  const dir = expertsDir(root);
  if (!existsSync(dir)) return out;
  let names: string[];
  try {
    names = readdirSync(dir).filter((entry) => statSync(join(dir, entry)).isDirectory()).sort();
  } catch {
    return out;
  }
  for (const name of names) {
    const paths = readExpertDomain(root, name).paths;
    if (paths.length > 0) out.set(name, paths);
  }
  return out;
}

export function knowledgeScopeFor(root: string, expert: ExpertRecord, areaId: string): KnowledgeScope {
  const seenSrc = new Set<string>();
  for (const area of expert.areas) {
    if (area.id === areaId) continue;
    for (const row of area.evidence) seenSrc.add(row.src);
  }
  return {
    expert: expert.name,
    domainPaths: readExpertDomain(root, expert.name).paths,
    otherDomains: allExpertDomains(root),
    seenSrc,
  };
}
