/**
 * The three consumers of `tldrx retro --all` (issue #74).
 *
 * #64 shipped the READER: a deterministic classifier over review logs, fix
 * lists, `retro.md` and reopen reasons, printed as a table. Its stated purpose
 * was "feeding expert training and stage prompts", and nothing consumed it. This
 * file is the far end of that loop, and it tests exactly three seams:
 *
 *   1. **`--json`** — a machine shape that will not move under a consumer. The
 *      key sets are asserted LITERALLY, so adding a field is a deliberate act
 *      that breaks a test rather than a silent contract change.
 *   2. **The reviewer prompt** — the workspace's top finding classes reach the
 *      adversarial reviewer BEFORE it reads the diff. Both directions are
 *      asserted: present when there is history, and absent — no heading, no
 *      blank section, no noise — when there is none.
 *   3. **The extensible taxonomy** — `.tldrx/memory/finding-classes.yml`. The
 *      load-bearing half is the REFUSALS: a workspace that cannot express its
 *      own recurring defect got `other` before this, and a workspace that
 *      mistypes its rules must be told so, not silently ignored and not crashed
 *      through.
 *
 * The fixture artefacts are the real shapes — `renderReviewLog`
 * (`build/review.ts`) and the `story.reopened` envelope — for the same reason
 * `retro-all.test.ts` uses them: a classifier tested against invented text is
 * tested against itself.
 */
import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";
import { EXIT_OK, EXIT_USAGE } from "../src/cli/exitCodes.ts";
import {
  ALL_RETRO_JSON_VERSION, FINDING_CLASSES, FINDING_CLASSES_FILE, FindingClassesError,
  classify, loadExtraClasses, mineAll, recurringClasses, toAllRetroJson, workspaceRecurring,
  REVIEWER_FOCUS_TOP_N,
} from "../src/core/retro/index.ts";
import { buildReviewerPrompt, REVIEWER_FOCUS_HEADING } from "../src/core/build/prompts.ts";
import type { PlannedStory } from "../src/core/build/plan.ts";
import { noSpawnEnv } from "./fixtures/noSpawnPath.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";
import { makeBuildWorkspace, type BuildWorkspace, type BuildWorkspaceOptions } from "./fixtures/build/workspace.ts";
import { runNext, type NextOptions } from "../src/core/facilitator/runNext.ts";
import { reject } from "../src/core/run/gates.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { REVIEW_DIR } from "../src/core/run/prepared.ts";

setDefaultTimeout(spawnTestTimeout());

const BIN = join(FRAMEWORK_ROOT, "bin", "tldrx.ts");

async function tldrx(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", BIN, ...args], {
    stdout: "pipe", stderr: "pipe", cwd: FRAMEWORK_ROOT, env: noSpawnEnv(),
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

// --- the fixture -------------------------------------------------------------

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "tldrx-retro-consumers-"));
  temps.push(root);
  mkdirSync(join(root, ".tldrx"), { recursive: true });
  return root;
}

function write(root: string, rel: string, body: string): void {
  const path = join(root, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body, "utf8");
}

/** A review log in the shape `renderReviewLog` writes, carrying `n` findings. */
function reviewLog(story: string, findings: readonly string[], summary: string): string {
  return [
    `# Review — ${story} · fixture`,
    "",
    "- Verdict: **changes**",
    "- Story status: `review`",
    "- Attempt: 1",
    "",
    "## Summary",
    "",
    summary,
    "",
    "## Findings",
    "",
    ...findings.map((line) => `- ${line}`),
    "",
  ].join("\n");
}

/**
 * Two runs whose findings are deliberately UNEQUAL, so "top 3" has an order to
 * get right and a fourth class to leave out.
 *
 *   authorization-not-widened  4   (2 runs)
 *   unreachable-structure      3   (2 runs)
 *   test-cannot-fail           2   (2 runs)
 *   stale-comment              1   (1 run)
 *   other                      1   (1 run)  — never offered to the reviewer
 */
