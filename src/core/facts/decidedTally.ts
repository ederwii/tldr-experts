/**
 * How many of a run's recorded decisions name who decided them (#169 ask 4).
 *
 * It is a REPORT, on the standing precedent of the #141 close sentence
 * (`closeRun.ts:72-75`): it changes no exit code, blocks no close and writes not
 * one byte. It never claims a timeout-default mechanism exists — there is none
 * (`closeRun.ts:52-60`, measured: §2.7 declares no `default:` and no `timeout:`).
 * It says how many of this run's facts name a decider and how many do not.
 *
 * `notStated` is `source.decided_by === undefined`, and that is the whole
 * argument against a second field: a `decided_by_basis` would re-derive exactly
 * this, could contradict the row it sits on, and could not carry the REASON a
 * particular row has none — only prose can, and `tldrx answer` prints it.
 */
import { type Fact } from "./Fact.ts";

export interface DecidedTally {
  readonly owner: number;
  readonly driver: number;
  /**
   * `decided_by: agent-default` — the loop took the asker's recommendation under
   * `questions_policy: recommended` (gh #251). Counted apart, never folded into
   * `notStated`: it IS stated, and it is the one count an owner reading a close
   * most wants to see.
   */
  readonly agentDefault: number;
  /** No `decided_by` on the row. "Not stated", never "owner". */
  readonly notStated: number;
}

export function decidedTally(facts: readonly Fact[], runId: string): DecidedTally {
  let owner = 0;
  let driver = 0;
  let agentDefault = 0;
  let notStated = 0;
  for (const fact of facts) {
    if (fact.source.run !== runId) continue;
    if (fact.source.decided_by === "owner") owner += 1;
    else if (fact.source.decided_by === "driver") driver += 1;
    else if (fact.source.decided_by === "agent-default") agentDefault += 1;
    else notStated += 1;
  }
  return { owner, driver, agentDefault, notStated };
}

/** The one sentence both readers print, or null when this run recorded nothing. */
export function describeDecidedTally(tally: DecidedTally): string | null {
  const total = tally.owner + tally.driver + tally.agentDefault + tally.notStated;
  if (total === 0) return null;
  // The agent-default count is named only when there is one, so every close that
  // recorded none reads byte-for-byte as it did before the value existed.
  const agentDefault = tally.agentDefault === 0 ? "" : `${String(tally.agentDefault)} agent-default, `;
  return `${String(total)} decision(s) recorded on this run: ${String(tally.owner)} owner, `
    + `${String(tally.driver)} driver, ${agentDefault}${String(tally.notStated)} not stated. `
    + "A row with no decider says \"not stated\" — it is never read as the owner's.";
}
