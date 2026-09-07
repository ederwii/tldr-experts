/**
 * `tldrx ship` — open a PR from the run's epic branch, with the handoff as the
 * body (issue #15).
 *
 * The gap: the pipeline ended at "merge by hand". A finished epic sat on
 * `epic/<slug>` with a handoff beside it and nothing carried either one to a PR.
 *
 * Two things these tests are careful about.
 *
 * **Nothing here runs the real `gh`.** The unit cases drive a recording
 * `ShipTransport`, which is also the only way to assert the argument shape of a
 * command we must not run. The one end-to-end case puts a STUB `gh` first on
 * PATH, in a throwaway workspace with a throwaway bare `origin` — so the CLI is
 * exercised whole, and the binary it reaches is a shell script that writes its
 * argv to a file.
 *
 * **Every refusal is a sentence, not a stack.** A missing epic branch, a missing
 * remote, an absent `gh` and an unpushed branch are all ordinary situations, and
 * the assertions below check both the exit code and that stderr carries no
 * exception text.
 *
 * **The handoff fixture is a REAL Build handoff** (issue #167). It is rendered by
 * `renderBuildHandoff`, not typed out here, because the whole finding behind #167
 * is that a Build handoff is a GATE document — it opens `Blocked on: **human
 * approval**` and carries operator instructions — and a hand-written stand-in
 * would have let the PR body be tested against a document Build never writes.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";
import { runStories, shipRun, type ShipTransport } from "../src/core/run/ship.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { renderBuildHandoff } from "../src/core/build/handoff.ts";
import type { StoryOutcome } from "../src/core/build/outcome.ts";
import { renderFixlist, type FixFinding } from "../src/core/build/fixlist.ts";
import { EXIT_GATE_REFUSED, EXIT_NOT_FOUND, EXIT_OK } from "../src/cli/exitCodes.ts";
import { makeBuildWorkspace, type BuildWorkspace, type BuildWorkspaceOptions } from "./fixtures/build/workspace.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

setDefaultTimeout(spawnTestTimeout());

const BIN = join(FRAMEWORK_ROOT, "bin", "tldrx.ts");
const ORIGINAL_PATH = process.env.PATH ?? "";

let open: BuildWorkspace[] = [];

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  for (const ws of open) ws.dispose();
  open = [];
});

const ONE: BuildWorkspaceOptions = {
  stories: [{ id: "S1", epic: "E1", title: "First story" }],
  epics: [{ id: "E1", stories: ["S1"], branch: "epic/e1" }],
  waves: [["S1"]],
};

/** One `StoryOutcome`, with everything the handoff does not read left inert. */
function outcome(id: string, title: string, status: "done" | "review"): StoryOutcome {
  return {
    id, title, status,
    wave: "W1",
    repo: "app",
    epic: "E1",
    epicBranch: "epic/e1",
    branch: `story/${id}`,
    attempts: 1,
    dod: [{ command: "npm run test", exitCode: 0, timedOut: false, tail: "ok" }],
    commit: status === "done" ? "abc1234" : null,
    merged: status === "done",
    carried: status === "done" ? 3 : 0,
    conflicts: [],
    verdict: status === "done" ? "approve" : "changes",
    developerError: null,
    reviewSummary: "",
    reviewFindings: [],
    reviewRel: `04-build/log/${id}.md`,
    reason: status === "done" ? null : "the reviewer asked for changes",
    rescued: null,
    cost_usd: 0.21,
  };
}

/**
 * The document `04-build` really writes: S1 done, S2 not, and a `## Gate` section
 * whose first line is `Blocked on: **human approval**`.
 */
const HANDOFF = renderBuildHandoff({
  runId: "260829-build",
  stageId: "build",
  model: "sonnet",
  costUsd: 0.42,
  budgetUsd: 8,
  at: "2026-08-31T10:00:00Z",
  outcomes: [outcome("S1", "First story", "done"), outcome("S2", "Second story", "review")],
  epics: [{
    id: "E1", branch: "epic/e1", repos: ["app"], merged: ["S1"],
    defaultBranches: ["main"], rel: "03-plan/epics/E1.md",
  }],
});

function workspace(options: BuildWorkspaceOptions = ONE): BuildWorkspace {
  const made = makeBuildWorkspace(options);
  open.push(made);
  return made;
}

