/**
 * WHICH MODEL JUDGES THE DIFF — `reviewer:`, `reviewer_by_stakes:`, and the
 * record of what produced a verdict (#178).
 *
 * The measurement this exists to make possible: across three real workspaces and
 * 168 Build stories, the developer and the reviewer ran the same model at the
 * same effort every single time, because `stage.yml` pinned them per STAGE and
 * one accessor served both roles. Zero reviewers ran on anything stronger, and
 * no review record named the model behind its verdict — so "does a stronger
 * reviewer find more" could not be asked of the data at all.
 *
 * Every assertion here is against BEHAVIOUR, not against the constant that
 * produced it: the reviewer's model is read out of the argv the fake `claude`
 * was actually invoked with, and the developer's argv from the SAME run is
 * asserted alongside it — a change that moved both roles would pass a test that
 * only looked at one.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runNext, type NextOptions } from "../src/core/facilitator/runNext.ts";
import { resolveReviewer } from "../src/core/facilitator/reviewerModel.ts";
import {
  REVIEWER_NOT_RECORDED, renderReviewerProvenance,
} from "../src/core/build/reviewerProvenance.ts";
import { readReviewLedger } from "../src/core/build/reviewLedger.ts";
import { renderReviewLog } from "../src/core/build/review.ts";
import { loadRun, renderReplay } from "../src/core/replay/index.ts";
import { validateStory } from "../src/core/schemas/story.ts";
import { validateStage } from "../src/core/schemas/stage.ts";
import { renderPlanSchemaContract } from "../src/core/plan/schemaContract.ts";
import type { StoryOutcome } from "../src/core/build/outcome.ts";
import {
  makeBuildWorkspace, type BuildWorkspace, type BuildWorkspaceOptions,
} from "./fixtures/build/workspace.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

// This file spawns real processes — git, the fake `claude`. Process cost is a
// property of the machine, so bun's fixed 5000 ms default measures the box.
setDefaultTimeout(spawnTestTimeout());

const ORIGINAL_PATH = process.env.PATH ?? "";
const FAKE_KEYS = [
  "FAKE_BUILD_STATE", "FAKE_BUILD_COST", "FAKE_BUILD_ARGV_LOG", "FAKE_BUILD_VERDICTS",
  "FAKE_BUILD_FAIL", "FAKE_BUILD_FAIL_REASON",
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
  process.env.FAKE_BUILD_COST = "0.10";
  return made;
}

function next(ws: BuildWorkspace, overrides: Partial<NextOptions> = {}) {
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

/** One story, one epic, one wave — the smallest thing that spawns both roles. */
const ONE_STORY: BuildWorkspaceOptions = {
  stories: [{ id: "S1", epic: "E1", title: "First story" }],
  epics: [{ id: "E1", stories: ["S1"], branch: "epic/e1" }],
  waves: [["S1"]],
};

/**
 * The `--model` and `--effort` each spawn was actually given, in call order.
 *
 * Read off the argv the fake `claude` logged, never off an event: an event is
 * what the executor SAID it did, and the whole question here is what it passed
 * to the provider CLI. `null` is "the flag was not passed at all", which is a
 * different fact from a model named `null`.
 */
async function spawns(
  ws: BuildWorkspace,
  overrides: Partial<NextOptions> = {},
): Promise<readonly { model: string | null; effort: string | null }[]> {
  const argvLog = join(ws.root, "argv.log");
  process.env.FAKE_BUILD_ARGV_LOG = argvLog;
  await next(ws, overrides);
  return readFileSync(argvLog, "utf8").trim().split("\n")
    .map((line) => JSON.parse(line) as string[])
    .map((argv) => ({ model: flag(argv, "--model"), effort: flag(argv, "--effort") }));
}

function flag(argv: readonly string[], name: string): string | null {
  const at = argv.indexOf(name);
  return at === -1 ? null : argv[at + 1] ?? null;
}

/**
 * Drive the story to the point where a REVIEWER BUNDLE is on disk and the host
 * owns the verdict — the cursor-mode shape.
 *
 * The reviewer's first spawn is made to die, which is what leaves the review
 * outstanding; the following `--prepare` writes the bundle rather than a second
 * developer, because the diff is already merged and its DoD was green. Copied in
 * shape from `fixlist.test.ts`'s `handOffReview`, which is the same handshake.
 */
