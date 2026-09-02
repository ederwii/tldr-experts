/**
 * The incremental read of an append-only ledger (#108).
 *
 * `events.jsonl` only ever grows, and that is a property worth spending. A live
 * server that re-read every ledger on every file event would do work
 * proportional to the whole run history each time somebody saved a file; the
 * natural read is "the bytes past where I stopped", which is proportional to
 * what actually happened.
 *
 * What this is FOR is naming the change, not building the model. The model is
 * still built by `model.ts` from the files, once, and this says which runs
 * appeared, which vanished and how many events landed — so a `reload` on the
 * wire can say what moved instead of only that something did.
 *
 * Three shapes a naive offset gets wrong, each one a real file on a real disk:
 *
 *  - **A torn write.** A line half on disk is not an event. The offset advances
 *    only past the last newline in what was read, so the tail of a partial line
 *    is read again next time rather than parsed as a truncated one.
 *  - **A ledger that shrinks.** Append-only is a convention, not a guarantee: a
 *    run folder can be replaced, a file can be rewritten. A size below the
 *    offset means the file is not the one we were reading, so it is read whole.
 *  - **A run that goes away.** Its offset goes with it, or a run id reused later
 *    would start halfway through its own ledger.
 *
 * The read itself is a seam so a test can measure that the ranges asked for are
 * the appended ones — "incremental" is a claim that should be measurable.
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { EVENTS_FILE, listRuns, runDir } from "../replay/loadRun.ts";

/** The complete lines one run's ledger gained since the last poll. */
export interface LedgerAppend {
  readonly run: string;
  readonly lines: readonly string[];
}

export interface LedgerChange {
  /** Run ids seen for the first time, sorted. */
  readonly added: readonly string[];
  /** Run ids that were tracked and are no longer on disk, sorted. */
  readonly removed: readonly string[];
  readonly appended: readonly LedgerAppend[];
  /** Total complete lines across `appended` — the number a reload reports. */
  readonly lines: number;
}

/** `[from, to)` of one file, as bytes. The seam the tests measure. */
export type TailRead = (path: string, from: number, to: number) => Buffer;

export interface LedgerTail {
  /** What changed since the previous call. The first call reports everything. */
  poll(): LedgerChange;
  /** The run ids this tail is holding an offset for, sorted. */
  tracked(): readonly string[];
}

const NEWLINE = 0x0a;

export function createLedgerTail(root: string, read: TailRead = readRange): LedgerTail {
  const offsets = new Map<string, number>();

  return {
    poll(): LedgerChange {
      const present = listRuns(root);
      const here = new Set(present);
      const added: string[] = [];
      const removed: string[] = [];

      for (const id of present) {
        if (offsets.has(id)) continue;
        offsets.set(id, 0);
        added.push(id);
      }
      for (const id of [...offsets.keys()]) {
        if (here.has(id)) continue;
        offsets.delete(id);
        removed.push(id);
      }

      const appended: LedgerAppend[] = [];
      let lines = 0;
      for (const id of present) {
        const grew = readAppended(root, id, offsets, read);
        if (grew.length === 0) continue;
        appended.push({ run: id, lines: grew });
        lines += grew.length;
      }

      return { added: added.sort(), removed: removed.sort(), appended, lines };
    },

    tracked(): readonly string[] {
      return [...offsets.keys()].sort();
    },
  };
}

/** The complete lines one ledger gained, advancing its offset past them. */
function readAppended(
  root: string,
  id: string,
  offsets: Map<string, number>,
  read: TailRead,
): readonly string[] {
  const path = join(runDir(root, id), EVENTS_FILE);
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    // No ledger yet, or it has just gone. Either way the next one starts at 0.
    offsets.set(id, 0);
    return [];
  }

  const offset = offsets.get(id) ?? 0;
  // Below the offset means this is not the file we were reading — a rewrite, a
  // rotation, a replaced run folder. Start again rather than report nothing.
  const from = size < offset ? 0 : offset;
  if (size === from) return [];

  let buffer: Buffer;
  try {
    buffer = read(path, from, size);
  } catch {
    return [];
  }
  const end = buffer.lastIndexOf(NEWLINE);
  if (end === -1) {
    // Bytes arrived, but not one whole line of them. Hold the offset where it
    // was so the partial line is read again with its terminator.
    offsets.set(id, from);
    return [];
  }
  offsets.set(id, from + end + 1);
  return buffer
    .subarray(0, end + 1)
    .toString("utf8")
    .split("\n")
    .filter((line) => line.trim() !== "");
}

function readRange(path: string, from: number, to: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(Math.max(0, to - from));
    if (buffer.length === 0) return buffer;
    const got = readSync(fd, buffer, 0, buffer.length, from);
    return got === buffer.length ? buffer : buffer.subarray(0, got);
  } finally {
    closeSync(fd);
  }
}
