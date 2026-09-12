/**
 * `tldrx-work/<run>/run.yml` (spec §2.2) — the execution path and the only resume
 * point.
 *
 * Note for archaeologists: `src/core/schemas/run.ts` validates the *draft*
 * skeleton shape (`schema_version`, `run_id`, flat `phases[]`) that shipped before
 * the spec settled. This file is the spec §2.2 shape — `version: 1`, `run`,
 * `cursor`, phases-of-stages-of-tasks — which is what `run new` writes, the
 * fixtures carry, and the hooks already read. Do not merge the two: the old one
 * still guards the old templates.
 */
import {
  asDocument, isRecord, requireArray, requireEnum, requireKeys, requireNumber, requireString,
  requireVersion, result, type ValidationIssue, type ValidationResult,
} from "../schemas/validation.ts";
import { GATE_POLICIES, validateGatesPolicy, type GatePolicy, type GatesPolicy } from "./gatePolicy.ts";
import { BRANCH_MODELS, isBranchModelKind, type BranchModelKind } from "../plan/branchModel.ts";
import {
  EVIDENCE_ROLES, EVIDENCE_VERDICTS, type EvidenceRole, type EvidenceVerdict,
} from "../text/evidence.ts";
import { DURATION_BASES, type DurationBasis } from "./duration.ts";
import { AUTO_MERGE_POLICIES, type ShipPolicy } from "./shipPolicy.ts";

/** One enum, all three levels (spec §2.2). */
export const STAGE_STATUSES = [
  "pending", "ready", "running", "awaiting_answer", "awaiting_gate", "blocked",
  "done", "failed", "skipped", "cancelled",
] as const;
export type StageStatus = (typeof STAGE_STATUSES)[number];

export const TERMINAL_STATUSES: readonly StageStatus[] = ["done", "failed", "skipped", "cancelled"];

export const GATE_TYPES = ["approve", "checks", "auto"] as const;
export type GateType = (typeof GATE_TYPES)[number];

export const GATE_STATUSES = ["pending", "approved", "rejected", "n-a"] as const;
export type GateStatus = (typeof GATE_STATUSES)[number];

/**
 * Who drives this run (spec §2.2, `attended_by`).
 *
 * One legal value today, and the enum exists so a second one is a schema change
 * rather than a string comparison somewhere. `host` means a host session is doing
 * the turns: the framework writes bundles and judges results, and never spawns.
 */
export const ATTENDED_BY = ["host"] as const;
export type AttendedBy = (typeof ATTENDED_BY)[number];

export const RUN_ID_RE = /^\d{6}-[a-z0-9-]{1,40}$/;
export const PHASE_ID_RE = /^0[1-5]-[a-z]+$/;

/** Spec §2.2 caps. */
export const MAX_PHASES = 5;
export const MAX_STAGES = 40;
export const MAX_TASKS = 200;

/**
 * What an `agent` gate was signed over (design §A.5), recorded on the gate itself.
 *
 * The headline counts, plus a pointer at the note they came from — the COMMITTED
 * copy under `<phase>/gate-evidence/<stage>.md`, not the gitignored scratch file
 * the agent wrote. A gate whose evidence lives only in `.agent/` is a gate nobody
 * can audit from a clone.
 *
 * ADDITIVE and optional. Every `run.yml` written before this — and every gate a
 * person or the facilitator closes — has no `evidence` key at all, and the
 * validator has never rejected an unknown key inside `gate:` (measured: a run.yml
 * carrying this block validates against the reader that predates it), so the two
 * directions cross without a shim.
 */
export interface RunGateEvidence {
  /** Run-relative path of the committed copy. */
  readonly path: string;
  readonly role: EvidenceRole;
  readonly verdict: EvidenceVerdict;
  readonly sampled: number;
  readonly of: number;
  readonly resolved: number;
  readonly refuted: number;
  readonly outside_surface: number;
}

/**
 * WHAT KIND of entity evaluated a gate (issue #122).
 *
 * `human` is a person at a terminal. `auto` is the facilitator closing its own
 * seven conditions. `agent` is a sub-agent that wrote an evidence note and signed
 * over it — and it is the one that needed saying out loud, because the name such
 * an agent records is the OPERATOR's, not its own.
 */
export const GATE_EXECUTOR_TYPES = ["human", "agent", "auto"] as const;
export type GateExecutorType = (typeof GATE_EXECUTOR_TYPES)[number];

/** Whether the executor held the authority itself, or was lent it (issue #122). */
export const GATE_AUTHORITY_TYPES = ["direct", "delegated"] as const;
export type GateAuthorityType = (typeof GATE_AUTHORITY_TYPES)[number];

/**
 * HOW the authorizer was established — the evidence, recorded beside the claim.
 *
 * `self` is a person signing as themselves. `run.created` is a policy frozen at
 * `run new` by whoever opened the run. `gate.policy_changed` is a policy moved
 * afterwards by `tldrx run gates set`, and names THAT signer. `unrecorded` is the
 * honest fourth: the log does not say, so nothing is claimed and
 * `authorized_by` is null.
 */
export const GATE_AUTHORITY_SOURCES = ["self", "run.created", "gate.policy_changed", "unrecorded"] as const;
export type GateAuthoritySource = (typeof GATE_AUTHORITY_SOURCES)[number];

/**
 * Which entity actually evaluated this gate (issue #122).
 *
 * `id` is the name that entity signed under, and it is ABSENT for `auto`: the
 * facilitator is a role, not an identity, and `by: auto` already carries it.
 */
export interface RunGateExecutor {
  readonly type: GateExecutorType;
  readonly id?: string;
}

/**
 * The authority the executor acted under (issue #122).
 *
 * `policy` is the run's frozen `gates_policy` for this stage at the moment of
 * signing. `authorized_by` is who granted it, and `source` says how that was
 * established — including `unrecorded`, which is what an absence is called here
 * rather than guessed at.
 */
export interface RunGateAuthority {
  readonly type: GateAuthorityType;
  readonly policy: GatePolicy;
  readonly authorized_by: string | null;
  readonly source: GateAuthoritySource;
}

