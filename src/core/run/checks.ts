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
import { basename, join } from "node:path";
import { runtime } from "../runtime/index.ts";
import { parseYaml } from "../yaml.ts";
import {
  BULLET_RULE, EMPTY_SECTION_RULE, isHandoff, noneBullet, validateCitations, validateHandoff,
  type CitationReport, type HandoffIssue, type HandoffValidation,
} from "../text/handoff.ts";
import { srcRule, type SrcRuleId } from "../text/srcToken.ts";
import { validateRunBudget } from "../budget/RunBudget.ts";
import { loadWorkspace, repoPath, toSrcContext } from "../../hooks/lib/workspace.ts";
import { describePlanIssues, validatePlan, writesPlanArtefacts } from "../plan/validatePlan.ts";
import { branchModelFor, describeBranchModel } from "../plan/branchModel.ts";
import { validateRunFile } from "./RunFile.ts";
import { resolveMany, type PathContext } from "../facilitator/paths.ts";
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

/**
 * Every `.md` output this stage declared, read with the §2.8 grammar — and every
 * problem found in all of them reported at once.
 *
 * Two failures of the old body, both measured live 2026-08-31:
 *
 *   **It looked at one file** (issue #34). The filter was
 *   `endsWith("handoff.md")`, so a citation that refuses a stage when it is
 *   written in the handoff passed in silence when it was written in `design.md`
 *   or `scope.md` beside it. Every declared `.md` is read now: the four-section
 *   rule for the ones that ARE handoffs, and `validateCitations` — "a citation
 *   you wrote must be true" — for the ones that are not.
 *
 *   **It reported one problem** (issue #33). Each category returned on its first
 *   hit and `unresolved` reported only `[0]`, so a 226-bullet cap breach sat
 *   invisible behind one bad file path: fixing the visible one and re-running
 *   would have bought the next one at the price of a full paid pass. The report is
 *   a per-file, per-category summary now — the same convention the training
 *   validator uses, and the reason it is a SUMMARY rather than a dump is that a
 *   detail line ends up inside one-line renderings (`autoGate`, `next`), so 226
 *   line numbers would drown the one sentence that matters.
 */
function checkClaimSources(ctx: CheckContext): CheckOutcome {
  const declared = ctx.stage.outputs.filter((p) => p.endsWith(".md"));
  if (declared.length === 0) {
    return { id: "claim-sources", status: "skipped", detail: "the stage declares no .md output" };
  }
  // `{ epicRefs: true }` — the gate/stage side of the #140 opt-in. This check runs
  // at a stage boundary that already spawns git, so it may pay for a blob read; the
  // PreToolUse hook running the same validator on every write may not (spec §0).
  const srcCtx = toSrcContext(loadWorkspace(ctx.root), ctx.runDir, { epicRefs: true });
  const pathCtx: PathContext = { root: ctx.root, runDir: ctx.runDir };
  const failures: string[] = [];
  // Counted, never fatal: an `unverified` citation passes the check and blocks the
  // AUTO gate (spec §5, condition 5). The count is carried in `detail` because
  // `CheckOutcome` is a three-state contract every other check shares.
  let unverified = 0;
  // `noted` — an `absent:` over a path that exists with content (spec §2.8). It
  // does NOT fail this check and does NOT block the auto gate; both of those are
  // the point. What it does is get NAMED, here, in the one string both readers
  // print, so the two can never again disagree in silence (gh #110/#105).
  const noted: string[] = [];
  // `file` citations that resolve ONLY on something unmerged (gh #140). Like
  // `noted` they neither fail this check nor block the auto gate — a Watch stage
  // or a retro written about an unmerged epic cites that code by construction.
  // What they must not be is SILENT, so the ref is named here, in the one string
  // the gate, `next` and the run record all print.
  const epicOnly: string[] = [];
  let handoffs = 0;
  let others = 0;

  for (const rel of declared) {
    // A handoff is the one output whose ABSENCE is a failure: the stage's whole
    // record is in it. Anything else the stage declared and did not write is the
    // `--commit` gap check's business, not this one's — refusing a stage here for
    // an unwritten `questions.md` would fail every stage that had nothing to ask.
    const isHandoffOutput = rel.endsWith("handoff.md");
    const hits = resolveMany(rel, pathCtx);
    if (hits.length === 0 && isHandoffOutput) {
      failures.push(`${rel} was declared but never written`);
      continue;
    }
    for (const hit of hits) {
      if (!existsSync(hit.absolute)) {
        if (isHandoffOutput) failures.push(`${hit.path} was declared but never written`);
        continue;
      }
      const text = readFileSync(hit.absolute, "utf8");
      if (isHandoffOutput || isHandoff(text)) {
        handoffs++;
        const validation = validateHandoff(text, srcCtx);
        unverified += validation.unverified.length;
        noted.push(...notedPaths(validation.noted));
        epicOnly.push(...unmergedRefs(validation.epicOnly));
        failures.push(...describeHandoff(hit.path, validation, text));
        continue;
      }
      others++;
      const report = validateCitations(text, srcCtx);
      unverified += report.unverified.length;
      noted.push(...notedPaths(report.noted));
      epicOnly.push(...unmergedRefs(report.epicOnly));
      failures.push(...describeCitations(hit.path, report, text));
    }
  }

  if (failures.length > 0) {
    return { id: "claim-sources", status: "failed", detail: failures.join(" · ") };
  }
  const tail = unverified === 0 ? "" : `, ${UNVERIFIED_PREFIX}${unverified}`;
  const absences = noted.length === 0
    ? ""
    : `, ${NOTED_PREFIX}${String(noted.length)} (${some([...new Set(noted)])})`;
  const cited = others === 0 ? "" : ` + ${others} cited output(s)`;
  // Last, and after both counts that are parsed back out of this string, so a new
  // segment can never be mistaken for one of theirs.
  const unmerged = epicOnly.length === 0
    ? ""
    : `, ${EPIC_ONLY_PREFIX}${String(epicOnly.length)} (${some([...new Set(epicOnly)])})`;
  return {
    id: "claim-sources",
    status: "passed",
    detail: `${handoffs} handoff(s) sourced${cited}${tail}${absences}${unmerged}`,
  };
}

