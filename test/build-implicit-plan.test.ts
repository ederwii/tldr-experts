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
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runNext, type NextOptions } from "../src/core/facilitator/runNext.ts";
import {
  chooseRepo, citedRepoPaths, decisionBullets, decisionKeysOf, dodCommandsFor, dodRolesFor, epicBranchFor,
  implicitPlanContent, isWhatDeliverable, loadImplicitPlan, planFacts, planIsSkipped, renderImplicitPlan,
  runFacts, satisfiedByImplicitPlan, updateImplicitPlan, IMPLICIT_PLAN_REL, IMPLICIT_STORY_NOTE,
} from "../src/core/build/implicitPlan.ts";
import type { Fact } from "../src/core/facts/Fact.ts";
import { listItems } from "../src/core/text/handoff.ts";
import { loadWorkflowPreset } from "../src/core/run/workflowPreset.ts";
import { buildProgress } from "../src/core/run/buildProgress.ts";
import { buildStatus, renderStatus } from "../src/core/run/runStatus.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { loadWorkspace } from "../src/hooks/lib/workspace.ts";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";
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
    expect(isWhatDeliverable("In scope: one `questions.md` block per item")).toBe(true);
    expect(isWhatDeliverable("`01-what/questions.md` contains exactly 6 `### Q` blocks")).toBe(true);
    expect(isWhatDeliverable("Out of scope: selecting an answer on the owner's behalf")).toBe(false);
    expect(isWhatDeliverable("settle ADR-D008 and ADR-D011")).toBe(false);
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

    // (3) the What's own deliverable is gone from both lists.
    expect(text).not.toContain("one `questions.md` block per open ADR");
    expect(text).not.toContain("### Q` blocks");
    // What the What decided that is NOT about questions.md survives.
    expect(text).toContain("In scope: settling ADR-D008 and ADR-D011");
    expect(text).toContain("**Every ADR names its decision.**");

    // (4) the developer is told where this story came from.
    const developer = readFileSync(join(promptDir, "developer-S1-1.md"), "utf8");
    expect(developer).toContain(IMPLICIT_STORY_NOTE);
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
