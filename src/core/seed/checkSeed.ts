/**
 * `tldrx seed check <file|dir>` — the read-only seed validator (#291).
 *
 * Measured across four unattended runs in one week: whether a run finishes alone
 * or needs four rescues is decided in the seed, before `run new`. The rules that
 * decided it are mechanical, and until this command the only way to check a seed
 * was to create a run and watch it refuse — or to write a private script, which
 * is what the subagent that authored the clean seeds had to do.
 *
 * Two halves, deliberately:
 *
 *   1. **The importer's own verdict.** The seed is pushed through the SAME chain
 *      `run new --seed` runs — `collectSeeds` → `seedClaims` → `renderSeedHandoff`
 *      → `validateHandoff` — into a private temp dir that stands in for the run
 *      dir, so "would `run new` refuse this" is answered by `run new`'s code and
 *      not by a second reading of its grammar.
 *   2. **The authoring rules**, each traceable to a run that died without it:
 *      bullets under the cap, citations last and resolvable, `dod` lines that are
 *      workspace commands byte for byte with no shell separator, a `Recommended:`
 *      on every open question, `touches:` + `depends_on:` + a ```dod fence on
 *      every story, and no two stories sharing a touched file in one wave.
 *
 * Nothing here is a new derivation. The `[src:]` grammar is `srcToken.ts`, the
 * dod fence is `parseDodBlock`, the allowlist is `validateStoryDod`, the
 * separator test is `unquotedShellSeparator`, the budget split is `planBudget`
 * and the per-story caps are `caps.ts` — the check calls each and formats what
 * comes back. A finding is `file:line rule — text`; an ADVISORY is the same line
 * prefixed, and never changes the exit code: the size rule is the framework's
 * CURRENT limit (#286/#244/#280), not a law, and a person may decide otherwise.
 *
 * It creates no run, writes nothing under the workspace, and spends nothing.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractProseClaims } from "../distill/markdownClaims.ts";
import { collectSeeds, type SeedDocument, type SeedSet } from "./collectSeed.ts";
import { allSeedHeadings, seedClaims, seedHeadings, type SeedHeading } from "./seedClaims.ts";
import { renderSeedHandoff, renderSeedIndex, SEED_INDEX } from "./renderSeed.ts";
import { uncoveredSections } from "./seedCoverage.ts";
import { validateHandoff } from "../text/handoff.ts";
import {
  describeSrcFailure, diagnoseSrcToken, parseSrcToken, resolveSrc, type SrcContext,
} from "../text/srcToken.ts";
import { loadWorkspace, toSrcContext, type WorkspaceContext } from "../../hooks/lib/workspace.ts";
import { unquotedShellSeparator } from "../../hooks/lib/story.ts";
import { parseDodBlock, validateStoryDod } from "../schemas/story.ts";
import { loadWorkflowPreset, PHASE_IDS, type WorkflowPreset } from "../run/workflowPreset.ts";
import { describeHandoff, planBudget } from "../run/newRun.ts";
import { developerCap, reviewerCap, round2, type CapParts } from "../build/caps.ts";

/**
 * The bullet cap the guide states (`docs/guide/05-seeds-and-triage.md`): the
 * importer clips at `MAX_CLAIM_CHARS` (240) and a clipped bullet loses its own
 * citation, so the authoring cap sits below it with room for the token.
 */
export const MAX_SEED_BULLET_CHARS = 200;

/**
 * The size the framework carries today — a PATCH, not a craft rule. Raise both
 * when #286 (conflict resolution), #244/#289 (budgets) and #280 (dependency in
 * review) close; the advisory text names them so the number is never read as a
 * design preference.
 */
export const MAX_STORIES_PER_SEED = 4;
export const MAX_WAVES_PER_SEED = 2;
const SIZE_ISSUES = "#286/#244/#280";

export type SeedCheckRule =
  | "bullet-length" | "src-grammar" | "src-resolve"
  | "dod-separator" | "dod-command"
  | "story-id" | "story-dod" | "story-touches" | "story-depends" | "depends-unknown"
  | "wave-boundary" | "question-recommended" | "importer";

export type SeedCheckAdvisory = "size" | "waves" | "heading";

export interface SeedFinding<Rule extends string = SeedCheckRule> {
  /** Workspace-relative seed path. */
  readonly file: string;
  /** 1-based; 0 when the finding is about the document as a whole. */
  readonly line: number;
  readonly rule: Rule;
  readonly text: string;
}

