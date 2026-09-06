/**
 * Wave M · M2 — an auto gate cannot be closed by silence.
 *
 * The measured failure, 2026-08-29: a stage that declares `questions.md` as an
 * output followed `templates/questions.md`, wrote `### Q1 — …` and `**Answer:**`,
 * and the §2.7 parser — which reads exactly `## Qn · Title` — found ZERO blocks.
 * "0 open questions" was recorded as satisfied and the gate signed itself over
 * four unanswered questions. Nothing anywhere said the file was unreadable.
 *
 * The prose fixture below is that file's real shape.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fixQuestions, parseLooseQuestions, parseQuestions, unreadableQuestionHeadings,
  validateQuestions,
} from "../src/core/text/questions.ts";
import {
  declaresQuestions, evaluateAutoGate, MISSING_QUESTIONS, NO_PARSEABLE_QUESTIONS,
} from "../src/core/run/autoGate.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { validateRunFile } from "../src/core/run/RunFile.ts";
import { emitRunYaml } from "../src/core/run/emitRunYaml.ts";
import { parseYaml } from "../src/core/yaml.ts";
import { EventLog } from "../src/core/events/EventLog.ts";
import { loadWorkflowPreset } from "../src/core/run/workflowPreset.ts";
import { runNext } from "../src/core/facilitator/runNext.ts";
import { questionsCommand } from "../src/cli/commands/questions.ts";
import { rejectCommand } from "../src/cli/commands/reject.ts";
import { TEMPLATES_DIR } from "../src/core/paths.ts";
import {
  cannedHandoff, cannedIntent, makeFacilitatorWorkspace, type FacilitatorWorkspace, type StageOptions,
} from "./fixtures/facilitator/workspace.ts";

/** The real shape a stage wrote on 2026-08-29, from the old template. */
const PROSE_QUESTIONS = [
  "# Open questions — `260829-probe` / `01-what`",
  "",
  "You may answer any subset.",
  "",
  "---",
  "",
  "### Q1 — Where does leaderboard state live?",
  "",
  "*Why it is being asked:* no ranking store exists in the map",
  "",
  "- **A)** New Postgres table — *implies:* a migration",
  "- **B)** Redis sorted set — *implies:* a new dependency",
  "- **Other:** _______",
  "",
  "**Answer:**",
  "",
  "---",
  "",
  "### Q2 — Is per-tenant isolation required?",
  "",
  "*Why it is being asked:* Place.TenantId is nullable",
  "",
  "- **A)** Yes, per tenant",
  "- **B)** No, global",
  "",
  "**Answer:** B — rankings are global",
  "",
].join("\n");

const GRAMMAR_QUESTIONS = [
  "# Questions",
  "",
  "## Q1 · Where does leaderboard state live?",
  "<!-- id: Q1 | status: open | area: domain | asked_by: alpha | asked_at: 2026-08-29T09:00:00Z -->",
  "Why asked: not in facts.yml [src: absent:.tldrx/memory/facts.yml]",
  "",
  "- A) In the API",
  "- B) In the lab",
  "",
  "[Answer]:",
  "",
].join("\n");

const ORIGINAL_PATH = process.env.PATH ?? "";
let open: FacilitatorWorkspace[] = [];
let scratch: string[] = [];

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  for (const ws of open) ws.dispose();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  open = [];
  scratch = [];
});

/** A stage that DECLARES questions.md as an output — the shape (b) applies to. */
const ASKER: StageOptions = {
  id: "alpha", phase: "01-what", budgetUsd: 6, gate: "approve",
  outputs: [
    { path: "01-what/intent.md", sections: ["Intent", "Scope"] },
    { path: "01-what/handoff.md", sections: ["Findings", "Decisions", "Unknowns", "Evidence ledger"] },
    { path: "01-what/questions.md" },
  ],
  checks: "[claim-sources]",
};

