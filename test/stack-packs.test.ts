/**
 * The materialisation rules (stack packs design §4.2, §4.6): the pack body replaces a
 * stub and ONLY a stub, overlays are framework-managed files rewritten on every enable
 * and re-init, disable removes overlays and nothing else, and the switch survives
 * `tldrx init`. Real fixtures, real detection: the rules read manifests and git.
 *
 * The body's OWN bytes are named in its front matter (`pack_body:`) beside the shipment
 * that produced them (`pack:`), so the three questions stay separate and none of them is
 * answered by guessing: did a human edit this body (sha differs), is it from an older
 * shipment (sha matches, hash differs — upgradeable), or is it current. Comparing a body
 * against the CURRENT template alone cannot tell "edited" from "one release behind", which
 * would make every pack un-upgradeable the moment a template changed.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { SpawnCommandRunner } from "../src/core/detect/index.ts";
import { rfc3339, runInit, type InitOptions } from "../src/core/init/index.ts";
import {
  bodyState, disableStackPacks, enableStackPacks, stackPacksStatus, stubBodyFor,
} from "../src/core/init/stackPacks.ts";
import { readStackPacks } from "../src/core/experts/stackPacks.ts";
import { hashText, readOverlayTemplate, readPackBody, templatesHash } from "../src/core/experts/packTemplates.ts";
import { OVERLAYS_DIRNAME } from "../src/core/experts/packSections.ts";
import { splitFrontMatter } from "../src/core/experts/expertDocument.ts";
import { parseList } from "../src/core/experts/expertDomain.ts";
import { parseYaml, stringifyYaml } from "../src/core/yaml.ts";
import { startSteps, type StepReporter } from "../src/core/ui/steps.ts";
import { stripAnsi } from "../src/core/ui/color.ts";
import { greenfieldFixture, multiRepoFixture, singleRepoFixture, type Fixture } from "./init-fixture.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

// The fixtures `git init` and detection runs `git`; the budget scales with measured load (#43).
setDefaultTimeout(spawnTestTimeout());

const runner = new SpawnCommandRunner();
const NOW = new Date("2026-09-05T10:00:00Z");
const AT = rfc3339(NOW);
/** A frozen clock, so no step ever prints a duration into what these tests read. */
const FROZEN = (): number => 1_757_066_400_000;

function options(root: string): InitOptions {
  // `probe: false`: the fixture's scripts are real, and this file is not testing them.
  return {
    root, out: root, interview: false, methodology: null, mcp: false, stack: [], provider: "static",
    probe: false,
  };
}
async function init(root: string, steps?: StepReporter): Promise<void> {
  await runInit(options(root), { runner, cliVersion: "0.0.1", now: NOW, ...(steps === undefined ? {} : { steps }) });
}
function yaml(path: string): Record<string, unknown> {
  return parseYaml(readFileSync(path, "utf8")) as Record<string, unknown>;
}
function expertPath(root: string, name: string): string {
  return join(root, ".tldrx", "experts", name, "expert.md");
}
function overlayPath(root: string, name: string, id: string): string {
  return join(root, ".tldrx", "experts", name, OVERLAYS_DIRNAME, `${id}.md`);
}

/** Captures what the step view writes, the way `init-progress.test.ts` does. */
function recorder(): { readonly text: () => string; readonly steps: StepReporter } {
  const chunks: string[] = [];
  return {
    text: (): string => stripAnsi(chunks.join("")),
    steps: startSteps({
      root: "/work/fixture", isTty: false, cols: 100, rows: 40, env: {},
      write: (text: string): void => { chunks.push(text); },
      now: FROZEN, schedule: (): null => null,
    }),
  };
}

