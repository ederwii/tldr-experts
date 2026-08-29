/**
 * `tldrx run new` — open a piece of work (spec §3, §2.2, §2.11, §6).
 *
 * Deterministic and offline: no LLM, no network. It reads a scope preset and its
 * stage files, seeds run.yml + budget.yml + events.jsonl + the phase folders, and
 * optionally distills an AI-DLC intent folder into `01-what/`.
 *
 * **Atomicity.** Everything is written into a sibling temp directory, validated
 * there, and only then renamed into place. A validation failure leaves the
 * workspace exactly as it was — no half-run to clean up by hand.
 *
 * `[assumption]`s, all because the spec is silent:
 *   - The run id's `yymmdd` is **UTC**, so the same command run either side of a
 *     local midnight is reproducible.
 *   - Every stage is seeded `pending` (not `ready`); the run status is then
 *     *derived* per §2.2 as "the status of the stage at the cursor".
 *   - `per_agent_max_usd` is the largest scaled stage budget, so no stage is
 *     seeded with a share its own sub-agent cap would refuse.
 *   - `--repos` defaults to every repo in workspace.yml.
 *   - A workspace's `.tldrx/workflows/` and `.tldrx/stages/` win over the
 *     framework's shipped copies (see `workflowPreset.ts`).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_WORK_DIR } from "../paths.ts";
import { EventLog } from "../events/EventLog.ts";
import type { TldrxEvent } from "../events/Event.ts";
import { FactsStore } from "../facts/FactsStore.ts";
import { validateFactsFile } from "../facts/validateFactsFile.ts";
import { parseYaml } from "../yaml.ts";
import { validateHandoff } from "../text/handoff.ts";
import { parseQuestions, validateQuestions } from "../text/questions.ts";
import { factsPath, loadWorkspace, toSrcContext } from "../../hooks/lib/workspace.ts";
import { validateRunBudget, type RunBudget } from "../budget/RunBudget.ts";
import { distill, type DistillResult } from "../distill/distill.ts";
import { collectSeed, type SeedSet } from "../seed/collectSeed.ts";
import { allSeedHeadings, seedClaims } from "../seed/seedClaims.ts";
import { renderSeedHandoff, renderSeedIndex, SEED_INDEX } from "../seed/renderSeed.ts";
import { findDuplicate } from "../facts/findDuplicate.ts";
import { renderHandoff, renderProse, renderQuestions, targetOf } from "../distill/renderDistill.ts";
import { emitBudgetYaml, emitRunYaml } from "./emitRunYaml.ts";
import { loadWorkflowPreset, MAX_STAGE_INPUTS, type PlannedStage, type WorkflowPreset } from "./workflowPreset.ts";
import { deriveRunStatus, validateRunFile, type RunFile, type RunPhase, type RunStage } from "./RunFile.ts";

export class NewRunError extends Error {}

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** Spec §2.11 default. */
export const DEFAULT_WARN_AT_PCT = 80;
const MIN_STAGE_BUDGET = 0.01;

export interface NewRunOptions {
  readonly root: string;
  readonly slug: string;
  readonly title?: string;
  readonly scope: string;
  readonly budgetUsd?: number;
  readonly repos?: readonly string[];
  readonly from?: string;
  /**
   * `--seed <file|dir>` — generic document import (spec §6.1). Mutually exclusive
   * with `--from`, which is AI-DLC-specific: both write `01-what/handoff.md`, and
   * two importers fighting over one file is a bug waiting to be reported as a
   * mystery. `[assumption]`
   */
  readonly seed?: string;
  readonly actor: string;
  readonly now: Date;
}

export interface NewRunOutcome {
  readonly runId: string;
  readonly runDir: string;
  readonly preset: WorkflowPreset;
  readonly ceilingUsd: number;
  readonly stageCount: number;
  readonly distill: DistillResult | null;
  /** What `--seed` read, or null when it was not passed. */
  readonly seed: SeedSet | null;
  /** Facts the distill actually appended to `facts.yml`. */
  readonly factsAppended: number;
  /** Distilled facts that an existing non-retired fact already said. */
  readonly factsReused: number;
  /** Every file written, relative to the run dir, in write order. */
  readonly files: readonly string[];
}

