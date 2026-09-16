/**
 * The seed's own explicit technical-solution marker (gh #346).
 *
 * Unit-level: a synthetic `RunFile` (only `phases[0].stages[0].inputs` and
 * `repos` matter to these functions) plus real files on a temp workspace root,
 * exercised through the same `resolveDeclared` fallback the facilitator uses —
 * no run needs to exist on disk for any of this.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractSeedSolution, hasDeclaredSeedSolution, materializeSeedSolution, seedDocumentPaths,
  SEED_SOLUTION_HEADING_RE,
} from "../src/core/facilitator/seedSolution.ts";
import { evaluateSkipIf, SkipIfError, countSkipInputs } from "../src/core/facilitator/skipIf.ts";
import type { RunFile } from "../src/core/run/RunFile.ts";

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "tldrx-seed-solution-"));
  dirs.push(dir);
  return dir;
}

/** A minimal RunFile — only what `seedSolution.ts` and `countSkipInputs` read. */
function fakeRun(firstStageInputs: readonly string[], repos: readonly string[] = ["api"]): RunFile {
  const firstPhase = {
    id: "01-what",
    status: "pending",
    stages: [{
      id: "what", status: "pending", expert: null, model: null, budget_usd: 1, cost_usd: 0,
      started_at: null, ended_at: null, inputs: [...firstStageInputs], outputs: [],
      gate: { type: "approve", status: "open", by: null, at: null, note: "" }, tasks: [],
    }],
  };
  return {
    version: 1, run: "run", title: "t", scope: "feature", workflow: "feature", repos: [...repos],
    created_at: "2026-09-16T00:00:00Z", updated_at: "2026-09-16T00:00:00Z", status: "in_progress",
    cursor: { phase: "01-what", stage: "what", task: null },
    budget: { ceiling_usd: 10, spent_usd: 0, per_agent_max_usd: 10 },
    phases: [firstPhase],
  } as unknown as RunFile;
}

describe("the seed_solution grammar", () => {
  test("evaluateSkipIf accepts seed_solution alongside the original three", () => {
    const counts = { stories: 0, repos: 0, questions: 0, seed_solution: 1 };
    expect(evaluateSkipIf("seed_solution==1", counts)).toBe(true);
    expect(evaluateSkipIf("seed_solution==0", counts)).toBe(false);
  });

  test("a counts object with no seed_solution key still type-checks and reads as 0", () => {
    const counts = { stories: 3, repos: 2, questions: 0 };
    expect(evaluateSkipIf("stories<=1", counts)).toBe(false);
    expect(evaluateSkipIf("seed_solution==0", counts)).toBe(true);
    expect(() => evaluateSkipIf("stories<=one", counts)).toThrow(SkipIfError);
  });
});

describe("seedDocumentPaths", () => {
  test("drops the what stage's own template inputs and phase-folder-relative entries, keeps the rest", () => {
    const run = fakeRun([
      ".tldrx/memory/facts.yml", ".tldrx/map/api/domains.md",
      "01-what/seed-index.md", "requirements.md", "docs/adr/0001.md",
    ]);
    expect(seedDocumentPaths(run)).toEqual(["requirements.md", "docs/adr/0001.md"]);
  });

  test("an unseeded run (no first stage) has no seed documents", () => {
    const run = { ...fakeRun([]), phases: [] } as unknown as RunFile;
    expect(seedDocumentPaths(run)).toEqual([]);
  });

  // gh #358: a seed under `.tldrx/seeds/` — where `run new --seed` and the docs
  // put it — was dropped by the old blanket `.tldrx/`-prefix filter alongside the
  // `what` stage's own template inputs. Only those two template families
  // (`.tldrx/memory/`, `.tldrx/map/`) are excluded; a `.tldrx/seeds/` entry is a
  // seed document like any other.
  test("keeps a seed document under .tldrx/seeds/ while still dropping the what stage's own template inputs", () => {
    const run = fakeRun([
      ".tldrx/memory/facts.yml", ".tldrx/map/api/domains.md",
      "01-what/seed-index.md", ".tldrx/seeds/payments.md",
    ]);
    expect(seedDocumentPaths(run)).toEqual([".tldrx/seeds/payments.md"]);
  });
});

