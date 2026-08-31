/**
 * Build `.tldrx/map/**` for every detected repo.
 *
 * The provider list is a preference order: the first one that reports available
 * for a repo runs it. Which one ran is recorded — in the document header, in
 * `workspace.yml`, and in the init handoff — because a reader must be able to
 * tell a graph-derived claim from a file-tree-derived one.
 */
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { MAP_DOCS, type MapFacts } from "./MapFacts.ts";
import { renderMapDoc, renderWorkspaceMap } from "./renderMap.ts";
import type { MapContext, MapProvider } from "./Provider.ts";
import { runtime } from "../runtime/index.ts";
import type { DetectedWorkspace } from "../detect/types.ts";

export const MAP_DIR = ".tldrx/map";
export const GRAPHIFY_OUT_DIR = ".tldrx/graphify-out";

/**
 * Optional progress callbacks.
 *
 * This loop is where `tldrx init` spends nearly all of its wall time — measured
 * 2026-08-30 on a five-repo workspace, 36.0 s in total with `--provider auto`
 * against 1.3 s with `--provider static`, because `graphify update` runs once
 * per repo. A caller with a person waiting on it says which repo is in the
 * provider right now; a caller without one passes nothing.
 */
export interface MapProgress {
  readonly repoStart?: (repo: string) => void;
  readonly repoDone?: (repo: string, provider: string, documents: number) => void;
  /** No provider reported available for this repo, so nothing was written. */
  readonly repoSkipped?: (repo: string) => void;
}

export interface BuildMapOptions {
  readonly workspace: DetectedWorkspace;
  /** Absolute directory that holds `.tldrx/`. */
  readonly workspaceDir: string;
  /** Preference order; the first available provider wins per repo. */
  readonly providers: readonly MapProvider[];
  readonly progress?: MapProgress;
}

export interface BuildMapResult {
  readonly facts: readonly MapFacts[];
  /** Providers that actually ran, sorted and deduplicated. */
  readonly providers: readonly string[];
  /** Files written, workspace-relative. */
  readonly files: readonly string[];
}

export async function buildMap(options: BuildMapOptions): Promise<BuildMapResult> {
  const facts: MapFacts[] = [];
  const files: string[] = [];

  const progress = options.progress ?? {};
  for (const repo of options.workspace.repos) {
    const context: MapContext = {
      repo,
      outDir: join(options.workspaceDir, GRAPHIFY_OUT_DIR, repo.name),
      root: options.workspace.root,
    };
    progress.repoStart?.(repo.name);
    const provider = await firstAvailable(options.providers, context);
    if (provider === null) {
      progress.repoSkipped?.(repo.name);
      continue;
    }

    const collected = await provider.collect(context);
    facts.push(collected);

    const repoDir = join(options.workspaceDir, MAP_DIR, repo.name);
    await mkdir(repoDir, { recursive: true });
    for (const doc of MAP_DOCS) {
      const path = join(repoDir, `${doc}.md`);
      await runtime.writeText(path, renderMapDoc(collected, doc));
      files.push(`${MAP_DIR}/${repo.name}/${doc}.md`);
    }
    progress.repoDone?.(repo.name, collected.provider, MAP_DOCS.length);
  }

  if (options.workspace.mode === "multi-repo") {
    const path = join(options.workspaceDir, MAP_DIR, "workspace.md");
    await mkdir(join(options.workspaceDir, MAP_DIR), { recursive: true });
    await runtime.writeText(path, renderWorkspaceMap(options.workspace, facts));
    files.push(`${MAP_DIR}/workspace.md`);
  }

  return {
    facts,
    providers: [...new Set(facts.map((item) => item.provider))].sort(),
    files,
  };
}

async function firstAvailable(
  providers: readonly MapProvider[],
  context: MapContext,
): Promise<MapProvider | null> {
  for (const provider of providers) {
    if (await provider.isAvailable(context)) return provider;
  }
  return null;
}
