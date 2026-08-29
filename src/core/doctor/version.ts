/** Version extraction and comparison for `tldrx doctor`. */

/** Pull the first dotted numeric run out of a tool's `--version` output. */
export function extractVersion(output: string): string | null {
  const match = output.match(/(\d+(?:\.\d+)+)/);
  return match?.[1] ?? null;
}

/**
 * Compare two dotted numeric versions.
 * Returns <0 if a < b, 0 if equal, >0 if a > b. Missing segments count as 0.
 */
export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const right = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function satisfiesMinimum(found: string | null, minimum: string | null | undefined): boolean {
  if (!minimum) return true;
  if (!found) return false;
  return compareVersions(found, minimum) >= 0;
}
