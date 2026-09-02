/**
 * The public surfaces must not disagree with each other, or with the package.
 *
 * We ship four things a stranger reads before they trust us: the README, the docs
 * site (two locales), `env.yml` (which is what `tldrx doctor` enforces), and the
 * package itself. On 2026-09-02 all four were live and three of them were wrong —
 * the site advertised 0.4.0 while npm served 0.5.0, the site's quickstart demanded
 * Bun to RUN a package that runs on Node alone, and the landing page claimed an
 * absolute ("nothing to fall out of sync with") that the same week's #116 and #117
 * had just finished disproving. None of that was caught by anything, because
 * nothing was looking.
 *
 * This file looks. It is deliberately cheap and deterministic — it reads files off
 * disk, does no network, spawns nothing, and has no opinion about prose style. It
 * only asserts the handful of things that MUST agree, and each assertion names the
 * file and line a human has to go fix.
 *
 * `scripts/release-check.sh` already checks version agreement between
 * `package.json`, `plugin.json`, `CHANGELOG.md` and the README table — but only at
 * release time, when the drift has already shipped. This runs on every PR in
 * `ci.yml`, which is where drift is cheap.
 *
 * The rule behind rule 1 is worth stating, because it is the one that keeps
 * coming back: **the current version must never be typed into prose.** A literal
 * is a promise to remember, and we have now failed to remember twice. The docs
 * config derives it from `package.json`; this test makes sure nobody re-types it.
 *
 * #125 found the same failure mode on a fifth surface: `docs/spec.md` §2.10 RESTATES an
 * `env.yml`, and a restated example goes stale exactly the way a restated version number
 * does — two of the three defects on that one line were on the same line as each other.
 * The last describe block asserts that example against the real manifest and the real schema.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";
import { loadEnvManifest } from "../src/core/doctor/loadEnvManifest.ts";
import { parseYaml } from "../src/core/yaml.ts";
import { validateEnv } from "../src/core/schemas/env.ts";

const DOCS_SITE = join(FRAMEWORK_ROOT, "docs-site");

const pkg = JSON.parse(readFileSync(join(FRAMEWORK_ROOT, "package.json"), "utf8")) as {
  version: string;
};
const README = readFileSync(join(FRAMEWORK_ROOT, "README.md"), "utf8");

/**
 * `docs-site/reference/changelog.md` is GENERATED from CHANGELOG.md at build time
 * (`docs-site/scripts/gen-changelog.ts`). It is a historical record: it cites every
 * version we ever shipped, by design, and it quotes decisions about wording that
 * these rules would otherwise flag. Every rule below skips it for that reason —
 * the source of truth for its content is CHANGELOG.md, which no rule here reads.
 */
const GENERATED = join("reference", "changelog.md");

/** Every markdown file under docs-site/ except the generated changelog. */
function docsMarkdown(): { path: string; rel: string; text: string }[] {
  const out: { path: string; rel: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (name === "node_modules" || name === ".vitepress" || name === "public") continue;
        walk(path);
        continue;
      }
      if (!name.endsWith(".md")) continue;
      const rel = relative(DOCS_SITE, path);
      if (rel.endsWith(GENERATED)) continue;
      out.push({ path, rel, text: readFileSync(path, "utf8") });
    }
  };
  walk(DOCS_SITE);
  return out;
}

const DOCS = docsMarkdown();

/** `path:line: the whole line`, for every line of `text` matching `re`. */
function hits(rel: string, text: string, re: RegExp): string[] {
  return text
    .split("\n")
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => re.test(line))
    .map(({ line, n }) => `docs-site/${rel}:${n}: ${line.trim()}`);
}

