# 5 — Seeds and triage

## Starting a run from documents you already have

```bash
tldrx run new payments --seed docs/payments/README.md
tldrx run new payments --seed docs/payments/ --seed docs/adr/
```

`--seed` takes one `.md`/`.txt` file, or a directory of them (recursive, sorted, ≤ 50 files,
≤ 2 MB each; larger or unreadable ones are skipped **and named**; PDFs and Word files are out
of scope). It **copies nothing**: the originals stay where they are and every claim cites
them as `[src: <path>:<line>]`.

It writes `01-what/seed-index.md` (what was read, how big, what was skipped) and
`01-what/handoff.md` whose Findings are every heading, bullet and paragraph of the seed, and
whose Unknowns are the What outputs no seed heading covers (`intent` / `scope` /
`success-metrics` / `open-questions`, matched by heading, no model involved). The documents
are added to the What stage's **declared inputs** in `run.yml`, so `tldrx next` inlines them
into the prompt. Deterministic — no LLM, no network.

`--seed` is **repeatable**: several are merged, deduped and re-sorted, with the 50-file cap
applied to the merged set rather than per argument. One occurrence is byte-for-byte what it
always was.

### From an AI-DLC intent folder

```bash
tldrx run new payments --from ~/project/aidlc/intents/260821-feature
```

`--from` reads only the listed files, turns every bullet/paragraph under a heading into a
Finding tagged `[src: aidlc:<file>:<line>]` and every answered `## Q<n>.` block into a fact
plus a Finding tagged `[src: aidlc:<file>#Q<n>]`. Unanswered blocks and ceremony stages are
dropped; a claim contradicting a non-retired fact becomes a question in
`01-what/questions.md`. A claim that **agrees** with a fact already held (same area, Jaccard
≥ 0.9) reuses it rather than appending a second copy, so importing the same folder twice
leaves `facts.yml` byte-identical. Deterministic — no LLM, no network.

`--from` and `--seed` are mutually exclusive.

## When the seed is too big for one run

`--seed docs/` on a 25-document design folder makes one run that pays for that context at
**every stage**, and one branch for what was several pieces of work. `tldrx run new --seed`
says so on stderr when it happens:

```
note: seed is 25 files / ~44k tokens — `tldrx seed triage docs/domain-design` can propose a split
```

stderr, never stdout — a chat bridge parses stdout, and a note is not a result.

Three commands, and the boundaries between them are the design:

```bash
tldrx seed triage docs/domain-design            # count it — free, no model, no network
tldrx seed triage docs/domain-design --propose  # ONE cheap pass → split.yml + split.md
tldrx seed answer .tldrx/triage/260830-domain-design/split.yml Q1 "we ship zones first"
tldrx seed apply  .tldrx/triage/260830-domain-design/split.yml --dry-run
tldrx seed apply  .tldrx/triage/260830-domain-design/split.yml
```

### `triage` — free, offline, no LLM

Collects the documents with exactly the `--seed` rules and writes `inventory.md` +
`inventory.json`: per document, its size in tokens (`bytes/4`), its H1/H2 headings, which
other seed documents it links to **or names by filename**, the first `Status:` line's value,
a count of open markers (`TODO`/`TBD`/`open question`/`??`), and whether it is
**code-derived**.

That last flag is the only judgement in the file, and it resolves before it counts: a
document is code-derived when ≥ 8 distinct path-like, non-documentation tokens it cites are
**real files** under the workspace root or a repo in `workspace.yml`. Citing `src/Foo.cs`
proves nothing; eight paths that all exist means the code says the same thing and the model
can read the code instead of you paying for the document.

Measured on a real design folder (2026-08-29): a 152 KB legacy inventory document cites
**294** distinct path-like tokens and **0** of them resolve — that repo is a rewrite and
those paths belong to the system it replaced — so it is *not* flagged. A rule that counted
citations instead of resolving them would have called it code-derived and been wrong.

Ends in one verdict line naming the next command. Threshold: `--threshold-tokens`, else
`seed_triage.threshold_tokens` in `workspace.yml`, else 20,000. `--out` defaults to
`.tldrx/triage/<yymmdd>-<slug>/`; `--json` for the same data.

### `--propose` — one cheap model pass that creates nothing

ONE sub-agent (effort `low`, `--max-usd 1.00` by default, no `--model` unless you pass one),
spawned the way `next` and `expert train` spawn theirs, with `--json-schema` and the same
`--prepare` / `--commit` handshake.

The prompt carries the inventory and the documents under a 120 KB budget: everything whole
if it fits, otherwise small documents whole plus **complete heading lists and a 2 KB prefix**
for the rest, with every truncation named and byte-counted — because a model that thinks it
read a 152 KB design document and read 2 KB of it will propose a split with great confidence.

The answer is validated against **this** workspace before anything is written: scope against
the workflows on disk, seeds against the inventory, slugs against `run new`'s own regex,
`depends_on` for cycles, and every `why[].src` against the `seed:<rel>#<heading>` /
`seed:<rel>:<line>` grammar. Failure is whole — exit `5`, no `split.yml`, the raw answer kept
at `.agent/propose/result.raw.json`. Below the $0.25 floor it refuses before spawning
(exit `2`). **It never creates a run.**

### `answer` — a decision with somewhere to live

A split's runs could always be edited and its exclusions deleted; its `questions:` were the
one part with nowhere to put the reply, so the answer lived in someone's head until `apply`
created runs that did not reflect it.

`tldrx seed answer <split.yml> <Qid> "<text>"` records the decision beside the question. The
key is human-owned — the propose schema still refuses it, so a model can never write one —
and the file is parsed, validated and re-emitted whole rather than patched, so a proposal
that does not validate is refused before anything is written.

### `apply` — the human gate

"The model proposed it" and "we are doing it" must not be the same event. `apply` refuses
anything that is not `status: proposed`, revalidates the file you were invited to edit, then
creates each run in **topological order** through the same `createRun` that
`tldrx run new` calls — `--scope`, `--budget`, and `shared_context + seeds` as repeated
`--seed`.

Each `run.yml` records an optional `triage: {split, depends_on}` block (absent on every other
run, so nothing else changes), which is what makes `tldrx status` and the dashboard show
`blocked by <slug>` on a run whose sibling is not done.

`split.yml` moves to `status: applying` before the first run and grows `created_runs` after
each one, so a crash at run 3 of 8 is reported as `stopped at run 3 of 8` rather than as
"nothing has been created yet". On success it is rewritten `status: applied` with
`applied_at` and the created run ids, so a second apply cannot duplicate them.

`--dry-run` prints the exact `tldrx run new …` lines and writes nothing. If a run directory
already exists the apply **stops there**, exit `1`, naming the collision *and* the runs
already created and left in place — partial application is a real state, and pretending
otherwise is how people lose work.

Unanswered questions are listed on **stderr** by `apply`: a warning, never a refusal.
Applying anyway is a legitimate call; staying silent about it is not.
