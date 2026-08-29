/**
 * `split.yml` — a proposed division of one seed into several runs (spec §6.2).
 *
 * The model proposes; this file refuses. Every field is checked against something
 * real before a byte is written: a scope must be a workflow that exists on disk,
 * a seed must be a document the inventory actually found, a slug must be a slug
 * `run new` would accept, the dependency graph must be acyclic, and every `why`
 * must cite a heading or a line of a seed document. A proposal that fails any of
 * those is rejected WHOLE (exit 5) with the raw model output kept beside it —
 * half a split is worse than none, because the half that survived looks
 * authoritative.
 *
 * `status:` is the human gate. `proposed` is the only state `tldrx seed apply`
 * will act on, and apply rewrites it to `applied` with the run ids it created, so
 * running apply twice cannot create the same runs twice.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_FRAMEWORK_DIR, WORKFLOWS_DIR } from "../paths.ts";
import { isRecord } from "../schemas/validation.ts";
import { yamlScalar } from "../facts/emitFactsYaml.ts";
import { SLUG_RE } from "../run/newRun.ts";
import { parseSeedSrc } from "./triageSrc.ts";

export const SPLIT_YML = "split.yml";
export const SPLIT_MD = "split.md";

export const SPLIT_SIZES = ["S", "M", "L"] as const;
export type SplitSize = (typeof SPLIT_SIZES)[number];

export const SPLIT_STATUSES = ["proposed", "applied"] as const;
export type SplitStatus = (typeof SPLIT_STATUSES)[number];

/** Spec §2.2 caps a run at 40 stages; a split that proposes more runs than this is a mistake. */
export const MAX_SPLIT_RUNS = 20;

export interface SplitWhy {
  readonly claim: string;
  /** `seed:<rel>#<heading>` or `seed:<rel>:<line>`. */
  readonly src: string;
}

export interface SplitRun {
  readonly slug: string;
  readonly scope: string;
  readonly goal: string;
  readonly seeds: readonly string[];
  readonly depends_on: readonly string[];
  readonly size: SplitSize;
  readonly budget_usd: number;
  readonly why: readonly SplitWhy[];
}

export interface SplitExclude {
  readonly path: string;
  readonly reason: string;
}

export interface SplitQuestion {
  readonly id: string;
  readonly text: string;
  readonly options?: readonly string[];
}

/** Exactly what the model returns. */
export interface SplitProposal {
  readonly shared_context: readonly string[];
  readonly exclude: readonly SplitExclude[];
  readonly runs: readonly SplitRun[];
  readonly questions: readonly SplitQuestion[];
}

/** The proposal plus the bookkeeping `split.yml` carries around it. */
export interface SplitFile extends SplitProposal {
  readonly version: 1;
  readonly status: SplitStatus;
  /** What `--seed` named, workspace-relative. */
  readonly source: string;
  readonly created_at: string;
  readonly applied_at?: string;
  /** Run ids `seed apply` created, in the order it created them. */
  readonly created_runs?: readonly string[];
}

export interface SplitContext {
  /** Every document rel path the inventory found — the only legal `seeds` entry. */
  readonly rels: ReadonlySet<string>;
  /** Every workflow stem on disk — the only legal `scope`. */
  readonly scopes: ReadonlySet<string>;
  /** rel path -> line count, so a `seed:<rel>:<line>` past the end is caught. */
  readonly lines?: ReadonlyMap<string, number>;
}

export interface SplitValidation {
  readonly ok: boolean;
  readonly issues: readonly string[];
  /** Present only when `ok`. */
  readonly proposal: SplitProposal | null;
}

/**
 * Every scope `run new --scope` would accept: the workspace's own
 * `.tldrx/workflows/*.yml` plus the shipped `workflows/*.yml`, exactly the two
 * places `workflowPath` looks (`workflowPreset.ts:70-75`).
 */
export function knownScopes(root: string): ReadonlySet<string> {
  const stems = new Set<string>();
  for (const dir of [join(root, PROJECT_FRAMEWORK_DIR, "workflows"), WORKFLOWS_DIR]) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.endsWith(".yml")) stems.add(entry.slice(0, -4));
    }
  }
  return stems;
}

