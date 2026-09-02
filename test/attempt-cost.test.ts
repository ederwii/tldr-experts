/**
 * gh #78 — what a story's ATTEMPT is allowed to be spent on.
 *
 * Measured on run `260830-ordering-inventory` (2026-09-01), in that run's own
 * `events.jsonl` and `04-build/log/`: S2, S3 and S5 each recorded
 * `check: review · verdict: changes · attempt: 1` over a summary that reads
 * "I would sign this: every named acceptance criterion is met …" with six
 * findings attached. Those were `fixlist` envelopes whose `refuted` findings
 * carried an `[src: …]` the §2.8 parser could not read — a FORMATTING fault in
 * the reviewer's report — and every one of them was charged to the story as a
 * failure of its WORK: one of two attempts, gone, on a diff nobody faulted.
 *
 * Owner decision (2026-09-01, on the issue): a claim-sources/grammar rejection
 * of a review envelope re-prompts for a corrected envelope WITHOUT consuming an
 * attempt, bounded at `MAX_GRAMMAR_RETRIES`; the one after that consumes it
 * exactly as today, so a reviewer that cannot write the grammar at all still
 * settles instead of looping for free.
 *
 * The scope guard is half the feature, so half the tests are pins: a verdict's
 * CONTENT, a DoD failure, an envelope refused for anything other than the
 * citation grammar — all keep the cost they have today, to the event.
 *
 * "Spends no attempt" is measured off `readReviewLedger`, which is the counter
 * the requeue actually reads, and off `events.jsonl`, never off prose in a log.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runNext, type NextOptions } from "../src/core/facilitator/runNext.ts";
import {
  isGrammarRejection, MAX_GRAMMAR_RETRIES, parseReview, renderGrammarRefusal,
} from "../src/core/build/review.ts";
import { parseFixFindings } from "../src/core/build/fixlist.ts";
import { SRC_GRAMMAR_HEADING } from "../src/core/text/srcGrammarContract.ts";
import { REVIEW_DIR } from "../src/core/run/prepared.ts";
import { EventLog } from "../src/core/events/EventLog.ts";
import { readReviewLedger } from "../src/core/facilitator/executors/build.ts";
import { makeBuildWorkspace, type BuildWorkspace, type BuildWorkspaceOptions } from "./fixtures/build/workspace.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

setDefaultTimeout(spawnTestTimeout());

const ORIGINAL_PATH = process.env.PATH ?? "";
const FAKE_KEYS = [
  "FAKE_BUILD_WRITE", "FAKE_BUILD_VERDICTS", "FAKE_BUILD_COST", "FAKE_BUILD_STATE",
  "FAKE_BUILD_ARGV_LOG", "FAKE_BUILD_PROMPT_DIR", "FAKE_BUILD_IS_ERROR",
  "FAKE_BUILD_FAIL", "FAKE_BUILD_FAIL_REASON", "FAKE_BUILD_FIXLIST",
] as const;

/** The event that records one free re-prompt. Attempt bookkeeping stays auditable. */
const RETRIED = "story.review_retried";

/**
 * A `refuted` finding whose citation is MID-LINE, which is the exact shape that
 * cost the ordering run three attempts: §2.8's token is anchored to the end of
 * its line (`TRAILING_TOKEN_RE` in `text/srcToken.ts`), so a `[src: …]` with
 * prose after it is invisible to the parser and the refutation carries no
 * evidence at all. The reviewer thinks it cited; the check says it did not.
 */
const CITATION_MID_LINE: readonly Record<string, unknown>[] = [
  {
    n: 1,
    severity: "high",
    finding: "the framing that the CHECK constraint is the real backstop is wrong",
    where: "src/stock.ts:74",
    disposition: "refuted",
    detail: "the CHECK cannot see this class of oversell [src: app:s1.txt:1] — measured by deleting it",
  },
];

/** A corrected envelope: the same claim, with the token where §2.8 puts it. */
const CITATION_FIXED: readonly Record<string, unknown>[] = [
  {
    n: 1,
    severity: "high",
    finding: "the framing that the CHECK constraint is the real backstop is wrong",
    where: "src/stock.ts:74",
    disposition: "refuted",
    detail: "the CHECK cannot see this class of oversell — measured by deleting it [src: app:s1.txt:1]",
  },
];

