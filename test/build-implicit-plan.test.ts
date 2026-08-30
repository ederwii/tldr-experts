/**
 * A scope that SKIPS the Plan phase can still Build (spec §2.4, §5).
 *
 * The bug these guard: `workflows/docs.yml` is `stages: [what, build]` with
 * `skips: [how, plan, watch]`, `stages/build/stage.yml` declares
 * `03-plan/waves.yml` as an input, and the executor's first act was
 * `loadBuildPlan(03-plan/)`. A real `docs` run parked at `04-build (ready)` with
 * no `03-plan/` on disk could therefore only fail its own Build stage — the whole
 * scope was a dead end.
 *
 * Everything below runs the REAL pipeline against a REAL git repo, like
 * `build-executor.test.ts`: only `claude` is faked. What is being guarded is that
 * the synthesised plan is DERIVED — every line of it traceable to a file the run
 * already wrote — and that a plan somebody actually wrote still wins.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runNext, type NextOptions } from "../src/core/facilitator/runNext.ts";
import {
  answersByQuestion, chooseRepo, citedRepoPaths, decisionBullets, decisionKeysOf, dodCommandsFor, dodRolesFor,
  applyAcceptance, droppedNotes, epicBranchFor, implicitPlanContent, isWhatDeliverable, loadImplicitPlan, matchTextOf, planFacts,
  planIsSkipped, renderImplicitPlan, runFacts, satisfiedByImplicitPlan, updateImplicitPlan, wasTruncated,
  whatSignal, addedNotes, answerIndex, factRange, findDecisionDocuments, implicitPlanIsStale, implicitStoryNote,
  touchesNamedByFacts, IMPLICIT_PLAN_REL, IMPLICIT_STORY_NOTE, MAX_IMPLICIT_TOUCHES,
} from "../src/core/build/implicitPlan.ts";
import { MAX_FACT_CHARS } from "../src/core/facts/Fact.ts";
import { FactsStore } from "../src/core/facts/FactsStore.ts";
import { validateFactsFile } from "../src/core/facts/validateFactsFile.ts";
import { captureAnswers, factTextFor, factWasTruncated, TRUNCATION_MARK } from "../src/core/answers/captureAnswers.ts";
import { parseYaml } from "../src/core/yaml.ts";
import type { Fact } from "../src/core/facts/Fact.ts";
import { listItems } from "../src/core/text/handoff.ts";
import { loadWorkflowPreset } from "../src/core/run/workflowPreset.ts";
import { buildProgress } from "../src/core/run/buildProgress.ts";
import { buildStatus, renderStatus } from "../src/core/run/runStatus.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { loadWorkspace } from "../src/hooks/lib/workspace.ts";
import { FRAMEWORK_ROOT, PROJECT_FRAMEWORK_DIR, PROJECT_WORK_DIR } from "../src/core/paths.ts";
import { makeBuildWorkspace, type BuildWorkspace, type BuildWorkspaceOptions } from "./fixtures/build/workspace.ts";

const ORIGINAL_PATH = process.env.PATH ?? "";
const FAKE_KEYS = [
  "FAKE_BUILD_WRITE", "FAKE_BUILD_VERDICTS", "FAKE_BUILD_COST", "FAKE_BUILD_STATE", "FAKE_BUILD_PROMPT_DIR",
] as const;

let open: BuildWorkspace[] = [];

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  for (const key of FAKE_KEYS) delete process.env[key];
  for (const ws of open) ws.dispose();
  open = [];
});

function workspace(options: BuildWorkspaceOptions): BuildWorkspace {
  const made = makeBuildWorkspace(options);
  open.push(made);
  process.env.PATH = made.binDir;
  process.env.FAKE_BUILD_STATE = made.statePath;
  return made;
}

function next(ws: BuildWorkspace, overrides: Partial<NextOptions> = {}): Promise<{ code: number; lines: readonly string[] }> {
  return runNext({
    root: ws.root,
    dryRun: false,
    mode: "headless",
    yolo: false,
    actor: "alan",
    at: "2026-08-29T09:00:00Z",
    ...overrides,
  });
}

/** A What handoff shaped like the real one, citing two paths the fixture repo has. */
const HANDOFF = `<!-- schema: draft -->

# What — handoff

## Findings

- The guide is out of date in two places [src: app:docs/guide.md:3]

## Decisions

- In scope: rewriting \`docs/guide.md\` § Install and § Upgrade [src: app:docs/guide.md:3]
- Out of scope: the README's badge table [src: app:README.md:1]
- Out of scope: anything in a repo this run does not name [src: other:src/x.ts:1]

## Unknowns

- none [src: absent:docs/CHANGELOG.md]

## Evidence ledger

- \`docs/guide.md:3\` is the paragraph both decisions are about [src: app:docs/guide.md:3]
`;

const METRICS = `# Success metrics — docs run

1. **Install section names the current version.** Measured by grepping
   \`docs/guide.md\` for the version string.
2. **No dead link.** Measured by the lint command.
`;

const DOCS_RUN: BuildWorkspaceOptions = {
  scope: "docs",
  skips: ["how", "plan", "watch"],
  plan: false,
  stories: [],
  epics: [],
  waves: [],
  whatHandoff: HANDOFF,
  successMetrics: METRICS,
  commands: { build: null, test: "npm run test", lint: "npm run lint", typecheck: null, run: null },
  repoFiles: {
    "docs/guide.md": "# Guide\n\n## Install\n\nOld version.\n",
    "package.json": `${JSON.stringify({
      name: "app",
      version: "0.0.0",
      private: true,
      scripts: { test: 'node -e "process.exit(0)"', lint: 'node -e "process.exit(0)"' },
    }, null, 2)}\n`,
  },
};

