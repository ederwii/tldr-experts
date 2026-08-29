/**
 * `tldrx init` step 1: detect (concept §4.1).
 *
 * Deterministic and offline. Reads the filesystem and runs `git`; never an LLM,
 * never the network, never a build.
 */
import { join } from "node:path";
import { detectCi } from "./ci.ts";
import { detectCommands } from "./commands.ts";
import { detectDefaultBranch } from "./defaultBranch.ts";
import { findRepos } from "./findRepos.ts";
import { detectStack } from "./stack.ts";
import { scoreConfidence } from "./confidence.ts";
import { repoSlug, uniqueSlug } from "./repoSlug.ts";
import { toPosix } from "./walk.ts";
import type { CommandRunner } from "./CommandRunner.ts";
import type { DetectedRepo, DetectedWorkspace, Evidence } from "./types.ts";
import { basename } from "node:path";

export async function detectWorkspace(root: string, runner: CommandRunner): Promise<DetectedWorkspace> {
  const { mode, rootIsRepo, repoDirs } = await findRepos(root);
  const evidence: Evidence[] = [
    {
      claim: mode === "multi-repo"
        ? `Multi-repo workspace: ${repoDirs.length} child directories are git repos`
        : "Single-repo workspace: the root itself is the only git repo",
      src: mode === "multi-repo"
        ? `${toPosix(join(repoDirs[0] ?? ".", ".git"))}:1`
        : ".git/HEAD:1",
      workspaceScoped: true,
    },
  ];

  const taken = new Set<string>();
  const repos: DetectedRepo[] = [];

  for (const dir of repoDirs) {
    const absPath = dir === "." ? root : join(root, dir);
    const name = uniqueSlug(repoSlug(dir === "." ? basename(root) : dir), taken);
    taken.add(name);

    const stack = await detectStack(absPath);
    const commands = await detectCommands(absPath, stack);
    const ci = await detectCi(absPath);
    const branch = await detectDefaultBranch(runner, absPath);

    const repoEvidence: Evidence[] = [...stack.evidence, ...commands.evidence];
    repoEvidence.push(
      branch.measured
        ? { claim: `Default branch is \`${branch.branch}\``, src: "$ git symbolic-ref refs/remotes/origin/HEAD → exit 0" }
        : { claim: `No origin/HEAD; default branch assumed \`${branch.branch}\``, src: "absent:.git/refs/remotes/origin/HEAD" },
    );
    for (const file of ci) repoEvidence.push({ claim: `CI definition: \`${file}\``, src: `${file}:1` });
    if (stack.manifests.length === 0) {
      repoEvidence.push({ claim: "No build manifest found — stack unknown", src: "absent:package.json" });
    }

    repos.push({
      name,
      path: dir === "." ? "." : toPosix(dir),
      absPath,
      defaultBranch: branch.branch,
      stack: stack.stack,
      languages: stack.languages,
      packageManager: stack.packageManager,
      manifests: stack.manifests,
      commands: commands.commands,
      ci,
      confidence: scoreConfidence(commands.commands, stack.manifests.length),
      evidence: repoEvidence,
    });
  }

  return { mode, rootIsRepo, root, repos, evidence };
}
