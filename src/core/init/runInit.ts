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
import { basename } from "node:path";
import { detectWorkspace } from "../detect/detectWorkspace.ts";
import { isGreenfield } from "../detect/greenfield.ts";
import { repoSlug } from "../detect/repoSlug.ts";
import { toPosix } from "../detect/walk.ts";
import { detectConventionSignals } from "../map/conventionSignals.ts";
import { buildMap, type BuildMapResult } from "../map/buildMap.ts";
import { GraphifyProvider } from "../map/GraphifyProvider.ts";
import { StaticProvider } from "../map/StaticProvider.ts";
import { McpProbe, type McpServer } from "../doctor/McpProbe.ts";
import { plural } from "../map/plural.ts";
import { silentSteps, type StepReporter } from "../ui/steps.ts";
import { stringifyYaml } from "../yaml.ts";
import { CONVENTIONS_DIR, renderRepoConventions, renderSharedConventions } from "./conventions.ts";
import { FACTS_FILE, FACTS_HEADER, buildFactsDocument, validateFactsDocument } from "./factsDocument.ts";
import { renderInitHandoff } from "./handoff.ts";
import { planExperts, type ExpertPlan } from "./planExperts.ts";
import { buildProcessDocument, PROCESS_HEADER } from "./processDocument.ts";
import { gitUserName } from "./gitUserName.ts";
import { QUESTIONS_FILE, planQuestions, renderQuestions, type Question } from "./questions.ts";
import { seedExperts } from "./seedExperts.ts";
import { buildWorkspaceDocument } from "./workspaceDocument.ts";
import { formatIssues, validateProcessDocument, validateWorkspaceDocument } from "./validateEmitted.ts";
import { writeAmbientFootprint } from "./ambientFootprint.ts";
import { WriteLog } from "./writeFile.ts";
import type { CommandRunner } from "../detect/CommandRunner.ts";
import type { MapProvider } from "../map/Provider.ts";
import type { DetectedRepo, DetectedWorkspace } from "../detect/types.ts";
import { COMMAND_SLOTS } from "../detect/types.ts";
import type { InitOptions } from "./InitOptions.ts";
import { PROJECT_WORKSPACE_FILE } from "../paths.ts";

/**
 * Kept under this name for every existing import site; the STRING is
 * `paths.ts`'s `PROJECT_WORKSPACE_FILE` (#92), so the path an operator is told
 * to edit is spelled in exactly one place.
 */
export const WORKSPACE_FILE = PROJECT_WORKSPACE_FILE;
export const PROCESS_FILE = ".tldrx/process.yml";
export const HANDOFF_FILE = ".tldrx/init-handoff.md";

export interface InitDependencies {
  readonly runner: CommandRunner;
  readonly cliVersion: string;
  readonly now: Date;
  /** Injected so tests never spawn `claude mcp list`. */
  readonly probeMcp?: () => Promise<readonly McpServer[]>;
  /**
   * Where the live per-step lines go. Omitted means `silentSteps()` — which is
   * what every test and every non-interactive caller wants, and what the CLI
   * installs for `--quiet` and `--ui off`.
   */
  readonly steps?: StepReporter;
}

export interface InitReport {
  readonly workspace: DetectedWorkspace;
  /** `workspace.yml mode: greenfield` — no code anywhere yet (`detect/greenfield.ts`). */
  readonly greenfield: boolean;
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
  const steps = deps.steps ?? silentSteps();

  const detecting = steps.begin("detecting repos");
  const workspace = await detectWorkspace(root, deps.runner, {
    repoStart: (name) => { detecting.tick(name); },
    repoDone: (repo) => { detecting.note(describeRepo(repo)); },
  });

  if (workspace.repos.length === 0) {
    detecting.fail(`no git repo at ${root}`);
    throw new Error(
      `no git repo at ${root}: init needs the root to be a repo, or to contain child repos.\n`
      + "Run `git init` at the root (a docs-only root is fine) and try again.",
    );
  }
  detecting.done(
    `${workspace.mode} — ${plural(workspace.repos.length, "repo")}: `
    + workspace.repos.map((repo) => repo.name).join(", "),
  );

  const log = new WriteLog();
  const timestamp = rfc3339(deps.now);
  const mcpServers = await probeServers(options, deps, steps);

  // Where the wall time goes. Measured 2026-08-30 on a five-repo workspace:
  // 36.0 s with `--provider auto` (graphify runs once per repo) against 1.3 s
  // with `--provider static` — so ~97% of an `init` is this one loop, and it is
  // the reason the whole command used to look hung.
  const mapping = steps.begin("building the code map");
  const map = await buildMap({
    workspace,
    workspaceDir: out,
    providers: chooseProviders(options, deps.runner),
    progress: {
      repoStart: (repo) => { mapping.tick(`${repo}…`); },
      repoDone: (repo, provider, documents) => {
        mapping.note(`${repo} — ${plural(documents, "document")} via ${provider}`);
      },
      repoSkipped: (repo) => { mapping.note(`${repo} — no provider available, skipped`); },
    },
  });
  mapping.done(
    `${plural(map.files.length, "map document")} via ${map.providers.join(", ") || "no provider"}`,
  );

