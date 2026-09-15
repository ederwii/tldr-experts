/**
 * `tldrx story reopen <id>` — one story, given another run of attempts, by a person.
 *
 * The third verb in the family that landed 2026-08-30, and the one the other two
 * cannot cover. `65ab09a` stopped a reviewer that FAILED being read as a verdict;
 * `a48ec02` stopped a developer that FAILED being read as an attempt. Both are
 * about the MACHINE mis-reading a transport error as a judgement, and both are
 * automatic. This one is the opposite case: the machine read the run correctly and
 * a person disagrees with the outcome.
 *
 * Measured on `260830-tenancy-identity-customers` (`~/aparece-v2`). Story S3 is
 * `blocked` after two GENUINE `changes` verdicts — its headless developers ran,
 * committed nothing, and both reviewers correctly refused an empty diff. Neither
 * rescue applies and neither should: the verdicts are real and the attempts were
 * really consumed. But S3 gates wave 3 (S4, S6 depend on it), the owner has decided
 * it must be built, and the only reopening verb in the CLI was
 * `tldrx reject --stage`, which works at STAGE level and revokes an approval.
 * There was no way to say "this one story, again" — and `run.yml` and the story
 * files are hand-edit-forbidden by design (spec §1: the files are the state, and
 * the state is written by the tool).
 *
 * So: human-signed, like `approve` and `reject`. It requires a `--note`, appends
 * one `story.reopened` carrying the actor, the note and the prior state, and puts
 * the story back to `todo`. Nothing else moves. It runs no agent, spends nothing,
 * deletes nothing and refunds nothing.
 *
 * **What carries the last attempt's work forward is the BRANCH, not the worktree.**
 * `story/<run>/<story>` holds every commit the story's developers made and nothing
 * here touches it, so the next turn opens on top of them. The worktree is left
 * exactly as the build left it — kept for a story parked at `review`, already
 * removed by `cleanUp` for one that blocked — and `openStory` reopens it from the
 * branch when it is gone. "The worktree is kept" would be false for the blocked
 * case, which is the case this verb exists for.
 *
 * **The attempt counter resets to 1 of the stage's `attempts:`**, and the mechanism is the
 * event, not a counter written anywhere: `readReviewLedger` treats
 * `story.reopened` as a reset boundary, so the verdicts before it stop counting
 * against the reopened run of attempts. Nothing is erased to make that true —
 * every event of every earlier attempt is still in `events.jsonl`, still read by
 * `replay`, `cost` and `retro`, and the reopen event itself records how many
 * verdicts were consumed before it. A full reset is the honest choice precisely
 * because the history survives it: "you get two more turns" is what an owner
 * overruling a block actually means, and half-resetting it would be a number
 * nobody could explain from the record.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_WORK_DIR } from "../paths.ts";
import { RunStore } from "./RunStore.ts";
import { ambiguousRunLines } from "./openRuns.ts";
import { BUILD_PHASE, buildProgress, PLAN_DIR, storyDependsOn } from "./buildProgress.ts";
import { IMPLICIT_PLAN_FILE, updateImplicitPlan } from "../build/implicitPlan.ts";
import { StoryWriteError, updateStoryFront } from "../build/storyFile.ts";
import { readReviewLedger } from "../facilitator/executors/build.ts";
import { buildStageDefaults } from "./workflowPreset.ts";
import type { RunStage } from "./RunFile.ts";
import { validateEvent, type TldrxEvent } from "../events/Event.ts";
import { dependencyHoldOfLog, releasedByReopen, type ReleaseCandidate } from "../build/dependencyHold.ts";
import { LOG_DIR } from "../build/plan.ts";

export interface ReopenOptions {
  readonly root: string;
  /** The story id as typed, e.g. `S3`. */
  readonly storyId: string;
  /** Required. A reopen with no reason is not actionable. */
  readonly note: string;
  /**
   * Open a FIX ROUND on a story that is `done` (issue #58): the note names one
   * defect, no attempt is consumed, and the fix passes the same DoD and the same
   * reviewer as the original. Absent — every existing caller — is the plain verb,
   * unchanged.
   */
  readonly forFix?: boolean;
  /**
   * Settle the story from its BRANCH AS IT STANDS (#279): the next Build turn
   * runs the DoD, the review and the merge over the commits already on
   * `story/<run>/<id>`, and spawns NO developer.
   *
   * The case the plain verb cannot reach. `reopen` hands the story to a
   * developer, and a developer handed a branch whose work is already finished
   * has nothing to do — #271 then blocks the story after one attempt, correctly,
   * because work that predates the spawn is indistinguishable from a developer
   * that did nothing. Measured on a real unattended run (0.18.2): the only way
   * to merge a hand-finished branch was to invent a commit for the developer to
   * make.
   *
   * It does not weaken #271. Nothing is spawned, so there is no spawn to measure
   * work since; the DoD and the reviewer are unchanged and still decide, and the
   * Build refuses the settlement outright when the branch carries nothing its
   * epic has not already got or when the DoD goes red.
   *
   * One named case beside that refusal (#295): a story whose work is ALREADY on
   * the epic from an earlier turn and whose review never completed is settled
   * REVIEW-ONLY — nothing merged, the DoD on the epic head, the reviewer over
   * the range the story was merged as. Decided by the Build off the ledger, not
   * here: this verb records the signature and nothing about the branch.
   */
  readonly asIs?: boolean;
  readonly runId?: string;
  readonly actor: string;
  readonly at: string;
}

