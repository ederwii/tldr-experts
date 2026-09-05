# AGENTS.md — everything an agent needs to work on tldr-experts

This file is the canonical working context for ANY coding agent in this repo — Claude Code
(`CLAUDE.md` imports this file), Codex, or anything else. It was distilled from the burn that
took the repo from 0.3.0 to multi-provider across four days of live maintenance; every rule
below exists because its absence cost something once. When this file and reality disagree,
reality wins — fix the file in the same change.

**What this is**: an evidence-first, file-based AI development framework — five stages, a gate
on every one, and every claim cited or refused. The repo holds itself to the same standard it
sells: measured over asserted, refused over guessed, named over silent.

---

## 1. The golden rules (violating any of these is a failed change)

- **Evidence before assertion.** Label claims `measured` (you ran it), `inferred` (mechanism +
  evidence, could be wrong) or `assumed`. Never copy a measurement from a doc or a comment when
  you can take one — a stale "403" copied from a note shipped a real bug here.
- **Never quote a CLI command or flag from memory.** Check `tldrx <cmd> --help` (or
  `src/cli/helpText.ts`) before instructing anyone to run it — a session confidently invented
  `tldrx facts` twice in one sitting. `--help` is the authoritative command surface.
- **Exit codes are never read through a pipe or after a trailing command.** `cmd | tail` eats
  the code; `cmd; git log; echo $?` reports `git log`'s. Capture the critical command's exit as
  its OWN line, immediately. `${PIPESTATUS[0]}` is a bashism — the shell here is zsh (where
  `status` is also a reserved variable; never name a variable `status`).
- **Red-first, always.** Every behavior change starts with a failing test whose verbatim RED
  output you keep for the report/close. A test that passed before the fix is a guard, not a
  proof — label it as such. Habit that has caught real bugs: mutate the code under test and
  confirm your new test goes red (both directions where the fix has two halves).
- **New out-of-scope bugs → file a GitHub issue with evidence; do not fix them in your change.**
  A measured refutation is a valid close. Deviating from an instruction is allowed WITH measured
  evidence — state the deviation and its evidence prominently.

## 2. Working model: your own worktree, one sanctioned merge path

- **Releases go through `scripts/release.sh <version>` only.** Never `git tag`,
  `git push … vX.Y.Z` or `npm publish` by hand: a PreToolUse hook (`.claude/settings.json` →
  `scripts/release-gate-hook.sh`) denies them unless `scripts/release-check.sh` passes. The
  checklist and reasoning live in `docs/RELEASING.md`. See §6.
- Merge wave branches with `scripts/merge-wave.sh <branch> "<merge message>"` — **two
  arguments**; a missing message dies obscurely at the `${2:?message}` guard. It runs every
  gate, prints one `OK <sha> Ran N tests …` line, and pushes. It takes a lock on the checkout
  for the whole merge+gate+push span: a second invocation WAITS (poll `MW_LOCK_POLL_S`, default
  2 s), gives up with exit 6 after `MW_LOCK_WAIT_S` (default 3600 s), having merged nothing. A
  lock whose owner is dead, or older than `MW_LOCK_STALE_S`, is broken open automatically. Do
  not work around it.
- **Agents touch the shared checkout ONLY through `scripts/merge-wave.sh`.** Everything else
  happens in your own worktree
  (`git fetch origin && git worktree add <scratch>/wt-<topic> -b <branch> origin/main`). Never
  `git reset --hard`, never `git checkout -B main` in the shared checkout (#89: a sibling did
  exactly that mid-gate and a merge commit stopped being reachable from `main`). A
  `.MERGE-WAVE-IN-PROGRESS` file at the repo root means a wave is running — wait. The
  `reference-transaction` guard (`scripts/merge-guard.sh`) makes git itself refuse ref updates
  in the shared checkout while the lock is held; it saves commits, not working trees, and it is
  bypassable — the rule above is the real protection.
- The wave survives interruption (it unwinds an unpushed merge and refuses a pre-existing
  orphan on `main` with exit 8, naming the commits) and survives merging changes to itself
  (it re-execs from a snapshot). Trust it; if it refuses, read WHY before anything else.
