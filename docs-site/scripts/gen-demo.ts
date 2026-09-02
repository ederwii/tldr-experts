/**
 * Generate the docs site's live demo of `tldrx dashboard`, from invented data only.
 *
 * The site should be able to SHOW the dashboard rather than describe it, and the
 * honest way to do that is to run the real export over data nobody has to trust.
 * So this composes a throwaway workspace out of the repository's own synthetic
 * fixtures, runs the model builder and the renderer `tldrx dashboard --static`
 * runs over it, and drops the page into `docs-site/public/dashboard-demo/`, which
 * VitePress copies to `/dashboard-demo/` verbatim.
 *
 * **The hard rule is where the data comes from.** Real runs carry a client's
 * domain in every clue: run titles, repo names, story text, the questions a
 * stakeholder answered. A demo generator that could be pointed at a real
 * workspace would publish all of that the first time somebody ran it in the wrong
 * directory, and it would look like it worked. So `assertSynthetic` refuses any
 * source outside `test/fixtures/` before a byte is read, and it refuses the
 * framework's own checkout by name — that one IS a tldrx workspace, and it is
 * where a careless default would land. `test/docs-demo.test.ts` proves the guard
 * fires rather than trusting that it is written down.
 *
 * Run by `bun run build` and `bun run dev` in docs-site/, beside gen-changelog.ts,
 * and by the docs workflow on every deploy — so the demo is rebuilt from today's
 * renderer every time the site ships, and cannot rot into a screenshot of a
 * version that no longer exists. The output is gitignored, like the changelog page.
 */
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { FRAMEWORK_ROOT } from "../../src/core/paths.ts";
import {
  APP_ELEMENT_ID, INDEX_FILE, buildModel, renderDashboard,
} from "../../src/core/dashboard/index.ts";

/** The only tree this generator is allowed to read run data out of. */
export const DEMO_FIXTURE_ROOT: string = join(FRAMEWORK_ROOT, "test", "fixtures");

/**
 * The two fixtures, in overlay order.
 *
 * `views` is the detailed one — one run with handoffs, open questions, a budget
 * ledger, an events log and two trained experts — and it supplies `.tldrx/` for
 * the composed workspace. `chain` is the wide one: seven runs carrying every
 * status a reader should learn to recognise (`pending`, `awaiting_gate`,
 * `awaiting_answer`, `failed`, `done`) and the dependency edges between them.
 * Neither is written for this page; both are what the dashboard's own tests
 * assert against, which is why the demo cannot drift away from the real thing
 * without a test going red.
 */
export const DEMO_SOURCES: readonly string[] = [
  join(DEMO_FIXTURE_ROOT, "views", "workspace"),
  join(DEMO_FIXTURE_ROOT, "chain", "workspace"),
];

/**
 * VitePress copies `public/` to the site root, so this lands at
 * `/dashboard-demo/index.html`.
 *
 * NOT `public/demo/`, which is the one name it cannot have: the prose page that frames
 * this export is `docs-site/demo.md`, and `cleanUrls` builds that as `demo.html`. A site
 * holding both `demo.html` and `demo/index.html` asks GitHub Pages to guess what `/demo`
 * means, and the two answers are "the page about the demo" and "the raw dashboard with no
 * explanation around it". Measured 2026-09-02 — the first build of this feature shipped
 * exactly that collision.
 */
export const DEMO_OUT_DIR: string = join(FRAMEWORK_ROOT, "docs-site", "public", "dashboard-demo");

/**
 * A fixed clock, and why.
 *
 * The fixtures' timestamps run to 2026-09-03T11:00Z. Rendering them against the
 * real `now` would print "in 3 months" on a page whose whole job is to look like
 * a workspace somebody is working in, and would make the output different on
 * every build — a diff nobody can review and a cache nobody can trust. An hour
 * after the last event is the reading the fixtures were written for.
 */
export const DEMO_GENERATED_AT = "2026-09-03T12:00:00Z";
export const DEMO_NOW: Date = new Date(DEMO_GENERATED_AT);

/** The workspace name the page prints in its title bar. */
const DEMO_WORKSPACE_NAME = "demo-workspace";

/**
 * The path the page says it was generated from — and why it is not the real one.
 *
 * `model.root` is drawn on the page ("generated from files on disk at …"), so the
 * first version of this script published
 * `/var/folders/bb/s_w0…/tldrx-demo-AUfHya/demo-workspace`: the build machine's
 * temp directory, different on every run, straight into a public document. Two
 * separate problems — a path off somebody's box has no business on a website, and
 * a page whose bytes change every build is a page nobody can diff or cache.
 *
 * The fix is to compose in a throwaway directory (isolated, safe to run twice at
 * once) and render with the root the demo is ABOUT. It is one more invented value
 * on a page whose runs, dollars and signatures are all invented and which says so
 * in its first line — not a claim about a real directory. `test/docs-demo.test.ts`
 * holds the other half: no path from the machine that built the page appears
 * anywhere in it.
 */
export const DEMO_DISPLAY_ROOT = `~/code/${DEMO_WORKSPACE_NAME}`;

export class DemoSourceError extends Error {}

/**
 * Refuse anything that is not one of the repository's synthetic fixtures.
 *
 * Prefix containment on the RESOLVED path, so `fixtures/../..` is rejected for
 * what it resolves to rather than for how it is spelled.
 */
