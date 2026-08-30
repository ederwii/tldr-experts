/**
 * `tldrx run unlock` and `tldrx run cancel` — the two ways out of a stuck run.
 *
 * Before these existed there was none (2026-08-29 audit, §B and §F.5). A `.lock`
 * whose pid had been REUSED by an unrelated process was permanent: `isAlive` said
 * true, `next` exited 2, and the only fix was knowing to delete a gitignored file
 * by hand. And `cancelled` was a status in the schema with nothing that could
 * write it, so a run you had given up on stayed open, stayed in `tldrx status`,
 * and stayed the thing every id-less command tripped over.
 *
 * Both are deliberately small and deliberately loud: they mutate one field, they
 * append one event, and neither spends a cent or touches a stage's outputs.
 */
import { existsSync } from "node:fs";
import { PROJECT_WORK_DIR } from "../paths.ts";
import { isAlive, lockPath, readLock, releaseLock } from "../facilitator/Lock.ts";
import { ambiguousRunLines } from "./openRuns.ts";
import { hasPreparedBundle } from "./prepared.ts";
import { RunStore } from "./RunStore.ts";
import { isFinished, isTerminal, type RunFile } from "./RunFile.ts";
import type { TldrxEvent } from "../events/Event.ts";

export interface RescueOptions {
  readonly root: string;
  readonly runId?: string;
  /** Remove a lock a LIVE process holds / cancel a run that is still locked. */
  readonly force: boolean;
  readonly actor: string;
  readonly at: string;
}

export interface RescueOutcome {
  readonly code: number;
  readonly lines: readonly string[];
}

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_REFUSED = 2;
const EXIT_NOT_FOUND = 3;

function resolve(options: RescueOptions): { store: RunStore } | RescueOutcome {
  const resolution = RunStore.resolve(options.root, options.runId);
  if (resolution.kind === "ambiguous") return { code: EXIT_REFUSED, lines: [...ambiguousRunLines(resolution.open)] };
  if (resolution.kind === "none") {
    return {
      code: EXIT_NOT_FOUND,
      lines: [options.runId === undefined
        ? `no non-terminal run in ${PROJECT_WORK_DIR}/`
        : `no run '${options.runId}' in ${PROJECT_WORK_DIR}/`],
    };
  }
  return { store: resolution.store };
}

function isStore(value: { store: RunStore } | RescueOutcome): value is { store: RunStore } {
  return "store" in value;
}

/** Every non-terminal stage, as `<phase>/<stage>`. */
function liveStages(run: RunFile): readonly string[] {
  const out: string[] = [];
  for (const phase of run.phases) {
    for (const stage of phase.stages) if (!isTerminal(stage.status)) out.push(`${phase.id}/${stage.id}`);
  }
  return out;
}

function event(
  options: RescueOptions,
  runId: string,
  type: TldrxEvent["type"],
  payload: Readonly<Record<string, unknown>>,
): TldrxEvent {
  return { ts: options.at, run: runId, stage: null, type, actor: options.actor, cost_usd: 0, payload };
}

/**
 * Drop a `.lock` nobody is behind, and put the stage it stranded back to `ready`.
 *
 * A DEAD holder is removed without ceremony — that is the same judgement `next`
 * already makes on its own stale locks, just reachable on purpose. A LIVE holder
 * needs `--force`, because "the pid was reused" and "a colleague is running the
 * stage right now" look identical from here and only one of them is safe.
 */
export function unlockRun(options: RescueOptions): RescueOutcome {
  const resolved = resolve(options);
  if (!isStore(resolved)) return resolved;
  const store = resolved.store;
  const holder = readLock(store.runDir);
  const path = lockPath(store.runDir);

  if (holder === null && !existsSync(path)) {
    const stranded = strandedNote(store);
    return {
      code: EXIT_OK,
      lines: [`no .lock in ${PROJECT_WORK_DIR}/${store.runId} — nothing to unlock`, ...stranded],
    };
  }

  const alive = holder !== null && isAlive(holder.pid);
  if (alive && !options.force) {
    return {
      code: EXIT_REFUSED,
      lines: [
        `.lock on ${store.runId} is held by live pid ${String(holder.pid)}` +
          (holder.at === "" ? "" : ` since ${holder.at}`),
        "  if that really is a `tldrx next` still working, let it finish",
        `  if the pid was recycled and the run is stuck, \`tldrx run unlock ${store.runId} --force\``,
      ],
    };
  }

  releaseLock(store.runDir);
  const demoted = demoteRunning(store);
  store.append(event(options, store.runId, "run.unlocked", {
    pid: holder?.pid ?? null,
    was_alive: alive,
    forced: options.force,
    demoted,
  }));
  store.save();

  const who = holder === null ? "an unreadable .lock" : `pid ${String(holder.pid)}`;
  return {
    code: EXIT_OK,
    lines: [
      `unlocked ${store.runId} — removed the .lock held by ${who}${alive ? " (forced: it is still alive)" : " (not running)"}`,
      ...(demoted.length === 0
        ? ["  no stage was left running"]
        : [`  demoted ${demoted.join(", ")} from running to ready`]),
      `next: tldrx next ${store.runId}`,
    ],
  };
}

