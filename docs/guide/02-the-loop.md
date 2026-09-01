# 2 — The loop

## One loop, five phases, everything on disk

Every phase is the same loop — **Investigate → Handoff → Interview → Gate** — run by a
facilitator that only ever reads and writes files. The files ARE the state, the
dashboard, the resume point and the memory.

- **Investigate** — read code, docs and memory. Every finding carries a source.
- **Handoff** — one `.md` per stage: what was found, what was decided, what is still unknown.
- **Interview** — only the unknowns become questions; answers land in `.tldrx/memory/facts.yml`.
- **Gate** — the stage stops. Who closes it is policy, recorded in `run.yml` + `events.jsonl`.

The five phases are that loop with different inputs, outputs and experts:
**what · how · plan · build · watch**. `stages/<slug>/stage.yml` declares which;
`workflows/<scope>.yml` declares the order.

```bash
tldrx init                 # detect the workspace, map the code, ask only the gaps
tldrx run new --scope X    # open a piece of work
tldrx next                 # run the next stage; it stops at a gate
tldrx answer / approve     # answer the unknowns, approve the gate
tldrx retro                # close the run and keep what was learned
```

## What a stage file controls

`stage.yml` is the contract; `stage.md` is the handoff template the sub-agent is given.
The keys a stage may set, and what they do:

| Key | Default | What it does |
|---|---|---|
| `name` `title` `phase` `model` `budget_usd` | required | Identity, which model, what the stage may spend |
| `effort` | unset (the CLI's own default) | `low\|medium\|high\|xhigh\|max` — the cost lever `--max-usd` is not |
| `inputs` / `outputs` | required | Declared inputs are inlined; declared outputs are re-read off disk after the run |
| `experts` | required | Names a stage loads explicitly (rule 1 of three — see [4 — Experts](04-experts.md)) |
| `stack_experts` | `true` | Also load `<language>-stack` for the run's repos |
| `knowledge_max_bytes` | 48 KB | Trained knowledge inlined for **all** loaded experts together |
| `inputs_max_bytes` | 96 KB | Ceiling on the content of every declared input, filled first |
| `prompt_max_bytes` | 160 KB | Over it the stage is **refused** (exit 2) before anything spawns |
| `max_reads` | 120 (200 build, 60 watch) | Completed `Read`/`Glob`/`Grep` calls before the sub-agent is stopped |
| `dry_run_allowed` | `true` | `false` refuses `tldrx next --dry-run` on this stage |
| `gate.type` | required | `approve` \| `checks` \| `auto` |
| `checks` | none | The list that is actually enforced, re-run off disk by `tldrx approve` |
| `preconditions` | none (≤10) | `{id, repo, command, expect_exit, timeout_s}` — an operational fact checked **before** the stage is dispatched. Same allowlist rule as a `cmd` check; `expect_exit` defaults to `0` and `timeout_s` to **60 s**, never the stage's. A red one is exit `2` before anything is spent ([10 — Unattended mode](10-unattended-mode.md)) |

`expert_knowledge_bytes:` is the retired spelling of `knowledge_max_bytes` and is still
read, as the same **total**. `skip_if` and `questions.max` come from the workflow entry
(`workflows/<scope>.yml`), not from `stage.yml`.

## Two execution modes, one code path

`tldrx next` can do the work itself or supervise someone else doing it, and it judges both
by the same rules.

**Headless** — `tldrx next` — spawns `claude -p --output-format stream-json --verbose
--json-schema …` through the runtime seam, with `--allowedTools` limited to the file tools
plus one `Bash(<command>)` grant per command `workspace.yml` declares, and
`--dangerously-skip-permissions` only when you pass `--yolo`. Use it from a terminal, CI
or a chat bridge.

**In-session** — `tldrx next --prepare` then `tldrx next --commit` — writes the same prompt
bundle to `tldrx-work/<run>/.agent/<stage>/` and lets the Claude Code session you are
already in dispatch its own sub-agent. Cheaper, because that context is already warm, and
it works where spawning is disallowed.

That is a decision per invocation. A whole run can be pinned to it — `attended_by: host`,
where the framework never spawns at all and every turn, the Build reviewer included, is the
host session's. See [10 — Unattended mode](10-unattended-mode.md).

From "re-read the declared outputs off disk" onwards the two are literally the same
function: same output validation, same `checks`, same cost roll-up, same gate. The agent's
structured envelope (`{outputs, questions_asked, notes}`) is a report, never evidence — a
file exists or it does not.

Nesting was the open question and it is measured (2026-08-29): `claude -p` runs fine from
inside a Claude Code Bash tool. What bites is the ceiling, not the nesting — a cold session
pays ~10–26k cache-creation tokens before its first reply, so a `--max-budget-usd` under
about $0.25 fails as `error_max_budget_usd` before any work happens.

## What you see while it runs

The four commands that spawn a sub-agent and leave you waiting — `tldrx next`,
`tldrx run auto`, `tldrx expert train`, `tldrx seed triage --propose` — show a progress
view on **stderr**. Three modes, chosen with `--ui` or `TLDRX_UI`, `auto` by default:

| Mode | When `auto` picks it | What it is |
|---|---|---|
| `scene` | stderr is a terminal, at least 72x20 | a classroom: blackboard, wall clock, student, teacher |
| `compact` | stderr is a terminal, smaller than that | one line, rewritten in place |
| `plain` | a pipe, a file, CI, or `NO_COLOR` set | `[03:41] reading api/src/Outbox.cs` |
| `off` | never — ask for it | nothing at all |

```
⠦ 03:41 writing tldrx-work/260829-tenancy/01-what/h… · $0.00/$6.00
```

Nothing on that screen costs anything. `claude` is spawned with
`--output-format stream-json --verbose`, and every line is derived from events it was
already sending: `Read` → `reading …`, `Bash` → `$ dotnet test → running` and then
`→ ok (12 s)` when the tool_result comes back, `Grep` → `grep "Outbox"`, an assistant
paragraph → its first sentence. There is no second model call and no summary agent.

The dollar figure is what has actually been **recorded**, not an estimate: `claude` reports
a cost when a turn finishes, so a single stage sits at `$0.00` until its result lands, and
across a `run auto` loop the figure climbs stage by stage.

Two rules the view keeps in every mode:

- **stdout is never written to.** Every progress byte goes to stderr, so
  `tldrx next --prepare | jq`, `tldrx run status --json` and a chat bridge read exactly the
  bytes they read before this existed.
- **the cursor always comes back.** Hidden while a scene is on screen; restored on a normal
  exit, on a thrown error and on Ctrl-C.

`--prepare`, `--commit` and `--dry-run` spawn nothing, so they show nothing — a view of an
empty stream would be a decoration that lies.

Ctrl-C (SIGINT/SIGTERM) kills the sub-agent's whole process tree, records a partial
`agent.result` with `cost_usd: null` and `stopped_by: "signal"`, demotes the stage to
`ready`, releases the `.lock` and exits `130`.

## Layout

```
bin/tldrx.ts          entrypoint — parses nothing, decides nothing
scripts/build.ts      bundles bin/ + src/hooks/ into dist/ for node (hooks share one chunk)
src/cli/              command table + one file per command + helpText.ts (the flag registry)
src/core/runtime/     the Bun/Node seam — the only place `Bun.` appears
src/core/run/         run.yml, budget.yml, the run lifecycle and its gates
src/core/budget/      ceilings, the phase table, and the one sanctioned edit to them
src/core/plan/        epics + stories + waves.yml, checked together at the Plan gate
src/core/dashboard/   model.ts reads the files, render.ts draws them, server.ts serves them
src/core/distill/     the `--from` AI-DLC importer
src/core/seed/        the `--seed` importer, and `seed triage`/`seed apply`
src/core/answers/     recording an answer — shared by the hook and the CLI
src/core/interview/   the terminal Interview: line reader, prompt, one loop over the answers
src/core/install/     `install --claude` — the settings merge and its exact inverse
src/core/status/      `tldrx status` — the four sources of pending work, as one list
src/core/schemas/     types + a tiny validate() per file kind
src/hooks/            the runnable hook scripts
plugin/               Claude Code plugin packaging (manifest, skill, hooks.json)
stages/<slug>/        stage.yml (contract) + stage.md (handoff template)
workflows/<scope>.yml the 13 scope presets
templates/            the file shapes `tldrx init` will write
env.yml               the manifest `tldrx doctor` runs
```

Per project, the framework writes into `.tldrx/` (framework state) and
`tldrx-work/<yymmdd>-<slug>/` (one folder per piece of work). `tldrx init` creates the
first; `tldrx run new` creates the second.

## What to commit

**Both of them.** The files are the state, so `.tldrx/` and `tldrx-work/` belong in git —
the map, the facts, the questions and their answers, `run.yml`, `budget.yml`,
`events.jsonl`, the handoffs, the plan. A teammate who clones the repo gets the run.

The block `tldrx init` appends to `.gitignore` excludes a short list and nothing else,
because every line on it is machine-local, regenerated, or a backup git already keeps
the history of:

```
.tldrx/graphify-out/               regenerated by `tldrx map --refresh`
.tldrx/cache/                      static dashboard exports, training prompt bundles
.tldrx/worktrees/                  real checkouts of branches that ARE committed
tldrx-work/*/.lock                 one live pid
tldrx-work/*/.agent/               one in-flight prompt bundle
tldrx-work/*/*.bak                 the version the last save replaced
.tldrx/memory/*.bak                the same, for facts.yml
.claude/settings.json.bak-tldrx-*  what `tldrx install --claude` merged into
```

The same block opens with `!tldrx-work/**` and `!.tldrx/**`, which re-include the state
against a rule your project already had — a .NET repo's stock `[Ll]og/` ignores
`tldrx-work/<run>/04-build/log/<story>.md`, and git says nothing while it does. The
lines above come after the negations, so they still win. `tldrx doctor` asks
`git check-ignore` about four of these paths and names any rule still hiding one.

## Schema versions

Every data schema — the files a workspace or a run owns — opens with `version: 1`.
`schema_version:` was the pre-spec spelling: a file still saying it **loads** for one more
release, prints `<file>: schema_version is deprecated — say version: 1` on stderr once per
process, and is listed by `tldrx doctor`. Nothing writes it any more. The stage and
workflow libraries carry no version key: they are the framework's own configuration,
versioned with the package.

## Design notes

**Bun to build, Node or Bun to run.** Every host capability that differs between the two
runtimes — stdin, spawn, file IO, YAML — lives behind `src/core/runtime/`, which picks its
implementation at import time from `typeof Bun`. `yaml` is a devDependency on purpose:
`bun build --target=node` inlines it, so a published install still resolves zero runtime
dependencies. The invariant that keeps the seam honest is mechanical:

```bash
grep -rn 'Bun\.' src | grep -v src/core/runtime/    # must print nothing
```

`run.yml`, `budget.yml` and `facts.yml` are emitted by hand-written serialisers rather than
a generic YAML writer, because the two runtimes disagree on layout and these files are
committed and diffed. Same input, same bytes, either runtime.

**Claude Code shapes are copied, not remembered.** Every plugin manifest field, hook event
name, skill frontmatter key and statusLine field in this repo was taken from the official
docs during the session that wrote it, and the source URL sits in a comment next to the
shape:

- <https://code.claude.com/docs/en/plugins.md>
- <https://code.claude.com/docs/en/hooks.md>
- <https://code.claude.com/docs/en/skills.md>
- <https://code.claude.com/docs/en/statusline.md>

Anything that could not be confirmed from those pages is marked `TODO(verify)` rather than
guessed. Find them with `grep -rn 'TODO(verify)' .`.

**The prompt is ordered for the cache** — stage rules and expert blocks first (stable),
declared inputs and the previous attempt last (volatile). Measured: two real `claude` calls,
same 40,715-byte prompt, separate processes — the first wrote 37,059 cache tokens and cost
**$0.074982**; the second read all 37,059 back and cost **$0.004550**.
