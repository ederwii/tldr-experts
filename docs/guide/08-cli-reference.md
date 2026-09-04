# 8 — CLI reference

Hand-written from `src/cli/helpText.ts`, which is the single registry three callers read:
`tldrx <cmd> --help` renders it, the argv guard rejects a flag that is not in it, and a drift
test asserts every flag the code reads is declared there. **`tldrx <cmd> --help` is the
authority** — it needs no workspace, no run and no network, and it prints the allowed values
of every closed set from where they are enforced. This page is a map of that surface.

## Exit codes

One table, defined in `src/cli/exitCodes.ts` and printed by `tldrx --help`.
`tldrx <command> --help` lists the subset that command can return.

| Code | Meaning |
|---|---|
| `0` | ok |
| `1` | usage or schema error, or a check ran and failed |
| `2` | refused: a gate said no, or several runs are open and it will not guess |
| `3` | not found: no workspace, no run, no card by that name |
| `4` | awaiting a human: the stage ran and stopped at its gate |
| `5` | the sub-agent failed |
| `64` | not implemented (reserved; no command in this build returns it) |

`4` is the normal end of a successful `tldrx next`: the stage ran, wrote its outputs, and a
person now has to approve. `1` covers both "you asked for something impossible" and "the
check I ran said no", which are the same thing to a shell. An unknown command or an unknown
flag is `1`; `64` is kept for a command that is genuinely not built, and there are none.
Ctrl-C on a spawning command exits `130`.

## Rules that hold everywhere

- **An unknown flag is refused**, not ignored. `tldrx status --nope` is exit `1`.
- **`--json` is supported or it is an error.** Where a command has no JSON shape, passing it
  is exit `1` with `--json is not supported by <cmd>` — never a silent no-op.
- **`--root <path>`** works on every command that touches a workspace. Omitted, they use the
  nearest `.tldrx/` at or above the cwd.
- **`--help`** on any command prints its usage, flags, allowed values, examples and exit
  codes, and exits `0` without needing a workspace.
- **Ambiguity is refused.** With several runs open and no id, a run-targeting command exits
  `2` and lists them. Selector: a positional `<run>` on `next`, `run status`, `run estimate`,
  `run auto`, `run unlock`, `run cancel`, `cost`, `replay` and `retro`; `--run <id>`
  elsewhere.
- **stdout is data, stderr is progress and notes.** The progress view never touches stdout.

## Environment variables

| Variable | What it does |
|---|---|
| `TLDRX_UI` | The progress view, same values as `--ui`. The flag wins where both are given. |
| `TLDRX_AGENT_PROVIDER` | Automated runner: `claude` (default) or `codex`. |
| `TLDRX_CLAUDE_BIN` | Which binary a sub-agent spawn executes. Default `claude`, taken off `PATH`. |
| `TLDRX_CODEX_BIN` | Which Codex binary the runner executes. Default `codex`, taken off `PATH`. |
| `TLDRX_UPDATE_CHECK` | `off` (also `0`, `false`, `no`, `never`) silences the new-version notice. |

`TLDRX_CLAUDE_BIN` replaces the executable **name only** — the arguments are still Claude
Code's (`-p --output-format stream-json --verbose --json-schema …`), so whatever it points at
has to speak them. It is for a pinned install, a wrapper that adds a proxy or credentials, or
a stand-in in a sandbox; it is not a provider switch. Blank or whitespace counts as unset.
`tldrx run --dry-run` prints the command it would run, so it is also how you check the
variable took. With `TLDRX_AGENT_PROVIDER=codex`, the same seam runs plain `codex exec --json`
with `--output-schema`: developer turns use `workspace-write`; Build reviewers use an enforced
`read-only` sandbox. Codex reports token usage and a thread id but no provider-metered USD or
provider-side USD cap, so its tasks are `cost_usd: null, metered: false` and every reported dollar
total remains a lower bound. `TLDRX_CODEX_BIN` has the same late-bound wrapper/pinned-install use.
No Codex model prices are inferred.

---

## `tldrx init`

Detect the workspace, build the code map, and write down the questions detection could not
answer. Deterministic and offline: filesystem and git only. No model runs and nothing is sent
anywhere.

```
tldrx init [--root <path>] [--out <path>] [--no-interview] [--process <name>]
           [--stack <a,b,…>] [--mcp] [--provider <name>]
           [--ui scene|compact|plain|off] [--quiet]
```

| Flag | Meaning |
|---|---|
| `--root <path>` | Workspace to act on |
| `--out <path>` | Where to write `.tldrx/`. Default: the same directory as `--root` |
| `--no-interview` | Skip `.tldrx/init-questions.md` entirely; nothing is asked |
| `--process <name>` | How the team plans, recorded in `process.yml`. One of: `scrum` `kanban` `shape-up` `none` |
| `--stack <a,b,…>` | Declare the stack instead of detecting it, e.g. `ts,dotnet,python` |
| `--mcp` | Also ask `claude mcp list` which servers are configured. Slower: it health-checks each one |
| `--provider <name>` | Map provider. One of: `auto` `graphify` `static`. `auto` picks graphify when it is on PATH |
| `--ui <mode>` | What to show while it works. One of: `auto` `scene` `compact` `plain` `off`. `TLDRX_UI` sets it too |
| `--quiet` | No live progress. The report at the end is still printed |

Exits: `0` `1`.

### What you see while it runs

`init` reports every step as it happens, on stderr — detecting repos, building the code map,
writing each file — with the repo it is inside named as it goes. On a terminal that is one
line with a spinner, rewritten in place and left in your scrollback once the step is done; in
a pipe or a CI job it is plain lines with no escape codes.

**Where the time goes.** Nearly all of it is the code map, because `graphify update` runs once
per repo. Measured on a five-repo workspace: **36.0 s** with `--provider auto` against
**1.3 s** with `--provider static`. `--provider static` is much faster and still cites every
claim it makes; `--provider auto` buys you graph-derived structure for the wait.


## `tldrx install --claude`

Install the tldrx skill, hooks and status line into `.claude/`. Idempotent and reversible —
see [7 — Claude Code](07-claude-code.md).

```
tldrx install --claude [--project|--user] [--skill-only] [--no-hooks] [--no-statusline]
                       [--force-statusline] [--uninstall] [--dry-run]
```

| Flag | Meaning |
|---|---|
| `--claude` | The install target. Required — it is the only one today |
| `--project` | Install into `./.claude/` (the default; refuses outside a git repo) |
| `--user` | Install into `~/.claude/` instead |
| `--skill-only` | Install the skill and neither the hooks nor the status line |
| `--no-hooks` / `--no-statusline` | Skip that half |
| `--force-statusline` | Replace an existing `statusLine` setting instead of leaving it alone |
| `--uninstall` | Remove what a previous install wrote, and nothing else |
| `--dry-run` | Print what would be written or removed. Writes nothing |

Exits: `0` `1`.

## `tldrx update`

Update tldrx to the latest published version and print the CHANGELOG between the two.

```
tldrx update [--dry-run]
```

| Flag | Meaning |
|---|---|
| `--dry-run` | Print the exact `npm` command and install nothing |

Exits: `0` `1`.

It is `npm i -g tldr-experts@latest`, run for you. The version it reports is **read back**
from what npm installed (`$(npm root -g)/tldr-experts/package.json`), never assumed — the
process printing the line is the OLD build. The changelog delta comes from the `CHANGELOG.md`
that shipped with the version now on disk.

