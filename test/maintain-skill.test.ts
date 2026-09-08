/**
 * `.claude/skills/maintain/` is a WORKFLOW skill: it turns a session into a maintainer of
 * this repo working the GitHub issue backlog. Its whole design premise is that it REFERENCES
 * the rules instead of restating them — `AGENTS.md` and `docs/RELEASING.md` are the one set
 * of rules, and a second copy that drifts is the failure mode this repo exists to kill.
 *
 * A prose file cannot hold that premise on its own, so these four assertions do:
 *
 *   1. it is a real skill (frontmatter `name: maintain` + a one-line `description`)
 *   2. every `tldrx` command and `scripts/*.sh` it names EXISTS — the command surface is
 *      `src/cli/helpText.ts`, and a skill quoting a flag from memory is exactly the failure
 *      AGENTS.md §1 names ("a session confidently invented `tldrx facts` twice in one sitting")
 *   3. it names no private workspace and no chat product — #191's rule, plus the owner's:
 *      the skill says "the owner's bridge, if one is installed", never a vendor
 *   4. every `AGENTS.md §N` / RELEASING.md section it CITES resolves to a real heading — a
 *      dangling cross-reference is how a reference-not-copy file rots into a copy
 *
 * Cheap and hermetic: reads files, spawns nothing (so no `test/machine-load.test.ts` row).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";
import { HELP_ENTRIES, declaredFlags, subcommandsOf } from "../src/cli/helpText.ts";

const SKILL_DIR = join(FRAMEWORK_ROOT, ".claude", "skills", "maintain");
const SKILL_MD = join(SKILL_DIR, "SKILL.md");

/** Every markdown file in the skill tree, relative path plus text. */
function skillFiles(): { rel: string; text: string }[] {
  const out: { rel: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) { walk(path); continue; }
      if (!name.endsWith(".md")) continue;
      out.push({ rel: relative(FRAMEWORK_ROOT, path), text: readFileSync(path, "utf8") });
    }
  };
  if (existsSync(SKILL_DIR)) walk(SKILL_DIR);
  return out;
}

describe("the maintain skill is a real skill", () => {
  test("SKILL.md exists", () => {
    expect(existsSync(SKILL_MD), `${relative(FRAMEWORK_ROOT, SKILL_MD)} is missing`).toBe(true);
  });

  test("frontmatter declares name: maintain and a one-line description", () => {
    const text = existsSync(SKILL_MD) ? readFileSync(SKILL_MD, "utf8") : "";
    const front = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? "";
    expect(front, "no YAML frontmatter block at the top of SKILL.md").not.toBe("");
    expect(/^name: maintain$/m.test(front), `frontmatter has no \`name: maintain\`:\n${front}`).toBe(true);
    const description = /^description: (.+)$/m.exec(front)?.[1] ?? "";
    expect(description.length, `frontmatter has no one-line \`description:\`:\n${front}`).toBeGreaterThan(40);
  });

  test("SKILL.md stays a workflow, not a rulebook copy (< 250 lines)", () => {
    const text = existsSync(SKILL_MD) ? readFileSync(SKILL_MD, "utf8") : "";
    expect(text.split("\n").length).toBeLessThan(250);
  });
});

