/**
 * `tldrx expert train` (concept §6, spec §2.6).
 *
 * What every test here is really guarding: **a level moves only on evidence.**
 * The sub-agent is faked — it is the only part that costs money — but everything
 * that decides whether a level changes is real: real files with real line counts,
 * the real `[src: …]` grammar, the real §2.6 formula. A fake that could talk its
 * way to level 3 would be the bug.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseYaml } from "../src/core/yaml.ts";
import { buildModel } from "../src/core/dashboard/model.ts";
import { loadExpert, loadExperts, renderExpertList, expertListJson } from "../src/core/experts/index.ts";
import { emptySrcContext } from "../src/core/text/srcToken.ts";
import { toSrcContext, loadWorkspace } from "../src/hooks/lib/workspace.ts";
import { competencyLevel } from "../src/core/init/competencyLevel.ts";
import {
  runTraining, selectFiles, keywordsFor, mineRuns, relevantFacts, parseKnowledgeFile,
  codeEvidence, runEvidence, mergeEvidence, LIGHT_SHAPE, RUNS_SHAPE, TrainingLog,
  trainingCacheDir, expertRepos, MIN_TRAIN_USD, DEFAULT_TRAIN_USD, DEFAULT_TRAIN_EFFORT, withGutter,
  isRoleExpertOnDisk, lightModeRefusal, nothingToMineRefusal,
  type TrainOptions,
} from "../src/core/training/index.ts";
import { allowedTools } from "../src/core/facilitator/spawnAgent.ts";
import { FactsStore } from "../src/core/facts/FactsStore.ts";
import { factsPath } from "../src/hooks/lib/workspace.ts";
import {
  makeTrainingWorkspace, knowledgeMd, fromRunsMd, AREA, EXPERT, TRAIN_AT, TRAIN_NOW,
  type TrainingWorkspace, type TrainingWorkspaceOptions,
} from "./fixtures/training/workspace.ts";

const ORIGINAL_PATH = process.env.PATH ?? "";
const FAKE_KEYS = [
  "FAKE_TRAIN_ROOT", "FAKE_TRAIN_OUTPUTS", "FAKE_TRAIN_COST", "FAKE_TRAIN_STATE",
  "FAKE_TRAIN_IS_ERROR", "FAKE_TRAIN_PROMPT_DIR", "FAKE_TRAIN_ARGV_LOG",
] as const;

let open: TrainingWorkspace[] = [];

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  for (const key of FAKE_KEYS) delete process.env[key];
  for (const ws of open) ws.dispose();
  open = [];
});

const KNOWLEDGE_REL = `.tldrx/experts/${EXPERT}/knowledge/${AREA}.md`;
const FROM_RUNS_REL = `.tldrx/experts/${EXPERT}/knowledge/from-runs-${AREA}.md`;
/**
 * Where a sub-agent is told to write (wave Q): `<name>.md.partial`, renamed onto
 * the real name only once the file validates. `knowledge/*.md` is what gets
 * inlined into later prompts, so a half-written file must never wear that name.
 */
const KNOWLEDGE_WRITE = `${KNOWLEDGE_REL}.partial`;
const FROM_RUNS_WRITE = `${FROM_RUNS_REL}.partial`;

function workspace(options: TrainingWorkspaceOptions = {}): TrainingWorkspace {
  const made = makeTrainingWorkspace(options);
  open.push(made);
  return made;
}

/** Put the fake first (and only) on PATH, and tell it what to write per call. */
function fakeClaude(ws: TrainingWorkspace, plans: readonly Record<string, string>[], cost = "0.37"): void {
  process.env.PATH = ws.binDir;
  process.env.FAKE_TRAIN_ROOT = ws.root;
  process.env.FAKE_TRAIN_STATE = ws.statePath;
  process.env.FAKE_TRAIN_OUTPUTS = JSON.stringify(plans);
  process.env.FAKE_TRAIN_COST = cost;
}

function train(ws: TrainingWorkspace, overrides: Partial<TrainOptions> = {}) {
  return runTraining({
    root: ws.root,
    expert: EXPERT,
    area: AREA,
    mode: "light",
    run: "headless",
    actor: "alan",
    at: TRAIN_AT,
    now: TRAIN_NOW,
    timeoutMs: 20_000,
    ...overrides,
  });
}

function competencies(ws: TrainingWorkspace): Record<string, unknown> {
  return parseYaml(readFileSync(join(ws.expertDir, "competencies.yml"), "utf8")) as Record<string, unknown>;
}

function areaOf(ws: TrainingWorkspace, id: string): Record<string, unknown> {
  const areas = competencies(ws).areas as Record<string, unknown>[];
  const found = areas.find((area) => area.id === id);
  if (found === undefined) throw new Error(`no area ${id}`);
  return found;
}

// --- the deterministic pre-pass ---------------------------------------------

describe("the pre-pass picks the files, not the model", () => {
  test("keywords are the area id first, then the words of its title", () => {
    expect(keywordsFor("oauth", "OAuth authorisation code exchange"))
      .toEqual(["oauth", "authorisation", "code", "exchange"]);
  });

  test("a hyphenated id contributes the whole id and its parts", () => {
    expect(keywordsFor("google-maps-sdk", "Google Maps SDK usage"))
      .toEqual(["google-maps-sdk", "google", "maps", "sdk", "usage"]);
  });

  test("stopwords and two-letter words never become keywords", () => {
    expect(keywordsFor("ef-core", "The way it is used with and for this workspace"))
      .toEqual(["ef-core", "core"]);
  });

  test("only the expert's own repos are scanned, and unrelated files score zero", async () => {
    const ws = workspace();
    const selection = await selectFiles({
      root: ws.root,
      repos: [{ name: "api", path: "api" }],
      areaId: AREA,
      areaTitle: "OAuth authorisation code exchange",
    });
    const picked = selection.inlined.map((file) => `${file.repo}:${file.path}`);
    expect(picked).toContain("api:src/auth/oauth.ts");
    expect(picked).toContain("api:src/auth/token.ts");
    // `src/hunts/next.ts` is cited by domains.md, but nothing in it matches an
    // `oauth` keyword — the map re-ranks, it does not qualify.
    expect(picked).not.toContain("api:src/hunts/next.ts");
    expect(picked.every((path) => path.startsWith("api:"))).toBe(true);
  });

  test("a file cited by domains.md is scored for it, and the reason is recorded", async () => {
    const ws = workspace();
    const selection = await selectFiles({
      root: ws.root,
      repos: [{ name: "api", path: "api" }],
      areaId: AREA,
      areaTitle: "OAuth authorisation code exchange",
    });
    const oauth = selection.inlined.find((file) => file.path === "src/auth/oauth.ts");
    expect(oauth?.why.join(" ")).toContain("cited in domains.md");
    expect(selection.domainLines.some((line) => line.includes("src/auth/"))).toBe(true);
  });

  test("no graphify graph is reported as an absence, never as an empty result", async () => {
    const ws = workspace();
    const selection = await selectFiles({
      root: ws.root,
      repos: [{ name: "api", path: "api" }],
      areaId: AREA,
      areaTitle: "OAuth authorisation code exchange",
    });
    expect(selection.graphNotes.join(" ")).toContain("no graphify graph");
  });

  test("`expert.md` front matter decides the repos", () => {
    const ws = workspace();
    const repos = expertRepos(ws.root, EXPERT, loadWorkspace(ws.root).repos);
    expect(repos.map((repo) => repo.name)).toEqual(["api"]);
  });

  test("the gutter is what a citation's line number refers to", () => {
    expect(withGutter("a\nb\nc")).toBe("1| a\n2| b\n3| c");
  });
});

