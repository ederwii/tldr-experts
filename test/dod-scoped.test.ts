/**
 * Scoped per-story DoD checks, and the full suite ONCE on the epic head (#257).
 *
 * Measured on a field run at tldrx 0.16.1: 99 `check.*` events on one 8-story
 * epic — every story's Definition of Done ran the whole declared list, the full
 * suite among it, on every attempt and every fix round, and nothing ever ran on
 * the epic head that actually ships. The DoD's own contract is a DELTA gate
 * ("this story did not break the tree", `build/preflight.ts`), proven until now
 * by running everything, because nothing narrower existed.
 *
 * The rules pinned here:
 *
 *   - `commands.<slot>_scoped: "<cmd> {{paths}}"` is a TEMPLATE, additive, never
 *     citable and never a developer tool; a ```dod line naming it is refused at
 *     Plan time with a sentence that names the slot.
 *   - a story's DoD runs the scoped template when one exists for the command and
 *     the story's paths are non-empty — substituted at the ARGV level, so a path
 *     with a space is one argument — and the event says `scope: "paths"` with
 *     the paths; otherwise it runs the full command exactly as before.
 *   - once per epic, when the epic flips to `done` and at least one scoped run
 *     happened in it, the deduped full commands run on the EPIC HEAD; the event
 *     says `scope: "full"` with the epic's `lane`; a red blocks the last merged
 *     story, so the `stories` gate condition refuses.
 *   - a workspace declaring no template emits no `scope` key at all (the golden
 *     is the byte-level proof of that; this file's control is its sibling).
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runNext } from "../src/core/facilitator/runNext.ts";
import { EventLog } from "../src/core/events/EventLog.ts";
import { runStoryDod } from "../src/core/build/dodRunner.ts";
import { scopedPathsFor } from "../src/core/build/scopedPaths.ts";
import { git } from "../src/core/build/git.ts";
import {
  PATHS_PLACEHOLDER, SCOPED_SUFFIX, scopedOnlyDodMessage, scopedSlotOf, notDeclaredMessage,
} from "../src/core/schemas/commandAllowlist.ts";
import { parseDodBlock, validateStoryDod, validateStoryFile } from "../src/core/schemas/story.ts";
import { validatePlan } from "../src/core/plan/validatePlan.ts";
import { loadWorkspace } from "../src/hooks/lib/workspace.ts";
import { renderScopedCommand, scopedArgv } from "../src/hooks/lib/story.ts";
import {
  makeBuildWorkspace, type BuildWorkspace, type BuildWorkspaceOptions,
} from "./fixtures/build/workspace.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

// This file runs the REAL executor: git worktrees, a real `npm run test`, a real
// scoped script. Process cost is a property of the machine (#43).
setDefaultTimeout(spawnTestTimeout());

const ORIGINAL_PATH = process.env.PATH ?? "";
const FAKE_KEYS = ["FAKE_BUILD_STATE", "FAKE_BUILD_COST", "FAKE_BUILD_WRITE"] as const;

let open: BuildWorkspace[] = [];
const dirs: string[] = [];

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  for (const key of FAKE_KEYS) delete process.env[key];
  for (const ws of open) ws.dispose();
  open = [];
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const FULL = "npm run test";
const TEMPLATE = `node scripts/scoped.js ${PATHS_PLACEHOLDER}`;
const ARGV_LOG = "scoped-argv.jsonl";

/**
 * The scoped runner: records the argv it was handed, next to the workspace's
 * `.tldrx/` (found by walking up from the worktree it runs in, so a story
 * worktree and the epic worktree write to the same file), and exits 0.
 */
const SCOPED_JS = [
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  "let dir = process.cwd();",
  "while (!fs.existsSync(path.join(dir, '.tldrx')) && path.dirname(dir) !== dir) dir = path.dirname(dir);",
  `fs.appendFileSync(path.join(dir, ${JSON.stringify(ARGV_LOG)}),`
    + " JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2) }) + '\\n');",
  "",
].join("\n");

