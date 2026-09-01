/**
 * The `## Output schemas` section is GENERATED from the validators, not copied
 * from them (gh #35, #38).
 *
 * A hand-written copy of a schema is a second source of truth that drifts on the
 * first commit nobody thought about — which is how `templates/story.md` ended up
 * carrying the schema while `grep -rn 'story\.md' src/` returned nothing: the
 * file was right and unread. So the guarantee tested here is a loop, not a
 * resemblance:
 *
 *   the contract CONTAINS the example
 *     → the example VALIDATES through `validatePlan`, the very check that gates
 *       the stage
 *     → the example's key set IS `STORY_KEYS` / `EPIC_KEYS`, in order.
 *
 * Add a required key to a schema and the middle link breaks. Rename one and the
 * last link breaks. Neither can be fixed by editing prose.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseYaml } from "../src/core/yaml.ts";
import { parseFrontMatter } from "../src/core/schemas/frontMatter.ts";
import { parseDodBlock, STORY_KEYS, validateStoryFile } from "../src/core/schemas/story.ts";
import { EPIC_KEYS, validateEpicFile } from "../src/core/schemas/epic.ts";
import { validateWaves } from "../src/core/schemas/waves.ts";
import {
  MAX_ITEM_CHARS, MAX_LIST_ITEMS, MAX_PLAN_STORIES, MAX_STORIES_PER_WAVE,
  MAX_TOUCHES, MAX_WAVES, PLAN_STATUSES,
} from "../src/core/schemas/planCommon.ts";
import { STORIES_DIR, validatePlan } from "../src/core/plan/validatePlan.ts";
import { updateStoryFront } from "../src/core/build/storyFile.ts";
import { FRAMEWORK_ROOT, TEMPLATES_DIR } from "../src/core/paths.ts";
import { noSpawnEnv } from "./fixtures/noSpawnPath.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";
import {
  PLAN_CONTRACT_HEADING, planContractExamples, renderPlanSchemaContract,
} from "../src/core/plan/schemaContract.ts";

// The #71 block spawns a real `bun bin/tldrx.ts` per case.
setDefaultTimeout(spawnTestTimeout());

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

function keysOf(markdown: string): readonly string[] {
  const doc = parseFrontMatter(markdown).doc;
  expect(doc).not.toBeNull();
  return Object.keys(doc as Record<string, unknown>);
}

describe("the contract's examples are what the check accepts", () => {
  test("the story example validates, dod block and all", () => {
    const examples = planContractExamples();
    const parsed = validateStoryFile(examples.story, new Set(examples.dodCommands));
    expect(parsed.validation.issues).toEqual([]);
    expect(parsed.story).not.toBeNull();
  });

  test("the epic example validates", () => {
    const parsed = validateEpicFile(planContractExamples().epic);
    expect(parsed.validation.issues).toEqual([]);
    expect(parsed.epic).not.toBeNull();
  });

  test("the waves example validates", () => {
    expect(validateWaves(parseYaml(planContractExamples().waves)).issues).toEqual([]);
  });

  test("the three together pass `validatePlan` — the check that gates the stage", () => {
    const examples = planContractExamples();
    const story = parseFrontMatter(examples.story).doc as { id: string };
    const epic = parseFrontMatter(examples.epic).doc as { id: string };
    const dir = mkdtempSync(join(tmpdir(), "tldrx-contract-"));
    dirs.push(dir);
    mkdirSync(join(dir, "stories"), { recursive: true });
    mkdirSync(join(dir, "epics"), { recursive: true });
    writeFileSync(join(dir, "stories", `${story.id}.md`), examples.story, "utf8");
    writeFileSync(join(dir, "epics", `${epic.id}.md`), examples.epic, "utf8");
    writeFileSync(join(dir, "waves.yml"), examples.waves, "utf8");
    const report = validatePlan(dir, new Set(examples.dodCommands));
    expect(report.issues).toEqual([]);
    expect(report.ok).toBe(true);
  });
});

describe("the contract cannot drift from the schema", () => {
  test("the rendered section carries the examples verbatim", () => {
    const contract = renderPlanSchemaContract();
    const examples = planContractExamples();
    expect(contract).toContain(examples.story.trimEnd());
    expect(contract).toContain(examples.epic.trimEnd());
    expect(contract).toContain(examples.waves.trimEnd());
  });

  test("the story example's keys ARE `STORY_KEYS`, in order", () => {
    expect(keysOf(planContractExamples().story)).toEqual([...STORY_KEYS]);
  });

  test("the epic example's keys ARE `EPIC_KEYS`, in order", () => {
    expect(keysOf(planContractExamples().epic)).toEqual([...EPIC_KEYS]);
  });

  test("every cap the Plan schemas enforce is stated, at its current value", () => {
    const contract = renderPlanSchemaContract();
    const caps: readonly [string, number][] = [
      ["MAX_ITEM_CHARS", MAX_ITEM_CHARS],
      ["MAX_LIST_ITEMS", MAX_LIST_ITEMS],
      ["MAX_TOUCHES", MAX_TOUCHES],
      ["MAX_WAVES", MAX_WAVES],
      ["MAX_STORIES_PER_WAVE", MAX_STORIES_PER_WAVE],
      ["MAX_PLAN_STORIES", MAX_PLAN_STORIES],
    ];
    for (const [name, value] of caps) {
      expect(`${name}=${contract.includes(String(value)) ? "stated" : "MISSING"}`)
        .toBe(`${name}=stated`);
    }
  });

  test("the status enum is stated in full and spelled the way the enum is", () => {
    const contract = renderPlanSchemaContract();
    expect(contract).toContain(PLAN_STATUSES.join(" | "));
  });

  test("the heading is the one the prompt splices under", () => {
    expect(PLAN_CONTRACT_HEADING).toBe("Output schemas");
  });

  /**
   * Caught while writing this: the first draft's examples carried `## Definition
   * of done` and `## Why`, and `replaceSection` / `cutSection` / the context
   * ledger all find a section's END by scanning for a line that starts with
   * `## `. An H2 inside the contract truncates the section for every one of
   * them. The examples say the same thing with bold text instead.
   */
  test("every generated table row has exactly two columns", () => {
    const rows = renderPlanSchemaContract().split("\n").filter((line) => line.startsWith("| "));
    expect(rows.length).toBeGreaterThan(0);
    // `PLAN_STATUSES.join(" | ")` in a cell used to open five extra columns.
    for (const row of rows) expect(row.replaceAll("\\|", "").split("|").length).toBe(4);
  });

  test("no H2 inside it — every section scanner ends a section on `## `", () => {
    const offenders = renderPlanSchemaContract().split("\n").filter((line) => line.startsWith("## "));
    expect(offenders).toEqual([]);
  });
});

