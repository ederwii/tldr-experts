#!/usr/bin/env bun
/**
 * tldrx hook: claim-sources
 * Wired to: PostToolUse (matcher: Write|Edit)
 *
 * Concept §8: every bullet under Findings / Decisions in a handoff written under
 * `tldrx-work/` must carry a marker: [src: file:line], [src: <url>], or [src: Q<n>].
 * When implemented this rejects the write (exit 2) and names the offending lines.
 *
 * STATUS: NOT IMPLEMENTED. Reads stdin, logs to stderr, exits 0 (allow).
 * Hook contract: https://code.claude.com/docs/en/hooks
 */
import { passthrough } from "../core/hooks/passthrough.ts";

await passthrough("claim-sources");
