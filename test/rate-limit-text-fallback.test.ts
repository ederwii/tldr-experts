/**
 * gh #341 (part of) — the frame-attested capture of a turn that DIED against
 * the provider's rate limit still does not exist in this repo (see #341's own
 * "what is still unmeasured" section: `classifyRateLimit`'s detection reads
 * the last `rate_limit_event` frame, and nobody holds one from a turn that
 * actually hit the wall). This is a narrower, text-matched fallback for the
 * one case `describeFailure` would otherwise drop into `"unclassified"`:
 * REPORTED (not measured — second-hand from a consumer session, 2026-09-17,
 * never captured in this repo), an API error text of the shape "… API error:
 * You've hit your session limit · resets …" (error type rate_limit, HTTP
 * 429)".
 *
 * `RATE_LIMIT_STDERR` below is a SYNTHETIC fixture line built from that
 * reported shape — never real workspace data (AGENTS.md §8).
 *
 * Unit-level on `interpret()`, per the brief: no process is spawned. This
 * exercises `describeFailure`'s new fallback directly; `classifyRateLimit`
 * (the frame-based detector, unaffected by this change) is a separate seam
 * covered by `test/agent-stream.test.ts`.
 */
import { expect, test } from "bun:test";
import { interpret } from "../src/core/facilitator/spawnAgent.ts";
import { claudeOutput } from "../src/core/facilitator/fakeTranscript.ts";

/** SYNTHETIC — built from #341's reported (not measured) shape. */
const RATE_LIMIT_STDERR =
  "Claude AI usage limit reached — API error: You've hit your session limit · "
  + "resets 2026-09-17T18:00:00Z (error type rate_limit, HTTP 429)\n";

function successStdout(): string {
  return claudeOutput([], {
    isError: false,
    result: "done",
    sessionId: "sess-341",
    costUsd: 0,
    usage: { input_tokens: 10, output_tokens: 1 },
    structured: { outputs: [], questions_asked: [], notes: "" },
    errors: [],
  });
}

test("a text-matched rate-limit death is classified rate_limit, not unclassified", () => {
  // Exit code disagrees with the (unrelated) subtype-success document — the
  // same "nothing here can name WHY" shape #375 also lands in — but THIS
  // turn's stderr carries the reported session-limit text.
  const outcome = interpret(1, successStdout(), RATE_LIMIT_STDERR, false);
  expect(outcome.ok).toBe(false);
  expect(outcome.failureKind).toBe("rate_limit");
  // The `.error` TEXT is unchanged by the fallback — only the KIND it earns
  // does (one derivation, AGENTS.md §7): it still reads as the same
  // "no reason named" verdict this file always produced for this shape.
  expect(outcome.error).toContain("no reason named");
});

test("without the matching text, the same shape stays unclassified", () => {
  const outcome = interpret(1, successStdout(), "some unrelated stderr noise\n", false);
  expect(outcome.failureKind).toBe("unclassified");
});

test("a MALFORMED envelope is never relabeled rate_limit even if its text matches", () => {
  // `doc.type !== "result"` (Claude's whole-buffer fallback path) — malformed
  // takes priority over every other classification, text-matched or not.
  const malformed = `${JSON.stringify({ type: "not-a-result", subtype: "success", errors: [] })}\n`;
  const outcome = interpret(1, malformed, RATE_LIMIT_STDERR, false);
  expect(outcome.failureKind).toBe("malformed_result");
});

test("a genuine TIMEOUT is never relabeled rate_limit even if the text is present", () => {
  const outcome = interpret(1, "", RATE_LIMIT_STDERR, true);
  expect(outcome.failureKind).toBe("timeout");
});