function git(dir: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Give the run an epic branch (as a Build stage would) and a handoff to send. */
function readyToShip(ws: BuildWorkspace, branches: readonly string[] = ["epic/e1"]): void {
  const store = RunStore.open(ws.runDir);
  store.mutate((run) => ({ ...run, build: { epic_branch: [...branches] } }));
  store.save();
  mkdirSync(join(ws.runDir, "04-build"), { recursive: true });
  writeFileSync(join(ws.runDir, "04-build", "handoff.md"), HANDOFF, "utf8");
  for (const branch of branches) git(ws.repoDir, ["branch", branch]);
}

interface Call {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /**
   * `--body-file`'s content, read AT CALL TIME — the bytes `gh` would have seen.
   *
   * Snapshotted rather than read from disk afterwards because `shipRun` removes
   * the body's temp directory when it is done with it. Reading it later would
   * assert that the file OUTLIVED the command, which is not the property that
   * matters; this asserts it existed while the command ran, which is.
   */
  readonly body?: string;
}

/** A transport that records every call and answers from a scripted table. */
function fakeTransport(
  answers: Readonly<Record<string, { exitCode?: number; stdout?: string; stderr?: string }>> = {},
): ShipTransport & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async run(cmd, args, cwd) {
      calls.push({ cmd, args: [...args], cwd, ...snapshotBody(args) });
      const key = `${cmd} ${args.slice(0, 2).join(" ")}`;
      const answer = answers[key] ?? answers[cmd];
      return {
        exitCode: answer?.exitCode ?? 0,
        stdout: answer?.stdout ?? "",
        stderr: answer?.stderr ?? "",
      };
    },
  };
}

/** `{ body }` when this argv carries a readable `--body-file`, `{}` otherwise. */
function snapshotBody(args: readonly string[]): { body?: string } {
  const at = args.indexOf("--body-file");
  const path = at === -1 ? "" : args[at + 1] ?? "";
  if (path === "") return {};
  try {
    return { body: readFileSync(path, "utf8") };
  } catch {
    return {};
  }
}

/** The `--body-file` path of the `gh pr create` that ran, quoting stripped. */
function bodyPathIn(text: string): string {
  const found = /--body-file (?:"([^"]+)"|(\S+))/.exec(text);
  return found?.[1] ?? found?.[2] ?? "";
}

/** The answers a healthy repo gives: gh present, an origin, the branch pushed. */
function healthy(overrides: Readonly<Record<string, { exitCode?: number; stdout?: string; stderr?: string }>> = {}) {
  return fakeTransport({
    "gh --version": { stdout: "gh version 2.62.0\n" },
    "git remote": { stdout: "origin\n" },
    "git remote get-url": { stdout: "git@github.com:ederwii/app.git\n" },
    "git ls-remote --heads": { stdout: "a1b2c3\trefs/heads/epic/e1\n" },
    "gh pr create": { stdout: "https://github.com/ederwii/app/pull/7\n" },
    git: { stdout: "" },
    ...overrides,
  });
}

async function ship(ws: BuildWorkspace, transport: ShipTransport, extra: Record<string, unknown> = {}) {
  return await shipRun({
    root: ws.root,
    runId: ws.runId,
    actor: "alan",
    at: "2026-08-31T10:00:00Z",
    transport,
    ...extra,
  });
}

/** What `--body-file` was actually handed, as `gh` saw it. */
function bodyOf(transport: { calls: Call[] }): string {
  return transport.calls.find((call) => call.cmd === "gh" && call.args[0] === "pr")?.body ?? "";
}

/**
 * One H2 section of the rendered body, heading included, up to the next H2 or the
 * `<details>` block — so "S2 is not under `## What shipped`" is a claim that can
 * fail, which `body.toContain("S2")` over the whole document could not make.
 */
function section(body: string, heading: string): string {
  const from = body.indexOf(`${heading}\n`);
  if (from === -1) return "";
  const rest = body.slice(from + heading.length + 1);
  const ends = [rest.indexOf("\n## "), rest.indexOf("\n<details>")].filter((at) => at !== -1);
  return heading + (ends.length === 0 ? rest : rest.slice(0, Math.min(...ends)));
}

/**
 * A healthy repo whose epic branch DOES carry changes to tldrx's own state.
 *
 * The answer is scripted rather than committed: `stateOnBranch` asks
 * `git diff --name-only <base>...<branch> -- tldrx-work .tldrx`, and the fake
 * transport keys on `<cmd> <arg0> <arg1>`, so this is the same repo with one
 * different reading — which is exactly the case #102's refusal is about.
 */
