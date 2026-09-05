# tldr-experts — Claude Code sessions start here

The canonical working context for this repo — merge discipline, gates, CI truths, CHANGELOG
and release rituals, house invariants, test discipline, provider facts, and the traps that
cost real time once — lives in **one** file shared by every coding agent (Codex reads it too):

@AGENTS.md

Do not duplicate its content here; drift between two rule files is exactly the failure mode
this repo exists to kill. If a rule proves wrong or incomplete, fix `AGENTS.md` in the same
change that proved it.

Claude-specific notes only:

- The PreToolUse release gate (`.claude/settings.json` → `scripts/release-gate-hook.sh`) will
  deny manual `git tag`/tag-push/`npm publish` — that is working as intended; use
  `scripts/release.sh` (see AGENTS.md §6 and `docs/RELEASING.md`).
- Long waits (merge-wave lock, CI watch, a running suite) happen in bounded foreground loops
  INSIDE your turn. Ending your turn to "wait for a monitor" strands the work — nothing will
  wake you.
