/**
 * `tldrx budget grant` — a ceiling that answers to a recorded decision (#170).
 *
 * Three places write a dollar ceiling and one place records what the owner said
 * they would pay (an answered fact), and until this landed no code path connected
 * them: `grep -rn 'facts\|FactsStore\|grant\|authoriz\|reconcil' src/core/budget/
 * src/cli/commands/budget.ts` returned zero functional hits. A grant was prose.
 *
 * Most of this file drives the REAL CLI, so it spawns; `setDefaultTimeout` scales
 * with measured machine load exactly as `budget-ux.test.ts` does. The two pure
 * tests at the end are the schema half — a `budget.yml` written before these keys
 * existed still loads, and still emits byte-for-byte what it always did.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";
import { parseYaml } from "../src/core/yaml.ts";
import { EXIT_GATE_REFUSED, EXIT_OK, EXIT_USAGE } from "../src/cli/exitCodes.ts";
import { asRunBudget, validateRunBudget, type RunBudget } from "../src/core/budget/RunBudget.ts";
import { emitBudgetYaml } from "../src/core/run/emitRunYaml.ts";
import { EVENT_TYPES } from "../src/core/events/Event.ts";
import { readReviewLedger } from "../src/core/build/reviewLedger.ts";
import { makeRunWorkspace, type TempRunWorkspace } from "./fixtures/tempRunWorkspace.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

setDefaultTimeout(spawnTestTimeout());

const BIN = join(FRAMEWORK_ROOT, "bin", "tldrx.ts");

async function tldrx(cwd: string, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", BIN, ...args], { stdout: "pipe", stderr: "pipe", cwd });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

let workspace: TempRunWorkspace | null = null;
afterEach(() => {
  workspace?.dispose();
  workspace = null;
});

function onlyRunDir(root: string): string {
  const work = join(root, "tldrx-work");
  const entries = readdirSync(work).filter((name) => !name.startsWith("."));
  return join(work, entries[0] as string);
}

function loadBudgetFile(runDir: string): RunBudget {
  const doc = parseYaml(readFileSync(join(runDir, "budget.yml"), "utf8"));
  expect(validateRunBudget(doc).issues).toEqual([]);
  return asRunBudget(doc);
}

function eventsOf(root: string): { type: string; payload: Record<string, unknown> }[] {
  const text = readFileSync(join(onlyRunDir(root), "events.jsonl"), "utf8");
  return text.split("\n").filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> });
}

/**
 * One run priced at $10, and ONE live fact (`F001`) for a grant to cite.
 *
 * The fact is written by the real `tldrx facts add`, not by hand: a grant whose
 * `--fact` had to be hand-edited into facts.yml would be testing a file shape
 * rather than the path an operator actually walks.
 */
async function runWithFact(): Promise<TempRunWorkspace> {
  const ws = makeRunWorkspace();
  workspace = ws;
  const created = await tldrx(ws.root, "run", "new", "leaderboard", "--budget", "10");
  expect(created.code).toBe(EXIT_OK);
  const fact = await tldrx(
    ws.root, "facts", "add", "The owner authorised a ceiling for this run.",
    "--area", "budget", "--decided-by", "owner",
  );
  expect(fact.code).toBe(EXIT_OK);
  expect(fact.stdout).toContain("F001");
  return ws;
}

/**
 * A `budget.yml` written before any of these keys existed — the measured bytes
 * `tldrx run new leaderboard --budget 10` produced at `06e3eab`, run id and all.
 */
const LEGACY_BUDGET_YML = `# tldrx-work/<run>/budget.yml — the ceiling the facilitator refuses to exceed (spec §2.11).
# Actuals are rolled up from run.yml task costs; never typed by hand.
version: 1
run: "260907-leaderboard"
ceiling_usd: 10.00
per_agent_max_usd: 3.60
warn_at_pct: 80
on_exceed: block
phases:
  - {id: "01-what", ceiling_usd: 1.60, spent_usd: 0.00}
  - {id: "02-how", ceiling_usd: 2.40, spent_usd: 0.00}
  - {id: "03-plan", ceiling_usd: 1.60, spent_usd: 0.00}
  - {id: "04-build", ceiling_usd: 3.60, spent_usd: 0.00}
  - {id: "05-watch", ceiling_usd: 0.80, spent_usd: 0.00}
`;

