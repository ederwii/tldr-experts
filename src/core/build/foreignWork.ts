/**
 * Foreign work: somebody else's uncommitted changes in a repo this run is about
 * to build in — set aside for the wave, recorded, and given back.
 *
 * ## Why this exists (#164, measured)
 *
 * Build refuses to cut an epic branch from a dirty tree, and the refusal is
 * right about WHAT it protects: the #41 base pre-flight runs the workspace's gate
 * commands in the repo's OWN checkout, so an uncommitted product change there
 * sits silently inside the measurement that decides whether a story's red DoD is
 * the story's fault or the base's (`build/dodRunner.ts`). What it had no answer
 * for is the normal state of a checkout with people and agents in it. Measured on
 * 2026-09-05 and again the next day: 14 uncommitted paths, 13 of them untracked,
 * none belonging to the run, and a host agent that correctly refused to commit or
 * stash somebody else's files on its own authority — so nine stories waited three
 * hours for a human to grant one `git stash`. Measured again on 0.14.2 across
 * three real workspaces: every first engine-driven run reaching Build stopped
 * here, and the remedy the refusal printed was wrong twice over (a bare `-u`
 * swept the run's own untracked records into the stash; `tldrx next` is the
 * cursor verb and the owner was in `run auto`).
 *
 * ## The rule
 *
 * The definition of dirty does not move — tracked modified/staged plus untracked,
 * per repo, `git status --porcelain`. What moves is the OUTCOME, decided per path:
 *
 *   - `own` — THIS workspace's own `tldrx-work/`/`.tldrx/` as they sit inside this
 *     repo (`stateDirPrefixes`). Not dirt, never stashed, never a refusal. This is
 *     the older half of the same lesson, and it wins over every other verdict
 *     below: a story whose `touches:` names a state path does not make that path
 *     stashable. A path that merely LOOKS like state — a `tldrx-work/` of the
 *     operator's own inside a repo in the multi-repo shape — is `overlapping`
 *     instead: it refuses, exactly as it always did, and it is still never
 *     stashed, because nothing under those names is ever moved by the framework.
 *   - `overlapping` — a dirty path inside a pending story's declared `touches:`,
 *     or a submodule. REFUSED, as before: the story is about to write that path,
 *     and setting the operator's version of it aside would hand the developer a
 *     tree the operator did not agree to. A submodule refuses because its dirt is
 *     a whole other repository's state and `git stash` in the superproject does
 *     not carry it.
 *   - `foreign` — everything else. Set aside with a pathspec-limited stash before
 *     the epic branch is cut, recorded as `worktree.foreign_work_aside`, and
 *     popped back when the wave ends, recorded as `worktree.foreign_work_restored`.
 *
 * ## What this file will not do
 *
 * It never deletes a stash, never forces a pop, never resolves a conflict, and
 * never touches a path under the framework's own state dirs. A restore that
 * cannot happen is REPORTED — `restored: false`, the paths, the stash and the
 * literal command — and the run's own exit code is untouched by it, because the
 * exit code answers for the run's work, not for the operator's tree.
 *
 * Every function here takes DATA and returns data (AGENTS.md §12): the caller
 * owns the repo directories, the events and the lines.
 */
import { isStatePath } from "./implicitPlan.ts";
import { inSurface } from "../run/boundary.ts";
import {
  literalPathspec, type DirtyEntry, operationInProgress, stashPop, stashPushPaths, submodulePaths,
} from "./git.ts";

/** The two event types this file's outcomes are recorded as (spec §2.9). */
export const FOREIGN_ASIDE_EVENT = "worktree.foreign_work_aside";
export const FOREIGN_RESTORED_EVENT = "worktree.foreign_work_restored";

/** How many paths a line names before it counts the rest. */
export const NAMED_PATHS = 5;

export interface OverlappingPath {
  readonly entry: DirtyEntry;
  /** Why this one may not be set aside — rendered into the refusal verbatim. */
  readonly why: string;
}

