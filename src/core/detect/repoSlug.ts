/** Directory name -> `repos[].name`, which must match `^[a-z0-9-]{1,32}$` (spec §2.1). */

const MAX_LENGTH = 32;

export function repoSlug(directoryName: string): string {
  const slug = directoryName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_LENGTH)
    .replace(/-+$/g, "");
  return slug === "" ? "repo" : slug;
}

/** Make `candidate` unique against names already handed out. */
export function uniqueSlug(candidate: string, taken: ReadonlySet<string>): string {
  if (!taken.has(candidate)) return candidate;
  for (let n = 2; n < 100; n += 1) {
    const suffix = `-${n}`;
    const next = `${candidate.slice(0, MAX_LENGTH - suffix.length)}${suffix}`;
    if (!taken.has(next)) return next;
  }
  return candidate.slice(0, MAX_LENGTH - 5) + "-many";
}
