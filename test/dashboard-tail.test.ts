import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync, closeSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLedgerTail, type TailRead } from "../src/core/dashboard/tail.ts";
import { listRuns } from "../src/core/replay/loadRun.ts";

/**
 * The incremental ledger tail (#108).
 *
 * `events.jsonl` is append-only, which is a property worth spending: the natural
 * read is "what is past the offset I stopped at", not "the whole file again".
 * These tests hold it to that literally — the read seam records the byte ranges
 * it was asked for, so "incremental" is measured rather than asserted.
 */

const temps: string[] = [];

afterEach(() => {
  while (temps.length > 0) rmSync(temps.pop()!, { recursive: true, force: true });
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "tldrx-tail-"));
  temps.push(root);
  return root;
}

function makeRun(root: string, id: string, lines: readonly string[] = []): string {
  const dir = join(root, "tldrx-work", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "run.yml"), `id: ${id}\nstatus: open\n`, "utf8");
  if (lines.length > 0) writeFileSync(join(dir, "events.jsonl"), `${lines.join("\n")}\n`, "utf8");
  return dir;
}

function event(seq: number): string {
  return JSON.stringify({ seq, type: "stage.started", at: "2026-09-02T10:00:00Z" });
}

/** A read seam that records every range it is asked for, then does the real read. */
function recording(): { read: TailRead; ranges: { path: string; from: number; to: number }[] } {
  const ranges: { path: string; from: number; to: number }[] = [];
  const read: TailRead = (path, from, to) => {
    ranges.push({ path, from, to });
    // The real read, through the same primitive the module uses.
    const fd = openSync(path, "r");
    try {
      const buffer = Buffer.alloc(Math.max(0, to - from));
      readSync(fd, buffer, 0, buffer.length, from);
      return buffer;
    } finally {
      closeSync(fd);
    }
  };
  return { read, ranges };
}

describe("the ledger tail reads only what was appended", () => {
  test("a second poll returns the new lines only, and asks for the new bytes only", () => {
    const root = workspace();
    const dir = makeRun(root, "260901-one", [event(1), event(2)]);
    const { read, ranges } = recording();
    const tail = createLedgerTail(root, read);

    const first = tail.poll();
    expect(first.added).toEqual(["260901-one"]);
    expect(first.lines).toBe(2);
    expect(first.appended[0]!.lines).toHaveLength(2);
    const firstEnd = ranges.at(-1)!.to;
    expect(ranges.at(-1)!.from).toBe(0);

    appendFileSync(join(dir, "events.jsonl"), `${event(3)}\n`, "utf8");
    const second = tail.poll();
    expect(second.added).toEqual([]);
    expect(second.removed).toEqual([]);
    expect(second.lines).toBe(1);
    expect(second.appended).toHaveLength(1);
    expect(second.appended[0]!.run).toBe("260901-one");
    expect(JSON.parse(second.appended[0]!.lines[0]!)).toMatchObject({ seq: 3 });

    // The measurement that makes this a tail and not a re-read.
    const last = ranges.at(-1)!;
    expect(last.from, `re-read from ${String(last.from)} instead of ${String(firstEnd)}`).toBe(firstEnd);
  });

  test("a poll with nothing appended reads no bytes at all", () => {
    const root = workspace();
    makeRun(root, "260901-one", [event(1)]);
    const { read, ranges } = recording();
    const tail = createLedgerTail(root, read);
    tail.poll();
    const before = ranges.length;

    const idle = tail.poll();
    expect(idle.lines).toBe(0);
    expect(idle.appended).toEqual([]);
    expect(ranges.length, "an unchanged ledger was opened anyway").toBe(before);
  });

  test("a half-written last line is held back until its newline arrives", () => {
    const root = workspace();
    const dir = makeRun(root, "260901-one", [event(1)]);
    const tail = createLedgerTail(root);
    tail.poll();

    appendFileSync(join(dir, "events.jsonl"), '{"seq":2,"type":"stage', "utf8");
    const torn = tail.poll();
    expect(torn.lines, "a torn write was reported as an event").toBe(0);

    appendFileSync(join(dir, "events.jsonl"), '.finished","at":"2026-09-02T10:01:00Z"}\n', "utf8");
    const whole = tail.poll();
    expect(whole.lines).toBe(1);
    expect(JSON.parse(whole.appended[0]!.lines[0]!)).toMatchObject({ seq: 2, type: "stage.finished" });
  });

  test("a ledger that shrinks under it is re-read whole rather than reported as empty", () => {
    const root = workspace();
    const dir = makeRun(root, "260901-one", [event(1), event(2), event(3)]);
    const tail = createLedgerTail(root);
    expect(tail.poll().lines).toBe(3);

    // A rewrite, not an append: shorter file, different content.
    writeFileSync(join(dir, "events.jsonl"), `${event(9)}\n`, "utf8");
    const after = tail.poll();
    expect(after.lines).toBe(1);
    expect(JSON.parse(after.appended[0]!.lines[0]!)).toMatchObject({ seq: 9 });
  });
});

