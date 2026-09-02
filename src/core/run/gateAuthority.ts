/**
 * The entity that EXECUTED a gate, and the authority it acted under (issue #122).
 *
 * ## The record that made this necessary
 *
 * Measured 2026-09-02 on run `260902-discovery-pipeline-map`:
 *
 * ```json
 * {"type":"gate.approved","actor":"alanmartinez",
 *  "payload":{"by":"alanmartinez","note":"agent-gate: evidence=sign by alanmartinez, …"}}
 * ```
 *
 * Nobody named `alanmartinez` looked at that stage. An agent evaluated and signed
 * it, under authority the owner had delegated once, at `run new --gates
 * what:agent`. Six months later `by: alanmartinez` reads as "Alan personally
 * reviewed this", and the only trace of the delegation is the prose inside
 * `note:` — which nothing parses and any hand-typed `--note "agent-gate: …"` can
 * forge.
 *
 * `gates.ts` had already noticed half of it: `by` duplicates the envelope's
 * `actor` so that `by: auto` can be told apart from a person called auto. That
 * works for the facilitator, which passes a reserved literal. It cannot work for
 * an agent, whose recorded name IS a person's — the agent signs under the
 * operator account it is running as, and rewriting that name would be inventing a
 * second claim on top of the note's own.
 *
 * ## What is recorded instead
 *
 * Two additive blocks, and between them they answer the four questions an audit
 * asks: **who authorized** the decision authority, **which entity** evaluated
 * this gate, whether that entity was a **human, an agent or the facilitator**,
 * and **under which policy**.
 *
 * ## Derived, never guessed
 *
 * Everything here comes off something already on disk. The policy is the run's
 * own frozen `gates_policy`. The authorizer is the actor of the
 * `gate.policy_changed` that last moved this stage's policy, or — when nothing
 * moved it — the actor of `run.created`, who froze it at `run new`. When the log
 * says neither, `authorized_by` is `null` and `source` is `unrecorded`: an
 * absence is NAMED, because a plausible name in an audit field is worse than a
 * blank one.
 *
 * `gate.evidence` (design §A.5) is not this and does not replace it: it says what
 * was checked, not who checked it under whose authority, and its `role:` is a job
 * an agent gave itself, not an identity claim the framework measured.
 */
import type { TldrxEvent } from "../events/Event.ts";
import type { GatePolicy } from "./gatePolicy.ts";
import type { RunGateAuthority, RunGateExecutor } from "./RunFile.ts";
import { AUTO_GATE_ACTOR } from "./autoGate.ts";

/** What `by` is rendered as when nothing recorded who granted the authority. */
export const UNRECORDED_AUTHORIZER = "unrecorded";

export interface GateAttribution {
  readonly executed_by: RunGateExecutor;
  readonly authority: RunGateAuthority;
}

export interface GateAttributionInput {
  /** The actor `approve` is signing with — the note's `by:` on an agent gate. */
  readonly actor: string;
  /** The run's frozen `gates_policy` for this stage, resolved by `gatePolicyFor`. */
  readonly policy: GatePolicy;
  /** True when an evidence note is being recorded, which only an agent gate does. */
  readonly signedWithEvidence: boolean;
  /** The stage whose gate is being closed — a policy is keyed by stage id. */
  readonly stageId: string;
  /** This run's events, in file order. */
  readonly events: readonly TldrxEvent[];
}

/**
 * Who evaluated this gate, and under whose authority.
 *
 * The executor's KIND is read off how the gate is being closed, never off the
 * policy: a person may always approve an `agent`-gated stage with no flag, and
 * that is a human acting directly, whatever the stage was set up to allow. The
 * three cases are exactly the three doors `approve` has — the facilitator's
 * reserved actor, an evidence-backed signature, and a person at a terminal.
 */
export function attributeGate(input: GateAttributionInput): GateAttribution {
  const executed_by = executorOf(input);
  return { executed_by, authority: authorityOf(input, executed_by) };
}

function executorOf(input: GateAttributionInput): RunGateExecutor {
  // The facilitator is a ROLE, not an identity: `AUTO_GATE_ACTOR` is a reserved
  // literal the facilitator alone passes, and `by: auto` already carries it. An
  // `id` here would read as a name somebody could be looked up by.
  if (input.actor === AUTO_GATE_ACTOR) return { type: "auto" };
  if (input.signedWithEvidence) return { type: "agent", id: input.actor };
  return { type: "human", id: input.actor };
}

