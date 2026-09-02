import { describe, expect, test } from "bun:test";
import {
  buildModel, clientRenderer, dashEscape, dashMain, dashModelJson, dashRoute, dashSignature, dashText,
  liveScript, renderDashboard, DASHBOARD_JS,
} from "../src/core/dashboard/index.ts";
import type { DashUi, StageRowModel } from "../src/core/dashboard/index.ts";
import { escapeHtml } from "../src/core/markdown/index.ts";
import { describeGateSignature } from "../src/core/run/gateAuthority.ts";
import { money } from "../src/core/replay/index.ts";
import { VIEWS_FIXTURE, VIEWS_NOW } from "./fixtures/views/tempViews.ts";

/**
 * The typed renderer and the one that reaches the browser must never drift.
 *
 * `render.ts` is the only markup in the product. It is written in TypeScript so
 * `tsc --strict` holds it to `DashboardModel`, and it reaches the page by
 * serialising those functions (`clientRenderer()`). Nothing else renders — the
 * server ships an empty `<main>` — so this file is the guard on the half that
 * actually runs: it evaluates the serialised source in a scope with NOTHING in
 * it, feeds it the model as it arrives over the wire (a JSON round trip), and
 * demands byte-identical output against the typed original. A template function
 * that closes over a module constant, or one added to the file but not to the
 * serialised list, fails here rather than as a blank page in someone's browser.
 */
const GENERATED_AT = "2026-09-02T08:00:00Z";
const NOW_MS = VIEWS_NOW.getTime();
const UI: DashUi = { status: "all", sort: "updated" };
const staticModel = buildModel(VIEWS_FIXTURE, GENERATED_AT, { now: VIEWS_NOW });
const liveModel = buildModel(VIEWS_FIXTURE, GENERATED_AT, { now: VIEWS_NOW, live: true });

interface ClientRenderer {
  readonly dashMain: (model: unknown, ui: unknown, route: unknown, nowMs: number) => string;
  readonly dashRoute: (hash: string) => { view: string; id: string | null };
  readonly dashTitle: (model: unknown) => string;
  readonly dashNav: (model: unknown, view: string) => string;
  readonly dashTopMeta: (model: unknown) => string;
}

/** The client renderer, evaluated exactly as the browser would evaluate it. */
function evaluateClientRenderer(): ClientRenderer {
  const factory = new Function(
    `${clientRenderer()}
     return { dashMain: dashMain, dashRoute: dashRoute, dashTitle: dashTitle,
              dashNav: dashNav, dashTopMeta: dashTopMeta };`,
  ) as () => ClientRenderer;
  return factory();
}

/** The model as the page reads it back: JSON in, JSON out. */
function overTheWire(model: unknown): unknown {
  return JSON.parse(JSON.stringify(model));
}

const VIEWS = ["runs", "experts", "watchers", "faq"];

describe("one renderer, two sides of the transpiler", () => {
  test("the serialised renderer draws every view exactly as the typed one does", () => {
    const client = evaluateClientRenderer();
    const wire = overTheWire(liveModel);
    for (const view of VIEWS) {
      const route = { view, id: null };
      expect(client.dashMain(wire, UI, route, NOW_MS)).toBe(dashMain(liveModel, UI, route, NOW_MS));
    }
    for (const run of liveModel.runs) {
      const route = { view: "run", id: run.id };
      expect(client.dashMain(wire, UI, route, NOW_MS)).toBe(dashMain(liveModel, UI, route, NOW_MS));
    }
  });

  test("the chrome agrees too — the tab name, the meta line and the nav", () => {
    const client = evaluateClientRenderer();
    const wire = overTheWire(liveModel);
    expect(client.dashTitle(wire)).toBe("tldrx dashboard — workspace");
    expect(client.dashTopMeta(wire)).toContain("live");
    expect(client.dashNav(wire, "runs")).toContain('aria-current="page"');
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
    const client = evaluateClientRenderer();
    const wire = overTheWire(staticModel);
    for (const view of VIEWS) {
      expect(() => client.dashMain(wire, UI, { view, id: null }, NOW_MS)).not.toThrow();
    }
  });

  test("the runs filter is view state only — it never reaches the model", () => {
    const client = evaluateClientRenderer();
    const wire = overTheWire(liveModel);
    const all = client.dashMain(wire, { status: "all", sort: "updated" }, { view: "runs", id: null }, NOW_MS);
    const none = client.dashMain(wire, { status: "no-such-status", sort: "updated" }, { view: "runs", id: null }, NOW_MS);
    expect(all).not.toBe(none);
    expect(none).toContain("No runs with status");
    expect(overTheWire(liveModel)).toEqual(overTheWire(liveModel));
  });
});

