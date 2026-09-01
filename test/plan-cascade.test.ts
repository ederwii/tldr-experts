/**
 * `validatePlan` must not misdiagnose a cascade as a missing file (gh #37).
 *
 * Measured on the 260829-scoring-leaderboard driver session: `acceptance[3]` in
 * `S8.md` was 1,009 characters against the 512 cap, so `S8.md` did not validate,
 * so `S8` never entered the parsed-story set — and from there the cross-file
 * checks could not tell "invalid" from "absent". The commit check reported THREE
 * errors, two of which were `S8 has no file in stories/` for a file that was
 * 5,794 bytes on disk. An agent reading that goes hunting for a missing file or
 * rewrites waves.yml; the real defect is one over-cap list item.
 *
 * The rule under test: a reference to a story whose FILE EXISTS is never
 * reported as missing. It is reported as a cascade, it says which file to fix,
 * and the root violation is what `describePlanIssues` shows first.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_ITEM_CHARS } from "../src/core/schemas/planCommon.ts";
import { describePlanIssues, validatePlan, type PlanIssue } from "../src/core/plan/validatePlan.ts";

const ALLOWED = new Set(["npm run test"]);

interface StoryOptions {
  readonly id: string;
  readonly epic?: string;
  readonly acceptance?: readonly string[];
}

function story({ id, epic = "E2", acceptance = ["it works"] }: StoryOptions): string {
  return [
    "---",
    "version: 1",
    `id: ${id}`,
    `epic: ${epic}`,
    `title: "Story ${id}"`,
    "repo: lab",
    "status: todo",
    "depends_on: []",
    'touches: ["src/"]',
    `acceptance: [${acceptance.map((a) => JSON.stringify(a)).join(", ")}]`,
    'test_plan: ["unit"]',
    "evidence: []",
    "---",
    "",
    `# ${id}`,
    "",
    "```dod",
    "npm run test",
    "```",
    "",
  ].join("\n");
}

function epicFile(id: string, stories: readonly string[]): string {
  return [
    "---",
    "version: 1",
    `id: ${id}`,
    `title: "Epic ${id}"`,
    "repos: [lab]",
    `stories: [${stories.join(", ")}]`,
    "branch: epic/leaderboard",
    "status: todo",
    "---",
    "",
    `# ${id}`,
    "",
  ].join("\n");
}

function waves(rows: readonly (readonly string[])[]): string {
  const body = rows.map((ids, i) => `  - {id: W${String(i + 1)}, stories: [${ids.join(", ")}]}`);
  return ["version: 1", "waves:", ...body, ""].join("\n");
}

interface PlanFiles {
  readonly stories: Readonly<Record<string, string>>;
  readonly epics: Readonly<Record<string, string>>;
  readonly waves: string;
}

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

function planDir(files: PlanFiles): string {
  const dir = mkdtempSync(join(tmpdir(), "tldrx-plan-"));
  dirs.push(dir);
  mkdirSync(join(dir, "stories"), { recursive: true });
  mkdirSync(join(dir, "epics"), { recursive: true });
  for (const [name, text] of Object.entries(files.stories)) {
    writeFileSync(join(dir, "stories", name), text, "utf8");
  }
  for (const [name, text] of Object.entries(files.epics)) {
    writeFileSync(join(dir, "epics", name), text, "utf8");
  }
  writeFileSync(join(dir, "waves.yml"), files.waves, "utf8");
  return dir;
}

/** The reported bug, reproduced: one over-cap item in S8, referenced twice. */
function overCapPlan(): string {
  const tooLong = "x".repeat(MAX_ITEM_CHARS + 1);
  return planDir({
    stories: {
      "S1.md": story({ id: "S1" }),
      "S8.md": story({ id: "S8", acceptance: ["it works", tooLong] }),
    },
    epics: { "E2.md": epicFile("E2", ["S1", "S8"]) },
    waves: waves([["S1", "S8"]]),
  });
}

function messagesOf(issues: readonly PlanIssue[]): string {
  return issues.map((i) => `${i.file} ${i.path}: ${i.message}`).join(" | ");
}

describe("an invalid story is not reported as a missing one (#37)", () => {
  test("the root violation is reported, as itself", () => {
    const report = validatePlan(overCapPlan(), ALLOWED);
    expect(report.ok).toBe(false);
    const root = report.issues.find((i) => i.file === "stories/S8.md");
    expect(root?.path).toBe("acceptance[1]");
    expect(root?.message).toContain(`${String(MAX_ITEM_CHARS)}-character cap`);
  });

  test("nothing claims S8 has no file, because S8.md exists", () => {
    const report = validatePlan(overCapPlan(), ALLOWED);
    expect(messagesOf(report.issues)).not.toContain("S8 has no file");
  });

  test("the epic's and the wave's references are annotated as cascades", () => {
    const report = validatePlan(overCapPlan(), ALLOWED);
    const fromEpic = report.issues.find((i) => i.file === "epics/E2.md");
    const fromWaves = report.issues.find((i) => i.file === "waves.yml");
    for (const issue of [fromEpic, fromWaves]) {
      expect(issue?.cascade).toBe(true);
      expect(issue?.message).toContain("stories/S8.md");
      expect(issue?.message).toContain("failed validation");
    }
  });

  test("`describePlanIssues` shows the root violation before the cascades", () => {
    const report = validatePlan(overCapPlan(), ALLOWED);
    const line = describePlanIssues(report.issues);
    expect(line.startsWith("stories/S8.md acceptance[1]:")).toBe(true);
  });

  test("a story that is genuinely absent is still reported as absent", () => {
    const dir = planDir({
      stories: { "S1.md": story({ id: "S1" }) },
      epics: { "E2.md": epicFile("E2", ["S1", "S9"]) },
      waves: waves([["S1", "S9"]]),
    });
    const report = validatePlan(dir, ALLOWED);
    const absent = report.issues.filter((i) => i.message.includes("S9 has no file in stories/"));
    expect(absent.length).toBe(2);
    for (const issue of absent) expect(issue.cascade).toBeUndefined();
  });

  test("an invalid EPIC does not read as a missing epic either", () => {
    const dir = planDir({
      stories: { "S1.md": story({ id: "S1" }) },
      // `branch:` is not `epic/<slug>`, so E2.md does not validate.
      epics: { "E2.md": epicFile("E2", ["S1"]).replace("branch: epic/leaderboard", "branch: main") },
      waves: waves([["S1"]]),
    });
    const report = validatePlan(dir, ALLOWED);
    expect(messagesOf(report.issues)).not.toContain("E2 has no file");
    const cascade = report.issues.find((i) => i.file === "stories/S1.md" && i.path === "epic");
    expect(cascade?.cascade).toBe(true);
    expect(cascade?.message).toContain("epics/E2.md");
  });
});
