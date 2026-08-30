/**
 * Two experts, one line, two different sentences about it.
 *
 * Measured 2026-08-29 on `~/aparece-v2`: 16 files were cited by two trained
 * experts each. That is not wrong on its own — a file on a boundary really does
 * belong to two domains — but nothing anywhere compared what the two SAID about
 * it, and a stage that loads both gets two claims about one line with no signal
 * that they might disagree. The audit's word for the shape was a laundering
 * vector: an unchallenged contradiction reaches `design.md` as a fact.
 *
 * This is deliberately the cheapest possible guard, and it resolves nothing. It
 * reports one line when two experts cite the same `file:line` with bullets whose
 * NORMALISED texts differ, and leaves the judgement to a person. An automatic
 * resolution would need to decide which expert is right, which is exactly the
 * thing no deterministic tool can do — and guessing would be worse than the
 * silence it replaces.
 *
 * Same normalisation as the paraphrase check (`training/claimCheck.ts`), so
 * "the same sentence with different punctuation" is the same sentence here too.
 */
import { parseHandoff } from "../text/handoff.ts";
import { parseSrcToken } from "../text/srcToken.ts";
import { claimText, normaliseClaim } from "../training/claimCheck.ts";
import { readKnowledgeFiles } from "./expertKnowledge.ts";
import type { ExpertRecord } from "./ExpertRecord.ts";

export interface SharedCitation {
  /** The `src` payload verbatim, e.g. `api:src/Checkout/Cart.cs:41`. */
  readonly src: string;
  /** The experts that cited it, sorted, each saying something different. */
  readonly experts: readonly string[];
}

/** Expert name -> `src` -> the normalised claims it made about that src. */
function claimsByExpert(root: string, names: readonly string[]): Map<string, Map<string, Set<string>>> {
  const out = new Map<string, Map<string, Set<string>>>();
  for (const name of names) {
    const bySrc = new Map<string, Set<string>>();
    for (const file of readKnowledgeFiles(root, name)) {
      for (const section of parseHandoff(file.text).sections) {
        for (const bullet of section.bullets) {
          const token = bullet.token ?? parseSrcToken(bullet.text);
          if (token === null) continue;
          const claim = normaliseClaim(claimText(bullet.text, token.raw));
          if (claim === "") continue;
          for (const ref of token.refs) {
            if (ref.kind !== "file") continue;
            const claims = bySrc.get(ref.raw) ?? new Set<string>();
            claims.add(claim);
            bySrc.set(ref.raw, claims);
          }
        }
      }
    }
    out.set(name, bySrc);
  }
  return out;
}

/**
 * Every `src` two or more experts cite with texts that are not the same sentence.
 * Sorted by `src`, so the output is stable across filesystems.
 */
export function sharedCitations(root: string, experts: readonly ExpertRecord[]): readonly SharedCitation[] {
  const byExpert = claimsByExpert(root, experts.map((expert) => expert.name));

  const bySrc = new Map<string, Map<string, Set<string>>>();
  for (const [name, srcs] of byExpert) {
    for (const [src, claims] of srcs) {
      const owners = bySrc.get(src) ?? new Map<string, Set<string>>();
      owners.set(name, claims);
      bySrc.set(src, owners);
    }
  }

  const out: SharedCitation[] = [];
  for (const [src, owners] of bySrc) {
    if (owners.size < 2) continue;
    // Identical sentences are agreement, not contradiction: two experts that
    // copied the same finding are duplicating work, which is a different report.
    const distinct = new Set<string>();
    for (const claims of owners.values()) for (const claim of claims) distinct.add(claim);
    if (distinct.size < 2) continue;
    out.push({ src, experts: [...owners.keys()].sort() });
  }
  return out.sort((a, b) => (a.src < b.src ? -1 : a.src > b.src ? 1 : 0));
}

/** One line per shared citation, in the shape every other expert warning uses. */
export function sharedCitationWarnings(shared: readonly SharedCitation[]): readonly string[] {
  return shared.map(
    (row) => `warning: shared citation ${row.src} by ${row.experts.join(",")} — check for contradiction`,
  );
}