export interface RunGate {
  readonly type: GateType;
  readonly status: GateStatus;
  readonly by: string | null;
  readonly at: string | null;
  readonly note: string;
  /** Present only on a gate an `agent` policy closed (design §A.5). */
  readonly evidence?: RunGateEvidence;
  /**
   * Which entity evaluated this gate, and under whose authority (issue #122).
   *
   * ADDITIVE and optional, both of them. A `run.yml` written before these keys
   * existed has neither, `by:` means exactly what it always meant, and every
   * reader falls back to it — the gate mapping has never rejected an unknown
   * key, so the two directions cross without a shim. Written together by
   * `approve`, and cleared together by a revoke: a gate nobody has signed has no
   * executor.
   */
  readonly executed_by?: RunGateExecutor;
  readonly authority?: RunGateAuthority;
  /**
   * What the REJECTION asked for, when it asked for anything (gh #242).
   *
   * `tldrx reject` covers two different acts under one verb: "stop, I will look"
   * and "redo it this way and carry on". Only the second one is written here, by
   * `tldrx reject --and-continue`, and it is the bit an unattended `run auto`
   * reads off this same gate object to decide whether to re-run the stage or stop.
   *
   * ADDITIVE, optional, and only ever `true`: absent means stop, which is what
   * every gate written before this key existed says and what a bare rejection
   * still says today. It is written by `reject` and cleared when the stage parks
   * on its gate again, so it never outlives the rejection it describes.
   */
  readonly and_continue?: true;
}

export interface RunTask {
  readonly id: string;
  readonly status: StageStatus;
  /**
   * The STAGE's expert — one value for every row of the stage, written from
   * `stage.experts[0]`. It is NOT who took this turn: see `role`.
   */
  readonly expert: string | null;
  /**
   * Which ROLE took this turn — `"developer"` or `"reviewer"` today (gh #234).
   *
   * ADDITIVE and optional, and a NEW key rather than a new meaning for `expert`:
   * a Build stage declares `experts: [developer]` and runs both roles under it,
   * so every row — the reviewer's included — said `developer`, and `run.yml`
   * asserted something false about who did the work. Absent means no executor
   * recorded one, which is every row written before this key existed and every
   * path that cannot say; absent reads as "not recorded" and never as a guessed
   * `developer`.
   */
  readonly role?: string;
  readonly model: string | null;
  /**
   * What the turn cost — or `null` when nobody could say.
   *
   * `null` is the in-session case (spec §5, `--commit`): the sub-agent ran inside
   * the host's own session, its usage was billed to that session, and unless the
   * host DECLARES a number with `--cost-usd` there is none to record. That used to
   * be written as `0`, which is a measurement, and a false one — a run's ledger
   * added up to `$0.00 spent` after real money had been spent (2026-08-29 audit,
   * §A). `null` says "unmetered"; every sum treats it as contributing nothing,
   * which is the only honest arithmetic, and every REPORT says so out loud.
   */
  readonly cost_usd: number | null;
  /**
   * False when this task's cost is unmetered. ADDITIVE and optional: absent means
   * metered, which is every task written before this existed and every headless
   * spawn, where the envelope's `total_cost_usd` is a real reconciled number.
   */
  readonly metered?: boolean;
  readonly error: string | null;
  readonly session_id: string | null;
  readonly started_at: string | null;
  readonly ended_at: string | null;
  readonly outputs: readonly string[];
  /**
   * Why the attempt stopped, when a LIMIT stopped it rather than the model
   * finishing: `"max_reads"` today (spec §5). Null or absent on every ordinary
   * attempt, so `run.yml` is unchanged unless a cap actually bit — "it ran out of
   * reads" and "it crashed" are different stories and the file must tell them
   * apart.
   */
  readonly stopped_by?: string | null;
  /** Tokens the host declared with `--tokens`, when it knew them. */
  readonly tokens?: number;
  /**
   * The PROVIDER's own token split for this turn, when a turn this process watched
   * reported one (`AgentOutcome.usage`), and reported it as a POSITIVE number on
   * both sides.
   *
   * ADDITIVE and optional, and deliberately NOT the same field as `tokens`: that
   * one is what a HOST declared with `--tokens` for a turn nothing here metered.
   * These two are a measurement, and they are what makes a dollar figure
   * checkable against a price table instead of a number nobody can falsify.
   *
   * Absent on every row written before this existed and on every turn whose
   * result document reported no usage at all — but the parse that produces
   * `AgentOutcome.usage` (`envelope.ts`'s `toUsage`/`EMPTY_USAGE`) collapses "no
   * usage object at all" and "usage reported as exactly 0" into the identical
   * shape, so this layer cannot tell those two apart, and a HALF-reported split
   * (one side a real number, the other defaulted by the parse) is exactly as
   * unverifiable as a fully-absent one. Absent therefore means "no POSITIVE
   * split reached the ledger" — an honest absence covering all three of those
   * cases, never an invented number standing in for any of them.
   */
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  /**
   * Prompt-cache accounting for the same turn (gh #222). ADDITIVE, and gated
   * SEPARATELY from the split above — see `runNext.ts`'s `cacheSplit`: a cache
   * WRITE and a cache READ are never added to each other or to anything else
   * (they are priced at 1.25x and 0.1x an input token), so each is written on
   * its own evidence, and a turn that only read the cache records the read
   * alone. Without them a row could say `input_tokens: 84, cost_usd: 1.98` for a
   * turn the provider billed 4,911,750 cache reads for — a dollar figure with
   * nothing on the row able to explain it.
   *
   * Absent means "no positive counter reached the ledger": every row written
   * before these existed, and every turn whose result document reported none.
   * Never a zero standing in for one.
   */
  readonly cache_creation_input_tokens?: number;
  readonly cache_read_input_tokens?: number;
  /**
   * True when `--commit` recorded this row AHEAD of refusing on an unreadable
   * `questions.md` (spec's ledger-before-refusal rule, gh #124) — the ONLY
   * case where the same `result.json` is expected to come back through
   * `--commit` a second time, because the refusal leaves the stage `running`
   * for the operator to fix the file and re-run. ADDITIVE and optional: absent
   * on every ordinary completed task (including one later sent back by a gate
   * reject and retried) and on every `run.yml` written before this existed.
   *
   * This is what a re-run's fingerprint (`runNext.ts`'s `alreadyBanked`) is
   * allowed to match against — and ONLY this. A stage that was gate-rejected
   * and retried leaves its earlier task rows in place with `status: "done"`
   * and no refusal ever attached to them; without this marker a second,
   * genuinely distinct attempt that happened to share a cost (most plausibly
   * `null`, the unmetered case) and the same output paths would silently match
   * an unrelated earlier row and be dropped — the ledger forgetting a turn,
   * which is the exact failure this field exists to prevent.
   */
  readonly banked_before_refusal?: true;
  /**
   * One sentence about this row's part in the banked-turn dedupe, in the two
   * cases where the file would otherwise not explain itself:
   *
   *   - `"none — no session id"` on a row recorded as its OWN rather than
   *     matched against an earlier `banked_before_refusal` row its cost and
   *     outputs resemble, because the result carried no `session_id` to
   *     fingerprint on — so it could not be told apart from a second, genuinely
   *     distinct unmetered turn (a null session id is NEVER used to dedupe, see
   *     `alreadyBanked`).
   *   - `"matched by the re-run committed at <at> — the marker is spent"` on a
   *     `banked_before_refusal` row whose re-run has ARRIVED and been matched to
   *     it. The marker is a claim ticket for exactly one re-run; leaving it
   *     armed made the row match every later turn of the same shape for the life
   *     of the stage, and the ledger dropped real turns for it. Its presence is
   *     what `alreadyBanked` reads as "already claimed".
   *
   * ADDITIVE and optional: absent on every row neither thing happened to, and on
   * every `run.yml` written before this existed.
   */
  readonly dedupe?: string;
  /**
   * How long this ATTEMPT took, in milliseconds — measured, never subtracted
   * from the two timestamps above (#184).
   *
   * `started_at` is the INVOCATION's clock (`options.at`) and `ended_at` is the
   * instant the row was written, so on a parallel Build every task of one
   * invocation shares one `started_at` and their `ended_at`s are the write-out
   * order. Subtracting them yields close to the whole invocation for every task
   * in it. Those fields keep their documented meaning — §7 forbids changing one —
   * and this is the new one that carries a real span.
   *
   * ADDITIVE and optional. Absent means NOT RECORDED: every row written before
   * this existed, and every row whose span nothing here could see. Never `0`,
   * which would say the turn was instantaneous.
   */
  readonly duration_ms?: number;
  /**
   * WHICH span `duration_ms` is — `spawned` or `prepare-to-commit`. Written
   * together with it, always, because the two are different quantities and a
   * number without its basis is one a reader will average with the other.
   * See `run/duration.ts`'s `DURATION_BASES`.
   */
  readonly duration_basis?: DurationBasis;
}

