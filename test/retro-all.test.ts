/**
 * `tldrx retro --all` — cross-run mining of review findings, defer ledgers and
 * fix rounds (issue #64).
 *
 * The fixture is not invented: every artefact below is the SHAPE a real run
 * leaves behind — `renderReviewLog` (`build/review.ts`), `renderFixlist`
 * (`build/fixlist.ts`), `appendBuildRetro` (`build/retroLog.ts`) and the
 * `story.reopened` envelope (`run/reopenStory.ts`) — with the wording of the
 * findings taken from the runs those modules' own headers cite. Testing the
 * keyword rules against anything else would test the rules against themselves.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";
import { EXIT_OK, EXIT_USAGE } from "../src/cli/exitCodes.ts";
import {
  classify, FINDING_CLASSES, mineAll, renderTrends, type FindingClass,
} from "../src/core/retro/index.ts";
import { noSpawnEnv } from "./fixtures/noSpawnPath.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

setDefaultTimeout(spawnTestTimeout());

const BIN = join(FRAMEWORK_ROOT, "bin", "tldrx.ts");

async function tldrx(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", BIN, ...args], {
    stdout: "pipe", stderr: "pipe", cwd: FRAMEWORK_ROOT, env: noSpawnEnv(),
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

// --- the fixture -------------------------------------------------------------

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "tldrx-retro-all-"));
  temps.push(root);
  mkdirSync(join(root, ".tldrx"), { recursive: true });
  return root;
}

function write(root: string, rel: string, body: string): void {
  const path = join(root, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body, "utf8");
}

const REOPEN_EVENT = JSON.stringify({
  ts: "2026-08-31T22:14:03Z",
  run: "260830-tenancy",
  stage: null,
  type: "story.reopened",
  actor: "alan",
  cost_usd: 0,
  payload: {
    phase: "04-build", story: "S3", wave: "w1", from_status: "blocked", to_status: "todo",
    verdicts: 2,
    note: "the confirm handler is unreachable — no route registers it, so the DoD proved nothing",
  },
});

/**
 * Three runs, deliberately unequal:
 *
 *   `260830-tenancy`  every source present, including one finding that appears
 *                     BOTH in its fix list and, verbatim, in `retro.md`
 *   `260901-payments` an events log and nothing else
 *   `260902-empty`    a run.yml and nothing else at all
 */
function threeRuns(): string {
  const root = tempRoot();

  write(root, "tldrx-work/260830-tenancy/run.yml", "id: 260830-tenancy\nstatus: done\n");
  write(root, "tldrx-work/260830-tenancy/04-build/log/S5.md", [
    "# Review — S5 · OTP confirm",
    "",
    "- Verdict: **changes**",
    "- Story status: `review`",
    "- Attempt: 1",
    "",
    "## Summary",
    "",
    "The retry path is asserted by a test that cannot fail — it stubs the very call it checks.",
    "",
    "## Findings",
    "",
    "- The tenant filter is not applied to the read model, so one tenant can list another's rows.",
    "- `ConfirmOtp` carries a comment claiming the compare is constant-time; it is not.",
    "",
  ].join("\n"));
  write(root, "tldrx-work/260830-tenancy/04-build/fixlist/S5-1.md", [
    "# Fix list — S5 · OTP confirm, round 1",
    "",
    "- Reviewer verdict: **fixlist** (signed, with findings the acceptance criteria did not cover)",
    "",
    "## 1 · Concurrent double-confirm mints two sessions  [high]",
    "",
    "Where: `src/Auth/ConfirmOtp.cs:74` [src: api:src/Auth/ConfirmOtp.cs:74]",
    "Disposition: **fix-now**",
    "Resolved: no",
    "",
    "The confirm is not atomic, so two requests in flight both pass the authorization check.",
    "",
    "## 3 · No OTP attempt limiter  [medium]",
    "",
    "Where: (not stated)",
    "Disposition: **defer-with-log**",
    "Resolved: no",
    "",
    "A lockout policy is a product call.",
    "",
    "## 4 · The stories table migration never ran against the read model  [medium]",
    "",
    "Where: (not stated)",
    "Disposition: **defer-with-log**",
    "Resolved: no",
    "",
    "The schema the query assumes has drifted from the one the migration wrote.",
    "",
  ].join("\n"));
  write(root, "tldrx-work/260830-tenancy/retro.md", [
    "# Retro — 260830-tenancy",
    "",
    "## Build feedback",
    "",
    "Appended by the Build executor as each story settled, and by nothing else.",
    "",
    "- `S5` — reviewer finding DEFERRED (medium): No OTP attempt limiter — A lockout policy is a"
      + " product call. [src: tldrx-work/260830-tenancy/04-build/fixlist/S5-1.md:1]",
    "- `S7` — dod `bun test` exited 1 on the first attempt"
      + " [src: tldrx-work/260830-tenancy/04-build/log/S7.md:1]",
    "",
  ].join("\n"));
  write(root, "tldrx-work/260830-tenancy/events.jsonl", `${REOPEN_EVENT}\n`);

  write(root, "tldrx-work/260901-payments/run.yml", "id: 260901-payments\nstatus: open\n");
  write(root, "tldrx-work/260901-payments/events.jsonl", `${JSON.stringify({
    ts: "2026-09-01T10:00:00Z",
    run: "260901-payments",
    stage: null,
    type: "story.reopened",
    actor: "alan",
    cost_usd: 0,
    payload: {
      phase: "04-build", story: "S1", wave: "w1", from_status: "review", to_status: "todo",
      verdicts: 1,
      note: "the refund test only covers the happy path — there is no negative control at all",
    },
  })}\n`);

  write(root, "tldrx-work/260902-empty/run.yml", "id: 260902-empty\nstatus: open\n");
  return root;
}

