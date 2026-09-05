/**
 * The shipped packs obey one format (stack packs design §4.1) and the shape test is the
 * thing that keeps them honest: interrogative Checks with a `verify:` hint, Defaults that
 * name what overrides them, size caps, no machine paths, no workspace names. Content is
 * a person's judgement; format is the framework's.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { PACK_LANGUAGES } from "../src/core/detect/overlays.ts";
import {
  CHECKS_HEADING, DEFAULTS_HEADING, OVERRIDDEN_BY, VERIFY_HINT,
} from "../src/core/experts/packSections.ts";
import { PACK_BODY_MAX_BYTES, PACK_TEMPLATES_DIR, packBodyPath } from "../src/core/experts/packTemplates.ts";
import { section } from "../src/core/experts/expertDocument.ts";
import { byteLength } from "../src/core/experts/expertKnowledge.ts";

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
    expect(item, `${label}: Default must end with "${OVERRIDDEN_BY} <signal>"`).toMatch(new RegExp(`${OVERRIDDEN_BY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\S.*$`));
  }
  const checks = bullets(section(text, CHECKS_HEADING));
  expect(checks.length, `${label}: at least one Check`).toBeGreaterThan(0);
  for (const item of checks) {
    expect(item, `${label}: Check must carry a "${VERIFY_HINT}" hint`).toContain(VERIFY_HINT);
    expect(item, `${label}: a Check is a question`).toContain("?");
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
