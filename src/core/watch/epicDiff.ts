/**
 * What the epic branch actually changed — read-only, through the runtime seam.
 *
 * The card is supposed to be derived "from what Build actually instrumented", and
 * the only artefact that knows that is the diff. Stories say what they INTENDED to
 * touch (`touches:` is written at Plan time, before a line of code exists); the
 * diff says what landed. Both go in the prompt, and where they disagree the diff
 * is the one that is evidence.
 *
 * Every command here reads: `rev-parse`, `diff --stat`, `diff --name-status`,
 * `diff --unified`. Nothing checks out, fetches or writes, so running Watch can
 * never disturb a branch someone is standing on. Anything unavailable — no repo,
 * no branch, no git — comes back as an ABSENCE the prompt states out loud, never
 * as a silent empty diff that would read as "nothing was instrumented".
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runtime } from "../runtime/index.ts";
import { parseYaml } from "../yaml.ts";
import { PROJECT_FRAMEWORK_DIR } from "../paths.ts";

export const GIT_BIN = "git";
/** `[assumption]` — a whole epic's unified diff can be megabytes; the prompt gets a bounded slice. */
export const MAX_DIFF_BYTES = 24 * 1024;
const GIT_TIMEOUT_MS = 30_000;

export interface RepoDiff {
  readonly repo: string;
  /** Absolute path of the repo, as workspace.yml places it. */
  readonly dir: string;
  readonly base: string;
  readonly branch: string;
  /** True when both refs resolved and the diff below is real. */
  readonly resolved: boolean;
  /** Why there is no diff, when `resolved` is false. */
  readonly reason: string | null;
  readonly stat: string;
  readonly nameStatus: string;
  /** Unified diff, truncated to `MAX_DIFF_BYTES`. */
  readonly patch: string;
  readonly truncated: boolean;
}

export interface DiffRequest {
  readonly repo: string;
  readonly dir: string;
  /** The repo's `default_branch` from workspace.yml. */
  readonly base: string;
  /** The epic's `branch:` (spec §2.14). */
  readonly branch: string;
}

export async function epicDiff(request: DiffRequest): Promise<RepoDiff> {
  const absent = (reason: string): RepoDiff => ({
    ...request, resolved: false, reason, stat: "", nameStatus: "", patch: "", truncated: false,
  });

  if (request.branch === "") return absent("the epic declares no branch");
  for (const ref of [request.base, request.branch]) {
    const check = await git(request.dir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    if (check.exitCode !== 0) return absent(`\`${ref}\` does not resolve in ${request.repo}`);
  }

  const range = `${request.base}...${request.branch}`;
  const stat = await git(request.dir, ["diff", "--stat", range]);
  if (stat.exitCode !== 0) return absent(`\`git diff ${range}\` failed in ${request.repo}`);
  const nameStatus = await git(request.dir, ["diff", "--name-status", range]);
  const patch = await git(request.dir, ["diff", "--unified=3", range]);

  const full = patch.stdout;
  const truncated = Buffer.byteLength(full, "utf8") > MAX_DIFF_BYTES;
  return {
    ...request,
    resolved: true,
    reason: null,
    stat: stat.stdout.trimEnd(),
    nameStatus: nameStatus.stdout.trimEnd(),
    patch: truncated ? Buffer.from(full, "utf8").subarray(0, MAX_DIFF_BYTES).toString("utf8") : full,
    truncated,
  };
}

/** One `## <repo>` block per diff, ready to inline in a prompt. */
export function renderDiffs(diffs: readonly RepoDiff[]): string {
  if (diffs.length === 0) {
    return "_No repo could be diffed: this run declares none, or the epic named no branch._";
  }
  const out: string[] = [];
  for (const diff of diffs) {
    out.push(`### \`${diff.repo}\` — \`${diff.base}...${diff.branch}\``, "");
    if (!diff.resolved) {
      out.push(
        `_Not diffed: ${diff.reason ?? "unavailable"}. Treat this feature's code as UNSEEN — `
        + "cite `absent:` rather than guessing at what it emits._",
        "",
      );
      continue;
    }
    if (diff.stat === "" && diff.nameStatus === "") {
      out.push("_The branch is identical to the base: nothing landed on it._", "");
      continue;
    }
    out.push("```", diff.nameStatus, "", diff.stat, "```", "");
    if (diff.patch.trim() !== "") {
      if (diff.truncated) {
        out.push(`_First ${String(MAX_DIFF_BYTES)} bytes of the patch only — the rest was not inlined._`, "");
      }
      out.push("```diff", diff.patch.replace(/\n$/, ""), "```", "");
    }
  }
  return out.join("\n");
}

export interface RepoBase {
  /** Path relative to the workspace root, as `workspace.yml` records it. */
  readonly path: string;
  readonly defaultBranch: string;
}

/**
 * `workspace.yml`'s repos, with the one field `loadWorkspace` drops: the branch an
 * epic was cut FROM (spec §2.1, §2.14). Without it there is nothing to diff
 * against, and guessing `main` would produce a confident, wrong diff on any repo
 * that uses `master` or `develop`. A repo with no `default_branch` is skipped,
 * which shows up as an absence in the prompt.
 */
export function readRepoBases(root: string): ReadonlyMap<string, RepoBase> {
  const bases = new Map<string, RepoBase>();
  const path = join(root, PROJECT_FRAMEWORK_DIR, "workspace.yml");
  if (!existsSync(path)) return bases;
  let doc: unknown;
  try {
    doc = parseYaml(readFileSync(path, "utf8"));
  } catch {
    return bases;
  }
  const list = (doc as { repos?: unknown } | null)?.repos;
  if (!Array.isArray(list)) return bases;
  for (const row of list as { name?: unknown; path?: unknown; default_branch?: unknown }[]) {
    if (typeof row?.name !== "string" || typeof row.default_branch !== "string") continue;
    bases.set(row.name, {
      path: typeof row.path === "string" ? row.path : ".",
      defaultBranch: row.default_branch,
    });
  }
  return bases;
}

async function git(cwd: string, args: readonly string[]): Promise<{ exitCode: number; stdout: string }> {
  const outcome = await runtime.spawn(GIT_BIN, args, { cwd, timeoutMs: GIT_TIMEOUT_MS });
  return { exitCode: outcome.timedOut ? 124 : outcome.exitCode, stdout: outcome.stdout };
}