async function handOffReview(ws: BuildWorkspace): Promise<string> {
  process.env.FAKE_BUILD_FAIL = "reviewer:S1#1";
  process.env.FAKE_BUILD_FAIL_REASON = "the reviewer died mid-read";
  await next(ws, { mode: "prepare" });
  writeFileSync(join(ws.root, ".tldrx", "worktrees", "app", `${ws.runId}-S1`, "s1.txt"), "S1\n", "utf8");
  writeFileSync(
    join(ws.runDir, ".agent", "build", "S1", "result.json"),
    JSON.stringify({ outputs: ["s1.txt"], questions_asked: [], notes: "", cost_usd: 0 }),
    "utf8",
  );
  await next(ws, { mode: "commit", at: "2026-08-29T09:30:00Z" });
  await next(ws, { mode: "prepare", at: "2026-08-29T09:40:00Z" });
  const dir = join(ws.runDir, ".agent", "build", "S1", "review");
  expect(existsSync(join(dir, "pending.json"))).toBe(true);
  return dir;
}

/** The host's answer to the reviewer bundle, as a `result.json` it wrote. */
function answerReview(dir: string): void {
  writeFileSync(join(dir, "result.json"), JSON.stringify({
    verdict: "approve", summary: "read the diff", findings: [],
  }), "utf8");
}

/** Every `check.passed`/`check.failed` payload for the review check, in order. */
function reviewChecks(runDir: string): readonly Record<string, unknown>[] {
  return readFileSync(join(runDir, "events.jsonl"), "utf8").trim().split("\n")
    .map((line) => JSON.parse(line) as { type?: string; payload?: Record<string, unknown> })
    .filter((e) => e.type === "check.passed" || e.type === "check.failed")
    .map((e) => e.payload ?? {})
    .filter((p) => p.check === "review");
}

describe("(a) a stage that declares neither block resolves exactly as it always did", () => {
  test("the resolution is the stage's own two values, attributed to the stage", () => {
    expect(resolveReviewer({
      cliModel: null, cliEffort: null, stakes: null, byStakes: {}, reviewer: null,
      stageModel: "sonnet", stageEffort: "high",
    })).toEqual({ model: "sonnet", effort: "high", modelFrom: "stage", effortFrom: "stage" });
  });

  test("and the reviewer spawn gets the SAME argv the developer got", async () => {
    const ws = workspace(ONE_STORY);
    const seen = await spawns(ws);
    expect(seen).toHaveLength(2);                      // developer, then reviewer
    expect(seen[1]).toEqual(seen[0] as never);
    expect(seen[1]?.model).toBe("sonnet");
  }, 60_000);
});

describe("(b) `reviewer:` moves the REVIEWER and nothing else", () => {
  test("it reaches the reviewer's argv while the developer's is untouched", async () => {
    const ws = workspace({ ...ONE_STORY, reviewer: { model: "opus", effort: "xhigh" } });
    const seen = await spawns(ws);
    expect(seen[0]).toEqual({ model: "sonnet", effort: null });   // the developer
    expect(seen[1]).toEqual({ model: "opus", effort: "xhigh" });  // the reviewer
  }, 60_000);

  test("and the reviewer bundle's pending.json carries it too", async () => {
    const ws = workspace({ ...ONE_STORY, reviewer: { model: "opus", effort: "xhigh" } });
    const dir = await handOffReview(ws);

    const pending = JSON.parse(readFileSync(join(dir, "pending.json"), "utf8")) as
      { model?: string; effort?: string; role?: string };
    expect(pending.role).toBe("reviewer");
    expect(pending.model).toBe("opus");
    expect(pending.effort).toBe("xhigh");
  }, 90_000);
});

