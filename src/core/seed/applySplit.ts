/**
 * `tldrx seed apply <split.yml>` — the human gate (spec §6.2).
 *
 * The gate is not a prompt and not a `y/N`: it is that you ran this command. A
 * proposal sits on disk as `status: proposed` until somebody reads it, edits or
 * deletes the runs they disagree with, and applies what is left. Nothing upstream
 * of here creates a run — `seed triage --propose` deliberately cannot.
 *
 * Creating the runs goes through `createRun`, the same function `tldrx run new`
 * calls, with `--scope` and the seed subset. There is no second run-creation path:
 * the phase folders, the budget split, the seeded handoff and the atomic rename
 * are all the ones that were already there, and a run made by apply is
 * indistinguishable from one made by hand except for the `triage:` block that
 * records where it came from.
 *
 * **Partial application is a real state and is said out loud.** Runs are created
 * one at a time in dependency order; if the fourth collides with a directory that
 * already exists, the first three stay created and the message names them. Undoing
 * them is `rm -rf tldrx-work/<id>` and the operator is told so, rather than the
 * tool guessing which half of a half-applied split it should destroy.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { PROJECT_WORK_DIR } from "../paths.ts";
import { parseYaml } from "../yaml.ts";
import { createRun, NewRunError } from "../run/newRun.ts";
import { RunStore } from "../run/RunStore.ts";
import { SeedError } from "./collectSeed.ts";
import {
  emitSplitYaml, isAnswered, knownScopes, readSplitFile, renderSplitMarkdown, topologicalOrder,
  validateProposal, SplitError, SPLIT_MD, SPLIT_YML,
  type SplitFile, type SplitQuestion, type SplitRun,
} from "./splitFile.ts";

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_NOT_FOUND = 3;

export interface ApplyOptions {
  readonly root: string;
  /** `<split.yml>` as typed; relative paths resolve against the CWD. */
  readonly splitPath: string;
  readonly dryRun?: boolean;
  readonly actor: string;
  readonly now: Date;
}

export interface ApplyOutcome {
  readonly code: number;
  readonly lines: readonly string[];
  /** Lines the CLI must put on stderr whatever the code — the several-runs reminder. */
  readonly notes: readonly string[];
  readonly created: readonly string[];
}

export function applySplit(options: ApplyOptions): ApplyOutcome {
  const path = isAbsolute(options.splitPath) ? options.splitPath : resolve(process.cwd(), options.splitPath);
  if (!existsSync(path)) {
    return fail(EXIT_NOT_FOUND, [`no such file: ${options.splitPath}`]);
  }

  let file: SplitFile;
  try {
    file = readSplitFile(parseYaml(readFileSync(path, "utf8")));
  } catch (error) {
    return fail(EXIT_USAGE, [error instanceof SplitError ? error.message : message(error)]);
  }
  if (file.status !== "proposed") {
    return fail(EXIT_USAGE, [
      `${options.splitPath} is \`status: ${file.status}\`, not \`proposed\` — nothing to apply.`,
      file.created_runs === undefined || file.created_runs.length === 0
        ? "  Re-run `tldrx seed triage <path> --propose` to make a new proposal."
        : `  It already created: ${file.created_runs.join(", ")}`,
    ]);
  }

  // The proposal is validated AGAIN here, not only when it was written: split.yml
  // is a file a human is invited to edit, and an edited scope or a hand-added
  // cycle must be refused by the command that acts on it.
  const validation = validateProposal(file, {
    rels: splitUniverse(path, file),
    scopes: knownScopes(options.root),
  });
  if (!validation.ok || validation.proposal === null) {
    return fail(EXIT_USAGE, [
      `${options.splitPath} does not validate — ${String(validation.issues.length)} problem(s)`,
      ...validation.issues.map((issue) => `  ${issue}`),
    ]);
  }

  const ordered = topologicalOrder(validation.proposal.runs);
  if (ordered === null) {
    return fail(EXIT_USAGE, [`${options.splitPath}: the runs do not order — depends_on has a cycle`]);
  }
  const shared = validation.proposal.shared_context;
  const splitRef = reference(options.root, path);

  const unanswered = unansweredNote(validation.proposal.questions);

  if (options.dryRun === true) {
    return {
      code: EXIT_OK,
      created: [],
      notes: unanswered,
      lines: [
        `dry run — ${String(ordered.length)} run(s) would be created, in this order, and nothing was written:`,
        ...ordered.map((run) => `  ${runNewLine(run, shared)}`),
        `  each also records \`triage: {split: ${splitRef}, depends_on: [...]}\` in its run.yml`,
      ],
    };
  }

  // `applying` BEFORE the first createRun, and `created_runs` rewritten after
  // each one. A crash at run 3 of 8 then leaves a file that says exactly that,
  // instead of one that still reads `proposed` next to three run directories.
  const created: string[] = [];
  const stamp = (status: "applying" | "applied"): void => {
    writeFileSync(path, emitSplitYaml({
      ...file,
      ...validation.proposal,
      status,
      applied_at: rfc3339(options.now),
      created_runs: [...created],
    }), "utf8");
  };
  stamp("applying");

  for (const run of ordered) {
    try {
      const outcome = createRun({
        root: options.root,
        slug: run.slug,
        title: run.goal.length > 120 ? `${run.goal.slice(0, 119)}…` : run.goal,
        scope: run.scope,
        budgetUsd: run.budget_usd,
        seed: seedsFor(run, shared),
        triage: { split: splitRef, depends_on: run.depends_on },
        actor: options.actor,
        now: options.now,
      });
      created.push(outcome.runId);
      stamp("applying");
    } catch (error) {
      const reason = error instanceof NewRunError || error instanceof SeedError
        ? error.message
        : message(error);
      return {
        code: EXIT_USAGE,
        created,
        notes: [...unanswered, ...openRunsNote(options.root)],
        lines: [
          `stopped at \`${run.slug}\`: ${reason}`,
          created.length === 0
            ? `  nothing was created; ${SPLIT_YML} now reads \`status: applying\``
            : `  ${String(created.length)} of ${String(ordered.length)} run(s) created before this one and `
              + `LEFT IN PLACE: ${created.join(", ")}`,
          created.length === 0
            ? `  fix the split (or the colliding directory), set ${SPLIT_YML} back to \`status: proposed\`, and apply again`
            : `  ${SPLIT_YML} records them under \`status: applying\` — remove those run dirs (or delete the runs),`
              + " set it back to `status: proposed`, and apply again",
        ],
      };
    }
  }

  const applied: SplitFile = {
    ...file,
    ...validation.proposal,
    status: "applied",
    applied_at: rfc3339(options.now),
    created_runs: created,
  };
  writeFileSync(path, emitSplitYaml(applied), "utf8");
  const outRel = reference(options.root, dirname(path));
  const markdown = join(dirname(path), SPLIT_MD);
  if (existsSync(markdown)) writeFileSync(markdown, renderSplitMarkdown(applied, outRel), "utf8");

  return {
    code: EXIT_OK,
    created,
    notes: [...unanswered, ...openRunsNote(options.root)],
    lines: [
      ...ordered.map((run, i) =>
        `created ${created[i] ?? run.slug} (${run.scope}, `
        + `${String(seedsFor(run, shared).length)} seeds`
        + (run.depends_on.length === 0 ? "" : `, depends on: ${run.depends_on.join(", ")}`) + ")"),
      `${options.splitPath} is now \`status: applied\` (${String(created.length)} run(s) recorded)`,
      `next: tldrx run status ${created[0] ?? ""}`.trimEnd(),
    ],
  };
}

