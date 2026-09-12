/**
 * Build ENTRY, measured in a FRESH WORKTREE (#254).
 *
 * The base pre-flight (`preflight.ts`, #41) deliberately measures in the human's
 * checkout: that tree has `node_modules`, the build cache and the tool state that
 * make a gate command mean what the team thinks it means. The price of that
 * choice is that a green there proves the OWNER's tree can run the gate — not
 * that the tree a story is written in can.
 *
 * Measured on a live workspace, 2026-09-12, tldrx 0.16.1: **18 h from `run auto`
 * to the first story that could run**, five relaunches, two of them environment
 * and both invisible here. The repo's `install:` named `./install.sh`, which
 * existed in the checkout and was **untracked** — `git worktree add` carries
 * TRACKED FILES ONLY, so the install failed identically in every story's tree
 * while the same command was green where the pre-flight had measured. And a DoD
 * command named a binary the worktree never had. Each was discovered per story,
 * after `openStory`, at the point the paid turn was about to start.
 *
 * So this file asks ONE question at Build entry, once, before `agent.spawned`:
 * *can a fresh worktree of the base sha install and reach the commands the
 * Definition of Done names?* Two halves, deliberately different mechanisms:
 *
 *   - **The free half** — the `install:` command's own first token, when it names
 *     a path. `git ls-files` decides, nothing is executed, and the refusal names
 *     the path and the `git add` that fixes it. This half is sound WITHOUT a
 *     worktree because of when the install runs: nothing has installed anything
 *     yet, so a relative path the install NAMES cannot be a path the install
 *     PRODUCED. It is a file somebody forgot to commit, and there is no other
 *     reading.
 *   - **The measured half** — one throwaway detached worktree at the base sha,
 *     the declared `install:` run inside it, and then a RESOLUTION of each
 *     declared DoD command's first token in that tree. Never the suite: the base
 *     pre-flight already measures the suite in the checkout, and paying for it
 *     twice on every Build entry is a cost nobody asked for.
 *
 * **Why the DoD's untracked paths are NOT refused by `git ls-files` (the
 * dangerous direction).** A DoD command may legitimately name something the
 * install CREATES — `node_modules/.bin/vitest` is the ordinary case, and it is
 * untracked in every repo on earth. Refusing it would block a whole run, before a
 * cent is spent, over a file that was always going to be there. A refusal of
 * entry is cheap when it is right and very expensive when it is wrong, so the
 * rule here is: for a DoD command, tracked-ness decides NOTHING. The install runs
 * first, in that tree, and only a token still unresolvable AFTER it refuses. When
 * the checkout happens to hold that same path untracked, the refusal says so as
 * ADVICE — the verdict is the measurement, never the advice.
 *
 * **How a token is resolved**: exactly the way `runDodCommand` will spawn it, and
 * for that reason only. A token with a `/` is resolved against the tree; a bare
 * name is looked up on `PATH`, because `runtime.spawn` passes no `env` and node
 * and bun both `execvp` it. A resolution this file does differently from the
 * spawn would be a refusal of something that would have worked.
 */
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { PROJECT_FRAMEWORK_DIR } from "../paths.ts";
import { WORKTREES } from "./plan.ts";
import { addDetachedWorktree, git, removeWorktree, repoDirOf, shaOf } from "./git.ts";
import { DodCommandRefused, isAllowedDodCommand, runDodCommand, splitArgv } from "../../hooks/lib/story.ts";
import { INSTALL_SLOT, installCommandFor } from "./worktreeDeps.ts";
import {
  PREFLIGHT_RED_TTL_MS, WORKSPACE_FILE, commandHash, type BaseStatus, type WorktreeProbeRow,
} from "./preflight.ts";
import { FALLBACK_DEFAULT_BRANCH, type WorkspaceContext } from "../../hooks/lib/workspace.ts";
import type { PlannedStory } from "./plan.ts";
import type { BuildRefusal, SerialWrite } from "./outcome.ts";
import type { PreflightCache } from "./dodRunner.ts";

/**
 * Exported markers, because a bare English word false-positives on innocent
 * prose and §8 asks the assertion to be able to fail for the right reason.
 */
export const UNTRACKED_INSTALL_MARKER = "names a path git does not track";
export const WORKTREE_UNREACHABLE_MARKER = "cannot run in a fresh worktree";

/**
 * The first token of a command WHEN IT NAMES A PATH INSIDE THE REPO.
 *
 * `null` for everything a tree cannot answer for: a command the argv splitter
 * will not split at all (it is refused elsewhere, with its own sentence), a bare
 * name (`npm`, `vitest` — `PATH`, not the tree), an absolute path (the host's,
 * and the same in every tree), and anything reaching outside the repo with `..`.
 */
