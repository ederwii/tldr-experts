/**
 * A story's ```dod block, and the base-tree pre-flight that decides whether a red
 * command is the STORY's fault (issue #41).
 *
 * A DoD is a delta gate — "this story did not break the tree" — so a command that
 * is already red on main makes every story in the plan block for something no
 * story caused. Measured on `260829-scoring-leaderboard`: two of three declared
 * commands were red on pristine main, so all 15 stories would have blocked
 * identically, each having spent a developer turn.
 *
 * `PreflightCache` is the "once per run" half of that: every base result is
 * written to `04-build/preflight.yml` and read back by the next invocation, and
 * within a process the file is opened at most once. A cache that reloaded per
 * call would make a resumed run re-pay for a `dotnet test`.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  DodCommandRefused, runDodCommand, runScopedDodCommand, type CommandResult,
} from "../../hooks/lib/story.ts";
import { FALLBACK_DEFAULT_BRANCH, type WorkspaceContext } from "../../hooks/lib/workspace.ts";
import type { EventType } from "../events/Event.ts";
import { PROJECT_FRAMEWORK_DIR } from "../paths.ts";
import {
  baseOutputId, failureExcerpt, failureSummaryLine, writeDodOutput, type DodOutputFile,
} from "./dodOutput.ts";
import { addDetachedWorktree, removeWorktree, repoDirOf, shaOf } from "./git.ts";
import { dodRefused } from "./outcome.ts";
import type { BuildRefusal, DodRecheck, DodResult, SerialWrite } from "./outcome.ts";
import { WORKTREES } from "./plan.ts";
import type { PlannedStory } from "./plan.ts";
import {
  BaseGateFailure, baseRefusalLines, baseResultFor, cachedProvenance, commandHash, EMPTY_PREFLIGHT, loadPreflight,
  measuredProvenance, PREFLIGHT_REL, refusalFreshness, savePreflight, withResult, withWorktreeRow, WORKSPACE_FILE,
  type BaseCommandResult, type BaseFreshness,
  type BasePreflight, type BaseServed, type WorktreeProbeRow,
} from "./preflight.ts";
import {
  absentBinaryOf, BASE_TREE, TOOL_RESTORE_SLOT, toolRestoreCommandFor, WORKTREE_TREE,
} from "./worktreeDeps.ts";

/**
 * The run's base-tree measurements, loaded LAZILY and ONCE per process.
 * Lazily: a run that entered Build before `04-build/preflight.yml` existed must
 * not error on its absence. Once: a resumed run must not re-pay for a
 * `dotnet test` it already measured.
 */
export class PreflightCache {
  private preflight: BasePreflight | null = null;
  private loaded = false;
  private loadCount = 0;

  constructor(private readonly runDir: string) {}

  /** Disk reads so far — read by ONE test, to pin "once". */
  get loads(): number {
    return this.loadCount;
  }

  /** The run's cached base results, read once per process. */
  read(): BasePreflight {
    if (!this.loaded) {
      this.preflight = loadPreflight(this.runDir);
      this.loaded = true;
      this.loadCount++;
    }
    return this.preflight ?? EMPTY_PREFLIGHT;
  }

  /**
   * Write one measurement into `04-build/preflight.yml`.
   *
   * Through the single writer, and best-effort: a cache that cannot be saved
   * costs the NEXT invocation a re-run, and that is never a reason to fail a
   * build that is otherwise fine.
   */
  remember(result: BaseCommandResult, at: string): string | null {
    return this.save(withResult(this.read(), result, at));
  }

  /**
   * Write one Build-ENTRY worktree probe (#254) into the same file, through the
   * same single writer — a second writer for the same file is the bug either
   * could have.
   */
  rememberWorktree(row: WorktreeProbeRow, at: string): string | null {
    return this.save(withWorktreeRow(this.read(), row, at));
  }

