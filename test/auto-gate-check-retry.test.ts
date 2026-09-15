/**
 * gh #231 (B) — an `auto` gate refused ONLY by failed checks re-runs its stage, once,
 * instead of stranding an unattended loop.
 *
 * Measured 2026-09-14 on an unattended validation run (tldrx 0.27.0): the What stage's
 * auto gate was refused by `claim-sources`, and `run auto --wait-gates` did what it has
 * always done with a refused auto gate — waited for a person. A person then ran
 * `tldrx reject --and-continue --note '<the finding>'`: exactly the move a machine holding
 * the finding could have made. Intervention #2 of that run.
 *
 * The ends pinned here:
 *
 *   RETRIED    checks-only refusal under --wait-gates ⇒ one `gate.rejected` with
 *              `and_continue`, signed `run auto` (never a person's name, never `auto`,
 *              which is the gate's own signature), the findings as the note — and the
 *              stage re-runs with them and the run carries on.
 *   BOUNDED    past `AUTO_GATE_CHECK_RETRIES` the loop waits for a person, and says why.
 *   HUMAN      a `human` gate is never retried, whatever holds it.
 *   OTHER HOLD a refusal that also names questions (or budget, stories, boundary, status,
 *              an unverified citation) is not retried — those have their own paths.
 *   NO WAIT    without --wait-gates nothing changes: the loop stops on exit 4.
 *
 * Hermetic: each workspace is its own temp directory; the only process spawned is the
 * fake `claude` inside it.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";
import { runAuto, type AutoOptions } from "../src/core/facilitator/runAuto.ts";
import { EventLog } from "../src/core/events/EventLog.ts";
import type { TldrxEvent } from "../src/core/events/Event.ts";
import {
  AUTO_GATE_CHECK_RETRIES, AUTO_GATE_RETRY_ACTOR, AUTO_GATE_RETRY_NOTE_PREFIX, checkRetryVerdict,
  heldBy, heldByNote, refusalNote, warnedByNote,
  type AutoGateVerdict,
} from "../src/core/run/autoGate.ts";
import {
  cannedHandoff, cannedIntent, makeFacilitatorWorkspace, type FacilitatorWorkspace, type StageOptions,
} from "./fixtures/facilitator/workspace.ts";

setDefaultTimeout(spawnTestTimeout(90_000));

const ORIGINAL_PATH = process.env.PATH ?? "";
const FAKE_KEYS = [
  "FAKE_CLAUDE_RUNDIR", "FAKE_CLAUDE_OUTPUTS", "FAKE_CLAUDE_COST", "FAKE_CLAUDE_ALT_MATCH", "FAKE_CLAUDE_ALT_OUTPUTS",
] as const;
let open: FacilitatorWorkspace[] = [];

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  for (const key of FAKE_KEYS) delete process.env[key];
  for (const ws of open) ws.dispose();
  open = [];
});

const ALPHA: StageOptions = {
  id: "alpha", phase: "01-what", budgetUsd: 6, gate: "approve",
  outputs: [
    { path: "01-what/intent.md", sections: ["Intent", "Scope"] },
    { path: "01-what/handoff.md", sections: ["Findings", "Decisions", "Unknowns", "Evidence ledger"] },
  ],
  // No DECLARED checks: a declared post-write `claim-sources` that fails fails the STAGE
  // (exit 5, `--retry-failed`'s path). The field refusal came from the auto gate's own
  // condition 5, which runs `claim-sources` whether or not the stage declares it — so
  // the stage ends `awaiting_gate` and the gate is what refuses, as it did on 2026-09-14.
  checks: "[]",
};
const BETA: StageOptions = {
  id: "beta", phase: "02-how", budgetUsd: 4, gate: "approve",
  outputs: [{ path: "02-how/handoff.md", sections: ["Findings", "Decisions", "Unknowns", "Evidence ledger"] }],
  checks: "[claim-sources]",
};

/** A handoff `claim-sources` REFUSES — a checked absence the file contradicts. */
function refusedHandoff(): string {
  return cannedHandoff().replace(
    "- none [src: absent:.tldrx/memory/notes.md]",
    "- none [src: absent:retention.md#30 days]",
  );
}

/** One open, blocking question in §2.7 grammar. */
const QUESTIONS = [
  "# Questions — 01-what",
  "",
  "## Q1 · How long is a hunt allowed to stay open?",
  "<!-- id: Q1 | status: open | area: product | asked_by: product | asked_at: 2026-08-30T09:41:00Z -->",
  "Why asked: no expiry is recorded anywhere [src: absent:.tldrx/memory/facts.yml]",
  "",
  "- A) 24 hours",
  "- B) 7 days",
  "",
  "[Answer]:",
  "",
].join("\n");

