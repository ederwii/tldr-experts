/**
 * `tldrx status` — the workspace-level "what is pending" report (wave J).
 *
 * The four sources are tested one at a time on a workspace holding only that
 * source, then together for priority order, because the ordering claim ("in the
 * order they block each other") is the one thing a per-source test cannot check.
 *
 * The CLI half runs the real binary as a subprocess: the exit-code contract is the
 * point of this command — a report exits 0 whatever it finds — and a test that
 * called the function directly would not be testing that at all.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { createRun } from "../src/core/run/newRun.ts";
import { EXIT_NOT_FOUND, EXIT_OK } from "../src/cli/exitCodes.ts";
import { buildWorkspaceStatus } from "../src/core/status/workspaceStatus.ts";
import { sessionStartLines } from "../src/core/status/renderWorkspaceStatus.ts";
import { slugOfRun } from "../src/core/status/runItems.ts";
import { makeRunWorkspace, type TempRunWorkspace } from "./fixtures/tempRunWorkspace.ts";
import { initQuestionsFile } from "./fixtures/initQuestions.ts";
import { noSpawnEnv } from "./fixtures/noSpawnPath.ts";

const BIN = join(FRAMEWORK_ROOT, "bin", "tldrx.ts");

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function tldrx(cwd: string, ...args: string[]): Promise<Run> {
  const proc = Bun.spawn(["bun", BIN, ...args], {
    stdout: "pipe", stderr: "pipe", cwd, env: noSpawnEnv(),
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

let workspace: TempRunWorkspace | null = null;
let bare: string | null = null;

afterEach(() => {
  workspace?.dispose();
  workspace = null;
  if (bare !== null) rmSync(bare, { recursive: true, force: true });
  bare = null;
});

function fresh(): string {
  workspace = makeRunWorkspace();
  return workspace.root;
}

function write(root: string, rel: string, text: string): void {
  const path = join(root, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text, "utf8");
}

const ADR_PROPOSED = [
  "# ADR-1 — how customers authenticate",
  "",
  "- Status: proposed — owner decision pending",
  "- Date: 2026-01-01",
  "",
  "## Context",
  "Two documents disagree.",
  "",
].join("\n");

const ADR_ACCEPTED = [
  "# ADR-2 — money is minor units",
  "",
  "- Status: accepted",
  "",
  "## Context",
  "Settled.",
  "",
].join("\n");

const DECISIONS_MD = ["# Decisions Needed", "", "## #1 · Who authenticates?", "", "Pick one.", ""].join("\n");

/**
 * A `.tldrx/triage/<dir>/` holding a split, its inventory, and the seed documents
 * the split names — the shape `tldrx seed triage --propose` leaves behind.
 */
function withSplit(root: string, status: "proposed" | "applied" = "proposed"): string {
  write(root, "docs/adr-1.md", ADR_PROPOSED);
  write(root, "docs/adr-2.md", ADR_ACCEPTED);
  write(root, "docs/DECISIONS-NEEDED.md", DECISIONS_MD);
  write(root, ".tldrx/triage/260101-docs/inventory.json", JSON.stringify({
    version: 1,
    documents: [
      { rel: "docs/adr-1.md", adrStatus: null },
      { rel: "docs/adr-2.md", adrStatus: "accepted" },
      { rel: "docs/DECISIONS-NEEDED.md", adrStatus: null },
    ],
  }));
  write(root, ".tldrx/triage/260101-docs/split.yml", [
    "version: 1",
    `status: ${status}`,
    'source: "docs"',
    'created_at: "2026-01-01T00:00:00Z"',
    ...(status === "applied" ? ['applied_at: "2026-01-02T00:00:00Z"', "created_runs: []"] : []),
    "shared_context: []",
    "exclude: []",
    "runs:",
    "  - slug: first",
    "    scope: docs",
    '    goal: "Decide the open ADR"',
    '    size: "M"',
    "    budget_usd: 5.00",
    '    seeds: ["docs/adr-1.md"]',
    "    depends_on: []",
    "    why:",
    '      - {claim: "the ADR is still proposed", src: "seed:docs/adr-1.md#Context"}',
    "  - slug: second",
    "    scope: docs",
    '    goal: "Write the money rules"',
    '    size: "S"',
    "    budget_usd: 5.00",
    '    seeds: ["docs/adr-2.md"]',
    '    depends_on: ["first"]',
    "    why:",
    '      - {claim: "money follows the decision", src: "seed:docs/adr-2.md#Context"}',
    "questions:",
    '  - {id: Q1, text: "Does promotions stay in scope?"}',
    "",
  ].join("\n"));
  return join(root, ".tldrx", "triage", "260101-docs", "split.yml");
}

