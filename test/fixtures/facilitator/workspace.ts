/**
 * A workspace built for one facilitator test: a scope preset, its stage folders,
 * an expert, and a real run seeded through `createRun`.
 *
 * The stage files are generated rather than checked in because what each test
 * needs is a different SHAPE of stage — a gate here, a required input there, a
 * `skip_if` in a third — and thirteen near-identical yml files on disk would hide
 * exactly the one line that matters to the test reading them.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FRAMEWORK_ROOT } from "../../../src/core/paths.ts";
import { createRun } from "../../../src/core/run/newRun.ts";
import { WORKSPACE_YML, EMPTY_FACTS } from "../tempRunWorkspace.ts";

export const FAKE_CLAUDE_IMPL = join(FRAMEWORK_ROOT, "test", "fixtures", "facilitator", "fakeClaude.ts");

export interface StageOptions {
  readonly id: string;
  readonly phase: string;
  readonly budgetUsd: number;
  readonly gate?: "approve" | "auto" | "checks";
  readonly required?: readonly string[];
  readonly optional?: readonly string[];
  readonly outputs?: readonly { readonly path: string; readonly sections?: readonly string[] }[];
  /** Raw YAML for `checks:`, e.g. `[{id: cmd, on: post-write, repo: api, command: "true"}]`. */
  readonly checks?: string;
  /**
   * Raw YAML for `preconditions:`, e.g. `[{id: docker, repo: api, command: "true"}]`.
   * Omitted ⇒ the key is absent from stage.yml entirely, which is the shape every
   * shipped stage has and the one the byte-identical tests are asserted against.
   */
  readonly preconditions?: string;
  readonly skipIf?: string;
  readonly dryRunAllowed?: boolean;
  readonly timeoutS?: number;
  readonly experts?: readonly string[];
  /** `expert_knowledge_bytes:` — the retired spelling, now read as the TOTAL (§2.3). */
  readonly expertKnowledgeBytes?: number;
  /** `knowledge_max_bytes:` — the total trained-knowledge ceiling, shared (§2.3). */
  readonly knowledgeMaxBytes?: number;
  /** `inputs_max_bytes:` — the shared ceiling on declared-input content (§2.3). */
  readonly inputsMaxBytes?: number;
  /** `prompt_max_bytes:` — the whole-prompt refusal ceiling (§2.3, §5). */
  readonly promptMaxBytes?: number;
  /** `max_reads:` — the Read/Glob/Grep ceiling for this stage's sub-agent (§5). */
  readonly maxReads?: number;
  /** The stage's own `effort:`. Omitted ⇒ the stage file carries no effort at all. */
  readonly effort?: string;
  /** Body of `stage.md`. Defaults to one that uses every placeholder. */
  readonly stageMd?: string;
}

export interface WorkspaceOptions {
  readonly scope: string;
  readonly stages: readonly StageOptions[];
  readonly budgetUsd?: number;
  readonly slug?: string;
  readonly facts?: string;
  /** The workflow's `gates:` block — stage id -> `human | auto`. Omitted ⇒ no block. */
  readonly gates?: Readonly<Record<string, string>>;
  /** `run new --gates <value>`, exercised through `createRun` exactly as the CLI does. */
  readonly gatesFlag?: string;
  /** Extra files, keyed by path relative to the workspace root. */
  readonly files?: Readonly<Record<string, string>>;
}

export interface FacilitatorWorkspace {
  readonly root: string;
  readonly runId: string;
  readonly runDir: string;
  /** Directory holding the fake `claude`; put it first on PATH. */
  readonly binDir: string;
  readonly dispose: () => void;
}

export const DEFAULT_STAGE_MD = `# {{run}} — stage prompt

## Role
You are the stage expert.

## Objective
Produce the declared outputs for run {{run}} across repos {{repos}}.

## Inputs
(replaced by the facilitator)

## Investigate
Read only what is inlined above.

## Produce
The files listed in stage.yml, within a $\{{budget_usd}} ceiling.

## Rules
Facts on record:
{{facts}}

Conventions:
{{conventions}}

## Questions
Only about genuine gaps.

## Stop
Write the files, then stop.
`;