  /** Best-effort, always: a cache that cannot be saved costs the NEXT invocation a re-run. */
  private save(next: BasePreflight): string | null {
    this.preflight = next;
    this.loaded = true;
    try {
      savePreflight(this.runDir, next);
      return null;
    } catch (error) {
      return `could not write ${PREFLIGHT_REL}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}

/**
 * ONE spawn of one gate command, read the same way wherever it is read (§7).
 *
 * The two normalisations below were spelled out twice — once in `baseResultOf`
 * for the base tree and once in `runStoryDod` for the story's — and #163 needed
 * a third reading for the re-run. A timed-out run is exit 124 (the process has
 * no exit code of its own), and a NON-GREEN run's one line is the
 * failure-looking line rather than the last line of `stdout + stderr` (#211);
 * `outcome.tail` is the old reading and survives only where there is no output
 * to choose from, which is every green row.
 */
interface OneRun {
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly output: string;
  readonly tail: string;
  /** The line that actually ran — a scoped template arrives here rendered. */
  readonly command: string;
}

async function measureOnce(spawn: () => Promise<CommandResult>): Promise<OneRun> {
  const outcome = await spawn();
  const exitCode = outcome.timedOut ? 124 : outcome.exitCode;
  const output = outcome.output ?? "";
  const green = exitCode === 0 && !outcome.timedOut;
  return {
    exitCode,
    timedOut: outcome.timedOut,
    output,
    tail: green ? outcome.tail : failureSummaryLine(output),
    command: outcome.command,
  };
}

/**
 * The SECOND reading of a red story DoD command (#163) — the same command, the
 * same tree, once.
 *
 * Measured on a .NET workspace 2026-09-05: a gate's `dotnet test → exit 2`
 * pinned a story `blocked` on its last attempt, and the identical suite run
 * twice by hand exited 0 with 2860 tests and 0 failing. It was contention over a
 * container runtime. Nothing in the record could tell that from a defect, and
 * `blocked` is terminal in-run — so the story needed a human. Owner decision
 * (Slack q_mu2lhfin2d03c3c5): re-run the red command once and record BOTH exit
 * codes. A red that reproduces is still a red and still blocks; this changes
 * what the block SAYS, never what it does.
 *
 * `null` means "do not ask": a REFUSED row never ran, so it has no first reading
 * to reproduce. Every other non-green row gets an answer, and when the answer
 * cannot be a number it is a REASON (§7) — a 127 whose binary the tree never had
 * would only measure the same absence again, and an error re-running is recorded
 * verbatim rather than rounded into a second exit code nobody took.
 */
async function recheckRed(
  result: DodResult, spawn: () => Promise<CommandResult>,
): Promise<DodRecheck | null> {
  if (dodRefused(result)) return null;
  if (result.absent !== undefined && result.absent !== null) {
    return {
      absentBecause: "the command's binary is absent from this worktree, so a second run would "
        + "measure the same environment absence and not the story",
    };
  }
  try {
    const again = await measureOnce(spawn);
    return {
      exitCode: again.exitCode,
      ...(again.timedOut ? { timedOut: true } : {}),
      ...(again.tail === "" ? {} : { tail: again.tail }),
    };
  } catch (error) {
    // Including `DodCommandRefused`, which the first run cannot have raised —
    // if it ever does, the reason is what is written down, never a number.
    return { absentBecause: error instanceof Error ? error.message : String(error) };
  }
}

/** What `baseResultOf` and `redBaseRefusal` need, as data the executor owns. */
export interface BaseParts {
  readonly workspace: WorkspaceContext;
  readonly cache: PreflightCache;
  readonly at: string;
  readonly preparing: boolean;
  /**
   * This invocation is a `run auto` RELAUNCH (#339). A cached RED is re-measured
   * rather than re-served: the attempt before this one refused and asked somebody
   * to repair the base tree, and a reading taken before that repair is evidence
   * about a tree that may no longer exist. Greens are still re-used.
   */
  readonly relaunching: boolean;
  readonly timeoutMs: number;
  /**
   * The run directory — a RED base's kept output is written under it (#229),
   * the same way a red story DoD's is. DATA the executor owns and passes, never
   * `ctx` and never the session.
   */
  readonly runDir: string;
  /** The executor's single writer — passed, never duplicated. */
  readonly write: SerialWrite;
  /** stderr sink, append-only, owned by the executor. */
  readonly advisories: string[];
  /**
   * The workspace root and this run's id — gh #371's opt-in worktree probe needs
   * both to open its own throwaway detached worktree, the same way
   * `entryProbe.ts`'s `EntryProbeParts` already does for the Build-entry door.
   * Unused, and never read, when `workspace.probeInWorktree` is false — which is
   * every workspace before this key existed.
   */
  readonly root: string;
  readonly runId: string;
}

/**
 * One gate command's result on one repo's base tree — from the run's cache when
 * this run already paid for it, measured and written down when it did not.
 *
 * `null` means the question could not be asked at all (a `repo:` the workspace
 * does not declare). Every caller treats that as "no evidence", never as a
 * verdict.
 */
export async function baseResultOf(
  parts: BaseParts, repo: string, command: string,
): Promise<BaseCommandResult | null> {
  return (await serveBaseResult(parts, repo, command))?.result ?? null;
}

/**
 * `baseResultOf` and WHERE ITS ANSWER CAME FROM — the one derivation, so a reader
 * that renders the freshness and the rule that decided it cannot drift (#339).
 *
 * `null` for the same reason `baseResultOf` returns `null`: the question could not
 * be asked at all.
 */
export async function serveBaseResult(
  parts: BaseParts, repo: string, command: string,
): Promise<BaseServed | null> {
  let repoDir: string;
  try {
    repoDir = repoDirOf(parts.workspace, repo);
  } catch {
    return null;
  }
  const baseRef = parts.workspace.defaultBranches.get(repo) ?? FALLBACK_DEFAULT_BRANCH;
  const baseSha = await shaOf(repoDir, baseRef);
  return measureBaseCommand(parts, repo, command, repoDir, BASE_TREE, baseRef, baseSha);
}

/**
 * The ONE measurement + cache logic every base command goes through (§7) —
 * `serveBaseResult` (the checkout, `cwd = repoDir`, `tree = BASE_TREE`) and
 * `probeBaseInWorktree` (gh #371's opt-in second reading, `cwd` a throwaway
 * worktree, `tree = WORKTREE_TREE`) are the same derivation with a different
 * tree, never two copies of it.
 */
async function measureBaseCommand(
  parts: BaseParts, repo: string, command: string, cwd: string, tree: string, baseRef: string, baseSha: string,
): Promise<BaseServed> {
  const hash = commandHash(command, [...parts.workspace.commands]);
  const preflight = parts.cache.read();
  const cached = baseResultFor(preflight, repo, command, baseSha, {
    commandHash: hash,
    at: parts.at,
    prepare: parts.preparing,
    relaunch: parts.relaunching,
  }, tree);
  if (cached !== null) return { result: cached, provenance: cachedProvenance(cached, preflight.checkedAt) };

  const timeoutMs = parts.timeoutMs;
  let measured: BaseCommandResult;
  try {
    const outcome = await measureOnce(
      () => runDodCommand(command, cwd, timeoutMs, parts.workspace.commands),
    );
    const exitCode = outcome.exitCode;
    const output = outcome.output;
    // #229: a RED base refuses the WHOLE stage before anything is dispatched, so
    // it keeps what the command SAID — through the same seam a red story DoD has
    // used since #211, never a second reading of it. A GREEN base still writes
    // nothing: it blocks nobody, and it is re-used from cache far more often
    // than a story's, so a file per passing run would be megabytes of chatter.
    const kept: DodOutputFile | null = exitCode === 0 && !outcome.timedOut
      ? null
      : writeDodOutput(parts.runDir, baseOutputId(repo, command), 0, output);
    measured = {
      repo, command, baseRef, baseSha, exitCode, timedOut: outcome.timedOut,
      // The failure-looking line, not the last line of stdout+stderr — chosen by
      // `measureOnce`, the one reading every spawn goes through (§7).
      tail: outcome.tail,
      ...(kept === null ? {} : {
        excerpt: failureExcerpt(output),
        outputPath: kept.rel,
        outputBytes: kept.bytes,
        outputLine: kept.line,
      }),
      status: exitCode === 0 && !outcome.timedOut ? "ok" : "failed", commandHash: hash,
      // gh #363, absent-with-reason: WHICH tree this row is a fact about. Given
      // by the caller now (gh #371: a second caller measures a second tree),
      // but still a fact a reader can cite rather than assume.
      tree,
    };
  } catch (error) {
    if (!(error instanceof DodCommandRefused)) throw error;
    // The gate would not run it, so nothing was learned ABOUT THE BASE — and no
    // exit code is invented to say so (#165). `unmeasured` is the status that
    // already means this, and it still refuses nothing and excuses nothing. The
    // story-level DoD refuses it on its own terms; this must not double as a
    // second, differently-worded veto. No `tree` either: the refusal is a fact
    // about the ALLOWLIST, not about either tree, and is the same regardless of
    // which one asked.
    measured = {
      repo, command, baseRef, baseSha, timedOut: false,
      tail: error.message, refusedBecause: error.message,
      status: "unmeasured", commandHash: hash,
    };
  }
  await parts.write(() => {
    const advisory = parts.cache.remember(measured, parts.at);
    if (advisory !== null) parts.advisories.push(advisory);
  });
  return { result: measured, provenance: measuredProvenance(parts.at) };
}

/**
 * gh #371 Item A: the base pre-flight's declared commands, measured a SECOND
 * time inside a fresh detached worktree of the base sha — kept BESIDE the
 * checkout row (`tree: WORKTREE_TREE` vs. `tree: BASE_TREE`, `measureBaseCommand`
 * above), never instead of it. OFF unless the workspace declares
 * `probe_in_worktree: true`: `dodRunner.ts`'s own "Where it runs" already names
 * the cost of moving the PRIMARY probe into a worktree (the `node_modules`-less
 * outage); this pays that cost only for a workspace that opted in, and only
 * once per repo — one worktree, every declared command run inside it in
 * order, never one worktree per command.
 *
 * #363's own declined scope, closed here: a command green in the checkout and
 * red only inside a story's own worktree (a `.git` FILE vs. a `.git` directory
 * is the measured case) went unnoticed until a story paid for the difference.
 * This asks the base pre-flight the SAME question a story's own worktree would,
 * before any story opens.
 */
async function probeBaseInWorktree(
  parts: BaseParts, repo: string, commands: readonly string[],
): Promise<readonly BaseServed[]> {
  if (commands.length === 0) return [];
  let repoDir: string;
  try {
    repoDir = repoDirOf(parts.workspace, repo);
  } catch {
    return [];   // a repo the workspace does not declare: no evidence, not a verdict
  }
  const baseRef = parts.workspace.defaultBranches.get(repo) ?? FALLBACK_DEFAULT_BRANCH;
  const baseSha = await shaOf(repoDir, baseRef);

  // A `git worktree add`/`remove` this call does not need to pay for: every
  // declared command already has a FRESH `tree: WORKTREE_TREE` reading, the same
  // freshness rule `measureBaseCommand` applies per command. Checked BEFORE
  // touching git at all — measured live: a session that calls `redBaseRefusal`
  // more than once (a `prepare()` followed by the real call, in one process)
  // paid for the worktree open/close on EVERY call, even though every command
  // inside it was already a cache hit and nothing was ever spawned there.
  const preflight = parts.cache.read();
  const freshness = (command: string): BaseFreshness => ({
    commandHash: commandHash(command, [...parts.workspace.commands]),
    at: parts.at, prepare: parts.preparing, relaunch: parts.relaunching,
  });
  const cachedOnly: BaseServed[] = [];
  for (const command of commands) {
    const cached = baseResultFor(preflight, repo, command, baseSha, freshness(command), WORKTREE_TREE);
    if (cached === null) { cachedOnly.length = 0; break; }
    cachedOnly.push({ result: cached, provenance: cachedProvenance(cached, preflight.checkedAt) });
  }
  if (cachedOnly.length === commands.length) return cachedOnly;

  const dir = baseWorktreeProbePath(parts.root, repo, parts.runId);
  // A tree left behind by a killed run is not evidence of anything; take it away
  // before asking git for a new one at the same path.
  if (existsSync(dir)) await removeWorktree(repoDir, dir);
  try {
    await addDetachedWorktree(repoDir, dir, baseSha === "" ? baseRef : baseSha);
  } catch {
    // git could not give us the tree. NOTHING was learned, so nothing is
    // written and nothing refuses — the same third case `entryProbe.ts`'s own
    // worktree probe already has when its `addDetachedWorktree` throws.
    return [];
  }
  try {
    const served: BaseServed[] = [];
    for (const command of commands) {
      served.push(await measureBaseCommand(parts, repo, command, dir, WORKTREE_TREE, baseRef, baseSha));
    }
    return served;
  } finally {
    const removed = await removeWorktree(repoDir, dir);
    if (!removed) {
      parts.advisories.push(`the base pre-flight's worktree probe for repo ${repo} at ${dir} could not be removed`);
    }
  }
}

