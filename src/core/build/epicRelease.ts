/**
 * Releasing an epic branch a FINISHED run claimed, so the name is free for the
 * next run of the same feature (gh #272).
 *
 * Measured 2026-09-13 on a headless proof run: run A cut `epic/main-ci-green`,
 * was cancelled, and the ordinary retry — same feature, id `…-2` — reached Build
 * and was refused for stacking onto "someone else's epic". The stale epic had zero
 * commits beyond `main`; A's only work sat on its story branch (#129). $3.70 of
 * what/how/plan died at Build on a leftover nothing in the workflow cleaned up.
 *
 * ONE rule, two callers. `tldrx run cancel` releases its own claims; a later
 * run's Build releases a leftover whose owner is explicitly finished. Either way:
 *
 *   - **no commit beyond the base → deleted.** There is nothing to lose: the
 *     branch is the base under another name.
 *   - **commits beyond the base → renamed to `epic/<slug>@<run-id>`.** The name is
 *     free and the commits survive under one that says whose they were. Never a
 *     delete: "recoverable" has to mean recoverable by name, not by reflog.
 *   - **checked out somewhere → left alone, with the checkout named.** A branch a
 *     worktree sits on is somebody's working state.
 *   - **could not be counted → left alone, with git's sentence.** `commitsAhead`
 *     answers `null` rather than 0 for a base that does not resolve, because a
 *     miscounted 0 here deletes commits.
 *
 * Story branches are never touched: `story/<run>/<story>` is where a cancelled
 * run's work lives (#129), and it cannot collide.
 *
 * What was done is written where a person reads it, not only in the branch list:
 * the owner run's `build.epic_released` (§2.2, additive), its `04-build/handoff.md`
 * when there is one, and an `epic.released` event on its ledger — plus, from Build,
 * on the requesting run's own ledger through `emitAlso`.
 */
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadWorkspace, type WorkspaceContext } from "../../hooks/lib/workspace.ts";
import type { EventType, TldrxEvent } from "../events/Event.ts";
import type { EpicReleaseRecord, EpicReleaseVia } from "../run/RunFile.ts";
import type { RunStore } from "../run/RunStore.ts";
import {
  branchExists, commitsAhead, deleteBranch, firstLine, renameBranch, repoDirOf, shaOf, worktreeOn,
} from "./git.ts";
import { BUILD_PHASE } from "./plan.ts";

/**
 * `epic/<slug>@<run-id>` — the ONE derivation of the aside name.
 *
 * `@` because it reads as "at": the epic as it stood under that run. It is a
 * legal ref character anywhere but alone or before `{` (`git check-ref-format`),
 * and it cannot collide with a live epic, whose name never carries a run id
 * (spec §5: an epic is the unit a team merges).
 */
export const ASIDE_SEPARATOR = "@";

export function asideBranchOf(epicBranch: string, ownerRunId: string): string {
  return `${epicBranch}${ASIDE_SEPARATOR}${ownerRunId}`;
}

/** What `releaseEpicBranch` needs, as data. */
export interface ReleaseParts {
  readonly repoDir: string;
  readonly branch: string;
  /** The repo's default branch — what the epic was cut from (§2.1 `default_branch`). */
  readonly base: string;
  /** The run that cut the branch. Names the aside branch. */
  readonly ownerRunId: string;
}

export type EpicRelease =
  | { readonly kind: "deleted"; readonly branch: string; readonly sha: string }
  | { readonly kind: "renamed"; readonly branch: string; readonly to: string; readonly commits: number; readonly sha: string }
  /** Left exactly where it was, and this is why. */
  | { readonly kind: "kept"; readonly branch: string; readonly reason: string }
  /** No such branch — nothing to release. */
  | { readonly kind: "absent"; readonly branch: string };

export async function releaseEpicBranch(parts: ReleaseParts): Promise<EpicRelease> {
  const { repoDir, branch } = parts;
  if (!(await branchExists(repoDir, branch))) return { kind: "absent", branch };
  const checkout = await worktreeOn(repoDir, branch);
  if (checkout !== null) {
    return { kind: "kept", branch, reason: `it is checked out in ${checkout}` };
  }
  const commits = await commitsAhead(repoDir, parts.base, branch);
  if (commits === null) {
    return {
      kind: "kept", branch,
      reason: `\`git rev-list --count ${parts.base}..${branch}\` could not count what it carries, `
        + "and an uncounted branch is never deleted",
    };
  }
  const sha = await shaOf(repoDir, branch);
  if (commits === 0) {
    const deleted = await deleteBranch(repoDir, branch);
    if (!deleted.ok) return { kind: "kept", branch, reason: `\`git branch -D\` failed — ${firstLine(deleted.stderr)}` };
    return { kind: "deleted", branch, sha };
  }
  const to = asideBranchOf(branch, parts.ownerRunId);
  if (await branchExists(repoDir, to)) {
    return { kind: "kept", branch, reason: `\`${to}\` already exists, so there is nowhere to move it` };
  }
  const renamed = await renameBranch(repoDir, branch, to);
  if (!renamed.ok) return { kind: "kept", branch, reason: `\`git branch -m\` failed — ${firstLine(renamed.stderr)}` };
  return { kind: "renamed", branch, to, commits, sha };
}