// --- item 1: init questions -------------------------------------------------

describe("item 1 — init questions", () => {
  test("open questions become one item pointing at `interview --init`", () => {
    const root = fresh();
    write(root, ".tldrx/init-questions.md", initQuestionsFile());
    const status = buildWorkspaceStatus(root);
    expect(status.pending).toBe(1);
    const item = status.items[0];
    expect(item?.kind).toBe("init-questions");
    expect(item?.command).toBe("tldrx interview --init");
    expect(item?.summary).toContain("2 setup questions");
    expect(item?.details.some((line) => line.startsWith("Q1 · "))).toBe(true);
  });

  test("a file whose questions are all answered is not pending", () => {
    const root = fresh();
    write(root, ".tldrx/init-questions.md", initQuestionsFile().replace(/status: open/g, "status: answered"));
    expect(buildWorkspaceStatus(root).pending).toBe(0);
  });

  test("no file at all is not pending", () => {
    expect(buildWorkspaceStatus(fresh()).pending).toBe(0);
  });
});

// --- item 2: a proposed split -----------------------------------------------

describe("item 2 — a proposed split", () => {
  test("reports the runs, the unanswered questions, the proposed ADRs and the decisions doc", () => {
    const root = fresh();
    withSplit(root);
    const status = buildWorkspaceStatus(root);
    expect(status.pending).toBe(1);
    const item = status.items[0];
    expect(item?.kind).toBe("seed-split");
    expect(item?.command).toBe("tldrx seed apply .tldrx/triage/260101-docs/split.yml --dry-run");
    expect(item?.summary).toContain("into 2 piece(s) of work");

    const details = item?.details ?? [];
    expect(details.some((line) => line.includes("first, second"))).toBe(true);
    expect(details.some((line) => line.includes("Q1 Does promotions stay in scope?"))).toBe(true);
    // Read from the document, not from the inventory's cached `adrStatus: null`.
    expect(details.some((line) => line.includes("docs/adr-1.md — Status: proposed"))).toBe(true);
    expect(details.some((line) => line.includes("docs/adr-2.md"))).toBe(false);
    expect(details.some((line) => line.includes("docs/DECISIONS-NEEDED.md"))).toBe(true);
  });

  test("`status: applied` is history, not pending work", () => {
    const root = fresh();
    withSplit(root, "applied");
    expect(buildWorkspaceStatus(root).pending).toBe(0);
  });

  test("an answered question stops being listed as one the proposal could not answer", async () => {
    const root = fresh();
    const split = withSplit(root);
    const answered = await tldrx(root, "seed", "answer", split, "Q1", "yes, promotions stay in");
    expect(answered.code).toBe(EXIT_OK);
    const details = buildWorkspaceStatus(root).items[0]?.details ?? [];
    expect(details.some((line) => line.includes("Q1 Does promotions"))).toBe(false);
    expect(details).toContain("no unanswered questions on the split itself");
  });

  test("a split that does not parse is skipped rather than crashing the report", () => {
    const root = fresh();
    write(root, ".tldrx/triage/260101-broken/split.yml", "status: nonsense\n");
    expect(buildWorkspaceStatus(root).pending).toBe(0);
  });
});

// --- item 3: open runs ------------------------------------------------------