export interface RunStage {
  readonly id: string;
  readonly status: StageStatus;
  readonly expert: string | null;
  readonly model: string | null;
  readonly budget_usd: number;
  readonly cost_usd: number;
  readonly started_at: string | null;
  readonly ended_at: string | null;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly gate: RunGate;
  readonly tasks: readonly RunTask[];
  /**
   * True when an EARLIER stage's gate was revoked (`tldrx reject --stage`) after
   * this one had already run. ADDITIVE and optional: absent on every run written
   * before revocation existed, and absent again the moment the stage re-runs.
   *
   * The stage's outputs are deliberately left on disk — money was spent producing
   * them and they are often still 90% right — but they were derived from a
   * decision that has since been withdrawn, and nothing may quietly treat them as
   * current. `run status` says so; `next` re-runs the stage and clears the flag.
   */
  readonly stale?: boolean;
}

export interface RunPhase {
  readonly id: string;
  readonly status: StageStatus;
  readonly stages: readonly RunStage[];
}

export interface RunCursor {
  readonly phase: string;
  readonly stage: string;
  readonly task: string | null;
}

/**
 * run.yml's budget block — a MIRROR, and only `spent_usd` is live (#236).
 *
 * `ceiling_usd` and `per_agent_max_usd` are the values the run was CREATED with
 * (`newRun.ts`). Nothing updates them: `budget raise` writes budget.yml, and
 * `RunStore.save()` carries whatever this store loaded straight back out
 * (`rollUp`), so a raise that lands while a hosted run holds the file is reverted
 * here on that run's next save. That is why they are documented rather than
 * synchronised — the live ceiling lives in budget.yml, which `save()` re-reads
 * from disk before every write (`ceilingsToWrite`) and which every money decision
 * and every live display already reads. The keys stay because a `version: 1`
 * format only grows (§7) and all three are REQUIRED by the v1 schema; what
 * changed in #236 is not their meaning — they were always the creation figures —
 * but that nothing reads them as if they were the current ones.
 *
 * `spent_usd` is the exception and IS re-derived on every save. So this block is
 * HALF LIVE, and that is the trap: printing `spent_usd` and `ceiling_usd` from it
 * as one sentence pairs two different moments, and produces `$12.00 spent of
 * $10.00 ceiling` on any run whose ceiling was raised. A pre-merge review caught
 * exactly that in `tldrx replay` while #236 was being fixed. Read the ceiling from
 * budget.yml; for a read-only view, `replay/loadRun.ts` has already done it.
 */
export interface RunBudgetMirror {
  readonly ceiling_usd: number;
  readonly spent_usd: number;
  readonly per_agent_max_usd: number;
}

/**
 * Where this run came from, when `tldrx seed apply` created it (spec §6.2).
 *
 * Optional and additive: a run created by `run new` has no `triage:` key at all,
 * every reader that never heard of it is unaffected, and `run status` does not
 * mention it. It exists so a run can say which split proposed it and which of its
 * siblings were meant to land first — the one piece of the triage that would
 * otherwise live only in a file nobody opens again.
 */
export interface RunTriage {
  /** Workspace-relative path of the `split.yml` this run came out of. */
  readonly split: string;
  /** Slugs of the sibling runs this one was proposed to follow. */
  readonly depends_on: readonly string[];
  /**
   * What produced this run's ceiling (#170), or absent — which is what every
   * run written before this key existed means.
   *
   * `applySplit` writes `model-guess` because that is measurably what produced
   * it: `triagePrompt.ts:249` tells the model "`budget_usd` is a guess … S ≈ $10,
   * M ≈ $25, L ≈ $50", and `splitFile.ts:213-215` validates only "finite and > 0".
   * A ceiling that enforces every spawn in the run should say when it was a guess.
   */
  readonly budget_basis?: TriageBudgetBasis;
}

/** Where a triaged run's `--budget` figure came from. */
export const TRIAGE_BUDGET_BASES = ["model-guess", "owner-grant", "preset"] as const;
export type TriageBudgetBasis = (typeof TRIAGE_BUDGET_BASES)[number];

/**
 * Why this run was closed by hand (`tldrx run cancel`).
 *
 * Optional and ADDITIVE, exactly like `triage`: a run nobody cancelled has no
 * `cancelled:` key at all and every reader that never heard of it is unaffected.
 *
 * It is a run-level field rather than a stage status because the run that most
 * needs cancelling is one whose stage FAILED — and there is no way to say
 * "cancelled" through the stages of such a run without overwriting the failure,
 * which is history, not state. So the stages keep what happened to them and the
 * run carries the decision.
 */
export interface RunCancellation {
  readonly by: string;
  readonly at: string;
  readonly note: string;
}

/**
 * What the Build phase has claimed on disk, so a later run can tell "I cut this"
 * from "this was already here" (spec §5).
 *
 * `epic_branch` is a LIST because a run's plan can hold several epics; the key is
 * named for what each entry is. Optional and additive: absent until a Build stage
 * cuts or adopts an epic branch, and every reader that never heard of it is
 * unaffected.
 */