describe("(c) `reviewer_by_stakes` wins over `reviewer`, and only for a story that declared them", () => {
  test("a security story gets the calibrated reviewer; an undeclared one falls back", async () => {
    const ws = workspace({
      stories: [
        { id: "S1", epic: "E1", title: "Security story", stakes: "security" },
        { id: "S2", epic: "E1", title: "Plain story", dependsOn: ["S1"] },
      ],
      epics: [{ id: "E1", stories: ["S1", "S2"], branch: "epic/e1" }],
      waves: [["S1"], ["S2"]],
      reviewer: { model: "haiku" },
      reviewerByStakes: { security: { model: "opus", effort: "max" } },
    });
    const seen = await spawns(ws);
    // dev S1, reviewer S1, dev S2, reviewer S2.
    expect(seen[1]).toEqual({ model: "opus", effort: "max" });
    expect(seen[3]).toEqual({ model: "haiku", effort: null });
    expect(seen[0]?.model).toBe("sonnet");
    expect(seen[2]?.model).toBe("sonnet");
  }, 90_000);

  test("the two layers resolve field by field, not block by block", () => {
    // `reviewer:` names an effort the stakes row does not, so the stakes row wins
    // the model and the `reviewer:` block keeps the effort. A block-level
    // precedence would drop `high` and pass nothing.
    expect(resolveReviewer({
      cliModel: null, cliEffort: null, stakes: "security",
      byStakes: { security: { model: "opus" } },
      reviewer: { effort: "high" },
      stageModel: "sonnet", stageEffort: null,
    })).toEqual({ model: "opus", effort: "high", modelFrom: "stakes", effortFrom: "reviewer" });
  });
});

describe("(d) an explicit CLI flag is the operator's word and outranks both", () => {
  test("`--model` beats `reviewer_by_stakes` on the story it matches", async () => {
    const ws = workspace({
      ...ONE_STORY,
      stories: [{ id: "S1", epic: "E1", title: "Security story", stakes: "security" }],
      reviewerByStakes: { security: { model: "opus" } },
    });
    const seen = await spawns(ws, { model: "haiku" });
    expect(seen[0]?.model).toBe("haiku");
    expect(seen[1]?.model).toBe("haiku");
  }, 60_000);
});

describe("(e) a review record says which reviewer produced it, or says it cannot", () => {
  test("a spawned verdict is attributed from the spawn that produced it", async () => {
    const ws = workspace({ ...ONE_STORY, reviewer: { model: "opus", effort: "xhigh" } });
    await next(ws);
    expect(readReviewLedger(ws.runDir, "S1").reviewer)
      .toEqual({ model: "opus", effort: "xhigh", basis: "spawned" });
    expect(readFileSync(join(ws.runDir, "04-build", "log", "S1.md"), "utf8"))
      .toContain("- Reviewer: opus · effort xhigh (spawned)");
  }, 60_000);

  test("a HOST review carries what the host declared, labelled as the host's word", async () => {
    const ws = workspace(ONE_STORY);
    const dir = await handOffReview(ws);
    answerReview(dir);
    await next(ws, {
      mode: "commit", review: true, model: "opus", effort: "high", at: "2026-08-29T10:00:00Z",
    });

    const host = reviewChecks(ws.runDir).at(-1) ?? {};
    expect(host.source).toBe("host");
    expect(host.model).toBe("opus");
    expect(host.effort).toBe("high");
    expect(host.basis).toBe("host-declared");
    expect(readReviewLedger(ws.runDir, "S1").reviewer)
      .toEqual({ model: "opus", effort: "high", basis: "host-declared" });
  }, 90_000);

  test("a host review that declared nothing is `not recorded`, never the bundle's suggestion", async () => {
    const ws = workspace({ ...ONE_STORY, reviewer: { model: "opus" } });
    const dir = await handOffReview(ws);
    // The bundle SUGGESTS opus — the point of the assertion below is that a
    // record which had merely copied that field would have said "opus".
    const pending = JSON.parse(readFileSync(join(dir, "pending.json"), "utf8")) as { model?: string };
    expect(pending.model).toBe("opus");
    answerReview(dir);
    await next(ws, { mode: "commit", review: true, at: "2026-08-29T10:00:00Z" });

    const host = reviewChecks(ws.runDir).at(-1) ?? {};
    expect(host.source).toBe("host");
    expect(host.model).toBeUndefined();
    expect(host.basis).toBeUndefined();
    expect(readReviewLedger(ws.runDir, "S1").reviewer).toBeNull();
    expect(readFileSync(join(ws.runDir, "04-build", "log", "S1.md"), "utf8"))
      .toContain(`- Reviewer: ${REVIEWER_NOT_RECORDED}`);
  }, 90_000);

  test("`tldrx replay` names the model on every review round, approved ones included", async () => {
    const ws = workspace({ ...ONE_STORY, reviewer: { model: "opus", effort: "xhigh" } });
    await next(ws);

    const loaded = loadRun(ws.root, ws.runId);
    expect(loaded).not.toBeNull();
    const narrative = renderReplay(loaded as NonNullable<typeof loaded>);
    // The round used to be invisible in the narrative when it PASSED — `bullet`
    // had a case for `check.failed` and none for `check.passed` — so a run whose
    // reviewer approved showed no review line at all, let alone a model.
    expect(narrative).toContain("review approve for story S1 by opus · effort xhigh (spawned)");
  }, 60_000);

  test("an outcome with no reviewer field at all — an old record — reads as not recorded", () => {
    const outcome = {
      id: "S1", title: "t", wave: "W1", repo: "app", epic: "E1", epicBranch: "epic/e1",
      branch: "story/x/S1", status: "done", attempts: 1, dod: [], commit: "abc",
      merged: true, carried: 1, conflicts: [], verdict: "approve", developerError: null,
      reviewSummary: "s", reviewFindings: [], reviewRel: "04-build/log/S1.md",
      reason: null, rescued: null, cost_usd: 0,
    } as StoryOutcome;
    expect(outcome.reviewer).toBeUndefined();
    expect(renderReviewLog(outcome)).toContain(`- Reviewer: ${REVIEWER_NOT_RECORDED}`);
    expect(renderReviewerProvenance(undefined)).toBe(REVIEWER_NOT_RECORDED);
  });
});

