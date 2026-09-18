/**
 * `tldrx facts dedupe [--dry-run]` — gh #216 part B.
 *
 * The dedupe check `FactsStore.append` gained in part A only stops NEW
 * duplicates; it does nothing for the ones already on disk before that fix —
 * the measured case is F028-F054 == F001-F027 in one real workspace, from an
 * import that ran twice. This command retires the EXISTING twins: group live
 * facts by `normaliseFactText`, keep the earliest id, and mark every other
 * member of the group `superseded_by` — chained through `retireDuplicate`
 * rather than fanned in, because `validateFactsFile`'s reciprocity check is
 * one-to-one (a group of 3+ cannot all point `superseded_by` at the same
 * target; see `FactsStore.retireDuplicate`'s own doc comment). `headOf` still
 * resolves every member of a chained group to the one still live.
 *
 * Fixtures write facts.yml DIRECTLY (`emitFactsYaml`), not through `append` —
 * `append` itself would refuse to create the duplicate in the first place
 * after part A, so a pre-existing duplicate ledger has to be built by hand,
 * exactly as the real ones on disk today were: written before this fix
 * existed.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { factsCommand } from "../src/cli/commands/facts.ts";
import { FactsStore } from "../src/core/facts/FactsStore.ts";
import { emitFactsYaml } from "../src/core/facts/emitFactsYaml.ts";
import type { Fact } from "../src/core/facts/Fact.ts";
import { makeRunWorkspace, type TempRunWorkspace } from "./fixtures/tempRunWorkspace.ts";

let workspaces: TempRunWorkspace[] = [];
afterEach(() => {
  for (const ws of workspaces) ws.dispose();
  workspaces = [];
});

function makeWorkspace(): TempRunWorkspace {
  const made = makeRunWorkspace();
  workspaces.push(made);
  return made;
}

function factsFileOf(ws: TempRunWorkspace): string {
  return join(ws.root, ".tldrx", "memory", "facts.yml");
}

function fact(overrides: Pick<Fact, "id" | "fact"> & Partial<Fact>): Fact {
  return {
    area: "billing",
    repos: [],
    kind: "observed",
    confidence: "measured",
    source: { who: "alan", when: "2026-09-06T09:00:00Z", run: null, q: null },
    supersedes: null,
    superseded_by: null,
    retired: null,
    ...overrides,
  };
}

function seed(ws: TempRunWorkspace, facts: readonly Fact[]): void {
  writeFileSync(factsFileOf(ws), emitFactsYaml({ version: 1, facts }), "utf8");
}

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

describe("tldrx facts dedupe (gh #216 part B)", () => {
  test("two twins: the later one is retired, superseded_by the earlier", async () => {
    const ws = makeWorkspace();
    seed(ws, [
      fact({ id: "F001", fact: "The outbox lives in the billing repo." }),
      fact({ id: "F002", fact: "Retries are capped at three." }),
      fact({ id: "F003", fact: "  the outbox   LIVES in the billing repo.  " }),
    ]);

    const printed = capture();
    const code = await factsCommand.run(["dedupe", "--root", ws.root]);
    const out = printed();

    expect(code).toBe(0);
    expect(out).toContain("F003");
    expect(out).toContain("F001");

    const store = FactsStore.load(factsFileOf(ws));
    const f003 = store.get("F003");
    expect(f003?.superseded_by).toBe("F001");
    const f001 = store.get("F001");
    expect(f001?.supersedes).toBe("F003");
    // Nothing deleted (§7: version 1 only grows).
    expect(store.facts).toHaveLength(3);
    expect(store.active.map((f) => f.id)).toEqual(["F001", "F002"]);
  });

  test("a group of three chains rather than fanning in, and headOf resolves every member", async () => {
    const ws = makeWorkspace();
    seed(ws, [
      fact({ id: "F001", fact: "The outbox lives in the billing repo." }),
      fact({ id: "F002", fact: "the OUTBOX lives in the billing repo." }),
      fact({ id: "F003", fact: "The outbox lives in the billing repo.  " }),
    ]);

    const code = await factsCommand.run(["dedupe", "--root", ws.root]);
    expect(code).toBe(0);

    const store = FactsStore.load(factsFileOf(ws));
    expect(store.active.map((f) => f.id)).toEqual(["F001"]);
    expect(store.headOf("F002")?.id).toBe("F001");
    expect(store.headOf("F003")?.id).toBe("F001");
    // The file is still valid — the reciprocal link is checked on load.
    expect(() => FactsStore.load(factsFileOf(ws))).not.toThrow();
  });

  test("--dry-run prints without writing — byte-identical file", async () => {
    const ws = makeWorkspace();
    seed(ws, [
      fact({ id: "F001", fact: "The outbox lives in the billing repo." }),
      fact({ id: "F002", fact: "the outbox lives in the billing repo." }),
    ]);
    const before = readFileSync(factsFileOf(ws), "utf8");

    const printed = capture();
    const code = await factsCommand.run(["dedupe", "--dry-run", "--root", ws.root]);
    const out = printed();

    expect(code).toBe(0);
    expect(out).toContain("would retire");
    expect(out).toContain("F002");
    expect(readFileSync(factsFileOf(ws), "utf8")).toBe(before);
  });

  test("nothing to retire — byte-identical file, exit 0", async () => {
    const ws = makeWorkspace();
    seed(ws, [
      fact({ id: "F001", fact: "The outbox lives in the billing repo." }),
      fact({ id: "F002", fact: "Retries are capped at three." }),
    ]);
    const before = readFileSync(factsFileOf(ws), "utf8");

    const code = await factsCommand.run(["dedupe", "--root", ws.root]);
    expect(code).toBe(0);
    expect(readFileSync(factsFileOf(ws), "utf8")).toBe(before);
  });

  test("a RETIRED twin is not grouped — it is not live", async () => {
    const ws = makeWorkspace();
    seed(ws, [
      fact({
        id: "F001", fact: "The outbox lives in the billing repo.",
        retired: { at: "2026-09-18T09:00:00Z", by: "alan", reason: "stale" },
      }),
      fact({ id: "F002", fact: "The outbox lives in the billing repo." }),
    ]);
    const before = readFileSync(factsFileOf(ws), "utf8");

    const code = await factsCommand.run(["dedupe", "--root", ws.root]);
    expect(code).toBe(0);
    expect(readFileSync(factsFileOf(ws), "utf8")).toBe(before);
  });

  // Guard, not a proof of the #383 fix: `runDedupe` never calls `store.save()`
  // when there is nothing to retire (early return on `groups.length === 0`),
  // so this path was never reachable from the throw #383 describes — asserted
  // here so a future change to that early return does not reopen it silently.
  test("an empty ledger (zero facts, seeded via emitFactsYaml) does not throw — see #383", async () => {
    const ws = makeWorkspace();
    seed(ws, []);
    const code = await factsCommand.run(["dedupe", "--root", ws.root]);
    expect(code).toBe(0);
  });
});

describe("FactsStore.retireDuplicate", () => {
  test("refuses a target whose `supersedes` is already taken — the link is one-to-one", () => {
    const ws = makeWorkspace();
    seed(ws, [
      fact({ id: "F001", fact: "a" }),
      fact({ id: "F002", fact: "b" }),
      fact({ id: "F003", fact: "c" }),
    ]);
    const store = FactsStore.load(factsFileOf(ws));
    store.retireDuplicate("F002", "F001");
    expect(() => store.retireDuplicate("F003", "F001")).toThrow(/one-to-one/);
  });
});
