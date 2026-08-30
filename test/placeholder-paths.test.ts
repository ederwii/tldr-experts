/**
 * Declared paths that are a SHAPE rather than a path: `03-plan/stories/<id>.md`.
 *
 * The bug these tests exist for was reproduced live on 2026-08-30, by the first
 * `feature`-scope run to reach Plan. Plan wrote `03-plan/epics/E1.md` and
 * `03-plan/stories/S1.md`..`S7.md`, and `tldrx next --commit` refused the stage:
 *
 *   03-plan/plan failed: 03-plan/epics/<epic>.md was declared as an output but
 *   does not exist on disk; 03-plan/stories/<id>.md was declared as an output but
 *   does not exist on disk
 *
 * Eight files on disk, and the validator asked `existsSync` about a path with a
 * literal `<id>` in it. So the tests here are about the SEAM — everywhere a
 * declared path meets the filesystem — not about `validateOutputs` alone:
 * `present`/`missing` feed the required-input gate, `expandPatterns` feeds the
 * prompt, and `resolveMany` feeds the previous-attempt inline and `--dry-run`'s
 * revert. A one-off fix in the validator would have moved the same failure one
 * stage down the loop, into Build's inputs.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  existsDeclared, expandAll, expandPatterns, isPattern, matchPattern, missing, present, resolveDeclared,
  resolveMany, type PathContext,
} from "../src/core/facilitator/paths.ts";
import { validateOutputs, describeProblems } from "../src/core/facilitator/validateOutputs.ts";

let roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

interface Bed {
  readonly ctx: PathContext;
  readonly root: string;
  readonly runDir: string;
  readonly write: (rel: string, text: string) => void;
  readonly writeAtRoot: (rel: string, text: string) => void;
}

/** A workspace root with a run dir inside it — the two bases `paths.ts` knows. */
function bed(): Bed {
  const root = mkdtempSync(join(tmpdir(), "tldrx-pattern-"));
  roots.push(root);
  const runDir = join(root, "tldrx-work", "260830-demo");
  mkdirSync(runDir, { recursive: true });
  const at = (base: string) => (rel: string, text: string): void => {
    const path = join(base, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text, "utf8");
  };
  return { ctx: { root, runDir }, root, runDir, write: at(runDir), writeAtRoot: at(root) };
}

/** A story file carrying both required sections. */
function story(id: string): string {
  return `# ${id}\n\n## Acceptance\n- it works\n\n## Test plan\n- run it\n`;
}

const SECTIONS = new Map<string, readonly string[]>([
  ["03-plan/stories/<id>.md", ["Acceptance", "Test plan"]],
]);

describe("isPattern tells a shape from a path", () => {
  test("an angle-bracket token in any segment is a pattern", () => {
    expect(isPattern("03-plan/stories/<id>.md")).toBe(true);
    expect(isPattern("03-plan/epics/<epic>.md")).toBe(true);
    expect(isPattern(".tldrx/worktrees/<repo>/<story-id>/notes.md")).toBe(true);
  });

  test("`{repo}` is not — it expands off the run's repo list, never off the disk", () => {
    expect(isPattern(".tldrx/map/{repo}/gotchas.md")).toBe(false);
    expect(isPattern("03-plan/waves.yml")).toBe(false);
    expect(isPattern("01-what/intent.md")).toBe(false);
  });
});

