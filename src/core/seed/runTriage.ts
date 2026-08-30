/**
 * `tldrx seed triage` — the run (spec §6.2).
 *
 * Two commands in one file because they are two halves of one answer. Without
 * `--propose` nothing costs anything: the seed is collected exactly as
 * `run new --seed` collects it, counted, and written out as `inventory.md` +
 * `inventory.json` with a verdict line. With `--propose` the same inventory plus
 * the documents themselves go to ONE sub-agent, which returns a proposed split —
 * and that proposal is validated against this workspace before a byte of
 * `split.yml` is written. Neither path ever creates a run: `tldrx seed apply` is
 * the human gate, and it is a separate command precisely so that "the model
 * proposed it" and "we are doing it" cannot be the same event.
 *
 * The three execution modes are the ones `tldrx next` and `tldrx expert train`
 * already have, over the same `pending.ts` bundle: headless spawns `claude -p`
 * itself with `--json-schema`; `--prepare` writes `prompt.md` + `pending.json` and
 * stops; `--commit` picks the same validation path up from the host session's
 * `result.json`. From "validate the proposal" onwards there is one code path.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { PROJECT_FRAMEWORK_DIR } from "../paths.ts";
import { loadWorkspace } from "../../hooks/lib/workspace.ts";
import { agentDir } from "../facilitator/paths.ts";
import { PendingError, resultPath, writeBundle, writeRaw, type PendingStage } from "../facilitator/pending.ts";
import { spawnAgent } from "../facilitator/spawnAgent.ts";
import { setProgressCeiling, setProgressTitle } from "../ui/bus.ts";
import type { EffortLevel } from "../schemas/stage.ts";
import { yymmdd } from "../run/newRun.ts";
import { collectSeed, type SeedSet } from "./collectSeed.ts";
import { buildInventory, inventoryRels, verdictLine, type SeedInventory } from "./triageInventory.ts";
import { inventoryJson, renderInventory, INVENTORY_JSON, INVENTORY_MD } from "./renderInventory.ts";
import { triagePrompt } from "./triagePrompt.ts";
import {
  emitSplitYaml, knownScopes, renderSplitMarkdown, validateProposal, SPLIT_MD, SPLIT_YML,
  SPLIT_SCHEMA, type SplitFile,
} from "./splitFile.ts";

export type TriageMode = "headless" | "prepare" | "commit";

/** The bundle stage id — `<out>/.agent/propose/`. */
export const PROPOSE_STAGE = "propose";

/** Spec §3 codes. */
const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_REFUSED = 2;
const EXIT_AGENT_FAILED = 5;

/** `[assumption]` — one cheap pass. `low` because this is sorting, not designing. */
export const DEFAULT_TRIAGE_EFFORT: EffortLevel = "low";
export const DEFAULT_TRIAGE_USD = 1.0;
/**
 * Below this a spawn is a failure, not a saving: a cold `claude -p` pays 10–26k
 * cache-creation tokens before its first reply (measured 2026-08-29, README
 * § Design notes), so a ceiling under a quarter of a dollar buys `error_max_budget_usd`.
 */
export const MIN_TRIAGE_USD = 0.25;
/** `[assumption]` — no stage.yml governs a triage; the facilitator's 30-minute default. */
export const TRIAGE_TIMEOUT_MS = 30 * 60 * 1000;

export interface TriageOptions {
  readonly root: string;
  /** What the operator typed after `seed triage`. */
  readonly seedPath: string;
  /** `--out`; relative paths resolve against the CWD, as a path an operator typed does. */
  readonly out?: string;
  readonly json?: boolean;
  readonly thresholdTokens?: number;
  readonly propose?: boolean;
  readonly mode?: TriageMode;
  readonly model?: string | null;
  readonly effort?: EffortLevel;
  readonly maxUsd?: number;
  readonly yolo?: boolean;
  readonly at: string;
  readonly now: Date;
  readonly timeoutMs?: number;
  /** Test seam: the byte budget of the model prompt. */
  readonly promptBytes?: number;
}