function workspace(stages: readonly StageOptions[], gates?: Record<string, string>): FacilitatorWorkspace {
  const made = makeFacilitatorWorkspace({ scope: "demo", stages, budgetUsd: 10, gates });
  open.push(made);
  process.env.PATH = made.binDir;
  return made;
}

function inputs(ws: FacilitatorWorkspace): never {
  const store = RunStore.open(ws.runDir);
  return {
    root: ws.root,
    runDir: ws.runDir,
    phaseId: "01-what",
    stage: store.run.phases[0]?.stages[0],
    planned: loadWorkflowPreset(ws.root, store.run.scope).stages[0],
    budget: store.budget,
    checks: [{ id: "claim-sources", status: "passed", detail: "1 handoff(s) sourced" }],
  } as never;
}

describe("M2 · the parser's grammar, and what misses it", () => {
  test("the prose form parses as ZERO questions — the whole failure in one line", () => {
    expect(parseQuestions(PROSE_QUESTIONS).blocks).toHaveLength(0);
  });

  test("but the headings are visible as unreadable, by id", () => {
    expect(unreadableQuestionHeadings(PROSE_QUESTIONS)).toEqual(["Q1", "Q2"]);
  });

  test("a file already in the grammar reports nothing unreadable", () => {
    expect(unreadableQuestionHeadings(GRAMMAR_QUESTIONS)).toEqual([]);
    expect(parseQuestions(GRAMMAR_QUESTIONS).blocks).toHaveLength(1);
  });

  test("the loose reader salvages the title, the reason, the options and the answer", () => {
    const [q1, q2] = parseLooseQuestions(PROSE_QUESTIONS);
    expect(q1?.id).toBe("Q1");
    expect(q1?.title).toBe("Where does leaderboard state live?");
    expect(q1?.why).toBe("no ranking store exists in the map");
    // `- **Other:** _______` had no letter; it keeps its words and gets the next one.
    expect(q1?.options.map((o) => o.letter)).toEqual(["A", "B", "C"]);
    expect(q1?.options[2]?.text).toContain("other");
    expect(q1?.answer).toBe("");
    expect(q2?.options.map((o) => o.letter)).toEqual(["A", "B"]);
    expect(q2?.answer).toBe("B — rankings are global");
  });
});

describe("M2 · the shipped template is the grammar", () => {
  const template = readFileSync(join(TEMPLATES_DIR, "questions.md"), "utf8");

  test("templates/questions.md parses as real question blocks", () => {
    const doc = parseQuestions(template);
    expect(doc.blocks.map((b) => b.id)).toEqual(["Q1", "Q2"]);
  });

  test("its first block satisfies every §2.7 rule", () => {
    const doc = parseQuestions(template);
    const q1 = doc.blocks.filter((b) => b.id === "Q1");
    const issues = validateQuestions({ ...doc, blocks: q1 });
    expect(issues).toEqual([]);
  });

  test("it carries no heading the parser cannot read", () => {
    expect(unreadableQuestionHeadings(template)).toEqual([]);
  });
});

