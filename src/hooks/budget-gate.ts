#!/usr/bin/env bun
/**
 * tldrx hook: budget-gate
 * Wired to: PreToolUse (matcher: Task)
 *
 * Concept §8 / §1.5: refuse to start a stage when remaining budget < estimate, and launch every sub-agent with its own --max-budget-usd share so a runaway agent cannot eat the phase.
 *
 * STATUS: NOT IMPLEMENTED. Reads stdin, logs to stderr, exits 0 (allow).
 * Hook contract: https://code.claude.com/docs/en/hooks
 */
import { passthrough } from "../core/hooks/passthrough.ts";

await passthrough("budget-gate");
