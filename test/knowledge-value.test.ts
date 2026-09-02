/**
 * Wave O — does a citation SUSTAIN its claim, and is the claim worth anything?
 *
 * Wave M proved every `src` resolves. These tests guard the next question, which
 * the 2026-08-29 audit asked and nothing answered: a resolvable citation under a
 * claim it does not support, a bullet that restates the line it cites, a citation
 * outside the expert's own domain, and a ladder that rewarded breadth of files
 * over depth of finding.
 *
 * The corpus is real. `test/fixtures/knowledge/aparece-api-header.md` is the
 * verbatim first 18 lines of a knowledge file a real training run wrote, header
 * and all, and the first thing asserted below is that this framework now refuses
 * it. A rule written against invented input is a rule that has never met the
 * failure it exists for.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseYaml } from "../src/core/yaml.ts";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";
import { emptySrcContext } from "../src/core/text/srcToken.ts";
import { loadWorkspace, toSrcContext } from "../src/hooks/lib/workspace.ts";
import { competencyLevel, weightOf, recency } from "../src/core/init/competencyLevel.ts";
import { readEvidenceRows } from "../src/core/experts/readEvidenceRows.ts";
import { countFindings, loadExperts, sharedCitations, sharedCitationWarnings } from "../src/core/experts/index.ts";
import { renderTrainPrompt } from "../src/core/experts/trainPrompt.ts";
import {
  claimText, confidenceOf, executionClaim, isParaphrase, neighbourhood, normaliseClaim,
} from "../src/core/training/claimCheck.ts";
import {
  EXECUTION_CLAIM_REFUSAL, LIGHT_SHAPE, RUNS_SHAPE, codeEvidence, parseKnowledgeFile,
  proseExecutionIssues, runEvidence, selectFiles, knowledgeScopeFor, runTraining, trainingCacheDir,
  type KnowledgeScope, type TrainOptions,
} from "../src/core/training/index.ts";
import { appendBuildRetro, extractBuildSection, gateRetroLines, storyRetroLines } from "../src/core/build/retroLog.ts";
import { loadExpert } from "../src/core/experts/loadExperts.ts";
import type { StoryOutcome } from "../src/core/build/outcome.ts";
import {
  makeTrainingWorkspace, knowledgeMd, AREA, EXPERT, TRAIN_AT, TRAIN_NOW,
  type TrainingWorkspace, type TrainingWorkspaceOptions,
} from "./fixtures/training/workspace.ts";

const ORIGINAL_PATH = process.env.PATH ?? "";
const FAKE_KEYS = [
  "FAKE_TRAIN_ROOT", "FAKE_TRAIN_OUTPUTS", "FAKE_TRAIN_COST", "FAKE_TRAIN_STATE",
] as const;

let open: TrainingWorkspace[] = [];

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  for (const key of FAKE_KEYS) delete process.env[key];
  for (const ws of open) ws.dispose();
  open = [];
});

function workspace(options: TrainingWorkspaceOptions = {}): TrainingWorkspace {
  const made = makeTrainingWorkspace(options);
  open.push(made);
  return made;
}

const KNOWLEDGE_WRITE = `.tldrx/experts/${EXPERT}/knowledge/${AREA}.md.partial`;

function fakeClaude(ws: TrainingWorkspace, plans: readonly Record<string, string>[]): void {
  process.env.PATH = ws.binDir;
  process.env.FAKE_TRAIN_ROOT = ws.root;
  process.env.FAKE_TRAIN_STATE = ws.statePath;
  process.env.FAKE_TRAIN_OUTPUTS = JSON.stringify(plans);
  process.env.FAKE_TRAIN_COST = "0.37";
}

function train(ws: TrainingWorkspace, overrides: Partial<TrainOptions> = {}) {
  return runTraining({
    root: ws.root, expert: EXPERT, area: AREA, mode: "light", run: "headless",
    actor: "alan", at: TRAIN_AT, now: TRAIN_NOW, timeoutMs: 20_000,
    // Hermetic (#96): never read the developer's own `~/.claude/settings.json`.
    ambientModel: null, ...overrides,
  });
}

/** A knowledge file with one bullet swapped into `## Invariants`. */
function knowledgeWith(bullets: readonly string[]): string {
  return [
    `# ${AREA} — ${EXPERT}`,
    "",
    "## Invariants",
    "",
    ...bullets,
    "",
    "## Entry points",
    "",
    "- `exchange()` is the only way in from the outside [src: api:src/auth/oauth.ts:6]",
    "",
    "## Business rules",
    "",
    "- The token is written to the shared store on success [src: api:src/auth/token.ts:5]",
    "",
    "## Gotchas",
    "",
    "- There is no refresh path at all [src: absent:api/src/auth/refresh.ts]",
    "",
    "## Sources",
    "",
    "`api:src/auth/oauth.ts` is the exchange.",
    "",
  ].join("\n");
}