describe("the version the docs advertise", () => {
  /**
   * A release-shaped literal: exactly three dotted numbers, not part of a longer
   * dotted run. The negative lookarounds are what keep `127.0.0.1` (which appears
   * on the dashboard pages) and `$5.00` out of the match.
   */
  const RELEASE_LITERAL = /(?<![\d.])\d+\.\d+\.\d+(?![\d.])/g;

  /**
   * A version presented as *the current one*: "version 0.4.0", "versión 0.4.0",
   * "Beta, 0.4.0". This is the shape that goes stale, and the shape that must be
   * interpolated from `package.json` rather than typed.
   *
   * Deliberately NOT global: `hits()` calls `.test()` once per line, and a `g` regex
   * carries `lastIndex` between those calls, which would silently skip every other
   * match. A guard that under-reports is worse than no guard.
   */
  const ADVERTISED = /(?:\b(?:version|versión)\s+|\b(?:Alpha|Beta|Stable),\s*)\d+\.\d+\.\d+/i;

  /**
   * Versions the prose may cite as HISTORY — "releases through 0.3.1 were alpha;
   * 0.4.0 was the first beta". Adding to this list is a deliberate act. Anything
   * NOT on it is a hardcode somebody forgot to update.
   */
  const HISTORICAL = new Set(["0.3.1", "0.4.0"]);

  test("no page states the current version as a literal — it comes from package.json", () => {
    const offenders = DOCS.flatMap(({ rel, text }) => hits(rel, text, ADVERTISED));
    expect(
      offenders,
      `A version typed into prose goes stale the next time we release — it did, twice.\n` +
        `These lines must interpolate the build-time value instead (see docs-site/version.ts):\n` +
        offenders.join("\n"),
    ).toEqual([]);
  });

  test("the current version appears nowhere in docs-site prose", () => {
    const offenders = DOCS.flatMap(({ rel, text }) =>
      hits(rel, text, new RegExp(`(?<![\\d.])${pkg.version.replace(/\./g, "\\.")}(?![\\d.])`)),
    );
    expect(
      offenders,
      `package.json is ${pkg.version}. Hardcoding it is how the site fell to 0.4.0 while npm served 0.5.0:\n` +
        offenders.join("\n"),
    ).toEqual([]);
  });

  test("every release-shaped literal in the prose is a version we deliberately cite as history", () => {
    const offenders: string[] = [];
    for (const { rel, text } of DOCS) {
      text.split("\n").forEach((line, i) => {
        for (const m of line.matchAll(RELEASE_LITERAL)) {
          if (HISTORICAL.has(m[0])) continue;
          offenders.push(`docs-site/${rel}:${i + 1}: ${m[0]} — ${line.trim()}`);
        }
      });
    }
    expect(
      offenders,
      `Unexpected version literal(s). Either this is stale and should be the interpolated\n` +
        `current version, or it is history and belongs in HISTORICAL in this file:\n` +
        offenders.join("\n"),
    ).toEqual([]);
  });

  test("the docs config derives the version from package.json rather than hardcoding it", () => {
    const version = readFileSync(join(DOCS_SITE, "version.ts"), "utf8");
    expect(version).toContain("package.json");
    const config = readFileSync(join(DOCS_SITE, ".vitepress", "config.mts"), "utf8");
    expect(config).toContain("./version.ts");
    expect(config.match(RELEASE_LITERAL) ?? []).toEqual([]);
  });

  test("the top row of the README release table is the version in package.json", () => {
    const row = README.split("\n").find((l) => /^\|\s*\d+\.\d+\.\d+\s*\|/.test(l));
    expect(row, "README.md has no release-table row at all").toBeDefined();
    const top = /^\|\s*(\d+\.\d+\.\d+)\s*\|/.exec(row!)![1];
    expect(
      top,
      `README.md's release table leads with ${top} but package.json says ${pkg.version}. ` +
        `Every release adds a row; this one is missing or out of order.`,
    ).toBe(pkg.version);
  });
});

describe("claims we have retired", () => {
  /**
   * Each entry is a claim the project decided it cannot defend, with the reason,
   * so the failure message teaches instead of just forbidding.
   */
  const BANNED: { re: RegExp; why: string }[] = [
    {
      re: /nothing to fall out of sync/i,
      why:
        "an absolute the implementation cannot guarantee — #116 and #117 both shipped because state CAN " +
        "fall out of sync. Say what is defensible: the canonical state is on disk, inspectable, diffable, " +
        "committable, recoverable.",
    },
    {
      re: /no hay nada que se pueda desincronizar/i,
      why: "the Spanish mirror of the same absolute.",
    },
    {
      re: /\blightweight\b/i,
      why: "retired as positioning by owner decision, 2026-09-02 (see CHANGELOG 0.5.0).",
    },
    {
      re: /\b(?:tool|provider|model)-agnostic\b/i,
      why:
        "an unqualified claim about software that has one working runner. Say the version that " +
        "survives inspection: the workflow and the persisted state format are provider-independent; " +
        "the automated runner currently supports Claude Code and Codex.",
    },
  ];

  for (const { re, why } of BANNED) {
    test(`no public surface says ${String(re)}`, () => {
      const offenders = [
        ...hits("../README.md", README, re).map((h) => h.replace("docs-site/../", "")),
        ...DOCS.flatMap(({ rel, text }) => hits(rel, text, re)),
      ];
      expect(offenders, `${why}\n${offenders.join("\n")}`).toEqual([]);
    });
  }
});