function twoRuns(): string {
  const root = tempRoot();

  write(root, "tldrx-work/260830-tenancy/run.yml", "id: 260830-tenancy\nstatus: done\n");
  write(root, "tldrx-work/260830-tenancy/04-build/log/S1.md", reviewLog("S1 · OTP", [
    "The tenant filter is not applied to the read model, so one tenant can list another's rows.",
    "`RateLimiter` is built but never called from the request pipeline.",
    "The endpoint gained a query parameter and no permission check widened with it.",
    "The button is two pixels off.",
  ], "The retry path is asserted by a test that cannot fail — it stubs the very call it checks."));

  write(root, "tldrx-work/260901-payments/run.yml", "id: 260901-payments\nstatus: done\n");
  write(root, "tldrx-work/260901-payments/04-build/log/S2.md", reviewLog("S2 · Refunds", [
    "Concurrent double-confirm mints two sessions for one credential.",
    "The refund handler is unreachable — no route registers it.",
    "The interface is dead code: nothing implements it.",
    "The docstring still describes the v1 signature.",
    "The permission check is missing on the new admin path entirely.",
  ], "This test always passes: the assertion compares the mock to itself."));

  return root;
}

// --- 1. the machine shape ----------------------------------------------------

/**
 * The contract, spelled out. A consumer that reads `trends[].example.src` must
 * keep reading it after the next release, and the only way to hold that is to
 * assert the key sets themselves rather than a couple of values inside them.
 */
const JSON_KEYS = [
  "version", "root", "runs", "contributed", "deduped", "classes", "trends", "findings",
] as const;
const TREND_KEYS = ["cls", "count", "runs", "example"] as const;
const EXAMPLE_KEYS = ["run", "kind", "text", "src"] as const;
const FINDING_KEYS = ["run", "kind", "cls", "text", "src"] as const;

describe("retro --all --json", () => {
  test("the top-level shape is exactly the documented keys", () => {
    const doc = toAllRetroJson(mineAll(twoRuns()));
    expect(Object.keys(doc).sort()).toEqual([...JSON_KEYS].sort());
    expect(doc.version).toBe(ALL_RETRO_JSON_VERSION);
    expect(doc.runs).toEqual(["260901-payments", "260830-tenancy"]);
    expect([...doc.contributed].sort()).toEqual(["260830-tenancy", "260901-payments"]);
    expect(doc.classes).toEqual([...FINDING_CLASSES]);
  });

  test("every trend carries a count, its runs and one cited example", () => {
    const doc = toAllRetroJson(mineAll(twoRuns()));
    expect(doc.trends.length).toBeGreaterThan(0);
    for (const trend of doc.trends) {
      expect(Object.keys(trend).sort()).toEqual([...TREND_KEYS].sort());
      expect(trend.count).toBeGreaterThan(0);
      expect(trend.runs.length).toBeGreaterThan(0);
      expect(trend.example).not.toBeNull();
      expect(Object.keys(trend.example ?? {}).sort()).toEqual([...EXAMPLE_KEYS].sort());
      expect(trend.example?.src).toMatch(/^\[src: tldrx-work\/.+:\d+\]$/);
    }
    const top = doc.trends[0];
    expect(top?.cls).toBe("authorization-not-widened");
    expect(top?.count).toBe(4);
    expect([...(top?.runs ?? [])]).toEqual(["260830-tenancy", "260901-payments"]);
  });

  test("findings are the raw rows an expert trainer would mine, one shape each", () => {
    const doc = toAllRetroJson(mineAll(twoRuns()));
    expect(doc.findings.length).toBe(11);
    for (const finding of doc.findings) {
      expect(Object.keys(finding).sort()).toEqual([...FINDING_KEYS].sort());
      expect(finding.text).not.toContain("[src:");
    }
  });

  test("the CLI prints parseable JSON on stdout, nothing else, and exits 0", async () => {
    const root = twoRuns();
    const run = await tldrx("retro", "--all", "--json", "--root", root);
    expect(run.code).toBe(EXIT_OK);
    expect(run.stderr).toBe("");
    const doc = JSON.parse(run.stdout) as Record<string, unknown>;
    expect(Object.keys(doc).sort()).toEqual([...JSON_KEYS].sort());
    // The table's prose must not leak into the machine shape.
    expect(run.stdout).not.toContain("CLASS");
    expect(run.stdout).not.toContain("Read-only:");
  });

  test("an empty workspace is the same shape with empty lists, at exit 0", async () => {
    const run = await tldrx("retro", "--all", "--json", "--root", tempRoot());
    expect(run.code).toBe(EXIT_OK);
    const doc = JSON.parse(run.stdout) as { runs: unknown[]; trends: unknown[]; findings: unknown[] };
    expect(Object.keys(doc).sort()).toEqual([...JSON_KEYS].sort());
    expect(doc.runs).toEqual([]);
    expect(doc.trends).toEqual([]);
    expect(doc.findings).toEqual([]);
  });

  test("--json without --all is refused: there is no per-run machine shape", async () => {
    const run = await tldrx("retro", "--json", "--root", twoRuns());
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.stderr).toContain("--all");
    expect(run.stdout).toBe("");
  });
});

