/**
 * Per-attempt cost for one stage, read off `events.jsonl`.
 *
 * `run.yml` carries a stage's *total* `cost_usd`, which is the right number for a
 * budget and the wrong one for the question an operator actually asks after a
 * failure: "what did the first try cost, and can I afford another?" A stage that
 * shows `$2.60` might be one $2.60 attempt or two $1.30 ones, and only the second
 * case tells you the retry fits.
 *
 * The ledger already holds it: one `agent.result` per sub-agent invocation, each
 * carrying its own `cost_usd` (spec §2.9). `[assumption]` — v0 spawns one
 * sub-agent per stage run, so one `agent.result` is one attempt; a future stage
 * with parallel tasks would need `payload.task` to group them.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TldrxEvent } from "../events/Event.ts";

export interface StageAttempts {
  readonly phase: string;
  readonly stage: string;
  /** One entry per `agent.result`, in ledger order. */
  readonly costs: readonly number[];
  readonly total_usd: number;
}

/** Never throws: a missing or half-written ledger yields no attempts. */
export function stageAttempts(runDir: string, phase: string, stage: string): StageAttempts {
  const costs: number[] = [];
  for (const event of readEvents(join(runDir, "events.jsonl"))) {
    if (event.type !== "agent.result" || event.stage !== stage) continue;
    const eventPhase = (event.payload as { phase?: unknown }).phase;
    if (typeof eventPhase === "string" && eventPhase !== phase) continue;
    costs.push(typeof event.cost_usd === "number" ? event.cost_usd : 0);
  }
  return { phase, stage, costs, total_usd: round(costs.reduce((sum, c) => sum + c, 0)) };
}

/** `attempts: 2 · $1.39 + $1.21`, or null when the stage has not run yet. */
export function renderAttempts(attempts: StageAttempts): string | null {
  if (attempts.costs.length === 0) return null;
  const each = attempts.costs.map((c) => `$${c.toFixed(2)}`).join(" + ");
  return `attempts: ${String(attempts.costs.length)} · ${each}`;
}

function readEvents(path: string): readonly TldrxEvent[] {
  if (!existsSync(path)) return [];
  const events: TldrxEvent[] = [];
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return events;
  }
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      events.push(JSON.parse(line) as TldrxEvent);
    } catch {
      // A half-written last line is not a reason to report no attempts at all.
    }
  }
  return events;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