function withStatePaths(paths: readonly string[]) {
  return healthy({ "git diff --name-only": { stdout: `${paths.join("\n")}\n` } });
}

/**
 * A fix list on disk for one story, written by the REAL renderer.
 *
 * `renderFixlist` rather than a literal so the test is anchored to the format
 * `fixlist.ts` parses back — a body that listed findings a fix list no longer
 * writes that way would be a body that lists nothing.
 */
function writeFixlistFixture(
  ws: BuildWorkspace,
  storyId: string,
  findings: readonly Partial<FixFinding>[],
  phase = "04-build",
): void {
  mkdirSync(join(ws.runDir, phase, "fixlist"), { recursive: true });
  writeFileSync(
    join(ws.runDir, phase, "fixlist", `${storyId}-1.md`),
    renderFixlist({
      storyId,
      title: "First story",
      round: 1,
      attempt: 1,
      maxAttempts: 2,
      diff: "git diff main...epic/e1",
      commit: "abc1234",
      summary: "signed, with findings",
      findings: findings.map((partial, i) => ({
        n: i + 1,
        severity: "high",
        finding: "a finding",
        where: "src/app.ts:1",
        disposition: "fix-now",
        detail: "",
        doNot: [],
        resolved: false,
        resolvedSha: null,
        ...partial,
      })),
    }),
    "utf8",
  );
}

