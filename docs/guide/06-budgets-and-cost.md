# 6 — Budgets and cost

## What the numbers mean

Ceilings live in `budget.yml` (per run and per phase) and `stage.yml` (per stage). They gate
a stage *before* it starts and are reconciled *after* from real costs.

A single sub-agent call is passed `--max-budget-usd`, which the Claude CLI applies as a
**stop after the current turn, not a hard cap**. Measured 2026-08-29: a `--max-usd 1.5`
training call was killed with `error_max_budget_usd` **after** `total_cost_usd: 5.15325`, on
a single 597-second turn of a 1M-context model. The flag ends a run once a turn's cost is
known; it cannot end a turn already in flight.

**Size the prompt for the money you are willing to lose, not the ceiling you passed.**

Measured costs so far (Sonnet, Aug 2026): a What stage ≈ $1.2–1.4; a light expert training
over ~20 files ≈ $5; a cold `claude -p` call floors at ≈ $0.25 (10–26k cache-creation tokens
before the first reply), which is why every spawn has a $0.25 floor and refuses below it
rather than paying for a failure.

## Four things bound what a stage costs

They act at different moments, and only two of them act before the money.

### Before the prompt is built

`stage.yml` says how many bytes each part may have. The declared inputs are filled first out
of `inputs_max_bytes` (96 KB); the loaded experts then share `knowledge_max_bytes` (48 KB)
between them, split by relevance rank, never one budget each. Over `prompt_max_bytes`
(160 KB) the stage is **refused** — exit `2`, before anything is spawned — naming the biggest
sections and the key or command that shrinks each. `--prompt-max-bytes <n>` overrides it for
one run.

### While the prompt is built

`tldrx next --prepare` and `--dry-run` print the **context ledger**, so what you are about to
pay for is visible before you pay for it:

```
context 83.7 KB of 160.0 KB (~23.8k tok, 12% of sonnet's ~200.0k window)
  stage 3.7 KB · inputs 77.3 KB · experts 2.7 KB (bodies 2.5 KB, knowledge 250 B)
  input docs/domain-design/DECISIONS-NEEDED.md 15.1 KB
  input docs/domain-design/SEED-README.md 7.6 KB
  input docs/domain-design/docs/adr/ADR-D013-DELIVERY-ZONE-GEOMETRY.md 5.7 KB
```

That is a real run. The same prompt was **159,575 bytes** before the budget was made one
shared total — 52% of it expert knowledge nobody had asked for, with one of the six ADRs the
run existed to settle dropped whole to make room. It is **85,676 bytes** now, loads two
experts, and contains that ADR in full.

`pending.json` carries the same numbers under `context:`. The model's context window is only
ever a stderr warning at 80%: both it and the bytes-per-token ratio are `[assumption]`, and
refusing on two stacked assumptions would block work the framework could have done.

### While the agent runs

`max_reads` counts **completed** `Read`/`Glob`/`Grep` calls off the stream that is already
arriving — no second model call, no extra tokens — and kills the process tree at the ceiling:
**120** for what/how/plan, **200** build, **60** watch; `--max-reads <n>` to override.
Counting completions is what makes the stop land after the current tool rather than inside
one.

This is the real brake. `--max-budget-usd` only stops a turn already in flight, and
`--effort` changes what a turn costs, not how many there are. The attempt records
`stopped_by: max_reads`, `agent.result` carries `reads` / `max_reads` / `stopped_by`, and the
live view shows `reads 37/120`.

### Before the turn — `--effort`

`--effort <low|medium|high|xhigh|max>` is the lever `--max-budget-usd` is not: it changes
what the turn costs in the first place. Set per stage in `stage.yml` as `effort:`, overridable
with `tldrx next --effort` and `tldrx expert train --effort`. Shipped stage defaults, all
`[assumption]`: what `medium`, how `high`, plan `medium`, build `high`, watch `low` — cheap
stages run cheap and only the stages that actually reason pay for `high`. The level is
recorded on `agent.spawned` / `agent.result` and on every `training.jsonl` line beside the
cost, so cost-per-effort is measurable rather than arguable.

