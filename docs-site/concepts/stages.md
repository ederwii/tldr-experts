---
title: The five stages
---

# The five stages

A piece of work goes through five stages, in order: **What → How → Plan → Build → Watch**.
Each is one turn of the same loop — Investigate, Handoff, Interview, Gate.

> **Investigate** — read code, docs and memory; every finding carries a source.
> **Handoff** — write one markdown file: what was found, what was decided, what is still unknown.
> **Interview** — turn only the genuine unknowns into questions for you.
> **Gate** — stop. Nothing after this runs until the gate is signed.

You advance one stage at a time with `tldrx next`. Nothing is implicit: each stage's
outputs are files on disk, and the next stage reads them.

## What each stage does

| Stage | It answers | It writes |
|---|---|---|
| **What** | What are we doing, and what are we deliberately not doing? | `intent.md`, `scope.md`, `success-metrics.md`, `open-questions.md`, `handoff.md`, `questions.md` |
| **How** | How does it fit this codebase — components, contracts, risks, tests? | `design.md`, `contracts.md`, `risks.md`, `test-strategy.md`, `handoff.md`, `questions.md` |
| **Plan** | What are the pieces, in what order? | `epics/`, `stories/`, `waves.yml`, `budget.yml`, `handoff.md`, `questions.md` |
| **Build** | The code. | a branch and a commit per story, plus `04-build/handoff.md` |
| **Watch** | What could go wrong in production, and how would we know? | one watcher card per shipped thing |

**How** is the stage that thinks hardest — it runs on a bigger model at higher effort,
because every component it names has to land on a real path in your repo. **What** and
**Plan** are cheaper on purpose.

**Build** is the one that is not like the others. It cuts an epic branch, then for each
story: a worktree and a branch of its own, a sub-agent to write the code, a re-run of that
story's own definition of done, a commit, a merge into the epic — and then a separate,
read-only reviewer whose job is to disagree. The epic branch waits for you; the framework
never pushes.

One branch per epic assumes the epics are independent. When a story `depends_on` a story in
**another** epic, the epics form a chain and the run cuts a single **integration branch**,
`epic/<run-id>`, with the epics staying in the plan as labels. That is decided at Plan time
from what the plan already says — the `plan` check prints which model it read, `epics form a
chain (E3→E2, E4→E2) → single integration branch` or `independent epics → one branch each`
— so you never discover it mid-Build.

## Scope decides which stages run

`tldrx run new <slug> --scope <scope>` picks a preset. There are 13 on disk, and the
preset says which stages run, at what depth, on what default budget, and who signs each
gate.

```bash
tldrx run new bulk-pricing --scope feature   # what, how, plan, build, watch — $25 default
tldrx run new is-redis-enough --scope spike  # what, how only — $6 default, decision memo
```

A stage a scope skips is recorded as skipped, not silently dropped — `skips: [plan, build,
watch]` sits in the preset file, so the omission is a decision you can read. The full list:
`bugfix` `docs` `feature` `hotfix` `integration` `migration` `performance` `prototype`
`refactor` `retro` `security-patch` `spike` `upgrade`.

Some scopes reach Build without a Plan phase — `docs`, `hotfix`, `performance`,
`prototype`, `security-patch`. Build then writes the single story that decision implies,
from your What handoff and your answers, and `tldrx run status` says `plan: implicit
(scope skips Plan)` so you can always tell it from a plan you read and approved.

## Where the definitions live

Stages are files, not code. `stages/<name>/stage.yml` is the contract — which model, what
it may spend, what it may read, what it must write, what checks run at the end.
`stages/<name>/stage.md` is the handoff template the sub-agent is handed.
`workflows/<scope>.yml` declares the order. A `.tldrx/stages/` or `.tldrx/workflows/` in
your own project overrides the shipped ones.

Full detail: [the loop](https://github.com/ederwii/tldr-experts/blob/main/docs/guide/02-the-loop.md)
in the repo.
