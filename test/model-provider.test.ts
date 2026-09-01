/**
 * `TLDRX_CLAUDE_BIN` — which binary the sub-agent spawn actually executes (#27).
 *
 * The minimal slice of the model-provider ask, and deliberately only that: one env var
 * that replaces the executable name, with the default unchanged. It exists so a sandbox,
 * a wrapper script or a pinned install can stand in for whatever is on PATH without
 * patching source. It is NOT a provider abstraction — the argv is still `claude`'s argv
 * (`-p --output-format stream-json --verbose --json-schema …`), so what it points at has
 * to speak that. #27 stays open for the real layer.
 *
 * What is asserted here is the thing that can silently rot: that the override reaches the
 * SPAWN, not merely a constant. A test that only read `claudeBin()` back would pass with
 * `runtime.spawn` still hardcoded — so the last test runs a real script and checks that
 * the script ran.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeBin, CLAUDE_BIN, describeSpawn, spawnAgent } from "../src/core/facilitator/spawnAgent.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

setDefaultTimeout(spawnTestTimeout(30_000));

const scratch: string[] = [];
afterEach(() => {
  delete process.env.TLDRX_CLAUDE_BIN;
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "tldrx-bin-"));
  scratch.push(dir);
  return dir;
}

const request = (cwd: string) => ({
  prompt: "say nothing",
  model: null,
  maxBudgetUsd: 0.01,
  workspaceCommands: [],
  yolo: false,
  cwd,
  timeoutMs: 15_000,
});

describe("claudeBin() picks the executable", () => {
  test("unset, it is `claude` — the default nobody had to opt into", () => {
    delete process.env.TLDRX_CLAUDE_BIN;
    expect(claudeBin()).toBe("claude");
    expect(CLAUDE_BIN).toBe("claude");
  });

  test("set, it is what was set", () => {
    process.env.TLDRX_CLAUDE_BIN = "/opt/wrappers/claude-via-proxy";
    expect(claudeBin()).toBe("/opt/wrappers/claude-via-proxy");
  });

  test("blank or whitespace is not an override — an empty var means `unset`, not `run \"\"`", () => {
    for (const blank of ["", "   ", "\t\n"]) {
      process.env.TLDRX_CLAUDE_BIN = blank;
      expect(claudeBin()).toBe("claude");
    }
  });

  test("surrounding whitespace is trimmed, because a shell export usually has some", () => {
    process.env.TLDRX_CLAUDE_BIN = "  my-claude  ";
    expect(claudeBin()).toBe("my-claude");
  });
});

describe("the override reaches every place the CLI is named", () => {
  test("`--dry-run` prints the command that WOULD run, so it prints the override", () => {
    const dir = tmp();
    expect(describeSpawn(request(dir))).toStartWith("claude -p ");
    process.env.TLDRX_CLAUDE_BIN = "/opt/wrappers/claude-via-proxy";
    expect(describeSpawn(request(dir))).toStartWith("/opt/wrappers/claude-via-proxy -p ");
  });

  test("spawnAgent EXECUTES it — proven by the stand-in leaving a mark on disk", async () => {
    const dir = tmp();
    const marker = join(dir, "it-ran.txt");
    const stub = join(dir, "stub-claude");
    // Records that it ran, with its argv, then answers like a `claude -p` that produced
    // nothing useful. The outcome is irrelevant; the marker is the whole assertion.
    writeFileSync(stub, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > ${JSON.stringify(marker)}\ncat > /dev/null\nexit 0\n`);
    chmodSync(stub, 0o755);

    process.env.TLDRX_CLAUDE_BIN = stub;
    await spawnAgent({ ...request(dir), env: { ...process.env } });

    expect(existsSync(marker)).toBe(true);
    const argv = readFileSync(marker, "utf8").split("\n");
    expect(argv).toContain("-p");                 // still claude's argv, on purpose
    expect(argv).toContain("stream-json");
  });
});
