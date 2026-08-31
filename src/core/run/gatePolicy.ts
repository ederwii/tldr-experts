/**
 * Who approves a stage's gate: a person, the harness, or an agent that showed its
 * work (spec §2.2 `gates_policy`, §2.4 `gates:`, §5 "who closes a gate").
 *
 * Every stage still ENDS at a gate — that is not negotiable and nothing here
 * changes it. What is negotiable is who closes it. A `human` gate waits for
 * `tldrx approve`; an `auto` gate is closed by the facilitator, but only when the
 * seven §5 conditions all hold, and it is recorded through the same `approve` path
 * with `by: auto` so the trail reads identically.
 *
 * An `agent` gate is the third: every `auto` condition, unweakened, PLUS a
 * structured evidence note whose verdict is `sign` (design §A). It is strictly
 * stronger than an auto gate, never a cheaper one — the extra requirement is a
 * file somebody has to have written and be accountable for, and the gate records
 * that person's name in `by:` rather than `auto`.
 *
 * The policy is DATA: a workflow file says it, `run new --gates` overrides it, and
 * the resolved map is frozen into `run.yml` at creation. A run therefore keeps the
 * policy it was opened with even if the workflow file changes underneath it.
 *
 * Absence means `human`, everywhere: a `run.yml` written before this existed, a
 * workflow with no `gates:` key, a stage the map does not name. The safe default
 * is the one that stops.
 */
import { isRecord, type ValidationIssue } from "../schemas/validation.ts";

export const GATE_POLICIES = ["human", "auto", "agent"] as const;
export type GatePolicy = (typeof GATE_POLICIES)[number];

/** Stage id -> who approves it. */
export type GatesPolicy = Readonly<Record<string, GatePolicy>>;

/**
 * `gates:` in a workflow file also carries the §2.4 `collapse:` key, which is
 * declared in the spec and implemented nowhere. It is skipped rather than read as
 * a stage id, so a workflow may keep it without inventing a stage called
 * "collapse".
 */
export const RESERVED_GATE_KEYS: readonly string[] = ["collapse"];

export class GatePolicyError extends Error {}

export function isGatePolicy(value: unknown): value is GatePolicy {
  return typeof value === "string" && (GATE_POLICIES as readonly string[]).includes(value);
}

/**
 * The `gates:` mapping of a workflow file, checked against the stages that
 * workflow actually lists.
 *
 * A key naming no stage is refused rather than ignored: a typo'd stage id would
 * otherwise silently leave that stage on the human default, which is the one
 * failure mode nobody would notice until the twelfth run.
 *
 * `agent` is accepted here exactly as `human` and `auto` are — the values are one
 * list, checked in one place, so a third policy is data rather than a branch.
 */
export function parseWorkflowGates(
  value: unknown,
  stageIds: readonly string[],
  source: string,
): GatesPolicy {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) {
    throw new GatePolicyError(`${source}: gates must be a mapping of stage id -> ${GATE_POLICIES.join(" | ")}`);
  }
  const known = new Set(stageIds);
  const out: Record<string, GatePolicy> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (RESERVED_GATE_KEYS.includes(key)) continue;
    if (!known.has(key)) {
      throw new GatePolicyError(
        `${source}: gates names '${key}', which is not one of this workflow's stages (${stageIds.join(", ")})`,
      );
    }
    if (!isGatePolicy(raw)) {
      throw new GatePolicyError(
        `${source}: gates.${key} must be ${GATE_POLICIES.join(" | ")}, got ${JSON.stringify(raw)}`,
      );
    }
    out[key] = raw;
  }
  return out;
}

/**
 * `--gates <entry,entry|all|none>` — the LIST is the non-`auto` gates.
 *
 * A bare entry (`plan`) is a HUMAN gate, which is what the flag has always meant
 * and what every existing invocation keeps meaning. A qualified entry
 * (`plan:agent`) names the policy outright, which is the only way to ask for the
 * third one from the command line — a workflow file is the other (design §A.7).
 *
 * `all` is every stage human (the pre-0.3 behaviour, spelled out); `none` is every
 * stage auto. An empty value is refused rather than read as `none`: `--gates ""`
 * is far more likely to be a shell variable that did not expand than a deliberate
 * request to remove every human from the loop.
 */
