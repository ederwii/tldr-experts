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
`.gitignore` rule ignoring one, with its `file:line`. That is a warning: it never moves the
exit code. Exits: `0` `1`.

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

Create a piece of work, look at one, drive one to its next human gate, or get a stuck one
moving again.

```
tldrx run new <slug> [--title <t>] [--scope <s>] [--budget <usd>] [--repos a,b]
                     [--from <dir> | --seed <file|dir> …] [--gates <a,b|all|none>]
tldrx run status   [<run>] [--json] [--run <id>]
tldrx run estimate [<run>] [--json] [--run <id>]
tldrx run auto     [<run>] [--max-usd <n>] [--until <stage>] [--model <m>] [--effort <level>]
                          [--yolo] [--ui <mode>]
tldrx run unlock   [<run>] [--force]
tldrx run cancel   [<run>] --note <text> [--force]
```

**`new`** — `--scope` is one of the workflow stems on disk: `bugfix` `docs` `feature`
`hotfix` `integration` `migration` `performance` `prototype` `refactor` `retro`
`security-patch` `spike` `upgrade` (default `feature`). `--budget <usd>` defaults to the
preset's `default_budget_usd`. `--from` and `--seed` are mutually exclusive; **`--seed` is
repeatable**. `--gates` names the HUMAN gates and overrides the workflow's `gates:` wholesale.

**`status`** with several runs open LISTS them and exits `0` — it is the screen you read to
find the id every other command wants.

**`estimate`** is the one command here that GUESSES, and it says so in its own output. For
what was actually spent, use `tldrx cost`.

**`auto`** loops `next` until a human gate or open question (`4`), a failure (`5`), a budget
refusal (`2`), `--until` reached or the run finished (`0`). `--max-usd` is a ceiling on the
LOOP's spend, checked between stages. Headless only.

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
tldrx next [<run>] [--run <id>] [--dry-run] [--prepare|--commit] [--model <m>] [--effort <level>]
           [--max-usd <n>] [--prompt-max-bytes <n>] [--max-reads <n>] [--cost-usd <n>]
           [--tokens <n>] [--yolo] [--keep-worktrees] [--discard-pending] [--reuse-epic]
           [--ui <mode>] [--root <path>]
```

| Flag | Meaning |
|---|---|
| `--dry-run` | Say which stage would run, with its inputs and budget. Spawns nothing, writes nothing |
| `--prepare` | Write the prompt bundle and stop, spawning nothing |
| `--commit` | Record the result of a `--prepare` cycle run by hand. Spawns nothing |
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

`--prepare` and `--dry-run` print the CONTEXT LEDGER. Exits: `0` `1` `2` `3` `4` `5`.

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
tldrx answer <Qid> <text> [--run <id>] [--root <path>]
```

Exits: `0` `1` `3`.

## `tldrx interview`

Work through the open questions in the terminal, one at a time.

```
tldrx interview [--run <id>] [--init] [--yes-to-defaults] [--root <path>]
```

`--init` answers `.tldrx/init-questions.md` instead of a run's `questions.md`. **This is the
only way to answer the INIT questions**: editing the file by hand fills the slot but records
no fact and writes no `process.yml`. `--yes-to-defaults` takes the first option of every
question that offers one. Piped stdin is one answer per line. Exits: `0` `1` `2` `3`.

## `tldrx questions lint`

Check that this run's `questions.md` can be read by the §2.7 parser.

```
tldrx questions lint [<run>] [--run <id>] [--fix] [--area <a>] [--root <path>]
```

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
tldrx approve [--note <text>] [--run <id>] [--root <path>]
```

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

## `tldrx story`

Give one Build story another run of attempts.

```
tldrx story reopen <id> --note <text> [--run <id>] [--root <path>]
```

`--note` is required — a reopen with no reason is not actionable. The story goes back to
`todo`, its attempt counter restarts at 1 of 2, and one `story.reopened` is appended carrying
the actor, the note, the status it came from and how many verdicts the closed run of attempts
consumed. Nothing is erased to make the reset true: `story.reopened` is a boundary the review
ledger reads, and every earlier attempt stays in `events.jsonl`. It runs no agent, spends
nothing, deletes nothing and refunds nothing — the story's branch, which carries the last
developer's commits, is untouched. It does NOT send the stage back; the output names the
`reject` that does. Refuses (`2`) an unknown story id, a `done` story (that is
`reject --stage`), a `todo` story, and a missing `--note`. Exits: `0` `1` `2` `3`.

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
`--check` resolves every `[src: <repo:>path:line]` citation in the map and the init handoff
against the filesystem — exit `1` with the offending document, line and reason when one does
not land. `--refresh` appends `map.refreshed` to the newest OPEN run's `events.jsonl` and says
which run it filed under; with no open run it records nothing and still exits `0`. Providers:
`auto` `graphify` `static`. Exits: `0` `1`.

## `tldrx expert`

List or create experts, recompute their levels, or train one. See
[4 — Experts](04-experts.md).

```
tldrx expert list      [--json]
tldrx expert create    <name> [--role <slug>] [--domain <slug>] [--stack <lang>]
tldrx expert train     <name> --area <area> [--mode light|full] [--max-usd <n>] [--model <m>]
                              [--effort <level>] [--prepare|--commit] [--yolo] [--print-prompt]
                              [--ui <mode>]
tldrx expert recompute [<name>] [--json]
```

`train --area` is required. `--mode light` reads the code; `full` also mines finished runs'
handoffs — a role expert only trains `full`. `--print-prompt` prints the training prompt and
stops: it spawns nothing and costs nothing. `recompute` is arithmetic over evidence already
on disk: it spawns nothing, spends nothing, and does not touch `status` or `last_trained`.

Exits, as `tldrx expert --help` prints them: `0` `1` `3`. **`expert train` also returns `2`**
(below the $0.25 spawn floor, or `--mode light` on a role expert) **and `5`** (the knowledge
file failed validation and was quarantined) — `src/core/training/runTraining.ts:114,297,511`.
Those two are missing from the help registry's `exits:` list for `expert`; the codes are real,
the help screen is the thing that is short.

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

Close a run and write down what it learned.

```
tldrx retro [<run-id>] [--apply] [--root <path>]
```

No model runs. `--apply` also appends the practice proposals to `.tldrx/memory/practices.md`,
idempotently. Exits: `0` `1` `2` `3`.

## `tldrx watch`

```
tldrx watch list  [--json] [--run <id>] [--root <path>]
tldrx watch check <feature> [--run <id>] [--root <path>]
```

`check` re-validates one watcher card off disk: every `[src: …]` still resolves, and the
stamped `status:` still equals what its `## Signal` sources earn. **It exits `1` when a
citation no longer resolves** — a check that reported rot on stdout and exited `0` would be
invisible to CI. `3` for an unknown feature, naming the ones that exist. Exits: `0` `1` `2` `3`.

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
