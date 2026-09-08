---
title: Budgets
---

# Budgets

Three ideas here, and the second one surprises people.

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
| **metered** | the framework spawns Claude Code | your API account, per turn | the exact dollar figure the CLI reported — and when a turn comes back without one (a process that died before writing its result document, say), `cost_usd: null, metered: false` like any other unmetered turn, never a `$0.00` nobody measured |
| **Codex** | the framework spawns `codex exec` | your Codex account | measured tokens; `cost_usd: null, metered: false` because the CLI reports no USD |
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

## 3. A ceiling is not what somebody authorized

`ceiling_usd` says what the run will spend. It has never said what anyone agreed to pay. That
lived in prose — a fact, a message, a thread — and nothing read it back, so three different
places could write a dollar ceiling and none of them answered to the decision behind it.

`tldrx budget grant` writes the decision down as a number:

```bash
tldrx budget grant 20 --fact F031
tldrx budget grant 5 --fact F031 --phase 04-build --on-exceed block
```

It **records**; it spends nothing and moves no ceiling. `--fact` is required and must name a
live fact: a grant that cannot cite a decision is a number nobody said. `<usd>` is a total, not
a delta.

`tldrx budget raise` then measures the ceiling it is about to write against the grant, before
anything lands — a phase grant against the phase ceiling, the run grant against the run
ceiling. Under the default `on_grant_exceed: warn` the ceiling is written and one sentence
names the grant, the fact and the figure; under `block` the raise is refused and `budget.yml`
is left byte-identical.

**Two different questions, two different keys.** `on_exceed` governs *spending* past a ceiling.
`on_grant_exceed` governs *writing* one above what was authorized. A run that blocks on dollars
has said nothing about the second, so it is never inferred from it.

No grant recorded means nothing is reconciled and nothing is refused. Absence is never read as
`$0`: every `budget.yml` written before these keys exists, and treating their silence as an
authorization of nothing would refuse every raise on all of them. A second grant on the same
scope replaces the first — a later decision supersedes an earlier one — and says what it
replaced rather than changing the number quietly.

## Reading the ledger

```bash
tldrx cost                # this run: per attempt, per stage, per run
tldrx cost --all          # every run in the workspace, totalled per economy
tldrx run estimate        # the one command that guesses — it says so in words
```

`tldrx cost` reads the run's event log and nothing else. **No token count is ever multiplied
by a price.** Retries are never merged into the stage total — a stage that failed twice cost
three turns, and that retry is usually the money you were looking for. Anything the process
never saw a cost for prints as `UNMETERED`.

Beside the money there is now a **duration** per attempt, and it says which span it is.
`spawned` is the sub-agent's own process, start to exit. `prepare-to-commit` is the gap
between the `--prepare` that handed a host session its bundle and the `--commit` that
recorded the turn — which includes whatever the host did in between, so it is a ceiling on
the sub-agent's time and is never called the sub-agent's time. An attempt from before the
framework recorded either reads `not recorded`, never `0s`.

And wherever a spend figure appears — `run status`, `budget show`, the dashboard, a replay,
the Build handoff — a run with unmetered turns in it reads `≥ $12.40 (7 tasks unmetered)`,
or `not measured: 9 in-session tasks, 0 metered` when nothing at all was metered. A bare
`$0.00` over thirty stories somebody's session paid for is arithmetically true and
communicatively false. A run that really did meter everything keeps its plain figure.

`tldrx cost --stories` changes the axis, not the source: one row per build story, with what it
measurably cost beside the **spawn ceiling** the executor handed its spawns, and the ratio.
Those are two different kinds of number — a charge and a cap — so they sit in separate columns
and are never added. A story missing either side reads `not recorded` with the reason, and a
measurement with an unmetered turn in it is named a lower bound rather than given a verdict.

When the provider reports its own token split for a turn, both halves land on that turn's
row in `run.yml` — `input_tokens` and `output_tokens`, written together or not at all,
because a split with one side missing cannot be told apart from one nobody reported. They
are **provenance for the dollar figure beside them**, so a later reader can check it against
a price table instead of taking it on faith. They are not a second way to price the turn.

`tldrx run estimate` is allowed to guess and labels itself `ESTIMATE`. Half of it is
measured — the next stage's prompt, assembled by the same code that would run it. The
other half is the median output of past attempts at that stage, and with no history it
prints no estimate rather than inventing one.
