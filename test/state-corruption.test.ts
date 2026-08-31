/**
 * Free text goes into YAML, and comes back out the same.
 *
 * Measured 2026-08-31 on the live `260829-scoring-leaderboard` run:
 * `tldrx reject --note "<two paragraphs>"` wrote the note into `run.yml`'s gate
 * flow mapping with LITERAL newlines inside a double-quoted scalar. That is not
 * YAML — the `yaml` package said `Missing closing " quote at line 57`, Bun said
 * `Unexpected character` — and every subsequent command on the run failed. There
 * was no repair verb, so the operator hand-edited a file the docs forbid editing.
 * Then the next save re-emitted the same string and broke it again, at the same
 * line, taking the backup with it.
 *
 * Four things had to be true for that to stop, and each has tests here:
 *   1. the EMITTER escapes, every time, for every field (`yamlScalar`);
 *   2. `emit(load(x))` is STABLE, so a repaired file stays repaired;
 *   3. an already-broken file heals itself on load rather than needing a hand;
 *   4. when a file is beyond mechanical repair, the error says so honestly — and
 *      a reader of MANY runs (the dashboard) survives one of them being broken.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRun } from "../src/core/run/newRun.ts";
import { RunStore, RunStoreError } from "../src/core/run/RunStore.ts";
import { approve, reject } from "../src/core/run/gates.ts";
import { cancelRun } from "../src/core/run/rescue.ts";
import { buildStatus, renderStatus } from "../src/core/run/runStatus.ts";
import { emitRunYaml } from "../src/core/run/emitRunYaml.ts";
import { yamlScalar } from "../src/core/facts/emitFactsYaml.ts";
import { FactsStore } from "../src/core/facts/FactsStore.ts";
import { parseYaml, parseYamlRepairing, rejoinBrokenQuotedScalars } from "../src/core/yaml.ts";
import { backupPathFor } from "../src/core/fs/writeAtomic.ts";
import { EventLog } from "../src/core/events/EventLog.ts";
import { validateEvent } from "../src/core/events/Event.ts";
import type { TldrxEvent } from "../src/core/events/Event.ts";
import { buildModel } from "../src/core/dashboard/index.ts";
import { dashUnreadable } from "../src/core/dashboard/render.ts";
import { listRuns } from "../src/core/replay/index.ts";
import { listRunDirs } from "../src/hooks/lib/workspace.ts";
import { makeRunWorkspace, type TempRunWorkspace } from "./fixtures/tempRunWorkspace.ts";
import { cannedHandoff } from "./fixtures/facilitator/workspace.ts";

/**
 * The shape that broke the live run, plus every other character class that could
 * break a double-quoted scalar: a blank line, an embedded quote, a Windows path
 * of backslashes, a tab, a CR, a `#` that could start a comment, and the `}`
 * that would close the flow mapping early.
 */
const NASTY_NOTE = [
  'The clue is wrong. It says "go north" but the anchor is south.',
  "",
  "Three things to fix:",
  "\t- the path C:\\Users\\alan\\temp\\x is windows-only",
  "\t- the } brace and the # hash both used to end the mapping early",
  "\t- a trailing CR\r",
].join("\n");

const NOW = new Date("2026-08-31T09:00:00Z");
let workspaces: TempRunWorkspace[] = [];

afterEach(() => {
  for (const ws of workspaces) ws.dispose();
  workspaces = [];
});

function workspace(): TempRunWorkspace {
  const made = makeRunWorkspace();
  workspaces.push(made);
  return made;
}

/** A run whose first stage is sitting at its gate, ready to be signed or sent back. */
function runAtGate(root: string, slug: string): RunStore {
  const runId = createRun({ root, slug, scope: "feature", actor: "alan", now: NOW }).runId;
  const store = RunStore.find(root, runId)!;
  store.mutate((run) => ({
    ...run,
    phases: run.phases.map((phase, i) => (i === 0
      ? {
        ...phase,
        stages: phase.stages.map((stage, j) => (j === 0
          ? { ...stage, status: "awaiting_gate" as const }
          : stage)),
      }
      : phase)),
  }));
  return store;
}

/** The gate note of the first stage, as it is on disk right now. */
function noteOnDisk(root: string, runId: string): string {
  return RunStore.find(root, runId)!.run.phases[0]!.stages[0]!.gate.note;
}

// ---------------------------------------------------------------------------
// 1. The emitter escapes — every write site of operator text
// ---------------------------------------------------------------------------