function git(ws: BuildWorkspace, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd: ws.repoDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function plan(ws: BuildWorkspace): string {
  return readFileSync(join(ws.runDir, IMPLICIT_PLAN_REL), "utf8");
}

/**
 * One `  <key>:` block of the rendered story.
 *
 * `notes:` deliberately ECHOES the head of every bullet the What-deliverable
 * filter dropped, so "gone from goal" cannot be asserted against the whole file
 * — it would be satisfied by the note that says it was dropped.
 */
function block(text: string, key: string): string {
  const lines = text.split("\n");
  const at = lines.findIndex((line) => line.startsWith(`  ${key}:`));
  if (at === -1) return "";
  const out = [lines[at] ?? ""];
  for (let i = at + 1; i < lines.length && (lines[i] ?? "").startsWith("    "); i++) out.push(lines[i] ?? "");
  return out.join("\n");
}

// ---------------------------------------------------------------------------

describe("which shipped scopes need an implicit plan", () => {
  test("every scope that skips Plan and still builds gets one; retro and spike do not", () => {
    const root = FRAMEWORK_ROOT;
    const names = readdirSync(join(root, "workflows"))
      .filter((file) => file.endsWith(".yml"))
      .map((file) => file.replace(/\.yml$/, ""));
    // The bare `name` list is asserted so a scope added later fails this test
    // rather than silently joining (or not joining) the set.
    expect(names.sort()).toEqual([
      "bugfix", "docs", "feature", "hotfix", "integration", "migration",
      "performance", "prototype", "refactor", "retro", "security-patch", "spike", "upgrade",
    ]);

    const needsImplicit: string[] = [];
    for (const name of names) {
      // `retro` lists no stages at all, so `loadWorkflowPreset` refuses it — it is
      // driven by `tldrx retro <run-id>`, not by the facilitator.
      if (name === "retro") continue;
      const preset = loadWorkflowPreset(root, name);
      const builds = preset.stages.some((stage) => stage.id === "build");
      if (builds && planIsSkipped(preset.skips)) needsImplicit.push(name);
    }
    expect(needsImplicit.sort()).toEqual(["docs", "hotfix", "performance", "prototype", "security-patch"]);

    // `spike` skips Plan AND Build, so there is nothing to synthesise for.
    const spike = loadWorkflowPreset(root, "spike");
    expect(planIsSkipped(spike.skips)).toBe(true);
    expect(spike.stages.some((stage) => stage.id === "build")).toBe(false);
  });

  test("`skips:` is read off the workflow, and only 03-plan inputs are excused by it", () => {
    expect(loadWorkflowPreset(FRAMEWORK_ROOT, "docs").skips).toEqual(["how", "plan", "watch"]);
    expect(loadWorkflowPreset(FRAMEWORK_ROOT, "feature").skips).toEqual([]);

    expect(satisfiedByImplicitPlan("03-plan/waves.yml")).toBe(true);
    expect(satisfiedByImplicitPlan("03-plan/stories/S1.md")).toBe(true);
    expect(satisfiedByImplicitPlan(".tldrx/conventions/shared.md")).toBe(false);
    expect(satisfiedByImplicitPlan(".tldrx/memory/facts.yml")).toBe(false);
    expect(satisfiedByImplicitPlan("01-what/handoff.md")).toBe(false);
  });
});

describe("the Definition of Done a scope implies", () => {
  const roles = (map: Record<string, string>): ReadonlyMap<string, string> => new Map(Object.entries(map));

  test("docs takes lint only, spike and prototype take nothing, everything else builds and tests", () => {
    const declared = roles({
      build: "npm run build", test: "npm run test", lint: "npm run lint", typecheck: "npm run typecheck",
    });
    expect(dodCommandsFor("docs", declared)).toEqual(["npm run lint"]);
    expect(dodCommandsFor("spike", declared)).toEqual([]);
    expect(dodCommandsFor("prototype", declared)).toEqual([]);
    expect(dodCommandsFor("hotfix", declared)).toEqual(["npm run build", "npm run test"]);
    expect(dodCommandsFor("security-patch", declared)).toEqual(["npm run build", "npm run test"]);
    expect(dodCommandsFor("performance", declared)).toEqual(["npm run build", "npm run test"]);
    expect(dodRolesFor("docs")).toEqual(["lint"]);
  });

  test("the ROLE decides, not the command text — `lint: dotnet format …` is still the lint", () => {
    // Measured on a real .NET workspace: no "lint" anywhere in the command
    // string. A text match found nothing and handed a docs run an empty DoD.
    const dotnet = roles({
      build: "dotnet build", test: "dotnet test", lint: "dotnet format --verify-no-changes",
    });
    expect(dodCommandsFor("docs", dotnet)).toEqual(["dotnet format --verify-no-changes"]);
    expect(dodCommandsFor("hotfix", dotnet)).toEqual(["dotnet build", "dotnet test"]);
  });

  test("a command the workspace does not declare can never reach the dod", () => {
    // The whole allowlist rule (spec §2.13) in one line: the picker only ever
    // reads the declared map, so there is no path by which it invents one.
    expect(dodCommandsFor("docs", roles({}))).toEqual([]);
    expect(dodCommandsFor("docs", undefined)).toEqual([]);
    // A role the repo leaves null never reaches `commandRoles` at all.
    expect(dodCommandsFor("hotfix", roles({ test: "cargo test" }))).toEqual(["cargo test"]);
    expect(dodCommandsFor("hotfix", roles({ run: "make serve" }))).toEqual([]);
  });
});

describe("the derivations", () => {
  test("goal is the handoff's Decisions bullets, verbatim, tokens kept", () => {
    const bullets = decisionBullets(HANDOFF);
    expect(bullets).toHaveLength(3);
    expect(bullets[0]).toBe(
      "In scope: rewriting `docs/guide.md` § Install and § Upgrade [src: app:docs/guide.md:3]",
    );
  });

  test("acceptance is success-metrics.md's items, wrapped lines joined", () => {
    const items = listItems(METRICS);
    expect(items).toHaveLength(2);
    expect(items[0]).toBe(
      "**Install section names the current version.** Measured by grepping `docs/guide.md` for the version string.",
    );
  });

  test("an epic branch is a slug of the run id, inside EPIC_BRANCH_RE", () => {
    expect(epicBranchFor("260830-decisions-gate")).toBe("epic/260830-decisions-gate");
    expect(epicBranchFor("Wave S / Build!")).toBe("epic/wave-s-build");
    expect(/^epic\/[a-z0-9][a-z0-9-]{0,48}$/.test(epicBranchFor("260830-decisions-gate"))).toBe(true);
  });

  test("the repo is the one the handoff cites most, ties going to run.repos order", () => {
    const cited = [{ repo: "b", path: "x" }, { repo: "b", path: "y" }, { repo: "a", path: "z" }];
    expect(chooseRepo(["a", "b"], cited)).toBe("b");
    expect(chooseRepo(["a", "b"], [])).toBe("a");
    expect(() => chooseRepo([], cited)).toThrow(/names no repo/);
  });

  test("`status:` and `evidence:` round-trip without touching the lists below them", () => {
    const ws = workspace(DOCS_RUN);
    const content = implicitPlanContent({
      runDir: ws.runDir, runId: ws.runId, runTitle: "A docs run", scope: "docs",
      repos: [ws.repoName], workspace: loadWorkspace(ws.root), facts: [], budgetUsd: 8,
    });
    const before = renderImplicitPlan(content);
    const after = updateImplicitPlan(before, { status: "done", evidence: ["$ npm run lint → exit 0", "commit abc"] });
    expect(after).toContain("status: done");
    expect(after).toContain('  - "$ npm run lint → exit 0"');
    // The wave list, the epic and the story survived the patch untouched.
    expect(after).toContain("  - {id: W1, stories: [S1]}");
    expect(after).toContain(`  repo: ${ws.repoName}`);
    expect(after.split("\n").filter((line) => line.startsWith("status:"))).toHaveLength(1);
  });
});

describe("a docs run that reaches Build with no 03-plan/", () => {
  test("writes one derived story, proves it with lint, merges it, and stops at a human gate", async () => {
    const ws = workspace(DOCS_RUN);
    process.env.FAKE_BUILD_WRITE = JSON.stringify({
      S1: { "docs/guide.md": "# Guide\n\n## Install\n\nVersion 0.3.0.\n\n## Upgrade\n\nSee the changelog.\n" },
    });
    const promptDir = join(ws.root, "prompts");
    process.env.FAKE_BUILD_PROMPT_DIR = promptDir;

    const outcome = await next(ws);
    const said = outcome.lines.join("\n");

    // Exit 4 = awaiting a human. Before this wave it was 5: the stage FAILED with
    // "03-plan/ does not validate — stories/: the Plan wrote no stories".
    expect(outcome.code).toBe(4);
    expect(said).toContain("implicit plan: Plan skipped by scope 'docs' — one story S1");
    expect(said).toContain("dod: npm run lint");
    expect(said).toContain("✓ S1 → `done`");

    const text = plan(ws);
    expect(text).toContain("implicit: true");
    expect(text).toContain('reason: "Plan skipped by scope \'docs\'"');
    expect(text).toContain("  - {id: W1, stories: [S1]}");
    expect(text).toContain("status: done");
    // goal = the handoff's Decisions, verbatim. The third bullet cites a repo
    // this run does not name, so it is in `goal` (which is prose) but NOT in
    // `touches` (which is a list of files an agent will be handed).
    expect(text).toContain(
      '    - "In scope: rewriting `docs/guide.md` § Install and § Upgrade [src: app:docs/guide.md:3]"',
    );
    expect(text).toContain('    - "**Install section names the current version.**');
    expect(text).toContain('    - "docs/guide.md"');
    expect(text).toContain('    - "README.md"');
    expect(text).not.toContain('"src/x.ts"');
    expect(text).toContain('    - "npm run lint"');
    expect(text).toContain("budget_usd: 8.00");

    // Done means proven, even here: the evidence names the command that ran.
    expect(text).toContain('  - "$ npm run lint → exit 0"');
    expect(text).toMatch(/- "commit [0-9a-f]+"/);

    // The branch graph is the ordinary one — a docs edit is a code edit.
    expect(git(ws, ["rev-parse", "--verify", `epic/${ws.runId}`])).not.toBe("");
    expect(git(ws, ["log", `epic/${ws.runId}`, "--oneline"])).toContain("merge(S1)");
    expect(git(ws, ["show", `epic/${ws.runId}:docs/guide.md`])).toContain("Version 0.3.0");
    // Nothing merged to main and nothing was pushed.
    expect(git(ws, ["show", "main:docs/guide.md"])).toContain("Old version.");

    // The developer was handed the touched file's CONTENT, not a path to go find.
    const developer = readFileSync(join(promptDir, "developer-S1-1.md"), "utf8");
    expect(developer).toContain("# Build — story S1");
    expect(developer).toContain(IMPLICIT_PLAN_REL);
    expect(developer).toContain("Old version.");
    expect(developer).toContain("- `npm run lint`");
  }, 60_000);

  /**
   * The reported bug, end to end (2026-08-30). A docs run in a `root_is_repo: true`
   * workspace synthesises its plan into `tldrx-work/<run>/04-build/` and rewrites
   * `run.yml`/`events.jsonl` on the way — then the Build executor read those very
   * files as a dirty tree and exited 2 before cutting anything. The framework's
   * own state is not the human's uncommitted work.
   */
  test("single-repo: the run's own state does not refuse the Build it just planned", async () => {
    const ws = workspace({ ...DOCS_RUN, rootIsRepo: true });
    process.env.FAKE_BUILD_WRITE = JSON.stringify({
      S1: { "docs/guide.md": "# Guide\n\n## Install\n\nVersion 0.3.0.\n" },
    });
    appendFileSync(join(ws.runDir, "run.yml"), "\n# touched by this very run\n", "utf8");
    writeFileSync(join(ws.runDir, ".lock"), "held\n", "utf8");

    const outcome = await next(ws);
    const said = outcome.lines.join("\n");
    expect(said).not.toContain("refusing to cut an epic branch");
    expect(outcome.code).toBe(4);
    expect(said).toContain("✓ S1 → `done`");

    // The story landed, and it carried the docs edit ONLY.
    const changed = git(ws, ["diff", "--name-only", `main...epic/${ws.runId}`]).split("\n").filter((l) => l !== "");
    expect(changed).toEqual(["docs/guide.md"]);
    expect(changed.some((path) => path.startsWith(`${PROJECT_WORK_DIR}/`))).toBe(false);
    expect(changed.some((path) => path.startsWith(`${PROJECT_FRAMEWORK_DIR}/`))).toBe(false);
  }, 60_000);

  test("`run status` says the plan is implicit", async () => {
    const ws = workspace(DOCS_RUN);
    await next(ws);
    const store = RunStore.open(ws.runDir);
    const progress = buildProgress(ws.runDir);
    expect(progress?.implicit).toBe(true);
    expect(progress?.total).toBe(1);
    expect(progress?.done).toBe(1);

    const rendered = renderStatus(buildStatus(store.run, store.budget, ws.runDir));
    // The label is padded to the phase-id column, so match the row not the spaces.
    expect(rendered).toMatch(/^plan\s+implicit \(scope skips Plan\)$/m);
    expect(rendered).toContain("W1 [S1 done]");
  }, 60_000);

  test("a scope with no verifying command still finishes: an empty DoD is green, not vacuously red", async () => {
    const ws = workspace({
      ...DOCS_RUN,
      // No `lint` declared, so `docs` has nothing to run. A planned story in this
      // state blocks ("the story declares no dod commands"); an implicit one must
      // not, or the scope is a dead end again one step further along.
      commands: { build: null, test: "npm run test", lint: null, typecheck: null, run: null },
    });
    const outcome = await next(ws);

    expect(outcome.code).toBe(4);
    expect(outcome.lines.join("\n")).toContain("dod: none");
    expect(outcome.lines.join("\n")).toContain("✓ S1 → `done`");
    const text = plan(ws);
    expect(text).toContain("  dod: []");
    expect(text).toContain("status: done");
    // Evidence is still required and still real: the commit and the review log.
    expect(text).toMatch(/- "commit [0-9a-f]+"/);
    expect(text).toContain('  - "04-build/log/S1.md"');
  }, 60_000);

  test("a handoff that cites no repo path yields `touches: []`, and the prompt says so", async () => {
    const ws = workspace({
      ...DOCS_RUN,
      whatHandoff: [
        "# What — handoff",
        "",
        "## Decisions",
        "",
        "- In scope: write the missing onboarding page [src: F001]",
        "- Out of scope: the API reference [src: https://example.com/adr-7]",
        "",
      ].join("\n"),
    });
    const promptDir = join(ws.root, "prompts");
    process.env.FAKE_BUILD_PROMPT_DIR = promptDir;

    const outcome = await next(ws);
    expect(outcome.code).toBe(4);
    expect(outcome.lines.join("\n")).toContain("0 touched path(s)");

    const text = plan(ws);
    expect(text).toContain("  touches: []  # 01-what/handoff.md cites no path inside a declared repo");
    // The goal survives even though nothing it cites is a file.
    expect(text).toContain('    - "In scope: write the missing onboarding page [src: F001]"');

    const developer = readFileSync(join(promptDir, "developer-S1-1.md"), "utf8");
    expect(developer).toContain("touches: []  # 01-what/handoff.md cites no path inside a declared repo");
  }, 60_000);

  test("a run with no What handoff at all still plans, and says the title is the whole brief", () => {
    const ws = workspace({ ...DOCS_RUN, whatHandoff: undefined, successMetrics: undefined });
    const parts = {
      runDir: ws.runDir, runId: ws.runId, runTitle: "Fix the guide", scope: "docs",
      repos: [ws.repoName], workspace: loadWorkspace(ws.root), facts: [], budgetUsd: 8,
    };
    const built = loadImplicitPlan(parts);
    expect(built.implicit).toBe(true);
    expect(built.storyCount).toBe(1);
    const story = built.stories.get("S1");
    expect(story?.story.touches).toEqual([]);
    expect(story?.story.acceptance[0]).toContain("the run title above is the whole brief");
    expect(citedRepoPaths("", loadWorkspace(ws.root))).toEqual([]);
  });
});

describe("a plan somebody actually wrote", () => {
  test("a feature run with 03-plan/ present is untouched — no implicit plan, no new file", async () => {
    const ws = workspace({
      scope: "feature",
      skips: [],
      stories: [{ id: "S1", epic: "E1", title: "First story" }],
      epics: [{ id: "E1", stories: ["S1"], branch: "epic/e1" }],
      waves: [["S1"]],
    });
    const outcome = await next(ws);

    expect(outcome.code).toBe(4);
    expect(outcome.lines.join("\n")).not.toContain("implicit plan");
    expect(existsSync(join(ws.runDir, IMPLICIT_PLAN_REL))).toBe(false);
    expect(buildProgress(ws.runDir)?.implicit).toBe(false);
    expect(renderStatus(buildStatus(RunStore.open(ws.runDir).run, RunStore.open(ws.runDir).budget, ws.runDir)))
      .not.toContain("implicit");
    // The story file is still the state, written back the way it always was.
    expect(readFileSync(join(ws.planDir, "stories", "S1.md"), "utf8")).toContain("status: done");
  }, 60_000);

  test("a real 03-plan/ wins even under a scope whose skips names plan", async () => {
    const ws = workspace({
      scope: "docs",
      skips: ["how", "plan", "watch"],
      stories: [{ id: "S1", epic: "E1", title: "Someone planned this" }],
      epics: [{ id: "E1", stories: ["S1"], branch: "epic/e1" }],
      waves: [["S1"]],
      whatHandoff: HANDOFF,
    });
    const outcome = await next(ws);

    expect(outcome.lines.join("\n")).not.toContain("implicit plan");
    expect(existsSync(join(ws.runDir, IMPLICIT_PLAN_REL))).toBe(false);
    expect(readFileSync(join(ws.planDir, "stories", "S1.md"), "utf8")).toContain("status: done");
  }, 60_000);
});

// ---------------------------------------------------------------------------
// The plan carries the work FORWARD: the run's answered facts become the work.
// ---------------------------------------------------------------------------

/** The id `makeBuildWorkspace` mints, so a fixture fact can be stamped with it. */
const FIXTURE_RUN = "260829-build";

const ANSWERED_FACTS = `version: 1
facts:
  - id: F001
    fact: "Who owns the repo? — I do"
    area: ownership
    repos: []
    kind: answer
    confidence: stated
    source: {who: alan, when: "2026-08-28T09:00:00Z", run: init, q: Q1}
    supersedes: null
    superseded_by: null
    retired: null
  - id: F002
    fact: "Do customers authenticate through the SSO provider? — A — outside it, via phone verification. Accepts ADR-D008 as written."
    area: identity
    repos: []
    kind: answer
    confidence: stated
    source: {who: alan, when: "2026-08-29T09:30:00Z", run: "${FIXTURE_RUN}", q: Q1}
    supersedes: null
    superseded_by: null
    retired: null
  - id: F003
    fact: "Is the entitlement subject the Account or the Business? — A — the Account, with the published contract unchanged. Accepts ADR-D011."
    area: entitlements
    repos: []
    kind: answer
    confidence: stated
    source: {who: alan, when: "2026-08-29T09:31:00Z", run: "${FIXTURE_RUN}", q: Q2}
    supersedes: null
    superseded_by: null
    retired: null
`;

const ADR_HANDOFF = `# What — handoff

## Findings

- Two ADRs are still \`proposed\` [src: app:docs/adr/ADR-D008-AUTH.md:1]

## Decisions

- In scope: one \`questions.md\` block per open ADR, each with the recommended option as A [src: app:docs/adr/ADR-D008-AUTH.md:1]
- In scope: settling ADR-D008 and ADR-D011 [src: app:docs/adr/ADR-D011-ENTITLEMENTS.md:1]
- Out of scope: the deployment ADRs [src: app:README.md:1]

## Unknowns

- none [src: absent:docs/adr/ADR-D099.md]

## Evidence ledger

- both ADRs carry \`Status: proposed\` [src: app:docs/adr/ADR-D008-AUTH.md:1]
`;

const ADR_METRICS = `# Success metrics

1. **Question count matches ADR count.** \`01-what/questions.md\` holds exactly 2 \`### Q\` blocks.
2. **Every ADR names its decision.** Each ADR's Decision section states the accepted option.
`;

const ANSWERED_RUN: BuildWorkspaceOptions = {
  scope: "docs",
  skips: ["how", "plan", "watch"],
  plan: false,
  stories: [],
  epics: [],
  waves: [],
  whatHandoff: ADR_HANDOFF,
  successMetrics: ADR_METRICS,
  commands: { build: null, test: "npm run test", lint: "npm run lint", typecheck: null, run: null },
  files: { ".tldrx/memory/facts.yml": ANSWERED_FACTS },
  repoFiles: {
    "docs/adr/ADR-D008-AUTH.md": "# ADR-D008 · Customer authentication\n\nStatus: proposed\n",
    "docs/adr/ADR-D011-ENTITLEMENTS.md": "# ADR-D011 · Entitlement scope\n\nStatus: proposed\n",
    "package.json": `${JSON.stringify({
      name: "app",
      version: "0.0.0",
      private: true,
      scripts: { test: 'node -e "process.exit(0)"', lint: 'node -e "process.exit(0)"' },
    }, null, 2)}\n`,
  },
};

function fact(id: string, text: string, run: string | null): Fact {
  return {
    id,
    fact: text,
    area: "x",
    repos: [],
    kind: "answer",
    confidence: "stated",
    source: { who: "alan", when: "2026-08-29T09:00:00Z", run, q: null },
    supersedes: null,
    superseded_by: null,
    retired: null,
  };
}

describe("which answers count, and which document each settles", () => {
  test("only this run's live facts — not init's, not a retired one", () => {
    const rows = [
      fact("F001", "from init", "init"),
      fact("F002", "from this run", FIXTURE_RUN),
      { ...fact("F003", "retired", FIXTURE_RUN), retired: { at: "2026-08-29T10:00:00Z", by: "alan", reason: "wrong" } },
    ];
    expect(runFacts(rows, FIXTURE_RUN).map((f) => f.id)).toEqual(["F002"]);
  });

  test("a file's decision keys are its ADR id — never a leading document number", () => {
    expect(decisionKeysOf("docs/adr/ADR-D008-CUSTOMER-AUTHENTICATION.md")).toEqual(["ADR-D008", "D008"]);
    expect(decisionKeysOf("docs/decisions/decision-7.md")).toEqual(["decision 7"]);
    // `13-` is a document number. Reading it as a decision number would let any
    // fact that says "13" claim to settle this file.
    expect(decisionKeysOf("docs/13-OPEN-DECISIONS.md")).toEqual([]);
    expect(decisionKeysOf("README.md")).toEqual([]);
  });

  test("a mapping is only claimed when the fact's own text names the key, and the gaps are reported", () => {
    const facts = [
      fact("F002", "customers authenticate outside it. Accepts ADR-D008 as written.", FIXTURE_RUN),
      fact("F004", "delivery zones are circles plus polygons", FIXTURE_RUN),
    ];
    const plan = planFacts(facts, ["docs/adr/ADR-D008-AUTH.md", "docs/adr/ADR-D013-ZONES.md", "README.md"]);
    expect(plan.mappings).toEqual([{ factId: "F002", path: "docs/adr/ADR-D008-AUTH.md", key: "ADR-D008" }]);
    expect(plan.unmappedPaths).toEqual(["docs/adr/ADR-D013-ZONES.md", "README.md"]);
    expect(plan.unmappedFactIds).toEqual(["F004"]);
  });

  test("a bullet whose subject is the What's own deliverable is detected by its literal mentions", () => {
    expect(whatSignal("In scope: one `questions.md` block per item")).toBe("questions.md");
    expect(whatSignal("it holds exactly 6 `### Q` blocks")).toBe("### Q");
    // The three aparece survivors of the first three signals, in their own words.
    expect(whatSignal(
      "**Gate passes.** `01-what/handoff.md`'s four required sections each hold at least one sourced bullet.",
    )).toBe("01-what/");
    expect(whatSignal(
      "**No recorded fact is re-asked.** None of Q1–Q6 duplicates the subject of F001 (planning process).",
    )).toBe("a question id");
    expect(whatSignal(
      "**Every question names what is blocked.** Each question's *Why it is being asked* text states the stage(s).",
    )).toBe("the run's questions");
  });

  test("Build's own work survives every signal", () => {
    for (const bullet of [
      "Out of scope: selecting an answer on the owner's behalf for any of the six",
      "settle ADR-D008 and ADR-D011 in `docs/adr/`",
      "`04-build/handoff.md` lists the epic branch ready to merge",
      "every touched document no longer reads `Status: proposed`",
      "each ADR's Decision section states the accepted option",
      "`docs/domain-design/DECISIONS-NEEDED.md` is left as it is",
    ]) {
      expect(whatSignal(bullet), bullet).toBeNull();
      expect(isWhatDeliverable(bullet)).toBe(false);
    }
  });

  test("a grep too long for one bullet points at `notes:` rather than being cut mid-command", () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      `docs/domain-design/docs/adr/ADR-D${String(100 + i)}-A-RATHER-LONG-DECISION-RECORD-NAME.md`);
    const facts = many.map((_path, i) =>
      fact(`F${String(100 + i)}`, `settled. Accepts ADR-D${String(100 + i)} as written.`, FIXTURE_RUN));
    const line = applyAcceptance(planFacts(facts, many))[0] ?? "";
    expect(line).toContain("`grep -c 'Status: proposed' <the 12 documents listed under `notes:`>`");
    expect(line).not.toContain("more)");
    expect(line.length).toBeLessThanOrEqual(512);
  });

  test("what the filter drops is written into the story, with the signal that fired", () => {
    expect(droppedNotes([{ where: "acceptance", bullet: "**Gate passes.** `01-what/handoff.md` holds bullets." }]))
      .toEqual([
        "dropped from acceptance as the What stage's own work (mentions 01-what/): " +
        "**Gate passes.** `01-what/handoff.md` holds bullets.",
      ]);
  });
});

