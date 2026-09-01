/**
 * `tldrx note <run> [--stage <id>] "text"` — an operator annotation, recorded at
 * the moment it happened and changing nothing else (issue #46).
 *
 * ## The failure this exists for
 *
 * Measured on run `260829-scoring-leaderboard` (scavtopia, 2026-09-01). A host
 * performed an owner-delegated mechanical resync of eight story dod blocks and
 * was explicitly asked to note it in the run log. It could not, and said so:
 *
 * > events.jsonl is append-only and tool-owned, so I can't write to it directly.
 * > The resync note will go into the build gate note when I sign it […] the only
 * > other honest carrier would be a reject, which would undo work.
 *
 * Both of those carriers are wrong in the same way. A gate note lands LATE and is
 * keyed to a decision the annotation is not about; a `reject` is destructive. The
 * session ended up attaching the context to an S1 `story.reopened` event — honest,
 * and keyed to the wrong moment and the wrong subject.
 *
 * ## What this verb is, and is not
 *
 * It is the smallest possible write: ONE `operator_note` line on `events.jsonl`,
 * carrying the actor, the timestamp, the optional stage and the text. It is not a
 * decision. It signs nothing, revokes nothing, moves no cursor, spends nothing and
 * does not touch `run.yml` or `budget.yml` — deliberately not through
 * `RunStore.save()`, which would rewrite `updated_at` and re-derive every status
 * for an annotation that changed no state. `test/operator-note.test.ts` compares
 * `run.yml` byte for byte across the call, because "safe to reach for mid-run" is
 * the whole of what makes this usable.
 *
 * ## Refusals, and why each writes nothing
 *
 * An unknown run, an unknown stage or an empty note all refuse BEFORE the log is
 * opened. A note verb that half-wrote would be worse than no note verb: the one
 * thing an operator must be able to assume here is that a mistyped stage id has
 * not left a stray line in the ledger they will read back in six weeks.
 *
 * The lone-argument rule is the other one worth naming. `tldrx note 260829-x` —
 * an id and no text — is far more likely to be a half-typed command than a
 * deliberate note whose entire content is a run id, so it is refused rather than
 * recorded.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_WORK_DIR } from "../paths.ts";
import { RunStore } from "./RunStore.ts";
import { ambiguousRunLines } from "./openRuns.ts";
import { flatten } from "./RunFile.ts";
import { EventLog } from "../events/EventLog.ts";
import { validateEvent, type TldrxEvent } from "../events/Event.ts";

export interface NoteOptions {
  readonly root: string;
  /** The note's text, verbatim. Required — an empty note is a usage error. */
  readonly note: string;
  readonly runId?: string;
  /** `--stage`: a bare stage id or `<phase>/<stage>`. Absent = a run-level note. */
  readonly stage?: string;
  /**
   * True when `note` came from the command's ONE positional, so the caller could
   * not tell an id from a text. See the lone-argument rule above.
   */
  readonly soleArgument?: boolean;
  readonly actor: string;
  readonly at: string;
}

export interface NoteOutcome {
  readonly code: number;
  readonly lines: readonly string[];
}

const EXIT_OK = 0;
/** Spec §3: `1` usage/schema, `2` refused, `3` not found. */
const EXIT_USAGE = 1;
const EXIT_REFUSED = 2;
const EXIT_NOT_FOUND = 3;

