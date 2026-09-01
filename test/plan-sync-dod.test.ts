/**
 * `tldrx plan sync-dod` — the mechanical resync of approved story dod blocks
 * (issue #42).
 *
 * A story's ```dod block may only name commands `.tldrx/workspace.yml` declares,
 * VERBATIM — "a story may not invent one". That rule is not relaxed here and must
 * never be: it is what stops a data file from running an arbitrary shell command
 * as the user. What it lacked was an inverse. Measured on the live run
 * `260829-scoring-leaderboard`: fixing workspace.yml (a filtered `test:`, `lint:`
 * removed) instantly orphaned the dod blocks of **8 approved stories**, and the
 * only recoveries were hand-editing agent-approved artefacts or re-running the
 * whole Plan stage — a paid turn that would have churned 13 correct stories to
 * change two lines in 8 files.
 *
 * So the rewrite is mechanical, evidence-led and refuses to guess: a dod line is
 * substituted only when a PREVIOUS version of workspace.yml declared it under a
 * role the current file still has, dropped when that role is gone, and FLAGGED —
 * never rewritten — when no version of the file ever declared it. Everything
 * outside the dod lines is byte-identical afterwards.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { notDeclaredMessage } from "../src/core/schemas/commandAllowlist.ts";
import { validateStoryFile } from "../src/core/schemas/story.ts";
import { validatePlan } from "../src/core/plan/validatePlan.ts";
import { loadWorkspace } from "../src/hooks/lib/workspace.ts";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";
import { noSpawnEnv } from "./fixtures/noSpawnPath.ts";
import {
  makeBuildWorkspace, type BuildWorkspace, type BuildWorkspaceOptions,
} from "./fixtures/build/workspace.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

// Every test in this file spawns a REAL process — git, `bun`, the CLI. Process cost is a
// property of the machine, not of the code, so bun's fixed 5000 ms default measures the box:
// on an untouched tree, tests here timed out while the same files passed alone (#43). The
// budget scales with measured load; the assertions are untouched, and a hang is still caught.
setDefaultTimeout(spawnTestTimeout());

const BIN = join(FRAMEWORK_ROOT, "bin", "tldrx.ts");

let open: BuildWorkspace[] = [];

afterEach(() => {
  for (const ws of open) ws.dispose();
  open = [];
});

/**
 * A workspace whose ROOT is the git repo, so `.tldrx/workspace.yml` is committed
 * by the fixture's initial commit — which is exactly what makes the file have a
 * history to read a rename out of.
 */
function workspace(options: BuildWorkspaceOptions): BuildWorkspace {
  const made = makeBuildWorkspace({ rootIsRepo: true, ...options });
  open.push(made);
  return made;
}

