/**
 * The plan a scope that SKIPS Plan gets when it reaches Build.
 *
 * Five shipped scopes list `build` in their stages and `plan` in their skips —
 * `docs`, `hotfix`, `performance`, `prototype`, `security-patch` — and until this
 * file existed every one of them was a dead end. `stages/build/stage.yml` declares
 * `03-plan/waves.yml` as an input and the executor's first act is
 * `loadBuildPlan(03-plan/)`, so a real `docs` run parked at `04-build (ready)`
 * with no `03-plan/` on disk could only fail its own Build stage:
 * `03-plan/ does not validate — stories/: the Plan wrote no stories`.
 *
 * The fix is not to loosen Build. It is to notice that the Plan phase was skipped
 * BY DECISION — the scope says so, in `skips:` — and to write the one story that
 * decision implies, deterministically, from what the run already has:
 *
 *   title       the run's own title
 *   goal        `01-what/handoff.md` § Decisions, verbatim, tokens and all
 *   acceptance  `01-what/success-metrics.md`'s items, verbatim
 *   touches     the repo paths those two documents actually cite, that exist
 *   dod         the commands `workspace.yml` declares that this scope calls for
 *   budget_usd  the Build stage's own ceiling
 *
 * Nothing here is invented and nothing here is asked of a model: every line of
 * the produced `04-build/implicit-plan.yml` is copied from a file the run already
 * wrote, and a command that is not in `workspace.yml` can never reach the `dod`
 * (spec §2.13's rule, which this obeys rather than routes around).
 *
 * The file is also the STATE, the way a story file is: its top-level `status:` and
 * `evidence:` are what the executor writes back, so `run status` and a resumed
 * `tldrx next` read the story's progress out of the same document that describes
 * it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listItems, parseHandoff } from "../text/handoff.ts";
import { parseSrcToken } from "../text/srcToken.ts";
import { MAX_ITEM_CHARS, MAX_LIST_ITEMS, type PlanStatus } from "../schemas/planCommon.ts";
import type { Story } from "../schemas/story.ts";
import type { Epic } from "../schemas/epic.ts";
import { repoPath, type WorkspaceContext } from "../../hooks/lib/workspace.ts";
import { MAX_TOUCHED_FILES } from "./prompts.ts";
import { applyPlanPatch, quote, type StoryPatch } from "./storyFile.ts";
import { BUILD_PHASE, PLAN_PHASE, type BuildPlan, type PlannedEpic, type PlannedStory } from "./plan.ts";

/** The stage id a workflow names in `skips:` when it will not plan. */
export const PLAN_STAGE = "plan";
export const IMPLICIT_PLAN_FILE = "implicit-plan.yml";
/** Run-relative, and the path everything downstream cites. */
export const IMPLICIT_PLAN_REL = `${BUILD_PHASE}/${IMPLICIT_PLAN_FILE}`;
export const IMPLICIT_STORY_ID = "S1";
export const IMPLICIT_EPIC_ID = "E1";
export const IMPLICIT_WAVE_ID = "W1";

/** Where the What phase leaves the two documents the plan is synthesised from. */
export const WHAT_HANDOFF_REL = "01-what/handoff.md";
export const SUCCESS_METRICS_REL = "01-what/success-metrics.md";

/** Spec §2.13's cap on a story's touched paths, narrowed to what a prompt inlines. */
export const MAX_IMPLICIT_TOUCHES = MAX_TOUCHED_FILES;

export class ImplicitPlanError extends Error {}

/** True when this scope declared, in writing, that it does not run the Plan phase. */
export function planIsSkipped(skips: readonly string[]): boolean {
  return skips.includes(PLAN_STAGE);
}

/**
 * A declared input the implicit plan stands in for.
 *
 * Only paths inside `03-plan/` — the phase that did not run. Everything else a
 * stage declares is still checked and still refused when it is missing: a scope
 * that skips Plan has not thereby excused itself from `.tldrx/workspace.yml`.
 */
export function satisfiedByImplicitPlan(declared: string): boolean {
  return declared === PLAN_PHASE || declared.startsWith(`${PLAN_PHASE}/`);
}

export function implicitPlanPath(runDir: string): string {
  return join(runDir, BUILD_PHASE, IMPLICIT_PLAN_FILE);
}

/**
 * Which of the roles a scope's Definition of Done calls for, in a fixed order.
 *
 * The shipped scopes' own words decide it:
 *   - `docs` — "Write or repair documentation": lint. A docs change cannot be
 *     proved by a build.
 *   - `spike`, `prototype` — "any code written is thrown away" / "Definition of
 *     Done drops the test requirement": nothing.
 *   - everything else that reaches Build (`hotfix`, `security-patch`,
 *     `performance`, and any scope a fork adds) — build, then test.
 */
