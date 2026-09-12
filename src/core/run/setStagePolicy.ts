/**
 * The signed upgrade path for a run's frozen per-stage policy — ONE engine behind
 * `tldrx run gates set` (`setGatePolicy.ts`, issue #14) and `tldrx run questions set`
 * (`setQuestionsPolicy.ts`, gh #251).
 *
 * `setGatePolicy.ts` explains the shape and why every refusal is there; nothing here
 * changes it. What this file holds is the MECHANISM the two verbs share — one stage
 * per invocation, the entry qualified, `--note` required, a no-op refused, the event
 * validated before a byte is written, the FULL map written on a run that had none —
 * so that the second verb could not drift from the first in any of those. Each verb
 * supplies its WORDS through `StagePolicyVerb`: the gates words are byte-for-byte
 * what `run gates set` printed before this file existed.
 */
import { PROJECT_WORK_DIR } from "../paths.ts";
import { RunStore } from "./RunStore.ts";
import { ambiguousRunLines } from "./openRuns.ts";
import { flatten, type RunFile } from "./RunFile.ts";
import { validateEvent, type EventType, type TldrxEvent } from "../events/Event.ts";

export interface SetStagePolicyOptions {
  readonly root: string;
  /** The `<stage>:<policy>` entry, exactly as typed. */
  readonly entry: string;
  /** Required. A policy change with no reason is not auditable. */
  readonly note: string;
  readonly runId?: string;
  readonly actor: string;
  readonly at: string;
}

export interface SetStagePolicyOutcome {
  readonly code: number;
  readonly lines: readonly string[];
}

/** The words and the field one verb owns. */
export interface StagePolicyVerb<P extends string> {
  /** `run gates set`, `run questions set`. */
  readonly verb: string;
  /** The `run new` flag whose bare-entry default this verb refuses to inherit: `gates`, `questions`. */
  readonly flag: string;
  /** `run.yml` key: `gates_policy`, `questions_policy`. */
  readonly field: string;
  readonly policies: readonly P[];
  readonly isPolicy: (value: unknown) => value is P;
  /** The stage's policy under the run's frozen map, with the absent-means-default rule applied. */
  readonly policyFor: (run: RunFile, stageId: string) => P;
  /** The run with the full map written. */
  readonly withPolicy: (run: RunFile, next: Readonly<Record<string, P>>) => RunFile;
  readonly eventType: EventType;
  /** The example policy in "must name the policy outright, as `plan:<example>`". */
  readonly qualifiedExample: P;
  /** What the default reads as when the run has no map at all. */
  readonly defaultPolicy: P;
  /** `gate` / `questions` — the thing whose policy this is, in the refusal sentences. */
  readonly noun: string;
  /** The `--note "…"` placeholder in the missing-note refusal. */
  readonly noteHint: string;
  /** One line per policy word, for the unknown-policy refusal. */
  readonly policyGlossary: string;
  /** `<run>'s `<stage>` … is already `<wanted>` — nothing to sign`, the subject phrase. */
  readonly subject: (stageId: string) => string;
  /** The success line's predicate: `gate is now`, `questions policy is now`. */
  readonly nowPhrase: string;
  /** One line on what the operator has just allowed. Not advice — a description. */
  readonly describe: (policy: P) => readonly string[];
  /** What the change reaches, and what it leaves alone. */
  readonly reach: string;
  /** Where the whole map can be read afterwards. */
  readonly whereToRead: (runId: string) => string;
}

const EXIT_OK = 0;
/** Spec §3: every refusal here is a refusal to act. */
const EXIT_REFUSED = 2;
const EXIT_NOT_FOUND = 3;

