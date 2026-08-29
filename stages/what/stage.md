<!-- schema: draft -->
<!-- Stage template: what (phase 1). Rendered into <record>/01-what/handoff.md. -->

# What — handoff

**Run:** `<run-id>` · **Stage:** `what` · **Expert(s):** `<from stage.yml>` · **Model:** `<from stage.yml>`
**Spent:** `$<n>` of `$<budget_usd>`

> Turn a phrase, a document or a ticket into a scope somebody can disagree with. Accepts a document as input: read it, extract the claims it actually makes, and ask only about the gaps.

---

## Findings

> What Investigate actually established. **Every bullet ends with a source.**
> `[src: path/to/file.ts:42]` · `[src: https://…]` · `[src: Q7]`
> A bullet you cannot source does not belong here — move it to Unknowns.

- The request is <…>, stated as <…> in the source document. `[src: …]`
- The system today does <…> in this area. `[src: …]`

## Decisions

> What was decided, and on the strength of what. Same rule: every bullet is sourced.
> Label each one **measured** (it was run), **inferred** (mechanism plus evidence,
> could be wrong) or **assumed** (nobody knows yet).

- In scope: <…>. Out of scope: <…>, because <…>. `[src: …]`

## Unknowns

> Only these become questions. Before writing one, grep `.tldrx/memory/facts.yml`:
> re-asking a recorded fact is a framework test failure, not a style choice.
> Each unknown states who or what could answer it.

- Who owns <…>, and what happens today when <…>? — *could be answered by:* `<person | file | command | doc>`

## Evidence ledger

> Every source cited above, once, with what it proved. This is what the next stage
> and the reviewer read instead of re-deriving the work.

| # | Source | Kind | What it establishes |
|---|--------|------|---------------------|
| 1 | `<path:line | url | Q-id>` | file / doc / answer / command output | … |

## Outputs written

- `intent.md`
- `scope.md` (in / out, MoSCoW)
- `success-metrics.md`
- `open-questions.md`

## Gate

Blocked on: **<human approval | checks green>**. Requirements are in `stage.yml`.
Nothing advances until this is recorded in `run.yml` and `events.jsonl`.
