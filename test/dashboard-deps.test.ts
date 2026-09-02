/**
 * The dashboard and the CLI, told to agree.
 *
 * `test/fixtures/chain/workspace` holds seven runs — a fresh one nobody has
 * touched, one parked at a gate, one holding open questions, one that failed,
 * one that finished, and two that were proposed to follow a sibling — wired into
 * two dependency chains. Both screens read the same folder, so any disagreement
 * is a bug in one of them.
 *
 * It covers five of the nine waiting kinds, not all nine, and the test below
 * now says which four it misses instead of claiming otherwise. That claim was
 * not free: `prepared` and `running` went unrendered because a test a few lines
 * from here said every kind was covered.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { buildModel, clientRenderer, dashMain } from "../src/core/dashboard/index.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { WAITING_KINDS } from "../src/core/run/waiting.ts";
import { whatIsWaiting } from "../src/core/run/runStatus.ts";
import { listRunDirs } from "../src/hooks/lib/workspace.ts";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";

export const CHAIN_FIXTURE = join(FRAMEWORK_ROOT, "test", "fixtures", "chain", "workspace");
const GENERATED_AT = "2026-09-03T12:00:00Z";
const NOW = new Date("2026-09-03T12:00:00Z");

const model = buildModel(CHAIN_FIXTURE, GENERATED_AT, { now: NOW });

/** The field names a designer targets, as a flat list of dotted paths. */
function fieldPaths(value: unknown, prefix = ""): readonly string[] {
  if (Array.isArray(value)) {
    return [...new Set(value.flatMap((item) => fieldPaths(item, `${prefix}[]`)))];
  }
  if (typeof value !== "object" || value === null) return [prefix];
  const out: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out.push(...fieldPaths(child, prefix === "" ? key : `${prefix}.${key}`));
  }
  return [...new Set(out)];
}

/** `tldrx run status`'s own answer, run by run, straight off the same files. */
function cliWaiting(): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const dir of listRunDirs(CHAIN_FIXTURE)) {
    const store = RunStore.open(dir);
    out.set(store.run.run, whatIsWaiting(store.run, store.runDir).kind);
  }
  return out;
}

describe("the dashboard never disagrees with `tldrx run status`", () => {
  test("the fixture's coverage is stated, and the gap is named rather than implied", () => {
    const covered = new Set<string>(model.runs.map((run) => run.waiting.kind));
    expect([...covered].sort()).toEqual(["answer", "done", "failed", "gate", "ready"]);
    expect(model.runs).toHaveLength(7);

    // The four this fixture cannot hold: `blocked` needs a broken cursor,
    // `running` needs a live pid, `prepared` needs a bundle on disk, `cancelled`
    // needs a run somebody closed. They are covered in
    // `test/dashboard-vocabulary.test.ts` against fixtures built for them.
    // Asserted against WAITING_KINDS so a TENTH kind fails here — which is
    // the only thing that would have caught `prepared` going unrendered.
    const missing = WAITING_KINDS.filter((kind) => !covered.has(kind));
    expect([...missing].sort()).toEqual(["blocked", "cancelled", "prepared", "running"]);
  });

  test("`waiting.kind` matches the CLI for every run, including a fresh one", () => {
    const cli = cliWaiting();
    const dashboard = new Map(model.runs.map((run) => [run.id, run.waiting.kind]));
    expect(Object.fromEntries(dashboard)).toEqual(Object.fromEntries(cli));
  });

  test("`waiting.message` is the CLI's message, not a second wording", () => {
    for (const dir of listRunDirs(CHAIN_FIXTURE)) {
      const store = RunStore.open(dir);
      const run = model.runs.find((candidate) => candidate.id === store.run.run);
      expect(run?.waiting.message).toBe(whatIsWaiting(store.run, store.runDir).message);
    }
  });

  /**
   * The bug this wave exists for. A run created a minute ago has `gate.status:
   * pending` on every stage, because that is the value the field is born with.
   * The old model read the first of those as "the gate this run is waiting on"
   * and drew a red card; the CLI said `ready`.
   */
  test("a run nobody has started is ready, not waiting at a gate", () => {
    const fresh = model.runs.find((run) => run.id === "260903-alpha");
    expect(fresh?.waiting.kind).toBe("ready");
    expect(fresh?.waiting.message).toContain("next up: 01-what/what (pending)");
    expect(fresh?.pendingGate).toBeNull();
    expect(fresh?.pendingQuestion).toBeNull();
    // Every one of its gates still reads `pending` on disk — that is the point.
    expect(fresh?.path.every((stage) => stage.gate === "approve: pending")).toBe(true);
  });

  test("the run holding open questions names them; the one at a gate names the stage", () => {
    const asked = model.runs.find((run) => run.id === "260903-delta");
    expect(asked?.waiting.kind).toBe("answer");
    expect(asked?.waiting.questions).toEqual(["Q1", "Q2"]);
    expect(asked?.pendingQuestion).toBe("Q1 · How far back does the retention window reach?");
    expect(asked?.pendingGate).toBeNull();

    const gated = model.runs.find((run) => run.id === "260903-charlie");
    expect(gated?.waiting.kind).toBe("gate");
    expect(gated?.pendingGate).toBe("what");
    expect(gated?.pendingQuestion).toBeNull();
  });

  test("a failed run says so, with the reason the task recorded", () => {
    const failed = model.runs.find((run) => run.id === "260903-echo");
    expect(failed?.waiting.kind).toBe("failed");
    expect(failed?.waiting.message).toContain("checks: npm test exited 1");
  });
});