/**
 * Refused for something that is NOT the citation grammar. This is the pin: the
 * envelope is still unreadable and still falls to `changes`, and it still costs
 * the attempt, because widening the free retry past the claim-sources check is a
 * decision nobody has made.
 */
const BAD_DISPOSITION: readonly Record<string, unknown>[] = [
  {
    n: 1,
    severity: "high",
    finding: "two StockLines for one product throw a raw 23505",
    where: "src/stock.ts:120",
    disposition: "wontfix",
    detail: "IStockPort promises a failure Result and throws instead.",
  },
];

/**
 * A dod that goes red only AFTER the developer has written into the worktree —
 * the base tree stays green, so Build fails for the story's own reason rather
 * than refusing on a workspace-config fault (issue #41). Same script as
 * `build-executor.test.ts`.
 */
const RED_ONLY_AFTER_DEVELOPER =
  'node -e "process.exit(require(\'fs\').readdirSync(\'.\').some(function (f) { return f.endsWith(\'.txt\'); }) ? 1 : 0)"';

let open: BuildWorkspace[] = [];

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  for (const key of FAKE_KEYS) delete process.env[key];
  for (const ws of open) ws.dispose();
  open = [];
});

const ONE_STORY: BuildWorkspaceOptions = {
  stories: [{ id: "S1", epic: "E1", title: "First story" }],
  epics: [{ id: "E1", stories: ["S1"], branch: "epic/e1" }],
  waves: [["S1"]],
};

function workspace(options: BuildWorkspaceOptions = ONE_STORY): BuildWorkspace {
  const made = makeBuildWorkspace(options);
  open.push(made);
  process.env.PATH = made.binDir;
  process.env.FAKE_BUILD_STATE = made.statePath;
  return made;
}

function next(
  ws: BuildWorkspace,
  overrides: Partial<NextOptions> = {},
): Promise<{ code: number; lines: readonly string[] }> {
  return runNext({
    root: ws.root,
    dryRun: false,
    mode: "headless",
    yolo: false,
    actor: "alan",
    at: "2026-08-29T09:00:00Z",
    ...overrides,
  });
}

function story(ws: BuildWorkspace, id: string): string {
  return readFileSync(join(ws.planDir, "stories", `${id}.md`), "utf8");
}

function events(ws: BuildWorkspace): readonly { type: string; payload: Record<string, unknown> }[] {
  return EventLog.forRun(ws.runDir).read() as never;
}

/** Every recorded review VERDICT, in ledger order. A free retry is not one. */
function verdicts(ws: BuildWorkspace): readonly unknown[] {
  return events(ws).filter((e) => e.payload.check === "review").map((e) => e.payload.verdict);
}

function retries(ws: BuildWorkspace): readonly Record<string, unknown>[] {
  return events(ws).filter((e) => e.type === RETRIED).map((e) => e.payload);
}

function reviewDir(ws: BuildWorkspace, id: string): string {
  return join(ws.runDir, ".agent", "build", id, REVIEW_DIR);
}

function answerReview(ws: BuildWorkspace, id: string, envelope: unknown): void {
  writeFileSync(join(reviewDir(ws, id), "result.json"), `${JSON.stringify(envelope)}\n`, "utf8");
}

/**
 * Drive S1 to `review` with a merged commit, a green DoD and a reviewer bundle
 * out — the shape a HOST verdict is written into. Lifted from `fixlist.test.ts`,
 * because it is the same handshake being measured from the other side.
 */
async function handOffReview(ws: BuildWorkspace): Promise<void> {
  process.env.FAKE_BUILD_COST = "0";
  process.env.FAKE_BUILD_FAIL_REASON = "Reached maximum budget ($1)";
  process.env.FAKE_BUILD_FAIL = "reviewer:S1#1";
  await next(ws, { mode: "prepare" });
  writeFileSync(join(ws.root, ".tldrx", "worktrees", "app", `${ws.runId}-S1`, "s1.txt"), "S1\n", "utf8");
  writeFileSync(
    join(ws.runDir, ".agent", "build", "S1", "result.json"),
    JSON.stringify({ outputs: ["s1.txt"], questions_asked: [], notes: "", cost_usd: 0, session_id: "sess-1" }),
    "utf8",
  );
  await next(ws, { mode: "commit", at: "2026-08-29T09:30:00Z" });
  expect(story(ws, "S1")).toContain("status: review");
  await next(ws, { mode: "prepare", at: "2026-08-29T09:40:00Z" });
  expect(existsSync(join(reviewDir(ws, "S1"), "prompt.md"))).toBe(true);
}