function ctxOf(ws: TrainingWorkspace) {
  return toSrcContext(loadWorkspace(ws.root), null);
}

function messages(issues: readonly { readonly message: string }[]): string {
  return issues.map((issue) => issue.message).join("\n");
}

// --- O1: a citation must sustain the claim ----------------------------------

describe("an execution claim needs a command, not a file line", () => {
  const REAL_HEADER = readFileSync(
    join(FRAMEWORK_ROOT, "test", "fixtures", "knowledge", "aparece-api-header.md"),
    "utf8",
  );

  test("the REAL aparece-api header is refused — three claims, three declarations cited", () => {
    // Verbatim from a knowledge file a real `tldrx expert train` wrote. It asserts
    // `dotnet build` exit 0 citing workspace.yml:19, which is the line that
    // DECLARES `build: dotnet build`, and "78/78 passed, exit 0" citing a line of
    // the test script. Every citation resolves; none of them is evidence anything ran.
    const issues = proseExecutionIssues(REAL_HEADER);
    expect(issues).toHaveLength(3);
    for (const issue of issues) {
      expect(issue.severity).toBe("error");
      expect(issue.message).toBe(EXECUTION_CLAIM_REFUSAL);
    }
    expect(EXECUTION_CLAIM_REFUSAL)
      .toBe("execution claim needs a '$ <cmd> → exit <n>' src, not a file line");
  });

  test("the same header inside a knowledge file rejects the file whole", () => {
    const ws = workspace();
    const parsed = parseKnowledgeFile(`${REAL_HEADER}\n${knowledgeMd()}`, ctxOf(ws), LIGHT_SHAPE);
    expect(parsed.ok).toBe(false);
    expect(messages(parsed.issues)).toContain(EXECUTION_CLAIM_REFUSAL);
  });

  test("a bullet claiming a result with a file src is refused; the same claim with a cmd src is not", () => {
    const ws = workspace();
    const refused = parseKnowledgeFile(
      knowledgeWith(["- The suite is green: 12/12 passed, exit 0 [src: api:src/auth/oauth.ts:7]"]),
      ctxOf(ws), LIGHT_SHAPE,
    );
    expect(refused.ok).toBe(false);
    expect(messages(refused.issues)).toContain(EXECUTION_CLAIM_REFUSAL);

    const accepted = parseKnowledgeFile(
      knowledgeWith(["- The suite is green: 12/12 passed, exit 0 [src: $ true → exit 0]"]),
      ctxOf(ws), LIGHT_SHAPE,
    );
    expect(accepted.ok).toBe(true);
    expect(codeEvidence(accepted.bullets, "2026-09-01").some((row) => row.kind === "run")).toBe(true);
  });

  test("the `(measured)` LABEL is not itself an execution claim — otherwise the rule eats the corpus", () => {
    // §2.3's own prompt rules ask every bullet to say measured/inferred/assumed,
    // and the real corpus does it on nearly every line. The word is a claim only
    // when it is in the sentence rather than in the annotation.
    expect(executionClaim(claimText("- A is B (measured) [src: a:b.ts:1]", "[src: a:b.ts:1]"))).toBeNull();
    expect(executionClaim(claimText("- A is B (measured: the two calls precede it) [src: a:b.ts:1]", "[src: a:b.ts:1]")))
      .toBeNull();
    expect(executionClaim("the build was measured on this branch")).toBe("measured");
    expect(executionClaim("`dotnet build` exit 0")).toBe("exit 0");
    expect(executionClaim("78/78 passed")).toBe("78/78 passed");
    expect(executionClaim("the build is green")).toBe("build is green");
    expect(executionClaim("the build succeeded")).toBe("build succeeded");
  });

  test("the corpus's OTHER spelling of the label — `*measured* —` — is a label too", () => {
    // All 56 bullets of the real `aparece-platform-abstractions.md` are written
    // `- *measured* — <claim> [src: …]`, and 38 of them were refused by the first
    // cut of this rule for obeying §2.3's "say which of measured/inferred/assumed".
    const leading = "- *measured* — The assembly depends on nothing else in Aparece [src: a:b.cs:1]";
    expect(executionClaim(claimText(leading, "[src: a:b.cs:1]"))).toBeNull();
    expect(confidenceOf(leading, "[src: a:b.cs:1]")).toBe("measured");
    // …including the qualified form the same file uses once.
    const qualified = "- *inferred, not measured* — `Result` and `Result<T>` are unrelated [src: a:b.cs:1]";
    expect(executionClaim(claimText(qualified, "[src: a:b.cs:1]"))).toBeNull();
    expect(confidenceOf(qualified, "[src: a:b.cs:1]")).toBe("inferred");
    expect(executionClaim("the exchange refuses an empty code")).toBeNull();
  });
});

