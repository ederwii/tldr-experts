/**
 * The `fixlist` verdict, its artifact and its router (design §B.4).
 *
 * The measurement it is built on is 2026-08-31, driving
 * `260830-tenancy-identity-customers` by hand: the reviewer SIGNED story S5 —
 * every acceptance criterion met, zero scope violations — and in the same breath
 * named three real defects the criteria never covered (a concurrent
 * double-confirm minting two sessions, a non-atomic confirm, a false security
 * comment beside a non-constant-time compare). S1 and S3 went the same way that
 * night. Every one of those loops was run in chat: number the findings, decide
 * fix-now vs defer-with-log, route them to the author, re-verify. None of it
 * reached a file.
 *
 * So the properties worth a test each are the ones that make it a loop rather
 * than a conversation:
 *
 *   - a `fixlist` verdict writes `04-build/fixlist/<story>-<n>.md` and spends NO
 *     attempt;
 *   - the next `--prepare` carries that file back to the AUTHOR;
 *   - there is exactly ONE such round, and the second is refused out loud;
 *   - `refuted` costs an `[src: …]`, and a fix list without one is not a fix list;
 *   - an unreadable `fixlist[]` is `changes`, never a free round (fail-closed);
 *   - a story cannot settle `done` over an open `fix-now`;
 *   - and both economies reach it: the host handshake and the spawned reviewer.
 *
 * "Spends no attempt" is measured off the ledger the requeue counter actually
 * reads, not off a line of prose in a log.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runNext, type NextOptions } from "../src/core/facilitator/runNext.ts";
import { REVIEW_DIR } from "../src/core/run/prepared.ts";
import { EventLog } from "../src/core/events/EventLog.ts";
import { parseReview } from "../src/core/build/review.ts";
import {
  DISPOSITIONS, MAX_FIXLIST_ROUNDS, openFindings, parseFixFindings, parseFixlistFile, renderFixlist,
} from "../src/core/build/fixlist.ts";
import { readReviewLedger } from "../src/core/facilitator/executors/build.ts";
import { makeBuildWorkspace, type BuildWorkspace, type BuildWorkspaceOptions } from "./fixtures/build/workspace.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

// Every test in this file spawns a REAL process — git, `bun`, the CLI. Process cost is a
// property of the machine, not of the code, so bun's fixed 5000 ms default measures the box:
// on an untouched tree, tests here timed out while the same files passed alone (#43). The
// budget scales with measured load; the assertions are untouched, and a hang is still caught.
setDefaultTimeout(spawnTestTimeout());

const ORIGINAL_PATH = process.env.PATH ?? "";
const FAKE_KEYS = [
  "FAKE_BUILD_WRITE", "FAKE_BUILD_VERDICTS", "FAKE_BUILD_COST", "FAKE_BUILD_STATE",
  "FAKE_BUILD_ARGV_LOG", "FAKE_BUILD_PROMPT_DIR", "FAKE_BUILD_IS_ERROR",
  "FAKE_BUILD_FAIL", "FAKE_BUILD_FAIL_REASON", "FAKE_BUILD_FIXLIST",
] as const;

const DIED = "Reached maximum budget ($1)";

/** The three defects S5's reviewer actually raised, in envelope shape. */
const THREE_DEFECTS: readonly Record<string, unknown>[] = [
  {
    n: 1,
    severity: "high",
    finding: "Concurrent double-confirm mints two sessions",
    where: "`src/auth.ts:74` [src: app:s1.txt:1]",
    disposition: "fix-now",
    detail: "Two requests carrying the same code both pass the check and both mint a session.",
    do_not: ["add a lockout policy; that is a product decision (see 3)"],
  },
  {
    n: 2,
    severity: "high",
    finding: "Non-atomic confirm",
    where: "`src/auth.ts:88` [src: app:s1.txt:1]",
    disposition: "fix-now",
    detail: "The read and the write are two statements with no transaction around them.",
  },
  {
    n: 3,
    severity: "medium",
    finding: "No OTP attempt limiter",
    disposition: "defer-with-log",
    detail: "A lockout policy is a product call; logged for the owner.",
  },
];

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