describe("the second copy of the schema is gone, not just guarded (#48)", () => {
  /**
   * Owner decision (Alan, 2026-09-01), option (a): `templates/story.md` and
   * `templates/epic.md` are DELETED, and the story and epic anyone copies are
   * GENERATED from `planContractExamples()` instead.
   *
   * What this describe asserted before that decision was that the two shipped files
   * agreed with `STORY_KEYS` / `EPIC_KEYS`. It asserts the same contract now, against
   * the generated output — plus the one thing a drift test could not say while the
   * files were still on disk: that they are gone, and that nothing else under
   * `templates/` has quietly grown a third copy of the Plan front matter.
   *
   * The teeth are unchanged. Break the generator — a key renamed in the example, a
   * `status:` the enum does not have, a `touches:` that is no longer a list — and
   * `validateStoryFile` / `validateEpicFile` refuse it here, exactly as the `plan`
   * check would refuse it mid-run.
   *
   * The dod commands come from the example itself rather than from a workspace:
   * `validateStoryDod` refuses every command under an EMPTY allowlist, and #48 is
   * about the FRONT MATTER.
   */
  test("templates/story.md and templates/epic.md are not on disk any more", () => {
    for (const name of ["story.md", "epic.md"]) {
      const state = existsSync(join(TEMPLATES_DIR, name)) ? "STILL SHIPPED" : "gone";
      expect(`${name}: ${state}`).toBe(`${name}: gone`);
    }
  });

  /**
   * Deleting two files does not stop a third from being added — and a `plan-story.md`
   * carrying the same front matter would be the same defect under a name this test
   * never mentioned. So the guard is on the SHAPE, not on the two file names.
   */
  test("no other shipped template has grown a copy of the Plan front matter", () => {
    const offenders: string[] = [];
    for (const name of readdirSync(TEMPLATES_DIR).filter((n) => n.endsWith(".md"))) {
      const doc = parseFrontMatter(readFileSync(join(TEMPLATES_DIR, name), "utf8")).doc;
      if (doc === null) continue;
      const keys = Object.keys(doc as Record<string, unknown>).join(",");
      if (keys === STORY_KEYS.join(",")) offenders.push(`${name} carries STORY_KEYS`);
      if (keys === EPIC_KEYS.join(",")) offenders.push(`${name} carries EPIC_KEYS`);
    }
    expect(offenders).toEqual([]);
  });

  test("the GENERATED story validates through the same `validateStoryFile` the check runs", () => {
    const examples = planContractExamples();
    const dod = parseDodBlock(parseFrontMatter(examples.story).frontMatter.body);
    expect(dod.present).toBe(true);
    expect(dod.commands).toEqual([...examples.dodCommands]);

    const parsed = validateStoryFile(examples.story, new Set(dod.commands));
    expect(parsed.validation.issues).toEqual([]);
    expect(parsed.story).not.toBeNull();
  });

  test("the GENERATED story's keys ARE `STORY_KEYS`, in order — no extra, none missing", () => {
    expect(keysOf(planContractExamples().story)).toEqual([...STORY_KEYS]);
  });

  test("the GENERATED epic validates through the same `validateEpicFile` the check runs", () => {
    const parsed = validateEpicFile(planContractExamples().epic);
    expect(parsed.validation.issues).toEqual([]);
    expect(parsed.epic).not.toBeNull();
  });

  test("the GENERATED epic's keys ARE `EPIC_KEYS`, in order", () => {
    expect(keysOf(planContractExamples().epic)).toEqual([...EPIC_KEYS]);
  });

  /**
   * The deleted templates spelled the enum a SECOND time, in a trailing comment
   * beside `status:` that no validator ever read — the kind of prose that goes stale
   * silently and then teaches a reader a status that does not exist. There is one
   * spelling left, and it is generated: asserted from both ends so neither can rot.
   */
  test("the only enum anyone reads is `PLAN_STATUSES` itself", () => {
    expect(renderPlanSchemaContract()).toContain(PLAN_STATUSES.join(" | "));
    const examples = planContractExamples();
    const statuses: readonly string[] = PLAN_STATUSES;
    for (const [what, text] of [["story", examples.story], ["epic", examples.epic]] as const) {
      const status = (parseFrontMatter(text).doc as { status?: string } | null)?.status ?? "";
      expect(`${what} status \`${status}\`: ${statuses.includes(status) ? "in the enum" : "NOT IN THE ENUM"}`)
        .toBe(`${what} status \`${status}\`: in the enum`);
    }
  });
});

