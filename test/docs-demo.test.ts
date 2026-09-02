/**
 * The docs site's demo dashboard must be a showcase, not a leak.
 *
 * `docs-site/scripts/gen-demo.ts` renders a real `tldrx dashboard --static` page
 * into the site's `public/` tree on every docs build (#106). The page is public,
 * permanent and indexed, so the two things that matter about it are not "does it
 * look nice":
 *
 *   1. **Where the data came from.** Only the repo's own synthetic fixtures under
 *      `test/fixtures/`. A generator that could be pointed at a real workspace —
 *      by a flag, by a default, by an env var — would publish a client's domain
 *      the first time somebody ran it in the wrong directory. The guard is a
 *      runtime assertion in the generator, and this file proves it FIRES rather
 *      than trusting that it is there.
 *   2. **That the page still stands alone.** The export inlines its CSS, its
 *      renderer and its data; a demo that fetches anything would both break on
 *      GitHub Pages' base path and quietly tell a vendor who read the docs.
 *
 * The banner is the third thing. A reader who lands on `/demo/index.html` from a
 * search result has none of the surrounding page's context, so the generator puts
 * one line at the top saying the numbers are invented. It is additive by
 * construction: strip it and what is left is byte-identical to what the CLI
 * writes, which is the property that keeps this a demo OF the command rather than
 * a mock-up of it.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  DEMO_DISPLAY_ROOT, DEMO_FIXTURE_ROOT, DEMO_GENERATED_AT, DEMO_NOW, DEMO_OUT_DIR, DEMO_SOURCES,
  assertSynthetic, composeDemoWorkspace, generateDemoDashboard, stripDemoBanner,
} from "../docs-site/scripts/gen-demo.ts";
import {
  APP_ELEMENT_ID, buildModel, dashMain, renderDashboard,
} from "../src/core/dashboard/index.ts";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

setDefaultTimeout(spawnTestTimeout());

const OUT = mkdtempSync(join(tmpdir(), "tldrx-demo-out-"));
const written = generateDemoDashboard(OUT);
const html = readFileSync(written.path, "utf8");

afterAll(() => rmSync(OUT, { recursive: true, force: true }));

describe("where the demo's data comes from", () => {
  test("every source it reads is a fixture inside test/fixtures/", () => {
    const fixtures = join(FRAMEWORK_ROOT, "test", "fixtures");
    expect(DEMO_FIXTURE_ROOT).toBe(fixtures);
    expect(DEMO_SOURCES.length).toBeGreaterThan(0);
    for (const source of DEMO_SOURCES) {
      expect(source.startsWith(fixtures + sep)).toBe(true);
      expect(existsSync(source)).toBe(true);
    }
  });

  /**
   * The guard is the point of the whole file. Three shapes of "somewhere else"
   * are checked because they are the three ways it would actually happen: an
   * absolute path to a real project, a relative escape out of the fixture tree,
   * and the framework's own checkout — which IS a tldrx workspace, and is the one
   * a careless `--root .` would land on.
   */
  test("a source outside the fixture tree is refused, not read", () => {
    for (const outside of [join(tmpdir(), "some-client-repo"), join(DEMO_FIXTURE_ROOT, "..", ".."), FRAMEWORK_ROOT]) {
      expect(() => assertSynthetic(outside)).toThrow(/synthetic/i);
    }
    // And the ones it really uses pass, so the guard is not vacuously strict.
    for (const source of DEMO_SOURCES) expect(() => assertSynthetic(source)).not.toThrow();
  });

  test("the composed workspace holds only the fixtures' own runs and repos", () => {
    const root = composeDemoWorkspace();
    try {
      const model = buildModel(root, DEMO_GENERATED_AT, { now: DEMO_NOW });
      expect(model.workspaceFound).toBe(true);
      expect(model.unreadable).toEqual([]);
      // Eight runs: the views fixture's one detailed run plus the chain fixture's seven.
      expect(model.runs.length).toBe(8);
      expect(model.experts.length).toBe(2);
      for (const run of model.runs) expect(run.id).toMatch(/^2609\d{2}-[a-z]+$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the generated page", () => {
  test("is one non-empty, self-contained HTML document", () => {
    expect(written.bytes).toBeGreaterThan(10_000);
    expect(written.runs).toBe(8);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html.trimEnd().endsWith("</html>")).toBe(true);
    expect(html).toContain("<style>");
    expect(html).toContain('<script type="application/json" id="model-data">');
  });

  test("nothing on it points off the page", () => {
    const targets = [...html.matchAll(/(?:src|href)="([^"]*)"/g)].map((match) => match[1] ?? "");
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) expect(target.startsWith("#")).toBe(true);
    expect(html).not.toMatch(/(?:src|href)="https?:\/\//);
  });

  test("it shows the whole vocabulary a reader came to see", () => {
    for (const status of ["awaiting_gate", "awaiting_answer", "failed", "done", "pending"]) {
      expect(html).toContain(status);
    }
    expect(html).toContain("260901-scoreboard");
    expect(html).toContain("260903-alpha");
  });

  test("the banner says the data is invented, and says it above the dashboard", () => {
    const banner = html.indexOf("data-demo-banner");
    expect(banner).toBeGreaterThan(-1);
    expect(html).toMatch(/synthetic/i);
    // Above the content, below the skip link — so the first stop for a keyboard
    // or a screen reader is still "skip to the dashboard", not the disclaimer.
    expect(html.indexOf("Skip to content")).toBeLessThan(banner);
    expect(banner).toBeLessThan(html.indexOf(`<main id="${APP_ELEMENT_ID}"`));
  });

  /**
   * Additive by construction: what is under the banner is what `tldrx dashboard
   * --static` writes, byte for byte. If this ever fails the demo has started
   * being a mock-up of the command instead of a run of it.
   */
  test("strip the banner and it is byte-identical to the CLI's own export", () => {
    const root = composeDemoWorkspace();
    try {
      const model = buildModel(root, DEMO_GENERATED_AT, { now: DEMO_NOW });
      const cli = renderDashboard({ ...model, root: DEMO_DISPLAY_ROOT });
      expect(stripDemoBanner(html)).toBe(cli);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * The regression this file was written around. `model.root` is DRAWN on the page
   * ("generated from files on disk at …"), so the first version published the
   * build machine's temp directory — a different one every run, into a public
   * document. Both halves are checked: no temp path, no checkout path, and the
   * root it does print is the invented one.
   */
  test("no path from the machine that built it appears anywhere on it", () => {
    expect(html).toContain(DEMO_DISPLAY_ROOT);
    expect(html).not.toContain(tmpdir());
    expect(html).not.toContain(FRAMEWORK_ROOT);
    expect(html).not.toMatch(/\/var\/folders\/|\/home\/runner\//);
  });

  /**
   * The page draws itself in the browser from the JSON it carries, so "the file is
   * not empty" says nothing about whether a reader sees anything. `dashMain` is the
   * function the inlined renderer IS (`clientRenderer()` serialises it, and
   * `dashboard-render.test.ts` holds those two together), so running it over the
   * demo's own model is the closest this suite gets to opening the page.
   */
  test("the model it carries actually draws — runs list and run detail", () => {
    const root = composeDemoWorkspace();
    try {
      const model = buildModel(root, DEMO_GENERATED_AT, { now: DEMO_NOW });
      const ms = DEMO_NOW.getTime();
      const runs = dashMain(model, { status: "all", sort: "updated" }, { view: "runs", id: null }, ms);
      for (const run of model.runs) expect(runs).toContain(run.id);
      expect(runs.length).toBeGreaterThan(2000);

      const detail = dashMain(model, { status: "all", sort: "updated" },
        { view: "run", id: "260901-scoreboard" }, ms);
      expect(detail).toContain("260901-scoreboard");
      expect(detail).toContain("architect");

      const experts = dashMain(model, { status: "all", sort: "updated" },
        { view: "experts", id: null }, ms);
      for (const expert of model.experts) expect(experts).toContain(expert.name);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("it is deterministic — two builds of the same tree agree", () => {
    const second = mkdtempSync(join(tmpdir(), "tldrx-demo-out-"));
    try {
      expect(readFileSync(generateDemoDashboard(second).path, "utf8")).toBe(html);
    } finally {
      rmSync(second, { recursive: true, force: true });
    }
  });
});

describe("the way the docs build runs it", () => {
  /**
   * `public/demo/` would collide with `docs-site/demo.md` — `cleanUrls` builds that as
   * `demo.html`, and a site holding both leaves `/demo` for GitHub Pages to guess at.
   * The first build of this feature shipped that collision, which is why the name is
   * asserted rather than left to whoever edits the script next.
   */
  test("the default output is inside docs-site, and does not collide with the demo page", () => {
    expect(DEMO_OUT_DIR).toBe(join(FRAMEWORK_ROOT, "docs-site", "public", "dashboard-demo"));
  });

  test("`bun docs-site/scripts/gen-demo.ts --out <dir>` writes the page and exits 0", async () => {
    const out = mkdtempSync(join(tmpdir(), "tldrx-demo-cli-"));
    try {
      const proc = Bun.spawn(
        ["bun", join(FRAMEWORK_ROOT, "docs-site", "scripts", "gen-demo.ts"), "--out", out],
        { stdout: "pipe", stderr: "pipe", cwd: join(FRAMEWORK_ROOT, "docs-site") },
      );
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      expect({ code: await proc.exited, stderr }).toEqual({ code: 0, stderr: "" });
      expect(stdout).toContain("gen-demo: wrote");
      expect(readFileSync(join(out, "index.html"), "utf8")).toBe(html);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
