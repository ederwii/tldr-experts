import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildModel, offlineHtml, renderDashboard, writeStaticDashboard,
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
      "root",
      "runs[].ceilingUsd",
      "runs[].cursor",
      "runs[].filter",
      "runs[].id",
      "runs[].path[].budgetUsd",
      "runs[].path[].costUsd",
      "runs[].path[].expert",
      "runs[].path[].gate",
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
      "runs[].scope",
      "runs[].spentUsd",
      "runs[].stagesDone",
      "runs[].stagesTotal",
      "runs[].status",
      "runs[].title",
      "runs[].updatedAt",
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
    expect(run.pendingGate).toBe("how");
    expect(run.pendingQuestion).toContain("Q2");
    expect(run.path.map((stage) => `${stage.phase}/${stage.id}`)).toEqual(["01-what/what", "02-how/how"]);
    expect(run.phases[0]!.handoffHtml).toContain("<h2>Findings</h2>");
    expect(run.phases[0]!.questions.map((question) => question.id)).toEqual(["Q2", "Q3"]);
    expect(model.experts.map((expert) => expert.name)).toEqual(["dotnet-stack", "lab-ui"]);
    expect(model.workspaceFound).toBe(true);
    expect(model.live).toBe(false);
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

      const page = renderDashboard(built);
      expect(page).toContain("Plan (03-plan)");
      expect(page).toContain("<th>depends on</th>");
      expect(page).toContain("branch <code>epic/leaderboard</code>");
    } finally {
      workspace.dispose();
    }
  });

  test("a workspace with no .tldrx/ says so instead of looking empty", () => {
    const empty = buildModel(join(FRAMEWORK_ROOT, "test", "fixtures"), GENERATED_AT, { now: VIEWS_NOW });
    expect(empty.workspaceFound).toBe(false);
    const page = renderDashboard(empty);
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

  test("shows the run id, its status, its progress and what it is waiting on", () => {
    expect(html).toContain(VIEWS_RUN);
    expect(html).toContain("Player scoreboard");
    expect(html).toContain("awaiting_gate");
    expect(html).toContain("$5.01");
    expect(html).toContain("$25.00");
    expect(html).toContain("gate pending: how");
    expect(html).toContain("1 of 2 stages terminal (50%)");
  });

  test("the run detail carries the execution path as a table", () => {
    expect(html).toContain("<th>phase</th>");
    expect(html).toContain("<td><code>01-what</code></td>");
    expect(html).toContain("<td>$2.61 / $3.00</td>");
    expect(html).toContain("approve: pending");
  });

  test("the handoff is rendered through the markdown converter", () => {
    expect(html).toContain("<h2>Findings</h2>");
    expect(html).toContain("<li>Rankings are global rather than per tenant [src: Q1]</li>");
  });

  test("an external citation survives as visible text, not as a fetchable link", () => {
    expect(html).toContain("https://developers.example.com/ranking");
    expect(html).not.toContain('href="https://developers.example.com/ranking"');
  });

  test("open questions appear with their options and the command that answers them", () => {
    expect(html).toContain("Open question Q2");
    expect(html).toContain("<strong>B)</strong> Rolling 30 days");
    expect(html).toContain('tldrx answer Q2 "your answer"');
    // Q1 is answered, so it is not in the open list.
    expect(html).not.toContain("Open question Q1");
  });

  test("experts show status, an inline SVG chart and the train prompts", () => {
    expect(html).toContain("dotnet-stack");
    expect(html).toContain("lab-ui");
    expect(html).toContain("<svg viewBox=");
    expect(html).toContain("<polygon points=");
    expect(html).toContain("tldrx expert train lab-ui --area scoreboard-ui --mode light --print-prompt");
    expect(html).toContain("stores level 5, evidence computes 1");
  });

  test("the FAQ hands over the copy-paste loop", () => {
    for (const command of ["tldrx run new", "tldrx next", "tldrx answer", "tldrx approve", "tldrx reject", "tldrx replay"]) {
      expect(html).toContain(command);
    }
  });

  test("it is read-only: no form controls that submit or act, and it does not watch", () => {
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("fetch(");
    expect(html).not.toContain("EventSource");
  });

  test("it is deterministic for the same inputs", () => {
    expect(renderDashboard(buildModel(VIEWS_FIXTURE, GENERATED_AT, { now: VIEWS_NOW }))).toBe(html);
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
