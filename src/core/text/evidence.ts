/**
 * `.agent/<stage>/evidence.md` — the gate evidence note (design §A.5).
 *
 * An `agent` gate is a gate a sub-agent may close, and the only thing that makes
 * that different from a machine signing its own homework is this file: a
 * structured record of what was read, which citations were spot-checked, which
 * touched paths were audited, and what the verdict is. Front matter is the
 * machine half — what `replay` and `run status` read; the body is the human half.
 * That split is the §2.13 story pattern, reused rather than reinvented.
 *
 * **Every list item in the four required sections carries a `[src: …]` token, and
 * the token must resolve.** Not a second grammar and not a second checker: the
 * §2.8 tokenizer (`srcToken.ts`) and the §2.8 section rule (`handoff.ts`'s
 * `validateSections`) are the ones that run. A checklist whose own claims are
 * unsourced is precisely what `claim-sources` exists to refuse, and an evidence
 * note is a claim about a claim.
 *
 * **`unverified` refuses here, unlike in a handoff.** A citation nothing could
 * check does not fail a stage (spec §2.8) but it is exactly what stops an AUTO
 * gate closing (spec §5, condition 5). An agent gate is strictly stronger than an
 * auto gate, never a cheaper one, so a `doc:` URL nothing in the workspace names
 * cannot be the evidence a signature rests on.
 *
 * This module parses and judges. It signs nothing, writes nothing into the run
 * tree, and knows nothing about gate policy — `approve --as-agent` is the one
 * verb, and it calls `validateEvidence` before it records anything.
 */
import { parseFrontMatter } from "../schemas/frontMatter.ts";
import {
  missingSections, parseHandoff, validateSections, type Handoff,
} from "./handoff.ts";
import type { SrcContext } from "./srcToken.ts";

/** The only schema version there is. A note that claims another is not this file. */
export const EVIDENCE_VERSION = 1;

/** The file an agent writes, beside `prompt.md` in the stage's scratch dir. */
export const EVIDENCE_FILE = "evidence.md";

/**
 * Three, not two (design §10). A reviewer can meet every acceptance criterion and
 * still have found three real defects nobody wrote a criterion for; binary
 * SIGN/REFUSE has nowhere to put those. Only `sign` closes an agent gate — the
 * other two are the gate falling to a person, by design.
 */
export const EVIDENCE_VERDICTS = ["sign", "sign-with-fixlist", "refuse"] as const;
export type EvidenceVerdict = (typeof EVIDENCE_VERDICTS)[number];

/**
 * The one role an evidence note is written in. `by:` says WHO; `role:` says what
 * kind of signature it is, so a reader tells a person, the facilitator
 * (`by: auto`) and an agent apart with one field each.
 */
export const EVIDENCE_ROLES = ["agent"] as const;
export type EvidenceRole = (typeof EVIDENCE_ROLES)[number];

/** `n-a` outside the Build phase, where there is no story set to diff against. */
export const DIFF_VS_STORIES = ["matches", "diverges", "n-a"] as const;
export type DiffVsStories = (typeof DIFF_VS_STORIES)[number];

/** The four H2 sections, in this order, each with at least one list item. */
export const EVIDENCE_SECTIONS = ["Read", "Citations checked", "Touches audited", "Verdict"] as const;

/** Required front-matter keys (design §A.5). `caveats` and `recommend` default to `[]`. */
export const REQUIRED_EVIDENCE_KEYS = [
  "version", "gate", "role", "by", "at", "verdict", "read", "citations", "touches", "diff_vs_stories",
] as const;

export interface EvidenceCitations {
  /** How many of the run's citations this reviewer actually re-checked. */
  readonly sampled: number;
  /** How many there were. */
  readonly of: number;
  readonly resolved: number;
  readonly refuted: number;
}

export interface EvidenceTouches {
  readonly audited: number;
  readonly outside_surface: number;
  readonly new_areas: readonly string[];
}

/** A decision card's recommendation (design §F.3). Optional, and never invented. */
export interface EvidenceRecommendation {
  readonly q: string;
  readonly option: string;
  readonly why: string;
  readonly src: string;
}