describe("M2 · --fix converts without changing a word", () => {
  test("every id comes across, and the result parses", () => {
    const fixed = fixQuestions(PROSE_QUESTIONS, {
      area: "domain", askedBy: "alan", askedAt: "2026-08-29T09:00:00Z",
    });
    expect(fixed.converted).toEqual(["Q1", "Q2"]);
    const doc = parseQuestions(fixed.text);
    expect(doc.blocks.map((b) => b.id)).toEqual(["Q1", "Q2"]);
    expect(unreadableQuestionHeadings(fixed.text)).toEqual([]);
  });

  test("the author's own words survive verbatim", () => {
    const fixed = fixQuestions(PROSE_QUESTIONS, {
      area: "domain", askedBy: "alan", askedAt: "2026-08-29T09:00:00Z",
    }).text;
    expect(fixed).toContain("## Q1 · Where does leaderboard state live?");
    expect(fixed).toContain("Why asked: no ranking store exists in the map");
    expect(fixed).toContain("- A) New Postgres table — *implies:* a migration");
    expect(fixed).toContain("- B) No, global");
  });

  test("an answer already typed in the prose form is carried into the slot", () => {
    const fixed = fixQuestions(PROSE_QUESTIONS, {
      area: "domain", askedBy: "alan", askedAt: "2026-08-29T09:00:00Z",
    }).text;
    expect(fixed).toContain("[Answer]: B — rankings are global");
    const q2 = parseQuestions(fixed).blocks.find((b) => b.id === "Q2");
    expect(q2?.metadata?.status).toBe("answered");
    expect(q2?.answer).toBe("B — rankings are global");
  });

  test("the surrounding prose is left alone", () => {
    const fixed = fixQuestions(PROSE_QUESTIONS, {
      area: "domain", askedBy: "alan", askedAt: "2026-08-29T09:00:00Z",
    }).text;
    expect(fixed).toContain("# Open questions — `260829-probe` / `01-what`");
    expect(fixed).toContain("You may answer any subset.");
  });

  test("it does NOT invent a `[src: …]` for a converted `Why asked:` line", () => {
    // §2.7 requires the token, the prose form had no such rule, and this whole
    // wave exists because citations resolving to nothing were being accepted.
    // Writing one here would manufacture the exact thing being removed.
    const result = fixQuestions(PROSE_QUESTIONS, {
      area: "domain", askedBy: "alan", askedAt: "2026-08-29T09:00:00Z",
    });
    expect(result.text).not.toContain("[src:");
    expect(result.needSource).toEqual(["Q1", "Q2"]);
  });

  test("and `questions lint --fix` says how many still need one", async () => {
    const ws = workspace([ASKER]);
    writeFileSync(join(ws.runDir, "01-what", "questions.md"), PROSE_QUESTIONS, "utf8");
    const printed = capture();
    await questionsCommand.run(["lint", "--root", ws.root, "--fix"]);
    const out = printed();
    expect(out).toContain("2 block(s) still need a source");
    expect(out).toContain("does not invent citations");
  });

  test("a `Why asked:` that already carried a token keeps it, and needs nothing", () => {
    const withToken = PROSE_QUESTIONS.replace(
      "*Why it is being asked:* no ranking store exists in the map",
      "*Why it is being asked:* no ranking store exists [src: absent:.tldrx/map/api/domains.md]",
    );
    const result = fixQuestions(withToken, {
      area: "domain", askedBy: "alan", askedAt: "2026-08-29T09:00:00Z",
    });
    expect(result.text).toContain("Why asked: no ranking store exists [src: absent:.tldrx/map/api/domains.md]");
    expect(result.needSource).toEqual(["Q2"]);
  });

  test("a file already in the grammar is returned untouched", () => {
    const result = fixQuestions(GRAMMAR_QUESTIONS, {
      area: "domain", askedBy: "alan", askedAt: "2026-08-29T09:00:00Z",
    });
    expect(result.converted).toEqual([]);
    expect(result.text).toBe(GRAMMAR_QUESTIONS);
  });
});

