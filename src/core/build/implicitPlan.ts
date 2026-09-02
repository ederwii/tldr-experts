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
 *   touches     the repo paths those two documents cite, that exist, PLUS the
 *               documents this run's own answers settle by name, PLUS the
 *               documents its brief NAMES — including one not written yet, which
 *               is what a docs run's whole output is
 *   inputs      `01-what/questions.md` and the run's `--seed` documents, carried
 *               as content because neither is inside the story's worktree
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
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SKIPPED_DIRS } from "../detect/walk.ts";
import { parseYaml } from "../yaml.ts";
import { resolveDeclared } from "../facilitator/paths.ts";
import { listItems, parseHandoff } from "../text/handoff.ts";
import { parseQuestions } from "../text/questions.ts";
import { parseSrcToken, withoutSrcToken } from "../text/srcToken.ts";
import { MAX_ITEM_CHARS, MAX_LIST_ITEMS, type PlanStatus } from "../schemas/planCommon.ts";
import type { Story } from "../schemas/story.ts";
import type { Epic } from "../schemas/epic.ts";
import { isLive, MAX_FACT_CHARS, type Fact } from "../facts/Fact.ts";
import { repoPath, type WorkspaceContext } from "../../hooks/lib/workspace.ts";
import { PROJECT_FRAMEWORK_DIR, PROJECT_WORK_DIR } from "../paths.ts";
import { integrationBranchFor } from "../plan/branchModel.ts";
import { MAX_TOUCHED_BYTES, MAX_TOUCHED_FILES } from "./prompts.ts";
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

/** Said to the developer, in the prompt, because no design document will say it. */
export const IMPLICIT_STORY_NOTE =
  "Plan was skipped by the scope; this single story applies the run's answered decisions " +
  "to the files it touches.";

/**
 * The same line, naming the facts this story is FOR.
 *
 * With answers on record the goal list is nothing but apply-bullets and the
 * What's decisions have moved to `context:` — so the note has to say which list
 * is the work and which is the background, or a developer reads "Out of scope:
 * selecting an answer on the owner's behalf" as an instruction and stops. That
 * is the sentence the aparece run of 2026-08-30 handed its developer.
 */
export function implicitStoryNote(factIds: readonly string[]): string {
  if (factIds.length === 0) return IMPLICIT_STORY_NOTE;
  return `Plan was skipped by the scope; this story applies the run's answered decisions ` +
    `(${factRange(factIds)}) to the files listed under \`touches\`; the What's decisions below ` +
    "are background.";
}

/** `F005–F010` for a contiguous block, else every id, so the line stays true. */
export function factRange(ids: readonly string[]): string {
  if (ids.length < 3) return ids.join(", ");
  const numbers = ids.map((id) => Number.parseInt(id.slice(1), 10));
  const contiguous = numbers.every((n, i) => i === 0 || n === (numbers[i - 1] ?? 0) + 1);
  return contiguous ? `${ids[0] ?? ""}–${ids[ids.length - 1] ?? ""}` : ids.join(", ");
}

/** Where the What phase leaves the two documents the plan is synthesised from. */
export const WHAT_HANDOFF_REL = "01-what/handoff.md";
export const SUCCESS_METRICS_REL = "01-what/success-metrics.md";
/** Where the whole answer lives — always, and whether or not the fact row was cut. */
export const QUESTIONS_REL = "01-what/questions.md";

/** Spec §2.13's cap on a story's touched paths, narrowed to what a prompt inlines. */
export const MAX_IMPLICIT_TOUCHES = MAX_TOUCHED_FILES;

/**
 * Directory names that make a path the framework's own state.
 *
 * `.agent/` is listed beside the two roots because a bundle is cited by its own
 * relative path as often as by the full `tldrx-work/<run>/.agent/…` one.
 */
export const STATE_DIRS: readonly string[] = [PROJECT_WORK_DIR, PROJECT_FRAMEWORK_DIR, ".agent"];

/**
 * Is this path inside tldrx's own state?
 *
 * `touches` is built from what the What handoff CITES, and a handoff cites state
 * as evidence: measured on the aparece run of 2026-08-30, 13 touched paths of
 * which three were `run.yml`, `.tldrx/triage/**\/split.yml` and
 * `.agent/**\/prompt.md`. The developer prompt inlines every touched path and
 * tells the sub-agent that a change outside `touches` is a plan deviation — so
 * those three read as an invitation to rewrite the run's own bookkeeping. A story
 * writes product code and product documents; it never writes state.
 *
 * Segment-matched, not prefix-matched: in a `root_is_repo: true` workspace the
 * state sits at the repo root, and in the multi-repo shape a citation can reach
 * it through a subdirectory.
 */
export function isStatePath(path: string): boolean {
  return path.split("/").some((segment) => STATE_DIRS.includes(segment));
}

/** One note per path the state filter removed, so an exclusion is never silent. */
export function excludedNotes(paths: readonly string[]): readonly string[] {
  return paths.map((path) =>
    `excluded ${path} from touches: tldrx state is never story-writable`);
}

/**
 * How long ONE apply-bullet may be, which is not `MAX_ITEM_CHARS`.
 *
 * A bullet quotes a whole answer and 512 cuts a real one mid-sentence — the very
 * failure this file spent a wave removing, moved from `facts.yml` into the plan.
 * `MAX_FACT_CHARS` is the bound on the same words at their source, so it is the
 * bound here. Only `goal:` uses it; every other list is still §2.13's 512.
 */
export const MAX_APPLY_CHARS = MAX_FACT_CHARS;

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
  /**
   * Every row of `.tldrx/memory/facts.yml`. The ones stamped with THIS run are
   * the answers a human gave at its gates, and they are the work Build has to do.
   */
  readonly facts: readonly Fact[];
  /** The Build stage's own ceiling, as scaled into `run.yml`. */
  readonly budgetUsd: number;
}

