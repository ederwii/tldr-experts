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
> and the reviewer read instead of re-deriving the work. **List items, not a table**
> — this section is checked exactly like the other three, and a table holds no
> list items for the gate to check.

- … what this file establishes … `[src: <repo>:<path>:<line>]`
- … what this command proved … `[src: $ <command> → exit 0]`

## Outputs written

- `design.md`
- `contracts.md` (APIs / DTOs / events)
- `risks.md`
- `test-strategy.md`

## Gate

Blocked on: **<human approval | checks green>**. Requirements are in `stage.yml`.
Nothing advances until this is recorded in `run.yml` and `events.jsonl`.

## Rules

- Every bullet under Findings / Decisions / Unknowns / Evidence ledger is ONE line and ENDS with a source token. A bullet without one is refused by the `claim-sources` gate and the whole stage fails.
- Each of Findings / Decisions / Unknowns / Evidence ledger must hold at least ONE list item; a section that is genuinely empty is written as `- none [src: absent:<what you looked at>]`, and a prose-only section is refused by the `claim-sources` gate.
- Source token grammar (exact): `[src: <one or more sources separated by "; ">]` where a source is ONE of:
  - `<repo>:<path>:<line>` or `<repo>:<path>:<start>-<end>` — a file with ONE line or ONE range. Never a whole file, never a comma list (`file.md:7,21` is invalid: write two sources or a range).
  - `F<n>` — a fact id from `.tldrx/memory/facts.yml` (cite the id, never the file).
  - `Q<n>` — a question from this run's questions.md.
  - `https://…` — an external document (https only).
  - `aidlc:<file>:<line>` / `aidlc:<file>#Q<n>` — an imported source, exactly as it already appears in intent.md/scope.md.
  - `$ <command> → exit <n>` — only under Evidence ledger, only for commands listed in `.tldrx/workspace.yml`.
  - `absent:<path>` — you looked there and found nothing.
- Do not cite templates, expert files or directories (`.tldrx/experts/*` is not evidence).
- Before asking a question, grep `.tldrx/memory/facts.yml`; if the answer is there, cite `F<n>` instead of asking.
- Write only the declared outputs; do not add sections beyond the ones listed under Produce.