describe("single repo: enable → status → disable", () => {
  let fixture: Fixture;
  beforeAll(async () => { fixture = await singleRepoFixture(); await init(fixture.root); });
  afterAll(async () => { await fixture.cleanup(); });

  test("the seeded stack body IS what stubBodyFor derives — one derivation, via renderExpert", () => {
    const text = readFileSync(expertPath(fixture.root, "typescript-stack"), "utf8");
    const { frontMatter, body } = splitFrontMatter(text);
    expect(body).toBe(stubBodyFor("typescript-stack", parseList(frontMatter.get("repos") ?? "")));
    expect(bodyState(text, "typescript")).toEqual({ kind: "stub" });
  });

  test("status before enable: disabled, overlays detected, body stub", async () => {
    const outcome = await stackPacksStatus({ workspaceDir: fixture.root });
    expect(outcome.ok).toBe(true);
    const text = outcome.lines.join("\n");
    expect(text).toContain("stack packs: disabled");
    expect(text).toContain("react (package.json: dependencies.react)");
    expect(text).toContain("typescript-stack: body stub, overlays: none");
  });

  test("enable applies the pack body to the untouched stub, writes overlays, records the switch", async () => {
    const outcome = await enableStackPacks({ workspaceDir: fixture.root, runner, now: AT });
    expect(outcome.ok).toBe(true);
    const text = outcome.lines.join("\n");
    const hash = templatesHash();
    expect(text).toContain(`stack packs: enabled (${AT})`);
    expect(text).toContain(`typescript-stack: pack applied (pack@${hash})`);
    expect(text).toContain("typescript-stack: overlays written: react, vite-react-spa");

    const expert = readFileSync(expertPath(fixture.root, "typescript-stack"), "utf8");
    const { frontMatter, body } = splitFrontMatter(expert);
    expect(frontMatter.get("name")).toBe("typescript-stack");
    expect(frontMatter.get("kind")).toBe("stack");
    expect(frontMatter.get("pack")).toBe(`typescript@${hash}`);
    // The body names its own bytes, so "edited" and "one shipment behind" stay tellable apart.
    expect(frontMatter.get("pack_body")).toBe(hashText(body));
    expect(bodyState(expert, "typescript")).toEqual({ kind: "pack", hash });
    expect(body).toBe(`\n${readPackBody("typescript") ?? "MISSING"}`);

    expect(readFileSync(overlayPath(fixture.root, "typescript-stack", "react"), "utf8")).toBe(readOverlayTemplate("react") ?? "MISSING");
    expect(existsSync(overlayPath(fixture.root, "typescript-stack", "vite-react-spa"))).toBe(true);

    const doc = yaml(join(fixture.root, ".tldrx", "workspace.yml"));
    expect(doc.stack_packs).toEqual({ enabled: true, enabled_at: AT });
    const repos = doc.repos as Record<string, unknown>[];
    expect(repos[0]?.overlays).toEqual([
      { id: "react", evidence: "package.json: dependencies.react" },
      { id: "vite-react-spa", evidence: "package.json: devDependencies.vite + dependencies.react" },
    ]);
    expect(readStackPacks(fixture.root).enabled).toBe(true);
  });

  test("a second enable is idempotent on the body and REWRITES the overlays folder", async () => {
    rmSync(overlayPath(fixture.root, "typescript-stack", "react"));
    writeFileSync(overlayPath(fixture.root, "typescript-stack", "stale"), "# stale\n", "utf8");
    const before = readFileSync(expertPath(fixture.root, "typescript-stack"), "utf8");
    const outcome = await enableStackPacks({ workspaceDir: fixture.root, runner, now: AT });
    expect(outcome.lines.join("\n")).toContain(`typescript-stack: pack already at pack@${templatesHash()}`);
    expect(readFileSync(expertPath(fixture.root, "typescript-stack"), "utf8")).toBe(before);
    expect(existsSync(overlayPath(fixture.root, "typescript-stack", "react"))).toBe(true);
    expect(existsSync(overlayPath(fixture.root, "typescript-stack", "stale"))).toBe(false);
  });

  test("a body from an older shipment is STALE, and enable UPGRADES it instead of calling it edited", async () => {
    const path = expertPath(fixture.root, "typescript-stack");
    const hash = templatesHash();
    const current = readFileSync(path, "utf8");
    expect(bodyState(current, "typescript")).toEqual({ kind: "pack", hash });

    // Only the shipment hash moves; not one byte of the body changes. This is exactly what
    // a template edit looks like to an `expert.md` nobody has touched — and before
    // `pack_body:` existed it read as `edited`, so packs could never upgrade.
    const older = current.replace(`pack: typescript@${hash}`, "pack: typescript@000000000000");
    expect(older).not.toBe(current);
    writeFileSync(path, older, "utf8");
    expect(bodyState(older, "typescript")).toEqual({ kind: "stale", was: "000000000000", hash });

    const status = await stackPacksStatus({ workspaceDir: fixture.root });
    expect(status.lines.join("\n"))
      .toContain(`typescript-stack: body pack@000000000000 (stale — shipment is pack@${hash})`);

    const outcome = await enableStackPacks({ workspaceDir: fixture.root, runner, now: AT });
    expect(outcome.lines.join("\n")).toContain(`upgraded: typescript-stack pack@000000000000 → pack@${hash}`);
    // Upgraded back to exactly the shipment — bytes, not just the label.
    expect(readFileSync(path, "utf8")).toBe(current);
  });

  test("an edited body is KEPT and said so; an emptied body is re-seeded", async () => {
    const path = expertPath(fixture.root, "typescript-stack");
    const edited = `${readFileSync(path, "utf8")}\n- our own rule\n`;
    writeFileSync(path, edited, "utf8");
    const kept = await enableStackPacks({ workspaceDir: fixture.root, runner, now: AT });
    expect(kept.lines).toContain("  kept: typescript-stack body was edited — pack body not applied (delete the body to re-seed)");
    expect(readFileSync(path, "utf8")).toBe(edited);
    const status = await stackPacksStatus({ workspaceDir: fixture.root });
    expect(status.lines.join("\n")).toContain(`typescript-stack: body edited (was pack@${templatesHash()})`);

    const { body } = splitFrontMatter(edited);
    writeFileSync(path, edited.slice(0, edited.length - body.length), "utf8");
    const reseeded = await enableStackPacks({ workspaceDir: fixture.root, runner, now: AT });
    expect(reseeded.lines.join("\n")).toContain("typescript-stack: pack applied");
    expect(splitFrontMatter(readFileSync(path, "utf8")).body).toBe(`\n${readPackBody("typescript") ?? "MISSING"}`);
  });

  test("disable removes overlays only and clears the switch", async () => {
    const competencies = join(fixture.root, ".tldrx", "experts", "typescript-stack", "competencies.yml");
    const competenciesBefore = readFileSync(competencies, "utf8");
    const bodyBefore = readFileSync(expertPath(fixture.root, "typescript-stack"), "utf8");
    const outcome = await disableStackPacks({ workspaceDir: fixture.root });
    expect(outcome.ok).toBe(true);
    // A body already applied by `enable` is NOT rolled back — only `overlays/` and the
    // switch go away — so the line says so rather than letting "untouched" alone read as
    // "disable takes it all back" (fix round 2, ruled).
    expect(outcome.lines.join("\n")).toContain(
      "bodies and knowledge/ untouched (a pack body already applied stays in expert.md — delete it, then `enable`, to remove it)");
    expect(existsSync(join(fixture.root, ".tldrx", "experts", "typescript-stack", OVERLAYS_DIRNAME))).toBe(false);
    expect(readFileSync(expertPath(fixture.root, "typescript-stack"), "utf8")).toBe(bodyBefore);
    expect(readFileSync(competencies, "utf8")).toBe(competenciesBefore);
    expect(yaml(join(fixture.root, ".tldrx", "workspace.yml")).stack_packs).toEqual({ enabled: false, enabled_at: null });
  });

  test("re-init with the switch on re-materialises the overlays and keeps the switch", async () => {
    await enableStackPacks({ workspaceDir: fixture.root, runner, now: AT });
    rmSync(join(fixture.root, ".tldrx", "experts", "typescript-stack", OVERLAYS_DIRNAME), { recursive: true, force: true });
    await init(fixture.root);
    expect(existsSync(overlayPath(fixture.root, "typescript-stack", "react"))).toBe(true);
    expect(yaml(join(fixture.root, ".tldrx", "workspace.yml")).stack_packs).toEqual({ enabled: true, enabled_at: AT });
  });
});

