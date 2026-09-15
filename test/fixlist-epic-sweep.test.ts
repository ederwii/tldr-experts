/**
 * The run-level fix-list sweep (#163, sub-fix 2).
 *
 * Measured, transcript N (2026-09-05, a Next.js workspace, L358): at the Build
 * gate all 6 `fix-now` findings carried a resolving sha and the 3
 * `defer-with-log` entries read `Resolved: no` — "correct PER STORY", in the host
 * agent's words. Two of those three defects had in fact been closed later in the
 * same run by a DIFFERENT story. Exactly one had genuinely shipped unfixed, and
 * the record could not tell those apart, so a human narrated the difference by
 * hand at the gate.
 *
 * What is tested here, at the leaf:
 *   - a claim whose sha is reachable from the EPIC tip and not from the story's
 *     own branch is recorded as a close BY A LATER STORY, with the closing sha —
 *     spelled `Resolved: yes-on-epic <sha>`, never flattened into the `yes` a
 *     story's own close writes;
 *   - a finding that genuinely shipped unfixed STILL reads unfixed afterwards —
 *     the guard that matters most, and the direction §7 refuses to lie in;
 *   - a sweep that found nothing SAYS it ran (`Swept:`), instead of going quiet
 *     and letting `Resolved: no` go on meaning "correct per story";
 *   - a sweep that could NOT be taken names the reason rather than reporting a
 *     clean sweep (§7, absent-with-reason);
 *   - the sweep never closes anything on inference: a sha that is nowhere, and a
 *     finding whose record names no commit at all, are left open with the reason.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLOSED_ON_EPIC, carriedFindings, isOpen, parseFixlistFile } from "../src/core/build/fixlist.ts";
import { sweepFixlistAgainstEpic } from "../src/core/build/fixlistSweep.ts";
import { renderBuildHandoff, type BuildHandoffParts } from "../src/core/build/handoff.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

// This file spawns a REAL git process: the sweep's whole point is that it asks
// git, not the file. Process cost is a property of the machine (#43).
setDefaultTimeout(spawnTestTimeout());

let scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  scratch = [];
});

/**
 * A repo shaped like a run mid-Build: an epic branch carrying two stories'
 * commits, and `S1`'s own branch carrying only its own.
 *
 * `own` is the commit S1 landed; `later` is the commit a DIFFERENT story landed
 * on the epic afterwards — reachable from the epic tip, and not from `S1`.
 */
function epicRepo(): {
  dir: string; own: string; later: string; epicTip: string;
  branch: string; epicBranch: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "tldrx-sweep-"));
  scratch.push(dir);
  const run = (...args: string[]): string =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  run("init", "-q", "-b", "epic/x");
  run("config", "user.email", "fixture@example.com");
  run("config", "user.name", "tldrx fixture");
  run("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "a.txt"), "base\n", "utf8");
  run("add", "-A");
  run("commit", "-qm", "base");
  run("checkout", "-q", "-b", "story/S1");
  writeFileSync(join(dir, "a.txt"), "s1\n", "utf8");
  run("add", "-A");
  run("commit", "-qm", "s1 work");
  const own = run("rev-parse", "HEAD");
  run("checkout", "-q", "epic/x");
  run("merge", "-q", "--no-ff", "-m", "merge s1", "story/S1");
  writeFileSync(join(dir, "b.txt"), "s2\n", "utf8");
  run("add", "-A");
  run("commit", "-qm", "s2 closes s1's deferred defect");
  const later = run("rev-parse", "HEAD");
  // The LATER story's own branch, so the two-stories-on-one-epic case is reachable:
  // `repo.later` is `story/S2`'s own close and `story/S1`'s epic close, from one tree.
  run("branch", "story/S2", later);
  return { dir, own, later, epicTip: later, branch: "story/S1", epicBranch: "epic/x" };
}

