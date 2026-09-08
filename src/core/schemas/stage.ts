/** Schema for `stages/<slug>/stage.yml` — the customizable stage library. */
import {
  asDocument, requireArray, requireEnum, requireKeys, requireNumber, requireRecord,
  requireString, result, type ValidationIssue, type ValidationResult,
} from "./validation.ts";
import { STORY_STAKES } from "./planCommon.ts";

export const GATE_TYPES = ["human-approval", "checks-green", "none"] as const;
export type GateType = (typeof GATE_TYPES)[number];

/**
 * `--effort <level>` on the Claude CLI — "Effort level for the current session".
 * The five values are the ones `claude --help` prints on this machine (read
 * 2026-08-29, verbatim: `low, medium, high, xhigh, max`); nothing else is
 * accepted, for the same reason `spawnAgent` refuses a flag nobody has seen in
 * `--help`.
 *
 * It is the cost lever `--max-budget-usd` is not: the budget flag STOPS a run
 * after the turn it is already in (measured: a 597 s training turn spent $5.15
 * against a $1.50 ceiling), so it cannot make a turn cheaper — only end it late.
 * Effort changes what the turn costs in the first place.
 */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === "string" && (EFFORT_LEVELS as readonly string[]).includes(value);
}

/**
 * A gate is its `type` and nothing else.
 *
 * `requires:` (a list of acceptance sentences) lived here until 2026-08-29 and
 * was read by nobody: `normaliseGate` (`run/workflowPreset.ts:216-231`) takes
 * `.type`, `validateStage` below checks `gate.type`, and the agent prompt ships
 * `stage.md`, never `stage.yml` (`facilitator/prompt.ts:101`). Dropping the field
 * does not break a stage library that still declares it — unknown keys are
 * ignored here, as they always have been — it just stops the type pretending
 * something consumes them. Real enforcement is `checks:`.
 */
export interface StageGate {
  readonly type: GateType;
}

/**
 * `preconditions:` — an OPERATIONAL fact that must hold before the stage is worth
 * dispatching at all (design §F.1).
 *
 * The grounding is measured, not hypothetical: on 2026-08-30 a host hand-checked
 * the Docker daemon and the .NET SDK before dispatching a Build story, precisely
 * because a dead daemon would have burned one of that story's two attempts on an
 * environment problem no amount of re-prompting fixes.
 *
 * It is the same shape and the SAME allowlist rule as a `cmd` check — only a
 * command byte-equal to one `.tldrx/workspace.yml` declares may run, argv-split,
 * never through a shell (`schemas/commandAllowlist.ts`). That constraint is the
 * whole reason this is safe to put in a stage file. The difference from `checks:`
 * is only WHEN: a check runs after the stage produced something, a precondition
 * runs before a byte is written or a cent is spent.
 */
export interface StagePrecondition {
  /** The operator-facing name — `docker`, `sdk`. What the refusal says back. */
  readonly id: string;
  /** A `workspace.yml` repo name; the command runs in its directory. */
  readonly repo: string;
  /** Byte-equal to a `workspace.yml` command. */
  readonly command: string;
  /** Default 0. */
  readonly expect_exit?: number;
  /**
   * Seconds this ONE command gets before it is killed (issue #20).
   *
   * Absent means `PRECONDITION_TIMEOUT_S` (`run/checks.ts`), never the stage's
   * `timeout_s`. A precondition inheriting 900–1800 s was the bug: one hung
   * `docker info` could park a run for half an hour — precisely the waste the
   * feature exists to prevent, taken by the guard instead of by the attempt. A
   * liveness question is worth a second or two; a stage's work is worth minutes,
   * and those are not the same number.
   */
  readonly timeout_s?: number;
}

/**
 * `reviewer:` and `reviewer_by_stakes.<stakes>:` — the REVIEWER role's own model
 * and effort, for a stage that spawns more than one role.
 *
 * Until now `model:` and `effort:` were per STAGE, and Build's developer and its
 * reviewer read the same two lines through one accessor. Measured across three
 * real workspaces and 168 Build stories: every one of them ran the same model at
 * the same effort for both roles, so nobody can say whether a stronger reviewer
 * finds more — and hosts were upgrading the reviewer by hand on the stories whose
 * own text said they were security-bearing.
 *
 * Both fields are OPTIONAL and they resolve INDEPENDENTLY: a block that names
 * only `model:` leaves effort exactly where the layer below it had it. Absent
 * everywhere ⇒ the stage's own `model:`/`effort:`, which is byte-for-byte the
 * behaviour this repo shipped before the key existed.
 */
export interface ReviewerOverride {
  readonly model?: string;
  readonly effort?: EffortLevel;
}

export interface Stage {
  readonly name: string;
  readonly title: string;
  readonly phase: number;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly experts: readonly string[];
  readonly model: string;
  /** Optional; absent means the CLI's own default for the session. */
  readonly effort?: EffortLevel;
  readonly budget_usd: number;
  readonly gate: StageGate;
  /** Optional; absent means the reviewer runs on `model`/`effort` above. */
  readonly reviewer?: ReviewerOverride;
  /**
   * Optional, keyed by a story's declared `stakes:` (`STORY_STAKES`). It wins
   * over `reviewer:` for a story that declares a matching value, and a story that
   * declares none never reads it at all.
   *
   * Shipped EMPTY. There is no evidence yet that a stronger reviewer finds more,
   * and shipping a default that spends money on that belief would be asserting
   * the very thing this key exists to measure.
   */
  readonly reviewer_by_stakes?: Readonly<Record<string, ReviewerOverride>>;
  readonly checks?: readonly string[];
  readonly preconditions?: readonly StagePrecondition[];
}