export interface DirtyVerdict {
  /** The framework's own state. Never stashed, never a refusal. */
  readonly own: readonly DirtyEntry[];
  /** Safe to set aside: nobody's story is going to write here. */
  readonly foreign: readonly DirtyEntry[];
  /** Refuses the build, exactly as a dirty tree always did. */
  readonly overlapping: readonly OverlappingPath[];
}

export interface DirtyInput {
  readonly entries: readonly DirtyEntry[];
  /**
   * THIS workspace's own state directories, relative to this repo
   * (`stateDirPrefixes`) — empty in the multi-repo shape, where the state sits at
   * the workspace root and nothing inside the repo is the framework's.
   */
  readonly statePrefixes: readonly string[];
  /** The union of every PENDING story's `touches:` for this repo. */
  readonly touches: readonly string[];
  /** Submodule paths `.gitmodules` declares, from `submodulePaths`. */
  readonly submodules: ReadonlySet<string>;
}

/**
 * Split a repo's dirt three ways.
 *
 * Order is the contract, not an implementation detail. `own` is tested FIRST, so
 * a `touches:` entry that reaches into `tldrx-work/` or `.tldrx/` cannot promote
 * a state file to something this run may stash; the submodule test comes next,
 * because a submodule inside a story's surface is still a repository whose dirt
 * a superproject stash does not carry.
 *
 * `inSurface` is the boundary condition's matcher (`run/boundary.ts`) and not a
 * second one: "is this path inside what the plan declared" has one answer in this
 * codebase, and a directory entry covers its tree here for the same reason it
 * does there.
 */
export function classifyDirty(input: DirtyInput): DirtyVerdict {
  const own: DirtyEntry[] = [];
  const foreign: DirtyEntry[] = [];
  const overlapping: OverlappingPath[] = [];
  for (const entry of input.entries) {
    // An untracked directory arrives with a trailing slash (`?? 04-build/`), so
    // the `${prefix}/` test catches it as well as a file below the prefix.
    if (input.statePrefixes.some((p) => entry.path === p || entry.path.startsWith(`${p}/`))) {
      own.push(entry);
      continue;
    }
    // A path that merely LOOKS like framework state — `tldrx-work/` inside a repo
    // in the multi-repo shape, where the framework's own state lives at the
    // workspace root — is the human's directory, not ours. It refuses exactly as
    // it always did, and it is never stashed: the one rule with no exception here
    // is that nothing under these names is ever moved by the framework.
    if (isStatePath(entry.path)) {
      overlapping.push({
        entry,
        why: "this is your own directory that happens to be named like tldrx state — the framework "
          + "never stashes a `tldrx-work/`, `.tldrx/` or `.agent/` path, so this one is yours to move",
      });
      continue;
    }
    const submodule = [...input.submodules].find(
      (path) => entry.path === path || entry.path.startsWith(`${path}/`),
    );
    if (submodule !== undefined) {
      overlapping.push({
        entry,
        why: `\`${submodule}\` is a submodule — its uncommitted state is another repository's, `
          + "and a stash here does not carry it",
      });
      continue;
    }
    if (inSurface(entry.path, input.touches)) {
      overlapping.push({
        entry,
        why: "a pending story declares this path in its `touches:` — setting your version of it "
          + "aside would hand the developer a tree you did not agree to",
      });
      continue;
    }
    foreign.push(entry);
  }
  return { own, foreign, overlapping };
}

/** What one repo's set-aside stash is, once it exists. */
export interface AsideStash {
  readonly repo: string;
  readonly repoDir: string;
  /** Repo-relative, exactly as git named them — the pathspec, and the record. */
  readonly paths: readonly string[];
  /** The stash commit's full sha. `stash@{n}` is looked up from it at restore. */
  readonly hash: string;
  readonly message: string;
}

/** The stash message this run's entries carry — one spelling, used and printed. */
export function stashMessage(runId: string): string {
  return `tldrx ${runId} foreign work`;
}

/**
 * A single-quoted shell word — the only quoting this file does, and it is exact.
 *
 * The printed remedy is a line a person RETYPES INTO A SHELL, so a path with a
 * space, a bracket or a leading dash has to survive the shell before it can
 * survive git. `'` inside is closed, escaped and reopened (`'\''`), which is the
 * one form that has no escape sequences of its own to get wrong.
 */
