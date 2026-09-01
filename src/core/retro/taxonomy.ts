/**
 * The finding taxonomy — the names only, in one leaf module.
 *
 * Split out of `findings.ts` when the taxonomy became workspace-extensible
 * (#74): the validator in `findingClasses.ts` has to know which names are
 * built in, and `findings.ts` has to know what a workspace added, so the two
 * would otherwise import each other. A leaf holding the constant breaks that
 * cycle rather than papering over it with a lazy read.
 *
 * The order is PRECEDENCE, not importance: the classifier takes the first rule
 * that matches. It is by how specific the evidence is —
 * `authorization-not-widened` sits below `stale-comment` deliberately, because
 * the S5 finding that produced both ("a false security comment beside a
 * non-constant-time compare") is a defect IN THE COMMENT, and a security
 * keyword anywhere in a sentence would otherwise swallow every finding that
 * mentions auth in passing. The rules themselves live in `findings.ts`.
 *
 * `other` is last and matches everything. It is a real answer, not a failure:
 * a table where `other` dominates is telling you the taxonomy is too small,
 * which is what `.tldrx/memory/finding-classes.yml` now lets you do something
 * about.
 */
export const FINDING_CLASSES = [
  "test-cannot-fail",
  "missing-negative-control",
  "unreachable-structure",
  "stale-comment",
  "authorization-not-widened",
  "schema-drift",
  "other",
] as const;

/** The seven this framework ships. A workspace may add to them; never redefine one. */
export type BuiltinFindingClass = (typeof FINDING_CLASSES)[number];

/**
 * A class name: one of the seven, or a workspace extension's
 * (`.tldrx/memory/finding-classes.yml`).
 *
 * `string & {}` rather than a bare `string` so the seven still autocomplete and
 * still typo-check where they are written as literals, while a name that exists
 * only in somebody's workspace is assignable at all.
 */
export type FindingClass = BuiltinFindingClass | (string & {});

/** `other` — the class that matches everything, and is never a lead worth chasing. */
export const OTHER: BuiltinFindingClass = "other";

/** The built-ins that actually carry rules: everything before `other`. */
export const RULED_CLASSES: readonly BuiltinFindingClass[] =
  FINDING_CLASSES.filter((cls) => cls !== OTHER);