// --- the knowledge contract --------------------------------------------------

describe("a knowledge file is accepted or rejected whole", () => {
  test("the canned file validates, and its citations resolve", () => {
    const ws = workspace();
    const ctx = toSrcContext(loadWorkspace(ws.root), null);
    const parsed = parseKnowledgeFile(knowledgeMd(), ctx, LIGHT_SHAPE);
    expect(parsed.issues).toEqual([]);
    expect(parsed.ok).toBe(true);
    expect(parsed.items.get("Invariants")).toBe(1);
  });

  test("one unsourced item fails the whole file", () => {
    const ws = workspace();
    const ctx = toSrcContext(loadWorkspace(ws.root), null);
    const parsed = parseKnowledgeFile(knowledgeMd({ extraItem: "- Tokens never expire" }), ctx, LIGHT_SHAPE);
    expect(parsed.ok).toBe(false);
    expect(parsed.issues[0]?.message).toContain("no `[src: …]` token");
  });

  test("a citation past the end of its file is rejected with the line count", () => {
    const ws = workspace();
    const ctx = toSrcContext(loadWorkspace(ws.root), null);
    const parsed = parseKnowledgeFile(
      knowledgeMd({ extraItem: "- Invented [src: api:src/auth/oauth.ts:9999]" }), ctx, LIGHT_SHAPE);
    expect(parsed.ok).toBe(false);
    expect(parsed.issues.map((issue) => issue.message).join(" ")).toContain("cited line 9999");
  });

  test("a missing section is an issue even when everything present is sourced", () => {
    const text = knowledgeMd().replace("## Gotchas", "## Notes");
    const parsed = parseKnowledgeFile(text, emptySrcContext("/nowhere"), LIGHT_SHAPE);
    expect(parsed.issues.some((issue) => issue.message.includes("missing `## Gotchas`"))).toBe(true);
  });

  test("`absent:` is a finding and earns no evidence", () => {
    const ws = workspace();
    const ctx = toSrcContext(loadWorkspace(ws.root), null);
    const parsed = parseKnowledgeFile(knowledgeMd(), ctx, LIGHT_SHAPE);
    const evidence = codeEvidence(parsed.refs, "2026-09-01");
    expect(evidence.some((item) => item.src.startsWith("absent:"))).toBe(false);
  });

  test("two lines of one file are one evidence row; two files are two", () => {
    const ws = workspace();
    const ctx = toSrcContext(loadWorkspace(ws.root), null);
    const twoLines = parseKnowledgeFile(knowledgeMd({ secondFile: false }), ctx, LIGHT_SHAPE);
    expect(codeEvidence(twoLines.refs, "2026-09-01")).toHaveLength(1);
    const twoFiles = parseKnowledgeFile(knowledgeMd(), ctx, LIGHT_SHAPE);
    expect(codeEvidence(twoFiles.refs, "2026-09-01")).toHaveLength(2);
  });

  test("evidence merges by src, and the level is the formula's answer", () => {
    const existing = [{ kind: "code", src: "api:src/auth/oauth.ts:7", at: "2026-08-25" }] as const;
    const merged = mergeEvidence(existing, [
      { kind: "code", src: "api:src/auth/oauth.ts:7", at: "2026-09-01" },
      { kind: "code", src: "api:src/auth/token.ts:5", at: "2026-09-01" },
    ], TRAIN_NOW);
    expect(merged.added).toHaveLength(1);
    expect(merged.evidence).toHaveLength(2);
    expect(merged.levelBefore).toBe(1);
    expect(merged.levelAfter).toBe(competencyLevel(merged.evidence, TRAIN_NOW));
    expect(merged.levelAfter).toBe(2);
  });
});

// --- a command that was run is a `run` row -----------------------------------

/**
 * The gap wave E left: the ladder gates level 4 on a `kind: run` row, and the
 * light-mode path could not produce one, because `codeEvidence` mapped `file`,
 * `doc` and `fact` and silently dropped every `cmd` ref. `--mode light` was
 * therefore capped at 3 by construction, whatever the sub-agent measured.
 *
 * The fixture workspace declares `build: "true"` and `test: "true"`, so `true` is
 * the only command a `cmd` src may name here — which is the point of the last
 * test in this block.
 */
