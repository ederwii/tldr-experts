/**
 * `.tldrx/experts/<name>/knowledge/<area>.md` — what a training run must produce,
 * and the only thing that is allowed to raise a level.
 *
 * The section half reuses the SHARED handoff parser (`src/core/text/handoff.ts`)
 * rather than growing a third one. That is not tidiness: `claim-sources` denies a
 * handoff bullet with exactly that parser and exactly that `[src: …]` grammar, so
 * a knowledge file judged by a different reader would drift from the rule the
 * hook enforces — and the drift would show up as evidence that cites something
 * nothing can resolve.
 *
 * `absent:` is legal and deliberate. "I looked at `mobile:src/auth/` and there is
 * no token refresh there" is a real finding; it just is not EVIDENCE, so it earns
 * a line in the file and no row in `competencies.yml`.
 *
 * **Since 2026-08-29 a citation must SUSTAIN its claim, not only resolve.** Wave M
 * checked every `src` against the workspace and stopped there, which is a check on
 * the citation rather than on the sentence. Four rules close that gap, and three of
 * them cost a bullet its evidence without failing the file:
 *
 *   - an execution claim ("exit 0", "78/78 passed", "build is green") needs the
 *     §2.8 `cmd` production; a `file` line under one is REFUSED (`claimCheck.ts`);
 *   - a bullet that restates the line it cites is `paraphrase` — a warning, and no
 *     evidence, because it told the reader nothing the line did not;
 *   - a citation outside the expert's declared `## Domain` is `outside domain` — a
 *     warning, and no evidence for THIS expert, with the expert whose domain does
 *     contain it named when one does;
 *   - a `src` already on record in another of this expert's areas is `duplicate
 *     src` — a warning, and no second row for one reading.
 *
 * And `## Sources` earns nothing at all. Measured 2026-08-29: it was 41 of 107
 * bullets in `aparece-platform` and 18 of 56 in `aparece-platform-abstractions`,
 * every one of them re-citing a source the file had already cited above. A section
 * whose whole job is to repeat the citations is not a second body of evidence.
 */
import { competencyLevel, type CompetencyEvidence, type EvidenceKind } from "../init/competencyLevel.ts";
import { parseHandoff, type HandoffSection } from "../text/handoff.ts";
import { parseSrcToken, resolveSrc, type SrcContext, type SrcRef } from "../text/srcToken.ts";
import { pathsIntersect } from "../experts/expertDomain.ts";
import {
  claimText, confidenceOf, executionClaim, isParaphrase, neighbourhood, type Confidence,
} from "./claimCheck.ts";

/** Light mode's file: the four claim sections plus the recap. */
export const KNOWLEDGE_SECTIONS = ["Invariants", "Entry points", "Business rules", "Gotchas", "Sources"] as const;
/** The sections that must each hold at least one sourced item. */
export const KNOWLEDGE_CHECKED_SECTIONS = ["Invariants", "Entry points", "Business rules", "Gotchas"] as const;

/** Full mode's extra file: what past runs keep deciding. */
export const FROM_RUNS_SECTIONS = ["Recurring decisions", "Recurring patterns", "Sources"] as const;
export const FROM_RUNS_CHECKED_SECTIONS = ["Recurring decisions", "Recurring patterns"] as const;

/**
 * The recap section, in both shapes. Its bullets are validated like any other —
 * an unsourced one still fails the file — but they are never DERIVED into
 * evidence: every one of them re-cites a claim made above it, and counting both
 * would let a file buy two rows for one reading.
 */
export const RECAP_SECTION = "Sources";

/**
 * `[assumption]` — spec §2.8 confines a `$ <cmd> → exit <n>` source to a handoff's
 * `Evidence ledger`, because there the other three sections are claims and the
 * ledger is the proof. A knowledge file has no such split — every line on it is a
 * claim about code, and "the suite is green on this invariant
 * `[src: $ npm run test → exit 0]`" is the most honest form that claim takes — so
 * every section is resolved under the ledger's name, exactly as a watcher card is.
 */