export interface ReopenOutcome {
  readonly code: number;
  readonly lines: readonly string[];
}

const EXIT_OK = 0;
/** Spec §3: `refused`. Every one of this verb's own refusals is a refusal to act. */
const EXIT_REFUSED = 2;
const EXIT_NOT_FOUND = 3;

/**
 * The states a story may be reopened FROM.
 *
 * `blocked` is the case this exists for. `review` and `in_progress` are here
 * because they are the other two ways a story sits unfinished mid-run — a
 * requeued story waiting on its second developer, and one a `--prepare` bundle
 * was cut for — and an owner who wants that story started over should not have to
 * wait for it to block first.
 */
const REOPENABLE: ReadonlySet<string> = new Set(["blocked", "review", "in_progress"]);

/** The status a reopened story goes to. The operator's intent is "run the developer again". */
const REOPENED_TO = "todo";

export function reopenStory(options: ReopenOptions): ReopenOutcome {
  const id = options.storyId.trim();
  if (id === "") {
    return refuse(['story reopen needs a story id: `tldrx story reopen S3 --note "why"`']);
  }
  const forFix = options.forFix === true;
  const asIs = options.asIs === true;
  if (options.note.trim() === "") {
    return asIs
      ? refuse([
        `story reopen --as-is needs --note: \`tldrx story reopen ${id} --as-is --note "<what you did by hand>"\``,
        "  the note is the ONLY record of who finished this branch and how — no developer will run,",
        "  so nothing else in the log will say where the commits came from",
      ])
      : forFix
      ? refuse([
        `story reopen --for-fix needs --note: \`tldrx story reopen ${id} --for-fix --note "<the defect>"\``,
        "  the note IS the defect — it is what scopes the fix round, and what the reviewer reads",
        "  to tell a fix from a second opinion about the story",
      ])
      : refuse([
        `story reopen needs --note: \`tldrx story reopen ${id} --note "why it must be built"\``,
        "  a reopen with no reason is not actionable — the note is the whole of what the next reader gets",
      ]);
  }

  const resolution = RunStore.resolve(options.root, options.runId);
  if (resolution.kind === "ambiguous") {
    return { code: EXIT_REFUSED, lines: [...ambiguousRunLines(resolution.open)] };
  }
  if (resolution.kind === "none") {
    return {
      code: EXIT_NOT_FOUND,
      lines: [options.runId === undefined
        ? `no non-terminal run in ${PROJECT_WORK_DIR}/`
        : `no run '${options.runId}' in ${PROJECT_WORK_DIR}/`],
    };
  }
  const store = resolution.store;

  // The plan is the list of stories that EXIST — read from the same two files
  // `run status` reads, so an id this refuses is an id nothing could ever run.
  const progress = buildProgress(store.runDir);
  if (progress === null) {
    return refuse([
      `${store.runId} has no plan, so it has no story to reopen`,
      `  a story lives in ${PLAN_DIR}/stories/<id>.md or ${BUILD_PHASE}/${IMPLICIT_PLAN_FILE}, and this run has neither`,
    ]);
  }
  const rows = progress.waves.flatMap((wave) => wave.stories.map((s) => ({ ...s, wave: wave.id })));
  const row = rows.find((s) => s.id === id);
  if (row === undefined) {
    return refuse([
      `${store.runId} plans no story \`${id}\``,
      `  it plans ${rows.map((s) => s.id).join(", ")}`,
    ]);
  }

  const stage = buildStage(store);
  // Read once, before any refusal that depends on it. `readReviewLedger` is a
  // pure read of `events.jsonl`, and BOTH halves of this verb need it: the fix
  // round's bound is in it, and the plain verb's reset count is too.
  const ledger = readReviewLedger(store.runDir, id);

  if (forFix) {
    // The bound the owner set: ONE open fix round per story (2026-09-01). Checked
    // before the `done` check on purpose — the story of an open fix round is
    // `todo`, so the generic "not done" refusal would fire first and say the
    // wrong thing about the right situation.
    if (ledger.fixRound !== null) {
      return refuse([
        `${id} already has a fix round open — one at a time`,
        `  opened by ${ledger.fixRound.actor} at ${ledger.fixRound.at}: ${ledger.fixRound.note}`,
        "  land that one (the round closes when the story is `done` again) before opening another.",
        "  Two open rounds on one story is two defects with one set of acceptance criteria between them,",
        "  and no way to tell which fix a reviewer just approved.",
      ]);
    }
    if (row.status !== "done") {
      return refuse([
        `${id} is \`${row.status}\`, not \`done\` — \`--for-fix\` reopens work that FINISHED`,
        "  a fix round exists for a defect found in work a reviewer already approved and merged.",
        `  An unfinished story is the plain verb's job: \`tldrx story reopen ${id} --note "…"\``,
      ]);
    }
  }

  if (!forFix && row.status === "done") {
    return refuse([
      `${id} is \`done\` — refusing to reopen finished work`,
      "  a done story was built, its dod ran green and a reviewer approved it, and its commit is merged.",
      "  Taking that back is a decision about the STAGE, not about one story:",
      `  \`tldrx reject --stage ${BUILD_PHASE}/${stage?.id ?? "<stage>"} --note "…"\` revokes the approval and marks`,
      "  what followed stale. This verb only gives an UNFINISHED story another run of attempts.",
      "  For ONE named defect in that finished work, open a FIX ROUND instead:",
      `  \`tldrx story reopen ${id} --for-fix --note "<the defect>"\` — no attempt is consumed, the fix passes`,
      "  the same dod and the same reviewer, and the story's acceptance criteria do not move.",
    ]);
  }
  if (!forFix && row.status === REOPENED_TO) {
    return refuse([
      `${id} is already \`${REOPENED_TO}\` — nothing to reopen`,
      `  it is pending as it stands: \`tldrx next ${store.runId}\` offers it at attempt 1.`,
    ]);
  }
  if (!forFix && !REOPENABLE.has(row.status)) {
    return refuse([
      `${id} is \`${row.status}\`, which is not a state a story can be reopened from`,
      `  reopenable: ${[...REOPENABLE].join(", ")}`,
      ...(row.status === "missing"
        ? [`  \`${PLAN_DIR}/stories/${id}.md\` is scheduled in ${row.wave} and not on disk — that is a broken plan, not a blocked story`]
        : []),
    ]);
  }

  const path = progress.implicit
    ? join(store.runDir, BUILD_PHASE, IMPLICIT_PLAN_FILE)
    : join(store.runDir, PLAN_DIR, "stories", `${id}.md`);
  if (!existsSync(path)) {
    return refuse([`${id} is \`${row.status}\` but ${path} is not on disk — refusing to write a file that is not there`]);
  }

  // Everything the reopen is ABOUT is read, and BOTH writes are proved possible,
  // before either happens. The order matters and is deliberate.
  //
  // The status line goes down first and the event second, because the two failure
  // modes are not symmetrical: a story left `todo` with no event is offered again
  // at attempt 2 — degraded, but nothing claims otherwise — whereas an event with
  // no status change would reset the ledger for a story still `blocked`, which is
  // a counter nothing can explain. So the file, then the log.
  //
  // Which leaves one window worth closing: `EventLog.append` validates, and a
  // `--note` is free text, so a note over the §2.9 4KB payload cap would throw
  // AFTER the story file had been rewritten. Both are checked here instead.
  let patched: string;
  try {
    const text = readFileSync(path, "utf8");
    patched = progress.implicit
      ? updateImplicitPlan(text, { status: REOPENED_TO })
      : updateStoryFront(text, { status: REOPENED_TO });
  } catch (error) {
    if (error instanceof StoryWriteError) {
      return refuse([`${id}'s file cannot be updated: ${error.message}`, `  ${path}`]);
    }
    throw error;
  }

  const event = reopenEvent(options, store.runId, id, row.wave, row.status, ledger.verdicts, forFix, asIs);
  const validation = validateEvent(event);
  if (!validation.ok) {
    const first = validation.issues[0];
    return refuse([
      `the story.reopened event this would append is not valid: ${first?.path ?? ""} ${first?.message ?? "schema error"}`,
      "  nothing was written — the note is the only free text in it, so it is almost certainly too long",
    ]);
  }

  // #312: a BLOCKED dependency going back to `todo` makes every hold that named
  // it stale in the same instant. Prepared — files patched in memory, events
  // built and validated — before anything is written, so a cascade that cannot
  // be recorded leaves nothing half-moved.
  const cascade = !forFix && row.status === "blocked" && !progress.implicit
    ? prepareCascade(options, store, id, rows)
    : { writes: [], lines: [] };
  if ("refusal" in cascade) return refuse(cascade.refusal);

  writeFileSync(path, patched, "utf8");
  store.append(event);
  for (const write of cascade.writes) {
    writeFileSync(write.path, write.text, "utf8");
    store.append(write.event);
  }

  const kept = [
    "  its branch is kept, so the next developer starts from the commits the last one made "
      + "(the worktree is reopened from that branch if the build had removed it)",
    `  nothing was deleted and no cost was refunded — \`tldrx replay ${store.runId}\` still reads every attempt`,
    `  ${nextStep(store.runId, stage)}`,
  ];

  // THIS run's Build stage, not the constant: a workspace that wrote
  // `attempts: 3` must not be told its fix round is "1 of 2".
  const attempts = buildStageDefaults(options.root, store.run.scope).attempts;
  if (forFix) {
    return {
      code: EXIT_OK,
      lines: [
        `reopened ${id} in ${store.runId} — \`${row.status}\` → \`${REOPENED_TO}\` (${row.wave}), as a fix round`,
        `  defect: ${options.note}`,
        "  no attempt was consumed: the verdict that closed this story stops counting against it, "
          + `so the fix runs as attempt 1 of ${String(attempts)}`,
        "  the fix must pass the same dod and the same reviewer the story passed — a fix round ends "
          + "the way the story did, or it does not end",
        "  the story's acceptance criteria are unchanged, and this verb did not touch them: it reopens "
          + "the story for the defect above, not for its scope",
        `  one fix round at a time — this one closes when ${id} is \`done\` again`,
        ...kept,
      ],
    };
  }

  if (asIs) {
    return {
      code: EXIT_OK,
      lines: [
        `reopened ${id} in ${store.runId} — \`${row.status}\` → \`${REOPENED_TO}\` (${row.wave}), `
          + "to be settled from its branch AS IT STANDS",
        `  signed by ${options.actor}: ${options.note}`,
        "  no developer will be spawned: the next Build turn runs the dod, the review and the merge "
          + "over the commits already on the story branch",
        "  it is not a shortcut past either gate — a red dod BLOCKS the story, and so does a branch "
          + "that carries no commit its epic has not already got; the refusal says which",
        "  one named exception: work that is ALREADY on the epic with a review that never completed is "
          + "settled review-only — nothing merged, the dod on the epic head, the reviewer over the recorded range",
        "  the record will say the branch was taken as it stands and name you, so nothing reads as "
          + "though a developer delivered it",
        ...cascade.lines,
        ...kept,
      ],
    };
  }

  return {
    code: EXIT_OK,
    lines: [
      `reopened ${id} in ${store.runId} — \`${row.status}\` → \`${REOPENED_TO}\` (${row.wave})`,
      `  note: ${options.note}`,
      ledger.verdicts === 0
        ? "  no reviewer had judged it, so no attempt was consumed; it runs as attempt 1"
        : `  ${String(ledger.verdicts)} verdict(s) were consumed before this and stay on the record — `
          + "they no longer count against it, and the next developer runs as attempt 1",
      ...cascade.lines,
      ...kept,
    ],
  };
}