describe("a cited command becomes evidence that something was executed", () => {
  test("`$ cmd → exit n` produces a `kind: run` row carrying the command and the exit code", () => {
    const ws = workspace();
    const ctx = toSrcContext(loadWorkspace(ws.root), null);
    const parsed = parseKnowledgeFile(
      knowledgeMd({ extraItem: "- The suite is green on this [src: $ true → exit 0]" }), ctx, LIGHT_SHAPE);
    expect(parsed.ok).toBe(true);

    const evidence = codeEvidence(parsed.refs, "2026-09-01");
    expect(evidence).toContainEqual({ kind: "run", src: "$ true → exit 0", at: "2026-09-01" });
  });

  test("that row is what lifts a light run past the §2.6 run cap of 3", () => {
    const ws = workspace();
    const ctx = toSrcContext(loadWorkspace(ws.root), null);
    const reading = parseKnowledgeFile(knowledgeMd(), ctx, LIGHT_SHAPE);
    // Reading alone: two files, W = 2.0 -> thresholds say 2, and the run cap is
    // not even reached. The cap bites once enough files are read to pass 6.
    expect(codeEvidence(reading.refs, "2026-09-01").some((row) => row.kind === "run")).toBe(false);

    const measured = parseKnowledgeFile(
      knowledgeMd({ extraItem: "- The suite is green on this [src: $ true → exit 0]" }), ctx, LIGHT_SHAPE);
    const rows = [
      ...codeEvidence(measured.refs, "2026-09-01"),
      // Six more files read, so the weight sum clears the level-4 threshold and
      // only the run cap is left deciding.
      ...Array.from({ length: 6 }, (_, i) => (
        { kind: "code" as const, src: `api:src/f${String(i)}.ts:1`, at: "2026-09-01" }
      )),
    ];
    expect(competencyLevel(rows, TRAIN_NOW)).toBe(4);
    expect(competencyLevel(rows.filter((row) => row.kind !== "run"), TRAIN_NOW)).toBe(3);
  });

  test("one row per distinct command+exit — the same command twice is one row", () => {
    const ws = workspace();
    const ctx = toSrcContext(loadWorkspace(ws.root), null);
    const twice = parseKnowledgeFile(knowledgeMd({
      extraItem: "- Green here [src: $ true → exit 0]\n- And green here too [src: $ true → exit 0]",
    }), ctx, LIGHT_SHAPE);
    expect(codeEvidence(twice.refs, "2026-09-01").filter((row) => row.kind === "run")).toHaveLength(1);

    const twoExits = parseKnowledgeFile(knowledgeMd({
      extraItem: "- Green [src: $ true → exit 0]\n- Red on the empty code [src: $ true → exit 1]",
    }), ctx, LIGHT_SHAPE);
    const runs = codeEvidence(twoExits.refs, "2026-09-01").filter((row) => row.kind === "run");
    expect(runs.map((row) => row.src).sort()).toEqual(["$ true → exit 0", "$ true → exit 1"]);
  });

  test("a command workspace.yml does not declare is still rejected, and takes the whole file", () => {
    const ws = workspace();
    const ctx = toSrcContext(loadWorkspace(ws.root), null);
    const parsed = parseKnowledgeFile(
      knowledgeMd({ extraItem: "- Invented [src: $ npm run invent → exit 0]" }), ctx, LIGHT_SHAPE);
    expect(parsed.ok).toBe(false);
    expect(parsed.issues.map((issue) => issue.message).join(" "))
      .toContain("is not one of workspace.yml's commands");
  });

  test("end to end: a light run that cites a command writes the `run` row to competencies.yml", async () => {
    const ws = workspace();
    fakeClaude(ws, [{
      [KNOWLEDGE_WRITE]: knowledgeMd({ extraItem: "- The suite is green on this [src: $ true → exit 0]" }),
    }]);

    const outcome = await train(ws);
    expect(outcome.code).toBe(0);
    const evidence = areaOf(ws, AREA).evidence as { kind: string; src: string; at: string }[];
    expect(evidence).toContainEqual({ kind: "run", src: "$ true → exit 0", at: "2026-09-01" });
  });
});

// --- what the sub-agent is told it may run -----------------------------------

/**
 * The prompt used to say "do not run anything" while `allowedTools` was already
 * handing the sub-agent a `Bash(<command>)` for every command in
 * `workspace.yml`. These tests hold the two halves together: whatever the prompt
 * says about running is checked against the grant the argv actually carries.
 */
describe("the prompt and the tool grant say the same thing", () => {
  /** A workspace.yml identical to the fixture's, with every command nulled out. */
  const NO_COMMANDS = `version: 1
mode: multi-repo
root_is_repo: true
detected_at: 2026-08-28T14:02:11Z
detected_by: "tldrx 0.2.0"
repos:
  - name: api
    path: api
    default_branch: main
    stack: [typescript]
    package_manager: npm
    commands: {build: null, test: null, lint: null, typecheck: null, run: null}
    ci: []
    confidence: high
`;

  async function promptOf(ws: TrainingWorkspace): Promise<string> {
    const promptDir = join(ws.root, "prompts");
    process.env.FAKE_TRAIN_PROMPT_DIR = promptDir;
    await train(ws);
    return readFileSync(join(promptDir, "prompt-0.md"), "utf8");
  }

  test("it names the declared commands, and forbids everything else", async () => {
    const ws = workspace();
    fakeClaude(ws, [{ [KNOWLEDGE_WRITE]: knowledgeMd() }]);
    const prompt = await promptOf(ws);

    expect(prompt).toContain("You may run ONLY the commands `.tldrx/workspace.yml` declares");
    expect(prompt).toContain("`true`");
    expect(prompt).toContain("no installs");
    expect(prompt).toContain("Do not modify product code");
    // The old blanket ban is gone: it contradicted the grant and cost every
    // training run its only route to a `run` row.
    expect(prompt).not.toContain("do not run anything");
  });

  test("it says citing the command is the only way to earn a `run` row", async () => {
    const ws = workspace();
    fakeClaude(ws, [{ [KNOWLEDGE_WRITE]: knowledgeMd() }]);
    const prompt = await promptOf(ws);

    expect(prompt).toContain("[src: $ <cmd> → exit <n>]");
    expect(prompt).toContain("levels 4 and 5");
    expect(prompt).toContain("Reading alone stops at level 3.");
  });

  test("with no declared command it says so, and that level 3 is the honest ceiling", async () => {
    const ws = workspace({ files: { ".tldrx/workspace.yml": NO_COMMANDS } });
    fakeClaude(ws, [{ [KNOWLEDGE_WRITE]: knowledgeMd() }]);
    const prompt = await promptOf(ws);

    expect(prompt).toContain("**Do not run anything.**");
    expect(prompt).toContain("declares no command");
    expect(prompt).toContain("This run cannot go past level 3, and that is correct.");
    expect(prompt).not.toContain("You may run ONLY");
  });

  test("the argv grants exactly the base tools plus those commands, and nothing more", async () => {
    const ws = workspace();
    fakeClaude(ws, [{ [KNOWLEDGE_WRITE]: knowledgeMd() }]);
    const argvLog = join(ws.root, "argv.log");
    process.env.FAKE_TRAIN_ARGV_LOG = argvLog;

    await train(ws);
    const argv = JSON.parse(readFileSync(argvLog, "utf8").trim()) as string[];
    const granted = argv[argv.indexOf("--allowedTools") + 1] ?? "";
    // Both repos declare `build: "true"` and `test: "true"`, so the flat set is
    // one command — and the prompt above names that same one.
    expect(granted).toBe(allowedTools(["true"]).join(","));
    expect(granted).toBe("Read,Write,Edit,Glob,Grep,Bash(true)");
  });
});

