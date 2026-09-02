/**
 * What ONE run is waiting on — the single derivation, for every reader.
 *
 * This used to live inside `runStatus.ts` and be reachable only through
 * `whatIsWaiting(run: RunFile, …)`. The dashboard could not call it: its reader
 * (`src/core/replay/RunDocument.ts`) projects `run.yml` tolerantly into a
 * `RunDocument`, not into the strictly-validated `RunFile`, so it re-derived the
 * answer from the gate objects instead — "the first stage whose gate is still
 * `pending`". That is a different question, and on a fresh run it gives a
 * different answer: every gate of a brand-new run is `pending`, so the dashboard
 * called an untouched run "waiting at a gate" while `tldrx run status` called it
 * `ready`. Two screens, one file, two stories.
 *
 * So the derivation moved here and is typed STRUCTURALLY — the smallest shape
 * that can answer the question (`WaitingRun`), which both `RunFile` and
 * `RunDocument` already satisfy. `runStatus.ts` keeps `whatIsWaiting` as a thin
 * `RunFile` wrapper so nothing that imported it has to change, and the dashboard
 * model calls `waitingFor` on the document it already loaded. There is now one
 * function, and the two screens cannot disagree.
 *
 * Reads exactly one file beyond the run document it is handed: the cursor
 * phase's `questions.md`, for the open block ids. No model, no network, no write.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { openBlocks, parseQuestions } from "../text/questions.ts";
import { isAlive, readLock } from "../facilitator/Lock.ts";
import { hasPreparedBundle } from "./prepared.ts";

/**
 * Every kind, as a VALUE — so a reader can enumerate them.
 *
 * It was a bare type union, which is invisible at runtime, and a screen could
 * therefore claim to cover "every waiting kind" while handling five of the eight
 * and nothing could contradict it. The dashboard did exactly that: `prepared`
 * and `running` fell through its WAITING ON column into "nothing", for months,
 * with a test asserting full coverage a few lines away (measured 2026-09-01).
 * A list a test can iterate makes the next addition a visible act.
 *
 * `running` — a live `next` holds the run's `.lock`; nobody else may touch it.
 * `prepared` — a `--prepare` bundle is on disk and no process is holding the run.
 * `cancelled` — a human closed the run with `tldrx run cancel` (gh #86).
 */
export const WAITING_KINDS = [
  "gate", "answer", "ready", "done", "blocked", "failed", "running", "prepared", "cancelled",
] as const;
export type WaitingKind = (typeof WAITING_KINDS)[number];

export interface Waiting {
  readonly kind: WaitingKind;
  readonly message: string;
  /** Open question ids in the cursor phase, when the run is waiting on answers. */
  readonly questions: readonly string[];
}

/**
 * The waiting kinds a human can act on right now.
 *
 * `done` is finished, `cancelled` was closed on purpose, `blocked` needs
 * something else to move first, and `running` is already in someone's hands, so
 * none of the four is a run you can
 * be handed. `prepared` IS one: the bundle is written and it is waiting on a
 * human to run the prompt and come back through `--commit`. `tldrx status` uses this to pick which run
 * wears `← next`, and the dashboard uses it for the same decision.
 */
export const MOVABLE_KINDS: readonly WaitingKind[] = ["gate", "answer", "ready", "failed", "prepared"];

export function isMovable(kind: WaitingKind): boolean {
  return MOVABLE_KINDS.includes(kind);
}

// ---------------------------------------------------------------------------
// The structural minimum. Both `RunFile` and `RunDocument` are assignable.
// ---------------------------------------------------------------------------

export interface WaitingTask {
  readonly error: string | null;
}

export interface WaitingStage {
  readonly id: string;
  readonly status: string;
  readonly tasks: readonly WaitingTask[];
}

export interface WaitingPhase {
  readonly id: string;
  readonly stages: readonly WaitingStage[];
}