const SRC_SECTION = "Evidence ledger";

/** The exact refusal an execution claim with a `file` src earns. */
export const EXECUTION_CLAIM_REFUSAL =
  "execution claim needs a '$ <cmd> → exit <n>' src, not a file line";

export type KnowledgeSeverity = "error" | "warning";

export interface KnowledgeIssue {
  /** 1-based line in the file, or 0 when the issue is about the file as a whole. */
  readonly line: number;
  readonly section: string;
  readonly message: string;
  /** `error` rejects the file whole; `warning` costs the bullet its evidence only. */
  readonly severity: KnowledgeSeverity;
}

/** One list item, with everything the evidence derivation needs to judge it. */
export interface KnowledgeBullet {
  readonly section: string;
  readonly line: number;
  /** The bullet verbatim, token and all. */
  readonly text: string;
  /** The sentence: no `[src: …]`, no `(measured)` annotation. */
  readonly claim: string;
  /** Every `src` the bullet cited. */
  readonly refs: readonly SrcRef[];
  /** The subset of `refs` that may become an evidence row. */
  readonly evidence: readonly SrcRef[];
  /** True when `evidence` spans two or more distinct FILES — §2.6 weighs it double. */
  readonly cross: boolean;
  readonly confidence: Confidence | null;
}

export interface KnowledgeFile {
  readonly ok: boolean;
  readonly issues: readonly KnowledgeIssue[];
  /** Every `src` cited in the file, in order, including ones that did not resolve. */
  readonly refs: readonly SrcRef[];
  /** Every list item in a declared section, in order. */
  readonly bullets: readonly KnowledgeBullet[];
  /** Section name -> how many list items it holds. */
  readonly items: ReadonlyMap<string, number>;
  readonly itemCount: number;
}

export interface KnowledgeShape {
  readonly sections: readonly string[];
  readonly checked: readonly string[];
}

export const LIGHT_SHAPE: KnowledgeShape = {
  sections: KNOWLEDGE_SECTIONS,
  checked: KNOWLEDGE_CHECKED_SECTIONS,
};

export const RUNS_SHAPE: KnowledgeShape = {
  sections: FROM_RUNS_SECTIONS,
  checked: FROM_RUNS_CHECKED_SECTIONS,
};

/**
 * What this expert is allowed to speak for, and what it has already said.
 *
 * Optional by design: `parseKnowledgeFile` is also called on files read out of a
 * tarball, where there is no `expert.md` to read a domain from. With no scope, the
 * domain and duplicate rules simply do not fire — they narrow, they never invent.
 */
export interface KnowledgeScope {
  readonly expert: string;
  /** `## Domain` paths, repo-relative and normalised. Empty ⇒ no domain scoping. */
  readonly domainPaths: readonly string[];
  /** Other experts' `## Domain` paths, for "who should own this" — never a refusal. */
  readonly otherDomains: ReadonlyMap<string, readonly string[]>;
  /** Every `src` already on record in this expert's OTHER areas. */
  readonly seenSrc: ReadonlySet<string>;
}

export function emptyKnowledgeScope(expert: string): KnowledgeScope {
  return { expert, domainPaths: [], otherDomains: new Map(), seenSrc: new Set() };
}

/**
 * Read one knowledge file and say whether it may be kept.
 *
 * Four ways it can FAIL, and all four reject the whole file: a required H2 is
 * missing; a checked section holds no list item; a list item ANYWHERE in the file
 * has no `[src: …]` token, or one that does not resolve; or a claim that asserts
 * an execution result cites a file line instead of a command. There is no partial
 * acceptance, because a file half of whose claims are unsourced is a file whose
 * sourced half nobody has any reason to trust.
 *
 * Warnings are the other half and they never reject: `paraphrase`, `outside
 * domain` and `duplicate src` each cost a citation its evidence row and leave the
 * file on disk, because none of them is a lie — they are ways of being worth
 * nothing, and the honest response to worth nothing is a level that does not move.
 */
