/**
 * Finding a knowledge file a trainer wrote into the wrong repo — and getting it back.
 *
 * **The bug this exists for, measured 2026-08-31** on a ten-expert batch over a
 * five-repo workspace: a training sub-agent ran `cd <workspace>/whiteboard` to
 * execute that repo's declared gate command, then wrote its knowledge file to the
 * RELATIVE path `.tldrx/experts/mcp/knowledge/mcp.md.partial`. The relative path
 * resolved against the repo it had `cd`'d into, so 9,567 bytes of finished, paid
 * work landed at `whiteboard/.tldrx/experts/mcp/knowledge/mcp.md.partial` — inside
 * an unrelated git repo, which then reported `?? .tldrx/`. The framework looked
 * where it had asked for the file, found nothing, and rejected the run with
 * "was never written". $1.23 for a file that existed the whole time.
 *
 * Two fixes, and this module is the second one. The FIRST is prevention: the
 * training prompt now states an absolute output path and says why
 * (`trainingPrompt.ts`). This one is recovery, for the write that happens anyway —
 * an older prompt in a cache bundle, a `--commit` handoff, a model that
 * reconstructs the path from the repo-relative form it saw elsewhere.
 *
 * **Two guards keep this from stealing a file that is not ours.**
 *
 *   1. A repo whose root resolves to the WORKSPACE root is skipped. That is the
 *      real target, it has already been checked, and "recovering" it onto itself
 *      would be a no-op dressed as a rescue.
 *   2. A repo carrying its OWN `.tldrx/workspace.yml` is skipped entirely. A
 *      nested tldrx workspace may legitimately hold an expert of the same name
 *      training the same area, and taking that file would be theft rather than
 *      recovery. A parasitic tree written by a confused `cd` has no
 *      `workspace.yml` in it — the sub-agent only ever wrote the one file.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { PROJECT_FRAMEWORK_DIR } from "../paths.ts";

export interface StrayProbe {
  /** The repos to look in, as `expertRepos` returns them: name plus a root-relative path. */
  readonly repos: readonly { readonly name: string; readonly path: string }[];
  readonly root: string;
  readonly expert: string;
  /** `knowledge/<area>.md.partial` — the path the prompt asked for, expert-relative. */
  readonly output: string;
}

export interface StrayWrite {
  /** Absolute path of the file, where it actually landed. */
  readonly path: string;
  /** The declared repo it landed in. */
  readonly repo: string;
  /** That repo's absolute root. */
  readonly repoPath: string;
}

export interface StrayRecovery {
  readonly stray: StrayWrite;
  /** True when the bytes now sit at the path the framework validates. */
  readonly recovered: boolean;
  /**
   * What is still on disk in the foreign repo after the move — the deepest
   * directory that could not be pruned because something else lives in it, or
   * `null` when the whole parasitic tree came out cleanly.
   */
  readonly leftBehind: string | null;
}

/**
 * The first declared repo holding the file at the path the trainer was asked for,
 * or null when no repo does.
 *
 * First rather than all, deliberately: a sub-agent writes the file once, so a
 * second hit would mean two different runs left strays and picking either is a
 * guess. The repos are walked in declaration order, which is the order
 * `workspace.yml` lists them, so the answer is at least reproducible.
 */
export function findStrayWrite(probe: StrayProbe): StrayWrite | null {
  const root = resolve(probe.root);
  for (const repo of probe.repos) {
    const repoPath = resolve(join(probe.root, repo.path));
    if (repoPath === root) continue;
    if (existsSync(join(repoPath, PROJECT_FRAMEWORK_DIR, "workspace.yml"))) continue;
    const candidate = join(repoPath, PROJECT_FRAMEWORK_DIR, "experts", probe.expert, probe.output);
    if (!existsSync(candidate)) continue;
    return { path: candidate, repo: repo.name, repoPath };
  }
  return null;
}

/**
 * Move a stray file to where the framework validates it, and take the empty
 * directories it created in the foreign repo out with it.
 *
 * Only EMPTY directories are removed, and only the ones between the file and the
 * stray `.tldrx/` inclusive. That rule is what makes this safe to run inside
 * somebody else's git repo: a directory with anything else in it is left exactly
 * as it was found and NAMED in the result, so the operator cleans it themselves
 * rather than discovering later that a tool deleted something in a repo it was
 * never asked to touch.
 */
export function recoverStrayWrite(stray: StrayWrite, dest: string): StrayRecovery {
  mkdirSync(dirname(dest), { recursive: true });
  try {
    renameSync(stray.path, dest);
  } catch {
    // A rename across devices throws. The bytes matter more than the syscall.
    try {
      writeFileSync(dest, readFileSync(stray.path, "utf8"), "utf8");
      unlinkSync(stray.path);
    } catch {
      return { stray, recovered: existsSync(dest), leftBehind: stray.path };
    }
  }
  return { stray, recovered: existsSync(dest), leftBehind: pruneEmpty(stray) };
}

/** Remove the now-empty parasitic dirs, stopping at the first that is not empty. */
function pruneEmpty(stray: StrayWrite): string | null {
  const stop = join(stray.repoPath, PROJECT_FRAMEWORK_DIR);
  let dir = dirname(stray.path);
  for (;;) {
    if (!dir.startsWith(stop)) return null;
    if (!existsSync(dir)) {
      if (dir === stop) return null;
      dir = dirname(dir);
      continue;
    }
    if (readdirSync(dir).length > 0) return dir;
    try {
      rmdirSync(dir);
    } catch {
      return dir;
    }
    if (dir === stop) return null;
    dir = dirname(dir);
  }
}

/**
 * What the operator is told, and it says three things on purpose: the file was
 * recovered (so the cost was not wasted), where it had actually been written (so
 * the cause is legible), and whether anything is still sitting in the foreign
 * repo (so `git status` over there is not a surprise).
 */
export function describeStrayRecovery(root: string, recovery: StrayRecovery, rel: string): readonly string[] {
  const at = relative(root, recovery.stray.path);
  if (!recovery.recovered) {
    return [
      `  found the missing file at ${at} — inside the \`${recovery.stray.repo}\` repo, not this workspace —`,
      "  but it could not be moved back, so it was NOT validated and nothing was kept",
    ];
  }
  const lines = [
    `  recovered: the trainer wrote to ${at}, inside the \`${recovery.stray.repo}\` repo — a relative`,
    `  \`${PROJECT_FRAMEWORK_DIR}/…\` path resolves against whatever directory it had \`cd\`'d into. The file was`,
    `  moved to ${rel} and validated there; nothing about the verdict was softened.`,
  ];
  lines.push(recovery.leftBehind === null
    ? `  the stray \`${PROJECT_FRAMEWORK_DIR}/\` tree it created in \`${recovery.stray.repo}\` was empty afterwards and removed`
    : `  ${relative(root, recovery.leftBehind)} is not empty and was LEFT in place — check `
      + `\`git -C ${relative(root, recovery.stray.repoPath) || "."} status\``);
  return lines;
}