export interface RunBuild {
  readonly epic_branch: readonly string[];
  /**
   * Which branch model this run's Build is executing (issue #57): `per-epic`,
   * or `integration` when the plan's epics form a dependency chain and every
   * story merges into one branch.
   *
   * ADDITIVE and optional, and that is what makes the change backward-safe. A
   * `run.yml` written before this key existed — the three closed runs, and any
   * run mid-flight — has `epic_branch` and no model, and the executor reads that
   * absence as "keep the branches you already cut". The key is only ever written
   * by the Build executor, which records the model it actually used.
   */
  readonly branch_model?: BranchModelKind;
}

/**
 * `ship:` on `run.yml` (spec §2.2, gh #253) — ADDITIVE and optional.
 *
 * The DECISION half is `ShipPolicy`, frozen at `run new --ship` the way
 * `gates_policy` is: what the run may do to its epic branch once every gate is
 * signed. The RECORD half is written once, by `tldrx ship` — from `run auto` when
 * the run closes under it, or typed by a person — and says what was actually done:
 * the PR URLs `gh` printed, what became of the merge, and when. `shipped_at` is
 * the idempotence key (`shipPolicy.ts`, `shipWanted`).
 *
 * Absent on every run.yml written before this key existed, and on every run
 * opened without `--ship`: nothing is pushed, nothing is opened, and `tldrx ship`
 * refuses an unpushed branch exactly as it always did. `version: 1` grows (§7).
 */
export interface RunShip extends ShipPolicy {
  /** One URL per repo the PR was opened in, in the run's repo order. `[]` under `pr: false`. */
  readonly pr_urls?: readonly string[];
  /**
   * What became of the merge: `queued` (`gh pr merge --auto` accepted), `never`
   * (the policy), `absent — no checks to wait on` (§7: the merge was NOT armed,
   * and this is why), or `failed — <gh's first line>`. Free text on purpose — the
   * failure case carries a sentence — so a reader compares against the exported
   * constants rather than an enum this file would have to grow for every reason.
   */
  readonly merge?: string;
  /**
   * Repo name → that repo's merge state, in the same words as `merge` — the
   * per-repo truth `merge` summarises (one sentence when every repo agrees,
   * `repo: state; …` otherwise). It exists because a re-run has to know WHICH
   * repo still owes a merge: `tldrx ship` typed again after a partial failure
   * arms a repo recorded `failed — …`, leaves one recorded `queued` alone, and
   * writes the union — so a recorded failure is never erased by the command that
   * was supposed to fix it (review of 1fdc250, §7).
   */
  readonly merges?: Readonly<Record<string, string>>;
  /** When the record was LAST written. Present ⇒ `run auto` ships nothing again; `tldrx ship` typed again is the recovery. */
  readonly shipped_at?: string;
}

/**
 * How much of what the run set out to build actually landed.
 *
 * `n/a` is the fourth and it is not a failure: a docs-scope run has no Build
 * stage, so no story could be delivered and a `nothing-delivered` there would be
 * an accusation rather than a measurement.
 */
export const RUN_OUTCOME_KINDS = ["delivered", "partial", "nothing-delivered", "n/a"] as const;
export type RunOutcomeKind = (typeof RUN_OUTCOME_KINDS)[number];

/**
 * `outcome:` on `run.yml` (spec §2.2) — ADDITIVE and optional.
 *
 * A run.yml written before this key existed has none, and every reader prints
 * `OUTCOME_NOT_RECORDED`'s sentence for that rather than guessing at what a run
 * from before the field delivered. `version: 1` grows (§7).
 *
 * The counts are absent for `n/a` for the same reason: `stories_total: 0` on a
 * docs run is a confident zero about a plan that never existed, and `why` is the
 * sentence that says which absence it is.
 */
export interface RunOutcome {
  readonly kind: RunOutcomeKind;
  /** Present only for `n/a`: WHICH absence this is, in words. */
  readonly why?: string;
  readonly stories_done?: number;
  readonly stories_total?: number;
  readonly stories_blocked?: number;
  /** `S1 — <reason>`, absent when nothing was blocked. */
  readonly first_blocked?: string;
}

/**
 * What a run says about the tldrx that wrote it, when it says nothing (#183).
 *
 * A constant rather than a literal at four call sites, because `run status`, the
 * spec and two tests all have to spell the same absence — and "not recorded" is
 * the wording `duration.ts` and `spendBasis.ts` already use for the same class of
 * fact. An absent version is not `0.0.0` and not "unknown": it is a run written
 * by a tldrx from before the field existed, which is a knowable thing to say.
 */
export const VERSION_NOT_RECORDED = "not recorded";

/** What a run.yml from before `outcome:` existed says, and it says it in words (#210). */
export const OUTCOME_NOT_RECORDED =
  "not recorded — this run.yml was written before `outcome:` existed, and nothing can derive it now";

/** `created_with` / `last_written_by`, or the absence sentence. Never invented. */
export function recordedVersion(value: string | undefined): string {
  return value === undefined || value === "" ? VERSION_NOT_RECORDED : value;
}

