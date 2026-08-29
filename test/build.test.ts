import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";
import { singleRepoFixture } from "./init-fixture.ts";

/**
 * The portability contract (2026-08-28): **Bun to build, Node or Bun to run.**
 *
 * These tests are the only thing standing between that sentence and a `Bun.` call
 * sneaking back into a shipped bundle. They build for real and then run the output
 * under `node`, because "it typechecks" has never once proven a runtime works.
 */

const DIST = join(FRAMEWORK_ROOT, "dist");

interface Ran {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(cmd: readonly string[], stdin?: string): Promise<Ran> {
  const proc = Bun.spawn([...cmd], {
    cwd: FRAMEWORK_ROOT,
    stdout: "pipe",
    stderr: "pipe",
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

/** Trimmed from the official statusLine example payload (docs § "Available data"). */
const STATUSLINE_PAYLOAD = JSON.stringify({
  cwd: FRAMEWORK_ROOT,
  session_id: "abc123",
  model: { id: "claude-opus-5", display_name: "Opus" },
  version: "2.1.90",
  cost: { total_cost_usd: 1.23 },
  context_window: { used_percentage: 16, context_window_size: 200000 },
});

beforeAll(async () => {
  const built = await run(["bun", "scripts/build.ts"]);
  expect(built.stderr, built.stderr).not.toContain("error");
  expect(built.code).toBe(0);
}, 60_000);

describe("bun run build", () => {
  test("emits dist/tldrx.js and a bundle per hook", () => {
    expect(existsSync(join(DIST, "tldrx.js"))).toBe(true);
    for (const hook of ["statusline", "answer-capture", "claim-sources", "no-reask", "dod-gate", "budget-gate", "session-start"]) {
      expect(existsSync(join(DIST, "hooks", `${hook}.js`))).toBe(true);
    }
  });

  test("the built entry points say node, not bun", () => {
    expect(readFileSync(join(DIST, "tldrx.js"), "utf8").split("\n")[0]).toBe("#!/usr/bin/env node");
    expect(readFileSync(join(DIST, "hooks", "statusline.js"), "utf8").split("\n")[0]).toBe("#!/usr/bin/env node");
  });

  test("the bundle inlines `yaml` rather than requiring it at runtime", () => {
    const bundle = readFileSync(join(DIST, "tldrx.js"), "utf8");
    expect(bundle).not.toContain('from "yaml"');
    expect(bundle).not.toContain('require("yaml")');
  });
});

describe("running the build under node", () => {
  test("`node dist/tldrx.js --version` prints the version and exits 0", async () => {
    const ran = await run(["node", join(DIST, "tldrx.js"), "--version"]);
    expect(ran.stderr).toBe("");
    expect(ran.code).toBe(0);
    expect(ran.stdout.trim()).toBe("0.0.1");
  });

  test("`node dist/tldrx.js --help` finds the framework root from inside dist/", async () => {
    const ran = await run(["node", join(DIST, "tldrx.js"), "--help"]);
    expect(ran.code).toBe(0);
    expect(ran.stdout).toContain("Usage: tldrx <command>");
  });

  test("`node dist/hooks/statusline.js` renders the line, not `no session data`", async () => {
    const ran = await run(["node", join(DIST, "hooks", "statusline.js")], STATUSLINE_PAYLOAD);
    expect(ran.code).toBe(0);
    expect(ran.stdout.trim()).toBe("[tldrx] Opus ctx:16% $1.23");
    expect(ran.stdout).not.toContain("no session data");
  });

  test("node and bun render the same status line from the same payload", async () => {
    const underNode = await run(["node", join(DIST, "hooks", "statusline.js")], STATUSLINE_PAYLOAD);
    const underBun = await run(["bun", join(FRAMEWORK_ROOT, "src", "hooks", "statusline.ts")], STATUSLINE_PAYLOAD);
    expect(underNode.stdout).toBe(underBun.stdout);
  });

  test("`init` and `map --check` run end to end under node", async () => {
    // The whole point of the seam: init walks the filesystem, spawns `git`,
    // writes YAML and renders the map — every capability that differs between
    // the two runtimes, in one command. `--provider static` keeps it
    // deterministic; whether a dev machine has `graphify` on PATH is not what
    // this test is about.
    const fixture = await singleRepoFixture();
    const out = await mkdtemp(join(tmpdir(), "tldrx-node-init-"));
    try {
      const init = await run([
        "node", join(DIST, "tldrx.js"), "init",
        "--no-interview", "--provider", "static", "--root", fixture.root, "--out", out,
      ]);
      expect(init.stderr, init.stderr).toBe("");
      expect(init.code).toBe(0);
      expect(existsSync(join(out, ".tldrx", "workspace.yml"))).toBe(true);
      expect(readFileSync(join(out, ".tldrx", "workspace.yml"), "utf8")).toContain("mode: single-repo");

      const checked = await run(["node", join(DIST, "tldrx.js"), "map", "--check", "--root", out]);
      expect(checked.stderr, checked.stderr).toBe("");
      expect(checked.code).toBe(0);
      expect(checked.stdout).toContain("citations in");
    } finally {
      await fixture.cleanup();
      await rm(out, { recursive: true, force: true });
    }
  }, 120_000);

  test("node parses the framework's own YAML through the seam", async () => {
    // `doctor` reads env.yml; getting a table out of it under node proves the
    // Node YAML implementation is wired, not just present.
    const ran = await run(["node", join(DIST, "tldrx.js"), "doctor"]);
    expect([0, 1]).toContain(ran.code); // 1 when an optional tool is missing — still a real parse
    expect(ran.stdout).toContain("bun");
  });
});

describe("the runtime seam invariant", () => {
  test("no `Bun.` call site survives outside src/core/runtime/", async () => {
    const grep = await run(["grep", "-rn", "Bun\\.", "src"]);
    const offenders = grep.stdout
      .split("\n")
      .filter((line) => line.trim() !== "")
      .filter((line) => !line.startsWith("src/core/runtime/"));
    expect(offenders).toEqual([]);
  });
});
