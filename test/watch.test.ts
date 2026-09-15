/**
 * The Watch phase (concept §10, spec §2.16, §5 "Watch executor").
 *
 * Every test runs the real executor against a real run on disk. The only thing
 * faked is the sub-agent: a `claude` first on PATH that writes a canned card. So
 * the pre-pass really reads the stories, the card is really re-read off disk, the
 * status is really recomputed, and the handoff is really the one a reviewer would
 * open — for $0.00.
 *
 * The assertion that matters most is the one about `draft`: a card whose Signal
 * cites `absent:` must NOT come out verified, however confidently the model wrote
 * it. That is the whole feature.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TEMPLATES_DIR } from "../src/core/paths.ts";
import { watchExecutor } from "../src/core/facilitator/executors/watch.ts";
import { executorFor, EXECUTORS, type ExecutorContext } from "../src/core/facilitator/executors/index.ts";
import { claimEpicBranches } from "../src/core/facilitator/runNext.ts";
import { loadStageSpec } from "../src/core/facilitator/stageSpec.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { validateHandoff } from "../src/core/text/handoff.ts";
import { parseSrcToken } from "../src/core/text/srcToken.ts";
import { PREVIOUS_ATTEMPT_HEADING } from "../src/core/facilitator/prompt.ts";
import { clearSrcCaches } from "../src/core/text/srcToken.ts";
import { loadWorkspace, toSrcContext } from "../src/hooks/lib/workspace.ts";
import {
  checkCard, collectFeatures, featureBrief, loadCards, NO_SRC_TOKEN_ISSUE, parseWatcherCard, queryBlock,
  renderWatchFacts, renderWatchList, setWatcherStatus, watcherRelPath, WATCH_PHASE,
} from "../src/core/watch/index.ts";
import type { Fact } from "../src/core/facts/Fact.ts";
import { makeFacilitatorWorkspace, type FacilitatorWorkspace } from "./fixtures/facilitator/workspace.ts";

const ORIGINAL_PATH = process.env.PATH ?? "";
const FAKE_KEYS = [
  "FAKE_CLAUDE_RUNDIR", "FAKE_CLAUDE_OUTPUTS", "FAKE_CLAUDE_COST", "FAKE_CLAUDE_IS_ERROR", "FAKE_CLAUDE_PROMPT_OUT",
] as const;

let open: FacilitatorWorkspace[] = [];

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  for (const key of FAKE_KEYS) delete process.env[key];
  for (const ws of open) ws.dispose();
  open = [];
  clearSrcCaches();
});

// --- the fixture -----------------------------------------------------------

/** A file in `api/` the cards can cite by line — a `[src: …]` must RESOLVE. */
const LEADERBOARD_CS = [
  "public sealed class LeaderboardRefresher",
  "{",
  "    public void Refresh() => _log.LogInformation(\"leaderboard.refreshed {Rows}\", rows);",
  "}",
  "",
].join("\n");

function story(id: string, epic: string, status: string, repo = "api"): string {
  const evidence = status === "done" ? `evidence: ["npm run test exited 0"]` : "evidence: []";
  return [
    "---",
    "version: 1",
    `id: ${id}`,
    `epic: ${epic}`,
    `title: "${id} on ${epic}"`,
    `repo: ${repo}`,
    `status: ${status}`,
    "depends_on: []",
    'touches: ["src/"]',
    'acceptance: ["it works"]',
    'test_plan: ["a unit test"]',
    evidence,
    "---",
    "",
    `# ${id}`,
    "",
    "## Definition of done",
    "",
    "```dod",
    "true",
    "```",
    "",
  ].join("\n");
}

function epic(id: string, branch: string, stories: readonly string[], repos = "[api]"): string {
  return [
    "---",
    "version: 1",
    `id: ${id}`,
    `title: "${id} — a shipped thing"`,
    `repos: ${repos}`,
    `stories: [${stories.join(", ")}]`,
    `branch: ${branch}`,
    "status: done",
    "---",
    "",
    `# ${id}`,
    "",
  ].join("\n");
}

/** A card the fake agent "writes". `signal` is the ONE line under `## Signal`. */
function card(id: string, stories: readonly string[], signal: string, status = "draft"): string {
  return [
    "---",
    "version: 1",
    `id: ${id}`,
    "epic: E1",
    `title: "${id} — a shipped thing"`,
    `stories: [${stories.join(", ")}]`,
    "repos: [api]",
    `status: ${status}`,
    "---",
    "",
    `# ${id}`,
    "",
    "## Signal",
    `- ${signal}`,
    "",
    "## Where",
    "- Application Insights `traces` [src: api:src/Leaderboard.cs:3]",
    "",
    "## Healthy baseline",
    "- 12-40 refreshes/hour [src: api:src/Leaderboard.cs:3]",
    "",
    "## Looks broken when",
    "- Zero refreshes for 30 minutes [src: api:src/Leaderboard.cs:3]",
    "",
    "## Query",
    "",
    QUERY_FENCE,
    "",
    "## Sources",
    "",
    "`Leaderboard.cs:3` is the only place the event is emitted.",
    "",
  ].join("\n");
}

const LIVE_SIGNAL = "`leaderboard.refreshed` is emitted on every refresh [src: api:src/Leaderboard.cs:3]";
const ABSENT_SIGNAL = "Nothing is emitted on refresh — add a counter [src: absent:api/src/Leaderboard.cs]";

/** The fenced `## Query` every card here carries, so a test can swap it out whole. */
const QUERY_FENCE = [
  "```kql",
  'traces | where message startswith "leaderboard.refreshed"',
  "```",
].join("\n");

/** gh #212 — the absent-with-reason shape of `## Query`, on one line. */
const QUERY_NONE =
  "Query: none — nothing in this path emits a log line, a metric or a span"
  + " [src: absent:api/src/Leaderboard.cs]";

