#!/usr/bin/env bash
# merge-wave.sh <branch> "<message>" — merge a wave branch into main, run every gate, push.
# Prints ONE summary line; exits non-zero (and leaves main untouched) on any red gate.
#
# Concurrency (#44). The merge, the gates and the push all happen in ONE shared checkout,
# so two invocations must never overlap: a second merge landing mid-gate makes the first
# invocation gate a tree it is not pushing (false GREEN) or fail on code it never wrote
# (false RED). Both were observed live 2026-08-31. Two independent defences:
#   1. A lock held from before the dirty-tree check through the push. `mkdir` is the
#      portable atomic primitive here — `flock(1)` is not on a stock macOS. A second
#      invocation WAITS (with a progress note on stderr) instead of failing.
#   2. An assertion, between the gates and the push, that HEAD is still the commit the
#      gates ran against. The lock prevents the race; the assertion makes it impossible
#      to push a HEAD whose gates ran on a different tree even if the lock is bypassed.
#
# Exit codes: 1 dirty tree · 2 merge conflict · 3 red gate · 4 push failed
#             5 HEAD moved during the gates · 6 gave up waiting for the lock
#             7 the gated commit is not a fast-forward of origin/main
set -u
B="${1:?branch}"; M="${2:?message}"; R="$(git rev-parse --show-toplevel)"; cd "$R" || exit 1

