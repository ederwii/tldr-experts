# 3 — Runs and gates

## Opening a run

```bash
tldrx run new payments --scope feature --budget 25
```

A run is `tldrx-work/<yymmdd>-<slug>/`, seeded from `workflows/<scope>.yml` plus each
`stages/<id>/stage.yml`: `run.yml`, `budget.yml`, `events.jsonl` and the phase folders.
Per-phase ceilings are proportional to the stages' `budget_usd`, scaled to `--budget` (or
the preset's `default_budget_usd`). Writes go to a temp dir and are renamed, so a
validation failure leaves nothing behind.

The 13 scopes on disk (`--scope <s>`, default `feature`):

`bugfix` `docs` `feature` `hotfix` `integration` `migration` `performance` `prototype`
`refactor` `retro` `security-patch` `spike` `upgrade`

A workspace's own `.tldrx/workflows/` wins over the shipped defaults, so this list is the
file stems `tldrx run new --help` prints on **your** machine.

## Running it

```bash
tldrx next            # run the next stage; it stops at a gate or a question
tldrx run status      # where it is, what it is waiting on, what it cost
tldrx approve         # re-runs the stage's checks off disk, then advances the cursor
tldrx reject --note "…"   # send it back with a reason the next attempt will read
tldrx retro           # close the run and keep what was learned
```

`tldrx next` takes the `.lock`, resolves the cursor, honours `awaiting_gate` /
`awaiting_answer`, evaluates `skip_if`, refuses a stage the phase budget cannot cover,
checks required inputs exist, assembles the prompt, spawns one sub-agent, then re-reads
every declared output **off disk**, re-runs the stage's `checks`, rolls the cost into
`run.yml` + `budget.yml`, and either requests the gate (exit `4`) or advances the cursor
(exit `0`). A failure is exit `5`, and the cost is recorded, never refunded. Run it again
on a `failed` stage and it **retries that stage** — a failure never advances the cursor.

`tldrx approve` re-runs the stage's checks against what is on disk: `claim-sources` and
`schema` through the validators, `cmd` for real — and only a command `workspace.yml`
declares verbatim. Exit `2` names the failing check otherwise.

`tldrx reject --note` records the note on the gate and sends the stage back to `ready`. It
is valid on a stage that is `awaiting_gate` **or** `failed`. The note reaches the next
attempt: `next` renders it, with the previous failure, under `## Previous attempt` in the
prompt, and inlines the declared outputs that exist so attempt 2 edits rather than restarts.

## The loop, without you

```bash
tldrx run auto --max-usd 12 --until watch
```

```
01-what/what … done $1.21 · auto-approved
02-how/how … done $2.60 · awaiting human gate
```

`run auto` calls `next` over and over until a human gate or an open question (`4`), a
failure (`5`), a budget refusal (`2`), `--until <stage>` reached, or the run finished (`0`).
It holds no state — every iteration re-reads `run.yml`, so killing it leaves a run
`tldrx next` picks up unchanged. `--max-usd` is a ceiling on the LOOP's total spend on top
of every stage's own, checked **between** stages, so it can overshoot by at most one stage's
share. `--until <stage>` stops **before** running that stage. Headless only: inside a Claude
Code session `/tldrx` stays one stage per call.

`--gate-agent` changes what the loop prints where it stops: a **decision card** (below)
instead of the ordinary status block. It changes nothing else — in particular it does not
upgrade any stage to `gates_policy: agent`, which is frozen at `run new`.

## A scope that skips Plan

`docs`, `hotfix`, `performance`, `prototype` and `security-patch` do not run the Plan phase
— they say so, in their workflow's `skips:` — and they still reach Build. When they do,
Build writes the one story that decision implies into `04-build/implicit-plan.yml` and runs
it: title from the run, goal from your What handoff's **Decisions** bullets, acceptance from
`01-what/success-metrics.md`, touched files from the paths that handoff actually cites, and
a Definition of Done built only from commands your `workspace.yml` declares (`docs` uses
your `lint`; `spike` and `prototype` use nothing; the rest use `build` and `test`).

```
implicit plan: Plan skipped by scope 'docs' — one story S1 (6 acceptance, 6 touched path(s), dod: dotnet format --verify-no-changes)
```