describe("the ledger tail survives runs coming and going", () => {
  test("a run that appears is added with its whole ledger", () => {
    const root = workspace();
    makeRun(root, "260901-one", [event(1)]);
    const tail = createLedgerTail(root);
    tail.poll();

    makeRun(root, "260902-two", [event(1), event(2)]);
    const change = tail.poll();
    expect(change.added).toEqual(["260902-two"]);
    expect(change.removed).toEqual([]);
    expect(change.lines).toBe(2);
  });

  test("a run that vanishes is reported removed once, then forgotten", () => {
    const root = workspace();
    makeRun(root, "260901-one", [event(1)]);
    makeRun(root, "260902-two", [event(1)]);
    const tail = createLedgerTail(root);
    expect(tail.poll().added).toEqual(["260901-one", "260902-two"]);

    rmSync(join(root, "tldrx-work", "260902-two"), { recursive: true, force: true });
    const gone = tail.poll();
    expect(gone.removed).toEqual(["260902-two"]);
    expect(tail.tracked()).toEqual(["260901-one"]);

    // Forgotten: it is not removed a second time, and the offset is not leaked.
    expect(tail.poll().removed).toEqual([]);
  });

  test("a run with no events.jsonl is carried without one being invented", () => {
    const root = workspace();
    const dir = makeRun(root, "260901-one");
    const tail = createLedgerTail(root);
    const first = tail.poll();
    expect(first.added).toEqual(["260901-one"]);
    expect(first.lines).toBe(0);
    expect(first.appended).toEqual([]);

    writeFileSync(join(dir, "events.jsonl"), `${event(1)}\n`, "utf8");
    expect(tail.poll().lines).toBe(1);
  });

  test("the whole work dir disappearing is every run removed, not a throw", () => {
    const root = workspace();
    makeRun(root, "260901-one", [event(1)]);
    const tail = createLedgerTail(root);
    tail.poll();

    rmSync(join(root, "tldrx-work"), { recursive: true, force: true });
    const gone = tail.poll();
    expect(gone.removed).toEqual(["260901-one"]);
    expect(tail.tracked()).toEqual([]);
  });
});

/**
 * `listRuns` is what both the model and the tail ask "which runs are there", and
 * a live server asks it while the disk is being written to. Two shapes made it
 * throw straight through `buildModel` and take the server with it (#108).
 */
describe("listing runs survives a work dir being written under it", () => {
  test("an entry that dangles is not a run, and does not take the listing down", () => {
    const root = workspace();
    makeRun(root, "260901-one", [event(1)]);
    // Exactly what a run folder removed between readdir and stat looks like.
    symlinkSync(join(root, "tldrx-work", "never-existed"), join(root, "tldrx-work", "260902-gone"));
    expect(listRuns(root)).toEqual(["260901-one"]);
  });

  test("a work dir that is not a directory is no runs, not a crash", () => {
    const root = workspace();
    mkdirSync(join(root, ".tldrx"), { recursive: true });
    writeFileSync(join(root, "tldrx-work"), "somebody put a file here\n", "utf8");
    expect(listRuns(root)).toEqual([]);
  });
});
