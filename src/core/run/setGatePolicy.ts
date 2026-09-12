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
 *
 * ## The engine
 *
 * The mechanism above is `setStagePolicy.ts`'s since gh #251, shared with
 * `run questions set`; this file supplies the gates WORDS, byte-for-byte what it
 * printed before the split.
 */
import { setStagePolicy, type SetStagePolicyOptions, type SetStagePolicyOutcome } from "./setStagePolicy.ts";
import { GATE_POLICIES, gatePolicyFor, isGatePolicy, type GatePolicy } from "./gatePolicy.ts";

export type SetGatePolicyOptions = SetStagePolicyOptions;
export type SetGatePolicyOutcome = SetStagePolicyOutcome;

export function setGatePolicy(options: SetGatePolicyOptions): SetGatePolicyOutcome {
  return setStagePolicy<GatePolicy>(options, {
    verb: "run gates set",
    flag: "gates",
    field: "gates_policy",
    policies: GATE_POLICIES,
    isPolicy: isGatePolicy,
    policyFor: (run, stageId) => gatePolicyFor(run.gates_policy, stageId),
    withPolicy: (run, next) => ({ ...run, gates_policy: next }),
    eventType: "gate.policy_changed",
    qualifiedExample: "agent",
    defaultPolicy: "human",
    noun: "gate",
    noteHint: "why this stage may now be closed that way",
    policyGlossary: "`human` waits for `tldrx approve`; `auto` lets the facilitator close it when the spec §5 "
      + "conditions hold; `agent` is every auto condition PLUS a signed evidence note.",
    subject: (stageId) => `\`${stageId}\` gate`,
    nowPhrase: "gate is now",
    describe,
    reach: "it changes who may CLOSE this stage's gate from now on; gates already signed are untouched.",
    whereToRead: (runId) => `\`tldrx run status ${runId}\` prints the whole policy.`,
  });
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
