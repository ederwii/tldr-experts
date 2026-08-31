# 4 — Experts

An expert is a folder under `.tldrx/experts/<name>/`, and a stage prompt gets three things
out of it.

1. **`expert.md`** — the role, the domain and the citation rules a human wrote.
2. **A star chart** — one line per competency area, computed from evidence and never
   self-declared: `ef-core  ★★★☆☆ 3  (17 evidence, newest 2026-08-20)`.
3. **Trained knowledge** — the `knowledge/<area>.md` files `tldrx expert train` wrote and
   the framework validated off disk, most-recently-trained first.

Every bullet in those knowledge files carries a `[src: …]` token that resolved against a
real file when the knowledge was accepted, and the prompt tells the sub-agent so — they are
reusable as evidence, verbatim, without re-opening anything. Otherwise the sub-agent
re-derives what it was just handed.

## Which experts a stage loads

Three rules, and only three:

1. the stage's own `experts:` list in `stage.yml`;
2. `stack_experts: true` (the default) → the `<language>-stack` expert of each of the run's
   repos;
3. any `kind: domain` expert whose declared paths the run cites — or that sits within two
   hops of a cited path in `graphify-out/<repo>/graph.json`.

A `repos:` match only counts in a workspace with two or more repos, because in a single-repo
workspace it selects everybody. Rank is a score: a direct `## Domain` path match is worth 10,
a path within 2 hops of a cited one is worth 1, and scores add. Experts are ranked by that
score, the knowledge budget is split by rank, and an expert with score 0 contributes its body
and no knowledge at all.

`tldrx next --prepare` prints what each one contributed in bytes; `tldrx expert list` prints
a `loaded by:` line naming the stages that would load each expert and why — `what (named),
how (stack), build (domain)` — so an expert that is trained and that no stage will ever load
stops being invisible.

An expert loaded with zero evidence in every area earns one **stderr** note naming its train
command. It never blocks and never changes an exit code.

## The knowledge budget

One budget for ALL the loaded experts together — `knowledge_max_bytes` in `stage.yml`,
default **48 KB** — split by relevance rank, never one budget each. (A per-expert cap scales
with a number nobody set: that is how 64 KB became 83,523 measured bytes across nine
experts.) Declared inputs are filled first, out of `inputs_max_bytes` (96 KB), because an
input the stage declared outranks reference material nobody asked for.

When the budget bites, the cut lands on an H2 boundary — half a bullet is a claim with its
citation torn off — and the prompt says `… N more findings in
.tldrx/experts/<name>/knowledge/<area>.md` rather than trailing off. A file whose first
section already blows the budget is named, not half-inlined.

## Role experts

Five of the shipped experts are **role experts**, and `tldrx init` seeds all five:
`product` (What), `architect` (How and Plan), `delivery` (Plan), `developer` (Build) and
`operations` (Watch) — the names the shipped stage files have always listed.

A role expert's subject is the workflow rather than a folder of code: what its stage is
accountable for, what it must refuse, what it cites and what it hands over. Its body ships as
an editable file at `templates/experts/<role>.md`, copied into
`.tldrx/experts/<role>/expert.md` once and yours after that. `init` re-runs add a missing
role and never touch an existing one, and `tldrx expert create <name> --role <slug>` seeds
the same thing on demand (an unknown slug falls back to the generic template with
`kind: role`, and the CLI says which of the two it used).

`kind: role` keeps a role out of the domain-match rule: a role loads because a stage named
it, and for no other reason.

The two placeholder names older stage files used, `domain` and `stack`, are retired: they
were rules 2 and 3 above written as though they were folders. A stage file that still lists
them gets one note saying so instead of a NOT LOADED line on every run.

## Training

```bash
tldrx expert train billing --area money --mode light
tldrx expert train billing --area money --mode light --print-prompt   # free, spawns nothing
```

The design is built around one rule: **a level moves because a file was cited, never because
an agent said it learned something.**

- **A deterministic pre-pass picks the files.** No model is asked what to read:
  `.tldrx/map/<repo>/domains.md`, graphify communities when the graph has any, and a bounded
  keyword grep over the expert's repos (the area id and the words of its title) — capped at
  **40 files / 96 KB**, with everything over the cap listed by name as "not read", so a
  sub-agent cannot describe a file it was never shown.
- **The expert's own `## Domain` is a hard boundary on that walk.** A file outside the declared
  folders is never scored, never inlined, and is not even listed as "not read" — it was never a
  candidate for this expert. Measured on a real workspace: the grep alone put 29% / 55% / 22% of
  three trained experts' citations outside their own declared domain — knowledge filed under the
  wrong name, written at full price. Bounding the input is cheaper than warning about the
  output. An expert that declares no domain (a stack or whole-repo expert) is unbounded.
- **One sub-agent** — the expert plus its stack experts plus the conventions — reads only
  what was inlined, with a line-number gutter (a citation whose line is outside its file is
  rejected), and writes `.tldrx/experts/<name>/knowledge/<area>.md` with `## Invariants`,
  `## Entry points`, `## Business rules`, `## Gotchas`, `## Sources`.