// --- 2. the reviewer prompt --------------------------------------------------

const STORY: PlannedStory = {
  story: {
    version: 1,
    id: "S1",
    epic: "E1",
    title: "Confirm OTP",
    repo: "api",
    status: "todo",
    depends_on: [],
    touches: ["src/Auth/"],
    acceptance: ["A confirmed OTP mints exactly one session."],
    test_plan: [],
    evidence: [],
  },
  dod: { present: true, commands: ["bun test"] },
  text: "---\nid: S1\nstatus: todo\n---\n",
  path: "/tmp/S1.md",
  rel: "03-plan/stories/S1.md",
  wave: "w1",
};

function prompt(recurring?: Parameters<typeof buildReviewerPrompt>[0]["recurring"]): string {
  return buildReviewerPrompt({
    runId: "260901-fixture",
    story: STORY,
    repoName: "api",
    branch: "story/260901-fixture/S1",
    epicBranch: "epic/e1",
    worktree: "/tmp/wt",
    conventions: "- one class per file",
    dodResults: [{ command: "bun test", exitCode: 0 }],
    ...(recurring === undefined ? {} : { recurring }),
  });
}

describe("the reviewer prompt carries the workspace's recurring classes", () => {
  test("no history at all: no heading, no empty section, no noise", () => {
    expect(prompt()).not.toContain(REVIEWER_FOCUS_HEADING);
    expect(prompt([])).not.toContain(REVIEWER_FOCUS_HEADING);
    // Byte-identical: an absent aggregate must change nothing whatsoever.
    expect(prompt([])).toBe(prompt());
  });

  test("with history: the classes, their counts and a citation per class", () => {
    const text = prompt(recurringClasses(mineAll(twoRuns())));
    expect(text).toContain(REVIEWER_FOCUS_HEADING);
    expect(text).toContain("authorization-not-widened");
    expect(text).toContain("unreachable-structure");
    expect(text).toContain("test-cannot-fail");
    expect(text).toMatch(/\[src: tldrx-work\/.+:\d+\]/);
    // It is a prior, not a checklist — the prompt must say so, or it manufactures
    // findings to match the list it was handed.
    expect(text.toLowerCase()).toContain("not a checklist");
    // Before the criteria, so it frames the read rather than trailing it.
    expect(text.indexOf(REVIEWER_FOCUS_HEADING)).toBeLessThan(text.indexOf("## Acceptance criteria"));
  });

  test("`other` is never offered — it names no defect to look for", () => {
    const classes = recurringClasses(mineAll(twoRuns()));
    expect(classes.map((entry) => entry.cls)).not.toContain("other");
  });

  test("bounded at the top N, ranked by count", () => {
    const classes = recurringClasses(mineAll(twoRuns()));
    expect(classes.length).toBe(REVIEWER_FOCUS_TOP_N);
    expect(classes.map((entry) => entry.cls)).toEqual([
      "authorization-not-widened", "unreachable-structure", "test-cannot-fail",
    ]);
    for (let i = 1; i < classes.length; i++) {
      expect(classes[i - 1]!.count).toBeGreaterThanOrEqual(classes[i]!.count);
    }
  });

  test("an empty workspace yields no classes and no error", () => {
    const focus = workspaceRecurring(tempRoot());
    expect(focus.classes).toEqual([]);
    expect(focus.error).toBeNull();
  });

  test("a broken taxonomy file yields no classes and a NAMED error, never a throw", () => {
    const root = twoRuns();
    write(root, FINDING_CLASSES_FILE, "version: 1\nclasses:\n  - name: 'Not A Slug'\n    rules: ['x']\n");
    const focus = workspaceRecurring(root);
    expect(focus.classes).toEqual([]);
    expect(focus.error).toContain(FINDING_CLASSES_FILE);
    expect(focus.error).toContain("Not A Slug");
  });
});

