/**
 * #211 — a red DoD command's records name the FAILURE, not the last warning.
 *
 * Measured on a real workspace (tldrx 0.14.2): a story's `scripts/gate/test.sh`
 * exited 1 and the only sentence any record kept — `check.failed`'s `detail`, the
 * story log under `## Definition of done` and under `## Why it is not done`, and
 * the handoff Finding — was
 *
 *   sys:1: DeprecationWarning: builtin type swigvarlink has no __module__ attribute
 *
 * The suite genuinely failed and WHICH TEST failed was nowhere in the run, and the
 * worktree is deleted when the story settles, so it was not re-derivable. The
 * mechanism: `lastMeaningfulLine` takes the last non-empty line of
 * `stdout + "\n" + stderr`, and stderr is concatenated last.
 *
 * Every test below runs the real `runStoryDod` against a real script, or renders
 * the real documents. `RED_SCRIPT` is that shape exactly: the warning goes to
 * stderr LAST, the failure to stdout FIRST.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStoryDod } from "../src/core/build/dodRunner.ts";
import {
  DOD_DETAIL_MAX_BYTES, DOD_EXCERPT_MAX_LINES, DOD_OUTPUT_MAX_BYTES, DOD_OUTPUT_MAX_LINES,
  dodOutputRel, failureExcerpt, failureSummaryLine, outputTail,
} from "../src/core/build/dodOutput.ts";
import { dodFailureReason, type DodResult, type StoryOutcome } from "../src/core/build/outcome.ts";
import { buildDeveloperPrompt } from "../src/core/build/prompts.ts";
import { renderReviewLog } from "../src/core/build/review.ts";
import { capPayload, MAX_PAYLOAD_BYTES, serializeEvent } from "../src/core/events/Event.ts";
import { readReviewLedger } from "../src/core/facilitator/executors/build.ts";
import { runNext } from "../src/core/facilitator/runNext.ts";
import { reject } from "../src/core/run/gates.ts";
import { reopenStory } from "../src/core/run/reopenStory.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { makeBuildWorkspace } from "./fixtures/build/workspace.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

setDefaultTimeout(spawnTestTimeout());

/** The Python warning that displaced a whole failure report on a real workspace. */
const WARNING = "sys:1: DeprecationWarning: builtin type swigvarlink has no __module__ attribute";

/** Runs an ordinary suite, fails one test, and warns on stderr LAST. */
const RED_SCRIPT = `#!/bin/sh
echo "collected 42 items"
echo "test_a PASSED"
echo "FAIL test_x — AssertionError: expected 3, got 4"
echo "1 failed, 41 passed in 2.10s"
echo "${WARNING}" >&2
exit 1
`;

const GREEN_SCRIPT = `#!/bin/sh
echo "42 passed in 2.10s"
echo "${WARNING}" >&2
exit 0
`;

interface Ran {
  readonly dir: string;
  readonly results: readonly DodResult[];
  readonly events: readonly { type: string; payload: Record<string, unknown> }[];
}

/** Run one real script through the real `runStoryDod`, in a private dir. */
async function runScript(body: string, name = "gate.sh"): Promise<Ran> {
  const dir = mkdtempSync(join(tmpdir(), "tldrx-dod-detail-"));
  const script = join(dir, name);
  writeFileSync(script, body, "utf8");
  chmodSync(script, 0o755);
  const command = `./${name}`;
  const events: { type: string; payload: Record<string, unknown> }[] = [];
  const results = await runStoryDod({
    storyId: "S1",
    repo: "app",
    worktree: dir,
    commands: [command],
    workspaceCommands: new Set([command]),
    timeoutMs: 30_000,
    phaseId: "04-build",
    runDir: dir,
    emit: (type, payload) => { events.push({ type, payload }); },
    baseResult: async () => null,
  });
  return { dir, results, events };
}

function outcomeWith(dod: readonly DodResult[]): StoryOutcome {
  return {
    id: "S1", title: "First story", repo: "app", wave: 1, epic: "E1",
    branch: "story/r/S1", epicBranch: "epic/e1", status: "blocked", verdict: "n-a",
    reviewSummary: "", reviewFindings: [], attempts: 1, dod, commit: null, merged: false,
    carried: 0, conflicts: [], reason: dodFailureReason(dod[0] as DodResult, "app"),
    developerError: null, rescued: null, reviewRel: "04-build/log/S1.md", reviewer: null,
  } as unknown as StoryOutcome;
}

// ---------------------------------------------------------------------------