/** A no-op install that leaves a marker, so the epic-head install can be seen. */
const INSTALL_JS = "require('node:fs').writeFileSync('.installed', '');\n";

const TWO_STORIES = {
  stories: [
    { id: "S1", epic: "E1", title: "First story" },
    { id: "S2", epic: "E1", title: "Second story" },
  ],
  epics: [{ id: "E1", stories: ["S1", "S2"], branch: "epic/e1" }],
  waves: [["S1", "S2"]],
} satisfies Partial<BuildWorkspaceOptions>;

function scopedWorkspace(extra: Partial<BuildWorkspaceOptions> = {}, scoped = true): BuildWorkspace {
  const made = makeBuildWorkspace({
    ...TWO_STORIES,
    repoFiles: { "scripts/scoped.js": SCOPED_JS, "scripts/install.js": INSTALL_JS, ".gitignore": ".installed\n" },
    commands: {
      build: null, test: FULL, lint: null, typecheck: null,
      ...(scoped ? { [`test${SCOPED_SUFFIX}`]: TEMPLATE } : {}),
    },
    ...extra,
  });
  open.push(made);
  process.env.PATH = made.binDir;
  process.env.FAKE_BUILD_STATE = made.statePath;
  process.env.FAKE_BUILD_COST = "0.10";
  return made;
}

function next(ws: BuildWorkspace): Promise<{ code: number; lines: readonly string[] }> {
  return runNext({
    root: ws.root, dryRun: false, mode: "headless", yolo: false,
    actor: "alan", at: "2026-08-29T09:00:00Z",
  }) as never;
}

type Row = { type: string; payload: Record<string, unknown> };

function events(ws: BuildWorkspace): readonly Row[] {
  return EventLog.forRun(ws.runDir).read() as never;
}

function dodChecks(ws: BuildWorkspace): readonly Row[] {
  return events(ws).filter((e) => e.type.startsWith("check.") && e.payload.check === "dod");
}

function argvLog(ws: BuildWorkspace): readonly { cwd: string; argv: string[] }[] {
  const path = join(ws.root, ARGV_LOG);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as never);
}

function storyStatus(ws: BuildWorkspace, id: string): string {
  const text = readFileSync(join(ws.planDir, "stories", `${id}.md`), "utf8");
  return /^status\s*:\s*(\w+)\s*$/m.exec(text)?.[1] ?? "";
}

function epicStatus(ws: BuildWorkspace, id: string): string {
  const text = readFileSync(join(ws.planDir, "epics", `${id}.md`), "utf8");
  return /^status\s*:\s*(\w+)\s*$/m.exec(text)?.[1] ?? "";
}

// ---------------------------------------------------------------------------
// (a) The template: loader, argv substitution, Plan-time refusal
// ---------------------------------------------------------------------------

function workspaceDir(commands: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), "tldrx-dod-scoped-"));
  dirs.push(root);
  mkdirSync(join(root, ".tldrx"), { recursive: true });
  writeFileSync(
    join(root, ".tldrx", "workspace.yml"),
    ["version: 1", "mode: single", 'root: "."', "repos:", "  - name: app",
      '    path: "."', "    commands:", ...commands.map((c) => `      ${c}`), ""].join("\n"),
    "utf8",
  );
  return root;
}