// --- 3. the extensible taxonomy ---------------------------------------------

describe(".tldrx/memory/finding-classes.yml", () => {
  test("absent is the normal case: no extension, no complaint", () => {
    const root = tempRoot();
    expect(loadExtraClasses(root)).toEqual([]);
    expect(mineAll(root).classes).toEqual([...FINDING_CLASSES]);
  });

  test("a valid file extends the taxonomy, in file order, before `other`", () => {
    const root = twoRuns();
    write(root, FINDING_CLASSES_FILE, [
      "version: 1",
      "classes:",
      "  - name: flaky-timing",
      "    rules:",
      "      - 'flaky'",
      "      - 'timing[- ]dependent'",
      "  - name: pixel-nit",
      "    rules:",
      "      - 'two pixels'",
      "",
    ].join("\n"));
    const report = mineAll(root);
    expect(report.classes).toEqual([
      "test-cannot-fail", "missing-negative-control", "unreachable-structure",
      "stale-comment", "authorization-not-widened", "schema-drift",
      "flaky-timing", "pixel-nit", "other",
    ]);
    // The one finding that used to be `other` now has a name.
    const pixel = report.findings.find((finding) => finding.text.includes("two pixels"));
    expect(pixel?.cls).toBe("pixel-nit");
    expect(report.trends.find((trend) => trend.cls === "other")).toBeUndefined();
  });

  /**
   * The property that makes an unbounded taxonomy testable: an extension can only
   * ever claim a finding the built-in rules left as `other`. Every fixture in
   * `retro-all.test.ts` is therefore immune to whatever a workspace writes here.
   */
  test("an extension cannot steal a finding a built-in rule already claims", () => {
    const extra = loadClassesFrom([
      "version: 1",
      "classes:",
      "  - name: greedy",
      "    rules: ['.+ test', 'tenant', 'unreachable']",
      "",
    ].join("\n"));
    expect(classify("The tenant filter is not applied to the read model.", extra))
      .toBe("authorization-not-widened");
    expect(classify("the confirm handler is unreachable — no route registers it", extra))
      .toBe("unreachable-structure");
  });

  test("rules are case-insensitive, like every built-in rule", () => {
    const extra = loadClassesFrom("version: 1\nclasses:\n  - name: brand\n    rules: ['SHOUTING']\n");
    expect(classify("the copy is shouting at the user", extra)).toBe("brand");
  });

  const REFUSALS: readonly (readonly [string, string, string])[] = [
    ["not YAML at all", ":\n  - [\n", "does not parse"],
    ["not a mapping", "- one\n- two\n", "a mapping"],
    ["no version", "classes:\n  - name: x\n    rules: ['y']\n", "version: 1"],
    ["wrong version", "version: 2\nclasses:\n  - name: x\n    rules: ['y']\n", "version: 1"],
    ["no classes key", "version: 1\n", "classes"],
    ["classes not a list", "version: 1\nclasses: nope\n", "a list"],
    ["classes empty", "version: 1\nclasses: []\n", "at least one"],
    ["a class with no name", "version: 1\nclasses:\n  - rules: ['y']\n", "name"],
    ["a name that is not a slug", "version: 1\nclasses:\n  - name: 'Not A Slug'\n    rules: ['y']\n", "Not A Slug"],
    ["a name that shadows a built-in", "version: 1\nclasses:\n  - name: stale-comment\n    rules: ['y']\n", "built-in"],
    ["a name that shadows `other`", "version: 1\nclasses:\n  - name: other\n    rules: ['y']\n", "built-in"],
    ["a duplicated name", "version: 1\nclasses:\n  - name: a-b\n    rules: ['y']\n  - name: a-b\n    rules: ['z']\n", "twice"],
    ["a class with no rules", "version: 1\nclasses:\n  - name: a-b\n", "rules"],
    ["rules empty", "version: 1\nclasses:\n  - name: a-b\n    rules: []\n", "at least one"],
    ["a rule that is not a string", "version: 1\nclasses:\n  - name: a-b\n    rules: [7]\n", "a string"],
    ["a rule that is not a regex", "version: 1\nclasses:\n  - name: a-b\n    rules: ['(unclosed']\n", "not a regular expression"],
    ["a rule that matches everything", "version: 1\nclasses:\n  - name: a-b\n    rules: ['.*']\n", "matches every"],
    ["an empty rule", "version: 1\nclasses:\n  - name: a-b\n    rules: ['']\n", "matches every"],
  ];

  for (const [what, body, expected] of REFUSALS) {
    test(`refused, clearly: ${what}`, () => {
      let raised: unknown = null;
      try {
        loadClassesFrom(body);
      } catch (error) {
        raised = error;
      }
      expect(raised).toBeInstanceOf(FindingClassesError);
      const message = (raised as Error).message;
      expect(message).toContain(FINDING_CLASSES_FILE);
      expect(message).toContain(expected);
    });
  }

  test("too many classes is a refusal, not an unbounded loop", () => {
    const many = ["version: 1", "classes:"];
    for (let i = 0; i < 40; i++) many.push(`  - name: c-${String(i)}`, "    rules: ['x']");
    expect(() => loadClassesFrom(`${many.join("\n")}\n`)).toThrow(FindingClassesError);
  });

  test("`retro --all` refuses a broken file loudly, and writes nothing", async () => {
    const root = twoRuns();
    write(root, FINDING_CLASSES_FILE, "version: 1\nclasses:\n  - name: a-b\n    rules: ['(unclosed']\n");
    const run = await tldrx("retro", "--all", "--root", root);
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain(FINDING_CLASSES_FILE);
    expect(run.stderr).toContain("not a regular expression");
  });

  test("`retro --all --json` refuses the same way — never half a document", async () => {
    const root = twoRuns();
    write(root, FINDING_CLASSES_FILE, "version: 1\nclasses: []\n");
    const run = await tldrx("retro", "--all", "--json", "--root", root);
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("at least one");
  });

  /** Write the body to a temp workspace and load it — the real file path, every time. */
  function loadClassesFrom(body: string): ReturnType<typeof loadExtraClasses> {
    const root = tempRoot();
    write(root, FINDING_CLASSES_FILE, body);
    return loadExtraClasses(root);
  }
});