export function validateProposal(input: unknown, ctx: SplitContext): SplitValidation {
  const issues: string[] = [];
  if (!isRecord(input)) {
    return { ok: false, issues: ["the proposal is not a JSON object"], proposal: null };
  }

  const shared = stringList(input.shared_context, "shared_context", issues);
  for (const rel of shared) {
    if (!ctx.rels.has(rel)) issues.push(`shared_context: '${rel}' is not a document in the inventory`);
  }

  const exclude: SplitExclude[] = [];
  for (const [i, entry] of arrayOf(input.exclude, "exclude", issues).entries()) {
    if (!isRecord(entry)) {
      issues.push(`exclude[${String(i)}]: expected an object`);
      continue;
    }
    const path = text(entry.path, `exclude[${String(i)}].path`, issues);
    const reason = text(entry.reason, `exclude[${String(i)}].reason`, issues);
    if (path !== null && !ctx.rels.has(path)) {
      issues.push(`exclude[${String(i)}]: '${path}' is not a document in the inventory`);
    }
    if (path !== null && reason !== null) exclude.push({ path, reason });
  }

  const runs: SplitRun[] = [];
  const rawRuns = arrayOf(input.runs, "runs", issues);
  if (rawRuns.length === 0) issues.push("runs: a split must propose at least one run");
  if (rawRuns.length > MAX_SPLIT_RUNS) {
    issues.push(`runs: ${String(rawRuns.length)} runs exceeds the ${String(MAX_SPLIT_RUNS)} cap`);
  }
  const slugs = new Set<string>();
  for (const [i, entry] of rawRuns.entries()) {
    const at = `runs[${String(i)}]`;
    if (!isRecord(entry)) {
      issues.push(`${at}: expected an object`);
      continue;
    }
    const slug = text(entry.slug, `${at}.slug`, issues);
    if (slug !== null && !SLUG_RE.test(slug)) {
      issues.push(`${at}.slug: '${slug}' is not a run slug — expected ^[a-z0-9][a-z0-9-]{0,39}$`);
    }
    if (slug !== null && slugs.has(slug)) issues.push(`${at}.slug: '${slug}' is used twice`);
    if (slug !== null) slugs.add(slug);

    const scope = text(entry.scope, `${at}.scope`, issues);
    if (scope !== null && !ctx.scopes.has(scope)) {
      issues.push(
        `${at}.scope: '${scope}' is not a workflow — known: ${[...ctx.scopes].sort().join(", ")}`,
      );
    }
    const goal = text(entry.goal, `${at}.goal`, issues);

    const seeds = stringList(entry.seeds, `${at}.seeds`, issues);
    if (seeds.length === 0) issues.push(`${at}.seeds: a run must name at least one seed document`);
    for (const rel of seeds) {
      if (!ctx.rels.has(rel)) issues.push(`${at}.seeds: '${rel}' is not a document in the inventory`);
    }

    const dependsOn = stringList(entry.depends_on, `${at}.depends_on`, issues);
    const size = text(entry.size, `${at}.size`, issues);
    if (size !== null && !(SPLIT_SIZES as readonly string[]).includes(size)) {
      issues.push(`${at}.size: expected one of ${SPLIT_SIZES.join(" | ")}, got '${size}'`);
    }
    const budget = entry.budget_usd;
    if (typeof budget !== "number" || !Number.isFinite(budget) || budget <= 0) {
      issues.push(`${at}.budget_usd: expected a number greater than 0`);
    }

    const why: SplitWhy[] = [];
    const rawWhy = arrayOf(entry.why, `${at}.why`, issues);
    if (rawWhy.length === 0) issues.push(`${at}.why: a proposed run must say what it is based on`);
    for (const [j, reason] of rawWhy.entries()) {
      const where = `${at}.why[${String(j)}]`;
      if (!isRecord(reason)) {
        issues.push(`${where}: expected an object`);
        continue;
      }
      const claim = text(reason.claim, `${where}.claim`, issues);
      const src = text(reason.src, `${where}.src`, issues);
      if (src !== null) {
        const parsed = parseSeedSrc(src);
        if ("error" in parsed) {
          issues.push(`${where}.src: ${parsed.error}`);
        } else if (!ctx.rels.has(parsed.rel)) {
          issues.push(`${where}.src: '${parsed.rel}' is not a document in the inventory`);
        } else if (parsed.kind === "line") {
          const total = ctx.lines?.get(parsed.rel);
          if (total !== undefined && parsed.line > total) {
            issues.push(`${where}.src: ${parsed.rel} has ${String(total)} line(s), not ${String(parsed.line)}`);
          }
        }
      }
      if (claim !== null && src !== null) why.push({ claim, src });
    }

    if (slug === null || scope === null || goal === null || size === null || typeof budget !== "number") continue;
    runs.push({
      slug, scope, goal, seeds, depends_on: dependsOn,
      size: size as SplitSize, budget_usd: budget, why,
    });
  }

  // Dependencies: known slugs, no self-reference, no cycle.
  for (const run of runs) {
    for (const dependency of run.depends_on) {
      if (dependency === run.slug) issues.push(`runs.${run.slug}: depends on itself`);
      else if (!slugs.has(dependency)) {
        issues.push(`runs.${run.slug}: depends_on '${dependency}', which is not a run in this split`);
      }
    }
  }
  const cycle = findCycle(runs);
  if (cycle !== null) issues.push(`runs: dependency cycle ${cycle.join(" -> ")}`);

  const questions: SplitQuestion[] = [];
  for (const [i, entry] of arrayOf(input.questions, "questions", issues).entries()) {
    const at = `questions[${String(i)}]`;
    if (!isRecord(entry)) {
      issues.push(`${at}: expected an object`);
      continue;
    }
    const id = text(entry.id, `${at}.id`, issues);
    if (id !== null && !/^Q\d{1,6}$/.test(id)) issues.push(`${at}.id: expected Q<n>, got '${id}'`);
    const body = text(entry.text, `${at}.text`, issues);
    const options = entry.options === undefined ? undefined : stringList(entry.options, `${at}.options`, issues);
    if (id !== null && body !== null) {
      questions.push(options === undefined ? { id, text: body } : { id, text: body, options });
    }
  }

  if (issues.length > 0) return { ok: false, issues, proposal: null };
  return { ok: true, issues: [], proposal: { shared_context: shared, exclude, runs, questions } };
}

