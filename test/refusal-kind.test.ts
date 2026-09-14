/**
 * gh #278 — a headless permission refusal names its CURE, not only its symptom.
 *
 * Measured on two real runs in one day (six refusals, sonnet and opus
 * developers, with #271's prompt sentence in front of them): every refused line
 * was either a CHAIN (`a && b`, `cmd; echo`, `cmd > log 2>&1`, `diff <(…)`) or
 * a git VERB the developer does not hold (`git checkout --`, `git status`,
 * `git log`, `git merge-tree`, `git rev-parse`), and the ledger recorded both
 * causes with one identical sentence. This file pins the classifier — one leaf,
 * data in, data out — the cure sentence each kind appends, the verb list the
 * prompt derives from the SAME constant the grant is built from, and the one
 * retry bound.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  classifyRefusal, MAX_SEPARATOR_RETRIES, OUTCOME_ALREADY_REPORTED, refusalCure, separatorCurePrefix,
} from "../src/core/build/refusalKind.ts";
import { DEVELOPER_GIT_VERBS, developerGitGrants } from "../src/core/build/developerGrants.ts";
import { developerTools, permissionBlockReason } from "../src/core/facilitator/executors/build.ts";
import { buildDeveloperPrompt } from "../src/core/build/prompts.ts";
import { unquotedShellSeparator } from "../src/hooks/lib/story.ts";
import type { PlannedEpic, PlannedStory } from "../src/core/build/plan.ts";

// The six lines measured in the field, verbatim shape (paths shortened).
const FIELD = {
  checkoutChain: "git checkout -- src/f.cs && sha256sum src/f.cs && git status",
  mergeTreePipe: "git merge-tree epic HEAD 2>&1 | head -100",
  gateEcho: 'scripts/gate/build.sh; echo "EXIT:$?"',
  gateRedirect: "scripts/gate/build.sh > /tmp/build_out.txt 2>&1; echo",
  diffSubst: "diff <(sed -n '1,300p' f) /dev/null | head -5; git log -1 -- f; git log -1 -- g",
  revParse: "git rev-parse HEAD:f; git hash-object f; mkdir -p /tmp/s2ev",
} as const;

describe("unquotedShellSeparator — the tokenizer `splitArgv` already has, asked one question", () => {
  test("every bare separator is found, and named", () => {
    expect(unquotedShellSeparator("a && b")).toBe("&&");
    expect(unquotedShellSeparator("a || b")).toBe("||");
    expect(unquotedShellSeparator("a | head")).toBe("|");
    expect(unquotedShellSeparator("a; b")).toBe(";");
    expect(unquotedShellSeparator("a > log")).toBe(">");
    expect(unquotedShellSeparator("a >> log")).toBe(">>");
    expect(unquotedShellSeparator("a < in")).toBe("<");
    expect(unquotedShellSeparator("a 2>&1")).toBe("2>&1");
    expect(unquotedShellSeparator("echo $(date)")).toBe("$(");
    expect(unquotedShellSeparator("diff <(sort a) b")).toBe("<");
    expect(unquotedShellSeparator("echo `date`")).toBe("`");
    expect(unquotedShellSeparator("a &")).toBe("&");
  });

  test("a separator INSIDE quotes is an argument, not a separator — as this tokenizer reads quotes", () => {
    // `splitArgv` hands a quoted token to the child whole; the same reading here,
    // so the two cannot disagree about one line. Whether the HOST's permission
    // layer reads quotes the same way is not claimed by this test.
    expect(unquotedShellSeparator('git commit -m "fix; and more"')).toBeNull();
    expect(unquotedShellSeparator("git commit -m 'a && b'")).toBeNull();
    expect(unquotedShellSeparator('echo "EXIT:$?"')).toBeNull();
  });

  test("a glob, a tilde or a plain `$VAR` is a metacharacter `splitArgv` refuses, but NOT a separator", () => {
    expect(unquotedShellSeparator("git add *.ts")).toBeNull();
    expect(unquotedShellSeparator("ls ~/x")).toBeNull();
    expect(unquotedShellSeparator("echo $HOME")).toBeNull();
  });

  test("arithmetic expansion `$((…))` is not a command substitution — a line with it is still alone", () => {
    // Review finding on the first cut: `\\$\\(` also matched `$((`, so a line that
    // was already alone would have burned the one retry on a cure that cannot apply.
    expect(unquotedShellSeparator("echo $((1+2))")).toBeNull();
    expect(classifyRefusal("echo $((1+2))")).toEqual({ kind: "unknown" });
    expect(unquotedShellSeparator("echo $(date)")).toBe("$(");
  });

  test("a newline splits a line as surely as `;`", () => {
    expect(unquotedShellSeparator("a\nb")).toBe("\n");
  });
});

describe("classifyRefusal (gh #278)", () => {
  test("every field line with a chain is `separator`, named by its first separator", () => {
    expect(classifyRefusal(FIELD.checkoutChain)).toEqual({ kind: "separator", separator: "&&", capturing: false });
    expect(classifyRefusal(FIELD.mergeTreePipe)).toEqual({ kind: "separator", separator: "2>&1", capturing: true });
    expect(classifyRefusal(FIELD.gateEcho)).toEqual({ kind: "separator", separator: ";", capturing: true });
    expect(classifyRefusal(FIELD.gateRedirect)).toEqual({ kind: "separator", separator: ">", capturing: true });
    expect(classifyRefusal(FIELD.diffSubst)).toEqual({ kind: "separator", separator: "<", capturing: false });
    expect(classifyRefusal(FIELD.revParse)).toEqual({ kind: "separator", separator: ";", capturing: false });
  });

  test("a chain is `separator` even when its first fragment is also an ungranted verb — the chain is what runs first", () => {
    expect(classifyRefusal("git checkout -- f && git status").kind).toBe("separator");
  });

  test("an ungranted git verb, alone, is `verb`, with the granted equivalent named where one exists", () => {
    expect(classifyRefusal("git checkout -- src/f.cs")).toEqual({
      kind: "verb", verb: "checkout", equivalent: "git restore <path>",
    });
    expect(classifyRefusal("git checkout src/f.cs")).toEqual({
      kind: "verb", verb: "checkout", equivalent: "git restore <path>",
    });
    expect(classifyRefusal("git reset -- src/f.cs")).toEqual({
      kind: "verb", verb: "reset", equivalent: "git restore --staged <path>",
    });
    expect(classifyRefusal("git reset HEAD src/f.cs")).toEqual({
      kind: "verb", verb: "reset", equivalent: "git restore --staged <path>",
    });
  });

  test("an ungranted verb with NO granted equivalent says so, and invents none", () => {
    // `git status` and `git log` were on this list until #287 granted them; the
    // verbs that remain ungranted are the ones that move history or another tree.
    expect(classifyRefusal("git rev-parse HEAD")).toEqual({ kind: "verb", verb: "rev-parse", equivalent: null });
    expect(classifyRefusal("git stash")).toEqual({ kind: "verb", verb: "stash", equivalent: null });
    expect(classifyRefusal("git merge-tree epic HEAD")).toEqual({ kind: "verb", verb: "merge-tree", equivalent: null });
    // A branch switch is not a file restore: no equivalent is offered for it.
    expect(classifyRefusal("git checkout -b topic")).toEqual({ kind: "verb", verb: "checkout", equivalent: null });
    expect(classifyRefusal("git reset --hard")).toEqual({ kind: "verb", verb: "reset", equivalent: null });
  });

  test("a GRANTED git verb that was still refused is `unknown` — the grant is not the cause and no cure is claimed", () => {
    // #261's measured shape: refused for a reason the line does not show.
    expect(classifyRefusal("git rm -- unused.txt")).toEqual({ kind: "unknown" });
    expect(classifyRefusal("git commit -m 'a; b'")).toEqual({ kind: "unknown" });
  });

  test("a non-git line with no separator is `unknown`; a `-C` line is its OWN kind (gh #287)", () => {
    expect(classifyRefusal("sha256sum src/f.cs")).toEqual({ kind: "unknown" });
    // Until #287 this classified as `unknown` and the developer was told nothing.
    expect(classifyRefusal("git -C /elsewhere rm -- o.txt")).toEqual({ kind: "elsewhere", option: "-C" });
    expect(classifyRefusal("git --git-dir=/elsewhere/.git log")).toEqual({ kind: "elsewhere", option: "--git-dir" });
    expect(classifyRefusal("")).toEqual({ kind: "unknown" });
  });

  test("the verb allowlist the classifier reads IS the one the grant is built from", () => {
    for (const verb of DEVELOPER_GIT_VERBS) {
      expect(classifyRefusal(`git ${verb} x`)).toEqual({ kind: "unknown" });
      expect(developerTools([])).toContain(`Bash(git ${verb} *)`);
    }
    expect(developerGitGrants()).toEqual(DEVELOPER_GIT_VERBS.map((verb) => `Bash(git ${verb} *)`));
    // Every `Bash(git …)` grant the developer holds comes from the constant.
    const gitGrants = developerTools([]).filter((tool) => tool.startsWith("Bash(git "));
    expect(gitGrants).toEqual([...developerGitGrants()]);
  });
});

describe("refusalCure — the sentence each kind appends", () => {
  test("separator: run each command alone, and why", () => {
    expect(refusalCure(classifyRefusal("git add -A && git commit -m x"))).toBe(
      "run each command alone — shell separators split a line into subcommands that each need their own grant",
    );
    // gh #294: the field line's chain is a CAPTURE, so the cure also says why the capture is unneeded.
    expect(refusalCure(classifyRefusal(FIELD.gateEcho))).toBe(
      "run each command alone — shell separators split a line into subcommands that each need their own "
      + `grant. The exit code is not lost by dropping it: ${OUTCOME_ALREADY_REPORTED}`,
    );
  });

  test("verb with an equivalent names it; without one it names only the refusal", () => {
    expect(refusalCure(classifyRefusal("git checkout -- f"))).toBe("`git checkout` is not granted; use `git restore <path>`");
    expect(refusalCure(classifyRefusal("git stash"))).toBe("`git stash` is not granted");
    // `git status` is granted since #287, so the classifier claims no cure for it.
    expect(refusalCure(classifyRefusal("git status"))).toBe("");
  });

  test("unknown: nothing is appended", () => {
    expect(refusalCure(classifyRefusal("git rm -- unused.txt"))).toBe("");
  });

  // #261's exact wording as the BASE — the cure follows it, never replaces it.
  const BASE_FOR = (command: string): string =>
    `permission — \`${command}\` was refused for approval by the agent's own permission layer, `
    + "and a headless turn has nobody to approve it: the same allowance would refuse it again, "
    + "so this attempt was not repeated";

  test("permissionBlockReason keeps #261's text verbatim as the base and appends the cure", () => {
    expect(permissionBlockReason("git rm -- unused.txt")).toBe(BASE_FOR("git rm -- unused.txt"));
    expect(permissionBlockReason(FIELD.gateEcho)).toBe(
      `${BASE_FOR(FIELD.gateEcho)}. The cure: run each command alone — shell separators split a line `
      + "into subcommands that each need their own grant. The exit code is not lost by dropping it: "
      + `${OUTCOME_ALREADY_REPORTED}`,
    );
    expect(permissionBlockReason("git checkout -- f")).toBe(
      `${BASE_FOR("git checkout -- f")}. The cure: \`git checkout\` is not granted; use \`git restore <path>\``,
    );
  });

  test("a block AFTER the one retry says the cure was already stated once", () => {
    expect(permissionBlockReason("git checkout -- f", { retried: true })).toBe(
      `${BASE_FOR("git checkout -- f")} beyond the one re-spawn with the cure stated, which was refused too. `
      + "The cure: `git checkout` is not granted; use `git restore <path>`",
    );
  });
});

describe("the one retry (gh #278)", () => {
  test("the bound is ONE, by name", () => {
    expect(MAX_SEPARATOR_RETRIES).toBe(1);
  });

  test("the cure prefix names the refused line and the rule, first", () => {
    const prefix = separatorCurePrefix(FIELD.gateEcho);
    expect(prefix.split("\n")[0]).toBe(
      `Your previous command \`${FIELD.gateEcho}\` was refused because it chains commands. Run each command alone.`,
    );
  });
});

// ---------------------------------------------------------------------------
// The developer prompt lists the verbs it holds — from the constant, and no other.
// ---------------------------------------------------------------------------

const EPIC: PlannedEpic = {
  epic: {
    version: 1, id: "E1", title: "One epic", repos: ["app"],
    stories: ["S1"], branch: "epic/e1", status: "todo",
  },
  text: "# E1\n",
  path: "/nowhere/E1.md",
  rel: "03-plan/epics/E1.md",
};

const STORY: PlannedStory = {
  story: {
    version: 1, id: "S1", epic: "E1", title: "One story",
    repo: "app", status: "todo", depends_on: [], touches: [],
    acceptance: ["it works"], test_plan: ["$ npm run test -> exit 0"], evidence: [],
  },
  dod: { present: true, commands: ["npm run test"] },
  text: "# S1\n",
  path: "/nowhere/S1.md",
  rel: "03-plan/stories/S1.md",
  wave: "W1",
  goal: [],
};

function prompt(): string {
  return buildDeveloperPrompt({
    runId: "260913-r",
    story: STORY,
    epic: EPIC,
    repoName: "app",
    branch: "story/260913-r/S1",
    epicBranch: "epic/e1",
    worktree: "/nowhere",
    commands: ["npm run test"],
    conventions: "_none_",
    facts: "_none_",
    experts: [],
    budgetUsd: 4,
  });
}

describe("the developer prompt's git verbs (gh #278)", () => {
  test("the prompt names every verb from the constant and no other `git <verb>`", () => {
    const text = prompt();
    const named = new Set([...text.matchAll(/`git ([a-z-]+)/g)].map((m) => m[1]));
    expect([...named].sort()).toEqual([...DEVELOPER_GIT_VERBS].sort());
    // The LIST line itself, in order — the sentence before it already says
    // `git add` and `git commit`, so a list that dropped one of those would pass
    // the set check above (measured: a `.slice(1)` mutation did). This one reads
    // the list and only the list.
    const line = text.split("\n").find((l) => l.includes("The git verbs you hold are exactly ")) ?? "";
    const list = line.slice(line.indexOf("exactly "));
    expect([...list.matchAll(/`git ([a-z-]+)`/g)].map((m) => m[1])).toEqual([...DEVELOPER_GIT_VERBS]);
  });

  test("`git restore <path>` is named as the way to put a file back", () => {
    expect(prompt()).toContain("`git restore <path>` is how to put a file back");
  });

  test("the list in the prompt is rendered from the constant, so the two cannot drift", () => {
    const source = readFileSync(join(import.meta.dir, "..", "src", "core", "build", "prompts.ts"), "utf8");
    expect(source).toContain("DEVELOPER_GIT_VERBS");
  });
});

// ---------------------------------------------------------------------------
// gh #287 / gh #294 — a developer may READ its own tree, and every cure says WHY.
// ---------------------------------------------------------------------------

/** The read-only verbs, as #287 measured them missing. Not derived: the point is the LIST. */
const READ_VERBS = ["status", "log", "diff", "show"] as const;

