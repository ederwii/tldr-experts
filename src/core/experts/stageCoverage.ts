/**
 * Which stages would load which expert — the answer `tldrx expert list` prints.
 *
 * It is derived, never declared: the same `selectExperts` rule the facilitator
 * runs, applied to every `stage.yml` in the workspace with the workspace's own
 * repos standing in for a run's. So a stage that names an expert nobody created,
 * and an expert nobody's stage will ever load, both show up as what they are
 * rather than as silence.
 *
 * Deliberately run WITHOUT cited paths: `expert list` has no run, so it cannot
 * know which files a future stage will be pointed at. A domain expert therefore
 * shows up here on its repo claim alone, which is the weakest reason it could
 * load — never a stronger one than the truth.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_FRAMEWORK_DIR, STAGES_DIR } from "../paths.ts";
import { parseYaml } from "../yaml.ts";
import { isRecord } from "../schemas/validation.ts";
import { stackExpertNames } from "./stackExperts.ts";
import { selectExperts, type ExpertReason } from "./selectExperts.ts";

export interface StageLoad {
  readonly stage: string;
  readonly reason: ExpertReason;
}

/** Expert name -> the stages that load it, in stage-id order. */
export function stagesLoadingExperts(root: string): ReadonlyMap<string, readonly StageLoad[]> {
  const repos = workspaceRepos(root);
  const stackNames = stackExpertNames(root, repos);
  const byExpert = new Map<string, StageLoad[]>();

  for (const stage of stageIds(root)) {
    const doc = readStage(root, stage);
    if (doc === null) continue;
    const selection = selectExperts({
      root,
      staged: strings(doc.experts),
      repos,
      stackExperts: typeof doc.stack_experts === "boolean" ? doc.stack_experts : true,
      stackNames,
    });
    for (const chosen of selection.experts) {
      const rows = byExpert.get(chosen.name) ?? [];
      rows.push({ stage, reason: chosen.reason });
      byExpert.set(chosen.name, rows);
    }
  }
  return byExpert;
}

/** `what (named), how (stack)` — or the honest empty answer. */
export function describeStageLoads(loads: readonly StageLoad[] | undefined): string {
  if (loads === undefined || loads.length === 0) {
    return "loaded by: no stage — not named in any `experts:`, not a stack expert, no domain match";
  }
  const label: Readonly<Record<ExpertReason, string>> = { stage: "named", stack: "stack", domain: "domain" };
  return `loaded by: ${loads.map((load) => `${load.stage} (${label[load.reason]})`).join(", ")}`;
}

/** Local stage folders first, then the shipped ones the workspace has not overridden. */
export function stageIds(root: string): readonly string[] {
  const ids = new Set<string>([
    ...dirsIn(join(root, PROJECT_FRAMEWORK_DIR, "stages")),
    ...dirsIn(STAGES_DIR),
  ]);
  return [...ids].sort();
}

function dirsIn(dir: string): readonly string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((entry) => {
      try {
        return statSync(join(dir, entry)).isDirectory() && existsSync(join(dir, entry, "stage.yml"));
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

function readStage(root: string, id: string): Record<string, unknown> | null {
  const local = join(root, PROJECT_FRAMEWORK_DIR, "stages", id, "stage.yml");
  const path = existsSync(local) ? local : join(STAGES_DIR, id, "stage.yml");
  if (!existsSync(path)) return null;
  try {
    const doc = parseYaml(readFileSync(path, "utf8"));
    return isRecord(doc) ? doc : null;
  } catch {
    return null;
  }
}

function workspaceRepos(root: string): readonly string[] {
  const path = join(root, PROJECT_FRAMEWORK_DIR, "workspace.yml");
  if (!existsSync(path)) return [];
  try {
    const doc = parseYaml(readFileSync(path, "utf8"));
    const list = isRecord(doc) && Array.isArray(doc.repos) ? (doc.repos as unknown[]) : [];
    return list
      .map((row) => (isRecord(row) && typeof row.name === "string" ? row.name : ""))
      .filter((name) => name !== "");
  } catch {
    return [];
  }
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value) ? (value as unknown[]).filter((v): v is string => typeof v === "string") : [];
}
