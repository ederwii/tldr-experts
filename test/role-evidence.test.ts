/**
 * gh #154 — the run record IS the corpus of the runs pass, and the domain gate
 * refused it.
 *
 * `roleTraining.ts:23-26` states the premise in the source: `--mode full` mines
 * `tldrx-work/<run>/**\/{handoff,retro}.md`, "the record of how this workflow
 * actually ran, which IS a role's domain". `outsideDomain` then judged every one
 * of those citations against the `## Domain` bullets of `expert.md`, which name
 * folders of CODE. The two halves disagreed, and the citation lost.
 *
 * Measured on `~/scavtopia` at 0.8.0, four role experts, `--mode full`: $9.47
 * spent, one evidence row — and that row is `F088`, a fact token, the one
 * citation kind `outsideDomain` never inspects (`knowledgeFile.ts:313`). The
 * three `check.passed` records read `evidence_added: 0` beside a knowledge file
 * of twenty well-sourced bullets.
 *
 * The rule these tests pin is scoped to the PASS, not to the expert's kind: what
 * `mineRuns` put in front of the sub-agent is what that file is allowed to cite.
 * A code file citing a handoff is still out of domain, and the second test says
 * so — the gate narrows, it does not evaporate.
 */
import { describe, expect, setDefaultTimeout, test, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";
import { pathsIntersect, readExpertDomain } from "../src/core/experts/expertDomain.ts";
import { loadWorkspace, toSrcContext } from "../src/hooks/lib/workspace.ts";
import {
  LIGHT_SHAPE, RUNS_SHAPE, parseKnowledgeFile, runEvidence, knowledgeScopeFor, runTraining,
} from "../src/core/training/index.ts";
import { loadExpert } from "../src/core/experts/loadExperts.ts";
import { rescoreExperts } from "../src/core/training/rescoreExperts.ts";
import {
  makeTrainingWorkspace, fromRunsMd, AREA, EXPERT, TRAIN_AT, TRAIN_NOW,
  type TrainingWorkspace, type TrainingWorkspaceOptions,
} from "./fixtures/training/workspace.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

// This file spawns: the third block runs a real training turn against the fake
// agent on PATH, so the load-aware budget replaces the fixed 5000 ms that would
// measure the box instead of the assertion. This line was taken by hand while the
// spawner heuristic still named only four markers; since #194 it names the training
// shape too, so `machine-load.test.ts` claims this file and checks for the line.
setDefaultTimeout(spawnTestTimeout());

const ORIGINAL_PATH = process.env.PATH ?? "";
const FAKE_KEYS = [
  "FAKE_TRAIN_ROOT", "FAKE_TRAIN_OUTPUTS", "FAKE_TRAIN_COST", "FAKE_TRAIN_STATE",
] as const;

let open: TrainingWorkspace[] = [];

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  for (const key of FAKE_KEYS) delete process.env[key];
  for (const ws of open) ws.dispose();
  open = [];
});

function workspace(options: TrainingWorkspaceOptions = {}): TrainingWorkspace {
  const made = makeTrainingWorkspace(options);
  open.push(made);
  return made;
}

const CODE_ONLY_DOMAIN = [
  "---",
  `name: ${EXPERT}`,
  "kind: domain",
  "status: created",
  'created_by: "tldrx init"',
  "created_at: 2026-08-28T14:02:11Z",
  "repos: [api]",
  "---",
  "",
  `# ${EXPERT}`,
  "",
  "## Domain",
  "",
  "- `src/auth/`",
  "",
].join("\n");

function codeDomainWorkspace(): TrainingWorkspace {
  return workspace({ files: { [`.tldrx/experts/${EXPERT}/expert.md`]: CODE_ONLY_DOMAIN } });
}

// --- 1: the runs pass may cite the run record -------------------------------

