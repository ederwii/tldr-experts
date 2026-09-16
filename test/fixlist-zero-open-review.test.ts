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

    expect(prepared.code).not.toBe(0);
    expect(prepared.lines.join("\n")).toContain("0 `fix-now` finding(s)");
    expect(prepared.lines.join("\n")).toContain("04-build/fixlist/S1-1.md");
    expect(existsSync(join(ws.runDir, ".agent", "build", "S1", "pending.json"))).toBe(false);
  }, 120_000);
});