If you have answered questions on this run, those answers are the work: each fact
becomes an `Apply <the answer> to the touched files` goal — quoting your WHOLE answer out
of `01-what/questions.md`, which is inlined into the developer's prompt and cited by line —
and the acceptance gains a check that every document one of your answers settles no longer
reads `Status: proposed`. **A document your answer settles is added to `touches` even when
the What never cited it**, so the story is allowed to edit the ADR it was opened to settle;
`notes:` says `added <path> to touches: settled by F<n>`. With answers on record the goal is
nothing but that work, and the What's Decisions move to a `context:` list the prompt labels
background — before this, a run opened to settle six decisions handed its developer "Out of
scope: selecting an answer on the owner's behalf" as its stated goal. Bullets whose subject
is the What stage's own work — anything naming `questions.md`, an `01-what/` path or a
question id — are dropped, and the story's `notes:` says which ones and why, so you can put
one back if the filter got it wrong. Where an answer cannot be matched to a file by its ADR
id, the story says that too instead of guessing.

Changed your mind, or answered another question, after the bundle was written? `tldrx next
--prepare --discard-pending` throws the bundle away **and derives the plan again** from the
handoff and the answers as they stand now, reusing this run's epic branch and worktree. It
refuses to rewind a plan something has already been built off — recorded evidence, or a
commit on the story branch — and tells you which.

`tldrx run status` says `plan: implicit (scope skips Plan)`, so you can always tell a
synthesised plan from one you read and approved. Nothing else about the phase changes: the
story gets its own worktree and branch, the DoD is re-run for real, the reviewer is
read-only, and the epic branch waits for you. If you would rather plan it yourself, write
`03-plan/` — a real plan always wins over the implicit one.

## Building a wave's stories at once

```bash
tldrx next --parallel 3          # or: tldrx run auto --parallel 3
```

A wave's stories are independent — `waves.yml` puts every dependency in an earlier
wave — so they can run at the same time. `--parallel N` runs up to N of them
concurrently, each in its own worktree on its own branch, and the live view gives
each one its own column:

```
⠹ 0m42s S1 reading src/checkout/Cart.cs · S2 $ dotnet test    · $1.80/$9.00
```

What does **not** change: merges into the epic happen in the order `waves.yml`
lists, after every story of the wave has finished, so the branch reads the same
whatever order the machine got through them; a conflict still blocks one story and
leaves the epic as it was; each sub-agent keeps its own budget share, so three at
once costs what three in a row cost, sooner. A story that goes red does not cancel
its siblings, but the wave ends `failed` and the next wave does not start — its
stories may need what this one did not land. Ctrl-C kills every running sub-agent,
not just the first.

The default is 1, and at 1 nothing about the build is different from before. Set it
per scope instead of per command with `build: {parallel: 3}` at the top of your
`.tldrx/workflows/<scope>.yml`.

## Who closes a gate

Every stage ends at a gate. What you choose is **who closes it**. Three answers:

| Policy | Closes when | Recorded as |
|---|---|---|
| `human` | you type `tldrx approve` | your name |
| `auto` | seven measured conditions hold | `by: auto` |
| `agent` | those seven, **plus** no budget decision in the stage's window, **plus** an evidence note that signs | the note's `by:`, with `gate.evidence` beside it and `role: agent` on the event |

`human` waits for `tldrx approve`; `auto` lets the harness close it — but only when all seven conditions hold:
the stage's checks pass, its phase has no open question, the spend is inside both the stage
and the phase ceiling, the stage did not fail, the claim-sources validator reports
nothing (zero refused **and** zero unverified), and — on a Build stage — every story in the
plan reached `done` **and** the epic branch changed nothing the run did not declare it would
touch. Any one of them failing falls straight back
to the human gate and says which one and what it measured. The approval is recorded through
the same path a person's is, with `by: auto` and a note carrying all seven values, so
`tldrx run status` and `events.jsonl` read identically either way.

The shipped defaults — every scope keeps at least one human gate:

| Scope | what | how | plan | build | watch |
|---|---|---|---|---|---|
| `feature` `bugfix` `integration` `refactor` | human | auto | human | auto | human |
| `performance` | human | auto | — | auto | human |
| `docs` | auto | — | — | human | — |
| `spike` | auto | human | — | — | — |
| `prototype` | auto | auto | — | human | — |
| `upgrade` | auto | — | auto | auto | human |
| `hotfix` | auto | — | — | human | human |
| `security-patch` | auto | auto | — | human | human |
| `migration` | auto | auto | auto | human | human |

