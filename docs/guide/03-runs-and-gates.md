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

Every stage ends at a gate. What you choose is **who closes it**. `human` waits for
`tldrx approve`; `auto` lets the harness close it — but only when all five conditions hold:
the stage's checks pass, its phase has no open question, the spend is inside both the stage
and the phase ceiling, the stage did not fail, and the claim-sources validator reports
nothing (zero refused **and** zero unverified). Any one of them failing falls straight back
to the human gate and says which one and what it measured. The approval is recorded through
the same path a person's is, with `by: auto` and a note carrying all five values, so
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

Override per run with `tldrx run new … --gates <stage,stage>` — **the list is the human
gates** — or `--gates all` / `--gates none`. It is frozen into `run.yml` as `gates_policy:`
at creation, so a run keeps the policy it was opened with even after the workflow file
changes. A `run.yml` from before 0.3.0, or a workflow with no `gates:` block, is `human`
everywhere.

### What an auto gate cannot do

An auto gate is a gate the harness may sign when it can show its work. It is not a claim
that the work is good, and there are exactly three things it cannot do.

**It cannot judge whether a decision was right.** It checks that every claim carries a
citation and that every citation resolves — that `[src: F019]` names a live fact, that
`[src: Q4]` is a question this run really asked, that `graph:api.Hunt` is a node in the
graph, that `absent:` supports a negative claim and not a positive one. It does not read
the design. A perfectly sourced bad idea passes all five conditions.

**It cannot verify what it cannot reach.** A `doc` citation is never fetched — a gate that
opened a socket would be a different kind of thing — so an https URL nothing in the
workspace already names is `unverified`, and an `unverified` citation stops the gate rather
than closing it. Same for an `absent:` over a file that exists.

**It cannot notice silence, unless it is told to expect noise.** A stage that was told to
write a `questions.md` and wrote one nothing can parse used to satisfy "zero open
questions". Now it does not. But a stage that was never asked to ask anything, and asks
nothing, is still silent by right.

So: keep at least one human gate per scope (the table above does), read the note — it
records all five conditions with their measured values — and when the machine signs
something it should not have, take it back.

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
carries `auto:N` / `stale:N`.

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
