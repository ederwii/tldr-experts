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
 *
 * **One repair round sits between validation and rejection** (`repairRound`,
 * 2026-08-30). A headless run whose knowledge file does not validate hands the
 * validator's exact problems back to the trainer for one more turn, paid out of
 * the same `--max-usd`, before anything is quarantined. The gate itself does not
 * move: the second file is judged by the same `parseKnowledgeFile`, and a second
 * failure rejects exactly as the first one used to.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { PROJECT_FRAMEWORK_DIR } from "../paths.ts";
import { loadWorkspace, toSrcContext, factsPath } from "../../hooks/lib/workspace.ts";
import { FactsStore } from "../facts/FactsStore.ts";
import { loadExpert, expertDir, EXPERT_FILE } from "../experts/loadExperts.ts";
import { missingAreaRefusal } from "../experts/missingArea.ts";
import { readExpertDocument } from "../experts/expertDocument.ts";
import { agentDir } from "../facilitator/paths.ts";
import {
  promptPath, preflightRecord, readResult, writeBundle, writeRaw, PendingError,
  type PendingStage,
} from "../facilitator/pending.ts";
import { spawnAgent } from "../facilitator/spawnAgent.ts";
import { setProgressCeiling, setProgressTitle } from "../ui/bus.ts";
import type { EffortLevel } from "../schemas/stage.ts";
import type { SrcContext } from "../text/srcToken.ts";
import type { CompetencyEvidence } from "../init/competencyLevel.ts";
import {
  CODE_TASK, DEFAULT_TRAIN_EFFORT, MIN_TRAIN_USD, RUNS_TASK, defaultTrainUsd,
  fromRunsRelPath, knowledgeRelPath, partialOf,
  type TrainingMode, type TrainingRunMode, type TrainingTask,
} from "./Training.ts";
import { trainPreflight, type AmbientModel } from "./trainPreflight.ts";
import { ambientModelFiles, resolveAmbientModel } from "./ambientModel.ts";
import {
  LIGHT_SHAPE, RUNS_SHAPE, codeEvidence, describeKnowledgeIssue, describeKnowledgeIssues,
  knowledgeErrors, knowledgeWarnings, parseKnowledgeFile, runEvidence,
  type KnowledgeFile, type KnowledgeIssue, type KnowledgeScope, type KnowledgeShape,
} from "./knowledgeFile.ts";
import { knowledgeScopeFor } from "./knowledgeScope.ts";
import { selectFiles, keywordsFor } from "./selectFiles.ts";
import { mineRuns } from "./mineRuns.ts";
import { codePrompt, outputPath, repairPrompt, runsPrompt, type TrainingPromptInput } from "./trainingPrompt.ts";
import { describeStrayRecovery, findStrayWrite, recoverStrayWrite } from "./strayWrite.ts";
import { CompetenciesError, writeCompetencies } from "./competenciesWrite.ts";
import { isRoleExpertOnDisk, lightModeRefusal, nothingToMineRefusal } from "./roleTraining.ts";
import { MAX_PAYLOAD_BYTES, TrainingLog, type TrainingEvent } from "./trainingLog.ts";

export type { TrainingRunMode } from "./Training.ts";

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
  /**
   * What the sub-agent inherits when `--model` is absent. `undefined` ⇒ resolve
   * it from this box (`ambientModel.ts`); `null` ⇒ there is none and the
   * pre-start line says so. Tests pass it explicitly so no run's behaviour
   * depends on the developer's own `~/.claude/settings.json`.
   */
  readonly ambientModel?: AmbientModel | null;
  /** `--effort`. Undefined ⇒ `DEFAULT_TRAIN_EFFORT`. */
  readonly effort?: EffortLevel | null;
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
  /**
   * Lines the CLI must put on stderr whatever the exit code — today, evidence
   * rows already in `competencies.yml` that this write could not count. They are
   * not part of `lines` because `lines` is the result, and these are a complaint
   * about the input.
   */
  readonly warnings?: readonly string[];
  /**
   * The lines said BEFORE the money, already written to stderr by the time this
   * returns (`trainPreflight.ts`). Returned as well as printed so a test can
   * assert on the sentence an operator was shown, not only on the exit code.
   */
  readonly preflight?: readonly string[];
}

