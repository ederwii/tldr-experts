verdict: fixes required
reviewed-by: Claude Opus 5 (tldr-experts-6d) — NOT the author of this branch, but the author of #261, the change this branch corrects. Declared conflict: see "On my standing in this review" below.
against: 4131016

## On my standing in this review

I did not write this branch, so I satisfy §2's "a fresh reviewer that did not write the code". But I wrote #261, and this branch exists because #261 threw away committed work on the first real proof run. That gives me a bias in both directions — to resist a change that says my design was wrong, and to over-accept it out of authorship guilt. The other session offered to find a third reviewer and I said it was the conservative call; we agreed I would review and declare this instead. Weigh the finding below against that.

## Finding (Important) — the dirty-tree case reproduces this branch's own defect, one case narrower

**Measured.** `committedWork` defines "there is work" as `treesDiffer(<sha before the spawn>, HEAD)` over commits only, excluding `tldrx-work` and `.tldrx`. Four cases, measured end-to-end and by direct probe:

| case | behaviour |
|---|---|
| (a) real commit with code changes | passes to the DoD → `done` |
| (b) `--allow-empty` commit | blocks |
| (c) tree unchanged | blocks |
| (d) **dirty tree, no commit** | **blocks** |

(b) and (c) are right: no work exists, nothing for a DoD to judge.

**(d) is the problem, and the measurement that decides it is about the normal path, not this one.** Without a permission refusal, `runDod` (`build.ts:1282`) runs **before** `commitIfDirty` (`:1311`) — the DoD is executed **against the dirty tree**, and the ordinary tests in this very file measure such a tree reaching `done` (the fake developer does not commit by default; `epic/e1:s1.txt` → "S1 was here", lines 215 and 1094). So the framework's own answer to "is uncommitted work real work?" is **yes, and the DoD decides**.

This branch answers `no` for the refusal path only. That is an asymmetry created here, and its justification is a comment, with no measurement behind it.

**Failure scenario, concrete and close to the incident that produced this branch:** a developer edits the files, runs a compound command to verify its work — the exact shape that caused the proof run's refusal — is refused, and never reaches a commit because the refusal came first. The story blocks. The DoD is never asked, though it would have run on that tree and might well have passed. The attempt is spent. The work survives (`rescueUncommitted`, #129, commits `wip(S1)` on `story/<run>/S1` and the review log names it) but is unreviewed, unmerged, and delivered to nobody.

That is **the same shape as #261's defect**: work that exists, thrown away because a signal arrived after it rather than instead of it. This branch fixes the committed half and leaves the uncommitted half, and the uncommitted half is the more likely one — a developer refused while *verifying* has not committed yet.

**The fix that matches the branch's own principle**: treat a tree that differs from the spawn-time state as work, committed or not, and let the DoD decide — which is exactly what the non-refusal path does. If instead the block is kept deliberately, it needs a measured reason written down, not a comment, and the CHANGELOG must say that a refusal before a commit discards a DoD that would have run.

## Fixes required

1. **(d) passes to the DoD, like (a)** — or a measured justification for keeping the block, in the code and the CHANGELOG.
2. **The CHANGELOG states a measurement that is false.** It says dropping the tree comparison "reddens #261's own test and the two no-work cases". Measured with the `headSha !== since` proxy: **only** the empty-commit case reddens; #261's own test stays **green**. The other half of that sentence is exact. A false measured claim in the CHANGELOG is the one thing this repo does not ship.
3. **The prompt does not name the operator from the actual incident.** The four new lines explain that separators split a line into subcommands needing their own grant, and cover `>`, `|`, `;`, `&&` — but the command that broke the proof run was `./scripts/gate/build.sh > /tmp/… 2>&1; echo …; tail …`, and `2>&1` is not named. Add `2>&1`, `>>`, `<`, `||`, `&` and `$()`.
4. **`refusals.delete` (`build.ts:1207`) has no coverage** — removing it leaves all four new tests green. That map is keyed per story and lives across stories; if the delete is wrong, one story's refusal is attributed to another, which is a record lying in the dangerous direction (§7). One test.
5. **One assertion compares against the function that produced it** (`expect(blocked_reason).toBe(permissionBlockReason(PLUMBED))`, §8). Assert the shape a reader would recognise instead.

## Verified and correct (no action)

- **Recording without blocking**: the refusal reaches the review log, the handoff's `## Unknowns`, and `task.done.permission_refused`. It does **not** reach `gate.requested` (no per-story field for the `done` case) nor the story file — and the docs and CHANGELOG **do not claim it does**. Accepted: the human path (handoff) and the machine path (event) both carry it, and the gap is not overstated.
- **#261's dangerous direction holds**: never blocking reddens three tests including #261's own; always blocking reddens the two with a commit.
- **DoD-red plus refusal**: both halves survive in `blocked_reason` (`` `npm run test` exited 1 ``, `permission — `, and the command); neither eats the other.
- **The detector is untouched**: `non_execution_kind: "user-rejected"` stays primary, the English phrase stays fenced to `Bash` + `is_error`; the diff over `agentEvents.ts`, `spawnAgent.ts` and the fixtures is empty.
- **Golden (§12)**: exactly 6 prompt goldens, `+4/−0` each; no `*-events.txt`, `*-run-tasks.txt`, `*-exit-codes.txt` or reviewer prompt moved. Parsed from numstat, declared in the commit.
- Gates: typecheck 0 · build 0 · docs:build 0 · seam clean · the diff's test files green.

## Cosmetic, not required

A comment says "The three shapes" over a two-entry loop. And a story blocked before the DoD logs `(the story declares no dod commands)` when it declares them — inherited from #261, so mine, and worth a follow-up rather than a fix here.

## Not measured

The field run itself; the interaction with `run auto --until-done`; the full suite (the reviewer was told not to run it); the real stdout progress line; and `treesDiffer`'s `null` branch end to end.
