/**
 * Wave 2A — the gate evidence note (design §A.5).
 *
 * An `agent` gate is a gate a sub-agent may close, and this file is the artefact
 * that makes that different from a machine signing its own homework. So the tests
 * are about the two properties that keep it honest:
 *
 *  - it goes through the EXISTING §2.8 machinery — the same tokenizer, the same
 *    resolver, the same section rule `claim-sources` runs. A second checker would
 *    be a looser one, and it would win the argument at exactly the moment a gate
 *    is being signed;
 *  - every refusal in §A.5's table fires on its own fixture with its own message,
 *    because "which of these stopped it" is the first question anybody asks.
 *
 * The template is tested by ROUND TRIP: the blank form must refuse, and the same
 * bytes with the judgements filled in must pass. A template that validated clean
 * out of the box would be a signature nobody had to earn.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DIFF_VS_STORIES, EVIDENCE_SECTIONS, EVIDENCE_VERDICTS, GUIDANCE, REQUIRED_EVIDENCE_KEYS,
  describeEvidenceIssues, parseEvidence, renderEvidenceTemplate, validateEvidence,
  type EvidenceIssueKind,
} from "../src/core/text/evidence.ts";
import { evidencePath } from "../src/core/facilitator/paths.ts";
import { listItems } from "../src/core/text/handoff.ts";
import { clearSrcCaches, type SrcContext } from "../src/core/text/srcToken.ts";
import { loadWorkspace, toSrcContext } from "../src/hooks/lib/workspace.ts";
import { gateCommand } from "../src/cli/commands/gate.ts";
import { cannedHandoff, makeFacilitatorWorkspace, type FacilitatorWorkspace } from "./fixtures/facilitator/workspace.ts";

const WORKSPACE_YML = `version: 1
mode: multi-repo
repos:
  - name: api
    path: api
    default_branch: main
    stack: [dotnet]
    commands: {build: "dotnet build", test: null, lint: null, typecheck: null, run: null}
`;

const GATE = "03-plan/plan";

let scratch: string[] = [];
let workspaces: FacilitatorWorkspace[] = [];

afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  for (const ws of workspaces) ws.dispose();
  scratch = [];
  workspaces = [];
  clearSrcCaches();
});

interface Fixture {
  readonly root: string;
  readonly runDir: string;
  readonly ctx: SrcContext;
}

/** A workspace with one run, a handoff to cite, and a `src` context over both. */
function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "tldrx-evidence-"));
  scratch.push(root);
  mkdirSync(join(root, ".tldrx"), { recursive: true });
  writeFileSync(join(root, ".tldrx", "workspace.yml"), WORKSPACE_YML, "utf8");
  const runDir = join(root, "tldrx-work", "260830-x");
  mkdirSync(join(runDir, "01-what"), { recursive: true });
  writeFileSync(join(runDir, "01-what", "handoff.md"), cannedHandoff(), "utf8");
  return { root, runDir, ctx: toSrcContext(loadWorkspace(root), runDir) };
}

/** The parts of a note, each overridable, so a fixture differs in exactly one thing. */
interface NoteParts {
  readonly front?: readonly string[];
  readonly sections?: readonly (readonly [string, readonly string[]])[];
}

const DEFAULT_FRONT: readonly string[] = [
  "version: 1",
  `gate: ${GATE}`,
  "role: agent",
  "by: fable",
  "at: 2026-08-30T22:14:03Z",
  "verdict: sign",
  'read: ["01-what/handoff.md"]',
  "citations: {sampled: 2, of: 7, resolved: 2, refuted: 0}",
  "touches: {audited: 3, outside_surface: 0, new_areas: []}",
  "diff_vs_stories: n-a",
  "caveats: []",
  "recommend: []",
];

const DEFAULT_SECTIONS: readonly (readonly [string, readonly string[]])[] = [
  ["Read", ["- the What handoff, every bullet of it [src: 01-what/handoff.md:1]"]],
  ["Citations checked", ["- 2 of 7 spot-checked, both resolved [src: 01-what/handoff.md:4]"]],
  ["Touches audited", ["- 3 touched paths, all inside the declared surface [src: .tldrx/workspace.yml:1]"]],
  ["Verdict", ["- SIGN — every declared output is on disk [src: 01-what/handoff.md:7]"]],
];

