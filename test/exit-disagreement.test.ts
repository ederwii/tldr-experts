/**
 * gh #375 — a spawned turn whose process exit code disagrees with what the
 * provider's own result document said (`subtype: "success"`) settles as DONE
 * when every declared output is on disk and non-empty, carrying an additive
 * `exit_disagreement` note — rather than the stage failure `run auto` paid a
 * full relaunch for on a live run (see the module doc on
 * `src/core/facilitator/exitDisagreement.ts` for the measured incident).
 *
 * Unit-level on the helper (`settleExitDisagreement`) and on `interpret()`,
 * per the brief: no process is spawned, so this is hermetic without a fake
 * `claude` on PATH. `claudeOutput` (the ONE shared fake-transcript emitter,
 * AGENTS.md §8) builds the result document; only the exit code passed to
 * `interpret()` is varied independently of it, which is exactly the shape of
 * the real disagreement — the provider's stdout and the process's own exit
 * code are two different signals that can disagree with each other.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { interpret } from "../src/core/facilitator/spawnAgent.ts";
import { claudeOutput } from "../src/core/facilitator/fakeTranscript.ts";
import { settleExitDisagreement } from "../src/core/facilitator/exitDisagreement.ts";
import type { PathContext } from "../src/core/facilitator/paths.ts";

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function ctxWith(files: Record<string, string>): PathContext {
  const dir = mkdtempSync(join(tmpdir(), "exit-disagreement-"));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body, "utf8");
  return { root: dir, runDir: dir };
}

const BASE = {
  sessionId: "sess-375",
  costUsd: 0.16,
  usage: { input_tokens: 100, output_tokens: 50 },
  errors: [],
};

test("(1) exit 1 + subtype success + every declared output present and non-empty settles as done", () => {
  // `claudeOutput`'s `isError` sets the document's `subtype` too (it is the ONE
  // shared fake, and a real `claude` ties them together on the happy path) — so
  // the disagreement here is carried entirely by the PROCESS exit code passed to
  // `interpret()` below, exactly as gh #375's own rule is worded ("exit code ≠
  // 0", not "is_error"). `isError: false` is what a subtype of `"success"` needs.
  const stdout = claudeOutput([], {
    ...BASE, isError: false, result: "done", structured: { outputs: ["watcher.md"], questions_asked: [], notes: "" },
  });
  const outcome = interpret(1, stdout, "", false);
  expect(outcome.ok).toBe(false);
  expect(outcome.resultSubtype).toBe("success");

  const ctx = ctxWith({ "watcher.md": "the watcher's output, non-empty" });
  const settled = settleExitDisagreement(outcome, ["watcher.md"], ctx);
  expect(settled).toBe("exit 1, subtype success");
});

test("(2) exit 1 + subtype success + one declared output missing stays failed, no exit_disagreement", () => {
  const stdout = claudeOutput([], {
    ...BASE, isError: false, result: "done", structured: { outputs: [], questions_asked: [], notes: "" },
  });
  const outcome = interpret(1, stdout, "", false);
  expect(outcome.resultSubtype).toBe("success");

  const ctx = ctxWith({ "watcher.md": "present" });
  // "other.md" was declared but never written.
  const settled = settleExitDisagreement(outcome, ["watcher.md", "other.md"], ctx);
  expect(settled).toBeNull();
});

test("(2b) a declared output that exists but is EMPTY also stays failed", () => {
  const stdout = claudeOutput([], {
    ...BASE, isError: false, result: "done", structured: { outputs: [], questions_asked: [], notes: "" },
  });
  const outcome = interpret(1, stdout, "", false);
  const ctx = ctxWith({ "watcher.md": "" });
  expect(settleExitDisagreement(outcome, ["watcher.md"], ctx)).toBeNull();
});

test("(3) exit 0 + subtype success is already ok — no disagreement, byte-identical to today", () => {
  const stdout = claudeOutput([], {
    ...BASE, isError: false, result: "done", structured: { outputs: ["watcher.md"], questions_asked: [], notes: "" },
  });
  const outcome = interpret(0, stdout, "", false);
  expect(outcome.ok).toBe(true);
  expect(outcome.resultSubtype).toBe("success");

  const ctx = ctxWith({ "watcher.md": "present" });
  // The helper is never consulted by a caller once `agent.ok` is already true
  // (see runNext.ts's three spawn sites), and it is inert here too: an already-ok
  // outcome has nothing to settle.
  expect(settleExitDisagreement(outcome, ["watcher.md"], ctx)).toBeNull();
});

test("(4) exit 1 + subtype error_during_execution fails as today — not a subtype disagreement", () => {
  const stdout = claudeOutput([], {
    ...BASE, isError: true, result: "", structured: { outputs: [], questions_asked: [], notes: "" },
  });
  const outcome = interpret(1, stdout, "", false);
  expect(outcome.resultSubtype).toBe("error_during_execution");

  const ctx = ctxWith({ "watcher.md": "present" });
  expect(settleExitDisagreement(outcome, ["watcher.md"], ctx)).toBeNull();
});

test("a turn that timed out is untouched even with a success-shaped document", () => {
  const stdout = claudeOutput([], {
    ...BASE, isError: false, result: "done", structured: { outputs: ["watcher.md"], questions_asked: [], notes: "" },
  });
  const interpreted = interpret(1, stdout, "", false);
  const outcome = { ...interpreted, timedOut: true, ok: false };
  const ctx = ctxWith({ "watcher.md": "present" });
  expect(settleExitDisagreement(outcome, ["watcher.md"], ctx)).toBeNull();
});
