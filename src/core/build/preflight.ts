/**
 * What the workspace's gate commands do on the UNTOUCHED base tree — measured
 * once per run, written down, and consulted before a story is ever blamed.
 *
 * A story's ```dod block is a DELTA gate. It proves exactly one thing: *this
 * story did not break the tree*. That claim is only meaningful if the tree was
 * unbroken to begin with, and until 2026-08-31 nothing checked.
 *
 * Measured live on `260829-scoring-leaderboard` (scavtopia): of the three
 * commands `workspace.yml` declared, TWO already failed on pristine main — a bare
 * `dotnet test` ran two `Live`-trait tests that call paid Azure AI and that the
 * repo's own CI excludes, and `dotnet format --verify-no-changes` flagged 336
 * files in a repo whose CI never gates format at all. All 15 stories in the plan
 * would have blocked identically. The framework reported it as
 * `S1 → blocked (dotnet test exited 1 …)`: a configuration error charged to a
 * correct story, with a developer turn spent on it and paid AI tests run as a
 * routine gate.
 *
 * So the base result is a fact this run OWNS, and it lives where the run's other
 * state lives — `04-build/preflight.yml`, files-as-state (spec §1) — because a
 * `dotnet test` is minutes of wall clock and a resumed run must not re-pay it.
 * Two readers:
 *
 *   - **Build entry** refuses before dispatching or charging anything, naming the
 *     command and its exit code.
 *   - **A story's DoD failure** consults it for ATTRIBUTION: the same command red
 *     on base is not this story's fault.
 *
 * The cache is a convenience, never a precondition. A run that entered Build on
 * an older binary has no file here, and every reader degrades to measuring
 * lazily rather than erroring — a missing cache is a question, not a fault.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseYaml } from "../yaml.ts";
import { yamlScalar } from "../facts/emitFactsYaml.ts";
import { writeAtomic } from "../fs/writeAtomic.ts";
import { BUILD_PHASE } from "./plan.ts";

/** The file that decides what a red story means, run-relative. */
export const PREFLIGHT_REL = `${BUILD_PHASE}/preflight.yml`;

/** How the workspace file is named in every message here. */
export const WORKSPACE_FILE = ".tldrx/workspace.yml";

/**
 * `ok` and `failed` are MEASUREMENTS of the base tree. `unmeasured` is the third
 * case and it is not a synonym for either: the gate declined to run the command
 * at all (it is not on the allowlist, or it needs a shell this gate does not
 * open), so nothing is known about the base and nothing may be inferred from it.
 * An `unmeasured` row never refuses Build and never excuses a story.
 */
export type BaseStatus = "ok" | "failed" | "unmeasured";

export interface BaseCommandResult {
  readonly repo: string;
  /** Byte-identical to the `workspace.yml` command — the join key everywhere. */
  readonly command: string;
  /** The repo's `default_branch` — what an epic branch is cut from (spec §2.1). */
  readonly baseRef: string;
  /** Short sha of `baseRef` when it was measured; `""` when git had no answer. */
  readonly baseSha: string;
  readonly exitCode: number;
  readonly timedOut: boolean;
  /** Last meaningful line of the output — the operator's first clue. */
  readonly tail: string;
  readonly status: BaseStatus;
}

export interface BasePreflight {
  readonly checkedAt: string;
  readonly results: readonly BaseCommandResult[];
}

export const EMPTY_PREFLIGHT: BasePreflight = { checkedAt: "", results: [] };

// --- the file ---------------------------------------------------------------

/**
 * Block-style YAML, emitted field by field through `yamlScalar`.
 *
 * Not `stringifyYaml`: a `tail` is model-adjacent free text and can carry a
 * newline, and free text written into YAML without escaping is the exact bug
 * (#13) that broke `run.yml` and its backup on a live run 2026-08-31. Every
 * string below goes through the same escaper that fix installed.
 */
