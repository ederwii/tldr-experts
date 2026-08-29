/** Read + validate `budget.yml`. One file, no cross-file resolution (spec §0). */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseYaml } from "../yaml.ts";
import { asRunBudget, validateRunBudget, type RunBudget } from "./RunBudget.ts";

export function loadBudget(path: string): RunBudget {
  const doc = parseYaml(readFileSync(path, "utf8"));
  const validation = validateRunBudget(doc);
  if (!validation.ok) {
    const first = validation.issues[0];
    throw new Error(`invalid budget.yml (${path}): ${first?.path ?? ""} ${first?.message ?? "schema error"}`);
  }
  return asRunBudget(doc);
}

export function loadRunBudget(runDir: string): RunBudget | null {
  const path = join(runDir, "budget.yml");
  return existsSync(path) ? loadBudget(path) : null;
}
