import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { FRAMEWORK_ROOT, PLUGIN_DIR } from "../src/core/paths.ts";
import { parseHookInput } from "../src/core/hooks/passthrough.ts";
import { parseQuestions } from "../src/core/text/questions.ts";
import { FactsStore } from "../src/core/facts/FactsStore.ts";
import { EventLog } from "../src/core/events/EventLog.ts";
import { makeWorkspace, FIXTURE_RUN, type TempWorkspace } from "./fixtures/tempWorkspace.ts";

const HOOKS = ["claim-sources", "no-reask", "answer-capture", "dod-gate", "budget-gate", "session-start"] as const;

interface HookRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** The decision a PreToolUse hook printed, or null when it allowed. */
function denial(run: HookRun): string | null {
  if (run.stdout.trim() === "") return null;
  const out = JSON.parse(run.stdout) as {
    hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
  };
  if (out.hookSpecificOutput?.permissionDecision !== "deny") return null;
  return out.hookSpecificOutput.permissionDecisionReason ?? "";
}

function context(run: HookRun): string | null {
  if (run.stdout.trim() === "") return null;
  const out = JSON.parse(run.stdout) as { hookSpecificOutput?: { additionalContext?: string } };
  return out.hookSpecificOutput?.additionalContext ?? null;
}