/** One host verdict, settled through `--commit --review`. */
function settleHostReview(ws: BuildWorkspace, envelope: unknown, at: string): Promise<{ lines: readonly string[] }> {
  answerReview(ws, "S1", envelope);
  return next(ws, { mode: "commit", review: true, at });
}

function signedWith(fixlist: readonly Record<string, unknown>[]): Record<string, unknown> {
  return {
    verdict: "fixlist",
    summary: "I would sign this: every named acceptance criterion is met and the gate is green",
    findings: [],
    fixlist,
  };
}

// ---------------------------------------------------------------------------

describe("#78 — a claim-sources rejection re-prompts and spends no attempt", () => {
  test("the spawned reviewer is asked again, and the story's attempt is untouched", async () => {
    const ws = workspace();
    process.env.FAKE_BUILD_VERDICTS = JSON.stringify({ S1: ["fixlist", "approve"] });
    process.env.FAKE_BUILD_FIXLIST = JSON.stringify({ S1: CITATION_MID_LINE });

    await next(ws);

    // The work was never faulted, so the story finishes on its FIRST attempt.
    expect(story(ws, "S1")).toContain("status: done");
    // The refused envelope is not a verdict: only the corrected one is counted.
    expect(verdicts(ws)).toEqual(["approve"]);
    expect(readReviewLedger(ws.runDir, "S1").verdicts).toBe(1);
    // And the free round is on the record, with what was wrong with it.
    const retried = retries(ws);
    expect(retried).toHaveLength(1);
    expect(retried[0]?.story).toBe("S1");
    expect(String(retried[0]?.detail ?? "")).toContain("[src:");
  }, 90_000);

  test("the re-prompt carries the rejection, so the reviewer knows what to fix", async () => {
    const ws = workspace();
    const promptDir = join(ws.root, "prompts");
    process.env.FAKE_BUILD_PROMPT_DIR = promptDir;
    process.env.FAKE_BUILD_VERDICTS = JSON.stringify({ S1: ["fixlist", "approve"] });
    process.env.FAKE_BUILD_FIXLIST = JSON.stringify({ S1: CITATION_MID_LINE });

    await next(ws);

    const second = readFileSync(join(promptDir, "reviewer-S1-2.md"), "utf8");
    expect(second).toContain("REFUSED");
    expect(second).toContain("[src:");
    // The first prompt said nothing about a refusal, because nothing had been.
    expect(readFileSync(join(promptDir, "reviewer-S1-1.md"), "utf8")).not.toContain("REFUSED");
  }, 90_000);

  test("the retries are BOUNDED: the third grammar failure costs the attempt, as today", async () => {
    const ws = workspace();
    // Three refused envelopes: two free, the third counted. Then the developer
    // gets its second attempt and the fourth reviewer approves.
    process.env.FAKE_BUILD_VERDICTS = JSON.stringify({
      S1: ["fixlist", "fixlist", "fixlist", "approve"],
    });
    process.env.FAKE_BUILD_FIXLIST = JSON.stringify({ S1: CITATION_MID_LINE });

    await next(ws);

    expect(retries(ws)).toHaveLength(2);
    // The third is a verdict like any other `changes`: it requeues the story.
    expect(verdicts(ws)).toEqual(["changes", "approve"]);
    expect(story(ws, "S1")).toContain("status: done");
    expect(readFileSync(join(ws.runDir, "04-build", "log", "S1.md"), "utf8")).toContain("Attempt: 2");
  }, 120_000);
});

