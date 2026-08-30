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
> and the reviewer read instead of re-deriving the work. **List items, not a table**
> — this section is checked exactly like the other three, and a table holds no
> list items for the gate to check.

- … what this file establishes … `[src: <repo>:<path>:<line>]`
- … what this command proved … `[src: $ <command> → exit 0]`

## Outputs written

- `intent.md`
- `scope.md` (in / out, MoSCoW)
- `success-metrics.md`
- `open-questions.md`

## Gate

Blocked on: **<human approval | checks green>** — `stage.yml`'s `gate.type`. What is
actually enforced is that file's `checks:` list, which `tldrx approve` re-runs against what
is on disk before it will advance anything. Nothing advances until this is recorded in
`run.yml` and `events.jsonl`.

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
- Questions go in `questions.md`, and its shape is a PARSER's, not a style. One regex reads a block — `^## (Q\d+) · (.+)$` — and a heading that misses it is not half-read, it is read as ABSENT: the gate then records "0 open questions" and signs itself over questions nobody answered. Write each one EXACTLY like this, `·` being U+00B7 MIDDLE DOT:
  ```
  ## Q1 · Where does leaderboard state live?
  <!-- id: Q1 | status: open | area: data-model | asked_by: architect | asked_at: 2026-08-29T14:02:11Z -->
  Why asked: no ranking store exists in the map [src: absent:.tldrx/map/api/domains.md]

  - A) New Postgres table, recomputed on hunt completion
  - B) Redis sorted set
  - C) other — write it below

  [Answer]:
  ```
  All five metadata keys are required; `Why asked:` must END with a `[src: …]` token; 2–5 options lettered A–E in order; exactly one empty `[Answer]:` slot. Ids ascend. Never write `### Qn — …`, `**Answer:**`, or the answered footer — the hook writes that. `tldrx questions lint` checks the file; `--fix` converts a file already written the wrong way.
- Before asking a question, grep `.tldrx/memory/facts.yml`; if the answer is there, cite `F<n>` instead of asking.
- Write only the declared outputs; do not add sections beyond the ones listed under Produce.
