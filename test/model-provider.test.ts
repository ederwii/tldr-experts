/**
 * `TLDRX_CLAUDE_BIN` — which binary the sub-agent spawn actually executes (#27).
 *
 * The minimal slice of the model-provider ask, and deliberately only that: one env var
 * that replaces the executable name, with the default unchanged. It exists so a sandbox,
 * a wrapper script or a pinned install can stand in for whatever is on PATH without
 * patching source. It is NOT a provider abstraction — the argv is still `claude`'s argv
 * (`-p --output-format stream-json --verbose --json-schema …`), so what it points at has
 * to speak that. #27 stays open for the real layer.
 *
 * What is asserted here is the thing that can silently rot: that the override reaches the
 * SPAWN, not merely a constant. A test that only read `claudeBin()` back would pass with
 * `runtime.spawn` still hardcoded — so the last test runs a real script and checks that
 * the script ran.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentProvider, claudeBin, CLAUDE_BIN, codexBin, CODEX_BIN, describeSpawn, spawnAgent,
  providerBudgetAdvisory, buildClaudeArgs, interpret,
} from "../src/core/facilitator/spawnAgent.ts";
import { REVIEW_SCHEMA } from "../src/core/build/prompts.ts";
import { parseReview } from "../src/core/build/review.ts";
import { codexPromptMarker } from "../src/core/facilitator/fakeTranscript.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

setDefaultTimeout(spawnTestTimeout(30_000));

const scratch: string[] = [];
afterEach(() => {
  delete process.env.TLDRX_CLAUDE_BIN;
  delete process.env.TLDRX_CODEX_BIN;
  delete process.env.TLDRX_AGENT_PROVIDER;
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the provider selection keeps Claude as the byte-identical default", () => {
  test("Codex receives a strict reviewer schema without changing Claude's optional fields", async () => {
    const dir = tmp();
    const schemaLog = join(dir, "schema.json");
    process.env.TLDRX_AGENT_PROVIDER = "codex";
    process.env.TLDRX_CODEX_BIN = join(import.meta.dir, "fixtures", "agent", "fakeCodex.ts");
    const before = JSON.stringify(REVIEW_SCHEMA);
    await spawnAgent({ ...request(dir), role: "reviewer", schema: REVIEW_SCHEMA,
      env: { ...process.env, FAKE_CODEX_SCHEMA_LOG: schemaLog } });
    const schema = JSON.parse(readFileSync(schemaLog, "utf8"));
    expect(schema.required).toEqual(["verdict", "summary", "findings", "fixlist"]);
    expect(schema.properties.fixlist.anyOf[1]).toEqual({ type: "null" });
    const item = schema.properties.fixlist.anyOf[0].items;
    expect(item.required).toEqual(["n", "severity", "finding", "where", "disposition", "detail", "do_not"]);
    expect(item.properties.n).toEqual({ anyOf: [{ type: "integer" }, { type: "null" }] });
    expect(item.properties.disposition).toEqual(REVIEW_SCHEMA.properties.fixlist.items.properties.disposition);
    expect(item.additionalProperties).toBe(false);
    expect(JSON.stringify(REVIEW_SCHEMA)).toBe(before);
    const claude = buildClaudeArgs({ ...request(dir), schema: REVIEW_SCHEMA });
    expect(claude[claude.indexOf("--json-schema") + 1]).toBe(before);
  });

  test("multiline Codex errors stay on one handoff line without losing the reason", () => {
    const raw = JSON.stringify({ type: "turn.failed", error: { message: "{\n  code: invalid_json_schema,\n  message: Missing n\n}" } });
    const outcome = interpret(1, raw, "", false, "codex");
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("invalid_json_schema");
    expect(outcome.error).toContain("Missing n");
    expect(outcome.error).not.toContain("\n");
  });

  test("nullable optional reviewer fields preserve approval and fail-closed fix-list parsing", () => {
    expect(parseReview({ verdict: "approve", summary: "checked", findings: [], fixlist: null }, "").verdict).toBe("approve");
    const review = parseReview({ verdict: "fixlist", summary: "one defect", findings: [], fixlist: [{
      n: null, severity: null, finding: "Missing test", where: null,
      disposition: "fix-now", detail: null, do_not: null,
    }] }, "");
    expect(review.verdict).toBe("fixlist");
    expect(review.fixlist[0]).toMatchObject({ n: 1, severity: "unrated", where: "", detail: "", doNot: [] });
    expect(parseReview({ verdict: "fixlist", summary: "empty", findings: [], fixlist: null }, "").verdict).toBe("changes");
  });

  test("unset selects Claude; codex is an explicit opt-in", () => {
    expect(agentProvider()).toBe("claude");
    process.env.TLDRX_AGENT_PROVIDER = "codex";
    expect(agentProvider()).toBe("codex");
  });

  test("an unknown provider is refused instead of silently spending through Claude", () => {
    process.env.TLDRX_AGENT_PROVIDER = "codxe";
    expect(() => agentProvider()).toThrow("TLDRX_AGENT_PROVIDER must be one of claude | codex");
  });

  test("the Codex binary has the same late-bound, trimmed override seam", () => {
    expect(codexBin()).toBe(CODEX_BIN);
    process.env.TLDRX_CODEX_BIN = "  /opt/wrappers/codex-via-proxy  ";
    expect(codexBin()).toBe("/opt/wrappers/codex-via-proxy");
    process.env.TLDRX_CODEX_BIN = "   ";
    expect(codexBin()).toBe("codex");
  });

  test("Codex dry-run uses plain exec, JSONL, schema file and workspace-write", () => {
    process.env.TLDRX_AGENT_PROVIDER = "codex";
    const shown = describeSpawn(request(tmp()));
    expect(shown).toStartWith("codex exec ");
    expect(shown).toContain("--ephemeral");
    expect(shown).toContain("--json");
    expect(shown).toContain("--color never");
    expect(shown).toContain("--output-schema '<output-schema.json>'");
    expect(shown).toContain("--sandbox workspace-write");
    expect(shown).not.toContain(" exec review ");
    expect(shown).not.toContain("--max-budget-usd");
  });

  test("reviewers get read-only while developer work remains workspace-write", () => {
    process.env.TLDRX_AGENT_PROVIDER = "codex";
    expect(describeSpawn({ ...request(tmp()), role: "reviewer" })).toContain("--sandbox read-only");
    expect(describeSpawn({ ...request(tmp()), role: "developer" })).toContain("--sandbox workspace-write");
  });

  test("configured Codex effort uses the CLI's config override", () => {
    process.env.TLDRX_AGENT_PROVIDER = "codex";
    expect(describeSpawn({ ...request(tmp()), effort: "low" })).toContain(
      "--config 'model_reasoning_effort=\"low\"'",
    );
  });

  test("the unsupported provider-side USD cap is warned, never presented as enforced", () => {
    expect(providerBudgetAdvisory("claude", 1.25)).toBeNull();
    expect(providerBudgetAdvisory("codex", 1.25)).toBe(
      "budget: Codex has no provider-side USD cap; $1.25 is a planning ceiling only, " +
      "and this turn will be recorded unmetered in dollars",
    );
  });

  test("Codex spawn executes a real stub and records the turn as unmetered", async () => {
    const dir = tmp();
    const argvLog = join(dir, "argv.jsonl");
    process.env.TLDRX_AGENT_PROVIDER = "codex";
    process.env.TLDRX_CODEX_BIN = join(import.meta.dir, "fixtures", "agent", "fakeCodex.ts");
    const outcome = await spawnAgent({
      ...request(dir),
      env: { ...process.env, FAKE_CODEX_ARGV_LOG: argvLog },
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.metered).toBe(false);
    expect(outcome.costUsd).toBe(0);
    expect(outcome.sessionId).toBe("01a06472-03bb-7ba3-abd2-820c96afe586");
    expect(outcome.envelope?.outputs).toEqual(["tiny.md"]);
    expect(outcome.usage.input_tokens).toBe(37682);
    expect(outcome.reads).toBe(1);

    const argv = JSON.parse(readFileSync(argvLog, "utf8").trim()) as string[];
    expect(argv[0]).toBe("exec");
    expect(argv).toContain("--json");
    expect(argv).toContain("workspace-write");
    const schemaPath = argv[argv.indexOf("--output-schema") + 1];
    expect(typeof schemaPath).toBe("string");
    expect(schemaPath).not.toBe("<output-schema.json>");
  });

  test("the prompt actually REACHES the Codex stub, and is not on the command line", async () => {
    const dir = tmp();
    const argvLog = join(dir, "argv.jsonl");
    process.env.TLDRX_AGENT_PROVIDER = "codex";
    process.env.TLDRX_CODEX_BIN = join(import.meta.dir, "fixtures", "agent", "fakeCodex.ts");
    const prompt = "name the line Outbox lives on, and nothing else";

    const outcome = await spawnAgent({
      ...request(dir),
      prompt,
      env: { ...process.env, FAKE_CODEX_ARGV_LOG: argvLog },
    });

    // `buildCodexArgs` emits no positional prompt and no `-`, so stdin is the
    // ONLY delivery path. Nothing pinned that: the fake read stdin and dropped
    // it, so cutting the stdin wiring, or adding a positional [PROMPT] the real
    // CLI would then take instead, left the suite green. The fake now echoes a
    // digest of what it received into the envelope the real parser returns, so
    // the assertion below fails if the prompt stops arriving.
    expect(outcome.ok).toBe(true);
    expect(outcome.envelope?.notes).toContain(codexPromptMarker(prompt));

    // The other half of the same contract: it must NOT travel as an argument.
    const argv = JSON.parse(readFileSync(argvLog, "utf8").trim()) as string[];
    expect(argv).not.toContain("-");
    expect(argv.filter((arg) => arg.includes(prompt))).toEqual([]);
  });
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "tldrx-bin-"));
  scratch.push(dir);
  return dir;
}

const request = (cwd: string) => ({
  prompt: "say nothing",
  model: null,
  maxBudgetUsd: 0.01,
  workspaceCommands: [],
  yolo: false,
  cwd,
  timeoutMs: 15_000,
});

describe("claudeBin() picks the executable", () => {
  test("unset, it is `claude` — the default nobody had to opt into", () => {
    delete process.env.TLDRX_CLAUDE_BIN;
    expect(claudeBin()).toBe("claude");
    expect(CLAUDE_BIN).toBe("claude");
  });

  test("set, it is what was set", () => {
    process.env.TLDRX_CLAUDE_BIN = "/opt/wrappers/claude-via-proxy";
    expect(claudeBin()).toBe("/opt/wrappers/claude-via-proxy");
  });

  test("blank or whitespace is not an override — an empty var means `unset`, not `run \"\"`", () => {
    for (const blank of ["", "   ", "\t\n"]) {
      process.env.TLDRX_CLAUDE_BIN = blank;
      expect(claudeBin()).toBe("claude");
    }
  });

  test("surrounding whitespace is trimmed, because a shell export usually has some", () => {
    process.env.TLDRX_CLAUDE_BIN = "  my-claude  ";
    expect(claudeBin()).toBe("my-claude");
  });
});

describe("the override reaches every place the CLI is named", () => {
  test("`--dry-run` prints the command that WOULD run, so it prints the override", () => {
    const dir = tmp();
    expect(describeSpawn(request(dir))).toStartWith("claude -p ");
    process.env.TLDRX_CLAUDE_BIN = "/opt/wrappers/claude-via-proxy";
    expect(describeSpawn(request(dir))).toStartWith("/opt/wrappers/claude-via-proxy -p ");
  });

  test("spawnAgent EXECUTES it — proven by the stand-in leaving a mark on disk", async () => {
    const dir = tmp();
    const marker = join(dir, "it-ran.txt");
    const stub = join(dir, "stub-claude");
    // Records that it ran, with its argv, then answers like a `claude -p` that produced
    // nothing useful. The outcome is irrelevant; the marker is the whole assertion.
    writeFileSync(stub, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > ${JSON.stringify(marker)}\ncat > /dev/null\nexit 0\n`);
    chmodSync(stub, 0o755);

    process.env.TLDRX_CLAUDE_BIN = stub;
    await spawnAgent({ ...request(dir), env: { ...process.env } });

    expect(existsSync(marker)).toBe(true);
    const argv = readFileSync(marker, "utf8").split("\n");
    expect(argv).toContain("-p");                 // still claude's argv, on purpose
    expect(argv).toContain("stream-json");
  });
});
