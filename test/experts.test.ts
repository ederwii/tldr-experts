import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { competencyLevel, type CompetencyEvidence, type EvidenceKind } from "../src/core/init/competencyLevel.ts";
import {
  createExpert, driftWarnings, evidenceNote, evidenceWarnings, loadExpert, loadExperts,
  checkEvidenceSrc, ignoredRowWarnings,
  readEvidenceRows, readExpertDocument, renderExpertList, renderTrainPrompt, stars, starChartLine,
} from "../src/core/experts/index.ts";
import { CompetenciesError, writeCompetencies } from "../src/core/training/competenciesWrite.ts";
import { EXIT_NOT_FOUND } from "../src/cli/exitCodes.ts";
import { parseYaml } from "../src/core/yaml.ts";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";
import { noSpawnEnv } from "./fixtures/noSpawnPath.ts";
import { EXIT_FAILED, EXIT_GATE_REFUSED, EXIT_OK } from "../src/cli/exitCodes.ts";
import { makeViewsWorkspace, VIEWS_FIXTURE, VIEWS_NOW } from "./fixtures/views/tempViews.ts";

const BIN = join(FRAMEWORK_ROOT, "bin", "tldrx.ts");
const NOW = new Date("2026-09-01T00:00:00Z");

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function tldrx(...args: string[]): Promise<Run> {
  const proc = Bun.spawn(["bun", BIN, ...args], { stdout: "pipe", stderr: "pipe", cwd: FRAMEWORK_ROOT, env: noSpawnEnv() });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString().slice(0, 10);
}

function evidence(kind: EvidenceKind, count: number, days: number, sameSrc = false): CompetencyEvidence[] {
  return Array.from({ length: count }, (_unused, i) => ({
    kind,
    src: sameSrc ? "api:src/A.cs:1" : `api:src/A.cs:${i + 1}`,
    at: daysAgo(days),
  }));
}

/** One `run` row — a command actually executed, cited with the §2.8 `cmd` production. */
function runRow(days: number, command = "bun test"): CompetencyEvidence {
  return { kind: "run", src: `$ ${command} → exit 0`, at: daysAgo(days) };
}

describe("the §2.6 level formula", () => {
  test("no evidence is level 0 — an untrained expert says so", () => {
    expect(competencyLevel([], NOW)).toBe(0);
  });

  // W thresholds: 0 if W<0.5 · 1 if <1.5 · 2 if <3 · 3 if <6 · 4 if <20 · else 5.
  // Rows without a `run` are additionally capped at 3 — see the run-gate block below.
  const table: readonly { readonly why: string; readonly items: CompetencyEvidence[]; readonly level: number }[] = [
    { why: "one fresh doc, W=0.5", items: evidence("doc", 1, 0), level: 1 },
    { why: "one fresh code, W=1.0", items: evidence("code", 1, 0), level: 1 },
    { why: "two fresh code, W=2.0", items: evidence("code", 2, 0), level: 2 },
    { why: "four fresh code, W=4.0", items: evidence("code", 4, 0), level: 3 },
    { why: "six fresh code, W=6.0, but nothing was run", items: evidence("code", 6, 0), level: 3 },
    { why: "twelve fresh code, W=12.0, but nothing was run", items: evidence("code", 12, 0), level: 3 },
    { why: "six fresh code plus one run, W=7.0", items: [...evidence("code", 6, 0), runRow(0)], level: 4 },
    { why: "twenty fresh code plus one run, W=21.0, two kinds", items: [...evidence("code", 20, 0), runRow(0)], level: 5 },
    { why: "recency band 31-90d halves and more (0.6)", items: evidence("code", 2, 31), level: 1 },
    { why: "recency band 91-365d (0.3): W=0.3 is below the first threshold", items: evidence("code", 1, 91), level: 0 },
    { why: "answer weight 0.8: two fresh answers, W=1.6", items: evidence("answer", 2, 0), level: 2 },
  ];

  for (const row of table) {
    test(`${row.why} -> level ${row.level}`, () => {
      expect(competencyLevel(row.items, NOW)).toBe(row.level);
    });
  }

  test("staleness cap: newest evidence older than 180d caps the level at 2", () => {
    // 40 code items would be W=4.0 at 0.1 recency -> level 3 without the cap.
    expect(competencyLevel(evidence("code", 40, 400), NOW)).toBe(2);
    // And a W big enough for level 5 is still capped — with a `run` row or without one.
    expect(competencyLevel(evidence("code", 200, 400), NOW)).toBe(2);
    expect(competencyLevel([...evidence("code", 200, 400), runRow(400)], NOW)).toBe(2);
    // 180 days exactly is NOT stale: W=12.3 clears the fourth threshold and the run row
    // clears the run cap, so the level lands at 4 rather than the stale 2.
    expect(competencyLevel([...evidence("code", 40, 180), runRow(180)], NOW)).toBe(4);
  });

  test("distinct-source cap: ten citations of one line are worth one source", () => {
    expect(competencyLevel(evidence("code", 10, 0, true), NOW)).toBe(1);
    expect(competencyLevel(evidence("code", 10, 0, false), NOW)).toBe(3);
  });
});

