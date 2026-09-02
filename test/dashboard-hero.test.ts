/**
 * The "Now" strip, the drill-in it opens onto, and the waves view (#107).
 *
 * The model layer landed first (#103) and is not re-derived here: `spend`,
 * `nextAction`, `lastEventAt` / `lastEventFrom` / `ageSeconds` are read as given.
 * What is under test is the RENDER — the half of the redesign that decides what a
 * reader sees in the five seconds they give the page, and every one of these
 * assertions is written against a decision that could have gone the other way:
 *
 *  - **A lower bound never gets a bar.** `spend.basis` is `absent` on the audited
 *    host-attended run, and a progress bar over a number that is admittedly not
 *    the total is the same confident-wrong figure #103 was filed about — drawn in
 *    a shape that cannot be argued with. So the bar is reserved for `measured`,
 *    and every other basis gets the figure with an explicit marker instead.
 *  - **The staleness threshold is the RENDER's, and it is said out loud.** The
 *    model bakes none in on purpose. The page picks 30 minutes, and it picks it
 *    here rather than in `model.ts` so a second consumer is free to disagree.
 *  - **Nothing is invented to fill a shape.** The dots are the phases the run's
 *    own `run.yml` declares, not five because a feature workflow has five; a
 *    stage's DURATION and a gate's free-text NOTE are not on the model, so the
 *    timeline says so rather than leaving a reader to assume they were nil.
 *
 * The negatives are the half that catches a regression: a finished run is not on
 * the strip, a run with no plan draws no grid, a run nobody has annotated draws
 * no stream, and a measured run gets no lower-bound marker.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildModel } from "../src/core/dashboard/model.ts";
import {
  clientRenderer, dashEventStream, dashHeroAge, dashHeroSpend, dashKeyHelp, dashMain,
  dashNowStrip, dashPhaseDots, dashPhaseTimeline, dashStoryGrid, dashWavesView,
} from "../src/core/dashboard/render.ts";
import { DASHBOARD_CSS } from "../src/core/dashboard/styles.ts";
import { DASHBOARD_JS } from "../src/core/dashboard/script.ts";
import type { DashboardModel, RunModel } from "../src/core/dashboard/model.ts";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";

const READ_AT = "2026-09-03T12:00:00Z";
const NOW = new Date(READ_AT);
const NOW_MS = NOW.getTime();
const UI = { status: "all", sort: "order" };

/** Tags stripped: most of these tests are about the WORDS, not the markup. */
function text(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

/** One workspace, written as files — the model reads files, so the fixture is files. */
function workspaceWith(id: string, runYaml: string): { root: string; runDir: string } {
  const root = mkdtempSync(join(tmpdir(), "tldrx-hero-"));
  mkdirSync(join(root, ".tldrx"), { recursive: true });
  const runDir = join(root, "tldrx-work", id);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "run.yml"), runYaml, "utf8");
  return { root, runDir };
}

function modelOf(root: string): DashboardModel {
  return buildModel(root, READ_AT, { now: NOW });
}

function onlyRun(root: string): RunModel {
  const run = modelOf(root).runs[0];
  if (run === undefined) throw new Error("fixture produced no run");
  return run;
}

/** The five phases a `feature` workflow declares, written the way `run new` writes them. */
function fiveP(status: readonly string[]): string {
  const ids = ["01-what", "02-how", "03-plan", "04-build", "05-watch"];
  const stages = ["what", "how", "plan", "build", "watch"];
  return ids.map((id, at) => `  - id: ${id}
    status: ${status[at] ?? "pending"}
    stages:
      - {id: ${stages[at] ?? "x"}, status: ${status[at] ?? "pending"}, expert: architect, model: sonnet,
         budget_usd: 3.0, cost_usd: ${status[at] === "done" ? "1.25" : "0.0"},
         started_at: null, ended_at: null, inputs: [], outputs: [],
         gate: {type: approve, status: ${status[at] === "done" ? "approved" : "pending"},
                by: ${status[at] === "done" ? "alan" : "null"}, at: null, note: ""},
         tasks: []}`).join("\n");
}

function runYaml(id: string, head: string, phases: string): string {
  return `version: 1
run: ${id}
title: "A run with somewhere to be"
scope: feature
workflow: feature
repos: [api]
created_at: 2026-09-03T09:00:00Z
updated_at: 2026-09-03T11:00:00Z
${head}
budget: {ceiling_usd: 25.0, spent_usd: 5.0, per_agent_max_usd: 3.0}
phases:
${phases}
`;
}