describe("the run record is in domain for the file mined from it", () => {
  test("a from-runs citation earns evidence though `## Domain` names only code", () => {
    const ws = codeDomainWorkspace();
    const scope = knowledgeScopeFor(ws.root, loadExpert(ws.root, EXPERT, TRAIN_NOW), AREA);
    // The premise of the bug: the declared domain cannot contain a run citation.
    expect(scope.domainPaths).toEqual(["src/auth"]);

    const parsed = parseKnowledgeFile(
      fromRunsMd(), toSrcContext(loadWorkspace(ws.root), null), RUNS_SHAPE, scope,
    );

    expect(parsed.ok).toBe(true);
    expect(parsed.issues.filter((issue) => issue.message.includes("outside domain"))).toHaveLength(0);
    expect(runEvidence(parsed.bullets, "2026-09-01").map((row) => row.src))
      .toEqual(expect.arrayContaining([
        "tldrx-work/260820-oauth/02-how/handoff.md:12",
        "tldrx-work/260820-oauth/retro.md:4",
      ]));
  });

  test("the gate still holds on a CODE file — the run record is not a free pass", () => {
    const ws = codeDomainWorkspace();
    const scope = knowledgeScopeFor(ws.root, loadExpert(ws.root, EXPERT, TRAIN_NOW), AREA);
    const codeFile = [
      `# ${AREA} — ${EXPERT}`,
      "",
      "## Invariants",
      "",
      "- The run decided storage stays in-process [src: tldrx-work/260820-oauth/02-how/handoff.md:12]",
      "",
      "## Entry points",
      "",
      "- `exchange()` is the only way in [src: api:src/auth/oauth.ts:6]",
      "",
      "## Business rules",
      "",
      "- The token is written to the store [src: api:src/auth/token.ts:5]",
      "",
      "## Gotchas",
      "",
      "- There is no refresh path at all [src: absent:api/src/auth/refresh.ts]",
      "",
      "## Sources",
      "",
      "`api:src/auth/oauth.ts` is the exchange.",
      "",
    ].join("\n");

    const parsed = parseKnowledgeFile(
      codeFile, toSrcContext(loadWorkspace(ws.root), null), LIGHT_SHAPE, scope,
    );
    const outside = parsed.issues.filter((issue) => issue.message.includes("outside domain"));
    expect(outside).toHaveLength(1);
    expect(outside[0]?.message).toContain("tldrx-work/260820-oauth/02-how/handoff.md:12");
  });
});

// --- 2: the shipped role templates declare paths that can match --------------

describe("the shipped role templates declare a domain that matches something", () => {
  function templateDomain(role: string): readonly string[] {
    const body = readFileSync(join(FRAMEWORK_ROOT, "templates", "experts", `${role}.md`), "utf8");
    const ws = workspace({ files: { [`.tldrx/experts/${role}/expert.md`]: body } });
    return readExpertDomain(ws.root, role).paths;
  }

  test("architect's map bullet matches a real map file", () => {
    const paths = templateDomain("architect");
    expect(paths.some((path) => pathsIntersect(".tldrx/map/api/architecture.md", path))).toBe(true);
  });

  test("operations' map bullet matches a real gotchas file", () => {
    const paths = templateDomain("operations");
    expect(paths.some((path) => pathsIntersect(".tldrx/map/api/gotchas.md", path))).toBe(true);
  });

  test("every path a role template declares is one the matcher can reach", () => {
    // A glob or a `{repo}` placeholder registers as a literal and then matches
    // nothing at all — the shape that made `.tldrx/map/**` inert.
    for (const role of ["architect", "delivery", "developer", "operations", "product"]) {
      for (const path of templateDomain(role)) {
        expect([role, path, path.includes("*") || path.includes("{")]).toEqual([role, path, false]);
      }
    }
  });
});

// --- 3: a paid pass that earned nothing says so, in both places -------------

/**
 * The other half of gh #154, and the sibling of #101 on the OUTPUT side.
 *
 * #101 refuses a pass whose INPUT is empty, before the money. Nothing asked the
 * question afterwards: a file that validated, cost $1.61 and added zero evidence
 * rows was recorded as `check.passed` with `evidence_added: 0` and no reason
 * beside it, because the ledger writes `problems` only on the failure path
 * (`runTraining.ts`). Two of the three role experts measured on `~/scavtopia`
 * have no record on disk of why they earned nothing; the third's survives only
 * because an unrelated error dragged the warnings into the rejection with it.
 *
 * The file is still kept and the exit is still 0 — a warning is a way of being
 * worth nothing, not a lie, and quarantining an honest file would be worse. What
 * changes is that the run SAYS it bought nothing, and the ledger remembers why.
 */
