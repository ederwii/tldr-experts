#!/usr/bin/env bun
/**
 * tldrx hook: answer-capture
 * Wired to: UserPromptSubmit
 *
 * Concept §2 / §13: answers to interview questions are captured to .tldrx/memory/facts.yml with provenance (who / when / run / question id). Never blocks; it only records.
 *
 * STATUS: NOT IMPLEMENTED. Reads stdin, logs to stderr, exits 0 (allow).
 * Hook contract: https://code.claude.com/docs/en/hooks
 */
import { passthrough } from "../core/hooks/passthrough.ts";

await passthrough("answer-capture");