No shipped scope uses `agent`: it arrives by choice, never by default. The three sections
below are the reference for it; the end-to-end narrative — how an `agent` gate fits with a run
the framework never spawns on, and what one story's cycle looks like from `--prepare` to signed
gate — is [10 — Unattended mode](10-unattended-mode.md).

Override per run with `tldrx run new … --gates <stage,stage>` — **the list is the human
gates** — or `--gates all` / `--gates none`. An entry may name its policy outright:
`--gates plan:agent,build:agent`. A bare entry still means `human`, so every invocation you
have already typed means what it meant. It is frozen into `run.yml` as `gates_policy:`
at creation, so a run keeps the policy it was opened with even after the workflow file
changes. A `run.yml` from before 0.3.0, or a workflow with no `gates:` block, is `human`
everywhere.

### Moving a frozen policy: `tldrx run gates set`

Frozen is the right default and it is not being taken back. What it left with no door at all
is a run opened BEFORE the `agent` policy existed: it can never use `approve --as-agent`, and
`run.yml` is hand-edit-forbidden, so the only remaining move was to abandon the run and open
a new one. `tldrx run gates set` is that door, and the ONLY sanctioned one:

```
$ tldrx run gates set plan:agent --note "predates the agent policy; the pilot signs with evidence"
```

One stage per invocation (a comma list is refused — a second change would ride along on the
first one's note), the policy named outright (a bare `plan` is refused here even though it
means `human` under `--gates`, because a signature must not rest on a default), and a no-op
is refused rather than recorded. It changes who may CLOSE a gate from then on; gates already
signed are untouched.

**`--note` is required.** The change is human-signed exactly like `story reopen`: it appends
one `gate.policy_changed` event carrying the **actor**, the moment, your **note** and the
old→new value. That event is the entire audit trail for the one gate mutation nobody would
otherwise go looking for, which is why the framework will not record the change without it.

### What an auto gate cannot do

An auto gate is a gate the harness may sign when it can show its work. It is not a claim
that the work is good, and there are exactly five things it cannot do.

**It cannot judge whether a decision was right.** It checks that every claim carries a
citation and that every citation resolves — that `[src: F019]` names a live fact, that
`[src: Q4]` is a question this run really asked, that `graph:api.Hunt` is a node in the
graph, that `absent:` supports a negative claim and not a positive one. It does not read
the design. A perfectly sourced bad idea passes all seven conditions.

**It cannot verify what it cannot reach.** A `doc` citation is never fetched — a gate that
opened a socket would be a different kind of thing — so an https URL nothing in the
workspace already names is `unverified`, and an `unverified` citation stops the gate rather
than closing it. Same for an `absent:` over a file that exists.

**It cannot notice silence, unless it is told to expect noise.** A stage that was told to
write a `questions.md` and wrote one nothing can parse used to satisfy "zero open
questions". Now it does not. But a stage that was never asked to ask anything, and asks
nothing, is still silent by right.

**It cannot decide that unfinished work is worth shipping.** A Build stage whose stories are
not all `done` falls to a human, naming the stories and their statuses. You may well approve
it anyway — half an epic is often the right thing to merge — but that is a judgement about
your project, and the harness has no basis for making it for you. Before 2026-08-30 it made
it silently: a build with six of seven stories blocked and one story's work on the epic
branch was auto-approved, twice.

**It cannot widen the scope.** The `boundary` condition compares what actually landed on the
epic branch — `git diff --name-only <default_branch>...<epic_branch>` — against the surface
the run declared: every `file:` citation in `01-what/handoff.md` and `02-how/handoff.md`,
plus every `touches:` entry in the plan (a directory entry covers everything beneath it).
A `file:` citation that named no repo widens **every** repo's surface, deliberately: a
handoff that cited `src/Auth/Otp.cs` without saying which repo did not thereby scope one.
A changed path outside that surface refuses the gate and is **named**, up to eight of them
before `+N more`. Work nobody scoped may well be the right work — a module story that had to
change a Platform file usually is — but widening a boundary is a decision, and it is yours.
Approve over it and the reason lives in your note.

It never refuses on an absence: no epic branch cut yet, no repo on disk, no plan, or a run
whose What cited no repo path at all each read as `n/a` with the reason spelled out, because
a condition that could not measure must not pretend it measured zero. `tldrx-work/`,
`.tldrx/` and `.agent/` paths are excluded from both sides — the framework's own state is
never a boundary question.

