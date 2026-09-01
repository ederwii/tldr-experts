/**
 * The dispatch-notes slot (wave 1B) — the one place a HOST can add context to a
 * prompt the framework generated.
 *
 * Measured over one full run, 2026-08-30: every stage needed host-added context
 * the bundle lacked, and the host's only two options were editing the
 * framework's own `stage.md` or editing a `prompt.md` the next `--prepare` would
 * overwrite. The tests below are about the three properties that make a third
 * option safe rather than another way to smuggle instructions in:
 *
 *  - an ABSENT file changes nothing, byte for byte;
 *  - a PRESENT file is counted — against the 8 KB slot cap and against
 *    `prompt_max_bytes`, so it can never be free;
 *  - it is CONTEXT, not configuration: never substituted, never parsed.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DISPATCH_NOTES_FILE, DISPATCH_NOTES_HEADING, DISPATCH_NOTES_MAX_BYTES,
  describeDispatchNotes, dispatchNotesPath, loadDispatchNotes, sliceBytes,
} from "../src/core/facilitator/dispatchNotes.ts";
import { buildPrompt, renderParts, type PromptParts } from "../src/core/facilitator/prompt.ts";
import { buildLedger } from "../src/core/facilitator/contextLedger.ts";
import { dispatchNotesRecord, type PendingStage } from "../src/core/facilitator/pending.ts";
import { buildDeveloperPrompt } from "../src/core/build/prompts.ts";
import type { PlannedEpic, PlannedStory } from "../src/core/build/plan.ts";
import { runNext, type NextOptions } from "../src/core/facilitator/runNext.ts";
import {
  makeFacilitatorWorkspace, type FacilitatorWorkspace, type StageOptions,
} from "./fixtures/facilitator/workspace.ts";
import { makeBuildWorkspace, type BuildWorkspace, type BuildWorkspaceOptions } from "./fixtures/build/workspace.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

// Every test in this file spawns a REAL process — git, `bun`, the CLI. Process cost is a
// property of the machine, not of the code, so bun's fixed 5000 ms default measures the box:
// on an untouched tree, tests here timed out while the same files passed alone (#43). The
// budget scales with measured load; the assertions are untouched, and a hang is still caught.
setDefaultTimeout(spawnTestTimeout());

// ---------------------------------------------------------------------------
// loadDispatchNotes — reading the slot
// ---------------------------------------------------------------------------

let scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  scratch = [];
});

/** A throwaway run dir with `.agent/<key>/dispatch-notes.md` written for each entry. */
function runDir(files: Readonly<Record<string, string>>): string {
  const dir = mkdtempSync(join(tmpdir(), "tldrx-notes-"));
  scratch.push(dir);
  for (const [key, content] of Object.entries(files)) {
    const path = dispatchNotesPath(dir, key);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content, "utf8");
  }
  return dir;
}