function note(parts: NoteParts = {}): string {
  const front = parts.front ?? DEFAULT_FRONT;
  const sections = parts.sections ?? DEFAULT_SECTIONS;
  return [
    "---",
    ...front,
    "---",
    "",
    `# Gate evidence — ${GATE}`,
    "",
    ...sections.flatMap(([name, bullets]) => [`## ${name}`, "", ...bullets, ""]),
  ].join("\n");
}

/** One front-matter line replaced by another; everything else byte-identical. */
function withFront(key: string, line: string | null): readonly string[] {
  const out: string[] = [];
  for (const entry of DEFAULT_FRONT) {
    if (!entry.startsWith(`${key}:`)) out.push(entry);
    else if (line !== null) out.push(line);
  }
  return out;
}

function kinds(issues: readonly { kind: EvidenceIssueKind }[]): readonly EvidenceIssueKind[] {
  return [...new Set(issues.map((issue) => issue.kind))];
}

// ---------------------------------------------------------------------------
// the happy path
// ---------------------------------------------------------------------------

describe("a complete evidence note", () => {
  test("parses, resolves every citation, and validates clean", () => {
    const fx = fixture();
    const report = validateEvidence(note(), fx.ctx, { gate: GATE });
    expect(report.issues).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.unverified).toEqual([]);
    expect(report.bulletCount).toBe(4);
  });

  test("the front matter comes back with the design's field names, not a rename", () => {
    const fx = fixture();
    const front = validateEvidence(note(), fx.ctx, { gate: GATE }).front;
    expect(front).not.toBeNull();
    expect(front?.version).toBe(1);
    expect(front?.gate).toBe(GATE);
    expect(front?.role).toBe("agent");
    expect(front?.by).toBe("fable");
    expect(front?.verdict).toBe("sign");
    expect(front?.read).toEqual(["01-what/handoff.md"]);
    expect(front?.citations).toEqual({ sampled: 2, of: 7, resolved: 2, refuted: 0 });
    expect(front?.touches).toEqual({ audited: 3, outside_surface: 0, new_areas: [] });
    expect(front?.diff_vs_stories).toBe("n-a");
    expect(front?.caveats).toEqual([]);
    expect(front?.recommend).toEqual([]);
  });

  test("`caveats` and `recommend` are optional and default to empty", () => {
    const fx = fixture();
    const front = withFront("caveats", null).filter((line) => !line.startsWith("recommend:"));
    const report = validateEvidence(note({ front }), fx.ctx, { gate: GATE });
    expect(report.ok).toBe(true);
    expect(report.front?.caveats).toEqual([]);
    expect(report.front?.recommend).toEqual([]);
  });

  test("a recommendation is carried through whole, for §F.3's decision card", () => {
    const fx = fixture();
    const front = withFront(
      "recommend",
      'recommend: [{q: Q2, option: "B", why: "one screen, correct for everyone", src: "01-what/handoff.md:22"}]',
    );
    const report = validateEvidence(note({ front }), fx.ctx, { gate: GATE });
    expect(report.ok).toBe(true);
    expect(report.front?.recommend).toEqual([
      { q: "Q2", option: "B", why: "one screen, correct for everyone", src: "01-what/handoff.md:22" },
    ]);
  });

  test("every problem is reported, never just the first", () => {
    const fx = fixture();
    const report = validateEvidence(
      note({
        front: withFront("verdict", "verdict: refuse"),
        sections: [
          ["Read", ["- a file nobody can find [src: 01-what/nope.md:1]"]],
          ["Citations checked", ["- no source at all on this one"]],
          ["Touches audited", ["- fine [src: .tldrx/workspace.yml:1]"]],
          ["Verdict", ["- REFUSE [src: .tldrx/workspace.yml:1]"]],
        ],
      }),
      fx.ctx,
      { gate: GATE },
    );
    expect([...kinds(report.issues)].sort()).toEqual(["citation", "verdict"]);
    expect(report.issues.length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// the seven refusals of §A.5, one fixture and one message each
// ---------------------------------------------------------------------------

describe("§A.5 refusals", () => {
  test("1 — no front matter at all", () => {
    const fx = fixture();
    const text = note().split("\n").slice(1).join("\n");
    const report = validateEvidence(text, fx.ctx, { gate: GATE });
    expect(report.ok).toBe(false);
    expect(kinds(report.issues)).toContain("front-matter");
    expect(report.issues[0]?.message).toContain("no YAML front matter");
    expect(report.front).toBeNull();
  });

  test("1 — front matter that is not YAML", () => {
    const fx = fixture();
    const text = ["---", "verdict: [unclosed", "---", "", "## Read", "- x [src: 01-what/handoff.md:1]", ""].join("\n");
    const report = validateEvidence(text, fx.ctx, { gate: GATE });
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.kind === "front-matter" && i.message.includes("not valid YAML"))).toBe(true);
  });

  test("1 — a missing required key, named", () => {
    const fx = fixture();
    for (const key of REQUIRED_EVIDENCE_KEYS) {
      const report = validateEvidence(note({ front: withFront(key, null) }), fx.ctx, { gate: GATE });
      expect(report.ok).toBe(false);
      expect(report.issues.some((i) => i.message === `front matter is missing required key \`${key}\``)).toBe(true);
      // A note whose front matter could not be read is not then judged on its verdict.
      expect(report.front).toBeNull();
    }
  });

  test("1 — a value outside its closed set names the set", () => {
    const fx = fixture();
    const verdict = validateEvidence(note({ front: withFront("verdict", "verdict: maybe") }), fx.ctx, { gate: GATE });
    expect(verdict.issues.some((i) => i.message === `\`verdict\` must be one of ${EVIDENCE_VERDICTS.join(" | ")}, got \`maybe\``)).toBe(true);
    const diff = validateEvidence(note({ front: withFront("diff_vs_stories", "diff_vs_stories: sort-of") }), fx.ctx, { gate: GATE });
    expect(diff.issues.some((i) => i.message === `\`diff_vs_stories\` must be one of ${DIFF_VS_STORIES.join(" | ")}, got \`sort-of\``)).toBe(true);
  });

  test("2 — a missing required section", () => {
    const fx = fixture();
    const report = validateEvidence(
      note({ sections: DEFAULT_SECTIONS.filter(([name]) => name !== "Touches audited") }),
      fx.ctx,
      { gate: GATE },
    );
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.kind === "section" && i.message.includes("missing the `## Touches audited` section"))).toBe(true);
  });

  test("2 — a section present but holding only prose", () => {
    const fx = fixture();
    const report = validateEvidence(
      note({ sections: DEFAULT_SECTIONS.map(([name, bullets]) => (name === "Verdict" ? [name, ["It all looked fine to me."]] as const : [name, bullets] as const)) }),
      fx.ctx,
      { gate: GATE },
    );
    expect(report.ok).toBe(false);
    const issue = report.issues.find((i) => i.kind === "section");
    expect(issue?.message).toBe("`## Verdict` has no list item — a section of prose is not a checked claim");
    expect(issue?.line).toBeGreaterThan(0);
  });

  test("3 — a bullet with no `src` token at all", () => {
    const fx = fixture();
    const report = validateEvidence(
      note({ sections: DEFAULT_SECTIONS.map(([name, bullets]) => (name === "Read" ? [name, ["- I read the plan"]] as const : [name, bullets] as const)) }),
      fx.ctx,
      { gate: GATE },
    );
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.kind === "citation" && i.message.includes("no `[src: …]` token"))).toBe(true);
  });

  test("4 — arithmetic that cannot be true", () => {
    const fx = fixture();
    const over = validateEvidence(
      note({ front: withFront("citations", "citations: {sampled: 9, of: 7, resolved: 9, refuted: 0}") }),
      fx.ctx,
      { gate: GATE },
    );
    expect(over.ok).toBe(false);
    expect(over.issues.some((i) => i.kind === "arithmetic" && i.message.includes("more citations than exist"))).toBe(true);

    const outcomes = validateEvidence(
      note({ front: withFront("citations", "citations: {sampled: 2, of: 7, resolved: 2, refuted: 3}") }),
      fx.ctx,
      { gate: GATE },
    );
    expect(outcomes.ok).toBe(false);
    expect(outcomes.issues.some((i) => i.kind === "arithmetic" && i.message.includes("belongs to a citation you sampled"))).toBe(true);
  });

  test("5 — sampled 0 of a non-zero total is not a check", () => {
    const fx = fixture();
    const report = validateEvidence(
      note({ front: withFront("citations", "citations: {sampled: 0, of: 7, resolved: 0, refuted: 0}") }),
      fx.ctx,
      { gate: GATE },
    );
    expect(report.ok).toBe(false);
    const issue = report.issues.find((i) => i.kind === "sampling");
    expect(issue?.message).toContain("has not checked anything");
    // Zero of zero is a real state — a stage whose outputs cite nothing.
    const none = validateEvidence(
      note({ front: withFront("citations", "citations: {sampled: 0, of: 0, resolved: 0, refuted: 0}") }),
      fx.ctx,
      { gate: GATE },
    );
    expect(none.ok).toBe(true);
  });

  test("6 — a verdict that is not `sign` falls to a human rather than closing the gate", () => {
    const fx = fixture();
    for (const verdict of ["sign-with-fixlist", "refuse"] as const) {
      const report = validateEvidence(note({ front: withFront("verdict", `verdict: ${verdict}`) }), fx.ctx, { gate: GATE });
      expect(report.ok).toBe(false);
      const issue = report.issues.find((i) => i.kind === "verdict");
      expect(issue?.message).toBe(`verdict is \`${verdict}\`, not \`sign\` — this gate falls to a human, by design`);
      // The note itself is fine: nothing else is wrong with it, which is how a
      // caller tells "a person must decide" from "this note is broken".
      expect(kinds(report.issues)).toEqual(["verdict"]);
      expect(report.front?.verdict).toBe(verdict);
    }
  });

  test("7 — a note pasted from another gate", () => {
    const fx = fixture();
    const report = validateEvidence(note(), fx.ctx, { gate: "01-what/what" });
    expect(report.ok).toBe(false);
    const issue = report.issues.find((i) => i.kind === "gate");
    expect(issue?.message).toContain("is not the stage at the cursor (01-what/what)");
    expect(kinds(report.issues)).toEqual(["gate"]);
  });
});

