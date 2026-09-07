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
import { hashText } from "../experts/packTemplates.ts";
import { BUILD_PHASE } from "./plan.ts";
import type { WorkspaceContext } from "../../hooks/lib/workspace.ts";

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
  /**
   * The measured exit. Absent — and only ever absent — on an `unmeasured` row
   * the gate REFUSED to run: nothing spawned, so there is nothing to report.
   *
   * ADDITIVE and optional in the tolerant direction only. Every `preflight.yml`
   * written before 2026-09-06 carries one on every row, including the refused
   * ones (a fabricated `126`, #165), and those files still load with the number
   * they recorded — the reader reports what the file says.
   */
  readonly exitCode?: number;
  readonly timedOut: boolean;
  /** Last meaningful line of the output — the operator's first clue. */
  readonly tail: string;
  /** Present only on a REFUSED probe: the gate's own sentence, verbatim. */
  readonly refusedBecause?: string;
  readonly status: BaseStatus;
  /**
   * What the row was measured UNDER, beyond the command string itself.
   *
   * The command string is already the join key, so a hash OF IT would never
   * differ for a row that matched. This hashes the command together with the
   * workspace's whole declared command list — because the refusal's own advice is
   * "fix `.tldrx/workspace.yml`", and that edit can leave one command byte-identical
   * while changing what the gate will run at all. Without this, the fix the tool
   * asked for was the one thing the cache could not see.
   *
   * ADDITIVE and optional. Absent on every preflight.yml written before it existed,
   * and an absence never invalidates anything — the same rule the sha comparison
   * follows: a missing answer is not a mismatch.
   */
  readonly commandHash?: string;
  /**
   * When THIS row was measured, as against the file-level `checked_at`, which is
   * only ever the newest write in the file. Per-row because the freshness rule
   * below is per-row: with one shared clock, re-probing the first stale red would
   * stamp the file `now` and make every other stale red in it look fresh.
   *
   * ADDITIVE and optional; absent falls back to the file-level `checked_at`, and
   * with neither the row is never invalidated by age.
   */
  readonly checkedAt?: string;
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
        // Absent-with-reason: a row the gate REFUSED writes no `exit_code` at all
        // and writes WHY instead. A zero here would read as a green base (#165).
        // Emitted in place so a measured row's bytes are exactly what they were.
        ...(typeof row.exitCode === "number" ? [`    exit_code: ${String(row.exitCode)}`] : []),
        `    timed_out: ${row.timedOut ? "true" : "false"}`,
        `    status: ${yamlScalar(row.status)}`,
        `    tail: ${yamlScalar(row.tail)}`,
      );
      if (row.refusedBecause !== undefined) lines.push(`    refused_because: ${yamlScalar(row.refusedBecause)}`);
      if (row.commandHash !== undefined) lines.push(`    command_hash: ${yamlScalar(row.commandHash)}`);
      if (row.checkedAt !== undefined) lines.push(`    checked_at: ${yamlScalar(row.checkedAt)}`);
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
    const refusedBecause = asText(row.refused_because);
    const exitCode = Number.isInteger(row.exit_code) ? row.exit_code as number : null;
    // `repo` and `command` are the join key, so a row without them is not a row.
    if (repo === "" || command === "") return null;
    // Exactly ONE new hole, and it is the one a refusal needs (#165): a row that
    // says `unmeasured` and says WHY may carry no `exit_code`, because nothing
    // ran. Every other shape invalidates the FILE exactly as it always did, and
    // the two that matter are:
    //
    //   - a PRESENT but non-integer `exit_code` (`"0"`, `null`, `1.5`) — reading
    //     that as "no exit code" would silently promote corruption to a refusal;
    //   - an `exit_code`-less `ok`/`failed` row — those two statuses ARE
    //     measurements, and `baseResultFor` hands back every non-`failed` row as
    //     a cached answer, so a truncated `status: ok` would become a cached
    //     GREEN base and the Build-entry gate would skip that command.
    //
    // A rejected file is not a loss: `loadPreflight` returns null, the caller
    // falls back to `EMPTY_PREFLIGHT`, and the base is re-measured.
    if (exitCode === null) {
      if (row.exit_code !== undefined) return null;
      if (row.status === "ok" || row.status === "failed") return null;
      // Absent-WITH-REASON or nothing: an unexplained absence is not a record.
      if (refusedBecause === "") return null;
    }
    const hash = asText(row.command_hash);
    const rowCheckedAt = asText(row.checked_at);
    results.push({
      repo,
      command,
      baseRef: asText(row.base_ref),
      baseSha: asText(row.base_sha),
      ...(exitCode === null ? {} : { exitCode }),
      timedOut: row.timed_out === true,
      tail: asText(row.tail),
      ...(refusedBecause === "" ? {} : { refusedBecause }),
      status: row.status === "ok" || row.status === "failed" ? row.status : "unmeasured",
      ...(hash === "" ? {} : { commandHash: hash }),
      ...(rowCheckedAt === "" ? {} : { checkedAt: rowCheckedAt }),
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
 * How long a MEASURED RED may be trusted before it is probed again.
 *
 * Only a red has a TTL. A green base that has not moved is the same green base —
 * the sha rule already covers the case where it moved. A red is the answer that
 * costs the most to be wrong about: it blocks every story in the plan for something
 * no story caused, and the operator is being told to go fix the workspace, so the
 * cache has to be willing to notice that they did.
 */
export const PREFLIGHT_RED_TTL_MS = 30 * 60 * 1000;

/**
 * The command AND the allowlist it ran under, as twelve hex characters.
 *
 * `workspaceCommands` is the WHOLE workspace's flat command set (every repo's, not
 * just the row's own repo) — so editing any one repo's `commands:` in
 * `.tldrx/workspace.yml` changes the hash, and therefore invalidates, every red row
 * in the file, not only the repo that changed. Conservative by design: a narrower
 * per-repo hash would miss a workspace-level edit (a renamed script shared across
 * repos, a global default) that changes what a command actually runs.
 */
export function commandHash(command: string, workspaceCommands: readonly string[]): string {
  return hashText(JSON.stringify([command, [...workspaceCommands].sort()]));
}

/** What THIS invocation knows about itself, for deciding whether a red still holds. */
export interface BaseFreshness {
  /** `commandHash(command, workspace.commands)` for this invocation. */
  readonly commandHash?: string;
  /** The invocation's own `at` (RFC3339) — never a clock this function reads. */
  readonly at?: string;
  /** True under `tldrx next --prepare`: a 0-second prepare over a red is the lie. */
  readonly prepare?: boolean;
}

/**
 * What this run measured for one repo's command, or `null` for "not measured".
 *
 * `baseSha` narrows it: a result taken at a base that has since moved is a
 * measurement of a tree that is no longer the base, so the caller re-measures
 * rather than trusting it. An empty sha on either side does not narrow anything
 * — git had no answer, and a missing answer is not a mismatch.
 *
 * A MEASURED RED is narrowed further by `freshness`: it is re-probed when the
 * command hash differs (the operator's `.tldrx/workspace.yml` fix can leave the
 * command string byte-identical), when it is older than `PREFLIGHT_RED_TTL_MS`,
 * or unconditionally under `--prepare` (a 0-second prepare over a red nobody
 * measured today is the lie this exists to stop). A green keeps today's rule —
 * only the sha narrows it — and `unmeasured` is not evidence of anything, so
 * re-running a command the gate already declined to run would buy nothing.
 */
export function baseResultFor(
  preflight: BasePreflight | null,
  repo: string,
  command: string,
  baseSha = "",
  freshness: BaseFreshness = {},
): BaseCommandResult | null {
  if (preflight === null) return null;
  for (const row of preflight.results) {
    if (row.repo !== repo || row.command !== command) continue;
    if (baseSha !== "" && row.baseSha !== "" && row.baseSha !== baseSha) continue;
    if (row.status !== "failed") return row;
    if (freshness.prepare === true) continue;
    if (
      freshness.commandHash !== undefined && row.commandHash !== undefined
      && freshness.commandHash !== row.commandHash
    ) continue;
    if (isStale(row.checkedAt ?? preflight.checkedAt, freshness.at)) continue;
    return row;
  }
  return null;
}

/**
 * Is a red older than the TTL?
 *
 * Both clocks come from the CALLER — the row's own stamp and the invocation's `at`
 * — so this reads no clock of its own and a test can drive it. A clock that is
 * missing or unparseable makes nothing stale: a missing answer is not a mismatch,
 * the same rule an empty sha already follows.
 */
function isStale(measuredAt: string, at: string | undefined): boolean {
  if (measuredAt === "" || at === undefined || at === "") return false;
  const then = Date.parse(measuredAt);
  const now = Date.parse(at);
  if (!Number.isFinite(then) || !Number.isFinite(now)) return false;
  return now - then > PREFLIGHT_RED_TTL_MS;
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
  // The row carries the moment it was measured, beside the file-level stamp: the
  // freshness rule is per row, and one shared clock would make re-probing the
  // first stale red look like a re-probe of every other row in the file.
  const stamped = checkedAt === "" ? result : { ...result, checkedAt };
  return { checkedAt: checkedAt === "" ? preflight.checkedAt : checkedAt, results: [...kept, stamped] };
}

// --- what the operator reads ------------------------------------------------

export function baseFailureLine(result: BaseCommandResult): string {
  const at = result.baseSha === "" ? "" : ` (${result.baseSha})`;
  const why = result.tail === "" ? "" : ` — ${result.tail}`;
  // Only ever called for a `failed` row, which always carries an exit code — but
  // total anyway, because "exited undefined" is the shape of a record that lies.
  const ran = result.exitCode === undefined
    ? "was refused and never ran"
    : `exited ${String(result.exitCode)}`;
  return `  · \`${result.command}\` ${ran}`
    + `${result.timedOut ? " (timed out)" : ""} in repo ${result.repo}`
    + ` on \`${result.baseRef}\`${at}${why}`;
}

/**
 * The refusal. It names the command and its exit code, and it says whose fault
 * it is — because the whole failure this fixes was a config error reported as a
 * story that could not prove itself.
 */
export function baseRefusalLines(
  failures: readonly BaseCommandResult[],
  workspace?: WorkspaceContext,
): readonly string[] {
  const failed: string[] = [];
  for (const result of failures) {
    failed.push(baseFailureLine(result));
    const probe = initProbeLine(workspace, result);
    if (probe !== null) failed.push(probe);
  }
  return [
    "[tldrx] build: a Definition of Done is a DELTA gate, and these commands already fail on the "
      + "untouched base tree — every story would block for something no story caused:",
    ...failed,
    `Fix ${WORKSPACE_FILE} (or the base tree), then run \`tldrx next\` again. `
      + "Nothing was dispatched and nothing was charged.",
  ];
}

/**
 * One line, and only when `tldrx init` ALREADY measured this same command red (#168).
 *
 * It costs nothing and it saves the operator the search: the command was broken before
 * any story existed, and `workspace.yml` has said so since the day it was written. It
 * changes no verdict — the refusal above stands on the preflight's own measurement —
 * and it is silent whenever there is no probe, which is every `workspace.yml` written
 * before `command_probes:` existed.
 */
export function initProbeLine(
  workspace: WorkspaceContext | undefined, result: BaseCommandResult,
): string | null {
  if (workspace === undefined) return null;
  const roles = workspace.commandRoles.get(result.repo);
  const probes = workspace.commandProbes.get(result.repo);
  if (roles === undefined || probes === undefined) return null;
  for (const [slot, command] of roles) {
    if (command !== result.command) continue;
    const probe = probes.get(slot);
    // Only a MEASURED red is worth saying. A row with `exit_code: null` was never run
    // — not probed, timed out, skipped — and "we did not look" is not corroboration.
    if (probe === undefined || probe.verified || probe.exit_code === null) return null;
    return `    · \`tldrx init\` measured this red too, at ${probe.at}: ${probe.reason}`;
  }
  return null;
}

/** The attribution, when a story's DoD went red for a reason the base shares. */
export function preExistingFailureReason(result: BaseCommandResult): string {
  const code = String(result.exitCode ?? "?");
  return `\`${result.command}\` exited ${code} — and it exits `
    + `${code} on the untouched base tree too (${result.repo} @ \`${result.baseRef}\`), `
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