describe("#211 · a red dod command's detail names the failure", () => {
  test("(a) check.failed.detail carries the FAIL line and NOT the trailing warning", async () => {
    const ran = await runScript(RED_SCRIPT);

    const failed = ran.events.find((e) => e.type === "check.failed");
    expect(failed).toBeDefined();
    const detail = String(failed?.payload.detail ?? "");
    expect(detail).toContain("FAIL test_x — AssertionError: expected 3, got 4");
    // The bug, in one assertion: the warning is what the record used to keep.
    expect(detail).not.toContain("DeprecationWarning");
    expect(detail).not.toContain("swigvarlink");
  });

  test("(a) the kept output is on disk at the path the event names, and holds the tail", async () => {
    const ran = await runScript(RED_SCRIPT);

    const failed = ran.events.find((e) => e.type === "check.failed");
    const rel = String(failed?.payload.output_path ?? "");
    expect(rel).toBe(dodOutputRel("S1", 0));
    const path = join(ran.dir, rel);
    expect(existsSync(path)).toBe(true);
    const kept = readFileSync(path, "utf8");
    // The WHOLE tail — including the lines the excerpt did not choose, and the
    // warning, which is evidence too once it is not the only evidence.
    expect(kept).toContain("collected 42 items");
    expect(kept).toContain("FAIL test_x — AssertionError: expected 3, got 4");
    expect(kept).toContain(WARNING);
    expect(failed?.payload.output_bytes).toBe(Buffer.byteLength(kept, "utf8"));
    // And the result row carries the same two facts the event does.
    expect(ran.results[0]?.outputPath).toBe(rel);
    expect(ran.results[0]?.tail).toContain("FAIL test_x");
  });

  test("(b) a 16 KB tail still fits the 4096-byte payload cap — the event is never dropped", async () => {
    // 400 lines of ~1500 bytes — 600 KB, far past both `DOD_OUTPUT_MAX_LINES`
    // and `DOD_OUTPUT_MAX_BYTES` — and EVERY line matches the failure heuristic,
    // so the excerpt's own byte bound is the only thing between this and a
    // payload the cap would strip. That is the worst case, deliberately.
    const noisy = `#!/bin/sh
pad=$(printf 'x%.0s' $(seq 1 1500))
i=0
while [ $i -lt 400 ]; do echo "FAIL test_$i — AssertionError: $pad"; i=$((i+1)); done
echo "${WARNING}" >&2
exit 1
`;
    const ran = await runScript(noisy, "noisy.sh");

    const failed = ran.events.find((e) => e.type === "check.failed");
    const payload = failed?.payload ?? {};
    const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
    expect(bytes).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    expect(Buffer.byteLength(String(payload.detail ?? ""), "utf8"))
      .toBeLessThanOrEqual(DOD_DETAIL_MAX_BYTES);
    // `capPayload` returns the SAME object when nothing had to be dropped — the
    // identity contract in `Event.ts`. So the detail survives, and no
    // `detail_omitted` sentence takes its place (#160).
    expect(capPayload(payload)).toBe(payload);
    expect(payload.detail_omitted).toBeUndefined();
    // The whole serialised line, envelope included, stays inside `MAX_LINE_BYTES`.
    const line = serializeEvent({
      ts: "2026-09-09T09:00:00Z", run: "260909-x", stage: "04-build",
      type: "check.failed", actor: "tldrx", cost_usd: 0, payload,
    });
    expect(Buffer.byteLength(line, "utf8")).toBeLessThan(8 * 1024);
    // …while the FILE keeps the real thing, bounded at 16 KB.
    const kept = readFileSync(join(ran.dir, String(payload.output_path)), "utf8");
    expect(Buffer.byteLength(kept, "utf8")).toBeLessThanOrEqual(DOD_OUTPUT_MAX_BYTES + 1);
    expect(kept.split("\n").filter((l) => l !== "").length).toBeLessThanOrEqual(DOD_OUTPUT_MAX_LINES);
  });

  test("(c) the story log quotes the failure and cites the kept output by path", async () => {
    const ran = await runScript(RED_SCRIPT);

    const log = renderReviewLog(outcomeWith(ran.results));
    expect(log).toContain("FAIL test_x — AssertionError: expected 3, got 4");
    expect(log).toContain(dodOutputRel("S1", 0));
    const at = String(ran.results[0]?.outputLine ?? 0);
    expect(log).toContain(`[src: ${dodOutputRel("S1", 0)}:${at}]`);
    // The blocked-story reason — the handoff Finding's own sentence — cites it too.
    const reason = dodFailureReason(ran.results[0] as DodResult, "app");
    expect(reason).toContain("FAIL test_x");
    expect(reason).toContain(`[src: ${dodOutputRel("S1", 0)}:${at}]`);
    expect(reason).not.toContain("swigvarlink");
  });

  test("(d) a PASSING dod writes no output file and carries no output keys", async () => {
    const ran = await runScript(GREEN_SCRIPT, "green.sh");

    expect(ran.results[0]?.exitCode).toBe(0);
    expect(ran.results[0]?.outputPath).toBeUndefined();
    expect(existsSync(join(ran.dir, dodOutputRel("S1", 0)))).toBe(false);
    const passed = ran.events.find((e) => e.type === "check.passed");
    expect(passed?.payload.output_path).toBeUndefined();
    // Byte-identical to what a green check has always emitted: `detail: ""`, and
    // the same key set. `test/build-golden.test.ts` is the other half of this.
    expect(passed?.payload.detail).toBe("");
    expect(Object.keys(passed?.payload ?? {}))
      .toEqual(["phase", "check", "story", "command", "exit_code", "detail"]);
  });
});

