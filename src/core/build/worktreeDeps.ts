/**
 * A story worktree's DEPENDENCIES: the declared `install:` run inside it before a
 * developer is dispatched, and the reading of an exit 127 that says the tree
 * never had the binary the Definition of Done needed (gh #209).
 *
 * The measurement this file exists for, on a real multi-repo workspace
 * (tldrx 0.14.2, 2026-09-09): the Build-entry pre-flight ran `npm run test` in
 * the human's checkout and got **exit 0**, `Ran all test suites.`; minutes later
 * the SAME command, same repo, in the story's fresh worktree recorded
 * `{"check":"dod","exit_code":127,"detail":"sh: jest: command not found"}`, and
 * the story blocked with a full developer turn already paid for. Nothing about
 * the story was wrong. The base tree has `node_modules`; a fresh `git worktree`
 * does not, and until this file nothing installed anything in one — `install:`
 * was a slot `templates/workspace.yml` wrote and no code read.
 *
 * `dodRunner.ts`'s own header states the other half of the trap in as many
 * words: the base pre-flight deliberately runs in the checkout because "a
 * pristine worktree would fail half the world's repos for want of
 * `node_modules`". That reason applies to the story's tree untouched, and this
 * is the answer to it.
 *
 * Two halves, and they are deliberately not the same mechanism:
 *
 *   - **Declared** `install:` — run it, in the worktree, through the SAME
 *     allowlist-and-argv runner the DoD uses, recorded as its own check with an
 *     exit code and a duration so its cost is visible instead of folded into the
 *     story's turn. A failed install blocks the story with what it printed.
 *   - **Undeclared** — nothing is guessed. Not `npm ci`, not `yarn`, not a
 *     symlink of the base tree's `node_modules`. What the framework does instead
 *     is REFUSE TO CALL IT A RED TEST: an exit 127 is named as an environment
 *     absence, with the one edit that fixes it, which is the absent-with-reason
 *     rule applied to an exit code.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DodCommandRefused, runDodCommand } from "../../hooks/lib/story.ts";
import type { WorkspaceContext } from "../../hooks/lib/workspace.ts";
import type { EventType } from "../events/Event.ts";
import type { DodResult } from "./outcome.ts";

/**
 * The `commands:` key an install lives under — the same slot
 * `templates/workspace.yml` has always written, now with a reader.
 */
export const INSTALL_SLOT = "install";

/**
 * The declared install command for one repo, or null when the slot is empty.
 *
 * Read from `commandRoles` (slot -> command), never guessed from the command
 * TEXT: `install: pnpm i --frozen-lockfile` has no "install" in it, and the
 * measured .NET precedent for that mistake is in `hooks/lib/workspace.ts`.
 */
export function installCommandFor(workspace: WorkspaceContext, repo: string): string | null {
  return workspace.commandRoles.get(repo)?.get(INSTALL_SLOT) ?? null;
}

/** One install, measured: what ran, what it exited, and how long it cost. */
export interface InstallCheck {
  readonly command: string;
  /** Absent — and only ever absent — when the gate REFUSED to run the command. */
  readonly exitCode?: number;
  readonly timedOut: boolean;
  readonly tail: string;
  readonly refusedBecause?: string;
  /** Wall time of the install, in ms. Measured around the spawn, here. */
  readonly durationMs: number;
}

export function installFailed(check: InstallCheck): boolean {
  return check.refusedBecause !== undefined || check.timedOut || check.exitCode !== 0;
}

/** What `runWorktreeInstall` needs, as DATA: no `ctx`, no session. */
export interface InstallParts {
  readonly storyId: string;
  readonly repo: string;
  readonly worktree: string;
  readonly command: string;
  readonly workspaceCommands: ReadonlySet<string>;
  readonly timeoutMs: number;
  readonly phaseId: string;
  readonly emit: (type: EventType, payload: Record<string, unknown>) => void;
}

/**
 * Run the declared `install:` in a story's FRESH worktree, before the developer.
 *
 * Through `runDodCommand`, so the install obeys the byte-equality allowlist and
 * the argv-no-shell split every other workspace command obeys — an install is
 * not a privileged string, and one that needs a shell is refused here exactly as
 * a `test:` would be.
 *
 * `duration_ms` is on the event because the whole complaint in #209 is that this
 * work was invisible: an install that takes 90 s per story is a number an
 * operator has to be able to see next to the turn it precedes.
 */
