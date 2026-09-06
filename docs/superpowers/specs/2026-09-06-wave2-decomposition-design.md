# Wave 2 — decompose the Build executor (pure refactor)

Status: approved in scope by the owner on 2026-09-06 as the second of four hardening waves. Release
target: the next patch (a `### Changed` entry; no behaviour change is claimed or allowed). Plan:
`docs/superpowers/plans/2026-09-06-wave2-decomposition-plan.md`.

## 1. Problem

`src/core/facilitator/executors/build.ts` is 4,351 lines: one class `BuildSession` (`:520-3833`,
107 methods) plus module-level helpers. AGENTS.md §12 names its decomposition as planned debt;
`docs/ROADMAP.md` now tracks it. Every remaining hardening fix (#164 dirty tree, #165 DoD refusal
spelled as exit 126, #166 empty-diff review, the reviewer-path token split) lands inside it, and a
4,000-line diff context is where the review loop is weakest. Measured coupling: twelve methods reach
three or more clusters; the four entry points reach five to seven.

## 2. Decisions

1. **Pure refactor.** No behaviour change: byte-identical prompts, the same events in the same
   order, the same `run.yml` rows, the same exit codes, the same operator lines. Anything that
   looks like a fix is refused and filed.
2. **Target directory is `src/core/build/`** (12 modules already own the phase's machinery;
   `watch.ts` ↔ `src/core/watch/` is the executor shape). No second directory.
3. **Extracted functions take data, not `ctx`** — the rule `src/core/build/` keeps today without
   exception (`render*(parts)`, `load*/save*(runDir)`, `parse*` pure inverse, one `*Error` per
   refusal domain). Mutable session state becomes explicit values the orchestrator owns and passes:
   `PreflightCache`, `EpicState` (`epicWorktrees`, `merged`, `claimedEpics`), `ReviewCounters`
   (`reviews`, `fixlists`, `formatRetries` — three counters of three different things, never
   merged), append-only sinks `lines`/`advisories`/`tasks` passed as arrays, `writes: SerialQueue`
   passed, never duplicated.
4. **Every moved symbol is re-exported from `build.ts`** so the ten importing test files and
   `src/core/facilitator/index.ts:34` see no change. Public surface unchanged.
5. **Golden guard first (step 0b).** Before any move, capture the fake-agent fixture's developer
   prompt, reviewer prompt, `events.jsonl` kinds/payload keys, `run.yml` task rows and exit codes
   into committed golden files under `test/fixtures/build/golden/`, with a test that compares
   byte-for-byte. Every later step must keep it green; the golden is deleted or kept at the end
   by explicit decision (kept — it is the cheapest regression net this file has).
6. **Source-text pins are retargeted, not weakened.** `test/dod-allowlist.test.ts:127-146` reads
   `build.ts` as text for `REVIEWER_TOOLS` / `developerTools(commands` / `tools: REVIEWER_TOOLS`.
   When the pinned lines move, the SAME assertions point at the new file in the SAME commit, as a
   declared deviation with the reason. `build-executor.test.ts:1570` and
   `dashboard-sources.test.ts:620` likewise.
7. **The 126 refusal spelling (#165) moves verbatim** at both sites (`runDod`, `baseResult`); the
   reviewer-path narrowing and its `KNOWN LIMITATION` comments move verbatim; `refuseOnDirtyRepos`
   (#164) moves verbatim. The cut makes them addressable; it does not address them.
8. Dead barrel `src/core/build/index.ts` (zero importers, measured) is deleted in step 0.

## 3. The cut (each step leaves every gate green)

| Step | Creates | Moves (build.ts lines at 0511039) | Risk | Guard |
|---|---|---|---|---|
| 0 | — | delete `build/index.ts`; golden capture test | none | typecheck/build; golden test itself |
| 1 | `build/reviewLedger.ts`, `build/phaseCost.ts` | `:3871-4096`, `:4283-4351` (pure readers) | near zero | attempt-cost, fixlist, story-reopen, remaining-work, build-executor |
| 2 | `build/caps.ts` | `:110-211`, `:3338-3403` (money constants + caps as plain functions over plan/budget) | a transcribed divisor changes a ceiling | money-safety, build-parallel, remaining-work (cross-pins the arithmetic) |
| 3 | `build/dodRunner.ts` + `PreflightCache` | `:2021-2066`, `:2951-3067`, `:3312-3337` | lazy-once preflight becoming per-call (a resumed run re-pays) | dod-preflight, dod-allowlist (source pins), build-executor |
| 4 | `build/worktrees.ts`, `build/branchClaims.ts` + `EpicState` | `:1850-1932`, `:2067-2100`, `:2767-3102`, `:3172-3180`, `:3712-3832` | highest: a dropped `claimedEpics` entry (read by `withClaims` on every exit) or lost `writes` ordering | epic-chain-branch, build-executor `:1523,1601,1607`, story-base, recorded-default-branch, boundary |
| 5 | `build/reviewBundle.ts`, `build/reviewRound.ts` + `ReviewCounters` | `:2101-2472`, `:3443-3711` | the three bounds conflating; source pins on `REVIEWER_TOOLS` retargeted same commit | review-handshake (prompt byte-identity `:218-233`), reviewer-envelope-authority, handshake-sequencing, payload-cap, attempt-cost, fixlist |

What stays in `build.ts` (~1,100 lines): `buildExecutor` + `withClaims`, the refusal helpers,
`openPlan`/`rederiveImplicitPlan`/`discardBundles`/`runTitleOf`, `SerialQueue`, the five entry
points, the wave drivers, the story-state cluster (the session's identity) and the log/handoff
cluster. `openStory` stays as the composer over `worktrees.ts`.

## 4. Non-goals

#164, #165, #166 behaviour; #167 (`ship.ts`) and #168 (`init.ts`) are outside this file entirely;
the reviewer-path token split (#173); the `runExecutor` catch in `runNext.ts`. Any prompt byte
change. Any event, row, or exit-code change.

## 5. Tests and gates

Golden test (step 0b) green after every step · full AGENTS.md §3 gates after every step, exit codes
on their own lines, no filtered `tsc` · `test/machine-load.test.ts`'s computed guard row for any
new spawning test file · `docs:build`. A step whose diff changes a golden byte is a behaviour
change: revert, do not "update the golden".

## 6. Docs

CHANGELOG `## 0.9.2 — unreleased` `### Changed` (the WHY: every remaining hardening fix lands in
this file) · `docs/ROADMAP.md` item marked done with the module map · `docs/spec.md` only if it
names `build.ts` internals (grep) · AGENTS.md §12 sentence updated (the debt is paid; name the
modules) · docs-site only where a page names the file.
