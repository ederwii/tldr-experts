/**
 * `plugin/skills/tldrx-plan/SKILL.md` — the planning skill `tldrx install --claude`
 * installs beside the facilitator (#291).
 *
 * Its design premise is the same as the maintain skill's: it REFERENCES the seed
 * rules instead of restating them. The rules live in ONE place —
 * `docs/guide/05-seeds-and-triage.md`, "Writing a seed by hand" — and a second
 * copy that drifts is the failure mode this repo exists to kill. A prose file
 * cannot hold that premise on its own, so these assertions do:
 *
 *   1. it is a real skill (frontmatter `name: tldrx-plan`, a description, and
 *      `disable-model-invocation: true` — its body costs nothing until invoked)
 *   2. it cites the guide page for the grammar rather than carrying the grammar
 *   3. every rule that exists because of an OPEN bug is marked as a patch with
 *      its issue number, so it can be deleted when the issue closes — the owner's
 *      house rule for this skill. The craft rules carry no number.
 *   4. every `tldrx …` it names is a declared command with declared flags —
 *      AGENTS.md §1: never quote a flag from memory
 *   5. it ends with the exact `run new` line the unattended recipe uses, and
 *      names `seed check` before it
 *   6. it names no private workspace and no chat product (#191)
 *
 * Cheap and hermetic: reads files, spawns nothing.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FRAMEWORK_ROOT, PLUGIN_DIR } from "../src/core/paths.ts";
import { HELP_ENTRIES, declaredFlags, subcommandsOf } from "../src/cli/helpText.ts";
import { PLAN_SKILL_RELATIVE } from "../src/core/install/skillFile.ts";
import { PATTERN_A_FRAGMENT, PATTERN_B_FRAGMENT, PATTERN_C_FRAGMENT, PATTERN_D_FRAGMENT } from "./public-surface-consistency.test.ts";

const SKILL_MD = join(PLUGIN_DIR, ...PLAN_SKILL_RELATIVE.split("/"));
const GUIDE = "docs/guide/05-seeds-and-triage.md";
const GUIDE_ANCHOR = "#writing-a-seed-by-hand";

function skill(): string {
  return existsSync(SKILL_MD) ? readFileSync(SKILL_MD, "utf8") : "";
}

describe("the plan skill is a real skill", () => {
  test("SKILL.md exists at the path install reads", () => {
    expect(existsSync(SKILL_MD), `${SKILL_MD} is missing`).toBe(true);
  });

  test("frontmatter declares name: tldrx-plan, a description, and disable-model-invocation", () => {
    const front = /^---\n([\s\S]*?)\n---\n/.exec(skill())?.[1] ?? "";
    expect(front, "no YAML frontmatter block").not.toBe("");
    expect(/^name: tldrx-plan$/m.test(front), `no \`name: tldrx-plan\`:\n${front}`).toBe(true);
    expect((/^description: (.+)$/m.exec(front)?.[1] ?? "").length).toBeGreaterThan(40);
    expect(/^disable-model-invocation: true$/m.test(front)).toBe(true);
  });

  test("stays a workflow, not a rulebook copy (< 220 lines)", () => {
    expect(skill().split("\n").length).toBeLessThan(220);
  });
});

describe("it cites the seed grammar instead of restating it", () => {
  test("names the guide page and its anchor", () => {
    const text = skill();
    expect(text).toContain(GUIDE);
    expect(text).toContain(GUIDE_ANCHOR);
  });

  test("the guide page and the anchor's heading exist", () => {
    const guide = readFileSync(join(FRAMEWORK_ROOT, GUIDE), "utf8");
    expect(guide).toContain("### Writing a seed by hand");
  });

  test("does not carry the `[src:` production table — the guide does", () => {
    // The guide's grammar bullets each open with a bold rule; the skill may say
    // "citations: see the guide" and no more. Three of the guide's own bold openers
    // are the tell for a copy.
    const text = skill();
    expect(text).not.toContain("**Close every `[src:` you open.**");
    expect(text).not.toContain("**A `file` source is");
    expect(text).not.toContain("**Several sources in one token");
  });
});

describe("every rule born from an open bug is marked as a patch with its issue", () => {
  const MARKERS: { re: RegExp; why: string }[] = [
    { re: /patch for #286\/#244\/#280/, why: "the size rule is the CURRENT capability, tied to #286/#244/#280" },
    { re: /patch for #290 — the planner checks this by hand until Plan can/, why: "the declared-tools rule is a PLANNER rule until #290 lets Plan detect an undeclared tool; #285 shipped only the operator cure" },
    { re: /measured on #285/, why: "the declared-tools rule cites its measurement (#285: an undeclared tool cost four developers)" },
    { re: /#244\/#289/, why: "the derived-budget rule exists because of #244/#289 (a $10.80 Build stage killed its reviewer)" },
    { re: /#268\/#286/, why: "the boundary rule exists because of #268/#286 (one conflicted file became four)" },
    { re: /#278\/#285/, why: "the approved-snapshot rule comes from the #278/#285 field notes" },
  ];
  for (const { re, why } of MARKERS) {
    test(`carries ${String(re)}`, () => {
      expect(re.test(skill()), why).toBe(true);
    });
  }

  test("a git line is never blamed on commands: — git verbs are a separate grant (#285, measured)", () => {
    const text = skill();
    expect(text).toContain("git verbs are a separate grant");
  });

  test("the size rule says it is the measured limit, not a design preference, and tells the planner where to read the current one", () => {
    const text = skill();
    expect(text).toContain("measured limit, not a design preference");
    expect(text).toContain("CHANGELOG");
  });

  test("the craft rules carry no issue number on their line", () => {
    const text = skill();
    for (const craft of ["Recommended:", "byte-equal"]) {
      const lines = text.split("\n").filter((line) => line.includes(craft) && /^\s*-\s+\*\*/.test(line));
      expect(lines.length, `no bullet rule mentions ${craft}`).toBeGreaterThan(0);
      for (const line of lines) {
        expect(/\(patch for #\d+/.test(line), `craft rule marked as a patch: ${line}`).toBe(false);
      }
    }
  });
});