describe("a fact whose text was cut at the 300-char cap", () => {
  const QUESTIONS = `# Questions

## Q1 · Where do customers authenticate?

[Answer]: A — outside the SSO provider, via phone verification. Accepts ADR-D008 as written.

<!-- answered_by: alan | answered_at: 2026-08-29T09:30:00Z | fact: F002 -->

## Q2 · What shape is a zone?

[Answer]: A — circle plus polygon, first match wins. Accepts ADR-D013 as written.

<!-- answered_by: alan | answered_at: 2026-08-29T09:31:00Z | fact: F003 -->
`;

  test("the full `[Answer]:` is read back, keyed by both the question id and the fact id", () => {
    const ws = workspace({ ...DOCS_RUN, files: { ...(DOCS_RUN.files ?? {}) } });
    writeFileSync(join(ws.runDir, "01-what", "questions.md"), QUESTIONS, "utf8");
    const answers = answersByQuestion(ws.runDir);
    expect(answers.get("Q1")).toContain("Accepts ADR-D008 as written.");
    expect(answers.get("F002")).toBe(answers.get("Q1"));
    expect(answers.get("Q3")).toBeUndefined();
    // A run with no questions.md is an empty map, not a throw.
    expect(answersByQuestion(join(ws.root, "nowhere")).size).toBe(0);
  });

  test("every fact is matched against its answer, cut or not — the cap is not the trigger", () => {
    const answers = new Map([["Q1", "…Accepts ADR-D008 as written."]]);
    // `FactsStore.append` writes `slice(0, MAX - 1) + "…"`, so a cut fact is
    // exactly MAX_FACT_CHARS long — and its ADR clause is what went missing.
    const cut = fact("F002", `${"x".repeat(MAX_FACT_CHARS - 1)}…`, FIXTURE_RUN);
    expect(wasTruncated(cut.fact)).toBe(true);
    expect(matchTextOf({ ...cut, source: { ...cut.source, q: "Q1" } }, answers)).toContain("ADR-D008");

    // It used to append the answer ONLY to a fact at the cap, which tied the
    // mapping to the cap's exact value: raising it to 2000 would have switched
    // the fallback off for every 300-char fact already on disk. Concatenating
    // always cannot match less than the fact alone, so the gate bought nothing.
    const whole = fact("F004", "short and complete", FIXTURE_RUN);
    expect(wasTruncated(whole.fact)).toBe(false);
    expect(matchTextOf({ ...whole, source: { ...whole.source, q: "Q1" } }, answers))
      .toBe("short and complete\n…Accepts ADR-D008 as written.");

    // A fact that already carries its whole answer is not doubled.
    const same = fact("F005", "…Accepts ADR-D008 as written.", FIXTURE_RUN);
    expect(matchTextOf({ ...same, source: { ...same.source, q: "Q1" } }, answers))
      .toBe("…Accepts ADR-D008 as written.");
  });

  test("the mapping uses the answer, so a cut fact still settles its ADR", () => {
    const cut = {
      ...fact("F002", `Where do customers authenticate? — A — outside it${"x".repeat(MAX_FACT_CHARS)}`.slice(0, MAX_FACT_CHARS), FIXTURE_RUN),
      source: { who: "alan", when: "2026-08-29T09:30:00Z", run: FIXTURE_RUN, q: "Q1" },
    };
    const answers = new Map([["Q1", "A — outside the SSO provider. Accepts ADR-D008 as written."]]);
    expect(planFacts([cut], ["docs/adr/ADR-D008-AUTH.md"]).mappings).toEqual([]);
    expect(planFacts([cut], ["docs/adr/ADR-D008-AUTH.md"], answers).mappings)
      .toEqual([{ factId: "F002", path: "docs/adr/ADR-D008-AUTH.md", key: "ADR-D008" }]);
  });
});

