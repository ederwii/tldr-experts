/**
 * A minimal workspace for the run-lifecycle tests.
 *
 * Deliberately NOT the hooks fixture: that one ships a half-finished run, and
 * these tests need a workspace where the only runs are the ones they create.
 * `api/` and `lab/` exist so workspace.yml's repo paths resolve; the commands are
 * `true` and `false` so a `cmd` check can pass or fail without a toolchain.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FRAMEWORK_ROOT } from "../../src/core/paths.ts";

export const FIXTURE_AIDLC_INTENT = join(FRAMEWORK_ROOT, "test", "fixtures", "aidlc-intent");

export const WORKSPACE_YML = `version: 1
mode: multi-repo
root_is_repo: true
detected_at: 2026-08-28T14:02:11Z
detected_by: "tldrx 0.1.0"
repos:
  - name: api
    path: api
    default_branch: main
    stack: [dotnet]
    package_manager: nuget
    commands: {build: "true", test: "false", lint: null, typecheck: null, run: null}
    ci: []
    confidence: high
  - name: lab
    path: lab
    default_branch: main
    stack: [typescript]
    package_manager: npm
    commands: {build: "true", test: "true", lint: null, typecheck: null, run: null}
    ci: []
    confidence: high
`;

export const EMPTY_FACTS = "version: 1\nfacts: []\n";

export interface TempRunWorkspace {
  readonly root: string;
  readonly dispose: () => void;
}

export interface WorkspaceOptions {
  /** Contents of `.tldrx/memory/facts.yml`. Defaults to an empty file. */
  readonly facts?: string;
  /** Extra files, keyed by path relative to the root. */
  readonly files?: Readonly<Record<string, string>>;
}

export function makeRunWorkspace(options: WorkspaceOptions = {}): TempRunWorkspace {
  const root = mkdtempSync(join(tmpdir(), "tldrx-run-"));
  mkdirSync(join(root, ".tldrx", "memory"), { recursive: true });
  mkdirSync(join(root, "api"), { recursive: true });
  mkdirSync(join(root, "lab"), { recursive: true });
  writeFileSync(join(root, ".tldrx", "workspace.yml"), WORKSPACE_YML, "utf8");
  writeFileSync(join(root, ".tldrx", "memory", "facts.yml"), options.facts ?? EMPTY_FACTS, "utf8");
  for (const [rel, content] of Object.entries(options.files ?? {})) {
    const path = join(root, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content, "utf8");
  }
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

/** A one-stage scope whose gate check is a real command from workspace.yml. */
export function gatedScope(command: string, repo = "api"): Readonly<Record<string, string>> {
  return {
    ".tldrx/workflows/gated.yml": `version: 1
name: gated
title: "One stage, one cmd check"
depth: minimal
default_budget_usd: 5
stages: [{id: gated, phase: "01-what", budget_usd: 5}]
`,
    ".tldrx/stages/gated/stage.yml": `version: 1
id: gated
title: "A gated stage"
phase: 01-what
experts: [product]
model: sonnet
budget_usd: 5
timeout_s: 30
inputs: {required: [], optional: []}
outputs: []
gate: {type: approve, approvers: 1}
checks: [{id: cmd, on: post-write, repo: ${repo}, command: "${command}", expect_exit: 0}]
`,
  };
}
