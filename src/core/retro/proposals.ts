/**
 * Practice proposals — deterministic heuristics over `events.jsonl`.
 *
 * No model runs here. Each proposal is a pattern that the log can prove happened,
 * and each carries the line that proves it, so a reader can go check. The five
 * v0 heuristics:
 *
 *   1. a stage that was rejected at a gate at least once
 *   2. a stage whose logged cost passed its `run.yml` `budget_usd`
 *   3. a stage that asked more questions than its `stage.yml` `questions.max`
 *   4. every `check.failed`
 *   5. every `budget.warned` / `budget.blocked`
 *
 * Anything that needs judgement is NOT proposed — it goes to the human as prose
 * in the replay, not as a heuristic pretending to be a finding.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseYaml } from "../yaml.ts";
import { PROJECT_FRAMEWORK_DIR } from "../paths.ts";
import type { LoadedRun } from "../replay/index.ts";
import type { Proposal } from "./Proposal.ts";

/** Marker a human writes in a rejection note to ask for a new stage. */
export const PROPOSE_STAGE_MARKER = "propose stage:";

export function practiceProposals(loaded: LoadedRun): readonly Proposal[] {
  return [
    ...rejectedStages(loaded),
    ...overBudgetStages(loaded),
    ...questionCapExceeded(loaded),
    ...failedChecks(loaded),
    ...budgetEvents(loaded),
  ].sort((a, b) => a.line - b.line);
}

function rejectedStages(loaded: LoadedRun): readonly Proposal[] {
  const byStage = new Map<string, { count: number; line: number }>();
  for (const { line, event } of loaded.events) {
    if (event.type !== "gate.rejected" || event.stage === null) continue;
    const seen = byStage.get(event.stage);
    byStage.set(event.stage, { count: (seen?.count ?? 0) + 1, line });
  }
  return [...byStage].map(([stage, seen]) => ({
    line: seen.line,
    text: `Stage \`${stage}\` was rejected ${seen.count} time${seen.count === 1 ? "" : "s"} at its gate — `
      + "tighten its inputs or split it before the next run of this workflow.",
  }));
}

function overBudgetStages(loaded: LoadedRun): readonly Proposal[] {
  const ceilings = new Map<string, number>();
  for (const phase of loaded.run.phases) {
    for (const stage of phase.stages) {
      if (stage.budget_usd !== null) ceilings.set(stage.id, stage.budget_usd);
    }
  }

  const spent = new Map<string, number>();
  const found: Proposal[] = [];
  const reported = new Set<string>();

  for (const { line, event } of loaded.events) {
    if (event.stage === null || event.cost_usd <= 0) continue;
    const ceiling = ceilings.get(event.stage);
    if (ceiling === undefined) continue;
    const total = (spent.get(event.stage) ?? 0) + event.cost_usd;
    spent.set(event.stage, total);
    if (total > ceiling && !reported.has(event.stage)) {
      reported.add(event.stage);
      found.push({
        line,
        text: `Stage \`${event.stage}\` cost $${total.toFixed(2)} against a $${ceiling.toFixed(2)} ceiling — `
          + "raise the ceiling deliberately or cut the stage's scope; do not let it overrun silently.",
      });
    }
  }
  return found;
}

function questionCapExceeded(loaded: LoadedRun): readonly Proposal[] {
  const asked = new Map<string, number>();
  const found: Proposal[] = [];
  const reported = new Set<string>();

  for (const { line, event } of loaded.events) {
    if (event.type !== "question.asked" || event.stage === null) continue;
    const count = (asked.get(event.stage) ?? 0) + 1;
    asked.set(event.stage, count);
    const cap = questionsMax(loaded.root, event.stage);
    if (cap !== null && count > cap && !reported.has(event.stage)) {
      reported.add(event.stage);
      found.push({
        line,
        text: `Stage \`${event.stage}\` asked ${count} questions against a cap of ${cap} — `
          + "the map or facts.yml is missing something this stage keeps needing.",
      });
    }
  }
  return found;
}

/** `.tldrx/stages/<stage>/stage.yml` -> `questions.max`, or null when unavailable. */
export function questionsMax(root: string, stage: string): number | null {
  const path = join(root, PROJECT_FRAMEWORK_DIR, "stages", stage, "stage.yml");
  if (!existsSync(path)) return null;
  try {
    const doc = parseYaml(readFileSync(path, "utf8"));
    if (typeof doc !== "object" || doc === null) return null;
    const questions = (doc as { questions?: unknown }).questions;
    if (typeof questions !== "object" || questions === null) return null;
    const max = (questions as { max?: unknown }).max;
    return typeof max === "number" ? max : null;
  } catch {
    return null;
  }
}

function failedChecks(loaded: LoadedRun): readonly Proposal[] {
  return loaded.events
    .filter((item) => item.event.type === "check.failed")
    .map(({ line, event }) => ({
      line,
      text: `Check \`${str(event.payload.check) || str(event.payload.id) || "unnamed"}\` failed`
        + `${event.stage === null ? "" : ` in stage \`${event.stage}\``} — `
        + "make it part of the stage's definition of done so it fails earlier next time.",
    }));
}

function budgetEvents(loaded: LoadedRun): readonly Proposal[] {
  return loaded.events
    .filter((item) => item.event.type === "budget.warned" || item.event.type === "budget.blocked")
    .map(({ line, event }) => ({
      line,
      text: event.type === "budget.blocked"
        ? `The budget gate blocked a spawn${event.stage === null ? "" : ` in stage \`${event.stage}\``} — `
          + "the phase ceiling and the stage estimate disagree; fix one of them before the next run."
        : `The budget warned${event.stage === null ? "" : ` in stage \`${event.stage}\``} — `
          + "this workflow is running close to its ceiling; re-estimate it.",
    }));
}

/** Rejection notes containing `propose stage: <name>` (spec §7 leaves acceptance to the human). */
export function proposedStages(loaded: LoadedRun): readonly Proposal[] {
  const found: Proposal[] = [];
  for (const { line, event } of loaded.events) {
    if (event.type !== "gate.rejected") continue;
    const note = str(event.payload.note);
    const at = note.toLowerCase().indexOf(PROPOSE_STAGE_MARKER);
    if (at === -1) continue;
    const body = note.slice(at + PROPOSE_STAGE_MARKER.length).trim();
    if (body === "") continue;
    found.push({
      line,
      text: `\`${body}\` — proposed in a rejection note${event.stage === null ? "" : ` on stage \`${event.stage}\``}. `
        + "Inert until a human accepts it into `.tldrx/stages/`.",
    });
  }
  return found;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