describe("a run whose questions have been answered", () => {
  test("the goal gets one apply-bullet per fact, the acceptance gets the settled-documents check", async () => {
    const ws = workspace(ANSWERED_RUN);
    const promptDir = join(ws.root, "prompts");
    process.env.FAKE_BUILD_PROMPT_DIR = promptDir;
    process.env.FAKE_BUILD_WRITE = JSON.stringify({
      S1: {
        "docs/adr/ADR-D008-AUTH.md": "# ADR-D008 · Customer authentication\n\nStatus: Accepted\n",
        "docs/adr/ADR-D011-ENTITLEMENTS.md": "# ADR-D011 · Entitlement scope\n\nStatus: Accepted\n",
      },
    });

    const outcome = await next(ws);
    expect(outcome.code).toBe(4);
    expect(outcome.lines.join("\n")).toContain("applying F002, F003");

    const text = plan(ws);

    // (1) one apply-bullet per answered fact of THIS run, its text verbatim.
    expect(text).toContain(
      '    - "Apply Do customers authenticate through the SSO provider? — A — outside it, via phone ' +
      'verification. Accepts ADR-D008 as written. to the touched files [src: F002]"',
    );
    expect(text).toContain("Accepts ADR-D011. to the touched files [src: F003]\"");
    // init's fact is not this run's work.
    expect(text).not.toContain("[src: F001]");

    // (2) the settled-documents acceptance criterion, citing the mapping facts.
    expect(text).toContain(
      "every touched document whose decision is settled by a fact of this run no longer reads " +
      "`Status: proposed` — `grep -c 'Status: proposed' docs/adr/ADR-D008-AUTH.md " +
      "docs/adr/ADR-D011-ENTITLEMENTS.md` → 0 for the ones a fact decides [src: F002; F003]",
    );
    // README.md is touched and no fact names it, so the generic line is there too.
    expect(text).toContain("apply every listed fact; leave a one-line note per file saying which fact changed it");
    expect(text).toContain("  notes:");
    expect(text).toContain("F002 settles docs/adr/ADR-D008-AUTH.md (its text mentions `ADR-D008`)");
    expect(text).toContain("F003 settles docs/adr/ADR-D011-ENTITLEMENTS.md (its text mentions `ADR-D011`)");
    expect(text).toContain("no fact of this run mentions the ADR id or decision number of 1 touched file(s)");

    // (3) the What's own deliverable is gone from both lists — and the drop is
    // ON THE RECORD in `notes:`, so a filter mistake is visible, not invisible.
    expect(block(text, "goal")).not.toContain("one `questions.md` block per open ADR");
    expect(block(text, "acceptance")).not.toContain("### Q` blocks");
    expect(block(text, "notes")).toContain(
      "dropped from context as the What stage's own work (mentions questions.md): " +
      "In scope: one `questions.md` block",
    );
    expect(block(text, "notes")).toContain("dropped from acceptance as the What stage's own work");
    // The grep is a command a person pastes: it is complete or it is not given.
    expect(block(text, "acceptance")).not.toContain("more)`");
    // What the What decided that is NOT about the questions file survives — as
    // CONTEXT, because this run has answers and the answers are the work.
    expect(block(text, "goal")).not.toContain("In scope: settling ADR-D008 and ADR-D011");
    expect(block(text, "context")).toContain("In scope: settling ADR-D008 and ADR-D011");
    expect(block(text, "acceptance")).toContain("**Every ADR names its decision.**");

    // (4) the developer is told where this story came from, which facts it is
    // for, and that the What's decisions under `## Context` are background.
    const developer = readFileSync(join(promptDir, "developer-S1-1.md"), "utf8");
    expect(developer).toContain(implicitStoryNote(["F002", "F003"]));
    expect(developer).toContain("## Context (from the What stage)");
    expect(developer).toContain("They are not");
    expect(developer).toContain("- In scope: settling ADR-D008 and ADR-D011");
    expect(developer).toContain("Apply Do customers authenticate through the SSO provider?");
  }, 60_000);

  test("a run that has answered nothing keeps the What's decisions and says there is nothing to apply", () => {
    const ws = workspace(DOCS_RUN);
    const content = implicitPlanContent({
      runDir: ws.runDir, runId: ws.runId, runTitle: "A docs run", scope: "docs",
      repos: [ws.repoName], workspace: loadWorkspace(ws.root), facts: [], budgetUsd: 8,
    });
    expect(content.factIds).toEqual([]);
    expect(content.notes).toEqual([]);
    expect(content.goal.every((bullet) => !bullet.startsWith("Apply "))).toBe(true);
    expect(renderImplicitPlan(content)).toContain(
      "  notes: []  # this run has answered no question, so there is nothing to apply",
    );
  });

  test("with facts but no derivable mapping, only the generic acceptance is written — and it says so", () => {
    const ws = workspace(DOCS_RUN);
    const content = implicitPlanContent({
      runDir: ws.runDir, runId: ws.runId, runTitle: "A docs run", scope: "docs",
      repos: [ws.repoName], workspace: loadWorkspace(ws.root),
      // Neither touched file (docs/guide.md, README.md) carries an ADR id.
      facts: [fact("F009", "ship the guide rewrite", ws.runId)], budgetUsd: 8,
    });
    expect(content.goal.at(-1)).toBe("Apply ship the guide rewrite to the touched files [src: F009]");
    expect(content.acceptance.filter((item) => item.includes("Status: proposed"))).toHaveLength(0);
    expect(content.acceptance.at(-1)).toBe(
      "apply every listed fact; leave a one-line note per file saying which fact changed it [src: F009]",
    );
    expect(content.notes.join("\n")).toContain("no fact of this run mentions the ADR id or decision number");
    expect(content.notes.join("\n")).toContain("F009 settle no touched document by name");
  });
});