/**
 * `.tldrx/worktrees/<repo>/<run>-_base-worktree-probe` — thrown away when every
 * command has been asked. Exported so a test can assert on the exact path a
 * worktree would (or, cache-satisfied, would NOT) appear at.
 */
export function baseWorktreeProbePath(root: string, repo: string, runId: string): string {
  return join(root, PROJECT_FRAMEWORK_DIR, WORKTREES, repo, `${runId}-_base-worktree-probe`);
}

/**
 * gh #363: a repo's declared `tool_restore:` runs ONCE in the checkout, before
 * the base pre-flight asks that checkout a single question.
 *
 * Measured live: a workspace declared `tool_restore: dotnet tool restore` (no
 * `install:` at all) and nothing ran it anywhere automatically — the base
 * pre-flight's own FIRST probed command refused with the local tool missing,
 * naming a fix (#343's `installAdviceLine`-style advice) only after the fact.
 * This runs the fix instead of only naming it.
 *
 * `install:` is deliberately NOT run here — see `toolRestoreCommandFor`'s own
 * comment for why a third automatic install door, in the checkout, is the wrong
 * fix and was measured to regress an existing one (`story-worktree-deps.test.ts`
 * case (d)) while this was being built.
 *
 * A failure here refuses Build exactly the way a red base command does —
 * nothing dispatched, nothing charged — because a checkout whose declared
 * restore did not succeed cannot prove anything about a base command's redness
 * OR its greenness: the very thing #41 exists to keep a story from being
 * blamed for.
 *
 * Deduplicated by repo, not by story or command: `tool_restore:` prepares a
 * TREE, not a command, so two stories in the same repo pay for it once, the
 * same way `PreflightCache` already keeps a `dotnet test` from being re-paid.
 */