- **The framework re-reads that file off disk** and validates it with the SAME parser the
  `claim-sources` hook uses, so a knowledge file cannot pass here and be denied on write.
  Every list item must end in a `[src: …]` token; `absent:` is a legal finding and earns no
  evidence.
- **Evidence is derived, not asserted:** one `code` row per **distinct cited file**, one
  `run` row per distinct cited command and exit code, `doc` for an https URL, `answer` for
  `F<n>`. An evidence `src` is validated against its `kind` both directions through the same
  `classifySrc` the hook uses, so `{kind: run, src: "the tests pass"}` no longer counts as a
  run.
- **One repair round comes first.** When the file does not validate, the validator's exact
  problems are handed back to the SAME trainer for one more turn — a fresh `claude -p` carrying
  the original prompt (so the inlined files it must cite are still in front of it), the rejected
  file with a line-number gutter, and the numbered verdict. The output says so while it happens:
  `repairing: 3 problem(s) sent back to the trainer — one round, $0.31 of the ceiling left`.
  The repair turn is paid out of the same `--max-usd`: its ceiling is whatever is left of the
  run's, and under the `$0.25` floor it does not spawn at all and says why. **One round only** —
  a second failure rejects exactly as the first used to, and the repaired file is judged by the
  same validator, so the gate has not moved. Not on `--commit`: there the sub-agent belongs to
  the host session, and repairing is running `--commit` again.
- **Rejection is whole.** One unsourced item, or one line past the end of its file, and after
  the repair round nothing is written: no evidence, no level change, no status change. Any
  knowledge file already accepted is restored byte-for-byte, and the rejected one is moved to
  `<area>.rejected.md`. Exit `5`. Mid-run the sub-agent writes `<area>.md.partial`, which is
  renamed onto the real name only after the file validates — `.md.partial` never matches
  `*.md`, so nothing half-written can be inlined.
- **Errors reject; warnings do not, and the report now says which is which.** Only four things
  are fatal: a missing H2, a checked section with no list item, an item with no `[src: …]` or one
  that does not resolve, and an execution claim ("exit 0", "78/78 passed", "the build is green",
  the bare word "measured") citing a file line instead of a `` $ <cmd> → exit <n> `` command.
  `paraphrase`, `outside domain` and **`duplicate src` are warnings on every shape** — each costs
  that one bullet its evidence row and nothing else, because "it earns no second row" is a
  statement about scoring, not about honesty. The headline counts errors only, and warning lines
  carry the word `warning:`.

`--mode full` adds a second sub-agent that mines `tldrx-work/**/{handoff,retro}.md` from
runs whose repos overlap this expert's, plus matching `facts.yml` rows, into
`knowledge/from-runs-<area>.md` (`run` and `answer` evidence). **Claude Code transcripts are
deliberately out of scope:** they carry no citation anything can re-resolve.

On a **role expert**, `--mode light` is **refused** (exit 1) before anything is spawned or
spent — the grep would either score nothing or score files for containing the word — and
`--mode full` runs the runs pass alone. Full mode with no matching run is refused the same way.
There is material to mine now: the Build executor appends `## Build feedback` to
`tldrx-work/<run>/retro.md` as each story settles — every reviewer `changes` verdict and
finding, every DoD command that failed on the first attempt with its exit code, every merge
conflict, and every gate rejected or approval revoked with its note. Before that, `retro.md`
existed only when a human typed `tldrx retro`, which is why all five role experts sat at level
0. `tldrx retro` carries the section forward rather than overwriting it.

Every run appends to `.tldrx/experts/<name>/training.jsonl` — the `events.jsonl` envelope
with `run` replaced by `expert` and `stage` by `area`, because training outlives every run.
A refused run still writes its `agent.result`: money spent is recorded whether or not the
knowledge was kept.

`--prepare` / `--commit` runs training from inside a Claude Code session, one bundle per
sub-agent under `.tldrx/cache/training/`. `--print-prompt` prints the copy-paste prompt and
spawns nothing; it names the workspace's repos, lists the five evidence kinds a session may
write, and ends by telling that session to run `tldrx expert recompute <name>` — nothing
else writes the level on that path.