/** Every file under `dir`, as `<rel>:<sha1>` — the byte-level snapshot. */
function snapshot(dir: string): readonly string[] {
  const found: string[] = [];
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current).sort()) {
      const path = join(current, entry);
      const rel = prefix === "" ? entry : `${prefix}/${entry}`;
      if (statSync(path).isDirectory()) walk(path, rel);
      else found.push(`${rel}:${createHash("sha1").update(readFileSync(path)).digest("hex")}`);
    }
  };
  walk(dir, "");
  return found;
}

// --- the taxonomy ------------------------------------------------------------

describe("finding classes", () => {
  test("the taxonomy is the seven classes, `other` last", () => {
    expect([...FINDING_CLASSES]).toEqual([
      "test-cannot-fail",
      "missing-negative-control",
      "unreachable-structure",
      "stale-comment",
      "authorization-not-widened",
      "schema-drift",
      "other",
    ]);
  });

  /**
   * Each row is a sentence in the shape a real artefact carries it. A rule that
   * only fires on the words the rule was written from is not a rule.
   */
  const CASES: readonly (readonly [string, FindingClass])[] = [
    ["The retry path is asserted by a test that cannot fail — it stubs the very call it checks.", "test-cannot-fail"],
    ["This test always passes: the assertion compares the mock to itself.", "test-cannot-fail"],
    ["The new case asserts nothing — it calls the handler and returns.", "test-cannot-fail"],
    ["the refund test only covers the happy path — there is no negative control at all", "missing-negative-control"],
    ["No negative test for a refused token.", "missing-negative-control"],
    ["the confirm handler is unreachable — no route registers it, so the DoD proved nothing", "unreachable-structure"],
    ["`RateLimiter` is built but never called from the request pipeline.", "unreachable-structure"],
    ["The interface is dead code: nothing implements it.", "unreachable-structure"],
    ["`ConfirmOtp` carries a comment claiming the compare is constant-time; it is not.", "stale-comment"],
    ["The docstring still describes the v1 signature.", "stale-comment"],
    ["The tenant filter is not applied to the read model, so one tenant can list another's rows.", "authorization-not-widened"],
    ["Concurrent double-confirm mints two sessions", "authorization-not-widened"],
    ["The endpoint gained a query parameter and no permission check widened with it.", "authorization-not-widened"],
    ["The schema the query assumes has drifted from the one the migration wrote.", "schema-drift"],
    ["The DTO and the contract disagree about `status`.", "schema-drift"],
    ["The button is two pixels off.", "other"],
    ["", "other"],
  ];

  for (const [text, expected] of CASES) {
    test(`classify: ${expected} <- ${text.slice(0, 52) || "(empty)"}`, () => {
      expect(classify(text)).toBe(expected);
    });
  }

  test("every class the rules can produce is in FINDING_CLASSES", () => {
    for (const [text] of CASES) expect(FINDING_CLASSES).toContain(classify(text));
  });
});

// --- the aggregation ---------------------------------------------------------