/**
 * How close a distilled fact must be to an existing one to count as the SAME
 * fact rather than a new one.
 *
 * Deliberately higher than the §4 re-ask threshold (0.6). 0.6 means "you already
 * asked something like this"; here the question is "is this literally the fact we
 * already recorded", and importing the same intent folder twice must answer yes.
 * `distill` itself only drops claims that CONTRADICT a fact — identical text is
 * agreement, and agreement used to be appended as a brand-new row.
 */
export const SAME_FACT_THRESHOLD = 0.9;

export function createRun(options: NewRunOptions): NewRunOutcome {
  if (!SLUG_RE.test(options.slug)) {
    throw new NewRunError(`'${options.slug}' is not a slug — expected ^[a-z0-9][a-z0-9-]{0,39}$`);
  }
  const runId = `${yymmdd(options.now)}-${options.slug}`;
  const workDir = join(options.root, PROJECT_WORK_DIR);
  const runDir = join(workDir, runId);
  if (existsSync(runDir)) throw new NewRunError(`${PROJECT_WORK_DIR}/${runId} already exists`);
  if (options.from !== undefined && !existsSync(options.from)) {
    throw new NewRunError(`--from: no such directory: ${options.from}`);
  }
  if (options.from !== undefined && options.seed !== undefined) {
    throw new NewRunError(
      "--from and --seed both write 01-what/handoff.md — pass one.\n"
      + "  --from <dir>   an AI-DLC intent folder (spec §6)\n"
      + "  --seed <path>  any .md/.txt document or a directory of them (spec §6.1)",
    );
  }
  const seedSet = options.seed === undefined ? null : collectSeed(options.root, options.seed);

  const preset = loadWorkflowPreset(options.root, options.scope);
  const workspace = loadWorkspace(options.root);
  const repos = resolveRepos(options.repos, workspace.repos);
  const at = rfc3339(options.now);
  const budgetPlan = planBudget(preset, options.budgetUsd);

  const planned = buildPhases(preset, budgetPlan.perStage);
  const firstPhaseId = planned[0]?.id ?? "01-what";
  // Spec §2.3: `inputs` is "the ONLY files the sub-agent gets". A seeded run's
  // first stage therefore DECLARES its seed documents, or the facilitator would
  // inline a prompt that never mentions the requirements it was handed.
  const seedInputs = seedSet === null
    ? []
    : [`${firstPhaseId}/${SEED_INDEX}`, ...seedSet.documents.map((document) => document.rel)];
  const phases = declareSeedInputs(planned, seedInputs);
  const first = phases[0]?.stages[0];
  if (first === undefined) throw new NewRunError(`workflow '${preset.name}' produced no stages`);

  const seed: RunFile = {
    version: 1,
    run: runId,
    title: options.title ?? titleFromSlug(options.slug),
    scope: options.scope,
    workflow: preset.name,
    repos,
    created_at: at,
    updated_at: at,
    status: "pending",
    cursor: { phase: phases[0]?.id ?? "", stage: first.id, task: null },
    budget: {
      ceiling_usd: budgetPlan.ceiling,
      spent_usd: 0,
      per_agent_max_usd: budgetPlan.perAgentMax,
    },
    phases,
  };
  const run: RunFile = { ...seed, status: deriveRunStatus(seed) };

  const budget: RunBudget = {
    version: 1,
    run: runId,
    ceiling_usd: budgetPlan.ceiling,
    per_agent_max_usd: budgetPlan.perAgentMax,
    warn_at_pct: DEFAULT_WARN_AT_PCT,
    on_exceed: "block",
    phases: phases.map((p) => ({
      id: p.id,
      ceiling_usd: budgetPlan.perPhase.get(p.id) ?? 0,
      spent_usd: 0,
    })),
  };

  // --- distill (pure; nothing on disk yet) --------------------------------
  const factsStore = FactsStore.loadOrEmpty(factsPath(options.root));
  let result: DistillResult | null = null;
  if (options.from !== undefined) {
    result = distill(options.from, {
      run: runId,
      actor: options.actor,
      at,
      facts: factsStore.active,
    });
  }

  const temp = join(workDir, `.tmp-${runId}-${process.pid}`);
  rmSync(temp, { recursive: true, force: true });
  mkdirSync(temp, { recursive: true });

  const written: string[] = [];
  const appendedFacts: string[] = [];
  const reusedFacts: string[] = [];
  try {
    for (const phase of phases) mkdirSync(join(temp, phase.id), { recursive: true });

    const events = new EventLog(join(temp, "events.jsonl"));
    events.append(event(at, runId, "run.created", options.actor, {
      scope: options.scope,
      workflow: preset.name,
      repos: [...repos],
      ceiling_usd: budgetPlan.ceiling,
      stages: phases.reduce((n, p) => n + p.stages.length, 0),
      from: options.from ?? null,
      seed: options.seed ?? null,
      seed_documents: seedSet === null ? 0 : seedSet.documents.length,
    }));

    write(temp, "budget.yml", emitBudgetYaml(budget), written);
    write(temp, "run.yml", emitRunYaml(run), written);

    if (seedSet !== null) {
      const claims = seedClaims(seedSet.documents);
      const headings = allSeedHeadings(seedSet.documents);
      const indexPath = `${firstPhaseId}/${SEED_INDEX}`;
      const handoffPath = `${firstPhaseId}/handoff.md`;

      write(temp, indexPath, renderSeedIndex(runId, seedSet, firstPhaseId), written);
      const handoff = renderSeedHandoff({
        runId,
        stageId: preset.stages[0]?.id ?? "what",
        phase: firstPhaseId,
        at,
        seed: seedSet,
        claims,
        headings,
      });
      write(temp, handoffPath, handoff, written);
      // `temp` IS the run dir until the atomic rename, and the seed documents are
      // cited workspace-relative, so both bases §2.8 uses resolve here already.
      const check = validateHandoff(handoff, toSrcContext(workspace, temp));
      if (!check.ok) {
        throw new NewRunError(
          `seeded handoff is invalid: ${describeHandoff(check.missingSections, check.unsourced, check.unresolved)}`,
        );
      }
    }

    let factsYaml: string | null = null;
    if (result !== null) {
      const whatStage = preset.stages[0];
      const declared = whatStage === undefined ? [] : [...whatStage.outputs];
      const phaseId = phases[0]?.id ?? "01-what";

      const intentClaims = result.claims.filter((c) => targetOf(c.file) === "intent");
      const scopeClaims = result.claims.filter((c) => targetOf(c.file) === "scope");
      const intentPath = `${phaseId}/intent.md`;
      const scopePath = `${phaseId}/scope.md`;
      const handoffPath = `${phaseId}/handoff.md`;
      const questionsPath = `${phaseId}/questions.md`;

      write(temp, intentPath, renderProse("Intent", runId, options.from ?? "", intentClaims), written);
      write(temp, scopePath, renderProse("Scope", runId, options.from ?? "", scopeClaims), written);

      const writtenOutputs = [intentPath, scopePath];
      if (intentClaims.length === 0) writtenOutputs.splice(writtenOutputs.indexOf(intentPath), 1);
      if (scopeClaims.length === 0) writtenOutputs.splice(writtenOutputs.indexOf(scopePath), 1);

      const handoff = renderHandoff({
        runId,
        stageId: whatStage?.id ?? "what",
        phase: phaseId,
        at,
        result,
        declaredOutputs: declared,
        writtenOutputs,
      });
      write(temp, handoffPath, handoff, written);
      // `temp` IS the run dir until the atomic rename below, so run-relative
      // citations in the distilled handoff resolve here too.
      const srcCtx = toSrcContext(workspace, temp);
      const handoffCheck = validateHandoff(handoff, srcCtx);
      if (!handoffCheck.ok) {
        throw new NewRunError(
          `distilled handoff is invalid: ${describeHandoff(handoffCheck.missingSections, handoffCheck.emptySections, handoffCheck.unsourced, handoffCheck.unresolved)}`,
        );
      }

      if (result.conflicts.length > 0) {
        const text = renderQuestions(runId, phaseId, at, result.conflicts);
        write(temp, questionsPath, text, written);
        const issues = validateQuestions(parseQuestions(text));
        if (issues.length > 0) {
          throw new NewRunError(`distilled questions.md is invalid: ${issues[0]?.message ?? ""}`);
        }
      }

      for (const fact of result.facts) {
        // `active` is recomputed per call, so this also collapses two identical
        // claims inside ONE import, not just a re-import of the same folder.
        const already = findDuplicate(fact.fact, fact.area, factsStore.active, SAME_FACT_THRESHOLD);
        if (already !== null) {
          reusedFacts.push(already.fact.id);
          continue;
        }
        const appended = factsStore.append(fact);
        appendedFacts.push(appended.id);
        events.append(event(at, runId, "fact.added", options.actor, {
          fact: appended.id,
          area: appended.area,
          kind: appended.kind,
          q: appended.source.q,
        }));
      }
      for (const conflict of result.conflicts) {
        events.append(event(at, runId, "question.asked", "distill", {
          fact: conflict.factId,
          area: conflict.claim.area,
          score: Math.round(conflict.score * 100) / 100,
        }));
      }
      if (appendedFacts.length > 0) {
        factsYaml = factsStore.toYaml();
        const factsCheck = validateFactsFile(parseYaml(factsYaml));
        if (!factsCheck.ok) {
          throw new NewRunError(`refusing to write an invalid facts.yml: ${factsCheck.issues[0]?.message ?? ""}`);
        }
      }
    }

    // --- revalidate what is on disk, then commit ---------------------------
    assertValid("run.yml", validateRunFile(parseYaml(readBack(temp, "run.yml"))));
    assertValid("budget.yml", validateRunBudget(parseYaml(readBack(temp, "budget.yml"))));

    mkdirSync(workDir, { recursive: true });
    renameSync(temp, runDir);
    if (factsYaml !== null) writeFileSync(factsPath(options.root), factsYaml, "utf8");
  } catch (error) {
    rmSync(temp, { recursive: true, force: true });
    throw error;
  }

  return {
    runId,
    runDir,
    preset,
    ceilingUsd: budgetPlan.ceiling,
    stageCount: preset.stages.length,
    distill: result,
    seed: seedSet,
    factsAppended: appendedFacts.length,
    factsReused: reusedFacts.length,
    files: written,
  };
}

