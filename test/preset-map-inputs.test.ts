/**
 * The shipped stages' MAP inputs, and what happens to one that resolves to nothing.
 *
 * gh #131, reported off a live `feature` run. `stages/how/stage.yml` declared
 * `.tldrx/map/architecture.md` and `.tldrx/map/conventions.md`; `tldrx init`
 * writes those documents per repo, at `.tldrx/map/<repo>/architecture.md`
 * (`src/core/map/buildMap.ts:74-79`, `MAP_DOCS`). Nothing on disk answered either
 * declaration, they are OPTIONAL inputs, and `declaredInputsOf` drops an optional
 * input that is not present — so 02-how and 03-plan ran with no map at all and
 * nothing anywhere said so. 01-what and 05-watch had the `{repo}` token and
 * resolved correctly, which is why the fault survived: two stages of five.
 *
 * Two behaviours are pinned here, and they are separate:
 *
 *  1. every `MAP_DOCS` document a SHIPPED stage declares carries `{repo}`, for
 *     every scope preset — `workflows/*.yml` compose these same five stage files,
 *     so one guard covers all thirteen;
 *  2. a declared input that resolves to nothing is NAMED — in the prompt, so the
 *     stage's own handoff can cite it as `absent:`, and on stdout, so the
 *     operator sees it without opening the bundle. Silence is what made (1) a
 *     live incident rather than a typo somebody noticed on the first run.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { STAGES_DIR, WORKFLOWS_DIR } from "../src/core/paths.ts";
import { parseYaml } from "../src/core/yaml.ts";
import { MAP_DOCS } from "../src/core/map/MapFacts.ts";
import { loadStageSpec } from "../src/core/facilitator/stageSpec.ts";
import { expandAll, missing, present, type PathContext } from "../src/core/facilitator/paths.ts";
import { createRun } from "../src/core/run/newRun.ts";
import { makeRunWorkspace, type TempRunWorkspace } from "./fixtures/tempRunWorkspace.ts";
import { runNext } from "../src/core/facilitator/runNext.ts";
import { makeFacilitatorWorkspace, type FacilitatorWorkspace } from "./fixtures/facilitator/workspace.ts";

let workspaces: TempRunWorkspace[] = [];

afterEach(() => {
  for (const ws of workspaces) ws.dispose();
  workspaces = [];
});

const REPOS = ["api", "lab"] as const;

/** What `tldrx init` leaves behind on a multi-repo workspace: one folder per repo. */
function mapTree(): Record<string, string> {
  const files: Record<string, string> = {
    ".tldrx/map/workspace.md": "# Workspace\n\n- Two repos: api, lab [src: file:.tldrx/workspace.yml]\n",
  };
  for (const repo of REPOS) {
    for (const doc of MAP_DOCS) {
      files[`.tldrx/map/${repo}/${doc}.md`] = `# ${repo} — ${doc}\n\n- A real bullet [src: file:${repo}/src/main.ts:1]\n`;
    }
  }
  return files;
}

/** A `feature`-scope run over the shipped stage files, with a real map beside it. */
function featureRun(): { root: string; ctx: PathContext } {
  const ws = makeRunWorkspace({ files: mapTree() });
  workspaces.push(ws);
  const outcome = createRun({
    root: ws.root,
    slug: "leaderboard",
    scope: "feature",
    actor: "alan",
    now: new Date("2026-09-02T09:00:00Z"),
  });
  return { root: ws.root, ctx: { root: ws.root, runDir: outcome.runDir } };
}

/** Every path a stage declares, `{repo}`-expanded exactly as the facilitator does. */
function declaredFor(root: string, stageId: string): readonly string[] {
  const spec = loadStageSpec(root, "feature", stageId);
  return expandAll([...spec.requiredInputs, ...spec.optionalInputs], REPOS);
}

describe("gh #131 · the shipped stages resolve their map inputs", () => {
  test("02-how's architecture and conventions resolve for EVERY repo in the run", () => {
    const { root, ctx } = featureRun();
    const declared = declaredFor(root, "how");

    expect(present(declared, ctx)).toEqual(expect.arrayContaining([
      ".tldrx/map/api/architecture.md",
      ".tldrx/map/lab/architecture.md",
      ".tldrx/map/api/conventions.md",
      ".tldrx/map/lab/conventions.md",
    ]));
    // The live symptom: a declaration nothing on disk could ever answer. The
    // `01-what/*` inputs are legitimately missing here — What has not run — so
    // this is scoped to the workspace half, which init wrote before the run began.
    expect(missing(declared, ctx).filter((path) => path.startsWith(".tldrx/"))).toEqual([]);
  });

  test("01-what already resolved — the stage the placeholder was never dropped from", () => {
    const { root, ctx } = featureRun();
    const declared = declaredFor(root, "what");
    expect(present(declared, ctx)).toEqual(expect.arrayContaining([
      ".tldrx/map/api/domains.md",
      ".tldrx/map/lab/domains.md",
    ]));
  });

  test("03-plan's workspace.md is map-ROOT and stays so — `{repo}` would break it", () => {
    const { root, ctx } = featureRun();
    const declared = declaredFor(root, "plan");
    // `buildMap.ts:85` writes exactly one of these, beside the per-repo folders,
    // and only in multi-repo mode. It is not a `MAP_DOCS` document.
    expect(declared).toContain(".tldrx/map/workspace.md");
    expect(present(declared, ctx)).toContain(".tldrx/map/workspace.md");
  });
});