/** Shared context first, then the run's own, deduped and in a stable order. */
export function seedsFor(run: SplitRun, shared: readonly string[]): readonly string[] {
  const out: string[] = [];
  for (const rel of [...shared, ...run.seeds]) {
    if (!out.includes(rel)) out.push(rel);
  }
  return out;
}

/** The exact command `--dry-run` prints — copy-pasteable, not a summary of one. */
export function runNewLine(run: SplitRun, shared: readonly string[]): string {
  return [
    "tldrx run new", run.slug,
    "--scope", run.scope,
    "--budget", run.budget_usd.toFixed(2),
    ...seedsFor(run, shared).flatMap((rel) => ["--seed", rel]),
  ].join(" ");
}

/**
 * The rel-path universe a `seeds` entry is checked against.
 *
 * `inventory.json` beside the split is the real answer — it is the list the
 * proposal was made from. Without it (a split moved somewhere else, or edited by
 * hand into a new folder) the split's own paths stand in, and the check reduces
 * to "internally consistent"; `collectSeeds` still refuses a path that is not on
 * disk when the run is created, so nothing gets past on a missing file.
 */
export function splitUniverse(splitPath: string, file: SplitFile): ReadonlySet<string> {
  const inventory = join(dirname(splitPath), "inventory.json");
  if (existsSync(inventory)) {
    try {
      const doc = JSON.parse(readFileSync(inventory, "utf8")) as { documents?: { rel?: unknown }[] };
      const rels = (doc.documents ?? [])
        .map((row) => row.rel)
        .filter((rel): rel is string => typeof rel === "string");
      if (rels.length > 0) return new Set(rels);
    } catch {
      // fall through to the split's own paths
    }
  }
  const rels = new Set<string>(file.shared_context);
  for (const entry of file.exclude) rels.add(entry.path);
  for (const run of file.runs) for (const rel of run.seeds) rels.add(rel);
  return rels;
}

/** Workspace-relative when the file is inside the root, absolute when it is not. */
function reference(root: string, path: string): string {
  const rel = relative(root, path);
  return rel === "" || rel.startsWith("..") ? path : rel.split("\\").join("/");
}

/**
 * The questions nobody answered, as a WARNING — never a refusal.
 *
 * A split's questions are the model saying "this changes what the runs should be
 * and I could not decide it". Applying anyway is a legitimate choice (the answer
 * may not change these runs), so this does not block. What it must not do is stay
 * silent: the questions live inside a YAML file nobody re-opens after the first
 * read, and until this line existed, applying a split was the last moment they
 * could have mattered and the one moment nothing mentioned them.
 */
export function unansweredNote(questions: readonly SplitQuestion[]): readonly string[] {
  const open = questions.filter((question) => !isAnswered(question));
  if (open.length === 0) return [];
  return [
    `warning: ${String(open.length)} question(s) on this split are unanswered — applying anyway:`,
    ...open.map((question) => `  ${question.id} ${question.text}`),
    "  record a decision with `tldrx seed answer <split.yml> <Qid> \"<text>\"` (it does not block apply)",
  ];
}

/**
 * Spec §3.1: several runs open means every later command needs an explicit id.
 * Applying a split is the fastest way there is to get there, so it says so.
 */
function openRunsNote(root: string): readonly string[] {
  const open = RunStore.findOpen(root).length;
  return open > 1
    ? [`note: ${String(open)} run(s) open in ${PROJECT_WORK_DIR}/ — `
      + "pass a run id to next/answer/approve/… from now on"]
    : [];
}

function fail(code: number, lines: readonly string[]): ApplyOutcome {
  return { code, lines, notes: [], created: [] };
}

function rfc3339(now: Date): string {
  return `${now.toISOString().slice(0, 19)}Z`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