describe("#211 · failureExcerpt picks failure-looking lines, never the first stderr line", () => {
  test("a warning last on stderr does not displace the failure", () => {
    const text = `collected 42 items\nFAIL test_x — AssertionError: nope\n1 failed\n\n${WARNING}\n`;
    expect(failureExcerpt(text)).toContain("FAIL test_x");
    expect(failureExcerpt(text)).not.toContain("swigvarlink");
    expect(failureSummaryLine(text)).toBe("FAIL test_x — AssertionError: nope");
  });

  test("with nothing failure-looking, the LAST lines — never the first", () => {
    const text = "one\ntwo\nthree\nfour\nfive\nsix\nseven\n";
    const excerpt = failureExcerpt(text);
    expect(excerpt.split("\n").length).toBe(DOD_EXCERPT_MAX_LINES);
    expect(excerpt).toBe("three\nfour\nfive\nsix\nseven");
    expect(excerpt).not.toContain("one");
  });

  test("the excerpt is bounded even when every line matches", () => {
    const text = Array.from({ length: 5 }, () => `Error: ${"x".repeat(4000)}`).join("\n");
    expect(Buffer.byteLength(failureExcerpt(text), "utf8")).toBeLessThanOrEqual(DOD_DETAIL_MAX_BYTES);
  });

  test("outputTail keeps the END of a long output, bounded on both axes", () => {
    const many = Array.from({ length: 500 }, (_, i) => `line ${String(i)}`).join("\n");
    const tail = outputTail(many);
    expect(tail.split("\n").length).toBe(DOD_OUTPUT_MAX_LINES);
    expect(tail).toContain("line 499");
    expect(tail).not.toContain("line 299\n");

    const huge = Array.from({ length: 200 }, () => "y".repeat(500)).join("\n");
    expect(Buffer.byteLength(outputTail(huge), "utf8")).toBeLessThanOrEqual(DOD_OUTPUT_MAX_BYTES);
  });
});

// ---------------------------------------------------------------------------

/**
 * (e) The next developer must be handed the real failure, not asked to
 * rediscover it — the worktree it happened in is deleted when the story settles.
 *
 * End to end through the real pipeline: a story whose gate is GREEN on the base
 * tree and RED once the developer has written its file, blocked, reopened by a
 * person, then dispatched again with the prompt captured.
 */
