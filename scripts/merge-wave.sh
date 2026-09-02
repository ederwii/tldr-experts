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
#   3. A `reference-transaction` guard, installed on every run (#89). The first two defend
#      against another MERGE-WAVE; neither has anything to say about an agent typing
#      `git reset --hard origin/main` into this same shared checkout, which is exactly what
#      happened on 2026-09-02. See scripts/merge-guard.sh for what git lets it stop and
#      what it demonstrably cannot.
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
# also the right scope — every worktree of this repo pushes the same `main`. That
# resolution, and the rules for when an owner counts as dead, live in merge-lock.sh
# because scripts/merge-guard.sh has to answer both questions the same way.
MW_DIR="$(cd "$(dirname "$0")" && pwd)"
[ -f "$MW_DIR/merge-lock.sh" ] || { echo "FAIL lock: $MW_DIR/merge-lock.sh is missing — nothing merged"; exit 6; }
# shellcheck source=scripts/merge-lock.sh
. "$MW_DIR/merge-lock.sh"
mw_lock_paths || { echo "FAIL lock: cannot resolve this repository's git dir — nothing merged"; exit 6; }
LOCK="$MW_LOCK"
MARKER="$(mw_marker_path)"
WAIT_S="${MW_LOCK_WAIT_S:-3600}"    # how long to queue behind another merge before giving up
POLL_S="${MW_LOCK_POLL_S:-2}"       # MW_LOCK_STALE_S is read by mw_dead_owner in the library
# Install the ref guard BEFORE queueing (#89). The lock stops another merge-wave; only the
# guard stops another agent's raw `git reset --hard` in this same shared checkout, which is
# what destroyed a merge commit mid-gate on 2026-09-02. Not fatal when it will not install:
# an unguarded merge still beats no merge, and the refusal says so on stderr.
bash "$MW_DIR/merge-guard.sh" --install; GUARD=$?
[ "$GUARD" = 0 ] || echo "merge-wave: the ref guard did not install (exit $GUARD) — merging UNGUARDED" >&2
# The token that tells THIS run's own git apart from a sibling's. Exported, so every git
# child inherits it; generated before the wait loop, so no path through it leaves it unset.
MW_LOCK_TOKEN="mw-$$-$(date +%s)-${RANDOM:-0}"
export MW_LOCK_TOKEN
HELD=0
# The marker goes with the lock, on every path out — including the INT/TERM traps below.
release() { if [ "$HELD" = 1 ]; then rm -f "$MARKER" "$MARKER.tmp.$$"; rm -rf "$LOCK"; fi; return 0; }
trap release EXIT
# A signal that is not trapped kills bash WITHOUT running the EXIT trap, so an
# interrupted merge would leave its lock behind. The stale rules below would break it
# open a second later; releasing here means nobody has to.
trap 'release; exit 130' INT
trap 'release; exit 143' TERM

waited=0; noted=0
until mkdir "$LOCK" 2>/dev/null; do
  # mkdir failed and there is no lock: the PATH is unusable, not contended. Say so now —
  # queueing for an hour behind a lock that cannot exist is the worst of both worlds.
  [ -d "$LOCK" ] || { echo "FAIL lock: cannot create $LOCK — nothing merged"; exit 6; }
  if [ "$waited" -ge "$WAIT_S" ]; then
    echo "FAIL lock: another merge-wave has held $LOCK for ${waited}s (owner: $(mw_owner_of)) — nothing merged"; exit 6
  fi
  o="$(mw_owner_of)"
  if [ "$noted" -eq 0 ] || [ $(( waited % 60 )) -lt "$POLL_S" ]; then
    echo "merge-wave: waiting for another merge in this checkout (owner: ${o:-unknown}, ${waited}s so far)" >&2
    noted=1
  fi
  if mw_dead_owner "$o"; then
    # Re-read after a beat: only break a lock whose owner line has not changed, so two
    # waiters cannot tear down a lock a third one has just legitimately taken. The beat
    # counts against the budget like any other wait — no path through this loop is free.
    sleep 1; waited=$(( waited + 1 ))
    if [ "$(mw_owner_of)" = "$o" ]; then rm -rf "$LOCK"; fi
    continue
  fi
  sleep "$POLL_S"; waited=$(( waited + POLL_S ))
done
HELD=1
# `owner` is what everyone else polls for — a waiting merge-wave, and this run's own tests.
# So it is published LAST, after the token the guard recognises this run by and after the
# marker a human reads: by the time anything can see this lock as taken, both are complete.
printf '%s\n' "$MW_LOCK_TOKEN" > "$LOCK/token"
# The lock lives inside the git dir where nobody trips over it. The marker is the same fact
# where somebody WILL: at the root of the shared checkout, gitignored so it cannot dirty the
# tree it is guarding, and removed by release() on every path out.
#
# Written to a temp file and MOVED into place. A reader that catches a `> "$MARKER"` block
# halfway through gets a marker missing the very line that tells them what to do instead —
# measured, as a flaky test, before it could be measured as a confused agent.
if {
  echo "MERGE WAVE IN PROGRESS — do not run git in this checkout."
  echo
  echo "branch: $B"
  echo "owner:  pid $$ on $(hostname), since $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "lock:   $LOCK"
  echo
  echo "Agents: work in your OWN worktree and merge ONLY through scripts/merge-wave.sh."
  echo "Never 'git reset --hard' or 'git checkout -B main' in this shared checkout."
} > "$MARKER.tmp.$$"; then
  mv -f "$MARKER.tmp.$$" "$MARKER"; MV=$?
  [ "$MV" = 0 ] || echo "merge-wave: could not publish $MARKER (mv exit $MV) — the wave is unadvertised" >&2
