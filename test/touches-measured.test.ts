/**
 * The SECOND reading of a story's surface — measured off its own diff (#185).
 *
 * `touches` is written by the Plan sub-agent before the code exists and nothing
 * reads it again. Measured on three real workspaces: one story changed 21 files
 * and 18 of them were outside its declared `touches`, and the pattern repeated on
 * the other two stories of the same run. The boundary audit was therefore
 * answering against a forecast, which is the shape of check that gets switched
 * off.
 *
 * What is added here is not a second `touches` field and not a second verb. Wave
 * 4's `story.touches_widened` already records "the surface grew"; this gives that
 * one record TWO honest bases — `basis: "measured"` with `actor: "framework"` when
 * the framework read it off the diff, and an ABSENT `basis` (every row wave 4
 * wrote) meaning the operator declared it. `version: 1` formats only grow.
 *
 * Four things are pinned:
 *   (a) a build whose developer writes outside `touches` appends exactly ONE
 *       measured event, and the story still completes — this never refuses
 *   (b) a build whose changes stay inside `touches` appends none
 *   (c) an operator row and a measured row both render, labelled, in the handoff
 *       and in `tldrx replay`
 *   (d) a row written before this field existed reads as `declared`
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runNext, type NextOptions } from "../src/core/facilitator/runNext.ts";
import { widenStory } from "../src/core/run/widenStory.ts";
import { reopenStory } from "../src/core/run/reopenStory.ts";
import { EventLog } from "../src/core/events/EventLog.ts";
import { validateEvent } from "../src/core/events/Event.ts";
import { loadRun, renderReplay } from "../src/core/replay/index.ts";
import {
  basisOf, measuredWidening, MEASURED_NOTE_TAIL, wideningRows,
} from "../src/core/build/measuredTouches.ts";
import { renderBuildHandoff } from "../src/core/build/handoff.ts";
import { splitFrontMatter } from "../src/core/schemas/frontMatter.ts";
import { parseYaml } from "../src/core/yaml.ts";
import { makeBuildWorkspace, type BuildWorkspace, type BuildWorkspaceOptions } from "./fixtures/build/workspace.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

// `makeBuildWorkspace` `git init`s a real repo and two cases run the real Build
// executor, so this file spawns. Process cost is a property of the machine.
setDefaultTimeout(spawnTestTimeout());

const ORIGINAL_PATH = process.env.PATH ?? "";
const FAKE_KEYS = ["FAKE_BUILD_WRITE", "FAKE_BUILD_STATE", "FAKE_BUILD_COST"] as const;

let open: BuildWorkspace[] = [];

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  for (const key of FAKE_KEYS) delete process.env[key];
  for (const ws of open) ws.dispose();
  open = [];
});

/**
 * One story that declares `src/in.ts` and nothing else. The fake developer writes
 * `s1.txt` unless told otherwise — so this plan's work lands OUTSIDE its declared
 * surface, which is exactly the run #185 measured.
 */
const UNDER_DECLARED: BuildWorkspaceOptions = {
  stories: [{ id: "S1", epic: "E1", title: "Under-declared", touches: ["src/in.ts"] }],
  epics: [{ id: "E1", stories: ["S1"], branch: "epic/e1" }],
  waves: [["S1"]],
  gates: "none",
  repoFiles: { "src/in.ts": "export const before = 1;\n" },
};

/** The same story, declaring the file its developer actually writes. */
const DECLARED_RIGHT: BuildWorkspaceOptions = {
  ...UNDER_DECLARED,
  stories: [{ id: "S1", epic: "E1", title: "Declared right", touches: ["s1.txt"] }],
};

function workspace(options: BuildWorkspaceOptions): BuildWorkspace {
  const made = makeBuildWorkspace(options);
  open.push(made);
  process.env.PATH = made.binDir;
  process.env.FAKE_BUILD_STATE = made.statePath;
  return made;
}

function next(ws: BuildWorkspace, overrides: Partial<NextOptions> = {}) {
  return runNext({
    root: ws.root,
    dryRun: false,
    mode: "headless",
    yolo: false,
    actor: "alan",
    at: "2026-09-07T09:00:00Z",
    ...overrides,
  });
}

function eventsOf(
  ws: BuildWorkspace,
): readonly { type: string; actor: string; payload: Record<string, unknown> }[] {
  return EventLog.forRun(ws.runDir).read() as never;
}

function widenings(ws: BuildWorkspace) {
  return eventsOf(ws).filter((e) => e.type === "story.touches_widened");
}

