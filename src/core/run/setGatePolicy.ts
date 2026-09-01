/**
 * `tldrx run gates set <stage>:<policy> --note "…"` — the signed upgrade path for
 * a run's frozen `gates_policy` (issue #14).
 *
 * ## Why the policy was frozen, and why that was not enough
 *
 * `gatePolicy.ts` resolves the map once, at `run new`, and writes it into
 * `run.yml`: "a run therefore keeps the policy it was opened with even if the
 * workflow file changes underneath it." That is the right default and it is not
 * being taken back here. What it left with no door at all is the case measured on
 * the 2026-08-30/31 unattended pilots: a run created BEFORE the `agent` policy
 * existed can never use `approve --as-agent`, and `run.yml` is hand-edit-forbidden
 * by design (spec §1). The only remaining move was to abandon the run and open a
 * new one, which throws away everything it has done to change one word.
 *
 * ## The shape, which is `story reopen`'s
 *
 * The two verbs answer the same kind of question — a person overruling state the
 * machine is holding — so they are built the same way and should read the same
 * way in the log:
 *
 *   - a `--note` is REQUIRED. A gate policy changed for no recorded reason is the
 *     one gate mutation nobody would ever go looking for;
 *   - ONE stage per invocation. `--gates` takes a comma list at `run new` because
 *     that is one decision about a whole run; this is a signature on a single
 *     change, and a list would let a second change ride along on the first one's
 *     note;
 *   - the entry must be QUALIFIED. Under `--gates`, a bare `plan` means `human`
 *     — a sensible default for a list of "which stages stop for me", and a
 *     terrible one for a signature, where the operator must have said which of the
 *     three they meant;
 *   - a no-op is refused rather than recorded. An event saying `human → human`
 *     would be a signature on nothing.
 *
 * ## What it deliberately does NOT check
 *
 * It does not refuse a stage whose gate is already approved. The policy says who
 * may CLOSE a gate; a gate already closed is not re-opened by changing it, and
 * nothing re-reads the policy of a signed gate. Refusing there would add a branch
 * whose only effect is to block a legitimate "set the whole run to agent" in a
 * run that is halfway through. (Flagged on the issue.)
 *
 * ## Absent `gates_policy`
 *
 * A run.yml written before the key existed has no map at all, and reads as
 * `human` everywhere (`gatePolicyFor`). Setting one stage on such a run writes the
 * FULL map — every stage explicitly, with the one change applied — because
 * `validateGatesPolicy` refuses keys that name no stage and a partial map would
 * quietly claim the run's other stages had been decided too. Freezing the
 * implicit default explicitly is what it already behaved as, said out loud.
 */
import { PROJECT_WORK_DIR } from "../paths.ts";
import { RunStore } from "./RunStore.ts";
import { ambiguousRunLines } from "./openRuns.ts";
import { flatten } from "./RunFile.ts";
import { GATE_POLICIES, gatePolicyFor, isGatePolicy, type GatePolicy } from "./gatePolicy.ts";
import { validateEvent, type TldrxEvent } from "../events/Event.ts";

export interface SetGatePolicyOptions {
  readonly root: string;
  /** The `<stage>:<policy>` entry, exactly as typed. */
  readonly entry: string;
  /** Required. A policy change with no reason is not auditable. */
  readonly note: string;
  readonly runId?: string;
  readonly actor: string;
  readonly at: string;
}

export interface SetGatePolicyOutcome {
  readonly code: number;
  readonly lines: readonly string[];
}

const EXIT_OK = 0;
/** Spec §3: every refusal here is a refusal to act. */
const EXIT_REFUSED = 2;
const EXIT_NOT_FOUND = 3;

const POLICIES = GATE_POLICIES.join(" | ");

