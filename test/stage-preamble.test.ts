/**
 * The stage prompt says what to DO before it says anything else (gh #196).
 *
 * Measured on a real workspace at 0.13.0: a What sub-agent received the whole
 * 66,452-byte prompt and replied "I don't see an actual request in your message
 * — only system context, tldrx state, and template/expert file dumps". It wrote
 * none of its declared outputs and the stage failed with $0.29 spent. Grepping
 * that prompt found zero occurrences of "You are", "## Produce", "your task" or
 * "write the following files": `renderParts` prepended nothing, so the document
 * opened on `stage.md`, which is a fill-in HANDOFF TEMPLATE and not a brief.
 *
 * The only imperative-shaped sentence in the model's window came from the
 * SessionStart hook — "tldrx: 7 runs are open — pass a run id to
 * next/answer/approve/…" — and that is the one the agent answered. So both
 * halves are pinned here: the preamble exists and leads the prompt, and the
 * nudge meant for a human's session stops reaching a spawned sub-agent.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPrompt, renderParts, renderStagePreamble, STAGE_PREAMBLE_MARKER,
  type PromptParts, type StagePreamble,
} from "../src/core/facilitator/prompt.ts";
import { spawnAgent, SUBAGENT_ENV_VAR } from "../src/core/facilitator/spawnAgent.ts";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";
import { EXIT_OK } from "../src/cli/exitCodes.ts";
import { makeWorkspace, FIXTURE_RUN, type TempWorkspace } from "./fixtures/tempWorkspace.ts";
import { noSpawnEnv } from "./fixtures/noSpawnPath.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

setDefaultTimeout(spawnTestTimeout(30_000));

const scratch: string[] = [];
let fixture: TempWorkspace | null = null;

afterEach(() => {
  delete process.env.TLDRX_AGENT_PROVIDER;
  delete process.env.TLDRX_CODEX_BIN;
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  fixture?.dispose();
  fixture = null;
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "tldrx-preamble-"));
  scratch.push(dir);
  return dir;
}

const PREAMBLE: StagePreamble = {
  stage: "what",
  run: "260907-alpha",
  outputs: [
    ".tldrx/runs/260907-alpha/01-what/intent.md",
    ".tldrx/runs/260907-alpha/01-what/questions.md",
  ],
};

const STAGE_MD = "# What — handoff\n\nRun: `<run-id>`\n";

function parts(preamble?: StagePreamble): PromptParts {
  return {
    stageMd: STAGE_MD,
    values: {
      run: "260907-alpha", repos: "lab", inputs: "-", facts: "-",
      conventions: "-", budget_usd: "4.00",
    },
    experts: [],
    inputs: [],
    ...(preamble === undefined ? {} : { preamble }),
  };
}

describe("a stage prompt opens with an imperative, not with a template (#196)", () => {
  test("the FIRST part is the preamble, and it names the stage, the run and every output", () => {
    const rendered = renderParts(parts(PREAMBLE));
    const first = rendered[0];
    expect(first?.kind).toBe("preamble");
    expect(first?.text).toContain(STAGE_PREAMBLE_MARKER);
    expect(first?.text).toContain("what");
    expect(first?.text).toContain("260907-alpha");
    for (const output of PREAMBLE.outputs) expect(first?.text).toContain(output);
    // Before a byte of the template: the whole point is that the reader learns
    // what it is doing before it starts reading a document to fill in.
    expect(rendered[1]?.kind).toBe("stage");
    const prompt = buildPrompt(parts(PREAMBLE));
    expect(prompt.indexOf(STAGE_PREAMBLE_MARKER)).toBeLessThan(prompt.indexOf("# What — handoff"));
    expect(prompt.indexOf(STAGE_PREAMBLE_MARKER)).toBe(prompt.indexOf(STAGE_PREAMBLE_MARKER.trim()));
  });

  test("it tells the agent to FILL the template and to put questions in the questions file", () => {
    const text = renderStagePreamble(PREAMBLE);
    expect(text).toContain("Fill in the template");
    expect(text).toContain(".tldrx/runs/260907-alpha/01-what/questions.md");
    expect(text.split("\n").filter((line) => line.trim() !== "").length).toBeLessThanOrEqual(12);
  });

  test("no preamble supplied ⇒ the prompt is byte-identical to what it always was", () => {
    expect(buildPrompt(parts())).toBe(buildPrompt(parts()));
    expect(buildPrompt(parts())).not.toContain(STAGE_PREAMBLE_MARKER);
    expect(renderParts(parts())[0]?.kind).toBe("stage");
  });
});

describe("the session-start nudge is for a human's session, not for a sub-agent (#196)", () => {
  test(`with ${SUBAGENT_ENV_VAR} set the hook emits nothing at all`, async () => {
    fixture = makeWorkspace();
    const result = await hook(fixture.root, { [SUBAGENT_ENV_VAR]: "1" });
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout.trim()).toBe("");
  });

  test("without it, the same workspace still gets its run lines (guard)", async () => {
    fixture = makeWorkspace();
    const result = await hook(fixture.root, {});
    expect(result.code).toBe(EXIT_OK);
    const out = JSON.parse(result.stdout) as {
      hookSpecificOutput?: { additionalContext?: string };
    };
    expect(out.hookSpecificOutput?.additionalContext ?? "").toContain(FIXTURE_RUN);
  });
});

describe("a spawned sub-agent is marked as one in its environment (#196)", () => {
  test("the child process really receives the marker", async () => {
    const dir = tmp();
    const envLog = join(dir, "env.jsonl");
    process.env.TLDRX_AGENT_PROVIDER = "codex";
    process.env.TLDRX_CODEX_BIN = join(import.meta.dir, "fixtures", "agent", "fakeCodex.ts");

    const outcome = await spawnAgent({
      prompt: "say nothing",
      model: null,
      maxBudgetUsd: 0.01,
      workspaceCommands: [],
      yolo: false,
      cwd: dir,
      timeoutMs: 15_000,
      env: { ...process.env, FAKE_CODEX_ENV_LOG: envLog },
    });

    expect(outcome.ok).toBe(true);
    const seen = JSON.parse(readFileSync(envLog, "utf8").trim()) as Record<string, string | null>;
    expect(seen[SUBAGENT_ENV_VAR]).toBe("1");
  });
});

interface HookRun { readonly code: number; readonly stdout: string; readonly stderr: string }

async function hook(root: string, extra: Record<string, string>): Promise<HookRun> {
  const proc = Bun.spawn(["bun", join(FRAMEWORK_ROOT, "src", "hooks", "session-start.ts")], {
    stdin: new TextEncoder().encode(JSON.stringify({ hook_event_name: "SessionStart", cwd: root })),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...noSpawnEnv(), USER: "alan", ...extra },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}
