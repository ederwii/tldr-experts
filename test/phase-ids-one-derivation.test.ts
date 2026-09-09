/**
 * One phase list, one derivation (#187, AGENTS.md §7).
 *
 * The five §1 phase folders were written out as an ordered array literal in THREE
 * places at cd8721a — `PHASE_IDS` (`core/run/workflowPreset.ts`, which `--phase 3`
 * indexes into), `QUESTION_PHASES` (`core/run/questionCards.ts`, which the card
 * renderer and `closeRun`'s open-question walk read) and an unnamed inline literal
 * in `questionFiles` (`cli/commands/questions.ts`, which `questions lint` walks).
 * Nothing pinned them equal: `grep -rln "QUESTION_PHASES\|PHASE_IDS" test/` exited
 * 1. Three lists that must always agree, in three files, two of which do not import
 * each other, is a silent divergence waiting for the first phase rename — and the
 * doc comment over `QUESTION_PHASES` already CLAIMED it was "kept in one place so
 * the two verbs of `tldrx questions` cannot disagree", which was not true of the
 * lint verb.
 *
 * The guard here is on the SHAPE, not on the three names, for the reason
 * `map-citations.test.ts` gives about its own family: deleting a second copy does
 * not stop a third. A fourth list under a name this file never mentions would be
 * the same defect, so what is asserted is that only ONE file under `src/` writes
 * the ids out in order at all.
 *
 * It takes BOTH describes to cover the failure, which was measured by mutating the
 * collapse in each direction rather than assumed. Re-declare `QUESTION_PHASES` as an
 * identical literal and only the shape guard reddens (`offenders` names the file);
 * re-declare it as a DRIFTED literal — `06-ship` for `05-watch` — and the shape guard
 * goes quiet, because the pattern is built from `PHASE_IDS` and a drifted list no
 * longer matches it, while the equality guard reddens instead. A copy is caught
 * before it drifts, and a drift is caught even where the copy hid.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";
import { PHASE_IDS } from "../src/core/run/workflowPreset.ts";
import { QUESTION_PHASES } from "../src/core/run/questionCards.ts";

/** The one file allowed to spell the list out. Everything else imports it. */
const THE_ONE_LIST = "core/run/workflowPreset.ts";

/**
 * Every `.ts` / `.mts` / `.cts` file under `dir`, repo-relative and `/`-separated.
 *
 * A plain recursive readdir on purpose, not `walkFiles`: that walker drops any
 * directory named `build`, and `src/core/build/` is real source. The same blind
 * spot is called out in `pack-templates.test.ts`, and the non-vacuity assertion
 * below pins that this enumeration reaches it.
 */
function sourceFilesUnder(dir: string, base = ""): readonly string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = base === "" ? entry.name : `${base}/${entry.name}`;
    if (entry.isDirectory()) out.push(...sourceFilesUnder(join(dir, entry.name), rel));
    else if (/\.(?:ts|mts|cts)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

/**
 * The ordered-list spelling, BUILT FROM `PHASE_IDS` rather than typed out — a
 * hand-written pattern here would be a fourth copy of the very thing being pinned.
 *
 * It matches the ids quoted (any of the three quote characters) and comma-separated
 * across any whitespace, so a literal wrapped over several lines still matches. It
 * deliberately does NOT match the ids used as path segments: `core/learn/chapters.ts`
 * spells all five inside `{runDir}/01-what/intent.md`-style keys and is not a second
 * list, which is why "the file contains all five ids" would be the wrong instrument.
 */
const Q = "[\"'`]";
const ORDERED_LIST = new RegExp(
  PHASE_IDS.map((id) => `${Q}${id.replace(/-/g, "\\-")}${Q}`).join("\\s*,\\s*"),
);

describe("the five phase ids are written out once (#187)", () => {
  const srcRoot = join(FRAMEWORK_ROOT, "src");
  const files = sourceFilesUnder(srcRoot);

  test("the enumeration is not vacuous and reaches the directory the shared walker skips", () => {
    expect(files.length).toBeGreaterThan(300);
    expect(files.some((file) => file.startsWith("core/build/"))).toBe(true);
    expect(files).toContain(THE_ONE_LIST);
  });

  test("the pattern can see a real list — it matches the one file that is allowed to have one", () => {
    expect(ORDERED_LIST.test(readFileSync(join(srcRoot, THE_ONE_LIST), "utf8"))).toBe(true);
  });

  test("no other file under src/ writes the phase ids out as an ordered list", () => {
    const offenders = files.filter(
      (file) => file !== THE_ONE_LIST && ORDERED_LIST.test(readFileSync(join(srcRoot, file), "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});

describe("the derived names still say the same thing", () => {
  /**
   * A guard, not a proof: this passed before the collapse too, because the copies
   * agreed on the day they were written. What it catches is the day one of them
   * stops being derived and drifts.
   */
  test("QUESTION_PHASES is PHASE_IDS, in the same order", () => {
    expect([...QUESTION_PHASES]).toEqual([...PHASE_IDS]);
  });

  /**
   * The consumers care about the ORDER, not just the membership: `--phase 3` is
   * `PHASE_IDS[2]` (`normalisePhase`, `workflowPreset.ts`), so a reorder that kept
   * the same five ids would silently move every numeric stage placement.
   */
  test("the list is the five §1 folders, in run order", () => {
    expect([...PHASE_IDS]).toEqual(["01-what", "02-how", "03-plan", "04-build", "05-watch"]);
  });
});
