/**
 * Which carried findings no story's declared surface covers (#171).
 *
 * The ONE implementation of that judgement. Three surfaces read it — the Build
 * handoff's `## Unknowns`, `tldrx ship`'s PR body, and a decision card when one
 * already fires — and `ship` runs in its own process, so it calls this leaf with
 * the story rows it already holds rather than applying a predicate of its own.
 * Nothing re-scrapes a string another parser built (`decisionCards.ts:92-94`).
 *
 * It takes DATA — the carried rows, the declared surfaces, the workspace repo
 * names — and never `ctx`, never the session. It reuses two derivations and
 * copies neither: `parseSrcToken` (the ONE `[src:]` grammar) to get the ref out
 * of `where:`, and `inSurface` (the ONE path-coverage predicate) to test one path
 * against one story's list. Its own file, so `fixlist.ts` never imports
 * `boundary.ts`.
 *
 * OWNERSHIP IS REPO-THEN-PATH. `inSurface` compares normalised path strings and
 * has no repo in it; `deriveSurface` never uses it repo-blind (it keys the
 * surface by repo, `boundary.ts:262-268`), and `touches:` answers for exactly one
 * repo (`ship.ts:893`). Without the repo half a finding at `api:src/db.ts` would
 * read as owned by a `lab` story declaring `src/db.ts` — and a false "owned" is
 * the dangerous direction.
 */
import { type FixFinding } from "./fixlist.ts";
import { parseSrcToken } from "../text/srcToken.ts";
import { inSurface } from "../run/boundary.ts";

/** `owned` and three ways of not being ownable, each with a reason. */
export type Ownership = "owned" | "unowned" | "unqualified" | "no-src";

/**
 * One story's declared surface — the three things `ship.ts`'s `ShipStory`
 * already holds, under this leaf's own names. `ShipStory` calls the first one
 * `id`, so every caller maps rather than passing the array through: structural
 * typing does not rename a field.
 */
export interface DeclaredSurface {
  readonly story: string;
  /** The repo its `touches:` are relative to, and the only one they answer for. */
  readonly repo: string;
  readonly touches: readonly string[];
}

export interface UnownedRow {
  readonly finding: FixFinding;
  readonly ownership: Exclude<Ownership, "owned">;
  /** Why this one could not be given an owner. Never blank, never inferred. */
  readonly reason: string;
}

const REASONS: Readonly<Record<Exclude<Ownership, "owned">, string>> = {
  unowned: "no story declares this path in the repo it names",
  unqualified: "the citation names no repo, and a repo is not guessed at",
  "no-src": "`where:` carries no `[src: …]` path, so nothing can be checked against it",
};

export function ownershipOf(
  finding: FixFinding,
  declared: readonly DeclaredSurface[],
  repoNames: ReadonlySet<string>,
): Ownership {
  const token = parseSrcToken(finding.where, repoNames);
  const file = token?.refs.find((ref) => ref.kind === "file") ?? null;
  if (file === null) return "no-src";
  if (file.repo === null) return "unqualified";
  const owned = declared.some((story) => story.repo === file.repo && inSurface(file.path, story.touches));
  return owned ? "owned" : "unowned";
}

export function unownedFindings(
  carried: readonly FixFinding[],
  declared: readonly DeclaredSurface[],
  repoNames: ReadonlySet<string>,
): readonly UnownedRow[] {
  const rows: UnownedRow[] = [];
  for (const finding of carried) {
    const ownership = ownershipOf(finding, declared, repoNames);
    if (ownership === "owned") continue;
    rows.push({ finding, ownership, reason: REASONS[ownership] });
  }
  return rows;
}
