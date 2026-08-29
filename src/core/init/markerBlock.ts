/**
 * Idempotent marked blocks in files the framework does not own.
 *
 * `.gitignore` and `CLAUDE.md` belong to the project, so `init` writes exactly
 * one fenced block into each and replaces it on every re-run. Running init five
 * times must leave the file identical to running it once.
 */

export interface BlockMarkers {
  readonly begin: string;
  readonly end: string;
}

export const GITIGNORE_MARKERS: BlockMarkers = { begin: "# >>> tldrx >>>", end: "# <<< tldrx <<<" };
/** Markdown comment form, so the pointer block does not render in CLAUDE.md. `[assumption]` */
export const MARKDOWN_MARKERS: BlockMarkers = { begin: "<!-- >>> tldrx >>> -->", end: "<!-- <<< tldrx <<< -->" };

/** Replace the marked block, or append it when absent. Returns the whole file. */
export function upsertBlock(existing: string, body: string, markers: BlockMarkers): string {
  const block = `${markers.begin}\n${body.trimEnd()}\n${markers.end}\n`;
  const start = existing.indexOf(markers.begin);
  const end = existing.indexOf(markers.end);

  if (start !== -1 && end > start) {
    const before = existing.slice(0, start);
    const after = existing.slice(end + markers.end.length).replace(/^\n/, "");
    return `${before}${block}${after}`;
  }
  const separator = existing === "" || existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  return `${existing}${separator}${block}`;
}
