#!/usr/bin/env bash
# Claude Code PreToolUse hook (Bash). Denies `git tag`, `git push … v<semver>` and `npm publish`
# unless scripts/release-check.sh passes. Everything else is allowed untouched.
IN=$(cat); CMD=$(printf '%s' "$IN" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(JSON.parse(s).tool_input?.command||'')}catch{}})")
if printf '%s' "$CMD" | grep -qE '(^|[;&|] *)(git tag|git push[^;&|]* v[0-9]+\.[0-9]+\.[0-9]+|npm publish)'; then
  if printf '%s' "$CMD" | grep -q 'scripts/release.sh'; then exit 0; fi
  OUT=$(bash "$(dirname "$0")/release-check.sh" 2>&1) || {
    R=$(printf '%s' "$OUT" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.stringify(s)))")
    printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"[tldr-experts release gate] %s Use scripts/release.sh <version>."}}' "$(printf '%s' "$R" | sed 's/^"//; s/"$//')"
    exit 0; }
fi
exit 0
