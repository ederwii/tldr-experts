import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildModel, dashMain, dashRadar, offlineHtml, renderDashboard, writeStaticDashboard,
} from "../src/core/dashboard/index.ts";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";
import { EXIT_OK } from "../src/cli/exitCodes.ts";
import { makeViewsWorkspace, VIEWS_FIXTURE, VIEWS_NOW, VIEWS_RUN } from "./fixtures/views/tempViews.ts";

const BIN = join(FRAMEWORK_ROOT, "bin", "tldrx.ts");
const GENERATED_AT = "2026-09-02T08:00:00Z";

async function tldrx(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", BIN, ...args], { stdout: "pipe", stderr: "pipe", cwd: FRAMEWORK_ROOT });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

const model = buildModel(VIEWS_FIXTURE, GENERATED_AT, { now: VIEWS_NOW });
const html = renderDashboard(model);

/** Every `src="…"` / `href="…"` value in the document. */
function attributeTargets(document: string): readonly string[] {
  return [...document.matchAll(/(?:src|href)="([^"]*)"/g)].map((match) => match[1] ?? "");
}

/**
 * The field names a designer targets, as a flat sorted list of dotted paths.
 *
 * A snapshot of NAMES rather than of the whole page: the rendering layer is
 * meant to be replaced, so this test is about the contract that survives that,
 * not about the markup that does not.
 */
function fieldPaths(value: unknown, prefix = ""): readonly string[] {
  if (Array.isArray(value)) {
    return [...new Set(value.flatMap((item) => fieldPaths(item, `${prefix}[]`)))];
  }
  if (typeof value !== "object" || value === null) return [prefix];
  const out: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out.push(...fieldPaths(child, prefix === "" ? key : `${prefix}.${key}`));
  }
  return [...new Set(out)];
}