So: keep at least one human gate per scope (the table above does), read the note — it
records all seven conditions with their measured values — and when the machine signs
something it should not have, take it back.

### Writing down the check an agent made

An auto gate signs with seven measured conditions and no words. A person signs with
`--note "<whatever they typed>"`, which nothing validates and `replay` cannot render. There
is a third thing an agent can do — check something, **show its work**, and be accountable
for the check — and it needs somewhere to put the work.

That place is the **evidence note**, `.agent/<stage>/evidence.md` (spec §2.17). Write the
blank form with:

```
$ tldrx gate template
wrote tldrx-work/260830-tenancy/.agent/plan/evidence.md

Front matter: `gate`, `at`, `citations.of` (34) and `touches.audited` (13) are filled from
disk. `verdict` and `diff_vs_stories` are blank and must be answered.
…
```

The command fills only what a tool can COUNT — which gate, when, how many citations exist in
this stage's outputs, how many touched paths the plan declares — and leaves every judgement
blank. It writes no citations of its own, and what it writes deliberately does **not**
validate. A template that parsed clean out of the box would be a signature nobody had to
earn.

What you fill in is four sections — `Read`, `Citations checked`, `Touches audited`,
`Verdict` — and **every bullet in them ends with a `[src: …]` token that resolves**, checked
by the same validator `claim-sources` runs on a handoff. A checklist whose own claims are
unsourced is the thing that rule exists to refuse, and an evidence note is a claim about a
claim. One rule is stricter here than on a handoff: a citation nothing could **check** —
an https URL the workspace never names, an `absent:` over a file that exists — refuses the
note outright, because a gate closed by an agent has to be stronger than one closed by the
harness, never cheaper.

Three verdicts, not two: `sign`, `sign-with-fixlist`, `refuse`. Only `sign` could ever close
a gate; the other two are the note saying a person decides. That is not a hedge — a reviewer
can meet every acceptance criterion and still have found three real defects nobody wrote a
criterion for, and binary SIGN/REFUSE has nowhere to put those.

`tldrx gate template` itself spends nothing, spawns nothing, approves nothing and moves no
cursor. Signing with the note is the next section.

### Signing with it: `gates_policy: agent`

Open the run with the gate you want an agent to close:

```
$ tldrx run new tenancy --scope feature --gates plan:agent
```

Then the agent writes `.agent/plan/evidence.md` and either the framework closes the gate on
the next `tldrx next`, or the agent signs by hand:

```
$ tldrx approve --as-agent
approved 03-plan/plan (claim-sources:passed)
  signed by fable (agent) — evidence → 03-plan/gate-evidence/plan.md
cursor → 04-build/build (ready)
```

Both doors record the same thing — they differ only in what `gate.note` says, because
`tldrx next` has the seven measured conditions to hand and `approve --as-agent` does not, so
the first writes `agent-gate: <seven conditions>; evidence=…` and the second writes
`agent-gate: evidence=…`. The checks are re-run off disk. The note is **copied into the
run tree** at `<phase>/gate-evidence/<stage>.md`, which is committed — a gate whose evidence
lives only in a gitignored directory is a gate nobody can audit from a clone. `gate.by`
records the note's `by:`, `gate.evidence` records its counts and the path, and one ordinary
`gate.approved` is appended. `tldrx replay` then renders the check itself:

```
- 03-plan/plan SIGN by fable (agent) — read 9 files, spot-checked 7 of 34 citations (7 resolved),
  audited 13 touched paths (0 outside the surface), diff vs stories: matches
  → 03-plan/gate-evidence/plan.md
```

### What an agent gate cannot do

Everything an auto gate cannot do, because it runs every one of those conditions unchanged —
plus two more it deliberately refuses:

**It cannot sign after somebody moved the money.** A `budget.raised` or a `budget.blocked` in
`events.jsonl` since the stage started falls the gate to a person, even when the spend is
comfortably under the ceiling. Condition 3 compares numbers; what it cannot see is that a
person *raised* the ceiling to let this stage through, and a decision made to unblock a stage
may not then be signed off by the machine that was blocked.

**It cannot sign over its own doubt.** `verdict: refuse` and `verdict: sign-with-fixlist`
fall to a person, by design. A reviewer that met every acceptance criterion and still found
three real defects has done its job; the gate is where that lands on somebody who can decide.