export function parseKnowledgeFile(
  text: string,
  ctx: SrcContext,
  shape: KnowledgeShape,
  scope?: KnowledgeScope,
): KnowledgeFile {
  const issues: KnowledgeIssue[] = [];
  const refs: SrcRef[] = [];
  const bullets: KnowledgeBullet[] = [];
  const items = new Map<string, number>();
  const seenHere = new Set<string>();

  const handoff = parseHandoff(text);
  const byName = new Map<string, HandoffSection>();
  for (const section of handoff.sections) {
    if (!byName.has(section.name)) byName.set(section.name, section);
  }

  for (const required of shape.sections) {
    if (byName.has(required)) continue;
    issues.push({
      line: 0, section: required, severity: "error",
      message: `the file is missing \`## ${required}\``,
    });
  }

  let itemCount = 0;
  for (const name of shape.sections) {
    const section = byName.get(name);
    if (section === undefined) continue;
    items.set(name, section.bullets.length);
    if (section.bullets.length === 0 && shape.checked.includes(name)) {
      issues.push({
        line: section.headingLine,
        section: name,
        severity: "error",
        message: `\`## ${name}\` holds no list item — write \`- none [src: absent:<what you looked at>]\` `
          + "if you looked and there is genuinely nothing",
      });
      continue;
    }
    for (const bullet of section.bullets) {
      itemCount++;
      if (bullet.token === null) {
        issues.push({
          line: bullet.line,
          section: name,
          severity: "error",
          message: "no `[src: …]` token — an unsourced line is not knowledge, and cannot become evidence",
        });
        continue;
      }
      for (const error of bullet.token.errors) {
        issues.push({
          line: bullet.line, section: name, severity: "error",
          message: `[src: ${error.raw}] — ${error.message}`,
        });
      }

      const claim = claimText(bullet.text, bullet.token.raw);
      const confidence = confidenceOf(bullet.text, bullet.token.raw);
      const resolved = new Map<string, string>();
      let broken = false;

      for (const ref of bullet.token.refs) {
        refs.push(ref);
        const resolution = resolveSrc(ref, ctx, SRC_SECTION, claim);
        if (resolution.resolved !== undefined) resolved.set(ref.raw, resolution.resolved);
        if (resolution.ok) continue;
        broken = true;
        issues.push({
          line: bullet.line,
          section: name,
          severity: "error",
          message: `[src: ${ref.raw}] — ${resolution.message ?? "unresolvable"}`,
        });
      }

      // (1) The claim asserts a RESULT. Only a command can source that.
      const asserted = executionClaim(claim);
      if (asserted !== null && !bullet.token.refs.some((ref) => ref.kind === "cmd")) {
        broken = true;
        issues.push({
          line: bullet.line, section: name, severity: "error",
          message: EXECUTION_CLAIM_REFUSAL,
        });
      }

      // Nothing below can rescue a bullet the file is already rejected for; it is
      // still recorded, so a caller reporting bullets sees all of them.
      const candidates = broken ? [] : [...bullet.token.refs];
      const kept: SrcRef[] = [];

      // (2) A verbatim restatement of the cited line is not a finding.
      const echoes = candidates.some((ref) =>
        ref.kind === "file" && isParaphrase(claim, neighbourhood(resolved.get(ref.raw) ?? "", ref.startLine)));
      if (echoes) {
        issues.push({
          line: bullet.line, section: name, severity: "warning",
          message: "paraphrase — this bullet restates the line it cites almost verbatim, so it earns no evidence",
        });
      }

      // (3) The recap section re-cites; it never earns a second row.
      const recap = name === RECAP_SECTION;

      for (const ref of candidates) {
        if (echoes || recap) break;
        const outside = outsideDomain(ref, scope);
        if (outside !== null) {
          issues.push({ line: bullet.line, section: name, severity: "warning", message: outside });
          continue;
        }
        const duplicate = duplicateSrc(ref, scope, seenHere);
        if (duplicate !== null) {
          issues.push({ line: bullet.line, section: name, severity: "warning", message: duplicate });
          continue;
        }
        seenHere.add(ref.raw);
        kept.push(ref);
      }

      const files = new Set(kept.filter((ref) => ref.kind === "file").map((ref) => `${ref.repo ?? ""}:${ref.path}`));
      bullets.push({
        section: name,
        line: bullet.line,
        text: bullet.text,
        claim,
        refs: bullet.token.refs,
        evidence: kept,
        cross: files.size >= 2,
        confidence,
      });
    }
  }

  // Prose carries claims too, and the corpus proves it: the one dangerous line in
  // the whole aparece sample is a HEADER paragraph, not a bullet, and its tokens
  // sit mid-line where a line-anchored parser never looks.
  issues.push(...proseExecutionIssues(text));

  return { ok: !issues.some((issue) => issue.severity === "error"), issues, refs, bullets, items, itemCount };
}