describe("a pass that bought no evidence reports it", () => {
  const OUTSIDE_ONLY = [
    `# ${AREA} — ${EXPERT}`,
    "",
    "## Invariants",
    "",
    "- Stop selection runs with no reference to the token store [src: api:src/hunts/next.ts:1]",
    "",
    "## Entry points",
    "",
    "- Callers reach hunting through one exported function [src: api:src/hunts/next.ts:2]",
    "",
    "## Business rules",
    "",
    "- The chosen stop is returned rather than stored [src: api:src/hunts/next.ts:3]",
    "",
    "## Gotchas",
    "",
    "- There is no refresh path at all [src: absent:api/src/auth/refresh.ts]",
    "",
    "## Sources",
    "",
    "`api:src/hunts/next.ts` is the whole of it.",
    "",
  ].join("\n");

  test("it says the level did not move, and the ledger keeps the reason", async () => {
    const ws = codeDomainWorkspace();
    process.env.PATH = ws.binDir;
    process.env.FAKE_TRAIN_ROOT = ws.root;
    process.env.FAKE_TRAIN_STATE = ws.statePath;
    process.env.FAKE_TRAIN_COST = "1.61";
    process.env.FAKE_TRAIN_OUTPUTS = JSON.stringify([
      { [`.tldrx/experts/${EXPERT}/knowledge/${AREA}.md.partial`]: OUTSIDE_ONLY },
    ]);

    const result = await runTraining({
      root: ws.root, expert: EXPERT, area: AREA, mode: "light", run: "headless",
      actor: "alan", at: TRAIN_AT, now: TRAIN_NOW, timeoutMs: 20_000, ambientModel: null,
    });

    expect(result.code).toBe(0);
    const said = result.lines.join("\n");
    expect(said).toContain("evidence: +0 row(s)");
    // The headline the operator was never given: this bought nothing, and why.
    expect(said).toContain("the level did not move");
    expect(said).toContain("outside domain");

    const ledger = readFileSync(join(ws.root, ".tldrx", "experts", EXPERT, "training.jsonl"), "utf8");
    const passed = ledger.split("\n").filter((line) => line !== "")
      .map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> })
      .find((row) => row.type === "check.passed");
    expect(passed?.payload.evidence_added).toBe(0);
    const recorded = (passed?.payload.warnings ?? []) as readonly string[];
    expect(recorded.join("\n")).toContain("outside domain");
  });
});

// --- 4: what was already paid for can be scored without paying again --------

/**
 * gh #154's remediation half.
 *
 * The gate fix above changes what the NEXT training run earns. It does nothing
 * for the knowledge files already on disk, and `expert recompute` cannot help:
 * it is arithmetic over the evidence rows already in `competencies.yml`
 * (`recomputeExperts.ts`), and for every expert this bug hit that array is `[]`.
 * Without a path from "file on disk" back to "evidence row", the cheapest
 * recovery for an affected workspace is to buy the same readings a second time —
 * $9.47 of them, in the one measured case.
 *
 * `rescore` is that path, and it is deliberately not a training run: it reads no
 * code, spawns nothing, spends nothing, and leaves `status` and `last_trained`
 * exactly as it found them. The rows it writes are dated by the file's own
 * `trained_at` when it has one and by the expert's `last_trained` when it does
 * not — never by the clock, because recency is weighed and a reading taken in
 * August is not evidence gathered today.
 */
