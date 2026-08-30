/**
 * The redraw loop, and the only file here that touches a terminal.
 *
 * Three promises it keeps:
 *
 * 1. **stdout is never written to.** Not one byte. Command output, `--json` and
 *    the chat bridge's parsing are exactly what they were before this existed;
 *    every progress byte goes to stderr. That is not a style preference — a
 *    progress view that corrupted `tldrx next --prepare | jq` would be a bug in
 *    the thing it is decorating.
 * 2. **Only changed lines are rewritten.** A full repaint at 4 fps makes a
 *    terminal flicker and a `screen`/`tmux` session crawl; a frame here is a
 *    cursor-up plus one `\x1b[2K` per line that actually differs.
 * 3. **The cursor always comes back.** Normal exit, thrown error, Ctrl-C, or the
 *    process being told to stop: `stop()` is idempotent and is wired to `exit`
 *    and `SIGINT` as well as being called explicitly. A tool that leaves an
 *    invisible cursor behind has broken the user's shell, not just its own view.
 *
 * ANSI is written by hand: this repo has zero runtime dependencies and is not
 * about to grow one for eight escape sequences.
 */
import type { AgentEvent } from "../facilitator/agentEvents.ts";
import { setProgressSink, type ProgressSink } from "./bus.ts";
import { renderCompact } from "./compact.ts";
import { resolveUiMode, type UiMode, type UiEnvironment } from "./mode.ts";
import { plainLine } from "./plain.ts";
import { renderScene } from "./scene.ts";
import { UiState } from "./state.ts";

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CLEAR_LINE = "\r\x1b[2K";
const CLEAR_BELOW = "\x1b[J";

/** 4 frames a second: fast enough to look alive, slow enough to cost nothing. */
export const FRAME_MS = 250;

export interface ProgressOptions extends UiEnvironment {
  readonly root: string;
  readonly title?: string;
  readonly ceilingUsd?: number;
  /** Epoch millis. Defaults to now. */
  readonly startedAt?: number;
  /** Where a frame goes. Defaults to stderr. Injected by tests. */
  readonly write?: (text: string) => void;
  /** Injected by tests so a frame is a pure function of a number. */
  readonly now?: () => number;
  /** Injected by tests: return null to run without a timer. */
  readonly schedule?: (fn: () => void, ms: number) => (() => void) | null;
}

export interface ProgressHandle extends ProgressSink {
  readonly mode: UiMode;
  /** Declared non-optional here: a handle always implements the whole sink. */
  onTitle(title: string): void;
  onCeiling(usd: number): void;
  /** Erase the view, run `body`, and repaint. For a caller writing to stdout. */
  log(body: () => void): void;
  /** Idempotent. Leaves the last frame on screen and restores the cursor. */
  stop(): void;
  /** The frame the driver would paint right now — for tests and for `--ui` docs. */
  frame(): readonly string[];
}

/**
 * Install a progress view for this invocation and return its handle.
 *
 * The handle is registered as the global sink, so `spawnAgent` needs to know
 * nothing about it. `stop()` un-registers, restores the cursor, and is safe to
 * call twice.
 */
