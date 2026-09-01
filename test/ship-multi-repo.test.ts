/**
 * `tldrx ship` when the run's branch exists in MORE THAN ONE repo (issue #66).
 *
 * ## What was wrong
 *
 * #57 made every chained multi-repo run cut ONE integration branch, `epic/<run-id>`,
 * with the same name in every repo of the run. `ship` looked the branch up, found it
 * in several repos, and refused with `pass one: --repo <name>` — so the last step of
 * every chained multi-repo run was the operator running the same command N times,
 * once per repo, and remembering which ones had already gone through.
 *
 * ## The owner's decision (2026-09-01, on the issue)
 *
 * "Automatic per-repo PRs on chained multi-repo ship (same handoff body, repo in
 * title, list them at the end)."
 *
 * ## What these tests hold
 *
 * **Single-repo output is byte-identical.** The four lines are asserted as exact
 * strings, not as substrings, because "we did not change the common case" is a claim
 * that a `toContain` cannot make.
 *
 * **A partial failure names both sides.** PR 2 of 3 failing must not hide that PR 1
 * was opened: the operator has to know which repos have a PR before re-running.
 *
 * **Re-running is safe.** A repo whose PR is already open is skipped rather than
 * being asked for a second one, so the fix for a partial failure is `tldrx ship`
 * again and nothing else.
 *
 * **The real `gh` is never invoked.** Every case here drives a recording transport;
 * the end-to-end case puts a STUB `gh` first on PATH. Same rule as `ship.test.ts`.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";
import { shipRun, type ShipTransport } from "../src/core/run/ship.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { EXIT_GATE_REFUSED, EXIT_OK } from "../src/cli/exitCodes.ts";
import { makeBuildWorkspace, type BuildWorkspace } from "./fixtures/build/workspace.ts";
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

const HANDOFF = [
  "# Build handoff",
  "",
  "## Findings",
  "",
  "- The leaderboard sorts by score, then by name [src: app:README.md:1]",
  "",
  "Closes #66",
  "",
].join("\n");

/** The chained shape: one branch, the same name in every repo of the run. */
const BRANCH = "epic/260901-scoring";

function git(dir: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function workspace(): BuildWorkspace {
  const made = makeBuildWorkspace({
    stories: [{ id: "S1", epic: "E1", title: "First story" }],
    epics: [{ id: "E1", stories: ["S1"], branch: BRANCH }],
    waves: [["S1"]],
  });
  open.push(made);
  return made;
}

/**
 * A SECOND (and third) product repo in the same workspace, declared in
 * `workspace.yml` and on the run — the shape a chained multi-repo run has, and the
 * one `makeBuildWorkspace` (single-repo by construction) cannot make on its own.
 */
function addRepo(ws: BuildWorkspace, name: string, defaultBranch = "main"): string {
  const dir = join(ws.root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "README.md"), `# ${name}\n`, "utf8");
  git(dir, ["init", "-b", defaultBranch]);
  git(dir, ["config", "user.email", "fixture@example.com"]);
  git(dir, ["config", "user.name", "tldrx fixture"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "chore: fixture repo"]);

  const path = join(ws.root, ".tldrx", "workspace.yml");
  writeFileSync(path, `${readFileSync(path, "utf8").trimEnd()}\n`
    + `  - name: ${name}\n`
    + `    path: ${name}\n`
    + `    default_branch: ${defaultBranch}\n`
    + "    stack: [typescript]\n"
    + "    package_manager: npm\n"
    + '    commands: {build: null, test: "npm run test", lint: null, typecheck: null, run: null}\n'
    + "    ci: []\n"
    + "    confidence: high\n", "utf8");

  const store = RunStore.open(ws.runDir);
  store.mutate((run) => ({ ...run, repos: [...run.repos, name] }));
  store.save();
  return dir;
}

/** Give the run its branch and a handoff, and cut that branch in every named repo. */
function readyToShip(ws: BuildWorkspace, dirs: readonly string[]): void {
  const store = RunStore.open(ws.runDir);
  store.mutate((run) => ({ ...run, build: { epic_branch: [BRANCH] } }));
  store.save();
  mkdirSync(join(ws.runDir, "04-build"), { recursive: true });
  writeFileSync(join(ws.runDir, "04-build", "handoff.md"), HANDOFF, "utf8");
  for (const dir of dirs) git(dir, ["branch", BRANCH]);
}

interface Call {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

type Answer = { exitCode?: number; stdout?: string; stderr?: string };

/**
 * A transport that records every call and answers per `<cmd> <arg0> <arg1>` — and,
 * where the multi-repo cases need it, per CWD as well (`<key>@<dir basename>`), so
 * one repo can fail while another succeeds.
 */
function fakeTransport(answers: Readonly<Record<string, Answer>> = {}): ShipTransport & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async run(cmd, args, cwd) {
      calls.push({ cmd, args: [...args], cwd });
      const key = `${cmd} ${args.slice(0, 2).join(" ")}`;
      const repo = cwd.split("/").at(-1) ?? "";
      const answer = answers[`${key}@${repo}`] ?? answers[key] ?? answers[cmd];
      return { exitCode: answer?.exitCode ?? 0, stdout: answer?.stdout ?? "", stderr: answer?.stderr ?? "" };
    },
  };
}

