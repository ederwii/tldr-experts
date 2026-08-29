#!/usr/bin/env bun
/**
 * tldrx hook: session-start
 * SessionStart — always fires, never blocks.
 *
 * Concept §3 (non-intrusive): the entire ambient footprint of a run is three lines
 * of "where we are", injected as `additionalContext`. No run ⇒ no output at all.
 *
 * Fails OPEN.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runHook, sessionContext, allow } from "./lib/decide.ts";
import { readPayload } from "./lib/payload.ts";
import { findWorkspaceRoot } from "./lib/workspace.ts";
import { newestActiveRun, cursorStage, type RunView } from "./lib/runFile.ts";
import { parseQuestions, openBlocks } from "../core/text/questions.ts";

const MAX_LINES = 3;

await runHook("session-start", async () => {
  const payload = await readPayload();
  const root = findWorkspaceRoot(payload.cwd ?? process.cwd());
  if (root === null) return;

  const view = newestActiveRun(root);
  if (view === null) return;

  sessionContext(renderStatus(view).join("\n"));
});

/**
 * `[assumption]` — the spec asks for "a 3-line 'where we are'" without fixing the
 * wording. Taken: line 1 the run, line 2 the cursor, line 3 whatever is waiting on
 * a human; a line with nothing to say is dropped rather than padded.
 */
function renderStatus(view: RunView): readonly string[] {
  const lines: string[] = [];
  const title = view.title === "" ? "" : ` — "${view.title}"`;
  const scope = view.scope === "" ? "" : ` (${view.scope})`;
  lines.push(`tldrx: run ${view.run}${title}${scope} · ${view.status || "unknown"}`);

  if (view.cursor !== null) {
    const stage = cursorStage(view);
    const expert = stage?.expert == null ? "" : ` — ${stage.expert}`;
    const status = stage?.status == null || stage.status === "" ? view.status : stage.status;
    lines.push(`tldrx: at ${view.cursor.phase} / ${view.cursor.stage}${expert} · ${status}`);
  }

  const pending = pendingLine(view);
  if (pending !== null) lines.push(pending);
  return lines.slice(0, MAX_LINES);
}

/** One line for whatever is waiting on a human: an open question, or a gate. */
function pendingLine(view: RunView): string | null {
  const open = openQuestionIds(view);
  const bits: string[] = [];
  if (open.length > 0) {
    bits.push(`${open.length} open question${open.length === 1 ? "" : "s"} (${open.slice(0, 3).join(", ")})`);
  }
  const stage = cursorStage(view);
  if (view.status === "awaiting_gate" || stage?.status === "awaiting_gate") {
    bits.push("gate pending: `tldrx approve`");
  }
  if (bits.length === 0) return null;
  return `tldrx: ${bits.join(" · ")}`;
}

function openQuestionIds(view: RunView): readonly string[] {
  const ids: string[] = [];
  for (const phase of listPhaseDirs(view.dir)) {
    const path = join(view.dir, phase, "questions.md");
    if (!existsSync(path)) continue;
    try {
      for (const block of openBlocks(parseQuestions(readFileSync(path, "utf8")).blocks)) ids.push(block.id);
    } catch {
      // A malformed questions.md is not this hook's problem.
    }
  }
  return ids;
}

function listPhaseDirs(runDir: string): readonly string[] {
  try {
    return readdirSync(runDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^0[1-9]-/.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

allow();