/**
 * The `absent:<path>` each `noted` issue is about — the point is to NAME them.
 *
 * Read off `issue.src`, which the §2.8 reader already parsed. Re-extracting it
 * here would mean a second regex over the `[src: …]` marker, which is #80 under a
 * new name and is refused on shape by `test/map-citations.test.ts`.
 */
function notedPaths(issues: readonly { readonly src?: string }[]): readonly string[] {
  return issues.map((issue) => {
    const raw = issue.src ?? "";
    if (!raw.startsWith("absent:")) return raw === "" ? "an absence" : raw;
    const rest = raw.slice("absent:".length);
    const hash = rest.indexOf("#");
    return hash === -1 ? rest : rest.slice(0, hash);
  });
}

/**
 * The unmerged ref each epic-only citation resolved on — the point is to NAME it
 * (gh #140), so a reader of the document on `main` knows which branch to look on.
 *
 * Read off `issue.src`, which the resolver already filled with the ref (or the
 * epic checkout) it resolved against. Re-deriving it from the `[src: …]` marker
 * here would be a second reader of the grammar, which is #80 under a new name.
 */
function unmergedRefs(issues: readonly { readonly src?: string }[]): readonly string[] {
  return issues.map((issue) => {
    const raw = issue.src ?? "";
    return raw === "" ? "an unmerged ref" : `${raw} — unmerged`;
  });
}

/** How many of one category are named before the rest become a count. */
const MAX_NAMED = 6;

function some(issues: readonly string[]): string {
  const shown = issues.slice(0, MAX_NAMED).join(", ");
  const rest = issues.length - Math.min(issues.length, MAX_NAMED);
  return rest > 0 ? `${shown} (+${String(rest)} more)` : shown;
}

/**
 * The malformed phrase, naming the RULES that fired and quoting one offender.
 *
 * Before gh #77 this said "the [src: …] token must be last on the line" whatever
 * had actually gone wrong, which is right for one of the three ways a token fails
 * to tokenise and misleading for the other two. The detail line is read inside
 * one-line renderings (`autoGate`, `next`), so it names the distinct rules and
 * quotes exactly ONE line — the full block, with a corrected example per line,
 * belongs to the hook's deny and is where an author is sent next.
 */
