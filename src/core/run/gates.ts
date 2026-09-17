/**
 * `tldrx approve` / `tldrx reject` — the human stop in the loop (spec §3, §5).
 *
 * Approve is not a rubber stamp: the stage's declared checks are re-run against
 * what is on disk right now, and a failure refuses the approval and names the
 * check. Reject is the cheap half — it records the note and sends the stage back
 * to `ready` so the next `next` re-runs it with the note as input.
 *
 * Both write through `RunStore`, so the cursor, phase statuses, run status and the
 * budget mirror stay derived rather than hand-maintained.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { TldrxEvent } from "../events/Event.ts";
import { gateEvidenceRelPath } from "../text/evidence.ts";
import { runChecks, type CheckOutcome } from "./checks.ts";
import { loadWorkflowPreset, PresetError, type PlannedStage } from "./workflowPreset.ts";
import type { RunStore } from "./RunStore.ts";
import type { RunFile, RunGate, RunGateEvidence, RunPhase, RunStage } from "./RunFile.ts";
import { gatePolicyFor } from "./gatePolicy.ts";
import { givenAwayLines } from "../budget/rebalance.ts";
import { attributeGate } from "./gateAuthority.ts";
import { closeRun, type RunCloseOutcome } from "./closeRun.ts";
import { withRunOutcome } from "./runOutcome.ts";
import { evidencePath } from "../facilitator/paths.ts";
import { hasPreparedBundle } from "./prepared.ts";
import { candidateShasIn, latestFixlist, openFindings } from "../build/fixlist.ts";
import { phaseDirsOf, scanStories } from "../build/storyScan.ts";
import { repoDirOf } from "../build/git.ts";
import { storyBranchOf } from "../plan/branchModel.ts";
import { loadWorkspace } from "../../hooks/lib/workspace.ts";
import { closeNoted } from "../build/resolutionVerify.ts";

export class GateError extends Error {}

/**
 * The evidence an `agent` gate is closed over (design §A.5), handed to `approve`
 * already validated.
 *
 * `approve` does two things with it and neither is a judgement: it COPIES the
 * note into the run tree, where it is committed and auditable from a clone, and
 * it records the headline counts on the gate. Whether the note is any good was
 * settled before it got here — by `agentGate.ts` at `next`, or by
 * `approve --as-agent` at the CLI — because a validator that ran inside the
 * write path would be a second one, and the looser of two would win the argument
 * at exactly the moment a gate is being signed.
 */
export interface GateEvidenceInput {
  /** The note's bytes, verbatim. Copied, never rewritten. */
  readonly text: string;
  /** What goes on `gate.evidence`; `path` is `approve`'s to decide. */
  readonly record: Omit<RunGateEvidence, "path">;
}

export interface GateContext {
  readonly root: string;
  readonly actor: string;
  readonly at: string;
  readonly note: string;
  /** Measured provider identity for an automatically closed agent gate. */
  readonly executorId?: string | null;
  /** Present only when an `agent` policy is closing this gate. */
  readonly evidence?: GateEvidenceInput;
  /**
   * `tldrx reject --and-continue` — this rejection means "redo it this way and
   * carry on", not "stop, I will look" (gh #242). Recorded on the gate so an
   * unattended `run auto` waiting somewhere else can tell the two apart; absent
   * or false is the default and stops the loop exactly as it always did.
   */
  readonly andContinue?: boolean;
}

export interface ApproveOutcome {
  readonly ok: boolean;
  readonly stage: string;
  readonly phase: string;
  readonly checks: readonly CheckOutcome[];
  /** The first failing check, when `ok` is false and checks are why. */
  readonly failed: CheckOutcome | null;
  /** Where the cursor ended up, or null when the run is finished. */
  readonly advancedTo: { readonly phase: string; readonly stage: string } | null;
  readonly runDone: boolean;
  /** Run-relative path of the committed evidence copy, when one was made. */
  readonly evidencePath: string | null;
  /** What the close did with the worktrees and the run's own state (#16, #102). */
  readonly closed: RunCloseOutcome | null;
}

