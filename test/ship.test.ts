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
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";
import { shipRun, type ShipTransport } from "../src/core/run/ship.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
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

const HANDOFF = [
  "# Build handoff",
  "",
  "## Findings",
  "",
  "- The leaderboard sorts by score, then by name [src: app:README.md:1]",
  "",
].join("\n");

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
}

/** A transport that records every call and answers from a scripted table. */
function fakeTransport(
  answers: Readonly<Record<string, { exitCode?: number; stdout?: string; stderr?: string }>> = {},
): ShipTransport & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async run(cmd, args, cwd) {
      calls.push({ cmd, args: [...args], cwd });
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

describe("tldrx ship", () => {
  test("opens the PR from the epic branch with the handoff as the body", async () => {
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
    expect(existsSync(bodyFile)).toBe(true);
    expect(readFileSync(bodyFile, "utf8")).toBe(HANDOFF);
    // Run in the repo the branch lives in, never in the workspace root.
    expect(create?.cwd).toBe(ws.repoDir);
    expect(outcome.lines.join("\n")).toContain("https://github.com/ederwii/app/pull/7");
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