describe("the hash router", () => {
  test("reads a view, a run, and falls back to the runs list", () => {
    expect(dashRoute("")).toEqual({ view: "runs", id: null });
    expect(dashRoute("#/experts")).toEqual({ view: "experts", id: null });
    expect(dashRoute("#/watchers")).toEqual({ view: "watchers", id: null });
    expect(dashRoute("#/nonsense")).toEqual({ view: "runs", id: null });
    expect(dashRoute("#/run/260901-scoreboard")).toEqual({ view: "run", id: "260901-scoreboard" });
    expect(dashRoute("#/run/a%20b")).toEqual({ view: "run", id: "a b" });
  });

  test("the serialised copy routes the same way", () => {
    const client = evaluateClientRenderer();
    for (const hash of ["", "#/experts", "#/faq", "#/nonsense", "#/run/260901-scoreboard"]) {
      expect(client.dashRoute(hash)).toEqual(dashRoute(hash));
    }
  });

  test("an unknown run id says so rather than rendering nothing", () => {
    const html = dashMain(liveModel, UI, { view: "run", id: "no-such-run" }, NOW_MS);
    expect(html).toContain("Run not found");
    expect(html).toContain('<a href="#/runs">Back to runs</a>');
  });
});

describe("the embedded model", () => {
  test("cannot close the script element that carries it", () => {
    const json = dashModelJson(liveModel);
    expect(json).not.toContain("<");
    expect(json).toContain("\\u003c");
    expect(JSON.parse(json)).toEqual(JSON.parse(JSON.stringify(liveModel)));
  });

  test("a handoff quoting </script> survives the round trip intact", () => {
    const hostile = { ...liveModel, workspace: "</script><img src=x>" };
    const json = dashModelJson(hostile);
    expect(json).not.toContain("</script>");
    expect((JSON.parse(json) as { workspace: string }).workspace).toBe("</script><img src=x>");
  });

  test("the page ships it, and the renderer, in both live and static", () => {
    for (const page of [renderDashboard(liveModel), renderDashboard(staticModel)]) {
      expect(page).toContain('<script type="application/json" id="model-data">');
      expect(page).toContain("function dashMain(");
      expect(page).toContain('<main id="main" class="shell" tabindex="-1"></main>');
    }
  });

  test("only the live page watches; the static export has no network call at all", () => {
    const live = renderDashboard(liveModel);
    expect(live).toContain('new EventSource("/events")');
    expect(live).toContain('fetch("/model.json"');

    const still = renderDashboard(staticModel);
    expect(still).not.toContain("EventSource");
    expect(still).not.toContain("fetch(");
  });
});

describe("the inlined scripts", () => {
  test("both parse as JavaScript — a syntax error here is a page that does nothing", () => {
    // `new Function` parses without executing, so `document` never has to exist.
    expect(() => new Function(DASHBOARD_JS)).not.toThrow();
    expect(() => new Function(liveScript())).not.toThrow();
    expect(() => new Function(`${clientRenderer()}\n${DASHBOARD_JS}\n${liveScript()}`)).not.toThrow();
  });

  test("the live script hands the new model to the page's own renderer", () => {
    expect(DASHBOARD_JS).toContain("window.tldrxApply = function (model)");
    expect(liveScript()).toContain("window.tldrxApply(model)");
  });

  test("it listens for the named event the server actually sends", () => {
    expect(liveScript()).toContain('stream.addEventListener("reload", repaint)');
  });
});

