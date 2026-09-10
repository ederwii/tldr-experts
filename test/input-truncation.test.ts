/**
 * gh #207 — the two things a killed, half-fed turn never told the person paying.
 *
 * Measured on a real workspace (run `260908-tenant-scoped-writes`, tldrx 0.14.1):
 * a `how` turn was handed a `facts.yml` of 168,873 B cut to 86,571 B by the
 * 98,304-byte `inputs_max_bytes` default, ran to `timeout_s`, was SIGKILLed, and
 * booked `metered: false` with an all-zero `usage`. Both facts existed — the
 * truncation in `.agent/how/prompt.md`, the kill in `stage.failed` — and neither
 * reached the owner: the truncation only ever went IN-BAND to the sub-agent, and
 * the usage the provider had already streamed died with the process.
 *
 * So two behaviours are pinned here, each with its own guard:
 *
 *  1. **A truncation is an event.** `input.truncated` carries the four numbers a
 *     person needs to act — which file, how big, how much got through, and the
 *     cap that decided — and it is absent when nothing was cut.
 *  2. **A killed turn keeps whatever usage arrived.** The Claude stream reports
 *     tokens per assistant message and dollars only on the final `result` line
 *     (measured, `test/fixtures/agent/stream-json.jsonl`: five `message.usage`
 *     frames, one `total_cost_usd`). So a kill can inherit TOKENS and never a
 *     price — and when not even a token frame arrived, the record says so in
 *     words instead of inventing a zero.
 *
 * Both halves run the REAL facilitator against a real run on disk, with the fake
 * `claude` first on PATH.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { runNext, type NextOptions } from "../src/core/facilitator/runNext.ts";
import { EventLog } from "../src/core/events/EventLog.ts";
import { EVENT_TYPES, type TldrxEvent } from "../src/core/events/Event.ts";
import { buildStatus, renderStatus } from "../src/core/run/runStatus.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { stageTruncations, truncationSentence } from "../src/core/run/truncations.ts";
import { stageDoneNotification, runEndNotification } from "../src/core/notify/notifications.ts";
import {
  cannedHandoff, cannedIntent, makeFacilitatorWorkspace, type FacilitatorWorkspace, type StageOptions,
} from "./fixtures/facilitator/workspace.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

setDefaultTimeout(spawnTestTimeout());

const ORIGINAL_PATH = process.env.PATH ?? "";
const FAKE_KEYS = [
  "FAKE_CLAUDE_RUNDIR", "FAKE_CLAUDE_OUTPUTS", "FAKE_CLAUDE_COST", "FAKE_CLAUDE_IS_ERROR",
  "FAKE_CLAUDE_READS", "FAKE_CLAUDE_HANG_MS", "FAKE_CLAUDE_SLEEP_MS",
] as const;

let open: FacilitatorWorkspace[] = [];

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  for (const key of FAKE_KEYS) delete process.env[key];
  for (const workspace of open) workspace.dispose();
  open = [];
});

/** A file whose size is exactly what the assertions quote. */
const BIG_PATH = ".tldrx/big.md";
const BIG_BYTES = 12 * 1024;
const CAP_BYTES = 4 * 1024;

const OUTPUTS = JSON.stringify({
  "01-what/intent.md": cannedIntent(),
  "01-what/handoff.md": cannedHandoff(),
});

function stage(overrides: Partial<StageOptions> = {}): StageOptions {
  return {
    id: "alpha",
    phase: "01-what",
    budgetUsd: 6,
    gate: "auto",
    optional: [BIG_PATH],
    outputs: [
      { path: "01-what/intent.md", sections: ["Intent", "Scope"] },
      { path: "01-what/handoff.md", sections: ["Findings", "Decisions", "Unknowns", "Evidence ledger"] },
    ],
    ...overrides,
  };
}

function workspace(one: StageOptions): FacilitatorWorkspace {
  const made = makeFacilitatorWorkspace({
    scope: "demo",
    stages: [one],
    budgetUsd: 10,
    files: { [BIG_PATH]: "x".repeat(BIG_BYTES) },
  });
  open.push(made);
  return made;
}

function fake(ws: FacilitatorWorkspace, env: Readonly<Record<string, string>> = {}): void {
  process.env.PATH = ws.binDir;
  process.env.FAKE_CLAUDE_RUNDIR = ws.runDir;
  process.env.FAKE_CLAUDE_OUTPUTS = OUTPUTS;
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
}

function next(ws: FacilitatorWorkspace, overrides: Partial<NextOptions> = {}): Promise<{ code: number; lines: readonly string[] }> {
  return runNext({
    root: ws.root,
    dryRun: false,
    mode: "headless",
    yolo: false,
    actor: "alan",
    at: "2026-08-28T09:00:00Z",
    ...overrides,
  });
}

function events(ws: FacilitatorWorkspace): readonly TldrxEvent[] {
  return EventLog.forRun(ws.runDir).read();
}

function ctx(ws: FacilitatorWorkspace): { runId: string; root: string; stage: string; at: string } {
  return { runId: ws.runId, root: ws.root, stage: "alpha", at: "2026-08-28T09:05:00Z" };
}

