/**
 * Auto-gate condition 7 — `boundary`: did the stage stay inside the surface the
 * run declared it would touch?
 *
 * The other six conditions ask whether the artefact is sound (citations, open
 * questions, money, status) and whether the work finished (stories). None of them
 * asks the question a reviewer asks first: **is this the work we scoped?**
 *
 * Measured 2026-08-30 on run `260830-tenancy-identity-customers`: the host ran
 * this check BY HAND at every gate, because the framework does not run it
 * anywhere. Its own field notes say so — "#3 (touches outside What boundary) is
 * NOT checked anywhere — the host audited it manually at Plan and will at Build" —
 * and the run's S3 review surfaced exactly the shape it was worried about, a
 * Platform-layer file edited by a module story.
 *
 * ## The surface
 *
 * The union of what the run said it would touch, in three lines:
 *
 *   1. every `file:`-kind `[src: …]` citation in `01-what/handoff.md` and
 *      `02-how/handoff.md` — what the What and the How pointed AT;
 *   2. every `touches:` entry of every story under `03-plan/stories/`, or of
 *      `04-build/implicit-plan.yml` when the scope skipped Plan — what the plan
 *      declared it would WRITE, including the new files and the forced companions
 *      (a lockfile, a generated client) that a story listed on purpose;
 *   3. minus every path with a `tldrx-work/`, `.tldrx/` or `.agent/` segment, on
 *      BOTH sides — the framework's own state is never a boundary question
 *      (`isStatePath`, the same filter the implicit-plan derivation already
 *      applies for the same reason).
 *
 * A directory entry covers everything beneath it, so a story that declares
 * `src/features/tenancy/` has declared the files it is about to create there.
 *
 * ## The measurement
 *
 * `git diff --name-only <default_branch>...<epic_branch>`, once per repo the plan
 * names, through the `build/git.ts` seam. Nothing is checked out, nothing is
 * fetched, nothing is written. Every changed path outside the surface is NAMED —
 * capped at eight with `+N more`, never reduced to a count, because "3 paths
 * outside the surface" is not something a person can act on.
 *
 * ## What it deliberately does not do
 *
 * It does not judge whether the change was RIGHT, it does not read the diff, and
 * it does not fail on a path a story declared and did not touch. Under-delivery is
 * what the DoD and the reviewer are for; this is only about work nobody scoped.
 *
 * It also never refuses on an absence. No repo, no branch, no git, no plan — each
 * comes back as `n/a` with the reason said out loud in the note, the way
 * `storiesCondition` reports `n/a` outside Build. A condition that cannot measure
 * must not pretend it measured zero, and it must not refuse a gate for a reason
 * that has nothing to do with the boundary.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseYaml } from "../yaml.ts";
import { parseSrcToken } from "../text/srcToken.ts";
import { parseFrontMatter } from "../schemas/frontMatter.ts";
import { citedRepoPaths, isStatePath, IMPLICIT_PLAN_FILE } from "../build/implicitPlan.ts";
import { git } from "../build/git.ts";
import { loadWorkspace, repoPath, type WorkspaceContext } from "../../hooks/lib/workspace.ts";
import { BUILD_PHASE, PLAN_DIR } from "./buildProgress.ts";

/**
 * The line a Build stage's auto gate is refused on when work landed outside the
 * declared surface. Verbatim: it is what the operator reads and what the tests
 * assert, and it names WHO the decision belongs to.
 */
export const OUTSIDE_SURFACE =
  "work outside the declared surface is a boundary change — a human decides whether to widen the scope";

/** At most this many offending paths are named before the detail says "+N more". */
export const NAMED_PATHS = 8;

/** The two handoffs whose citations declare what the run is ABOUT (design §A.4). */
export const SURFACE_HANDOFFS: readonly string[] = ["01-what/handoff.md", "02-how/handoff.md"];

const STORIES_DIR = "stories";
const EPICS_DIR = "epics";

export interface BoundarySurface {
  /** repo name -> declared entries, repo-relative and POSIX. */
  readonly byRepo: ReadonlyMap<string, readonly string[]>;
  /**
   * Entries from citations that named no repo.
   *
   * `file := [repo ":"] path ":" line` makes the repo prefix OPTIONAL, and in a
   * single-repo workspace an author writes the bare form as a matter of course.
   * `citedRepoPaths` skips those, and it is right to: it feeds a developer's
   * prompt, where a wrong guess puts another repo's file in front of an agent
   * told it may edit only this one. Here the direction of the risk is inverted —
   * a citation we cannot attribute would SHRINK the surface and manufacture a
   * false refusal — so a bare path widens every repo's surface instead. Widening
   * costs a boundary exit we might have caught; narrowing costs the operator a
   * refusal that is simply wrong, which is the failure that makes a check get
   * turned off.
   */
  readonly unqualified: readonly string[];
  /** How many entries came from handoff citations, after the state filter. */
  readonly cited: number;
  /** How many came from `touches:`, after the state filter. */
  readonly declared: number;
  /** Paths dropped by the state filter, so an exclusion is never silent. */
  readonly excluded: readonly string[];
}