function reviewDir(ws: BuildWorkspace, id: string): string {
  return join(ws.runDir, ".agent", "build", id, REVIEW_DIR);
}

function fixlistPath(ws: BuildWorkspace, id: string, round: number): string {
  return join(ws.runDir, "04-build", "fixlist", `${id}-${String(round)}.md`);
}

function answerReview(ws: BuildWorkspace, id: string, envelope: unknown): void {
  writeFileSync(join(reviewDir(ws, id), "result.json"), `${JSON.stringify(envelope)}\n`, "utf8");
}

/** Every `claude` invocation the fake recorded. */
function spawns(ws: BuildWorkspace): readonly string[] {
  const path = join(ws.root, "argv.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((line) => line.trim() !== "");
}

function countSpawns(ws: BuildWorkspace): void {
  process.env.FAKE_BUILD_ARGV_LOG = join(ws.root, "argv.jsonl");
}

/**
 * Drive S1 through its developer half in-session, so it sits at `review` with a
 * merged commit, a green DoD and a reviewer bundle out — the shape a host verdict
 * is written into.
 */
async function handOffReview(ws: BuildWorkspace): Promise<void> {
  process.env.FAKE_BUILD_COST = "0";
  process.env.FAKE_BUILD_FAIL_REASON = DIED;
  process.env.FAKE_BUILD_FAIL = "reviewer:S1#1";
  await next(ws, { mode: "prepare" });
  writeFileSync(join(ws.root, ".tldrx", "worktrees", "app", `${ws.runId}-S1`, "s1.txt"), "S1\n", "utf8");
  writeFileSync(
    join(ws.runDir, ".agent", "build", "S1", "result.json"),
    JSON.stringify({ outputs: ["s1.txt"], questions_asked: [], notes: "", cost_usd: 0, session_id: "sess-author-1" }),
    "utf8",
  );
  await next(ws, { mode: "commit", at: "2026-08-29T09:30:00Z" });
  expect(story(ws, "S1")).toContain("status: review");
  await next(ws, { mode: "prepare", at: "2026-08-29T09:40:00Z" });
  expect(existsSync(join(reviewDir(ws, "S1"), "prompt.md"))).toBe(true);
}

/** The host's fix-list verdict, settled. */
async function fixlistRound(ws: BuildWorkspace, at: string): Promise<readonly string[]> {
  answerReview(ws, "S1", {
    verdict: "fixlist",
    summary: "signed — every criterion is met, and three defects the criteria never covered",
    findings: [],
    fixlist: THREE_DEFECTS,
  });
  const settled = await next(ws, { mode: "commit", review: true, at });
  return settled.lines;
}

// ---------------------------------------------------------------------------

describe("the fixlist verdict, through the host handshake", () => {
  test("writes the numbered artifact and spends NO attempt", async () => {
    const ws = workspace();
    await handOffReview(ws);
    countSpawns(ws);

    const lines = (await fixlistRound(ws, "2026-08-29T10:00:00Z")).join("\n");

    expect(spawns(ws)).toEqual([]);
    // The story parks at `review` — signed, not faulted, and not done either.
    expect(story(ws, "S1")).toContain("status: review");
    const text = readFileSync(fixlistPath(ws, "S1", 1), "utf8");
    expect(text.split("\n")[0]).toBe("# Fix list — S1 · First story, round 1");
    expect(text).toContain("## 1 · Concurrent double-confirm mints two sessions  [high]");
    expect(text).toContain("## 2 · Non-atomic confirm  [high]");
    expect(text).toContain("## 3 · No OTP attempt limiter  [medium]");
    expect(text).toContain("Disposition: **fix-now**");
    expect(text).toContain("Disposition: **defer-with-log**");
    expect(text).toContain("Resolved: no");
    // The `Do NOT` line, verbatim — a bound the reviewer put on the fix is worth
    // as much as the fix.
    expect(text).toContain("Do NOT: add a lockout policy; that is a product decision (see 3)");
    expect(lines).toContain("fix list written — 04-build/fixlist/S1-1.md");

    // NO attempt spent, measured off the counter the requeue rule actually reads.
    const ledger = readReviewLedger(ws.runDir, "S1");
    expect(ledger.verdicts).toBe(0);
    expect(ledger.fixlistRounds).toBe(1);
    // And on the ledger line, as its own verdict rather than a `changes`.
    const review = events(ws).filter((e) => e.payload.check === "review");
    expect(review.map((e) => e.payload.verdict)).toEqual(["error", "fixlist"]);
    expect(review[1]?.payload.source).toBe("host");
  }, 60_000);

  test("`defer-with-log` reaches the owner through retro.md, `fix-now` does not", async () => {
    const ws = workspace();
    await handOffReview(ws);
    await fixlistRound(ws, "2026-08-29T10:00:00Z");

    const retro = readFileSync(join(ws.runDir, "retro.md"), "utf8");
    expect(retro).toContain("reviewer finding DEFERRED (medium): No OTP attempt limiter");
    expect(retro).toContain("[src: tldrx-work/");
    // The two `fix-now` findings are work, not feedback: they go to the author.
    expect(retro).not.toContain("Concurrent double-confirm");
  }, 60_000);

  test("the next --prepare carries the fix list back to the AUTHOR", async () => {
    const ws = workspace();
    await handOffReview(ws);
    await fixlistRound(ws, "2026-08-29T10:00:00Z");
    countSpawns(ws);

    const prepared = await next(ws, { mode: "prepare", at: "2026-08-29T10:10:00Z" });

    expect(spawns(ws)).toEqual([]);
    const dir = join(ws.runDir, ".agent", "build", "S1");
    const prompt = readFileSync(join(dir, "prompt.md"), "utf8");
    expect(prompt).toContain("## Fix list");
    expect(prompt).toContain("`04-build/fixlist/S1-1.md`");
    expect(prompt).toContain("1. **Concurrent double-confirm mints two sessions** [high]");
    expect(prompt).toContain("2. **Non-atomic confirm** [high]");
    // Its `Do NOT` line, verbatim, in the author's own prompt.
    expect(prompt).toContain("Do NOT: add a lockout policy; that is a product decision (see 3)");
    // The deferred one is listed, not asked for.
    expect(prompt).toContain("**Not yours this round**");
    expect(prompt).toContain("3. No OTP attempt limiter — `defer-with-log`");

    const pending = JSON.parse(readFileSync(join(dir, "pending.json"), "utf8")) as {
      story: string; expert: string; resume_session: string | null;
      fixlist: { path: string; round: number; findings: number; open: number };
    };
    expect(pending.expert).toBe("developer");
    expect(pending.fixlist).toEqual({ path: "04-build/fixlist/S1-1.md", round: 1, findings: 3, open: 2 });
    // The prior author's session, handed BACK: the framework resumes nothing.
    expect(pending.resume_session).toBe("sess-author-1");
    const said = prepared.lines.join("\n");
    expect(said).toContain("routing 04-build/fixlist/S1-1.md back to the author");
    expect(said).toContain("this round spent no attempt");
    expect(said).toContain("the prior author's session was `sess-author-1`");
    // Attempt 1 still: a signed round buys no second one.
    expect(said).toContain("attempt 1 of 2");
  }, 60_000);

  test("--fixlist names the file explicitly, and refuses one that is not this story's", async () => {
    const ws = workspace();
    await handOffReview(ws);
    await fixlistRound(ws, "2026-08-29T10:00:00Z");

    const named = await next(ws, {
      mode: "prepare", at: "2026-08-29T10:10:00Z", fixlist: "04-build/fixlist/S1-1.md",
    });
    expect(named.code).toBe(0);
    expect(readFileSync(join(ws.runDir, ".agent", "build", "S1", "prompt.md"), "utf8"))
      .toContain("## Fix list");

    // A path that is not a fix list at all.
    const missing = await next(ws, { mode: "prepare", at: "2026-08-29T10:12:00Z", fixlist: "nope.md" });
    expect(missing.code).toBe(5);
    expect(missing.lines.join("\n")).toContain("--fixlist nope.md: no readable fix list there");

    // Another story's, refused rather than rendered.
    writeFileSync(
      join(ws.runDir, "04-build", "fixlist", "S9-1.md"),
      renderFixlist({
        storyId: "S9", title: "Other", round: 1, attempt: 1, maxAttempts: 2,
        diff: "git diff a...b", commit: "abc1234", summary: "",
        findings: parseFixFindings([{ finding: "x", disposition: "fix-now" }]).findings,
      }),
      "utf8",
    );
    const wrong = await next(ws, {
      mode: "prepare", at: "2026-08-29T10:14:00Z", fixlist: "04-build/fixlist/S9-1.md",
    });
    expect(wrong.code).toBe(5);
    expect(wrong.lines.join("\n")).toContain("is not S1's fix list");
  }, 90_000);
});

describe("the bound: one fix-list round per story", () => {
  test("a SECOND fixlist is refused out loud and read as `changes`", async () => {
    const ws = workspace();
    await handOffReview(ws);
    await fixlistRound(ws, "2026-08-29T10:00:00Z");
    // A second reviewer bundle over the same merged commit.
    await next(ws, { mode: "prepare", review: true, at: "2026-08-29T10:20:00Z" });
    countSpawns(ws);

    const second = await fixlistRound(ws, "2026-08-29T10:30:00Z");
    const said = second.join("\n");

    expect(spawns(ws)).toEqual([]);
    expect(said).toContain("a SECOND fix-list round was refused");
    expect(said).toContain(`the bound is ${String(MAX_FIXLIST_ROUNDS)} per story`);
    expect(said).toContain("(round 1 is 04-build/fixlist/S1-1.md)");
    expect(said).toContain("its verdict is read as `changes`");
    // No second artifact — the refusal is a refusal, not a rename.
    expect(existsSync(fixlistPath(ws, "S1", 2))).toBe(false);
    // And it settled as `changes`: THAT one costs the attempt a fix list did not.
    const ledger = readReviewLedger(ws.runDir, "S1");
    expect(ledger.verdicts).toBe(1);
    expect(ledger.fixlistRounds).toBe(1);
    const review = events(ws).filter((e) => e.payload.check === "review");
    expect(review.map((e) => e.payload.verdict)).toEqual(["error", "fixlist", "changes"]);
    // The findings survive the downgrade — they are the review's whole content.
    expect(readFileSync(join(ws.runDir, "04-build", "log", "S1.md"), "utf8"))
      .toContain("1. Concurrent double-confirm mints two sessions [high]");
  }, 90_000);

  test("the SECOND reviewer's prompt withdraws the verdict the executor would refuse", async () => {
    const ws = workspace();
    await handOffReview(ws);
    const first = readFileSync(join(reviewDir(ws, "S1"), "prompt.md"), "utf8");
    expect(first).toContain("- `fixlist` — you would sign, AND you found defects");

    await fixlistRound(ws, "2026-08-29T10:00:00Z");
    await next(ws, { mode: "prepare", review: true, at: "2026-08-29T10:20:00Z" });

    const second = readFileSync(join(reviewDir(ws, "S1"), "prompt.md"), "utf8");
    expect(second).toContain("(`fixlist` is NOT available on this story");
    expect(second).not.toContain("- `fixlist` — you would sign, AND you found defects");
  }, 90_000);
});

describe("a story cannot settle `done` over an open `fix-now`", () => {
  test("an approve is BLOCKED, and the block names the finding", async () => {
    const ws = workspace();
    await handOffReview(ws);
    await fixlistRound(ws, "2026-08-29T10:00:00Z");
    await next(ws, { mode: "prepare", review: true, at: "2026-08-29T10:20:00Z" });

    answerReview(ws, "S1", { verdict: "approve", summary: "re-read the diff", findings: [] });
    await next(ws, { mode: "commit", review: true, at: "2026-08-29T10:30:00Z" });

    expect(story(ws, "S1")).toContain("status: blocked");
    const log = readFileSync(join(ws.runDir, "04-build", "log", "S1.md"), "utf8");
    expect(log).toContain("2 fix-list finding(s) are still `fix-now` in 04-build/fixlist/S1-1.md");
    expect(log).toContain("#1 · Concurrent double-confirm mints two sessions");
    expect(log).toContain("Close each one there (`Resolved: yes`) or re-route its `Disposition:`");
  }, 90_000);

  test("closing every finding in the file lets the same approve settle `done`", async () => {
    const ws = workspace();
    await handOffReview(ws);
    await fixlistRound(ws, "2026-08-29T10:00:00Z");
    // The host's move: the fixes landed, so the file says so.
    const path = fixlistPath(ws, "S1", 1);
    writeFileSync(path, readFileSync(path, "utf8").replaceAll("Resolved: no", "Resolved: yes"), "utf8");
    await next(ws, { mode: "prepare", review: true, at: "2026-08-29T10:20:00Z" });

    answerReview(ws, "S1", { verdict: "approve", summary: "re-read the diff", findings: [] });
    await next(ws, { mode: "commit", review: true, at: "2026-08-29T10:30:00Z" });

    expect(story(ws, "S1")).toContain("status: done");
  }, 90_000);

  test("re-routing a finding away from `fix-now` closes it too", async () => {
    const ws = workspace();
    await handOffReview(ws);
    await fixlistRound(ws, "2026-08-29T10:00:00Z");
    const path = fixlistPath(ws, "S1", 1);
    writeFileSync(
      path,
      readFileSync(path, "utf8").replaceAll("Disposition: **fix-now**", "Disposition: **out-of-scope**"),
      "utf8",
    );
    await next(ws, { mode: "prepare", review: true, at: "2026-08-29T10:20:00Z" });

    answerReview(ws, "S1", { verdict: "approve", summary: "re-read the diff", findings: [] });
    await next(ws, { mode: "commit", review: true, at: "2026-08-29T10:30:00Z" });

    expect(story(ws, "S1")).toContain("status: done");
  }, 90_000);
});

describe("the spawned reviewer reaches the same verdict", () => {
  test("a headless run writes the artifact, spends no attempt, and parks the story", async () => {
    const ws = workspace();
    process.env.FAKE_BUILD_COST = "0";
    process.env.FAKE_BUILD_VERDICTS = JSON.stringify({ S1: ["fixlist"] });
    process.env.FAKE_BUILD_FIXLIST = JSON.stringify({ S1: THREE_DEFECTS });

    await next(ws);

    expect(story(ws, "S1")).toContain("status: review");
    const text = readFileSync(fixlistPath(ws, "S1", 1), "utf8");
    expect(text).toContain("## 1 · Concurrent double-confirm mints two sessions  [high]");
    expect(text).toContain("Disposition: **defer-with-log**");
    const ledger = readReviewLedger(ws.runDir, "S1");
    expect(ledger.verdicts).toBe(0);
    expect(ledger.fixlistRounds).toBe(1);
    // Exactly one developer and one reviewer: a fix list does not requeue the
    // developer inside the same process, because the routing it is owed needs a
    // host and a headless invocation has none.
    const spawned = events(ws).filter((e) => e.type === "agent.spawned");
    expect(spawned.map((e) => e.payload.role)).toEqual(["developer", "reviewer"]);
  }, 90_000);

  test("a `fixlist` verdict with no findings is `changes`, not a free round", async () => {
    const ws = workspace();
    process.env.FAKE_BUILD_COST = "0";
    process.env.FAKE_BUILD_VERDICTS = JSON.stringify({ S1: ["fixlist"] });
    // No FAKE_BUILD_FIXLIST: the envelope declares the verdict and carries nothing.

    await next(ws);

    expect(existsSync(fixlistPath(ws, "S1", 1))).toBe(false);
    const ledger = readReviewLedger(ws.runDir, "S1");
    expect(ledger.fixlistRounds).toBe(0);
    // Fail-closed: it cost the attempt a `changes` costs, and the reason says why.
    expect(ledger.verdicts).toBeGreaterThan(0);
    const log = readFileSync(join(ws.runDir, "04-build", "log", "S1.md"), "utf8");
    expect(log).toContain("Verdict: **changes**");
  }, 90_000);

  test("a `refuted` finding with no [src: …] refuses the whole fix list", async () => {
    const ws = workspace();
    process.env.FAKE_BUILD_COST = "0";
    process.env.FAKE_BUILD_VERDICTS = JSON.stringify({ S1: ["fixlist"] });
    process.env.FAKE_BUILD_FIXLIST = JSON.stringify({
      S1: [{ finding: "The compare is not constant time", disposition: "refuted", detail: "I checked" }],
    });

    const outcome = await next(ws);

    expect(existsSync(fixlistPath(ws, "S1", 1))).toBe(false);
    expect(outcome.lines.join("\n")).toContain("the reviewer's fix list was REFUSED");
    // gh #77: the refusal says WHY the citation was not read, not just that it was not.
    expect(outcome.lines.join("\n")).toContain("is `refuted` and its citation was not read");
    expect(outcome.lines.join("\n")).toContain("must END with a `[src: …]` token that parses");
    expect(outcome.lines.join("\n")).toContain("does not buy a free round");
    expect(readReviewLedger(ws.runDir, "S1").fixlistRounds).toBe(0);
  }, 90_000);
});

// ---------------------------------------------------------------------------
// The grammar itself, with no run around it.

describe("parseFixFindings", () => {
  test("every disposition parses, and defaults are filled rather than guessed", () => {
    const parsed = parseFixFindings(
      DISPOSITIONS.map((disposition, i) => ({
        finding: `finding ${String(i)}`,
        disposition,
        // `refuted` is the one that must cite; the others need nothing.
        ...(disposition === "refuted" ? { where: "the grep found none [src: app:s1.txt:1]" } : {}),
      })),
    );
    expect(parsed.problems).toEqual([]);
    expect(parsed.findings.map((f) => f.disposition)).toEqual([...DISPOSITIONS]);
    // `n` and `severity` are filled from position and a word, never invented.
    expect(parsed.findings.map((f) => f.n)).toEqual([1, 2, 3, 4]);
    expect(parsed.findings[0]?.severity).toBe("unrated");
    expect(parsed.findings[0]?.resolved).toBe(false);
  });

  test("`refuted` without a resolvable src token is refused, and named", () => {
    const parsed = parseFixFindings([{ finding: "not a real defect", disposition: "refuted" }]);
    expect(parsed.findings).toEqual([]);
    expect(parsed.problems).toHaveLength(1);
    expect(parsed.problems[0]).toContain("finding 1 is `refuted` and its citation was not read");
    // gh #77: and it says what a citation IS, with a line that would pass.
    expect(parsed.problems[0]).toContain("must END with a `[src: …]` token that parses");
  });

  test("a malformed [src: …] is not a citation, and the rule that refused it is named", () => {
    const parsed = parseFixFindings([
      { finding: "x", disposition: "refuted", where: "checked [src: ]" },
    ]);
    expect(parsed.problems).toHaveLength(1);
    expect(parsed.problems[0]).toContain("empty-token");
    expect(parsed.problems[0]).toContain("checked [src: ]");
  });

  test("an unknown disposition, a missing finding and an empty list are each refused", () => {
    expect(parseFixFindings([{ finding: "x", disposition: "wont-fix" }]).problems[0])
      .toContain("no valid `disposition`");
    expect(parseFixFindings([{ disposition: "fix-now" }]).problems[0]).toContain("no `finding` text");
    expect(parseFixFindings([]).problems[0]).toContain("`fixlist` is empty");
    expect(parseFixFindings(undefined).problems[0]).toContain("missing or is not an array");
  });
});

describe("the artifact round-trips", () => {
  test("render → parse returns the same findings, dispositions and bounds", () => {
    const findings = parseFixFindings(THREE_DEFECTS).findings;
    const text = renderFixlist({
      storyId: "S5", title: "OTP confirm", round: 1, attempt: 1, maxAttempts: 2,
      diff: "git diff epic/tenancy...story/260830-tenancy/S5",
      commit: "abc1234", summary: "signed with findings", findings,
    });
    const read = parseFixlistFile(text);

    expect(read).toHaveLength(3);
    expect(read.map((f) => [f.n, f.disposition, f.resolved]))
      .toEqual([[1, "fix-now", false], [2, "fix-now", false], [3, "defer-with-log", false]]);
    expect(read[0]?.severity).toBe("high");
    expect(read[0]?.finding).toBe("Concurrent double-confirm mints two sessions");
    expect(read[0]?.doNot).toEqual(["add a lockout policy; that is a product decision (see 3)"]);
    expect(read[0]?.detail).toContain("both mint a session");
    expect(openFindings(read)).toHaveLength(2);
    // The preamble is addressed to the host and is not a finding.
    expect(text).toContain("**A `fix-now` finding keeps this story out of `done`.**");
  });

  test("`Resolved: yes` closes a finding without changing where it was routed", () => {
    const findings = parseFixFindings(THREE_DEFECTS).findings;
    const text = renderFixlist({
      storyId: "S5", title: "OTP confirm", round: 1, attempt: 1, maxAttempts: 2,
      diff: "d", commit: "c", summary: "", findings,
    }).replace("Resolved: no", "Resolved: yes");
    const read = parseFixlistFile(text);

    expect(read[0]?.resolved).toBe(true);
    expect(read[0]?.disposition).toBe("fix-now");
    expect(openFindings(read).map((f) => f.n)).toEqual([2]);
  });
});

describe("parseReview and the third verdict", () => {
  test("`{verdict: fixlist}` with no fixlist[] is `changes` — fail-closed, asserted", () => {
    const review = parseReview({ verdict: "fixlist", summary: "signed", findings: [] }, "");
    expect(review.verdict).toBe("changes");
    expect(review.fixlist).toEqual([]);
    expect(review.fixlistProblems[0]).toContain("missing or is not an array");
  });

  test("a readable fixlist[] grants the verdict and carries the findings through", () => {
    const review = parseReview(
      { verdict: "fixlist", summary: "signed", findings: [], fixlist: THREE_DEFECTS },
      "",
    );
    expect(review.verdict).toBe("fixlist");
    expect(review.fixlist).toHaveLength(3);
    expect(review.fixlistProblems).toEqual([]);
  });

  test("`approve` and `changes` are untouched by any of this", () => {
    expect(parseReview({ verdict: "approve", summary: "ok", findings: [] }, "").verdict).toBe("approve");
    expect(parseReview({ verdict: "approve", summary: "", findings: [], fixlist: [] }, "").verdict)
      .toBe("approve");
    expect(parseReview("not an object", "fallback")).toEqual({
      verdict: "changes", summary: "fallback", findings: [], fixlist: [], fixlistProblems: [],
      // No envelope carried no verdict: the summary already says what happened,
      // so there is no second sentence to add (gh #36).
      verdictProblem: null,
    });
  });
});

/**
 * gh #36 — the review handshake, measured on `260831-hardening-d1` / S1
 * (2026-08-31). Two grammars coexist (gate evidence `sign|sign-with-fixlist|refuse`,
 * story review `approve|fixlist|changes`) and the host-facing hint named neither.
 * The host wrote `verdict: "sign"`; `parseReview` fail-closed it to `changes`
 * SILENTLY, which spent the story's second verdict and blocked it. Separately, the
 * attempt-1 reviewer's seven rich `{severity,file,line,claim,evidence,fix}`
 * findings were filtered out by a `typeof f === "string"` test: the verdict
 * survived, the evidence did not.
 *
 * Fail-closed stays. Silent does not.
 */
describe("an unrecognized verdict is NAMED, not swallowed (#36)", () => {
  test("`sign` — the gate vocabulary — is still `changes`, and says so in words", () => {
    const review = parseReview({ verdict: "sign", summary: "the diff is clean", findings: [] }, "");
    expect(review.verdict).toBe("changes");
    expect(review.verdictProblem).toContain("sign");
    expect(review.verdictProblem).toContain("approve|fixlist|changes");
  });

  test("the problem rides in `findings`, so the log and the next attempt both carry it", () => {
    const review = parseReview({ verdict: "sign", summary: "", findings: ["one real finding"] }, "");
    expect(review.findings).toContain("one real finding");
    expect(review.findings.some((f) => f.includes("sign"))).toBe(true);
  });

  test("a verdict inside the enum carries no problem at all", () => {
    for (const verdict of ["approve", "changes"]) {
      const review = parseReview({ verdict, summary: "ok", findings: [] }, "");
      expect(review.verdictProblem).toBeNull();
    }
    expect(parseReview({ verdict: "fixlist", summary: "s", findings: [], fixlist: THREE_DEFECTS }, "").verdictProblem)
      .toBeNull();
  });

  test("an envelope with NO verdict key is named too — that is not a silent `changes`", () => {
    const review = parseReview({ summary: "looks fine to me", findings: [] }, "");
    expect(review.verdict).toBe("changes");
    expect(typeof review.verdictProblem).toBe("string");
    expect(review.verdictProblem).toContain("approve|fixlist|changes");
  });

  test("a declared `fixlist` that fell to `changes` is NOT reported as an unknown verdict", () => {
    // `fixlistProblems` already says that one out loud; two sentences for one
    // downgrade would read as two different faults.
    const review = parseReview({ verdict: "fixlist", summary: "signed", findings: [] }, "");
    expect(review.verdict).toBe("changes");
    expect(review.verdictProblem).toBeNull();
    expect(review.fixlistProblems[0]).toContain("missing or is not an array");
  });
});

describe("structured findings are stringified, never dropped (#36)", () => {
  const RICH = {
    severity: "high",
    file: "src/core/build/review.ts",
    line: 74,
    claim: "the string filter drops every structured finding",
    evidence: "seven objects in, zero strings out",
    fix: "stringify severity + file:line + claim",
  };

  test("a {severity,file,line,claim} object survives with its parts in the text", () => {
    const review = parseReview({ verdict: "changes", summary: "s", findings: [RICH] }, "");
    expect(review.findings).toHaveLength(1);
    const only = review.findings[0] ?? "";
    expect(only).toContain("high");
    expect(only).toContain("src/core/build/review.ts:74");
    expect(only).toContain("the string filter drops every structured finding");
  });

  test("the live run's seven all survive — the count is the whole point", () => {
    const seven = Array.from({ length: 7 }, (_, i) => ({ ...RICH, line: i + 1, claim: `defect ${String(i + 1)}` }));
    const review = parseReview({ verdict: "changes", summary: "s", findings: seven }, "");
    expect(review.findings).toHaveLength(7);
    expect(review.findings.every((f) => f.includes("defect "))).toBe(true);
  });

  test("plain strings still pass through unchanged, and blanks are still dropped", () => {
    const review = parseReview({ verdict: "changes", summary: "s", findings: ["a", "   ", "b"] }, "");
    expect(review.findings).toEqual(["a", "b"]);
  });

  test("an object with no field this recognizes is kept as JSON rather than lost", () => {
    const review = parseReview({ verdict: "changes", summary: "s", findings: [{ wat: 1 }] }, "");
    expect(review.findings).toHaveLength(1);
    expect(review.findings[0]).toContain("wat");
  });

  test("a `findings` that is not an array is kept as one finding, not emptied", () => {
    const review = parseReview({ verdict: "changes", summary: "s", findings: "the whole thing as prose" }, "");
    expect(review.findings).toEqual(["the whole thing as prose"]);
  });

  test("no findings at all is still no findings", () => {
    expect(parseReview({ verdict: "approve", summary: "s", findings: [] }, "").findings).toEqual([]);
    expect(parseReview({ verdict: "approve", summary: "s" }, "").findings).toEqual([]);
  });
});