### The new-version notice

Any invocation may print one line, on stderr, after the command's own output:

```
tldr-experts 0.5.0 available (you have 0.4.0) — tldrx update
```

It never delays a command. The registry is called in a **detached child** after the output,
which caches its answer in `~/.tldrx/version-check.json` for a day; the next invocation reads
that file and nothing else. Any network failure is silent. The line never appears in `--json`
output, during `tldrx hook` / `tldrx statusline`, when stdout is not a terminal, or in CI.

Opt out with `TLDRX_UPDATE_CHECK=off` for one shell, or for the machine:

```yaml
# ~/.tldrx/config.yml
version: 1
update_check: off
```

## `tldrx doctor`

Check the local environment against `env.yml` and say what is missing. Exit `1` means a
REQUIRED tool is missing or below its `min_version`; an optional tool is reported, never fatal.

```
tldrx doctor [--mcp] [--json]
```

`--mcp` also runs `claude mcp list` (slow: it live-health-checks every server). `--json`
prints the check results; `mcp: null` there means NOT PROBED, which is a different claim from
"no servers". It also runs `git check-ignore` over four paths that are committed state
(`run.yml`, `events.jsonl`, a `04-build/log/` probe, `memory/facts.yml`) and names any
`.gitignore` rule ignoring one, with its `file:line`. And it asks git whether every repo in
`.tldrx/workspace.yml` actually HAS the `default_branch` recorded for it — a stale record there
makes the Watch stage refuse and leaves the `boundary` gate condition `n/a` at every Build gate,
and nothing else reports it. Both are warnings: neither moves the exit code. Exits: `0` `1`.

## `tldrx learn`

Play the framework in a throwaway sandbox: real commands, a stand-in agent, `$0.00`. It
scaffolds a tiny git repo somewhere harmless, then walks you through the loop by RUNNING it —
`tldrx init`, `tldrx run new`, `tldrx next`, `tldrx answer` are the shipped commands, executed
against that sandbox, so what you read on screen cannot drift from what the code does.

```
tldrx learn [--chapter <n>] [--reset] [--list] [--sandbox <path>] [--ui scene|compact|plain|off]
```

Each chapter narrates two to four lines, shows the exact command, waits for Enter, runs it for
real, and then points at the file that changed. `q` quits. Progress is a plain
`progress.json` in the sandbox, so a bare `tldrx learn` resumes at the first unfinished
chapter and `--chapter <n>` jumps — playing any earlier chapter it depends on first, so a jump
onto a fresh sandbox works. A chapter that is already played is REFUSED rather than replayed: its
commands really ran, and most of them refuse to run twice, so the refusal names `--reset` and the
chapter a bare `tldrx learn` would resume at. Exits: `0` `1`.

**It cannot spend money and cannot touch your work.** The sandbox writes its own `claude`
stand-in, points `TLDRX_CLAUDE_BIN` at it and puts it first on the child `PATH`, so no
tutorial step can resolve the real CLI by name or by variable. The sandbox lives at
`~/.tldrx-learn` unless `--sandbox` says otherwise, nothing is ever written outside it, and it
is refused outright if that directory would sit inside a real tldrx workspace. `--reset`
deletes and rebuilds it.

With no terminal on stdin — a pipe, a CI job, `< /dev/null` — the chapters play straight
through instead of waiting for a keypress, and `--ui` degrades exactly as it does for
`tldrx init`.

## `tldrx status`

Everything in this workspace that is waiting on a human, and the command that moves each one.
Deterministic and read-only.

```
tldrx status [--json] [--root <path>]
```

A report: it exits `0` whether or not anything is pending. The only non-zero finding is `3`,
which means there is no `.tldrx/` here at all. `--json` gives
`{root, pending, items[], advice[]}`; `items` are the blockers, `advice` is what blocks
nothing. Untrained experts are printed as advice under the blockers and are NOT counted in
the header — they degrade a stage, they do not block one. Exits: `0` `1` `3`.

## `tldrx run`

Create a piece of work, look at one, drive one to its next human gate, hand it to a host
session or back, or get a stuck one moving again.

```
tldrx run new <slug> [--title <t>] [--scope <s>] [--budget <usd>] [--repos a,b]
                     [--from <dir> | --seed <file|dir> …] [--gates <a,b|a:agent|all|none>]
                     [--attended-by host]
tldrx run attend   <host|--none> [<run>] [--run <id>]
tldrx run status   [<run>] [--json] [--run <id>]
tldrx run estimate [<run>] [--json] [--run <id>]
tldrx run auto     [<run>] [--max-usd <n>] [--until <stage>] [--model <m>] [--effort <level>]
                          [--parallel <n>] [--yolo] [--gate-agent] [--ui <mode>] [--run <id>]
tldrx run gates set <stage>:<human|auto|agent> --note <text> [--run <id>]
tldrx run unlock   [<run>] [--force] [--run <id>]
tldrx run cancel   [<run>] --note <text> [--force] [--run <id>]
```

**`new`** — `--scope` is one of the workflow stems on disk: `bugfix` `docs` `feature`
`hotfix` `integration` `migration` `performance` `prototype` `refactor` `retro`
`security-patch` `spike` `upgrade` (default `feature`). `--budget <usd>` defaults to the
preset's `default_budget_usd`. `--from` and `--seed` are mutually exclusive; **`--seed` is
repeatable**. `--gates` names the HUMAN gates and overrides the workflow's `gates:` wholesale; an entry may
be qualified as `<stage>:<policy>` (`plan:agent`), and a bare entry still means `human`.
`--attended-by host` opens the run in **attended mode**: a host session does the turns and
the framework never spawns on it (see below). Any other value is exit `1` and no run is made.

