/**
 * A story stuck after a person's reopen, measured live (gh #327, gh #329) — and
 * the owner decision that answers both: a full automatic headless fix round with
 * an AUDITED auto-close (Slack q_mu23trkg8ae9c999, answered by Alan, authority
 * owner-decision, choice "A: ronda + auto-cierre").
 *
 * Four defects, one test each, in the order a story meets them:
 *
 *   1. a re-reviewed story's `changes` requeue was never consumed — the story
 *      parked at `review` with attempts left, and its dependent never started;
 *   2. a headless `fixlist` with an open `fix-now` parked at `review` — no
 *      developer was handed the list, no reviewer was shown it, nothing closed it;
 *   3. the auto-close must close ONLY what the approving reviewer was shown — a
 *      finding that reached the file after its prompt was rendered stays open;
 *   4. a story `blocked` on an `approve` whose fix list was then closed by hand had
 *      no verb that settled it — the re-run settles it `done` and spawns nothing.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runNext, type NextOptions } from "../src/core/facilitator/runNext.ts";
import { EventLog } from "../src/core/events/EventLog.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { reject } from "../src/core/run/gates.ts";
import {
  AUTO_CLOSED_MARK, CLAIMED_UNVERIFIED, autoCloseShown, isOpen, markUnverified, parseFixFindings, parseFixlistFile,
  renderFixlist,
} from "../src/core/build/fixlist.ts";
import { FIX_ROUND_REVIEW_HEADING } from "../src/core/build/prompts.ts";
import { makeBuildWorkspace, type BuildWorkspace, type BuildWorkspaceOptions } from "./fixtures/build/workspace.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

setDefaultTimeout(spawnTestTimeout());

const ORIGINAL_PATH = process.env.PATH ?? "";
const FAKE_KEYS = [
  "FAKE_BUILD_WRITE", "FAKE_BUILD_VERDICTS", "FAKE_BUILD_COST", "FAKE_BUILD_STATE",
  "FAKE_BUILD_ARGV_LOG", "FAKE_BUILD_PROMPT_DIR", "FAKE_BUILD_FAIL", "FAKE_BUILD_FAIL_REASON",
  "FAKE_BUILD_FIXLIST", "FAKE_BUILD_REVIEWER_APPEND",
] as const;

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

/** W1 = [S1], W2 = [S2 depends_on S1] — the shape #327 measured S3/S4 stuck behind. */
const TWO_WAVES: BuildWorkspaceOptions = {
  stories: [
    { id: "S1", epic: "E1", title: "First story" },
    { id: "S2", epic: "E1", title: "Second, in the next wave", dependsOn: ["S1"] },
  ],
  epics: [{ id: "E1", stories: ["S1", "S2"], branch: "epic/e1" }],
  waves: [["S1"], ["S2"]],
};

/** Two `fix-now` findings and one deferred one — the deferred one is never shown, never closed. */
const FINDINGS: readonly Record<string, unknown>[] = [
  {
    n: 1, severity: "high", kind: "correctness",
    finding: "Concurrent double-confirm mints two sessions",
    where: "`src/auth.ts:74` [src: app:s1.txt:1]",
    disposition: "fix-now",
    detail: "Two requests carrying the same code both pass the check and both mint a session.",
    do_not: ["add a lockout policy; that is a product decision"],
  },
  {
    n: 2, severity: "high", kind: "correctness",
    finding: "Non-atomic confirm",
    where: "`src/auth.ts:88` [src: app:s1.txt:1]",
    disposition: "fix-now",
    detail: "The read and the write are two statements with no transaction around them.",
  },
  {
    n: 3, severity: "medium", kind: "correctness",
    finding: "No OTP attempt limiter",
    disposition: "defer-with-log",
    detail: "A lockout policy is a product call; logged for the owner.",
  },
];

function workspace(options: BuildWorkspaceOptions = ONE_STORY): BuildWorkspace {
  const made = makeBuildWorkspace(options);
  open.push(made);
  process.env.PATH = made.binDir;
  process.env.FAKE_BUILD_STATE = made.statePath;
  process.env.FAKE_BUILD_COST = "0";
  return made;
}

