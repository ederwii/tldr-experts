import { describe, expect, test } from "bun:test";
import {
  buildModel, clientRenderer, dashApp, dashEscape, dashText, liveScript, renderDashboard,
  DASHBOARD_JS,
} from "../src/core/dashboard/index.ts";
import { escapeHtml } from "../src/core/markdown/index.ts";
import { money } from "../src/core/replay/index.ts";
import { VIEWS_FIXTURE, VIEWS_NOW } from "./fixtures/views/tempViews.ts";

/**
 * The live page and the static export must never be two templates.
 *
 * `render.ts` is the only markup in the product, and the live page gets it by
 * serialising those functions (`clientRenderer()`). This file is the guard on
 * that: it evaluates the serialised source in a scope with NOTHING in it, feeds
 * it the model as it would arrive over the wire (a JSON round trip), and demands
 * byte-identical output. A template function that closes over a module constant,
 * or one that was added to the file but not to the serialised list, fails here
 * rather than as a blank page in someone's browser.
 */
const GENERATED_AT = "2026-09-02T08:00:00Z";
const staticModel = buildModel(VIEWS_FIXTURE, GENERATED_AT, { now: VIEWS_NOW });
const liveModel = buildModel(VIEWS_FIXTURE, GENERATED_AT, { now: VIEWS_NOW, live: true });

/** The client renderer, evaluated exactly as the browser would evaluate it. */
function evaluateClientRenderer(): (model: unknown) => string {
  const factory = new Function(`${clientRenderer()}\nreturn dashApp;`) as () => (model: unknown) => string;
  return factory();
}

describe("one renderer, two sides of the wire", () => {
  test("the serialised renderer produces the same markup as the server's", () => {
    const overTheWire: unknown = JSON.parse(JSON.stringify(liveModel));
    expect(evaluateClientRenderer()(overTheWire)).toBe(dashApp(liveModel));
  });

  test("it carries no type annotation and no import into the browser", () => {
    const source = clientRenderer();
    expect(source).not.toContain("import ");
    expect(source).not.toContain(": string)");
    expect(source).not.toContain("readonly ");
    expect(source.startsWith("function ")).toBe(true);
  });

  test("every function it needs is in the serialised set", () => {
    // A missing entry shows up as a ReferenceError the moment the page renders.
    expect(() => evaluateClientRenderer()(JSON.parse(JSON.stringify(staticModel)))).not.toThrow();
  });

  test("the live page inlines that renderer and listens; the static page does neither", () => {
    const live = renderDashboard(liveModel);
    expect(live).toContain("function dashApp(");
    expect(live).toContain("new EventSource(\"/events\")");
    expect(live).toContain('fetch("/model.json"');
    expect(live).toContain("Live and read-only");

    const still = renderDashboard(staticModel);
    expect(still).not.toContain("function dashApp(");
    expect(still).not.toContain("EventSource");
  });
});

describe("the inlined scripts", () => {
  test("both parse as JavaScript — a syntax error here is a page that does nothing", () => {
    // `new Function` parses without executing, so `document` never has to exist.
    expect(() => new Function(DASHBOARD_JS)).not.toThrow();
    expect(() => new Function(liveScript())).not.toThrow();
    expect(() => new Function(`${clientRenderer()}\n${DASHBOARD_JS}\n${liveScript()}`)).not.toThrow();
  });

  test("the filter script is re-callable, because the live page replaces the markup", () => {
    expect(DASHBOARD_JS).toContain("function tldrxWireFilter()");
    expect(liveScript()).toContain("tldrxWireFilter();");
  });
});

describe("the renderer's own escapers", () => {
  test("dashEscape matches the core escapeHtml character for character", () => {
    for (const sample of ["<script>", "a & b", `"quoted"`, "it's", "a>b", "plain", "&amp;", "«ok»"]) {
      expect(dashEscape(sample)).toBe(escapeHtml(sample));
    }
  });

  test("dashText leaves quotes alone — a shell command in a <pre> should read like one", () => {
    expect(dashText(`tldrx answer Q2 "all time"`)).toBe(`tldrx answer Q2 "all time"`);
    expect(dashText("<b> & </b>")).toBe("&lt;b&gt; &amp; &lt;/b&gt;");
  });
});

describe("the renderer's money formatting", () => {
  test("agrees with replay's money()", () => {
    const overTheWire = JSON.parse(JSON.stringify(liveModel)) as typeof liveModel;
    for (const run of overTheWire.runs) {
      expect(dashApp(overTheWire)).toContain(money(run.spentUsd));
      expect(dashApp(overTheWire)).toContain(money(run.ceilingUsd));
    }
    expect(money(null)).toBe("$?");
  });
});
