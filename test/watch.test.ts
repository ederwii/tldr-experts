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
import { loadStageSpec } from "../src/core/facilitator/stageSpec.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { validateHandoff } from "../src/core/text/handoff.ts";
import { clearSrcCaches } from "../src/core/text/srcToken.ts";
import { loadWorkspace, toSrcContext } from "../src/hooks/lib/workspace.ts";
import {
  checkCard, collectFeatures, loadCards, parseWatcherCard, queryBlock, renderWatchList,
  setWatcherStatus, watcherRelPath, WATCH_PHASE,
} from "../src/core/watch/index.ts";
import { makeFacilitatorWorkspace, type FacilitatorWorkspace } from "./fixtures/facilitator/workspace.ts";

const ORIGINAL_PATH = process.env.PATH ?? "";
const FAKE_KEYS = ["FAKE_CLAUDE_RUNDIR", "FAKE_CLAUDE_OUTPUTS", "FAKE_CLAUDE_COST", "FAKE_CLAUDE_IS_ERROR"] as const;

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
    "```kql",
    'traces | where message startswith "leaderboard.refreshed"',
    "```",
    "",
    "## Sources",
    "",
    "`Leaderboard.cs:3` is the only place the event is emitted.",
    "",
  ].join("\n");
}

const LIVE_SIGNAL = "`leaderboard.refreshed` is emitted on every refresh [src: api:src/Leaderboard.cs:3]";
const ABSENT_SIGNAL = "Nothing is emitted on refresh — add a counter [src: absent:api/src/Leaderboard.cs]";

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
      effort: null,
      budgetUsd: 2,
      maxBudgetUsd: 2,
      yolo: false,
      at: "2026-08-30T10:00:00Z",
      // wave5 added these three to ExecutorContext; `runNext` supplies them for
      // real. Here they are the identity: no worktrees, no split, no ledger.
      keepWorktrees: false,
    parallel: 1,
    reuseEpic: false,
      agentCap: (share = 1) => Math.round(2 * share * 100) / 100,
      emit: () => undefined,
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
    expect(queryBlock(text) ?? "").toContain("leaderboard.refreshed");
  });

  test("a missing section is named", () => {
    const text = card("x", ["S1"], LIVE_SIGNAL).replace("## Looks broken when", "## Looks broke when");
    const parsed = parseWatcherCard(text, { root: "/nowhere", repos: new Map(), commands: new Set() });
    expect(parsed.issues.some((i) => i.message.includes("`## Looks broken when`"))).toBe(true);
  });

  test("`## Query` without a fenced block is refused", () => {
    const text = card("x", ["S1"], LIVE_SIGNAL)
      .replace("```kql\ntraces | where message startswith \"leaderboard.refreshed\"\n```", "run the usual query");
    const parsed = parseWatcherCard(text, { root: "/nowhere", repos: new Map(), commands: new Set() });
    expect(parsed.issues.some((i) => i.message.includes("copy-pasteable"))).toBe(true);
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