function malformedPhrase(issues: readonly HandoffIssue[], text: string): string {
  const rules = [...new Set(issues.map((i) => i.rule).filter((id): id is SrcRuleId => id !== undefined))];
  const named = rules.length === 0
    ? "the [src: …] token could not be read"
    : `rule(s) ${rules.map((id) => `\`${id}\``).join(", ")}`;
  const first = issues[0];
  const quoted = first === undefined ? null : quoteLine(text, first.line);
  const example = rules[0] === undefined ? "" : ` — write e.g. \`${srcRule(rules[0]).good}\``;
  return `${String(issues.length)} malformed citation(s) on `
    + `${some(issues.map((m) => `L${String(m.line)}`))} — ${named}`
    + (quoted === null ? "" : `; L${String(first?.line ?? 0)} reads \`${quoted}\``)
    + example;
}

/** Line `n` of the document, trimmed and capped — or null when there is none. */
function quoteLine(text: string, line: number): string | null {
  if (text === "" || line < 1) return null;
  const found = text.split("\n")[line - 1];
  if (found === undefined || found.trim() === "") return null;
  const trimmed = found.trim();
  return trimmed.length <= MAX_QUOTED_CHARS ? trimmed : `${trimmed.slice(0, MAX_QUOTED_CHARS)}…`;
}

const MAX_QUOTED_CHARS = 120;

/** One phrase per category that has anything in it — never just the first. */
function describeHandoff(rel: string, validation: HandoffValidation, text = ""): readonly string[] {
  if (validation.ok) return [];
  const parts: string[] = [];
  if (validation.missingSections.length > 0) {
    parts.push(`missing section(s) ${validation.missingSections.join(", ")}`);
  }
  if (validation.unsourced.length > 0) {
    const first = validation.unsourced[0];
    const quoted = first === undefined ? null : quoteLine(text, first);
    parts.push(`${String(validation.unsourced.length)} unsourced bullet(s) on `
      + `line(s) ${some(validation.unsourced.map(String))} — ${BULLET_RULE}`
      + (quoted === null ? "" : `; L${String(first ?? 0)} reads \`${quoted}\``));
  }
  if (validation.malformed.length > 0) parts.push(malformedPhrase(validation.malformed, text));
  if (validation.emptySections.length > 0) {
    parts.push(`section(s) with no list items — `
      + `${some(validation.emptySections.map((s) => `${s.name} (L${String(s.line)})`))}. `
      + `${EMPTY_SECTION_RULE}; write \`${noneBullet("<what you looked at>")}\``);
  }
  parts.push(...unresolvedPhrase(validation.unresolved));
  return parts.length === 0 ? [] : [`${rel}: ${parts.join("; ")}`];
}

function describeCitations(rel: string, report: CitationReport, text = ""): readonly string[] {
  const parts: string[] = [];
  if (report.malformed.length > 0) parts.push(malformedPhrase(report.malformed, text));
  parts.push(...unresolvedPhrase(report.unresolved));
  return parts.length === 0 ? [] : [`${rel}: ${parts.join("; ")}`];
}

/**
 * File-level problems FIRST. `validateHandoff` appends the bullet-cap breach to
 * `unresolved` with line 0, so a file with 226 bullets and one bad path put the
 * cap behind 200-odd citations — exactly the failure issue #33 was filed for.
 */
function unresolvedPhrase(issues: readonly HandoffIssue[]): readonly string[] {
  if (issues.length === 0) return [];
  const ordered = [...issues.filter((i) => i.line === 0), ...issues.filter((i) => i.line !== 0)];
  // A grammar failure inside a token that DID tokenise arrives here rather than in
  // `malformed`; it carries a rule id, and naming it costs six characters (gh #77).
  const named = ordered.map((i) => {
    const rule = i.rule === undefined ? "" : ` [rule \`${i.rule}\`]`;
    return i.line === 0 ? `${i.message}${rule}` : `L${String(i.line)}: ${i.message}${rule}`;
  });
  return [`${String(issues.length)} unresolvable source(s) — ${some(named)}`];
}

/** How an unverified count is written into `claim-sources`' detail, and read back out. */
export const UNVERIFIED_PREFIX = "unverified: ";

