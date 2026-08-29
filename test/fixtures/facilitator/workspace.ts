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
  readonly skipIf?: string;
  readonly dryRunAllowed?: boolean;
  readonly timeoutS?: number;
  readonly experts?: readonly string[];
  /** `expert_knowledge_bytes:` — the per-expert trained-knowledge ceiling (§2.3). */
  readonly expertKnowledgeBytes?: number;
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
  return [
    "version: 1",
    `name: ${options.scope}`,
    `title: "Generated fixture scope"`,
    "depth: minimal",
    `default_budget_usd: ${String(options.budgetUsd ?? total)}`,
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
    ...(stage.expertKnowledgeBytes === undefined
      ? []
      : [`expert_knowledge_bytes: ${String(stage.expertKnowledgeBytes)}`]),
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
  lines.push("");
  return lines.join("\n");
}

function list(values: readonly string[]): string {
  return `[${values.map((v) => `"${v}"`).join(", ")}]`;
}

function write(root: string, rel: string, content: string): void {
  const path = join(root, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf8");
}

/** A handoff whose four sections all have content — enough to satisfy §2.3. */
export function cannedHandoff(): string {
  return [
    "# Handoff",
    "",
    "## Findings",
    "- The fixture ran [src: F001]",
    "",
    "## Decisions",
    "- Proceed [src: F001]",
    "",
    "## Unknowns",
    "- Nothing [src: absent:.tldrx/memory/facts.yml]",
    "",
    "## Evidence ledger",
    "- The fake agent wrote this file [src: F001]",
    "",
  ].join("\n");
}

export function cannedIntent(): string {
  return ["# Intent", "", "## Intent", "Ship the thing.", "", "## Scope", "In: the thing. Out: everything else.", ""].join("\n");
}
