/**
 * What the run actually DELIVERED — one derivation, five readers (gh #210).
 *
 * ## What was wrong
 *
 * Measured on tldrx 0.14.2, two real workspaces, 2026-09-09: two engine-driven
 * runs reached the end, both printed `run <id> is done`, both had their Build
 * gate approved by the owner from a phone, and both delivered ZERO stories. The
 * whole of what he had to decide on was
 * `{"phase":"04-build","cost_usd":1.78,"outputs":["04-build/handoff.md"],
 * "checks":["claim-sources:passed"]}` — a dollar figure, one output and one green
 * check. The information existed on disk at that instant: the same run's
 * `04-build/handoff.md` `## Findings` said `S1 · … — blocked — … npm run test
 * exited 127 …`. The event carried none of it, so neither did the notification,
 * so he approved blind. A third run the day this was written did the same with
 * 1 of 3 stories and two developer turns killed by timeout.
 *
 * ## The rule this file encodes
 *
 * A record that says `done` over nothing delivered is a record lying in the
 * dangerous direction (AGENTS.md §7). So "how many stories reached `done`, and
 * what stopped the first one that did not" is derived HERE, once, and every
 * surface renders it: the Build `gate.requested` payload and its notification,
 * `run.yml`'s `outcome:`, `tldrx run status`, the `run.finished` notification,
 * the dashboard model and the `tldrx ship` refusal.
 *
 * ## Where the numbers come from
 *
 * The counts come from `buildProgress` — the story files, which is where the
 * status actually lives and the same reader `autoGate.ts`'s `stories` condition
 * has always used. `storiesCondition` now calls `storyCounts` here rather than
 * counting for itself: it computed exactly this view for `policy: auto` and only
 * for `policy: auto`, which is why a `human` Build gate carried nothing.
 *
 * The blocked story's REASON comes from the Build handoff's `## Findings`, read
 * through `build/handoff.ts`'s own `findingStatus` / `findingReason` — the
 * parsers that live beside the renderer they have to agree with. Nothing here
 * re-parses a handoff and nothing here invents a reason: a blocked story whose
 * bullet names none reports `REASON_NOT_RECORDED`, which is a sentence saying so,
 * never an empty string and never a guess.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildProgress, BUILD_PHASE } from "./buildProgress.ts";
import { findingId, findingReason, findingStatus } from "../build/handoff.ts";
import { parseHandoff } from "../text/handoff.ts";
import {
  OUTCOME_NOT_RECORDED, type RunFile, type RunOutcome,
} from "./RunFile.ts";

/** `04-build/handoff.md` — the document the blocked reason is read out of. */
const BUILD_HANDOFF = join(BUILD_PHASE, "handoff.md");

/** `## Findings` in a Build handoff: one bullet per story, with its status in it. */
const FINDINGS = "Findings";

/**
 * What a blocked story says when the handoff names no reason for it.
 *
 * Absent-with-reason (§7): the surfaces below print this sentence rather than a
 * blank, because a blocked story rendered with an empty parenthesis reads as
 * "blocked for no reason", which is a claim, and this is the absence.
 */
export const REASON_NOT_RECORDED =
  "no reason recorded — `04-build/handoff.md` carries no `## Findings` bullet for it";

/** Story statuses, counted. `total` is authoritative; a status this list does not name is still in it. */
export interface StoryCounts {
  readonly total: number;
  readonly done: number;
  readonly in_progress: number;
  readonly review: number;
  readonly blocked: number;
  readonly todo: number;
}

/** One story that did not reach `done`, with the reason when the handoff records one. */
export interface UnfinishedStory {
  readonly id: string;
  readonly status: string;
  /** The handoff's own words, or `REASON_NOT_RECORDED`. Never empty, never invented. */
  readonly reason: string;
}

/** The whole view: what the counts are, and what stopped the first story that stopped. */
export interface StoriesView {
  readonly counts: StoryCounts;
  /** Every story not `done`, in plan order. */
  readonly unfinished: readonly UnfinishedStory[];
  /** The first `blocked` story, or null when none is blocked (they may all be `todo`). */
  readonly firstBlocked: UnfinishedStory | null;
}

/**
 * The view, or null when this run has no plan to build — every phase but Build,
 * and Build before Plan. Null is the `n/a` case and it is never a zero.
 */
