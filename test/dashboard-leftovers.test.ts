/**
 * The five dashboard questions #85 left as design decisions (gh #93).
 *
 * #85's owner decision (2026-09-02) let the model read `budget.yml` and
 * `events.jsonl`, and that wave shipped. Five things it did not answer were
 * filed separately, because each needed a call rather than a patch: the Watchers
 * tab was a stub, a preflight refusal left nothing on the page, `keep_worktrees`
 * and a cancellation's reason were carried and undrawn, and an annotated run got
 * no marker in the runs list.
 *
 * The maintainer's call, recorded on #93 and subject to owner review, is the
 * CONSERVATIVE one every time: **render what the files already say**, invent no
 * interaction that is not already on the page, and let nothing on this page run
 * a command or re-check the code. In particular:
 *
 *  - A watcher card is read the way its FILE reads: the seven front-matter
 *    fields, plus the `absent:` citations under `## Signal` that are the reason a
 *    card is `draft`. Not the `CardChecklist` `tldrx watch check` computes — that
 *    re-resolves every source against today's code, and a read-only page must not
 *    be the only thing on the screen that runs anything.
 *  - A `draft` card raises NO attention card. The page's stated rule is that an
 *    alert means a run is waiting on a person RIGHT NOW, and an uninstrumented
 *    signal is a fact about coverage, not a queue.
 *  - `04-build/preflight.yml` is read the same way `budget.yml` is: read-only,
 *    additive, tolerant. A red base row is drawn as a row, not as an alert — same
 *    reason `budget.blocked` is drawn as history.
 *
 * Written the way `dashboard-vocabulary.test.ts` and `dashboard-sources.test.ts`
 * are: build a workspace that carries the thing, render it, and demand the page
 * say it. The last block is the other half of the promise — a workspace carrying
 * NONE of it renders exactly as it did before, because that is most workspaces.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildModel, DASHBOARD_MODEL_VERSION } from "../src/core/dashboard/model.ts";
import type { DashboardModel, RunModel } from "../src/core/dashboard/model.ts";
import {
  dashAttention, dashPending, dashPreflightSection, dashRunRow, dashRunView, dashWatchersView,
} from "../src/core/dashboard/render.ts";
import { PREFLIGHT_REL } from "../src/core/build/preflight.ts";
import { WATCHERS_DIR, WATCH_PHASE } from "../src/core/watch/Watcher.ts";

const READ_AT = "2026-09-03T08:00:00Z";
const NOW_MS = Date.parse("2026-09-03T09:00:00Z");
const RUN_ID = "260903-leftovers";

/** Tags stripped: these tests are about the WORDS, not the markup around them. */
function text(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

/**
 * A run parked at a gate in `04-build`, with a Watch phase after it.
 *
 * `extra` is spliced in above `phases:` so a test can add a run-level key —
 * `keep_worktrees:`, `cancelled:` — without a second copy of the whole file.
 */
function runYaml(extra = ""): string {
  return `version: 1
run: ${RUN_ID}
title: "The five #85 left open"
scope: feature
workflow: feature
repos: [api]
created_at: 2026-09-03T09:00:00Z
updated_at: 2026-09-03T14:20:00Z
status: running
cursor: {phase: 04-build, stage: build, task: null}
budget: {ceiling_usd: 25.0, spent_usd: 2.5, per_agent_max_usd: 3.0}
${extra}phases:
  - id: 04-build
    status: running
    stages:
      - {id: build, status: awaiting_gate, expert: developer, model: sonnet, budget_usd: 12.0,
         cost_usd: 2.5, started_at: null, ended_at: null, inputs: [], outputs: [],
         gate: {type: approve, status: pending, by: null, at: null, note: ""}, tasks: []}
  - id: 05-watch
    status: ready
    stages:
      - {id: watch, status: ready, expert: architect, model: sonnet, budget_usd: 2.0,
         cost_usd: 0.0, started_at: null, ended_at: null, inputs: [], outputs: [],
         gate: null, tasks: []}
`;
}

interface Fixture {
  readonly runYamlExtra?: string;
  /** `<name>.md` -> card text, written under `05-watch/watchers/`. */
  readonly watchers?: Readonly<Record<string, string>>;
  /** Raw `04-build/preflight.yml`. */
  readonly preflight?: string;
  /** Raw `events.jsonl` lines. */
  readonly events?: string;
}

function modelOf(fixture: Fixture = {}): { model: DashboardModel; run: RunModel } {
  const root = mkdtempSync(join(tmpdir(), "tldrx-93-"));
  mkdirSync(join(root, ".tldrx"), { recursive: true });
  const dir = join(root, "tldrx-work", RUN_ID);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "run.yml"), runYaml(fixture.runYamlExtra ?? ""));

  if (fixture.watchers !== undefined) {
    const cards = join(dir, WATCH_PHASE, WATCHERS_DIR);
    mkdirSync(cards, { recursive: true });
    for (const [name, body] of Object.entries(fixture.watchers)) writeFileSync(join(cards, name), body);
  }
  if (fixture.preflight !== undefined) {
    mkdirSync(join(dir, "04-build"), { recursive: true });
    writeFileSync(join(dir, PREFLIGHT_REL), fixture.preflight);
  }
  if (fixture.events !== undefined) writeFileSync(join(dir, "events.jsonl"), fixture.events);

  const model = buildModel(root, READ_AT);
  const run = model.runs[0];
  if (run === undefined) throw new Error("fixture produced no run");
  return { model, run };
}

