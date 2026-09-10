verdict: merge
reviewed-by: fresh reviewer sub-agent, claude-sonnet-5, dispatched by session tldr-experts-4a
against: a385b2c

# Round 1 (against e82a8ae, base 404e8f4)

Gates: `bun run typecheck` exit 0; `bun test test/input-truncation.test.ts test/maintain-skill.test.ts
test/multi-run.test.ts test/run-provenance-duration.test.ts test/build-golden.test.ts
test/notify-hook.test.ts` — 121 pass, 0 fail, exit 0; `test/spec-event-enum.test.ts` (targeted extra,
directly guards the Event.ts/spec.md enum pair this diff touches) — 2 pass, exit 0.

- Usage honesty (main hunt target): measured against `test/fixtures/agent/stream-json.jsonl` — assistant
  frames carry per-message `input_tokens`/`output_tokens` only (9/9/9/8/8), the `result` line alone carries
  `total_cost_usd` and the turn aggregate. `spawnAgent.ts` and spec §2.9 both say the kept value is "the
  last frame the provider streamed... a floor, never its total, never a price" — never presented as a turn
  total. Minor/PLAUSIBLE: "floor" is a slightly generous word since per-message `input_tokens` isn't
  cumulative (it dips 9→8), so it isn't a guaranteed lower bound on true turn consumption — not blocking,
  since every surface already says "never its total."
- No invented cost confirmed: `costView.ts`'s `usd: metered ? event.cost_usd : null` is untouched by the
  new `usageBasis`/`unmeteredReason` fields; they render on their own line, never folded into a summed
  column.
- `input.truncated` emitted (runNext.ts) before `agent.spawned` and before `spawnAgent` is awaited — a
  killed turn still records the cut. `cost_usd: 0`, consistent with other zero-cost events.
- Notification wording neutral; `truncationSentence` shared by `stage.done`/`run.failed`/`status`
  heartbeat — owner sees it before the stage ends, not only after.
- `run status --verbose`: `truncations` appended LAST in `RunStatusView`; `test/multi-run.test.ts`'s
  `SINGLE_RUN_KEYS` updated to match; non-verbose output untouched.
- Skill briefs: both `SKILL.md` and `sub-agent-briefs.md` state "code head" literally, pinned by
  `test/maintain-skill.test.ts`; genuinely new information, not a restatement of AGENTS.md §2.
- EN/ES docs-site lockstep confirmed for `unattended-operation.md`.
- **Important, raised then WITHDRAWN**: flagged that `## 0.15.0 — unreleased` (CHANGELOG.md) was stacked
  above a pre-existing `## 0.14.3 — unreleased`, reading as two simultaneous unreleased sections. Corrected
  by the coordinator with evidence I had not seen from this worktree: `0.14.3` released on `main` as
  `c33bc82` (tag `v0.14.3`, npm `latest` 0.14.3) after this branch's base was cut, and `## 0.14.3 —
  2026-09-10` is now dated/immutable, matching every sibling branch's heading. My worktree's base (404e8f4)
  simply predated that release. Finding withdrawn as a stale read, not a real defect.

# Round 2 (narrow re-verify, against a385b2c, base 8e102b6)

Branch was rebased onto `main` (8e102b6, tip = #211) picking up #208/#209/#210/#212 unions. Diffed
`git diff 404e8f4..e82a8ae` against `git diff 8e102b6..a385b2c`, CHANGELOG excluded: every non-identical
hunk is exactly the named unions — `notifications.ts` (`truncation` moved to 8th positional after #210's
`outcome`; `run.failed` summary now carries `${delivered}` ahead of the truncation sentence),
`runAuto.ts` (`outcomeLine` and `cutInputs` both passed into `runEndNotification`), `runStatus.ts`
(`outcome` then `truncations`, both appended last), `test/multi-run.test.ts` key list gaining `outcome`
before `truncations`, spec §2.18 (both paragraphs present), and one test-arg fix (7th→8th positional in
`test/input-truncation.test.ts`). No #207/#164/#210/#211 behavior lost or altered beyond line-number
shift. CHANGELOG folded correctly into the (now correct) `0.15.0 — unreleased` section; the stale
`0.14.1`-era default (98,304 B) in the #207 bullet is corrected in prose to note the 256 KB default since
#208.

Rendered a combined `run.failed` summary by hand (outcome=nothing-delivered, note="the stage failed.",
truncation=1-input sentence): reads as exit family, spend, delivery outcome, last line, then the
truncation caveat — no duplication, no ambiguity about which number means what.

Gates: `git status --short` clean; `bun test test/run-outcome.test.ts test/build-foreign-work.test.ts
test/dod-failure-detail.test.ts test/input-truncation.test.ts test/notify-hook.test.ts
test/maintain-skill.test.ts test/multi-run.test.ts` — 145 pass, 0 fail, exit 0; `bun run typecheck` exit
0; `bash scripts/release-check.sh --ci` exit 0 (reports "release check OK for 0.14.3", the released
section's tag match — unrelated to and unaffected by this branch's 0.15.0 section). Ancestry: `git
merge-base --is-ancestor 8e102b6 a385b2c` true; `origin/main` measured at `8e102b6`; branch HEAD at
`a385b2c`, one commit ahead, not yet pushed.

No Important or Critical findings stand. Merge.