async function prepBaseTree(parts: BaseParts, repos: Iterable<string>): Promise<BuildRefusal | null> {
  for (const repo of new Set(repos)) {
    let repoDir: string;
    try {
      repoDir = repoDirOf(parts.workspace, repo);
    } catch {
      continue;   // a repo the workspace does not declare: no evidence, not a verdict
    }
    const command = toolRestoreCommandFor(parts.workspace, repo);
    if (command === null) continue;
    let outcome: CommandResult;
    try {
      outcome = await runDodCommand(command, repoDir, parts.timeoutMs, parts.workspace.commands);
    } catch (error) {
      if (!(error instanceof DodCommandRefused)) throw error;
      return prepRefusal(repo, command, `was refused and never ran — ${error.message}`);
    }
    const exitCode = outcome.timedOut ? 124 : outcome.exitCode;
    if (exitCode !== 0 || outcome.timedOut) {
      return prepRefusal(
        repo, command,
        `exited ${String(exitCode)}${outcome.timedOut ? " (timed out)" : ""} in the base checkout — `
          + failureSummaryLine(outcome.output ?? ""),
      );
    }
  }
  return null;
}

/** One `prepBaseTree` refusal, the same shape a red base command's refusal has. */
function prepRefusal(repo: string, command: string, detail: string): BuildRefusal {
  return {
    lines: [
      `[tldrx] build: the \`${TOOL_RESTORE_SLOT}:\` command for repo ${repo} (\`${command}\`) ${detail}`,
      `Fix ${WORKSPACE_FILE} (or what \`${command}\` runs), then run \`tldrx next\` again. `
        + "Nothing was dispatched and nothing was charged.",
    ],
    error: `\`${command}\` (the \`${TOOL_RESTORE_SLOT}:\` command for repo ${repo}) ${detail}`,
  };
}

