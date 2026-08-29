/**
 * The in-session handshake (spec §5, "Two execution modes").
 *
 * `tldrx next --prepare` writes `prompt.md` and `pending.json`; the Claude Code
 * session dispatches its own sub-agent with that prompt and writes
 * `result.json`; `tldrx next --commit` reads it and continues down the *same*
 * validation path the headless mode uses. The two files are the whole contract —
 * no daemon, no socket, no session state.
 *
 * Both live in `tldrx-work/<run>/.agent/<stage>/`, which is gitignored (spec §1).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentDir } from "./paths.ts";
import type { PlannedCheck } from "../run/workflowPreset.ts";
import type { EffortLevel } from "../schemas/stage.ts";

export const PROMPT_FILE = "prompt.md";
export const PENDING_FILE = "pending.json";
export const RESULT_FILE = "result.json";
export const RAW_FILE = "result.raw.json";

/** One expert the prompt loaded, and what it cost in bytes (spec §5). */
export interface PendingExpert {
  readonly name: string;
  /** Why it loaded: named by the stage, a stack expert for the repos, or a domain match. */
  readonly reason: "stage" | "stack" | "domain";
  /** For `domain`: the cited path or repo it matched on. */
  readonly match?: string;
  readonly expert_md_bytes: number;
  /** Bytes of `knowledge/*.md` content inlined — 0 for an expert never trained. */
  readonly knowledge_bytes: number;
  readonly knowledge_files: readonly string[];
  /** True when the byte budget cut a knowledge file short. */
  readonly truncated: boolean;
}

export interface PendingStage {
  readonly version: 1;
  readonly run: string;
  readonly phase: string;
  readonly stage: string;
  readonly expert: string | null;
  readonly model: string | null;
  /** `--effort` the sub-agent is to be spawned with. Null ⇒ the CLI's own default. */
  readonly effort?: EffortLevel | null;
  readonly budget_usd: number;
  readonly max_budget_usd: number;
  readonly prompt: string;
  readonly outputs: readonly string[];
  readonly sections: Readonly<Record<string, readonly string[]>>;
  readonly checks: readonly PlannedCheck[];
  readonly prepared_at: string;
  /**
   * Every expert whose `expert.md` and trained knowledge went into `prompt.md`.
   * Written so the host session can see what the sub-agent was actually given —
   * measured 2026-08-29, the bundle named one `expert` and said nothing about the
   * other two the prompt contained, or about the knowledge in none of them.
   */
  readonly experts?: readonly PendingExpert[];
  /**
   * The story this bundle is for, when the stage runs story by story (the Build
   * executor's `--prepare`/`--commit` cycle). `--commit` reads it back to know
   * which story's pipeline to continue.
   */
  readonly story?: string;
}

/** What the in-session runner is expected to write back. */
export interface StageResult {
  readonly outputs: readonly string[];
  readonly questions_asked: readonly string[];
  readonly notes: string;
  readonly cost_usd: number | null;
  readonly session_id: string | null;
}

export class PendingError extends Error {}

export function writeBundle(runDir: string, stageId: string, prompt: string, pending: PendingStage): void {
  const dir = agentDir(runDir, stageId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, PROMPT_FILE), prompt.endsWith("\n") ? prompt : `${prompt}\n`, "utf8");
  writeFileSync(join(dir, PENDING_FILE), `${JSON.stringify(pending, null, 2)}\n`, "utf8");
}

export function writeRaw(runDir: string, stageId: string, raw: string): void {
  const dir = agentDir(runDir, stageId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, RAW_FILE), raw.endsWith("\n") ? raw : `${raw}\n`, "utf8");
}

export function promptPath(runDir: string, stageId: string): string {
  return join(agentDir(runDir, stageId), PROMPT_FILE);
}

export function pendingPath(runDir: string, stageId: string): string {
  return join(agentDir(runDir, stageId), PENDING_FILE);
}

export function resultPath(runDir: string, stageId: string): string {
  return join(agentDir(runDir, stageId), RESULT_FILE);
}

/** Read `pending.json` back — what `--prepare` said this cycle is for. */
export function readPending(runDir: string, stageId: string): PendingStage {
  const path = pendingPath(runDir, stageId);
  if (!existsSync(path)) {
    throw new PendingError(
      `no ${PENDING_FILE} in ${agentDir(runDir, stageId)} — run \`tldrx next --prepare\` first`,
    );
  }
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new PendingError(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    throw new PendingError(`${path} must be a JSON object`);
  }
  return doc as PendingStage;
}

/**
 * Read `result.json`. Throws with the path in the message rather than guessing at
 * a default — a commit with no result is an operator mistake worth naming.
 */
export function readResult(runDir: string, stageId: string): StageResult {
  const path = resultPath(runDir, stageId);
  if (!existsSync(path)) {
    throw new PendingError(
      `no ${RESULT_FILE} in ${agentDir(runDir, stageId)} — the in-session run must write it before \`next --commit\``,
    );
  }
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new PendingError(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    throw new PendingError(`${path} must be a JSON object`);
  }
  const row = doc as Record<string, unknown>;
  return {
    outputs: strings(row.outputs),
    questions_asked: strings(row.questions_asked),
    notes: typeof row.notes === "string" ? row.notes : "",
    cost_usd: typeof row.cost_usd === "number" ? row.cost_usd : null,
    session_id: typeof row.session_id === "string" ? row.session_id : null,
  };
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value) ? (value as unknown[]).filter((v): v is string => typeof v === "string") : [];
}
