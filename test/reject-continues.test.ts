/**
 * gh #242 — a rejection that means "redo it this way and carry on".
 *
 * `run auto` resumed after an approve and STOPPED after a reject, so on a phone the
 * button meaning "there is still work to do" was the one that ended the run. The issue
 * measured five consecutive live rejections, all of them meaning "continue"; the
 * documented rationale for stopping ("resuming would re-spend the stage on a decision
 * the person who rejected it has not been shown the result of") is real for the OTHER
 * kind of rejection, so the rejection now says which kind it is.
 *
 * Both ends are asserted here, because "the default is unchanged" is half the claim:
 *
 *   DEFAULT    a bare `tldrx reject` still stops the loop with exit 4 and the note.
 *   OPT-IN     `tldrx reject --and-continue` puts the stage back to `ready` exactly as
 *              before and the loop re-runs it instead of exiting.
 *   CARRIED    the bit travels on the gate record the rejecting PROCESS writes, the
 *              same field `waitForGate` already reads `status` off — no second
 *              derivation, and a gate written before this existed reads as "stop".
 *
 * Hermetic: each workspace is its own temp directory, the only processes spawned are
 * the fake `claude` and the notifier script inside it.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";
import { deliveredTo, writeNotifier, workspaceYamlWithNotify } from "./fixtures/facilitator/notifier.ts";
import { runAuto, type AutoOptions } from "../src/core/facilitator/runAuto.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { reject } from "../src/core/run/gates.ts";
import { rejectCommand } from "../src/cli/commands/reject.ts";
import { EventLog } from "../src/core/events/EventLog.ts";
import type { TldrxEvent } from "../src/core/events/Event.ts";
import {
  cannedHandoff, cannedIntent, makeFacilitatorWorkspace, type FacilitatorWorkspace, type StageOptions,
} from "./fixtures/facilitator/workspace.ts";

setDefaultTimeout(spawnTestTimeout(60_000));

const ORIGINAL_PATH = process.env.PATH ?? "";
const FAKE_KEYS = ["FAKE_CLAUDE_RUNDIR", "FAKE_CLAUDE_OUTPUTS", "FAKE_CLAUDE_COST"] as const;
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
  checks: "[claim-sources]",
};
const BETA: StageOptions = {
  id: "beta", phase: "02-how", budgetUsd: 4, gate: "approve",
  outputs: [{ path: "02-how/handoff.md", sections: ["Findings", "Decisions", "Unknowns", "Evidence ledger"] }],
  checks: "[claim-sources]",
};

interface Made extends FacilitatorWorkspace {
  readonly outbox: string;
}

function workspace(): Made {
  const outbox = "notified.jsonl";
  const made = makeFacilitatorWorkspace({
    scope: "demo", stages: [ALPHA, BETA], budgetUsd: 10, gates: { alpha: "human", beta: "human" },
  });
  open.push(made);
  const script = writeNotifier(made.root);
  writeFileSync(
    join(made.root, ".tldrx", "workspace.yml"),
    workspaceYamlWithNotify(`${script} ${join(made.root, outbox)}`),
    "utf8",
  );
  process.env.PATH = made.binDir;
  process.env.FAKE_CLAUDE_RUNDIR = made.runDir;
  process.env.FAKE_CLAUDE_OUTPUTS = JSON.stringify({
    "01-what/intent.md": cannedIntent(),
    "01-what/handoff.md": cannedHandoff(),
    "02-how/handoff.md": cannedHandoff(),
  });
  process.env.FAKE_CLAUDE_COST = "0.42";
  return { ...made, outbox: join(made.root, outbox) };
}

function auto(ws: Made, overrides: Partial<AutoOptions> = {}): Promise<{ code: number; lines: readonly string[] }> {
  return runAuto({ root: ws.root, yolo: false, actor: "alan", at: "2026-08-29T09:00:00Z", ...overrides });
}

function events(ws: Made): readonly TldrxEvent[] {
  return EventLog.forRun(ws.runDir).read();
}

/**
 * Reject the gate once the loop is demonstrably parked on it.
 *
 * The signal is the loop's own heartbeat (`waiting_on_gate`), as `auto-gate-questions`
 * does it — a bare `setTimeout` races the park. The rejection goes through `reject()`,
 * the one function `tldrx reject` calls, from a store this test opened itself: that is
 * the real shape, a DIFFERENT process from the one waiting.
 */
