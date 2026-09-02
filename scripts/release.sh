#!/usr/bin/env bash
# release.sh <version> [--tag alpha|beta|stable]  — the ONLY sanctioned way to cut a release.
# Bumps package.json + plugin.json, dates the CHANGELOG heading, dates the README release row,
# commits "release: <version>" LOCALLY, runs release-check.sh --pre-push, and ONLY on green
# pushes main, tags v<version> and pushes the tag.
# The gate before the push is the point (#100): a red check leaves origin/main, the tags and
# npm untouched, so the worst state to recover from is one local commit — never a main
# carrying a dated release commit with no tag behind it.
# The tag push triggers .github/workflows/publish.yml (npm trusted publishing).
set -eu
cd "$(git rev-parse --show-toplevel)"
V="${1:?usage: scripts/release.sh <version> [--tag alpha|beta|stable]}"; TAG="alpha"
[ "${2:-}" = "--tag" ] && TAG="${3:-alpha}"
D=$(date -u +%F)
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