/**
 * Issue #41: the gate commands, on the UNTOUCHED base tree, before anything is
 * dispatched or charged.
 *
 * A DoD is a delta gate — "this story did not break the tree" — and a command
 * that is already red on main makes every story in the plan block for something
 * no story caused. Measured on `260829-scoring-leaderboard`: two of three
 * declared commands were red on pristine main, so all 15 stories would have
 * blocked identically, each having spent a developer turn, and one of the two
 * was running paid live AI tests as a routine gate.
 *
 * **Where it runs.** In the repo's own checkout, not a fresh worktree. That is
 * the tree a human calls "the base": it has the installed dependencies, the
 * build cache and the tool state that make the command mean what the team
 * thinks it means, and a pristine worktree would fail half the world's repos
 * for want of `node_modules` — turning this safety net into an outage. The
 * dirty-tree refusal has already run, so the tree is product-clean. The trade
 * is that a gate command which writes build output into a repo that does not
 * gitignore it now leaves that output in the repo rather than in a worktree —
 * a repo shaped like that was already broken for Build, whose commit step
 * would have swept the same files into a story's diff.
 *
 * gh #363, decided with the same trade in mind: a live run's base pre-flight was
 * green in the checkout on a command that then failed inside a story's own
 * worktree, for an environment reason (a `.git` FILE vs. a `.git` directory —
 * git's own worktree convention, unrelated to anything this repo declares) the
 * checkout reading could not see. Moving the probe itself into a throwaway
 * worktree would catch that ONE shape of gap, but pays for the declared command
 * a second time on every run that needs a fresh measurement and reopens the
 * exact `node_modules`-less outage two paragraphs up — for a class of gap
 * (worktree-vs-checkout git metadata) far narrower than "no worktree has
 * dependencies at all". So this stays in the checkout, and `serveBaseResult`
 * below records WHICH tree it measured (`BASE_TREE`, absent-with-reason, §7)
 * instead: a green row here is evidence about the checkout, never a promise
 * about the tree a story's own DoD actually runs in.
 *
 * **What it costs.** Once per run: every result is written to
 * `04-build/preflight.yml` and read back by the next invocation.
 *
 * A command the gate DECLINES to run (undeclared, or needing a shell) is
 * recorded `unmeasured` and refuses nothing — the story-level DoD already has
 * its own refusal for that, and inventing a base failure out of one would block
 * a build for a rule that is enforced elsewhere.
 */
