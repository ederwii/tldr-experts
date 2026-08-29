/**
 * `tldrx init` — the install loop, run once against the whole workspace
 * (concept §4): detect -> map -> handoff -> interview -> seed experts ->
 * conventions.
 *
 * Deterministic: filesystem and `git` only. No LLM, no network, no build. Every
 * document it writes is validated before it is written, and every claim it makes
 * carries a `[src: …]` token a reviewer can open.
 *
 * Re-runnable: detection output is regenerated, human-owned files are kept.
 */
import { join, relative, resolve } from "node:path";
import { detectWorkspace } from "../detect/detectWorkspace.ts";
import { toPosix } from "../detect/walk.ts";
import { detectConventionSignals } from "../map/conventionSignals.ts";
import { buildMap, type BuildMapResult } from "../map/buildMap.ts";
import { GraphifyProvider } from "../map/GraphifyProvider.ts";
import { StaticProvider } from "../map/StaticProvider.ts";
import { McpProbe, type McpServer } from "../doctor/McpProbe.ts";
import { stringifyYaml } from "../yaml.ts";
import { CONVENTIONS_DIR, renderRepoConventions, renderSharedConventions } from "./conventions.ts";
import { FACTS_FILE, FACTS_HEADER, buildFactsDocument, validateFactsDocument } from "./factsDocument.ts";
import { renderInitHandoff } from "./handoff.ts";
import { planExperts, type ExpertPlan } from "./planExperts.ts";
import { buildProcessDocument } from "./processDocument.ts";
import { QUESTIONS_FILE, planQuestions, renderQuestions, type Question } from "./questions.ts";
import { seedExperts } from "./seedExperts.ts";
import { buildWorkspaceDocument } from "./workspaceDocument.ts";
import { formatIssues, validateProcessDocument, validateWorkspaceDocument } from "./validateEmitted.ts";
import { writeAmbientFootprint } from "./ambientFootprint.ts";
import { WriteLog } from "./writeFile.ts";
import type { CommandRunner } from "../detect/CommandRunner.ts";
import type { MapProvider } from "../map/Provider.ts";
import type { DetectedWorkspace } from "../detect/types.ts";
import type { InitOptions } from "./InitOptions.ts";

export const WORKSPACE_FILE = ".tldrx/workspace.yml";
export const PROCESS_FILE = ".tldrx/process.yml";
export const HANDOFF_FILE = ".tldrx/init-handoff.md";

export interface InitDependencies {
  readonly runner: CommandRunner;
  readonly cliVersion: string;
  readonly now: Date;
  /** Injected so tests never spawn `claude mcp list`. */
  readonly probeMcp?: () => Promise<readonly McpServer[]>;
}

export interface InitReport {
  readonly workspace: DetectedWorkspace;
  readonly map: BuildMapResult;
  readonly experts: readonly ExpertPlan[];
  readonly questions: readonly Question[];
  readonly written: readonly string[];
  readonly created: readonly string[];
  readonly kept: readonly string[];
}

export async function runInit(options: InitOptions, deps: InitDependencies): Promise<InitReport> {
  const root = resolve(options.root);
  const out = resolve(options.out);
  const workspace = await detectWorkspace(root, deps.runner);

  if (workspace.repos.length === 0) {
    throw new Error(
      `no git repo at ${root}: init needs the root to be a repo, or to contain child repos.\n`
      + "Run `git init` at the root (a docs-only root is fine) and try again.",
    );
  }

  const log = new WriteLog();
  const timestamp = rfc3339(deps.now);
  const mcpServers = options.mcp ? await probe(deps) : [];

  const map = await buildMap({
    workspace,
    workspaceDir: out,
    providers: chooseProviders(options, deps.runner),
  });
  await writeWorkspaceFile({ workspace, root, out, map, mcpServers, timestamp, deps, log });

  const questions = options.interview ? planQuestions({
    workspace,
    processGiven: options.methodology !== null,
    mcpServers,
  }) : [];

  const experts = planExperts(workspace, map.facts);
  await seedExperts({ outDir: out, plans: experts, createdAt: timestamp, log });
  await writeConventions(workspace, out, log);
  await writeProcess(options, deps, questions, timestamp, out, log);
  await writeFacts(out, log);

  if (options.interview) {
    await log.createIfAbsent(
      join(out, QUESTIONS_FILE), QUESTIONS_FILE, renderQuestions(questions, timestamp),
    );
  }

  await log.overwrite(join(out, HANDOFF_FILE), HANDOFF_FILE, renderInitHandoff({
    workspace, map, experts, questions,
    detectedAt: timestamp,
    cliVersion: deps.cliVersion,
    methodologyGiven: options.methodology,
    kept: log.paths("kept"),
  }));

  await writeAmbientFootprint(out, log);

  return {
    workspace, map, experts, questions,
    written: [...map.files, ...log.paths("written")],
    created: log.paths("created"),
    kept: log.paths("kept"),
  };
}

