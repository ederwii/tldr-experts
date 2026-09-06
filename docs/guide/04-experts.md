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

## Stack packs

A `<language>-stack` expert is seeded as a name-only stub: until you train it, the language
name is the only stack-specific token in its body. **Stack packs** give it a shipped body
instead — off by default, one switch per project:

```bash
tldrx expert packs enable
tldrx expert packs status
tldrx expert packs disable
```

### What a pack says, and what it refuses to say

A pack has two sections and nothing else. **`## Defaults (when the repo is silent)`** apply
only where the repo has no signal on the topic, and every bullet names the signal that
overrides it — `— overridden by: the compilerOptions block in the repo's tsconfig`.
**`## Checks (always asked in review)`** are questions asked of every diff, each with a
`verify:` hint naming what to open or run; a miss is a finding with a cited file, and the
project's own convention is the accepted answer whenever it has one.

That shape is the design decision, not a style choice. **Measured repo conventions win over
pack content, always** — a pack that argued with the repo it is installed in would be worse
than no pack at all. So the packs are interrogative by default and prescriptive only in the
gaps: they ask, and they yield to any signal.

### Two layers

The **language pack** becomes the expert's body. Four ship: `typescript`, `javascript`,
`python`, `dotnet`. A stack expert for a language with no pack is untouched and said so —
`no pack ships for go`, not a silent skip.

**Framework overlays** are detected from manifests and from nothing else, never inferred from
the language: two .NET workspaces can use opposite architectures, and one prescriptive
".NET pack" would be wrong for one of them. Thirteen rules ship, each firing on a named signal
and recording the evidence a reader can go open:

| overlay | fires on |
|---|---|
| `react` | `react` in package.json `dependencies` or `devDependencies` |
| `next-app-router` | `next` declared **and** an `app/` or `src/app/` directory present |
| `vite-react-spa` | `vite` and `react` declared, and `next` not |
| `expo-router` | `expo-router` or `expo` declared |
| `node-express` | `express` declared |
| `prisma` | `prisma` or `@prisma/client` declared |
| `aspnet-minimal-apis` | a `Microsoft.NET.Sdk.Web` csproj with **no** `Controllers/` beside it |
| `aspnet-controllers` | a `Microsoft.NET.Sdk.Web` csproj **with** a `Controllers/` directory beside it |
| `mediatr-cqrs` | `MediatR` in any `PackageReference` / `PackageVersion` |
| `efcore-npgsql` | a `Microsoft.EntityFrameworkCore*` package **and** an `Npgsql*` one |
| `fastapi` | `fastapi` in pyproject's `[project] dependencies` or in a `requirements*.txt` |
| `sqlalchemy-alembic` | `sqlalchemy` declared — whether `alembic` is there too is noted in the evidence |
| `postgres-testcontainers` | a Postgres driver **and** a Testcontainers package, in any of the three ecosystems |

`src/core/detect/overlays.ts` is the one list of those ids in the tree, and the template files
mirror it one-to-one. A manifest that says nothing produces no overlay: unknown is never a guess.

### Where the files are

Templates ship inside the package, at `templates/experts/stack/<lang>.md` and
`templates/experts/stack/overlays/<id>.md`. With the switch on, `enable` — and every later
`tldrx init` — materialises them:

```
.tldrx/experts/typescript-stack/
  expert.md               front matter preserved, the pack body under it
  overlays/react.md       framework-managed: emptied and rewritten on every enable and re-init
  overlays/prisma.md
  knowledge/              never touched by any packs command
```

Detected overlays are written into `workspace.yml` with their evidence **whether or not the
switch is on** — detection is a measurement, and the switch governs only whether the files get
written. `stack_packs: {enabled, enabled_at}` is read out of the file being regenerated and
carried forward, so a re-init never quietly turns your packs off.

### The body is yours

`enable` replaces `expert.md`'s body only when there is nothing of yours in it: the untouched
stub `init` seeded, an empty body, or a pack body it wrote itself that is now one shipment behind
(the upgrade path, below). An edited body is kept, and the command says which —
`kept: typescript-stack body was edited — pack body not applied (delete the body to re-seed)`.

A materialised body records two additive front-matter keys: `pack: <lang>@<hash>` names the
shipment it came from and `pack_body: <sha>` names the bytes. Keeping those apart is what makes
"somebody edited this" (bytes differ) a different answer from "this is one shipment behind"
(bytes match, shipment differs). The second one `enable` upgrades and says so —
`upgraded: typescript-stack pack@<old> → pack@<new>` — and `status` names the state rather than
rounding it off: `body pack@<old> (stale — shipment is pack@<new>)`. Comparing a body against
today's template alone would have called every untouched file *edited* the first time a template
changed, and frozen every pack at the shipment it was first materialised with.

