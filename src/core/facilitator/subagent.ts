/**
 * The one marker that tells a spawned sub-agent apart from a human's session
 * (gh #196).
 *
 * Its own leaf because both sides need it and they must not need each other: a
 * SessionStart hook runs on every session a human opens, and importing
 * `spawnAgent.ts` — the agent stream, the envelope schema, the runtime — to read
 * one string would charge every one of those sessions for a spawn path it will
 * never take. §7's "one implementation per derivation": the name lives here, and
 * `spawnAgent` and `hooks/session-start` both read it from here.
 */
export const SUBAGENT_ENV_VAR = "TLDRX_SUBAGENT";

/** True when THIS process was spawned by tldrx as a sub-agent. */
export function isSubagentEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return (env[SUBAGENT_ENV_VAR] ?? "") !== "";
}

/** The caller's environment (or the live one), plus the marker. */
export function subagentEnv(
  base?: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  return { ...(base ?? process.env), [SUBAGENT_ENV_VAR]: "1" };
}