export function repoPathToken(command: string): string | null {
  const head = splitArgv(command)?.[0];
  if (head === undefined || head === "") return null;
  if (!head.includes("/")) return null;
  if (isAbsolute(head)) return null;
  const rel = head.startsWith("./") ? head.slice(2) : head;
  if (rel === "" || rel.startsWith("../")) return null;
  return rel;
}

/** `git ls-files --error-unmatch` exit 0 — the one reading `detect/skills.ts` already uses. */
export async function isTracked(repoDir: string, rel: string): Promise<boolean> {
  return (await git(["ls-files", "--error-unmatch", "--", rel], repoDir)).ok;
}

/** Is this an executable file? Used for both halves of the resolution. */
function runnable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where `runDodCommand`'s spawn would find this command's binary, run from
 * `tree` — or `null` when it would find nothing and exit 127.
 *
 * `PATH` is read from `process.env` because that is precisely what the child
 * inherits: `runtime.spawn` passes no `env` for a DoD command, so the lookup this
 * function does and the lookup `execvp` does are the same lookup.
 */
export function resolveHead(command: string, tree: string): string | null {
  const head = splitArgv(command)?.[0];
  if (head === undefined || head === "") return null;
  if (head.includes("/")) {
    const abs = isAbsolute(head) ? head : join(tree, head);
    return runnable(abs) ? abs : null;
  }
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (dir === "") continue;
    const abs = join(dir, head);
    if (runnable(abs)) return abs;
  }
  return null;
}

/** `.tldrx/worktrees/<repo>/<run>-_entry-probe` — thrown away in a `finally`. */
export function entryProbePath(root: string, repo: string, runId: string): string {
  return join(root, PROJECT_FRAMEWORK_DIR, WORKTREES, repo, `${runId}-_entry-probe`);
}

/** What `entryProbeRefusal` needs, as DATA the executor owns: no `ctx`, no session. */
export interface EntryProbeParts {
  readonly workspace: WorkspaceContext;
  readonly cache: PreflightCache;
  readonly root: string;
  readonly runId: string;
  readonly at: string;
  readonly timeoutMs: number;
  readonly write: SerialWrite;
  readonly advisories: string[];
  /** The executor's own report lines — the cost of the probe is written here. */
  readonly lines: string[];
}

/** What one repo declares that this gate can ask a fresh tree about. */
interface RepoDeclaration {
  readonly repo: string;
  /** The `install:` command, or null when the repo declares none. */
  readonly install: string | null;
  /** Every pending story's DoD commands, deduplicated, in first-seen order. */
  readonly dod: readonly string[];
}

/** The declarations of every repo a PENDING story belongs to, repo order stable. */
export function declarationsOf(
  workspace: WorkspaceContext, stories: readonly PlannedStory[],
): readonly RepoDeclaration[] {
  const byRepo = new Map<string, string[]>();
  for (const planned of stories) {
    const list = byRepo.get(planned.story.repo) ?? [];
    for (const command of planned.dod.commands) if (!list.includes(command)) list.push(command);
    byRepo.set(planned.story.repo, list);
  }
  return [...byRepo].map(([repo, dod]) => ({ repo, install: installCommandFor(workspace, repo), dod }));
}

/**
 * What the row was measured UNDER: the install, every DoD command probed, and the
 * whole workspace allowlist — through `commandHash`, the one hash this repo has
 * for "a declared command plus what it was allowed to run" (§7).
 */
export function declarationHash(decl: RepoDeclaration, workspace: WorkspaceContext): string {
  return commandHash(JSON.stringify([decl.install, [...decl.dod].sort()]), [...workspace.commands]);
}

/**
 * How long a worktree probe — GREEN OR RED — may stand before it is measured
 * again.
 *
 * The base pre-flight gives a green no TTL at all, and it is right to: a green
 * there is a statement about a tree, and the tree is pinned by its sha. This row
 * is not that. It is a statement about an ENVIRONMENT — the host's `PATH`, the
 * package registry the install reached, a toolchain somebody upgraded at lunch —
 * and none of that is in the sha. #162 is the twin failure in the other
 * direction (a red measured over a broken environment that kept refusing); the
 * inverse is worse, because a stale GREEN spends money: it waves a run through
 * into an environment that has since stopped working, which is the exact
 * 18-hour failure this file exists to end.
 *
 * Six hours: long enough that a run resumed across a working day never re-pays
 * the install, short enough that yesterday's environment never answers for
 * today's. A run that outlives it re-measures — which is the correct answer for
 * a run that has been going that long.
 */
