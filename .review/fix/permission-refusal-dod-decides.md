verdict: merge
reviewed-by: Claude Opus 5 (tldr-experts-6d) — NOT the author of this branch, but the author of #261, the change this branch corrects. Declared conflict: see "On my standing in this review".
against: a5053d7

## On my standing in this review

I did not write this branch, so I satisfy §2's "a fresh reviewer that did not write the code". But I wrote #261, and this branch exists because #261 threw away committed work on the first real proof run. That is a bias in both directions — resisting a change that says my design was wrong, and over-accepting it out of authorship guilt. The other session offered a third reviewer; we agreed I would review and declare this instead.

## Second pass — the five fixes from `4131016` are all verified done

**Every one of the six mutation claims the CHANGELOG now makes was run, and all six match in count AND in identity** — this was the point that failed last round, where the CHANGELOG claimed four reddened tests and only one did:

| mutation | claimed | measured |
|---|---|---|
| drop the tree comparison | 4 | **4** — #261's own, empty-commit, state-only, ignored-only |
| proxy `headSha !== since` | 2 | **2** — uncommitted, empty-commit |
| drop the `isDirty` half | 1 | **1** — uncommitted |
| drop the state-dir exclusions | 1 | **1** — state-only |
| add `--ignored` | 2 | **2** — state-only, ignored-only |
| drop `refusals.delete` | 1 | **1** — attempt-2 |

**The Important finding is fixed, and the trap it opened is closed.** `workSince` now counts a tip tree that differs from what was handed out **or** a dirty working copy, both excluding `tldrx-work/` and `.tldrx/`. Measured, six cases:

| case | behaviour |
|---|---|
| real commit with code | passes to the DoD → `done` |
| empty commit | blocks |
| tree untouched (#261's case) | blocks |
| **dirty, no commit** | **passes to the DoD**, the facilitator commits it, one spawn |
| **dirty only in `tldrx-work/` or `.tldrx/`** | **blocks** |
| only a git-ignored file | blocks |

The fifth row is the one I asked for: the facilitator writes state during the turn, so without the exclusions a developer that touched nothing would have looked busy and reached the DoD — the permissive direction, and the original defect through the back door. It is excluded, and pinned by its own test.

**Untracked counts, ignored does not, and it is written down** in four places (the `workSince` docblock, a comment in `build.ts`, `docs/spec.md`, the CHANGELOG) with the reason — `runDod` runs before `commitIfDirty`, and these are the two ways a no-work turn could look dirty by accident. A deliberate decision, not an artefact of the `git status` that happened to be chosen.

Also verified: the prompt names all ten separators including **`2>&1`**, the one from the incident that produced this branch, asserted literally; the goldens are exactly the same 6 prompts (`+4/−3` against `4131016`, `+5/−0` against main) with **no** `*-events.txt`, `*-run-tasks.txt`, `*-exit-codes.txt` or reviewer prompt moved; the tautological assertion is gone (`grep -c permissionBlockReason` in the test = 0); the detector is untouched (`agentEvents.ts` does not appear in the delta); and the +9 reconciles against the two changed test files (171 vs 162).

## Third pass — the sentence is fixed, and this is the merge

`docs-site/guides/unattended-operation.md:565` says:

> A refusal **with nothing committed** still blocks after one attempt, exactly as above.

That was true at `4131016` and this branch makes it **false**: a refusal with nothing committed but a dirty tree now passes to the DoD. It sits in the same paragraph that correctly explains the state dirs do not count, so the paragraph contradicts itself about the exact behaviour this branch changes. The Spanish mirror has it at `docs-site/es/guides/unattended-operation.md:587` ("sin nada commiteado").

I held this to the same bar I used to refuse `4131016` over a false measured claim in the CHANGELOG: a false sentence in the published guide is the same class, on the surface a user actually reads. Applying a softer rule because the second error was smaller is how a rule erodes.

**Fixed at `a5053d7`, verified by me.** The sentence now reads "A refusal with no work at all — a tree the developer left untouched — still blocks after one attempt", the Spanish mirror matches ("sin ningún trabajo — un árbol que el developer dejó intacto"), and `grep -c` for the old wording returns **0** in both files. The paragraph is re-wrapped. The commit is docs-only: its own numstat is the two guide files and nothing else (`5/4` EN, `2/2` ES) — the `.review/` file in the `20475e7..a5053d7` range is this record, which sits between the two commits.

## Non-blocking, recorded for whoever reads this later

- The handoff half of "records without blocking" is asserted **by content**, not by the `## Unknowns` heading. It passes, but an assertion anchored to the exported heading would survive a rewording of the prose (§8).
- Of the two new `refusals.delete` tests, only the attempt-2 one reddens under the mutation; the two-stories one is a **guard**, not a proof. Worth labelling as such.
- Not measured here: the absolute suite totals (the full run was excluded on purpose), `build` and `docs:build` (the wave runs them), and why adding `--ignored` reddens `state-only`.
