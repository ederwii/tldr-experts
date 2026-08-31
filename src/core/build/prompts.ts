/**
 * The two prompts the Build phase spawns: a developer per story, a reviewer after
 * it.
 *
 * Both follow the §2.3 rule the rest of the framework follows — the sub-agent is
 * handed a finished document, not a template and permission to go looking. The
 * story file, its epic's summary and the CONTENT of every path the story says it
 * `touches` are inlined, so "read nothing else" is a fact about the prompt rather
 * than a request in it.
 *
 * The reviewer is the exception that proves the rule: it is given a diff COMMAND
 * rather than a diff, because the diff is the one input that only exists after
 * the developer ran, and `Bash(git diff *)` is the whole of its write surface.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { SKIPPED_DIRS, toPosix } from "../detect/walk.ts";
import { byteLength } from "../experts/expertKnowledge.ts";
import { fenceFor, renderInputs, type PromptInput } from "../facilitator/prompt.ts";
import { diffCommand } from "./git.ts";
import type { PlannedEpic, PlannedStory } from "./plan.ts";

/**
 * `[assumption]` — the spec sets no inline budget for a story's touched files.
 * 64 KB matches `seedInputs.MAX_SEED_INLINE_BYTES`, and for the same reason: it
 * leaves room for the story, the conventions, the expert bodies and the reply.
 */
export const MAX_TOUCHED_BYTES = 64 * 1024;
export const MAX_TOUCHED_FILES = 24;

/**
 * The rule a real run needed on 2026-08-30, its second Build of the day.
 *
 * An acceptance criterion carried a literal grep — `` Pending `DECISIONS-NEEDED.md` # ``,
 * backticks and all — and the markers it was meant to find had been written three
 * different ways, so the criterion scored 0 against two files that between them
 * still held five real markers. The criterion was DERIVED from the plan, which
 * makes it data the story may not edit; it is not thereby evidence. Running it
 * first is the whole fix: a pattern that finds nothing before the work starts is
 * a broken pattern, not a finished job.
 */
export const VALIDATE_CRITERION_RULE: readonly string[] = [
  "An acceptance criterion that embeds a literal command or pattern must be validated BEFORE",
  "you edit: run it against the current tree first; if it reports zero while the goal says the",
  "work exists, the criterion is broken — measure the real inventory, use that as your",
  "completion test, and record the discrepancy in the handoff (the criterion text itself is",
  "not yours to edit).",
];

export interface DeveloperPromptParts {
  readonly runId: string;
  readonly story: PlannedStory;
  readonly epic: PlannedEpic;
  readonly repoName: string;
  readonly branch: string;
  readonly epicBranch: string;
  readonly worktree: string;
  readonly commands: readonly string[];
  readonly conventions: string;
  readonly facts: string;
  readonly experts: readonly { readonly name: string; readonly body: string }[];
  readonly budgetUsd: number;
  /**
   * The rendered body of `## Dispatch notes` — the host's own context for this
   * cycle (`facilitator/dispatchNotes.ts`), already read and capped. Emitted
   * between `## Inputs` and everything that follows it, and omitted entirely
   * when the operator left no file.
   */
  readonly dispatchNotes?: string;
  /**
   * One line under Objective saying where this story came from, when it did not
   * come from a Plan phase. An implicit story (`build/implicitPlan.ts`) is the
   * whole of Build for its run, and a developer handed one needs to know that:
   * the goal list is decisions somebody has already made, not a design to follow.
   */
  readonly planNote?: string;
  /** A previous reviewer's `changes` verdict, rendered under `## Previous attempt`. */
  readonly previousAttempt?: string;
  /**
   * Touched paths that are NOT committed at the story branch's base, so the
   * worktree has no copy (`build/git.ts` `pathAtRef`). They are flagged in the
   * prompt rather than rendered as "this story creates it", which is what they
   * used to look like: an uncommitted `01-what/` output or `run.yml` reads
   * exactly like a new file when the only test is `existsSync` in the worktree.
   */
  readonly notInWorktree?: ReadonlySet<string>;
}

