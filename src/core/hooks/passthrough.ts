/**
 * Shared body for the v0 hook stubs.
 *
 * Every enforcement hook in the concept doc (§8) is wired but INERT. It reads its
 * stdin payload, announces itself on stderr, and exits 0 — which Claude Code
 * treats as "allow" for every event.
 *
 * Exit-code semantics (https://code.claude.com/docs/en/hooks § "Exit code semantics"):
 *   0 -> success; stderr goes to the debug log only.
 *   2 -> BLOCKING error; stderr is shown to Claude as the reason.
 * Nothing here may return 2 until the check behind it is actually implemented.
 * A hook that blocks on a rule it does not enforce is worse than no hook.
 */

import { runtime } from "../runtime/index.ts";

export interface HookInput {
  readonly session_id?: string;
  readonly hook_event_name?: string;
  readonly cwd?: string;
  readonly tool_name?: string;
  readonly tool_input?: unknown;
}

/** Read all of stdin as text. Returns "" when stdin is closed or empty. */
export async function readStdin(): Promise<string> {
  return await runtime.readStdin();
}

/** Parse the hook payload. Returns null when stdin was empty or not JSON. */
export function parseHookInput(text: string): HookInput | null {
  if (text.trim() === "") return null;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null ? (value as HookInput) : null;
  } catch {
    return null;
  }
}

/**
 * Run a not-yet-implemented hook: consume stdin, log, allow.
 * Always exits 0.
 */
export async function passthrough(name: string): Promise<never> {
  const payload = parseHookInput(await readStdin());
  const event = payload?.hook_event_name ?? "unknown-event";
  process.stderr.write(`tldrx hook ${name}: not implemented (allow) [event=${event}]\n`);
  process.exit(0);
}
