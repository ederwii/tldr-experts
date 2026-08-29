/**
 * The `graphify` map provider.
 *
 * Runs exactly two documented commands and nothing else:
 *   `graphify --version`                        (the probe `env.yml` declares)
 *   `graphify update <path> --no-cluster`       (`graphify --help`: "re-extract
 *                                                code files … (no LLM needed)",
 *                                                "--no-cluster … raw extraction only")
 * No flag here was invented. The LLM stages of graphify's pipeline are never
 * invoked: `tldrx init` is deterministic and offline.
 *
 * graphify writes its own `graphify-out/` beside the path it was given, so the
 * graph is copied into `.tldrx/graphify-out/<repo>/graph.json` and read from
 * there. Spec §1 says a root install writes nothing into its sibling repos, so
 * a `graphify-out/` this run CREATED is removed again afterwards; one that was
 * already there is left alone and reused (it is the user's, and it makes
 * graphify's incremental update fast). `[assumption]`
 *
 * Structure comes from the graph; commands, conventions and churn still come
 * from the static provider, because graphify does not produce them.
 */
import { join } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { summariseGraph, type GraphSummary } from "./graphJson.ts";
import { emptyDocs, MAP_DOCS, type MapBullet, type MapDoc, type MapFacts } from "./MapFacts.ts";
import { cite } from "./StaticProvider.ts";
import type { CommandRunner } from "../detect/CommandRunner.ts";
import type { MapContext, MapProvider } from "./Provider.ts";

export const GRAPH_FILE = "graph.json";
/** The `[src: …]` payload for a claim that rests on the extraction run itself. */
export const GRAPHIFY_SRC = "$ graphify update --no-cluster → exit 0";

export class GraphifyProvider implements MapProvider {
  readonly name = "graphify";

  constructor(
    private readonly runner: CommandRunner,
    private readonly base: MapProvider,
  ) {}

  async isAvailable(context: MapContext): Promise<boolean> {
    const probe = await this.runner.run(["graphify", "--version"], context.repo.absPath);
    return probe.exitCode === 0;
  }

  async collect(context: MapContext): Promise<MapFacts> {
    const facts = await this.base.collect(context);
    const summary = await this.buildGraph(context);
    if (summary === null) return { ...facts, provider: `${this.name} (graph unavailable, static facts only)` };

    const docs = cloneDocs(facts);
    docs.architecture = [...this.architecture(context, summary), ...docs.architecture];
    docs.domains = [...docs.domains, ...this.domains(context, summary)];
    return { ...facts, provider: this.name, docs };
  }

  /** Run graphify, then read whichever graph.json it produced. `null` = no usable graph. */
  private async buildGraph(context: MapContext): Promise<GraphSummary | null> {
    await mkdir(context.outDir, { recursive: true });
    const repoOut = join(context.repo.absPath, "graphify-out");
    const repoOutExisted = await Bun.file(join(repoOut, GRAPH_FILE)).exists();

    await this.runner.run(["graphify", "update", context.repo.absPath, "--no-cluster"], context.repo.absPath);

    const workspaceCopy = join(context.outDir, GRAPH_FILE);
    const text = await firstReadable([
      join(repoOut, GRAPH_FILE),
      join(context.outDir, "graphify-out", GRAPH_FILE),
      workspaceCopy,
    ]);
    if (text !== null) await Bun.write(workspaceCopy, text);
    if (!repoOutExisted) await rm(repoOut, { recursive: true, force: true });
    if (text === null) return null;

    try {
      return summariseGraph(JSON.parse(text) as unknown);
    } catch {
      return null;
    }
  }

  private architecture(context: MapContext, summary: GraphSummary): MapBullet[] {
    const bullets: MapBullet[] = [{
      text: `graphify extracted ${summary.nodeCount} nodes and ${summary.edgeCount} edges from this repo`,
      srcs: [GRAPHIFY_SRC],
    }];
    for (const [relation, count] of summary.relations.slice(0, 3)) {
      bullets.push({ text: `${count} \`${relation}\` edges`, srcs: [GRAPHIFY_SRC] });
    }
    for (const hub of summary.hubs.slice(0, 5)) {
      bullets.push({
        text: `\`${hub.label}\` is a hub — ${hub.degree} connections`,
        srcs: srcsFor(context, hub.sourceFile, hub.sourceLine, hub.id),
      });
    }
    return bullets;
  }

  private domains(context: MapContext, summary: GraphSummary): MapBullet[] {
    return summary.hubs.slice(0, 3).map((hub) => ({
      text: `\`${hub.label}\` connects ${hub.degree} other nodes — a domain boundary candidate`,
      srcs: srcsFor(context, hub.sourceFile, hub.sourceLine, hub.id),
    }));
  }
}

/** Text of the first path that exists, or null. */
async function firstReadable(paths: readonly string[]): Promise<string | null> {
  for (const path of paths) {
    const file = Bun.file(path);
    if (await file.exists()) return file.text();
  }
  return null;
}

function srcsFor(
  context: MapContext,
  sourceFile: string | null,
  sourceLine: number | null,
  nodeId: string,
): string[] {
  const graph = `graph:${nodeId}`;
  if (sourceFile === null) return [graph];
  return [cite(context.repo, sourceFile, sourceLine ?? 1), graph];
}

function cloneDocs(facts: MapFacts): Record<MapDoc, MapBullet[]> {
  const out = emptyDocs();
  for (const doc of MAP_DOCS) out[doc] = [...facts.docs[doc]];
  return out;
}
