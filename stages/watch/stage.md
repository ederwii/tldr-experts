<!-- schema: draft -->
<!-- Stage template: watch (phase 5). Rendered into <record>/05-watch/handoff.md. -->

# Watch — handoff

**Run:** `<run-id>` · **Stage:** `watch` · **Expert(s):** `<from stage.yml>` · **Model:** `<from stage.yml>`
**Spent:** `$<n>` of `$<budget_usd>`

> Say how anyone would know this still works next month. Generated from what Build actually instrumented — never from what would have been nice to instrument.

---

## Findings

> What Investigate actually established. **Every bullet ends with a source.**
> `[src: path/to/file.ts:42]` · `[src: https://…]` · `[src: Q7]`
> A bullet you cannot source does not belong here — move it to Unknowns.

- The feature emits <signal> at <location>. `[src: …]`
- The healthy baseline is <measured number>, taken on <date> from <query>. `[src: …]`

## Decisions

> What was decided, and on the strength of what. Same rule: every bullet is sourced.
> Label each one **measured** (it was run), **inferred** (mechanism plus evidence,
> could be wrong) or **assumed** (nobody knows yet).

- Broken looks like <…>; the alert threshold is <…>. `[src: …]`

## Unknowns

> Only these become questions. Before writing one, grep `.tldrx/memory/facts.yml`:
> re-asking a recorded fact is a framework test failure, not a style choice.
> Each unknown states who or what could answer it.

- No signal exists for <…>; add one or accept it is unobservable. — *could be answered by:* `<person | file | command | doc>`

## Evidence ledger

> Every source cited above, once, with what it proved. This is what the next stage
> and the reviewer read instead of re-deriving the work.

| # | Source | Kind | What it establishes |
|---|--------|------|---------------------|
| 1 | `<path:line | url | Q-id>` | file / doc / answer / command output | … |

## Outputs written

- `watchers/<feature>.md` (signal, where, baseline, what broken looks like, copy-paste query)

## Gate

Blocked on: **<human approval | checks green>**. Requirements are in `stage.yml`.
Nothing advances until this is recorded in `run.yml` and `events.jsonl`.
