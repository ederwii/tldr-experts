/**
 * The prompt path (stack packs design §4.5). Because every renderer prints an expert's
 * `body`, composing `body + overlays` inside `loadExpertBundles` is the one change that
 * reaches stage prompts and the Build developer. With the switch off, bytes are today's.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeBundles, loadExpertBundles } from "../src/core/experts/expertBundle.ts";
import { CHECKS_HEADING, DEFAULTS_HEADING, overlayMarker, OVERLAYS_DIRNAME } from "../src/core/experts/packSections.ts";
import { renderParts, buildPrompt } from "../src/core/facilitator/prompt.ts";
import { buildDeveloperPrompt } from "../src/core/build/prompts.ts";
import type { PlannedEpic, PlannedStory } from "../src/core/build/plan.ts";

let roots: string[] = [];
afterEach(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
  roots = [];
});

export interface PackRootOptions {
  readonly enabled: boolean | null;
  readonly overlays?: readonly string[];
  readonly skills?: readonly { name: string; description: string; tracked: boolean }[];
}

/** A workspace with one `lab` repo, one `typescript-stack` expert, and whatever the test asks for. */
export function packRoot(options: PackRootOptions): string {
  const root = mkdtempSync(join(tmpdir(), "tldrx-packs-prompt-"));
  roots.push(root);
  const expert = join(root, ".tldrx", "experts", "typescript-stack");
  mkdirSync(join(root, ".tldrx", "conventions"), { recursive: true });
  mkdirSync(expert, { recursive: true });
  const skills = (options.skills ?? []).map((skill) =>
    `      - {name: ${skill.name}, description: "${skill.description}", path: .claude/skills/${skill.name}/SKILL.md, tracked: ${String(skill.tracked)}}`);
  writeFileSync(join(root, ".tldrx", "workspace.yml"), [
    "version: 1", "mode: single-repo", "root_is_repo: true", "root: .", "repos:",
    "  - name: lab", "    path: .", "    default_branch: main", "    stack: [typescript]",
    "    package_manager: npm", "    commands: {build: null, test: null, lint: null, typecheck: null, run: null}",
    "    ci: []",
    `    overlays: [${(options.overlays ?? []).map((id) => `{id: ${id}, evidence: "package.json: dependencies.${id}"}`).join(", ")}]`,
    skills.length === 0 ? "    skills: []" : `    skills:\n${skills.join("\n")}`,
    "    confidence: high",
    ...(options.enabled === null ? [] : ["stack_packs:", `  enabled: ${String(options.enabled)}`, "  enabled_at: 2026-09-05T10:00:00Z"]),
    "",
  ].join("\n"), "utf8");
  writeFileSync(join(expert, "expert.md"), [
    "---", "name: typescript-stack", "kind: stack", "status: created", "repos: [lab]", "---", "",
    "# TypeScript", "", "Scope.", "", `## ${DEFAULTS_HEADING}`, "", "- Strict on. — overridden by: tsconfig.json", "",
    `## ${CHECKS_HEADING}`, "", "- Any new `any`? verify: grep `: any`", "",
  ].join("\n"), "utf8");
  writeFileSync(join(expert, "competencies.yml"), "version: 1\nexpert: typescript-stack\nstatus: created\nareas: []\n", "utf8");
  for (const id of options.overlays ?? []) {
    mkdirSync(join(expert, OVERLAYS_DIRNAME), { recursive: true });
    writeFileSync(join(expert, OVERLAYS_DIRNAME, `${id}.md`), [
      `# ${id}`, "", "Scope.", "", `## ${DEFAULTS_HEADING}`, "", `- ${id} default — overridden by: x`, "",
      `## ${CHECKS_HEADING}`, "", `- ${id} check? verify: y`, "",
    ].join("\n"), "utf8");
  }
  return root;
}

function bundlesOf(root: string) {
  return loadExpertBundles({ root, staged: [], repos: ["lab"], stackExperts: true, stackNames: ["typescript-stack"] });
}

const EPIC: PlannedEpic = {
  epic: { version: 1, id: "E1", title: "Tenancy", repos: ["lab"], stories: ["S5"], branch: "epic/tenancy", status: "todo" },
  text: "# E1\n", path: "/nowhere/E1.md", rel: "03-plan/epics/E1.md",
};
const STORY: PlannedStory = {
  story: {
    version: 1, id: "S5", epic: "E1", title: "OTP confirm", repo: "lab", status: "todo", depends_on: [], touches: [],
    acceptance: ["it confirms"], test_plan: ["$ npm test -> exit 0"], evidence: [],
  },
  dod: { present: true, commands: ["npm test"] },
  text: "# S5\n", path: "/nowhere/S5.md", rel: "03-plan/stories/S5.md", wave: "W1", goal: [],
};

export function devPrompt(experts: readonly { name: string; body: string }[], extra: Record<string, unknown> = {}): string {
  return buildDeveloperPrompt({
    runId: "260905-x", story: STORY, epic: EPIC, repoName: "lab", branch: "story/x/S5", epicBranch: "epic/tenancy",
    worktree: "/nowhere", commands: ["npm test"], conventions: "_none_", facts: "_none_", experts, budgetUsd: 4, ...extra,
  });
}

describe("loadExpertBundles with the switch on", () => {
  test("a stack expert's body carries its overlays, sorted, under markers", () => {
    const root = packRoot({ enabled: true, overlays: ["react", "prisma"] });
    const set = bundlesOf(root);
    const body = set.experts[0]?.body ?? "";
    expect(set.experts[0]?.overlays).toEqual(["prisma", "react"]);
    expect(body.indexOf(overlayMarker("prisma"))).toBeGreaterThan(body.indexOf(`## ${CHECKS_HEADING}`));
    expect(body.indexOf(overlayMarker("prisma"))).toBeLessThan(body.indexOf(overlayMarker("react")));
    expect(body).toContain("- react check? verify: y");
    expect(describeBundles(set).join("\n")).toContain("overlays: prisma, react");
  });

  test("the stage prompt and the developer prompt both contain the overlay — no renderer changed", () => {
    const root = packRoot({ enabled: true, overlays: ["react"] });
    const experts = bundlesOf(root).experts;
    const stage = buildPrompt({
      stageMd: "# stage\n\n## Inputs\n\n(x)\n", values: { run: "r", repos: "lab", inputs: "-", facts: "-", conventions: "-", budget_usd: "1.00" },
      experts, inputs: [],
    });
    expect(stage).toContain(overlayMarker("react"));
    expect(renderParts({ stageMd: "# s\n", values: { run: "r", repos: "lab", inputs: "-", facts: "-", conventions: "-", budget_usd: "1.00" }, experts, inputs: [] })
      .find((part) => part.kind === "expert-body")?.text).toContain(overlayMarker("react"));
    expect(devPrompt(experts)).toContain(overlayMarker("react"));
  });
});

describe("loadExpertBundles with the switch off or absent", () => {
  test("overlay files on disk are NOT inlined — bodies render as today", () => {
    for (const enabled of [false, null]) {
      const root = packRoot({ enabled, overlays: ["react"] });
      const set = bundlesOf(root);
      expect(set.experts[0]?.body).not.toContain(overlayMarker("react"));
      expect(set.experts[0]?.overlays).toEqual([]);
      expect(describeBundles(set).join("\n")).not.toContain("overlays:");
    }
  });
});
