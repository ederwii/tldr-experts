/**
 * `tldrx expert train <name> --area <a> --mode light|full` — the run itself.
 *
 * The order is the whole design (see `Training.ts`): a deterministic pre-pass
 * chooses the files, ONE sub-agent reads only those and writes one knowledge
 * file, the framework re-reads that file off disk and derives the evidence, and
 * only then does a level move. Nothing between "prompt assembled" and "evidence
 * derived" is taken from the model's own account of how it went.
 *
 * Three execution modes, exactly as `tldrx next` has: headless spawns `claude -p`
 * itself; `--prepare` writes the prompt bundle and stops; `--commit` picks the
 * same validation path up from the host session's `result.json`. From "re-read
 * the knowledge file off disk" onwards they are literally the same code.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { PROJECT_FRAMEWORK_DIR } from "../paths.ts";
import { loadWorkspace, toSrcContext, factsPath } from "../../hooks/lib/workspace.ts";
import { FactsStore } from "../facts/FactsStore.ts";
import { loadExpert, expertDir, EXPERT_FILE } from "../experts/loadExperts.ts";
import { readExpertDocument } from "../experts/expertDocument.ts";
import { agentDir } from "../facilitator/paths.ts";
import { promptPath, readResult, writeBundle, writeRaw, PendingError, type PendingStage } from "../facilitator/pending.ts";
import { spawnAgent } from "../facilitator/spawnAgent.ts";
import type { CompetencyEvidence } from "../init/competencyLevel.ts";
import {
  CODE_TASK, DEFAULT_TRAIN_USD, MIN_TRAIN_USD, RUNS_TASK,
  fromRunsRelPath, knowledgeRelPath, type TrainingMode, type TrainingTask,
} from "./Training.ts";
import {
  LIGHT_SHAPE, RUNS_SHAPE, codeEvidence, describeKnowledgeIssues, parseKnowledgeFile, runEvidence,
} from "./knowledgeFile.ts";
import { selectFiles, keywordsFor } from "./selectFiles.ts";
import { mineRuns } from "./mineRuns.ts";
import { codePrompt, runsPrompt, type TrainingPromptInput } from "./trainingPrompt.ts";
import { CompetenciesError, writeCompetencies } from "./competenciesWrite.ts";
import { TrainingLog, type TrainingEvent } from "./trainingLog.ts";

export type TrainingRunMode = "headless" | "prepare" | "commit";

/** Spec §3 codes, as `tldrx next` uses them. */
const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_GATE_REFUSED = 2;
const EXIT_NOT_FOUND = 3;
const EXIT_AGENT_FAILED = 5;

/** `[assumption]` — no stage.yml governs a training run, so it borrows the
 * facilitator's default: 30 minutes for one sub-agent. */
export const TRAIN_TIMEOUT_MS = 30 * 60 * 1000;

export interface TrainOptions {
  readonly root: string;
  readonly expert: string;
  readonly area: string;
  readonly mode: TrainingMode;
  readonly run: TrainingRunMode;
  readonly maxUsd?: number;
  readonly model?: string | null;
  readonly yolo?: boolean;
  readonly actor: string;
  /** RFC3339 — `last_trained` and every log line. */
  readonly at: string;
  readonly now?: Date;
  readonly timeoutMs?: number;
}

export interface TrainOutcome {
  readonly code: number;
  readonly lines: readonly string[];
  readonly costUsd: number;
}