export function storiesView(runDir: string): StoriesView | null {
  const progress = buildProgress(runDir);
  if (progress === null) return null;
  const stories = progress.waves.flatMap((wave) => wave.stories);
  const counts: StoryCounts = {
    total: stories.length,
    done: stories.filter((s) => s.status === "done").length,
    in_progress: stories.filter((s) => s.status === "in_progress").length,
    review: stories.filter((s) => s.status === "review").length,
    blocked: stories.filter((s) => s.status === "blocked").length,
    todo: stories.filter((s) => s.status === "todo").length,
  };
  const reasons = blockedReasons(runDir);
  const unfinished = stories
    .filter((story) => story.status !== "done")
    .map((story) => ({
      id: story.id,
      status: story.status,
      reason: reasons.get(story.id) ?? REASON_NOT_RECORDED,
    }));
  return {
    counts,
    unfinished,
    firstBlocked: unfinished.find((story) => story.status === "blocked") ?? null,
  };
}

/**
 * Story id -> the reason its `## Findings` bullet gives, for every bullet that
 * names a status other than `done`.
 *
 * Read through `build/handoff.ts`'s parsers rather than a regex of this file's
 * own: the shape of a Findings bullet is that file's business, and a second
 * opinion about it here is the drift `findingStatus`'s own header warns about.
 */
function blockedReasons(runDir: string): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  const path = join(runDir, BUILD_HANDOFF);
  if (!existsSync(path)) return out;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return out;
  }
  let bullets: readonly string[];
  try {
    bullets = parseHandoff(text).sections
      .find((section) => section.name === FINDINGS)?.bullets.map((b) => b.text) ?? [];
  } catch {
    return out;
  }
  for (const bullet of bullets) {
    if (findingStatus(bullet) === "done") continue;
    const id = findingId(bullet);
    const reason = findingReason(bullet);
    if (id === null || reason === null) continue;
    if (!out.has(id)) out.set(id, reason);
  }
  return out;
}

/**
 * The stories view a GATE at `phaseId` is over — the view for a Build gate, null for
 * every other phase (gh #210, #239).
 *
 * ONE selection, because two surfaces ask the same question about the same pending
 * gate: the `gate.requested` notification when it is raised, and the `status`
 * heartbeat every interval it stays up. The heartbeat asked with a hard-wired `0`
 * unfinished stories, so a Build gate held by unbuilt work and no open question kept
 * repeating `tldrx approve` — which is the exact gate an owner approved by mistake
 * twice in one evening (#239). A second opinion about "is this gate over stories" is
 * how the alert and its reminder came to disagree; this is that opinion, once.
 *
 * Null on a Plan gate is deliberate and is not a zero: every story there is `todo` by
 * design, and describing that as "unfinished work" would refuse a signature the
 * workflow is asking for.
 */
export function gateStories(runDir: string, phaseId: string): StoriesView | null {
  return phaseId === BUILD_PHASE ? storiesView(runDir) : null;
}

/**
 * `stories: {…}` on a Build `gate.requested`, plus the first blocked story's id
 * and reason as two flat keys.
 *
 * Flat rather than nested so the payload stays greppable and a consumer reading
 * `blocked_story` never has to know whether `stories` was there. Both blocked
 * keys are ABSENT when nothing is blocked — `blocked_story: null` would read as
 * "we looked at a blocked story and it had no id" (§7).
 */
export function gateStoriesPayload(view: StoriesView): Record<string, unknown> {
  const blocked = view.firstBlocked;
  return {
    stories: view.counts,
    ...(blocked === null ? {} : { blocked_story: blocked.id, blocked_reason: blocked.reason }),
  };
}

/** The longest a reason is allowed to be inside a one-line summary before it is cut. */
const REASON_IN_SUMMARY = 80;

/** How many unfinished stories a summary names before it says `+N more`. */
const NAMED_IN_SUMMARY = 3;

/**
 * The sentence a Build gate's notification, decision card and terminal line all
 * say — "1 of 3 stories delivered, S2 blocked (npm run test exited 127…), S3 not
 * started".
 *
 * ONE builder, because these three go to three different places and the whole of
 * #210 is that they disagreed by omission. It goes in the SUMMARY and not only
 * the detail: the summary is the half that reaches a lock screen, which is the
 * argument #203 already made and won for `held`.
 */
export function deliveredPhrase(view: StoriesView): string {
  const head = `${String(view.counts.done)} of ${String(view.counts.total)} stories delivered`;
  if (view.unfinished.length === 0) return head;
  const named = view.unfinished.slice(0, NAMED_IN_SUMMARY).map(describeUnfinished);
  const rest = view.unfinished.length - named.length;
  return `${head}, ${named.join(", ")}${rest > 0 ? `, +${String(rest)} more` : ""}`;
}