describe("multi-repo: overlays land under the language expert they belong to", () => {
  let fixture: Fixture;
  beforeAll(async () => { fixture = await multiRepoFixture(); await init(fixture.root); });
  afterAll(async () => { await fixture.cleanup(); });

  test("a .NET overlay goes under dotnet-stack, never under typescript-stack", async () => {
    const outcome = await enableStackPacks({ workspaceDir: fixture.root, runner, now: AT });
    expect(outcome.ok).toBe(true);
    expect(outcome.lines.join("\n")).toContain("dotnet-stack: pack applied");
    expect(existsSync(overlayPath(fixture.root, "dotnet-stack", "aspnet-minimal-apis"))).toBe(true);
    expect(existsSync(overlayPath(fixture.root, "typescript-stack", "react"))).toBe(true);
    expect(existsSync(overlayPath(fixture.root, "typescript-stack", "aspnet-minimal-apis"))).toBe(false);
    expect(existsSync(overlayPath(fixture.root, "dotnet-stack", "react"))).toBe(false);
  });
});

describe("a hand-edited workspace.yml is refused BY NAME, never with a TypeError", () => {
  /**
   * `enableStackPacks` is the only caller that hands `validateWorkspaceDocument` a parsed
   * FILE rather than a `buildWorkspaceDocument` result, and that validator dereferences
   * `doc.repos.forEach`, `repo.path.includes` and `Object.entries(repo.commands)` without
   * checking any of them. Reaching it with a hand-edited file is this module's exposure,
   * so the refusal is this module's job — and it has to happen before anything is written.
   */
  let fixture: Fixture;
  beforeAll(async () => { fixture = await singleRepoFixture(); await init(fixture.root); });
  afterAll(async () => { await fixture.cleanup(); });

  function workspacePath(): string {
    return join(fixture.root, ".tldrx", "workspace.yml");
  }
  function rewrite(mutate: (doc: Record<string, unknown>) => void): void {
    const doc = yaml(workspacePath());
    mutate(doc);
    writeFileSync(workspacePath(), stringifyYaml(doc), "utf8");
  }

  test("a repo row with no `commands:` — the key that used to throw — is a named refusal", async () => {
    rewrite((doc) => {
      const first = (doc.repos as Record<string, unknown>[])[0];
      if (first !== undefined) delete first.commands;
    });
    const outcome = await enableStackPacks({ workspaceDir: fixture.root, runner, now: AT });
    expect(outcome.ok).toBe(false);
    const text = outcome.lines.join("\n");
    expect(text).toContain(".tldrx/workspace.yml");
    expect(text).toContain("has no `commands:` mapping");
    expect(yaml(workspacePath()).stack_packs).toBeUndefined();
  });

  test("a repo row with no `path:` is named too, and nothing is written", async () => {
    rewrite((doc) => {
      const first = (doc.repos as Record<string, unknown>[])[0];
      if (first !== undefined) { first.commands = { build: null }; delete first.path; }
    });
    const outcome = await enableStackPacks({ workspaceDir: fixture.root, runner, now: AT });
    expect(outcome.ok).toBe(false);
    expect(outcome.lines.join("\n")).toContain("has no `path:`");
    expect(yaml(workspacePath()).stack_packs).toBeUndefined();
  });

  test("`repos:` that is not a list at all", async () => {
    rewrite((doc) => { doc.repos = "lab"; });
    const outcome = await enableStackPacks({ workspaceDir: fixture.root, runner, now: AT });
    expect(outcome.ok).toBe(false);
    expect(outcome.lines.join("\n")).toContain("`repos:` is missing or is not a list");
    expect(yaml(workspacePath()).stack_packs).toBeUndefined();
  });
});