/**
 * The epic file states no story's status — the story file is the only writer (#50).
 *
 * Measured on run `260829-scoring-leaderboard`: `03-plan/epics/E1.md` listed S1, S2
 * and S3 as `todo` in its `## Stories` table while `03-plan/stories/S1.md` said
 * `done` (merged at 0a50660) and S2 said `in_progress`. Nothing had lied; nothing
 * had written, either. The table is a COPY of state whose home is elsewhere, and it
 * has no writer, so it is wrong from the first story that lands.
 *
 * The repo already draws this line, and draws it the other way for the one field it
 * does maintain: the epic's front-matter `status:` is DERIVED and WRITTEN, by
 * `BuildExecutor.updateEpicStatus` (`src/core/facilitator/executors/build.ts:2552`),
 * from the story files every time a story settles. That is the whole difference —
 * a copy with a writer is a cache, a copy without one is a lie waiting to be read.
 *
 * So the fix is (a) from the issue, not (b): stop rendering per-story status in the
 * epic, rather than adding a second writer for it. Three reasons, all from this
 * codebase rather than from taste:
 *
 *  - NOTHING PARSES IT. `validateEpicFile` is front matter only ("the front matter
 *    is the whole schema", `schemas/epic.ts:69`); `adapters/body.ts:50` mirrors an
 *    epic to a ticket as a bare list of ids with no status; `dashboard/model.ts:467`
 *    reads the front matter. A writer would be maintaining a document with no reader.
 *  - THE CONTRACT THE AGENT READS ALREADY OMITS IT. `planContractExamples().epic` —
 *    generated from `EPIC_KEYS`, spliced into the Plan prompt — is front matter plus
 *    two prose lines, no table. Only the shipped template disagreed.
 *  - IT IS #48's DEFECT AGAIN. "A prose copy of a schema is a second source of truth"
 *    (`schemaContract.ts:20`). Status is state, which rots faster than a schema does.
 */
