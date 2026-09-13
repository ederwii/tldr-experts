verdict: merge
reviewed-by: Claude Opus 5 (tldr-experts-6d) — a fresh reviewer that did not write this branch. No conflict to declare: I wrote neither `run cancel` nor `branchClaims`' refusal. I did set the three design constraints this branch implements, so the sections below say which findings are mine being checked against, and which are new.
against: e2cfd1b

## The three constraints I asked for are all met, measured

**Owner is read from written state only.** The decision's inputs are `listRunDirs` + `build.epic_branch` + `isFinished(run.status)`. A grep for `pid|kill|lock|mtime|statSync|process\.` across `branchClaims.ts` and `epicRelease.ts` returns five hits, **all inside comments** — no process, PID, lock or mtime reaches the decision. The three refusals, run rather than read:

| case | exit | branch |
|---|---|---|
| owner open | 2, verbatim + `· claimed by run <id> (<status>), which is still open` | untouched |
| owner unreadable | 2, verbatim + `· …run.yml could not be read, so who owns it is unknown` | untouched, same sha |
| **no claim (#262's killed run)** | 2, verbatim + `· no run under tldrx-work/ records cutting it, so it is nobody's leftover to move` | **not renamed, zero events** |

The third is the one I asked for explicitly: had it renamed, a run killed before its claim reached disk would lose its own epic — worse than today's refusal, which at least fails loudly and lets a person decide.

**The destructive edge holds.** Delete only at 0 commits; with commits it renames aside and does not delete; **`commitsAhead === null` (git could not count) preserves** — verified with 2 commits and with 0; a branch checked out in any worktree is preserved with its path named.

**The rename is written where someone will read it**, on all four surfaces: `build.epic_released` in the owner's `run.yml`, a `## Epic branch released` section in the owner's handoff, an `epic.released` event in the owner's ledger, and the ledger plus a Decisions bullet in the new run. A renamed branch whose new name is not written down is work nobody finds again (#148 is the same shape); this does not have that hole.

Also verified: `asideBranchOf` is the single constructor of `epic/<slug>@<run-id>` with one consumer (§7); the three declared mutations match in count and identity (4 / 1 / 1); `build-golden` 4/4 with an empty fixtures diff; the `machine-load` row is automatic and reconciles (92→93 spawners); §2.2's new `build` row matches the real `run.yml` key for key.

## Second pass — the two fail-safe tests are in, and I ran the mutation myself

Both behaviours were correct at `ca0f209` but had no test — the reviewer had to exercise them by hand. They guard the one path in this branch that **deletes a branch**, so unpinned was how the defect this branch carefully avoided would have come back. **Both are now pinned at `e2cfd1b`.**

1. **`commitsAhead === null` ⇒ the branch is kept.** **Verified by me at `e2cfd1b`, running the mutation rather than reading the claim**: rewriting `epicRelease.ts:89` to `(await commitsAhead(...)) ?? 0` — the exact "simplification" a later change might make — reddens **one** test and it is the right one, *"an epic git could NOT count against its base is KEPT — an uncounted branch is never deleted"*. Baseline 11/11 exit 0; mutated exit 1 with that single failure; file restored, tree clean. The marker is exported (`uncountedReason`), so the assertion is anchored to a symbol rather than to prose (§8).
2. **An unreadable owner `run.yml` ⇒ the verbatim refusal, branch untouched.** Pinned: both verbatim lines plus the context line, exit 2, the branch at its own sha, no aside and no event.

**The three weak assertions are fixed**, and the fix is better than a rename: `OWNER` and `ASIDE` are literals with a comment saying why (*"literal, so the aside names below are literal too"*), so `renamed_to` is compared against `epic/e1@260829-build` written out rather than against `asideBranchOf` reproducing itself. `toContain("deleted")` and `not.toBe(2)` are gone (0 occurrences each); the remaining `asideBranchOf` uses are the single format pin and three **negative** assertions, where a tautology cannot manufacture a pass.

## Non-blocking, recorded

- **#273 filed** (by me, with the evidence) for `commitsBetween` collapsing a failed git call into `0`, and `build.ts:409` discarding the implicit plan on that zero. This branch does not introduce it and correctly routed around it; §1 asks for the issue, and it did not exist — the finding lived only as a docstring on the new helper, while `commitsBetween`'s own docstring still says nothing about what its zero means.
- **§8, three weak assertions**: `toContain("deleted")` matches a bare English word that innocent prose could carry; `expect(code).not.toBe(2)` passes for any non-refusal including a crash; and `renamed_to` is compared against `asideBranchOf` itself — tautological, though mitigated by the single literal pin elsewhere.
- **Multi-repo is unmeasured.** The claim does not record which repo it belongs to, so `run cancel` sweeps the name across every repo of the run; the fixtures are single-repo. Not a defect found, a surface not exercised.

## Not measured here

`build`, `docs:build` and the seam grep (the wave runs them), the full suite, CI, a forced `rev-list` failure end to end, and the three `kept` paths that depend on a git command failing.
