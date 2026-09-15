/**
 * `tldrx seed check <file|dir>` — the read-only seed validator (#291).
 *
 * The rules it enforces are the ones four unattended runs paid to learn: a seed
 * that passes them finished alone, a seed that broke one needed a person. Each
 * rule below has a fixture that breaks ONLY it, so a finding names the rule and
 * nothing else — a validator that reports three things for one mistake sends
 * the author fixing the wrong one.
 *
 * The importer half is not reimplemented here and not asserted twice: the check
 * CALLS the same `collectSeeds` → `seedClaims` → `renderSeedHandoff` →
 * `validateHandoff` chain `run new --seed` runs, and one test pins that a seed
 * the importer refuses is a finding here too.
 *
 * The CLI tests spawn the real binary (exit codes are the contract), so this file
 * takes the load-aware timeout and earns a `machine-load.test.ts` row.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FRAMEWORK_ROOT, PROJECT_WORK_DIR } from "../src/core/paths.ts";
import { EXIT_NOT_FOUND, EXIT_OK, EXIT_USAGE } from "../src/cli/exitCodes.ts";
import { checkSeed, renderSeedCheck, MAX_SEED_BULLET_CHARS, MAX_STORIES_PER_SEED, MAX_WAVES_PER_SEED } from "../src/core/seed/checkSeed.ts";
import { makeWorkspace, type TempWorkspace } from "./fixtures/tempWorkspace.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

// Every CLI test in this file spawns a REAL process — `bun`, the CLI. Process cost is a
// property of the machine, not of the code, so bun's fixed 5000 ms default measures the box.
setDefaultTimeout(spawnTestTimeout());

const BIN = join(FRAMEWORK_ROOT, "bin", "tldrx.ts");

const open: TempWorkspace[] = [];
afterEach(() => {
  while (open.length > 0) open.pop()?.dispose();
});

function workspace(): TempWorkspace {
  const ws = makeWorkspace();
  open.push(ws);
  return ws;
}

/** Write a seed under the conventional `.tldrx/seeds/` and return its workspace-relative path. */
function writeSeed(ws: TempWorkspace, name: string, text: string): string {
  const rel = `.tldrx/seeds/${name}`;
  mkdirSync(join(ws.root, ".tldrx", "seeds"), { recursive: true });
  writeFileSync(join(ws.root, rel), text, "utf8");
  return rel;
}

/**
 * A seed that passes every rule against the fixture workspace: `lab` declares
 * `npm run test`, `api` declares `dotnet test`; `lab/src/rank.ts` has 4 lines and
 * `api/src/Hunt.cs` has 12. S2 depends on S1 and the two touch different files.
 */
const GOOD_SEED = [
  "# Intent",
  "- Ranking must break ties by name so the leaderboard is stable [src: lab/src/rank.ts:2]",
  "",
  "# Scope",
  "- Only the rank function and the hunt payload; nothing else moves [src: lab/src/rank.ts:2; api/src/Hunt.cs:3]",
  "",
  "# Success metrics",
  "- The rank test passes with two equal scores in name order [src: lab/src/rank.ts:2]",
  "",
  "# Open questions",
  "- Ascending or descending names on a tie? A) ascending B) descending. Recommended: A — matches the existing sort [src: lab/src/rank.ts:2]",
  "",
  "# Stories",
  "",
  "## S1 — Break ties by name",
  "- touches: lab/src/rank.ts",
  "- depends_on: none",
  "- Acceptance: equal scores come out in ascending name order [src: lab/src/rank.ts:2]",
  "",
  "```dod",
  "npm run test",
  "```",
  "",
  "## S2 — Name the tie rule in the hunt payload",
  "- touches: api/src/Hunt.cs",
  "- depends_on: S1",
  "- Acceptance: the hunt payload carries the tie rule [src: api/src/Hunt.cs:3]",
  "",
  "```dod",
  "dotnet test",
  "```",
  "",
].join("\n");

/** `GOOD_SEED` with one line replaced, so a variant breaks exactly one rule. */
function variant(from: string, to: string): string {
  if (!GOOD_SEED.includes(from)) throw new Error(`variant: GOOD_SEED does not contain ${from}`);
  return GOOD_SEED.replace(from, to);
}

