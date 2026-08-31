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
import type { DispatchNotes } from "./dispatchNotes.ts";
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

/**
 * The context ledger as `pending.json` carries it (wave N).
 *
 * `pending.json` already said how many bytes each expert contributed and nothing
 * about the whole; the host session could see nine expert rows and still not know
 * the prompt was 159,575 bytes. Flat numbers, one level deep, so the same object
 * can be read straight out of the file by anything.
 */
export interface PendingContext {
  readonly total_bytes: number;
  readonly limit_bytes: number;
  readonly estimated_tokens: number;
  readonly stage_bytes: number;
  readonly questions_bytes: number;
  readonly inputs_bytes: number;
  readonly expert_body_bytes: number;
  readonly expert_knowledge_bytes: number;
  /** The host's `## Dispatch notes` section — 0 when the operator left no file. */
  readonly dispatch_notes_bytes: number;
  readonly previous_attempt_bytes: number;
  /** Declared inputs the shared inline budget could not fit whole. */
  readonly truncated_inputs: readonly string[];
}

/**
 * The dispatch-notes slot as `pending.json` records it.
 *
 * Separate from `context:` on purpose, and not a duplicate of it. `context` is
 * the LEDGER — its groups must sum to `total_bytes`, and only the stages that
 * build a ledger have one. This is the slot's own record: which files fed it and
 * whether the cap cut anything, written by every bundle that renders the section,
 * including the Build executor's per-story bundles, which carry no ledger.
 */
export interface PendingDispatchNotes {
  /** Bytes of host-written note CONTENT inlined — what the 8 KB cap is spent from. */
  readonly bytes: number;
  readonly truncated: boolean;
  readonly max_bytes: number;
  /** Run-dir relative paths, in render order: the stage's file before a story's. */
  readonly sources: readonly string[];
}

/**
 * `pending.json`'s `dispatch_notes` key — and NOTHING when the operator left no
 * file, so a bundle nobody added context to is the bundle it always was.
 */
export function dispatchNotesRecord(
  notes: DispatchNotes,
): { dispatch_notes?: PendingDispatchNotes } {
  if (notes.sources.length === 0) return {};
  return {
    dispatch_notes: {
      bytes: notes.inlinedBytes,
      truncated: notes.truncated,
      max_bytes: notes.maxBytes,
      sources: notes.sources.map((source) => source.rel),
    },
  };
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
  /** What the prompt is made of, in bytes (§5, "Context ledger"). */
  readonly context?: PendingContext;
  /**
   * The host's own context for this cycle, when it left a `dispatch-notes.md`
   * beside `prompt.md`. Absent when it did not — so an unchanged bundle stays an
   * unchanged bundle, byte for byte.
   */
  readonly dispatch_notes?: PendingDispatchNotes;
  /** The `Read`/`Glob`/`Grep` ceiling this stage's sub-agent runs under. */
  readonly max_reads?: number;
  /**
   * The story this bundle is for, when the stage runs story by story (the Build
   * executor's `--prepare`/`--commit` cycle). `--commit` reads it back to know
   * which story's pipeline to continue.
   */
  readonly story?: string;
  /**
   * WHICH sub-agent this bundle is for, when a stage delegates more than one
   * (design §B.3). Absent means what it has always meant: the one agent the
   * stage runs — the developer, on a Build story.
   *
   * The host reads it to know which contract applies, because the two roles want
   * different things back: a developer writes `{outputs, questions_asked, notes}`,
   * a reviewer writes the `REVIEW_SCHEMA` envelope in `result_schema` below.
   */
  readonly role?: "developer" | "reviewer";
  /**
   * The JSON schema the result envelope must satisfy, verbatim — today only the
   * reviewer's `REVIEW_SCHEMA`.
   *
   * Written into the bundle so the host knows the envelope shape without reading
   * the framework's source. It is the SAME object handed to `claude --json-schema`
   * on the spawned path, so a host review and a spawned one are answering the
   * same question.
   */
  readonly result_schema?: Readonly<Record<string, unknown>>;
  /** What a reviewer bundle is judging: the diff refs and the DoD already re-run. */
  readonly review?: PendingReview;
  /**
   * The fix list this developer bundle is a round OF (design §B.4) — absent on
   * every bundle that is not one, so an ordinary `--prepare` is the bundle it
   * always was.
   */
  readonly fixlist?: PendingFixlist;
  /**
   * The `session_id` the PRIOR turn on this story reported, so the host can
   * resume that sub-agent rather than pay to rebuild its context.
   *
   * The framework resumes NOTHING itself, and the key is deliberately named for
   * what it is: `spawnAgent` has no `--resume` and gaining one is not this
   * chunk's business. What the framework can do is remember the id it was handed
   * and give it back — the host's own session tooling is what knows whether it is
   * still resumable. `null` when the previous turn declared none.
   */
  readonly resume_session?: string | null;
}

/**
 * The fix-list round a developer bundle is answering.
 *
 * `path` is run-dir relative and points at the committed artifact, not at a copy:
 * the file is the state, a host edits it to close findings, and a bundle carrying
 * a snapshot of it would go stale the first time somebody did.
 */
export interface PendingFixlist {
  readonly path: string;
  readonly round: number;
  /** Every finding in the file. */
  readonly findings: number;
  /** The ones still `fix-now` and unresolved — the work this round is for. */
  readonly open: number;
}

/**
 * The reviewer bundle's own facts — everything a host needs to dispatch the
 * review without re-deriving it from the run.
 *
 * `commit` and `dod` are RECOVERED, not re-measured: the story's diff was
 * committed and merged in an earlier cycle and its DoD went green then. Handing
 * the host the shas and the exit codes off the ledger is what makes a re-review
 * cost one turn instead of a whole rebuild.
 */
export interface PendingReview {
  readonly story: string;
  readonly repo: string;
  readonly branch: string;
  readonly epic_branch: string;
  /** The exact command that produces the diff under review. */
  readonly diff: string;
  /** The merged story commit the verdict is about. */
  readonly commit: string;
  readonly attempt: number;
  readonly max_attempts: number;
  /** Run-root-relative cwd the reviewer runs in. */
  readonly worktree: string;
  /** The Definition of Done the facilitator already re-ran — do not re-run it. */
  readonly dod: readonly { readonly command: string; readonly exit_code: number }[];
  /** Why this review is being asked for again, when it is. */
  readonly resumed_from?: string;
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
 * `result.json` as the raw object the host wrote.
 *
 * Split out of `readResult` because two envelopes now come back through this
 * door and only one of them is a `StageResult`: a reviewer's is the
 * `REVIEW_SCHEMA` shape, and narrowing it is `parseReview`'s job, not this
 * file's. What is shared is the part that must fail the same way for both —
 * absent, unparseable, or not an object.
 */
export function readResultObject(runDir: string, stageId: string): Record<string, unknown> {
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
  return doc as Record<string, unknown>;
}

/**
 * Read `result.json`. Throws with the path in the message rather than guessing at
 * a default — a commit with no result is an operator mistake worth naming.
 */
export function readResult(runDir: string, stageId: string): StageResult {
  const row = readResultObject(runDir, stageId);
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
