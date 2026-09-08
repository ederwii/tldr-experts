/** `tldrx-work/<run>/budget.yml` (spec §2.11) — the ceiling the facilitator refuses to exceed. */
import {
  asDocument, isRecord, requireArray, requireEnum, requireKeys, requireNumber, requireString,
  requireVersion, result, type ValidationIssue, type ValidationResult,
} from "../schemas/validation.ts";
import { SPENT_BASES, spentBasis, type SpentBasis } from "./spentFigure.ts";

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
 * What happens when a ceiling is WRITTEN above what the owner authorized (#170).
 *
 * Never `on_exceed`, and the argument is `ON_HOST_TOKENS_EXCEED`'s one domain
 * over: `on_exceed` governs SPENDING past a ceiling, this governs WRITING one
 * the owner forbade. A run that blocks on dollars has said nothing about
 * whether a ceiling above an authorization should be refused, and inferring one
 * from the other enforces a policy nobody asked for.
 *
 * `warn` is the default because it is what this file did before the key existed:
 * say so, never stop. `block` is the explicit opt-in.
 */
export const ON_GRANT_EXCEED = ["warn", "block"] as const;
export type OnGrantExceed = (typeof ON_GRANT_EXCEED)[number];

/** Absence means this: say so, never stop. */
export const DEFAULT_ON_GRANT_EXCEED: OnGrantExceed = "warn";

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
  /**
   * This phase's own authorization, or null when it declares none — in which
   * case the RUN's grant governs it (#170). Null, never 0: 0 is a ceiling
   * nothing could ever fit, and absent must never read as "the owner authorized
   * nothing".
   */
  readonly authorized_usd: number | null;
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
  /**
   * What the owner AUTHORIZED for this run, or null when no grant is recorded
   * (#170).
   *
   * ADDITIVE. Absent — every budget.yml on disk before this key — means "no
   * grant recorded, and nothing is reconciled". That is deliberately the LAX
   * side: absent read as `$0` would refuse every raise on every existing run,
   * which is exactly the argument `ceiling_host_tokens` won one domain over.
   */
  readonly authorized_usd: number | null;
  /**
   * The fact id the grant cites (`F031`), or null. A grant that cannot name a
   * decision is not recorded at all — `budget grant` refuses without `--fact`,
   * because a number with no decision behind it is a number nobody said.
   */
  readonly authorized_by: string | null;
  /** RFC3339, or null when unknown — every file written before this key. */
  readonly authorized_at: string | null;
  /**
   * Whether a ceiling above the grant warns or refuses. Absent means `warn`,
   * which is what this file did before the key existed.
   */
  readonly on_grant_exceed: OnGrantExceed;
  /**
   * How many of this run's task rows put NOTHING in the meter — `metered: false`,
   * the in-session `--commit` turns (defect 3 of the 2026-09-07 audit).
   *
   * `spent_usd` above stays exactly what it was: the sum of what WAS measured,
   * and therefore a lower bound. This is the number that says HOW MUCH of the
   * work that bound cannot see, so no reader has to open `run.yml` and count
   * rows to find out. Measured across 23 real runs: 45% of 845 task rows are
   * these, and two runs rendered `$0.00 spent` against $3,000 and $200 ceilings
   * because nothing in this file said so.
   *
   * ADDITIVE. Absent — every budget.yml written before this key — means "nobody
   * counted", which every renderer treats as `0` ONLY because `run.yml` is
   * always available to those renderers and is where they actually count. This
   * file records it so an archived budget.yml alone still tells the truth.
   */
  readonly unmetered_tasks: number;
  /**
   * `lower-bound` when `unmetered_tasks > 0`, `complete` otherwise — the one word
   * that stops a reader inferring it.
   *
   * Derived, and written anyway. The derivation is one comparison and this file
   * could have left it to the reader; the whole defect being fixed here is that
   * six different readers each inferred it differently and three inferred it as
   * "the number is the total". A file that states its own basis cannot be read
   * two ways. `budget/spentFigure.ts` owns the derivation, so the label and the
   * figure can never disagree.
   *
   * ADDITIVE. Absent means "not recorded"; `asRunBudget` reads it as
   * `complete` ONLY when `unmetered_tasks` is also absent or zero.
   */
  readonly spent_basis: SpentBasis;
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

/**
 * A recorded grant must be greater than zero (spec §2.11, fix round 2).
 *
 * `budget grant` has refused a non-positive amount since #170, and §2.11 types
 * both grant keys `number >0` — but the VALIDATOR only required a number, so a
 * hand-edited `authorized_usd: 0` loaded cleanly and `grantFor` returned a $0
 * grant that, under `on_grant_exceed: block`, refuses every later raise. That is
 * the state the CLI's own refusal argues against, reached by the other door: a
 * record must not be able to say what the verb that writes it will not write.
 *
 * Only a number that is PRESENT and non-positive is refused. Absence is untouched
 * and still means "no grant recorded", never `$0` — which is why this is a
 * separate check rather than a stricter `requireNumber`, and why it runs after
 * one: a non-number has already been reported by its own issue and does not need
 * a second, confusing one.
 */
function requirePositiveGrant(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (typeof value !== "number") return;
  if (value > 0) return;
  issues.push({
    path,
    message: "expected a grant greater than 0 — absence, not 0, means no grant was recorded",
  });
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
  // Optional, additive: how many turns went unmetered, and the one word for what
  // that makes `spent_usd`. Absent is a file written before they existed and is
  // read as "0 / complete" — see `asRunBudget`. A value this reader cannot
  // understand is refused rather than defaulted, the same rule `economy` follows:
  // a basis nothing here knows is not one it may quietly read as `complete`.
  if (doc.unmetered_tasks !== undefined && doc.unmetered_tasks !== null) {
    requireNumber(doc.unmetered_tasks, "unmetered_tasks", issues);
  }
  if (doc.spent_basis !== undefined && doc.spent_basis !== null) {
    requireEnum(doc.spent_basis, SPENT_BASES, "spent_basis", issues);
  }
  // Optional, additive (#170): what the owner AUTHORIZED, and the fact that says
  // so. Checked only when present and non-null — absent means "no grant
  // recorded", never `$0`, which would refuse every raise on every file on disk.
  //
  // There is deliberately NO rule relating a phase grant to the run grant, and
  // none relating either to `ceiling_usd`. A grant is what somebody said they
  // would pay; a ceiling is what this file will spend. Inventing arithmetic
  // between them would be enforcing a rule nobody stated — the reconciliation
  // lives in `budget/grant.ts`, where it is a policy with an enum, not a schema
  // error.
  if (doc.authorized_usd !== undefined && doc.authorized_usd !== null) {
    requireNumber(doc.authorized_usd, "authorized_usd", issues);
    requirePositiveGrant(doc.authorized_usd, "authorized_usd", issues);
  }
  if (doc.authorized_by !== undefined && doc.authorized_by !== null) {
    requireString(doc.authorized_by, "authorized_by", issues);
  }
  if (doc.authorized_at !== undefined && doc.authorized_at !== null) {
    requireString(doc.authorized_at, "authorized_at", issues);
  }
  // Refused rather than defaulted, for the same reason `on_host_tokens_exceed`
  // is: a policy this reader cannot honour is not one it may quietly downgrade.
  if (doc.on_grant_exceed !== undefined && doc.on_grant_exceed !== null) {
    requireEnum(doc.on_grant_exceed, ON_GRANT_EXCEED, "on_grant_exceed", issues);
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
    // Same rule, same reason (#170): checked only when present and non-null, and
    // never summed into anything — a phase grant is not required to fit the run
    // grant, because they answer two different questions.
    if (phase.authorized_usd !== undefined && phase.authorized_usd !== null) {
      requireNumber(phase.authorized_usd, `${path}.authorized_usd`, issues);
      requirePositiveGrant(phase.authorized_usd, `${path}.authorized_usd`, issues);
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
    // #170. The defaults live HERE, not in a `?:` on the interface: `?: T | null`
    // would make three states — missing, null, value — with no stated difference
    // between the first two and no mapper to collapse them.
    authorized_usd: doc.authorized_usd ?? null,
    authorized_by: doc.authorized_by ?? null,
    authorized_at: doc.authorized_at ?? null,
    on_grant_exceed: doc.on_grant_exceed ?? DEFAULT_ON_GRANT_EXCEED,
    // Tolerant read of a file written before either key existed: no unmetered
    // count, so no claim that the total is short — and `spentBasis(0)` is
    // `complete`, which is what such a file already MEANT by printing a bare
    // figure. `rollUpBudget` overwrites both from `run.yml` on the next save, so
    // an old file self-corrects the first time anything touches the run.
    unmetered_tasks: doc.unmetered_tasks ?? 0,
    spent_basis: doc.spent_basis ?? spentBasis(doc.unmetered_tasks ?? 0),
    phases: (doc.phases ?? []).map((phase) => ({
      id: phase.id,
      ceiling_usd: phase.ceiling_usd,
      spent_usd: phase.spent_usd,
      economy: phase.economy ?? null,
      ceiling_host_tokens: phase.ceiling_host_tokens ?? null,
      authorized_usd: phase.authorized_usd ?? null,
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
