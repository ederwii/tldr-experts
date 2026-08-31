/**
 * Live progress for work that spawns NO sub-agent.
 *
 * `driver.ts` watches an `AgentEvent` stream. `tldrx init` has no such stream —
 * it is a deterministic sequence of filesystem and `git` steps — and for want of
 * a view for that shape it printed nothing at all until it was finished.
 * Measured 2026-08-30 on a five-repo workspace: 36.0 s of total silence with the
 * default `--provider auto` (graphify), against 1.3 s with `--provider static`,
 * so ~97% of the wait is inside one loop that used to say nothing.
 *
 * Same conventions as the agent view, deliberately: the mode comes from
 * `resolveUiMode`, so `--ui`, `TLDRX_UI`, `NO_COLOR` and `CI` mean here exactly
 * what they mean there; every byte goes to stderr, so stdout stays parseable;
 * and the cursor always comes back.
 *
 * One thing is different, and it is the reason this is not `driver.ts` with a
 * different renderer. The agent view repaints a BLOCK, because its content is a
 * picture of a moment. A step list is a HISTORY: a finished step must scroll
 * away and stay readable in the terminal's scrollback after the command exits.
 * So a completed step is printed once and never touched again, and only the one
 * step still running is a line that gets rewritten.
 */
import { SPINNER } from "./compact.ts";
import { palette, colorEnabled, type Palette } from "./color.ts";
import { FRAME_MS } from "./driver.ts";
import { renderCampus } from "./campus.ts";
import { resolveUiMode, type UiEnvironment, type UiMode } from "./mode.ts";
import { duration } from "./summary.ts";

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CLEAR_LINE = "\r\x1b[2K";

/** Below this a step is fast enough that its duration is noise. */
export const SLOW_STEP_MS = 1_000;

/**
 * How often a still-running step says so in `plain` mode, where there is no
 * spinner to prove the process is alive. Five seconds, not one: a log that
 * repeats itself twelve times a minute is a log nobody reads.
 */
export const HEARTBEAT_MS = 5_000;

/** One thing `init` is doing, from the moment it starts until it reports. */
export interface StepRun {
  /**
   * A durable sub-result: the repo that finished, the document that was written.
   * In a terminal it is the tail of the one line that is moving; in `plain` it
   * is its own indented line, because there is nothing to rewrite.
   */
  note(text: string): void;
  /**
   * Live detail that is worth SEEING and not worth KEEPING — the repo that just
   * started, the name being considered. It moves the terminal line and is
   * dropped entirely in `plain`, because a log that records both "starting x"
   * and "finished x" for sixteen experts is a log nobody reads.
   */
  tick(text: string): void;
  /** Finish, and say what came of it. */
  done(detail: string): void;
  /** Finish badly. The step list keeps going: the caller decides what a failure means. */
  fail(detail: string): void;
}

export interface StepReporter {
  readonly mode: UiMode;
  /** False for `--quiet`, `--ui off`, and the silent reporter tests use. */
  readonly active: boolean;
  begin(label: string): StepRun;
  /** A line that belongs to no step — a heading, or a refusal. */
  say(text: string): void;
  /** Idempotent. Clears any live line and restores the cursor. */
  stop(): void;
}

export interface StepOptions extends UiEnvironment {
  /** Workspace root, for the banner's caption. */
  readonly root: string;
  /** Where a byte goes. Defaults to stderr. Injected by tests. */
  readonly write?: (text: string) => void;
  /** Injected by tests so every duration is a subtraction of two given numbers. */
  readonly now?: () => number;
  /** Injected by tests: return null to run without a timer. */
  readonly schedule?: (fn: () => void, ms: number) => (() => void) | null;
}

/** A reporter that renders nothing. What `--quiet` installs, and what tests default to. */
export function silentSteps(): StepReporter {
  const run: StepRun = { note: noop, tick: noop, done: noop, fail: noop };
  return {
    mode: "off",
    active: false,
    begin: (): StepRun => run,
    say: noop,
    stop: noop,
  };
}

/**
 * Install the step view for this invocation and return its handle.
 *
 * Always returns a handle, so every caller writes the same
 * `try { … } finally { steps.stop(); }` — a view that must be conditionally
 * stopped is a view that will one day not be.
 */
