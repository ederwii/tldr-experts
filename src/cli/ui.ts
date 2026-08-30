/**
 * `--ui <mode>`, shared by the four commands that spawn `claude` and make a
 * person wait: `next`, `run auto`, `expert train`, `seed triage --propose`.
 *
 * The CLI is the only layer that knows whether anybody is watching, so it is the
 * only layer that installs a progress driver. `--prepare`, `--commit` and
 * `--dry-run` spawn nothing and get nothing — a view of an empty stream would be
 * a decoration that lies.
 *
 * The environment is read HERE and passed down, so `resolveUiMode` stays a pure
 * function and every mode is testable without a terminal.
 */
import { stringFlag, UsageError, type ParsedArgs } from "./argv.ts";
import { startProgress, UiModeError, type ProgressHandle } from "../core/ui/index.ts";

/** Default terminal geometry when stderr will not say — a plain 80x24. */
const FALLBACK_COLS = 80;
const FALLBACK_ROWS = 24;

export interface UiStartOptions {
  readonly root: string;
  readonly title?: string;
  /** Set false for `--prepare`/`--commit`/`--dry-run`: nothing will be spawned. */
  readonly spawns?: boolean;
}

/**
 * Install the progress view for this invocation, or a handle that does nothing.
 *
 * Always returns a handle, so every caller can write the same
 * `try { … } finally { ui.stop(); }` — a view that must be conditionally stopped
 * is a view that will one day not be.
 */
export function startUi(args: ParsedArgs, options: UiStartOptions): ProgressHandle {
  const flag = options.spawns === false ? "off" : stringFlag(args, "ui");
  try {
    return startProgress({
      root: options.root,
      title: options.title,
      flag,
      env: process.env,
      isTty: process.stderr.isTTY === true,
      cols: process.stderr.columns ?? FALLBACK_COLS,
      rows: process.stderr.rows ?? FALLBACK_ROWS,
    });
  } catch (error) {
    // A bad `--ui` value is a usage error like any other, raised before the
    // command does any work rather than after it has spent money.
    if (error instanceof UiModeError) throw new UsageError(error.message);
    throw error;
  }
}