interface CascadeWrite {
  readonly path: string;
  readonly text: string;
  readonly event: TldrxEvent;
}

/**
 * The dependents a reopen of `reopened` releases, prepared and not yet written
 * (#312). The rule is `releasedByReopen`'s — this reads the files it needs and
 * turns its answer into story files, events and the lines that say so.
 *
 * Each release is a plain `story.reopened` (`reason: attempts`), signed by the
 * same actor, with two additive keys: `released_by` (the story whose reopen
 * caused it) and `dependency` (the hold its log named). Its note is the cause,
 * spelled out; the operator's own note is on the reopen that caused it.
 */
function prepareCascade(
  options: ReopenOptions,
  store: RunStore,
  reopened: string,
  rows: readonly { readonly id: string; readonly status: string; readonly wave: string }[],
): { readonly writes: readonly CascadeWrite[]; readonly lines: readonly string[] } | { readonly refusal: readonly string[] } {
  const candidates: ReleaseCandidate[] = rows.map((planned) => ({
    id: planned.id,
    status: planned.status,
    dependsOn: storyDependsOn(store.runDir, planned.id),
    hold: planned.status === "blocked" ? holdOf(store.runDir, planned.id) : null,
  }));
  const { released, stayed } = releasedByReopen(reopened, candidates);
  const writes: CascadeWrite[] = [];
  const lines: string[] = [];
  for (const release of released) {
    const planned = rows.find((r) => r.id === release.id);
    if (planned === undefined) continue;
    const path = join(store.runDir, PLAN_DIR, "stories", `${release.id}.md`);
    let text: string;
    try {
      text = updateStoryFront(readFileSync(path, "utf8"), { status: REOPENED_TO });
    } catch (error) {
      return {
        refusal: [
          `${reopened} was not reopened: its dependent ${release.id} would be released, and its file cannot be updated: `
            + (error instanceof Error ? error.message : String(error)),
          `  ${path}`,
          "  nothing was written",
        ],
      };
    }
    const cause = release.dependency === reopened
      ? `its only hold was dependency ${reopened}, which ${options.actor} reopened`
      : `its only hold was dependency ${release.dependency}, which this reopen of ${reopened} released`;
    const base = reopenEvent(
      { ...options, note: `released by the reopen of ${reopened}: ${cause}` },
      store.runId, release.id, planned.wave, planned.status, readReviewLedger(store.runDir, release.id).verdicts, false, false,
    );
    const event: TldrxEvent = {
      ...base,
      payload: { ...base.payload, released_by: reopened, dependency: release.dependency },
    };
    const validation = validateEvent(event);
    if (!validation.ok) {
      const first = validation.issues[0];
      return {
        refusal: [
          `the story.reopened event releasing ${release.id} is not valid: ${first?.path ?? ""} ${first?.message ?? "schema error"}`,
          "  nothing was written",
        ],
      };
    }
    writes.push({ path, text, event });
    lines.push(`  released ${release.id} — \`blocked\` → \`${REOPENED_TO}\`: ${cause}; no attempt was consumed`);
  }
  for (const held of stayed) lines.push(`  ${held.id} stays \`blocked\`: ${held.reason}`);
  return { writes, lines };
}