async function hook(name: string, payload: unknown): Promise<HookRun> {
  const proc = Bun.spawn(["bun", join(FRAMEWORK_ROOT, "src", "hooks", `${name}.ts`)], {
    stdin: new TextEncoder().encode(JSON.stringify(payload)),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, USER: "alan" },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

let ws: TempWorkspace | null = null;
function workspace(): TempWorkspace {
  ws ??= makeWorkspace();
  return ws;
}
afterEach(() => {
  ws?.dispose();
  ws = null;
});

function handoffPath(): string {
  return join(workspace().runDir, "02-how", "handoff.md");
}
function questionsPath(): string {
  return join(workspace().runDir, "02-how", "questions.md");
}
function storyPath(): string {
  return join(workspace().runDir, "03-plan", "stories", "S3.md");
}

const GOOD_HANDOFF = [
  "# Handoff — 02-how / contracts — run 260828-leaderboard",
  "",
  "## Findings",
  "- Hunt completion already emits a HuntCompleted domain event [src: api:src/Hunt.cs:8]",
  "",
  "## Decisions",
  "- Reads come from a materialised view [src: Q4]",
  "",
  "## Unknowns",
  "- Retention period for historical rankings [src: absent:.tldrx/memory/facts.yml]",
  "",
  "## Evidence ledger",
  "- Contract project builds clean [src: $ dotnet build → exit 0]",
  "",
].join("\n");

/** Three unsourced bullets, placed so the deny lands on L14, L22 and L31. */
const BAD_HANDOFF = [
  "# Handoff — 02-how / contracts — run 260828-leaderboard",
  "Stage: contracts · Expert: architect · Model: sonnet",
  "",
  "## Findings",
  "- Hunt completion already emits a HuntCompleted domain event [src: api:src/Hunt.cs:8]",
  "- The lab SDK is generated, so a DTO change is a two-repo change [src: F019]",
  "- Rank rows are keyed by player id [src: lab:src/rank.ts:2]",
  "",
  "## Decisions",
  "- Leaderboard reads come from a materialised view [src: Q4]",
  "- No new auth policy is needed [src: F019]",
  "- Reads are cached for 60 seconds [src: F019]",
  "- The view refreshes on HuntCompleted [src: Q4]",
  "- Ranking ties are broken by completion time",
  "",
  "## Unknowns",
  "- Retention period for historical rankings [src: absent:.tldrx/memory/facts.yml]",
  "- Whether mobile needs paging beyond top-50 [src: Q6]",
  "- Whether ranks are per tenant [src: Q5]",
  "- Whether the view can be materialised concurrently [src: Q6]",
  "- Whether the lab needs a new route [src: Q6]",
  "- Whether old seasons are archived",
  "",
  "## Evidence ledger",
  "- Contract project builds clean [src: $ dotnet build → exit 0]",
  "- Vendor rate limits confirmed [src: https://developers.example.com/limits]",
  "- Lab tests pass [src: $ npm run test → exit 0]",
  "- Hunt.cs compiles [src: api:src/Hunt.cs:1]",
  "- rank.ts exists [src: lab:src/rank.ts:1]",
  "- The API builds [src: $ dotnet build → exit 0]",
  "- Nothing else was run",
  "",
].join("\n");

const CLAIM_SOURCES_DENY =
  "[tldrx] claim-sources: 3 unsourced bullet(s) in tldrx-work/260828-leaderboard/02-how/handoff.md — L14, L22, L31.\n" +
  "Every bullet under Findings/Decisions/Unknowns/Evidence ledger must end with " +
  "[src: <repo:path:line> | https://… | Q<n> | F<n> | $ <cmd> → exit <n> | graph:<node> | absent:<path>]. " +
  "Add the source or delete the claim.";

describe("claim-sources (PreToolUse Write|Edit)", () => {
  test("allows a handoff whose every bullet is sourced", async () => {
    const run = await hook("claim-sources", {
      hook_event_name: "PreToolUse", tool_name: "Write",
      tool_input: { file_path: handoffPath(), content: GOOD_HANDOFF },
    });
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("");
  });

  test("denies unsourced bullets, naming every offending line", async () => {
    const run = await hook("claim-sources", {
      hook_event_name: "PreToolUse", tool_name: "Write",
      tool_input: { file_path: handoffPath(), content: BAD_HANDOFF },
    });
    expect(run.code).toBe(0);
    expect(denial(run)).toBe(CLAIM_SOURCES_DENY);
  });

  test("denies a file source that does not resolve", async () => {
    const run = await hook("claim-sources", {
      hook_event_name: "PreToolUse", tool_name: "Write",
      tool_input: {
        file_path: handoffPath(),
        content: GOOD_HANDOFF.replace("api:src/Hunt.cs:8", "api:src/Nope.cs:8"),
      },
    });
    expect(denial(run)).toBe(
      "[tldrx] claim-sources: 1 unresolvable source(s) in tldrx-work/260828-leaderboard/02-how/handoff.md.\n" +
      "L4: [src: api:src/Nope.cs:8] — no such file: src/Nope.cs\n" +
      "A cited file must exist with the line in range, a command must be one of workspace.yml's, and " +
      "`$ … → exit n` belongs only in the Evidence ledger. Fix the citation or delete the claim.",
    );
  });

  test("judges the would-be content of an Edit, not what is on disk", async () => {
    const path = handoffPath();
    writeFileSync(path, GOOD_HANDOFF, "utf8");
    const run = await hook("claim-sources", {
      hook_event_name: "PreToolUse", tool_name: "Edit",
      tool_input: {
        file_path: path,
        old_string: "- Reads come from a materialised view [src: Q4]",
        new_string: "- Reads come from a materialised view",
      },
    });
    expect(denial(run)).toContain("1 unsourced bullet(s)");
    expect(denial(run)).toContain("— L7.");
  });

  test("allows when old_string is absent — the Edit tool will fail on its own", async () => {
    writeFileSync(handoffPath(), GOOD_HANDOFF, "utf8");
    const run = await hook("claim-sources", {
      hook_event_name: "PreToolUse", tool_name: "Edit",
      tool_input: { file_path: handoffPath(), old_string: "nowhere in the file", new_string: "x" },
    });
    expect(run.stdout).toBe("");
  });

  test("ignores markdown under tldrx-work that is not a handoff", async () => {
    const run = await hook("claim-sources", {
      hook_event_name: "PreToolUse", tool_name: "Write",
      tool_input: {
        file_path: join(workspace().runDir, "02-how", "design.md"),
        content: "# Design\n\n## Notes\n- a bullet with no source at all\n",
      },
    });
    expect(run.stdout).toBe("");
  });

  test("ignores files outside tldrx-work", async () => {
    const run = await hook("claim-sources", {
      hook_event_name: "PreToolUse", tool_name: "Write",
      tool_input: { file_path: join(workspace().root, "notes.md"), content: BAD_HANDOFF },
    });
    expect(run.stdout).toBe("");
  });

  test("the PostToolUse twin reports instead of denying", async () => {
    const run = await hook("claim-sources", {
      hook_event_name: "PostToolUse", tool_name: "Write",
      tool_input: { file_path: handoffPath(), content: BAD_HANDOFF },
      tool_result: { success: true },
    });
    expect(denial(run)).toBeNull();
    expect(context(run)).toBe(CLAIM_SOURCES_DENY);
  });

  test("fails open on an internal error", async () => {
    // The Edit target is a directory: reading it throws EISDIR inside the hook.
    const dir = join(workspace().runDir, "02-how", "handoff.md");
    rmSync(dir, { force: true });
    mkdirSync(dir, { recursive: true });
    const run = await hook("claim-sources", {
      hook_event_name: "PreToolUse", tool_name: "Edit",
      tool_input: { file_path: dir, old_string: "a", new_string: "b" },
    });
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toStartWith("tldrx hook claim-sources: internal error, allowing — ");
  });
});

const RE_ASKED_TITLE = "Does the backend deploy via workflow dispatch, and does lab auto deploy on merge?";

function questionsWith(id: string, title: string, area: string): string {
  return [
    "# Questions — 02-how — run 260828-leaderboard",
    "",
    `## ${id} · ${title}`,
    `<!-- id: ${id} | status: open | area: ${area} | asked_by: architect | asked_at: 2026-08-28T14:02:11Z -->`,
    "Why asked: nothing in memory covers it [src: absent:.tldrx/memory/facts.yml]",
    "",
    "- A) yes",
    "- B) no",
    "",
    "[Answer]:",
    "",
  ].join("\n");
}

describe("no-re-ask (PreToolUse Write|Edit)", () => {
  test("allows a question nothing in facts.yml answers", async () => {
    const run = await hook("no-reask", {
      hook_event_name: "PreToolUse", tool_name: "Write",
      tool_input: {
        file_path: questionsPath(),
        content: questionsWith("Q7", "Where does leaderboard state live?", "data-model"),
      },
    });
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("");
  });

  test("denies a re-ask and names the fact", async () => {
    const run = await hook("no-reask", {
      hook_event_name: "PreToolUse", tool_name: "Write",
      tool_input: { file_path: questionsPath(), content: questionsWith("Q7", RE_ASKED_TITLE, "deploy") },
    });
    expect(denial(run)).toBe(
      `[tldrx] no-re-ask: Q7 "${RE_ASKED_TITLE}" is already answered by F019 (alan, 2026-08-14, run ` +
      '260814-envs): "Backend deploys run via deploy.yml…". Cite it as [src: F019] instead of asking.\n' +
      "If the fact is stale, set its `retired: {at, by, reason}` in .tldrx/memory/facts.yml first, " +
      "then re-write the question.",
    );
  });

  test("the same words in a different area are a different question", async () => {
    const run = await hook("no-reask", {
      hook_event_name: "PreToolUse", tool_name: "Write",
      tool_input: { file_path: questionsPath(), content: questionsWith("Q7", RE_ASKED_TITLE, "data-model") },
    });
    expect(run.stdout).toBe("");
  });

  test("a question already in the file is an edit, not an ask", async () => {
    const content = questionsWith("Q7", RE_ASKED_TITLE, "deploy");
    writeFileSync(questionsPath(), content, "utf8");
    const run = await hook("no-reask", {
      hook_event_name: "PreToolUse", tool_name: "Write",
      tool_input: { file_path: questionsPath(), content: `${content}\n<!-- a later edit -->\n` },
    });
    expect(run.stdout).toBe("");
  });

  test("a retired fact stops blocking", async () => {
    const path = join(workspace().root, ".tldrx", "memory", "facts.yml");
    const store = FactsStore.load(path);
    store.retire("F019", { at: "2026-08-29T00:00:00Z", by: "alan", reason: "stale" });
    store.save();
    const run = await hook("no-reask", {
      hook_event_name: "PreToolUse", tool_name: "Write",
      tool_input: { file_path: questionsPath(), content: questionsWith("Q7", RE_ASKED_TITLE, "deploy") },
    });
    expect(run.stdout).toBe("");
  });

  test("fails open when facts.yml cannot be read", async () => {
    writeFileSync(join(workspace().root, ".tldrx", "memory", "facts.yml"), "version: 1\nfacts: not-a-list\n", "utf8");
    const run = await hook("no-reask", {
      hook_event_name: "PreToolUse", tool_name: "Write",
      tool_input: { file_path: questionsPath(), content: questionsWith("Q7", RE_ASKED_TITLE, "deploy") },
    });
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toStartWith("tldrx hook no-reask: internal error, allowing — ");
  });
});

describe("answer-capture (PostToolUse + FileChanged)", () => {
  function answerQ4(): void {
    const path = questionsPath();
    writeFileSync(path, readFileSync(path, "utf8").replace("[Answer]:\n", "[Answer]: B) Redis sorted set\n"), "utf8");
  }

  test("records the answer, the fact and the event, and never blocks", async () => {
    answerQ4();
    const run = await hook("answer-capture", {
      hook_event_name: "PostToolUse", tool_name: "Edit",
      tool_input: { file_path: questionsPath(), old_string: "[Answer]:", new_string: "[Answer]: B) Redis sorted set" },
      tool_result: { success: true },
    });
    expect(run.code).toBe(0);
    expect(context(run)).toBe("tldrx: recorded Q4 → F020");
    expect(denial(run)).toBeNull();

    const doc = parseQuestions(readFileSync(questionsPath(), "utf8"));
    const q4 = doc.blocks.find((b) => b.id === "Q4");
    expect(q4?.metadata?.status).toBe("answered");
    expect(q4?.footer?.answered_by).toBe("alan");
    expect(q4?.footer?.fact).toBe("F020");
    expect(doc.blocks.find((b) => b.id === "Q5")?.footer?.fact).toBe("F021");

    const fact = FactsStore.load(join(workspace().root, ".tldrx", "memory", "facts.yml")).get("F020");
    expect(fact).toMatchObject({ kind: "answer", confidence: "stated", area: "data-model" });
    expect(fact?.source).toMatchObject({ who: "alan", run: FIXTURE_RUN, q: "Q4" });
    expect(fact?.fact).toContain("B) Redis sorted set");

    const events = EventLog.forRun(workspace().runDir).read();
    const answered = events.find((e) => e.type === "question.answered");
    expect(answered?.payload).toEqual({ q: "Q4", answer: "B) Redis sorted set", fact: "F020" });
    expect(events.some((e) => e.type === "fact.added")).toBe(true);
  });

  test("is idempotent — a second run finds nothing open", async () => {
    answerQ4();
    await hook("answer-capture", {
      hook_event_name: "PostToolUse", tool_name: "Write",
      tool_input: { file_path: questionsPath() },
    });
    const again = await hook("answer-capture", {
      hook_event_name: "PostToolUse", tool_name: "Write",
      tool_input: { file_path: questionsPath() },
    });
    expect(again.stdout).toBe("");
    expect(FactsStore.load(join(workspace().root, ".tldrx", "memory", "facts.yml")).facts).toHaveLength(3);
  });

  test("does nothing when no open block carries an answer", async () => {
    const run = await hook("answer-capture", {
      hook_event_name: "PostToolUse", tool_name: "Write",
      tool_input: { file_path: questionsPath() },
    });
    expect(run.stdout).toBe("");
  });

  test("fires on FileChanged, where the path is top level", async () => {
    answerQ4();
    const run = await hook("answer-capture", {
      hook_event_name: "FileChanged", file_path: questionsPath(),
    });
    expect(context(run)).toBe("tldrx: recorded Q4 → F020");
  });

  test("fails open on an unreadable facts.yml", async () => {
    answerQ4();
    writeFileSync(join(workspace().root, ".tldrx", "memory", "facts.yml"), "version: 1\nfacts: {}\n", "utf8");
    const run = await hook("answer-capture", {
      hook_event_name: "PostToolUse", tool_name: "Write",
      tool_input: { file_path: questionsPath() },
    });
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toStartWith("tldrx hook answer-capture: internal error, allowing — ");
  });
});

const FAILING_COMMAND =
  'echo "4 failing tests in src/features/leaderboard/__tests__/rank.test.ts" >&2; exit 1';

function story(status: string, commands: readonly string[] | null, repo = "lab"): string {
  const lines = [
    "# S3 · Leaderboard read model",
    "",
    `repo: ${repo}`,
    `status: ${status}`,
    "",
    "## Acceptance criteria",
    "- Top-50 ranks render from the materialised view [src: Q4]",
    "",
  ];
  if (commands !== null) lines.push("```dod", ...commands, "```", "");
  return lines.join("\n");
}

describe("DoD-gate (PreToolUse Write|Edit)", () => {
  test("allows a story that is not being marked done", async () => {
    const run = await hook("dod-gate", {
      hook_event_name: "PreToolUse", tool_name: "Write",
      tool_input: { file_path: storyPath(), content: story("in-progress", [FAILING_COMMAND]) },
    });
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("");
  });

  test("allows `done` when every dod command exits 0", async () => {
    const run = await hook("dod-gate", {
      hook_event_name: "PreToolUse", tool_name: "Write",
      tool_input: { file_path: storyPath(), content: story("done", ["echo dod-ok", "true"]) },
    });
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("");
  });

  test("denies `done` when a dod command fails, quoting the output tail", async () => {
    const run = await hook("dod-gate", {
      hook_event_name: "PreToolUse", tool_name: "Write",
      tool_input: { file_path: storyPath(), content: story("done", ["echo dod-ok", FAILING_COMMAND]) },
    });
    expect(denial(run)).toBe(
      `[tldrx] DoD-gate: story S3 cannot be marked done — \`${FAILING_COMMAND}\` in repo lab exited 1 (expected 0).\n` +
      "Command output tail: 4 failing tests in src/features/leaderboard/__tests__/rank.test.ts\n" +
      "Fix the code or the story's dod block; done means proven, not asserted.",
    );
  });

  test("denies `done` when the dod block is missing", async () => {
    const run = await hook("dod-gate", {
      hook_event_name: "PreToolUse", tool_name: "Write",
      tool_input: { file_path: storyPath(), content: story("done", null) },
    });
    expect(denial(run)).toBe(
      "[tldrx] DoD-gate: story S3 cannot be marked done — no fenced ```dod block in " +
      "tldrx-work/260828-leaderboard/03-plan/stories/S3.md.\n" +
      "Add the commands that prove it (test, lint, typecheck from map/commands.md) and let the gate re-run them; " +
      "done means proven, not asserted.",
    );
  });

  test("fails CLOSED: an internal error denies rather than allows", async () => {
    const run = await hook("dod-gate", {
      hook_event_name: "PreToolUse", tool_name: "Write",
      tool_input: { file_path: storyPath(), content: story("done", ["true"], "not-a-repo") },
    });
    expect(run.code).toBe(0);
    expect(denial(run)).toStartWith("[tldrx] DoD-gate: story S3 cannot be marked done — the gate itself failed:");
    expect(denial(run)).toEndWith("This gate fails closed: an unproven story stays not-done. Fix the gate's inputs and try again.");
  });

  test("ignores markdown that is not a story", async () => {
    const run = await hook("dod-gate", {
      hook_event_name: "PreToolUse", tool_name: "Write",
      tool_input: { file_path: handoffPath(), content: "status: done\n\n```dod\nfalse\n```\n" },
    });
    expect(run.stdout).toBe("");
  });

  test("times out a command that hangs, and denies", async () => {
    const run = await hook("dod-gate", {
      hook_event_name: "PreToolUse", tool_name: "Write",
      tool_input: { file_path: storyPath(), content: `timeout_s: 1\n${story("done", ["sleep 30"])}` },
    });
    expect(denial(run)).toContain("timed out after 1s");
  });
});

describe("budget-gate (PreToolUse Bash)", () => {
  test("allows a Bash command that is not a spawn", async () => {
    const run = await hook("budget-gate", {
      hook_event_name: "PreToolUse", tool_name: "Bash", cwd: workspace().root,
      tool_input: { command: "ls -la" },
    });
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("");
  });

  test("denies `tldrx next` when the phase cannot afford the stage", async () => {
    const run = await hook("budget-gate", {
      hook_event_name: "PreToolUse", tool_name: "Bash", cwd: workspace().root,
      tool_input: { command: "tldrx next 260828-leaderboard" },
    });
    expect(denial(run)).toBe(
      '[tldrx] budget-gate: refusing to start stage "contracts" — phase 02-how has $0.61 left of $7.00 and ' +
      "the stage estimate is $3.00. Raise phases[02-how].ceiling_usd in budget.yml, lower budget_usd in " +
      ".tldrx/stages/contracts/stage.yml, or set on_exceed: warn.",
    );
  });

  test("denies a `claude -p` spawn the same way, and records budget.blocked", async () => {
    const run = await hook("budget-gate", {
      hook_event_name: "PreToolUse", tool_name: "Bash", cwd: workspace().root,
      tool_input: { command: `claude -p --output-format json --run ${FIXTURE_RUN} < prompt.txt` },
    });
    expect(denial(run)).toContain('refusing to start stage "contracts"');
    const blocked = EventLog.forRun(workspace().runDir).read().filter((e) => e.type === "budget.blocked");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({ run: FIXTURE_RUN, stage: "contracts", actor: "hook:budget-gate", cost_usd: 0 });
    expect(blocked[0]?.payload).toMatchObject({ phase: "02-how", scope: "phase", estimate_usd: 3 });
  });

  test("allows when the phase can afford it", async () => {
    const path = join(workspace().runDir, "budget.yml");
    writeFileSync(path, readFileSync(path, "utf8").replace("spent_usd: 6.39", "spent_usd: 1.0"), "utf8");
    const run = await hook("budget-gate", {
      hook_event_name: "PreToolUse", tool_name: "Bash", cwd: workspace().root,
      tool_input: { command: "tldrx next" },
    });
    expect(run.stdout).toBe("");
  });

  test("allows when on_exceed is warn", async () => {
    const path = join(workspace().runDir, "budget.yml");
    writeFileSync(path, readFileSync(path, "utf8").replace("on_exceed: block", "on_exceed: warn"), "utf8");
    const run = await hook("budget-gate", {
      hook_event_name: "PreToolUse", tool_name: "Bash", cwd: workspace().root,
      tool_input: { command: "tldrx next" },
    });
    expect(run.stdout).toBe("");
  });

  test("fails open on an unreadable budget.yml", async () => {
    writeFileSync(join(workspace().runDir, "budget.yml"), "version: 1\nphases: 3\n", "utf8");
    const run = await hook("budget-gate", {
      hook_event_name: "PreToolUse", tool_name: "Bash", cwd: workspace().root,
      tool_input: { command: "tldrx next" },
    });
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toStartWith("tldrx hook budget-gate: internal error, allowing — ");
  });
});

describe("session-start (SessionStart)", () => {
  test("injects at most three lines about the newest non-terminal run", async () => {
    const run = await hook("session-start", {
      hook_event_name: "SessionStart", source: "startup", cwd: workspace().root,
    });
    expect(run.code).toBe(0);
    const lines = (context(run) ?? "").split("\n");
    expect(lines.length).toBeLessThanOrEqual(3);
    expect(lines[0]).toBe('tldrx: run 260828-leaderboard — "Player leaderboard" (feature) · awaiting_gate');
    expect(lines[1]).toBe("tldrx: at 02-how / contracts — architect · awaiting_gate");
    expect(lines[2]).toBe("tldrx: 1 open question (Q4) · gate pending: `tldrx approve`");
  });

  test("says nothing when there is no run", async () => {
    rmSync(join(workspace().root, "tldrx-work"), { recursive: true, force: true });
    const run = await hook("session-start", {
      hook_event_name: "SessionStart", source: "startup", cwd: workspace().root,
    });
    expect(run.stdout).toBe("");
  });

  test("says nothing outside a tldrx workspace", async () => {
    const run = await hook("session-start", { hook_event_name: "SessionStart", source: "startup", cwd: "/" });
    expect(run.stdout).toBe("");
  });

  test("says nothing when every run is terminal", async () => {
    const path = join(workspace().runDir, "run.yml");
    writeFileSync(path, readFileSync(path, "utf8").replace("status: awaiting_gate\ncursor", "status: done\ncursor"), "utf8");
    const run = await hook("session-start", {
      hook_event_name: "SessionStart", source: "startup", cwd: workspace().root,
    });
    expect(run.stdout).toBe("");
  });

  test("fails open on an internal error", async () => {
    rmSync(join(workspace().root, "tldrx-work"), { recursive: true, force: true });
    writeFileSync(join(workspace().root, "tldrx-work"), "not a directory", "utf8");
    const run = await hook("session-start", {
      hook_event_name: "SessionStart", source: "startup", cwd: workspace().root,
    });
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toStartWith("tldrx hook session-start: internal error, allowing — ");
  });
});

describe("every hook is safe to run with nothing to say", () => {
  for (const name of HOOKS) {
    test(`${name} allows on empty stdin`, async () => {
      const proc = Bun.spawn(["bun", join(FRAMEWORK_ROOT, "src", "hooks", `${name}.ts`)], {
        stdin: new TextEncoder().encode(""), stdout: "pipe", stderr: "pipe",
      });
      const stdout = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(0);
      expect(stdout).toBe("");
    });
  }
});

describe("parseHookInput", () => {
  const SAMPLE = JSON.stringify({
    session_id: "abc123", cwd: "/tmp", hook_event_name: "PostToolUse",
    tool_name: "Write", tool_input: { file_path: "/tmp/example.md" },
  });

  test("returns the payload for valid JSON", () => {
    expect(parseHookInput(SAMPLE)?.hook_event_name).toBe("PostToolUse");
  });

  test("returns null for empty or non-object input", () => {
    expect(parseHookInput("")).toBeNull();
    expect(parseHookInput("   ")).toBeNull();
    expect(parseHookInput("{broken")).toBeNull();
    expect(parseHookInput("[1,2]")).not.toBeNull(); // arrays are objects; shape checks live elsewhere
    expect(parseHookInput("42")).toBeNull();
  });
});

describe("plugin packaging", () => {
  test("the manifest lives at .claude-plugin/plugin.json and names the plugin", async () => {
    const manifest = (await Bun.file(join(PLUGIN_DIR, ".claude-plugin", "plugin.json")).json()) as {
      name: string; version: string; description: string;
    };
    expect(manifest.name).toBe("tldrx");
    expect(manifest.version).toBe("0.0.1");
    expect(manifest.description.length).toBeGreaterThan(0);
  });

  test("skills/, agents/ and hooks/ are at the plugin root, not inside .claude-plugin/", async () => {
    for (const dir of ["skills", "agents", "hooks"]) {
      expect(await Bun.file(join(PLUGIN_DIR, ".claude-plugin", dir, "x")).exists()).toBe(false);
    }
    expect(await Bun.file(join(PLUGIN_DIR, "skills", "tldrx", "SKILL.md")).exists()).toBe(true);
    expect(await Bun.file(join(PLUGIN_DIR, "hooks", "hooks.json")).exists()).toBe(true);
  });

  test("hooks.json is valid JSON and every handler points at a script that exists", async () => {
    const config = (await Bun.file(join(PLUGIN_DIR, "hooks", "hooks.json")).json()) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string; args?: string[]; timeout?: number }> }>>;
    };
    let handlers = 0;
    for (const entries of Object.values(config.hooks)) {
      for (const entry of entries) {
        for (const handler of entry.hooks) {
          handlers++;
          expect(handler.type).toBe("command");
          expect(handler.command).toBe("bun");
          const arg = handler.args?.[0] ?? "";
          expect(arg).toStartWith("${CLAUDE_PLUGIN_ROOT}/../src/hooks/");
          const resolved = join(PLUGIN_DIR, arg.replace("${CLAUDE_PLUGIN_ROOT}/", ""));
          expect(await Bun.file(resolved).exists()).toBe(true);
        }
      }
    }
    expect(handlers).toBe(8);
  });

  test("each hook is wired to the event the spec puts it on", async () => {
    const config = (await Bun.file(join(PLUGIN_DIR, "hooks", "hooks.json")).json()) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ args?: string[]; timeout?: number }> }>>;
    };
    const wiring = new Map<string, { event: string; matcher: string | undefined; timeout: number | undefined }[]>();
    for (const [event, entries] of Object.entries(config.hooks)) {
      for (const entry of entries) {
        for (const handler of entry.hooks) {
          const name = (handler.args?.[0] ?? "").split("/").pop()?.replace(".ts", "") ?? "";
          wiring.set(name, [...(wiring.get(name) ?? []), { event, matcher: entry.matcher, timeout: handler.timeout }]);
        }
      }
    }
    expect(wiring.get("claim-sources")).toEqual([
      { event: "PreToolUse", matcher: "Write|Edit", timeout: 15 },
      { event: "PostToolUse", matcher: "Write|Edit", timeout: 15 },
    ]);
    expect(wiring.get("no-reask")).toEqual([{ event: "PreToolUse", matcher: "Write|Edit", timeout: 15 }]);
    expect(wiring.get("answer-capture")).toEqual([
      { event: "PostToolUse", matcher: "Write|Edit", timeout: 15 },
      { event: "FileChanged", matcher: undefined, timeout: 15 },
    ]);
    expect(wiring.get("session-start")).toEqual([{ event: "SessionStart", matcher: undefined, timeout: 15 }]);
    expect(wiring.get("budget-gate")).toEqual([{ event: "PreToolUse", matcher: "Bash", timeout: 15 }]);
    // The DoD gate re-runs real test suites; its timeout must clear stage.yml's 900s default.
    const dod = wiring.get("dod-gate") ?? [];
    expect(dod).toHaveLength(1);
    expect(dod[0]?.event).toBe("PreToolUse");
    expect(dod[0]?.matcher).toBe("Write|Edit");
    expect(dod[0]?.timeout ?? 0).toBeGreaterThanOrEqual(900);
  });

  test("the facilitator skill is user-invoked only", async () => {
    const text = await Bun.file(join(PLUGIN_DIR, "skills", "tldrx", "SKILL.md")).text();
    expect(text).toStartWith("---\n");
    expect(text).toContain("disable-model-invocation: true");
  });
});