describe("stars above 3 are earned by running something (spec §2.6)", () => {
  const table: readonly { readonly why: string; readonly items: CompetencyEvidence[]; readonly level: number }[] = [
    { why: "12 fresh code rows, nothing executed — the old ladder said 5",
      items: evidence("code", 12, 0), level: 3 },
    { why: "the same 12 plus one run row", items: [...evidence("code", 12, 0), runRow(0)], level: 4 },
    { why: "20 fresh code plus one run: W=21, two kinds",
      items: [...evidence("code", 20, 0), runRow(0)], level: 5 },
    { why: "25 fresh code rows and still nothing executed", items: evidence("code", 25, 0), level: 3 },
    { why: "one run row alone is necessary, not sufficient — W=1.0 is level 1",
      items: [runRow(0)], level: 1 },
    { why: "level 5 needs two kinds: 25 run rows are one kind, however heavy",
      items: evidence("run", 25, 0), level: 4 },
    { why: "the staleness cap outranks the run row", items: [...evidence("code", 200, 400), runRow(400)], level: 2 },
    { why: "the source cap outranks everything: 25 readings of one line plus one run is two sources",
      items: [...evidence("code", 25, 0, true), runRow(0)], level: 2 },
  ];

  for (const row of table) {
    test(`${row.why} -> level ${row.level}`, () => {
      expect(competencyLevel(row.items, NOW)).toBe(row.level);
    });
  }

  test("a real read-only expert file computes 3, not 5", () => {
    // The fixture is a verbatim copy of a user's competencies.yml (2026-08-29):
    // 15 `code` + 2 `test` rows, all from one reading session, all distinct srcs.
    const path = join(FRAMEWORK_ROOT, "test", "fixtures", "competencies", "read-only-expert.yml");
    const doc = parseYaml(readFileSync(path, "utf8")) as { areas: { evidence: unknown }[] };
    const rows = readEvidenceRows(doc.areas[0]!.evidence);
    expect(rows.evidence).toHaveLength(17);
    expect(rows.evidence.some((item) => item.kind === "run")).toBe(false);
    expect(new Set(rows.evidence.map((item) => item.src)).size).toBe(17);
    expect(competencyLevel(rows.evidence, NOW)).toBe(3);
  });
});

/** Rewrite one area's evidence in a throwaway workspace copy. */
function withEvidence(root: string, expert: string, area: string, rows: readonly string[]): void {
  const path = join(root, ".tldrx", "experts", expert, "competencies.yml");
  writeFileSync(
    path,
    [
      "version: 1",
      `expert: ${expert}`,
      "status: in-use",
      "last_trained: 2026-08-20T11:00:00Z",
      "areas:",
      `  - id: ${area}`,
      `    title: "${area}"`,
      "    level: 0",
      "    evidence:",
      ...rows.map((row) => `      - ${row}`),
      "",
    ].join("\n"),
    "utf8",
  );
}