describe("tldrx budget grant — a ceiling that answers to a decision", () => {
  test("the grant is recorded with the fact behind it, and survives a re-read", async () => {
    const ws = await runWithFact();
    expect((await tldrx(ws.root, "budget", "grant", "40", "--fact", "F001")).code).toBe(EXIT_OK);
    const budget = loadBudgetFile(onlyRunDir(ws.root));
    expect(budget.authorized_usd).toBe(40);
    expect(budget.authorized_by).toBe("F001");
    expect(budget.authorized_at).not.toBeNull();
  });

  test("THE PIN: a grant survives `budget raise`, which rewrites the file through the emitter", async () => {
    // `emitRunYaml.ts` says it in its own comments: a key that does not round-trip
    // is ERASED by the one command an operator reaches for when a ceiling binds —
    // and that command is this one. Without the emitter lines every other test in
    // this file still passes and the grant is gone after the first raise.
    const ws = await runWithFact();
    await tldrx(ws.root, "budget", "grant", "40", "--fact", "F001");
    expect((await tldrx(ws.root, "budget", "raise", "01-what", "0.50", "--take-from", "05-watch")).code)
      .toBe(EXIT_OK);
    const budget = loadBudgetFile(onlyRunDir(ws.root));
    expect(budget.authorized_usd).toBe(40);
    expect(budget.authorized_by).toBe("F001");
  });

  test("the emitted grant is a PLAIN scalar, never quoted to suit a test", async () => {
    const ws = await runWithFact();
    await tldrx(ws.root, "budget", "grant", "40", "--fact", "F001", "--on-exceed", "block");
    const text = readFileSync(join(onlyRunDir(ws.root), "budget.yml"), "utf8");
    expect(text).toContain("\nauthorized_usd: 40.00\n");
    expect(text).toContain("\nauthorized_by: F001\n");
    expect(text).toContain("\non_grant_exceed: block\n");
  });

  test("under the default (warn), a ceiling above the grant is WARNED and written", async () => {
    const ws = await runWithFact();                       // run ceiling $10
    await tldrx(ws.root, "budget", "grant", "10", "--fact", "F001");
    const raised = await tldrx(ws.root, "budget", "raise", "04-build", "20");
    expect(raised.code).toBe(EXIT_OK);
    expect(raised.stdout).toContain("F001");
    expect(raised.stdout.toLowerCase()).toContain("authorized");
    expect(loadBudgetFile(onlyRunDir(ws.root)).ceiling_usd).toBeGreaterThan(10);
  });

  test("under `block`, the same raise is REFUSED with 2, and nothing is written", async () => {
    const ws = await runWithFact();
    await tldrx(ws.root, "budget", "grant", "10", "--fact", "F001", "--on-exceed", "block");
    const runDir = onlyRunDir(ws.root);
    const before = readFileSync(join(runDir, "budget.yml"), "utf8");

    const refused = await tldrx(ws.root, "budget", "raise", "04-build", "20");

    expect(refused.code).toBe(EXIT_GATE_REFUSED);          // money/gate, not usage
    expect(refused.stdout).toBe("");
    expect(readFileSync(join(runDir, "budget.yml"), "utf8")).toBe(before);
  });

  test("with NO grant recorded, nothing is reconciled and nothing is SAID", async () => {
    // Absent is the LAX side, deliberately: `$0` would brick every run on disk.
    // The silence is asserted too — an implementation that read absence as a $0
    // grant would still exit 0 under the `warn` default, and would give itself
    // away only here, in the sentence it had no business printing.
    const ws = await runWithFact();
    const raised = await tldrx(ws.root, "budget", "raise", "04-build", "20");
    expect(raised.code).toBe(EXIT_OK);
    expect(raised.stdout.toLowerCase()).not.toContain("authorized");
    expect(loadBudgetFile(onlyRunDir(ws.root)).authorized_usd).toBeNull();
  });

  test("a --fact naming no live fact is a usage error (1), and nothing is written", async () => {
    const ws = await runWithFact();
    const runDir = onlyRunDir(ws.root);
    const before = readFileSync(join(runDir, "budget.yml"), "utf8");
    const bad = await tldrx(ws.root, "budget", "grant", "40", "--fact", "F404");
    expect(bad.code).toBe(EXIT_USAGE);
    expect(bad.stdout).toBe("");
    expect(readFileSync(join(runDir, "budget.yml"), "utf8")).toBe(before);
  });

  test("grant with no --fact at all is a usage error: a number nobody said", async () => {
    const ws = await runWithFact();
    expect((await tldrx(ws.root, "budget", "grant", "40")).code).toBe(EXIT_USAGE);
  });

  test("a bad amount and an unknown phase are both usage errors (1), not gate refusals", async () => {
    const ws = await runWithFact();
    expect((await tldrx(ws.root, "budget", "grant", "banana", "--fact", "F001")).code).toBe(EXIT_USAGE);
    expect((await tldrx(ws.root, "budget", "grant", "40", "--fact", "F001", "--phase", "09-nope")).code)
      .toBe(EXIT_USAGE);
    expect(loadBudgetFile(onlyRunDir(ws.root)).authorized_usd).toBeNull();
  });

  test("a phase grant governs its phase and the run grant governs the rest", async () => {
    const ws = await runWithFact();
    await tldrx(ws.root, "budget", "grant", "5", "--fact", "F001", "--phase", "04-build", "--on-exceed", "block");
    expect((await tldrx(ws.root, "budget", "raise", "04-build", "20")).code).toBe(EXIT_GATE_REFUSED);
    expect((await tldrx(ws.root, "budget", "raise", "01-what", "0.50", "--take-from", "05-watch")).code)
      .toBe(EXIT_OK);
  });

  test("a phase grant is measured against the PHASE ceiling, not the run's", async () => {
    // The pin that tells the two branches apart. Measured at `06e3eab`: a $10 run
    // gives `04-build` a $3.60 ceiling. Granted $5 and raised by $0.50 the PHASE
    // lands at $4.10 — inside its grant — while the RUN ceiling grows to $10.50,
    // well above $5. An implementation that compared `runCeilingAfter` against the
    // phase grant would refuse this, and every other test here would still pass.
    const ws = await runWithFact();                       // run ceiling $10
    await tldrx(ws.root, "budget", "grant", "5", "--fact", "F001", "--phase", "04-build", "--on-exceed", "block");
    const raised = await tldrx(ws.root, "budget", "raise", "04-build", "0.50");
    expect(raised.code).toBe(EXIT_OK);
    const budget = loadBudgetFile(onlyRunDir(ws.root));
    expect(budget.phases.find((p) => p.id === "04-build")?.ceiling_usd).toBeCloseTo(4.1, 2);
    expect(budget.ceiling_usd).toBeGreaterThan(5);
  });

  test("recording a grant the ceiling ALREADY exceeds says so, and refuses nothing", async () => {
    // The money is already committed; there is nothing left to refuse. The grant
    // is still recorded, because a decision that arrives late is still a decision.
    const ws = await runWithFact();                       // run ceiling $10
    const granted = await tldrx(ws.root, "budget", "grant", "4", "--fact", "F001", "--on-exceed", "block");
    expect(granted.code).toBe(EXIT_OK);
    expect(granted.stdout).toContain("F001");
    expect(loadBudgetFile(onlyRunDir(ws.root)).authorized_usd).toBe(4);
  });

  test("a budget.granted event is appended, with the fact and the amount", async () => {
    const ws = await runWithFact();
    await tldrx(ws.root, "budget", "grant", "40", "--fact", "F001");
    const [event] = eventsOf(ws.root).filter((e) => e.type === "budget.granted");
    expect(event?.payload).toMatchObject({ amount_usd: 40, fact: "F001", phase: null });
  });

  test("a grant that is REFUSED leaves no event claiming it happened", async () => {
    const ws = await runWithFact();
    await tldrx(ws.root, "budget", "grant", "40", "--fact", "F404");
    expect(eventsOf(ws.root).filter((e) => e.type === "budget.granted")).toEqual([]);
  });
});