/** Events as the file holds them: one JSON object per line, in order. */
function jsonl(rows: readonly Record<string, unknown>[]): string {
  return rows
    .map((row) => JSON.stringify({ ts: "2026-09-07T10:00:00Z", run: "r", stage: null, cost_usd: 0, ...row }))
    .join("\n") + "\n";
}

function storyFront(ws: BuildWorkspace, id: string): Record<string, unknown> {
  const text = readFileSync(join(ws.planDir, "stories", `${id}.md`), "utf8");
  return parseYaml(splitFrontMatter(text).raw) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------

describe("(a) work outside the declared surface is measured, once, and never refused", () => {
  test("one story.touches_widened, basis measured, actor framework, naming the outside path", async () => {
    const ws = workspace(UNDER_DECLARED);
    const outcome = await next(ws);

    // 4 = awaiting a human, and it is the BOUNDARY gate's doing (condition 7, which
    // has refused work outside the declared surface since long before this
    // measurement) — not this event's. Measured: with the comparison removed, the
    // same plan still exits 4. What is pinned here is that the story SETTLES: an
    // advisory measurement must not be able to stop one from reaching `done`.
    expect(outcome.code).toBe(4);
    expect(storyFront(ws, "S1").status).toBe("done");

    const rows = widenings(ws);
    expect(rows).toHaveLength(1);
    const [event] = rows;
    expect(event?.actor).toBe("framework");
    expect(event?.payload.basis).toBe("measured");
    expect(event?.payload.story).toBe("S1");
    expect(event?.payload.paths).toEqual(["s1.txt"]);
    expect(event?.payload.before).toEqual(["src/in.ts"]);
    expect(event?.payload.after).toEqual(["src/in.ts", "s1.txt"]);
    expect(String(event?.payload.note)).toContain("1 of 1 changed file");
    expect(validateEvent(event).ok).toBe(true);
  });

  test("the story's DECLARED list is untouched — declaring is the operator's verb", async () => {
    const ws = workspace(UNDER_DECLARED);
    await next(ws);
    expect(storyFront(ws, "S1").touches).toEqual(["src/in.ts"]);
  });
});

describe("(b) a story that declared what it changed produces no measured event", () => {
  test("nothing is appended when every changed path is inside touches", async () => {
    const ws = workspace(DECLARED_RIGHT);
    const outcome = await next(ws);
    // 0, because nothing is outside the surface for condition 7 to refuse — the
    // control that shows the 4 in case (a) belongs to the boundary gate.
    expect(outcome.code).toBe(0);
    expect(widenings(ws)).toHaveLength(0);
  });
});

describe("(c) both bases render, labelled", () => {
  test("replay names the operator row and the measured row differently", async () => {
    const ws = workspace(UNDER_DECLARED);
    await next(ws);
    // The measured story settled `done`, and `widen` refuses a done story on
    // purpose (#171) — its evidence was written against the surface it declared.
    // The sanctioned path is `reopen --for-fix` first, which is exactly the order
    // a reader of this narrative needs to see both bases in.
    expect(reopenStory({
      root: ws.root, actor: "alan", at: "2026-09-07T10:00:00Z",
      storyId: "S1", forFix: true, note: "the tenancy check also lives in platform/Auth.cs",
    }).code).toBe(0);
    expect(widenStory({
      root: ws.root, actor: "alan", at: "2026-09-07T10:00:00Z",
      storyId: "S1", paths: ["platform/Auth.cs"], note: "the tenancy check lives here too",
    }).code).toBe(0);

    const text = renderReplay(loadRun(ws.root, ws.runId)!);
    expect(text).toContain("WIDENED by framework (measured)");
    expect(text).toContain("WIDENED by alan (declared)");
  });

  test("the handoff renders one bullet per widening, each carrying its basis", () => {
    const rendered = renderBuildHandoff({
      runId: "260907-x", stageId: "04-build", model: null, costUsd: 0, budgetUsd: 1,
      at: "2026-09-07T09:00:00Z", outcomes: [], epics: [],
      widenings: [
        { story: "S1", basis: "measured", paths: ["src/app/page.tsx"], before: 3, after: 4, line: 7,
          note: `18 of 21 changed files fell outside the declared touches${MEASURED_NOTE_TAIL}` },
        { story: "S2", basis: "declared", paths: ["platform/Auth.cs"], before: 2, after: 3, line: 9,
          note: "the tenancy check lives here too" },
      ],
    });
    expect(rendered).toContain("S1's declared surface was under the work it did (measured)");
    expect(rendered).toContain("src/app/page.tsx");
    expect(rendered).toContain("S2's surface was widened by a person (declared)");
  });
});

describe("(d) a row written before this field existed reads as declared", () => {
  test("basisOf is tolerant: absent, null and junk all read `declared`", () => {
    expect(basisOf({})).toBe("declared");
    expect(basisOf({ basis: null })).toBe("declared");
    expect(basisOf({ basis: "" })).toBe("declared");
    expect(basisOf({ basis: "guessed" })).toBe("declared");
    expect(basisOf({ basis: "measured" })).toBe("measured");
  });

  test("a wave-4 row with no basis reads as an operator widening", () => {
    const rows = wideningRows(jsonl([
      { type: "run.created", actor: "alan", payload: {} },
      {
        type: "story.touches_widened", actor: "alan",
        payload: { story: "S1", paths: ["a.ts"], note: "why", before: ["b.ts"], after: ["b.ts", "a.ts"] },
      },
    ]));
    expect(rows).toEqual([
      { story: "S1", basis: "declared", paths: ["a.ts"], before: 1, after: 2, note: "why", line: 2 },
    ]);
  });
});

describe("the handoff's citation names the line the event is actually on", () => {
  /**
   * A `[src: …]` token is an AUDIT citation, and a record that names a line
   * nothing is on is a record lying in the dangerous direction (AGENTS.md §7).
   * Two widenings at DIFFERENT known lines, so a hardcoded `:1` cannot pass:
   * the operator row is physical line 3 and the measured row is line 5.
   */
  const LOG = jsonl([
    { type: "run.created", actor: "alan", payload: {} },
    { type: "task.started", actor: "facilitator", payload: {} },
    {
      type: "story.touches_widened", actor: "alan",
      payload: { story: "S1", paths: ["platform/Auth.cs"], note: "the tenancy check lives here too",
        before: ["src/in.ts"], after: ["src/in.ts", "platform/Auth.cs"] },
    },
    { type: "task.done", actor: "facilitator", payload: {} },
    {
      type: "story.touches_widened", actor: "framework",
      payload: { story: "S2", paths: ["src/app/page.tsx"], note: "1 of 2 changed files fell outside",
        before: ["src/in.ts"], after: ["src/in.ts", "src/app/page.tsx"], basis: "measured" },
    },
  ]);

  test("wideningRows carries the physical line of each event", () => {
    expect(wideningRows(LOG).map((row) => [row.story, row.line])).toEqual([["S1", 3], ["S2", 5]]);
  });

  test("each handoff bullet cites its OWN line, not a constant", () => {
    const rendered = renderBuildHandoff({
      runId: "260907-x", stageId: "04-build", model: null, costUsd: 0, budgetUsd: 1,
      at: "2026-09-07T09:00:00Z", outcomes: [], epics: [],
      widenings: wideningRows(LOG),
    });
    const cited = rendered.split("\n")
      .filter((line) => line.includes("`touches:`") || line.includes("surface"))
      .filter((line) => line.includes("[src: events.jsonl:"));
    expect(cited).toHaveLength(2);
    expect(cited[0]).toContain("S1's surface was widened by a person (declared)");
    expect(cited[0]).toContain("[src: events.jsonl:3]");
    expect(cited[1]).toContain("S2's declared surface was under the work it did (measured)");
    expect(cited[1]).toContain("[src: events.jsonl:5]");
  });

  test("a torn line loses itself and nothing else, and the numbering does not shift", () => {
    const rows = wideningRows(`{"type":"run.created"}\n{not json\n${LOG.split("\n")[2] ?? ""}\n`);
    expect(rows.map((row) => row.line)).toEqual([3]);
  });
});

describe("the comparison itself", () => {
  test("outside paths only, with the count in the note the issue measured", () => {
    const changed = Array.from({ length: 21 }, (_, i) => (i < 3 ? `src/in${String(i)}.ts` : `app/out${String(i)}.tsx`));
    const measured = measuredWidening(changed, ["src/in0.ts", "src/in1.ts", "src/in2.ts"]);
    expect(measured?.paths).toHaveLength(18);
    expect(measured?.note).toContain("18 of 21 changed files fell outside the declared touches");
    expect(measured?.after).toHaveLength(21);
  });

  test("a directory entry covers its tree, so nothing under it is reported outside", () => {
    expect(measuredWidening(["src/a/b.ts", "src/c.ts"], ["src"])).toBeNull();
  });

  test("framework state is never counted as a surface the story grew into", () => {
    expect(measuredWidening([".tldrx/workspace.yml", "tldrx-work/r/run.yml"], ["src/in.ts"])).toBeNull();
  });

  test("no change at all is not a widening", () => {
    expect(measuredWidening([], ["src/in.ts"])).toBeNull();
  });
});
