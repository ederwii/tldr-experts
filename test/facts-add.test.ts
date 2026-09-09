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
 * The run-provenance tests need a REAL run on disk (`run.source.run`, the
 * `fact.added` event, `--run` picking one of several) — `RunStore.resolve` sees
 * nothing to resolve against a bare `makeRunWorkspace()`, since that fixture
 * creates no `tldrx-work/`. For those, `createRun` (`src/core/run/newRun.ts`) +
 * `gatedScope` (`./fixtures/tempRunWorkspace.ts`) mint a real one-stage run, the
 * same pairing `test/money-safety.test.ts`'s own `newRun` helper uses — lighter
 * than the facilitator fixture, and it needs no stage to actually run.
 *
 * Neither this file's helpers nor `factsCommand.run` spawn a subprocess or reach
 * for a heavier fixture that shells out to git — so this file is not a
 * machine-load spawner (`test/machine-load.test.ts`'s own spawner detection) and
 * needs no `spawnTestTimeout` guard row. `createRun` writes files under a
 * workspace lock; it starts no process either.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { factsCommand } from "../src/cli/commands/facts.ts";
import { helpFor, subcommandsOf } from "../src/cli/helpText.ts";
import { EXIT_NOT_FOUND, EXIT_USAGE } from "../src/cli/exitCodes.ts";
import { FactsStore } from "../src/core/facts/FactsStore.ts";
import { MAX_FACT_CHARS, type Fact } from "../src/core/facts/Fact.ts";
import { validateFactsFile } from "../src/core/facts/validateFactsFile.ts";
import { renderMandate } from "../src/core/drive/mandate.ts";
import { renderFacts } from "../src/core/facilitator/prompt.ts";
import { createRun } from "../src/core/run/newRun.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { EventLog } from "../src/core/events/EventLog.ts";
import { gatedScope, makeRunWorkspace, type TempRunWorkspace } from "./fixtures/tempRunWorkspace.ts";

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

/** Swap stderr for a buffer; the refusals under test write there and nowhere else. */
function captureStderr(): () => string {
  const original = process.stderr.write.bind(process.stderr);
  let buffer = "";
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    buffer += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stderr.write;
  return () => {
    process.stderr.write = original;
    return buffer;
  };
}

function factsFileOf(ws: TempRunWorkspace): string {
  return join(ws.root, ".tldrx", "memory", "facts.yml");
}

/** A workspace whose `.tldrx/workflows/gated.yml` lets `createRun` mint a real run. */
function makeRunnableWorkspace(): TempRunWorkspace {
  const made = makeRunWorkspace({ files: gatedScope("true") });
  workspaces.push(made);
  return made;
}

/** A real, open run — `RunStore.resolve` has something to find. */
function openRun(root: string, slug: string): RunStore {
  const created = createRun({
    root, slug, title: slug, scope: "gated", budgetUsd: 5,
    actor: "alan", now: new Date("2026-09-06T09:00:00Z"),
  });
  return RunStore.open(created.runDir);
}

/** A minimal, valid `Fact`, for `renderFacts` — everything but `id`/`fact`/`source` defaulted. */
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
    // `Command.subcommands` moved to `helpText.ts` (`subcommandsOf`) when the
    // docs-site CLI page started generating from the registry (main@3431a9e) — a
    // command's own subcommands live beside the flags they scope, not on the
    // dispatch-table object, so the docs generator never had to keep a third copy.
    expect(subcommandsOf("facts")).toContain("add");
    expect(factsCommand.implemented).toBe(true);
  });

  test("the not-found exit is DECLARED, so `--help` and the docs page carry it", () => {
    // `<cmd> --help`, the generated site page and the argv guard all read this
    // one registry: a refusal the code can return and the registry does not
    // declare is a code nobody is told about.
    expect(helpFor("facts")?.exits).toContain(EXIT_NOT_FOUND);
  });
});