/**
 * The pre-start lines are collected into `said` and stapled onto whatever
 * outcome the run reaches, whichever of its two dozen exits it takes. A thin
 * wrapper rather than a `preflight:` on every `return`: there is exactly one
 * place that decides them, and one place that attaches them.
 */
export async function runTraining(options: TrainOptions): Promise<TrainOutcome> {
  const said: string[] = [];
  const outcome = await trainWithPreflight(options, said);
  return said.length === 0 ? outcome : { ...outcome, preflight: said };
}

async function trainWithPreflight(options: TrainOptions, said: string[]): Promise<TrainOutcome> {
  const now = options.now ?? new Date(options.at);
  const expert = loadExpert(options.root, options.expert, now);
  const dir = expertDir(options.root, options.expert);

  if (expert.error !== null) {
    return fail(EXIT_NOT_FOUND, [`${options.expert}: ${expert.error}`]);
  }
  const area = expert.areas.find((candidate) => candidate.id === options.area);
  if (area === undefined) {
    // gh #94: the refusal names the file to edit and the block to paste, rather
    // than stating the constraint and leaving the remedy to be found in source.
    return fail(EXIT_USAGE, missingAreaRefusal({
      root: options.root,
      expert: options.expert,
      areaId: options.area,
      known: expert.areas.map((candidate) => candidate.id),
      mode: options.mode,
    }));
  }

  // --- what kind of expert this is, before any money is committed ----------
  // A role expert's domain is the workflow, not a folder, so light mode's grep
  // has nothing to grep. `roleTraining.ts` says why this is a refusal rather
  // than a run that produces an empty knowledge file at full price.
  const isRole = isRoleExpertOnDisk(options.root, options.expert);
  const refusal = lightModeRefusal(options.expert, area.id, options.mode, isRole);
  if (refusal !== null) return fail(EXIT_USAGE, refusal);

  // --- money, before anything is read --------------------------------------
  const ceiling = options.maxUsd ?? defaultTrainUsd(options.mode);
  // A role expert in full mode runs the runs pass alone — one sub-agent, so the
  // whole ceiling is its share rather than half of it.
  const agents = options.mode === "full" && !isRole ? 2 : 1;
  if (ceiling < MIN_TRAIN_USD) {
    return fail(EXIT_GATE_REFUSED, [
      `refusing to train under the $${MIN_TRAIN_USD.toFixed(2)} floor — --max-usd was $${ceiling.toFixed(2)}.`,
      "  A cold `claude -p` pays 10-26k cache-creation tokens before its first reply (measured 2026-08-29),",
      "  so a ceiling below the floor is a failed spawn, not a saving. Raise --max-usd or do not train.",
    ]);
  }
  const share = round2(Math.max(MIN_TRAIN_USD, ceiling / agents));
  const effort: EffortLevel = options.effort ?? DEFAULT_TRAIN_EFFORT;

  // Which model this will actually use, what that tier costs, and whether the
  // ceiling in force was ever measured for it — said before the spawn, and a
  // refusal when the combination provably cannot fit (#96). Only the headless
  // path spawns: `--prepare` hands the ceiling to the operator's own session and
  // `--commit` is reading a result that has already been paid for.
  const preflight = trainPreflight({
    mode: options.mode,
    agents,
    ceilingUsd: ceiling,
    ceilingExplicit: options.maxUsd !== undefined,
    model: options.model ?? null,
    ambient: options.ambientModel === undefined
      ? resolveAmbientModel({
        env: process.env,
        home: homedir(),
        files: ambientModelFiles(options.root, homedir()),
      })
      : options.ambientModel,
    run: options.run,
  });
  if (preflight.refusal !== null) return fail(EXIT_GATE_REFUSED, preflight.refusal);
  // Written here rather than returned only at the end: a line an operator reads
  // after the money has been spent is a receipt, not a warning.
  for (const line of preflight.notice) said.push(line);
  // A headless run is about to spend, so the line goes to stderr the moment it is
  // known — before the pre-pass, never as a receipt afterwards. `--prepare` spends
  // nothing here: its audience is the operator reading the prepared block on
  // stdout and the host session reading `pending.json`, and it is written into
  // both below (#98) rather than into a stream nobody is reading yet.
  if (options.run === "headless") {
    for (const line of preflight.notice) process.stderr.write(`${line}\n`);
  }

  // --- the deterministic pre-pass ------------------------------------------
  const workspace = loadWorkspace(options.root);
  const repos = expertRepos(options.root, options.expert, workspace.repos);
  const document = readExpertDocument(options.root, options.expert);
  const scope = knowledgeScopeFor(options.root, expert, area.id);
  const promptInput: TrainingPromptInput = {
    root: options.root,
    expert,
    document,
    area,
    mode: options.mode,
    repos: repos.map((repo) => repo.name),
    // The same list `spawnAgent` turns into `Bash(<command>)` grants below, so the
    // prompt describes the permission the process actually hands over.
    commands: [...workspace.commands],
    budgetUsd: share,
  };

  // `output` is where the sub-agent writes (`<area>.md.partial`); `final` is the
  // name it earns by validating. Nothing half-written ever wears the final name,
  // because `knowledge/*.md` is what gets inlined into later prompts.
  const prompts: { key: string; prompt: string; output: string; final: string }[] = [];
  // The code pass is skipped for a role expert — not budgeted, not walked, not
  // spawned. `selectFiles` walks every repo, so skipping it is also why a role
  // training run starts instantly.
  if (!isRole) {
    const selection = await selectFiles({
      root: options.root,
      repos,
      areaId: area.id,
      areaTitle: area.title,
      // Light mode inlines the expert's OWN folders and nothing else. Without
      // this the grep ranks the whole workspace and the sub-agent writes
      // knowledge it is then warned for, at full price.
      domainPaths: scope.domainPaths,
    });
    prompts.push({
      key: CODE_TASK,
      prompt: codePrompt(promptInput, selection),
      output: partialOf(knowledgeRelPath(area.id)),
      final: knowledgeRelPath(area.id),
    });
  }
  if (options.mode === "full") {
    const mine = mineRuns({
      root: options.root,
      repos: repos.map((repo) => repo.name),
      areaId: area.id,
      keywords: keywordsFor(area.id, area.title),
      facts: FactsStore.loadOrEmpty(factsPath(options.root)).facts,
    });
    const empty = nothingToMineRefusal(options.expert, area.id, mine.files.length, isRole);
    if (empty !== null) return fail(EXIT_USAGE, empty);
    prompts.push({
      key: RUNS_TASK,
      prompt: runsPrompt(promptInput, mine),
      output: partialOf(fromRunsRelPath(area.id)),
      final: fromRunsRelPath(area.id),
    });
  }

  const bundleRoot = trainingCacheDir(options.root, options.expert, area.id);
  const log = TrainingLog.forExpert(dir);

  // --- --prepare: hand the work to the host session and stop ----------------
  if (options.run === "prepare") {
    const lines = [
      ...preflight.notice,
      `prepared training for ${options.expert}/${area.id} (${options.mode}) — `
        + `${String(prompts.length)} sub-agent(s), $${share.toFixed(2)} ceiling each, effort ${effort}`,
    ];
    for (const task of prompts) {
      const pending: PendingStage = {
        version: 1,
        run: `expert:${options.expert}`,
        phase: "training",
        stage: area.id,
        expert: options.expert,
        model: options.model ?? null,
        effort,
        budget_usd: ceiling,
        max_budget_usd: share,
        prompt: relative(bundleRoot, promptPath(bundleRoot, task.key)),
        outputs: [`${PROJECT_FRAMEWORK_DIR}/experts/${options.expert}/${task.output}`],
        sections: {},
        checks: [],
        prepared_at: options.at,
        // The whole notice when there is an alarm — a bare warning without the
        // model line beside it is an assertion the reader cannot check. Nothing
        // at all when there is not, so an unremarkable bundle is byte-identical
        // to the one this command has always written.
        ...preflightRecord(preflight.warnings.length === 0 ? [] : preflight.notice),
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
  // A partial left by a run that crashed is scratch, not evidence: clear it
  // before spawning. Otherwise a sub-agent that wrote nothing this time would be
  // validated against last time's half-file and quietly pass.
  // NOT on `--commit`: there the partial is what the host session's sub-agent
  // just wrote, and it is the whole input to this half of the run.
  if (options.run !== "commit") {
    for (const task of prompts) rmSync(join(dir, task.output), { force: true });
  }

  // Snapshot the FINAL names — those are the accepted files a rejected run has to
  // put back. The partials are scratch and are cleared on the way out either way.
  const previous = prompts.map((task) => ({
    path: join(dir, task.final),
    partial: join(dir, task.output),
    content: existsSync(join(dir, task.final)) ? readFileSync(join(dir, task.final), "utf8") : null,
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

    setProgressTitle(`train ${options.expert}/${area.id} · ${options.mode} · ${task.key}`);
    setProgressCeiling(share);
    const outcome = await spawnAgent({
      prompt: task.prompt,
      model: options.model ?? null,
      effort,
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
      effort,
      session_id: outcome.sessionId,
      max_budget_usd: share,
      outputs: outcome.envelope?.outputs ?? [],
      usage: {
        input_tokens: outcome.usage.input_tokens,
        output_tokens: outcome.usage.output_tokens,
        cache_creation_input_tokens: outcome.usage.cache_creation_input_tokens,
        cache_read_input_tokens: outcome.usage.cache_read_input_tokens,
      },
      ok: outcome.ok,
    }));
    if (!outcome.ok) {
      rollback(previous);
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
        effort,
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
  const softWarnings: string[] = [];

  // Whatever the repair round did or refused to do, said out loud in the result:
  // an extra sub-agent that spends money silently is exactly the thing the
  // operator has no way to audit.
  const repairs: string[] = [];
  // Same rule for the stray-write probe: a file that had to be rescued out of
  // another git repo is not a detail to keep to ourselves — the operator has a
  // foreign `git status` to clean up either way.
  const recovered: string[] = [];

  for (const task of prompts) {
    const abs = join(dir, task.output);
    const rel = `${PROJECT_FRAMEWORK_DIR}/experts/${options.expert}/${task.output}`;

    // The file is missing from where it was asked for. Before calling that "never
    // written" — the verdict that cost a real run $1.23 on 2026-08-31 for a file
    // that was sitting complete inside another repo — look where a RELATIVE write
    // by a sub-agent that `cd`'d would have put it. Recovery happens here, above
    // the repair round, so a recovered file that turns out to be invalid can still
    // be repaired like any other.
    let stray = null;
    if (!existsSync(abs)) {
      stray = findStrayWrite({ root: options.root, repos, expert: options.expert, output: task.output });
      if (stray !== null) recovered.push(...describeStrayRecovery(options.root, recoverStrayWrite(stray, abs), rel));
    }
    if (!existsSync(abs)) {
      rollback(previous);
      return reject(log, options, area.id, sum(tasks), [
        `${options.expert}/${area.id}: ${rel} was never written`,
        ...recovered,
        ...(stray !== null ? [] : [
          `  no copy of it was found under any declared repo root either (${repos.map((repo) => repo.name).join(", ") || "none"}) —`,
          "  a sub-agent that `cd`s and writes a relative path lands one there, and this run did not",
        ]),
        "  nothing was written to competencies.yml and the status is unchanged",
      ]);
    }
    const text = readFileSync(abs, "utf8");
    const shape = task.key === CODE_TASK ? LIGHT_SHAPE : RUNS_SHAPE;
    let parsed = parseKnowledgeFile(text, srcCtx, shape, scope);

    // ONE repair round, before anything is thrown away. The trust layer is
    // untouched by it — the repaired file goes through the SAME validator and an
    // unsourced claim still cannot become evidence — but a run that spent real
    // money and produced a file wrong in two places should be told what the two
    // places are before its whole output is binned.
    // Never on `--commit`: there the sub-agent belongs to the HOST session and
    // this process spawned nothing, so spawning a repair here would be the one
    // `claude -p` the operator did not ask for. The in-session path repairs by
    // running `--commit` again after fixing the file, which is what it already is.
    if (!parsed.ok && options.run === "headless") {
      const round = await repairRound({
        options, areaId: area.id, dir, log, effort, srcCtx, scope, shape,
        commands: [...workspace.commands],
        task,
        rejected: parsed,
        rejectedText: text,
        spentUsd: sum(tasks),
        budgetUsd: round2(Math.min(share, ceiling - sum(tasks))),
      });
      repairs.push(...round.lines);
      if (round.spend !== null) tasks.push(round.spend);
      if (round.parsed !== null) parsed = round.parsed;
    }

    if (!parsed.ok) {
      // Every problem, in full, in two durable places — because the terminal is
      // neither. Measured 2026-08-31: a $1.02 run failed on 12 problems, five of
      // which reached stdout and none of which reached `training.jsonl`, so the
      // ledger said "12 problem(s)" and the only record of WHICH twelve was in a
      // scrollback nobody had captured.
      const problems = orderedProblems(parsed.issues);
      const kept = quarantine(abs, rejectionHeader({
        options, areaId: area.id, problems,
        errors: knowledgeErrors(parsed).length,
        costUsd: sum(tasks),
      }));
      rollback(previous);
      return reject(log, options, area.id, sum(tasks), [
        `${options.expert}/${area.id}: ${rel} does not validate — `
          + `${String(knowledgeErrors(parsed).length)} problem(s)`,
        ...describeKnowledgeIssues(parsed.issues),
        ...recovered,
        ...repairs,
        `  the file was moved to ${relative(options.root, kept)}, which now carries all `
          + `${String(problems.length)} problem(s) in its header; nothing was written to competencies.yml`,
        "  and the status is unchanged. An unsourced claim cannot become evidence.",
      ], { task: task.key, problems, errors: knowledgeErrors(parsed).length });
    }
    evidence.push(...(task.key === CODE_TASK ? codeEvidence(parsed.bullets, at) : runEvidence(parsed.bullets, at)));
    // Warnings never reject the file, and they must never be swallowed either: a
    // bullet flagged `paraphrase`, `outside domain` or `duplicate src` is a bullet
    // the level did NOT move for, and a training run that reported a level without
    // saying that is the silent-drop failure §2.6 already fixed once.
    softWarnings.push(...knowledgeWarnings(parsed));
    counts.push(`${task.final}: ${[...parsed.items].map(([name, n]) => `${name} ${String(n)}`).join(", ")}`);
  }

  // Every file validated. ONLY NOW does a partial earn the name that later
  // prompts inline — the rename is the moment "the model wrote something" becomes
  // "this expert knows something".
  for (const task of prompts) {
    renameSync(join(dir, task.output), join(dir, task.final));
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
    outputs: prompts.map((task) => task.final),
  }));

  return {
    code: EXIT_OK,
    costUsd,
    warnings: [...softWarnings, ...written.warnings],
    lines: [
      `trained ${options.expert}/${area.id} (${options.mode}) — $${costUsd.toFixed(2)} of $${ceiling.toFixed(2)}`,
      ...recovered,
      ...repairs,
      ...counts.map((line) => `  ${line}`),
      `  evidence: +${String(written.added.length)} row(s), ${String(written.evidenceCount)} total`
        + (written.dropped > 0 ? ` (${String(written.dropped)} oldest dropped at the 50-row cap)` : ""),
      `  level ${String(written.levelBefore)} → ${String(written.levelAfter)} (recomputed, spec §2.6)`,
      `  status in-use · last_trained ${options.at}`,
      `  ledger: ${relative(options.root, log.path)}`,
    ],
  };
}

// --- the repair round --------------------------------------------------------

interface RepairRoundInput {
  readonly options: TrainOptions;
  readonly areaId: string;
  readonly dir: string;
  readonly log: TrainingLog;
  readonly effort: EffortLevel;
  readonly srcCtx: SrcContext;
  readonly scope: KnowledgeScope;
  readonly shape: KnowledgeShape;
  readonly commands: readonly string[];
  readonly task: { readonly key: string; readonly prompt: string; readonly output: string };
  /** The verdict that started this: the parse that failed. */
  readonly rejected: KnowledgeFile;
  /** The rejected file's bytes, so the trainer is shown what it actually wrote. */
  readonly rejectedText: string;
  /** Spent by this run so far, for the ledger line. */
  readonly spentUsd: number;
  /** What this one turn may spend — already clamped to the run's remaining ceiling. */
  readonly budgetUsd: number;
}

interface RepairRoundOutcome {
  /** For the CLI, whichever way it went — including "no repair round, and why". */
  readonly lines: readonly string[];
  /** The repair sub-agent's cost record, or null when nothing was spawned. */
  readonly spend: TrainingTask | null;
  /** The RE-validated file, or null when there is nothing new to judge. */
  readonly parsed: KnowledgeFile | null;
}

/**
 * One more turn at a rejected knowledge file, with the validator's exact problems
 * handed back to the trainer.
 *
 * Why this exists, measured 2026-08-30: a real `expert train dotnet-stack --area
 * dotnet --mode light` spent $1.69, wrote a knowledge file, and had it refused on
 * two bullets that asserted an execution and cited a file line. Nothing reached
 * `competencies.yml`, the status did not move, and the operator paid $1.69 for
 * zero evidence — over a mistake the checker could describe in one line and the
 * writer could have fixed in one edit. Throwing the whole file away without ever
 * telling its author what was wrong with it is not rigour; it is just expensive.
 *
 * **What this does NOT do is soften the gate.** The repaired file goes through
 * `parseKnowledgeFile` again, with the same shape and the same scope, and it is
 * accepted only if it passes on its own terms. A second failure rejects exactly
 * as the first one used to. An unsourced claim still cannot become evidence — it
 * has simply been told, once, that it is unsourced.
 *
 * **One round, and never more.** Two rounds is a loop, a loop with a model in it
 * is a budget with no bottom, and the second failure carries information the
 * first does not: the trainer was shown the rule and still could not satisfy it,
 * which is a fact about the file rather than about the prompt.
 *
 * **The turn is paid for out of `--max-usd`, and refuses when there is nothing
 * left.** The ceiling is `min(this sub-agent's share, whatever is left of the
 * whole run's ceiling)`, so a repair can never push a run past the number the
 * operator typed. Under `MIN_TRAIN_USD` it does not spawn at all and says so:
 * a cold `claude -p` that dies on `error_max_budget_usd` before its first reply
 * costs money and produces nothing, which is the failure this whole file exists
 * to stop repeating.
 */
async function repairRound(input: RepairRoundInput): Promise<RepairRoundOutcome> {
  const { options, task } = input;
  const errors = knowledgeErrors(input.rejected);
  const abs = join(input.dir, task.output);
  // Absolute, for the same reason the first prompt's target is (`strayWrite.ts`):
  // a repair turn that `cd`s to re-run a gate must not be able to rewrite the file
  // into whichever repo it landed in.
  const target = outputPath(options.root, options.expert, task.output);

  input.log.append(record(options, input.areaId, "check.failed", 0, {
    mode: options.mode,
    task: task.key,
    reason: `${String(errors.length)} problem(s) — sending them back to the trainer`,
    cost_usd: input.spentUsd,
    repair: "attempted",
    errors: errors.length,
    problems_total: input.rejected.issues.length,
    // The list the trainer is about to be shown, on the ledger as well as in the
    // prompt. Without it the only durable record of a first-round failure that was
    // then repaired is a count, and "what did the repair actually fix" is exactly
    // the question a later reader has.
    ...fitProblems(orderedProblems(input.rejected.issues)),
  }));

  if (input.budgetUsd < MIN_TRAIN_USD) {
    return {
      lines: [
        `  no repair round: $${input.budgetUsd.toFixed(2)} left of the ceiling, under the `
          + `$${MIN_TRAIN_USD.toFixed(2)} floor — raise --max-usd and the ${String(errors.length)} `
          + "problem(s) above would have been sent back to the trainer",
      ],
      spend: null,
      parsed: null,
    };
  }

  setProgressTitle(`train ${options.expert}/${input.areaId} · ${options.mode} · ${task.key} repair`);
  setProgressCeiling(input.budgetUsd);
  const outcome = await spawnAgent({
    prompt: repairPrompt(task.prompt, {
      target,
      rejected: input.rejectedText,
      issues: input.rejected.issues,
      budgetUsd: input.budgetUsd,
    }),
    model: options.model ?? null,
    effort: input.effort,
    maxBudgetUsd: input.budgetUsd,
    workspaceCommands: [...input.commands],
    yolo: options.yolo ?? false,
    cwd: options.root,
    timeoutMs: options.timeoutMs ?? TRAIN_TIMEOUT_MS,
  });

  const spend: TrainingTask = {
    key: `${task.key}:repair`,
    model: options.model ?? null,
    costUsd: round2(outcome.costUsd),
    sessionId: outcome.sessionId,
    error: outcome.error,
    outputs: outcome.envelope?.outputs ?? [],
  };
  input.log.append(record(options, input.areaId, "agent.result", spend.costUsd, {
    task: spend.key,
    repair: true,
    mode: options.mode,
    model: spend.model,
    effort: input.effort,
    session_id: outcome.sessionId,
    max_budget_usd: input.budgetUsd,
    outputs: spend.outputs,
    problems_sent: errors.length,
    ok: outcome.ok,
  }));

  const opened = `  repairing: ${String(errors.length)} problem(s) sent back to the trainer — `
    + `one round, $${input.budgetUsd.toFixed(2)} of the ceiling left`;

  if (!outcome.ok) {
    return {
      lines: [opened, `  the repair sub-agent failed — ${outcome.error ?? "no result"}`],
      spend,
      parsed: null,
    };
  }
  // A repair that deleted the file leaves no record of what the run produced, and
  // the rejected bytes are that record. Put them back and judge them again: the
  // verdict is unchanged and the quarantined file still says what went wrong.
  if (!existsSync(abs)) {
    writeFileSync(abs, input.rejectedText, "utf8");
    return {
      lines: [opened, "  the repair sub-agent removed the file instead of rewriting it"],
      spend,
      parsed: null,
    };
  }

  const parsed = parseKnowledgeFile(readFileSync(abs, "utf8"), input.srcCtx, input.shape, input.scope);
  const left = knowledgeErrors(parsed).length;
  return {
    lines: [
      opened,
      parsed.ok
        ? `  repaired: the second file validates, and $${spend.costUsd.toFixed(2)} bought the evidence below`
        : `  the repaired file does not validate either (${String(left)} problem(s)) — one round is all there is`,
    ],
    spend,
    parsed,
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
 *
 * **With a header, when the verdict is known.** The file kept the bytes and threw
 * away the reason — a maintainer opening `<area>.rejected.md` a day later could
 * see a knowledge file that looks fine and no statement of what was wrong with
 * it, because the problem list only ever existed on stdout. The header is
 * prepended rather than written beside it so that the two cannot be separated by
 * a copy, and it is plain Markdown so `cat` and a renderer say the same thing.
 * `rollback` quarantines without one: there the run died before any verdict
 * existed, and inventing a header for it would be inventing the reason.
 */
function quarantine(abs: string, header: readonly string[] = []): string {
  const kept = abs.replace(/\.md(\.partial)?$/, ".rejected.md");
  try {
    const body = header.length === 0 ? null : `${header.join("\n")}\n${readFileSync(abs, "utf8")}`;
    rmSync(kept, { force: true });
    renameSync(abs, kept);
    if (body !== null) writeFileSync(kept, body, "utf8");
  } catch {
    return abs;
  }
  return kept;
}

interface RejectionHeaderInput {
  readonly options: TrainOptions;
  readonly areaId: string;
  /** Every issue, errors and warnings alike, already rendered one per line. */
  readonly problems: readonly string[];
  /** How many of them are fatal — the count the headline reports. */
  readonly errors: number;
  readonly costUsd: number;
}

/**
 * The block prepended to `<area>.rejected.md`: what was refused, when, why, and
 * what it cost. Every problem, uncapped — this file has no size budget and the
 * whole point of it is to be the copy the terminal is not.
 *
 * The problems are indented four spaces rather than fenced, because the rejected
 * file below may itself open a fence and a header that could collide with it
 * would be a header that sometimes swallows the evidence.
 */
function rejectionHeader(input: RejectionHeaderInput): readonly string[] {
  const { options } = input;
  const warnings = input.problems.length - input.errors;
  return [
    "# REJECTED — `tldrx expert train`",
    "",
    `\`${options.expert}/${input.areaId}\` · ${options.mode} mode · ${options.at} · `
      + `$${input.costUsd.toFixed(2)} spent · ${String(input.errors)} error(s)`
      + (warnings > 0 ? `, ${String(warnings)} warning(s)` : ""),
    "",
    "This file did not validate, so nothing was written to `competencies.yml` and the level did not",
    "move. The bytes below the rule are exactly what the trainer wrote. Only the error lines are why",
    "it was refused; a `warning:` line costs that one bullet its evidence row and nothing more.",
    "",
    ...input.problems.map((problem) => `    ${problem.trimStart()}`),
    "",
    "---",
    "",
  ];
}

/**
 * Put the workspace back the way the sub-agent found it.
 *
 * A file that existed is restored byte-for-byte. A file that did NOT exist and
 * now does is quarantined, not left — measured 2026-08-29 on the pilot: a
 * sub-agent killed by its own budget ceiling had already written a complete,
 * VALID knowledge file, and the old code left it at `knowledge/<area>.md` where
 * the next reader would take it for accepted knowledge. The run failed, so the
 * only honest state is "there is no accepted knowledge file, and here is what the
 * failed run produced".
 */
function rollback(previous: readonly { path: string; partial: string; content: string | null }[]): void {
  for (const entry of previous) {
    // A partial the failed run left behind is quarantined too. It could not have
    // been inlined — `.md.partial` does not match `knowledge/*.md` — but the one
    // record of what the run produced is worth keeping, under a name that says
    // it was rejected.
    if (existsSync(entry.partial)) quarantine(entry.partial);
    if (entry.content !== null) {
      mkdirSync(join(entry.path, ".."), { recursive: true });
      writeFileSync(entry.path, entry.content, "utf8");
      continue;
    }
    if (existsSync(entry.path)) quarantine(entry.path);
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

/**
 * Every issue as one line, errors first.
 *
 * The order is the same one `describeKnowledgeIssues` prints in and it is chosen
 * for the same reason: the reader's question is always "which of these is why
 * nothing was kept?", and it is answered by the lines above the warnings. It
 * matters more here than on a terminal, because this list is what gets TRUNCATED
 * to fit a ledger payload.
 */
function orderedProblems(issues: readonly KnowledgeIssue[]): readonly string[] {
  return [
    ...issues.filter((issue) => issue.severity === "error"),
    ...issues.filter((issue) => issue.severity !== "error"),
  ].map((issue) => describeKnowledgeIssue(issue));
}

/** The validator's verdict, for the ledger. Absent when the file never existed. */
interface RejectDetail {
  readonly task: string;
  /** Every issue, one rendered line each — errors first, as the validator ordered them. */
  readonly problems: readonly string[];
  readonly errors: number;
}

function reject(
  log: TrainingLog,
  options: TrainOptions,
  area: string,
  costUsd: number,
  lines: readonly string[],
  detail?: RejectDetail,
): TrainOutcome {
  log.append(record(options, area, "check.failed", 0, {
    mode: options.mode,
    reason: lines[0] ?? "the knowledge file did not validate",
    cost_usd: costUsd,
    ...(detail === undefined ? {} : {
      task: detail.task,
      errors: detail.errors,
      problems_total: detail.problems.length,
      ...fitProblems(detail.problems),
    }),
  }));
  return { code: EXIT_AGENT_FAILED, lines, costUsd };
}

/**
 * As many problem lines as `MAX_PAYLOAD_BYTES` will hold, plus the count of the
 * ones that did not fit.
 *
 * `TrainingLog.append` THROWS on an oversize payload rather than truncating it,
 * which is the right call for a ledger and the wrong outcome for a rejection: a
 * file with two hundred unsourced bullets would take the whole `check.failed`
 * record down with it and the run would lose its cost line as well as its
 * reasons. So the list is fitted here, from the front, and `orderedProblems` has
 * already put the errors there — a truncation that dropped the fatal lines and
 * kept the warnings would be worse than no list at all. The full, uncapped list
 * is always in `<area>.rejected.md`.
 */
function fitProblems(problems: readonly string[]): Record<string, unknown> {
  // Everything else on a check.failed payload — mode, reason, cost, task, counts
  // — is small and bounded; a kilobyte of headroom covers it several times over.
  const budget = MAX_PAYLOAD_BYTES - 1024;
  const kept: string[] = [];
  let used = 0;
  for (const problem of problems) {
    const cost = Buffer.byteLength(JSON.stringify(problem), "utf8") + 1;
    if (used + cost > budget) break;
    kept.push(problem.trimStart());
    used += cost;
  }
  const omitted = problems.length - kept.length;
  return omitted === 0 ? { problems: kept } : { problems: kept, problems_omitted: omitted };
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
