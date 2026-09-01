/**
 * Comparing two version strings, for the one question this framework asks of them:
 * is the registry's newer than mine? (issue #62)
 *
 * Deliberately not a semver library. The only versions compared here are ones this
 * project published, `MAJOR.MINOR.PATCH` with an occasional prerelease, and a
 * dependency for that would be a runtime dependency in a package that has none.
 *
 * The one rule that matters beyond arithmetic: **anything unparseable compares
 * EQUAL, so it can never be "newer".** A registry that answers with an error page,
 * a `package.json` with a version key someone hand-edited, a cache file from a
 * future format — every one of them ends in silence rather than in a notice about a
 * version that may not exist.
 */

interface Parsed {
  readonly nums: readonly [number, number, number];
  /** The `-beta.1` part, or null for a plain release. */
  readonly pre: string | null;
}

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(text: string): Parsed | null {
  const match = VERSION_RE.exec(text.trim());
  if (match === null) return null;
  return {
    nums: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ?? null,
  };
}

/** Negative when `a` is older, positive when newer, `0` when equal OR unparseable. */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === null || right === null) return 0;
  for (let i = 0; i < 3; i++) {
    const diff = (left.nums[i] ?? 0) - (right.nums[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  // 0.5.0-beta.1 is BELOW 0.5.0, which is what the npm `latest` tag means by it.
  if (left.pre === right.pre) return 0;
  if (left.pre === null) return 1;
  if (right.pre === null) return -1;
  return left.pre < right.pre ? -1 : left.pre > right.pre ? 1 : 0;
}

/** True only when both parse and `candidate` is strictly above `current`. */
export function isNewer(candidate: string, current: string): boolean {
  if (parseVersion(candidate) === null || parseVersion(current) === null) return false;
  return compareVersions(candidate, current) > 0;
}
