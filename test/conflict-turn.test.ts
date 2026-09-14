/**
 * gh #286 — the pure halves of the conflict turn: who gets one, what the ledger
 * counts, and the sentences a block names. The end-to-end halves (a real
 * executor, a real git repo, the fake `claude`) live in `story-base.test.ts`
 * Part 4, beside the #268 conflict they replace a person on.
 *
 * Nothing here spawns a process: every input is data or a file this test writes.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { leftoverMergeReason, MAX_CONFLICT_TURN_FILES } from "../src/core/build/outcome.ts";
import { readReviewLedger } from "../src/core/build/reviewLedger.ts";
import { conflictTurnRefusal } from "../src/core/build/reviewRound.ts";

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

const GRANTABLE = { conflicts: ["src/list.ts"], touches: ["src"], turnsSpent: 0, attempt: 1, attempts: 2 };

describe("conflictTurnRefusal — who gets ONE conflict turn", () => {
  test("a small conflict inside the declared touches, first time, attempts left: granted", () => {
    expect(conflictTurnRefusal(GRANTABLE)).toBeNull();
  });

  test("a directory entry covers its tree, and a sibling prefix is NOT covered", () => {
    expect(conflictTurnRefusal({ ...GRANTABLE, conflicts: ["src/a/b.ts"], touches: ["src/"] })).toBeNull();
    expect(conflictTurnRefusal({ ...GRANTABLE, conflicts: ["srcx/b.ts"], touches: ["src"] }))
      .toContain("`srcx/b.ts` is outside the story's declared `touches`");
  });

  test(`exactly ${String(MAX_CONFLICT_TURN_FILES)} files is granted; one more is refused`, () => {
    const at = Array.from({ length: MAX_CONFLICT_TURN_FILES }, (_, i) => `src/f${String(i)}.ts`);
    expect(conflictTurnRefusal({ ...GRANTABLE, conflicts: at })).toBeNull();
    expect(conflictTurnRefusal({ ...GRANTABLE, conflicts: [...at, "src/one-more.ts"] }))
      .toContain(`${String(MAX_CONFLICT_TURN_FILES + 1)} files conflict`);
  });

  test("a second turn, the last attempt, and an empty conflict list are each refused", () => {
    expect(conflictTurnRefusal({ ...GRANTABLE, turnsSpent: 1 })).toContain("already had its conflict turn");
    expect(conflictTurnRefusal({ ...GRANTABLE, attempt: 2 })).toContain("attempt 2 of 2 was the last");
    expect(conflictTurnRefusal({ ...GRANTABLE, conflicts: [] })).toContain("no conflicted file");
  });
});

describe("leftoverMergeReason — the block names what was left", () => {
  test("markers name each file; an open merge names MERGE_HEAD; both can be true", () => {
    expect(leftoverMergeReason(["a.ts", "b.ts"], false)).toContain("markers in `a.ts`, `b.ts`");
    expect(leftoverMergeReason([], true)).toContain("`MERGE_HEAD` is set");
    const both = leftoverMergeReason(["a.ts"], true);
    expect(both).toContain("`a.ts`");
    expect(both).toContain("`MERGE_HEAD`");
  });
});

/** An events.jsonl holding exactly these lines, for story S2. */
function ledgerOf(lines: readonly Record<string, unknown>[]) {
  const dir = mkdtempSync(join(tmpdir(), "tldrx-conflict-ledger-"));
  dirs.push(dir);
  writeFileSync(
    join(dir, "events.jsonl"),
    lines.map((line) => JSON.stringify({ ts: "2026-09-14T00:00:00Z", actor: "facilitator", ...line })).join("\n") + "\n",
    "utf8",
  );
  return readReviewLedger(dir, "S2");
}

const TURN = {
  type: "story.conflict_turn",
  payload: { story: "S2", attempt: 1, files: ["shared.txt"], epic_sha: "e".repeat(40), story_sha: "s".repeat(40) },
};
const STARTED = { type: "task.started", payload: { story: "S2", attempt: 2 } };
const DONE = { type: "task.done", payload: { story: "S2", status: "done", verdict: "approve", commit: "abc", attempt: 2 } };

describe("the ledger counts conflict turns from events.jsonl", () => {
  test("a log written before the event existed counts none and owes none", () => {
    const ledger = ledgerOf([STARTED, DONE]);
    expect(ledger.conflictTurns).toBe(0);
    expect(ledger.conflictTurnOwed).toBeNull();
  });

  test("a granted turn is counted and OWED, with what the event recorded", () => {
    const ledger = ledgerOf([TURN]);
    expect(ledger.conflictTurns).toBe(1);
    expect(ledger.conflictTurnOwed).toEqual({
      attempt: 1, files: ["shared.txt"], epicSha: "e".repeat(40), storySha: "s".repeat(40),
    });
  });

  test("an attempt whose developer RAN takes the turn; it stays counted", () => {
    const ledger = ledgerOf([TURN, STARTED, DONE]);
    expect(ledger.conflictTurns).toBe(1);
    expect(ledger.conflictTurnOwed).toBeNull();
  });

  test("a developer that FAILED mid-turn leaves the turn owed", () => {
    const ledger = ledgerOf([
      TURN, STARTED,
      { type: "check.failed", payload: { story: "S2", check: "developer", status: "error", detail: "Reached maximum budget" } },
      { type: "task.done", payload: { story: "S2", status: "todo", verdict: "n-a", commit: null, attempt: 2 } },
    ]);
    expect(ledger.conflictTurnOwed?.files).toEqual(["shared.txt"]);
  });

  test("a person's reopen resets both — the bound is per run of attempts", () => {
    const ledger = ledgerOf([TURN, { type: "story.reopened", payload: { story: "S2", note: "try again" } }]);
    expect(ledger.conflictTurns).toBe(0);
    expect(ledger.conflictTurnOwed).toBeNull();
  });

  test("another story's turn is not this story's", () => {
    expect(ledgerOf([{ ...TURN, payload: { ...TURN.payload, story: "S3" } }]).conflictTurns).toBe(0);
  });
});