describe("tldrx ship", () => {
  test("opens the PR from the epic branch, with the handoff carried whole in the body", async () => {
    const ws = workspace();
    readyToShip(ws);
    const transport = healthy();
    const outcome = await ship(ws, transport);

    expect(outcome.code).toBe(EXIT_OK);
    const create = transport.calls.find((call) => call.cmd === "gh" && call.args[0] === "pr");
    expect(create).toBeDefined();
    const args = create?.args ?? [];
    expect(args.slice(0, 2)).toEqual(["pr", "create"]);
    expect(args).toContain("--head");
    expect(args[args.indexOf("--head") + 1]).toBe("epic/e1");
    expect(args).toContain("--base");
    expect(args[args.indexOf("--base") + 1]).toBe("main");
    expect(args).toContain("--body-file");
    const bodyFile = args[args.indexOf("--body-file") + 1] ?? "";
    // The file was THERE when `gh` ran, and every byte of the handoff was in it —
    // nothing paraphrased, nothing dropped.
    expect(create?.body).toBeDefined();
    expect(create?.body ?? "").toContain(HANDOFF);
    // The body is not written into the workspace, where it would become a diff,
    // and it does not outlive the command that needed it.
    expect(bodyFile.startsWith(ws.root)).toBe(false);
    expect(existsSync(bodyFile)).toBe(false);
    // Run in the repo the branch lives in, never in the workspace root.
    expect(create?.cwd).toBe(ws.repoDir);
    expect(outcome.lines.join("\n")).toContain("https://github.com/ederwii/app/pull/7");
  });

  test("the PR body is written for a PR: what shipped, what did not, handoff folded away", async () => {
    const ws = workspace();
    readyToShip(ws);
    const transport = healthy();

    await ship(ws, transport);
    const body = bodyOf(transport);

    // Not the raw gate document: the operator instruction is not what a reviewer meets.
    const head = body.slice(0, body.indexOf("<details>"));
    expect(head).not.toContain("Blocked on: **human approval**");
    expect(body.startsWith("# Handoff —")).toBe(false);

    expect(body).toContain("## What shipped");
    const shipped = section(body, "## What shipped");
    expect(shipped).toContain("S1");
    expect(shipped).not.toContain("S2");

    expect(body).toContain("## Not done");
    expect(section(body, "## Not done")).toContain("S2");

    // The handoff is still there, in full, folded away.
    expect(body).toContain("<details>");
    expect(body).toContain("04-build/handoff.md");
    const details = body.slice(body.indexOf("<details>"));
    expect(details).toContain("Blocked on: **human approval**");
  });

  test("open fix-list findings are listed, and come from fixlist.ts", async () => {
    const ws = workspace();
    readyToShip(ws);
    writeFixlistFixture(ws, "S1", [{ disposition: "fix-now", finding: "the token is logged" }]);

    const transport = healthy();
    await ship(ws, transport);
    const body = bodyOf(transport);

    expect(body).toContain("## Open findings");
    expect(body).toContain("the token is logged");
    expect(body).toContain("04-build/fixlist/S1-1.md");
  });

  test("a finding closed by an EVIDENCED resolution is not listed as open", async () => {
    const ws = workspace();
    readyToShip(ws);
    writeFixlistFixture(ws, "S1", [
      { finding: "the token is logged", resolved: true, resolvedSha: "9f2c1ab" },
      { finding: "the confirm is not atomic" },
    ]);

    const transport = healthy();
    await ship(ws, transport);
    const body = bodyOf(transport);

    // `isOpen` is the one implementation of "settled": a sha, not a claim.
    expect(body).toContain("the confirm is not atomic");
    expect(section(body, "## Open findings")).not.toContain("the token is logged");
  });

  test("a story whose fix list turns up under two phase directories is listed once", async () => {
    const ws = workspace();
    readyToShip(ws);
    // The real home, and a decoy under the Plan phase. Nothing writes one there
    // today (`writeFixlist`'s only caller passes `BUILD_PHASE`) — this pins the
    // loop that would otherwise report one story's findings twice, once per
    // directory, with two different citations.
    writeFixlistFixture(ws, "S1", [{ finding: "the token is logged" }]);
    writeFixlistFixture(ws, "S1", [{ finding: "a decoy nobody wrote" }], "03-plan");

    const transport = healthy();
    await ship(ws, transport);
    const body = bodyOf(transport);

    expect(body.split("the token is logged").length - 1).toBe(1);
    expect(body).not.toContain("a decoy nobody wrote");
    // The fix list's real home wins, not whichever directory came first.
    expect(body).toContain("04-build/fixlist/S1-1.md");
  });

  test("--dry-run names a body file that IS the body, byte for byte", async () => {
    const ws = workspace();
    readyToShip(ws);

    const dry = await ship(ws, healthy(), { dryRun: true });
    const named = bodyPathIn(dry.lines.join("\n"));
    expect(named).not.toBe("");
    // The printed command has to be runnable: the file it names must be there,
    // and must be the body — not merely a path that parses.
    expect(existsSync(named)).toBe(true);
    const printed = readFileSync(named, "utf8");
    expect(printed).toContain("## What shipped");
    expect(printed).toContain(HANDOFF);

    // And it is what a real `gh pr create` would have been handed.
    const transport = healthy();
    await ship(ws, transport);
    expect(bodyOf(transport)).toBe(printed);
  });

  test("no fix list at all leaves the section out rather than asserting an empty one", async () => {
    const ws = workspace();
    readyToShip(ws);
    const transport = healthy();
    await ship(ws, transport);
    expect(bodyOf(transport)).not.toContain("## Open findings");
  });

  test("a state path a SETTLED story declares in `touches:` is excused, and the ship proceeds", async () => {
    const ws = workspace({
      ...ONE,
      stories: [{
        id: "S1", epic: "E1", title: "First story", status: "done",
        touches: [".tldrx/workspace.yml"], evidence: ["04-build/log/S1.md:1"],
      }],
    });
    readyToShip(ws);

    const outcome = await ship(ws, withStatePaths([".tldrx/workspace.yml"]));
    expect(outcome.code).toBe(EXIT_OK);
  });

  test("an UNDECLARED state path still refuses, and the message says which story excused which", async () => {
    const ws = workspace({
      ...ONE,
      stories: [{
        id: "S1", epic: "E1", title: "First story", status: "done",
        touches: [".tldrx/workspace.yml"], evidence: ["04-build/log/S1.md:1"],
      }],
    });
    readyToShip(ws);

    const outcome = await ship(
      ws,
      withStatePaths([".tldrx/workspace.yml", "tldrx-work/260829-x/run.yml"]),
    );
    expect(outcome.code).toBe(EXIT_GATE_REFUSED);
    const text = outcome.lines.join("\n");
    expect(text).toContain("tldrx-work/260829-x/run.yml");
    expect(text).toContain("excused by S1");
    // The excused path is subtracted, not listed among the refused ones.
    expect(text).not.toMatch(/^\s+\.tldrx\/workspace\.yml$/m);
    expect(text).toContain("1 change(s)");

    // …and the remedy it prints must not undo the excuse three lines above it.
    // `git checkout <base> -- .tldrx` would discard S1's declared work and ship
    // a branch that no longer carries the thing the story was written to do.
    const remedy = outcome.lines.find(
      (line) => line.trim().startsWith("git -C") && line.includes("checkout"),
    ) ?? "";
    expect(remedy).toContain("tldrx-work/260829-x/run.yml");
    expect(remedy).not.toContain(".tldrx/workspace.yml");
    expect(remedy).not.toMatch(/checkout main -- tldrx-work \.tldrx\s*$/);
  });

  /**
   * The remedy is a command an operator PASTES. `refused.join(" ")` made a path
   * with a space in it into two pathspecs — `git checkout main -- a b.yml` —
   * which either fails or checks out something nobody asked for. The blanket
   * two-directory form it replaced could not have the problem, so this arrived
   * with #167's path list.
   */
  test("a refused path with a SPACE is quoted, so the remedy line stays pasteable", async () => {
    const ws = workspace({
      ...ONE,
      stories: [{
        id: "S1", epic: "E1", title: "First story", status: "done",
        touches: [".tldrx/workspace.yml"], evidence: ["04-build/log/S1.md:1"],
      }],
    });
    readyToShip(ws);

    // An excuse is what puts the remedy on its path-list branch at all.
    const outcome = await ship(ws, withStatePaths([
      ".tldrx/workspace.yml",
      "tldrx-work/260829-x/notes with spaces.md",
    ]));
    expect(outcome.code).toBe(EXIT_GATE_REFUSED);

    const remedy = outcome.lines.find(
      (line) => line.trim().startsWith("git -C") && line.includes("checkout"),
    ) ?? "";
    expect(remedy).toContain('"tldrx-work/260829-x/notes with spaces.md"');
    // One pathspec, not two: the bare path must not appear unquoted anywhere.
    expect(remedy).not.toMatch(/ tldrx-work\/260829-x\/notes with/);
  });

  test("`touches: .tldrx/work` does not excuse `.tldrx/workspace.yml`, and does excuse `.tldrx/work/x`", async () => {
    const ws = workspace({
      ...ONE,
      stories: [{
        id: "S1", epic: "E1", title: "First story", status: "done",
        touches: [".tldrx/work"], evidence: ["04-build/log/S1.md:1"],
      }],
    });
    readyToShip(ws);

    // A declared path is a path, not a prefix: `.tldrx/work` and
    // `.tldrx/workspace.yml` are two different files, and reading one as the
    // other would wave an UNDECLARED state change through as an excuse.
    const refusal = await ship(ws, withStatePaths([".tldrx/workspace.yml"]));
    expect(refusal.code).toBe(EXIT_GATE_REFUSED);
    expect(refusal.lines.join("\n")).toMatch(/^\s+\.tldrx\/workspace\.yml$/m);
    expect(refusal.lines.join("\n")).not.toContain("excused by");

    // A declared DIRECTORY does cover what is under it — `touches:` may name one.
    const proceeds = await ship(ws, withStatePaths([".tldrx/work/notes.yml"]));
    expect(proceeds.code).toBe(EXIT_OK);
  });

  test("an UNSETTLED story's `touches:` excuses nothing — a plan is not a fact", async () => {
    const ws = workspace({
      ...ONE,
      stories: [{
        id: "S1", epic: "E1", title: "First story", status: "review",
        touches: [".tldrx/workspace.yml"],
      }],
    });
    readyToShip(ws);

    const outcome = await ship(ws, withStatePaths([".tldrx/workspace.yml"]));
    expect(outcome.code).toBe(EXIT_GATE_REFUSED);
    const text = outcome.lines.join("\n");
    expect(text).toMatch(/^\s+\.tldrx\/workspace\.yml$/m);
    expect(text).not.toContain("excused by");
  });

  /**
   * ONE row per story id (wave-3 final review, M5).
   *
   * `runStories` walked every phase directory and pushed whatever it found, so a
   * story file present under two of them became two rows and `settledTouches`
   * built two excuses from them — taking the one that said `done` even when the
   * copy in the directory that wins every other tie said `review`. Nothing writes
   * a story outside `03-plan/stories/` today, which is exactly why this is pinned
   * rather than left to be noticed: the guard is against a second writer, not
   * against today's tree.
   *
   * The surviving row is the FIRST phase directory's — `04-build`, the same
   * tie-break `openFixFindings` documents — so the two readers of this list read
   * one file per story, and a stale `done` copy cannot excuse a state path the
   * live one still has under review.
   */
  test("a story file duplicated across phase directories is read once, first directory winning", () => {
    const ws = workspace({
      ...ONE,
      stories: [{
        id: "S1", epic: "E1", title: "First story", status: "done",
        touches: [".tldrx/workspace.yml"], evidence: ["04-build/log/S1.md:1"],
      }],
    });
    readyToShip(ws);
    // The decoy: the same story, still under review, under the phase directory
    // that comes first.
    const planned = readFileSync(join(ws.runDir, "03-plan", "stories", "S1.md"), "utf8");
    mkdirSync(join(ws.runDir, "04-build", "stories"), { recursive: true });
    writeFileSync(
      join(ws.runDir, "04-build", "stories", "S1.md"),
      planned.replace("status: done", "status: review"),
      "utf8",
    );

    const rows = runStories(RunStore.open(ws.runDir));

    expect(rows.filter((row) => row.id === "S1")).toHaveLength(1);
    expect(rows.find((row) => row.id === "S1")?.status).toBe("review");
  });

  test("refuses when the run has cut no epic branch, and calls nothing", async () => {
    const ws = workspace();
    const transport = healthy();
    const outcome = await ship(ws, transport);
    expect(outcome.code).toBe(EXIT_GATE_REFUSED);
    expect(outcome.lines.join("\n")).toContain("epic branch");
    expect(transport.calls.length).toBe(0);
  });

  test("refuses when there is no handoff to send as the body", async () => {
    const ws = workspace();
    const store = RunStore.open(ws.runDir);
    store.mutate((run) => ({ ...run, build: { epic_branch: ["epic/e1"] } }));
    store.save();
    git(ws.repoDir, ["branch", "epic/e1"]);

    const outcome = await ship(ws, healthy());
    expect(outcome.code).toBe(EXIT_GATE_REFUSED);
    expect(outcome.lines.join("\n")).toContain("handoff");
  });

  test("refuses when gh is not installed, and names it", async () => {
    const ws = workspace();
    readyToShip(ws);
    const absent = fakeTransport({
      "gh --version": { exitCode: 127, stderr: "command not found: gh\n" },
      git: { stdout: "" },
    });
    const outcome = await ship(ws, absent);
    expect(outcome.code).toBe(EXIT_GATE_REFUSED);
    expect(outcome.lines.join("\n")).toContain("gh");
    // Nothing was attempted through it.
    expect(absent.calls.some((call) => call.cmd === "gh" && call.args[0] === "pr")).toBe(false);
  });

  test("refuses when the repo has no remote", async () => {
    const ws = workspace();
    readyToShip(ws);
    const transport = fakeTransport({
      "gh --version": { stdout: "gh version 2.62.0\n" },
      "git remote": { stdout: "" },
      git: { stdout: "" },
    });
    const outcome = await ship(ws, transport);
    expect(outcome.code).toBe(EXIT_GATE_REFUSED);
    expect(outcome.lines.join("\n")).toContain("remote");
    expect(transport.calls.some((call) => call.cmd === "gh" && call.args[0] === "pr")).toBe(false);
  });

  test("refuses an unpushed branch and names the push command rather than pushing it", async () => {
    const ws = workspace();
    readyToShip(ws);
    const transport = fakeTransport({
      "gh --version": { stdout: "gh version 2.62.0\n" },
      "git remote": { stdout: "origin\n" },
      "git remote get-url": { stdout: "git@github.com:ederwii/app.git\n" },
      "git ls-remote --heads": { stdout: "" },
      git: { stdout: "" },
    });
    const outcome = await ship(ws, transport);
    expect(outcome.code).toBe(EXIT_GATE_REFUSED);
    const text = outcome.lines.join("\n");
    // The refusal hands over a command that can be pasted, cwd and all.
    expect(text).toContain("push -u origin epic/e1");
    expect(text).toContain("git -C ");
    // tldrx never publishes a branch on its own (spec §5).
    expect(transport.calls.some((call) => call.cmd === "git" && call.args[0] === "push")).toBe(false);
    expect(transport.calls.some((call) => call.cmd === "gh" && call.args[0] === "pr")).toBe(false);
  });

  test("several epic branches and no --branch is a refusal that names them", async () => {
    const ws = workspace();
    readyToShip(ws, ["epic/e1", "epic/e2"]);
    const outcome = await ship(ws, healthy());
    expect(outcome.code).toBe(EXIT_GATE_REFUSED);
    const text = outcome.lines.join("\n");
    expect(text).toContain("epic/e1");
    expect(text).toContain("epic/e2");
    expect(text).toContain("--branch");
  });

  test("--branch picks one of several, and only one of the run's own", async () => {
    const ws = workspace();
    readyToShip(ws, ["epic/e1", "epic/e2"]);
    const transport = healthy();
    expect((await ship(ws, transport, { branch: "epic/e2" })).code).toBe(EXIT_OK);
    const create = transport.calls.find((call) => call.cmd === "gh" && call.args[0] === "pr");
    expect(create?.args[(create?.args.indexOf("--head") ?? -1) + 1]).toBe("epic/e2");

    const stranger = await ship(ws, healthy(), { branch: "epic/nope" });
    expect(stranger.code).toBe(EXIT_GATE_REFUSED);
    expect(stranger.lines.join("\n")).toContain("epic/nope");
  });

  test("--dry-run prints the command and creates nothing", async () => {
    const ws = workspace();
    readyToShip(ws);
    const transport = healthy();
    const outcome = await ship(ws, transport, { dryRun: true });
    expect(outcome.code).toBe(EXIT_OK);
    expect(outcome.lines.join("\n")).toContain("gh pr create");
    expect(transport.calls.some((call) => call.cmd === "gh" && call.args[0] === "pr")).toBe(false);
  });

  test("an unknown run is exit 3", async () => {
    const ws = workspace();
    readyToShip(ws);
    const outcome = await ship(ws, healthy(), { runId: "260101-nope" });
    expect(outcome.code).toBe(EXIT_NOT_FOUND);
  });

  test("end to end through the CLI, against a stub gh on PATH", async () => {
    const ws = workspace();
    readyToShip(ws);

    // A throwaway bare repo standing in for GitHub, and the epic branch pushed to it.
    const originDir = join(ws.root, "origin.git");
    execFileSync("git", ["init", "--bare", "-b", "main", originDir], { stdio: "pipe" });
    git(ws.repoDir, ["remote", "add", "origin", originDir]);
    git(ws.repoDir, ["push", "-q", "origin", "main"]);
    git(ws.repoDir, ["push", "-q", "origin", "epic/e1"]);

    // The stub: records its argv, prints a PR URL. Never the real gh.
    const record = join(ws.root, "gh-argv.txt");
    const stub = join(ws.binDir, "gh");
    writeFileSync(
      stub,
      [
        "#!/bin/sh",
        `for a in "$@"; do printf '%s\\n' "$a" >> ${JSON.stringify(record)}; done`,
        'case "$1" in --version) echo "gh version 2.62.0";; *) echo "https://github.com/ederwii/app/pull/9";; esac',
        "exit 0",
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(stub, 0o755);

    const proc = Bun.spawn(["bun", BIN, "ship", "--run", ws.runId, "--root", ws.root], {
      stdout: "pipe",
      stderr: "pipe",
      cwd: ws.root,
      env: { ...process.env, PATH: `${ws.binDir}:${ORIGINAL_PATH}` },
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;

    expect(stderr).toBe("");
    expect(code).toBe(EXIT_OK);
    expect(stdout).toContain("https://github.com/ederwii/app/pull/9");

    const argv = readFileSync(record, "utf8").split("\n").filter((line) => line !== "");
    expect(argv).toContain("pr");
    expect(argv).toContain("create");
    expect(argv).toContain("epic/e1");
  });

  test("a refusal through the CLI is a sentence, not a stack trace", async () => {
    const ws = workspace();
    const proc = Bun.spawn(["bun", BIN, "ship", "--run", ws.runId, "--root", ws.root], {
      stdout: "pipe",
      stderr: "pipe",
      cwd: ws.root,
      env: { ...process.env, PATH: `${ws.binDir}:${ORIGINAL_PATH}` },
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect(await proc.exited).toBe(EXIT_GATE_REFUSED);
    expect(stdout).toBe("");
    expect(stderr).toContain("epic branch");
    expect(stderr).not.toContain("    at ");
    expect(stderr).not.toContain("TypeError");
  });
});

/**
 * `## Carried findings` — the defects this run deliberately did NOT fix, that no
 * story's declared surface covers (#171).
 *
 * `ship` applies no predicate of its own here. The rows come from
 * `build/carriedRows.ts`, which calls `carriedFindings` (`build/fixlist.ts`) and
 * `unownedFindings` (`build/unownedFindings.ts`) — the one implementation of both
 * judgements. `ship` calls the leaf because it runs in a separate process, not
 * because it has a second opinion.
 *
 * Ownership is REPO-THEN-PATH, so both directions are asserted: a finding at a
 * path S1 declares is not listed, and one at a path nobody declares is.
 */
describe("tldrx ship — carried findings nobody's story owns (#171)", () => {
  test("carried findings nobody's story owns are listed, and come from the shared leaf", async () => {
    const ws = workspace();
    readyToShip(ws);                                     // S1 · repo app · touches ["s1.txt"]
    writeFixlistFixture(ws, "S1", [
      { disposition: "defer-with-log", finding: "the token is logged", where: "[src: app:platform/Auth.cs:3]" },
    ]);

    const transport = healthy();
    await ship(ws, transport);
    const body = bodyOf(transport);

    expect(body).toContain("## Carried findings");
    expect(body).toContain("the token is logged");
    expect(body).toContain("no story declares this path in the repo it names");
  });

  test("a carried finding a story DOES own is not listed — the section is about ownership", async () => {
    const ws = workspace();
    readyToShip(ws);
    writeFixlistFixture(ws, "S1", [
      { disposition: "defer-with-log", finding: "a nit inside the surface", where: "[src: app:s1.txt:1]" },
    ]);

    const transport = healthy();
    await ship(ws, transport);
    expect(bodyOf(transport)).not.toContain("## Carried findings");
  });

  test("no carried findings leaves the section out rather than asserting an empty one", async () => {
    const ws = workspace();
    readyToShip(ws);

    const transport = healthy();
    await ship(ws, transport);
    expect(bodyOf(transport)).not.toContain("## Carried findings");
  });

  test("a `fix-now` finding is NOT carried — the two dispositions are two questions", async () => {
    const ws = workspace();
    readyToShip(ws);
    writeFixlistFixture(ws, "S1", [
      { disposition: "fix-now", finding: "the token is logged", where: "[src: app:platform/Auth.cs:3]" },
    ]);

    const transport = healthy();
    await ship(ws, transport);
    const body = bodyOf(transport);
    expect(body).toContain("## Open findings");
    expect(body).not.toContain("## Carried findings");
  });

  /**
   * The Plan-skipped shape, BOTH ways.
   *
   * `runStories` walks `<phase>/stories/` and a scope that skips Plan writes no
   * story file at all — its one story lives in `04-build/implicit-plan.yml`. So
   * without the implicit source every carried finding on such a run would be
   * reported unowned, including one squarely inside the surface the implicit plan
   * declared. The leaf reads the same pair the boundary gate reads, real plan
   * first (`run/boundary.ts` `deriveSurface`).
   */
  describe("a run whose scope skipped Plan", () => {
    const SKIPPED: BuildWorkspaceOptions = { ...ONE, plan: false, skips: ["plan"] };

    function implicitPlan(ws: BuildWorkspace, touches: readonly string[]): void {
      mkdirSync(join(ws.runDir, "04-build"), { recursive: true });
      writeFileSync(join(ws.runDir, "04-build", "implicit-plan.yml"), [
        "version: 1",
        "implicit: true",
        "status: todo",
        "epic:",
        "  id: E1",
        "  branch: epic/e1",
        "  repos: [app]",
        "story:",
        "  id: S1",
        "  repo: app",
        "  touches:",
        ...touches.map((path) => `    - "${path}"`),
        "",
      ].join("\n"), "utf8");
    }

    test("a finding inside the implicit story's surface is OWNED, not falsely reported", async () => {
      const ws = workspace(SKIPPED);
      readyToShip(ws);
      implicitPlan(ws, ["src/in.ts"]);
      writeFixlistFixture(ws, "S1", [
        { disposition: "defer-with-log", finding: "a nit inside the surface", where: "[src: app:src/in.ts:1]" },
      ]);

      const transport = healthy();
      await ship(ws, transport);
      expect(bodyOf(transport)).not.toContain("## Carried findings");
    });

    test("a finding outside it is still reported, so the source is not a blanket excuse", async () => {
      const ws = workspace(SKIPPED);
      readyToShip(ws);
      implicitPlan(ws, ["src/in.ts"]);
      writeFixlistFixture(ws, "S1", [
        { disposition: "defer-with-log", finding: "the token is logged", where: "[src: app:platform/Auth.cs:3]" },
      ]);

      const transport = healthy();
      await ship(ws, transport);
      const body = bodyOf(transport);
      expect(body).toContain("## Carried findings");
      expect(body).toContain("the token is logged");
    });
  });
});
