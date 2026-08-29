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

const MAX_LINES = 3;

await runHook("session-start", async () => {
  const payload = await readPayload();
  const root = findWorkspaceRoot(payload.cwd ?? process.cwd());
  if (root === null) return;

  const snapshot = runSnapshot(root);
  if (snapshot === null) return;

  sessionContext(renderStatus(snapshot).join("\n"));
});

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
