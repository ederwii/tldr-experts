/**
 * `ownershipOf` / `unownedFindings` (#171) — pure leaf, spawns NOTHING.
 *
 * Repo-then-path: `inSurface` compares normalised path strings and has no repo
 * in it, so ownership has to check the repo half itself before ever calling
 * into `boundary.ts` — see `unownedFindings.ts`'s own header for the mechanism.
 */
import { describe, expect, test } from "bun:test";
import { ownershipOf, unownedFindings, type DeclaredSurface } from "../src/core/build/unownedFindings.ts";
import { type FixFinding } from "../src/core/build/fixlist.ts";

const REPOS = new Set(["api", "lab"]);
const DECLARED: readonly DeclaredSurface[] = [
  { story: "S1", repo: "api", touches: ["src/Billing"] },
  { story: "S2", repo: "lab", touches: ["src/db.ts"] },
];

let n = 0;
function finding(overrides: Partial<FixFinding>): FixFinding {
  n += 1;
  return {
    n,
    kind: "correctness",
    normalisedFrom: null,
    severity: "medium",
    finding: "a finding",
    where: "",
    disposition: "fix-now",
    detail: "",
    doNot: [],
    resolved: false,
    resolvedSha: null,
    ...overrides,
  };
}

const carried = (where: string): FixFinding => finding({ disposition: "defer-with-log", where, resolved: false });

describe("ownershipOf — four labels, three of them absent-with-reason", () => {
  test("a repo-qualified path inside a same-repo story's touches is OWNED", () => {
    expect(ownershipOf(carried("[src: api:src/Billing/Ledger.cs:12]"), DECLARED, REPOS)).toBe("owned");
  });

  test("a repo-qualified path no same-repo story covers is UNOWNED — the reportable case", () => {
    expect(ownershipOf(carried("[src: api:platform/Auth.cs:3]"), DECLARED, REPOS)).toBe("unowned");
  });

  test("the REPO half is load-bearing: api:src/db.ts is not owned by a lab story declaring src/db.ts", () => {
    // `inSurface` compares path strings and has no repo in it; `touches:`
    // answers for exactly one repo (`ship.ts:893`). A false "owned" is the
    // dangerous direction.
    expect(ownershipOf(carried("[src: api:src/db.ts:1]"), DECLARED, REPOS)).toBe("unowned");
  });

  test("a citation that names no repo is UNQUALIFIED — neither owned nor unowned", () => {
    // `implicitPlan.ts:1349-1351`: skipped rather than guessed at.
    expect(ownershipOf(carried("[src: src/db.ts:1]"), DECLARED, REPOS)).toBe("unqualified");
  });

  test("a `where:` with no [src: …] token at all is NO-SRC", () => {
    expect(ownershipOf(carried("somewhere in the billing module"), DECLARED, REPOS)).toBe("no-src");
  });

  test("a repo prefix naming no workspace repo is unqualified, not owned", () => {
    expect(ownershipOf(carried("[src: ghost:src/db.ts:1]"), DECLARED, REPOS)).toBe("unqualified");
  });
});

describe("unownedFindings — every non-owned row carries its reason", () => {
  test("owned rows are dropped; the other three come back with a sentence each", () => {
    const rows = unownedFindings(
      [carried("[src: api:src/Billing/Ledger.cs:1]"),
       carried("[src: api:platform/Auth.cs:1]"),
       carried("[src: src/db.ts:1]"),
       carried("no citation")],
      DECLARED, REPOS,
    );
    expect(rows.map((r) => r.ownership)).toEqual(["unowned", "unqualified", "no-src"]);
    for (const row of rows) expect(row.reason.length).toBeGreaterThan(0);
    expect(rows[1]?.reason).toContain("names no repo");
    expect(rows[2]?.reason).toContain("no `[src:");
  });

  test("no declared surface at all makes every repo-qualified finding unowned, not owned", () => {
    expect(unownedFindings([carried("[src: api:src/x.ts:1]")], [], REPOS)[0]?.ownership).toBe("unowned");
  });
});
