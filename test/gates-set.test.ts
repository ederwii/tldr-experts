/**
 * `tldrx run gates set <stage>:<policy> --note "…"` — the signed upgrade path for
 * a run's frozen `gates_policy` (issue #14).
 *
 * The gap: `gates_policy` is resolved at `run new` and frozen into `run.yml`
 * (`core/run/gatePolicy.ts` — "a run therefore keeps the policy it was opened
 * with"). Found during the 2026-08-30/31 unattended pilots: a run created before
 * the `agent` policy existed can never use `approve --as-agent`, and the files are
 * hand-edit-forbidden by design (spec §1), so there was no way to say so at all.
 *
 * This verb is modelled on `story reopen`, which is the other place a person
 * overrules the state the machine is holding: it REQUIRES a `--note`, it records
 * the actor, the moment, the note and the old→new value in one event, and it
 * moves nothing else. The tests below are mostly about what it REFUSES, because a
 * policy upgrade that could happen by accident would be the one gate mutation
 * nobody would ever notice.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";
import { parseYaml } from "../src/core/yaml.ts";
import { validateEvent } from "../src/core/events/Event.ts";
import { validateRunFile, type RunFile } from "../src/core/run/RunFile.ts";
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

async function oneRun(): Promise<{ root: string; runDir: string; runId: string }> {
  workspace = makeRunWorkspace();
  const root = workspace.root;
  const created = await tldrx(root, "run", "new", "leaderboard", "--title", "Player leaderboard");
  expect(created.code).toBe(EXIT_OK);
  const runId = /created tldrx-work\/([^\s]+) /.exec(created.stdout)?.[1] ?? "";
  expect(runId).not.toBe("");
  return { root, runDir: join(root, "tldrx-work", runId), runId };
}

function run(runDir: string): RunFile {
  const doc = parseYaml(readFileSync(join(runDir, "run.yml"), "utf8"));
  expect(validateRunFile(doc).issues).toEqual([]);
  return doc as RunFile;
}

function events(runDir: string): Record<string, unknown>[] {
  const path = join(runDir, "events.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function policyEvents(runDir: string): Record<string, unknown>[] {
  return events(runDir).filter((event) => event.type === "gate.policy_changed");
}

const WHY = "this run predates the agent policy and the pilot signs its plan gates with evidence";

describe("tldrx run gates set", () => {
  test("upgrades one stage's policy and records the change with its note", async () => {
    const { root, runDir, runId } = await oneRun();
    // `feature` freezes {what: human, how: auto, plan: human, build: auto, watch: human}.
    expect(run(runDir).gates_policy?.plan).toBe("human");

    const out = await tldrx(root, "run", "gates", "set", "plan:agent", "--note", WHY, "--run", runId);
    expect(out.stderr).toBe("");
    expect(out.code).toBe(EXIT_OK);
    expect(out.stdout).toContain("plan");
    expect(out.stdout).toContain("human");
    expect(out.stdout).toContain("agent");

    const after = run(runDir);
    expect(after.gates_policy?.plan).toBe("agent");
    // Only the named stage moves.
    expect(after.gates_policy?.what).toBe("human");
    expect(after.gates_policy?.how).toBe("auto");
    expect(after.gates_policy?.build).toBe("auto");
    expect(after.gates_policy?.watch).toBe("human");

    const recorded = policyEvents(runDir);
    expect(recorded.length).toBe(1);
    const event = recorded[0] as Record<string, unknown>;
    expect(validateEvent(event).issues).toEqual([]);
    expect(event.stage).toBe("plan");
    expect(event.cost_usd).toBe(0);
    expect(typeof event.actor).toBe("string");
    expect((event.actor as string).length).toBeGreaterThan(0);
    const payload = event.payload as Record<string, unknown>;
    expect(payload.from).toBe("human");
    expect(payload.to).toBe("agent");
    expect(payload.note).toBe(WHY);
    expect(payload.by).toBe(event.actor);
  });

  test("the new policy is what run status reports afterwards", async () => {
    const { root, runId } = await oneRun();
    expect((await tldrx(root, "run", "gates", "set", "plan:agent", "--note", WHY, "--run", runId)).code)
      .toBe(EXIT_OK);
    const status = await tldrx(root, "run", "status", runId, "--json");
    const view = JSON.parse(status.stdout) as { gates_policy: Record<string, string> };
    expect(view.gates_policy.plan).toBe("agent");
  });

  test("a downgrade to human is allowed and signed the same way", async () => {
    const { root, runDir, runId } = await oneRun();
    const out = await tldrx(
      root, "run", "gates", "set", "build:human", "--note", "the pilot wants to read every merge", "--run", runId,
    );
    expect(out.code).toBe(EXIT_OK);
    expect(run(runDir).gates_policy?.build).toBe("human");
    expect((policyEvents(runDir)[0]?.payload as Record<string, unknown>).from).toBe("auto");
  });

  test("refuses without --note, and writes nothing", async () => {
    const { root, runDir, runId } = await oneRun();
    const before = readFileSync(join(runDir, "run.yml"), "utf8");
    const out = await tldrx(root, "run", "gates", "set", "plan:agent", "--run", runId);
    expect(out.code).toBe(EXIT_GATE_REFUSED);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("--note");
    expect(readFileSync(join(runDir, "run.yml"), "utf8")).toBe(before);
    expect(policyEvents(runDir).length).toBe(0);
  });

  test("refuses a bare stage with no policy — `plan` alone is ambiguous here", async () => {
    const { root, runDir, runId } = await oneRun();
    const out = await tldrx(root, "run", "gates", "set", "plan", "--note", WHY, "--run", runId);
    expect(out.code).toBe(EXIT_GATE_REFUSED);
    expect(out.stderr).toContain("human");
    expect(out.stderr).toContain("agent");
    expect(policyEvents(runDir).length).toBe(0);
  });

  test("refuses an unknown stage and an unknown policy", async () => {
    const { root, runDir, runId } = await oneRun();
    const unknownStage = await tldrx(root, "run", "gates", "set", "nope:agent", "--note", WHY, "--run", runId);
    expect(unknownStage.code).toBe(EXIT_GATE_REFUSED);
    expect(unknownStage.stderr).toContain("nope");

    const unknownPolicy = await tldrx(root, "run", "gates", "set", "plan:sometimes", "--note", WHY, "--run", runId);
    expect(unknownPolicy.code).toBe(EXIT_GATE_REFUSED);
    expect(unknownPolicy.stderr).toContain("sometimes");

    expect(policyEvents(runDir).length).toBe(0);
    expect(run(runDir).gates_policy?.plan).toBe("human");
  });

  test("refuses a list — one signed decision per invocation", async () => {
    const { root, runDir, runId } = await oneRun();
    const out = await tldrx(root, "run", "gates", "set", "plan:agent,build:agent", "--note", WHY, "--run", runId);
    expect(out.code).toBe(EXIT_GATE_REFUSED);
    expect(policyEvents(runDir).length).toBe(0);
    expect(run(runDir).gates_policy?.plan).toBe("human");
  });

  test("refuses a no-op — a policy that is already set records nothing", async () => {
    const { root, runDir, runId } = await oneRun();
    const out = await tldrx(root, "run", "gates", "set", "plan:human", "--note", WHY, "--run", runId);
    expect(out.code).toBe(EXIT_GATE_REFUSED);
    expect(out.stderr).toContain("already");
    expect(policyEvents(runDir).length).toBe(0);
  });

  test("refuses an unknown run with exit 3", async () => {
    const { root } = await oneRun();
    const out = await tldrx(root, "run", "gates", "set", "plan:agent", "--note", WHY, "--run", "260101-nope");
    expect(out.code).toBe(EXIT_NOT_FOUND);
    expect(out.stdout).toBe("");
  });

  test("`run gates` with no subcommand is a usage error", async () => {
    const { root } = await oneRun();
    const out = await tldrx(root, "run", "gates");
    expect(out.code).toBe(EXIT_USAGE);
    expect(out.stderr).toContain("set");
  });

  test("the change is narrated by replay", async () => {
    const { root, runId } = await oneRun();
    expect((await tldrx(root, "run", "gates", "set", "plan:agent", "--note", WHY, "--run", runId)).code)
      .toBe(EXIT_OK);
    const replay = await tldrx(root, "replay", runId);
    expect(replay.code).toBe(EXIT_OK);
    expect(replay.stdout).toContain(WHY);
    expect(replay.stdout).toContain("agent");
  });
});
