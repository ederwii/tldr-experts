/**
 * `tldrx watch list` / `tldrx watch check` through the real binary.
 *
 * Exit codes are the point of these tests. `watch check` reporting a dead citation
 * on stdout and exiting `0` would be invisible to the CI job that is the only
 * reason anyone would run it unattended — so a card that no longer resolves must
 * come back `1`, and a missing one `3`.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";
import { EXIT_FAILED, EXIT_NOT_FOUND, EXIT_OK, EXIT_USAGE } from "../src/cli/exitCodes.ts";
import { watcherRelPath, WATCH_PHASE } from "../src/core/watch/index.ts";
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

const SOURCE = "public void Refresh() => Log(\"leaderboard.refreshed\");\n";

function card(status: string, signalSrc: string): string {
  return [
    "---",
    "version: 1",
    "id: leaderboard",
    "epic: E1",
    'title: "Player leaderboard"',
    "stories: [S1]",
    "repos: [api]",
    `status: ${status}`,
    "---",
    "",
    "# leaderboard",
    "",
    "## Signal",
    `- \`leaderboard.refreshed\` is emitted [src: ${signalSrc}]`,
    "",
    "## Where",
    "- The api log stream [src: api:src/Leaderboard.cs:1]",
    "",
    "## Healthy baseline",
    "- 12-40 per hour [src: api:src/Leaderboard.cs:1]",
    "",
    "## Looks broken when",
    "- Zero for 30 minutes [src: api:src/Leaderboard.cs:1]",
    "",
    "## Query",
    "",
    "```kql",
    "traces | count",
    "```",
    "",
    "## Sources",
    "",
    "One emit site.",
    "",
  ].join("\n");
}

/** A run whose Watch stage already produced one card. */
function withCard(signalSrc = "api:src/Leaderboard.cs:1", status = "verified"): FacilitatorWorkspace {
  const ws = makeFacilitatorWorkspace({
    scope: "demo",
    budgetUsd: 10,
    stages: [{ id: "watch", phase: WATCH_PHASE, budgetUsd: 2, gate: "approve" }],
    files: { "api/src/Leaderboard.cs": SOURCE },
  });
  open.push(ws);
  const path = join(ws.runDir, watcherRelPath("leaderboard"));
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, card(status, signalSrc), "utf8");
  return ws;
}

describe("tldrx watch list", () => {
  test("prints the card, its status and its signal, and exits 0", async () => {
    const ws = withCard();
    const run = await tldrx(ws.root, "watch", "list");

    expect(run.code).toBe(EXIT_OK);
    expect(run.stdout).toContain("leaderboard");
    expect(run.stdout).toContain("verified");
    expect(run.stdout).toContain("leaderboard.refreshed");
  });

  test("`--run <id>` names the run explicitly", async () => {
    const ws = withCard();
    const run = await tldrx(ws.root, "watch", "list", "--run", ws.runId);
    expect(run.code).toBe(EXIT_OK);
    expect(run.stdout).toContain(ws.runId);
  });

  test("--json carries the same rows the table shows", async () => {
    const ws = withCard();
    const run = await tldrx(ws.root, "watch", "list", "--json");
    expect(run.code).toBe(EXIT_OK);
    const parsed = JSON.parse(run.stdout) as {
      run: string;
      cards: { id: string; path: string; status: string; valid: boolean; signal: string | null }[];
      verified: number;
      invalid: number;
    };
    expect(parsed.run).toBe(ws.runId);
    expect(parsed.cards).toHaveLength(1);
    expect(parsed.cards[0]?.id).toBe("leaderboard");
    expect(parsed.cards[0]?.status).toBe("verified");
    expect(parsed.cards[0]?.valid).toBe(true);
    expect(parsed.cards[0]?.signal).toContain("leaderboard.refreshed");
    expect(parsed.verified).toBe(1);
    expect(parsed.invalid).toBe(0);
  });

  // The table and the JSON are built from one `statusOf`, so they cannot disagree.
  test("the JSON status is the status the table printed", async () => {
    const ws = withCard("api:src/Leaderboard.cs:400");
    const table = await tldrx(ws.root, "watch", "list");
    const json = await tldrx(ws.root, "watch", "list", "--json");
    const status = (JSON.parse(json.stdout) as { cards: { status: string }[] }).cards[0]?.status ?? "";
    expect(status).not.toBe("");
    expect(table.stdout).toContain(status);
  });

  test("an unknown run is 3, not a silent empty table", async () => {
    const ws = withCard();
    const run = await tldrx(ws.root, "watch", "list", "--run", "260101-nope");
    expect(run.code).toBe(EXIT_NOT_FOUND);
    expect(run.stderr).toContain("260101-nope");
  });
});

describe("tldrx watch check", () => {
  test("a card whose sources all resolve exits 0", async () => {
    const ws = withCard();
    const run = await tldrx(ws.root, "watch", "check", "leaderboard");

    expect(run.code).toBe(EXIT_OK);
    expect(run.stdout).toContain("ok — verified");
  });

  test("a dead citation exits 1 and names the line", async () => {
    const ws = withCard("api:src/Leaderboard.cs:400");
    const run = await tldrx(ws.root, "watch", "check", "leaderboard");

    expect(run.code).toBe(EXIT_FAILED);
    expect(run.stdout).toContain("citation(s) that no longer resolve");
    expect(run.stdout).toContain("cited line 400");
  });

  test("a card whose file was gutted after the run exits 1", async () => {
    const ws = withCard();
    writeFileSync(join(ws.root, "api", "src", "Leaderboard.cs"), "", "utf8");

    const run = await tldrx(ws.root, "watch", "check", "leaderboard");
    expect(run.code).toBe(EXIT_FAILED);
    expect(run.stdout).toContain("Leaderboard.cs");
  });

  test("a card hand-edited to `verified` over an `absent:` signal exits 1", async () => {
    const ws = withCard("absent:api/src/Leaderboard.cs", "verified");
    const run = await tldrx(ws.root, "watch", "check", "leaderboard");

    expect(run.code).toBe(EXIT_FAILED);
    expect(run.stdout).toContain("earn `draft`");
  });

  test("an unknown feature is 3 and lists the ones that exist", async () => {
    const ws = withCard();
    const run = await tldrx(ws.root, "watch", "check", "nope");

    expect(run.code).toBe(EXIT_NOT_FOUND);
    expect(run.stderr).toContain("leaderboard");
  });

  test("check with no feature id is a usage error", async () => {
    const ws = withCard();
    const run = await tldrx(ws.root, "watch", "check");
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.stderr).toContain("feature id");
  });

  test("an unknown subcommand is a usage error", async () => {
    const ws = withCard();
    const run = await tldrx(ws.root, "watch", "listen");
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.stderr).toContain("listen");
  });

  test("`tldrx watch --help` needs no workspace", async () => {
    const run = await tldrx(FRAMEWORK_ROOT, "watch", "--help");
    expect(run.code).toBe(EXIT_OK);
    expect(run.stdout).toContain("watch");
    expect(readFileSync(BIN, "utf8")).toContain("dispatch");
  });
});
