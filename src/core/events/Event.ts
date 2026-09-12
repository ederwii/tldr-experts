/** One line of `tldrx-work/<run>/events.jsonl` (spec §2.9). */
import {
  asDocument, requireEnum, requireKeys, requireNumber, requireString, result,
  type ValidationIssue, type ValidationResult,
} from "../schemas/validation.ts";

/**
 * Closed set — an unknown type is a validation error (spec §2.9).
 *
 * `gate.revoked` and `budget.raised` were added 2026-08-29. Both name a moment the
 * log could not previously describe: an approval taken back (a signed gate is not
 * final — see `revoke` in `run/gates.ts`), and a ceiling moved by hand (the audit
 * measured `budget raise` rewriting budget.yml and appending nothing at all).
 *
 * `story.reopened` was added 2026-08-30 for the same reason, one level down: a
 * person deciding that ONE Build story gets another run of attempts (`tldrx story
 * reopen`, `run/reopenStory.ts`). Its payload carries the story, the status it
 * came from, how many verdicts the closed run of attempts consumed, and the
 * operator's note. It is also a boundary the ledger reads — see `readReviewLedger`
 * in `facilitator/executors/build.ts` — so verdicts before it stop counting
 * against the reopened story without a single byte of history being rewritten.
 *
 * `fact.superseded` was added 2026-08-31, alongside `tldrx answer <Qn> "…"
 * --supersede`. `superseded_by` had been in the §2.5 schema since the first draft
 * with no command that wrote it, so an owner reversing an answered decision had
 * to hand-edit `facts.yml` and the log recorded nothing at all — the one moment
 * where a run's durable memory changes its mind was the one moment `tldrx replay`
 * could not narrate. Its payload carries the question, the new fact, the fact it
 * replaced and the superseding answer. The new row also gets the ordinary
 * `fact.added` before it, so "every row in facts.yml has a `fact.added` event"
 * stays true — `factsFromRun` relies on exactly that.
 *
 * `gate.policy_changed` was added 2026-08-31 (issue #14), for `tldrx run gates
 * set`. `gates_policy` is frozen at `run new` by design, and until this there was
 * no signed way to move it afterwards at all — a run opened before the `agent`
 * policy existed could never use it. Its payload carries the phase, who signed
 * it, the old and the new policy, and the operator's note. It says nothing about
 * gates already closed: the policy governs who may CLOSE a gate, and a signed one
 * is not re-opened by it.
 *
 * `operator_note` was added 2026-08-31 (issue #46), and is the only event in this
 * set that is not a report of something the framework DID. It is an operator
 * annotation: a person saying, at the moment it happened, what they did outside
 * the tool — a delegated resync, a hand-merge, a thing they want the next reader
 * to know. Before it, the only carriers were a future gate note (late, and keyed
 * to the wrong decision) or a `reject` (destructive), and a measured session
 * ended up hanging a maintenance note off an unrelated `story.reopened`. Its
 * payload carries the text and, when the note was keyed to one, the phase; the
 * envelope's `stage` carries the stage or null. It mutates nothing — see
 * `run/operatorNote.ts`.
 *
 * `story.review_retried` was added 2026-09-01 (issue #78, widened by #79), and it
 * is the one event whose whole job is to say that something did NOT happen: a
 * story's attempt was not spent. A review envelope refused for its FORMAT — an
 * unparseable `[src: …]` on a `refuted` finding, a missing `disposition`, a row
 * that is not an object, an empty `fixlist[]`, a verdict word outside the enum —
 * is a fault in the reviewer's REPORT, not a fault in the diff, so the framework
 * asks for a corrected envelope instead of charging the story one of its two
 * attempts (owner decisions, 2026-09-01). Attempt bookkeeping that changes with nothing in
 * the log would be unauditable, which is what this event is for: its payload
 * carries the story, the attempt it did not spend, which retry this was and the
 * bound, and the refusal verbatim. `readReviewLedger` counts them, and that count
 * is the bound — the third refusal is recorded as the `check.failed · changes` it
 * always was.
 *
 * `result.unreadable` was added 2026-09-02 (gh #88, owner decision). An in-session
 * `result.json` that EXISTS and does not parse no longer fails the stage — it is
 * refused like an absent one, because nothing was attempted and the fix is to
 * rewrite the file and run the same command again. The other half of that
 * decision is this event: corruption never passes silently, so the log carries
 * the run-dir-relative path of the file, the parser's own message, which role's
 * envelope it was and which story it belonged to. It is the ONLY thing a
 * sequencing refusal writes; `run.yml` still comes back byte for byte.
 *
 * `doc.superseded` was added 2026-09-02 (gh #104). A phase document is a
 * point-in-time snapshot, and an owner answer that lands three phases later can
 * flip a design the document still asserts — measured twice on
 * `260830-ordering-inventory`, where the flip was in questions.md, facts.yml and
 * retro.md and in none of the documents a reader opens. `src/core/answers/
 * stampSuperseded.ts` now appends an honest marker to the earlier-phase documents
 * the question names, and this is the line saying it did: the payload carries the
 * run-dir-relative document, the fact that overtook it, the question, and whether
 * the document was found by the question's own `Why asked:` citation (`cited`) or
 * named in its `affects:` metadata (`affects`). It reports a marker, never a
 * reconciliation — nothing in the document's own words is changed.
 *
 * `story.work_rescued` was added 2026-09-02 (#129) and is the SECOND event that
 * records tldrx touching git on the operator's behalf: uncommitted changes found
 * in a story worktree the framework was about to prune, committed to the story
 * branch first so they reach a ref. Its payload carries the story, the repo, the
 * branch, the sha and the status the story settled at. It is appended only when a
 * commit was really made — a rescue that could not commit keeps the worktree
 * instead, which is a line on stdout and in the review log, because nothing
 * happened to git.
 *
 * `worktree.foreign_work_aside` and `worktree.foreign_work_restored` were added
 * 2026-09-09 (#164), and they are the THIRD and fourth events that record tldrx
 * touching git on the operator's behalf — the pair that makes a Build stop being
 * a hostage to somebody else's uncommitted work. Measured across three real
 * workspaces on 0.14.2: every first engine-driven run reaching Build stopped at
 * `04-build` with `refusing to cut an epic branch from a dirty tree`, over seed
 * docs, a data export and one untracked note — none of it anything a story was
 * going to write. The engine now sets exactly those paths aside with a
 * PATHSPEC-LIMITED stash before it cuts the epic branch, and pops that stash back
 * when the wave ends.
 *
 * `worktree.foreign_work_aside` carries the `repo`, the `paths` (capped and
 * counted, never silently truncated — `build/foreignWork.ts`), the `stash_ref`
 * (the stash commit's full sha, which is the only name that survives another
 * stash being pushed beside it) and the `reason` the paths were judged foreign.
 * `worktree.foreign_work_restored` carries the same identity plus `restored`, and
 * on `restored: false` the `conflicts`, the literal `command` an operator retypes
 * and git's own `detail`.
 *
 * The pair is also the RESTORE's memory: the two moments are not always in one
 * process (a cursor-driven Build finishes its stage several `tldrx next` calls
 * after it cut the branch), so `pendingAsides` reads the open stashes back off
 * this log rather than off a field on a session. A stash is never dropped and
 * never force-popped: a restore that cannot happen is written down with
 * `restored: false` and said out loud, and it does not change the run's exit
 * code, which answers for the run's work and not for the operator's tree.
 *
 * `notify.sent` and `notify.failed` were added 2026-09-07 (gh #180), with the
 * owner-declared notify hook (§2.18). They are the only events in this set that record
 * something happening OUTSIDE the run: one invocation of the command
 * `.tldrx/workspace.yml` declares under `notify:`, handed one JSON payload on stdin at a
 * moment a person is needed. `notify.sent` carries the payload's `kind`, the declared
 * command verbatim, the child's `exit_code` and how long it took; `notify.failed` carries
 * the `kind`, the command and a `reason` sentence — a non-zero exit with the notifier's own
 * last line, a timeout, an executable that could not be started, a command that would need
 * a shell.
 *
 * There is no third outcome, and that is the point: a notifier NEVER changes a run's
 * outcome. Every failure above is written down and dropped, because "the owner was not
 * told, and here is why" is a fact about the run, and "the chat tool was down so the run
 * failed" would be the framework making a side channel load-bearing. Both carry
 * `cost_usd: 0` — a notification spends nothing — and both are appended through
 * `tryAppend`, so a log that refused the line does not take the run with it either.
 *
 * `story.base_fastforwarded` was added 2026-08-31, and is the first event in this
 * set that records tldrx MOVING A REF. Design §F.2: a story branch that sits
 * behind its epic tip is fast-forwarded before a developer is dispatched onto it,
 * and a moved branch that left no line in the log would be the framework
 * rewriting the operator's git state silently. Its payload carries the story, the
 * repo, both branch names and both shas (`from`, `to`) plus how many commits the
 * move carried. It is emitted ONLY when the ref actually moved: a divergent or
 * dirty branch is warned about on stdout and changed by nothing, so it has no
 * event, because nothing happened.
 */