export const WORKTREE_PROBE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * The cached row for this repo, or `null` for "measure it".
 *
 * Three things narrow it and all three are load-bearing: the BASE SHA (a
 * measurement of a tree that has moved is a measurement of another tree), the
 * DECLARATION HASH (the operator's fix is an edit to `.tldrx/workspace.yml`, and
 * that edit must not be invisible to the cache — the mistake #162's sibling
 * already made once), and AGE (above).
 */
export function worktreeProbeFor(
  rows: readonly WorktreeProbeRow[] | undefined,
  repo: string,
  baseSha: string,
  freshness: { readonly declarationHash: string; readonly at: string },
): WorktreeProbeRow | null {
  for (const row of rows ?? []) {
    if (row.repo !== repo) continue;
    if (baseSha !== "" && row.baseSha !== "" && row.baseSha !== baseSha) continue;
    if (row.declarationHash !== undefined && row.declarationHash !== freshness.declarationHash) continue;
    if (olderThanTtl(row.checkedAt ?? "", freshness.at, ttlFor(row.status))) continue;
    return row;
  }
  return null;
}

/**
 * A RED is trusted for far less time than a GREEN, and the asymmetry is the
 * point — it is the same asymmetry the base pre-flight draws, for the same two
 * reasons pointing in opposite directions.
 *
 * A red blocks every story in the plan and tells the operator to go fix their
 * environment, so the cache has to be willing to notice that they did: #162 is
 * the filed failure where a row measured over a broken environment kept
 * refusing after it was fixed. `PREFLIGHT_RED_TTL_MS` is that window and it is
 * REUSED, not re-derived (§7).
 */
function ttlFor(status: BaseStatus): number {
  return status === "failed" ? PREFLIGHT_RED_TTL_MS : WORKTREE_PROBE_TTL_MS;
}

/** Both clocks come from the caller; an unreadable clock makes nothing stale. */
function olderThanTtl(measuredAt: string, at: string, ttlMs: number): boolean {
  if (measuredAt === "" || at === "") return false;
  const then = Date.parse(measuredAt);
  const now = Date.parse(at);
  if (!Number.isFinite(then) || !Number.isFinite(now)) return false;
  return now - then > ttlMs;
}

// --- what the operator reads ------------------------------------------------

/** The free half's refusal: nothing ran, and nothing needed to. */
export function untrackedInstallLines(repo: string, command: string, rel: string): readonly string[] {
  return [
    `[tldrx] build: the \`${INSTALL_SLOT}:\` command for repo ${repo} ${UNTRACKED_INSTALL_MARKER} — `
      + `\`${command}\` starts with \`${rel}\`, which is in your checkout and absent from \`git ls-files\`. `
      + "Every story is written in a fresh `git worktree`, which carries TRACKED FILES ONLY, so this "
      + "install would fail identically in every one of them — once per story, each time after the "
      + "story was opened and just before a developer turn was paid for.",
    `  · \`git add ${rel}\` in ${repo} and commit it, or point \`${INSTALL_SLOT}:\` in ${WORKSPACE_FILE} `
      + "at something tracked.",
    "Nothing was dispatched and nothing was charged.",
  ];
}

/** The measured half's refusal, from the row that was written down. */
export function worktreeProbeLines(row: WorktreeProbeRow): readonly string[] {
  const at = row.baseSha === "" ? "" : ` (${row.baseSha})`;
  return [
    `[tldrx] build: the Definition of Done ${WORKTREE_UNREACHABLE_MARKER} of repo ${row.repo} — measured `
      + `in a throwaway worktree of \`${row.baseRef}\`${at}, which is the tree every story is written in:`,
    `  · ${row.tail}`,
    ...(row.advice === undefined ? [] : [`  · ${row.advice}`]),
    `Fix ${WORKSPACE_FILE} (or the base tree), then run \`tldrx next\` again. `
      + "Nothing was dispatched and nothing was charged.",
  ];
}

// --- the gate ---------------------------------------------------------------

/**
 * Build entry's worktree question, asked once per repo, cached beside the base
 * result — or `null` when every repo's fresh tree can install and reach its gate.
 *
 * **When it does nothing at all.** A repo that declares no `install:` AND whose
 * DoD names no path — every head a bare name, resolved on `PATH`, which a
 * worktree does not change — has nothing a fresh tree could answer differently.
 * No worktree is created and nothing is written down: the gate is free in
 * exactly the case where it could learn nothing.
 */