// ---------------------------------------------------------------------------
// F1 — a document a FACT names joins `touches`, even when the What never cited it.
// ---------------------------------------------------------------------------

/**
 * The aparece shape, minimised: the What cites ADR-D008 and never mentions
 * ADR-D013, whose decision the run's own answer to Q2 makes. The stored fact is
 * cut before the clause that names it — which is how the real one looked.
 */
const ZONES_FACTS = `version: 1
facts:
  - id: F001
    fact: "Do customers authenticate through the SSO provider? — A — outside it. Accepts ADR-D008 as written."
    area: identity
    repos: []
    kind: answer
    confidence: stated
    source: {who: alan, when: "2026-08-29T09:30:00Z", run: "${FIXTURE_RUN}", q: Q1}
    supersedes: null
    superseded_by: null
    retired: null
  - id: F002
    fact: "What shape is a delivery zone? — A — circle plus polygon, exclusions, explicit order, first match wins; containment in application code with no PostGIS and no spatial ind …"
    area: delivery
    repos: []
    kind: answer
    confidence: stated
    source: {who: alan, when: "2026-08-29T09:31:00Z", run: "${FIXTURE_RUN}", q: Q2}
    supersedes: null
    superseded_by: null
    retired: null
`;

const ZONES_QUESTIONS = `# Questions — ${FIXTURE_RUN}

Answer in the slot.

## Q1 · Do customers authenticate through the SSO provider?
<!-- id: Q1 | status: answered | area: identity | asked_by: facilitator | asked_at: 2026-08-29T09:00:00Z -->

[Answer]: A — outside it. Accepts ADR-D008 as written.

<!-- answered_by: alan | answered_at: 2026-08-29T09:30:00Z | fact: F001 -->

## Q2 · What shape is a delivery zone?
<!-- id: Q2 | status: answered | area: delivery | asked_by: facilitator | asked_at: 2026-08-29T09:00:00Z -->

[Answer]: A — circle plus polygon, exclusions, explicit order, first match wins; containment in application code with no PostGIS and no spatial index. Accepts ADR-D013 as written.

<!-- answered_by: alan | answered_at: 2026-08-29T09:31:00Z | fact: F002 -->
`;