describe("the renderer's own escapers", () => {
  test("dashEscape matches the core escapeHtml character for character", () => {
    for (const sample of ["<script>", "a & b", `"quoted"`, "it's", "a>b", "plain", "&amp;", "«ok»"]) {
      expect(dashEscape(sample)).toBe(escapeHtml(sample));
    }
  });

  /**
   * #122. Everything serialised to the browser may close over nothing, so
   * `dashSignature` is a copy of `describeGateSignature` — the same bargain
   * `dashEscape` strikes with `escapeHtml`, and the same insurance against the
   * two drifting: one of them printing a delegated agent as a bare human name
   * would be exactly the bug the fields were added for.
   */
  test("dashSignature matches the core describeGateSignature, case for case", () => {
    const cases: readonly Partial<StageRowModel>[] = [
      { gateBy: "alan", gateExecutedBy: null, gateAuthority: null },
      { gateBy: null, gateExecutedBy: null, gateAuthority: null },
      {
        gateBy: "alan", gateExecutedBy: { type: "human", id: "alan" },
        gateAuthority: { type: "direct", policy: "human", authorizedBy: "alan", source: "self" },
      },
      {
        gateBy: "alanmartinez", gateExecutedBy: { type: "agent", id: "alanmartinez" },
        gateAuthority: {
          type: "delegated", policy: "agent", authorizedBy: "alanmartinez", source: "run.created",
        },
      },
      {
        gateBy: "auto", gateExecutedBy: { type: "auto", id: null },
        gateAuthority: { type: "delegated", policy: "auto", authorizedBy: "will", source: "gate.policy_changed" },
      },
      {
        gateBy: "auto", gateExecutedBy: { type: "auto", id: null },
        gateAuthority: { type: "delegated", policy: "auto", authorizedBy: null, source: "unrecorded" },
      },
      // a record a NEWER writer made, whose executor kind this version never heard of
      {
        gateBy: "someone", gateExecutedBy: { type: "committee", id: "board" },
        gateAuthority: { type: "delegated", policy: "agent", authorizedBy: "alan", source: "run.created" },
      },
      // half a record: an executor with no authority beside it
      { gateBy: "fable", gateExecutedBy: { type: "agent", id: "fable" }, gateAuthority: null },
    ];
    for (const stage of cases) {
      const authority = stage.gateAuthority ?? null;
      expect(dashSignature(stage as StageRowModel)).toBe(describeGateSignature({
        by: stage.gateBy ?? null,
        executed_by: stage.gateExecutedBy ?? null,
        authority: authority === null ? null : {
          type: authority.type,
          policy: authority.policy,
          authorized_by: authority.authorizedBy,
          source: authority.source,
        },
      }));
    }
    // and the one that matters, spelled out rather than only compared
    expect(dashSignature({
      gateBy: "alanmartinez", gateExecutedBy: { type: "agent", id: "alanmartinez" },
      gateAuthority: {
        type: "delegated", policy: "agent", authorizedBy: "alanmartinez", source: "run.created",
      },
    } as StageRowModel)).toBe("agent alanmartinez (delegated by alanmartinez, policy: agent)");
  });

  test("dashText leaves quotes alone — a shell command in a <code> should read like one", () => {
    expect(dashText(`tldrx answer Q2 "all time"`)).toBe(`tldrx answer Q2 "all time"`);
    expect(dashText("<b> & </b>")).toBe("&lt;b&gt; &amp; &lt;/b&gt;");
  });
});

describe("the renderer's money formatting", () => {
  test("agrees with replay's money()", () => {
    const wire = JSON.parse(JSON.stringify(liveModel)) as typeof liveModel;
    const runs = dashMain(wire, UI, { view: "runs", id: null }, NOW_MS);
    for (const run of wire.runs) {
      expect(runs).toContain(money(run.spentUsd));
      expect(runs).toContain(money(run.ceilingUsd));
    }
    expect(money(null)).toBe("$?");
  });
});