describe("the new event type is a first-class citizen", () => {
  test("`budget.granted` is in the CLOSED enum, so `validateEvent` accepts it", () => {
    expect(EVENT_TYPES).toContain("budget.granted");
  });

  test("`tldrx replay` renders it rather than dropping the line", async () => {
    // `bullet` ends in `default: return null`, so a type with no case renders NO
    // line at all — a grant invisible in the narrative would be the same
    // written-but-never-read-back failure this change exists to remove.
    const ws = await runWithFact();
    await tldrx(ws.root, "budget", "grant", "40", "--fact", "F001");
    const replayed = await tldrx(ws.root, "replay");
    expect(replayed.code).toBe(EXIT_OK);
    expect(replayed.stdout).toContain("F001");
    expect(replayed.stdout).toContain("$40.00");
  });

  test("`readReviewLedger` survives a ledger carrying it", async () => {
    const ws = await runWithFact();
    await tldrx(ws.root, "budget", "grant", "40", "--fact", "F001");
    const ledger = readReviewLedger(onlyRunDir(ws.root), "S1");
    expect(ledger.verdicts).toBe(0);
    expect(ledger.erroredWith).toBeNull();
  });
});

describe("the format only grows", () => {
  test("a budget.yml written before these keys existed still loads, and means no grant", () => {
    const doc = parseYaml(LEGACY_BUDGET_YML);
    expect(validateRunBudget(doc).ok).toBe(true);
    const legacy = asRunBudget(doc);
    expect(legacy.authorized_usd).toBeNull();
    expect(legacy.authorized_by).toBeNull();
    expect(legacy.authorized_at).toBeNull();
    expect(legacy.on_grant_exceed).toBe("warn");
    expect(legacy.phases.every((p) => p.authorized_usd === null)).toBe(true);
  });

  test("a file with no grant is emitted byte-identically to before the keys existed", () => {
    expect(emitBudgetYaml(asRunBudget(parseYaml(LEGACY_BUDGET_YML)))).toBe(LEGACY_BUDGET_YML);
  });

  test("a file WITH a grant round-trips through the emitter and the mapper", () => {
    const granted = {
      ...asRunBudget(parseYaml(LEGACY_BUDGET_YML)),
      authorized_usd: 40,
      authorized_by: "F001",
      authorized_at: "2026-09-07T10:00:00Z",
      on_grant_exceed: "block" as const,
    };
    const back = asRunBudget(parseYaml(emitBudgetYaml(granted)));
    expect(validateRunBudget(parseYaml(emitBudgetYaml(granted))).issues).toEqual([]);
    expect(back.authorized_usd).toBe(40);
    expect(back.authorized_by).toBe("F001");
    expect(back.authorized_at).toBe("2026-09-07T10:00:00Z");
    expect(back.on_grant_exceed).toBe("block");
  });

  test("a PHASE grant round-trips too", () => {
    const base = asRunBudget(parseYaml(LEGACY_BUDGET_YML));
    const granted = {
      ...base,
      authorized_by: "F001",
      phases: base.phases.map((p) => (p.id === "04-build" ? { ...p, authorized_usd: 5 } : p)),
    };
    const back = asRunBudget(parseYaml(emitBudgetYaml(granted)));
    expect(back.phases.find((p) => p.id === "04-build")?.authorized_usd).toBe(5);
    expect(back.phases.find((p) => p.id === "01-what")?.authorized_usd).toBeNull();
  });
});