describe("validateOutputs: a pattern output", () => {
  test("passes when at least one file matches — the live 2026-08-30 failure", () => {
    const b = bed();
    b.write("03-plan/epics/E1.md", "# E1\n");
    for (const id of ["S1", "S2", "S3", "S4", "S5", "S6", "S7"]) b.write(`03-plan/stories/${id}.md`, story(id));

    const problems = validateOutputs(
      ["03-plan/epics/<epic>.md", "03-plan/stories/<id>.md"],
      new Map(),
      b.ctx,
    );
    expect(problems).toEqual([]);
  });

  test("one match is enough — a plan with a single story is a plan", () => {
    const b = bed();
    b.write("03-plan/stories/S1.md", story("S1"));
    expect(validateOutputs(["03-plan/stories/<id>.md"], new Map(), b.ctx)).toEqual([]);
  });

  test("fails when nothing matches, and says so honestly", () => {
    const b = bed();
    mkdirSync(join(b.runDir, "03-plan", "stories"), { recursive: true });

    const problems = validateOutputs(["03-plan/stories/<id>.md"], new Map(), b.ctx);
    expect(problems).toEqual([
      { path: "03-plan/stories/<id>.md", message: "was declared as an output but no file matches it on disk" },
    ]);
    // The sentence the operator actually reads. It must NOT claim a file with a
    // literal `<id>` in its name was looked for and not found.
    expect(describeProblems(problems))
      .toBe("03-plan/stories/<id>.md was declared as an output but no file matches it on disk");
    expect(describeProblems(problems)).not.toContain("does not exist on disk");
  });

  test("fails when the directory itself was never created", () => {
    const b = bed();
    const problems = validateOutputs(["03-plan/stories/<id>.md"], new Map(), b.ctx);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toBe("was declared as an output but no file matches it on disk");
  });

  test("enforces `sections:` on EVERY matched file, naming the concrete one", () => {
    const b = bed();
    b.write("03-plan/stories/S1.md", story("S1"));
    b.write("03-plan/stories/S2.md", "# S2\n\n## Acceptance\n- it works\n");
    b.write("03-plan/stories/S3.md", "# S3\n\n## Acceptance\n\n## Test plan\n- run it\n");

    const problems = validateOutputs(["03-plan/stories/<id>.md"], SECTIONS, b.ctx);
    expect(problems).toEqual([
      { path: "03-plan/stories/S2.md", message: "is missing the required section `## Test plan`" },
      { path: "03-plan/stories/S3.md", message: "has an empty `## Acceptance` section" },
    ]);
    // S1 was fine and is not mentioned; the two that were not are named by file,
    // not by the shape they were matched through.
    expect(describeProblems(problems)).not.toContain("<id>");
  });

  test("a pattern whose every match satisfies the sections has nothing to report", () => {
    const b = bed();
    for (const id of ["S1", "S2"]) b.write(`03-plan/stories/${id}.md`, story(id));
    expect(validateOutputs(["03-plan/stories/<id>.md"], SECTIONS, b.ctx)).toEqual([]);
  });
});

describe("validateOutputs: nothing changes for a plain path", () => {
  test("the missing-file message is word for word what it always was", () => {
    const b = bed();
    const problems = validateOutputs(["03-plan/waves.yml"], new Map(), b.ctx);
    expect(problems).toEqual([
      { path: "03-plan/waves.yml", message: "was declared as an output but does not exist on disk" },
    ]);
  });

  test("sections on a plain path still fail on the declared path", () => {
    const b = bed();
    b.write("01-what/handoff.md", "# Handoff\n\n## Findings\n- a thing\n");
    const problems = validateOutputs(
      ["01-what/handoff.md"],
      new Map([["01-what/handoff.md", ["Findings", "Decisions"]]]),
      b.ctx,
    );
    expect(problems).toEqual([
      { path: "01-what/handoff.md", message: "is missing the required section `## Decisions`" },
    ]);
  });
});

