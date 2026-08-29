<!-- schema: draft -->
<!-- Stage template: how (phase 2). Rendered into <record>/02-how/handoff.md. -->

# How — handoff

**Run:** `<run-id>` · **Stage:** `how` · **Expert(s):** `<from stage.yml>` · **Model:** `<from stage.yml>`
**Spent:** `$<n>` of `$<budget_usd>`

> Place the design on real files and modules from the code map. A component that does not cite an existing path is a wish, not a design.

---

## Findings

> What Investigate actually established. **Every bullet ends with a source.**
> `[src: path/to/file.ts:42]` · `[src: https://…]` · `[src: Q7]`
> A bullet you cannot source does not belong here — move it to Unknowns.

- The change lands in <module>, which today does <…>. `[src: …]`
- The external API behaves as <…> per its official docs, fetched this run. `[src: …]`

## Decisions

> What was decided, and on the strength of what. Same rule: every bullet is sourced.
> Label each one **measured** (it was run), **inferred** (mechanism plus evidence,
> could be wrong) or **assumed** (nobody knows yet).

- Approach <A> over <B>, because <…>. `[src: …]`

## Unknowns

> Only these become questions. Before writing one, grep `.tldrx/memory/facts.yml`:
> re-asking a recorded fact is a framework test failure, not a style choice.
> Each unknown states who or what could answer it.

- Whether <…> is load-bearing for <…> — no test covers it. — *could be answered by:* `<person | file | command | doc>`

## Evidence ledger

> Every source cited above, once, with what it proved. This is what the next stage
> and the reviewer read instead of re-deriving the work.

| # | Source | Kind | What it establishes |
|---|--------|------|---------------------|
| 1 | `<path:line | url | Q-id>` | file / doc / answer / command output | … |

## Outputs written

- `design.md`
- `contracts.md` (APIs / DTOs / events)
- `risks.md`
- `test-strategy.md`

## Gate

Blocked on: **<human approval | checks green>**. Requirements are in `stage.yml`.
Nothing advances until this is recorded in `run.yml` and `events.jsonl`.
