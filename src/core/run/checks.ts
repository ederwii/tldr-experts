/**
 * Re-running a stage's `checks` at gate time (spec §2.3, §3).
 *
 * `tldrx approve` does not take the stage's word for it: the checks the stage
 * declared are run again, now, against what is actually on disk. A gate that
 * approves without re-checking is a rubber stamp, and the whole point of the gate
 * is that it is not one.
 *
 * Implemented ids: `claim-sources` (the §2.8 handoff validator), `schema` (the
 * §2.2/§2.11 validators over the run's own files), `plan` (the §2.13–§2.15
 * epics/stories/waves validators, read together) and `cmd` (a workspace.yml
 * command, run for real). `[assumption]` — `no-reask`, `budget-gate` and `dod` are
 * PreToolUse write-time hooks with nothing to re-check at a gate, so they are
 * reported as skipped rather than silently counted as passes.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runtime } from "../runtime/index.ts";
import { parseYaml } from "../yaml.ts";
import { validateHandoff } from "../text/handoff.ts";
import { validateRunBudget } from "../budget/RunBudget.ts";
import { loadWorkspace, repoPath, toSrcContext } from "../../hooks/lib/workspace.ts";
import { describePlanIssues, validatePlan } from "../plan/validatePlan.ts";
import { validateRunFile } from "./RunFile.ts";
import { allowlistIssue } from "../schemas/commandAllowlist.ts";
import type { PlannedCheck, PlannedPrecondition, PlannedStage } from "./workflowPreset.ts";

export const WRITE_TIME_ONLY: readonly string[] = ["no-reask", "budget-gate", "dod"];

export type CheckStatus = "passed" | "failed" | "skipped";

export interface CheckOutcome {
  readonly id: string;
  readonly status: CheckStatus;
  readonly detail: string;
}

export interface CheckContext {
  readonly root: string;
  readonly runDir: string;
  readonly stage: PlannedStage;
}

export async function runChecks(
  checks: readonly PlannedCheck[],
  ctx: CheckContext,
): Promise<readonly CheckOutcome[]> {
  const outcomes: CheckOutcome[] = [];
  for (const check of checks) outcomes.push(await runCheck(check, ctx));
  return outcomes;
}

export async function runCheck(check: PlannedCheck, ctx: CheckContext): Promise<CheckOutcome> {
  if (WRITE_TIME_ONLY.includes(check.id)) {
    return { id: check.id, status: "skipped", detail: "write-time hook — nothing to re-check at a gate" };
  }
  switch (check.id) {
    case "claim-sources":
      return checkClaimSources(ctx);
    case "schema":
      return checkSchema(ctx);
    case "plan":
      return checkPlan(ctx);
    case "cmd":
      return await checkCommand(check, ctx);
    default:
      return { id: check.id, status: "skipped", detail: `unknown check id '${check.id}'` };
  }
}

/** Every handoff this stage declared must parse and have a source on every bullet. */
function checkClaimSources(ctx: CheckContext): CheckOutcome {
  const handoffs = ctx.stage.outputs.filter((p) => p.endsWith("handoff.md"));
  if (handoffs.length === 0) {
    return { id: "claim-sources", status: "skipped", detail: "the stage declares no handoff.md output" };
  }
  const srcCtx = toSrcContext(loadWorkspace(ctx.root), ctx.runDir);
  // Counted, never fatal: an `unverified` citation passes the check and blocks the
  // AUTO gate (spec §5, condition 5). The count is carried in `detail` because
  // `CheckOutcome` is a three-state contract every other check shares.
  let unverified = 0;
  for (const rel of handoffs) {
    const path = join(ctx.runDir, rel);
    if (!existsSync(path)) {
      return { id: "claim-sources", status: "failed", detail: `${rel} was declared but never written` };
    }
    const validation = validateHandoff(readFileSync(path, "utf8"), srcCtx);
    if (validation.ok) {
      unverified += validation.unverified.length;
      continue;
    }
    if (validation.missingSections.length > 0) {
      return { id: "claim-sources", status: "failed", detail: `${rel} is missing section(s) ${validation.missingSections.join(", ")}` };
    }
    if (validation.unsourced.length > 0) {
      return { id: "claim-sources", status: "failed", detail: `${rel}: unsourced bullet(s) on line(s) ${validation.unsourced.join(", ")}` };
    }
    if (validation.malformed.length > 0) {
      const named = validation.malformed.map((m) => `L${m.line}`).join(", ");
      return {
        id: "claim-sources",
        status: "failed",
        detail: `${rel}: malformed citation(s) on ${named} — the [src: …] token must be last on the line`,
      };
    }
    if (validation.emptySections.length > 0) {
      const named = validation.emptySections.map((s) => `${s.name} (L${String(s.line)})`).join(", ");
      return {
        id: "claim-sources",
        status: "failed",
        detail: `${rel}: section(s) with no list items — ${named}. Write \`- none [src: absent:<what you looked at>]\``,
      };
    }
    return { id: "claim-sources", status: "failed", detail: `${rel}: ${validation.unresolved[0]?.message ?? "unresolvable source"}` };
  }
  const tail = unverified === 0 ? "" : `, ${UNVERIFIED_PREFIX}${unverified}`;
  return { id: "claim-sources", status: "passed", detail: `${handoffs.length} handoff(s) sourced${tail}` };
}

