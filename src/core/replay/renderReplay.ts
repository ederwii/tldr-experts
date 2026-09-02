/**
 * `tldrx replay <run>` — the stakeholder narrative (concept §15.4).
 *
 * Built from `events.jsonl` in file order, laid over the execution path in
 * `run.yml`. Nothing is inferred: a line appears because an event was logged, and
 * a stage with no events says so rather than being narrated from its status.
 */
import { openBlocks, parseQuestions } from "../text/index.ts";
import { parseEvidence } from "../text/evidence.ts";
import { skippedNote } from "../events/EventLog.ts";
import { describeGateSignature } from "../run/gateAuthority.ts";
import {
  loadGateEvidence, loadPhaseArtefacts, runLevelEvents, stageEvents,
  type LoadedRun, type NumberedEvent,
} from "./loadRun.ts";
import type { RunPhase, RunStage } from "./RunDocument.ts";

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
      out.push(...gateEvidenceLines(loaded, phase, stage));
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
    // Who SIGNED it, not merely who ran the process (#122). A gate an agent
    // closed under a delegated policy carries the operator's name in `by`,
    // and a narrative read six months later must not present that as the
    // operator having reviewed it. Every event written before those fields
    // existed renders the bare actor, exactly as it always did.
    case "gate.approved":
      return `${prefix}gate APPROVED by ${signature(actor, payload)}${note(payload.note)}`;
    case "gate.rejected": return `${prefix}gate REJECTED by ${actor}${note(payload.note)}`;
    // An approval TAKEN BACK was in the event set and in no narrative: `bullet`
    // had no case for it, so it fell to `default: return null` and a replay of a
    // run whose gate had been revoked showed the approval and nothing after it
    // (issue #123). It is also where the withdrawn signature's evidence now
    // lives, and evidence moved somewhere no reader looks is evidence deleted.
    case "gate.revoked":
      return `${prefix}gate REVOKED by ${actor} — signed by ${text(payload.signed_by) || "unknown"}`
        + `${text(payload.signed_at) === "" ? "" : ` at ${text(payload.signed_at)}`}`
        + `${staleClause(payload.staled)}${withdrawnEvidence(payload.evidence)}${note(payload.note)}`;
    // A person overruling a block is the one thing in the log that explains why a
    // story's attempt counter went backwards. A narrative that showed the two
    // `changes` verdicts and then a third developer turn, with nothing in between,
    // would read as the framework losing count.
    case "story.reopened":
      return `${prefix}story ${text(payload.story) || "?"} REOPENED by ${actor}`
        + ` — back to \`${text(payload.to_status) || "todo"}\` from \`${text(payload.from_status) || "?"}\``
        + `${note(payload.note)}`;
    // The one event in the set that records tldrx moving a ref (design §F.2). A
    // narrative that showed a story's diff base change with nothing in between
    // would read as the framework editing the operator's git state behind them.
    case "story.base_fastforwarded":
      return `${prefix}story ${text(payload.story) || "?"}'s base fast-forwarded to`
        + ` \`${text(payload.base) || "?"}\` — ${text(payload.from) || "?"} → ${text(payload.to) || "?"}`
        + ` (${String(payload.commits ?? "?")} commit(s))`;
    // The only line in the narrative a PERSON wrote about themselves. It is
    // rendered in place, at its own timestamp, which is the entire point of the
    // event existing (issue #46) — the alternatives it replaced were a note
    // hanging off a later gate and a note hanging off an unrelated reopen.
    // Who may close a gate is the one property of a run that changes what every
    // LATER gate line in this narrative means. A policy that moved with nothing
    // in between would read as the framework having changed its own rules.
    case "gate.policy_changed":
      return `${prefix}gate policy \`${text(payload.from) || "?"}\` \u2192 \`${text(payload.to) || "?"}\``
        + ` by ${actor}${note(payload.note)}`;
    case "operator_note":
      return `${prefix}NOTE by ${actor}: ${text(payload.note) || "(empty)"}`;
    case "check.failed": return `${prefix}check failed: ${checkName(payload)}${note(payload.detail)}`;
    case "budget.warned": return `${prefix}budget warning: ${text(payload.message) || `${money(cost_usd)} spent`}`;
    case "budget.blocked": return `${prefix}budget BLOCKED: ${text(payload.message) || "the spawn was refused"}`;
    case "fact.added": return `${prefix}fact ${text(payload.fact) || text(payload.id) || "recorded"} added`;
    case "fact.retired": return `${prefix}fact ${text(payload.fact) || text(payload.id) || ""} retired`.trimEnd();
    // The one moment the workspace's durable memory changes its mind. A narrative
    // that showed two contradictory `fact.added` lines and nothing between them
    // would read as the run having decided both.
    case "fact.superseded":
      return `${prefix}fact ${text(payload.supersedes) || "?"} SUPERSEDED by `
        + `${text(payload.fact) || "?"} (${q || "a question"}), ${actor}: `
        + `${text(payload.answer) || "no answer recorded"}`;
    // The moment an earlier phase's document stopped being current. A narrative
    // that showed the answer and not the documents it overtook is exactly the gap
    // gh #104 measured — the flip was in the log and in none of the pages.
    case "doc.superseded":
      return `${prefix}${text(payload.doc) || "a phase document"} marked superseded in part by `
        + `${text(payload.fact) || "?"} (${q || "a question"}) — the document itself was not reconciled`;
    case "map.refreshed": return `${prefix}map refreshed`;
    // Nothing moved and nothing was spent — but a host wrote an envelope it could
    // not read, and the run said so out loud rather than shrugging (gh #88). The
    // path is the whole point of the line: it is the file to go and rewrite.
    case "result.unreadable":
      return `${prefix}UNREADABLE ${text(payload.path) || "result.json"}`
        + ` — ${text(payload.error) || "no parse error recorded"}`
        + " (nothing failed; rewrite it and run the same command again)";
    case "error": return `${prefix}error: ${text(payload.message) || "no message recorded"}`;
    default: return null;
  }
}