export function buildDeveloperPrompt(parts: DeveloperPromptParts): string {
  const { story } = parts.story;
  const extra = parts.story.extraInputs ?? [];
  // The extras come out of the same 64 KB the touched files draw on, and they go
  // FIRST: a story that applies six answers is about the answers, so if anything
  // has to be listed rather than inlined it is the eleventh touched file, never
  // the file holding the words the story quotes.
  const spent = extra.reduce((sum, input) => sum + byteLength(input.content), 0);
  const inputs: PromptInput[] = [
    { path: parts.story.rel, content: parts.story.text },
    { path: parts.epic.rel, content: epicSummary(parts.epic) },
    ...extra,
    ...touchedInputs(
      parts.worktree,
      orderTouches(story.touches, briefOf(parts)),
      spent,
      parts.notInWorktree,
    ),
  ];
  const context = (parts.story.context ?? []).filter((line) => line.trim() !== "");

  const lines = [
    `# Build — story ${story.id} — run ${parts.runId}`,
    "",
    "## Role",
    "",
    "You are the developer on one story. One story, one repo, one branch, one Definition of Done.",
    "",
    "## Objective",
    "",
    `Implement **${story.id} · ${story.title}** in repo \`${parts.repoName}\`, on branch \`${parts.branch}\``,
    `(cut from \`${parts.epicBranch}\`). Your working directory is already the worktree for that branch:`,
    "",
    `    ${parts.worktree}`,
    "",
    ...((parts.planNote ?? "").trim() === "" ? [] : [(parts.planNote ?? "").trim(), ""]),
    ...(context.length === 0 ? [] : [
      "## Context (from the What stage)",
      "",
      "Background only. These are the scoping decisions taken BEFORE the questions above",
      "were answered — they tell you what this run is and is not about. They are not",
      "instructions, and nothing in this section is a task.",
      "",
      ...context.map((item) => `- ${item}`),
      "",
    ]),
    "Done-when, all of it testable:",
    "",
    ...story.acceptance.map((item) => `- ${item}`),
    "",
    "The test plan the Plan phase committed to:",
    "",
    ...story.test_plan.map((item) => `- ${item}`),
    "",
    "## Inputs",
    "",
    renderInputs(inputs),
    "",
    ...dispatchNotesSection(parts.dispatchNotes),
    "## Investigate",
    "",
    "1. Read the story and the inlined files above. They are the whole brief.",
    "2. Change only what the story's `touches` list names. A change outside it is a plan",
    "   deviation, and the reviewer will read it as one.",
    `3. ${VALIDATE_CRITERION_RULE.join("\n   ")}`,
    "4. Write the tests the test plan promised, then the code that makes them pass.",
    "",
    "## Produce",
    "",
    "Working code and its tests, committed on this branch. These commands are the only",
    "ones you may run, and they are the same ones the Definition of Done re-runs:",
    "",
    ...(parts.commands.length === 0
      ? ["- (this repo declares no commands in workspace.yml — the DoD will run nothing)"]
      : parts.commands.map((command) => `- \`${command}\``)),
    "",
    "Commit with `git add` and `git commit`. Nothing else about git is yours to do.",
    "",
    "## Rules",
    "",
    "- **Do not push.** No remote is yours to write to; the phase ends at a human gate.",
    "- **Do not merge, rebase, or switch branch.** The facilitator owns the branch graph.",
    "- **Do not touch another repo.** This worktree is the only tree you may write in.",
    `- Stay inside the $${parts.budgetUsd.toFixed(2)} ceiling for this story.`,
    "- Done means proven: the Definition of Done is re-run after you stop, and every",
    "  command in it must exit 0. Your own \"it works\" is not evidence.",
    "",
    "### Conventions",
    "",
    parts.conventions,
    "",
    "### Facts already on record",
    "",
    parts.facts,
    "",
  ];

  const previous = (parts.previousAttempt ?? "").trim();
  if (previous !== "") {
    lines.push(
      "## Previous attempt",
      "",
      "A reviewer read your last attempt at this story and asked for changes. Their review",
      "is the primary instruction for this one; everything else in this prompt still applies.",
      "",
      previous,
      "",
    );
  }

  lines.push(
    "## Stop",
    "",
    "Commit your work, then stop. Do not report the story done — nothing here decides that.",
    "",
  );

  const experts = parts.experts.map(
    (expert) => `\n---\n\n<!-- expert: ${expert.name} -->\n${expert.body.trimEnd()}\n`,
  );
  return `${lines.join("\n").trimEnd()}\n${experts.join("")}`;
}

