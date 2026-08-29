/** Process exit codes used by the tldrx CLI. */

export const EXIT_OK = 0;

/** A real check ran and something is wrong (e.g. doctor found a missing required tool). */
export const EXIT_FAILED = 1;

/** Spec §3: the thing asked for does not exist (an unknown run id, say). */
export const EXIT_NOT_FOUND = 3;

/**
 * The spec §3 exit table, for the commands that implement it:
 *   0 ok · 1 usage/schema error · 2 refused by a gate · 3 not found ·
 *   4 awaiting human · 5 agent failed
 * `EXIT_USAGE` is the same code as `EXIT_FAILED` on purpose — "you asked for
 * something impossible" and "the check failed" are both `1` in that table.
 */
export const EXIT_USAGE = 1;
export const EXIT_GATE_REFUSED = 2;
export const EXIT_AWAITING_HUMAN = 4;
export const EXIT_AGENT_FAILED = 5;

/**
 * Usage error / not implemented. 64 is `EX_USAGE` from sysexits.h.
 *
 * HARD RULE for v0: a command that is not implemented must exit 64 and say so on
 * stderr. It must never print success for work it did not do.
 */
export const EXIT_NOT_IMPLEMENTED = 64;