describe("every command the skill names exists", () => {
  const files = skillFiles();

  test("the skill tree has files to scan", () => {
    expect(files.map((f) => f.rel)).toContain(join(".claude", "skills", "maintain", "SKILL.md"));
  });

  test("every backticked `tldrx …` names a declared command and declared flags", () => {
    const names = new Set(HELP_ENTRIES.map((entry) => entry.name));
    const offenders: string[] = [];
    for (const { rel, text } of files) {
      for (const match of text.matchAll(/`tldrx ([^`]+)`/g)) {
        const invocation = match[1] ?? "";
        const tokens = invocation.split(/\s+/).filter((token) => token.length > 0);
        const command = tokens[0] ?? "";
        if (!names.has(command)) { offenders.push(`${rel}: \`tldrx ${invocation}\` — no such command`); continue; }
        const subs = new Set(subcommandsOf(command));
        const flags = declaredFlags(command);
        for (const token of tokens.slice(1)) {
          if (!token.startsWith("--")) {
            if (subs.size > 0 && !subs.has(token) && token !== "<N>" && !token.startsWith("<")) {
              offenders.push(`${rel}: \`tldrx ${invocation}\` — \`${token}\` is not a subcommand of ${command}`);
            }
            continue;
          }
          const flag = token.replace(/^--/, "").split("=")[0] ?? "";
          if (!flags.has(flag)) offenders.push(`${rel}: \`tldrx ${invocation}\` — \`--${flag}\` is not declared for ${command}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * Every assertion above is of the form "nothing offends". An EMPTY SKILL.md satisfies all of
   * them, which would make this whole file a green light over no content. These two say the
   * skill actually reaches for the real surface at least once.
   */
  test("the skill names at least one real script or command", () => {
    const text = files.map((f) => f.text).join("\n");
    const named = [
      ...[...text.matchAll(/`tldrx ([^`]+)`/g)].map((m) => (m[1] ?? "").split(/\s+/)[0] ?? ""),
      ...[...text.matchAll(/`(scripts\/[A-Za-z0-9._-]+\.sh)/g)].map((m) => m[1] ?? ""),
    ].filter((name) => name.length > 0);
    expect(named.length, "the skill names no real command and no real script").toBeGreaterThan(0);
  });

  test("every `scripts/*.sh` it names exists on disk", () => {
    const offenders: string[] = [];
    for (const { rel, text } of files) {
      for (const match of text.matchAll(/`(scripts\/[A-Za-z0-9._-]+\.sh)[^`]*`/g)) {
        const script = match[1] ?? "";
        if (!existsSync(join(FRAMEWORK_ROOT, script))) offenders.push(`${rel}: ${script} does not exist`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("the skill names no private workspace and no chat product", () => {
  /**
   * #191's rule, extended to the chat surface by owner decision: the skill talks about
   * "the owner's bridge, if one is installed" and never about a vendor, because which
   * bridge (if any) is installed is not this repo's business.
   */
  const FORBIDDEN: { re: RegExp; why: string }[] = [
    { re: /\baparece(?:-v2)?\b/i, why: "a private workspace name (#191)" },
    { re: /\bcodiks\b/i, why: "a private workspace name (#191)" },
    { re: /\bscavtopia\b/i, why: "a private workspace name (#191)" },
    { re: /\bwhatsapp-agent\b/i, why: "a private workspace name (#191)" },
    { re: /\bslack\b/i, why: "a chat product — say \"the owner's bridge, if one is installed\"" },
    { re: /\bpumble\b/i, why: "a chat product — say \"the owner's bridge, if one is installed\"" },
    { re: /\bdiscord\b/i, why: "a chat product — say \"the owner's bridge, if one is installed\"" },
    { re: /\btelegram\b/i, why: "a chat product — say \"the owner's bridge, if one is installed\"" },
  ];
  const files = skillFiles();

  for (const { re, why } of FORBIDDEN) {
    test(`nothing in the skill tree matches ${String(re)}`, () => {
      const offenders = files.flatMap(({ rel, text }) =>
        text.split("\n").flatMap((line, i) => (re.test(line) ? [`${rel}:${i + 1}: ${line.trim()}`] : [])),
      );
      expect(offenders, `${why}\n${offenders.join("\n")}`).toEqual([]);
    });
  }
});

describe("every rule the skill cites resolves to a real heading", () => {
  const agents = readFileSync(join(FRAMEWORK_ROOT, "AGENTS.md"), "utf8");
  const releasing = readFileSync(join(FRAMEWORK_ROOT, "docs", "RELEASING.md"), "utf8");
  const agentSections = new Set(
    [...agents.matchAll(/^## (\d+)\. /gm)].map((match) => match[1] ?? ""),
  );
  const files = skillFiles();

  test("AGENTS.md has numbered sections to cite", () => {
    expect(agentSections.size).toBeGreaterThan(5);
  });

  test("every `AGENTS.md §N` (and bare §N) names a section that exists", () => {
    const offenders: string[] = [];
    for (const { rel, text } of files) {
      for (const match of text.matchAll(/§([\d/§. ]*\d)/g)) {
        for (const section of (match[1] ?? "").split(/[^\d]+/).filter((s) => s.length > 0)) {
          if (!agentSections.has(section)) offenders.push(`${rel}: §${section} is not an AGENTS.md section`);
        }
      }
    }
    expect([...new Set(offenders)]).toEqual([]);
  });

  test("the skill cites at least one real AGENTS.md section", () => {
    const cited = files.flatMap(({ text }) =>
      [...text.matchAll(/§([\d/§. ]*\d)/g)].flatMap((match) =>
        (match[1] ?? "").split(/[^\d]+/).filter((section) => agentSections.has(section)),
      ),
    );
    expect(cited.length, "the skill cites no AGENTS.md section — it is not referencing the rules").toBeGreaterThan(0);
  });

  test("every RELEASING.md section it quotes exists as a heading", () => {
    const offenders: string[] = [];
    for (const { rel, text } of files) {
      for (const match of text.matchAll(/RELEASING\.md\s+"([^"]+)"/g)) {
        const heading = match[1] ?? "";
        if (!releasing.includes(`## ${heading}`)) offenders.push(`${rel}: RELEASING.md has no "## ${heading}"`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * The two facts a maintainer session gets WRONG on its own, both measured on 2026-09-07:
 *
 *   1. A fresh reviewer, told only that it "may run tests", ran the whole suite on its own
 *      initiative. The full suite (4,200 tests, ~10 min) then ran THREE times in series for
 *      one wave — implementer (§3 requires it), reviewer, and `merge-wave.sh` (by design) —
 *      and the reviewer's run verified nothing the wave would not re-verify on the MERGED
 *      tree. Ten minutes of pure duplication per wave, so the brief has to say the negative
 *      out loud: targeted files, never the whole suite.
 *   2. The review-record path is built from the branch name VERBATIM, so a slash in the
 *      branch is a directory. `.review/<branch>.md` for `fix/x` is `.review/fix/x.md` — the
 *      gate's first real refusal in the wild, and five minutes to read.
 *
 * These assert the SENTENCES, because a brief is only as good as what it actually says: an
 * instruction the reviewer never reads cannot change what the reviewer runs.
 */
describe("the reviewer is told to run targeted tests, never the full suite", () => {
  const briefs = skillFiles().find((f) => f.rel.endsWith("sub-agent-briefs.md"));

  test("references/sub-agent-briefs.md exists", () => {
    expect(briefs, ".claude/skills/maintain/references/sub-agent-briefs.md is missing").toBeDefined();
  });

  test("the reviewer brief forbids the full `bun test` in so many words", () => {
    const text = briefs?.text ?? "";
    expect(
      text.includes("never the full `bun test`"),
      "the reviewer brief does not say `never the full `bun test``, so a reviewer will run it again:\n" +
        "the wave re-runs every gate on the merged tree (AGENTS.md §3)",
    ).toBe(true);
  });

  test("the reviewer brief says WHICH tests to run instead", () => {
    const text = briefs?.text ?? "";
    expect(
      text.includes("test files that cover the diff"),
      "the reviewer brief forbids the full suite without naming the alternative — a bare prohibition leaves the reviewer with no instruction",
    ).toBe(true);
  });

  test("SKILL.md §3 states the same rule once, citing the brief", () => {
    const text = existsSync(SKILL_MD) ? readFileSync(SKILL_MD, "utf8") : "";
    expect(
      text.includes("never the full `bun test`"),
      "SKILL.md does not carry the one-liner — the rule lives only in the brief, where the workflow reader never sees it",
    ).toBe(true);
  });
});

describe("the verbatim-branch-name rule for the review record is written down", () => {
  test("AGENTS.md §2 says a slash in the branch name is a directory", () => {
    const agents = readFileSync(join(FRAMEWORK_ROOT, "AGENTS.md"), "utf8");
    expect(
      agents.includes("a slash in the branch name is a directory"),
      "AGENTS.md §2 — the canonical rule file — does not say it, so nowhere does",
    ).toBe(true);
  });

  test("SKILL.md points at the verbatim branch name and cites §2 for the rest", () => {
    const text = existsSync(SKILL_MD) ? readFileSync(SKILL_MD, "utf8") : "";
    expect(
      text.includes("branch name verbatim"),
      "SKILL.md never warns that the record path takes the branch name verbatim",
    ).toBe(true);
  });
});
