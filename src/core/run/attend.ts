/**
 * `tldrx run attend host` and `tldrx run attend --none` — flip who drives a run
 * that is already open (spec §2.2, `attended_by`).
 *
 * `run new --attended-by host` decides it at creation, and most runs are decided
 * there. This is for the run that started headless and stopped being a good idea
 * headless — which is the shape the field notes describe: a Plan agent priced
 * `04-build` for host-billed sub-agents, the framework then enforced those prices
 * on metered spawns, and six of six died on their caps. The operator wants to
 * take the wheel at that point without cancelling the run and starting again.
 *
 * Deliberately small and deliberately loud, like `run cancel` beside it: it
 * mutates one field, it appends one event, it spends nothing, and it touches no
 * stage, no output and no branch. Nothing about the run's PAST changes — the
 * spawns that already happened stay on the record.
 */
import { PROJECT_WORK_DIR } from "../paths.ts";
import { ambiguousRunLines } from "./openRuns.ts";
import { RunStore } from "./RunStore.ts";
import { isFinished, type AttendedBy, type RunFile } from "./RunFile.ts";
import type { TldrxEvent } from "../events/Event.ts";

export interface AttendOptions {
  readonly root: string;
  readonly runId?: string;
  /** `host` to hand the run to a host session; `null` to hand it back to the framework. */
  readonly attendedBy: AttendedBy | null;
  readonly actor: string;
  readonly at: string;
}

export interface AttendOutcome {
  readonly code: number;
  readonly lines: readonly string[];
}

const EXIT_OK = 0;
const EXIT_REFUSED = 2;
const EXIT_NOT_FOUND = 3;

export function attendRun(options: AttendOptions): AttendOutcome {
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
  const was = store.run.attended_by ?? null;
  const want = options.attendedBy;

  // A finished run has no turns left to attend, and flipping a field on one would
  // be a change to history rather than to a plan.
  if (isFinished(store.run.status)) {
    return {
      code: EXIT_REFUSED,
      lines: [
        `${store.runId} is ${store.run.status} — there is nothing left to attend`,
        `  \`tldrx replay ${store.runId}\` still reads what it did`,
      ],
    };
  }

  // Idempotent, and SILENT about it: writing an event for a no-op would put a
  // decision in the log that nobody made.
  if (was === want) {
    return {
      code: EXIT_OK,
      lines: [want === null
        ? `${store.runId} is already unattended — the framework may spawn on it`
        : `${store.runId} is already attended_by: ${want} — nothing to change`],
    };
  }

  store.mutate((run) => withAttendedBy(run, want));
  store.append(event(options, store.runId, { attended_by: want, was }));
  store.save();

  return {
    code: EXIT_OK,
    lines: want === null
      ? [
        `${store.runId} is no longer attended — the framework may spawn on it again`,
        `  next: tldrx next ${store.runId}`,
      ]
      : [
        `${store.runId} is attended_by: ${want} — the framework will not spawn on it`,
        `  every stage is yours to run: tldrx next --prepare ${store.runId}, then tldrx next --commit ${store.runId}`,
        `  \`tldrx run auto\` is refused on this run, and a bare \`tldrx next\` names the command above`,
      ],
  };
}

/**
 * Set or REMOVE the key. Removal matters: `attended_by: null` is not a legal
 * value in §2.2 and `emitRunYaml` writes the key whenever it is not `undefined`,
 * so detaching has to delete rather than blank.
 */
function withAttendedBy(run: RunFile, want: AttendedBy | null): RunFile {
  if (want !== null) return { ...run, attended_by: want };
  const { attended_by: _dropped, ...rest } = run;
  return rest;
}

function event(options: AttendOptions, runId: string, payload: Readonly<Record<string, unknown>>): TldrxEvent {
  return { ts: options.at, run: runId, stage: null, type: "run.attended", actor: options.actor, cost_usd: 0, payload };
}
