#!/usr/bin/env bun
/**
 * tldrx hook: session-start
 * Wired to: SessionStart
 *
 * Concept §3 (non-intrusive): print one 'where we are' line for the active run, read from tldrx-work/<run>/run.yml. On SessionStart, stdout is shown to Claude as context.
 *
 * STATUS: NOT IMPLEMENTED. Reads stdin, logs to stderr, exits 0 (allow).
 * Hook contract: https://code.claude.com/docs/en/hooks
 */
import { passthrough } from "../core/hooks/passthrough.ts";

await passthrough("session-start");