const AT_A_GATE = runYaml(
  "260903-hero",
  `status: awaiting_gate
cursor: {phase: 03-plan, stage: plan, task: null}`,
  fiveP(["done", "done", "awaiting_gate"]),
);

// ---------------------------------------------------------------------------
// 1. The Now strip
// ---------------------------------------------------------------------------

describe("1. the Now strip: one card per LIVE run", () => {
  test("it draws the runs still in play, names who is waited on, and leaves the finished ones off", () => {
    const chain = buildModel(
      join(FRAMEWORK_ROOT, "test", "fixtures", "chain", "workspace"), READ_AT, { now: NOW },
    );
    const strip = dashNowStrip(chain, NOW_MS);

    // charlie is at a gate it has reached, delta holds a question, echo failed —
    // three runs waiting on a person, and the card says so in the page's own words.
    expect(strip).toContain("260903-charlie");
    expect(strip).toContain("260903-delta");
    expect(strip).toContain("260903-echo");
    expect(text(strip)).toContain("waiting on a human");
    // `waitingOn` is `isMovable`, so a `ready` run also reads "waiting on a
    // human" — truthfully. It must not wear the emphasis a gate does: alpha and
    // golf are ready, and only the three that raise an ask carry `data-ask`.
    expect(strip.split('data-ask="1"')).toHaveLength(4);
    // Focusable cards are named, or a screen reader announces "group".
    expect(strip).toContain('aria-labelledby="now-t-260903-charlie"');
    // foxtrot is `done`. A finished run is not news, and a strip that carries it
    // is a strip a reader learns to skim.
    expect(strip).not.toContain("260903-foxtrot");

    // The strip is the page's first answer, so it leads the runs view.
    const runs = dashMain(chain, UI, { view: "runs", id: null }, NOW_MS);
    expect(runs).toContain('class="now"');
    expect(runs.indexOf('class="now"')).toBeLessThan(runs.indexOf('class="runrow"'));
  });

  test("a workspace where nothing is live says so rather than drawing an empty rail", () => {
    const chain = buildModel(
      join(FRAMEWORK_ROOT, "test", "fixtures", "chain", "workspace"), READ_AT, { now: NOW },
    );
    const finished: DashboardModel = {
      ...chain,
      runs: chain.runs.map((run) => ({
        ...run,
        status: "done",
        waiting: { kind: "done", message: "this run is done", questions: [] },
        nextAction: { ...run.nextAction, kind: "done", waitingOn: "nobody" },
      })),
    };
    expect(text(dashNowStrip(finished, NOW_MS))).toContain("Nothing is live");
    expect(dashNowStrip(finished, NOW_MS)).not.toContain('class="now"');
  });
});

// ---------------------------------------------------------------------------
// 2. Phase dots
// ---------------------------------------------------------------------------

describe("2. the phase dots are the run's OWN phases", () => {
  test("a feature run draws what → watch, and each dot carries the phase it is", () => {
    const { root } = workspaceWith("260903-hero", AT_A_GATE);
    const dots = dashPhaseDots(onlyRun(root));
    for (const phase of ["what", "how", "plan", "build", "watch"]) {
      expect(dots).toContain(`>${phase}<`);
    }
    // Two done, one at a gate, two not started — the tones the page already uses.
    expect(dots.split('data-st="done"')).toHaveLength(3);
    expect(dots).toContain('data-st="wait"');
  });

  test("a run whose run.yml declares two phases gets two dots — no fifth is invented", () => {
    const { root } = workspaceWith("260903-short", runYaml(
      "260903-short",
      `status: running
cursor: {phase: 02-how, stage: how, task: null}`,
      fiveP(["done", "running"]).split("\n").slice(0, 18).join("\n"),
    ));
    const dots = dashPhaseDots(onlyRun(root));
    expect(dots).toContain(">what<");
    expect(dots).toContain(">how<");
    // The workflow preset says a `feature` run has five. This run's file says two,
    // and the file is what the model read.
    expect(dots).not.toContain(">watch<");
  });
});

// ---------------------------------------------------------------------------
// 3. Spend, both economies, honestly
// ---------------------------------------------------------------------------

const METERED_TASK = `{id: t1, status: done, expert: architect, model: sonnet, cost_usd: 2.5,
                  metered: true, error: null}`;
const UNMETERED_TASK = `{id: t2, status: done, expert: architect, model: sonnet, cost_usd: null,
                  metered: false, error: null}`;

function withTasks(tasks: string): string {
  return `  - id: 01-what
    status: done
    stages:
      - {id: what, status: done, expert: architect, model: sonnet, budget_usd: 3.0, cost_usd: 2.5,
         started_at: null, ended_at: null, inputs: [], outputs: [],
         gate: {type: approve, status: approved, by: alan, at: null, note: ""},
         tasks: [${tasks}]}`;
}