interface Fixture {
  readonly ws: FacilitatorWorkspace;
  readonly ctx: ExecutorContext;
}

/** A run with a `watch` stage, plus a Plan folder shaped by `plan`. */
function fixture(plan: Readonly<Record<string, string>> = defaultPlan()): Fixture {
  const ws = makeFacilitatorWorkspace({
    scope: "demo",
    budgetUsd: 10,
    stages: [{
      id: "watch",
      phase: WATCH_PHASE,
      budgetUsd: 2,
      gate: "approve",
      outputs: [{ path: "handoff.md", sections: ["Findings", "Decisions", "Unknowns", "Evidence ledger"] }],
    }],
    files: { "api/src/Leaderboard.cs": LEADERBOARD_CS },
  });
  open.push(ws);
  for (const [rel, content] of Object.entries(plan)) {
    const path = join(ws.runDir, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content, "utf8");
  }
  const store = RunStore.open(ws.runDir);
  return {
    ws,
    ctx: {
      root: ws.root,
      runId: store.runId,
      runDir: ws.runDir,
      phaseId: WATCH_PHASE,
      stageId: "watch",
      spec: loadStageSpec(ws.root, "demo", "watch"),
      repos: store.run.repos,
      mode: "headless",
      model: null,
      modelFlag: null,
      effortFlag: null,
      effort: null,
      costUsd: null,
      tokens: null,
      budgetUsd: 2,
      maxBudgetUsd: 2,
      yolo: false,
      at: "2026-08-30T10:00:00Z",
      relaunching: false,
      // wave5 added these three to ExecutorContext; `runNext` supplies them for
      // real. Here they are the identity: no worktrees, no split, no ledger.
      keepWorktrees: false,
      parallel: 1,
      reuseEpic: false,
      discardPending: false,
      review: false,
      attendedByHost: false,
      agentCap: (share = 1) => Math.round(2 * share * 100) / 100,
      emit: () => undefined,
      // #262: the real merge, not a no-op — a fake that swallowed the claim would
      // let a call site land green while `run.yml` said nothing.
      claimEpicBranch: (branch, branchModel) => { claimEpicBranches(store, [branch], branchModel); },
    },
  };
}

/** 2 done stories on E1, 1 not-done story on E2 — the shape the wave brief names. */
function defaultPlan(): Record<string, string> {
  return {
    "03-plan/stories/S1.md": story("S1", "E1", "done"),
    "03-plan/stories/S2.md": story("S2", "E1", "done"),
    "03-plan/stories/S3.md": story("S3", "E2", "todo"),
    "03-plan/epics/E1.md": epic("E1", "epic/leaderboard", ["S1", "S2"]),
    "03-plan/epics/E2.md": epic("E2", "epic/other", ["S3"]),
  };
}

function fakeClaude(ws: FacilitatorWorkspace, outputs: Readonly<Record<string, string>>): void {
  process.env.PATH = ws.binDir;
  process.env.FAKE_CLAUDE_RUNDIR = ws.runDir;
  process.env.FAKE_CLAUDE_OUTPUTS = JSON.stringify(outputs);
  process.env.FAKE_CLAUDE_COST = "0.11";
}

function read(ws: FacilitatorWorkspace, rel: string): string {
  return readFileSync(join(ws.runDir, rel), "utf8");
}

// --- the deterministic pre-pass --------------------------------------------

describe("the pre-pass groups DONE stories by epic", () => {
  test("two done stories on one epic become one feature, named after the branch", () => {
    const { ws } = fixture();
    const features = collectFeatures(ws.runDir);

    expect(features).toHaveLength(1);
    expect(features[0]?.id).toBe("leaderboard");
    expect(features[0]?.epicId).toBe("E1");
    expect(features[0]?.stories.map((s) => s.story.id)).toEqual(["S1", "S2"]);
    expect(features[0]?.repos).toEqual(["api"]);
  });

  test("an epic whose stories are not done ships nothing", () => {
    const { ws } = fixture();
    expect(collectFeatures(ws.runDir).map((f) => f.epicId)).not.toContain("E2");
  });

  test("a second epic with a done story becomes a second feature", () => {
    const plan = defaultPlan();
    plan["03-plan/stories/S3.md"] = story("S3", "E2", "done", "lab");
    const { ws } = fixture(plan);
    const features = collectFeatures(ws.runDir);

    expect(features.map((f) => f.id)).toEqual(["leaderboard", "other"]);
    expect(features[1]?.repos).toEqual(["lab", "api"]);
  });

  test("a done story whose epic has no file still ships, keyed on the epic id", () => {
    const plan = defaultPlan();
    delete plan["03-plan/epics/E1.md"];
    const { ws } = fixture(plan);
    const features = collectFeatures(ws.runDir);

    expect(features).toHaveLength(1);
    expect(features[0]?.id).toBe("e1");
    expect(features[0]?.epic).toBeNull();
  });
});

// --- the executor ----------------------------------------------------------

