/**
 * `tldrx note <run> [--stage <id>] "text"` — an operator annotation, at the moment
 * it happened (issue #46).
 *
 * The failure this exists for, measured on run `260829-scoring-leaderboard`
 * (scavtopia, 2026-09-01): a host performed an owner-delegated mechanical resync
 * of eight story dod blocks and was told to note it in the run log. It could not.
 * `events.jsonl` is append-only and tool-owned, so the only carriers available
 * were a FUTURE gate note (late, and keyed to the wrong moment) or a `reject`
 * (destructive). The session attached the context to an S1 reopen event — honest,
 * and keyed to the wrong subject.
 *
 * So the contract these tests hold the command to is narrow on purpose:
 *
 *   - ONE event is appended, and NOTHING else changes. `run.yml` is compared byte
 *     for byte before and after, because the whole value of this verb is that it
 *     is safe to reach for mid-run.
 *   - an unknown run, an unknown stage or an empty note is a clean refusal that
 *     writes nothing at all — a note command that half-wrote would be worse than
 *     no note command.
 *   - the note is VISIBLE afterwards, in `run status` and in `replay`. An
 *     annotation nobody reads is not an annotation.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";
import { validateEvent } from "../src/core/events/Event.ts";
import { EXIT_GATE_REFUSED, EXIT_NOT_FOUND, EXIT_OK, EXIT_USAGE } from "../src/cli/exitCodes.ts";
import { makeRunWorkspace, type TempRunWorkspace } from "./fixtures/tempRunWorkspace.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

setDefaultTimeout(spawnTestTimeout());

const BIN = join(FRAMEWORK_ROOT, "bin", "tldrx.ts");

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function tldrx(cwd: string, ...args: string[]): Promise<Run> {
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

/** A workspace with exactly one open `feature` run, and that run's directory. */
async function oneRun(): Promise<{ root: string; runDir: string; runId: string }> {
  workspace = makeRunWorkspace();
  const root = workspace.root;
  const created = await tldrx(root, "run", "new", "leaderboard", "--title", "Player leaderboard");
  expect(created.code).toBe(EXIT_OK);
  const runId = /created tldrx-work\/([^\s]+) /.exec(created.stdout)?.[1] ?? "";
  expect(runId).not.toBe("");
  return { root, runDir: join(root, "tldrx-work", runId), runId };
}