describe("rescore turns knowledge already on disk into evidence", () => {
  const TRAINED_AT = "2026-08-20T09:00:00Z";
  const COMPETENCIES = [
    "version: 1",
    `expert: ${EXPERT}`,
    "status: in-use",
    `last_trained: ${TRAINED_AT}`,
    "areas:",
    `  - id: ${AREA}`,
    "    title: OAuth authorisation code exchange",
    "    level: 0",
    `    train_prompt: tldrx expert train ${EXPERT} --area ${AREA} --mode full`,
    "    evidence: []",
    "",
  ].join("\n");

  function rescorable(): TrainingWorkspace {
    return workspace({
      files: {
        [`.tldrx/experts/${EXPERT}/expert.md`]: CODE_ONLY_DOMAIN,
        [`.tldrx/experts/${EXPERT}/competencies.yml`]: COMPETENCIES,
        [`.tldrx/experts/${EXPERT}/knowledge/from-runs-${AREA}.md`]: fromRunsMd(),
      },
    });
  }

  test("the run-record rows land, dated by the training that read them", () => {
    const ws = rescorable();
    const rows = rescoreExperts({ root: ws.root, expert: EXPERT, area: null, actor: "alan", at: TRAIN_AT, now: TRAIN_NOW });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.skipped).toBeNull();
    expect(rows[0]?.added).toBeGreaterThanOrEqual(2);
    expect(rows[0]?.levelAfter).toBeGreaterThan(0);
    // Dated by the reading, not by the clock — `now` is 2026-09-01.
    expect(rows[0]?.at).toBe("2026-08-20");

    const written = readFileSync(join(ws.root, ".tldrx", "experts", EXPERT, "competencies.yml"), "utf8");
    expect(written).toContain("tldrx-work/260820-oauth/02-how/handoff.md:12");
    expect(written).toContain("tldrx-work/260820-oauth/retro.md:4");
    // Not a training run: it must not claim to have been one.
    expect(written).toContain("status: in-use");
    expect(written).toContain(`last_trained: ${TRAINED_AT}`);
  });

  test("running it twice adds nothing the second time", () => {
    const ws = rescorable();
    const first = rescoreExperts({ root: ws.root, expert: EXPERT, area: null, actor: "alan", at: TRAIN_AT, now: TRAIN_NOW });
    const second = rescoreExperts({ root: ws.root, expert: EXPERT, area: null, actor: "alan", at: TRAIN_AT, now: TRAIN_NOW });
    expect(first[0]?.added).toBeGreaterThan(0);
    expect(second[0]?.added).toBe(0);
    expect(second[0]?.levelAfter).toBe(first[0]?.levelAfter);
  });

  test("a knowledge file whose area no longer exists is skipped with a reason", () => {
    const ws = workspace({
      files: {
        [`.tldrx/experts/${EXPERT}/expert.md`]: CODE_ONLY_DOMAIN,
        [`.tldrx/experts/${EXPERT}/competencies.yml`]: COMPETENCIES,
        [`.tldrx/experts/${EXPERT}/knowledge/from-runs-retired.md`]: fromRunsMd(),
      },
    });
    const rows = rescoreExperts({ root: ws.root, expert: EXPERT, area: null, actor: "alan", at: TRAIN_AT, now: TRAIN_NOW });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.added).toBe(0);
    expect(rows[0]?.skipped).toContain("no area");
  });
});

// --- 5: a free rescore may not leave the ledger contradicting the file -------

/**
 * §7 — "audit records never lie in the dangerous direction" — applied to the
 * command that exists to rescue workspaces whose ledger already says they earned
 * nothing.
 *
 * The dangerous state, built and measured on the first cut of `rescore`: a
 * `training.jsonl` holding a `check.passed` dated 2026-08-20 that asserts
 * `evidence_added: 0` — the record #154 itself produced — and a
 * `competencies.yml` that, after a $0 rescore run on 2026-09-01, holds real rows
 * DATED 2026-08-20 and a level that moved 0 → 1. The ledger was byte-identical
 * afterwards. Read together the two files contradict each other: one asserts
 * nothing was earned on a date the other now disproves, and nothing anywhere
 * says a free re-derivation on a later date is what actually wrote the rows.
 *
 * Two provenances, because there are two facts and they have different dates.
 * The CLAIM was read out of the code on 2026-08-20, and `at` keeps that date —
 * §2.6 weighs recency, and stamping today on an August reading would raise every
 * level in a workspace that merely ran this command. The SCORING happened on
 * 2026-09-01 for $0, and that is what `rescored_at` on the row and the
 * `evidence.rescored` line in the ledger say. Neither date is asked to stand for
 * the other, and the ledger record is NOT backdated to match the rows.
 */
