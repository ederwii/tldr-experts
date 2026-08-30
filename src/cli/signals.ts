/**
 * SIGINT and SIGTERM, for a CLI that spawns sub-agents.
 *
 * Deliberately ONE small block, in its own file, called from `index.ts` in one
 * line — the dispatcher's job is to route argv, and a signal handler bolted into
 * the middle of it is a merge conflict waiting to happen.
 *
 * What Ctrl-C used to do (measured, 2026-08-29): stop `tldrx`, and nothing else.
 * The sub-agent was spawned detached, so the terminal's SIGINT never reached it;
 * it kept working with `ppid 1`, kept billing against its `--max-budget-usd`, and
 * because a stage's cost is only recorded once the spawn returns, not a cent of
 * it appeared in `events.jsonl`. The run was left `running` behind a `.lock` held
 * by a pid that no longer existed.
 *
 * What it does now, in this order:
 *
 *   1. kill every spawned child's whole process tree — stop the spending FIRST
 *   2. run the registered interrupt hooks — record the partial attempt, demote
 *      `running` back to `ready`, release the `.lock` (`facilitator/interrupt.ts`)
 *   3. show the terminal cursor again, in case a progress view had hidden it
 *   4. exit 130 — the shell convention for "killed by SIGINT" (128 + 2)
 *
 * A SECOND signal while all that is happening exits immediately: an operator who
 * presses Ctrl-C twice means it, and a cleanup that refuses to be interrupted is
 * its own kind of hang.
 *
 * It also knows when NOT to act. `tldrx dashboard` and `tldrx watch` install
 * their own SIGINT handler and exit 0 on purpose — Ctrl-C is how you stop a
 * server, not a failure. When there is no sub-agent to kill and no run to close,
 * and another listener is registered, this one stands aside.
 */
import { killAllChildren } from "../core/runtime/index.ts";
import { runInterruptHooks } from "../core/facilitator/interrupt.ts";
import { currentActor, nowRfc3339 } from "../hooks/lib/actor.ts";

/** 128 + SIGINT(2). `tldrx` exits 130 for both signals: it was killed, not broken. */
export const EXIT_SIGNAL = 130;

const SHOW_CURSOR = "\x1b[?25h";
const SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

let installed = false;
let handling = false;

/**
 * Install the handlers, once. Idempotent, so a test or a nested dispatch can call
 * it without stacking listeners.
 */
export function installSignalHandlers(exit: (code: number) => never = defaultExit): void {
  if (installed) return;
  installed = true;
  for (const signal of SIGNALS) {
    process.on(signal, () => { handleSignal(signal, exit); });
  }
}

/** Exported for tests; `installSignalHandlers` is the only caller in `src/`. */
export function handleSignal(signal: NodeJS.Signals, exit: (code: number) => never = defaultExit): void {
  if (handling) exit(EXIT_SIGNAL);
  handling = true;

  // 1. Stop the money before anything else. Nothing below can fail in a way that
  //    leaves a sub-agent running, because it is already dead by this line.
  const killed = killAllChildren();

  // 2. Close the books. Never throws — see `runInterruptHooks`.
  const lines = runInterruptHooks({ signal, killed, actor: actorOrUnknown(), at: nowRfc3339() });

  // Nothing of ours was in flight AND some other listener is registered — that is
  // a command that owns its own shutdown (`dashboard` and `watch` both stop their
  // server and exit 0 on SIGINT). Stand aside rather than exit 130 over the top
  // of it: this handler exists to clean up sub-agents and locks, and there are
  // neither here. With no other listener there is nobody left to exit, so we do.
  if (killed === 0 && lines.length === 0 && process.listenerCount(signal) > 1) {
    handling = false;
    return;
  }

  const report = [
    `\ntldrx: ${signal} — ${killed === 0 ? "no sub-agent was running" : `killed ${String(killed)} sub-agent process tree(s)`}`,
    ...lines,
  ];
  try {
    process.stderr.write(`${report.join("\n")}\n`);
    // 3. A progress view hides the cursor; on this path its `finally` never runs.
    if (process.stderr.isTTY === true) process.stderr.write(SHOW_CURSOR);
  } catch {
    // A closed stderr is not a reason to skip the exit code.
  }
  exit(EXIT_SIGNAL);
}

function actorOrUnknown(): string {
  try {
    return currentActor();
  } catch {
    return "unknown";
  }
}

function defaultExit(code: number): never {
  process.exit(code);
}

/** For tests: pretend nothing was installed. Nothing in `src/` calls this. */
export function resetSignalHandlers(): void {
  for (const signal of SIGNALS) process.removeAllListeners(signal);
  installed = false;
  handling = false;
}