/** Cites ADR-D008. Says nothing at all about ADR-D013 — that is the whole point. */
const ZONES_HANDOFF = `# What — handoff

## Findings

- ADR-D008 is still \`proposed\` [src: app:docs/adr/ADR-D008-AUTH.md:1]

## Decisions

- In scope: settling the open ADRs the owner answers [src: app:docs/adr/ADR-D008-AUTH.md:1]
- Out of scope: choosing on the owner's behalf [src: app:README.md:1]

## Unknowns

- none [src: absent:docs/adr/ADR-D099.md]

## Evidence ledger

- ADR-D008 carries \`Status: proposed\` [src: app:docs/adr/ADR-D008-AUTH.md:1]
`;

const ZONES_RUN: BuildWorkspaceOptions = {
  scope: "docs",
  skips: ["how", "plan", "watch"],
  plan: false,
  stories: [],
  epics: [],
  waves: [],
  whatHandoff: ZONES_HANDOFF,
  successMetrics: "# Success metrics\n\n1. **Every answered ADR reads Accepted.**\n",
  commands: { build: null, test: "npm run test", lint: "npm run lint", typecheck: null, run: null },
  files: { ".tldrx/memory/facts.yml": ZONES_FACTS },
  repoFiles: {
    "docs/adr/ADR-D008-AUTH.md": "# ADR-D008 · Customer authentication\n\nStatus: proposed\n",
    "docs/adr/ADR-D013-ZONES.md": "# ADR-D013 · Delivery zone geometry\n\nStatus: proposed\n",
    "docs/adr/ADR-D099-UNANSWERED.md": "# ADR-D099 · Nobody asked\n\nStatus: proposed\n",
    "package.json": `${JSON.stringify({
      name: "app",
      version: "0.0.0",
      private: true,
      scripts: { test: 'node -e "process.exit(0)"', lint: 'node -e "process.exit(0)"' },
    }, null, 2)}\n`,
  },
};

function zonesWorkspace(): BuildWorkspace {
  const ws = workspace(ZONES_RUN);
  writeFileSync(join(ws.runDir, "01-what", "questions.md"), ZONES_QUESTIONS, "utf8");
  return ws;
}

describe("the documents this run's answers settle", () => {
  test("a repo's decision documents are found, the touched directories first", () => {
    const ws = zonesWorkspace();
    const found = findDecisionDocuments(ws.repoDir, ["docs/adr"]);
    expect(found).toEqual([
      "docs/adr/ADR-D008-AUTH.md",
      "docs/adr/ADR-D013-ZONES.md",
      "docs/adr/ADR-D099-UNANSWERED.md",
    ]);
    // A file whose name carries no decision key is not a decision document.
    expect(found).not.toContain("README.md");
    expect(found).not.toContain("package.json");
    expect(findDecisionDocuments(join(ws.root, "nowhere"), [])).toEqual([]);
  });

  test("only a document some fact actually names is added, and never one already touched", () => {
    const ws = zonesWorkspace();
    const facts = [
      fact("F002", "zones are circles plus polygons", FIXTURE_RUN),
    ];
    const answers = new Map([["Q2", "first match wins. Accepts ADR-D013 as written."]]);
    const parts = {
      facts: facts.map((f) => ({ ...f, source: { ...f.source, q: "Q2" } })),
      answers,
      repoDir: ws.repoDir,
      existing: ["docs/adr/ADR-D008-AUTH.md"],
      limit: MAX_IMPLICIT_TOUCHES,
    };
    expect(touchesNamedByFacts(parts)).toEqual([
      { path: "docs/adr/ADR-D013-ZONES.md", factId: "F002", key: "ADR-D013" },
    ]);
    // ADR-D099 exists and no fact names it, so it stays out.
    expect(touchesNamedByFacts(parts).map((entry) => entry.path)).not.toContain("docs/adr/ADR-D099-UNANSWERED.md");
    // Already touched -> nothing to add.
    expect(touchesNamedByFacts({ ...parts, existing: ["docs/adr/ADR-D013-ZONES.md"] })).toEqual([]);
    // No facts, or no room left, and the search does not even run.
    expect(touchesNamedByFacts({ ...parts, facts: [] })).toEqual([]);
    expect(touchesNamedByFacts({ ...parts, limit: 1 })).toEqual([]);

    expect(addedNotes([{ path: "docs/adr/ADR-D013-ZONES.md", factId: "F002", key: "ADR-D013" }])).toEqual([
      "added docs/adr/ADR-D013-ZONES.md to touches: settled by F002 (its text mentions `ADR-D013`)",
    ]);
  });

  test("the ADR a cut fact settles reaches `touches`, and `notes:` says who put it there", async () => {
    const ws = zonesWorkspace();
    process.env.FAKE_BUILD_PROMPT_DIR = join(ws.root, "prompts");
    process.env.FAKE_BUILD_WRITE = JSON.stringify({
      S1: {
        "docs/adr/ADR-D008-AUTH.md": "# ADR-D008 · Customer authentication\n\nStatus: Accepted\n",
        "docs/adr/ADR-D013-ZONES.md": "# ADR-D013 · Delivery zone geometry\n\nStatus: Accepted\n",
      },
    });

    const outcome = await next(ws);
    expect(outcome.code).toBe(4);
    const text = plan(ws);

    // The bug, gone: the handoff never cited ADR-D013 and it is touched anyway.
    expect(ZONES_HANDOFF).not.toContain("ADR-D013");
    expect(block(text, "touches")).toContain('    - "docs/adr/ADR-D013-ZONES.md"');
    expect(block(text, "notes")).toContain(
      "added docs/adr/ADR-D013-ZONES.md to touches: settled by F002 (its text mentions `ADR-D013`)",
    );
    // …and because it is touched, it is MAPPED — so the line that used to say
    // the fact settles nothing is gone, and the grep names the file.
    expect(block(text, "notes")).toContain("F002 settles docs/adr/ADR-D013-ZONES.md");
    expect(block(text, "notes")).not.toContain("settle no touched document");
    expect(block(text, "acceptance")).toContain("docs/adr/ADR-D013-ZONES.md");
    // An ADR nobody answered is still nobody's business.
    expect(text).not.toContain("ADR-D099");

    // The developer was handed its CONTENT, which is what `touches` buys.
    const developer = readFileSync(join(ws.root, "prompts", "developer-S1-1.md"), "utf8");
    expect(developer).toContain("### `docs/adr/ADR-D013-ZONES.md`");
    expect(developer).toContain("# ADR-D013 · Delivery zone geometry");
  }, 60_000);
});