describe("operator text survives the round trip into run.yml", () => {
  test("reject --note: newlines, quotes, backslashes and tabs come back verbatim", () => {
    const ws = workspace();
    const store = runAtGate(ws.root, "rejected");
    // `reject` saves for itself — a second save here would put the NEW version
    // in the backup instead of the one it replaced.
    reject(store, { root: ws.root, actor: "alan", at: "2026-08-31T09:01:00Z", note: NASTY_NOTE });

    // The whole point: the next command can read the file at all.
    const reopened = RunStore.find(ws.root, store.runId);
    expect(reopened).not.toBeNull();
    expect(noteOnDisk(ws.root, store.runId)).toBe(NASTY_NOTE);

    // And the note is ONE line of YAML, not a scalar torn across six.
    const raw = readFileSync(join(store.runDir, "run.yml"), "utf8");
    expect(raw.split("\n").filter((line) => line.includes("status: rejected"))).toHaveLength(1);
    expect(raw).not.toContain("go north\" but");

    // `tldrx run status` renders rather than throwing.
    const view = buildStatus(reopened!.run, reopened!.budget, reopened!.runDir);
    expect(renderStatus(view)).toContain(store.runId);
  });

  test("approve --note: the same note on the other verb", async () => {
    const ws = workspace();
    const store = runAtGate(ws.root, "approved");
    // The stage's `claim-sources` check reads the handoff it declared, so it has
    // to be on disk before the gate can be signed at all.
    mkdirSync(join(store.runDir, "01-what"), { recursive: true });
    writeFileSync(join(store.runDir, "01-what", "handoff.md"), cannedHandoff(), "utf8");

    const outcome = await approve(store, {
      root: ws.root, actor: "alan", at: "2026-08-31T09:01:00Z", note: NASTY_NOTE,
    });
    expect(outcome.ok).toBe(true);
    store.save();

    expect(RunStore.find(ws.root, store.runId)).not.toBeNull();
    expect(noteOnDisk(ws.root, store.runId)).toBe(NASTY_NOTE);
  });

  test("run cancel --note: cancellation reasons are free text too", () => {
    const ws = workspace();
    const store = runAtGate(ws.root, "cancelled");
    store.save();

    const outcome = cancelRun({
      root: ws.root, runId: store.runId, force: false, actor: "alan",
      at: "2026-08-31T09:05:00Z", note: NASTY_NOTE,
    });
    expect(outcome.code).toBe(0);

    const reopened = RunStore.find(ws.root, store.runId);
    expect(reopened).not.toBeNull();
    expect(reopened!.run.cancelled?.note).toBe(NASTY_NOTE);
  });

  test("a task error string — written by an agent, never by a person", () => {
    const ws = workspace();
    const store = runAtGate(ws.root, "errored");
    const error = `sub-agent failed:\n  stderr: "boom"\n  cwd: C:\\work\\api\n`;
    store.mutate((run) => ({
      ...run,
      phases: run.phases.map((phase, i) => (i === 0
        ? {
          ...phase,
          stages: phase.stages.map((stage, j) => (j === 0
            ? {
              ...stage,
              tasks: [{
                id: "t1", status: "failed" as const, expert: "product", model: "sonnet",
                cost_usd: 0.01, error, session_id: null,
                started_at: "2026-08-31T09:00:00Z", ended_at: "2026-08-31T09:00:10Z",
                outputs: [],
              }],
            }
            : stage)),
        }
        : phase)),
    }));
    store.save();

    const reopened = RunStore.find(ws.root, store.runId);
    expect(reopened).not.toBeNull();
    expect(reopened!.run.phases[0]!.stages[0]!.tasks[0]!.error).toBe(error);
  });

  test("facts.yml takes the same escaping — one helper, every file", () => {
    const ws = workspace();
    const path = join(ws.root, ".tldrx", "memory", "facts.yml");
    const text = `The API returns 200 with a ProblemDetails body.\n\nCheck \`data.id\` first — a "success" is not one.`;
    FactsStore.update(path, (store) => store.append({
      fact: text, area: "api", repos: ["api"], kind: "observed", confidence: "measured",
      source: { who: "alan", when: "2026-08-31T09:00:00Z", run: "260831-facts", q: null },
    }));
    expect(FactsStore.load(path).facts[0]!.fact).toBe(text);
  });

  test("story reopen --note lands in events.jsonl, and JSON keeps it whole", () => {
    const ws = workspace();
    const store = runAtGate(ws.root, "reopened");
    store.save();
    const event: TldrxEvent = {
      ts: "2026-08-31T09:02:00Z", run: store.runId, stage: "04-build",
      type: "story.reopened", actor: "alan", cost_usd: 0,
      payload: {
        phase: "04-build", story: "S1", wave: "W1",
        from_status: "blocked", to_status: "pending", verdicts: 2, note: NASTY_NOTE,
      },
    } as unknown as TldrxEvent;
    expect(validateEvent(event).ok).toBe(true);
    store.append(event);

    const read = new EventLog(join(store.runDir, "events.jsonl")).readAll();
    const reopen = read.events.filter((e) => e.type === "story.reopened")[0];
    expect((reopen?.payload as { note?: string } | undefined)?.note).toBe(NASTY_NOTE);
  });
});