export async function redBaseRefusal(
  parts: BaseParts, stories: readonly PlannedStory[],
): Promise<BuildRefusal | null> {
  const prepFailure = await prepBaseTree(parts, stories.map((planned) => planned.story.repo));
  if (prepFailure !== null) return prepFailure;

  const failures: BaseServed[] = [];
  const seen = new Set<string>();
  const perRepoCommands = new Map<string, string[]>();
  for (const planned of stories) {
    for (const command of planned.dod.commands) {
      const key = `${planned.story.repo}\u0000${command}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const served = await serveBaseResult(parts, planned.story.repo, command);
      if (served !== null && served.result.status === "failed") failures.push(served);
      const list = perRepoCommands.get(planned.story.repo) ?? [];
      list.push(command);
      perRepoCommands.set(planned.story.repo, list);
    }
  }
  // gh #371 Item A: opt-in ONLY. A workspace that has never heard of
  // `probe_in_worktree:` gets exactly the loop above and nothing else — the same
  // behavior this repo shipped before the flag existed.
  if (parts.workspace.probeInWorktree) {
    for (const [repo, commands] of perRepoCommands) {
      const served = await probeBaseInWorktree(parts, repo, commands);
      for (const one of served) if (one.result.status === "failed") failures.push(one);
    }
  }
  if (failures.length === 0) return null;
  return {
    lines: [...baseRefusalLines(failures, parts.workspace)],
    // #339: whether THIS attempt measured the evidence behind the refusal, or was
    // handed a reading an earlier one took. The supervisor's repeat guard reads it —
    // a refusal repeating verbatim proves nothing moved only when the second one was
    // actually taken. Through `refusalFreshness`, the one derivation both refusal
    // builders share, so the entry gate and the mid-story one cannot drift.
    freshness: refusalFreshness(failures.map((served) => served.provenance)),
    // EVERY red command, not the first in iteration order (gh #297). This sentence is
    // what `--until-done` compares one attempt against the next, and a base tree with two
    // reds and one with only the first of them still red are different states that the
    // printed refusal already distinguishes: measured, the old sentence did not move
    // between them, so the loop called a base an operator was fixing "the same refusal"
    // and stopped relaunching over it.
    error: failures.length === 0
      ? "a workspace command fails on the base tree"
      : failures
        .map(({ result: row }) =>
          `\`${row.command}\` exits ${String(row.exitCode ?? "?")} on the base tree of ${row.repo}`)
        .join("; "),
  };
}