export function dodRolesFor(scope: string): readonly string[] {
  if (scope === "spike" || scope === "prototype") return [];
  if (scope === "docs") return ["lint"];
  return ["build", "test"];
}

/**
 * The scope's DoD commands, looked up by the ROLE the human wrote in
 * `workspace.yml` — never guessed from the command text.
 *
 * `roles` is `commandRoles.get(repo)`: `{build: "dotnet build", lint: "dotnet
 * format --verify-no-changes"}`. Matching on the string would have missed that
 * lint entirely (measured, 2026-08-29, on a real .NET workspace), and a rule that
 * silently finds nothing is worse than one that finds nothing loudly.
 *
 * A repo that declares none of the roles gets an empty list, which is a real
 * answer: see `dodIsSatisfiedEmpty` for what an empty DoD then means. Nothing
 * here can produce a command `workspace.yml` does not already hold.
 */
export function dodCommandsFor(scope: string, roles: ReadonlyMap<string, string> | undefined): readonly string[] {
  const declared = roles ?? new Map<string, string>();
  const out: string[] = [];
  for (const role of dodRolesFor(scope)) {
    const command = declared.get(role);
    if (command === undefined || command.trim() === "" || out.includes(command)) continue;
    out.push(command);
  }
  return out;
}

/**
 * An implicit story with no dod command is GREEN, not vacuously red.
 *
 * A real story's empty ```dod block is a Plan bug and blocks (spec §2.13, "done
 * means proven"): a human wrote a story and forgot to say how it would be proved.
 * An implicit story's empty dod is the opposite — it is the framework reporting,
 * accurately, that this scope has nothing to run: `spike`/`prototype` declare no
 * DoD by design, and a `docs` repo may genuinely have no lint command. Failing it
 * would mean a docs run can never finish, which is the bug this file exists to
 * fix, moved one step later.
 *
 * The reviewer still runs, and the epic still stops at a human gate.
 */
export function dodIsSatisfiedEmpty(plan: Pick<BuildPlan, "implicit">): boolean {
  return plan.implicit;
}

export interface ImplicitPlanParts {
  readonly runDir: string;
  readonly runId: string;
  readonly runTitle: string;
  /** `run.yml`'s `scope:` — named in the reason line and used to pick the DoD. */
  readonly scope: string;
  readonly repos: readonly string[];
  readonly workspace: WorkspaceContext;
  /** The Build stage's own ceiling, as scaled into `run.yml`. */
  readonly budgetUsd: number;
}

export interface ImplicitPlanContent {
  readonly repo: string;
  readonly title: string;
  readonly reason: string;
  readonly goal: readonly string[];
  readonly acceptance: readonly string[];
  readonly testPlan: readonly string[];
  readonly touches: readonly string[];
  readonly dod: readonly string[];
  readonly branch: string;
  readonly budgetUsd: number;
}

/** Everything the file says, derived — nothing read back from a previous write. */
export function implicitPlanContent(parts: ImplicitPlanParts): ImplicitPlanContent {
  const handoff = readOrEmpty(join(parts.runDir, WHAT_HANDOFF_REL));
  const metrics = readOrEmpty(join(parts.runDir, SUCCESS_METRICS_REL));

  const goal = cap(decisionBullets(handoff));
  const acceptanceRaw = cap(listItems(metrics));
  const cited = citedRepoPaths(handoff, parts.workspace);
  const repo = chooseRepo(parts.repos, cited);
  const touches = cited
    .filter((entry) => entry.repo === repo)
    .map((entry) => entry.path)
    .slice(0, MAX_IMPLICIT_TOUCHES);
  const dod = dodCommandsFor(parts.scope, parts.workspace.commandRoles.get(repo));

  // Success metrics first: they are the measurable half, and the developer prompt
  // renders `acceptance` as its Done-when list. The Decisions are still in the
  // prompt — the whole file is inlined as the story — so nothing is lost by
  // preferring the half that is testable.
  const acceptance = acceptanceRaw.length > 0
    ? acceptanceRaw
    : goal.length > 0
      ? goal
      : [`(no \`## Decisions\` bullet in ${WHAT_HANDOFF_REL} and no item in ${SUCCESS_METRICS_REL}` +
          " — the run title above is the whole brief)"];

  return {
    repo,
    title: parts.runTitle,
    reason: `Plan skipped by scope '${parts.scope}'`,
    goal,
    acceptance,
    testPlan: dod.length === 0
      ? [`(none — scope '${parts.scope}' declares no verifying command for this repo)`]
      : dod.map((command) => `$ ${command} → exit 0`),
    touches,
    dod,
    branch: epicBranchFor(parts.runId),
    budgetUsd: parts.budgetUsd,
  };
}

