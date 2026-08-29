/**
 * The `static` map provider: file tree, manifests, git churn, largest files.
 *
 * It is the floor, not the fallback — it runs with nothing but git and the
 * filesystem, and every bullet it produces carries a citation a human can open.
 */
import { collectChurn, CHURN_SRC, CHURN_WINDOW_DAYS, type ChurnReport } from "./gitChurn.ts";
import { detectConventionSignals, CONVENTION_GAP_PATHS } from "./conventionSignals.ts";
import { readSourceTree, type SourceTree } from "./sourceTree.ts";
import { scanTodos } from "./todoScan.ts";
import { emptyDocs, type MapBullet, type MapFacts } from "./MapFacts.ts";
import { fileSize, plural } from "./plural.ts";
import { COMMAND_SLOTS, type DetectedRepo } from "../detect/types.ts";
import { gapSrc } from "../detect/gapSrc.ts";
import type { CommandRunner } from "../detect/CommandRunner.ts";
import type { MapContext, MapProvider } from "./Provider.ts";

const MAX_FOLDER_BULLETS = 8;
const MAX_HOTSPOT_BULLETS = 10;
const FIX_SUBJECT = /\b(fix|fixes|fixed|revert|reverts|hotfix|workaround|bug)\b/i;

export class StaticProvider implements MapProvider {
  readonly name = "static";

  constructor(private readonly runner: CommandRunner) {}

  async isAvailable(): Promise<boolean> {
    return true; // git and a filesystem are already required by `tldrx doctor`.
  }

  async collect(context: MapContext): Promise<MapFacts> {
    const { repo } = context;
    const tree = await readSourceTree(repo.absPath);
    const churn = await collectChurn(this.runner, repo.absPath);
    const docs = emptyDocs();

    docs.architecture = await this.architecture(repo, tree);
    docs.domains = this.domains(repo, tree);
    docs.conventions = await this.conventions(repo);
    docs.commands = this.commands(repo);
    docs.hotspots = this.hotspots(repo, tree, churn);
    docs.gotchas = await this.gotchas(repo, tree, churn);

    return {
      repo: repo.name,
      provider: this.name,
      docs,
      domains: tree.domainCandidates.slice(0, MAX_FOLDER_BULLETS),
    };
  }