describe("dependencies, order and chains", () => {
  test("the full field contract, over a workspace that exercises every array", () => {
    // The `views` fixture cannot carry these four: empty arrays contribute no
    // path. Between the two lists, every field a designer targets is named.
    const paths = new Set(fieldPaths(model));
    for (const field of [
      "chains[][]", "order[]",
      "runs[].dependsOn[]", "runs[].blockedBy[]", "runs[].runnable", "runs[].started",
      "runs[].waiting.kind", "runs[].waiting.message", "runs[].waiting.questions[]",
      "runs[].path[].gatePolicy", "runs[].path[].gateBy",
    ]) {
      expect(paths).toContain(field);
    }
  });

  test("`depends_on` slugs resolve to run ids, and only `done` releases one", () => {
    const byId = new Map(model.runs.map((run) => [run.id, run]));
    // bravo was proposed to follow alpha, which is `pending`: still blocked.
    expect(byId.get("260903-bravo")?.dependsOn).toEqual(["260903-alpha"]);
    expect(byId.get("260903-bravo")?.blockedBy).toEqual(["260903-alpha"]);
    expect(byId.get("260903-bravo")?.runnable).toBe(false);
    // golf follows foxtrot, which IS `done`: it depends on it and is free.
    expect(byId.get("260903-golf")?.dependsOn).toEqual(["260903-foxtrot"]);
    expect(byId.get("260903-golf")?.blockedBy).toEqual([]);
    expect(byId.get("260903-golf")?.runnable).toBe(true);
  });

  /**
   * #60. charlie is `awaiting_gate` and was proposed to follow bravo, which is
   * still `pending` — so it is the shape the issue is about: a run that HAS run a
   * stage, sitting at a gate a person can sign right now, behind a sibling that
   * was only ever PROPOSED to come first.
   *
   * This used to assert `runnable: false`, on the reasoning that a gate you
   * cannot reach yet is not the thing to go and sign. The reasoning does not
   * survive the evidence: charlie HAS reached its gate. `depends_on` is a
   * proposal a split wrote, not an enforcement, so it cannot make a signature
   * unreachable after the fact. `blockedBy` still records the proposal — that is
   * a true statement about the split — and `started` is what says it no longer
   * holds anything back.
   */
  test("a started run outranks the order it was proposed to follow (#60)", () => {
    const gated = model.runs.find((run) => run.id === "260903-charlie");
    expect(gated?.waiting.kind).toBe("gate");
    expect(gated?.started).toBe(true);
    expect(gated?.blockedBy).toEqual(["260903-bravo"]);
    expect(gated?.runnable).toBe(true);
    // …and the run that has NOT started is still held by it.
    const notStarted = model.runs.find((run) => run.id === "260903-bravo");
    expect(notStarted?.started).toBe(false);
    expect(notStarted?.runnable).toBe(false);
  });

  test("`runnable` needs BOTH nothing that still blocks and something a human can do", () => {
    const finished = model.runs.find((run) => run.id === "260903-foxtrot");
    expect(finished?.blockedBy).toEqual([]);
    expect(finished?.waiting.kind).toBe("done");
    // Started, unblocked — and still not runnable, because `done` is not a move.
    expect(finished?.started).toBe(true);
    expect(finished?.runnable).toBe(false);
  });

  test("order is topological, runnable first, then newest-updated", () => {
    expect(model.order).toEqual([
      "260903-alpha",    // runnable, newest of the three that are
      "260903-delta",    // runnable, next newest
      "260903-echo",     // runnable, oldest of the three
      "260903-bravo",    // released by alpha, but still not runnable
      "260903-charlie",  // released by bravo
      "260903-foxtrot",  // done, so never runnable
      "260903-golf",     // has to follow foxtrot in the reading order
    ]);
    // Every dependency is placed before the run that names it.
    for (const run of model.runs) {
      for (const id of run.dependsOn) {
        expect(model.order.indexOf(id)).toBeLessThan(model.order.indexOf(run.id));
      }
    }
  });

  test("chains are real dependency paths, one per branch, singletons omitted", () => {
    expect(model.chains).toEqual([
      ["260903-alpha", "260903-bravo", "260903-charlie"],
      ["260903-foxtrot", "260903-golf"],
    ]);
    // delta and echo depend on nothing and nothing depends on them.
    expect(model.chains.flat()).not.toContain("260903-delta");
    expect(model.chains.flat()).not.toContain("260903-echo");
  });
});