export interface EvidenceFront {
  readonly version: number;
  /** `<phase>/<stage>` — the gate this note is evidence for. */
  readonly gate: string;
  readonly role: EvidenceRole;
  readonly by: string;
  readonly at: string;
  readonly verdict: EvidenceVerdict;
  readonly read: readonly string[];
  readonly citations: EvidenceCitations;
  readonly touches: EvidenceTouches;
  readonly diff_vs_stories: DiffVsStories;
  readonly caveats: readonly string[];
  readonly recommend: readonly EvidenceRecommendation[];
}

export interface EvidenceNote {
  /** The front matter, or null when it is absent, empty or unreadable. */
  readonly front: EvidenceFront | null;
  /** Why `front` is null, or what is wrong with the keys inside it. */
  readonly frontIssues: readonly EvidenceIssue[];
  /** The body's H2 sections, parsed by the §2.8 reader. */
  readonly body: Handoff;
  /** 1-based line of the file the body starts on — every body line is offset by it. */
  readonly bodyLine: number;
}

/**
 * One kind per refusal in design §A.5's table, so a caller can route on the
 * REASON rather than on a string. `verdict` is the one that means "a person
 * decides" (exit 4 at `next`) rather than "this note is broken" (exit 2 at
 * `approve --as-agent`); everything else is the note being wrong.
 */
export type EvidenceIssueKind =
  | "front-matter"
  | "section"
  | "citation"
  | "arithmetic"
  | "sampling"
  | "verdict"
  | "gate";

export interface EvidenceIssue {
  readonly kind: EvidenceIssueKind;
  /** 1-based line in the whole file; 0 when the problem is the file itself. */
  readonly line: number;
  readonly message: string;
}

export interface EvidenceValidation {
  /** True only when nothing at all is wrong — including the verdict being `sign`. */
  readonly ok: boolean;
  readonly issues: readonly EvidenceIssue[];
  readonly front: EvidenceFront | null;
  /**
   * The `citation` issues that came from a well-formed source nothing could CHECK.
   * They are in `issues` too — an evidence note refuses over them, unlike a
   * handoff — and are listed separately because the operator's fix is different.
   */
  readonly unverified: readonly EvidenceIssue[];
  readonly bulletCount: number;
}

/** What the note must be evidence FOR. Without it, a pasted note cannot be caught. */
export interface EvidenceExpectation {
  /** `<phase>/<stage>` at the cursor, e.g. `03-plan/plan`. */
  readonly gate: string;
}

// --- parsing -----------------------------------------------------------------

/**
 * Split the note into its two halves and read each with the parser that already
 * owns it: `parseFrontMatter` (§2.13) for the YAML, `parseHandoff` (§2.8) for the
 * H2 sections. Never throws — an unreadable half is an issue, not an exception.
 */
export function parseEvidence(text: string): EvidenceNote {
  const parsed = parseFrontMatter(text);
  const body = parseHandoff(parsed.frontMatter.body);
  const bodyLine = parsed.frontMatter.bodyLine;
  if (parsed.doc === null) {
    return {
      front: null,
      frontIssues: [front(0, parsed.issue?.message ?? "front matter could not be read")],
      body,
      bodyLine,
    };
  }
  if (!isRecord(parsed.doc)) {
    return {
      front: null,
      frontIssues: [front(0, "front matter is empty — it must be a mapping of the keys design §A.5 names")],
      body,
      bodyLine,
    };
  }
  const issues: EvidenceIssue[] = [];
  const doc = parsed.doc;
  for (const key of REQUIRED_EVIDENCE_KEYS) {
    if (!(key in doc) || doc[key] === undefined) {
      issues.push(front(0, `front matter is missing required key \`${key}\``));
    }
  }

  const version = doc.version;
  if (version !== undefined && version !== EVIDENCE_VERSION) {
    issues.push(front(0, `\`version\` must be ${String(EVIDENCE_VERSION)}, got ${describe(version)}`));
  }
  const gate = requireText(doc.gate, "gate", issues);
  const role = requireEnum(doc.role, EVIDENCE_ROLES, "role", issues);
  const by = requireText(doc.by, "by", issues);
  const at = requireText(doc.at, "at", issues);
  const verdict = requireEnum(doc.verdict, EVIDENCE_VERDICTS, "verdict", issues);
  const read = requireStrings(doc.read, "read", issues);
  const citations = requireCitations(doc.citations, issues);
  const touches = requireTouches(doc.touches, issues);
  const diff = requireEnum(doc.diff_vs_stories, DIFF_VS_STORIES, "diff_vs_stories", issues);
  const caveats = doc.caveats === undefined ? [] : requireStrings(doc.caveats, "caveats", issues);
  const recommend = requireRecommendations(doc.recommend, issues);

  if (issues.length > 0) return { front: null, frontIssues: issues, body, bodyLine };
  return {
    front: {
      version: EVIDENCE_VERSION,
      gate, role, by, at, verdict, read, citations, touches,
      diff_vs_stories: diff,
      caveats, recommend,
    },
    frontIssues: [],
    body,
    bodyLine,
  };
}

