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

/** The heading the rendered section carries, in every prompt shape (precedent: `## Dispatch notes`). */
export const PROJECT_SKILLS_HEADING = "Project skills";

/** Skills of `repos`, deduplicated by path, sorted by name — the list every prompt renders. */
export function skillsFor(state: StackPacksState, repos: readonly string[]): readonly DetectedSkill[] {
  const byPath = new Map<string, DetectedSkill>();
  for (const repo of state.repos) {
    if (!repos.includes(repo.name)) continue;
    for (const skill of repo.skills) if (!byPath.has(skill.path)) byPath.set(skill.path, skill);
  }
  return [...byPath.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * The body of `## Project skills`, or `""` when there are none — and then no section is
 * emitted at all. Skills are for DOING: the harness loads and invokes them; this only
 * says they exist, in the skill's own words (decision 6). Independent of the switch:
 * `stack_packs.enabled` governs pack CONTENT (overlays, Checks), and a project's own
 * skills are not pack content — they are the project, and they exist either way.
 *
 * `[unverified]` Whether an agent CLI's print mode actually denies a `Skill` call that
 * is not in `--allowedTools` has not been measured here. The framework's job is the
 * list: name the skills, and put `Skill` in the allowance when there is one to invoke.
 */
export function renderProjectSkills(skills: readonly DetectedSkill[]): string {
  if (skills.length === 0) return "";
  return [
    "Skills installed in this project (`.claude/skills/<name>/SKILL.md`). When a skill's",
    "description matches the work, invoke it with the Skill tool: it is how this project wants",
    "that job done, and it outranks the Defaults of any expert above.",
    "",
    ...skills.map((skill) =>
      `- ${skill.name} — ${skill.description === "" ? "(no description)" : skill.description}`
      + (skill.tracked ? "" : " (untracked: not present in story worktrees)")),
  ].join("\n");
}

/** One line per untracked skill, for the Build opening lines: a skill the worktree cannot see. */
export function untrackedSkillWarnings(skills: readonly DetectedSkill[]): readonly string[] {
  return skills
    .filter((skill) => !skill.tracked)
    .map((skill) => `warning: project skill ${skill.name} is untracked (${skill.path}) — not present in story worktrees`);
}