## After it runs — what was actually spent

```bash
tldrx cost                    # this run: per attempt, per stage, per run
tldrx cost --all              # every run in the workspace, with the workspace total
tldrx cost --json
```

Read off `agent.result` events and nothing else — **no token count is ever multiplied by a
price here**. All four token counters, including both prompt-cache halves.

Two rules it will not bend:

- **Attempts are never merged.** A stage that failed twice cost three turns, and that retry
  is usually exactly the money you are looking for.
- **Unmetered is not zero.** Work whose cost this process never saw is reported as
  **UNMETERED**, never summed as $0.00. An in-session `--commit` sub-agent was billed to the
  host session and has no meter of its own, so with nothing declared the task is recorded
  `cost_usd: null, metered: false` and `budget show` / `run status` call `spent` a **lower
  bound**. Declare it with `tldrx next --commit --cost-usd <n> [--tokens <n>]` when you know
  it; never guess one.

## The one command that guesses

```bash
tldrx run estimate [<run>] [--json]
```

It says so in its own output. The next stage's prompt is assembled by the same code `next`
uses and weighed by the same context ledger — that half is **measured** bytes. The output
half is the **median** output tokens of past attempts at that stage id in this workspace; with
no history it prints no estimate rather than inventing one. Prices and context windows are a
dated `[assumption]` in `src/core/budget/modelPrices.ts`.

## Moving a ceiling

```bash
tldrx budget show [<run>] [--json]
tldrx budget raise 04-build 25 --take-from 02-how --note "the plan grew two waves"
```

`show` is the money in one screen: run ceiling / spent / left, then a row per phase with its
ceiling, spent, remaining, the next stage it would run, that stage's own estimate, and
whether `tldrx next` would be blocked there. When it would be, it prints the exact command
that unblocks it with the shortfall already computed and rounded **up** to the cent.

`raise` is the one sanctioned edit to `budget.yml`, and it leaves a `budget.raised` event
with before/after, actor and note. It is validated before it writes:
`Σ phase ceilings ≤ ceiling_usd` holds on the way out, and `--take-from <phase>` moves the
money instead of adding it — refusing to cut a donor below what it has already spent. The
output says which happened: the money moved, or the **run** ceiling grew.

Ceilings are re-read from disk before every write, so a `budget raise` that lands while a
stage is in flight is no longer silently reverted when that stage saves.

## Running stories in parallel does not change the bill

`--parallel N` (guide 3) changes when the money is spent, not how much. A Build
stage divides its ceiling by `stories x 2 attempts x (developer + a quarter for the
reviewer)` up front, so the sum of every sub-agent ceiling it can hand out is inside
the stage ceiling however the attempts fall — and however many are in flight at once.
Three developers running together each get the same share they would have got one at
a time.

## The budget gate

`budget-gate` is a PreToolUse hook on **every command that spends**: `claude -p …`,
`tldrx next`, `tldrx run auto`, `tldrx expert train`, `tldrx seed triage`. It denies when the
cursor phase cannot afford the estimate and appends `budget.blocked`. The denial names the
exact `tldrx budget raise` command, shortfall included.

It **fails CLOSED**: once the command is known to be a spender inside a tldrx workspace, an
unreadable `run.yml` or `budget.yml` denies and says which one. "Cannot read the budget" is
not "the budget is fine". Outside a workspace, or for a command that spends nothing, it
allows silently.

## Where the money is written down

- `tldrx-work/<run>/events.jsonl` — `agent.spawned`, `agent.result`, `cost`, `budget.warned`,
  `budget.blocked`, `budget.raised`
- `.tldrx/experts/<name>/training.jsonl` — one line per training run, with its cost and effort
- `run.yml` + `budget.yml` — the rolled-up actuals, rewritten through `RunStore` on every save

`tldrx replay <run>` narrates all of it in event order.