/**
 * The run-provenance block (`facts.ts`'s `RunStore.resolve` branch) — untested
 * before this fix round, because `makeWorkspace()`/`makeRunWorkspace()` creates no
 * `tldrx-work/`, so every prior test hit `resolved.kind === "none"` and never
 * exercised `--run`, the ambiguous-run refusal, or the `fact.added` event (which
 * `tryAppend` writes best-effort — a silent failure there would have gone
 * unnoticed). `makeRunnableWorkspace`/`openRun` (above) mint a real run via
 * `createRun`, the same helper `test/money-safety.test.ts` uses.
 */
describe("tldrx facts add — run provenance", () => {
  test("with exactly one open run, the fact is attributed to it and the event lands on it", async () => {
    const ws = makeRunnableWorkspace();
    const run = openRun(ws.root, "alpha");

    const printed = capture();
    const code = await factsCommand.run([
      "add", "The outbox lives in the billing repo.", "--area", "billing",
      "--decided-by", "owner", "--root", ws.root,
    ]);
    const out = printed();

    expect(code).toBe(0);
    expect(out).not.toContain("no run recorded");
    const fact1 = FactsStore.load(factsFileOf(ws)).facts[0];
    expect(fact1?.source.run).toBe(run.runId);

    const events = EventLog.forRun(run.runDir).read().filter((e) => e.type === "fact.added");
    expect(events).toHaveLength(1);
    expect(events[0]?.run).toBe(run.runId);
    expect(events[0]?.actor).toBe(fact1?.source.who);
    expect(events[0]?.payload).toEqual({
      fact: fact1?.id, area: "billing", kind: fact1?.kind, q: null,
    });
  });

  test("`--run` selects the named run among two open ones, and only that run's log gains the event", async () => {
    const ws = makeRunnableWorkspace();
    const alpha = openRun(ws.root, "alpha");
    const beta = openRun(ws.root, "beta");

    const code = await factsCommand.run([
      "add", "Retries are capped at three.", "--area", "billing",
      "--decided-by", "driver", "--run", alpha.runId, "--root", ws.root,
    ]);

    expect(code).toBe(0);
    const fact1 = FactsStore.load(factsFileOf(ws)).facts[0];
    expect(fact1?.source.run).toBe(alpha.runId);

    const alphaEvents = EventLog.forRun(alpha.runDir).read().filter((e) => e.type === "fact.added");
    const betaEvents = EventLog.forRun(beta.runDir).read().filter((e) => e.type === "fact.added");
    expect(alphaEvents).toHaveLength(1);
    expect(betaEvents).toHaveLength(0);
  });

  test("`--run` naming a run that does not exist refuses — nothing is written, nothing is logged", async () => {
    // `RunStore.resolve` answers `{kind: "none"}` to BOTH "no run is open" and
    // "the id you named is not there", and this command used to take that one
    // branch for both: the fact was written with `source.run: null` and stdout
    // said "no open run to attribute it to" — a sentence that is false while a
    // run IS open, over a fact whose provenance was silently dropped. An id
    // nobody can find is spec §3's not-found, refused before the store is
    // touched.
    const ws = makeRunnableWorkspace();
    const alpha = openRun(ws.root, "alpha");

    const printed = capture();
    const code = await factsCommand.run([
      "add", "Something true.", "--area", "billing", "--decided-by", "owner",
      "--run", "260101-nope", "--root", ws.root,
    ]);
    const out = printed();

    expect(code).toBe(3);
    expect(out).toBe("");
    expect(FactsStore.load(factsFileOf(ws)).facts).toHaveLength(0);
    expect(EventLog.forRun(alpha.runDir).read().filter((e) => e.type === "fact.added")).toHaveLength(0);
  });

  test("two open runs with no `--run` refuse to guess, name the flag, and still record the fact", async () => {
    const ws = makeRunnableWorkspace();
    const alpha = openRun(ws.root, "alpha");
    const beta = openRun(ws.root, "beta");

    const printed = capture();
    const code = await factsCommand.run([
      "add", "Something true.", "--area", "billing", "--decided-by", "owner", "--root", ws.root,
    ]);
    const out = printed();

    expect(code).toBe(0);
    expect(out).toContain("several runs are open and this will not guess between them");
    expect(out).toContain("--run <id>");
    const fact1 = FactsStore.load(factsFileOf(ws)).facts[0];
    expect(fact1?.source.run).toBeNull();

    const alphaEvents = EventLog.forRun(alpha.runDir).read().filter((e) => e.type === "fact.added");
    const betaEvents = EventLog.forRun(beta.runDir).read().filter((e) => e.type === "fact.added");
    expect(alphaEvents).toHaveLength(0);
    expect(betaEvents).toHaveLength(0);
  });
});