describe("a bullet that restates its own citation is a paraphrase", () => {
  test("it warns, earns no evidence, and does not reject the file", () => {
    const ws = workspace();
    // Verbatim from the fixture's `api/src/auth/oauth.ts:6-7`, with the wrapper
    // words a model would add. The bullet says nothing the line does not.
    const echo = "- if (code === \"\") throw new Error(\"an oauth code is required\"); "
      + "const token = await post(\"/oauth/token\", { code }); [src: api:src/auth/oauth.ts:7]";
    const parsed = parseKnowledgeFile(knowledgeWith([echo]), ctxOf(ws), LIGHT_SHAPE);

    expect(parsed.ok).toBe(true);
    const paraphrase = parsed.issues.filter((issue) => issue.message.startsWith("paraphrase"));
    expect(paraphrase).toHaveLength(1);
    expect(paraphrase[0]?.severity).toBe("warning");

    // The bullet's own file earns nothing; the other two bullets still do.
    const rows = codeEvidence(parsed.bullets, "2026-09-01");
    expect(rows.map((row) => row.src)).not.toContain("api:src/auth/oauth.ts:7");
    expect(rows.map((row) => row.src)).toContain("api:src/auth/token.ts:5");
  });

  test("a finding ABOUT the same line is not a paraphrase of it", () => {
    const ws = workspace();
    const parsed = parseKnowledgeFile(
      knowledgeWith([
        "- An empty authorisation code is refused before any network call, so a caller that retries "
        + "with an empty string never reaches the token endpoint [src: api:src/auth/oauth.ts:7]",
      ]),
      ctxOf(ws), LIGHT_SHAPE,
    );
    expect(parsed.issues.filter((issue) => issue.severity === "warning")).toEqual([]);
    expect(codeEvidence(parsed.bullets, "2026-09-01").map((row) => row.src))
      .toContain("api:src/auth/oauth.ts:7");
  });

  test("the containment check is normalised, floored on length, and cheap", () => {
    expect(normaliseClaim("Foo-BAR, baz!")).toBe("foo bar baz");
    // Under MIN_PARAPHRASE_CHARS: too generic to accuse of anything.
    expect(isParaphrase("token store", "the token store is here")).toBe(false);
    const line = "the token is written to the shared store on success and never anywhere else";
    expect(isParaphrase(line, normaliseClaim(`prefix ${line} suffix`))).toBe(true);
    expect(isParaphrase(line, normaliseClaim("something entirely different about oauth scopes"))).toBe(false);
    // An unreadable file is not evidence of a paraphrase.
    expect(neighbourhood("/no/such/file.ts", 4)).toBe("");
  });
});

// --- O3: domain scoping and dedup -------------------------------------------

const DOMAIN_EXPERT_MD = [
  "---",
  `name: ${EXPERT}`,
  "kind: domain",
  "status: created",
  'created_by: "tldrx init"',
  "created_at: 2026-08-28T14:02:11Z",
  "repos: [api]",
  "---",
  "",
  `# ${EXPERT}`,
  "",
  "## Domain",
  "",
  "- `src/auth/`",
  "",
].join("\n");

const HUNTS_EXPERT_MD = [
  "---",
  "name: hunts-expert",
  "kind: domain",
  "status: created",
  'created_by: "tldrx init"',
  "created_at: 2026-08-28T14:02:11Z",
  "repos: [api]",
  "---",
  "",
  "# hunts-expert",
  "",
  "## Domain",
  "",
  "- `src/hunts/`",
  "",
].join("\n");

function domainWorkspace(extra: Readonly<Record<string, string>> = {}): TrainingWorkspace {
  return workspace({
    files: {
      [`.tldrx/experts/${EXPERT}/expert.md`]: DOMAIN_EXPERT_MD,
      ".tldrx/experts/hunts-expert/expert.md": HUNTS_EXPERT_MD,
      ".tldrx/experts/hunts-expert/competencies.yml": [
        "version: 1",
        "expert: hunts-expert",
        "status: created",
        "last_trained: null",
        "areas:",
        "  - id: hunts",
        "    title: hunt selection",
        "    level: 0",
        "    train_prompt: tldrx expert train hunts-expert --area hunts --mode light",
        "    evidence: []",
        "",
      ].join("\n"),
      ...extra,
    },
  });
}