describe("commands.<slot>_scoped is a template, kept out of the allowlist", () => {
  test("the loader maps the full command to its template and declares neither as a command", () => {
    const ws = loadWorkspace(workspaceDir([`test: "${FULL}"`, `test_scoped: "${TEMPLATE}"`, 'lint: "npm run lint"']));
    expect(ws.scopedCommands.get("app")?.get(FULL)).toBe(TEMPLATE);
    expect(ws.scopedTemplates.has(TEMPLATE)).toBe(true);
    // NOT citable, NOT a developer tool: the flat set and the per-repo list are as
    // they were before the slot existed.
    expect(ws.commands.has(TEMPLATE)).toBe(false);
    expect([...ws.commands].sort()).toEqual(["npm run lint", FULL]);
    expect(ws.repoCommands.get("app")).toEqual([FULL, "npm run lint"]);
  });

  test("a template without {{paths}} is ignored, and so is one whose base slot is not declared", () => {
    const noToken = loadWorkspace(workspaceDir([`test: "${FULL}"`, 'test_scoped: "node scripts/scoped.js"']));
    expect(noToken.scopedCommands.get("app")?.size ?? 0).toBe(0);
    expect(noToken.scopedTemplates.size).toBe(0);
    expect(noToken.commands.has("node scripts/scoped.js")).toBe(false);
    const orphan = loadWorkspace(workspaceDir(['lint: "npm run lint"', `test_scoped: "${TEMPLATE}"`]));
    expect(orphan.scopedCommands.get("app")?.size ?? 0).toBe(0);
    expect(orphan.commands.has(TEMPLATE)).toBe(false);
  });

  test("a workspace without one reads exactly as before", () => {
    const ws = loadWorkspace(workspaceDir([`test: "${FULL}"`]));
    expect(ws.scopedCommands.get("app")?.size ?? 0).toBe(0);
    expect(ws.scopedTemplates.size).toBe(0);
    expect(scopedSlotOf("test")).toBeNull();
    expect(scopedSlotOf("test_scoped")).toBe("test");
    expect(scopedSlotOf("_scoped")).toBeNull();
  });

  test("{{paths}} becomes N argv elements — a path with a space is ONE argument, and no shell is opened", () => {
    expect(scopedArgv(TEMPLATE, ["s1.txt", "we ird.txt"])).toEqual(["node", "scripts/scoped.js", "s1.txt", "we ird.txt"]);
    expect(scopedArgv(`pytest ${PATHS_PLACEHOLDER} -q`, ["a/b.py"])).toEqual(["pytest", "a/b.py", "-q"]);
    // The token must be a whole word, and there must be exactly one.
    expect(scopedArgv(`pytest x${PATHS_PLACEHOLDER}`, ["a"])).toBeNull();
    expect(scopedArgv(`pytest ${PATHS_PLACEHOLDER} ${PATHS_PLACEHOLDER}`, ["a"])).toBeNull();
    // A metacharacter outside the token is refused the way every command is.
    expect(scopedArgv(`pytest ${PATHS_PLACEHOLDER} | tee`, ["a"])).toBeNull();
    expect(renderScopedCommand(TEMPLATE, ["s1.txt", "we ird.txt"])).toBe('node scripts/scoped.js s1.txt "we ird.txt"');
  });

  test("a path that starts with `-` is rendered as ./<path> — still a path, still tested, never a flag", () => {
    // A repo file named `-rf` or `--foo` spliced straight into argv is a FLAG to
    // the runner. Not dropped (it changed, it gets tested) and no `--` (not every
    // runner accepts one): the one renderer prefixes `./`.
    expect(scopedArgv(`pytest ${PATHS_PLACEHOLDER}`, ["-rf", "--foo", "-", "src/a.py"]))
      .toEqual(["pytest", "./-rf", "./--foo", "./-", "src/a.py"]);
    expect(renderScopedCommand(`pytest ${PATHS_PLACEHOLDER}`, ["-rf", "src/a.py"])).toBe("pytest ./-rf src/a.py");
  });
});

const STORY_TEXT = (command: string): string => [
  "---", "version: 1", "id: S1", "epic: E1", 'title: "One story"', "repo: app",
  "status: todo", "depends_on: []", 'touches: ["src/"]',
  'acceptance: ["it works"]', 'test_plan: ["$ npm run test -> exit 0"]', "evidence: []",
  "---", "", "```dod", command, "```", "",
].join("\n");

