/**
 * A workspace the Build executor can actually run in: a real git repo, a real
 * `03-plan/`, and a fake `claude` that plays both sub-agents.
 *
 * "Real git repo" is the point. The executor cuts branches, opens worktrees,
 * merges and reads shas, and a stubbed git would let every one of those be wrong
 * in the same direction. The repo is `git init`ed here, given an identity and an
 * initial commit, and thrown away with the temp dir.
 *
 * PATH is set to the fixture's own bin directory ONLY, holding the fake `claude`
 * plus absolute-path shims for `git`, `npm` and `node`. That keeps the property
 * the facilitator fixture has — a fake that fails to resolve cannot fall through
 * to the real `claude` and spend money — while still letting a dod command run.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FRAMEWORK_ROOT } from "../../../src/core/paths.ts";
import { createRun } from "../../../src/core/run/newRun.ts";

export const FAKE_BUILD_CLAUDE = join(FRAMEWORK_ROOT, "test", "fixtures", "build", "fakeClaude.ts");

/** Tools the fixture shims onto its bin dir so a dod command can run. */
const SHIMMED = ["git", "npm", "node", "sh"] as const;

export interface StorySpec {
  readonly id: string;
  readonly epic?: string;
  readonly title?: string;
  readonly repo?: string;
  readonly dependsOn?: readonly string[];
  readonly touches?: readonly string[];
  readonly dod?: readonly string[];
  readonly status?: string;
}

export interface EpicSpec {
  readonly id: string;
  readonly title?: string;
  readonly branch?: string;
  readonly stories: readonly string[];
  readonly repos?: readonly string[];
}

export interface BuildWorkspaceOptions {
  readonly stories: readonly StorySpec[];
  readonly epics: readonly EpicSpec[];
  /** Wave id -> story ids, in execution order. */
  readonly waves: readonly (readonly string[])[];
  /** The workflow (and `run.yml` scope) this run is opened under. */
  readonly scope?: string;
  /**
   * `run new --seed <path>` — documents at the WORKSPACE ROOT the run is opened
   * from. They are not copied into the run and they are not inside the product
   * repo, which is the shape a docs-scope run has when the sources of truth live
   * in the root repo and the story's repo is a sibling (gh #111).
   */
  readonly seed?: readonly string[];
  /** The workflow's `skips:` — `["plan"]` is what makes Build synthesise a plan. */
  readonly skips?: readonly string[];
  /** False writes no `03-plan/` at all, the way a Plan-skipping scope leaves it. */
  readonly plan?: boolean;
  /** `01-what/handoff.md`, when the test needs one to synthesise from. */
  readonly whatHandoff?: string;
  /** `01-what/success-metrics.md`, likewise. */
  readonly successMetrics?: string;
  /** The repo's `commands:` map. Default: test only, everything else null. */
  readonly commands?: Readonly<Record<string, string | null>>;
  readonly budgetUsd?: number;
  readonly perAgentMaxUsd?: number;
  /**
   * `--gates <stages|all|none>` — which stages a HUMAN must sign. `"none"` makes
   * the build stage `auto`, which is the only way to exercise the auto gate's
   * own conditions end to end.
   */
  readonly gates?: string;
  /** The `test` script the fixture repo's package.json gets. Default: passes. */
  readonly testScript?: string;
  /** Extra files inside the repo, keyed by path relative to the repo. */
  readonly repoFiles?: Readonly<Record<string, string>>;
  /** Extra files in the workspace, keyed by path relative to the root. */
  readonly files?: Readonly<Record<string, string>>;
  readonly repoName?: string;
  /**
   * `root_is_repo: true` — the workspace root IS the product repo, so `.tldrx/`
   * and `tldrx-work/` live inside it. The repo is `git init`ed LAST in this shape
   * and everything committed, so the run starts from a clean tree and a test can
   * dirty exactly the paths it means to.
   */
  readonly rootIsRepo?: boolean;
}

export interface BuildWorkspace {
  readonly root: string;
  readonly repoDir: string;
  readonly repoName: string;
  readonly runId: string;
  readonly runDir: string;
  readonly planDir: string;
  readonly binDir: string;
  readonly statePath: string;
  readonly dispose: () => void;
}

