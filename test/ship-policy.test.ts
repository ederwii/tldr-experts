/**
 * `ship:` on a run — push the epic, open the PR, arm the merge (gh #253).
 *
 * The measurement behind it: two real runs, $89.82 and $26.38, neither of which
 * could end in a PR toward main whatever it spent. Every preset ended at `watch`,
 * and the verb that opens a PR refused to push the branch it opens it for. The
 * last mile — the only one the owner's sentence names — was a person typing
 * `git push -u origin epic/<slug>`, then `tldrx ship`, then watching the checks.
 *
 * What these tests hold:
 *
 *   ADDITIVE          a run.yml with no `ship:` loads exactly as before, and a
 *                     `tldrx ship` on such a run pushes NOTHING — the refusal that
 *                     names the `git push` command is unchanged.
 *   ORDERED           `push -u origin <branch>` → `pr create` → `pr view` (the
 *                     checks probe) → `pr merge --auto`, recorded off a fake
 *                     transport, in that order and no other.
 *   NO CHECKS, NO MERGE  a repo whose PR reports no check at all is NOT merged:
 *                     `run.yml` says `merge: absent — no checks to wait on` (§7,
 *                     absent-with-reason) and `pr merge` is never called.
 *   ONE PUSH WRAPPER  `pushBranch` lives in `core/build/git.ts` and has exactly
 *                     one caller, `core/run/ship.ts` — the Build seam keeps its
 *                     "no push wrapper anywhere in the phase" (spec §5).
 *   END TO END        a `--gates none --ship merge` run driven by `run auto`
 *                     pushes to a real bare origin, opens the PR through a stub
 *                     `gh` on PATH, and `run.finished` carries the URL.
 *
 * Nothing here runs the real `gh` or touches a network: the unit cases drive a
 * recording `ShipTransport`, and the end-to-end case's `gh` is a shell script
 * that writes its argv to a file. Every `git push` that happens for real goes to
 * a bare repository inside the test's own temp directory.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";
import { shipRun, type ShipTransport } from "../src/core/run/ship.ts";
import {
  AUTO_MERGE_POLICIES, MERGE_QUEUED, NO_CHECKS_TO_WAIT_ON, parseShipFlag, ShipPolicyError, shipWanted,
} from "../src/core/run/shipPolicy.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { validateRunFile, type RunFile } from "../src/core/run/RunFile.ts";
import { renderBuildHandoff } from "../src/core/build/handoff.ts";
import type { StoryOutcome } from "../src/core/build/outcome.ts";
import { EXIT_GATE_REFUSED, EXIT_OK } from "../src/cli/exitCodes.ts";
import { runAuto } from "../src/core/facilitator/runAuto.ts";
import { makeBuildWorkspace, type BuildWorkspace, type BuildWorkspaceOptions } from "./fixtures/build/workspace.ts";
import {
  cannedHandoff, cannedIntent, makeFacilitatorWorkspace, type FacilitatorWorkspace, type StageOptions,
} from "./fixtures/facilitator/workspace.ts";
import { deliveredTo, writeNotifier, workspaceYamlWithNotify } from "./fixtures/facilitator/notifier.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";
import { HELP_ENTRIES } from "../src/cli/helpText.ts";

setDefaultTimeout(spawnTestTimeout(90_000));

const ORIGINAL_PATH = process.env.PATH ?? "";
const FAKE_KEYS = ["FAKE_CLAUDE_RUNDIR", "FAKE_CLAUDE_OUTPUTS", "FAKE_CLAUDE_COST"] as const;

let open: { dispose: () => void }[] = [];

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  for (const key of FAKE_KEYS) delete process.env[key];
  for (const ws of open) ws.dispose();
  open = [];
});

// ---------------------------------------------------------------------------
// Fixtures — the same shape `test/ship.test.ts` ships from
// ---------------------------------------------------------------------------

const ONE: BuildWorkspaceOptions = {
  stories: [{ id: "S1", epic: "E1", title: "First story" }],
  epics: [{ id: "E1", stories: ["S1"], branch: "epic/e1" }],
  waves: [["S1"]],
};

function outcome(id: string, title: string, status: "done" | "review"): StoryOutcome {
  return {
    id, title, status,
    wave: "W1", repo: "app", epic: "E1", epicBranch: "epic/e1", branch: `story/${id}`, attempts: 1,
    dod: [{ command: "npm run test", exitCode: 0, timedOut: false, tail: "ok" }],
    commit: status === "done" ? "abc1234" : null,
    merged: status === "done",
    carried: status === "done" ? 3 : 0,
    conflicts: [],
    verdict: status === "done" ? "approve" : "changes",
    developerError: null, reviewSummary: "", reviewFindings: [], reviewRel: `04-build/log/${id}.md`,
    reason: status === "done" ? null : "the reviewer asked for changes",
    rescued: null, cost_usd: 0.21,
  };
}

const HANDOFF = renderBuildHandoff({
  runId: "260829-build", stageId: "build", model: "sonnet", costUsd: 0.42, budgetUsd: 8,
  at: "2026-08-31T10:00:00Z",
  outcomes: [outcome("S1", "First story", "done"), outcome("S2", "Second story", "review")],
  epics: [{ id: "E1", branch: "epic/e1", repos: ["app"], merged: ["S1"], defaultBranches: ["main"], rel: "03-plan/epics/E1.md" }],
});

function git(dir: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function settleFirstStory(ws: BuildWorkspace): void {
  const dir = join(ws.runDir, "03-plan", "stories");
  for (const path of readdirSync(dir).sort().map((name) => join(dir, name))) {
    const text = readFileSync(path, "utf8");
    if (!/^status: todo$/m.test(text)) continue;
    writeFileSync(path, text
      .replace(/^status: todo$/m, "status: done")
      .replace(/^evidence: \[\]$/m, 'evidence: ["04-build/handoff.md:1"]'), "utf8");
    return;
  }
}

/** A Build workspace with an epic branch, a handoff, and — when given — a `ship:` block. */
function shippable(ship: RunFile["ship"] | null): BuildWorkspace {
  const ws = makeBuildWorkspace(ONE);
  open.push(ws);
  settleFirstStory(ws);
  const store = RunStore.open(ws.runDir);
  store.mutate((run) => ({ ...run, build: { epic_branch: ["epic/e1"] }, ...(ship === null ? {} : { ship }) }));
  store.save();
  mkdirSync(join(ws.runDir, "04-build"), { recursive: true });
  writeFileSync(join(ws.runDir, "04-build", "handoff.md"), HANDOFF, "utf8");
  git(ws.repoDir, ["branch", "epic/e1"]);
  git(ws.repoDir, ["remote", "add", "origin", join(ws.root, "origin.git")]);
  return ws;
}