// ---------------------------------------------------------------------------
// F2 — the WHOLE answer reaches the developer.
// ---------------------------------------------------------------------------

describe("the whole answer, not the fact's first line", () => {
  test("`01-what/questions.md` is a declared input, and the prompt inlines it", async () => {
    const ws = zonesWorkspace();
    process.env.FAKE_BUILD_PROMPT_DIR = join(ws.root, "prompts");
    await next(ws);

    expect(block(plan(ws), "inputs")).toContain('    - "01-what/questions.md"');
    const developer = readFileSync(join(ws.root, "prompts", "developer-S1-1.md"), "utf8");
    expect(developer).toContain("### `01-what/questions.md`");
    expect(developer).toContain("Accepts ADR-D013 as written.");
  }, 60_000);

  test("a run with no questions.md declares no input and cites only the fact", () => {
    const ws = workspace({ ...DOCS_RUN });
    const content = implicitPlanContent({
      runDir: ws.runDir, runId: ws.runId, runTitle: "A docs run", scope: "docs",
      repos: [ws.repoName], workspace: loadWorkspace(ws.root),
      facts: [fact("F009", "ship the guide rewrite", ws.runId)], budgetUsd: 8,
    });
    expect(content.inputs).toEqual([]);
    expect(content.goal).toEqual(["Apply ship the guide rewrite to the touched files [src: F009]"]);
    expect(renderImplicitPlan(content)).toContain("  inputs: []  # this run wrote no 01-what/questions.md");
  });

  test("the apply-bullet quotes the FULL answer and cites the line it was taken from", async () => {
    const ws = zonesWorkspace();
    await next(ws);
    const goal = block(plan(ws), "goal");

    // The fact row stops at "no spatial ind …". The bullet does not.
    expect(goal).toContain("no PostGIS and no spatial index. Accepts ADR-D013 as written.");
    expect(goal).not.toContain("no spatial ind …");
    // Both sources, in one token: the fact, and where its words actually are.
    expect(goal).toContain("[src: F002; 01-what/questions.md:15]");
    expect(goal).toContain("[src: F001; 01-what/questions.md:8]");
  }, 60_000);

  test("`answerIndex` reads the answer, the restated fact and the [Answer]: line", () => {
    const ws = zonesWorkspace();
    const index = answerIndex(ws.runDir);
    expect(index.answers.get("Q2")).toContain("Accepts ADR-D013 as written.");
    expect(index.answers.get("F002")).toBe(index.answers.get("Q2"));
    expect(index.restated.get("Q2")).toStartWith("What shape is a delivery zone? — A — circle plus polygon");
    // 1-based, and it is the `[Answer]:` line rather than the heading.
    expect(index.lines.get("Q2")).toBe(15);
    expect(ZONES_QUESTIONS.split("\n")[14]).toStartWith("[Answer]: A — circle plus polygon");
    expect(answerIndex(join(ws.root, "nowhere")).lines.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// F3 — the goal is the work; the What's decisions are context.
// ---------------------------------------------------------------------------

describe("goal is the work, context is the What", () => {
  test("with answers, `goal` holds nothing but apply-bullets", () => {
    const ws = zonesWorkspace();
    const content = implicitPlanContent({
      runDir: ws.runDir, runId: FIXTURE_RUN, runTitle: "Settle the ADRs", scope: "docs",
      repos: [ws.repoName], workspace: loadWorkspace(ws.root),
      facts: [fact("F002", "zones. Accepts ADR-D013 as written.", FIXTURE_RUN)], budgetUsd: 8,
    });
    expect(content.goal.every((item) => item.startsWith("Apply "))).toBe(true);
    expect(content.goal.join("\n")).not.toContain("Out of scope: choosing on the owner's behalf");
    expect(content.context.join("\n")).toContain("Out of scope: choosing on the owner's behalf");
    expect(content.context.join("\n")).toContain("In scope: settling the open ADRs the owner answers");
  });

  test("with no answers, nothing moves: the What's decisions are still the goal", () => {
    const ws = zonesWorkspace();
    const content = implicitPlanContent({
      runDir: ws.runDir, runId: FIXTURE_RUN, runTitle: "Settle the ADRs", scope: "docs",
      repos: [ws.repoName], workspace: loadWorkspace(ws.root), facts: [], budgetUsd: 8,
    });
    expect(content.context).toEqual([]);
    expect(content.goal.join("\n")).toContain("Out of scope: choosing on the owner's behalf");
    expect(renderImplicitPlan(content))
      .toContain("  context: []  # nothing to apply, so the What's decisions ARE the goal above");
  });

  test("the note names the facts, and a contiguous block is written as a range", () => {
    expect(implicitStoryNote([])).toBe(IMPLICIT_STORY_NOTE);
    expect(implicitStoryNote(["F005", "F006", "F007", "F008", "F009", "F010"])).toBe(
      "Plan was skipped by the scope; this story applies the run's answered decisions (F005–F010) " +
      "to the files listed under `touches`; the What's decisions below are background.",
    );
    expect(factRange(["F005", "F006"])).toBe("F005, F006");
    expect(factRange(["F005", "F007", "F009"])).toBe("F005, F007, F009");
    expect(factRange(["F005", "F006", "F007"])).toBe("F005–F007");
  });

  test("the developer prompt labels the context as background, after the objective", async () => {
    const ws = zonesWorkspace();
    process.env.FAKE_BUILD_PROMPT_DIR = join(ws.root, "prompts");
    await next(ws);
    const developer = readFileSync(join(ws.root, "prompts", "developer-S1-1.md"), "utf8");

    expect(developer).toContain(implicitStoryNote(["F001", "F002"]));
    expect(developer).toContain("## Context (from the What stage)");
    expect(developer).toContain("They are not\ninstructions, and nothing in this section is a task.");
    // Objective first, then context, then the Done-when list.
    expect(developer.indexOf("## Objective")).toBeLessThan(developer.indexOf("## Context (from the What stage)"));
    expect(developer.indexOf("## Context (from the What stage)"))
      .toBeLessThan(developer.indexOf("Done-when, all of it testable:"));
  }, 60_000);
});

// ---------------------------------------------------------------------------
// F4 — `--prepare --discard-pending` derives the plan again.
// ---------------------------------------------------------------------------

describe("re-preparing an implicit plan", () => {
  test("--discard-pending bins the bundle AND re-derives the plan, reusing this run's branches", async () => {
    const ws = zonesWorkspace();
    const first = await next(ws, { mode: "prepare" });
    expect(first.code).toBe(0);
    expect(first.lines.join("\n")).toContain("prepared S1");
    expect(plan(ws)).toContain("status: in_progress");
    expect(existsSync(join(ws.runDir, ".agent", "build", "S1", "pending.json"))).toBe(true);
    // A result the killed session left behind, which a later --commit would read.
    writeFileSync(
      join(ws.runDir, ".agent", "build", "S1", "result.json"),
      JSON.stringify({ outputs: [], questions_asked: [], notes: "stale", cost_usd: 9 }),
      "utf8",
    );

    // Something the What did not know: a third answer, naming a third ADR.
    writeFileSync(
      join(ws.root, ".tldrx", "memory", "facts.yml"),
      ZONES_FACTS.replace(/\n$/, `
  - id: F003
    fact: "Is ADR-D099 in? — A — yes. Accepts ADR-D099 as written."
    area: scope
    repos: []
    kind: answer
    confidence: stated
    source: {who: alan, when: "2026-08-29T09:32:00Z", run: "${FIXTURE_RUN}", q: Q3}
    supersedes: null
    superseded_by: null
    retired: null
`),
      "utf8",
    );

    const again = await next(ws, { mode: "prepare", discardPending: true });
    const said = again.lines.join("\n");
    expect(again.code).toBe(0);
    expect(said).toContain("discarded the --prepare bundle in");
    expect(said).toContain("re-derived 04-build/implicit-plan.yml (--discard-pending;");
    expect(said).toContain("prepared S1");
    // (b) the plan is DIFFERENT: the new answer is in it, and so is its document.
    expect(block(plan(ws), "goal")).toContain("[src: F003]");
    expect(block(plan(ws), "touches")).toContain("ADR-D099-UNANSWERED.md");
    // (a) the stale result is gone, so no --commit can read it as this cycle's.
    expect(existsSync(join(ws.runDir, ".agent", "build", "S1", "result.json"))).toBe(false);
    // (d) a fresh bundle, for this story, is on disk.
    expect(existsSync(join(ws.runDir, ".agent", "build", "S1", "pending.json"))).toBe(true);
    expect(readFileSync(join(ws.runDir, ".agent", "build", "S1", "prompt.md"), "utf8"))
      .toContain("Accepts ADR-D099 as written.");
    // (c) the epic branch this run cut is reused, not refused.
    expect(said).not.toContain("refusing to stack this run's commits");
    expect(git(ws, ["rev-parse", "--verify", `epic/${ws.runId}`])).not.toBe("");
  }, 60_000);

  test("a plan something has already been built off is KEPT, and the reason is said", async () => {
    const ws = zonesWorkspace();
    await next(ws, { mode: "prepare" });

    // The developer's commit, on the story branch, before the session died.
    const worktree = join(ws.root, ".tldrx", "worktrees", "app", `${ws.runId}-S1`);
    writeFileSync(join(worktree, "docs", "adr", "ADR-D008-AUTH.md"), "Status: Accepted\n", "utf8");
    execFileSync("git", ["add", "-A", "docs"], { cwd: worktree, stdio: ["ignore", "pipe", "pipe"] });
    execFileSync("git", ["commit", "-m", "wip"], { cwd: worktree, stdio: ["ignore", "pipe", "pipe"] });

    const again = await next(ws, { mode: "prepare", discardPending: true });
    const said = again.lines.join("\n");
    expect(said).toContain("kept 04-build/implicit-plan.yml (--discard-pending re-derives only an unbuilt plan):");
    expect(said).toContain("carries 1 commit(s) beyond");
    expect(said).toContain("prepared S1");
  }, 60_000);

  test("evidence, or a settled story, is the other half of the guard", () => {
    expect(implicitPlanIsStale("status: todo\nevidence: []\n")).toBeNull();
    expect(implicitPlanIsStale("status: in_progress\nevidence: []\n")).toBeNull();
    expect(implicitPlanIsStale("status: done\nevidence: []\n")).toBe("the story is already `done`");
    expect(implicitPlanIsStale("status: blocked\nevidence: []\n")).toBe("the story is already `blocked`");
    expect(implicitPlanIsStale('status: todo\nevidence:\n  - "commit abc"\n'))
      .toBe("the story has recorded evidence");
  });

  test("without the flag the plan on disk is left exactly as it is", async () => {
    const ws = zonesWorkspace();
    await next(ws, { mode: "prepare" });
    const before = plan(ws);
    writeFileSync(
      join(ws.root, ".tldrx", "memory", "facts.yml"),
      "version: 1\nfacts: []\n",
      "utf8",
    );
    const again = await next(ws, { mode: "prepare" });
    expect(again.lines.join("\n")).not.toContain("re-derived");
    expect(plan(ws)).toBe(before);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// F2 (b)(c) — the cap that cut the sentence, and saying so when it still cuts.
// ---------------------------------------------------------------------------

describe("the fact cap, and what a cut fact says about itself", () => {
  test("spec §2.5's cap is 2000, and the spec table says the same number", () => {
    expect(MAX_FACT_CHARS).toBe(2000);
    const spec = readFileSync(join(FRAMEWORK_ROOT, "docs", "spec.md"), "utf8");
    expect(spec).toContain("| `fact` | str ≤2000 |");
  });

  test("under the cap nothing is marked; over it the text ends in ` …` and the row says truncated", () => {
    expect(factWasTruncated("Q", "short")).toBe(false);
    expect(factTextFor("Q", "short")).toBe("Q — short");

    const long = "x".repeat(MAX_FACT_CHARS);
    expect(factWasTruncated("Q", long)).toBe(true);
    const cut = factTextFor("Q", long);
    expect(cut.length).toBe(MAX_FACT_CHARS);
    expect(cut).toEndWith(TRUNCATION_MARK);
  });

  test("`tldrx answer` records the mark and the flag, and a whole answer records neither", () => {
    const ws = workspace(DOCS_RUN);
    const path = join(ws.runDir, "01-what", "questions.md");
    const long = `A — ${"long ".repeat(500)}end`;
    writeFileSync(path, [
      "# Questions",
      "",
      "## Q1 · A short one",
      "<!-- id: Q1 | status: open | area: x | asked_by: facilitator | asked_at: 2026-08-29T09:00:00Z -->",
      "",
      "[Answer]: A — brief.",
      "",
      "## Q2 · A long one",
      "<!-- id: Q2 | status: open | area: x | asked_by: facilitator | asked_at: 2026-08-29T09:00:00Z -->",
      "",
      `[Answer]: ${long}`,
      "",
    ].join("\n"), "utf8");

    const captured = captureAnswers(path, {
      root: ws.root, runDir: ws.runDir, run: ws.runId, actor: "alan", at: "2026-08-29T09:30:00Z",
    });
    expect(captured.map((row) => row.q)).toEqual(["Q1", "Q2"]);

    const store = FactsStore.load(join(ws.root, ".tldrx", "memory", "facts.yml"));
    const short = store.get("F001");
    expect(short?.truncated).toBeUndefined();
    expect(short?.fact).toBe("A short one — A — brief.");

    const big = store.get("F002");
    expect(big?.truncated).toBe(true);
    expect(big?.fact).toEndWith(TRUNCATION_MARK);
    expect(big?.fact.length).toBe(MAX_FACT_CHARS);
    // The whole answer is still on disk, which is the point of the flag.
    expect(answerIndex(ws.runDir).answers.get("F002")).toBe(long);

    // The flag survives a round trip through the emitter and the validator.
    const yaml = readFileSync(join(ws.root, ".tldrx", "memory", "facts.yml"), "utf8");
    expect(yaml).toContain("    truncated: true");
    expect(yaml.match(/truncated: true/g)).toHaveLength(1);
    expect(validateFactsFile(parseYaml(yaml)).ok).toBe(true);
  });

  test("a row written before the field existed still validates; a wrong type does not", () => {
    const row = (extra: string): string => `version: 1
facts:
  - id: F001
    fact: "Q — A"
    area: x
    repos: []
    kind: answer
    confidence: stated
    source: {who: alan, when: "2026-08-29T09:00:00Z", run: null, q: null}
    supersedes: null
    superseded_by: null
    retired: null${extra}
`;
    expect(validateFactsFile(parseYaml(row(""))).ok).toBe(true);
    expect(validateFactsFile(parseYaml(row("\n    truncated: true"))).ok).toBe(true);
    const bad = validateFactsFile(parseYaml(row('\n    truncated: "yes"')));
    expect(bad.ok).toBe(false);
    expect(bad.issues[0]?.path).toBe("facts[0].truncated");
  });
});
