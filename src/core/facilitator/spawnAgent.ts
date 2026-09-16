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
import { codexSchema } from "./codexSchema.ts";
import { emitAgentEvent } from "../ui/bus.ts";
import type { EffortLevel } from "../schemas/stage.ts";
import {
  AgentStream, CODEX_ENVELOPE_UNREADABLE, permissionRefusal, resolveCodexResultDoc, resolveResultDoc,
  type AgentEvent,
} from "./agentEvents.ts";
import { isReadTool, readCapError, STOPPED_BY_MAX_READS } from "./readCap.ts";
import { subagentEnv } from "./subagent.ts";
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
  /**
   * Build's reviewer is enforced by Codex's sandbox, not merely by its prompt.
   *
   * `gate-signer` (gh #198) is deliberately NOT `read-only` under Codex: its whole
   * turn is one write, `.agent/<stage>/evidence.md`, so it takes the ordinary
   * `workspace-write` sandbox and is narrowed by `tools` instead. The Codex
   * provider pin is therefore untouched — `role === "reviewer"` is still the one
   * value that selects the read-only sandbox.
   */
  readonly role?: "developer" | "reviewer" | "gate-signer";
}

/**
 * One `rate_limit_event` frame, as the provider stated it (gh #298).
 *
 * The parser's own event minus its `kind`, so there is ONE shape for this fact
 * and no second derivation of it (AGENTS.md §7).
 */
export type AgentRateLimit = Omit<Extract<AgentEvent, { kind: "rate-limit" }>, "kind">;

/**
 * Why a turn failed, named — the family of gh #341/#298 (gh #348).
 *
 * MEASURED (the field audit notes, workspace B, 2026-09-15): 24 of 54 failed
 * tasks in one sample were "turno de agente con timeout / error genérico" —
 * the largest single bucket in the data, 2.4x the next cause, and entirely
 * unnamed. Every value here is derived from a shape `describeFailure` (or, for
 * `rate_limit`, `spawnAgent` itself) can already tell apart mechanically —
 * nothing here is a new detector, and nothing here decides a retry.
 *
 *  - `"timeout"` — the stage's `timeout_s` killed the process (`AgentOutcome.timedOut`).
 *  - `"rate_limit"` — reuses gh #298's own detection: the LAST `rate_limit_event`
 *    frame the stream carried (`AgentOutcome.rateLimit`) named a `status` other
 *    than `"allowed"`. What that status reads when the wall is actually HIT is
 *    still unattested (gh #341) — this never invents that string, it only
 *    trusts the one the provider already sent and this repo already parses.
 *  - `"process_killed"` — the exit code is the `128 + signal` shape
 *    `nodeRuntime.ts`'s `exitCodeOf` writes for SIGKILL/SIGTERM, and the death
 *    was not the stage's own timeout and not the read cap (which already names
 *    itself via `stoppedBy` — see `AgentOutcome.stoppedBy`'s doc).
 *  - `"empty_result"` — the process exited `0` and produced nothing this file
 *    can parse as a result event at all.
 *  - `"non_zero_exit"` — a non-zero exit, with or without a document: either
 *    nothing parsed, or a document parsed and named its own reason (an
 *    `errors[]` entry or a disagreeing `subtype`) — the common, ordinary case.
 *  - `"malformed_result"` — a document parsed, but not into a real result
 *    event: Codex's own "envelope was unreadable" sentinel, or (Claude)
 *    `resolveResultDoc`'s whole-buffer fallback accepted JSON whose `type` was
 *    never `"result"`.
 *  - `"unclassified"` — a document parsed, named nothing, and none of the
 *    shapes above applies. `AgentOutcome.error` still carries the raw signal
 *    seen (the exit code, `is_error`, and any subtype), so nothing is lost —
 *    this is the value gh #348 exists to shrink, not a place to guess.
 *
 * `null` on every outcome where `ok` is `true` and on a read-cap kill (see
 * `stoppedBy`, which already names that death in full).
 */
export type AgentFailureKind =
  | "timeout"
  | "rate_limit"
  | "process_killed"
  | "empty_result"
  | "non_zero_exit"
  | "malformed_result"
  | "unclassified";

