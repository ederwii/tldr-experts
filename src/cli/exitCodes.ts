/** Process exit codes used by the tldrx CLI. */

export const EXIT_OK = 0;

/** A real check ran and something is wrong (e.g. doctor found a missing required tool). */
export const EXIT_FAILED = 1;

/**
 * Usage error / not implemented. 64 is `EX_USAGE` from sysexits.h.
 *
 * HARD RULE for v0: a command that is not implemented must exit 64 and say so on
 * stderr. It must never print success for work it did not do.
 */
export const EXIT_NOT_IMPLEMENTED = 64;
