/**
 * `tldrx facts add` — the command the drive mandate has been telling drivers to run.
 *
 * `mandate.ts` says "a fact that must outlive the turn is `tldrx facts add`, which
 * every later prompt DOES read", and until now no such command was dispatched. What
 * drivers did instead was hand-edit `.tldrx/memory/facts.yml`, which walks straight
 * past `FactsStore.append`: past the MAX_FACT_CHARS cut, past the `…` marker, past
 * the `truncated: true` flag, and past `save()`'s validation. A fact cut mid-word
 * with no marker on it is a record that does not know it is incomplete.
 *
 * `--decided-by` is REQUIRED here (a controller ruling over the original design):
 * 0.8.0's rule is that a driver's default is never cited as the owner's decision,
 * so the command never lets that field default silently — the caller must say
 * which of the two it was.
 *
 * Fixture: `makeRunWorkspace` (`./fixtures/tempRunWorkspace.ts`), the same one
 * `test/money-safety.test.ts` and `test/drive.test.ts` use — this command needs
 * nothing from the heavier facilitator fixture (`makeFacilitatorWorkspace`), which
 * exists for stage/workflow tests. Note: `makeRunWorkspace` ALREADY writes an empty
 * `.tldrx/memory/facts.yml` (`version: 1\nfacts: []\n`), so "nothing was written" is
 * asserted as "still zero facts", not as `existsSync(...) === false` — the file
 * always exists once the workspace is made.
 *
 * Neither this file's helpers nor `factsCommand.run` spawn a subprocess or reach
 * for a heavier fixture that shells out to git — so this file is not a
 * machine-load spawner (`test/machine-load.test.ts`'s own spawner detection) and
 * needs no `spawnTestTimeout` guard row.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { factsCommand } from "../src/cli/commands/facts.ts";
import { FactsStore } from "../src/core/facts/FactsStore.ts";
import { MAX_FACT_CHARS } from "../src/core/facts/Fact.ts";
import { renderMandate } from "../src/core/drive/mandate.ts";
import { makeRunWorkspace, type TempRunWorkspace } from "./fixtures/tempRunWorkspace.ts";

/** Placeholder only: `renderMandate` interpolates it as text and asserts nothing about it. */
const VERSION = "0.0.0-test";

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

/** Swap stdout for a buffer; returns a reader that restores it (pattern: questions-grammar.test.ts). */
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

function factsFileOf(ws: TempRunWorkspace): string {
  return join(ws.root, ".tldrx", "memory", "facts.yml");
}

describe("tldrx facts add", () => {
  test("writes a fact through the store, with the area, kind and confidence given", async () => {
    const ws = makeWorkspace();
    const code = await factsCommand.run([
      "add", "The outbox lives in the billing repo, not the api one.",
      "--area", "billing", "--kind", "observed", "--confidence", "measured",
      "--decided-by", "owner", "--root", ws.root,
    ]);

    expect(code).toBe(0);
    const store = FactsStore.load(factsFileOf(ws));
    const fact = store.facts[0];
    expect(fact?.id).toBe("F001");
    expect(fact?.fact).toBe("The outbox lives in the billing repo, not the api one.");
    expect(fact?.area).toBe("billing");
    expect(fact?.kind).toBe("observed");
    expect(fact?.confidence).toBe("measured");
    expect(fact?.source.decided_by).toBe("owner");
    expect(fact?.truncated).toBeUndefined();
  });

  test("a fact over the cap is cut at the cap, marked, and says so on stdout", async () => {
    const ws = makeWorkspace();
    const long = "y".repeat(MAX_FACT_CHARS + 500);

    const printed = capture();
    const code = await factsCommand.run([
      "add", long, "--area", "unscoped", "--decided-by", "owner", "--root", ws.root,
    ]);
    const out = printed();

    expect(code).toBe(0);
    const fact = FactsStore.load(factsFileOf(ws)).facts[0];
    expect(fact?.fact).toHaveLength(MAX_FACT_CHARS);
    expect(fact?.fact.endsWith("…")).toBe(true);
    expect(fact?.truncated).toBe(true);
    // The cut is told to the person who made it, at the moment they made it — a
    // marker only a later reader sees is a marker the author never acts on.
    expect(out).toContain("truncated");
    expect(out).toContain(String(MAX_FACT_CHARS));
  });

  test("attribution is recorded, and a driver default is never cited as the owner's", async () => {
    const ws = makeWorkspace();
    await factsCommand.run([
      "add", "Retries are capped at three.", "--area", "billing",
      "--decided-by", "driver", "--root", ws.root,
    ]);

    const path = factsFileOf(ws);
    expect(readFileSync(path, "utf8")).toContain("decided_by: driver");
    expect(FactsStore.load(path).facts[0]?.source.decided_by).toBe("driver");
  });

  test("a fact with no area is a usage error, and nothing is written", async () => {
    const ws = makeWorkspace();
    // `--decided-by` given, so the failure is isolated to the missing `--area`.
    const code = await factsCommand.run([
      "add", "Something true.", "--decided-by", "owner", "--root", ws.root,
    ]);
    expect(code).toBe(1);
    expect(FactsStore.load(factsFileOf(ws)).facts).toHaveLength(0);
  });

  test("a fact with no --decided-by is a usage error, and nothing is written", async () => {
    const ws = makeWorkspace();
    // `--area` given, so the failure is isolated to the missing `--decided-by` —
    // a controller ruling over the brief's original (optional) design: 0.8.0's
    // rule is that a driver's default is never cited as the owner's decision, so
    // the command never lets the caller skip saying which of the two it was.
    const code = await factsCommand.run([
      "add", "Something true.", "--area", "billing", "--root", ws.root,
    ]);
    expect(code).toBe(1);
    expect(FactsStore.load(factsFileOf(ws)).facts).toHaveLength(0);
  });

  test("an empty fact is a usage error — a fact without an assertion is not a fact", async () => {
    const ws = makeWorkspace();
    const code = await factsCommand.run([
      "add", "   ", "--area", "billing", "--decided-by", "owner", "--root", ws.root,
    ]);
    expect(code).toBe(1);
    expect(FactsStore.load(factsFileOf(ws)).facts).toHaveLength(0);
  });

  test("the string the drive mandate tells drivers to run is a command that exists", () => {
    // The load-bearing one. `test/drive.test.ts` pins that the mandate SAYS
    // `tldrx facts add`; this pins that saying it is not a lie.
    expect(renderMandate("unattended", VERSION, undefined, true)).toContain("tldrx facts add");
    expect(factsCommand.name).toBe("facts");
    expect(factsCommand.subcommands).toContain("add");
    expect(factsCommand.implemented).toBe(true);
  });
});
