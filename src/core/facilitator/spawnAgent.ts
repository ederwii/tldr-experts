/**
 * Spawning one sub-agent (spec §5, headless mode).
 *
 * Every flag here was read out of `claude --help` before it was used —
 * `-p/--print`, `--output-format`, `--json-schema`, `--model`,
 * `--max-budget-usd`, `--allowedTools`, `--dangerously-skip-permissions`
 * (2026-08-28), `--effort <level>` (2026-08-29, whose help line reads
 * "Effort level for the current session (low, medium, high, xhigh, max)"), and
 * `--verbose` (2026-08-29). A flag nobody has seen in `--help` does not go in
 * this file.
 *
 * **`stream-json`, since wave K.** The format changed from `json` to
 * `stream-json` so a waiting human can be told what the sub-agent is doing while
 * it does it. Two measured facts, from one real call on `claude` 2.1.251:
 * `--verbose` is REQUIRED (`stream-json` in print mode refuses without it, before
 * spending anything), and `--json-schema` still works — the last `result` event
 * carries `structured_output` exactly as the single-blob format did. So the
 * validation path below is unchanged; only the transport is different, and
 * `resolveResultDoc` reads either one.
 *
 * The prompt goes in on **stdin**, not as an argv element: a stage prompt is tens
 * of kilobytes with newlines and quotes in it, and an argv is neither the right
 * size nor the right shape for that.
 */
import { runtime } from "../runtime/index.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertNoAttendedSpawn } from "./attended.ts";
import { emitAgentEvent } from "../ui/bus.ts";
import type { EffortLevel } from "../schemas/stage.ts";
import { AgentStream, resolveCodexResultDoc, resolveResultDoc, type AgentEvent } from "./agentEvents.ts";
import { isReadTool, readCapError, STOPPED_BY_MAX_READS } from "./readCap.ts";
import { ENVELOPE_SCHEMA, toEnvelope, toUsage, type AgentEnvelope, type AgentUsage, type ClaudeResultJson } from "./envelope.ts";

/** The provider this file speaks to, when nobody says otherwise. */
export const CLAUDE_BIN = "claude";
export const CODEX_BIN = "codex";
export type AgentProvider = "claude" | "codex";
export const AGENT_PROVIDERS: readonly AgentProvider[] = ["claude", "codex"];

/** The automated runner remains Claude unless a caller explicitly opts into Codex. */
export function agentProvider(): AgentProvider {
  const configured = process.env.TLDRX_AGENT_PROVIDER?.trim().toLowerCase();
  if (configured === undefined || configured === "") return "claude";
  if (configured === "claude" || configured === "codex") return configured;
  throw new Error(`TLDRX_AGENT_PROVIDER must be one of ${AGENT_PROVIDERS.join(" | ")}; got ${JSON.stringify(configured)}`);
}

/**
 * Which binary the sub-agent spawn actually executes (#27, minimal slice).
 *
 * `TLDRX_CLAUDE_BIN` replaces the executable NAME and nothing else — the argv below is
 * still `claude`'s argv, so a stand-in has to speak `-p --output-format stream-json
 * --json-schema`. That buys the cases people actually hit today: a pinned install, a
 * wrapper that adds credentials or a proxy, a stub in a sandbox. It is not the provider
 * abstraction #27 asks for, and it is not pretending to be one.
 *
 * Read on every call rather than captured at import: a test that sets the variable and a
 * process that exports it late must both be obeyed, and a module-load snapshot obeys
 * neither. Blank or whitespace means UNSET — an exported-but-empty var is how a shell
 * says "no value", and spawning `""` would be a worse answer than the default.
 *
 * `tldrx doctor` is deliberately NOT covered: it checks `claude --version` because
 * `env.yml` declares that string, and rewriting a manifest command is the provider
 * layer's job, not this variable's.
 */
export function claudeBin(): string {
  return process.env.TLDRX_CLAUDE_BIN?.trim() || CLAUDE_BIN;
}

export function codexBin(): string {
  return process.env.TLDRX_CODEX_BIN?.trim() || CODEX_BIN;
}