/** One story's ```dod block, as data: no `ctx`, no session, no `this`. */
export interface DodParts {
  readonly storyId: string;
  readonly repo: string;
  readonly worktree: string;
  /**
   * The repo's own checkout — the tree the base pre-flight measured in. Read for
   * ONE comparison (gh #209): whether the base has a `node_modules` this
   * worktree does not, which is the difference between a green pre-flight and a
   * story's 127 and the only evidence that names it.
   */
  readonly repoDir: string;
  /** True when this repo declares `install:`, so it already ran here. */
  readonly installDeclared: boolean;
  readonly commands: readonly string[];
  readonly workspaceCommands: ReadonlySet<string>;
  readonly timeoutMs: number;
  readonly phaseId: string;
  /**
   * The run directory — a red check's kept output is written under it (#211).
   * DATA the executor owns and passes, never `ctx` and never the session.
   */
  readonly runDir: string;
  readonly emit: (type: EventType, payload: Record<string, unknown>) => void;
  /**
   * The base answer AND where it came from (#339) — so the refusal this raises
   * says whether it read the tree or a record, exactly as the entry refusal does.
   */
  readonly baseResult: (repo: string, command: string) => Promise<BaseServed | null>;
  /**
   * The repo's `<slot>_scoped` templates and this story's paths (#257). PRESENT
   * means the repo declares at least one template, and every row then says
   * which proof it was (`scope`); ABSENT means the repo declares none, and the
   * runner is byte-for-byte what it was before the suffix existed — no key, no
   * branch. A command with a template runs scoped only when `paths` is
   * non-empty; a story that touched nothing the tree still has runs the full
   * command, because "narrowed to nothing" is not a proof of anything.
   */
  readonly scoped?: {
    /** full command -> template, as `loadWorkspace` derived it. */
    readonly templates: ReadonlyMap<string, string>;
    readonly paths: readonly string[];
  };
}

