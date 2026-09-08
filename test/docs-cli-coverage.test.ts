/**
 * Every flag the CLI declares has to be findable in the docs a reader actually opens.
 *
 * `src/cli/helpText.ts` is the one registry of the command surface, and a drift test
 * already asserts that every flag the CODE reads is declared there. Nothing asserted the
 * other direction: that a declared flag is EXPLAINED anywhere a person who is not reading
 * `--help` would look. On 2026-09-06 the owner went looking for `--yolo` — the flag that
 * turns off per-tool permission prompts, so the one whose meaning matters most — and found
 * it only in the changelog. It was real: `--yolo` appeared in four usage lines across
 * `docs/guide/08-cli-reference.md` and carried a meaning in exactly one of them, and the
 * published docs site (`docs-site/`, whose `srcDir` never includes `docs/`) did not
 * contain the string at all.
 *
 * Two assertions, one per surface:
 *
 *   1. the repo's hand-written guide mentions every flag inside its own command's section
 *   2. the site's GENERATED reference carries every command, flag, allowed value and exit
 *
 * The second one cannot really fail while the generator reads the registry — that is the
 * point of generating it, and this test is what says so out loud. The first one can, and
 * did: it went red on `dashboard --serve` and `run status --verbose` when it was written.
 *
 * Cheap and hermetic: reads files, calls one pure render function, spawns nothing.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";
import { HELP_ENTRIES, declaredFlags, flagValues } from "../src/cli/helpText.ts";
import { ENV_VARS, cell, renderCliReference } from "../docs-site/scripts/gen-cli.ts";

/**
 * Flags the guide documents ONCE, under "Rules that hold everywhere", rather than in every
 * section that accepts them. Saying `--root` thirty times would be noise, not coverage.
 */
const GLOBAL_IN_GUIDE = new Set(["root"]);

const guide = readFileSync(join(FRAMEWORK_ROOT, "docs", "guide", "08-cli-reference.md"), "utf8");

/**
 * The body of the `## \`tldrx <name>…\`` heading up to the next `## `, subsections included.
 * The heading may carry more than the name — `## \`tldrx install --claude\`` is one — so the
 * name is matched at a word boundary rather than against a closing backtick.
 */
function guideSection(name: string): string | null {
  const lines = guide.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (new RegExp(`^## \`tldrx ${name}(\`| )`).test(lines[i] ?? "")) { start = i + 1; break; }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if ((lines[i] ?? "").startsWith("## ")) { end = i; break; }
  }
  return lines.slice(start, end).join("\n");
}

describe("docs/guide/08-cli-reference.md covers the declared surface", () => {
  for (const command of HELP_ENTRIES) {
    if (command.flags.length === 0) continue;
    test(`\`tldrx ${command.name}\` names every flag it declares`, () => {
      const section = guideSection(command.name);
      expect(section, `no \`## \\\`tldrx ${command.name}\\\`\` section in the guide`).not.toBeNull();
      const missing = command.flags
        .map((flag) => flag.name)
        .filter((name) => !GLOBAL_IN_GUIDE.has(name))
        .filter((name) => !(section ?? "").includes(`--${name}`));
      expect([...new Set(missing)]).toEqual([]);
    });
  }
});