// --- helpers ---------------------------------------------------------------

interface BudgetPlan {
  readonly ceiling: number;
  readonly perAgentMax: number;
  readonly perStage: ReadonlyMap<string, number>;
  readonly perPhase: ReadonlyMap<string, number>;
}

/**
 * Per-phase ceilings are proportional to the stages' declared `budget_usd`, scaled
 * so they fit the run ceiling. Every share is floored to the cent, so the sum can
 * only come in under the ceiling — never over it, which is what §2.11 validates.
 */
export function planBudget(preset: WorkflowPreset, requested: number | undefined): BudgetPlan {
  const ceiling = requested ?? preset.defaultBudgetUsd;
  if (!(ceiling > 0)) throw new NewRunError(`--budget must be > 0, got ${String(requested)}`);
  const declared = preset.stages.reduce((sum, s) => sum + s.budget_usd, 0);
  if (declared <= 0) throw new NewRunError(`workflow '${preset.name}' declares no stage budget`);
  const factor = ceiling / declared;

  const perStage = new Map<string, number>();
  const perPhase = new Map<string, number>();
  let total = 0;
  for (const stage of preset.stages) {
    const share = Math.max(MIN_STAGE_BUDGET, floor2(stage.budget_usd * factor));
    perStage.set(stage.id, share);
    perPhase.set(stage.phase, round2((perPhase.get(stage.phase) ?? 0) + share));
    total = round2(total + share);
  }
  if (total > ceiling + 1e-9) {
    throw new NewRunError(
      `the ${preset.stages.length} stages of '${preset.name}' need at least $${total.toFixed(2)}; raise --budget above $${ceiling.toFixed(2)}`,
    );
  }
  const perAgentMax = Math.max(...perStage.values());
  return { ceiling: round2(ceiling), perAgentMax, perStage, perPhase };
}