describe("the watch executor writes one card per shipped feature", () => {
  test("the card is created and the handoff names it", async () => {
    const { ws, ctx } = fixture();
    fakeClaude(ws, { [watcherRelPath("leaderboard")]: card("leaderboard", ["S1", "S2"], LIVE_SIGNAL) });

    const outcome = await watchExecutor(ctx);

    expect(outcome.ok).toBe(true);
    expect(outcome.awaiting).toBe(false);
    expect(existsSync(join(ws.runDir, watcherRelPath("leaderboard")))).toBe(true);
    expect(outcome.outputs).toContain(watcherRelPath("leaderboard"));
    expect(outcome.tasks).toHaveLength(1);
    expect(outcome.costUsd).toBeCloseTo(0.11, 5);

    const handoff = read(ws, `${WATCH_PHASE}/handoff.md`);
    expect(handoff).toContain("`leaderboard`");
    expect(handoff).toContain(`[src: ${watcherRelPath("leaderboard")}:1]`);
  });

  test("one sub-agent per feature, not one per stage", async () => {
    const plan = defaultPlan();
    plan["03-plan/stories/S3.md"] = story("S3", "E2", "done", "lab");
    const { ws, ctx } = fixture(plan);
    fakeClaude(ws, {
      [watcherRelPath("leaderboard")]: card("leaderboard", ["S1", "S2"], LIVE_SIGNAL),
      [watcherRelPath("other")]: card("other", ["S3"], LIVE_SIGNAL),
    });

    const outcome = await watchExecutor(ctx);

    expect(outcome.ok).toBe(true);
    expect(outcome.tasks.map((t) => t.key)).toEqual(["leaderboard", "other"]);
    expect(outcome.costUsd).toBeCloseTo(0.22, 5);
  });

  test("a Signal with no `absent:` source earns `verified`", async () => {
    const { ws, ctx } = fixture();
    fakeClaude(ws, { [watcherRelPath("leaderboard")]: card("leaderboard", ["S1", "S2"], LIVE_SIGNAL) });

    await watchExecutor(ctx);

    expect(read(ws, watcherRelPath("leaderboard"))).toContain("status: verified");
    expect(read(ws, `${WATCH_PHASE}/handoff.md`)).toContain("**verified**");
  });

  test("a Signal citing `absent:` stays `draft`, whatever the model wrote", async () => {
    const { ws, ctx } = fixture();
    // The model claims `verified`; the code emits nothing. The framework decides.
    fakeClaude(ws, {
      [watcherRelPath("leaderboard")]: card("leaderboard", ["S1", "S2"], ABSENT_SIGNAL, "verified"),
    });

    const outcome = await watchExecutor(ctx);

    expect(outcome.ok).toBe(true);
    expect(read(ws, watcherRelPath("leaderboard"))).toContain("status: draft");
    const handoff = read(ws, `${WATCH_PHASE}/handoff.md`);
    expect(handoff).toContain("**draft**");
    expect(handoff).toContain("is not observable yet");
  });

  /**
   * gh #212. A card that can say "nothing is queryable, and here is what I looked
   * at" must not then vanish from the artefact the next reader trusts most. The
   * Findings list says `unobservable` in its own line, sourced to the card — an
   * omission would read as a card that simply has a query somewhere.
   */
  test("a card whose Query is `none` is listed as unobservable in the handoff", async () => {
    const { ws, ctx } = fixture();
    fakeClaude(ws, {
      [watcherRelPath("leaderboard")]:
        card("leaderboard", ["S1", "S2"], ABSENT_SIGNAL).replace(QUERY_FENCE, QUERY_NONE),
    });

    const outcome = await watchExecutor(ctx);

    expect(outcome.ok).toBe(true);
    const handoff = read(ws, `${WATCH_PHASE}/handoff.md`);
    expect(handoff).toContain("**unobservable**");
    expect(handoff).toContain("nothing in this path emits a log line, a metric or a span");
    expect(validateHandoff(handoff, toSrcContext(loadWorkspace(ws.root), ws.runDir)).ok).toBe(true);
  });

  test("the handoff satisfies the §2.8 handoff rules", async () => {
    const { ws, ctx } = fixture();
    fakeClaude(ws, { [watcherRelPath("leaderboard")]: card("leaderboard", ["S1", "S2"], LIVE_SIGNAL) });
    await watchExecutor(ctx);

    const validation = validateHandoff(
      read(ws, `${WATCH_PHASE}/handoff.md`),
      toSrcContext(loadWorkspace(ws.root), ws.runDir),
    );
    expect(validation.missingSections).toEqual([]);
    expect(validation.emptySections).toEqual([]);
    expect(validation.unsourced).toEqual([]);
    expect(validation.unresolved).toEqual([]);
    expect(validation.ok).toBe(true);
  });

  test("a card that does not validate fails the stage rather than being stamped", async () => {
    const { ws, ctx } = fixture();
    const broken = card("leaderboard", ["S1", "S2"], "no source on this line at all");
    fakeClaude(ws, { [watcherRelPath("leaderboard")]: broken });

    const outcome = await watchExecutor(ctx);

    expect(outcome.ok).toBe(false);
    expect(outcome.error ?? "").toContain("does not validate");
    expect(read(ws, watcherRelPath("leaderboard"))).toContain("status: draft");
  });

  test("a card the sub-agent never wrote fails the stage", async () => {
    const { ws, ctx } = fixture();
    fakeClaude(ws, {});

    const outcome = await watchExecutor(ctx);

    expect(outcome.ok).toBe(false);
    expect(outcome.error ?? "").toContain("was never written");
  });
});

describe("no done stories", () => {
  test("the stage completes, spawns nothing, and says what it looked at", async () => {
    const plan = defaultPlan();
    plan["03-plan/stories/S1.md"] = story("S1", "E1", "todo");
    plan["03-plan/stories/S2.md"] = story("S2", "E1", "in_progress");
    const { ws, ctx } = fixture(plan);
    // No fake claude on PATH at all: a spawn here would fail loudly.
    process.env.PATH = "";

    const outcome = await watchExecutor(ctx);

    expect(outcome.ok).toBe(true);
    expect(outcome.tasks).toEqual([]);
    expect(outcome.costUsd).toBe(0);
    expect(existsSync(join(ws.runDir, WATCH_PHASE, "watchers"))).toBe(false);

    const handoff = read(ws, `${WATCH_PHASE}/handoff.md`);
    expect(handoff).toContain("- none [src: absent:03-plan/stories]");
    expect(validateHandoff(handoff, toSrcContext(loadWorkspace(ws.root), ws.runDir)).ok).toBe(true);
  });
});