export interface SeedStory {
  readonly id: string;
  readonly title: string;
  readonly file: string;
  /** Line of the `## S<n>` heading. */
  readonly line: number;
  readonly touches: readonly string[];
  readonly dependsOn: readonly string[];
  readonly dod: readonly string[];
}

export interface StageShare {
  readonly id: string;
  readonly phase: string;
  readonly attempts: number;
  /** One attempt's share, as `run new` writes it into run.yml. */
  readonly perAttemptUsd: number;
  /** What the phase holds for every attempt. */
  readonly phaseUsd: number;
}

export interface BudgetView {
  readonly scope: string;
  readonly ceilingUsd: number;
  readonly stages: readonly StageShare[];
  /** Per-story figures for the Build stage, over the seed's story count. Null when the scope runs no Build. */
  readonly build: {
    readonly storyCount: number;
    readonly attempts: number;
    readonly developerUsd: number;
    readonly reviewerUsd: number;
  } | null;
}

export interface SeedCheckOptions {
  /** Workflow preset used for the importer's stage id and for `--budget`. Default `feature`. */
  readonly scope?: string;
  /** Print the derived split for this ceiling. Absent: no budget block. */
  readonly budgetUsd?: number;
}

export interface SeedCheckReport {
  readonly source: string;
  readonly documents: readonly string[];
  readonly findings: readonly SeedFinding[];
  readonly advisories: readonly SeedFinding<SeedCheckAdvisory>[];
  readonly stories: readonly SeedStory[];
  readonly waves: number;
  readonly openQuestions: number;
  readonly budget: BudgetView | null;
  /** True when there is no finding. Advisories do not count. */
  readonly ok: boolean;
}

/** The whole check. Throws `SeedError` (from `collectSeeds`) when the path cannot be read. */
export function checkSeed(root: string, seedPath: string, options: SeedCheckOptions = {}): SeedCheckReport {
  const scope = options.scope ?? "feature";
  const seed = collectSeeds(root, [seedPath]);
  const workspace = loadWorkspace(root);
  const preset = loadWorkflowPreset(root, scope);
  const ctx = toSrcContext(workspace, null);

  const findings: SeedFinding[] = [];
  const advisories: SeedFinding<SeedCheckAdvisory>[] = [];
  const stories: SeedStory[] = [];
  let openQuestions = 0;

  for (const document of seed.documents) {
    const structure = documentStructure(document);
    openQuestions += structure.questions.length;
    checkBullets(document, structure, ctx, findings);
    const own = readStories(document, structure, workspace, findings);
    for (const story of own) stories.push(story);
  }
  // Coverage is over the whole seed set, as the importer reads it: a directory
  // seed may carry `# Intent` in one file and `# Scope` in another.
  for (const section of uncoveredSections(allSeedHeadings(seed.documents))) {
    advisories.push({
      file: seed.documents[0]?.rel ?? seed.source, line: 0, rule: "heading",
      text: `no heading covers ${section.label} — the What stage reports \`${section.output}\` as an Unknown`
        + " and may ask a person; add the heading (the guide's four)",
    });
  }

  checkDependencies(stories, findings);
  checkWaveBoundaries(stories, findings);
  const waves = waveCount(stories);

  if (stories.length > MAX_STORIES_PER_SEED) {
    advisories.push({
      file: seed.documents[0]?.rel ?? seed.source, line: 0, rule: "size",
      text: `${stories.length} stories — today the framework carries ${MAX_STORIES_PER_SEED} per run alone `
        + `(patch for ${SIZE_ISSUES} — the measured limit, not a design preference); split into two seeds or say why not`,
    });
  }
  if (waves > MAX_WAVES_PER_SEED) {
    advisories.push({
      file: seed.documents[0]?.rel ?? seed.source, line: 0, rule: "waves",
      text: `${waves} waves of dependencies — today the framework carries ${MAX_WAVES_PER_SEED} per run alone `
        + `(patch for ${SIZE_ISSUES}); a later wave waits on every earlier merge`,
    });
  }

  // The importer's verdict, ALWAYS — a second instrument on the same seed. It
  // may repeat a citation fault the per-line pass already named at its seed
  // line; that is two true sentences, and the second one is `run new`'s own
  // wording (the #275 fold note included), which is what the author will read
  // if they skip this command.
  const importer = importerVerdict(seed, preset, workspace);
  if (importer !== null) findings.push(importer);

  const budget = options.budgetUsd === undefined ? null : budgetView(preset, options.budgetUsd, stories.length);

  findings.sort(byPosition);
  return {
    source: seed.source,
    documents: seed.documents.map((d) => d.rel),
    findings, advisories, stories, waves, openQuestions, budget,
    ok: findings.length === 0,
  };
}

