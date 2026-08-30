/**
 * One line, rewritten in place: spinner, elapsed, what it is doing, what it cost.
 *
 * This is what a short terminal gets, and what anyone gets who would rather have
 * their scrollback than a picture. Same state, same summaries, one row.
 */
import type { UiSnapshot } from "./state.ts";
import { clockFace } from "./summary.ts";

/** Braille dots. Ten frames at 4 fps is a two-and-a-half second cycle. */
export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export function renderCompact(state: UiSnapshot, cols: number, tick: number): string {
  const mark = state.failed ? "✗" : state.finished ? "✓" : SPINNER[tick % SPINNER.length] ?? "-";
  const money = state.ceilingUsd > 0
    ? `$${state.spentUsd.toFixed(2)}/$${state.ceilingUsd.toFixed(2)}`
    : `$${state.spentUsd.toFixed(2)}`;
  const head = `${mark} ${clockFace(state.elapsedMs)} `;
  const tail = ` · ${money}`;
  const room = Math.max(8, cols - head.length - tail.length - 1);
  const activity = state.activity.length <= room
    ? state.activity
    : `${state.activity.slice(0, Math.max(1, room - 1))}…`;
  return `${head}${activity}${tail}`;
}