export interface AgentOutcome {
  readonly ok: boolean;
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly isError: boolean;
  readonly sessionId: string | null;
  readonly costUsd: number;
  /**
   * True only when the provider's result document carried a USD figure. False for a
   * turn that reported tokens and no dollars, for a Codex turn (metered in tokens),
   * and for a process that died before it produced a result document at all. A
   * `false` here means `costUsd` is not a measurement and nothing may sum it.
   */
  readonly metered: boolean;
  readonly usage: AgentUsage;
  /**
   * Where `usage` came from (#207). Additive, and `"result"` on every turn that
   * finished — the shape this file has always returned.
   *
   * MEASURED, `test/fixtures/agent/stream-json.jsonl` (`claude` 2.1.251): the
   * stream reports TOKENS per assistant message (`message.usage`) and DOLLARS
   * only on the final `type: "result"` line (`total_cost_usd`). A turn SIGKILLed
   * on `timeout_s` never reaches that line, so before #207 fifteen minutes of
   * real compute booked an all-zero `usage` — honestly labelled `metered: false`,
   * and still throwing away token counts the provider had already streamed.
   *
   * `"partial-before-kill"` means: these tokens are the LAST frame the provider
   * reported before the kill — a floor on the turn, not its total, and never a
   * price. No USD is derived from them: this file quotes what a provider said,
   * and a dollar figure this repo computed from tokens would be a second
   * implementation of a derivation `budget/` already owns (AGENTS.md §7).
   *
   * `"absent"` means the child died without emitting one usage frame, and
   * `unmeteredReason` says so in words rather than as a zero.
   */
  readonly usageBasis: "result" | "partial-before-kill" | "absent";
  /** Why this turn has no dollars, when the reason is knowable. Else null. */
  readonly unmeteredReason: string | null;
  readonly envelope: AgentEnvelope | null;
  /** The raw `structured_output`, for a request that passed its own `schema`. */
  readonly structured: unknown;
  readonly result: string;
  /** One line, suitable for `tasks[].error`. Null when the run succeeded. */
  readonly error: string | null;
  /** Raw stdout, persisted to `.agent/<stage>/result.raw.json` for the audit trail. */
  readonly raw: string;
  /**
   * The first command this turn was REFUSED APPROVAL for, or null (gh #261).
   *
   * Not an error and not a failure: a turn that hit the permission wall finishes
   * normally, returns an envelope, and reports a cost. What it did not do is the
   * work — and in `-p` mode nobody was ever going to approve it, so the caller
   * that spends attempts needs to be able to SEE this rather than infer it from
   * an empty diff. `null` on every ordinary turn.
   */
  readonly permissionRefusal: string | null;
  /** Completed `Read`/`Glob`/`Grep` calls seen on the stream. */
  readonly reads: number;
  /**
   * The LAST quota frame this turn's stream carried, or null (gh #298).
   *
   * Null means "the stream said nothing about the quota", NEVER "the quota is
   * fine". A Codex turn is always null here: `codex exec --json` carries no
   * rate-limit event this repo has measured (AGENTS.md §10), and writing a
   * confident `allowed` for it would be the invented value §7 forbids.
   *
   * The LAST rather than the first, and not summed: the provider restates the
   * whole window on every frame — 0.92 then 0.94 across one measured turn — so
   * the newest frame is the only one that is still true.
   */
  readonly rateLimit: AgentRateLimit | null;
  /** `"max_reads"` when the read cap stopped this run, else null. */
  readonly stoppedBy: string | null;
  /**
   * A named cause for a failed turn (gh #348), or null on success and on a
   * read-cap kill — `stoppedBy` already names that one in full, and a second
   * account of the same event would be redundant rather than additive. See
   * `AgentFailureKind` for what each value means and how it was derived.
   */
  readonly failureKind: AgentFailureKind | null;
  /**
   * The sub-agent's turn, in milliseconds: the clock wraps `runtime.spawn` plus
   * its immediate setup and teardown — the schema temp dir, the argv, and the
   * reap (#184). Not a pure process time to the microsecond, and it is not
   * claimed as one; what it excludes is everything else the invocation does,
   * which is the part that made the two run.yml timestamps useless here.
   *
   * MEASURED here because here is the only place it can be. `run.yml`'s
   * `started_at` is the invocation's stamp and `ended_at` is when the row was
   * written, so on a parallel Build the subtraction of those two is close to the
   * whole invocation for every task in it. This is the span of one process.
   *
   * `interpret()` returns `0` for it — that function is handed a process that has
   * already finished and never saw it start, so it has nothing to report. Only
   * `spawnAgent` fills it in, and only a value it timed itself reaches a task row
   * as `duration_basis: "spawned"`.
   */
  readonly durationMs: number;
}

