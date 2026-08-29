/**
 * `.tldrx/experts/<name>/training.jsonl` — the cost and provenance ledger of
 * every training run, append-only.
 *
 * `[assumption]` — spec §2.9's `events.jsonl` is **run-scoped**: its envelope
 * requires a `run` id, the file lives inside `tldrx-work/<run>/`, and its
 * consumers (`run status`, `replay`, `retro`, the dashboard) all read it as one
 * run's history. Training belongs to an EXPERT and outlives every run, so writing
 * it into a run's ledger would either need a run that does not exist or would
 * bury an expert's history across a dozen unrelated folders. It gets its own file
 * beside the expert instead, with §2.9's exact envelope shape — seven keys, one
 * line of JSON, closed `type` set, append enforced by byte length — and `run`
 * replaced by `expert`, `stage` by `area`. Everything true of an event line is
 * true of a training line except which thing it belongs to.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { TRAINING_LOG_FILE } from "./Training.ts";

/** The subset of §2.9's enum that a training run can honestly emit. */
export const TRAINING_EVENT_TYPES = ["agent.spawned", "agent.result", "check.failed", "check.passed"] as const;
export type TrainingEventType = (typeof TRAINING_EVENT_TYPES)[number];

export const TRAINING_KEYS = ["ts", "expert", "area", "type", "actor", "cost_usd", "payload"] as const;

export const MAX_LINE_BYTES = 8 * 1024;
export const MAX_PAYLOAD_BYTES = 4 * 1024;

export interface TrainingEvent {
  readonly ts: string;
  readonly expert: string;
  readonly area: string | null;
  readonly type: TrainingEventType;
  readonly actor: string;
  readonly cost_usd: number;
  readonly payload: Readonly<Record<string, unknown>>;
}

export function trainingLogPath(expertDirPath: string): string {
  return join(expertDirPath, TRAINING_LOG_FILE);
}

export class TrainingLog {
  constructor(readonly path: string) {}

  static forExpert(expertDirPath: string): TrainingLog {
    return new TrainingLog(trainingLogPath(expertDirPath));
  }

  get sizeBytes(): number {
    return existsSync(this.path) ? statSync(this.path).size : 0;
  }

  /**
   * Validate, then append one line. Throws rather than writing a bad record, and
   * refuses a write that would shorten the file — the same append-only proof
   * `EventLog` uses, because "the ledger got smaller" is the one corruption a
   * cost record must never survive.
   */
  append(event: TrainingEvent): void {
    const problem = validateTrainingEvent(event);
    if (problem !== null) throw new Error(`refusing to append an invalid training record: ${problem}`);

    const line = serializeTrainingEvent(event);
    const bytes = Buffer.byteLength(line, "utf8") + 1;
    if (bytes > MAX_LINE_BYTES) throw new Error(`training record is ${String(bytes)} bytes (max ${String(MAX_LINE_BYTES)})`);

    const before = this.sizeBytes;
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${line}\n`, "utf8");
    const after = this.sizeBytes;
    if (after < before + bytes) {
      throw new Error(`${TRAINING_LOG_FILE} shrank under an append (${String(before)} -> ${String(after)} bytes): the log is append-only`);
    }
  }

  read(): readonly TrainingEvent[] {
    if (!existsSync(this.path)) return [];
    const out: TrainingEvent[] = [];
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      out.push(JSON.parse(line) as TrainingEvent);
    }
    return out;
  }
}

/** Key order is the spec's, because humans diff this file. */
export function serializeTrainingEvent(event: TrainingEvent): string {
  return JSON.stringify({
    ts: event.ts,
    expert: event.expert,
    area: event.area,
    type: event.type,
    actor: event.actor,
    cost_usd: event.cost_usd,
    payload: event.payload,
  });
}

/** Null when valid; otherwise the first thing wrong with it. */
export function validateTrainingEvent(event: TrainingEvent): string | null {
  if (typeof event.ts !== "string" || event.ts === "") return "ts must be a non-empty RFC3339 string";
  if (typeof event.expert !== "string" || event.expert === "") return "expert must be a non-empty string";
  if (event.area !== null && typeof event.area !== "string") return "area must be a string or null";
  if (!(TRAINING_EVENT_TYPES as readonly string[]).includes(event.type)) {
    return `type must be one of ${TRAINING_EVENT_TYPES.join(", ")}`;
  }
  if (typeof event.actor !== "string" || event.actor === "") return "actor must be a non-empty string";
  if (typeof event.cost_usd !== "number" || !Number.isFinite(event.cost_usd) || event.cost_usd < 0) {
    return "cost_usd must be a number >= 0";
  }
  if (typeof event.payload !== "object" || event.payload === null || Array.isArray(event.payload)) {
    return "payload must be an object";
  }
  const bytes = Buffer.byteLength(JSON.stringify(event.payload), "utf8");
  if (bytes > MAX_PAYLOAD_BYTES) return `payload is ${String(bytes)} bytes (max ${String(MAX_PAYLOAD_BYTES)})`;
  return null;
}