describe("a dod line may not name a scoped template", () => {
  const allowed = new Set([FULL]);
  const scoped = new Set([TEMPLATE]);

  test("refused at Plan time, and the sentence NAMES the slot", () => {
    const issues = validateStoryDod(parseDodBlock("```dod\n" + TEMPLATE + "\n```"), allowed, "dod", new Set(), scoped);
    expect(issues.map((issue) => issue.message)).toEqual([scopedOnlyDodMessage(TEMPLATE)]);
    expect(issues[0]?.message).not.toBe(notDeclaredMessage(TEMPLATE, "story"));
    expect(issues[0]?.message).toContain(SCOPED_SUFFIX);
    expect(validateStoryDod(parseDodBlock("```dod\n" + FULL + "\n```"), allowed, "dod", new Set(), scoped)).toEqual([]);
  });

  test("validateStoryFile and validatePlan carry the refusal", () => {
    expect(validateStoryFile(STORY_TEXT(TEMPLATE), allowed, new Set(), scoped).validation.issues
      .map((issue) => issue.message)).toContain(scopedOnlyDodMessage(TEMPLATE));
    const planDir = mkdtempSync(join(tmpdir(), "tldrx-dod-scoped-plan-"));
    dirs.push(planDir);
    mkdirSync(join(planDir, "stories"), { recursive: true });
    mkdirSync(join(planDir, "epics"), { recursive: true });
    writeFileSync(join(planDir, "stories", "S1.md"), STORY_TEXT(TEMPLATE), "utf8");
    writeFileSync(
      join(planDir, "epics", "E1.md"),
      ["---", "version: 1", "id: E1", 'title: "One epic"', "repos: [app]",
        "stories: [S1]", "branch: epic/scoped", "status: todo", "---", "", "# E1", ""].join("\n"),
      "utf8",
    );
    writeFileSync(join(planDir, "waves.yml"), ["version: 1", "waves:", "  - id: W1", "    stories: [S1]", ""].join("\n"), "utf8");
    const report = validatePlan(planDir, allowed, new Set(), scoped);
    expect(report.ok).toBe(false);
    expect(report.issues.map((issue) => issue.message)).toContain(scopedOnlyDodMessage(TEMPLATE));
  });
});

// ---------------------------------------------------------------------------
// (b) The paths: one derivation, filtered to what exists
// ---------------------------------------------------------------------------

describe("scopedPathsFor is the union of declared, committed and dirty — existing paths only", () => {
  test("declared ∪ committed diff ∪ dirty entries, deduped, sorted, a deleted file dropped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tldrx-scoped-paths-"));
    dirs.push(dir);
    const run = async (args: readonly string[]): Promise<void> => {
      const r = await git(args, dir);
      if (!r.ok) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    };
    await run(["init", "-q", "-b", "main"]);
    await run(["config", "user.email", "t@example.com"]);
    await run(["config", "user.name", "t"]);
    writeFileSync(join(dir, "base.txt"), "base\n");
    writeFileSync(join(dir, "gone.txt"), "gone\n");
    await run(["add", "."]);
    await run(["commit", "-q", "-m", "base"]);
    await run(["checkout", "-q", "-b", "story/S1"]);
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "committed.txt"), "c\n");
    await run(["add", "."]);
    await run(["rm", "-q", "gone.txt"]);
    await run(["commit", "-q", "-m", "story"]);
    writeFileSync(join(dir, "we ird.txt"), "dirty\n");
    writeFileSync(join(dir, "base.txt"), "changed\n");
    const paths = await scopedPathsFor({
      declared: ["src/", "declared-but-missing.txt", "base.txt"],
      repoDir: dir,
      worktree: dir,
      range: "main...story/S1",
    });
    expect(paths).toEqual(["base.txt", "src/", "src/committed.txt", "we ird.txt"]);
  });
});

// ---------------------------------------------------------------------------
// (c) The runner: scoped when a template exists AND paths are non-empty
// ---------------------------------------------------------------------------

/** A gate script that records its argv and exits as told. */
const GATE_SH = (exit: number): string => `#!/bin/sh
printf '%s\\n' "$@" > argv.txt
echo "gate ran"
exit ${String(exit)}
`;