// --- structure ---------------------------------------------------------------

interface Bullet {
  readonly text: string;
  readonly line: number;
  readonly heading: string;
}

interface StorySection {
  readonly heading: SeedHeading;
  /** 1-based, inclusive, of the section's body. */
  readonly from: number;
  readonly to: number;
}

interface Structure {
  readonly bullets: readonly Bullet[];
  readonly questions: readonly Bullet[];
  readonly storySections: readonly StorySection[];
}

const STORIES_HEADING_RE = /^stories\b/i;
const QUESTIONS_HEADING_RE = /^open\s+questions?\b/i;
const STORY_ID_RE = /^(S\d+)\b/;

/**
 * Bullets come from the importer's own reader, so "one claim" here is exactly
 * one claim there (a hard-wrapped bullet is one, a fence is none). Headings come
 * from `seedHeadings`, which ignores fences the same way.
 */
function documentStructure(document: SeedDocument): Structure {
  const fileName = document.rel.split("/").pop() ?? document.rel;
  const bullets = extractProseClaims(document.text, { fallbackHeading: fileName });
  const headings = seedHeadings(document);
  const lineCount = document.text.split("\n").length;

  const storySections: StorySection[] = [];
  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i];
    if (heading === undefined || !STORIES_HEADING_RE.test(heading.text)) continue;
    // Every heading DEEPER than `# Stories` until the next one at its level or above.
    for (let j = i + 1; j < headings.length; j++) {
      const child = headings[j];
      if (child === undefined || child.level <= heading.level) break;
      if (child.level !== heading.level + 1) continue;
      const next = headings[j + 1];
      const end = next === undefined || next.level > child.level
        ? (nextAtOrAbove(headings, j, child.level)?.line ?? lineCount + 1) - 1
        : next.line - 1;
      storySections.push({ heading: child, from: child.line + 1, to: end });
    }
  }

  const questionHeadings = new Set(headings.filter((h) => QUESTIONS_HEADING_RE.test(h.text)).map((h) => h.text));
  const questions = bullets.filter((b) => questionHeadings.has(b.heading));
  return { bullets, questions, storySections };
}

function nextAtOrAbove(headings: readonly SeedHeading[], from: number, level: number): SeedHeading | undefined {
  for (let k = from + 1; k < headings.length; k++) {
    const candidate = headings[k];
    if (candidate !== undefined && candidate.level <= level) return candidate;
  }
  return undefined;
}

// --- bullets: length, citation grammar, citation resolution, Recommended: ------

function checkBullets(document: SeedDocument, structure: Structure, ctx: SrcContext, findings: SeedFinding[]): void {
  const raw = document.text.split("\n");
  for (const bullet of structure.bullets) {
    if (bullet.text.length > MAX_SEED_BULLET_CHARS) {
      findings.push({
        file: document.rel, line: bullet.line, rule: "bullet-length",
        text: `${bullet.text.length} characters — keep a bullet under ${MAX_SEED_BULLET_CHARS}, citation included; `
          + "the importer clips longer ones and a clipped bullet loses its own [src:]",
      });
    }
    // The citation is read off the LAST physical line of the bullet, which is
    // where the grammar says it must sit; the joined text would hide a token
    // that a continuation line pushed mid-sentence.
    const last = lastLineOf(raw, bullet.line);
    const repos = new Set(ctx.repos.keys());
    const failure = diagnoseSrcToken(last, repos);
    if (failure !== null) {
      findings.push({
        file: document.rel, line: bullet.line, rule: "src-grammar",
        text: describeSrcFailure(failure).replace(/\n\s+/g, "; "),
      });
      continue;
    }
    const token = parseSrcToken(last, repos);
    if (token === null) continue;
    for (const ref of token.refs) {
      const resolution = resolveSrc(ref, ctx, "seed", bullet.text);
      if (!resolution.ok) {
        findings.push({
          file: document.rel, line: bullet.line, rule: "src-resolve",
          text: `[src: ${ref.raw}] — ${resolution.message ?? "does not resolve"}`,
        });
      }
    }
  }
  for (const question of structure.questions) {
    if (!/\bRecommended:/.test(question.text)) {
      findings.push({
        file: document.rel, line: question.line, rule: "question-recommended",
        text: "an open question with no `Recommended: <letter> — <why>` line parks the run for a person under --questions none",
      });
    }
  }
}