/** `outside domain — …`, or null when the ref is inside the declared domain. */
function outsideDomain(ref: SrcRef, scope: KnowledgeScope | undefined): string | null {
  if (scope === undefined || scope.domainPaths.length === 0) return null;
  if (ref.kind !== "file") return null;
  if (scope.domainPaths.some((domain) => pathsIntersect(ref.path, domain))) return null;

  const owner = [...scope.otherDomains.entries()]
    .filter(([name]) => name !== scope.expert)
    .find(([, paths]) => paths.some((domain) => pathsIntersect(ref.path, domain)));
  const hint = owner === undefined
    ? ""
    : ` — \`${owner[0]}\` declares a domain that contains it, so train that expert on it instead`;
  return `[src: ${ref.raw}] — outside domain: \`${scope.expert}\` declares `
    + `${scope.domainPaths.map((path) => `\`${path}\``).join(", ")}, so this citation earns it no evidence${hint}`;
}

/** `duplicate src — …`, or null when this `src` is new to the expert. */
function duplicateSrc(ref: SrcRef, scope: KnowledgeScope | undefined, seenHere: ReadonlySet<string>): string | null {
  const already = seenHere.has(ref.raw) || (scope?.seenSrc.has(ref.raw) ?? false);
  if (!already) return null;
  return `[src: ${ref.raw}] — duplicate src: this expert already has it on record, so it earns no second row`;
}

const FENCE_RE = /^\s*(?:```|~~~)/;
const H_RE = /^#{1,6}\s/;
const BULLET_LINE_RE = /^(?: {0,3}[-*+]|\s*\d{1,9}[.)])\s+\S/;
const INLINE_TOKEN_RE = /\[src: ([^\]]*)\]/g;

/**
 * Execution claims in PROSE, found paragraph by paragraph.
 *
 * Measured 2026-08-29 — the header of the real `aparece-api.md`:
 *
 *     Gate state at training time: `dotnet build` exit 0, 0 warnings, 0 errors — measured, exit code captured
 *     unpiped [src: aparece-v2:.tldrx/workspace.yml:19]. `scripts/test.sh …`
 *     → 78/78 passed, exit 0 — measured [src: aparece-v2:scripts/test.sh:105]. …
 *
 * Three claims of a measurement, three citations to declarations, and not one of
 * them visible to a bullet-level check: they are not bullets, and their tokens are
 * mid-line, so `parseSrcToken` — anchored to end-of-line by §2.8 — sees nothing.
 * A rule that only reads bullets would report this file clean, which is the
 * "wrong instrument" failure the whole audit is about.
 *
 * So prose is joined into paragraphs, every `[src: …]` in one is found, and the
 * text since the previous token is that token's claim. Prose is checked for THIS
 * rule alone: §2.8 asks bullets to carry sources, not paragraphs, and demanding a
 * citation of every sentence would reject every knowledge file ever written.
 */
