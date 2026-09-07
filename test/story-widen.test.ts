/**
 * `tldrx story widen <id> <path>… --note <text>` — the verb the boundary card had
 * been pointing at (#171).
 *
 * The measured problem: `decisionCards.ts:105` told the operator to *"add the path
 * to a story's `touches:`"* while `cli/commands/story.ts:8-9` says `run.yml` and
 * the story files are the state and hand-editing them is forbidden by design. The
 * framework's only sanctioned remedy for work landing in an undeclared file was an
 * edit its own CLI refuses, and no TS function wrote a `touches:` line.
 *
 * Two halves are proved here, and they are deliberately separate tests:
 *
 *   the FILE   the path lands in `touches:` and nothing else in the story moves
 *   the RECORD one `story.touches_widened` carries before, after, the paths and
 *              the note, so a surface never grows silently
 *
 * And the third, which is the whole reason the verb exists: the boundary gate
 * needs NO change. `deriveSurface` reads `touches:` off disk at evaluation time,
 * so the same refused run passes on the next evaluation with zero boundary code
 * touched — the other direction of `test/boundary.test.ts:266`.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runNext, type NextOptions } from "../src/core/facilitator/runNext.ts";
import { widenStory } from "../src/core/run/widenStory.ts";
import { reopenStory } from "../src/core/run/reopenStory.ts";
import { storyCommand } from "../src/cli/commands/story.ts";
import { applyPlanPatch } from "../src/core/build/storyFile.ts";
import { readReviewLedger } from "../src/core/build/reviewLedger.ts";
import { EventLog } from "../src/core/events/EventLog.ts";
import { validateEvent } from "../src/core/events/Event.ts";
import { loadRun, renderReplay } from "../src/core/replay/index.ts";
import { evaluateBoundary } from "../src/core/run/boundary.ts";
import { splitFrontMatter } from "../src/core/schemas/frontMatter.ts";
import { parseYaml } from "../src/core/yaml.ts";
import { MAX_TOUCHES } from "../src/core/schemas/planCommon.ts";
import { makeBuildWorkspace, type BuildWorkspace, type BuildWorkspaceOptions } from "./fixtures/build/workspace.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

// `makeBuildWorkspace` `git init`s a real repo and the boundary case runs the real
// Build executor, so this file spawns. Process cost is a property of the machine,
// not of the code: the budget scales with measured load and a hang is still caught.
setDefaultTimeout(spawnTestTimeout());

const ORIGINAL_PATH = process.env.PATH ?? "";
const FAKE_KEYS = ["FAKE_BUILD_WRITE", "FAKE_BUILD_STATE", "FAKE_BUILD_COST"] as const;

let open: BuildWorkspace[] = [];

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  for (const key of FAKE_KEYS) delete process.env[key];
  for (const ws of open) ws.dispose();
  open = [];
});

/** A run whose one story declares `src/in.ts` and nothing else — `boundary.test.ts`'s shape. */
const DECLARED: BuildWorkspaceOptions = {
  stories: [{ id: "S1", epic: "E1", title: "Inside the surface", touches: ["src/in.ts"] }],
  epics: [{ id: "E1", stories: ["S1"], branch: "epic/e1" }],
  waves: [["S1"]],
  gates: "none",
  repoFiles: { "src/in.ts": "export const before = 1;\n" },
};

function workspace(options: BuildWorkspaceOptions): BuildWorkspace {
  const made = makeBuildWorkspace(options);
  open.push(made);
  process.env.PATH = made.binDir;
  process.env.FAKE_BUILD_STATE = made.statePath;
  return made;
}

/** The same plan, with no build run against it: S1 `todo`, touching `src/in.ts`. */
function planWorkspace(statuses: Readonly<Record<string, string>> = {}): BuildWorkspace {
  return workspace({
    ...DECLARED,
    stories: DECLARED.stories.map((story) => {
      const status = statuses[story.id];
      if (status === undefined) return story;
      // A story at `status: done` must carry evidence or it stops validating —
      // done means proven, not asserted (`schemas/story.ts`).
      return { ...story, status, ...(status === "done" ? { evidence: ["$ npm run test → exit 0"] } : {}) };
    }),
  });
}

function next(ws: BuildWorkspace, overrides: Partial<NextOptions> = {}) {
  return runNext({
    root: ws.root,
    dryRun: false,
    mode: "headless",
    yolo: false,
    actor: "alan",
    at: "2026-09-07T09:00:00Z",
    ...overrides,
  });
}

function base(ws: BuildWorkspace) {
  return { root: ws.root, actor: "alan", at: "2026-09-07T10:00:00Z" };
}

function storyPath(ws: BuildWorkspace, id: string): string {
  return join(ws.planDir, "stories", `${id}.md`);
}

function front(text: string): Record<string, unknown> {
  return parseYaml(splitFrontMatter(text).raw) as Record<string, unknown>;
}

function touchesOf(text: string): readonly string[] {
  const value = front(text).touches;
  return Array.isArray(value) ? (value as readonly string[]) : [];
}

function statusOf(text: string): unknown {
  return front(text).status;
}