function workspace(options: {
  gates: Readonly<Record<string, string>>;
  /** What the RE-RUN writes, when the retry's note reaches its prompt. Absent: the same refused handoff. */
  fixedOnRetry?: boolean;
  questions?: string;
}): FacilitatorWorkspace {
  const made = makeFacilitatorWorkspace({ scope: "demo", stages: [ALPHA, BETA], budgetUsd: 20, gates: options.gates });
  open.push(made);
  writeFileSync(join(made.root, "retention.md"), "# Retention\n\nRows are kept for 30 days.\n", "utf8");
  process.env.PATH = made.binDir;
  process.env.FAKE_CLAUDE_RUNDIR = made.runDir;
  const first = {
    "01-what/intent.md": cannedIntent(),
    "01-what/handoff.md": refusedHandoff(),
    "02-how/handoff.md": cannedHandoff(),
    ...(options.questions === undefined ? {} : { "01-what/questions.md": options.questions }),
  };
  process.env.FAKE_CLAUDE_OUTPUTS = JSON.stringify(first);
  if (options.fixedOnRetry === true) {
    // The fake writes this set only when the prompt carries the loop's note — i.e. only
    // on the re-run the retry caused, which is the claim under test.
    process.env.FAKE_CLAUDE_ALT_MATCH = AUTO_GATE_RETRY_NOTE_PREFIX;
    process.env.FAKE_CLAUDE_ALT_OUTPUTS = JSON.stringify({ ...first, "01-what/handoff.md": cannedHandoff() });
  }
  process.env.FAKE_CLAUDE_COST = "0.42";
  return made;
}

function auto(ws: FacilitatorWorkspace, overrides: Partial<AutoOptions> = {}): Promise<{ code: number; lines: readonly string[] }> {
  return runAuto({ root: ws.root, yolo: false, actor: "alan", at: "2026-09-14T23:44:00Z", ...overrides });
}

function events(ws: FacilitatorWorkspace): readonly TldrxEvent[] {
  return EventLog.forRun(ws.runDir).read();
}

function starts(ws: FacilitatorWorkspace, stage: string): number {
  return events(ws).filter((e) => e.type === "stage.started" && e.stage === stage).length;
}

function rejections(ws: FacilitatorWorkspace): readonly TldrxEvent[] {
  return events(ws).filter((e) => e.type === "gate.rejected" && e.stage === "alpha");
}

describe("an auto gate refused only by failed checks re-runs its stage (#231)", () => {
  test("RETRIED — one signed re-run with the findings as the note, and the run carries on", async () => {
    const ws = workspace({ gates: { alpha: "auto", beta: "auto" }, fixedOnRetry: true });

    const outcome = await auto(ws, { waitGatesMs: spawnTestTimeout(20_000) });

    const rejected = rejections(ws);
    expect(rejected.length).toBe(1);
    expect(rejected[0]?.actor).toBe(AUTO_GATE_RETRY_ACTOR);
    expect(rejected[0]?.payload.and_continue).toBe(true);
    // The finding itself, not a paraphrase: the line the stage has to fix.
    expect(String(rejected[0]?.payload.note)).toStartWith(AUTO_GATE_RETRY_NOTE_PREFIX);
    expect(String(rejected[0]?.payload.note)).toContain("retention.md:3");
    expect(starts(ws, "alpha")).toBe(2);
    // The re-run passed and the gate signed itself the ordinary way.
    const approved = events(ws).filter((e) => e.type === "gate.approved" && e.stage === "alpha");
    expect(approved.length).toBe(1);
    expect(approved[0]?.payload.by).toBe("auto");
    expect(starts(ws, "beta")).toBe(1);
    expect(outcome.lines.some((line) => line.includes(`automatic re-run 1 of ${String(AUTO_GATE_CHECK_RETRIES)}`)))
      .toBe(true);
  });

  test("BOUNDED — past the bound the loop waits for a person and prints why", async () => {
    const ws = workspace({ gates: { alpha: "auto", beta: "auto" } });

    const outcome = await auto(ws, { waitGatesMs: spawnTestTimeout(1_500) });

    expect(outcome.code).toBe(4);
    expect(rejections(ws).length).toBe(AUTO_GATE_CHECK_RETRIES);
    expect(starts(ws, "alpha")).toBe(1 + AUTO_GATE_CHECK_RETRIES);
    expect(starts(ws, "beta")).toBe(0);
    expect(outcome.lines.some((line) => line.includes("not re-running") && line.includes("bound is spent")))
      .toBe(true);
  });

  test("HUMAN — a human gate refused by the same check is never retried", async () => {
    const ws = workspace({ gates: { alpha: "human", beta: "auto" } });

    const outcome = await auto(ws, { waitGatesMs: 600 });

    expect(outcome.code).toBe(4);
    expect(rejections(ws).length).toBe(0);
    expect(starts(ws, "alpha")).toBe(1);
  });

  test("OTHER HOLD — checks AND open questions: not retried, the questions have their own path", async () => {
    const ws = workspace({ gates: { alpha: "auto", beta: "auto" }, questions: QUESTIONS });

    const outcome = await auto(ws, { waitGatesMs: 600 });

    expect(outcome.code).toBe(4);
    expect(rejections(ws).length).toBe(0);
    expect(starts(ws, "alpha")).toBe(1);
  });

  test("NO WAIT — without --wait-gates the loop stops on exit 4 exactly as before", async () => {
    const ws = workspace({ gates: { alpha: "auto", beta: "auto" }, fixedOnRetry: true });

    const outcome = await auto(ws);

    expect(outcome.code).toBe(4);
    expect(rejections(ws).length).toBe(0);
    expect(starts(ws, "alpha")).toBe(1);
  });
});