/**
 * `04-build/implicit-plan.yml`, byte-for-byte deterministic given the same run.
 *
 * `status:` and `evidence:` sit ABOVE the lists on purpose: `applyPlanPatch`
 * rewrites `evidence:` plus the list items directly under it, so the key that
 * follows it must not be a list of anything else.
 */
export function renderImplicitPlan(content: ImplicitPlanContent, status: PlanStatus = "todo"): string {
  const lines = [
    `# ${IMPLICIT_PLAN_REL} — written by the Build executor, not by a model.`,
    "#",
    `# ${content.reason}. This file is the plan that decision implies: one wave, one`,
    "# story, every line of it copied from what the run already wrote. It is also the",
    "# story's STATE — `status:` and `evidence:` below are what Build writes back.",
    "version: 1",
    "implicit: true",
    `reason: ${quote(content.reason)}`,
    `status: ${status}`,
    "evidence: []",
    `budget_usd: ${content.budgetUsd.toFixed(2)}`,
    "waves:",
    `  - {id: ${IMPLICIT_WAVE_ID}, stories: [${IMPLICIT_STORY_ID}]}`,
    "epic:",
    `  id: ${IMPLICIT_EPIC_ID}`,
    `  title: ${quote(content.title)}`,
    `  branch: ${content.branch}`,
    `  repos: [${content.repo}]`,
    `  stories: [${IMPLICIT_STORY_ID}]`,
    "story:",
    `  id: ${IMPLICIT_STORY_ID}`,
    `  epic: ${IMPLICIT_EPIC_ID}`,
    `  title: ${quote(content.title)}`,
    `  repo: ${content.repo}`,
    "  depends_on: []",
    ...block("touches", content.touches, `[]  # ${WHAT_HANDOFF_REL} cites no path inside a declared repo`),
    ...block("goal", content.goal, `[]  # ${WHAT_HANDOFF_REL} has no \`## Decisions\` bullet`),
    ...block("acceptance", content.acceptance, "[]"),
    ...block("test_plan", content.testPlan, "[]"),
    ...block("dod", content.dod, `[]  # scope declares no verifying command`),
    "",
  ];
  return lines.join("\n");
}

/** `key: [...]` when empty, else `key:` with one quoted item per line. */
function block(key: string, items: readonly string[], empty: string): readonly string[] {
  if (items.length === 0) return [`  ${key}: ${empty}`];
  return [`  ${key}:`, ...items.map((item) => `    - ${quote(item)}`)];
}

/**
 * The `BuildPlan` the executor runs, with the file written if it is not there yet.
 *
 * Written once and then read: a second `tldrx next` in the same run must see the
 * story's `status:` as the first one left it, not a freshly synthesised `todo`.
 */
export function loadImplicitPlan(parts: ImplicitPlanParts): BuildPlan {
  const path = implicitPlanPath(parts.runDir);
  const content = implicitPlanContent(parts);
  if (!existsSync(path)) {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, renderImplicitPlan(content), "utf8");
  }
  const text = readFileSync(path, "utf8");

  const story: Story = {
    version: 1,
    id: IMPLICIT_STORY_ID,
    epic: IMPLICIT_EPIC_ID,
    title: content.title,
    repo: content.repo,
    status: statusIn(text),
    depends_on: [],
    touches: content.touches,
    acceptance: content.acceptance,
    test_plan: content.testPlan,
    evidence: [],
  };
  const epic: Epic = {
    version: 1,
    id: IMPLICIT_EPIC_ID,
    title: content.title,
    repos: [content.repo],
    stories: [IMPLICIT_STORY_ID],
    branch: content.branch,
    status: story.status,
  };
  const plannedStory: PlannedStory = {
    story,
    // The commands come from the rendered `dod:` list, not from a fenced block:
    // there is no author here to have written one, and the list was already
    // checked against `workspace.yml` when it was built.
    dod: { present: content.dod.length > 0, commands: content.dod },
    text,
    path,
    rel: IMPLICIT_PLAN_REL,
    wave: IMPLICIT_WAVE_ID,
  };
  const plannedEpic: PlannedEpic = { epic, text, path, rel: IMPLICIT_PLAN_REL };

  return {
    waves: [{ id: IMPLICIT_WAVE_ID, stories: [plannedStory] }],
    epics: new Map([[IMPLICIT_EPIC_ID, plannedEpic]]),
    stories: new Map([[IMPLICIT_STORY_ID, plannedStory]]),
    storyCount: 1,
    implicit: true,
    source: IMPLICIT_PLAN_REL,
  };
}