// --- light mode, end to end --------------------------------------------------

describe("light training", () => {
  test("validates the file, appends evidence, recomputes the level and stamps the expert", async () => {
    const ws = workspace();
    fakeClaude(ws, [{ [KNOWLEDGE_WRITE]: knowledgeMd() }]);

    const outcome = await train(ws);
    expect(outcome.code).toBe(0);
    expect(existsSync(join(ws.root, KNOWLEDGE_REL))).toBe(true);

    const area = areaOf(ws, AREA);
    const evidence = area.evidence as { kind: string; src: string; at: string }[];
    expect(evidence.map((item) => item.src).sort())
      .toEqual(["api:src/auth/oauth.ts:7", "api:src/auth/token.ts:5"]);
    expect(evidence.every((item) => item.kind === "code")).toBe(true);
    expect(evidence.every((item) => item.at === "2026-09-01")).toBe(true);
    // Two fresh `code` rows: W = 2.0 -> level 2, and distinct sources = 2.
    expect(area.level).toBe(2);

    const doc = competencies(ws);
    expect(doc.status).toBe("in-use");
    expect(doc.last_trained).toBe(TRAIN_AT);
    expect(outcome.costUsd).toBe(0.37);
    expect(outcome.lines.join("\n")).toContain("level 0 → 2");
  });

  test("the sub-agent is given the pre-pass's files and told what it may write", async () => {
    const ws = workspace();
    fakeClaude(ws, [{ [KNOWLEDGE_WRITE]: knowledgeMd() }]);
    const promptDir = join(ws.root, "prompts");
    process.env.FAKE_TRAIN_PROMPT_DIR = promptDir;

    await train(ws);
    const prompt = readFileSync(join(promptDir, "prompt-0.md"), "utf8");
    expect(prompt).toContain("api:src/auth/oauth.ts");
    expect(prompt).toContain(`Write exactly ONE file: \`${KNOWLEDGE_WRITE}\``);
    // The expert's own body travels with the prompt.
    expect(prompt).toContain(`<!-- expert: ${EXPERT} -->`);
  });

  test("re-running adds nothing when the same file is cited again — the level does not drift up", async () => {
    const ws = workspace();
    fakeClaude(ws, [{ [KNOWLEDGE_WRITE]: knowledgeMd() }]);
    await train(ws);
    const first = areaOf(ws, AREA).level;

    await train(ws, { at: "2026-09-02T12:00:00Z", now: new Date("2026-09-02T12:00:00Z") });
    const area = areaOf(ws, AREA);
    expect((area.evidence as unknown[]).length).toBe(2);
    expect(area.level).toBe(first);
    expect(competencies(ws).last_trained).toBe("2026-09-02T12:00:00Z");
  });

  test("an untrained area's level is recomputed too, never left as it was written", async () => {
    const ws = workspace();
    fakeClaude(ws, [{ [KNOWLEDGE_WRITE]: knowledgeMd() }]);
    // A hand-set level on an area training does not touch.
    const path = join(ws.expertDir, "competencies.yml");
    writeFileSync(path, readFileSync(path, "utf8").replace("title: session handling\n    level: 0", "title: session handling\n    level: 5"), "utf8");

    await train(ws);
    expect(areaOf(ws, "sessions").level).toBe(0);
  });

  test("the run is recorded in training.jsonl with its cost", async () => {
    const ws = workspace();
    fakeClaude(ws, [{ [KNOWLEDGE_WRITE]: knowledgeMd() }], "1.25");
    await train(ws);

    const log = TrainingLog.forExpert(ws.expertDir).read();
    const result = log.find((event) => event.type === "agent.result");
    expect(result?.expert).toBe(EXPERT);
    expect(result?.area).toBe(AREA);
    expect(result?.cost_usd).toBe(1.25);
    expect(result?.payload.session_id).toBe("session-0");

    const passed = log.find((event) => event.type === "check.passed");
    expect(passed?.payload.level_before).toBe(0);
    expect(passed?.payload.level_after).toBe(2);
    expect(passed?.payload.evidence_added).toBe(2);
  });

  test("training.jsonl is append-only: a shortening write is refused", () => {
    const ws = workspace();
    const log = TrainingLog.forExpert(ws.expertDir);
    log.append({ ts: TRAIN_AT, expert: EXPERT, area: AREA, type: "agent.result", actor: "alan", cost_usd: 0.1, payload: {} });
    const before = log.sizeBytes;
    writeFileSync(log.path, "", "utf8");
    expect(log.sizeBytes).toBe(0);
    // The class refuses to write a record that would leave the file shorter than
    // it found it — the same proof `EventLog` uses.
    expect(before).toBeGreaterThan(0);
    expect(() => log.append({
      ts: TRAIN_AT, expert: EXPERT, area: AREA, type: "agent.result", actor: "alan",
      cost_usd: -1, payload: {},
    })).toThrow("cost_usd");
  });
});

// --- rejection ---------------------------------------------------------------

