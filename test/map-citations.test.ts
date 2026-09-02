/**
 * gh #80 — `tldrx map --check` reads the ONE `[src: …]` grammar, and says which rule refused.
 *
 * `src/core/map/srcToken.ts` was a complete second implementation of the grammar:
 * a different `file` regex (a path could not contain a colon), a different answer
 * regex (no digit cap), a GLOBAL token regex (a mid-line citation counted), no
 * closer-stripping (a token wrapped in backticks was invisible), and no `aidlc:`
 * kind at all. Two readers of one question, and — as `core/text/handoff.ts` puts
 * it — the looser one wins the argument at the wrong moment.
 *
 * It also carried #77's defect on its own path: `"unparseable src token"` is a
 * SYMPTOM. #77 taught the claim-sources reader to answer with the RULE it
 * enforced, the line as written and a line that would have passed. `map --check`
 * gets that by construction here, because it now calls the same reader.
 *
 * Three things are measured:
 *
 *   1. the unification — every `map --check` grammar failure names a rule id,
 *      quotes the offending line and shows a corrected one, and the two old
 *      symptom strings are gone;
 *   2. the guard — no OTHER file may grow a competing `[src:` grammar. #48's
 *      lesson: deleting a second copy does not stop a third, so the guard is on
 *      the SHAPE, not on the file name that happened to hold it;
 *   3. the compatibility measurement — the shapes where unifying is STRICTER are
 *      pinned in code, so the migration hazard the issue names is a table a
 *      maintainer can read rather than a promise.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";
import { makeWorkspace, type TempWorkspace } from "./fixtures/tempWorkspace.ts";
import { noSpawnEnv } from "./fixtures/noSpawnPath.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";
import { checkCitations, MAP_BULLET_RULE, type CitationProblem } from "../src/core/map/checkCitations.ts";
import { srcRule, srcToken, SRC_RULE_IDS, type SrcRuleId } from "../src/core/text/srcToken.ts";

const REPO_ROOT = join(import.meta.dir, "..");

let dir: string | null = null;
afterEach(() => {
  if (dir !== null) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

/** A workspace holding one map document with `lines` in it, plus a real file to cite. */
function workspaceWith(lines: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), "tldrx-map-80-"));
  dir = root;
  mkdirSync(join(root, "lab", "src"), { recursive: true });
  writeFileSync(join(root, "lab", "src", "a.ts"), "one\ntwo\nthree\n");
  mkdirSync(join(root, ".tldrx", "map", "lab"), { recursive: true });
  writeFileSync(join(root, ".tldrx", "map", "lab", "architecture.md"), `# arch\n\n${lines.join("\n")}\n`);
  return root;
}

async function check(lines: readonly string[]): Promise<readonly CitationProblem[]> {
  const root = workspaceWith(lines);
  const result = await checkCitations({
    workspaceDir: root, root, repos: [{ name: "lab", path: "lab" }],
  });
  return result.problems;
}

const DOC = ".tldrx/map/lab/architecture.md";

// --- 1. the unification: one grammar, and rejections that name the rule ---------