export async function entryProbeRefusal(
  parts: EntryProbeParts, stories: readonly PlannedStory[],
): Promise<BuildRefusal | null> {
  for (const decl of declarationsOf(parts.workspace, stories)) {
    let repoDir: string;
    try {
      repoDir = repoDirOf(parts.workspace, decl.repo);
    } catch {
      continue;   // a repo the workspace does not declare: no evidence, not a verdict
    }
    // Only commands the gate would actually RUN are probed. One it declines
    // (undeclared, or needing a shell) is refused elsewhere, in its own words, and
    // a second differently-worded veto for the same condition is how one fault
    // gets two names.
    const dod = decl.dod.filter((command) =>
      isAllowedDodCommand(command, parts.workspace.commands) && splitArgv(command) !== null);

    // The FREE half first: it costs nothing, it needs no worktree, and it gives
    // the operator the better sentence when it fires.
    if (decl.install !== null) {
      const rel = repoPathToken(decl.install);
      if (rel !== null && existsSync(join(repoDir, rel)) && !(await isTracked(repoDir, rel))) {
        return {
          lines: [...untrackedInstallLines(decl.repo, decl.install, rel)],
          error: `the \`${INSTALL_SLOT}:\` command for ${decl.repo} ${UNTRACKED_INSTALL_MARKER}: \`${rel}\``,
        };
      }
    }
    // NOTHING A TREE COULD ANSWER DIFFERENTLY. With no `install:` declared and
    // every DoD head a bare name, the resolution below is a `PATH` lookup, and
    // `PATH` is the same in a worktree as in the checkout — where the base
    // pre-flight has already RUN the command, which is the stronger measurement.
    // So no worktree is opened and nothing is written down: this gate costs
    // exactly zero in the case where it could learn exactly nothing.
    const needsTree = decl.install !== null || dod.some((command) => repoPathToken(command) !== null);
    if (!needsTree) continue;

    const baseRef = parts.workspace.defaultBranches.get(decl.repo) ?? FALLBACK_DEFAULT_BRANCH;
    const baseSha = await shaOf(repoDir, baseRef);
    const hash = declarationHash(decl, parts.workspace);
    const cached = worktreeProbeFor(parts.cache.read().worktree, decl.repo, baseSha, {
      declarationHash: hash, at: parts.at,
    });
    const row = cached ?? await measureWorktree(parts, decl, dod, repoDir, baseRef, baseSha, hash);
    if (cached === null) {
      await parts.write(() => {
        const advisory = parts.cache.rememberWorktree(row, parts.at);
        if (advisory !== null) parts.advisories.push(advisory);
      });
    }
    if (row.status === "failed") {
      return {
        lines: [...worktreeProbeLines(row)],
        error: `the Definition of Done of ${decl.repo} ${WORKTREE_UNREACHABLE_MARKER}: ${row.tail}`,
      };
    }
  }
  return null;
}

/**
 * One repo, measured: a detached worktree at the base sha, the install inside it,
 * then the resolution of each DoD command's head in that tree.
 *
 * The worktree is removed in a `finally`, on every path including a throw, and
 * the removal is best-effort: a tree that will not go away is an advisory, never
 * a reason to fail a Build that is otherwise fine.
 */
