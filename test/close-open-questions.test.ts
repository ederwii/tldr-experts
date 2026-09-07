/**
 * gh #141 — a run may close with a question nobody ever answered, and nothing says so.
 *
 * ## The measurement that produced this file
 *
 * The issue was filed INFERRED, from the driver of run `260830-money-and-payments`
 * (aparece-v2) at close: *"D7.6 nunca recibió respuesta ni disparó su default"* —
 * a fail-open on a money path. Three things were then measured against that run
 * and against this repo, and all three refute the mechanism the report assumes:
 *
 * 1. **`D7.6` was never a question.** The §2.7 heading grammar is
 *    `^## (Q\d{1,6}) · ` (`src/core/text/questions.ts:89`). `D7.6` is a
 *    Definition-of-Done criterion in the aparece-v2 handoff package
 *    (`docs/domain-design/docs/12-DEFINITION-OF-DONE.md:118-125`), cited as such
 *    throughout the run. The run's `questions.md` files hold exactly three blocks
 *    — `Q1`, `Q2` (`01-what`) and `Q3` (`02-how`) — and every one is
 *    `status: answered`.
 * 2. **A question cannot DECLARE a default.** §2.7's metadata keys are
 *    `id status area asked_by asked_at`, all required, plus the optional
 *    `affects:`. There is no `default:` and no `timeout:` — nothing to fire.
 * 3. **Nothing fires one.** The only thing in the codebase called a default is
 *    `tldrx interview --yes-to-defaults` (`core/interview/reply.ts:46`), which is
 *    operator-invoked, takes option **A**, and carries its own `[assumption]`
 *    label. No timer, no gate and no close applies anything to an open question.
 *
 * So the report's mechanism does not exist. What DOES exist is the fail-open it
 * was reaching for: the auto gate's `questions` condition is per-stage and reads
 * only that stage's own declared `questions.md` (`core/run/autoGate.ts:150`), a
 * HUMAN `approve` does not look at questions at all, and `closeRun` reads
 * `run.yml` and git and nothing else. A question left open in `01-what` can
 * therefore age through every later stage, past a signed gate, and out of the
 * run's close without one word about it.
 *
 * This file pins the cheap guard the issue asks for: **a run close NAMES the
 * questions nobody answered**, and says in the same breath that nothing was going
 * to answer them — which is the belief that produced the report.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";
import { closeRun, describeOpenQuestions } from "../src/core/run/closeRun.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { decidedTally, describeDecidedTally } from "../src/core/facts/decidedTally.ts";
import { FactsStore } from "../src/core/facts/FactsStore.ts";
import { factsPath } from "../src/hooks/lib/workspace.ts";
import type { Fact, FactSource } from "../src/core/facts/Fact.ts";
import { makeFacilitatorWorkspace, type FacilitatorWorkspace } from "./fixtures/facilitator/workspace.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

// `closeRun` spawns git, and the CLI test spawns `bun`. Process cost is a property
// of the box, not of the code (#43).
setDefaultTimeout(spawnTestTimeout());

const BIN = join(FRAMEWORK_ROOT, "bin", "tldrx.ts");

let open: FacilitatorWorkspace[] = [];
afterEach(() => {
  for (const ws of open) ws.dispose();
  open = [];
});

function workspace(): FacilitatorWorkspace {
  const ws = makeFacilitatorWorkspace({
    scope: "demo",
    budgetUsd: 10,
    stages: [{
      id: "alpha", phase: "01-what", budgetUsd: 6, gate: "auto",
      outputs: [{ path: "01-what/intent.md", sections: ["Intent", "Scope"] }],
    }],
  });
  open.push(ws);
  return ws;
}

/** One §2.7 block, spelled in the exact grammar the parser reads. */
function block(id: string, title: string, status: "open" | "answered", answer = ""): string {
  return [
    `## ${id} · ${title}`,
    `<!-- id: ${id} | status: ${status} | area: money | asked_by: product | asked_at: 2026-09-02T15:00:00Z -->`,
    "Why asked: no seeded source settles it [src: absent:docs/12-DEFINITION-OF-DONE.md]",
    "",
    "- A) Yes",
    "- B) No",
    "",
    `[Answer]:${answer === "" ? "" : ` ${answer}`}`,
    "",
  ].join("\n");
}

function writeQuestions(ws: FacilitatorWorkspace, phase: string, body: string): void {
  const dir = join(ws.runDir, phase);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "questions.md"), `# Questions — ${phase}\n\n${body}`, "utf8");
}

