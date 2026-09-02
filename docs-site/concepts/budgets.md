---
title: Budgets
---

# Budgets

Two ideas here, and the second one surprises people.

## 1. Ceilings are per run, per phase, and per stage

`tldrx run new pay --budget 25` sets the run's ceiling. That is divided across the phases
in proportion to each stage's own declared cost, and written to `budget.yml`. A stage the
phase cannot afford is **refused before it starts**, not stopped halfway.

```
budget  $0.00 spent of $5.00 ceiling ($5.00 left)
> 01-what   [░░░░░] 0/1 stages   $0.00 / $0.80
  02-how    [░░░░░] 0/1 stages   $0.00 / $1.20
```

Four things bound what a single stage costs, and only two of them act *before* the money
is spent. The practical guide is [Budgets and estimates](/guides/budgets); the short
version is that `--max-usd` is the weakest of the four, because it ends a run only
once a turn's cost is known and cannot stop a turn already in flight. Measured: a call
with a $1.50 ceiling was killed after it had spent **$5.15**.

## 2. There are two economies, and they do not add up

A turn can be paid for in two different ways, and tldrx refuses to pretend otherwise.

| | who runs the turn | who pays | what is recorded |
|---|---|---|---|
| **metered** | the framework spawns `claude -p` | your API account, per turn | the exact dollar figure the CLI reported |
| **host** | the Claude Code session you are already in, using its own sub-agents | your session's plan | `cost_usd: null, metered: false` |

A host turn has **no meter of its own**. The framework did not spawn it and was never told
what it cost, so recording `$0.00` would be a measurement, and a false one. It records
nothing instead, and says so:

```
  STAGE           ECONOMY       MEASURED     DECLARED
  01-what/what    metered-usd   $1.70        —
  03-plan/plan    host-tokens   —            ~342.5k tokens (host session)

  metered      $1.70 over 1 attempt
```

If you know what a host turn cost, you can declare it: `tldrx next --commit --cost-usd
0.42`. Declared is kept separate from measured, because they are different claims.

A host phase is not therefore unbounded. `budget.yml` takes an optional
`ceiling_host_tokens`, at the run level and per phase, and the declared `tokens:` are summed
against **that** — never against `ceiling_usd`. The two are never added and never converted:
there is no exchange rate between a metered dollar and a host token, and inventing one
would be a guess about a price. Crossing the ceiling warns; `on_host_tokens_exceed: block`
is the explicit opt-in that makes it deny instead. Declare no token ceiling and there is
nothing to compare against, so nothing is checked.

## Reading the ledger

```bash
tldrx cost                # this run: per attempt, per stage, per run
tldrx cost --all          # every run in the workspace, totalled per economy
tldrx run estimate        # the one command that guesses — it says so in words
```

`tldrx cost` reads dollar figures off the run's event log and nothing else. **No token
count is ever multiplied by a price.** Retries are never merged into the stage total — a
stage that failed twice cost three turns, and that retry is usually the money you were
looking for. Anything the process never saw a cost for prints as `UNMETERED`.

`tldrx run estimate` is allowed to guess and labels itself `ESTIMATE`. Half of it is
measured — the next stage's prompt, assembled by the same code that would run it. The
other half is the median output of past attempts at that stage, and with no history it
prints no estimate rather than inventing one.