describe("M2 · the auto gate reads the unreadable file", () => {
  test("a stage that declares questions.md as an output is subject to the rule", () => {
    const ws = workspace([ASKER], { alpha: "auto" });
    const planned = loadWorkflowPreset(ws.root, RunStore.open(ws.runDir).run.scope).stages[0];
    expect(declaresQuestions(planned as never)).toBe(true);
  });

  test("prose questions refuse the gate, and the reason names the grammar", async () => {
    const ws = workspace([ASKER], { alpha: "auto" });
    writeFileSync(join(ws.runDir, "01-what", "handoff.md"), cannedHandoff(), "utf8");
    writeFileSync(join(ws.runDir, "01-what", "questions.md"), PROSE_QUESTIONS, "utf8");
    const verdict = await evaluateAutoGate(inputs(ws));
    expect(verdict.ok).toBe(false);
    expect(verdict.why).toContain(NO_PARSEABLE_QUESTIONS);
    expect(verdict.why).toContain("Q1, Q2");
  });

  // gh #109, 2026-09-02. This assertion used to read `ok: false`, and it was the
  // rule the whole issue is about: an empty questions.md the stage WAS told to
  // write is the stage saying it needs no decision, which is the state an auto
  // gate exists to close over. A MISSING file is the failure, and it still is —
  // the case below, and the pair in test/gate-conditions.test.ts.
  test("an EMPTY questions.md the stage was told to write is an ANSWER, not silence", async () => {
    const ws = workspace([ASKER], { alpha: "auto" });
    writeFileSync(join(ws.runDir, "01-what", "handoff.md"), cannedHandoff(), "utf8");
    writeFileSync(join(ws.runDir, "01-what", "questions.md"), "# Questions\n\nNone.\n", "utf8");
    const verdict = await evaluateAutoGate(inputs(ws));
    expect(verdict.ok).toBe(true);
    expect(verdict.note).toContain("questions=0 open");
  });

  test("a questions.md the stage was told to write and never wrote still refuses it", async () => {
    const ws = workspace([ASKER], { alpha: "auto" });
    writeFileSync(join(ws.runDir, "01-what", "handoff.md"), cannedHandoff(), "utf8");
    rmSync(join(ws.runDir, "01-what", "questions.md"), { force: true });
    const verdict = await evaluateAutoGate(inputs(ws));
    expect(verdict.ok).toBe(false);
    expect(verdict.why).toContain(MISSING_QUESTIONS);
  });

  test("the same file in the grammar, with the question answered, lets it through", async () => {
    const ws = workspace([ASKER], { alpha: "auto" });
    writeFileSync(join(ws.runDir, "01-what", "handoff.md"), cannedHandoff(), "utf8");
    writeFileSync(
      join(ws.runDir, "01-what", "questions.md"),
      GRAMMAR_QUESTIONS.replace("status: open", "status: answered"),
      "utf8",
    );
    const verdict = await evaluateAutoGate(inputs(ws));
    expect(verdict.ok).toBe(true);
  });

  test("a stage that does NOT declare questions.md is unaffected", async () => {
    const quiet: StageOptions = {
      id: "alpha", phase: "01-what", budgetUsd: 6, gate: "approve",
      outputs: [
        { path: "01-what/intent.md", sections: ["Intent", "Scope"] },
        { path: "01-what/handoff.md", sections: ["Findings", "Decisions", "Unknowns", "Evidence ledger"] },
      ],
      checks: "[claim-sources]",
    };
    const ws = workspace([quiet], { alpha: "auto" });
    writeFileSync(join(ws.runDir, "01-what", "handoff.md"), cannedHandoff(), "utf8");
    const verdict = await evaluateAutoGate(inputs(ws));
    expect(verdict.ok).toBe(true);
    expect(verdict.note).toContain("questions=0 open");
  });
});

