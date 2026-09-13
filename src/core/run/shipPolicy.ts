/**
 * `ship:` on a run — how far past the last gate the framework may carry the epic
 * (gh #253): publish the branch, open the PR, arm the merge.
 *
 * ## Why a run-level block and not a sixth phase
 *
 * Shipping is not a stage. A stage spends money on a sub-agent, produces declared
 * outputs and ends at a gate somebody signs; shipping spends nothing, produces a
 * PR URL and is gated by what every earlier gate already signed. Making it
 * `06-ship` would have grown `PHASE_IDS`, every `^0[1-5]-` validator and every
 * preset, to give the phase model a member with none of a phase's properties. A
 * policy block on the run is what it is: a DECISION, frozen at `run new` like
 * `gates_policy`, that the last mile may be walked without a person.
 *
 * ## Three levels, nested
 *
 *   `push`   publish `epic/<slug>` to origin and stop — the branch is there for a
 *            person to open the PR from.
 *   `pr`     push, then open the PR `tldrx ship` already knows how to open.
 *   `merge`  push, open, then `gh pr merge --auto` — GitHub merges when ITS
 *            requirements are met, and the framework arms nothing unless it has
 *            SEEN a requirement: a PR that reports no check at all
 *            (`NO_CHECKS_TO_WAIT_ON`), a base that requires none
 *            (`NO_REQUIRED_CHECKS`, gh #274) and a base it could not interrogate
 *            (`REQUIREMENTS_UNREADABLE`) are all left for a person, because an
 *            auto-merge with nothing to wait on merges at once.
 *
 * The block is the CLI flag's three words spelled out, so a reader of `run.yml`
 * never has to know the flag existed: `{push, pr, auto_merge}`.
 *
 * ## What it does not weaken
 *
 * Every gate still ends where it ended and is signed by whom the run's
 * `gates_policy` says. An unattended ship is therefore a deliberate `--gates none
 * --ship merge`, and `run.yml` carries both decisions side by side. The Build
 * phase keeps its rule — no push wrapper anywhere in it (spec §5) — because the
 * one push wrapper that now exists lives beside Build's git seam and is called by
 * `ship` alone (`test/ship-policy.test.ts` pins the single caller).
 *
 * Absence means what every run.yml written before this key meant: push nothing,
 * open nothing. The safe default is the one that stops.
 */
import type { RunFile } from "./RunFile.ts";

export const SHIP_LEVELS = ["push", "pr", "merge"] as const;
export type ShipLevel = (typeof SHIP_LEVELS)[number];

export const AUTO_MERGE_POLICIES = ["never", "checks"] as const;
export type AutoMergePolicy = (typeof AUTO_MERGE_POLICIES)[number];

/** The decision half of `run.yml`'s `ship:` block — what the run MAY do once it closes. */
export interface ShipPolicy {
  readonly push: boolean;
  readonly pr: boolean;
  readonly auto_merge: AutoMergePolicy;
}

/**
 * `ship.merge` on run.yml, and `merge` on the `run.finished` payload, when
 * `auto_merge: checks` found nothing to wait on. Absent-with-reason (§7): the
 * merge was not armed, and this is why — never a silent `never`, which would
 * read as the policy the run was opened with.
 */
export const NO_CHECKS_TO_WAIT_ON = "absent — no checks to wait on";
/**
 * The base branch REQUIRES nothing before a merge (gh #274). A PR that REPORTS
 * checks is not a base that REQUIRES them: `gh pr merge --auto` waits on the
 * PR's requirements, and over a base with none it merges at once — measured in
 * the field, where all four of a PR's checks completed AFTER the merge whose
 * record said `queued`. Absent-with-reason (§7), and a state of its own because
 * the two absences are different facts: nothing REPORTED versus nothing REQUIRED.
 */
export const NO_REQUIRED_CHECKS = "absent — the base branch requires no check before merge";
/**
 * The requirements probe could not answer (gh #274) — `gh` failed, or printed
 * something that is not the JSON it was asked for. "I could not tell" is never
 * "none": for a merge it BEHAVES like `NO_REQUIRED_CHECKS` (nothing is armed)
 * and the record says which of the two it was, so a permission error is never
 * read back as a base that was checked and found bare.
 */
export const REQUIREMENTS_UNREADABLE = "absent — could not tell what the base branch requires";
/** `gh pr merge --auto` accepted: GitHub merges when its own requirements are met. */
export const MERGE_QUEUED = "queued";

export class ShipPolicyError extends Error {}

export function isAutoMergePolicy(value: unknown): value is AutoMergePolicy {
  return typeof value === "string" && (AUTO_MERGE_POLICIES as readonly string[]).includes(value);
}

/** `--ship <push|pr|merge>` → the block. Refused by name outside the three; never defaulted. */
export function parseShipFlag(raw: string): ShipPolicy {
  const value = raw.trim();
  switch (value) {
    case "push":
      return { push: true, pr: false, auto_merge: "never" };
    case "pr":
      return { push: true, pr: true, auto_merge: "never" };
    case "merge":
      return { push: true, pr: true, auto_merge: "checks" };
    default:
      throw new ShipPolicyError(
        `--ship: \`${value}\` is not one of ${SHIP_LEVELS.join(" | ")}. `
          + "`push` publishes the epic branch, `pr` also opens the pull request, `merge` also arms "
          + "`gh pr merge --auto` so the remote's own checks decide.",
      );
  }
}

/**
 * Does this run want the last mile walked, and has it NOT been walked yet?
 *
 * `shipped_at` is the idempotence key: `run auto` may be re-run on a closed run,
 * and `tldrx ship` may be typed twice. A second push is harmless; a second
 * `pr create` is a `gh` failure and a second `pr merge --auto` would re-arm a
 * decision already recorded. One record, one walk.
 */
export function shipWanted(run: RunFile): boolean {
  const ship = run.ship;
  if (ship === undefined) return false;
  if (!ship.push && !ship.pr) return false;
  return ship.shipped_at === undefined;
}