describe("the `test` evidence kind", () => {
  test("weighs the same as code — a test read or run is a direct observation", () => {
    expect(competencyLevel(evidence("test", 2, 0), NOW)).toBe(2);
    expect(competencyLevel(evidence("test", 4, 0), NOW)).toBe(3);
    // Same W as the same number of `code` rows.
    expect(competencyLevel(evidence("test", 6, 0), NOW)).toBe(competencyLevel(evidence("code", 6, 0), NOW));
  });

  test("readEvidenceRows keeps it, and tallies only the kinds it cannot place", () => {
    const rows = readEvidenceRows([
      { kind: "test", src: "api:tests/A.cs:1", at: "2026-08-29" },
      { kind: "code", src: "api:src/A.cs:1", at: "2026-08-29" },
      { kind: "bogus", src: "api:src/B.cs:1", at: "2026-08-29" },
      { kind: "bogus", src: "api:src/C.cs:1", at: "2026-08-29" },
      { kind: "sketch", src: "api:src/D.cs:1", at: "2026-08-29" },
      // Malformed rather than misclassified: no `src`. Not an unknown-kind report.
      { kind: "nope", at: "2026-08-29" },
    ]);
    expect(rows.evidence.map((item) => item.kind)).toEqual(["test", "code"]);
    expect(rows.ignored).toEqual([
      { reason: "unknown-kind", kind: "bogus", src: "", count: 2 },
      { reason: "unknown-kind", kind: "sketch", src: "", count: 1 },
    ]);
  });

  test("`expert list` counts a test row and reports unknown kinds on stderr", async () => {
    const workspace = makeViewsWorkspace();
    try {
      withEvidence(workspace.root, "lab-ui", "scoreboard-ui", [
        `{kind: code, src: "lab:src/A.tsx:1", at: ${daysAgo(1)}}`,
        `{kind: test, src: "lab:src/A.test.tsx:1", at: ${daysAgo(1)}}`,
        `{kind: sketch, src: "lab:src/B.tsx:1", at: ${daysAgo(1)}}`,
      ]);
      const run = await tldrx("expert", "list", "--root", workspace.root);
      expect(run.code).toBe(EXIT_OK);
      // 2 of 3 rows count; the third is named rather than dropped in silence.
      expect(run.stdout).toContain("scoreboard-ui  ★★☆☆☆ 2  (2 evidence");
      expect(run.stderr).toBe(
        "warning: lab-ui/scoreboard-ui: 1 evidence row(s) ignored — "
        + "unknown kind 'sketch' (allowed: code, run, test, doc, answer)\n",
      );
    } finally {
      workspace.dispose();
    }
  });

  test("`expert list --json` keeps stdout parseable and still warns on stderr", async () => {
    const workspace = makeViewsWorkspace();
    try {
      withEvidence(workspace.root, "lab-ui", "scoreboard-ui", [
        `{kind: sketch, src: "lab:src/B.tsx:1", at: ${daysAgo(1)}}`,
        `{kind: sketch, src: "lab:src/C.tsx:1", at: ${daysAgo(1)}}`,
      ]);
      const run = await tldrx("expert", "list", "--root", workspace.root, "--json");
      expect(run.code).toBe(EXIT_OK);
      expect(() => JSON.parse(run.stdout)).not.toThrow();
      expect(run.stderr).toContain("2 evidence row(s) ignored — unknown kind 'sketch'");
    } finally {
      workspace.dispose();
    }
  });

  test("evidenceWarnings is one line per unknown kind per area", () => {
    const workspace = makeViewsWorkspace();
    try {
      withEvidence(workspace.root, "lab-ui", "scoreboard-ui", [
        `{kind: sketch, src: "lab:src/B.tsx:1", at: ${daysAgo(1)}}`,
        `{kind: hunch, src: "lab:src/C.tsx:1", at: ${daysAgo(1)}}`,
      ]);
      const warnings = evidenceWarnings(loadExpert(workspace.root, "lab-ui", NOW));
      expect(warnings).toHaveLength(2);
      expect(warnings[0]).toBe(
        "warning: lab-ui/scoreboard-ui: 1 evidence row(s) ignored — "
        + "unknown kind 'sketch' (allowed: code, run, test, doc, answer)",
      );
      expect(warnings[1]).toContain("unknown kind 'hunch'");
    } finally {
      workspace.dispose();
    }
  });

  test("training's merge returns the same warning instead of dropping rows quietly", () => {
    const workspace = makeViewsWorkspace();
    try {
      withEvidence(workspace.root, "lab-ui", "scoreboard-ui", [
        `{kind: sketch, src: "lab:src/B.tsx:1", at: ${daysAgo(1)}}`,
      ]);
      const written = writeCompetencies({
        root: workspace.root,
        expert: "lab-ui",
        areaId: "scoreboard-ui",
        evidence: [{ kind: "test", src: "lab:src/A.test.tsx:1", at: daysAgo(1) }],
        status: "in-use",
        lastTrained: "2026-09-01T00:00:00Z",
        now: NOW,
      });
      expect(written.warnings).toEqual([
        "warning: lab-ui/scoreboard-ui: 1 evidence row(s) ignored — "
        + "unknown kind 'sketch' (allowed: code, run, test, doc, answer)",
      ]);
      // The `test` row it was handed is real evidence, not another dropped row.
      expect(written.evidenceCount).toBe(1);
      expect(written.levelAfter).toBe(1);
    } finally {
      workspace.dispose();
    }
  });
});

// --- an evidence `src` has to be a citation of its own kind -------------------

