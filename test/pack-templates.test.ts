/**
 * The shipped packs obey one format (stack packs design §4.1) and the shape test is the
 * thing that keeps them honest: interrogative Checks with a `verify:` hint, Defaults that
 * name what overrides them, size caps, no machine paths, no workspace names. Content is
 * a person's judgement; format is the framework's.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";
import { OVERLAY_RULES, PACK_LANGUAGES } from "../src/core/detect/overlays.ts";
import {
  CHECKS_HEADING, DEFAULTS_HEADING, OVERRIDDEN_BY, VERIFY_HINT,
} from "../src/core/experts/packSections.ts";
import {
  OVERLAY_MAX_BYTES, OVERLAY_TEMPLATES_DIR, PACK_BODY_MAX_BYTES, PACK_TEMPLATES_DIR,
  overlayTemplatePath, packBodyPath,
} from "../src/core/experts/packTemplates.ts";
import { section } from "../src/core/experts/expertDocument.ts";
import { byteLength } from "../src/core/experts/expertKnowledge.ts";

/** The workspace file a Check may name; naming it obliges the empty-slot clause. */
const WORKSPACE_FILE = ".tldrx/workspace.yml";

/**
 * Every `.ts` / `.mts` / `.cts` file under `dir`, repo-relative and `/`-separated.
 *
 * Deliberately a plain recursive readdir and NOT `walkFiles`: that walker exists to scan a
 * user's repo cheaply, so its `SKIPPED_DIRS` drops build output — including any directory
 * literally named `build`. `src/core/build/` is twelve real source files, and measured,
 * `walkFiles("src")` returned 409 of the 421 files on disk with none of them under
 * `core/build/`. A guard that silently skips source is worse than no guard.
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

/** A Check reduced to its words, so punctuation and casing stop hiding a verbatim repeat. */
function checkWords(check: string): string {
  return check.toLowerCase().replace(/[^a-z]+/g, " ").trim();
}

/** Bullets of a section, continuation lines joined — a wrapped bullet is one bullet. */
export function bullets(body: string): readonly string[] {
  const out: string[] = [];
  for (const line of body.split("\n")) {
    if (/^- /.test(line)) out.push(line.slice(2).trim());
    else if (/^\s+\S/.test(line) && out.length > 0) out[out.length - 1] = `${out[out.length - 1]} ${line.trim()}`;
  }
  return out;
}

