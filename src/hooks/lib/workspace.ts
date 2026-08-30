/**
 * Locating the workspace from a hook payload.
 *
 * A hook gets a file path or a cwd and nothing else, so everything it needs — the
 * root, `.tldrx/`, the run folder — is derived by walking the path. No globbing,
 * no cross-file resolution beyond workspace.yml (spec §0).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { parseYaml } from "../../core/yaml.ts";
import { PROJECT_FRAMEWORK_DIR, PROJECT_WORK_DIR } from "../../core/paths.ts";
import type { SrcContext } from "../../core/text/srcToken.ts";

export interface WorkLocation {
  /** Workspace root — the parent of `tldrx-work/`. */
  readonly root: string;
  /** Absolute path of `tldrx-work/<run>/`. */
  readonly runDir: string;
  readonly run: string;
  /** Path of the touched file relative to the run dir, POSIX-separated. */
  readonly relative: string;
}

/** Split an absolute or relative path on its `tldrx-work/<run>/` segment. */
export function locateWork(filePath: string): WorkLocation | null {
  if (filePath === "") return null;
  const abs = isAbsolute(filePath) ? filePath : resolve(filePath);
  const parts = abs.split(sep);
  const at = parts.lastIndexOf(PROJECT_WORK_DIR);
  if (at === -1 || at + 1 >= parts.length) return null;
  const run = parts[at + 1] ?? "";
  if (run === "") return null;
  return {
    root: parts.slice(0, at).join(sep) || sep,
    runDir: parts.slice(0, at + 2).join(sep),
    run,
    relative: parts.slice(at + 2).join("/"),
  };
}