Money: `--max-usd` (default **$2.00**, split between full mode's two agents) reaches the
sub-agent as `--max-budget-usd`. Below the **$0.25 floor** it refuses with exit `2` before
reading anything. See [6 — Budgets and cost](06-budgets-and-cost.md).

## What earns a place on a knowledge file

Making every `src` resolvable is a check on the citation and says nothing about the sentence.
Four more rules decide whether a bullet is worth anything.

**An execution claim needs a command src.** A bullet asserting a result — "exit 0", "78/78
passed", "the build is green" — must cite the command, `[src: $ dotnet build → exit 0]`. Citing
the line of `workspace.yml` that *declares* that command is **refused**:
`execution claim needs a '$ <cmd> → exit <n>' src, not a file line`. The rule reads prose
paragraphs as well as bullets, because a knowledge file's header is a paragraph and its tokens
sit mid-line where a line-anchored parser never looks. Measured on a real corpus: 7 refusals on
one file, 1 on another, 0 on the third.

**Three warnings cost a citation its evidence row without rejecting the file.** None of them is
a lie; they are ways of being worth nothing, and the honest response is a level that does not
move:

| Warning | When | Note |
|---|---|---|
| `paraphrase` | the bullet is ≥ 90% a verbatim substring of the ±3-line neighbourhood of the line it cites | restating a docstring is not a finding |
| `outside domain` | the path is outside this expert's own `## Domain` | the expert whose domain *does* contain it is named — train that one |
| `duplicate src` | this `src` is already on record for this expert, in any area | one reading cannot be sold twice by moving it to a second area |

Measured on the real corpus: 57 outside-domain and 7 duplicate warnings across 248 bullets.

**`## Sources` earns nothing.** It was 41 of 107 bullets in one real knowledge file and 18 of 56
in another, every one re-citing a source cited above it. It is still validated like any other
section; it just derives no evidence and does not count as a finding.

**A bullet may carry its own confidence.** End it with `(measured)` / `(inferred)` /
`(assumed)`, or lead with `*measured* —`; it is parsed onto the evidence row as `confidence:`.
Both spellings are stripped before the execution rule matches — inside the annotation the word
is a label, not a claim.

**What the prompt asks for.** A finding is something a model could not re-derive by reading that
one file once: cross-file contradictions, dead paths, defaults that differ from their
docstrings, absences written as a negative claim, measured commands.

## How a level is computed

`level` is arithmetic over the evidence on disk, never self-declared; a hand-edited value is
overwritten on the next write.

```
recency = max(0.25, 1 - ageDays/365)              # continuous, no cliff
weight  = code 1.0 · run 1.0 · test 1.0 · answer 0.8 · doc 0.5
          × 2   when the row is `cross: true`     # a finding spanning ≥ 2 files
          × 0.5 when `confidence: assumed`
W       = Σ (recency × weight)
level   = 0 if W<0.5 · 1 if <1.5 · 2 if <3 · 3 if <6 · 4 if <20 · else 5
```

Then three caps, in this order:

1. **run cap** — no `kind: run` row at all ⇒ `min(level, 3)`
2. **top-rung kinds** — level 5 needs ≥ 2 distinct evidence kinds, else 4
3. **distinct sources** — `level ≤ count(distinct src)`

**Stars above 3 are earned by measuring.** Reading is evidence that code *says* something;
only a run is evidence that it *does* it. Measured 2026-08-29: an expert holding 15 `code` +
2 `test` rows — all written the same afternoon by one reading session, no command ever
executed — computed 5/5 under the old thresholds. It caps at 3 now.

**Recency fades; it does not expire on a Tuesday.** There used to be a four-band recency table
and a hard cap pinning any area whose newest row was over 180 days old at level 2 — a cliff, so
an expert trained on day 179 and the same expert on day 181 knew identical things and the ladder
reported 4 and 2. One continuous factor, floored at 0.25, replaced both.

**A cross-file finding counts double.** `cross:` and `confidence:` are additive `evidence[]`
fields derived from the bullet, never asserted; a row written before they existed carries
neither and computes as it always did. A model can re-derive anything one file says by reading
it; what it cannot re-derive is the relationship between two.

A `run` row is necessary, not sufficient: one alone is `W = 1.0`, level 1. Where
`workspace.yml` declares no command there is no `Bash` grant at all, the training prompt says
so, and level 3 is the honest ceiling in that workspace.

An evidence row whose `kind` is not one of `code` `run` `test` `doc` `answer` is not counted,
and never silently: one `warning: <expert>/<area>: N evidence row(s) ignored — unknown kind
'<x>'` per unknown kind goes to **stderr**, so it survives `--json` and a redirect.

`tldrx expert list` also warns when two experts cite the same `file:line` with bullets whose
normalised texts differ — `warning: shared citation <file:line> by <a>,<b> — check for
contradiction`, on stderr. It resolves nothing on purpose: deciding which expert is right is not
something a deterministic tool can do. Measured: 16 files on a real workspace were cited by two
trained experts each, and nothing compared what the two said.

## Looking at them

```bash
tldrx expert list [--json]           # status, last_trained, areas, evidence count, levels, star chart
tldrx expert recompute [<name>]      # recompute every level from evidence already on disk
tldrx expert create <name> --role <slug> | --domain <slug> | --stack <lang>
```

`list` recomputes every level from evidence with the formula above and **warns when the
stored number disagrees**, naming `tldrx expert recompute <name>` as the fix. That command
exists because only the headless / `--commit` training path ever wrote a level: a human who
pasted the `--print-prompt` prompt into their own session ended with `level: 0` on disk while
the formula computed 5. `recompute` prints one line per area — `name/area: level 0 → 5 (17
evidence)` — is idempotent, and does **not** touch `status` or `last_trained`: it is
arithmetic, not a training run. It spawns nothing and spends nothing.

`create` writes `.tldrx/experts/<name>/{expert.md,competencies.yml}` at status `created` with
one area per flag given, at level 0, and **refuses to overwrite** an existing expert (exit 1).