export function makeBuildWorkspace(options: BuildWorkspaceOptions): BuildWorkspace {
  const root = mkdtempSync(join(tmpdir(), "tldrx-build-"));
  const repoName = options.repoName ?? "app";
  const rootIsRepo = options.rootIsRepo ?? false;
  const repoDir = rootIsRepo ? root : join(root, repoName);

  // --- the repo -------------------------------------------------------------
  mkdirSync(repoDir, { recursive: true });
  write(repoDir, "package.json", `${JSON.stringify({
    name: repoName,
    version: "0.0.0",
    private: true,
    scripts: { test: options.testScript ?? 'node -e "process.exit(0)"' },
  }, null, 2)}\n`);
  write(repoDir, "README.md", `# ${repoName}\n`);
  for (const [rel, content] of Object.entries(options.repoFiles ?? {})) write(repoDir, rel, content);
  if (!rootIsRepo) gitInit(repoDir);

  // --- the workspace --------------------------------------------------------
  write(root, ".tldrx/workspace.yml", workspaceYaml(repoName, options.commands, rootIsRepo));
  write(root, ".tldrx/memory/facts.yml", "version: 1\nfacts: []\n");
  write(root, ".tldrx/conventions/shared.md", "# Shared conventions\n\n- Done means proven.\n");
  write(root, ".tldrx/experts/developer/expert.md", "# Developer\n\nSmall diffs, tests first.\n");
  const scope = options.scope ?? "build-only";
  write(root, `.tldrx/workflows/${scope}.yml`, workflowYaml(scope, options.skips ?? []));
  write(root, ".tldrx/stages/build/stage.yml", stageYaml(options.budgetUsd ?? 8));
  write(root, ".tldrx/stages/build/stage.md", "# Build\n\n## Role\nThe wave executor runs this stage.\n");
  for (const [rel, content] of Object.entries(options.files ?? {})) write(root, rel, content);

  const binDir = join(root, ".fakebin");
  mkdirSync(binDir, { recursive: true });
  shim(binDir, "claude", `${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_BUILD_CLAUDE)}`);
  for (const tool of SHIMMED) {
    const abs = whichOrNull(tool);
    if (abs !== null) shim(binDir, tool, JSON.stringify(abs));
  }

  const outcome = createRun({
    root,
    slug: "build",
    scope,
    budgetUsd: options.budgetUsd ?? 8,
    repos: [repoName],
    gates: options.gates,
    ...(options.seed === undefined ? {} : { seed: options.seed }),
    actor: "alan",
    now: new Date("2026-08-29T09:00:00Z"),
  });

  // --- 01-what, when the test wants something to synthesise a plan from -------
  if (options.whatHandoff !== undefined) {
    write(outcome.runDir, "01-what/handoff.md", options.whatHandoff);
  }
  if (options.successMetrics !== undefined) {
    write(outcome.runDir, "01-what/success-metrics.md", options.successMetrics);
  }

  // --- 03-plan --------------------------------------------------------------
  const planDir = join(outcome.runDir, "03-plan");
  if (options.plan !== false) {
    mkdirSync(join(planDir, "stories"), { recursive: true });
    mkdirSync(join(planDir, "epics"), { recursive: true });
    for (const story of options.stories) {
      write(planDir, `stories/${story.id}.md`, storyMarkdown(story, repoName));
    }
    for (const epic of options.epics) {
      write(planDir, `epics/${epic.id}.md`, epicMarkdown(epic, repoName));
    }
    write(planDir, "waves.yml", wavesYaml(options.waves));
  }

  // The run's budget mirror must allow the per-agent cap the tests assert on.
  if (options.perAgentMaxUsd !== undefined) {
    setPerAgentMax(outcome.runDir, options.perAgentMaxUsd);
  }

  // Single-repo: the state written above is INSIDE the repo, so it is committed
  // with everything else and the tree the executor meets is clean. The fixture's
  // OWN scratch is gitignored — a real workspace does not carry `.fakebin/`, and
  // leaving it untracked would be product dirt the tests never meant to create.
  if (rootIsRepo) {
    write(root, ".gitignore", [".fakebin/", "fake-state.json", "*.log", "prompts/", ""].join("\n"));
    gitInit(repoDir);
  }

  return {
    root,
    repoDir,
    repoName,
    runId: outcome.runId,
    runDir: outcome.runDir,
    planDir,
    binDir,
    statePath: join(root, "fake-state.json"),
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** A SECOND run's `03-plan/`, for a test about two runs sharing one workspace. */
export interface SecondRunOptions {
  readonly stories: readonly StorySpec[];
  readonly epics: readonly EpicSpec[];
  readonly waves: readonly (readonly string[])[];
  /** The run slug, which is also half its id. Must differ from the first run's. */
  readonly slug?: string;
  readonly budgetUsd?: number;
  /** A LATER day than the first run's, so the ids differ and the order is stable. */
  readonly now?: Date;
}

/**
 * Open another run in an EXISTING build workspace, with its own `03-plan/`.
 *
 * The shape the cross-run bugs live in: two runs, one workspace, one repo, and a
 * plan that — as every plan does — calls its first epic `E1`. `makeBuildWorkspace`
 * gives each test its own temp root and exactly one run, which is what makes those
 * bugs invisible to it. The second run here is a real `createRun`, so it gets its
 * own `run.yml`, `budget.yml` and `events.jsonl`, and `runNext({runId})` drives it.
 */
export function addBuildRun(ws: BuildWorkspace, options: SecondRunOptions): {
  readonly runId: string;
  readonly runDir: string;
  readonly planDir: string;
} {
  const outcome = createRun({
    root: ws.root,
    slug: options.slug ?? "second",
    scope: "build-only",
    budgetUsd: options.budgetUsd ?? 8,
    repos: [ws.repoName],
    actor: "alan",
    now: options.now ?? new Date("2026-08-30T09:00:00Z"),
  });
  const planDir = join(outcome.runDir, "03-plan");
  mkdirSync(join(planDir, "stories"), { recursive: true });
  mkdirSync(join(planDir, "epics"), { recursive: true });
  for (const story of options.stories) {
    write(planDir, `stories/${story.id}.md`, storyMarkdown(story, ws.repoName));
  }
  for (const epic of options.epics) {
    write(planDir, `epics/${epic.id}.md`, epicMarkdown(epic, ws.repoName));
  }
  write(planDir, "waves.yml", wavesYaml(options.waves));
  return { runId: outcome.runId, runDir: outcome.runDir, planDir };
}

function workflowYaml(scope: string, skips: readonly string[]): string {
  return `version: 1
name: ${scope}
title: "One Build stage, for the executor's tests"
depth: minimal
default_budget_usd: 8
skips: [${skips.join(", ")}]
stages:
  - {id: build, phase: "04-build", budget_usd: 8}
`;
}

function stageYaml(budgetUsd: number): string {
  return `version: 1
id: build
title: "Build"
phase: 04-build
experts: [developer]
stack_experts: false
model: sonnet
budget_usd: ${String(budgetUsd)}
timeout_s: 120
dry_run_allowed: false
inputs: {required: ["03-plan/waves.yml"], optional: []}
outputs:
  - {path: "04-build/handoff.md", sections: [Findings, Decisions, Unknowns, "Evidence ledger"]}
gate: {type: approve, approvers: 1}
checks: [{id: claim-sources, on: post-write}]
`;
}

function workspaceYaml(
  repo: string,
  commands?: Readonly<Record<string, string | null>>,
  rootIsRepo = false,
): string {
  const declared = commands ?? { build: null, test: "npm run test", lint: null, typecheck: null, run: null };
  const rendered = Object.entries(declared)
    .map(([key, value]) => `${key}: ${value === null ? "null" : JSON.stringify(value)}`)
    .join(", ");
  return `version: 1
mode: single-repo
root_is_repo: ${String(rootIsRepo)}
detected_at: 2026-08-29T09:00:00Z
detected_by: "tldrx test"
repos:
  - name: ${repo}
    path: ${rootIsRepo ? "." : repo}
    default_branch: main
    stack: [typescript]
    package_manager: npm
    commands: {${rendered}}
    ci: []
    confidence: high
`;
}

export function storyMarkdown(story: StorySpec, repo: string): string {
  const dod = story.dod ?? ["npm run test"];
  return [
    "---",
    "version: 1",
    `id: ${story.id}`,
    `epic: ${story.epic ?? "E1"}`,
    `title: "${story.title ?? `Story ${story.id}`}"`,
    `repo: ${story.repo ?? repo}`,
    `status: ${story.status ?? "todo"}`,
    `depends_on: [${(story.dependsOn ?? []).join(", ")}]`,
    `touches: [${(story.touches ?? [`${story.id.toLowerCase()}.txt`]).map((t) => `"${t}"`).join(", ")}]`,
    "acceptance:",
    `  - "${story.id} exists and the suite is green"`,
    "test_plan:",
    `  - "Unit: the ${story.id} file is written"`,
    "evidence: []",
    "---",
    "",
    `# ${story.id} · ${story.title ?? `Story ${story.id}`}`,
    "",
    "## Context",
    "",
    "Written by the fixture. [src: 03-plan/waves.yml:1]",
    "",
    "## Definition of done",
    "",
    "```dod",
    ...dod,
    "```",
    "",
    "## Evidence",
    "",
    "Filled by Build.",
    "",
  ].join("\n");
}

export function epicMarkdown(epic: EpicSpec, repo: string): string {
  return [
    "---",
    "version: 1",
    `id: ${epic.id}`,
    `title: "${epic.title ?? `Epic ${epic.id}`}"`,
    `repos: [${(epic.repos ?? [repo]).join(", ")}]`,
    `stories: [${epic.stories.join(", ")}]`,
    `branch: ${epic.branch ?? `epic/${epic.id.toLowerCase()}`}`,
    "status: todo",
    "---",
    "",
    `# ${epic.id} · ${epic.title ?? `Epic ${epic.id}`}`,
    "",
  ].join("\n");
}

function wavesYaml(waves: readonly (readonly string[])[]): string {
  const rows = waves.map((stories, i) => `  - {id: W${String(i + 1)}, stories: [${stories.join(", ")}]}`);
  return ["version: 1", "waves:", ...rows, ""].join("\n");
}

function setPerAgentMax(runDir: string, value: number): void {
  // One regex for both files: the capture group must exist, or `replace`'s
  // callback hands the MATCH OFFSET where the indent was expected and writes it
  // into the file (measured: `211per_agent_max_usd: 3`).
  const re = /^([ \t]*)per_agent_max_usd:.*$/m;
  for (const name of ["budget.yml", "run.yml"]) {
    const path = join(runDir, name);
    const text = readFileSync(path, "utf8");
    if (!re.test(text)) continue;
    writeFileSync(path, text.replace(re, (_match, indent: string) =>
      `${indent}per_agent_max_usd: ${String(value)}`), "utf8");
  }
}

function gitInit(dir: string): void {
  run(dir, ["init", "-b", "main"]);
  run(dir, ["config", "user.email", "fixture@example.com"]);
  run(dir, ["config", "user.name", "tldrx fixture"]);
  run(dir, ["config", "commit.gpgsign", "false"]);
  run(dir, ["add", "-A"]);
  run(dir, ["commit", "-m", "chore: fixture repo"]);
}

function run(cwd: string, args: readonly string[]): void {
  execFileSync("git", [...args], { cwd, stdio: "pipe" });
}

function shim(binDir: string, name: string, target: string): void {
  const path = join(binDir, name);
  writeFileSync(path, `#!/bin/sh\nexec ${target} "$@"\n`, "utf8");
  chmodSync(path, 0o755);
}

function whichOrNull(tool: string): string | null {
  try {
    const found = execFileSync("/usr/bin/env", ["which", tool], { encoding: "utf8" }).trim();
    return found !== "" && existsSync(found) ? found : null;
  } catch {
    return null;
  }
}

function write(base: string, rel: string, content: string): void {
  const path = join(base, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf8");
}