// --- 2b. the wire, end to end ------------------------------------------------

/**
 * The unit tests above prove the renderer and the selector. Neither proves the
 * EXECUTOR calls them — which is `unreachable-structure`, the third most common
 * finding this framework's own runs produce. So one real Build workspace, driven
 * to a review bundle, and the bytes on disk are the assertion.
 */
describe("the Build executor's review path injects it", () => {
  const ORIGINAL_PATH = process.env.PATH ?? "";
  const FAKE_KEYS = [
    "FAKE_BUILD_STATE", "FAKE_BUILD_COST", "FAKE_BUILD_FAIL", "FAKE_BUILD_FAIL_REASON",
  ] as const;
  let open: BuildWorkspace[] = [];

  afterEach(() => {
    process.env.PATH = ORIGINAL_PATH;
    for (const key of FAKE_KEYS) delete process.env[key];
    for (const ws of open) ws.dispose();
    open = [];
  });

  const ONE_STORY: BuildWorkspaceOptions = {
    stories: [{ id: "S1", epic: "E1", title: "First story" }],
    epics: [{ id: "E1", stories: ["S1"], branch: "epic/e1" }],
    waves: [["S1"]],
  };

  function workspace(files?: Readonly<Record<string, string>>): BuildWorkspace {
    const made = makeBuildWorkspace(files === undefined ? ONE_STORY : { ...ONE_STORY, files });
    open.push(made);
    process.env.PATH = made.binDir;
    process.env.FAKE_BUILD_STATE = made.statePath;
    return made;
  }

  function next(ws: BuildWorkspace, overrides: Partial<NextOptions> = {}): Promise<unknown> {
    return runNext({
      root: ws.root, dryRun: false, mode: "headless", yolo: false,
      actor: "alan", at: "2026-08-29T09:00:00Z", ...overrides,
    });
  }

  /** Drive S1 to `review` with an errored reviewer, then re-enter the stage. */
  async function stallAtReview(ws: BuildWorkspace): Promise<void> {
    process.env.FAKE_BUILD_COST = "0";
    process.env.FAKE_BUILD_FAIL_REASON = "Reached maximum budget ($1)";
    process.env.FAKE_BUILD_FAIL = "reviewer:S1#1";
    await next(ws);
    reject(RunStore.open(ws.runDir), {
      root: ws.root, actor: "alan", at: "2026-08-29T10:00:00Z", note: "the reviewer died at its cap",
    });
  }

  function bundledPrompt(ws: BuildWorkspace): string {
    return readFileSync(join(ws.runDir, ".agent", "build", "S1", REVIEW_DIR, "prompt.md"), "utf8");
  }

  const PRIOR_RUN: Readonly<Record<string, string>> = {
    "tldrx-work/251201-prior/run.yml": "id: 251201-prior\nstatus: done\n",
    "tldrx-work/251201-prior/04-build/log/S9.md": reviewLog("S9 · prior", [
      "The tenant filter is not applied to the read model, so one tenant can list another's rows.",
      "The permission check is missing on the new admin path entirely.",
    ], "The retry path is asserted by a test that cannot fail — it stubs the very call it checks."),
  };

  test("with a prior run, the bundled prompt carries the recurring classes", async () => {
    const ws = workspace(PRIOR_RUN);
    await stallAtReview(ws);
    await next(ws, { mode: "prepare", at: "2026-08-29T10:05:00Z" });
    const text = bundledPrompt(ws);
    expect(text).toContain(REVIEWER_FOCUS_HEADING);
    expect(text).toContain("authorization-not-widened");
    expect(text).toContain("[src: tldrx-work/251201-prior/04-build/log/S9.md:");
  }, 120_000);

  test("with no prior run, the prompt is unchanged — the section is simply not there", async () => {
    const ws = workspace();
    await stallAtReview(ws);
    await next(ws, { mode: "prepare", at: "2026-08-29T10:05:00Z" });
    expect(bundledPrompt(ws)).not.toContain(REVIEWER_FOCUS_HEADING);
  }, 120_000);
});