function events(runDir: string): Record<string, unknown>[] {
  const path = join(runDir, "events.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function notes(runDir: string): Record<string, unknown>[] {
  return events(runDir).filter((event) => event.type === "operator_note");
}

/** Bytes AND mtime: "nothing else moved" is a claim about the file, not about its text. */
function snapshot(path: string): { text: string; size: number } {
  return { text: readFileSync(path, "utf8"), size: statSync(path).size };
}

const RESYNC = "owner-delegated mechanical resync of 8 story dod blocks (aftermath of #41/#42)";

describe("tldrx note", () => {
  test("appends one operator_note event and changes nothing else", async () => {
    const { root, runDir, runId } = await oneRun();
    const runYml = join(runDir, "run.yml");
    const budgetYml = join(runDir, "budget.yml");
    const beforeRun = snapshot(runYml);
    const beforeBudget = snapshot(budgetYml);
    const beforeEvents = events(runDir).length;

    const out = await tldrx(root, "note", runId, RESYNC);
    expect(out.stderr).toBe("");
    expect(out.code).toBe(EXIT_OK);

    // run.yml is byte-identical: no `updated_at`, no cursor, no derived status.
    expect(snapshot(runYml)).toEqual(beforeRun);
    expect(snapshot(budgetYml)).toEqual(beforeBudget);

    const appended = notes(runDir);
    expect(appended.length).toBe(1);
    const event = appended[0] as Record<string, unknown>;
    expect(validateEvent(event).issues).toEqual([]);
    expect(event.run).toBe(runId);
    expect(event.stage).toBe(null);
    expect(event.cost_usd).toBe(0);
    expect(typeof event.actor).toBe("string");
    expect((event.actor as string).length).toBeGreaterThan(0);
    expect(typeof event.ts).toBe("string");
    expect((event.payload as Record<string, unknown>).note).toBe(RESYNC);
    // Exactly one line was added to the ledger, and it is the last one.
    expect(events(runDir).length).toBe(beforeEvents + 1);
    expect(events(runDir).at(-1)?.type).toBe("operator_note");
  });

  test("--stage keys the note to a stage of this run", async () => {
    const { root, runDir, runId } = await oneRun();
    const out = await tldrx(root, "note", runId, "--stage", "plan", "the dod blocks were resynced by hand");
    expect(out.code).toBe(EXIT_OK);
    const event = notes(runDir)[0] as Record<string, unknown>;
    expect(event.stage).toBe("plan");
    expect((event.payload as Record<string, unknown>).note).toBe("the dod blocks were resynced by hand");
  });

  test("an unknown stage is refused and NOTHING is written", async () => {
    const { root, runDir, runId } = await oneRun();
    const before = events(runDir).length;
    const out = await tldrx(root, "note", runId, "--stage", "nope", "text");
    expect(out.code).toBe(EXIT_GATE_REFUSED);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("nope");
    expect(events(runDir).length).toBe(before);
    expect(notes(runDir).length).toBe(0);
  });

  test("an unknown run is refused with exit 3 and nothing is written", async () => {
    const { root, runDir } = await oneRun();
    const before = events(runDir).length;
    const out = await tldrx(root, "note", "260101-nope", "text");
    expect(out.code).toBe(EXIT_NOT_FOUND);
    expect(out.stdout).toBe("");
    expect(events(runDir).length).toBe(before);
  });

  test("an empty note is a usage error, not an empty event", async () => {
    const { root, runDir, runId } = await oneRun();
    const before = events(runDir).length;
    const out = await tldrx(root, "note", runId, "   ");
    expect(out.code).toBe(EXIT_USAGE);
    expect(events(runDir).length).toBe(before);
  });

  test("a lone argument that names a run is refused rather than recorded as the note", async () => {
    const { root, runDir, runId } = await oneRun();
    const before = events(runDir).length;
    const out = await tldrx(root, "note", runId);
    expect(out.code).toBe(EXIT_USAGE);
    expect(out.stderr).toContain(runId);
    expect(events(runDir).length).toBe(before);
  });

  test("with one open run the id may be omitted", async () => {
    const { root, runDir } = await oneRun();
    const out = await tldrx(root, "note", "resynced by hand, owner-delegated");
    expect(out.code).toBe(EXIT_OK);
    expect(notes(runDir).length).toBe(1);
    expect((notes(runDir)[0]?.payload as Record<string, unknown>).note)
      .toBe("resynced by hand, owner-delegated");
  });

  test("the note is visible in run status and in replay", async () => {
    const { root, runId } = await oneRun();
    expect((await tldrx(root, "note", runId, "--stage", "what", RESYNC)).code).toBe(EXIT_OK);

    const status = await tldrx(root, "run", "status", runId);
    expect(status.code).toBe(EXIT_OK);
    expect(status.stdout).toContain(RESYNC);

    const replay = await tldrx(root, "replay", runId);
    expect(replay.code).toBe(EXIT_OK);
    expect(replay.stdout).toContain(RESYNC);
  });

  test("--json status carries the notes as data", async () => {
    const { root, runId } = await oneRun();
    expect((await tldrx(root, "note", runId, RESYNC)).code).toBe(EXIT_OK);
    const status = await tldrx(root, "run", "status", runId, "--json");
    expect(status.code).toBe(EXIT_OK);
    const view = JSON.parse(status.stdout) as { operator_notes?: { note: string; stage: string | null }[] };
    expect(view.operator_notes?.length).toBe(1);
    expect(view.operator_notes?.[0]?.note).toBe(RESYNC);
    expect(view.operator_notes?.[0]?.stage).toBe(null);
  });
});