// --- the spawn ceiling on the log ------------------------------------------

/**
 * gh #190. Every other executor's spawn ceiling is reconcilable off
 * `events.jsonl` — `agent.spawned.max_budget_usd` against the `agent.result` it
 * paired with. Watch computed the same number (`agentShare`), handed it to
 * `spawnAgent`, and never wrote it anywhere, so a watcher feature's measured cost
 * had nothing to be read against.
 */
describe("a watch spawn records its ceiling (gh #190)", () => {
  test("one `agent.spawned` per feature, carrying the ceiling that spawn was given", async () => {
    const plan = defaultPlan();
    plan["03-plan/stories/S3.md"] = story("S3", "E2", "done", "lab");
    const { ws, ctx } = fixture(plan);
    fakeClaude(ws, {
      [watcherRelPath("leaderboard")]: card("leaderboard", ["S1", "S2"], LIVE_SIGNAL),
      [watcherRelPath("other")]: card("other", ["S3"], LIVE_SIGNAL),
    });
    const emitted: { type: string; payload: Record<string, unknown> }[] = [];

    const outcome = await watchExecutor({
      ...ctx,
      emit: (type, payload) => { emitted.push({ type, payload }); },
    });

    expect(outcome.ok).toBe(true);
    const spawns = emitted.filter((e) => e.type === "agent.spawned");
    expect(spawns.map((e) => e.payload.key)).toEqual(["leaderboard", "other"]);
    // The ceiling the executor actually handed `spawnAgent`: the stage's
    // $2.00 shared two ways, which is also what `--prepare` writes as the
    // bundle's `max_budget_usd`.
    expect(spawns.map((e) => e.payload.max_budget_usd)).toEqual([1, 1]);
    expect(spawns.map((e) => e.payload.role)).toEqual(["developer", "developer"]);
    expect(spawns.map((e) => e.payload.phase)).toEqual([WATCH_PHASE, WATCH_PHASE]);
  });

  /**
   * The spawn is on the log BEFORE the turn, not after it: a sub-agent that dies
   * is still a turn the ceiling was committed to, and a ceiling written only on
   * the way out would be missing from exactly the runs that need explaining.
   */
  test("the ceiling is recorded even when the sub-agent fails", async () => {
    const { ws, ctx } = fixture();
    fakeClaude(ws, { [watcherRelPath("leaderboard")]: card("leaderboard", ["S1", "S2"], LIVE_SIGNAL) });
    process.env.FAKE_CLAUDE_IS_ERROR = "1";
    const emitted: { type: string; payload: Record<string, unknown> }[] = [];

    const outcome = await watchExecutor({
      ...ctx,
      emit: (type, payload) => { emitted.push({ type, payload }); },
    });

    expect(outcome.ok).toBe(false);
    expect(emitted.filter((e) => e.type === "agent.spawned")).toHaveLength(1);
    expect(ws.runDir).toBeTruthy();
  });
});

// --- in-session mode -------------------------------------------------------

