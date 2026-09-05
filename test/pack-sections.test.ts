/**
 * The pack grammar has exactly two headings and one composition rule (stack packs
 * design §4.1, §4.5). Everything that reads a pack — the prompt, the reviewer, the shape
 * test — imports these constants; nothing re-types them.
 *
 * Composition is ATOMIC per overlay (controller ruling on task 4): the body is always
 * included in full, then overlays are appended whole, in sorted-id order, while the
 * running total stays under the cap. The first overlay that does not fit — and every
 * later one — is left out whole; `truncateAtHeading`'s H2 cut is never applied inside an
 * overlay, only (defensively) to the body itself, because it would otherwise cut at an
 * overlay's own `## Defaults`/`## Checks` heading just as readily as the pack body's.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHECKS_HEADING, DEFAULTS_HEADING, checksOf, composePackBody, OVERLAYS_DIRNAME, overlayMarker,
  PACK_MAX_BYTES, readOverlayFiles,
} from "../src/core/experts/packSections.ts";
import { hashTemplates, OVERLAY_MAX_BYTES, PACK_BODY_MAX_BYTES, templatesHash } from "../src/core/experts/packTemplates.ts";
import { byteLength } from "../src/core/experts/expertKnowledge.ts";

const BODY = [
  "---", "name: typescript-stack", "kind: stack", "---", "",
  "# TypeScript", "", "Scope paragraph.", "",
  `## ${DEFAULTS_HEADING}`, "", "- Strict on. — overridden by: tsconfig.json compilerOptions.strict", "",
  `## ${CHECKS_HEADING}`, "", "- Any `any`? verify: grep for `: any`", "",
].join("\n");

function overlay(id: string, filler = ""): { id: string; text: string } {
  return {
    id,
    text: [`# ${id}`, "", "Scope.", "", `## ${DEFAULTS_HEADING}`, "", `- d — overridden by: x${filler}`, "",
      `## ${CHECKS_HEADING}`, "", "- c verify: y", ""].join("\n"),
  };
}

describe("the headings", () => {
  test("are the exact strings the spec names", () => {
    expect(DEFAULTS_HEADING).toBe("Defaults (when the repo is silent)");
    expect(CHECKS_HEADING).toBe("Checks (always asked in review)");
    expect(OVERLAYS_DIRNAME).toBe("overlays");
    expect(PACK_MAX_BYTES).toBe(24 * 1024);
    expect(PACK_BODY_MAX_BYTES).toBe(8 * 1024);
    expect(OVERLAY_MAX_BYTES).toBe(6 * 1024);
  });
});

describe("composePackBody", () => {
  test("appends every overlay after the body, sorted by id, each under its marker", () => {
    const composed = composePackBody(BODY, [overlay("react"), overlay("aspnet-controllers")]);
    expect(composed.inlined).toEqual(["aspnet-controllers", "react"]);
    expect(composed.notInlined).toEqual([]);
    expect(composed.truncated).toBe(false);
    expect(composed.text.indexOf(overlayMarker("aspnet-controllers"))).toBeLessThan(composed.text.indexOf(overlayMarker("react")));
    expect(composed.text.startsWith("---\nname: typescript-stack")).toBe(true);
  });

  test("no overlays ⇒ the body, trimmed, with one trailing newline", () => {
    expect(composePackBody(BODY, []).text).toBe(`${BODY.trimEnd()}\n`);
  });

  test("past the cap, overlays are dropped ATOMICALLY at overlay boundaries, in sorted order, and named in a marker", () => {
    // maxBytes fits the body plus alpha's whole chunk (with a little slack), but not
    // beta's on top of that — so beta, and zeta after it, are left out WHOLE. Neither is
    // cut mid-overlay: this is the case the brief's `zeta`-filler truncation test could
    // never pass (truncateAtHeading would cut at the overlay's OWN `## Checks` line).
    const alpha = overlay("alpha");
    const beta = overlay("beta");
    const zeta = overlay("zeta", "x".repeat(3000));
    const withAlphaOnly = composePackBody(BODY, [alpha]);
    expect(withAlphaOnly.notInlined).toEqual([]);
    const maxBytes = byteLength(withAlphaOnly.text) + 10;

    const composed = composePackBody(BODY, [alpha, beta, zeta], maxBytes);

    expect(composed.inlined).toEqual(["alpha"]);
    expect(composed.notInlined).toEqual(["beta", "zeta"]);
    // Nothing was CUT — beta and zeta were left out WHOLE, and `notInlined` already says
    // so. `truncated` reports only a real cut of the body itself (none happened here), so
    // it stays false; a caller wanting "was anything left out at all" checks both fields.
    expect(composed.truncated).toBe(false);
    // alpha is present WHOLE, its own Checks section included — not a same-content
    // overlay that got dropped, since only alpha is inlined.
    expect(composed.text).toContain(overlayMarker("alpha"));
    expect(composed.text).toContain("- c verify: y");
    // beta and zeta are absent entirely — no marker, no partial content.
    expect(composed.text).not.toContain(overlayMarker("beta"));
    expect(composed.text).not.toContain(overlayMarker("zeta"));
    expect(byteLength(composed.text)).toBeLessThanOrEqual(maxBytes + 100);
    expect(composed.text.endsWith("(not inlined: 2 overlays — beta, zeta)\n")).toBe(true);
  });

  test("a cap smaller than the body still yields the body IN FULL (not truncated — no cut point fit), with the dropped overlay named in a marker", () => {
    const composed = composePackBody(BODY, [overlay("react")], 10);
    expect(composed.text).toBe(`${BODY.trimEnd()}\n\n(not inlined: 1 overlay — react)\n`);
    expect(composed.notInlined).toEqual(["react"]);
    // The body was kept WHOLE (no `## ` boundary fit under 10 bytes, so `truncateAtHeading`
    // fell back to the untouched body) — nothing was actually cut, so `truncated` is false
    // even though the cap was blown and an overlay got left out.
    expect(composed.truncated).toBe(false);
  });

  test("a body that genuinely exceeds the cap IS cut by truncateAtHeading, and only THAT counts as truncated", () => {
    const bigBody = [
      "# Big", "", "Scope.", "",
      `## ${DEFAULTS_HEADING}`, "", "- d — overridden by: x", "",
      `## ${CHECKS_HEADING}`, "", `- c verify: y${"x".repeat(2000)}`, "",
    ].join("\n");
    const fullBig = `${bigBody.trimEnd()}\n`;
    // Everything up to (not including) the `## Checks` heading — the largest whole
    // section `truncateAtHeading` can keep once the Checks section alone blows the cap.
    const beforeChecks = fullBig.slice(0, fullBig.indexOf(`## ${CHECKS_HEADING}`)).replace(/\n+$/, "\n");
    const maxBytes = byteLength(beforeChecks) + 5;
    expect(maxBytes).toBeLessThan(byteLength(fullBig)); // sanity: the cap really is smaller

    const composed = composePackBody(bigBody, [], maxBytes);

    expect(composed.truncated).toBe(true);
    expect(composed.text).not.toContain(CHECKS_HEADING);
    expect(byteLength(composed.text)).toBeLessThan(byteLength(fullBig));
  });
});

describe("checksOf", () => {
  test("returns the Checks section of a pack (front matter tolerated) and empty when absent", () => {
    expect(checksOf(BODY)).toBe("- Any `any`? verify: grep for `: any`");
    expect(checksOf("# nothing\n\n## Other\n\n- x\n")).toBe("");
  });
});

describe("readOverlayFiles", () => {
  test("reads overlays/*.md sorted by id, ignores everything else, tolerates a missing dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "tldrx-pack-"));
    try {
      expect(readOverlayFiles(dir)).toEqual([]);
      mkdirSync(join(dir, OVERLAYS_DIRNAME));
      writeFileSync(join(dir, OVERLAYS_DIRNAME, "react.md"), "# react\n", "utf8");
      writeFileSync(join(dir, OVERLAYS_DIRNAME, "aspnet-controllers.md"), "# c\n", "utf8");
      writeFileSync(join(dir, OVERLAYS_DIRNAME, "notes.txt"), "no", "utf8");
      expect(readOverlayFiles(dir)).toEqual([
        { id: "aspnet-controllers", text: "# c\n" }, { id: "react", text: "# react\n" },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the templates hash", () => {
  test("is twelve hex chars, stable, and changes with content or path", () => {
    const a = hashTemplates([{ rel: "typescript.md", text: "# a\n" }]);
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(hashTemplates([{ rel: "typescript.md", text: "# a\n" }])).toBe(a);
    expect(hashTemplates([{ rel: "typescript.md", text: "# b\n" }])).not.toBe(a);
    expect(hashTemplates([{ rel: "javascript.md", text: "# a\n" }])).not.toBe(a);
    expect(templatesHash()).toMatch(/^[0-9a-f]{12}$/);
  });
});