export async function runTraining(options: TrainOptions): Promise<TrainOutcome> {
  const now = options.now ?? new Date(options.at);
  const expert = loadExpert(options.root, options.expert, now);
  const dir = expertDir(options.root, options.expert);

  if (expert.error !== null) {
    return fail(EXIT_NOT_FOUND, [`${options.expert}: ${expert.error}`]);
  }
  const area = expert.areas.find((candidate) => candidate.id === options.area);
  if (area === undefined) {
    const known = expert.areas.map((candidate) => candidate.id).join(", ") || "none";
    return fail(EXIT_USAGE, [`${options.expert} has no area '${options.area}' (areas: ${known})`]);
  }

  // --- money, before anything is read --------------------------------------
  const ceiling = options.maxUsd ?? DEFAULT_TRAIN_USD;
  const agents = options.mode === "full" ? 2 : 1;
  if (ceiling < MIN_TRAIN_USD) {
    return fail(EXIT_GATE_REFUSED, [
      `refusing to train under the $${MIN_TRAIN_USD.toFixed(2)} floor — --max-usd was $${ceiling.toFixed(2)}.`,
      "  A cold `claude -p` pays 10-26k cache-creation tokens before its first reply (measured 2026-08-29),",
      "  so a ceiling below the floor is a failed spawn, not a saving. Raise --max-usd or do not train.",
    ]);
  }
  const share = round2(Math.max(MIN_TRAIN_USD, ceiling / agents));

  // --- the deterministic pre-pass ------------------------------------------
  const workspace = loadWorkspace(options.root);
  const repos = expertRepos(options.root, options.expert, workspace.repos);
  const document = readExpertDocument(options.root, options.expert);
  const promptInput: TrainingPromptInput = {
    root: options.root,
    expert,
    document,
    area,
    mode: options.mode,
    repos: repos.map((repo) => repo.name),
    budgetUsd: share,
  };

  const selection = await selectFiles({
    root: options.root,
    repos,
    areaId: area.id,
    areaTitle: area.title,
  });
  const prompts: { key: string; prompt: string; output: string }[] = [
    { key: CODE_TASK, prompt: codePrompt(promptInput, selection), output: knowledgeRelPath(area.id) },
  ];
  if (options.mode === "full") {
    const mine = mineRuns({
      root: options.root,
      repos: repos.map((repo) => repo.name),
      areaId: area.id,
      keywords: keywordsFor(area.id, area.title),
      facts: FactsStore.loadOrEmpty(factsPath(options.root)).facts,
    });
    prompts.push({ key: RUNS_TASK, prompt: runsPrompt(promptInput, mine), output: fromRunsRelPath(area.id) });
  }

  const bundleRoot = trainingCacheDir(options.root, options.expert, area.id);
  const log = TrainingLog.forExpert(dir);

  // --- --prepare: hand the work to the host session and stop ----------------
  if (options.run === "prepare") {
    const lines = [
      `prepared training for ${options.expert}/${area.id} (${options.mode}) — `
        + `${String(prompts.length)} sub-agent(s), $${share.toFixed(2)} ceiling each`,
    ];
    for (const task of prompts) {
      const pending: PendingStage = {
        version: 1,
        run: `expert:${options.expert}`,
        phase: "training",
        stage: area.id,
        expert: options.expert,
        model: options.model ?? null,
        budget_usd: ceiling,
        max_budget_usd: share,
        prompt: relative(bundleRoot, promptPath(bundleRoot, task.key)),
        outputs: [`${PROJECT_FRAMEWORK_DIR}/experts/${options.expert}/${task.output}`],
        sections: {},
        checks: [],
        prepared_at: options.at,
      };
      writeBundle(bundleRoot, task.key, task.prompt, pending);
      lines.push(
        `  ${task.key}: ${relative(options.root, agentDir(bundleRoot, task.key))}/prompt.md → writes `
        + `${PROJECT_FRAMEWORK_DIR}/experts/${options.expert}/${task.output}`,
      );
    }
    lines.push(
      "each sub-agent writes {outputs, questions_asked, notes} to its own result.json, then run",
      `  tldrx expert train ${options.expert} --area ${area.id} --mode ${options.mode} --commit`,
    );
    return { code: EXIT_OK, lines, costUsd: 0 };
  }

  // Keep whatever was on disk, so a rejected run leaves the workspace as it was.
  const previous = prompts.map((task) => ({
    path: join(dir, task.output),
    content: existsSync(join(dir, task.output)) ? readFileSync(join(dir, task.output), "utf8") : null,
  }));

  // --- the sub-agents ------------------------------------------------------
  const tasks: TrainingTask[] = [];
  for (const task of prompts) {
    if (options.run === "commit") {
      try {
        const result = readResult(bundleRoot, task.key);
        tasks.push({
          key: task.key,
          model: options.model ?? null,
          costUsd: round2(result.cost_usd ?? 0),
          sessionId: result.session_id,
          error: null,
          outputs: result.outputs,
        });
      } catch (error) {
        if (error instanceof PendingError) return fail(EXIT_USAGE, [`${task.key}: ${error.message}`]);
        throw error;
      }
      continue;
    }

    const outcome = await spawnAgent({
      prompt: task.prompt,
      model: options.model ?? null,
      maxBudgetUsd: share,
      workspaceCommands: [...workspace.commands],
      yolo: options.yolo ?? false,
      cwd: options.root,
      timeoutMs: options.timeoutMs ?? TRAIN_TIMEOUT_MS,
    });
    if (outcome.raw !== "") writeRaw(bundleRoot, task.key, outcome.raw);
    tasks.push({
      key: task.key,
      model: options.model ?? null,
      costUsd: round2(outcome.costUsd),
      sessionId: outcome.sessionId,
      error: outcome.error,
      outputs: outcome.envelope?.outputs ?? [],
    });
    // Money spent is recorded whether or not the run is accepted (spec §5).
    log.append(record(options, area.id, "agent.result", round2(outcome.costUsd), {
      task: task.key,
      mode: options.mode,
      model: options.model ?? null,
      session_id: outcome.sessionId,
      max_budget_usd: share,
      outputs: outcome.envelope?.outputs ?? [],
      usage: { input_tokens: outcome.usage.input_tokens, output_tokens: outcome.usage.output_tokens },
      ok: outcome.ok,
    }));
    if (!outcome.ok) {
      restore(previous);
      return fail(EXIT_AGENT_FAILED, [
        `${options.expert}/${area.id}: the ${task.key} sub-agent failed — ${outcome.error ?? "no result"}`,
        `  $${round2(outcome.costUsd).toFixed(2)} spent and recorded; nothing was written to competencies.yml`,
      ], sum(tasks));
    }
  }
  if (options.run === "commit") {
    for (const task of tasks) {
      log.append(record(options, area.id, "agent.result", task.costUsd, {
        task: task.key,
        mode: options.mode,
        model: task.model,
        session_id: task.sessionId,
        max_budget_usd: share,
        outputs: task.outputs,
        in_session: true,
      }));
    }
  }

  // --- validate off disk ---------------------------------------------------
  const srcCtx = toSrcContext(workspace, null);
  const evidence: CompetencyEvidence[] = [];
  const at = options.at.slice(0, 10);
  const counts: string[] = [];

  for (const task of prompts) {
    const abs = join(dir, task.output);
    const rel = `${PROJECT_FRAMEWORK_DIR}/experts/${options.expert}/${task.output}`;
    if (!existsSync(abs)) {
      restore(previous);
      return reject(log, options, area.id, sum(tasks), [
        `${options.expert}/${area.id}: ${rel} was never written`,
        "  nothing was written to competencies.yml and the status is unchanged",
      ]);
    }
    const text = readFileSync(abs, "utf8");
    const shape = task.key === CODE_TASK ? LIGHT_SHAPE : RUNS_SHAPE;
    const parsed = parseKnowledgeFile(text, srcCtx, shape);
    if (!parsed.ok) {
      const kept = quarantine(abs);
      restore(previous);
      return reject(log, options, area.id, sum(tasks), [
        `${options.expert}/${area.id}: ${rel} does not validate — ${String(parsed.issues.length)} problem(s)`,
        ...describeKnowledgeIssues(parsed.issues),
        `  the file was moved to ${relative(options.root, kept)}; nothing was written to competencies.yml`,
        "  and the status is unchanged. An unsourced claim cannot become evidence.",
      ]);
    }
    evidence.push(...(task.key === CODE_TASK ? codeEvidence(parsed.refs, at) : runEvidence(parsed.refs, at)));
    counts.push(`${task.output}: ${[...parsed.items].map(([name, n]) => `${name} ${String(n)}`).join(", ")}`);
  }

  // --- the level moves, on evidence ----------------------------------------
  let written;
  try {
    written = writeCompetencies({
      root: options.root,
      expert: options.expert,
      areaId: area.id,
      evidence,
      status: "in-use",
      lastTrained: options.at,
      now,
    });
  } catch (error) {
    if (error instanceof CompetenciesError) return fail(EXIT_USAGE, [error.message], sum(tasks));
    throw error;
  }
  setExpertStatus(join(dir, EXPERT_FILE), "in-use");

  const costUsd = sum(tasks);
  log.append(record(options, area.id, "check.passed", 0, {
    mode: options.mode,
    evidence_added: written.added.length,
    evidence_total: written.evidenceCount,
    level_before: written.levelBefore,
    level_after: written.levelAfter,
    cost_usd: costUsd,
    outputs: prompts.map((task) => task.output),
  }));

  return {
    code: EXIT_OK,
    costUsd,
    lines: [
      `trained ${options.expert}/${area.id} (${options.mode}) — $${costUsd.toFixed(2)} of $${ceiling.toFixed(2)}`,
      ...counts.map((line) => `  ${line}`),
      `  evidence: +${String(written.added.length)} row(s), ${String(written.evidenceCount)} total`
        + (written.dropped > 0 ? ` (${String(written.dropped)} oldest dropped at the 50-row cap)` : ""),
      `  level ${String(written.levelBefore)} → ${String(written.levelAfter)} (recomputed, spec §2.6)`,
      `  status in-use · last_trained ${options.at}`,
      `  ledger: ${relative(options.root, log.path)}`,
    ],
  };
}