export function providerBudgetAdvisory(provider: AgentProvider, ceilingUsd: number): string | null {
  if (provider === "claude") return null;
  return `budget: Codex has no provider-side USD cap; $${ceilingUsd.toFixed(2)} is a planning ceiling only, `
    + "and this turn will be recorded unmetered in dollars";
}

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
  /**
   * Every `AgentEvent` derived from the stream, as it arrives. The global
   * progress bus (`core/ui/bus.ts`) gets the same events either way; this is the
   * direct hook, for a caller that wants them without installing a sink.
   */
  readonly onEvent?: (event: AgentEvent) => void;
  /**
   * Stop the sub-agent after this many COMPLETED `Read`/`Glob`/`Grep` calls
   * (spec §5, `max_reads`). Counting completions rather than starts is what makes
   * "stop after the current tool" true rather than "stop in the middle of one".
   * Undefined or <= 0 leaves exploration uncapped, exactly as before.
   */
  readonly maxReads?: number;
  /**
   * Which concurrent unit this sub-agent is: a Build story id when a wave runs
   * with `--parallel N`. Published with every event so a progress view can show
   * one activity line per story instead of interleaving them into one.
   */
  readonly lane?: string;
  /** Build's reviewer is enforced by Codex's sandbox, not merely by its prompt. */
  readonly role?: "developer" | "reviewer";
}

export interface AgentOutcome {
  readonly ok: boolean;
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly isError: boolean;
  readonly sessionId: string | null;
  readonly costUsd: number;
  /** False when the provider reports tokens but no provider-metered USD amount. */
  readonly metered: boolean;
  readonly usage: AgentUsage;
  readonly envelope: AgentEnvelope | null;
  /** The raw `structured_output`, for a request that passed its own `schema`. */
  readonly structured: unknown;
  readonly result: string;
  /** One line, suitable for `tasks[].error`. Null when the run succeeded. */
  readonly error: string | null;
  /** Raw stdout, persisted to `.agent/<stage>/result.raw.json` for the audit trail. */
  readonly raw: string;
  /** Completed `Read`/`Glob`/`Grep` calls seen on the stream. */
  readonly reads: number;
  /** `"max_reads"` when the read cap stopped this run, else null. */
  readonly stoppedBy: string | null;
}

export function allowedTools(workspaceCommands: readonly string[]): readonly string[] {
  return [...BASE_TOOLS, ...workspaceCommands.map((command) => `Bash(${command})`)];
}

export function buildClaudeArgs(request: AgentRequest): readonly string[] {
  // `--verbose` is not optional here: measured 2026-08-29, `claude -p
  // --output-format stream-json` without it exits with "When using --print,
  // --output-format=stream-json requires --verbose" and spends $0.00.
  const args: string[] = ["-p", "--output-format", "stream-json", "--verbose"];
  if (request.model !== null && request.model !== "") args.push("--model", request.model);
  if (request.effort !== null && request.effort !== undefined) args.push("--effort", request.effort);
  args.push("--max-budget-usd", formatUsd(request.maxBudgetUsd));
  args.push("--json-schema", JSON.stringify(request.schema ?? ENVELOPE_SCHEMA));
  args.push("--allowedTools", (request.tools ?? allowedTools(request.workspaceCommands)).join(","));
  if (request.yolo) args.push("--dangerously-skip-permissions");
  return args;
}

export function buildCodexArgs(request: AgentRequest, schemaPath: string): readonly string[] {
  // Verified against `codex exec --help` in codex-cli 0.152.0: when the optional
  // positional [PROMPT] is omitted, instructions are read from stdin. The same
  // help output lists --ephemeral, --json, --color, --sandbox, --output-schema
  // and --config. Keeping the prompt out of argv preserves the shared contract
  // for large, multiline stage prompts.
  const args: string[] = [
    "exec", "--ephemeral", "--json", "--color", "never",
    "--sandbox", request.role === "reviewer" ? "read-only" : "workspace-write",
    "--output-schema", schemaPath,
  ];
  if (request.model !== null && request.model !== "") args.push("--model", request.model);
  if (request.effort !== null && request.effort !== undefined) {
    args.push("--config", `model_reasoning_effort=${JSON.stringify(request.effort)}`);
  }
  return args;
}

