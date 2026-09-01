/**
 * Auto-gate condition 7 — `boundary` (spec §5; design §A.4).
 *
 * Two halves, tested at two levels. The SURFACE is derivation over files, so it
 * is tested directly: what the What cited, what the plan declared, and what the
 * state filter drops. The MEASUREMENT is a real `git diff` over a real epic
 * branch, so it is tested end to end through the real Build executor against the
 * real fixture repo — the branch is cut, the story is merged, and the diff is the
 * diff. Only the sub-agents are faked, and `FAKE_BUILD_WRITE` is what lets a test
 * decide exactly which paths land on the branch.
 *
 * The failure this guards against is the one the host hit on 2026-08-30: it
 * audited "did the stage touch anything nobody scoped" BY HAND at every gate,
 * because nothing in the framework asked.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runNext, type NextOptions } from "../src/core/facilitator/runNext.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { approve } from "../src/core/run/gates.ts";
import { evaluateBoundary, deriveSurface, epicTargets, inSurface, normalisePath, unqualifiedCitedPaths, OUTSIDE_SURFACE } from "../src/core/run/boundary.ts";
import { loadWorkspace } from "../src/hooks/lib/workspace.ts";
import { makeBuildWorkspace, type BuildWorkspace, type BuildWorkspaceOptions } from "./fixtures/build/workspace.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

// Every test in this file spawns a REAL process — git, `bun`, the CLI. Process cost is a
// property of the machine, not of the code, so bun's fixed 5000 ms default measures the box:
// on an untouched tree, tests here timed out while the same files passed alone (#43). The
// budget scales with measured load; the assertions are untouched, and a hang is still caught.
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

function workspace(options: BuildWorkspaceOptions): BuildWorkspace {
  const made = makeBuildWorkspace(options);
  open.push(made);
  process.env.PATH = made.binDir;
  process.env.FAKE_BUILD_STATE = made.statePath;
  return made;
}

function next(
  ws: BuildWorkspace,
  overrides: Partial<NextOptions> = {},
): Promise<{ code: number; lines: readonly string[] }> {
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

function write(ws: BuildWorkspace, rel: string, text: string): void {
  const path = join(ws.runDir, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text, "utf8");
}

/** A run whose one story declares `src/in.ts` and nothing else. */
const DECLARED: BuildWorkspaceOptions = {
  stories: [{ id: "S1", epic: "E1", title: "Inside the surface", touches: ["src/in.ts"] }],
  epics: [{ id: "E1", stories: ["S1"], branch: "epic/e1" }],
  waves: [["S1"]],
  gates: "none",
  repoFiles: { "src/in.ts": "export const before = 1;\n" },
};

// ---------------------------------------------------------------------------
// The surface
// ---------------------------------------------------------------------------