async function rejectWhenWaiting(ws: Made, andContinue: boolean): Promise<boolean> {
  for (let i = 0; i < 1200; i++) {
    const parked = deliveredTo(ws.outbox).some(
      (payload) => payload.kind === "status"
        && (payload.detail as { waiting_on_gate?: unknown }).waiting_on_gate !== undefined,
    );
    if (parked) {
      reject(RunStore.open(ws.runDir), {
        root: ws.root,
        actor: "alan",
        at: "2026-08-29T09:05:00Z",
        note: "faltan 4 stories sin arrancar; continuar el build",
        andContinue,
      });
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

function gateOfAlpha(store: RunStore): { readonly and_continue?: true } {
  const alpha = store.run.phases.flatMap((phase) => phase.stages).find((stage) => stage.id === "alpha");
  if (alpha === undefined) throw new Error("no alpha stage");
  return alpha.gate;
}

function alphaStarts(ws: Made): number {
  return events(ws).filter((e) => e.type === "stage.started" && e.stage === "alpha").length;
}

describe("a rejection says whether the loop may carry on (#242)", () => {
  test("DEFAULT — a bare rejection stops the loop, exactly as before", async () => {
    const ws = workspace();
    const rejecting = rejectWhenWaiting(ws, false);

    const outcome = await auto(ws, { waitGatesMs: spawnTestTimeout(4_000), notifyEveryMs: 40 });
    expect(await rejecting).toBe(true);

    expect(outcome.code).toBe(4);
    expect(outcome.lines.some((line) => line.includes("was REJECTED"))).toBe(true);
    expect(outcome.lines.some((line) => line.includes("continuar el build"))).toBe(true);
    // It did NOT re-run the stage it was told to stop at.
    expect(alphaStarts(ws)).toBe(1);
  });

  test("OPT-IN — `--and-continue` re-runs the rejected stage instead of exiting", async () => {
    const ws = workspace();
    const rejecting = rejectWhenWaiting(ws, true);

    const outcome = await auto(ws, { waitGatesMs: spawnTestTimeout(4_000), notifyEveryMs: 40 });
    expect(await rejecting).toBe(true);

    expect(outcome.lines.some((line) => line.includes("REJECTED") && line.includes("resuming")))
      .toBe(true);
    // The rejection's own semantics are untouched: the stage went back to `ready` with
    // the note, and the loop re-ran it — the note reaches the next prompt either way.
    expect(events(ws).some((e) => e.type === "gate.rejected" && e.stage === "alpha")).toBe(true);
    expect(alphaStarts(ws)).toBeGreaterThanOrEqual(2);
  });

  test("REFUSED — `--and-continue` beside `--stage`, which is a revoke, not a rejection", async () => {
    const ws = workspace();
    expect((await auto(ws)).code).toBe(4);
    const stderr: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    // A narrowed stub for one call, restored immediately.
    process.stderr.write = (chunk: string): boolean => { stderr.push(String(chunk)); return true; };
    let exit: number;
    try {
      exit = await rejectCommand.run([
        "--root", ws.root, "--and-continue", "--stage", "01-what/alpha", "--note", "take it back",
      ]);
    } finally {
      process.stderr.write = original;
    }
    expect(exit).toBe(1);
    expect(stderr.join("")).toContain("--and-continue");
    // It refused rather than half-doing it: the gate is untouched.
    expect(gateOfAlpha(RunStore.open(ws.runDir)).and_continue).toBeUndefined();
  });

  test("CARRIED — the flag is recorded on the gate, and a bare rejection records nothing", async () => {
    const asked = workspace();
    expect((await auto(asked)).code).toBe(4);
    reject(RunStore.open(asked.runDir), {
      root: asked.root, actor: "alan", at: "2026-08-29T09:05:00Z", note: "redo it", andContinue: true,
    });
    const withFlag = RunStore.open(asked.runDir);
    expect(gateOfAlpha(withFlag).and_continue).toBe(true);
    expect(readFileSync(join(asked.runDir, "run.yml"), "utf8")).toContain("and_continue: true");

    const bare = workspace();
    expect((await auto(bare)).code).toBe(4);
    reject(RunStore.open(bare.runDir), {
      root: bare.root, actor: "alan", at: "2026-08-29T09:05:00Z", note: "stop, I will look",
    });
    // Absent, not `false`: a run.yml written before this field existed is byte-identical
    // to one written by a bare rejection today, and both read as "stop".
    expect(gateOfAlpha(RunStore.open(bare.runDir)).and_continue).toBeUndefined();
    expect(readFileSync(join(bare.runDir, "run.yml"), "utf8")).not.toContain("and_continue");
  });
});