interface Call { readonly cmd: string; readonly args: readonly string[]; readonly cwd: string }

type Answer = { exitCode?: number; stdout?: string; stderr?: string };

/**
 * Records every call; answers from a table keyed `<cmd> <arg0> <arg1>@<repo>` first
 * (the cwd's last segment — the same keying `test/ship-multi-repo.test.ts` uses,
 * so one repo can fail while another succeeds), then `<cmd> <arg0> <arg1>`, then `<cmd>`.
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

/**
 * A SECOND product repo in the same workspace, declared in `workspace.yml` and on
 * the run — the shape a chained multi-repo run has (`test/ship-multi-repo.test.ts`
 * builds it the same way), with the epic branch already cut in it.
 */
function addRepo(ws: BuildWorkspace, name: string): string {
  const dir = join(ws.root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "README.md"), `# ${name}\n`, "utf8");
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "fixture@example.com"]);
  git(dir, ["config", "user.name", "tldrx fixture"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "chore: fixture repo"]);
  git(dir, ["branch", "epic/e1"]);
  const path = join(ws.root, ".tldrx", "workspace.yml");
  writeFileSync(path, `${readFileSync(path, "utf8").trimEnd()}\n`
    + `  - name: ${name}\n    path: ${name}\n    default_branch: main\n    stack: [typescript]\n`
    + "    package_manager: npm\n"
    + '    commands: {build: null, test: "npm run test", lint: null, typecheck: null, run: null}\n'
    + "    ci: []\n    confidence: high\n", "utf8");
  const store = RunStore.open(ws.runDir);
  store.mutate((run) => ({ ...run, repos: [...run.repos, name] }));
  store.save();
  return dir;
}

