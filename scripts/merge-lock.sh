#!/usr/bin/env bash
# Where the merge-wave lock lives, who owns it, and when that owner is gone (#44, #89).
# SOURCED, never executed: `scripts/merge-wave.sh` writes the lock and
# `scripts/merge-guard.sh` reads it, and the two must answer "is this owner still alive?"
# identically. A guard that were stricter than the writer wedges the checkout; a guard that
# were laxer waves through the exact `git reset --hard` #89 is about. One copy, both callers.
#
# Every function is safe under `set -u` and prints nothing.

# MW_GITDIR (the COMMON git dir, absolute) and MW_LOCK. Returns 1 outside a repository.
#
# `--git-common-dir` is resolved by cd-ing into it rather than by prefixing the toplevel:
# from a SUBDIRECTORY of the main worktree git answers `../.git`, which is relative to the
# CWD and not to the toplevel — measured, git 2.50.1. The guard runs wherever the agent
# happened to be standing, so it cannot assume the toplevel.
mw_lock_paths() {
  local common
  common="$(git rev-parse --git-common-dir 2>/dev/null)" || return 1
  [ -n "$common" ] || return 1
  MW_GITDIR="$(cd "$common" 2>/dev/null && pwd)" || return 1
  MW_LOCK="$MW_GITDIR/merge-wave.lock"
  return 0
}

# The root of the MAIN working tree — the shared checkout every wave merges in. `git worktree
# list` puts it first, by documented contract, which beats guessing that the git dir is named
# `.git` and sitting one level down.
mw_shared_root() {
  local first
  first="$(git worktree list --porcelain 2>/dev/null | awk '/^worktree /{print substr($0, 10); exit}')"
  if [ -n "$first" ]; then printf '%s\n' "$first"; return 0; fi
  printf '%s\n' "$(dirname "${MW_GITDIR:-.}")"
}

# The marker a human or an agent can SEE, at the shared root. `.gitignore` carries it so a
# wave cannot trip its own dirty-tree guard.
mw_marker_path() { printf '%s/.MERGE-WAVE-IN-PROGRESS\n' "$(mw_shared_root)"; }

# 0 when this command was typed in the MAIN working tree, 1 from a linked worktree.
mw_in_shared_checkout() {
  local own
  own="$(git rev-parse --git-dir 2>/dev/null)" || return 1
  own="$(cd "$own" 2>/dev/null && pwd)" || return 1
  [ "$own" = "${MW_GITDIR:-}" ]
}

mw_owner_of() { cat "${MW_LOCK:-/nonexistent}/owner" 2>/dev/null || true; }
mw_token_of() { cat "${MW_LOCK:-/nonexistent}/token" 2>/dev/null || true; }

# "<pid> <host> <epoch>" — true when that owner is gone: same host and the pid is dead, or
# the lock is older than MW_LOCK_STALE_S (the only signal available for another host).
mw_dead_owner() {
  local o pid host born
  o="$1"
  [ -n "$o" ] || return 0
  pid=$(echo "$o" | cut -d' ' -f1); host=$(echo "$o" | cut -d' ' -f2); born=$(echo "$o" | cut -d' ' -f3)
  case "$born" in ''|*[!0-9]*) born=0 ;; esac
  if [ "$born" -gt 0 ] && [ $(( $(date +%s) - born )) -gt "${MW_LOCK_STALE_S:-3600}" ]; then return 0; fi
  if [ "$host" = "$(hostname)" ] && [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then return 0; fi
  return 1
}

# 0 when a merge wave is in progress and the CALLER is not the invocation holding it.
# The LOCK is the sentinel, not the marker: only the lock carries an owner, and only an
# owner can be tested for death. The marker is what that lock looks like to a human.
mw_foreign_wave_in_progress() {
  [ -d "${MW_LOCK:-/nonexistent}" ] || return 1
  local o t
  o="$(mw_owner_of)"
  mw_dead_owner "$o" && return 1
  t="$(mw_token_of)"
  [ -n "$t" ] && [ "${MW_LOCK_TOKEN:-}" = "$t" ] && return 1
  return 0
}