/** One repo of one epic: what to diff, and against what. */
export interface EpicTarget {
  readonly epic: string;
  readonly repo: string;
  readonly branch: string;
  readonly base: string;
  /** Absolute repo directory, or null when `workspace.yml` does not place it. */
  readonly dir: string | null;
}

export interface BoundaryVerdict {
  readonly ok: boolean;
  readonly detail: string;
}

/**
 * Normalise a declared or changed path to the shape both sides are compared in:
 * POSIX, no leading `./`, no trailing `/`.
 */
export function normalisePath(path: string): string {
  let out = path.trim().split("\\").join("/");
  while (out.startsWith("./")) out = out.slice(2);
  while (out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

/**
 * Is `changed` covered by `surface`?
 *
 * Equal, or beneath a declared directory. The `${entry}/` test is what makes a
 * directory entry cover its tree without making `src/foo` cover `src/foobar.ts`.
 */
export function inSurface(changed: string, surface: readonly string[]): boolean {
  const path = normalisePath(changed);
  for (const raw of surface) {
    const entry = normalisePath(raw);
    if (entry === "") continue;
    if (path === entry || path.startsWith(`${entry}/`)) return true;
  }
  return false;
}

/**
 * Bare `file:` citations — the ones `citedRepoPaths` skips because they name no
 * repo. Existence is deliberately NOT required: the repo it would be checked
 * against is the very thing the citation did not say.
 */
export function unqualifiedCitedPaths(
  handoffText: string,
  repos: ReadonlySet<string>,
): readonly string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  if (handoffText === "") return out;
  for (const line of handoffText.split("\n")) {
    const token = parseSrcToken(line, repos);
    if (token === null) continue;
    for (const ref of token.refs) {
      if (ref.kind !== "file" || ref.repo !== null) continue;
      const path = normalisePath(ref.path);
      if (path === "" || seen.has(path)) continue;
      seen.add(path);
      out.push(path);
    }
  }
  return out;
}

/** Every `<runDir>/03-plan/stories/*.md`, as `{repo, touches}`. Never throws. */
function storyTouches(runDir: string): readonly { repo: string; touches: readonly string[] }[] {
  const dir = join(runDir, PLAN_DIR, STORIES_DIR);
  if (!existsSync(dir)) return [];
  const out: { repo: string; touches: readonly string[] }[] = [];
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".md")).sort();
  } catch {
    return [];
  }
  for (const name of names) {
    const front = readFront(join(dir, name));
    if (front === null) continue;
    const repo = typeof front.repo === "string" ? front.repo : "";
    out.push({ repo, touches: stringList(front.touches) });
  }
  return out;
}

/** `04-build/implicit-plan.yml`'s one story, as `{repo, touches}`, or null. */
function implicitTouches(runDir: string): { repo: string; touches: readonly string[] } | null {
  const doc = readYaml(join(runDir, BUILD_PHASE, IMPLICIT_PLAN_FILE));
  const story = (doc as { story?: unknown } | null)?.story;
  if (story === null || typeof story !== "object") return null;
  const row = story as { repo?: unknown; touches?: unknown };
  return { repo: typeof row.repo === "string" ? row.repo : "", touches: stringList(row.touches) };
}

/**
 * The surface, from every source that declares one.
 *
 * Total by construction: a missing handoff, a missing plan, an unreadable story
 * are each simply an absence. What comes back is smaller, and the caller says so.
 */