describe("matchPattern reads the directory, and only the directory", () => {
  test("matches by fixed prefix and suffix, in a stable sorted order", () => {
    const b = bed();
    for (const id of ["S3", "S1", "S2"]) b.write(`03-plan/stories/${id}.md`, story(id));
    b.write("03-plan/stories/notes.txt", "not markdown");

    const hits = matchPattern("03-plan/stories/<id>.md", b.ctx);
    expect(hits.map((h) => h.path)).toEqual([
      "03-plan/stories/S1.md", "03-plan/stories/S2.md", "03-plan/stories/S3.md",
    ]);
    expect(hits.every((h) => existsSync(h.absolute))).toBe(true);
  });

  test("a prefix in the segment is honoured: `story-<id>.md` skips `epic-1.md`", () => {
    const b = bed();
    b.write("03-plan/stories/story-1.md", "a");
    b.write("03-plan/stories/story-2.md", "b");
    b.write("03-plan/stories/epic-1.md", "c");
    expect(matchPattern("03-plan/stories/story-<id>.md", b.ctx).map((h) => h.path))
      .toEqual(["03-plan/stories/story-1.md", "03-plan/stories/story-2.md"]);
  });

  test("a directory is never a match — a pattern stands for files", () => {
    const b = bed();
    mkdirSync(join(b.runDir, "03-plan", "stories", "S1.md"), { recursive: true });
    expect(matchPattern("03-plan/stories/<id>.md", b.ctx)).toEqual([]);
  });

  test("a token in a DIRECTORY segment branches the walk", () => {
    const b = bed();
    b.write("04-build/log/api/S1.md", "a");
    b.write("04-build/log/lab/S2.md", "b");
    expect(matchPattern("04-build/log/<repo>/<id>.md", b.ctx).map((h) => h.path))
      .toEqual(["04-build/log/api/S1.md", "04-build/log/lab/S2.md"]);
  });

  test("hidden files are not swept in by a bare token", () => {
    const b = bed();
    b.write("03-plan/stories/.DS_Store", "junk");
    expect(matchPattern("03-plan/stories/<id>", b.ctx)).toEqual([]);
    b.write("03-plan/stories/S1", "real");
    expect(matchPattern("03-plan/stories/<id>", b.ctx).map((h) => h.path)).toEqual(["03-plan/stories/S1"]);
  });

  test("the run dir wins over the workspace root, the same order `resolveDeclared` uses", () => {
    const b = bed();
    b.writeAtRoot("03-plan/stories/ROOT.md", "at the workspace root");
    expect(matchPattern("03-plan/stories/<id>.md", b.ctx).map((h) => h.path)).toEqual(["03-plan/stories/ROOT.md"]);

    b.write("03-plan/stories/S1.md", story("S1"));
    expect(matchPattern("03-plan/stories/<id>.md", b.ctx).map((h) => h.path)).toEqual(["03-plan/stories/S1.md"]);
  });

  test("a `.tldrx/` pattern resolves against the workspace root only", () => {
    const b = bed();
    b.write(".tldrx/experts/api/x.md", "inside the run — must not be seen");
    b.writeAtRoot(".tldrx/experts/api/expert.md", "the real one");
    expect(matchPattern(".tldrx/experts/api/<name>.md", b.ctx).map((h) => h.path))
      .toEqual([".tldrx/experts/api/expert.md"]);
  });
});

describe("present / missing count a pattern by its matches", () => {
  test("a pattern with matches is present; without, it is missing AS THE PATTERN", () => {
    const b = bed();
    b.write("03-plan/waves.yml", "waves: []\n");
    b.write("03-plan/stories/S1.md", story("S1"));
    const declared = ["03-plan/waves.yml", "03-plan/stories/<id>.md", "03-plan/epics/<epic>.md"];

    expect(present(declared, b.ctx)).toEqual(["03-plan/waves.yml", "03-plan/stories/<id>.md"]);
    // The gap line names the DECLARATION, because that is what went unanswered.
    // An operator told "03-plan/epics/E?.md is missing" would go looking for a
    // file nobody ever named.
    expect(missing(declared, b.ctx)).toEqual(["03-plan/epics/<epic>.md"]);
  });

  test("existsDeclared is the one question both of them ask", () => {
    const b = bed();
    b.write("03-plan/stories/S1.md", story("S1"));
    expect(existsDeclared("03-plan/stories/<id>.md", b.ctx)).toBe(true);
    expect(existsDeclared("03-plan/epics/<epic>.md", b.ctx)).toBe(false);
    expect(existsDeclared("03-plan/stories/S1.md", b.ctx)).toBe(true);
    expect(existsDeclared("03-plan/stories/S9.md", b.ctx)).toBe(false);
  });

  test("plain paths behave exactly as before", () => {
    const b = bed();
    b.write("01-what/intent.md", "# Intent\n");
    expect(present(["01-what/intent.md", "01-what/scope.md"], b.ctx)).toEqual(["01-what/intent.md"]);
    expect(missing(["01-what/intent.md", "01-what/scope.md"], b.ctx)).toEqual(["01-what/scope.md"]);
  });
});