function next(
  ws: BuildWorkspace,
  overrides: Partial<NextOptions> = {},
): Promise<{ code: number; lines: readonly string[] }> {
  return runNext({
    root: ws.root, dryRun: false, mode: "headless", yolo: false, actor: "alan", at: "2026-08-29T09:00:00Z",
    ...overrides,
  });
}

function story(ws: BuildWorkspace, id: string): string {
  return readFileSync(join(ws.planDir, "stories", `${id}.md`), "utf8");
}

function events(ws: BuildWorkspace): readonly { type: string; payload: Record<string, unknown> }[] {
  return EventLog.forRun(ws.runDir).read() as never;
}

function roles(ws: BuildWorkspace, id: string): readonly unknown[] {
  return events(ws).filter((e) => e.type === "agent.spawned" && e.payload.story === id).map((e) => e.payload.role);
}

function reenter(ws: BuildWorkspace, note: string): void {
  reject(RunStore.open(ws.runDir), { root: ws.root, actor: "alan", at: "2026-08-29T10:00:00Z", note });
}

function fixlistPath(ws: BuildWorkspace): string {
  return join(ws.runDir, "04-build", "fixlist", "S1-1.md");
}

function storyHead(ws: BuildWorkspace): string {
  return execFileSync("git", ["rev-parse", `story/${ws.runId}/S1`], { cwd: ws.repoDir, encoding: "utf8" }).trim();
}

