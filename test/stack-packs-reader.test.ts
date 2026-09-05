/**
 * `readStackPacks` — the leaf every prompt path reads for the stack-packs switch and the
 * per-repo overlays/skills `workspace.yml` carries (stack packs design §4.3). Pure
 * filesystem + YAML: no git, no subprocess, so none of this spawns.
 *
 * Found in review (#task-3 round 1): nothing exercised this reader directly, so its
 * tolerance branches (missing file, bad YAML, a malformed `stack_packs`/`repos[]` shape)
 * and the `RepoPacks` surface (`stack`, `overlays`, `skills`) had no assertion at all.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NO_STACK_PACKS, readStackPacks } from "../src/core/experts/index.ts";

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

/** A fresh `.tldrx/` root; `workspace.yml` is written only when `yaml` is given. */
function root(yaml?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "tldrx-stackpacks-"));
  dirs.push(dir);
  if (yaml !== undefined) {
    mkdirSync(join(dir, ".tldrx"), { recursive: true });
    writeFileSync(join(dir, ".tldrx", "workspace.yml"), yaml, "utf8");
  }
  return dir;
}

describe("readStackPacks: absence and malformed input never throw, and never claim enabled", () => {
  test("no workspace.yml at all: disabled, not present, no repos", () => {
    expect(readStackPacks(root())).toEqual(NO_STACK_PACKS);
  });

  test("workspace.yml exists but fails to parse: same as absent, and it does not throw", () => {
    const dir = root("version: 1\nrepos: [\n  - name: a\n");
    expect(() => readStackPacks(dir)).not.toThrow();
    expect(readStackPacks(dir)).toEqual(NO_STACK_PACKS);
  });

  test("`stack_packs` is a scalar, not a mapping: not present, not enabled", () => {
    const dir = root("version: 1\nmode: single\nroot: .\nrepos: []\nstack_packs: \"on\"\n");
    const state = readStackPacks(dir);
    expect(state.present).toBe(false);
    expect(state.enabled).toBe(false);
    expect(state.enabledAt).toBeNull();
    expect(state.repos).toEqual([]);
  });

  test("`stack_packs.enabled` is a string, not a boolean: present, but read as OFF", () => {
    const dir = root(
      "version: 1\nmode: single\nroot: .\nrepos: []\nstack_packs:\n  enabled: \"yes\"\n  enabled_at: null\n",
    );
    const state = readStackPacks(dir);
    expect(state.present).toBe(true);
    expect(state.enabled).toBe(false);
    expect(state.enabledAt).toBeNull();
  });

  test("an old-format file whose repos never had overlays/skills: both come back [], not undefined", () => {
    const dir = root([
      "version: 1",
      "mode: single-repo",
      "root: .",
      "repos:",
      "  - name: lab",
      "    path: .",
      "    stack: [typescript]",
      "",
    ].join("\n"));
    const state = readStackPacks(dir);
    expect(state.present).toBe(false);
    expect(state.repos).toEqual([{ name: "lab", stack: ["typescript"], overlays: [], skills: [] }]);
    // Not just "falsy" — an old caller iterating `.overlays` on `undefined` would throw;
    // pin the actual empty array, since `toEqual([])` and `toEqual(undefined)` both read
    // as "nothing" to a careless assertion but are very different values to iterate.
    expect(Array.isArray(state.repos[0]?.overlays)).toBe(true);
    expect(Array.isArray(state.repos[0]?.skills)).toBe(true);
  });
});

describe("readStackPacks: a full file round-trips enabled state and every per-repo field", () => {
  test("enabled + enabled_at, and overlays/skills with their fields intact", () => {
    const dir = root([
      "version: 1",
      "mode: multi-repo",
      "root: .",
      "repos:",
      "  - name: lab",
      "    path: lab",
      "    stack: [typescript, react]",
      "    overlays:",
      "      - id: react",
      "        evidence: \"package.json: dependencies.react\"",
      "    skills:",
      "      - name: deploy-checklist",
      "        description: Pre-deploy checks",
      "        path: .claude/skills/deploy-checklist/SKILL.md",
      "        tracked: true",
      "  - name: api-service",
      "    path: api-service",
      "    stack: [dotnet]",
      "    overlays: []",
      "    skills: []",
      "stack_packs:",
      "  enabled: true",
      "  enabled_at: \"2026-09-05T10:00:00Z\"",
      "",
    ].join("\n"));

    const state = readStackPacks(dir);
    expect(state.present).toBe(true);
    expect(state.enabled).toBe(true);
    expect(state.enabledAt).toBe("2026-09-05T10:00:00Z");
    expect(state.repos).toEqual([
      {
        name: "lab",
        stack: ["typescript", "react"],
        overlays: [{ id: "react", evidence: "package.json: dependencies.react" }],
        skills: [{
          name: "deploy-checklist", description: "Pre-deploy checks",
          path: ".claude/skills/deploy-checklist/SKILL.md", tracked: true,
        }],
      },
      { name: "api-service", stack: ["dotnet"], overlays: [], skills: [] },
    ]);
  });

  test("`enabled: false` with a null `enabled_at` round-trips both, present stays true", () => {
    const dir = root("version: 1\nmode: single\nroot: .\nrepos: []\nstack_packs:\n  enabled: false\n  enabled_at: null\n");
    const state = readStackPacks(dir);
    expect(state.present).toBe(true);
    expect(state.enabled).toBe(false);
    expect(state.enabledAt).toBeNull();
  });
});