export function startSteps(options: StepOptions): StepReporter {
  const mode = resolveUiMode(options);
  if (mode === "off") return silentSteps();

  const now = options.now ?? ((): number => Date.now());
  const write = options.write ?? ((text: string): void => { process.stderr.write(text); });
  const live = mode === "scene" || mode === "compact";
  const ink = palette(live && colorEnabled({ isTty: options.isTty, env: options.env }));

  let open: OpenStep | null = null;
  let painted = false;
  let tick = 0;
  let stopped = false;
  let cancelTimer: (() => void) | null = null;
  let exitHook: (() => void) | null = null;

  const erase = (): void => {
    if (!painted) return;
    write(CLEAR_LINE);
    painted = false;
  };

  const paint = (): void => {
    if (stopped || !live || open === null) return;
    const glyph = SPINNER[tick % SPINNER.length] ?? "-";
    write(`${CLEAR_LINE}  ${ink.cyan(glyph)} ${runningLine(open, now(), ink, options.cols)}`);
    painted = true;
  };

  const finish = (step: OpenStep, detail: string, ok: boolean): void => {
    if (open !== step) return;
    open = null;
    erase();
    const took = elapsedSuffix(now() - step.startedAt, ink);
    const mark = ok ? ink.green("✓") : ink.red("✗");
    const body = ok ? detail : ink.red(detail);
    write(`  ${mark} ${body}${took}\n`);
  };

  const heartbeat = (): void => {
    tick += 1;
    if (live) { paint(); return; }
    if (open === null) return;
    const waited = now() - open.startedAt;
    if (waited < HEARTBEAT_MS) return;
    write(`      ${ink.dim(`still ${open.label} — ${duration(waited)}`)}\n`);
  };

  const handle: StepReporter = {
    mode,
    active: true,
    begin(label: string): StepRun {
      // A step left open by a throwing caller is closed here rather than leaking
      // its live line into the next one's.
      if (open !== null) finish(open, open.detail === null ? open.label : open.detail, true);
      const step: OpenStep = { label, detail: null, startedAt: now() };
      open = step;
      if (live) paint();
      else write(`  ${ink.cyan("·")} ${label}…\n`);
      return {
        note(text: string): void {
          if (open !== step) return;
          step.detail = text;
          if (live) paint();
          else write(`      ${ink.dim(text)}\n`);
        },
        tick(text: string): void {
          if (open !== step) return;
          step.detail = text;
          if (live) paint();
        },
        done(detail: string): void { finish(step, detail, true); },
        fail(detail: string): void { finish(step, detail, false); },
      };
    },
    say(text: string): void {
      erase();
      write(`${text}\n`);
      paint();
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      cancelTimer?.();
      cancelTimer = null;
      erase();
      if (live) write(SHOW_CURSOR);
      if (exitHook !== null) { process.off("exit", exitHook); exitHook = null; }
    },
  };

  if (mode === "scene") {
    for (const row of renderCampus({ root: options.root, palette: ink, cols: options.cols })) {
      write(`${row}\n`);
    }
    write("\n");
  }
  if (live) {
    write(HIDE_CURSOR);
    // `stop()` is called explicitly by every caller, in a `finally`. This is for
    // the paths a `finally` does not reach.
    exitHook = (): void => { write(SHOW_CURSOR); };
    process.on("exit", exitHook);
  }
  const schedule = options.schedule ?? defaultSchedule;
  cancelTimer = schedule(heartbeat, live ? FRAME_MS : HEARTBEAT_MS);
  return handle;
}

interface OpenStep {
  readonly label: string;
  detail: string | null;
  readonly startedAt: number;
}

/** `detecting repos… mobile · 3 s`, clipped to the terminal. */
function runningLine(step: OpenStep, at: number, ink: Palette, cols: number): string {
  const took = duration(Math.max(0, at - step.startedAt));
  const head = `${step.label}…`;
  const tail = step.detail === null ? took : `${step.detail} · ${took}`;
  const room = Math.max(8, cols - head.length - 6);
  const shown = tail.length <= room ? tail : `${tail.slice(0, Math.max(1, room - 1))}…`;
  return `${head} ${ink.dim(shown)}`;
}

/** `  (21 s)`, and nothing at all for a step nobody waited on. */
function elapsedSuffix(ms: number, ink: Palette): string {
  return ms < SLOW_STEP_MS ? "" : ink.gray(`  (${duration(ms)})`);
}

/** A repeating timer that never keeps the process alive on its own. */
function defaultSchedule(fn: () => void, ms: number): () => void {
  const timer = setInterval(fn, ms);
  (timer as { unref?: () => void }).unref?.();
  return (): void => { clearInterval(timer); };
}

function noop(): void {
  // Intentionally nothing: the silent reporter is the null object.
}