function buildPhases(preset: WorkflowPreset, perStage: ReadonlyMap<string, number>): RunPhase[] {
  const order: string[] = [];
  const byPhase = new Map<string, RunStage[]>();
  for (const stage of preset.stages) {
    if (!byPhase.has(stage.phase)) {
      byPhase.set(stage.phase, []);
      order.push(stage.phase);
    }
    byPhase.get(stage.phase)?.push(toRunStage(stage, perStage.get(stage.id) ?? stage.budget_usd));
  }
  return order.map((id) => ({ id, status: "pending", stages: byPhase.get(id) ?? [] }));
}

function toRunStage(stage: PlannedStage, budgetUsd: number): RunStage {
  return {
    id: stage.id,
    status: "pending",
    expert: stage.experts[0] ?? null,
    model: stage.model,
    budget_usd: budgetUsd,
    cost_usd: 0,
    started_at: null,
    ended_at: null,
    inputs: [...stage.inputs],
    outputs: [...stage.outputs],
    gate: {
      type: stage.gateType,
      status: stage.gateType === "auto" ? "n-a" : "pending",
      by: null,
      at: null,
      note: "",
    },
    tasks: [],
  };
}

/**
 * Add the seed documents to the first stage's declared inputs.
 *
 * Capped at §2.3's 20 inputs: the declared list is a contract the facilitator
 * validates, and a directory of 50 documents must not silently invalidate it. The
 * index is added first, so an over-long seed still tells the stage what exists.
 */