async function tldrx(root: string, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", BIN, ...args, "--root", root], {
    stdout: "pipe", stderr: "pipe", cwd: FRAMEWORK_ROOT, env: noSpawnEnv(),
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

function storyPath(ws: BuildWorkspace, id: string): string {
  return join(ws.planDir, "stories", `${id}.md`);
}

function story(ws: BuildWorkspace, id: string): string {
  return readFileSync(storyPath(ws, id), "utf8");
}

/** The file with every dod COMMAND line removed — what must not move. */
function outsideDod(text: string): string {
  const kept: string[] = [];
  let inside = false;
  for (const line of text.split("\n")) {
    if (!inside && /^\s*```+\s*dod\s*$/i.test(line)) {
      inside = true;
      kept.push(line);
      continue;
    }
    if (inside) {
      if (/^\s*```+\s*$/.test(line)) {
        inside = false;
        kept.push(line);
      }
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

/** Rewrite `.tldrx/workspace.yml`'s commands map, leaving it UNCOMMITTED. */
function editCommands(ws: BuildWorkspace, commands: Readonly<Record<string, string | null>>): void {
  const path = join(ws.root, ".tldrx", "workspace.yml");
  const rendered = Object.entries(commands)
    .map(([key, value]) => `${key}: ${value === null ? "null" : JSON.stringify(value)}`)
    .join(", ");
  writeFileSync(path, readFileSync(path, "utf8").replace(/commands: \{.*\}/, `commands: {${rendered}}`), "utf8");
}

const V1 = { build: "npm run build", test: "npm run test", lint: "npm run lint" } as const;

const TWO_STORIES: BuildWorkspaceOptions = {
  commands: V1,
  stories: [
    { id: "S1", epic: "E1", title: "First story", dod: ["npm run test", "npm run lint"] },
    { id: "S2", epic: "E1", title: "Second story", dependsOn: ["S1"], dod: ["npm run build", "npm run test"] },
  ],
  epics: [{ id: "E1", stories: ["S1", "S2"], branch: "epic/e1" }],
  waves: [["S1"], ["S2"]],
};

// ---------------------------------------------------------------------------

describe("the drift error", () => {
  test("names the sync command as the remedy — the constraint alone is not actionable", () => {
    const message = notDeclaredMessage("npm run test", "story");
    expect(message).toContain("may not invent one");
    expect(message).toContain("tldrx plan sync-dod");
  });

  test("the story schema's own issue carries the remedy too", () => {
    const parsed = validateStoryFile(
      story(workspace(TWO_STORIES), "S1"),
      new Set(["npm run build"]),
    );
    const messages = parsed.validation.issues.map((i) => i.message).join("\n");
    expect(messages).toContain("tldrx plan sync-dod");
  });
});

describe("tldrx plan sync-dod", () => {
  test("golden: an edited workspace.yml is carried into every story, and nothing else moves", async () => {
    const ws = workspace(TWO_STORIES);
    const before = { S1: story(ws, "S1"), S2: story(ws, "S2") };
    // The live edit: `test` gains a filter, `lint` is removed outright.
    editCommands(ws, { build: "npm run build", test: "npm run test -- --filter core", lint: null });
    // The plan is broken by that edit — that is the state this command exists for.
    expect(validatePlan(ws.planDir, loadWorkspace(ws.root).commands).ok).toBe(false);

    const run = await tldrx(ws.root, "plan", "sync-dod");
    expect(run.code).toBe(0);

    // Renamed commands substituted, removed ones dropped.
    expect(validateStoryFile(story(ws, "S1"), loadWorkspace(ws.root).commands).dod.commands)
      .toEqual(["npm run test -- --filter core"]);
    expect(validateStoryFile(story(ws, "S2"), loadWorkspace(ws.root).commands).dod.commands)
      .toEqual(["npm run build", "npm run test -- --filter core"]);
    // The plan check — the SAME one — now passes.
    expect(validatePlan(ws.planDir, loadWorkspace(ws.root).commands).ok).toBe(true);
    // Byte-identical outside the dod lines.
    expect(outsideDod(story(ws, "S1"))).toBe(outsideDod(before.S1));
    expect(outsideDod(story(ws, "S2"))).toBe(outsideDod(before.S2));
  }, 60_000);

  test("prints a per-story diff summary", async () => {
    const ws = workspace(TWO_STORIES);
    editCommands(ws, { build: "npm run build", test: "npm run test -- --filter core", lint: null });

    const run = await tldrx(ws.root, "plan", "sync-dod");

    expect(run.stdout).toContain("S1");
    expect(run.stdout).toContain("S2");
    expect(run.stdout).toContain("npm run test -- --filter core");
    expect(run.stdout).toContain("npm run lint");
  }, 60_000);

  test("a dod line no version of workspace.yml ever declared is flagged, not rewritten", async () => {
    const ws = workspace({
      ...TWO_STORIES,
      stories: [
        { id: "S1", epic: "E1", title: "First story", dod: ["npm run test", "npm run bogus"] },
        { id: "S2", epic: "E1", title: "Second story", dependsOn: ["S1"], dod: ["npm run build"] },
      ],
    });
    const before = story(ws, "S1");
    editCommands(ws, { build: "npm run build", test: "npm run test -- --filter core", lint: null });

    const run = await tldrx(ws.root, "plan", "sync-dod");

    // Refused for that story, and the story is untouched — a line with no
    // ancestor is real drift, and guessing at it is the one thing this must not do.
    expect(run.code).toBe(2);
    expect(`${run.stdout}${run.stderr}`).toContain("npm run bogus");
    expect(story(ws, "S1")).toBe(before);
    // The stories that CAN be resynced still were: one bad line is not a veto on
    // the other seven files.
    expect(validateStoryFile(story(ws, "S2"), loadWorkspace(ws.root).commands).dod.commands)
      .toEqual(["npm run build"]);
  }, 60_000);

  test("--dry-run prints the same summary and writes nothing", async () => {
    const ws = workspace(TWO_STORIES);
    const before = story(ws, "S1");
    editCommands(ws, { build: "npm run build", test: "npm run test -- --filter core", lint: null });

    const run = await tldrx(ws.root, "plan", "sync-dod", "--dry-run");

    expect(run.code).toBe(0);
    expect(run.stdout).toContain("npm run test -- --filter core");
    expect(story(ws, "S1")).toBe(before);
  }, 60_000);

  test("a workspace with no git history flags rather than rewrites — no ancestor, no guess", async () => {
    // `rootIsRepo: false`: the REPO is a git repo, the workspace root is not, so
    // `.tldrx/workspace.yml` has never been committed and has no history at all.
    const ws = workspace({ ...TWO_STORIES, rootIsRepo: false });
    const before = story(ws, "S1");
    editCommands(ws, { build: "npm run build", test: "npm run test -- --filter core", lint: null });

    const run = await tldrx(ws.root, "plan", "sync-dod");

    expect(run.code).toBe(2);
    expect(run.stdout).toContain("no ancestor to follow");
    expect(story(ws, "S1")).toBe(before);
  }, 60_000);

  test("a workspace nobody edited syncs to a no-op", async () => {
    const ws = workspace(TWO_STORIES);
    const before = { S1: story(ws, "S1"), S2: story(ws, "S2") };

    const run = await tldrx(ws.root, "plan", "sync-dod");

    expect(run.code).toBe(0);
    expect(story(ws, "S1")).toBe(before.S1);
    expect(story(ws, "S2")).toBe(before.S2);
  }, 60_000);
});

/** `git` in the workspace repo — the history the sync reads its ancestors from. */
export function gitIn(ws: BuildWorkspace, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd: ws.root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
