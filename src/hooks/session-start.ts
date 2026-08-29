#!/usr/bin/env bun
/**
 * tldrx hook: session-start
 * SessionStart — always fires, never blocks.
 *
 * Concept §3 (non-intrusive): the entire ambient footprint of a run is three lines
 * of "where we are", injected as `additionalContext`. No run ⇒ no output at all.
 *
 * Reads the same `RunSnapshot` the status line does, so the two can never
 * disagree about which run is live or where its cursor is.
 *
 * Fails OPEN.
 */
import { runHook, sessionContext, allow } from "./lib/decide.ts";
import { readPayload } from "./lib/payload.ts";
import { findWorkspaceRoot } from "./lib/workspace.ts";
import { openQuestions, runSnapshot, type RunSnapshot } from "../core/statusline/runSnapshot.ts";
import { openRunViews } from "./lib/runFile.ts";

const MAX_LINES = 3;

/** A SessionStart block is ambient context, not a report. Eight runs is plenty. */
const MAX_OPEN_LISTED = 8;

await runHook("session-start", async () => {
  const payload = await readPayload();
  const root = findWorkspaceRoot(payload.cwd ?? process.cwd());
  if (root === null) return;

  const snapshot = runSnapshot(root);
  if (snapshot === null) return;

  sessionContext([...renderOpenRuns(root, snapshot), ...renderStatus(snapshot)].join("\n"));
});

/**
 * Nothing at all when one run is open — that is the ordinary case and the three
 * lines below already describe it. When several are, every one of them is named
 * BEFORE the newest-run block, so a session that starts in the wrong run finds
 * out here rather than at the first refusal.
 *
 * Read through the tolerant reader, never `RunStore`: this hook must not go quiet
 * because one unrelated run.yml stopped validating.
 */
function renderOpenRuns(root: string, newest: RunSnapshot): readonly string[] {
  if (newest.openCount < 2) return [];
  const open = openRunViews(root).slice(0, MAX_OPEN_LISTED);
  const lines = [
    `tldrx: ${String(newest.openCount)} runs are open — pass a run id to next/answer/approve/…`,
  ];
  for (const view of open) {
    const cursor = view.cursor === null ? "?" : `${view.cursor.phase}/${view.cursor.stage}`;
    const mark = view.run === newest.run ? "  (newest)" : "";
    lines.push(`tldrx:   ${view.run} · ${view.status || "unknown"} · ${cursor}${mark}`);
  }
  if (newest.openCount > open.length) {
    lines.push(`tldrx:   … and ${String(newest.openCount - open.length)} more — \`tldrx run status\``);
  }
  return lines;
}

/**
 * `[assumption]` — the spec asks for "a 3-line 'where we are'" without fixing the
 * wording. Taken: line 1 the run, line 2 the cursor, line 3 whatever is waiting on
 * a human; a line with nothing to say is dropped rather than padded.
 */
function renderStatus(snapshot: RunSnapshot): readonly string[] {
  const lines: string[] = [];
  const title = snapshot.title === "" ? "" : ` — "${snapshot.title}"`;
  const scope = snapshot.scope === "" ? "" : ` (${snapshot.scope})`;
  lines.push(`tldrx: run ${snapshot.run}${title}${scope} · ${snapshot.status || "unknown"}`);

  if (snapshot.stage !== "") {
    const expert = snapshot.expert === null ? "" : ` — ${snapshot.expert}`;
    lines.push(`tldrx: at ${snapshot.phase} / ${snapshot.stage}${expert} · ${snapshot.stageStatus}`);
  }

  const pending = pendingLine(snapshot);
  if (pending !== null) lines.push(pending);
  return lines.slice(0, MAX_LINES);
}

/** One line for whatever is waiting on a human: an open question, or a gate. */
function pendingLine(snapshot: RunSnapshot): string | null {
  const open = openQuestions(snapshot);
  const bits: string[] = [];
  if (open.length > 0) {
    bits.push(`${String(open.length)} open question${open.length === 1 ? "" : "s"} (${open.slice(0, 3).join(", ")})`);
  }
  if (snapshot.status === "awaiting_gate" || snapshot.stageStatus === "awaiting_gate") {
    bits.push("gate pending: `tldrx approve`");
  }
  if (bits.length === 0) return null;
  return `tldrx: ${bits.join(" · ")}`;
}

allow();
