/**
 * What version and maturity the site is allowed to advertise — read, never typed.
 *
 * The site used to state "Beta, version 0.4.0" in four places as literal prose. npm
 * moved to 0.5.0 and the site did not, because a literal is a promise to remember and
 * nobody did. So the number now comes from `package.json` (the same field npm
 * publishes) and the maturity tag comes from the README release table (the same row
 * `scripts/release-check.sh` already refuses to release without). Neither can be
 * edited into disagreement with the thing it describes, because neither is edited.
 *
 * Both are resolved at BUILD time and handed to the pages through `themeConfig`, so a
 * rebuild is all it takes for the site to catch up with a release — and `docs.yml`
 * rebuilds on every push to main.
 *
 * This module throws rather than guesses. A docs build that cannot work out which
 * version it is describing must fail loudly; the alternative is a site that quietly
 * advertises `undefined`, which is how this class of bug hides.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The version npm serves: `package.json`'s `version`, and nothing else. */
export function tldrxVersion(): string {
  const path = join(REPO_ROOT, "package.json");
  const { version } = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown };
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+/.test(version)) {
    throw new Error(`docs-site/version.ts: no usable "version" in ${path} (got ${String(version)})`);
  }
  return version;
}

/**
 * The maturity tag for THAT version, read off the README release table.
 *
 * Deliberately not a constant here and not a second field in package.json: the table
 * is the surface a reader checks, `release-check.sh` already enforces that a release
 * has a dated row with a tag, and one source that is verified beats two that agree
 * until they do not.
 */
export function tldrxStatus(version = tldrxVersion()): "alpha" | "beta" | "stable" {
  const path = join(REPO_ROOT, "README.md");
  const escaped = version.replace(/\./g, "\\.");
  const row = new RegExp(`^\\|\\s*${escaped}\\s*\\|[^|]*\\|\\s*\`(alpha|beta|stable)\`\\s*\\|`, "m");
  const found = row.exec(readFileSync(path, "utf8"));
  if (found === null) {
    throw new Error(
      `docs-site/version.ts: README.md has no release-table row for ${version} carrying a ` +
        `status tag. Add the row (see "Releases and status tags") before building the site.`,
    );
  }
  return found[1] as "alpha" | "beta" | "stable";
}

/** `beta` -> `Beta`, for prose that opens a sentence with it. */
export function tldrxStatusLabel(status = tldrxStatus()): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}
