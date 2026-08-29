/**
 * Line numbers for citations.
 *
 * A `[src: path:line]` token is only worth something if the line actually says
 * what the bullet claims, so every citation is resolved to the line that
 * contains the evidence — never to a guessed or constant line number.
 */

/** 1-based line of the first line containing `needle`, or 1 when it is absent. */
export function lineOf(text: string, needle: string): number {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line !== undefined && line.includes(needle)) return i + 1;
  }
  return 1;
}

export function countLines(text: string): number {
  if (text === "") return 0;
  const lines = text.split("\n");
  const last = lines[lines.length - 1];
  return last === "" ? lines.length - 1 : lines.length;
}