describe("a truncated input reaches the OWNER, not only the sub-agent (#207)", () => {
  test("`input.truncated` is a member of the closed event enum", () => {
    expect(EVENT_TYPES).toContain("input.truncated");
  });

  test("one event per cut input, carrying all four numbers", async () => {
    const ws = workspace(stage({ inputsMaxBytes: CAP_BYTES }));
    fake(ws);

    const outcome = await next(ws);
    expect(outcome.code).toBe(0);

    const cut = events(ws).filter((event) => event.type === "input.truncated");
    expect(cut).toHaveLength(1);
    expect(cut[0]?.stage).toBe("alpha");
    expect(cut[0]?.payload).toEqual({
      stage: "alpha",
      path: BIG_PATH,
      bytes: BIG_BYTES,
      inlined_bytes: CAP_BYTES,
      cap: CAP_BYTES,
    });
    // Never money: a truncation costs nothing and must not move any total.
    expect(cut[0]?.cost_usd).toBe(0);
  });

  test("GUARD — an input UNDER the cap writes no event at all", async () => {
    const ws = workspace(stage({ inputsMaxBytes: BIG_BYTES * 4 }));
    fake(ws);

    expect((await next(ws)).code).toBe(0);
    expect(events(ws).filter((event) => event.type === "input.truncated")).toHaveLength(0);
    expect(truncationSentence(stageTruncations(ws.runDir, "alpha"))).toBeNull();
  });

  test("the summary sentence names the file and both ends of the cut", async () => {
    const ws = workspace(stage({ inputsMaxBytes: CAP_BYTES }));
    fake(ws);
    await next(ws);

    const sentence = truncationSentence(stageTruncations(ws.runDir, "alpha"));
    expect(sentence).toBe("1 input truncated: big.md 12 KB → 4 KB (cap 4 KB).");

    // …and the summaries an owner actually receives carry it, with no new kind.
    expect(stageDoneNotification(ctx(ws), 0.42, 0, null, sentence).summary).toContain(sentence ?? "");
    // 8th positional: `note` (#164), then `outcome` (#210), then `truncation` —
    // every one of them appended rather than inserted, so this call names them all.
    expect(
      runEndNotification(ctx(ws), 1, 0.42, "the stage failed.", undefined, null, null, sentence).summary,
    ).toContain(sentence ?? "");
  });

  test("`run status --verbose` lists the truncation for the stage the run is parked on", async () => {
    const ws = workspace(stage({ inputsMaxBytes: CAP_BYTES }));
    fake(ws, { FAKE_CLAUDE_IS_ERROR: "1" });
    // A failed stage leaves the cursor where it is — the #207 shape exactly.
    expect((await next(ws)).code).not.toBe(0);

    const store = RunStore.open(ws.runDir);
    const view = buildStatus(store.run, store.budget, store.runDir);
    const quiet = renderStatus(view, false);
    const loud = renderStatus(view, true);
    expect(loud).toContain(BIG_PATH);
    expect(loud).toContain("inputs_max_bytes 4 KB");
    // The default screen stays a screen (#120).
    expect(quiet).not.toContain(BIG_PATH);
  });
});

describe("a killed turn keeps the usage the provider had already streamed (#207)", () => {
  test("one usage frame before the kill is recorded, with its basis, and still unmetered", async () => {
    const ws = workspace(stage({ timeoutS: 2, inputsMaxBytes: BIG_BYTES * 4 }));
    // One flushed assistant frame (which carries `message.usage`), then a hang
    // far past the stage's 2 s ceiling: the child is SIGKILLed mid-turn.
    fake(ws, { FAKE_CLAUDE_READS: "1", FAKE_CLAUDE_HANG_MS: "60000" });

    expect((await next(ws)).code).not.toBe(0);

    const result = events(ws).find((event) => event.type === "agent.result");
    expect(result?.payload).toMatchObject({
      metered: false,
      usage_basis: "partial-before-kill",
      usage: {
        input_tokens: 1234,
        output_tokens: 56,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    });
    // No dollars are invented: the stream carries `total_cost_usd` only on the
    // `result` line, which a killed turn never reaches.
    expect(result?.cost_usd).toBe(0);
  });

  test("nothing streamed before the kill is said in WORDS, never as a zero", async () => {
    const ws = workspace(stage({ timeoutS: 2, inputsMaxBytes: BIG_BYTES * 4 }));
    // Silent for a minute, then killed: not one byte of transcript arrived.
    fake(ws, { FAKE_CLAUDE_SLEEP_MS: "60000" });

    expect((await next(ws)).code).not.toBe(0);

    const result = events(ws).find((event) => event.type === "agent.result");
    expect(result?.payload).toMatchObject({
      metered: false,
      usage_basis: "absent",
      unmetered_reason: "killed before any usage was reported",
    });
    expect(result?.payload.usage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
  });

  test("GUARD — a turn that FINISHES carries neither key, so the ordinary record is unchanged", async () => {
    const ws = workspace(stage({ inputsMaxBytes: BIG_BYTES * 4 }));
    fake(ws);

    expect((await next(ws)).code).toBe(0);
    const result = events(ws).find((event) => event.type === "agent.result");
    expect(result?.payload).not.toHaveProperty("usage_basis");
    expect(result?.payload).not.toHaveProperty("unmetered_reason");
  });
});