describe("an expert speaks for its declared `## Domain` and nothing else", () => {
  test("light mode inlines only files inside it — the boundary is applied before scoring", async () => {
    const ws = domainWorkspace();
    const bounded = await selectFiles({
      root: ws.root, repos: [{ name: "api", path: "api" }],
      areaId: AREA, areaTitle: "OAuth authorisation code exchange",
      domainPaths: ["src/auth"],
    });
    const picked = bounded.inlined.map((file) => file.path);
    expect(picked).toContain("src/auth/oauth.ts");
    expect(picked).toContain("src/auth/token.ts");
    expect(picked).not.toContain("src/hunts/next.ts");
    expect(bounded.notRead.map((file) => file.path)).not.toContain("src/hunts/next.ts");
    expect(bounded.domainPaths).toEqual(["src/auth"]);

    // With no declared domain nothing changes — a stack expert is still unbounded.
    const unbounded = await selectFiles({
      root: ws.root, repos: [{ name: "api", path: "api" }],
      areaId: AREA, areaTitle: "OAuth authorisation code exchange",
    });
    expect(unbounded.domainPaths).toEqual([]);
  });

  test("a file inside the domain that greps for nothing is still a candidate", async () => {
    const ws = domainWorkspace({ "api/src/auth/quiet.ts": "export const quiet = 1;\n" });
    const bounded = await selectFiles({
      root: ws.root, repos: [{ name: "api", path: "api" }],
      areaId: AREA, areaTitle: "OAuth authorisation code exchange",
      domainPaths: ["src/auth"],
    });
    const quiet = bounded.inlined.find((file) => file.path === "src/auth/quiet.ts");
    expect(quiet?.why.join(" ")).toContain("inside the declared `## Domain`");
  });

  test("a citation outside the domain warns, names the expert that owns it, and earns nothing", () => {
    const ws = domainWorkspace();
    const scope = knowledgeScopeFor(ws.root, loadExpert(ws.root, EXPERT, TRAIN_NOW), AREA);
    expect(scope.domainPaths).toEqual(["src/auth"]);

    const parsed = parseKnowledgeFile(
      knowledgeWith(["- The next stop is chosen without touching the token store [src: api:src/hunts/next.ts:1]"]),
      ctxOf(ws), LIGHT_SHAPE, scope,
    );
    expect(parsed.ok).toBe(true);
    const outside = parsed.issues.filter((issue) => issue.message.includes("outside domain"));
    expect(outside).toHaveLength(1);
    expect(outside[0]?.severity).toBe("warning");
    expect(outside[0]?.message).toContain("hunts-expert");
    expect(codeEvidence(parsed.bullets, "2026-09-01").map((row) => row.src))
      .not.toContain("api:src/hunts/next.ts:1");
  });

  test("a src already on record in another area of the same expert is a duplicate", () => {
    const ws = domainWorkspace();
    const scope: KnowledgeScope = {
      expert: EXPERT,
      domainPaths: [],
      otherDomains: new Map(),
      seenSrc: new Set(["api:src/auth/token.ts:5"]),
    };
    const parsed = parseKnowledgeFile(knowledgeMd(), ctxOf(ws), LIGHT_SHAPE, scope);
    expect(parsed.ok).toBe(true);
    expect(messages(parsed.issues)).toContain("duplicate src");
    expect(codeEvidence(parsed.bullets, "2026-09-01").map((row) => row.src))
      .not.toContain("api:src/auth/token.ts:5");
  });

  test("the same src twice in ONE file is a duplicate too", () => {
    const ws = domainWorkspace();
    const parsed = parseKnowledgeFile(
      knowledgeWith([
        "- An empty code is refused before any request [src: api:src/auth/oauth.ts:7]",
        "- Nothing else guards the exchange at all [src: api:src/auth/oauth.ts:7]",
      ]),
      ctxOf(ws), LIGHT_SHAPE, { expert: EXPERT, domainPaths: [], otherDomains: new Map(), seenSrc: new Set() },
    );
    expect(messages(parsed.issues)).toContain("duplicate src");
  });

  test("the training run reports its warnings rather than swallowing them", async () => {
    const ws = domainWorkspace();
    fakeClaude(ws, [{
      [KNOWLEDGE_WRITE]: knowledgeWith([
        "- The next stop ignores the token store entirely [src: api:src/hunts/next.ts:1]",
      ]),
    }]);
    const outcome = await train(ws);
    expect(outcome.code).toBe(0);
    expect((outcome.warnings ?? []).join("\n")).toContain("outside domain");
  });
});

// --- O5: the ladder ----------------------------------------------------------

