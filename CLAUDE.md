# tldr-experts — working rules for Claude Code sessions in this repo

- **Releases go through `scripts/release.sh <version>` only.** Never `git tag`, `git push … vX.Y.Z` or `npm publish` by hand: a PreToolUse hook (`.claude/settings.json` → `scripts/release-gate-hook.sh`) denies them unless `scripts/release-check.sh` passes. The checklist and the reasoning are in `docs/RELEASING.md`.
- Merge wave branches with `scripts/merge-wave.sh <branch> "<msg>"` (runs every gate, prints one line).
  It takes a lock on the checkout for the whole merge+gate+push span: a second invocation WAITS,
  reporting the wait on stderr. Do not work around it — that lock is what stops one agent's gates
  from running over another agent's half-merged tree.
- Gates for any change: `bun run typecheck`, `bun test`, `bun run build`, and no `Bun.*` outside `src/core/runtime/`. Run them without pipes and read the exit codes.
- Docs are part of the change: CHANGELOG (`## <next> — unreleased`), README status table + release table, `docs/spec.md` when a schema or command changes, `docs/ROADMAP.md` when scope moves.