describe("item 3 — open runs", () => {
  function withRuns(root: string, ...specs: readonly { slug: string; dependsOn?: readonly string[] }[]): readonly string[] {
    return specs.map((spec, i) =>
      createRun({
        root,
        slug: spec.slug,
        scope: "feature",
        actor: "alan",
        now: new Date(`2026-08-${String(20 + i).padStart(2, "0")}T09:00:00Z`),
        ...(spec.dependsOn === undefined
          ? {}
          : { triage: { split: ".tldrx/triage/260101-docs/split.yml", depends_on: spec.dependsOn } }),
      }).runId,
    );
  }

  test("a ready run gets `tldrx next <id>` and the `← next` mark", () => {
    const root = fresh();
    const [id] = withRuns(root, { slug: "alpha" });
    const item = buildWorkspaceStatus(root).items[0];
    expect(item?.kind).toBe("run");
    expect(item?.command).toBe(`tldrx next ${id ?? ""}`);
    expect(item?.details[0]).toStartWith("← next — ");
    expect(item?.details[0]).toContain(`tldrx run auto ${id ?? ""}`);
  });

  test("a run whose dependency has not finished is blocked and offered no command", () => {
    const root = fresh();
    const ids = withRuns(root, { slug: "first" }, { slug: "second", dependsOn: ["first"] });
    const items = buildWorkspaceStatus(root).items;
    // Matched by run id, not by slug: the blocked one's summary NAMES its
    // dependency ("proposed to follow first"), so a slug match finds the wrong row.
    const blocked = items.find((item) => item.summary.includes(ids[1] ?? ""));
    const runnable = items.find((item) => item.summary.includes(ids[0] ?? ""));

    expect(blocked?.command).toBe("");
    expect(blocked?.summary).toContain("proposed to follow first");
    expect(blocked?.details.some((line) => line.startsWith("blocked by first — it is"))).toBe(true);
    // Only the unblocked one is marked, however loudly the blocked one says ready.
    expect(runnable?.details[0]).toStartWith("← next — ");
    expect(blocked?.details.some((line) => line.startsWith("← next"))).toBe(false);

    // …and it unblocks when the dependency finishes.
    const store = RunStore.find(root, ids[0] ?? "");
    if (store === null) throw new Error("no first run");
    store.mutate((run) => ({
      ...run,
      phases: run.phases.map((phase) => ({
        ...phase,
        stages: phase.stages.map((stage) => ({ ...stage, status: "done" as const })),
      })),
    }));
    store.save();
    const after = buildWorkspaceStatus(root).items.find((item) => item.summary.includes("second"));
    expect(after?.command).toBe(`tldrx next ${ids[1] ?? ""}`);
  });

  test("a dependency with no run at all counts as unfinished", () => {
    const root = fresh();
    withRuns(root, { slug: "orphan", dependsOn: ["never-created"] });
    const item = buildWorkspaceStatus(root).items[0];
    expect(item?.command).toBe("");
    expect(item?.details).toContain("blocked by never-created — no run exists for it");
  });

  test("a run waiting on a gate is offered approve, and reject beside it", () => {
    const root = fresh();
    const [id] = withRuns(root, { slug: "gated" });
    const store = RunStore.find(root, id ?? "");
    if (store === null) throw new Error("no run");
    store.mutate((run) => ({
      ...run,
      phases: run.phases.map((phase, index) => (index === 0
        ? {
          ...phase,
          stages: phase.stages.map((stage, at) =>
            (at === 0 ? { ...stage, status: "awaiting_gate" as const } : stage)),
        }
        : phase)),
    }));
    store.save();
    const item = buildWorkspaceStatus(root).items[0];
    expect(item?.command).toBe(`tldrx approve --run ${id ?? ""}`);
    expect(item?.details.some((line) => line.includes(`tldrx reject --run ${id ?? ""}`))).toBe(true);
  });

  test("a run folder that does not validate is reported, not silently dropped", () => {
    const root = fresh();
    const [id] = withRuns(root, { slug: "broken" });
    writeFileSync(join(root, "tldrx-work", id ?? "", "run.yml"), "version: 1\nrun: broken\n", "utf8");
    const item = buildWorkspaceStatus(root).items[0];
    expect(item?.kind).toBe("run");
    expect(item?.summary).toContain("could not be read");
    expect(item?.command).toBe(`tldrx run status ${id ?? ""}`);
  });

  test("slugOfRun strips the date prefix and leaves anything else alone", () => {
    expect(slugOfRun("260829-decisions-gate")).toBe("decisions-gate");
    expect(slugOfRun("not-a-run-id")).toBe("not-a-run-id");
  });
});