describe("the ladder weighs findings, not files", () => {
  const AT = "2026-09-01";
  const NOW = new Date("2026-09-01T12:00:00Z");

  test("a cross-file row weighs double and an `assumed` row weighs half", () => {
    expect(weightOf({ kind: "code", src: "a:b.ts:1", at: AT })).toBe(1);
    expect(weightOf({ kind: "code", src: "a:b.ts:1", at: AT, cross: true })).toBe(2);
    expect(weightOf({ kind: "code", src: "a:b.ts:1", at: AT, confidence: "assumed" })).toBe(0.5);
    expect(weightOf({ kind: "code", src: "a:b.ts:1", at: AT, confidence: "measured" })).toBe(1);
    expect(weightOf({ kind: "doc", src: "https://x/y", at: AT, cross: true })).toBe(1);

    // Three cross-file findings plus a run row are W=7 (level 4); the same three
    // read one file at a time are W=4 (level 3). The run row is there so the run
    // cap is not what is being measured.
    const run = { kind: "run" as const, src: "$ bun test → exit 0", at: AT };
    const crossed = [
      { kind: "code" as const, src: "a:b.ts:1", at: AT, cross: true },
      { kind: "code" as const, src: "a:c.ts:1", at: AT, cross: true },
      { kind: "code" as const, src: "a:d.ts:1", at: AT, cross: true },
    ];
    expect(competencyLevel([...crossed, run], NOW)).toBe(4);
    expect(competencyLevel([...crossed.map(({ cross: _drop, ...row }) => row), run], NOW)).toBe(3);
  });

  test("recency is continuous and floored at a quarter", () => {
    expect(recency(0)).toBe(1);
    expect(recency(365)).toBe(0.25);
    expect(recency(4000)).toBe(0.25);
    expect(recency(182.5)).toBeCloseTo(0.5, 5);
  });

  test("`cross` and `confidence` round-trip through the evidence reader", () => {
    const rows = readEvidenceRows([
      { kind: "code", src: "a:b.ts:1", at: AT, cross: true, confidence: "assumed" },
      { kind: "code", src: "a:c.ts:1", at: AT },
      { kind: "code", src: "a:d.ts:1", at: AT, confidence: "nonsense" },
    ]);
    expect(rows.ignored).toEqual([]);
    expect(rows.evidence[0]).toEqual({ kind: "code", src: "a:b.ts:1", at: AT, cross: true, confidence: "assumed" });
    // Additive: a row written before either field existed carries neither.
    expect(rows.evidence[1]).toEqual({ kind: "code", src: "a:c.ts:1", at: AT });
    // An unrecognised confidence changes a weight, it is not a citation: dropped, not refused.
    expect(rows.evidence[2]).toEqual({ kind: "code", src: "a:d.ts:1", at: AT });
  });

  test("`## Sources` derives no evidence and is not counted as findings", () => {
    const ws = workspace();
    const recap = [
      `# ${AREA} — ${EXPERT}`,
      "",
      "## Invariants",
      "",
      "- An empty code is refused before any request [src: api:src/auth/oauth.ts:7]",
      "",
      "## Entry points",
      "",
      "- `exchange()` is the only way in [src: api:src/auth/oauth.ts:6]",
      "",
      "## Business rules",
      "",
      "- The token lands in the shared store [src: api:src/auth/token.ts:5]",
      "",
      "## Gotchas",
      "",
      "- There is no refresh path at all [src: absent:api/src/auth/refresh.ts]",
      "",
      "## Sources",
      "",
      "- `hunts/next.ts` is where the caller lives [src: api:src/hunts/next.ts:1]",
      "",
    ].join("\n");

    const parsed = parseKnowledgeFile(recap, ctxOf(ws), LIGHT_SHAPE);
    expect(parsed.ok).toBe(true);
    // The recap's bullet is validated like any other — but derives nothing.
    expect(codeEvidence(parsed.bullets, AT).map((row) => row.src)).not.toContain("api:src/hunts/next.ts:1");
    // Two rows, not three: `codeEvidence` is one row per distinct FILE, and the
    // `absent:` gotcha earns nothing at all.
    expect(codeEvidence(parsed.bullets, AT)).toHaveLength(2);
    // And `countFindings` stops counting it as a finding.
    expect(countFindings(recap)).toBe(4);
  });
});

// --- O7: structured confidence ----------------------------------------------