describe("--prepare / --commit, per feature", () => {
  test("prepare writes one bundle per feature and spawns nothing", async () => {
    const { ws, ctx } = fixture();
    process.env.PATH = "";

    const outcome = await watchExecutor({ ...ctx, mode: "prepare" });

    expect(outcome.ok).toBe(true);
    expect(outcome.awaiting).toBe(true);
    const dir = join(ws.runDir, ".agent", "watch", "leaderboard");
    expect(existsSync(join(dir, "prompt.md"))).toBe(true);
    const pending = JSON.parse(readFileSync(join(dir, "pending.json"), "utf8")) as { outputs: string[] };
    expect(pending.outputs).toEqual([watcherRelPath("leaderboard")]);
    expect(existsSync(join(ws.runDir, WATCH_PHASE, "handoff.md"))).toBe(false);
  });

  test("the prepared prompt inlines the stories and names the one file to write", async () => {
    const { ws, ctx } = fixture();
    process.env.PATH = "";
    await watchExecutor({ ...ctx, mode: "prepare" });

    const prompt = readFileSync(join(ws.runDir, ".agent", "watch", "leaderboard", "prompt.md"), "utf8");
    expect(prompt).toContain("03-plan/stories/S1.md");
    expect(prompt).toContain("03-plan/stories/S2.md");
    expect(prompt).toContain(`Write exactly ONE file: \`${watcherRelPath("leaderboard")}\``);
    // Another feature's evidence is never in this prompt.
    expect(prompt).not.toContain("03-plan/stories/S3.md");
  });

  test("commit reads each feature's result.json and finishes the stage", async () => {
    const { ws, ctx } = fixture();
    process.env.PATH = "";
    await watchExecutor({ ...ctx, mode: "prepare" });

    const path = join(ws.runDir, watcherRelPath("leaderboard"));
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, card("leaderboard", ["S1", "S2"], LIVE_SIGNAL), "utf8");
    writeFileSync(
      join(ws.runDir, ".agent", "watch", "leaderboard", "result.json"),
      JSON.stringify({ outputs: [watcherRelPath("leaderboard")], questions_asked: [], notes: "", cost_usd: 0.07 }),
      "utf8",
    );

    const outcome = await watchExecutor({ ...ctx, mode: "commit" });

    expect(outcome.ok).toBe(true);
    expect(outcome.costUsd).toBeCloseTo(0.07, 5);
    expect(read(ws, watcherRelPath("leaderboard"))).toContain("status: verified");
    expect(existsSync(join(ws.runDir, WATCH_PHASE, "handoff.md"))).toBe(true);
  });

  /**
   * gh #224. A host's in-session sub-agent is billed to the HOST session, so the
   * row must read `cost_usd: null` + `metered: false` — the spelling Build's
   * `commit()` and `commitStage` already use — and never a `$0.00` that reads as
   * a measurement. Measured before the fix: 56 watch rows at `cost_usd: 0.0`
   * with no `metered` key across two live workspaces.
   */
  test("commit with nothing declared records an UNMETERED row, not a measured $0.00", async () => {
    const { ws, ctx } = fixture();
    process.env.PATH = "";
    await watchExecutor({ ...ctx, mode: "prepare" });

    const path = join(ws.runDir, watcherRelPath("leaderboard"));
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, card("leaderboard", ["S1", "S2"], LIVE_SIGNAL), "utf8");
    // No `cost_usd` at all: a host session has no reason to fill one in.
    writeFileSync(
      join(ws.runDir, ".agent", "watch", "leaderboard", "result.json"),
      JSON.stringify({ outputs: [watcherRelPath("leaderboard")], questions_asked: [], notes: "" }),
      "utf8",
    );

    const outcome = await watchExecutor({ ...ctx, mode: "commit", costUsd: null });

    expect(outcome.ok).toBe(true);
    expect(outcome.tasks[0]?.metered).toBe(false);
  });

  /** gh #224: `--cost-usd` is what the host DECLARED, and watch never read it. */
  test("commit reads `--cost-usd` in preference to the envelope's own figure", async () => {
    const { ws, ctx } = fixture();
    process.env.PATH = "";
    await watchExecutor({ ...ctx, mode: "prepare" });

    const path = join(ws.runDir, watcherRelPath("leaderboard"));
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, card("leaderboard", ["S1", "S2"], LIVE_SIGNAL), "utf8");
    writeFileSync(
      join(ws.runDir, ".agent", "watch", "leaderboard", "result.json"),
      JSON.stringify({ outputs: [watcherRelPath("leaderboard")], questions_asked: [], notes: "", cost_usd: 0 }),
      "utf8",
    );

    const outcome = await watchExecutor({ ...ctx, mode: "commit", costUsd: 2.25, tokens: 41000 });

    expect(outcome.tasks[0]?.costUsd).toBeCloseTo(2.25, 5);
    expect(outcome.tasks[0]?.metered).toBeUndefined();
    expect(outcome.tasks[0]?.tokens).toBe(41000);
    expect(outcome.costUsd).toBeCloseTo(2.25, 5);
  });

  test("commit without a result.json says which feature is missing one", async () => {
    const { ws, ctx } = fixture();
    process.env.PATH = "";
    await watchExecutor({ ...ctx, mode: "prepare" });

    const outcome = await watchExecutor({ ...ctx, mode: "commit" });

    expect(outcome.ok).toBe(false);
    expect(outcome.error ?? "").toContain("leaderboard");
    expect(outcome.error ?? "").toContain("result.json");
    expect(ws.runDir).toBeTruthy();
  });
});

// --- the card itself -------------------------------------------------------

