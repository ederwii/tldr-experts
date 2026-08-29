/**
 * What the seed does NOT say — the What stage's Unknowns.
 *
 * Deterministic by construction: the What stage declares four content outputs
 * (`intent.md`, `scope.md`, `success-metrics.md`, `open-questions.md`), each has a
 * fixed set of heading words, and an output is UNCOVERED when no heading anywhere
 * in the seed matches its pattern. No model decides this and no prose is read —
 * only headings, only these regexes.
 *
 * `[assumption]` — the patterns. They are deliberately broad (a "Goals" heading
 * counts as intent, "Non-goals" as scope) because a false "covered" merely means
 * the stage is not reminded, while a false "uncovered" adds one honest question.
 */
import type { SeedHeading } from "./seedClaims.ts";

export interface ExpectedSection {
  /** Declared output of the What stage, without its phase folder. */
  readonly output: string;
  readonly label: string;
  readonly pattern: RegExp;
}

export const EXPECTED_SECTIONS: readonly ExpectedSection[] = [
  {
    output: "intent.md",
    label: "intent",
    pattern: /\b(intent|purpose|why|problem|background|overview|summary|goal|goals|objective|objectives)\b/i,
  },
  {
    output: "scope.md",
    label: "scope",
    // `requirements` is deliberately absent: a document TITLED "requirements" says
    // nothing about where its scope boundary is.
    pattern: /\b(scope|in[- ]scope|out[- ]of[- ]scope|non[- ]goals?|boundary|boundaries|must[- ]have|should[- ]have|deliverables?|features?)\b/i,
  },
  {
    output: "success-metrics.md",
    label: "success metrics",
    pattern: /\b(success|metrics?|kpis?|measure[ds]?|measurement|acceptance|done)\b/i,
  },
  {
    output: "open-questions.md",
    label: "open questions",
    pattern: /\b(open[- ]questions?|questions?|unknowns?|tbd|undecided|risks?|assumptions?)\b/i,
  },
];

/** The expected sections no seed heading matches, in declaration order. */
export function uncoveredSections(headings: readonly SeedHeading[]): readonly ExpectedSection[] {
  return EXPECTED_SECTIONS.filter((section) =>
    !headings.some((heading) => section.pattern.test(heading.text)));
}

/** The first heading that covers a section, for the Findings ledger. */
export function coveringHeading(
  section: ExpectedSection,
  headings: readonly SeedHeading[],
): SeedHeading | null {
  return headings.find((heading) => section.pattern.test(heading.text)) ?? null;
}
