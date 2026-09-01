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
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { validatePlan } from "../src/core/plan/validatePlan.ts";
import { TEMPLATES_DIR } from "../src/core/paths.ts";
import {
  PLAN_CONTRACT_HEADING, planContractExamples, renderPlanSchemaContract,
} from "../src/core/plan/schemaContract.ts";

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

describe("the shipped templates are held to the same contract (#48)", () => {
  /**
   * `templates/story.md` and `templates/epic.md` state the Plan front-matter schema, are
   * shipped in the npm package (`package.json` → `files`), and NOTHING in `src/` reads
   * either one. They are a second copy of a contract whose first copy is computed from
   * `STORY_KEYS` / `EPIC_KEYS`, and they were correct only by luck: add a required key
   * and `schemaContract.ts` stops compiling — `Record<StoryKey, Field>` sees to that —
   * while these two say nothing at all. A human then opens the template, writes a story
   * the check refuses, and the framework looks broken.
   *
   * This is the guard half of #48, not the packaging half. Whether these files should be
   * generated from `planContractExamples()` or deleted outright is the owner's call, and
   * deleting a shipped file is not a decision a drift test gets to make. Until then they
   * go red the moment they disagree with the schema.
   *
   * The dod commands are read out of each template rather than asserted against a
   * workspace: a template has no `workspace.yml` to be verbatim against, and #48 is about
   * the FRONT MATTER. What is checked is that the block exists and parses.
   */
  const read = (name: string): string => readFileSync(join(TEMPLATES_DIR, name), "utf8");

  test("templates/story.md validates through the same `validateStoryFile` the check runs", () => {
    const text = read("story.md");
    const dod = parseDodBlock(parseFrontMatter(text).frontMatter.body);
    expect(dod.present).toBe(true);
    expect(dod.commands.length).toBeGreaterThan(0);

    const parsed = validateStoryFile(text, new Set(dod.commands));
    expect(parsed.validation.issues).toEqual([]);
    expect(parsed.story).not.toBeNull();
  });

  test("templates/story.md's keys ARE `STORY_KEYS`, in order — no extra, none missing", () => {
    expect(keysOf(read("story.md"))).toEqual([...STORY_KEYS]);
  });

  test("templates/epic.md validates through the same `validateEpicFile` the check runs", () => {
    const parsed = validateEpicFile(read("epic.md"));
    expect(parsed.validation.issues).toEqual([]);
    expect(parsed.epic).not.toBeNull();
  });

  test("templates/epic.md's keys ARE `EPIC_KEYS`, in order", () => {
    expect(keysOf(read("epic.md"))).toEqual([...EPIC_KEYS]);
  });

  /**
   * The `status:` line in both templates carries the enum as a trailing comment. That
   * comment is prose — the validator never reads it — so it is exactly the kind of copy
   * that goes stale silently and then teaches a reader a status that does not exist.
   */
  test("the enum each template spells out beside `status:` is the real `PLAN_STATUSES`", () => {
    for (const name of ["story.md", "epic.md"]) {
      const line = read(name).split("\n").find((l) => l.trimStart().startsWith("status:"));
      expect(`${name}: ${line ?? "NO status: LINE"}`).toContain(PLAN_STATUSES.join(" | "));
    }
  });
});
