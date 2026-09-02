/**
 * Does every repo actually HAVE the `default_branch` the workspace records for it?
 *
 * `.tldrx/workspace.yml` is a RECORD, not a guess: `tldrx init` detected each
 * `default_branch:` from the repo in front of it and wrote it down (spec §2.1).
 * The record can then go stale without anything erroring — a `master`→`main`
 * rename, a fresh clone that has only the remote's branches, a repo pointed at a
 * different checkout, a misdetection on a repo with no commits yet.
 *
 * Nothing notices, because every consumer treats the failure as an ABSENCE:
 *
 *   - Watch used to render `` `main`, the `default_branch` of api, does not
 *     resolve there. Treat this feature's code as UNSEEN `` — an instruction that
 *     produces an all-`absent:` card, which PASSES `claim-sources` and covers
 *     nothing. It now refuses (gh #92); this is the surface that tells you WHY
 *     before you hit the refusal.
 *   - `boundary` reports `n/a (nothing could be diffed)` at every Build gate, so
 *     the condition silently stops measuring for as long as the record is wrong.
 *
 * `doctor` is exactly the right home for the question: it is the one command
 * whose job is "what does this machine and this workspace actually have", and
 * the answer here is a fact about a file, not about a run.
 *
 * A WARNING, never a blocker — `DoctorReport.healthy` is about the TOOLS this
 * machine has, the same call `gitignoreShadow` and `legacyVersionKeys` make. The
 * concrete reason to keep it out of the exit code: a repo can be legitimately
 * mid-clone or mid-rename on a developer's box, and a `doctor` that exits 1 for
 * that is a `doctor` people stop running.
 *
 * Read-only and bounded: one `git rev-parse --verify --quiet` per repo declared
 * in `workspace.yml`, nothing fetched, nothing checked out, nothing written.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runtime } from "../runtime/index.ts";
import { parseYaml } from "../yaml.ts";
import { PROJECT_FRAMEWORK_DIR, PROJECT_WORKSPACE_FILE } from "../paths.ts";

/** A local `rev-parse` is milliseconds; this only catches a hung git. */
const GIT_TIMEOUT_MS = 15_000;

/** Where the record lives — named in every message, because it is the fix. */
export const WORKSPACE_YML_REL = PROJECT_WORKSPACE_FILE;

/** One repo whose RECORDED default branch its own checkout cannot find. */
export interface RecordedDefaultBranch {
  readonly repo: string;
  /** Workspace-relative, as `workspace.yml` places it. */
  readonly path: string;
  /** The `default_branch:` value `workspace.yml` RECORDS. */
  readonly branch: string;
  /** What git said, first line — so the finding is never just an assertion. */
  readonly detail: string;
}

/**
 * A repo that was not asked about, and why.
 *
 * Never folded into "all resolve": a repo that is not on disk has not been
 * checked, and reporting it as healthy would be the same class of mistake this
 * whole module exists to catch.
 */
export interface SkippedRepo {
  readonly repo: string;
  readonly reason: string;
}

export interface DefaultBranchAudit {
  /**
   * False when there was no `workspace.yml` to read, or it would not parse —
   * which is not the same claim as "nothing is wrong".
   */
  readonly ran: boolean;
  readonly error: string | null;
  /** Every repo actually asked about, by name, so the report can size the sample. */
  readonly probed: readonly string[];
  readonly unresolved: readonly RecordedDefaultBranch[];
  readonly skipped: readonly SkippedRepo[];
}

interface DeclaredRepo {
  readonly name: string;
  readonly path: string;
  readonly branch: string;
}

export async function findUnresolvedDefaultBranches(root: string): Promise<DefaultBranchAudit> {
  const declared = readDeclaredRepos(root);
  if (declared === null) {
    return {
      ran: false,
      error: `${WORKSPACE_YML_REL} is missing or does not parse`,
      probed: [],
      unresolved: [],
      skipped: [],
    };
  }

  const probed: string[] = [];
  const unresolved: RecordedDefaultBranch[] = [];
  const skipped: SkippedRepo[] = [];

  for (const repo of declared) {
    if (repo.branch === "") {
      // Spec §2.1 lets `default_branch` be absent and every consumer then assumes
      // `main`. Nothing was RECORDED here, so there is no record to contradict.
      skipped.push({ repo: repo.name, reason: `${WORKSPACE_YML_REL} records no \`default_branch\`` });
      continue;
    }
    const dir = join(root, repo.path);
    if (!existsSync(dir)) {
      skipped.push({ repo: repo.name, reason: `\`${repo.path}\` is not on disk` });
      continue;
    }
    const check = await runtime.spawn(
      "git",
      ["rev-parse", "--verify", "--quiet", `${repo.branch}^{commit}`],
      { cwd: dir, timeoutMs: GIT_TIMEOUT_MS },
    );
    if (check.timedOut) {
      skipped.push({ repo: repo.name, reason: "`git rev-parse` timed out" });
      continue;
    }
    // 128 is a fatal git error — "not a git repository" is the one that matters
    // here, and it is a different problem from a branch that is simply not there.
    if (check.exitCode === 128 || check.exitCode === 127) {
      skipped.push({
        repo: repo.name,
        reason: firstLine(check.stderr) || `git exited ${String(check.exitCode)}`,
      });
      continue;
    }
    probed.push(repo.name);
    if (check.exitCode === 0) continue;
    unresolved.push({
      repo: repo.name,
      path: repo.path,
      branch: repo.branch,
      detail: `\`git rev-parse --verify ${repo.branch}\` exits ${String(check.exitCode)} in \`${repo.path}\``,
    });
  }

  return { ran: true, error: null, probed, unresolved, skipped };
}

/**
 * `workspace.yml`'s repos, with the two fields this asks about. Null when the
 * file is missing or unreadable — the caller reports that as "did not run", not
 * as "found nothing".
 */
function readDeclaredRepos(root: string): readonly DeclaredRepo[] | null {
  const path = join(root, PROJECT_FRAMEWORK_DIR, "workspace.yml");
  if (!existsSync(path)) return null;
  let doc: unknown;
  try {
    doc = parseYaml(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  const list = (doc as { repos?: unknown } | null)?.repos;
  if (!Array.isArray(list)) return null;
  const out: DeclaredRepo[] = [];
  for (const row of list as { name?: unknown; path?: unknown; default_branch?: unknown }[]) {
    if (typeof row?.name !== "string" || row.name === "") continue;
    out.push({
      name: row.name,
      path: typeof row.path === "string" && row.path !== "" ? row.path : ".",
      branch: typeof row.default_branch === "string" ? row.default_branch : "",
    });
  }
  return out;
}

function firstLine(text: string): string {
  return text.split("\n")[0]?.trim() ?? "";
}
