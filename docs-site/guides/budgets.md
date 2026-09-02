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
context 83.7 KB of 160.0 KB (~23.8k tok, 12% of sonnet's ~200.0k window)
  stage 3.7 KB · inputs 77.3 KB · experts 2.7 KB (bodies 2.5 KB, knowledge 250 B)
  input docs/domain-design/DECISIONS-NEEDED.md 15.1 KB
  input docs/domain-design/SEED-README.md 7.6 KB
```

Over the stage's `prompt_max_bytes` (160 KB by default) the stage is **refused** — exit
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

## Afterwards

```bash
tldrx cost                # per attempt, per stage, per run
tldrx cost --all          # every run in the workspace
tldrx run estimate        # the one command that guesses
```

`cost` reads what was actually charged, per attempt — retries are never folded into the
stage total, since the retry is usually the money you were looking for. Two economies are
reported separately and never summed; see [Budgets](/concepts/budgets).

`run estimate` prints `ESTIMATE` in words. Its input half is measured (the real prompt);
its output half is the median of past attempts at that stage, and with no history it prints
nothing rather than inventing a number.

## Rough numbers

Measured on Sonnet, August 2026, on one real workspace — indicative, not a price list.

- a What stage: **$1.20–1.40**
- a light expert training over ~20 files: **≈ $5**
- the floor for any cold `claude -p` call: **≈ $0.25**, because 10–26k cache-creation
  tokens are paid before the first reply. Stages refuse a ceiling below that rather than
  paying for a guaranteed failure.

Full detail: [6 — Budgets and cost](https://github.com/ederwii/tldr-experts/blob/main/docs/guide/06-budgets-and-cost.md).
