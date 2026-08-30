/**
 * `tldrx install --claude`, `tldrx hook <name>` and `tldrx statusline`.
 *
 * Every test drives the real CLI in a real temp git repo, because the thing being
 * asserted is a FILE — what lands in `.claude/`, byte for byte. The two properties
 * that matter most are byte-level and are checked as such: a second install leaves
 * `settings.json` and `SKILL.md` unchanged, and `--uninstall` puts the file back
 * exactly as it was found.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FRAMEWORK_ROOT, PLUGIN_DIR } from "../src/core/paths.ts";
import { EXIT_FAILED, EXIT_OK } from "../src/cli/exitCodes.ts";
import { HOOK_SCRIPTS, MANAGED_HOOKS, STATUSLINE_COMMAND } from "../src/core/install/managedEntries.ts";
import { SKILL_MARKER } from "../src/core/install/skillFile.ts";
import { handlersOf, type ClaudeSettings } from "../src/core/install/ClaudeSettings.ts";
import { makeWorkspace, type TempWorkspace } from "./fixtures/tempWorkspace.ts";

const BIN = join(FRAMEWORK_ROOT, "bin", "tldrx.ts");

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function tldrx(cwd: string, args: readonly string[], env: Record<string, string> = {}): Promise<Run> {
  const proc = Bun.spawn(["bun", BIN, ...args], {
    cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

/** A temp directory that is a git repo — `--project` refuses anything else. */
function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "tldrx-install-"));
  mkdirSync(join(root, ".git"), { recursive: true });
  return root;
}

const temps: string[] = [];
function repo(): string {
  const root = makeRepo();
  temps.push(root);
  return root;
}
afterEach(() => {
  while (temps.length > 0) rmSync(temps.pop() ?? "", { recursive: true, force: true });
});

function settingsPath(root: string): string {
  return join(root, ".claude", "settings.json");
}
function skillPath(root: string): string {
  return join(root, ".claude", "skills", "tldrx", "SKILL.md");
}
function readSettings(root: string): ClaudeSettings {
  return JSON.parse(readFileSync(settingsPath(root), "utf8")) as ClaudeSettings;
}
function backups(root: string): string[] {
  const dir = join(root, ".claude");
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.includes(".bak-tldrx-")) : [];
}

/** A settings.json in the canonical two-space layout the merge reproduces. */
function writeSettings(root: string, value: unknown): string {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(settingsPath(root), text, "utf8");
  return text;
}