/**
 * Who checked what, on a gate an agent closed (design §A.5).
 *
 * Rendered from the note's FRONT MATTER and from `run.yml`, never from the note's
 * prose — a narrative built by re-reading somebody's paragraphs is a narrative
 * that changes when they rephrase them. `run.yml` carries the pointer and the
 * headline counts; the three numbers a reader wants that it does not carry —
 * files read, paths audited, diff vs stories — come from the committed copy.
 *
 * A note that has gone missing is SAID to be missing. The gate still happened,
 * the counts run.yml recorded still stand, and pretending the evidence is there
 * would be worse than a short line.
 */
function gateEvidenceLines(loaded: LoadedRun, phase: RunPhase, stage: RunStage): readonly string[] {
  const evidence = stage.gate?.evidence ?? null;
  if (evidence === null) return [];
  const gate = `${phase.id}/${stage.id}`;
  const by = stage.gate?.by ?? "?";
  const head = `- ${gate} ${evidence.verdict.toUpperCase()} by ${by} (${evidence.role})`;

  const text = loadGateEvidence(loaded, evidence.path);
  const front = text === null ? null : parseEvidence(text).front;
  const sampled = `spot-checked ${count(evidence.sampled)} of ${count(evidence.of)} citations `
    + `(${count(evidence.resolved)} resolved)`;
  if (front === null) {
    return [
      `${head} — ${sampled}, ${count(evidence.outside_surface)} touched path(s) outside the surface`,
      `  → ${evidence.path} _(not in this run tree — the note it was signed over is missing)_`,
    ];
  }
  return [
    `${head} — read ${String(front.read.length)} files, ${sampled},`,
    `  audited ${String(front.touches.audited)} touched paths `
      + `(${String(front.touches.outside_surface)} outside the surface), `
      + `diff vs stories: ${front.diff_vs_stories}`,
    `  → ${evidence.path}`,
  ];
}

function count(value: number | null): string {
  return value === null ? "?" : String(value);
}

/** How many later stages the revocation left behind — omitted when none did. */
function staleClause(value: unknown): string {
  const staled = Array.isArray(value) ? value.length : 0;
  return staled === 0 ? "" : `, ${String(staled)} later stage(s) marked stale`;
}

/**
 * What the withdrawn signature had rested on (issue #123).
 *
 * Read off the EVENT, because `revoke` clears it from `run.yml` — a gate nobody
 * has signed rests on nothing, and the same mapping cannot say `by: null` and
 * name the counts a signature was closed over. The note itself never moved, so
 * the line says where it still is: the pointer was cleared, not a file deleted.
 *
 * Absent on every `gate.revoked` written before this, and on every revocation of
 * a human or auto gate, which rest on no note at all — those render exactly the
 * line they always would have.
 */
function withdrawnEvidence(value: unknown): string {
  if (!isRecord(value)) return "";
  const path = text(value.path);
  const verdict = text(value.verdict);
  const counts = typeof value.sampled === "number" && typeof value.of === "number"
    ? `, ${String(value.sampled)} of ${String(value.of)} citations spot-checked`
    : "";
  return ` — it had been signed over ${path === "" ? "an evidence note" : path}`
    + `${verdict === "" ? "" : ` (${verdict}${counts})`}, which is still on disk`;
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

/**
 * The gate signature as `run status` and the dashboard render it (#122), read out
 * of an event payload rather than off `run.yml`.
 *
 * The payload is `unknown` by construction — `events.jsonl` is JSON somebody
 * else's version may have written — so the two blocks are narrowed here and a
 * malformed one falls back to the actor. A narrative is not the place to refuse.
 */
function signature(actor: string, payload: Readonly<Record<string, unknown>>): string {
  const executed = payload.executed_by;
  if (!isRecord(executed) || typeof executed.type !== "string") return actor;
  const authority = payload.authority;
  return describeGateSignature({
    by: typeof payload.by === "string" ? payload.by : actor,
    executed_by: { type: executed.type, id: typeof executed.id === "string" ? executed.id : null },
    authority: !isRecord(authority) || typeof authority.type !== "string"
        || typeof authority.policy !== "string"
      ? null
      : {
          type: authority.type,
          policy: authority.policy,
          authorized_by: typeof authority.authorized_by === "string" ? authority.authorized_by : null,
        },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