export interface WaitingCursor {
  readonly phase: string;
  readonly stage: string;
}

/**
 * `run.yml`'s `cancelled:` — who closed the run by hand, when, and why.
 *
 * Structurally the same three strings `RunFile.RunCancellation` carries, spelled
 * again here for the same reason every other shape in this file is: `waiting.ts`
 * must not depend on the strict schema, or the dashboard's tolerantly-read
 * document could not be passed to it.
 */
export interface WaitingCancellation {
  readonly by: string;
  readonly at: string;
  readonly note: string;
}

export interface WaitingRun {
  /** `RunFile` always has one; a tolerantly-read `RunDocument` may not. */
  readonly cursor: WaitingCursor | null;
  /**
   * Present only on a run `tldrx run cancel` closed (gh #86).
   *
   * The field this shape was MISSING, and the reason a closed run was told to
   * retry itself: the answer used to come from the status of the stage at the
   * cursor, and cancelling a run deliberately leaves that stage `failed` —
   * "which is history, not state" (`RunFile.RunCancellation`). `deriveRunStatus`
   * had read the decision first since the field existed; this could not see it
   * at all, so `tldrx run status` and the dashboard — one derivation since
   * #60 — both offered `tldrx next` on a run somebody had closed.
   *
   * Optional and nullable so BOTH readers satisfy it: `RunFile` leaves the key
   * off entirely, the tolerant `RunDocument` projects `null`.
   */
  readonly cancelled?: WaitingCancellation | null;
  readonly phases: readonly WaitingPhase[];
}

/**
 * Why a stage failed. A stage has no `error` field (spec §2.2) — the reason is
 * recorded on the task that failed, so that is where this reads it from.
 */
export function failureReason(stage: WaitingStage): string | null {
  const error = [...stage.tasks].reverse().find((task) => task.error !== null)?.error ?? null;
  return error === null || error.trim() === "" ? null : oneLine(error);
}

function oneLine(text: string): string {
  return text.split("\n")[0]?.trim() ?? "";
}

/**
 * The stage the cursor points at, or null when it points at nothing.
 *
 * `RunFile.stageAt` does the same for the strict type; this one is structural so
 * the dashboard's document can use it too.
 */
function stageAtCursor(
  run: WaitingRun,
  cursor: WaitingCursor,
): { phase: WaitingPhase; stage: WaitingStage } | null {
  for (const phase of run.phases) {
    for (const stage of phase.stages) {
      if (phase.id === cursor.phase && stage.id === cursor.stage) return { phase, stage };
    }
  }
  return null;
}

/**
 * The ONE answer to "what is this run waiting on".
 *
 * It is derived from the STATUS of the stage the cursor sits on, never from the
 * gate objects: `awaiting_gate` is the status a stage wears while a gate holds
 * it, and a `gate.status: pending` on a stage nobody has run yet is just the
 * initial value of a field.
 */