/**
 * The `--allowedTools` grants for ONE declared workspace command: the exact
 * string, and the same string with trailing arguments.
 *
 * Both, because the exact form alone is a permission bug measured live (gh
 * #209): a Build developer whose only grant was `Bash(npm run test)` had every
 * attempt to run its own Definition of Done denied with "This command requires
 * approval to run" — `npm run test -- app/dev/__tests__/x.test.ts`, `npx jest …`
 * — so the DoD's exit 127 was first seen by the gate, after the turn was paid
 * for, by a developer that could not have seen it.
 *
 * The grammar is verified, not remembered, against
 * https://code.claude.com/docs/en/permissions ("Configure permissions" → the
 * wildcard table, read 2026-09-09):
 *
 *   - "`Bash(npm run build)` … Matches `npm run build` … Doesn't match
 *     `npm run build --watch`" — the exact form really is exact.
 *   - "`Bash(ls *)` … Matches `ls -la`, `ls`" and "A `*` at the end, with a
 *     space before it, also matches the bare command", so the trailing-wildcard
 *     form covers both and "The space before a trailing `*` is part of the rule"
 *     (`Bash(ls *)` does NOT match `lsof`).
 *   - "The `:*` suffix is an equivalent way to write a trailing wildcard, so
 *     `Bash(ls:*)` matches the same commands as `Bash(ls *)`."
 *
 * The space form is the one written here: it is what the two grants this repo
 * already ships use (`Bash(git add *)`, `Bash(git commit *)`,
 * `Bash(git diff *)`), the docs call it and `:*` the same rule, and one spelling
 * per grammar is the house rule. The exact form is kept beside it rather than
 * dropped — it is what the docs say a bare command matches, it costs one list
 * entry, and a provider that reads the two forms differently is then covered by
 * both rather than by a guess about which it prefers.
 *
 * It does NOT widen the surface to another program: `Bash(npm run test *)`
 * cannot match `curl`, and a compound command is a different string to the
 * DoD's own byte-equality allowlist either way (`hooks/lib/story.ts`).
 */
export function bashGrantsFor(command: string): readonly string[] {
  return [`Bash(${command})`, `Bash(${command} *)`];
}

