<!-- schema: draft -->
<!-- Stage template: build (phase 4). Rendered into <record>/04-build/handoff.md. -->

# Build — handoff

**Run:** `<run-id>` · **Stage:** `build` · **Expert(s):** `<from stage.yml>` · **Model:** `<from stage.yml>`
**Spent:** `$<n>` of `$<budget_usd>`

> Write the code. Interview here usually has zero questions; the gate is tests green plus a reviewer sign-off. Nothing is done because an agent said so.

---

## Findings

> What Investigate actually established. **Every bullet ends with a source.**
> `[src: path/to/file.ts:42]` · `[src: https://…]` · `[src: Q7]`
> A bullet you cannot source does not belong here — move it to Unknowns.

- Story <id>: implemented in <files>; `<command>` exits 0. `[src: …]`
- Reviewer sub-agent raised <…>, resolved by <…>. `[src: …]`

## Decisions

> What was decided, and on the strength of what. Same rule: every bullet is sourced.
> Label each one **measured** (it was run), **inferred** (mechanism plus evidence,
> could be wrong) or **assumed** (nobody knows yet).

- Deviated from the plan at <…>, because <…>. `[src: …]`

## Unknowns

> Only these become questions. Before writing one, grep `.tldrx/memory/facts.yml`:
> re-asking a recorded fact is a framework test failure, not a style choice.
> Each unknown states who or what could answer it.

- <…> could not be verified locally and needs a real environment. — *could be answered by:* `<person | file | command | doc>`

## Evidence ledger

> Every source cited above, once, with what it proved. This is what the next stage
> and the reviewer read instead of re-deriving the work.

| # | Source | Kind | What it establishes |
|---|--------|------|---------------------|
| 1 | `<path:line | url | Q-id>` | file / doc / answer / command output | … |

## Outputs written

- `stories/<id>.md` updated with evidence
- story branches merged to the epic branch on green
- `integration-test-log.md`

## Gate

Blocked on: **<human approval | checks green>**. Requirements are in `stage.yml`.
Nothing advances until this is recorded in `run.yml` and `events.jsonl`.