/** `S2 blocked (npm run test exited 127…)`, or `S3 not started` for a `todo`. */
function describeUnfinished(story: UnfinishedStory): string {
  if (story.status === "todo") return `${story.id} not started`;
  if (story.status !== "blocked") return `${story.id} ${story.status}`;
  return `${story.id} blocked (${clip(story.reason)})`;
}

/** Cut at a word boundary with an ellipsis, never mid-word and never silently. */
function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= REASON_IN_SUMMARY) return flat;
  const cut = flat.slice(0, REASON_IN_SUMMARY);
  const space = cut.lastIndexOf(" ");
  return `${(space > 20 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** No Build phase at all: a docs-scope run never had a story to deliver. */
const NO_BUILD_PHASE = "this run's workflow has no Build phase, so no story could be delivered";

/** A Build phase with no plan under it — Build never ran, or the scope skipped Plan and Build never synthesised one. */
const NO_PLAN = "this run has no plan on disk, so there is no story to count";

/**
 * The `outcome:` a closing run records. Derived, never asserted, and never a
 * confident zero: a run with no Build reads `n/a` WITH the sentence saying so.
 */
export function deriveRunOutcome(run: RunFile, runDir: string): RunOutcome {
  if (!run.phases.some((phase) => phase.id === BUILD_PHASE)) {
    return { kind: "n/a", why: NO_BUILD_PHASE };
  }
  const view = storiesView(runDir);
  if (view === null || view.counts.total === 0) return { kind: "n/a", why: NO_PLAN };
  const blocked = view.firstBlocked;
  return {
    kind: view.counts.done === 0
      ? "nothing-delivered"
      : view.counts.done === view.counts.total ? "delivered" : "partial",
    stories_done: view.counts.done,
    stories_total: view.counts.total,
    stories_blocked: view.counts.blocked,
    ...(blocked === null ? {} : { first_blocked: `${blocked.id} — ${blocked.reason}` }),
  };
}

/** `outcome:` written onto the run, for the three commands that close one. */
export function withRunOutcome(run: RunFile, runDir: string): RunFile {
  return { ...run, outcome: deriveRunOutcome(run, runDir) };
}

/**
 * The one clause every surface appends to the run's status word — "nothing
 * delivered: 0 of 3 stories; S1 blocked: npm run test exited 127".
 *
 * `undefined` is the old-run.yml case and it is a SENTENCE, not a blank: a run
 * whose outcome nobody recorded must not render identically to one that
 * delivered everything.
 */
export function describeRunOutcome(outcome: RunOutcome | undefined): string {
  if (outcome === undefined) return OUTCOME_NOT_RECORDED;
  if (outcome.kind === "n/a") return `n/a — ${outcome.why ?? NO_BUILD_PHASE}`;
  const counts = `${String(outcome.stories_done ?? 0)} of ${String(outcome.stories_total ?? 0)} stories`;
  const head = outcome.kind === "nothing-delivered"
    ? `nothing delivered: ${counts}`
    : outcome.kind === "partial"
      ? `partial: ${counts} delivered`
      : `delivered: ${counts}`;
  return outcome.first_blocked === undefined ? head : `${head}; ${outcome.first_blocked}`;
}

/**
 * A run's outcome as a NOTIFIABLE fact: the sentence, and the kind for a machine
 * consumer's `detail`.
 *
 * It exists so `notify/notifications.ts` can keep its rule — it words, it never
 * derives (#197) — while still saying `not recorded` for a run.yml that predates
 * the field: `undefined` in, a sentence out, and the caller decides only WHETHER
 * to mention the outcome at all (it does not, for a run that is not over).
 */
export interface OutcomeLine {
  readonly text: string;
  readonly kind: string;
}

/** `not recorded` is a KIND here, so a consumer filtering on it never sees a missing key instead. */
export function outcomeLine(outcome: RunOutcome | undefined): OutcomeLine {
  return { text: describeRunOutcome(outcome), kind: outcome?.kind ?? "not-recorded" };
}

/**
 * `done — nothing delivered: 0 of 3 stories; S1 — …` — the status word and its
 * outcome, together, in one place so `run status` and the dashboard cannot
 * disagree about the punctuation between them.
 *
 * `null` is a run that is not over yet and it returns the bare status word: a
 * live run has no outcome to report and has not failed to record one.
 */
export function statusWithOutcome(status: string, outcome: OutcomeLine | null): string {
  return outcome === null ? status : `${status} — ${outcome.text}`;
}

/** True when the run's Build delivered no story at all — what `tldrx ship` refuses over. */
export function deliveredNothing(outcome: RunOutcome): boolean {
  return outcome.kind === "nothing-delivered";
}
