/**
 * Running the owner's declared notify command — once per notification, argv only.
 *
 * ## The one rule this class exists to keep
 *
 * **A notifier never changes a run's outcome.** Not its exit code, not its files, not one
 * line of its stdout. Everything that can go wrong here — a command that will not split,
 * a binary that is not there, a non-zero exit, a hang — is recorded as a `notify.failed`
 * event carrying the reason and then dropped. That is the "absent with a reason" rule
 * (AGENTS.md §7) applied to a side channel: the run's record says the owner was not told
 * and why, rather than the run failing because a chat tool was down.
 *
 * The event append itself goes through `EventLog.tryAppend`, which is the same promise one
 * layer down: a log that refused the line does not take the run with it either.
 *
 * ## Why argv, and why stdin
 *
 * `splitArgv` is the SAME splitter the DoD gate uses (`hooks/lib/story.ts`), imported
 * rather than re-spelled — `detect/probeCommands.ts` set that precedent for the same
 * reason. A command carrying a bare shell metacharacter is refused here exactly as it is
 * there: no shell is opened, so `|` and `&&` would be arguments pretending to be syntax.
 * The payload never touches the command line at all; it arrives on stdin as one JSON
 * object, so nothing a question's title contains can become part of a command.
 *
 * ## Serialisation
 *
 * Sends are chained. `--notify-every` fires from a timer while the loop is inside a
 * stage, so two notifications can be asked for at once; running them concurrently would
 * interleave two appends to `events.jsonl` and hand the owner's script two live stdins.
 * The chain costs a promise and removes both.
 */
import type { EventLog } from "../events/EventLog.ts";
import type { TldrxEvent } from "../events/Event.ts";
import { runtime } from "../runtime/index.ts";
import { splitArgv } from "../../hooks/lib/story.ts";
import type { NotifyDeclaration } from "./declaration.ts";
import { serializeNotification, type NotifyKind, type NotifyPayload } from "./payload.ts";

/** How much of a failing notifier's own output is quoted back into the event. */
const REASON_TAIL_MAX = 200;

export class Notifier {
  private chain: Promise<void> = Promise.resolve();
  /**
   * Set once, where the loop returns. A `--notify-every` tick that was already in flight
   * when the run ended would otherwise enqueue a `status` BEHIND `run.finished` — a
   * heartbeat for a run that is over, which is the one thing a heartbeat must not be.
   */
  private closed = false;

  constructor(
    private readonly declaration: NotifyDeclaration,
    private readonly log: EventLog,
    private readonly runId: string,
    private readonly cwd: string,
    private readonly actor: string,
  ) {}

  /** Whether the workspace subscribed to this kind at all. */
  wants(kind: NotifyKind): boolean {
    return this.declaration.events.includes(kind);
  }

  /**
   * Deliver one notification, or record why it could not be.
   *
   * Resolves when the invocation has finished and its event has been appended — the loop
   * awaits it at a stop, so the owner's phone has the answer command before the process
   * exits. Never rejects.
   */
  send(payload: NotifyPayload, stageId: string | null): Promise<void> {
    const queued = this.chain.then(() => this.run(payload, stageId));
    this.chain = queued.catch(() => undefined);
    return this.chain;
  }

  /** Wait for every queued send, then accept no more. Called once, where the loop returns. */
  async drain(): Promise<void> {
    this.closed = true;
    await this.chain;
  }

  private async run(payload: NotifyPayload, stageId: string | null): Promise<void> {
    if (this.closed || !this.wants(payload.kind)) return;
    const command = this.declaration.command;
    const argv = splitArgv(command);
    if (argv === null) {
      this.record("notify.failed", stageId, {
        kind: payload.kind,
        command,
        reason: `\`${command}\` needs a shell to run (it contains a metacharacter), and the notify hook `
          + "does not open one. Put it in a script and declare the script.",
      });
      return;
    }
    const head = argv[0] ?? "";
    const startedAt = Date.now();
    let result;
    try {
      result = await runtime.spawn(head, argv.slice(1), {
        stdin: `${serializeNotification(payload)}\n`,
        cwd: this.cwd,
        env: process.env,
        timeoutMs: this.declaration.timeoutMs,
      });
    } catch (error) {
      this.record("notify.failed", stageId, {
        kind: payload.kind,
        command,
        reason: `could not be started: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
    const durationMs = Date.now() - startedAt;
    if (result.spawnFailed === true) {
      this.record("notify.failed", stageId, {
        kind: payload.kind,
        command,
        reason: `\`${head}\` could not be started — no such executable, or it is not runnable`,
      });
      return;
    }
    if (result.timedOut) {
      this.record("notify.failed", stageId, {
        kind: payload.kind,
        command,
        reason: `timed out after ${String(this.declaration.timeoutMs)} ms and was killed`,
      });
      return;
    }
    if (result.exitCode !== 0) {
      this.record("notify.failed", stageId, {
        kind: payload.kind,
        command,
        reason: `exit ${String(result.exitCode)}${tail(result.stderr, result.stdout)}`,
      });
      return;
    }
    this.record("notify.sent", stageId, {
      kind: payload.kind,
      command,
      exit_code: result.exitCode,
      duration_ms: durationMs,
    });
  }

  private record(
    type: "notify.sent" | "notify.failed",
    stageId: string | null,
    payload: Readonly<Record<string, unknown>>,
  ): void {
    const event: TldrxEvent = {
      ts: new Date().toISOString(),
      run: this.runId,
      stage: stageId,
      type,
      actor: this.actor,
      // A notification spends nothing. A non-zero here would land in the run's own
      // spend arithmetic, which is money the framework did not pay.
      cost_usd: 0,
      payload,
    };
    this.log.tryAppend(event);
  }
}

/** The last meaningful line the notifier said, so a refusal is diagnosable. */
function tail(stderr: string, stdout: string): string {
  const lines = `${stderr}\n${stdout}`.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  const last = lines[lines.length - 1];
  if (last === undefined) return "";
  const quoted = last.length > REASON_TAIL_MAX ? `${last.slice(0, REASON_TAIL_MAX - 1)}…` : last;
  return ` — ${quoted}`;
}