/**
 * How an UNCHECKED ABSENCE is written into that same detail (gh #110).
 *
 * Deliberately a different prefix from `UNVERIFIED_PREFIX`, and deliberately read
 * by a different function: the auto gate refuses to close over an `unverified`
 * citation and closes over a `noted` one, and the two counts have to be tellable
 * apart in the one string that carries both.
 */
export const NOTED_PREFIX = "unchecked absence: ";

/**
 * How an EPIC-ONLY citation is written into that same detail (gh #140).
 *
 * A third prefix, for a third answer: `unverified` blocks an auto gate, `noted`
 * does not and is about an absence, and this one does not and is about a
 * PRESENCE — on a branch nothing has merged. The whole reason it exists is that
 * the alternative was silence: `retro.md` reached `main` with 96 citations to
 * `epic/money-and-payments` and no reader was ever told where to look.
 */
export const EPIC_ONLY_PREFIX = "on unmerged refs: ";

/** The number of epic-only citations a `claim-sources` outcome reported, or 0. */
export function epicOnlyCount(outcome: CheckOutcome): number {
  if (outcome.id !== "claim-sources") return 0;
  const at = outcome.detail.indexOf(EPIC_ONLY_PREFIX);
  if (at === -1) return 0;
  const parsed = Number.parseInt(outcome.detail.slice(at + EPIC_ONLY_PREFIX.length), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** The number of unchecked absences a `claim-sources` outcome reported, or 0. */
export function notedCount(outcome: CheckOutcome): number {
  if (outcome.id !== "claim-sources") return 0;
  const at = outcome.detail.indexOf(NOTED_PREFIX);
  if (at === -1) return 0;
  const parsed = Number.parseInt(outcome.detail.slice(at + NOTED_PREFIX.length), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

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
 *
 * A passing detail also states the BRANCH MODEL (issue #57). The Plan already
 * knows whether the epics depend on each other, and the run cuts one integration
 * branch when they do; a host that learns that from a Build stage mid-flight is
 * the exact failure the owner decided against on 2026-09-01. The run id comes
 * from the run directory's name, which is what `RunStore` calls the run.
 */
function checkPlan(ctx: CheckContext): CheckOutcome {
  if (!writesPlanArtefacts(ctx.stage.outputs)) {
    return { id: "plan", status: "skipped", detail: "the stage declares no waves.yml output" };
  }
  const planDir = join(ctx.runDir, ctx.stage.phase);
  const report = validatePlan(planDir, loadWorkspace(ctx.root).commands);
  if (!report.ok) {
    return { id: "plan", status: "failed", detail: describePlanIssues(report.issues) };
  }
  const model = branchModelFor(basename(ctx.runDir), report.epicChain);
  return {
    id: "plan",
    status: "passed",
    detail: `${report.epicCount} epic(s), ${report.storyCount} story(ies), ${report.waveCount} wave(s)`
      + ` — ${describeBranchModel(model)}`,
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
  const ran = await runAllowlisted(check.command, check.repo, check.expect_exit, ctx, ctx.stage.timeout_s);
  return { id: "cmd", status: ran.ok ? "passed" : "failed", detail: ran.detail };
}

/** What one allowlisted command did: the two things a caller reports, plus how long. */
export interface CommandRun {
  readonly ok: boolean;
  /** `null` when the command timed out or was never allowed to start. */
  readonly exitCode: number | null;
  readonly ms: number;
  readonly detail: string;
  /**
   * True only when the clock killed it — as opposed to a refusal, an unknown
   * repo, or a wrong exit code, which also leave `exitCode` null. A caller that
   * rewrites the timeout message (`runPrecondition` does) needs to tell those
   * apart without reading prose.
   */
  readonly timedOut: boolean;
}

/**
 * Run ONE `workspace.yml` command in ONE repo and say what it did.
 *
 * Both callers that run a command out of a stage file land here — the `cmd` check
 * above, which runs AFTER the stage, and `runPrecondition` below, which runs
 * before it. They share this body on purpose: the allowlist comparison, the
 * argv-split-never-a-shell rule and the timeout are the safety properties, and a
 * second copy of them is a second place for one of the three to go missing.
 *
 * The one thing they do NOT share is the clock (issue #20). A `cmd` check runs
 * the stage's work and gets the stage's `timeout_s`; a precondition asks a
 * liveness question before the work and gets its own, much shorter one. So the
 * seconds are a parameter here rather than read off `ctx.stage`.
 */
async function runAllowlisted(
  command: string,
  repo: string,
  expectExit: number,
  ctx: CheckContext,
  timeoutS: number,
): Promise<CommandRun> {
  return await runDeclaredCommand(ctx.root, command, repo, expectExit, timeoutS);
}

/**
 * The same body, addressed by workspace root rather than by a `CheckContext`.
 *
 * `tldrx watch check --execute` (issue #65) re-runs the `$ <cmd> → exit <n>`
 * source a watcher card recorded, months after the run that wrote it closed —
 * there is no stage and no `CheckContext` at that point, only a root and a card.
 * It is the same function and not a second one on purpose: the allowlist
 * comparison, the argv-split-never-a-shell rule and the timeout are the safety
 * properties, and a second copy of them is a second place for one of the three to
 * go missing.
 */
export async function runDeclaredCommand(
  root: string,
  command: string,
  repo: string,
  expectExit: number,
  timeoutS: number,
): Promise<CommandRun> {
  const workspace = loadWorkspace(root);
  const refusal = allowlistIssue(command, workspace.commands, "stage");
  if (refusal !== null) return { ok: false, exitCode: null, ms: 0, detail: refusal, timedOut: false };
  const cwd = repoPath(workspace, repo);
  if (cwd === null) {
    return {
      ok: false, exitCode: null, ms: 0, timedOut: false,
      detail: `unknown repo \`${repo}\` (not in workspace.yml)`,
    };
  }
  const argv = command.split(/\s+/).filter((part) => part !== "");
  const head = argv[0];
  if (head === undefined) return { ok: false, exitCode: null, ms: 0, detail: "empty command", timedOut: false };

  const started = Date.now();
  const outcome = await runtime.spawn(head, argv.slice(1), { cwd, timeoutMs: timeoutS * 1000 });
  const ms = Date.now() - started;
  if (outcome.timedOut) {
    return {
      ok: false, exitCode: null, ms, timedOut: true,
      detail: `\`${command}\` in ${repo} timed out after ${String(timeoutS)}s`,
    };
  }
  if (outcome.exitCode !== expectExit) {
    return {
      ok: false,
      exitCode: outcome.exitCode,
      ms,
      timedOut: false,
      detail: `\`${command}\` in ${repo} exited ${outcome.exitCode} (expected ${expectExit}) — ${lastLine(outcome.stdout, outcome.stderr)}`,
    };
  }
  return {
    ok: true, exitCode: outcome.exitCode, ms, timedOut: false,
    detail: `\`${command}\` in ${repo} exited ${outcome.exitCode}`,
  };
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
  const ran = await runAllowlisted(
    precondition.command, precondition.repo, precondition.expect_exit, ctx, precondition.timeout_s,
  );
  return {
    ...ran,
    // A hung precondition is the failure this whole feature exists to catch, so
    // its message names the precondition, its own clock, and the knob that
    // changes it — never the stage's `timeout_s`, which is the number that used
    // to apply here and the reason a dead daemon could cost half an hour
    // (issue #20).
    detail: ran.timedOut ? timeoutDetail(precondition) : ran.detail,
    id: precondition.id,
    repo: precondition.repo,
    command: precondition.command,
  };
}

function timeoutDetail(precondition: PlannedPrecondition): string {
  return `precondition \`${precondition.id}\`: \`${precondition.command}\` in ${precondition.repo} `
    + `timed out after ${String(precondition.timeout_s)}s and was killed. Preconditions have their own clock — `
    + `the stage's \`timeout_s\` never applies to one. Raise it with \`timeout_s:\` on this precondition, `
    + "or fix whatever the command is waiting for.";
}

function lastLine(stdout: string, stderr: string, max = 160): string {
  const lines = `${stdout}\n${stderr}`.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim() !== "");
  const last = lines[lines.length - 1] ?? "(no output)";
  return last.length > max ? `${last.slice(0, max - 1)}…` : last;
}