describe("the dashboard model", () => {
  test("is one plain JSON document — it survives a JSON round trip unchanged", () => {
    expect(JSON.parse(JSON.stringify(model))).toEqual(model);
  });

  // Empty arrays contribute no path, so `chains[][]`, `runs[].dependsOn[]`,
  // `runs[].blockedBy[]` and `runs[].waiting.questions[]` are absent HERE only
  // because this fixture's one run has no siblings and no open block in its
  // cursor phase. `dashboard-deps.test.ts` asserts all four over a fixture that
  // does have them — the two lists together are the whole contract.
  test("its field names are the contract a designer targets", () => {
    expect([...fieldPaths(model)].sort()).toEqual([
      "experts[].areas[].evidenceCount",
      "experts[].areas[].id",
      "experts[].areas[].level",
      "experts[].areas[].newestEvidence",
      "experts[].areas[].storedLevel",
      "experts[].areas[].title",
      "experts[].areas[].trainPrompt",
      "experts[].error",
      "experts[].lastTrained",
      "experts[].name",
      "experts[].status",
      "experts[].warnings[]",
      "faq[].commands[]",
      "faq[].heading",
      "generatedAt",
      "live",
      "maxLevel",
      "modelVersion",
      "order[]",
      "root",
      "runs[].ceilingUsd",
      "runs[].cursor",
      "runs[].filter",
      "runs[].id",
      "runs[].path[].budgetUsd",
      "runs[].path[].costUsd",
      "runs[].path[].expert",
      "runs[].path[].gate",
      "runs[].path[].gateBy",
      "runs[].path[].gatePolicy",
      "runs[].path[].id",
      "runs[].path[].model",
      "runs[].path[].phase",
      "runs[].path[].status",
      "runs[].pendingGate",
      "runs[].pendingQuestion",
      "runs[].percent",
      "runs[].phases[].handoffHtml",
      "runs[].phases[].id",
      "runs[].phases[].questions[].answerCommand",
      "runs[].phases[].questions[].id",
      "runs[].phases[].questions[].options[].letter",
      "runs[].phases[].questions[].options[].text",
      "runs[].phases[].questions[].title",
      "runs[].phases[].questions[].whyAsked",
      "runs[].phases[].status",
      "runs[].plan",
      "runs[].repos[]",
      "runs[].runnable",
      "runs[].scope",
      "runs[].spentUsd",
      "runs[].stagesDone",
      "runs[].stagesTotal",
      "runs[].status",
      "runs[].title",
      "runs[].updatedAt",
      "runs[].waiting.kind",
      "runs[].waiting.message",
      "runs[].workflow",
      "workspace",
      "workspaceFound",
    ]);
  });

  test("finds the run, its phases, its artefacts and the experts", () => {
    expect(model.runs).toHaveLength(1);
    const run = model.runs[0]!;
    expect(run.id).toBe(VIEWS_RUN);
    expect(run.stagesTotal).toBe(2);
    expect(run.stagesDone).toBe(1);
    expect(run.percent).toBe(50);
    // The run is parked at a gate, so that is what it is waiting on. Q2 and Q3
    // are open in `01-what`, a phase that was already approved — still listed
    // under `phases[].questions`, but not what stops the run.
    expect(run.waiting.kind).toBe("gate");
    expect(run.pendingGate).toBe("how");
    expect(run.pendingQuestion).toBeNull();
    expect(run.path.map((stage) => `${stage.phase}/${stage.id}`)).toEqual(["01-what/what", "02-how/how"]);
    expect(run.phases[0]!.handoffHtml).toContain("<h2>Findings</h2>");
    expect(run.phases[0]!.questions.map((question) => question.id)).toEqual(["Q2", "Q3"]);
    expect(model.experts.map((expert) => expert.name)).toEqual(["dotnet-stack", "lab-ui"]);
    expect(model.workspaceFound).toBe(true);
    expect(model.live).toBe(false);
  });

  test("an unknown evidence kind reaches the page as a warning line, not silence", () => {
    const workspace = makeViewsWorkspace();
    try {
      writeFileSync(
        join(workspace.root, ".tldrx", "experts", "lab-ui", "competencies.yml"),
        [
          "version: 1",
          "expert: lab-ui",
          "status: in-use",
          "last_trained: 2026-08-20T11:00:00Z",
          "areas:",
          "  - id: scoreboard-ui",
          '    title: "scoreboard-ui"',
          "    level: 0",
          "    evidence:",
          '      - {kind: sketch, src: "lab:src/B.tsx:1", at: 2026-08-30}',
          "",
        ].join("\n"),
        "utf8",
      );
      const built = buildModel(workspace.root, GENERATED_AT, { now: VIEWS_NOW });
      const labUi = built.experts.find((expert) => expert.name === "lab-ui")!;
      expect(labUi.warnings).toContain(
        "warning: lab-ui/scoreboard-ui: 1 evidence row(s) ignored — "
        + "unknown kind 'sketch' (allowed: code, run, test, doc, answer)",
      );
    } finally {
      workspace.dispose();
    }
  });

  test("a run with no Plan artefacts carries `plan: null`", () => {
    expect(model.runs[0]!.plan).toBeNull();
  });

  test("stories, epics and waves are read when the Plan has written them", () => {
    const workspace = makeViewsWorkspace();
    try {
      const plan = join(workspace.runDir, "03-plan");
      mkdirSync(join(plan, "stories"), { recursive: true });
      mkdirSync(join(plan, "epics"), { recursive: true });
      writeFileSync(join(plan, "stories", "S1.md"), story("S1"), "utf8");
      writeFileSync(join(plan, "stories", "S2.md"), story("S2", ["S1"]), "utf8");
      writeFileSync(join(plan, "epics", "E1.md"), EPIC, "utf8");
      writeFileSync(join(plan, "waves.yml"), WAVES, "utf8");

      // The fixture's run.yml has no 03-plan phase, so the folder scan has to
      // find it — which it cannot, by design: the model reads the phases run.yml
      // declares. Add the phase and it appears.
      const runYml = join(workspace.runDir, "run.yml");
      writeFileSync(runYml, `${readFileSync(runYml, "utf8")}  - id: 03-plan\n    status: ready\n    stages: []\n`, "utf8");

      const built = buildModel(workspace.root, GENERATED_AT, { now: VIEWS_NOW });
      const found = built.runs[0]!.plan;
      expect(found).not.toBeNull();
      expect(found!.phase).toBe("03-plan");
      expect(found!.stories.map((s) => `${s.id}:${s.wave ?? "-"}`)).toEqual(["S1:W1", "S2:W2"]);
      expect(found!.stories[1]!.dependsOn).toEqual(["S1"]);
      expect(found!.epics.map((e) => e.id)).toEqual(["E1"]);
      expect(found!.waves.map((w) => w.id)).toEqual(["W1", "W2"]);
      expect(found!.unreadable).toEqual([]);

      const page = dashMain(built, { status: "all", sort: "updated" },
        { view: "run", id: built.runs[0]!.id }, VIEWS_NOW.getTime());
      expect(page).toContain("03-plan · 2 stories");
      expect(page).toContain("<th>depends on</th>");
      expect(page).toContain('<span class="tag" style="margin-left:auto">epic/leaderboard</span>');
      // Waves are shown in file order, because file order is execution order.
      expect(page.indexOf(">W1<")).toBeLessThan(page.indexOf(">W2<"));
    } finally {
      workspace.dispose();
    }
  });

  test("a workspace with no .tldrx/ says so instead of looking empty", () => {
    const empty = buildModel(join(FRAMEWORK_ROOT, "test", "fixtures"), GENERATED_AT, { now: VIEWS_NOW });
    expect(empty.workspaceFound).toBe(false);
    const page = dashMain(empty, { status: "all", sort: "updated" },
      { view: "runs", id: null }, VIEWS_NOW.getTime());
    expect(page).toContain("No workspace here");
    expect(page).toContain("tldrx init");
  });
});

