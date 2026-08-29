#!/usr/bin/env bun
/**
 * tldrx hook: statusline
 * Wired to: the `statusLine` settings key (NOT the hooks map).
 *
 * Settings shape (https://code.claude.com/docs/en/statusline):
 *   { "statusLine": { "type": "command", "command": "bun /path/to/statusline.ts", "padding": 2 } }
 *
 * Renders the spec §4 line when there is a run to render, and the short
 * host-only line when there is not. Both halves are real: the model, context and
 * session cost come from the payload Claude Code hands in; the run, cursor,
 * progress and ceiling come from `RunStore`.
 *
 * Prints to stdout and always exits 0 — a status line must never break a session.
 */
import { renderStatusLineFromText, renderStatusLine, NO_SESSION_DATA } from "../core/statusline/renderStatusLine.ts";
import { hostFrom, locateFrom, renderRunLine } from "../core/statusline/renderRunLine.ts";
import { runSnapshot } from "../core/statusline/runSnapshot.ts";
import { findWorkspaceRoot } from "./lib/workspace.ts";
import { runtime } from "../core/runtime/index.ts";

const text = await runtime.readStdin();

process.stdout.write(`${render(text)}\n`);
process.exit(0);

function render(input: string): string {
  let payload: unknown;
  try {
    payload = JSON.parse(input);
  } catch {
    return NO_SESSION_DATA;
  }
  try {
    const host = hostFrom(payload);
    const where = locateFrom(payload);
    if (host !== null && where !== null) {
      const root = findWorkspaceRoot(where);
      const snapshot = root === null ? null : runSnapshot(root);
      if (snapshot !== null) return renderRunLine(host, snapshot);
    }
    return renderStatusLine(payload);
  } catch {
    // Anything at all went wrong reading the run: still show the short line.
    return renderStatusLineFromText(input);
  }
}
