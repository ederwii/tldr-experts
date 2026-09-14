/**
 * The Build handoff must pass the `claim-sources` check it is measured by,
 * whatever text it embeds (gh #283).
 *
 * MEASURED on a live unattended run, twice in one hour: the executor wrote
 * `04-build/handoff.md` itself and then failed its own check on it — once as
 * `trailing-position` on the Findings and Unknowns bullets of a blocked story,
 * once as `unsourced` on the `<id>'s developer had … refused` bullet of a story
 * that went on. Nobody wrote a bad citation. The refused command reaches the
 * renderer verbatim (`agentEvents.ts` `toolTarget` returns the Bash `command`
 * input as typed), and a command that spans lines splits the bullet that quotes
 * it: `parseHandoff` ends a bullet at the first column-0 line, so the first
 * physical line has no trailing token (or no token at all) and the rest is
 * prose nothing reads. The issue's own reading — the DoD citation joined
 * mid-line by `; and ` — was probed on the same base and PASSES: the reader
 * takes the LAST token on the line, so the third test below is a guard, not a
 * proof.
 *
 * `validateHandoff` is what `run/checks.ts` runs at the stage boundary, so a
 * green here is the same verdict the gate gives.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LINE_BREAK_MARK, LINE_BREAK_NOTE, renderBuildHandoff, type BuildHandoffParts } from "../src/core/build/handoff.ts";
import { dodFailureReason, type StoryOutcome } from "../src/core/build/outcome.ts";
import { permissionBlockReason } from "../src/core/facilitator/executors/build.ts";
import { emptySrcContext, validateHandoff } from "../src/core/text/handoff.ts";

/** One `StoryOutcome`, with everything the handoff does not read left inert. */
function outcome(id: string, status: "done" | "blocked", over: Partial<StoryOutcome>): StoryOutcome {
  return {
    id, title: `Story ${id}`, status, wave: "W1", repo: "app", epic: "E1", epicBranch: "epic/e1",
    branch: `story/${id}`, attempts: 1,
    dod: [{ command: "npm run test", exitCode: 0, timedOut: false, tail: "ok" }],
    commit: status === "done" ? "abc1234" : null, merged: status === "done",
    carried: status === "done" ? 3 : 0, conflicts: [], verdict: status === "done" ? "approve" : "n-a",
    developerError: null, reviewSummary: "", reviewFindings: [], reviewRel: `04-build/log/${id}.md`,
    reason: null, rescued: null, cost_usd: 0.2, ...over,
  };
}

const RED_DOD = {
  command: "dotnet test", exitCode: 2, timedOut: false,
  tail: "failed MigrationRunnerTests.EmptyContainer (33ms)",
  outputPath: "04-build/log/dod-output/S4-2.txt", outputLine: 1,
};

/** The refused line as the field run had it: one `mv` wrapped over two lines. */
const WRAPPED_COMMAND =
  "mv tests/Contract/Approved/openapi.v1.received.json \\\ntests/Contract/Approved/openapi.v1.approved.json";

/** A run dir holding every file the document cites, so `ok` can be asserted. */
function cited(): { root: string; runDir: string } {
  const root = mkdtempSync(join(tmpdir(), "tldrx-283-"));
  const runDir = join(root, "tldrx-work", "260913-x");
  mkdirSync(join(runDir, "04-build", "log", "dod-output"), { recursive: true });
  for (const id of ["S2", "S4"]) writeFileSync(join(runDir, "04-build", "log", `${id}.md`), "# review\n");
  writeFileSync(join(runDir, "04-build", "log", "dod-output", "S4-2.txt"), "failed\n");
  return { root, runDir };
}

function render(outcomes: readonly StoryOutcome[]): string {
  const parts: BuildHandoffParts = {
    runId: "260913-x", stageId: "build", model: null, costUsd: 1, budgetUsd: 8,
    at: "2026-09-13T00:00:00Z", outcomes, epics: [],
  };
  return renderBuildHandoff(parts);
}

describe("the Build handoff passes the claim-sources check it is measured by, whatever text it embeds (#283)", () => {
  test("a blocked reason quoting a refused command that spans lines still renders one bullet per claim", () => {
    const reason = [dodFailureReason(RED_DOD, "app"), permissionBlockReason(WRAPPED_COMMAND)].join("; and ");
    const text = render([outcome("S4", "blocked", { reason })]);
    const { root, runDir } = cited();
    const report = validateHandoff(text, emptySrcContext(root, runDir));
    expect(report.malformed).toEqual([]);
    expect(report.unsourced).toEqual([]);
    expect(report.ok).toBe(true);
    // Nothing is dropped: both halves of the wrapped line are still on the bullet.
    const finding = text.split("\n").find((line) => line.startsWith("- S4 · ")) ?? "";
    expect(finding).toContain("openapi.v1.received.json");
    expect(finding).toContain("openapi.v1.approved.json");
  });

  test("a refused-but-measured story whose command spans lines is still a sourced bullet", () => {
    const text = render([outcome("S2", "done", { permissionRefused: "cat <<EOF > notes.md\nhello\nEOF" })]);
    const { root, runDir } = cited();
    const report = validateHandoff(text, emptySrcContext(root, runDir));
    expect(report.unsourced).toEqual([]);
    expect(report.malformed).toEqual([]);
    expect(report.ok).toBe(true);
  });

  test("the break stays visible: the bullet carries the mark where the newline was, and no physical line is cut", () => {
    const text = render([outcome("S2", "done", { permissionRefused: "cat <<EOF > notes.md\nhello\nEOF" })]);
    const bullet = text.split("\n").find((line) => line.startsWith("- S2's developer had ")) ?? "";
    expect(bullet).toContain(`notes.md ${LINE_BREAK_MARK} hello ${LINE_BREAK_MARK} EOF`);
    expect(bullet.endsWith("[src: 04-build/log/S2.md:1]")).toBe(true);
  });

  test("the note explaining the mark appears exactly once, before the first section, iff a mark appears", () => {
    const marked = render([outcome("S2", "done", { permissionRefused: "cat <<EOF > notes.md\nhello\nEOF" })]);
    expect(marked.split(LINE_BREAK_NOTE).length - 1).toBe(1);
    expect(marked.indexOf(LINE_BREAK_NOTE)).toBeLessThan(marked.indexOf("## Findings"));
    // The note is its own paragraph outside every checked section: still a valid document.
    const { root, runDir } = cited();
    expect(validateHandoff(marked, emptySrcContext(root, runDir)).ok).toBe(true);
    const plain = render([outcome("S2", "done", { permissionRefused: "mv a.json b.json" })]);
    expect(plain).not.toContain(LINE_BREAK_NOTE);
    expect(plain).not.toContain(LINE_BREAK_MARK);
  });

  test("guard (green before the fix): a DoD citation joined mid-line by '; and' is not what fails the document", () => {
    const reason = [dodFailureReason(RED_DOD, "app"), permissionBlockReason("mv a.json b.json")].join("; and ");
    const text = render([outcome("S4", "blocked", { reason })]);
    const { root, runDir } = cited();
    const report = validateHandoff(text, emptySrcContext(root, runDir));
    expect(report.malformed).toEqual([]);
    expect(report.unsourced).toEqual([]);
    expect(report.ok).toBe(true);
  });
});
