/**
 * Schema for `tldrx-work/<run>/budget.yml`.
 * Budget is a first-class input (concept §1.5): a stage that cannot be afforded
 * is refused, not started and abandoned.
 */
import {
  asDocument, requireEnum, requireKeys, requireNumber, requireRecord, requireString,
  requireVersion, result, type ValidationIssue, type ValidationResult,
} from "./validation.ts";
import { ECONOMIES, type Economy } from "../budget/RunBudget.ts";

export interface BudgetFile {
  /**
   * `version: 1`. A file still saying `schema_version` loads and is reported;
   * see `requireVersion` in `./validation.ts`.
   */
  readonly version: number;
  /** @deprecated the pre-spec spelling of `version`. Accepted for one release. */
  readonly schema_version?: number;
  readonly run: string;
  readonly ceiling_usd: number;
  readonly spent_usd: number;
  readonly per_phase_usd: Readonly<Record<string, number>>;
  /**
   * Which economy the Plan agent was PRICING IN (design §E.2). Optional; absent
   * means `metered-usd`, which is what every plan written before the label meant.
   *
   * It sits at the document root rather than inside `per_phase_usd`, because that
   * map is `story id -> number` and every key in it is a story: an `economy` key
   * in there would be indistinguishable from a story called `economy` and would
   * break the "every value is a number" rule the validator already enforces. One
   * plan is priced in one economy, so one label at the root says it exactly.
   */
  readonly economy?: Economy;
}

export function validateBudget(input: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  const deprecations: string[] = [];
  const doc = asDocument(input, issues);
  if (!doc) return result(issues);

  requireVersion(doc, issues, deprecations);
  requireKeys(doc, ["run", "ceiling_usd", "spent_usd", "per_phase_usd"], "", issues);
  requireString(doc.run, "run", issues);
  requireNumber(doc.ceiling_usd, "ceiling_usd", issues);
  requireNumber(doc.spent_usd, "spent_usd", issues);
  // `null` is absence: `economy:` with no value parses to null, and an empty key
  // is a file that did not say, not a file that said something unreadable.
  if (doc.economy !== undefined && doc.economy !== null) {
    requireEnum(doc.economy, ECONOMIES, "economy", issues);
  }

  if (requireRecord(doc.per_phase_usd, "per_phase_usd", issues)) {
    for (const [key, value] of Object.entries(doc.per_phase_usd as Record<string, unknown>)) {
      requireNumber(value, `per_phase_usd.${key}`, issues);
    }
  }
  return result(issues, deprecations);
}
