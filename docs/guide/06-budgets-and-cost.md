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
tldrx cost --all              # every run in the workspace, per economy
tldrx cost --json
```

Read off `agent.result` events and nothing else — **no token count is ever multiplied by a
price here**. All four token counters, including both prompt-cache halves, on **every attempt
line** as well as the stage and run totals — a stage that ran once still shows where its money
went.

`tldrx cost` is organised **by economy**, because two economies do not add up:

```
  STAGE           ECONOMY       MEASURED     DECLARED
  01-what/what    metered-usd   $1.70        —
  03-plan/plan    host-tokens   —            ~342.5k tokens (host session)
  04-build/build  host-tokens   —            ~1.2M tokens (host session)

  metered      $1.70 over 1 attempt
  host-billed  ~1.5M tokens declared over 2 attempts — no dollar figure; this process metered none of it
  (no total: two economies, no exchange rate — see spec §2.11)
```

No row spans both columns, and **there is no grand total**. A footer that printed `$1.70`
under a run which had also burned 1.5M host tokens is the sentence the label exists to stop.

Three rules it will not bend:

- **Attempts are never merged.** A stage that failed twice cost three turns, and that retry
  is usually exactly the money you are looking for.
- **Unmetered is not zero.** Work whose cost this process never saw is reported as
  **UNMETERED**, never summed as $0.00. An in-session `--commit` sub-agent was billed to the
  host session and has no meter of its own, so with nothing declared the task is recorded
  `cost_usd: null, metered: false` and `budget show` / `run status` call `spent` a **lower
  bound**. Declare it with `tldrx next --commit --cost-usd <n> [--tokens <n>]` when you know
  it; never guess one. A declared `--tokens` figure prints as
  `~342.5k declared (host session)` — its own notation, kept apart from the four measured
  counters, because the four zeroes it used to print said "this turn used no tokens" about a
  turn that used 342,527 of them.

## Two economies, and why a price needs a currency

A number in `budget.yml` used to have no unit on it. On 2026-08-30 that cost **$9.95**: a
Plan agent priced a run assuming HOST-billed sub-agents — turns the host session pays for,
which tldrx never meters and which are ~free to the run — and the executor then enforced
those figures as dollar ceilings on metered spawns. Six spawns of six died on
`Reached maximum budget`, each having spent real money to get there.

So a price gets a currency. `budget.yml` takes one optional key, at the run level and per
phase, and `03-plan/budget.yml` takes the same key at its root:

```yaml
ceiling_usd: 25.0
economy: metered-usd              # metered-usd (the default) | host-tokens
phases:
  - {id: 01-what,  ceiling_usd: 4.0, spent_usd: 1.14}
  - {id: 04-build, ceiling_usd: 8.0, spent_usd: 0.0, economy: host-tokens}