export function parseGatesFlag(raw: string, stageIds: readonly string[]): GatesPolicy {
  const value = raw.trim();
  if (value === "") {
    throw new GatePolicyError(
      `--gates needs a value: a comma-separated list of the HUMAN gates (\`plan\`) or of qualified `
        + `gates (\`plan:agent\`), or \`all\`, or \`none\``,
    );
  }
  if (value === "all") return everyStage(stageIds, "human");
  if (value === "none") return everyStage(stageIds, "auto");

  const entries = value.split(",").map((part) => part.trim()).filter((part) => part !== "");
  const known = new Set(stageIds);
  const named = new Map<string, GatePolicy>();
  const unknownStages: string[] = [];
  for (const entry of entries) {
    // `plan:agent`. Split on the FIRST colon only: a stage id may not contain one
    // (it is refused below as unknown either way), and the policy never does.
    const colon = entry.indexOf(":");
    const id = colon === -1 ? entry : entry.slice(0, colon).trim();
    const policy = colon === -1 ? "human" : entry.slice(colon + 1).trim();
    if (!known.has(id)) {
      unknownStages.push(id);
      continue;
    }
    if (!isGatePolicy(policy)) {
      throw new GatePolicyError(
        `--gates: \`${entry}\` names the policy \`${policy}\`, which is not one of `
          + `${GATE_POLICIES.join(" | ")}. A bare \`${id}\` means \`human\`.`,
      );
    }
    named.set(id, policy);
  }
  if (unknownStages.length > 0) {
    throw new GatePolicyError(
      `--gates: ${unknownStages.join(", ")} is not a stage of this workflow (${stageIds.join(", ")})`,
    );
  }
  const out: Record<string, GatePolicy> = {};
  for (const id of stageIds) out[id] = named.get(id) ?? "auto";
  return out;
}

function everyStage(stageIds: readonly string[], policy: GatePolicy): GatesPolicy {
  const out: Record<string, GatePolicy> = {};
  for (const id of stageIds) out[id] = policy;
  return out;
}

/**
 * The policy actually written into `run.yml`: one entry per stage, no gaps.
 *
 * Resolving it at creation rather than at gate time is deliberate — the run then
 * carries its own answer, and `run status` can print the policy without loading a
 * workflow file that may have been edited since.
 */
export function resolveGatesPolicy(
  stageIds: readonly string[],
  fromWorkflow: GatesPolicy,
  override: GatesPolicy | null,
): GatesPolicy {
  const out: Record<string, GatePolicy> = {};
  for (const id of stageIds) {
    out[id] = override?.[id] ?? fromWorkflow[id] ?? "human";
  }
  return out;
}

/** Who approves this stage. Absent policy, absent stage: a human. */
export function gatePolicyFor(policy: GatesPolicy | undefined, stageId: string): GatePolicy {
  return policy?.[stageId] ?? "human";
}

/** `run.yml`'s optional `gates_policy:` block (spec §2.2). */
export function validateGatesPolicy(
  value: unknown,
  stageIds: readonly string[],
  issues: ValidationIssue[],
): void {
  if (value === undefined || value === null) return;
  if (!isRecord(value)) {
    issues.push({
      path: "gates_policy",
      message: `expected a mapping of stage id -> ${GATE_POLICIES.join(" | ")}`,
    });
    return;
  }
  const known = new Set(stageIds);
  for (const [key, raw] of Object.entries(value)) {
    if (!isGatePolicy(raw)) {
      issues.push({
        path: `gates_policy.${key}`,
        message: `expected one of ${GATE_POLICIES.join(" | ")}, got ${JSON.stringify(raw)}`,
      });
    }
    if (known.size > 0 && !known.has(key)) {
      issues.push({ path: `gates_policy.${key}`, message: `names no stage in this run` });
    }
  }
}