describe("#78 scope guard — every other rejection costs exactly what it did", () => {
  test("a CONTENT `changes` still consumes the attempt, and records no free retry", async () => {
    const ws = workspace();
    process.env.FAKE_BUILD_VERDICTS = JSON.stringify({ S1: ["changes", "changes"] });

    await next(ws);

    expect(story(ws, "S1")).toContain("status: blocked");
    expect(verdicts(ws)).toEqual(["changes", "changes"]);
    expect(readReviewLedger(ws.runDir, "S1").verdicts).toBe(2);
    expect(retries(ws)).toEqual([]);
  }, 90_000);

  test("an envelope refused for something OTHER than the citation grammar still costs one", async () => {
    const ws = workspace();
    process.env.FAKE_BUILD_VERDICTS = JSON.stringify({ S1: ["fixlist", "approve"] });
    process.env.FAKE_BUILD_FIXLIST = JSON.stringify({ S1: BAD_DISPOSITION });

    await next(ws);

    // Unreadable, fail-closed to `changes`, counted — the pre-#78 behaviour.
    expect(verdicts(ws)).toEqual(["changes", "approve"]);
    expect(retries(ws)).toEqual([]);
    expect(readFileSync(join(ws.runDir, "04-build", "log", "S1.md"), "utf8")).toContain("Attempt: 2");
  }, 120_000);

  test("a red DoD still blocks the story — nothing here touches that path", async () => {
    // Red only once the developer has written into the worktree, so the base
    // tree stays green and Build is not refused for a workspace-config fault.
    const ws = workspace({ ...ONE_STORY, testScript: RED_ONLY_AFTER_DEVELOPER });

    await next(ws);

    expect(story(ws, "S1")).toContain("status: blocked");
    expect(retries(ws)).toEqual([]);
  }, 90_000);
});

describe("#78 through the host handshake — the same rule, the other door", () => {
  test("a malformed host envelope keeps the bundle out and counts no verdict", async () => {
    const ws = workspace();
    await handOffReview(ws);

    const refused = await settleHostReview(ws, signedWith(CITATION_MID_LINE), "2026-08-29T10:00:00Z");

    // Nothing was judged, so nothing is spent and the handshake is still open.
    expect(readReviewLedger(ws.runDir, "S1").verdicts).toBe(0);
    expect(story(ws, "S1")).toContain("status: review");
    expect(existsSync(join(reviewDir(ws, "S1"), "pending.json"))).toBe(true);
    expect(retries(ws)).toHaveLength(1);
    const said = refused.lines.join("\n");
    expect(said).toContain("[src:");
    expect(said).toContain("--commit --review");
    // The judgement the host paid for is kept, not binned — only moved so the
    // next `--commit --review` cannot settle the envelope this just refused.
    expect(existsSync(join(reviewDir(ws, "S1"), "result.json"))).toBe(false);
    expect(existsSync(join(reviewDir(ws, "S1"), "result.refused-1.json"))).toBe(true);
    // And the rewritten prompt carries the refusal, not the brief that produced it.
    expect(readFileSync(join(reviewDir(ws, "S1"), "prompt.md"), "utf8")).toContain("REFUSED");

    // The corrected envelope settles it, on the SAME attempt.
    await settleHostReview(ws, signedWith(CITATION_FIXED), "2026-08-29T10:10:00Z");
    expect(readReviewLedger(ws.runDir, "S1").fixlistRounds).toBe(1);
    expect(readReviewLedger(ws.runDir, "S1").verdicts).toBe(0);
    expect(readFileSync(join(ws.runDir, "04-build", "log", "S1.md"), "utf8")).toContain("Attempt: 1");
  }, 90_000);

  test("the host gets two free corrections and no more", async () => {
    const ws = workspace();
    await handOffReview(ws);

    await settleHostReview(ws, signedWith(CITATION_MID_LINE), "2026-08-29T10:00:00Z");
    await settleHostReview(ws, signedWith(CITATION_MID_LINE), "2026-08-29T10:10:00Z");
    await settleHostReview(ws, signedWith(CITATION_MID_LINE), "2026-08-29T10:20:00Z");

    expect(retries(ws)).toHaveLength(2);
    // `error` is the fixture's own deliberately-dead first spawn (`handOffReview`),
    // and it is not a verdict. The third refused envelope IS one: `changes`,
    // counted, and it costs the attempt exactly as a content refusal does.
    expect(verdicts(ws)).toEqual(["error", "changes"]);
    expect(readReviewLedger(ws.runDir, "S1").verdicts).toBe(1);
    // The round closed, so the counter is back to zero for the next envelope.
    expect(readReviewLedger(ws.runDir, "S1").grammarRetries).toBe(0);
  }, 90_000);
});