export interface TriageOutcome {
  readonly code: number;
  readonly lines: readonly string[];
  /** Stdout when the code is 0, stderr otherwise — the CLI decides, not this. */
  readonly costUsd: number;
  readonly outDir: string;
  readonly inventory: SeedInventory | null;
}

export async function runTriage(options: TriageOptions): Promise<TriageOutcome> {
  const workspace = loadWorkspace(options.root);
  const seed: SeedSet = collectSeed(options.root, options.seedPath);
  const inventory = buildInventory({
    root: options.root,
    seed,
    repos: workspace.repos,
    thresholdTokens: options.thresholdTokens ?? workspace.seedTriageThresholdTokens ?? undefined,
  });

  const outDir = resolveOut(options);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, INVENTORY_MD), renderInventory(inventory, options.seedPath, options.at), "utf8");
  writeFileSync(join(outDir, INVENTORY_JSON), inventoryJson(inventory, options.seedPath, options.at), "utf8");

  if (options.propose !== true) {
    const where = display(options.root, outDir);
    const lines = options.json === true
      ? [inventoryJson(inventory, options.seedPath, options.at).replace(/\n$/, "")]
      : [
        verdictLine(inventory, options.seedPath),
        `  ${where}/${INVENTORY_MD}`,
        `  ${where}/${INVENTORY_JSON}`,
        ...inventory.warnings.map((warning) => `  warning: ${warning}`),
      ];
    return { code: EXIT_OK, lines, costUsd: 0, outDir, inventory };
  }

  return propose(options, workspace.commands, inventory, seed, outDir);
}