function rulesOf(report: ReturnType<typeof checkSeed>): string[] {
  return report.findings.map((f) => f.rule);
}

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function tldrx(cwd: string, args: readonly string[]): Promise<Run> {
  const proc = Bun.spawn(["bun", BIN, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

describe("a seed that follows every rule is clean", () => {
  test("no findings, no advisories, the stories and their dod lines counted", () => {
    const ws = workspace();
    const rel = writeSeed(ws, "01-good.md", GOOD_SEED);
    const report = checkSeed(ws.root, rel);
    expect(report.findings).toEqual([]);
    expect(report.advisories).toEqual([]);
    expect(report.stories.map((s) => s.id)).toEqual(["S1", "S2"]);
    expect(report.stories.map((s) => s.dod)).toEqual([["npm run test"], ["dotnet test"]]);
    expect(report.openQuestions).toBe(1);
    expect(report.ok).toBe(true);
  });
});

describe("one fixture per rule, each breaking only that rule", () => {
  test("a bullet over the cap — bullet-length, naming the cap and the seed line", () => {
    const ws = workspace();
    const long = `- ${"Ranking must break ties by name ".repeat(8).trim()} [src: lab/src/rank.ts:2]`;
    expect(long.length).toBeGreaterThan(MAX_SEED_BULLET_CHARS);
    const rel = writeSeed(ws, "02.md", variant(
      "- Ranking must break ties by name so the leaderboard is stable [src: lab/src/rank.ts:2]", long,
    ));
    const report = checkSeed(ws.root, rel);
    expect(rulesOf(report)).toEqual(["bullet-length"]);
    expect(report.findings[0]?.line).toBe(2);
    expect(report.findings[0]?.text).toContain(String(MAX_SEED_BULLET_CHARS));
  });

  test("a citation that is not the last thing on its line — src-grammar, in the grammar's own words", () => {
    const ws = workspace();
    const rel = writeSeed(ws, "03.md", variant(
      "- The rank test passes with two equal scores in name order [src: lab/src/rank.ts:2]",
      "- The rank test passes [src: lab/src/rank.ts:2] with two equal scores in name order",
    ));
    const report = checkSeed(ws.root, rel);
    expect(rulesOf(report)).toEqual(["src-grammar"]);
    expect(report.findings[0]?.line).toBe(8);
    expect(report.findings[0]?.text).toContain("trailing-position");
  });

  test("an unterminated `[src:` — src-grammar at the seed line, AND the importer's own refusal (#275's fold)", () => {
    const ws = workspace();
    const rel = writeSeed(ws, "04.md", variant(
      "- The rank test passes with two equal scores in name order [src: lab/src/rank.ts:2]",
      "- The rank test passes with two equal scores in name order [src: lab/src/rank.ts:2",
    ));
    const report = checkSeed(ws.root, rel);
    expect(rulesOf(report)).toEqual(["src-grammar", "importer"]);
    expect(report.findings[0]?.line).toBe(8);
    expect(report.findings[1]?.text).toContain("run new --seed would refuse this");
    expect(report.findings[1]?.text).toContain("unterminated");
  });

  test("a cited line past the end of the file, and a path that does not exist — src-resolve", () => {
    const ws = workspace();
    const rel = writeSeed(ws, "05.md", variant(
      "- The rank test passes with two equal scores in name order [src: lab/src/rank.ts:2]",
      "- The rank test passes with two equal scores in name order [src: lab/src/rank.ts:99; lab/src/none.ts:1]",
    ));
    const report = checkSeed(ws.root, rel);
    // Measured: the importer ACCEPTS this seed — the renderer appends its own
    // seed-line token after the inline one, and a closed citation quoted
    // mid-line is not validated. So the run would be created, and the handoff
    // would carry a citation a reviewer follows to nothing: an authoring rule,
    // caught only here.
    expect(rulesOf(report)).toEqual(["src-resolve", "src-resolve"]);
    expect(report.findings[0]?.text).toContain("lab/src/rank.ts has 4 line(s); cited line 99");
    expect(report.findings[1]?.text).toContain("lab/src/none.ts");
    expect(report.findings.every((f) => f.line === 8)).toBe(true);
  });

  test("a dod line that is not a workspace command byte-for-byte — dod-command, naming the declared ones", () => {
    const ws = workspace();
    const rel = writeSeed(ws, "06.md", variant("npm run test\n```", "npm test\n```"));
    const report = checkSeed(ws.root, rel);
    expect(rulesOf(report)).toEqual(["dod-command"]);
    expect(report.findings[0]?.line).toBe(21);
    expect(report.findings[0]?.text).toContain("npm test");
  });

  test("a dod line that chains two commands — dod-separator names the operator, not the allowlist", () => {
    const ws = workspace();
    const rel = writeSeed(ws, "07.md", variant("npm run test\n```", "npm run test && npm run lint\n```"));
    const report = checkSeed(ws.root, rel);
    expect(rulesOf(report)).toEqual(["dod-separator"]);
    expect(report.findings[0]?.text).toContain("`&&`");
  });

  test("an open question with no Recommended: line — question-recommended", () => {
    const ws = workspace();
    const rel = writeSeed(ws, "08.md", variant(
      "- Ascending or descending names on a tie? A) ascending B) descending. Recommended: A — matches the existing sort [src: lab/src/rank.ts:2]",
      "- Ascending or descending names on a tie? A) ascending B) descending. [src: lab/src/rank.ts:2]",
    ));
    const report = checkSeed(ws.root, rel);
    expect(rulesOf(report)).toEqual(["question-recommended"]);
    expect(report.findings[0]?.line).toBe(11);
  });

  // #323: seed check tested the SUBSTRING `Recommended:` while the loop read the line
  // with its own grammar, so a seed could pass clean and park every unattended run.
  // The check now reads the line with the loop's own reader — one derivation.
  test("a letter and a citation with no reason is a readable recommendation — clean (#323)", () => {
    const ws = workspace();
    const rel = writeSeed(ws, "08b.md", variant(
      "Recommended: A — matches the existing sort [src: lab/src/rank.ts:2]",
      "Recommended: A [src: lab/src/rank.ts:2]",
    ));
    const report = checkSeed(ws.root, rel);
    expect(rulesOf(report)).toEqual([]);
  });

  test("a Recommended: line the loop cannot read — question-recommended-unreadable, with the shape it expects (#323)", () => {
    const ws = workspace();
    const rel = writeSeed(ws, "08c.md", variant(
      "Recommended: A — matches the existing sort [src: lab/src/rank.ts:2]",
      "Recommended: A because it matches the existing sort [src: lab/src/rank.ts:2]",
    ));
    const report = checkSeed(ws.root, rel);
    expect(rulesOf(report)).toEqual(["question-recommended-unreadable"]);
    expect(report.findings[0]?.line).toBe(11);
    expect(report.findings[0]?.text).toContain("Recommended: A because it matches the existing sort");
    expect(report.findings[0]?.text).toContain("Recommended: <letter>");
  });

  test("a Recommended: letter that names none of the question's options — question-recommended-option (#323)", () => {
    const ws = workspace();
    const rel = writeSeed(ws, "08d.md", variant(
      "Recommended: A — matches the existing sort",
      "Recommended: C — matches the existing sort",
    ));
    const report = checkSeed(ws.root, rel);
    expect(rulesOf(report)).toEqual(["question-recommended-option"]);
    expect(report.findings[0]?.text).toContain("A, B");
  });

  test("a story with no touches: line — story-touches, on the story heading", () => {
    const ws = workspace();
    const rel = writeSeed(ws, "09.md", variant("- touches: api/src/Hunt.cs\n", ""));
    const report = checkSeed(ws.root, rel);
    expect(rulesOf(report)).toEqual(["story-touches"]);
    expect(report.findings[0]?.line).toBe(24);
  });

  test("a story with no depends_on: line — story-depends", () => {
    const ws = workspace();
    const rel = writeSeed(ws, "10.md", variant("- depends_on: S1\n", ""));
    const report = checkSeed(ws.root, rel);
    expect(rulesOf(report)).toEqual(["story-depends"]);
  });

  test("a depends_on naming a story the seed does not declare — depends-unknown", () => {
    const ws = workspace();
    const rel = writeSeed(ws, "11.md", variant("- depends_on: S1\n", "- depends_on: S9\n"));
    const report = checkSeed(ws.root, rel);
    expect(rulesOf(report)).toEqual(["depends-unknown"]);
    expect(report.findings[0]?.text).toContain("S9");
  });

  test("a story with no ```dod fence — story-dod", () => {
    const ws = workspace();
    const rel = writeSeed(ws, "12.md", variant("```dod\ndotnet test\n```\n", ""));
    const report = checkSeed(ws.root, rel);
    expect(rulesOf(report)).toEqual(["story-dod"]);
    expect(report.findings[0]?.line).toBe(24);
  });

  test("two stories touching the same file with no dependency between them — wave-boundary (#286)", () => {
    const ws = workspace();
    const rel = writeSeed(ws, "13.md", variant("- touches: api/src/Hunt.cs\n- depends_on: S1\n", "- touches: lab/src/rank.ts\n- depends_on: none\n"));
    const report = checkSeed(ws.root, rel);
    expect(rulesOf(report)).toEqual(["wave-boundary"]);
    expect(report.findings[0]?.text).toContain("lab/src/rank.ts");
    expect(report.findings[0]?.text).toContain("#286");
  });

  test("the same two stories chained through depends_on are not a boundary finding", () => {
    const ws = workspace();
    const rel = writeSeed(ws, "14.md", variant("- touches: api/src/Hunt.cs\n- depends_on: S1\n", "- touches: lab/src/rank.ts\n- depends_on: S1\n"));
    expect(rulesOf(checkSeed(ws.root, rel))).toEqual([]);
  });
});

describe("advisories are printed, never refused", () => {
  function stories(n: number): string {
    const blocks: string[] = [];
    for (let i = 1; i <= n; i++) {
      blocks.push(
        `## S${i} — Story ${i}`,
        `- touches: lab/src/rank-${i}.ts`,
        "- depends_on: none",
        `- Acceptance: story ${i} does its one thing [src: lab/src/rank.ts:2]`,
        "",
        "```dod",
        "npm run test",
        "```",
        "",
      );
    }
    return blocks.join("\n");
  }
  const head = GOOD_SEED.slice(0, GOOD_SEED.indexOf("## S1"));

  test(`more than ${MAX_STORIES_PER_SEED} stories is an advisory naming the open issues, and the seed stays ok`, () => {
    const ws = workspace();
    const rel = writeSeed(ws, "15.md", head + stories(MAX_STORIES_PER_SEED + 1));
    const report = checkSeed(ws.root, rel);
    expect(report.findings).toEqual([]);
    expect(report.advisories.map((a) => a.rule)).toEqual(["size"]);
    expect(report.advisories[0]?.text).toContain("#286");
    expect(report.advisories[0]?.text).toContain("#244");
    expect(report.advisories[0]?.text).toContain("#280");
    expect(report.ok).toBe(true);
  });

  test(`a dependency chain deeper than ${MAX_WAVES_PER_SEED} waves is an advisory`, () => {
    const ws = workspace();
    const chained = stories(3)
      .replace("## S2 — Story 2\n- touches: lab/src/rank-2.ts\n- depends_on: none", "## S2 — Story 2\n- touches: lab/src/rank-2.ts\n- depends_on: S1")
      .replace("## S3 — Story 3\n- touches: lab/src/rank-3.ts\n- depends_on: none", "## S3 — Story 3\n- touches: lab/src/rank-3.ts\n- depends_on: S2");
    const rel = writeSeed(ws, "16.md", head + chained);
    const report = checkSeed(ws.root, rel);
    expect(report.findings).toEqual([]);
    expect(report.advisories.map((a) => a.rule)).toEqual(["waves"]);
    expect(report.waves).toBe(3);
  });

  test("a missing What heading is an advisory: the stage reports it as an Unknown, run new does not refuse it", () => {
    const ws = workspace();
    const rel = writeSeed(ws, "17.md", GOOD_SEED.replace("# Success metrics\n- The rank test passes with two equal scores in name order [src: lab/src/rank.ts:2]\n\n", ""));
    const report = checkSeed(ws.root, rel);
    expect(report.findings).toEqual([]);
    expect(report.advisories.map((a) => a.rule)).toEqual(["heading"]);
    expect(report.advisories[0]?.text).toContain("success-metrics");
  });
});

describe("the importer is a second instrument, not a copy of the first", () => {
  test("a seed the per-line pass cannot fault and the importer accepts: an empty document is LEGAL to run new (measured), so no finding", () => {
    const ws = workspace();
    // Measured while writing this file: `validateHandoff` accepts the handoff the
    // renderer writes for an all-blank seed (the Findings section carries its
    // own `none — …` item). The check must not invent a refusal `run new` would
    // not make; the four missing What headings are advisories, as they are there.
    const rel = writeSeed(ws, "18.md", "\n\n\n");
    const report = checkSeed(ws.root, rel);
    expect(rulesOf(report)).toEqual([]);
    expect(report.advisories.map((a) => a.rule)).toEqual(["heading", "heading", "heading", "heading"]);
  });

  test("a mid-sentence citation the per-line pass faults is one the importer still accepts — the two are not the same reading", () => {
    const ws = workspace();
    const rel = writeSeed(ws, "23.md", variant(
      "- The rank test passes with two equal scores in name order [src: lab/src/rank.ts:2]",
      "- The rank test passes [src: lab/src/rank.ts:2] with two equal scores in name order",
    ));
    // The renderer appends its own seed-line token, so the handoff line parses;
    // only the authoring rule says the reader will not see the citation.
    expect(rulesOf(checkSeed(ws.root, rel))).toEqual(["src-grammar"]);
  });
});

describe("the rendered report", () => {
  test("one `file:line rule — text` line per finding, `advisory:` prefixed for advisories, and a last line that says the verdict", () => {
    const ws = workspace();
    const rel = writeSeed(ws, "19.md", variant("- depends_on: S1\n", "- depends_on: S9\n"));
    const text = renderSeedCheck(checkSeed(ws.root, rel));
    const lines = text.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^\.tldrx\/seeds\/19\.md:\d+ depends-unknown — /);
    expect(lines[lines.length - 1]).toContain("1 finding");
  });

  test("with --budget the derived stage split and the per-story caps are printed off the same arithmetic run new uses", () => {
    const ws = workspace();
    const rel = writeSeed(ws, "20.md", GOOD_SEED);
    const report = checkSeed(ws.root, rel, { scope: "feature", budgetUsd: 60 });
    const text = renderSeedCheck(report);
    // feature: what 4, how 6, plan 4, build 9, watch 2 = 25 declared, x2 attempts = 50
    // claimed; 60/50 = 1.2 → build 10.80 per attempt (the figure #289 was filed over).
    expect(text).toContain("build");
    expect(text).toContain("$10.80");
    // Two stories, two attempts, a quarter reviewer share: 10.80 / (2 x 2 x 1.25) = 2.16.
    expect(text).toContain("$2.16");
    expect(text).toContain("#244");
  });
});

describe("tldrx seed check, through the binary", () => {
  test("a clean seed exits 0 and creates no run", async () => {
    const ws = workspace();
    const rel = writeSeed(ws, "21.md", GOOD_SEED);
    const before = readdirSync(join(ws.root, PROJECT_WORK_DIR));
    const run = await tldrx(ws.root, ["seed", "check", rel]);
    expect(run.stderr).toBe("");
    expect(run.code).toBe(EXIT_OK);
    expect(run.stdout).toContain("ok");
    expect(readdirSync(join(ws.root, PROJECT_WORK_DIR))).toEqual(before);
  });

  test("a seed with findings exits 1, one line per finding, and still creates no run", async () => {
    const ws = workspace();
    const rel = writeSeed(ws, "22.md", variant("npm run test\n```", "npm test\n```"));
    const run = await tldrx(ws.root, ["seed", "check", rel]);
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.stdout).toMatch(/^\.tldrx\/seeds\/22\.md:\d+ dod-command — /m);
    expect(existsSync(join(ws.root, PROJECT_WORK_DIR))).toBe(true);
    expect(readdirSync(join(ws.root, PROJECT_WORK_DIR)).filter((d) => !d.startsWith("260828"))).toEqual([]);
  });

  test("an unreadable Recommended: line exits 1 through the binary, naming the rule (#323)", async () => {
    const ws = workspace();
    const rel = writeSeed(ws, "22b.md", variant(
      "Recommended: A — matches the existing sort",
      "Recommended: A because it matches the existing sort",
    ));
    const run = await tldrx(ws.root, ["seed", "check", rel]);
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.stdout).toMatch(/^\.tldrx\/seeds\/22b\.md:11 question-recommended-unreadable — /m);
  });

  test("a path that does not exist exits 3", async () => {
    const ws = workspace();
    const run = await tldrx(ws.root, ["seed", "check", ".tldrx/seeds/nope.md"]);
    expect(run.code).toBe(EXIT_NOT_FOUND);
    expect(run.stderr).toContain("nope.md");
  });

  test("no path is a usage error", async () => {
    const ws = workspace();
    const run = await tldrx(ws.root, ["seed", "check"]);
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.stderr).toContain("seed check");
  });
});
