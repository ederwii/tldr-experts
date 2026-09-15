---
title: Budgets and estimates
---

# Budgets and estimates

How to keep a run from costing more than you meant, in the order the four brakes actually
act. Only the first two act *before* the money.

## 1. See the bill before you pay it

```bash
tldrx next --prepare        # or --dry-run: both spawn nothing and cost nothing
```

Both print the **context ledger** — the assembled prompt, broken down by where the bytes
came from:

```
context 83.7 KB of 400.0 KB (~23.8k tok, 12% of sonnet's ~200.0k window)
  stage 3.7 KB · inputs 77.3 KB · experts 2.7 KB (bodies 2.5 KB, knowledge 250 B)
  input docs/domain-design/DECISIONS-NEEDED.md 15.1 KB
  input docs/domain-design/SEED-README.md 7.6 KB
```

Over the stage's `prompt_max_bytes` (400 KB by default) the stage is **refused** — exit
`2`, before anything is spawned — naming the biggest sections and the setting that shrinks
each. `--prompt-max-bytes <n>` overrides it for one run.

That ledger is why the ceiling exists. On a real run the same prompt was 159,575 bytes
before the byte budget was made one shared total: 52% of it was expert knowledge nobody had
asked for, and one of the six documents the run existed to settle had been dropped whole to
make room. It is 85,676 bytes now, and contains that document in full.

## 2. Buy less thinking

```bash
tldrx next --effort low        # low | medium | high | xhigh | max
```

`--effort` is the lever that changes what a turn *costs*, rather than stopping one that is
already expensive. Stage defaults are set for this: What `medium`, How `high`, Plan
`medium`, Build `high`, Watch `low` — the cheap stages run cheap, and only the stages that
genuinely reason pay for `high`.

## 3. Stop the agent reading forever

```bash
tldrx next --max-reads 60
```

This is the real brake. It counts completed `Read` / `Glob` / `Grep` calls off the stream
the model is already sending — no extra call, no extra tokens — and stops the run at the
ceiling. Defaults: **120** for What/How/Plan, **200** for Build, **60** for Watch. The
attempt records `stopped_by: max_reads`, and the live view shows `reads 37/120`.

## 4. `--max-usd` is the weakest one

```bash
tldrx next --max-usd 3
```

It ends a run **after** the turn it is already in. It cannot stop a turn in flight, because
the cost is only known when the turn reports it. Measured: a call passed a $1.50 ceiling was
killed with `error_max_budget_usd` after `total_cost_usd: 5.15`, on one 597-second turn.

**Size the prompt for the money you are willing to lose, not the ceiling you passed.**

## Moving a ceiling

```bash
tldrx budget show
tldrx budget raise 04-build 25 --take-from 02-how --note "the plan grew to nine stories"
```

A phase priced in host tokens has its own ceiling — `ceiling_host_tokens` in `budget.yml`,
never mixed into `ceiling_usd`; see [Budgets](/concepts/budgets).

`raise` takes a **delta**, not a new ceiling — `raise 04-build 5` turns $20 into $25.
`--take-from` moves it out of another phase instead of raising the run's total. The event
log keeps who raised it, by how much, and why. Raising a ceiling mid-stage is also one of
the things that stops an [agent gate](/concepts/gates) from signing itself.

### Money a finished phase can no longer spend

A phase that has finished under its ceiling keeps the difference, and no stage will ever spend
it. When a later phase is refused on money, the refusal now says so and names the move:

```
budget: finished phase(s) hold $16.25 unspent (01-what $16.25), which covers the $11.07 shortfall:
`tldrx budget raise 04-build 11.07 --run <id> --take-from 01-what`, or launch
`tldrx run auto --rebalance-finished` to make that move on the record automatically.
```