describe("#211 · the retry prompt names the kept output", () => {
  test("a reopened story's second developer prompt cites the blocked attempt's output file", async () => {
    const gate = `node -e "var fs=require('fs');`
      + `if(!fs.readdirSync('.').some(function(f){return f.endsWith('.txt')}))process.exit(0);`
      + `console.log('collected 42 items');`
      + `console.log('FAIL test_x — AssertionError: expected 3, got 4');`
      + `console.error('${WARNING}');process.exit(1)"`;
    const ws = makeBuildWorkspace({
      stories: [{ id: "S1", epic: "E1", title: "First story" }],
      epics: [{ id: "E1", stories: ["S1"], branch: "epic/e1" }],
      waves: [["S1"]],
      testScript: gate,
      // Two dispatches of one story, and the brake prices both: the default $8
      // refuses the second before it starts.
      budgetUsd: 8,
    });
    const promptDir = join(ws.root, "prompts");
    const priorPath = process.env.PATH ?? "";
    process.env.PATH = ws.binDir;
    process.env.FAKE_BUILD_STATE = ws.statePath;
    process.env.FAKE_BUILD_PROMPT_DIR = promptDir;
    // The stage's brake prices the REMAINING work, and a second dispatch of the
    // same story is priced twice over. A free fake agent keeps this test about
    // the prompt rather than about the budget.
    process.env.FAKE_BUILD_COST = "0";
    try {
      const first = await runNext({
        root: ws.root, dryRun: false, mode: "headless", yolo: false,
        actor: "alan", at: "2026-09-09T09:00:00Z",
      });
      expect(first.code).not.toBe(126);
      const blocked = readFileSync(join(ws.planDir, "stories", "S1.md"), "utf8");
      expect(blocked).toContain("status: blocked");

      // The kept output is on disk, and the story log cites it.
      const rel = dodOutputRel("S1", 0);
      expect(existsSync(join(ws.runDir, rel))).toBe(true);
      const log = readFileSync(join(ws.runDir, "04-build/log/S1.md"), "utf8");
      expect(log).toContain("FAIL test_x — AssertionError: expected 3, got 4");
      expect(log).toContain(rel);

      // A person reopens it. The counters reset; the EVIDENCE does not.
      const reopened = reopenStory({
        root: ws.root, storyId: "S1", note: "have another go", actor: "alan",
        at: "2026-09-09T10:00:00Z",
      });
      expect(reopened.code).toBe(0);
      expect(readReviewLedger(ws.runDir, "S1").lastDodOutputPath).toBe(rel);
      // The stage is sitting at its gate; a reject sends it back to `ready`, which
      // is exactly what `story reopen` tells the operator to do next.
      reject(RunStore.open(ws.runDir), {
        root: ws.root, actor: "alan", at: "2026-09-09T10:00:30Z", note: "try again",
      });

      await runNext({
        root: ws.root, dryRun: false, mode: "headless", yolo: false,
        actor: "alan", at: "2026-09-09T10:01:00Z",
      });
      // The fake counts the spawns it sees, so this is the SECOND developer
      // prompt for S1 — the one a person reopening the story asked for.
      const second = readFileSync(join(promptDir, "developer-S1-2.md"), "utf8");
      const firstPrompt = readFileSync(join(promptDir, "developer-S1-1.md"), "utf8");
      // The instrument can tell the two apart: the first attempt had nothing to
      // carry forward, so a green assertion below is about THIS prompt.
      expect(firstPrompt).not.toContain("## Previous attempt");
      expect(second).toContain("## Previous attempt");
      // The header names the ACTUAL source: this story never reached a reviewer.
      expect(second).toContain("Your last attempt blocked on its Definition of Done");
      expect(second).not.toContain("A reviewer read your last attempt");
      expect(second).toContain(rel);
      expect(second).toContain("FAIL test_x — AssertionError: expected 3, got 4");
    } finally {
      process.env.PATH = priorPath;
      delete process.env.FAKE_BUILD_STATE;
      delete process.env.FAKE_BUILD_PROMPT_DIR;
      delete process.env.FAKE_BUILD_COST;
      ws.dispose();
    }
  }, 120_000);

  test("`story.reopened` clears the counters but keeps the kept-output pointer", () => {
    const dir = mkdtempSync(join(tmpdir(), "tldrx-dod-ledger-"));
    const rel = dodOutputRel("S1", 0);
    const lines = [
      { type: "task.started", payload: { story: "S1", attempt: 1 } },
      {
        type: "check.failed",
        payload: {
          check: "dod", story: "S1", command: "npm run test", exit_code: 1,
          detail: "FAIL test_x — AssertionError: expected 3, got 4",
          output_path: rel, output_bytes: 128,
        },
      },
      { type: "story.reopened", payload: { story: "S1", note: "again" } },
    ].map((e) => JSON.stringify(e)).join("\n");
    writeFileSync(join(dir, "events.jsonl"), `${lines}\n`, "utf8");

    const ledger = readReviewLedger(dir, "S1");
    expect(ledger.verdicts).toBe(0);
    expect(ledger.dod).toEqual([]);
    // The one field a reopen does not erase — see its docstring.
    expect(ledger.lastDodOutputPath).toBe(rel);
  });

  test("a pre-#211 single-line detail round-trips through the ledger unchanged", () => {
    const dir = mkdtempSync(join(tmpdir(), "tldrx-dod-legacy-"));
    const line = JSON.stringify({
      type: "check.failed",
      payload: { check: "dod", story: "S1", command: "npm run test", exit_code: 1, detail: WARNING },
    });
    writeFileSync(join(dir, "events.jsonl"), `${line}\n`, "utf8");

    const ledger = readReviewLedger(dir, "S1");
    expect(ledger.dod[0]?.tail).toBe(WARNING);
    expect(ledger.dod[0]?.excerpt).toBeUndefined();
    expect(ledger.lastDodOutputPath).toBeNull();
  });
});