// ---------------------------------------------------------------------------
// the §2.8 resolver, not a second one
// ---------------------------------------------------------------------------

describe("citations go through the §2.8 resolver", () => {
  test("a file:line that exists passes", () => {
    const fx = fixture();
    const report = validateEvidence(
      note({ sections: DEFAULT_SECTIONS.map(([name, bullets]) => (name === "Read" ? [name, ["- the handoff's first line [src: 01-what/handoff.md:1]"]] as const : [name, bullets] as const)) }),
      fx.ctx,
      { gate: GATE },
    );
    expect(report.ok).toBe(true);
  });

  test("a file that is not there is refused, in the resolver's own words", () => {
    const fx = fixture();
    const report = validateEvidence(
      note({ sections: DEFAULT_SECTIONS.map(([name, bullets]) => (name === "Read" ? [name, ["- a file nobody wrote [src: 01-what/nope.md:1]"]] as const : [name, bullets] as const)) }),
      fx.ctx,
      { gate: GATE },
    );
    expect(report.ok).toBe(false);
    const issue = report.issues.find((i) => i.kind === "citation");
    expect(issue?.message).toContain("[src: 01-what/nope.md:1]");
    expect(issue?.message).toContain("nope.md");
  });

  test("a line past the end of a real file is refused too", () => {
    const fx = fixture();
    const report = validateEvidence(
      note({ sections: DEFAULT_SECTIONS.map(([name, bullets]) => (name === "Read" ? [name, ["- line 900 of a 15-line file [src: 01-what/handoff.md:900]"]] as const : [name, bullets] as const)) }),
      fx.ctx,
      { gate: GATE },
    );
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.message.includes("cited line 900"))).toBe(true);
  });

  test("an `unverified` citation REFUSES here, unlike in a handoff", () => {
    const fx = fixture();
    const report = validateEvidence(
      note({ sections: DEFAULT_SECTIONS.map(([name, bullets]) => (name === "Read" ? [name, ["- a page nothing in the workspace names [src: https://example.invalid/spec]"]] as const : [name, bullets] as const)) }),
      fx.ctx,
      { gate: GATE },
    );
    expect(report.ok).toBe(false);
    expect(report.unverified.length).toBe(1);
    expect(report.unverified[0]?.message).toContain("an agent gate cannot sign over a citation nothing could check");
    expect(report.issues.some((i) => i.message === report.unverified[0]?.message)).toBe(true);
  });

  test("issue lines are lines of the FILE, not of the body under the front matter", () => {
    const fx = fixture();
    const text = note({ sections: DEFAULT_SECTIONS.map(([name, bullets]) => (name === "Read" ? [name, ["- unsourced"]] as const : [name, bullets] as const)) });
    const report = validateEvidence(text, fx.ctx, { gate: GATE });
    const line = report.issues.find((i) => i.kind === "citation")?.line ?? 0;
    expect(text.split("\n")[line - 1]).toBe("- unsourced");
  });
});