/**
 * Runs in an order that respects `depends_on`, stable within a level: among runs
 * whose dependencies are already placed, the one the model listed first goes
 * first. Deterministic, so two applies of the same split create the same runs in
 * the same order. Returns null when the graph does not settle (a cycle the
 * validator should already have refused).
 */
export function topologicalOrder(runs: readonly SplitRun[]): readonly SplitRun[] | null {
  const placed = new Set<string>();
  const ordered: SplitRun[] = [];
  const pending = [...runs];
  while (pending.length > 0) {
    const index = pending.findIndex((run) => run.depends_on.every((slug) => placed.has(slug)));
    if (index === -1) return null;
    const [next] = pending.splice(index, 1);
    if (next === undefined) return null;
    placed.add(next.slug);
    ordered.push(next);
  }
  return ordered;
}

function findCycle(runs: readonly SplitRun[]): readonly string[] | null {
  const bySlug = new Map(runs.map((run) => [run.slug, run] as const));
  const state = new Map<string, "open" | "closed">();
  const stack: string[] = [];

  const walk = (slug: string): readonly string[] | null => {
    const status = state.get(slug);
    if (status === "closed") return null;
    if (status === "open") return [...stack.slice(stack.indexOf(slug)), slug];
    state.set(slug, "open");
    stack.push(slug);
    for (const dependency of bySlug.get(slug)?.depends_on ?? []) {
      if (!bySlug.has(dependency)) continue;
      const found = walk(dependency);
      if (found !== null) return found;
    }
    stack.pop();
    state.set(slug, "closed");
    return null;
  };

  for (const run of runs) {
    const found = walk(run.slug);
    if (found !== null) return found;
  }
  return null;
}