/** What `releaseRunEpics` needs to release a finished run's claims and say so. */
export interface ReleaseRunEpicsParts {
  readonly root: string;
  /** The run whose claim is released. Its run.yml, handoff and ledger take the record. */
  readonly owner: RunStore;
  readonly actor: string;
  readonly at: string;
  readonly via: EpicReleaseVia;
  readonly reason: string;
  /** Build only: the one `repo:branch` that collided. Absent: every claimed branch in every repo. */
  readonly only?: { readonly repo: string; readonly branch: string };
  /** Build only: the requesting run's own ledger, which gets the same event. */
  readonly emitAlso?: (type: EventType, payload: Record<string, unknown>) => void;
}

export interface KeptEpic {
  readonly branch: string;
  readonly repo: string;
  readonly reason: string;
}

export interface ReleaseRunEpicsOutcome {
  /** Operator lines, one per branch that was released or deliberately kept. */
  readonly lines: readonly string[];
  readonly released: readonly EpicReleaseRecord[];
  readonly kept: readonly KeptEpic[];
}

export async function releaseRunEpics(parts: ReleaseRunEpicsParts): Promise<ReleaseRunEpicsOutcome> {
  const owner = parts.owner;
  let workspace: WorkspaceContext;
  try {
    workspace = loadWorkspace(parts.root);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      lines: [`epic branches left alone — no readable workspace.yml (${firstLine(detail)})`],
      released: [], kept: [],
    };
  }
  const claimed = owner.run.build?.epic_branch ?? [];
  const lines: string[] = [];
  const released: EpicReleaseRecord[] = [];
  const kept: KeptEpic[] = [];
  const pairs = parts.only === undefined
    ? claimed.flatMap((branch) => owner.run.repos.map((repo) => ({ repo, branch })))
    : [parts.only];
  for (const { repo, branch } of pairs) {
    if (!claimed.includes(branch) || !workspace.repos.has(repo)) continue;
    const base = workspace.defaultBranches.get(repo) ?? "main";
    const outcome = await releaseEpicBranch({
      repoDir: repoDirOf(workspace, repo), branch, base, ownerRunId: owner.runId,
    });
    if (outcome.kind === "absent") continue;
    if (outcome.kind === "kept") {
      kept.push({ branch, repo, reason: outcome.reason });
      lines.push(`\`${branch}\` in ${repo} left alone — ${outcome.reason}`);
      continue;
    }
    const record: EpicReleaseRecord = {
      branch, repo,
      outcome: outcome.kind,
      ...(outcome.kind === "renamed" ? { renamed_to: outcome.to } : {}),
      commits: outcome.kind === "renamed" ? outcome.commits : 0,
      base, via: parts.via, at: parts.at, reason: parts.reason,
    };
    released.push(record);
    lines.push(describeRelease(record, outcome.sha));
    const payload = eventPayload(record, owner.runId);
    owner.append(event(parts, owner.runId, payload));
    parts.emitAlso?.("epic.released", payload);
  }
  if (released.length > 0) {
    owner.mutate((run) => ({
      ...run,
      build: {
        epic_branch: run.build?.epic_branch ?? [],
        ...(run.build?.branch_model === undefined ? {} : { branch_model: run.build.branch_model }),
        epic_released: [...(run.build?.epic_released ?? []), ...released],
      },
    }));
    owner.save();
    appendToHandoff(owner.runDir, released);
  }
  return { lines, released, kept };
}

/** The one sentence per released branch every caller prints. */
export function describeRelease(record: EpicReleaseRecord, sha = ""): string {
  const was = sha === "" ? "" : ` (was ${sha})`;
  return record.outcome === "deleted"
    ? `released \`${record.branch}\` in ${record.repo} — deleted${was}: no commit beyond \`${record.base}\``
    : `released \`${record.branch}\` in ${record.repo} — renamed to \`${record.renamed_to ?? ""}\`${was}: `
      + `${String(record.commits)} commit(s) beyond \`${record.base}\` survive there`;
}

function eventPayload(record: EpicReleaseRecord, ownerRunId: string): Record<string, unknown> {
  return {
    branch: record.branch,
    repo: record.repo,
    outcome: record.outcome,
    renamed_to: record.renamed_to ?? null,
    commits: record.commits,
    base: record.base,
    owner: ownerRunId,
    via: record.via,
    reason: record.reason,
  };
}

function event(parts: ReleaseRunEpicsParts, runId: string, payload: Record<string, unknown>): TldrxEvent {
  return { ts: parts.at, run: runId, stage: null, type: "epic.released", actor: parts.actor, cost_usd: 0, payload };
}

/**
 * The owner's Build handoff, when it wrote one, gets the same sentence under its
 * own heading — a person who reads the document a cancelled run left behind
 * finds where its epic went without opening run.yml. Appended, never rewritten:
 * the handoff is a stage artefact and its four sections stay as the stage wrote
 * them (`validateHandoff` reads only the required sections). A run cancelled
 * before Build wrote a handoff has none, and none is invented for it.
 */
function appendToHandoff(runDir: string, released: readonly EpicReleaseRecord[]): void {
  const path = join(runDir, BUILD_PHASE, "handoff.md");
  if (!existsSync(path)) return;
  const bullets = released.map((record) =>
    `- ${describeRelease(record)} — ${record.via} at ${record.at}: ${record.reason} `
    + `[src: absent:${BUILD_PHASE}/log]`);
  try {
    appendFileSync(path, `\n## Epic branch released\n\n${bullets.join("\n")}\n`, "utf8");
  } catch {
    // The record is on run.yml and on the ledger; a handoff that will not take
    // the note is not a reason to fail a release that already happened.
  }
}
