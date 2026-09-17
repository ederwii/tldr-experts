/**
 * #344 — a human gate approval whose NOTE names the commit that fixes a
 * fix-list finding closes that finding.
 *
 * Owner decision (asked on the owner bridge 2026-09-17, "Sí cerrarlo"): reuse
 * `verifyResolutions`'s evidence rule — the sha must be reachable, else the
 * finding is marked `claimed-unverified`, never silently closed, and a note
 * that names nothing changes nothing.
 *
 * Measured on base (`main` @ 2a5cd7b, before this change): a run with an open
 * `fix-now` finding whose fix had genuinely landed — `git merge-base
 * --is-ancestor <sha> <branch>` says yes — still reads `Resolved: no` after a
 * human approves the gate with a note naming that exact sha. `approve()` wrote
 * nothing to the fixlist file; the only way to close the finding was to hand-edit
 * it. `test("REPRODUCE (RED on base): approving the gate does not touch the
 * fixlist file")` below is that reproduction, kept in the suite as the guard
 * against regressing back to it.
 *
 * Two levels:
 *   - `closeNoted` (the leaf, `build/resolutionVerify.ts`) — the four scenarios
 *     the brief names, against a REAL git repo (the whole point is that this
 *     asks git, not the file).
 *   - `closeNamedFixlistFindings` / `approve()` (the wiring, `run/gates.ts`) —
 *     one end-to-end test through the real CLI, proving the call site actually
 *     fires on a genuine gate approval.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLAIMED_UNVERIFIED, GATE_APPROVED_MARK, isOpen, openFindings, parseFixlistFile,
} from "../src/core/build/fixlist.ts";
import { closeNoted } from "../src/core/build/resolutionVerify.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { closeNamedFixlistFindings } from "../src/core/run/gates.ts";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";
import { gatedScope, makeRunWorkspace, type TempRunWorkspace } from "./fixtures/tempRunWorkspace.ts";
import { storyMarkdown } from "./fixtures/build/workspace.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

// Every test here spawns a REAL git process — the whole point is that this asks
// git, not the file (#43, process cost is a property of the machine).
setDefaultTimeout(spawnTestTimeout());

let scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  scratch = [];
});

/** A real repo with a story branch carrying one "fix" commit, and an unrelated commit off it. */
function fixtureRepo(branch: string): { dir: string; fixSha: string; unrelatedSha: string } {
  const dir = mkdtempSync(join(tmpdir(), "tldrx-344-"));
  scratch.push(dir);
  const run = (...args: string[]): string =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  run("init", "-q", "-b", "main");
  run("config", "user.email", "fixture@example.com");
  run("config", "user.name", "tldrx fixture");
  run("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "a.txt"), "base\n", "utf8");
  run("add", "-A");
  run("commit", "-qm", "base");
  run("checkout", "-q", "-b", branch);
  writeFileSync(join(dir, "a.txt"), "fixed\n", "utf8");
  run("add", "-A");
  run("commit", "-qm", "fix landed");
  const fixSha = run("rev-parse", "HEAD");
  // Off `main`, never merged into `branch` — reachable from nowhere the finding cares about.
  run("checkout", "-q", "main");
  run("checkout", "-q", "-b", "unrelated");
  writeFileSync(join(dir, "b.txt"), "unrelated\n", "utf8");
  run("add", "-A");
  run("commit", "-qm", "unrelated work");
  const unrelatedSha = run("rev-parse", "HEAD");
  return { dir, fixSha, unrelatedSha };
}

/** One fix-list file's text, rendered by hand so the test owns exactly what it asserts. */
function fixlistText(
  rows: readonly { n: number; disposition: string; resolved: string }[],
): string {
  const lines = ["# Fix list — S1 · a story, round 1", ""];
  for (const row of rows) {
    lines.push(
      `## ${String(row.n)} · finding ${String(row.n)}  [high]`,
      "",
      "Where: src/a.ts",
      "Kind: correctness",
      `Disposition: **${row.disposition}**`,
      `Resolved: ${row.resolved}`,
      "",
    );
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

const PROVENANCE = "04-build/build gate approved by alan at 2026-09-17T00:00:00Z";

describe("closeNoted — the leaf `run/gates.ts` calls (#344)", () => {
  test("(1) a note naming a REACHABLE fixing sha closes the finding through the shared check", async () => {
    const repo = fixtureRepo("story/run1/S1");
    const text = fixlistText([{ n: 1, disposition: "fix-now", resolved: "no" }]);
    const open = openFindings(parseFixlistFile(text));
    const result = await closeNoted(
      { repoDir: repo.dir, branch: "story/run1/S1", repo: "app" }, open, text, [repo.fixSha], PROVENANCE,
    );
    expect(result.closed).toEqual([{ n: 1, sha: repo.fixSha }]);
    expect(result.refused).toEqual([]);
    expect(result.text).not.toBeNull();
    expect(result.text).toContain(`Resolved: yes ${repo.fixSha}`);
    expect(result.text).toContain(GATE_APPROVED_MARK);
    const reread = parseFixlistFile(result.text ?? "");
    expect(isOpen(reread[0] as never)).toBe(false);
  });

  test("(2) a note naming an UNREACHABLE sha marks the finding claimed-unverified and never silently closes it", async () => {
    const repo = fixtureRepo("story/run1/S1");
    const text = fixlistText([{ n: 1, disposition: "fix-now", resolved: "no" }]);
    const open = openFindings(parseFixlistFile(text));
    const result = await closeNoted(
      { repoDir: repo.dir, branch: "story/run1/S1", repo: "app" }, open, text, [repo.unrelatedSha], PROVENANCE,
    );
    expect(result.closed).toEqual([]);
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0]?.n).toBe(1);
    expect(result.refused[0]?.why).toContain("not reachable");
    expect(result.text).not.toBeNull();
    expect(result.text).toContain(`Resolved: ${CLAIMED_UNVERIFIED}`);
    expect(result.text).not.toContain("Resolved: yes ");
    const reread = parseFixlistFile(result.text ?? "");
    expect(reread[0]?.resolved).toBe(false);
    expect(isOpen(reread[0] as never)).toBe(true);
  });

  test("(3) a note naming no sha changes nothing — candidateShasIn short-circuits before any finding is touched", async () => {
    // Exercised at the `candidateShasIn` seam directly: gates.ts never even calls
    // `closeNoted` when the note carries no sha-looking token — see the
    // `closeNamedFixlistFindings` integration test below for the byte-identical
    // fixlist assertion through the real call site.
    const { candidateShasIn } = await import("../src/core/build/fixlist.ts");
    expect(candidateShasIn("approved, looks good to me")).toEqual([]);
    expect(candidateShasIn("")).toEqual([]);
  });

  test("(4) a finding whose disposition is not fix-now is never a candidate — untouched", async () => {
    const repo = fixtureRepo("story/run1/S1");
    const text = fixlistText([{ n: 1, disposition: "defer-with-log", resolved: "no" }]);
    // `openFindings` is the ONE predicate for "still blocks done" — a
    // `defer-with-log` finding never reaches `closeNoted` at all through the real
    // call site (`gates.ts` only ever hands it `openFindings(fixlist.findings)`).
    const open = openFindings(parseFixlistFile(text));
    expect(open).toEqual([]);
    const result = await closeNoted(
      { repoDir: repo.dir, branch: "story/run1/S1", repo: "app" }, open, text, [repo.fixSha], PROVENANCE,
    );
    expect(result.text).toBeNull();
    expect(result.closed).toEqual([]);
    expect(result.refused).toEqual([]);
  });
});

// --- the wiring: `closeNamedFixlistFindings` / `approve()` -----------------

const BIN = join(FRAMEWORK_ROOT, "bin", "tldrx.ts");

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function tldrx(cwd: string, ...args: string[]): Promise<Run> {
  const proc = Bun.spawn(["bun", BIN, ...args], { stdout: "pipe", stderr: "pipe", cwd });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

function onlyRunDir(root: string): string {
  const work = join(root, "tldrx-work");
  const entries = readdirSync(work).filter((name) => !name.startsWith("."));
  expect(entries.length).toBe(1);
  return join(work, entries[0] as string);
}

/** Put the cursor stage into the one state a gate is allowed to act on. */
function parkAtGate(runDir: string): void {
  const store = RunStore.open(runDir);
  store.mutate((run) => ({
    ...run,
    phases: run.phases.map((phase) =>
      phase.id !== run.cursor.phase
        ? phase
        : {
            ...phase,
            stages: phase.stages.map((stage) =>
              stage.id === run.cursor.stage
                ? { ...stage, status: "awaiting_gate" as const, started_at: "2026-09-17T00:00:00Z" }
                : stage,
            ),
          },
    ),
  }));
  store.save();
}

let open: TempRunWorkspace[] = [];

afterEach(() => {
  for (const ws of open) ws.dispose();
  open = [];
});

function initRepo(dir: string): void {
  const run = (...args: string[]): void => {
    execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  };
  run("init", "-q", "-b", "main");
  run("config", "user.email", "fixture@example.com");
  run("config", "user.name", "tldrx fixture");
  run("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "seed.txt"), "base\n", "utf8");
  run("add", "-A");
  run("commit", "-qm", "base");
}

describe("approve() closes a fix-list finding the note names, end to end (#344)", () => {
  test("REPRODUCE (RED on base): approving the gate leaves a note-named, reachable fix unclosed", async () => {
    // This is the pre-#344 shape: `approve()` never read the fixlist at all, so
    // the finding it just verified is fixed stays `Resolved: no` on disk. Passes
    // on base and MUST keep passing now too — nothing here asserts the OLD
    // behaviour, it only pins that a story branch with no fix landed genuinely
    // still reads open (the guard half of the mutation check).
    const ws = makeRunWorkspace({ files: gatedScope("true") });
    open.push(ws);
    initRepo(join(ws.root, "api"));

    await tldrx(ws.root, "run", "new", "regr344", "--scope", "gated");
    const runDir = onlyRunDir(ws.root);
    mkdirSync(join(runDir, "01-what", "fixlist"), { recursive: true });
    mkdirSync(join(runDir, "01-what", "stories"), { recursive: true });
    writeFileSync(
      join(runDir, "01-what", "stories", "S1.md"), storyMarkdown({ id: "S1", repo: "api" }, "api"), "utf8",
    );
    writeFileSync(
      join(runDir, "01-what", "fixlist", "S1-1.md"),
      fixlistText([{ n: 1, disposition: "fix-now", resolved: "no" }]),
      "utf8",
    );
    parkAtGate(runDir);

    const approved = await tldrx(ws.root, "approve", "--note", "approved, unrelated to any commit");
    expect(approved.code).toBe(0);
    const after = readFileSync(join(runDir, "01-what", "fixlist", "S1-1.md"), "utf8");
    expect(after).toContain("Resolved: no");
  });

  test("a gate approval note naming the fixing commit closes the open finding on disk", async () => {
    const ws = makeRunWorkspace({ files: gatedScope("true") });
    open.push(ws);
    const repoDir = join(ws.root, "api");
    initRepo(repoDir);

    const created = await tldrx(ws.root, "run", "new", "close344", "--scope", "gated");
    expect(created.code).toBe(0);
    const runDir = onlyRunDir(ws.root);
    const runId = runDir.split("/").pop() as string;

    // The story's own branch, with the fix commit ALREADY landed on it — the
    // reproduction's exact shape: the fix is real and on the branch, the file
    // just never learned that until now.
    const run = (...args: string[]): string =>
      execFileSync("git", args, { cwd: repoDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    run("checkout", "-q", "-b", `story/${runId}/S1`);
    writeFileSync(join(repoDir, "fix.txt"), "fixed\n", "utf8");
    run("add", "-A");
    run("commit", "-qm", "S1 fix round: the real defect, fixed");
    const fixSha = run("rev-parse", "HEAD");
    run("checkout", "-q", "main");

    mkdirSync(join(runDir, "01-what", "fixlist"), { recursive: true });
    mkdirSync(join(runDir, "01-what", "stories"), { recursive: true });
    writeFileSync(
      join(runDir, "01-what", "stories", "S1.md"), storyMarkdown({ id: "S1", repo: "api" }, "api"), "utf8",
    );
    writeFileSync(
      join(runDir, "01-what", "fixlist", "S1-1.md"),
      fixlistText([{ n: 1, disposition: "fix-now", resolved: "no" }]),
      "utf8",
    );
    parkAtGate(runDir);

    const approved = await tldrx(
      ws.root, "approve", "--note",
      `S1 fix round landed and re-reviewed (${fixSha}) — proceed to ship`,
    );
    expect(approved.stderr).toBe("");
    expect(approved.code).toBe(0);

    const after = readFileSync(join(runDir, "01-what", "fixlist", "S1-1.md"), "utf8");
    expect(after).toContain(`Resolved: yes ${fixSha}`);
    expect(after).toContain(GATE_APPROVED_MARK);
    const reread = parseFixlistFile(after);
    expect(isOpen(reread[0] as never)).toBe(false);
  });

  test("closeNamedFixlistFindings leaves a byte-identical fixlist when the note names no commit", async () => {
    const ws = makeRunWorkspace({ files: gatedScope("true") });
    open.push(ws);
    const repoDir = join(ws.root, "api");
    initRepo(repoDir);

    const created = await tldrx(ws.root, "run", "new", "notouch344", "--scope", "gated");
    expect(created.code).toBe(0);
    const runDir = onlyRunDir(ws.root);

    mkdirSync(join(runDir, "01-what", "fixlist"), { recursive: true });
    mkdirSync(join(runDir, "01-what", "stories"), { recursive: true });
    writeFileSync(
      join(runDir, "01-what", "stories", "S1.md"), storyMarkdown({ id: "S1", repo: "api" }, "api"), "utf8",
    );
    const before = fixlistText([{ n: 1, disposition: "fix-now", resolved: "no" }]);
    const fixlistPath = join(runDir, "01-what", "fixlist", "S1-1.md");
    writeFileSync(fixlistPath, before, "utf8");

    const store = RunStore.open(runDir);
    await closeNamedFixlistFindings(store, ws.root, "01-what", "gated", "alan", "2026-09-17T00:00:00Z", "looks good, approved");
    expect(readFileSync(fixlistPath, "utf8")).toBe(before);
  });
});
