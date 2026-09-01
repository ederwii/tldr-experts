/** `tldrx-work/<run>/budget.yml` (spec §2.11) — the ceiling the facilitator refuses to exceed. */
import {
  asDocument, isRecord, requireArray, requireEnum, requireKeys, requireNumber, requireString,
  requireVersion, result, type ValidationIssue, type ValidationResult,
} from "../schemas/validation.ts";

export const ON_EXCEED = ["block", "warn"] as const;
export type OnExceed = (typeof ON_EXCEED)[number];

/**
 * What a HOST-TOKEN ceiling does when the declared tokens cross it (issue #22,
 * owner decision 2026-09-01, policy (b)).
 *
 * Spelled as an enum beside `on_exceed`, and defaulting to `warn`, because the
 * two levers already in this file are enums and absence already means "the
 * behaviour this file had before the key existed". A token ceiling has never
 * stopped anything, so `warn` is that behaviour plus the sentence it was missing.
 *
 * `block` is the EXPLICIT OPT-IN the decision requires, and it is deliberately
 * separate from `on_exceed`: a run that blocks on dollars has said nothing about
 * whether a host session's own token allowance should stop the framework, and
 * inferring one from the other would enforce a ceiling nobody asked for.
 */
export const ON_HOST_TOKENS_EXCEED = ["warn", "block"] as const;
export type OnHostTokensExceed = (typeof ON_HOST_TOKENS_EXCEED)[number];