`tldrx next` exits `4` for any of these and names each reason with its own label —
`questions`, `budget-event`, `boundary`, `refusal` for the four that are decisions, and
`condition` or `evidence` for a condition that went red or a note that is missing or broken.
`tldrx approve --as-agent` splits the same two apart by exit code: **2** is "this note is
broken, fix the file", **4** is "a person decides". It is refused outright (exit 1) on a
stage whose policy is not `agent` — a run keeps the policy it was opened with, and a flag
that could upgrade one at approve time would make the frozen policy decorative.

And you can always overrule it. `tldrx approve` with no flag on an agent-gated stage works
exactly as it does anywhere else, is recorded as you, and carries no `evidence` key: an
agent gate is one an agent MAY close, never one a person may not.

### Decision cards — what the interrupt looks like

When a run stops for a person, the useful thing to hand over is the **decision**, not a
dashboard. `tldrx run auto --gate-agent` prints a card:

```
$ tldrx run auto --gate-agent 260830-tenancy
01-what/what … awaiting answers: 2 open question(s) in 01-what/questions.md (Q1, Q2)
DECISION — 260830-tenancy · 01-what/what
Q1 · Should hunts a player abandoned count toward the leaderboard?
  Why asked: no rule for abandoned hunts exists in memory [src: absent:.tldrx/memory/facts.yml]
  A) count them — simplest, but rewards quitting early
  B) drop them — matches how players talk about their score
  C) other — write it below
  tldrx answer Q1 "…" --run 260830-tenancy

Q2 · Should an existing customer's tenant be inferred or asked for?
  Why asked: no tenant column on the customer aggregate [src: absent:api:src/Places/Place.cs]
  A) infer from the invoice email domain — no new UI, wrong for resellers
  B) ask once at first login — one screen, correct for everyone
  C) other — write it below
Recommends B — one screen, correct for everyone [src: 01-what/handoff.md:22]
  tldrx answer Q2 "…" --run 260830-tenancy
```

It is a **pure rendering** of things that already exist. The question, its `Why asked:` line
and its lettered options come out of `questions.md` through the §2.7 parser — the questions
grammar is not changed by any of this, and a block the parser cannot read does not appear on
a card any more than it appears anywhere else. The `Recommends` line comes out of the
evidence note's optional `recommend:` array:

```yaml
recommend:
  - {q: Q2, option: "B", why: "one screen, correct for everyone", src: "01-what/handoff.md:22"}
```

**A question with no recommendation gets no line.** The value of that line is that an agent
stood behind it with a citation; a manufactured one is worse than none. Q1 above had none.

The same card shows up in three places, from one renderer — but **where it sits differs**:

| Where | When | Placement |
|---|---|---|
| `tldrx run auto --gate-agent` | the loop stops for a person | **replaces** the ordinary stop block |
| `tldrx next`, on an agent gate | a question, a boundary or a budget event fell the gate through | **appended** below `gate pending: tldrx approve`, after a blank line, so nothing that reads those lines loses a byte |
| `tldrx status` | a run is waiting on answers | in place of `open questions: Q1, Q2` |

There are four card kinds and they are chosen in this order — `questions`, then `boundary`,
then `budget`, then a plain `gate` card for anything else. The last three carry a headline, the
measured fact, and the commands that settle them:

```
DECISION — 260830-tenancy · 04-build/build
Boundary — the epic changed paths nobody scoped
  13 changed path(s), 2 outside the surface: api:src/Billing/Invoice.cs, api:src/Billing/Ledger.cs
  widen the scope: add the path to a story's `touches:`, or cite it in a handoff, then re-run the stage
  tldrx approve --run 260830-tenancy
  tldrx reject --run 260830-tenancy --note "<why>"
```

```
DECISION — 260830-tenancy · 04-build/build
Budget — a person moved the ceiling while this stage ran
  $6.20 spent of $8.00
  1 budget event(s) in this stage's window (budget.raised at 2026-08-30T21:04:11Z) — a ceiling a
  person moved to let this stage through is not a ceiling the machine that was blocked may then
  sign off against
  tldrx budget show --run 260830-tenancy
  tldrx approve --run 260830-tenancy
  tldrx reject --run 260830-tenancy --note "<why>"
```

The `gate` card is the fallback: `Gate — N reason(s) an agent gate could not close this`, one
`<trigger>: <detail>` line each, then approve and reject.