/** What `--json-schema`'s value is replaced by in a printed command. */
export const SCHEMA_PLACEHOLDER = "<envelope-schema>";
export const CODEX_SCHEMA_PLACEHOLDER = "<output-schema.json>";

/**
 * The command `spawnAgent` WOULD run, as one printable line — for `--dry-run`
 * (issue #17), which must show the dispatch rather than make it.
 *
 * It is `buildClaudeArgs` itself, not a second description of it, so the printed
 * command cannot drift from the one that runs. The single edit is the
 * `--json-schema` value: the envelope schema is a JSON blob nobody reads on a
 * terminal, and a line that is 90% schema hides the three flags — model, budget,
 * tools — a reader is actually checking. The prompt is on stdin either way,
 * which the caller says out loud.
 */
export function describeSpawn(request: AgentRequest): string {
  if (agentProvider() === "codex") {
    return `${codexBin()} ${buildCodexArgs(request, CODEX_SCHEMA_PLACEHOLDER).map(shellQuote).join(" ")}`;
  }
  const args = buildClaudeArgs(request);
  const shown = args.map((arg, i) => (args[i - 1] === "--json-schema" ? SCHEMA_PLACEHOLDER : arg));
  return `${claudeBin()} ${shown.map(shellQuote).join(" ")}`;
}