async function measureWorktree(
  parts: EntryProbeParts,
  decl: RepoDeclaration,
  dod: readonly string[],
  repoDir: string,
  baseRef: string,
  baseSha: string,
  declarationHash: string,
): Promise<WorktreeProbeRow> {
  const started = Date.now();
  const dir = entryProbePath(parts.root, decl.repo, parts.runId);
  // A tree left behind by a killed run is not evidence of anything; take it away
  // before asking git for a new one at the same path.
  if (existsSync(dir)) await removeWorktree(repoDir, dir);
  const base = baseSha === "" ? baseRef : baseSha;
  const stamp = (row: Omit<WorktreeProbeRow, "repo" | "baseRef" | "baseSha" | "declarationHash" | "durationMs">)
    : WorktreeProbeRow => ({
      repo: decl.repo, baseRef, baseSha, declarationHash, durationMs: Date.now() - started, ...row,
    });
  try {
    await addDetachedWorktree(repoDir, dir, base);
  } catch (error) {
    // git could not give us the tree. NOTHING was learned about the environment,
    // so nothing is claimed about it: `unmeasured` refuses nothing and excuses
    // nothing, the same third case the base pre-flight already has (#165).
    return stamp({
      status: "unmeasured", timedOut: false,
      tail: `no worktree of \`${baseRef}\` could be opened at ${dir}: `
        + `${error instanceof Error ? error.message : String(error)}`,
    });
  }
  try {
    if (decl.install !== null) {
      let installed;
      try {
        installed = await runDodCommand(decl.install, dir, parts.timeoutMs, parts.workspace.commands);
      } catch (error) {
        if (!(error instanceof DodCommandRefused)) throw error;
        // The gate would not run it. That is the DoD allowlist's refusal, not
        // this gate's finding — no exit code is invented for a thing that never
        // ran (#165), and the probe reports that it learned nothing.
        return stamp({ status: "unmeasured", timedOut: false, tail: error.message, refusedBecause: error.message });
      }
      const exitCode = installed.timedOut ? 124 : installed.exitCode;
      if (exitCode !== 0 || installed.timedOut) {
        const rel = repoPathToken(decl.install);
        return stamp({
          status: "failed", exitCode, timedOut: installed.timedOut, installCommand: decl.install,
          tail: `\`${decl.install}\` (the \`${INSTALL_SLOT}:\` command) exited ${String(exitCode)}`
            + `${installed.timedOut ? " (timed out)" : ""} in the fresh worktree — ${installed.tail}`,
          ...(rel === null || existsSync(join(dir, rel)) ? {} : {
            advice: `\`${rel}\` is not in that tree. A worktree carries tracked files only: `
              + `\`git add ${rel}\` in ${decl.repo} if your checkout has it.`,
          }),
        });
      }
    }
    // AFTER the install, and only after it: a DoD command may legitimately name
    // something the install produced, and probing before it would refuse exactly
    // the case that was always going to work.
    for (const [index, command] of dod.entries()) {
      if (resolveHead(command, dir) !== null) continue;
      const rel = repoPathToken(command);
      const head = splitArgv(command)?.[0] ?? command;
      // THE SECOND WAY TO REFUSE SOMETHING THAT WOULD HAVE WORKED, and the
      // cheaper half of the same lesson. A dod list runs in order, so a command
      // after the first may name an artefact an EARLIER dod command builds —
      // `dod: ["npm run build", "dist/check.sh"]` is the ordinary shape, and the
      // base pre-flight is honestly green on it because it runs the whole list in
      // the checkout. This probe deliberately runs no suite, so it never built
      // that artefact and cannot tell "nobody committed it" from "the command
      // before it makes it". Undecidable ⇒ ADVISORY, not a verdict.
      //
      // A BARE head is not downgraded at any index: it resolves on `PATH`, and no
      // dod command can put a binary on this process's `PATH`, so an absence
      // there means the same thing wherever it sits in the list.
      if (rel !== null && index > 0) {
        parts.advisories.push(
          `build: \`${command}\` (repo ${decl.repo}) names \`${head}\`, which is not in a fresh worktree `
          + `after \`${decl.install ?? "no install:"}\` — not refused, because an earlier \`dod\` command `
          + "may build it. If it is a file your checkout never committed, `git add` it.",
        );
        continue;
      }
      const untrackedHere = rel !== null && existsSync(join(repoDir, rel)) && !(await isTracked(repoDir, rel));
      return stamp({
        status: "failed", timedOut: false, installCommand: decl.install ?? undefined,
        tail: `\`${command}\` cannot start: \`${head}\` resolves to nothing in that tree`
          + `${decl.install === null ? "" : ` even after \`${decl.install}\` ran there`}`
          + " — the command would exit 127 without running.",
        // ADVICE, never the verdict: the verdict above is the measurement.
        ...(untrackedHere
          ? { advice: `Your checkout HAS \`${rel}\` and git does not track it — \`git add ${rel}\` in `
              + `${decl.repo} and commit it.` }
          : rel === null
            ? { advice: `\`${head}\` is not on this process's PATH either. Install it, or declare an `
                + `\`${INSTALL_SLOT}:\` under ${decl.repo}'s \`commands:\` that puts it in the tree.` }
            : {}),
      });
    }
    return stamp({
      status: "ok", exitCode: 0, timedOut: false, installCommand: decl.install ?? undefined,
      tail: decl.install === null
        ? `every declared command's binary resolves in a fresh worktree of \`${baseRef}\``
        : `\`${decl.install}\` exited 0 in a fresh worktree of \`${baseRef}\` and every declared `
          + "command's binary resolves there",
    });
  } finally {
    const removed = await removeWorktree(repoDir, dir);
    if (!removed) parts.advisories.push(`the Build-entry probe worktree at ${dir} could not be removed`);
    parts.lines.push(
      `  · ${decl.repo}: Build-entry worktree probe — ${String(Date.now() - started)} ms`
      + `${decl.install === null ? "" : ` (including \`${decl.install}\`)`}`,
    );
  }
}