describe("the generated site reference carries the whole surface", () => {
  for (const locale of ["en", "es"] as const) {
    const page = renderCliReference(locale);

    test(`[${locale}] every command has its own section`, () => {
      const missing = HELP_ENTRIES.map((c) => c.name).filter((name) => !page.includes(`## \`tldrx ${name}\``));
      expect(missing).toEqual([]);
    });

    test(`[${locale}] every flag is named with its meaning`, () => {
      const missing: string[] = [];
      for (const command of HELP_ENTRIES) {
        for (const flag of command.flags) {
          if (!page.includes(`--${flag.name}`)) missing.push(`${command.name} --${flag.name}`);
          // Through the same table-cell escaping the page went through: a meaning carrying
          // `<stage>` or a `|` is on the page as `&lt;stage>`, and comparing the raw string
          // would report a gap that is not there.
          else if (!page.includes(cell(flag.meaning.split(".")[0] ?? ""))) missing.push(`${command.name} --${flag.name} (meaning)`);
        }
      }
      expect([...new Set(missing)]).toEqual([]);
    });

    test(`[${locale}] every closed value set is spelled out`, () => {
      const missing: string[] = [];
      for (const command of HELP_ENTRIES) {
        for (const flag of command.flags) {
          for (const value of flagValues(flag)) {
            if (!page.includes(cell(value))) missing.push(`${command.name} --${flag.name}=${value}`);
          }
        }
      }
      expect([...new Set(missing)]).toEqual([]);
    });

    test(`[${locale}] no bare \`<\` survives to the Vue compiler`, () => {
      // VitePress compiles the rendered page as a Vue template, so a `<sandbox>` in a note
      // is an element that never closes and `docs:build` dies pointing somewhere else
      // entirely. It did. This is the same failure in a tenth of a second.
      const offenders: string[] = [];
      let fenced = false;
      page.split("\n").forEach((line, index) => {
        if (line.startsWith("```")) { fenced = !fenced; return; }
        if (fenced) return;
        if (line.replace(/`[^`\n]*`/g, "").includes("<")) offenders.push(`${String(index + 1)}: ${line.slice(0, 80)}`);
      });
      expect(offenders).toEqual([]);
    });

    test(`[${locale}] --yolo is explained on every command that takes it`, () => {
      // The flag this whole file exists for. It must not be a bare token in a usage line.
      const takers = HELP_ENTRIES.filter((c) => c.flags.some((f) => f.name === "yolo")).map((c) => c.name);
      expect(takers.length).toBeGreaterThan(0);
      for (const name of takers) {
        const section = page.slice(page.indexOf(`## \`tldrx ${name}\``));
        const body = section.slice(0, section.indexOf("\n## ") === -1 ? undefined : section.indexOf("\n## "));
        expect(body, `${name} names --yolo without its meaning`).toContain("without per-tool permission prompts");
      }
    });
  }
});

/**
 * The env vars are the one part of the generated page that is WRITTEN, not derived: a
 * variable is read as `process.env.X` at a call site that says nothing about what it means.
 * So this holds the written list against a grep of `src/` in both directions — a new
 * variable cannot land undocumented, and a documented one cannot outlive its reader.
 */
describe("the env-var table matches what src/ actually reads", () => {
  test("every TLDRX_* the code reads is on the page, and nothing else is", () => {
    const read = new Set<string>();
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith(".ts")) {
          for (const hit of readFileSync(path, "utf8").matchAll(/TLDRX_[A-Z_]+/g)) read.add(hit[0]);
        }
      }
    };
    walk(join(FRAMEWORK_ROOT, "src"));
    const documented = new Set(ENV_VARS.map(([name]) => name));
    expect([...read].filter((name) => !documented.has(name)).sort()).toEqual([]);
    expect([...documented].filter((name) => !read.has(name)).sort()).toEqual([]);
  });
});

/**
 * No page may print a `tldrx …` line the CLI would refuse.
 *
 * The other direction of the same problem, and the more embarrassing one: the docs did not
 * merely omit flags, they invented commands. `tldrx facts add` was instructed three times
 * across three guide pages and has never existed (`tldrx: unknown command 'facts'`, exit 1);
 * the env-var section told you to check `TLDRX_CLAUDE_BIN` with `tldrx run --dry-run`, and
 * `--dry-run` is `next`'s flag, not `run`'s. Both were reachable, copyable, and wrong.
 *
 * So every invocation inside a code span or a fenced block is parsed and held against the
 * registry. Prose is not scanned — "tldrx has no daemon" is a sentence, not a command — and
 * the shell around an invocation (a pipe, `&&`, a redirect) ends it.
 */