/**
 * `renderFacts` (`src/core/facilitator/prompt.ts`) — the ONE place a prompt sees
 * `decided_by`. Before this fix round it was written by `facts add` but never
 * rendered, so a `--decided-by driver` fact reached every prompt indistinguishable
 * from an owner ruling — exactly the mistake the required flag exists to prevent.
 * No test pinned `renderFacts` at all before this (measured: `grep -rl renderFacts
 * test/` found no matches), so both the byte-identical absent case and the
 * present case are pinned here, from scratch.
 */
describe("renderFacts — {{facts}} carries decided_by attribution", () => {
  test("a fact with no decided_by renders byte-identically to before the field existed", () => {
    const f = fact({
      id: "F001", fact: "The outbox lives in the billing repo.", confidence: "measured",
    });
    expect(renderFacts([f], [])).toBe("- [F001] The outbox lives in the billing repo. (billing · measured)");
  });

  test("decided_by is appended only when present, and both values are pinned", () => {
    const driver = fact({
      id: "F001", fact: "Retries are capped at three.", confidence: "stated",
      source: { who: "alan", when: "2026-09-06T09:00:00Z", run: null, q: null, decided_by: "driver" },
    });
    const owner = fact({
      id: "F002", fact: "We ship weekly.", confidence: "stated",
      source: { who: "alan", when: "2026-09-06T09:00:00Z", run: null, q: null, decided_by: "owner" },
    });
    expect(renderFacts([driver], []))
      .toBe("- [F001] Retries are capped at three. (billing · stated) · decided by driver");
    expect(renderFacts([owner], []))
      .toBe("- [F002] We ship weekly. (billing · stated) · decided by owner");
  });

  test("conflicts_with is named in the prompt, so a reader handed both is told they disagree", () => {
    const f = fact({ id: "F002", fact: "State lives in Postgres.", confidence: "stated" });
    expect(renderFacts([{ ...f, conflicts_with: ["F001"] }], []))
      .toBe("- [F002] State lives in Postgres. (billing · stated) · conflicts with F001");
  });
});

/** `validateFactsFile` — the closed-set check on `source.decided_by` (task 5, fix round finding 4). */
describe("validateFactsFile — decided_by is a closed set", () => {
  test("a value outside owner/driver is rejected with a named issue", () => {
    const doc = {
      version: 1,
      facts: [{
        id: "F001", fact: "x", area: "billing", repos: [], kind: "observed", confidence: "measured",
        source: {
          who: "alan", when: "2026-09-06T09:00:00Z", run: null, q: null, decided_by: "bogus",
        },
        supersedes: null, superseded_by: null, retired: null,
      }],
    };
    const outcome = validateFactsFile(doc);
    expect(outcome.ok).toBe(false);
    expect(outcome.issues).toContainEqual({
      path: "facts[0].source.decided_by",
      message: "expected owner, driver or absent",
    });
  });
});