/** The dependency a story's review log says blocked it, or null — `dependencyHoldOfLog`, off the file. */
function holdOf(runDir: string, id: string): string | null {
  try {
    return dependencyHoldOfLog(readFileSync(join(runDir, BUILD_PHASE, LOG_DIR, `${id}.md`), "utf8"));
  } catch {
    return null;
  }
}

/**
 * What the operator has to do next, which depends on where the BUILD STAGE is —
 * not on the story.
 *
 * Reopening a story makes it pending; it does not make the stage runnable, and
 * saying "run `tldrx next`" at a stage sitting on a signed gate would be advice
 * that does nothing. Deliberately not automated: sending a stage back is
 * `reject`'s job, it is its own signed decision, and one verb quietly performing
 * another's is how a gate stops meaning anything.
 */
function nextStep(runId: string, stage: RunStage | undefined): string {
  if (stage === undefined) return `\`tldrx next ${runId}\` runs the Build stage`;
  const at = `${BUILD_PHASE}/${stage.id}`;
  if (stage.gate.status === "approved") {
    return `${at} is already approved — \`tldrx reject --stage ${at} --note "…"\` takes that back first, `
      + `then \`tldrx next ${runId}\``;
  }
  if (stage.status === "awaiting_gate") {
    return `${at} is sitting at its gate — \`tldrx reject --note "…"\` sends it back to \`ready\`, `
      + `then \`tldrx next ${runId}\``;
  }
  return `${at} is \`${stage.status}\` — \`tldrx next ${runId}\` picks the story up`;
}