// --- item 4: untrained experts ----------------------------------------------

describe("item 4 — experts with no evidence", () => {
  function withExpert(root: string, name: string, kind: string, area: string): void {
    write(root, `.tldrx/experts/${name}/expert.md`, [
      "---", `name: ${name}`, `kind: ${kind}`, "status: created", "repos: [api]", "---", "", `# ${name}`, "",
    ].join("\n"));
    write(root, `.tldrx/experts/${name}/competencies.yml`, [
      "version: 1", `expert: ${name}`, "status: created", "last_trained: null", "areas:",
      `  - id: ${area}`, `    title: "The ${area} area"`, "    level: 0",
      `    train_prompt: tldrx expert train ${name} --area ${area} --mode light`,
      "    evidence: []", "",
    ].join("\n"));
  }

  test("a domain expert a stage will load is offered light-mode training", () => {
    const root = fresh();
    withExpert(root, "product", "product", "shop");
    const item = buildWorkspaceStatus(root).items.find((entry) => entry.summary.includes("product"));
    expect(item?.kind).toBe("expert");
    expect(item?.command).toBe("tldrx expert train product --area shop --mode light --print-prompt");
    expect(item?.details.some((line) => line.startsWith("it is loaded by "))).toBe(true);
  });

  test("a role expert with no handoff to mine is reported with NO command", () => {
    const root = fresh();
    withExpert(root, "architect", "role", "architect");
    const item = buildWorkspaceStatus(root).items.find((entry) => entry.summary.includes("architect"));
    expect(item?.command).toBe("");
    expect(item?.summary).toContain("nothing to mine yet");
  });

  test("a role expert IS offered full-mode training once a handoff exists", () => {
    const root = fresh();
    withExpert(root, "architect", "role", "architect");
    createRun({ root, slug: "past", scope: "feature", actor: "alan", now: new Date("2026-08-20T09:00:00Z") });
    write(root, "tldrx-work/260820-past/01-what/handoff.md", "# Handoff\n");
    const item = buildWorkspaceStatus(root).items.find((entry) => entry.summary.includes("architect"));
    expect(item?.command).toBe("tldrx expert train architect --area architect --mode full --print-prompt");
  });

  test("an expert that already has evidence is not pending", () => {
    const root = fresh();
    withExpert(root, "product", "product", "shop");
    write(root, ".tldrx/experts/product/competencies.yml", [
      "version: 1", "expert: product", "status: trained", "last_trained: 2026-08-20T09:00:00Z", "areas:",
      "  - id: shop", '    title: "The shop area"', "    level: 1",
      "    train_prompt: tldrx expert train product --area shop --mode light",
      "    evidence:", "      - {kind: code, src: 'api:src/Billing/Money.cs:1', at: 2026-08-20T09:00:00Z}", "",
    ].join("\n"));
    expect(buildWorkspaceStatus(root).pending).toBe(0);
  });
});

// --- the report as a whole --------------------------------------------------

describe("the report", () => {
  test("items come in the order the sources block each other", () => {
    const root = fresh();
    write(root, ".tldrx/init-questions.md", initQuestionsFile());
    withSplit(root);
    createRun({ root, slug: "alpha", scope: "feature", actor: "alan", now: new Date("2026-08-20T09:00:00Z") });
    write(root, ".tldrx/experts/product/expert.md",
      ["---", "name: product", "kind: product", "status: created", "repos: [api]", "---", "", "# product", ""].join("\n"));
    write(root, ".tldrx/experts/product/competencies.yml", [
      "version: 1", "expert: product", "status: created", "last_trained: null", "areas:",
      "  - id: shop", '    title: "The shop area"', "    level: 0",
      "    train_prompt: tldrx expert train product --area shop --mode light", "    evidence: []", "",
    ].join("\n"));

    expect(buildWorkspaceStatus(root).items.map((item) => item.kind))
      .toEqual(["init-questions", "seed-split", "run", "expert"]);
  });

  test("an idle workspace gets one `none` item and a pending count of zero", () => {
    const status = buildWorkspaceStatus(fresh());
    expect(status.pending).toBe(0);
    expect(status.items.map((item) => item.kind)).toEqual(["none"]);
    expect(status.items[0]?.summary).toStartWith("nothing pending — open work with");
    expect(status.items[0]?.command).toBe("");
  });
});