```

`metered-usd` means dollars a spawn may spend, which is what every file already meant.
`host-tokens` means a budget in units nobody in this process meters — a host-session token
allowance, not money.

**Leave it out and nothing changes.** Absence is `metered-usd`, and every path behaves
exactly as it did before the label existed.

**With `host-tokens` on a phase:**

- `tldrx next` **refuses a headless spawn on that phase, exit 2, before it spends a cent**.
  The message names the number, the unit and both ways out.
- `tldrx next --prepare` / `--commit` run normally — the in-session handshake is where a
  host-billed turn belongs, and the run says once, on stderr, that no dollar ceiling was
  enforced.
- The auto gate's money condition reads `n/a (host-tokens economy)` instead of comparing a
  spend in dollars to a ceiling in tokens.
- `tldrx run estimate` prices the stage in TOKENS and prints no dollar figure.
- A `03-plan/budget.yml` labelled `host-tokens` contributes **no** story caps: its numbers
  are not dollars, so the executor falls back to the uniform share and says so.

The two are **never converted**. There is no exchange rate here, and inventing one would be
a guess about a price — which is the whole reason the label exists. `tldrx budget raise`
rewrites `budget.yml` and the label survives the rewrite; a raise that erased it would turn
a token budget back into dollars silently.

## The one command that guesses

```bash
tldrx run estimate [<run>] [--json]
```

It says so in its own output. The next stage's prompt is assembled by the same code `next`
uses and weighed by the same context ledger — that half is **measured** bytes. The other three
terms — **cache write, cache read and output** — are the **median** of each counter over past
attempts at that stage id in this workspace, falling back to attempts at any stage and saying
which sample it used; with no history at all it prints no estimate rather than inventing one.
Prices, cache multipliers and context windows are a dated `[assumption]` in
`src/core/budget/modelPrices.ts`.

**Cache traffic is priced because that is where the money is.** Until 2026-08-30 the estimate
multiplied input and output only. Measured on a real What stage: it said **$0.33**, the
comparable real attempt cost **$1.70** — **5x** — and the attempt's ledger says why: 56 input
· 29.0k output · **166.3k cache write** · **3,747.1k cache read**. The two cache columns were
most of the bill and none of the formula, even though `agent.result` had recorded both since
wave N. Priced at write **1.25x** and read **0.1x** an input token, the same fixture now
estimates **$1.46**:

```
prompt 682 B ≈ 189 input tokens [measured bytes; ~3.6 B/token is an assumption]
cache and output: medians of 1 past attempt(s) at `alpha` here
input ~189 · cache write ~166k · cache read ~3,747k · output ~29k → ~$1.46
ESTIMATE: $1.46 ($0.00 in + $0.42 cache write + $0.75 cache read + $0.29 out).
```

The input term and the cache-write term **overlap on a cold first turn** — bytes sent cold
are billed as cache creation, not as fresh input — so a first attempt's total leans high by
roughly the prompt. That is the safe direction for a ceiling, and it is stated rather than
silently corrected: closing it needs a measurement of cache lifetime, which this repo does not
have.

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

## The Plan prices its own stories

`03-plan/budget.yml` is written by the Plan phase: a `per_phase_usd:` map from story id to
dollars, inside the Build stage's ceiling. The Build executor reads it. A story the plan
priced gets a developer ceiling of `price / (2 attempts x (developer + a quarter for the
reviewer))`, and its reviewer a quarter of that. A story the plan did not price falls back
to an equal share of the stage. If the prices add up to more than the stage was given they
are scaled down proportionally, so the ratio the plan decided survives and the total cannot
escape the ceiling. A `budget.yml` that will not parse or validate is an advisory on stderr
and an equal split — never a refused build. So is one labelled `economy: host-tokens`: those
numbers are not dollars, so they never become `--max-budget-usd` on a spawn.

Until 2026-08-30 nothing read that file, and a seven-story plan that priced one story at
$4.75 and another at $0.75 handed both the same $1.03.

**The reviewer has a floor of $1.00.** Whatever the arithmetic says, a reviewer is given at
least that (clamped by what the stage has left and by `per_agent_max_usd`). Measured the
same day: a $0.26 reviewer on a 39-file, +1879-line diff exited with
`Reached maximum budget ($0.26)` before finishing the read. A reviewer that cannot read the
diff approves nothing and blocks nothing — it converts the whole developer turn beside it
into a story stuck at `review`.

## Running stories in parallel does not change the bill

`--parallel N` (guide 3) changes when the money is spent, not how much. A Build
stage divides its ceiling by `stories x 2 attempts x (developer + a quarter for the
reviewer)` up front, so the sum of every sub-agent ceiling it can hand out is inside
the stage ceiling however the attempts fall — and however many are in flight at once.
Three developers running together each get the same share they would have got one at
a time. (The reviewer floor above is the one deliberate exception to that sum: it can
lift a small stage's worst case past its ceiling, and the budget gate is what stops a
stage that actually runs out.)

## The budget gate

`budget-gate` is a PreToolUse hook on **every command that spends**: `claude -p …`,
`tldrx next`, `tldrx run auto`, `tldrx expert train`, `tldrx seed triage`. It denies when the
cursor phase cannot afford the estimate and appends `budget.blocked`. The denial names the
exact `tldrx budget raise` command, shortfall included.

On a phase priced in `host-tokens` it never denies — there is no dollar ceiling there to
enforce — and says so on stderr. The refusal that matters for such a phase is `tldrx next`'s
own, which stops the headless spawn outright rather than measuring it against the wrong unit.

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