export function setGatePolicy(options: SetGatePolicyOptions): SetGatePolicyOutcome {
  const entry = options.entry.trim();
  if (entry === "") {
    return refuse([
      `run gates set needs a stage and a policy: \`tldrx run gates set <stage>:<${POLICIES}> --note "why"\``,
    ]);
  }
  if (options.note.trim() === "") {
    return refuse([
      `run gates set needs --note: \`tldrx run gates set ${entry} --note "why this stage may now be `
        + 'closed that way"`',
      "  a gate policy that changed for no recorded reason is the one gate mutation nobody would find later",
    ]);
  }
  if (entry.includes(",")) {
    return refuse([
      `run gates set takes ONE \`<stage>:<policy>\`, not a list (got \`${entry}\`)`,
      "  each change is signed on its own note — run it once per stage.",
    ]);
  }

  const colon = entry.indexOf(":");
  if (colon <= 0 || colon === entry.length - 1) {
    return refuse([
      `\`${entry}\` must name the policy outright, as \`${entry.replace(":", "")}:agent\``,
      `  one of ${POLICIES}. A bare stage id is refused here on purpose: under \`--gates\` it would `
        + "mean `human`, and a signature must not rest on a default.",
    ]);
  }
  const stageId = entry.slice(0, colon).trim();
  const wanted = entry.slice(colon + 1).trim();
  if (!isGatePolicy(wanted)) {
    return refuse([
      `\`${wanted}\` is not a gate policy — it is one of ${POLICIES}`,
      "  `human` waits for `tldrx approve`; `auto` lets the facilitator close it when the spec §5 "
        + "conditions hold; `agent` is every auto condition PLUS a signed evidence note.",
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
      "  a gate policy is keyed by stage id, so two stages sharing one id cannot be told apart here.",
    ]);
  }

  const from = gatePolicyFor(store.run.gates_policy, stageId);
  if (from === wanted) {
    return refuse([
      `${store.runId}'s \`${stageId}\` gate is already \`${wanted}\` — nothing to sign`,
      store.run.gates_policy === undefined
        ? "  (this run has no `gates_policy:` at all, so every stage reads as `human`.)"
        : "  `tldrx run status` prints the whole policy.",
    ]);
  }

  // The note is free text and `EventLog.append` validates, so a note over the
  // §2.9 4KB cap would throw AFTER run.yml had been rewritten. Both are proved
  // possible here, before either happens — `reopenStory` makes the same move for
  // the same reason.
  const event = policyEvent(options, store.runId, only.phase.id, stageId, from, wanted);
  const validation = validateEvent(event);
  if (!validation.ok) {
    const first = validation.issues[0];
    return refuse([
      `the gate.policy_changed event this would append is not valid: `
        + `${first?.path ?? ""} ${first?.message ?? "schema error"}`,
      "  nothing was written — the note is the only free text in it, so it is almost certainly too long",
    ]);
  }

  const next: Record<string, GatePolicy> = {};
  for (const e of entries) next[e.stage.id] = gatePolicyFor(store.run.gates_policy, e.stage.id);
  next[stageId] = wanted;

  store.mutate((run) => ({ ...run, gates_policy: next }));
  store.save();
  store.append(event);

  return {
    code: EXIT_OK,
    lines: [
      `${store.runId}: ${only.phase.id}/${stageId} gate is now \`${wanted}\` (was \`${from}\`), `
        + `signed by ${options.actor}`,
      `  note: ${options.note}`,
      ...describe(wanted),
      `  it changes who may CLOSE this stage's gate from now on; gates already signed are untouched.`,
      `  \`tldrx run status ${store.runId}\` prints the whole policy.`,
    ],
  };
}

/** One line on what the operator has just allowed. Not advice — a description. */
function describe(policy: GatePolicy): readonly string[] {
  if (policy === "human") return ["  it now waits for `tldrx approve`."];
  if (policy === "auto") {
    return ["  the facilitator may now close it, when the spec §5 conditions all hold."];
  }
  return [
    "  an agent may now close it, but only over a structured evidence note whose verdict is `sign` "
      + "(`tldrx approve --as-agent`) — every `auto` condition still applies, unweakened.",
  ];
}

function policyEvent(
  options: SetGatePolicyOptions,
  runId: string,
  phaseId: string,
  stageId: string,
  from: GatePolicy,
  to: GatePolicy,
): TldrxEvent {
  return {
    ts: options.at,
    run: runId,
    stage: stageId,
    type: "gate.policy_changed",
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

function refuse(lines: readonly string[]): SetGatePolicyOutcome {
  return { code: EXIT_REFUSED, lines };
}
