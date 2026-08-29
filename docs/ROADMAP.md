# Roadmap

Source of truth for *what is next*. Facts about *what shipped* live in `CHANGELOG.md`;
design rationale lives in `docs/concept.md`; open design questions in `docs/spec.md` §7.

## v0 — the loop (shipped: 0.0.1 → 0.0.2, 2026-08-29; install name `@ederwii/tldrx`)

`init` (detect → code map → handoff → interview → experts → conventions → process), `run new`
(+ `--from` AI-DLC distill), `next` (headless `claude -p` and in-session `--prepare/--commit`),
`answer / approve / reject / status`, six live hooks (claim-sources, no-re-ask, answer-capture,
dod-gate, budget-gate, session-start), `expert list/create/train --print-prompt`, `replay`,
`retro`, `dashboard --static`, statusline. Runs on Node ≥ 20 or Bun. Released by tag through
npm trusted publishing.

Validated on one real workspace (5 sibling repos): the What phase of a feature run passed the
citation gate on the second attempt; both failures were framework bugs and are fixed.

## v1 — execute and observe

- **Build phase for real**: waves from `waves.yml`, one worktree + branch per story, epic
  branches, DoD gate re-running the workspace's own test/lint/typecheck commands, reviewer pass.
- **Watch phase**: `watchers/<feature>.md` generated from what Build actually instrumented.
- **Story / epic / waves schemas** (spec §7).
- **Live dashboard** (`tldrx dashboard`): same renderer, file watcher + SSE, still read-only.
- **Budget UX**: estimate vs. ceiling reconciliation so a retry is not blocked by its own first
  attempt; per-attempt accounting in `run status`.
- **Prose sections are not checked**: an Unknowns section written as a paragraph has no list
  items to validate — require items or check sentences.

## v1.1 — experts that learn

- `expert train --mode light|full` (targeted reverse-engineering; mining past runs), evidence
  written with provenance, competency levels recomputed from evidence (formula in spec §2.6).
- Star chart from real evidence in the dashboard; "train me on X" prompts wired to it.
- Stack expertise shared by every expert by default.

## Adapters (opt-in, files stay the source of truth)

- Ticket mirror (Jira / GitHub / Linear): epics and stories out, `external_status` in; never
  advances `run.yml`, never marks a story done.
- Chat channel (Slack / Pumble): the questions file is the contract; the channel only delivers.

## Not planned

Anything that makes the model the source of truth, installs tools for the user, or launches
work from the dashboard.