**Every close names the questions nobody answered (#141).** `cancel`, `tldrx approve` signing the
last gate and `tldrx next` closing the last stage all read every phase's `questions.md` and print
the ids, titles and files of everything still `status: open` — and say, in the same sentence, that
nothing was going to answer them: a §2.7 question declares no default and no timeout, and
`tldrx interview --yes-to-defaults` is invoked by hand. It is a report: no exit code changes and
no close is refused. A run is allowed to end with a question open; it may not do it quietly.

**`attend`** flips that on a run that is already open. `tldrx run attend host` hands the run
to a host session; `tldrx run attend --none` hands it back. It runs no agent, spends nothing,
moves no stage and touches no branch — it sets one field and appends one `run.attended` event.
A direction is required and never guessed (exit `1`), setting what is already set is a silent
no-op, and a `done` or `cancelled` run is refused (exit `2`).

**Attended mode** (`attended_by: host` in `run.yml`) exists for one measured failure: a bare
`tldrx next` on a Build stage runs the WHOLE remaining pipeline — every wave, every story, as
paid spawns — when the host wanted one turn. On such a run:

- `tldrx next` with no `--prepare`/`--commit` exits **`4`** and names the exact command the
  stage is waiting for. Nothing is billed and nothing is written. `--dry-run` is refused with
  it, because it is headless too — it spawns nothing (issue #17), but it describes a dispatch
  this run never makes.
- `tldrx run auto` is refused at exit **`1`** before the event log is even opened.
- Every stage executor exposes prepare/commit only, and `spawnAgent` itself throws if any path
  reaches it — three layers, because "nothing spawns" is a promise about money.
- `tldrx run status` prints `attended: host`, and the status line carries an `att` marker.

Everything else is untouched: the prepare/commit contract, `pending.json`/`result.json`,
`--cost-usd`/`--tokens`, the lock, the cursor and the gates all behave exactly as they do on
an ordinary run.

**`status`** with several runs open LISTS them and exits `0` — it is the screen you read to
find the id every other command wants.

**`estimate`** is the one command here that GUESSES, and it says so in its own output. For
what was actually spent, use `tldrx cost`.

**`auto`** loops `next` until a human gate or open question (`4`), a failure (`5`), a budget
refusal (`2`), `--until` reached or the run finished (`0`). `--max-usd` is a ceiling on the
LOOP's spend, checked between stages. Headless only — which is why it is refused outright
(exit `1`) on a run marked `attended_by: host`. `--gate-agent` prints a **decision card** at
the stop instead of the ordinary status block (guide 03); it is rendering only and never
upgrades a stage's gate policy.

**`gates set`** is the **only sanctioned way to move `gates_policy` after `run new` froze
it** — the case it exists for is a run opened before the `agent` policy existed, which can
otherwise never use `approve --as-agent`, and `run.yml` is hand-edit-forbidden. It changes
who may CLOSE a gate from then on; gates already signed are untouched.

```
$ tldrx run gates set plan:agent --note "predates the agent policy; the pilot signs with evidence"
```

One stage per invocation — a comma list is refused, because a second change would ride along
on the first one's note. The entry must name its policy outright: a bare `plan` is refused
here even though `--gates plan` means `human` at `run new`, since a signature must not rest
on a default. A no-op (`human` → `human`) is refused rather than recorded.

**`--note` is required** and there is no way around it. The change is human-signed like
`story reopen`: it appends one **`gate.policy_changed`** event carrying the actor, the
moment, your note and the old→new value, which is the whole audit trail for a gate mutation
nobody would otherwise go looking for. A run with no `gates_policy` map at all gets the full
map written, every stage explicit, with the one change applied.

**`unlock`** drops a `.lock` nobody is behind and puts the stage it stranded back to `ready`.
It spends nothing and touches no stage output. A live pid needs `--force`.

**`cancel`** closes a run for good. Nothing is deleted — the stages, outputs, events and money
spent stay on disk, and `tldrx replay <id>` still reads them. `--note` is required; an empty
note is exit `1`.

Exits: `0` `1` `2` `3` `4` `5`.

## `tldrx next`

Run the run's next stage and stop at its gate. Exit `4` is the normal end of a successful
stage.

```
tldrx next [<run>] [--run <id>] [--dry-run] [--prepare|--commit] [--review] [--fixlist <path>]
           [--parallel <n>] [--model <m>] [--effort <level>]
           [--max-usd <n>] [--prompt-max-bytes <n>] [--max-reads <n>] [--cost-usd <n>]
           [--tokens <n>] [--yolo] [--keep-worktrees] [--discard-pending] [--reuse-epic]
           [--ui <mode>] [--root <path>]
```

| Flag | Meaning |
|---|---|
| `--dry-run` | Show what WOULD be dispatched — the expert bundle, the context ledger, the prompt size, the declared outputs and the exact `claude -p` argv — then stop. **Spawns nothing, writes nothing, spends nothing.** Until issue #17 it ran the stage for real and reverted the non-handoff files afterwards, which cost $0.42 on the 2026-08-30 pilot |
| `--prepare` | Write the prompt bundle and stop, spawning nothing |
| `--commit` | Record the result of a `--prepare` cycle run by hand. Spawns nothing |
| `--review` | With `--prepare`/`--commit`, addresses the story's **reviewer** half instead of its developer half: the bundle is one directory down, at `.agent/<stage>/<story>/review/`. Spawns nothing ([10 — Unattended mode](10-unattended-mode.md)) |
| `--fixlist <path>` | With `--prepare`, re-prepares the AUTHOR's bundle carrying that fix list's open findings under `## Fix list`. Omit it and the latest round on disk with anything still open is carried by itself |
| `--parallel <n>` | How many stories of ONE wave to build at a time. Merges still land in the wave's listed order; default `1` |
| `--model <m>` | Passed through to `claude --model`. Default: the stage's own `model:` |
| `--effort <level>` | `low` `medium` `high` `xhigh` `max`. The cost lever `--max-usd` is not |
| `--max-usd <n>` | Stop after the turn that crosses this. A ceiling on the run, not a brake on the turn in flight |
| `--prompt-max-bytes <n>` | Ceiling on the assembled prompt. Over it the stage is refused (exit `2`) before a cent is spent. Default: the stage's, else 160 KB |
| `--max-reads <n>` | Completed `Read`/`Glob`/`Grep` calls before the sub-agent is stopped. Default: the stage's (120; 200 build, 60 watch) |
| `--cost-usd <n>` | `--commit` only: what the host session's sub-agent cost. Without it the task is `cost_usd: null, metered: false` |
| `--tokens <n>` | `--commit` only: tokens the host used, recorded beside the declared cost |
| `--yolo` | Let the sub-agent run without per-tool permission prompts. It still cannot push |
| `--keep-worktrees` | Leave the per-story worktrees on disk after the build stage |
| `--discard-pending` | Bin an orphaned `--prepare` bundle and run the stage again. On a build stage running off an implicit plan, also derives the plan again — unless something has been built off it |
| `--reuse-epic` | Let the build stage adopt an existing `epic/<slug>` branch this run did not cut |
| `--ui <mode>` | `auto` `scene` `compact` `plain` `off`. Every byte goes to stderr |

`--prepare` and `--dry-run` print the CONTEXT LEDGER. On a run marked `attended_by: host`
every headless invocation — `--dry-run` included — is refused at exit `4`, naming the half of
the handshake the stage is waiting for. Exits: `0` `1` `2` `3` `4` `5`.

## `tldrx seed`

Triage a seed too big for one run into several, then create them. See
[5 — Seeds and triage](05-seeds-and-triage.md).

```
tldrx seed triage <path> [--out <dir>] [--json] [--threshold-tokens <n>]
tldrx seed triage <path> --propose [--model <m>] [--effort <level>] [--max-usd <n>]
                                   [--ui <mode>] [--prepare|--commit] [--yolo] [--out <dir>]
tldrx seed answer <split.yml> <Qid> "<text>"
tldrx seed apply  <split.yml> [--dry-run]
```

`triage` without `--propose` is free: no model, no network. `--propose` spawns ONE sub-agent
(effort `low`, `--max-usd 1.00` by default) and **never creates a run**. `apply` creates the
runs and **never asks a model**. Exits: `0` `1` `2` `3` `5`.

## `tldrx answer`

Answer one open question from the command line, recording it as a fact.

```
tldrx answer <Qid> <text> [--supersede] [--run <id>] [--root <path>]
```

Exits: `0` `1` `3`.

### Reversing a decision — `--supersede`

An answer is recorded once, so answering an already answered question is refused. `--supersede`
is the way through when the reason for the original answer stops holding — a risk gets refuted,
a benchmark comes back, an owner changes their mind:

```
tldrx answer Q3 "Redis sorted set — the load test refuted the contention risk" --supersede
```

It is only valid on an **answered** question (on an open one it exits `1` and tells you to
answer it normally). What it does:

- appends a **new fact** carrying the whole new answer, with the same `area` and `repos` and
  ordinary provenance (`who`, `when`, `run`, `q`);
- sets the old fact's `superseded_by` to the new id — and `supersedes` on the new one, so the
  §2.5 chain stays reciprocal. **The old fact's text is never edited.**
- appends to the question block: the superseding answer and its footer. The original
  `[Answer]:` line stays exactly where it was;
- appends `fact.added` and `fact.superseded` to `events.jsonl`.

**Every reader that feeds a decision then skips the old fact** — the no-re-ask hook, the
`{{facts}}` section of every prepared prompt, the Watch stage's facts input, the implicit plan
and the training miner all filter on *live* (neither retired nor superseded). Re-asking a
question a superseded fact answers is therefore legal, which is the point: an owner who
reverses a call must be able to be asked again.

**Nothing is erased.** `tldrx replay` renders the reversal as its own line, `tldrx retro` still
lists the old fact and labels it `(superseded by F<n>)`, and the words originally typed stay in
`questions.md`.

Reversing twice supersedes the *second* fact, not the first: the chain is walked to its head.

Superseding is not retiring. Retire a fact when it should never have been recorded or has gone
stale with no replacement (`retired: {at, by, reason}`, by hand); supersede it when a *different*
answer is now the right one.

### When the answer overtakes a document — the superseded stamp

Every answer, `--supersede` or not, can flip something an **earlier phase already wrote down**. The
plan says the trigger is inert; you answer Q4 three phases later and it is not. The fact is right,
`questions.md` is right, `retro.md` is right — and `03-plan/stories/S4.md`, which is what anyone
actually opens, still says the old thing.

So when an answer is recorded, `tldrx` appends a marker to the earlier-phase documents the question
**names**:

```markdown
<!-- tldrx:superseded F021 | q: Q4 | at: 2026-08-30T10:00:00Z | see: 04-build/questions.md -->
> **Superseded in part by F021** — Q4 was answered after this document was written; the answer is
> in `04-build/questions.md` and `.tldrx/memory/facts.yml`. This document was not reconciled:
> where the two disagree, the fact is what the workspace believes.
```

**Which documents.** The ones the block names, and nothing else:

- every `file` citation in its `Why asked:` `[src: …]` token that points at a `.md` file in an
  **earlier** phase of the run. §2.7 already requires that token, so a question raised in Build
  about a plan claim normally cites the plan claim — no new habit to learn. A citation into the
  question's own phase is not a supersession (you are reading your own half-written page), and a
  citation into source code names no phase document at all;
- anything listed in an optional `affects:` key on the block's metadata comment, honoured wherever
  it points inside the run. Use it when the honest citation is a `.cs` file rather than a document:

```markdown
<!-- id: Q4 | status: open | area: inventory | asked_by: developer | asked_at: 2026-08-30T09:00:00Z | affects: 02-how/design.md, 02-how/handoff.md -->
```

**What it is not.** It is a marker, not a reconciliation. Nothing in the document's own words is
rewritten — knowing *which sentence* went stale means guessing, and a framework that guesses at
content is the thing `[src: …]` exists to stop. Read the fact and the question; the document tells
you they exist.

**Properties worth relying on.** It is append-only (`appendFileSync` — no byte the phase wrote is
read back or rewritten); idempotent per fact (the comment carries the id, so recording the same
answer twice stamps once); and deliberately not a list item and not a citation, so a stamped
`handoff.md` passes `claim-sources` and the §2.8 gate exactly as it did before. Each stamp appends
one `doc.superseded` line to `events.jsonl`, which `tldrx replay` renders.

## `tldrx interview`

Work through the open questions in the terminal, one at a time.

```
tldrx interview [--run <id>] [--init] [--yes-to-defaults] [--root <path>]
```

`--init` answers `.tldrx/init-questions.md` instead of a run's `questions.md`. **This is the
only way to answer the INIT questions**: editing the file by hand fills the slot but records
no fact and writes no `process.yml`. `--yes-to-defaults` takes the first option of every
question that offers one. Piped stdin is one answer per line. Exits: `0` `1` `2` `3`.

## `tldrx questions`

Read this run's open questions as decision cards, or check that the file the §2.7 parser
reads is one it can see.

```
tldrx questions cards [<run>] [--run <id>] [--root <path>]
tldrx questions lint  [<run>] [--run <id>] [--fix] [--area <a>] [--root <path>]
```

`cards` (#59) renders each OPEN question as a printable decision card: two lines of context
(which run and file it is parked in, who asked it, when, in what area), the question's own
`Why asked:` note **verbatim** with its `[src: …]` — the slot for what the binding docs
already decide — and the file's lettered options. A note that cites nothing is flagged as
somebody's recollection; a question parked with no note says so; and a question with no
options gets a loud `NEEDS OPTIONS` marker rather than a manufactured A/B/C, because
inventing the choices would be answering the question in the act of asking it.

It **reads only**. Answers still flow through `tldrx answer`, and every card prints the exact
line to type. No open question is a sentence and an exit `0` — and "this run parked nothing"
and "everything here is answered" are different sentences, because they send a reader to
different places.

A heading that misses `## Qn · Title` is not half-read, it is read as ABSENT — so everything
downstream reports "0 open questions" and an auto gate signs itself over them. This names
every block in that state and exits `2`. `--fix` converts the prose form to the grammar
**without changing a word**: title, reason, every option and any answer already typed come
across verbatim; what is added is the heading separator, the metadata comment and the
`[Answer]:` slot. `--area <a>` is the area stamped on a block `--fix` has to write metadata
for (default `general`). Exits: `0` `1` `2` `3`.

## `tldrx approve`

Approve the gate the run is sitting at. Re-runs the stage's `checks` against what is on disk
first; exit `2` names the failing check.

```
tldrx approve [--note <text>] [--as-agent] [--evidence <path>] [--run <id>] [--root <path>]
```

`--as-agent` signs an `agent` gate with the evidence note at `.agent/<stage>/evidence.md`
(spec §2.17), or at `--evidence <path>`. `--evidence` on its own is exit `1` — a note nobody
signs with is not evidence for anything. The note is validated by the same §2.8 machinery
`claim-sources` runs before anything is recorded; then the gate records the note's `by:` as
the actor, `gate.evidence` carries its counts, and the note is copied to
`<phase>/gate-evidence/<stage>.md`, where it is committed.

Two refusals, and they mean different things. Exit **`2`** is "this note is broken" — fix
the file, nothing was signed. Exit **`4`** is "a person decides": the note parsed perfectly
and its verdict is `refuse` or `sign-with-fixlist`. Exit **`1`** is `--as-agent` on a stage
whose policy is not `agent`; a run keeps the policy it was opened with, and a flag that could
upgrade one at approve time would make the frozen policy decorative.

A person may always approve an agent-gated stage with no flag at all. That is an override, it
is recorded as a person, and the gate carries no `evidence` key.

Exits: `0` `1` `2` `3` `4`.

## `tldrx gate`

Write the skeleton evidence note an agent gate is closed over (spec §2.17).

```
tldrx gate template [<run>] [--run <id>] [--force] [--root <path>]
```

It writes `.agent/<stage>/evidence.md` with the measured fields filled — the gate at the
cursor, the time, how many citations the §2.8 resolver found in this stage's outputs, how
many touched paths the plan declares — and every judgement blank, then prints what each of
the four sections has to contain. The blank form does **not** validate, on purpose. An
evidence note already on disk is left alone (exit `2`) unless you pass `--force`.

Non-signing: it spends nothing, spawns nothing, approves nothing and moves no cursor.
Exits: `0` `1` `2` `3`.

## `tldrx reject`

Send the current stage back with a note saying what has to change, or revoke an approval
already given.

```
tldrx reject --note <text> [--stage <phase>/<stage>] [--run <id>] [--root <path>]
```

`--note` is required — a rejection with no reason is not actionable. `--stage` revokes an
approval already given, whoever signed it: the cursor moves back, `gate.revoked` is appended
carrying `signed_by`, and later stages that had run are marked `stale`. Nothing is deleted and
no cost is refunded. It is the one verb that may reopen a finished run. Exits: `0` `1` `2` `3`.

## `tldrx note`

Record one operator annotation on a run's event log, at the moment it happened.

```
tldrx note [<run>] [--stage <id>] "<text>" [--run <id>] [--root <path>]
```

The text is required — an empty note is a usage error. `--stage` keys the note to one stage of
the run, spelled either `plan` or `03-plan/plan`; without it the note is about the run, and a
stage the run does not have is refused with nothing written.

It appends exactly one `operator_note` event and touches NOTHING else: `run.yml` and
`budget.yml` are byte-identical across the call, no gate is signed or revoked, no cursor moves
and no money is spent. It exists because there was no honest carrier for a maintenance action
at the moment it happened — the alternatives people reached for were a FUTURE gate note (late,
and attached to a decision the note is not about) and `tldrx reject`, which undoes work. The
note then shows up in `tldrx status` (the last few) and in `tldrx replay` (every one, in
place). Exits: `0` `1` `2` `3`.

## `tldrx story`

Give one Build story another run of attempts, or open a fix round on a done one.

```
tldrx story reopen <id> --note <text> [--for-fix] [--run <id>] [--root <path>]
```

`--note` is required — a reopen with no reason is not actionable. The story goes back to
`todo`, its attempt counter restarts at 1 of 2, and one `story.reopened` is appended carrying
the actor, the note, the status it came from and how many verdicts the closed run of attempts
consumed. Nothing is erased to make the reset true: `story.reopened` is a boundary the review
ledger reads, and every earlier attempt stays in `events.jsonl`. It runs no agent, spends
nothing, deletes nothing and refunds nothing — the story's branch, which carries the last
developer's commits, is untouched. It does NOT send the stage back; the output names the
`reject` that does. Refuses (`2`) an unknown story id, a `done` story (that is
`reject --stage`, or `--for-fix` below), a `todo` story, and a missing `--note`.
Exits: `0` `1` `2` `3`.

### `--for-fix` — a fix round on a `done` story

An accepted defect in finished work had no sanctioned path: rejecting the whole Build stage
destroys every other story's closure, and fixing it outside the story machinery leaves an
epic-level commit with no story provenance. `--for-fix` is the missing arc, `done` → fix
round:

```
tldrx story reopen S11 --for-fix --note "linkEmail succeeds then setDisplayName fails: account linked, score never claimable"
```

The `--note` is the **named defect**, and it is what scopes the round. The story goes back to
`todo` and **no attempt is consumed** — the verdict that closed it stops counting, so the fix
runs as attempt 1 of 2. The fix then passes **the same DoD and the same reviewer** the story
passed: a fix round ends the way the story did, or it does not end.

It is not a way to relitigate scope. The story's acceptance criteria are not touched — the
only line this verb moves on the file is `status:` — and one story may have exactly **one**
fix round open at a time. The round opens on a `story.reopened` carrying `reason: fix` and
closes when the story is `done` again.

Refuses (`2`) a story that is **not** `done` (that is the plain reopen), a missing `--note`,
and a story that already has a fix round open — the refusal names who opened it and with
which defect.

## `tldrx plan`

Carry an edited `workspace.yml` into the dod blocks of stories that are already approved.

```
tldrx plan sync-dod [--dry-run] [--run <id>] [--root <path>]
tldrx plan schema   [--story | --epic | --waves]
```

A story's dod command must equal a `workspace.yml` command verbatim, so editing
`workspace.yml` orphans every approved story that cited the old string. This is the
mechanical repair for that, and it does not weaken the verbatim rule by a byte.

Four outcomes per dod line, and only the first three write anything: a line the current
workspace still declares is left alone; a line a PREVIOUS version declared under a role the
current file still has becomes that role's command; a line whose role is gone is dropped; and
a line no version of `workspace.yml` ever declared is FLAGGED and its story left untouched —
that is real drift, not a rename, and guessing at it is the one thing this must not do. The
ancestry comes from git's history of `.tldrx/workspace.yml`, so a workspace with no history
has no ancestors and every non-current line is flagged rather than rewritten.

Nothing else in a story moves: the front matter, the prose and the fences come back
byte-identical, the previous version is kept at `<story>.md.bak`, and the result is validated
by the same plan check the drift came from. `--dry-run` prints the same per-story diff summary
and writes nothing. It runs no agent, spends nothing and moves no cursor.

`tldrx plan schema` prints the story, epic and `waves.yml` contract for a human to write to:
the front-matter keys in order, what the check enforces for each, the caps at the values it
currently uses, and one example of each file that the check accepts as it stands. These are the
SAME bytes the Plan agent is given, generated from the validators themselves, so they cannot
drift from what will be accepted — which is why `templates/story.md` and `templates/epic.md`
were deleted rather than kept up to date. Pass at most one of `--story`, `--epic` or `--waves`
to print just that example; passing two is a usage error, and passing none prints the whole
contract. Alone among these verbs it resolves no workspace and no run, reads no disk and spends
nothing, because the question comes before any of that exists. Exits: `0` `1` `2` `3`.

## `tldrx budget`

```
tldrx budget show  [--run <id>] [--json]
tldrx budget raise <phase> <usd> [--run <id>] [--take-from <phase>] [--note <text>]
```

`--take-from <phase>` moves the money out of that phase instead of raising the run's total,
refusing to cut a donor below what it has already spent. `--note` is recorded on the
`budget.raised` event beside the before/after and the actor. Exits: `0` `1` `2` `3`.

## `tldrx cost`

What the work actually cost — per attempt, per stage, per run.

```
tldrx cost [<run>] [--run <id>] [--all] [--json] [--root <path>]
```

Read off `agent.result` events and nothing else: every dollar printed here is one the Claude
CLI reported. No token count is ever multiplied by a price. Attempts are never merged. Work
this process never saw a cost for is UNMETERED, never $0.00. `--all` covers every run in the
workspace, finished ones included, and the run argument is ignored. Exits: `0` `1` `3`.

## `tldrx map`

Build, refresh or drift-check the code knowledge base under `.tldrx/map/`.

```
tldrx map --refresh [--provider <name>] [--root <path>]
tldrx map --check   [--root <path>]
```

One of `--refresh` or `--check` is required; they are the subcommands, spelled as flags.
`--check` reads every `[src: …]` citation in the map and the init handoff through the same
grammar `claim-sources` enforces, then resolves the `file` ones against the filesystem. Exit
`1` reports two kinds of problem, counted separately: citations that no longer **land** (the
file is gone, the line is past the end, the repo is not in `workspace.yml`), and citations
that no longer **parse** — those name the rule that refused them, quote the line as written
and show a line that would pass, exactly as a `claim-sources` rejection does. `--refresh` appends `map.refreshed` to the newest OPEN run's `events.jsonl` and says
which run it filed under; with no open run it records nothing and still exits `0`. Providers:
`auto` `graphify` `static`. Exits: `0` `1`.

## `tldrx expert`

List or create experts, recompute their levels, or train one. See
[4 — Experts](04-experts.md).

```
tldrx expert list      [--json]
tldrx expert create    <name> [--area <id>] [--title <text>] [--role <slug>] [--domain <slug>]
                              [--stack <lang>]
tldrx expert train     <name> --area <area> [--mode light|full] [--max-usd <n>] [--model <m>]
                              [--effort <level>] [--prepare|--commit] [--yolo] [--print-prompt]
                              [--ui <mode>]
tldrx expert recompute [<name>] [--json]
```

`create --area <id>` seeds the expert's first competency area and `--title <text>` names it —
without one, the expert has no area and `expert train` refuses it (#94). The title is what light
mode greps the code for, so it is worth writing. `create` also writes the front matter `repos:`
from `.tldrx/workspace.yml`; the `## Domain` bullets are paths relative to those repos, with no
repo prefix.

`train --area` is required. `--mode light` reads the code; `full` also mines finished runs'
handoffs — a role expert only trains `full`. `--print-prompt` prints the training prompt and
stops: it spawns nothing and costs nothing. `recompute` is arithmetic over evidence already
on disk: it spawns nothing, spends nothing, and does not touch `status` or `last_trained`.

`expert train` **refuses before it spawns** whenever the run has nothing to work on — exit `1`,
nothing spent, nothing written: no such area (#94), `--mode light` on a role expert, and — since
#101 — a pass whose input is empty. A `--mode full` run with one live pass and one empty one is
not refused: the empty pass is **skipped**, said on stderr, and its share of the ceiling simply
goes unspent.

Exits, as `tldrx expert --help` prints them: `0` `1` `3`. **`expert train` also returns `2`**
(below the $0.25 spawn floor, or the #96 pre-start check: the per-sub-agent share cannot reach
what one pass on the resolved model tier costs) **and `5`** (the knowledge file failed validation
and was quarantined). Those two are missing from the help registry's `exits:` list for `expert`;
the codes are real, the help screen is the thing that is short.

*(Corrected 2026-09-02: this paragraph used to put `--mode light` on a role expert under `2`. It
is `1` — `lightModeRefusal` returns `EXIT_USAGE`, which `src/cli/exitCodes.ts` defines as `1`, and
`test/training.test.ts` pins it as "refused (exit 1)". `2` is this codebase's MONEY refusal: the
spawn floor and the preflight.)*

## `tldrx dashboard`

```
tldrx dashboard [--port <n>] [--open] [--root <path>]
tldrx dashboard --static [--out <dir>] [--root <path>]
```

Read-only: it serves GET and writes nothing into the workspace. Default port `4477`; `--port 0`
takes any free one. `--static` writes one self-contained page instead of serving — no server,
no watcher. Ctrl-C exits `0`. Exits: `0` `1`.

## `tldrx replay`

Render a run's `events.jsonl` as a narrative of what happened and what it cost.

```
tldrx replay [<run-id>] [--root <path>]
```

Read-only: every line comes from an event that was actually logged. With no id it narrates the
newest run and refuses (exit `2`) only when several are open. Exits: `0` `1` `2` `3`.

## `tldrx retro`

Close a run and write down what it learned — or, with `--all`, what every run keeps catching.

```
tldrx retro [<run-id>] [--apply] [--root <path>]
tldrx retro --all [--json] [--root <path>]
```

No model runs. `--apply` also appends the practice proposals to `.tldrx/memory/practices.md`,
idempotently. Exits: `0` `1` `2` `3`.

### `--all` — the cross-run trends table

Every run leaves findings nobody aggregates: a reviewer's verdict and its `## Findings`, a fix
list with a **disposition** per finding, `retro.md`'s `## Build feedback`, and the reason a
person typed when they reopened a story. `--all` reads all four across **every** run under
`tldrx-work/` and prints one table:

```
3 run(s) under tldrx-work/ · 2 contributed · 9 finding(s) · 1 same-run repeat(s) collapsed

CLASS                      COUNT  RUNS  EXAMPLE
-------------------------  -----  ----  -------
authorization-not-widened      3     1  "The tenant filter is not applied to the read model…"
                                        [src: tldrx-work/260830-tenancy/04-build/log/S5.md:13] · seen in: 260830-tenancy
```

Seven classes, in this precedence: `test-cannot-fail`, `missing-negative-control`,
`unreachable-structure`, `stale-comment`, `authorization-not-widened`, `schema-drift`, `other`
— plus whatever `.tldrx/memory/finding-classes.yml` adds (below), which slot in just before
`other`.
Classification is **ordered keyword rules over the finding text** — no model, no scoring — so
the same tree always gives the same table and a rule that misfires can be pointed at. `other`
is a real row: a table it dominates says the taxonomy is too small.

Four properties are the contract:

- **Zero new state.** It writes nothing anywhere — not `retro.md`, not `practices.md`, no
  cache. Safe to run out of curiosity, which is the only way anyone runs it.
- **Absence is never an error.** A run with no Build phase, no retro, no events log or an
  unreadable one contributes what it has and is still counted. An empty workspace is exit `0`
  with `no runs found under tldrx-work/`.
- **A repeat within one run is collapsed** — `retro.md` quotes the fix list verbatim, so the
  same defect is on disk twice. The same finding in **two** runs is two occurrences, which is
  the whole point of the table.
- **A `refuted` fix-list finding is read and dropped.** It is the one disposition that says the
  reviewer was wrong, with the citation proving it; ranking a class by disproven findings would
  make this a report on the reviewer.

`--all` is refused (exit `1`) alongside a `<run-id>` or `--apply`: each asks for the opposite of
what `--all` does, and the refusal happens before a file is opened.

### `--all --json` — the machine shape

`--json` belongs to `--all` alone. Closing one run **writes** `retro.md` and reports the path;
there is nothing there to parse, so `tldrx retro --json` without `--all` is a refusal (exit `1`)
rather than a stringified sentence.

The shape is a deliberate projection, not a dump of an internal type, and its key set is asserted
literally by a test — adding a field is a visible act, removing or renaming one bumps `version`:

```json
{
  "version": 1,
  "root": "/abs/path/to/workspace",
  "runs": ["260830-tenancy"],
  "contributed": ["260830-tenancy"],
  "deduped": 0,
  "classes": ["test-cannot-fail", "...", "other"],
  "trends": [
    {
      "cls": "authorization-not-widened",
      "count": 2,
      "runs": ["260830-tenancy"],
      "example": {
        "run": "260830-tenancy",
        "kind": "review-finding",
        "text": "The tenant filter is not applied to the read model, so one tenant can list another's rows.",
        "src": "[src: tldrx-work/260830-tenancy/04-build/log/S5.md:13]"
      }
    }
  ],
  "findings": [
    {
      "run": "260830-tenancy",
      "kind": "review-finding",
      "cls": "authorization-not-widened",
      "text": "The tenant filter is not applied to the read model, so one tenant can list another's rows.",
      "src": "[src: tldrx-work/260830-tenancy/04-build/log/S5.md:13]"
    }
  ]
}
```

`trends` is the ranked table. `findings` is every mined row — the table has no use for them, an
expert trainer does. `classes` is the effective taxonomy in precedence order, so a consumer
reading `cls` knows the full set it is ranking over, extensions included. `kind` is one of
`verdict`, `review-finding`, `fixlist`, `deferred`, `retro-bullet`, `reopen`. Nothing is written,
and a refusal writes nothing to stdout at all — never half a document.

### The reviewer is fed this

The Build phase's adversarial reviewer prompt carries the **top three** classes (never `other`)
before it reads the diff, so a review starts from what this team keeps getting wrong instead of
rediscovering `test-cannot-fail` on its own, run after run:

```
## What this team keeps getting wrong

This workspace's own history — `tldrx retro --all` over every run in it — ranks these
as the finding classes its reviews keep producing. Check for them specifically, and
check for them first: they are where the evidence says this team's defects are.

- `authorization-not-widened` — 2 finding(s) across 1 run(s)
  e.g. "The tenant filter is not applied to the read model, so one tenant can list another's rows."
  [src: tldrx-work/260830-tenancy/04-build/log/S5.md:13]

It is a prior, not a checklist. A diff clean of all of them is clean, and saying so is
the right answer; finding one is not automatically `changes` — the Rules below still
decide that. Never write a finding you cannot cite in the diff.
```

It is computed by the same `mineAll` over the same workspace, so **what the reviewer is told is
exactly the top of what `tldrx retro --all` prints** — run it to see what your reviewers are being
primed with. It is additive and absent-safe in every direction: no runs, no findings, nothing but
`other`, or a `finding-classes.yml` that will not load, and there is no section at all — not a
heading, not a blank line. The aggregate is mined once per `tldrx next` invocation, so every
reviewer in one invocation gets the same prior and a wave of six stories pays for it once.

### `.tldrx/memory/finding-classes.yml` — extending the taxonomy

The seven built-in classes are a closed set on purpose: keyword rules are only trustworthy because
they are tested against fixtures. But a team whose repeated defect is not one of the seven got
`other` and no way to say so. This file is that way.

```yaml
version: 1
classes:
  - name: flaky-timing
    rules:
      - "flaky"
      - "timing[- ]dependent"
      - "sleep\("
  - name: n-plus-one
    rules:
      - "n\+1"
      - "query in a loop"
```

- `version: 1`, like every other data file this framework reads.
- `classes:` — 1 to 16 entries, each `{name, rules}`. `name` is lowercase letters, digits and
  hyphens, 2–40 characters (it is a table heading and a JSON key). `rules` is 1 to 16 strings,
  each a JavaScript regular expression, compiled case-insensitively like every built-in rule.
- **Extensions are tried AFTER every built-in rule and before `other`.** A workspace class can
  therefore only ever claim a finding the built-ins left unclassified. It cannot re-label
  `test-cannot-fail`, which is what keeps an unbounded taxonomy testable — the shipped fixtures
  are immune to whatever any workspace writes here.
- **No file is the normal case**, and costs nothing. A file that exists and will not load is a
  **refusal** (exit `1`) naming the file, the class index, the class and what is wrong with it —
  never a silent fallback to the built-ins, because a rule its author believes is running and is
  not would make every count a lie. Refused, with examples: not a mapping · no `version: 1` ·
  no `classes:` · an empty list · a name that is not a slug · a name that shadows a built-in ·
  a name declared twice · no rules · a rule that is not a string · a rule that is not a valid
  regular expression · a rule such as `.*` that matches every text, including the empty string,
  and so would swallow every unclassified finding.

The Build reviewer never fails on this file: a refusal costs the prior and prints
`reviewer focus skipped — …` on the invocation's output, so a team editing a file that has stopped
being read finds out, and no story loses an attempt to a YAML typo.

## `tldrx drive`

Print the session mandate for driving a run — the discipline, not the manual.

```
tldrx drive <--attended|--unattended> [--tldr] [<run>] [--run <id>]
```

The output is plain text you paste into the session that will drive a run (or read yourself
before you start). It opens with a **preflight** — the driver establishes the run's
attendedness (`tldrx run status <run>`), its gate policy (`--json`, stage by stage) and its
`budget.yml`, states the ceiling it will honour, and **refuses to start** on any one it cannot
establish, naming the command that failed. Preconditions are part of the discipline the
mandate transfers: a text that assumes six commands were hand-run for it first only works
where somebody was already being careful. After that it carries what the first real runs were
actually driven by: the three-role
protocol (developer sub-agent → a **fresh** adversarial reviewer, never the author → the host
verifying both **in the code**, not in their reports), evidence discipline (measured / inferred
/ assumed labelled in the same sentence as the claim, exit codes never read through a pipe,
verification from the source, remote shas via `git ls-remote`), parking product questions as
**guided** ones — lettered options and a recommendation, asked on the console unless the launch
message named another channel — instead of deciding them or halting for them, calibrating the
reviewer to the story's **stakes**, and declaring a
turn's cost once — with a floor rather than a total when the records are incomplete.

The two modes share that spine and differ in exactly four sections:

| | `--attended` | `--unattended` |
|---|---|---|
| the preflight | checks attendedness and the budget, and **moves no gate policy** — a stage that is not `human` where you expected it is reported to you, not fixed | sets what it finds wrong: `tldrx run attend host <run>`, and `tldrx run gates set <stage>:agent --note "…"` for a stage you delegated, over a note quoting **your** delegation from the launch message |
| when it may stop | no rule — you are at the keyboard, so stopping costs a sentence | **`## Do not stop`**: halt only on a STRICT blocker, one where no remaining turn can proceed until you answer, and name the work it does NOT block before calling it one |
| who drives the turns | you say which, and do not switch mid-run | the session, through `--prepare`/`--commit`; the framework never spawns |
| who closes a gate | **you** — the session does the check, writes the note and hands you the command | the session, over a validated evidence note (`tldrx approve --as-agent`) |

**`--tldr`** adds one section to either mode, for a run whose trail nobody is going to read. It
is a **reporting contract**, not a quality setting: after every `--commit` and at every gate the
session shows what `tldrx run status` prints — the phases, the percentages, the spend against the
ceiling and what is next — plus **at most three bullets of delta**, and nothing else. No recap of
a sub-agent's report, no summary of a diff you can read, no restating the status block in prose.
Free text is reserved for a strict blocker's guided question and for a correction to something it
already told you.

It also turns off the half of the trail nothing consumes. Measured on a real workspace of ten
runs: of ~4.0 MB written, 2.16 MB is trail, and all **261** declared stage `inputs:` contain
**zero** occurrences of `handoff.md`, `retro.md` or `gate-evidence` — they are written for a human
who, on these runs, was never going to open them. `--tldr` says to write no `tldrx note`
(133,689 B of them across those runs, read back by nothing) and to keep gate evidence at the
template's minimum; a fact that must outlive the turn goes to `tldrx facts add`, which every later
prompt **does** read.

What it may not do is drop the handoff. `claim-sources` is condition 5 of the seven `auto`
conditions and runs whether or not a stage declared it as a check, so a run with no handoff cannot
close an `auto` or `agent` gate — every gate would fall to the person the mode exists to leave
alone. `--tldr` therefore briefs sub-agents to trim the **prose** and never the `[src: …]`
citations, and the mandate says why in as many words.

A mode is **required and never guessed** (exit `1`) — the same refusal `tldrx run attend` makes,
and for the same reason: handing an attended session the unattended text tells it to sign gates
that were never its to sign.

Every command in the mandate names a run, so a run id fills all of them in at once — `<run>` is
never partly substituted, which is the point: a hand find-replace across them only has to miss
one to send a session at the wrong run. Give the id as a positional or as `--run <id>` (the
positional wins if both are passed); it is substituted **textually and never validated**, so an
id that names no run is yours to notice, exactly as it would be had you typed it into each
command yourself. Omit it and the **one** open run of this workspace is used. Where the CLI
would refuse to choose — two runs open — this declines to substitute, leaves `<run>` standing
and names the ids on stderr, because a mandate silently aimed at the wrong run is worse than a
placeholder. With no workspace and no runs at all it still prints, still exits `0`, and still
carries `<run>`. Exits: `0` `1`.

It needs no workspace, opens no run, spawns nothing and writes nothing. It is versioned with
the package: the header carries the framework version that printed it. The machinery it assumes
is [10 — Unattended mode](10-unattended-mode.md). Exits: `0` `1`.

## `tldrx ship`

Open a pull request from the run's epic branch — one per repo the branch is in — with the run's
handoff as the body.

```
tldrx ship [<run>] [--branch <name>] [--repo <name>] [--base <branch>]
                   [--draft] [--dry-run] [--run <id>] [--root <path>]
```

It NEVER pushes. tldrx does not publish a branch on its own (spec §5), so a branch the remote
has not seen is a refusal that names the `git push` command rather than running it. The body is
the LAST phase handoff the run has on disk — `04-build/handoff.md` on a run that built
something — handed to `gh` as a file, never as an argument, so a long handoff cannot overflow
an argv limit.

When the branch exists in SEVERAL repos — the normal shape of a chained multi-repo run, whose
epics share one integration branch — it opens one PR per repo: the same handoff as the body,
the repo name in the title, and every URL listed at the end. `--repo` narrows that to one, and
`--branch` picks between epic branches when the run cut more than one (it must be one of the
run's own; an unrelated branch is refused). `--base` overrides what the PR opens against,
which defaults to that repo's `default_branch` from `.tldrx/workspace.yml`. A partial failure
names both sides — the PRs that were opened, with their URLs, and the repos that failed, with
the reason — and re-running retries the rest, skipping any repo whose PR is already open.

`--dry-run` runs every check and prints the exact `gh` command, creating nothing. It is
read-only about the run either way: no event, no gate, no cursor. To mirror the plan's epics
and stories to a ticket tool, `tldrx tickets sync` is the verb that does that, and it stays
separate. It refuses cleanly, in a sentence, when there is no epic branch, no handoff, no
remote, no `gh` on PATH, or when several epic branches leave the choice open.
Exits: `0` `1` `2` `3`.

## `tldrx watch`

```
tldrx watch list  [--json] [--run <id>] [--root <path>]
tldrx watch check [<feature>] [--execute] [--run <id>] [--root <path>]
tldrx watch arm   [--interval <s>] [--timeout <s>] [--branch <name>] [--repo <name>]
                  [--run <id>] [--root <path>]
```

`check` is the post-merge checklist (#65). It prints each card's `## Signal` items as a
numbered list with the repo that owns each one, plus `## Where`, the healthy baseline, what
broken looks like, and the `## Query` block — and it re-validates the card while it is there:
every `[src: …]` still resolves, and the stamped `status:` still equals what its `## Signal`
sources earn. Omit `<feature>` and every card in the run is checked; name one to scope it.

**Only a `$ <cmd> → exit <n>` signal is runnable**, and only when `.tldrx/workspace.yml`
declares that exact command in a repo the item or the card names unambiguously. `--execute`
re-runs those and reports the exit each gets now against the exit the card recorded; without
it nothing is run. A `## Query` block is never runnable — it belongs to the console named
under `## Where`.

**A citation that resolves only on the epic is NAMED, never failed (#143).** `watch` resolves a
card's `file` sources with this run's recorded epic refs switched on, so a card may legitimately
cite code no merged ref has — the Watch stage's whole subject is code nothing has merged. `check`
prints `on unmerged refs: 4 (epic/money-and-payments — unmerged)` beside the card's status, `list`
prints the same phrase in a footer naming each card, and `list --json` carries `unmerged_refs` per
card plus an `unmerged` count. None of it changes a verdict: a card whose only remark is this one
is still `ok` and still exits `0`. It exists so a card committed to the trunk cannot point a reader
at paths that are not there and say nothing.

**It exits `1` when a citation no longer resolves**, or when an executed command disagrees
with the card — a check that reported rot on stdout and exited `0` would be invisible to CI.
`3` for an unknown feature (naming the ones that exist), for a run whose Watch stage never
ran, and for a Watch stage that wrote no card; those last two are different sentences because
they need different actions.

**An owner may be a person.** With nothing declared, the owner printed beside a Signal item is
DERIVED from that item's own citation — `[src: api:src/Leaderboard.cs:64]` → `api` — which
answers "which repo emits this" rather than "who gets paged". Since #70 a card may say: an
optional front-matter `owner:`, or `(owner: <name>)` on an individual item, written before its
`[src: …]` token. Resolution is item → card → repo-derived, and the printed line says which it
is showing. Both forms are optional; a card that declares neither reads exactly as it did
before.

`arm` (#69) is `check` with a trigger in front of it: a **bounded foreground poller**, not a
daemon. It reads the branch Build cut (`build.epic_branch` in `run.yml` — the same list
`tldrx ship` picks from), asks `gh pr view <branch> --json state,mergedAt` in every repo of the
run that has the branch, and prints the `check` checklist the moment they have all merged. It
never pushes, opens or merges anything, and `--execute` is not offered: an hour-old poller must
not start running build commands the instant a merge lands.

Three bounds hold it: `--timeout <s>` (default 3600, max 86400), `--interval <s>` (default 60;
under 10 is REFUSED rather than quietly raised), and a poll cap that holds even if the clock
does not move. No epic branch, no PR for the branch, and a PR `CLOSED` without merging are all
refusals with a sentence in them (`2`); a window that expires with the PR still open exits `4`
and prints the command that re-arms it. Exits: `0` `1` `2` `3` `4`.

## `tldrx tickets`

Mirror the plan's epics and stories to a ticket tool. The files stay the source of truth.

```
tldrx tickets sync   [--run <id>] [--apply] [--dry-run] [--provider github|jira]
tldrx tickets status [--run <id>]
```

**Preview is the default.** `--apply` is what writes, because this is the only verb in the
tool that reaches a third party; `--dry-run` is an explicit alias for the default and also
cancels an `--apply` on the same line. `--provider` picks between configured providers and
cannot switch on a workspace set to `ticket_tool.kind: none`. No `--json`. Exits:
`0` `1` `2` `3`.

## `tldrx hook` / `tldrx statusline`

```
tldrx hook <script>      # payload on stdin, decision on stdout
tldrx statusline
```

`hook` runs one hook script — `dist/hooks/<name>.js` when tldrx is running from `dist/`,
`src/hooks/<name>.ts` in a source checkout — and passes stdin, stdout, stderr and the exit
code through unchanged. Everything after the script name is forwarded to it, so this command
judges no flags of its own; an unknown name exits `1` and lists the real ones. `statusline` is
the same for `src/hooks/statusline.ts`, which is wired to the `statusLine` **settings key**
rather than to a hook event, and always exits `0`.

## `tldrx --version` / `tldrx --help`

`--version` prints the version read from `package.json`. `--help` prints the command list, the
`--ui` legend, the exit-code table and the loop in five lines. Both exit `0`.
