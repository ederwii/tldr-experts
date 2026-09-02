#!/usr/bin/env bash
# The merge guard (#89) — git's own veto on raw state changes in the SHARED checkout while
# a merge wave holds the lock.
#
# WHAT HAPPENED. 2026-09-02, while agent A's merge-wave gates were running, agent B typed
# `git reset --hard origin/main` into the same shared ~/tldr-experts checkout. The reflog
# reads `reset: moving to origin/main`; A's merge commit stopped being reachable from `main`
# mid-gate. #44's gated-HEAD assertion fired and refused to push. The aftermath was caught;
# the damage was not prevented. The lock serialises merge-wave INVOCATIONS — it has never
# had anything to say about a human or an agent running git by hand.
#
# WHAT GIT ACTUALLY OFFERS. There is no pre-reset, pre-checkout or pre-merge hook. The one
# hook git will let abort work in progress is `reference-transaction`, which fires for every
# reference update and, in its PREPARE state only, aborts the whole transaction when it exits
# non-zero. That state's NAME is not portable — git 2.50.1 on macOS passes `prepared`, the
# Linux CI runner's git says `preparing` in its own error text — so this script recognises
# `committed` and `aborted` and treats everything else as the prepare state. Measured on
# git 2.50.1, with this guard refusing:
#
#   git reset --hard <ref>   → exit 128, `fatal: ref updates aborted by hook`, HEAD UNMOVED
#   git checkout -B main …   → exit 128, ref unmoved
#   git merge --no-ff …      → exit 128, ref unmoved AND the worktree untouched
#   git commit               → exit 128, and `--no-verify` does NOT bypass it
#   git update-ref …         → exit 128
#
# WHERE THE LINE IS, HONESTLY. `git reset --hard` writes the WORKING TREE before it opens
# any ref transaction — measured: the file content had already changed to the target
# commit's while HEAD still pointed at the old one. So this guard saves the COMMIT, which
# is what #89 lost, and cannot save the checked-out files. A wave whose worktree is
# clobbered mid-gate still gates a tree nobody meant it to gate; its gated-HEAD assertion
# will not fire, because HEAD is exactly where it left it. That residue is visible as a
# dirty tree afterwards, and the marker file at the repo root is what tells whoever is
# holding the keyboard to stop. Beyond that the guard is a hook in a checkout: anyone
# willing to run `git -c core.hooksPath=…`, delete the hook, or export MW_LOCK_TOKEN
# defeats it. It is built against accidents, not against intent.
#
# Three ways in:
#   --install                     write the hook shim into this repository's common git dir
#   --check                       answer the same question with no transaction to hang it on
#   <reference-transaction state> the hook itself; ref lines arrive on stdin
set -u

MARK='tldr-experts merge guard (#89)'
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
LIB="$(dirname "$SELF")/merge-lock.sh"
if [ ! -f "$LIB" ]; then
  # Fail OPEN, loudly. A guard that cannot read its own vocabulary must not be able to brick
  # the checkout it is guarding — including the ability to git-restore the file it is missing.
  echo "merge-guard: $LIB is missing — ref updates are NOT guarded" >&2
  exit 0
fi
# shellcheck source=scripts/merge-lock.sh
. "$LIB"

install_hook() {
  mw_lock_paths || { echo "merge-guard: not inside a git repository — nothing to install into" >&2; return 2; }
  local hooks hook
  hooks="$MW_GITDIR/hooks"
  mkdir -p "$hooks" || return 2
  hook="$hooks/reference-transaction"
  if [ -e "$hook" ] && ! grep -qF "$MARK" "$hook" 2>/dev/null; then
    echo "merge-guard: $hook already exists and is not ours — left alone; the guard is NOT installed" >&2
    return 3
  fi
  cat > "$hook" <<EOF
#!/usr/bin/env bash
# $MARK — installed by scripts/merge-guard.sh --install. Regenerated on every merge-wave run.
G='$SELF'
[ -f "\$G" ] || { echo "merge-guard: \$G is missing — ref updates are NOT guarded" >&2; exit 0; }
exec bash "\$G" "\$@"
EOF
  chmod +x "$hook" || return 2
  return 0
}

refuse() {
  local why="$1"
  {
    echo "REFUSED by the tldr-experts merge guard (#89): a merge wave holds $MW_LOCK"
    echo "  owner:  $(mw_owner_of)"
    echo "  reason: $why"
    echo "  see:    $(mw_marker_path)"
    echo "  Work in your OWN worktree (git worktree add …) and merge ONLY through"
    echo "  scripts/merge-wave.sh. Never 'git reset --hard' or 'git checkout -B main' here."
  } >&2
  exit 1
}

case "${1:-}" in
  --install) install_hook; exit $? ;;
  --check)
    mw_lock_paths || exit 0
    mw_foreign_wave_in_progress || exit 0
    mw_in_shared_checkout || exit 0
    refuse "this is the shared checkout"
    ;;
  "") echo "usage: merge-guard.sh --install | --check | <reference-transaction state>" >&2; exit 2 ;;
  committed|aborted) exit 0 ;;   # git ignores the exit code for these
  # EVERY other state runs the decision, and the default is deliberate. This shipped red:
  # macOS git 2.50.1 names the abortable state `prepared`, the CI runner's git names it
  # something else (`fatal: in 'preparing' phase, update aborted by the reference-transaction
  # hook`), and a `*)` arm that printed usage and exited 2 turned the guard into a blanket
  # refusal of every ref update on that machine — the whole merge-wave suite went red at once.
  # Falling through here cannot repeat that: git honours the exit code in the prepare state
  # ONLY, so running the decision for an unrecognised state is either correct or ignored,
  # and the decision itself refuses nothing unless a foreign wave actually holds the lock.
  *) ;;
esac

# `prepared`. Drain stdin first, always: git is writing the ref lines into this pipe and a
# guard that exits without reading them turns a clean refusal into a broken pipe.
REFS="$(cat 2>/dev/null || true)"

mw_lock_paths || exit 0
mw_foreign_wave_in_progress || exit 0

if mw_in_shared_checkout; then
  refuse "state-changing git in the shared checkout while another invocation holds the lock"
fi
# From a linked worktree an agent's own branch is their own business. `refs/heads/main` is
# not: refs live in the COMMON dir, so `git update-ref refs/heads/main` typed in a worktree
# destroys the wave just as thoroughly as a reset in the shared checkout would.
case "$REFS" in
  *refs/heads/main*) refuse "refs/heads/main is being updated from outside merge-wave" ;;
esac
exit 0