describe("a bullet's confidence reaches the evidence row", () => {
  test("it is parsed off the bullet, tolerating absence", () => {
    expect(confidenceOf("- A is B (measured) [src: a:b.ts:1]", "[src: a:b.ts:1]")).toBe("measured");
    expect(confidenceOf("- A is B (inferred: from the order) [src: a:b.ts:1]", "[src: a:b.ts:1]")).toBe("inferred");
    expect(confidenceOf("- A is B (assumed) [src: a:b.ts:1]", "[src: a:b.ts:1]")).toBe("assumed");
    expect(confidenceOf("- A is B [src: a:b.ts:1]", "[src: a:b.ts:1]")).toBeNull();
    expect(confidenceOf("- A (measured) is B [src: a:b.ts:1]", "[src: a:b.ts:1]")).toBeNull();
  });

  test("it is written into competencies.yml, and an `assumed` row weighs half", async () => {
    const ws = workspace();
    fakeClaude(ws, [{
      [KNOWLEDGE_WRITE]: knowledgeWith([
        "- Nothing refreshes the token, so a caller must re-run the exchange (assumed) [src: api:src/auth/oauth.ts:7]",
      ]),
    }]);
    const outcome = await train(ws);
    expect(outcome.code).toBe(0);

    const doc = parseYaml(readFileSync(join(ws.expertDir, "competencies.yml"), "utf8")) as {
      areas: { id: string; evidence: Record<string, unknown>[] }[];
    };
    const area = doc.areas.find((row) => row.id === AREA);
    const row = area?.evidence.find((item) => item.src === "api:src/auth/oauth.ts:7");
    expect(row?.confidence).toBe("assumed");
    // Every other row carries no `confidence` key at all.
    expect(area?.evidence.some((item) => !("confidence" in item))).toBe(true);
  });

  test("a bullet citing two distinct files is written as `cross: true`", () => {
    const ws = workspace();
    const parsed = parseKnowledgeFile(
      knowledgeWith([
        "- `exchange()` writes straight into the store, so a change to either file breaks the other "
        + "(inferred) [src: api:src/auth/oauth.ts:9; api:src/auth/token.ts:5]",
      ]),
      ctxOf(ws), LIGHT_SHAPE,
    );
    expect(parsed.ok).toBe(true);
    const rows = codeEvidence(parsed.bullets, "2026-09-01");
    const crossed = rows.filter((row) => row.cross === true);
    expect(crossed).toHaveLength(2);
    expect(crossed.every((row) => row.confidence === "inferred")).toBe(true);
  });
});

// --- O2: the prompts ask for value, not breadth -----------------------------

describe("the training prompts ask for findings rather than file coverage", () => {
  test("the spawned prompt drops the breadth reward and states the criterion", async () => {
    const ws = domainWorkspace();
    const outcome = await train(ws, { run: "prepare" });
    expect(outcome.code).toBe(0);
    const prompt = readFileSync(
      join(trainingCacheDir(ws.root, EXPERT, AREA), ".agent", "code", "prompt.md"),
      "utf8",
    );

    expect(prompt).not.toContain("reading twelve files is worth twelve");
    expect(prompt).toContain("could not re-derive by reading");
    expect(prompt).toContain("A bullet citing two or more DISTINCT files counts double");
    expect(prompt).toContain("restating a docstring");
    expect(prompt).toContain("(measured)");
    // The rule that refused a real $1.69 run is now TAUGHT: the literal shapes, a
    // conforming line, a refused line, and the `(measured)` annotation trap.
    expect(prompt).toContain("A claim about a RESULT needs a COMMAND, not a file line");
    expect(prompt).toContain("Write this:");
    expect(prompt).toContain("Never this:");
    expect(prompt).toContain(".tldrx/workspace.yml:19");
    expect(prompt).toContain("stripped before the check");
    // …and it names the boundary the pre-pass actually applied.
    expect(prompt).toContain("Domain boundary");
    expect(prompt).toContain("`src/auth`");
  });

  test("`--print-prompt` says the same thing, word for word where it matters", () => {
    const ws = domainWorkspace();
    const expert = loadExpert(ws.root, EXPERT, TRAIN_NOW);
    const printed = renderTrainPrompt({
      expert,
      document: { exists: true, path: join(ws.root, ".tldrx/experts", EXPERT, "expert.md"), frontMatter: new Map(), body: "" },
      area: expert.areas[0]!,
      mode: "light",
      repos: [{ name: "api", path: "api" }],
    });
    expect(printed).toContain("could not re-derive by reading that one file once");
    expect(printed).not.toContain("reading twelve files is worth twelve");
    expect(printed).toContain("worth double (`cross: true`, spec §2.6)");
    expect(printed).toContain("`(measured)`, `(inferred)` or `(assumed)`");
    // Both prompts show the same counter-example: a `workspace.yml` line DECLARES a
    // command, which is not a record of running it.
    expect(printed).toContain("is not a record of running it");
    expect(printed).toContain("[src: $ npm test → exit 0]");
    expect(printed).toContain("refused WHOLE");
  });
});

// --- O6: two experts, one line, two sentences -------------------------------

