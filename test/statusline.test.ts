import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import {
  NO_SESSION_DATA,
  renderStatusLine,
  renderStatusLineFromText,
} from "../src/core/statusline/renderStatusLine.ts";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

// Every test in this file spawns a REAL process — git, `bun`, the CLI. Process cost is a
// property of the machine, not of the code, so bun's fixed 5000 ms default measures the box:
// on an untouched tree, tests here timed out while the same files passed alone (#43). The
// budget scales with measured load; the assertions are untouched, and a hang is still caught.
setDefaultTimeout(spawnTestTimeout());

/**
 * Trimmed from the example payload in the official docs:
 * https://code.claude.com/docs/en/statusline  (§ "Available data")
 */
const SAMPLE = {
  cwd: "/current/working/directory",
  session_id: "abc123...",
  model: { id: "claude-opus-5", display_name: "Opus" },
  workspace: { current_dir: "/current/working/directory", project_dir: "/original/project/directory" },
  version: "2.1.90",
  cost: {
    total_cost_usd: 0.01234,
    total_duration_ms: 45000,
    total_api_duration_ms: 2300,
    total_lines_added: 156,
    total_lines_removed: 23,
  },
  context_window: {
    total_input_tokens: 15500,
    total_output_tokens: 1200,
    context_window_size: 200000,
    used_percentage: 8,
    remaining_percentage: 92,
  },
  exceeds_200k_tokens: false,
};

describe("renderStatusLine", () => {
  test("renders from the documented sample payload", () => {
    expect(renderStatusLine(SAMPLE)).toBe("[tldrx] Opus ctx:8% $0.01");
  });

  test("truncates a fractional context percentage, as the docs' own example does", () => {
    const payload = { ...SAMPLE, context_window: { ...SAMPLE.context_window, used_percentage: 23.9 } };
    expect(renderStatusLine(payload)).toBe("[tldrx] Opus ctx:23% $0.01");
  });

  test("formats cost to two decimals", () => {
    const payload = { ...SAMPLE, cost: { ...SAMPLE.cost, total_cost_usd: 4.9151 } };
    expect(renderStatusLine(payload)).toBe("[tldrx] Opus ctx:8% $4.92");
  });

  test("falls back when used_percentage is null early in the session", () => {
    const payload = { ...SAMPLE, context_window: { ...SAMPLE.context_window, used_percentage: null } };
    expect(renderStatusLine(payload)).toBe(NO_SESSION_DATA);
  });

  test.each([
    ["no model", { ...SAMPLE, model: {} }],
    ["no cost", { ...SAMPLE, cost: {} }],
    ["no context window", { ...SAMPLE, context_window: {} }],
    ["empty object", {}],
    ["null", null],
    ["a string", "not json"],
  ])("falls back for %s", (_label, payload) => {
    expect(renderStatusLine(payload)).toBe(NO_SESSION_DATA);
  });
});

describe("renderStatusLineFromText", () => {
  test("parses raw stdin text", () => {
    expect(renderStatusLineFromText(JSON.stringify(SAMPLE))).toBe("[tldrx] Opus ctx:8% $0.01");
  });

  test("never throws on garbage", () => {
    expect(renderStatusLineFromText("")).toBe(NO_SESSION_DATA);
    expect(renderStatusLineFromText("{not json")).toBe(NO_SESSION_DATA);
  });
});

describe("the statusline hook script", () => {
  test("renders the sample payload piped on stdin and exits 0", async () => {
    const proc = Bun.spawn(["bun", join(FRAMEWORK_ROOT, "src", "hooks", "statusline.ts")], {
      stdin: new TextEncoder().encode(JSON.stringify(SAMPLE)),
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(stdout.trim()).toBe("[tldrx] Opus ctx:8% $0.01");
  });

  test("prints the fallback rather than crashing on empty stdin", async () => {
    const proc = Bun.spawn(["bun", join(FRAMEWORK_ROOT, "src", "hooks", "statusline.ts")], {
      stdin: new TextEncoder().encode(""),
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(stdout.trim()).toBe(NO_SESSION_DATA);
  });
});
