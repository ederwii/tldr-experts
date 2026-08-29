/**
 * One line of stdin at a time, with no dependencies.
 *
 * Two sources, because stdin is two different things here:
 *
 * - **Piped** (`printf 'A\nB\n' | tldrx interview`, and every test) — the whole
 *   stream is finite, so it comes through the runtime seam's `readStdin()` in one
 *   read and is handed out line by line. Using the seam is the point: it is the
 *   one place allowed to know whether it is Bun or Node underneath.
 * - **A terminal** — never ends, so it cannot be read in one go. `[assumption]`:
 *   the seam has no incremental reader (nothing else in the framework needed one),
 *   so the TTY branch listens to `process.stdin` directly. That is `node:process`,
 *   identical on both runtimes, so the seam invariant (no bun-namespaced call
 *   site outside `src/core/runtime/`) still holds.
 *
 * A reader that runs out returns `null` forever, which the interview treats as
 * "the human stopped answering" — remaining questions stay open.
 */
import { runtime } from "../runtime/index.ts";

export interface LineReader {
  /** The next line without its terminator, or null at end of input. */
  next(): Promise<string | null>;
  /** Release stdin so the process can exit. Safe to call twice. */
  close(): void;
}

export interface LineReaderOptions {
  /** Force a source instead of sniffing `process.stdin.isTTY`. */
  readonly interactive?: boolean;
  /** Injection point for tests: what the buffered reader reads. */
  readonly readAll?: () => Promise<string>;
}

export function createLineReader(options: LineReaderOptions = {}): LineReader {
  const interactive = options.interactive ?? process.stdin.isTTY === true;
  return interactive ? interactiveReader() : bufferedReader(options.readAll ?? (() => runtime.readStdin()));
}

/** Everything at once, then handed out. The piped and tested path. */
function bufferedReader(readAll: () => Promise<string>): LineReader {
  let lines: string[] | null = null;
  let at = 0;
  return {
    async next(): Promise<string | null> {
      if (lines === null) lines = splitLines(await readAll());
      return at < lines.length ? (lines[at++] ?? null) : null;
    },
    close(): void {
      lines = [];
      at = 0;
    },
  };
}

/** Incremental, for a terminal that never reaches EOF. */
function interactiveReader(): LineReader {
  const input = process.stdin;
  input.setEncoding("utf8");
  input.resume();

  let buffer = "";
  let ended = false;
  let closed = false;
  const waiting: ((line: string | null) => void)[] = [];

  const flush = (): void => {
    while (waiting.length > 0) {
      const at = buffer.indexOf("\n");
      if (at !== -1) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        waiting.shift()?.(stripCr(line));
        continue;
      }
      if (!ended) return;
      const rest = buffer;
      buffer = "";
      waiting.shift()?.(rest === "" ? null : stripCr(rest));
    }
  };

  const onData = (chunk: unknown): void => { buffer += String(chunk); flush(); };
  const onEnd = (): void => { ended = true; flush(); };

  input.on("data", onData);
  input.on("end", onEnd);
  input.on("error", onEnd);

  return {
    next(): Promise<string | null> {
      if (closed || (ended && buffer === "")) return Promise.resolve(null);
      return new Promise<string | null>((resolve) => {
        waiting.push(resolve);
        flush();
      });
    },
    close(): void {
      if (closed) return;
      closed = true;
      ended = true;
      flush();
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onEnd);
      input.pause();
    },
  };
}

/**
 * Split on `\n`, dropping a single trailing empty line so `"A\n"` is one answer
 * and not an answer plus a skip. A blank line in the MIDDLE is kept — it means
 * "skip this one", and swallowing it would shift every later answer up by one.
 */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n").map(stripCr);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function stripCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}
