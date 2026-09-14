#!/usr/bin/env bash
# release.sh <version> [--tag alpha|beta|stable]  — the ONLY sanctioned way to cut a release.
# Bumps package.json + plugin.json, dates the CHANGELOG heading, dates the README release row,
# commits "release: <version>" LOCALLY, runs release-check.sh --pre-push, and ONLY on green
# pushes main, tags v<version> and pushes the tag.
# The gate before the push is the point (#100): a red check leaves origin/main, the tags and
# npm untouched, so the worst state to recover from is one local commit — never a main
# carrying a dated release commit with no tag behind it.
# The tag push triggers .github/workflows/publish.yml (npm trusted publishing).
# For its WHOLE span — first edit to tag push — it advertises itself as `.RELEASE-IN-PROGRESS`
# at the repo root (#299): `scripts/merge-wave.sh` waits on that marker exactly as it waits on
# its own lock, so "is a release in flight?" is a file and not a question. Removed on every
# exit path, red gate and signal included: a marker left behind freezes merges for an hour.
# And the reverse (#304): before that marker, before the first edit, it WAITS on a running
# wave's lock with the wave's own knobs and dead-owner rule — a release started mid-wave used
# to edit three files in a tree another process was gating, and the only thing that stopped the
# commit was the ref hook, which aborts the commit and leaves the edits dirty.
# Exit codes: 1 a precondition or the gate refused (nothing pushed, the undo is printed) · 14 gave up waiting for a merge wave in flight (#304)
# 14 and not 1 because nothing was edited and there is nothing to undo; not the wave's own 6
# because the two scripts' codes are read in the same logs and docs — merge-wave.sh owns 1–13,
# so the next free number keeps a bare "exit 14" unambiguous across both.
set -eu
cd "$(git rev-parse --show-toplevel)"
V="${1:?usage: scripts/release.sh <version> [--tag alpha|beta|stable]}"; TAG="alpha"
[ "${2:-}" = "--tag" ] && TAG="${3:-alpha}"
D=$(date -u +%F)
# shellcheck source=scripts/merge-lock.sh
. scripts/merge-lock.sh
mw_lock_paths || { echo "release.sh: cannot resolve this repository's git dir — nothing released"; exit 1; }
MARKER="$(mw_release_marker_path)"
trap 'rm -f "$MARKER" "$MARKER.tmp.$$"' EXIT
trap 'rm -f "$MARKER" "$MARKER.tmp.$$"; exit 130' INT
trap 'rm -f "$MARKER" "$MARKER.tmp.$$"; exit 143' TERM
# --- wait on a running wave (#304) -------------------------------------------------------
# The mirror of merge-wave.sh's wait_for_release, beat for beat: poll the wave's lock, break
# open one whose owner is dead (re-read after a beat, so a lock a third party just took is not
# torn down on a stale reading), give up after $WAIT_S. This runs BEFORE the marker and before
# the first edit: a release that is queued has changed nothing, and a wave that finishes finds
# the tree exactly as it left it. Only the lock is broken, as the wave breaks it — the dead
# wave's root marker is overwritten by the next wave and is gitignored for the gate's sake.
WAIT_S="${MW_LOCK_WAIT_S:-3600}"; POLL_S="${MW_LOCK_POLL_S:-2}"   # MW_LOCK_STALE_S: mw_dead_owner
waited=0; noted=0
wave_desc() { printf 'branch %s, pid %s, since %s' "$(cat "$MW_LOCK/branch" 2>/dev/null || echo '?')" "${1%% *}" "$(cat "$MW_LOCK/started" 2>/dev/null || echo '?')"; }
while :; do
  while [ -d "$MW_LOCK" ]; do
    o="$(mw_owner_of)"
    if mw_dead_owner "$o"; then
      sleep 1; waited=$(( waited + 1 ))
      if [ "$(mw_owner_of)" = "$o" ]; then
        rm -rf "$MW_LOCK"
        echo "release.sh: broke open $MW_LOCK — the wave that held it (owner: ${o:-unknown}) is dead" >&2
      fi
      continue
    fi
    if [ "$waited" -ge "$WAIT_S" ]; then
      echo "FAIL merge wave in flight: scripts/merge-wave.sh ($(wave_desc "$o")) has held $MW_LOCK for ${waited}s — nothing released, nothing edited. A release waits for a wave, it does not race it (docs/RELEASING.md)."; exit 14
    fi
    if [ "$noted" -eq 0 ] || [ $(( waited % 60 )) -lt "$POLL_S" ]; then
      echo "release.sh: waiting for a merge wave in this checkout ($(wave_desc "$o"), ${waited}s so far)" >&2
      noted=1
    fi
    sleep "$POLL_S"; waited=$(( waited + POLL_S ))
  done
  # Written whole and MOVED into place, like the wave's marker: a reader must never catch it
  # without the `pid:` line that tells them whether the release is still alive.
  {
    echo "RELEASE IN PROGRESS — scripts/release.sh $V is running in this checkout; merges wait on this file (docs/RELEASING.md)."
    echo "version: $V"
    echo "pid:     $$"
    echo "host:    $(hostname)"
    echo "started: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    echo "epoch:   $(date +%s)"
  } > "$MARKER.tmp.$$"
  mv -f "$MARKER.tmp.$$" "$MARKER"
  # A wave that took its lock in the gap between the last poll and the marker: hand the marker
  # back and queue again, rather than release under a wave because the check ran a beat early.
  # (The wave does the same in the other direction after its mkdir.)
  if [ -d "$MW_LOCK" ] && ! mw_dead_owner "$(mw_owner_of)"; then rm -f "$MARKER"; continue; fi
  break
done
# `sed -i` is not portable — BSD demands a suffix argument, GNU must not have one — and this
# script has to run on the maintainer's Mac and be testable on ubuntu CI. Rewrite through a
# temp file OUTSIDE the tree and `cat` it back: the file keeps its inode and mode, and no
# stray *.tmp is ever left inside the repo for the "working tree clean" check to trip over.
edit(){ local f="$1" e="$2" t; t=$(mktemp) && sed -E "$e" "$f" > "$t" && cat "$t" > "$f" && rm -f "$t"; }
grep -qE "^## $V — (unreleased|[0-9-]+)$" CHANGELOG.md || { echo "CHANGELOG.md needs a '## $V — unreleased' section listing what shipped"; exit 1; }
node -e "for (const f of ['package.json','plugin/.claude-plugin/plugin.json']){const fs=require('fs');const d=JSON.parse(fs.readFileSync(f));d.version='$V';fs.writeFileSync(f,JSON.stringify(d,null,2)+'\n')}"
edit CHANGELOG.md "s/^## $V — unreleased$/## $V — $D/"
if grep -qE "^\| $V \| unreleased \|" README.md; then edit README.md "s/^\| $V \| unreleased \| \`[a-z]+\` \|/| $V | $D | \`$TAG\` |/"
else echo "README.md release table has no '| $V | unreleased |' row — add one describing what ships"; exit 1; fi
git add package.json plugin/.claude-plugin/plugin.json CHANGELOG.md README.md
git commit -q -m "release: $V"
scripts/release-check.sh --pre-push || { echo "release aborted — NOTHING was pushed: origin/main, the tags and npm are untouched. Undo the local release commit with: git reset --hard HEAD~1"; exit 1; }
git push -q origin main
git tag -a "v$V" -m "tldr-experts $V"
git push -q origin "v$V"
echo "released $V — tag v$V pushed; publish.yml will publish to npm (watch: gh run list --workflow publish)"
