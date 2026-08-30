/**
 * Say, once, on stderr, what a file is still spelling the old way.
 *
 * A `ValidationResult` carries `deprecations` but no filename — `validate()` sees
 * a parsed object and cannot know which of a workspace's files produced it, and
 * "schema_version is deprecated" without a path is a warning nobody can act on.
 * The loaders have the path, so the notice belongs there.
 *
 * DEDUPED per process, per file, per note. The statusline hook opens `run.yml`
 * and `budget.yml` on every prompt render; a workspace mid-migration would
 * otherwise get the same line hundreds of times an hour. stderr, never stdout,
 * so `--json` output stays parseable.
 */
import type { ValidationResult } from "./validation.ts";

const said = new Set<string>();

export function noteDeprecations(file: string, outcome: ValidationResult): void {
  for (const note of outcome.deprecations ?? []) {
    const line = `${file}: ${note}`;
    if (said.has(line)) continue;
    said.add(line);
    process.stderr.write(`${line}\n`);
  }
}

/** Test seam: forget what has been said, so a case can assert the first line again. */
export function resetDeprecationNotices(): void {
  said.clear();
}
