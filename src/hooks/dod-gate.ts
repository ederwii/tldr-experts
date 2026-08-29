#!/usr/bin/env bun
/**
 * tldrx hook: dod-gate
 * Wired to: PostToolUse (matcher: Write|Edit)
 *
 * Concept §8 'Done means proven': a story cannot move to done unless stories/<id>.md carries a fenced command block AND this hook re-ran it with exit 0 (test + lint + typecheck from map/commands.md). The agent's own 'ok' is never evidence.
 *
 * STATUS: NOT IMPLEMENTED. Reads stdin, logs to stderr, exits 0 (allow).
 * Hook contract: https://code.claude.com/docs/en/hooks
 */
import { passthrough } from "../core/hooks/passthrough.ts";

await passthrough("dod-gate");
