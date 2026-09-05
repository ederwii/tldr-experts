/**
 * What `workspace.yml` says about the stack packs — read by every prompt path, so it is a
 * LEAF like `stackExperts.ts`: one file, one parse, tolerant of a file written before the
 * keys existed (absent ⇒ off, empty lists). Nothing here writes; `init/stackPacks.ts` does.
 *
 * Not folded into `hooks/lib/workspace.ts`: that loader is bundled into every hook and
 * `test/build.test.ts` caps a hook entry at 50 KB (gh #94). Prompt assembly is not a hook.
 *
 * Reading `workspace.yml` and walking `repos[]` is `./workspaceRepos.ts` — shared with
 * `stackExperts.ts`, which derives a different per-repo fact from the same file.
 */
import { readWorkspaceDocument, strings, workspaceRepoRows } from "./workspaceRepos.ts";
import type { DetectedOverlay } from "../detect/overlays.ts";
import type { DetectedSkill } from "../detect/skills.ts";

export interface RepoPacks {
  readonly name: string;
  /** `repos[].stack`, so a caller can tell which `<lang>-stack` experts a repo maps to. */
  readonly stack: readonly string[];
  readonly overlays: readonly DetectedOverlay[];
  readonly skills: readonly DetectedSkill[];
}

export interface StackPacksState {
  /** Whether the file carries a `stack_packs` block at all. */
  readonly present: boolean;
  readonly enabled: boolean;
  readonly enabledAt: string | null;
  readonly repos: readonly RepoPacks[];
}

export const NO_STACK_PACKS: StackPacksState = { present: false, enabled: false, enabledAt: null, repos: [] };

/** `root` is the directory holding `.tldrx/` — the same `root` `expertDir` takes. */
export function readStackPacks(root: string): StackPacksState {
  const doc = readWorkspaceDocument(root);
  if (typeof doc !== "object" || doc === null) return NO_STACK_PACKS;
  const record = doc as Record<string, unknown>;

  const block = record.stack_packs;
  const present = typeof block === "object" && block !== null;
  const enabled = present && (block as Record<string, unknown>).enabled === true;
  const at = present ? (block as Record<string, unknown>).enabled_at : null;

  const repos: RepoPacks[] = workspaceRepoRows(doc).map((row) => ({
    name: row.name,
    stack: strings(row.stack),
    overlays: overlaysOf(row.overlays),
    skills: skillsOf(row.skills),
  }));

  return { present, enabled, enabledAt: typeof at === "string" ? at : null, repos };
}

function overlaysOf(value: unknown): readonly DetectedOverlay[] {
  if (!Array.isArray(value)) return [];
  const out: DetectedOverlay[] = [];
  for (const item of value as unknown[]) {
    const row = item as Record<string, unknown> | null;
    if (row === null || typeof row !== "object" || typeof row.id !== "string") continue;
    out.push({ id: row.id, evidence: typeof row.evidence === "string" ? row.evidence : "" });
  }
  return out;
}

function skillsOf(value: unknown): readonly DetectedSkill[] {
  if (!Array.isArray(value)) return [];
  const out: DetectedSkill[] = [];
  for (const item of value as unknown[]) {
    const row = item as Record<string, unknown> | null;
    if (row === null || typeof row !== "object" || typeof row.name !== "string") continue;
    out.push({
      name: row.name,
      description: typeof row.description === "string" ? row.description : "",
      path: typeof row.path === "string" ? row.path : "",
      tracked: row.tracked === true,
    });
  }
  return out;
}