/** Absence means this: say so, never stop. */
export const DEFAULT_ON_HOST_TOKENS_EXCEED: OnHostTokensExceed = "warn";

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
  /**
   * This phase's HOST-TOKEN allowance (issue #61), or null when it declares
   * none. Read only under `economy: host-tokens`, where `ceiling_usd` is not
   * what governs; see `hostTokenCeiling` for the compat fallback.
   */
  readonly ceiling_host_tokens: number | null;
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
  /**
   * Whether crossing a `host-tokens` ceiling warns or stops (issue #22). ADDITIVE
   * and optional: absent — every budget.yml written before this key existed —
   * means `warn`, which is what a token ceiling has always done.
   */
  readonly on_host_tokens_exceed: OnHostTokensExceed;
  /**
   * The run's HOST-TOKEN allowance — the ceiling `ceiling_usd` is NOT (issue #61,
   * owner decision 2026-09-01). Null when the file declares none.
   *
   * SEPARATE, never a conversion. `ceiling_usd` is dollars by its name and by
   * every other use in this tree; a host-token allowance is a count of tokens in
   * somebody else's session. Summing one into the other is the category error
   * `economy:` exists to prevent, and until this key existed the phase-sum check
   * committed it — a 200 000-token phase ceiling read as $200 000 made a valid
   * file invalid, `RunStore.open` threw, and the budget-gate hook then denied
   * every spawn on the run (#61, measured).
   *
   * ADDITIVE and optional. Absent — every budget.yml written before this key —
   * means the token sum has nothing to compare against, so it is not checked.
   * That is deliberately the LAX side: the alternative is comparing a token total
   * to a dollar figure, which is the bug.
   */
  readonly ceiling_host_tokens: number | null;
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
  // Optional, additive: absent means `warn`. Refused rather than defaulted for
  // the same reason `economy` is — a policy this reader cannot honour is not one
  // it may quietly downgrade.
  if (doc.on_host_tokens_exceed !== undefined && doc.on_host_tokens_exceed !== null) {
    requireEnum(doc.on_host_tokens_exceed, ON_HOST_TOKENS_EXCEED, "on_host_tokens_exceed", issues);
  }
  // Optional, additive: a number of HOST TOKENS. Absent means "no token ceiling
  // is declared", never "zero" and never "read `ceiling_usd` instead".
  if (doc.ceiling_host_tokens !== undefined && doc.ceiling_host_tokens !== null) {
    requireNumber(doc.ceiling_host_tokens, "ceiling_host_tokens", issues);
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
  // ONE SUM PER ECONOMY (issue #61, owner decision 2026-09-01). A phase priced in
  // `host-tokens` carries a number that is not dollars, so it is not summed with
  // dollars and is not compared against `ceiling_usd`. There is no exchange rate
  // here and inventing one would be a guess about a price.
  const runEconomy = (ECONOMIES as readonly unknown[]).includes(doc.economy)
    ? doc.economy as Economy
    : DEFAULT_ECONOMY;
  let sum = 0;
  let tokenSum = 0;
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
    if (phase.ceiling_host_tokens !== undefined && phase.ceiling_host_tokens !== null) {
      requireNumber(phase.ceiling_host_tokens, `${path}.ceiling_host_tokens`, issues);
    }
    const economy = (ECONOMIES as readonly unknown[]).includes(phase.economy)
      ? phase.economy as Economy
      : runEconomy;
    if (economy === "host-tokens") {
      // COMPAT: a file written before `ceiling_host_tokens` existed put the token
      // allowance in `ceiling_usd`, and `hostTokenCeiling` reads it there. The sum
      // reads it the same way, so the two never disagree about what this phase's
      // ceiling IS.
      const tokens = typeof phase.ceiling_host_tokens === "number"
        ? phase.ceiling_host_tokens
        : typeof phase.ceiling_usd === "number" ? phase.ceiling_usd : 0;
      tokenSum += tokens;
      return;
    }
    if (typeof phase.ceiling_usd === "number") sum += phase.ceiling_usd;
  });
  if (typeof doc.ceiling_usd === "number" && sum > doc.ceiling_usd + 1e-9) {
    issues.push({ path: "phases", message: `phase ceilings sum to ${sum} > ceiling_usd ${doc.ceiling_usd}` });
  }
  // Checked ONLY against a declared token ceiling. A file with token-priced phases
  // and no `ceiling_host_tokens` has said nothing to compare them to, and the one
  // other number on the run is dollars — see the field's own comment.
  if (typeof doc.ceiling_host_tokens === "number" && tokenSum > doc.ceiling_host_tokens + 1e-9) {
    issues.push({
      path: "phases",
      message: `phase host-token ceilings sum to ${tokenSum} > ceiling_host_tokens ${doc.ceiling_host_tokens}`,
    });
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
    on_host_tokens_exceed: doc.on_host_tokens_exceed ?? DEFAULT_ON_HOST_TOKENS_EXCEED,
    ceiling_host_tokens: doc.ceiling_host_tokens ?? null,
    phases: (doc.phases ?? []).map((phase) => ({
      id: phase.id,
      ceiling_usd: phase.ceiling_usd,
      spent_usd: phase.spent_usd,
      economy: phase.economy ?? null,
      ceiling_host_tokens: phase.ceiling_host_tokens ?? null,
    })),
  };
}

/**
 * The host-token allowance governing a phase, or null when it is not priced in
 * tokens (issue #22).
 *
 * Under `economy: host-tokens` the ceiling NUMBER is a host-session token
 * allowance and not dollars — that is what the label means and why the two are
 * never converted.
 *
 * TWO PLACES it can be written, and the order matters (issue #61):
 *
 *  - `ceiling_host_tokens`, the field that means tokens and nothing else. This
 *    is where an operator should put it, and it wins wherever it is present.
 *  - `ceiling_usd`, the COMPAT reading. Before the token field existed the file
 *    had one scalar per phase with no unit on it, and f353d8d read that scalar as
 *    the token allowance under this economy. Files written that way are still on
 *    disk and still resume, so they are still read that way. Renaming or
 *    dropping the fallback would break them for no gain in truth.
 */
export function hostTokenCeiling(budget: RunBudget | null, phaseId?: string | null): number | null {
  if (budget === null || !isHostTokens(budget, phaseId)) return null;
  if (phaseId !== undefined && phaseId !== null) {
    const phase = budget.phases.find((entry) => entry.id === phaseId);
    if (phase !== undefined) return phase.ceiling_host_tokens ?? phase.ceiling_usd;
  }
  return budget.ceiling_host_tokens ?? budget.ceiling_usd;
}