describe("what the chain workspace draws", () => {
  const ui = { status: "all", sort: "order" };
  const nowMs = NOW.getTime();
  const runs = dashMain(model, ui, { view: "runs", id: null }, nowMs);

  test("the attention summary mirrors `tldrx status`, counts disjoint", () => {
    // 2 ready (alpha, golf), 1 blocked (bravo — the only one that has not
    // started), 3 waiting on a human (delta at a question, echo failed, and
    // charlie at the gate it has actually reached), and foxtrot is done.
    // 2 + 1 + 3 + 1 = 7. charlie moved from `blocked` to `waiting on you` with
    // #60: it was counted behind a sibling it had already overtaken.
    expect(runs).toContain("2 runs ready");
    expect(runs).toContain("<code class=\"attn__cmd\">tldrx next 260903-alpha</code>");
    expect(runs).toContain("1 blocked");
    expect(runs).toContain("3 waiting on you");
  });

  test("the dependency chain block renders both chains as text", () => {
    expect(runs).toContain("<h2>Dependency chain</h2>");
    expect(runs).toContain(">alpha</a>");
    expect(runs).toContain(">bravo</a>");
    expect(runs).toContain(">charlie</a>");
    // A finished run is ticked; the run to pick up now is highlighted.
    expect(runs).toContain('data-st="done" href="#/run/260903-foxtrot">&#10003; foxtrot</a>');
    expect(runs).toContain('data-st="active" href="#/run/260903-alpha">alpha</a>');
    // Slugs, because slugs are what `depends_on` proposed.
    expect(runs).not.toContain(">260903-alpha</a>");
  });

  test("the WAITING ON column says what a NOT-STARTED run is behind (#60)", () => {
    // bravo has not started, so the proposal still holds it and the cell says so.
    expect(runs).toContain("blocked by alpha");
    // charlie has, so its own gate is the cell and the proposal is the note
    // beside it. "blocked by bravo" was the false claim #60 was filed about, and
    // suppressing its alert card hid the one signature a person could give.
    expect(runs).not.toContain("blocked by bravo");
    expect(runs).toContain("stage what is waiting at a gate");
    expect(runs).toContain("proposed to follow bravo — started anyway");
    expect(runs).toContain('href="#/run/260903-charlie">Ship it</a>');
  });

  test("a fresh run reads as ready, with the command that starts it", () => {
    expect(runs).toContain("ready — <code>tldrx next 260903-alpha</code>");
  });

  test("the first runnable run wears the ← next marker, and only it", () => {
    expect(runs).toContain('<span class="runrow__next">&larr; next</span>');
    expect(runs.split('class="runrow__next"')).toHaveLength(2);
    const marker = runs.indexOf('class="runrow__next"');
    const alpha = runs.indexOf("260903-alpha", runs.indexOf('class="runrow"'));
    expect(alpha).toBeLessThan(marker);
  });

  test("ORDER is a sort chip, and the default one", () => {
    expect(runs).toContain('data-sort="order" aria-pressed="true"');
    expect(runs).toContain('data-sort="updated" aria-pressed="false"');
    // The list follows it: alpha before delta before echo before bravo.
    const at = (id: string): number => runs.indexOf(`<div class="runrow__id">${id}`);
    expect(at("260903-alpha")).toBeLessThan(at("260903-delta"));
    expect(at("260903-delta")).toBeLessThan(at("260903-echo"));
    expect(at("260903-echo")).toBeLessThan(at("260903-bravo"));
  });

  test("a workspace with no dependencies draws no chain block", () => {
    const flat = { ...model, chains: [] };
    expect(dashMain(flat, ui, { view: "runs", id: null }, nowMs))
      .not.toContain("<h2>Dependency chain</h2>");
  });
});