// --- pieces -----------------------------------------------------------------

/**
 * The repos an expert speaks for: its `expert.md` front matter, which `init`
 * writes as `repos: [a, b]`. A hand-written expert without the key speaks for the
 * whole workspace — that is wider than ideal, but narrowing it by guessing would
 * silently exclude the repo the operator meant. `[assumption]`
 */
export function expertRepos(
  root: string,
  name: string,
  workspaceRepos: ReadonlyMap<string, string>,
): readonly { name: string; path: string }[] {
  const all = [...workspaceRepos.entries()].map(([repo, path]) => ({ name: repo, path }));
  const declared = readExpertDocument(root, name).frontMatter.get("repos");
  if (declared === undefined) return all;
  const wanted = declared.replace(/^\[|\]$/g, "").split(",").map((part) => part.trim()).filter((part) => part !== "");
  if (wanted.length === 0) return all;
  const matched = all.filter((repo) => wanted.includes(repo.name));
  return matched.length === 0 ? all : matched;
}

/** `.tldrx/cache/training/<expert>/<area>/` — gitignored, like every other cache. */
export function trainingCacheDir(root: string, expert: string, area: string): string {
  return join(root, PROJECT_FRAMEWORK_DIR, "cache", "training", expert, area);
}

/**
 * A rejected knowledge file is moved aside rather than deleted or left in place.
 * Left in place it reads as accepted knowledge to the next person who opens the
 * folder; deleted, the one record of what went wrong is gone. `[assumption]`
 */
