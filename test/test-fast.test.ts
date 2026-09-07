/**
 * `commands.test_fast:` — the developer's iteration instrument (measured, 2026-09-07).
 *
 * The framework gave a story's developer exactly one test command: a ```dod line must
 * be byte-equal to a `workspace.yml` command (`plan/validatePlan.ts`), and the developer
 * prompt says those commands "are the only ones you may run, and they are the same ones
 * the Definition of Done re-runs" (`build/prompts.ts`). On three real workspaces that
 * made the whole suite the only instrument on offer: one of them is 11,929 tests across
 * 855 files, and a developer iterating a story ran it 6–10 times while the Definition of
 * Done ran it 2–3 more (preflight once per run, cached, then once per attempt).
 *
 * `test_fast` is the second speed, and it is deliberately NOT part of the Definition of
 * Done: a suite that proves a story is not the subset that guides its author. So the
 * rules pinned here are the two halves of that —
 *
 *   - it loads, and a workspace that never declares it is read exactly as before;
 *   - a ```dod line equal to it is REFUSED, with a sentence that names the slot rather
 *     than the generic "not one of workspace.yml's commands", which would be false.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseYaml } from "../src/core/yaml.ts";
import { validateWorkspace } from "../src/core/schemas/workspace.ts";
import { loadWorkspace } from "../src/hooks/lib/workspace.ts";
import {
  ITERATION_ONLY_SLOT, iterationOnlyDodMessage, notDeclaredMessage,
} from "../src/core/schemas/commandAllowlist.ts";
import { parseDodBlock, validateStoryDod, validateStoryFile } from "../src/core/schemas/story.ts";
import { validatePlan } from "../src/core/plan/validatePlan.ts";
import { buildDeveloperPrompt, testFastRule } from "../src/core/build/prompts.ts";
import type { PlannedEpic, PlannedStory } from "../src/core/build/plan.ts";
import { WORKSPACE_FILE_HEADER, renderWorkspaceFile } from "../src/core/init/workspaceDocument.ts";
import { probeCommands } from "../src/core/detect/probeCommands.ts";
import type { CommandResult, CommandRunner } from "../src/core/detect/CommandRunner.ts";
import { MANDATE_MAX_LINES, MANDATE_TLDR_MAX_LINES, renderMandate } from "../src/core/drive/mandate.ts";

const FULL = "npm run test";
const FAST = "npm run test -- --changed";

const dirs: string[] = [];

function workspaceDir(fast: string | null): string {
  const root = mkdtempSync(join(tmpdir(), "tldrx-test-fast-"));
  dirs.push(root);
  mkdirSync(join(root, ".tldrx"), { recursive: true });
  const commands = [`      test: "${FULL}"`, `      lint: "npm run lint"`];
  if (fast !== null) commands.push(`      ${ITERATION_ONLY_SLOT}: "${fast}"`);
  writeFileSync(
    join(root, ".tldrx", "workspace.yml"),
    ["version: 1", "mode: single", 'root: "."', "repos:", "  - name: app",
      '    path: "."', "    commands:", ...commands, ""].join("\n"),
    "utf8",
  );
  return root;
}

// ---------------------------------------------------------------------------
// (a) The schema and the loader
// ---------------------------------------------------------------------------

describe("workspace.yml grows a test_fast slot", () => {
  test("a workspace declaring it validates, and the loader names it", () => {
    const root = workspaceDir(FAST);
    const doc = parseYaml(readFileSync(join(root, ".tldrx", "workspace.yml"), "utf8"));
    expect(validateWorkspace(doc).ok).toBe(true);
    const workspace = loadWorkspace(root);
    expect(workspace.iterationCommands.has(FAST)).toBe(true);
    // It is still a DECLARED command: the allowlist is what may be run at all, and
    // the developer is meant to run this one.
    expect(workspace.commands.has(FAST)).toBe(true);
    expect(workspace.commandRoles.get("app")?.get(ITERATION_ONLY_SLOT)).toBe(FAST);
  });

  test("a workspace WITHOUT it reads exactly as before — no slot, no iteration set", () => {
    const workspace = loadWorkspace(workspaceDir(null));
    expect(workspace.iterationCommands.size).toBe(0);
    expect([...workspace.commands].sort()).toEqual(["npm run lint", FULL]);
    expect(workspace.commandRoles.get("app")?.has(ITERATION_ONLY_SLOT)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (b) It is never a Definition of Done command
// ---------------------------------------------------------------------------

const STORY_TEXT = (command: string): string => [
  "---", "version: 1", "id: S1", "epic: E1", 'title: "One story"', "repo: app",
  "status: todo", "depends_on: []", 'touches: ["src/"]',
  'acceptance: ["it works"]', 'test_plan: ["$ npm run test -> exit 0"]', "evidence: []",
  "---", "", "```dod", command, "```", "",
].join("\n");

describe("a dod line may not name test_fast", () => {
  const allowed = new Set([FULL, FAST]);
  const iteration = new Set([FAST]);

  test("refused, and the sentence NAMES the slot", () => {
    const issues = validateStoryDod(parseDodBlock("```dod\n" + FAST + "\n```"), allowed, "dod", iteration);
    expect(issues.map((issue) => issue.message)).toEqual([iterationOnlyDodMessage(FAST)]);
    // Not the generic refusal: the command IS declared, so saying it is not would be false.
    expect(issues[0]?.message).not.toBe(notDeclaredMessage(FAST, "story"));
    expect(issues[0]?.message).toContain(ITERATION_ONLY_SLOT);
  });

  test("the full test command in the same allowlist is untouched", () => {
    expect(validateStoryDod(parseDodBlock("```dod\n" + FULL + "\n```"), allowed, "dod", iteration))
      .toEqual([]);
  });

  test("validateStoryFile and validatePlan carry the refusal", () => {
    expect(validateStoryFile(STORY_TEXT(FAST), allowed, iteration).validation.issues
      .map((issue) => issue.message)).toContain(iterationOnlyDodMessage(FAST));

    const planDir = mkdtempSync(join(tmpdir(), "tldrx-test-fast-plan-"));
    dirs.push(planDir);
    mkdirSync(join(planDir, "stories"), { recursive: true });
    mkdirSync(join(planDir, "epics"), { recursive: true });
    writeFileSync(join(planDir, "stories", "S1.md"), STORY_TEXT(FAST), "utf8");
    writeFileSync(
      join(planDir, "epics", "E1.md"),
      ["---", "version: 1", "id: E1", 'title: "One epic"', "repos: [app]",
        "stories: [S1]", "branch: epic/two-speed", "status: todo", "---", "", "# E1", ""].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(planDir, "waves.yml"),
      ["version: 1", "waves:", "  - id: W1", "    stories: [S1]", ""].join("\n"),
      "utf8",
    );
    const report = validatePlan(planDir, allowed, iteration);
    expect(report.ok).toBe(false);
    expect(report.issues.map((issue) => issue.message)).toContain(iterationOnlyDodMessage(FAST));
    // With no iteration set declared, the SAME plan validates — the refusal is the
    // slot's, not the string's.
    expect(validatePlan(planDir, allowed).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (c) The developer prompt
// ---------------------------------------------------------------------------

const EPIC: PlannedEpic = {
  epic: {
    version: 1, id: "E1", title: "One epic", repos: ["app"],
    stories: ["S1"], branch: "epic/two-speed", status: "todo",
  },
  text: "# E1\n",
  path: "/nowhere/E1.md",
  rel: "03-plan/epics/E1.md",
};

const STORY: PlannedStory = {
  story: {
    version: 1, id: "S1", epic: "E1", title: "One story",
    repo: "app", status: "todo", depends_on: [], touches: [],
    acceptance: ["it works"], test_plan: ["$ npm run test -> exit 0"], evidence: [],
  },
  dod: { present: true, commands: [FULL] },
  text: "# S1\n",
  path: "/nowhere/S1.md",
  rel: "03-plan/stories/S1.md",
  wave: "W1",
  goal: [],
};

function devPrompt(testFast?: { readonly fast: string; readonly full: string | null }): string {
  return buildDeveloperPrompt({
    runId: "260907-two-speed",
    story: STORY,
    epic: EPIC,
    repoName: "app",
    branch: "story/260907-two-speed/S1",
    epicBranch: "epic/two-speed",
    worktree: "/nowhere",
    commands: testFast === undefined ? [FULL] : [FULL, testFast.fast],
    conventions: "_none_",
    facts: "_none_",
    experts: [],
    budgetUsd: 4,
    testFast,
  });
}

describe("the developer prompt gets the second speed only when it exists", () => {
  test("declared ⇒ the rule is in the prompt, once", () => {
    const text = devPrompt({ fast: FAST, full: FULL });
    const rule = testFastRule(FAST, FULL).join("\n");
    expect(text).toContain(rule);
    expect(text.split(rule).length - 1).toBe(1);
  });

  test("absent ⇒ byte-identical to the prompt with no slot at all", () => {
    expect(devPrompt(undefined)).toBe(devPrompt());
    for (const line of testFastRule(FAST, FULL)) expect(devPrompt()).not.toContain(line);
    expect(devPrompt()).not.toContain(ITERATION_ONLY_SLOT);
  });
});

// ---------------------------------------------------------------------------
// (d) `tldrx init` does not guess it, and never probes it
// ---------------------------------------------------------------------------

describe("init offers the slot without inventing one", () => {
  test("the emitted file explains it in a COMMENT — nothing parses out of it", () => {
    const rendered = renderWorkspaceFile({ version: 1, repos: [{ name: "app", commands: { test: FULL } }] });
    const mentions = rendered.split("\n").filter((line) => line.includes(ITERATION_ONLY_SLOT));
    expect(mentions.length).toBeGreaterThan(0);
    for (const line of mentions) expect(line.trimStart().startsWith("#")).toBe(true);
    expect(WORKSPACE_FILE_HEADER).toContain(ITERATION_ONLY_SLOT);
    const parsed = parseYaml(rendered) as { repos: { commands: Record<string, string> }[] };
    expect(Object.keys(parsed.repos[0]?.commands ?? {})).toEqual(["test"]);
  });

  test("a probe never runs it, because it is not a probed slot", async () => {
    const seen: string[] = [];
    const runner: CommandRunner = {
      run(argv: readonly string[]): Promise<CommandResult> {
        seen.push(argv.join(" "));
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
      },
    };
    const probes = await probeCommands(
      runner,
      "/nowhere",
      { test: FULL, [ITERATION_ONLY_SLOT]: FAST } as Record<string, string>,
      { at: "2026-09-07T00:00:00Z", timeoutMs: 1_000, synthesised: new Set() },
    );
    expect(Object.keys(probes)).toEqual(["test"]);
    expect(seen).toEqual([FULL]);
  });
});

// ---------------------------------------------------------------------------
// (e) The mandate's one line
// ---------------------------------------------------------------------------

describe("the drive mandate briefs the driver about the second speed", () => {
  for (const mode of ["attended", "unattended"] as const) {
    test(`${mode}: names the slot and still fits its budget`, () => {
      const text = renderMandate(mode, "0.10.1");
      expect(text).toContain(ITERATION_ONLY_SLOT);
      expect(text.split("\n").length).toBeLessThanOrEqual(MANDATE_MAX_LINES);
      expect(renderMandate(mode, "0.10.1", undefined, true).split("\n").length)
        .toBeLessThanOrEqual(MANDATE_TLDR_MAX_LINES);
    });
  }
});

process.on("exit", () => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
