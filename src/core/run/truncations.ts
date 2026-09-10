/**
 * What the inputs budget cut, read back off `events.jsonl` — for the owner, not
 * for the sub-agent.
 *
 * `seedInputs.ts` has always TOLD the sub-agent, in-band, exactly which declared
 * input it only got a prefix of ("truncated inputs: … the 98,304-byte
 * `inputs_max_bytes` budget ran out"). #207 measured what that leaves out: on a
 * real workspace a 168,873 B `facts.yml` was cut to 86,571 B for an `effort:
 * high` design turn that then ran to its `timeout_s` and was killed, and the
 * ONLY place that fact existed was `.agent/<stage>/prompt.md` — a file nobody
 * opens until after a zero-on-the-books failure. The person paying for the turn
 * was never told that half the ledger it was reasoning from had been dropped.
 *
 * So `runNext` now appends one `input.truncated` per cut input at spawn, and this
 * leaf is the ONE place that reads them back and words them. Three surfaces share
 * it — `tldrx run status --verbose`, the `stage.done`/`run.failed`/`status`
 * notification summaries, and the tests — because three renderers each computing
 * "169 KB → 87 KB" is three chances to disagree about a number the operator is
 * being asked to act on.
 *
 * No new `NotifyKind`. A truncation is not a moment that wants its own tap on the
 * shoulder; it is a caveat on the moments already being announced, and a tenth
 * kind would have to be handled by every adapter anyone has already written.
 */
import { EventLog } from "../events/EventLog.ts";
import type { TldrxEvent } from "../events/Event.ts";
import { fileSize, plural } from "../map/plural.ts";

/** One declared input the stage's `inputs_max_bytes` could not fit whole. */
export interface Truncation {
  readonly stage: string;
  readonly path: string;
  /** The file's size on disk. */
  readonly bytes: number;
  /** How much of it reached the prompt. `0` when none of it did. */
  readonly inlinedBytes: number;
  /** The `inputs_max_bytes` budget in force for that stage. */
  readonly cap: number;
}

/**
 * Every `input.truncated` this run recorded for `stage`, in ledger order.
 *
 * Never throws: a missing or half-written ledger yields no truncations, exactly
 * as `stageAttempts` treats a torn last line.
 */
export function stageTruncations(runDir: string, stage: string): readonly Truncation[] {
  return runTruncations(runDir).filter((entry) => entry.stage === stage);
}

/** Every `input.truncated` this run recorded, any stage, in ledger order. */
export function runTruncations(runDir: string): readonly Truncation[] {
  let events: readonly TldrxEvent[];
  try {
    events = EventLog.forRun(runDir).read();
  } catch {
    return [];
  }
  const out: Truncation[] = [];
  for (const event of events) {
    if (event.type !== "input.truncated") continue;
    const payload = event.payload as Record<string, unknown>;
    const path = typeof payload.path === "string" ? payload.path : null;
    if (path === null) continue;
    out.push({
      stage: typeof payload.stage === "string" ? payload.stage : (event.stage ?? ""),
      path,
      bytes: num(payload.bytes),
      inlinedBytes: num(payload.inlined_bytes),
      cap: num(payload.cap),
    });
  }
  return out;
}

/**
 * The one sentence a notification carries: how many, which files, and both ends
 * of the cut with the cap that made it.
 *
 * Null when nothing was cut — which is what keeps every existing summary
 * byte-identical to what it sent before this existed.
 */
export function truncationSentence(entries: readonly Truncation[]): string | null {
  if (entries.length === 0) return null;
  const listed = entries
    .map((entry) => `${basename(entry.path)} ${fileSize(entry.bytes)} → ${fileSize(entry.inlinedBytes)}`
      + ` (cap ${fileSize(entry.cap)})`)
    .join("; ");
  return `${plural(entries.length, "input")} truncated: ${listed}.`;
}

/** `run status --verbose`: one indented line per cut input, full path and the fix. */
export function renderTruncations(entries: readonly Truncation[]): readonly string[] {
  if (entries.length === 0) return [];
  return [
    `        ${plural(entries.length, "input")} truncated for this stage — the sub-agent read a prefix, not the file:`,
    ...entries.map((entry) =>
      `          ${entry.path}: ${fileSize(entry.bytes)} → ${fileSize(entry.inlinedBytes)}`
      + ` (inputs_max_bytes ${fileSize(entry.cap)})`),
    "          raise `inputs_max_bytes` in the stage file, or split the input (`tldrx seed triage`).",
  ];
}

/** The trailing path segment — a summary has no room for `.tldrx/memory/facts.yml`. */
function basename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? path;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