describe("the static page", () => {
  test("is one self-contained HTML document", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html.trimEnd().endsWith("</html>")).toBe(true);
    expect(html).toContain("<style>");
    expect(html).toContain("<script>");
    expect(html).toContain("prefers-color-scheme: dark");
  });

  test("no src or href attribute points anywhere off this page", () => {
    const targets = attributeTargets(html);
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) expect(target).not.toMatch(/^https?:\/\//);
    expect(html).not.toMatch(/(?:src|href)="https?:\/\//);
    // Every anchor is an in-page one.
    for (const target of targets) expect(target.startsWith("#")).toBe(true);
  });

  test("it carries the model it will draw, and the renderer that draws it", () => {
    expect(html).toContain('<script type="application/json" id="model-data">');
    expect(html).toContain("function dashMain(");
    // The model rides as JSON, so the run is on the page as data, not as markup.
    const json = html.split('id="model-data">')[1]?.split("</script>")[0] ?? "";
    const shipped = JSON.parse(json) as typeof model;
    expect(shipped).toEqual(JSON.parse(JSON.stringify(model)) as typeof model);
  });

  test("it is read-only: no form, no write path, and it does not watch", () => {
    expect(html).not.toContain("<form");
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("fetch(");
    expect(html).not.toContain("EventSource");
    expect(html).not.toContain("XMLHttpRequest");
    expect(html).not.toContain("localStorage");
    // Every button on the page copies text or filters the list. Nothing else.
    for (const [, attributes] of html.matchAll(/<button([^>]*)>/g)) {
      expect(attributes).toMatch(/data-(copy|filter|sort)=/);
    }
  });

  test("it is deterministic for the same inputs", () => {
    expect(renderDashboard(buildModel(VIEWS_FIXTURE, GENERATED_AT, { now: VIEWS_NOW }))).toBe(html);
  });
});

/**
 * What a reader actually sees.
 *
 * The document ships an empty `<main>` and fills it in the browser, so these
 * assertions run the page's own renderer over the same model rather than
 * grepping the file. `dashboard-render.test.ts` separately proves the serialised
 * copy of these functions renders byte-identically, so testing the typed ones
 * here tests what ships.
 */
