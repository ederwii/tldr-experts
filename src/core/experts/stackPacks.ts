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

/** A detected skill with the repo that declares it — `path` is repo-relative, so it needs one. */
export interface RepoSkill extends DetectedSkill {
  readonly repo: string;
}

/** Skills of `repos`, deduplicated, sorted by name (then repo) — what every prompt renders. */
export function skillsFor(state: StackPacksState, repos: readonly string[]): readonly RepoSkill[] {
  const seen = new Map<string, RepoSkill>();
  for (const repo of state.repos) {
    if (!repos.includes(repo.name)) continue;
    for (const skill of repo.skills) {
      // Keyed by repo AND path, not path alone: `.claude/skills/x/SKILL.md` under two repos
      // is two different files, and one row standing for both would make the untracked
      // warning name a repo the file might not be in.
      const key = `${repo.name}\u0000${skill.path}`;
      if (!seen.has(key)) seen.set(key, { ...skill, repo: repo.name });
    }
  }
  return [...seen.values()].sort((a, b) =>
    a.name < b.name ? -1
      : a.name > b.name ? 1
        : a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0);
}

/** How much of a `description` a prompt line carries before it is cut with an ellipsis. */
export const SKILL_DESCRIPTION_MAX_CHARS = 200;

/**
 * One line, bounded — the single gate every `workspace.yml` value passes through on its way
 * into a prompt.
 *
 * Detection writes flat one-line strings, but `readStackPacks` reads a FILE a human may edit,
 * and YAML has block scalars: a `description` holding `\n## Checks\n…` would open a heading in
 * the assembled prompt, and everything under it would read as the framework's own section
 * rather than as one repo's `SKILL.md` blurb. Flattening whitespace is what makes a heading
 * impossible; the cap is what stops one description from being the prompt.
 */
function oneLine(value: string, maxChars?: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  if (maxChars === undefined || flat.length <= maxChars) return flat;
  return `${flat.slice(0, maxChars - 1).trimEnd()}…`;
}

/**
 * The body of `## Project skills`, or `""` when there are none — and then no section is
 * emitted at all. Skills are for DOING: the harness loads and invokes them; this only
 * says they exist, in the skill's own words (decision 6). Independent of the switch:
 * `stack_packs.enabled` governs pack CONTENT (overlays, Checks), and a project's own
 * skills are not pack content — they are the project, and they exist either way.
 *
 * **Provider-neutral by construction.** It used to say "invoke it with the Skill tool",
 * which is a promise only one provider's allowance can keep: `buildCodexArgs`
 * (`facilitator/spawnAgent.ts`) sends NO tool list at all, so under Codex the prompt was
 * naming a tool the agent does not have and the `{ skills: true }` allowance went nowhere.
 * The row now carries the SKILL.md PATH, which every provider can read, and the tool is
 * offered as the alternative rather than the instruction.
 *
 * `[unverified]` Whether an agent CLI's print mode actually denies a `Skill` call that is
 * not in `--allowedTools` has not been measured here. The framework's job is the list.
 */
export function renderProjectSkills(skills: readonly DetectedSkill[]): string {
  if (skills.length === 0) return "";
  return [
    "Skills installed in this project. Each row names a skill and the path to its `SKILL.md`.",
    "Before you work in an area a skill's description covers, READ that file at the path shown:",
    "it is how this project wants that job done, and it outranks the Defaults of any expert",
    "above. Where your harness exposes skills as a tool of their own, invoking the skill does",
    "the same thing.",
    "",
    ...skills.map((skill) => {
      const description = oneLine(skill.description, SKILL_DESCRIPTION_MAX_CHARS);
      return `- ${oneLine(skill.name)} — ${description === "" ? "(no description)" : description}`
        + ` — \`${oneLine(skill.path)}\``
        + (skill.tracked ? "" : " (untracked: not present in story worktrees)");
    }),
  ].join("\n");
}

/**
 * One line per untracked skill, for the Build opening lines: a skill the worktree cannot see.
 *
 * The REPO is named because `path` is repo-relative: in a multi-repo run
 * `.claude/skills/x/SKILL.md` on its own does not say which checkout to look in, and the
 * operator reading the warning is being asked to go find the file.
 */
export function untrackedSkillWarnings(skills: readonly RepoSkill[]): readonly string[] {
  return skills
    .filter((skill) => !skill.tracked)
    .map((skill) =>
      `warning: project skill ${oneLine(skill.name)} in ${oneLine(skill.repo)} is untracked `
      + `(${oneLine(skill.path)}) — not present in story worktrees`);
}
