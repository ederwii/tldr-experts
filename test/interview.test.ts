/**
 * `tldrx interview` — the terminal channel over `questions.md`.
 *
 * Piped stdin is the tested path on purpose: it is what CI can drive, and it is
 * the same reader a human's terminal uses once a line has been typed. What the
 * assertions are really about is that answering here is INDISTINGUISHABLE from
 * answering with `tldrx answer` or by editing the file in Claude Code — same
 * footer, same `facts.yml` row, same two events (spec §2.7).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";
import { EXIT_NOT_FOUND, EXIT_OK } from "../src/cli/exitCodes.ts";
import { parseQuestions } from "../src/core/text/questions.ts";
import { FactsStore } from "../src/core/facts/FactsStore.ts";
import { EventLog } from "../src/core/events/EventLog.ts";
import { interpret, defaultReply } from "../src/core/interview/reply.ts";
import { splitLines } from "../src/core/interview/lineReader.ts";
import { WORKSPACE_YML, EMPTY_FACTS } from "./fixtures/tempRunWorkspace.ts";

const BIN = join(FRAMEWORK_ROOT, "bin", "tldrx.ts");

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function tldrx(cwd: string, args: readonly string[], stdin = ""): Promise<Run> {
  const proc = Bun.spawn(["bun", BIN, ...args], {
    cwd,
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, USER: "alan" },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

const QUESTIONS = [
  "# Questions — 01-what — run",
  "",
  "## Q1 · Where does leaderboard state live?",
  "<!-- id: Q1 | status: open | area: data-model | asked_by: architect | asked_at: 2026-08-29T09:00:00Z -->",
  "Why asked: no ranking store exists in the map [src: absent:.tldrx/map/api/domains.md]",
  "",
  "- A) New Postgres table, recomputed on hunt completion",
  "- B) Redis sorted set",
  "",
  "[Answer]:",
  "",
  "## Q2 · Who owns the ranking job?",
  "<!-- id: Q2 | status: open | area: ownership | asked_by: architect | asked_at: 2026-08-29T09:00:00Z -->",
  "Why asked: ownership cannot be read from the filesystem [src: absent:.tldrx/memory/facts.yml]",
  "",
  "- A) The API team",
  "- B) other — write it below",
  "",
  "[Answer]:",
  "",
  "## Q3 · Does the board page need SSR?",
  "<!-- id: Q3 | status: open | area: frontend | asked_by: architect | asked_at: 2026-08-29T09:00:00Z -->",
  "Why asked: no rendering mode is recorded [src: absent:.tldrx/memory/facts.yml]",
  "",
  "- A) Yes",
  "- B) No",
  "",
  "[Answer]:",
  "",
].join("\n");

const temps: string[] = [];
afterEach(() => {
  while (temps.length > 0) rmSync(temps.pop() ?? "", { recursive: true, force: true });
});

/** A workspace with a real run, so `RunStore` (not a fixture) resolves the cursor. */
async function workspaceWithRun(): Promise<{ root: string; runDir: string; questions: string }> {
  const root = mkdtempSync(join(tmpdir(), "tldrx-interview-"));
  temps.push(root);
  mkdirSync(join(root, ".tldrx", "memory"), { recursive: true });
  mkdirSync(join(root, "api"), { recursive: true });
  mkdirSync(join(root, "lab"), { recursive: true });
  writeFileSync(join(root, ".tldrx", "workspace.yml"), WORKSPACE_YML, "utf8");
  writeFileSync(join(root, ".tldrx", "memory", "facts.yml"), EMPTY_FACTS, "utf8");

  const created = await tldrx(root, ["run", "new", "leaderboard", "--scope", "feature", "--budget", "5"]);
  expect(created.code).toBe(EXIT_OK);
  const runId = /created tldrx-work\/(\S+)/.exec(created.stdout)?.[1] ?? "";
  expect(runId).not.toBe("");

  const runDir = join(root, "tldrx-work", runId);
  const questions = join(runDir, "01-what", "questions.md");
  writeFileSync(questions, QUESTIONS, "utf8");
  return { root, runDir, questions };
}

