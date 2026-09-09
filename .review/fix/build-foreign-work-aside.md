verdict: merge
reviewed-by: fresh adversarial reviewer sub-agent, claude-opus-5, dispatched by session tldr-experts-4a
against: 68fe1d6

Two rounds, adversarial, against the first change in this repo that WRITES to an owner's
uncommitted working tree. Every claim below is `measured` unless it says otherwise.

## Round 1 (b539bd2) — three findings, all reproduced

**Critical — a refusal after the stash left the tree short a file, silently.** The stash was the
FIRST Build step, so `refuseOnForeignEpic`/`refuseOnRedBase` could refuse with the owner's files
already moved, through `withClaims` (which restores nothing). Reproduced on the real pipeline
(fixture workspace, one foreign untracked `owner-note.txt`, `git branch epic/e1` pre-created):
exit 2, `stash@{0}: … tldrx 260829-build foreign work`, `git status --porcelain` EMPTY, and the
refusal report said nothing at all — the "set aside" line lived on `this.lines`, which the
refusal outcome discarded. A re-run refused identically, so nothing would ever restore it.

**Important — the printed remedy was a glob.** `stashCommand` joined raw paths. Running the
printed line verbatim for an overlapping `[x].txt`: `git stash push -u -m "…" -- [x].txt` → exit
0, and the neighbouring dirty `x.txt` moved while `[x].txt` did not. Its docstring claimed the
engine ran the same function; the engine went through `literalPathspec`.

**Important — the owner's index was discarded on restore.** HEAD `A` / staged `B` / worktree `C`
(`MM f.txt`) came back ` M f.txt` with `git show :f.txt` reading `A`: the staged snapshot gone.

Minors: the spec's `own` table row claimed "never a refusal" while the multi-repo shape refuses;
an untracked directory moves as a whole tree and the payload names the directory only.

## Round 2 (812878a, replayed on the rebase) — every finding fixed, each re-attacked

- Order is now dirty-check → foreign-epic → STASH → red-base, and `withRestore` wraps every
  return from `buildExecutor`. Replayed both: the foreign-epic refusal never reaches the stash
  (`stash list` empty, `?? owner-note.txt` still in the tree, zero `foreign_work_*` events); the
  red-base refusal stashes, refuses (exit 2), restores, and its report carries BOTH sentences
  ("set aside in stash 78be4e80f5a0" and "foreign work restored from stash 78be4e80f5a0"), with
  `restored: true, index_restored: true` on the log and a clean `stash list`.
- The printed remedy is now shell-quoted `:(literal)` per path. Run verbatim through `sh -c`
  with `[x].txt`, `a b.txt`, `-dash.txt` beside a dirty `x.txt`: exactly the three named files
  moved, `x.txt` untouched. MUTATION-PROVEN: stubbing `shellQuote` to identity turns the new
  test RED (`sh: syntax error near unexpected token '('`).
- `stashPop` is `--index` first. `MM f.txt` round-trips to `MM f.txt`, `:f.txt` = `B`, worktree
  `C`. MUTATION-PROVEN: dropping `--index` turns the new test RED (`Expected "MM f.txt",
  Received " M f.txt"`). The plain-pop fallback records `index_restored: false` and prints "back
  UNSTAGED; `git add` them as you had them" — a partial success named, not dressed as success.
- Restore is once per invocation (`restoreAttempted`), so the success path's double call
  (`finish()` + `withRestore`) writes no duplicate `restored:false` event; a refused pop stays
  pending on the log for a later invocation. No `stash drop`/`clear`/force anywhere in `src/`.

## Also attacked, both rounds (clean)

Pathspec exactness in a throwaway repo over `a b.txt`, `-dash.txt`, `[x].txt`, `a?.txt`,
`ab.txt`, `café.md`, `d:c/new.txt`, `sp ` (trailing space), `--`: only the named paths moved,
and a dirty `x.txt` that `[x].txt` would glob stayed. `dirtyEntries` `-z` returns real bytes and
consumes the rename origin field. Ignored files never enter porcelain and were never touched.
`stashRefFor` found `stash@{1}` correctly with THREE stashes sharing one message. The aside
event is emitted only AFTER a successful push, so the record cannot claim a stash that does not
exist. Mid-merge/rebase refuses at both the caller and the writer. Both event types are in the
closed enum and in spec §2.9; docs EN/ES are in lockstep; CHANGELOG sits under
`## 0.14.3 — unreleased` only.

Residual, not blocking (Minor, unchanged by this branch): when the tree has STAGED its own
version of a stashed path, `git stash pop` auto-merges and leaves conflict markers rather than
aborting whole — measured identically on plain `pop` at b539bd2, so it is git's semantics, not a
regression. The docstring on `stashPop` and spec §5 still say "aborting whole … the tree
untouched", which holds for the unstaged case only. The record errs toward alarm
(`restored: false`, the conflicted path named, the stash kept), which is the safe direction.

Gates on 812878a: `bun run typecheck` exit 0; `bun test test/build-foreign-work.test.ts
test/build-executor.test.ts test/build-golden.test.ts` exit 0 (155 pass, 0 fail — golden
byte-identical). `scripts/release-check.sh --ci` was NOT run (it runs the full suite, which this
review's brief forbids) — unverified here.

## Round 3 — re-verified after the rebase onto 5215a37 (code 7af7472, dbe15a1)

`git diff a15fbc5..812878a` and `git diff 5215a37..dbe15a1`, both excluding `CHANGELOG.md`, are
BYTE-IDENTICAL (`diff` exit 0) — every source and test hunk I attacked is unchanged. The only
non-identical hunk is the CHANGELOG union, and it is a correct union: one
`## 0.14.3 — unreleased`, one `### Changed` (the two #164 bullets), one `### Fixed` carrying
#193, #213 AND both #164 bullets. Nothing dropped, no duplicate heading. Replayed the
post-stash-refusal reproduction on the rebased tree: exit 2, `git stash list` EMPTY,
`?? owner-note.txt` still in the tree, zero `foreign_work_*` events. `bun run typecheck` exit 0;
`bun test test/build-foreign-work.test.ts` exit 0 (19 pass, 0 fail).