/**
 * Close a run for good. `cancelled` is terminal and `isFinished`, so from here on
 * `tldrx status`, `findOpen` and every id-less command stop seeing it — which is
 * the entire point: an abandoned run that stays open makes every OTHER command
 * ambiguous.
 *
 * Nothing is deleted. The stages, the outputs, the events and the money spent are
 * all still on disk, and `tldrx replay <id>` still reads them.
 */
export function cancelRun(options: RescueOptions & { readonly note: string }): RescueOutcome {
  if (options.note.trim() === "") {
    return { code: EXIT_USAGE, lines: ['run cancel needs --note: `tldrx run cancel --note "why"`'] };
  }
  const resolved = resolve(options);
  if (!isStore(resolved)) return resolved;
  const store = resolved.store;

  const holder = readLock(store.runDir);
  if (holder !== null && isAlive(holder.pid) && !options.force) {
    return {
      code: EXIT_REFUSED,
      lines: [
        `${store.runId} is locked by live pid ${String(holder.pid)} — refusing to cancel a run that is still working`,
        `  wait for it, or \`tldrx run cancel ${store.runId} --note "…" --force\``,
      ],
    };
  }

  if (isFinished(store.run.status)) {
    return { code: EXIT_OK, lines: [`${store.runId} is already ${store.run.status} — nothing to cancel`] };
  }
  // A run whose only stage FAILED has no live stage to mark, and it is exactly
  // the run people want to close. So the decision goes on the run (`cancelled:`,
  // additive, §2.2) and the stages that never ran are marked with it — the ones
  // that already finished keep their own history.
  const cancelled = liveStages(store.run);
  const spent = store.run.budget.spent_usd;
  store.mutate((run) => ({
    ...run,
    cancelled: { by: options.actor, at: options.at, note: options.note },
    phases: run.phases.map((phase) => ({
      ...phase,
      stages: phase.stages.map((stage) =>
        isTerminal(stage.status) ? stage : { ...stage, status: "cancelled" as const, ended_at: options.at }),
    })),
  }));
  store.append(event(options, store.runId, "run.cancelled", {
    note: options.note,
    stages: cancelled,
    forced: options.force,
    spent_usd: spent,
  }));
  store.save();
  if (options.force) releaseLock(store.runDir);

  return {
    code: EXIT_OK,
    lines: [
      cancelled.length === 0
        ? `cancelled ${store.runId} — no stage was still open; the run is closed`
        : `cancelled ${store.runId} — ${String(cancelled.length)} stage(s) closed: ${cancelled.join(", ")}`,
      `  note: ${options.note}`,
      `  $${spent.toFixed(2)} already spent is kept on the record; ` +
        `\`tldrx replay ${store.runId}\` still reads it`,
    ],
  };
}

/** Every `running` stage back to `ready`. Returns what it moved. */
function demoteRunning(store: RunStore): readonly string[] {
  const moved: string[] = [];
  store.mutate((run) => ({
    ...run,
    phases: run.phases.map((phase) => ({
      ...phase,
      stages: phase.stages.map((stage) => {
        if (stage.status !== "running") return stage;
        moved.push(`${phase.id}/${stage.id}`);
        return { ...stage, status: "ready" as const };
      }),
    })),
  }));
  return moved;
}

/**
 * A run with no lock can still be stuck — on an orphaned `--prepare` bundle, the
 * one cut `unlock` is NOT the answer to. Say so rather than leave the operator
 * running the one command that has just told them it did nothing.
 */
function strandedNote(store: RunStore): readonly string[] {
  const entry = store.cursorEntry();
  if (entry === null || entry.stage.status !== "running") return [];
  if (!hasPreparedBundle(store.runDir, entry.stage.id)) {
    return [`  ${entry.phase.id}/${entry.stage.id} is running with nothing holding it — \`tldrx next\` demotes it`];
  }
  return [
    `  ${entry.phase.id}/${entry.stage.id} is waiting on a --prepare bundle, not on a lock`,
    `  finish it with \`tldrx next --commit ${store.runId}\`, or bin it with \`tldrx next --discard-pending\``,
  ];
}