// ---------------------------------------------------------------------------
// 1. Watcher cards — the real seven fields, and why a card is a draft
// ---------------------------------------------------------------------------

/** Every section §2.16 requires, with `absent:` under Signal — so it stays `draft`. */
const DRAFT_CARD = `---
version: 1
id: leaderboard
epic: E1
title: Season leaderboard
stories: [S1, S2]
repos: [api]
status: draft
owner: alan
---

## Signal

- nothing emits a rank recompute yet [src: absent:src/core/scoring/rank.ts]

## Where

- the scoring service [src: api:src/core/scoring/rank.ts:1]

## Healthy baseline

- a recompute every hour [src: api:src/core/scoring/rank.ts:1]

## Looks broken when

- the board stops moving [src: api:src/core/scoring/rank.ts:1]

## Query

\`\`\`
rank_recompute | count
\`\`\`

## Sources

Written from the Build handoff.
`;

/** The same card with a real Signal source: nothing absent, so `verified`. */
const VERIFIED_CARD = DRAFT_CARD
  .replace("id: leaderboard", "id: standings")
  .replace("status: draft", "status: verified")
  .replace("- nothing emits a rank recompute yet [src: absent:src/core/scoring/rank.ts]",
    "- `rank.recomputed` on every pass [src: api:src/core/scoring/rank.ts:1]");

describe("1. the Watchers tab reads the cards that are on disk", () => {
  test("the model carries a card's seven fields, its path, and nothing invented", () => {
    const { run } = modelOf({ watchers: { "leaderboard.md": DRAFT_CARD } });
    expect(run.watch).not.toBeNull();
    expect(run.watch?.phase).toBe(WATCH_PHASE);
    const card = run.watch?.watchers[0];
    expect(card?.id).toBe("leaderboard");
    expect(card?.epic).toBe("E1");
    expect(card?.title).toBe("Season leaderboard");
    expect(card?.stories).toEqual(["S1", "S2"]);
    expect(card?.repos).toEqual(["api"]);
    expect(card?.status).toBe("draft");
    expect(card?.owner).toBe("alan");
    expect(card?.path).toBe(`${WATCH_PHASE}/${WATCHERS_DIR}/leaderboard.md`);
  });

  test("a draft card carries WHY — the `absent:` citations under Signal, verbatim", () => {
    const { run } = modelOf({ watchers: { "leaderboard.md": DRAFT_CARD } });
    expect(run.watch?.watchers[0]?.absent).toEqual(["src/core/scoring/rank.ts"]);
  });

  test("a verified card cites nothing absent", () => {
    const { run } = modelOf({ watchers: { "standings.md": VERIFIED_CARD } });
    expect(run.watch?.watchers[0]?.status).toBe("verified");
    expect(run.watch?.watchers[0]?.absent).toEqual([]);
  });

  test("the tab draws the card instead of printing the shape it wishes it had", () => {
    const { model } = modelOf({ watchers: { "leaderboard.md": DRAFT_CARD, "standings.md": VERIFIED_CARD } });
    const view = text(dashWatchersView(model));
    expect(view).not.toContain("No watchers in this model");
    expect(view).toContain("Season leaderboard");
    expect(view).toContain("leaderboard");
    expect(view).toContain("standings");
    expect(view).toContain("alan");
    expect(view).toContain("E1");
    // The reason it is a draft, in the card's own words.
    expect(view).toContain("src/core/scoring/rank.ts");
  });

  test("a card that does not parse is NAMED, never dropped", () => {
    const { model, run } = modelOf({ watchers: { "broken.md": "no front matter here\n" } });
    expect(run.watch?.unreadable).toEqual([`${WATCHERS_DIR}/broken.md`]);
    expect(text(dashWatchersView(model))).toContain("broken.md");
  });

  test("a draft card raises NO attention card — an alert means a person is waited on", () => {
    const { model, run } = modelOf({ watchers: { "leaderboard.md": DRAFT_CARD } });
    // The run is at a gate, so that — and only that — is what it is waiting on.
    expect(dashPending(run)?.kind).toBe("gate");
    const attention = text(dashAttention(model));
    expect(attention).not.toContain("draft");
    expect(attention).not.toContain("watcher");
  });

  test("reading a card re-checks nothing: the model never resolves a source", async () => {
    const source = await Bun.file(new URL("../src/core/dashboard/model.ts", import.meta.url)).text();
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    // `resolveSrc` hits the filesystem to prove a citation still points at real
    // code, and `parseWatcherCard` calls it for every bullet on the card. Either
    // one would make the dashboard the only screen that re-runs the check.
    expect(code).not.toContain("resolveSrc");
    expect(code).not.toContain("parseWatcherCard");
    expect(code).not.toContain("CardChecklist");
  });
});

