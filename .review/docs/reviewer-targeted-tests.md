verdict: merge
reviewed-by: fresh reviewer sub-agent, claude-sonnet-5, dispatched by session tldr-experts-4a
against: a8b223d

Findings: no Critical or Important defects found. Four Minor/PLAUSIBLE notes, none blocking.

- **Minor, PLAUSIBLE** — `publish.yml`'s "ci must be green" query filters only by `head_sha`,
  not by trigger event. A `pull_request`-triggered `ci` run for the same sha would also count
  as green. In this repo's actual release flow (`release.sh` commits and pushes straight to
  `main`) that sha essentially never exists on an open PR too, so real-world likelihood is very
  low; noting for awareness, not requesting a fix.
- **Minor, PLAUSIBLE** — the loop's success check
  (`if [ "$(... | jq ...)" -gt 0 ]`) sits inside an `if` condition, which bash's `set -e`
  (on by default for GitHub Actions `run:` steps) does not apply to. A transient `gh api`
  failure there degrades to "keep polling" rather than crashing loudly — it never flips to a
  false "green," so it fails safe, just less noisily than a hard crash would.
- **Minor** — the failure remedy says "re-run the ci workflow for this sha" without naming a
  command. `ci.yml` has no `workflow_dispatch`, so the actual mechanism is re-running the
  existing (cancelled/failed) run object (`gh run rerun <id>` or the Actions UI), not a fresh
  dispatch. The message doesn't claim otherwise, but a named command would be more actionable.
- **Minor, cosmetic** — in `SKILL.md`, the new "branch name verbatim" sentence was inserted
  mid-paragraph, so it now runs directly into "Re-review after a rebase…" with no break. Reads
  a little dense; not a correctness issue.

Verified, not just read:
- `bun run build`'s removal from `publish.yml` does NOT ship a stale/empty `dist/`:
  `package.json` (unchanged by this diff) already has `"prepublishOnly": "bun run build"`,
  which npm runs automatically on `npm publish --access public` (no `--ignore-scripts`
  anywhere in the step). Confirmed `package.json` has zero diff between 41c5c2c and a8b223d,
  and confirmed via `git log -p` that `prepublishOnly` predates this branch.
  This was the most-likely-Critical hypothesis in the brief and it does not hold.
- The "ci must be green" step runs *before* `release-check.sh --ci` and the
  tag==`package.json` check, as claimed — read the full file top to bottom.
- `ci.yml`'s new `concurrency: group: ci-${{ github.ref }}` does not collide push vs PR
  (`github.ref` for `pull_request` events is `refs/pull/<n>/merge`, distinct per PR; for push
  it's `refs/heads/main`), and a tag push never triggers `ci.yml` (`on:` has no `tags:`), so a
  release tag's push cannot cancel anything in `ci`.
- `docs.yml`'s `docs-site/**` glob already covers `docs-site/scripts/**` (verified by pattern
  semantics and pinned by the new `docs-cli-coverage.test.ts` assertion, which passed).
- Grepped the whole tree for stale "three times" / "runs typecheck, tests and build" copy in
  `RELEASING.md`/`README.md`/docs-site — none found; only unrelated hits in CHANGELOG history
  and the new brief's own prose. No docs-site RELEASING.md mirror exists, so no EN/ES drift.
- `CHANGELOG.md`: 47 additions, 0 deletions vs base — released `0.13.1` section untouched,
  new `## 0.13.2 — unreleased` heading matches convention.
- `.review/` path-verbatim rule (`REVIEW=".review/$B.md"` in `scripts/merge-wave.sh`) was
  unchanged by this diff (`scripts/` shows 0 files touched) — this is documentation of
  existing behavior, not a behavior change, and it's accurate.
- YAML validity: `python3 -c "import yaml; ..."` loaded all three workflow files without error.
- `bun run typecheck` → exit 0.
- `bun test test/maintain-skill.test.ts test/docs-cli-coverage.test.ts test/release-gate-order.test.ts`
  → 125 pass, 0 fail, exit 0.
- `release-gate-order.test.ts`'s diff is purely additive (new `describe` block only); the
  existing commit→gate→push→tag ordering assertions are untouched.