const PR_URL = "https://github.com/ederwii/app/pull/9";
const ROLLUP_WITH_CI = JSON.stringify({ statusCheckRollup: [{ name: "ci", status: "IN_PROGRESS", conclusion: null }] });
const ROLLUP_EMPTY = JSON.stringify({ statusCheckRollup: [] });

/** The answers a repo with checks gives: the branch lands on the remote, gh opens the PR. */
function answersWithChecks(rollup = ROLLUP_WITH_CI): Record<string, Answer> {
  return {
    "gh --version": { stdout: "gh version 2.62.0" },
    "git remote": { stdout: "origin\n" },
    "git ls-remote --heads": { stdout: "abc123\trefs/heads/epic/e1" },
    "gh pr create": { stdout: PR_URL },
    "gh pr view": { stdout: rollup },
    "gh pr list": { stdout: "[]" },
  };
}

/** The calls that matter, as `<cmd> <arg0> <arg1>` — the order is the property. */
function shape(calls: readonly Call[]): readonly string[] {
  return calls
    .map((call) => `${call.cmd} ${call.args.slice(0, 2).join(" ")}`)
    .filter((line) => /^git push|^gh pr (create|view|merge)/.test(line));
}

function ship(ws: BuildWorkspace, transport: ShipTransport) {
  return shipRun({
    root: ws.root, runId: ws.runId, actor: "alan", at: "2026-09-12T10:00:00Z", transport, checksGraceMs: 0,
  });
}

// ---------------------------------------------------------------------------
// (a) The flag and the block — one derivation, additive on run.yml
// ---------------------------------------------------------------------------

describe("`run new --ship <push|pr|merge>` is one derivation", () => {
  test("the three levels are nested: push < pr < merge", () => {
    expect(parseShipFlag("push")).toEqual({ push: true, pr: false, auto_merge: "never" });
    expect(parseShipFlag("pr")).toEqual({ push: true, pr: true, auto_merge: "never" });
    expect(parseShipFlag("merge")).toEqual({ push: true, pr: true, auto_merge: "checks" });
  });

  test("anything else is refused by name, never defaulted to a level that pushes", () => {
    expect(() => parseShipFlag("auto")).toThrow(ShipPolicyError);
    expect(() => parseShipFlag("")).toThrow(ShipPolicyError);
    expect(() => parseShipFlag("yes")).toThrow(/push \| pr \| merge/);
  });

  test("`auto_merge` is a closed set", () => {
    expect([...AUTO_MERGE_POLICIES]).toEqual(["never", "checks"]);
  });
});

