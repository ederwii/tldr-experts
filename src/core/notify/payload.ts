/**
 * The notify payload — one JSON object, `version: 1`, handed to the owner's command
 * on stdin (spec §2.18).
 *
 * A leaf on purpose: it imports nothing, so the schema that validates the DECLARATION
 * (`schemas/workspace.ts`) and the loop that BUILDS a notification
 * (`facilitator/runAuto.ts`) can both reach the kind enum without either of them
 * importing the other. The enum is closed for the same reason `EVENT_TYPES` is: an
 * owner's script switches on `kind`, and a kind that arrives from nowhere is a branch
 * nobody wrote.
 *
 * ## Why the payload, and not an argument
 *
 * The command is run as argv, never through a shell, and the payload never touches the
 * command line. That is not caution about quoting — it is the same rule §2.1 puts on
 * every declared command: nothing the framework assembles may become shell syntax. A
 * question title carrying a backtick is a string on stdin here; concatenated into a
 * command it would be a subshell.
 *
 * ## Why `command`
 *
 * Every kind that a person can DO something about carries the exact line to type, at the
 * top level, already spelled with the run id. The measured failure this exists to stop
 * (gh #59) was never that the owner lacked information — it was that acting on it meant
 * reconstructing a command from a screen he was not looking at.
 */

/** `version:` on every payload. Additive from here: fields grow, meanings do not change. */
export const NOTIFY_PAYLOAD_VERSION = 1;

/**
 * The moments a run can tell somebody about. Closed set.
 *
 * `status` is the only one that is not an event — it is the periodic heartbeat
 * `--notify-every` asks for, and it carries what `tldrx run status` prints.
 * `question.timeout` fires only under `--wait-answers`, at the moment the wait lapses
 * and the loop goes back to exiting 4.
 */
export const NOTIFY_KINDS = [
  "question.raised",
  "question.timeout",
  "gate.requested",
  "stage.done",
  "run.finished",
  "run.failed",
  "budget.warned",
  "status",
] as const;
export type NotifyKind = (typeof NOTIFY_KINDS)[number];

export interface NotifyPayload {
  readonly version: number;
  readonly kind: NotifyKind;
  /** RFC3339, the instant the loop built this notification. */
  readonly at: string;
  readonly run: string;
  /** Absolute workspace root — an owner's script is not otherwise told where it ran. */
  readonly root: string;
  /** `<phase>/<stage>`, or null when the notification is about the run as a whole. */
  readonly stage: string | null;
  /** One paragraph a person can read on a phone without opening anything. */
  readonly summary: string;
  /**
   * The exact command to type, or null when there is nothing to do.
   *
   * Null is a real answer, not a gap: `stage.done` and a clean `run.finished` are
   * reports. An invented "next command" on those would be the framework guessing at an
   * intention, which is the one thing every surface here refuses to do.
   */
  readonly command: string | null;
  /** Kind-specific, documented per kind in spec §2.18. Always an object, never null. */
  readonly detail: Readonly<Record<string, unknown>>;
}

/** The key order every payload is serialized in — stable, so a diff of two is readable. */
export const NOTIFY_PAYLOAD_KEYS = [
  "version", "kind", "at", "run", "root", "stage", "summary", "command", "detail",
] as const;

export function serializeNotification(payload: NotifyPayload): string {
  const ordered: Record<string, unknown> = {};
  for (const key of NOTIFY_PAYLOAD_KEYS) ordered[key] = payload[key];
  return JSON.stringify(ordered);
}

/**
 * The refusal-code FAMILY behind an exit code, in the words `src/cli/exitCodes.ts`
 * gives them (§7 of AGENTS.md, "refusal exit codes have families").
 *
 * A phone notification saying "exit 2" is a number; saying "money — a ceiling refused
 * it" is a decision the owner can make from a bus stop.
 */
export function exitFamily(code: number): string {
  switch (code) {
    case 0: return "ok";
    case 1: return "usage — the command was wrong for this run, or there was nothing behind it";
    case 2: return "refused — a budget ceiling or a gate said no";
    case 3: return "not found";
    case 4: return "awaiting a person";
    case 5: return "a stage failed";
    default: return `unclassified exit ${String(code)}`;
  }
}