`disable` removes the `overlays/` folders and nothing else. Bodies stay, `knowledge/` stays, and
the command says so on its way out.

### Where a pack lands in a prompt

Every renderer already prints an expert's body, so one composition point reaches every stage
prompt and the Build developer: `expert.md` first, then each overlay behind a
`<!-- overlay: <id> -->` marker, sorted by id, under a 24 KB cap kept separate from the 48 KB
knowledge budget so pack prose cannot crowd out what training found. An overlay goes in whole or
not at all — the first that does not fit, and every later one, is named in a `(not inlined: …)`
marker instead of being cut in half.

The Build **reviewer** carries no expert bodies at all, so it is handed the active packs' Checks
explicitly, under `## Stack checks (the repo's own conventions win)`. That section needs BOTH
switches on: the packs switch, and the stage's own `stack_experts`. Under `stack_experts: false`
the developer was never shown a stack expert, and holding a diff to Checks that were never in the
brief is grading against a document nobody wrote from.

### Project skills are not part of the switch

A repo's own `.claude/skills/<name>/SKILL.md` files are detected alongside and named to the
developer under `## Project skills` — name, description, and the path to read — **independent of
the packs switch**, because a project's own skills are not pack content: they are the project.
Skills are for doing and packs are for checking. The harness loads and invokes a skill; tldrx
only says it is there.

A skill git does not track is marked `(untracked: not present in story worktrees)`, because Build
runs in a worktree that carries tracked files only, and Build's opening lines warn about each one
by name and by repo. On a Build story the developer turn gets `Skill` among its allowed tools when
that story's repo has skills, and not otherwise. `[unverified]`: whether an agent CLI's print mode
actually DENIES a `Skill` call absent from that list has not been measured — the framework's job
is the list.

### Exit codes

`status` exits `0` always: with no `.tldrx/workspace.yml` it prints the line naming the missing
file and the `tldrx init` that fixes it rather than refusing. `enable` exits `1` when no repo has
a detectable language — there is nothing to enable, and nothing is written — or when the workspace
cannot be read, printing `error: <message>` rather than a stack trace. `disable` is idempotent:
nothing to disable is exit `0` and a named line, and only a `workspace.yml` that exists but is too
broken to read is exit `1`.

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
- **A pass with an empty input is never paid for (#101).** If the sweep selects 0 files, or
  `--mode full` finds no run to mine, that pass is not spawned. When the OTHER pass still has
  real input it is skipped with the reason on stderr and its share goes unspent; when no pass
  survives the run is refused (exit 1) before anything is spawned. Measured before the check
  existed: a training whose domain matched nothing still spawned, spent, and wrote a knowledge
  file about no code.
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
| `outside domain` | the path is outside this expert's own `## Domain` | when the path would match under the other spelling, the **grammar** is named first (repo-relative, no repo prefix); then the expert whose domain *does* contain it — as a better home, not an exclusive one |
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
tldrx expert create <name> [--area <id>] [--title <text>]
                          [--role <slug>] [--domain <slug>] [--stack <lang>]
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

**An expert with no area cannot be trained**, so `create` names the remedy where the gap shows
(#94). `--area <id>` seeds the first area outright; `--title <text>` names it, and the title is
not decoration — light mode greps the words of the area title to decide which files the expert
is shown, so a default title is a search nobody tuned. Every area is also just a block in
`competencies.yml`, and both refusals now print it:

```yaml
areas:
  - id: discoverer
    title: Google Places discovery, candidates and ranking
    level: 0
    train_prompt: tldrx expert train discoverer --area discoverer --mode light
    evidence: []
```

`create` also writes the front matter `repos:` off `.tldrx/workspace.yml` (`repos: []` when
there is no workspace file), because that list is what the `## Domain` bullets below it are
relative to — see the grammar next.

### The `## Domain` grammar

This is read by the tool, not only by a human, and getting it wrong is expensive: measured
2026-09-02, a $2.10 full training earned **zero** evidence because all 13 of its code citations
landed `outside domain`.

- **Every path bullet is repo-RELATIVE**, with no repo prefix: `` - `src/Checkout/` ``.
- **The repos it is relative to are the front matter `repos:`** list.
- **A whole-repo claim is `` - repo `api` ``** — that exact shape, carrying no path. It is
  deliberately not a path, or a repo-wide expert would match every file in the workspace by
  prefix.
- Citations arrive as `repo:path:line`, so `api:src/Checkout/Cart.cs:12` is matched by
  `` `src/Checkout/` `` and **is not matched by** `` `api/src/Checkout/` `` — the second is
  workspace-relative and matches nothing.

`tldrx expert create` writes this grammar into the `## Domain` section of the `expert.md` it
creates, and the `outside domain` warning names it FIRST when the cited path would match under
the other spelling.