describe("the watcher card", () => {
  test("the shipped template validates as a card", () => {
    const text = readFileSync(join(TEMPLATES_DIR, "watcher.md"), "utf8");
    const parsed = parseWatcherCard(text, { root: TEMPLATES_DIR, repos: new Map(), commands: new Set() }, "watcher");

    // A template cites a codebase nobody has, so its `file` sources cannot resolve
    // here. Its SHAPE must be right, and every token must parse.
    expect(parsed.issues.filter((i) => i.kind === "shape" && i.path !== "id")).toEqual([]);
    expect(parsed.issues.filter((i) => i.message.includes("expected"))).toEqual([]);
    expect(parsed.watcher?.status).toBe("draft");
    // The template's own Signal has an `absent:` item, so `draft` is what it earns.
    expect(parsed.decidedStatus).toBe("draft");
    const query = queryBlock(text);
    expect(query?.kind).toBe("query");
    expect(query?.kind === "query" ? query.text : "").toContain("leaderboard.refreshed");
  });

  test("a missing section is named", () => {
    const text = card("x", ["S1"], LIVE_SIGNAL).replace("## Looks broken when", "## Looks broke when");
    const parsed = parseWatcherCard(text, { root: "/nowhere", repos: new Map(), commands: new Set() });
    expect(parsed.issues.some((i) => i.message.includes("`## Looks broken when`"))).toBe(true);
  });

  /**
   * GUARD, and it passed before gh #212 as it passes after. Prose under `## Query`
   * is the failure #212 was filed about and it is STILL refused, in the same words:
   * the escape hatch #212 adds is a form the reader can recognise, not permission
   * to describe a query. The message is asserted verbatim because a card written
   * against the old wording is what a person will be holding when they read it.
   */
  test("`## Query` without a fenced block is refused", () => {
    const text = card("x", ["S1"], LIVE_SIGNAL).replace(QUERY_FENCE, "run the usual query");
    const parsed = parseWatcherCard(text, { root: "/nowhere", repos: new Map(), commands: new Set() });
    expect(parsed.issues.some((i) => i.message
      === "`## Query` holds no fenced block — the query has to be copy-pasteable, not described")).toBe(true);
  });

  /**
   * gh #212, measured on tldrx 0.14.2. A real workspace's Watch stage (haiku,
   * $0.17) wrote a card whose Signal, Where and Looks-broken-when all cited
   * `absent:` correctly — the code under watch emits nothing, and the only signal
   * that exists is a customer reporting a missing code. Then it had to fill
   * `## Query`, wrote the truth in prose, and the stage FAILED on it. `Query` was
   * the one checked section with no absent form; this is that form.
   */
  test("`Query: none — <reason> [src: …]` validates, and the card carries the reason", () => {
    const text = card("x", ["S1"], ABSENT_SIGNAL).replace(QUERY_FENCE, QUERY_NONE);
    const parsed = parseWatcherCard(text, { root: "/nowhere", repos: new Map(), commands: new Set() });

    expect(parsed.issues.filter((i) => i.path === "Query")).toEqual([]);
    expect(parsed.query?.kind).toBe("none");
    expect(parsed.query?.kind === "none" ? parsed.query.reason : "")
      .toBe("nothing in this path emits a log line, a metric or a span");
  });

  /**
   * The reviewer's probe (#212 review). A sourced `none` is not enough: this card's
   * `## Signal` names a real, resolvable emitting line, so SOMETHING is queryable
   * and `none` is a shortcut. Before this the validator only asked that the none
   * line's own token resolve, and the "only when nothing is instrumented" rule
   * lived in the prompt — a rule a sub-agent is free to ignore.
   */
  test("`Query: none` on a card whose Signal is live is refused", () => {
    const text = card("x", ["S1"], LIVE_SIGNAL)
      .replace(QUERY_FENCE, "Query: none — nothing is queryable [src: absent:api/src/Leaderboard.cs]");
    const parsed = parseWatcherCard(text, { root: "/nowhere", repos: new Map(), commands: new Set() });

    expect(parsed.issues.some((i) => i.path === "Query" && i.message
      === "`Query: none` is only for a card whose `## Signal` is itself `absent:` — this one names a real signal"))
      .toBe(true);
  });

  /**
   * The other half, and it is the same rule read from the other side: a `none`
   * whose reason cites a line of REAL code is citing something that exists, which
   * is what `absent:` is for. The template shows only `absent:` here.
   */
  test("`Query: none` sourced to a real line rather than `absent:` is refused", () => {
    const text = card("x", ["S1"], ABSENT_SIGNAL)
      .replace(QUERY_FENCE, "Query: none — nothing is queryable [src: api:src/Leaderboard.cs:3]");
    const parsed = parseWatcherCard(text, { root: "/nowhere", repos: new Map(), commands: new Set() });

    expect(parsed.issues.some((i) => i.path === "Query" && i.message
      === "`Query: none` is only for a card whose `## Signal` is itself `absent:` — this one names a real signal"))
      .toBe(true);
  });

  /**
   * The reason is a claim like every other claim on a card, so it is sourced by the
   * same parser `claim-sources` denies a handoff bullet with — one reader of the
   * `[src: …]` grammar, not two (#80). An unsourced `none` would be the invented
   * absence AGENTS.md §7 exists to refuse.
   */
  test("a `Query: none` line with no `[src: …]` is refused like any unsourced item", () => {
    const text = card("x", ["S1"], ABSENT_SIGNAL)
      .replace(QUERY_FENCE, "Query: none — nothing in this path emits anything");
    const parsed = parseWatcherCard(text, { root: "/nowhere", repos: new Map(), commands: new Set() });

    // The bullets' sentence, verbatim — the rule half; #301 appended the cure to both.
    expect(parsed.issues.some((i) => i.path === "Query"
      && i.message.startsWith("no `[src: …]` token — every item on a card is sourced"))).toBe(true);
  });

  test("setWatcherStatus rewrites one line and keeps the rest byte-identical", () => {
    const before = card("x", ["S1"], LIVE_SIGNAL);
    const after = setWatcherStatus(before, "verified");
    expect(after).toContain("status: verified");
    expect(after.split("\n").length).toBe(before.split("\n").length);
    expect(setWatcherStatus(after, "verified")).toBe(after);
  });
});

// --- list and check --------------------------------------------------------

describe("tldrx watch list / check", () => {
  test("list shows each card's status and its Signal line", async () => {
    const { ws, ctx } = fixture();
    fakeClaude(ws, { [watcherRelPath("leaderboard")]: card("leaderboard", ["S1", "S2"], LIVE_SIGNAL) });
    await watchExecutor(ctx);

    const cards = loadCards(ws.runDir, toSrcContext(loadWorkspace(ws.root), ws.runDir));
    const table = renderWatchList(ctx.runId, cards);

    expect(table).toContain("leaderboard");
    expect(table).toContain("verified");
    expect(table).toContain("leaderboard.refreshed");
    expect(table).toContain("1 card(s): 1 verified, 0 draft");
  });

  test("check catches a citation that no longer resolves", async () => {
    const { ws, ctx } = fixture();
    fakeClaude(ws, { [watcherRelPath("leaderboard")]: card("leaderboard", ["S1", "S2"], LIVE_SIGNAL) });
    await watchExecutor(ctx);

    // Somebody deleted three quarters of the file the card points at.
    writeFileSync(join(ws.root, "api", "src", "Leaderboard.cs"), "// gone\n", "utf8");
    clearSrcCaches();

    const cards = loadCards(ws.runDir, toSrcContext(loadWorkspace(ws.root), ws.runDir));
    const report = checkCard(cards[0] as NonNullable<(typeof cards)[number]>);

    expect(report.ok).toBe(false);
    expect(report.lines.join("\n")).toContain("Leaderboard.cs");
    expect(report.lines.join("\n")).toContain("cited line 3");
  });

  test("check catches a card hand-edited to `verified`", async () => {
    const { ws, ctx } = fixture();
    fakeClaude(ws, { [watcherRelPath("leaderboard")]: card("leaderboard", ["S1", "S2"], ABSENT_SIGNAL) });
    await watchExecutor(ctx);

    const path = join(ws.runDir, watcherRelPath("leaderboard"));
    writeFileSync(path, setWatcherStatus(readFileSync(path, "utf8"), "verified"), "utf8");

    const cards = loadCards(ws.runDir, toSrcContext(loadWorkspace(ws.root), ws.runDir));
    const report = checkCard(cards[0] as NonNullable<(typeof cards)[number]>);

    expect(report.ok).toBe(false);
    expect(report.lines.join("\n")).toContain("earn `draft`");
  });

  test("a run with no cards says so instead of printing an empty table", () => {
    expect(renderWatchList("260830-demo", [])).toContain("is empty or absent");
  });
});