describe("tldrx interview", () => {
  test("records a letter, free text, and stops at `q`", async () => {
    const { root, runDir, questions } = await workspaceWithRun();
    const run = await tldrx(root, ["interview"], "A\nthe platform squad\nq\n");
    expect(run.stderr).toBe("");
    expect(run.code).toBe(EXIT_OK);

    // Footers, in the file, written by the shared answer path.
    const blocks = parseQuestions(readFileSync(questions, "utf8")).blocks;
    const byId = new Map(blocks.map((block) => [block.id, block]));
    expect(byId.get("Q1")?.metadata?.status).toBe("answered");
    expect(byId.get("Q1")?.answer).toBe("New Postgres table, recomputed on hunt completion");
    expect(byId.get("Q1")?.footer?.answered_by).toBe("alan");
    expect(byId.get("Q2")?.answer).toBe("the platform squad");
    // `q` stopped before Q3, so Q3 is untouched.
    expect(byId.get("Q3")?.metadata?.status).toBe("open");
    expect(byId.get("Q3")?.answer).toBe("");

    // Facts, with the question as provenance.
    const facts = FactsStore.loadOrEmpty(join(root, ".tldrx", "memory", "facts.yml")).facts;
    expect(facts).toHaveLength(2);
    expect(facts[0]?.kind).toBe("answer");
    expect(facts[0]?.confidence).toBe("stated");
    expect(facts[0]?.area).toBe("data-model");
    expect(facts[0]?.source.q).toBe("Q1");
    expect(facts[0]?.fact).toContain("New Postgres table");
    expect(facts[1]?.fact).toContain("the platform squad");

    // Two events per answer, in the run's own log.
    const events = EventLog.forRun(runDir).read();
    const answered = events.filter((event) => event.type === "question.answered");
    const added = events.filter((event) => event.type === "fact.added");
    expect(answered.map((event) => event.payload.q)).toEqual(["Q1", "Q2"]);
    expect(added.map((event) => event.payload.fact)).toEqual([facts[0]?.id, facts[1]?.id]);

    expect(run.stdout).toContain("2 of 3 answered, 1 still open (quit)");
    expect(run.stdout).toContain("`tldrx next`");
    expect(run.stdout).toContain("`tldrx run status`");
  });

  test("shows each question's `Why asked` line and its options", async () => {
    const { root } = await workspaceWithRun();
    const run = await tldrx(root, ["interview"], "q\n");
    expect(run.stdout).toContain("Q1 · Where does leaderboard state live?");
    expect(run.stdout).toContain("Why asked: no ranking store exists in the map");
    expect(run.stdout).toContain("A) New Postgres table, recomputed on hunt completion");
    expect(run.stdout).toContain("B) Redis sorted set");
    expect(run.stdout).toContain("s=skip");
  });

  test("`s` and a blank line skip without recording anything", async () => {
    const { root, questions } = await workspaceWithRun();
    const run = await tldrx(root, ["interview"], "s\n\nB\n");
    expect(run.code).toBe(EXIT_OK);
    const byId = new Map(parseQuestions(readFileSync(questions, "utf8")).blocks.map((b) => [b.id, b]));
    expect(byId.get("Q1")?.metadata?.status).toBe("open");
    expect(byId.get("Q2")?.metadata?.status).toBe("open");
    expect(byId.get("Q3")?.answer).toBe("No");
    expect(FactsStore.loadOrEmpty(join(root, ".tldrx", "memory", "facts.yml")).facts).toHaveLength(1);
  });

  test("end of input leaves the rest open, and says so", async () => {
    const { root, questions } = await workspaceWithRun();
    const run = await tldrx(root, ["interview"], "A\n");
    expect(run.code).toBe(EXIT_OK);
    expect(run.stdout).toContain("1 of 3 answered, 2 still open (input ended)");
    const open = parseQuestions(readFileSync(questions, "utf8")).blocks
      .filter((block) => block.metadata?.status === "open");
    expect(open.map((block) => block.id)).toEqual(["Q2", "Q3"]);
  });

  test("a letter the question does not offer records nothing", async () => {
    const { root, questions } = await workspaceWithRun();
    const run = await tldrx(root, ["interview"], "E\nq\n");
    expect(run.stdout).toContain("Q1 offers no option E (only A/B) — skipped");
    const q1 = parseQuestions(readFileSync(questions, "utf8")).blocks.find((b) => b.id === "Q1");
    expect(q1?.metadata?.status).toBe("open");
    expect(FactsStore.loadOrEmpty(join(root, ".tldrx", "memory", "facts.yml")).facts).toHaveLength(0);
  });

  test("--yes-to-defaults takes option A for every question, reading no stdin", async () => {
    const { root, questions } = await workspaceWithRun();
    const run = await tldrx(root, ["interview", "--yes-to-defaults"], "");
    expect(run.code).toBe(EXIT_OK);
    const answers = parseQuestions(readFileSync(questions, "utf8")).blocks.map((block) => block.answer);
    expect(answers).toEqual([
      "New Postgres table, recomputed on hunt completion",
      "The API team",
      "Yes",
    ]);
    expect(run.stdout).toContain("3 of 3 answered, 0 still open");
  });

  test("--run names the run, and an unknown one exits 3", async () => {
    const { root, questions } = await workspaceWithRun();
    const runId = questions.split("/").at(-3) ?? "";
    const named = await tldrx(root, ["interview", "--run", runId], "A\nq\n");
    expect(named.code).toBe(EXIT_OK);
    expect(named.stdout).toContain(`run ${runId}`);

    const missing = await tldrx(root, ["interview", "--run", "260101-nope"], "");
    expect(missing.code).toBe(EXIT_NOT_FOUND);
    expect(missing.stderr).toContain("no run '260101-nope'");
  });

  test("no open questions is a clean exit 0, not an error", async () => {
    const { root, questions } = await workspaceWithRun();
    await tldrx(root, ["interview", "--yes-to-defaults"], "");
    const again = await tldrx(root, ["interview"], "");
    expect(again.code).toBe(EXIT_OK);
    expect(again.stdout).toContain("No open questions.");
    expect(existsSync(questions)).toBe(true);
  });

  test("--init works on .tldrx/init-questions.md, with no run at all", async () => {
    const root = mkdtempSync(join(tmpdir(), "tldrx-interview-init-"));
    temps.push(root);
    mkdirSync(join(root, ".tldrx", "memory"), { recursive: true });
    writeFileSync(join(root, ".tldrx", "workspace.yml"), WORKSPACE_YML, "utf8");
    writeFileSync(join(root, ".tldrx", "memory", "facts.yml"), EMPTY_FACTS, "utf8");
    const questions = join(root, ".tldrx", "init-questions.md");
    writeFileSync(questions, [
      "# Questions — init — workspace install",
      "",
      "## Q1 · How does this team plan work?",
      "<!-- id: Q1 | status: open | area: process | asked_by: facilitator | asked_at: 2026-08-29T09:00:00Z -->",
      "Why asked: no process model is recorded [src: absent:.tldrx/process.yml]",
      "",
      "- A) Scrum — fixed-length sprints",
      "- B) Kanban — continuous flow with a WIP limit",
      "",
      "[Answer]:",
      "",
    ].join("\n"), "utf8");

    const run = await tldrx(root, ["interview", "--init"], "B\n");
    expect(run.stderr).toBe("");
    expect(run.code).toBe(EXIT_OK);

    const block = parseQuestions(readFileSync(questions, "utf8")).blocks[0];
    expect(block?.metadata?.status).toBe("answered");
    expect(block?.answer).toBe("Kanban — continuous flow with a WIP limit");

    const facts = FactsStore.loadOrEmpty(join(root, ".tldrx", "memory", "facts.yml")).facts;
    expect(facts).toHaveLength(1);
    expect(facts[0]?.area).toBe("process");
    // `[assumption]`: init is not a run, so the events land in .tldrx/ under `init`.
    const events = new EventLog(join(root, ".tldrx", "events.jsonl")).read();
    expect(events.map((event) => event.type)).toEqual(["question.answered", "fact.added"]);
    expect(events[0]?.run).toBe("init");
    // No run exists, so the closing hint points at `run new`, not `next`.
    expect(run.stdout).toContain("tldrx run new");
  });

  test("--init without the file exits 3 and points at `tldrx init`", async () => {
    const root = mkdtempSync(join(tmpdir(), "tldrx-interview-noinit-"));
    temps.push(root);
    mkdirSync(join(root, ".tldrx"), { recursive: true });
    const run = await tldrx(root, ["interview", "--init"], "");
    expect(run.code).toBe(EXIT_NOT_FOUND);
    expect(run.stderr).toContain("run `tldrx init` first");
  });

  test("--init and --run together are a usage error", async () => {
    const { root } = await workspaceWithRun();
    const run = await tldrx(root, ["interview", "--init", "--run", "260101-x"], "");
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("pass one");
  });
});

