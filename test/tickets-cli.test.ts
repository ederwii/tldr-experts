/**
 * `tldrx tickets` through the real binary.
 *
 * Only the paths that make ZERO outbound calls are driven end to end here — a
 * disabled adapter, missing Jira credentials, `--dry-run`, and `status`. The
 * paths that would talk to `gh` or to Jira are covered in `tickets.test.ts`
 * against injected fakes, because a CLI test that shelled out for real would file
 * issues in somebody's tracker the first time CI ran.
 *
 * `PATH` is deliberately left alone: none of these cases may reach `gh` at all,
 * and a test that has to neutralise a binary is a test that expected to call it.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";
import { EXIT_OK, EXIT_USAGE } from "../src/cli/exitCodes.ts";
import { JIRA_ENV_VARS } from "../src/core/adapters/index.ts";
import { makeFacilitatorWorkspace, type FacilitatorWorkspace } from "./fixtures/facilitator/workspace.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

// Every test in this file spawns a REAL process — git, `bun`, the CLI. Process cost is a
// property of the machine, not of the code, so bun's fixed 5000 ms default measures the box:
// on an untouched tree, tests here timed out while the same files passed alone (#43). The
// budget scales with measured load; the assertions are untouched, and a hang is still caught.
setDefaultTimeout(spawnTestTimeout());

const BIN = join(FRAMEWORK_ROOT, "bin", "tldrx.ts");

let open: FacilitatorWorkspace[] = [];
afterEach(() => {
  for (const ws of open) ws.dispose();
  open = [];
});

interface Result {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** `env` REPLACES the child's environment, so a stray JIRA_* on the dev box cannot leak in. */
async function tldrx(cwd: string, env: Record<string, string>, ...args: string[]): Promise<Result> {
  const proc = Bun.spawn(["bun", BIN, ...args], {
    cwd, stdout: "pipe", stderr: "pipe",
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

const STORY = [
  "---",
  "version: 1",
  "id: S1",
  "epic: E1",
  'title: "Leaderboard read model"',
  "repo: lab",
  "status: todo",
  "depends_on: []",
  'touches: ["src/features/leaderboard/"]',
  "acceptance:",
  '  - "Top-50 ranks render"',
  "test_plan:",
  '  - "Unit: rank ordering"',
  "evidence: []",
  "---",
  "",
  "# S1 · Leaderboard read model",
  "",
].join("\n");

const EPIC = [
  "---",
  "version: 1",
  "id: E1",
  'title: "Player leaderboard"',
  "repos: [lab]",
  "stories: [S1]",
  "branch: epic/leaderboard",
  "status: todo",
  "---",
  "",
  "# E1 · Player leaderboard",
  "",
].join("\n");

function workspace(processYml: string | null): FacilitatorWorkspace {
  const ws = makeFacilitatorWorkspace({
    scope: "tickets",
    stages: [{ id: "what", phase: "01-what", budgetUsd: 1 }],
  });
  open.push(ws);
  const planDir = join(ws.runDir, "03-plan");
  mkdirSync(join(planDir, "stories"), { recursive: true });
  mkdirSync(join(planDir, "epics"), { recursive: true });
  writeFileSync(join(planDir, "stories", "S1.md"), STORY, "utf8");
  writeFileSync(join(planDir, "epics", "E1.md"), EPIC, "utf8");
  if (processYml !== null) writeFileSync(join(ws.root, ".tldrx", "process.yml"), processYml, "utf8");
  return ws;
}

function storyText(ws: FacilitatorWorkspace): string {
  return readFileSync(join(ws.runDir, "03-plan", "stories", "S1.md"), "utf8");
}

describe("tldrx tickets sync", () => {
  test("a `none` ticket tool exits 0 and says the adapter is disabled", async () => {
    const ws = workspace("version: 1\nticket_tool: {kind: none, project: null, board: null, sync: mirror-out}\n");
    const before = storyText(ws);
    const result = await tldrx(ws.root, {}, "tickets", "sync");
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toContain("adapter disabled");
    expect(storyText(ws)).toBe(before);
  });

  test("no process.yml at all is also `disabled`, not an error", async () => {
    const ws = workspace(null);
    const result = await tldrx(ws.root, {}, "tickets", "sync");
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toContain("adapter disabled");
  });

  test("jira with no credentials exits 1, names all three env vars, and writes nothing", async () => {
    const ws = workspace("version: 1\nticket_tool: {kind: jira, project: APP, board: null, sync: two-way}\n");
    const before = storyText(ws);
    const result = await tldrx(ws.root, {}, "tickets", "sync");
    expect(result.code).toBe(EXIT_USAGE);
    for (const name of JIRA_ENV_VARS) expect(result.stderr).toContain(name);
    expect(result.stderr).toContain("Nothing was written.");
    expect(result.stdout).toBe("");
    expect(storyText(ws)).toBe(before);
  });

  test("a ticket tool with no project key exits 1 before reading the plan", async () => {
    const ws = workspace("version: 1\nticket_tool: {kind: github, project: null, board: null, sync: mirror-out}\n");
    const before = storyText(ws);
    const result = await tldrx(ws.root, {}, "tickets", "sync");
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr).toContain("ticket_tool.project is required");
    expect(storyText(ws)).toBe(before);
  });

  test("--dry-run prints the plan, writes nothing, and never needs a binary", async () => {
    const ws = workspace("version: 1\nticket_tool: {kind: github, project: o/r, board: null, sync: two-way}\n");
    const before = storyText(ws);
    const result = await tldrx(ws.root, {}, "tickets", "sync", "--dry-run");
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toContain("nothing was called");
    expect(result.stdout).toContain("would create");
    expect(result.stdout).toContain("2 to create");
    expect(storyText(ws)).toBe(before);
    // Never advanced the run.
    expect(readFileSync(join(ws.runDir, "run.yml"), "utf8")).toContain("status:");
    expect(readFileSync(join(ws.runDir, "events.jsonl"), "utf8")).not.toContain("ticket.synced");
  });

  test("an unknown --provider is a usage error", async () => {
    const ws = workspace("version: 1\nticket_tool: {kind: github, project: o/r, board: null, sync: mirror-out}\n");
    const result = await tldrx(ws.root, {}, "tickets", "sync", "--provider", "linear", "--dry-run");
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr).toContain("--provider expects github or jira");
  });

  test("a ticket_tool kind with no adapter says so instead of guessing", async () => {
    const ws = workspace("version: 1\nticket_tool: {kind: linear, project: APP, board: null, sync: mirror-out}\n");
    const result = await tldrx(ws.root, {}, "tickets", "sync", "--dry-run");
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr).toContain("has no adapter");
  });
});

