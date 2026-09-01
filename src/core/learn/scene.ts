/**
 * The chapter card: the small drawing between chapters.
 *
 * Same family and the same hand as `ui/campus.ts` — `.-.`, `'---'`, `|`, `/`,
 * `\`, nothing a 1990s terminal cannot print — because the visual identity is the
 * point: `init` paints the schoolhouse from outside, the agent view paints the
 * classroom inside it, and the tutorial paints the blackboard the lesson is on.
 *
 * Pure, like everything in that folder: palette and width come in, strings come
 * out. It draws only in `scene` mode, and the caller decides that the same way
 * `init` does, so `--ui plain`, `NO_COLOR`, `CI` and a pipe all behave here
 * exactly as they behave there.
 */
import type { Palette } from "../ui/color.ts";

const BOARD_WIDTH = 46;

/**
 * A blackboard with the chapter number chalked on it.
 *
 * `n of total` rather than a bare number: a learner who has just been dropped in
 * at chapter 6 needs to know how much is left, and the frame is the only place
 * that can say so without a sentence.
 */
export function renderChapterCard(input: {
  readonly n: number;
  readonly total: number;
  readonly title: string;
  readonly palette: Palette;
  readonly cols: number;
}): readonly string[] {
  const ink = input.palette;
  const width = Math.min(BOARD_WIDTH, Math.max(24, input.cols - 4));
  const inner = width - 2;
  const counter = `chapter ${String(input.n)} of ${String(input.total)}`;

  return [
    ` ${ink.gray(`.${"-".repeat(inner)}.`)}`,
    ` ${ink.gray("|")}${pad(ink.dim(counter), counter, inner)}${ink.gray("|")}`,
    ` ${ink.gray("|")}${pad(ink.bold(ink.cyan(clip(input.title, inner - 2))), clip(input.title, inner - 2), inner)}${ink.gray("|")}`,
    ` ${ink.gray(`'${"-".repeat(inner)}'`)}`,
    `   ${ink.gray("/ \\")}`,
    "",
  ];
}

/** Centre `painted` in `width` columns, measuring the UNPAINTED text. */
function pad(painted: string, plain: string, width: number): string {
  const room = Math.max(0, width - plain.length);
  const left = Math.floor(room / 2);
  return `${" ".repeat(left)}${painted}${" ".repeat(room - left)}`;
}

function clip(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, Math.max(1, width - 1))}…`;
}

/** The last screen: the school is built, the lesson is over. */
export function renderFinale(ink: Palette): readonly string[] {
  return [
    `   ${ink.yellow(".-.")}`,
    `  ${ink.yellow("( ^ )")}   ${ink.bold("that is the loop.")}`,
    `   ${ink.yellow("'-'")}    ${ink.dim("every command you just ran was the real one.")}`,
    "",
  ];
}
