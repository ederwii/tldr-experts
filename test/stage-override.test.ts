/**
 * gh #39 — a project `.tldrx/stages/<stage>/` that supplies ONLY `stage.yml`.
 *
 * Measured on the 260829-scoring-leaderboard driver session (2026-08-31): the
 * operator created `.tldrx/stages/plan/stage.yml` to trim `knowledge_max_bytes`,
 * and creating that directory made the framework resolve `stage.md` out of it
 * too — where there was none. The context ledger read **stage 1 B** where it had
 * been 4.9 KB: the sub-agent would have been handed the inputs, the experts and
 * the rejection note, and ZERO stage instructions. Nothing refused. It was caught
 * only because the operator read the prepare ledger line by line.
 *
 * The fix the issue argues for, taken in full: `stage.md` resolves per FILE, not
 * per directory — an override that supplies only `stage.yml` inherits the
 * packaged body — and the residual case the issue calls "the worst of the three",
 * an empty body, is a named refusal rather than a silent substitution.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STAGES_DIR } from "../src/core/paths.ts";
import { stageMdPath, StageBodyError, stagePath } from "../src/core/run/workflowPreset.ts";
import { runNext } from "../src/core/facilitator/runNext.ts";
import { makeFacilitatorWorkspace, type FacilitatorWorkspace } from "./fixtures/facilitator/workspace.ts";

const ORIGINAL_PATH = process.env.PATH ?? "";
let roots: string[] = [];
let open: FacilitatorWorkspace[] = [];

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  delete process.env.FAKE_CLAUDE_RUNDIR;
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  for (const ws of open) ws.dispose();
  roots = [];
  open = [];
});

/** A workspace holding `.tldrx/stages/<id>/` with exactly the files named. */
function overrideDir(id: string, files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "tldrx-stage-override-"));
  roots.push(root);
  const dir = join(root, ".tldrx", "stages", id);
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body, "utf8");
  return root;
}

describe("stage.md resolves per file, not per directory (#39)", () => {
  test("an override with only stage.yml INHERITS the packaged stage.md", () => {
    const root = overrideDir("plan", { "stage.yml": "version: 1\nid: plan\n" });
    const source = stagePath(root, "plan");

    expect(source).toBe(join(root, ".tldrx", "stages", "plan", "stage.yml"));
    expect(stageMdPath("plan", source as string)).toBe(join(STAGES_DIR, "plan", "stage.md"));
  });

  test("an override that ships its OWN stage.md still wins", () => {
    const root = overrideDir("plan", { "stage.yml": "version: 1\nid: plan\n", "stage.md": "# mine\n" });
    const source = stagePath(root, "plan") as string;

    expect(stageMdPath("plan", source)).toBe(join(root, ".tldrx", "stages", "plan", "stage.md"));
  });

  test("with no override at all the packaged pair is used, exactly as before", () => {
    const root = mkdtempSync(join(tmpdir(), "tldrx-stage-override-"));
    roots.push(root);
    const source = stagePath(root, "how") as string;

    expect(source).toBe(join(STAGES_DIR, "how", "stage.yml"));
    expect(stageMdPath("how", source)).toBe(join(STAGES_DIR, "how", "stage.md"));
  });

  test("a stage with NO stage.md anywhere refuses by name, and names both places it looked", () => {
    const root = overrideDir("invented", { "stage.yml": "version: 1\nid: invented\n" });
    const source = stagePath(root, "invented") as string;

    expect(() => stageMdPath("invented", source)).toThrow(StageBodyError);
    let message = "";
    try {
      stageMdPath("invented", source);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("invented");
    expect(message).toContain(join(root, ".tldrx", "stages", "invented", "stage.md"));
    expect(message).toContain(join(STAGES_DIR, "invented", "stage.md"));
  });
});

describe("the prompt a prepare actually writes (#39)", () => {
  test("an override with only stage.yml still carries the packaged stage body", async () => {
    const ws = makeFacilitatorWorkspace({
      scope: "demo",
      budgetUsd: 10,
      stages: [{ id: "what", phase: "01-what", budgetUsd: 6, gate: "auto", outputs: [{ path: "01-what/intent.md" }] }],
    });
    open.push(ws);
    // Exactly the operator's move: keep the tuned stage.yml, drop the body.
    unlinkSync(join(ws.root, ".tldrx", "stages", "what", "stage.md"));
    expect(existsSync(join(ws.root, ".tldrx", "stages", "what", "stage.md"))).toBe(false);

    process.env.PATH = ws.binDir;
    process.env.FAKE_CLAUDE_RUNDIR = ws.runDir;
    const prepared = await runNext({
      root: ws.root, dryRun: false, mode: "prepare", yolo: false,
      actor: "alan", at: "2026-08-28T09:00:00Z",
    });

    expect(prepared.code).toBe(0);
    const prompt = readFileSync(join(ws.runDir, ".agent", "what", "prompt.md"), "utf8");
    // The packaged `stages/what/stage.md`, inherited — not a 1-byte body.
    expect(prompt).toContain("Stage template: what (phase 1)");
    expect(prompt.length).toBeGreaterThan(1000);
  }, 60_000);
});