function bodyOf(text: string): string {
  return splitFrontMatter(text).body;
}

function eventsOf(ws: BuildWorkspace): readonly { type: string; actor: string; payload: Record<string, unknown> }[] {
  return EventLog.forRun(ws.runDir).read() as never;
}

function capture(): () => { stdout: string; stderr: string } {
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  let stdout = "";
  let stderr = "";
  const sink = (append: (text: string) => void) =>
    ((chunk: string | Uint8Array): boolean => {
      append(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as typeof process.stdout.write;
  process.stdout.write = sink((text) => { stdout += text; });
  process.stderr.write = sink((text) => { stderr += text; });
  return () => {
    process.stdout.write = out;
    process.stderr.write = err;
    return { stdout, stderr };
  };
}

const WHY = "the defect is here";

// ---------------------------------------------------------------------------

describe("tldrx story widen — the sanctioned way to grow a story's surface", () => {
  test("the path lands in touches:, and the front matter is otherwise byte-identical", () => {
    const ws = planWorkspace();
    const before = readFileSync(storyPath(ws, "S1"), "utf8");

    const out = widenStory({ ...base(ws), storyId: "S1", paths: ["platform/Auth.cs"], note: WHY });

    expect(out.code).toBe(0);
    const after = readFileSync(storyPath(ws, "S1"), "utf8");
    expect(touchesOf(after)).toEqual(["src/in.ts", "platform/Auth.cs"]);
    // Surgical, like `evidence`: nothing else in the file moves.
    expect(bodyOf(after)).toBe(bodyOf(before));
    expect(statusOf(after)).toBe(statusOf(before));
    expect(front(after).acceptance).toEqual(front(before).acceptance as never);
    // It says what it did NOT do, because that is the half an operator has to trust.
    const said = out.lines.join("\n");
    expect(said).toContain("widened S1");
    expect(said).toContain("platform/Auth.cs");
  });

  test("it is recorded: story.touches_widened carries before, after and the note", () => {
    const ws = planWorkspace();
    widenStory({ ...base(ws), storyId: "S1", paths: ["platform/Auth.cs"], note: WHY });

    const [event] = eventsOf(ws).filter((e) => e.type === "story.touches_widened");
    expect(event?.payload).toMatchObject({
      story: "S1",
      paths: ["platform/Auth.cs"],
      before: ["src/in.ts"],
      after: ["src/in.ts", "platform/Auth.cs"],
      note: WHY,
    });
    expect(event?.actor).toBe("alan");
    expect(validateEvent(event).ok).toBe(true);
  });

  /**
   * `EVENT_TYPES` is a CLOSED enum, so a new type is a change to every reader of
   * the log. The two that read one story's events are pinned here: the review
   * ledger must not count a widening as anything, and the narrative must not
   * skip it (a type with no `case` falls to `default: return null`, which is how
   * `gate.revoked` went missing from `replay` in #123).
   */
  test("the review ledger and the replay narrative both survive the new type", () => {
    const ws = planWorkspace();
    widenStory({ ...base(ws), storyId: "S1", paths: ["platform/Auth.cs"], note: WHY });

    const ledger = readReviewLedger(ws.runDir, "S1");
    expect(ledger.verdicts).toBe(0);
    expect(ledger.reopened).toBeNull();

    const narrative = renderReplay(loadRun(ws.root, ws.runId)!);
    expect(narrative).toContain("S1");
    expect(narrative).toContain("platform/Auth.cs");
    expect(narrative).toContain(WHY);
  });

  /**
   * One writer, two documents. `04-build/implicit-plan.yml` nests `touches:` under
   * `story:` at indent 2 (`implicitPlan.ts` renders it through `block()`), so a
   * `touches:` rewrite anchored at column 0 would silently be unable to widen the
   * plan a Plan-skipping scope runs on — while `status:` and `evidence:`, which
   * ARE top-level there, kept working. The patch preserves the key's own indent.
   */
  test("the same writer widens the implicit plan, indent and all", () => {
    const lines = [
      "version: 1",
      "status: todo",
      "evidence: []",
      "story:",
      "  id: S1",
      "  touches:",
      '    - "docs/a.md"',
      "  acceptance:",
      '    - "it is written"',
    ];
    expect(applyPlanPatch(lines, { touches: ["docs/a.md", "docs/b.md"] })).toEqual([
      "version: 1",
      "status: todo",
      "evidence: []",
      "story:",
      "  id: S1",
      "  touches:",
      '    - "docs/a.md"',
      '    - "docs/b.md"',
      "  acceptance:",
      '    - "it is written"',
    ]);
  });

  /**
   * The other half of `test/boundary.test.ts:266` ("a path nobody scoped refuses
   * the gate and is NAMED"): declare it, and the same run passes.
   *
   * It goes the long way ROUND on purpose, and the long way is the framework's
   * own advice. Measured here: when a Build stage's auto gate refuses on the
   * boundary, its stories are already settled — S1 comes out of that run
   * `status: done` with evidence — so `widen` refuses it and names
   * `reopen --for-fix`, exactly as designed (AGENTS §7: a done story's evidence
   * was written against the surface it DECLARED). The sanctioned path is the one
   * the refusal prints, and this test walks it end to end: refuse, reopen for the
   * defect, widen, and the same branch and the same diff now pass.
   */
  test("a widened story turns the boundary refusal into a pass", async () => {
    const ws = workspace(DECLARED);
    process.env.FAKE_BUILD_WRITE = JSON.stringify({
      S1: { "src/in.ts": "export const after = 2;\n", "platform/Auth.cs": "// nobody scoped this\n" },
    });
    const refused = await next(ws);
    expect(refused.code).toBe(4);
    expect(refused.lines.join("\n")).toContain("outside the surface");

    const evaluate = () => evaluateBoundary({ root: ws.root, runDir: ws.runDir, phaseId: "04-build" });
    const before = await evaluate();
    expect(before.ok).toBe(false);
    expect(before.detail).toContain("1 outside the surface: app:platform/Auth.cs");

    // The story the work landed in is `done`, so widen refuses and says what to do.
    const tooLate = widenStory({ ...base(ws), storyId: "S1", paths: ["platform/Auth.cs"], note: WHY });
    expect(tooLate.code).toBe(2);
    expect(tooLate.lines.join("\n")).toContain("--for-fix");

    expect(reopenStory({
      ...base(ws), storyId: "S1", forFix: true, note: "the tenancy check also lives in platform/Auth.cs",
    }).code).toBe(0);
    expect(widenStory({ ...base(ws), storyId: "S1", paths: ["platform/Auth.cs"], note: WHY }).code).toBe(0);

    // Not one byte of `boundary.ts` moved: `deriveSurface` re-reads `touches:` off
    // disk, so the same run, the same branch and the same diff now pass.
    const again = await evaluate();
    expect(again.ok).toBe(true);
    expect(again.detail).toContain("0 outside the surface");
  }, 90_000);
});

describe("what widen refuses, and with which code", () => {
  test("a done story is refused (2) and the refusal names --for-fix", () => {
    const ws = planWorkspace({ S1: "done" });
    const out = widenStory({ ...base(ws), storyId: "S1", paths: ["a.ts"], note: "n" });
    expect(out.code).toBe(2);
    expect(out.lines.join("\n")).toContain("--for-fix");
  });

  test("an unknown story, a missing --note and a path already declared are each 2", () => {
    const ws = planWorkspace();
    expect(widenStory({ ...base(ws), storyId: "S9", paths: ["a.ts"], note: "n" }).code).toBe(2);
    expect(widenStory({ ...base(ws), storyId: "S1", paths: ["a.ts"], note: "" }).code).toBe(2);
    expect(widenStory({ ...base(ws), storyId: "S1", paths: ["src/in.ts"], note: "n" }).code).toBe(2);
  });

  test("more than MAX_TOUCHES entries is refused (2), and nothing is written", () => {
    const ws = planWorkspace();
    const before = readFileSync(storyPath(ws, "S1"), "utf8");
    const many = Array.from({ length: MAX_TOUCHES + 72 }, (_, i) => `src/f${String(i)}.ts`);
    expect(widenStory({ ...base(ws), storyId: "S1", paths: many, note: "n" }).code).toBe(2);
    expect(readFileSync(storyPath(ws, "S1"), "utf8")).toBe(before);
    expect(eventsOf(ws).filter((e) => e.type === "story.touches_widened")).toHaveLength(0);
  });

  test("an unknown run is NOT FOUND (3), not refused (2)", () => {
    const ws = planWorkspace();
    expect(widenStory({ ...base(ws), storyId: "S1", paths: ["a.ts"], note: "n", runId: "nope" }).code).toBe(3);
  });

  test("through the command: widen dispatches, and prints its result on stdout", async () => {
    const ws = planWorkspace();
    const printed = capture();
    const code = await storyCommand.run(["widen", "S1", "platform/Auth.cs", "--root", ws.root, "--note", WHY]);
    const out = printed();

    expect(code).toBe(0);
    expect(out.stdout).toContain("widened S1");
    expect(out.stdout).toContain("platform/Auth.cs");
    expect(out.stderr).toBe("");
    expect(touchesOf(readFileSync(storyPath(ws, "S1"), "utf8"))).toEqual(["src/in.ts", "platform/Auth.cs"]);
  });

  test("through the command: a refusal goes to stderr, and stdout stays empty", async () => {
    const ws = planWorkspace({ S1: "done" });
    const printed = capture();
    const code = await storyCommand.run(["widen", "S1", "a.ts", "--root", ws.root, "--note", WHY]);
    const out = printed();

    expect(code).toBe(2);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("tldrx story widen:");
    expect(out.stderr).toContain("--for-fix");
  });

  test("through the command: a subcommand that is neither reopen nor widen is a usage error (1)", async () => {
    const printed = capture();
    const code = await storyCommand.run(["unblock", "S1"]);
    const out = printed();
    expect(code).toBe(1);
    expect(out.stderr).toContain("expected `reopen` or `widen`");
  });
});
