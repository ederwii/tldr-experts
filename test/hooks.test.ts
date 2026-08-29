import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { FRAMEWORK_ROOT, PLUGIN_DIR } from "../src/core/paths.ts";
import { parseHookInput } from "../src/core/hooks/passthrough.ts";

const INERT_HOOKS = [
  "claim-sources",
  "no-reask",
  "answer-capture",
  "dod-gate",
  "budget-gate",
  "session-start",
] as const;

const SAMPLE_EVENT = JSON.stringify({
  session_id: "abc123",
  transcript_path: "/path/to/transcript.jsonl",
  cwd: "/current/working/directory",
  hook_event_name: "PostToolUse",
  tool_name: "Write",
  tool_input: { file_path: "/tmp/example.md" },
});

describe("v0 hooks are wired but inert", () => {
  for (const name of INERT_HOOKS) {
    test(`${name} allows (exit 0) and says it is not implemented`, async () => {
      const proc = Bun.spawn(["bun", join(FRAMEWORK_ROOT, "src", "hooks", `${name}.ts`)], {
        stdin: new TextEncoder().encode(SAMPLE_EVENT),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      // Exit 2 is the BLOCKING code. Nothing may block until it enforces something.
      expect(await proc.exited).toBe(0);
      expect(stderr).toContain(`tldrx hook ${name}: not implemented (allow)`);
      expect(stdout).toBe("");
    });
  }

  test("a hook survives empty stdin", async () => {
    const proc = Bun.spawn(["bun", join(FRAMEWORK_ROOT, "src", "hooks", "claim-sources.ts")], {
      stdin: new TextEncoder().encode(""),
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(0);
    expect(stderr).toContain("unknown-event");
  });
});

describe("parseHookInput", () => {
  test("returns the payload for valid JSON", () => {
    expect(parseHookInput(SAMPLE_EVENT)?.hook_event_name).toBe("PostToolUse");
  });

  test("returns null for empty or non-object input", () => {
    expect(parseHookInput("")).toBeNull();
    expect(parseHookInput("   ")).toBeNull();
    expect(parseHookInput("{broken")).toBeNull();
    expect(parseHookInput("[1,2]")).not.toBeNull(); // arrays are objects; shape checks live elsewhere
    expect(parseHookInput("42")).toBeNull();
  });
});

describe("plugin packaging", () => {
  test("the manifest lives at .claude-plugin/plugin.json and names the plugin", async () => {
    const manifest = (await Bun.file(join(PLUGIN_DIR, ".claude-plugin", "plugin.json")).json()) as {
      name: string;
      version: string;
      description: string;
    };
    expect(manifest.name).toBe("tldrx");
    expect(manifest.version).toBe("0.0.1");
    expect(manifest.description.length).toBeGreaterThan(0);
  });

  test("skills/, agents/ and hooks/ are at the plugin root, not inside .claude-plugin/", async () => {
    for (const dir of ["skills", "agents", "hooks"]) {
      expect(await Bun.file(join(PLUGIN_DIR, ".claude-plugin", dir, "x")).exists()).toBe(false);
    }
    expect(await Bun.file(join(PLUGIN_DIR, "skills", "tldrx", "SKILL.md")).exists()).toBe(true);
    expect(await Bun.file(join(PLUGIN_DIR, "hooks", "hooks.json")).exists()).toBe(true);
  });

  test("hooks.json is valid JSON and every handler points at a script that exists", async () => {
    const config = (await Bun.file(join(PLUGIN_DIR, "hooks", "hooks.json")).json()) as {
      hooks: Record<string, Array<{ hooks: Array<{ type: string; command: string; args?: string[] }> }>>;
    };
    let handlers = 0;
    for (const entries of Object.values(config.hooks)) {
      for (const entry of entries) {
        for (const handler of entry.hooks) {
          handlers++;
          expect(handler.type).toBe("command");
          expect(handler.command).toBe("bun");
          const arg = handler.args?.[0] ?? "";
          expect(arg).toStartWith("${CLAUDE_PLUGIN_ROOT}/../src/hooks/");
          const resolved = join(PLUGIN_DIR, arg.replace("${CLAUDE_PLUGIN_ROOT}/", ""));
          expect(await Bun.file(resolved).exists()).toBe(true);
        }
      }
    }
    expect(handlers).toBe(INERT_HOOKS.length);
  });

  test("the facilitator skill is user-invoked only", async () => {
    const text = await Bun.file(join(PLUGIN_DIR, "skills", "tldrx", "SKILL.md")).text();
    expect(text).toStartWith("---\n");
    expect(text).toContain("disable-model-invocation: true");
  });
});
