/**
 * gh #218 — a fix list parked at `review` with an open `fix-now` finding, whose
 * remaining finding is later dispositioned away from `fix-now` by hand (not
 * through the audited auto-close), must settle `done` with no agent spawned —
 * not be handed a fresh plain developer bundle as if the story had never been
 * reviewed.
 *
 * Measured mechanism (gh #218): `fixlistFor`'s unnamed door
 * (`openFixlist`) returns `null` once the latest round has 0 open findings —
 * correctly, it is not to be re-rendered — but `--prepare` treated `null` as
 * "no fix list ever happened" and fell through to a plain developer bundle,
 * and a developer would then run for nothing and `--commit` would re-run the
 * whole DoD over an unchanged tree.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runNext, type NextOptions } from "../src/core/facilitator/runNext.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { EXIT_USAGE } from "../src/cli/exitCodes.ts";
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

const ONE_FIX_NOW_FINDING: readonly Record<string, unknown>[] = [
  {
    n: 1, severity: "high", kind: "correctness",
    finding: "Concurrent double-confirm mints two sessions",
    disposition: "fix-now",
    detail: "Two requests carrying the same code both pass the check and both mint a session.",
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

function fixlistPath(ws: BuildWorkspace): string {
  return join(ws.runDir, "04-build", "fixlist", "S1-1.md");
}

function pendingJson(ws: BuildWorkspace): Record<string, unknown> | null {
  const path = join(ws.runDir, ".agent", "build", "S1", "pending.json");
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

/**
 * Gets S1 to `status: review` behind a fix list with exactly one OPEN
 * `fix-now` finding — the reviewer signed `fixlist`, not `approve`, so the
 * story is owed a developer round and nothing has settled it yet. The
 * developer half is host-run (`--prepare` hands out the bundle, the test
 * plays the author), and the reviewer half is spawned by the framework
 * itself inline with `--commit` — `attended_by` is not `host` in this
 * fixture, so the reviewer is never handed off (`reviewAndSettle`).
 */
async function parkAtReviewBehindOpenFixlist(ws: BuildWorkspace): Promise<void> {
  process.env.FAKE_BUILD_VERDICTS = JSON.stringify({ S1: ["fixlist"] });
  process.env.FAKE_BUILD_FIXLIST = JSON.stringify({ S1: ONE_FIX_NOW_FINDING });
  await next(ws, { mode: "prepare" });
  writeFileSync(join(ws.root, ".tldrx", "worktrees", "app", `${ws.runId}-S1`, "s1.txt"), "S1\n", "utf8");
  writeFileSync(join(ws.runDir, ".agent", "build", "S1", "result.json"), JSON.stringify({
    outputs: ["s1.txt"], questions_asked: [], notes: "", cost_usd: 0, session_id: "sess-author-1",
  }), "utf8");
  await next(ws, { mode: "commit", at: "2026-08-29T09:30:00Z" });
  expect(story(ws, "S1")).toContain("status: review");
  expect(readFileSync(fixlistPath(ws), "utf8")).toContain("Disposition: **fix-now**");
}

describe("a fix list dispositioned away from fix-now by hand settles review with no spawn (gh #218)", () => {
  test("`--prepare` after the last open finding is re-routed away from fix-now settles `done`, no bundle", async () => {
    const ws = workspace();
    await parkAtReviewBehindOpenFixlist(ws);
    const before = pendingJson(ws);

    // The host re-routes the last remaining finding away from `fix-now` by
    // hand — NOT through `Resolved: yes <sha>`, exactly the shape #218
    // measured: every finding in the round is now dispositioned away from
    // `fix-now`, and nothing yet has told the framework the round is spent.
    const path = fixlistPath(ws);
    writeFileSync(path, readFileSync(path, "utf8").replace("Disposition: **fix-now**", "Disposition: **defer-with-log**"), "utf8");

    const prepared = await next(ws, { mode: "prepare", at: "2026-08-29T10:00:00Z" });

    // RED (pre-fix): this used to write a fresh, plain developer bundle for a
    // story nothing faulted — a NEW `pending.json`, carrying no `fixlist` key,
    // as if S1 had never been reviewed — and the story stayed `review`
    // forever waiting on a developer turn nobody owed.
    expect(pendingJson(ws)).toEqual(before);
    expect(story(ws, "S1")).toContain("status: done");
    expect(prepared.lines.join("\n")).toContain("settles `done` with no agent spawned");
  }, 120_000);
});