describe("an invalid knowledge file changes nothing", () => {
  test("an unsourced item is rejected: no evidence, no status change, exit 5", async () => {
    const ws = workspace();
    fakeClaude(ws, [{ [KNOWLEDGE_WRITE]: knowledgeMd({ extraItem: "- Tokens never expire" }) }]);

    const outcome = await train(ws);
    expect(outcome.code).toBe(5);
    expect(outcome.lines.join("\n")).toContain("does not validate");

    const area = areaOf(ws, AREA);
    expect(area.evidence).toEqual([]);
    expect(area.level).toBe(0);
    const doc = competencies(ws);
    expect(doc.status).toBe("created");
    expect(doc.last_trained).toBe(null);
  });

  test("the rejected file is moved aside, so `knowledge/<area>.md` never reads as accepted", async () => {
    const ws = workspace();
    fakeClaude(ws, [{ [KNOWLEDGE_WRITE]: knowledgeMd({ extraItem: "- Tokens never expire" }) }]);
    await train(ws);

    expect(existsSync(join(ws.root, KNOWLEDGE_REL))).toBe(false);
    expect(existsSync(join(ws.expertDir, "knowledge", `${AREA}.rejected.md`))).toBe(true);
  });

  test("a previously accepted knowledge file survives a rejected re-run", async () => {
    const ws = workspace();
    fakeClaude(ws, [{ [KNOWLEDGE_WRITE]: knowledgeMd() }]);
    await train(ws);
    const accepted = readFileSync(join(ws.root, KNOWLEDGE_REL), "utf8");

    fakeClaude(ws, [{ [KNOWLEDGE_WRITE]: "# nothing sourced here\n\n## Invariants\n\n- nope\n" }]);
    const outcome = await train(ws, { at: "2026-09-02T12:00:00Z", now: new Date("2026-09-02T12:00:00Z") });

    expect(outcome.code).toBe(5);
    expect(readFileSync(join(ws.root, KNOWLEDGE_REL), "utf8")).toBe(accepted);
    expect(competencies(ws).last_trained).toBe(TRAIN_AT);
  });

  test("the refusal is recorded, with the money that was already spent", async () => {
    const ws = workspace();
    fakeClaude(ws, [{ [KNOWLEDGE_WRITE]: knowledgeMd({ extraItem: "- Tokens never expire" }) }], "0.80");
    await train(ws);

    const log = TrainingLog.forExpert(ws.expertDir).read();
    expect(log.find((event) => event.type === "agent.result")?.cost_usd).toBe(0.8);
    expect(log.find((event) => event.type === "check.failed")?.payload.cost_usd).toBe(0.8);
  });

  test("a sub-agent that fails is exit 5, and nothing is written", async () => {
    const ws = workspace();
    fakeClaude(ws, [{}]);
    process.env.FAKE_TRAIN_IS_ERROR = "1";

    const outcome = await train(ws);
    expect(outcome.code).toBe(5);
    expect(competencies(ws).status).toBe("created");
  });

  // Measured on the pilot 2026-08-29: a sub-agent killed by its own budget
  // ceiling had ALREADY written a complete, valid knowledge file. The run
  // failed, so that file must not sit where an accepted one would.
  test("a torn knowledge file is never inlinable: the agent writes `.md.partial`", async () => {
    const ws = workspace();
    // The sub-agent writes the partial and then FAILS. Before wave Q it wrote
    // `knowledge/<area>.md` directly, and `expertKnowledge` inlines
    // `knowledge/*.md` into every later prompt for the area — so half a file,
    // written by a run that died, was read as if it were whole.
    fakeClaude(ws, [{ [KNOWLEDGE_WRITE]: "## Invariants\n\n- torn, no source\n" }]);
    process.env.FAKE_TRAIN_IS_ERROR = "1";

    const outcome = await train(ws);
    expect(outcome.code).toBe(5);
    // Nothing wears the inlinable name, and nothing is left at `.md.partial`
    // either: the record of the failed run is under `.rejected.md`.
    expect(existsSync(join(ws.root, KNOWLEDGE_REL))).toBe(false);
    expect(existsSync(join(ws.root, KNOWLEDGE_WRITE))).toBe(false);
    expect(existsSync(join(ws.expertDir, "knowledge", `${AREA}.rejected.md`))).toBe(true);
  });

  test("a failed sub-agent's file is quarantined, not left where an accepted one goes", async () => {
    const ws = workspace();
    fakeClaude(ws, [{ [KNOWLEDGE_WRITE]: knowledgeMd() }]);
    process.env.FAKE_TRAIN_IS_ERROR = "1";

    const outcome = await train(ws);
    expect(outcome.code).toBe(5);
    expect(existsSync(join(ws.root, KNOWLEDGE_REL))).toBe(false);
    expect(existsSync(join(ws.expertDir, "knowledge", `${AREA}.rejected.md`))).toBe(true);
    expect(competencies(ws).status).toBe("created");
    expect(areaOf(ws, AREA).evidence).toEqual([]);
  });

  test("a knowledge file that was never written is exit 5, not a silent pass", async () => {
    const ws = workspace();
    fakeClaude(ws, [{}]);
    const outcome = await train(ws);
    expect(outcome.code).toBe(5);
    expect(outcome.lines.join("\n")).toContain("was never written");
  });
});

// --- full mode ---------------------------------------------------------------

describe("full training mines past runs as well", () => {
  test("the mine keeps runs whose repos overlap and drops the rest", () => {
    const ws = workspace();
    const mine = mineRuns({
      root: ws.root,
      repos: ["api"],
      areaId: AREA,
      keywords: keywordsFor(AREA, "OAuth authorisation code exchange"),
      facts: FactsStore.loadOrEmpty(factsPath(ws.root)).facts,
    });
    expect(mine.files.map((file) => file.path).sort()).toEqual([
      "tldrx-work/260820-oauth/02-how/handoff.md",
      "tldrx-work/260820-oauth/retro.md",
    ]);
    expect(mine.facts.map((fact) => fact.id)).toEqual(["F001"]);
  });

  test("a fact about another area and another repo is not made relevant by being on record", () => {
    const ws = workspace();
    const facts = FactsStore.loadOrEmpty(factsPath(ws.root)).facts;
    const kept = relevantFacts({
      root: ws.root, repos: ["api"], areaId: AREA,
      keywords: keywordsFor(AREA, "OAuth authorisation code exchange"), facts,
    });
    expect(kept.map((fact) => fact.id)).toEqual(["F001"]);
  });

  test("both files are written, and run/answer evidence lands beside the code rows", async () => {
    const ws = workspace();
    fakeClaude(ws, [
      { [KNOWLEDGE_WRITE]: knowledgeMd() },
      { [FROM_RUNS_WRITE]: fromRunsMd() },
    ]);

    const outcome = await train(ws, { mode: "full" });
    expect(outcome.code).toBe(0);
    expect(existsSync(join(ws.root, FROM_RUNS_REL))).toBe(true);

    const evidence = areaOf(ws, AREA).evidence as { kind: string; src: string }[];
    const kinds = evidence.map((item) => item.kind).sort();
    expect(kinds).toEqual(["answer", "code", "code", "run", "run"]);
    expect(evidence.find((item) => item.kind === "answer")?.src).toBe("F001");
    // W = 1.0+1.0+1.0+1.0+0.8 = 4.8 -> level 3, 5 distinct sources.
    expect(areaOf(ws, AREA).level).toBe(3);
    expect(outcome.costUsd).toBe(0.74);
  });

  test("the run mine's prompt says transcripts are out of scope", async () => {
    const ws = workspace();
    fakeClaude(ws, [{ [KNOWLEDGE_WRITE]: knowledgeMd() }, { [FROM_RUNS_WRITE]: fromRunsMd() }]);
    const promptDir = join(ws.root, "prompts");
    process.env.FAKE_TRAIN_PROMPT_DIR = promptDir;

    await train(ws, { mode: "full" });
    expect(readFileSync(join(promptDir, "prompt-1.md"), "utf8")).toContain("Claude Code transcripts");
  });

  test("only tldrx-work citations and facts become evidence; a repo file in that file does not", () => {
    const ws = workspace();
    const ctx = toSrcContext(loadWorkspace(ws.root), null);
    const withRepoCite = fromRunsMd().replace(
      "## Sources",
      "## Sources\n\n- A repo line, which is not a run [src: api:src/auth/oauth.ts:1]\n",
    );
    const parsed = parseKnowledgeFile(withRepoCite, ctx, RUNS_SHAPE);
    expect(parsed.ok).toBe(true);
    const evidence = runEvidence(parsed.refs, "2026-09-01");
    expect(evidence.map((item) => item.kind).sort()).toEqual(["answer", "run", "run"]);
    expect(evidence.some((item) => item.src.startsWith("api:"))).toBe(false);
  });

  test("no matching run is a result, not an error — full mode still says so honestly", () => {
    const ws = workspace({ withoutRuns: true });
    const mine = mineRuns({
      root: ws.root, repos: ["api"], areaId: AREA,
      keywords: keywordsFor(AREA, "OAuth authorisation code exchange"),
      facts: [],
    });
    expect(mine.files).toEqual([]);
    expect(mine.notes.join(" ")).toContain("nothing to mine");
  });
});