export function startProgress(options: ProgressOptions): ProgressHandle {
  const mode = resolveUiMode(options);
  const now = options.now ?? ((): number => Date.now());
  const write = options.write ?? ((text: string): void => { process.stderr.write(text); });
  const state = new UiState({
    root: options.root,
    ceilingUsd: options.ceilingUsd,
    title: options.title,
    startedAt: options.startedAt ?? now(),
    width: summaryWidth(options.cols),
  });

  let painted: string[] = [];
  let tick = 0;
  let stopped = false;
  let cancelTimer: (() => void) | null = null;
  let sigint: (() => void) | null = null;
  let exitHook: (() => void) | null = null;
  const previous = setProgressSink(null);

  const size = (): { cols: number; rows: number } => ({
    // Re-read every frame: a terminal that was resized mid-run must not keep
    // drawing at the width it had when the stage started.
    cols: liveCols(options),
    rows: liveRows(options),
  });

  const compose = (): readonly string[] => {
    const { cols, rows } = size();
    state.setWidth(summaryWidth(cols));
    const snapshot = state.snapshot(now());
    if (mode === "scene") return renderScene(snapshot, { cols, rows, tick });
    if (mode === "compact") return [renderCompact(snapshot, cols, tick)];
    return [];
  };

  const paint = (): void => {
    if (stopped || mode === "plain" || mode === "off") return;
    const next = [...compose()];
    if (next.length !== painted.length) {
      // The block changed shape (a resize, or the first frame). Wipe and repaint
      // rather than leave orphaned rows from the old height on screen.
      if (painted.length > 0) write(`\x1b[${String(painted.length)}A${CLEAR_BELOW}`);
      write(next.map((line) => `${CLEAR_LINE}${line}\n`).join(""));
      painted = next;
      return;
    }
    if (painted.length === 0) return;
    let out = `\x1b[${String(painted.length)}A`;
    for (let i = 0; i < next.length; i++) {
      // An unchanged row costs one newline: the cursor steps over it and the
      // pixels on screen are never touched.
      out += next[i] === painted[i] ? "\n" : `${CLEAR_LINE}${next[i] ?? ""}\n`;
    }
    write(out);
    painted = next;
  };

  const erase = (): void => {
    if (painted.length === 0) return;
    write(`\x1b[${String(painted.length)}A${CLEAR_BELOW}`);
    painted = [];
  };

  const handle: ProgressHandle = {
    mode,
    onEvent(event: AgentEvent): void {
      const at = now();
      const lines = state.apply(event, at);
      if (mode === "plain") {
        const elapsed = state.snapshot(at).elapsedMs;
        for (const line of lines) write(`${plainLine(elapsed, line)}\n`);
        return;
      }
      // Repaint immediately on a real event rather than waiting up to 250 ms:
      // the whole complaint this exists to answer is "it said nothing".
      if (lines.length > 0) paint();
    },
    onTitle(title: string): void {
      state.setTitle(title);
      if (mode === "plain") write(`${plainLine(state.snapshot(now()).elapsedMs, `— ${title}`)}\n`);
      else paint();
    },
    onCeiling(usd: number): void {
      state.setCeiling(usd);
    },
    log(body: () => void): void {
      erase();
      body();
      paint();
    },
    frame(): readonly string[] {
      return compose();
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      cancelTimer?.();
      cancelTimer = null;
      if (mode === "compact" && painted.length === 1) write("\n");
      if (mode !== "plain" && mode !== "off") write(SHOW_CURSOR);
      if (sigint !== null) { process.off("SIGINT", sigint); sigint = null; }
      if (exitHook !== null) { process.off("exit", exitHook); exitHook = null; }
      setProgressSink(previous);
    },
  };

  if (mode === "off") {
    setProgressSink(null);
    return handle;
  }
  setProgressSink(handle);

  if (mode !== "plain") {
    write(HIDE_CURSOR);
    // Belt and braces. `stop()` is called explicitly by every caller, in a
    // `finally`; these two are for the paths a `finally` does not reach.
    exitHook = (): void => { write(SHOW_CURSOR); };
    process.on("exit", exitHook);
    sigint = (): void => {
      handle.stop();
      // Restore the default behaviour rather than swallow the signal: adding a
      // listener already stopped Node from exiting on its own.
      process.off("SIGINT", sigint ?? (() => undefined));
      process.kill(process.pid, "SIGINT");
    };
    process.on("SIGINT", sigint);

    const schedule = options.schedule ?? defaultSchedule;
    cancelTimer = schedule(() => { tick += 1; paint(); }, FRAME_MS);
    paint();
  }
  return handle;
}

/** A repeating timer that never keeps the process alive on its own. */
function defaultSchedule(fn: () => void, ms: number): () => void {
  const timer = setInterval(fn, ms);
  (timer as { unref?: () => void }).unref?.();
  return (): void => { clearInterval(timer); };
}

/** How wide a summary line may be, given the terminal. */
function summaryWidth(cols: number): number {
  return Math.max(24, Math.min(96, cols - 8));
}

/**
 * The terminal's live size, or the size the caller declared.
 *
 * `process.stderr` is only consulted when the caller did NOT override `write` —
 * a test that injects a writer is describing a terminal that does not exist, and
 * must not have its declared 80x24 quietly replaced by the real one.
 */
function liveCols(options: ProgressOptions): number {
  if (options.write !== undefined) return options.cols;
  const live = process.stderr.columns;
  return typeof live === "number" && live > 0 ? live : options.cols;
}

function liveRows(options: ProgressOptions): number {
  if (options.write !== undefined) return options.rows;
  const live = process.stderr.rows;
  return typeof live === "number" && live > 0 ? live : options.rows;
}
