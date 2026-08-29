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

  read(): readonly TldrxEvent[] {
    if (!existsSync(this.path)) return [];
    const text = readFileSync(this.path, "utf8");
    const events: TldrxEvent[] = [];
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      events.push(JSON.parse(line) as TldrxEvent);
    }
    return events;
  }
}
