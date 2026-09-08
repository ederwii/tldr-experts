/**
 * Reading `notify:` out of `.tldrx/workspace.yml`.
 *
 * Deliberately TOLERANT in one direction only. A workspace with no such key — which is
 * every workspace written before this existed — reads as `null` and the loop notifies
 * nothing; that is the whole compatibility story for a `version: 1` file that only grows.
 * A workspace whose block is MALFORMED also reads as `null`, because the alternative is
 * spawning something the schema would have refused. `tldrx doctor` and every command that
 * validates the file are where a bad block is reported; this reader's job is to be unable
 * to produce a hook the validator would reject, which is why it calls the validator's own
 * `notifyIssues` rather than re-deciding what a good block looks like.
 *
 * It reads the file synchronously and swallows every read error for the same reason:
 * a notification is never a reason to fail a run.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseYaml } from "../yaml.ts";
import { PROJECT_WORKSPACE_FILE } from "../paths.ts";
import { notifyIssues } from "../schemas/workspace.ts";
import { NOTIFY_KINDS, type NotifyKind } from "./payload.ts";

/** The default ceiling on ONE invocation. A notifier is a message, not a job. */
export const NOTIFY_TIMEOUT_MS = 30_000;

export interface NotifyDeclaration {
  /** Verbatim, as the file spells it — the string an event records and a refusal quotes. */
  readonly command: string;
  /** Resolved: the file's `events:`, or every kind when it declared none. */
  readonly events: readonly NotifyKind[];
  readonly timeoutMs: number;
}

/** The workspace's declared notifier, or null when it declares none (or a broken one). */
export function readNotifyDeclaration(root: string): NotifyDeclaration | null {
  const path = join(root, PROJECT_WORKSPACE_FILE);
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const block = (parsed as Record<string, unknown>).notify;
  if (block === undefined) return null;
  if (notifyIssues(block, "notify").length > 0) return null;

  const record = block as Record<string, unknown>;
  const declared = record.events;
  const events = Array.isArray(declared) ? (declared as NotifyKind[]) : [...NOTIFY_KINDS];
  const seconds = typeof record.timeout_s === "number" ? record.timeout_s : null;
  return {
    command: String(record.command),
    events,
    timeoutMs: seconds === null ? NOTIFY_TIMEOUT_MS : Math.round(seconds * 1000),
  };
}