/** Every rule a pack file — body or overlay — must satisfy. Shared with the overlay describe below. */
export function assertPackShape(label: string, text: string, maxBytes: number): void {
  const lines = text.split("\n");
  expect(lines[0], `${label}: first line is the H1`).toMatch(/^# \S/);
  expect(text.endsWith("\n"), `${label}: ends with a newline`).toBe(true);
  expect(byteLength(text), `${label}: size cap`).toBeLessThanOrEqual(maxBytes);

  const h2s = lines.filter((line) => line.startsWith("## ")).map((line) => line.slice(3).trim());
  expect(h2s, `${label}: exactly the two H2s, Defaults first`).toEqual([DEFAULTS_HEADING, CHECKS_HEADING]);
  expect(lines.some((line) => /^#{3,} /.test(line)), `${label}: no H3 or deeper`).toBe(false);

  const scope = lines.slice(1, lines.indexOf(`## ${DEFAULTS_HEADING}`)).filter((line) => line.trim() !== "");
  expect(scope.length, `${label}: one scope paragraph between the H1 and Defaults`).toBeGreaterThan(0);
  expect(scope.some((line) => line.startsWith("- ")), `${label}: the scope is prose, not bullets`).toBe(false);

  const defaults = bullets(section(text, DEFAULTS_HEADING));
  expect(defaults.length, `${label}: at least one Default`).toBeGreaterThan(0);
  for (const item of defaults) {
    // "Ends with" is asserted as an end, not as a containment. A regex that merely finds
    // the marker somewhere passes a bullet that names its override in the middle and then
    // trails off into another sentence — exactly the shape this format exists to forbid,
    // because a reader takes everything after the marker to BE the overriding signal.
    //
    // Three assertions, because one is not enough: the marker appears exactly once; the
    // signal starts right after it; and the signal contains NO SENTENCE BREAK and does not
    // end in a full stop. The sentence-break ban is what actually anchors the end — without
    // it, `— overridden by: the tsconfig. And always keep the build green` passes, and a
    // reader would take that trailing sentence for part of the signal.
    //
    // A "the marker is the last `— ` in the bullet" rule was considered and MEASURED to be
    // wrong: two Defaults in `python.md` legitimately continue their signal with an em-dash
    // list (`— overridden by: the config files already committed — \`setup.cfg\`, …`), so
    // that rule would redden correct prose. `. ` is the discriminator — a full stop plus a
    // space starts a new sentence, while `tox.ini` and `package.json` never contain one.
    const markers = item.split(OVERRIDDEN_BY).length - 1;
    expect(markers, `${label}: exactly one "${OVERRIDDEN_BY}" per Default — ${item}`).toBe(1);
    const signal = item.slice(item.indexOf(OVERRIDDEN_BY) + OVERRIDDEN_BY.length);
    expect(signal, `${label}: Default names a signal after "${OVERRIDDEN_BY}" — ${item}`).toMatch(/^ \S/);
    expect(signal, `${label}: the signal is the END of the Default, not a clause inside it — ${item}`).toMatch(/[^\s.]$/);
    expect(signal, `${label}: no sentence break inside the signal — the signal IS the end — ${item}`).not.toMatch(/\.\s/);
  }
  const checks = bullets(section(text, CHECKS_HEADING));
  expect(checks.length, `${label}: at least one Check`).toBeGreaterThan(0);
  for (const item of checks) {
    expect(item, `${label}: Check must carry a "${VERIFY_HINT}" hint`).toContain(VERIFY_HINT);
    expect(item, `${label}: a Check is a question`).toContain("?");
  }

  // A Check that leans on a workspace-declared command must also say what to do when that
  // slot is empty, or "run the lint command" passes quietly on a workspace declaring none.
  // Conditional on purpose: an overlay that names no workspace command is correct — asking
  // whether the commands are green is the LANGUAGE BODY's job, and repeating it per overlay
  // is what made a reader meet the same bullet once per detected framework.
  if (text.includes(WORKSPACE_FILE)) {
    expect(text, `${label}: a Check naming ${WORKSPACE_FILE} must also say what to do when that slot is empty`)
      .toMatch(/leaves (?:that|a) slot empty/);
  }

  for (const banned of ["/Users/", "C:\\", "~/", "/home/"]) {
    expect(text, `${label}: no machine path (${banned})`).not.toContain(banned);
  }
  expect(text, `${label}: version-agnostic — no "vNN" or "version NN" in prose`).not.toMatch(/\b(?:v\d+(?:\.\d+)*|version \d+)\b/i);
}

describe("language pack bodies", () => {
  test("one body ships per pack language, and nothing else sits beside them", () => {
    const files = readdirSync(PACK_TEMPLATES_DIR).filter((entry) => entry.endsWith(".md")).sort();
    expect(files).toEqual([...PACK_LANGUAGES].map((lang) => `${lang}.md`).sort());
  });

  for (const lang of PACK_LANGUAGES) {
    test(`${lang}.md has the §4.1 shape and fits in ${String(PACK_BODY_MAX_BYTES)} bytes`, () => {
      const path = packBodyPath(lang);
      expect(existsSync(path), path).toBe(true);
      assertPackShape(`${lang}.md`, readFileSync(path, "utf8"), PACK_BODY_MAX_BYTES);
    });
  }

  test("a body never carries front matter — the expert's own front matter is preserved on apply", () => {
    for (const lang of PACK_LANGUAGES) {
      expect(readFileSync(packBodyPath(lang), "utf8").startsWith("---"), lang).toBe(false);
    }
  });
});

describe("framework overlays mirror the detection table one-to-one (one derivation)", () => {
  const ids = OVERLAY_RULES.map((rule) => rule.id).sort();

  /**
   * `src/core/detect/overlays.ts` is the table. `src/core/detect/stack.ts` is excluded too,
   * and only it: its `react` / `vite` / `expo` / `next` literals are the PRE-EXISTING
   * framework list behind `workspace.yml`'s `stack` field — a different concept that
   * happens to share one spelling with an overlay id, not a second copy of this table.
   * The two naming schemes are tracked by issue #152; nothing here edits that file.
   */
  const MAY_SPELL_AN_ID: ReadonlySet<string> = new Set(["core/detect/overlays.ts", "core/detect/stack.ts"]);

  test("every rule has a template, every template has a rule, and each one ships", () => {
    expect(ids.length, "the detection table names at least one overlay").toBeGreaterThan(0);
    const files = readdirSync(OVERLAY_TEMPLATES_DIR)
      .filter((entry) => entry.endsWith(".md"))
      .map((entry) => entry.replace(/\.md$/, ""))
      .sort();
    expect(files).toEqual(ids);
    // Shipment guard: an empty overlays directory still hashes to a valid-looking
    // `pack: <lang>@<hash>`, so every file is asserted present by name, never counted.
    for (const id of ids) {
      expect(existsSync(overlayTemplatePath(id)), `overlays/${id}.md ships`).toBe(true);
    }
  });

  for (const id of OVERLAY_RULES.map((rule) => rule.id)) {
    test(`overlays/${id}.md has the §4.1 shape and fits in ${String(OVERLAY_MAX_BYTES)} bytes`, () => {
      const path = overlayTemplatePath(id);
      expect(existsSync(path), path).toBe(true);
      assertPackShape(`overlays/${id}.md`, readFileSync(path, "utf8"), OVERLAY_MAX_BYTES);
    });
  }

  /**
   * The table is the ONE list of ids. A second copy in a renderer, a status printer or a
   * docs generator would be #80 again under a new name, so the guard is on the literal:
   * no other file under `src/` may spell an overlay id in quotes. Tests and templates are
   * allowed — they are the readers this pins for.
   */
  test("no file under src/ other than the table spells an overlay id in quotes or backticks", () => {
    const srcRoot = join(FRAMEWORK_ROOT, "src");
    const files = sourceFilesUnder(srcRoot);
    expect(files.length, "the enumeration found source files at all").toBeGreaterThan(0);
    // The blind spot this guard was rebuilt around: `walkFiles` skips any directory named
    // `build`, and `src/core/build/` holds real source. If that directory is ever renamed,
    // this assertion fails loudly rather than the guard going quietly half-blind again.
    expect(
      files.some((file) => file.startsWith("core/build/")),
      "the enumeration reaches src/core/build/, which the shared repo walker skips",
    ).toBe(true);

    const offenders: string[] = [];
    for (const file of files) {
      if (MAY_SPELL_AN_ID.has(file)) continue;
      const text = readFileSync(join(srcRoot, file), "utf8");
      for (const id of ids) {
        // Quotes catch a copied constant; backticks catch a copy that arrived as prose in a
        // doc comment and is one edit away from becoming a constant.
        for (const spelling of [`"${id}"`, `'${id}'`, `\`${id}\``]) {
          if (text.includes(spelling)) offenders.push(`${file}: ${spelling}`);
        }
      }
    }
    expect(offenders).toEqual([]);
    // Not vacuous: the table itself does spell them.
    expect(readFileSync(join(srcRoot, "core/detect/overlays.ts"), "utf8")).toContain(`"${ids[0] ?? ""}"`);
    expect(relative(FRAMEWORK_ROOT, OVERLAY_TEMPLATES_DIR)).toBe("templates/experts/stack/overlays");
  });

  /**
   * `composePackBody` emits the body in full and then each overlay whole, so a Check the
   * body already asks is read again once per detected overlay — five times on a repo with
   * four of them. Overlays carry framework-specific questions; the generic ones (are the
   * commands green, can each new test fail, did the lockfile move with the manifest) belong
   * to the language body and are asked there once.
   *
   * The pin is on VERBATIM repetition, normalised for punctuation and case. A paraphrase
   * still needs a human reviewer — this catches the copy, which is what actually happened.
   */
  test("no overlay Check repeats a Check the language body already asks", () => {
    const bodyChecks = new Map<string, string>();
    for (const lang of PACK_LANGUAGES) {
      for (const check of bullets(section(readFileSync(packBodyPath(lang), "utf8"), CHECKS_HEADING))) {
        bodyChecks.set(checkWords(check), `${lang}.md`);
      }
    }
    expect(bodyChecks.size, "not vacuous: the bodies do carry Checks").toBeGreaterThan(0);

    const repeats: string[] = [];
    for (const id of ids) {
      for (const check of bullets(section(readFileSync(overlayTemplatePath(id), "utf8"), CHECKS_HEADING))) {
        const from = bodyChecks.get(checkWords(check));
        if (from !== undefined) repeats.push(`overlays/${id}.md repeats ${from}: ${check}`);
      }
    }
    expect(repeats).toEqual([]);
  });
});

/**
 * The can-it-fail Check is asked of the reviewer, so it asks for a READ (gh #182).
 *
 * Two dates, one Check. On 2026-09-07 the instrument shrank from the declared suite to
 * the one test file that covers the broken line (`c7ce90f`) — measured over a week of
 * unattended runs on three real workspaces, where a host paid one whole suite per
 * mutation, against a suite of 11,929 tests over 855 files in one of them.
 *
 * That fixed the cost and left the reader wrong. A pack's `## Checks` are rendered into
 * the reviewer prompt under `## Stack checks` and asked of the DIFF, and the reviewer's
 * allowance is `Read`, `Grep`, `Glob`, `Bash(git diff *)` (`REVIEWER_TOOLS`) — the same
 * prompt tells it "you have no write tool". "Change the line under test and re-run" is a
 * write and a test run, so the role being asked could not perform it, and a reviewer that
 * cannot run a check still answers it — from reading, which is the worse outcome.
 *
 * So the mutation is the PRODUCER's, and lives in the developer's contract
 * (`build/prompts.ts` `MUTATION_PROOF_RULE`, pinned in `stack-packs-prompt.test.ts`).
 * What is left here is the reviewer's half, and it is a read: did the developer record it?
 */
describe("the can-it-fail Check asks the reviewer for a read, not a mutation", () => {
  const ASKS_FOR_THE_RECORD = "seen to fail";
  /** The imperatives the retired wording aimed at a role holding no pen. */
  const RETIRED = ["change the line under test", "re-run only that test's file", "re-run the test command declared"];

  for (const lang of PACK_LANGUAGES) {
    test(`${lang}.md asks whether the developer recorded it, and asks for nothing it cannot do`, () => {
      const text = readFileSync(packBodyPath(lang), "utf8");
      const check = bullets(section(text, CHECKS_HEADING))
        .find((item) => item.includes(ASKS_FOR_THE_RECORD));
      expect(check, `${lang}.md still asks about a test "${ASKS_FOR_THE_RECORD}"`).toBeDefined();
      // The verify: hint sends the reviewer to the one surface it holds — the diff.
      expect(check ?? "", `${lang}.md points the reviewer at the diff`).toContain("diff");
      for (const retired of RETIRED) {
        expect((check ?? "").toLowerCase(), `${lang}.md no longer asks the reviewer to ${retired}`)
          .not.toContain(retired);
      }
      // A missing record is a finding; answering from the test's own text is not an answer.
      expect(check ?? "", `${lang}.md says a new test with no record is a finding`).toContain("finding");
    });
  }

  test("no Check anywhere in a shipped pack body tells the reviewer to edit a file", () => {
    const offenders: string[] = [];
    for (const lang of PACK_LANGUAGES) {
      for (const check of bullets(section(readFileSync(packBodyPath(lang), "utf8"), CHECKS_HEADING))) {
        if (/\b(?:change|edit|rewrite|delete|break) the line\b/i.test(check)) offenders.push(`${lang}.md: ${check}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