else
  echo "merge-wave: could not write $MARKER.tmp.$$ — the wave is unadvertised, merging anyway" >&2
fi
printf '%s %s %s\n' "$$" "$(hostname)" "$(date +%s)" > "$LOCK/owner"

# --- merge, gate, push --------------------------------------------------------
LOGS="${TMPDIR:-/tmp}/mw-$$"; mkdir -p "$LOGS"
# Named, not just flagged (#76). By this line the lock is HELD, so dirt in this shared
# checkout is more likely another run's residue than the caller's own work — and "FAIL
# dirty tree" alone sends them looking in the wrong place, with nothing to look at.
DIRT="$(git status --porcelain)"
[ -z "$DIRT" ] || { echo "FAIL dirty tree — the lock is held, so this is more likely another run's residue in this SHARED checkout than your own: $(echo "$DIRT" | tr '\n' ' ' | cut -c1-300)"; exit 1; }
git merge --no-ff "$B" -m "$M

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019gpPtEAhKfcQc7vfZtmT2L" >"$LOGS/merge.log" 2>&1 || {
  # Collect the conflicting paths, THEN abort (#76) — the order `mergeNoFf` uses in
  # src/core/build/git.ts, and for the same reason. `exit 2` fires the EXIT trap, which
  # hands the LOCK back; without this abort the conflicted INDEX survives that handover,
  # and every sibling queued behind it then dies on the dirty-tree guard above having
  # merged nothing, until a human intervenes. One conflict wedged the whole wave.
  # The agent still learns exactly which files conflicted and still has to rebase.
  CONFLICTS="$(git diff --name-only --diff-filter=U | tr '\n' ' ')"
  # The guard above proved this tree clean moments ago under the lock, so the fallback
  # can only ever discard the failed merge's own residue.
  git merge --abort >>"$LOGS/merge.log" 2>&1 || git reset -q --hard HEAD >>"$LOGS/merge.log" 2>&1
  LEFT="$(git status --porcelain)"
  if [ -n "$LEFT" ]; then
    echo "FAIL merge conflict: ${CONFLICTS}— and the abort did NOT clean up; this checkout still needs a human: $(echo "$LEFT" | tr '\n' ' ' | cut -c1-200)"
  else
    echo "FAIL merge conflict: ${CONFLICTS}— aborted, checkout left clean; rebase $B on main and retry"
  fi
  exit 2
}
GATED="$(git rev-parse HEAD)"
bun install >/dev/null 2>&1
bun run typecheck >"$LOGS/tc.log" 2>&1; TC=$?
bun test >"$LOGS/test.log" 2>&1; TE=$?
bun run build >"$LOGS/build.log" 2>&1; BU=$?
# The docs site is a BUILD, and until #114 it was the only one that ran after the push.
# `ignoreDeadLinks: false` is deliberate, and `docs-site/package.json` runs two generators
# before VitePress — so a moved page or a generator that throws used to reach `main` green
# and go red as a failed DEPLOY, which is `main` broken AND the published site stale.
# Measured 2026-09-02 on this repo, warm: 4 s wall, and `git status --porcelain` empty
# before and after, so it cannot leave dirt that fails the NEXT wave's dirty-tree guard.
# Against a `bun test` of ~440 s it is noise. It blocks, like every other gate here.
bun run docs:build >"$LOGS/docs.log" 2>&1; DO=$?
SEAM=$(grep -rn 'Bun\.' src | grep -v src/core/runtime/ | wc -l | tr -d ' ')
FAILS=$(grep -c '^(fail)' "$LOGS/test.log"); TESTS=$(tail -1 "$LOGS/test.log" | grep -oE 'Ran [0-9]+ tests' )
NOW="$(git rev-parse HEAD)"
if [ "$NOW" != "$GATED" ]; then
  echo "FAIL HEAD moved during the gates: gated $(git rev-parse --short "$GATED"), now $(git rev-parse --short "$NOW") — those gate results describe a tree this run is not pushing; NOT pushed. Logs: $LOGS"; exit 5
fi
if [ $TC -ne 0 ] || [ $TE -ne 0 ] || [ $BU -ne 0 ] || [ $DO -ne 0 ] || [ "$SEAM" != "0" ]; then
  echo "FAIL typecheck=$TC test=$TE(fails=$FAILS) build=$BU docs=$DO seam=$SEAM — main left at merge commit $(git rev-parse --short HEAD), NOT pushed; logs: $LOGS; failing: $(grep '^(fail)' "$LOGS/test.log" | head -3 | cut -c1-80 | tr '\n' '|')"; exit 3
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
echo "OK $(git rev-parse --short HEAD) $TESTS 0 fail · typecheck/build/docs/seam clean · pushed"
