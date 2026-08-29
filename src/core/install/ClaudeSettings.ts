/**
 * Reading and writing `.claude/settings.json` without owning it.
 *
 * The file belongs to the user: it may hold `permissions`, `env`, `model`, and
 * anything a future Claude Code adds. `tldrx install --claude` merges into it, so
 * everything here is built around one rule — **a key we did not write is a key we
 * do not touch**, and the bytes around ours change as little as JSON allows.
 *
 * "As little as JSON allows" is the honest limit. Comments and trailing commas are
 * not JSON, key order beyond insertion order is not preserved by any parser, and
 * the indent has to be re-chosen on the way out. So the indent and the trailing
 * newline are *detected* from the file that is there and reproduced, which makes
 * install → uninstall byte-for-byte reversible for any file that was itself written
 * as `JSON.stringify(value, null, <indent>)`. A hand-formatted file survives
 * semantically, not byte-for-byte — which is why a backup is taken before the
 * first write.
 *
 * Shapes verified from https://code.claude.com/docs/en/hooks (settings `hooks` map)
 * and https://code.claude.com/docs/en/statusline (the `statusLine` key), 2026-08-28.
 */

/** One `{type: "command", command, timeout?}` handler inside a hook entry. */
export interface HookHandler {
  readonly type: string;
  readonly command: string;
  readonly timeout?: number;
  /** Anything Claude Code accepts that we neither read nor rewrite. */
  readonly [key: string]: unknown;
}

/** One `{matcher?, hooks: [...]}` entry inside an event's array. */
export interface HookEntry {
  readonly matcher?: string;
  readonly hooks: readonly HookHandler[];
  readonly [key: string]: unknown;
}

export interface StatusLine {
  readonly type?: string;
  readonly command?: string;
  readonly [key: string]: unknown;
}

/** The subset of settings this command knows about. Everything else rides along. */
export interface ClaudeSettings {
  readonly hooks?: Readonly<Record<string, readonly HookEntry[]>>;
  readonly statusLine?: StatusLine;
  readonly [key: string]: unknown;
}

/** How the file on disk was laid out, so a rewrite reproduces it. */
export interface SettingsFormat {
  /** Spaces per level, or a literal tab. Two spaces when there is nothing to copy. */
  readonly indent: number | string;
  readonly trailingNewline: boolean;
}

export const DEFAULT_FORMAT: SettingsFormat = { indent: 2, trailingNewline: true };

export class SettingsError extends Error {}

export interface LoadedSettings {
  readonly settings: ClaudeSettings;
  readonly format: SettingsFormat;
  /** The exact bytes read, or null when the file did not exist. */
  readonly text: string | null;
}

/** Parse `text`, or start from `{}` when the file is absent (`text === null`). */
export function parseSettings(text: string | null, path: string): LoadedSettings {
  if (text === null) return { settings: {}, format: DEFAULT_FORMAT, text: null };
  if (text.trim() === "") return { settings: {}, format: DEFAULT_FORMAT, text };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new SettingsError(
      `${path} is not valid JSON (${error instanceof Error ? error.message : String(error)})`
      + " — fix it or move it aside; refusing to overwrite a file I cannot read",
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SettingsError(`${path} is not a JSON object — refusing to replace it`);
  }
  return { settings: parsed as ClaudeSettings, format: detectFormat(text), text };
}

/** The indent of the first indented line, and whether the file ended in a newline. */
export function detectFormat(text: string): SettingsFormat {
  const match = /\n([ \t]+)\S/.exec(text);
  const lead = match?.[1];
  const indent = lead === undefined ? 2 : lead.startsWith("\t") ? "\t" : lead.length;
  return { indent, trailingNewline: text.endsWith("\n") };
}

export function serializeSettings(settings: ClaudeSettings, format: SettingsFormat): string {
  const body = JSON.stringify(settings, null, format.indent);
  return format.trailingNewline ? `${body}\n` : body;
}

/** Every hook handler in the file, flattened, for counting and for dedupe. */
export function handlersOf(settings: ClaudeSettings): readonly HookHandler[] {
  const out: HookHandler[] = [];
  for (const entries of Object.values(settings.hooks ?? {})) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!Array.isArray(entry?.hooks)) continue;
      for (const handler of entry.hooks) if (handler !== null && typeof handler === "object") out.push(handler);
    }
  }
  return out;
}
