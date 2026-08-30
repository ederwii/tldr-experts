/**
 * The classroom.
 *
 * A blackboard with the last six things the agent did, a wall clock with a hand
 * that goes round, a student seen from behind at a desk who moves while a tool
 * runs, and a teacher who blinks and occasionally says something. It is a
 * progress view: everything on it is derived from the stream, and nothing on it
 * is invented.
 *
 * `render` is a PURE function of `(snapshot, cols, rows, tick)`. No timers, no
 * terminal, no process — the driver supplies the tick and the size, which is why
 * a frame can be snapshot-tested exactly.
 *
 * Every element is clipped to the frame. Below 72×20 the caller falls back to
 * `compact` (see `mode.ts`); this file assumes it was called above that.
 */
import type { UiSnapshot } from "./state.ts";
import { clockFace } from "./summary.ts";

export const MIN_SCENE_COLS = 72;
export const MIN_SCENE_ROWS = 20;

/** Notes shown on the blackboard. The rest of the ring is scrollback. */
export const BOARD_NOTES = 6;

const BOARD_MAX = 48;
const BOARD_MIN = 40;

/**
 * The clock face: a 5-row dial, 13 columns wide, with 12 hand positions.
 *
 * 13 rather than 11 because the hand's ring of twelve cells has to clear the
 * diagonal rim on both sides — at 11 the 2-o'clock and 8-o'clock positions
 * landed against `\\` and `/` and read as a thicker rim, not as a hand.
 */
const DIAL: readonly string[] = [
  "    .---.    ",
  "  /       \\  ",
  " |         | ",
  "  \\       /  ",
  "    '---'    ",
];

/** Hand glyph per hour position, 0 = twelve o'clock, clockwise. */
const HAND = ["|", "\\", "\\", "-", "/", "/", "|", "\\", "\\", "-", "/", "/"] as const;

/** Grid cell (x, y) of the hand for each of the 12 positions. */
const HAND_AT: readonly (readonly [number, number])[] = [
  [6, 1], [7, 1], [8, 1], [8, 2], [8, 3], [7, 3],
  [6, 3], [5, 3], [4, 3], [4, 2], [4, 1], [5, 1],
];

/**
 * The student, seen from behind at a desk: the back of a head, two arms, and a
 * sheet of paper between the hands. Row 3 holds the writing arm and row 4 holds
 * the paper — those two are the only cells that move.
 */
const STUDENT: readonly string[] = [
  "     ,-----.     ",
  "    ( ##### )    ",
  "     '--|--'     ",
  "     /  |  \\     ",
  "  __/  [.]  \\__  ",
  " |_____________| ",
  "   ||       ||   ",
];

/** Column of the writing arm in row 3, and of the pencil mark in row 4. */
const ARM_COL = 11;
const SCRIBBLE_COL = 8;
const ARM_FRAMES = ["\\", "\\", "|", "|"] as const;
const SCRIBBLE_FRAMES = [".", "-", "~", "="] as const;

const TEACHER: readonly string[] = [
  "    .-------.    ",
  "    | o   o |    ",
  "    |   -   |    ",
  "    '---+---'    ",
  "   __/     \\__   ",
  "  |___________|  ",
  "   ||       ||   ",
];

const TEACHER_BLINK = "    | -   - |    ";

export interface Frame {
  readonly cols: number;
  readonly rows: number;
  /** Monotonic frame counter from the driver — 4 per second. */
  readonly tick: number;
}

/** The whole scene, one string per terminal row, none wider than `cols`. */
export function renderScene(state: UiSnapshot, frame: Frame): readonly string[] {
  const cols = Math.max(MIN_SCENE_COLS, frame.cols);
  const boardWidth = Math.min(BOARD_MAX, Math.max(BOARD_MIN, cols - 24));
  const board = blackboard(state, boardWidth);
  const clock = wallClock(state, frame.tick);

  const out: string[] = [];
  const top = Math.max(board.length, clock.length);
  for (let i = 0; i < top; i++) {
    out.push(clip(`${pad(board[i] ?? "", boardWidth)}  ${clock[i] ?? ""}`, cols));
  }
  out.push("");
  for (const line of classroom(state, frame.tick, cols)) out.push(clip(line, cols));
  out.push("");
  out.push(clip(footer(state), cols));
  // Never taller than the terminal: a scene that scrolls is a scene that leaves
  // a trail of half-frames behind it.
  return out.slice(0, Math.max(1, frame.rows));
}

