/**
 * The one wire between "a sub-agent did something" and "a human can see it".
 *
 * A module-level sink rather than a callback threaded through `runNext` →
 * executor → `spawnAgent`: the progress view is a property of the PROCESS (is a
 * person watching this terminal?), not of the algorithm, and six signatures
 * carrying an optional renderer would be six chances to forget one. Nothing in
 * `src/core/` renders; it only publishes here. The CLI decides whether anyone is
 * listening, and installs the sink if so.
 *
 * With no sink installed every function here is a no-op, which is exactly the
 * behaviour a test, a hook and a piped invocation want.
 */
import type { AgentEvent } from "../facilitator/agentEvents.ts";

export interface ProgressSink {
  /**
   * `lane` names the concurrent unit the event came from — a Build story id when
   * a wave is running with `--parallel N`, undefined when there is only one thing
   * running. Optional and additive: a sink that ignores it behaves exactly as it
   * did when nothing was ever parallel.
   */
  onEvent(event: AgentEvent, lane?: string): void;
  /** The blackboard heading: `what · 260829-tenancy · attempt 1`. */
  onTitle?(title: string): void;
  /** The stage's own ceiling, for the footer's `$x.xx of $y.yy`. */
  onCeiling?(usd: number): void;
  /** The stage's `max_reads`, for the footer's `reads 37/120`. 0 = uncapped. */
  onReadCap?(cap: number): void;
}

let sink: ProgressSink | null = null;

/** Install (or clear) the sink. Returns the previous one, so a caller can nest. */
export function setProgressSink(next: ProgressSink | null): ProgressSink | null {
  const previous = sink;
  sink = next;
  return previous;
}

export function progressActive(): boolean {
  return sink !== null;
}

/**
 * Publish one event. A throwing sink must never fail a stage — a progress view
 * is not allowed to be the reason money was spent for nothing.
 */
export function emitAgentEvent(event: AgentEvent, lane?: string): void {
  if (sink === null) return;
  try {
    sink.onEvent(event, lane);
  } catch {
    // A broken renderer is a cosmetic problem. Keep running.
  }
}

export function setProgressTitle(title: string): void {
  if (sink === null) return;
  try {
    sink.onTitle?.(title);
  } catch {
    // See above.
  }
}

export function setProgressCeiling(usd: number): void {
  if (sink === null) return;
  try {
    sink.onCeiling?.(usd);
  } catch {
    // See above.
  }
}

export function setProgressReadCap(cap: number): void {
  if (sink === null) return;
  try {
    sink.onReadCap?.(cap);
  } catch {
    // See above.
  }
}
