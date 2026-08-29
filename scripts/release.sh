#!/usr/bin/env bash
# release.sh <version> [--tag alpha|beta|stable]  — the ONLY sanctioned way to cut a release.
# Bumps package.json + plugin.json, dates the CHANGELOG heading, dates the README release row,
# runs release-check.sh, commits "release: <version>", tags v<version>, pushes main + tag.
# The tag push triggers .github/workflows/publish.yml (npm trusted publishing).
set -eu
cd "$(git rev-parse --show-toplevel)"
V="${1:?usage: scripts/release.sh <version> [--tag alpha|beta|stable]}"; TAG="alpha"
[ "${2:-}" = "--tag" ] && TAG="${3:-alpha}"
D=$(date -u +%F)
grep -qE "^## $V — (unreleased|[0-9-]+)$" CHANGELOG.md || { echo "CHANGELOG.md needs a '## $V — unreleased' section listing what shipped"; exit 1; }
node -e "for (const f of ['package.json','plugin/.claude-plugin/plugin.json']){const fs=require('fs');const d=JSON.parse(fs.readFileSync(f));d.version='$V';fs.writeFileSync(f,JSON.stringify(d,null,2)+'\n')}"
sed -i '' -E "s/^## $V — unreleased$/## $V — $D/" CHANGELOG.md
if grep -qE "^\| $V \| unreleased \|" README.md; then sed -i '' -E "s/^\| $V \| unreleased \| \`[a-z]+\` \|/| $V | $D | \`$TAG\` |/" README.md
else echo "README.md release table has no '| $V | unreleased |' row — add one describing what ships"; exit 1; fi
git add package.json plugin/.claude-plugin/plugin.json CHANGELOG.md README.md
git commit -q -m "release: $V"
git push -q origin main
scripts/release-check.sh
git tag -a "v$V" -m "tldr-experts $V"
git push -q origin "v$V"
echo "released $V — tag v$V pushed; publish.yml will publish to npm (watch: gh run list --workflow publish)"
