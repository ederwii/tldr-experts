/**
 * `tldrx expert packs` through the real CLI (stack packs design §4.6): exit families,
 * the lines an operator reads, and `--help` as the authoritative surface.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";
import { EXIT_OK, EXIT_USAGE } from "../src/cli/exitCodes.ts";
import { SpawnCommandRunner } from "../src/core/detect/index.ts";
import { runInit, type InitOptions } from "../src/core/init/index.ts";
import { templatesHash } from "../src/core/experts/packTemplates.ts";
import { greenfieldFixture, singleRepoFixture, type Fixture } from "./init-fixture.ts";
import { noSpawnEnv } from "./fixtures/noSpawnPath.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

// Every test here spawns the real CLI; the budget scales with measured load (#43).
setDefaultTimeout(spawnTestTimeout());

const BIN = join(FRAMEWORK_ROOT, "bin", "tldrx.ts");
const runner = new SpawnCommandRunner();
const NOW = new Date("2026-09-05T10:00:00Z");

interface Run { readonly code: number; readonly stdout: string; readonly stderr: string; }

/** The CLI, with a private $TMPDIR per invocation and a `claude` that refuses (#95/#97). */
async function tldrx(cwd: string, ...args: string[]): Promise<Run> {
  const scratch = mkdtempSync(join(tmpdir(), "tldrx-packs-cli-tmp-"));
  const proc = Bun.spawn(["bun", BIN, ...args], {
    cwd, stdout: "pipe", stderr: "pipe", env: { ...noSpawnEnv(), TMPDIR: scratch },
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, stdout, stderr };
}

function options(root: string): InitOptions {
  return { root, out: root, interview: false, methodology: null, mcp: false, stack: [], provider: "static" };
}

describe("tldrx expert packs", () => {
  let fixture: Fixture;
  beforeAll(async () => {
    fixture = await singleRepoFixture();
    await runInit(options(fixture.root), { runner, cliVersion: "0.0.1", now: NOW });
  });
  afterAll(async () => { await fixture.cleanup(); });

  test("status exits 0 and says disabled before anyone enabled it", async () => {
    const run = await tldrx(fixture.root, "expert", "packs", "status", "--root", fixture.root);
    expect(run.code).toBe(EXIT_OK);
    expect(run.stdout).toContain("stack packs: disabled");
    expect(run.stdout).toContain("typescript-stack: body stub");
  });

  test("enable prints overlays with evidence and the applied pack, then status reflects it", async () => {
    const run = await tldrx(fixture.root, "expert", "packs", "enable", "--root", fixture.root);
    expect(run.code).toBe(EXIT_OK);
    expect(run.stdout).toContain("react (package.json: dependencies.react)");
    expect(run.stdout).toContain(`typescript-stack: pack applied (pack@${templatesHash()})`);
    expect(existsSync(join(fixture.root, ".tldrx", "experts", "typescript-stack", "overlays", "react.md"))).toBe(true);
    const status = await tldrx(fixture.root, "expert", "packs", "status", "--root", fixture.root);
    expect(status.stdout).toContain("stack packs: enabled");
    expect(status.stdout).toContain(`typescript-stack: body pack@${templatesHash()}, overlays: react, vite-react-spa`);
  });

  test("disable exits 0, removes the overlays, and says what it left alone", async () => {
    const run = await tldrx(fixture.root, "expert", "packs", "disable", "--root", fixture.root);
    expect(run.code).toBe(EXIT_OK);
    expect(run.stdout).toContain("bodies and knowledge/ untouched");
    expect(existsSync(join(fixture.root, ".tldrx", "experts", "typescript-stack", "overlays"))).toBe(false);
    expect(readFileSync(join(fixture.root, ".tldrx", "workspace.yml"), "utf8")).toContain("enabled: false");
  });

  test("an unknown action is a usage error naming the three verbs", async () => {
    const run = await tldrx(fixture.root, "expert", "packs", "bogus", "--root", fixture.root);
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.stderr).toContain("expected enable, disable or status");
  });

  test("--help lists packs and its verbs", async () => {
    const run = await tldrx(FRAMEWORK_ROOT, "expert", "--help");
    expect(run.code).toBe(EXIT_OK);
    expect(run.stdout).toContain("packs");
    expect(run.stdout).toContain("tldrx expert packs enable");
  });
});

describe("enable with nothing detectable", () => {
  let fixture: Fixture;
  beforeAll(async () => {
    fixture = await greenfieldFixture();
    await runInit(options(fixture.root), { runner, cliVersion: "0.0.1", now: NOW });
  });
  afterAll(async () => { await fixture.cleanup(); });

  test("exits 1 (usage family) and says why on stderr", async () => {
    const run = await tldrx(fixture.root, "expert", "packs", "enable", "--root", fixture.root);
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.stderr).toContain("no detectable language");
    expect(run.stdout).toBe("");
  });
});

describe("status with no workspace.yml at all", () => {
  test("still exits 0 and names the missing file", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "tldrx-packs-cli-noworkspace-"));
    const run = await tldrx(scratch, "expert", "packs", "status", "--root", scratch);
    expect(run.code).toBe(EXIT_OK);
    expect(run.stdout).toContain("run `tldrx init` first");
  });
});