`tldrx answer`, `questions.md`, the live dashboard and every exit code are unchanged —
`--gate-agent` is rendering, and it never upgrades a stage to `gates_policy: agent`, which is
frozen at `run new`. To actually move it on an open run, see
[Moving a frozen policy](#moving-a-frozen-policy-tldrx-run-gates-set).

### Taking an approval back

```
$ tldrx reject --stage 02-how/contracts --note "the handoff cites facts that do not exist"
REVOKED 02-how/contracts — it had been auto-approved by the facilitator at 2026-08-29T14:31:40Z
```

`--stage <phase>/<stage>` revokes an approval already given, whoever signed it: the cursor
moves back to that stage, one `gate.revoked` is appended carrying `signed_by`, and later
stages that had run are marked `stale: true` — their files stay on disk, they stop counting
as current. Nothing is deleted and no cost is refunded. It is the one verb that may reopen
a FINISHED run. `tldrx status` names every gate signed `by: auto` and the status line
carries `att` / `auto:N` / `stale:N`, in that order and only when each is true.

### Giving one story another go

```
$ tldrx story reopen S3 --note "it gates wave 3 (S4, S6) and the owner has decided it ships"
reopened S3 in 260830-tenancy-identity-customers — `blocked` → `todo` (W2)
```

`reject --stage` works on a STAGE. Sometimes what you disagree with is one story. A story
that a reviewer refused twice is `blocked`, which is terminal for the rest of the run — and
that is usually right, but not when the story gates a whole wave and you have decided it
ships anyway. `tldrx story reopen <id> --note "<why>"` is the sanctioned way to say so; the
files are the state, and hand-editing `run.yml` or `03-plan/stories/<id>.md` is not a move
the framework supports.

The note is **required** — a reopen with no reason is not actionable — and one
`story.reopened` is appended carrying who signed it, the note, the status the story came
from, and how many verdicts the run of attempts you are closing consumed. The story goes
back to `todo` and **its attempt counter restarts at 1 of 2**. Nothing is erased to make
that true: the reopen event is a boundary the review ledger reads, so the old verdicts stop
counting while staying in `events.jsonl` for `replay`, `cost` and `retro`. When the story
runs again the Build stage says so in one line, with your note.

It runs no agent, spends nothing, deletes nothing and refunds nothing. The story's *branch*
carries the last developer's commits forward and is untouched, so the next turn starts on
top of them.

It does **not** send the stage back — that is `reject`'s own signed decision, and one verb
quietly performing another's is how a gate stops meaning anything. The output names the
command that fits: `tldrx next` when the Build stage is ready, `tldrx reject --note "…"`
when it is sitting at a gate, `tldrx reject --stage 04-build/build --note "…"` when that
gate is already signed.

It refuses (exit `2`) an id the plan does not have, naming the ones it does; a `done` story,
because undoing finished work is a decision about the stage and belongs to `reject --stage`;
a `todo` story, which is already pending; and a missing `--note`.

## Several runs open at once

When there is exactly one open run, nothing changes. When there are several, every
run-targeting command — `next`, `answer`, `approve`, `reject`, `budget`, `interview --run`,
`tickets`, `watch`, `retro`, `replay` — **refuses rather than guessing**, exits `2`, and
lists the open runs:

```
tldrx next: 3 runs are open — pass one:
```

Exit `2` there means "you left off the id", not "it broke". Pass one: a positional `<run>`
on `next`, `run status`, `cost`, `replay` and `retro`; `--run <id>` on the rest.
`tldrx run status` with several open prints a table of them all and exits `0` — `--json`
returns `{ "runs": [...] }`, and the single-run shape is unchanged when exactly one is open
— and `tldrx run new` says so when it opens another. `tldrx dashboard` is not on that list
and never was: it draws every run in the workspace, so it has no single run to be ambiguous
about. Hooks never block on the ambiguity, and the status line appends `(+N open)`.

Runs are also **dependency-aware**: a run created by `tldrx seed apply` records
`triage.depends_on`, and a run whose dependency is not `done` shows `blocked by <slug>` and
is offered no command. The first runnable one is marked `← next`.

## Getting a stuck run moving

```bash
tldrx run unlock [<run>] [--force]
tldrx run cancel [<run>] --note "<why>" [--force]
```

**`unlock`** removes a `.lock` whose pid is dead, demotes any `running` stage back to
`ready` and appends `run.unlocked` — a recycled pid used to make a lock permanent, because
`kill(pid, 0)` said alive forever. A LIVE holder needs `--force`; without it, exit `2`
naming the pid. With no lock at all it exits `0` and points at the real problem (an
uncommitted `--prepare` bundle is not a lock).

**`cancel`** closes a run for good: every non-terminal stage becomes `cancelled`, the
decision is recorded on the run itself (`cancelled: {by, at, note}`) and `run.cancelled` is
appended — which is what lets a FAILED run be closed without overwriting the failure on its
stages. Refuses while a live lock holds the run unless `--force`. Nothing is deleted —
`tldrx replay <id>` still reads the whole thing — and a cancelled run is finished, so
`tldrx status` and every id-less command stop seeing it.

## Where else a run shows up

### The live dashboard

```bash
tldrx dashboard --open              # http://127.0.0.1:4477, live
tldrx dashboard --static --out ./public   # one self-contained page, no server
```

A read-only local server on `127.0.0.1`: `GET /` is the page, `GET /model.json` is the
model it was drawn from ([`docs/dashboard-model.md`](../dashboard-model.md)), `GET /events`
is a Server-Sent Events stream. A recursive watcher over `.tldrx/**` and `tldrx-work/**`
pushes a `reload`; the page re-fetches the model and redraws, keeping scroll position and
any open handoff panel. Five views behind a hash route — runs list, run detail, experts,
watchers, how-to. `node:http` + `node:fs` only; no framework, no runtime dependency; it
never writes and answers nothing but GET.

A request whose `Host` is not `127.0.0.1`, `localhost`, `::1` or the host it was told to
bind gets 403 before the method check — binding loopback is necessary, not sufficient, when
a page on a name the attacker owns can point a browser at 127.0.0.1. Only the name is
compared, never the port, so `ssh -L` and container port maps keep working.

**It never disagrees with the CLI about what a run needs.** `runs[].waiting` is
`tldrx run status`'s own `{kind, message, questions}`, from the one derivation both call
(`src/core/run/waiting.ts`), and `dependsOn` / `blockedBy` / `runnable` come from the same
resolver `tldrx status` uses (`src/core/run/dependencies.ts`).

### The ticket mirror

Optional, off by default, and separate from the loop: `tldrx tickets sync` pushes every epic
and story in `03-plan/` out to Jira or GitHub as an issue. It is a command a human runs — it
appears in no stage, and `tldrx next` never calls it, so the loop cannot come to depend on a
tracker being reachable.

Two guard-rails, and the whole design is downstream of them:

1. **Files are the source of truth.** The mirror pushes epics and stories *out*; the only
   thing that comes back *in* is each issue's own status string, written to
   `external_status:`. It never advances `run.yml` — the run is opened read-only.
2. **Filing a ticket is never "done".** The mirror may write exactly two front-matter keys,
   `external:` and `external_status:`. Attempting to move a story's `status:` line
   **throws**, so `external_status: Done` beside `status: todo` is a legal state and stays
   one. Only the DoD hook marks a story done.

```bash
tldrx tickets sync               # the plan, and zero calls to anything (preview is the default)
tldrx tickets sync --apply       # create-or-update; re-running creates nothing
tldrx tickets status             # local status beside external_status, changes nothing
```

Configured in `.tldrx/process.yml` (`ticket_tool: {kind, project, sync}`); `none`, or no
`process.yml`, exits `0` with "adapter disabled". GitHub goes through the `gh` CLI, so no
token is ever handled here; Jira needs `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, and
a missing one is exit `1` naming all three before anything is written.

### The narrative

`tldrx replay [<run>]` renders `events.jsonl` over the `run.yml` execution path as a
stakeholder narrative: header, then per phase and stage in event order — start/end,
questions asked and answered with who, gate approvals and rejections with their notes,
failed checks, budget warnings, cost against ceiling — ending with "Where it stands now".
Writes nothing.

`tldrx retro [<run>] [--apply]` writes `tldrx-work/<run>/retro.md`: **Facts to remember**,
**Practice proposals** (five deterministic heuristics over the log, each bullet ending in
`[src: tldrx-work/<run>/events.jsonl:<line>]`) and **Proposed stages**. No model runs.
`--apply` appends the proposals to `.tldrx/memory/practices.md` under a dated, run-stamped
heading, idempotently.