export async function runStoryDod(parts: DodParts): Promise<readonly DodResult[]> {
  const timeoutMs = parts.timeoutMs;
  const results: DodResult[] = [];
  for (const command of parts.commands) {
    // Same allowlist the hook uses, same refusal. The Build executor runs a dod
    // block in a worktree for real; an undeclared command is a failed check
    // here, not a spawn.
    const template = parts.scoped?.templates.get(command);
    const paths = parts.scoped?.paths ?? [];
    const scopedRun = template !== undefined && paths.length > 0;
    // Which proof this row is — only ever said when the repo declares a template.
    const scope: Pick<DodResult, "scope" | "paths"> = parts.scoped === undefined
      ? {}
      : { scope: scopedRun ? "paths" : "full", ...(scopedRun ? { paths: [...paths] } : {}) };
    // ONE spawn recipe for this row, so the re-run below is the SAME command in
    // the SAME tree and not a second reading of what it ought to have been.
    const spawn = (): Promise<CommandResult> => (scopedRun && template !== undefined
      ? runScopedDodCommand(template, paths, parts.worktree, timeoutMs)
      : runDodCommand(command, parts.worktree, timeoutMs, parts.workspaceCommands));
    let result: DodResult;
    try {
      const outcome = await measureOnce(spawn);
      const exitCode = outcome.exitCode;
      const output = outcome.output;
      // Only a RED check's output is kept (#211). A green one has nothing anybody
      // has ever needed at 2am, and writing a file per passing command would put
      // megabytes of `npm test` chatter in every run dir — the record exists to
      // answer "why did this block", and a green command blocks nothing.
      const kept: DodOutputFile | null = exitCode === 0 && !outcome.timedOut
        ? null
        : writeDodOutput(parts.runDir, parts.storyId, results.length, output);
      const ran: DodResult = {
        // The DECLARED command on every row — it is what the evidence cites.
        // A scoped row carries the line that ran beside it, as `rendered`.
        command,
        status: "ran",
        exitCode,
        timedOut: outcome.timedOut,
        ...scope,
        ...(scopedRun ? { rendered: outcome.command } : {}),
        // #211: the failure-looking line, not the last line of stdout+stderr —
        // chosen by `measureOnce`, the one reading every spawn goes through (§7).
        tail: outcome.tail,
        ...(kept === null ? {} : {
          excerpt: failureExcerpt(output),
          outputPath: kept.rel,
          outputBytes: kept.bytes,
          outputLine: kept.line,
        }),
      };
      // gh #209: an exit 127 HERE, in a tree that never had the binary, is an
      // environment absence and must not be rendered as a red test. Asked only
      // of a 127 — `absentBinaryOf` returns null for every other result, and
      // absent is what every non-127 row carries.
      const absent = absentBinaryOf(ran, {
        worktree: parts.worktree,
        repoDir: parts.repoDir,
        installDeclared: parts.installDeclared,
      });
      result = absent === null ? ran : { ...ran, absent };
    } catch (error) {
      if (!(error instanceof DodCommandRefused)) throw error;
      // NOTHING RAN. There is no exit code, so none is written — a fabricated
      // 126 was rendered as a measurement by three documents (#165).
      result = { command, status: "refused", refusedBecause: error.message, timedOut: false, tail: "", ...scope };
    }
    const green = !dodRefused(result) && result.exitCode === 0 && !result.timedOut;
    // #163: a red is MEASURED TWICE before it pins a story. Before the event is
    // emitted, because the event ledger is what a resumed invocation rebuilds
    // these rows from — a reading that does not reach the payload is not
    // recorded at all.
    if (!green) {
      const recheck = await recheckRed(result, spawn);
      if (recheck !== null) result = { ...result, recheck };
    }
    results.push(result);
    parts.emit(green ? "check.passed" : "check.failed", {
      phase: parts.phaseId,
      check: "dod",
      story: parts.storyId,
      // The ledger records what RAN: the rendered line on a scoped row.
      command: result.rendered ?? result.command,
      ...(dodRefused(result) ? {} : { exit_code: result.exitCode }),
      ...(dodRefused(result) ? { refused: result.refusedBecause ?? "" } : {}),
      // #257: which proof this row is, and over which paths. Both keys are
      // ADDITIVE and absent on a repo that declares no template — the golden
      // for such a workspace is the proof that absent is what it was.
      ...(result.scope === undefined ? {} : { scope: result.scope }),
      ...(result.paths === undefined ? {} : { paths: [...result.paths] }),
      // WHICH TREE (gh #209). The base pre-flight runs in the repo's checkout,
      // with its dependencies; this runs in a fresh worktree. Both wrote the same
      // command and the same shape of check, and nothing in either record said
      // they were different trees — so a green pre-flight beside a story's 127
      // read as a contradiction instead of as the environment gap it was.
      tree: WORKTREE_TREE,
      ...(result.absent === undefined || result.absent === null
        ? {}
        : { absent_binary: result.absent.binary ?? "" }),
      // #211: the excerpt, bounded at `DOD_DETAIL_MAX_BYTES` so this payload can
      // never reach the §2.9 4096-byte cap and lose its `detail` to
      // `capPayload`'s `detail_omitted` (#160). The event that says WHY a story
      // blocked is the one event that must never be trimmed for size — and the
      // #209 keys above are small and fixed, so they cannot eat that headroom.
      detail: green ? "" : (result.refusedBecause ?? result.excerpt ?? result.tail),
      ...(result.outputPath === undefined ? {} : {
        output_path: result.outputPath,
        output_bytes: result.outputBytes ?? 0,
        output_line: result.outputLine ?? 1,
      }),
      // #163: the second reading of a red command — ONE of these two keys, never
      // both and never neither, so the ledger can tell a measurement from a
      // reason. ADDITIVE and absent on every green row and every refusal, which
      // is what the golden for a build without a red DoD proves. `recheck_detail`
      // is ONE `failureSummaryLine`, bounded at 200 characters by the function
      // itself, so this payload keeps the headroom #160/#211 bought `detail`:
      // the event that says WHY a story blocked must never be the one the
      // §2.9 cap trims.
      ...(result.recheck === undefined ? {} : (result.recheck.exitCode === undefined
        ? { recheck_absent: result.recheck.absentBecause ?? "" }
        : {
          recheck_exit_code: result.recheck.exitCode,
          ...(result.recheck.timedOut === true ? { recheck_timed_out: true } : {}),
          ...(result.recheck.tail === undefined ? {} : { recheck_detail: result.recheck.tail }),
        })),
    });
    if (green) continue;
    // A scoped red is the story's own: the base tree ran the FULL command, and
    // a measurement of a different command over different paths answers
    // nothing about this one (#257). No base consult, no halt — block.
    if (scopedRun) break;
    // Issue #41, the second reader: a red command only faults the STORY if it
    // is green on the untouched base tree. The answer is normally already in
    // the run's cache — the Build-entry pre-flight put it there — and when it
    // is not (a run that entered Build on an older binary, a base that moved
    // under a reopened story) it is measured now rather than assumed. A base
    // that shares the failure halts the build instead of blocking the story.
    const base = await parts.baseResult(parts.repo, command);
    if (base !== null && base.result.status === "failed") {
      throw new BaseGateFailure(base.result, parts.storyId, base.provenance);
    }
    break;
  }
  return results;
}