export async function approve(store: RunStore, ctx: GateContext): Promise<ApproveOutcome> {
  const entry = requireGate(store, "approve");
  const planned = plannedStage(ctx.root, store.run, entry.stage.id);
  const checks = planned === null ? [] : await runChecks(planned.checks, {
    root: ctx.root,
    runDir: store.runDir,
    stage: planned,
  });

  for (const check of checks) {
    store.append(event(ctx.at, store.runId, entry.stage.id, check.status === "failed" ? "check.failed" : "check.passed", ctx.actor, {
      check: check.id,
      status: check.status,
      detail: check.detail,
    }));
  }
  const failed = checks.find((c) => c.status === "failed") ?? null;
  if (failed !== null) {
    return {
      ok: false, stage: entry.stage.id, phase: entry.phase.id, checks, failed,
      advancedTo: null, runDone: false, evidencePath: null, closed: null,
    };
  }

  // The run-tree copy is written BEFORE the gate is signed, so a gate that says
  // it rests on evidence always has the evidence beside it. A failure to write it
  // throws, and nothing is approved.
  const evidence = ctx.evidence === undefined
    ? null
    : copyEvidence(store.runDir, entry.phase.id, entry.stage.id, ctx.evidence);

  // WHO signed, and under WHOSE authority — derived here, off the run's own
  // frozen policy and its own log, so the two travel with the gate rather than
  // being reconstructed later from the prose of `note:` (#122). `by` is
  // untouched: it is what the note said, and the note is the agent's own claim
  // about itself.
  const attribution = attributeGate({
    actor: ctx.actor,
    executorId: ctx.executorId,
    policy: gatePolicyFor(store.run.gates_policy, entry.stage.id),
    signedWithEvidence: evidence !== null,
    stageId: entry.stage.id,
    events: store.events.read(),
  });

  const next = store.nextEntry();
  store.mutate((run) =>
    mapStage(run, entry.phase.id, entry.stage.id, (stage) => ({
      ...stage,
      status: "done",
      ended_at: stage.ended_at ?? ctx.at,
      gate: {
        ...stage.gate,
        status: "approved",
        by: ctx.actor,
        at: ctx.at,
        note: ctx.note,
        ...(evidence === null ? {} : { evidence }),
        executed_by: attribution.executed_by,
        authority: attribution.authority,
      } satisfies RunGate,
    })),
  );
  if (next !== null) {
    store.mutate((run) => ({
      ...mapStage(run, next.phase.id, next.stage.id, (stage) => ({ ...stage, status: "ready" })),
      cursor: { phase: next.phase.id, stage: next.stage.id, task: null },
    }));
  }

  // `by` duplicates the envelope's `actor` on purpose: a reader of the event
  // stream asks "who signed this gate", and the answer belongs in the payload it
  // is reading, not in a field that also means "who ran the process". It is how
  // `by: auto` is told apart from a person who happens to be called auto — the
  // facilitator is the only caller that passes the AUTO_GATE_ACTOR.
  store.append(event(ctx.at, store.runId, entry.stage.id, "gate.approved", ctx.actor, {
    phase: entry.phase.id,
    by: ctx.actor,
    note: ctx.note,
    checks: checks.map((c) => `${c.id}:${c.status}`),
    // Additive, and only on an agent-closed gate: the event stream carries `by`
    // already, and `by: fable` alone cannot tell a person from an agent that
    // happens to be called fable. The role and the path can.
    ...(evidence === null ? {} : { role: evidence.role, evidence: evidence.path }),
    // Additive, and on EVERY gate (#122). The two above are an agent's own claim
    // about what it read; these two are the framework's measurement of who acted
    // and under what — the answer a reader needs when the name in `by` belongs to
    // a person who was not there.
    executed_by: attribution.executed_by,
    authority: attribution.authority,
  }));
  store.append(event(ctx.at, store.runId, entry.stage.id, "stage.done", ctx.actor, { phase: entry.phase.id }));
  store.save();

  // #344, owner decision "Sí cerrarlo": a human gate approval whose note names
  // the commit that fixes an open fix-now finding closes that finding. Run
  // AFTER the gate itself is signed and saved, so a check failure above (which
  // returns early) never touches a fixlist file, and never on a gate this
  // function is about to refuse.
  await closeNamedFixlistFindings(store, ctx.root, entry.phase.id, entry.stage.id, ctx.actor, ctx.at, ctx.note);

  const runDone = store.run.status === "done";
  let closed: RunCloseOutcome | null = null;
  if (runDone) {
    // What the run DELIVERED, on the run itself, before the close commits it
    // (#210). The same line `tldrx next` and `tldrx run cancel` write: signing
    // the last gate is the most ordinary way a run closes, and it was one of the
    // two paths that let a run read `done` over zero delivered stories.
    store.mutate((run) => withRunOutcome(run, store.runDir));
    store.save();
    store.append(event(ctx.at, store.runId, null, "run.closed", ctx.actor, { reason: "every stage terminal" }));
    // Signing the last gate is the most ordinary way a run closes, so it is also
    // where its epic worktrees are most ordinarily taken (#16) and where its own
    // state is most ordinarily committed (#102).
    closed = await closeRun(store.run, ctx.root, store.runDir, store.runId);
  }
  return {
    ok: true, stage: entry.stage.id, phase: entry.phase.id, checks, failed: null,
    advancedTo: next === null ? null : { phase: next.phase.id, stage: next.stage.id },
    runDone,
    evidencePath: evidence === null ? null : evidence.path,
    closed,
  };
}