// --- reading and writing ----------------------------------------------------

export class SplitError extends Error {}

/** Narrow a parsed `split.yml`. Structure is re-validated by `validateProposal`. */
export function readSplitFile(doc: unknown): SplitFile {
  if (!isRecord(doc)) throw new SplitError("split.yml: expected a mapping at the document root");
  const status = doc.status;
  if (typeof status !== "string" || !(SPLIT_STATUSES as readonly string[]).includes(status)) {
    throw new SplitError(`split.yml: status must be one of ${SPLIT_STATUSES.join(" | ")}, got ${String(status)}`);
  }
  if (typeof doc.source !== "string") throw new SplitError("split.yml: `source` must be a string");
  return doc as unknown as SplitFile;
}

export function emitSplitYaml(file: SplitFile): string {
  const lines = [
    "# tldrx: a proposed split of one seed into several runs (spec §6.2).",
    "# `status: proposed` is the human gate — `tldrx seed apply` acts on nothing else.",
    `version: ${String(file.version)}`,
    `status: ${yamlScalar(file.status)}`,
    `source: ${yamlScalar(file.source)}`,
    `created_at: ${yamlScalar(file.created_at)}`,
  ];
  if (file.applied_at !== undefined) lines.push(`applied_at: ${yamlScalar(file.applied_at)}`);
  if (file.created_runs !== undefined) lines.push(`created_runs: ${inlineList(file.created_runs)}`);

  lines.push(`shared_context: ${inlineList(file.shared_context)}`);
  if (file.exclude.length === 0) lines.push("exclude: []");
  else {
    lines.push("exclude:");
    for (const entry of file.exclude) {
      lines.push(`  - {path: ${yamlScalar(entry.path)}, reason: ${yamlScalar(entry.reason)}}`);
    }
  }

  lines.push("runs:");
  for (const run of file.runs) {
    lines.push(`  - slug: ${yamlScalar(run.slug)}`);
    lines.push(`    scope: ${yamlScalar(run.scope)}`);
    lines.push(`    goal: ${yamlScalar(run.goal)}`);
    lines.push(`    size: ${yamlScalar(run.size)}`);
    lines.push(`    budget_usd: ${run.budget_usd.toFixed(2)}`);
    lines.push(`    seeds: ${inlineList(run.seeds)}`);
    lines.push(`    depends_on: ${inlineList(run.depends_on)}`);
    if (run.why.length === 0) lines.push("    why: []");
    else {
      lines.push("    why:");
      for (const why of run.why) {
        lines.push(`      - {claim: ${yamlScalar(why.claim)}, src: ${yamlScalar(why.src)}}`);
      }
    }
  }

  if (file.questions.length === 0) lines.push("questions: []");
  else {
    lines.push("questions:");
    for (const question of file.questions) {
      const options = question.options === undefined ? "" : `, options: ${inlineList(question.options)}`;
      lines.push(`  - {id: ${yamlScalar(question.id)}, text: ${yamlScalar(question.text)}${options}}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function renderSplitMarkdown(file: SplitFile, outRel: string): string {
  const lines = [
    `# Proposed split — ${file.source}`,
    "",
    `Status: **${file.status}** · proposed ${file.created_at}`
      + (file.applied_at === undefined ? "" : ` · applied ${file.applied_at}`),
    "",
    "Nothing has been created yet. `tldrx seed apply` is the gate: read this, edit or",
    `delete runs in \`${outRel}/${SPLIT_YML}\`, then apply it.`,
    "",
    "## Runs",
    "",
    "| Slug | Scope | Size | Budget | Seeds | Depends on |",
    "|------|-------|------|--------|-------|------------|",
  ];
  for (const run of file.runs) {
    lines.push(
      `| \`${run.slug}\` | ${run.scope} | ${run.size} | $${run.budget_usd.toFixed(2)} | `
      + `${String(run.seeds.length)} | ${run.depends_on.length === 0 ? "—" : run.depends_on.join(", ")} |`,
    );
  }
  lines.push("");

  for (const run of file.runs) {
    lines.push(`### \`${run.slug}\` — ${run.goal}`, "");
    lines.push(`- scope \`${run.scope}\`, size ${run.size}, budget $${run.budget_usd.toFixed(2)}`);
    lines.push(run.depends_on.length === 0
      ? "- depends on: nothing"
      : `- depends on: ${run.depends_on.map((slug) => `\`${slug}\``).join(", ")}`);
    lines.push("- seeds:");
    for (const seed of run.seeds) lines.push(`  - \`${seed}\``);
    lines.push("- why:");
    for (const why of run.why) lines.push(`  - ${why.claim} [${why.src}]`);
    lines.push("");
  }

  lines.push("## Shared context", "");
  if (file.shared_context.length === 0) lines.push("- none — no document is added to every run");
  for (const rel of file.shared_context) lines.push(`- \`${rel}\``);
  lines.push("");

  lines.push("## Excluded", "");
  if (file.exclude.length === 0) lines.push("- none — every document landed in a run");
  for (const entry of file.exclude) lines.push(`- \`${entry.path}\` — ${entry.reason}`);
  lines.push("");

  lines.push("## Questions", "");
  if (file.questions.length === 0) lines.push("- none");
  for (const question of file.questions) {
    lines.push(`- **${question.id}** ${question.text}`);
    for (const option of question.options ?? []) lines.push(`  - ${option}`);
  }
  lines.push("");

  if (file.created_runs !== undefined && file.created_runs.length > 0) {
    lines.push("## Created", "");
    for (const id of file.created_runs) lines.push(`- \`${id}\``);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The `--json-schema` the headless sub-agent is spawned with.
 *
 * It constrains the SHAPE only. Whether a scope exists, a seed was in the
 * inventory or the dependency graph is acyclic is decided by `validateProposal`
 * against this workspace — a schema cannot know any of that, and a model that
 * returns a well-shaped lie must still be caught.
 */
export const SPLIT_SCHEMA: Readonly<Record<string, unknown>> = {
  type: "object",
  additionalProperties: false,
  required: ["shared_context", "exclude", "runs", "questions"],
  properties: {
    shared_context: { type: "array", items: { type: "string" } },
    exclude: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "reason"],
        properties: { path: { type: "string" }, reason: { type: "string" } },
      },
    },
    runs: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["slug", "scope", "goal", "seeds", "depends_on", "size", "budget_usd", "why"],
        properties: {
          slug: { type: "string" },
          scope: { type: "string" },
          goal: { type: "string" },
          seeds: { type: "array", items: { type: "string" } },
          depends_on: { type: "array", items: { type: "string" } },
          size: { type: "string", enum: [...SPLIT_SIZES] },
          budget_usd: { type: "number" },
          why: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["claim", "src"],
              properties: { claim: { type: "string" }, src: { type: "string" } },
            },
          },
        },
      },
    },
    questions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "text"],
        properties: {
          id: { type: "string" },
          text: { type: "string" },
          options: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

// --- small helpers ----------------------------------------------------------

function inlineList(values: readonly string[]): string {
  return `[${values.map((value) => yamlScalar(value)).join(", ")}]`;
}

function arrayOf(value: unknown, path: string, issues: string[]): readonly unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    issues.push(`${path}: expected an array`);
    return [];
  }
  return value;
}

function stringList(value: unknown, path: string, issues: string[]): readonly string[] {
  const out: string[] = [];
  for (const [i, entry] of arrayOf(value, path, issues).entries()) {
    if (typeof entry !== "string" || entry === "") {
      issues.push(`${path}[${String(i)}]: expected a non-empty string`);
      continue;
    }
    out.push(entry);
  }
  return out;
}

function text(value: unknown, path: string, issues: string[]): string | null {
  if (typeof value !== "string" || value.trim() === "") {
    issues.push(`${path}: expected a non-empty string`);
    return null;
  }
  return value;
}