/**
 * The classifier itself. Every widening of #78 has to get past this describe
 * first, which is the point of writing it as a predicate rather than as a
 * condition inline in the executor.
 */
describe("isGrammarRejection — the scope guard, in one predicate", () => {
  function refused(fixlist: readonly Record<string, unknown>[]) {
    return parseReview({ verdict: "fixlist", summary: "I would sign this", findings: [], fixlist }, "");
  }

  test("a mis-placed [src: …] on a `refuted` finding is one", () => {
    const review = refused(CITATION_MID_LINE);
    expect(review.verdict).toBe("changes");
    expect(review.grammarProblems).toHaveLength(1);
    // The subset is a subset: an operator still reads every refusal.
    expect(review.fixlistProblems).toEqual(review.grammarProblems);
    expect(isGrammarRejection(review)).toBe(true);
  });

  test("a citation the parser CAN read is not refused at all", () => {
    const review = refused(CITATION_FIXED);
    expect(review.verdict).toBe("fixlist");
    expect(review.grammarProblems).toEqual([]);
    expect(isGrammarRejection(review)).toBe(false);
  });

  test("an envelope refused for anything else is NOT one", () => {
    for (const envelope of [
      { verdict: "fixlist", summary: "s", findings: [] },                        // no fixlist[]
      { verdict: "fixlist", summary: "s", findings: [], fixlist: [] },           // empty
      { verdict: "fixlist", summary: "s", findings: [], fixlist: BAD_DISPOSITION },
      { verdict: "changes", summary: "the criteria are not met", findings: [] }, // content
      { verdict: "approve", summary: "ok", findings: [] },
    ]) {
      expect(isGrammarRejection(parseReview(envelope, ""))).toBe(false);
    }
  });

  test("a MIXED refusal costs the attempt — one bad citation does not excuse the rest", () => {
    const review = refused([...CITATION_MID_LINE, ...BAD_DISPOSITION]);
    expect(review.grammarProblems).toHaveLength(1);
    expect(review.fixlistProblems).toHaveLength(2);
    expect(isGrammarRejection(review)).toBe(false);
  });

  test("an unreadable verdict WORD keeps its own fault, and its own cost (#36)", () => {
    // `sign` is the gate vocabulary; #36 named it out loud and it still costs an
    // attempt. A `fixlist[]` beside it does not turn that into a formatting slip.
    const review = parseReview({ verdict: "sign", summary: "s", findings: [], fixlist: CITATION_MID_LINE }, "");
    expect(review.verdictProblem).toContain("sign");
    expect(isGrammarRejection(review)).toBe(false);
  });

  test("the re-prompt carries #77's diagnosis verbatim — rule named, line quoted", () => {
    const parsed = parseFixFindings(CITATION_MID_LINE);
    expect(parsed.grammar).toHaveLength(1);
    const said = parsed.problems[0] ?? "";
    // #77's contract, not #78's: the rule it enforced, the line it read, and a
    // corrected one. #78 owns none of these words and re-words none of them.
    expect(said).toContain("trailing-position");
    expect(said).toContain("the CHECK cannot see this class of oversell [src: app:s1.txt:1]");
    const prompt = renderGrammarRefusal(parsed.problems);
    expect(prompt).toContain(said);
    expect(prompt).toContain(String(MAX_GRAMMAR_RETRIES));
    // …and it points at the grammar #77 splices into the same prompt rather than
    // restating it. Two copies of a grammar is the thing #77 exists to abolish.
    expect(prompt).toContain(SRC_GRAMMAR_HEADING);
  });

  test("#78 indexes #77's refusals, it does not re-word or filter them", () => {
    const parsed = parseFixFindings(CITATION_MID_LINE);
    // `grammar` is a SUBSET of `problems`, sharing the identical strings — so a
    // change to the message cannot silently change what counts as free.
    expect(parsed.grammar).toEqual(parsed.problems);
  });
});