// ---------------------------------------------------------------------------

/**
 * Review round 1, item 1: the `## Previous attempt` header used to be
 * unconditional — "A reviewer read your last attempt at this story and asked for
 * changes" — and #211 made a DoD-only block carry its log forward, so that
 * sentence would have sat above a log reading `Verdict: n-a · Reviewer: not
 * recorded`. The prompt would have asserted a review that never happened.
 */
describe("#211 · the previous-attempt header says which kind of attempt it was", () => {
  const REVIEW_LINE = "A reviewer read your last attempt";
  const DOD_LINE = "Your last attempt blocked on its Definition of Done";

  function devPrompt(previousAttemptKind?: "review" | "dod"): string {
    return buildDeveloperPrompt({
      runId: "260909-detail",
      story: {
        story: {
          version: 1, id: "S1", epic: "E1", title: "First story", repo: "app", status: "todo",
          depends_on: [], touches: ["s1.txt"], acceptance: ["it works"],
          test_plan: ["$ npm run test -> exit 0"], evidence: [],
        },
        dod: { present: true, commands: ["npm run test"] },
        text: "# S1\n",
        path: "/nowhere/S1.md",
        rel: "03-plan/stories/S1.md",
        wave: "W1",
        goal: [],
      },
      epic: {
        epic: {
          version: 1, id: "E1", title: "Epic E1", repos: ["app"],
          stories: ["S1"], branch: "epic/e1", status: "todo",
        },
        text: "# E1\n",
        path: "/nowhere/E1.md",
        rel: "03-plan/epics/E1.md",
      },
      repoName: "app",
      branch: "story/260909-detail/S1",
      epicBranch: "epic/e1",
      worktree: "/nowhere",
      commands: ["npm run test"],
      conventions: "_none_",
      facts: "_none_",
      experts: [],
      budgetUsd: 4,
      previousAttempt: "> Verdict: **n-a**",
      ...(previousAttemptKind === undefined ? {} : { previousAttemptKind }),
    });
  }

  test("a DoD-blocked attempt gets the DoD header, and claims no reviewer", () => {
    const prompt = devPrompt("dod");
    expect(prompt).toContain("## Previous attempt");
    expect(prompt).toContain(DOD_LINE);
    expect(prompt).not.toContain(REVIEW_LINE);
  });

  test("a reviewed attempt keeps today's header — and so does an absent kind", () => {
    expect(devPrompt("review")).toContain(REVIEW_LINE);
    expect(devPrompt("review")).not.toContain(DOD_LINE);
    // Absent means `review`: every prompt written before the field existed.
    expect(devPrompt()).toBe(devPrompt("review"));
  });
});

/**
 * Review round 1, item 3: the citation resolves to the line that carries the
 * failure, not to a constant `:1` at the top of a 200-line tail.
 */
describe("#211 · the kept output is cited at the failing line", () => {
  test("the citation's line is the FAIL line's own index in the file", async () => {
    const ran = await runScript(RED_SCRIPT);

    const row = ran.results[0] as DodResult;
    const kept = readFileSync(join(ran.dir, String(row.outputPath)), "utf8");
    const expected = kept.split("\n")
      .findIndex((l) => l.includes("FAIL test_x — AssertionError: expected 3, got 4")) + 1;
    expect(expected).toBeGreaterThan(1);
    expect(row.outputLine).toBe(expected);
    expect(dodFailureReason(row, "app")).toContain(`:${String(expected)}]`);
    expect(renderReviewLog(outcomeWith(ran.results)))
      .toContain(`[src: ${String(row.outputPath)}:${String(expected)}]`);
    const failed = ran.events.find((e) => e.type === "check.failed");
    expect(failed?.payload.output_line).toBe(expected);
  });
});

/**
 * Review round 1, item 4: bun's own summary line, which the heuristic missed —
 * `(fail)` has no capital and no `Error`.
 */
describe("#211 · the heuristic reads bun's summary line", () => {
  test("`(fail)` is failure-looking, and a trailing warning still does not win", () => {
    const text = "bun test v1.3.14\n(pass) something ok\n(fail) the thing > it works\n"
      + `1 fail\n\n${WARNING}\n`;
    const excerpt = failureExcerpt(text);
    expect(excerpt).toContain("(fail) the thing > it works");
    expect(excerpt).not.toContain("swigvarlink");
    expect(failureSummaryLine(text)).toBe("(fail) the thing > it works");
  });
});
