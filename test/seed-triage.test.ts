/**
 * `tldrx seed triage` / `tldrx seed apply` (spec §6.2).
 *
 * The deterministic half is tested against real files with real cross-links, a
 * real `Status:` line and eight paths that really exist — the code-derived
 * heuristic resolves every path it counts, so a fixture of made-up paths would
 * silently test nothing.
 *
 * The model is faked, always. `FAKE_TRIAGE_*` drives a `claude` script that is the
 * ONLY one on PATH for the duration, so a test that forgot to set it up gets a
 * failed spawn rather than a real, billed session.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseYaml } from "../src/core/yaml.ts";
import { collectSeed, collectSeeds } from "../src/core/seed/collectSeed.ts";
import {
  buildInventory, estimateTokens, formatTokens, verdictLine, DEFAULT_THRESHOLD_TOKENS,
} from "../src/core/seed/triageInventory.ts";
import { parseSeedSrc } from "../src/core/seed/triageSrc.ts";
import { planInline, triagePrompt } from "../src/core/seed/triagePrompt.ts";
import { knownScopes, topologicalOrder, validateProposal } from "../src/core/seed/splitFile.ts";
import { runTriage, slugOf, triageOutDir, MIN_TRIAGE_USD } from "../src/core/seed/runTriage.ts";
import { applySplit, runNewLine, seedsFor } from "../src/core/seed/applySplit.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { createRun } from "../src/core/run/newRun.ts";
import { validateRunFile } from "../src/core/run/RunFile.ts";
import { validateWorkspace } from "../src/core/schemas/workspace.ts";
import { loadWorkspace } from "../src/hooks/lib/workspace.ts";
import { parseArgs, repeatedFlag } from "../src/cli/argv.ts";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";
import {
  makeSeedWorkspace, goodProposal, CODE_FILES,
  type SeedWorkspace, type SeedWorkspaceOptions,
} from "./fixtures/seed/workspace.ts";

const BIN = join(FRAMEWORK_ROOT, "bin", "tldrx.ts");
const ORIGINAL_PATH = process.env.PATH ?? "";
const FAKE_KEYS = [
  "FAKE_TRIAGE_OUTPUT", "FAKE_TRIAGE_COST", "FAKE_TRIAGE_IS_ERROR",
  "FAKE_TRIAGE_ARGV_LOG", "FAKE_TRIAGE_PROMPT_OUT", "FAKE_TRIAGE_SESSION",
] as const;

const NOW = new Date("2026-08-30T09:00:00Z");
const AT = "2026-08-30T09:00:00Z";

let open: SeedWorkspace[] = [];

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  for (const key of FAKE_KEYS) delete process.env[key];
  for (const ws of open) ws.dispose();
  open = [];
});

function workspace(options: SeedWorkspaceOptions = {}): SeedWorkspace {
  const made = makeSeedWorkspace(options);
  open.push(made);
  return made;
}

function fakeClaude(ws: SeedWorkspace, output: unknown, env: Record<string, string> = {}): void {
  process.env.PATH = ws.binDir;
  process.env.FAKE_TRIAGE_OUTPUT = JSON.stringify(output);
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
}

function inventoryOf(ws: SeedWorkspace, seedPath = "docs", thresholdTokens?: number) {
  return buildInventory({
    root: ws.root,
    seed: collectSeed(ws.root, seedPath),
    repos: loadWorkspace(ws.root).repos,
    thresholdTokens,
  });
}

function outDir(ws: SeedWorkspace): string {
  return join(ws.root, ".out");
}

// --- F1: the deterministic inventory ---------------------------------------

describe("seed triage — the inventory is measured, not guessed", () => {
  test("reads exactly what `run new --seed` reads, and reports every per-document fact", () => {
    const ws = workspace();
    const inventory = inventoryOf(ws);

    expect(inventory.documents.map((document) => document.rel)).toEqual([
      "docs/00-overview.md",
      "docs/01-tenancy.md",
      "docs/02-billing.md",
      "docs/03-legacy-inventory.md",
      "docs/adr/ADR-001.md",
    ]);

    const overview = inventory.documents[0];
    expect(overview?.h1).toEqual(["Overview"]);
    expect(overview?.h2).toEqual(["Goal", "Open questions"]);
    // A Markdown link resolved relative to the document's own directory.
    expect(overview?.references).toEqual(["docs/01-tenancy.md"]);
    // TODO + TBD + the "Open questions" heading.
    expect(overview?.openMarkers).toBe(3);
    expect(overview?.adrStatus).toBeNull();

    // `**Status:** Accepted` — bold, colon inside the emphasis, value lower-cased.
    expect(inventory.documents[1]?.adrStatus).toBe("accepted");
    expect(inventory.documents[4]?.adrStatus).toBe("superseded");

    // A BARE filename mention counts as a reference too, both ways.
    const billing = inventory.documents[2];
    expect(billing?.references).toEqual(["docs/01-tenancy.md"]);
    expect(billing?.openMarkers).toBe(2); // "Open question" + "??"

    expect(inventory.files).toBe(5);
    expect(inventory.tokens).toBe(estimateTokens(inventory.bytes));
  });

  test("`code-derived: likely` only fires on paths that RESOLVE to real files", () => {
    const ws = workspace();
    const inventory = inventoryOf(ws);
    const legacy = inventory.documents.find((document) => document.rel === "docs/03-legacy-inventory.md");

    expect(legacy?.codeDerived.cited).toBe(CODE_FILES.length);
    expect(legacy?.codeDerived.resolved).toBe(CODE_FILES.length);
    expect(legacy?.codeDerived.likely).toBe(true);
    expect(legacy?.codeDerived.examples.length).toBe(3);

    // Same eight paths, none of them on disk: cited, resolved 0, not flagged.
    const invented = workspace({
      files: {
        "docs/03-legacy-inventory.md": CODE_FILES
          .map((path) => `- \`${path.replace("src/", "gone/")}\``)
          .join("\n"),
      },
    });
    const other = inventoryOf(invented).documents
      .find((document) => document.rel === "docs/03-legacy-inventory.md");
    expect(other?.codeDerived.cited).toBe(CODE_FILES.length);
    expect(other?.codeDerived.resolved).toBe(0);
    expect(other?.codeDerived.likely).toBe(false);
  });

  test("a document citing its siblings is a REFERENCE, never code-derived", () => {
    const ws = workspace();
    const inventory = inventoryOf(ws);
    for (const document of inventory.documents) {
      expect(document.codeDerived.cited).toBeLessThanOrEqual(CODE_FILES.length);
    }
    // The overview links a .md and is not counted as citing code.
    expect(inventory.documents[0]?.codeDerived.cited).toBe(0);
  });

  test("the verdict line names the next command, both above and below the threshold", () => {
    const ws = workspace();
    expect(verdictLine(inventoryOf(ws), "docs"))
      .toBe("seed: 5 files, ~267 tokens — under the 20k threshold; `tldrx run new --seed docs` will do");
    expect(verdictLine(inventoryOf(ws, "docs", 100), "docs"))
      .toBe("seed: 5 files, ~267 tokens — above the 100 threshold; run `tldrx seed triage docs --propose`");
    expect(formatTokens(44_231)).toBe("~44k");
    expect(formatTokens(256)).toBe("~256");
  });

  test("the threshold comes from workspace.yml when it is there, and the flag wins over both", async () => {
    const ws = workspace({ workspaceExtra: "seed_triage:\n  threshold_tokens: 100\n" });
    expect(loadWorkspace(ws.root).seedTriageThresholdTokens).toBe(100);
    // The key is additive: it raises no issue of its own. (The fixture is the
    // draft `version:`/`mode: single-repo` shape the repo ships, which
    // `validateWorkspace` has never accepted — that predates this wave.)
    const issues = validateWorkspace(parseYaml(readFileSync(join(ws.root, ".tldrx/workspace.yml"), "utf8"))).issues;
    expect(issues.filter((issue) => issue.path.startsWith("seed_triage"))).toEqual([]);

    const fromFile = await runTriage({ root: ws.root, seedPath: "docs", out: outDir(ws), at: AT, now: NOW });
    expect(fromFile.lines[0]).toContain("above the 100 threshold");

    const fromFlag = await runTriage({
      root: ws.root, seedPath: "docs", out: outDir(ws), thresholdTokens: 50_000, at: AT, now: NOW,
    });
    expect(fromFlag.lines[0]).toContain("under the 50k threshold");

    // No key at all ⇒ the built-in default, and the default is what the docs say.
    const plain = workspace();
    expect(loadWorkspace(plain.root).seedTriageThresholdTokens).toBeNull();
    expect(inventoryOf(plain).thresholdTokens).toBe(DEFAULT_THRESHOLD_TOKENS);
  });

  test("a non-numeric or non-positive threshold_tokens is a schema error, not a silent default", () => {
    const base = { schema_version: 1, mode: "single", root: ".", repos: [{ name: "api", path: "api" }] };
    expect(validateWorkspace(base).ok).toBe(true);
    expect(validateWorkspace({ ...base, seed_triage: { threshold_tokens: 30_000 } }).ok).toBe(true);
    // Absent is legal — that is what "optional" means.
    expect(validateWorkspace({ ...base, seed_triage: {} }).ok).toBe(true);

    const bad = validateWorkspace({ ...base, seed_triage: { threshold_tokens: "lots" } });
    expect(bad.ok).toBe(false);
    expect(bad.issues[0]?.path).toBe("seed_triage.threshold_tokens");

    const zero = validateWorkspace({ ...base, seed_triage: { threshold_tokens: 0 } });
    expect(zero.ok).toBe(false);
    expect(zero.issues[0]?.message).toContain("positive number of tokens");

    const notAMapping = validateWorkspace({ ...base, seed_triage: 30_000 });
    expect(notAMapping.ok).toBe(false);
    expect(notAMapping.issues[0]?.path).toBe("seed_triage");
  });

  test("writes inventory.md and inventory.json, and --json puts the same numbers on stdout", async () => {
    const ws = workspace();
    const outcome = await runTriage({
      root: ws.root, seedPath: "docs", out: outDir(ws), json: true, at: AT, now: NOW,
    });
    expect(outcome.code).toBe(0);
    expect(existsSync(join(outDir(ws), "inventory.md"))).toBe(true);

    const json = JSON.parse(outcome.lines.join("\n")) as {
      totals: { files: number; tokens: number };
      documents: { rel: string; code_derived: { likely: boolean } }[];
      verdict: string;
    };
    expect(json.totals.files).toBe(5);
    expect(json.verdict).toContain("seed: 5 files");
    expect(json.documents.find((row) => row.rel === "docs/03-legacy-inventory.md")?.code_derived.likely).toBe(true);
    expect(JSON.parse(readFileSync(join(outDir(ws), "inventory.json"), "utf8"))).toEqual(json);
  });

  test("the default --out is `.tldrx/triage/<yymmdd>-<slug>/`", () => {
    const ws = workspace();
    expect(triageOutDir(ws.root, "docs/domain-design", NOW))
      .toBe(join(ws.root, ".tldrx", "triage", "260830-domain-design"));
    expect(slugOf("docs/Domain Design/")).toBe("domain-design");
    expect(slugOf("requirements.md")).toBe("requirements");
    expect(slugOf("/")).toBe("seed");
  });

  test("skipped documents survive into the inventory rather than vanishing", () => {
    const ws = workspace({ files: { "docs/notes.rst": "# not markdown\n" } });
    const inventory = inventoryOf(ws);
    // `.rst` is not a seed extension, so it is not a document and not a skip —
    // the skip list is for things that WERE candidates and lost.
    expect(inventory.documents.map((d) => d.rel)).not.toContain("docs/notes.rst");
    expect(inventory.skipped).toEqual([]);
  });
});

// --- the `seed:` src grammar -----------------------------------------------

describe("the `seed:` src grammar is its own, narrower thing", () => {
  test("accepts a heading and a line, and nothing else", () => {
    expect(parseSeedSrc("seed:docs/01-tenancy.md#Accounts"))
      .toEqual({ kind: "heading", raw: "seed:docs/01-tenancy.md#Accounts", rel: "docs/01-tenancy.md", heading: "Accounts" });
    expect(parseSeedSrc("seed:docs/01-tenancy.md:5"))
      .toEqual({ kind: "line", raw: "seed:docs/01-tenancy.md:5", rel: "docs/01-tenancy.md", line: 5 });
    // A heading may hold a colon; `#` is checked first, so this is unambiguous.
    const withColon = parseSeedSrc("seed:a.md#Goal: ship it");
    expect(withColon).toMatchObject({ kind: "heading", rel: "a.md", heading: "Goal: ship it" });

    expect(parseSeedSrc("docs/a.md:1")).toHaveProperty("error");
    expect(parseSeedSrc("seed:docs/a.md")).toHaveProperty("error");
    expect(parseSeedSrc("seed:docs/a.md#")).toHaveProperty("error");
    expect(parseSeedSrc("seed:docs/a.md:0")).toHaveProperty("error");
    // §2.8's own kinds are NOT seed srcs — the two grammars stay apart.
    expect(parseSeedSrc("F001")).toHaveProperty("error");
    expect(parseSeedSrc("absent:docs/a.md")).toHaveProperty("error");
  });
});

// --- F2: validation ---------------------------------------------------------

describe("a proposal is validated against this workspace before anything is written", () => {
  function ctx(ws: SeedWorkspace) {
    const inventory = inventoryOf(ws);
    return {
      rels: new Set(inventory.documents.map((document) => document.rel)),
      scopes: knownScopes(ws.root),
      lines: new Map(inventory.documents.map((document) => [document.rel, document.lines] as const)),
    };
  }

  test("the happy path validates and keeps every field", () => {
    const ws = workspace();
    const validation = validateProposal(goodProposal(), ctx(ws));
    expect(validation.issues).toEqual([]);
    expect(validation.ok).toBe(true);
    expect(validation.proposal?.runs.map((run) => run.slug)).toEqual(["billing", "tenancy"]);
    expect(validation.proposal?.questions[0]?.options).toEqual(["banker's", "half-up"]);
  });

  test("an unknown scope is named, with the ones that exist", () => {
    const ws = workspace();
    const bad = goodProposal();
    (bad.runs as Record<string, unknown>[])[0]!.scope = "megafeature";
    const validation = validateProposal(bad, ctx(ws));
    expect(validation.ok).toBe(false);
    expect(validation.issues.join("\n")).toContain("'megafeature' is not a workflow");
    expect(validation.issues.join("\n")).toContain("feature");
  });

  test("a seed that was not in the inventory is refused", () => {
    const ws = workspace();
    const bad = goodProposal();
    (bad.runs as Record<string, unknown>[])[0]!.seeds = ["docs/99-invented.md"];
    const validation = validateProposal(bad, ctx(ws));
    expect(validation.ok).toBe(false);
    expect(validation.issues.join("\n")).toContain("'docs/99-invented.md' is not a document in the inventory");
  });

  test("a dependency cycle is refused and the cycle is printed", () => {
    const ws = workspace();
    const bad = goodProposal();
    (bad.runs as Record<string, unknown>[])[1]!.depends_on = ["billing"];
    const validation = validateProposal(bad, ctx(ws));
    expect(validation.ok).toBe(false);
    expect(validation.issues.join("\n")).toContain("dependency cycle");
    expect(topologicalOrder([
      { slug: "a", scope: "feature", goal: "a", seeds: [], depends_on: ["b"], size: "S", budget_usd: 1, why: [] },
      { slug: "b", scope: "feature", goal: "b", seeds: [], depends_on: ["a"], size: "S", budget_usd: 1, why: [] },
    ])).toBeNull();
  });

  test("a `why` src outside the grammar, or past the end of the file, is refused", () => {
    const ws = workspace();
    const badGrammar = goodProposal();
    (badGrammar.runs as Record<string, unknown>[])[0]!.why = [{ claim: "x", src: "docs/02-billing.md:1" }];
    expect(validateProposal(badGrammar, ctx(ws)).issues.join("\n")).toContain("does not start with `seed:`");

    const pastEnd = goodProposal();
    (pastEnd.runs as Record<string, unknown>[])[0]!.why = [{ claim: "x", src: "seed:docs/02-billing.md:9999" }];
    expect(validateProposal(pastEnd, ctx(ws)).issues.join("\n")).toContain("line(s), not 9999");

    const unknownDoc = goodProposal();
    (unknownDoc.runs as Record<string, unknown>[])[0]!.why = [{ claim: "x", src: "seed:nope.md#H" }];
    expect(validateProposal(unknownDoc, ctx(ws)).issues.join("\n")).toContain("'nope.md' is not a document");
  });

  test("duplicate or malformed slugs, and an empty runs list, are refused", () => {
    const ws = workspace();
    const dupe = goodProposal();
    (dupe.runs as Record<string, unknown>[])[1]!.slug = "billing";
    expect(validateProposal(dupe, ctx(ws)).issues.join("\n")).toContain("is used twice");

    const shouty = goodProposal();
    (shouty.runs as Record<string, unknown>[])[0]!.slug = "Billing Run";
    expect(validateProposal(shouty, ctx(ws)).issues.join("\n")).toContain("is not a run slug");

    expect(validateProposal({ shared_context: [], exclude: [], runs: [], questions: [] }, ctx(ws)).issues.join("\n"))
      .toContain("at least one run");
  });
});

// --- F2: the model pass -----------------------------------------------------

describe("seed triage --propose", () => {
  function propose(ws: SeedWorkspace, overrides: Partial<Parameters<typeof runTriage>[0]> = {}) {
    return runTriage({
      root: ws.root, seedPath: "docs", out: outDir(ws), propose: true,
      at: AT, now: NOW, timeoutMs: 20_000, ...overrides,
    });
  }

  test("writes split.yml and split.md from a valid proposal, and never creates a run", async () => {
    const ws = workspace();
    const argvLog = join(ws.root, "argv.log");
    const promptOut = join(ws.root, "prompt.txt");
    fakeClaude(ws, goodProposal(), {
      FAKE_TRIAGE_COST: "0.19",
      FAKE_TRIAGE_ARGV_LOG: argvLog,
      FAKE_TRIAGE_PROMPT_OUT: promptOut,
    });

    const outcome = await propose(ws);
    expect(outcome.code).toBe(0);
    expect(outcome.costUsd).toBe(0.19);
    expect(outcome.lines[0]).toContain("proposed 2 run(s)");

    const split = parseYaml(readFileSync(join(outDir(ws), "split.yml"), "utf8")) as Record<string, unknown>;
    expect(split.status).toBe("proposed");
    expect(split.source).toBe("docs");
    expect(split.created_at).toBe(AT);
    expect((split.runs as { slug: string }[]).map((run) => run.slug)).toEqual(["billing", "tenancy"]);
    expect(readFileSync(join(outDir(ws), "split.md"), "utf8")).toContain("`tldrx seed apply` is the gate");

    // Nothing was created. That is the whole separation of concerns.
    expect(existsSync(join(ws.root, "tldrx-work"))).toBe(false);

    // The spawn used the shared flags, with the split schema and a low effort.
    const argv = JSON.parse(readFileSync(argvLog, "utf8").trim()) as string[];
    expect(argv.slice(0, 3)).toEqual(["-p", "--output-format", "json"]);
    expect(argv).toContain("--json-schema");
    expect(argv[argv.indexOf("--effort") + 1]).toBe("low");
    expect(argv[argv.indexOf("--max-budget-usd") + 1]).toBe("1.00");
    // No `--model` at all when none is asked for: the CLI's own default applies,
    // exactly as `tldrx next` and `expert train` leave it (spawnAgent.ts:117).
    expect(argv).not.toContain("--model");

    const prompt = readFileSync(promptOut, "utf8");
    expect(prompt).toContain("docs/03-legacy-inventory.md");
    expect(prompt).toContain("likely (8 paths resolve)");
    expect(prompt).toContain("Prices are integers in minor units.");
  });

  test("--model and --effort reach the sub-agent", async () => {
    const ws = workspace();
    const argvLog = join(ws.root, "argv.log");
    fakeClaude(ws, goodProposal(), { FAKE_TRIAGE_ARGV_LOG: argvLog });
    const outcome = await propose(ws, { model: "haiku", effort: "medium", maxUsd: 0.5 });
    expect(outcome.code).toBe(0);
    const argv = JSON.parse(readFileSync(argvLog, "utf8").trim()) as string[];
    expect(argv[argv.indexOf("--model") + 1]).toBe("haiku");
    expect(argv[argv.indexOf("--effort") + 1]).toBe("medium");
    expect(argv[argv.indexOf("--max-budget-usd") + 1]).toBe("0.50");
  });

  test("a proposal that does not validate exits 5, writes no split, and keeps the raw answer", async () => {
    const ws = workspace();
    const bad = goodProposal();
    (bad.runs as Record<string, unknown>[])[0]!.scope = "megafeature";
    fakeClaude(ws, bad);

    const outcome = await propose(ws);
    expect(outcome.code).toBe(5);
    expect(outcome.lines[0]).toContain("does not validate");
    expect(outcome.lines.join("\n")).toContain("'megafeature' is not a workflow");
    expect(existsSync(join(outDir(ws), "split.yml"))).toBe(false);
    expect(existsSync(join(outDir(ws), ".agent", "propose", "result.raw.json"))).toBe(true);
  });

  test("a failed sub-agent exits 5 and says what it cost", async () => {
    const ws = workspace();
    fakeClaude(ws, goodProposal(), { FAKE_TRIAGE_IS_ERROR: "1", FAKE_TRIAGE_COST: "0.07" });
    const outcome = await propose(ws);
    expect(outcome.code).toBe(5);
    expect(outcome.lines[0]).toContain("sub-agent failed");
    expect(outcome.lines.join("\n")).toContain("$0.07 of $1.00 spent");
    expect(existsSync(join(outDir(ws), "split.yml"))).toBe(false);
  });

  test("a ceiling under the floor is refused BEFORE anything is spawned", async () => {
    const ws = workspace();
    // No fake on PATH at all: if this spawned, it would fail differently.
    const outcome = await propose(ws, { maxUsd: 0.05 });
    expect(outcome.code).toBe(2);
    expect(outcome.lines[0]).toContain(`under the $${MIN_TRIAGE_USD.toFixed(2)} floor`);
    expect(outcome.lines.join("\n")).toContain("stop-after-turn, not a cap");
  });

  test("--prepare writes the bundle and stops; --commit picks the same path up", async () => {
    const ws = workspace();
    const prepared = await propose(ws, { mode: "prepare" });
    expect(prepared.code).toBe(0);
    expect(prepared.costUsd).toBe(0);

    const bundle = join(outDir(ws), ".agent", "propose");
    expect(existsSync(join(bundle, "prompt.md"))).toBe(true);
    const pending = JSON.parse(readFileSync(join(bundle, "pending.json"), "utf8")) as Record<string, unknown>;
    expect(pending.stage).toBe("propose");
    expect(pending.effort).toBe("low");
    expect(pending.max_budget_usd).toBe(1);
    expect(readFileSync(join(bundle, "prompt.md"), "utf8")).toContain("result.json");
    expect(existsSync(join(outDir(ws), "split.yml"))).toBe(false);

    // A commit with nothing written is a usage error that names the file.
    const early = await propose(ws, { mode: "commit" });
    expect(early.code).toBe(1);
    expect(early.lines[0]).toContain("no result.json");

    writeFileSync(
      join(bundle, "result.json"),
      JSON.stringify({ proposal: goodProposal(), cost_usd: 0.08, session_id: "s-1" }),
      "utf8",
    );
    const committed = await propose(ws, { mode: "commit" });
    expect(committed.code).toBe(0);
    expect(committed.costUsd).toBe(0.08);
    expect(committed.lines[0]).toContain("session s-1");
    const split = parseYaml(readFileSync(join(outDir(ws), "split.yml"), "utf8")) as { status: string };
    expect(split.status).toBe("proposed");
  });

  test("the prompt states precisely what was truncated", () => {
    const ws = workspace();
    const seed = collectSeed(ws.root, "docs");
    const plan = planInline(seed, 400);
    expect(plan.truncated.length).toBeGreaterThan(0);

    const prompt = triagePrompt({
      inventory: inventoryOf(ws),
      seed,
      seedPath: "docs",
      scopes: ["feature"],
      budgetUsd: 1,
      promptBytes: 400,
    });
    expect(prompt).toContain("TRUNCATED");
    expect(prompt).toContain("Every heading in the whole document");
    for (const note of plan.truncated) expect(prompt).toContain(note);
    // The whole-document heading list, not the prefix's — the map must be the real map.
    expect(prompt).toContain("## Locations");
  });
});

// --- F3: apply --------------------------------------------------------------

describe("seed apply — the gate is that you ran it", () => {
  async function proposed(ws: SeedWorkspace): Promise<string> {
    fakeClaude(ws, goodProposal());
    const outcome = await runTriage({
      root: ws.root, seedPath: "docs", out: outDir(ws), propose: true, at: AT, now: NOW, timeoutMs: 20_000,
    });
    expect(outcome.code).toBe(0);
    return join(outDir(ws), "split.yml");
  }

  test("--dry-run prints the exact `run new` lines and writes nothing", async () => {
    const ws = workspace();
    const path = await proposed(ws);
    const outcome = applySplit({ root: ws.root, splitPath: path, dryRun: true, actor: "alan", now: NOW });

    expect(outcome.code).toBe(0);
    expect(outcome.created).toEqual([]);
    // Dependency order, not declaration order: tenancy is what billing waits for.
    expect(outcome.lines[1]).toBe(
      "  tldrx run new tenancy --scope feature --budget 12.00 "
      + "--seed docs/00-overview.md --seed docs/01-tenancy.md",
    );
    expect(outcome.lines[2]).toBe(
      "  tldrx run new billing --scope feature --budget 25.00 "
      + "--seed docs/00-overview.md --seed docs/02-billing.md",
    );
    expect(existsSync(join(ws.root, "tldrx-work"))).toBe(false);
    expect((parseYaml(readFileSync(path, "utf8")) as { status: string }).status).toBe("proposed");
  });

  test("a real apply creates every run in dependency order, with the right seeds and a triage block", async () => {
    const ws = workspace();
    const path = await proposed(ws);
    const outcome = applySplit({ root: ws.root, splitPath: path, actor: "alan", now: NOW });

    expect(outcome.code).toBe(0);
    expect(outcome.created).toEqual(["260830-tenancy", "260830-billing"]);
    expect(outcome.lines[0]).toBe("created 260830-tenancy (feature, 2 seeds)");
    expect(outcome.lines[1]).toBe("created 260830-billing (feature, 2 seeds, depends on: tenancy)");
    expect(outcome.notes.join("\n")).toContain("2 run(s) open");

    const billing = RunStore.open(join(ws.root, "tldrx-work", "260830-billing"));
    expect(billing.run.scope).toBe("feature");
    expect(billing.run.title).toBe("Money, prices and refunds");
    expect(billing.run.budget.ceiling_usd).toBe(25);
    expect(billing.run.triage).toEqual({ split: ".out/split.yml", depends_on: ["tenancy"] });
    // The shared context landed in the run's declared What inputs, with its own seed.
    const what = billing.run.phases[0]?.stages[0];
    expect(what?.inputs).toContain("docs/00-overview.md");
    expect(what?.inputs).toContain("docs/02-billing.md");
    expect(what?.inputs).not.toContain("docs/01-tenancy.md");

    // `triage:` survives a round trip through the emitter and the validator.
    const onDisk = parseYaml(readFileSync(join(billing.runDir, "run.yml"), "utf8"));
    expect(validateRunFile(onDisk).ok).toBe(true);
    expect((onDisk as { triage: unknown }).triage)
      .toEqual({ split: ".out/split.yml", depends_on: ["tenancy"] });

    // And the split is flipped, once, with what it made.
    const split = parseYaml(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(split.status).toBe("applied");
    expect(split.applied_at).toBe("2026-08-30T09:00:00Z");
    expect(split.created_runs).toEqual(["260830-tenancy", "260830-billing"]);
    expect(readFileSync(join(outDir(ws), "split.md"), "utf8")).toContain("## Created");
  });

  test("an applied split is refused a second time", async () => {
    const ws = workspace();
    const path = await proposed(ws);
    expect(applySplit({ root: ws.root, splitPath: path, actor: "alan", now: NOW }).code).toBe(0);

    const again = applySplit({ root: ws.root, splitPath: path, actor: "alan", now: NOW });
    expect(again.code).toBe(1);
    expect(again.lines[0]).toContain("`status: applied`, not `proposed`");
    expect(again.lines[1]).toContain("260830-tenancy");
  });

  test("an existing run dir stops the apply there, and the earlier runs are named", async () => {
    const ws = workspace();
    const path = await proposed(ws);
    // Take the SECOND run's id — the first must still be created before the stop.
    createRun({ root: ws.root, slug: "billing", scope: "docs", budgetUsd: 6, actor: "alan", now: NOW });

    const outcome = applySplit({ root: ws.root, splitPath: path, actor: "alan", now: NOW });
    expect(outcome.code).toBe(1);
    expect(outcome.lines[0]).toContain("stopped at `billing`");
    expect(outcome.lines[0]).toContain("tldrx-work/260830-billing already exists");
    expect(outcome.lines[1]).toContain("LEFT IN PLACE: 260830-tenancy");
    expect(existsSync(join(ws.root, "tldrx-work", "260830-tenancy"))).toBe(true);
    // Not flipped: the split still describes work that has not all happened.
    expect((parseYaml(readFileSync(path, "utf8")) as { status: string }).status).toBe("proposed");
  });

  test("apply revalidates the file a human was invited to edit", async () => {
    const ws = workspace();
    const path = await proposed(ws);
    writeFileSync(path, readFileSync(path, "utf8").replace("scope: feature", "scope: megafeature"), "utf8");

    const outcome = applySplit({ root: ws.root, splitPath: path, actor: "alan", now: NOW });
    expect(outcome.code).toBe(1);
    expect(outcome.lines.join("\n")).toContain("'megafeature' is not a workflow");
    expect(existsSync(join(ws.root, "tldrx-work"))).toBe(false);
  });

  test("a missing file is exit 3, not a crash", () => {
    const ws = workspace();
    const outcome = applySplit({ root: ws.root, splitPath: join(ws.root, "nope.yml"), actor: "alan", now: NOW });
    expect(outcome.code).toBe(3);
  });

  test("shared context is deduped, and the printed line is the command", () => {
    const run = {
      slug: "a", scope: "feature", goal: "g", seeds: ["x.md", "s.md"], depends_on: [],
      size: "S" as const, budget_usd: 3, why: [],
    };
    expect(seedsFor(run, ["s.md"])).toEqual(["s.md", "x.md"]);
    expect(runNewLine(run, ["s.md"]))
      .toBe("tldrx run new a --scope feature --budget 3.00 --seed s.md --seed x.md");
  });
});

// --- F4 + repeatable --seed -------------------------------------------------

describe("run new --seed", () => {
  test("the flag is repeatable, and one occurrence is unchanged", () => {
    const ws = workspace();
    const one = collectSeed(ws.root, "docs/01-tenancy.md");
    expect(collectSeeds(ws.root, ["docs/01-tenancy.md"])).toEqual(one);

    const merged = collectSeeds(ws.root, ["docs/02-billing.md", "docs/adr", "docs/02-billing.md"]);
    expect(merged.documents.map((document) => document.rel))
      .toEqual(["docs/02-billing.md", "docs/adr/ADR-001.md"]);
    expect(merged.sources).toEqual(["docs/02-billing.md", "docs/adr", "docs/02-billing.md"]);
    expect(merged.isDirectory).toBe(true);

    // The parser keeps every occurrence; `stringFlag` still sees the last one.
    const args = parseArgs(["--seed", "a.md", "--seed", "docs/"], ["seed"]);
    expect(repeatedFlag(args, "seed")).toEqual(["a.md", "docs/"]);
    expect(args.flags.get("seed")).toBe("docs/");
    expect(repeatedFlag(args, "never")).toEqual([]);
  });

  test("a run created from several --seed declares them all", () => {
    const ws = workspace();
    const outcome = createRun({
      root: ws.root, slug: "multi", scope: "feature", budgetUsd: 25,
      seed: ["docs/01-tenancy.md", "docs/02-billing.md"], actor: "alan", now: NOW,
    });
    const inputs = RunStore.open(outcome.runDir).run.phases[0]?.stages[0]?.inputs ?? [];
    expect(inputs).toContain("docs/01-tenancy.md");
    expect(inputs).toContain("docs/02-billing.md");
    expect(readFileSync(join(outcome.runDir, "01-what/seed-index.md"), "utf8"))
      .toContain("--seed docs/01-tenancy.md --seed docs/02-billing.md");
  });

  test("the size hint goes to STDERR and never touches stdout", async () => {
    const ws = workspace({ workspaceExtra: "seed_triage:\n  threshold_tokens: 100\n" });
    const run = await tldrx(ws.root, "run", "new", "big", "--scope", "feature", "--seed", "docs");
    expect(run.code).toBe(0);
    expect(run.stderr).toContain("note: seed is 5 files / ~267 tokens — `tldrx seed triage docs` can propose a split");
    expect(run.stdout).not.toContain("seed triage");
    expect(run.stdout).toContain("created tldrx-work/");
  });

  test("no hint for a small seed of few files", async () => {
    const ws = workspace();
    const run = await tldrx(ws.root, "run", "new", "small", "--seed", "docs/01-tenancy.md");
    expect(run.code).toBe(0);
    expect(run.stderr).not.toContain("seed triage");
  });

  test("over ten files hints even under the token threshold", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 8; i++) files[`docs/extra-${String(i)}.md`] = `# Extra ${String(i)}\n\nOne line.\n`;
    const ws = workspace({ files });
    const run = await tldrx(ws.root, "run", "new", "many", "--seed", "docs");
    expect(run.code).toBe(0);
    expect(run.stderr).toContain("note: seed is 13 files /");
    expect(run.stderr).toContain("can propose a split");
  });
});

// --- the CLI surface --------------------------------------------------------

describe("tldrx seed, through the real binary", () => {
  test("triage with no --propose spawns nothing and exits 0", async () => {
    const ws = workspace();
    const run = await tldrx(ws.root, "seed", "triage", "docs", "--out", join(ws.root, ".out"));
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("seed: 5 files");
    expect(existsSync(join(ws.root, ".out", "inventory.md"))).toBe(true);
  });

  test("`--prepare` without `--propose` is a usage error, not a silent no-op", async () => {
    const ws = workspace();
    const run = await tldrx(ws.root, "seed", "triage", "docs", "--prepare");
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("--prepare/--commit only mean something with --propose");
  });

  test("an unknown subcommand prints the usage and exits 1", async () => {
    const ws = workspace();
    const run = await tldrx(ws.root, "seed", "explode");
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("expected `triage` or `apply`");
  });
});

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * The real binary, in a workspace, with a PATH that has no `claude` on it: every
 * case here must be free, and a test that accidentally reached the real binary
 * would spend money nobody logged.
 */
async function tldrx(cwd: string, ...args: string[]): Promise<Run> {
  mkdirSync(cwd, { recursive: true });
  const proc = Bun.spawn(["bun", BIN, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: "/nonexistent", HOME: process.env.HOME ?? "", ...bunOnPath() },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

/** `bun` itself must still resolve; nothing else needs to. */
function bunOnPath(): Record<string, string> {
  const bun = process.execPath.slice(0, process.execPath.lastIndexOf("/"));
  return { PATH: `${bun}:/usr/bin:/bin` };
}