export interface ImplicitPlanContent {
  readonly repo: string;
  readonly title: string;
  readonly reason: string;
  readonly goal: readonly string[];
  /**
   * The What stage's own Decisions, when the run has answers to apply.
   *
   * Background, never instructions. On the aparece run of 2026-08-30 they were
   * the whole of `goal:` and they read "Out of scope: selecting an answer on the
   * owner's behalf … every relevant ADR is status `proposed`" — the exact
   * opposite of the job the answers had just created. With no answers there is
   * no other statement of intent, so they stay in `goal:` as they always were.
   */
  readonly context: readonly string[];
  readonly acceptance: readonly string[];
  readonly testPlan: readonly string[];
  readonly touches: readonly string[];
  readonly dod: readonly string[];
  /** The fact→document mapping, and every gap in it. Written into the story. */
  readonly notes: readonly string[];
  /** Ids of the answered facts of this run, for the log line. */
  readonly factIds: readonly string[];
  /**
   * Files the developer prompt inlines beyond the story and its touched paths.
   *
   * Two kinds, and they resolve against two different roots — the same two
   * `facilitator/paths.ts` `resolveDeclared` has always resolved a declared input
   * against, run dir first and workspace root second:
   *
   *   - `01-what/questions.md`, run-relative — the only place the WHOLE answer
   *     lives, and the file every apply-bullet cites by line.
   *   - this run's `--seed` documents, workspace-root-relative — the sources of
   *     truth the run was opened from. They are never copied into the run and
   *     they need not be inside the story's repo, so inlining their content is
   *     the ONLY way a sub-agent standing in one repo's worktree can read them.
   */
  readonly inputs: readonly string[];
  readonly branch: string;
  readonly budgetUsd: number;
}

/** Everything the file says, derived — nothing read back from a previous write. */
export function implicitPlanContent(parts: ImplicitPlanParts): ImplicitPlanContent {
  const handoff = readOrEmpty(join(parts.runDir, WHAT_HANDOFF_REL));
  const metrics = readOrEmpty(join(parts.runDir, SUCCESS_METRICS_REL));

  const cited = citedRepoPaths(handoff, parts.workspace);
  const repo = chooseRepo(parts.repos, cited);
  const inRepo = cited.filter((entry) => entry.repo === repo).map((entry) => entry.path);
  // The handoff cites the run's own state as EVIDENCE; a story may never write
  // it. Dropped here rather than at render time so nothing downstream — the
  // prompt's inlining, `planFacts`, the fact-named search — ever sees them.
  const excluded = inRepo.filter(isStatePath);
  const citedTouches = inRepo
    .filter((path) => !isStatePath(path))
    .slice(0, MAX_IMPLICIT_TOUCHES);
  const dod = dodCommandsFor(parts.scope, parts.workspace.commandRoles.get(repo));

  const facts = runFacts(parts.facts, parts.runId);
  const index = answerIndex(parts.runDir);

  // A document a fact SETTLES belongs in `touches` even when the What never cited
  // it. Measured on the aparece run of 2026-08-30: F010 decided ADR-D013 and the
  // handoff never mentioned the file, so the story's `touches` left it out and
  // the developer prompt forbids changes outside `touches` — the one story of the
  // run could not do the thing the run was for.
  const added = touchesNamedByFacts({
    facts,
    answers: index.answers,
    repoDir: repoPath(parts.workspace, repo) ?? "",
    existing: citedTouches,
    limit: MAX_IMPLICIT_TOUCHES,
  });
  // A document the run's own BRIEF names belongs in `touches` too — including one
  // that does not exist yet, which is the normal shape of a docs run. Measured on
  // the 260902-discovery-pipeline-map run (gh #111): the run existed to write
  // `docs/discovery-pipeline-map.md`, its success metrics said so by name, and
  // `touches` came out EMPTY — a story whose write surface forbids every change
  // it was opened to make. `touchedInputs` already renders a path with no file
  // behind it as "(does not exist yet — this story creates it)", so the only
  // thing missing was the path.
  const briefAdded = touchesNamedInBrief({
    bullets: [
      ...decisionBullets(handoff).map((text) => ({ where: WHAT_HANDOFF_REL, text })),
      ...listItems(metrics).map((text) => ({ where: SUCCESS_METRICS_REL, text })),
    ],
    repoDir: repoPath(parts.workspace, repo) ?? "",
    existing: [...citedTouches, ...added.map((entry) => entry.path)],
    limit: MAX_IMPLICIT_TOUCHES,
  });
  const touches = [
    ...citedTouches, ...added.map((entry) => entry.path), ...briefAdded.map((entry) => entry.path),
  ].slice(0, MAX_IMPLICIT_TOUCHES);

  // The run's `--seed` documents: the sources of truth this run was opened from.
  // They live at the WORKSPACE root and are never copied, so a story worktree of
  // one repo cannot open them by the path the handoff cites (gh #111, defect 2:
  // the driver rewrote every read to an absolute path by hand). Carried as
  // INPUTS, whose content the prompt inlines, rather than as touches: they are
  // the team's own documents and this story does not write them.
  const seeds = carriedSeeds(seedDocuments(parts.runDir), parts.workspace.root);

  // The answers a human gave at this run's gates, and which touched document each
  // one settles. This is the half that makes the plan about Build's work rather
  // than a transcript of What's.
  const answered = planFacts(facts, touches, index.answers);

  // Everything the What stage said, MINUS the bullets whose subject was the What
  // stage's own output. `questions.md` has been written; telling a developer to
  // write it is the one instruction that is certainly wrong here. What was
  // dropped, and on which signal, goes into `notes:` — a filter whose mistakes
  // are invisible is a filter nobody can correct.
  const dropped: { where: string; bullet: string }[] = [];
  const keep = (where: string) => (bullet: string): boolean => {
    if (!isWhatDeliverable(bullet)) return true;
    dropped.push({ where, bullet });
    return false;
  };
  // Where the What's decisions are headed decides what a dropped one is dropped
  // FROM, and the note has to say the list it was actually dropped from.
  const decisionsInto = facts.length > 0 ? "context" : "goal";
  const whatDecisions = decisionBullets(handoff).filter(keep(decisionsInto));
  const applied = applyGoals(answered, index);
  // With answers on record the goal is the WORK and nothing else; the What's
  // decisions become `context:`. With none, they are the only statement of
  // intent the run has, so they stay exactly where they always were.
  const goal = answered.facts.length > 0
    ? cap(applied, MAX_APPLY_CHARS)
    : cap(whatDecisions);
  const context = answered.facts.length > 0 ? cap(whatDecisions) : [];
  const acceptanceRaw = cap([
    ...listItems(metrics).filter(keep("acceptance")),
    ...applyAcceptance(answered),
  ]);

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
    context,
    acceptance,
    testPlan: dod.length === 0
      ? [`(none — scope '${parts.scope}' declares no verifying command for this repo)`]
      : dod.map((command) => `$ ${command} → exit 0`),
    touches,
    dod,
    notes: cap([
      ...excludedNotes(excluded), ...addedNotes(added), ...briefNotes(briefAdded),
      ...emptyTouchesNote(touches, repo), ...seedNotes(seeds, repo),
      ...factNotes(answered), ...droppedNotes(dropped),
    ]),
    factIds: answered.facts.map((fact) => fact.id),
    inputs: [...(index.lines.size > 0 ? [QUESTIONS_REL] : []), ...seeds.carried],
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
    ...block("touches", content.touches,
      `[]  # neither ${WHAT_HANDOFF_REL} nor ${SUCCESS_METRICS_REL} names a path inside a declared repo`),
    ...block("inputs", content.inputs, `[]  # this run wrote no ${QUESTIONS_REL} and imported no seed document`),
    ...block("goal", content.goal, `[]  # ${WHAT_HANDOFF_REL} has no \`## Decisions\` bullet`),
    ...block("context", content.context, "[]  # nothing to apply, so the What's decisions ARE the goal above"),
    ...block("acceptance", content.acceptance, "[]"),
    ...block("test_plan", content.testPlan, "[]"),
    ...block("dod", content.dod, `[]  # scope declares no verifying command`),
    ...block("notes", content.notes, "[]  # this run has answered no question, so there is nothing to apply"),
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
  // `01-what/questions.md` lives in the RUN dir and a `--seed` document lives at
  // the WORKSPACE root; neither is in the story's worktree, so neither can ever
  // arrive through `touches`. They are read here and handed to the prompt as
  // content, which is the only way a sub-agent told to read nothing else can be
  // shown the answers and the requirements its story is about. `resolveDeclared`
  // is the same two-base resolution the What stage's own inputs already use.
  const pathCtx = { root: parts.workspace.root, runDir: parts.runDir };
  const extraInputs = content.inputs
    .map((rel) => ({ path: rel, content: readOrEmpty(resolveDeclared(rel, pathCtx)) }))
    .filter((input) => input.content !== "");
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
    context: content.context,
    extraInputs,
    note: implicitStoryNote(content.factIds),
    goal: content.goal,
  };
  const plannedEpic: PlannedEpic = { epic, text, path, rel: IMPLICIT_PLAN_REL };

  return {
    waves: [{ id: IMPLICIT_WAVE_ID, stories: [plannedStory] }],
    epics: new Map([[IMPLICIT_EPIC_ID, plannedEpic]]),
    stories: new Map([[IMPLICIT_STORY_ID, plannedStory]]),
    storyCount: 1,
    implicit: true,
    source: IMPLICIT_PLAN_REL,
    // Nobody planned this run, so nobody priced its one story: the executor falls
    // back to the uniform share, which for a single story is the whole stage.
    prices: new Map(),
    priceIssue: null,
  };
}