describe("interview input parsing", () => {
  const block = parseQuestions(QUESTIONS).blocks[0]!;

  test("a letter becomes that option's text, case-insensitively", () => {
    expect(interpret("b", block)).toEqual({ kind: "answer", text: "Redis sorted set", option: "B" });
  });

  test("anything else is free text, verbatim and trimmed", () => {
    expect(interpret("  a new table in lab  ", block))
      .toEqual({ kind: "answer", text: "a new table in lab", option: null });
  });

  test("s / skip / blank skip; q / quit stop; null is end of input", () => {
    for (const line of ["s", "skip", "SKIP", "", "   "]) expect(interpret(line, block).kind).toBe("skip");
    for (const line of ["q", "quit", "Q"]) expect(interpret(line, block).kind).toBe("quit");
    expect(interpret(null, block).kind).toBe("eof");
  });

  test("a letter with no option behind it is reported, never invented", () => {
    expect(interpret("D", block)).toEqual({ kind: "unknown-option", letter: "D" });
  });

  test("the default is option A", () => {
    expect(defaultReply(block))
      .toEqual({ kind: "answer", text: "New Postgres table, recomputed on hunt completion", option: "A" });
  });

  test("splitLines keeps an interior blank line but drops one trailing newline", () => {
    expect(splitLines("A\n\nB\n")).toEqual(["A", "", "B"]);
    expect(splitLines("A")).toEqual(["A"]);
    expect(splitLines("")).toEqual([]);
    expect(splitLines("A\r\nB\r\n")).toEqual(["A", "B"]);
  });
});