describe("expandPatterns hands the PROMPT real files", () => {
  test("a pattern becomes its matches; a plain path passes through untouched", () => {
    const b = bed();
    b.write("03-plan/waves.yml", "waves: []\n");
    for (const id of ["S1", "S2"]) b.write(`03-plan/stories/${id}.md`, story(id));

    expect(expandPatterns(["03-plan/waves.yml", "03-plan/stories/<id>.md"], b.ctx))
      .toEqual(["03-plan/waves.yml", "03-plan/stories/S1.md", "03-plan/stories/S2.md"]);
  });

  test("a pattern that matches nothing drops out — there is no content behind a shape", () => {
    const b = bed();
    b.write("03-plan/waves.yml", "waves: []\n");
    expect(expandPatterns(["03-plan/waves.yml", "03-plan/stories/<id>.md"], b.ctx)).toEqual(["03-plan/waves.yml"]);
  });

  test("a plain path that does not exist is still passed through, present or not", () => {
    const b = bed();
    expect(expandPatterns(["03-plan/waves.yml"], b.ctx)).toEqual(["03-plan/waves.yml"]);
  });

  test("overlapping declarations are deduplicated", () => {
    const b = bed();
    b.write("03-plan/stories/S1.md", story("S1"));
    expect(expandPatterns(["03-plan/stories/S1.md", "03-plan/stories/<id>.md"], b.ctx))
      .toEqual(["03-plan/stories/S1.md"]);
  });
});

describe("`{repo}` and a pattern compose: repos first, then the disk", () => {
  const REPOS = ["api", "lab"] as const;

  test("expandAll resolves `{repo}` and leaves the token for the disk to answer", () => {
    expect(expandAll([".tldrx/map/{repo}/notes/<topic>.md"], REPOS)).toEqual([
      ".tldrx/map/api/notes/<topic>.md",
      ".tldrx/map/lab/notes/<topic>.md",
    ]);
  });

  test("each expanded repo is then matched on its own directory", () => {
    const b = bed();
    b.writeAtRoot(".tldrx/map/api/notes/auth.md", "a");
    b.writeAtRoot(".tldrx/map/api/notes/db.md", "b");
    // `lab` has the folder and nothing in it: a repo with no notes is not an error.
    mkdirSync(join(b.root, ".tldrx", "map", "lab", "notes"), { recursive: true });

    const declared = expandAll([".tldrx/map/{repo}/notes/<topic>.md"], REPOS);
    expect(present(declared, b.ctx)).toEqual([".tldrx/map/api/notes/<topic>.md"]);
    expect(missing(declared, b.ctx)).toEqual([".tldrx/map/lab/notes/<topic>.md"]);
    expect(expandPatterns(declared, b.ctx))
      .toEqual([".tldrx/map/api/notes/auth.md", ".tldrx/map/api/notes/db.md"]);
  });

  test("validateOutputs sees the composed pair as two independent declarations", () => {
    const b = bed();
    b.writeAtRoot(".tldrx/map/api/notes/auth.md", "a");
    const declared = expandAll([".tldrx/map/{repo}/notes/<topic>.md"], REPOS);
    expect(validateOutputs(declared, new Map(), b.ctx)).toEqual([
      { path: ".tldrx/map/lab/notes/<topic>.md", message: "was declared as an output but no file matches it on disk" },
    ]);
  });
});

describe("resolveMany is the one door every filesystem caller goes through", () => {
  test("a plain path is one entry, resolved exactly as `resolveDeclared` does", () => {
    const b = bed();
    b.write("01-what/intent.md", "# Intent\n");
    expect(resolveMany("01-what/intent.md", b.ctx)).toEqual([
      { path: "01-what/intent.md", absolute: resolveDeclared("01-what/intent.md", b.ctx) },
    ]);
  });

  test("a plain path that does NOT exist still comes back — callers write and delete through it", () => {
    const b = bed();
    const hits = resolveMany("03-plan/waves.yml", b.ctx);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.path).toBe("03-plan/waves.yml");
    expect(existsSync(hits[0]?.absolute ?? "")).toBe(false);
  });

  test("a pattern is every match, and an empty list when there are none", () => {
    const b = bed();
    for (const id of ["S1", "S2"]) b.write(`03-plan/stories/${id}.md`, story(id));
    expect(resolveMany("03-plan/stories/<id>.md", b.ctx).map((h) => h.path))
      .toEqual(["03-plan/stories/S1.md", "03-plan/stories/S2.md"]);
    expect(resolveMany("03-plan/epics/<epic>.md", b.ctx)).toEqual([]);
  });
});