- If `main` moves under you mid-work: rebase your branch onto latest `origin/main`, re-run the
  full local gate, then wave. **CHANGELOG conflicts resolve as the UNION of both sides** under
  the current unreleased section — every bullet from both sides survives, one section per
  version, one heading per kind (a duplicate `### Fixed` group has shipped before; don't).
- Clean up: remove your worktree and delete your branch after the wave. The branch delete may
  be refused by the ref guard while a sibling holds the lock — retry in a bounded loop; never
  force.

## 3. Gates for any change

`bun run typecheck` · `bun test` · `bun run build` · `bun run docs:build` · and no `Bun.*`
under `src/` outside `src/core/runtime/` (the seam grep scans `src` only — `scripts/build.ts`
calls `Bun.build` by design). Run each without pipes and read each exit code.

- `docs:build` is a gate since #114: `ignoreDeadLinks: false` is deliberate, and the site runs
  generators before VitePress — a moved page or a throwing generator used to reach `main` green
  and die at deploy. ~4 s warm, leaves the tree clean.
- **Runtime code must run under Node** (the published package needs only Node ≥ 20; Bun builds
  and tests it). Don't reintroduce Bun-only APIs outside `src/core/runtime/` — a live daemon
  died on Bun's `undici` shim missing `ping()` once.

## 4. CI verification — the part everyone gets wrong

- **`gh run list --commit <sha>` LIES**: it returns `[]` for minutes while the runs demonstrably
  exist (measured three separate times). Get run ids from an UNFILTERED `gh run list --limit 8`
  and match `headSha` yourself.
- **Assert the checks list is NON-EMPTY** via `gh run view <id> --json jobs` — jobs > 0 and
  steps > 0, every step success. "No checks found" is a FAILURE state, not a pass. A clean
  report over zero checks is the classic false all-clear.
- Both workflows matter: `ci` AND `docs`.
- **Known flake**: `test/merge-wave.test.ts`'s concurrency case (#115) can redden a run under
  machine load. A re-run of the SAME sha going green with nothing pushed in between is an
  acceptable pass — say so explicitly when it happens. If you can reproduce it, that issue
  wants your evidence.

## 5. CHANGELOG and docs conventions

- Post-release work goes under a NEW `## <next-version> — unreleased` heading (create it,
  matching the existing convention). **Released (dated) sections are immutable.**
- Docs are part of the change: CHANGELOG bullet (write the WHY, not just the what — read the
  existing entries for the voice), README status/release tables, `docs/spec.md` when a schema
  or command changes, `docs/ROADMAP.md` when scope moves, `docs/dashboard-model.md` for
  dashboard model fields, and the docs-site — **EN and ES in lockstep** (ES is a real
  translation; sample CLI strings stay in English by owner decision).

## 6. Releasing to npm

Full checklist: `docs/RELEASING.md`. The shape, so you recognize the moving parts:

1. Preconditions on disk: `CHANGELOG.md` has `## <V> — unreleased` and README's release table
   has a `| <V> | unreleased | … |` row. (The public-surface drift guard requires the TOP table
   row to equal `package.json` — which is why these prep edits ride into `release.sh`'s own
   commit rather than merging separately.)
2. `scripts/release.sh <V> --tag beta` — commits locally, runs `release-check.sh --pre-push`
   (full gates; NOTHING is pushed if the gate goes red — it prints the exact undo), then pushes
   `main`, tags `v<V>`, pushes the tag.
3. The tag triggers `publish.yml` (npm trusted publishing). Watch it (§4 rules), then verify
   `npm view tldr-experts dist-tags` and align any global install. Optionally
   `gh release create v<V> --notes-file <section>` from the CHANGELOG section.
4. Run it as a foreground/background command whose LAST line echoes the release exit code.

## 7. House invariants (each is pinned by tests — expect a red gate if you break one)

- **`version: 1` file formats only grow.** Additive fields, tolerant reads of old records,
  never a changed meaning. Same for `DASHBOARD_MODEL_VERSION` — additions don't bump it.
- **One implementation per derivation.** Grammar/regex/arithmetic live in exactly one file
  (`src/core/text/srcToken.ts` for the `[src:]` grammar; `spendBasis`, `storyBranchOf`,
  `gateAuthority` are precedents). Shape tests (#80 family) refuse a second copy — if you need
  a helper both sides use, extract it to a leaf.
- **Absent-with-reason, never invented.** A value that can't be derived is named with WHY
  (`basis: "absent"` + a reason sentence; "not recorded — run.yml carries neither…"), never
  guessed, never a confident zero. Cost figures that are lower bounds SAY so.
- **No invented price/model rows.** `priceFor` returning null is designed behavior — nothing
  quotes a price the table can't price. `[1m]` is a marker on a name, not part of a family id.
- **Refusal exit codes have families**: 1 = usage / nothing-behind-it; 2 = money / gate
  refusals. Don't split one condition across families; match the siblings
  (`src/cli/exitCodes.ts`).
- **Audit records never lie in the dangerous direction.** A "Resolved: yes" carries a reachable
  sha or it is `claimed-unverified`; a gate's evidence must not predate what it signs;
  reconstructions never silently downgrade a document (reconstruct from the ledger, or say
  what you couldn't).

## 8. Test discipline

- Hermeticity is law: every spawning test gets a **private `$TMPDIR` per invocation** (#95/#97);
  never scan shared tmp; `test/machine-load.test.ts` auto-adds a guard row per test file that
  spawns processes (your +N will be one higher than the tests you wrote — reconcile, don't
  hand-wave).
- The agent boundary is a **real executable fake on PATH anchored to a recorded transcript**
  (`test/fixtures/agent/stream-json.jsonl` for Claude, the codex fixture for Codex), with ONE
  shared emitter (`fakeTranscript.ts`) both fakes route through — a second emitter is the only
  bug either can have. Tests that read the developer's real `~/.claude/settings.json` must pin
  `ambientModel: null`.
- Assertions must be able to fail. Compare against behavior, not the constant that produced the
  value; a proxy string like a bare English word will false-positive on innocent prose — assert
  the exported marker/heading instead.
- Demo/docs fixtures are SYNTHETIC ONLY (`assertSynthetic` gates every read; the export must be
  byte-identical across machines, no real workspace data ever).

## 9. Public surfaces

`test/public-surface-consistency.test.ts` runs on every PR and has teeth. The rules it encodes:
**the current version is never typed into prose** (the docs-site derives it from
`package.json`); banned positioning: "lightweight", bare "tool-agnostic", absolute
state-coherence claims ("nothing to fall out of sync with"); runtime requirements distinguish
running (Node ≥ 20) from building/contributing (Bun); the landing must name `tldrx drive`;
provider wording: "The workflow and persisted state format are provider-independent. The
automated runner supports Claude Code and Codex."

## 10. Providers

The model-provider contract lives in `CONTRIBUTING.md` and is pinned by
`test/model-provider.test.ts` — satisfy it, don't reinterpret it. The seam is
`src/core/facilitator/spawnAgent.ts`. Codex facts (measured): the prompt goes via stdin (no
positional — a positional would change stdin's semantics to an appended block), turns are
`metered: false` (no provider-side USD cap — the preflight refuses what it controls and warns
about what it doesn't), reviewer roles use the `read-only` sandbox, `codex exec review` is
avoided (it ignores `--output-schema`). Weakening an existing provider pin is a finding, not a
migration.

## 11. Issue discipline

Close with: merged sha, test delta (both ends measured, attributed), CI run ids with the §4
assertion, RED proofs verbatim, and the design paragraph when you made a judgement call. File
with: the measurement, the mechanism (labelled if inferred), and file:line. The repo's own
history is the style guide — read a few recent closes before writing yours.

## 12. Known live traps (all cost real time once)

- Backticks inside a double-quoted shell string are command substitution — a message once went
  out with its command executed and replaced by nothing.
- `git show <ref>:<dir>` prints a tree listing and exits 0 — use `git cat-file blob` when a
  citation must be a file.
- `git merge` replaces a changed file's inode, so a running script keeps reading its original
  bytes; in-place truncation is the dangerous case (why merge-wave snapshots itself).
- `dotnet`-style multi-command wrappers, `timeout` missing on macOS, `echo` mangling `\n`
  before `jq` — when an instrument gives a weird reading, suspect the instrument first and say
  you did.
- `src/core/facilitator/executors/build.ts` is ~4k lines by design debt; its decomposition is a
  planned roadmap item — do not drive-by restructure it inside another change.