describe("M2 · --commit refuses an unreadable questions.md (exit 5)", () => {
  test("the host session is told which questions vanished, and how to fix it", async () => {
    const ws = workspace([ASKER], { alpha: "auto" });
    const prepared = await runNext({
      root: ws.root, dryRun: false, mode: "prepare", yolo: false,
      actor: "alan", at: "2026-08-29T09:00:00Z",
    });
    expect(prepared.code).toBe(0);

    writeFileSync(join(ws.runDir, "01-what", "intent.md"), cannedIntent(), "utf8");
    writeFileSync(join(ws.runDir, "01-what", "handoff.md"), cannedHandoff(), "utf8");
    writeFileSync(join(ws.runDir, "01-what", "questions.md"), PROSE_QUESTIONS, "utf8");
    mkdirSync(join(ws.runDir, ".agent", "alpha"), { recursive: true });
    writeFileSync(
      join(ws.runDir, ".agent", "alpha", "result.json"),
      JSON.stringify({ outputs: ["01-what/intent.md"], questions_asked: [], notes: "", cost_usd: 0.4 }),
      "utf8",
    );

    const committed = await runNext({
      root: ws.root, dryRun: false, mode: "commit", yolo: false,
      actor: "alan", at: "2026-08-29T09:05:00Z",
    });
    expect(committed.code).toBe(5);
    const text = committed.lines.join("\n");
    expect(text).toContain("the parser cannot read");
    expect(text).toContain("Q1, Q2");
    expect(text).toContain("tldrx questions lint");

    // The refusal is real and it still exits 5 — and the money is recorded anyway.
    // The turn RAN. A refusal that discards the row is the ledger forgetting a
    // dollar it saw, which is the one thing this file's own subject forbids.
    const store = RunStore.open(ws.runDir);
    const stage = store.run.phases.flatMap((p) => p.stages).find((s) => s.id === "alpha");
    expect(stage?.tasks).toHaveLength(1);
    expect(stage?.tasks[0]?.cost_usd).toBe(0.4);
    expect(stage?.tasks[0]?.session_id).toBeNull();
    const results = EventLog.forRun(ws.runDir).read()
      .filter((e) => e.type === "agent.result");
    expect(results).toHaveLength(1);
    expect(results[0]?.cost_usd).toBe(0.4);
  });

  /**
   * The other half, and the one that decides whether the fix is honest: the
   * operator fixes `questions.md` and runs `--commit` again over the SAME
   * `result.json`. The stage is still `running`, so nothing else stops a second
   * row — and two rows for one turn double-counts the money, which is the same
   * lie pointing the other way.
   *
   * This turn's `result.json` carries a real `session_id`, so the fingerprint
   * (session + cost + outputs) can tell "the same artefact, re-read" apart from
   * "a second turn that happened to cost the same" — and collapses the re-run
   * to one row.
   */
  test("a re-run with the same session id after the fix does not bank the same turn twice", async () => {
    const ws = workspace([ASKER], { alpha: "auto" });
    await runNext({
      root: ws.root, dryRun: false, mode: "prepare", yolo: false,
      actor: "alan", at: "2026-08-29T09:00:00Z",
    });
    writeFileSync(join(ws.runDir, "01-what", "intent.md"), cannedIntent(), "utf8");
    writeFileSync(join(ws.runDir, "01-what", "handoff.md"), cannedHandoff(), "utf8");
    writeFileSync(join(ws.runDir, "01-what", "questions.md"), PROSE_QUESTIONS, "utf8");
    mkdirSync(join(ws.runDir, ".agent", "alpha"), { recursive: true });
    writeFileSync(
      join(ws.runDir, ".agent", "alpha", "result.json"),
      JSON.stringify({
        outputs: ["01-what/intent.md"], questions_asked: [], notes: "", cost_usd: 0.4,
        session_id: "sess-abc",
      }),
      "utf8",
    );

    const refused = await runNext({
      root: ws.root, dryRun: false, mode: "commit", yolo: false,
      actor: "alan", at: "2026-08-29T09:05:00Z",
    });
    expect(refused.code).toBe(5);

    // The operator's fix, then the same command again.
    expect(await questionsCommand.run(["lint", "--root", ws.root, "--fix"])).toBe(0);
    const again = await runNext({
      root: ws.root, dryRun: false, mode: "commit", yolo: false,
      actor: "alan", at: "2026-08-29T09:10:00Z",
    });

    const stage = RunStore.open(ws.runDir).run.phases
      .flatMap((p) => p.stages).find((s) => s.id === "alpha");
    expect(stage?.tasks).toHaveLength(1);
    expect(stage?.cost_usd).toBe(0.4);
    // The row the refusal banked is the ONLY thing a re-run's fingerprint may
    // ever match against — it must carry the marker for the match above to be
    // legitimate, not incidental.
    expect(stage?.tasks[0]?.banked_before_refusal).toBe(true);
    expect(again.lines.join("\n")).toContain("already recorded as t1");
  });

  /**
   * The case the controller ruling exists for: a null `session_id` identifies
   * NOTHING, so it must never be used to collapse two rows into one — even when
   * a re-run's cost and outputs happen to match an earlier row exactly. Both
   * turns are banked, and the second row's note names why it was not deduped:
   * a null session id cannot tell "the same artefact, re-read" apart from "a
   * second, genuinely distinct unmetered turn."
   *
   * The reason lives in `run.yml` itself (`dedupe`), not only in the console
   * transcript of the `--commit` that wrote it — §7's absent-with-reason rule:
   * a reader of the file alone, months later, must be able to see why two
   * identical-looking rows are not a double-count.
   */
  test("a null session id is never used to fingerprint a re-run — both turns are banked", async () => {
    const ws = workspace([ASKER], { alpha: "auto" });
    await runNext({
      root: ws.root, dryRun: false, mode: "prepare", yolo: false,
      actor: "alan", at: "2026-08-29T09:00:00Z",
    });
    writeFileSync(join(ws.runDir, "01-what", "intent.md"), cannedIntent(), "utf8");
    writeFileSync(join(ws.runDir, "01-what", "handoff.md"), cannedHandoff(), "utf8");
    writeFileSync(join(ws.runDir, "01-what", "questions.md"), PROSE_QUESTIONS, "utf8");
    mkdirSync(join(ws.runDir, ".agent", "alpha"), { recursive: true });
    writeFileSync(
      join(ws.runDir, ".agent", "alpha", "result.json"),
      JSON.stringify({ outputs: ["01-what/intent.md"], questions_asked: [], notes: "", cost_usd: 0.4 }),
      "utf8",
    );

    const refused = await runNext({
      root: ws.root, dryRun: false, mode: "commit", yolo: false,
      actor: "alan", at: "2026-08-29T09:05:00Z",
    });
    expect(refused.code).toBe(5);

    // The operator's fix, then the same command again — still no session id.
    expect(await questionsCommand.run(["lint", "--root", ws.root, "--fix"])).toBe(0);
    const again = await runNext({
      root: ws.root, dryRun: false, mode: "commit", yolo: false,
      actor: "alan", at: "2026-08-29T09:10:00Z",
    });

    const stage = RunStore.open(ws.runDir).run.phases
      .flatMap((p) => p.stages).find((s) => s.id === "alpha");
    expect(stage?.tasks).toHaveLength(2);
    expect(stage?.tasks.every((t) => t.cost_usd === 0.4)).toBe(true);
    expect(stage?.tasks.every((t) => t.session_id === null)).toBe(true);
    expect(again.lines.join("\n")).toContain("dedupe: none — no session id");

    // Persisted, not just printed: the first row banked the refusal and
    // carries the marker; the second carries the reason it was NOT matched
    // against the first, in `run.yml` itself.
    expect(stage?.tasks[0]?.banked_before_refusal).toBe(true);
    expect(stage?.tasks[1]?.dedupe).toBe("none — no session id");
    const raw = readFileSync(join(ws.runDir, "run.yml"), "utf8");
    expect(raw).toContain("banked_before_refusal: true");
    expect(raw).toContain('dedupe: "none — no session id"');
  });
});

