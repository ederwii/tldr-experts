# Wave 1a — records and money that do not lie

Status: approved in scope by the owner on 2026-09-06 as the first of four hardening waves
(measured from three real-run transcripts; the transcripts themselves are private and never
cited here). Release target: the next patch. Implementation plan:
`docs/superpowers/plans/2026-09-06-wave1a-records-money-plan.md`.

## 1. Problem

The framework's thesis is that its records never lie in the dangerous direction (AGENTS.md
§7). Five measured mechanisms break that in its own ledger:

1. **Invented `$0.00`.** `src/core/facilitator/spawnAgent.ts:339-340` writes
   `cost_usd: 0, metered: true` for a Claude turn whose result carries no `total_cost_usd`,
   contradicting the field's own contract at `:149`. A stage or a whole run can read `$0.00`
   after real turns ran.
2. **A refusal discards a cost.** `runNext.ts:1230-1240` returns `EXIT_AGENT_FAILED` on an
   unreadable `questions.md` BEFORE `recordTask` (`:1251`); the turn ran, the ledger has no row.
3. **The 4096-byte event cap throws and loses the whole invocation's rows.** `EventLog.append`
   throws on an oversized payload (`Event.ts:130,170-173`; `EventLog.ts:34-38`); the reviewer
   verdict `detail` is the overflowing field (`build.ts:2435-2442`); `runNext.ts:1082-1087`
   has no `try/finally`, so `recordExecutorTasks` (`:1114`) and `store.save()` never run — the
   epic merge stands, every task's cost is gone.
4. **Token split parsed, never persisted.** Input/output tokens are parsed (`envelope.ts:93-101`,
   `agentEvents.ts:160-165`) but only reach the `agent.result` event; `run.yml` rows carry none,
   so every dollar downstream is an unfalsifiable bound.
5. **`tldrx facts add` is instructed but does not exist.** The drive mandate tells the driver to
   run it (`src/core/drive/mandate.ts:347`, pinned by `test/drive.test.ts:563`); no such command
   is dispatched (`src/cli/index.ts:56-87`, no `facts` in `helpText.ts`). Drivers then hand-edit
   `facts.yml`, bypassing `FactsStore.append`'s cap and `truncated:` marker — the mid-word cut
   seen in a real `facts.yml` (`inferred`: only a hand edit can produce it).
6. **A cached red base is trusted forever.** `04-build/preflight.yml` is invalidated only by a
   base-sha comparison that no-ops on empty shas (`src/core/build/preflight.ts:189`);
   `checked_at` is written, never compared; `--prepare` returns the cached red in 0 s
   (`build.ts:667-673, 2971-2972`) over a base that a live probe shows green.
7. **The resolved-sha check accepts a truncated sha silently.** `fixlist.ts:379`
   `/\b([0-9a-f]{7,40})\b/` treats a 39-char sha as an abbreviation; git resolves it, and the
   record keeps the truncated form.

## 2. Decisions

- **No new `spendBasis` word.** `absent` already means "not recorded — <reason>"; the fix is to
  make more turns reach it honestly (`src/core/budget/spendBasis.ts:83-139` stays the one
  derivation).
- **`metered` is derived from the presence of a USD figure**: no `total_cost_usd` → `cost_usd:
  null, metered: false`. The whole chain (`RunDocument.ts:408-414`, dashboard, `budget show`)
  already handles that shape; tests that pinned the invented zero are re-pinned to the honest
  value (each such re-pin is listed in the report as a behaviour change, not a guard).
- **Cost is recorded before any refusal** in `runNext`: the row lands, then the refusal exits.
- **Additive `input_tokens` / `output_tokens` on the `run.yml` task row** (`RunFile.ts:193`
  family), written from the parsed usage for provider turns; `tokens` keeps its meaning (host
  declarations). `version: 1` unchanged; old rows load.
- **The 4096-byte cap is honoured at the emit seam, never raised.** `runNext.ts:1082`: an
  oversized `detail` is replaced by an additive `detail_omitted: "<n> bytes exceeds the
  4096-byte cap — full text in <review file>"` (the prose is already on disk via `writeLog`,
  `build.ts:2569-2572`); the executor call is wrapped so `recordExecutorTasks` and
  `store.save()` run on any throw. No `build.ts` edit.
- **`tldrx facts add` becomes a real command** wrapping `FactsStore.append`
  (`src/core/facts/FactsStore.ts:83-101`): enforces `MAX_FACT_CHARS`, sets `truncated: true`
  with the `…` marker, validates on save, and records attribution (`decided_by: owner|driver`,
  because 0.8.0's rule is that a driver default is never cited as the owner's). The surface is
  whatever the mandate string already promises — read `mandate.ts:347` and make the help text
  match it; `--help` is the authoritative surface and docs quote it.
- **Preflight cache honesty** (`preflight.ts`, a leaf; `build.ts` only passes arguments):
  additive `command_hash` per row; a cached **red** is re-probed when the command hash differs,
  when `checked_at` is older than `PREFLIGHT_RED_TTL_MS` (30 min), or always under `--prepare`
  (a 0-second prepare over a red is the lie); a cached green keeps today's sha rule. The test
  that pins "not re-run" (`test/dod-preflight.test.ts:159-172`) is re-scoped to the green case.
- **Fix-list canonical sha**: keep the 7–40 grammar, but after `git rev-parse --verify` the
  full 40-hex object is written back into the fix list (a sibling of `markUnverified` in the
  `fixlist.ts` leaf). Stronger than demanding 40 and refuses no legitimate abbreviation.
- **Deferred to wave 2 with the decomposition** (build.ts territory, filed with evidence):
  a verified-green re-run that moves a false-red story out of `blocked`; the five unverified
  `openFindings` call sites; whether cross-story sha reachability is intended.

## 3. Non-goals

Raising the cap · a fifth `spendBasis` word · restructuring `build.ts` · changing what
`tokens` means · any docs-site restructuring beyond the pages the change touches.

## 4. Tests (red-first, verbatim RED kept)

`metered:false` + `cost_usd:null` on a Claude result without USD (mutate back to see red both
ways) · a `questions.md` refusal still leaves the cost row · an oversized reviewer verdict:
events carry `detail_omitted`, the merge stands, every task row and `store.save()` land · token
split round-trips through `run.yml` and old rows load · `tldrx facts add` exists, enforces the
cap and marker, and the mandate's string is a runnable command (`test/drive.test.ts:563` stays
green) · preflight: changed command / stale red / `--prepare` re-probe, green stays cached ·
fix list rewrites a 39-char sha to the canonical 40 · `version: 1` pins unchanged.

## 5. Docs (EN and ES in lockstep)

CHANGELOG `## 0.9.1 — unreleased` with `### Fixed` (the why) and `### Added` (`facts add`,
token fields) · `docs/spec.md` for the new `run.yml` fields, the `detail_omitted` payload key,
the `preflight.yml` `command_hash` · CLI reference for `facts add` (`docs/guide/08-cli-reference.md`,
docs-site `reference/cli.md` EN+ES) · `docs/ROADMAP.md` gains the tracked item "decompose
`src/core/facilitator/executors/build.ts`" (AGENTS.md §12 names it as planned; the roadmap did
not) · the docs-site is being edited concurrently by another session: rebase before the wave.