/**
 * Spec §2.3 caps `checks:` at 10; a precondition is a command run as the user
 * before every dispatch, so it gets the same ceiling for the same reason.
 */
export const MAX_PRECONDITIONS = 10;

/**
 * Seconds a precondition gets when it declares no `timeout_s:` of its own
 * (issue #20).
 *
 * NOT the stage's `timeout_s`, which ships at 900 and runs to 1800 on Build.
 * Inheriting that meant one hung `docker info` could hold a run for half an hour
 * — the exact waste preconditions exist to prevent, moved from the attempt to
 * the guard in front of it.
 *
 * `[assumption]` — 60 s is not measured. It is sized from what these commands
 * ARE: a liveness question (`docker info` answered in 1.2 s on 2026-08-30) with
 * enough headroom for a cold toolchain probe (`dotnet --info` on a first run) and
 * none at all for a hang. A stage that genuinely needs longer says so per
 * precondition rather than borrowing the stage's clock.
 */
export const PRECONDITION_TIMEOUT_S = 60;

export function validateStage(input: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  const doc = asDocument(input, issues);
  if (!doc) return result(issues);

  requireKeys(
    doc,
    ["name", "title", "phase", "inputs", "outputs", "experts", "model", "budget_usd", "gate"],
    "",
    issues,
  );
  requireString(doc.name, "name", issues);
  requireString(doc.title, "title", issues);
  requireNumber(doc.phase, "phase", issues);
  requireString(doc.model, "model", issues);
  requireNumber(doc.budget_usd, "budget_usd", issues);
  // Optional: `requireEnum` returns early on `undefined`, and `effort` is not in
  // the required-key list above.
  requireEnum(doc.effort, EFFORT_LEVELS, "effort", issues);
  requireArray(doc.inputs, "inputs", issues);
  requireArray(doc.outputs, "outputs", issues);
  requireArray(doc.experts, "experts", issues);

  if (requireRecord(doc.gate, "gate", issues)) {
    const gate = doc.gate as Record<string, unknown>;
    requireKeys(gate, ["type"], "gate", issues);
    requireEnum(gate.type, GATE_TYPES, "gate.type", issues);
  }
  validatePreconditions(doc.preconditions, issues);
  validateReviewerOverrides(doc.reviewer, doc.reviewer_by_stakes, issues);
  return result(issues);
}

/**
 * SHAPE only, and the same two keys twice — a `reviewer:` block and every entry
 * of `reviewer_by_stakes:` are one type, validated by one function, so the two
 * spellings cannot drift on what an override may say.
 *
 * The map's KEYS are checked against `STORY_STAKES` here rather than left to the
 * lookup: a `reviewer_by_stakes: {secutiry: …}` that merely never matched would
 * be a calibration the operator wrote, paid for in nothing, and never heard about
 * again.
 */
function validateReviewerOverrides(
  reviewer: unknown,
  byStakes: unknown,
  issues: ValidationIssue[],
): void {
  validateReviewerOverride(reviewer, "reviewer", issues);
  if (byStakes === undefined || byStakes === null) return;
  if (!requireRecord(byStakes, "reviewer_by_stakes", issues)) return;
  for (const [key, value] of Object.entries(byStakes as Record<string, unknown>)) {
    const base = `reviewer_by_stakes.${key}`;
    if (!(STORY_STAKES as readonly string[]).includes(key)) {
      issues.push({
        path: base,
        message: `expected one of ${STORY_STAKES.join(" | ")} — a story's \`stakes:\` value`,
      });
      continue;
    }
    validateReviewerOverride(value, base, issues);
  }
}

function validateReviewerOverride(value: unknown, base: string, issues: ValidationIssue[]): void {
  if (value === undefined || value === null) return;
  if (!requireRecord(value, base, issues)) return;
  const row = value as Record<string, unknown>;
  if (row.model !== undefined) requireString(row.model, `${base}.model`, issues);
  requireEnum(row.effort, EFFORT_LEVELS, `${base}.effort`, issues);
}

/**
 * SHAPE only. The allowlist half of the rule — "byte-equal to a `workspace.yml`
 * command" — cannot be checked here: `validateStage` is handed a parsed document
 * and has no workspace to compare against. It is enforced where the workspace IS
 * in hand, at preset load (`run/workflowPreset.ts`), and a stage whose
 * precondition names an undeclared command never loads.
 */
function validatePreconditions(value: unknown, issues: ValidationIssue[]): void {
  if (value === undefined || value === null) return;
  if (!requireArray(value, "preconditions", issues)) return;
  const list = value as readonly unknown[];
  if (list.length > MAX_PRECONDITIONS) {
    issues.push({ path: "preconditions", message: `${list.length} entries exceeds the cap of ${MAX_PRECONDITIONS}` });
  }
  list.forEach((entry, i) => {
    const base = `preconditions[${i}]`;
    if (!requireRecord(entry, base, issues)) return;
    const row = entry as Record<string, unknown>;
    requireKeys(row, ["id", "repo", "command"], base, issues);
    requireString(row.id, `${base}.id`, issues);
    requireString(row.repo, `${base}.repo`, issues);
    requireString(row.command, `${base}.command`, issues);
    if (row.expect_exit !== undefined) requireNumber(row.expect_exit, `${base}.expect_exit`, issues);
    if (row.timeout_s !== undefined) {
      requireNumber(row.timeout_s, `${base}.timeout_s`, issues);
      if (typeof row.timeout_s === "number" && row.timeout_s <= 0) {
        issues.push({ path: `${base}.timeout_s`, message: "expected a number of seconds > 0" });
      }
    }
  });
}
