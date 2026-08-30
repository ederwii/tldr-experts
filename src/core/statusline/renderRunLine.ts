/**
 * The full status line (spec §4).
 *
 *   [tldrx] 260828-leaderboard · 02-HOW [▓▓░░░] 2/5 > contracts — architect | Sonnet ctx:16% $3.75/$25
 *
 * Half the line comes from Claude Code's statusLine payload (`model.display_name`,
 * `context_window.used_percentage`, `cost.total_cost_usd`) and half from the run
 * (`run`, `cursor`, phase progress, `budget.ceiling_usd`). Neither half is faked:
 * with no run, the caller falls back to the short line rather than printing zeros.
 */
import { bar } from "../run/runStatus.ts";
import type { RunSnapshot } from "./runSnapshot.ts";

export interface StatusLineHost {
  readonly modelName: string;
  readonly usedPercentage: number;
  readonly totalCostUsd: number;
}

export function renderRunLine(host: StatusLineHost, snapshot: RunSnapshot): string {
  const phase = snapshot.phase === "" ? "?" : snapshot.phase.toUpperCase();
  const stage = snapshot.stage === "" ? "?" : snapshot.stage;
  const expert = snapshot.expert === null || snapshot.expert === "" ? "" : ` — ${snapshot.expert}`;
  return (
    `[tldrx] ${snapshot.run}${alsoOpen(snapshot.openCount)} · ${phase} [${bar(snapshot.done, snapshot.total)}] ` +
    `${String(snapshot.done)}/${String(snapshot.total)}${signedByMachine(snapshot)} > ${stage}${expert} | ` +
    `${host.modelName} ctx:${String(Math.floor(host.usedPercentage))}% ` +
    `${money(host.totalCostUsd)}/${money(snapshot.ceilingUsd)}`
  );
}

/**
 * ` auto:2` when the facilitator signed gates in this run, ` stale:1` after an
 * approval was revoked. Nothing at all when neither happened, so the ordinary
 * line is byte-identical to what it always was.
 *
 * On the line because `by: auto` reached run.yml, the event log and `run status`
 * and never the place an operator actually looks (2026-08-29 audit, §B).
 */
function signedByMachine(snapshot: RunSnapshot): string {
  const parts: string[] = [];
  if (snapshot.autoGates > 0) parts.push(`auto:${String(snapshot.autoGates)}`);
  if (snapshot.staleStages > 0) parts.push(`stale:${String(snapshot.staleStages)}`);
  return parts.length === 0 ? "" : ` ${parts.join(" ")}`;
}

/**
 * ` (+2 open)` when other runs are open, nothing when this is the only one.
 *
 * The line shows ONE run because it is one line; the marker is what stops that
 * from reading as "there is one run". The number counts the OTHERS, so it lines
 * up with the `run new` notice and with what `tldrx run status` would list.
 */
function alsoOpen(openCount: number): string {
  return openCount > 1 ? ` (+${String(openCount - 1)} open)` : "";
}

/** `$25` not `$25.00`; `$3.75` stays `$3.75`. A status line is read, not audited. */
export function money(amount: number): string {
  return `$${amount.toFixed(2).replace(/\.00$/, "")}`;
}

/** The statusLine payload fields the host half of the line needs. */
export function hostFrom(input: unknown): StatusLineHost | null {
  if (typeof input !== "object" || input === null) return null;
  const payload = input as {
    model?: { display_name?: unknown } | null;
    context_window?: { used_percentage?: unknown } | null;
    cost?: { total_cost_usd?: unknown } | null;
  };
  const modelName = payload.model?.display_name;
  const pct = payload.context_window?.used_percentage;
  const cost = payload.cost?.total_cost_usd;
  if (typeof modelName !== "string" || modelName === "") return null;
  if (typeof pct !== "number" || Number.isNaN(pct)) return null;
  if (typeof cost !== "number" || Number.isNaN(cost)) return null;
  return { modelName, usedPercentage: pct, totalCostUsd: cost };
}

/**
 * Where the session is, per the statusLine payload: `workspace.project_dir` is
 * the original project root, `cwd` is wherever the session wandered to. Project
 * first — a run lives at the workspace root, not in whatever subdirectory is open.
 */
export function locateFrom(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const payload = input as {
    workspace?: { project_dir?: unknown; current_dir?: unknown } | null;
    cwd?: unknown;
  };
  const candidates = [payload.workspace?.project_dir, payload.cwd, payload.workspace?.current_dir];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate !== "") return candidate;
  }
  return null;
}