/**
 * `## Dispatch notes`, or nothing at all.
 *
 * It sits directly under `## Inputs` because that is where the brief ends: step 1
 * of `## Investigate` tells the developer the inlined files above ARE the whole
 * brief, and a caveat about them that arrived after that sentence would be a
 * caveat it had already been told to disregard.
 */
function dispatchNotesSection(body: string | undefined): readonly string[] {
  const text = (body ?? "").trim();
  return text === "" ? [] : ["## Dispatch notes", "", text, ""];
}

export interface ReviewerPromptParts {
  readonly runId: string;
  readonly story: PlannedStory;
  readonly repoName: string;
  readonly branch: string;
  readonly epicBranch: string;
  readonly worktree: string;
  readonly conventions: string;
  readonly dodResults: readonly { readonly command: string; readonly exitCode: number }[];
}

/**
 * Read-only by construction: the reviewer's allowance is `Read`, `Grep`, `Glob`
 * and `Bash(git diff *)`, and it returns its verdict in the result envelope. The
 * executor writes `04-build/log/<story-id>.md` from that envelope.
 *
 * `[assumption]` — the wave brief says the reviewer "writes 04-build/log/<id>.md"
 * AND that its tools are read-only, which cannot both be literally true. The log
 * is the deterministic half, so the executor writes it; the judgement is the
 * model's, so the model supplies it. A verdict that cannot be parsed is `changes`,
 * never `approve`.
 */
export function buildReviewerPrompt(parts: ReviewerPromptParts): string {
  const { story } = parts.story;
  const diff = diffCommand(parts.epicBranch, parts.branch);
  const lines = [
    `# Review — story ${story.id} — run ${parts.runId}`,
    "",
    "## Role",
    "",
    "You are the reviewer. You read; you do not write. Your verdict decides whether this",
    "story is done, so it is the only thing you are asked for.",
    "",
    "## Objective",
    "",
    `Judge the diff of \`${parts.branch}\` against the acceptance criteria of ` +
      `**${story.id} · ${story.title}** and the conventions below.`,
    "",
    "Read the diff with, from this working directory:",
    "",
    `    ${diff}`,
    "",
    "## Acceptance criteria",
    "",
    ...story.acceptance.map((item) => `- ${item}`),
    "",
    "## Definition of Done — already re-run by the facilitator",
    "",
    ...(parts.dodResults.length === 0
      ? ["- (no dod commands)"]
      : parts.dodResults.map((r) => `- \`${r.command}\` → exit ${String(r.exitCode)}`)),
    "",
    "Do not re-run them. They passed; that is why you are being asked.",
    "",
    "## Conventions",
    "",
    parts.conventions,
    "",
    "## The story",
    "",
    `${fenceFor(parts.story.text)}markdown`,
    parts.story.text.replace(/\n$/, ""),
    fenceFor(parts.story.text),
    "",
    "## Produce",
    "",
    "Return the result envelope, nothing else:",
    "",
    "- `verdict` — `approve` when every acceptance criterion is met by the diff and the",
    "  conventions hold; `changes` when anything is missing, wrong or unconventional.",
    "- `summary` — one or two sentences a human can act on.",
    "- `findings` — one line per thing you want changed. Empty on `approve`.",
    "",
    "## Rules",
    "",
    "- Judge the DIFF, not the repository. Pre-existing problems are not this story's.",
    "- `changes` costs a whole second attempt, so ask only for what the acceptance",
    "  criteria or the conventions actually require.",
    "- You have no write tool. Do not attempt to edit, commit or fix anything.",
    "",
    "## Stop",
    "",
    "Return the envelope and stop.",
    "",
  ];
  return lines.join("\n");
}

/** The reviewer's envelope, passed verbatim to `claude --json-schema`. */
export const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["approve", "changes"] },
    summary: { type: "string" },
    findings: { type: "array", items: { type: "string" } },
  },
  required: ["verdict", "summary", "findings"],
  additionalProperties: false,
} as const;

