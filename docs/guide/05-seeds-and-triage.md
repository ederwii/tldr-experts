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

### Writing a seed by hand

A seed you write yourself is the input of an unattended run, so it has to survive two
mechanical readers with nobody there to fix it: the importer
(`src/core/distill/markdownClaims.ts`) that turns it into claims, and the `[src:]` grammar
(`src/core/text/srcToken.ts`) that `claim-sources` checks every claim against. The rules,
measured in both:

- **One claim per bullet.** Consecutive prose lines are merged into ONE claim before
  anything else happens — a hard-wrapped paragraph is one claim, not several — and a blank
  line, a heading or a fence ends it.
- **At most ~200 characters per bullet, citation included.** The importer clips a claim at
  240 characters (`MAX_CLAIM_CHARS`). The clip never splits a citation — since #275 it moves
  back to the start of the one it would have cut — but a clipped bullet LOSES that citation,
  and the handoff then cites only the seed line. Stay well under if you want your own `[src:]`
  to survive.
- **Close every `[src:` you open.** An unterminated marker is swallowed by the closing `]` of
  the importer's own token, and the two fold into one path that is not a file; `run new`
  refuses and says so, naming the line (#275).
- **The `[src: path:line]` token is the LAST thing on the line.** A citation written
  mid-sentence is invisible to the reader; only punctuation may follow the `]`.
- **A `file` source is `[repo:]path:line[-line]`** — a path with no line number cites a
  file, not a fact, and is refused; the range ascends; line numbers are 1-based.
- **Paths are workspace-relative and must exist.** They are resolved against your checkout.
- **Several sources in one token are joined with `"; "`**: `[src: src/a.ts:12; src/b.ts:40]`.
- **Use the four What headings** — `# Intent`, `# Scope`, `# Success metrics`,
  `# Open questions` — so every output is covered and none is reported as an Unknown.
- **A `## Solution` (or `## Technical approach`) H2 skips `how` (gh #346).** When the seed
  already declares its own technical solution under one of these two exact headings, `run
  next` skips `how` entirely and `plan` reads that section instead of a `how`-written
  `design.md` — `how`'s own `design.md` is materialised from it verbatim, cited back to this
  file and heading. This is never inferred from prose: a paragraph that merely SOUNDS like a
  solution does not trigger it, only the heading, exactly spelled, at H2 (a nested `###
  Solution` under something else does not count either). Skip the heading if you want `how`
  to think it through instead — most seeds should.
- **Give every open question a `Recommended:` line.** Under `run new --questions none` the
  loop answers a question only when its block names one of its own options on a
  `Recommended: <letter>` line — optionally `<letter>)`, then `— <why>`, then a trailing
  `[src: …]`, in that order; one without a recommendation parks the run for a person.
  `seed check` reads the line with the loop's own reader (#323): a `Recommended:` it cannot
  read (`question-recommended-unreadable`) or a letter naming none of the options the bullet
  lists (`question-recommended-option`) is a finding, exit `1`, like a missing one.
  The question blocks are the What agent's — the seed's recommendation is what it
  reads to write that line (inferred from the mechanism, not measured on a run).

The rules above are the grammar. The rules below are what four unattended runs in one week
taught about the WORK a seed describes — the seeds that finished alone followed them, the one
that needed four rescues broke most of them (#291). Two kinds, and each says which: a
**craft** rule holds for any version; a **patch for #N** exists because of an OPEN framework
bug and is deleted when it closes. `tldrx seed check <file>` enforces every one below that a
machine can read, as findings (exit `1`) or advisories (printed, exit unchanged).

- **Declare the stories** (craft): a `# Stories` heading, then one `## S<n> — <title>` per
  story with, in order, `- touches: <path>, <path>`, `- depends_on: none` (or `S1, S2`),
  the acceptance bullets with their citations, and a fenced ```` ```dod ```` block. The Plan
  stage still writes the real `03-plan/stories/<id>.md`; the seed is what it plans FROM.
- **A story is one agent's turn under one cap** (craft): ≤ ~$15 of work, one repo, one
  branch, one Definition of Done a hook can re-run. If you cannot say which files it
  touches, it is two stories or it is not ready.
- **Size (patch for #286/#244/#280 — raise when they close):** today plan runs of at most 4
  stories and 2 waves; the framework's measured limit, not a design preference. 1/1 and
  3/3 runs finished alone; the 8-story run needed four human rescues, and every story that
  waited for a person lost the race against siblings merging into the epic. Over the limit
  is an `advisory:` from `seed check`, never a refusal of the SEED — read the CHANGELOG's
  latest released section for the current number before planning. The plan written from it
  is held harder (#316): the Plan gate refuses more waves than that unless `waves.yml`
  records `wave_cap_reason: "<why>"`, and refuses a story scheduled later than its
  `depends_on` requires. Both numbers live in `src/core/plan/planShape.ts`.
- **Plan shape (craft, #317/#318/#319):** every story is a vertical slice — reachable from
  a route or endpoint when its own dod goes green, wiring included; the route trees, guard
  tables, allow-lists and snapshots that ENUMERATE what a story adds are in its `touches:`
  from the start; and end-to-end coverage is a harness story first or the e2e command in
  each UI story's `dod`, never one last story that depends on everything. The full wording
  is what the Plan stage is given: `tldrx plan schema`, section "Plan shape".
- **Waves are bounded by shared files, not by a count** (craft): stories touching the same
  counted list / snapshot / registration file chain through `depends_on`; everything else
  may run in parallel.
- **Boundaries (#268/#286):** a migration inventory test, an approved OpenAPI or
  authorization contract, an allow-list, a route registration — any file two stories would
  BOTH edit — is in both stories' `touches:` and the second story `depends_on` the first.
  Never the same wave: one conflicted file became four. Two stories naming the same touched
  path with no dependency between them is a `wave-boundary` finding.
- **`dod` lines are byte-equal to a workspace `commands:` value, one per line** (craft): no
  `&&`, no `;`, no redirection, no added flag — `dod-gate` compares bytes
  (`src/core/schemas/story.ts`, `validateStoryDod`) and refuses a line that needs a shell
  (`unquotedShellSeparator`). Measured on #271/#278: a chained line was refused by the
  permission layer before the gate ever ran.
- **Tools (patch for #290 — the planner checks this by hand until Plan can):** an
  acceptance criterion may only demand a command the workspace declares in `commands:`.
  Need one that is not there? Add the slot to `workspace.yml` first — measured on #285, an
  undeclared tool cost four developers on one story, and the cure names the tool and its
  subcommand only (add `sha256sum`, not a pipeline). A `git` line is never a `commands:`
  slot: git verbs are a separate grant.
- **Approved snapshots (#278/#285 field notes):** when the repo approves a contract by
  replacing a file (a `.approved.*`, a golden, a generated inventory), the story SAYS which
  file and how it is regenerated — "run `<command>` and commit the new `<file>`" — or the
  developer leaves it stale and the review refuses.
- **Budget (patch for #244/#289 — delete when closed):** `run new --budget` is split into
  stage shares by the preset's ratios, weighted by `attempts` (`planBudget`,
  `src/core/run/newRun.ts`); a feature run at `--budget 60` gives Build $10.80 per attempt
  and a story's developer cap is a share of THAT. `tldrx seed check <file> --scope <s>
  --budget <usd>` prints the split and the per-story caps off the same arithmetic — pick a
  ceiling whose per-story cap covers the largest story.

Run `tldrx seed check <file>` before `run new`: it is the same importer plus every rule on
this page, read-only, and it creates no run. In Claude Code, `/tldrx-plan` — the second skill
`tldrx install --claude` writes — walks from "I want X" to seeds that pass it, and ends with
the exact `run new` line.

The conventional location is `.tldrx/seeds/<nn>-<slug>.md`, committed with the rest of
`.tldrx/`. A seed for a session-timeout defect, every bullet under the cap:

````markdown
# Intent
- Sessions expire after 15 idle minutes; the settings page promises 60 [src: src/auth/session.ts:42]

# Scope
- Fix the constant and its one reader; the settings copy is not in scope [src: src/auth/session.ts:42; src/auth/refresh.ts:18]

# Success metrics
- The existing idle-timeout test passes with a 59-minute idle session [src: test/auth/session.test.ts:77]

# Open questions
- Should a refresh call extend the idle window? A) yes B) no. Recommended: B — the copy promises idle minutes [src: src/auth/refresh.ts:18]

# Stories

## S1 — Fix the idle constant and its reader
- touches: src/auth/session.ts, src/auth/refresh.ts
- depends_on: none
- Acceptance: a 59-minute idle session is still valid [src: test/auth/session.test.ts:77]

```dod
npm test
```
````

(`npm test` here stands for whatever `commands:` value the workspace declares — the line
is compared byte for byte.) The run that consumes it with nobody watching is in
[10 — Unattended mode](10-unattended-mode.md#zero-touch-the-recipe-that-worked).

### From an AI-DLC intent folder

```bash
tldrx run new payments --from ~/project/aidlc/intents/260821-feature
```

`--from` reads only the listed files, turns every bullet/paragraph under a heading into a
Finding tagged `[src: aidlc:<file>:<line>]` and every answered `## Q<n>.` block into a fact
plus a Finding tagged `[src: aidlc:<file>#Q<n>]`. Unanswered blocks and ceremony stages are
dropped; a claim contradicting a live fact becomes a question in
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