export function assertSynthetic(path: string): string {
  const full = resolve(path);
  if (!full.startsWith(DEMO_FIXTURE_ROOT + sep)) {
    throw new DemoSourceError(
      `gen-demo: refusing to read ${full} — the demo is built from synthetic fixtures only, `
      + `and that path is outside ${DEMO_FIXTURE_ROOT}${sep}. `
      + "This page is public: a real workspace read here would publish its domain.",
    );
  }
  return full;
}

/**
 * Copy the fixtures into one throwaway workspace and return its path.
 *
 * The caller deletes it. The first source lands whole (it brings `.tldrx/`); every
 * later one contributes its run folders only, so two fixtures cannot fight over
 * one `workspace.yml`.
 */
export function composeDemoWorkspace(): string {
  const [base, ...overlays] = DEMO_SOURCES;
  if (base === undefined) throw new DemoSourceError("gen-demo: DEMO_SOURCES is empty");

  const root = join(mkdtempSync(join(tmpdir(), "tldrx-demo-")), DEMO_WORKSPACE_NAME);
  cpSync(assertSynthetic(base), root, { recursive: true });

  for (const overlay of overlays) {
    const work = join(assertSynthetic(overlay), "tldrx-work");
    if (!existsDir(work)) continue;
    for (const entry of readdirSync(work)) {
      cpSync(join(work, entry), join(root, "tldrx-work", entry), { recursive: true });
    }
  }
  return root;
}

function existsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * One line at the top of the page saying the numbers are invented.
 *
 * A reader who arrives at `/dashboard-demo/index.html` from a search result has none of the
 * surrounding docs page's context, and every number on the dashboard — dollars,
 * gates, who approved what — reads as a real project's. The banner is styled
 * inline and links nowhere: the export's defining property is that it fetches
 * nothing, and a link out of it would be the first exception.
 */
export const DEMO_BANNER = '<div data-demo-banner style="background:#EDFF8A;color:#232220;'
  + "font:600 14px/1.5 ui-sans-serif,system-ui,sans-serif;padding:10px 16px;text-align:center;"
  + 'border-bottom:1px solid rgba(0,0,0,.15)">'
  + "Demo — every run, dollar and signature below is <strong>synthetic fixture data</strong> "
  + "from the tldr-experts test suite. No real project is shown here."
  + "</div>";

/** Where the banner goes: straight after the skip link, so that stays the first stop. */
const ANCHOR = `<a class="sr-only" href="#${APP_ELEMENT_ID}">Skip to content</a>\n`;

export function withDemoBanner(html: string): string {
  if (!html.includes(ANCHOR)) {
    throw new DemoSourceError(
      "gen-demo: could not find the skip link to insert the banner after. "
      + "The renderer's document shape changed — update ANCHOR in this file rather than "
      + "shipping a demo page that does not say it is a demo.",
    );
  }
  return html.replace(ANCHOR, `${ANCHOR}${DEMO_BANNER}\n`);
}

/** The inverse, so a test can prove the banner is the only difference from the CLI's export. */
export function stripDemoBanner(html: string): string {
  return html.replace(`${DEMO_BANNER}\n`, "");
}

export interface DemoExport {
  readonly path: string;
  readonly bytes: number;
  readonly runs: number;
  readonly experts: number;
}

/**
 * Build the model the CLI builds, render it the way the CLI renders it, and write
 * it where VitePress will find it.
 *
 * These are the two halves of `writeStaticDashboard` (`src/core/dashboard/
 * writeStatic.ts`) rather than a call to it, for exactly one reason: the root has
 * to be overridden between them. Everything else — the model, the renderer, the
 * single self-contained file — is the shipped code path, so a change to either
 * shows up on this page on the next docs deploy.
 */
export function demoPage(): { readonly html: string; readonly runs: number; readonly experts: number } {
  const root = composeDemoWorkspace();
  try {
    const model = buildModel(root, DEMO_GENERATED_AT, { now: DEMO_NOW });
    return {
      html: withDemoBanner(renderDashboard({ ...model, root: DEMO_DISPLAY_ROOT })),
      runs: model.runs.length,
      experts: model.experts.length,
    };
  } finally {
    rmSync(dirname(root), { recursive: true, force: true });
  }
}

/** Compose, render, banner, write. Returns what landed. */
export function generateDemoDashboard(outDir: string = DEMO_OUT_DIR): DemoExport {
  const page = demoPage();
  const path = join(outDir, INDEX_FILE);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path, page.html, "utf8");
  return { path, bytes: Buffer.byteLength(page.html, "utf8"), runs: page.runs, experts: page.experts };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const at = argv.indexOf("--out");
  const outDir = at === -1 ? DEMO_OUT_DIR : argv[at + 1];
  if (outDir === undefined) {
    process.stderr.write("gen-demo: --out expects a directory\n");
    process.exit(2);
  }
  const written = generateDemoDashboard(resolve(outDir));
  process.stdout.write(
    `gen-demo: wrote ${written.path} (${String(written.bytes)} bytes) — `
    + `${String(written.runs)} synthetic run(s), ${String(written.experts)} expert(s)\n`,
  );
}