describe("3. spend on the card is a lower bound when it is one, and never a bar", () => {
  test("a run nobody left unmetered gets the fraction and the bar it has always had", () => {
    const { root } = workspaceWith("260903-measured", runYaml(
      "260903-measured", "status: running\ncursor: {phase: 01-what, stage: what, task: null}",
      withTasks(METERED_TASK),
    ));
    const run = onlyRun(root);
    expect(run.spend.basis).toBe("measured");
    const spend = dashHeroSpend(run);
    expect(spend).toContain('class="meter"');
    expect(text(spend)).toContain("$5.00");
    expect(text(spend)).toContain("$25.00");
    // The marker is for the runs that need it. A measured run does not.
    expect(text(spend)).not.toContain("lower bound");
  });

  test("a host-attended run whose costless turns declared nothing gets a marker, not a bar", () => {
    const { root } = workspaceWith("260903-absent", runYaml(
      "260903-absent",
      `status: running
attended_by: host
cursor: {phase: 01-what, stage: what, task: null}`,
      withTasks(`${METERED_TASK}, ${UNMETERED_TASK}`),
    ));
    const run = onlyRun(root);
    expect(run.spend.basis).toBe("absent");

    const spend = dashHeroSpend(run);
    // A bar is a claim about a denominator. There is no honest denominator here.
    expect(spend).not.toContain('class="meter"');
    // The figure is still shown — it is the part that IS known — and it is marked
    // as the floor it is, in the phrase the CLI already prints.
    expect(text(spend)).toContain("$5.00");
    expect(text(spend).toLowerCase()).toContain("lower bound");
    // And the count of turns that put nothing in the meter, so the size of the
    // gap is a number rather than an adjective.
    expect(text(spend)).toContain("1 of 2");
  });
});

// ---------------------------------------------------------------------------
// 4. Staleness — shown always, "quiet" is the RENDER's own threshold
// ---------------------------------------------------------------------------

describe("4. how long since anything happened, and when that is worth a colour", () => {
  const withAge = (run: RunModel, seconds: number | null, from: string): RunModel => ({
    ...run,
    lastEventAt: seconds === null ? null : new Date(NOW_MS - seconds * 1000).toISOString(),
    lastEventFrom: from,
    ageSeconds: seconds,
  });

  test("an age is always printed; past the render's own threshold it also goes quiet", () => {
    const { root } = workspaceWith("260903-hero", AT_A_GATE);
    const run = onlyRun(root);

    const fresh = dashHeroAge(withAge(run, 120, "event"), NOW_MS);
    expect(text(fresh)).toContain("2m ago");
    expect(fresh).not.toContain('data-quiet="1"');

    // 30 minutes is the page's line, not the model's — the model bakes none in.
    const quiet = dashHeroAge(withAge(run, 40 * 60, "event"), NOW_MS);
    expect(text(quiet)).toContain("40m ago");
    expect(quiet).toContain('data-quiet="1"');
  });

  test("an mtime is named as the weaker fact it is, and no ledger says no ledger", () => {
    const { root } = workspaceWith("260903-hero", AT_A_GATE);
    const run = onlyRun(root);

    const touched = text(dashHeroAge(withAge(run, 45 * 60, "mtime"), NOW_MS));
    expect(touched).toContain("touched");
    // "last event" would be a claim the file cannot support: the ledger's mtime
    // says the file was written, not that the run moved.
    expect(touched).not.toContain("last event");

    expect(text(dashHeroAge(withAge(run, null, "none"), NOW_MS))).toContain("no ledger");
  });

  test("a ledger written AFTER the read is named, not reported as a negative age", () => {
    const { root } = workspaceWith("260903-hero", AT_A_GATE);
    const ahead = dashHeroAge(withAge(onlyRun(root), -600, "event"), NOW_MS);
    expect(text(ahead)).toContain("ahead of this read");
    // Clock skew is not silence.
    expect(ahead).not.toContain('data-quiet="1"');
  });
});

// ---------------------------------------------------------------------------
// 5. Drill-in: the phase timeline
// ---------------------------------------------------------------------------