// ---------------------------------------------------------------------------
// 2. Preflight refusals — the base gate rows
// ---------------------------------------------------------------------------

const PREFLIGHT_YML = `version: 1
checked_at: 2026-09-03T10:00:00Z
results:
  - repo: api
    command: dotnet test
    base_ref: main
    base_sha: abc1234
    exit_code: 1
    timed_out: false
    status: failed
    tail: "2 failed, 118 passed"
  - repo: api
    command: dotnet build
    base_ref: main
    base_sha: abc1234
    exit_code: 0
    timed_out: false
    status: ok
    tail: "Build succeeded"
`;

describe("2. a preflight refusal leaves the base gate rows on the page", () => {
  test("the model reads 04-build/preflight.yml", () => {
    const { run } = modelOf({ preflight: PREFLIGHT_YML });
    expect(run.preflight).not.toBeNull();
    expect(run.preflight?.checkedAt).toBe("2026-09-03T10:00:00Z");
    expect(run.preflight?.rows.map((row) => row.command)).toEqual(["dotnet test", "dotnet build"]);
    const red = run.preflight?.rows[0];
    expect(red?.status).toBe("failed");
    expect(red?.exitCode).toBe(1);
    expect(red?.repo).toBe("api");
    expect(red?.baseRef).toBe("main");
    expect(red?.baseSha).toBe("abc1234");
    expect(red?.timedOut).toBe(false);
    expect(red?.tail).toBe("2 failed, 118 passed");
  });

  test("the run detail names the command, its exit code and the repo it was red in", () => {
    const { model, run } = modelOf({ preflight: PREFLIGHT_YML });
    const section = text(dashPreflightSection(run));
    expect(section).toContain("dotnet test");
    expect(section).toContain("1");
    expect(section).toContain("failed");
    expect(section).toContain("api");
    expect(text(dashRunView(model, RUN_ID, NOW_MS))).toContain("dotnet test");
  });

  test("a red base row raises no alert either — it is a row, like a budget refusal", () => {
    const { model, run } = modelOf({ preflight: PREFLIGHT_YML });
    expect(dashPending(run)?.kind).toBe("gate");
    expect(text(dashAttention(model))).not.toContain("preflight");
  });

  test("a preflight.yml that does not parse is a null, never a throw", () => {
    const { model, run } = modelOf({ preflight: "results: not-a-list\n" });
    expect(run.preflight).toBeNull();
    expect(dashPreflightSection(run)).toBe("");
    expect(() => dashRunView(model, RUN_ID, NOW_MS)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 3. keep_worktrees
// ---------------------------------------------------------------------------

describe("3. keep_worktrees is one line on the run detail", () => {
  test("set, it is carried and drawn", () => {
    const { model, run } = modelOf({ runYamlExtra: "keep_worktrees: true\n" });
    expect(run.keepWorktrees).toBe(true);
    const detail = text(dashRunView(model, RUN_ID, NOW_MS));
    expect(detail).toContain("worktrees");
    expect(detail).toContain("kept");
  });

  test("absent, it is false and the card gains nothing", () => {
    const { model, run } = modelOf();
    expect(run.keepWorktrees).toBe(false);
    expect(text(dashRunView(model, RUN_ID, NOW_MS))).not.toContain("worktrees");
  });
});

// ---------------------------------------------------------------------------
// 4. A cancelled run says who closed it, when, and why
// ---------------------------------------------------------------------------

describe("4. the reason a run was cancelled reaches the run detail", () => {
  const CANCELLED = "cancelled: {by: alan, at: 2026-09-03T15:00:00Z, note: the scope moved to 260904-x}\n";

  test("the waiting record carries it, and the detail prints all three facts", () => {
    const { model, run } = modelOf({ runYamlExtra: CANCELLED });
    expect(run.waiting.kind).toBe("cancelled");
    const detail = text(dashRunView(model, RUN_ID, NOW_MS));
    expect(detail).toContain("alan");
    expect(detail).toContain("2026-09-03T15:00:00Z");
    expect(detail).toContain("the scope moved to 260904-x");
  });

  test("it still raises no alert — a closed run is not waiting on anybody", () => {
    const { run } = modelOf({ runYamlExtra: CANCELLED });
    expect(dashPending(run)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. The runs-list marker for an annotated run — the smallest one that works
// ---------------------------------------------------------------------------

const NOTE = JSON.stringify({
  ts: "2026-09-03T12:00:00Z", run: RUN_ID, seq: 1, stage: "build", actor: "alan",
  type: "operator_note", cost_usd: 0, payload: { note: "rebased the epic branch by hand" },
});

describe("5. an annotated run is marked in the runs list", () => {
  test("one glyph, with the count in its title — nothing else changes", () => {
    const { run } = modelOf({ events: `${NOTE}\n` });
    expect(run.notes).toHaveLength(1);
    const row = dashRunRow(run, NOW_MS, false);
    expect(row).toContain("title=\"1 operator note");
    // The detail stays where the notes are; the marker is a pointer, not a panel.
    expect(text(row)).not.toContain("rebased the epic branch by hand");
  });

  test("a run nobody annotated gets no marker", () => {
    const { run } = modelOf();
    expect(run.notes).toHaveLength(0);
    expect(dashRunRow(run, NOW_MS, false)).not.toContain("operator note");
  });
});

// ---------------------------------------------------------------------------
// The other half of the promise
// ---------------------------------------------------------------------------

describe("a workspace carrying none of it renders exactly as it did before", () => {
  test("every new field is present and empty, never missing", () => {
    const { run } = modelOf();
    expect(run.watch).toBeNull();
    expect(run.preflight).toBeNull();
    expect(run.keepWorktrees).toBe(false);
  });

  test("no new section appears on a run that has none of it", () => {
    const { model } = modelOf();
    const detail = text(dashRunView(model, RUN_ID, NOW_MS));
    expect(detail).not.toContain("Base gates");
    expect(detail).not.toContain("worktrees");
  });

  test("the Watchers tab still says so, honestly, when there are no cards", () => {
    const { model } = modelOf();
    expect(text(dashWatchersView(model))).toContain("No watchers");
  });

  test("the model version does not move: every change here is an ADDITION", () => {
    // model.ts's own rule — bumped when a field is removed or changes meaning,
    // never for an addition. `watch`, `preflight` and `keepWorktrees` are new
    // fields; nothing that existed reads differently than it did at v3.
    expect(DASHBOARD_MODEL_VERSION).toBe(3);
  });

  test("it is still one plain JSON document", () => {
    const { model } = modelOf({
      watchers: { "leaderboard.md": DRAFT_CARD },
      preflight: PREFLIGHT_YML,
      runYamlExtra: "keep_worktrees: true\n",
      events: `${NOTE}\n`,
    });
    expect(JSON.parse(JSON.stringify(model))).toEqual(model);
  });
});