describe("the views it draws", () => {
  const ui = { status: "all", sort: "updated" };
  const nowMs = VIEWS_NOW.getTime();
  const view = (name: string, id: string | null = null): string =>
    dashMain(model, ui, { view: name, id }, nowMs);
  const runs = view("runs");
  const detail = view("run", VIEWS_RUN);

  test("the runs list shows the run, its status, its progress and its spend", () => {
    expect(runs).toContain(VIEWS_RUN);
    expect(runs).toContain("Player scoreboard");
    expect(runs).toContain("awaiting gate");
    expect(runs).toContain("$5.01");
    expect(runs).toContain("$25.00");
    expect(runs).toContain("1/2 stages · 50%");
  });

  test("it names the one thing waiting on a human, and raises it as an alert", () => {
    expect(runs).toContain('<span class="alert__kind">gate</span>');
    expect(runs).toContain("stage how is waiting at a gate");
    expect(runs).toContain("waiting on a human");
    // Q2 is open, but in a phase that was already approved. The run is stopped
    // at the gate on 02-how, which is what `tldrx run status` says too.
    expect(runs).not.toContain('<span class="alert__kind">question</span>');
  });

  test("an open question the run actually stopped for reads as the question", () => {
    const asked = {
      ...model,
      runs: model.runs.map((run) => ({
        ...run,
        waiting: { kind: "answer", message: "1 open question(s)", questions: ["Q2"] },
        pendingGate: null,
        pendingQuestion: "Q2 · How far back does the scoreboard reach?",
      })),
    };
    const page = dashMain(asked, ui, { view: "runs", id: null }, nowMs);
    expect(page).toContain('<span class="alert__kind">question</span>');
    expect(page).toContain("Q2 · How far back does the scoreboard reach?");
    expect(page).not.toContain("stage how is waiting at a gate");
  });

  test("a run with nothing to sign says it is ready, with the command", () => {
    const ready = {
      ...model,
      runs: model.runs.map((run) => ({
        ...run,
        waiting: { kind: "ready", message: "next up: 01-what/what (pending)", questions: [] },
        pendingGate: null,
        pendingQuestion: null,
      })),
    };
    const page = dashMain(ready, ui, { view: "runs", id: null }, nowMs);
    expect(page).toContain(`ready — <code>tldrx next ${VIEWS_RUN}</code>`);
    // `ready` is a state of the work, not an ask: no alert card, no nav badge.
    expect(page).not.toContain('class="alert__kind"');
  });

  test("the run detail carries the execution path as a table", () => {
    expect(detail).toContain("<th>phase</th>");
    expect(detail).toContain('<td class="mono">how</td>');
    expect(detail).toContain("$2.61");
    expect(detail).toContain("$3.00");
    expect(detail).toContain("approve: pending");
    // The row waiting at a gate is marked, so the eye lands on it.
    expect(detail).toContain('<tr data-wait="1">');
  });

  test("the handoff is rendered through the markdown converter, inline and unescaped", () => {
    expect(detail).toContain("<h2>Findings</h2>");
    expect(detail).toContain("<li>Rankings are global rather than per tenant [src: Q1]</li>");
    // A stable panel id is what keeps an open handoff open across a re-render.
    expect(detail).toContain(`id="ho-${VIEWS_RUN}-01-what"`);
  });

  test("an external citation survives as visible text, not as a fetchable link", () => {
    expect(detail).toContain("https://developers.example.com/ranking");
    expect(detail).not.toContain('href="https://developers.example.com/ranking"');
  });

  test("open questions appear with their options and the command that answers them", () => {
    expect(detail).toContain('<span class="q__id">Q2</span>');
    expect(detail).toContain('<span class="opt__letter">B</span><span>Rolling 30 days</span>');
    expect(detail).toContain('tldrx answer Q2 "your answer"');
    expect(detail).toContain('<span class="q__id">Q3</span>');
    // Q1 is answered, so it is not in the open list.
    expect(detail).not.toContain('<span class="q__id">Q1</span>');
  });

  test("a run with no plan says so rather than showing an empty table", () => {
    expect(model.runs[0]!.plan).toBeNull();
    expect(detail).toContain("The Plan phase has not written stories yet");
  });

  test("experts show the computed level, the evidence behind it, and a safe train command", () => {
    const experts = view("experts");
    expect(experts).toContain("dotnet-stack");
    expect(experts).toContain("lab-ui");
    expect(experts).toContain("stores level 5, evidence computes 1");
    // The copied command prints the prompt; it never runs training.
    expect(experts).toContain("tldrx expert train lab-ui --area scoreboard-ui --mode light --print-prompt");
    expect(experts).toContain("1 evidence · newest 2026-08-30");
    // The stored level is named as stored, never shown as the level.
    expect(experts).toContain("stored 5 (not shown as level)");
  });

  test("the radar is drawn from the computed levels, and reads out in text", () => {
    const expert = {
      name: "wide", status: "in-use", lastTrained: null, warnings: [], error: null,
      areas: ["a", "b", "c"].map((id, index) => ({
        id, title: id, level: index, storedLevel: null,
        evidenceCount: 0, newestEvidence: null, trainPrompt: `tldrx expert train wide --area ${id}`,
      })),
    };
    const svg = dashRadar(expert, model.maxLevel);
    expect(svg).toContain("<svg class=\"radar\"");
    expect(svg).toContain("<polygon points=");
    expect(svg).toContain('aria-label="wide competency: a 0 of 5, b 1 of 5, c 2 of 5"');
  });

  test("watchers says what is missing instead of inventing a card", () => {
    const watchers = view("watchers");
    expect(watchers).toContain("No watchers in this model.");
    expect(watchers).toContain("has no <code>watchers</code> field yet");
  });

  test("the FAQ hands over the copy-paste loop", () => {
    const faq = view("faq");
    for (const command of ["tldrx run new", "tldrx next", "tldrx answer", "tldrx approve", "tldrx reject", "tldrx replay"]) {
      expect(faq).toContain(command);
    }
  });

  test("no workspace is a page that says so, not an empty one", () => {
    const missing = { ...model, workspaceFound: false };
    const page = dashMain(missing, ui, { view: "runs", id: null }, nowMs);
    expect(page).toContain("No workspace here");
    expect(page).toContain("tldrx init");
  });
});