/** The board: a framed title, a rule, and the last six notes. */
export function blackboard(state: UiSnapshot, width: number): readonly string[] {
  const inner = width - 4;
  const notes = state.lines.slice(-BOARD_NOTES);
  const lines = [
    `+${"-".repeat(width - 2)}+`,
    `| ${pad(ellipsis(state.title, inner), inner)} |`,
    `+${"-".repeat(width - 2)}+`,
  ];
  for (let i = 0; i < BOARD_NOTES; i++) {
    const note = notes[notes.length - BOARD_NOTES + i] ?? "";
    lines.push(`| ${pad(ellipsis(note, inner), inner)} |`);
  }
  lines.push(`+${"-".repeat(width - 2)}+`);
  return lines;
}

/** The dial with its hand, and `mm:ss` underneath. */
export function wallClock(state: UiSnapshot, tick: number): readonly string[] {
  // One position per second of the elapsed time, so the hand IS the clock rather
  // than an animation that happens to spin next to one.
  const seconds = Math.floor(state.elapsedMs / 1000);
  const position = ((seconds % 60) / 5) | 0;
  const grid = DIAL.map((row) => [...row]);
  const cell = HAND_AT[position % 12] ?? HAND_AT[0];
  const glyph = HAND[position % 12] ?? "|";
  if (cell !== undefined) {
    const [x, y] = cell;
    const row = grid[y];
    if (row !== undefined && x < row.length) row[x] = glyph;
  }
  const face = grid.map((row) => row.join(""));
  // A tiny blink on the centre pip, so a stopped run still looks alive but a
  // finished one does not: `finished` freezes it.
  const pip = state.finished ? "o" : tick % 8 < 4 ? "o" : "·";
  const middle = grid[2];
  if (middle !== undefined && middle[6] === " ") {
    middle[6] = pip;
    face[2] = middle.join("");
  }
  return [...face, center(clockFace(state.elapsedMs), DIAL[0]?.length ?? 11)];
}

/** Student and teacher side by side, with the teacher's speech line. */
export function classroom(state: UiSnapshot, tick: number, cols: number): readonly string[] {
  const student = STUDENT.map((row, i) => {
    if (!state.busy) return row;
    if (i === 3) return replaceAt(row, ARM_COL, ARM_FRAMES[tick % ARM_FRAMES.length] ?? "\\");
    if (i === 4) return replaceAt(row, SCRIBBLE_COL, SCRIBBLE_FRAMES[tick % SCRIBBLE_FRAMES.length] ?? ".");
    return row;
  });
  // One frame of blink in twenty — a quarter-second every five, at 4 fps.
  const blinking = !state.finished && tick % 20 < 1;
  const teacher = TEACHER.map((row, i) => (i === 1 && blinking ? TEACHER_BLINK : row));

  const gap = 3;
  const width = (STUDENT[0]?.length ?? 17) + gap + (TEACHER[0]?.length ?? 17);
  const speechCol = width + 2;
  const speechRoom = cols - speechCol - 1;
  const speech = state.speech === null || speechRoom < 12
    ? null
    : `( ${ellipsis(state.speech, speechRoom - 4)} )`;

  const rows: string[] = [];
  for (let i = 0; i < Math.max(student.length, teacher.length); i++) {
    let line = `${pad(student[i] ?? "", (STUDENT[0]?.length ?? 17) + gap)}${teacher[i] ?? ""}`;
    if (i === 1 && speech !== null) line = `${pad(line, speechCol)}${speech}`;
    rows.push(line);
  }
  return rows;
}

/** `$0.42 of $6.00 · Ctrl-C stops after this turn`. */
export function footer(state: UiSnapshot): string {
  const spent = `$${state.spentUsd.toFixed(2)}`;
  const money = state.ceilingUsd > 0 ? `${spent} of $${state.ceilingUsd.toFixed(2)}` : `${spent} spent`;
  const hint = state.failed ? "failed" : state.finished ? "done" : "Ctrl-C stops after this turn";
  return `  ${money} · ${hint}`;
}

function replaceAt(row: string, index: number, glyph: string): string {
  if (index < 0 || index >= row.length) return row;
  return `${row.slice(0, index)}${glyph}${row.slice(index + 1)}`;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function center(text: string, width: number): string {
  if (text.length >= width) return text;
  const left = Math.floor((width - text.length) / 2);
  return `${" ".repeat(left)}${text}`;
}

function ellipsis(text: string, width: number): string {
  if (width <= 0) return "";
  return text.length <= width ? text : `${text.slice(0, Math.max(1, width - 1))}…`;
}

function clip(text: string, cols: number): string {
  return text.length <= cols ? text.trimEnd() : text.slice(0, cols).trimEnd();
}