describe("a shared citation is reported, never resolved", () => {
  function withKnowledge(a: string, b: string): TrainingWorkspace {
    return domainWorkspace({
      [`.tldrx/experts/${EXPERT}/knowledge/${AREA}.md`]: [
        "## Invariants", "", a, "",
      ].join("\n"),
      ".tldrx/experts/hunts-expert/knowledge/hunts.md": [
        "## Invariants", "", b, "",
      ].join("\n"),
    });
  }

  test("two experts saying different things about one line earn one warning", () => {
    const ws = withKnowledge(
      "- The exchange stores the token synchronously [src: api:src/auth/oauth.ts:9]",
      "- The exchange never touches the store on this path [src: api:src/auth/oauth.ts:9]",
    );
    const shared = sharedCitations(ws.root, loadExperts(ws.root, TRAIN_NOW));
    expect(shared).toEqual([{ src: "api:src/auth/oauth.ts:9", experts: [EXPERT, "hunts-expert"] }]);
    expect(sharedCitationWarnings(shared)).toEqual([
      `warning: shared citation api:src/auth/oauth.ts:9 by ${EXPERT},hunts-expert — check for contradiction`,
    ]);
  });

  test("the same sentence twice is agreement, and is not reported", () => {
    const ws = withKnowledge(
      "- The exchange stores the token synchronously [src: api:src/auth/oauth.ts:9]",
      "- The exchange stores the token, synchronously. [src: api:src/auth/oauth.ts:9]",
    );
    expect(sharedCitations(ws.root, loadExperts(ws.root, TRAIN_NOW))).toEqual([]);
  });

  test("one expert citing one line twice is not a shared citation", () => {
    const ws = domainWorkspace({
      [`.tldrx/experts/${EXPERT}/knowledge/${AREA}.md`]: [
        "## Invariants",
        "",
        "- The exchange stores the token [src: api:src/auth/oauth.ts:9]",
        "- Nothing else writes to the store [src: api:src/auth/oauth.ts:9]",
        "",
      ].join("\n"),
    });
    expect(sharedCitations(ws.root, loadExperts(ws.root, TRAIN_NOW))).toEqual([]);
  });
});

// --- O4: the Build feedback reaches a role expert ---------------------------