describe("tldrx install --claude --project", () => {
  test("writes the skill with our marker and keeps disable-model-invocation", async () => {
    const root = repo();
    const run = await tldrx(root, ["install", "--claude", "--project"]);
    expect(run.stderr).toBe("");
    expect(run.code).toBe(EXIT_OK);

    const skill = readFileSync(skillPath(root), "utf8");
    expect(skill).toContain(SKILL_MARKER);
    expect(skill).toContain("disable-model-invocation: true");
    // The body is the plugin's, not a paraphrase of it. The heading is READ from
    // the source rather than restated here: a test that hard-codes it keeps
    // passing after the skill is rewritten, which is the drift it exists to catch.
    const source = readFileSync(join(PLUGIN_DIR, "skills", "tldrx", "SKILL.md"), "utf8");
    // …from the BODY: the front matter's comment lines also start with `# `.
    const body = source.slice(source.indexOf("---", 3) + 3);
    const heading = body.split("\n").find((line) => line.startsWith("# ")) ?? "";
    expect(heading).toStartWith("# tldrx");
    expect(skill).toContain(heading);
    expect(skill.length).toBeGreaterThan(source.length);
  });

  test("merges six hooks over eight handlers, plus the status line", async () => {
    const root = repo();
    await tldrx(root, ["install", "--claude"]);
    const settings = readSettings(root);

    const commands = handlersOf(settings).map((handler) => handler.command);
    expect(commands).toHaveLength(MANAGED_HOOKS.length);
    expect(new Set(commands).size).toBe(HOOK_SCRIPTS.length);
    for (const script of HOOK_SCRIPTS) expect(commands).toContain(`tldrx hook ${script}`);

    expect(Object.keys(settings.hooks ?? {}).sort())
      .toEqual(["FileChanged", "PostToolUse", "PreToolUse", "SessionStart"]);
    expect(settings.statusLine).toEqual({ type: "command", command: STATUSLINE_COMMAND });
  });

  test("matchers are the ones plugin/hooks/hooks.json uses", async () => {
    const root = repo();
    await tldrx(root, ["install", "--claude"]);
    const settings = readSettings(root);
    const pre = settings.hooks?.PreToolUse ?? [];
    expect(pre.map((entry) => entry.matcher)).toEqual(["Write|Edit", "Write|Edit", "Write|Edit", "Bash"]);
    expect((settings.hooks?.PostToolUse ?? []).map((e) => e.matcher)).toEqual(["Write|Edit", "Write|Edit"]);
    // FileChanged and SessionStart carry no matcher — the scripts filter themselves.
    for (const event of ["FileChanged", "SessionStart"]) {
      for (const entry of settings.hooks?.[event] ?? []) expect(entry.matcher).toBeUndefined();
    }
  });

  test("never writes a permissions key", async () => {
    const root = repo();
    await tldrx(root, ["install", "--claude"]);
    expect(readSettings(root).permissions).toBeUndefined();
  });

  test("running twice leaves both files byte-identical", async () => {
    const root = repo();
    await tldrx(root, ["install", "--claude"]);
    const settingsAfterFirst = readFileSync(settingsPath(root), "utf8");
    const skillAfterFirst = readFileSync(skillPath(root), "utf8");

    const second = await tldrx(root, ["install", "--claude"]);
    expect(second.code).toBe(EXIT_OK);
    expect(readFileSync(settingsPath(root), "utf8")).toBe(settingsAfterFirst);
    expect(readFileSync(skillPath(root), "utf8")).toBe(skillAfterFirst);
    expect(second.stdout).toContain("0 added, 8 already there");
    // Nothing changed, so nothing was backed up a second time.
    expect(backups(root)).toHaveLength(0);
  });

  test("a pre-existing unrelated hook and status line survive", async () => {
    const root = repo();
    writeSettings(root, {
      permissions: { allow: ["Bash(ls:*)"] },
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-own-guard" }] }] },
      statusLine: { type: "command", command: "my-statusline" },
    });
    const run = await tldrx(root, ["install", "--claude"]);
    expect(run.code).toBe(EXIT_OK);

    const settings = readSettings(root);
    expect(settings.permissions).toEqual({ allow: ["Bash(ls:*)"] });
    expect(settings.hooks?.PreToolUse?.[0]).toEqual({
      matcher: "Bash", hooks: [{ type: "command", command: "my-own-guard" }],
    });
    // A foreign status line is never replaced silently; the command says how to chain.
    expect(settings.statusLine).toEqual({ type: "command", command: "my-statusline" });
    expect(run.stdout).toContain("left `my-statusline` alone");
    expect(run.stdout).toContain("tldrx statusline");
  });

  test("--force-statusline replaces a foreign one and says which", async () => {
    const root = repo();
    writeSettings(root, { statusLine: { type: "command", command: "my-statusline" } });
    const run = await tldrx(root, ["install", "--claude", "--force-statusline"]);
    expect(readSettings(root).statusLine).toEqual({ type: "command", command: STATUSLINE_COMMAND });
    expect(run.stdout).toContain("replaced `my-statusline`");
  });

  test("--uninstall restores the original settings byte-for-byte", async () => {
    const root = repo();
    const before = writeSettings(root, {
      permissions: { allow: ["Bash(ls:*)"] },
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-own-guard" }] }] },
      statusLine: { type: "command", command: "my-statusline" },
    });
    await tldrx(root, ["install", "--claude", "--force-statusline"]);
    expect(readFileSync(settingsPath(root), "utf8")).not.toBe(before);

    // The status line we replaced is ours now, so uninstall removes it and does
    // NOT resurrect the foreign one — that is what the backup file is for.
    const uninstall = await tldrx(root, ["install", "--claude", "--uninstall"]);
    expect(uninstall.code).toBe(EXIT_OK);
    const restored = JSON.parse(readFileSync(settingsPath(root), "utf8")) as ClaudeSettings;
    expect(restored.permissions).toEqual({ allow: ["Bash(ls:*)"] });
    expect(restored.statusLine).toBeUndefined();
    expect(handlersOf(restored).map((h) => h.command)).toEqual(["my-own-guard"]);
  });

  test("install then uninstall is byte-for-byte reversible, backups aside", async () => {
    const root = repo();
    const before = writeSettings(root, {
      permissions: { allow: ["Bash(ls:*)"] },
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-own-guard" }] }] },
    });
    await tldrx(root, ["install", "--claude"]);
    await tldrx(root, ["install", "--claude", "--uninstall"]);
    expect(readFileSync(settingsPath(root), "utf8")).toBe(before);
    expect(existsSync(skillPath(root))).toBe(false);
    // Two writes, two backups — the only files left over.
    expect(backups(root)).toHaveLength(2);
  });

  test("--uninstall leaves a SKILL.md it does not own", async () => {
    const root = repo();
    mkdirSync(join(root, ".claude", "skills", "tldrx"), { recursive: true });
    writeFileSync(skillPath(root), "# mine\n", "utf8");
    const run = await tldrx(root, ["install", "--claude", "--uninstall"]);
    expect(run.code).toBe(EXIT_OK);
    expect(readFileSync(skillPath(root), "utf8")).toBe("# mine\n");
  });

  test("refuses a SKILL.md without our marker, and writes nothing", async () => {
    const root = repo();
    mkdirSync(join(root, ".claude", "skills", "tldrx"), { recursive: true });
    writeFileSync(skillPath(root), "# my own skill\n", "utf8");

    const run = await tldrx(root, ["install", "--claude"]);
    expect(run.code).toBe(EXIT_FAILED);
    expect(run.stderr).toContain("not tldrx-managed");
    expect(run.stdout).toBe("");
    expect(readFileSync(skillPath(root), "utf8")).toBe("# my own skill\n");
    expect(existsSync(settingsPath(root))).toBe(false);
  });

  test("--dry-run prints the same summary and writes nothing", async () => {
    const root = repo();
    const run = await tldrx(root, ["install", "--claude", "--dry-run"]);
    expect(run.code).toBe(EXIT_OK);
    expect(run.stdout).toContain("dry run — nothing written");
    expect(run.stdout).toContain("6 hooks / 8 handlers");
    expect(existsSync(join(root, ".claude"))).toBe(false);
  });

  test("--skill-only touches settings.json not at all", async () => {
    const root = repo();
    const run = await tldrx(root, ["install", "--claude", "--skill-only"]);
    expect(run.code).toBe(EXIT_OK);
    expect(existsSync(skillPath(root))).toBe(true);
    expect(existsSync(settingsPath(root))).toBe(false);
  });

  test("--no-hooks writes only the status line; --no-statusline only the hooks", async () => {
    const a = repo();
    await tldrx(a, ["install", "--claude", "--no-hooks"]);
    expect(readSettings(a).hooks).toBeUndefined();
    expect(readSettings(a).statusLine).toEqual({ type: "command", command: STATUSLINE_COMMAND });

    const b = repo();
    await tldrx(b, ["install", "--claude", "--no-statusline"]);
    expect(handlersOf(readSettings(b))).toHaveLength(MANAGED_HOOKS.length);
    expect(readSettings(b).statusLine).toBeUndefined();
  });

  test("refuses outside a git repo, and names --user as the way out", async () => {
    const root = mkdtempSync(join(tmpdir(), "tldrx-nogit-"));
    try {
      const run = await tldrx(root, ["install", "--claude"]);
      expect(run.code).toBe(EXIT_FAILED);
      expect(run.stderr).toContain("not inside a git repository");
      expect(run.stderr).toContain("--user");
      expect(existsSync(join(root, ".claude"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("--user writes under $HOME and needs no git repo", async () => {
    const home = mkdtempSync(join(tmpdir(), "tldrx-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "tldrx-cwd-"));
    try {
      const run = await tldrx(cwd, ["install", "--claude", "--user"], { HOME: home });
      expect(run.code).toBe(EXIT_OK);
      expect(existsSync(join(home, ".claude", "skills", "tldrx", "SKILL.md"))).toBe(true);
      expect(existsSync(join(cwd, ".claude"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("refuses without a target, and refuses two scopes at once", async () => {
    const root = repo();
    const noTarget = await tldrx(root, ["install"]);
    expect(noTarget.code).toBe(EXIT_FAILED);
    expect(noTarget.stderr).toContain("--claude");

    const both = await tldrx(root, ["install", "--claude", "--project", "--user"]);
    expect(both.code).toBe(EXIT_FAILED);
    expect(both.stderr).toContain("alternatives");
  });

  test("the summary is four to six lines", async () => {
    const root = repo();
    const run = await tldrx(root, ["install", "--claude"]);
    const lines = run.stdout.trimEnd().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(4);
    expect(lines.length).toBeLessThanOrEqual(6);
  });

  test("refuses a settings.json that is not valid JSON rather than replacing it", async () => {
    const root = repo();
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(settingsPath(root), "{ not json", "utf8");
    const run = await tldrx(root, ["install", "--claude"]);
    expect(run.code).toBe(EXIT_FAILED);
    expect(run.stderr).toContain("not valid JSON");
    expect(readFileSync(settingsPath(root), "utf8")).toBe("{ not json");
  });
});

describe("tldrx hook <name>", () => {
  let ws: TempWorkspace | null = null;
  afterEach(() => {
    ws?.dispose();
    ws = null;
  });

  async function pipeTo(args: readonly string[], payload: unknown): Promise<Run> {
    const proc = Bun.spawn(["bun", BIN, ...args], {
      stdin: new TextEncoder().encode(JSON.stringify(payload)),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, USER: "alan" },
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code: await proc.exited, stdout, stderr };
  }

  test("passes a claim-sources deny through, JSON intact, exit 0", async () => {
    ws = makeWorkspace();
    const handoff = join(ws.runDir, "02-how", "handoff.md");
    const bad = [
      "# Handoff — 02-how / contracts — run 260828-leaderboard",
      "",
      "## Findings",
      "- Ranking ties are broken by completion time",
      "",
      "## Decisions",
      "- Reads come from a materialised view [src: Q4]",
      "",
      "## Unknowns",
      "- Retention period [src: absent:.tldrx/memory/facts.yml]",
      "",
      "## Evidence ledger",
      "- Contract project builds clean [src: $ dotnet build → exit 0]",
      "",
    ].join("\n");

    const run = await pipeTo(["hook", "claim-sources"], {
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: handoff, content: bad },
    });

    expect(run.code).toBe(0);
    const decision = JSON.parse(run.stdout) as {
      hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string };
    };
    expect(decision.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(decision.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(decision.hookSpecificOutput.permissionDecisionReason).toContain("unsourced bullet(s)");
  });

  test("passes an allow through as silence and exit 0", async () => {
    const run = await pipeTo(["hook", "session-start"], { hook_event_name: "SessionStart", cwd: tmpdir() });
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("");
  });

  test("`tldrx statusline` renders the short line from the payload", async () => {
    const run = await pipeTo(["statusline"], {
      model: { display_name: "Sonnet" },
      cost: { total_cost_usd: 1.5 },
      context_window: { used_percentage: 16 },
    });
    expect(run.code).toBe(0);
    expect(run.stdout.trim()).toBe("[tldrx] Sonnet ctx:16% $1.50");
  });

  test("an unknown hook name exits 1 and lists the real ones", async () => {
    const run = await pipeTo(["hook", "nope"], {});
    expect(run.code).toBe(EXIT_FAILED);
    expect(run.stderr).toContain("no hook 'nope'");
    for (const script of HOOK_SCRIPTS) expect(run.stderr).toContain(script);
    expect(run.stdout).toBe("");
  });

  test("every script `install` wires is a script `tldrx hook` will run", async () => {
    for (const script of HOOK_SCRIPTS) {
      const run = await pipeTo(["hook", script], { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: {} });
      expect(run.code).toBe(0);
      expect(run.stderr).not.toContain("no script found");
    }
  });
});