// --- the registry ----------------------------------------------------------

describe("the executor registry", () => {
  test("`05-watch` resolves to the watch executor and nothing else does", () => {
    expect(executorFor(WATCH_PHASE)).toBe(watchExecutor);
    expect(executorFor("01-what")).toBeNull();
    expect(EXECUTORS.has(WATCH_PHASE)).toBe(true);
  });
});

/**
 * The Watch stage inlines `{{facts}}` as a declared input, so the same rule holds
 * here as in every other prompt: a superseded fact is what the workspace used to
 * believe, and a watcher told where a signal "is read" by a reversed decision
 * will cite a query nobody runs any more.
 */
describe("renderWatchFacts skips superseded facts", () => {
  function deployFact(id: string, text: string, supersededBy: string | null): Fact {
    return {
      id, fact: text, area: "deploy", repos: ["api"], kind: "answer", confidence: "stated",
      source: { who: "alan", when: "2026-08-31T09:00:00Z", run: "260831-x", q: "Q1" },
      supersedes: null, superseded_by: supersededBy, retired: null,
    };
  }

  test("the superseding fact is rendered and the one it replaced is not", () => {
    const rendered = renderWatchFacts([
      deployFact("F001", "Deploys are manual via workflow_dispatch.", "F002"),
      deployFact("F002", "Deploys run automatically on merge.", null),
    ], ["api"]);
    expect(rendered).toContain("[F002] Deploys run automatically on merge.");
    expect(rendered).not.toContain("F001");
  });

  test("when every matching fact is superseded, the section says there is none", () => {
    const rendered = renderWatchFacts([deployFact("F001", "Deploys are manual.", "F002")], ["api"]);
    expect(rendered).toContain("No live fact is tagged");
  });
});

// --- gh #301: a refused card comes back to its writer, marked ---------------
//
// Measured on two field runs (2026-09-13/14): a `## Where` item naming a TABLE
// carried no `[src: …]`, the stage failed on it, and the retry — a fresh prompt
// with no memory of the card — moved the refusal to a different line instead of
// curing it. Twice per run, on both workspaces; a person hand-recorded the stage.

