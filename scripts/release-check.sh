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

# --- released sections are immutable (#200) ---------------------------------------------------
# A dated CHANGELOG section is the record of what a tag shipped, and it was silently rewritten
# three times before anything compared the two. #197's `--wait-gates` bullets, merged after
# v0.13.1 was cut and shipped in v0.14.0, were appended to the FIRST `### Added` in the file —
# 0.13.0's, already released — so the changelog claimed a flag for a tag that does not carry it
# (`git show v0.13.0:CHANGELOG.md | grep -c wait-gates` → 0). Same slip in 0.3.1 and 0.6.1.
# For every dated heading whose tag is present, the section must equal that section AT THE TAG,
# which is the only copy nobody can edit afterwards. Tolerant exactly twice, and out loud both
# times: a checkout with no tags (publish.yml's `actions/checkout` fetches none) proves nothing,
# and a tag whose own section still says `unreleased` predates the dating convention. A
# deliberate correction is recorded in CHANGELOG.amendments — a second file, which is the point:
# the failure this catches is an append nobody meant, and an append never edits two files.
#
# An amendment line is `<version> <source-sha> <why>`, and it buys exactly two freedoms, never a
# third: the tag's section must survive as an ORDERED SUBSEQUENCE of the current one (nothing
# deleted, nothing reworded), and every line the amendment ADDS must already exist verbatim in
# `<source-sha>:CHANGELOG.md`. Both halves are the same claim — that this is a MOVE of text the
# changelog already carried. Without them a listed version could say anything, measured: a
# reviewer injected an invented bullet into an amended section and the bare "is it listed?" check
# passed it.
changelog_section() { awk -v v="$1" '/^## /{ if ($2 == v) { p = 1; print; next } else if (p) { exit } } p { print }'; }
amendment_for() { [ -f CHANGELOG.amendments ] && awk -v v="$1" '$1 == v && NF > 2 { print; exit }' CHANGELOG.amendments; }
# Is `tag` an ordered subsequence of `now`, and is every added line present in `src`? Prints the
# first offending line as `REMOVED <line>` / `INVENTED <line>`, and nothing at all when it holds.
amendment_violation() {
  awk -v tagf="$1" -v nowf="$2" -v srcf="$3" '
    FILENAME == tagf { tag[++nt] = $0; next }
    FILENAME == nowf { now[++nn] = $0; next }
    FILENAME == srcf { src[$0] = 1; next }
    END {
      i = 1
      for (j = 1; j <= nn; j++) {
        if (i <= nt && now[j] == tag[i]) { i++; continue }
        added[++na] = now[j]
      }
      if (i <= nt) { printf "REMOVED %s\n", tag[i]; exit }
      for (k = 1; k <= na; k++) if (!(added[k] in src)) { printf "INVENTED %s\n", added[k]; exit }
    }' "$1" "$2" "$3"
}
imm_skipped=0
for ver in $(grep -oE "^## [0-9]+\.[0-9]+\.[0-9]+ — [0-9]{4}-[0-9]{2}-[0-9]{2}$" CHANGELOG.md | awk '{print $2}'); do
  if ! git rev-parse -q --verify "refs/tags/v$ver" >/dev/null 2>&1; then imm_skipped=$((imm_skipped + 1)); continue; fi
  was=$(git show "v$ver:CHANGELOG.md" 2>/dev/null | changelog_section "$ver")
  case "$(printf '%s\n' "$was" | head -1)" in
    "") imm_skipped=$((imm_skipped + 1)); continue;;
    *unreleased*) imm_skipped=$((imm_skipped + 1)); continue;;
  esac
  now=$(changelog_section "$ver" < CHANGELOG.md)
  [ "$was" = "$now" ] && continue
  amend=$(amendment_for "$ver")
  if [ -n "$amend" ]; then
    src_sha=$(printf '%s' "$amend" | awk '{print $2}')
    why="CHANGELOG.amendments names $ver with source sha $src_sha"
    if ! git rev-parse -q --verify "$src_sha^{commit}" >/dev/null 2>&1; then
      bad "CHANGELOG.md: released section '## $ver' — $why, which is not a commit in this repository: an amendment must cite the changelog the moved lines came from"
      continue
    fi
    d=$(mktemp -d) || { bad "CHANGELOG.md: released section '## $ver' — could not create a temp dir to verify the amendment"; continue; }
    printf '%s\n' "$was" > "$d/tag"; printf '%s\n' "$now" > "$d/now"
    git show "$src_sha:CHANGELOG.md" > "$d/src" 2>/dev/null || : > "$d/src"
    viol=$(amendment_violation "$d/tag" "$d/now" "$d/src")
    rm -rf "$d"
    case "$viol" in
      "") echo "released-section check: $ver differs from v$ver:CHANGELOG.md — a recorded amendment, verified as a move of lines present at $src_sha (CHANGELOG.amendments)"; continue;;
      REMOVED\ *) bad "CHANGELOG.md: released section '## $ver' — $why, but the amendment DELETES or rewords a line the tag has: '$(printf '%s' "${viol#REMOVED }" | cut -c1-100)' — an amendment may only ADD; a released line is restored, never edited";;
      INVENTED\ *) bad "CHANGELOG.md: released section '## $ver' — $why, but this added line exists nowhere in $src_sha:CHANGELOG.md: '$(printf '%s' "${viol#INVENTED }" | cut -c1-100)' — an amendment moves text the changelog already carried; it does not write new claims into a shipped release";;
    esac
    continue
  fi
  first=$(diff <(printf '%s\n' "$was") <(printf '%s\n' "$now") | grep -m1 -E "^[<>] " | cut -c3- | cut -c1-100)
  bad "CHANGELOG.md: released section '## $ver' no longer matches v$ver:CHANGELOG.md — first difference: $first  — a released section is restored, never edited: move the bullet under the unreleased heading (or, for a deliberate correction, record it in CHANGELOG.amendments)"
done
[ "$imm_skipped" -gt 0 ] && echo "released-section check: skipped $imm_skipped dated section(s) — no local tag for them, or the tag's own section still said 'unreleased'"

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