describe("the epic file states no story's status (#50)", () => {

  /**
   * Every `<story id> = <status>` claim a stretch of markdown makes: any line that
   * names a story id AND a status word is asserting one. Deliberately blunt — a
   * table row, a bullet or a sentence all read the same to somebody skimming the
   * file, and all three drift identically.
   */
  function storyStatusClaims(markdown: string): string[] {
    const claims: string[] = [];
    for (const line of markdown.split("\n")) {
      const ids = [...line.matchAll(/\bS\d{1,4}\b/g)].map((match) => match[0]);
      if (ids.length === 0) continue;
      for (const status of PLAN_STATUSES) {
        if (!new RegExp(`\\b${status}\\b`).test(line)) continue;
        for (const id of ids) claims.push(`${id}=${status}`);
      }
    }
    return claims;
  }

  test("the claim detector really detects — the table that was on disk is found", () => {
    const wasShipped = [
      "## Stories",
      "",
      "| Story | Repo | Depends on | Status |",
      "|---|---|---|---|",
      "| S1 | example | — | todo |",
      "| S2 | example | S1 | in_progress |",
    ].join("\n");
    // Three claims, not two: S2's row names S1 in its `Depends on` cell, so a blunt
    // reader takes `in_progress` for both. That over-breadth is the point — the guard
    // wants the table gone, and it is only ever pointed at files this repo ships.
    expect(storyStatusClaims(wasShipped)).toEqual(["S1=todo", "S2=in_progress", "S1=in_progress"]);
    expect(storyStatusClaims("## Stories\n\nOne file each under `03-plan/stories/`.")).toEqual([]);
  });

  /**
   * `templates/epic.md` used to be the second half of this assertion. It is deleted
   * (#48, owner option (a)), so the generated epic is now the ONLY epic anyone
   * copies — and the only one that can carry the table back.
   */
  test("the epic example the Plan agent is told to copy claims no story's status", () => {
    const epic = planContractExamples().epic;
    expect(storyStatusClaims(parseFrontMatter(epic).frontMatter.body)).toEqual([]);
  });

  /**
   * The issue's acceptance, run: flip S1 to `done` through the same writer the Build
   * executor uses, then grep the epic. Nothing may contradict `stories/S1.md`.
   */
  test("flip S1 to done and nothing in the epic contradicts stories/S1.md", () => {
    const dir = mkdtempSync(join(tmpdir(), "tldrx-epic-50-"));
    dirs.push(dir);
    mkdirSync(join(dir, "stories"), { recursive: true });
    mkdirSync(join(dir, "epics"), { recursive: true });

    const examples = planContractExamples();
    const storyPath = join(dir, "stories", "S1.md");
    writeFileSync(storyPath, examples.story, "utf8");
    writeFileSync(join(dir, "epics", "E1.md"), examples.epic, "utf8");

    writeFileSync(
      storyPath,
      updateStoryFront(readFileSync(storyPath, "utf8"), {
        status: "done",
        evidence: ["$ npm run test → exit 0"],
      }),
      "utf8",
    );
    const story = parseFrontMatter(readFileSync(storyPath, "utf8")).doc as { id: string; status: string };
    expect(`${story.id}=${story.status}`).toBe("S1=done");

    const epicText = readFileSync(join(dir, "epics", "E1.md"), "utf8");
    const contradictions = storyStatusClaims(parseFrontMatter(epicText).frontMatter.body)
      .filter((claim) => claim !== `${story.id}=${story.status}`);
    expect(contradictions).toEqual([]);
  });

  /**
   * The template is a file a human copies; the contract is what the sub-agent reads.
   * Fixing only the first leaves the next Plan agent free to invent the table again,
   * which is how it got there. So the generated contract has to SAY it.
   */
  test("the generated contract tells the Plan agent where a story's status lives", () => {
    const contract = renderPlanSchemaContract();
    expect(contract).toContain(`${STORIES_DIR}/<id>.md`);
    expect(contract.toLowerCase()).toContain("do not restate");
  });
});