// --- money -------------------------------------------------------------------

describe("the budget floor", () => {
  test(`--max-usd below $${MIN_TRAIN_USD.toFixed(2)} is refused (exit 2) before anything is read`, async () => {
    const ws = workspace();
    // No fake on PATH at all: a spawn here would fail loudly rather than silently pass.
    const outcome = await train(ws, { maxUsd: 0.1 });
    expect(outcome.code).toBe(2);
    expect(outcome.lines.join("\n")).toContain("floor");
    expect(existsSync(TrainingLog.forExpert(ws.expertDir).path)).toBe(false);
    expect(competencies(ws).status).toBe("created");
  });

  test("the ceiling reaches the sub-agent as --max-budget-usd", async () => {
    const ws = workspace();
    fakeClaude(ws, [{ [KNOWLEDGE_WRITE]: knowledgeMd() }]);
    const argvLog = join(ws.root, "argv.log");
    process.env.FAKE_TRAIN_ARGV_LOG = argvLog;

    await train(ws, { maxUsd: 1.5 });
    const argv = JSON.parse(readFileSync(argvLog, "utf8").trim()) as string[];
    expect(argv[argv.indexOf("--max-budget-usd") + 1]).toBe("1.50");
  });

  test("full mode shares the ceiling between its two sub-agents", async () => {
    const ws = workspace();
    fakeClaude(ws, [{ [KNOWLEDGE_WRITE]: knowledgeMd() }, { [FROM_RUNS_WRITE]: fromRunsMd() }]);
    const argvLog = join(ws.root, "argv.log");
    process.env.FAKE_TRAIN_ARGV_LOG = argvLog;

    await train(ws, { mode: "full", maxUsd: 3 });
    const lines = readFileSync(argvLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
    expect(lines).toHaveLength(2);
    for (const argv of lines) expect(argv[argv.indexOf("--max-budget-usd") + 1]).toBe("1.50");
  });

  test("the default ceiling is $2.00", async () => {
    const ws = workspace();
    fakeClaude(ws, [{ [KNOWLEDGE_WRITE]: knowledgeMd() }]);
    const argvLog = join(ws.root, "argv.log");
    process.env.FAKE_TRAIN_ARGV_LOG = argvLog;

    await train(ws);
    const argv = JSON.parse(readFileSync(argvLog, "utf8").trim()) as string[];
    expect(argv[argv.indexOf("--max-budget-usd") + 1]).toBe(DEFAULT_TRAIN_USD.toFixed(2));
  });
});

// --- effort ------------------------------------------------------------------

describe("--effort", () => {
  function firstArgv(argvLog: string): readonly string[] {
    return JSON.parse((readFileSync(argvLog, "utf8").trim().split("\n")[0]) ?? "[]") as string[];
  }

  test(`training defaults to --effort ${DEFAULT_TRAIN_EFFORT}`, async () => {
    const ws = workspace();
    fakeClaude(ws, [{ [KNOWLEDGE_WRITE]: knowledgeMd() }]);
    const argvLog = join(ws.root, "argv.log");
    process.env.FAKE_TRAIN_ARGV_LOG = argvLog;

    await train(ws);
    const argv = firstArgv(argvLog);
    expect(argv[argv.indexOf("--effort") + 1]).toBe(DEFAULT_TRAIN_EFFORT);
  });

  test("--effort overrides that default", async () => {
    const ws = workspace();
    fakeClaude(ws, [{ [KNOWLEDGE_WRITE]: knowledgeMd() }]);
    const argvLog = join(ws.root, "argv.log");
    process.env.FAKE_TRAIN_ARGV_LOG = argvLog;

    await train(ws, { effort: "low" });
    const argv = firstArgv(argvLog);
    expect(argv[argv.indexOf("--effort") + 1]).toBe("low");
  });

  test("full mode spawns both sub-agents at the same effort", async () => {
    const ws = workspace();
    fakeClaude(ws, [{ [KNOWLEDGE_WRITE]: knowledgeMd() }, { [FROM_RUNS_WRITE]: fromRunsMd() }]);
    const argvLog = join(ws.root, "argv.log");
    process.env.FAKE_TRAIN_ARGV_LOG = argvLog;

    await train(ws, { mode: "full", maxUsd: 3, effort: "xhigh" });
    const lines = readFileSync(argvLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
    expect(lines).toHaveLength(2);
    for (const argv of lines) expect(argv[argv.indexOf("--effort") + 1]).toBe("xhigh");
  });

  test("the effort is on every training.jsonl line, so cost can be compared per level later", async () => {
    const ws = workspace();
    fakeClaude(ws, [{ [KNOWLEDGE_WRITE]: knowledgeMd() }]);

    await train(ws, { effort: "low" });
    const log = TrainingLog.forExpert(ws.expertDir).read();
    const results = log.filter((event) => event.type === "agent.result");
    expect(results.length).toBeGreaterThan(0);
    for (const event of results) expect(event.payload.effort).toBe("low");
  });
});

// --- in-session --------------------------------------------------------------

describe("--prepare / --commit", () => {
  test("--prepare writes a bundle per sub-agent and spawns nothing", async () => {
    const ws = workspace();
    // No fake on PATH: prepare must not spawn.
    const outcome = await train(ws, { run: "prepare", mode: "full" });
    expect(outcome.code).toBe(0);
    expect(outcome.costUsd).toBe(0);

    const cache = trainingCacheDir(ws.root, EXPERT, AREA);
    expect(existsSync(join(cache, ".agent", "code", "prompt.md"))).toBe(true);
    expect(existsSync(join(cache, ".agent", "runs", "prompt.md"))).toBe(true);
    const pending = JSON.parse(readFileSync(join(cache, ".agent", "code", "pending.json"), "utf8")) as Record<string, unknown>;
    // The bundle declares the PARTIAL: that is what the sub-agent writes, and the
    // rename onto `<area>.md` is the framework's to make, after validation.
    expect(pending.outputs).toEqual([KNOWLEDGE_WRITE]);
    expect(pending.max_budget_usd).toBe(1);
    expect(competencies(ws).status).toBe("created");
  });

  test("--commit validates what the host session wrote, down the same path", async () => {
    const ws = workspace();
    await train(ws, { run: "prepare" });

    const cache = trainingCacheDir(ws.root, EXPERT, AREA);
    mkdirSync(join(ws.expertDir, "knowledge"), { recursive: true });
    writeFileSync(join(ws.root, KNOWLEDGE_WRITE), knowledgeMd(), "utf8");
    writeFileSync(
      join(cache, ".agent", "code", "result.json"),
      JSON.stringify({ outputs: [KNOWLEDGE_WRITE], questions_asked: [], notes: "", cost_usd: 0.9, session_id: "s1" }),
      "utf8",
    );

    const outcome = await train(ws, { run: "commit" });
    expect(outcome.code).toBe(0);
    expect(outcome.costUsd).toBe(0.9);
    expect(areaOf(ws, AREA).level).toBe(2);
    expect(TrainingLog.forExpert(ws.expertDir).read().some((event) => event.payload.in_session === true)).toBe(true);
  });

  test("--commit without a result.json says which file is missing", async () => {
    const ws = workspace();
    const outcome = await train(ws, { run: "commit" });
    expect(outcome.code).toBe(1);
    expect(outcome.lines.join("\n")).toContain("result.json");
  });

  test("--commit still rejects an unsourced file", async () => {
    const ws = workspace();
    await train(ws, { run: "prepare" });
    const cache = trainingCacheDir(ws.root, EXPERT, AREA);
    mkdirSync(join(ws.expertDir, "knowledge"), { recursive: true });
    writeFileSync(join(ws.root, KNOWLEDGE_REL), knowledgeMd({ extraItem: "- Tokens never expire" }), "utf8");
    writeFileSync(
      join(cache, ".agent", "code", "result.json"),
      JSON.stringify({ outputs: [KNOWLEDGE_REL], questions_asked: [], notes: "", cost_usd: 0.4, session_id: "s1" }),
      "utf8",
    );

    const outcome = await train(ws, { run: "commit" });
    expect(outcome.code).toBe(5);
    expect(competencies(ws).status).toBe("created");
  });
});

// --- what the operator sees --------------------------------------------------

describe("expert list and the dashboard move with the evidence", () => {
  test("`expert list` shows the new level and the evidence count", async () => {
    const ws = workspace();
    fakeClaude(ws, [{ [KNOWLEDGE_WRITE]: knowledgeMd() }]);
    await train(ws);

    const rendered = renderExpertList(loadExperts(ws.root, TRAIN_NOW));
    expect(rendered).toContain("evidence");
    expect(rendered).toContain("★★☆☆☆ 2  (2 evidence, newest 2026-09-01)");
    expect(rendered).toContain("in-use");

    const json = JSON.parse(expertListJson(loadExperts(ws.root, TRAIN_NOW))) as { evidence_count: number; areas: { id: string; level: number; evidence_count: number }[] }[];
    expect(json[0]?.evidence_count).toBe(2);
    expect(json[0]?.areas.find((area) => area.id === AREA)?.level).toBe(2);
  });

  test("no drift warning after a training run — the stored level is what the evidence computes", async () => {
    const ws = workspace();
    fakeClaude(ws, [{ [KNOWLEDGE_WRITE]: knowledgeMd() }]);
    await train(ws);
    expect(loadExpert(ws.root, EXPERT, TRAIN_NOW).drifted).toEqual([]);
  });

  test("the dashboard model's star chart data changes — tested on the model, not the HTML", async () => {
    const ws = workspace();
    const before = buildModel(ws.root, TRAIN_AT, { now: TRAIN_NOW }).experts
      .find((expert) => expert.name === EXPERT);
    expect(before?.status).toBe("created");
    expect(before?.areas.find((area) => area.id === AREA)?.level).toBe(0);
    expect(before?.areas.find((area) => area.id === AREA)?.evidenceCount).toBe(0);

    fakeClaude(ws, [{ [KNOWLEDGE_WRITE]: knowledgeMd() }]);
    await train(ws);

    const after = buildModel(ws.root, TRAIN_AT, { now: TRAIN_NOW }).experts
      .find((expert) => expert.name === EXPERT);
    expect(after?.status).toBe("in-use");
    expect(after?.lastTrained).toBe(TRAIN_AT);
    const area = after?.areas.find((entry) => entry.id === AREA);
    expect(area?.level).toBe(2);
    expect(area?.evidenceCount).toBe(2);
    expect(area?.newestEvidence).toBe("2026-09-01");
  });
});

// --- role experts ------------------------------------------------------------

/**
 * A role expert's domain is the WORKFLOW, not a folder, so light mode's grep has
 * nothing to grep. These tests pin both halves of that: the refusal that keeps
 * money from being spent on a file that would say nothing, and the full-mode run
 * that does work — one sub-agent over past runs, not two.
 */
describe("training a role expert", () => {
  const ROLE = "architect";
  const ROLE_FROM_RUNS = `.tldrx/experts/${ROLE}/knowledge/from-runs-${ROLE}.md`;
  const ROLE_FROM_RUNS_WRITE = `${ROLE_FROM_RUNS}.partial`;

  const ROLE_MD = [
    "---",
    `name: ${ROLE}`,
    "kind: role",
    "status: created",
    'created_by: "tldrx init"',
    "created_at: 2026-08-28T14:02:11Z",
    "repos: [api, lab]",
    "---",
    "",
    `# ${ROLE}`,
    "",
    "## Role",
    "",
    "You are the architect of this workspace inside the **How** stage.",
    "",
  ].join("\n");

  const ROLE_COMPETENCIES = [
    "version: 1",
    `expert: ${ROLE}`,
    "status: created",
    "last_trained: null",
    "areas:",
    `  - id: ${ROLE}`,
    "    title: The How stage",
    "    level: 0",
    `    train_prompt: tldrx expert train ${ROLE} --area ${ROLE} --mode full`,
    "    evidence: []",
  ].join("\n");

  function roleWorkspace(options: TrainingWorkspaceOptions = {}): TrainingWorkspace {
    return workspace({
      ...options,
      files: {
        [`.tldrx/experts/${ROLE}/expert.md`]: ROLE_MD,
        [`.tldrx/experts/${ROLE}/competencies.yml`]: ROLE_COMPETENCIES,
        ...(options.files ?? {}),
      },
    });
  }

  function trainRole(ws: TrainingWorkspace, overrides: Partial<TrainOptions> = {}) {
    return train(ws, { expert: ROLE, area: ROLE, ...overrides });
  }

  test("--mode light is refused (exit 1) before anything is spawned or spent", async () => {
    const ws = roleWorkspace();
    // No fake on PATH: a spawn here would fail loudly rather than quietly pass.
    const outcome = await trainRole(ws, { mode: "light" });
    expect(outcome.code).toBe(1);
    expect(outcome.costUsd).toBe(0);
    const text = outcome.lines.join("\n");
    expect(text).toContain("role expert");
    expect(text).toContain("--mode light` is refused");
    expect(text).toContain(`tldrx expert train ${ROLE} --area ${ROLE} --mode full`);
    // Nothing was written: no ledger, no status change, no knowledge file.
    expect(existsSync(TrainingLog.forExpert(join(ws.root, ".tldrx/experts", ROLE)).path)).toBe(false);
    expect(existsSync(join(ws.root, ROLE_FROM_RUNS))).toBe(false);
  });

  test("--mode full runs ONE sub-agent — the runs pass only — with the whole ceiling", async () => {
    const ws = roleWorkspace();
    fakeClaude(ws, [{ [ROLE_FROM_RUNS_WRITE]: fromRunsMd() }]);
    const argvLog = join(ws.root, "argv.log");
    process.env.FAKE_TRAIN_ARGV_LOG = argvLog;

    const outcome = await trainRole(ws, { mode: "full", maxUsd: 3 });
    expect(outcome.code).toBe(0);
    const spawns = readFileSync(argvLog, "utf8").trim().split("\n");
    expect(spawns).toHaveLength(1);
    // One agent, so the ceiling is not halved the way a two-agent full run halves it.
    const argv = JSON.parse(spawns[0] ?? "[]") as string[];
    expect(argv[argv.indexOf("--max-budget-usd") + 1]).toBe("3.00");
    // The code pass never ran, so its output does not exist.
    expect(existsSync(join(ws.root, `.tldrx/experts/${ROLE}/knowledge/${ROLE}.md`))).toBe(false);
    expect(existsSync(join(ws.root, ROLE_FROM_RUNS))).toBe(true);
  });

  test("--mode full moves the level on run evidence, like any other area", async () => {
    const ws = roleWorkspace();
    fakeClaude(ws, [{ [ROLE_FROM_RUNS_WRITE]: fromRunsMd() }]);
    const outcome = await trainRole(ws, { mode: "full" });
    expect(outcome.code).toBe(0);

    const document = parseYaml(
      readFileSync(join(ws.root, ".tldrx/experts", ROLE, "competencies.yml"), "utf8"),
    ) as Record<string, unknown>;
    const area = (document.areas as Record<string, unknown>[])[0];
    expect((area?.evidence as unknown[]).length).toBeGreaterThan(0);
    expect(area?.level).toBeGreaterThan(0);
  });

  test("--mode full with no run to mine is refused (exit 1) rather than paid for", async () => {
    const ws = roleWorkspace({ withoutRuns: true });
    // No fake on PATH again: this must not reach a spawn.
    const outcome = await trainRole(ws, { mode: "full" });
    expect(outcome.code).toBe(1);
    expect(outcome.costUsd).toBe(0);
    expect(outcome.lines.join("\n")).toContain("nothing to train from");
    expect(existsSync(join(ws.root, ROLE_FROM_RUNS))).toBe(false);
  });

  test("a domain expert is untouched: light mode still trains it", async () => {
    const ws = roleWorkspace();
    fakeClaude(ws, [{ [KNOWLEDGE_WRITE]: knowledgeMd() }]);
    const outcome = await train(ws, { mode: "light" });
    expect(outcome.code).toBe(0);
    expect(areaOf(ws, AREA).level).toBeGreaterThan(0);
  });

  test("the refusal is a pure function of kind and mode", () => {
    expect(lightModeRefusal("architect", "architect", "light", true)).not.toBeNull();
    expect(lightModeRefusal("architect", "architect", "full", true)).toBeNull();
    expect(lightModeRefusal("checkout", "checkout", "light", false)).toBeNull();
    expect(nothingToMineRefusal("architect", "architect", 0, true)).not.toBeNull();
    expect(nothingToMineRefusal("architect", "architect", 3, true)).toBeNull();
    expect(nothingToMineRefusal("checkout", "checkout", 0, false)).toBeNull();
  });

  test("`kind: role` is read off expert.md, not guessed from the name", () => {
    const ws = roleWorkspace();
    expect(isRoleExpertOnDisk(ws.root, ROLE)).toBe(true);
    expect(isRoleExpertOnDisk(ws.root, EXPERT)).toBe(false);
    expect(isRoleExpertOnDisk(ws.root, "no-such-expert")).toBe(false);
  });
});
