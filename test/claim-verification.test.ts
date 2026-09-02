/**
 * Wave M · M1 + M11 — the `[src: …]` validator has to VERIFY, not wave through.
 *
 * The 2026-08-29 audit measured a handoff that cited `F999`, `Q42`,
 * `graph:i-made-this-up` and `absent:ops/backup.yml` to assert "we removed the
 * auth check from /admin" — and it validated clean, closed its own auto gate and
 * advanced the cursor. Six of the eight `src` kinds returned `ok` unconditionally
 * (`srcToken.ts:240-246`). These tests are that probe, plus the four line shapes a
 * real user's citations were wrongly refused for on the same day.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateHandoff } from "../src/core/text/handoff.ts";
import {
  classifySrc, clearSrcCaches, hasSrcMarker, isNegativeClaim, parseSrcToken, resolveSrc,
  type SrcContext, type SrcRef,
} from "../src/core/text/srcToken.ts";
import { loadWorkspace, toSrcContext } from "../src/hooks/lib/workspace.ts";

const WORKSPACE_YML = `version: 1
mode: multi-repo
repos:
  - name: api
    path: api
    default_branch: main
    stack: [dotnet]
    commands: {build: "dotnet build", test: null, lint: null, typecheck: null, run: null}
`;

const FACTS_YML = `version: 1
facts:
  - id: F019
    fact: "Backend deploys run via deploy.yml."
    area: deploy
    repos: [api]
    kind: answer
    confidence: measured
    source: {who: alan, when: "2026-08-14T10:11:00Z", run: 260814-envs, q: Q1}
    supersedes: null
    superseded_by: null
    retired: null
  - id: F020
    fact: "The old deploy script is gone."
    area: deploy
    repos: [api]
    kind: answer
    confidence: measured
    source: {who: alan, when: "2026-08-01T10:11:00Z", run: 260801-old, q: Q2}
    supersedes: null
    superseded_by: null
    retired: {at: "2026-08-20T00:00:00Z", by: alan, reason: "superseded"}
`;

const QUESTIONS_MD = `# Questions — 02-how — run 260829-probe

## Q4 · Where does leaderboard state live?
<!-- id: Q4 | status: open | area: data-model | asked_by: architect | asked_at: 2026-08-29T14:02:11Z -->
Why asked: no ranking store exists [src: absent:.tldrx/map/api/domains.md]

- A) Postgres
- B) Redis

[Answer]:
`;

const GRAPH_JSON = JSON.stringify({
  nodes: [{ id: "api.Hunt.Complete", label: "Complete" }, { id: "api.Hunt", label: "Hunt" }],
  links: [{ source: "api.Hunt", target: "api.Hunt.Complete", relation: "declares" }],
});

interface Probe {
  readonly root: string;
  readonly runDir: string;
  readonly ctx: SrcContext;
}

let probe: Probe;

function write(root: string, rel: string, content: string): void {
  const path = join(root, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf8");
}

beforeEach(() => {
  clearSrcCaches();
  const root = mkdtempSync(join(tmpdir(), "tldrx-verify-"));
  write(root, ".tldrx/workspace.yml", WORKSPACE_YML);
  write(root, ".tldrx/memory/facts.yml", FACTS_YML);
  write(root, ".tldrx/map/api/domains.md", "# api\n\n- Hunts live in src/Hunt.cs\n");
  write(root, ".tldrx/graphify-out/graph.json", GRAPH_JSON);
  write(root, "api/src/Hunt.cs", "one\ntwo\nthree\n");
  const runDir = join(root, "tldrx-work", "260829-probe");
  write(root, "tldrx-work/260829-probe/02-how/questions.md", QUESTIONS_MD);
  probe = { root, runDir, ctx: toSrcContext(loadWorkspace(root), runDir) };
});

afterEach(() => {
  rmSync(probe.root, { recursive: true, force: true });
  clearSrcCaches();
});

function resolve(src: string, section = "Findings", claim = ""): ReturnType<typeof resolveSrc> {
  const ref = classifySrc(src);
  if ("message" in ref) throw new Error(`fixture bug: ${src} does not parse — ${ref.message}`);
  return resolveSrc(ref as SrcRef, probe.ctx, section, claim);
}

describe("M1 · fact sources are looked up in facts.yml", () => {
  test("a live fact resolves", () => {
    expect(resolve("F019")).toMatchObject({ ok: true, outcome: "ok" });
  });

  test("an invented fact is REFUSED — this is the audit's F999", () => {
    expect(resolve("F999")).toMatchObject({
      ok: false,
      outcome: "refused",
      message: expect.stringContaining("no such fact F999"),
    });
  });

  test("a retired fact is refused, and says it is retired rather than missing", () => {
    expect(resolve("F020")).toMatchObject({
      ok: false,
      outcome: "refused",
      message: expect.stringContaining("RETIRED"),
    });
  });

  test("no facts.yml at all is `unverified`, never `ok`", () => {
    rmSync(join(probe.root, ".tldrx", "memory", "facts.yml"));
    clearSrcCaches();
    expect(resolve("F019")).toMatchObject({ ok: true, outcome: "unverified" });
  });
});

describe("M1 · answer sources must be a question this run asked", () => {
  test("a declared question resolves, from any phase of the run", () => {
    expect(resolve("Q4")).toMatchObject({ ok: true, outcome: "ok" });
  });

  test("an invented question is REFUSED — this is the audit's Q42", () => {
    expect(resolve("Q42")).toMatchObject({
      ok: false,
      outcome: "refused",
      message: expect.stringContaining("no such question Q42"),
    });
  });

  test("with no run directory in context it is `unverified`, not `ok`", () => {
    const ctx = toSrcContext(loadWorkspace(probe.root));
    const ref = classifySrc("Q42") as SrcRef;
    expect(resolveSrc(ref, ctx, "Findings")).toMatchObject({ ok: true, outcome: "unverified" });
  });
});

describe("M1 · graph sources are looked up in the graph", () => {
  test("a real node id resolves", () => {
    expect(resolve("graph:api.Hunt.Complete")).toMatchObject({ ok: true, outcome: "ok" });
  });

  test("an invented node is REFUSED — this is the audit's graph:i-made-this-up", () => {
    expect(resolve("graph:i-made-this-up")).toMatchObject({
      ok: false,
      outcome: "refused",
      message: expect.stringContaining("no node `i-made-this-up`"),
    });
  });

  test("with no graph.json the map is the fallback, and a path in it resolves", () => {
    rmSync(join(probe.root, ".tldrx", "graphify-out"), { recursive: true });
    clearSrcCaches();
    expect(resolve("graph:src/Hunt.cs")).toMatchObject({ ok: true, outcome: "ok" });
    expect(resolve("graph:i-made-this-up")).toMatchObject({ ok: false, outcome: "refused" });
  });

  test("with neither graph nor map it is `unverified`", () => {
    rmSync(join(probe.root, ".tldrx", "graphify-out"), { recursive: true });
    rmSync(join(probe.root, ".tldrx", "map"), { recursive: true });
    clearSrcCaches();
    expect(resolve("graph:anything")).toMatchObject({ ok: true, outcome: "unverified" });
  });
});

describe("M1 · doc sources cannot be fetched, so they are provenance-checked", () => {
  test("a URL nothing in the workspace names is `unverified` — never a silent pass", () => {
    expect(resolve("https://developers.example.com/limits")).toMatchObject({
      ok: true,
      outcome: "unverified",
      message: expect.stringContaining("not fetched offline"),
    });
  });

  test("a URL a knowledge file already cites resolves", () => {
    write(
      probe.root,
      ".tldrx/experts/architect/knowledge/deploy.md",
      "# deploy\n\n- Rate limits are documented at https://developers.example.com/limits\n",
    );
    clearSrcCaches();
    expect(resolve("https://developers.example.com/limits")).toMatchObject({ ok: true, outcome: "ok" });
  });
});

describe("M1 · absent sources", () => {
  test("a positive claim sourced by an absence is REFUSED — the audit's probe verbatim", () => {
    expect(resolve("absent:ops/backup.yml", "Findings", "we removed the auth check from /admin")).toMatchObject({
      ok: false,
      outcome: "refused",
      message: expect.stringContaining("positive claim"),
    });
  });

  test("a negative claim over a genuinely missing path resolves", () => {
    expect(resolve("absent:ops/backup.yml", "Findings", "no backup policy is recorded anywhere")).toMatchObject({
      ok: true,
      outcome: "ok",
    });
  });

  test("Unknowns is exempt: the heading is the negation (spec §2.8's own example)", () => {
    expect(resolve("absent:ops/backup.yml", "Unknowns", "Retention period for historical rankings")).toMatchObject({
      ok: true,
      outcome: "ok",
    });
  });

  test("citing a file that EXISTS is `unverified` — the absence is about its contents", () => {
    expect(resolve("absent:.tldrx/memory/facts.yml", "Unknowns", "Retention period")).toMatchObject({
      ok: true,
      outcome: "unverified",
      message: expect.stringContaining("EXISTS"),
    });
  });

  test("the negation test is word-bounded, not substring", () => {
    expect(isNegativeClaim("no ranking store exists")).toBe(true);
    expect(isNegativeClaim("nothing was found")).toBe(true);
    expect(isNegativeClaim("we didn't ship it")).toBe(true);
    expect(isNegativeClaim("the notation is new")).toBe(false);
    expect(isNegativeClaim("we shipped the new endpoint")).toBe(false);
  });
});

describe("M1 · cmd sources with nothing to check against", () => {
  test("an empty workspace command set is `unverified`, not `ok`", () => {
    write(probe.root, ".tldrx/workspace.yml", "version: 1\nrepos: []\n");
    clearSrcCaches();
    const ctx = toSrcContext(loadWorkspace(probe.root), probe.runDir);
    const ref = classifySrc("$ dotnet build → exit 0") as SrcRef;
    expect(resolveSrc(ref, ctx, "Evidence ledger")).toMatchObject({ ok: true, outcome: "unverified" });
  });
});

describe("M1 · the audit's fabricated handoff, end to end", () => {
  const FABRICATED = [
    "# Handoff — 02-how — run 260829-probe",
    "",
    "## Findings",
    "- We removed the auth check from /admin [src: absent:ops/backup.yml]",
    "- The lab SDK is generated [src: F999]",
    "",
    "## Decisions",
    "- Ship the change [src: Q42]",
    "",
    "## Unknowns",
    "- Whether the graph agrees [src: graph:i-made-this-up]",
    "",
    "## Evidence ledger",
    "- The design is coherent [src: F999]",
    "",
  ].join("\n");

  test("is REFUSED, and every fabricated citation is named", () => {
    const report = validateHandoff(FABRICATED, probe.ctx);
    expect(report.ok).toBe(false);
    const messages = report.unresolved.map((i) => i.message).join("\n");
    expect(messages).toContain("F999");
    expect(messages).toContain("Q42");
    expect(messages).toContain("i-made-this-up");
    expect(messages).toContain("positive claim");
    // Every section had a bullet and every bullet had a token: the OLD validator
    // is what reported this file clean.
    expect(report.unsourced).toEqual([]);
    expect(report.emptySections).toEqual([]);
  });
});

describe("M11 · a citation wrapped in punctuation is still a citation", () => {
  const shapes: readonly (readonly [string, string])[] = [
    ["plain", "- The event is emitted [src: api:src/Hunt.cs:1]"],
    ["backticked", "- The event is emitted `[src: api:src/Hunt.cs:1]`"],
    ["period", "- The event is emitted [src: api:src/Hunt.cs:1]."],
    ["parenthesised", "- The event is emitted ([src: api:src/Hunt.cs:1])"],
  ];

  for (const [name, line] of shapes) {
    test(`${name}: the token parses and resolves`, () => {
      const token = parseSrcToken(line);
      expect(token).not.toBeNull();
      expect(token?.refs.map((r) => r.kind)).toEqual(["file"]);
      expect(resolveSrc(token?.refs[0] as SrcRef, probe.ctx, "Findings")).toMatchObject({ ok: true, outcome: "ok" });
    });
  }

  test("words after the token are still refused — it must be the LAST element", () => {
    expect(parseSrcToken("- claim [src: Q4] and then prose")).toBeNull();
  });

  test("a malformed citation is reported as malformed, not as unsourced", () => {
    const text = [
      "# Handoff",
      "",
      "## Findings",
      "- The event is emitted [src: api:src/Hunt.cs:1] and also elsewhere",
      "",
      "## Decisions",
      "- Ship it [src: F019]",
      "",
      "## Unknowns",
      "- none [src: absent:ops/nothing.yml]",
      "",
      "## Evidence ledger",
      "- The file exists [src: api:src/Hunt.cs:1]",
      "",
    ].join("\n");
    const report = validateHandoff(text, probe.ctx);
    expect(report.unsourced).toEqual([]);
    // gh #77: the issue names the RULE it enforced, not just the symptom.
    expect(report.malformed).toEqual([
      {
        line: 4,
        message: expect.stringContaining("malformed citation") as unknown as string,
        rule: "trailing-position",
      },
    ]);
    expect(report.ok).toBe(false);
  });

  test("a bullet with no `[src:` at all is unsourced, not malformed", () => {
    const text = [
      "# Handoff",
      "",
      "## Findings",
      "- A claim with no source at all",
      "",
      "## Decisions",
      "- Ship it [src: F019]",
      "",
      "## Unknowns",
      "- none [src: absent:ops/nothing.yml]",
      "",
      "## Evidence ledger",
      "- The file exists [src: api:src/Hunt.cs:1]",
      "",
    ].join("\n");
    const report = validateHandoff(text, probe.ctx);
    expect(report.unsourced).toEqual([4]);
    expect(report.malformed).toEqual([]);
  });

  test("hasSrcMarker is what tells the two apart", () => {
    expect(hasSrcMarker("- claim `[src: Q4]`")).toBe(true);
    expect(hasSrcMarker("- claim with nothing")).toBe(false);
  });
});