export function deriveSurface(runDir: string, workspace: WorkspaceContext): BoundarySurface {
  const byRepo = new Map<string, string[]>();
  const unqualified: string[] = [];
  const excluded: string[] = [];
  let cited = 0;
  let declared = 0;

  const add = (repo: string, path: string, count: () => void): void => {
    const entry = normalisePath(path);
    if (entry === "") return;
    if (isStatePath(entry)) {
      if (!excluded.includes(entry)) excluded.push(entry);
      return;
    }
    count();
    if (repo === "") {
      if (!unqualified.includes(entry)) unqualified.push(entry);
      return;
    }
    const list = byRepo.get(repo) ?? [];
    if (!list.includes(entry)) list.push(entry);
    byRepo.set(repo, list);
  };

  // (1) what the What and the How pointed at.
  const repoNames = new Set(workspace.repos.keys());
  for (const rel of SURFACE_HANDOFFS) {
    const text = readText(join(runDir, rel));
    if (text === "") continue;
    for (const entry of citedRepoPaths(text, workspace)) {
      add(entry.repo, entry.path, () => { cited += 1; });
    }
    for (const path of unqualifiedCitedPaths(text, repoNames)) {
      add("", path, () => { cited += 1; });
    }
  }

  // (2) what the plan declared it would write. The real plan wins over the
  // implicit one, exactly as `buildProgress` resolves the same pair.
  const stories = storyTouches(runDir);
  const sources = stories.length > 0 ? stories : [implicitTouches(runDir)].filter((s) => s !== null);
  for (const story of sources) {
    for (const path of story.touches) {
      add(story.repo, path, () => { declared += 1; });
    }
  }

  return { byRepo, unqualified, cited, declared, excluded };
}

/**
 * Every `{repo, branch, base}` the plan says Build worked on.
 *
 * The epic file is the authority on the branch, because `openStory` cuts and
 * adopts exactly `epic.branch` — reading it here means the diff is against the
 * ref the executor actually used, not one this file re-derived. A repo comes from
 * the epic's own `repos:`, falling back to the repos its stories name.
 */
export function epicTargets(runDir: string, workspace: WorkspaceContext): readonly EpicTarget[] {
  const out: EpicTarget[] = [];
  const seen = new Set<string>();
  const push = (epic: string, repo: string, branch: string): void => {
    if (repo === "" || branch === "") return;
    const key = `${repo}\u0000${branch}`;
    if (seen.has(key)) return;
    seen.add(key);
    const rel = repoPath(workspace, repo);
    out.push({
      epic,
      repo,
      branch,
      base: workspace.defaultBranches.get(repo) ?? "main",
      dir: rel,
    });
  };

  const dir = join(runDir, PLAN_DIR, EPICS_DIR);
  if (existsSync(dir)) {
    let names: string[] = [];
    try {
      names = readdirSync(dir).filter((name) => name.endsWith(".md")).sort();
    } catch {
      names = [];
    }
    for (const name of names) {
      const front = readFront(join(dir, name));
      if (front === null) continue;
      const id = typeof front.id === "string" ? front.id : name.replace(/\.md$/, "");
      const branch = typeof front.branch === "string" ? front.branch : "";
      const repos = stringList(front.repos);
      const fallback = storyTouches(runDir).map((story) => story.repo).filter((repo) => repo !== "");
      for (const repo of repos.length > 0 ? repos : [...new Set(fallback)]) push(id, repo, branch);
    }
    if (out.length > 0) return out;
  }

  const doc = readYaml(join(runDir, BUILD_PHASE, IMPLICIT_PLAN_FILE));
  const epic = (doc as { epic?: unknown } | null)?.epic;
  if (epic !== null && typeof epic === "object") {
    const row = epic as { id?: unknown; branch?: unknown; repos?: unknown };
    const id = typeof row.id === "string" ? row.id : "E1";
    const branch = typeof row.branch === "string" ? row.branch : "";
    for (const repo of stringList(row.repos)) push(id, repo, branch);
  }
  return out;
}

export interface RepoBoundary {
  readonly target: EpicTarget;
  /** Null when the diff could not be taken; `reason` says why. */
  readonly changed: readonly string[] | null;
  readonly reason: string | null;
  /** Changed paths not covered by this repo's surface. */
  readonly outside: readonly string[];
  /** Changed paths dropped as framework state before anything was compared. */
  readonly state: readonly string[];
}

/**
 * `git diff --name-only <base>...<branch>` in one repo, with both refs verified
 * first so a missing branch is an ABSENCE rather than a git error read as a diff.
 */
export async function diffRepo(target: EpicTarget): Promise<{ changed: readonly string[] | null; reason: string | null }> {
  if (target.dir === null) return { changed: null, reason: `${target.repo} is not in .tldrx/workspace.yml` };
  if (!existsSync(target.dir)) return { changed: null, reason: `${target.repo} is not on disk` };
  for (const ref of [target.base, target.branch]) {
    const check = await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], target.dir);
    if (!check.ok) return { changed: null, reason: `\`${ref}\` does not resolve in ${target.repo}` };
  }
  const range = `${target.base}...${target.branch}`;
  const diff = await git(["diff", "--name-only", range], target.dir);
  if (!diff.ok) return { changed: null, reason: `\`git diff ${range}\` failed in ${target.repo}` };
  const changed = diff.stdout.split("\n").map(normalisePath).filter((path) => path !== "");
  return { changed, reason: null };
}