/** The last physical line of the bullet that starts at `line` (1-based), as written. */
function lastLineOf(raw: readonly string[], line: number): string {
  let last = raw[line - 1] ?? "";
  for (let i = line; i < raw.length; i++) {
    const next = raw[i] ?? "";
    if (next.trim() === "" || /^\s*(?:[-*+]|\d{1,3}[.)])\s+/.test(next) || /^#{1,6}\s/.test(next) || /^\s*(?:```|~~~)/.test(next)) break;
    last = next;
  }
  return last;
}

// --- stories: id, touches, depends_on, the dod fence -------------------------

const TOUCHES_RE = /^touches:\s*(.*)$/i;
const DEPENDS_RE = /^depends_on:\s*(.*)$/i;

function readStories(
  document: SeedDocument, structure: Structure, workspace: WorkspaceContext, findings: SeedFinding[],
): readonly SeedStory[] {
  const raw = document.text.split("\n");
  const out: SeedStory[] = [];
  for (const section of structure.storySections) {
    const id = STORY_ID_RE.exec(section.heading.text)?.[1];
    if (id === undefined) {
      findings.push({
        file: document.rel, line: section.heading.line, rule: "story-id",
        text: `a story heading reads \`## S<n> — <title>\`; got \`${section.heading.text}\``,
      });
      continue;
    }
    const bullets = structure.bullets.filter((b) => b.line >= section.from && b.line <= section.to);
    const touches = listAfter(bullets, TOUCHES_RE);
    const dependsOn = listAfter(bullets, DEPENDS_RE);
    if (touches === null || touches.length === 0) {
      findings.push({
        file: document.rel, line: section.heading.line, rule: "story-touches",
        text: `${id} declares no \`- touches: <path>, <path>\` — the paths it may change, and what the wave check reads`,
      });
    }
    if (dependsOn === null) {
      findings.push({
        file: document.rel, line: section.heading.line, rule: "story-depends",
        text: `${id} declares no \`- depends_on: none\` or \`- depends_on: S<n>, S<m>\``,
      });
    }

    const slice = raw.slice(section.from - 1, section.to).join("\n");
    const dod = parseDodBlock(slice);
    const issues = validateStoryDod(dod, workspace.commands, "dod", workspace.iterationCommands, workspace.scopedTemplates);
    if (!dod.present || dod.commands.length === 0) {
      findings.push({
        file: document.rel, line: section.heading.line, rule: "story-dod",
        text: `${id}: ${issues[0]?.message ?? "no ```dod fence"} — one workspace command per line`,
      });
    } else {
      dod.commands.forEach((command, i) => {
        const line = lineOfCommand(raw, section.from, section.to, command);
        const separator = unquotedShellSeparator(command);
        if (separator !== null) {
          findings.push({
            file: document.rel, line, rule: "dod-separator",
            text: `\`${command}\` chains commands with \`${separator}\` — one workspace command per dod line, no shell`,
          });
          return;
        }
        const issue = issues.find((it) => it.path === `dod[${i}]`);
        if (issue !== undefined) {
          findings.push({ file: document.rel, line, rule: "dod-command", text: issue.message });
        }
      });
    }

    out.push({
      id, title: section.heading.text, file: document.rel, line: section.heading.line,
      touches: touches ?? [], dependsOn: (dependsOn ?? []).filter((d) => d.toLowerCase() !== "none"),
      dod: dod.commands,
    });
  }
  return out;
}

/** `- touches: a, b` → `["a", "b"]`; `- depends_on: none` → `["none"]`; absent → null. */
function listAfter(bullets: readonly Bullet[], re: RegExp): readonly string[] | null {
  for (const bullet of bullets) {
    const match = re.exec(bullet.text);
    if (match === null) continue;
    return (match[1] ?? "").split(",").map((s) => s.trim().replace(/^`|`$/g, "")).filter((s) => s.length > 0);
  }
  return null;
}