describe("(f) an unknown `stakes` is refused, and the refusal names the field", () => {
  const STORY = {
    version: 1, id: "S1", epic: "E1", title: "t", repo: "app", status: "todo",
    depends_on: [], touches: ["src/a.ts"], acceptance: ["a"], test_plan: ["t"], evidence: [],
  };

  test("a declared value outside the five is a validation issue on `stakes`", () => {
    const result = validateStory({ ...STORY, stakes: "critical" });
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.path === "stakes");
    expect(issue?.message).toContain("security | money | data | correctness | routine");
  });

  test("a declared value inside the five validates, and so does no value at all", () => {
    expect(validateStory({ ...STORY, stakes: "security" }).ok).toBe(true);
    expect(validateStory(STORY).ok).toBe(true);
  });

  test("the Plan prompt states the vocabulary, so the agent can emit it", () => {
    const contract = renderPlanSchemaContract();
    expect(contract).toContain("stakes");
    expect(contract).toContain("`security`, `money`, `data`, `correctness`, `routine`");
  });

  test("a `reviewer_by_stakes` key outside the five is refused at the STAGE, not ignored", () => {
    const stage = {
      name: "build", title: "Build", phase: 4, inputs: [], outputs: [], experts: [],
      model: "sonnet", budget_usd: 8, gate: { type: "human-approval" },
    };
    const result = validateStage({ ...stage, reviewer_by_stakes: { secutiry: { model: "opus" } } });
    expect(result.ok).toBe(false);
    expect(result.issues.find((i) => i.path === "reviewer_by_stakes.secutiry")?.message)
      .toContain("security | money | data | correctness | routine");
    expect(validateStage({ ...stage, reviewer_by_stakes: { security: { model: "opus" } } }).ok).toBe(true);
  });

  test("an effort outside the five levels is refused on a reviewer block", () => {
    const stage = {
      name: "build", title: "Build", phase: 4, inputs: [], outputs: [], experts: [],
      model: "sonnet", budget_usd: 8, gate: { type: "human-approval" },
    };
    const result = validateStage({ ...stage, reviewer: { effort: "extreme" } });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.path === "reviewer.effort")).toBe(true);
  });
});