/** Quote an argv element only when it needs it, so the common case stays readable. */
function shellQuote(arg: string): string {
  return /^[\w.,:/@=-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
}

export async function spawnAgent(request: AgentRequest): Promise<AgentOutcome> {
  // Before the parser, before the argv, before a byte of prompt goes anywhere: a
  // run marked `attended_by: host` never spawns, and the one place that cannot be
  // forgotten is the spawn itself (`facilitator/attended.ts`). No-op on every
  // ordinary run, where the guard is not armed.
  assertNoAttendedSpawn("spawnAgent");
  // The parser is attached ALWAYS, not only when someone is watching: a code path
  // that runs solely with the UI on is a code path nothing tests. Publishing into
  // an empty bus costs one null check per event.
  const provider = agentProvider();
  const stream = new AgentStream(provider);
  const publish = (event: AgentEvent): void => {
    request.onEvent?.(event);
    emitAgentEvent(event, request.lane);
  };

  const cap = request.maxReads ?? 0;
  const controller = new AbortController();
  let reads = 0;
  let capped = false;

  const schemaDir = provider === "codex" ? mkdtempSync(join(tmpdir(), "tldrx-codex-schema-")) : null;
  const schemaPath = schemaDir === null ? null : join(schemaDir, "output-schema.json");
  if (schemaPath !== null) writeFileSync(schemaPath, `${JSON.stringify(request.schema ?? ENVELOPE_SCHEMA)}\n`, "utf8");
  let spawned;
  try {
    spawned = await runtime.spawn(
      provider === "codex" ? codexBin() : claudeBin(),
      provider === "codex" ? buildCodexArgs(request, schemaPath ?? CODEX_SCHEMA_PLACEHOLDER) : buildClaudeArgs(request),
      {
        cwd: request.cwd,
        stdin: request.prompt,
        timeoutMs: request.timeoutMs,
        ...(cap > 0 ? { signal: controller.signal } : {}),
        // Explicit, live env: the provider is resolved off PATH, and on Bun the
        // default child environment is the one captured at process start.
        env: request.env ?? { ...process.env },
        onStdoutLine: (line) => {
          for (const event of stream.push(line)) {
            // Counted on COMPLETION, so the kill lands between tools rather than
            // inside one, and a read whose result never arrived is not charged.
            //
            // `!capped` guards the COUNTER, not just the kill (issue #24). A chunk
            // boundary is not a line boundary: `LineSplitter` hands every complete
            // line in one chunk to this callback synchronously, so on a loaded
            // machine — where the OS coalesces the child's writes — reads 4..20
            // arrive in the same tick as read 3 and were counted, minutes of wall
            // clock before the SIGKILL just ordered could possibly land. The
            // recorded figure was therefore a function of scheduling, and the test
            // that pinned it to the cap flaked twice in one night.
            //
            // Once the cap has fired the process is already being killed and this
            // run is over. What belongs on the ledger is the number of reads the cap
            // ALLOWED — which is the cap — not however many bytes were in flight.
            if (!capped && event.kind === "tool-done" && (event.countsAsRead === true || isReadTool(event.name))) {
              reads += 1;
              publish({ kind: "reads", count: reads, cap });
              if (cap > 0 && reads >= cap) {
                capped = true;
                publish({ kind: "error", message: readCapError(reads, cap, provider) });
                controller.abort();
              }
            }
            publish(event);
          }
        },
      },
    );
  } finally {
    if (schemaDir !== null) rmSync(schemaDir, { recursive: true, force: true });
  }

  const interpreted = interpret(spawned.exitCode, spawned.stdout, spawned.stderr, spawned.timedOut, provider);
  const outcome: AgentOutcome = capped
    ? {
      ...interpreted,
      ok: false,
      reads,
      stoppedBy: STOPPED_BY_MAX_READS,
      // The cap is the reason, whatever the dying process said on its way out.
      error: readCapError(reads, cap, provider),
    }
    : { ...interpreted, reads, stoppedBy: null };
  // A process that died before its `result` event never emitted `done`. Say so,
  // so the view stops on a failure rather than on a frozen last frame.
  if (!outcome.ok && outcome.error !== null && !capped) {
    publish({ kind: "error", message: outcome.error });
  }
  return outcome;
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
  provider: AgentProvider = "claude",
): AgentOutcome {
  // Either format: a whole-buffer object (`--output-format json`, pretty or not)
  // or the last `type: "result"` line of a JSONL stream.
  const doc = (provider === "codex" ? resolveCodexResultDoc(stdout) : resolveResultDoc(stdout)) as ClaudeResultJson | null;
  const isError = doc?.is_error === true;
  const sessionId = typeof doc?.session_id === "string" ? doc.session_id : null;
  const costUsd = typeof doc?.total_cost_usd === "number" ? doc.total_cost_usd : 0;
  const metered = provider === "claude";
  const usage = toUsage(doc?.usage);
  const envelope = toEnvelope(doc?.structured_output);
  const result = typeof doc?.result === "string" ? doc.result : "";
  const ok = exitCode === 0 && !isError && !timedOut && doc !== null;

  return {
    ok, exitCode, timedOut, isError, sessionId, costUsd, metered, usage, envelope,
    structured: doc?.structured_output ?? null, result,
    error: ok ? null : describe(exitCode, doc, stderr, timedOut, stdout, provider),
    raw: stdout,
    reads: 0,
    stoppedBy: null,
  };
}

function describe(
  exitCode: number,
  doc: ClaudeResultJson | null,
  stderr: string,
  timedOut: boolean,
  stdout: string,
  provider: AgentProvider,
): string {
  const name = provider === "codex" ? "codex" : "claude";
  if (timedOut) return `${name} timed out (killed after the stage's timeout_s)`;
  if (doc === null) {
    const tail = firstLine(stderr) || firstLine(stdout) || "(no output)";
    return `${name} exited ${exitCode} without a parseable result event: ${tail}`;
  }
  const errors = Array.isArray(doc.errors) ? (doc.errors as unknown[]).filter((e) => typeof e === "string") : [];
  const reason = errors[0] ?? (typeof doc.subtype === "string" ? doc.subtype : "") ?? "";
  const suffix = reason === "" ? "" : `: ${String(reason)}`;
  return `${name} exited ${exitCode} with is_error=${String(doc.is_error === true)}${suffix}`;
}

function firstLine(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).find((l) => l !== "");
  return line === undefined ? "" : line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

/** `--max-budget-usd` takes a plain amount; two decimals is money, not a float. */
export function formatUsd(amount: number): string {
  return (Math.max(amount, 0.01)).toFixed(2);
}