/**
 * A human gate approval whose NOTE names the commit that fixes an open fix-now
 * finding closes that finding (#344, owner decision "Sí cerrarlo") — reusing
 * the same evidence rule every other `Resolved: yes` is held to
 * (`../build/resolutionVerify.ts`'s `unverifiedBecause`, shared with the Build
 * executor's own per-story check), never a looser one just because the claim
 * arrived in an approval note instead of the file.
 *
 * Scope, deliberately narrow — the safe direction only (§7):
 *   - A note with NO sha-looking token changes nothing, and nothing is even
 *     read: `candidateShasIn` is the same 7-40-hex grammar every other sha in
 *     the fix-list grammar is read with, applied to free text instead of one
 *     `Resolved:` line (#7, one implementation).
 *   - Only `fix-now` findings that are STILL OPEN are ever touched —
 *     `openFindings` is the one predicate that already answers "still blocks
 *     `done`" (`build/fixlist.ts`); a finding already closed, deferred, refuted
 *     or out-of-scope is not this gate's business and is never looked at.
 *   - Every open finding is tried against the note's own candidates through the
 *     story's own branch, exactly the reachability rule `verifyResolutions`
 *     runs at story-settle time; the leaf (`closeNoted`) writes `Resolved: yes
 *     <sha>` when one checks out and `claimed-unverified` with the reason when
 *     none does, so a note that named something wrong is recorded, never
 *     silently dropped and never silently closed.
 *
 * Walks every story this run has declared (`scanStories`/`phaseDirsOf`, the ONE
 * walk `run/ship.ts` also uses for the same reason — no second `readdirSync`
 * over `stories/`, gh #189), first-phase-directory-wins per story id, the same
 * tie-break `run/ship.ts`'s `openFixFindings` uses so two readers of one story
 * cannot end up looking at two different fix lists. A repo `workspace.yml`
 * does not declare is skipped, not guessed at — nothing can be verified against
 * a repo that cannot be resolved, so nothing there is touched either.
 */