function isAncestor(ws: BuildWorkspace, sha: string): boolean {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", sha, `story/${ws.runId}/S1`], {
      cwd: ws.repoDir, stdio: ["ignore", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------

describe("a re-reviewed story's `changes` is consumed, not parked (gh #327, rereview half)", () => {
  for (const parallel of [1, 2]) {
    test(`--parallel ${String(parallel)}: the second developer attempt runs and the dependent starts`, async () => {
      const ws = workspace(TWO_WAVES);
      const promptDir = join(ws.root, "prompts");
      process.env.FAKE_BUILD_PROMPT_DIR = promptDir;
      // S1's FIRST reviewer dies; the re-review asks for changes; the next approves.
      process.env.FAKE_BUILD_FAIL_REASON = "Reached maximum budget ($0.26)";
      process.env.FAKE_BUILD_FAIL = "reviewer:S1#1";
      process.env.FAKE_BUILD_VERDICTS = JSON.stringify({ S1: ["changes", "approve"] });
      process.env.FAKE_BUILD_WRITE = JSON.stringify({ "S1#2": { "s1.txt": "S1 fixed\n" } });

      await next(ws, { parallel });
      expect(story(ws, "S1")).toContain("status: review");

      reenter(ws, "the reviewer died");
      const again = await next(ws, { parallel, at: "2026-08-29T10:05:00Z" });

      const said = again.lines.join("\n");
      expect(said).toContain("re-running the REVIEW only");
      // The defect: the requeue the re-review earned was never consumed.
      expect(readdirSync(promptDir).filter((n) => n.startsWith("developer-S1")).sort())
        .toEqual(["developer-S1-1.md", "developer-S1-2.md"]);
      expect(story(ws, "S1")).toContain("status: done");
      expect(events(ws).some((e) => e.type === "task.started" && e.payload.story === "S2")).toBe(true);
      expect(story(ws, "S2")).toContain("status: done");
    }, 120_000);
  }
});

describe("a headless fix list buys its fix round in the same process (gh #327, fixlist half)", () => {
  test("the developer gets the list, the reviewer is shown it, and its approve closes what it was shown", async () => {
    const ws = workspace();
    const promptDir = join(ws.root, "prompts");
    process.env.FAKE_BUILD_PROMPT_DIR = promptDir;
    process.env.FAKE_BUILD_VERDICTS = JSON.stringify({ S1: ["fixlist", "approve"] });
    process.env.FAKE_BUILD_FIXLIST = JSON.stringify({ S1: FINDINGS });
    process.env.FAKE_BUILD_WRITE = JSON.stringify({ "S1#2": { "s1.txt": "S1 fixed\n" } });

    const outcome = await next(ws);

    expect(roles(ws, "S1")).toEqual(["developer", "reviewer", "developer", "reviewer"]);
    // The fix-round developer is handed the list.
    const developer = readFileSync(join(promptDir, "developer-S1-2.md"), "utf8");
    expect(developer).toContain("## Fix list");
    expect(developer).toContain("1. **Concurrent double-confirm mints two sessions** [high]");
    expect(developer).toContain("Do NOT: add a lockout policy; that is a product decision");
    // The fix-round reviewer is SHOWN each open finding, and the rule.
    const reviewer = readFileSync(join(promptDir, "reviewer-S1-2.md"), "utf8");
    expect(reviewer).toContain(FIX_ROUND_REVIEW_HEADING);
    expect(reviewer).toContain("Concurrent double-confirm mints two sessions");
    expect(reviewer).toContain("Non-atomic confirm");
    expect(reviewer.split(FIX_ROUND_REVIEW_HEADING)[1]?.split("\n## ")[0]).not.toContain("No OTP attempt limiter");
    // The first reviewer had no fix list to be shown.
    expect(readFileSync(join(promptDir, "reviewer-S1-1.md"), "utf8")).not.toContain(FIX_ROUND_REVIEW_HEADING);

    expect(story(ws, "S1")).toContain("status: done");
    const sha = storyHead(ws);
    const findings = parseFixlistFile(readFileSync(fixlistPath(ws), "utf8"));
    for (const n of [1, 2]) {
      const f = findings.find((x) => x.n === n);
      expect(f?.resolved).toBe(true);
      expect(f?.resolvedSha).toBe(sha);
    }
    expect(isAncestor(ws, sha)).toBe(true);
    // The deferred finding was never shown and is never closed.
    expect(findings.find((x) => x.n === 3)?.resolved).toBe(false);
    const text = readFileSync(fixlistPath(ws), "utf8");
    expect(text).toContain(`Resolved: yes ${sha} — ${AUTO_CLOSED_MARK}`);
    expect(text).toContain("fake-reviewer-S1");
    expect(outcome.lines.join("\n")).toContain(AUTO_CLOSED_MARK);
  }, 120_000);
});

describe("the auto-close closes only what the approving reviewer was shown (gh #327)", () => {
  test("a finding that reached the file after the prompt was rendered stays open, and the story blocks on it", async () => {
    const ws = workspace();
    process.env.FAKE_BUILD_VERDICTS = JSON.stringify({ S1: ["fixlist", "approve"] });
    process.env.FAKE_BUILD_FIXLIST = JSON.stringify({ S1: [FINDINGS[0]] });
    process.env.FAKE_BUILD_WRITE = JSON.stringify({ "S1#2": { "s1.txt": "S1 fixed\n" } });
    process.env.FAKE_BUILD_REVIEWER_APPEND = JSON.stringify({
      "S1#2": {
        path: fixlistPath(ws),
        text: "\n## 7 · A finding written after the reviewer was briefed  [high]\n\n"
          + "Where: (not stated)\nKind: correctness\nDisposition: **fix-now**\nResolved: no\n",
      },
    });

    await next(ws);

    const findings = parseFixlistFile(readFileSync(fixlistPath(ws), "utf8"));
    expect(findings.find((x) => x.n === 1)?.resolvedSha).toBe(storyHead(ws));
    expect(findings.find((x) => x.n === 7)?.resolved).toBe(false);
    expect(story(ws, "S1")).toContain("status: blocked");
    const log = readFileSync(join(ws.runDir, "04-build", "log", "S1.md"), "utf8");
    expect(log).toContain("#7 · A finding written after the reviewer was briefed");
  }, 120_000);
});

describe("a fix list closed by hand settles its blocked story with no spawn (gh #329)", () => {
  test("`blocked` on an `approve`, every `fix-now` closed with a reachable sha, re-run → `done`, zero spawns", async () => {
    const ws = workspace();
    // #329's path, through the doors a host really has: S1 merged, the host's
    // reviewer signs a fix list, the host's re-review approves, and the story
    // settles `blocked` because the file still says `Resolved: no`.
    process.env.FAKE_BUILD_FAIL_REASON = "Reached maximum budget ($1)";
    process.env.FAKE_BUILD_FAIL = "reviewer:S1#1";
    await next(ws, { mode: "prepare" });
    writeFileSync(join(ws.root, ".tldrx", "worktrees", "app", `${ws.runId}-S1`, "s1.txt"), "S1\n", "utf8");
    writeFileSync(join(ws.runDir, ".agent", "build", "S1", "result.json"), JSON.stringify({
      outputs: ["s1.txt"], questions_asked: [], notes: "", cost_usd: 0, session_id: "sess-author-1",
    }), "utf8");
    await next(ws, { mode: "commit", at: "2026-08-29T09:30:00Z" });
    await next(ws, { mode: "prepare", at: "2026-08-29T09:40:00Z" });
    const reviewResult = join(ws.runDir, ".agent", "build", "S1", "review", "result.json");
    writeFileSync(reviewResult, JSON.stringify({
      verdict: "fixlist", summary: "signed, with one defect", findings: [], fixlist: [FINDINGS[0]],
    }), "utf8");
    await next(ws, { mode: "commit", review: true, at: "2026-08-29T09:50:00Z" });
    await next(ws, { mode: "prepare", review: true, at: "2026-08-29T09:55:00Z" });
    writeFileSync(reviewResult, JSON.stringify({ verdict: "approve", summary: "re-read", findings: [] }), "utf8");
    await next(ws, { mode: "commit", review: true, at: "2026-08-29T09:58:00Z" });
    expect(story(ws, "S1")).toContain("status: blocked");

    // The person does exactly what the refusal said: closes the line with the sha.
    const sha = storyHead(ws);
    const path = fixlistPath(ws);
    writeFileSync(path, readFileSync(path, "utf8").replace("Resolved: no", `Resolved: yes ${sha}`), "utf8");
    reenter(ws, "the fix list is closed");
    process.env.FAKE_BUILD_ARGV_LOG = join(ws.root, "argv.jsonl");

    const again = await next(ws, { at: "2026-08-29T10:05:00Z" });

    expect(story(ws, "S1")).toContain("status: done");
    expect(existsSync(join(ws.root, "argv.jsonl"))).toBe(false);
    expect(again.lines.join("\n")).not.toContain("is already `blocked` — left alone");
    const done = events(ws).filter((e) => e.type === "task.done" && e.payload.story === "S1").at(-1);
    expect(done?.payload.status).toBe("done");
    expect(done?.payload.verdict).toBe("approve");
  }, 120_000);
});

describe("an auto-closed line is the existing grammar, and stays reopenable (gh #327, §7)", () => {
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  const text = renderFixlist({
    storyId: "S1", title: "First story", round: 1, attempt: 1, maxAttempts: 2,
    diff: "git diff a...b", commit: SHA, summary: "",
    findings: parseFixFindings(FINDINGS).findings,
  });

  test("it reads back as `Resolved: yes <sha>` — the provenance is prose the parser already tolerates", () => {
    const shown = parseFixlistFile(text).filter(isOpen);
    const { text: closed, closed: ns } = autoCloseShown(text, shown, SHA, "reviewer session sess-1, attempt 1, run r");
    expect(ns).toEqual([1, 2]);
    const read = parseFixlistFile(closed);
    expect(read.filter(isOpen)).toEqual([]);
    expect(read.find((f) => f.n === 1)?.resolvedSha).toBe(SHA);
    expect(closed).toContain(`Resolved: yes ${SHA} — ${AUTO_CLOSED_MARK} (reviewer session sess-1, attempt 1, run r)`);
    // The deferred finding was never open, so it was never closable.
    expect(read.find((f) => f.n === 3)?.resolved).toBe(false);
  });

  test("a shown finding re-worded on disk since the prompt is not closed — same number is not enough", () => {
    const shown = parseFixlistFile(text).filter(isOpen);
    const edited = text.replace("## 2 · Non-atomic confirm", "## 2 · Non-atomic confirm AND a lost update");
    const { closed } = autoCloseShown(edited, shown, SHA, "p");
    expect(closed).toEqual([1]);
  });

  test("`markUnverified` reopens an auto-closed line exactly as it reopens a typed one", () => {
    const shown = parseFixlistFile(text).filter(isOpen);
    const { text: closed } = autoCloseShown(text, shown, SHA, "p");
    const reopened = markUnverified(closed, 1, "named a sha that is not reachable");
    const f = parseFixlistFile(reopened).find((x) => x.n === 1);
    expect(f !== undefined && isOpen(f)).toBe(true);
    expect(reopened).toContain(`Resolved: ${CLAIMED_UNVERIFIED} — named a sha that is not reachable`);
  });
});
