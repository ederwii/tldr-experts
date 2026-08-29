/**
 * The idempotent merge, and its exact inverse.
 *
 * Two properties are load-bearing and both are tested:
 *
 * 1. **Merging twice changes nothing.** A handler is identified by `(event,
 *    command)`, so a second install finds all eight already there and returns the
 *    settings object it was given.
 * 2. **Unmerge is the inverse of merge.** Whatever merge added, unmerge removes —
 *    including the `hooks` key itself when merge is what created it, and the event
 *    arrays merge created. Anything that was in the file first survives both, in
 *    place. `merge(x) |> unmerge` therefore serializes back to the bytes of `x`
 *    for any `x` written by `JSON.stringify(_, null, indent)`.
 *
 * Nothing here writes a file; `installClaude.ts` decides what to do with the
 * result. Keeping the transform pure is what makes `--dry-run` honest — it runs
 * exactly the same code and simply does not call the writer.
 */
import {
  isManagedCommand, MANAGED_HOOKS, STATUSLINE_COMMAND, entryFor, statusLineValue,
} from "./managedEntries.ts";
import type { ClaudeSettings, HookEntry, HookHandler } from "./ClaudeSettings.ts";

export interface MergeOptions {
  readonly hooks: boolean;
  readonly statusline: boolean;
  /** Replace a status line that is not ours. Off by default — see `statusLine`. */
  readonly forceStatusline: boolean;
}

export type StatusLineOutcome = "set" | "already-ours" | "skipped-foreign" | "replaced" | "off";

export interface MergeResult {
  readonly settings: ClaudeSettings;
  /** Commands added, in the order they were added. */
  readonly addedHooks: readonly string[];
  /** Managed commands already present — the reason a second run is a no-op. */
  readonly keptHooks: readonly string[];
  readonly statusLine: StatusLineOutcome;
  /** The foreign command left alone, when `statusLine` is `skipped-foreign`. */
  readonly foreignStatusLine: string | null;
}

/** Add every managed hook that is not already there, and the status line. */
export function mergeSettings(settings: ClaudeSettings, options: MergeOptions): MergeResult {
  const next: Record<string, unknown> = { ...settings };
  const addedHooks: string[] = [];
  const keptHooks: string[] = [];

  if (options.hooks) {
    const hooks: Record<string, HookEntry[]> = {};
    for (const [event, entries] of Object.entries(settings.hooks ?? {})) {
      hooks[event] = Array.isArray(entries) ? [...entries] : [];
    }
    for (const hook of MANAGED_HOOKS) {
      const entry = entryFor(hook);
      const command = entry.hooks[0]?.command ?? "";
      const existing = hooks[hook.event] ?? [];
      if (existing.some((e) => hasCommand(e, command))) {
        hooks[hook.event] = existing;
        keptHooks.push(command);
        continue;
      }
      // A new entry of our own rather than a handler appended to somebody else's:
      // an entry we did not write is an entry we do not edit.
      hooks[hook.event] = [...existing, entry];
      addedHooks.push(command);
    }
    if (Object.keys(hooks).length > 0) next.hooks = hooks;
  }

  let statusLine: StatusLineOutcome = "off";
  let foreign: string | null = null;
  if (options.statusline) {
    const current = settings.statusLine;
    const currentCommand = typeof current?.command === "string" ? current.command : null;
    if (currentCommand === STATUSLINE_COMMAND) {
      statusLine = "already-ours";
    } else if (current === undefined || current === null) {
      next.statusLine = statusLineValue();
      statusLine = "set";
    } else if (options.forceStatusline) {
      next.statusLine = statusLineValue();
      statusLine = "replaced";
      foreign = currentCommand;
    } else {
      statusLine = "skipped-foreign";
      foreign = currentCommand;
    }
  }

  return { settings: next as ClaudeSettings, addedHooks, keptHooks, statusLine, foreignStatusLine: foreign };
}

export interface UnmergeResult {
  readonly settings: ClaudeSettings;
  readonly removedHooks: readonly string[];
  /** True when a `tldrx statusline` status line was removed. */
  readonly removedStatusLine: boolean;
}

/**
 * Remove exactly what merge adds: handlers whose command is ours, the entries that
 * held nothing else, the event arrays that then held nothing, the `hooks` key when
 * it then held nothing — and a status line only when it is still ours.
 */
export function unmergeSettings(settings: ClaudeSettings): UnmergeResult {
  const next: Record<string, unknown> = { ...settings };
  const removedHooks: string[] = [];

  const hooks: Record<string, HookEntry[]> = {};
  for (const [eventName, entries] of Object.entries(settings.hooks ?? {})) {
    if (!Array.isArray(entries)) {
      hooks[eventName] = entries as never;
      continue;
    }
    const kept: HookEntry[] = [];
    for (const entry of entries) {
      const handlers = Array.isArray(entry?.hooks) ? entry.hooks : [];
      const survivors = handlers.filter((handler: HookHandler) => {
        if (!isManagedCommand(handler?.command)) return true;
        removedHooks.push(String(handler.command));
        return false;
      });
      if (survivors.length === handlers.length) kept.push(entry);
      else if (survivors.length > 0) kept.push({ ...entry, hooks: survivors });
      // survivors.length === 0 and something was ours: the entry was ours; drop it.
    }
    if (kept.length > 0) hooks[eventName] = kept;
  }
  if (Object.keys(hooks).length > 0) next.hooks = hooks;
  else delete next.hooks;

  const currentCommand = typeof settings.statusLine?.command === "string" ? settings.statusLine.command : null;
  const removedStatusLine = currentCommand === STATUSLINE_COMMAND;
  if (removedStatusLine) delete next.statusLine;

  return { settings: next as ClaudeSettings, removedHooks, removedStatusLine };
}

function hasCommand(entry: HookEntry, command: string): boolean {
  return Array.isArray(entry?.hooks) && entry.hooks.some((handler) => handler?.command === command);
}