export function proseExecutionIssues(text: string): readonly KnowledgeIssue[] {
  const issues: KnowledgeIssue[] = [];
  const lines = text.split("\n");
  let section = "(prose)";
  let fenced = false;
  let paragraph: { line: number; parts: string[] } | null = null;

  const flush = (): void => {
    if (paragraph === null) return;
    issues.push(...paragraphIssues(paragraph.parts.join(" "), paragraph.line, section));
    paragraph = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (FENCE_RE.test(line)) {
      flush();
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading !== null && heading[1] !== undefined) {
      flush();
      section = heading[1];
      continue;
    }
    if (line.trim() === "" || H_RE.test(line) || BULLET_LINE_RE.test(line) || line.trim() === "---") {
      flush();
      continue;
    }
    // A bullet's own wrapped continuation is indented and belongs to the bullet,
    // which the bullet pass already judged.
    if (paragraph === null && /^\s/.test(line)) continue;
    if (paragraph === null) paragraph = { line: i + 1, parts: [line.trim()] };
    else paragraph.parts.push(line.trim());
  }
  flush();
  return issues;
}

function paragraphIssues(paragraph: string, line: number, section: string): readonly KnowledgeIssue[] {
  const issues: KnowledgeIssue[] = [];
  INLINE_TOKEN_RE.lastIndex = 0;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = INLINE_TOKEN_RE.exec(paragraph)) !== null) {
    const claim = claimText(paragraph.slice(cursor, match.index), null);
    cursor = match.index + match[0].length;
    if (executionClaim(claim) === null) continue;
    const token = parseSrcToken(`x ${match[0]}`);
    if (token !== null && token.refs.some((ref) => ref.kind === "cmd")) continue;
    issues.push({ line, section, severity: "error", message: EXECUTION_CLAIM_REFUSAL });
  }
  return issues;
}

/** One line per issue, for a CLI report. */
export function describeKnowledgeIssues(issues: readonly KnowledgeIssue[], max = 5): readonly string[] {
  const shown = issues.slice(0, max).map(
    (issue) => `  L${String(issue.line)} ${issue.section}: ${issue.message}`,
  );
  const rest = issues.length - shown.length;
  return rest > 0 ? [...shown, `  (+${String(rest)} more)`] : shown;
}

/** The warnings a caller must print even when the file was accepted. */
export function knowledgeWarnings(file: KnowledgeFile): readonly string[] {
  return file.issues
    .filter((issue) => issue.severity === "warning")
    .map((issue) => `warning: L${String(issue.line)} ${issue.section}: ${issue.message}`);
}

/**
 * Evidence for the CODE knowledge file, derived from what it cited.
 *
 * `[assumption]` — the wave brief says "one evidence row per distinct cited FILE
 * (dedupe by src)". Those two halves can disagree, because a `src` carries a line
 * number and a file does not, so the choice made here is the conservative one:
 * one row per distinct `repo:path`, keeping the FIRST citation's `repo:path:line`
 * as the row's `src` so the token still resolves. Per-line rows would let twelve
 * careful readings of a single file compute level 5, which is precisely the
 * self-declared number the §2.6 distinct-source cap exists to stop.
 *
 * `absent:` cites nothing, so they produce nothing. A `doc` becomes `kind: doc`
 * and a fact `kind: answer`, matching the §2.6 example.
 *
 * **A `cmd` citation becomes `kind: run`, and it is the only way light mode can
 * reach level 4.** Before 2026-08-29 this function dropped `cmd` refs on the
 * floor: it mapped `file`, `doc` and `fact` and nothing else, so a sub-agent that
 * ran `npm test` and cited `[src: $ npm test → exit 0]` earned no row for it. Set
 * against the §2.6 run cap — no `kind: run` row means `level = min(level, 3)` —
 * that made `tldrx expert train --mode light` structurally incapable of exceeding
 * 3 no matter what the sub-agent measured.
 *
 * It reads BULLETS rather than a flat ref list, because since 2026-08-29 whether a
 * citation is evidence is a fact about the sentence it is attached to: a paraphrase
 * earns nothing, a citation outside the domain earns nothing here, and a bullet
 * that ties two files together earns a row worth double (§2.6 `cross`).
 */