export function emitPreflightYaml(preflight: BasePreflight): string {
  const lines = ["version: 1", `checked_at: ${yamlScalar(preflight.checkedAt)}`];
  if (preflight.results.length === 0) {
    lines.push("results: []");
  } else {
    lines.push("results:");
    for (const row of preflight.results) {
      lines.push(
        `  - repo: ${yamlScalar(row.repo)}`,
        `    command: ${yamlScalar(row.command)}`,
        `    base_ref: ${yamlScalar(row.baseRef)}`,
        `    base_sha: ${yamlScalar(row.baseSha)}`,
        `    exit_code: ${String(row.exitCode)}`,
        `    timed_out: ${row.timedOut ? "true" : "false"}`,
        `    status: ${yamlScalar(row.status)}`,
        `    tail: ${yamlScalar(row.tail)}`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

/** `null` for anything this cannot read — never a throw. */
export function parsePreflight(text: string): BasePreflight | null {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch {
    return null;
  }
  if (doc === null || typeof doc !== "object") return null;
  const rows = (doc as { results?: unknown }).results;
  if (!Array.isArray(rows)) return null;
  const results: BaseCommandResult[] = [];
  for (const entry of rows) {
    if (entry === null || typeof entry !== "object") return null;
    const row = entry as Record<string, unknown>;
    const repo = asText(row.repo);
    const command = asText(row.command);
    const exitCode = typeof row.exit_code === "number" && Number.isFinite(row.exit_code) ? row.exit_code : null;
    if (repo === "" || command === "" || exitCode === null) return null;
    results.push({
      repo,
      command,
      baseRef: asText(row.base_ref),
      baseSha: asText(row.base_sha),
      exitCode,
      timedOut: row.timed_out === true,
      tail: asText(row.tail),
      status: row.status === "ok" || row.status === "failed" ? row.status : "unmeasured",
    });
  }
  return { checkedAt: asText((doc as { checked_at?: unknown }).checked_at), results };
}

/**
 * A YAML scalar read back as text.
 *
 * `String` rather than a `typeof` guard because a short sha of all digits comes
 * back from both parsers as a NUMBER, and dropping it would silently invalidate
 * the cache key on one repo in a hundred.
 */
function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

/** The run's cached base results, or `null` when there are none to be had. */
export function loadPreflight(runDir: string): BasePreflight | null {
  const path = join(runDir, PREFLIGHT_REL);
  if (!existsSync(path)) return null;
  try {
    return parsePreflight(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function savePreflight(runDir: string, preflight: BasePreflight): void {
  writeAtomic(join(runDir, PREFLIGHT_REL), emitPreflightYaml(preflight));
}

// --- reading it -------------------------------------------------------------

/**
 * What this run measured for one repo's command, or `null` for "not measured".
 *
 * `baseSha` narrows it: a result taken at a base that has since moved is a
 * measurement of a tree that is no longer the base, so the caller re-measures
 * rather than trusting it. An empty sha on either side does not narrow anything
 * — git had no answer, and a missing answer is not a mismatch.
 */
export function baseResultFor(
  preflight: BasePreflight | null,
  repo: string,
  command: string,
  baseSha = "",
): BaseCommandResult | null {
  if (preflight === null) return null;
  for (const row of preflight.results) {
    if (row.repo !== repo || row.command !== command) continue;
    if (baseSha !== "" && row.baseSha !== "" && row.baseSha !== baseSha) continue;
    return row;
  }
  return null;
}

/** True only for a MEASURED red. `unmeasured` is not evidence of anything. */
export function failedOnBase(result: BaseCommandResult | null): boolean {
  return result !== null && result.status === "failed";
}

/** The same result list with each command kept once — the newest measurement wins. */
export function withResult(
  preflight: BasePreflight,
  result: BaseCommandResult,
  checkedAt: string,
): BasePreflight {
  const kept = preflight.results.filter((row) => !(row.repo === result.repo && row.command === result.command));
  return { checkedAt: checkedAt === "" ? preflight.checkedAt : checkedAt, results: [...kept, result] };
}

// --- what the operator reads ------------------------------------------------

export function baseFailureLine(result: BaseCommandResult): string {
  const at = result.baseSha === "" ? "" : ` (${result.baseSha})`;
  const why = result.tail === "" ? "" : ` — ${result.tail}`;
  return `  · \`${result.command}\` exited ${String(result.exitCode)}`
    + `${result.timedOut ? " (timed out)" : ""} in repo ${result.repo}`
    + ` on \`${result.baseRef}\`${at}${why}`;
}

/**
 * The refusal. It names the command and its exit code, and it says whose fault
 * it is — because the whole failure this fixes was a config error reported as a
 * story that could not prove itself.
 */
export function baseRefusalLines(failures: readonly BaseCommandResult[]): readonly string[] {
  return [
    "[tldrx] build: a Definition of Done is a DELTA gate, and these commands already fail on the "
      + "untouched base tree — every story would block for something no story caused:",
    ...failures.map(baseFailureLine),
    `Fix ${WORKSPACE_FILE} (or the base tree), then run \`tldrx next\` again. `
      + "Nothing was dispatched and nothing was charged.",
  ];
}

/** The attribution, when a story's DoD went red for a reason the base shares. */
export function preExistingFailureReason(result: BaseCommandResult): string {
  return `\`${result.command}\` exited ${String(result.exitCode)} — and it exits `
    + `${String(result.exitCode)} on the untouched base tree too (${result.repo} @ \`${result.baseRef}\`), `
    + `so this is a pre-existing failure on the base tree, not this story's. Fix ${WORKSPACE_FILE} or the base.`;
}

/**
 * Thrown out of the DoD step when the failing command is red on base as well.
 *
 * A throw rather than a `blocked` story is the point: blocking would spend the
 * story's attempt and write the wrong reason into an approved artefact. The
 * executor turns this into a REFUSAL — the stage goes back to `ready`, the story
 * stays exactly where it was, and whatever the developer already cost is still
 * recorded.
 */
export class BaseGateFailure extends Error {
  constructor(readonly result: BaseCommandResult, readonly storyId: string | null) {
    super(preExistingFailureReason(result));
    this.name = "BaseGateFailure";
  }
}