export function shellQuote(word: string): string {
  return `'${word.split("'").join(`'\\''`)}'`;
}

/**
 * The pathspec-limited `git stash push`, and the ONE place its command is spelled.
 *
 * Printed by the refusal and RUN by the engine THROUGH THE SAME `literalPathspec`,
 * so the remedy an operator is handed and the thing the framework does cannot
 * drift. It used to join the raw paths while the engine passed `:(literal)`, and
 * the docstring above said otherwise — measured 2026-09-09: the printed line for a
 * file called `[x].txt` moved the neighbouring `x.txt` instead. A promise a
 * docstring makes and the code does not keep is worse than no promise.
 */
export function stashCommand(repoDir: string, runId: string, paths: readonly string[]): string {
  const pathspecs = paths.map((path) => shellQuote(literalPathspec(path))).join(" ");
  return `git -C ${shellQuote(repoDir)} stash push -u -m ${shellQuote(stashMessage(runId))} -- ${pathspecs}`;
}

export interface AsideOutcome {
  readonly stash: AsideStash | null;
  /** Why nothing was set aside, when `stash` is null and there was work to move. */
  readonly reason: string | null;
}

/**
 * Set one repo's foreign work aside, or say why it was not.
 *
 * A repo mid-merge, mid-rebase, mid-cherry-pick or mid-bisect is REFUSED by the
 * caller before this is reached; the check is repeated here because this is the
 * function that writes, and a write into a half-finished merge is the one shape
 * with no clean undo.
 */
export async function setAsideForeignWork(
  repo: string, repoDir: string, runId: string, paths: readonly string[],
): Promise<AsideOutcome> {
  if (paths.length === 0) return { stash: null, reason: null };
  const busy = await operationInProgress(repoDir);
  if (busy !== null) return { stash: null, reason: `${repo} is in the middle of ${busy}` };
  const pushed = await stashPushPaths(repoDir, stashMessage(runId), paths);
  if (!pushed.ok) return { stash: null, reason: pushed.detail };
  return { stash: { repo, repoDir, paths, hash: pushed.hash, message: pushed.message }, reason: null };
}

export interface RestoreOutcome {
  readonly stash: AsideStash;
  readonly restored: boolean;
  /** Did the staged snapshot come back too? See `stashPop`'s `--index` note. */
  readonly indexRestored: boolean;
  /** Paths git left unmerged. Empty when it refused whole and changed nothing. */
  readonly conflicts: readonly string[];
  /** The literal line an operator retypes. Empty only when the stash is gone. */
  readonly command: string;
  readonly detail: string;
}

/** Pop exactly this run's stash, by its hash. Never forces, never drops. */
export async function restoreForeignWork(stash: AsideStash): Promise<RestoreOutcome> {
  const popped = await stashPop(stash.repoDir, stash.hash);
  return {
    stash,
    restored: popped.restored,
    indexRestored: popped.indexRestored,
    conflicts: popped.conflicts,
    command: popped.ref === "" ? "" : `git -C ${stash.repoDir} stash pop ${popped.ref}`,
    detail: popped.detail,
  };
}

/** `a, b, c, +2 more` — never a bare count, never a truncation nobody can see. */
export function namePaths(paths: readonly string[], max = NAMED_PATHS): string {
  const named = paths.slice(0, max).join(", ");
  return paths.length > max ? `${named}, +${String(paths.length - max)} more` : named;
}

/**
 * The line a failed restore prints, and the one every surface repeats.
 *
 * ONE spelling for the terminal's last line, the handoff bullet and the notify
 * summary. A restore that failed must read the same on a phone as in a PR body:
 * the framework moved the operator's work and could not put it back, and this
 * sentence is the whole of what it owes them.
 *
 * It names the stash by HASH and the pop by `stash@{n}`, which is not a
 * redundancy: `git stash pop <sha>` is refused by git outright (measured
 * 2026-09-09, `'<sha>' is not a stash reference`), so the hash is the durable
 * name and the ref is the only form that can actually be typed.
 */
export function notRestoredLine(outcome: RestoreOutcome): string {
  return notRestoredSentence({
    repo: outcome.stash.repo,
    hash: outcome.stash.hash,
    paths: outcome.conflicts.length > 0 ? outcome.conflicts : outcome.stash.paths,
    command: outcome.command,
    detail: outcome.detail,
  });
}

/**
 * The marker every surface recognises this sentence by.
 *
 * `runNext`'s `out()` moves a line carrying it to the END of the report, whatever
 * else the stage had to say: a stage that finished green while the operator's
 * work is still in a stash must not have `gate pending` as its last word.
 */
export const NOT_RESTORED_MARK = "foreign work NOT restored";

/** The one spelling, from the fields any reader has — a live outcome or the log. */
export function notRestoredSentence(row: {
  readonly repo: string;
  readonly hash: string;
  readonly paths: readonly string[];
  readonly command: string;
  readonly detail: string;
}): string {
  const how = row.command === "" ? row.detail : row.command;
  return `${NOT_RESTORED_MARK} in ${row.repo} — stash ${row.hash.slice(0, 12)} `
    + `still holds ${namePaths(row.paths)}: ${how}`;
}

/**
 * The same sentence for a notification, read back off the LOG (#164, notify half).
 *
 * No new notify kind: this rides in the `summary` of the kinds a run-level
 * notification already goes out under — `stage.done` when the Build stage ends
 * inside the loop, and `run.finished` / `run.failed` when the loop itself stops.
 * A person who is told a stage finished, on a phone, is exactly the person who
 * has to know their uncommitted work is sitting in a stash.
 *
 * `null` when every restore succeeded, which is the ordinary case and leaves
 * every existing summary byte-identical.
 */
export function notRestoredSummary(eventsText: string): string | null {
  const failed = new Map<string, string>();
  for (const line of eventsText.split("\n")) {
    if (line.trim() === "") continue;
    let event: { type?: unknown; payload?: unknown };
    try {
      event = JSON.parse(line) as { type?: unknown; payload?: unknown };
    } catch {
      continue;
    }
    if (event.type !== FOREIGN_RESTORED_EVENT) continue;
    const payload = (typeof event.payload === "object" && event.payload !== null)
      ? event.payload as Record<string, unknown>
      : {};
    const hash = typeof payload.stash_ref === "string" ? payload.stash_ref : "";
    if (hash === "") continue;
    if (payload.restored === true) {
      failed.delete(hash);
      continue;
    }
    failed.set(hash, notRestoredSentence({
      repo: typeof payload.repo === "string" ? payload.repo : "a repo",
      hash,
      paths: Array.isArray(payload.paths) ? payload.paths.filter((p): p is string => typeof p === "string") : [],
      command: typeof payload.command === "string" ? payload.command : "",
      detail: typeof payload.detail === "string" ? payload.detail : "git refused the pop",
    }));
  }
  return failed.size === 0 ? null : [...failed.values()].join(" ");
}

/**
 * The line a SUCCESSFUL restore prints — one spelling, because a partial success
 * has to read as one.
 *
 * `index_restored: false` is not a failure and must not be printed as one: the
 * files are back, and what did not come back is the staging. The sentence says
 * exactly that, and says what to do about it, because "your work is back" over a
 * lost `git add` is the record lying in the comfortable direction.
 */
export function restoredLine(outcome: RestoreOutcome): string {
  const head = `${outcome.stash.repo}: foreign work restored from stash `
    + `${outcome.stash.hash.slice(0, 12)} (${namePaths(outcome.stash.paths)})`;
  return outcome.indexRestored
    ? head
    : `${head} — the staged snapshot could NOT be reinstated, so those paths are back UNSTAGED; `
      + "`git add` them as you had them";
}

/** Only the restores that failed — the ones every reader has to be told about. */
export function unrestored(outcomes: readonly RestoreOutcome[]): readonly RestoreOutcome[] {
  return outcomes.filter((outcome) => !outcome.restored);
}

/**
 * How many paths one event payload names before it counts the rest.
 *
 * A bound, not a preference: §2.9 caps a payload at 4 KiB and an uncapped list of
 * an operator's file names could cross it, at which point `EventLog.append`
 * refuses the line and the framework has stashed somebody's work with NO record
 * of having done so. That is the one direction this must never fail in, so the
 * list is capped and the remainder is COUNTED in the same payload. The `stash_ref`
 * — the only field a restore needs — is never affected.
 */
export const MAX_RECORDED_PATHS = 40;

/** `worktree.foreign_work_aside`'s payload (spec §2.9). */
export function asidePayload(stash: AsideStash, reason: string): Readonly<Record<string, unknown>> {
  const omitted = stash.paths.length - MAX_RECORDED_PATHS;
  return {
    repo: stash.repo,
    paths: stash.paths.slice(0, MAX_RECORDED_PATHS),
    ...(omitted > 0 ? { paths_omitted: omitted } : {}),
    stash_ref: stash.hash,
    reason,
  };
}

/** `worktree.foreign_work_restored`'s payload — the same shape, plus the verdict. */
export function restoredPayload(outcome: RestoreOutcome): Readonly<Record<string, unknown>> {
  const paths = outcome.restored ? outcome.stash.paths : (
    outcome.conflicts.length > 0 ? outcome.conflicts : outcome.stash.paths
  );
  const omitted = paths.length - MAX_RECORDED_PATHS;
  return {
    repo: outcome.stash.repo,
    paths: paths.slice(0, MAX_RECORDED_PATHS),
    ...(omitted > 0 ? { paths_omitted: omitted } : {}),
    stash_ref: outcome.stash.hash,
    restored: outcome.restored,
    // Additive and always present on a restore: a partial success has to be
    // legible without the reader knowing which release added the field.
    index_restored: outcome.indexRestored,
    ...(outcome.restored ? {} : { conflicts: outcome.conflicts.slice(0, MAX_RECORDED_PATHS) }),
    ...(outcome.restored ? {} : { command: outcome.command }),
    ...(outcome.restored ? {} : { detail: outcome.detail }),
  };
}

/**
 * The stashes this run has set aside and not yet given back, read off the LOG.
 *
 * The log, not a field on the session, because the two moments are not always in
 * one process: a cursor-driven Build sets the work aside on the invocation that
 * cuts the epic branch and finishes the stage several `tldrx next` calls later.
 * The event is already the durable record the design requires, so reading it back
 * is not a second source of truth — it is the only one.
 *
 * Tolerant by construction: an unparseable line, a payload missing its
 * `stash_ref`, a log that will not open — each is simply not a stash this
 * function claims exists. A restore it fails to notice leaves the operator's work
 * in a stash that is still named on their own `git stash list` and in this very
 * log; a restore it INVENTED would pop a stash nobody here pushed.
 */
export function pendingAsides(
  eventsText: string, repoDirOf: (repo: string) => string | null,
): readonly AsideStash[] {
  const open = new Map<string, AsideStash>();
  for (const line of eventsText.split("\n")) {
    if (line.trim() === "") continue;
    let event: { type?: unknown; payload?: unknown };
    try {
      event = JSON.parse(line) as { type?: unknown; payload?: unknown };
    } catch {
      continue;
    }
    const payload = (typeof event.payload === "object" && event.payload !== null)
      ? event.payload as Record<string, unknown>
      : {};
    const hash = typeof payload.stash_ref === "string" ? payload.stash_ref : "";
    if (hash === "") continue;
    if (event.type === FOREIGN_RESTORED_EVENT && payload.restored === true) {
      open.delete(hash);
      continue;
    }
    if (event.type !== FOREIGN_ASIDE_EVENT) continue;
    const repo = typeof payload.repo === "string" ? payload.repo : "";
    const repoDir = repo === "" ? null : repoDirOf(repo);
    if (repoDir === null) continue;
    open.set(hash, {
      repo,
      repoDir,
      paths: Array.isArray(payload.paths) ? payload.paths.filter((p): p is string => typeof p === "string") : [],
      hash,
      message: "",
    });
  }
  return [...open.values()];
}

/** Every submodule this repo declares, for `classifyDirty`. Re-exported so callers import one file. */
export { submodulePaths };
