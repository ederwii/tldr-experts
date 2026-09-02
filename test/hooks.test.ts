import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { FRAMEWORK_ROOT, PLUGIN_DIR } from "../src/core/paths.ts";
import { parseHookInput } from "../src/core/hooks/passthrough.ts";
import { parseQuestions } from "../src/core/text/questions.ts";
import { FactsStore } from "../src/core/facts/FactsStore.ts";
import { EventLog } from "../src/core/events/EventLog.ts";
import { makeWorkspace, FIXTURE_RUN, type TempWorkspace } from "./fixtures/tempWorkspace.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

// Every test in this file spawns a REAL process — git, `bun`, the CLI. Process cost is a
// property of the machine, not of the code, so bun's fixed 5000 ms default measures the box:
// on an untouched tree, tests here timed out while the same files passed alone (#43). The
// budget scales with measured load; the assertions are untouched, and a hang is still caught.
setDefaultTimeout(spawnTestTimeout());
const PKG_VERSION: string = JSON.parse(await Bun.file(new URL("../package.json", import.meta.url)).text()).version;

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

/** `denial`, but always a string — a null denial reports what the hook did print. */
function denialText(run: HookRun): string {
  return denial(run)
    ?? `no deny decision (exit ${run.code}) — stdout=${JSON.stringify(run.stdout)} stderr=${JSON.stringify(run.stderr)}`;
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
  "- Whether mobile needs paging beyond top-50 [src: Q4]",
  "- Whether ranks are per tenant [src: Q5]",
  "- Whether the view can be materialised concurrently [src: Q4]",
  "- Whether the lab needs a new route [src: Q4]",
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

/**
 * gh #77: the deny quotes each offending bullet and names the rule it broke.
 *
 * Naming L14 and nothing else asks the author to go and find L14, and then to
 * work out for themselves which of its characters the reader objected to — the
 * loop that cost run `260830-ordering-inventory` three story attempts.
 */
const CLAIM_SOURCES_DENY =
  "[tldrx] claim-sources: 3 unsourced bullet(s) in tldrx-work/260828-leaderboard/02-how/handoff.md — L14, L22, L31.\n" +
  "L14: - Ranking ties are broken by completion time\n" +
  "L22: - Whether old seasons are archived\n" +
  "L31: - Nothing else was run\n" +
  "Rule: every list item under Findings / Decisions / Unknowns / Evidence ledger ends with a " +
  "`[src: …]` token. The token goes at the END of the line: " +
  "[src: <repo:path:line> | https://… | Q<n> | F<n> | $ <cmd> → exit <n> | graph:<node> | absent:<path>].\n" +
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
      "L4: [src: api:src/Nope.cs:8] — no such file: src/Nope.cs — tried repo `api` (api)\n" +
      // gh #77: the line as written, so the author is not sent to go and read it.
      // No `rule` line here — a file that is not there breaks no GRAMMAR rule, and
      // the message already names the thing that was not found.
      "      you wrote: - Hunt completion already emits a HuntCompleted domain event [src: api:src/Nope.cs:8]\n" +
      "A cited file must exist with the line in range, a command must be one of workspace.yml's, and " +
      "`$ … → exit n` belongs only in the Evidence ledger. Fix the citation or delete the claim.",
    );
  });

  test("denies a checked section that holds only prose, and names the fix", async () => {
    // Spec §2.8: each of the four sections must carry at least one list item.
    // A paragraph is exactly how an unchecked claim used to get written.
    const prosey = GOOD_HANDOFF.replace(
      /## Unknowns\n(?:- .*\n)+/,
      "## Unknowns\nNothing surfaced that the map could not answer.\n",
    );
    const run = await hook("claim-sources", {
      hook_event_name: "PreToolUse", tool_name: "Write",
      tool_input: { file_path: handoffPath(), content: prosey },
    });
    const denied = denialText(run);
    expect(denied).toContain("checked section(s)");
    expect(denied).toContain('"Unknowns"');
    expect(denied).toContain("- none [src: absent:<what you looked at>]");
  });

  test("allows the same section once it says `- none [src: absent:…]`", async () => {
    const named = GOOD_HANDOFF.replace(
      /## Unknowns\n(?:- .*\n)+/,
      "## Unknowns\n- none [src: absent:.tldrx/memory/facts.yml]\n",
    );
    const run = await hook("claim-sources", {
      hook_event_name: "PreToolUse", tool_name: "Write",
      tool_input: { file_path: handoffPath(), content: named },
    });
    expect(run.stdout).toBe("");
    expect(run.code).toBe(0);
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

  test("an UNCITED bullet in markdown that is not a handoff is left alone", async () => {
    // The four-section "every bullet is sourced" rule is the handoff's, and only
    // the handoff's. Prose in a design document is prose.
    const run = await hook("claim-sources", {
      hook_event_name: "PreToolUse", tool_name: "Write",
      tool_input: {
        file_path: join(workspace().runDir, "02-how", "design.md"),
        content: "# Design\n\n## Notes\n- a bullet with no source at all\n",
      },
    });
    expect(run.stdout).toBe("");
  });

  test("a citation that does NOT resolve is denied in design.md too (issue #34)", async () => {
    const run = await hook("claim-sources", {
      hook_event_name: "PreToolUse", tool_name: "Write",
      tool_input: {
        file_path: join(workspace().runDir, "02-how", "design.md"),
        content: "# Design\n\n## Notes\n- the view is refreshed [src: api:src/Nope.cs:8]\n",
      },
    });
    const denied = denialText(run);
    expect(denied).toContain("unresolvable source(s)");
    expect(denied).toContain("02-how/design.md");
    expect(denied).toContain("src/Nope.cs");
  });

  test("a malformed token is denied in a non-handoff output too (issue #34)", async () => {
    const run = await hook("claim-sources", {
      hook_event_name: "PreToolUse", tool_name: "Write",
      tool_input: {
        file_path: join(workspace().runDir, "01-what", "scope.md"),
        content: "# Scope\n\n- in scope: ranking `[src: api:src/Hunt.cs:1]` for now\n",
      },
    });
    const denied = denialText(run);
    expect(denied).toContain("malformed citation(s)");
    expect(denied).toContain("01-what/scope.md");
  });

  test("a resolving citation in a non-handoff output is allowed", async () => {
    const run = await hook("claim-sources", {
      hook_event_name: "PreToolUse", tool_name: "Write",
      tool_input: {
        file_path: join(workspace().runDir, "02-how", "design.md"),
        content: "# Design\n\n## Notes\n- the event already exists [src: api:src/Hunt.cs:8]\n",
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

  /**
   * The half of `--supersede` that matters most. A fact whose `superseded_by` is
   * set is what the workspace USED to believe, and never-re-ask is about what it
   * believes now — so re-asking a question a superseded fact answers is legal,
   * and must be, or an owner who reverses a decision can never have the question
   * put to them again.
   */
  test("a superseded fact stops blocking", async () => {
    const path = join(workspace().root, ".tldrx", "memory", "facts.yml");
    const store = FactsStore.load(path);
    store.supersede("F019", {
      fact: "Backend deploys are fully automatic on merge — deploy.yml now triggers on push.",
      area: "deploy",
      repos: ["api", "lab"],
      kind: "answer",
      confidence: "stated",
      source: { who: "alan", when: "2026-08-31T09:00:00Z", run: "260831-envs", q: "Q1" },
    });
    store.save();
    const run = await hook("no-reask", {
      hook_event_name: "PreToolUse", tool_name: "Write",
      tool_input: { file_path: questionsPath(), content: questionsWith("Q7", RE_ASKED_TITLE, "deploy") },
    });
    expect(run.code).toBe(0);
    // stderr too: the hook fails OPEN, so "allowed" alone would also be what a
    // crash looks like, and this test would pass for the wrong reason.
    expect(run.stderr).toBe("");
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

/**
 * Every command in this block is DECLARED in the fixture's workspace.yml. Since
 * 2026-08-29 the gate runs only what the workspace declared, argv-split with no
 * shell, so an ad-hoc `echo … >&2; exit 1` is no longer runnable — and that is
 * the point being tested, not an obstacle to it.
 */
const FAILING_COMMAND = "sh scripts/dod-fail.sh";
const PASSING_COMMAND = "sh scripts/dod-ok.sh";

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
      tool_input: { file_path: storyPath(), content: story("done", [PASSING_COMMAND, "true"]) },
    });
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("");
  });

  test("denies `done` when a dod command fails, quoting the output tail", async () => {
    const run = await hook("dod-gate", {
      hook_event_name: "PreToolUse", tool_name: "Write",
      tool_input: { file_path: storyPath(), content: story("done", [PASSING_COMMAND, FAILING_COMMAND]) },
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
    // Always a string: `toContain` on a null denial reports a matcher-type error
    // instead of the hook's actual output, which is what hid a Linux-only hang.
    expect(denialText(run)).toContain("timed out after 1s");
  }, 15_000);

  test("a command that needs a shell is refused BEFORE anything spawns", async () => {
    // Was: `sleep 30 & wait`, which forced a grandchild and proved the process
    // tree got killed. That property now lives in test/runtime.test.ts, where it
    // is tested directly — this gate no longer opens a shell at all, so a command
    // carrying `&` never reaches one. The stronger statement is the refusal.
    const run = await hook("dod-gate", {
      hook_event_name: "PreToolUse", tool_name: "Write",
      tool_input: { file_path: storyPath(), content: story("done", ["sleep 30 & wait"]) },
    });
    expect(denialText(run)).toContain("refusing to RUN");
    expect(denialText(run)).toContain("not one of .tldrx/workspace.yml's commands");
  }, 15_000);

  test("an UNDECLARED command is refused, however harmless it looks", async () => {
    const run = await hook("dod-gate", {
      hook_event_name: "PreToolUse", tool_name: "Write",
      tool_input: { file_path: storyPath(), content: story("done", ["echo hello"]) },
    });
    expect(denialText(run)).toContain("refusing to RUN `echo hello`");
    expect(denialText(run)).toContain("a story is data, and data does not get to invent a command");
  });

  test("`dod: rm -rf ~` is DENIED and never runs — the audit's second finding", async () => {
    const run = await hook("dod-gate", {
      hook_event_name: "PreToolUse", tool_name: "Write",
      tool_input: { file_path: storyPath(), content: story("done", ["rm -rf ~"]) },
    });
    expect(run.code).toBe(0);
    expect(denialText(run)).toContain("refusing to RUN `rm -rf ~`");
    // and the home directory is, self-evidently, still there
    expect(existsSync(homedir())).toBe(true);
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
    // The remedy is the command that performs it, with the shortfall already
    // computed and rounded UP — the pilot's hand-edit under-shot and the retry
    // was refused a second time.
    expect(denial(run)).toBe(
      '[tldrx] budget-gate: refusing to start stage "contracts" — phase 02-how has $0.61 left of $7.00 and ' +
      "the stage estimate is $3.00. Run `tldrx budget raise 02-how 2.39 --run 260828-leaderboard` " +
      "(add `--take-from <phase>` to move the money instead of adding it), lower budget_usd in " +
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

  test("fails CLOSED on an unreadable budget.yml", async () => {
    // Was fail-OPEN until 2026-08-29 (`budget-gate.ts:14`): the one hook whose job
    // is refusing to spend allowed every spawn it could not price. "Cannot read
    // the budget" and "the budget is fine" are not the same answer.
    writeFileSync(join(workspace().runDir, "budget.yml"), "version: 1\nphases: 3\n", "utf8");
    const run = await hook("budget-gate", {
      hook_event_name: "PreToolUse", tool_name: "Bash", cwd: workspace().root,
      tool_input: { command: "tldrx next" },
    });
    expect(run.code).toBe(0);
    expect(denialText(run)).toContain("could not read the budget it is supposed to enforce");
    expect(denialText(run)).toContain("fails CLOSED");
  });

  // --- M6: the three spenders the gate could not see (2026-08-29 audit, §A) ---

  test("`tldrx run auto` is gated — the command that can spend a whole run", async () => {
    const run = await hook("budget-gate", {
      hook_event_name: "PreToolUse", tool_name: "Bash", cwd: workspace().root,
      tool_input: { command: `tldrx run auto --run ${FIXTURE_RUN}` },
    });
    expect(denialText(run)).toContain('refusing to start stage "contracts"');
  });

  test("`tldrx run auto --max-usd` is priced at the flag, not the stage", async () => {
    const run = await hook("budget-gate", {
      hook_event_name: "PreToolUse", tool_name: "Bash", cwd: workspace().root,
      tool_input: { command: `tldrx run auto --run ${FIXTURE_RUN} --max-usd 25` },
    });
    expect(denialText(run)).toContain("the stage estimate is $25.00");
  });

  test("`tldrx expert train` is gated at its $2.00 default", async () => {
    const run = await hook("budget-gate", {
      hook_event_name: "PreToolUse", tool_name: "Bash", cwd: workspace().root,
      tool_input: { command: `tldrx expert train architect --area api --run ${FIXTURE_RUN}` },
    });
    expect(denialText(run)).toContain("the stage estimate is $2.00");
  });

  test("`tldrx seed triage --propose` is gated at its $1.00 default", async () => {
    const run = await hook("budget-gate", {
      hook_event_name: "PreToolUse", tool_name: "Bash", cwd: workspace().root,
      tool_input: { command: `tldrx seed triage docs/prd.md --propose --run ${FIXTURE_RUN}` },
    });
    expect(denialText(run)).toContain("the stage estimate is $1.00");
  });

  test("a command that spends nothing is still allowed", async () => {
    const run = await hook("budget-gate", {
      hook_event_name: "PreToolUse", tool_name: "Bash", cwd: workspace().root,
      tool_input: { command: "tldrx run status" },
    });
    expect(run.stdout).toBe("");
  });

  test("outside a tldrx workspace it allows — that is a correct negative, not a failure", async () => {
    const run = await hook("budget-gate", {
      hook_event_name: "PreToolUse", tool_name: "Bash", cwd: "/",
      tool_input: { command: "tldrx run auto" },
    });
    expect(run.stdout).toBe("");
  });

  // --- both economies, and who is driving (issue #22) ------------------------

  /** One task the host paid for: no dollars, a declared token figure. */
  const HOST_TASK =
    `[{id: t1, status: done, expert: architect, model: sonnet, cost_usd: null, metered: false, tokens: 12000,`
    + ` error: null, session_id: null, started_at: null, ended_at: null, outputs: []}]`;

  /** Rewrite the fixture run's contracts stage to carry a host-paid turn. */
  function withHostTask(attended: boolean): void {
    const path = join(workspace().runDir, "run.yml");
    let text = readFileSync(path, "utf8").replace("tasks: []}\n", "tasks: []}\n");
    // The SECOND `tasks: []` is the contracts stage the cursor points at.
    const at = text.lastIndexOf("tasks: []}");
    text = `${text.slice(0, at)}tasks: ${HOST_TASK}}${text.slice(at + "tasks: []}".length)}`;
    if (attended) text = text.replace(/^status: /m, "attended_by: host\nstatus: ");
    writeFileSync(path, text, "utf8");
  }

  function priceInHostTokens(): void {
    const path = join(workspace().runDir, "budget.yml");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace("{id: 02-how, ceiling_usd: 7.0, spent_usd: 6.39}",
        "{id: 02-how, ceiling_usd: 7.0, spent_usd: 6.39, economy: host-tokens}"),
      "utf8",
    );
  }

  test("a `host-tokens` phase still allows — and now SAYS what was spent in tokens", async () => {
    priceInHostTokens();
    withHostTask(false);
    const run = await hook("budget-gate", {
      hook_event_name: "PreToolUse", tool_name: "Bash", cwd: workspace().root,
      tool_input: { command: "tldrx next 260828-leaderboard" },
    });
    // Unchanged decision: a ceiling that is not in dollars cannot deny a dollar
    // spend, and the two economies are never converted (design §E.2).
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("host-tokens");
    // What was missing: the gate could not see the host-token spend at all.
    expect(run.stderr).toContain("12000 host tokens");
    expect(run.stderr).toContain("1 unmetered turn");
  });

  /**
   * Unattended, deliberately. This test was written with `withHostTask(true)` and
   * asserted a DENY on an attended run; the owner's decision of 2026-09-01 (#22a)
   * is that an attended run is never denied on metered dollars, so the deny it
   * measures now has to come from a run the framework really would spawn on. What
   * it is FOR is unchanged and is still pinned: when host tokens were spent, the
   * refusal says the dollar figure is metered spend only.
   */
  test("the deny says the dollar figure is METERED spend only when it is", async () => {
    withHostTask(false);
    const run = await hook("budget-gate", {
      hook_event_name: "PreToolUse", tool_name: "Bash", cwd: workspace().root,
      tool_input: { command: "tldrx next 260828-leaderboard" },
    });
    const said = denialText(run);
    expect(said).toContain('refusing to start stage "contracts"');
    expect(said).toContain("12000 host tokens");
    expect(said).not.toContain("attended_by: host");

    const blocked = EventLog.forRun(workspace().runDir).read().filter((e) => e.type === "budget.blocked");
    expect(blocked[0]?.payload).toMatchObject({
      economy: "metered-usd",
      attended_by: null,
      host_tokens: 12_000,
      unmetered_tasks: 1,
    });
  });

  /**
   * #22(a), owner decision 2026-09-01.
   *
   * `tldrx next` on an `attended_by: host` run exits 4 and spawns nothing, so the
   * dollar estimate this hook was denying against is spend that provably will not
   * happen. It INFORMS instead — both economies, exactly as already wired — and
   * allows. The event it writes says `budget.warned`, because nothing was blocked
   * and an audit trail that records a block that did not happen is a lie.
   */
  test("an attended run is INFORMED, never denied, on metered dollars (#22a)", async () => {
    withHostTask(true);
    const run = await hook("budget-gate", {
      hook_event_name: "PreToolUse", tool_name: "Bash", cwd: workspace().root,
      tool_input: { command: "tldrx next 260828-leaderboard" },
    });

    expect(run.stdout).toBe("");                       // no deny envelope at all
    expect(run.stderr).toContain("attended_by: host");
    expect(run.stderr).toContain("12000 host tokens");
    // The dollar facts are still SAID — informing is the whole point.
    expect(run.stderr).toContain("$0.61");
    expect(run.stderr).toContain("$3.00");

    const log = EventLog.forRun(workspace().runDir).read();
    expect(log.filter((e) => e.type === "budget.blocked")).toHaveLength(0);
    const warned = log.filter((e) => e.type === "budget.warned");
    expect(warned).toHaveLength(1);
    expect(warned[0]?.payload).toMatchObject({
      phase: "02-how", attended_by: "host", estimate_usd: 3, host_tokens: 12_000,
    });
  });

  /**
   * #22(b), owner decision 2026-09-01.
   *
   * Under `economy: host-tokens` the phase's ceiling number is a host-session
   * TOKEN allowance, not dollars (`budget/RunBudget.ts`) — so `declared tokens vs
   * that ceiling` is the one comparison in this file whose two sides share a unit.
   * It is now computable (`runSpend().hostTokens`, wired at bb6204b) and it warns.
   * It does NOT deny: enforcement is opt-in, below.
   */
  function hostCeiling(tokens: number, extra = ""): void {
    const path = join(workspace().runDir, "budget.yml");
    const text = readFileSync(path, "utf8")
      // The token allowance goes in `ceiling_host_tokens`, and the run's
      // `ceiling_usd: 25.0` is LEFT ALONE (#61, fixed). The first version of this
      // helper had to raise it to 60000 — a dollar figure that meant nothing —
      // because the sum check added a 10 000-token phase ceiling to dollars. The
      // sums are per economy now, so a token phase costs the dollar ceiling
      // nothing and the fixture stays a fixture.
      .replace(
        "{id: 02-how, ceiling_usd: 7.0, spent_usd: 6.39}",
        `{id: 02-how, ceiling_usd: 7.0, spent_usd: 0, economy: host-tokens, `
          + `ceiling_host_tokens: ${String(tokens)}}`,
      )
      // Before `phases:`, not after it: `phases:` is a multi-line flow sequence
      // and is the last key in the file.
      .replace("phases: [", `${extra}phases: [`);
    writeFileSync(path, text, "utf8");
  }

  test("declared tokens OVER the host ceiling warn, and still allow (#22b)", async () => {
    hostCeiling(10_000);          // the run has declared 12 000
    withHostTask(false);
    const run = await hook("budget-gate", {
      hook_event_name: "PreToolUse", tool_name: "Bash", cwd: workspace().root,
      tool_input: { command: "tldrx next 260828-leaderboard" },
    });

    expect(run.stdout).toBe("");                        // allowed
    expect(run.stderr).toContain("12000");
    expect(run.stderr).toContain("10000");
    expect(run.stderr).toMatch(/over|exceed/i);
    const warned = EventLog.forRun(workspace().runDir).read().filter((e) => e.type === "budget.warned");
    expect(warned).toHaveLength(1);
    expect(warned[0]?.payload).toMatchObject({
      phase: "02-how", economy: "host-tokens", host_tokens: 12_000, ceiling_tokens: 10_000,
    });
  });

  test("declared tokens UNDER the host ceiling say nothing new (#22b)", async () => {
    hostCeiling(50_000);
    withHostTask(false);
    const run = await hook("budget-gate", {
      hook_event_name: "PreToolUse", tool_name: "Bash", cwd: workspace().root,
      tool_input: { command: "tldrx next 260828-leaderboard" },
    });
    expect(run.stdout).toBe("");
    expect(run.stderr).not.toMatch(/over its host-token ceiling/i);
    expect(EventLog.forRun(workspace().runDir).read().filter((e) => e.type === "budget.warned")).toHaveLength(0);
  });

  test("`on_host_tokens_exceed: block` is the explicit opt-in that DENIES (#22b)", async () => {
    hostCeiling(10_000, "on_host_tokens_exceed: block\n");
    withHostTask(false);
    const run = await hook("budget-gate", {
      hook_event_name: "PreToolUse", tool_name: "Bash", cwd: workspace().root,
      tool_input: { command: "tldrx next 260828-leaderboard" },
    });

    const said = denialText(run);
    expect(said).toContain("host-token");
    expect(said).toContain("12000");
    expect(said).toContain("10000");
    // Never a dollar remedy for a token ceiling: `budget raise` moves money.
    expect(said).not.toContain("budget raise");
    const blocked = EventLog.forRun(workspace().runDir).read().filter((e) => e.type === "budget.blocked");
    expect(blocked[0]?.payload).toMatchObject({ economy: "host-tokens", ceiling_tokens: 10_000 });
  });

  test("the opt-in still never denies an ATTENDED run (#22a beats #22b)", async () => {
    hostCeiling(10_000, "on_host_tokens_exceed: block\n");
    withHostTask(true);
    const run = await hook("budget-gate", {
      hook_event_name: "PreToolUse", tool_name: "Bash", cwd: workspace().root,
      tool_input: { command: "tldrx next 260828-leaderboard" },
    });
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("attended_by: host");
  });

  test("an ordinary metered run's deny is byte-identical to what it always was", async () => {
    const run = await hook("budget-gate", {
      hook_event_name: "PreToolUse", tool_name: "Bash", cwd: workspace().root,
      tool_input: { command: "tldrx next 260828-leaderboard" },
    });
    expect(denialText(run)).not.toContain("host tokens");
    expect(denialText(run)).not.toContain("attended_by");
  });
});

describe("session-start (SessionStart)", () => {
  test("injects three lines about the newest run, then up to three of the pending report", async () => {
    const run = await hook("session-start", {
      hook_event_name: "SessionStart", source: "startup", cwd: workspace().root,
    });
    expect(run.code).toBe(0);
    const lines = (context(run) ?? "").split("\n");
    // Spec §4: 3 for "where we are", 3 for `tldrx status`, never more.
    expect(lines.length).toBeLessThanOrEqual(6);
    // The run block is still the PREFIX and still byte-identical.
    expect(lines[0]).toBe('tldrx: run 260828-leaderboard — "Player leaderboard" (feature) · awaiting_gate');
    expect(lines[1]).toBe("tldrx: at 02-how / contracts — architect · awaiting_gate");
    expect(lines[2]).toBe("tldrx: 1 open question (Q4) · gate pending: `tldrx approve`");
    // …and the pending block follows it. This fixture's run.yml deliberately
    // fails §2.2 validation (see the tolerant-reader test in
    // `facilitator-statusline.test.ts`), so what `tldrx status` has to report
    // about it is exactly that it could not be read.
    expect(lines[3]).toStartWith("tldrx: 1 pending — ");
    expect(lines[4]).toContain("could not be read");
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

  test("drops the run block when every run is terminal", async () => {
    const path = join(workspace().runDir, "run.yml");
    writeFileSync(path, readFileSync(path, "utf8").replace("status: awaiting_gate\ncursor", "status: done\ncursor"), "utf8");
    const run = await hook("session-start", {
      hook_event_name: "SessionStart", source: "startup", cwd: workspace().root,
    });
    const lines = (context(run) ?? "").split("\n").filter((line) => line !== "");
    expect(lines.some((line) => line.startsWith("tldrx: run "))).toBe(false);
    expect(lines.some((line) => line.startsWith("tldrx: at "))).toBe(false);
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
    expect(manifest.version).toBe(PKG_VERSION);
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
