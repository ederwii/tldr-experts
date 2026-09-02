# 10 — Unattended mode

> **`attend` is a lock. `auto` is an engine. They do not compose.**
>
> | | `tldrx run attend host` | `tldrx run auto` |
> |---|---|---|
> | what it is | a LOCK: it sets one field, runs nothing, and the framework never spawns on that run again | an ENGINE: a headless loop in which the FRAMEWORK spawns a metered sub-agent, stage after stage |
> | who executes each turn | your host session, through `tldrx next --prepare` / `--commit` | the framework, until something needs a person — a gate, a question, a failure, a ceiling |
> | with the other one | `tldrx run auto` on it is refused, exit `1` | refused on an attended run, exit `1`, before the event log is opened |
>
> Running a whole run unattended *and* keeping the checking is the first column plus a session you
> have given a **mandate** ([the recipe](#the-mandate)). There is no flag for it: the mandate is a
> prompt you write.

The rest of this guide describes a framework that spawns its own sub-agents and stops when a
person is needed. This chapter describes the other way round: a **host session** — a Claude
Code conversation, or any agent with a tool surface — doing every turn, and the framework
reduced to what it is actually good at. Writing the bundle. Judging the result off disk.
Refusing to sign what it may not sign.

It is one feature made of five parts that arrived together, and they are only worth reading
as one thing.

## The one insight

Everything here follows from a single division:

| The gate may be an **agent** for | The gate must be a **person** for |
|---|---|
| verification — do the citations resolve? | a new product decision |
| the criteria against the tree | raising a budget ceiling |
| the boundary: did the work stay inside what we scoped? | a boundary change — work outside what the What cited |
| question grammar | the final merge to `main` |
| the diff against the stories it claims to implement | |

The framework has always encoded that split *implicitly*: conditions get checked, questions
get asked. Unattended mode makes it **explicit** — a gate policy that names who may sign what,
and a run mode that stops the framework spending money behind a session that is already doing
the work.

## The three switches

They are independent, and each is useful alone. Together they are the mode.

| Switch | Where | What it changes |
|---|---|---|
| `attended_by: host` | `run.yml` | The framework never spawns on this run. Every turn is the host's. |
| `gates_policy: agent` | `run.yml`, per stage | A gate an agent may close, over a written, validated check. |
| `economy: host-tokens` | `budget.yml`, per phase | The ceiling is not dollars, so it may not buy a metered spawn. |

### Turning it on

```bash
tldrx run new tenancy --scope feature --budget 25 \
  --attended-by host --gates plan:agent,build:agent
```

`--gates` names the **human** gates and overrides the workflow's `gates:` wholesale; an entry
may be qualified `<stage>:<policy>`, and a bare entry still means `human`. **Stages you do not
name become `auto`** — the invocation above leaves the run with no human gate at all, which is a
choice, not an accident: name the ones you want to keep. The policy is frozen into `run.yml` at
creation, so a run keeps what it was opened with even after the workflow file changes.

On a run that is already open:

```
$ tldrx run attend host 260830-tenancy
260830-tenancy is attended_by: host — the framework will not spawn on it
  every stage is yours to run: tldrx next --prepare 260830-tenancy, then tldrx next --commit 260830-tenancy
  `tldrx run auto` is refused on this run, and a bare `tldrx next` names the command above
```

`tldrx run attend --none` hands it back. It runs no agent, spends nothing, moves no stage and
touches no branch: it sets one field and appends one `run.attended` event. A direction is
required and never guessed (exit `1`), setting what is already set is a silent no-op, and a
`done` or `cancelled` run is refused (exit `2`).

### The mandate

`attend host` is the lock. What actually runs the run to its last gate is the session on the other
side of the handshake, and what makes that session trustworthy is a **mandate you write in prose**.
There is no keyword and no flag: the framework enforces that it will not spawn, and the mandate is
what tells your session what to do with the run it has just been handed.

The strongest form names all four things a person still owns, so the session knows exactly which
interrupts are legitimate:

```bash
tldrx run new payments --scope feature --budget 25 \
  --attended-by host --gates what:agent,plan:agent,build:agent,watch:agent
```

> Act as my unattended verification gate on run `260101-payments`, until it reaches its last gate.
>
> Drive every stage yourself — `tldrx next --prepare 260101-payments`, then
> `tldrx next --commit 260101-payments` — dispatching your own sub-agents for the turns. The
> framework must never spawn.
>
> For every build story, run an INDEPENDENT adversarial review through the `--review` handshake:
> `tldrx next --prepare --review`, one read-only sub-agent over the diff, then
> `tldrx next --commit --review`. Its job is to find what the developer got wrong, not to agree
> with it.
>
> Approve a gate only after you have checked it yourself — that the citations resolve, that every
> touched path is one this run declared, and that the diff matches the stories it claims to
> implement — and write that check down as evidence: `tldrx gate template`, fill it in, then
> `tldrx approve --as-agent`.
>
> Interrupt me ONLY for a new product decision, a budget-ceiling raise, or work that has to go
> outside the declared boundary. Everything else you decide, and log.
>
> Never push. The final merge is mine.

The four interrupts in that last paragraph are not a style choice — they are the right-hand column
of [The one insight](#the-one-insight), and the framework independently falls through to a person
on the first three whatever the prompt says (`questions`, `budget-event`, `boundary`; see
[The four fallthroughs](#the-four-fallthroughs)). The mandate makes the session agree with the
machine rather than fight it. The fourth, the merge, the framework never does at all: there is no
`git push` wrapper in the Build executor, and the developer prompt says **"Do not push"** in as many
words.

For the third switch, `economy: host-tokens` on a phase, see
[6 — Budgets and cost](06-budgets-and-cost.md). The short version: a ceiling the Plan wrote
assuming host-billed turns is not a number of dollars a spawn may spend, and a headless
`tldrx next` on such a phase is refused at exit `2` before a cent is spent.

### What "never spawns" actually means

Three layers, because "nothing spawns" is a promise about money and one `if` is not a promise:

1. `tldrx next` refuses the headless mode at the **top of the stage**, before the budget gate,
   before an input is read, before a prompt is assembled and before an executor is chosen.
2. Each executor exposes prepare/commit only and refuses `mode: headless` with `refused: true`
   — the outcome for "a precondition the operator can fix", not a failure.
3. `spawnAgent` itself throws if any path reaches it, and says in as many words that reaching
   it is a bug.

`--dry-run` is refused with the rest of them — but not because it costs anything. Since
issue #17 it spawns nothing at all: it prices the prompt, prints the command it WOULD run,
and exits. It is refused here because it describes a dispatch the framework never makes on
an attended run; `--prepare` writes the bundle you are actually going to carry.

`tldrx run status` prints `· attended: host` on its scope line, and the status line carries an
`att` marker ahead of `auto:N` and `stale:N`.

## One story, end to end

What follows is a Build stage on a run that is `attended_by: host` with `build:agent`. Every
line shown is the shipped rendering.

### 1 · Ask for the bundle

```
$ tldrx next --prepare 260830-tenancy
```

Before anything is written, the stage's **preconditions** run — the operational facts that
must hold before an attempt is worth spending:

```yaml
# .tldrx/stages/build/stage.yml
preconditions:
  - {id: docker, repo: api, command: "docker compose ps", expect_exit: 0}
```

Each prints a line, green or red:

```
· precondition: docker compose ps → exit 0 (1.2s)
```

Each gets **60 seconds**, not the stage's `timeout_s` — add `timeout_s: <n>` to one that
legitimately needs longer. A precondition is a liveness question; letting a hung `docker info`
borrow a Build stage's 1800 s clock is the half-hour of waste the feature exists to prevent.

A red one stops there, exit `2`, and nothing has been spent:

```
refusing to dispatch 04-build/build — precondition `docker` is red.
  `docker compose ps` in api exited 1 (expected 0) — Cannot connect to the Docker daemon
Fix it and run the same command again: the stage is still `ready` and nothing was spent.
```

Preconditions carry the same allowlist rule as a `cmd` check — only a command **byte-equal**
to one `workspace.yml` declares runs at all, argv-split, never shelled — and a stage naming an
undeclared command is refused when the stage LOADS, so it cannot open a run. They run on
`--prepare` and headless, never on `--commit`: `--commit` settles a turn that already happened.

`--prepare` also fast-forwards a story branch that has fallen behind its epic, because a
dispatch onto a stale base would not compile:

```
  · S3: fast-forwarded `story/260830-tenancy/S3` to `epic/tenancy` — 2 commit(s), b5a2474 → ae9c8dd
```

Only the two openings that put a **developer** on the branch move anything. A diverged branch
is warned about and left alone; so is a dirty worktree. It is `git merge --ff-only`, never a
rebase. See [9 — Troubleshooting](09-troubleshooting.md) for all four outcomes.

### 2 · Add what the bundle cannot know

The prompt is assembled from files. Some of what a turn needs is not in any of them: a caveat
the owner gave in chat, a seed doc that did not inline, "the staging DB is the old schema".
Write it into the **dispatch-notes slot**:

```
tldrx-work/260830-tenancy/.agent/build/dispatch-notes.md          # the stage's
tldrx-work/260830-tenancy/.agent/build/S5/dispatch-notes.md       # this story's
```

It renders under `## Dispatch notes`, between `## Inputs` and `## Previous attempt` — both
volatile sections, so a per-cycle file never pays the cache-write price of sitting ahead of the
expert blocks. When both files exist the stage's is rendered first. **Every mode reads it**,
not only `--prepare`.

```
dispatch notes: .agent/build/dispatch-notes.md (1,204 B); .agent/build/S5/dispatch-notes.md (612 B)
```

Three things to know:

- **It is context, not configuration.** Nothing in it can change a declared input, an output, a
  check or a cap, and the section says so to the sub-agent.
- **It is capped at 8,192 B**, one budget across both files, spent stage-first, counted against
  `prompt_max_bytes` and shown in the context ledger as `dispatch notes`. Over the cap it is
  cut and the cut is named in the prompt, on stdout and in `pending.json`.
- **It is per-cycle scratch.** It survives `--discard-pending` — it is an input to the
  rendering, not an output of the one being binned — and nothing else. A caveat that must
  outlive this cycle is a **fact**: `tldrx facts add`, which reaches every prompt with
  attribution behind it.

### 3 · The developer turn, and `--commit`

You dispatch one sub-agent with the bundle's `prompt.md`, write `{outputs, questions_asked,
notes}` to `result.json`, and:

```
$ tldrx next --commit 260830-tenancy
```

The framework picks the story's pipeline up at the DoD step: it re-runs the definition of done
in the story's own worktree, commits, and merges into the epic. Then — because this run is
attended — it does **not** spawn a reviewer. It writes the reviewer's bundle and stops:

```
  · S5 merged into `epic/tenancy` ($0.00 so far) — its review is the host's
prepared the REVIEW of S5 — tldrx-work/260830-tenancy/.agent/build/S5/review/prompt.md (read-only, nothing spawned)
dispatch ONE read-only sub-agent with cwd api-worktrees/S5
then write {verdict, summary, findings} to tldrx-work/260830-tenancy/.agent/build/S5/review/result.json and run `tldrx next --commit --review`
```

Without `attended_by: host` this is the point where the framework spends $0.26 on a reader
beside a session that is already reading the diff. That is the redundant economy the mode
removes.

A bare `tldrx next` here tells you exactly which half is outstanding:

```
260830-tenancy is attended_by: host — the framework does not spawn on this run.
  04-build/build has a REVIEW bundle out and is waiting for its verdict: tldrx next --commit --review 260830-tenancy
  (to hand the whole run back to the framework: tldrx run attend --none 260830-tenancy)
```

Exit `4`, not `2` — the run is not refusing the work, it is waiting on you, which is the same
shape as waiting at a gate.

### 4 · The review is a turn too

The reviewer is the second delegable role, on the same handshake one directory down —
`.agent/<stage>/<story>/review/`, nested so a reviewer bundle can never be read as a developer
one. `tldrx next --prepare --review` writes it on demand, and a bare `--prepare` writes it by
itself whenever a story is waiting on a review:

```
prepared the REVIEW of S5 · OTP confirm — tldrx-work/260830-tenancy/.agent/build/S5/review/prompt.md (read-only, attempt 1 of 2)
dispatch ONE read-only sub-agent with cwd api-worktrees/S5
then write {verdict, summary, findings} to tldrx-work/260830-tenancy/.agent/build/S5/review/result.json and run `tldrx next --commit --review`
```

The bundle hands you the reviewer's `prompt.md` (the same one a spawn would get, from the same
renderer), the diff command and the merged commit, the DoD results the framework already re-ran
— do not re-run them — and `result_schema`, the exact envelope your sub-agent must return.

`--commit --review` reads that `result.json` through the same fail-closed parser a spawned
verdict goes through: an envelope it cannot read is `changes`, **never** `approve`. The turn is
recorded `cost_usd: null, metered: false` unless the envelope declares a cost, the review event
carries `source: host`, and **no `agent.spawned` is emitted** — a `task.started` with
`role: reviewer, mode: prepare` is.

```
S5 → `done` (host review, unmetered)
```

A review you never write costs the story no attempt at all.

`--review` is a modifier on the in-session handshake. Used headless it is a usage error, and
says so.

### 5 · When you would sign and still have findings

A reviewer can meet every acceptance criterion and still find three real defects nobody wrote a
criterion for. `approve` throws them away; `changes` spends the story's one requeue on a diff
nobody faulted. The third verdict is **`fixlist`**:

```json
{"verdict": "fixlist",
 "summary": "signed — every criterion is met, and three defects the criteria never covered",
 "findings": [],
 "fixlist": [
   {"n": 1, "severity": "high", "finding": "Concurrent double-confirm mints two sessions",
    "where": "`src/Auth/ConfirmOtp.cs:74` [src: api:src/Auth/ConfirmOtp.cs:74]",
    "disposition": "fix-now",
    "do_not": ["add a lockout policy; that is a product decision (see 3)"]},
   {"n": 3, "severity": "medium", "finding": "No OTP attempt limiter",
    "disposition": "defer-with-log", "detail": "A lockout policy is a product call."}]}
```

```
  · S5: fix list written — 04-build/fixlist/S5-1.md (1 to fix now; this round spent no attempt)
```

The four dispositions are `fix-now`, `defer-with-log`, `refuted` and `out-of-scope`, and each is
a decision somebody made rather than a fact about the code. **`refuted` must carry an
`[src: …]`** that parses, in its `where` or its `detail` — a reviewer's verdict is a claim like
every other one, and a refutation carries its evidence or it is not one. A fix list with an
uncited `refuted` is refused whole and the verdict falls to `changes`.

The file is the state. Each finding is a
`## <n> · <finding>␣␣[<severity>]` section (two spaces before the bracket) carrying `Where:`,
`Disposition: **<value>**` and `Resolved: no`. **Keep the disposition bolded** when you edit it:
that is how the file is read back, and a line without the asterisks drops its finding rather
than half-reading it.

Routing it back to the author:

```
$ tldrx next --prepare 260830-tenancy
  · S5: routing 04-build/fixlist/S5-1.md back to the author — 1 of 2 finding(s) still `fix-now`; this round spent no attempt
  · S5: the prior author's session was `019gpPtE…` — resume it if your tooling can; the framework resumes nothing itself
  · S5: close each finding in 04-build/fixlist/S5-1.md as it lands (`Resolved: yes`) or re-route its `Disposition:` — an open `fix-now` blocks `done`
```

The open findings land under `## Fix list` in the developer prompt with their `Do NOT` lines
verbatim, and `pending.json` gains `fixlist: {path, round, findings, open}` plus
`resume_session`. Both keys appear only on a fix-list round. `--fixlist <path>` names a
different file and refuses one that is not this story's.

Four rules bound it:

- **It spends no attempt.** The diff was not faulted, so no second developer turn is owed.
- **There is exactly one round per story.** A second `fixlist` is refused out loud and read as
  `changes`, which costs the attempt the first one did not — and the second reviewer's prompt
  withdraws the verdict rather than offering one that would be refused. `tldrx story reopen`
  resets the count, like every other count in the review ledger.
- **A story cannot reach `done` with an open `fix-now`.** It settles `blocked` and the reason
  names the file, the finding's number and its heading.
- **`defer-with-log` findings reach the owner** through `retro.md`'s `## Build feedback` — the
  existing second writer with its existing dedup, not a new channel.

A `fixlist` verdict whose `fixlist[]` is missing, empty or unreadable is `changes`, not a free
round.

### 6 · Write down the check you made

The stage is done and its gate is `agent`. An auto gate signs with seven measured conditions and
no words; a person signs with a free-text `--note` nothing validates. An agent signs with an
**evidence note** — a checklist whose own claims are sourced.

```
$ tldrx gate template
wrote tldrx-work/260830-tenancy/.agent/build/evidence.md
```

It fills what a tool can count or already knows — `version`, `gate`, `role`, `by`, `at`,
`citations.of`, `touches.audited`, empty `caveats` and `recommend` — and leaves `verdict` and
`diff_vs_stories` blank. The blank form deliberately does **not** validate: a template that
parsed clean out of the box would be a signature nobody had to earn. It spends nothing, spawns
nothing, approves nothing and moves no cursor.

```markdown
---
version: 1
gate: 04-build/build
role: agent
by: fable
at: 2026-08-31T22:14:03Z
verdict: sign                 # sign | sign-with-fixlist | refuse
read: ["04-build/log/S5.md", "03-plan/stories/S5.md", "…"]
citations: {sampled: 7, of: 34, resolved: 7, refuted: 0}
touches: {audited: 13, outside_surface: 0, new_areas: ["src/Auth/"]}
diff_vs_stories: matches      # matches | diverges | n-a
caveats: ["read-only mandate — no DoD command was run by this reviewer"]
recommend: []
---

## Read
## Citations checked
## Touches audited
## Verdict
```

Four H2 sections, **in that order**, each with at least one list item, and **every list item
ends in a `[src: …]` token that resolves** — checked by the same §2.8 machinery `claim-sources`
runs on a handoff. One rule is stricter here than on a handoff: a citation nothing could
*check* — an https URL the workspace never names, a `cmd` with no workspace command behind it —
refuses the note outright. A gate closed by an agent has to be stronger than one closed by the
harness, never cheaper. An `absent:` over a path that exists is not one of those: it is `noted`
here as everywhere — named, never fatal — because it is the framework's own spelling of a
negative case.

The note also refuses arithmetic that cannot be true (`sampled` above `of`; `resolved + refuted`
above `sampled`), a `sampled: 0` while citations exist ("I checked none of them" is not a
check), and a `gate:` naming a stage other than the one at the cursor.

Three verdicts, not two: `sign`, `sign-with-fixlist`, `refuse`. Only `sign` could ever close a
gate.

### 7 · The gate

Either the framework closes it on the next `tldrx next`, or you sign by hand. Both doors take
the same shape at every gate — here it is at this run's earlier Plan gate, where the counts
above came from:

```
$ tldrx approve --as-agent
approved 03-plan/plan (claim-sources:passed)
  signed by fable (agent) — evidence → 03-plan/gate-evidence/plan.md
cursor → 04-build/build (ready)
```

Both doors record the same thing. The checks are re-run off disk first. The note is **copied
into the run tree** at `<phase>/gate-evidence/<stage>.md`, which is committed — a gate whose
evidence lives only in a gitignored directory is one nobody can audit from a clone. `gate.by`
records the note's `by:`, `gate.evidence` records the counts and the path, and one ordinary
`gate.approved` is appended carrying `role: agent`.

**`by:` is a name, not a kind — and here that name is yours.** An agent signs under the
operator account it is running as, so an agent-closed gate can record `by: alanmartinez` for
a stage no person read. The gate therefore also carries `executed_by: {type: agent, id: …}`
and `authority: {type: delegated, policy: agent, authorized_by: …, source: run.created}` —
the entity that did the checking, and who lent it the authority (you, at `run new --gates`,
or whoever ran `run gates set`). `tldrx run status` and `tldrx replay` print it as
`agent alanmartinez (delegated by alanmartinez, policy: agent)`, so nothing in the record
reads as you having reviewed it yourself. See
[3 — Runs and gates](03-runs-and-gates.md#who-closes-a-gate).

`tldrx replay` then renders the check itself:

```
- 03-plan/plan SIGN by fable (agent) — read 9 files, spot-checked 7 of 34 citations (7 resolved),
  audited 13 touched paths (0 outside the surface), diff vs stories: matches
  → 03-plan/gate-evidence/plan.md
```

## The four fallthroughs

An agent gate is closed when all three of these hold: **every one of the seven `auto`
conditions**, unchanged and unweakened; **no budget decision in the stage's window**; and **an
evidence note whose verdict is `sign`**. Anything else and `tldrx next` exits `4`, the gate
stays open, and every reason is named with its own label.

Four of those labels are decisions in their own right, because a person's next move differs for
each:

| Label | What happened | Your move |
|---|---|---|
| `questions` | the phase has an open question | answer it — `tldrx answer Q2 "…"` |
| `budget-event` | a `budget.raised` or `budget.blocked` landed at or after the stage started | decide whether the raise bought what it was for |
| `boundary` | the epic branch changed paths nobody scoped | widen the scope, or approve over it with your reason in the note |
| `refusal` | the note's own verdict is `refuse` or `sign-with-fixlist` | read the note — the agent did its job |

Two more labels cover the rest: `condition` for any other of the seven going red, and
`evidence` for a note that is missing or broken.

```
agent gate not taken — 1 reason(s), this gate falls to a person:
  boundary: boundary=13 changed path(s), 2 outside the surface: api:src/Billing/Invoice.cs, api:src/Billing/Ledger.cs; work outside the declared surface is a boundary change — a human decides whether to widen the scope
gate pending: tldrx approve
```

**The budget trigger is an event, not an arithmetic.** Condition 3 already compares spend
against the ceiling. What it cannot see is that a *person raised the ceiling to let this stage
through* — and a decision made to unblock a stage may not then be signed off by the machine
that was blocked.

**The boundary trigger is about scope, not quality.** It compares
`git diff --name-only <default_branch>...<epic_branch>` against the surface the run declared:
every `file:` citation in the What and How handoffs, plus every `touches:` entry in the plan. It
does not read the diff, does not judge whether the change was right, and does not fail on a path
a story declared and did not touch. `tldrx-work/`, `.tldrx/` and `.agent/` are excluded from
both sides. It never refuses on an absence — no epic branch, no repo on disk, no plan, or a run
that declared no surface each read as `n/a` with the reason spelled out.

`tldrx approve --as-agent` splits two of these apart by exit code: **`2`** is "this note is
broken, fix the file"; **`4`** is "a person decides". Exit `1` is `--as-agent` on a stage whose
policy is not `agent` — a run keeps the policy it was opened with, and a flag that could upgrade
one at approve time would make the frozen policy decorative.

And you can always overrule it. `tldrx approve` with no flag on an agent-gated stage works
exactly as it does anywhere else, is recorded as you, and carries no `evidence` key: an agent
gate is one an agent MAY close, never one a person may not.

## The interrupt: decision cards

When the run stops for a person, the useful thing to hand over is the **decision**, not a
dashboard. `tldrx run auto --gate-agent` prints a card instead of the ordinary stop block:

```
DECISION — 260830-tenancy · 01-what/what
Q2 · Should an existing customer's tenant be inferred or asked for?
  Why asked: no tenant column on the customer aggregate [src: absent:api:src/Places/Place.cs]
  A) infer from the invoice email domain — no new UI, wrong for resellers
  B) ask once at first login — one screen, correct for everyone
  C) other — write it below
Recommends B — one screen, correct for everyone [src: 01-what/handoff.md:22]
  tldrx answer Q2 "…" --run 260830-tenancy
```

It is a **pure rendering** of things that already exist. The question, its `Why asked:` line and
its lettered options come out of `questions.md` through the §2.7 parser — the questions grammar
is not touched. The `Recommends` line comes out of the evidence note's optional `recommend:`
array, and **a question with no recommendation gets no line**: the value of that line is that an
agent stood behind it with a citation, and a manufactured one is worse than none.

`--gate-agent` never changes an exit code and never upgrades a stage's frozen gate policy.
On an attended run it never spawns, because nothing on an attended run does. The full card
reference — all four kinds, and where each one is appended rather than substituted — is in
[3 — Runs and gates](03-runs-and-gates.md#decision-cards--what-the-interrupt-looks-like).

Note that `tldrx run auto` is refused outright on an attended run, at exit `1`, before the event
log is opened:

```
260830-tenancy is attended_by: host — `run auto` is a loop over spawns and this run does not spawn.
  drive it a turn at a time: tldrx next --prepare 260830-tenancy
  or hand the run back to the framework: tldrx run attend --none 260830-tenancy
```

So `--gate-agent` is for the runs the framework still drives. On an attended run, the card you
get is the one `tldrx next` appends below `gate pending: tldrx approve`.

## What none of this changes

Worth stating, because the whole value of the mode is that it is additive:

- **Absence is today.** A run with no `attended_by`, no `agent` gate and no `economy` behaves
  byte-identically to the release before them, event sequence included.
- **The seven auto conditions** keep their wording, their order and their refusal strings. An
  agent gate runs them unchanged — it is strictly stronger than an auto gate, never cheaper.
- **The prepare/commit contract** — `pending.json`, `result.json`, `--cost-usd`/`--tokens`, the
  lock, the cursor — is exactly what it was.
- **`parseReview` stays fail-closed.** Anything it cannot read is `changes`.
- **The DoD is still re-run by the framework** at `--commit`, in the story's own worktree. The
  reviewer's read-only mandate and that re-run are complements; neither subsumes the other.
- **No shipped scope uses `agent`**, and `--gates` with a bare stage id still means `human`. Every
  invocation you have already typed means what it meant.

## Cheat sheet

```bash
# open a run this session will drive, with two agent-signable gates
tldrx run new tenancy --scope feature --attended-by host --gates plan:agent,build:agent

# or flip an open one, either way
tldrx run attend host 260830-tenancy
tldrx run attend --none 260830-tenancy

# the developer half
tldrx next --prepare 260830-tenancy        # bundle; runs preconditions; renders dispatch notes
tldrx next --commit  260830-tenancy        # DoD, commit, merge — then the review bundle

# the reviewer half
tldrx next --prepare --review 260830-tenancy
tldrx next --commit  --review 260830-tenancy

# a fix-list round (no attempt spent, exactly one per story)
tldrx next --prepare --fixlist 04-build/fixlist/S5-1.md 260830-tenancy

# the gate
tldrx gate template                         # the blank evidence note; signs nothing
tldrx approve --as-agent                    # sign it; 2 = broken note, 4 = a person decides
tldrx approve --note "…"                    # overrule, as yourself
```

| Exit | On an unattended-mode command |
|---|---|
| `1` | `--as-agent` on a non-`agent` gate · `--evidence` with no `--as-agent` · `run auto` on an attended run · `--review` used headless |
| `2` | a red precondition · a broken evidence note · a headless spawn on a `host-tokens` phase · an executor refusing headless |
| `4` | a bare `tldrx next` on an attended run · an agent gate falling through · an evidence note that does not sign |

Reference: [3 — Runs and gates](03-runs-and-gates.md) for the gate machinery,
[6 — Budgets and cost](06-budgets-and-cost.md) for the two economies,
[7 — Claude Code](07-claude-code.md) for driving it from a session,
[8 — CLI reference](08-cli-reference.md) for every flag,
[9 — Troubleshooting](09-troubleshooting.md) for every refusal.