async function runGate(
  exit: number,
  scoped: { paths: readonly string[] } | null,
): Promise<{ dir: string; events: Row[]; baseAsked: number }> {
  const dir = mkdtempSync(join(tmpdir(), "tldrx-dod-scoped-run-"));
  dirs.push(dir);
  writeFileSync(join(dir, "gate.sh"), GATE_SH(exit), "utf8");
  chmodSync(join(dir, "gate.sh"), 0o755);
  const command = "./gate.sh";
  const events: Row[] = [];
  let baseAsked = 0;
  await runStoryDod({
    storyId: "S1", repo: "app", worktree: dir, repoDir: dir, installDeclared: false,
    commands: [command], workspaceCommands: new Set([command]), timeoutMs: 30_000,
    phaseId: "04-build", runDir: dir,
    emit: (type, payload) => { events.push({ type, payload }); },
    baseResult: async () => { baseAsked++; return null; },
    ...(scoped === null ? {} : {
      scoped: { templates: new Map([[command, `${command} ${PATHS_PLACEHOLDER}`]]), paths: scoped.paths },
    }),
  });
  return { dir, events, baseAsked };
}

describe("runStoryDod", () => {
  test("scoped: the template runs with the paths as argv, the event says scope:paths and carries them", async () => {
    const ran = await runGate(0, { paths: ["a.txt", "we ird.txt"] });
    expect(ran.events).toHaveLength(1);
    expect(ran.events[0]?.type).toBe("check.passed");
    expect(ran.events[0]?.payload.scope).toBe("paths");
    expect(ran.events[0]?.payload.paths).toEqual(["a.txt", "we ird.txt"]);
    expect(ran.events[0]?.payload.command).toBe('./gate.sh a.txt "we ird.txt"');
    expect(readFileSync(join(ran.dir, "argv.txt"), "utf8")).toBe("a.txt\nwe ird.txt\n");
  });

  test("no mappable paths: the full command runs, byte-identical, and the event says scope:full", async () => {
    const ran = await runGate(0, { paths: [] });
    expect(ran.events).toHaveLength(1);
    expect(ran.events[0]?.payload.scope).toBe("full");
    expect(ran.events[0]?.payload).not.toHaveProperty("paths");
    expect(ran.events[0]?.payload.command).toBe("./gate.sh");
    expect(readFileSync(join(ran.dir, "argv.txt"), "utf8")).toBe("\n");
  });

  test("no template declared: no scope key at all (the golden's control)", async () => {
    const ran = await runGate(0, null);
    expect(ran.events[0]?.payload).not.toHaveProperty("scope");
    expect(ran.events[0]?.payload).not.toHaveProperty("paths");
  });

  test("a scoped RED never consults the base tree — the base ran a different command", async () => {
    const scoped = await runGate(1, { paths: ["a.txt"] });
    expect(scoped.events[0]?.type).toBe("check.failed");
    expect(scoped.baseAsked).toBe(0);
    const full = await runGate(1, { paths: [] });
    expect(full.baseAsked).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// (d) End to end: 2 scoped + 1 full on the epic head
// ---------------------------------------------------------------------------

describe("a two-story epic with test_scoped declared", () => {
  test("exactly 2 scope:paths checks with the right paths, and 1 scope:full on the epic head", async () => {
    const ws = scopedWorkspace({
      stories: [
        { id: "S1", epic: "E1", title: "First story", touches: ["s1.txt", "we ird.txt"] },
        { id: "S2", epic: "E1", title: "Second story" },
      ],
      commands: { build: null, test: FULL, lint: null, typecheck: null, test_scoped: TEMPLATE, install: "node scripts/install.js" },
    });
    process.env.FAKE_BUILD_WRITE = JSON.stringify({ S1: { "s1.txt": "S1\n", "we ird.txt": "S1 too\n" } });
    const result = await next(ws);
    expect(result.code).toBe(4);

    const checks = dodChecks(ws);
    const scoped = checks.filter((e) => e.payload.scope === "paths");
    const full = checks.filter((e) => e.payload.scope === "full");
    expect(checks).toHaveLength(3);
    expect(scoped).toHaveLength(2);
    expect(scoped.map((e) => e.payload.story)).toEqual(["S1", "S2"]);
    expect(scoped[0]?.payload.paths).toEqual(["s1.txt", "we ird.txt"]);
    expect(scoped[0]?.payload.command).toBe('node scripts/scoped.js s1.txt "we ird.txt"');
    expect(scoped[1]?.payload.paths).toEqual(["s2.txt"]);
    expect(scoped.every((e) => e.type === "check.passed")).toBe(true);
    expect(scoped.every((e) => !("lane" in e.payload))).toBe(true);

    expect(full).toHaveLength(1);
    expect(full[0]?.type).toBe("check.passed");
    expect(full[0]?.payload.command).toBe(FULL);
    expect(full[0]?.payload.lane).toBe("epic/e1");
    expect(full[0]?.payload.story).toBe("S2");
    expect(full[0]?.payload).not.toHaveProperty("paths");

    // The scoped script really received the paths as argv — one element each.
    const log = argvLog(ws);
    expect(log.map((row) => row.argv)).toEqual([["s1.txt", "we ird.txt"], ["s2.txt"]]);
    expect(log.every((row) => row.cwd.includes(join(".tldrx", "worktrees")))).toBe(true);

    // The epic worktree was INSTALLED into before the full suite ran there — once,
    // on the epic's lane, beside the two per-story installs.
    const installs = events(ws).filter((e) => e.type.startsWith("check.") && e.payload.check === "install");
    expect(installs.filter((e) => e.payload.lane === "epic/e1")).toHaveLength(1);
    expect(installs.filter((e) => !("lane" in e.payload))).toHaveLength(2);

    expect(storyStatus(ws, "S1")).toBe("done");
    expect(storyStatus(ws, "S2")).toBe("done");
    expect(epicStatus(ws, "E1")).toBe("done");
    const gate = events(ws).find((e) => e.type === "gate.requested");
    expect((gate?.payload.stories as { done: number }).done).toBe(2);
  });

  test("a red epic head blocks the LAST merged story, so the gate's stories count refuses", async () => {
    // Green on the base and on every story's scoped run; red only once S2's
    // file is on the epic head — which is the exact hole a scoped-only proof has.
    const ws = scopedWorkspace({
      testScript: "node -e \"process.exit(require('fs').existsSync('s2.txt') ? 1 : 0)\"",
    });
    await next(ws);
    const full = dodChecks(ws).filter((e) => e.payload.scope === "full");
    expect(full).toHaveLength(1);
    expect(full[0]?.type).toBe("check.failed");
    expect(full[0]?.payload.exit_code).toBe(1);
    expect(full[0]?.payload.story).toBe("S2");
    expect(full[0]?.payload.lane).toBe("epic/e1");

    expect(storyStatus(ws, "S1")).toBe("done");
    expect(storyStatus(ws, "S2")).toBe("blocked");
    expect(epicStatus(ws, "E1")).toBe("blocked");
    const gate = events(ws).find((e) => e.type === "gate.requested");
    expect((gate?.payload.stories as { blocked: number }).blocked).toBe(1);
    const done = events(ws).filter((e) => e.type === "task.done" && e.payload.story === "S2");
    expect(done.at(-1)?.payload.status).toBe("blocked");
    const handoff = readFileSync(join(ws.runDir, "04-build", "handoff.md"), "utf8");
    expect(handoff).toContain("epic/e1");
  });

  test("control: with no template declared there is no scope key, no lane, one check per story", async () => {
    const ws = scopedWorkspace({}, false);
    await next(ws);
    const checks = dodChecks(ws);
    expect(checks).toHaveLength(2);
    expect(checks.every((e) => !("scope" in e.payload) && !("paths" in e.payload) && !("lane" in e.payload))).toBe(true);
    expect(argvLog(ws)).toEqual([]);
  });
});