export async function closeNamedFixlistFindings(
  store: RunStore, root: string, phaseId: string, stageId: string, actor: string, at: string, note: string,
): Promise<void> {
  const candidates = candidateShasIn(note);
  if (candidates.length === 0) return;
  const workspace = loadWorkspace(root);
  const stories = scanStories(store.runDir).stories;
  const seen = new Set<string>();
  const provenance = `${phaseId}/${stageId} gate approved by ${actor} at ${at}`;
  for (const phase of phaseDirsOf(store.runDir)) {
    for (const story of stories) {
      if (seen.has(story.story)) continue;
      const fixlist = latestFixlist(store.runDir, phase, story.story);
      if (fixlist === null) continue;
      seen.add(story.story);
      // A round the parse could not fully read is not a round this may act on
      // (gh #218's correctness half): a dropped heading could hide a live
      // `fix-now` finding a note's sha was never meant to touch.
      if (fixlist.unreadable.length > 0) continue;
      const open = openFindings(fixlist.findings);
      if (open.length === 0) continue;
      let repoDir: string;
      try {
        repoDir = repoDirOf(workspace, story.repo);
      } catch {
        continue;
      }
      const branch = storyBranchOf(store.runId, story.story);
      const text = readFileSync(fixlist.path, "utf8");
      const result = await closeNoted({ repoDir, branch, repo: story.repo }, open, text, candidates, provenance);
      if (result.text !== null) writeFileSync(fixlist.path, result.text, "utf8");
    }
  }
}

/**
 * Write `<phase>/gate-evidence/<stage>.md` and return the record that points at
 * it. The scratch note under `.agent/` stays exactly where the agent left it —
 * this is a copy, not a move, because a gitignored original is still the thing
 * the next `--prepare` cycle is allowed to overwrite.
 */
function copyEvidence(
  runDir: string,
  phaseId: string,
  stageId: string,
  input: GateEvidenceInput,
): RunGateEvidence {
  const rel = gateEvidenceRelPath(phaseId, stageId);
  const absolute = join(runDir, ...rel.split("/"));
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, input.text, "utf8");
  return { path: rel, ...input.record };
}

export interface RejectOutcome {
  readonly stage: string;
  readonly phase: string;
  readonly note: string;
  /** The status the stage was in when it was rejected: `awaiting_gate` or `failed`. */
  readonly from: string;
  /** True when the rejection asked an unattended loop to carry on (#242). */
  readonly andContinue: boolean;
  /**
   * Run-relative path the stage's scratch evidence note (`.agent/<stage>/
   * evidence.md`) was archived to, when there was one — null when the stage had
   * none (issue #199).
   */
  readonly archivedEvidence: string | null;
}

/**
 * Move a stale scratch evidence note out of the way of the next attempt (#199).
 *
 * `reject` sends a stage back to `ready` so the NEXT `next` re-runs it and writes
 * different outputs, but nothing removed `.agent/<stage>/evidence.md` — so a note
 * signed over the attempt being thrown away was still the first (and only) thing
 * either signer found, and it still said `verdict: sign`. Renamed, not deleted:
 * the note is a record of a real check somebody made, just not one this gate may
 * still rest on. Its ABSENCE at the ordinary path is what makes the existing
 * "no evidence note at …" fallthrough fire honestly on the re-run, rather than a
 * second reader having to learn a new "superseded" state.
 */
function archiveEvidenceNote(runDir: string, stageId: string, at: string): string | null {
  const path = evidencePath(runDir, stageId);
  if (!existsSync(path)) return null;
  // Unique, never overwriting (issue #144 F3): `at` is second-precision, and a
  // stage rejected twice in the same second — a fast scripted loop, or two
  // rejections issued with the same `--at` in a test — used to rename the
  // second note ONTO the first, silently destroying the record `reject`'s own
  // docs promise it never deletes. `-2`, `-3`, … until the name is free.
  const base = `evidence.rejected-${at.replace(/:/g, "-")}`;
  const dir = dirname(path);
  let archived = join(dir, `${base}.md`);
  for (let n = 2; existsSync(archived); n++) archived = join(dir, `${base}-${String(n)}.md`);
  renameSync(path, archived);
  return relative(runDir, archived);
}