export interface RunFile {
  readonly version: number;
  /**
   * The tldrx that CREATED this run — `frameworkVersion()`'s answer at
   * `run new` / `seed apply`, stamped once and never rewritten (#183).
   *
   * NOT `version:` above, which is the FILE FORMAT's number and only ever grows
   * by the §7 rule. This is the framework's, and the two are next to each other
   * on purpose: 23 real runs carried the first and none carried the second, so
   * no run could say which release's behaviour produced it — and behaviour moved
   * ten times in the week those runs were recorded.
   *
   * ADDITIVE and optional: absent on every run.yml written before it existed,
   * and every reader prints `recordedVersion()`'s sentence for that, never a
   * guess at what was installed that day.
   */
  readonly created_with?: string;
  /**
   * The tldrx of the LAST save — rewritten by `RunStore.rollUp` on every write.
   *
   * The second half of the same question, and the half that matters for a run
   * that outlived an upgrade: a run created on 0.9.0 and finished on 0.11.0 was
   * driven by both, and one field cannot say that. Together they bound it.
   *
   * ADDITIVE and optional for the same reason as `created_with`; a run that has
   * not been saved since the field arrived carries neither.
   */
  readonly last_written_by?: string;
  readonly run: string;
  readonly title: string;
  readonly scope: string;
  readonly workflow: string;
  readonly repos: readonly string[];
  readonly created_at: string;
  readonly updated_at: string;
  readonly status: StageStatus;
  readonly cursor: RunCursor;
  readonly budget: RunBudgetMirror;
  /** Present only on a run created by `tldrx seed apply`. */
  readonly triage?: RunTriage;
  /** Present only on a run closed by `tldrx run cancel`. */
  readonly cancelled?: RunCancellation;
  /** Present only once a Build stage has cut or adopted an epic branch. */
  readonly build?: RunBuild;
  /**
   * Who approves each stage's gate (spec §2.2). ADDITIVE and optional: a run.yml
   * written before this key existed has no policy, and `gatePolicyFor` reads that
   * absence as `human` for every stage — exactly the behaviour it had.
   */
  readonly gates_policy?: GatesPolicy;
  /**
   * Who drives the turns. ADDITIVE and optional: absent — the default, and every
   * run.yml written before this key existed — means the framework may spawn, and
   * every path behaves exactly as it did.
   *
   * `host` says a host session is doing the work. `tldrx next` then refuses the
   * headless mode outright (exit 4, naming the `--prepare` command), `run auto`
   * refuses at the CLI, and no run path can reach `spawnAgent` — the guard in
   * `facilitator/attended.ts` is what makes that last one enforced rather than
   * merely arranged. The affordance was missing at the RUN level: `--prepare` is
   * per invocation, and one bare `tldrx next` on a Build stage ran the whole
   * remaining plan as paid spawns (measured 2026-08-30, $9.95 of headless deaths).
   */
  readonly attended_by?: AttendedBy;
  /**
   * `--keep-worktrees`, remembered (issue #16, owner decision 2026-09-01).
   *
   * ADDITIVE and optional: absent — every run.yml written before this key
   * existed — means "clean the epic worktrees up when the run closes", which is
   * the decided default and the behaviour every such run already had.
   *
   * It is on the RUN rather than left in `argv` because the flag is typed on the
   * `tldrx next` that BUILDS and the run is usually closed by a different command
   * in a different process — `tldrx approve` signing the last gate, or
   * `tldrx run cancel` days later. A flag those never see cannot be honoured by
   * them, and "survive even run close" is exactly what the flag was decided to
   * mean, so the intent is recorded once, where every close path can read it.
   */
  readonly keep_worktrees?: boolean;
  /**
   * What this run DELIVERED, written once when it closes (gh #210).
   *
   * ADDITIVE and optional, and the absence is a fact with a name: a run.yml
   * written before this key existed reads `OUTCOME_NOT_RECORDED`, never
   * `delivered` and never a zero. `version: 1` grows (§7).
   *
   * It is a run-level record and not a roll-up of stage statuses because those
   * are exactly what lied: every stage of a run whose stories all blocked is
   * terminal, so `deriveRunStatus` calls the run `done` — correctly, since the
   * PATH finished — and nothing anywhere said the path had delivered nothing.
   */
  readonly outcome?: RunOutcome;
  /**
   * How far past the last gate the framework may carry the epic, and what it did
   * (gh #253). ADDITIVE and optional: absent — every run.yml written before this
   * key, and every run opened without `--ship` — means push nothing, open nothing.
   */
  readonly ship?: RunShip;
  readonly phases: readonly RunPhase[];
}

export function isTerminal(status: string): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/**
 * Finished for good — nothing an operator can do will move it.
 *
 * `failed` is terminal for the ATTEMPT but not for the run: spec §5's failure
 * path gives the operator `next` (retry) and `reject --note`, so a failed run is
 * still the live run and must stay findable. Everything that asks "is this run
 * over?" asks this, not `isTerminal`.
 */
export function isFinished(status: string): boolean {
  return status === "done" || status === "cancelled";
}

/**
 * Is a host session driving this run? The one question every refusal asks.
 *
 * A function rather than `run.attended_by === "host"` at six call sites, so the
 * day a second value exists there is one place that decides what it means.
 */
export function isAttendedByHost(run: RunFile): boolean {
  return run.attended_by === "host";
}

/** Every stage in execution order, paired with its phase. */
export function flatten(run: RunFile): readonly { phase: RunPhase; stage: RunStage }[] {
  const out: { phase: RunPhase; stage: RunStage }[] = [];
  for (const phase of run.phases) for (const stage of phase.stages) out.push({ phase, stage });
  return out;
}

export function stageAt(run: RunFile, cursor: RunCursor): { phase: RunPhase; stage: RunStage } | null {
  return flatten(run).find((e) => e.phase.id === cursor.phase && e.stage.id === cursor.stage) ?? null;
}

/**
 * Spec §2.2: "Run status = status of the stage at cursor, or done when every phase
 * is terminal." A failed stage is checked FIRST, because a run holding one is not
 * done — calling it done hides the failure and makes `next` refuse the retry the
 * spec's failure path promises.
 */
export function deriveRunStatus(run: RunFile): StageStatus {
  const all = flatten(run);
  // A cancellation is a DECISION, not a roll-up, so it is read before anything is
  // derived. It has to come first: the run most often cancelled is one whose
  // stage failed, and a failure checked first would make such a run impossible to
  // close — it would stay `failed`, stay open, and keep appearing in every
  // id-less command's ambiguity list forever.
  if (run.cancelled !== undefined) return "cancelled";
  if (all.some((e) => e.stage.status === "failed")) return "failed";
  if (all.length > 0 && all.every((e) => isTerminal(e.stage.status))) return "done";
  return stageAt(run, run.cursor)?.stage.status ?? "pending";
}

/** A phase wears a failure first, is done when every stage is terminal, else its first live stage's status. */
export function derivePhaseStatus(phase: RunPhase): StageStatus {
  if (phase.stages.length === 0) return "skipped";
  if (phase.stages.some((s) => s.status === "failed")) return "failed";
  if (phase.stages.every((s) => isTerminal(s.status))) return "done";
  const live = phase.stages.find((s) => !isTerminal(s.status));
  return live?.status ?? "pending";
}