describe("map --check speaks the canonical grammar's rules (#80 + #77)", () => {
  test("a mid-line token on a bullet is refused, by NAME — the old reader called it fine", async () => {
    const problems = await check(["- it drops places [src: lab:src/a.ts:2] before ranking"]);
    expect(problems).toHaveLength(1);
    const problem = problems[0];
    expect(problem?.rule).toBe("trailing-position");
    expect(problem?.file).toBe(DOC);
    expect(problem?.line).toBe(3);
    // the rule in its own words, the line as written, and a line that would pass
    expect(problem?.reason).toContain("rule `trailing-position`");
    expect(problem?.reason).toContain(srcRule("trailing-position").rule);
    expect(problem?.reason).toContain("you wrote: - it drops places [src: lab:src/a.ts:2] before ranking");
    expect(problem?.reason).toContain(`corrected: ${srcRule("trailing-position").good}`);
  });

  test("an ASCII `->` in a cmd src is `cmd-arrow`, not `unparseable src token`", async () => {
    const problems = await check(["- the suite is green [src: $ bun test -> exit 0]"]);
    expect(problems.map((p) => p.rule)).toEqual(["cmd-arrow"]);
    expect(problems[0]?.reason).toContain(srcRule("cmd-arrow").good);
  });

  test("a `]` inside the token is `no-bracket-inside`", async () => {
    const problems = await check(["- four pids skipped [src: lab:src/a.ts:2 (pids: [1,2])]"]);
    expect(problems.map((p) => p.rule)).toEqual(["no-bracket-inside"]);
  });

  test("a misspelled marker is `marker-spelling`", async () => {
    const problems = await check(["- hints are synchronous [src:lab:src/a.ts:2]"]);
    expect(problems.map((p) => p.rule)).toEqual(["marker-spelling"]);
  });

  test("a bullet with no citation at all names the document rule and shows a corrected line", async () => {
    const problems = await check(["- the selector drops low-quality places"]);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.rule).toBe("map-bullet");
    expect(problems[0]?.reason).toContain("rule `map-bullet`");
    expect(problems[0]?.reason).toContain(MAP_BULLET_RULE);
    expect(problems[0]?.reason).toContain("you wrote: - the selector drops low-quality places");
    expect(problems[0]?.reason).toContain(`corrected: ${srcRule("file-shape").good}`);
  });

  test("the two symptom-only strings #80 was filed over are gone from the reader", async () => {
    const problems = await check([
      "- a claim with no source",
      "- a malformed one [src: $ bun test -> exit 0]",
      "- a mid-line one [src: lab:src/a.ts:1] and prose after",
    ]);
    expect(problems).toHaveLength(3);
    for (const problem of problems) {
      expect(problem.reason).not.toBe("bullet has no [src: …] token");
      expect(problem.reason).not.toBe("unparseable src token");
    }
    // …and the reader no longer holds either sentence AS A STRING LITERAL. The
    // quotes are part of the needle: the reader's header names the old messages as
    // history, and a bare `toContain` would match the prose explaining the fix
    // rather than a message it could print.
    const reader = readFileSync(join(REPO_ROOT, "src/core/map/checkCitations.ts"), "utf8");
    expect(reader).not.toContain('"unparseable src token"');
    expect(reader).not.toContain('"bullet has no');
  });

  test("every grammar problem carries a rule id the canonical registry knows", async () => {
    const problems = await check([
      "- one [src: $ bun test -> exit 0]",
      "- two [src: lab:src/a.ts:1] trailing prose",
      "- three [src: ]",
    ]);
    expect(problems.length).toBeGreaterThan(0);
    const known = new Set<string>([...SRC_RULE_IDS, "map-bullet"]);
    for (const problem of problems) {
      expect(problem.rule, `unknown rule on ${problem.reason}`).not.toBeNull();
      expect(known.has(String(problem.rule)), `rule ${String(problem.rule)} is not in the registry`).toBe(true);
    }
  });
});

describe("what the second grammar got WRONG is now right", () => {
  test("a bullet whose token is wrapped in backticks validates — the old reader saw no token", async () => {
    const problems = await check(["- the API binds to all interfaces `[src: lab:src/a.ts:2]`"]);
    expect(problems).toEqual([]);
  });

  test("a bullet whose token is followed by a period validates", async () => {
    const problems = await check(["- the API binds to all interfaces [src: lab:src/a.ts:2]."]);
    expect(problems).toEqual([]);
  });

  test("an `aidlc:` src is a kind, not an unknown repo", async () => {
    const problems = await check(["- the intent named two personas [src: aidlc:intents/260821/design.md:14]"]);
    expect(problems).toEqual([]);
  });

  test("a path containing a colon resolves instead of being called unparseable", async () => {
    const root = mkdtempSync(join(tmpdir(), "tldrx-map-80-"));
    dir = root;
    mkdirSync(join(root, "lab", "src"), { recursive: true });
    writeFileSync(join(root, "lab", "src", "a:b.ts"), "one\ntwo\n");
    mkdirSync(join(root, ".tldrx", "map", "lab"), { recursive: true });
    writeFileSync(
      join(root, ".tldrx", "map", "lab", "architecture.md"),
      `# arch\n\n- a colon in the name ${srcToken(["lab:src/a:b.ts:2"])}\n`,
    );
    const result = await checkCitations({
      workspaceDir: root, root, repos: [{ name: "lab", path: "lab" }],
    });
    expect(result.problems).toEqual([]);
    expect(result.checked).toBe(1);
  });

  test("resolution failures still resolve, and carry no grammar rule", async () => {
    const problems = await check([`- a gone file ${srcToken(["lab:src/gone.ts:1"])}`]);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.rule).toBeNull();
    expect(problems[0]?.reason).toBe("file does not exist");
  });

  test("an out-of-range line is still drift, and still says so", async () => {
    const problems = await check([`- past the end ${srcToken(["lab:src/a.ts:9999"])}`]);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.rule).toBeNull();
    expect(problems[0]?.reason).toStartWith("line out of range");
  });

  test("an unknown repo is still an unknown repo", async () => {
    const problems = await check([`- elsewhere ${srcToken(["api:src/a.ts:1"])}`]);
    expect(problems.map((p) => p.reason)).toEqual(["unknown repo `api`"]);
  });
});

