/**
 * ANSI colour, decided once and passed as a value.
 *
 * There is no global "are we in colour" flag here on purpose. A `tldrx` process
 * has TWO independent streams and they are not always the same kind of thing:
 * `tldrx init > report.txt` on a terminal has a piped stdout and a TTY stderr,
 * and a palette resolved from the wrong one writes escape codes into the file.
 * So a caller resolves `colorEnabled({ isTty })` per stream and holds the
 * `Palette` it got back.
 *
 * `palette(false)` returns the identity for every ink, so a renderer never
 * branches on colour — it paints, and a disabled palette is a no-op. That is
 * what keeps the plain path byte-for-byte deterministic in a test.
 *
 * Written by hand: this repo has zero runtime dependencies and is not about to
 * grow one for nine escape sequences.
 */

/** Wraps text in one escape pair, or returns it untouched. */
export type Ink = (text: string) => string;

export interface Palette {
  readonly enabled: boolean;
  readonly bold: Ink;
  readonly dim: Ink;
  readonly red: Ink;
  readonly green: Ink;
  readonly yellow: Ink;
  readonly blue: Ink;
  readonly magenta: Ink;
  readonly cyan: Ink;
  /** Bright black. For punctuation and units, never for information. */
  readonly gray: Ink;
}

const RESET = "\x1b[0m";

const CODES = {
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
} as const;

const PLAIN: Palette = {
  enabled: false,
  bold: identity, dim: identity, red: identity, green: identity, yellow: identity,
  blue: identity, magenta: identity, cyan: identity, gray: identity,
};

const COLOUR: Palette = {
  enabled: true,
  bold: wrap(CODES.bold), dim: wrap(CODES.dim), red: wrap(CODES.red),
  green: wrap(CODES.green), yellow: wrap(CODES.yellow), blue: wrap(CODES.blue),
  magenta: wrap(CODES.magenta), cyan: wrap(CODES.cyan), gray: wrap(CODES.gray),
};

export function palette(enabled: boolean): Palette {
  return enabled ? COLOUR : PLAIN;
}

export interface ColorEnvironment {
  /** Is the stream this palette will be written to a terminal? */
  readonly isTty: boolean;
  /** `FORCE_COLOR`, `NO_COLOR` and `CI` are read from here, never from the process. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * `FORCE_COLOR` wins, then `NO_COLOR`, then `CI`, then the stream itself.
 *
 * `FORCE_COLOR` is first because it is the only way a test — or a user piping
 * into `less -R` — can ask for escapes on a stream that is not a terminal.
 */
export function colorEnabled(input: ColorEnvironment): boolean {
  const env = input.env ?? {};
  if (truthy(env.FORCE_COLOR)) return true;
  if (truthy(env.NO_COLOR)) return false;
  if (truthy(env.CI)) return false;
  return input.isTty;
}

/** How wide a string is on screen: the same string with every escape removed. */
export function visibleLength(text: string): number {
  return stripAnsi(text).length;
}

// eslint-disable-next-line no-control-regex -- the point of this function.
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

function wrap(code: string): Ink {
  return (text: string): string => `${code}${text}${RESET}`;
}

function identity(text: string): string {
  return text;
}

/** `NO_COLOR` and `CI` are conventionally "set at all", not "set to true". */
function truthy(value: string | undefined): boolean {
  return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}