  private async architecture(repo: DetectedRepo, tree: SourceTree): Promise<MapBullet[]> {
    const bullets: MapBullet[] = [];
    const first = tree.sourceFiles[0];

    // Greenfield (`detect/greenfield.ts` uses the same rule): there is no
    // architecture yet, and the map says so with an `absent:` source instead of
    // describing an empty tree as if it were a design.
    if (first === undefined) {
      bullets.push({
        text: "Greenfield: no code file of any known extension exists in this repo yet — "
          + "there is no architecture to describe, only one to decide",
        srcs: [`absent:${repo.path}`],
      });
      bullets.push({
        text: `${plural(tree.files.length, "non-code file")} present — docs, config and manifests only`,
        srcs: [`absent:${repo.path}`],
      });
      return bullets;
    }
    bullets.push({
      text: `${plural(tree.sourceFiles.length, "source file")} across `
        + `${plural(tree.extensions.length, "extension")}, `
        + `${plural(tree.folders.length, "top-level source folder")}`,
      srcs: [cite(repo, first.path, 1)],
    });
    for (const [extension, count] of tree.extensions.slice(0, 5)) {
      const sample = tree.sourceFiles.find((file) => file.path.endsWith(extension));
      if (sample === undefined) continue;
      bullets.push({ text: `${plural(count, `\`${extension}\` file`)}`, srcs: [cite(repo, sample.path, 1)] });
    }
    for (const evidence of repo.evidence.filter((item) => item.src.endsWith(":1") || item.src.includes("package.json"))) {
      if (!evidence.claim.startsWith("`")) {
        bullets.push({ text: evidence.claim, srcs: [prefix(repo, evidence)] });
      }
    }
    return dedupe(bullets);
  }

  private domains(repo: DetectedRepo, tree: SourceTree): MapBullet[] {
    if (tree.folders.length === 0) {
      return [{ text: "No source folders to divide into domains", srcs: [`absent:${repo.path}/src`] }];
    }
    return tree.folders.slice(0, MAX_FOLDER_BULLETS).map((folder) => ({
      text: `\`${folder.folder}/\` — ${plural(folder.fileCount, "source file")}`,
      srcs: [cite(repo, folder.sample, 1)],
    }));
  }

  private async conventions(repo: DetectedRepo): Promise<MapBullet[]> {
    const signals = await detectConventionSignals(repo.absPath);
    if (signals.length === 0) {
      return CONVENTION_GAP_PATHS.map((path) => ({
        text: `No \`${path}\` — conventions for this repo are not enforced by tooling`,
        srcs: [`absent:${repo.path === "." ? path : `${repo.path}/${path}`}`],
      }));
    }
    return signals.map((signal) => ({
      text: `${signal.what} (\`${signal.path}\`)`,
      srcs: [cite(repo, signal.path, signal.line)],
    }));
  }

  private commands(repo: DetectedRepo): MapBullet[] {
    const bullets: MapBullet[] = [];
    for (const slot of COMMAND_SLOTS) {
      const command = repo.commands[slot];
      const evidence = repo.evidence.find((item) => item.claim.startsWith(`\`${slot}\``));
      if (command === null || evidence === undefined) {
        bullets.push({
          text: `\`${slot}\`: no command found — do not invent one`,
          srcs: [gapSrc(repo)],
        });
        continue;
      }
      bullets.push({ text: `\`${slot}\` = \`${command}\`, run from \`${repo.path}\``, srcs: [prefix(repo, evidence)] });
    }
    return bullets;
  }

  private hotspots(repo: DetectedRepo, tree: SourceTree, churn: ChurnReport): MapBullet[] {
    const bullets: MapBullet[] = [];
    const known = new Set(tree.files.map((file) => file.path));

    if (!churn.ok) {
      bullets.push({ text: "Churn is unknown — `git log` did not run here", srcs: [`absent:${repo.path}/.git`] });
    } else if (churn.files.length === 0) {
      bullets.push({
        text: `No file changed in the last ${CHURN_WINDOW_DAYS} days`,
        srcs: [CHURN_SRC],
      });
    }
    for (const file of churn.files.filter((entry) => known.has(entry.path)).slice(0, MAX_HOTSPOT_BULLETS)) {
      bullets.push({
        text: `\`${file.path}\` — ${plural(file.commits, "commit")}, `
          + `+${file.added}/-${file.deleted} lines in ${CHURN_WINDOW_DAYS}d`,
        srcs: [cite(repo, file.path, 1), CHURN_SRC],
      });
    }
    for (const file of tree.largest) {
      bullets.push({
        text: `\`${file.path}\` is one of the largest source files (${fileSize(file.size)})`,
        srcs: [cite(repo, file.path, 1)],
      });
    }
    return bullets;
  }

  private async gotchas(repo: DetectedRepo, tree: SourceTree, churn: ChurnReport): Promise<MapBullet[]> {
    const bullets: MapBullet[] = [];
    const todos = await scanTodos(repo.absPath, tree.sourceFiles);

    for (const hit of todos.hits) {
      bullets.push({
        text: `${hit.marker} in \`${hit.path}\`: ${hit.text || "(no text)"}`,
        srcs: [cite(repo, hit.path, hit.line)],
      });
    }
    if (todos.hits.length === 0) {
      bullets.push({
        text: `No TODO/FIXME/HACK markers in ${plural(todos.filesScanned, "scanned source file")}`,
        srcs: [`absent:${repo.path}`],
      });
    }
    if (churn.ok && churn.commitCount > 0) {
      const fixes = churn.subjects.filter((subject) => FIX_SUBJECT.test(subject)).length;
      bullets.push({
        text: `${fixes} of ${churn.commitCount} commits in ${CHURN_WINDOW_DAYS}d are fixes, reverts or workarounds`,
        srcs: [CHURN_SRC],
      });
    }
    return bullets;
  }
}

/** A repo-prefixed `file` src (spec §2.8): `<repo>:<path>:<line>`. */
export function cite(repo: DetectedRepo, path: string, line: number): string {
  return `${repo.name}:${path}:${line}`;
}

/** Detection evidence carries a repo-relative src; prefix it unless it is a cmd/absent token. */
function prefix(repo: DetectedRepo, evidence: { src: string; workspaceScoped?: boolean }): string {
  if (evidence.workspaceScoped === true) return evidence.src;
  if (evidence.src.startsWith("$ ") || evidence.src.startsWith("absent:")) return evidence.src;
  return `${repo.name}:${evidence.src}`;
}

function dedupe(bullets: readonly MapBullet[]): MapBullet[] {
  const seen = new Set<string>();
  const out: MapBullet[] = [];
  for (const bullet of bullets) {
    if (seen.has(bullet.text)) continue;
    seen.add(bullet.text);
    out.push(bullet);
  }
  return out;
}