export function setStagePolicy<P extends string>(
  options: SetStagePolicyOptions,
  verb: StagePolicyVerb<P>,
): SetStagePolicyOutcome {
  const POLICIES = verb.policies.join(" | ");
  const entry = options.entry.trim();
  if (entry === "") {
    return refuse([
      `${verb.verb} needs a stage and a policy: \`tldrx ${verb.verb} <stage>:<${POLICIES}> --note "why"\``,
    ]);
  }
  if (options.note.trim() === "") {
    return refuse([
      `${verb.verb} needs --note: \`tldrx ${verb.verb} ${entry} --note "${verb.noteHint}"\``,
      `  a ${verb.noun} policy that changed for no recorded reason is the one ${verb.noun} mutation nobody would find later`,
    ]);
  }
  if (entry.includes(",")) {
    return refuse([
      `${verb.verb} takes ONE \`<stage>:<policy>\`, not a list (got \`${entry}\`)`,
      "  each change is signed on its own note — run it once per stage.",
    ]);
  }

  const colon = entry.indexOf(":");
  if (colon <= 0 || colon === entry.length - 1) {
    return refuse([
      `\`${entry}\` must name the policy outright, as \`${entry.replace(":", "")}:${verb.qualifiedExample}\``,
      `  one of ${POLICIES}. A bare stage id is refused here on purpose: under \`--${verb.flag}\` it would `
        + `mean \`${verb.defaultPolicy}\`, and a signature must not rest on a default.`,
    ]);
  }
  const stageId = entry.slice(0, colon).trim();
  const wanted = entry.slice(colon + 1).trim();
  if (!verb.isPolicy(wanted)) {
    return refuse([
      `\`${wanted}\` is not a ${verb.noun} policy — it is one of ${POLICIES}`,
      `  ${verb.policyGlossary}`,
    ]);
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

  const entries = flatten(store.run);
  const found = entries.filter((e) => e.stage.id === stageId);
  const only = found[0];
  if (only === undefined) {
    return refuse([
      `${store.runId} has no stage \`${stageId}\``,
      `  it has ${entries.map((e) => e.stage.id).join(", ")}`,
    ]);
  }
  if (found.length > 1) {
    return refuse([
      `\`${stageId}\` names ${String(found.length)} stages of ${store.runId} `
        + `(${found.map((e) => `${e.phase.id}/${e.stage.id}`).join(", ")})`,
      `  a ${verb.noun} policy is keyed by stage id, so two stages sharing one id cannot be told apart here.`,
    ]);
  }

  const from = verb.policyFor(store.run, stageId);
  if (from === wanted) {
    const hasMap = (store.run as unknown as Record<string, unknown>)[verb.field] !== undefined;
    return refuse([
      `${store.runId}'s ${verb.subject(stageId)} is already \`${wanted}\` — nothing to sign`,
      hasMap
        ? `  ${verb.whereToRead(store.runId)}`
        : `  (this run has no \`${verb.field}:\` at all, so every stage reads as \`${verb.defaultPolicy}\`.)`,
    ]);
  }

  // The note is free text and `EventLog.append` validates, so a note over the
  // §2.9 4KB cap would throw AFTER run.yml had been rewritten. Both are proved
  // possible here, before either happens — `reopenStory` makes the same move for
  // the same reason.
  const event = policyEvent(options, store.runId, only.phase.id, stageId, from, wanted, verb.eventType);
  const validation = validateEvent(event);
  if (!validation.ok) {
    const first = validation.issues[0];
    return refuse([
      `the ${verb.eventType} event this would append is not valid: `
        + `${first?.path ?? ""} ${first?.message ?? "schema error"}`,
      "  nothing was written — the note is the only free text in it, so it is almost certainly too long",
    ]);
  }

  const next: Record<string, P> = {};
  for (const e of entries) next[e.stage.id] = verb.policyFor(store.run, e.stage.id);
  next[stageId] = wanted;

  store.mutate((run) => verb.withPolicy(run, next));
  store.save();
  store.append(event);

  return {
    code: EXIT_OK,
    lines: [
      `${store.runId}: ${only.phase.id}/${stageId} ${verb.nowPhrase} \`${wanted}\` (was \`${from}\`), `
        + `signed by ${options.actor}`,
      `  note: ${options.note}`,
      ...verb.describe(wanted),
      `  ${verb.reach}`,
      `  ${verb.whereToRead(store.runId)}`,
    ],
  };
}

function policyEvent(
  options: SetStagePolicyOptions,
  runId: string,
  phaseId: string,
  stageId: string,
  from: string,
  to: string,
  type: EventType,
): TldrxEvent {
  return {
    ts: options.at,
    run: runId,
    stage: stageId,
    type,
    actor: options.actor,
    cost_usd: 0,
    payload: {
      phase: phaseId,
      // `by` duplicates the envelope's `actor` for the same reason `gate.approved`
      // does: a reader asking "who signed this" wants the answer in the payload
      // they are reading, not in a field that also means "who ran the process".
      by: options.actor,
      from,
      to,
      note: options.note,
    },
  };
}

function refuse(lines: readonly string[]): SetStagePolicyOutcome {
  return { code: EXIT_REFUSED, lines };
}
