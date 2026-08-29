<!-- schema: draft -->
<!-- Generic handoff. Each stage ships its own specialised copy at stages/<slug>/stage.md. -->

# <Stage> — handoff

**Run:** `<run-id>` · **Stage:** `<slug>` · **Expert(s):** `<names>` · **Model:** `<model>`
**Spent:** `$<n>` of `$<budget>`

> One sentence: what this stage was asked to establish.

---

## Findings

> What Investigate actually established. **Every bullet ends with a source.**
> `[src: path/to/file.ts:42]` · `[src: https://…]` · `[src: Q7]`
> An unsourced bullet is rejected by the claim-sources hook, not by a prose rule.
> If you cannot source it, it is not a finding — it is an Unknown.

- … `[src: …]`
- … `[src: …]`

## Decisions

> Label each one:
> **measured** — I ran it and this is the output.
> **inferred** — here is the mechanism and the evidence; I could be wrong.
> **assumed** — nobody knows yet; this is what we are proceeding on.

- **measured** … `[src: …]`
- **inferred** … `[src: …]`
- **assumed** … `[src: …]`

## Unknowns

> Only these become questions in `questions.md`. Grep `.tldrx/memory/facts.yml`
> first — re-asking a recorded fact is a framework bug.

- … — *could be answered by:* `<person | file | command | doc>`

## Evidence ledger

> Every source cited above, once, with what it proved. **List items, not a table**
> — like the three sections above, this one is checked, and each of the four must
> hold at least one item. Nothing to say? `- none [src: absent:<what you looked at>]`.

- … what this file establishes … `[src: <repo>:<path>:<line>]`
- … what this command proved … `[src: $ <command> → exit 0]`

## Confidence

| Area | Confidence | Why |
|------|-----------|-----|
| … | high / medium / low | … |

## Outputs written

- `<file>` — …

## Gate

Blocked on: **<human approval | checks green>**.
Recorded in `run.yml` and `events.jsonl` when it clears.
