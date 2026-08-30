/**
 * Append-only writer for `tldrx-work/<run>/events.jsonl` (spec §2.9).
 *
 * "Append-only enforced by comparing file byte length before/after — a write that
 * shortens the file is rejected." Both halves of that are here: `append` checks
 * the file did not shrink under it, and `replaceAll` (the only whole-file write
 * this class offers) refuses content shorter than what is already on disk.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MAX_LINE_BYTES, serializeEvent, validateEvent, type TldrxEvent } from "./Event.ts";

/** What one read of the ledger found, including what it could not parse. */
export interface EventReadResult {
  readonly events: readonly TldrxEvent[];
  /** 1-based line number of each event in `events`, same order. */
  readonly lines: readonly number[];
  /** Lines that were non-empty and did not parse — a torn write. */
  readonly skipped: number;
}

export class EventLog {
  constructor(readonly path: string) {}

  static forRun(runDir: string): EventLog {
    return new EventLog(join(runDir, "events.jsonl"));
  }

  get sizeBytes(): number {
    return existsSync(this.path) ? statSync(this.path).size : 0;
  }

  /** Validate, then append one line. Throws rather than writing a bad envelope. */
  append(event: TldrxEvent): void {
    const validation = validateEvent(event);
    if (!validation.ok) {
      const first = validation.issues[0];
      throw new Error(`refusing to append an invalid event: ${first?.path ?? ""} ${first?.message ?? ""}`);
    }
    const line = serializeEvent(event);
    const bytes = Buffer.byteLength(line, "utf8") + 1;
    if (bytes > MAX_LINE_BYTES) {
      throw new Error(`event line is ${bytes} bytes (max ${MAX_LINE_BYTES})`);
    }
    const before = this.sizeBytes;
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${line}\n`, "utf8");
    const after = this.sizeBytes;
    if (after < before + bytes) {
      throw new Error(
        `events.jsonl shrank under an append (${before} -> ${after} bytes): the log is append-only`,
      );
    }
  }

  /** Best-effort append for hooks: never throws, reports why it gave up. */
  tryAppend(event: TldrxEvent): string | null {
    try {
      this.append(event);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * The one whole-file write. Rejected when it would shorten the log — that is the
   * spec's append-only rule, enforced before anything touches disk.
   */
  replaceAll(content: string): void {
    const next = Buffer.byteLength(content, "utf8");
    const current = this.sizeBytes;
    if (next < current) {
      throw new Error(
        `refusing to shorten events.jsonl (${current} -> ${next} bytes): the log is append-only`,
      );
    }
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, content, "utf8");
  }

  /**
   * Every event, plus what could not be read.
   *
   * A JSONL file written by `appendFileSync` can be torn: the process dies
   * between the `{` and the `\n` and the last line is half an object. Before
   * 2026-08-29 `read()` ran that through a bare `JSON.parse` and threw, so ONE
   * torn byte took the entire history down with it — `tldrx replay` printed
   * "events.jsonl could not be read" and exit 0, for a file whose first 400 lines
   * were perfectly good. Tolerant readers already existed elsewhere
   * (`run/attempts.ts`, `executors/build.ts`); this makes the shared one agree
   * with them.
   *
   * Skipping is COUNTED, never silent: the count comes back here, and `read()`
   * says it once on stderr. A line that does not parse is still a lost event, and
   * a reader who is not told has been handed a quietly shorter history.
   */
  readAll(): EventReadResult {
    if (!existsSync(this.path)) return { events: [], lines: [], skipped: 0 };
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch {
      return { events: [], lines: [], skipped: 0 };
    }
    const events: TldrxEvent[] = [];
    const lines: number[] = [];
    let skipped = 0;
    text.split("\n").forEach((line, index) => {
      if (line.trim() === "") return;
      try {
        events.push(JSON.parse(line) as TldrxEvent);
        lines.push(index + 1);
      } catch {
        skipped += 1;
      }
    });
    return { events, lines, skipped };
  }

  /**
   * The events, with a one-time stderr note when any line had to be skipped.
   *
   * "Once" is per path per process: a command that reads the same ledger three
   * times says it once, and a torn line never becomes a wall of warnings.
   */
  read(): readonly TldrxEvent[] {
    const result = this.readAll();
    if (result.skipped > 0 && !WARNED.has(this.path)) {
      WARNED.add(this.path);
      process.stderr.write(`tldrx: ${this.path}: ${skippedNote(result.skipped)} (unparseable — a torn write)\n`);
    }
    return result.events;
  }
}

/** `1 line skipped` / `3 lines skipped` — one phrasing, for every reader. */
export function skippedNote(skipped: number): string {
  return `${String(skipped)} line${skipped === 1 ? "" : "s"} skipped`;
}

/** Paths already warned about in this process. See `read()`. */
const WARNED = new Set<string>();