describe("who signs each gate", () => {
  test("every stage carries its policy, absence reading as `human`", () => {
    // The fixture's runs declare `gates_policy: {what: human, how: auto}`.
    const stages = model.runs.find((run) => run.id === "260903-foxtrot")?.path ?? [];
    expect(stages.map((stage) => `${stage.id}:${stage.gatePolicy}`))
      .toEqual(["what:human", "how:auto"]);
    // `views` declares no policy at all, so every stage there reads `human`.
    const views = buildModel(
      join(FRAMEWORK_ROOT, "test", "fixtures", "views", "workspace"),
      GENERATED_AT, { now: NOW },
    );
    expect(views.runs[0]?.path.every((stage) => stage.gatePolicy === "human")).toBe(true);
  });

  test("the execution path draws the policy and who actually signed", () => {
    const detail = dashMain(model, { status: "all", sort: "order" },
      { view: "run", id: "260903-foxtrot" }, NOW.getTime());
    expect(detail).toContain("<th>signed by</th>");
    expect(detail).toContain("run.yml order · 1 human, 1 auto");
    // A gate a person signed and one the facilitator closed no longer look alike.
    expect(detail).toContain('<span class="tag">human</span> <span class="signer">by alan</span>');
    expect(detail).toContain('<span class="tag">auto</span> <span class="signer">by auto</span>');
  });

  test("an unsigned gate shows the policy alone, not an empty cell", () => {
    const detail = dashMain(model, { status: "all", sort: "order" },
      { view: "run", id: "260903-alpha" }, NOW.getTime());
    expect(detail).toContain('<span class="tag">human</span></td>');
    expect(detail).not.toContain('class="signer"');
  });
});

/**
 * The serialised renderer, over the chain workspace.
 *
 * `dashboard-render.test.ts` already proves the two copies agree — but only over
 * the `views` fixture, whose one run has no dependencies, so `dashChains` returns
 * early there and its body never reaches the empty scope. A new closure-free
 * function is exactly the thing that looks fine in TypeScript and throws a
 * `ReferenceError` in a browser, so it gets a workspace that walks its whole body.
 */
describe("the serialised renderer draws the chain workspace too", () => {
  test("byte-identical to the typed original, evaluated in an empty scope", () => {
    const factory = new Function(
      `${clientRenderer()}\n return { dashMain: dashMain };`,
    ) as () => { dashMain: (m: unknown, u: unknown, r: unknown, n: number) => string };
    const client = factory();
    const wire: unknown = JSON.parse(JSON.stringify(model));
    for (const ui of [{ status: "all", sort: "order" }, { status: "all", sort: "updated" }]) {
      const route = { view: "runs", id: null };
      expect(client.dashMain(wire, ui, route, NOW.getTime()))
        .toBe(dashMain(model, ui, route, NOW.getTime()));
    }
    const detail = { view: "run", id: "260903-foxtrot" };
    expect(client.dashMain(wire, { status: "all", sort: "order" }, detail, NOW.getTime()))
      .toBe(dashMain(model, { status: "all", sort: "order" }, detail, NOW.getTime()));
  });
});
