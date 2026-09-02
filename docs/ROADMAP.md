# Roadmap

Source of truth for *what is next*. Facts about *what shipped* live in `CHANGELOG.md`;
design rationale lives in `docs/concept.md`; open design questions in `docs/spec.md` §7.

## v0 — the loop (tagged: v0.0.1 → v0.2.0, all 2026-08-29; install name `tldr-experts`, commands `tldrx` / `tldr-experts`)

`init` (detect → code map → handoff → interview → experts → conventions → process), `run new`
(+ `--from` AI-DLC distill), `next` (headless `claude -p` and in-session `--prepare/--commit`),
`answer / approve / reject / status`, six live hooks (claim-sources, no-re-ask, answer-capture,
dod-gate, budget-gate, session-start), `expert list/create/train --print-prompt`, `replay`,
`retro`, `dashboard --static`, statusline. Runs on Node ≥ 20 or Bun. Released by tag through
npm trusted publishing.

Validated on one real workspace (5 sibling repos): the What phase of a feature run passed the
citation gate on the second attempt; both failures were framework bugs and are fixed.

## v1 — execute and observe (on main, unreleased)

Everything in this section is written and tested on main; none of it is tagged.

- **Build phase for real**: waves from `waves.yml`, one worktree + branch per story, epic
  branches, DoD gate re-running the workspace's own test/lint/typecheck commands, reviewer pass.
- **Watch phase**: `watchers/<feature>.md` generated from what Build actually instrumented.
- **Story / epic / waves schemas** (spec §2.13–§2.15).
- **Live dashboard** (`tldrx dashboard`): same renderer, file watcher + SSE, still read-only.
  A push is sent only when a rebuild of the model differs from the page's, an `age` tick keeps
  the staleness marks honest while nothing happens, and the ledger is read forward from the
  last offset rather than re-read whole.
- **Budget UX**: `budget show` / `budget raise`, estimate vs. ceiling reconciliation so a retry
  is not blocked by its own first attempt; per-attempt accounting in `run status`.
- **Token economy**: cache-friendly prompt order with both cache counters recorded; one shared
  byte budget with declared inputs filled first; a context ledger and `prompt_max_bytes` as a
  refusal; experts ranked by relevance rather than by sharing a repo; `max_reads` as the brake
  `--max-budget-usd` is not; the refused draft handed to attempt 2; `tldrx cost` and
  `tldrx run estimate`.
- **Prose sections are checked**: each of Findings / Decisions / Unknowns / Evidence ledger must
  hold at least one sourced list item, and prose alone is refused by `claim-sources`.

## v1.1 — experts that learn (on main, unreleased: light/full training with provenance, computed levels; star chart reads real evidence)

- `expert train --mode light|full` (targeted reverse-engineering; mining past runs), evidence
  written with provenance, competency levels recomputed from evidence (formula in spec §2.6).
- Star chart from real evidence in the dashboard; "train me on X" prompts wired to it.
- Stack expertise shared by every expert by default.
- **Role experts** (on main, unreleased): `init` seeds `product`, `architect`, `delivery`,
  `developer`, `operations` — the names the shipped stage files name — with `kind: role` and
  an editable body at `templates/experts/<role>.md`. Their domain is the workflow, so they
  train with `--mode full` (past runs) and light mode is refused. The old `domain`/`stack`
  placeholders are retired from stage `experts:` lists.

## v1.2 — one door in (on main, unreleased)

- **`tldrx status`**: everything pending in the workspace as one ordered list — init
  questions, proposed splits (with their unanswered questions and the seed documents still
  marked `proposed`), open runs with the command each needs and their `depends_on` order, and
  experts a stage will load that have no evidence. A report: exit 0 whatever it finds.
- **The `/tldrx` skill runs it first** and walks the items one at a time, asking the human
  every decision that is theirs. The SessionStart hook shows the top of the same list, so a
  session that opens on work which is not a run is no longer greeted with silence.
- **`tldrx seed answer`**: a split's questions get somewhere to record the reply, and
  `seed apply` warns about the ones still open.

## v1.3 — the driving discipline, packaged (on main, unreleased)

- **`tldrx drive --attended|--unattended`** (#63): the host/driver mandate as a versioned
  artifact instead of a chat paste — the three-role protocol, evidence discipline, parking,
  review calibration by stakes and budget honesty. Two modes over one spine, differing only in
  who may close a gate and who spawns. Needs no workspace and writes nothing.
- **`tldrx retro --all`** (#64): what keeps catching you, across every run in the workspace —
  finding class × count × runs × one cited example, mined from the review logs, the fix lists,
  `retro.md` and the `story.reopened` reasons. Deterministic keyword rules, zero new state.
  Feeding these classes back into the stage prompts and expert training is the half that is
  NOT written: the reader exists, nothing consumes it yet.

## Adapters (opt-in, files stay the source of truth) — ticket mirror on main, unreleased; chat channel not started

- Ticket mirror: Jira and GitHub are implemented; `linear` is in `process.yml`'s enum with no
  adapter behind it (`src/core/adapters/types.ts:17`). Epics and stories out, `external_status`
  in; never advances `run.yml`, never marks a story done. `tickets sync` previews by default.
- Chat channel (Slack / Pumble): NOT STARTED. The questions file is the contract; the channel
  would only deliver.

## Next — open, nothing written yet

- **Seam analysis** for the `migration` / `refactor` scopes. `workflows/migration.yml` says What
  is "an inventory plus a compatibility matrix, both derived from the code map"; nothing walks
  the map to produce one. The k-hop walk is the missing half.
- **Discovery by sampling** — pick reads by centrality + churn (both already computed by the
  map) instead of reading whole repos.
- **Parallel stories in Build.** Sequential on purpose today
  (`src/core/facilitator/executors/build.ts:17-19`): `waves.yml` already guarantees a dependency
  sits in an earlier wave, so the inner loop can become a fan-out without changing anything else.
- **Multi-model.** `spawnAgent.ts:32` is `const CLAUDE_BIN = "claude"` with no provider seam, so
  "which model" means "which Claude". A provider adapter behind that constant is the whole change.
- **Outcome evals.** `test/evals/` (v1, #26) now proves each STAGE's output contract — the
  artifacts, the checks, the parsers, the side effects — against a scripted stand-in. What it
  still does not measure is whether a run produces better software than a bare `claude -p`:
  that needs a real model and a judge, and until it exists "it has gates" is the only claim on
  offer.

## Not planned

Anything that makes the model the source of truth, installs tools for the user, or launches
work from the dashboard.
