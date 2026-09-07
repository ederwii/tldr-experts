# Waves 1b+2 — mechanical blockers and the cost-ledger remainder

Status: approved in scope by the owner on 2026-09-06 (third of four hardening waves; the program
calls it "1b+2"). Release target: the next MINOR (gate behaviour and file formats grow). Plan:
`docs/superpowers/plans/2026-09-06-wave3-blockers-plan.md`.

## 1. Problem (measured in real-run transcripts, code paths measured post-decomposition)

1. **#173** reviewer rows carry no token split: `build.ts` `formatRetry`/`recordReview` pass
   `{costUsd, sessionId, metered}` only, while the developer path passes `agent.usage.*`.
2. **#159 remainder** `spendBasisOf` reads only the scalar `turn.tokens`; both feeders
   (`phaseCost.ts`, `dashboard/model.ts`) ignore `input_tokens`/`output_tokens`, so a row carrying
   a full provider split but no host `tokens` is counted "absent" and the basis sentence ("none of
   them declared host tokens") is false about it. Under Codex every Build turn is unmetered, so a
   whole provider reads `absent` over rows that hold the tokens.
3. **#165** a refused DoD command (`DodCommandRefused` from `story.ts` `splitArgv`/allowlist) is
   FABRICATED as `{exitCode: 126}` in `dodRunner.ts` (story and base sides), then rendered as a
   measurement in three documents (handoff evidence ledger `[src: $ cmd → exit 126]`, review log,
   retro log). Nothing ran.
4. **#164** `dirtyRepoRefusal` names the verb ("commit or stash"), never the command; the guard's
   docstring gives a false reason (worktrees do not carry the index); the real reason is that the
   base preflight runs in the repo's own checkout.
5. **#166** the story is merged into the epic BEFORE the reviewer spawns, and the reviewer prompt
   diffs `epic...story`, which is empty once the story is an ancestor — the code says so itself.
   The epic sha before the merge is recorded nowhere.
6. **#168** `tldrx init` writes `commands:` it never ran; for Go/Rust/.NET it SYNTHESISES commands
   from the language id while the file's docstring says nothing here is conventional wisdom.
7. **#167** `tldrx ship`'s PR body is the last phase handoff (a gate document with operator
   instructions); a story that legitimately edits `.tldrx/workspace.yml` has no allowed move past
   the state refusal.

## 2. Decisions

1. **Order**: #173 → #159 leaf → #165 → #164 → #166 → #168 → #167 (measured dependency: the
   basis fix must read the tokens #173 writes; #166 is the only one that rewrites existing golden
   prompt bytes, so it goes when nothing else moves them; #168/#167 touch neither build.ts nor
   the golden).
2. **Golden discipline**: a golden byte change is a behaviour change and is allowed ONLY when the
   task's commit says which bytes changed and why; each such task lists the affected artifacts
   before starting and the review compares the diff of the golden to that list. #165 ADDS a
   fourth scenario (a refused command) rather than editing one.
3. **#173**: widen both reviewer task structs with `inputTokens?/outputTokens?`, pass
   `agent.usage.*` at the two call sites; `tokenSplit` (one derivation) decides presence. Golden:
   `headless-run-tasks.txt` t2, `rounds-run-tasks.txt` t2/t4 change and are named.
4. **#159 leaf**: one function (`turnTokens(task)` = `tokens ?? (input+output when both present)`)
   in `src/core/budget/` that BOTH feeders call; `spendBasis` unchanged; the basis sentence
   becomes true. A Codex Build stage reads `declared`/`measured` where the split exists.
5. **#165**: `DodResult` gains additive `status: "ran" | "refused"` and `refusedBecause`; a refused
   command emits `check.failed` WITHOUT `exit_code` (absent-with-reason) and with `refused: <why>`;
   the base side drops its 126 the same way (`unmeasured` stays); the three renderers print
   `refused: <why>` and never an `[src: $ … → exit 126]`. Docs: a quoted token is passed literally,
   so `sh -c "…"` is already expressible when declared verbatim; the `scripts/gate/*.sh`
   convention is documented. Tests that pin the 126 (`dod-preflight.test.ts`) change with RED.
6. **#164**: the refusal prints the literal, run-specific commands
   (`git -C <dir> stash push -u -m "tldrx <run> foreign work"` and the matching `stash pop`) and
   the corrected reason (the base preflight runs in this checkout); no flag, no framework-owned
   stash (a crash mid-wave would strand it — the #129 shape).
7. **#166**: capture the epic sha immediately before the merge; thread `diffBase?` through
   `ReviewerPromptParts` defaulting to `epicBranch` (absent ⇒ today's bytes); render
   `diffCommand(diffBase ?? epicBranch, story)`; persist `epic_base` additively on `task.done` and
   on the review bundle so `--prepare --review` and `rereview` recover it; the golden normaliser
   learns to scrub shas in prompt files; a test asserts the sha-form command still matches
   `REVIEWER_TOOLS`' `Bash(git diff *)`.
8. **#168**: `commands:` stays byte-identical (it is the allowlist); an additive sibling
   `command_probes: {<slot>: {verified, exit_code, at, reason}}` written by init after probing
   `build/test/lint/typecheck` once with a timeout through `CommandRunner` — never `run`; a
   synthesised command's probe reason says it was synthesised from the language id; a timeout
   writes `verified: false` with the reason; nothing is guessed. `redBaseRefusal` and
   `tldrx expert packs status`-style surfaces may print the probe; the DoD reads nothing new.
9. **#167**: a `renderShipBody` leaf in `src/core/run/` builds the PR body from the handoff's
   findings split (done / not done) and the open fix-list findings obtained by CALLING
   `src/core/build/fixlist.ts` (never re-parsing), with the handoff underneath in a
   `<details>` block; the no-handoff refusal is preserved. The `.tldrx` state refusal subtracts
   paths declared in settled stories' `touches:` and names which story excused which path.

## 3. Non-goals

The `runExecutor` catch losing rows on a throw (executor must hand rows to the seam as earned —
its own change). Decision governance (#169 #170 #171 — wave 4). Any prompt change beyond #166's
diff line.

## 4. Tests (red-first; verbatim RED kept)

Per issue as in §2, plus: each golden-affecting task names its artifacts first and the review
diffs the golden against that list; #165's fourth golden scenario; hermetic spawning tests keep
the machine-load convention; `version: 1` pins for every new key (old records load).

## 5. Docs (EN and ES in lockstep)

CHANGELOG `### Fixed`/`### Added`/`### Changed` under the next minor · `docs/spec.md` for
`DodResult.status`, the `check.failed` payload, `task.done.epic_base`, `command_probes`, the PR
body · CLI reference for `init` (probes) and `ship` · `docs/guide/*` on the DoD allowlist and the
`scripts/gate/*.sh` convention · docs-site twins.