export function validateRunFile(input: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  const deprecations: string[] = [];
  const doc = asDocument(input, issues);
  if (!doc) return result(issues);

  requireVersion(doc, issues, deprecations);
  requireKeys(
    doc,
    ["run", "title", "scope", "workflow", "repos", "created_at", "updated_at", "status", "cursor", "budget", "phases"],
    "",
    issues,
  );
  if (typeof doc.run !== "string" || !RUN_ID_RE.test(doc.run)) {
    issues.push({ path: "run", message: "run id must match ^\\d{6}-[a-z0-9-]{1,40}$" });
  }
  requireString(doc.title, "title", issues);
  requireString(doc.scope, "scope", issues);
  requireString(doc.workflow, "workflow", issues);
  requireString(doc.created_at, "created_at", issues);
  requireString(doc.updated_at, "updated_at", issues);
  requireEnum(doc.status, STAGE_STATUSES, "status", issues);
  requireArray(doc.repos, "repos", issues);

  let cursor: RunCursor | null = null;
  if (isRecord(doc.cursor)) {
    requireKeys(doc.cursor, ["phase", "stage", "task"], "cursor", issues);
    cursor = {
      phase: String(doc.cursor.phase ?? ""),
      stage: String(doc.cursor.stage ?? ""),
      task: typeof doc.cursor.task === "string" ? doc.cursor.task : null,
    };
  } else if (doc.cursor !== undefined) {
    issues.push({ path: "cursor", message: "expected a mapping" });
  }

  if (isRecord(doc.budget)) {
    requireKeys(doc.budget, ["ceiling_usd", "spent_usd", "per_agent_max_usd"], "budget", issues);
    requireNumber(doc.budget.ceiling_usd, "budget.ceiling_usd", issues);
    requireNumber(doc.budget.spent_usd, "budget.spent_usd", issues);
    requireNumber(doc.budget.per_agent_max_usd, "budget.per_agent_max_usd", issues);
  } else if (doc.budget !== undefined) {
    issues.push({ path: "budget", message: "expected a mapping" });
  }

  // Optional, additive: absent until a Build stage claims an epic branch.
  if (doc.build !== undefined) {
    if (isRecord(doc.build)) {
      requireKeys(doc.build, ["epic_branch"], "build", issues);
      if (requireArray(doc.build.epic_branch, "build.epic_branch", issues)) {
        (doc.build.epic_branch as unknown[]).forEach((branch, i) => {
          requireString(branch, `build.epic_branch[${i}]`, issues);
        });
      }
      // Optional (issue #57): absent on every run.yml written before the key
      // existed, which is what keeps those runs replaying identically.
      if (doc.build.branch_model !== undefined && !isBranchModelKind(doc.build.branch_model)) {
        issues.push({
          path: "build.branch_model",
          message: `expected one of ${BRANCH_MODELS.join(" | ")}`,
        });
      }
    } else {
      issues.push({ path: "build", message: "expected a mapping" });
    }
  }

  // Optional, additive: absent unless `tldrx run cancel` closed this run.
  if (doc.cancelled !== undefined) {
    if (isRecord(doc.cancelled)) {
      requireKeys(doc.cancelled, ["by", "at", "note"], "cancelled", issues);
      requireString(doc.cancelled.by, "cancelled.by", issues);
      requireString(doc.cancelled.at, "cancelled.at", issues);
      requireString(doc.cancelled.note, "cancelled.note", issues);
    } else {
      issues.push({ path: "cancelled", message: "expected a mapping" });
    }
  }

  // Optional, additive (#210): absent until a run CLOSES, and absent forever on
  // every run.yml written before the key existed. `kind` is the only required
  // half — the counts are omitted for `n/a`, where a zero would be a claim about
  // a plan that never existed.
  if (doc.outcome !== undefined) {
    if (isRecord(doc.outcome)) {
      requireKeys(doc.outcome, ["kind"], "outcome", issues);
      requireEnum(doc.outcome.kind, RUN_OUTCOME_KINDS, "outcome.kind", issues);
      for (const key of ["stories_done", "stories_total", "stories_blocked"] as const) {
        if (doc.outcome[key] !== undefined) requireNumber(doc.outcome[key], `outcome.${key}`, issues);
      }
      for (const key of ["why", "first_blocked"] as const) {
        if (doc.outcome[key] !== undefined) requireString(doc.outcome[key], `outcome.${key}`, issues);
      }
    } else {
      issues.push({ path: "outcome", message: "expected a mapping" });
    }
  }

  // Optional, additive (§6.2): absent on every run `run new` creates. Present it
  // must still be well formed — a half-written provenance block is worse than none.
  if (doc.triage !== undefined) {
    if (isRecord(doc.triage)) {
      requireKeys(doc.triage, ["split", "depends_on"], "triage", issues);
      requireString(doc.triage.split, "triage.split", issues);
      if (requireArray(doc.triage.depends_on, "triage.depends_on", issues)) {
        (doc.triage.depends_on as unknown[]).forEach((slug, i) => {
          requireString(slug, `triage.depends_on[${i}]`, issues);
        });
      }
      // Optional and additive: absence is what every existing run means, and only
      // a value this reader does not understand is an issue.
      if (doc.triage.budget_basis !== undefined) {
        requireEnum(doc.triage.budget_basis, TRIAGE_BUDGET_BASES, "triage.budget_basis", issues);
      }
    } else {
      issues.push({ path: "triage", message: "expected a mapping" });
    }
  }

  // Optional, additive: absent means the framework may spawn. Present it must be
  // a value this binary understands — a policy the reader cannot honour is not a
  // policy it may quietly downgrade to "spawn anyway".
  if (doc.attended_by !== undefined) requireEnum(doc.attended_by, ATTENDED_BY, "attended_by", issues);

  // Optional and additive (#183): absent is what every run.yml written before
  // these existed means, and `recordedVersion` says so in words. A wrong TYPE is
  // still an issue — a version that is not a string is a provenance claim nothing
  // can compare against `tldrx --version`, and a file may not carry one of those.
  for (const key of ["created_with", "last_written_by"] as const) {
    if (doc[key] !== undefined) requireString(doc[key], key, issues);
  }

  // Optional, additive (#253): absent means push nothing, open nothing. Present,
  // the three policy keys are REQUIRED — a block with `push: true` and no `pr`
  // would have to be read as some default, and a default that publishes is the
  // one guess this key exists to forbid. The record keys are optional: absent
  // until `tldrx ship` writes them, and checked only when there.
  if (doc.ship !== undefined) {
    if (isRecord(doc.ship)) {
      requireKeys(doc.ship, ["push", "pr", "auto_merge"], "ship", issues);
      for (const key of ["push", "pr"] as const) {
        if (doc.ship[key] !== undefined && typeof doc.ship[key] !== "boolean") {
          issues.push({ path: `ship.${key}`, message: `expected a boolean, got ${typeof doc.ship[key]}` });
        }
      }
      requireEnum(doc.ship.auto_merge, AUTO_MERGE_POLICIES, "ship.auto_merge", issues);
      if (requireArray(doc.ship.pr_urls, "ship.pr_urls", issues)) {
        (doc.ship.pr_urls as unknown[]).forEach((url, i) => requireString(url, `ship.pr_urls[${i}]`, issues));
      }
      requireString(doc.ship.merge, "ship.merge", issues);
      if (doc.ship.merges !== undefined) {
        if (isRecord(doc.ship.merges)) {
          for (const [name, state] of Object.entries(doc.ship.merges)) requireString(state, `ship.merges.${name}`, issues);
        } else {
          issues.push({ path: "ship.merges", message: "expected a mapping of repo name to merge state" });
        }
      }
      requireString(doc.ship.shipped_at, "ship.shipped_at", issues);
    } else {
      issues.push({ path: "ship", message: "expected a mapping" });
    }
  }

  // Optional, additive: absent means "clean up at run close". Present it must be
  // a real boolean — a `keep_worktrees: "yes"` that silently read as false would
  // delete the checkouts the operator asked to keep.
  if (doc.keep_worktrees !== undefined && typeof doc.keep_worktrees !== "boolean") {
    issues.push({ path: "keep_worktrees", message: `expected a boolean, got ${typeof doc.keep_worktrees}` });
  }

  if (!requireArray(doc.phases, "phases", issues)) return result(issues, deprecations);
  const phases = doc.phases as unknown[];
  if (phases.length > MAX_PHASES) {
    issues.push({ path: "phases", message: `${phases.length} phases exceeds the ${MAX_PHASES} cap` });
  }

  const declaredStageIds: string[] = [];
  for (const phase of phases) {
    if (!isRecord(phase) || !Array.isArray(phase.stages)) continue;
    for (const stage of phase.stages as unknown[]) {
      if (isRecord(stage) && typeof stage.id === "string") declaredStageIds.push(stage.id);
    }
  }
  validateGatesPolicy(doc.gates_policy, declaredStageIds, issues);

  let stageCount = 0;
  let taskCount = 0;
  let running = 0;
  let cursorResolves = false;
  let spentFromTasks = 0;
  const phaseIds = new Set<string>();

  phases.forEach((phase, i) => {
    const base = `phases[${i}]`;
    if (!isRecord(phase)) {
      issues.push({ path: base, message: "expected a mapping" });
      return;
    }
    requireKeys(phase, ["id", "status", "stages"], base, issues);
    const phaseId = typeof phase.id === "string" ? phase.id : "";
    if (!PHASE_ID_RE.test(phaseId)) {
      issues.push({ path: `${base}.id`, message: "phase id must match ^0[1-5]-[a-z]+$" });
    }
    if (phaseIds.has(phaseId)) issues.push({ path: `${base}.id`, message: `duplicate phase id ${phaseId}` });
    phaseIds.add(phaseId);
    requireEnum(phase.status, STAGE_STATUSES, `${base}.status`, issues);
    if (!requireArray(phase.stages, `${base}.stages`, issues)) return;

    const stageIds = new Set<string>();
    (phase.stages as unknown[]).forEach((stage, j) => {
      const path = `${base}.stages[${j}]`;
      stageCount++;
      if (!isRecord(stage)) {
        issues.push({ path, message: "expected a mapping" });
        return;
      }
      requireKeys(
        stage,
        ["id", "status", "expert", "model", "budget_usd", "cost_usd", "started_at", "ended_at", "inputs", "outputs", "gate", "tasks"],
        path,
        issues,
      );
      const stageId = typeof stage.id === "string" ? stage.id : "";
      if (stageIds.has(stageId)) issues.push({ path: `${path}.id`, message: `duplicate stage id ${stageId}` });
      stageIds.add(stageId);
      requireEnum(stage.status, STAGE_STATUSES, `${path}.status`, issues);
      if (stage.status === "running") running++;
      requireNumber(stage.budget_usd, `${path}.budget_usd`, issues);
      requireNumber(stage.cost_usd, `${path}.cost_usd`, issues);
      requireArray(stage.inputs, `${path}.inputs`, issues);
      requireArray(stage.outputs, `${path}.outputs`, issues);
      if (stage.stale !== undefined && typeof stage.stale !== "boolean") {
        issues.push({ path: `${path}.stale`, message: "expected true or false" });
      }
      checkOrder(stage.started_at, stage.ended_at, path, issues);
      if (cursor !== null && cursor.phase === phaseId && cursor.stage === stageId) cursorResolves = true;

      if (isRecord(stage.gate)) {
        const gate = stage.gate;
        requireKeys(gate, ["type", "status", "by", "at", "note"], `${path}.gate`, issues);
        requireEnum(gate.type, GATE_TYPES, `${path}.gate.type`, issues);
        requireEnum(gate.status, GATE_STATUSES, `${path}.gate.status`, issues);
        if (gate.status === "approved" && (typeof gate.by !== "string" || typeof gate.at !== "string")) {
          issues.push({ path: `${path}.gate`, message: "an approved gate needs both `by` and `at`" });
        }
        validateGateEvidence(gate.evidence, `${path}.gate.evidence`, issues);
        validateGateExecutor(gate.executed_by, `${path}.gate.executed_by`, issues);
        validateGateAuthority(gate.authority, `${path}.gate.authority`, issues);
      } else if (stage.gate !== undefined) {
        issues.push({ path: `${path}.gate`, message: "expected a mapping" });
      }

      if (requireArray(stage.tasks, `${path}.tasks`, issues)) {
        const taskIds = new Set<string>();
        (stage.tasks as unknown[]).forEach((task, k) => {
          const tp = `${path}.tasks[${k}]`;
          taskCount++;
          if (!isRecord(task)) {
            issues.push({ path: tp, message: "expected a mapping" });
            return;
          }
          requireKeys(task, ["id", "status", "cost_usd", "error", "session_id"], tp, issues);
          const taskId = typeof task.id === "string" ? task.id : "";
          if (!/^t\d+$/.test(taskId)) issues.push({ path: `${tp}.id`, message: "task id must match ^t\\d+$" });
          if (taskIds.has(taskId)) issues.push({ path: `${tp}.id`, message: `duplicate task id ${taskId}` });
          taskIds.add(taskId);
          requireEnum(task.status, STAGE_STATUSES, `${tp}.status`, issues);
          // `null` is legal and means unmetered (an in-session turn nobody costed).
          // It contributes nothing to the total, which is why `budget.spent_usd`
          // can be below what was really spent and why every report says so.
          if (task.cost_usd !== null) requireNumber(task.cost_usd, `${tp}.cost_usd`, issues);
          // Additive (#234): absence is fine — a run.yml from before the key
          // existed has none, and so does any turn nothing could attribute — but
          // a non-string role is a record no reader can join on.
          if (task.role !== undefined && typeof task.role !== "string") {
            issues.push({ path: `${tp}.role`, message: "expected a string" });
          }
          if (task.metered !== undefined && typeof task.metered !== "boolean") {
            issues.push({ path: `${tp}.metered`, message: "expected true or false" });
          }
          if (task.cost_usd === null && task.metered !== false) {
            issues.push({ path: `${tp}.metered`, message: "a null cost_usd must be marked `metered: false`" });
          }
          if (task.banked_before_refusal !== undefined && task.banked_before_refusal !== true) {
            issues.push({ path: `${tp}.banked_before_refusal`, message: "expected `true` or absent" });
          }
          if (task.dedupe !== undefined && typeof task.dedupe !== "string") {
            issues.push({ path: `${tp}.dedupe`, message: "expected a string" });
          }
          // Additive: absence is fine, a wrong TYPE is not. A token count that is
          // not a non-negative finite number is a record that cannot be arithmetic.
          for (const key of [
            "input_tokens", "output_tokens",
            "cache_creation_input_tokens", "cache_read_input_tokens",
          ] as const) {
            const value = task[key];
            if (value === undefined) continue;
            if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
              issues.push({ path: `${tp}.${key}`, message: "expected a number >= 0" });
            }
          }
          // Additive (#184), and the two are validated as a PAIR: a span with no
          // basis is a number a reader will mistake for the other quantity, and a
          // basis with no span is a claim about nothing. A negative or
          // non-finite span is not a measurement.
          if (task.duration_ms !== undefined) {
            if (typeof task.duration_ms !== "number" || !Number.isFinite(task.duration_ms) || task.duration_ms < 0) {
              issues.push({ path: `${tp}.duration_ms`, message: "expected a number >= 0" });
            }
            requireEnum(task.duration_basis, DURATION_BASES, `${tp}.duration_basis`, issues);
          } else if (task.duration_basis !== undefined) {
            issues.push({
              path: `${tp}.duration_basis`,
              message: "a duration_basis with no duration_ms names the basis of nothing",
            });
          }
          if (typeof task.cost_usd === "number") spentFromTasks += task.cost_usd;
          checkOrder(task.started_at, task.ended_at, tp, issues);
        });
      }
    });
  });

  if (stageCount > MAX_STAGES) issues.push({ path: "phases", message: `${stageCount} stages exceeds the ${MAX_STAGES} cap` });
  if (taskCount > MAX_TASKS) issues.push({ path: "phases", message: `${taskCount} tasks exceeds the ${MAX_TASKS} cap` });
  if (running > 1) issues.push({ path: "phases", message: `${running} stages are running; tldrx is single-writer` });
  if (cursor !== null && !cursorResolves) {
    issues.push({ path: "cursor", message: `cursor ${cursor.phase}/${cursor.stage} does not resolve to a stage` });
  }
  if (isRecord(doc.budget) && typeof doc.budget.spent_usd === "number") {
    if (Math.abs(doc.budget.spent_usd - spentFromTasks) > 0.01) {
      issues.push({
        path: "budget.spent_usd",
        message: `${doc.budget.spent_usd} does not match the task total ${round(spentFromTasks)} (tolerance 0.01)`,
      });
    }
  }
  return result(issues, deprecations);
}