describe("M2 · the fingerprint only matches a row a refusal itself banked", () => {
  /**
   * The bug review found: `alreadyBanked` scanned EVERY task on the stage, not
   * only ones a refusal had banked. `--prepare` re-marks a gate-rejected stage
   * `running` without clearing `tasks` (spec §5) — so an ordinary, already-done
   * row from attempt 1 is still sitting there when attempt 2 commits. When that
   * second, genuinely distinct attempt happens to share a session id (the host
   * resuming the same session across the retry), a declared cost (`null`, the
   * common unmetered case) and the same output paths, the OLD code matched it
   * to attempt 1 and dropped it — a real turn's cost silently missing from the
   * ledger, the exact failure this task exists to prevent, pointing the other
   * way. Attempt 1 here never refuses anything — no `questions.md` is even
   * declared — so it never earns `banked_before_refusal`, and is therefore
   * never a legitimate match for attempt 2.
   */
  test("a retry after a gate reject, same session, same cost, same outputs, is a NEW row — not dropped", async () => {
    const NO_QUESTIONS: StageOptions = {
      id: "alpha", phase: "01-what", budgetUsd: 6, gate: "approve",
      outputs: [
        { path: "01-what/intent.md", sections: ["Intent", "Scope"] },
        { path: "01-what/handoff.md", sections: ["Findings", "Decisions", "Unknowns", "Evidence ledger"] },
      ],
      checks: "[claim-sources]",
    };
    const ws = workspace([NO_QUESTIONS]);
    const resultJson = JSON.stringify({
      outputs: ["01-what/intent.md"], questions_asked: [], notes: "", cost_usd: null,
      session_id: "sess-retry",
    });

    // Attempt 1: an ORDINARY commit. Nothing refuses — questions.md is not even
    // declared — so this row is never marked `banked_before_refusal`.
    await runNext({
      root: ws.root, dryRun: false, mode: "prepare", yolo: false,
      actor: "alan", at: "2026-08-29T09:00:00Z",
    });
    writeFileSync(join(ws.runDir, "01-what", "intent.md"), cannedIntent(), "utf8");
    writeFileSync(join(ws.runDir, "01-what", "handoff.md"), cannedHandoff(), "utf8");
    mkdirSync(join(ws.runDir, ".agent", "alpha"), { recursive: true });
    writeFileSync(join(ws.runDir, ".agent", "alpha", "result.json"), resultJson, "utf8");
    await runNext({
      root: ws.root, dryRun: false, mode: "commit", yolo: false,
      actor: "alan", at: "2026-08-29T09:05:00Z",
    });

    const afterFirst = RunStore.open(ws.runDir).run.phases
      .flatMap((p) => p.stages).find((s) => s.id === "alpha");
    expect(afterFirst?.status).toBe("awaiting_gate");
    expect(afterFirst?.tasks).toHaveLength(1);
    expect(afterFirst?.tasks[0]?.banked_before_refusal).toBeUndefined();

    // A gate reject sends it back to `ready` without touching `tasks` — the
    // money already spent is not refunded (spec §5).
    const rejected = await rejectCommand.run(["--root", ws.root, "--note", "needs another pass"]);
    expect(rejected).toBe(0);
    expect(RunStore.open(ws.runDir).run.phases[0]?.stages[0]?.status).toBe("ready");
    expect(RunStore.open(ws.runDir).run.phases[0]?.stages[0]?.tasks).toHaveLength(1);

    // Attempt 2, retried: `--prepare` re-marks it `running`, `tasks` untouched.
    await runNext({
      root: ws.root, dryRun: false, mode: "prepare", yolo: false,
      actor: "alan", at: "2026-08-29T09:10:00Z",
    });
    expect(RunStore.open(ws.runDir).run.phases[0]?.stages[0]?.status).toBe("running");
    expect(RunStore.open(ws.runDir).run.phases[0]?.stages[0]?.tasks).toHaveLength(1);

    // Same host session, same declared (null) cost, same output paths as
    // attempt 1 — the exact shape that used to collapse into attempt 1's row.
    writeFileSync(join(ws.runDir, ".agent", "alpha", "result.json"), resultJson, "utf8");
    const second = await runNext({
      root: ws.root, dryRun: false, mode: "commit", yolo: false,
      actor: "alan", at: "2026-08-29T09:15:00Z",
    });

    const afterSecond = RunStore.open(ws.runDir).run.phases
      .flatMap((p) => p.stages).find((s) => s.id === "alpha");
    // The turn RAN a second time and must have its OWN row — not be silently
    // matched to the first and dropped.
    expect(afterSecond?.tasks).toHaveLength(2);
    expect(afterSecond?.tasks.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(afterSecond?.tasks[1]?.session_id).toBe("sess-retry");
    expect(afterSecond?.tasks[1]?.cost_usd).toBeNull();
    expect(second.lines.join("\n")).not.toContain("already recorded as t1");
  });
});

describe("M2 · banked_before_refusal / dedupe are additive RunTask fields", () => {
  test("a run.yml with neither key still validates and round-trips byte-identically", () => {
    const ws = workspace([ASKER]);
    const raw = readFileSync(join(ws.runDir, "run.yml"), "utf8");
    expect(raw).not.toContain("banked_before_refusal");
    expect(raw).not.toContain("dedupe");
    expect(validateRunFile(parseYaml(raw)).ok).toBe(true);
    expect(emitRunYaml(RunStore.open(ws.runDir).run)).toBe(raw);
  });

  test("both keys round-trip when present: emit, parse, emit again, byte for byte", () => {
    const ws = workspace([ASKER]);
    const store = RunStore.open(ws.runDir);
    store.mutate((run) => ({
      ...run,
      phases: run.phases.map((phase, i) => i !== 0 ? phase : {
        ...phase,
        stages: phase.stages.map((stage, j) => j !== 0 ? stage : {
          ...stage,
          tasks: [{
            id: "t1", status: "done" as const, expert: null, model: null,
            cost_usd: null, metered: false,
            error: null, session_id: null,
            started_at: "2026-08-29T09:00:00Z", ended_at: "2026-08-29T09:01:00Z",
            outputs: [],
            banked_before_refusal: true as const,
            dedupe: "none — no session id",
          }],
        }),
      }),
    }));
    store.save();

    const first = readFileSync(join(store.runDir, "run.yml"), "utf8");
    expect(first).toContain("banked_before_refusal: true");
    expect(first).toContain('dedupe: "none — no session id"');
    expect(validateRunFile(parseYaml(first)).ok).toBe(true);

    const reopened = RunStore.open(store.runDir);
    expect(emitRunYaml(reopened.run)).toBe(first);
  });
});

describe("M2 · tldrx questions lint", () => {
  test("exits 2 and names the unreadable blocks", async () => {
    const ws = workspace([ASKER]);
    writeFileSync(join(ws.runDir, "01-what", "questions.md"), PROSE_QUESTIONS, "utf8");
    const printed = capture();
    const code = await questionsCommand.run(["lint", "--root", ws.root]);
    const out = printed();
    expect(code).toBe(2);
    expect(out).toContain("BAD");
    expect(out).toContain("Q1, Q2");
    expect(out).toContain("--fix");
  });

  test("--fix rewrites the file in place and then lints clean (exit 0)", async () => {
    const ws = workspace([ASKER]);
    const path = join(ws.runDir, "01-what", "questions.md");
    writeFileSync(path, PROSE_QUESTIONS, "utf8");

    let printed = capture();
    expect(await questionsCommand.run(["lint", "--root", ws.root, "--fix"])).toBe(0);
    expect(printed()).toContain("converted Q1, Q2");
    expect(parseQuestions(readFileSync(path, "utf8")).blocks).toHaveLength(2);

    printed = capture();
    expect(await questionsCommand.run(["lint", "--root", ws.root])).toBe(0);
    expect(printed()).toContain("2 question(s) parse");
  });

  test("a run with no questions.md says so and exits 0", async () => {
    const ws = workspace([ASKER]);
    const printed = capture();
    expect(await questionsCommand.run(["lint", "--root", ws.root])).toBe(0);
    expect(printed()).toContain("nothing to lint");
  });
});

/** Swap stdout for a buffer; returns a reader that restores it. */
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

/** Keeps the temp-dir helper honest if a future test needs a bare workspace. */
export function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tldrx-q-"));
  scratch.push(dir);
  return dir;
}