/** graphify first when it is on PATH, static otherwise (spec §5 decision (b)). */
export function chooseProviders(options: InitOptions, runner: CommandRunner): MapProvider[] {
  const staticProvider = new StaticProvider(runner);
  if (options.provider === "static") return [staticProvider];
  return [new GraphifyProvider(runner, staticProvider), staticProvider];
}

interface WorkspaceWriteInput {
  readonly workspace: DetectedWorkspace;
  readonly root: string;
  readonly out: string;
  readonly map: BuildMapResult;
  readonly mcpServers: readonly McpServer[];
  readonly timestamp: string;
  readonly deps: InitDependencies;
  readonly log: WriteLog;
}

async function writeWorkspaceFile(input: WorkspaceWriteInput): Promise<void> {
  const document = buildWorkspaceDocument({
    workspace: input.workspace,
    root: input.root === input.out ? "." : toPosix(relative(input.out, input.root)) || input.root,
    detectedAt: input.timestamp,
    cliVersion: input.deps.cliVersion,
    provider: input.map.providers.join(", ") || "none",
    mcpServers: input.mcpServers,
  });
  const validation = validateWorkspaceDocument(document);
  if (!validation.ok) throw new Error(formatIssues(WORKSPACE_FILE, validation));

  await input.log.overwrite(
    join(input.out, WORKSPACE_FILE), WORKSPACE_FILE,
    "# Written by `tldrx init` (spec §2.1). Detection result: which repos exist, their\n"
    + "# stack, and the ONLY commands the DoD gate and the map may run. Regenerated on\n"
    + "# every `tldrx init`; hand edits to detected values are overwritten.\n"
    + stringifyYaml(document),
  );
}

async function writeConventions(
  workspace: DetectedWorkspace,
  out: string,
  log: WriteLog,
): Promise<void> {
  await log.createIfAbsent(
    join(out, CONVENTIONS_DIR, "shared.md"), `${CONVENTIONS_DIR}/shared.md`, renderSharedConventions(),
  );
  for (const repo of workspace.repos) {
    const signals = await detectConventionSignals(repo.absPath);
    await log.createIfAbsent(
      join(out, CONVENTIONS_DIR, `${repo.name}.md`), `${CONVENTIONS_DIR}/${repo.name}.md`,
      renderRepoConventions(repo, signals),
    );
  }
}

async function writeProcess(
  options: InitOptions,
  deps: InitDependencies,
  questions: readonly Question[],
  timestamp: string,
  out: string,
  log: WriteLog,
): Promise<void> {
  const document = buildProcessDocument({
    methodology: options.methodology,
    approver: await gitUserName(deps.runner, options.root),
    when: timestamp,
    questionId: questions.find((question) => question.area === "process")?.id ?? null,
  });
  const validation = validateProcessDocument(document);
  if (!validation.ok) throw new Error(formatIssues(PROCESS_FILE, validation));

  await log.createIfAbsent(
    join(out, PROCESS_FILE), PROCESS_FILE,
    "# Written by `tldrx init` (spec §2.12). The team's way of working as DATA, never\n"
    + "# assumed. Changing methodology means editing this file and nothing else.\n"
    + stringifyYaml(document),
  );
}

async function writeFacts(out: string, log: WriteLog): Promise<void> {
  const document = buildFactsDocument();
  const validation = validateFactsDocument(document);
  if (!validation.ok) throw new Error(formatIssues(FACTS_FILE, validation));
  await log.createIfAbsent(join(out, FACTS_FILE), FACTS_FILE, FACTS_HEADER + stringifyYaml(document));
}

async function probe(deps: InitDependencies): Promise<readonly McpServer[]> {
  if (deps.probeMcp !== undefined) return deps.probeMcp();
  const result = await new McpProbe().probe();
  return result.servers;
}

/** `approvers` must be non-empty (spec §2.12); git knows who is sitting here. */
async function gitUserName(runner: CommandRunner, cwd: string): Promise<string> {
  const result = await runner.run(["git", "config", "user.name"], cwd);
  const name = result.stdout.trim();
  return result.exitCode === 0 && name !== "" ? name : "owner";
}

export function rfc3339(now: Date): string {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z");
}