/**
 * Before 2026-08-29 nothing validated an evidence `src`: `readEvidenceRows`
 * rejected an empty string and `competenciesWrite` never looked at one. So
 * `{kind: run, src: "the tests pass"}` counted as a run — and under the wave-E
 * ladder that single row is the difference between level 3 and level 4. The
 * grammar is spec §2.8's, read by the same `classifySrc` the `claim-sources`
 * hook uses.
 */
describe("evidence src validation (spec §2.6/§2.8)", () => {
  const AT = daysAgo(1);
  const rowsFor = (kind: string, src: string) => readEvidenceRows([{ kind, src, at: AT }]);

  test("a src that is not a citation at all is dropped, and named", () => {
    const rows = rowsFor("code", "the auth file");
    expect(rows.evidence).toEqual([]);
    expect(ignoredRowWarnings("e", "a", rows.ignored)).toEqual([
      "warning: e/a: 1 evidence row(s) ignored — malformed src 'the auth file'",
    ]);
  });

  test("a `run` row whose src is a file read is a kind/src mismatch, not a run", () => {
    const rows = rowsFor("run", "api:src/Thing.cs:1");
    expect(rows.evidence).toEqual([]);
    expect(ignoredRowWarnings("e", "a", rows.ignored)).toEqual([
      "warning: e/a: 1 evidence row(s) ignored — kind 'run' needs a "
      + "'$ <cmd> → exit <n>' or 'tldrx-work/<run>/<file>:<line>' src",
    ]);
  });

  test("both refusals travel the same channel as an unknown kind, and tally per complaint", () => {
    const rows = readEvidenceRows([
      { kind: "code", src: "api:src/A.cs:1", at: AT },
      { kind: "hunch", src: "api:src/B.cs:1", at: AT },
      { kind: "doc", src: "not a url", at: AT },
      { kind: "doc", src: "not a url", at: AT },
      { kind: "answer", src: "api:src/C.cs:1", at: AT },
    ]);
    expect(rows.evidence.map((row) => row.kind)).toEqual(["code"]);
    expect(rows.ignored.map((row) => row.reason))
      .toEqual(["unknown-kind", "malformed-src", "kind-mismatch"]);
    expect(rows.ignored[1]?.count).toBe(2);
    expect(ignoredRowWarnings("e", "a", rows.ignored)).toEqual([
      "warning: e/a: 1 evidence row(s) ignored — unknown kind 'hunch' (allowed: code, run, test, doc, answer)",
      "warning: e/a: 2 evidence row(s) ignored — malformed src 'not a url'",
      "warning: e/a: 1 evidence row(s) ignored — kind 'answer' needs a 'F<n>' src",
    ]);
  });

  const table: readonly {
    readonly kind: EvidenceKind;
    readonly good: readonly string[];
    readonly bad: readonly string[];
  }[] = [
    { kind: "code", good: ["api:src/A.cs:1", "src/A.cs:1-9"], bad: ["$ bun test → exit 0", "F001", "https://x.dev"] },
    {
      kind: "run",
      good: ["$ bun test → exit 0", "$ npm run build → exit 1", "tldrx-work/260820-x/02-how/handoff.md:4"],
      bad: ["api:src/A.cs:1", "F001", "https://x.dev"],
    },
    { kind: "test", good: ["api:tests/A.cs:1", "$ bun test → exit 0"], bad: ["F001", "https://x.dev"] },
    { kind: "doc", good: ["https://x.dev/a"], bad: ["api:src/A.cs:1", "$ bun test → exit 0", "F001"] },
    { kind: "answer", good: ["F001", "F00123"], bad: ["api:src/A.cs:1", "Q4", "$ bun test → exit 0"] },
  ];

  for (const row of table) {
    test(`kind \`${row.kind}\` accepts only its own src class`, () => {
      for (const src of row.good) {
        expect(checkEvidenceSrc(row.kind, src)).toBeNull();
        expect(rowsFor(row.kind, src).evidence).toHaveLength(1);
      }
      for (const src of row.bad) {
        expect(checkEvidenceSrc(row.kind, src)).not.toBeNull();
        expect(rowsFor(row.kind, src).evidence).toEqual([]);
      }
    });
  }

  test("a hand-written `run` row that IS a command is accepted, and counts toward the run cap", () => {
    const hand = [
      ...evidence("code", 6, 1),
      { kind: "run" as const, src: "$ bun test → exit 0", at: AT },
    ];
    const rows = readEvidenceRows(hand);
    expect(rows.ignored).toEqual([]);
    expect(rows.evidence).toHaveLength(7);
    // The run row is the whole difference: without it the §2.6 run cap holds at 3.
    expect(competencyLevel(rows.evidence, NOW)).toBe(4);
    expect(competencyLevel(rows.evidence.filter((r) => r.kind !== "run"), NOW)).toBe(3);
  });

  test("`expert list` prints the new refusals on stderr, like the old one", async () => {
    const workspace = makeViewsWorkspace();
    try {
      withEvidence(workspace.root, "lab-ui", "scoreboard-ui", [
        `{kind: code, src: "lab:src/A.tsx:1", at: ${AT}}`,
        `{kind: run, src: "lab:src/A.tsx:1", at: ${AT}}`,
      ]);
      const run = await tldrx("expert", "list", "--root", workspace.root);
      expect(run.code).toBe(EXIT_OK);
      expect(run.stderr).toBe(
        "warning: lab-ui/scoreboard-ui: 1 evidence row(s) ignored — kind 'run' needs a "
        + "'$ <cmd> → exit <n>' or 'tldrx-work/<run>/<file>:<line>' src\n",
      );
    } finally {
      workspace.dispose();
    }
  });

  test("the WRITE side throws instead of warning — a bad row there is a harness bug", () => {
    const workspace = makeViewsWorkspace();
    try {
      const write = (row: CompetencyEvidence) => (): unknown => writeCompetencies({
        root: workspace.root,
        expert: "lab-ui",
        areaId: "scoreboard-ui",
        evidence: [row],
        status: "in-use",
        lastTrained: "2026-09-01T00:00:00Z",
        now: NOW,
      });

      expect(write({ kind: "run", src: "the tests pass", at: AT })).toThrow(CompetenciesError);
      expect(write({ kind: "run", src: "the tests pass", at: AT }))
        .toThrow("refusing to write evidence — malformed src 'the tests pass'");
      expect(write({ kind: "run", src: "lab:src/A.tsx:1", at: AT }))
        .toThrow("refusing to write evidence — kind 'run' needs a");
      // …and the file was not touched by any of the three attempts.
      expect(loadExpert(workspace.root, "lab-ui", NOW).areas[0]?.evidence).toHaveLength(1);

      // The valid row on the same path still writes.
      const ok = write({ kind: "run", src: "$ bun test → exit 0", at: AT })() as { evidenceCount: number };
      expect(ok.evidenceCount).toBe(2);
    } finally {
      workspace.dispose();
    }
  });
});