describe("a rescore leaves a record that does not contradict the file", () => {
  const TRAINED_AT = "2026-08-20T09:00:00Z";
  const COMPETENCIES = [
    "version: 1",
    `expert: ${EXPERT}`,
    "status: in-use",
    `last_trained: ${TRAINED_AT}`,
    "areas:",
    `  - id: ${AREA}`,
    "    title: OAuth authorisation code exchange",
    "    level: 0",
    "    evidence: []",
    "",
  ].join("\n");

  /** The record #154 produced: a paid pass that validated and earned nothing. */
  const PRIOR_LEDGER = `${JSON.stringify({
    ts: TRAINED_AT,
    expert: EXPERT,
    area: AREA,
    type: "check.passed",
    actor: "alan",
    cost_usd: 1.61,
    payload: { mode: "full", evidence_added: 0, evidence_total: 0, level_before: 0, level_after: 0 },
  })}\n`;

  function affected(): TrainingWorkspace {
    return workspace({
      files: {
        [`.tldrx/experts/${EXPERT}/expert.md`]: CODE_ONLY_DOMAIN,
        [`.tldrx/experts/${EXPERT}/competencies.yml`]: COMPETENCIES,
        [`.tldrx/experts/${EXPERT}/knowledge/from-runs-${AREA}.md`]: fromRunsMd(),
        [`.tldrx/experts/${EXPERT}/training.jsonl`]: PRIOR_LEDGER,
      },
    });
  }

  const ledgerPath = (root: string): string =>
    join(root, ".tldrx", "experts", EXPERT, "training.jsonl");

  function ledger(root: string): readonly {
    ts: string; type: string; cost_usd: number; payload: Record<string, unknown>;
  }[] {
    return readFileSync(ledgerPath(root), "utf8").split("\n").filter((line) => line !== "")
      .map((line) => JSON.parse(line) as {
        ts: string; type: string; cost_usd: number; payload: Record<string, unknown>;
      });
  }

  test("every row it writes says on its face that it was not earned by a paid turn", () => {
    const ws = affected();
    const rows = rescoreExperts({
      root: ws.root, expert: EXPERT, area: null, actor: "alan", at: TRAIN_AT, now: TRAIN_NOW,
    });
    expect(rows[0]?.added).toBeGreaterThan(0);

    const written = readFileSync(
      join(ws.root, ".tldrx", "experts", EXPERT, "competencies.yml"), "utf8",
    );
    // A GUARD, not the proof: the claim keeps the date it was read on. It held
    // before this change too, and it must keep holding — recency is weighed, and
    // a rescore that moved `at` would be a way to make August evidence look like
    // today's.
    expect(written).toContain("at: 2026-08-20");
    // …and every row carries the date it was SCORED on, which is not that date.
    const rescoredAt = written.split("\n").filter((line) => line.includes("rescored_at"));
    expect(rescoredAt).not.toHaveLength(0);
    for (const line of rescoredAt) expect(line).toContain("2026-09-01");
  });

  test("the ledger gains a $0 record of the rescore, dated when it ran", () => {
    const ws = affected();
    const before = ledger(ws.root);
    rescoreExperts({ root: ws.root, expert: EXPERT, area: null, actor: "alan", at: TRAIN_AT, now: TRAIN_NOW });
    const after = ledger(ws.root);

    // Append-only: the record that says `evidence_added: 0` is untouched.
    expect(after.slice(0, before.length)).toEqual([...before]);

    const rescored = after.filter((row) => row.type === "evidence.rescored");
    expect(rescored).toHaveLength(1);
    // Dated when it RAN, never backdated to match the rows it wrote.
    expect(rescored[0]?.ts).toBe(TRAIN_AT);
    expect(rescored[0]?.ts).not.toBe(TRAINED_AT);
    expect(rescored[0]?.cost_usd).toBe(0);
    expect(rescored[0]?.payload.spawned).toBe(0);
    expect(rescored[0]?.payload.level_before).toBe(0);
    expect(rescored[0]?.payload.level_after).toBeGreaterThan(0);
    // And it says which date the rows it wrote actually carry, so the two
    // clocks in this record can never be mistaken for one.
    expect(rescored[0]?.payload.dated_at).toBe("2026-08-20");
  });

  test("a second rescore changes nothing, so it records nothing", () => {
    const ws = affected();
    const competencies = join(ws.root, ".tldrx", "experts", EXPERT, "competencies.yml");
    rescoreExperts({ root: ws.root, expert: EXPERT, area: null, actor: "alan", at: TRAIN_AT, now: TRAIN_NOW });
    const ledgerAfterFirst = readFileSync(ledgerPath(ws.root), "utf8");
    const fileAfterFirst = readFileSync(competencies, "utf8");

    rescoreExperts({ root: ws.root, expert: EXPERT, area: null, actor: "alan", at: TRAIN_AT, now: TRAIN_NOW });
    expect(readFileSync(ledgerPath(ws.root), "utf8")).toBe(ledgerAfterFirst);
    // And the provenance survives the round trip: the reader has to carry
    // `rescored_at` back off disk, or the second write quietly re-emits these
    // rows as though a paid turn had earned them.
    expect(readFileSync(competencies, "utf8")).toBe(fileAfterFirst);
    expect(fileAfterFirst).toContain("rescored_at: 2026-09-01");
  });

  /**
   * A GUARD, not a red-first proof: this passed the moment `rescored_at` was
   * added, because `readEvidenceRows` keeps the value verbatim rather than
   * validating it. It is written down because that is the most reversible line
   * in this change.
   *
   * `rescored_at` sits beside `confidence` in the same reader, and `confidence`
   * is validate-and-drop. Making the two consistent is the obvious tidy, it is a
   * two-character edit, and the ENTIRE shipped suite stays green when someone
   * makes it — measured. What that tidy actually does is delete the marker off
   * any row it cannot parse and re-emit the row with nothing on it, which reads
   * as a paid training turn. That is the exact defect this half of #154 exists
   * to end, reintroduced silently and in the dangerous direction (§7). The
   * asymmetry is deliberate: `confidence` changes a WEIGHT, so dropping a value
   * nothing understands is conservative; `rescored_at` changes what the row
   * CLAIMS about itself, where dropping is the opposite of conservative.
   *
   * The assertion is the field name and the byte-for-byte value, not a word that
   * innocent prose could satisfy (§8).
   */
  test("a `rescored_at` the reader cannot parse survives a read-write round trip", () => {
    const UNPARSEABLE = "not-a-date";
    const ws = workspace({
      files: {
        [`.tldrx/experts/${EXPERT}/expert.md`]: CODE_ONLY_DOMAIN,
        [`.tldrx/experts/${EXPERT}/competencies.yml`]: [
          "version: 1",
          `expert: ${EXPERT}`,
          "status: in-use",
          `last_trained: ${TRAINED_AT}`,
          "areas:",
          `  - id: ${AREA}`,
          "    title: OAuth authorisation code exchange",
          "    level: 0",
          "    evidence:",
          "      - kind: run",
          "        src: tldrx-work/260101-legacy/retro.md:2",
          "        at: 2026-01-01",
          `        rescored_at: ${UNPARSEABLE}`,
          "",
        ].join("\n"),
        [`.tldrx/experts/${EXPERT}/knowledge/from-runs-${AREA}.md`]: fromRunsMd(),
      },
    });
    const competencies = join(ws.root, ".tldrx", "experts", EXPERT, "competencies.yml");

    // Any write of this file reads every existing row back through
    // `readEvidenceRows` and re-emits it. A rescore is the one to hand.
    rescoreExperts({ root: ws.root, expert: EXPERT, area: null, actor: "alan", at: TRAIN_AT, now: TRAIN_NOW });

    const written = readFileSync(competencies, "utf8");
    // The row is still there, still refusing to claim it was paid for.
    expect(written).toContain("src: tldrx-work/260101-legacy/retro.md:2");
    expect(written).toContain(`rescored_at: ${UNPARSEABLE}`);
  });
});