/** One fix-list file, rendered by hand so the test owns exactly what it asserts. */
function fixlistText(
  rows: readonly { n: number; disposition: string; resolved: string; where?: string }[],
): string {
  const lines = ["# Fix list — S1 · a story, round 1", ""];
  for (const row of rows) {
    lines.push(
      `## ${String(row.n)} · finding ${String(row.n)}  [high]`,
      "",
      `Where: ${row.where ?? "src/a.ts"}`,
      "Kind: correctness",
      `Disposition: **${row.disposition}**`,
      `Resolved: ${row.resolved}`,
      "",
    );
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function onDisk(dir: string, text: string): { round: number; path: string; rel: string; findings: ReturnType<typeof parseFixlistFile> } {
  const path = join(dir, "S1-1.md");
  writeFileSync(path, text, "utf8");
  return { round: 1, path, rel: "04-build/fixlist/S1-1.md", findings: parseFixlistFile(text) };
}

const AT = "2026-09-15T00:00:00Z";

describe("a still-open finding is re-checked against the epic tip before the Build gate (#163)", () => {
  test("a claim reachable from the epic and not from the story branch is a close BY A LATER STORY", async () => {
    const repo = epicRepo();
    const text = fixlistText([
      { n: 1, disposition: "defer-with-log", resolved: `claimed-unverified — named \`${repo.later}\`, which is not reachable from \`story/S1\`` },
    ]);
    const fixlist = onDisk(repo.dir, text);
    const swept = await sweepFixlistAgainstEpic(
      { storyId: "S1", repo: "app", repoDir: repo.dir, branch: repo.branch, epicBranch: repo.epicBranch },
      fixlist, text, AT,
    );
    expect(swept.outcome.absence).toBeNull();
    expect(swept.outcome.closed).toEqual([{ n: 1, sha: repo.later }]);
    expect(swept.text).not.toBeNull();
    // The two kinds of close are SPELLED apart: this one is never `Resolved: yes`.
    expect(swept.text).toContain(`Resolved: ${CLOSED_ON_EPIC} ${repo.later}`);
    expect(swept.text).not.toContain("Resolved: yes ");
    const reread = parseFixlistFile(swept.text ?? "");
    expect(reread[0]?.closedOnEpicSha).toBe(repo.later);
    expect(reread[0]?.swept).toContain(repo.epicBranch);
  });

  test("a finding that genuinely shipped unfixed STILL reads unfixed after the sweep (guard)", async () => {
    const repo = epicRepo();
    const text = fixlistText([{ n: 1, disposition: "fix-now", resolved: "no" }]);
    const fixlist = onDisk(repo.dir, text);
    const swept = await sweepFixlistAgainstEpic(
      { storyId: "S1", repo: "app", repoDir: repo.dir, branch: repo.branch, epicBranch: repo.epicBranch },
      fixlist, text, AT,
    );
    expect(swept.outcome.closed).toEqual([]);
    const reread = parseFixlistFile(swept.text ?? text);
    expect(reread[0]?.resolved).toBe(false);
    expect(isOpen(reread[0] as never)).toBe(true);
    // And it does not go quiet: the record says the sweep ran and found nothing.
    expect(reread[0]?.swept).not.toBeNull();
    expect(reread[0]?.swept).toContain("no commit");
  });

  test("a story's OWN close is never re-spelled as an epic close", async () => {
    const repo = epicRepo();
    const text = fixlistText([{ n: 1, disposition: "fix-now", resolved: `yes ${repo.own}` }]);
    const fixlist = onDisk(repo.dir, text);
    const swept = await sweepFixlistAgainstEpic(
      { storyId: "S1", repo: "app", repoDir: repo.dir, branch: repo.branch, epicBranch: repo.epicBranch },
      fixlist, text, AT,
    );
    // Already closed with evidence — not a candidate at all, and nothing is rewritten.
    expect(swept.outcome.closed).toEqual([]);
    expect(swept.text).toBeNull();
  });

  test("a sha that is nowhere closes nothing, and the reason is written down", async () => {
    const repo = epicRepo();
    const nowhere = "0".repeat(40);
    const text = fixlistText([
      { n: 1, disposition: "fix-now", resolved: `claimed-unverified — named \`${nowhere}\`, which is not a commit in repo app` },
    ]);
    const fixlist = onDisk(repo.dir, text);
    const swept = await sweepFixlistAgainstEpic(
      { storyId: "S1", repo: "app", repoDir: repo.dir, branch: repo.branch, epicBranch: repo.epicBranch },
      fixlist, text, AT,
    );
    expect(swept.outcome.closed).toEqual([]);
    const reread = parseFixlistFile(swept.text ?? text);
    expect(isOpen(reread[0] as never)).toBe(true);
    expect(reread[0]?.swept).toContain(nowhere);
  });

  test("a sweep that could not be taken names the reason rather than reporting a clean one", async () => {
    const repo = epicRepo();
    const text = fixlistText([{ n: 1, disposition: "fix-now", resolved: "no" }]);
    const fixlist = onDisk(repo.dir, text);
    const swept = await sweepFixlistAgainstEpic(
      { storyId: "S1", repo: "app", repoDir: repo.dir, branch: repo.branch, epicBranch: "epic/never-cut" },
      fixlist, text, AT,
    );
    expect(swept.outcome.absence).not.toBeNull();
    expect(swept.outcome.absence).toContain("epic/never-cut");
    expect(swept.outcome.closed).toEqual([]);
    const reread = parseFixlistFile(swept.text ?? text);
    expect(reread[0]?.swept).toContain("not taken");
  });

  test("the sweep is idempotent: a second pass over its own output rewrites nothing new", async () => {
    const repo = epicRepo();
    const text = fixlistText([
      { n: 1, disposition: "defer-with-log", resolved: `claimed-unverified — named \`${repo.later}\`, which is not reachable from \`story/S1\`` },
    ]);
    const fixlist = onDisk(repo.dir, text);
    const scope = { storyId: "S1", repo: "app", repoDir: repo.dir, branch: repo.branch, epicBranch: repo.epicBranch };
    const first = await sweepFixlistAgainstEpic(scope, fixlist, text, AT);
    const once = first.text ?? text;
    const second = await sweepFixlistAgainstEpic(
      scope, { ...fixlist, findings: parseFixlistFile(once) }, once, AT,
    );
    expect(second.text ?? once).toBe(once);
  });
});

describe("the `Swept:` line grows the format additively (#163, §7)", () => {
  test("a fix list written before this change still reads, with `swept` null", () => {
    const text = fixlistText([{ n: 1, disposition: "fix-now", resolved: "no" }]);
    const findings = parseFixlistFile(text);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.swept).toBeNull();
    expect(findings[0]?.closedOnEpicSha).toBeNull();
    expect(findings[0]?.claimedSha).toBeNull();
  });

  test("a `Swept:` line is not swallowed into the finding's detail", () => {
    const text = `${fixlistText([{ n: 1, disposition: "fix-now", resolved: "no" }]).trimEnd()}\nSwept: ${AT} — nothing\n\nthe detail\n`;
    const findings = parseFixlistFile(text);
    expect(findings[0]?.swept).toBe(`${AT} — nothing`);
    expect(findings[0]?.detail).toBe("the detail");
  });
});

/**
 * The half the sha-reachability sweep above cannot reach (#163, sub-fix 2).
 *
 * Transcript N's three `defer-with-log` entries read `Resolved: no` — they named
 * NO commit at all, because nobody had claimed one. Two of them were closed later
 * in the same run by a different story, and the host found that out by reading the
 * code. A sweep that only re-checks shas the record already names has nothing to
 * say about those three, which is the exact case the issue measured.
 *
 * So the sweep also asks git the question the human asked the code: did a commit
 * on the EPIC, and not on this story's own branch, change the file this finding
 * cites? That answer is EVIDENCE, and it is not a close — a changed file is not a
 * fixed defect, and writing `Resolved: yes` off it would be §7's dangerous
 * direction with extra steps. It is recorded as a candidate, named, with the
 * commit, and a person decides.
 */
describe("a still-open finding whose FILE a later story changed is named, never closed (#163)", () => {
  test("a later commit touching the cited path is recorded as a candidate, and closes nothing", async () => {
    const repo = epicRepo();
    const text = fixlistText([
      { n: 1, disposition: "defer-with-log", resolved: "no", where: "[src: app:b.txt:1]" },
    ]);
    const fixlist = onDisk(repo.dir, text);
    const swept = await sweepFixlistAgainstEpic(
      { storyId: "S1", repo: "app", repoDir: repo.dir, branch: repo.branch, epicBranch: repo.epicBranch },
      fixlist, text, AT,
    );
    expect(swept.outcome.touched).toEqual([{ n: 1, path: "b.txt", commits: [repo.later] }]);
    // Evidence, never a close: the verdict word does not move.
    expect(swept.outcome.closed).toEqual([]);
    const reread = parseFixlistFile(swept.text ?? text);
    expect(reread[0]?.resolved).toBe(false);
    expect(reread[0]?.closedOnEpicSha).toBeNull();
    // `defer-with-log`, so the predicate that answers "is this still owed" is
    // `carriedFindings`, not `isOpen` — and it still says yes.
    expect(carriedFindings(reread)).toHaveLength(1);
    expect(swept.text).not.toContain("Resolved: yes");
    // …and the record says what was measured, with the commit that carries it.
    expect(reread[0]?.swept).toContain(repo.later);
    expect(reread[0]?.swept).toContain("b.txt");
  });

  test("a path only the story's OWN branch changed is not a candidate (the false-positive guard)", async () => {
    const repo = epicRepo();
    const text = fixlistText([
      { n: 1, disposition: "defer-with-log", resolved: "no", where: "[src: app:a.txt:1]" },
    ]);
    const fixlist = onDisk(repo.dir, text);
    const swept = await sweepFixlistAgainstEpic(
      { storyId: "S1", repo: "app", repoDir: repo.dir, branch: repo.branch, epicBranch: repo.epicBranch },
      fixlist, text, AT,
    );
    expect(swept.outcome.touched).toEqual([]);
    const reread = parseFixlistFile(swept.text ?? text);
    expect(reread[0]?.swept).toContain("a.txt");
    expect(reread[0]?.swept).toContain("no later commit");
  });

  test("a finding whose `Where:` carries no citable path says so, rather than probing nothing quietly", async () => {
    const repo = epicRepo();
    const text = fixlistText([
      { n: 1, disposition: "fix-now", resolved: "no", where: "(not stated)" },
    ]);
    const fixlist = onDisk(repo.dir, text);
    const swept = await sweepFixlistAgainstEpic(
      { storyId: "S1", repo: "app", repoDir: repo.dir, branch: repo.branch, epicBranch: repo.epicBranch },
      fixlist, text, AT,
    );
    expect(swept.outcome.touched).toEqual([]);
    const reread = parseFixlistFile(swept.text ?? text);
    expect(reread[0]?.swept).toContain("cites no file in repo app");
  });
});

/**
 * What of the sweep reaches the gate document, and what deliberately does not.
 *
 * `renderBuildHandoff` places rows and judges nothing; the judgement is in
 * `fixlistSweep.ts`. Pinned here: the three answers that need a human land in
 * `## Unknowns` with a citation, and a sweep that ran clean adds no bullet at all
 * — a document that grew a line per story per run would bury the ones that matter.
 */
describe("the sweep's reportable answers reach `## Unknowns` (#163)", () => {
  const BASE: BuildHandoffParts = {
    runId: "260915-x", stageId: "build", model: null, costUsd: 0, budgetUsd: 8,
    at: AT, outcomes: [], epics: [],
  };
  const REL = "04-build/fixlist/S1-1.md";

  function unknowns(parts: Partial<BuildHandoffParts>): string {
    const text = renderBuildHandoff({ ...BASE, ...parts });
    const from = text.indexOf("## Unknowns\n");
    if (from === -1) return "";
    const rest = text.slice(from + "## Unknowns\n".length);
    const ends = rest.indexOf("\n## ");
    return ends === -1 ? rest : rest.slice(0, ends);
  }

  const CLEAN = {
    storyId: "S1", rel: REL, epicTip: "a".repeat(40), closed: [], touched: [], unmeasured: [],
    examined: 3, absence: null,
  } as const;

  test("a close a LATER story landed is a bullet naming the story, the finding and the sha", () => {
    const text = unknowns({ sweep: [{ ...CLEAN, closed: [{ n: 2, sha: "b".repeat(40) }] }] });
    expect(text).toContain("S1");
    expect(text).toContain("#2");
    expect(text).toContain("b".repeat(40));
    expect(text).toContain(`[src: ${REL}:1]`);
  });

  test("a file a later story changed is a bullet that says a changed file is NOT a closed defect", () => {
    const text = unknowns({
      sweep: [{ ...CLEAN, touched: [{ n: 3, path: "src/a.ts", commits: ["c".repeat(40)] }] }],
    });
    expect(text).toContain("#3");
    expect(text).toContain("src/a.ts");
    expect(text).toContain("c".repeat(40));
    expect(text).toContain("a changed file is not a closed defect");
  });

  test("a sweep that could not be taken is a bullet, and never reads as a clean one", () => {
    const text = unknowns({
      sweep: [{ ...CLEAN, epicTip: null, examined: 1, absence: "`epic/x` could not be resolved" }],
    });
    expect(text).toContain("could not be taken");
    expect(text).toContain("`epic/x` could not be resolved");
  });

  test("a sweep that ran and found nothing adds NO bullet — only the fix-list file records it", () => {
    expect(unknowns({ sweep: [CLEAN] })).toBe(unknowns({ sweep: [] }));
  });
});

/**
 * A probe git REFUSED is not a probe that came back empty (#163 review, §7).
 *
 * `commitsTouching` answers with a list, and an empty list used to mean two
 * different things at once: nothing touched the path, or git would not answer the
 * question — an unresolvable story ref, a repo that moved. Written down, both read
 * as "no later commit changed this", which is a measurement nobody took wearing
 * the words of one that was. Absent-with-reason, not a confident zero.
 */
describe("a probe git refused says so, instead of reading as a clean one (#163)", () => {
  test("an unresolvable story ref is named as a failed measurement, not as `no later commit`", async () => {
    const repo = epicRepo();
    const text = fixlistText([
      { n: 1, disposition: "defer-with-log", resolved: "no", where: "[src: app:b.txt:1]" },
    ]);
    const fixlist = onDisk(repo.dir, text);
    const swept = await sweepFixlistAgainstEpic(
      { storyId: "S1", repo: "app", repoDir: repo.dir, branch: "story/never-cut", epicBranch: repo.epicBranch },
      fixlist, text, AT,
    );
    expect(swept.outcome.touched).toEqual([]);
    expect(swept.outcome.unmeasured).toHaveLength(1);
    expect(swept.outcome.unmeasured[0]?.n).toBe(1);
    expect(swept.outcome.unmeasured[0]?.path).toBe("b.txt");
    expect(swept.outcome.unmeasured[0]?.reason).not.toBe("");
    const reread = parseFixlistFile(swept.text ?? text);
    expect(reread[0]?.swept).toContain("could not be measured");
    // The sentence a clean probe writes must NOT be the sentence a refused one writes.
    expect(reread[0]?.swept).not.toContain("no later commit");
  });

  test("a refused probe is a `## Unknowns` bullet naming git's own reason", () => {
    const text = renderBuildHandoff({
      runId: "260915-x", stageId: "build", model: null, costUsd: 0, budgetUsd: 8,
      at: AT, outcomes: [], epics: [],
      sweep: [{
        storyId: "S1", rel: "04-build/fixlist/S1-1.md", epicTip: "a".repeat(40),
        closed: [], touched: [], examined: 1, absence: null,
        unmeasured: [{ n: 1, path: "b.txt", reason: "unknown revision story/never-cut" }],
      }],
    });
    expect(text).toContain("could not be measured");
    expect(text).toContain("unknown revision story/never-cut");
    expect(text).toContain("b.txt");
  });
});

/**
 * Two stories on ONE epic, which is the shape the whole sweep exists for: the same
 * commit is `story/S2`'s own close and `story/S1`'s epic close, and the record has
 * to say which it is from whose side it is read.
 */
describe("the same commit reads differently from each story on the epic (#163)", () => {
  test("`story/S2`'s own close is not re-spelled as an epic close when S2's list is swept", async () => {
    const repo = epicRepo();
    const claim = `claimed-unverified — named \`${repo.later}\`, which is not reachable from \`story/S9\``;
    const text = fixlistText([{ n: 1, disposition: "defer-with-log", resolved: claim }]);
    const fixlist = onDisk(repo.dir, text);
    const fromS2 = await sweepFixlistAgainstEpic(
      { storyId: "S2", repo: "app", repoDir: repo.dir, branch: "story/S2", epicBranch: repo.epicBranch },
      fixlist, text, AT,
    );
    expect(fromS2.outcome.closed).toEqual([]);
    expect(fromS2.text).not.toContain(CLOSED_ON_EPIC);
    expect(parseFixlistFile(fromS2.text ?? text)[0]?.swept).toContain("S2's own close");
    // …and the SAME commit, read from S1's side, is an epic close.
    const fromS1 = await sweepFixlistAgainstEpic(
      { storyId: "S1", repo: "app", repoDir: repo.dir, branch: repo.branch, epicBranch: repo.epicBranch },
      fixlist, text, AT,
    );
    expect(fromS1.outcome.closed).toEqual([{ n: 1, sha: repo.later }]);
  });
});