# --- the lock -----------------------------------------------------------------
# Inside the git dir, where it can never show up as dirt in the tree it is guarding.
# --git-common-dir, not "$R/.git": in a linked worktree that path is a FILE, so `mkdir`
# there could never succeed and every run would queue for an hour. The common dir is
# also the right scope — every worktree of this repo pushes the same `main`.
GITDIR="$(git rev-parse --git-common-dir 2>/dev/null || git rev-parse --git-dir)"
case "$GITDIR" in /*) ;; *) GITDIR="$R/$GITDIR" ;; esac
LOCK="$GITDIR/merge-wave.lock"
WAIT_S="${MW_LOCK_WAIT_S:-3600}"    # how long to queue behind another merge before giving up
STALE_S="${MW_LOCK_STALE_S:-3600}"  # an owner this old is assumed dead
POLL_S="${MW_LOCK_POLL_S:-2}"
HELD=0
release() { if [ "$HELD" = 1 ]; then rm -rf "$LOCK"; fi; return 0; }
trap release EXIT
# A signal that is not trapped kills bash WITHOUT running the EXIT trap, so an
# interrupted merge would leave its lock behind. The stale rules below would break it
# open a second later; releasing here means nobody has to.
trap 'release; exit 130' INT
trap 'release; exit 143' TERM

owner_of() { cat "$LOCK/owner" 2>/dev/null || true; }

# "<pid> <host> <epoch>" — true when that owner is gone: same host and the pid is dead,
# or the lock is older than STALE_S (the only signal available for another host).
dead_owner() {
  o="$1"
  [ -n "$o" ] || return 0
  pid=$(echo "$o" | cut -d' ' -f1); host=$(echo "$o" | cut -d' ' -f2); born=$(echo "$o" | cut -d' ' -f3)
  case "$born" in ''|*[!0-9]*) born=0 ;; esac
  if [ "$born" -gt 0 ] && [ $(( $(date +%s) - born )) -gt "$STALE_S" ]; then return 0; fi
  if [ "$host" = "$(hostname)" ] && [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then return 0; fi
  return 1
}

waited=0; noted=0
until mkdir "$LOCK" 2>/dev/null; do
  # mkdir failed and there is no lock: the PATH is unusable, not contended. Say so now —
  # queueing for an hour behind a lock that cannot exist is the worst of both worlds.
  [ -d "$LOCK" ] || { echo "FAIL lock: cannot create $LOCK — nothing merged"; exit 6; }
  if [ "$waited" -ge "$WAIT_S" ]; then
    echo "FAIL lock: another merge-wave has held $LOCK for ${waited}s (owner: $(owner_of)) — nothing merged"; exit 6
  fi
  o="$(owner_of)"
  if [ "$noted" -eq 0 ] || [ $(( waited % 60 )) -lt "$POLL_S" ]; then
    echo "merge-wave: waiting for another merge in this checkout (owner: ${o:-unknown}, ${waited}s so far)" >&2
    noted=1
  fi
  if dead_owner "$o"; then
    # Re-read after a beat: only break a lock whose owner line has not changed, so two
    # waiters cannot tear down a lock a third one has just legitimately taken. The beat
    # counts against the budget like any other wait — no path through this loop is free.
    sleep 1; waited=$(( waited + 1 ))
    if [ "$(owner_of)" = "$o" ]; then rm -rf "$LOCK"; fi
    continue
  fi
  sleep "$POLL_S"; waited=$(( waited + POLL_S ))
done
HELD=1
printf '%s %s %s\n' "$$" "$(hostname)" "$(date +%s)" > "$LOCK/owner"

# --- merge, gate, push --------------------------------------------------------
LOGS="${TMPDIR:-/tmp}/mw-$$"; mkdir -p "$LOGS"
[ -z "$(git status --porcelain)" ] || { echo "FAIL dirty tree"; exit 1; }
git merge --no-ff "$B" -m "$M

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019gpPtEAhKfcQc7vfZtmT2L" >"$LOGS/merge.log" 2>&1 || { echo "FAIL merge conflict: $(git diff --name-only --diff-filter=U | tr '\n' ' ')"; exit 2; }
GATED="$(git rev-parse HEAD)"
bun install >/dev/null 2>&1
bun run typecheck >"$LOGS/tc.log" 2>&1; TC=$?
bun test >"$LOGS/test.log" 2>&1; TE=$?
bun run build >"$LOGS/build.log" 2>&1; BU=$?
SEAM=$(grep -rn 'Bun\.' src | grep -v src/core/runtime/ | wc -l | tr -d ' ')
FAILS=$(grep -c '^(fail)' "$LOGS/test.log"); TESTS=$(tail -1 "$LOGS/test.log" | grep -oE 'Ran [0-9]+ tests' )
NOW="$(git rev-parse HEAD)"
if [ "$NOW" != "$GATED" ]; then
  echo "FAIL HEAD moved during the gates: gated $(git rev-parse --short "$GATED"), now $(git rev-parse --short "$NOW") — those gate results describe a tree this run is not pushing; NOT pushed. Logs: $LOGS"; exit 5
fi
if [ $TC -ne 0 ] || [ $TE -ne 0 ] || [ $BU -ne 0 ] || [ "$SEAM" != "0" ]; then
  echo "FAIL typecheck=$TC test=$TE(fails=$FAILS) build=$BU seam=$SEAM — main left at merge commit $(git rev-parse --short HEAD), NOT pushed; logs: $LOGS; failing: $(grep '^(fail)' "$LOGS/test.log" | head -3 | cut -c1-80 | tr '\n' '|')"; exit 3
fi
# Push the commit that was GATED, not the `main` ref — which need not be the same object.
# `git push origin main` publishes refs/heads/main whatever HEAD is: gate one tree, push
# another, the same class of lie as #44's race. `HEAD:main` can only publish what ran.
if git rev-parse --verify -q origin/main >/dev/null; then
  git merge-base --is-ancestor origin/main HEAD || {
    echo "FAIL not a fast-forward: $(git rev-parse --short origin/main) (origin/main) is not an ancestor of the gated $(git rev-parse --short HEAD) — NOT pushed"; exit 7
  }
fi
git push -q origin HEAD:main || { echo "FAIL push"; exit 4; }
rm -rf "$LOGS"   # a green run's logs are noise; every FAIL above names the directory it kept
echo "OK $(git rev-parse --short HEAD) $TESTS 0 fail · typecheck/build/seam clean · pushed"
