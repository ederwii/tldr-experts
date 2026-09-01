/**
 * The CHANGELOG between the version you had and the version you now have (#62).
 *
 * `tldrx update` prints this and nothing else about what changed, because the
 * CHANGELOG is the only statement of it that a human wrote. Reading it out of the
 * package that was JUST INSTALLED — rather than out of a release note fetched
 * separately — means the text shown is the text that shipped with the code now on
 * disk; there is no second source to drift.
 *
 * The parse is the file's own shape: `## <version> — <date>` opens a section, the
 * next `## ` closes it. A heading that is not a version (`# Changelog`) is not a
 * section and is skipped, so a preamble never leaks into a delta.
 */
import { compareVersions, isNewer, parseVersion } from "./version.ts";

/** `## 0.4.1 — 2026-09-05` -> `0.4.1`. Null for any other `## ` line. */
function headingVersion(line: string): string | null {
  const match = /^##\s+v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(line);
  const found = match?.[1];
  return found !== undefined && parseVersion(found) !== null ? found : null;
}

/**
 * Every section strictly above `from` and no higher than `to`, in the order the
 * file has them. `""` when there is nothing in that window — including when `to` is
 * not above `from`, which is the "you were already up to date" case and must not
 * invent a single line.
 */
export function changelogDelta(text: string, from: string, to: string): string {
  if (text.trim() === "" || !isNewer(to, from)) return "";
  const lines = text.split("\n");
  const kept: string[] = [];
  let taking = false;
  for (const line of lines) {
    if (line.startsWith("## ")) {
      const version = headingVersion(line);
      taking = version !== null && isNewer(version, from) && compareVersions(version, to) <= 0;
    } else if (line.startsWith("# ")) {
      taking = false;
    }
    if (taking) kept.push(line);
  }
  return kept.join("\n").trim();
}
