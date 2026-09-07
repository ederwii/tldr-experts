/**
 * `docs/spec.md` §2.9 publishes the event enum as a CLOSED set — "an unknown type is a
 * validation error" — and `validateEvent` really does refuse one (`Event.ts`, `requireEnum`
 * against `EVENT_TYPES`). That makes the spec's list a promise about what a reader may be
 * handed, not a summary: a name missing from it is a line a conforming reader was told could
 * never arrive, and a name in it that the code does not emit is a shape nobody will ever see.
 *
 * Nothing asserted the two agreed, and they had drifted: on 2026-09-07, with wave 4's two
 * new types added to the enum, §2.9's list was missing FIVE of them — `gate.policy_changed`,
 * `result.unreadable`, `operator_note` (all three predating this wave), `fact.conflict_raised`
 * and `story.touches_widened`. Three of those five were described in the spec's own prose
 * elsewhere and still absent from the enum paragraph that claims to be closed.
 *
 * So: the list and the enum are compared in ORDER, and adding a type to `EVENT_TYPES` without
 * naming it in §2.9 is a red gate rather than a documentation debt somebody notices later.
 *
 * Cheap and hermetic: reads one file, imports one constant, spawns nothing.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";
import { EVENT_TYPES } from "../src/core/events/Event.ts";

const SPEC = readFileSync(join(FRAMEWORK_ROOT, "docs", "spec.md"), "utf8");

/**
 * The `**Type enum:**` paragraph of §2.9, verbatim — from its marker to the blank line that
 * ends the paragraph. Anchored inside §2.9 rather than on the marker alone, so a second
 * "Type enum:" anywhere else in the spec could not silently become the thing under test.
 */
function typeEnumParagraph(): string {
  const section = SPEC.split("### 2.9 ")[1];
  expect(section, "no `### 2.9` heading in docs/spec.md").toBeDefined();
  const rest = (section ?? "").split("### 2.10 ")[0] ?? "";
  const marker = rest.indexOf("**Type enum:**");
  expect(marker, "no `**Type enum:**` paragraph inside §2.9").toBeGreaterThanOrEqual(0);
  const body = rest.slice(marker);
  const end = body.indexOf("\n\n");
  return end === -1 ? body : body.slice(0, end);
}

/** Every backticked token in that paragraph, in the order the paragraph names them. */
function documentedTypes(): readonly string[] {
  return [...typeEnumParagraph().matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? "");
}

describe("docs/spec.md §2.9's closed event list is the EVENT_TYPES enum", () => {
  test("the spec names every type the code can write, in enum order", () => {
    expect(documentedTypes()).toEqual([...EVENT_TYPES]);
  });

  test("the paragraph still says the set is closed", () => {
    expect(typeEnumParagraph()).toContain("Closed set: an\nunknown type is a validation error.");
  });
});