describe("expert list", () => {
  test("levels are recomputed, never taken from the file", () => {
    const experts = loadExperts(VIEWS_FIXTURE, VIEWS_NOW);
    expect(experts.map((expert) => expert.name)).toEqual(["dotnet-stack", "lab-ui"]);

    const dotnet = experts[0]!;
    const efCore = dotnet.areas.find((area) => area.id === "ef-core")!;
    expect(efCore.storedLevel).toBe(2);
    expect(efCore.level).toBe(2);

    const soap = dotnet.areas.find((area) => area.id === "legacy-soap")!;
    expect(soap.evidence).toHaveLength(4);
    expect(soap.level).toBe(0);
    expect(soap.newestEvidence).toBe("2024-03-10");
  });

  test("warns when the stored level disagrees with the evidence", () => {
    const labUi = loadExpert(VIEWS_FIXTURE, "lab-ui", VIEWS_NOW);
    expect(labUi.areas[0]!.storedLevel).toBe(5);
    expect(labUi.areas[0]!.level).toBe(1);

    const warnings = driftWarnings(labUi);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("lab-ui/scoreboard-ui");
    expect(warnings[0]).toContain("stores level 5");
    expect(warnings[0]).toContain("evidence computes 1");
  });

  test("the star chart line carries the level, the count and the newest date", () => {
    const efCore = loadExpert(VIEWS_FIXTURE, "dotnet-stack", VIEWS_NOW).areas[0]!;
    expect(starChartLine(efCore, 11)).toBe("ef-core      ★★☆☆☆ 2  (4 evidence, newest 2026-08-20)");
    expect(stars(0)).toBe("☆☆☆☆☆");
    expect(stars(5)).toBe("★★★★★");
    expect(evidenceNote({ ...efCore, evidence: [], newestEvidence: null })).toBe("(no evidence)");
  });

  test("renders a table, a chart per expert, and the warnings", () => {
    const text = renderExpertList(loadExperts(VIEWS_FIXTURE, VIEWS_NOW));
    expect(text).toContain("expert");
    expect(text).toContain("last_trained");
    expect(text).toContain("dotnet-stack");
    expect(text).toContain("lab-ui");
    expect(text).toContain("★");
    expect(text).toContain("warning:");
  });

  test("`tldrx expert list --json` exits 0 and reports the drift as data", async () => {
    const run = await tldrx("expert", "list", "--root", VIEWS_FIXTURE, "--json");
    expect(run.code).toBe(EXIT_OK);
    const parsed = JSON.parse(run.stdout) as {
      name: string;
      areas: { id: string; level: number; stored_level: number; level_matches_evidence: boolean }[];
    }[];
    const labUi = parsed.find((expert) => expert.name === "lab-ui")!;
    expect(labUi.areas[0]!.stored_level).toBe(5);
    expect(labUi.areas[0]!.level_matches_evidence).toBe(false);
  });

  test("an empty workspace says so instead of printing an empty table", () => {
    expect(renderExpertList([])).toContain("No experts yet");
  });
});