describe("mineAll", () => {
  const root = threeRuns();
  const report = mineAll(root);

  test("reads every run folder that has a run.yml", () => {
    expect([...report.runs].sort()).toEqual(["260830-tenancy", "260901-payments", "260902-empty"]);
  });

  test("a run with nothing to mine is read, counted and contributes nothing", () => {
    expect(report.runs).toContain("260902-empty");
    expect(report.contributed).not.toContain("260902-empty");
    expect(report.findings.filter((f) => f.run === "260902-empty")).toEqual([]);
  });

  test("a run with only an events log still contributes its reopen reasons", () => {
    const mined = report.findings.filter((f) => f.run === "260901-payments");
    expect(mined).toHaveLength(1);
    expect(mined[0]?.kind).toBe("reopen");
    expect(mined[0]?.cls).toBe("missing-negative-control");
    expect(mined[0]?.src).toBe("[src: tldrx-work/260901-payments/events.jsonl:1]");
  });

  test("review-log findings and the verdict summary are mined with real line numbers", () => {
    const mined = report.findings.filter((f) => f.run === "260830-tenancy" && f.kind === "review-finding");
    expect(mined.map((f) => f.cls).sort()).toEqual(["authorization-not-widened", "stale-comment"]);
    for (const finding of mined) {
      expect(finding.src).toMatch(/^\[src: tldrx-work\/260830-tenancy\/04-build\/log\/S5\.md:\d+\]$/);
      expect(finding.src).not.toContain(":0]");
    }
    const verdict = report.findings.find((f) => f.run === "260830-tenancy" && f.kind === "verdict");
    expect(verdict?.cls).toBe("test-cannot-fail");
  });

  test("fix-list findings carry their disposition; defer-with-log is its own kind", () => {
    const fix = report.findings.filter((f) => f.run === "260830-tenancy" && f.kind === "fixlist");
    const deferred = report.findings.filter((f) => f.run === "260830-tenancy" && f.kind === "deferred");
    expect(fix.map((f) => f.text)).toEqual(["Concurrent double-confirm mints two sessions"]);
    expect(deferred.map((f) => f.cls).sort()).toEqual(["authorization-not-widened", "schema-drift"]);
  });

  /**
   * `retro.md`'s `## Build feedback` is written FROM the fix list, so the same
   * defect is on disk twice. Counting it twice would inflate exactly the classes
   * the table exists to rank.
   */
  test("a retro.md bullet that repeats a fix-list finding is collapsed, not counted twice", () => {
    const limiter = report.findings.filter((f) => f.text.includes("OTP attempt limiter"));
    expect(limiter).toHaveLength(1);
    expect(limiter[0]?.kind).toBe("deferred");
    expect(report.deduped).toBe(1);
  });

  test("a retro.md bullet with no other source is kept", () => {
    const dod = report.findings.filter((f) => f.run === "260830-tenancy" && f.kind === "retro-bullet");
    expect(dod).toHaveLength(1);
    expect(dod[0]?.text).toContain("dod `bun test` exited 1");
  });

  /**
   * The row carries ONE citation — this module's, which resolves — and the shown
   * text must not carry a second, stale one inside it.
   */
  test("a finding's own [src: …] is stripped from the text it shows", () => {
    for (const finding of report.findings) expect(finding.text).not.toContain("[src:");
  });

  test("trends rank by count and every row cites one real example", () => {
    expect(report.trends.length).toBeGreaterThan(0);
    for (let i = 1; i < report.trends.length; i++) {
      expect(report.trends[i - 1]!.count).toBeGreaterThanOrEqual(report.trends[i]!.count);
    }
    for (const trend of report.trends) {
      expect(trend.count).toBeGreaterThan(0);
      expect(trend.runs.length).toBeGreaterThan(0);
      expect(trend.example).not.toBeNull();
      expect(trend.example?.src).toMatch(/^\[src: tldrx-work\/.+:\d+\]$/);
    }
    const authz = report.trends.find((t) => t.cls === "authorization-not-widened");
    expect(authz?.count).toBe(3);
    expect([...(authz?.runs ?? [])]).toEqual(["260830-tenancy"]);
  });

  test("an empty workspace is an empty answer, not a failure", () => {
    const empty = tempRoot();
    const nothing = mineAll(empty);
    expect(nothing.runs).toEqual([]);
    expect(nothing.findings).toEqual([]);
    expect(nothing.trends).toEqual([]);
    expect(renderTrends(nothing)).toContain("no runs found under tldrx-work/");
  });
});

// --- the command -------------------------------------------------------------

describe("tldrx retro --all", () => {
  test("prints the trends table and exits 0", async () => {
    const root = threeRuns();
    const run = await tldrx("retro", "--all", "--root", root);
    expect(run.code).toBe(EXIT_OK);
    expect(run.stdout).toContain("CLASS");
    expect(run.stdout).toContain("COUNT");
    expect(run.stdout).toContain("RUNS");
    expect(run.stdout).toContain("authorization-not-widened");
    expect(run.stdout).toContain("[src: tldrx-work/260830-tenancy/");
    expect(run.stdout).toContain("3 run(s)");
  });

  test("writes nothing at all — the workspace is byte-identical", async () => {
    const root = threeRuns();
    const before = snapshot(root);
    const run = await tldrx("retro", "--all", "--root", root);
    expect(run.code).toBe(EXIT_OK);
    expect(snapshot(root)).toEqual(before);
  });

  test("an empty workspace exits 0 and says so", async () => {
    const root = tempRoot();
    const run = await tldrx("retro", "--all", "--root", root);
    expect(run.code).toBe(EXIT_OK);
    expect(run.stdout).toContain("no runs found under tldrx-work/");
  });

  test("--all with a run id is refused: it is the opposite of naming one", async () => {
    const root = threeRuns();
    const run = await tldrx("retro", "260830-tenancy", "--all", "--root", root);
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.stderr).toContain("--all");
    expect(run.stdout).toBe("");
  });

  test("--all --apply is refused: --all writes nothing, by definition", async () => {
    const root = threeRuns();
    const before = snapshot(root);
    const run = await tldrx("retro", "--all", "--apply", "--root", root);
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.stderr).toContain("--apply");
    // The refusal must happen BEFORE practices.md is touched, so the byte check
    // is the assertion and the exit code is only half of it.
    expect(snapshot(root)).toEqual(before);
  });
});