describe("no page prints a tldrx invocation the CLI would refuse", () => {
  /** Deliberate counter-examples: lines whose whole point is that tldrx refuses them. */
  const INTENTIONAL = new Set(["status --nope"]);
  const NAMES = new Set(HELP_ENTRIES.map((c) => c.name));

  const docs: string[] = [];
  const collect = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) collect(path);
      // The generated pages are the registry rendered; holding them against it proves nothing.
      else if (entry.name.endsWith(".md") && entry.name !== "cli-flags.md" && entry.name !== "changelog.md") docs.push(path);
    }
  };
  collect(join(FRAMEWORK_ROOT, "docs-site"));
  collect(join(FRAMEWORK_ROOT, "docs", "guide"));
  docs.push(join(FRAMEWORK_ROOT, "README.md"));

  /** Inline code spans and fenced blocks — the only places an invocation is being PRINTED. */
  function codeOf(source: string): string[] {
    const out: string[] = [];
    for (const hit of source.matchAll(/`([^`\n]+)`/g)) out.push(hit[1] ?? "");
    for (const hit of source.matchAll(/```[a-z]*\n([\s\S]*?)```/g)) out.push(...(hit[1] ?? "").split("\n"));
    return out;
  }

  for (const file of docs) {
    const relative = file.slice(FRAMEWORK_ROOT.length + 1);
    test(relative, () => {
      const wrong: string[] = [];
      for (const snippet of codeOf(readFileSync(file, "utf8"))) {
        for (const hit of snippet.matchAll(/\btldrx\s+([a-z][a-z-]*)([^|&;>\n]*)/g)) {
          const [command, rest] = [hit[1] ?? "", hit[2] ?? ""];
          if (INTENTIONAL.has(`${command}${rest}`.trim())) continue;
          if (!NAMES.has(command)) { wrong.push(`tldrx ${command} — no such command`); continue; }
          const declared = declaredFlags(command);
          for (const flag of rest.matchAll(/--([a-z][a-z-]*)/g)) {
            const name = flag[1] ?? "";
            if (name === "help" || declared.has(name)) continue;
            wrong.push(`tldrx ${command} --${name} — not a flag of \`${command}\``);
          }
        }
      }
      expect([...new Set(wrong)]).toEqual([]);
    });
  }
});

/**
 * Generating a page is only half of it: the deploy has to RUN. `.github/workflows/docs.yml`
 * fires on a paths filter, and `docs-site/scripts/gen-cli.ts` reads `src/cli/helpText.ts` —
 * a path the filter did not list. Measured this week: a change that touched only the help
 * registry landed on `main`, deployed nothing, and the published CLI reference kept showing
 * the previous surface. The generator's INPUTS belong in the filter alongside the pages, for
 * the same reason CHANGELOG.md and the dashboard fixtures already are (see the file's own
 * header note).
 */
describe("the docs deploy fires on the CLI reference's real inputs", () => {
  const workflow = readFileSync(
    join(FRAMEWORK_ROOT, ".github", "workflows", "docs.yml"), "utf8",
  );
  const paths = workflow.split(/^\s*paths:\s*$/m)[1]?.split(/^\s{2}\S/m)[0] ?? "";

  test("docs.yml has a paths filter to check", () => {
    expect(paths.trim().length, "no `paths:` block found in .github/workflows/docs.yml").toBeGreaterThan(0);
  });

  test("the filter lists src/cli/helpText.ts — gen-cli.ts's source", () => {
    expect(
      paths.includes("src/cli/helpText.ts"),
      "docs.yml's paths filter does not list `src/cli/helpText.ts`, so a help-registry change deploys nothing and the site's generated CLI reference goes stale:\n" + paths,
    ).toBe(true);
  });

  /**
   * The generators themselves need no entry of their own: they live under
   * `docs-site/scripts/`, which the existing `docs-site/**` glob already matches. This
   * asserts that, so a future narrowing of that glob does not silently orphan them.
   */
  test("the generators are covered by the docs-site glob", () => {
    expect(
      paths.includes("docs-site/**") || paths.includes("docs-site/scripts/**"),
      "nothing in docs.yml's paths filter matches docs-site/scripts/:\n" + paths,
    ).toBe(true);
  });
});
