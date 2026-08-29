/**
 * MapFacts -> the six markdown documents (concept §4.2).
 *
 * Deliberately timestamp-free: `map --refresh` on an unchanged tree must produce
 * a zero-line diff, so a rerun is proof that nothing moved rather than noise.
 * Every bullet ends with its `[src: …]` token — that is the format's whole point.
 */
import { srcToken } from "./srcToken.ts";
import { GRAPHIFY_SRC } from "./GraphifyProvider.ts";
import type { MapBullet, MapDoc, MapFacts } from "./MapFacts.ts";
import { gapSrc } from "../detect/gapSrc.ts";
import type { DetectedRepo, DetectedWorkspace } from "../detect/types.ts";

const TITLES: Readonly<Record<MapDoc, string>> = {
  architecture: "Architecture",
  domains: "Domains",
  conventions: "Conventions",
  commands: "Commands",
  hotspots: "Hotspots",
  gotchas: "Gotchas",
};

const SUBTITLES: Readonly<Record<MapDoc, string>> = {
  architecture: "What this repo is built from, measured from the files on disk.",
  domains: "Top-level source folders — candidates for a domain, not confirmed boundaries.",
  conventions: "Conventions with a config file behind them. A convention nothing enforces is not listed.",
  commands: "The only commands `tldrx` may run in this repo (mirror of `workspace.yml`).",
  hotspots: "Where the code actually changes, and the biggest files.",
  gotchas: "What the code and its history admit about themselves.",
};

export function renderMapDoc(facts: MapFacts, doc: MapDoc): string {
  const lines: string[] = [
    `# ${TITLES[doc]} — ${facts.repo}`,
    "",
    `> ${SUBTITLES[doc]}`,
    `> Provider: \`${facts.provider}\`. Written by \`tldrx map\`; edits are overwritten on refresh.`,
    "",
  ];
  const bullets = facts.docs[doc];
  if (bullets.length === 0) {
    lines.push(`- Nothing detected for this document ${srcToken([`absent:${facts.repo}`])}`);
  }
  for (const bullet of bullets) lines.push(renderBullet(bullet));
  lines.push("");
  return lines.join("\n");
}

export function renderBullet(bullet: MapBullet): string {
  return `- ${bullet.text} ${srcToken(bullet.srcs)}`;
}

/** `map/workspace.md` — multi-repo only (spec §1). */
export function renderWorkspaceMap(
  workspace: DetectedWorkspace,
  facts: readonly MapFacts[],
): string {
  const lines: string[] = [
    "# Workspace map",
    "",
    `> ${workspace.repos.length} repos under one root. Shared: memory, experts, stages, workflows.`,
    "> Per repo: `map/<repo>/`, `conventions/<repo>.md`.",
    "",
    "## Repos",
    "",
  ];
  for (const repo of workspace.repos) {
    lines.push(renderBullet(repoBullet(repo)));
  }
  lines.push("", "## Cross-repo signals", "");
  for (const bullet of crossRepoBullets(workspace, facts)) lines.push(renderBullet(bullet));
  lines.push("");
  return lines.join("\n");
}

function repoBullet(repo: DetectedRepo): MapBullet {
  const stack = repo.stack.length > 0 ? repo.stack.join(", ") : "stack unknown";
  const src = repo.evidence.find((item) => /:\d+$/.test(item.src) && item.workspaceScoped !== true);
  return {
    text: `\`${repo.name}\` at \`${repo.path}\` — ${stack}; default branch \`${repo.defaultBranch}\`; `
      + `detection confidence ${repo.confidence}`,
    srcs: [src === undefined ? gapSrc(repo) : `${repo.name}:${src.src}`],
  };
}

function crossRepoBullets(workspace: DetectedWorkspace, facts: readonly MapFacts[]): MapBullet[] {
  const bullets: MapBullet[] = [];
  const generated = workspace.repos.filter((repo) => repo.commands.build !== null && repo.stack.includes("typescript"));
  if (generated.length > 1) {
    bullets.push({
      text: `${generated.length} TypeScript repos build independently — a shared DTO change is a multi-repo change`,
      srcs: generated.slice(0, 2).map((repo) => `${repo.name}:package.json:1`),
    });
  }
  const lowConfidence = workspace.repos.filter((repo) => repo.confidence === "low");
  for (const repo of lowConfidence) {
    bullets.push({
      text: `\`${repo.name}\` detection is low confidence — its commands are unknown until someone answers`,
      srcs: [gapSrc(repo)],
    });
  }
  const providers = [...new Set(facts.map((item) => item.provider))].sort();
  const usedGraphify = providers.some((name) => name.startsWith("graphify"));
  bullets.push({
    text: `Map provider(s) used: ${providers.join(", ") || "none"}`,
    srcs: [usedGraphify ? GRAPHIFY_SRC : "absent:.tldrx/graphify-out"],
  });
  return bullets;
}