describe("expert create", () => {
  test("writes both files, with zero areas by default", async () => {
    const workspace = makeViewsWorkspace();
    try {
      const created = await createExpert({
        root: workspace.root, name: "payments", createdAt: "2026-09-02T10:00:00Z",
      });
      expect(created.areas).toEqual([]);
      const doc = parseYaml(readFileSync(join(created.dir, "competencies.yml"), "utf8")) as {
        version: number; expert: string; status: string; areas: unknown[];
      };
      expect(doc.version).toBe(1);
      expect(doc.expert).toBe("payments");
      expect(doc.status).toBe("created");
      expect(doc.areas).toEqual([]);

      const markdown = readFileSync(join(created.dir, "expert.md"), "utf8");
      expect(markdown).toContain("name: payments");
      expect(markdown).toContain("# payments");
      expect(markdown).toContain('created_by: "tldrx expert create"');
    } finally {
      workspace.dispose();
    }
  });

  test("--domain and --stack each add one area, at level 0 with no evidence", async () => {
    const workspace = makeViewsWorkspace();
    try {
      const created = await createExpert({
        root: workspace.root, name: "checkout", domain: "billing", stack: "typescript",
        createdAt: "2026-09-02T10:00:00Z",
      });
      expect(created.areas).toEqual(["typescript", "billing"]);
      const expert = loadExpert(workspace.root, "checkout", VIEWS_NOW);
      expect(expert.areas.map((area) => area.level)).toEqual([0, 0]);
      expect(expert.areas.map((area) => area.evidence.length)).toEqual([0, 0]);
      expect(expert.areas[0]!.trainPrompt).toBe("tldrx expert train checkout --area typescript --mode light");
    } finally {
      workspace.dispose();
    }
  });

  test("refuses to overwrite an existing expert (exit 1), leaving it untouched", async () => {
    const workspace = makeViewsWorkspace();
    try {
      const path = join(workspace.root, ".tldrx", "experts", "lab-ui", "competencies.yml");
      const before = readFileSync(path, "utf8");

      const run = await tldrx("expert", "create", "lab-ui", "--root", workspace.root);
      expect(run.code).toBe(EXIT_FAILED);
      expect(run.stderr).toContain("already exists");
      expect(readFileSync(path, "utf8")).toBe(before);
    } finally {
      workspace.dispose();
    }
  });

  test("rejects a name that is not a slug", async () => {
    const workspace = makeViewsWorkspace();
    try {
      const run = await tldrx("expert", "create", "Not A Slug", "--root", workspace.root);
      expect(run.code).toBe(EXIT_FAILED);
      expect(existsSync(join(workspace.root, ".tldrx", "experts", "Not A Slug"))).toBe(false);
    } finally {
      workspace.dispose();
    }
  });
});