/**
 * `--repo` is validated against `workspace.yml`, the same way `tldrx answer --repo`
 * already was (#186).
 *
 * The two commands write the same field on the same record through the same store,
 * and only one of them looked at what the workspace declares: `facts add --repo
 * ghost` exited 0 and wrote `repos: [ghost]`, while `answer --repo ghost` exited 1
 * and named the declared repos. A fact scoped to a repo that does not exist is not
 * a loud failure — it is invisible to every `renderFacts` filter keyed on the real
 * name, forever, with nothing anywhere saying why.
 *
 * The refusal is exit 1 (`EXIT_USAGE`, spec §3's "usage/schema error") because that
 * is the family `answer`'s already lives in — one condition, one family (AGENTS §7).
 */
describe("facts add --repo is checked against workspace.yml", () => {
  test("a repo the workspace never declared is refused, and nothing is written", async () => {
    const ws = makeWorkspace();

    const err = captureStderr();
    const code = await factsCommand.run([
      "add", "ghost repo test", "--area", "test", "--decided-by", "driver",
      "--repo", "ghost", "--root", ws.root,
    ]);
    const text = err();

    expect(code).toBe(EXIT_USAGE);
    expect(text).toContain("tldrx facts add: --repo ghost is not a repo in this workspace — it has api, lab");
    // Refused BEFORE the store is opened: the fixture ships an empty facts file, so
    // "nothing was written" is "still zero facts", not "no file".
    expect(FactsStore.load(factsFileOf(ws)).facts).toHaveLength(0);
  });

  test("the refusal names the empty case instead of dangling", async () => {
    const ws = makeWorkspace();
    writeFileSync(
      join(ws.root, ".tldrx", "workspace.yml"),
      "version: 1\nmode: multi-repo\nroot_is_repo: false\nrepos: []\n",
      "utf8",
    );

    const err = captureStderr();
    const code = await factsCommand.run([
      "add", "ghost repo test", "--area", "test", "--decided-by", "driver",
      "--repo", "api", "--root", ws.root,
    ]);
    const text = err();

    expect(code).toBe(EXIT_USAGE);
    expect(text).toContain(
      "tldrx facts add: --repo api is not a repo in this workspace — this workspace declares no repos",
    );
  });

  test("a declared repo still records, and naming it twice scopes it once", async () => {
    const ws = makeWorkspace();

    const printed = capture();
    const code = await factsCommand.run([
      "add", "The outbox lives in api.", "--area", "billing", "--decided-by", "owner",
      "--repo", "api", "--repo", "api", "--root", ws.root,
    ]);
    printed();

    expect(code).toBe(0);
    // `uniqueRepos` is the ONE de-duplication of a fact's `repos` (`reposFromAffects.ts`),
    // and this command producing `[api, api]` while `answer --repo api --repo api`
    // produced `[api]` was the same scoping spelled two ways depending on its source.
    expect(FactsStore.load(factsFileOf(ws)).facts[0]?.repos).toEqual(["api"]);
  });
});

/**
 * The §7 shape check: ONE implementation of "is this a declared repo?".
 *
 * The ask on #186 was explicitly not "copy `answer.ts:71-81` into `facts.ts`" —
 * two copies of a refusal sentence drift, and the drift is silent because each
 * command's own test still passes. The sentence is the observable fingerprint of
 * the derivation, so it is counted over `src/` rather than asserted from the leaf
 * that produced it.
 */
describe("the declared-repo check has one implementation", () => {
  /** Every `.ts` under `dir`, recursively — the walk `test/source-hygiene.test.ts` uses. */
  function sourceFiles(dir: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) found.push(...sourceFiles(path));
      else if (entry.name.endsWith(".ts")) found.push(path);
    }
    return found;
  }

  test("the refusal sentence is written in exactly one file under src/", () => {
    const srcRoot = join(import.meta.dir, "..", "src");
    const carriers = sourceFiles(srcRoot)
      .filter((path) => readFileSync(path, "utf8").includes("is not a repo in this workspace"))
      .map((path) => path.slice(srcRoot.length + 1))
      .sort();
    expect(carriers).toEqual(["cli/repoScope.ts"]);
  });
});
