/**
 * The `seed:` src grammar — TRIAGE OUTPUT ONLY (spec §6.2).
 *
 *   seedsrc := "seed:" rel ("#" heading | ":" line)
 *
 * Deliberately its own tiny grammar and NOT part of §2.8. A `[src: …]` token in a
 * handoff is checked by the `claim-sources` hook against files that exist inside
 * the run; a triage proposal is a claim about documents the run does not have
 * yet, made before any run exists. Widening §2.8 to cover that would loosen the
 * one check that keeps handoffs honest, so this stays a separate, narrower thing
 * that only `split.yml` ever uses.
 *
 * What it buys: every "why this run exists" line in a proposal points at a
 * heading or a line of a real seed document, so a human rejecting a proposed run
 * can open the sentence that produced it.
 */

export type SeedSrc =
  | { readonly kind: "heading"; readonly raw: string; readonly rel: string; readonly heading: string }
  | { readonly kind: "line"; readonly raw: string; readonly rel: string; readonly line: number };

const PREFIX = "seed:";
const LINE_SUFFIX_RE = /^(.+):(\d{1,9})$/;

/** Parse one `seed:…` src, or explain in one line why it is not one. */
export function parseSeedSrc(raw: string): SeedSrc | { readonly error: string } {
  if (!raw.startsWith(PREFIX)) {
    return { error: `'${raw}' does not start with \`seed:\`` };
  }
  const body = raw.slice(PREFIX.length);
  if (body === "") return { error: `'${raw}' names no document` };

  // `#` wins over `:` — a heading may contain a colon ("Goal: ship it"), and a
  // rel path may not, so splitting on the last `#` first is unambiguous.
  const hash = body.lastIndexOf("#");
  if (hash > 0) {
    const rel = body.slice(0, hash);
    const heading = body.slice(hash + 1).trim();
    if (heading === "") return { error: `'${raw}' has an empty heading after '#'` };
    return { kind: "heading", raw, rel, heading };
  }

  const match = LINE_SUFFIX_RE.exec(body);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    return { error: `'${raw}' is neither \`seed:<rel>#<heading>\` nor \`seed:<rel>:<line>\`` };
  }
  const line = Number(match[2]);
  if (!Number.isInteger(line) || line < 1) return { error: `'${raw}' has a line number below 1` };
  return { kind: "line", raw, rel: match[1], line };
}

export function isSeedSrc(raw: string): boolean {
  return !("error" in parseSeedSrc(raw));
}