export async function runWorktreeInstall(parts: InstallParts): Promise<InstallCheck> {
  const started = Date.now();
  let check: InstallCheck;
  try {
    const outcome = await runDodCommand(
      parts.command, parts.worktree, parts.timeoutMs, parts.workspaceCommands,
    );
    check = {
      command: parts.command,
      exitCode: outcome.timedOut ? 124 : outcome.exitCode,
      timedOut: outcome.timedOut,
      tail: outcome.tail,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    if (!(error instanceof DodCommandRefused)) throw error;
    // NOTHING RAN, so no exit code is written — the same rule #165 settled for
    // the DoD, and for the same reason: a fabricated exit is read as a
    // measurement by every document downstream.
    check = {
      command: parts.command,
      timedOut: false,
      tail: error.message,
      refusedBecause: error.message,
      durationMs: Date.now() - started,
    };
  }
  const failed = installFailed(check);
  parts.emit(failed ? "check.failed" : "check.passed", {
    phase: parts.phaseId,
    check: INSTALL_SLOT,
    story: parts.storyId,
    repo: parts.repo,
    command: check.command,
    ...(check.refusedBecause === undefined ? { exit_code: check.exitCode } : { refused: check.refusedBecause }),
    duration_ms: check.durationMs,
    tree: WORKTREE_TREE,
    detail: failed ? (check.refusedBecause ?? check.tail) : "",
  });
  return check;
}

/** One sentence for a story blocked by its own install — never a silent skip. */
export function installFailureReason(check: InstallCheck, repo: string): string {
  if (check.refusedBecause !== undefined) {
    return `\`${check.command}\` (the \`${INSTALL_SLOT}:\` command for repo ${repo}) was REFUSED and never ran — `
      + `${check.refusedBecause}`;
  }
  return `\`${check.command}\` (the \`${INSTALL_SLOT}:\` command for repo ${repo}) exited `
    + `${String(check.exitCode ?? "?")}${check.timedOut ? " (timed out)" : ""} in the story worktree — `
    + `${check.tail}. The developer was not dispatched: a tree whose dependencies did not install `
    + "cannot prove anything.";
}

/**
 * Which tree a check ran in. On the story's DoD check since #209, because the
 * events were the only place the discrepancy lived and they did not say: the
 * pre-flight's green and the story's 127 were the same command, and nothing in
 * either record said they were different trees.
 */
export const WORKTREE_TREE = "worktree";

/** What an exit 127 in a story worktree turned out to be, as data. */
export interface AbsentBinary {
  /** The name the shell could not find, when it said one. Null when it did not. */
  readonly binary: string | null;
  /** `install:` is declared for this repo — so this absence survived an install. */
  readonly installDeclared: boolean;
  readonly baseHasNodeModules: boolean;
  readonly worktreeHasNodeModules: boolean;
}

/**
 * `sh: jest: command not found` → `jest`. Null when the tail names nothing.
 *
 * Two shells' spellings, because the one measured in #209 is `sh`'s and zsh
 * inverts it. A tail that matches neither still leaves a 127 a 127 — the exit
 * code is the finding; the name is the courtesy.
 */
export function notFoundBinary(tail: string): string | null {
  // zsh FIRST. `zsh: command not found: jest` also satisfies the sh pattern
  // below, and it satisfies it with `zsh` — the shell's own name reported as the
  // missing binary, which is a wrong answer in the confident direction.
  const zsh = /(?:command\s+)?not found:\s*(\S+)/i.exec(tail);
  if (zsh?.[1] !== undefined) return zsh[1];
  const sh = /([^\s:]+):\s*(?:command\s+)?not found/i.exec(tail);
  return sh?.[1] ?? null;
}

export interface AbsenceProbe {
  readonly worktree: string;
  readonly repoDir: string;
  readonly installDeclared: boolean;
}

/**
 * Read an exit 127 as what it is, or return null and let it be a red.
 *
 * **127 is `command not found`** — it is the one exit code that means the tree,
 * not the code. A test runner that legitimately exits 127 does not exist in any
 * repo measured here, and the alternative (calling an absent binary a failing
 * suite) is precisely the dangerous direction: it blames the story for the
 * environment and spends the next attempt proving the same 127 again.
 *
 * `binary` is `[inferred]` from the tail and may be null; the 127 itself is
 * `[measured]`. The `node_modules` pair is `[measured]` too — plain `existsSync`
 * on both trees — and it is what turns "declare `install:`" from advice into a
 * sentence naming the difference between the two trees.
 */
export function absentBinaryOf(result: DodResult, probe: AbsenceProbe): AbsentBinary | null {
  if (result.status === "refused" || result.timedOut || result.exitCode !== 127) return null;
  return {
    binary: notFoundBinary(result.tail),
    installDeclared: probe.installDeclared,
    baseHasNodeModules: existsSync(join(probe.repoDir, "node_modules")),
    worktreeHasNodeModules: existsSync(join(probe.worktree, "node_modules")),
  };
}

/**
 * The exported marker a test asserts on, and an operator greps for. It is a
 * PHRASE, not an English word: a bare word matches innocent prose (§8).
 */
export const BINARY_ABSENT_MARKER = "test command's binary is absent in the worktree";

/**
 * Why the story is blocked, when a DoD command exited 127 in a tree that never
 * had the binary.
 *
 * Everything it can offer, and nothing it cannot: it names the absent binary
 * when the shell named one, names the one workspace.yml edit that fixes it, and
 * REFUSES to guess an installer — a lockfile plus a package manager is not a
 * declaration, and `npm ci` chosen by the framework is a command nobody
 * approved. The symlink is named as an option and explicitly NOT taken:
 * `node_modules` is hoisted and cached per tree, so a shared one is a decision
 * about correctness that belongs to the repo.
 */
export function binaryAbsentReason(result: DodResult, repo: string, absent: AbsentBinary): string {
  const named = absent.binary === null ? "" : ` (\`${absent.binary}\`: command not found)`;
  const lines = [
    `\`${result.command}\` exited 127 in repo ${repo} — the ${BINARY_ABSENT_MARKER}${named}, `
    + "so this is an ENVIRONMENT absence and not a red test: the command never ran.",
  ];
  if (absent.installDeclared) {
    lines.push(
      `The \`${INSTALL_SLOT}:\` command for ${repo} DID run in this worktree before the developer `
      + "and still left the binary absent — check what it installs.",
    );
  } else {
    lines.push(
      `Declare \`${INSTALL_SLOT}:\` under repo ${repo}'s \`commands:\` in .tldrx/workspace.yml and tldrx `
      + "will run it in every story worktree before the developer. tldrx does not guess an installer "
      + "from a lockfile — `npm ci` is a command your team declares, not one the framework picks.",
    );
  }
  if (absent.baseHasNodeModules && !absent.worktreeHasNodeModules) {
    lines.push(
      "The base tree has `node_modules` and this worktree does not. Sharing them (a symlink) is an "
      + "option and tldrx does not create one: hoisting and cache layout are per-tree facts, and a "
      + "shared tree can be silently wrong.",
    );
  }
  return lines.join(" ");
}
