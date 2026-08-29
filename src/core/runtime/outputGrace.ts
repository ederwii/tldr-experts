/**
 * How long a spawn waits for output AFTER the child has already exited.
 *
 * Normally the pipes reach EOF the moment the child dies and this timer is never
 * reached. It only matters when something the child started outlived it and
 * still holds stdout/stderr — the case that used to hang the DoD gate. The
 * output is already in the OS pipe buffer by then, so half a second is generous;
 * the point is that the spawn ALWAYS settles with strings.
 */
export const OUTPUT_GRACE_MS = 500;
