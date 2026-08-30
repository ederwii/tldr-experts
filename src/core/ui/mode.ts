/**
 * Which view to draw, decided once per invocation.
 *
 * `auto` is the default and it is deliberately conservative: a redraw loop
 * belongs on a terminal a person is looking at and NOWHERE else, so anything
 * that is not one gets plain log lines instead. An explicit `--ui scene` in a
 * pipe still degrades — the flag says what you would like, not what the pipe can
 * render, and ANSI cursor moves in a log file help nobody.
 */
export const UI_MODES = ["auto", "scene", "compact", "plain", "off"] as const;
export type UiModeFlag = (typeof UI_MODES)[number];

/** What the driver actually draws. */
export type UiMode = "scene" | "compact" | "plain" | "off";

export const MIN_SCENE_COLS = 72;
export const MIN_SCENE_ROWS = 20;

export interface UiEnvironment {
  /** `--ui <mode>`; undefined when the flag was not passed. */
  readonly flag?: string | undefined;
  /** `TLDRX_UI`, `NO_COLOR` and `CI` are read from here, never from the process. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly isTty: boolean;
  readonly cols: number;
  readonly rows: number;
}

export class UiModeError extends Error {}

export function isUiModeFlag(value: string): value is UiModeFlag {
  return (UI_MODES as readonly string[]).includes(value);
}

/**
 * Resolve the mode. Throws `UiModeError` only for a value nobody could have
 * meant — every legal value that the terminal cannot render degrades silently.
 */
export function resolveUiMode(input: UiEnvironment): UiMode {
  const env = input.env ?? {};
  const raw = input.flag ?? env.TLDRX_UI ?? "auto";
  const wanted = raw.trim().toLowerCase();
  if (!isUiModeFlag(wanted)) {
    throw new UiModeError(`--ui must be one of ${UI_MODES.join(" | ")} (got '${raw}')`);
  }
  if (wanted === "off") return "off";
  // A pipe, a file, a CI job, or a terminal that asked for no decoration: log
  // lines. This applies to an EXPLICIT `--ui scene` too — see the header.
  const drawable = input.isTty && !truthy(env.NO_COLOR) && !truthy(env.CI);
  if (!drawable) return "plain";
  if (wanted === "plain") return "plain";
  if (wanted === "compact") return "compact";
  const roomy = input.cols >= MIN_SCENE_COLS && input.rows >= MIN_SCENE_ROWS;
  return roomy ? "scene" : "compact";
}

/** `NO_COLOR` and `CI` are conventionally "set at all", not "set to true". */
function truthy(value: string | undefined): boolean {
  return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}
