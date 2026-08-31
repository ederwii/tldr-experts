/** `tldrx-work/<run>/budget.yml` (spec §2.11) — the ceiling the facilitator refuses to exceed. */
import {
  asDocument, isRecord, requireArray, requireEnum, requireKeys, requireNumber, requireString,
  requireVersion, result, type ValidationIssue, type ValidationResult,
} from "../schemas/validation.ts";

export const ON_EXCEED = ["block", "warn"] as const;
export type OnExceed = (typeof ON_EXCEED)[number];

/**
 * What the numbers in this file are DENOMINATED IN (spec §2.11, design §E).
 *
 * The money model was a single scalar with no unit on it, and on 2026-08-30 that
 * cost $9.95: the Plan agent priced `260830-tenancy-identity-customers` assuming
 * HOST-billed sub-agents — turns the host session pays for, which this process
 * never meters and which are ~free to the run — and the executor then enforced
 * those figures as dollar ceilings on METERED spawns. Six spawns of six died on
 * `Reached maximum budget`, each one having spent real money to get there.
 *
 * So a price gets a currency:
 *
 *  - `metered-usd` — dollars a spawn may spend, metered by the CLI. The default,
 *    and exactly what every existing file already means.
 *  - `host-tokens` — a budget in units nobody in this process meters. The number
 *    is a host-session token allowance, not dollars, and it may never become a
 *    `--max-budget-usd` on a spawn.
 *
 * The two are NEVER converted into one another. There is no exchange rate here
 * and inventing one would be a guess about a price — which is the whole reason
 * the label exists.
 */
export const ECONOMIES = ["metered-usd", "host-tokens"] as const;
export type Economy = (typeof ECONOMIES)[number];

/** Absence means this, which is what every file written before the label meant. */
export const DEFAULT_ECONOMY: Economy = "metered-usd";

/** Spec §2.11 default. `[assumption]` documented there: emitted once per phase. */
export const DEFAULT_WARN_AT_PCT = 80;
export const MAX_PHASES = 5;

export interface BudgetPhase {
  readonly id: string;
  readonly ceiling_usd: number;
  readonly spent_usd: number;
  /** This phase's own economy, or null to inherit the run's. */
  readonly economy: Economy | null;
}

export interface RunBudget {
  readonly version: number;
  readonly run: string;
  readonly ceiling_usd: number;
  readonly per_agent_max_usd: number;
  readonly warn_at_pct: number;
  readonly on_exceed: OnExceed;
  /** The run-level economy every phase inherits unless it names its own. */
  readonly economy: Economy;
  readonly phases: readonly BudgetPhase[];
}

/**
 * The economy that governs one phase: the phase's own label, else the run's.
 *
 * Phase-then-run, and never anything cleverer — a stage does not get to argue
 * with the phase it is in, and a null budget (no budget.yml) is the default.
 */
export function economyFor(budget: RunBudget | null, phaseId?: string | null): Economy {
  if (budget === null) return DEFAULT_ECONOMY;
  if (phaseId !== undefined && phaseId !== null) {
    const phase = budget.phases.find((entry) => entry.id === phaseId);
    if (phase !== undefined && phase.economy !== null) return phase.economy;
  }
  return budget.economy;
}

/** True when the numbers governing this phase are not dollars. */
export function isHostTokens(budget: RunBudget | null, phaseId?: string | null): boolean {
  return economyFor(budget, phaseId) === "host-tokens";
}

export function validateRunBudget(input: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  const deprecations: string[] = [];
  const doc = asDocument(input, issues);
  if (!doc) return result(issues);

  requireVersion(doc, issues, deprecations);
  requireKeys(doc, ["run", "ceiling_usd", "per_agent_max_usd", "on_exceed", "phases"], "", issues);
  requireString(doc.run, "run", issues);
  requireNumber(doc.ceiling_usd, "ceiling_usd", issues);
  requireNumber(doc.per_agent_max_usd, "per_agent_max_usd", issues);
  requireEnum(doc.on_exceed, ON_EXCEED, "on_exceed", issues);
  // Optional, and absent means `metered-usd`. A file that names an economy this
  // reader does not know is REFUSED rather than defaulted: a unit nothing here
  // understands is not a unit it may quietly read as dollars.
  //
  // `null` counts as absent on purpose. `economy:` with no value parses to null,
  // and the in-memory `BudgetPhase.economy` uses null for "inherit the run's" —
  // and that same object is revalidated on every `RunStore.save()`.
  if (doc.economy !== undefined && doc.economy !== null) {
    requireEnum(doc.economy, ECONOMIES, "economy", issues);
  }
  if (doc.warn_at_pct !== undefined) {
    requireNumber(doc.warn_at_pct, "warn_at_pct", issues);
    const pct = doc.warn_at_pct;
    if (typeof pct === "number" && (pct < 1 || pct > 99)) {
      issues.push({ path: "warn_at_pct", message: "expected 1–99" });
    }
  }
  if (!requireArray(doc.phases, "phases", issues)) return result(issues, deprecations);

  const phases = doc.phases as unknown[];
  if (phases.length > MAX_PHASES) {
    issues.push({ path: "phases", message: `${phases.length} phases exceeds the ${MAX_PHASES} cap` });
  }
  let sum = 0;
  phases.forEach((phase, i) => {
    const path = `phases[${i}]`;
    if (!isRecord(phase)) {
      issues.push({ path, message: "expected a mapping" });
      return;
    }
    requireKeys(phase, ["id", "ceiling_usd", "spent_usd"], path, issues);
    requireString(phase.id, `${path}.id`, issues);
    requireNumber(phase.ceiling_usd, `${path}.ceiling_usd`, issues);
    requireNumber(phase.spent_usd, `${path}.spent_usd`, issues);
    if (phase.economy !== undefined && phase.economy !== null) {
      requireEnum(phase.economy, ECONOMIES, `${path}.economy`, issues);
    }
    if (typeof phase.ceiling_usd === "number") sum += phase.ceiling_usd;
  });
  if (typeof doc.ceiling_usd === "number" && sum > doc.ceiling_usd + 1e-9) {
    issues.push({ path: "phases", message: `phase ceilings sum to ${sum} > ceiling_usd ${doc.ceiling_usd}` });
  }
  return result(issues, deprecations);
}

export function asRunBudget(input: unknown): RunBudget {
  const doc = input as Partial<RunBudget> & { phases: BudgetPhase[] };
  return {
    version: doc.version ?? 1,
    run: doc.run ?? "",
    ceiling_usd: doc.ceiling_usd ?? 0,
    per_agent_max_usd: doc.per_agent_max_usd ?? 0,
    warn_at_pct: doc.warn_at_pct ?? DEFAULT_WARN_AT_PCT,
    on_exceed: doc.on_exceed ?? "block",
    economy: doc.economy ?? DEFAULT_ECONOMY,
    phases: (doc.phases ?? []).map((phase) => ({
      id: phase.id,
      ceiling_usd: phase.ceiling_usd,
      spent_usd: phase.spent_usd,
      economy: phase.economy ?? null,
    })),
  };
}