/**
 * `tldrx plan schema` — the contract, printed for a human (#71).
 *
 * #48 deleted `templates/story.md` and `templates/epic.md`. They were WRONG to keep
 * (nothing read them, so nothing kept them honest — the tests above are the whole
 * argument), but they were answering a real question: what shape does a story file
 * take? After #48 the only reader of the generated contract was `checkContracts.ts`,
 * which splices it into the Plan stage's prompt, so the answer existed only inside a
 * prompt an agent sees and a person does not.
 *
 * This is that answer, addressed to the person — and it is deliberately a RENDERER of
 * `renderPlanSchemaContract()`, not a second copy of it. Every test here asserts the
 * printed bytes ARE the contract's, because a `plan schema` that could disagree with
 * the check would be `templates/story.md` again under a new name.
 */
describe("`tldrx plan schema` prints the contract a human has to write to (#71)", () => {
  const BIN = join(FRAMEWORK_ROOT, "bin", "tldrx.ts");

  async function tldrxIn(cwd: string, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn(["bun", BIN, ...args], { stdout: "pipe", stderr: "pipe", cwd, env: noSpawnEnv() });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code: await proc.exited, stdout, stderr };
  }

  /** A directory with no `.tldrx/` in it or above it that this command may lean on. */
  function bare(): string {
    const dir = mkdtempSync(join(tmpdir(), "tldrx-plan-schema-"));
    dirs.push(dir);
    return dir;
  }

  test("with no selector it prints the SAME bytes the Plan agent is given", async () => {
    const { code, stdout } = await tldrxIn(bare(), "plan", "schema");
    expect(code).toBe(0);
    expect(stdout).toBe(`${renderPlanSchemaContract()}\n`);
  });

  test("all three schemas are in it — story, epic and the wave file", async () => {
    const { stdout } = await tldrxIn(bare(), "plan", "schema");
    expect(stdout).toContain("stories/<id>.md");
    expect(stdout).toContain("epics/<id>.md");
    expect(stdout).toContain("waves.yml");
    // The caps a file is refused for, at the value the check currently uses.
    expect(stdout).toContain("### Caps");
    // What it must NOT carry: the `## ` heading, which is `checkContracts.ts`'s to
    // add. Printing it here would make this a second author of the prompt's shape.
    expect(stdout).not.toContain(`## ${PLAN_CONTRACT_HEADING}`);
  });

  for (const [flag, key] of [["--story", "story"], ["--epic", "epic"], ["--waves", "waves"]] as const) {
    test(`${flag} prints just that example — the file, not the essay`, async () => {
      const { code, stdout } = await tldrxIn(bare(), "plan", "schema", flag);
      expect(code).toBe(0);
      const example = planContractExamples()[key];
      expect(stdout).toBe(`${example.trimEnd()}\n`);
      // One example, not the surrounding contract: the rule tables stay behind.
      expect(stdout).not.toContain("| key | what the check enforces |");
    });
  }

  test("the printed story example is one `validateStoryFile` accepts, byte for byte", async () => {
    const { stdout } = await tldrxIn(bare(), "plan", "schema", "--story");
    // Not "resembles the contract": the bytes a human copies off their terminal go
    // through the very validator the `plan` check runs.
    const parsed = validateStoryFile(stdout, new Set(planContractExamples().dodCommands));
    expect(parsed.validation.issues).toEqual([]);
    expect(parsed.story).not.toBeNull();
  });

  test("two selectors are a usage error, because the answer would be ambiguous", async () => {
    const { code, stderr } = await tldrxIn(bare(), "plan", "schema", "--story", "--epic");
    expect(code).toBe(1);   // EXIT_USAGE
    expect(stderr).toContain("one of");
  });

  test("it needs NO workspace and NO run — the question comes before either exists", async () => {
    const dir = bare();
    const { code } = await tldrxIn(dir, "plan", "schema");
    expect(code).toBe(0);
    // Read-only about the world: nothing created, in a directory that had nothing.
    expect(readdirSync(dir)).toEqual([]);
  });
});
