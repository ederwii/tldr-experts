/**
 * Project skills — `.claude/skills/<name>/SKILL.md` — detected and NAMED, never loaded.
 *
 * Skills are for doing and packs are for checking (stack packs design decision 6): the
 * harness loads and invokes a skill; the framework only tells the developer they exist,
 * with the `description` each skill declares for itself. `tracked` matters because Build
 * runs in a worktree that carries tracked files only — an untracked skill does not exist
 * where the story is written, and the prompt says so.
 *
 * The front matter is read with the one parser `expert.md` already has
 * (`experts/expertDocument.ts`); a second YAML-ish reader for the same `---` block is the
 * kind of copy #80 was filed over. Known limit, inherited from that parser: a `#` inside a
 * description ends it (`C# projects` reads as `C`). Evidence-only field; not fixed here.
 */
import { join } from "node:path";
import { runtime } from "../runtime/index.ts";
import { splitFrontMatter } from "../experts/expertDocument.ts";
import { readEntries } from "./walk.ts";
import type { CommandRunner } from "./CommandRunner.ts";

export const SKILLS_DIR = ".claude/skills";
export const SKILL_FILE = "SKILL.md";

export interface DetectedSkill {
  readonly name: string;
  readonly description: string;
  /** Repo-relative, POSIX: `.claude/skills/<dir>/SKILL.md`. */
  readonly path: string;
  /** `git ls-files --error-unmatch` exit 0. False ⇒ absent from story worktrees. */
  readonly tracked: boolean;
}

export async function detectSkills(repoDir: string, runner: CommandRunner): Promise<readonly DetectedSkill[]> {
  const skills: DetectedSkill[] = [];
  for (const entry of await readEntries(join(repoDir, SKILLS_DIR))) {
    if (!entry.isDirectory()) continue;
    const rel = `${SKILLS_DIR}/${entry.name}/${SKILL_FILE}`;
    const abs = join(repoDir, rel);
    if (!(await runtime.exists(abs))) continue;
    const { frontMatter } = splitFrontMatter(await runtime.readText(abs));
    const tracked = (await runner.run(["git", "ls-files", "--error-unmatch", "--", rel], repoDir)).exitCode === 0;
    skills.push({
      name: frontMatter.get("name") ?? entry.name,
      description: frontMatter.get("description") ?? "",
      path: rel,
      tracked,
    });
  }
  return skills;
}