describe("offlineHtml", () => {
  test("demotes an external anchor while keeping the URL readable", () => {
    expect(offlineHtml('<a href="https://x.test/a">docs</a>'))
      .toBe("<code>docs → https://x.test/a</code>");
    expect(offlineHtml('<a href="#runs">runs</a>')).toBe('<a href="#runs">runs</a>');
  });
});

describe("tldrx dashboard --static", () => {
  test("writes index.html and reports its size", async () => {
    const workspace = makeViewsWorkspace();
    try {
      const run = await tldrx("dashboard", "--static", "--root", workspace.root);
      expect(run.code).toBe(EXIT_OK);
      const path = join(workspace.root, ".tldrx", "cache", "dashboard", "index.html");
      const written = readFileSync(path, "utf8");
      expect(run.stdout).toContain(`wrote ${path}`);
      expect(written).toContain(VIEWS_RUN);
      expect(written).not.toMatch(/(?:src|href)="https?:\/\//);
    } finally {
      workspace.dispose();
    }
  });

  test("--out redirects the export", () => {
    const workspace = makeViewsWorkspace();
    try {
      const out = join(workspace.root, "snapshot");
      const written = writeStaticDashboard(workspace.root, out, GENERATED_AT, VIEWS_NOW);
      expect(written.path).toBe(join(out, "index.html"));
      expect(written.runs).toBe(1);
      expect(written.experts).toBe(2);
      expect(written.bytes).toBe(Buffer.byteLength(readFileSync(written.path, "utf8"), "utf8"));
    } finally {
      workspace.dispose();
    }
  });
});

function story(id: string, dependsOn: readonly string[] = []): string {
  return `---
version: 1
id: ${id}
epic: E1
title: "Materialise the leaderboard read model"
repo: lab
status: todo
depends_on: [${dependsOn.join(", ")}]
touches: ["src/features/leaderboard/"]
acceptance: ["Top-50 ranks render from the view"]
test_plan: ["Unit: rank ordering with ties"]
evidence: []
---

# ${id}

\`\`\`dod
npm test
\`\`\`
`;
}

const EPIC = `---
version: 1
id: E1
title: "Player leaderboard"
repos: [lab]
stories: [S1, S2]
branch: epic/leaderboard
status: todo
---

# E1
`;

const WAVES = `version: 1
waves:
  - {id: W1, stories: [S1]}
  - {id: W2, stories: [S2]}
`;
