/** The one source of truth for the CLI version: package.json. */
import { join } from "node:path";
import { FRAMEWORK_ROOT } from "./paths.ts";
import { runtime } from "./runtime/index.ts";

export async function frameworkVersion(): Promise<string> {
  const pkg = (await runtime.readJson(join(FRAMEWORK_ROOT, "package.json"))) as { version?: unknown };
  return typeof pkg.version === "string" ? pkg.version : "0.0.0";
}