// --- the CLI ----------------------------------------------------------------

describe("tldrx status, through the real binary", () => {
  test("exits 0 with pending work and prints `[n] … → <command>`", async () => {
    const root = fresh();
    withSplit(root);
    const run = await tldrx(root, "status");
    expect(run.code).toBe(EXIT_OK);
    expect(run.stdout).toContain("1 thing(s) waiting on you");
    expect(run.stdout).toContain("[1] a proposed split of `docs`");
    expect(run.stdout).toContain("→ tldrx seed apply .tldrx/triage/260101-docs/split.yml --dry-run");
  });

  test("exits 0 with nothing pending — a report, not a failure", async () => {
    const run = await tldrx(fresh(), "status");
    expect(run.code).toBe(EXIT_OK);
    expect(run.stdout).toContain("nothing pending — open work with");
  });

  test("--json carries {kind, summary, command, details} per item", async () => {
    const root = fresh();
    withSplit(root);
    const run = await tldrx(root, "status", "--json");
    expect(run.code).toBe(EXIT_OK);
    const parsed = JSON.parse(run.stdout) as {
      root: string;
      pending: number;
      items: { kind: string; summary: string; command: string; details: string[] }[];
    };
    expect(parsed.pending).toBe(1);
    // `/var` is a symlink to `/private/var` on macOS; the basename is the claim.
    expect(parsed.root.endsWith(root.split("/").pop() ?? "")).toBe(true);
    expect(Object.keys(parsed.items[0] ?? {}).sort()).toEqual(["command", "details", "kind", "summary"]);
    expect(parsed.items[0]?.kind).toBe("seed-split");
  });

  test("exits 3 when there is no .tldrx/ at all", async () => {
    bare = mkdtempSync(join(tmpdir(), "tldrx-bare-"));
    const run = await tldrx(bare, "status");
    expect(run.code).toBe(EXIT_NOT_FOUND);
    expect(run.stderr).toContain("run `tldrx init` first");
  });

  test("`tldrx next` with no run open prints the report before its exit-3 line", async () => {
    const root = fresh();
    withSplit(root);
    const run = await tldrx(root, "next");
    expect(run.code).toBe(EXIT_NOT_FOUND);
    expect(run.stdout).toContain("[1] a proposed split of `docs`");
    expect(run.stderr).toContain("no non-terminal run in tldrx-work/");
  });
});

// --- the SessionStart lines -------------------------------------------------

describe("the SessionStart block", () => {
  test("a headline plus as many items as fit, never more than the cap", () => {
    const root = fresh();
    write(root, ".tldrx/init-questions.md", initQuestionsFile());
    withSplit(root);
    const lines = sessionStartLines(buildWorkspaceStatus(root), 3);
    expect(lines.length).toBe(3);
    expect(lines[0]).toStartWith("tldrx: 2 pending — ");
    expect(lines[1]).toStartWith("tldrx:   [1] ");
    expect(lines[2]).toStartWith("tldrx:   [2] ");
  });

  test("nothing pending is nothing said", () => {
    expect(sessionStartLines(buildWorkspaceStatus(fresh()), 3)).toEqual([]);
  });

  test("the hook itself never blocks and stays inside its line budget", async () => {
    const root = fresh();
    withSplit(root);
    const proc = Bun.spawn(["bun", join(FRAMEWORK_ROOT, "src", "hooks", "session-start.ts")], {
      stdin: new TextEncoder().encode(JSON.stringify({
        hook_event_name: "SessionStart", source: "startup", cwd: root,
      })),
      stdout: "pipe", stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    const parsed = JSON.parse(stdout) as {
      hookSpecificOutput?: { additionalContext?: string; permissionDecision?: string };
    };
    // SessionStart cannot block, and this one must not try to.
    expect(parsed.hookSpecificOutput?.permissionDecision).toBeUndefined();
    const lines = (parsed.hookSpecificOutput?.additionalContext ?? "").split("\n");
    expect(lines.length).toBeLessThanOrEqual(3);
    expect(lines[0]).toStartWith("tldrx: 1 pending — ");
  });
});