describe("gh #131 · the sweep: no shipped stage declares a per-repo map doc without `{repo}`", () => {
  const stageIds = readdirSync(STAGES_DIR).filter((id) => existsSync(join(STAGES_DIR, id, "stage.yml")));

  test("all five stage files are read by this sweep", () => {
    expect([...stageIds].sort()).toEqual(["build", "how", "plan", "watch", "what"]);
  });

  for (const id of stageIds) {
    test(`stages/${id}/stage.yml`, () => {
      for (const declared of declaredInputsOfFile(join(STAGES_DIR, id, "stage.yml"))) {
        for (const doc of MAP_DOCS) {
          if (!declared.endsWith(`/${doc}.md`) || !declared.startsWith(".tldrx/map/")) continue;
          expect(declared).toContain("{repo}");
        }
      }
    });
  }

  // The thirteen scope presets compose the five stage files above and declare no
  // inputs of their own; this is the assertion that keeps that true, so the guard
  // above cannot be quietly bypassed by a preset growing its own `inputs:`.
  test("no scope preset declares stage inputs of its own", () => {
    const scopes = readdirSync(WORKFLOWS_DIR).filter((name) => name.endsWith(".yml"));
    expect(scopes.length).toBe(13);
    for (const name of scopes) {
      const doc = parseYaml(readFileSync(join(WORKFLOWS_DIR, name), "utf8")) as Record<string, unknown>;
      const stages = Array.isArray(doc.stages) ? (doc.stages as unknown[]) : [];
      for (const entry of stages) {
        if (typeof entry === "string") continue;
        expect(Object.keys(entry as Record<string, unknown>)).not.toContain("inputs");
      }
    }
  });
});

/** `inputs:` of a stage file, in both spellings, flattened. */
function declaredInputsOfFile(path: string): readonly string[] {
  const doc = parseYaml(readFileSync(path, "utf8")) as Record<string, unknown>;
  const inputs = doc.inputs;
  if (Array.isArray(inputs)) return inputs.filter((v): v is string => typeof v === "string");
  if (typeof inputs === "object" && inputs !== null) {
    const record = inputs as Record<string, unknown>;
    return [...asStrings(record.required), ...asStrings(record.optional)];
  }
  return [];
}

function asStrings(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

// ---------------------------------------------------------------------------
// The second half of #131: an absence that is SAID, not performed
// ---------------------------------------------------------------------------

let facWorkspaces: FacilitatorWorkspace[] = [];

afterEach(() => {
  for (const ws of facWorkspaces) ws.dispose();
  facWorkspaces = [];
});

/** One stage declaring two OPTIONAL map documents; only one of them is on disk. */
function halfMappedWorkspace(): FacilitatorWorkspace {
  const made = makeFacilitatorWorkspace({
    scope: "demo",
    budgetUsd: 10,
    stages: [{
      id: "what",
      phase: "01-what",
      budgetUsd: 4,
      optional: [".tldrx/map/{repo}/architecture.md"],
      outputs: [{ path: "01-what/handoff.md" }],
    }],
    files: {
      ".tldrx/map/api/architecture.md": "# api\n\n- One real bullet [src: file:api/src/main.ts:1]\n",
    },
  });
  facWorkspaces.push(made);
  return made;
}

describe("gh #131 · a declared input that resolves to nothing is NAMED", () => {
  test("the prompt names it, in the `absent:` grammar the handoff has to cite it with", async () => {
    const ws = halfMappedWorkspace();
    const result = await runNext({
      root: ws.root, dryRun: false, mode: "prepare", yolo: false,
      actor: "alan", at: "2026-09-02T09:00:00Z",
    });
    expect(result.code).toBe(0);

    const prompt = readFileSync(join(ws.runDir, ".agent", "what", "prompt.md"), "utf8");
    // The one that IS there is inlined as it always was.
    expect(prompt).toContain(".tldrx/map/api/architecture.md");
    // The one that is NOT is named rather than dropped — with the citation token
    // that lets the stage's own handoff source a negative claim on it (§2.8).
    expect(prompt).toContain(".tldrx/map/lab/architecture.md");
    expect(prompt).toContain("absent:.tldrx/map/lab/architecture.md");
  });

  test("stdout names it too, so an operator sees it without opening the bundle", async () => {
    const ws = halfMappedWorkspace();
    const result = await runNext({
      root: ws.root, dryRun: false, mode: "prepare", yolo: false,
      actor: "alan", at: "2026-09-02T09:00:00Z",
    });
    expect(result.code).toBe(0);
    expect(result.lines.join("\n")).toContain(".tldrx/map/lab/architecture.md");
  });

  test("a stage whose every declared input resolves says nothing extra", async () => {
    const made = makeFacilitatorWorkspace({
      scope: "demo",
      budgetUsd: 10,
      stages: [{
        id: "what",
        phase: "01-what",
        budgetUsd: 4,
        optional: [".tldrx/map/{repo}/architecture.md"],
        outputs: [{ path: "01-what/handoff.md" }],
      }],
      files: {
        ".tldrx/map/api/architecture.md": "# api\n\n- A bullet [src: file:api/src/main.ts:1]\n",
        ".tldrx/map/lab/architecture.md": "# lab\n\n- A bullet [src: file:lab/src/main.ts:1]\n",
      },
    });
    facWorkspaces.push(made);
    const result = await runNext({
      root: made.root, dryRun: false, mode: "prepare", yolo: false,
      actor: "alan", at: "2026-09-02T09:00:00Z",
    });
    expect(result.code).toBe(0);
    const prompt = readFileSync(join(made.runDir, ".agent", "what", "prompt.md"), "utf8");
    expect(prompt).not.toContain("absent:");
    expect(result.lines.join("\n")).not.toContain("declared and not on disk");
  });
});
