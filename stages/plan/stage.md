<!-- schema: draft -->
<!-- Stage template: plan (phase 3). Rendered into <record>/03-plan/handoff.md. -->

# Plan — handoff

**Run:** `<run-id>` · **Stage:** `plan` · **Expert(s):** `<from stage.yml>` · **Model:** `<from stage.yml>`
**Spent:** `$<n>` of `$<budget_usd>`

> Cut the design into stories somebody could pick up cold, ordered by dependency, priced against the budget, and shaped the way this team actually works.

---

## Findings

> What Investigate actually established. **Every bullet ends with a source.**
> `[src: path/to/file.ts:42]` · `[src: https://…]` · `[src: Q7]`
> A bullet you cannot source does not belong here — move it to Unknowns.

- Story <id> touches <files>, and its acceptance criteria are testable by <…>. `[src: …]`
- Stories <a> and <b> are independent and can run in the same wave. `[src: …]`

## Decisions

> What was decided, and on the strength of what. Same rule: every bullet is sourced.
> Label each one **measured** (it was run), **inferred** (mechanism plus evidence,
> could be wrong) or **assumed** (nobody knows yet).

- Wave ordering is <…>, because <b> needs <a>'s contract. `[src: …]`

## Unknowns

> Only these become questions. Before writing one, grep `.tldrx/memory/facts.yml`:
> re-asking a recorded fact is a framework test failure, not a style choice.
> Each unknown states who or what could answer it.

- Whether <…> can ship behind a flag or needs a migration first. — *could be answered by:* `<person | file | command | doc>`

## Evidence ledger

> Every source cited above, once, with what it proved. This is what the next stage
> and the reviewer read instead of re-deriving the work.

| # | Source | Kind | What it establishes |
|---|--------|------|---------------------|
| 1 | `<path:line | url | Q-id>` | file / doc / answer / command output | … |

## Outputs written

- `epics/<epic>.md`
- `stories/<id>.md` (AC + test plan + touched files + repo)
- `waves.yml`
- `budget.yml`

## Gate

Blocked on: **<human approval | checks green>**. Requirements are in `stage.yml`.
Nothing advances until this is recorded in `run.yml` and `events.jsonl`.
