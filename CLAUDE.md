# tldr-experts — working rules for Claude Code sessions in this repo

- **Releases go through `scripts/release.sh <version>` only.** Never `git tag`, `git push … vX.Y.Z` or `npm publish` by hand: a PreToolUse hook (`.claude/settings.json` → `scripts/release-gate-hook.sh`) denies them unless `scripts/release-check.sh` passes. The checklist and the reasoning are in `docs/RELEASING.md`.
- Merge wave branches with `scripts/merge-wave.sh <branch> "<msg>"` (runs every gate, prints one line).
  It takes a lock on the checkout for the whole merge+gate+push span: a second invocation WAITS,
  polling every `MW_LOCK_POLL_S` (default 2 s) and reporting the wait on stderr, then gives up with
  exit 6 after `MW_LOCK_WAIT_S` (default 3600 s), having merged nothing. A lock whose owner process
  is dead, or older than `MW_LOCK_STALE_S` (default 3600 s), is broken open automatically. Do not work around it — that lock is what stops one agent's gates
  from running over another agent's half-merged tree.
- **Agents touch the shared checkout ONLY through `scripts/merge-wave.sh`. Every other piece of
  work happens in your own worktree. Never `git reset --hard` and never `git checkout -B main` in
  the shared checkout** (#89: a sibling did exactly that mid-gate and a merge commit stopped being
  reachable from `main`). A `.MERGE-WAVE-IN-PROGRESS` file at the repo root means a wave is running
  right now — read it and wait. `merge-wave.sh` also installs `scripts/merge-guard.sh` as a
  `reference-transaction` hook, so git itself refuses ref updates in the shared checkout while the
  lock is held; it saves the commit, not the working tree, and it is bypassable. The rule above is
  the real protection.
- Gates for any change: `bun run typecheck`, `bun test`, `bun run build`, and no `Bun.*` under `src/` outside `src/core/runtime/` (the grep scans `src` only — `scripts/build.ts` calls `Bun.build` by design). Run them without pipes and read the exit codes.
- Docs are part of the change: CHANGELOG (`## <next> — unreleased`), README status table + release table, `docs/spec.md` when a schema or command changes, `docs/ROADMAP.md` when scope moves.
