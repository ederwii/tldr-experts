#!/usr/bin/env bun
/**
 * tldrx hook: no-reask
 * Wired to: PreToolUse (matcher: Write|Edit)
 *
 * Concept §1.2 / §8: a question written to questions.md whose subject already has an entry in .tldrx/memory/facts.yml is a framework test failure. When implemented this rejects the write (exit 2) and cites the fact id.
 *
 * STATUS: NOT IMPLEMENTED. Reads stdin, logs to stderr, exits 0 (allow).
 * Hook contract: https://code.claude.com/docs/en/hooks
 */
import { passthrough } from "../core/hooks/passthrough.ts";

await passthrough("no-reask");