  const writingWorkspace = steps.begin(`writing ${WORKSPACE_FILE}`);
  await writeWorkspaceFile({ workspace, root, out, map, mcpServers, timestamp, deps, log });
  writingWorkspace.done(
    `${WORKSPACE_FILE} — ${plural(workspace.repos.length, "repo")}, `
    + `${plural(countCommands(workspace), "gate command")}`,
  );

  const planning = steps.begin("planning the interview");
  const questions = options.interview ? planQuestions({
    workspace,
    processGiven: options.methodology !== null,
    mcpServers,
    stackGiven: options.stack.length > 0,
  }) : [];
  planning.done(options.interview
    ? `${plural(questions.length, "question")} detection could not answer`
    : "skipped (--no-interview)");

  const seeding = steps.begin("seeding experts");
  const experts = planExperts(workspace, map.facts, {
    declaredLanguages: options.stack,
    project: repoSlug(basename(root)),
  });
  for (const plan of experts) seeding.tick(plan.name);
  await seedExperts({ outDir: out, plans: experts, createdAt: timestamp, log });
  seeding.done(`${plural(experts.length, "expert")} at level 0`);

  const conventions = steps.begin("reading conventions");
  await writeConventions(workspace, out, log, (repo) => { conventions.tick(repo); });
  conventions.done(`${plural(workspace.repos.length + 1, "convention file")} under ${CONVENTIONS_DIR}/`);

  const recording = steps.begin("writing the process and facts files");
  await writeProcess(options, deps, questions, timestamp, out, log);
  await writeFacts(out, log);
  recording.done(`${PROCESS_FILE}, ${FACTS_FILE}`);

  if (options.interview) {
    const asking = steps.begin(`writing ${QUESTIONS_FILE}`);
    const outcome = await log.createIfAbsent(
      join(out, QUESTIONS_FILE), QUESTIONS_FILE, renderQuestions(questions, timestamp),
    );
    asking.done(`${QUESTIONS_FILE} — ${outcome}`);
  }

  const handing = steps.begin(`writing ${HANDOFF_FILE}`);
  await log.overwrite(join(out, HANDOFF_FILE), HANDOFF_FILE, renderInitHandoff({
    workspace, map, experts, questions,
    detectedAt: timestamp,
    cliVersion: deps.cliVersion,
    methodologyGiven: options.methodology,
    kept: log.paths("kept"),
  }));
  handing.done(HANDOFF_FILE);

  const ambient = steps.begin("updating .gitignore and CLAUDE.md");
  await writeAmbientFootprint(out, log);
  ambient.done(".gitignore, CLAUDE.md — one marked block each");

  return {
    workspace, map, experts, questions,
    greenfield: isGreenfield(workspace),
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
  onRepo: (repo: string) => void = () => undefined,
): Promise<void> {
  await log.createIfAbsent(
    join(out, CONVENTIONS_DIR, "shared.md"), `${CONVENTIONS_DIR}/shared.md`, renderSharedConventions(),
  );
  for (const repo of workspace.repos) {
    onRepo(repo.name);
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
    join(out, PROCESS_FILE), PROCESS_FILE, PROCESS_HEADER + stringifyYaml(document),
  );
}

async function writeFacts(out: string, log: WriteLog): Promise<void> {
  const document = buildFactsDocument();
  const validation = validateFactsDocument(document);
  if (!validation.ok) throw new Error(formatIssues(FACTS_FILE, validation));
  await log.createIfAbsent(join(out, FACTS_FILE), FACTS_FILE, FACTS_HEADER + stringifyYaml(document));
}

/**
 * `--mcp` only. It health-checks every configured server, so it is the one
 * optional step that can be slower than the map — and the only one a person can
 * turn off by not asking for it.
 */
async function probeServers(
  options: InitOptions,
  deps: InitDependencies,
  steps: StepReporter,
): Promise<readonly McpServer[]> {
  if (!options.mcp) return [];
  const step = steps.begin("probing MCP servers");
  const servers = await probe(deps);
  step.done(`${plural(servers.length, "MCP server")} configured`);
  return servers;
}

async function probe(deps: InitDependencies): Promise<readonly McpServer[]> {
  if (deps.probeMcp !== undefined) return deps.probeMcp();
  const result = await new McpProbe().probe();
  return result.servers;
}

/** `mobile — typescript, react, expo · medium confidence · main`. */
export function describeRepo(repo: DetectedRepo): string {
  const stack = repo.stack.length > 0 ? repo.stack.join(", ") : "stack unknown";
  return `${repo.name} — ${stack} · ${repo.confidence} confidence · ${repo.defaultBranch}`;
}

/**
 * How many of the five command slots detection actually filled, across every
 * repo. This is the number that decides whether a DoD gate can run at all, so
 * it is worth saying out loud next to the file that records it.
 */
export function countCommands(workspace: DetectedWorkspace): number {
  let filled = 0;
  for (const repo of workspace.repos) {
    for (const slot of COMMAND_SLOTS) if (repo.commands[slot] !== null) filled += 1;
  }
  return filled;
}


export function rfc3339(now: Date): string {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z");
}