export function makeFacilitatorWorkspace(options: WorkspaceOptions): FacilitatorWorkspace {
  const root = mkdtempSync(join(tmpdir(), "tldrx-fac-"));
  mkdirSync(join(root, ".tldrx", "memory"), { recursive: true });
  mkdirSync(join(root, ".tldrx", "conventions"), { recursive: true });
  mkdirSync(join(root, ".tldrx", "experts", "product"), { recursive: true });
  mkdirSync(join(root, "api"), { recursive: true });
  mkdirSync(join(root, "lab"), { recursive: true });

  write(root, ".tldrx/workspace.yml", WORKSPACE_YML);
  write(root, ".tldrx/memory/facts.yml", options.facts ?? EMPTY_FACTS);
  write(root, ".tldrx/conventions/shared.md", "# Shared conventions\n\n- Done means proven.\n");
  write(root, ".tldrx/experts/product/expert.md", "# Product expert\n\nAsk about outcomes, not features.\n");
  write(root, `.tldrx/workflows/${options.scope}.yml`, workflowYaml(options));
  for (const stage of options.stages) {
    write(root, `.tldrx/stages/${stage.id}/stage.yml`, stageYaml(stage));
    write(root, `.tldrx/stages/${stage.id}/stage.md`, stage.stageMd ?? DEFAULT_STAGE_MD);
  }
  for (const [rel, content] of Object.entries(options.files ?? {})) write(root, rel, content);

  const binDir = join(root, ".fakebin");
  mkdirSync(binDir, { recursive: true });
  // Absolute paths on purpose: the tests put ONLY this directory on the child's
  // PATH, so a fake that failed to resolve could never silently fall through to
  // the real `claude` and spend real money.
  const claude = join(binDir, "claude");
  writeFileSync(
    claude,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_CLAUDE_IMPL)} "$@"\n`,
    "utf8",
  );
  chmodSync(claude, 0o755);

  const outcome = createRun({
    root,
    slug: options.slug ?? "demo",
    scope: options.scope,
    budgetUsd: options.budgetUsd,
    gates: options.gatesFlag,
    actor: "alan",
    now: new Date("2026-08-28T09:00:00Z"),
  });

  return {
    root,
    runId: outcome.runId,
    runDir: outcome.runDir,
    binDir,
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

function workflowYaml(options: WorkspaceOptions): string {
  const rows = options.stages.map((stage) => {
    const skip = stage.skipIf === undefined ? "" : `, skip_if: "${stage.skipIf}"`;
    return `  - {id: ${stage.id}, phase: "${stage.phase}", budget_usd: ${String(stage.budgetUsd)}${skip}}`;
  });
  const total = options.stages.reduce((sum, s) => sum + s.budgetUsd, 0);
  const gates = options.gates === undefined
    ? []
    : [`gates: {${Object.entries(options.gates).map(([k, v]) => `${k}: ${v}`).join(", ")}}`];
  return [
    "version: 1",
    `name: ${options.scope}`,
    `title: "Generated fixture scope"`,
    "depth: minimal",
    `default_budget_usd: ${String(options.budgetUsd ?? total)}`,
    ...gates,
    "stages:",
    ...rows,
    "",
  ].join("\n");
}

function stageYaml(stage: StageOptions): string {
  const outputs = stage.outputs ?? [];
  const lines = [
    "version: 1",
    `id: ${stage.id}`,
    `title: "Stage ${stage.id}"`,
    `phase: ${stage.phase}`,
    `experts: [${(stage.experts ?? ["product"]).join(", ")}]`,
    "stack_experts: true",
    ...numberKey("expert_knowledge_bytes", stage.expertKnowledgeBytes),
    ...numberKey("knowledge_max_bytes", stage.knowledgeMaxBytes),
    ...numberKey("inputs_max_bytes", stage.inputsMaxBytes),
    ...numberKey("prompt_max_bytes", stage.promptMaxBytes),
    ...numberKey("max_reads", stage.maxReads),
    "model: sonnet",
    ...(stage.effort === undefined ? [] : [`effort: ${stage.effort}`]),
    `budget_usd: ${String(stage.budgetUsd)}`,
    `timeout_s: ${String(stage.timeoutS ?? 60)}`,
    `dry_run_allowed: ${String(stage.dryRunAllowed ?? true)}`,
    `inputs: {required: ${list(stage.required ?? [])}, optional: ${list(stage.optional ?? [])}}`,
  ];
  if (outputs.length === 0) lines.push("outputs: []");
  else {
    lines.push("outputs:");
    for (const output of outputs) {
      const sections = output.sections === undefined ? "" : `, sections: ${list(output.sections)}`;
      lines.push(`  - {path: "${output.path}"${sections}}`);
    }
  }
  lines.push(`questions: {path: "${stage.phase}/questions.md", max: 8}`);
  lines.push(`gate: {type: ${stage.gate ?? "auto"}, approvers: 1}`);
  lines.push(`checks: ${stage.checks ?? "[]"}`);
  if (stage.preconditions !== undefined) lines.push(`preconditions: ${stage.preconditions}`);
  lines.push("");
  return lines.join("\n");
}

function numberKey(key: string, value: number | undefined): readonly string[] {
  return value === undefined ? [] : [`${key}: ${String(value)}`];
}

function list(values: readonly string[]): string {
  return `[${values.map((v) => `"${v}"`).join(", ")}]`;
}

function write(root: string, rel: string, content: string): void {
  const path = join(root, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf8");
}

/**
 * A handoff whose four sections all have content — enough to satisfy §2.3.
 *
 * Every citation here RESOLVES. It used to be three `[src: F001]` against a
 * facts.yml holding no facts at all, which the 2026-08-29 audit named as the
 * repo's own use of the shield pattern: the fixture proved the validator ran, not
 * that it checked anything. `.tldrx/workspace.yml` exists in every fixture
 * workspace, and `notes.md` exists in none of them.
 */
export function cannedHandoff(): string {
  return [
    "# Handoff",
    "",
    "## Findings",
    "- The fixture workspace declares its repos [src: .tldrx/workspace.yml:1]",
    "",
    "## Decisions",
    "- Proceed on the declared repos [src: .tldrx/workspace.yml:1]",
    "",
    "## Unknowns",
    "- none [src: absent:.tldrx/memory/notes.md]",
    "",
    "## Evidence ledger",
    "- The fake agent wrote this file [src: .tldrx/workspace.yml:1]",
    "",
  ].join("\n");
}

export function cannedIntent(): string {
  return ["# Intent", "", "## Intent", "Ship the thing.", "", "## Scope", "In: the thing. Out: everything else.", ""].join("\n");
}
