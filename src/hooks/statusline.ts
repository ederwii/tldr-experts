#!/usr/bin/env bun
/**
 * tldrx hook: statusline
 * Wired to: the `statusLine` settings key (NOT the hooks map).
 *
 * Settings shape (https://code.claude.com/docs/en/statusline):
 *   { "statusLine": { "type": "command", "command": "bun /path/to/statusline.ts", "padding": 2 } }
 *
 * This is the ONE hook that does real work in v0: it renders what Claude Code
 * already measures. Everything richer (run id, phase, progress bar, budget
 * ceiling) needs run.yml, which v0 does not write yet.
 *
 * Prints to stdout and always exits 0 — a status line must never break a session.
 */
import { renderStatusLineFromText, NO_SESSION_DATA } from "../core/statusline/renderStatusLine.ts";

let text = "";
try {
  text = await Bun.stdin.text();
} catch {
  text = "";
}

try {
  process.stdout.write(renderStatusLineFromText(text) + "\n");
} catch {
  process.stdout.write(NO_SESSION_DATA + "\n");
}
process.exit(0);
