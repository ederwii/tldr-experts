verdict: merge
reviewed-by: fresh reviewer sub-agent, claude-sonnet-5, dispatched by session tldr-experts-4a
against: 8d0e0a7

## Round 2 (a114dd8..8d0e0a7) — the fix for round 1's Important

- AGENTS.md §4's #213 paragraph reworded: no longer says #213 "is NOT fixed" / fails
  "at any budget"; now says it "is now BOUNDED at the source too" via the watch-mode
  sweep (names `SWEEP_MS`, 2 s) and that a no-frame dashboard failure is a real defect
  to file, not a re-run. CONFIRMED true to code: `SWEEP_MS = 2_000` and the sweep
  running in both modes are both present in `src/core/dashboard/server.ts` (round 1).
  Grepped the whole file for `#213`/`#193`/`fseventsd`/`SWEEP_MS`/`sweep` — appears
  once, at this paragraph; no restatement elsewhere in AGENTS.md.
- `simulateWatcherLoss()` (server.ts) now carries `@internal` on its DashboardServer
  interface doc comment — addresses round 1's surface-hygiene minor.
- `SWEEP_MS`'s doc comment gained a measured zero-client cost note: "floor of 20
  `fingerprint` calls over a 1,021-entry workspace is 2.38 ms, once every 2 s" —
  consistent with my own round-1 synthetic measurement (~2.9 ms avg over 1,050
  entries); addresses round 1's "not gated on clients.size" minor with a real number
  rather than leaving it unexamined. The stated tradeoff (gating on `clients.size`
  costs a stale baseline on first connection) is a reasonable design rationale, not
  independently re-derived here.
- `bun run typecheck`: exit 0. Diff is comments/docs only (AGENTS.md prose, JSDoc) —
  no logic touched, so round 1's test run (129 pass / 0 fail, dashboard-live +
  dashboard-server + machine-load, single run) still stands as current.

## Round 1 (a15fbc5..a114dd8) — the substantive review

- `bun run typecheck`: exit 0.
- `bun test test/dashboard-live.test.ts test/dashboard-server.test.ts
  test/machine-load.test.ts`: 129 pass, 0 fail, 18.05s, one run, no red.
- Idempotence: traced `fire()`/`swept`/`onChange` (server.ts) by hand — a watcher-fire
  and a sweep-fire in the same debounce window cannot produce two client-visible
  frames; `onChange`'s `next === shown` guard dedups at the model level regardless of
  which path triggered it, matching the implementer's claim.
- Sweep cost: `fingerprint`/`MAX_SWEEP_ENTRIES` predate this branch, only the
  watch-mode cadence is new. Measured synthetically: ~2.9 ms/sweep over 1,050
  entries; negligible at 2 s cadence.
- `eventWaitMs`/`spawnTestTimeout` (test/fixtures/machineLoad.ts): `clamp()` floors
  `loadFactor()` at 1, so a wait can never scale below its base. Confirmed by
  reading. Every per-test `spawnTestTimeout(N)` in the diff exceeds the sum of its
  `eventWaitMs()` calls at any load factor (margins ~1.28x-1.5x), hand-summed.
- `machine-load.test.ts` literal guard ran green in the same pass; its regex is
  scoped to a closing-brace immediately before a trailing numeral (test-timeout
  args), so a bare `port: 3000`-style literal elsewhere would not match it.
- CHANGELOG: two bullets present under `## 0.14.3 — unreleased`, content matches the
  measured commit messages.
- Found and required a fix for: AGENTS.md's #213 paragraph (added in commit
  `c3c0e34`, before `a114dd8` closed #213) still read "is NOT fixed" at that head,
  contradicting the branch's own closing commit. Resolved in round 2 (`8d0e0a7`).