async function tldrx(cwd: string, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", BIN, ...args], { stdout: "pipe", stderr: "pipe", cwd });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

async function close(ws: FacilitatorWorkspace) {
  const store = RunStore.open(ws.runDir);
  return closeRun(store.run, ws.root, store.runDir, store.runId);
}

/** A minimal `FactSource` naming only `run`, for the pure `decidedTally` cases. */
function src(run: string): FactSource {
  return { who: "alan", when: "2026-09-06T09:00:00Z", run, q: null };
}

/** A minimal live `Fact`, for the calls that need facts and no workspace. */
function liveFact(overrides: Pick<Fact, "id" | "source"> & Partial<Fact>): Fact {
  return {
    fact: "seeded for #169",
    area: "governance",
    repos: [],
    kind: "answer",
    confidence: "stated",
    supersedes: null,
    superseded_by: null,
    retired: null,
    ...overrides,
  };
}

/** A fact recorded on `ws`'s real store, so `closeRun` reads it back for real. */
function seedFact(
  ws: FacilitatorWorkspace,
  input: { readonly id: string; readonly run: string; readonly decided_by?: "owner" | "driver" },
): Fact {
  return FactsStore.update(factsPath(ws.root), (store) => store.append({
    fact: `${input.id} seeded for #169`,
    area: "governance",
    repos: [],
    kind: "answer",
    confidence: "stated",
    source: {
      who: "alan",
      when: "2026-09-06T09:00:00Z",
      run: input.run,
      q: null,
      ...(input.decided_by === undefined ? {} : { decided_by: input.decided_by }),
    },
  }));
}

describe("#141 — a run close names the questions nobody answered", () => {
  test("every open block in the run, by id, phase and title", async () => {
    const ws = workspace();
    writeQuestions(ws, "01-what", block("Q1", "Which currency?", "open"));
    writeQuestions(ws, "02-how", [
      block("Q2", "Settled already", "answered", "B — no"),
      block("Q3", "Who owns the snapshot?", "open"),
    ].join("\n"));

    const closed = await close(ws);

    expect(closed.openQuestions.map((q) => q.id)).toEqual(["Q1", "Q3"]);
    expect(closed.openQuestions[0]).toMatchObject({
      id: "Q1", path: "01-what/questions.md", title: "Which currency?",
    });
    expect(closed.openQuestions[1]?.path).toBe("02-how/questions.md");
  });

  test("the sentence names them AND refuses the belief that a default was coming", async () => {
    const ws = workspace();
    writeQuestions(ws, "01-what", block("Q1", "Which currency?", "open"));

    const said = describeOpenQuestions((await close(ws)).openQuestions);

    expect(said).not.toBeNull();
    expect(said).toContain("Q1");
    expect(said).toContain("01-what/questions.md");
    expect(said).toContain("Which currency?");
    // The driver of 260830-money-and-payments believed a declared default would
    // fire. §2.7 has no such key and nothing fires one — so the close says so
    // rather than leaving the belief standing (gh #141).
    expect(said).toContain("no default");
    expect(said).toContain("--yes-to-defaults");
  });

  test("`tldrx run cancel` prints it — cancelling is closing", async () => {
    const ws = workspace();
    writeQuestions(ws, "01-what", block("Q1", "Which currency?", "open"));

    const cancelled = await tldrx(ws.root, "run", "cancel", ws.runId, "--note", "superseded");

    expect(cancelled.code).toBe(0);
    expect(cancelled.stdout).toContain("Q1");
    expect(cancelled.stdout).toContain("never answered");
  });
});

describe("#141 — the guards that keep the guard quiet", () => {
  test("a run whose every question is answered says nothing at all", async () => {
    const ws = workspace();
    writeQuestions(ws, "01-what", block("Q1", "Which currency?", "answered", "A — MXN"));

    const closed = await close(ws);

    expect(closed.openQuestions).toEqual([]);
    expect(describeOpenQuestions(closed.openQuestions)).toBeNull();
  });

  test("a run that asked nothing says nothing", async () => {
    const closed = await close(workspace());

    expect(closed.openQuestions).toEqual([]);
    expect(describeOpenQuestions(closed.openQuestions)).toBeNull();
  });

  test("a questions.md nobody can parse is reported as that, never as `0 open`", async () => {
    const ws = workspace();
    // The prose form `templates/questions.md` used to teach — `### Q1 — …`, which
    // the §2.7 parser reads as ABSENT, not as half a block (spec §2.7, 2026-08-29).
    writeQuestions(ws, "01-what", "### Q1 — Which currency?\n\n**Answer:**\n");

    const closed = await close(ws);

    expect(closed.openQuestions).toHaveLength(1);
    expect(closed.openQuestions[0]).toMatchObject({ id: "Q1", unreadable: true });
    const said = describeOpenQuestions(closed.openQuestions);
    expect(said).toContain("01-what/questions.md");
    expect(said).toContain("cannot be read");
  });
});

describe("#169 — the close says how many of this run's decisions name a decider", () => {
  test("owner, driver and not-stated are counted, and absence is the count", () => {
    const facts = [
      liveFact({ id: "F001", source: { ...src("R"), decided_by: "owner" } }),
      liveFact({ id: "F002", source: { ...src("R"), decided_by: "driver" } }),
      liveFact({ id: "F003", source: src("R") }),                 // nothing said
      liveFact({ id: "F004", source: src("OTHER-RUN") }),         // another run's
    ];
    expect(decidedTally(facts, "R")).toEqual({ owner: 1, driver: 1, notStated: 1 });
  });

  test("the sentence names all three and claims no timeout mechanism", () => {
    const said = describeDecidedTally({ owner: 1, driver: 2, notStated: 3 }) ?? "";
    expect(said).toContain("6");
    expect(said).toContain("3");
    // It must not imply a default fired: nothing ages a question into an answer
    // (`closeRun.ts:52-60`), and a row with no decider says "not stated".
    expect(said).toContain("not stated");
    expect(said).not.toContain("default");
  });

  test("a run that recorded no facts says nothing rather than a confident zero", () => {
    expect(describeDecidedTally({ owner: 0, driver: 0, notStated: 0 })).toBeNull();
  });

  test("closing a run carries the tally, and changes no exit code", async () => {
    const ws = workspace();
    seedFact(ws, { id: "F001", run: ws.runId, decided_by: "owner" });
    const closed = await close(ws);
    expect(closed.decided).toEqual({ owner: 1, driver: 0, notStated: 0 });
  });
});