/**
 * Two states may be rejected, and spec §5 names them both.
 *
 * `awaiting_gate` is the ordinary one. `failed` is the other half of the failure
 * path — "the operator's options are `next` (retry, re-spending), `reject --note`
 * (send the stage back to `ready` with the note fed into the next prompt)" — so
 * refusing a failed stage would leave the operator with retry as the only move.
 *
 * Both record the note in `gate.note` and append one `gate.rejected` event; the
 * event's `from` payload says which state it came out of. There is deliberately
 * no separate `stage.reset` event: one verb, one event, and the note lives in one
 * place for `next` to read back.
 */
const REJECTABLE: readonly string[] = ["awaiting_gate", "failed"];

export function reject(store: RunStore, ctx: GateContext): RejectOutcome {
  if (ctx.note.trim() === "") {
    throw new GateError("reject needs --note: a rejection without a reason is not actionable");
  }
  const entry = requireStatus(store, "reject", REJECTABLE);
  const from = entry.stage.status;
  store.mutate((run) =>
    mapStage(run, entry.phase.id, entry.stage.id, (stage) => ({
      ...stage,
      status: "ready",
      ended_at: null,
      // Advanced to THIS moment, not cleared (issue #144 F1) — a rejection is
      // itself a decision that the attempt being thrown away is done, so
      // nothing dated before it (the just-thrown-away note included, however
      // it is later pointed at — `approve --evidence <archived path>`) can be
      // evidence for whatever the NEXT attempt produces. `next` advances it
      // again, further still, the moment it actually re-runs the stage.
      attempt_started_at: ctx.at,
      // `and_continue` is written on EVERY rejection, `true` or nothing at all: a
      // bare rejection must not inherit a previous one's answer through the spread
      // (#242), and `undefined` is what the emitter omits.
      gate: {
        ...stage.gate,
        status: "rejected",
        by: ctx.actor,
        at: ctx.at,
        note: ctx.note,
        and_continue: ctx.andContinue === true ? true : undefined,
      } satisfies RunGate,
    })),
  );
  const archivedEvidence = archiveEvidenceNote(store.runDir, entry.stage.id, ctx.at);
  store.append(event(ctx.at, store.runId, entry.stage.id, "gate.rejected", ctx.actor, {
    phase: entry.phase.id,
    note: ctx.note,
    from,
    // On the event as well as the gate, and for the same reason the gate carries it:
    // "was this rejection asking for another round" is a fact about the decision, and
    // the gate mapping is overwritten by the next `gate.requested` while the log is not.
    ...(ctx.andContinue === true ? { and_continue: true } : {}),
    // Additive (#199): null when there was no scratch note to archive, so an event
    // written before this exists still reads — an absent key, never a claim that
    // nothing was ever signed.
    ...(archivedEvidence === null ? {} : { archived_evidence: archivedEvidence }),
  }));
  store.save();
  return {
    stage: entry.stage.id, phase: entry.phase.id, note: ctx.note, from,
    andContinue: ctx.andContinue === true, archivedEvidence,
  };
}

export interface RevokeOutcome {
  readonly stage: string;
  readonly phase: string;
  readonly note: string;
  /** Who had signed the gate being taken back — `auto` or a person. */
  readonly signedBy: string;
  /** When it was signed. */
  readonly signedAt: string | null;
  /**
   * What the withdrawn signature had rested on, when it rested on anything
   * (issue #123). It has just been cleared from `run.yml` and written onto the
   * `gate.revoked` event; it is returned so the CLI can say where the note it
   * was signed over still is, rather than leaving the operator to guess that
   * clearing a pointer did not delete a file.
   */
  readonly signedOver: RunGateEvidence | null;
  /** `<phase>/<stage>` of every later stage now marked stale. */
  readonly staled: readonly string[];
  /**
   * When the revoked stage's phase had GIVEN ceiling through `run auto --rebalance-finished`
   * and is now unfinished: one line per move, naming it and the `--take-from` that returns what
   * is still unspent (review of #314). Empty otherwise. Nothing is moved back.
   */
  readonly givenAway: readonly string[];
  /**
   * `<phase>/<stage>` of every later stage that was `running` with nothing
   * holding it and was demoted to `ready` alongside going stale (issue #228).
   * Empty when no later stage was mid-flight.
   */
  readonly demoted: readonly string[];
}

