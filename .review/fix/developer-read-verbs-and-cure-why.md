verdict: merge
reviewed-by: independent pre-merge reviewer sub-agent (claude-sonnet-5), spawned by tldr-experts-6d; it did not write this code
against: a2b6f92

# fix/developer-read-verbs-and-cure-why — #287 + #294

## What was reviewed

The whole branch diff against `origin/main` (`8b8e67c`, release 0.21.0), plus the
commit body. This is the SECOND review of this branch. The first ran at head
`8db3039` and returned `fixes required` with exactly one item: the #294 why-clause
asserted *"the tool that runs a command reports the command's exit code and output
to you"* — measured for Claude Code's `Bash` tool, established NOWHERE for
`codex exec` (nothing in `spawnAgent.ts`, `CONTRIBUTING.md` or
`test/model-provider.test.ts` pins what that CLI returns to the model) — and that
sentence goes into the SHARED developer prompt both providers read. `a2b6f92` is
the reworded result, so this review covers both "did the fix land" and "did the
reword disturb what was already confirmed". The record is written against the new
head because the old one is a different diff (AGENTS.md §2).

## Findings

**None.** No blocking finding, and no non-blocking finding worth a fix round. One
observation is recorded below because it is a real limit of a guard, not because
it changes the verdict.

Checks that ran, each confirmed by the reviewer rather than taken from the commit:

1. **The removed claim is gone from every surface an agent can read.** CONFIRMED:
   `grep -rn "the tool that runs a command\|exit code and output to you" src docs docs-site test`
   matches ONLY inside the test's own `not.toContain` assertions
   (`test/stack-packs-prompt.test.ts:635-636`). Not in the prompt constant, not in
   `docs/spec.md`, not in either docs-site guide. The Claude-side measurement
   survives only in the doc comment on `OUTCOME_ALREADY_REPORTED`
   (`src/core/build/refusalKind.ts:158-181`), which is code, not prompt.
2. **The surviving clause is true for both providers.** CONFIRMED: it states a fact
   about the FACILITATOR — it re-runs the Definition of Done and records each
   command's exit code (`build/dodRunner.ts`, `:144` base run, `:302` story) — which
   holds whichever agent was spawned.
3. **`gitElsewhereOption` is not a permission boundary, and nothing depends on it
   being one.** CONFIRMED by tracing the path, which was the security-shaped
   question of this branch. `gitElsewhereOption` and `classifyRefusal` produce the
   CURE TEXT. Enforcement is elsewhere and is a literal prefix match:
   `developerGitGrants()` (`developerGrants.ts:58-60`) emits `Bash(git <verb> *)`
   per granted verb, wired at `executors/build.ts:4406`. So the known blind spot —
   `gitElsewhereOption` reads only `argv[1]`, so `git -c foo=bar -C /other/tree log`
   classifies as `unknown` and gets a generic cure instead of one naming `-C` — is
   COSMETIC: that line still matches no grant (it begins `git -c …`, not `git log `)
   and is still refused. A worse cure, never a bypass.
4. **"Every non-prompt golden is byte-identical" (AGENTS.md §12).** CONFIRMED
   independently: `git diff origin/main...HEAD --stat -- test/fixtures/build/golden/`
   lists exactly the six `*developer*`/`*bundle*` prompt files. No `-events.txt`, no
   `-run-tasks.txt`, no `-exit-codes.txt`, no reviewer prompt. The prompt goldens
   moving IS the behaviour change and the commit body argues it in those terms.
5. **One implementation per derivation (§7).** CONFIRMED: the grant
   (`developerGitGrants`), the prompt's verb list (`gitVerbList` in `prompts.ts`) and
   the classifier (`isDeveloperGitVerb` / `gitElsewhereOption`) all read the same
   `developerGrants.ts` constants; the clause is one constant read by the prompt,
   the cure and the retry prefix.
6. **EN/ES docs-site in lockstep (§5).** CONFIRMED by reading both diffs side by
   side: the ES addition is a genuine parallel translation — verb list, `-C`
   rationale, capturing-outcome rationale — not English pasted into the ES file.

## Recorded observation, not a fix

The new negative assertions (`not.toContain("the tool that runs a command")`,
`not.toContain("exit code and output to you")`) pin two EXACT phrasings. They are
a tripwire against this specific sentence returning verbatim — which is the thing
that actually happened once — and not a guard against the underlying unmeasured
claim being reintroduced in other words ("the CLI you are using reports the result
back to you" would walk straight past them). Both the reviewer and the
orchestrator judged that acceptable and worth keeping, on the condition that
nobody reads it as more than it is: the real protection is the doc comment that
says WHICH half was measured and where. This paragraph exists so the next reader
does not mistake the tripwire for a proof.

## Evidence

- `bun run typecheck` → exit 0.
- `bun test test/stack-packs-prompt.test.ts test/refusal-kind.test.ts test/build-executor.test.ts test/undeclared-commands.test.ts test/story-worktree-deps.test.ts`
  with `TMPDIR=/tmp/bx` → 244 pass, 0 fail, exit 0. (`TMPDIR` is pinned short on
  purpose: a long one reddens `build-executor`'s "WRONG branch" case for reasons
  unrelated to any code change — gh #293.)
- The full gate is deliberately NOT run here; `scripts/merge-wave.sh` re-runs every
  gate on the merged tree, which is the tree that matters.