describe("5. the phase timeline: cost and model per stage, gate detail expandable", () => {
  test("it lanes the stages by phase and opens each one onto what the gate carries", () => {
    const { root } = workspaceWith("260903-hero", AT_A_GATE);
    const timeline = dashPhaseTimeline(onlyRun(root));
    expect(timeline).toContain("<h2>Phase timeline</h2>");
    expect(timeline).toContain("<details");
    const words = text(timeline);
    expect(words).toContain("01-what");
    expect(words).toContain("sonnet");
    expect(words).toContain("$1.25");
    expect(words).toContain("alan");
    // The path table is still reachable, and still the exhaustive listing.
    expect(timeline).toContain("<th>signed by</th>");
  });

  test("a stage's duration and a gate's note are NOT on the model, and it says so", () => {
    const { root } = workspaceWith("260903-hero", AT_A_GATE);
    const words = text(dashPhaseTimeline(onlyRun(root)));
    // run.yml carries `started_at`, `ended_at` and `gate.note`; StageRowModel
    // carries none of the three. A blank cell would read as "it took no time".
    expect(words).toContain("not on the model");
    expect(words).toContain("started_at");
    expect(words).toContain("ended_at");
    // And it points at the file, not at a command: `tldrx run status` does not
    // print a duration or a gate note either — measured against runStatus.ts.
    expect(words).toContain("run.yml");
  });
});

// ---------------------------------------------------------------------------
// 6. Drill-in: the story grid
// ---------------------------------------------------------------------------

/** The shapes the schema really accepts: `done` is refused without evidence. */
const STORY = (id: string, status: string): string => `---
version: 1
id: ${id}
epic: E1
title: "Story ${id}"
repo: api
status: ${status}
depends_on: []
touches: ["src/"]
acceptance: ["it works"]
test_plan: ["unit"]
evidence: [${status === "done" ? '"commit abc1234"' : ""}]
---

# ${id}

\`\`\`dod
bun test
\`\`\`
`;

const EPIC_MD = `---
version: 1
id: E1
title: "The epic"
repos: [api]
stories: [S1, S2, S3]
branch: epic/hero
status: in_progress
---

# E1
`;

const WAVES_YML = `version: 1
waves:
  - {id: W1, stories: [S1, S2]}
  - {id: W2, stories: [S3]}
`;

const REOPEN = JSON.stringify({
  ts: "2026-09-03T10:00:00Z", run: "260903-plan", seq: 9, stage: "build", actor: "alan",
  type: "story.reopened", cost_usd: 0,
  payload: { story: "S2", reason: "fix", note: "the ordering was wrong", from_status: "done" },
});

/** A run that has reached Build, with three stories over two waves and one fix round. */
function planWorkspace(): string {
  const { root, runDir } = workspaceWith("260903-plan", runYaml(
    "260903-plan",
    `status: running
cursor: {phase: 04-build, stage: build, task: null}`,
    fiveP(["done", "done", "done", "running"]),
  ));
  const plan = join(runDir, "03-plan");
  mkdirSync(join(plan, "stories"), { recursive: true });
  mkdirSync(join(plan, "epics"), { recursive: true });
  writeFileSync(join(plan, "stories", "S1.md"), STORY("S1", "done"), "utf8");
  writeFileSync(join(plan, "stories", "S2.md"), STORY("S2", "in_progress"), "utf8");
  writeFileSync(join(plan, "stories", "S3.md"), STORY("S3", "todo"), "utf8");
  writeFileSync(join(plan, "epics", "E1.md"), EPIC_MD, "utf8");
  writeFileSync(join(plan, "waves.yml"), WAVES_YML, "utf8");
  writeFileSync(join(runDir, "events.jsonl"), `${REOPEN}\n`, "utf8");
  return root;
}