describe("which refusals a re-run may answer (#231)", () => {
  function verdict(
    conditions: readonly { id: string; ok: boolean; detail: string; warning?: string }[],
  ): AutoGateVerdict {
    const failed = conditions.filter((c) => !c.ok && c.warning === undefined);
    return {
      ok: failed.length === 0,
      conditions,
      note: "",
      why: failed.map((c) => `${c.id}=${c.detail}`).join("; "),
      warnedBy: conditions.filter((c) => !c.ok && c.warning !== undefined).map((c) => c.id),
      failedChecks: [],
    };
  }

  test("a declared check and claim-sources failing: retried, with the findings", () => {
    const answer = checkRetryVerdict(verdict([
      { id: "checks", ok: false, detail: "claim-sources:failed" },
      { id: "questions", ok: true, detail: "0 open" },
      { id: "budget", ok: true, detail: "$0.42 of $6.00 stage" },
      { id: "claim-sources", ok: false, detail: "failed: L7: `30 days` IS at retention.md:3" },
    ]));
    expect(answer.retry).toBe(true);
    expect(answer.retry && answer.findings).toContain("retention.md:3");
  });

  test("budget in the held set: never retried, and the reason names it", () => {
    const answer = checkRetryVerdict(verdict([
      { id: "checks", ok: false, detail: "lint:failed" },
      { id: "budget", ok: false, detail: "$7.00 of $6.00 stage" },
    ]));
    expect(answer).toMatchObject({ retry: false, reason: expect.stringContaining("budget") });
  });

  test("an UNVERIFIED citation is a person's to judge: not retried", () => {
    const answer = checkRetryVerdict(verdict([
      { id: "claim-sources", ok: false, detail: "1 unverified citation(s) — unverified: 1" },
    ]));
    expect(answer).toMatchObject({ retry: false, reason: expect.stringContaining("unverified") });
  });

  test("stories or boundary in the held set: not retried", () => {
    for (const id of ["stories", "boundary", "status"]) {
      const answer = checkRetryVerdict(verdict([
        { id: "checks", ok: false, detail: "lint:failed" },
        { id, ok: false, detail: "held" },
      ]));
      expect(answer).toMatchObject({ retry: false, reason: expect.stringContaining(id) });
    }
  });

  /**
   * gh #331: a boundary that only WARNS an auto gate is not part of the refusal — not in
   * `held_by`, not a reason to skip a check re-run — and a refusal note still carries it.
   */
  test("a WARNING boundary is not in the held set: a checks-only refusal is still retried", () => {
    const v = verdict([
      { id: "checks", ok: false, detail: "lint:failed" },
      { id: "boundary", ok: false, detail: "1 outside — a human decides", warning: "1 outside — carried into the PR body" },
    ]);
    expect(heldBy(v)).toEqual(["checks"]);
    expect(checkRetryVerdict(v).retry).toBe(true);
    const note = refusalNote(v);
    expect(heldByNote(note)).toEqual(["checks"]);
    expect(warnedByNote(note)).toEqual(["boundary"]);
  });

  test("warnedByNote reads only a machine note, and only a plain id tail", () => {
    expect(warnedByNote("auto-gate: checks=none declared \u00b7 warned by: boundary")).toEqual(["boundary"]);
    expect(warnedByNote("looked fine \u00b7 warned by: boundary")).toEqual([]);
    expect(warnedByNote("auto-gate: boundary=1 outside: app:a \u00b7 warned by: b.cs; x")).toEqual([]);
    expect(warnedByNote("auto-gate: checks=none declared")).toEqual([]);
  });

  test("a passing verdict is not a refusal at all", () => {
    expect(checkRetryVerdict(verdict([{ id: "checks", ok: true, detail: "none declared" }])).retry).toBe(false);
  });
});