describe("`--fixlist <path>` naming a file with 0 open findings is a refusal, not a bundle (gh #218)", () => {
  test("a story never reviewed, with a stray 0-open fix list on disk, is refused by name and count", async () => {
    const ws = workspace();
    // No review has happened yet — `closedFixlistCandidates` never fires (S1
    // is `todo`, not `review`/`blocked`) — but a fix-list-shaped file already
    // sits on disk with nothing open, and the operator names it explicitly.
    const dir = join(ws.runDir, "04-build", "fixlist");
    const path = join(dir, "S1-1.md");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path,
      "# Fix list — S1 · First story, round 1\n\n"
      + "## 1 · Stray finding routed away already  [high]\n\n"
      + "Where: (not stated)\nKind: correctness\nDisposition: **defer-with-log**\nResolved: no\n",
      "utf8",
    );

    const prepared = await next(ws, { mode: "prepare", fixlist: "04-build/fixlist/S1-1.md" });

    // RED (pre-fix, pre-merge review): this threw out of `fixlistFor`, was
    // caught by `failed()` and read back as a STAGE failure — exit 5
    // (EXIT_AGENT_FAILED), `run.yml`'s stage stamped `status: failed`, and the
    // NEXT `tldrx next` printed "retrying … (cost already spent is not
    // refunded)" though nothing was ever spent. It must be exit 1
    // (EXIT_USAGE, family "usage / nothing-behind-it") with the stage left
    // exactly as it was.
    expect(prepared.code).toBe(EXIT_USAGE);
    expect(prepared.lines.join("\n")).toContain("0 `fix-now` finding(s)");
    expect(prepared.lines.join("\n")).toContain("04-build/fixlist/S1-1.md");
    expect(existsSync(join(ws.runDir, ".agent", "build", "S1", "pending.json"))).toBe(false);
    const stage = RunStore.open(ws.runDir).run.phases[0]?.stages[0];
    expect(stage?.status).not.toBe("failed");

    // The next invocation must not read this as a retry of a failed stage.
    const again = await next(ws, { mode: "prepare", at: "2026-08-29T10:05:00Z" });
    expect(again.lines.join("\n")).not.toContain("cost already spent is not refunded");
  }, 120_000);
});

describe("a fix list the parse could not fully read must never settle done (gh #218, correctness half)", () => {
  test("a typo'd Disposition silently drops the live finding — must hold, not settle done", async () => {
    const ws = workspace();
    await parkAtReviewBehindOpenFixlist(ws);

    // Reviewer-measured repro: `**fix-now**` typo'd to `**fix-noww**`.
    // `parseFixlistFile` cannot recognise it as a disposition, so the finding
    // is silently DROPPED from `findings` (by design — see its own doc) —
    // `openFindings(...).length` reads 0, indistinguishable from "every
    // finding was genuinely dispositioned away", unless the parse's own
    // account of what it could not read is consulted too.
    const path = fixlistPath(ws);
    writeFileSync(path, readFileSync(path, "utf8").replace("Disposition: **fix-now**", "Disposition: **fix-noww**"), "utf8");

    const prepared = await next(ws, { mode: "prepare", at: "2026-08-29T10:00:00Z" });

    // RED (pre-fix, pre-merge review): `closedFixlistCandidates` trusted
    // `openFindings(fixlist.findings).length === 0` on its own and settled
    // the story `done` with no spawn and no re-review — a live correctness
    // defect reported as shipped and proven.
    expect(story(ws, "S1")).not.toContain("status: done");
    expect(prepared.lines.join("\n")).not.toContain("settles `done`");
    const said = prepared.lines.join("\n");
    expect(said).toContain("could not be read as a finding");
    expect(said).toContain("Concurrent double-confirm mints two sessions");
  }, 120_000);

  test("an empty/truncated round file reads as 0 findings — must hold, not settle done", async () => {
    const ws = workspace();
    await parkAtReviewBehindOpenFixlist(ws);

    // A round file a crash or a disk-full write left empty. `latestFixlist`
    // (unlike `readFixlistAt`) has no "0 findings means not a fix list"
    // guard, so this reads as `findings: []` exactly like a fully-resolved
    // round — the same silent zero as the typo case, from a different cause.
    writeFileSync(fixlistPath(ws), "", "utf8");

    const prepared = await next(ws, { mode: "prepare", at: "2026-08-29T10:00:00Z" });

    expect(story(ws, "S1")).not.toContain("status: done");
    expect(prepared.lines.join("\n")).not.toContain("settles `done`");
    expect(prepared.lines.join("\n")).toContain("could not be read as a finding");
  }, 120_000);
});
