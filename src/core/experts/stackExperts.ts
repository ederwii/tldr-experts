/**
 * Spec §2.3 `stack_experts: also load stack expertise for run.repos`.
 *
 * `[assumption]` — `tldrx init` names these `<language>-stack`
 * (`src/core/init/planExperts.ts`), so the mapping is repo -> its detected
 * languages -> `<language>-stack`. Moved out of `src/core/facilitator/prompt.ts`
 * (where it lived until the knowledge wave) so `src/core/experts/` can compose the
 * whole selection rule without importing the facilitator; `prompt.ts` still
 * re-exports it, so every existing import keeps working.
 *
 * Reading `workspace.yml` and walking `repos[]` is `./workspaceRepos.ts` — shared with
 * `stackPacks.ts`, which derives a different per-repo fact from the same file.
 */
import { readWorkspaceDocument, strings, workspaceRepoRows } from "./workspaceRepos.ts";

export function stackExpertNames(root: string, repos: readonly string[]): readonly string[] {
  const names: string[] = [];
  for (const row of workspaceRepoRows(readWorkspaceDocument(root))) {
    if (!repos.includes(row.name)) continue;
    // Empty-string entries name no expert; excluded here rather than in the shared
    // `strings()` coercion, which every other caller wants unfiltered.
    for (const language of strings(row.stack).filter((item) => item !== "")) {
      const expert = `${language}-stack`;
      if (!names.includes(expert)) names.push(expert);
    }
  }
  return names;
}