export interface BoundaryInput {
  readonly root: string;
  readonly runDir: string;
  readonly phaseId: string;
}

/** The condition, measured. `id` is added by `autoGate`. */
export async function evaluateBoundary(input: BoundaryInput): Promise<BoundaryVerdict> {
  if (input.phaseId !== BUILD_PHASE) return { ok: true, detail: "n/a (not a build stage)" };

  const workspace = loadWorkspace(input.root);
  const targets = epicTargets(input.runDir, workspace);
  if (targets.length === 0) return { ok: true, detail: "n/a (no plan naming an epic branch)" };

  const surface = deriveSurface(input.runDir, workspace);
  // `BoundarySurface.excluded` promises an exclusion is "never silent", and until
  // this line nothing read it: a `touches:` entry naming `.tldrx/` or `.agent/` was
  // dropped from the surface without appearing in any output an operator sees.
  // Appended to every verdict that HAS a surface, green and red alike — an exclusion
  // is not a failure, it is a fact about what was measured (gh #25).
  const excludedPart = surface.excluded.length === 0
    ? ""
    : `; ${String(surface.excluded.length)} state path(s) excluded from the surface: `
      + surface.excluded.slice(0, NAMED_PATHS).join(", ")
      + (surface.excluded.length > NAMED_PATHS
        ? `, +${String(surface.excluded.length - NAMED_PATHS)} more`
        : "");
  if (surface.cited + surface.declared === 0) {
    // Nothing declared a surface, so everything is outside one and nothing is.
    // Refusing here would refuse every run whose What cited no repo path, which
    // is a fact about the handoff, not about this stage's work.
    return {
      ok: true,
      detail: `n/a (the run declares no surface: no cited path, no \`touches:\`)${excludedPart}`,
    };
  }

  const repos: RepoBoundary[] = [];
  for (const target of targets) {
    const { changed, reason } = await diffRepo(target);
    if (changed === null) {
      repos.push({ target, changed: null, reason, outside: [], state: [] });
      continue;
    }
    const allowed = [...(surface.byRepo.get(target.repo) ?? []), ...surface.unqualified];
    const state = changed.filter(isStatePath);
    const product = changed.filter((path) => !isStatePath(path));
    repos.push({
      target,
      changed: product,
      reason: null,
      outside: product.filter((path) => !inSurface(path, allowed)),
      state,
    });
  }

  const measured = repos.filter((repo) => repo.changed !== null);
  if (measured.length === 0) {
    const why = repos.map((repo) => repo.reason ?? "unavailable").join("; ");
    return { ok: true, detail: `n/a (nothing could be diffed: ${why})${excludedPart}` };
  }

  const audited = measured.reduce((sum, repo) => sum + (repo.changed?.length ?? 0), 0);
  const outside = measured.flatMap((repo) => repo.outside.map((path) => `${repo.target.repo}:${path}`));
  const unread = repos.filter((repo) => repo.changed === null);
  const unreadPart = unread.length === 0
    ? ""
    : `; not diffed: ${unread.map((repo) => repo.reason ?? "unavailable").join(", ")}`;
  const range = measured.map((repo) => `${repo.target.repo} ${repo.target.base}...${repo.target.branch}`).join(", ");

  if (outside.length === 0) {
    return {
      ok: true,
      detail: `${String(audited)} changed path(s), 0 outside the surface (${range})${unreadPart}${excludedPart}`,
    };
  }
  const named = outside.slice(0, NAMED_PATHS);
  const rest = outside.length - named.length;
  return {
    ok: false,
    detail:
      `${String(audited)} changed path(s), ${String(outside.length)} outside the surface: `
      + `${named.join(", ")}${rest > 0 ? `, +${String(rest)} more` : ""}`
      + `${unreadPart}${excludedPart}; ${OUTSIDE_SURFACE}`,
  };
}

function readText(path: string): string {
  if (!existsSync(path)) return "";
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function readYaml(path: string): unknown {
  const text = readText(path);
  if (text === "") return null;
  try {
    return parseYaml(text);
  } catch {
    return null;
  }
}

/** A plan artefact's front matter as a plain mapping, or null. Never throws. */
function readFront(path: string): Record<string, unknown> | null {
  const text = readText(path);
  if (text === "") return null;
  const parsed = parseFrontMatter(text);
  const doc = parsed.doc;
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return null;
  return doc as Record<string, unknown>;
}

function stringList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}