/** One line for `tldrx next`'s stdout, naming what was synthesised and why. */
export function describeImplicitPlan(plan: BuildPlan, content: ImplicitPlanContent): string {
  const story = plan.stories.get(IMPLICIT_STORY_ID);
  return `implicit plan: ${content.reason} — one story ${IMPLICIT_STORY_ID} (` +
    `${String(story?.story.acceptance.length ?? 0)} acceptance, ` +
    `${String(content.touches.length)} touched path(s), ` +
    `${content.factIds.length === 0 ? "no answered fact" : `applying ${content.factIds.join(", ")}`}, ` +
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

// --- re-deriving the plan (`--prepare --discard-pending`) --------------------

/**
 * Whether the file on disk may be thrown away and written again.
 *
 * The plan is also the STATE, so re-deriving it rewinds a story. That is only
 * safe while the story has produced nothing: `evidence:` empty (no dod run, no
 * commit sha, no review log recorded) and `status:` not settled. The caller adds
 * the half this file cannot see — that `git log <epic>..<story>` is empty — and
 * both must hold.
 *
 * A refusal is a sentence, not a boolean: the operator has to be told which of
 * the two conditions stopped it.
 */
export function implicitPlanIsStale(text: string): string | null {
  const status = statusIn(text);
  if (status === "done" || status === "blocked") {
    return `the story is already \`${status}\``;
  }
  const evidence = /^evidence:\s*\[\s*\]\s*$/m.test(text);
  if (!evidence) return "the story has recorded evidence";
  return null;
}

/** Throw the file away so the next `loadImplicitPlan` writes it from scratch. */
export function discardImplicitPlan(runDir: string): void {
  rmSync(implicitPlanPath(runDir), { force: true });
}

// --- the derivations --------------------------------------------------------

/** The `## Decisions` bullets of the What handoff, verbatim, tokens included. */
export function decisionBullets(handoffText: string): readonly string[] {
  if (handoffText === "") return [];
  return parseHandoff(handoffText).sections
    .filter((section) => section.name === "Decisions")
    .flatMap((section) => section.bullets.map((bullet) => bullet.text));
}

/**
 * The facts THIS run produced: answers a human gave at its gates.
 *
 * Keyed on `source.run`, which is the run id every `tldrx answer` stamps. A
 * retired or superseded fact is not the answer any more and is left out — the
 * same rule the no-re-ask hook applies. A run that reversed one of its own
 * answers must plan off the reversal, not off both halves of it.
 */
export function runFacts(facts: readonly Fact[], runId: string): readonly Fact[] {
  return facts.filter((fact) => isLive(fact) && fact.source.run === runId);
}

/**
 * Signals that a bullet's subject is the WHAT stage's own deliverable.
 *
 * Every one is a LITERAL the run's own documents actually use, never an
 * inference about intent. Measured on the aparece run: the first three caught
 * three of six bullets and left "Every question names what is blocked", "No
 * recorded fact is re-asked" and "Gate passes" behind — three criteria about
 * `01-what/questions.md`'s contents that never name the file. The last three
 * signals are exactly what those three say instead.
 *
 * Whatever is dropped is written into the story's `notes:`, so a bullet this
 * gets wrong is visible to the person reading the plan rather than gone.
 */
export const WHAT_SIGNALS: readonly { readonly name: string; readonly test: (bullet: string) => boolean }[] = [
  // Path-boundary matched, not substring matched. `b.includes("questions.md")`
  // also fires on `seeds/pipeline-questions.md` — a document the TEAM wrote, and
  // the source of truth of the run gh #111 was filed from. Both of that run's
  // `## Decisions` bullets cited it, both were read as the What stage's own
  // output, and `goal:` came out empty.
  { name: "questions.md", test: (b) => /(?:^|[^\w-])questions\.md/.test(b) },
  { name: "### Q", test: (b) => b.includes("### Q") },
  // Any path inside the What phase: `01-what/handoff.md`, `01-what/scope.md`.
  { name: "01-what/", test: (b) => b.includes("01-what/") },
  // A question id of this run: `Q1`, `Q1–Q6`, `Q1, Q3, Q4`.
  { name: "a question id", test: (b) => /\bQ\d{1,3}\b/.test(b) },
  // "Every question names…", "each question's why-text", "the question count".
  { name: "the run's questions", test: (b) => /\b(?:each|every|no|the)\s+(?:recorded\s+)?questions?\b/i.test(b) },
];

/**
 * A bullet whose subject is the What stage's own deliverable, not Build's work.
 *
 * Errs towards dropping ONLY because `whatSignal` records what it dropped and
 * why: a bullet about `04-build/`, or about a file the story touches, matches no
 * signal and survives.
 */
export function isWhatDeliverable(bullet: string): boolean {
  return whatSignal(bullet) !== null;
}

/**
 * Which signal fired, for the note. Null when the bullet is Build's work.
 *
 * A bullet that NAMES A PRODUCT DOCUMENT is Build's work whatever else it says.
 * The sentence above this list has claimed that since it was written — "a bullet
 * about `04-build/`, or about a file the story touches, matches no signal and
 * survives" — and it was not true: the signals were tested against the whole
 * bullet with nothing to weigh them against. Measured on the
 * 260902-discovery-pipeline-map run (gh #111), the criterion
 *
 *   "All four seed questions (Q1–Q4) have a dedicated section in
 *    `docs/discovery-pipeline-map.md`"
 *
 * — the run's core acceptance criterion, and the only measurable one — was
 * dropped on `a question id`, leaving the story with the "(no `## Decisions`
 * bullet …)" placeholder as its whole Done-when list. Naming a question is how a
 * document ABOUT the questions is specified; it is not evidence that the subject
 * is `01-what/questions.md`. The document named is.
 *
 * The signals are unchanged and still drop what they always dropped: the aparece
 * bullets that fired them ("Every question names what is blocked", "No recorded
 * fact is re-asked", "Gate passes") name no product document and are dropped
 * exactly as before.
 */
export function whatSignal(bullet: string): string | null {
  // The CLAIM, not its evidence: §2.8's token says where a bullet was CHECKED,
  // and reading it as the subject gets the answer wrong in both directions —
  // "In scope: one `questions.md` block per open ADR [src: app:docs/adr/…]" is
  // about the What's own file, and "Rewrite § Install [src: 01-what/handoff.md:3]"
  // is Build's work. Only the prose says which.
  const claim = withoutSrcToken(bullet);
  if (productPathsIn(claim).length > 0) return null;
  return WHAT_SIGNALS.find((signal) => signal.test(claim))?.name ?? null;
}

/**
 * A run phase directory — `01-what/`, `03-plan/`, `04-build/`. A path under one
 * is the framework's own document, never a product document.
 */
const PHASE_DIR_RE = /^\d\d-[a-z][a-z0-9-]*\//;

/**
 * The What stage's own outputs, by bare file name.
 *
 * A bullet writes `questions.md` as often as `01-what/questions.md`, and the
 * unqualified form has to mean the same thing — otherwise dropping the phase
 * prefix would turn the What's own deliverable into a product document.
 */
export const WHAT_OUTPUT_NAMES: readonly string[] = [
  "questions.md", "handoff.md", "intent.md", "scope.md", "success-metrics.md", "seed-index.md",
];

/**
 * Every path-shaped token in a line, in first-named order.
 *
 * Deliberately narrow: a name, optional directories, and an extension of at
 * least two letters starting with a letter. `e.g.` and `0.5.1` are not paths and
 * must not become one — the extension rule is what refuses them.
 */
const PATH_TOKEN_RE = /(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_][A-Za-z0-9_.-]*\.[A-Za-z][A-Za-z0-9]{1,5}(?![A-Za-z0-9])|[A-Za-z0-9_][A-Za-z0-9_.-]*\.[A-Za-z][A-Za-z0-9]{1,5}(?![A-Za-z0-9])/g;

export function pathsIn(text: string): readonly string[] {
  return [...new Set(text.match(PATH_TOKEN_RE) ?? [])];
}

/**
 * The paths a line names that are a PRODUCT document — not the run's own state,
 * not a phase output, not the What stage's own file under a bare name.
 */
export function productPathsIn(text: string): readonly string[] {
  return pathsIn(text).filter((path) =>
    !PHASE_DIR_RE.test(path)
    && !isStatePath(path)
    && !(!path.includes("/") && WHAT_OUTPUT_NAMES.includes(path)));
}

/** One note per dropped bullet, naming the signal and the bullet's opening. */
export function droppedNotes(dropped: readonly { readonly where: string; readonly bullet: string }[]): readonly string[] {
  return dropped.map((entry) =>
    `dropped from ${entry.where} as the What stage's own work ` +
    `(mentions ${whatSignal(entry.bullet) ?? "?"}): ${head(entry.bullet)}`);
}

/** Enough of a bullet to recognise it, without repeating the whole thing. */
function head(bullet: string, max = 90): string {
  const line = bullet.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * The decision this touched file IS: its ADR id, plus a `decision <n>` if the
 * name carries one.
 *
 * Both forms of an ADR id are returned — `ADR-D008` and the bare `D008` — since
 * a human writing a fact may use either. A leading number (`13-OPEN-DECISIONS.md`)
 * is deliberately NOT a decision number: it is a document number, and reading it
 * as one would let any fact mentioning "13" claim to settle that file.
 */
export function decisionKeysOf(path: string): readonly string[] {
  const keys: string[] = [];
  const name = path.split("/").pop() ?? path;
  for (const match of name.matchAll(/ADR-([A-Za-z]?\d{1,4})/g)) {
    keys.push(match[0]);
    if (match[1] !== undefined) keys.push(match[1]);
  }
  for (const match of name.matchAll(/(?:decision|adr)[-_ ]?#?(\d{1,4})/gi)) {
    if (match[1] !== undefined) keys.push(`decision ${match[1]}`);
  }
  return [...new Set(keys)];
}

export interface FactMapping {
  readonly factId: string;
  readonly path: string;
  /** The token that connected them — quoted in the story so it can be checked. */
  readonly key: string;
}

export interface FactPlan {
  readonly facts: readonly Fact[];
  readonly mappings: readonly FactMapping[];
  /** Touched files no fact of this run names. */
  readonly unmappedPaths: readonly string[];
  /** Facts that settle no touched file. */
  readonly unmappedFactIds: readonly string[];
}

/**
 * Which fact settles which touched document.
 *
 * "Settles" is deliberately narrow: the fact's own text mentions the file's ADR
 * id or decision number. That is a claim anyone can re-check by reading the two
 * strings, which is the only kind of mapping worth writing into a plan. Where it
 * cannot be derived the plan SAYS SO rather than inventing a pairing.
 */
export function wasTruncated(text: string): boolean {
  return text.length >= MAX_FACT_CHARS;
}

/**
 * What `01-what/questions.md` holds, in the three shapes the plan needs.
 *
 * `.tldrx/memory/facts.yml` caps a fact (spec §2.5) and `captureAnswers` builds
 * it as `"<question> — <answer>"`, so a long answer is cut — on the aparece run
 * of 2026-08-30, four of six lost the very clause that names the ADR they settle.
 * `questions.md` still holds the whole thing under `[Answer]:`, and a question
 * block's footer carries the fact id it produced, so either key finds it.
 *
 * Every map is keyed by BOTH the question id and the fact id:
 *   `answers`  the `[Answer]:` capture, verbatim — what the mapping matches on
 *   `restated` `"<title> — <answer>"`, i.e. the fact the cap would have written
 *              had it not run out; what an apply-bullet quotes
 *   `lines`    the 1-based line of the `[Answer]:` slot in the file, so a bullet
 *              can cite where the words it quotes actually are
 */
export interface AnswerIndex {
  readonly answers: ReadonlyMap<string, string>;
  readonly restated: ReadonlyMap<string, string>;
  readonly lines: ReadonlyMap<string, number>;
}

export const EMPTY_ANSWER_INDEX: AnswerIndex = {
  answers: new Map(), restated: new Map(), lines: new Map(),
};

export function answerIndex(runDir: string): AnswerIndex {
  const answers = new Map<string, string>();
  const restated = new Map<string, string>();
  const lines = new Map<string, number>();
  const text = readOrEmpty(join(runDir, QUESTIONS_REL));
  if (text === "") return { answers, restated, lines };
  for (const block of parseQuestions(text).blocks) {
    if (block.answer.trim() === "" || block.answerIndex === -1) continue;
    const keys = [block.id, block.footer?.fact ?? ""].filter((key) => key !== "");
    for (const key of keys) {
      answers.set(key, block.answer);
      restated.set(key, `${block.title} — ${block.answer}`);
      // `startLine` is the 1-based line of the `## Q…` heading and `answerIndex`
      // the offset of the `[Answer]:` line inside the block, heading at 0.
      lines.set(key, block.startLine + block.answerIndex);
    }
  }
  return { answers, restated, lines };
}

/** The `answers` half on its own — the shape `planFacts` takes. */
export function answersByQuestion(runDir: string): ReadonlyMap<string, string> {
  return answerIndex(runDir).answers;
}

/** The answer behind a fact, by its question id or by its own id. Empty when none. */
export function answerFor(fact: Fact, answers: ReadonlyMap<string, string>): string {
  return answers.get(fact.source.q ?? "") ?? answers.get(fact.id) ?? "";
}

/**
 * What a fact's mapping is matched against: its own text, PLUS the full answer
 * behind it.
 *
 * Both halves, never the answer alone — a fact whose stored text carries a key
 * the answer does not must keep matching on it. It used to append the answer
 * only when the stored text had hit the cap, which tied the mapping to the exact
 * value of `MAX_FACT_CHARS`: raising the cap on 2026-08-30 would have silently
 * switched the fallback off for every fact already on disk. Concatenating
 * unconditionally cannot match less than the fact alone, so there is nothing the
 * old gate was buying.
 */
export function matchTextOf(fact: Fact, answers: ReadonlyMap<string, string>): string {
  const full = answerFor(fact, answers);
  return full === "" || fact.fact.includes(full) ? fact.fact : `${fact.fact}\n${full}`;
}

export function planFacts(
  facts: readonly Fact[],
  touches: readonly string[],
  answers: ReadonlyMap<string, string> = new Map(),
): FactPlan {
  const mappings: FactMapping[] = [];
  const mappedPaths = new Set<string>();
  const mappedFacts = new Set<string>();
  // One row per (fact, file). `decisionKeysOf` returns `ADR-D008` AND the bare
  // `D008`, and both match the same sentence — recording the pair twice would
  // double every citation and every note about it. The FIRST key wins, which is
  // the longer, more specific spelling.
  const seen = new Set<string>();
  for (const path of touches) {
    for (const key of decisionKeysOf(path)) {
      for (const fact of facts) {
        if (!matchTextOf(fact, answers).toLowerCase().includes(key.toLowerCase())) continue;
        if (seen.has(`${fact.id}\u0000${path}`)) continue;
        seen.add(`${fact.id}\u0000${path}`);
        mappings.push({ factId: fact.id, path, key });
        mappedPaths.add(path);
        mappedFacts.add(fact.id);
      }
    }
  }
  return {
    facts,
    mappings,
    unmappedPaths: touches.filter((path) => !mappedPaths.has(path)),
    unmappedFactIds: facts.filter((fact) => !mappedFacts.has(fact.id)).map((fact) => fact.id),
  };
}

/**
 * One `Apply <answer> …` goal per answered fact of this run, in id order.
 *
 * The bullet quotes the WHOLE answer, read back from `01-what/questions.md`, not
 * the row in `facts.yml` — that row is what fits in a fact and a developer given
 * "Accepts ADR-D009 as writt" has been handed a sentence that stops before it
 * says anything. It cites both: `F<n>` for the fact, and the questions file at
 * the line of the `[Answer]:` slot the words were taken from, so the quote is
 * checkable against its source rather than trusted.
 */
export function applyGoals(plan: FactPlan, index: AnswerIndex = EMPTY_ANSWER_INDEX): readonly string[] {
  return plan.facts.map((fact) => {
    const key = index.restated.has(fact.source.q ?? "") ? (fact.source.q ?? "") : fact.id;
    const whole = index.restated.get(key) ?? fact.fact;
    const line = index.lines.get(key);
    const cite = line === undefined
      ? fact.id
      : `${fact.id}; ${QUESTIONS_REL}:${String(line)}`;
    return `Apply ${whole} to the touched files [src: ${cite}]`;
  });
}

// --- the documents a fact names, which the What never cited ------------------

/** One document added to `touches` because a fact of this run settles it. */
export interface AddedTouch {
  readonly path: string;
  readonly factId: string;
  /** The token that connected them — the same one `planFacts` will re-derive. */
  readonly key: string;
}

/**
 * How many files the search may look at before giving up.
 *
 * The walk exists to find `ADR-D013-*.md` in a docs tree, not to index a
 * monorepo. A bound that is reached is reported by finding nothing, which is the
 * same answer the run got before this existed.
 */
export const MAX_SCANNED_FILES = 20_000;

/**
 * Repo-relative paths of every file whose NAME carries a decision key, nearest
 * first.
 *
 * "Nearest" is the directories the story already touches, in order, then the
 * whole repo breadth-first. The ADR a fact settles is almost always beside the
 * ADRs the handoff did cite, and looking there first keeps the answer stable
 * when two trees hold a file of the same name.
 */
export function findDecisionDocuments(repoDir: string, preferredDirs: readonly string[]): readonly string[] {
  if (repoDir === "" || !existsSync(repoDir)) return [];
  const found: string[] = [];
  const seen = new Set<string>();
  let scanned = 0;

  const take = (rel: string): void => {
    if (seen.has(rel) || decisionKeysOf(rel).length === 0) return;
    seen.add(rel);
    found.push(rel);
  };
  const filesIn = (rel: string): readonly string[] => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(join(repoDir, rel), { withFileTypes: true });
    } catch {
      return [];
    }
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
  };

  for (const dir of preferredDirs) {
    for (const name of filesIn(dir)) {
      scanned++;
      take(dir === "" ? name : `${dir}/${name}`);
    }
  }

  const queue: string[] = [""];
  while (queue.length > 0 && scanned < MAX_SCANNED_FILES) {
    const dir = queue.shift() ?? "";
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(join(repoDir, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const rel = dir === "" ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (SKIPPED_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        queue.push(rel);
        continue;
      }
      if (!entry.isFile()) continue;
      scanned++;
      if (scanned > MAX_SCANNED_FILES) break;
      take(rel);
    }
  }
  return found;
}

export interface TouchesNamedByFactsParts {
  readonly facts: readonly Fact[];
  readonly answers: ReadonlyMap<string, string>;
  /** Absolute directory of the story's repo. Empty ⇒ nothing to search. */
  readonly repoDir: string;
  /** What is already in `touches` — never added twice, and the search's home. */
  readonly existing: readonly string[];
  readonly limit: number;
}

/**
 * Documents a fact of this run settles BY NAME that `touches` does not hold.
 *
 * The mapping rule is exactly `planFacts`': the file's own ADR id or decision
 * number appears in the fact's text or in the full answer behind it. The only
 * difference is the direction — `planFacts` asks "which fact settles this
 * touched file?", this asks "which file does this fact settle?" — so a document
 * cannot be added here and then go unmapped there.
 */
export function touchesNamedByFacts(parts: TouchesNamedByFactsParts): readonly AddedTouch[] {
  if (parts.facts.length === 0) return [];
  const room = parts.limit - parts.existing.length;
  if (room <= 0) return [];

  const already = new Set(parts.existing);
  const dirs: string[] = [];
  for (const path of parts.existing) {
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    if (!dirs.includes(dir)) dirs.push(dir);
  }

  const out: AddedTouch[] = [];
  for (const rel of findDecisionDocuments(parts.repoDir, dirs)) {
    if (already.has(rel) || out.length >= room) continue;
    const hit = firstFactNaming(rel, parts.facts, parts.answers);
    if (hit === null) continue;
    out.push({ path: rel, factId: hit.factId, key: hit.key });
  }
  return out;
}

/** The first fact of this run whose text names one of this path's decision keys. */
function firstFactNaming(
  path: string,
  facts: readonly Fact[],
  answers: ReadonlyMap<string, string>,
): { readonly factId: string; readonly key: string } | null {
  for (const key of decisionKeysOf(path)) {
    for (const fact of facts) {
      if (matchTextOf(fact, answers).toLowerCase().includes(key.toLowerCase())) {
        return { factId: fact.id, key };
      }
    }
  }
  return null;
}

/** One note per document the facts pulled in, so an addition is never silent. */
export function addedNotes(added: readonly AddedTouch[]): readonly string[] {
  return added.map((entry) =>
    `added ${entry.path} to touches: settled by ${entry.factId} (its text mentions \`${entry.key}\`)`);
}

// --- the write surface the run's own brief names ----------------------------

/** A bullet of the run's brief, and which document it came from. */
export interface BriefBullet {
  readonly where: string;
  readonly text: string;
}

export interface BriefTouch {
  readonly path: string;
  readonly where: string;
  /** False when the repo has no file there yet — the story CREATES it. */
  readonly exists: boolean;
}

export interface TouchesNamedInBriefParts {
  readonly bullets: readonly BriefBullet[];
  readonly repoDir: string;
  readonly existing: readonly string[];
  readonly limit: number;
}

/**
 * Documents the run's own brief NAMES that `touches` does not already hold.
 *
 * `citedRepoPaths` can only find a path that is BOTH cited with a repo prefix and
 * already on disk, and a docs run's whole output is a document that is neither.
 * Measured on the 260902-discovery-pipeline-map run (gh #111): the run existed to
 * write `docs/discovery-pipeline-map.md`, its `01-what/success-metrics.md` named
 * that file in its first criterion, the seeded handoff cited only workspace-root
 * paths — and the story shipped with `touches: []`. The developer prompt tells a
 * sub-agent that a change outside `touches` is a plan deviation, so an empty list
 * is not a small omission: it forbids the whole story.
 *
 * Two ways in, and no third:
 *   - the repo HAS the file — the brief names something real;
 *   - the path has a directory and the repo HAS that directory — a new file in a
 *     place that exists, which is what "write this document" looks like before
 *     it is written.
 *
 * A bare name the repo does not have (`Node.js`, `package.json` in a repo with no
 * such file) is refused: prose is full of dotted words, and inventing a top-level
 * file out of one is how a filter earns its distrust.
 */
export function touchesNamedInBrief(parts: TouchesNamedInBriefParts): readonly BriefTouch[] {
  const already = new Set(parts.existing);
  const out: BriefTouch[] = [];
  const room = parts.limit - parts.existing.length;
  if (room <= 0 || parts.repoDir === "") return out;

  for (const bullet of parts.bullets) {
    // The CLAIM, not its `[src: …]`: a citation is already handled by
    // `citedRepoPaths`, and reading one as a write target would put a document
    // the bullet merely quoted on the story's write surface.
    for (const path of productPathsIn(withoutSrcToken(bullet.text))) {
      if (already.has(path) || out.length >= room) continue;
      const exists = existsSync(join(parts.repoDir, path));
      const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      if (!exists && (dir === "" || !isDirectory(join(parts.repoDir, dir)))) continue;
      already.add(path);
      out.push({ path, where: bullet.where, exists });
    }
  }
  return out;
}

/** One note per document the brief pulled in, so an addition is never silent. */
export function briefNotes(added: readonly BriefTouch[]): readonly string[] {
  return added.map((entry) => entry.exists
    ? `added ${entry.path} to touches: named by ${entry.where}`
    : `added ${entry.path} to touches: named by ${entry.where} and not on disk — this story creates it`);
}

/**
 * The one note a story with NO write surface owes its reader.
 *
 * A `touches: []` renders as an empty list with a comment, which reads like a
 * detail. It is not: every change the story could make is outside it.
 */
export function emptyTouchesNote(touches: readonly string[], repo: string): readonly string[] {
  if (touches.length > 0) return [];
  return [
    `touches is empty: nothing ${WHAT_HANDOFF_REL} cites and nothing ${SUCCESS_METRICS_REL} names is ` +
    `inside repo '${repo}', so this story has no write surface — name the document it is to write`,
  ];
}

// --- the seed documents this run was opened from ----------------------------

/**
 * `[assumption]` — how many bytes of `--seed` documents one story bundle carries.
 *
 * The same 64 KB `prompts.ts` spends on a story's touched files, and for the same
 * reason: a seed can be a directory of fifty documents, and a prompt that inlines
 * all of them has no room left for the files the story writes.
 */
export const MAX_SEED_CARRY_BYTES = MAX_TOUCHED_BYTES;

export interface CarriedSeeds {
  /** Workspace-root-relative, in declaration order — inlined into the prompt. */
  readonly carried: readonly string[];
  /** Declared, present, and over the byte budget. Named in `notes:`, never silent. */
  readonly skipped: readonly string[];
}

/**
 * The `--seed` documents this run declared, workspace-root-relative.
 *
 * Read from `run.yml`'s FIRST stage, which is where `run new --seed` declares
 * them (`newRun.declareSeedInputs`). A declared input that is neither
 * workspace-prefixed (`.tldrx/…`) nor run-relative (`01-what/…`) is a seed
 * document — that is exactly the third case `facilitator/paths.ts`
 * `resolveDeclared` was written for, stated from the other side.
 *
 * An unreadable or seedless `run.yml` is an empty list, not a throw: the implicit
 * plan is derived from what the run HAS, and a run with no seeds is the ordinary
 * case.
 */
export function seedDocuments(runDir: string): readonly string[] {
  const text = readOrEmpty(join(runDir, "run.yml"));
  if (text === "") return [];
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch {
    return [];
  }
  const phases = (doc as { phases?: unknown }).phases;
  if (!Array.isArray(phases)) return [];
  const stages = (phases[0] as { stages?: unknown } | undefined)?.stages;
  if (!Array.isArray(stages)) return [];
  const inputs = (stages[0] as { inputs?: unknown } | undefined)?.inputs;
  if (!Array.isArray(inputs)) return [];
  return inputs.filter((entry): entry is string =>
    typeof entry === "string"
    && entry !== ""
    && !PHASE_DIR_RE.test(entry)
    && !isStatePath(entry));
}

/** Which of them fit the bundle's inline budget, in declaration order. */
export function carriedSeeds(documents: readonly string[], root: string): CarriedSeeds {
  const carried: string[] = [];
  const skipped: string[] = [];
  let spent = 0;
  for (const rel of documents) {
    const abs = join(root, rel);
    if (!existsSync(abs)) continue;
    const size = sizeOf(abs);
    if (spent + size > MAX_SEED_CARRY_BYTES) {
      skipped.push(rel);
      continue;
    }
    spent += size;
    carried.push(rel);
  }
  return { carried, skipped };
}

/** What the bundle did with the seeds, and why it had to do anything at all. */
export function seedNotes(seeds: CarriedSeeds, repo: string): readonly string[] {
  const notes: string[] = [];
  if (seeds.carried.length > 0) {
    notes.push(
      `carried ${String(seeds.carried.length)} seed document(s) into inputs (${listPaths(seeds.carried)}): ` +
      `they live at the workspace root, outside repo '${repo}', so the story worktree cannot open them — ` +
      "their content is inlined in the prompt instead",
    );
  }
  if (seeds.skipped.length > 0) {
    notes.push(
      `${String(seeds.skipped.length)} seed document(s) were NOT carried (${listPaths(seeds.skipped)}): ` +
      `over the ${String(MAX_SEED_CARRY_BYTES)}-byte inline budget for one bundle`,
    );
  }
  return notes;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * The acceptance criteria the answers imply.
 *
 * A specific one when the mapping is derivable — name the documents and the grep
 * that checks them — and a generic one whenever anything is left over, because a
 * partial mapping is exactly the case where "apply every listed fact" still has
 * work in it. With nothing mapped at all, only the generic one is written.
 */
export function applyAcceptance(plan: FactPlan): readonly string[] {
  if (plan.facts.length === 0) return [];
  const out: string[] = [];
  if (plan.mappings.length > 0) {
    const paths = [...new Set(plan.mappings.map((m) => m.path))];
    const ids = [...new Set(plan.mappings.map((m) => m.factId))];
    const say = (target: string): string =>
      "every touched document whose decision is settled by a fact of this run no longer reads " +
      `\`Status: proposed\` — \`grep -c 'Status: proposed' ${target}\` → 0 for the ones ` +
      `a fact decides [src: ${ids.join("; ")}]`;
    // The command has to be COMPLETE or not given at all: a `(+1 more)` inside a
    // grep is something a person pastes, runs, and reads the wrong answer from.
    // Over the item cap, point at `notes:`, which lists every path in full.
    const whole = say(paths.join(" "));
    out.push(whole.length <= MAX_ITEM_CHARS
      ? whole
      : say(`<the ${String(paths.length)} documents listed under \`notes:\`>`));
  }
  if (plan.mappings.length === 0 || plan.unmappedPaths.length > 0 || plan.unmappedFactIds.length > 0) {
    out.push(
      "apply every listed fact; leave a one-line note per file saying which fact changed it " +
      `[src: ${plan.facts.map((fact) => fact.id).join("; ")}]`,
    );
  }
  return out;
}

/** What the mapping came to, said out loud in the story — including its gaps. */
export function factNotes(plan: FactPlan): readonly string[] {
  if (plan.facts.length === 0) return [];
  const notes = plan.mappings.map((m) => `${m.factId} settles ${m.path} (its text mentions \`${m.key}\`)`);
  if (plan.unmappedPaths.length > 0) {
    notes.push(
      `no fact of this run mentions the ADR id or decision number of ${String(plan.unmappedPaths.length)} ` +
      `touched file(s) (${listPaths(plan.unmappedPaths)}) — apply every listed fact there and leave a ` +
      "one-line note per file saying which fact changed it",
    );
  }
  if (plan.unmappedFactIds.length > 0) {
    notes.push(
      `${plan.unmappedFactIds.join(", ")} settle no touched document by name — decide where they land ` +
      "and say so in the commit",
    );
  }
  return notes;
}

/**
 * At most four paths, then a count — for PROSE, where an abbreviation is fine.
 * Never for a command: see `applyAcceptance`.
 */
function listPaths(paths: readonly string[]): string {
  const shown = paths.slice(0, 4);
  const rest = paths.length - shown.length;
  return `${shown.join(" ")}${rest > 0 ? ` (+${String(rest)} more)` : ""}`;
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

/**
 * `epic/<slug>` from the run id, forced into `EPIC_BRANCH_RE`'s shape.
 *
 * Delegates to `plan/branchModel.ts`, which needs the identical name for a
 * chained run's integration branch (issue #57). Two copies of this slug rule
 * would let an implicit plan and an integration branch disagree about what the
 * same run is called.
 */
export function epicBranchFor(runId: string): string {
  return integrationBranchFor(runId);
}

// --- odds and ends ----------------------------------------------------------

function cap(items: readonly string[], max: number = MAX_ITEM_CHARS): readonly string[] {
  return items
    .slice(0, MAX_LIST_ITEMS)
    .map((item) => (item.length > max ? `${item.slice(0, max - 1)}…` : item));
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
