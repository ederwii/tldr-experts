/**
 * Block-style YAML for `run.yml` and `budget.yml`.
 *
 * Same reasoning as `emitFactsYaml`: these are committed, human-read, diffed files,
 * and the runtime seam's two YAML implementations do not agree on layout. Hand-
 * emitting the two shapes we own means a run.yml written under Node and one written
 * under Bun are byte-identical, so a diff only ever shows what actually changed.
 */
import { yamlScalar } from "../facts/emitFactsYaml.ts";
import type { RunBudget } from "../budget/RunBudget.ts";
import type { RunFile, RunGate, RunStage, RunTask } from "./RunFile.ts";

function inlineList(values: readonly string[]): string {
  return `[${values.map((v) => yamlScalar(v)).join(", ")}]`;
}

function money(n: number): string {
  return n.toFixed(2);
}

function gate(g: RunGate): string {
  return `{type: ${yamlScalar(g.type)}, status: ${yamlScalar(g.status)}, by: ${yamlScalar(g.by)}, ` +
    `at: ${yamlScalar(g.at)}, note: ${yamlScalar(g.note)}}`;
}

function task(t: RunTask, indent: string): string {
  const inner = `${indent}   `;
  return [
    `${indent} - {id: ${yamlScalar(t.id)}, status: ${yamlScalar(t.status)}, expert: ${yamlScalar(t.expert)}, ` +
      `model: ${yamlScalar(t.model)}, cost_usd: ${money(t.cost_usd)},`,
    `${inner}error: ${yamlScalar(t.error)}, session_id: ${yamlScalar(t.session_id)},`,
    `${inner}started_at: ${yamlScalar(t.started_at)}, ended_at: ${yamlScalar(t.ended_at)},`,
    `${inner}outputs: ${inlineList(t.outputs)}}`,
  ].join("\n");
}

function stage(s: RunStage): string {
  const lines = [
    `      - id: ${yamlScalar(s.id)}`,
    `        status: ${yamlScalar(s.status)}`,
    `        expert: ${yamlScalar(s.expert)}`,
    `        model: ${yamlScalar(s.model)}`,
    `        budget_usd: ${money(s.budget_usd)}`,
    `        cost_usd: ${money(s.cost_usd)}`,
    `        started_at: ${yamlScalar(s.started_at)}`,
    `        ended_at: ${yamlScalar(s.ended_at)}`,
    `        inputs: ${inlineList(s.inputs)}`,
    `        outputs: ${inlineList(s.outputs)}`,
    `        gate: ${gate(s.gate)}`,
  ];
  if (s.tasks.length === 0) {
    lines.push("        tasks: []");
  } else {
    lines.push("        tasks:");
    for (const t of s.tasks) lines.push(task(t, "       "));
  }
  return lines.join("\n");
}

export function emitRunYaml(run: RunFile): string {
  const lines = [
    "# tldrx-work/<run>/run.yml — the execution path and the only resume point (spec §2.2).",
    "# Written by the facilitator alone. Hand-edit at your own risk: every write revalidates.",
    `version: ${run.version}`,
    `run: ${yamlScalar(run.run)}`,
    `title: ${yamlScalar(run.title)}`,
    `scope: ${yamlScalar(run.scope)}`,
    `workflow: ${yamlScalar(run.workflow)}`,
    `repos: ${inlineList(run.repos)}`,
    `created_at: ${yamlScalar(run.created_at)}`,
    `updated_at: ${yamlScalar(run.updated_at)}`,
    `status: ${yamlScalar(run.status)}`,
    `cursor: {phase: ${yamlScalar(run.cursor.phase)}, stage: ${yamlScalar(run.cursor.stage)}, ` +
      `task: ${yamlScalar(run.cursor.task)}}`,
    `budget: {ceiling_usd: ${money(run.budget.ceiling_usd)}, spent_usd: ${money(run.budget.spent_usd)}, ` +
      `per_agent_max_usd: ${money(run.budget.per_agent_max_usd)}}`,
  ];
  // Optional §6.2 provenance. Emitted only when it is there, so a run.yml written
  // by `run new` is byte-identical to the one it wrote before triage existed.
  if (run.triage !== undefined) {
    lines.push(
      `triage: {split: ${yamlScalar(run.triage.split)}, depends_on: ${inlineList(run.triage.depends_on)}}`,
    );
  }
  lines.push("phases:");
  for (const phase of run.phases) {
    lines.push(`  - id: ${yamlScalar(phase.id)}`);
    lines.push(`    status: ${yamlScalar(phase.status)}`);
    if (phase.stages.length === 0) {
      lines.push("    stages: []");
    } else {
      lines.push("    stages:");
      for (const s of phase.stages) lines.push(stage(s));
    }
  }
  return `${lines.join("\n")}\n`;
}

export function emitBudgetYaml(budget: RunBudget): string {
  const lines = [
    "# tldrx-work/<run>/budget.yml — the ceiling the facilitator refuses to exceed (spec §2.11).",
    "# Actuals are rolled up from run.yml task costs; never typed by hand.",
    `version: ${budget.version}`,
    `run: ${yamlScalar(budget.run)}`,
    `ceiling_usd: ${money(budget.ceiling_usd)}`,
    `per_agent_max_usd: ${money(budget.per_agent_max_usd)}`,
    `warn_at_pct: ${budget.warn_at_pct}`,
    `on_exceed: ${yamlScalar(budget.on_exceed)}`,
    "phases:",
  ];
  for (const phase of budget.phases) {
    lines.push(
      `  - {id: ${yamlScalar(phase.id)}, ceiling_usd: ${money(phase.ceiling_usd)}, ` +
        `spent_usd: ${money(phase.spent_usd)}}`,
    );
  }
  return `${lines.join("\n")}\n`;
}