describe("yamlScalar is the one helper, and it does not churn existing files", () => {
  test("plain scalars stay unquoted, so run.yml stays readable", () => {
    expect(yamlScalar("awaiting_gate")).toBe("awaiting_gate");
    expect(yamlScalar("product")).toBe("product");
    expect(yamlScalar("handoff.md")).toBe("handoff.md");
    // A leading digit is not plain-safe (a run id, a phase) — quoted, as before.
    expect(yamlScalar("260831-scoring")).toBe('"260831-scoring"');
    expect(yamlScalar(null)).toBe("null");
    expect(yamlScalar(7)).toBe("7");
  });

  test("anything a plain scalar cannot hold is quoted, and parses back", () => {
    for (const value of ["", "true", "0.30", "a: b", "has space", "#hash", "{brace}"]) {
      const doc = parseYaml(`gate: {note: ${yamlScalar(value)}}`) as { gate: { note: string } };
      expect(doc.gate.note).toBe(value);
    }
  });

  test("control characters are escaped rather than written raw", () => {
    const emitted = yamlScalar("a\nb\tc\rd");
    expect(emitted).not.toContain("\n");
    expect(emitted).toBe('"a\\nb\\tc\\rd"');
  });

  /**
   * The old escaping only handled `\` and `"`. For every value that contains
   * NEITHER a control character NOR a lone surrogate, the new one must produce
   * the same bytes — otherwise upgrading tldrx would rewrite every state file in
   * the workspace and fill a diff with changes nobody made.
   */
  test("byte-identical to the old escaping for every value that was already valid", () => {
    const old = (v: string): string => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    let differed = 0;
    for (let cp = 0x20; cp <= 0xffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const value = `a${String.fromCodePoint(cp)}"b\\c`;
      if (yamlScalar(value) !== old(value)) differed++;
    }
    expect(differed).toBe(0);
  });

  test("a lone surrogate becomes U+FFFD instead of an escape Bun's parser rejects", () => {
    const doc = parseYaml(`gate: {note: ${yamlScalar("bad\uD800end")}}`) as { gate: { note: string } };
    expect(doc.gate.note).toBe("bad\uFFFDend");
  });
});

// ---------------------------------------------------------------------------
// 2. emit(load(x)) is stable
// ---------------------------------------------------------------------------