function lineOfCommand(raw: readonly string[], from: number, to: number, command: string): number {
  for (let i = from - 1; i < to && i < raw.length; i++) {
    if ((raw[i] ?? "").trim() === command) return i + 1;
  }
  return from;
}

// --- dependencies and waves --------------------------------------------------

function checkDependencies(stories: readonly SeedStory[], findings: SeedFinding[]): void {
  const ids = new Set(stories.map((s) => s.id));
  for (const story of stories) {
    for (const dep of story.dependsOn) {
      if (!ids.has(dep)) {
        findings.push({
          file: story.file, line: story.line, rule: "depends-unknown",
          text: `${story.id} depends on ${dep}, which no story in this seed declares`,
        });
      }
    }
  }
}

/**
 * Two stories that name the same touched path must be chained — one reaches the
 * other through `depends_on`, in either direction. Measured (#286): two stories
 * of one wave editing one inventory file merged into the epic as 1 conflicted
 * file, and the rescue turned it into 4.
 */
function checkWaveBoundaries(stories: readonly SeedStory[], findings: SeedFinding[]): void {
  for (let i = 0; i < stories.length; i++) {
    for (let j = i + 1; j < stories.length; j++) {
      const a = stories[i];
      const b = stories[j];
      if (a === undefined || b === undefined) continue;
      const shared = a.touches.filter((path) => b.touches.includes(path));
      if (shared.length === 0) continue;
      if (reaches(stories, a.id, b.id) || reaches(stories, b.id, a.id)) continue;
      findings.push({
        file: b.file, line: b.line, rule: "wave-boundary",
        text: `${a.id} and ${b.id} both touch \`${shared.join("`, `")}\` and neither depends on the other — `
          + "chain them with depends_on so they never share a wave (#286: one conflicted file became four)",
      });
    }
  }
}

/** True when `from` depends, directly or transitively, on `to`. */
function reaches(stories: readonly SeedStory[], from: string, to: string): boolean {
  const byId = new Map(stories.map((s) => [s.id, s]));
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length > 0) {
    const id = stack.pop() ?? "";
    if (seen.has(id)) continue;
    seen.add(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (dep === to) return true;
      stack.push(dep);
    }
  }
  return false;
}

/** The longest dependency chain, counted in stories — the waves `waves.yml` would need. */
function waveCount(stories: readonly SeedStory[]): number {
  const byId = new Map(stories.map((s) => [s.id, s]));
  const memo = new Map<string, number>();
  const depth = (id: string, trail: ReadonlySet<string>): number => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    if (trail.has(id)) return 1; // a cycle: `depends-unknown`/plan validation own it; do not loop
    const story = byId.get(id);
    if (story === undefined) return 0;
    const next = new Set(trail).add(id);
    let deepest = 0;
    for (const dep of story.dependsOn) deepest = Math.max(deepest, depth(dep, next));
    memo.set(id, deepest + 1);
    return deepest + 1;
  };
  let waves = 0;
  for (const story of stories) waves = Math.max(waves, depth(story.id, new Set()));
  return waves;
}

// --- the importer's verdict --------------------------------------------------

/**
 * Exactly what `createRun` does with a seed, into a temp dir that stands in for
 * the run dir: the index is written first (the handoff cites it) and the handoff
 * is validated against the workspace with that dir as the run-relative base.
 */