describe("every command the skill names exists", () => {
  test("every backticked `tldrx …` names a declared command, subcommand and flags", () => {
    const names = new Set(HELP_ENTRIES.map((entry) => entry.name));
    const offenders: string[] = [];
    for (const match of skill().matchAll(/`tldrx ([^`]+)`/g)) {
      const invocation = match[1] ?? "";
      const tokens = invocation.split(/\s+/).filter((token) => token.length > 0);
      const command = tokens[0] ?? "";
      if (!names.has(command)) { offenders.push(`\`tldrx ${invocation}\` — no such command`); continue; }
      const subs = subcommandsOf(command);
      const first = tokens[1];
      if (subs.length > 0 && first !== undefined && !first.startsWith("-") && !first.startsWith("<") && !subs.includes(first)) {
        offenders.push(`\`tldrx ${invocation}\` — \`${first}\` is not a subcommand of ${command}`);
      }
      const flags = declaredFlags(command);
      for (const token of tokens.slice(1)) {
        if (!token.startsWith("--")) continue;
        const flag = token.replace(/^--/, "").split("=")[0] ?? "";
        if (!flags.has(flag)) offenders.push(`\`tldrx ${invocation}\` — \`--${flag}\` is not declared for ${command}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("names the validator and ends with the exact unattended `run new` line, every flag of which is declared", () => {
    const text = skill();
    expect(text).toContain("`tldrx seed check <file>`");
    const line = "tldrx run new <slug> --scope <s> --seed <file> --gates none --questions none --ship merge --budget <usd>";
    expect(text).toContain(line);
    expect(text.lastIndexOf("tldrx seed check")).toBeLessThan(text.lastIndexOf(line));
    const flags = declaredFlags("run");
    for (const flag of ["scope", "seed", "gates", "questions", "ship", "budget"]) expect(flags.has(flag), flag).toBe(true);
    expect(subcommandsOf("seed")).toContain("check");
  });
});

describe("the skill names no private workspace and no chat product", () => {
  const FORBIDDEN: { re: RegExp; why: string }[] = [
    { re: new RegExp(`\\b${PATTERN_A_FRAGMENT}(?:-v2)?\\b`, "i"), why: "a private workspace name (#191)" },
    { re: new RegExp(`\\b${PATTERN_D_FRAGMENT}\\b`, "i"), why: "a private workspace name (#191)" },
    { re: new RegExp(`\\b${PATTERN_B_FRAGMENT}\\b`, "i"), why: "a private workspace name (#191)" },
    { re: new RegExp(`\\b${PATTERN_C_FRAGMENT}(?:-agent)?\\b`, "i"), why: "a private workspace name (#191)" },
    { re: /\bslack\b/i, why: "a chat product" },
    { re: /\bpumble\b/i, why: "a chat product" },
  ];
  for (const { re, why } of FORBIDDEN) {
    test(`nothing matches ${String(re)}`, () => {
      const offenders = skill().split("\n").flatMap((line, i) => (re.test(line) ? [`${i + 1}: ${line.trim()}`] : []));
      expect(offenders, why).toEqual([]);
    });
  }
});
