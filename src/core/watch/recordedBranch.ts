/**
 * Which branch a shipped feature was actually built on — read off the RUN's
 * record, never derived from an id (gh #90).
 *
 * ## The failure this replaces
 *
 * Watch used to diff `feature.epic?.branch` — the `branch:` an epic file
 * DECLARES. That value is written at Plan time, before a line of code exists, and
 * under the integration branch model (issue #57) the Build executor deliberately
 * ignores it: every epic's stories merge into ONE `epic/<run-slug>` branch and the
 * epic stays in the plan as a label. So on `260901-leaderboard-v2` the prompt told
 * both watchers that `epic/leaderboard-v2-api` "does not resolve" — a branch name
 * nothing had ever cut — and instructed them to treat the feature's code as
 * UNSEEN. An obedient all-`absent:` card PASSES `claim-sources`, because an
 * `absent:` citation resolves by construction. Confident, validated, useless.
 *
 * ## The rule
 *
 * The only place that knows what Build cut is `run.yml`'s `build:` block, which
 * the Build executor writes through `runNext`'s `claimEpicBranches`. It is the
 * same record `tldrx ship` opens its PR from and `tldrx watch arm` polls. So:
 *
 * - **integration** — the run cut one branch; every feature is that branch.
 * - **per-epic** (and any run predating `branch_model`) — the recorded LIST, and
 *   the epic's declaration is used only as a KEY into it. Under this model Build
 *   cuts `epicBranchOf(model, declared) === declared`, so an epic that shipped has
 *   its declaration in the record; one that does not is a feature no recorded
 *   branch is known to carry, and that is stated rather than guessed at.
 *
 * A declaration is never returned as a branch. It is compared against the record,
 * and either it is IN the record — in which case the value returned is the
 * record's — or the answer is `unrecorded`.
 */
import type { BranchModelKind } from "../plan/branchModel.ts";
import type { Feature } from "./features.ts";

/** `run.yml`'s `build:` block — the shape `RunBuild` has, and nothing more. */
export interface RecordedBuild {
  readonly epic_branch: readonly string[];
  readonly branch_model?: BranchModelKind;
}

/**
 * The branch this feature's code is on, or why the run's record does not say.
 *
 * `unrecorded` is an ABSENCE — an honest one, and the only case where a watcher
 * may be told to treat the code as unseen. It is not the same thing as a recorded
 * branch that will not resolve in its repo: that is incoherent state, and the
 * caller refuses on it.
 */
export type RecordedBranch =
  | { readonly kind: "recorded"; readonly branch: string }
  | { readonly kind: "unrecorded"; readonly reason: string };

const RUN_YML = "run.yml";

export function recordedEpicBranch(
  build: RecordedBuild | undefined,
  feature: Feature,
): RecordedBranch {
  const recorded = (build?.epic_branch ?? []).filter((branch) => branch !== "");
  if (recorded.length === 0) {
    return {
      kind: "unrecorded",
      reason:
        `\`build.epic_branch\` in ${RUN_YML} is empty — this run's Build cut no epic branch, `
        + "so it has none to diff",
    };
  }

  if (build?.branch_model === "integration") {
    const only = recorded[0];
    if (recorded.length === 1 && only !== undefined) return { kind: "recorded", branch: only };
    return {
      kind: "unrecorded",
      reason:
        `\`build.branch_model: integration\` means this run cut ONE branch, and \`build.epic_branch\` `
        + `in ${RUN_YML} records ${String(recorded.length)} (${quoted(recorded)}) — nothing here can say `
        + "which of them carries this feature",
    };
  }

  // per-epic, and every run written before `branch_model` existed (issue #57).
  const declared = feature.epic?.branch ?? "";
  if (declared !== "" && recorded.includes(declared)) {
    // The value returned is the RECORD's entry, found by the declaration.
    return { kind: "recorded", branch: recorded[recorded.indexOf(declared)] ?? declared };
  }
  if (declared === "") {
    return {
      kind: "unrecorded",
      reason:
        `epic ${feature.epicId} has no \`branch:\` on file, so nothing keys it to any of the branches `
        + `\`build.epic_branch\` records in ${RUN_YML} (${quoted(recorded)})`,
    };
  }
  return {
    kind: "unrecorded",
    reason:
      `epic ${feature.epicId} declares \`${declared}\`, and \`build.epic_branch\` in ${RUN_YML} records `
      + `${quoted(recorded)} — no branch this run cut is known to carry this feature`,
  };
}

function quoted(values: readonly string[]): string {
  return values.map((value) => `\`${value}\``).join(", ");
}