// --- validation --------------------------------------------------------------

/**
 * The whole of design §A.5's refusal table, in one call — the function
 * `approve --as-agent` runs before it records anything, and the one an agent gate
 * consults before it closes.
 *
 * Every problem is reported, never just the first: "which of these stopped it" is
 * the first question anybody asks, and a short-circuit answers it with silence.
 */
export function validateEvidence(
  text: string,
  ctx: SrcContext,
  expected: EvidenceExpectation,
): EvidenceValidation {
  const note = parseEvidence(text);
  const issues: EvidenceIssue[] = [...note.frontIssues];
  const offset = note.bodyLine - 1;

  // 2 — a missing required section, or one with no list items.
  for (const name of missingSections(note.body, EVIDENCE_SECTIONS)) {
    issues.push({
      kind: "section",
      line: 0,
      message: `missing the \`## ${name}\` section — the four are ${EVIDENCE_SECTIONS.join(" · ")}, in that order`,
    });
  }
  const report = validateSections(note.body, EVIDENCE_SECTIONS, ctx, offset);
  for (const empty of report.emptySections) {
    issues.push({
      kind: "section",
      line: empty.line,
      message: `\`## ${empty.name}\` has no list item — a section of prose is not a checked claim`,
    });
  }

  // 3 — a list item with no `src` token, or one that does not resolve. The
  // §2.8 resolver's own verdicts, verbatim; nothing is re-judged here.
  for (const line of report.unsourced) {
    issues.push({ kind: "citation", line, message: "no `[src: …]` token — every bullet in an evidence note is a claim" });
  }
  for (const issue of report.malformed) issues.push({ kind: "citation", line: issue.line, message: issue.message });
  for (const issue of report.unresolved) issues.push({ kind: "citation", line: issue.line, message: issue.message });
  // `unverified` REFUSES here. In a handoff it only blocks an auto gate; an agent
  // gate is strictly stronger than an auto gate, so it cannot rest on a citation
  // nothing was able to check.
  const unverified = report.unverified.map((issue): EvidenceIssue => ({
    kind: "citation",
    line: issue.line,
    message: `${issue.message} — an agent gate cannot sign over a citation nothing could check`,
  }));
  issues.push(...unverified);

  const front = note.front;
  if (front !== null) {
    // 4 — arithmetic that cannot be true.
    const c = front.citations;
    if (c.sampled > c.of) {
      issues.push({
        kind: "arithmetic",
        line: 0,
        message: `citations.sampled (${String(c.sampled)}) is more than citations.of (${String(c.of)}) — `
          + "you cannot spot-check more citations than exist",
      });
    }
    if (c.resolved + c.refuted > c.sampled) {
      issues.push({
        kind: "arithmetic",
        line: 0,
        message: `citations.resolved + citations.refuted (${String(c.resolved + c.refuted)}) is more than `
          + `citations.sampled (${String(c.sampled)}) — every outcome belongs to a citation you sampled`,
      });
    }
    // 5 — "I checked none of them" is not a check.
    if (c.sampled === 0 && c.of > 0) {
      issues.push({
        kind: "sampling",
        line: 0,
        message: `citations.sampled is 0 with ${String(c.of)} citation(s) on record — `
          + "an agent gate that sampled none of them has not checked anything",
      });
    }
    // 6 — the verdict. `sign-with-fixlist` and `refuse` are not defects in the
    // note; they are the note saying a person decides (design §10).
    if (front.verdict !== "sign") {
      issues.push({
        kind: "verdict",
        line: 0,
        message: `verdict is \`${front.verdict}\`, not \`sign\` — this gate falls to a human, by design`,
      });
    }
    // 7 — a note pasted from another gate.
    if (front.gate !== expected.gate) {
      issues.push({
        kind: "gate",
        line: 0,
        message: `\`gate: ${front.gate}\` is not the stage at the cursor (${expected.gate}) — `
          + "this note is evidence for a different gate",
      });
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    front,
    unverified,
    bulletCount: report.bulletCount,
  };
}

/** One line per problem, in the shape `approve` and `next` print refusals in. */
export function describeEvidenceIssues(issues: readonly EvidenceIssue[]): readonly string[] {
  return issues.map((issue) => (issue.line === 0 ? `  ${issue.message}` : `  L${String(issue.line)}: ${issue.message}`));
}

// --- the template ------------------------------------------------------------

export interface EvidenceTemplateInput {
  /** `<phase>/<stage>` the note is for. */
  readonly gate: string;
  readonly by: string;
  readonly at: string;
  /** How many citations the §2.8 resolver found in this stage's outputs. */
  readonly citationsOf: number;
  /** How many touched paths the plan declares — the set there is to audit. */
  readonly touchesAudited: number;
}

/**
 * The skeleton, with every MEASURED field filled and every JUDGEMENT blank.
 *
 * What is filled is what a tool can count without an opinion: the gate at the
 * cursor, the time, how many citations exist, how many touched paths the plan
 * declares. What is left blank is the verdict, the sample, the audit and the
 * bullets — and a blank one does not validate, on purpose. A template that
 * parsed clean out of the box would be a signature nobody had to earn, and the
 * whole reason `questions lint --fix` refuses to write citations applies here
 * with more force: this file is what a gate rests on.
 */
export function renderEvidenceTemplate(input: EvidenceTemplateInput): string {
  return [
    "---",
    `version: ${String(EVIDENCE_VERSION)}`,
    `gate: ${input.gate}`,
    "role: agent",
    `by: ${input.by}`,
    `at: ${input.at}`,
    `verdict:                      # ${EVIDENCE_VERDICTS.join(" | ")} — only \`sign\` closes the gate`,
    "read: []                      # every file you actually opened",
    `citations: {sampled: 0, of: ${String(input.citationsOf)}, resolved: 0, refuted: 0}`,
    `touches: {audited: ${String(input.touchesAudited)}, outside_surface: 0, new_areas: []}`,
    `diff_vs_stories:              # ${DIFF_VS_STORIES.join(" | ")} — \`n-a\` outside Build`,
    "caveats: []                   # what your mandate stopped you checking",
    "recommend: []                 # {q, option, why, src} per open question, or leave empty",
    "---",
    "",
    `# Gate evidence — ${input.gate}`,
    "",
    ...EVIDENCE_SECTIONS.flatMap((name) => [`## ${name}`, "", `_${GUIDANCE[name]}_`, ""]),
  ].join("\n");
}

/** What each section must contain, in the note and on stdout. One source, two readers. */
export const GUIDANCE: Readonly<Record<(typeof EVIDENCE_SECTIONS)[number], string>> = {
  "Read": "One bullet per file or artefact you opened, each ending with a `[src: …]` token for it.",
  "Citations checked": "Which of this stage's citations you re-checked, and what each one turned out to be. "
    + "Sample honestly: `citations.sampled` above must match what is listed here.",
  "Touches audited": "The touched paths you looked at, and every path outside the surface the What and the "
    + "stories declared. Name a new area rather than absorbing it.",
  "Verdict": "SIGN, SIGN-with-fixlist or REFUSE, and the measurement behind it — a command you ran, "
    + "a file you read. A verdict with no source is an opinion.",
};

/** The stdout brief: what the operator must fill in, section by section. */
export function describeEvidenceTemplate(path: string, input: EvidenceTemplateInput): readonly string[] {
  return [
    `wrote ${path}`,
    "",
    `Front matter: \`gate\`, \`at\`, \`citations.of\` (${String(input.citationsOf)}) and `
      + `\`touches.audited\` (${String(input.touchesAudited)}) are filled from disk. `
      + "`verdict` and `diff_vs_stories` are blank and must be answered.",
    "",
    "Sections — each needs at least one list item, and every list item must END with a valid",
    "`[src: …]` token that resolves (the §2.8 grammar, the §2.8 resolver, the same one",
    "`claim-sources` runs). A citation nothing can check refuses here, unlike in a handoff.",
    "",
    ...EVIDENCE_SECTIONS.map((name) => `  ## ${name} — ${GUIDANCE[name]}`),
    "",
    "This command signs nothing, spends nothing and spawns nothing.",
  ];
}

// --- front-matter readers ----------------------------------------------------

function front(line: number, message: string): EvidenceIssue {
  return { kind: "front-matter", line, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireText(value: unknown, key: string, issues: EvidenceIssue[]): string {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (value !== undefined) issues.push(front(0, `\`${key}\` must be a non-empty string, got ${describe(value)}`));
  return "";
}

function requireEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  key: string,
  issues: EvidenceIssue[],
): T {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  if (value !== undefined) {
    issues.push(front(0, `\`${key}\` must be one of ${allowed.join(" | ")}, got ${describe(value)}`));
  }
  return allowed[0] as T;
}

function requireStrings(value: unknown, key: string, issues: EvidenceIssue[]): readonly string[] {
  if (!Array.isArray(value)) {
    if (value !== undefined) issues.push(front(0, `\`${key}\` must be a list, got ${describe(value)}`));
    return [];
  }
  const out: string[] = [];
  for (const [i, entry] of value.entries()) {
    if (typeof entry === "string") out.push(entry);
    else issues.push(front(0, `\`${key}[${String(i)}]\` must be a string, got ${describe(entry)}`));
  }
  return out;
}

function requireCount(value: unknown, key: string, issues: EvidenceIssue[]): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  issues.push(front(0, `\`${key}\` must be a whole number of 0 or more, got ${describe(value)}`));
  return 0;
}

function requireCitations(value: unknown, issues: EvidenceIssue[]): EvidenceCitations {
  if (!isRecord(value)) {
    if (value !== undefined) {
      issues.push(front(0, "`citations` must be a mapping `{sampled, of, resolved, refuted}`, got " + describe(value)));
    }
    return { sampled: 0, of: 0, resolved: 0, refuted: 0 };
  }
  return {
    sampled: requireCount(value.sampled, "citations.sampled", issues),
    of: requireCount(value.of, "citations.of", issues),
    resolved: requireCount(value.resolved, "citations.resolved", issues),
    refuted: requireCount(value.refuted, "citations.refuted", issues),
  };
}

function requireTouches(value: unknown, issues: EvidenceIssue[]): EvidenceTouches {
  if (!isRecord(value)) {
    if (value !== undefined) {
      issues.push(front(0, "`touches` must be a mapping `{audited, outside_surface, new_areas}`, got " + describe(value)));
    }
    return { audited: 0, outside_surface: 0, new_areas: [] };
  }
  return {
    audited: requireCount(value.audited, "touches.audited", issues),
    outside_surface: requireCount(value.outside_surface, "touches.outside_surface", issues),
    new_areas: requireStrings(value.new_areas, "touches.new_areas", issues),
  };
}

/** `recommend:` is optional and defaults to `[]`; every entry it DOES carry is checked. */
function requireRecommendations(value: unknown, issues: EvidenceIssue[]): readonly EvidenceRecommendation[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    issues.push(front(0, `\`recommend\` must be a list of {q, option, why, src}, got ${describe(value)}`));
    return [];
  }
  const out: EvidenceRecommendation[] = [];
  for (const [i, entry] of value.entries()) {
    if (!isRecord(entry)) {
      issues.push(front(0, `\`recommend[${String(i)}]\` must be a mapping {q, option, why, src}`));
      continue;
    }
    const path = `recommend[${String(i)}]`;
    for (const key of ["q", "option", "why", "src"]) {
      if (!(key in entry)) issues.push(front(0, `\`${path}\` is missing \`${key}\``));
    }
    out.push({
      q: requireText(entry.q, `${path}.q`, issues),
      option: requireText(entry.option, `${path}.option`, issues),
      why: requireText(entry.why, `${path}.why`, issues),
      src: requireText(entry.src, `${path}.src`, issues),
    });
  }
  return out;
}

function describe(value: unknown): string {
  if (value === null || value === undefined) return "nothing";
  if (Array.isArray(value)) return "a list";
  if (typeof value === "object") return "a mapping";
  return typeof value === "string" ? `\`${value}\`` : String(value);
}