describe("SEED_SOLUTION_HEADING_RE", () => {
  test("matches the two named spellings, whole, case-insensitively", () => {
    expect(SEED_SOLUTION_HEADING_RE.test("Solution")).toBe(true);
    expect(SEED_SOLUTION_HEADING_RE.test("solution")).toBe(true);
    expect(SEED_SOLUTION_HEADING_RE.test("Technical approach")).toBe(true);
    expect(SEED_SOLUTION_HEADING_RE.test("Solution and rollout")).toBe(false);
    expect(SEED_SOLUTION_HEADING_RE.test("A Solution")).toBe(false);
  });
});

describe("hasDeclaredSeedSolution / extractSeedSolution", () => {
  test("true and extractable when a seed document has the H2 marker", () => {
    const root = tempRoot();
    writeFileSync(
      join(root, "requirements.md"),
      ["# Payments", "", "## Solution", "", "Use the existing gateway. [src: requirements.md:5]", "", "## Rollout", "", "Behind a flag."].join("\n"),
      "utf8",
    );
    const runDir = join(root, "tldrx-work", "260916-demo");
    mkdirSync(runDir, { recursive: true });
    const run = fakeRun(["requirements.md"]);

    expect(hasDeclaredSeedSolution(runDir, run)).toBe(true);
    const section = extractSeedSolution(runDir, run);
    expect(section?.srcPath).toBe("requirements.md");
    expect(section?.srcLine).toBe(3);
    expect(section?.text).toContain("Use the existing gateway.");
    expect(section?.text).not.toContain("Rollout");
  });

  test("false when the seed has no such heading — never inferred from prose", () => {
    const root = tempRoot();
    writeFileSync(
      join(root, "requirements.md"),
      ["# Payments", "", "We will probably solve this with the existing gateway."].join("\n"),
      "utf8",
    );
    const runDir = join(root, "tldrx-work", "260916-demo");
    mkdirSync(runDir, { recursive: true });
    const run = fakeRun(["requirements.md"]);

    expect(hasDeclaredSeedSolution(runDir, run)).toBe(false);
    expect(extractSeedSolution(runDir, run)).toBeNull();
  });

  // gh #358: a seed accepted at `.tldrx/seeds/<name>.md` (`run new --seed`'s
  // documented location) must be read like any other seed document — the H2
  // marker there fires `hasDeclaredSeedSolution` and, through `countSkipInputs`,
  // `skip_if: seed_solution==1` on the `how` stage (stages/how/stage.yml).
  test("a seed under .tldrx/seeds/ with the H2 marker is declared and skips how", () => {
    const root = tempRoot();
    mkdirSync(join(root, ".tldrx", "seeds"), { recursive: true });
    writeFileSync(
      join(root, ".tldrx", "seeds", "payments.md"),
      ["# Payments", "", "## Solution", "", "Use the existing gateway."].join("\n"),
      "utf8",
    );
    const runDir = join(root, "tldrx-work", "260916-demo");
    mkdirSync(runDir, { recursive: true });
    const run = fakeRun([".tldrx/memory/facts.yml", ".tldrx/map/api/domains.md", "01-what/seed-index.md", ".tldrx/seeds/payments.md"]);

    expect(seedDocumentPaths(run)).toContain(".tldrx/seeds/payments.md");
    expect(hasDeclaredSeedSolution(runDir, run)).toBe(true);
    expect(countSkipInputs(runDir, run).seed_solution).toBe(1);
    // Same shape `stages/how/stage.yml`'s `skip_if:` line uses.
    expect(evaluateSkipIf("seed_solution==1", countSkipInputs(runDir, run))).toBe(true);
  });

  test("false on an unseeded run", () => {
    const root = tempRoot();
    const runDir = join(root, "tldrx-work", "260916-demo");
    mkdirSync(runDir, { recursive: true });
    expect(hasDeclaredSeedSolution(runDir, fakeRun([]))).toBe(false);
  });

  test("an H1 # Solution does not count — the marker is an H2, exactly", () => {
    const root = tempRoot();
    writeFileSync(
      join(root, "requirements.md"),
      ["# Solution", "", "Not the marker: wrong level."].join("\n"),
      "utf8",
    );
    const runDir = join(root, "tldrx-work", "260916-demo");
    mkdirSync(runDir, { recursive: true });
    expect(hasDeclaredSeedSolution(runDir, fakeRun(["requirements.md"]))).toBe(false);
  });

  test("a nested ### Solution (a container heading) does not count", () => {
    const root = tempRoot();
    writeFileSync(
      join(root, "requirements.md"),
      ["# Payments", "", "## Design notes", "", "### Solution", "", "Not the marker."].join("\n"),
      "utf8",
    );
    const runDir = join(root, "tldrx-work", "260916-demo");
    mkdirSync(runDir, { recursive: true });
    expect(hasDeclaredSeedSolution(runDir, fakeRun(["requirements.md"]))).toBe(false);
  });

  test("countSkipInputs wires it through as 0/1", () => {
    const root = tempRoot();
    writeFileSync(join(root, "requirements.md"), "# X\n\n## Solution\n\nDo it.\n", "utf8");
    const runDir = join(root, "tldrx-work", "260916-demo");
    mkdirSync(runDir, { recursive: true });
    expect(countSkipInputs(runDir, fakeRun(["requirements.md"])).seed_solution).toBe(1);
    expect(countSkipInputs(runDir, fakeRun([])).seed_solution).toBe(0);
  });
});