/** How an unverified count is written into `claim-sources`' detail, and read back out. */
export const UNVERIFIED_PREFIX = "unverified: ";

/** The number of unverified citations a `claim-sources` outcome reported, or 0. */
export function unverifiedCount(outcome: CheckOutcome): number {
  if (outcome.id !== "claim-sources") return 0;
  const at = outcome.detail.indexOf(UNVERIFIED_PREFIX);
  if (at === -1) return 0;
  const parsed = Number.parseInt(outcome.detail.slice(at + UNVERIFIED_PREFIX.length), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * The Plan phase's epics, stories and waves, read together (spec §2.13–§2.15).
 * Skipped for any stage that does not declare `waves.yml` as an output — the check
 * is listed on the Plan stage and would otherwise fail every other stage's gate.
 */
function checkPlan(ctx: CheckContext): CheckOutcome {
  if (!ctx.stage.outputs.some((p) => p.endsWith("waves.yml"))) {
    return { id: "plan", status: "skipped", detail: "the stage declares no waves.yml output" };
  }
  const planDir = join(ctx.runDir, ctx.stage.phase);
  const report = validatePlan(planDir, loadWorkspace(ctx.root).commands);
  if (!report.ok) {
    return { id: "plan", status: "failed", detail: describePlanIssues(report.issues) };
  }
  return {
    id: "plan",
    status: "passed",
    detail: `${report.epicCount} epic(s), ${report.storyCount} story(ies), ${report.waveCount} wave(s)`,
  };
}

/** The run's own two schema files, revalidated off disk. */
function checkSchema(ctx: CheckContext): CheckOutcome {
  const pairs: [string, (input: unknown) => { ok: boolean; issues: readonly { path: string; message: string }[] }][] = [
    ["run.yml", validateRunFile],
    ["budget.yml", validateRunBudget],
  ];
  for (const [name, validate] of pairs) {
    const path = join(ctx.runDir, name);
    if (!existsSync(path)) return { id: "schema", status: "failed", detail: `${name} is missing` };
    const validation = validate(parseYaml(readFileSync(path, "utf8")));
    if (!validation.ok) {
      const first = validation.issues[0];
      return { id: "schema", status: "failed", detail: `${name}: ${first?.path ?? ""} ${first?.message ?? ""}`.trim() };
    }
  }
  return { id: "schema", status: "passed", detail: "run.yml and budget.yml validate" };
}

/**
 * Spec §2.3: "Command must equal a `workspace.yml` command verbatim." A stage file
 * is data, and data does not get to invent a shell command — so the command is
 * looked up in workspace.yml and then run as a single argv, never through a shell.
 */
async function checkCommand(check: PlannedCheck, ctx: CheckContext): Promise<CheckOutcome> {
  if (check.command === null || check.repo === null) {
    return { id: "cmd", status: "failed", detail: "a `cmd` check needs both `repo` and `command`" };
  }
  const ran = await runAllowlisted(check.command, check.repo, check.expect_exit, ctx);
  return { id: "cmd", status: ran.ok ? "passed" : "failed", detail: ran.detail };
}

/** What one allowlisted command did: the two things a caller reports, plus how long. */
export interface CommandRun {
  readonly ok: boolean;
  /** `null` when the command timed out or was never allowed to start. */
  readonly exitCode: number | null;
  readonly ms: number;
  readonly detail: string;
}

/**
 * Run ONE `workspace.yml` command in ONE repo and say what it did.
 *
 * Both callers that run a command out of a stage file land here — the `cmd` check
 * above, which runs AFTER the stage, and `runPrecondition` below, which runs
 * before it. They share this body on purpose: the allowlist comparison, the
 * argv-split-never-a-shell rule and the timeout are the safety properties, and a
 * second copy of them is a second place for one of the three to go missing.
 */
async function runAllowlisted(
  command: string,
  repo: string,
  expectExit: number,
  ctx: CheckContext,
): Promise<CommandRun> {
  const workspace = loadWorkspace(ctx.root);
  const refusal = allowlistIssue(command, workspace.commands, "stage");
  if (refusal !== null) return { ok: false, exitCode: null, ms: 0, detail: refusal };
  const cwd = repoPath(workspace, repo);
  if (cwd === null) {
    return { ok: false, exitCode: null, ms: 0, detail: `unknown repo \`${repo}\` (not in workspace.yml)` };
  }
  const argv = command.split(/\s+/).filter((part) => part !== "");
  const head = argv[0];
  if (head === undefined) return { ok: false, exitCode: null, ms: 0, detail: "empty command" };

  const started = Date.now();
  const outcome = await runtime.spawn(head, argv.slice(1), { cwd, timeoutMs: ctx.stage.timeout_s * 1000 });
  const ms = Date.now() - started;
  if (outcome.timedOut) {
    return { ok: false, exitCode: null, ms, detail: `\`${command}\` in ${repo} timed out after ${ctx.stage.timeout_s}s` };
  }
  if (outcome.exitCode !== expectExit) {
    return {
      ok: false,
      exitCode: outcome.exitCode,
      ms,
      detail: `\`${command}\` in ${repo} exited ${outcome.exitCode} (expected ${expectExit}) — ${lastLine(outcome.stdout, outcome.stderr)}`,
    };
  }
  return { ok: true, exitCode: outcome.exitCode, ms, detail: `\`${command}\` in ${repo} exited ${outcome.exitCode}` };
}

/** One precondition's result — `CommandRun` plus the id and command that produced it. */
export interface PreconditionOutcome extends CommandRun {
  readonly id: string;
  readonly repo: string;
  readonly command: string;
}

/**
 * Design §F.1: an operational precondition, run BEFORE a bundle is written and
 * before anything is spawned.
 *
 * It is the `cmd` check's own body (`runAllowlisted`) pointed at the other end of
 * the stage. The reason it is not literally `runCheck({id: "cmd", …})` is that
 * `runCheck` dispatches on `check.id` and a precondition's id is its NAME
 * (`docker`, `sdk`) — the thing the operator line and the exit-2 message have to
 * say back. The command-running half, which is the half with the safety
 * properties in it, is shared exactly.
 */
export async function runPrecondition(
  precondition: PlannedPrecondition,
  ctx: CheckContext,
): Promise<PreconditionOutcome> {
  const ran = await runAllowlisted(precondition.command, precondition.repo, precondition.expect_exit, ctx);
  return { ...ran, id: precondition.id, repo: precondition.repo, command: precondition.command };
}

function lastLine(stdout: string, stderr: string, max = 160): string {
  const lines = `${stdout}\n${stderr}`.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim() !== "");
  const last = lines[lines.length - 1] ?? "(no output)";
  return last.length > max ? `${last.slice(0, max - 1)}…` : last;
}
