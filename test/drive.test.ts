/**
 * `tldrx drive [--attended|--unattended]` — the host/driver mandate as a
 * shipped artifact (issue #63).
 *
 * What is asserted here is the CONTRACT of the text, not its prose: that both
 * modes carry the disciplines the first real runs were driven by, that the two
 * modes actually differ where they are supposed to, that neither runs long
 * enough to stop being read, and that printing a mandate needs no workspace,
 * touches no disk and spawns nothing.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";
import { EXIT_OK, EXIT_USAGE } from "../src/cli/exitCodes.ts";
import { DRIVE_MODES, MANDATE_MAX_LINES, renderMandate } from "../src/core/drive/index.ts";
import { noSpawnEnv } from "./fixtures/noSpawnPath.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

setDefaultTimeout(spawnTestTimeout());

const BIN = join(FRAMEWORK_ROOT, "bin", "tldrx.ts");

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function bareDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tldrx-drive-"));
  temps.push(dir);
  return dir;
}

async function tldrxIn(cwd: string, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", BIN, ...args], { stdout: "pipe", stderr: "pipe", cwd, env: noSpawnEnv() });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

const VERSION = "0.4.0";

// --- the renderer ------------------------------------------------------------

describe("renderMandate", () => {
  test("there are exactly two modes", () => {
    expect([...DRIVE_MODES]).toEqual(["attended", "unattended"]);
  });

  for (const mode of DRIVE_MODES) {
    const text = renderMandate(mode, VERSION);
    const lines = text.split("\n");

    test(`${mode}: is under ${String(MANDATE_MAX_LINES)} lines`, () => {
      expect(lines.length).toBeLessThanOrEqual(MANDATE_MAX_LINES);
      expect(lines.length).toBeGreaterThan(40);
    });

    test(`${mode}: is stamped with the framework version it shipped with`, () => {
      expect(text).toContain(VERSION);
    });

    test(`${mode}: carries the three-role protocol, and names the author exclusion`, () => {
      expect(text).toContain("Three roles");
      expect(text.toLowerCase()).toContain("never the author");
      // The host is the third role, and its job is the code — not the reports.
      expect(text.toLowerCase()).toContain("in the code");
    });

    test(`${mode}: carries the evidence discipline, all four rules`, () => {
      expect(text).toContain("measured");
      expect(text).toContain("inferred");
      expect(text).toContain("assumed");
      expect(text.toLowerCase()).toContain("exit code");
      expect(text).toContain("ls-remote");
    });

    test(`${mode}: carries the parking discipline and its hard limit`, () => {
      expect(text.toLowerCase()).toContain("park");
      expect(text.toLowerCase()).toContain("open question");
    });

    test(`${mode}: carries review calibration by stakes`, () => {
      expect(text.toLowerCase()).toContain("stakes");
    });

    test(`${mode}: carries budget honesty`, () => {
      expect(text).toContain("--tokens");
      expect(text.toLowerCase()).toContain("floor");
    });

    test(`${mode}: never tells the driver to push`, () => {
      expect(text).toContain("Never push");
    });
  }

  test("the two modes differ in the GATE section", () => {
    const unattended = renderMandate("unattended", VERSION);
    const attended = renderMandate("attended", VERSION);
    expect(unattended).toContain("tldrx approve --as-agent");
    expect(attended).not.toContain("--as-agent");
    expect(attended).toContain("tldrx approve");
  });

  test("the two modes differ in the PREPARE/COMMIT section", () => {
    const unattended = renderMandate("unattended", VERSION);
    const attended = renderMandate("attended", VERSION);
    expect(unattended).toContain("attended_by: host");
    expect(unattended).toContain("The framework must never spawn");
    expect(attended).toContain("tldrx next");
    expect(attended).not.toContain("The framework must never spawn");
  });

  test("the two modes are not the same document", () => {
    expect(renderMandate("attended", VERSION)).not.toBe(renderMandate("unattended", VERSION));
  });
});

// --- the command -------------------------------------------------------------

describe("tldrx drive", () => {
  test("--unattended prints the mandate on stdout and exits 0", async () => {
    const run = await tldrxIn(bareDir(), "drive", "--unattended");
    expect(run.code).toBe(EXIT_OK);
    expect(run.stderr).toBe("");
    expect(run.stdout).toContain("tldrx approve --as-agent");
    expect(run.stdout.split("\n").length).toBeLessThanOrEqual(MANDATE_MAX_LINES + 1);
  });

  test("--attended prints the other one", async () => {
    const run = await tldrxIn(bareDir(), "drive", "--attended");
    expect(run.code).toBe(EXIT_OK);
    expect(run.stdout).not.toContain("--as-agent");
    expect(run.stdout).toContain("Three roles");
  });

  /**
   * A direction is required and never guessed — the same refusal
   * `tldrx run attend` makes. Guessing here would hand somebody the wrong
   * half of the one thing this command exists to get right.
   */
  test("with no mode it refuses and names both", async () => {
    const run = await tldrxIn(bareDir(), "drive");
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("--attended");
    expect(run.stderr).toContain("--unattended");
  });

  test("both modes at once is refused too", async () => {
    const run = await tldrxIn(bareDir(), "drive", "--attended", "--unattended");
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("one of");
  });

  test("needs no workspace, and writes nothing where it is run", async () => {
    const dir = bareDir();
    const run = await tldrxIn(dir, "drive", "--unattended");
    expect(run.code).toBe(EXIT_OK);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("the printed version is the package's own", async () => {
    const run = await tldrxIn(bareDir(), "drive", "--unattended");
    const version = JSON.parse(await Bun.file(new URL("../package.json", import.meta.url)).text()).version;
    expect(run.stdout).toContain(version);
  });
});