async function propose(
  options: TriageOptions,
  workspaceCommands: ReadonlySet<string>,
  inventory: SeedInventory,
  seed: SeedSet,
  outDir: string,
): Promise<TriageOutcome> {
  const mode = options.mode ?? "headless";
  const ceiling = options.maxUsd ?? DEFAULT_TRIAGE_USD;
  const effort = options.effort ?? DEFAULT_TRIAGE_EFFORT;
  const where = display(options.root, outDir);

  // The gate is before anything is read or spawned (spec §5 order).
  if (mode !== "commit" && ceiling < MIN_TRIAGE_USD) {
    return {
      code: EXIT_REFUSED,
      costUsd: 0,
      outDir,
      inventory,
      lines: [
        `refusing to propose under the $${MIN_TRIAGE_USD.toFixed(2)} floor — --max-usd was $${ceiling.toFixed(2)}.`,
        "  A cold `claude -p` pays 10-26k cache-creation tokens before its first reply,",
        "  so a ceiling below the floor is a failed spawn, not a saving. Raise --max-usd.",
        "  `--max-budget-usd` is a stop-after-turn, not a cap: a turn already in flight",
        "  runs to its end. Size the prompt for what you are willing to lose.",
      ],
    };
  }

  const scopes = [...knownScopes(options.root)].sort();
  const prompt = triagePrompt({
    inventory,
    seed,
    seedPath: options.seedPath,
    scopes,
    budgetUsd: ceiling,
    promptBytes: options.promptBytes,
    proposalPath: mode === "prepare" ? `${where}/.agent/${PROPOSE_STAGE}/result.json` : undefined,
  });

  if (mode === "prepare") {
    const pending: PendingStage = {
      version: 1,
      run: `seed:${inventory.source}`,
      phase: "triage",
      stage: PROPOSE_STAGE,
      expert: null,
      model: options.model ?? null,
      effort,
      budget_usd: ceiling,
      max_budget_usd: ceiling,
      prompt: "prompt.md",
      outputs: [`${where}/${SPLIT_YML}`, `${where}/${SPLIT_MD}`],
      sections: {},
      checks: [],
      prepared_at: options.at,
    };
    writeBundle(outDir, PROPOSE_STAGE, prompt, pending);
    return {
      code: EXIT_OK,
      costUsd: 0,
      outDir,
      inventory,
      lines: [
        `prepared a triage proposal for ${inventory.source} — 1 sub-agent, `
          + `$${ceiling.toFixed(2)} ceiling, effort ${effort}`,
        `  ${where}/.agent/${PROPOSE_STAGE}/prompt.md`,
        `  the sub-agent writes {proposal, outputs, questions_asked, notes, cost_usd, session_id}`,
        `  to ${where}/.agent/${PROPOSE_STAGE}/result.json — \`proposal\` is the JSON object the prompt describes`,
        "then run",
        `  tldrx seed triage ${options.seedPath} --propose --commit --out ${where}`,
      ],
    };
  }

  let raw: unknown;
  let costUsd = 0;
  let sessionId: string | null = null;

  if (mode === "commit") {
    try {
      const result = readTriageResult(outDir);
      raw = result.proposal;
      costUsd = result.costUsd;
      sessionId = result.sessionId;
    } catch (error) {
      if (error instanceof PendingError) {
        return { code: EXIT_USAGE, costUsd: 0, outDir, inventory, lines: [error.message] };
      }
      throw error;
    }
  } else {
    setProgressTitle(`triage ${inventory.source}`);
    setProgressCeiling(ceiling);
    const outcome = await spawnAgent({
      prompt,
      model: options.model ?? null,
      effort,
      maxBudgetUsd: ceiling,
      workspaceCommands: [...workspaceCommands],
      yolo: options.yolo ?? false,
      cwd: options.root,
      timeoutMs: options.timeoutMs ?? TRIAGE_TIMEOUT_MS,
      schema: SPLIT_SCHEMA,
    });
    if (outcome.raw !== "") writeRaw(outDir, PROPOSE_STAGE, outcome.raw);
    costUsd = round2(outcome.costUsd);
    sessionId = outcome.sessionId;
    if (!outcome.ok) {
      return {
        code: EXIT_AGENT_FAILED,
        costUsd,
        outDir,
        inventory,
        lines: [
          `the triage sub-agent failed — ${outcome.error ?? "no result"}`,
          `  $${costUsd.toFixed(2)} of $${ceiling.toFixed(2)} spent; nothing was written to ${SPLIT_YML}`,
        ],
      };
    }
    raw = outcome.structured;
  }

  const validation = validateProposal(raw, {
    rels: inventoryRels(inventory),
    scopes: knownScopes(options.root),
    lines: new Map(inventory.documents.map((document) => [document.rel, document.lines] as const)),
  });
  if (!validation.ok || validation.proposal === null) {
    // The raw answer is kept, always: the one record of what the model actually
    // said is the only way to tell a bad prompt from a bad model.
    if (mode === "commit") writeRaw(outDir, PROPOSE_STAGE, JSON.stringify(raw ?? null, null, 2));
    return {
      code: EXIT_AGENT_FAILED,
      costUsd,
      outDir,
      inventory,
      lines: [
        `the proposal does not validate — ${String(validation.issues.length)} problem(s); `
          + `nothing was written to ${SPLIT_YML}`,
        ...validation.issues.map((issue) => `  ${issue}`),
        `  the raw answer is at ${where}/.agent/${PROPOSE_STAGE}/result.raw.json`,
      ],
    };
  }

  const file: SplitFile = {
    version: 1,
    status: "proposed",
    source: inventory.source,
    created_at: options.at,
    ...validation.proposal,
  };
  writeFileSync(join(outDir, SPLIT_YML), emitSplitYaml(file), "utf8");
  writeFileSync(join(outDir, SPLIT_MD), renderSplitMarkdown(file, where), "utf8");

  const over = costUsd > ceiling + 1e-9;
  return {
    code: EXIT_OK,
    costUsd,
    outDir,
    inventory,
    lines: [
      `proposed ${String(file.runs.length)} run(s) from ${inventory.source} — `
        + `$${costUsd.toFixed(2)} of $${ceiling.toFixed(2)}`
        + (sessionId === null ? "" : ` · session ${sessionId}`),
      ...file.runs.map((run) =>
        `  ${run.slug} (${run.scope}, ${run.size}, $${run.budget_usd.toFixed(2)}, `
        + `${String(run.seeds.length)} seed(s)`
        + (run.depends_on.length === 0 ? "" : `, after ${run.depends_on.join(", ")}`) + ")"),
      `  ${String(file.shared_context.length)} shared, ${String(file.exclude.length)} excluded, `
        + `${String(file.questions.length)} question(s)`,
      `  ${where}/${SPLIT_YML}`,
      `  ${where}/${SPLIT_MD}`,
      ...(over
        ? [`  warning: $${costUsd.toFixed(2)} spent against a $${ceiling.toFixed(2)} ceiling — `
          + "`--max-budget-usd` stops after a turn, it cannot end one already in flight"]
        : []),
      `next: read ${where}/${SPLIT_MD}, then \`tldrx seed apply ${where}/${SPLIT_YML}\``,
    ],
  };
}

