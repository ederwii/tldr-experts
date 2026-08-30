/**
 * `tldrx replay <run>` — the stakeholder narrative (concept §15.4).
 *
 * Built from `events.jsonl` in file order, laid over the execution path in
 * `run.yml`. Nothing is inferred: a line appears because an event was logged, and
 * a stage with no events says so rather than being narrated from its status.
 */
import { openBlocks, parseQuestions } from "../text/index.ts";
import { skippedNote } from "../events/EventLog.ts";
import { loadPhaseArtefacts, runLevelEvents, stageEvents, type LoadedRun, type NumberedEvent } from "./loadRun.ts";
import type { RunStage } from "./RunDocument.ts";

export function renderReplay(loaded: LoadedRun): string {
  const run = loaded.run;
  const out: string[] = [
    `# Replay — ${run.run}`,
    "",
    describe(run.title === "" ? "" : `**${run.title}**`, `scope \`${run.scope || "?"}\``,
      `workflow \`${run.workflow || "?"}\``,
      run.repos.length > 0 ? `repos ${run.repos.join(", ")}` : ""),
    `Status: **${run.status || "unknown"}** · ${money(run.spent_usd)} spent of ${money(run.ceiling_usd)} ceiling`,
    describe(run.created_at === null ? "" : `Created ${run.created_at}`,
      run.updated_at === null ? "" : `updated ${run.updated_at}`),
  ];

  if (loaded.eventsError !== null) {
    out.push("", `_events.jsonl could not be read: ${loaded.eventsError}_`);
  }
  // A torn last line no longer takes the whole history down (see EventLog.readAll),
  // but the history IS shorter than the file, and a replay that did not say so
  // would be quietly incomplete.
  if (loaded.eventsSkipped > 0) {
    out.push("", `_events.jsonl: ${skippedNote(loaded.eventsSkipped)} (unparseable — a torn write)_`);
  }

  const runLevel = runLevelEvents(loaded);
  if (runLevel.length > 0) {
    out.push("", "## Run", "");
    for (const item of runLevel) {
      const line = bullet(item);
      if (line !== null) out.push(line);
    }
  }

  for (const phase of run.phases) {
    out.push("", `## ${phase.id} — ${phase.status || "unknown"}`);
    if (phase.stages.length === 0) out.push("", "_no stages recorded_");
    for (const stage of phase.stages) {
      out.push("", `### ${stage.id} — ${stage.status || "unknown"}${who(stage)}`, "");
      const events = stageEvents(loaded, stage.id);
      if (events.length === 0) out.push("- _no events recorded for this stage_");
      for (const item of events) {
        const line = bullet(item);
        if (line !== null) out.push(line);
      }
      out.push(`- Cost: ${money(stageCost(stage, events))}${stage.budget_usd === null ? "" : ` of ${money(stage.budget_usd)} ceiling`}`);
    }
  }

  out.push("", "## Where it stands now", "", ...standing(loaded));
  return `${out.join("\n")}\n`;
}

function standing(loaded: LoadedRun): readonly string[] {
  const run = loaded.run;
  const lines: string[] = [];
  lines.push(run.cursor === null
    ? "- Cursor: none — the run has no resume point recorded"
    : `- Cursor: ${run.cursor.phase} / ${run.cursor.stage}${run.cursor.task === null ? "" : ` / ${run.cursor.task}`}`);

  const stage = cursorStage(loaded);
  if (stage !== null && stage.gate !== null && stage.gate.status === "pending") {
    lines.push(`- Pending gate: \`${stage.id}\` is waiting for \`tldrx approve\` (${stage.gate.type})`);
  }

  const open = openQuestions(loaded);
  if (open.length === 0) lines.push("- No open questions.");
  for (const question of open) lines.push(`- Open question: ${question}`);

  if (stage === null && run.cursor !== null) {
    lines.push(`- The cursor does not resolve to a stage in run.yml.`);
  }
  return lines;
}

function openQuestions(loaded: LoadedRun): readonly string[] {
  const found: string[] = [];
  for (const phase of loaded.run.phases) {
    const text = loadPhaseArtefacts(loaded, phase.id).questions;
    if (text === null) continue;
    for (const block of openBlocks(parseQuestions(text).blocks)) {
      found.push(`${block.id} · ${block.title} (${phase.id})`);
    }
  }
  return found;
}

function cursorStage(loaded: LoadedRun): RunStage | null {
  const cursor = loaded.run.cursor;
  if (cursor === null) return null;
  for (const phase of loaded.run.phases) {
    if (phase.id !== cursor.phase) continue;
    return phase.stages.find((stage) => stage.id === cursor.stage) ?? null;
  }
  return null;
}

function stageCost(stage: RunStage, events: readonly NumberedEvent[]): number {
  if (stage.cost_usd > 0) return stage.cost_usd;
  return events.reduce((total, item) => total + item.event.cost_usd, 0);
}

/** One narrative line per event, or null for the bookkeeping types. */
function bullet(item: NumberedEvent): string | null {
  const { ts, type, actor, payload, cost_usd } = item.event;
  const q = text(payload.q);
  const prefix = `- ${ts} — `;

  switch (type) {
    case "run.created": return `${prefix}run created by ${actor}`;
    case "run.closed": return `${prefix}run closed by ${actor}`;
    case "phase.started": return `${prefix}phase started`;
    case "phase.done": return `${prefix}phase done`;
    case "stage.started": return `${prefix}started (${actor})`;
    case "stage.done": return `${prefix}ended`;
    case "stage.failed": return `${prefix}FAILED: ${text(payload.error) || "no reason recorded"}`;
    case "stage.skipped": return `${prefix}skipped: ${text(payload.reason) || "no reason recorded"}`;
    case "question.asked": return `${prefix}${q || "a question"} asked by ${actor}: ${text(payload.question)}`.trimEnd();
    case "question.answered": return `${prefix}${q || "a question"} answered by ${actor}: ${text(payload.answer)}`.trimEnd();
    case "gate.requested": return `${prefix}gate requested`;
    case "gate.approved": return `${prefix}gate APPROVED by ${actor}${note(payload.note)}`;
    case "gate.rejected": return `${prefix}gate REJECTED by ${actor}${note(payload.note)}`;
    case "check.failed": return `${prefix}check failed: ${checkName(payload)}${note(payload.detail)}`;
    case "budget.warned": return `${prefix}budget warning: ${text(payload.message) || `${money(cost_usd)} spent`}`;
    case "budget.blocked": return `${prefix}budget BLOCKED: ${text(payload.message) || "the spawn was refused"}`;
    case "fact.added": return `${prefix}fact ${text(payload.fact) || text(payload.id) || "recorded"} added`;
    case "fact.retired": return `${prefix}fact ${text(payload.fact) || text(payload.id) || ""} retired`.trimEnd();
    case "map.refreshed": return `${prefix}map refreshed`;
    case "error": return `${prefix}error: ${text(payload.message) || "no message recorded"}`;
    default: return null;
  }
}

function checkName(payload: Readonly<Record<string, unknown>>): string {
  return text(payload.check) || text(payload.id) || "unnamed check";
}

function note(value: unknown): string {
  const body = text(value);
  return body === "" ? "" : ` — "${body}"`;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function who(stage: RunStage): string {
  const parts = [stage.expert, stage.model].filter((part): part is string => part !== null && part !== "");
  return parts.length === 0 ? "" : ` (${parts.join(", ")})`;
}

export function money(value: number | null): string {
  return value === null ? "$?" : `$${value.toFixed(2)}`;
}

function describe(...parts: readonly string[]): string {
  return parts.filter((part) => part !== "").join(" · ");
}
