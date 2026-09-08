/** The one source of truth for the CLI version: package.json. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FRAMEWORK_ROOT } from "./paths.ts";
import { runtime } from "./runtime/index.ts";

/** The one path, read by both doors below. */
const PACKAGE_JSON = join(FRAMEWORK_ROOT, "package.json");

/**
 * `"0.0.0"` when `package.json` carries no string `version`.
 *
 * The extraction lives here, once, so the async and sync doors below cannot
 * disagree about what the version IS — the whole reason `tldrx --version` and a
 * `run.yml` stamp are worth putting side by side (#183).
 */
function versionOf(pkg: unknown): string {
  const version = (pkg as { version?: unknown } | null)?.version;
  return typeof version === "string" ? version : "0.0.0";
}

export async function frameworkVersion(): Promise<string> {
  return versionOf(await runtime.readJson(PACKAGE_JSON));
}

/**
 * The same answer, without an `await` — for the write paths that cannot have one.
 *
 * `RunStore.save()` is synchronous and is reached from `run new`, `approve`,
 * `reject`, `next`, `close` and the statusline; making it async to stamp a
 * version would have rippled through every one of them, which is a refactor
 * wearing a field's clothes. So the FILE is the same file and the extraction is
 * the same function; only the reader differs.
 *
 * Failures are swallowed to `"0.0.0"` rather than thrown: a missing or unreadable
 * `package.json` must not turn a save into a crash, and `"0.0.0"` is the same
 * "nobody could say" value the async door already returns for a package.json with
 * no version in it. It is never written to disk as a claim — `stampVersion` only
 * records what this returns, and a reader that sees `0.0.0` is seeing exactly
 * what `tldrx --version` would have printed on that machine.
 */
export function frameworkVersionSync(): string {
  try {
    return versionOf(JSON.parse(readFileSync(PACKAGE_JSON, "utf8")));
  } catch {
    return "0.0.0";
  }
}
