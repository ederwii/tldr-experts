/**
 * Does a citation SUSTAIN the bullet it is attached to, or does it merely resolve?
 *
 * Wave M made every `src` resolvable: a `file` src names a file that exists with
 * the line in range, a `cmd` src names a command `workspace.yml` declares. That is
 * a check on the CITATION. It says nothing about the CLAIM, and the two came apart
 * in the first real corpus this framework produced.
 *
 * Measured 2026-08-29 on `~/aparece-v2/.tldrx/experts/aparece-api/knowledge/aparece-api.md`,
 * written by a real training run: its header asserts
 *
 *     `dotnet build` exit 0, 0 warnings, 0 errors — measured, exit code captured
 *     unpiped [src: aparece-v2:.tldrx/workspace.yml:19]
 *
 * and line 19 of that workspace.yml is `build: dotnet build` — the DECLARATION of
 * the command, not a result of running it. The same header claims "78/78 passed,
 * exit 0" against `scripts/test.sh:105`, a line of the script. Both citations
 * resolve. Neither is evidence that anything ran, and `resolveSrc` had no way to
 * tell: it was asked whether the line exists, and it does.
 *
 * So two cheap checks live here, and both are about the relationship between a
 * sentence and its source rather than about the source alone:
 *
 *   1. **Execution claims need a `cmd` src.** "exit 0", "78/78 passed", "build is
 *      green", a bare "measured" — those assert that something was RUN. §2.8 has
 *      exactly one production for that (`$ <cmd> → exit <n>`), and a `file` line
 *      under such a claim is refused.
 *   2. **A verbatim restatement is not a finding.** A bullet that is ≥90% a
 *      substring of the neighbourhood of the line it cites has told the reader
 *      what the line already says. That is a warning, not a refusal — it is not
 *      dishonest, it is just worth nothing, so it earns no evidence row.
 *
 * Both operate on the bullet's CLAIM TEXT: the bullet with its `[src: …]` token
 * and its `(measured)` / `(inferred)` / `(assumed)` annotations removed.
 *
 * `[assumption]` — stripping the confidence annotation before matching is what
 * keeps rule 1 usable. §2.3's own prompt rules ask every bullet to say which of
 * *measured* / *inferred* / *assumed* it is, and the real corpus does exactly that
 * on nearly every line; a `measured` pattern applied to the raw bullet would refuse
 * the whole file for obeying the instruction. Inside the annotation the word is a
 * LABEL; outside it, in the sentence itself, it is a claim about a command.
 */
import { existsSync, readFileSync } from "node:fs";

/** How many lines either side of a cited line count as its neighbourhood. */
export const NEIGHBOURHOOD_RADIUS = 3;
/** A normalised claim shorter than this is too generic to call a paraphrase. */
export const MIN_PARAPHRASE_CHARS = 40;
/** How much of the claim must appear verbatim in the neighbourhood. */
export const PARAPHRASE_RATIO = 0.9;

/**
 * A parenthesised confidence annotation, in either spelling the real corpus uses:
 * `(measured)` and `(measured: the two AddSingleton calls precede the builder)`.
 */
const CONFIDENCE_ANY_RE = /\((?:measured|inferred|assumed)\b[^)]*\)/gi;
const CONFIDENCE_TRAILING_RE = /\((measured|inferred|assumed)\b[^)]*\)\s*$/i;

export const CONFIDENCE_VALUES = ["measured", "inferred", "assumed"] as const;
export type Confidence = (typeof CONFIDENCE_VALUES)[number];

export function isConfidence(value: string): value is Confidence {
  return (CONFIDENCE_VALUES as readonly string[]).includes(value);
}

/**
 * The patterns that make a sentence an assertion about an execution.
 *
 * Deliberately few and deliberately literal. A cleverer classifier would be a
 * model, and a model is exactly what must not decide whether a claim needs a
 * measurement — the point of this file is that the rule is checkable.
 */
export const EXECUTION_CLAIM_PATTERNS: readonly RegExp[] = [
  /\bexit \d/i,
  /\b\d+\/\d+ (?:passed|pass)\b/i,
  /\bbuild(?:s|ed)? (?:ok|green|succeeded)\b/i,
  /\bmeasured\b/i,
];

/** The offending phrase, or null when the claim asserts no execution. */
export function executionClaim(claim: string): string | null {
  for (const pattern of EXECUTION_CLAIM_PATTERNS) {
    const match = pattern.exec(claim);
    if (match !== null) return match[0];
  }
  return null;
}

/**
 * The bullet's sentence: no `[src: …]` token, no confidence annotation.
 *
 * `token` is the raw token text as `parseSrcToken` found it, so the same string
 * that was parsed is the string removed — a second regex here would be a second
 * grammar, and the two would drift.
 */
export function claimText(bulletText: string, token: string | null): string {
  const withoutToken = token === null ? bulletText : bulletText.split(token).join(" ");
  return withoutToken.replace(CONFIDENCE_ANY_RE, " ").replace(/\s+/g, " ").trim();
}

/** `(measured)` / `(inferred: …)` immediately before the token, or null. */
export function confidenceOf(bulletText: string, token: string | null): Confidence | null {
  const withoutToken = (token === null ? bulletText : bulletText.split(token).join(" ")).trim();
  const match = CONFIDENCE_TRAILING_RE.exec(withoutToken);
  const word = match?.[1]?.toLowerCase() ?? "";
  return isConfidence(word) ? word : null;
}

/** Lowercase, alphanumerics only, single-spaced — so wrapping and punctuation do not matter. */
export function normaliseClaim(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * `±NEIGHBOURHOOD_RADIUS` lines around `line`, normalised. `""` when the file
 * cannot be read — an unreadable file is not evidence of a paraphrase.
 */
export function neighbourhood(abs: string, line: number, radius = NEIGHBOURHOOD_RADIUS): string {
  if (!existsSync(abs)) return "";
  let lines: string[];
  try {
    lines = readFileSync(abs, "utf8").split("\n");
  } catch {
    return "";
  }
  const from = Math.max(0, line - 1 - radius);
  const to = Math.min(lines.length, line + radius);
  return normaliseClaim(lines.slice(from, to).join(" "));
}

/**
 * Is `claim` ≥ `PARAPHRASE_RATIO` a verbatim substring of `haystack`?
 *
 * Cheap on purpose: slide a window of the required length over the normalised
 * claim and ask the haystack whether it contains it. At most `10%` of the claim's
 * length window positions, over a haystack of seven lines — a few microseconds,
 * and no similarity metric anybody has to trust.
 */
export function isParaphrase(claim: string, haystack: string, ratio = PARAPHRASE_RATIO): boolean {
  const needle = normaliseClaim(claim);
  if (needle.length < MIN_PARAPHRASE_CHARS || haystack === "") return false;
  const width = Math.ceil(needle.length * ratio);
  if (width > needle.length) return false;
  for (let start = 0; start + width <= needle.length; start++) {
    if (haystack.includes(needle.slice(start, start + width))) return true;
  }
  return false;
}