/**
 * `tldrx reject --stage <phase>/<stage>` — take an approval back.
 *
 * Before this, an approval was final. `approve()` moves the cursor in the same
 * transaction that signs the gate (`gates.ts:63-77`) and `reject` only ever looked
 * at the cursor, so the audit's probe — a wholly fabricated handoff that closed
 * its own auto gate — met `REJECT REFUSED: nothing to reject: 02-how/beta is
 * 'ready'`. A machine that can sign but cannot be overruled is not a gate.
 *
 * What it does, and deliberately does not do:
 *
 *   - the named stage goes back to `ready` with the note on its gate, and the
 *     CURSOR moves back to it, so the next `tldrx next` re-runs it with the note
 *     as input — identical to an ordinary rejection, one stage further back;
 *   - every LATER stage that had already run is marked `stale: true`. Its outputs
 *     stay on disk: they cost money, they are usually mostly right, and deleting
 *     a reviewer's work to make a flag true is worse than the flag. What changes
 *     is that nothing may treat them as current;
 *   - a later stage that is `running` with NOTHING holding it also goes back to
 *     `ready` (issue #228). Marking it `stale: true` and leaving `status:
 *     running` untouched left a state no verb owned: `next` only demotes a
 *     `running` stage behind a DEAD-PID lock, and a `--prepare` cycle releases
 *     its lock on purpose, so a stage stranded by a revoke had no lock to go
 *     stale and the cursor walked back into it mid-flight once the revoked stage
 *     was re-approved. One HOLDING a `--prepare` bundle is different: that is a
 *     sub-agent turn already paid for, not ours to discard silently, so revoke
 *     refuses instead and names the stage;
 *   - no cost is refunded and no task is deleted. Money spent stays on the record
 *     (spec §5).
 *
 * One `gate.revoked` event carries who signed the original, who took it back,
 * what went stale — and, when the withdrawn signature rested on an evidence note,
 * what it rested on (issue #123).
 *
 * ## Why the gate mapping is emptied and the event is not (issue #123)
 *
 * `run.yml` is STATE — the resume point, read as a description of how things are
 * now. `events.jsonl` is HISTORY — append-only, read as a description of what
 * happened. A revoked gate carrying `evidence` said both "nobody has signed this"
 * (`status: pending`, `by: null`) and "here is what the signature rested on", in
 * one mapping, and `replay` drew the counts of a withdrawn signature under a gate
 * the same file said was open.
 *
 * So everything that DESCRIBED the signature leaves the mapping together — `by`,
 * `at`, `executed_by`, `authority` and `evidence` — and the evidence rides onto
 * the `gate.revoked` event beside `signed_by`/`signed_at`, where the envelope's
 * own actor and timestamp say who took it back and when. Nothing is destroyed:
 * the committed note stays exactly where it was, under
 * `<phase>/gate-evidence/<stage>.md`.
 *
 * A `revoked:` trail kept ON the gate was the alternative, and it was refused
 * because it grows. A gate may be approved, revoked, re-approved and revoked
 * again, so the state file would accumulate a list of withdrawn signatures —
 * which is what the append-only log is for — and every reader would have to learn
 * a "withdrawn" mode for a block whose only truthful reading in `run.yml` is
 * "current".
 */
