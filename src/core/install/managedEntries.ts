/**
 * What `tldrx install --claude` puts into `.claude/settings.json`, and how it
 * knows later which of those entries are its own.
 *
 * The list mirrors `plugin/hooks/hooks.json` one-for-one: the same six scripts,
 * on the same four events, with the same matchers and timeouts. The only thing
 * that changes is HOW each script is named. The plugin has to work for someone who
 * cloned the repo and never installed anything, so it spawns `bun
 * ${CLAUDE_PLUGIN_ROOT}/../src/hooks/<name>.ts` — an absolute path computed by
 * Claude Code. A `settings.json` written by `install` cannot use that variable
 * (there is no plugin root) and must not hard-code an absolute path (it is
 * committed, and the next machine puts the checkout somewhere else), so it goes
 * through the CLI instead: `tldrx hook <name>`.
 *
 * That prefix is also the ownership marker. Uninstall removes exactly the handlers
 * whose command starts with `tldrx hook ` (plus the `tldrx statusline` status line)
 * and nothing else — no marker comment is possible inside JSON, and matching on the
 * command string is the only test that survives a user reordering the file.
 */
import type { HookEntry } from "./ClaudeSettings.ts";

/** The six hook scripts, in `plugin/hooks/hooks.json` order. */
export const HOOK_SCRIPTS = [
  "claim-sources",
  "no-reask",
  "dod-gate",
  "budget-gate",
  "answer-capture",
  "session-start",
] as const;
export type HookScript = (typeof HOOK_SCRIPTS)[number];

/** `src/hooks/statusline.ts` is a hook script, but it is wired to a settings KEY. */
export const STATUSLINE_SCRIPT = "statusline";

/** Every script `tldrx hook <name>` will run. */
export const RUNNABLE_SCRIPTS: readonly string[] = [...HOOK_SCRIPTS, STATUSLINE_SCRIPT];

/** The command string prefix that marks a handler as ours. */
export const HOOK_COMMAND_PREFIX = "tldrx hook ";
export const STATUSLINE_COMMAND = "tldrx statusline";

export function hookCommand(script: string): string {
  return `${HOOK_COMMAND_PREFIX}${script}`;
}

export function isManagedCommand(command: unknown): boolean {
  return typeof command === "string" && command.startsWith(HOOK_COMMAND_PREFIX);
}

/** One managed handler, with the event and matcher it belongs under. */
export interface ManagedHook {
  readonly event: string;
  /** Omitted exactly where `hooks.json` omits it (FileChanged, SessionStart). */
  readonly matcher?: string;
  readonly script: HookScript;
  readonly timeout: number;
}

/**
 * Eight handlers over six scripts on four events — the same set the plugin wires.
 * `claim-sources` runs twice (gate on PreToolUse, feedback-only twin on
 * PostToolUse) and `answer-capture` runs twice (after a tool write, and after a
 * human's editor write, which never goes through Write/Edit).
 */
export const MANAGED_HOOKS: readonly ManagedHook[] = [
  { event: "PreToolUse", matcher: "Write|Edit", script: "claim-sources", timeout: 15 },
  { event: "PreToolUse", matcher: "Write|Edit", script: "no-reask", timeout: 15 },
  { event: "PreToolUse", matcher: "Write|Edit", script: "dod-gate", timeout: 960 },
  { event: "PreToolUse", matcher: "Bash", script: "budget-gate", timeout: 15 },
  { event: "PostToolUse", matcher: "Write|Edit", script: "answer-capture", timeout: 15 },
  { event: "PostToolUse", matcher: "Write|Edit", script: "claim-sources", timeout: 15 },
  { event: "FileChanged", script: "answer-capture", timeout: 15 },
  { event: "SessionStart", script: "session-start", timeout: 15 },
];

/** The settings entry one managed hook becomes. */
export function entryFor(hook: ManagedHook): HookEntry {
  const handler = { type: "command", command: hookCommand(hook.script), timeout: hook.timeout };
  return hook.matcher === undefined ? { hooks: [handler] } : { matcher: hook.matcher, hooks: [handler] };
}

/** `{type: "command", command: "tldrx statusline"}` — the whole status line. */
export function statusLineValue(): { type: string; command: string } {
  return { type: "command", command: STATUSLINE_COMMAND };
}