// --- 2. the guard: there is one grammar, and re-adding a second goes red --------

/** Every `.ts` under `src/`, recursively. Plain walk — no globbing, no shelling out. */
function sourceFiles(dir_: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir_, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = join(dir_, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(path));
    else if (entry.name.endsWith(".ts")) found.push(path);
  }
  return found;
}

const SRC_FILES = sourceFiles(join(REPO_ROOT, "src"))
  .map((p) => p.slice(REPO_ROOT.length + 1))
  .sort();

/** The ONE file allowed to define the grammar. */
const CANONICAL = "src/core/text/srcToken.ts";

/**
 * Files that may hold a regex matching the `[src:` marker WITHOUT being a grammar,
 * each with the reason it is not one. A new entry is a deliberate act with a
 * justification attached; that is the whole point of listing them.
 */
const MARKER_ALLOWED: Readonly<Record<string, string>> = {
  [CANONICAL]: "the canonical grammar itself",
  "src/core/training/knowledgeFile.ts":
    "a LOCATOR: it finds tokens in prose and hands each one to `parseSrcToken` — it never classifies",
  "src/core/retro/findings.ts":
    "two STRIPPERS: `.replace(…, ' ')` removes tokens before text is compared — it never reads one",
};

/**
 * The signature of a regex that can MATCH the `[src:` marker: an escaped `\[`.
 *
 * A `[` inside a regex opens a character class, so a pattern that means the
 * literal bracket has to escape it — every one of the four readers this repo has
 * ever had spelled it `/\[src…/`. Prose does not: a doc comment or a message
 * writes `[src: …]` bare. So the backslash IS the discriminator between code that
 * reads the grammar and text that talks about it, and it needs no lexer.
 *
 * The first version of this guard tried to lex out regex literals instead. It
 * reported eleven offenders that were all doc comments, and when that was fixed
 * by stripping comments and strings it reported five more that were template
 * literals nested inside interpolations — an instrument that could not tell code
 * from prose, which is the same wrong-instrument failure #80 itself is about.
 * Measured over the tree: this predicate is true for exactly three files, and it
 * was true for the deleted `core/map/srcToken.ts` (asserted below).
 */
function definesMarkerRegex(text: string): boolean {
  return text.includes("\\[src");
}