export function revoke(store: RunStore, ctx: GateContext, target: string): RevokeOutcome {
  if (ctx.note.trim() === "") {
    throw new GateError("reject needs --note: a revocation without a reason is not actionable");
  }
  const entry = locate(store, target);
  if (entry.stage.gate.status !== "approved") {
    throw new GateError(
      `cannot revoke ${entry.phase.id}/${entry.stage.id}: its gate is \`${entry.stage.gate.status}\`, not ` +
        "`approved`. To send the CURRENT stage back, use `tldrx reject --note \"…\"` with no --stage.",
    );
  }
  const signedBy = entry.stage.gate.by ?? "unknown";
  const signedAt = entry.stage.gate.at;
  const signedOver = entry.stage.gate.evidence ?? null;
  const laterEntries = stagesAfter(store.run, entry.phase.id, entry.stage.id)
    .filter((e) => e.stage.status !== "pending" || e.stage.tasks.length > 0);
  const later = laterEntries.map((e) => `${e.phase.id}/${e.stage.id}`);

  // A later stage left `running` by a `--prepare` cycle is a sub-agent turn this
  // run already paid for — refuse rather than silently discard it (issue #228).
  // Every OTHER `running` later stage has nothing holding it (no lock: this
  // process is the only writer here, and a normal `next` always releases its
  // own) and goes back to `ready` below, alongside going stale.
  const strandedRunning = laterEntries.filter((e) => e.stage.status === "running");
  for (const e of strandedRunning) {
    if (hasPreparedBundle(store.runDir, e.stage.id)) {
      throw new GateError(
        `cannot revoke ${entry.phase.id}/${entry.stage.id}: ${e.phase.id}/${e.stage.id} is running with a `
          + "--prepare bundle waiting — finish it (`tldrx next --commit`) or discard it "
          + "(`tldrx next --discard-pending`) before revoking an earlier stage",
      );
    }
  }
  const demoted = strandedRunning.map((e) => `${e.phase.id}/${e.stage.id}`);
  const runningToReady = new Set(demoted);

  store.mutate((run) => {
    const reset = mapStage(run, entry.phase.id, entry.stage.id, (stage) => ({
      ...stage,
      status: "ready",
      ended_at: null,
      stale: undefined,
      // Advanced to THIS moment (issue #144 F1), for the same reason `reject`
      // advances it: a revoke is itself a decision that whatever this stage
      // signed is done, so nothing dated before it can be evidence for the
      // re-approval that follows.
      attempt_started_at: ctx.at,
      // `by: null` says nobody has signed this gate. An `executed_by` left beside
      // it would be a second, contradicting claim about the same fact, so the
      // attribution goes with the signature it described (#122) — and so does
      // `evidence`, which is what that signature rested on (#123). What leaves
      // the mapping is not lost: it is on the `gate.revoked` event below, and the
      // note itself never moved off disk.
      gate: {
        ...stage.gate,
        status: "pending",
        by: null,
        at: null,
        note: ctx.note,
        evidence: undefined,
        executed_by: undefined,
        authority: undefined,
      } satisfies RunGate,
    }));
    const stale = new Set(later);
    return {
      ...reset,
      phases: reset.phases.map((phase) => ({
        ...phase,
        stages: phase.stages.map((stage) => {
          if (!stale.has(`${phase.id}/${stage.id}`)) return stage;
          const demotedNow = runningToReady.has(`${phase.id}/${stage.id}`);
          return {
            ...stage,
            stale: true,
            // Same reasoning as the revoked stage above: a demoted stage is
            // getting a fresh attempt too, so nothing dated before this revoke
            // may sign over whatever it produces next (issue #144 F1).
            ...(demotedNow ? { status: "ready" as const, attempt_started_at: ctx.at } : {}),
          };
        }),
      })),
      cursor: { phase: entry.phase.id, stage: entry.stage.id, task: null },
    };
  });

  store.append(event(ctx.at, store.runId, entry.stage.id, "gate.revoked", ctx.actor, {
    phase: entry.phase.id,
    note: ctx.note,
    signed_by: signedBy,
    signed_at: signedAt,
    // Only when the withdrawn signature HAD one. A human or auto gate rests on no
    // note, and an `evidence: null` there would be a key claiming the record
    // knows something it does not — every `gate.revoked` written before #123
    // stays shape-identical.
    ...(signedOver === null ? {} : { evidence: { ...signedOver } }),
    staled: later,
    // Additive (#228): absent, not `[]`-by-convention, on every `gate.revoked`
    // written before this existed — a reader tolerant of a missing key needs no
    // second case for "the field exists and is empty".
    ...(demoted.length === 0 ? {} : { demoted }),
  }));
  store.save();
  return {
    stage: entry.stage.id, phase: entry.phase.id, note: ctx.note,
    signedBy, signedAt, signedOver, staled: later, demoted,
    givenAway: givenAwayLines(store.events.read(), store.budget, store.run, store.runId, entry.phase.id),
  };
}