export function addOperatorNote(options: NoteOptions): NoteOutcome {
  const text = options.note.trim();
  if (text === "") {
    return {
      code: EXIT_USAGE,
      lines: [
        'note needs text: `tldrx note [<run>] [--stage <id>] "what happened"`',
        "  an empty annotation is not an annotation — the text is the whole of what the next reader gets",
      ],
    };
  }

  // `tldrx note 260829-x` — an id and nothing else. Recording that as the note's
  // TEXT would be the one outcome nobody wanted, so say what was probably meant.
  if (options.soleArgument === true && existsSync(join(options.root, PROJECT_WORK_DIR, text))) {
    return {
      code: EXIT_USAGE,
      lines: [
        `\`${text}\` names a run, and there is no text to note`,
        `  \`tldrx note ${text} "what happened"\` — the run id comes first, the note second`,
      ],
    };
  }

  const resolution = RunStore.resolve(options.root, options.runId);
  if (resolution.kind === "ambiguous") {
    return { code: EXIT_REFUSED, lines: [...ambiguousRunLines(resolution.open)] };
  }
  if (resolution.kind === "none") {
    return {
      code: EXIT_NOT_FOUND,
      lines: [options.runId === undefined || options.runId === ""
        ? `no non-terminal run in ${PROJECT_WORK_DIR}/`
        : `no run '${options.runId}' in ${PROJECT_WORK_DIR}/`],
    };
  }
  const store = resolution.store;

  // The stage is resolved against the RUN, not against the workflow on disk: a
  // note is keyed to a stage this run actually has, and a workflow edited since
  // the run was opened must not decide what is a valid subject for it.
  let stageId: string | null = null;
  let phaseId: string | null = null;
  const wanted = options.stage?.trim() ?? "";
  if (wanted !== "") {
    const entries = flatten(store.run);
    const slash = wanted.indexOf("/");
    const found = slash > 0
      ? entries.find((e) => e.phase.id === wanted.slice(0, slash) && e.stage.id === wanted.slice(slash + 1))
      : entries.filter((e) => e.stage.id === wanted);
    const one = Array.isArray(found) ? (found.length === 1 ? found[0] : undefined) : found;
    if (one === undefined) {
      const named = entries.map((e) => `${e.phase.id}/${e.stage.id}`).join(", ");
      const ambiguous = Array.isArray(found) && found.length > 1;
      return {
        code: EXIT_REFUSED,
        lines: [
          ambiguous
            ? `\`${wanted}\` names ${String(found.length)} stages of ${store.runId} — pass <phase>/<stage>`
            : `${store.runId} has no stage \`${wanted}\``,
          `  it has ${named}`,
          "  nothing was written",
        ],
      };
    }
    stageId = one.stage.id;
    phaseId = one.phase.id;
  }

  // `EventLog.append` validates and throws, and the note is free text, so a note
  // over the §2.9 4KB payload cap would throw with the ledger already open. It is
  // checked here instead, and the refusal says which limit bit.
  const event = noteEvent(options, store.runId, stageId, phaseId, text);
  const validation = validateEvent(event);
  if (!validation.ok) {
    const first = validation.issues[0];
    return {
      code: EXIT_REFUSED,
      lines: [
        `the operator_note this would append is not valid: ${first?.path ?? ""} ${first?.message ?? "schema error"}`,
        "  nothing was written — the text is the only free field in it, so it is almost certainly too long",
      ],
    };
  }

  store.append(event);

  return {
    code: EXIT_OK,
    lines: [
      `noted on ${store.runId}${stageId === null ? "" : ` · ${phaseId ?? ""}/${stageId}`} (${options.actor})`,
      `  ${text}`,
      "  one operator_note appended to events.jsonl; run.yml, budget.yml and the cursor are untouched",
    ],
  };
}

/** What `run status` and the dashboards show: the notes, newest last. */
export interface OperatorNote {
  readonly ts: string;
  readonly actor: string;
  readonly stage: string | null;
  readonly note: string;
}

/**
 * Every `operator_note` on a run's ledger, in file order.
 *
 * Read straight off `events.jsonl` rather than mirrored into `run.yml`: the log
 * is the record, and a second copy of it in the state file would be a second
 * thing to keep true. `EventLog.readAll` is the tolerant reader, so one torn line
 * costs the notes after it and not the whole history.
 */
export function operatorNotes(runDir: string): readonly OperatorNote[] {
  const out: OperatorNote[] = [];
  for (const event of EventLog.forRun(runDir).readAll().events) {
    if (event.type !== "operator_note") continue;
    const note = event.payload.note;
    out.push({
      ts: event.ts,
      actor: event.actor,
      stage: event.stage,
      note: typeof note === "string" ? note : "",
    });
  }
  return out;
}

function noteEvent(
  options: NoteOptions,
  runId: string,
  stageId: string | null,
  phaseId: string | null,
  text: string,
): TldrxEvent {
  return {
    ts: options.at,
    run: runId,
    // Null for a run-level note, exactly as `run.unlocked` and `story.reopened`
    // record an operator acting outside a stage run.
    stage: stageId,
    type: "operator_note",
    actor: options.actor,
    cost_usd: 0,
    payload: {
      note: text,
      ...(phaseId === null ? {} : { phase: phaseId }),
    },
  };
}
