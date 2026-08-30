# Roadmap

Source of truth for *what is next*. Facts about *what shipped* live in `CHANGELOG.md`;
design rationale lives in `docs/concept.md`; open design questions in `docs/spec.md` §7.

## v0 — the loop (shipped: 0.0.1 → 0.0.2, 2026-08-29; install name `tldr-experts`, commands `tldrx` / `tldr-experts`)

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

## v1.1 — experts that learn (shipped in 0.3.0: light/full training with provenance, computed levels; star chart reads real evidence)

- `expert train --mode light|full` (targeted reverse-engineering; mining past runs), evidence
  written with provenance, competency levels recomputed from evidence (formula in spec §2.6).
- Star chart from real evidence in the dashboard; "train me on X" prompts wired to it.
- Stack expertise shared by every expert by default.
- **Role experts** (shipped in 0.3.0): `init` seeds `product`, `architect`, `delivery`,
  `developer`, `operations` — the names the shipped stage files name — with `kind: role` and
  an editable body at `templates/experts/<role>.md`. Their domain is the workflow, so they
  train with `--mode full` (past runs) and light mode is refused. The old `domain`/`stack`
  placeholders are retired from stage `experts:` lists.

## v1.2 — one door in (shipped in 0.3.0)

- **`tldrx status`**: everything pending in the workspace as one ordered list — init
  questions, proposed splits (with their unanswered questions and the seed documents still
  marked `proposed`), open runs with the command each needs and their `depends_on` order, and
  experts a stage will load that have no evidence. A report: exit 0 whatever it finds.
- **The `/tldrx` skill runs it first** and walks the items one at a time, asking the human
  every decision that is theirs. The SessionStart hook shows the top of the same list, so a
  session that opens on work which is not a run is no longer greeted with silence.
- **`tldrx seed answer`**: a split's questions get somewhere to record the reply, and
  `seed apply` warns about the ones still open.

## Adapters (opt-in, files stay the source of truth) — ticket mirror shipped in 0.3.0; chat channel not started

- Ticket mirror (Jira / GitHub / Linear): epics and stories out, `external_status` in; never
  advances `run.yml`, never marks a story done.
- Chat channel (Slack / Pumble): the questions file is the contract; the channel only delivers.

## Not planned

Anything that makes the model the source of truth, installs tools for the user, or launches
work from the dashboard.
