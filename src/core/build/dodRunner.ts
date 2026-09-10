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
import { DodCommandRefused, runDodCommand } from "../../hooks/lib/story.ts";
import { FALLBACK_DEFAULT_BRANCH, type WorkspaceContext } from "../../hooks/lib/workspace.ts";
import type { EventType } from "../events/Event.ts";
import { failureExcerpt, failureSummaryLine, writeDodOutput, type DodOutputFile } from "./dodOutput.ts";
import { repoDirOf, shaOf } from "./git.ts";
import { dodRefused } from "./outcome.ts";
import type { BuildRefusal, DodResult, SerialWrite } from "./outcome.ts";
import type { PlannedStory } from "./plan.ts";
import {
  BaseGateFailure, baseRefusalLines, baseResultFor, commandHash, EMPTY_PREFLIGHT, loadPreflight, PREFLIGHT_REL,
  savePreflight, withResult, type BaseCommandResult, type BasePreflight,
} from "./preflight.ts";
import { absentBinaryOf, WORKTREE_TREE } from "./worktreeDeps.ts";

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
    const next = withResult(this.read(), result, at);
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

/** What `baseResultOf` and `redBaseRefusal` need, as data the executor owns. */
export interface BaseParts {
  readonly workspace: WorkspaceContext;
  readonly cache: PreflightCache;
  readonly at: string;
  readonly preparing: boolean;
  readonly timeoutMs: number;
  /** The executor's single writer — passed, never duplicated. */
  readonly write: SerialWrite;
  /** stderr sink, append-only, owned by the executor. */
  readonly advisories: string[];
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
  let repoDir: string;
  try {
    repoDir = repoDirOf(parts.workspace, repo);
  } catch {
    return null;
  }
  const baseRef = parts.workspace.defaultBranches.get(repo) ?? FALLBACK_DEFAULT_BRANCH;
  const baseSha = await shaOf(repoDir, baseRef);
  const hash = commandHash(command, [...parts.workspace.commands]);
  const cached = baseResultFor(parts.cache.read(), repo, command, baseSha, {
    commandHash: hash,
    at: parts.at,
    prepare: parts.preparing,
  });
  if (cached !== null) return cached;

  const timeoutMs = parts.timeoutMs;
  let measured: BaseCommandResult;
  try {
    const outcome = await runDodCommand(command, repoDir, timeoutMs, parts.workspace.commands);
    const exitCode = outcome.timedOut ? 124 : outcome.exitCode;
    measured = {
      repo, command, baseRef, baseSha, exitCode, timedOut: outcome.timedOut, tail: outcome.tail,
      status: exitCode === 0 && !outcome.timedOut ? "ok" : "failed", commandHash: hash,
    };
  } catch (error) {
    if (!(error instanceof DodCommandRefused)) throw error;
    // The gate would not run it, so nothing was learned ABOUT THE BASE — and no
    // exit code is invented to say so (#165). `unmeasured` is the status that
    // already means this, and it still refuses nothing and excuses nothing. The
    // story-level DoD refuses it on its own terms; this must not double as a
    // second, differently-worded veto.
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
  return measured;
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
  const failures: BaseCommandResult[] = [];
  const seen = new Set<string>();
  for (const planned of stories) {
    for (const command of planned.dod.commands) {
      const key = `${planned.story.repo}\u0000${command}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const result = await baseResultOf(parts, planned.story.repo, command);
      if (result !== null && result.status === "failed") failures.push(result);
    }
  }
  if (failures.length === 0) return null;
  const first = failures[0];
  return {
    lines: [...baseRefusalLines(failures, parts.workspace)],
    error: first === undefined
      ? "a workspace command fails on the base tree"
      : `\`${first.command}\` exits ${String(first.exitCode ?? "?")} on the base tree of ${first.repo}`,
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
  readonly baseResult: (repo: string, command: string) => Promise<BaseCommandResult | null>;
}

export async function runStoryDod(parts: DodParts): Promise<readonly DodResult[]> {
  const timeoutMs = parts.timeoutMs;
  const results: DodResult[] = [];
  for (const command of parts.commands) {
    // Same allowlist the hook uses, same refusal. The Build executor runs a dod
    // block in a worktree for real; an undeclared command is a failed check
    // here, not a spawn.
    let result: DodResult;
    try {
      const outcome = await runDodCommand(command, parts.worktree, timeoutMs, parts.workspaceCommands);
      const exitCode = outcome.timedOut ? 124 : outcome.exitCode;
      const output = outcome.output ?? "";
      // Only a RED check's output is kept (#211). A green one has nothing anybody
      // has ever needed at 2am, and writing a file per passing command would put
      // megabytes of `npm test` chatter in every run dir — the record exists to
      // answer "why did this block", and a green command blocks nothing.
      const kept: DodOutputFile | null = exitCode === 0 && !outcome.timedOut
        ? null
        : writeDodOutput(parts.runDir, parts.storyId, results.length, output);
      const ran: DodResult = {
        command,
        status: "ran",
        exitCode,
        timedOut: outcome.timedOut,
        // #211: the failure-looking line, not the last line of stdout+stderr.
        // `outcome.tail` is the old reading and is kept only when there is no
        // output to choose from (a record replayed through an older seam).
        tail: kept === null ? outcome.tail : failureSummaryLine(output),
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
      result = { command, status: "refused", refusedBecause: error.message, timedOut: false, tail: "" };
    }
    results.push(result);
    const green = !dodRefused(result) && result.exitCode === 0 && !result.timedOut;
    parts.emit(green ? "check.passed" : "check.failed", {
      phase: parts.phaseId,
      check: "dod",
      story: parts.storyId,
      command,
      ...(dodRefused(result) ? {} : { exit_code: result.exitCode }),
      ...(dodRefused(result) ? { refused: result.refusedBecause ?? "" } : {}),
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
    });
    if (green) continue;
    // Issue #41, the second reader: a red command only faults the STORY if it
    // is green on the untouched base tree. The answer is normally already in
    // the run's cache — the Build-entry pre-flight put it there — and when it
    // is not (a run that entered Build on an older binary, a base that moved
    // under a reopened story) it is measured now rather than assumed. A base
    // that shares the failure halts the build instead of blocking the story.
    const base = await parts.baseResult(parts.repo, command);
    if (base !== null && base.status === "failed") {
      throw new BaseGateFailure(base, parts.storyId);
    }
    break;
  }
  return results;
}