function declareSeedInputs(phases: readonly RunPhase[], seedInputs: readonly string[]): RunPhase[] {
  if (seedInputs.length === 0) return [...phases];
  return phases.map((phase, phaseIndex) => phaseIndex > 0 ? phase : {
    ...phase,
    stages: phase.stages.map((stage, stageIndex) => {
      if (stageIndex > 0) return stage;
      const inputs = [...stage.inputs];
      for (const entry of seedInputs) {
        if (inputs.includes(entry)) continue;
        if (inputs.length >= MAX_STAGE_INPUTS) break;
        inputs.push(entry);
      }
      return { ...stage, inputs };
    }),
  });
}

function resolveRepos(requested: readonly string[] | undefined, known: ReadonlyMap<string, string>): string[] {
  if (requested !== undefined && requested.length > 0) {
    const unknown = known.size === 0 ? [] : requested.filter((r) => !known.has(r));
    if (unknown.length > 0) {
      throw new NewRunError(`--repos: ${unknown.join(", ")} not in .tldrx/workspace.yml`);
    }
    return [...requested];
  }
  return [...known.keys()];
}

function event(
  ts: string,
  run: string,
  type: TldrxEvent["type"],
  actor: string,
  payload: Record<string, unknown>,
): TldrxEvent {
  return { ts, run, stage: null, type, actor, cost_usd: 0, payload };
}

function write(dir: string, rel: string, content: string, written: string[]): void {
  const path = join(dir, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf8");
  written.push(rel);
}

/** Read our own just-written file back off disk — validate what landed, not what we meant. */
function readBack(dir: string, rel: string): string {
  return readFileSync(join(dir, rel), "utf8");
}

function assertValid(what: string, validation: { ok: boolean; issues: readonly { path: string; message: string }[] }): void {
  if (validation.ok) return;
  const first = validation.issues[0];
  throw new NewRunError(`refusing to create a run with an invalid ${what}: ${first?.path ?? ""} ${first?.message ?? ""}`);
}

function describeHandoff(
  missing: readonly string[],
  empty: readonly { name: string; line: number }[],
  unsourced: readonly number[],
  unresolved: readonly { line: number; message: string }[],
): string {
  if (missing.length > 0) return `missing section(s) ${missing.join(", ")}`;
  if (empty.length > 0) {
    return `section(s) with no list items: ${empty.map((s) => `${s.name} (L${String(s.line)})`).join(", ")}`;
  }
  if (unsourced.length > 0) return `unsourced bullet(s) on line(s) ${unsourced.join(", ")}`;
  return unresolved[0]?.message ?? "unknown problem";
}

export function yymmdd(now: Date): string {
  return now.toISOString().slice(2, 10).replace(/-/g, "");
}

export function rfc3339(now: Date): string {
  return `${now.toISOString().slice(0, 19)}Z`;
}

export function titleFromSlug(slug: string): string {
  return slug
    .split("-")
    .filter((part) => part !== "")
    .map((part) => (part[0] ?? "").toUpperCase() + part.slice(1))
    .join(" ");
}

function floor2(n: number): number {
  return Math.floor(n * 100) / 100;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