describe("a retry after a refused card repairs it rather than restarting (#301)", () => {
  const SOURCED_WHERE = "- Application Insights `traces` [src: api:src/Leaderboard.cs:3]";
  /** What both field runs wrote: a place that is not a file, and no citation at all. */
  const UNSOURCED_WHERE = "- PostgreSQL `leaderboard_refreshes` table, read over a database connection";
  const REL = watcherRelPath("leaderboard");

  function unsourcedWhereCard(): string {
    const text = card("leaderboard", ["S1", "S2"], LIVE_SIGNAL);
    expect(text).toContain(SOURCED_WHERE);
    return text.replace(SOURCED_WHERE, UNSOURCED_WHERE);
  }

  test("the refusal names the line, the rule, and the cure for a location that is not a file", async () => {
    const { ws, ctx } = fixture();
    fakeClaude(ws, { [REL]: unsourcedWhereCard() });

    const outcome = await watchExecutor(ctx);

    expect(outcome.ok).toBe(false);
    // Guard (passed before #301): the line and the rule.
    expect(outcome.error ?? "").toContain("L17 Where: no `[src: …]` token");
    // #301: the cure — WHAT to cite when the place named is a table, queue or dashboard.
    expect(outcome.error ?? "").toContain("cite the file that defines it");
  });

  test("the headless retry is handed the refused card, its refused line marked with the refusal", async () => {
    const { ws, ctx } = fixture();
    fakeClaude(ws, { [REL]: unsourcedWhereCard() });
    const first = await watchExecutor(ctx);
    expect(first.ok).toBe(false);

    // Attempt 2, headless — the same call `run auto --retry-failed` and a second
    // `tldrx next` make. The fake records the prompt it was handed.
    const promptOut = join(ws.root, "attempt-2-prompt.md");
    process.env.FAKE_CLAUDE_PROMPT_OUT = promptOut;
    await watchExecutor(ctx);
    const prompt = readFileSync(promptOut, "utf8");

    expect(prompt).toContain(`## ${PREVIOUS_ATTEMPT_HEADING}`);
    expect(prompt).toContain(`#### \`${REL}\``);
    // The refused line, verbatim, marked with its line number and the validator's own sentence.
    expect(prompt).toContain(`L17 Where: ${NO_SRC_TOKEN_ISSUE}`);
    expect(prompt).toContain(`> ${UNSOURCED_WHERE}`);
    // The rest of the card is there to be KEPT, not rewritten.
    expect(prompt).toContain(LIVE_SIGNAL);
  });

  test("the prepared bundle for the retry carries the same section", async () => {
    const { ws, ctx } = fixture();
    fakeClaude(ws, { [REL]: unsourcedWhereCard() });
    expect((await watchExecutor(ctx)).ok).toBe(false);

    process.env.PATH = "";
    await watchExecutor({ ...ctx, mode: "prepare" });
    const prompt = readFileSync(join(ws.runDir, ".agent", "watch", "leaderboard", "prompt.md"), "utf8");

    expect(prompt).toContain(`## ${PREVIOUS_ATTEMPT_HEADING}`);
    expect(prompt).toContain(UNSOURCED_WHERE);
    expect(prompt).toContain(`L17 Where: ${NO_SRC_TOKEN_ISSUE}`);
  });

  test("a first attempt carries no previous-attempt section at all", async () => {
    const { ws, ctx } = fixture();
    fakeClaude(ws, { [REL]: card("leaderboard", ["S1", "S2"], LIVE_SIGNAL) });
    const promptOut = join(ws.root, "attempt-1-prompt.md");
    process.env.FAKE_CLAUDE_PROMPT_OUT = promptOut;

    expect((await watchExecutor(ctx)).ok).toBe(true);

    expect(readFileSync(promptOut, "utf8")).not.toContain(`## ${PREVIOUS_ATTEMPT_HEADING}`);
  });

  test("the writer's brief shows ONE non-file Where example whose citation parses, in the refusal's words", () => {
    const { ws } = fixture();
    const feature = collectFeatures(ws.runDir)[0];
    expect(feature).toBeDefined();
    if (feature === undefined) return;

    const brief = featureBrief(feature);

    // The same sentence the validator's refusal carries — one derivation (§7).
    expect(brief).toContain("cite the file that defines it");
    expect(NO_SRC_TOKEN_ISSUE).toContain("cite the file that defines it");
    // Exactly one example item names a table/queue/dashboard, and its token is a `file` source.
    const examples = brief.split("\n").filter((line) => /^\s+- .*\b(table|queue|dashboard)\b.*\[src: /.test(line));
    expect(examples).toHaveLength(1);
    const token = parseSrcToken(examples[0] ?? "");
    expect(token?.errors ?? ["no token"]).toEqual([]);
    expect(token?.refs.map((ref) => ref.kind)).toEqual(["file"]);
  });
});

/**
 * #306. The stage fails on the FIRST card that does not validate, and `tldrx next`
 * / `run auto --retry-failed` re-enters the executor from the top — so every
 * feature's writer was spawned again, including the ones whose card had already
 * validated and been stamped. Each of those re-spawns pays at least `MIN_AGENT_USD`
 * for a card nothing refused.
 */
describe("a retry keeps a card that already validated instead of paying for it again (#306)", () => {
  const SOURCED_WHERE = "- Application Insights `traces` [src: api:src/Leaderboard.cs:3]";
  const UNSOURCED_WHERE = "- PostgreSQL `leaderboard_refreshes` table, read over a database connection";

  /** Two features: `leaderboard` (E1, 2 done stories) and `other` (E2, 1 done story). */
  function twoFeaturePlan(): Record<string, string> {
    const plan = defaultPlan();
    plan["03-plan/stories/S3.md"] = story("S3", "E2", "done", "lab");
    return plan;
  }

  function refusedCard(id: string, stories: readonly string[]): string {
    const text = card(id, stories, LIVE_SIGNAL);
    expect(text).toContain(SOURCED_WHERE);
    return text.replace(SOURCED_WHERE, UNSOURCED_WHERE);
  }

  test("attempt 2 spawns only for the refused feature, and the kept card is a $0.00 row", async () => {
    const { ws, ctx } = fixture(twoFeaturePlan());
    // Attempt 1: `leaderboard` validates and is stamped; `other` is refused, so
    // the stage fails with both cards on disk.
    fakeClaude(ws, {
      [watcherRelPath("leaderboard")]: card("leaderboard", ["S1", "S2"], LIVE_SIGNAL),
      [watcherRelPath("other")]: refusedCard("other", ["S3"]),
    });
    const first = await watchExecutor(ctx);
    expect(first.ok).toBe(false);
    const kept = read(ws, watcherRelPath("leaderboard"));
    expect(kept).toContain("status: verified");

    // Attempt 2, headless — the same call `run auto --retry-failed` makes. The
    // fake writes ONLY the refused feature's card now, so a spawn for
    // `leaderboard` would be visible as a rewrite that never happened.
    const spawned: string[] = [];
    fakeClaude(ws, { [watcherRelPath("other")]: card("other", ["S3"], LIVE_SIGNAL) });
    const outcome = await watchExecutor({
      ...ctx,
      emit: (type, payload) => {
        if (type === "agent.spawned") spawned.push(String((payload as { key?: unknown }).key ?? ""));
      },
    });

    expect(outcome.ok).toBe(true);
    // The whole feature: one spawn, not two.
    expect(spawned).toEqual(["other"]);
    // The kept card is still a row — the run records what happened to every
    // feature — and it says no turn was bought for it.
    const leaderboardRow = outcome.tasks.find((task) => task.key === "leaderboard");
    expect(leaderboardRow).toBeDefined();
    expect(leaderboardRow?.costUsd).toBe(0);
    expect(leaderboardRow?.sessionId).toBeNull();
    expect(leaderboardRow?.model).toBeNull();
    expect(outcome.costUsd).toBeCloseTo(0.11, 5);
    // Byte-identical: nothing rewrote it.
    expect(read(ws, watcherRelPath("leaderboard"))).toBe(kept);
    // And the stage SAYS so, rather than leaving a $0.00 row to be read as a bug.
    expect(outcome.lines.join("\n")).toContain("already validated");
  });

  test("a first attempt with no cards on disk still spawns for every feature", async () => {
    const { ws, ctx } = fixture(twoFeaturePlan());
    const spawned: string[] = [];
    fakeClaude(ws, {
      [watcherRelPath("leaderboard")]: card("leaderboard", ["S1", "S2"], LIVE_SIGNAL),
      [watcherRelPath("other")]: card("other", ["S3"], LIVE_SIGNAL),
    });

    const outcome = await watchExecutor({
      ...ctx,
      emit: (type, payload) => {
        if (type === "agent.spawned") spawned.push(String((payload as { key?: unknown }).key ?? ""));
      },
    });

    expect(outcome.ok).toBe(true);
    expect(spawned).toEqual(["leaderboard", "other"]);
    expect(outcome.costUsd).toBeCloseTo(0.22, 5);
    expect(outcome.lines.join("\n")).not.toContain("already validated");
  });
});
