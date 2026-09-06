/**
 * Project skills are NAMED, never loaded (stack packs design decision 6): the harness
 * invokes a skill, the framework only tells the developer it exists. `tracked` is the
 * load-bearing bit — Build runs in a worktree of tracked files, so an untracked skill is
 * absent exactly where the story is written.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpawnCommandRunner } from "../src/core/detect/CommandRunner.ts";
import { detectSkills, SKILLS_DIR } from "../src/core/detect/skills.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

// Every test here runs a REAL `git`. Process cost is a property of the machine, so the
// fixed 5000 ms default would measure the box (#43); the budget scales with measured load.
setDefaultTimeout(spawnTestTimeout());

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

/** A real repo with a private $TMPDIR for every git it spawns (#95/#97). */
function repo(): { root: string; git: (...args: string[]) => void } {
  const root = mkdtempSync(join(tmpdir(), "tldrx-skills-"));
  const scratch = mkdtempSync(join(tmpdir(), "tldrx-skills-tmp-"));
  dirs.push(root, scratch);
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: root, stdio: "pipe", env: { ...process.env, TMPDIR: scratch } });
  };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "fixture@example.com");
  git("config", "user.name", "Fixture");
  return { root, git };
}

function skill(root: string, dir: string, frontMatter: string): void {
  mkdirSync(join(root, SKILLS_DIR, dir), { recursive: true });
  writeFileSync(join(root, SKILLS_DIR, dir, "SKILL.md"), `---\n${frontMatter}\n---\n\n# body\n`, "utf8");
}

const runner = new SpawnCommandRunner();

describe("detectSkills", () => {
  test("no .claude/skills directory is an empty list, not an error", async () => {
    const { root } = repo();
    expect(await detectSkills(root, runner)).toEqual([]);
  });

  test("name and description come from the front matter; tracked follows git", async () => {
    const { root, git } = repo();
    skill(root, "impeccable", "name: impeccable\ndescription: Use when the user wants to design a page");
    skill(root, "scratch", "name: scratch\ndescription: Not committed yet");
    git("add", `${SKILLS_DIR}/impeccable`);
    git("commit", "-q", "-m", "skill", "--no-gpg-sign");

    const found = await detectSkills(root, runner);
    expect(found).toEqual([
      { name: "impeccable", description: "Use when the user wants to design a page", path: ".claude/skills/impeccable/SKILL.md", tracked: true },
      { name: "scratch", description: "Not committed yet", path: ".claude/skills/scratch/SKILL.md", tracked: false },
    ]);
  });

  test("a directory without SKILL.md is not a skill; a missing name falls back to the directory", async () => {
    const { root } = repo();
    mkdirSync(join(root, SKILLS_DIR, "empty"), { recursive: true });
    skill(root, "nameless", "description: only a description");
    const found = await detectSkills(root, runner);
    expect(found.map((item) => item.name)).toEqual(["nameless"]);
    expect(found[0]?.description).toBe("only a description");
  });
});