describe("the developer holds the read-only git verbs (gh #287)", () => {
  test("each read verb is granted, so a developer can look at its own tree", () => {
    for (const verb of READ_VERBS) {
      expect(developerTools([])).toContain(`Bash(git ${verb} *)`);
      expect(DEVELOPER_GIT_VERBS as readonly string[]).toContain(verb);
    }
  });

  test("a refused read verb is no longer blamed on the allowance", () => {
    // The field line from #287, with the `-C` dropped: it is granted now.
    expect(classifyRefusal("git log --oneline -5")).toEqual({ kind: "unknown" });
    expect(classifyRefusal("git status")).toEqual({ kind: "unknown" });
  });

  test("`git -C <path>` is refused DELIBERATELY and the cure names the reason", () => {
    expect(classifyRefusal("git -C /w/260913-r-S5 log --oneline -5")).toEqual({
      kind: "elsewhere", option: "-C",
    });
    const cure = refusalCure(classifyRefusal("git -C /w/260913-r-S5 log --oneline -5"));
    expect(cure).toContain("-C");
    // The WHY, not only the WHAT: the next reader must not add `-C` to the grant.
    expect(cure).toContain("points git at another directory");
    expect(cure).toContain("Your working directory already is the worktree");
  });
});

describe("a cure says WHY, not only what (gh #294)", () => {
  test("an `echo $?` tail is told the exit code is already reported to it", () => {
    const cure = refusalCure(classifyRefusal('scripts/gate/test.sh; echo "EXIT_STATUS_MARKER:$?"'));
    expect(cure).toContain("each need their own grant");
    expect(cure).toContain("records each command's exit code");
  });

  test("a redirect-to-file capture is told the same thing", () => {
    expect(refusalCure(classifyRefusal("scripts/gate/test.sh > /tmp/s2_test.log 2>&1")))
      .toContain("records each command's exit code");
  });

  test("a chain that is NOT an exit-code idiom keeps the plain separator cure", () => {
    expect(refusalCure(classifyRefusal("git add -A && git commit -m x"))).toBe(
      "run each command alone — shell separators split a line into subcommands that each need their own grant",
    );
  });

  test("the retry prefix put in front of the prompt carries the same why", () => {
    const prefix = separatorCurePrefix('scripts/gate/test.sh; echo "GATE_TEST_EXIT=$?"');
    expect(prefix).toContain("records each command's exit code");
  });
});

describe("the developer prompt's cures carry a why-clause (gh #287, gh #294)", () => {
  test("the read verbs are listed, and `-C` is named as the thing not to reach for", () => {
    const text = prompt();
    expect(text).toContain("`git restore <path>` is how to put a file back");
    for (const verb of READ_VERBS) expect(text).toContain(`\`git ${verb}\``);
    expect(text).toContain("`-C <path>`");
    expect(text).toContain("points git at another directory");
  });

  test("the DoD rule says why the echo is unnecessary, not only that it is refused", () => {
    expect(prompt()).toContain("records each command's exit code");
  });
});