describe("expert recompute", () => {
  test("settles the level an in-session training left behind, and says what moved", async () => {
    const workspace = makeViewsWorkspace();
    try {
      // The fixture's lab-ui stores 5 over one piece of evidence, which computes 1.
      const run = await tldrx("expert", "recompute", "lab-ui", "--root", workspace.root);
      expect(run.code).toBe(EXIT_OK);
      expect(run.stdout).toBe("lab-ui/scoreboard-ui: level 5 → 1 (1 evidence)\n");

      // The warning it was the remedy for is gone, because the file agrees now.
      const after = loadExpert(workspace.root, "lab-ui", VIEWS_NOW);
      expect(after.drifted).toHaveLength(0);
      expect(after.areas[0]!.storedLevel).toBe(1);
      // Not a training run: status and last_trained are untouched.
      expect(after.status).toBe("created");
      expect(after.lastTrained).toBeNull();
    } finally {
      workspace.dispose();
    }
  });

  test("is idempotent — the second run writes nothing, byte-identical", async () => {
    const workspace = makeViewsWorkspace();
    try {
      const path = join(workspace.root, ".tldrx", "experts", "lab-ui", "competencies.yml");
      await tldrx("expert", "recompute", "lab-ui", "--root", workspace.root);
      const first = readFileSync(path, "utf8");

      const again = await tldrx("expert", "recompute", "lab-ui", "--root", workspace.root, "--json");
      expect(again.code).toBe(EXIT_OK);
      expect(readFileSync(path, "utf8")).toBe(first);
      const parsed = JSON.parse(again.stdout) as { written: boolean; areas: { changed: boolean }[] }[];
      expect(parsed[0]!.written).toBe(false);
      expect(parsed[0]!.areas[0]!.changed).toBe(false);
      expect(again.stdout).toContain('"level_after": 1');
    } finally {
      workspace.dispose();
    }
  });

  test("with no name it recomputes every expert, one line per area", async () => {
    const workspace = makeViewsWorkspace();
    try {
      const run = await tldrx("expert", "recompute", "--root", workspace.root);
      expect(run.code).toBe(EXIT_OK);
      expect(run.stdout).toBe([
        "dotnet-stack/ef-core: level 2 unchanged (4 evidence)",
        "dotnet-stack/legacy-soap: level 0 unchanged (4 evidence)",
        "lab-ui/scoreboard-ui: level 5 → 1 (1 evidence)",
        "",
      ].join("\n"));
    } finally {
      workspace.dispose();
    }
  });

  test("an unknown expert is exit 3, naming the ones that exist", async () => {
    const workspace = makeViewsWorkspace();
    try {
      const run = await tldrx("expert", "recompute", "nope", "--root", workspace.root);
      expect(run.code).toBe(EXIT_NOT_FOUND);
      expect(run.stderr).toContain("no expert 'nope'");
      expect(run.stderr).toContain("dotnet-stack, lab-ui");
      expect(run.stdout).toBe("");
    } finally {
      workspace.dispose();
    }
  });

  test("it reports unknown evidence kinds on stderr like every other reader", async () => {
    const workspace = makeViewsWorkspace();
    try {
      withEvidence(workspace.root, "lab-ui", "scoreboard-ui", [
        `{kind: code, src: "lab:src/A.tsx:1", at: ${daysAgo(1)}}`,
        `{kind: sketch, src: "lab:src/B.tsx:1", at: ${daysAgo(1)}}`,
      ]);
      const run = await tldrx("expert", "recompute", "lab-ui", "--root", workspace.root);
      expect(run.code).toBe(EXIT_OK);
      expect(run.stdout).toBe("lab-ui/scoreboard-ui: level 0 → 1 (1 evidence)\n");
      expect(run.stderr).toContain("1 evidence row(s) ignored — unknown kind 'sketch'");
    } finally {
      workspace.dispose();
    }
  });

  test("the drift warning names the command that fixes it", () => {
    const warnings = driftWarnings(loadExpert(VIEWS_FIXTURE, "lab-ui", VIEWS_NOW));
    expect(warnings[0]).toContain("Run `tldrx expert recompute lab-ui` to settle it.");
  });

  test("the printed prompt tells the session to run it when it is done", () => {
    const expert = loadExpert(VIEWS_FIXTURE, "dotnet-stack", VIEWS_NOW);
    const prompt = renderTrainPrompt({
      expert,
      document: readExpertDocument(VIEWS_FIXTURE, "dotnet-stack"),
      area: expert.areas[0]!,
      mode: "light",
      repos: [],
    });
    expect(prompt).toContain("run `tldrx expert recompute dotnet-stack`");
    // and it lists the kinds it may write, which is what BUG 2 was about
    expect(prompt).toContain("- `test` — a test you ran or read");
  });
});