function checkOrder(started: unknown, ended: unknown, path: string, issues: ValidationIssue[]): void {
  if (typeof started === "string" && typeof ended === "string" && ended < started) {
    issues.push({ path: `${path}.ended_at`, message: "ended_at is before started_at" });
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Narrow a validated document. Call `validateRunFile` first. */
export function asRunFile(input: unknown): RunFile {
  return input as RunFile;
}

/** Keys of `gate.evidence`, in the order they are emitted. */
export const GATE_EVIDENCE_KEYS = [
  "path", "role", "verdict", "sampled", "of", "resolved", "refuted", "outside_surface",
] as const;

/**
 * `gate.evidence`, when it is there. Absent is legal and means what it always
 * meant; present it must be complete, because a half-written record of what a
 * signature rested on is worse than none.
 */
/** Keys of `gate.executed_by`. `id` is optional — see `RunGateExecutor`. */
export const GATE_EXECUTOR_KEYS = ["type"] as const;

/** Keys of `gate.authority`, in the order they are emitted. */
export const GATE_AUTHORITY_KEYS = ["type", "policy", "authorized_by", "source"] as const;

/**
 * `gate.executed_by` (#122), when it is there. Absent is legal and means what a
 * gate has always meant: read `by`. Present, its `type` must be one of the three
 * — a kind of entity the reader does not understand is a schema error, never a
 * silent downgrade to "assume a person".
 */
function validateGateExecutor(value: unknown, base: string, issues: ValidationIssue[]): void {
  if (value === undefined || value === null) return;
  if (!isRecord(value)) {
    issues.push({ path: base, message: "expected a mapping" });
    return;
  }
  requireKeys(value, GATE_EXECUTOR_KEYS, base, issues);
  requireEnum(value.type, GATE_EXECUTOR_TYPES, `${base}.type`, issues);
  if (value.id !== undefined) requireString(value.id, `${base}.id`, issues);
  if (value.type === "auto" && value.id !== undefined) {
    issues.push({
      path: `${base}.id`,
      message: "the facilitator is a role, not an identity — an `auto` executor carries no id",
    });
  }
}

/**
 * `gate.authority` (#122), when it is there. Present it must be COMPLETE, for the
 * same reason `gate.evidence` must be: a half-written record of what a signature
 * rested on is worse than none.
 *
 * `authorized_by: null` is legal and is the honest case — paired with
 * `source: unrecorded` it is the record saying the log does not name an
 * authorizer, which is a different fact from a key nobody wrote.
 */
function validateGateAuthority(value: unknown, base: string, issues: ValidationIssue[]): void {
  if (value === undefined || value === null) return;
  if (!isRecord(value)) {
    issues.push({ path: base, message: "expected a mapping" });
    return;
  }
  requireKeys(value, GATE_AUTHORITY_KEYS, base, issues);
  requireEnum(value.type, GATE_AUTHORITY_TYPES, `${base}.type`, issues);
  requireEnum(value.policy, GATE_POLICIES, `${base}.policy`, issues);
  requireEnum(value.source, GATE_AUTHORITY_SOURCES, `${base}.source`, issues);
  if (value.authorized_by !== null) requireString(value.authorized_by, `${base}.authorized_by`, issues);
  // The two travel together or the record contradicts itself: a named authorizer
  // whose source is `unrecorded`, or an unnamed one the record claims to know.
  if ((value.authorized_by === null) !== (value.source === "unrecorded")) {
    issues.push({
      path: base,
      message: "`authorized_by: null` and `source: unrecorded` are the same fact and must travel together",
    });
  }
}

function validateGateEvidence(value: unknown, base: string, issues: ValidationIssue[]): void {
  if (value === undefined || value === null) return;
  if (!isRecord(value)) {
    issues.push({ path: base, message: "expected a mapping" });
    return;
  }
  requireKeys(value, GATE_EVIDENCE_KEYS, base, issues);
  requireString(value.path, `${base}.path`, issues);
  requireEnum(value.role, EVIDENCE_ROLES, `${base}.role`, issues);
  requireEnum(value.verdict, EVIDENCE_VERDICTS, `${base}.verdict`, issues);
  for (const key of ["sampled", "of", "resolved", "refuted", "outside_surface"] as const) {
    requireNumber(value[key], `${base}.${key}`, issues);
  }
}