// ---------------------------------------------------------------------------
// the template
// ---------------------------------------------------------------------------

describe("gate template round trip", () => {
  const INPUT = { gate: GATE, by: "fable", at: "2026-08-30T22:14:03Z", citationsOf: 7, touchesAudited: 13 };

  test("the blank form carries every measured field and no judgement", () => {
    const text = renderEvidenceTemplate(INPUT);
    expect(text).toContain(`gate: ${GATE}`);
    expect(text).toContain("role: agent");
    expect(text).toContain("by: fable");
    expect(text).toContain("at: 2026-08-30T22:14:03Z");
    expect(text).toContain("citations: {sampled: 0, of: 7, resolved: 0, refuted: 0}");
    expect(text).toContain("touches: {audited: 13, outside_surface: 0, new_areas: []}");
    for (const section of EVIDENCE_SECTIONS) expect(text).toContain(`## ${section}`);
    // Not one list item, anywhere in it. The guidance SAYS the word `[src: …]`;
    // what it must never do is write a claim with a citation on it, which is the
    // same rule `questions lint --fix` follows and for the same reason.
    expect(listItems(text)).toEqual([]);
  });

  test("the blank form does NOT validate — a template is not a signature", () => {
    const fx = fixture();
    const report = validateEvidence(renderEvidenceTemplate(INPUT), fx.ctx, { gate: GATE });
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.message.includes("`verdict` must be one of"))).toBe(true);
    expect(report.issues.some((i) => i.message.includes("`diff_vs_stories` must be one of"))).toBe(true);
    for (const section of EVIDENCE_SECTIONS) {
      expect(report.issues.some((i) => i.kind === "section" && i.message.includes(`\`## ${section}\``))).toBe(true);
    }
  });

  test("the same bytes, with the judgements filled in, validate clean", () => {
    const fx = fixture();
    let text = renderEvidenceTemplate(INPUT)
      .replace(/^verdict:.*$/m, "verdict: sign")
      .replace(/^diff_vs_stories:.*$/m, "diff_vs_stories: n-a")
      .replace(/^read:.*$/m, 'read: ["01-what/handoff.md"]')
      .replace(/^citations:.*$/m, "citations: {sampled: 7, of: 7, resolved: 7, refuted: 0}");
    for (const [i, section] of EVIDENCE_SECTIONS.entries()) {
      text = text.replace(
        `_${GUIDANCE[section]}_`,
        `_${GUIDANCE[section]}_\n\n- what I did for ${section} [src: 01-what/handoff.md:${String(i + 1)}]`,
      );
    }
    const report = validateEvidence(text, fx.ctx, { gate: GATE });
    expect(describeEvidenceIssues(report.issues)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.front?.touches.audited).toBe(13);
    expect(report.bulletCount).toBe(4);
  });

  test("the guidance the file carries is the guidance stdout prints — one source", () => {
    const text = renderEvidenceTemplate(INPUT);
    for (const section of EVIDENCE_SECTIONS) expect(text).toContain(GUIDANCE[section]);
  });
});