`tldrx run auto` makes exactly that move before refusing, and carries on. It is **on by
default** (gh #330): `--no-rebalance-finished` turns it off for a launch whose phase ceilings must
mean exactly what they were set to, and `--rebalance-finished` is still accepted. It shipped
off, because a phase ceiling is a person's decision about money; it was turned on after an audit
of unattended runs found 22 human interventions on phase sizing whose raise notes, by the
audit's reading, never changed the work. `tldrx next` on its own never makes the move, and when
a launch would be funded by it, the `budget-gate` hook lets `run auto` start instead of refusing
it first (gh #321). "Finished" is strict — every stage of the phase `done` or `skipped`,
none stale, priced in `metered-usd`, and no unmetered turn (whose spend would only be a lower
bound). A phase with a stage still to run, such as `05-watch` while Build is blocked, never gives.
It moves only the shortfall, never grows the run ceiling, never passes a recorded grant, and
records one `budget.raised` per donor with `source: run auto --rebalance-finished` and your name.
If every finished phase together cannot cover the shortfall, nothing moves and the refusal says
how short it still is.

### A phase that cannot afford its own retry

A phase whose ceiling equals **one** attempt of its stage refuses every retry after the first
cent of spend — by arithmetic, not by policy. `tldrx run new` has sized every phase at
`attempts ×` its stage since gh #170, so it cannot create one; a run created before that keeps
it for life, and the money in a phase sized that way is spent before anyone finds out. The
`next` column now says so first (gh #232):

```
  phase       ceiling      spent       left  next stage       est.  next
> 04-build    $787.87      $1.43    $786.44  build          $71.00  NO-RETRY
  05-watch    $175.08      $0.00    $175.08  watch         $175.08  NO-RETRY

NO-RETRY: phase 05-watch holds one attempt of `watch` ($175.08) and that stage declares
attempts: 2, so it must hold $350.16. The first failed attempt spends money the retry cannot
then find, and a run that cannot retry stops where nothing unattended can restart it. Size it
now:
  tldrx budget raise 05-watch 175.08 --run <id>
```

The verdict is measured against the stage's **declared** `budget_usd` and its own `attempts:`,
never against the `est.` column beside it. On a run whose turns are partly unmetered the
estimate is too small, so `ceiling / est.` reports headroom that is not there — the less a run
is metered, the safer that ratio claims it is. A declaration does not move with metering.
`attempts: 1` is a decision that the stage gets no retry, so a ceiling holding exactly one is
the right size for it and reads `ok`. A phase with no stage left to run reads `n/e`: there is
nothing to size, and saying nothing is not the same as saying it is fine.

It is a warning, never a refusal — `tldrx next` still runs, and the all-clear line says how
many phases are carrying it.

## The three knobs, and which one caps a sub-agent

A raise like the one above moves the **phase ceiling**, and a phase ceiling decides one thing:
whether the next stage may start at all. It caps no sub-agent. The ceiling a developer or a
reviewer is actually dispatched under comes from the **stage's own `budget_usd`** in `run.yml`,
and `per_agent_max_usd` only trims that from above. Measured on two live unattended runs:
raising the stage figure alone, 16.20 → 60, moved a developer ceiling 5.97 → 22.11 on the next
spawn, while raising the other two without it moved nothing.

```bash
tldrx budget raise 04-build 25 --stage build
```

`--stage` adds the same amount to that stage's `budget_usd` as well, and it is what to reach
for when a sub-agent died on its cap rather than the run running out of money. A raise that
names no stage says, in its own output, that no spawn ceiling moved.

The stage's `budget_usd` is also what the plan's prices are **scaled** to. A story's cap is
`max(price × scale × 3, $4.00)`, and `scale` is 1 only while `03-plan/budget.yml`'s prices sum
inside the stage: a $16.20 stage over a $114.00 plan is a scale of 0.1421, so a story priced
$14.00 is capped at $5.97, not $42 — and raising every price moves nothing, because a uniform
raise keeps the ratio and the sum. The `plan` gate's detail and the Build's stderr at entry say
so, with the factor and the `--stage` command that lifts the scale to 1; a developer that dies
on its cap gets the formula with its inputs and the same lever named.

A reviewer is the one turn the framework will not under-fund: when what the stage has left is
below what a review costs, no reviewer is spawned at all. The story parks with its diff merged
and its review still owed, nothing is spent on a turn that could not read the diff, and the
record says *no reviewer ran* — never that one asked for changes or failed. The line it prints
carries the `--stage` command sized to the shortfall.

## Writing down what was authorized

```bash
tldrx budget grant 20 --fact F031
tldrx budget grant 5 --fact F031 --phase 04-build --on-exceed block
```

`grant` records what the owner authorized, so the ceiling has something to answer to. It
spends nothing and moves no ceiling — `<usd>` is a **total**, the opposite of `raise`'s delta.
`--fact` is required and must name a live fact: an authorization that cannot cite a decision is
a number nobody said. `budget show` reads it back on one line — the fact, each scope and the
policy — and says nothing when there is no grant, because printing `$0.00 authorized` would
invent the one figure the key refuses to guess.

`raise` then checks the ceiling it is about to write against it, before anything lands. Under
the default it writes and warns; under `--on-exceed block` it refuses and leaves `budget.yml`
byte-identical. That policy is `on_grant_exceed`, and it is **not** `on_exceed`: one governs
spending past a ceiling, the other governs writing one above what was authorized. See
[Budgets](/concepts/budgets).

## Afterwards

```bash
tldrx cost                # per attempt, per stage, per run
tldrx cost --all          # every run in the workspace
tldrx run estimate        # the one command that guesses
```

`cost` reads what was actually charged, per attempt — retries are never folded into the
stage total, since the retry is usually the money you were looking for. Two economies are
reported separately and never summed; see [Budgets](/concepts/budgets).

```bash
tldrx cost --stories      # per story, against the spawn ceiling its spawns were given
```

`--stories` is the calibration report: one row per build story, with what it measurably cost,
the spawn ceiling the executor handed it, and the ratio. It changes no ceiling and spends
nothing. Use it before arguing that a stage default is wrong — the shipped numbers say in their
own comments that they are guesses, and this is the command that produces the evidence to
replace them with.

`run estimate` prints `ESTIMATE` in words. Its input half is measured (the real prompt);
its output half is the median of past attempts at that stage, and with no history it prints
nothing rather than inventing a number.

## Rough numbers

Measured on Sonnet, August 2026, on one real workspace — indicative, not a price list.

The shipped ceilings are the same kind of claim, and they say so: every `budget_usd` in a stage
file and every `default_budget_usd` in a workflow file carries an `[assumption]` comment on the
money itself, naming what it is (a scoped guess), what evidence exists (one story that cost
5.8x the ceiling its spawn was given), and what would replace it (`tldrx cost --stories`). A
run created by `tldrx seed apply` records the same thing in its own `run.yml`, as
`triage.budget_basis: model-guess`.

- a What stage: **$1.20–1.40**
- a light expert training over ~20 files: **≈ $5**
- the floor for any cold `claude -p` call: **≈ $0.25**, because 10–26k cache-creation
  tokens are paid before the first reply. Stages refuse a ceiling below that rather than
  paying for a guaranteed failure.

Full detail: [6 — Budgets and cost](https://github.com/ederwii/tldr-experts/blob/main/docs/guide/06-budgets-and-cost.md).
