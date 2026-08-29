#!/usr/bin/env bash
# merge-wave.sh <branch> "<message>" — merge a wave branch into main, run every gate, push.
# Prints ONE summary line; exits non-zero (and leaves main untouched) on any red gate.
set -u
B="${1:?branch}"; M="${2:?message}"; R="$(git rev-parse --show-toplevel)"; cd "$R" || exit 1
[ -z "$(git status --porcelain)" ] || { echo "FAIL dirty tree"; exit 1; }
git merge --no-ff "$B" -m "$M

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019gpPtEAhKfcQc7vfZtmT2L" >/tmp/mw-merge.log 2>&1 || { echo "FAIL merge conflict: $(git diff --name-only --diff-filter=U | tr '\n' ' ')"; exit 2; }
bun install >/dev/null 2>&1
bun run typecheck >/tmp/mw-tc.log 2>&1; TC=$?
bun test >/tmp/mw-test.log 2>&1; TE=$?
bun run build >/tmp/mw-build.log 2>&1; BU=$?
SEAM=$(grep -rn 'Bun\.' src | grep -v src/core/runtime/ | wc -l | tr -d ' ')
FAILS=$(grep -c '^(fail)' /tmp/mw-test.log); TESTS=$(tail -1 /tmp/mw-test.log | grep -oE 'Ran [0-9]+ tests' )
if [ $TC -ne 0 ] || [ $TE -ne 0 ] || [ $BU -ne 0 ] || [ "$SEAM" != "0" ]; then
  echo "FAIL typecheck=$TC test=$TE(fails=$FAILS) build=$BU seam=$SEAM — main left at merge commit $(git rev-parse --short HEAD), NOT pushed; failing: $(grep '^(fail)' /tmp/mw-test.log | head -3 | cut -c1-80 | tr '\n' '|')"; exit 3
fi
git push -q origin main || { echo "FAIL push"; exit 4; }
echo "OK $(git rev-parse --short HEAD) $TESTS 0 fail · typecheck/build/seam clean · pushed"