/** Healthy answers: gh present, an origin, the branch pushed, no PR open yet. */
function healthy(overrides: Readonly<Record<string, Answer>> = {}) {
  return fakeTransport({
    "gh --version": { stdout: "gh version 2.62.0\n" },
    "git remote": { stdout: "origin\n" },
    "git ls-remote --heads": { stdout: `a1b2c3\trefs/heads/${BRANCH}\n` },
    "gh pr list": { stdout: "[]\n" },
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
    at: "2026-09-01T10:00:00Z",
    transport,
    ...extra,
  });
}

function creates(transport: { calls: Call[] }): Call[] {
  return transport.calls.filter((call) => call.cmd === "gh" && call.args[0] === "pr" && call.args[1] === "create");
}

function valueOf(call: Call | undefined, flag: string): string {
  const args = call?.args ?? [];
  const at = args.indexOf(flag);
  return at === -1 ? "" : args[at + 1] ?? "";
}

describe("tldrx ship across the repos a chained run shares a branch name in (#66)", () => {
  test("opens one PR per repo, with the repo in the title and the same handoff body", async () => {
    const ws = workspace();
    const api = addRepo(ws, "api");
    readyToShip(ws, [ws.repoDir, api]);

    const transport = healthy({
      "gh pr create@app": { stdout: "https://github.com/ederwii/app/pull/7\n" },
      "gh pr create@api": { stdout: "https://github.com/ederwii/api/pull/3\n" },
    });
    const outcome = await ship(ws, transport);

    expect(outcome.code).toBe(EXIT_OK);
    const opened = creates(transport);
    expect(opened.length).toBe(2);
    // In the order the run declares its repos, so two runs of the same command agree.
    expect(opened.map((call) => call.cwd)).toEqual([ws.repoDir, api]);
    // The repo name is IN the title, so a reviewer with three tabs open can tell them apart.
    expect(valueOf(opened[0], "--title")).toContain("app");
    expect(valueOf(opened[1], "--title")).toContain("api");
    // Same handoff, byte for byte, as the body of every one of them.
    for (const call of opened) {
      expect(valueOf(call, "--head")).toBe(BRANCH);
      expect(readFileSync(valueOf(call, "--body-file"), "utf8")).toBe(HANDOFF);
      // `Closes #66` and every other link in the handoff survives untouched.
      expect(readFileSync(valueOf(call, "--body-file"), "utf8")).toContain("Closes #66");
    }
    // Both URLs are printed at the end — the list is the point of the change.
    const text = outcome.lines.join("\n");
    expect(text).toContain("https://github.com/ederwii/app/pull/7");
    expect(text).toContain("https://github.com/ederwii/api/pull/3");
  });

  test("one repo is byte-identical to what it printed before (the common case)", async () => {
    const ws = workspace();
    readyToShip(ws, [ws.repoDir]);
    const transport = healthy();
    const outcome = await ship(ws, transport);

    expect(outcome.code).toBe(EXIT_OK);
    expect(outcome.lines).toEqual([
      `opened a PR for ${ws.runId} from \`${BRANCH}\` into \`main\` (app)`,
      "  https://github.com/ederwii/app/pull/7",
      "  body: 04-build/handoff.md",
      `  next: \`tldrx tickets sync --run ${ws.runId}\` mirrors the plan's epics and stories, `
        + "if this workspace configures a ticket tool.",
    ]);
    // The title is the run's, unadorned: nothing about one repo changes.
    expect(valueOf(creates(transport)[0], "--title")).toBe(RunStore.open(ws.runDir).run.title);
    // And no existing-PR probe is made on the path that never needed one.
    expect(transport.calls.some((call) => call.args[1] === "list")).toBe(false);
  });

  test("PR 2 of 3 failing names exactly which succeeded and which failed, and exits 2", async () => {
    const ws = workspace();
    const api = addRepo(ws, "api");
    const web = addRepo(ws, "web");
    readyToShip(ws, [ws.repoDir, api, web]);

    const transport = healthy({
      "gh pr create@app": { stdout: "https://github.com/ederwii/app/pull/7\n" },
      "gh pr create@api": { exitCode: 1, stderr: "pull request create failed: HTTP 403\n" },
      "gh pr create@web": { stdout: "https://github.com/ederwii/web/pull/2\n" },
    });
    const outcome = await ship(ws, transport);

    expect(outcome.code).toBe(EXIT_GATE_REFUSED);
    const text = outcome.lines.join("\n");
    // Both sides, by name. A failure that hides the successes cannot be re-run safely.
    expect(text).toContain("app");
    expect(text).toContain("https://github.com/ederwii/app/pull/7");
    expect(text).toContain("web");
    expect(text).toContain("https://github.com/ederwii/web/pull/2");
    expect(text).toContain("api");
    expect(text).toContain("HTTP 403");
    // The third repo was still attempted — one failure does not abandon the rest.
    expect(creates(transport).length).toBe(3);
  });

  test("re-running skips a repo whose PR is already open, and opens only the missing one", async () => {
    const ws = workspace();
    const api = addRepo(ws, "api");
    readyToShip(ws, [ws.repoDir, api]);

    const transport = healthy({
      "gh pr list@app": { stdout: '[{"url":"https://github.com/ederwii/app/pull/7"}]\n' },
      "gh pr list@api": { stdout: "[]\n" },
      "gh pr create@api": { stdout: "https://github.com/ederwii/api/pull/3\n" },
    });
    const outcome = await ship(ws, transport);

    expect(outcome.code).toBe(EXIT_OK);
    const opened = creates(transport);
    expect(opened.length).toBe(1);
    expect(opened[0]?.cwd).toBe(api);
    const text = outcome.lines.join("\n");
    // The already-open one is still listed, with its URL, and marked as not new.
    expect(text).toContain("https://github.com/ederwii/app/pull/7");
    expect(text).toContain("already");
    expect(text).toContain("https://github.com/ederwii/api/pull/3");
  });

  test("a repo whose branch is unpushed is reported, the others still open, nothing is pushed", async () => {
    const ws = workspace();
    const api = addRepo(ws, "api");
    readyToShip(ws, [ws.repoDir, api]);

    const transport = healthy({
      "git ls-remote --heads@api": { stdout: "" },
      "gh pr create@app": { stdout: "https://github.com/ederwii/app/pull/7\n" },
    });
    const outcome = await ship(ws, transport);

    expect(outcome.code).toBe(EXIT_GATE_REFUSED);
    const text = outcome.lines.join("\n");
    expect(text).toContain("https://github.com/ederwii/app/pull/7");
    expect(text).toContain(`push -u origin ${BRANCH}`);
    // Spec §5 holds per repo as much as it does for one.
    expect(transport.calls.some((call) => call.cmd === "git" && call.args[0] === "push")).toBe(false);
    expect(creates(transport).length).toBe(1);
  });

  test("--repo still narrows to one, and takes the single-repo path", async () => {
    const ws = workspace();
    const api = addRepo(ws, "api");
    readyToShip(ws, [ws.repoDir, api]);

    const transport = healthy();
    const outcome = await ship(ws, transport, { repo: "api" });

    expect(outcome.code).toBe(EXIT_OK);
    const opened = creates(transport);
    expect(opened.length).toBe(1);
    expect(opened[0]?.cwd).toBe(api);
    expect(valueOf(opened[0], "--title")).toBe(RunStore.open(ws.runDir).run.title);
  });

  test("--dry-run names every repo it would open a PR in, and creates none", async () => {
    const ws = workspace();
    const api = addRepo(ws, "api");
    readyToShip(ws, [ws.repoDir, api]);

    const transport = healthy();
    const outcome = await ship(ws, transport, { dryRun: true });

    expect(outcome.code).toBe(EXIT_OK);
    const text = outcome.lines.join("\n");
    expect(text).toContain("app");
    expect(text).toContain("api");
    expect(text).toContain("gh pr create");
    expect(creates(transport).length).toBe(0);
  });

  test("each repo's PR opens against ITS OWN default branch", async () => {
    const ws = workspace();
    const api = addRepo(ws, "api", "trunk");
    readyToShip(ws, [ws.repoDir, api]);

    const transport = healthy();
    expect((await ship(ws, transport)).code).toBe(EXIT_OK);
    const opened = creates(transport);
    expect(valueOf(opened[0], "--base")).toBe("main");
    expect(valueOf(opened[1], "--base")).toBe("trunk");
  });

  test("end to end through the CLI, against a stub gh on PATH", async () => {
    const ws = workspace();
    const api = addRepo(ws, "api");
    readyToShip(ws, [ws.repoDir, api]);

    for (const [dir, name] of [[ws.repoDir, "app"], [api, "api"]] as const) {
      const originDir = join(ws.root, `${name}-origin.git`);
      execFileSync("git", ["init", "--bare", "-b", "main", originDir], { stdio: "pipe" });
      git(dir, ["remote", "add", "origin", originDir]);
      git(dir, ["push", "-q", "origin", "main"]);
      git(dir, ["push", "-q", "origin", BRANCH]);
    }

    const record = join(ws.root, "gh-argv.txt");
    const stub = join(ws.binDir, "gh");
    writeFileSync(
      stub,
      [
        "#!/bin/sh",
        `for a in "$@"; do printf '%s\\n' "$a" >> ${JSON.stringify(record)}; done`,
        'case "$1" in',
        "  --version) echo \"gh version 2.62.0\";;",
        '  *) case "$2" in list) echo "[]";; *) echo "https://github.com/ederwii/x/pull/1";; esac;;',
        "esac",
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
    expect(stderr).toBe("");
    expect(await proc.exited).toBe(EXIT_OK);
    expect(stdout).toContain("app");
    expect(stdout).toContain("api");

    const argv = readFileSync(record, "utf8").split("\n").filter((line) => line !== "");
    expect(argv.filter((word) => word === "create").length).toBe(2);
  });
});