describe("6. the story grid: a status cell per story, opening onto the story", () => {
  test("every story is a cell, coloured by status, and each opens onto what the model has", () => {
    const grid = dashStoryGrid(onlyRun(planWorkspace()), 2);
    expect(grid).toContain("<h2>Story grid</h2>");
    for (const id of ["S1", "S2", "S3"]) expect(grid).toContain(id);
    expect(grid).toContain('data-st="done"');
    expect(grid).toContain("<details");
    const words = text(grid);
    expect(words).toContain("Story S2");
    expect(words).toContain("the ordering was wrong");
    // The build log and the fix list are files on disk that the model does not
    // read. Naming them beats a cell that looks like it has them.
    expect(words).toContain("not on the model");
  });

  test("a run whose Plan has written nothing draws no grid at all", () => {
    const { root } = workspaceWith("260903-hero", AT_A_GATE);
    expect(dashStoryGrid(onlyRun(root), 2)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// 7. Drill-in: the event stream
// ---------------------------------------------------------------------------

const NOTE = JSON.stringify({
  ts: "2026-09-03T11:30:00Z", run: "260903-plan", seq: 12, stage: "build", actor: "alan",
  type: "operator_note", cost_usd: 0, payload: { note: "rebased the epic branch by hand" },
});

describe("7. the event stream: every timestamped fact the model carries", () => {
  test("it merges the notes, the refusals and the reopens, newest first, and can be filtered", () => {
    const root = planWorkspace();
    const runDir = join(root, "tldrx-work", "260903-plan");
    writeFileSync(join(runDir, "events.jsonl"), `${REOPEN}\n${NOTE}\n`, "utf8");
    const run = onlyRun(root);

    const stream = dashEventStream(run, { status: "all", sort: "order", stream: "all" });
    expect(stream).toContain("<h2>Event stream</h2>");
    const words = text(stream);
    expect(words).toContain("rebased the epic branch by hand");
    expect(words).toContain("the ordering was wrong");
    // Newest first: the note is 11:30, the reopen 10:00.
    expect(stream.indexOf("rebased")).toBeLessThan(stream.indexOf("ordering"));
    // Filterable, with the page's own button vocabulary.
    expect(stream).toContain('data-stream="note"');

    const notes = dashEventStream(run, { status: "all", sort: "order", stream: "note" });
    expect(text(notes)).toContain("rebased the epic branch by hand");
    expect(text(notes)).not.toContain("the ordering was wrong");

    // And it does not claim to be the ledger: most event types never reach the model.
    expect(words).toContain("tldrx replay");
  });

  test("a run nobody annotated, nobody blocked and nobody reopened draws no stream", () => {
    const { root } = workspaceWith("260903-hero", AT_A_GATE);
    expect(dashEventStream(onlyRun(root), UI)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// 8. The waves view
// ---------------------------------------------------------------------------

describe("8. the waves view: parallelism and fix rounds, as bars", () => {
  test("a wave with two stories draws two bars in it, and a fix round is marked on one", () => {
    const model = modelOf(planWorkspace());
    const view = dashWavesView(model);
    expect(view).toContain("<h1>Waves</h1>");
    expect(view).toContain("W1");
    expect(view).toContain("W2");
    expect(view).toContain('class="gantt__bar"');
    // W1 schedules S1 and S2 — that is the parallelism the view exists to show.
    expect(view.split('data-wave="W1"')).toHaveLength(3);
    // S2 was reopened for a defect. A fix round is the thing a wave view is read for.
    expect(text(view)).toContain("1 fix round");
    // It is reachable: a tab, and a hash route.
    expect(dashMain(model, UI, { view: "waves", id: null }, NOW_MS)).toContain("<h1>Waves</h1>");
  });

  test("a workspace whose plans schedule nothing says so instead of drawing an empty chart", () => {
    const { root } = workspaceWith("260903-hero", AT_A_GATE);
    expect(text(dashWavesView(modelOf(root)))).toContain("No waves");
    expect(dashWavesView(modelOf(root))).not.toContain('class="gantt__bar"');
  });
});

// ---------------------------------------------------------------------------
// 9. Craft — keyboard, tabular money, and the one-file rule
// ---------------------------------------------------------------------------

describe("9. craft: keyboard reach, tabular money, still one file", () => {
  test("the page states its own shortcuts, and every Now card is a keyboard stop", () => {
    const chain = buildModel(
      join(FRAMEWORK_ROOT, "test", "fixtures", "chain", "workspace"), READ_AT, { now: NOW },
    );
    const help = text(dashKeyHelp());
    expect(help).toContain("j");
    expect(help).toContain("k");

    const strip = dashNowStrip(chain, NOW_MS);
    expect(strip).toContain('data-nav="1"');
    // The handler is real, not just advertised.
    expect(DASHBOARD_JS).toContain('data-nav="1"');
    expect(() => new Function(DASHBOARD_JS)).not.toThrow();
  });

  test("money lines up: the hero's figures are tabular, in both themes", () => {
    expect(DASHBOARD_CSS).toContain(".now__usd");
    expect(DASHBOARD_CSS).toMatch(/\.now__usd\{[^}]*font-variant-numeric:tabular-nums/);
    // The strip has to be legible in the reader's own theme, which is the one
    // thing a hard-coded colour would break.
    expect(DASHBOARD_CSS).toContain("prefers-color-scheme: dark");
  });

  test("every new template function is serialised into the page", () => {
    const source = clientRenderer();
    for (const name of [
      "dashNowStrip", "dashPhaseDots", "dashHeroSpend", "dashHeroAge",
      "dashPhaseTimeline", "dashStoryGrid", "dashEventStream", "dashWavesView", "dashKeyHelp",
    ]) {
      expect(source).toContain(`function ${name}(`);
    }
  });
});