describe("emit(load(x)) is stable — a repaired file stays repaired", () => {
  test("save → load → save → load leaves the note and the bytes identical", () => {
    const ws = workspace();
    const store = runAtGate(ws.root, "stable");
    // `reject` saves for itself — a second save here would put the NEW version
    // in the backup instead of the one it replaced.
    reject(store, { root: ws.root, actor: "alan", at: "2026-08-31T09:01:00Z", note: NASTY_NOTE });
    const path = join(store.runDir, "run.yml");
    const first = readFileSync(path, "utf8");

    // A second store loads it and writes it straight back out.
    const second = RunStore.find(ws.root, store.runId)!;
    expect(second.run.phases[0]!.stages[0]!.gate.note).toBe(NASTY_NOTE);
    expect(emitRunYaml(second.run)).toBe(first);

    // And a third pass through a real save changes nothing but `updated_at`.
    second.mutate((run) => run);
    second.save();
    const third = RunStore.find(ws.root, store.runId)!;
    expect(third.run.phases[0]!.stages[0]!.gate.note).toBe(NASTY_NOTE);
    // Nothing needed repairing on the way in: the file was always valid YAML.
    expect(parseYamlRepairing(readFileSync(path, "utf8")).repaired).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. An already-broken file heals itself
// ---------------------------------------------------------------------------

/** Re-emit `run.yml` the way the pre-0.3.2 emitter did: no escaping past `\` and `"`. */
function corruptNoteOnDisk(runDir: string, note: string): void {
  const path = join(runDir, "run.yml");
  const oldScalar = `"${note.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const text = readFileSync(path, "utf8").replace(
    /note: "(?:[^"\\]|\\.)*"\}/,
    `note: ${oldScalar}}`,
  );
  writeFileSync(path, text, "utf8");
}

describe("a run.yml broken by the old emitter heals on load", () => {
  test("the note comes back whole and the file is rewritten correctly", () => {
    const ws = workspace();
    const store = runAtGate(ws.root, "healed");
    // `reject` saves for itself — a second save here would put the NEW version
    // in the backup instead of the one it replaced.
    reject(store, { root: ws.root, actor: "alan", at: "2026-08-31T09:01:00Z", note: NASTY_NOTE });

    corruptNoteOnDisk(store.runDir, NASTY_NOTE);
    const path = join(store.runDir, "run.yml");
    expect(() => parseYaml(readFileSync(path, "utf8"))).toThrow();

    // Opening it works, and recovers the note exactly.
    const healed = RunStore.find(ws.root, store.runId);
    expect(healed).not.toBeNull();
    expect(healed!.run.phases[0]!.stages[0]!.gate.note).toBe(NASTY_NOTE);

    // The file on disk is fixed too, so the next reader pays nothing.
    expect(() => parseYaml(readFileSync(path, "utf8"))).not.toThrow();
    expect(noteOnDisk(ws.root, store.runId)).toBe(NASTY_NOTE);
  });

  test("the repair declines a healthy file and never rewrites one", () => {
    const ws = workspace();
    const store = runAtGate(ws.root, "healthy");
    store.save();
    const text = readFileSync(join(store.runDir, "run.yml"), "utf8");
    expect(rejoinBrokenQuotedScalars(text)).toBeNull();
    expect(parseYamlRepairing(text).repaired).toBe(false);
  });

  test("a file broken some OTHER way still throws the parser's original words", () => {
    expect(() => parseYamlRepairing("a: [1, 2\nb: }{\n")).toThrow();
    // The repair must not invent a document out of nonsense.
    expect(rejoinBrokenQuotedScalars('a: "never closed\nb: 1\n')).toBeNull();
  });

  test("a comment or an apostrophe is not mistaken for an open scalar", () => {
    const text = ['# don\'t read this apostrophe as YAML', 'note: "one', 'two"', "ok: true", ""].join("\n");
    const parsed = parseYamlRepairing(text);
    expect(parsed.repaired).toBe(true);
    expect((parsed.doc as { note: string; ok: boolean }).note).toBe("one\ntwo");
    expect((parsed.doc as { note: string; ok: boolean }).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Honest failure, and a backup to fail back to
// ---------------------------------------------------------------------------

describe("every save leaves one step back", () => {
  test("run.yml.bak appears after a save and holds the PREVIOUS version", () => {
    const ws = workspace();
    const store = runAtGate(ws.root, "backed-up");
    store.save();
    const path = join(store.runDir, "run.yml");
    const afterFirst = readFileSync(path, "utf8");

    const second = RunStore.find(ws.root, store.runId)!;
    reject(second, { root: ws.root, actor: "alan", at: "2026-08-31T09:05:00Z", note: "sent back" });

    const backup = backupPathFor(path);
    expect(existsSync(backup)).toBe(true);
    expect(readFileSync(backup, "utf8")).toBe(afterFirst);
    expect(readFileSync(path, "utf8")).not.toBe(afterFirst);
    expect(readFileSync(path, "utf8")).toContain("sent back");
    // budget.yml is written through the same path, so it gets one too.
    expect(existsSync(backupPathFor(join(store.runDir, "budget.yml")))).toBe(true);
  });

  test("a backup is never mistaken for a run", () => {
    const ws = workspace();
    const store = runAtGate(ws.root, "listed");
    store.save();
    store.mutate((run) => run);
    store.save();
    expect(existsSync(backupPathFor(join(store.runDir, "run.yml")))).toBe(true);

    // Both walkers key off the run FOLDER holding a `run.yml`, so a sibling
    // `run.yml.bak` — or a hand-made `run.yml.corrupt.bak` — is never live state.
    writeFileSync(join(store.runDir, "run.yml.corrupt.bak"), "not: [yaml\n", "utf8");
    expect(listRuns(ws.root)).toEqual([store.runId]);
    expect(listRunDirs(ws.root).map((d) => d.split("/").pop())).toEqual([store.runId]);
  });
});

describe("a run.yml beyond repair fails honestly", () => {
  /** Nothing mechanical can mend this: the flow mapping itself is malformed. */
  const BEYOND_REPAIR = "version: 1\nrun: x\nphases: [ {id: 01-what, stages: }{ ]\n";

  test("the message names the file, the parse error, and the manual .bak recovery", () => {
    const ws = workspace();
    const store = runAtGate(ws.root, "wrecked");
    store.save();
    store.mutate((run) => run);
    store.save(); // Two saves, so a .bak definitely exists.

    const path = join(store.runDir, "run.yml");
    writeFileSync(path, BEYOND_REPAIR, "utf8");

    let message = "";
    try {
      RunStore.find(ws.root, store.runId);
    } catch (error) {
      expect(error).toBeInstanceOf(RunStoreError);
      message = (error as Error).message;
    }
    expect(message).toContain(path);                       // the file
    expect(message).toContain("does not parse");
    expect(message.toLowerCase()).toContain("yaml");        // the parser's own words
    expect(message).toContain("run.yml.bak");               // the backup
    expect(message).toContain("MANUAL");                    // and that using it is on the operator
    expect(message).toContain("every tldrx command on this run reads that file first");
  });

  test("with no backup beside it, the message says so rather than pointing at nothing", () => {
    const ws = workspace();
    const runId = createRun({
      root: ws.root, slug: "nobak", scope: "feature", actor: "alan", now: NOW,
    }).runId;
    const dir = join(ws.root, "tldrx-work", runId);
    writeFileSync(join(dir, "run.yml"), BEYOND_REPAIR, "utf8");
    expect(existsSync(join(dir, "run.yml.bak"))).toBe(false);

    let message = "";
    try {
      RunStore.find(ws.root, runId);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("there is no run.yml.bak beside it");
    expect(message).toContain("no previous version to go back to");
  });
});

// ---------------------------------------------------------------------------
// 5. One broken run must not take the others down
// ---------------------------------------------------------------------------

describe("readers of MANY runs survive one that is broken", () => {
  test("the dashboard model keeps the good runs and names the bad one", () => {
    const ws = workspace();
    const good = runAtGate(ws.root, "good");
    good.save();
    const bad = runAtGate(ws.root, "bad");
    bad.save();
    writeFileSync(join(bad.runDir, "run.yml"), "phases: [ }{ ]\n", "utf8");

    // Before the fix this threw a raw YAMLParseError and killed the server.
    const model = buildModel(ws.root, "2026-08-31T09:10:00Z");
    expect(model.runs.map((run) => run.id)).toEqual([good.runId]);
    expect(model.unreadable.map((run) => run.id)).toEqual([bad.runId]);
    expect(model.unreadable[0]!.error.toLowerCase()).toContain("yaml");

    const html = dashUnreadable(model);
    expect(html).toContain(bad.runId);
    expect(html).toContain("unreadable");
    expect(html).toContain(`tldrx run status ${bad.runId}`);
  });

  test("a workspace whose ONLY run is broken still renders, and says why", () => {
    const ws = workspace();
    const bad = runAtGate(ws.root, "onlybad");
    bad.save();
    writeFileSync(join(bad.runDir, "run.yml"), "phases: [ }{ ]\n", "utf8");

    const model = buildModel(ws.root, "2026-08-31T09:10:00Z");
    expect(model.runs).toHaveLength(0);
    expect(model.unreadable).toHaveLength(1);
    expect(dashUnreadable(model)).toContain(bad.runId);
  });

  test("a corrupt run.yml the OLD emitter wrote is simply read, not reported", () => {
    const ws = workspace();
    const store = runAtGate(ws.root, "dashheal");
    // `reject` saves for itself — a second save here would put the NEW version
    // in the backup instead of the one it replaced.
    reject(store, { root: ws.root, actor: "alan", at: "2026-08-31T09:01:00Z", note: NASTY_NOTE });
    corruptNoteOnDisk(store.runDir, NASTY_NOTE);

    const model = buildModel(ws.root, "2026-08-31T09:10:00Z");
    expect(model.unreadable).toHaveLength(0);
    expect(model.runs.map((run) => run.id)).toEqual([store.runId]);
  });
});

describe("a heal that cannot land on disk still returns a usable store", () => {
  test("an unwritable run folder degrades to an in-memory repair, not a crash", () => {
    const ws = workspace();
    const store = runAtGate(ws.root, "readonly");
    reject(store, { root: ws.root, actor: "alan", at: "2026-08-31T09:01:00Z", note: NASTY_NOTE });
    corruptNoteOnDisk(store.runDir, NASTY_NOTE);

    // No new file can be created here, so `writeAtomic`'s temp write fails.
    chmodSync(store.runDir, 0o555);
    try {
      const healed = RunStore.find(ws.root, store.runId);
      expect(healed).not.toBeNull();
      expect(healed!.run.phases[0]!.stages[0]!.gate.note).toBe(NASTY_NOTE);
      // The file is still broken on disk — honestly, and without pretending otherwise.
      expect(() => parseYaml(readFileSync(join(store.runDir, "run.yml"), "utf8"))).toThrow();
    } finally {
      chmodSync(store.runDir, 0o755);
    }
  });
});
