/** One line of `tldrx-work/<run>/events.jsonl` (spec §2.9). */
import {
  asDocument, requireEnum, requireKeys, requireNumber, requireString, result,
  type ValidationIssue, type ValidationResult,
} from "../schemas/validation.ts";

/** Closed set — an unknown type is a validation error (spec §2.9). */
export const EVENT_TYPES = [
  "run.created", "run.closed",
  "phase.started", "phase.done",
  "stage.started", "stage.done", "stage.failed", "stage.skipped",
  "task.started", "task.done",
  "agent.spawned", "agent.result",
  "question.asked", "question.answered",
  "gate.requested", "gate.approved", "gate.rejected",
  "check.passed", "check.failed",
  "budget.warned", "budget.blocked",
  "fact.added", "fact.retired",
  "map.refreshed",
  "ticket.synced",
  "error",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** The envelope, in the key order the file is written in. */
export const EVENT_KEYS = ["ts", "run", "stage", "type", "actor", "cost_usd", "payload"] as const;

export const MAX_LINE_BYTES = 8 * 1024;
export const MAX_PAYLOAD_BYTES = 4 * 1024;
export const MAX_PAYLOAD_DEPTH = 3;

export interface TldrxEvent {
  readonly ts: string;
  readonly run: string;
  readonly stage: string | null;
  readonly type: EventType;
  readonly actor: string;
  readonly cost_usd: number;
  readonly payload: Readonly<Record<string, unknown>>;
}

export function validateEvent(input: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  const doc = asDocument(input, issues);
  if (!doc) return result(issues);

  requireKeys(doc, EVENT_KEYS, "", issues);
  for (const key of Object.keys(doc)) {
    if (!(EVENT_KEYS as readonly string[]).includes(key)) {
      issues.push({ path: key, message: `unexpected key \`${key}\` — the envelope is exactly ${EVENT_KEYS.join(", ")}` });
    }
  }
  requireString(doc.ts, "ts", issues);
  requireString(doc.run, "run", issues);
  if (doc.stage !== null) requireString(doc.stage, "stage", issues);
  requireEnum(doc.type, EVENT_TYPES, "type", issues);
  requireString(doc.actor, "actor", issues);
  requireNumber(doc.cost_usd, "cost_usd", issues);
  if (typeof doc.cost_usd === "number" && doc.cost_usd < 0) {
    issues.push({ path: "cost_usd", message: "must be >= 0" });
  }
  if (typeof doc.payload !== "object" || doc.payload === null || Array.isArray(doc.payload)) {
    issues.push({ path: "payload", message: "expected an object" });
  } else {
    const bytes = Buffer.byteLength(JSON.stringify(doc.payload), "utf8");
    if (bytes > MAX_PAYLOAD_BYTES) {
      issues.push({ path: "payload", message: `${bytes} bytes exceeds the ${MAX_PAYLOAD_BYTES} byte cap` });
    }
    const depth = objectDepth(doc.payload);
    if (depth > MAX_PAYLOAD_DEPTH) {
      issues.push({ path: "payload", message: `nesting depth ${depth} exceeds ${MAX_PAYLOAD_DEPTH}` });
    }
  }
  return result(issues);
}

/** Serialize with the seven keys in spec order — the file is diffed by humans. */
export function serializeEvent(event: TldrxEvent): string {
  return JSON.stringify({
    ts: event.ts,
    run: event.run,
    stage: event.stage,
    type: event.type,
    actor: event.actor,
    cost_usd: event.cost_usd,
    payload: event.payload,
  });
}

function objectDepth(value: unknown, depth = 1): number {
  if (typeof value !== "object" || value === null) return depth - 1;
  let deepest = depth;
  for (const child of Object.values(value as Record<string, unknown>)) {
    if (typeof child === "object" && child !== null) {
      deepest = Math.max(deepest, objectDepth(child, depth + 1));
    }
  }
  return deepest;
}
