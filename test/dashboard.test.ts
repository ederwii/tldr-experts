import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { collect, offlineHtml, renderDashboard, writeStaticDashboard } from "../src/core/dashboard/index.ts";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";
import { EXIT_NOT_IMPLEMENTED, EXIT_OK } from "../src/cli/exitCodes.ts";
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

const data = collect(VIEWS_FIXTURE, GENERATED_AT, VIEWS_NOW);
const html = renderDashboard(data);

/** Every `src="…"` / `href="…"` value in the document. */
function attributeTargets(document: string): readonly string[] {
  return [...document.matchAll(/(?:src|href)="([^"]*)"/g)].map((match) => match[1] ?? "");
}

describe("collect", () => {
  test("finds the run, its phases, its artefacts and the experts", () => {
    expect(data.runs).toHaveLength(1);
    const run = data.runs[0]!;
    expect(run.loaded.id).toBe(VIEWS_RUN);
    expect(run.stagesTotal).toBe(2);
    expect(run.stagesDone).toBe(1);
    expect(run.pendingGate).toBe("how");
    expect(run.pendingQuestion).toContain("Q2");
    expect(run.phases[0]!.handoff).toContain("## Findings");
    expect(run.phases[0]!.questions.map((block) => block.id)).toEqual(["Q2", "Q3"]);
    expect(data.experts.map((expert) => expert.name)).toEqual(["dotnet-stack", "lab-ui"]);
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

  test("it is read-only: no form controls that submit or act", () => {
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("fetch(");
  });

  test("it is deterministic for the same inputs", () => {
    expect(renderDashboard(collect(VIEWS_FIXTURE, GENERATED_AT, VIEWS_NOW))).toBe(html);
  });
});

describe("offlineHtml", () => {
  test("demotes an external anchor while keeping the URL readable", () => {
    expect(offlineHtml('<a href="https://x.test/a">docs</a>'))
      .toBe("<code>docs → https://x.test/a</code>");
    expect(offlineHtml('<a href="#runs">runs</a>')).toBe('<a href="#runs">runs</a>');
  });
});

describe("tldrx dashboard", () => {
  test("--static writes index.html and reports its size", async () => {
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

  test("without --static it stays a stub and says the live server is v1", async () => {
    const run = await tldrx("dashboard");
    expect(run.code).toBe(EXIT_NOT_IMPLEMENTED);
    expect(run.stderr).toContain("live server is v1");
    expect(run.stdout).toBe("");
  });
});
