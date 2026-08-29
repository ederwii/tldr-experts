/**
 * The four things a tldrx hook is allowed to do (spec §4).
 *
 * Only PreToolUse can block, and it blocks by PRINTING JSON and exiting 0 — an
 * exit code never denies here. PostToolUse can only feed context back. Everything
 * else is an allow, and an allow is silent.
 */

export function deny(reason: string): never {
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    })}\n`,
  );
  process.exit(0);
}

export function allow(): never {
  process.exit(0);
}

/** PostToolUse feedback: one line of context, never a decision. */
export function postContext(text: string): never {
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: text },
    })}\n`,
  );
  process.exit(0);
}

export function sessionContext(text: string): never {
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text },
    })}\n`,
  );
  process.exit(0);
}

/**
 * Spec §4: every hook but DoD-gate fails OPEN. An internal error must never cost
 * the user a write — it costs one line of stderr and nothing else.
 */
export function failOpen(name: string, error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`tldrx hook ${name}: internal error, allowing — ${message.split("\n")[0] ?? ""}\n`);
  process.exit(0);
}

/** Wrap a hook body so any throw becomes a fail-open allow. */
export async function runHook(name: string, body: () => Promise<void>): Promise<never> {
  try {
    await body();
  } catch (error) {
    failOpen(name, error);
  }
  return allow();
}