export function waitingFor(run: WaitingRun, runDir: string): Waiting {
  // A cancellation is a DECISION, not a roll-up, so it is read before anything
  // is derived — the same order, and for the same reason, as `deriveRunStatus`
  // (`RunFile.ts`). It has to come first: the run most often cancelled is one
  // whose stage FAILED, and that stage keeps its failure, so any answer derived
  // from the cursor would offer a retry on a run a person deliberately closed.
  //
  // It also comes before the cursor checks. A run with no resolvable cursor is
  // `blocked` — something to go and fix — and a closed run is not that either.
  if (run.cancelled !== undefined && run.cancelled !== null) {
    return { kind: "cancelled", message: cancelledMessage(run.cancelled), questions: [] };
  }
  const cursor = run.cursor;
  if (cursor === null) {
    return { kind: "blocked", message: "run.yml records no cursor, so nothing can say where it is", questions: [] };
  }
  const entry = stageAtCursor(run, cursor);
  if (entry === null) {
    return {
      kind: "blocked",
      message: `cursor ${cursor.phase}/${cursor.stage} does not resolve to a stage`,
      questions: [],
    };
  }
  const open = openQuestionIds(join(runDir, cursor.phase, "questions.md"));

  switch (entry.stage.status) {
    case "awaiting_gate":
      return {
        kind: "gate",
        message: `gate on ${entry.phase.id}/${entry.stage.id} — \`tldrx approve\` or \`tldrx reject --note "…"\``,
        questions: open,
      };
    case "awaiting_answer":
      return {
        kind: "answer",
        message: open.length === 0
          ? `stage ${entry.stage.id} is waiting on an answer, but ${cursor.phase}/questions.md has no open block`
          : `${open.length} open question(s) in ${cursor.phase}/questions.md — \`tldrx answer ${open[0] ?? "Q1"} "…"\``,
        questions: open,
      };
    case "failed": {
      const reason = failureReason(entry.stage);
      return {
        kind: "failed",
        message: `${entry.phase.id}/${entry.stage.id} FAILED${reason === null ? "" : `: ${reason}`} — ` +
          "retry: `tldrx next` · or: `tldrx reject --note \"…\"`",
        questions: open,
      };
    }
    // `running` is three different situations wearing one word, and calling all
    // three `ready` was the audit's second finding: it offered `tldrx next`,
    // which for an orphaned `--prepare` re-spawns the stage and bins work the
    // run has already been billed for.
    case "running": {
      const holder = readLock(runDir);
      if (holder !== null && isAlive(holder.pid)) {
        return {
          kind: "running",
          message: `stage is running (pid ${String(holder.pid)}) — wait, or ` +
            `\`tldrx run unlock ${basename(runDir)}\` if it died`,
          questions: open,
        };
      }
      if (hasPreparedBundle(runDir, entry.stage.id)) {
        return {
          kind: "prepared",
          message: "a --prepare bundle is waiting — run the prompt and " +
            `\`tldrx next --commit ${basename(runDir)}\`, or ` +
            `\`tldrx reject --run ${basename(runDir)} --note …\` to discard`,
          questions: open,
        };
      }
      // No lock, no bundle: a crash between `markRunning` and the spawn. `next`
      // demotes it back to `ready` on its next pass, so say what it will say.
      return {
        kind: "ready",
        message: `next up: ${entry.phase.id}/${entry.stage.id} (running, but nothing holds it) — \`tldrx next\``,
        questions: open,
      };
    }
    case "done":
    case "skipped":
    case "cancelled":
      return { kind: "done", message: "every stage is terminal — nothing is waiting", questions: open };
    case "blocked":
      return { kind: "blocked", message: `stage ${entry.stage.id} is blocked`, questions: open };
    default:
      return {
        kind: "ready",
        message: `next up: ${entry.phase.id}/${entry.stage.id} (${entry.stage.status}) — \`tldrx next\``,
        questions: open,
      };
  }
}

/**
 * Who closed the run, when, and what they said — the three facts every screen
 * dropped (gh #86).
 *
 * No command is offered, deliberately. `tldrx next` on a cancelled run already
 * advances nothing and says so, and printing it here is what made an operator
 * think there was something left to do. `tldrx replay <run>` is how the history
 * of a closed run is read, and it is not "what this run is waiting on".
 */
function cancelledMessage(cancelled: WaitingCancellation): string {
  const by = cancelled.by.trim() === "" ? "someone" : cancelled.by.trim();
  const when = cancelled.at.trim() === "" ? "" : ` at ${cancelled.at.trim()}`;
  const note = cancelled.note.trim();
  return `run cancelled by ${by}${when}${note === "" ? "" : ` — ${note}`}`;
}

function openQuestionIds(path: string): readonly string[] {
  if (!existsSync(path)) return [];
  try {
    return openBlocks(parseQuestions(readFileSync(path, "utf8")).blocks).map((b) => b.id);
  } catch {
    return [];
  }
}
