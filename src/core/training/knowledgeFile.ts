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
 */
import { competencyLevel, type CompetencyEvidence, type EvidenceKind } from "../init/competencyLevel.ts";
import { parseHandoff, type HandoffSection } from "../text/handoff.ts";
import { resolveSrc, type SrcContext, type SrcRef } from "../text/srcToken.ts";

/** Light mode's file: the four claim sections plus the recap. */
export const KNOWLEDGE_SECTIONS = ["Invariants", "Entry points", "Business rules", "Gotchas", "Sources"] as const;
/** The sections that must each hold at least one sourced item. */
export const KNOWLEDGE_CHECKED_SECTIONS = ["Invariants", "Entry points", "Business rules", "Gotchas"] as const;

/** Full mode's extra file: what past runs keep deciding. */
export const FROM_RUNS_SECTIONS = ["Recurring decisions", "Recurring patterns", "Sources"] as const;
export const FROM_RUNS_CHECKED_SECTIONS = ["Recurring decisions", "Recurring patterns"] as const;

/**
 * `[assumption]` — spec §2.8 confines a `$ <cmd> → exit <n>` source to a handoff's
 * `Evidence ledger`, because there the other three sections are claims and the
 * ledger is the proof. A knowledge file has no such split — every line on it is a
 * claim about code, and "the suite is green on this invariant
 * `[src: $ npm run test → exit 0]`" is the most honest form that claim takes — so
 * every section is resolved under the ledger's name, exactly as a watcher card is.
 */
const SRC_SECTION = "Evidence ledger";

export interface KnowledgeIssue {
  /** 1-based line in the file, or 0 when the issue is about the file as a whole. */
  readonly line: number;
  readonly section: string;
  readonly message: string;
}

export interface KnowledgeFile {
  readonly ok: boolean;
  readonly issues: readonly KnowledgeIssue[];
  /** Every `src` cited in the file, in order, including ones that did not resolve. */
  readonly refs: readonly SrcRef[];
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
 * Read one knowledge file and say whether it may be kept.
 *
 * Three ways it can fail, and all three reject the whole file: a required H2 is
 * missing; a checked section holds no list item; or a list item ANYWHERE in the
 * file has no `[src: …]` token, or one that does not resolve. There is no partial
 * acceptance, because a file half of whose claims are unsourced is a file whose
 * sourced half nobody has any reason to trust.
 */
export function parseKnowledgeFile(text: string, ctx: SrcContext, shape: KnowledgeShape): KnowledgeFile {
  const issues: KnowledgeIssue[] = [];
  const refs: SrcRef[] = [];
  const items = new Map<string, number>();

  const handoff = parseHandoff(text);
  const byName = new Map<string, HandoffSection>();
  for (const section of handoff.sections) {
    if (!byName.has(section.name)) byName.set(section.name, section);
  }

  for (const required of shape.sections) {
    if (byName.has(required)) continue;
    issues.push({ line: 0, section: required, message: `the file is missing \`## ${required}\`` });
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
          message: "no `[src: …]` token — an unsourced line is not knowledge, and cannot become evidence",
        });
        continue;
      }
      for (const error of bullet.token.errors) {
        issues.push({ line: bullet.line, section: name, message: `[src: ${error.raw}] — ${error.message}` });
      }
      for (const ref of bullet.token.refs) {
        refs.push(ref);
        const resolution = resolveSrc(ref, ctx, SRC_SECTION);
        if (resolution.ok) continue;
        issues.push({
          line: bullet.line,
          section: name,
          message: `[src: ${ref.raw}] — ${resolution.message ?? "unresolvable"}`,
        });
      }
    }
  }

  return { ok: issues.length === 0, issues, refs, items, itemCount };
}

/** One line per issue, for a CLI report. */
export function describeKnowledgeIssues(issues: readonly KnowledgeIssue[], max = 5): readonly string[] {
  const shown = issues.slice(0, max).map((issue) => `  L${String(issue.line)} ${issue.section}: ${issue.message}`);
  const rest = issues.length - shown.length;
  return rest > 0 ? [...shown, `  (+${String(rest)} more)`] : shown;
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
 * 3 no matter what the sub-agent measured. The rule and the code disagreed, and
 * the code was wrong: §2.6's own "where evidence comes from" table has always
 * said a `run` row is written when "a knowledge file cites a command that was
 * executed", `src` = `$ <cmd> → exit <n>`.
 *
 * One row per distinct command+exit, deduped by the whole `src` — `$ npm test →
 * exit 0` and `$ npm test → exit 1` are two different measurements of the same
 * command and both are worth recording. Nothing here re-checks that the command
 * is declared in `workspace.yml`: `parseKnowledgeFile` already resolved every ref
 * through `resolveSrc`, which refuses an undeclared command outright (see
 * `srcToken.ts` `resolveSrc` case "cmd"), and a file with one unresolvable source
 * is rejected whole before any evidence is derived from it.
 */
export function codeEvidence(refs: readonly SrcRef[], at: string): readonly CompetencyEvidence[] {
  const out: CompetencyEvidence[] = [];
  const seenFiles = new Set<string>();
  const seenSrc = new Set<string>();

  const push = (kind: EvidenceKind, src: string): void => {
    if (seenSrc.has(src)) return;
    seenSrc.add(src);
    out.push({ kind, src, at });
  };

  for (const ref of refs) {
    if (ref.kind === "file") {
      const file = `${ref.repo ?? ""}:${ref.path}`;
      if (seenFiles.has(file)) continue;
      seenFiles.add(file);
      push("code", ref.raw);
      continue;
    }
    if (ref.kind === "doc") push("doc", ref.url);
    if (ref.kind === "fact") push("answer", ref.id);
    // `raw` is `$ <command> → exit <n>` — command AND exit code, so the row is
    // one measurement rather than one command.
    if (ref.kind === "cmd") push("run", ref.raw);
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
export function runEvidence(refs: readonly SrcRef[], at: string): readonly CompetencyEvidence[] {
  const out: CompetencyEvidence[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
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
    out.push({ kind, src, at });
  }
  return out;
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