describe("loadDispatchNotes", () => {
  test("no file at all is an empty slot, and an empty slot renders no section", () => {
    const notes = loadDispatchNotes(runDir({}), ["01-what/what"]);
    expect(notes.body).toBe("");
    expect(notes.sources).toEqual([]);
    expect(notes.inlinedBytes).toBe(0);
    expect(notes.truncated).toBe(false);
    expect(describeDispatchNotes(notes)).toEqual([]);
    expect(dispatchNotesRecord(notes)).toEqual({});
  });

  test("a file that is only whitespace is the same as no file", () => {
    const notes = loadDispatchNotes(runDir({ "01-what/what": "\n\n   \n" }), ["01-what/what"]);
    expect(notes.body).toBe("");
    expect(notes.sources).toEqual([]);
  });

  test("the note's own prose reaches the body verbatim, under a path marker", () => {
    const dir = runDir({ "01-what/what": "D008 was deferred; treat it as OPEN.\n" });
    const notes = loadDispatchNotes(dir, ["01-what/what"]);
    expect(notes.body).toContain("D008 was deferred; treat it as OPEN.");
    expect(notes.body).toContain("<!-- .agent/01-what/what/dispatch-notes.md -->");
    expect(notes.sources).toEqual([
      { rel: ".agent/01-what/what/dispatch-notes.md", totalBytes: 37, inlinedBytes: 37 },
    ]);
  });

  test("stage-level first, story-level second — one slot, one order", () => {
    const dir = runDir({
      "build": "Docker is up; the compose stack was started at 21:40.\n",
      "build/S5": "The OTP table was migrated by hand.\n",
    });
    const notes = loadDispatchNotes(dir, ["build", "build/S5"]);
    expect(notes.sources.map((s) => s.rel)).toEqual([
      ".agent/build/dispatch-notes.md",
      ".agent/build/S5/dispatch-notes.md",
    ]);
    expect(notes.body.indexOf("Docker is up")).toBeLessThan(notes.body.indexOf("OTP table"));
  });

  test("the same key twice is read once", () => {
    const dir = runDir({ build: "once\n" });
    expect(loadDispatchNotes(dir, ["build", "build"]).sources).toHaveLength(1);
  });

  test("`{{run}}` inside a note is the host's own text, never substituted", () => {
    // The whole point of the slot: prose the host wrote for its own sub-agent.
    // A placeholder the facilitator owns is not one the operator wrote.
    const dir = runDir({ "01-what/what": "the literal string {{run}} must survive\n" });
    const parts = base({ dispatchNotes: loadDispatchNotes(dir, ["01-what/what"]).body });
    expect(buildPrompt(parts)).toContain("the literal string {{run}} must survive");
  });
});