describe("retro.md carries the gates back to the experts", () => {
  const RUN = "260820-oauth";

  function outcome(overrides: Partial<StoryOutcome> = {}): StoryOutcome {
    return {
      id: "S1", title: "First story", wave: "w1", repo: "api", epic: "E1",
      epicBranch: "epic/e1", branch: "story/S1", status: "review", attempts: 1,
      dod: [{ command: "npm run test", exitCode: 1, timedOut: false, tail: "1 failing" }],
      commit: null, merged: false, carried: null, conflicts: [], verdict: "changes", developerError: null,
      reviewSummary: "the acceptance criteria are not met yet", reviewFindings: ["no test for the empty code"],
      reviewRel: "04-build/log/S1.md", reason: null, cost_usd: 0.4, ...overrides,
    };
  }

  test("a story's push-back becomes sourced bullets, deduped on a second write", () => {
    const ws = workspace();
    const runDir = join(ws.root, "tldrx-work", RUN);
    const lines = storyRetroLines(outcome(), RUN);
    expect(lines.some((line) => line.includes("asked for CHANGES on attempt 1"))).toBe(true);
    expect(lines.some((line) => line.includes("reviewer finding: no test for the empty code"))).toBe(true);
    expect(lines.some((line) => line.includes("dod `npm run test` exited 1 on the first attempt"))).toBe(true);
    expect(lines.every((line) => line.endsWith(`[src: tldrx-work/${RUN}/04-build/log/S1.md:1]`))).toBe(true);

    expect(appendBuildRetro(runDir, lines)).toHaveLength(lines.length);
    expect(appendBuildRetro(runDir, lines)).toEqual([]);
    const text = readFileSync(join(runDir, "retro.md"), "utf8");
    expect(text).toContain("## Build feedback");
    expect(extractBuildSection(text).split("\n")).toHaveLength(lines.length);
  });

  test("a second attempt's dod failure is not reported as a first-attempt one", () => {
    expect(storyRetroLines(outcome({ attempts: 2, verdict: "n-a" }), RUN)).toEqual([]);
  });

  test("gate rejections and revocations are recovered from events.jsonl", () => {
    const ws = workspace();
    const runDir = join(ws.root, "tldrx-work", RUN);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "events.jsonl"), [
      JSON.stringify({
        ts: "2026-08-29T10:00:00Z", run: RUN, stage: "build", type: "stage.done",
        actor: "tldrx", cost_usd: 0, payload: {},
      }),
      JSON.stringify({
        ts: "2026-08-29T11:00:00Z", run: RUN, stage: "build", type: "gate.rejected",
        actor: "alan", cost_usd: 0, payload: { phase: "04-build", note: "the epic is not reviewable", from: "awaiting_gate" },
      }),
      JSON.stringify({
        ts: "2026-08-29T12:00:00Z", run: RUN, stage: "contracts", type: "gate.revoked",
        actor: "alan", cost_usd: 0,
        payload: { phase: "02-how", note: "the contract was wrong", signed_by: "auto", staled: ["04-build/build"] },
      }),
      "{ this line is torn",
      "",
    ].join("\n"), "utf8");

    const lines = gateRetroLines(runDir, RUN);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("gate REJECTED by alan: the epic is not reviewable");
    expect(lines[0]).toContain(`[src: tldrx-work/${RUN}/events.jsonl:2]`);
    expect(lines[1]).toContain("approval REVOKED by alan (signed by auto)");
    expect(lines[1]).toContain("stale: `04-build/build`");
    expect(lines[1]).toContain(`[src: tldrx-work/${RUN}/events.jsonl:3]`);
  });

  test("a role expert trained after such a run earns `run` evidence citing retro.md", async () => {
    const ROLE = "delivery";
    const ROLE_REL = `.tldrx/experts/${ROLE}/knowledge/from-runs-${ROLE}.md`;
    const ws = workspace({
      files: {
        [`.tldrx/experts/${ROLE}/expert.md`]: [
          "---", `name: ${ROLE}`, "kind: role", "status: created",
          'created_by: "tldrx init"', "created_at: 2026-08-28T14:02:11Z", "repos: [api]", "---",
          "", `# ${ROLE}`, "", "## Role", "", "You sequence the work.", "",
        ].join("\n"),
        [`.tldrx/experts/${ROLE}/competencies.yml`]: [
          "version: 1", `expert: ${ROLE}`, "status: created", "last_trained: null", "areas:",
          `  - id: ${ROLE}`, "    title: Delivery sequencing", "    level: 0",
          `    train_prompt: tldrx expert train ${ROLE} --area ${ROLE} --mode full`, "    evidence: []", "",
        ].join("\n"),
      },
    });

    // The Build executor's own writer produces the file — not a hand-written
    // fixture, so this test breaks if the two ever disagree.
    const runDir = join(ws.root, "tldrx-work", RUN);
    appendBuildRetro(runDir, storyRetroLines(outcome(), RUN));
    const retro = readFileSync(join(runDir, "retro.md"), "utf8").split("\n");
    const cited = retro.findIndex((line) => line.includes("asked for CHANGES")) + 1;
    expect(cited).toBeGreaterThan(0);

    // What `mineRuns` inlines is what the sub-agent may cite, so cite that line.
    fakeClaude(ws, [{
      [`${ROLE_REL}.partial`]: [
        `# ${ROLE} — from past runs`,
        "",
        "## Recurring decisions",
        "",
        "- A reviewer's `changes` verdict is what sends a story round again, not a failing check "
        + `(measured) [src: tldrx-work/${RUN}/retro.md:${String(cited)}]`,
        "",
        "## Recurring patterns",
        "",
        "- none [src: absent:tldrx-work]",
        "",
        "## Sources",
        "",
        "One retro, written by the Build executor.",
        "",
      ].join("\n"),
    }]);

    const trained = await runTraining({
      root: ws.root, expert: ROLE, area: ROLE, mode: "full", run: "headless",
      actor: "alan", at: TRAIN_AT, now: TRAIN_NOW, timeoutMs: 20_000,
      ambientModel: null,
    });
    expect(trained.code).toBe(0);

    const doc = parseYaml(readFileSync(join(ws.root, ".tldrx/experts", ROLE, "competencies.yml"), "utf8")) as {
      areas: { evidence: Record<string, unknown>[] }[];
    };
    const rows = doc.areas[0]?.evidence ?? [];
    expect(rows).toContainEqual({
      kind: "run",
      src: `tldrx-work/${RUN}/retro.md:${String(cited)}`,
      at: "2026-09-01",
      confidence: "measured",
    });
    expect(existsSync(join(ws.root, ROLE_REL))).toBe(true);
  });

  test("`runEvidence` mints a run row from a retro citation and nothing from an absent one", () => {
    const ws = workspace();
    const parsed = parseKnowledgeFile(
      [
        "# from past runs",
        "",
        "## Recurring decisions",
        "",
        `- The team keeps re-cutting the epic branch [src: tldrx-work/${RUN}/retro.md:1]`,
        "",
        "## Recurring patterns",
        "",
        "- none [src: absent:tldrx-work]",
        "",
        "## Sources",
        "",
        "One retro.",
        "",
      ].join("\n"),
      emptySrcContext(ws.root), RUNS_SHAPE,
    );
    expect(parsed.ok).toBe(true);
    expect(runEvidence(parsed.bullets, "2026-09-01")).toEqual([
      { kind: "run", src: `tldrx-work/${RUN}/retro.md:1`, at: "2026-09-01" },
    ]);
  });
});