describe("`ship:` is an additive `version: 1` key on run.yml", () => {
  function minimalRun(extra: Record<string, unknown>): Record<string, unknown> {
    return {
      version: 1, run: "260912-demo", title: "Demo", scope: "feature", workflow: "feature", repos: [],
      created_at: "2026-09-12T09:00:00Z", updated_at: "2026-09-12T09:00:00Z", status: "pending",
      cursor: { phase: "01-what", stage: "what", task: null },
      budget: { ceiling_usd: 10, spent_usd: 0, per_agent_max_usd: 2 },
      phases: [{
        id: "01-what", status: "pending",
        stages: [{
          id: "what", status: "pending", expert: null, model: "sonnet", budget_usd: 10, cost_usd: 0,
          started_at: null, ended_at: null, inputs: [], outputs: [],
          gate: { type: "approve", status: "pending", by: null, at: null, note: "" }, tasks: [],
        }],
      }],
      ...extra,
    };
  }

  test("absent loads as before, and means: push nothing, open nothing", () => {
    const run = minimalRun({});
    expect(validateRunFile(run).ok).toBe(true);
    expect(shipWanted(run as unknown as RunFile)).toBe(false);
  });

  test("a well-formed block loads, with its record keys when present", () => {
    const policy = minimalRun({ ship: { push: true, pr: true, auto_merge: "checks" } });
    expect(validateRunFile(policy).ok).toBe(true);
    expect(shipWanted(policy as unknown as RunFile)).toBe(true);
    const recorded = minimalRun({
      ship: { push: true, pr: true, auto_merge: "checks", pr_urls: [PR_URL], merge: MERGE_QUEUED, shipped_at: "2026-09-12T10:00:00Z" },
    });
    expect(validateRunFile(recorded).ok).toBe(true);
    expect(shipWanted(recorded as unknown as RunFile)).toBe(false);
  });

  test("the block SURVIVES a save — run.yml is emitted key by key, and this key is one of them", () => {
    // Measured red on the first end-to-end run: `run new --ship merge` wrote the
    // block, the first `RunStore.save` (the one `run new` itself makes through the
    // fixture) dropped it, and the loop believed the run had never asked.
    const ws = makeBuildWorkspace(ONE);
    open.push(ws);
    const store = RunStore.open(ws.runDir);
    store.mutate((run) => ({ ...run, ship: { push: true, pr: true, auto_merge: "checks" } }));
    store.save();
    expect(RunStore.open(ws.runDir).run.ship).toEqual({ push: true, pr: true, auto_merge: "checks" });
    expect(readFileSync(join(ws.runDir, "run.yml"), "utf8")).toContain("ship: {push: true, pr: true, auto_merge: checks}");

    const again = RunStore.open(ws.runDir);
    again.mutate((run) => ({
      ...run, ship: { ...run.ship!, pr_urls: [PR_URL], merge: MERGE_QUEUED, shipped_at: "2026-09-12T10:00:00Z" },
    }));
    again.save();
    expect(RunStore.open(ws.runDir).run.ship?.pr_urls).toEqual([PR_URL]);
    expect(RunStore.open(ws.runDir).run.ship?.shipped_at).toBe("2026-09-12T10:00:00Z");
  });

  test("an unknown `auto_merge` is a schema error, never a silent `never`", () => {
    const result = validateRunFile(minimalRun({ ship: { push: true, pr: true, auto_merge: "always" } }));
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.path)).toContain("ship.auto_merge");
  });

  test("a block missing a policy key is a schema error", () => {
    const result = validateRunFile(minimalRun({ ship: { push: true } }));
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.path)).toContain("ship.pr");
  });
});

// ---------------------------------------------------------------------------
// (b) `tldrx ship` under a policy — ordered, and guarded both ways
// ---------------------------------------------------------------------------

