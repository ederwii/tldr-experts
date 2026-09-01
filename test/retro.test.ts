import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadRun } from "../src/core/replay/index.ts";
import { applyPractices, buildRetro, practicesPath, RETRO_SECTIONS } from "../src/core/retro/index.ts";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";
import { EXIT_NOT_FOUND, EXIT_OK } from "../src/cli/exitCodes.ts";
import { makeViewsWorkspace, VIEWS_FIXTURE, VIEWS_RUN } from "./fixtures/views/tempViews.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

// Every test in this file spawns a REAL process — git, `bun`, the CLI. Process cost is a
// property of the machine, not of the code, so bun's fixed 5000 ms default measures the box:
// on an untouched tree, tests here timed out while the same files passed alone (#43). The
// budget scales with measured load; the assertions are untouched, and a hang is still caught.
setDefaultTimeout(spawnTestTimeout());

const BIN = join(FRAMEWORK_ROOT, "bin", "tldrx.ts");

async function tldrx(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", BIN, ...args], { stdout: "pipe", stderr: "pipe", cwd: FRAMEWORK_ROOT });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

const report = buildRetro(loadRun(VIEWS_FIXTURE, VIEWS_RUN)!);

/** The `- ` lines under one H2 of the retro. */
function bulletsUnder(markdown: string, heading: string): readonly string[] {
  const start = markdown.indexOf(`## ${heading}`);
  expect(start).toBeGreaterThan(-1);
  const rest = markdown.slice(start + heading.length);
  const end = rest.indexOf("\n## ");
  return (end === -1 ? rest : rest.slice(0, end))
    .split("\n")
    .filter((line) => line.startsWith("- "));
}

describe("retro.md", () => {
  test("has the three sections, in order", () => {
    let cursor = -1;
    for (const heading of RETRO_SECTIONS) {
      const at = report.markdown.indexOf(`## ${heading}`);
      expect(at).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  test("facts to remember are the facts whose source.run is this run", () => {
    expect(report.facts.map((fact) => fact.id)).toEqual(["F021"]);
    const bullets = bulletsUnder(report.markdown, RETRO_SECTIONS[0]);
    expect(bullets).toHaveLength(1);
    expect(bullets[0]).toContain("F021");
    expect(bullets[0]).toContain("[src: F021]");
    // F007 came from another run and must not be claimed by this one.
    expect(report.markdown).not.toContain("F007");
  });

  test("all five heuristics fire on the fixture", () => {
    const bullets = bulletsUnder(report.markdown, RETRO_SECTIONS[1]);
    expect(bullets).toHaveLength(5);
    const joined = bullets.join("\n");
    expect(joined).toContain("was rejected 1 time at its gate");
    expect(joined).toContain("cost $1.60 against a $1.00 ceiling");
    expect(joined).toContain("asked 3 questions against a cap of 2");
    expect(joined).toContain("Check `claim-sources` failed");
    expect(joined).toContain("The budget warned");
  });

  test("every practice bullet ends in an events.jsonl source token", () => {
    for (const bullet of bulletsUnder(report.markdown, RETRO_SECTIONS[1])) {
      expect(bullet).toMatch(new RegExp(`\\[src: tldrx-work/${VIEWS_RUN}/events\\.jsonl:\\d+\\]$`));
    }
  });

  test("proposed stages come only from a `propose stage:` rejection note", () => {
    const bullets = bulletsUnder(report.markdown, RETRO_SECTIONS[2]);
    expect(bullets).toHaveLength(1);
    expect(bullets[0]).toContain("`success-metrics-review`");
    expect(bullets[0]).toMatch(/\[src: .*events\.jsonl:12\]$/);
  });

  test("with no such note the section says `none proposed`", () => {
    const loaded = loadRun(VIEWS_FIXTURE, VIEWS_RUN)!;
    const withoutNotes = {
      ...loaded,
      events: loaded.events.filter((item) => item.event.type !== "gate.rejected"),
    };
    expect(buildRetro(withoutNotes).markdown).toContain("## Proposed stages\n\nnone proposed");
  });

  test("it is deterministic", () => {
    expect(buildRetro(loadRun(VIEWS_FIXTURE, VIEWS_RUN)!).markdown).toBe(report.markdown);
  });
});

describe("tldrx retro", () => {
  test("writes retro.md and, without --apply, touches nothing else", async () => {
    const workspace = makeViewsWorkspace();
    try {
      const practices = readFileSync(practicesPath(workspace.root), "utf8");
      const run = await tldrx("retro", VIEWS_RUN, "--root", workspace.root);
      expect(run.code).toBe(EXIT_OK);

      const written = readFileSync(join(workspace.runDir, "retro.md"), "utf8");
      expect(written).toBe(report.markdown);
      expect(readFileSync(practicesPath(workspace.root), "utf8")).toBe(practices);
    } finally {
      workspace.dispose();
    }
  });

  test("--apply appends once and is idempotent on re-run", async () => {
    const workspace = makeViewsWorkspace();
    try {
      const before = readFileSync(practicesPath(workspace.root), "utf8");

      const first = await tldrx("retro", VIEWS_RUN, "--apply", "--root", workspace.root);
      expect(first.code).toBe(EXIT_OK);
      const after = readFileSync(practicesPath(workspace.root), "utf8");
      expect(after.startsWith(before)).toBe(true);
      expect(after).toContain(`— run ${VIEWS_RUN}`);
      expect(occurrences(after, "was rejected 1 time at its gate")).toBe(1);
      // The block that was already there survives.
      expect(after).toContain("run 260814-envs");

      const second = await tldrx("retro", VIEWS_RUN, "--apply", "--root", workspace.root);
      expect(second.code).toBe(EXIT_OK);
      expect(second.stdout).toContain("practices.md unchanged");
      expect(readFileSync(practicesPath(workspace.root), "utf8")).toBe(after);
    } finally {
      workspace.dispose();
    }
  });

  test("--apply creates practices.md when the workspace has none", () => {
    const workspace = makeViewsWorkspace();
    try {
      const path = practicesPath(workspace.root);
      rmSync(path);
      expect(existsSync(path)).toBe(false);

      const applied = applyPractices(workspace.root, VIEWS_RUN, report.practices, new Date("2026-09-02T00:00:00Z"));
      expect(applied.appended).toBe(true);
      const text = readFileSync(path, "utf8");
      expect(text).toContain("# Practices");
      expect(text).toContain(`## 2026-09-02 — run ${VIEWS_RUN}`);
    } finally {
      workspace.dispose();
    }
  });

  test("exits 3 when the run does not exist, and writes nothing", async () => {
    const workspace = makeViewsWorkspace();
    try {
      const run = await tldrx("retro", "260101-nope", "--root", workspace.root);
      expect(run.code).toBe(EXIT_NOT_FOUND);
      expect(run.stdout).toBe("");
      expect(existsSync(join(workspace.root, "tldrx-work", "260101-nope"))).toBe(false);
    } finally {
      workspace.dispose();
    }
  });
});

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}