/** Nearest ancestor of `start` that holds a `.tldrx/` directory. */
export function findWorkspaceRoot(start: string): string | null {
  let current = isAbsolute(start) ? start : resolve(start);
  for (let i = 0; i < 64; i++) {
    if (existsSync(join(current, PROJECT_FRAMEWORK_DIR))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

export interface WorkspaceContext {
  readonly root: string;
  /** repo name -> path relative to the root. */
  readonly repos: ReadonlyMap<string, string>;
  /** Every non-null command in workspace.yml — the only ones a `cmd` src may cite. */
  readonly commands: ReadonlySet<string>;
  /**
   * repo name -> that repo's own non-null commands, in `workspace.yml` order.
   *
   * The flat `commands` set answers "may this command be cited at all?"; the Build
   * phase asks the narrower question "what may a sub-agent working in THIS repo
   * run?", and hands exactly that list to `--allowedTools`.
   */
  readonly repoCommands: ReadonlyMap<string, readonly string[]>;
  /**
   * repo name -> that repo's `commands:` map, KEYS INTACT: `{build: "dotnet
   * build", lint: "dotnet format --verify-no-changes", …}`.
   *
   * `repoCommands` above drops the keys, which is right for an allowlist — "may
   * this string be run?" does not care what it is called. It is wrong for anyone
   * asking "which of these is the lint command?": the answer is the key the human
   * wrote in `workspace.yml`, and reading it out of the command TEXT is a guess.
   * Measured 2026-08-29 on a real .NET workspace: `lint: dotnet format
   * --verify-no-changes` has no "lint" in it, so a text match found nothing and a
   * docs run was given an empty Definition of Done it should have had a command
   * for (`build/implicitPlan.ts`).
   */
  readonly commandRoles: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /** repo name -> `default_branch` — the base an epic branch is cut from (spec §2.1). */
  readonly defaultBranches: ReadonlyMap<string, string>;
  /**
   * `seed_triage.threshold_tokens` — the size at which a seed is worth splitting
   * (spec §6.2). Null when the workspace does not say, and the built-in default
   * applies. Read here rather than in the triage command so the one parse of
   * workspace.yml answers every question about it.
   */
  readonly seedTriageThresholdTokens: number | null;
}

interface RawRepo {
  readonly name?: unknown;
  readonly path?: unknown;
  readonly commands?: unknown;
  readonly default_branch?: unknown;
}

/** Spec §2.1 example; a repo whose `default_branch` is missing is assumed to use it. */
export const FALLBACK_DEFAULT_BRANCH = "main";

/** Read `.tldrx/workspace.yml`. A missing or unreadable file yields an empty context. */
export function loadWorkspace(root: string): WorkspaceContext {
  const repos = new Map<string, string>();
  const commands = new Set<string>();
  const repoCommands = new Map<string, readonly string[]>();
  const commandRoles = new Map<string, ReadonlyMap<string, string>>();
  const defaultBranches = new Map<string, string>();
  let seedTriageThresholdTokens: number | null = null;
  const empty = (): WorkspaceContext => ({
    root, repos, commands, repoCommands, commandRoles, defaultBranches, seedTriageThresholdTokens,
  });
  const path = join(root, PROJECT_FRAMEWORK_DIR, "workspace.yml");
  if (!existsSync(path)) return empty();
  let doc: unknown;
  try {
    doc = parseYaml(readFileSync(path, "utf8"));
  } catch {
    return empty();
  }
  const triage = (doc as { seed_triage?: unknown } | null)?.seed_triage;
  if (triage !== null && typeof triage === "object") {
    const tokens = (triage as { threshold_tokens?: unknown }).threshold_tokens;
    if (typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0) {
      seedTriageThresholdTokens = tokens;
    }
  }
  const list = (doc as { repos?: unknown } | null)?.repos;
  if (!Array.isArray(list)) return empty();
  for (const entry of list as RawRepo[]) {
    if (typeof entry?.name !== "string") continue;
    repos.set(entry.name, typeof entry.path === "string" ? entry.path : ".");
    defaultBranches.set(
      entry.name,
      typeof entry.default_branch === "string" && entry.default_branch !== ""
        ? entry.default_branch
        : FALLBACK_DEFAULT_BRANCH,
    );
    const own: string[] = [];
    const roles = new Map<string, string>();
    const cmds = entry.commands;
    if (cmds !== null && typeof cmds === "object") {
      for (const [role, value] of Object.entries(cmds as Record<string, unknown>)) {
        if (typeof value !== "string" || value.trim() === "") continue;
        commands.add(value);
        roles.set(role, value);
        if (!own.includes(value)) own.push(value);
      }
    }
    repoCommands.set(entry.name, own);
    commandRoles.set(entry.name, roles);
  }
  return empty();
}

/**
 * `runDir` is the absolute `tldrx-work/<run>/` folder of the handoff about to be
 * validated. Passing it lets a bare `01-what/intent.md:1` resolve run-relatively
 * as well as workspace-relatively (spec §2.8) — every caller that knows the run
 * dir must pass it, or `next`, `approve` and the hook disagree about the same file.
 */
export function toSrcContext(workspace: WorkspaceContext, runDir?: string | null): SrcContext {
  return {
    root: workspace.root,
    repos: workspace.repos,
    commands: workspace.commands,
    runDir: runDir ?? null,
  };
}

/** Absolute path of a repo declared in workspace.yml, or null. */
export function repoPath(workspace: WorkspaceContext, name: string): string | null {
  const rel = workspace.repos.get(name);
  return rel === undefined ? null : join(workspace.root, rel);
}

export function factsPath(root: string): string {
  return join(root, PROJECT_FRAMEWORK_DIR, "memory", "facts.yml");
}

export function stageYamlPath(root: string, stage: string): string {
  return join(root, PROJECT_FRAMEWORK_DIR, "stages", stage, "stage.yml");
}

/** Every `tldrx-work/<run>/` directory that has a run.yml, newest folder name first. */
export function listRunDirs(root: string): readonly string[] {
  const work = join(root, PROJECT_WORK_DIR);
  if (!existsSync(work)) return [];
  const dirs: string[] = [];
  for (const entry of readdirSync(work)) {
    const dir = join(work, entry);
    if (existsSync(join(dir, "run.yml")) && statSync(dir).isDirectory()) dirs.push(dir);
  }
  return dirs.sort().reverse();
}