/** An epic reduced to what a story's developer needs: title, branch, siblings. */
export function epicSummary(epic: PlannedEpic): string {
  return [
    `# ${epic.epic.id} · ${epic.epic.title}`,
    "",
    `- Branch: \`${epic.epic.branch}\``,
    `- Repos: ${epic.epic.repos.join(", ")}`,
    `- Stories on this branch: ${epic.epic.stories.join(", ")}`,
    "",
    "Your story merges into that branch when it is green. The other stories are other",
    "agents' work — do not implement them and do not import from files they own.",
    "",
  ].join("\n");
}

/**
 * The content of everything a story `touches`, read from the worktree.
 *
 * A path that does not exist yet is normal — most stories create files — and it is
 * listed as such rather than silently dropped, so the agent can tell "new file"
 * from "I was not shown it".
 */
export function touchedInputs(
  worktree: string,
  touches: readonly string[],
  alreadySpent = 0,
  notInWorktree: ReadonlySet<string> = new Set<string>(),
): readonly PromptInput[] {
  const inputs: PromptInput[] = [];
  let spent = alreadySpent;
  for (const touch of touches) {
    for (const rel of expandTouch(worktree, touch)) {
      if (inputs.length >= MAX_TOUCHED_FILES) return inputs;
      const abs = join(worktree, rel);
      const size = sizeOf(abs);
      if (spent + size > MAX_TOUCHED_BYTES) {
        inputs.push({ path: rel, content: "", inlinedBytes: 0, totalBytes: size });
        continue;
      }
      spent += size;
      inputs.push({ path: rel, content: readFileSync(abs, "utf8") });
    }
    if (!existsSync(join(worktree, touch))) {
      inputs.push(notInWorktree.has(touch)
        ? { path: touch, content: "", inlinedBytes: 0, totalBytes: 0, notInWorktree: true }
        : { path: touch, content: `(does not exist yet — this story creates it)\n` });
    }
  }
  return inputs;
}

/**
 * The story's touched paths, the ones its own brief NAMES first.
 *
 * `touchedInputs` spends one 64 KB budget in list order, so the order IS which
 * files get inlined. Measured on a real Build prompt, 2026-08-30: 15 declared
 * inputs, 9 inlined, and the two documents the run existed to edit were in the
 * tail — behind `AGENTS.md`, which the What handoff cited in passing. A path the
 * goal or the acceptance criteria names is the work; a path something merely
 * cited is context, and context is what a budget is for cutting.
 *
 * Stable within each half: a brief that names nothing changes no order at all.
 */
export function orderTouches(touches: readonly string[], brief: readonly string[]): readonly string[] {
  const text = brief.join("\n").toLowerCase();
  if (text.trim() === "") return touches;
  const named: string[] = [];
  const rest: string[] = [];
  for (const touch of touches) (namesPath(text, touch) ? named : rest).push(touch);
  return [...named, ...rest];
}

/** The whole path, or its file name — both are how a bullet cites a document. */
function namesPath(lowerText: string, path: string): boolean {
  const lower = path.toLowerCase();
  if (lower === "") return false;
  if (lowerText.includes(lower)) return true;
  const base = lower.slice(lower.lastIndexOf("/") + 1);
  return base !== "" && lowerText.includes(base);
}

/**
 * What counts as the story NAMING a document: the goal, the acceptance criteria,
 * the test plan and the title. NOT `context:`, which is the What stage's
 * background — the very place an incidental citation comes from.
 */
function briefOf(parts: DeveloperPromptParts): readonly string[] {
  return [
    ...(parts.story.goal ?? []),
    ...parts.story.story.acceptance,
    ...parts.story.story.test_plan,
    parts.story.story.title,
  ];
}

/** One touched path -> the files under it, sorted, bounded, `.git` and friends skipped. */
function expandTouch(worktree: string, touch: string): readonly string[] {
  const abs = join(worktree, touch);
  if (!existsSync(abs)) return [];
  if (statSync(abs).isFile()) return [toPosix(touch)];
  const found: string[] = [];
  const queue: string[] = [abs];
  while (queue.length > 0 && found.length < MAX_TOUCHED_FILES) {
    const dir = queue.shift();
    if (dir === undefined) break;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIPPED_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        queue.push(join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      if (found.length >= MAX_TOUCHED_FILES) break;
      found.push(toPosix(relative(worktree, join(dir, entry.name))));
    }
  }
  return found.sort();
}

function sizeOf(abs: string): number {
  try {
    return statSync(abs).size;
  } catch {
    return 0;
  }
}