export function codeEvidence(bullets: readonly KnowledgeBullet[], at: string): readonly CompetencyEvidence[] {
  const out: CompetencyEvidence[] = [];
  const seenFiles = new Set<string>();
  const seenSrc = new Set<string>();

  const push = (kind: EvidenceKind, src: string, bullet: KnowledgeBullet): void => {
    if (seenSrc.has(src)) return;
    seenSrc.add(src);
    out.push(row(kind, src, at, bullet));
  };

  for (const bullet of bullets) {
    for (const ref of bullet.evidence) {
      if (ref.kind === "file") {
        const file = `${ref.repo ?? ""}:${ref.path}`;
        if (seenFiles.has(file)) continue;
        seenFiles.add(file);
        push("code", ref.raw, bullet);
        continue;
      }
      if (ref.kind === "doc") push("doc", ref.url, bullet);
      if (ref.kind === "fact") push("answer", ref.id, bullet);
      // `raw` is `$ <command> → exit <n>` — command AND exit code, so the row is
      // one measurement rather than one command.
      if (ref.kind === "cmd") push("run", ref.raw, bullet);
    }
  }
  return out;
}

/**
 * Evidence for the FROM-RUNS file. Only two kinds, per the wave brief: a citation
 * into `tldrx-work/` is `run`, a fact is `answer`. A run file is deduped by the
 * whole `src` rather than by file, because two decisions recorded on two lines of
 * one handoff really are two pieces of evidence — unlike two readings of one
 * source file, they were written at different moments by different stages.
 */
export function runEvidence(bullets: readonly KnowledgeBullet[], at: string): readonly CompetencyEvidence[] {
  const out: CompetencyEvidence[] = [];
  const seen = new Set<string>();
  for (const bullet of bullets) {
    for (const ref of bullet.evidence) {
      let kind: EvidenceKind | null = null;
      let src = "";
      if (ref.kind === "file" && ref.repo === null && ref.path.startsWith("tldrx-work/")) {
        kind = "run";
        src = ref.raw;
      } else if (ref.kind === "fact") {
        kind = "answer";
        src = ref.id;
      }
      if (kind === null || seen.has(src)) continue;
      seen.add(src);
      out.push(row(kind, src, at, bullet));
    }
  }
  return out;
}

/** Both derivations mint a row the same way, so both carry the same §2.6 fields. */
function row(kind: EvidenceKind, src: string, at: string, bullet: KnowledgeBullet): CompetencyEvidence {
  return {
    kind,
    src,
    at,
    ...(bullet.cross ? { cross: true } : {}),
    ...(bullet.confidence === null ? {} : { confidence: bullet.confidence }),
  };
}

/** Spec §2.6: at most 50 evidence items per area. */
export const MAX_EVIDENCE_PER_AREA = 50;

export interface MergedEvidence {
  readonly evidence: readonly CompetencyEvidence[];
  /** Rows genuinely added — the ones whose `src` was not already on record. */
  readonly added: readonly CompetencyEvidence[];
  readonly levelBefore: number;
  readonly levelAfter: number;
  /** Rows dropped because the area is already at the §2.6 cap. */
  readonly dropped: number;
}

/**
 * Merge new evidence into an area's existing rows: deduped by `src`, capped at 50,
 * newest kept when the cap bites. The level is recomputed both ways so the caller
 * can report the movement rather than assert it.
 */
export function mergeEvidence(
  existing: readonly CompetencyEvidence[],
  incoming: readonly CompetencyEvidence[],
  now: Date,
): MergedEvidence {
  const bySrc = new Map<string, CompetencyEvidence>();
  for (const item of existing) bySrc.set(item.src, item);

  const added: CompetencyEvidence[] = [];
  for (const item of incoming) {
    if (bySrc.has(item.src)) continue;
    bySrc.set(item.src, item);
    added.push(item);
  }

  const all = [...bySrc.values()];
  // Oldest first, so a cap keeps the newest — recency is what the formula weighs.
  all.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const dropped = Math.max(0, all.length - MAX_EVIDENCE_PER_AREA);
  const kept = dropped === 0 ? all : all.slice(dropped);

  return {
    evidence: kept,
    added,
    levelBefore: competencyLevel(existing, now),
    levelAfter: competencyLevel(kept, now),
    dropped,
  };
}