describe("what the front door advertises", () => {
  test("the automated runner names both implementations it actually ships", () => {
    const claim = "the automated runner currently supports Claude Code and Codex.";
    expect(README).toContain(claim);
    expect(readFileSync(join(FRAMEWORK_ROOT, "docs", "concept.md"), "utf8")).toContain(claim);
  });

  /**
   * #128: `tldrx drive` is the star operator command for unattended runs — it has a
   * guide in both locales and a chapter behind that — and on 2026-09-02 neither landing
   * page mentioned it. Measured, not estimated: `grep -c 'tldrx drive'` returned 0 on
   * `docs-site/index.md` and on `docs-site/es/index.md`, and a bare `grep drive` exited
   * 1 on both. The capability had shipped; the front door never said so.
   *
   * That is the expensive kind of gap. The landing walks a reader from `run new` through
   * `next` / `approve` / `reject` to `run auto` — the attended loop — and stops. A reader
   * stops where the page stops, so the one flow that most needs explaining was reachable
   * only by someone who already knew to go looking for it.
   *
   * This pins the entry point, not the prose: each landing must name the command and link
   * to the guide that explains it. It has no opinion about wording, heading, or placement,
   * all of which stay free to change.
   */
  const LANDINGS = [
    { rel: "index.md", guide: "/guides/driving" },
    { rel: join("es", "index.md"), guide: "/es/guides/driving" },
  ];

  for (const { rel, guide } of LANDINGS) {
    test(`docs-site/${rel} names \`tldrx drive\` and links to its guide`, () => {
      const page = DOCS.find((d) => d.rel === rel);
      expect(page, `docs-site/${rel} is not under docs-site any more`).toBeDefined();
      expect(
        page!.text.includes("tldrx drive"),
        `docs-site/${rel} never mentions \`tldrx drive\`. The unattended flow is the one a ` +
          `reader cannot discover on their own — if the landing ends at \`run auto\`, so do they.`,
      ).toBe(true);
      expect(
        page!.text.includes(`](${guide})`),
        `docs-site/${rel} names the command but never links to ${guide}, so a reader who ` +
          `wants the detail has nowhere to go for it.`,
      ).toBe(true);
    });
  }
});

describe("what you actually need installed", () => {
  /**
   * The measured truth, 2026-09-02: `node dist/tldrx.js --version` prints the
   * version and exits 0 on a machine with no Bun involved. `src/core/runtime/index.ts`
   * picks its implementation off `typeof Bun` at import time and `nodeRuntime.ts` is
   * complete, with `yaml` inlined by `bun build --target=node`. Bun builds the
   * bundle and runs the test suite; it does not run the published package.
   *
   * So `env.yml` must not mark Bun REQUIRED — `DoctorReport.healthy` is
   * "no required tool is missing", which means a `required: true` here exits
   * `tldrx doctor` 1 on a machine where tldrx is installed and working fine.
   */
  test("env.yml does not require Bun, because the published package runs on Node alone", async () => {
    const manifest = await loadEnvManifest();
    const bun = manifest.tools.find((t) => t.id === "bun");
    expect(bun, "env.yml no longer declares bun at all — did the toolchain change?").toBeDefined();
    expect(
      bun!.required,
      "README.md:45 says an installed tldrx needs only Node, and `node dist/tldrx.js --version` " +
        "confirms it. A required bun here makes `tldrx doctor` exit 1 on a working install.",
    ).toBe(false);
  });

  test("no quickstart tells a reader they need Bun to run tldrx", () => {
    const quickstarts = DOCS.filter(({ rel }) => rel.endsWith("quickstart.md"));
    expect(quickstarts.length, "expected an English and a Spanish quickstart").toBe(2);
    const offenders = quickstarts.flatMap(({ rel, text }) =>
      hits(rel, text, /(?:You need|Necesitas)\b[^.]*\bBun\b/i),
    );
    expect(
      offenders,
      "Bun builds tldrx and runs its tests; it is not needed to run the published package. " +
        "Say which is which rather than listing it as a requirement:\n" + offenders.join("\n"),
    ).toEqual([]);
  });
});

