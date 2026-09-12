/**
 * ONE parser for a per-stage policy flag and ONE validator for its frozen map in
 * `run.yml` — shared by `--gates` / `gates_policy` (`gatePolicy.ts`) and by
 * `--questions` / `questions_policy` (`questionsPolicy.ts`, gh #251).
 *
 * The two flags have the same grammar on purpose: a comma list of entries, each a
 * bare stage id or `<stage>:<policy>`, plus the two words `all` and `none`. A second
 * copy of that grammar would be a second place for "split on the FIRST colon" to
 * drift (§7, one implementation per derivation — `srcToken.ts` is the precedent), so
 * the grammar lives here and each policy file supplies only its WORDS: the flag name
 * for the refusals, the closed policy list, what a bare entry means, what `all` and
 * `none` mean, and its own error class so a caller can still catch the one it asked
 * for.
 *
 * Every refusal names the flag it was typed on. The gates messages are byte-for-byte
 * what `parseGatesFlag` printed before this file existed.
 */
import { isRecord, type ValidationIssue } from "../schemas/validation.ts";

export interface StagePolicyFlag<P extends string> {
  /** The flag without its dashes — `gates`, `questions`. Named in every refusal. */
  readonly flag: string;
  /** The closed set, in the order refusals list it. */
  readonly policies: readonly P[];
  /** What a bare `<stage>` entry means. */
  readonly bare: P;
  /** What `all` gives every stage. */
  readonly all: P;
  /**
   * What `none` gives every stage — and what every stage the list does NOT name
   * gets: the list is the `bare` stages, everything else is this.
   */
  readonly none: P;
  /** The sentence after `--<flag> needs a value: ` on an empty value. */
  readonly emptyHint: string;
  readonly error: new (message: string) => Error;
}

export function parseStagePolicyFlag<P extends string>(
  raw: string,
  stageIds: readonly string[],
  spec: StagePolicyFlag<P>,
): Readonly<Record<string, P>> {
  const value = raw.trim();
  if (value === "") {
    throw new spec.error(`--${spec.flag} needs a value: ${spec.emptyHint}`);
  }
  if (value === "all") return everyStage(stageIds, spec.all);
  if (value === "none") return everyStage(stageIds, spec.none);

  const entries = value.split(",").map((part) => part.trim()).filter((part) => part !== "");
  const known = new Set(stageIds);
  const named = new Map<string, P>();
  const unknownStages: string[] = [];
  for (const entry of entries) {
    // `plan:agent`. Split on the FIRST colon only: a stage id may not contain one
    // (it is refused below as unknown either way), and the policy never does.
    const colon = entry.indexOf(":");
    const id = colon === -1 ? entry : entry.slice(0, colon).trim();
    const policy = colon === -1 ? spec.bare : entry.slice(colon + 1).trim();
    if (!known.has(id)) {
      unknownStages.push(id);
      continue;
    }
    if (!isOneOf(policy, spec.policies)) {
      throw new spec.error(
        `--${spec.flag}: \`${entry}\` names the policy \`${policy}\`, which is not one of `
          + `${spec.policies.join(" | ")}. A bare \`${id}\` means \`${spec.bare}\`.`,
      );
    }
    named.set(id, policy);
  }
  if (unknownStages.length > 0) {
    throw new spec.error(
      `--${spec.flag}: ${unknownStages.join(", ")} is not a stage of this workflow (${stageIds.join(", ")})`,
    );
  }
  const out: Record<string, P> = {};
  for (const id of stageIds) out[id] = named.get(id) ?? spec.none;
  return out;
}

function everyStage<P extends string>(stageIds: readonly string[], policy: P): Readonly<Record<string, P>> {
  const out: Record<string, P> = {};
  for (const id of stageIds) out[id] = policy;
  return out;
}

function isOneOf<P extends string>(value: string, policies: readonly P[]): value is P {
  return (policies as readonly string[]).includes(value);
}

/**
 * `run.yml`'s optional `<field>:` block — a mapping of stage id -> policy.
 *
 * Absent is fine (every run.yml written before the field existed); a value outside
 * the closed set, or a key naming no stage of this run, is an issue at its own path.
 */
export function validateStagePolicy(
  value: unknown,
  stageIds: readonly string[],
  issues: ValidationIssue[],
  spec: { readonly field: string; readonly policies: readonly string[] },
): void {
  if (value === undefined || value === null) return;
  if (!isRecord(value)) {
    issues.push({
      path: spec.field,
      message: `expected a mapping of stage id -> ${spec.policies.join(" | ")}`,
    });
    return;
  }
  const known = new Set(stageIds);
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== "string" || !spec.policies.includes(raw)) {
      issues.push({
        path: `${spec.field}.${key}`,
        message: `expected one of ${spec.policies.join(" | ")}, got ${JSON.stringify(raw)}`,
      });
    }
    if (known.size > 0 && !known.has(key)) {
      issues.push({ path: `${spec.field}.${key}`, message: `names no stage in this run` });
    }
  }
}
