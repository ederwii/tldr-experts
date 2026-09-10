/**
 * What a red DoD command actually SAID — kept, not summarised away (#211).
 *
 * Measured on a real workspace (tldrx 0.14.2): a story's `scripts/gate/test.sh`
 * exited 1 and the only sentence any record kept was
 *
 *   sys:1: DeprecationWarning: builtin type swigvarlink has no __module__ attribute
 *
 * — a Python warning that had nothing to do with the failure. `lastMeaningfulLine`
 * takes the LAST non-empty line of `stdout + "\n" + stderr`, and because stderr is
 * appended last, a single trailing warning on stderr displaces the entire failure
 * report on stdout. The worktree is deleted when the story settles, so which test
 * failed was not re-derivable from anything.
 *
 * Two derivations live here and nowhere else:
 *
 * - `outputTail` — the LAST `DOD_OUTPUT_MAX_LINES` lines, bounded by
 *   `DOD_OUTPUT_MAX_BYTES`, written to a per-check file beside the story log. The
 *   tail, not the head: a test runner puts its summary at the end.
 * - `failureExcerpt` — the few lines that LOOK like the failure (`FAIL`, `Error`,
 *   `assert`, `Traceback`, `not ok`, …), falling back to the last few lines when
 *   nothing matches. This is what reaches `check.failed`'s `detail`, the story
 *   log, and the blocked-story reason the handoff quotes. It is never "the first
 *   stderr line" and never "the last line of the combined streams" — those two
 *   readings are exactly what this issue is about.
 *
 * The excerpt is bounded at `DOD_DETAIL_MAX_BYTES`, well under the §2.9
 * 4096-byte payload cap, DELIBERATELY: `capPayload` drops an oversized `detail`
 * and replaces it with `detail_omitted` (#160), and a detail that could be
 * dropped for size would put us back where we started — a red check whose reason
 * is not in the record.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUILD_PHASE, LOG_DIR } from "./plan.ts";

/** Lines of a red command's combined output kept on disk. */
export const DOD_OUTPUT_MAX_LINES = 200;
/** …and the byte ceiling that wins when 200 lines are longer than this. */
export const DOD_OUTPUT_MAX_BYTES = 16 * 1024;
/** Lines of the kept output quoted inline (the event, the log, the reason). */
export const DOD_EXCERPT_MAX_LINES = 5;
/**
 * The inline excerpt's byte ceiling. A quarter of `MAX_PAYLOAD_BYTES`, so
 * `check.failed` — whose other keys are a phase id, a story id and a command —
 * cannot reach the cap and lose its `detail` to `capPayload`.
 */
export const DOD_DETAIL_MAX_BYTES = 1024;

/** `…` is three UTF-8 bytes, and it is the RESULT that both bounds are about. */
const ELLIPSIS_BYTES = 3;

/** `04-build/log/dod-output/` — a sibling of the story logs, tracked like them. */
export const DOD_OUTPUT_DIR = "dod-output";

/**
 * Lines that look like a failure rather than like noise.
 *
 * Deliberately broad and deliberately not anchored: test runners disagree about
 * everything except that they say one of these words when something breaks. A
 * false positive costs a slightly worse excerpt; a false negative costs the whole
 * point of this file.
 */
const FAILURE_RE = /FAIL|Failed|failed|Error|error:|assert|✗|✖|not ok|Exception|Traceback|exit code/;

/** `04-build/log/dod-output/<story>-<n>.txt`, relative to the run dir. ONE derivation. */
export function dodOutputRel(storyId: string, index: number): string {
  return `${BUILD_PHASE}/${LOG_DIR}/${DOD_OUTPUT_DIR}/${storyId}-${String(index + 1)}.txt`;
}

/** Non-empty lines, right-trimmed — the shape both derivations below work on. */
function meaningfulLines(output: string): readonly string[] {
  return output.split("\n").map((line) => line.trimEnd()).filter((line) => line.trim() !== "");
}

/** Cut `text` to at most `maxBytes` UTF-8 bytes, saying so when it cuts. */
function boundBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  // Byte-safe: slice on the buffer, then drop a trailing partial code point. The
  // ellipsis is itself 3 UTF-8 bytes, and the RESULT is what the bound is about.
  const cut = Buffer.from(text, "utf8").subarray(0, maxBytes - ELLIPSIS_BYTES).toString("utf8")
    .replace(/�$/, "");
  return `${cut}…`;
}

/**
 * The tail of a red command's combined output — the last `DOD_OUTPUT_MAX_LINES`
 * lines, or `DOD_OUTPUT_MAX_BYTES`, whichever is SMALLER.
 *
 * Bounded from the end on both axes, so a runner that prints one enormous line
 * last still leaves that line's beginning in the file.
 */
export function outputTail(output: string): string {
  const lines = meaningfulLines(output);
  const kept = lines.slice(Math.max(0, lines.length - DOD_OUTPUT_MAX_LINES));
  const text = kept.join("\n");
  if (Buffer.byteLength(text, "utf8") <= DOD_OUTPUT_MAX_BYTES) return text;
  const buffer = Buffer.from(text, "utf8");
  const cut = buffer.subarray(buffer.length - (DOD_OUTPUT_MAX_BYTES - ELLIPSIS_BYTES)).toString("utf8")
    .replace(/^�/, "");
  return `…${cut}`;
}

/**
 * The lines a human would point at when asked "what failed?" — at most
 * `DOD_EXCERPT_MAX_LINES` of them, bounded by `DOD_DETAIL_MAX_BYTES`.
 *
 * Failure-looking lines first, in the order they were printed, so a test runner's
 * `FAIL test_x — AssertionError: …` survives a trailing deprecation warning. When
 * nothing matches, the LAST few lines — a summary lives at the end, and the first
 * line of stderr is the one reading this issue proved is worthless.
 */
export function failureExcerpt(output: string): string {
  const lines = meaningfulLines(output);
  const matched = lines.filter((line) => FAILURE_RE.test(line));
  const chosen = matched.length > 0
    ? matched.slice(0, DOD_EXCERPT_MAX_LINES)
    : lines.slice(Math.max(0, lines.length - DOD_EXCERPT_MAX_LINES));
  return boundBytes(chosen.join("\n"), DOD_DETAIL_MAX_BYTES);
}

/**
 * The excerpt's first line, for the one-line surfaces — the blocked-story reason,
 * the handoff bullet, the executor's stdout. Derived from `failureExcerpt`, never
 * chosen a second way.
 */
export function failureSummaryLine(output: string, max = 200): string {
  const first = failureExcerpt(output).split("\n")[0] ?? "";
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}

/** Where a red check's kept output went, and how much of it there is. */
export interface DodOutputFile {
  readonly rel: string;
  readonly bytes: number;
}

/**
 * Write one red check's tail beside the story log.
 *
 * Best-effort by design: a tail that cannot be written is a worse record, never a
 * reason to fail a build that has already run its gate. `null` means "not
 * written", and every reader treats that as no evidence rather than an empty file.
 */
export function writeDodOutput(
  runDir: string, storyId: string, index: number, output: string,
): DodOutputFile | null {
  const text = outputTail(output);
  if (text === "") return null;
  const rel = dodOutputRel(storyId, index);
  try {
    const path = join(runDir, rel);
    mkdirSync(join(runDir, BUILD_PHASE, LOG_DIR, DOD_OUTPUT_DIR), { recursive: true });
    const body = `${text}\n`;
    writeFileSync(path, body, "utf8");
    return { rel, bytes: Buffer.byteLength(body, "utf8") };
  } catch {
    return null;
  }
}