function quarantine(abs: string): string {
  const kept = abs.replace(/\.md$/, ".rejected.md");
  try {
    rmSync(kept, { force: true });
    renameSync(abs, kept);
  } catch {
    return abs;
  }
  return kept;
}

/** Put back whatever was on disk before the sub-agent ran. */
function restore(previous: readonly { path: string; content: string | null }[]): void {
  for (const entry of previous) {
    if (entry.content === null) continue;
    mkdirSync(join(entry.path, ".."), { recursive: true });
    writeFileSync(entry.path, entry.content, "utf8");
  }
}

/** Rewrite `expert.md`'s `status:` line, keeping every other byte. */
export function setExpertStatus(path: string, status: string): void {
  if (!existsSync(path)) return;
  const lines = readFileSync(path, "utf8").split("\n");
  if ((lines[0] ?? "").trimEnd() !== "---") return;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trimEnd() === "---") break;
    if (!/^status:\s/.test(line)) continue;
    const comment = line.indexOf("#", line.indexOf(":") + 1);
    lines[i] = comment === -1 ? `status: ${status}` : `status: ${status} ${line.slice(comment)}`;
    writeFileSync(path, lines.join("\n"), "utf8");
    return;
  }
}

function record(
  options: TrainOptions,
  area: string,
  type: TrainingEvent["type"],
  costUsd: number,
  payload: Record<string, unknown>,
): TrainingEvent {
  return { ts: options.at, expert: options.expert, area, type, actor: options.actor, cost_usd: costUsd, payload };
}

function reject(
  log: TrainingLog,
  options: TrainOptions,
  area: string,
  costUsd: number,
  lines: readonly string[],
): TrainOutcome {
  log.append(record(options, area, "check.failed", 0, {
    mode: options.mode,
    reason: lines[0] ?? "the knowledge file did not validate",
    cost_usd: costUsd,
  }));
  return { code: EXIT_AGENT_FAILED, lines, costUsd };
}

function fail(code: number, lines: readonly string[], costUsd = 0): TrainOutcome {
  return { code, lines, costUsd };
}

function sum(tasks: readonly TrainingTask[]): number {
  return round2(tasks.reduce((total, task) => total + task.costUsd, 0));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