// --- pieces -----------------------------------------------------------------

export interface TriageResult {
  readonly proposal: unknown;
  readonly costUsd: number;
  readonly sessionId: string | null;
}

/**
 * Read the host session's `result.json` — the `--commit` half of the handshake.
 *
 * Same file, same directory and same error type as `next --commit` and
 * `expert train --commit`; the only difference is that this one carries the
 * answer itself under `proposal`, because a triage produces an object rather than
 * a file on disk. A result whose top level already looks like a proposal (it has
 * `runs`) is accepted as one, so a session that wrote the object straight into
 * `result.json` is not punished for a guess the prompt could have been clearer about.
 */
export function readTriageResult(outDir: string): TriageResult {
  const path = resultPath(outDir, PROPOSE_STAGE);
  if (!existsSync(path)) {
    throw new PendingError(
      `no result.json in ${agentDir(outDir, PROPOSE_STAGE)} — the in-session run must write it `
      + "before `seed triage --propose --commit`",
    );
  }
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new PendingError(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    throw new PendingError(`${path} must be a JSON object`);
  }
  const row = doc as Record<string, unknown>;
  const proposal = row.proposal !== undefined ? row.proposal : "runs" in row ? row : null;
  if (proposal === null) {
    throw new PendingError(`${path} has no \`proposal\` key — the sub-agent must write the JSON object there`);
  }
  return {
    proposal,
    costUsd: typeof row.cost_usd === "number" ? round2(row.cost_usd) : 0,
    sessionId: typeof row.session_id === "string" ? row.session_id : null,
  };
}

/** `.tldrx/triage/<yymmdd>-<slug>/` unless `--out` says otherwise. */
export function triageOutDir(root: string, seedPath: string, now: Date): string {
  return join(root, PROJECT_FRAMEWORK_DIR, "triage", `${yymmdd(now)}-${slugOf(seedPath)}`);
}

/** The last path segment, extension dropped, lower-cased and hyphenated. */
export function slugOf(seedPath: string): string {
  const base = seedPath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "seed";
  const stem = base.replace(/\.(md|txt)$/i, "");
  const slug = stem.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return slug === "" ? "seed" : slug;
}

function resolveOut(options: TriageOptions): string {
  if (options.out === undefined) return triageOutDir(options.root, options.seedPath, options.now);
  return isAbsolute(options.out) ? options.out : resolve(process.cwd(), options.out);
}

/** Workspace-relative when it is inside the root, absolute when it is not. */
function display(root: string, dir: string): string {
  const rel = relative(root, dir);
  return rel === "" || rel.startsWith("..") ? dir : rel.split("\\").join("/");
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
