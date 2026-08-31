/**
 * How `tldrx status` prints, in three shapes for three readers.
 *
 *   renderWorkspaceStatus  a human at a terminal
 *   workspaceStatusJson    the `/tldrx` skill, which walks `items` in order
 *   sessionStartLines      the SessionStart hook, which gets three lines and no more
 *
 * All three read `items` for the BLOCKERS. `advice` is rendered under them by the
 * terminal view and carried beside them in the JSON; the SessionStart hook drops
 * it entirely, because three lines of ambient context is no place for a nudge.
 *
 * One shape per reader, all three built from the same `PendingItem[]`, so the
 * skill can never be guided through a list the terminal did not show.
 */
import { isPending, type PendingItem, type WorkspaceStatus } from "./PendingItem.ts";

/** The numbered form: `[1] <what is waiting> → <the command that moves it>`. */
export function renderItem(item: PendingItem, index: number): readonly string[] {
  const head = `[${String(index + 1)}] ${item.summary}`;
  const lines = [item.command === "" ? head : `${head} → ${item.command}`];
  // A blank detail line stays blank: a decision card separates its questions with
  // one, and four spaces of trailing whitespace is not an indent, it is lint.
  for (const detail of item.details) lines.push(detail === "" ? "" : `    ${detail}`);
  return lines;
}

export function renderWorkspaceStatus(status: WorkspaceStatus): string {
  const lines = [`tldrx status · ${status.root}`];
  if (status.pending === 0) {
    lines.push("", status.items[0]?.summary ?? "nothing pending");
    lines.push(...renderAdvice(status));
    return lines.join("\n");
  }
  lines.push(`${String(status.pending)} thing(s) waiting on you, in the order they block each other`);
  status.items.forEach((item, index) => {
    lines.push("", ...renderItem(item, index));
  });
  lines.push(...renderAdvice(status));
  lines.push("", "Walk them one at a time: `/tldrx` in Claude Code, or run the command on the item you want.");
  return lines.join("\n");
}

/**
 * The advice block: unnumbered, and headed `Also:` rather than `[n]`, because a
 * number in the same sequence as the blockers is a claim that it is one.
 */
function renderAdvice(status: WorkspaceStatus): readonly string[] {
  const lines: string[] = [];
  for (const item of status.advice) {
    lines.push("", item.command === "" ? `Also: ${item.summary}` : `Also: ${item.summary} → ${item.command}`);
    for (const detail of item.details) lines.push(`    ${detail}`);
  }
  return lines;
}

/**
 * `items` keeps exactly the shape it has always had, so a consumer that walks it
 * is unaffected; `advice` is added beside it. A reader that ignores the new key
 * sees blockers only, which is the correct list to be walked through.
 */
export function workspaceStatusJson(status: WorkspaceStatus): string {
  return JSON.stringify(
    {
      root: status.root,
      pending: status.pending,
      items: status.items.map(jsonItem),
      advice: status.advice.map(jsonItem),
    },
    null,
    2,
  );
}

function jsonItem(item: PendingItem): Record<string, unknown> {
  return { kind: item.kind, summary: item.summary, command: item.command, details: item.details };
}

/**
 * The SessionStart form (spec §4): a headline plus as many items as fit.
 *
 * Ambient context, not a report — someone opening a session gets told there IS
 * work and where to see it, and reads the rest with `tldrx status` or `/tldrx`.
 * Nothing is emitted when nothing is pending: a hook that speaks when it has
 * nothing to say is the thing §3's "non-intrusive" requirement rules out.
 */
export function sessionStartLines(status: WorkspaceStatus, max: number): readonly string[] {
  const pending = status.items.filter(isPending);
  if (pending.length === 0 || max <= 0) return [];
  const lines = [
    `tldrx: ${String(pending.length)} pending — \`tldrx status\` for all of it, or \`/tldrx\` to be walked through it`,
  ];
  for (const item of pending) {
    if (lines.length >= max) break;
    lines.push(`tldrx:   [${String(lines.length)}] ${item.summary}`);
  }
  return lines;
}