function importerVerdict(seed: SeedSet, preset: WorkflowPreset, workspace: WorkspaceContext): SeedFinding | null {
  const stage = preset.stages[0];
  const phase = stage?.phase ?? PHASE_IDS[0];
  const temp = mkdtempSync(join(tmpdir(), "tldrx-seed-check-"));
  try {
    const claims = seedClaims(seed.documents);
    const headings = allSeedHeadings(seed.documents);
    const indexPath = join(temp, ...phase.split("/"), SEED_INDEX);
    mkdirSync(join(temp, phase), { recursive: true });
    writeFileSync(indexPath, renderSeedIndex("seed-check", seed, phase), "utf8");
    const handoff = renderSeedHandoff({
      runId: "seed-check", stageId: stage?.id ?? "what", phase, at: new Date().toISOString(),
      seed, claims, headings,
    });
    const check = validateHandoff(handoff, toSrcContext(workspace, temp));
    if (check.ok) return null;
    return {
      file: seed.documents[0]?.rel ?? seed.source, line: 0, rule: "importer",
      text: "run new --seed would refuse this: "
        + describeHandoff(check.missingSections, check.emptySections, check.unsourced, check.unresolved, handoff),
    };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

// --- budget ------------------------------------------------------------------

/**
 * `planBudget` is `run new`'s split, called as is; the Build caps are `caps.ts`'s
 * own functions over a `CapParts` with no plan prices (a seed has none yet), so the
 * developer figure is the uniform share and the reviewer figure carries its floor.
 */
function budgetView(preset: WorkflowPreset, ceiling: number, storyCount: number): BudgetView {
  const plan = planBudget(preset, ceiling);
  const stages: StageShare[] = preset.stages.map((stage) => ({
    id: stage.id,
    phase: stage.phase,
    attempts: stage.attempts,
    perAttemptUsd: plan.perStage.get(stage.id) ?? 0,
    phaseUsd: plan.perPhase.get(stage.phase) ?? 0,
  }));
  const buildStage = preset.stages.find((stage) => stage.phase === PHASE_IDS[3]);
  let build: BudgetView["build"] = null;
  if (buildStage !== undefined) {
    const budgetUsd = plan.perStage.get(buildStage.id) ?? 0;
    const parts: CapParts = {
      prices: new Map(),
      storyCount: Math.max(storyCount, 1),
      budgetUsd,
      maxBudgetUsd: Math.min(budgetUsd, plan.perAgentMax),
      agentCap: (share = 1) => round2(budgetUsd * share),
      attempts: buildStage.attempts,
    };
    build = {
      storyCount: Math.max(storyCount, 1),
      attempts: buildStage.attempts,
      developerUsd: developerCap(parts),
      reviewerUsd: reviewerCap(parts, 0),
    };
  }
  return { scope: preset.name, ceilingUsd: plan.ceiling, stages, build };
}

// --- rendering ---------------------------------------------------------------

/** Line-level findings first, in file order; whole-document ones (line 0) last. */
function byPosition(a: SeedFinding, b: SeedFinding): number {
  if ((a.line === 0) !== (b.line === 0)) return a.line === 0 ? 1 : -1;
  return a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line;
}

export function renderSeedCheck(report: SeedCheckReport): string {
  const lines: string[] = [];
  for (const finding of report.findings) {
    lines.push(`${finding.file}:${String(finding.line)} ${finding.rule} — ${finding.text}`);
  }
  for (const advisory of report.advisories) {
    lines.push(`advisory: ${advisory.file}:${String(advisory.line)} ${advisory.rule} — ${advisory.text}`);
  }
  if (report.budget !== null) {
    const b = report.budget;
    lines.push(`budget $${b.ceilingUsd.toFixed(2)} over scope ${b.scope} — the split run new would write:`);
    for (const stage of b.stages) {
      lines.push(
        `  ${stage.id.padEnd(7)} ${`$${stage.perAttemptUsd.toFixed(2)}`.padStart(8)} per attempt`
          + `  (${stage.phase} holds $${stage.phaseUsd.toFixed(2)} for ${String(stage.attempts)} attempt(s))`,
      );
    }
    if (b.build !== null) {
      lines.push(
        `  per story, ${String(b.build.storyCount)} story(ies), no plan price yet: developer cap $${b.build.developerUsd.toFixed(2)}`
          + ` per attempt, reviewer cap $${b.build.reviewerUsd.toFixed(2)} (#244/#289 — a priced story gets`
          + " max(price x scale x 3, $4.00) at dispatch, scale being 1 only while the plan's prices sum inside"
          + " the stage (#281); raise --budget if the cap does not cover the largest story)",
      );
    }
  }
  const stories = report.stories.length;
  const dodLines = report.stories.reduce((sum, s) => sum + s.dod.length, 0);
  if (report.ok) {
    lines.push(
      `ok ${report.source} — ${String(stories)} story(ies), ${String(report.waves)} wave(s), `
        + `${String(report.openQuestions)} open question(s), ${String(dodLines)} dod line(s)`
        + (report.advisories.length === 0 ? "" : `, ${String(report.advisories.length)} advisory(ies)`),
    );
  } else {
    lines.push(
      `seed check: ${String(report.findings.length)} finding(s) in ${report.source}`
        + (report.advisories.length === 0 ? "" : `, ${String(report.advisories.length)} advisory(ies)`)
        + " — no run was created",
    );
  }
  return `${lines.join("\n")}\n`;
}