describe("materializeSeedSolution", () => {
  test("writes <phase>/design.md from the seed section, with a provenance note and a citation", () => {
    const root = tempRoot();
    writeFileSync(
      join(root, "requirements.md"),
      ["# Payments", "", "## Solution", "", "Reuse the existing gateway."].join("\n"),
      "utf8",
    );
    const runDir = join(root, "tldrx-work", "260916-demo");
    mkdirSync(runDir, { recursive: true });
    const run = fakeRun(["requirements.md"]);

    materializeSeedSolution(runDir, run, "02-how", ["02-how/design.md", "02-how/contracts.md"]);

    const written = readFileSync(join(runDir, "02-how", "design.md"), "utf8") as string;
    expect(written).toContain("Reuse the existing gateway.");
    expect(written).toContain("skip_if: seed_solution==1");
    expect(written).toContain("[src: requirements.md:3]");
  });

  test("never clobbers a design.md that is already there", () => {
    const root = tempRoot();
    writeFileSync(join(root, "requirements.md"), "# X\n\n## Solution\n\nNew content.\n", "utf8");
    const runDir = join(root, "tldrx-work", "260916-demo", "02-how");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "design.md"), "# Design\n\nOriginal, real work.\n", "utf8");
    const run = fakeRun(["requirements.md"]);

    materializeSeedSolution(join(root, "tldrx-work", "260916-demo"), run, "02-how", ["02-how/design.md"]);

    const written = readFileSync(join(runDir, "design.md"), "utf8") as string;
    expect(written).toContain("Original, real work.");
  });

  test("a no-op when the skipped stage declares no design.md output", () => {
    const root = tempRoot();
    writeFileSync(join(root, "requirements.md"), "# X\n\n## Solution\n\nDo it.\n", "utf8");
    const runDir = join(root, "tldrx-work", "260916-demo");
    mkdirSync(runDir, { recursive: true });
    const run = fakeRun(["requirements.md"]);

    materializeSeedSolution(runDir, run, "02-how", ["02-how/handoff.md"]);

    expect(existsSync(join(runDir, "02-how", "design.md"))).toBe(false);
  });
});