// ---------------------------------------------------------------------------
// `tldrx gate template`
// ---------------------------------------------------------------------------

describe("tldrx gate template", () => {
  function runWorkspace(): FacilitatorWorkspace {
    const ws = makeFacilitatorWorkspace({
      scope: "feature",
      stages: [{
        id: "alpha",
        phase: "01-what",
        budgetUsd: 6,
        gate: "approve",
        outputs: [{ path: "01-what/handoff.md", sections: ["Findings", "Decisions", "Unknowns", "Evidence ledger"] }],
      }],
    });
    workspaces.push(ws);
    mkdirSync(join(ws.runDir, "01-what"), { recursive: true });
    writeFileSync(join(ws.runDir, "01-what", "handoff.md"), cannedHandoff(), "utf8");
    return ws;
  }

  test("writes the note beside prompt.md and counts the stage's citations", async () => {
    const ws = runWorkspace();
    const printed = capture();
    const code = await gateCommand.run(["template", "--root", ws.root]);
    const out = printed();
    expect(code).toBe(0);
    const path = evidencePath(ws.runDir, "alpha");
    expect(existsSync(path)).toBe(true);
    const text = readFileSync(path, "utf8");
    expect(text).toContain("gate: 01-what/alpha");
    // The canned handoff carries four bullets, each with one `src`.
    expect(text).toContain("citations: {sampled: 0, of: 4, resolved: 0, refuted: 0}");
    expect(out).toContain("Read");
    expect(out).toContain("signs nothing, spends nothing and spawns nothing");
  });

  test("what it writes is refused until a human fills it in", async () => {
    const ws = runWorkspace();
    const printed = capture();
    await gateCommand.run(["template", "--root", ws.root]);
    printed();
    const ctx = toSrcContext(loadWorkspace(ws.root), ws.runDir);
    const report = validateEvidence(readFileSync(evidencePath(ws.runDir, "alpha"), "utf8"), ctx, { gate: "01-what/alpha" });
    expect(report.ok).toBe(false);
  });

  test("it never overwrites a note somebody wrote, unless told to", async () => {
    const ws = runWorkspace();
    const path = evidencePath(ws.runDir, "alpha");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "# my evidence\n", "utf8");

    const code = await gateCommand.run(["template", "--root", ws.root]);
    expect(code).toBe(2);
    expect(readFileSync(path, "utf8")).toBe("# my evidence\n");

    const printed = capture();
    const forced = await gateCommand.run(["template", "--root", ws.root, "--force"]);
    printed();
    expect(forced).toBe(0);
    expect(readFileSync(path, "utf8")).toContain("gate: 01-what/alpha");
  });

  test("an unknown subcommand is a usage error, not a silent no-op", async () => {
    const code = await gateCommand.run(["sign"]);
    expect(code).toBe(1);
  });

  test("it advances no cursor and appends no event", async () => {
    const ws = runWorkspace();
    const before = readFileSync(join(ws.runDir, "run.yml"), "utf8");
    const events = join(ws.runDir, "events.jsonl");
    const eventsBefore = existsSync(events) ? readFileSync(events, "utf8") : "";
    const printed = capture();
    await gateCommand.run(["template", "--root", ws.root]);
    printed();
    expect(readFileSync(join(ws.runDir, "run.yml"), "utf8")).toBe(before);
    expect(existsSync(events) ? readFileSync(events, "utf8") : "").toBe(eventsBefore);
  });
});

describe("parseEvidence", () => {
  test("it splits the halves without judging either", () => {
    const parsed = parseEvidence(note());
    expect(parsed.front?.gate).toBe(GATE);
    expect(parsed.body.headings).toEqual([...EVIDENCE_SECTIONS]);
    expect(parsed.bodyLine).toBeGreaterThan(1);
    expect(parsed.frontIssues).toEqual([]);
  });
});

function capture(): () => string {
  const original = process.stdout.write.bind(process.stdout);
  let buffer = "";
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    buffer += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stdout.write;
  return () => {
    process.stdout.write = original;
    return buffer;
  };
}