describe("there is exactly ONE `[src: …]` grammar in the tree (#80, #48's lesson)", () => {
  test("the sweep is not vacuous: it sees the canonical grammar and a real file count", () => {
    expect(SRC_FILES.length).toBeGreaterThan(100);
    expect(SRC_FILES).toContain(CANONICAL);
    expect(definesMarkerRegex(readFileSync(join(REPO_ROOT, CANONICAL), "utf8"))).toBe(true);
  });

  /**
   * The teeth, proven rather than assumed: the two token regexes the deleted file
   * carried, verbatim from `origin/main` at 888c518. A guard that would not have
   * caught the thing it was written for is decoration.
   */
  test("the guard WOULD have caught the copy it was written for", () => {
    const deleted = [
      String.raw`const TOKEN_RE = /\[src: ([^\]]+)\]/g;`,
      String.raw`const TRAILING_TOKEN_RE = /\[src: [^\]]+\]$/;`,
    ];
    for (const line of deleted) expect(definesMarkerRegex(line), line).toBe(true);
    // …and it does NOT fire on prose that merely names the marker.
    expect(definesMarkerRegex("/** the `[src: …]` token this bullet must end with */")).toBe(false);
    expect(definesMarkerRegex(`reason: "bullet has no [src: …] token"`)).toBe(false);
  });

  /**
   * An exemption that has stopped being needed is an exemption that will one day
   * cover something it was never granted for. Asserting each one still MATCHES
   * makes the reasons beside them load-bearing rather than decorative.
   */
  test("every exemption is still needed — no stale entries on the allowlist", () => {
    for (const [rel, why] of Object.entries(MARKER_ALLOWED)) {
      expect(SRC_FILES, `${rel} is exempted but is not in the tree`).toContain(rel);
      const text = readFileSync(join(REPO_ROOT, rel), "utf8");
      expect(definesMarkerRegex(text), `${rel} no longer needs its exemption (${why})`).toBe(true);
    }
  });

  test("the divergent copy is DELETED, not merely unused", () => {
    const state = SRC_FILES.includes("src/core/map/srcToken.ts") ? "STILL SHIPPED" : "gone";
    expect(`src/core/map/srcToken.ts: ${state}`).toBe("src/core/map/srcToken.ts: gone");
  });

  /**
   * Deleting one file does not stop a second: a `src/core/map/citations.ts` with
   * the same `TOKEN_RE` in it would be #80 again under a name this test never
   * mentions. So the guard is on the SHAPE — any regex that matches the marker,
   * in any file, must be on the list with its reason.
   */
  test("no unlisted file defines a regex that matches the `[src:` marker", () => {
    const offenders: string[] = [];
    for (const rel of SRC_FILES) {
      if (rel in MARKER_ALLOWED) continue;
      if (definesMarkerRegex(readFileSync(join(REPO_ROOT, rel), "utf8"))) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  /**
   * The second half of the guard. A copy could rename its token regex to
   * something this sweep does not match and still be a second grammar — what
   * makes it one is that it decides what KIND a source is. Two or more of the
   * per-kind productions in one file is that decision being made a second time.
   */
  test("no other file classifies src KINDS — that is what makes a file a grammar", () => {
    const productions: readonly [string, RegExp][] = [
      ["answer", /\/\^Q\\d/],
      ["fact", /\/\^F\\d/],
      ["cmd", /exit \\d|→ exit/],
      ["graph", /\^graph:/],
      ["absent", /\^absent:/],
      ["doc", /\^https:/],
    ];
    const offenders: string[] = [];
    /**
     * `validateFactsFile.ts` re-spells `^F\\d{3,6}$` and `^Q\\d{1,6}$` to validate the
     * `id:` and `question:` FIELDS of `.tldrx/memory/facts.yml`. Today they agree
     * with `SRC_PATTERNS.fact` / `.answer` character for character. That is a second
     * copy of a shape and it is the same family of defect as #80 — but it is a
     * different question (is this a valid fact id in a facts FILE) reached by a
     * different reader, so it is FILED rather than fixed here. See gh #81.
     */
    const KIND_ALLOWED = new Set(["src/core/facts/validateFactsFile.ts"]);
    for (const rel of SRC_FILES) {
      if (rel === CANONICAL || KIND_ALLOWED.has(rel)) continue;
      const text = readFileSync(join(REPO_ROOT, rel), "utf8");
      const matched = productions.filter(([, re]) => re.test(text)).map(([name]) => name);
      if (matched.length >= 2) offenders.push(`${rel} classifies ${matched.join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });

  test("map's public surface no longer re-exports a parser of its own", () => {
    const index = readFileSync(join(REPO_ROOT, "src/core/map/index.ts"), "utf8");
    for (const gone of ["parseSrc", "ParsedSrc"]) {
      expect(index, `map/index.ts still exports ${gone}`).not.toContain(gone);
    }
    expect(index).toContain("../text/srcToken.ts");
  });
});

// --- 3. the compatibility measurement, pinned ----------------------------------

/**
 * The migration hazard, measured (#80).
 *
 * Run over the two real `.tldrx/map` trees on the maintainer's machine
 * (39 documents, 692 lines, 435 of them carrying a citation) the two grammars
 * disagreed on ZERO lines: no multi-token line, no non-bullet citation, and not
 * one token that failed to end its line. That measurement cannot be a test — the
 * trees are not in this repo — so what is pinned here is the AXES: every shape
 * where unification changes the answer, asserted through the reader that now runs.
 *
 * A shape moving from `refused` to `ok` is a bug fixed. A shape moving the other
 * way is the migration hazard, and there are five: read the STRICTER rows as the
 * list of what a pre-#80 map could contain and a post-#80 map may not.
 */
describe("the compatibility difference between the two grammars, as a table", () => {
  const STRICTER: readonly [string, string, SrcRuleId][] = [
    ["a mid-line token on a bullet", "- claim [src: lab:src/a.ts:1] and prose after", "trailing-position"],
    ["a `..` in a file path", "- claim [src: ../outside/a.ts:1]", "no-parent-dir"],
    ["an answer id with 7+ digits", "- claim [src: Q1234567]", "id-shape"],
    ["a cmd exit code with 4+ digits", "- claim [src: $ bun test → exit 1234]", "cmd-arrow"],
    ["a line range that ends before it starts", "- claim [src: lab:src/a.ts:9-2]", "line-range"],
    ["a line number of zero", "- claim [src: lab:src/a.ts:0]", "line-number"],
  ];

  const LOOSER: readonly [string, string][] = [
    ["a path containing a colon", "- claim [src: lab:src/a:b.ts:1]"],
    ["an `aidlc:…#Q<n>` src", "- claim [src: aidlc:intents/260821/design.md#Q3]"],
    ["a cmd whose command holds a backtick", "- claim [src: $ bun run `x` → exit 0]"],
    ["an `absent:` path with a space in it", "- claim [src: absent:docs/my file.md]"],
    ["a token wrapped in backticks", "- claim `[src: lab:src/a.ts:1]`"],
  ];

  test("every STRICTER shape is refused by the reader map --check now runs, with that rule", async () => {
    for (const [label, line, rule] of STRICTER) {
      const problems = await check([line]);
      expect(problems.length, `${label} was not refused`).toBeGreaterThan(0);
      expect(problems[0]?.rule, `${label} refused by the wrong rule`).toBe(rule);
    }
  });

  test("every LOOSER shape is accepted for its GRAMMAR — the old reader called each unparseable", async () => {
    for (const [label, line] of LOOSER) {
      const problems = await check([line]);
      const grammar = problems.filter((problem) => problem.rule !== null);
      expect(grammar.map((p) => p.rule), `${label} is still a grammar failure`).toEqual([]);
    }
  });
});


// --- 4. the message a human actually reads -------------------------------------

/**
 * Everything above reads `checkCitations` in-process. #77 and #80 are about what
 * reaches a PERSON, and between the reader and the person is a CLI that formats.
 * So one end-to-end run of the real binary, against a real workspace on disk.
 */
describe("`tldrx map --check` prints the rule, not the symptom", () => {
  // Spawns a real process; the budget scales with measured machine load (#43).
  setDefaultTimeout(spawnTestTimeout());

  let ws: TempWorkspace | null = null;
  afterEach(() => {
    ws?.dispose();
    ws = null;
  });

  test("a drifting map exits 1 and the report names the rule and quotes the line", async () => {
    ws = makeWorkspace();
    mkdirSync(join(ws.root, ".tldrx", "map", "lab"), { recursive: true });
    writeFileSync(
      join(ws.root, ".tldrx", "map", "lab", "architecture.md"),
      "# arch\n\n- it drops places [src: lab:src/a.ts:2] before ranking\n",
    );

    const proc = Bun.spawn(["bun", join(FRAMEWORK_ROOT, "bin", "tldrx.ts"), "map", "--check"], {
      stdout: "pipe", stderr: "pipe", cwd: ws.root, env: noSpawnEnv(),
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;

    expect(code, `stdout: ${stdout}\nstderr: ${stderr}`).toBe(1);
    expect(stderr).toContain("rule `trailing-position`");
    expect(stderr).toContain("you wrote: - it drops places [src: lab:src/a.ts:2] before ranking");
    expect(stderr).toContain(`corrected: ${srcRule("trailing-position").good}`);
    // the middle column names the rule rather than claiming there is no token
    expect(stderr).toContain("trailing-position  — rule");
    expect(stderr).not.toContain("(no token)");
    expect(stderr).not.toContain("unparseable src token");
    // and the headline counts the two failures apart: nothing RESOLVED badly here
    expect(stderr).toContain("1 do not parse");
    expect(stderr).not.toContain("of 0 citations");
  });
});
