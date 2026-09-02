#!/usr/bin/env bash
# release-check.sh [--ci|--pre-push]  — the hard release gate. Exit 0 only when EVERY check passes.
# Used by: scripts/release.sh, the Claude Code PreToolUse hook (.claude/settings.json) and publish.yml.
set -u
cd "$(git rev-parse --show-toplevel)" || exit 1
CI=false; PREPUSH=false
case "${1:-}" in --ci) CI=true;; --pre-push) PREPUSH=true;; esac
fail=(); ok(){ :; }; bad(){ fail+=("$1"); }
V=$(node -p "require('./package.json').version")
PV=$(node -p "require('./plugin/.claude-plugin/plugin.json').version")
[ "$V" = "$PV" ] && ok || bad "plugin/.claude-plugin/plugin.json version ($PV) != package.json ($V)"
grep -qE "^## $V — [0-9]{4}-[0-9]{2}-[0-9]{2}$" CHANGELOG.md && ok || bad "CHANGELOG.md has no dated heading '## $V — YYYY-MM-DD' (is it still 'unreleased'?)"
grep -qE "^\| $V \| [0-9]{4}-[0-9]{2}-[0-9]{2} \| \`(alpha|beta|stable)\` \|" README.md && ok || bad "README.md release table has no dated row for $V with a status tag (alpha|beta|stable)"
grep -qE "unreleased" <(grep -E "^## $V" CHANGELOG.md) && bad "CHANGELOG.md $V still says unreleased"
if ! $CI; then
  [ -z "$(git status --porcelain)" ] && ok || bad "working tree not clean"
  [ "$(git branch --show-current)" = "main" ] && ok || bad "not on main"
  # --pre-push (scripts/release.sh, #100): the release commit is deliberately still LOCAL, so
  # "HEAD equals origin/main" cannot hold and would make the gate permanently red. What that
  # check is actually for — nobody else moved main under you, and nothing but the release
  # commit itself is unpushed — restates exactly as "origin/main IS HEAD's parent".
  if $PREPUSH; then
    git fetch -q origin main && [ "$(git rev-parse HEAD^ 2>/dev/null)" = "$(git rev-parse origin/main)" ] && ok || bad "the release commit does not sit directly on origin/main (someone pushed, or more than the release commit is unpushed — fetch and rebase; do NOT push)"
  else
    git fetch -q origin main && [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] && ok || bad "main is not in sync with origin/main (push or pull first)"
  fi
  git rev-parse -q --verify "refs/tags/v$V" >/dev/null && bad "tag v$V already exists locally"
  npm view "tldr-experts@$V" version >/dev/null 2>&1 && bad "tldr-experts@$V is already on npm"
  bun run typecheck >/dev/null 2>&1 || bad "typecheck red"
  bun test >/tmp/release-test.log 2>&1 || bad "tests red ($(grep -c '^(fail)' /tmp/release-test.log) failing)"
  bun run build >/dev/null 2>&1 || bad "build red"
  [ "$(grep -rn 'Bun\.' src | grep -v src/core/runtime/ | wc -l | tr -d ' ')" = "0" ] || bad "Bun.* used outside src/core/runtime/"
fi
if [ ${#fail[@]} -gt 0 ]; then printf 'RELEASE CHECK FAILED for %s:\n' "$V"; printf '  - %s\n' "${fail[@]}"; echo "Fix these, or run scripts/release.sh <version> which does the mechanical parts. See docs/RELEASING.md."; exit 1; fi
echo "release check OK for $V"