describe("re-init SAYS what it did not do", () => {
  let fixture: Fixture;
  beforeAll(async () => {
    fixture = await singleRepoFixture();
    await init(fixture.root);
    await enableStackPacks({ workspaceDir: fixture.root, runner, now: AT });
  });
  afterAll(async () => { await fixture.cleanup(); });

  test("a re-init over an edited pack body NAMES the expert it kept", async () => {
    const path = expertPath(fixture.root, "typescript-stack");
    writeFileSync(path, `${readFileSync(path, "utf8")}\n- our own rule\n`, "utf8");
    const out = recorder();
    await init(fixture.root, out.steps);
    out.steps.stop();
    const text = out.text();
    expect(text).toContain("kept:");
    expect(text).toContain("typescript-stack");
    // The counts are still there — the names are added to the line, not swapped for it.
    expect(text).toContain("2 overlays written");
  });
});

describe("greenfield: nothing to enable", () => {
  let fixture: Fixture;
  beforeAll(async () => { fixture = await greenfieldFixture(); await init(fixture.root); });
  afterAll(async () => { await fixture.cleanup(); });

  test("enable refuses (usage family) and leaves workspace.yml without a switch", async () => {
    const outcome = await enableStackPacks({ workspaceDir: fixture.root, runner, now: AT });
    expect(outcome.ok).toBe(false);
    expect(outcome.lines.join("\n")).toContain("no detectable language");
    expect(yaml(join(fixture.root, ".tldrx", "workspace.yml")).stack_packs).toBeUndefined();
  });

  test("enable on a directory with no workspace.yml names `tldrx init`", async () => {
    const empty = join(fixture.root, "elsewhere");
    mkdirSync(empty, { recursive: true });
    await expect(enableStackPacks({ workspaceDir: empty, runner, now: AT })).rejects.toThrow("run `tldrx init` first");
  });
});