export function allowedTools(workspaceCommands: readonly string[]): readonly string[] {
  return [...BASE_TOOLS, ...workspaceCommands.flatMap((command) => bashGrantsFor(command))];
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

/**
 * The child is TOLD it is a sub-agent (gh #196), at the one place every
 * provider's spawn goes through.
 *
 * The session-start hook greets a session with "N runs are open — pass a run
 * id"; that is advice for a human who has several runs and no prompt. A spawned
 * sub-agent has its run in its prompt, and on a real workspace at 0.13.0 that
 * nudge was the only imperative-shaped sentence in a What agent's window — so it
 * answered the nudge and wrote none of its outputs. The name and the setter live
 * in `subagent.ts` so a hook can read them without importing this module.
 */
export { SUBAGENT_ENV_VAR, subagentEnv } from "./subagent.ts";

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

  // The clock starts before the schema temp dir and the argv, and stops when the
  // process is reaped: what this measures is "how long did asking cost", which is
  // the question a person timing a run is asking. `Date.now()` rather than a
  // monotonic clock because the number is written to a file and read by people —
  // a span that disagrees with two RFC3339 stamps by a leap second is not a
  // problem this ledger has.
  const startedMs = Date.now();
  const cap = request.maxReads ?? 0;
  const controller = new AbortController();
  let reads = 0;
  let capped = false;
  // The last usage frame the provider streamed. Kept so a turn that is KILLED
  // still reports the tokens it had already been charged for (#207). Not summed
  // across frames: Claude restates the conversation prefix on every assistant
  // message (measured — five frames reading 9/9/9/8/8 input tokens against a
  // result total of 17), so a sum would be an invented aggregate the provider
  // never published. The last frame is a figure it did publish.
  let streamedUsage: AgentUsage | null = null;
  // The last `rate_limit_event` the provider streamed (gh #298), or null when it
  // streamed none — which is every Codex turn and every Claude turn whose stream
  // carried no frame.
  let lastRateLimit: AgentRateLimit | null = null;

  const schemaDir = provider === "codex" ? mkdtempSync(join(tmpdir(), "tldrx-codex-schema-")) : null;
  const schemaPath = schemaDir === null ? null : join(schemaDir, "output-schema.json");
  if (schemaPath !== null) writeFileSync(schemaPath, `${JSON.stringify(codexSchema(request.schema ?? ENVELOPE_SCHEMA))}\n`, "utf8");
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
        env: subagentEnv(request.env),
        onStdoutLine: (line) => {
          for (const event of stream.push(line)) {
            // Every usage frame the provider streams, kept so a KILLED turn can
            // still report the last one (#207). Above the read cap on purpose: a
            // frame that arrived before the cap fired is a frame that arrived.
            // The newest quota frame, kept for the outcome (gh #298). Above the
            // read cap for the same reason the usage frame is: a frame that
            // arrived before the cap fired is a frame that arrived.
            if (event.kind === "rate-limit") {
              const { kind: _kind, ...frame } = event;
              lastRateLimit = frame;
            }
            if (event.kind === "cost") {
              streamedUsage = {
                input_tokens: event.inputTokens,
                output_tokens: event.outputTokens,
                cache_creation_input_tokens: event.cacheCreationTokens,
                cache_read_input_tokens: event.cacheReadTokens,
              };
            }
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
      // `stoppedBy` already names this in full (gh #348): a deliberate cap-kill
      // is not one more entry in the failure taxonomy, and a `failureKind` here
      // would be a second, redundant account of the same one event.
      failureKind: null,
    }
    : { ...interpreted, reads, stoppedBy: null };
  const timed: AgentOutcome = classifyRateLimit({
    ...outcome,
    ...partialUsage(outcome, streamedUsage),
    rateLimit: lastRateLimit,
    durationMs: Math.max(0, Date.now() - startedMs),
  });
  // A process that died before its `result` event never emitted `done`. Say so,
  // so the view stops on a failure rather than on a frozen last frame.
  if (!outcome.ok && outcome.error !== null && !capped) {
    publish({ kind: "error", message: outcome.error });
  }
  // The TIMED outcome, not `outcome`: a turn that failed, timed out or hit the
  // read cap still took wall clock, and that is exactly the span an operator
  // hunting a 43-hour run wants to see. A duration is not a reward for success.
  return timed;
}

/**
 * What a KILLED turn is allowed to say about its usage (#207).
 *
 * Only a turn that produced no result document is touched, which is exactly the
 * killed one: a process that reached `type: "result"` reported its own totals and
 * they are not second-guessed here. `metered` is untouched in both branches —
 * tokens are not dollars, and nothing may sum this into a spend.
 */
function partialUsage(
  outcome: AgentOutcome,
  streamed: AgentUsage | null,
): Partial<AgentOutcome> {
  if (!outcome.timedOut) return {};
  if (streamed === null) {
    return { usageBasis: "absent", unmeteredReason: "killed before any usage was reported" };
  }
  return {
    usage: streamed,
    usageBasis: "partial-before-kill",
    unmeteredReason: "killed mid-turn; the tokens above are the last frame the provider streamed",
  };
}

/**
 * Reuses gh #298's OWN detection — the last `rate_limit_event` frame the stream
 * carried — to name a failed turn's cause `"rate_limit"` (gh #348), rather than
 * whatever `describeFailure` guessed from the exit code and result document
 * alone. No second detector: this reads the exact field `spawnAgent` already
 * populates from the stream, and only from it.
 *
 * Silent on a turn that timed out or hit the read cap: both already have a
 * more specific, already-true account of their own death (`timedOut`,
 * `stoppedBy`), and a rate-limit frame arriving beside either is not evidence
 * that the QUOTA is what ended the turn — only that the quota was ALSO being
 * reported, the same way it is on a turn that finishes normally (`stream-json.jsonl:9`,
 * status `"allowed"`, utilization 0.03).
 *
 * `status !== "allowed"` is the only comparison made, on purpose: what the
 * provider's `status` reads at the moment the wall is actually HIT is
 * unattested anywhere in this repo (gh #341) — `"allowed_warning"` is the one
 * non-`"allowed"` value ever measured, and inventing a second string to
 * compare against would be exactly the guess AGENTS.md §7 forbids.
 */
export function classifyRateLimit(outcome: AgentOutcome): AgentOutcome {
  if (outcome.ok || outcome.timedOut || outcome.stoppedBy !== null) return outcome;
  if (outcome.rateLimit === null || outcome.rateLimit.status === "allowed") return outcome;
  return { ...outcome, failureKind: "rate_limit" };
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
  // `metered` is DERIVED from the presence of a USD figure, not from the provider's
  // name. A result document with no `total_cost_usd` is a turn whose dollars nothing
  // in this process saw, and `costUsd: 0` on it is a measurement and a false one —
  // `runNext` turns this pair into the `cost_usd: null` + `metered: false` row the
  // schema already requires. The `provider === "claude"` half stays because
  // `resolveCodexResultDoc` synthesizes `total_cost_usd: 0` for a turn Codex meters
  // in tokens only (`agentEvents.ts:159`): dropping the guard would read that
  // synthesized zero as a measurement and re-introduce the same lie for Codex.
  const hasUsd = typeof doc?.total_cost_usd === "number";
  const costUsd = hasUsd ? (doc?.total_cost_usd as number) : 0;
  const metered = provider === "claude" && hasUsd;
  const usage = toUsage(doc?.usage);
  const envelope = toEnvelope(doc?.structured_output);
  const result = typeof doc?.result === "string" ? doc.result : "";
  const ok = exitCode === 0 && !isError && !timedOut && doc !== null;
  const failure = ok ? null : describeFailure(exitCode, doc, stderr, timedOut, stdout, provider);

  return {
    ok, exitCode, timedOut, isError, sessionId, costUsd, metered, usage,
    // `interpret` is handed a finished process and a whole buffer: whatever usage
    // it found came off the result document. Only `spawnAgent`, which watched the
    // stream, can say otherwise — and it overwrites both fields when it can.
    usageBasis: "result",
    unmeteredReason: null,
    envelope,
    structured: doc?.structured_output ?? null, result,
    error: failure?.error ?? null,
    raw: stdout,
    permissionRefusal: permissionRefusal(stdout, provider),
    reads: 0,
    // `interpret` is handed a finished buffer, and the quota frames are STREAM
    // lines it is not asked to re-read. Only `spawnAgent`, which watched them go
    // past, can fill this in — and it does, below.
    rateLimit: null,
    stoppedBy: null,
    failureKind: failure?.kind ?? null,
    // Not measurable from here — see `AgentOutcome.durationMs`. `spawnAgent`
    // overwrites it with the span it timed; a direct caller of `interpret` (only
    // the tests) gets a `0` that nothing writes to a ledger.
    durationMs: 0,
  };
}

/** The signal a `runtime.spawn` exit code names, per `nodeRuntime.ts`'s `exitCodeOf`: Node reports a signalled
 *  death as `code: null` (translated upstream to `1` there for anything but these two), Bun as `128 + signal`. */
function killSignal(exitCode: number): "SIGKILL" | "SIGTERM" | null {
  return exitCode === 137 ? "SIGKILL" : exitCode === 143 ? "SIGTERM" : null;
}

/**
 * `AgentOutcome.error`'s text and `AgentOutcome.failureKind`'s value (gh #348),
 * from the SAME branches — one derivation, not two accounts that could drift
 * apart (AGENTS.md §7). Called only when `ok` is false.
 */
function describeFailure(
  exitCode: number,
  doc: ClaudeResultJson | null,
  stderr: string,
  timedOut: boolean,
  stdout: string,
  provider: AgentProvider,
): { readonly error: string; readonly kind: AgentFailureKind } {
  const name = provider === "codex" ? "codex" : "claude";
  if (timedOut) {
    return { error: `${name} timed out (killed after the stage's timeout_s)`, kind: "timeout" };
  }
  const signal = killSignal(exitCode);
  if (signal !== null) {
    const tail = firstLine(stderr) || firstLine(stdout) || "(no output)";
    return {
      error: `${name} was killed (${signal}, exit ${exitCode}) before it produced a result: ${tail}`,
      kind: "process_killed",
    };
  }
  if (doc === null) {
    const tail = firstLine(stderr) || firstLine(stdout) || "(no output)";
    return {
      error: `${name} exited ${exitCode} without a parseable result event: ${tail}`,
      // exitCode 0 with nothing parseable is a clean process that wrote
      // nothing this file can read as a result — an EMPTY result, not a
      // crash. Anything else is an ordinary non-zero death with no document
      // to say more.
      kind: exitCode === 0 ? "empty_result" : "non_zero_exit",
    };
  }
  // A document parsed, but not into a real result event: Codex's own sentinel
  // for an unreadable envelope, or (Claude) `resolveResultDoc`'s whole-buffer
  // fallback accepting JSON whose `type` was never `"result"` — the JSONL
  // branch it prefers already filters on that tag, so only that fallback path
  // can hand this function a document shaped like this.
  const malformed = provider === "codex"
    ? Array.isArray(doc.errors) && doc.errors[0] === CODEX_ENVELOPE_UNREADABLE
    : doc.type !== "result";
  const errors = Array.isArray(doc.errors) ? (doc.errors as unknown[]).filter((e) => typeof e === "string") : [];
  const verdict = `${name} exited ${exitCode} with is_error=${String(doc.is_error === true)}`;
  // Codex names its refusal in a pretty-printed block — `{\n  code: invalid_json_schema,\n
  // message: …\n}` — and this sentence lands in a handoff, where every line has to carry its
  // own citation: a multi-line reason renders as uncited continuation lines. Collapse the
  // whitespace instead of taking the first line, because the first line of that block is `{`
  // and the WHY is two lines down (#148). Claude's text is passed through untouched.
  const flatten = (text: string): string => (provider === "codex" ? text.replace(/\s+/g, " ").trim() : text);
  const named = flatten(typeof errors[0] === "string" ? (errors[0] as string) : "");
  if (named !== "") {
    return { error: `${verdict}: ${named}`, kind: malformed ? "malformed_result" : "non_zero_exit" };
  }
  const subtype = typeof doc.subtype === "string" ? doc.subtype : "";
  if (subtype !== "" && !SUCCESS_SUBTYPES.has(subtype)) {
    return { error: `${verdict}: ${subtype}`, kind: malformed ? "malformed_result" : "non_zero_exit" };
  }
  // Nothing here can name WHY. Say that, and — when the provider's own subtype is
  // the thing that disagrees — say that too, rather than dropping either half.
  const contradiction = subtype === "" ? "" : ` (the provider's own subtype said "${subtype}")`;
  return {
    error: `${verdict}: no reason named${contradiction}`,
    kind: malformed ? "malformed_result" : "unclassified",
  };
}

/**
 * Provider subtypes that assert the turn SUCCEEDED.
 *
 * `describeFailure()` is reached only when `ok` is false (`interpret`), so
 * one of these on the result document is not this failure's reason — it is a
 * SECOND, contradicting verdict. MEASURED (gh #296, two live unattended runs,
 * 2026-09-13): a turn that died against the account's usage limit parsed with
 * `errors: []` and `subtype: "success"`, and the old line concatenated the two
 * into `claude exited 1 with is_error=true: success` — an audit record whose only
 * human-readable word was the wrong one (AGENTS.md §7). WHY the turn died is still
 * unmeasured and this function does not guess at it; it refuses to borrow a word
 * that means the opposite.
 */
const SUCCESS_SUBTYPES: ReadonlySet<string> = new Set(["success"]);

function firstLine(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).find((l) => l !== "");
  return line === undefined ? "" : line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

/** `--max-budget-usd` takes a plain amount; two decimals is money, not a float. */
export function formatUsd(amount: number): string {
  return (Math.max(amount, 0.01)).toFixed(2);
}
