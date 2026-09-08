# Sub-agent briefs

Two templates, used by `SKILL.md` §2 and §3. Both are deliberately generic: they carry the
SHAPE of the brief and cite `AGENTS.md` by section, so a rule change lands in one place.

Fill `<>` placeholders. Keep both briefs short — a brief that restates `AGENTS.md` is a second
copy of it, and the sub-agent reads `AGENTS.md` itself as its first act.

---

## Implementer brief

> Repo: `<repo path>`. READ `AGENTS.md` FIRST and follow it exactly.
>
> **Issue**: `#<N>` — `<one-line summary>`. Read it with `gh issue view <N>`.
>
> **Step 0 — reproduce.** Before changing anything, reproduce the issue's measurement on
> current `origin/main` and report what you got. Issues here go stale: if it does not
> reproduce, STOP and report the refutation with its evidence instead of writing a fix.
>
> **Worktree**: `git fetch origin && git worktree add <scratch>/wt-<topic> -b <branch>
> origin/main`. Work ONLY there; never touch the shared checkout.
>
> **Scope**: `<the files you may change>`. A new out-of-scope bug is a GitHub issue with
> evidence, not a change in this branch (§1).
>
> **Red-first (§1)**: write the failing test first and keep its VERBATIM red output for the
> report. Then the mutation check — break the fix and confirm the new test goes red again;
> if the fix has two halves, do both directions.
>
> **Gates (§3)**: typecheck, tests, build, docs build, and the runtime seam grep. Run each
> WITHOUT a pipe and echo each exit code on its own line — a pipe eats the exit code.
>
> **Docs are part of the change (§5)**: the CHANGELOG bullet in the repo's voice under the
> current unreleased heading, plus whatever surface the change moved.
>
> **Commit** with the repo's trailers, then **STOP. Do not merge.** A separate reviewer reads
> your branch before it merges, and you will be resumed with either a fix list or `merge`.
> On `merge`, your last commit is the review record `.review/<branch>.md` — shape and refusals
> in `AGENTS.md` §2 — written from the reviewer's name and the sha it read, which come with the
> resume message. Without it the wave refuses your branch and merges nothing.
>
> **Report, under 300 words**: what reproduced and how it was measured, the red output
> (trimmed), the fix in a sentence, each gate's exit code, the test delta, branch and head sha,
> worktree path.

---

## Reviewer brief

> Repo: `<repo path>`, worktree `<implementer worktree>`, branch `<branch>`.
> READ `AGENTS.md` FIRST. You did NOT write this code and you are not resuming anyone's work.
>
> Review the branch diff against `origin/main` — `git fetch origin && git diff
> origin/main...<branch>` — for issue `#<N>`: `<one-line summary>`.
>
> **What to judge**, and nothing else:
> - `AGENTS.md` §1 — is every claim in the change and its commit message actually measured?
>   Is the red-first proof real, or is the new test a guard that passed before the fix?
> - `AGENTS.md` §7 — house invariants: additive-only `version: 1` formats, one implementation
>   per derivation, absent-with-reason instead of an invented value, refusal exit-code
>   families, audit records that never lie in the dangerous direction.
> - `AGENTS.md` §8 — test discipline: hermeticity, assertions that can actually fail, no
>   proxy-string assertions, synthetic fixtures only.
>
> **How to report a finding**: a CONCRETE FAILURE SCENARIO — the input, the path the code
> takes, the wrong output — and a label:
> - `CONFIRMED` — you ran the scenario and observed the wrong output. Say how you ran it.
> - `PLAUSIBLE` — mechanism plus file:line, not executed. Say what you would run to settle it.
>
> Rank findings Important / Minor. **No style opinions, no refactor wishes**, no findings about
> code the diff did not touch (those are new issues, named but not fixed here).
>
> If a golden fixture changed bytes, that IS a behaviour change (§12): either the commit says
> so deliberately, or it is an Important finding.
>
> **Report, under 200 words**: a verdict line (`merge` or `fixes required`), the sha you
> reviewed (`git rev-parse <branch>`) and your own name/model, then the findings in rank order.
> Those three lines become the branch's review record (`AGENTS.md` §2); the implementer commits
> it, so do not edit any file yourself.
