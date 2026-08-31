/**
 * The schoolhouse: the banner `tldrx init` paints before it starts working.
 *
 * The rest of the progress view is a CLASSROOM — a blackboard, a student, a
 * teacher (`scene.ts`). `init` runs before any of that exists: it is the survey
 * that decides where the school goes. So the banner is the building seen from
 * outside, drawn in the same hand as the figures inside it (`.-.`, `'---'`,
 * `|`, `/`, `\` — no box-drawing characters, nothing a 1990s terminal cannot
 * print).
 *
 * Like everything else in this folder it is a PURE function of its input: no
 * timer, no terminal, no process. The palette is passed in, so the same call
 * renders the coloured banner and the byte-identical uncoloured one.
 */
import type { Palette } from "./color.ts";

/** The bell above the roof, the roof, and the two-window schoolhouse. */
const HOUSE: readonly string[] = [
  "       .-.       ",
  "      ( ^ )      ",
  "       '-'       ",
  "    .-------.    ",
  "   /_________\\   ",
  "   | .-. .-. |   ",
  "   | |_| |_| |   ",
  "   |___[+]___|   ",
];

/** Where the caption column starts. Wider than the house, so nothing collides. */
const CAPTION_COL = 19;

export interface CampusInput {
  /** The workspace root being surveyed, already shortened for display. */
  readonly root: string;
  readonly palette: Palette;
  /** Terminal width; captions are clipped to it. */
  readonly cols: number;
}

/**
 * The banner, one string per row. Painted once, at the top, with the live step
 * lines flowing beneath it.
 */
export function renderCampus(input: CampusInput): readonly string[] {
  const ink = input.palette;
  const captions: readonly (string | null)[] = [
    null,
    ink.bold(ink.magenta("t l d r x   i n i t")),
    null,
    ink.dim("surveying the campus before the school opens"),
    null,
    ink.gray(clip(input.root, Math.max(8, input.cols - CAPTION_COL - 1))),
    null,
    null,
  ];

  return HOUSE.map((row, index) => {
    const caption = captions[index] ?? null;
    const drawn = paintHouseRow(row, index, ink);
    if (caption === null) return drawn.trimEnd();
    return `${drawn}${" ".repeat(Math.max(1, CAPTION_COL - row.length))}${caption}`;
  });
}

/**
 * Colour by PART, not by row: the bell is the thing that rings, the windows are
 * the things that light up, and the door is the way in. Three inks on a
 * seventeen-column drawing is decoration; four would be a christmas tree.
 */
function paintHouseRow(row: string, index: number, ink: Palette): string {
  if (index <= 2) return ink.yellow(row);
  if (index === 3 || index === 4) return ink.cyan(row);
  if (index === 7) return row.replace("[+]", ink.magenta("[+]"));
  return row.replace(/\.-\.|\|_\|/g, (window) => ink.blue(window));
}

function clip(text: string, width: number): string {
  return text.length <= width ? text : `…${text.slice(text.length - width + 1)}`;
}