describe("the env.yml example in docs/spec.md", () => {
  /**
   * §2.10 restates a manifest, and a restated manifest drifts. By #125 this one had
   * drifted three ways at once, two of them on the same physical line:
   *
   *  - `version_re:` — a field that was designed and then dropped. `src/core/schemas/env.ts`
   *    requires `["id", "required", "check", "install"]` and knows `min_version`; no regex
   *    appears anywhere in it. Extraction is `extractVersion` in `src/core/doctor/version.ts`,
   *    "the first dotted numeric run in stdout+stderr", which is what `env.yml`'s own header
   *    comment has always said. A contributor who copied the example got a field nothing reads.
   *  - `min_version: "1.1.0"` for Bun, which the manifest stopped saying when native `Bun.YAML`
   *    became the dependency (`1.3.0`).
   *  - `required: true` for Bun, which #121 disproved: the published package runs on Node alone.
   *
   * So the example is asserted rather than proofread. Deliberately narrow: it must parse, it
   * must satisfy the schema `loadEnvManifest` enforces, it may use no key the real `env.yml`
   * does not, and it must agree with the real manifest about every tool it names. It says
   * nothing about prose, ordering, or WHICH tools are shown — an illustration is allowed to be
   * an excerpt, and `purpose` is deliberately not compared because the example abbreviates it.
   */
  const SPEC_REL = join("docs", "spec.md");
  const SPEC = readFileSync(join(FRAMEWORK_ROOT, SPEC_REL), "utf8");

  /** The first fenced ```yaml block under the `### 2.10 … env.yml` heading. */
  function example(): string {
    const lines = SPEC.split("\n");
    const heading = lines.findIndex((l) => /^### 2\.10\b.*env\.yml/.test(l));
    expect(heading, `${SPEC_REL} no longer has a "### 2.10 … env.yml" heading`).toBeGreaterThan(-1);
    let open = -1;
    for (let i = heading + 1; i < lines.length; i++) {
      if (/^#{1,3} /.test(lines[i]!)) break;
      if (lines[i] === "```yaml") { open = i; break; }
    }
    expect(open, `${SPEC_REL} §2.10 carries no \`\`\`yaml example any more`).toBeGreaterThan(-1);
    const close = lines.indexOf("```", open + 1);
    expect(close, `${SPEC_REL} §2.10's yaml fence is never closed`).toBeGreaterThan(open);
    return lines.slice(open + 1, close).join("\n");
  }

  test("satisfies the same schema loadEnvManifest enforces on the real file", () => {
    const check = validateEnv(parseYaml(example()));
    expect(
      check.ok,
      `${SPEC_REL} §2.10's example would be REFUSED by \`tldrx doctor\` if anyone pasted it:\n` +
        check.issues.map((i) => `  ${i.path || "<root>"}: ${i.message}`).join("\n"),
    ).toBe(true);
  });

  test("invents no field — every key it uses is a key env.yml uses", async () => {
    const manifest = await loadEnvManifest();
    const topKeys = new Set(Object.keys(manifest as unknown as Record<string, unknown>));
    const toolKeys = new Set(
      manifest.tools.flatMap((t) => Object.keys(t as unknown as Record<string, unknown>)),
    );
    const doc = parseYaml(example()) as Record<string, unknown>;

    const offenders: string[] = [];
    for (const key of Object.keys(doc)) if (!topKeys.has(key)) offenders.push(`top-level \`${key}\``);
    for (const tool of (doc.tools ?? []) as Record<string, unknown>[]) {
      for (const key of Object.keys(tool)) {
        if (!toolKeys.has(key)) offenders.push(`\`${String(tool.id)}\`.\`${key}\``);
      }
    }
    expect(
      offenders,
      `${SPEC_REL} §2.10 shows field(s) the real env.yml does not have. Either the schema in\n` +
        `src/core/schemas/env.ts grew them and env.yml should use them, or — as with \`version_re\` —\n` +
        `they were designed and dropped and the example is teaching a validation error:\n` +
        offenders.map((o) => `  ${o}`).join("\n"),
    ).toEqual([]);
  });

  test("carries the real manifest's own values for every tool it names", async () => {
    const manifest = await loadEnvManifest();
    const doc = parseYaml(example()) as { tools?: Record<string, unknown>[] };

    const offenders: string[] = [];
    for (const shown of doc.tools ?? []) {
      const real = manifest.tools.find((t) => t.id === shown.id);
      if (!real) {
        offenders.push(`\`${String(shown.id)}\` is not a tool env.yml declares at all`);
        continue;
      }
      const source = real as unknown as Record<string, unknown>;
      for (const field of ["required", "check", "min_version"] as const) {
        const spec = shown[field] ?? null;
        const truth = source[field] ?? null;
        if (spec !== truth) {
          offenders.push(
            `\`${real.id}\`.${field}: spec says ${JSON.stringify(spec)}, env.yml says ${JSON.stringify(truth)}`,
          );
        }
      }
    }
    expect(
      offenders,
      `${SPEC_REL} §2.10 and env.yml disagree. env.yml is the file \`tldrx doctor\` actually runs,\n` +
        `so it wins; fix the spec (this is how "min_version: 1.1.0" and "required: true" survived\n` +
        `two changes to the real manifest):\n` +
        offenders.map((o) => `  ${o}`).join("\n"),
    ).toEqual([]);
  });
});