describe("the 8 KB cap", () => {
  const OVER = `${"x".repeat(DISPATCH_NOTES_MAX_BYTES + 500)}\n`;

  test("a file over the cap is cut, named, and marked truncated", () => {
    const notes = loadDispatchNotes(runDir({ build: OVER }), ["build"]);
    expect(notes.truncated).toBe(true);
    expect(notes.inlinedBytes).toBe(DISPATCH_NOTES_MAX_BYTES);
    expect(notes.body).toContain("dispatch-notes budget ran out");
    expect(notes.sources[0]?.totalBytes).toBe(DISPATCH_NOTES_MAX_BYTES + 501);
    expect(notes.sources[0]?.inlinedBytes).toBe(DISPATCH_NOTES_MAX_BYTES);
  });

  test("the cap is ONE budget across both files, not one each", () => {
    const notes = loadDispatchNotes(runDir({ build: OVER, "build/S5": "and this too\n" }), ["build", "build/S5"]);
    expect(notes.inlinedBytes).toBe(DISPATCH_NOTES_MAX_BYTES);
    // The stage file spent it all, so the story's file is NAMED rather than
    // silently dropped — the same rule a truncated declared input follows.
    expect(notes.sources[1]?.inlinedBytes).toBe(0);
    expect(notes.body).toContain("None of this file fit");
    expect(notes.body).not.toContain("and this too");
  });

  test("the cut is named on stdout with the command that avoids it", () => {
    const said = describeDispatchNotes(loadDispatchNotes(runDir({ build: OVER }), ["build"])).join("\n");
    expect(said).toContain("dispatch notes:");
    expect(said).toContain(".agent/build/dispatch-notes.md");
    expect(said).toContain("facts.yml");
  });

  test("a byte cap never splits a character in half", () => {
    // `Buffer.subarray().toString()` alone turns the dangling continuation byte
    // into U+FFFD, so a 4-byte cap could yield 3 bytes of text plus a 3-byte
    // replacement character — a cap that ADDS a byte is not a cap.
    const text = "aé€😀";
    for (let limit = 0; limit <= Buffer.byteLength(text, "utf8"); limit++) {
      const cut = sliceBytes(text, limit);
      expect(Buffer.byteLength(cut, "utf8")).toBeLessThanOrEqual(limit);
      expect(cut).not.toContain("�");
      expect(text.startsWith(cut)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Position in the assembled prompt
// ---------------------------------------------------------------------------

const VALUES = {
  run: "260830-demo",
  repos: "api",
  inputs: "- a.md",
  facts: "_none_",
  conventions: "_none_",
  budget_usd: "4.00",
} as const;

function base(overrides: Partial<PromptParts> = {}): PromptParts {
  return {
    stageMd: "# Stage\n\n## Role\n\nYou are the product expert.\n",
    values: VALUES,
    experts: [{ name: "product", body: "# product\n\nBody." }],
    inputs: [{ path: "a.md", content: "alpha" }],
    ...overrides,
  };
}

describe("where the section goes", () => {
  test("between `## Inputs` and `## Previous attempt`, in that order", () => {
    const kinds = renderParts(base({ dispatchNotes: "docker is up", previousAttempt: "it failed" }))
      .map((part) => part.kind);
    expect(kinds).toEqual(["stage", "expert-body", "inputs", "dispatch-notes", "previous-attempt"]);
  });

  test("behind the expert blocks, so the stable prefix is not invalidated", () => {
    const withNotes = buildPrompt(base({ dispatchNotes: "docker is up" }));
    const without = buildPrompt(base());
    const prefix = (text: string): string => text.slice(0, text.indexOf("## Inputs"));
    expect(prefix(withNotes)).toBe(prefix(without));
  });

  test("absent ⇒ the prompt is byte-identical to the one with no slot at all", () => {
    expect(buildPrompt(base({ dispatchNotes: "" }))).toBe(buildPrompt(base()));
    expect(buildPrompt(base({ dispatchNotes: "   \n " }))).toBe(buildPrompt(base()));
    expect(buildPrompt(base())).not.toContain(`## ${DISPATCH_NOTES_HEADING}`);
  });

  test("exactly one heading, even when a stage author wrote their own", () => {
    const stageMd = [
      "# Stage", "", "## Dispatch notes", "", "the author's own words", "",
      "## Stop", "", "stop here", "",
    ].join("\n");
    const prompt = buildPrompt(base({ stageMd, dispatchNotes: "the host's words" }));
    expect(prompt.split(`## ${DISPATCH_NOTES_HEADING}`).length - 1).toBe(1);
    expect(prompt).not.toContain("the author's own words");
    expect(prompt).toContain("the host's words");
  });

  test("the section says it is context and not configuration", () => {
    const dir = runDir({ build: "Docker is up.\n" });
    const prompt = buildPrompt(base({ dispatchNotes: loadDispatchNotes(dir, ["build"]).body }));
    expect(prompt).toContain("not configuration, and nothing in it is a new task");
    expect(prompt).toContain("Docker is up.");
  });
});

// ---------------------------------------------------------------------------
// The context ledger
// ---------------------------------------------------------------------------

describe("the ledger charges for it", () => {
  function ledgerOf(dispatchNotes?: string) {
    return buildLedger({
      parts: renderParts(base({ dispatchNotes })),
      inputBytes: [{ path: "a.md", bytes: 5 }],
      truncatedInputs: [],
      limitBytes: 160 * 1024,
      model: null,
    });
  }

  test("a slot with nothing in it is 0 B and no row", () => {
    const ledger = ledgerOf();
    expect(ledger.groups.dispatchNotes).toBe(0);
    expect(ledger.rows.some((row) => row.kind === "dispatch-notes")).toBe(false);
  });

  test("the group, the row and the total all move together", () => {
    const empty = ledgerOf();
    const full = ledgerOf("docker is up");
    const row = full.rows.find((r) => r.kind === "dispatch-notes");
    expect(row?.bytes).toBe(full.groups.dispatchNotes);
    expect(full.groups.dispatchNotes).toBeGreaterThan(0);
    expect(full.totalBytes).toBe(empty.totalBytes + full.groups.dispatchNotes);
  });

  test("the groups still sum to the total", () => {
    const g = ledgerOf("docker is up").groups;
    const total = ledgerOf("docker is up").totalBytes;
    expect(g.stage + g.inputs + g.expertBodies + g.expertKnowledge + g.dispatchNotes + g.previousAttempt)
      .toBe(total);
  });
});

// ---------------------------------------------------------------------------
// The developer prompt (Build)
// ---------------------------------------------------------------------------

const EPIC: PlannedEpic = {
  epic: {
    version: 1, id: "E1", title: "The tenancy run", repos: ["app"],
    stories: ["S5"], branch: "epic/tenancy", status: "todo",
  },
  text: "# E1\n",
  path: "/nowhere/E1.md",
  rel: "03-plan/epics/E1.md",
};

const STORY: PlannedStory = {
  story: {
    version: 1, id: "S5", epic: "E1", title: "OTP confirm",
    repo: "app", status: "todo", depends_on: [], touches: [],
    acceptance: ["it confirms"], test_plan: ["$ npm test -> exit 0"], evidence: [],
  },
  dod: { present: true, commands: ["npm test"] },
  text: "# S5\n",
  path: "/nowhere/S5.md",
  rel: "03-plan/stories/S5.md",
  wave: "W1",
  goal: [],
};

function devPrompt(dispatchNotes?: string): string {
  return buildDeveloperPrompt({
    runId: "260830-tenancy",
    story: STORY,
    epic: EPIC,
    repoName: "app",
    branch: "story/260830-tenancy/S5",
    epicBranch: "epic/tenancy",
    worktree: "/nowhere",
    commands: ["npm test"],
    conventions: "_none_",
    facts: "_none_",
    experts: [],
    budgetUsd: 4,
    dispatchNotes,
  });
}

describe("the developer prompt", () => {
  test("absent ⇒ byte-identical to the prompt with no slot at all", () => {
    expect(devPrompt("")).toBe(devPrompt());
    expect(devPrompt("   ")).toBe(devPrompt());
    expect(devPrompt()).not.toContain(`## ${DISPATCH_NOTES_HEADING}`);
  });

  test("present ⇒ once, after `## Inputs` and before the rest of the brief", () => {
    const text = devPrompt("Docker is up.");
    expect(text.split(`## ${DISPATCH_NOTES_HEADING}`).length - 1).toBe(1);
    expect(text.indexOf("## Inputs")).toBeLessThan(text.indexOf(`## ${DISPATCH_NOTES_HEADING}`));
    expect(text.indexOf(`## ${DISPATCH_NOTES_HEADING}`)).toBeLessThan(text.indexOf("## Investigate"));
    expect(text).toContain("Docker is up.");
  });
});

// ---------------------------------------------------------------------------
// End to end, through `tldrx next --prepare`
// ---------------------------------------------------------------------------

let facWorkspaces: FacilitatorWorkspace[] = [];
let buildWorkspaces: BuildWorkspace[] = [];
const ORIGINAL_PATH = process.env.PATH ?? "";

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  delete process.env.FAKE_BUILD_STATE;
  for (const ws of facWorkspaces) ws.dispose();
  for (const ws of buildWorkspaces) ws.dispose();
  facWorkspaces = [];
  buildWorkspaces = [];
});

const ONE_STAGE: readonly StageOptions[] = [
  { id: "what", phase: "01-what", budgetUsd: 4, outputs: [{ path: "01-what/handoff.md" }] },
];

function facWorkspace(): FacilitatorWorkspace {
  const made = makeFacilitatorWorkspace({ scope: "demo", stages: ONE_STAGE, budgetUsd: 10 });
  facWorkspaces.push(made);
  return made;
}

function prepare(ws: FacilitatorWorkspace, overrides: Partial<NextOptions> = {}) {
  return runNext({
    root: ws.root,
    dryRun: false,
    mode: "prepare",
    yolo: false,
    actor: "alan",
    at: "2026-08-30T09:00:00Z",
    ...overrides,
  });
}

function promptOf(ws: FacilitatorWorkspace): string {
  return readFileSync(join(ws.runDir, ".agent", "what", "prompt.md"), "utf8");
}

function pendingOf(ws: FacilitatorWorkspace): PendingStage {
  return JSON.parse(readFileSync(join(ws.runDir, ".agent", "what", "pending.json"), "utf8")) as PendingStage;
}

function writeNotes(runDir: string, key: string, content: string): string {
  const path = dispatchNotesPath(runDir, key);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf8");
  return path;
}

describe("tldrx next --prepare", () => {
  test("absent ⇒ no section, no `dispatch_notes` key, and 0 B in the ledger", async () => {
    const ws = facWorkspace();
    expect((await prepare(ws)).code).toBe(0);
    expect(promptOf(ws)).not.toContain(`## ${DISPATCH_NOTES_HEADING}`);
    const pending = pendingOf(ws);
    expect(pending.dispatch_notes).toBeUndefined();
    expect(pending.context?.dispatch_notes_bytes).toBe(0);
  });

  test("adding the file, then removing it, restores the byte-identical prompt", async () => {
    const ws = facWorkspace();
    await prepare(ws);
    const before = promptOf(ws);

    const path = writeNotes(ws.runDir, "what", "D008 was deferred; treat it as OPEN.\n");
    await prepare(ws, { discardPending: true });
    expect(promptOf(ws)).toContain(`## ${DISPATCH_NOTES_HEADING}`);

    rmSync(path);
    await prepare(ws, { discardPending: true });
    expect(promptOf(ws)).toBe(before);
  });

  test("present ⇒ one section, its bytes in pending.json, its file named on stdout", async () => {
    const ws = facWorkspace();
    writeNotes(ws.runDir, "what", "D008 was deferred; treat it as OPEN.\n");
    const result = await prepare(ws);
    expect(result.code).toBe(0);

    const prompt = promptOf(ws);
    expect(prompt.split(`## ${DISPATCH_NOTES_HEADING}`).length - 1).toBe(1);
    expect(prompt.indexOf("## Inputs")).toBeLessThan(prompt.indexOf(`## ${DISPATCH_NOTES_HEADING}`));
    expect(prompt).toContain("D008 was deferred; treat it as OPEN.");

    const pending = pendingOf(ws);
    expect(pending.dispatch_notes?.bytes).toBe(37);
    expect(pending.dispatch_notes?.truncated).toBe(false);
    expect(pending.dispatch_notes?.max_bytes).toBe(DISPATCH_NOTES_MAX_BYTES);
    expect(pending.dispatch_notes?.sources).toEqual([".agent/what/dispatch-notes.md"]);
    // The ledger charges the whole rendered SECTION, which is the note plus the
    // heading and the framing sentence — more than the note's own bytes.
    expect(pending.context?.dispatch_notes_bytes).toBeGreaterThan(37);
    expect(result.lines.join("\n")).toContain(".agent/what/dispatch-notes.md");
  });

  test("it counts against `prompt_max_bytes`, so the slot is never free", async () => {
    const ws = facWorkspace();
    await prepare(ws);
    const total = pendingOf(ws).context?.total_bytes ?? 0;
    expect(total).toBeGreaterThan(0);

    // A ceiling the prompt fits under with 200 bytes to spare...
    const roomy = await prepare(ws, { discardPending: true, promptMaxBytes: total + 200 });
    expect(roomy.code).toBe(0);

    // ...is a ceiling a 2 KB note breaks.
    writeNotes(ws.runDir, "what", `${"note. ".repeat(400)}\n`);
    const refused = await prepare(ws, { discardPending: true, promptMaxBytes: total + 200 });
    expect(refused.code).toBe(2);
    expect(refused.lines.join("\n")).toContain("refusing to start stage");
  });

  test("`--discard-pending` bins the bundle and KEEPS the notes", async () => {
    const ws = facWorkspace();
    const path = writeNotes(ws.runDir, "what", "Docker is up.\n");
    await prepare(ws);
    expect(existsSync(join(ws.runDir, ".agent", "what", "pending.json"))).toBe(true);

    const again = await prepare(ws, { discardPending: true });
    expect(again.code).toBe(0);
    expect(again.lines.join("\n")).toContain("discarded the --prepare bundle");
    expect(existsSync(path)).toBe(true);
    expect(promptOf(ws)).toContain("Docker is up.");
  });
});

// ---------------------------------------------------------------------------
// End to end, through the Build executor
// ---------------------------------------------------------------------------

const ONE_STORY: BuildWorkspaceOptions = {
  stories: [{ id: "S1", epic: "E1", title: "First story" }],
  epics: [{ id: "E1", stories: ["S1"], branch: "epic/e1" }],
  waves: [["S1"]],
};

function buildWorkspace(): BuildWorkspace {
  const made = makeBuildWorkspace(ONE_STORY);
  buildWorkspaces.push(made);
  process.env.PATH = made.binDir;
  process.env.FAKE_BUILD_STATE = made.statePath;
  return made;
}

describe("the Build executor's per-story bundle", () => {
  test("absent ⇒ no section and no `dispatch_notes` key", async () => {
    const ws = buildWorkspace();
    const result = await runNext({
      root: ws.root, dryRun: false, mode: "prepare", yolo: false,
      actor: "alan", at: "2026-08-30T09:00:00Z",
    });
    expect(result.code).toBe(0);
    const dir = join(ws.runDir, ".agent", "build", "S1");
    expect(readFileSync(join(dir, "prompt.md"), "utf8")).not.toContain(`## ${DISPATCH_NOTES_HEADING}`);
    const pending = JSON.parse(readFileSync(join(dir, "pending.json"), "utf8")) as PendingStage;
    expect(pending.dispatch_notes).toBeUndefined();
  });

  test("the stage's file and the story's own both render, stage first", async () => {
    const ws = buildWorkspace();
    writeNotes(ws.runDir, "build", "Docker is up; the compose stack was started at 21:40.\n");
    writeNotes(ws.runDir, join("build", "S1"), "The OTP table was migrated by hand.\n");

    const result = await runNext({
      root: ws.root, dryRun: false, mode: "prepare", yolo: false,
      actor: "alan", at: "2026-08-30T09:00:00Z",
    });
    expect(result.code).toBe(0);

    const dir = join(ws.runDir, ".agent", "build", "S1");
    const prompt = readFileSync(join(dir, "prompt.md"), "utf8");
    expect(prompt.split(`## ${DISPATCH_NOTES_HEADING}`).length - 1).toBe(1);
    expect(prompt.indexOf("## Inputs")).toBeLessThan(prompt.indexOf(`## ${DISPATCH_NOTES_HEADING}`));
    expect(prompt.indexOf(`## ${DISPATCH_NOTES_HEADING}`)).toBeLessThan(prompt.indexOf("## Investigate"));
    expect(prompt.indexOf("Docker is up")).toBeLessThan(prompt.indexOf("OTP table"));

    const pending = JSON.parse(readFileSync(join(dir, "pending.json"), "utf8")) as PendingStage;
    expect(pending.dispatch_notes?.sources).toEqual([
      ".agent/build/dispatch-notes.md",
      ".agent/build/S1/dispatch-notes.md",
    ]);
    expect(pending.dispatch_notes?.bytes).toBe(54 + 36);
    expect(result.lines.join("\n")).toContain(".agent/build/S1/dispatch-notes.md");
  });

  test(`\`--discard-pending\` keeps ${DISPATCH_NOTES_FILE} while binning the bundle`, async () => {
    const ws = buildWorkspace();
    const path = writeNotes(ws.runDir, join("build", "S1"), "The OTP table was migrated by hand.\n");
    await runNext({
      root: ws.root, dryRun: false, mode: "prepare", yolo: false,
      actor: "alan", at: "2026-08-30T09:00:00Z",
    });
    const again = await runNext({
      root: ws.root, dryRun: false, mode: "prepare", yolo: false, discardPending: true,
      actor: "alan", at: "2026-08-30T09:05:00Z",
    });
    expect(again.code).toBe(0);
    expect(again.lines.join("\n")).toContain("discarded the --prepare bundle");
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(join(ws.runDir, ".agent", "build", "S1", "prompt.md"), "utf8"))
      .toContain("The OTP table was migrated by hand.");
  });
});
