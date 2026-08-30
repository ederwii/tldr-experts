#!/bin/sh
# A dod command that fails with a quotable tail — the DoD gate's deny message
# quotes the last meaningful line of the combined output.
echo "4 failing tests in src/features/leaderboard/__tests__/rank.test.ts" >&2
exit 1
