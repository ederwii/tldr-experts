/**
 * Timestamped log lines — one per summary, no escapes, no redraw.
 *
 * What a pipe, a CI job and the chat bridge get, and what anyone gets who asked
 * for it with `--ui plain`. The timestamp is ELAPSED, not wall clock: it is the
 * number a person reading "why did this take four minutes" actually wants, it
 * needs no timezone, and it makes a log line reproducible in a test.
 *
 * These go to stderr like every other progress byte. stdout stays exactly what
 * it was, so `tldrx next --prepare | jq` and the chat bridge are untouched.
 */
import { clockFace } from "./summary.ts";

export function plainLine(elapsedMs: number, summary: string): string {
  return `[${clockFace(elapsedMs)}] ${summary.trim()}`;
}