describe("the surface a run declares", () => {
  test("it is the union of the What's citations and the plan's `touches:`", () => {
    const ws = workspace({
      ...DECLARED,
      stories: [{ id: "S1", epic: "E1", title: "S1", touches: ["src/declared.ts", "docs/"] }],
      repoFiles: { "src/cited.ts": "// cited\n", "src/declared.ts": "// declared\n" },
    });
    write(ws, "01-what/handoff.md", [
      "## Decisions",
      "- the handler is here [src: app:src/cited.ts:1]",
      "- and this one names no repo [src: src/bare.ts:3]",
      "",
    ].join("\n"));

    const surface = deriveSurface(ws.runDir, loadWorkspace(ws.root));

    // The citation half: repo-qualified where the token said so.
    expect(surface.byRepo.get("app")).toContain("src/cited.ts");
    // The `touches:` half, with the trailing slash normalised off.
    expect(surface.byRepo.get("app")).toContain("src/declared.ts");
    expect(surface.byRepo.get("app")).toContain("docs");
    // A bare path widens EVERY repo rather than shrinking the surface to nothing.
    expect(surface.unqualified).toEqual(["src/bare.ts"]);
    expect(surface.cited).toBe(2);
    expect(surface.declared).toBe(2);
  });

  test("`02-how/handoff.md` counts too, not just the What's", () => {
    const ws = workspace({ ...DECLARED, repoFiles: { "src/how.ts": "// how\n" } });
    write(ws, "02-how/handoff.md", "## Decisions\n- the contract [src: app:src/how.ts:1]\n");

    const surface = deriveSurface(ws.runDir, loadWorkspace(ws.root));

    expect(surface.byRepo.get("app")).toContain("src/how.ts");
  });

  test("it reads `04-build/implicit-plan.yml` when the scope skipped Plan", () => {
    const ws = workspace({ ...DECLARED, plan: false, skips: ["plan"] });
    write(ws, "04-build/implicit-plan.yml", [
      "version: 1",
      "implicit: true",
      "status: todo",
      "epic:",
      "  id: E1",
      "  branch: epic/implicit",
      "  repos: [app]",
      "story:",
      "  id: S1",
      "  repo: app",
      "  touches:",
      '    - "src/implicit.ts"',
      "",
    ].join("\n"));

    const surface = deriveSurface(ws.runDir, loadWorkspace(ws.root));

    expect(surface.byRepo.get("app")).toEqual(["src/implicit.ts"]);
    expect(surface.declared).toBe(1);
    // and the epic it names is what would be diffed
    expect(epicTargets(ws.runDir, loadWorkspace(ws.root))).toMatchObject([
      { epic: "E1", repo: "app", branch: "epic/implicit", base: "main" },
    ]);
  });

  test("a real `03-plan/` wins over an implicit plan left beside it", () => {
    const ws = workspace(DECLARED);
    write(ws, "04-build/implicit-plan.yml", "story:\n  repo: app\n  touches:\n    - \"src/stale.ts\"\n");

    const surface = deriveSurface(ws.runDir, loadWorkspace(ws.root));

    expect(surface.byRepo.get("app")).toEqual(["src/in.ts"]);
    expect(surface.byRepo.get("app")).not.toContain("src/stale.ts");
  });

  /**
   * A handoff cites the run's own state as EVIDENCE — measured 13 touched paths
   * on the aparece run of 2026-08-30, three of them `run.yml`, a `.tldrx/`
   * split file and a `.agent/` prompt. None of those is a boundary question.
   */
  test("tldrx's own state never reaches the surface, from either source", () => {
    const ws = workspace({
      ...DECLARED,
      stories: [{ id: "S1", epic: "E1", title: "S1", touches: ["src/in.ts", ".tldrx/workspace.yml"] }],
    });
    write(ws, "01-what/handoff.md", [
      "## Decisions",
      "- the run said so [src: app:tldrx-work/260830-x/run.yml:1]",
      "- the bundle [src: .agent/build/prompt.md:1]",
      "",
    ].join("\n"));

    const surface = deriveSurface(ws.runDir, loadWorkspace(ws.root));

    expect(surface.byRepo.get("app")).toEqual(["src/in.ts"]);
    expect(surface.unqualified).toEqual([]);
    expect(surface.excluded).toContain(".tldrx/workspace.yml");
    expect(surface.excluded).toContain(".agent/build/prompt.md");
  });

  test("a directory entry covers everything beneath it, and nothing beside it", () => {
    expect(inSurface("src/features/tenancy/Otp.cs", ["src/features/tenancy/"])).toBe(true);
    expect(inSurface("src/features/tenancy/Otp.cs", ["src/features/tenancy"])).toBe(true);
    expect(inSurface("src/features/tenancy", ["src/features/tenancy"])).toBe(true);
    // the trap a naive prefix test falls into
    expect(inSurface("src/foobar.ts", ["src/foo"])).toBe(false);
    expect(inSurface("src/other.ts", ["src/in.ts"])).toBe(false);
  });

  test("paths are compared in one shape — no `./`, no trailing slash", () => {
    expect(normalisePath("./src/a/")).toBe("src/a");
    expect(inSurface("./src/a/b.ts", ["src/a/"])).toBe(true);
  });

  test("a bare citation is found only when the token really names no repo", () => {
    const repos = new Set(["app"]);
    expect(unqualifiedCitedPaths("- x [src: src/bare.ts:1]", repos)).toEqual(["src/bare.ts"]);
    expect(unqualifiedCitedPaths("- x [src: app:src/q.ts:1]", repos)).toEqual([]);
    // an `absent:` is not a `file:` — a path nothing has written yet is declared
    // through `touches:`, which is where a plan says what it will create.
    expect(unqualifiedCitedPaths("- x [src: absent:src/new.ts]", repos)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The honest n/a
// ---------------------------------------------------------------------------

describe("the boundary condition abstains rather than guessing", () => {
  test("outside Build there is no epic branch, so it is n/a", async () => {
    const ws = workspace(DECLARED);
    const verdict = await evaluateBoundary({ root: ws.root, runDir: ws.runDir, phaseId: "01-what" });
    expect(verdict).toEqual({ ok: true, detail: "n/a (not a build stage)" });
  });

  test("a plan whose epic branch was never cut is n/a, and says which ref", async () => {
    const ws = workspace(DECLARED);
    write(ws, "01-what/handoff.md", "## Decisions\n- a [src: app:src/in.ts:1]\n");

    const verdict = await evaluateBoundary({ root: ws.root, runDir: ws.runDir, phaseId: "04-build" });

    expect(verdict.ok).toBe(true);
    expect(verdict.detail).toContain("n/a (nothing could be diffed");
    expect(verdict.detail).toContain("`epic/e1` does not resolve in app");
  });

  test("a run that declared no surface at all is n/a, not a blanket refusal", async () => {
    const ws = workspace({
      ...DECLARED,
      stories: [{ id: "S1", epic: "E1", title: "S1", touches: [] }],
    });
    const verdict = await evaluateBoundary({ root: ws.root, runDir: ws.runDir, phaseId: "04-build" });
    expect(verdict.ok).toBe(true);
    expect(verdict.detail).toContain("the run declares no surface");
  });

  test("no plan at all is n/a", async () => {
    const ws = workspace({ ...DECLARED, plan: false, skips: ["plan"] });
    const verdict = await evaluateBoundary({ root: ws.root, runDir: ws.runDir, phaseId: "04-build" });
    expect(verdict).toEqual({ ok: true, detail: "n/a (no plan naming an epic branch)" });
  });
});

// ---------------------------------------------------------------------------
// The measurement, end to end
// ---------------------------------------------------------------------------

describe("the boundary condition against a real epic branch", () => {
  test("work inside the surface signs the gate, and the note counts it", async () => {
    const ws = workspace(DECLARED);
    process.env.FAKE_BUILD_WRITE = JSON.stringify({ S1: { "src/in.ts": "export const after = 2;\n" } });

    const outcome = await next(ws);

    const said = outcome.lines.join("\n");
    expect(said).toContain("auto-approved");
    expect(said).toContain("boundary=1 changed path(s), 0 outside the surface (app main...epic/e1)");
    expect(RunStore.open(ws.runDir).run.phases.flatMap((p) => p.stages)[0]?.gate.by).toBe("auto");
  }, 60_000);

  test("a path nobody scoped refuses the gate and is NAMED", async () => {
    const ws = workspace(DECLARED);
    process.env.FAKE_BUILD_WRITE = JSON.stringify({
      S1: { "src/in.ts": "export const after = 2;\n", "platform/Auth.cs": "// nobody scoped this\n" },
    });

    const outcome = await next(ws);

    expect(outcome.code).toBe(4);
    const said = outcome.lines.join("\n");
    expect(said).toContain("auto gate not taken");
    // the paths, not a count — "1 path outside the surface" is not actionable
    expect(said).toContain("1 outside the surface: app:platform/Auth.cs");
    expect(said).toContain(OUTSIDE_SURFACE);
    // and the gate is still open for the person the decision belongs to
    expect(RunStore.open(ws.runDir).run.phases.flatMap((p) => p.stages)[0]?.gate.status).toBe("pending");
  }, 60_000);

  test("a human may still approve over a boundary refusal — it is their call", async () => {
    const ws = workspace(DECLARED);
    process.env.FAKE_BUILD_WRITE = JSON.stringify({
      S1: { "src/in.ts": "export const after = 2;\n", "platform/Auth.cs": "// nobody scoped this\n" },
    });
    expect((await next(ws)).code).toBe(4);

    const signed = await approve(RunStore.open(ws.runDir), {
      root: ws.root,
      actor: "alan",
      at: "2026-08-29T10:05:00Z",
      note: "widening the scope on purpose: Platform needed the same change",
    });

    expect(signed.ok).toBe(true);
    const stage = RunStore.open(ws.runDir).run.phases.flatMap((p) => p.stages)[0];
    expect(stage?.gate.status).toBe("approved");
    expect(stage?.gate.by).toBe("alan");
  }, 60_000);

  /**
   * The diff side of the state filter. In the multi-repo shape `tldrx-work/` is
   * at the workspace root, so a file the developer happens to write at that path
   * INSIDE the repo is committed like any other — and must still never read as a
   * boundary exit. State is never a boundary question, wherever it sits.
   */
  test("a state-shaped path on the branch is not counted as outside the surface", async () => {
    const ws = workspace(DECLARED);
    process.env.FAKE_BUILD_WRITE = JSON.stringify({
      S1: { "src/in.ts": "export const after = 2;\n", "tldrx-work/260830-x/scratch.md": "# scratch\n" },
    });

    const outcome = await next(ws);

    const said = outcome.lines.join("\n");
    expect(said).toContain("auto-approved");
    expect(said).toContain("boundary=1 changed path(s), 0 outside the surface");
    expect(said).not.toContain("scratch.md");
    // it really did land on the branch — the filter is what excused it, not an
    // empty diff
    expect(existsSync(join(ws.repoDir, "src", "in.ts"))).toBe(true);
  }, 60_000);

  test("a path the What cited but no story declared is still inside the surface", async () => {
    // committed at `git init`, so the tree Build meets is clean
    const ws = workspace({
      ...DECLARED,
      repoFiles: { "src/in.ts": "export const before = 1;\n", "src/cited.ts": "// cited\n" },
    });
    write(ws, "01-what/handoff.md", "## Decisions\n- the other one too [src: app:src/cited.ts:1]\n");
    process.env.FAKE_BUILD_WRITE = JSON.stringify({
      S1: { "src/in.ts": "export const after = 2;\n", "src/cited.ts": "// changed\n" },
    });

    const outcome = await next(ws);

    const said = outcome.lines.join("\n");
    expect(said).toContain("boundary=2 changed path(s), 0 outside the surface");
  }, 60_000);
});