function authorityOf(input: GateAttributionInput, executed: RunGateExecutor): RunGateAuthority {
  // A person signs as themselves. There is no delegation to record and no event
  // to go looking for — the authority and the executor are one entity, and
  // `source: self` says exactly that rather than leaving the field blank.
  if (executed.type === "human") {
    return { type: "direct", policy: input.policy, authorized_by: executed.id ?? null, source: "self" };
  }
  const moved = lastPolicyChange(input.events, input.stageId);
  if (moved !== null) {
    return { type: "delegated", policy: input.policy, authorized_by: moved, source: "gate.policy_changed" };
  }
  const opened = runCreator(input.events);
  if (opened !== null) {
    return { type: "delegated", policy: input.policy, authorized_by: opened, source: "run.created" };
  }
  return { type: "delegated", policy: input.policy, authorized_by: null, source: "unrecorded" };
}

/**
 * The actor of the LAST `gate.policy_changed` for this stage, or null.
 *
 * Last rather than first: `run gates set` may be run twice, and the authority a
 * gate rests on is the one in force when it was signed. A run whose policy was
 * never moved has no such event and falls through to whoever opened the run.
 */
function lastPolicyChange(events: readonly TldrxEvent[], stageId: string): string | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event === undefined) continue;
    if (event.type === "gate.policy_changed" && event.stage === stageId) return event.actor;
  }
  return null;
}

function runCreator(events: readonly TldrxEvent[]): string | null {
  return events.find((event) => event.type === "run.created")?.actor ?? null;
}

/**
 * The three fields every reader needs to render a signature honestly.
 *
 * Typed STRUCTURALLY and loosely on purpose. `run.yml`'s own `RunGate` satisfies
 * it, and so do the tolerant shapes the replay document and the dashboard model
 * parse out of files this version did not write — where `type` is whatever string
 * was on disk. A renderer that demanded the strict enums would force a cast at
 * every call site, and a cast is how an unreadable value gets rendered as a
 * readable one.
 */
export interface GateSignature {
  readonly by: string | null;
  readonly executed_by?: { readonly type: string; readonly id?: string | null } | null;
  readonly authority?: {
    readonly type: string;
    readonly policy: string;
    readonly authorized_by: string | null;
    readonly source?: string;
  } | null;
}

/**
 * One line naming the signature, used by `run status`, `replay` and the dashboard
 * so the three cannot disagree about what a gate says.
 *
 * Two shapes, and the rule between them is that nothing gets longer unless it was
 * lying at the shorter length:
 *
 *   - a bare name, exactly what every reader printed before, for a record with no
 *     `executed_by` (every run.yml written before #122) and for a PERSON signing
 *     as themselves, where a name is the whole truth and the human is accountable;
 *   - `agent alan (delegated by alan, policy: agent)` otherwise — the kind of
 *     entity first, so a delegated-agent signature can never be read as a person,
 *     then who lent it the authority and under which policy.
 */
/**
 * Did a MACHINE close this gate? (issues #124, #127)
 *
 * The selector used to be `by === "auto"`, in two places independently. That
 * catches every facilitator-closed gate and no agent-closed one: an `agent` gate
 * records the evidence note's `by:`, which is the OPERATOR account the agent was
 * running as — a person's name. Measured on run `260902-discovery-pipeline-map`,
 * that gate reads `by: alanmartinez`, so `tldrx status` counted it as
 * human-signed (#124) and the status line's counter did not count it at all
 * (#127).
 *
 * With #122's `executed_by` the question is answered directly, off the field
 * written on every gate `approve` closes. It asks `!== "human"` rather than
 * naming `agent` and `auto`: a kind this version has not heard of is a kind
 * nobody has shown to be a person, and listing the machines by name is exactly
 * how the `agent` case went missing the first time.
 *
 * `by === "auto"` stays as the UNION member, not as a replacement: a gate signed
 * before #122 has no `executed_by`, and there it is the only signal there is.
 *
 * It lives HERE, next to `describeGateSignature`, because the report and the
 * status line answer the same question about the same field and had drifted once
 * already — #124 fixed one copy and #127 was the other copy, still saying `auto`.
 */
export function closedByMachine(sig: GateSignature): boolean {
  const executed = sig.executed_by ?? null;
  if (executed !== null) return executed.type !== "human";
  return sig.by === AUTO_GATE_ACTOR;
}

export function describeGateSignature(sig: GateSignature): string {
  const by = sig.by ?? "?";
  const executed = sig.executed_by ?? null;
  if (executed === null) return by;
  const authority = sig.authority ?? null;
  if (executed.type === "human" && (authority === null || authority.type === "direct")) return by;
  const who = executed.type === "auto" ? "auto" : `${executed.type} ${executed.id ?? by}`;
  if (authority === null) return who;
  const granter = authority.authorized_by ?? UNRECORDED_AUTHORIZER;
  return `${who} (${authority.type} by ${granter}, policy: ${authority.policy})`;
}