describe("tldrx tickets status", () => {
  test("prints local status beside external_status and changes nothing", async () => {
    const ws = workspace("version: 1\nticket_tool: {kind: github, project: o/r, board: null, sync: two-way}\n");
    const path = join(ws.runDir, "03-plan", "stories", "S1.md");
    writeFileSync(
      path,
      STORY.replace(
        "evidence: []",
        [
          "evidence: []",
          "external:",
          '  provider: "github"',
          '  key: "12"',
          '  url: "https://github.com/o/r/issues/12"',
          '  synced_at: "2026-08-29T10:00:00Z"',
          'external_status: "CLOSED"',
        ].join("\n"),
      ),
      "utf8",
    );
    const before = readFileSync(path, "utf8");

    const result = await tldrx(ws.root, {}, "tickets", "status");
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toContain("S1");
    expect(result.stdout).toContain("todo");
    expect(result.stdout).toContain("CLOSED");
    expect(result.stdout).toContain("https://github.com/o/r/issues/12");
    expect(result.stdout).toContain("1 diverged");
    expect(result.stdout).toContain("This view changes nothing");
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("an unknown subcommand is a usage error naming both", async () => {
    const ws = workspace(null);
    const result = await tldrx(ws.root, {}, "tickets", "nonsense");
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr).toContain("expected `sync` or `status`");
  });
});

describe("registration", () => {
  test("`tldrx --help` lists tickets, and `tickets --help` needs no workspace", async () => {
    const help = await tldrx(FRAMEWORK_ROOT, {}, "--help");
    expect(help.code).toBe(EXIT_OK);
    expect(help.stdout).toContain("tickets");

    const usage = await tldrx(FRAMEWORK_ROOT, {}, "tickets", "--help");
    expect(usage.code).toBe(EXIT_OK);
    expect(usage.stdout).toContain("tldrx tickets sync");
  });
});