describe("expert train --print-prompt", () => {
  test("the prompt is deterministic and names the expert, area, mode and repos", () => {
    const expert = loadExpert(VIEWS_FIXTURE, "dotnet-stack", VIEWS_NOW);
    const input = {
      expert,
      document: readExpertDocument(VIEWS_FIXTURE, "dotnet-stack"),
      area: expert.areas[0]!,
      mode: "light" as const,
      repos: [{ name: "api", path: "api" }, { name: "lab", path: "lab" }],
    };
    const prompt = renderTrainPrompt(input);

    expect(prompt).toBe(renderTrainPrompt(input));
    expect(prompt).toContain("# Train `dotnet-stack` — area `ef-core` (light mode)");
    expect(prompt).toContain("Level now: ★★☆☆☆ 2/5 (4 evidence, newest 2026-08-20)");
    expect(prompt).toContain("- `api` at `api`");
    expect(prompt).toContain("- `lab` at `lab`");
    expect(prompt).toContain(".tldrx/experts/dotnet-stack/knowledge/ef-core.md");
    expect(prompt).toContain("Speaks for the dotnet stack across api.");
    expect(prompt).not.toContain("Mine past runs");
  });

  test("full mode adds the run-mining steps", () => {
    const expert = loadExpert(VIEWS_FIXTURE, "dotnet-stack", VIEWS_NOW);
    const prompt = renderTrainPrompt({
      expert,
      document: readExpertDocument(VIEWS_FIXTURE, "dotnet-stack"),
      area: expert.areas[1]!,
      mode: "full",
      repos: [],
    });
    expect(prompt).toContain("Mine past runs");
    expect(prompt).toContain("none declared in `.tldrx/workspace.yml`");
  });

  test("the CLI prints it and exits 0", async () => {
    const run = await tldrx(
      "expert", "train", "dotnet-stack", "--area", "ef-core", "--mode", "light",
      "--print-prompt", "--root", VIEWS_FIXTURE,
    );
    expect(run.code).toBe(EXIT_OK);
    expect(run.stdout).toContain("# Train `dotnet-stack` — area `ef-core` (light mode)");
  });

  // The regression: `repos()` handed `loadWorkspaceFile` the `.tldrx/` directory,
  // which joins `.tldrx/workspace.yml` onto it — so every prompt on every real
  // workspace said "none declared". The fixture declares api + lab.
  test("the CLI names every repo workspace.yml declares", async () => {
    const run = await tldrx(
      "expert", "train", "dotnet-stack", "--area", "ef-core", "--print-prompt", "--root", VIEWS_FIXTURE,
    );
    expect(run.code).toBe(EXIT_OK);
    expect(run.stdout).toContain("- `api` at `api`");
    expect(run.stdout).toContain("- `lab` at `lab`");
    expect(run.stdout).not.toContain("none declared");
    expect(run.stderr).toBe("");
  });

  test("`none declared` only when repos: [] is genuinely empty — and no warning", async () => {
    const workspace = makeViewsWorkspace();
    try {
      const path = join(workspace.root, ".tldrx", "workspace.yml");
      writeFileSync(path, "version: 1\nroot: \".\"\nrepos: []\n", "utf8");
      const run = await tldrx(
        "expert", "train", "dotnet-stack", "--area", "ef-core", "--print-prompt", "--root", workspace.root,
      );
      expect(run.code).toBe(EXIT_OK);
      expect(run.stdout).toContain("none declared in `.tldrx/workspace.yml`");
      expect(run.stderr).toBe("");
    } finally {
      workspace.dispose();
    }
  });

  test("an unreadable workspace.yml warns on stderr instead of failing silently", async () => {
    const workspace = makeViewsWorkspace();
    try {
      rmSync(join(workspace.root, ".tldrx", "workspace.yml"));
      const run = await tldrx(
        "expert", "train", "dotnet-stack", "--area", "ef-core", "--print-prompt", "--root", workspace.root,
      );
      expect(run.code).toBe(EXIT_OK);
      expect(run.stdout).toContain("none declared in `.tldrx/workspace.yml`");
      expect(run.stderr).toContain("warning: could not read .tldrx/workspace.yml:");
    } finally {
      workspace.dispose();
    }
  });

  // Without `--print-prompt`, training RUNS (wave 7). This asserts it through the
  // ONE door that reaches a decision before any file is read and before anything
  // is spawned — the budget floor — so the suite can never buy a real sub-agent.
  test("without --print-prompt it runs, and the budget floor refuses below $0.25", async () => {
    const run = await tldrx(
      "expert", "train", "dotnet-stack", "--area", "ef-core", "--max-usd", "0.10", "--root", VIEWS_FIXTURE,
    );
    expect(run.code).toBe(EXIT_GATE_REFUSED);
    expect(run.stderr).toContain("floor");
    expect(run.stdout).toBe("");
  });

  test("--prepare and --commit are refused together", async () => {
    const run = await tldrx(
      "expert", "train", "dotnet-stack", "--area", "ef-core", "--prepare", "--commit", "--root", VIEWS_FIXTURE,
    );
    expect(run.code).toBe(EXIT_FAILED);
    expect(run.stderr).toContain("two halves of one handshake");
  });

  test("an unknown area is an error that lists the known ones", async () => {
    const run = await tldrx(
      "expert", "train", "dotnet-stack", "--area", "nope", "--print-prompt", "--root", VIEWS_FIXTURE,
    );
    expect(run.code).toBe(EXIT_FAILED);
    expect(run.stderr).toContain("ef-core");
  });
});
