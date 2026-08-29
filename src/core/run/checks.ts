/**
 * Re-running a stage's `checks` at gate time (spec §2.3, §3).
 *
 * `tldrx approve` does not take the stage's word for it: the checks the stage
 * declared are run again, now, against what is actually on disk. A gate that
 * approves without re-checking is a rubber stamp, and the whole point of the gate
 * is that it is not one.
 *
 * Implemented ids: `claim-sources` (the §2.8 handoff validator), `schema` (the
 * §2.2/§2.11 validators over the run's own files) and `cmd` (a workspace.yml
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
import { validateRunFile } from "./RunFile.ts";
import type { PlannedCheck, PlannedStage } from "./workflowPreset.ts";

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
  for (const rel of handoffs) {
    const path = join(ctx.runDir, rel);
    if (!existsSync(path)) {
      return { id: "claim-sources", status: "failed", detail: `${rel} was declared but never written` };
    }
    const validation = validateHandoff(readFileSync(path, "utf8"), srcCtx);
    if (validation.ok) continue;
    if (validation.missingSections.length > 0) {
      return { id: "claim-sources", status: "failed", detail: `${rel} is missing section(s) ${validation.missingSections.join(", ")}` };
    }
    if (validation.unsourced.length > 0) {
      return { id: "claim-sources", status: "failed", detail: `${rel}: unsourced bullet(s) on line(s) ${validation.unsourced.join(", ")}` };
    }
    return { id: "claim-sources", status: "failed", detail: `${rel}: ${validation.unresolved[0]?.message ?? "unresolvable source"}` };
  }
  return { id: "claim-sources", status: "passed", detail: `${handoffs.length} handoff(s) sourced` };
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
  const workspace = loadWorkspace(ctx.root);
  if (!workspace.commands.has(check.command)) {
    return {
      id: "cmd",
      status: "failed",
      detail: `\`${check.command}\` is not one of .tldrx/workspace.yml's commands — a stage may not invent one`,
    };
  }
  const cwd = repoPath(workspace, check.repo);
  if (cwd === null) {
    return { id: "cmd", status: "failed", detail: `unknown repo \`${check.repo}\` (not in workspace.yml)` };
  }
  const argv = check.command.split(/\s+/).filter((part) => part !== "");
  const head = argv[0];
  if (head === undefined) return { id: "cmd", status: "failed", detail: "empty command" };

  const outcome = await runtime.spawn(head, argv.slice(1), { cwd, timeoutMs: ctx.stage.timeout_s * 1000 });
  if (outcome.timedOut) {
    return { id: "cmd", status: "failed", detail: `\`${check.command}\` in ${check.repo} timed out after ${ctx.stage.timeout_s}s` };
  }
  if (outcome.exitCode !== check.expect_exit) {
    return {
      id: "cmd",
      status: "failed",
      detail: `\`${check.command}\` in ${check.repo} exited ${outcome.exitCode} (expected ${check.expect_exit}) — ${lastLine(outcome.stdout, outcome.stderr)}`,
    };
  }
  return { id: "cmd", status: "passed", detail: `\`${check.command}\` in ${check.repo} exited ${outcome.exitCode}` };
}

function lastLine(stdout: string, stderr: string, max = 160): string {
  const lines = `${stdout}\n${stderr}`.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim() !== "");
  const last = lines[lines.length - 1] ?? "(no output)";
  return last.length > max ? `${last.slice(0, max - 1)}…` : last;
}
