/**
 * Spawning one sub-agent (spec §5, headless mode).
 *
 * Every flag here was read out of `claude --help` before it was used —
 * `-p/--print`, `--output-format json`, `--json-schema`, `--model`,
 * `--max-budget-usd`, `--allowedTools`, `--dangerously-skip-permissions`
 * (2026-08-28), and `--effort <level>` (2026-08-29, whose help line reads
 * "Effort level for the current session (low, medium, high, xhigh, max)"). A
 * flag nobody has seen in `--help` does not go in this file.
 *
 * The prompt goes in on **stdin**, not as an argv element: a stage prompt is tens
 * of kilobytes with newlines and quotes in it, and an argv is neither the right
 * size nor the right shape for that.
 */
import { runtime } from "../runtime/index.ts";
import type { EffortLevel } from "../schemas/stage.ts";
import { ENVELOPE_SCHEMA, parseClaudeJson, toEnvelope, toUsage, type AgentEnvelope, type AgentUsage } from "./envelope.ts";

export const CLAUDE_BIN = "claude";

/**
 * `[assumption]` — the spec never lists the sub-agent's tool allowance. Taken: the
 * file tools it needs to produce Markdown, plus exactly the commands
 * `workspace.yml` declares, each as its own `Bash(<command>)` grant. A stage may
 * not invent a command (spec §2.3), so neither may its sub-agent.
 */
export const BASE_TOOLS: readonly string[] = ["Read", "Write", "Edit", "Glob", "Grep"];

export interface AgentRequest {
  readonly prompt: string;
  readonly model: string | null;
  /**
   * `--effort`, the per-turn cost lever. Null/absent leaves the flag off entirely
   * and the CLI picks its own default — a stage that says nothing about effort
   * must behave exactly as it did before this option existed.
   */
  readonly effort?: EffortLevel | null;
  readonly maxBudgetUsd: number;
  /** Every command in `.tldrx/workspace.yml`, verbatim. */
  readonly workspaceCommands: readonly string[];
  readonly yolo: boolean;
  readonly cwd: string;
  readonly timeoutMs: number;
  /** Overrides the child environment; defaults to the live `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * The complete `--allowedTools` list, replacing base tools + workspace commands.
   *
   * The Build phase needs both a NARROWER allowance than the default (one repo's
   * commands, not every repo's) and a WIDER one (`Bash(git add *)`), and a reviewer
   * needs a read-only one. A caller that knows exactly what a sub-agent may do says
   * so rather than describing it in commands. `[assumption]` — the spec never lists
   * the sub-agent's tool allowance at all.
   */
  readonly tools?: readonly string[];
  /** Replaces `ENVELOPE_SCHEMA` for a sub-agent that returns something else. */
  readonly schema?: Readonly<Record<string, unknown>>;
}

export interface AgentOutcome {
  readonly ok: boolean;
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly isError: boolean;
  readonly sessionId: string | null;
  readonly costUsd: number;
  readonly usage: AgentUsage;
  readonly envelope: AgentEnvelope | null;
  /** The raw `structured_output`, for a request that passed its own `schema`. */
  readonly structured: unknown;
  readonly result: string;
  /** One line, suitable for `tasks[].error`. Null when the run succeeded. */
  readonly error: string | null;
  /** Raw stdout, persisted to `.agent/<stage>/result.raw.json` for the audit trail. */
  readonly raw: string;
}

export function allowedTools(workspaceCommands: readonly string[]): readonly string[] {
  return [...BASE_TOOLS, ...workspaceCommands.map((command) => `Bash(${command})`)];
}

export function buildClaudeArgs(request: AgentRequest): readonly string[] {
  const args: string[] = ["-p", "--output-format", "json"];
  if (request.model !== null && request.model !== "") args.push("--model", request.model);
  if (request.effort !== null && request.effort !== undefined) args.push("--effort", request.effort);
  args.push("--max-budget-usd", formatUsd(request.maxBudgetUsd));
  args.push("--json-schema", JSON.stringify(request.schema ?? ENVELOPE_SCHEMA));
  args.push("--allowedTools", (request.tools ?? allowedTools(request.workspaceCommands)).join(","));
  if (request.yolo) args.push("--dangerously-skip-permissions");
  return args;
}

export async function spawnAgent(request: AgentRequest): Promise<AgentOutcome> {
  const spawned = await runtime.spawn(CLAUDE_BIN, buildClaudeArgs(request), {
    cwd: request.cwd,
    stdin: request.prompt,
    timeoutMs: request.timeoutMs,
    // Explicit, live env: `claude` is resolved off PATH, and on Bun the default
    // child environment is the one captured at process start.
    env: request.env ?? { ...process.env },
  });
  return interpret(spawned.exitCode, spawned.stdout, spawned.stderr, spawned.timedOut);
}

/**
 * Turn a finished process into a result. Exported so a test can exercise every
 * failure shape — a broken JSON body, a non-zero exit, `is_error: true` — without
 * a process to break.
 */
export function interpret(
  exitCode: number,
  stdout: string,
  stderr: string,
  timedOut: boolean,
): AgentOutcome {
  const doc = parseClaudeJson(stdout);
  const isError = doc?.is_error === true;
  const sessionId = typeof doc?.session_id === "string" ? doc.session_id : null;
  const costUsd = typeof doc?.total_cost_usd === "number" ? doc.total_cost_usd : 0;
  const usage = toUsage(doc?.usage);
  const envelope = toEnvelope(doc?.structured_output);
  const result = typeof doc?.result === "string" ? doc.result : "";
  const ok = exitCode === 0 && !isError && !timedOut && doc !== null;

  return {
    ok, exitCode, timedOut, isError, sessionId, costUsd, usage, envelope,
    structured: doc?.structured_output ?? null, result,
    error: ok ? null : describe(exitCode, doc, stderr, timedOut, stdout),
    raw: stdout,
  };
}

function describe(
  exitCode: number,
  doc: ReturnType<typeof parseClaudeJson>,
  stderr: string,
  timedOut: boolean,
  stdout: string,
): string {
  if (timedOut) return `claude timed out (killed after the stage's timeout_s)`;
  if (doc === null) {
    const tail = firstLine(stderr) || firstLine(stdout) || "(no output)";
    return `claude exited ${exitCode} without parseable --output-format json: ${tail}`;
  }
  const errors = Array.isArray(doc.errors) ? (doc.errors as unknown[]).filter((e) => typeof e === "string") : [];
  const reason = errors[0] ?? (typeof doc.subtype === "string" ? doc.subtype : "") ?? "";
  const suffix = reason === "" ? "" : `: ${String(reason)}`;
  return `claude exited ${exitCode} with is_error=${String(doc.is_error === true)}${suffix}`;
}

function firstLine(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).find((l) => l !== "");
  return line === undefined ? "" : line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

/** `--max-budget-usd` takes a plain amount; two decimals is money, not a float. */
export function formatUsd(amount: number): string {
  return (Math.max(amount, 0.01)).toFixed(2);
}