/** `<phase>/<stage>`, or a bare stage id when it is unambiguous. */
function locate(store: RunStore, target: string): { phase: RunPhase; stage: RunStage } {
  const all = flattenEntries(store.run);
  const slash = target.indexOf("/");
  if (slash > 0) {
    const phaseId = target.slice(0, slash);
    const stageId = target.slice(slash + 1);
    const found = all.find((e) => e.phase.id === phaseId && e.stage.id === stageId);
    if (found === undefined) {
      throw new GateError(`no stage ${target} in this run — it has ${describeStages(all)}`);
    }
    return found;
  }
  const matches = all.filter((e) => e.stage.id === target);
  const only = matches[0];
  if (only === undefined) {
    throw new GateError(`no stage \`${target}\` in this run — it has ${describeStages(all)}`);
  }
  if (matches.length > 1) {
    const named = matches.map((e) => `${e.phase.id}/${e.stage.id}`).join(", ");
    throw new GateError(`\`${target}\` names ${matches.length} stages (${named}) — pass <phase>/<stage>`);
  }
  return only;
}

function describeStages(all: readonly { phase: RunPhase; stage: RunStage }[]): string {
  return all.map((e) => `${e.phase.id}/${e.stage.id}`).join(", ");
}

function flattenEntries(run: RunFile): readonly { phase: RunPhase; stage: RunStage }[] {
  const out: { phase: RunPhase; stage: RunStage }[] = [];
  for (const phase of run.phases) for (const stage of phase.stages) out.push({ phase, stage });
  return out;
}

/** Every stage after the named one, in execution order. */
function stagesAfter(
  run: RunFile,
  phaseId: string,
  stageId: string,
): readonly { phase: RunPhase; stage: RunStage }[] {
  const all = flattenEntries(run);
  const at = all.findIndex((e) => e.phase.id === phaseId && e.stage.id === stageId);
  return at === -1 ? [] : all.slice(at + 1);
}

// --- helpers ---------------------------------------------------------------

function requireGate(store: RunStore, verb: string): { phase: RunPhase; stage: RunStage } {
  return requireStatus(store, verb, ["awaiting_gate"]);
}

function requireStatus(
  store: RunStore,
  verb: string,
  allowed: readonly string[],
): { phase: RunPhase; stage: RunStage } {
  const entry = store.cursorEntry();
  if (entry === null) {
    throw new GateError(`cursor ${store.run.cursor.phase}/${store.run.cursor.stage} does not resolve to a stage`);
  }
  if (!allowed.includes(entry.stage.status)) {
    const wanted = allowed.map((status) => `\`${status}\``).join(" or ");
    throw new GateError(
      `nothing to ${verb}: ${entry.phase.id}/${entry.stage.id} is \`${entry.stage.status}\`, not ${wanted}`,
    );
  }
  return entry;
}

function plannedStage(root: string, run: RunFile, stageId: string): PlannedStage | null {
  try {
    return loadWorkflowPreset(root, run.scope).stages.find((s) => s.id === stageId) ?? null;
  } catch (error) {
    if (error instanceof PresetError) return null;
    throw error;
  }
}

function mapStage(run: RunFile, phaseId: string, stageId: string, fn: (stage: RunStage) => RunStage): RunFile {
  return {
    ...run,
    phases: run.phases.map((phase) =>
      phase.id !== phaseId
        ? phase
        : { ...phase, stages: phase.stages.map((stage) => (stage.id === stageId ? fn(stage) : stage)) },
    ),
  };
}

function event(
  ts: string,
  run: string,
  stage: string | null,
  type: TldrxEvent["type"],
  actor: string,
  payload: Record<string, unknown>,
): TldrxEvent {
  return { ts, run, stage, type, actor, cost_usd: 0, payload };
}