/** One line for `tldrx next`'s stdout, naming what was synthesised and why. */
export function describeImplicitPlan(plan: BuildPlan, content: ImplicitPlanContent): string {
  const story = plan.stories.get(IMPLICIT_STORY_ID);
  return `implicit plan: ${content.reason} — one story ${IMPLICIT_STORY_ID} (` +
    `${String(story?.story.acceptance.length ?? 0)} acceptance, ` +
    `${String(content.touches.length)} touched path(s), ` +
    `dod: ${content.dod.length === 0 ? "none" : content.dod.join(", ")})`;
}

/** The implicit plan's `status:`/`evidence:`, patched the way a story file is. */
export function updateImplicitPlan(text: string, patch: StoryPatch): string {
  const patched = applyPlanPatch(text.split("\n"), patch);
  return patched.join("\n");
}

/** The top-level `status:` of an implicit plan file. */
export function statusIn(text: string): PlanStatus {
  const found = /^status\s*:\s*(\w+)\s*$/m.exec(text)?.[1];
  return isPlanStatus(found) ? found : "todo";
}

/** `run status` asks this: is the Build phase running off a synthesised plan? */
export function isImplicitPlanOnDisk(runDir: string): boolean {
  return existsSync(implicitPlanPath(runDir));
}

// --- the derivations --------------------------------------------------------

/** The `## Decisions` bullets of the What handoff, verbatim, tokens included. */
export function decisionBullets(handoffText: string): readonly string[] {
  if (handoffText === "") return [];
  return parseHandoff(handoffText).sections
    .filter((section) => section.name === "Decisions")
    .flatMap((section) => section.bullets.map((bullet) => bullet.text));
}

export interface CitedPath {
  readonly repo: string;
  /** Repo-relative, POSIX — the shape a story's `touches` is resolved in. */
  readonly path: string;
}

/**
 * Repo paths the What handoff cites that actually exist, first-cited order.
 *
 * A `[src: …]` token's `file` production is `[repo ":"] path ":" line`, so a
 * citation already names both halves. Only a repo `workspace.yml` declares
 * counts, and only a path that is on disk under it: a story's `touches` is
 * inlined into the developer's prompt from ITS OWN WORKTREE, so a path that is
 * not in that repo is not a file the developer could be shown.
 *
 * A citation with no repo prefix is skipped rather than guessed at — the run may
 * have several repos, and a wrong guess would put another repo's file in front of
 * an agent told it may edit only this one.
 */
export function citedRepoPaths(handoffText: string, workspace: WorkspaceContext): readonly CitedPath[] {
  const out: CitedPath[] = [];
  const seen = new Set<string>();
  if (handoffText === "") return out;
  for (const line of handoffText.split("\n")) {
    const token = parseSrcToken(line, new Set(workspace.repos.keys()));
    if (token === null) continue;
    for (const ref of token.refs) {
      if (ref.kind !== "file" || ref.repo === null) continue;
      const dir = repoPath(workspace, ref.repo);
      if (dir === null) continue;
      const key = `${ref.repo}:${ref.path}`;
      if (seen.has(key)) continue;
      if (!existsSync(join(dir, ref.path))) continue;
      seen.add(key);
      out.push({ repo: ref.repo, path: ref.path });
    }
  }
  return out;
}

/**
 * Which repo the one story belongs to: the run repo the handoff cites most.
 *
 * Ties, and a handoff that cites nothing, fall back to `run.repos` order — the
 * order a human wrote when they opened the run.
 */
export function chooseRepo(repos: readonly string[], cited: readonly CitedPath[]): string {
  const first = repos[0];
  if (first === undefined) {
    throw new ImplicitPlanError(
      "the run names no repo, so an implicit plan has nowhere to cut a branch — " +
      "re-open the run with `tldrx run new … --repo <name>`",
    );
  }
  let best = first;
  let bestCount = cited.filter((entry) => entry.repo === first).length;
  for (const repo of repos.slice(1)) {
    const count = cited.filter((entry) => entry.repo === repo).length;
    if (count > bestCount) {
      best = repo;
      bestCount = count;
    }
  }
  return best;
}

/** `epic/<slug>` from the run id, forced into `EPIC_BRANCH_RE`'s shape. */
export function epicBranchFor(runId: string): string {
  const slug = runId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 49);
  return `epic/${slug === "" ? "run" : slug}`;
}

// --- odds and ends ----------------------------------------------------------

function cap(items: readonly string[]): readonly string[] {
  return items
    .slice(0, MAX_LIST_ITEMS)
    .map((item) => (item.length > MAX_ITEM_CHARS ? `${item.slice(0, MAX_ITEM_CHARS - 1)}…` : item));
}

function isPlanStatus(value: string | undefined): value is PlanStatus {
  return value !== undefined && ["todo", "in_progress", "review", "done", "blocked"].includes(value);
}

function readOrEmpty(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}