/** The run's Build stage, when it has one. */
function buildStage(store: RunStore): RunStage | undefined {
  return store.run.phases.find((phase) => phase.id === BUILD_PHASE)?.stages[0];
}

function reopenEvent(
  options: ReopenOptions,
  runId: string,
  storyId: string,
  wave: string,
  from: string,
  verdicts: number,
  forFix: boolean,
  asIs: boolean,
): TldrxEvent {
  return {
    ts: options.at,
    run: runId,
    // The operator acted outside a stage run — the same call `run.unlocked` and
    // `run.cancelled` make. `payload.story` is what carries the story, and it is
    // what `readReviewLedger` filters on.
    stage: null,
    type: "story.reopened",
    actor: options.actor,
    cost_usd: 0,
    payload: {
      phase: BUILD_PHASE,
      story: storyId,
      wave,
      from_status: from,
      to_status: REOPENED_TO,
      /** Verdicts the closed run of attempts consumed. Kept because the reset erases the count, not the history. */
      verdicts,
      /**
       * WHY this story was reopened (issue #58) — `fix` for a named defect in
       * finished work, `attempts` for the original verb. Written on BOTH so a
       * reader never has to infer one from the absence of the other, and so the
       * fix-round bound has something to count. Additive: a `story.reopened`
       * with no `reason` predates this key and is an `attempts` reopen, which is
       * the only kind that existed.
       *
       * `as_is` was added 2026-09-13 (#279): the same reopen, settled from the
       * branch as it stands with no developer spawned. It is what
       * `readReviewLedger` reads to know the next Build turn must not spawn one,
       * and it is the record of WHO decided that.
       */
      reason: forFix ? "fix" : asIs ? "as_is" : "attempts",
      note: options.note,
    },
  };
}

function refuse(lines: readonly string[]): ReopenOutcome {
  return { code: EXIT_REFUSED, lines };
}
