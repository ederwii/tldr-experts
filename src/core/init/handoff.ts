/**
 * `.tldrx/init-handoff.md` — the Handoff step (concept §4.3), in the §2.8 shape:
 * Findings, Decisions, Unknowns, Evidence ledger, in that order, every bullet
 * ending in a `[src: …]` token.
 *
 * The handoff is the only place `init` is allowed to say what it thinks. It says
 * it in four sections a reviewer can re-run, and it separates what was MEASURED
 * (a file, a command's exit code) from what was DECIDED (a default we picked) and
 * what is still UNKNOWN (a question, or an `absent:` path).
 */
import { srcToken } from "../text/srcToken.ts";
import { plural } from "../map/plural.ts";
import { CHURN_SRC } from "../map/gitChurn.ts";
import { COMMAND_SLOTS, type DetectedWorkspace } from "../detect/types.ts";
import { gapSrc } from "../detect/gapSrc.ts";
import type { MapBullet } from "../map/MapFacts.ts";
import type { BuildMapResult } from "../map/buildMap.ts";
import type { ExpertPlan } from "./planExperts.ts";
import type { Question } from "./questions.ts";

export interface HandoffInput {
  readonly workspace: DetectedWorkspace;
  readonly map: BuildMapResult;
  readonly experts: readonly ExpertPlan[];
  readonly questions: readonly Question[];
  readonly detectedAt: string;
  readonly cliVersion: string;
  readonly methodologyGiven: string | null;
  readonly kept: readonly string[];
}

export function renderInitHandoff(input: HandoffInput): string {
  return [
    "# Handoff — init — workspace install",
    `Detected by tldrx ${input.cliVersion} · provider: ${input.map.providers.join(", ") || "none"} · ${input.detectedAt}`,
    "",
    "## Findings",
    "",
    ...findings(input).map(render),
    "",
    "## Decisions",
    "",
    ...decisions(input).map(render),
    "",
    "## Unknowns",
    "",
    ...unknowns(input).map(render),
    "",
    "## Evidence ledger",
    "",
    ...ledger(input).map(render),
    "",
  ].join("\n");
}

function render(bullet: MapBullet): string {
  return `- ${bullet.text} ${srcToken(bullet.srcs)}`;
}

function findings(input: HandoffInput): MapBullet[] {
  const bullets: MapBullet[] = [{
    text: input.workspace.mode === "multi-repo"
      ? `Multi-repo workspace: ${plural(input.workspace.repos.length, "child git repo")} under one root`
      : "Single-repo workspace: the root is the only git repo",
    srcs: [".tldrx/workspace.yml:1"],
  }];

  for (const repo of input.workspace.repos) {
    const stack = repo.stack.length > 0 ? repo.stack.join(", ") : "no stack detected";
    const known = COMMAND_SLOTS.filter((slot) => repo.commands[slot] !== null);
    const evidence = repo.evidence.find((item) => /:\d+$/.test(item.src) && item.workspaceScoped !== true);
    bullets.push({
      text: `\`${repo.name}\` (\`${repo.path}\`) — ${stack}; `
        + `${known.length}/5 commands detected; confidence ${repo.confidence}`,
      srcs: [evidence === undefined ? gapSrc(repo) : `${repo.name}:${evidence.src}`],
    });
  }

  for (const facts of input.map.facts) {
    if (facts.domains.length === 0) continue;
    bullets.push({
      text: `\`${facts.repo}\` has ${plural(facts.domains.length, "top-level source folder")}: `
        + facts.domains.slice(0, 5).join(", "),
      srcs: [`.tldrx/map/${facts.repo}/domains.md:1`],
    });
  }
  return bullets;
}

function decisions(input: HandoffInput): MapBullet[] {
  const bullets: MapBullet[] = [{
    text: `**measured** map built with the \`${input.map.providers.join(", ") || "none"}\` provider; `
      + `${input.map.files.length} documents written`,
    srcs: [".tldrx/workspace.yml:1"],
  }];

  const stackExperts = input.experts.filter((expert) => expert.kind === "stack");
  const domainExperts = input.experts.filter((expert) => expert.kind === "domain");
  bullets.push({
    text: `**inferred** seeded ${stackExperts.length} stack and ${domainExperts.length} domain experts at level 0 — `
      + "one per detected language, one per top-level source folder",
    srcs: [".tldrx/workspace.yml:1"],
  });

  bullets.push(input.methodologyGiven === null
    ? {
      text: "**assumed** `process.yml` methodology is `none` until the interview answers otherwise",
      srcs: [input.questions[0]?.id ?? "absent:.tldrx/init-questions.md"],
    }
    : {
      text: `**measured** \`process.yml\` methodology is \`${input.methodologyGiven}\`, passed with \`--process\``,
      srcs: [".tldrx/process.yml:1"],
    });

  bullets.push({
    text: "**assumed** `ticket_tool.kind` stays `none`: a connected MCP server is a suggestion, not consent",
    srcs: [".tldrx/process.yml:1"],
  });

  for (const path of input.kept) {
    bullets.push({ text: `**measured** kept the existing \`${path}\` — init never overwrites it`, srcs: [`${path}:1`] });
  }
  return bullets;
}

function unknowns(input: HandoffInput): MapBullet[] {
  const bullets: MapBullet[] = [];

  for (const repo of input.workspace.repos) {
    const missing = COMMAND_SLOTS.filter((slot) => repo.commands[slot] === null);
    if (missing.length === 0) continue;
    bullets.push({
      text: `\`${repo.name}\`: no command found for ${missing.map((slot) => `\`${slot}\``).join(", ")} — `
        + "unavailable, not absent; nobody has said which",
      srcs: [gapSrc(repo)],
    });
  }
  for (const question of input.questions) {
    bullets.push({ text: `Open: ${question.question}`, srcs: [question.id] });
  }
  if (input.questions.length === 0) {
    bullets.push({
      text: "No interview was written (`--no-interview`), so every gap above stays unrecorded",
      srcs: ["absent:.tldrx/init-questions.md"],
    });
  }
  bullets.push({
    text: "Business rules, prod behaviour and dead code cannot be detected from a filesystem",
    srcs: ["absent:.tldrx/memory/facts.yml"],
  });
  return bullets;
}

function ledger(input: HandoffInput): MapBullet[] {
  const bullets: MapBullet[] = [
    { text: "Repo layout read from the filesystem", srcs: [".tldrx/workspace.yml:1"] },
  ];

  // Only claim a command ran if it actually did: the detector records the
  // fallback as an `absent:` source, and the churn source only appears in the
  // map when `git log` exited 0.
  const branchMeasured = input.workspace.repos.some((repo) =>
    repo.evidence.some((item) => item.src.startsWith("$ git symbolic-ref")));
  bullets.push(branchMeasured
    ? { text: "Default branches read from git", srcs: ["$ git symbolic-ref refs/remotes/origin/HEAD → exit 0"] }
    : {
      text: "No repo reported an origin/HEAD; every default branch is the `main` fallback",
      srcs: ["absent:.git/refs/remotes/origin/HEAD"],
    });

  const churnRan = input.map.facts.some((facts) =>
    facts.docs.hotspots.some((bullet) => bullet.srcs.includes(CHURN_SRC)));
  if (churnRan) bullets.push({ text: "Churn and history read from git", srcs: [CHURN_SRC] });
  for (const facts of input.map.facts.slice(0, 3)) {
    bullets.push({
      text: `\`${facts.repo}\` map documents written by the \`${facts.provider}\` provider`,
      srcs: [`.tldrx/map/${facts.repo}/architecture.md:1`],
    });
  }
  return bullets;
}