export const EVENT_TYPES = [
  "run.created", "run.closed", "run.unlocked", "run.cancelled", "run.attended",
  "phase.started", "phase.done",
  "stage.started", "stage.done", "stage.failed", "stage.skipped",
  "task.started", "task.done",
  "agent.spawned", "agent.result",
  "question.asked", "question.answered",
  "gate.requested", "gate.approved", "gate.rejected", "gate.revoked", "gate.policy_changed",
  "questions.policy_changed",
  "story.reopened", "story.base_fastforwarded", "story.review_retried", "story.work_rescued",
  "story.touches_widened",
  "worktree.foreign_work_aside", "worktree.foreign_work_restored",
  "result.unreadable",
  "input.truncated",
  "operator_note",
  "check.passed", "check.failed",
  "budget.warned", "budget.blocked", "budget.raised", "budget.granted",
  "fact.added", "fact.retired", "fact.superseded", "fact.conflict_raised", "doc.superseded",
  "notify.sent", "notify.failed",
  "map.refreshed",
  "ticket.synced",
  "error",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** The envelope, in the key order the file is written in. */
export const EVENT_KEYS = ["ts", "run", "stage", "type", "actor", "cost_usd", "payload"] as const;

export const MAX_LINE_BYTES = 8 * 1024;
export const MAX_PAYLOAD_BYTES = 4 * 1024;
export const MAX_PAYLOAD_DEPTH = 3;

export interface TldrxEvent {
  readonly ts: string;
  readonly run: string;
  readonly stage: string | null;
  readonly type: EventType;
  readonly actor: string;
  readonly cost_usd: number;
  readonly payload: Readonly<Record<string, unknown>>;
}

export function validateEvent(input: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  const doc = asDocument(input, issues);
  if (!doc) return result(issues);

  requireKeys(doc, EVENT_KEYS, "", issues);
  for (const key of Object.keys(doc)) {
    if (!(EVENT_KEYS as readonly string[]).includes(key)) {
      issues.push({ path: key, message: `unexpected key \`${key}\` — the envelope is exactly ${EVENT_KEYS.join(", ")}` });
    }
  }
  requireString(doc.ts, "ts", issues);
  requireString(doc.run, "run", issues);
  if (doc.stage !== null) requireString(doc.stage, "stage", issues);
  requireEnum(doc.type, EVENT_TYPES, "type", issues);
  requireString(doc.actor, "actor", issues);
  requireNumber(doc.cost_usd, "cost_usd", issues);
  if (typeof doc.cost_usd === "number" && doc.cost_usd < 0) {
    issues.push({ path: "cost_usd", message: "must be >= 0" });
  }
  if (typeof doc.payload !== "object" || doc.payload === null || Array.isArray(doc.payload)) {
    issues.push({ path: "payload", message: "expected an object" });
  } else {
    const bytes = Buffer.byteLength(JSON.stringify(doc.payload), "utf8");
    if (bytes > MAX_PAYLOAD_BYTES) {
      issues.push({ path: "payload", message: `${bytes} bytes exceeds the ${MAX_PAYLOAD_BYTES} byte cap` });
    }
    const depth = objectDepth(doc.payload);
    if (depth > MAX_PAYLOAD_DEPTH) {
      issues.push({ path: "payload", message: `nesting depth ${depth} exceeds ${MAX_PAYLOAD_DEPTH}` });
    }
  }
  return result(issues);
}

/**
 * Fit a payload inside the §2.9 cap by NAMING what was left out, not by raising it.
 *
 * TWO fields overflow in practice, and this function knows exactly those two —
 * by NAME, one branch each, in the order below. It has no general rule for
 * "shrink whatever is biggest": trimming a field it does not understand would be
 * the framework editing its own record, and a payload oversized for any other
 * reason still comes back untouched and is still refused by the append.
 *
 *   1. `detail` — a reviewer's verdict prose, copied into
 *      `check.passed`/`check.failed` (#160). Prose is the first thing to go: it
 *      is the field a ledger does not read, and the VERDICT beside it survives.
 *   2. `outputs` — every run-relative path a turn wrote, on `agent.result`
 *      (#248). A story with a few dozen files clears 4096 bytes on that array
 *      alone, and the live incident that filed #248 lost a whole invocation's
 *      accounting to one. It is dropped WHOLE and replaced by a COUNT: a
 *      truncated `outputs` would read downstream as the entire list, which is
 *      the invented value AGENTS.md §7 bans. The full list goes to `save`, one
 *      path per line.
 *
 * Adding a THIRD field is a deliberate edit here, not something that happens by
 * itself: a new payload field that can grow without bound (a `usage` block, a
 * findings array) is oversized-and-refused until this function is taught it.
 *
 * Neither drop GUARANTEES the result fits — if the rest of the payload alone is
 * already over the cap, the named absence is added to a payload that is still
 * oversized and `EventLog.append` throws on it exactly as it would have before
 * this function existed. That throw is not silent: the emit seam in `runNext.ts`
 * catches it and fails the stage by name (fix round 1; #248 extends the same
 * treatment to the task-recording seam).
 *
 * Identity is the contract for the ordinary case: an in-cap payload comes back as
 * the SAME object, so every event this framework has ever written is byte-identical.
 *
 * `save`, when given, is called with the text about to be dropped and the NAME of
 * the field it came from, and must return where it now lives — "omitted text
 * saved at <relative path>" (fix round 1: the caller writes that file BEFORE
 * calling this function, so the pointer is true by construction rather than a
 * guess at a story log that may not exist yet, may hold a LATER verdict's prose
 * by the time anyone reads it, or may never be written at all) — or why it could
 * not be, so a failed write is named rather than pointing at a path that does not
 * exist. `save` is called ONLY when a field is actually being dropped, never for
 * an in-cap payload: this function stays synchronous and disk-free on its own, so
 * every unit test calls it with no filesystem at all. Omitting `save` falls back
 * to an honest "not preserved" sentence rather than inventing a path.
 */
export function capPayload(
  payload: Readonly<Record<string, unknown>>,
  save?: (text: string, field: string) => string,
): Readonly<Record<string, unknown>> {
  if (byteSize(payload) <= MAX_PAYLOAD_BYTES) return payload;

  const where = (text: string, field: string): string => save === undefined
    ? "the full text was not preserved and is not recoverable from this event"
    : save(text, field);
  const named = (size: number, text: string, field: string): string =>
    `${String(size)} bytes exceeds the ${String(MAX_PAYLOAD_BYTES)}-byte cap — ${where(text, field)}`;

  let current = payload;

  // 1. The prose.
  if (typeof current.detail === "string") {
    const { detail: dropped, ...rest } = current;
    current = { ...rest, detail_omitted: named(byteSize(current), dropped, "detail") };
    if (byteSize(current) <= MAX_PAYLOAD_BYTES) return current;
  }

  // 2. The path list — only when there is one, since dropping an empty array
  //    buys nothing and would leave a misleading `outputs_omitted: 0` behind.
  if (Array.isArray(current.outputs) && current.outputs.length > 0) {
    const { outputs: dropped, ...rest } = current;
    const list = dropped as readonly unknown[];
    current = {
      ...rest,
      outputs_omitted: list.length,
      outputs_omitted_reason: named(byteSize(current), list.map((p) => String(p)).join("\n"), "outputs"),
    };
  }

  return current;
}

function byteSize(payload: Readonly<Record<string, unknown>>): number {
  return Buffer.byteLength(JSON.stringify(payload), "utf8");
}

/** Serialize with the seven keys in spec order — the file is diffed by humans. */
export function serializeEvent(event: TldrxEvent): string {
  return JSON.stringify({
    ts: event.ts,
    run: event.run,
    stage: event.stage,
    type: event.type,
    actor: event.actor,
    cost_usd: event.cost_usd,
    payload: event.payload,
  });
}

function objectDepth(value: unknown, depth = 1): number {
  if (typeof value !== "object" || value === null) return depth - 1;
  let deepest = depth;
  for (const child of Object.values(value as Record<string, unknown>)) {
    if (typeof child === "object" && child !== null) {
      deepest = Math.max(deepest, objectDepth(child, depth + 1));
    }
  }
  return deepest;
}