describe("`tldrx ship` under `ship: {push, pr, auto_merge: checks}`", () => {
  test("pushes, opens, probes the checks, arms the merge — in that order", async () => {
    const ws = shippable({ push: true, pr: true, auto_merge: "checks" });
    const transport = fakeTransport(answersWithChecks());

    const out = await ship(ws, transport);

    expect(out.lines.join("\n")).toContain(PR_URL);
    expect(out.code).toBe(EXIT_OK);
    expect(shape(transport.calls)).toEqual(["git push -u", "gh pr create", "gh pr view", "gh pr merge"]);

    const push = transport.calls.find((call) => call.cmd === "git" && call.args[0] === "push");
    expect(push?.args).toEqual(["push", "-u", "origin", "epic/e1"]);
    expect(push?.cwd).toBe(ws.repoDir);
    const merge = transport.calls.find((call) => call.cmd === "gh" && call.args[1] === "merge");
    expect(merge?.args).toEqual(["pr", "merge", PR_URL, "--auto", "--merge"]);

    // The record: what was done, on the run, so `run status` can answer "did it land".
    const record = RunStore.open(ws.runDir).run.ship;
    expect(record?.pr_urls).toEqual([PR_URL]);
    expect(record?.merge).toBe(MERGE_QUEUED);
    expect(typeof record?.shipped_at).toBe("string");
  });

  test("a PR that reports NO check is not merged, and the record says why", async () => {
    const ws = shippable({ push: true, pr: true, auto_merge: "checks" });
    const transport = fakeTransport(answersWithChecks(ROLLUP_EMPTY));

    const out = await ship(ws, transport);

    expect(out.code).toBe(EXIT_OK);
    expect(shape(transport.calls)).toEqual(["git push -u", "gh pr create", "gh pr view"]);
    expect(RunStore.open(ws.runDir).run.ship?.merge).toBe(NO_CHECKS_TO_WAIT_ON);
    expect(out.lines.join("\n")).toContain(NO_CHECKS_TO_WAIT_ON);
  });

  test("`auto_merge: never` opens the PR and never asks about checks", async () => {
    const ws = shippable({ push: true, pr: true, auto_merge: "never" });
    const transport = fakeTransport(answersWithChecks());

    const out = await ship(ws, transport);

    expect(out.code).toBe(EXIT_OK);
    expect(shape(transport.calls)).toEqual(["git push -u", "gh pr create"]);
    expect(RunStore.open(ws.runDir).run.ship?.merge).toBe("never");
  });

  test("`--ship push` publishes the branch and opens nothing", async () => {
    const ws = shippable({ push: true, pr: false, auto_merge: "never" });
    const transport = fakeTransport(answersWithChecks());

    const out = await ship(ws, transport);

    expect(out.code).toBe(EXIT_OK);
    expect(shape(transport.calls)).toEqual(["git push -u"]);
    expect(RunStore.open(ws.runDir).run.ship?.pr_urls).toEqual([]);
    expect(out.lines.join("\n")).toContain("pushed `epic/e1`");
  });

  test("a push git refuses is a refusal naming it, and no PR is opened", async () => {
    const ws = shippable({ push: true, pr: true, auto_merge: "checks" });
    const transport = fakeTransport({
      ...answersWithChecks(),
      "git push -u": { exitCode: 1, stderr: "! [rejected] epic/e1 -> epic/e1 (non-fast-forward)" },
    });

    const out = await ship(ws, transport);

    expect(out.code).toBe(EXIT_GATE_REFUSED);
    expect(shape(transport.calls)).toEqual(["git push -u"]);
    expect(out.lines.join("\n")).toContain("non-fast-forward");
  });

  test("GUARD: a run with no `ship:` block pushes nothing — the old refusal, byte for byte", async () => {
    const ws = shippable(null);
    const transport = fakeTransport({
      "gh --version": { stdout: "gh version 2.62.0" }, "git remote": { stdout: "origin\n" },
    });

    const out = await ship(ws, transport);

    expect(out.code).toBe(EXIT_GATE_REFUSED);
    expect(shape(transport.calls)).toEqual([]);
    expect(out.lines.join("\n")).toContain("git -C");
    expect(out.lines.join("\n")).toContain("push -u origin epic/e1");
    expect(RunStore.open(ws.runDir).run.ship).toBeUndefined();
  });

  // Reviewer finding on 1fdc250 (CONFIRMED): the merge was armed for `opened` repos
  // only. A transient failure in repo A beside a success in B recorded
  // `app: failed…; api: queued` and exit 2; the documented recovery — run `tldrx
  // ship` again — then saw both PRs as `existing`, armed neither, overwrote the
  // record's `merge` with "" and exited 0. A recorded failure erased by the
  // command that was supposed to fix it is §7's dangerous direction exactly.
  describe("re-running after a merge that failed in one repo (review of 1fdc250)", () => {
    const URL_APP = "https://github.com/ederwii/app/pull/7";
    const URL_API = "https://github.com/ederwii/api/pull/3";

    function twoRepos(): BuildWorkspace {
      const ws = shippable({ push: true, pr: true, auto_merge: "checks" });
      addRepo(ws, "api");
      return ws;
    }
    const firstAnswers = (): Record<string, Answer> => ({
      ...answersWithChecks(),
      "gh pr create@app": { stdout: URL_APP },
      "gh pr create@api": { stdout: URL_API },
      "gh pr merge@app": { exitCode: 1, stderr: "GraphQL: something went wrong (transient)" },
    });
    const secondAnswers = (appMerge: Answer): Record<string, Answer> => ({
      ...answersWithChecks(),
      "gh pr list@app": { stdout: JSON.stringify([{ url: URL_APP }]) },
      "gh pr list@api": { stdout: JSON.stringify([{ url: URL_API }]) },
      "gh pr merge@app": appMerge,
    });
    const merges = (calls: readonly Call[]): readonly Call[] =>
      calls.filter((c) => c.cmd === "gh" && c.args[0] === "pr" && c.args[1] === "merge");

    test("the first ship records the failure per repo and exits 2", async () => {
      const ws = twoRepos();
      const out = await ship(ws, fakeTransport(firstAnswers()));
      expect(out.code).toBe(EXIT_GATE_REFUSED);
      const record = RunStore.open(ws.runDir).run.ship;
      expect(record?.pr_urls).toEqual([URL_APP, URL_API]);
      expect(record?.merges?.api).toBe(MERGE_QUEUED);
      expect(record?.merges?.app).toMatch(/^failed — /);
      expect(record?.merge).toContain("transient");
    });

    test("the second ship arms the repo that failed, leaves the queued one alone, and the record shows both", async () => {
      const ws = twoRepos();
      await ship(ws, fakeTransport(firstAnswers()));

      const again = fakeTransport(secondAnswers({ exitCode: 0 }));
      const out = await ship(ws, again);

      expect(out.code).toBe(EXIT_OK);
      const armed = merges(again.calls);
      expect(armed.map((c) => c.args[2])).toEqual([URL_APP]);
      expect(armed[0]?.cwd).toBe(ws.repoDir);
      expect(again.calls.some((c) => c.cmd === "gh" && c.args[1] === "create")).toBe(false);
      const record = RunStore.open(ws.runDir).run.ship;
      expect(record?.merges).toEqual({ app: MERGE_QUEUED, api: MERGE_QUEUED });
      expect(record?.merge).toBe(MERGE_QUEUED);
      expect(record?.pr_urls).toEqual([URL_APP, URL_API]);
    });

    test("a second ship in which the arm STILL fails keeps the failure on record and exits 2 — never an empty merge", async () => {
      const ws = twoRepos();
      await ship(ws, fakeTransport(firstAnswers()));

      const out = await ship(ws, fakeTransport(secondAnswers({ exitCode: 1, stderr: "GraphQL: still broken" })));

      expect(out.code).toBe(EXIT_GATE_REFUSED);
      const record = RunStore.open(ws.runDir).run.ship;
      expect(record?.merges?.app).toContain("still broken");
      expect(record?.merges?.api).toBe(MERGE_QUEUED);
      expect(record?.merge).not.toBe("");
      expect(record?.merge).toContain("still broken");
    });

    test("ONE repo: a PR already open is re-armed on the next ship rather than refused by `gh pr create`", async () => {
      const ws = shippable({ push: true, pr: true, auto_merge: "checks" });
      const first = fakeTransport({ ...answersWithChecks(), "gh pr merge": { exitCode: 1, stderr: "GraphQL: transient" } });
      const out1 = await ship(ws, first);
      expect(out1.code).toBe(EXIT_GATE_REFUSED);
      expect(RunStore.open(ws.runDir).run.ship?.merges?.app).toMatch(/^failed — /);

      const second = fakeTransport({ ...answersWithChecks(), "gh pr list": { stdout: JSON.stringify([{ url: PR_URL }]) } });
      const out2 = await ship(ws, second);

      expect(out2.code).toBe(EXIT_OK);
      expect(second.calls.some((c) => c.cmd === "gh" && c.args[1] === "create")).toBe(false);
      expect(merges(second.calls).map((c) => c.args[2])).toEqual([PR_URL]);
      expect(RunStore.open(ws.runDir).run.ship?.merges).toEqual({ app: MERGE_QUEUED });
      expect(out2.lines.join("\n")).toContain(PR_URL);
    });
  });

  test("a run already shipped is not shipped twice", async () => {
    const ws = shippable({
      push: true, pr: true, auto_merge: "checks", pr_urls: [PR_URL], merge: MERGE_QUEUED, shipped_at: "2026-09-12T09:00:00Z",
    });
    expect(shipWanted(RunStore.open(ws.runDir).run)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (b2) The help text says what the verb now does to the run (review of 1fdc250)
// ---------------------------------------------------------------------------

describe("`tldrx ship --help` is truthful about run.yml", () => {
  test("it no longer claims to be read-only about the run, and names the record it writes", () => {
    const entry = HELP_ENTRIES.find((command) => command.name === "ship");
    const notes = (entry?.notes ?? []).join("\n");
    expect(notes).not.toContain("read-only about the run");
    expect(notes).toContain("`shipped_at`");
    expect(notes).toContain("never writes to the run");
  });
});

// ---------------------------------------------------------------------------
// (c) One push wrapper, one caller (spec §5, the #80 shape family)
// ---------------------------------------------------------------------------

describe("the ONE `git push` wrapper", () => {
  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
      else if (name.endsWith(".ts")) out.push(path);
    }
    return out;
  }
  const src = join(FRAMEWORK_ROOT, "src");
  const rel = (path: string): string => path.slice(src.length + 1);

  test("`pushBranch` is defined in core/build/git.ts and called from core/run/ship.ts alone", () => {
    const defined = sourceFiles(src).filter((path) => /export async function pushBranch\(/.test(readFileSync(path, "utf8")));
    expect(defined.map(rel)).toEqual(["core/build/git.ts"]);
    const callers = sourceFiles(src)
      .filter((path) => !path.endsWith("core/build/git.ts"))
      .filter((path) => /\bpushBranch\(/.test(readFileSync(path, "utf8")));
    expect(callers.map(rel)).toEqual(["core/run/ship.ts"]);
  });

  test("no other file spells a `git push` argv — `stash push` is a different verb", () => {
    const spellers = sourceFiles(src)
      .filter((path) => !path.endsWith("core/build/git.ts"))
      // An ARGV: `git(["push"…` or `"git", ["push"…`. The word alone is also a
      // policy level and a schema key, which is not what this pins.
      .filter((path) => /(?:git\(|"git",\s*)\[\s*"push"/.test(readFileSync(path, "utf8")));
    expect(spellers.map(rel)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (d) End to end: `run auto` on a `--gates none` run with `--ship merge`
// ---------------------------------------------------------------------------

const ALPHA: StageOptions = {
  id: "alpha", phase: "01-what", budgetUsd: 6, gate: "approve",
  outputs: [
    { path: "01-what/intent.md", sections: ["Intent", "Scope"] },
    { path: "01-what/handoff.md", sections: ["Findings", "Decisions", "Unknowns", "Evidence ledger"] },
  ],
};
const BETA: StageOptions = {
  id: "beta", phase: "02-how", budgetUsd: 4, gate: "approve",
  outputs: [{ path: "02-how/handoff.md", sections: ["Findings", "Decisions", "Unknowns", "Evidence ledger"] }],
};

interface AutoMade extends FacilitatorWorkspace {
  readonly outbox: string;
  readonly ghArgv: string;
  readonly originDir: string;
}

/**
 * A `--gates none` run with a real git repo at `api/`, a bare origin beside it, an
 * epic branch Build "cut", and a stub `gh` first on PATH. `git` is the real one:
 * the push lands in the bare repo, which is how the test measures it.
 */
function autoWorkspace(shipFlag: string | null): AutoMade {
  const made = makeFacilitatorWorkspace({
    scope: "demo", stages: [ALPHA, BETA], budgetUsd: 10, gatesFlag: "none", shipFlag: shipFlag ?? undefined,
  });
  open.push(made);
  const outbox = join(made.root, "notified.jsonl");
  writeFileSync(
    join(made.root, ".tldrx", "workspace.yml"),
    workspaceYamlWithNotify(`${writeNotifier(made.root)} ${outbox}`),
    "utf8",
  );

  const api = join(made.root, "api");
  git(api, ["init", "-q", "-b", "main"]);
  git(api, ["config", "user.email", "t@example.com"]);
  git(api, ["config", "user.name", "t"]);
  writeFileSync(join(api, "README.md"), "# api\n", "utf8");
  git(api, ["add", "."]);
  git(api, ["commit", "-q", "-m", "init"]);
  const originDir = join(made.root, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", originDir], { stdio: "pipe" });
  git(api, ["remote", "add", "origin", originDir]);
  git(api, ["push", "-q", "origin", "main"]);
  git(api, ["branch", "epic/demo"]);

  const store = RunStore.open(made.runDir);
  store.mutate((run) => ({ ...run, build: { epic_branch: ["epic/demo"] } }));
  store.save();

  const ghArgv = join(made.root, "gh-argv.txt");
  const stub = join(made.binDir, "gh");
  writeFileSync(stub, [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> ${JSON.stringify(ghArgv)}`,
    'case "$1 $2" in',
    '  "--version ") echo "gh version 2.62.0";;',
    '  "pr create") echo "https://github.com/ederwii/api/pull/9";;',
    `  "pr view") echo '${ROLLUP_WITH_CI}';;`,
    '  "pr list") echo "[]";;',
    "esac",
    "exit 0",
    "",
  ].join("\n"), "utf8");
  chmodSync(stub, 0o755);

  process.env.PATH = `${made.binDir}:${ORIGINAL_PATH}`;
  process.env.FAKE_CLAUDE_RUNDIR = made.runDir;
  process.env.FAKE_CLAUDE_OUTPUTS = JSON.stringify({
    "01-what/intent.md": cannedIntent(),
    "01-what/handoff.md": cannedHandoff(),
    "02-how/handoff.md": cannedHandoff(),
  });
  process.env.FAKE_CLAUDE_COST = "0.42";
  return { ...made, outbox, ghArgv, originDir };
}

describe("`run auto` ships when the run closes under it", () => {
  test("--gates none --ship merge: push lands on origin, the PR opens, the merge is armed, run.finished names the URL", async () => {
    const ws = autoWorkspace("merge");

    const out = await runAuto({ root: ws.root, yolo: false, actor: "alan", at: "2026-09-12T09:00:00Z" });

    expect(out.code).toBe(EXIT_OK);
    // Measured on the bare repo, not on a log line: the branch is THERE.
    expect(git(ws.originDir, ["rev-parse", "--verify", "refs/heads/epic/demo"])).not.toBe("");

    const gh = readFileSync(ws.ghArgv, "utf8").split("\n").filter((line) => line !== "");
    const at = (prefix: string): number => gh.findIndex((line) => line.startsWith(prefix));
    expect(at("pr create")).toBeGreaterThan(-1);
    expect(at("pr view")).toBeGreaterThan(at("pr create"));
    expect(at("pr merge")).toBeGreaterThan(at("pr view"));
    expect(gh.find((line) => line.startsWith("pr merge"))).toContain("--auto --merge");

    const finished = deliveredTo(ws.outbox).find((payload) => payload.kind === "run.finished");
    expect(finished).toBeDefined();
    const detail = finished?.detail as Record<string, unknown>;
    expect(detail.pr_url).toBe("https://github.com/ederwii/api/pull/9");
    expect(detail.merge).toBe(MERGE_QUEUED);
    expect(String(finished?.summary)).toContain("https://github.com/ederwii/api/pull/9");

    expect(RunStore.open(ws.runDir).run.ship?.pr_urls).toEqual(["https://github.com/ederwii/api/pull/9"]);
    expect(out.lines.some((line) => line.includes("https://github.com/ederwii/api/pull/9"))).toBe(true);
  });

  test("GUARD: no --ship ⇒ nothing is pushed, nothing is opened, the loop's lines are what they were", async () => {
    const ws = autoWorkspace(null);

    const out = await runAuto({ root: ws.root, yolo: false, actor: "alan", at: "2026-09-12T09:00:00Z" });

    expect(out.code).toBe(EXIT_OK);
    expect(() => git(ws.originDir, ["rev-parse", "--verify", "refs/heads/epic/demo"])).toThrow();
    expect(existsSync(ws.ghArgv)).toBe(false);
    const finished = deliveredTo(ws.outbox).find((payload) => payload.kind === "run.finished");
    expect((finished?.detail as Record<string, unknown>).pr_url).toBeUndefined();
    expect(RunStore.open(ws.runDir).run.ship).toBeUndefined();
  });
});
