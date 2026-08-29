/**
 * Spec §2.3 `stack_experts: also load stack expertise for run.repos`.
 *
 * `[assumption]` — `tldrx init` names these `<language>-stack`
 * (`src/core/init/planExperts.ts`), so the mapping is repo -> its detected
 * languages -> `<language>-stack`. Moved out of `src/core/facilitator/prompt.ts`
 * (where it lived until the knowledge wave) so `src/core/experts/` can compose the
 * whole selection rule without importing the facilitator; `prompt.ts` still
 * re-exports it, so every existing import keeps working.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_FRAMEWORK_DIR } from "../paths.ts";
import { parseYaml } from "../yaml.ts";

export function stackExpertNames(root: string, repos: readonly string[]): readonly string[] {
  const path = join(root, PROJECT_FRAMEWORK_DIR, "workspace.yml");
  if (!existsSync(path)) return [];
  let doc: unknown;
  try {
    doc = parseYaml(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
  const list = (doc as { repos?: unknown } | null)?.repos;
  if (!Array.isArray(list)) return [];

  const names: string[] = [];
  for (const row of list as { name?: unknown; stack?: unknown }[]) {
    if (typeof row?.name !== "string" || !repos.includes(row.name)) continue;
    const stack = Array.isArray(row.stack) ? (row.stack as unknown[]) : [];
    for (const language of stack) {
      if (typeof language !== "string" || language === "") continue;
      const expert = `${language}-stack`;
      if (!names.includes(expert)) names.push(expert);
    }
  }
  return names;
}
