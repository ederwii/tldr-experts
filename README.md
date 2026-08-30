# tldr-experts

[![npm](https://img.shields.io/npm/v/tldr-experts?label=npm%20tldr-experts)](https://www.npmjs.com/package/tldr-experts) [![ci](https://github.com/ederwii/tldr-experts/actions/workflows/ci.yml/badge.svg)](https://github.com/ederwii/tldr-experts/actions/workflows/ci.yml) ![status](https://img.shields.io/badge/status-alpha-orange)

**Status: alpha** — the v0 loop (What → How → Plan, hooks, distill, seed, budgets), the Build and Watch phases and the live dashboard are released; expert training runs as of 0.3.0, and ticket/chat adapters are landing wave by wave (see `docs/ROADMAP.md`; released versions in `CHANGELOG.md`).

Every command in the table below is implemented and verified by running it. Nothing here prints success for work it did not do: a
command that cannot do the thing exits non-zero and says which thing.

A lightweight, file-based AI development workflow. Open source, tool-agnostic in
design, piloted on Claude Code.

> **One loop, five phases, everything on disk.**
> Every phase is the same loop — *Investigate → Handoff → Interview → Gate* — run by
> a facilitator that only ever reads and writes files. The files ARE the state, the
> dashboard, the resume point, and the memory.

## Start here

> **Not on npm yet.** Every published version was unpublished on
> 2026-08-29 (`npm view tldr-experts version` → `E404 Unpublished`), and there is
> no `v0.3.0` tag yet, so the two `npm i -g` lines below will 404 until
> `scripts/release.sh 0.3.0` is run. Until then: clone the repo and
> `bun link`, or `bun <repo>/bin/tldrx.ts <command>`.

```bash
npm i -g tldr-experts && cd your-project && tldrx init && tldrx install --claude
```

Then open Claude Code in that project and type **`/tldrx`**. It runs
`tldrx status`, finds what is already waiting on you — setup questions nobody
answered, a proposed split nobody decided, a run waiting on a gate, an expert no
stage can lean on yet — and walks you through it one item at a time, asking you
every decision that is yours and running only the steps that are mechanical.

## Quick start

```bash
npm i -g tldr-experts          # installs the `tldrx` command (alias: `tldr-experts`) — 404s until v0.3.0 is tagged and published
tldrx doctor                   # check the local environment first — it is the authority

cd your-project
tldrx init                     # detect repos, map the code, write .tldrx/, ask only the gaps
tldrx run new payments --scope feature --budget 5
tldrx next                     # run the next stage; it stops at a gate or a question
tldrx run status               # where the run is, what it is waiting on, what it cost
tldrx answer Q1 "the answer"   # answer what it asked
tldrx approve                  # re-runs the stage's checks, then advances the cursor
```

**Runtime: Node ≥ 20 or Bun.** The published package is a pre-built bundle with
zero runtime dependencies, so an installed `tldrx` needs only Node. Bun is
required to *build* from source, not to run.

## Two execution modes

`tldrx next` can do the work itself or supervise someone else doing it, and it
judges both by the same rules. **Headless** — `tldrx next` — spawns `claude -p`
itself; use it from a terminal, CI or a chat bridge. **In-session** — the `/tldrx`
skill runs `tldrx next --prepare`, the Claude Code session you are already in
dispatches its own sub-agent against the prompt bundle, then `tldrx next --commit`
picks it up. In-session is cheaper (that context is already warm) and works where
spawning is disallowed. From "re-read the declared outputs off disk" onwards the
two are literally the same function — see [Design notes](#design-notes).

## What you see while it runs

A stage can take four minutes. It used to say nothing for all of them. Now the
commands that spawn a sub-agent and leave you waiting — `tldrx next`,
`tldrx run auto`, `tldrx expert train`, `tldrx seed triage --propose` — show a
classroom: a blackboard with the last six things the agent did, a wall clock, a
student who moves while a tool is running, and a teacher who says something when
the model does. Captured at 80x24, mid-stage:

```
+----------------------------------------------+      .---.
| what · 260829-tenancy · attempt 1            |    /       \
+----------------------------------------------+   |    ·    |
| reading api/src/Outbox.cs                    |    \ \     /
| grep "Outbox"                                |      '---'
| The tenancy boundary is the row filter, not… |      03:41
| $ dotnet test tests/Unit → running           |
|   → ok (12 s)                                |
| writing tldrx-work/260829-tenancy/01-what/h… |
+----------------------------------------------+

     ,-----.            .-------.
    ( ##### )           | o   o |
     '--|--'            |   -   |
     /  |  |            '---+---'
  __/  [~]  \__        __/     \__
 |_____________|      |___________|
   ||       ||         ||       ||

  $0.00 of $6.00 · Ctrl-C stops after this turn
```

Nothing on that screen cost anything. `claude` is spawned with
`--output-format stream-json --verbose`, and every line is derived from the
events it was already sending: `Read` → `reading api/src/Outbox.cs`, `Bash` →
`$ dotnet test → running` and then `→ ok (12 s)` when the tool_result comes back,
`Grep` → `grep "Outbox"`, an assistant paragraph → its first sentence. There is
no second model call and no summary agent.

The dollar figure is what has actually been **recorded**, not an estimate:
`claude` reports a cost when a turn finishes, so a single stage sits at `$0.00`
until its result lands, and across a `tldrx run auto` loop the figure climbs
stage by stage. A number this tool has not measured is not put on the board.

Three views, chosen with `--ui` or `TLDRX_UI`, `auto` by default:

| Mode | When `auto` picks it | What it is |
|---|---|---|
| `scene` | stderr is a terminal, at least 72x20 | the classroom above |
| `compact` | stderr is a terminal, smaller than that | one line, rewritten in place |
| `plain` | a pipe, a file, CI, or `NO_COLOR` set | `[03:41] reading api/src/Outbox.cs` |
| `off` | never — ask for it | nothing at all |

`compact` is the same state on one row:

```
⠦ 03:41 writing tldrx-work/260829-tenancy/01-what/h… · $0.00/$6.00
```

Two rules the view keeps, whichever mode it is in:

- **stdout is never written to.** Every progress byte goes to stderr, so
  `tldrx next --prepare | jq`, `tldrx run status --json` and the chat bridge read
  exactly the bytes they read before this existed.
- **the cursor always comes back.** Hidden while a scene is on screen, restored
  on a normal exit, on a thrown error, and on Ctrl-C.

`--prepare`, `--commit` and `--dry-run` spawn nothing, so they show nothing —
a view of an empty stream would be a decoration that lies.

## The loop, in five lines

```bash
tldrx init                 # detect the workspace, map the code, ask only the gaps
tldrx run new --scope X    # open a piece of work
tldrx next                 # run the next stage; it stops at a gate
tldrx answer / approve     # answer the unknowns, approve the gate
tldrx retro                # close the run and keep what was learned
```

## What an expert contributes to a stage

An expert is a folder, and a stage prompt gets three things out of it. Its `expert.md` — the role, the domain and the
citation rules a human wrote. Its **star chart**, one line per competency area, computed from evidence and never
self-declared (`ef-core  ★★★☆☆ 3  (17 evidence, newest 2026-08-20)`). And its **trained knowledge**: the
`knowledge/<area>.md` files `tldrx expert train` wrote and the framework validated off disk, most-recently-trained
first, up to `expert_knowledge_bytes` per expert (default 64 KB, set per stage). Every bullet on those files carries a
`[src: …]` token that resolved against a real file when the knowledge was accepted, and the prompt tells the sub-agent
so — they are reusable as evidence, verbatim, without re-opening anything. When the budget bites, the cut lands on a
section boundary and the prompt says `… N more findings in .tldrx/experts/<name>/knowledge/<area>.md` rather than
trailing off. Which experts load is three rules: the stage's own `experts:` list, the `<language>-stack` experts of the
run's repos, and any `kind: domain` expert whose declared repos or paths the run touches. `tldrx next --prepare` prints
what each one contributed in bytes; `tldrx expert list` prints which stages load each expert.

Five of those experts are **role experts**, and `tldrx init` seeds all five: `product` (What), `architect` (How and
Plan), `delivery` (Plan), `developer` (Build) and `operations` (Watch) — the names the shipped stage files have always
listed. A role expert's subject is the workflow rather than a folder of code: what its stage is accountable for, what it
must refuse, what it cites and what it hands over. Its body therefore ships as an editable file at
`templates/experts/<role>.md`, copied into `.tldrx/experts/<role>/expert.md` once and yours after that; `init` re-runs
add a missing role and never touch an existing one, and `tldrx expert create <name> --role <slug>` seeds the same thing
on demand (an unknown slug falls back to the generic template with `kind: role`). Because a role has no folder to grep,
`tldrx expert train <role> --mode light` is **refused** (exit 1) rather than paid for — `--mode full` trains it from
`tldrx-work/**/{handoff,retro}.md`, the record of how this workflow actually ran, with one sub-agent instead of two. The
two placeholder names older stage files used, `domain` and `stack`, are retired: they were rules 2 and 3 above written
as though they were folders, and a stage file that still lists them gets one note saying so instead of a NOT LOADED line
on every run.

## Init questions

`tldrx init` detects what it can and writes only the gaps to
`.tldrx/init-questions.md`. Answer them with `tldrx interview --init` rather than by
editing the file — the interview is what writes the footer, the `facts.yml` row and
the two events, and a hand-edited file has none of those.

```bash
tldrx interview --init                            # interactive, one question at a time
printf 'A\nB\nA\nA\n' | tldrx interview --init    # non-TTY: one line per question
```

Piped stdin is read one line per question, in file order: a single letter `A`–`E`
picks that option (the letter is the option's position in the block as the file
prints it), anything else is recorded as free text, a blank line or `s` skips, `q`
stops. A letter with no option behind it is reported and skipped — never turned into
the text "C". Every question left unanswered stays `status: open`.

Two of the questions are about **process**, and their answers are also applied to
`.tldrx/process.yml`: `methodology`, and `ticket_tool.kind` (`jira` / `github` /
`linear` / `none`). For GitHub the `owner/repo` is filled from the git remote when
it can be read, and otherwise a note says to set it by hand; Jira always prints a
note to set the project key by hand; answering "other" leaves `process.yml`
untouched. The last line of the run says which happened —
`process.yml: methodology=none, ticket_tool=github (owner/repo)`, or
`process.yml: unchanged`.

`--yes-to-defaults` answers **every** question with its first option. For the two
process questions that first option is "None", which is a real default; for the
ownership and dead-code questions it is a guess about somebody else's project. It is
a flag for a human in a hurry, not one an agent gets to pass on their behalf.

## Several runs

More than one run can be open at once. When there is exactly one, nothing changes.
When there are several, every run-targeting command — `next`, `answer`, `approve`,
`reject`, `budget`, `interview --run`, `tickets`, `watch`, `retro`, `replay` —
**refuses rather than guessing**, exits `2`, and lists the open runs:

```
tldrx next: 3 runs are open — pass one:
```

Exit `2` there means "you left off the id", not "it broke". Pass one: a positional
`<run>` on `next` and `run status`, `--run <id>` on the rest. `tldrx run status`
with several open prints a table of them all and exits `0` — `--json` returns
`{ "runs": [...] }`, and the single-run shape is unchanged when exactly one is open
— and `tldrx run new` says so when it opens another. `tldrx dashboard` is not on
that list and never was: it draws every run in the workspace, so it has no single
run to be ambiguous about. Hooks never block on the ambiguity, and the status line
appends `(+N open)`.

## Exit codes

One table, defined once in `src/cli/exitCodes.ts` and printed by `tldrx --help`.
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

`4` is the normal end of a successful `tldrx next`: the stage ran, wrote its
outputs, and a person now has to approve. `1` covers both "you asked for something
impossible" and "the check I ran said no", which are the same thing to a shell.
An unknown command or an unknown flag is `1`; `64` is kept for a command that is
genuinely not built, and there are none.

## Big seeds

`--seed docs/` on a 25-document design folder makes one run that pays for 44k
tokens of context at every stage, and one branch for what was several pieces of
work. `tldrx run new --seed` now says so on stderr when that happens:

```
note: seed is 25 files / ~44k tokens — `tldrx seed triage docs/domain-design` can propose a split
```

Three commands, and the boundaries between them are the design:

```bash
tldrx seed triage docs/domain-design            # count it — free, no model, no network
tldrx seed triage docs/domain-design --propose  # ONE cheap pass → split.yml + split.md
tldrx seed apply .tldrx/triage/260830-domain-design/split.yml --dry-run
tldrx seed apply .tldrx/triage/260830-domain-design/split.yml
```

The free pass writes `inventory.md`: per document, its size in tokens, its
headings, which other seed documents it links to or names, its `Status:` line,
its open markers (`TODO`/`TBD`/`open question`/`??`), and whether it is
**code-derived** — meaning it cites paths that actually resolve to files in your
repos, so the model can read the code instead of you paying for the document.

`--propose` spends (one sub-agent, effort `low`, `--max-usd 1.00` by default) and
**never creates a run**. `apply` creates the runs and **never asks a model**. The
human gate is that you ran `apply`: until then `split.yml` says `status: proposed`
and you are invited to edit or delete the runs you disagree with. `--seed` is
repeatable, which is how apply hands each run its own subset.

## What actually works today

| Command | Status | Notes |
|---|---|---|
| `tldrx --version` | **implemented** | Prints the version read from `package.json`. |
| `tldrx --help` | **implemented** | Lists every command with its one-line summary. The `* = not implemented` legend is printed only when a command actually carries the mark — today none do. `tldrx <command> --help` prints that command's usage and exits `0` **without needing a workspace**. |
| `tldrx doctor` | **implemented** | Reads `env.yml`, runs each tool's `check` command, prints a table. Exit `0` when every required tool is present and meets its `min_version`, else `1`. `--mcp` also runs `claude mcp list` (slow — live health checks per server; off by default). |
| `tldrx install --claude` | **implemented** | Puts the facilitator into a real `.claude/` without the plugin and without `init`. Writes `.claude/skills/tldrx/SKILL.md` (a copy of `plugin/skills/tldrx/SKILL.md`, `disable-model-invocation: true` intact, stamped `<!-- tldrx-managed -->`) and **merges** two keys into `.claude/settings.json`: the six hooks as eight handlers with the plugin's exact matchers, each `tldrx hook <name>`, and `statusLine: {type: "command", command: "tldrx statusline"}`. **Idempotent** — a second run leaves both files byte-identical. It never touches `permissions`, never edits an entry it did not write, never overwrites a `SKILL.md` without the marker (exit `1`), and never replaces a foreign `statusLine` (it prints how to chain the two; `--force-statusline` overrides). `settings.json` is backed up to `settings.json.bak-tldrx-<ts>` before the first write. `--uninstall` removes exactly what was added — `install` then `--uninstall` restores the file byte-for-byte. `--project` (default, refuses outside a git repo) `--user` `--skill-only` `--no-hooks` `--no-statusline` `--dry-run`. Exit `0`/`1`. |
| `tldrx init` | **implemented** | Detects repos/stack/commands → `.tldrx/workspace.yml` (spec §2.1), builds `.tldrx/map/<repo>/{architecture,domains,conventions,commands,hotspots,gotchas}.md` + `map/workspace.md`, writes `.tldrx/init-handoff.md` (§2.8) and `.tldrx/init-questions.md` (§2.7, only real gaps), seeds experts at level 0 (§2.6), writes `conventions/`, `process.yml` (§2.12) and an empty `facts.yml`, and appends a marked block to `.gitignore` and `CLAUDE.md`. Deterministic: filesystem + `git` only, no LLM and no network. Re-running regenerates detection output and **keeps** `facts.yml`, `experts/`, `process.yml`, `conventions/*.md` and an answered questions file. Always seeds the **five role experts** the shipped stage files name — `product`, `architect`, `delivery`, `developer`, `operations` — with `kind: role` and the editable body from `templates/experts/<role>.md`; re-running adds a role that is missing and never overwrites one that exists. **Greenfield** — a single repo with zero code files (`detect/codeFiles.ts` defines the extension set) — is recorded as `mode: greenfield`, said out loud in `architecture.md` with an `absent:` source rather than described as an architecture, and asks two extra questions: which stack the project will use, and which document holds the requirements. Flags: `--root <path>` `--out <path>` `--no-interview` `--process <scrum\|kanban\|shape-up\|none>` `--stack <ts,dotnet,python,go,rust,…>` `--mcp` `--provider <auto\|graphify\|static>`. Exit `0`/`1`. |
| `tldrx status [--json]` | **implemented** | Everything in this workspace that is waiting on a human, in the order the sources block each other: open questions in `.tldrx/init-questions.md`, every `.tldrx/triage/*/split.yml` still `status: proposed` (its runs, its unanswered `questions`, the seed documents whose own `Status:` line still says `proposed`, any `DECISIONS*.md`), every open run with the exact command it needs, and every expert a stage will load with zero evidence. Each item prints as `[n] <one sentence> → <exact command>`; `--json` gives `{root, pending, items[]}` with `{kind, summary, command, details}` per item — the shape `/tldrx` walks. Runs are **dependency-aware**: a run whose `triage.depends_on` sibling is not `done` shows `blocked by <slug>` and is offered no command, and the first runnable one is marked `← next`. A run folder that does not validate gets its own item rather than vanishing. Deterministic and read-only — no model, no network, nothing written. Exit `0` whatever it finds (it is a report); `3` only when there is no `.tldrx/` at all. `tldrx next` with no run open prints the same report before its exit-3 line. |
| `tldrx next [<run>]` | **implemented** | The facilitator (spec §5). Takes `.lock` (a live pid refuses with `2`; a dead one demotes the crashed `running` stage back to `ready`), resolves the cursor, honours `awaiting_gate`/`awaiting_answer` (exit `4`), evaluates `skip_if`, refuses a stage the phase budget cannot cover (exit `2` + `budget.blocked`), checks required inputs exist (exit `1`), assembles the prompt, spawns one sub-agent, then re-reads every declared output **off disk**, re-runs the stage's `checks`, rolls the cost into `run.yml`+`budget.yml` and either requests the gate (exit `4`) or advances the cursor (exit `0`). A failure is exit `5`, and the cost is recorded, never refunded. Run again on a `failed` stage and it **retries that stage** — spec §5: `stage.failed` never advances the cursor. A phase with a **stage executor** (`04-build`, `05-watch`) replaces only the middle step — everything either side is the same code. Flags: `--dry-run --prepare --commit --model --effort --max-usd --yolo --keep-worktrees --ui --root`. While it runs it shows a [progress view](#what-you-see-while-it-runs) on stderr — `--ui scene|compact|plain|off`, `auto` by default; stdout is byte-identical with it on or off. |
| `tldrx next --dry-run` | **implemented** | Runs the stage, keeps `handoff.md`, reverts every other declared output, records `stage.skipped`. Refused when the stage sets `dry_run_allowed: false`. |
| `tldrx next --prepare` / `--commit` | **implemented** | In-session mode. `--prepare` writes `.agent/<stage>/{prompt.md,pending.json}`, prints **one line per loaded expert** (`expert product (stage) — expert.md 280 B, knowledge 1.1 KB over 2 areas`, plus `truncated` when the budget bit, plus `NOT LOADED` for a name with no folder) followed by three lines of instructions, and records the same numbers in `pending.json`'s `experts:` array; `--commit` reads `.agent/<stage>/result.json` and continues down the identical validation path. An expert with zero evidence anywhere earns one **stderr** note naming its train command — never a block, never a different exit code. |
| `tldrx next` on `04-build` | **implemented** | The **wave executor** (spec §5, concept §9). Reads `03-plan/{waves.yml,stories/*.md,epics/*.md}` and, wave by wave and story by story: ensures `epic/<slug>` off the repo's `default_branch`, opens a worktree at `.tldrx/worktrees/<repo>/<story-id>` on `story/<id>`, spawns ONE developer sub-agent with cwd inside it (`--allowedTools` = file tools + only **that repo's** `workspace.yml` commands + `Bash(git add *)`/`Bash(git commit *)`; no push, ever), then **re-runs the story's ```dod block itself** in that worktree, commits anything left over as `feat(<story-id>): <title>`, merges `--no-ff` into the epic, and hands the diff to a read-only reviewer (`Read`/`Grep`/`Glob`/`Bash(git diff *)`). `done` needs DoD green **and** an approval, and writes its proof into the story's `evidence:` — `$ <cmd> → exit 0`, the commit sha, the review path. A `changes` verdict requeues the story once with the review under `## Previous attempt`; a second blocks it. A red DoD or a merge conflict blocks that story (merge aborted, conflicting paths recorded as evidence) and the wave carries on. Refuses a dirty repo before cutting anything (exit `2`), refuses `--dry-run`, and never merges an epic into a default branch — the phase ends at a human gate listing the epic branches. Worktrees are removed at `done`/`blocked` unless `--keep-worktrees`. Budget: `min(stage ÷ stories, per_agent_max_usd, --max-usd)` per developer, a quarter of that per reviewer. `--prepare`/`--commit` is one story per cycle. |
| `tldrx map [--refresh\|--check]` | **implemented** | `--refresh` re-detects and rewrites `.tldrx/map/**`. `--check` resolves every `[src: <repo:>path:line]` citation in the map and the init handoff against the filesystem — exit `0` when they all land, `1` with the offending document, line and reason when they do not. Map providers: `graphify` when the binary is on PATH (runs only `graphify --version` and `graphify update <path> --no-cluster`, both documented, no LLM), otherwise `static` (file tree, manifests, 90-day `git log --numstat` churn, largest files). Which one ran is recorded as `provider:` in `workspace.yml`. |
| `tldrx run new <slug>` | **implemented** | Seeds `tldrx-work/<yymmdd>-<slug>/` from `workflows/<scope>.yml` + each `stages/<id>/stage.yml`: `run.yml`, `budget.yml`, `events.jsonl` and the phase folders. Per-phase ceilings are proportional to the stages' `budget_usd`, scaled to `--budget` (or the preset default). The scope's `gates:` block (who closes each gate — see *How much human is in the loop*) is resolved and frozen into `run.yml` as `gates_policy:`; `--gates <a,b\|all\|none>` overrides it and **names the HUMAN gates**, refusing a stage the workflow does not list. Flags: `--title --scope --budget --repos --from --seed --gates` (`--from` and `--seed` are mutually exclusive; **`--seed` is repeatable** — several are merged, deduped and re-sorted, with the 50-file cap applied to the merged set). Writes to a temp dir and renames, so a validation failure leaves nothing behind. Exit `0`/`1`. |
| `tldrx run auto [<run>]` | **implemented** | The headless loop: `next`, over and over, until a human gate or an open question (`4`), a failure (`5`), a budget refusal (`2`), `--until <stage>` reached or the run finished (`0`). Holds no state — every iteration re-reads `run.yml`, so killing it leaves a run `tldrx next` picks up unchanged. One stdout line per stage, read off the events each invocation appended (so a `skip_if` stage gets its own line rather than being swallowed): `01-what/what … done $1.21 · auto-approved`. `--max-usd` is a ceiling on the LOOP's total spend on top of every stage's own, checked between stages, so it can overshoot by at most one stage's share. Flags: `--max-usd --until --model --effort --yolo --ui --root`. Headless only. One scene persists across the whole loop, re-titled at every stage boundary, and each stdout line is printed with the view erased and repainted around it. While it runs it shows a [progress view](#what-you-see-while-it-runs) on stderr — `--ui scene|compact|plain|off`, `auto` by default; stdout is byte-identical with it on or off. |
| `tldrx run new --from <dir>` | **implemented** | The §6 AI-DLC distill. Reads only the listed files, turns every bullet/paragraph under a heading into a Finding tagged `[src: aidlc:<file>:<line>]` and every answered `## Q<n>.` block into a fact plus a Finding tagged `[src: aidlc:<file>#Q<n>]`. Unanswered blocks and ceremony stages are dropped; a claim contradicting a non-retired fact becomes a question in `01-what/questions.md`. A claim that **agrees** with a fact already held (same area, Jaccard ≥ 0.9) reuses it rather than appending a second copy, so importing the same folder twice leaves `facts.yml` byte-identical. Deterministic — no LLM, no network. |
| `tldrx run new --seed <file\|dir>` | **implemented** | The §6.1 generic document import — one `.md`/`.txt` file, or a directory of them (recursive, sorted, ≤50 files, ≤2 MB each; larger or unreadable ones are skipped **and named**, PDFs and Word files are out of scope). Copies nothing: the originals stay where they are and every claim cites them as `[src: <path>:<line>]`. Writes `01-what/seed-index.md` (what was read, how big, what was skipped) and `01-what/handoff.md` whose Findings are every heading, bullet and paragraph of the seed, and whose Unknowns are the What outputs no seed heading covers (`intent`/`scope`/`success-metrics`/`open-questions`, matched by heading, no model involved). Adds the documents to the What stage's **declared inputs** in `run.yml`, so `tldrx next` inlines them into the prompt (`stage.yml` opts in with `seed: true`; over the 64 KB inline budget the index plus a labelled prefix goes in and the prompt says so). Deterministic — no LLM, no network. |
| `tldrx seed triage <path>` | **implemented** | The §6.2 deterministic pass — free, offline, no LLM. Collects the seed with exactly the `--seed` rules and writes `<out>/inventory.md` + `inventory.json`: per document its bytes and ~tokens (`bytes/4`), H1/H2, which other seed documents it links to **or names by filename**, the first `Status:` line's value, a count of open markers (`TODO`/`TBD`/`open question`/`??`), and a **code-derived** flag — set when ≥ 8 distinct path-like, non-documentation tokens it cites **resolve to real files** under the root or a repo in `workspace.yml` (citing `src/Foo.cs` proves nothing; eight paths that all exist means the code says the same thing). Ends in one verdict line naming the next command. Threshold: `--threshold-tokens`, else `seed_triage.threshold_tokens` in `workspace.yml`, else 20,000. `--out` defaults to `.tldrx/triage/<yymmdd>-<slug>/`; `--json` for the same data. Exit `0`/`1`/`3`. |
| `tldrx seed triage <path> --propose` | **implemented** | ONE sub-agent (effort `low`, `--max-usd 1.00`, no `--model` unless you pass one) spawned the way `next` and `expert train` spawn theirs, with `--json-schema` and the same `--prepare`/`--commit` handshake. The prompt carries the inventory and the documents under a 120 KB budget — everything whole if it fits, otherwise small documents whole plus **complete heading lists and a 2 KB prefix** for the rest, with every truncation named and byte-counted. The answer is validated against **this** workspace before anything is written: scope against the workflows on disk, seeds against the inventory, slugs against `run new`'s own regex, `depends_on` for cycles, and every `why[].src` against the `seed:<rel>#<heading>` / `seed:<rel>:<line>` grammar. Failure is whole — exit `5`, no `split.yml`, the raw answer kept at `.agent/propose/result.raw.json`. Below a $0.25 floor it refuses before spawning (exit `2`); `--max-budget-usd` is a stop-after-turn, not a cap. **Never creates a run.** Exit `0`/`1`/`2`/`5`. While it runs it shows a [progress view](#what-you-see-while-it-runs) on stderr — `--ui scene|compact|plain|off`, `auto` by default; stdout is byte-identical with it on or off. |
| `tldrx seed answer <split.yml> <Qid> "<text>"` | **implemented** | Records a decision on a proposal's question, beside the question. A split's runs could always be edited and its exclusions deleted; its `questions:` were the one part with nowhere to put the reply, so the answer lived in someone's head until `apply` created runs that did not reflect it. The key is human-owned — the propose schema still refuses it, so a model can never write one — and the file is parsed, validated and re-emitted whole rather than patched, so a proposal that does not validate is refused before anything is written. `seed apply` now lists any question with no answer on **stderr**: a warning, never a refusal. Exit `0`/`1`/`3`. |
| `tldrx seed apply <split.yml>` | **implemented** | The human gate. Refuses anything that is not `status: proposed`, revalidates the file you were invited to edit, then creates each run in **topological order** through the same `createRun` that `tldrx run new` calls — `--scope`, `--budget`, and `shared_context + seeds` as repeated `--seed`. Each `run.yml` records an optional `triage: {split, depends_on}` block (absent on every other run, so nothing else changes). Then `split.yml` is rewritten `status: applied` with `applied_at` and the created run ids, so a second apply cannot duplicate them. `--dry-run` prints the exact `tldrx run new …` lines and writes nothing. If a run dir already exists the apply **stops there**, exit `1`, naming the collision and the runs already created and left in place. Exit `0`/`1`/`3`. |
| `tldrx run status [<run>]` | **implemented** | Run id, scope, cursor, a progress bar per phase, budget spent/ceiling, **per-attempt cost for the cursor stage** (`attempts: 2 · $1.39 + $1.21`, from `agent.result` events — a stage's total cannot tell one $2.60 attempt from two $1.30 ones), and the pending question or gate. A `gates` block lists every stage with its policy (`human`/`auto`) and who signed the gates already closed — `approved by auto` on one the framework closed. On a run with a plan it also prints the Build phase story by story — `04-build  W1 [S1 done, S2 review] W2 [S3 todo]` with per-story cost, read from the story files and `events.jsonl` — because a one-stage phase holding a dozen sub-agents cannot say anything with a stage-level bar. A **failed** stage is never counted as progress: the bar takes `✗` in its first cell (`[✗░░░░] 0/1 stages · failed: <reason>`) and the waiting line offers both ways out — `retry: tldrx next` · `or: tldrx reject --note`. Newest unfinished run when omitted (a failed run still counts as unfinished). `--json` for the same view as data. Exit `0`/`3`. |
| `tldrx answer <Qid> <text>` | **implemented** | The terminal half of `answer-capture`, sharing its code path (`src/core/answers/`): fills the `[Answer]:` slot, flips the status, writes the footer, appends the fact and the `question.answered` + `fact.added` events, and prints the fact id. Exit `0`/`1`/`3`. |
| `tldrx interview` | **implemented** | The whole Interview step in a terminal. Walks the open blocks of the cursor phase's `questions.md` (or `.tldrx/init-questions.md` with `--init`), showing each question's `Why asked:` line and its options, and reads a letter `A`–`E`, free text, `s` to skip or `q` to stop. Every answer goes through the **same** `src/core/answers/` path as `tldrx answer` and the `answer-capture` hook — footer, `facts.yml` row, `question.answered` + `fact.added` — so the channel is interchangeable and the record is not. Answers nothing on your behalf: end of input, `s` and `q` all leave the question `status: open`. Piped stdin works (one answer per line), which is how it is tested. `--run <id>` `--init` `--yes-to-defaults` (takes option A, which is `None` for both install process questions — an unattended default commits the team to nothing). With `--init` it also **applies** the two process answers to `.tldrx/process.yml`: `methodology`, `ticket_tool.kind`, and for GitHub the `owner/repo` read from `git remote get-url origin`. Free text ("other") leaves the file alone and prints the key to set by hand. Exit `0`/`1`/`2`/`3`. |
| `tldrx approve` | **implemented** | Only when the cursor stage is `awaiting_gate`. **Re-runs** the stage's `checks` against what is on disk — `claim-sources` and `schema` via the validators, `cmd` for real (and only a command `workspace.yml` declares verbatim). On a pass: gate approved with `by`/`at`, stage `done`, cursor advances to the next stage as `ready`. Exit `2` naming the failing check otherwise. |
| `tldrx budget show [<run>]` | **implemented** | The money in one screen: run ceiling/spent/left, then a row per phase with its ceiling, spent, remaining, the next stage it would run, **that stage's own estimate**, and whether `tldrx next` would be blocked there. When it would be, it prints the exact command that unblocks it with the shortfall already computed and rounded **up** to the cent. `--json` for the same view as data. Exit `0`/`1`/`3`. |
| `tldrx budget raise <phase> <usd>` | **implemented** | The one sanctioned edit to `budget.yml`, validated before it writes: `Σ phase ceilings ≤ ceiling_usd` (spec §2.11) holds on the way out, and `--take-from <phase>` moves the money instead of adding it — refusing to cut a donor below what it has already spent. The output says which happened: the money moved, or the **run** ceiling grew. Writes `budget.yml` through `RunStore` and mirrors the ceiling into `run.yml`. Exit `0`/`1`/`3`. |
| `tldrx reject --note <t>` | **implemented** | Records the note on the gate and sends the stage back to `ready`. Valid on a stage that is `awaiting_gate` **or** `failed` — spec §5 lists both as the operator's moves after a failure. The note reaches the next attempt: `next` renders it, with the previous failure, under a `## Previous attempt` heading in the prompt. Exit `0`/`2`/`3`. |
| `tldrx expert <list\|create>` | **implemented** | `list` prints a table (status, last_trained, areas, **evidence count**, per-area levels) plus an ASCII star chart per expert, **recomputing every level from evidence** with the §2.6 formula and warning when the stored number disagrees (naming `tldrx expert recompute <name>` as the fix). Stars above 3 are earned by measuring: an area with no `kind: run` row — no command ever executed — caps at 3, and level 5 additionally needs two distinct evidence kinds and `W ≥ 20`, so an expert trained by reading alone shows 3 however many files it read (§2.6). An evidence row whose `kind` is not one of `code` `run` `test` `doc` `answer` is not counted, and **never silently**: one `warning: <expert>/<area>: N evidence row(s) ignored — unknown kind '<x>'` per unknown kind goes to **stderr**, so it survives `--json` and a redirect; `--json` for the same data, `--root <path>` to point elsewhere. Each expert also gets a **`loaded by:`** line naming the stages that would load it and why (`what (named), how (stack), build (domain)`), derived from the same three-rule selection `tldrx next` runs — so an expert that is trained and that no stage will ever load stops being invisible. `create <name> [--role <slug>] [--domain <slug>] [--stack <lang>]` writes `.tldrx/experts/<name>/{expert.md,competencies.yml}` at status `created` with zero areas (one per flag given, level 0, no evidence) and **refuses to overwrite** an existing expert (exit `1`). `--role` seeds a ROLE expert: `kind: role`, the shipped body from `templates/experts/<slug>.md` (a slug with no template falls back to the generic one and says which it used), one area named for the role whose `train_prompt` says `--mode full`, and an empty `knowledge/`. Exit `0`/`1`. |
| `tldrx expert train <name> --area <a>` | **implemented** | Runs training, and a level moves only on evidence. A **deterministic pre-pass** picks the candidate files — `map/<repo>/domains.md`, graphify communities when the graph has any, and a bounded keyword grep over the expert's repos (area id + title words), capped at 40 files / 96 KB with everything over the cap listed by name as "not read". **One sub-agent** (the expert + its stack experts + conventions) reads only what was inlined and writes `.tldrx/experts/<name>/knowledge/<area>.md` with `## Invariants` `## Entry points` `## Business rules` `## Gotchas` `## Sources`, every list item ending in a `[src: …]` token. The framework re-reads that file **off disk**, validates it with the same parser the `claim-sources` hook uses, and DERIVES the evidence: one `code` row per distinct cited file, `doc` for an https URL, `answer` for `F<n>`. `absent:` is a legal finding and earns nothing. On a **role expert** (`kind: role`) light mode is refused instead (exit `1`, nothing spawned and nothing spent): its domain is the workflow, not a folder, so the grep would either score nothing — one paid sub-agent writing four `absent:` sections that earn no evidence — or score files for containing the word. `--mode full` adds a second sub-agent that mines `tldrx-work/**/{handoff,retro}.md` and matching `facts.yml` rows into `knowledge/from-runs-<area>.md` (`run`/`answer` evidence); **Claude Code transcripts are out of scope** — they carry no citation anything can re-resolve. On a role expert full mode runs that pass ALONE (one sub-agent, the whole ceiling as its share), and refuses with exit `1` when no run matches the expert's repos, because a sub-agent spawned to write `- none [src: absent:tldrx-work]` costs money to learn what the pre-pass already knew. On success `competencies.yml` gains the evidence, **every** level is recomputed (§2.6), status becomes `in-use`, `last_trained` is stamped, and the run is appended to `training.jsonl` with its cost. An invalid file is rejected whole: nothing written, status unchanged, the file moved to `<area>.rejected.md`, exit `5`. `--max-usd <n>` (default `2.00`, split between full mode's two agents) reaches the sub-agent as `--max-budget-usd`; below the **$0.25 floor** it refuses with exit `2` before reading anything. **`--max-budget-usd` is a stop, not a cap** — measured 2026-08-29: a `--max-usd 1.5` run was killed with `error_max_budget_usd` *after* `total_cost_usd: 5.15` on a single turn of a 1M-context model, because the flag cannot end a turn already in flight. Size the prompt for what you are willing to lose. `--effort <level>` (`low\|medium\|high\|xhigh\|max`, default `medium` `[assumption]`) reaches the sub-agent as `--effort` and is recorded on every `training.jsonl` line. `--prepare`/`--commit` runs it from inside a Claude Code session, one bundle per sub-agent under `.tldrx/cache/training/`. `--print-prompt` prints the copy-paste prompt and spawns nothing; it now names the workspace's repos (it printed "none declared" for everyone until 0.3.0), lists the five evidence kinds a session may write, and ends by telling that session to run `tldrx expert recompute <name>` — nothing else writes the level on that path. Exit `0`/`1`/`2`/`3`/`5`. While it runs it shows a [progress view](#what-you-see-while-it-runs) on stderr — `--ui scene|compact|plain|off`, `auto` by default; stdout is byte-identical with it on or off. |
| `tldrx expert recompute [<name>]` | **implemented** | Recomputes `areas[].level` from the evidence already on disk and writes it, for every area of one expert or of every expert when no name is given. It exists because only the headless/`--commit` training path ever wrote a level: a human who pasted the `--print-prompt` prompt into their own session ended with `level: 0` on disk while the §2.6 formula computed 5, and `expert list` and the dashboard warned about the disagreement forever with no command to settle it. Shares the training path's reader and serializer, so the file shape is identical. Prints one line per area — `name/area: level 0 → 5 (17 evidence)`, or `level 5 unchanged (17 evidence)` — `--json` for the same as data. **Idempotent**: a second run re-serializes to the same bytes and writes nothing. Does **not** touch `status` or `last_trained` — it is arithmetic, not a training run — spawns nothing and spends nothing. Exit `0`/`1`, `3` for an unknown expert (naming the ones that exist). |
| `tldrx dashboard [--port <n>] [--open]` | **implemented** | A live, read-only local server on `127.0.0.1` (default port `4477`, `--port 0` for any free one). `GET /` is the page, `GET /model.json` is the model it was drawn from, `GET /events` is a Server-Sent Events stream. A recursive watcher over `.tldrx/**` and `tldrx-work/**` (debounced 300 ms, mtime-sweep fallback where the platform has no recursive `fs.watch`) pushes a `reload`; the page re-fetches the model and redraws with the template functions inlined into it, keeping scroll position and any open handoff panel. `node:http` + `node:fs` only — no framework, no runtime dependency. Never writes; answers nothing but GET; Ctrl-C exits `0`. |
| `tldrx dashboard --static [--out <dir>]` | **implemented** | The same model and the same renderer, written once as a self-contained `index.html` (default `.tldrx/cache/dashboard/`) that needs no server: the model rides inline as JSON and the page draws it. Five views behind a hash route — runs list (status, phase progress, spent/ceiling, what each run is waiting on, sorted by the workspace's dependency order with a `← next` marker and a dependency-chain block), run detail (execution path table with each gate's policy and who signed it, plan stories/epics/waves when present, handoffs with their citations, open questions with options), experts (status, inline SVG radar, evidence counts, train prompts), watchers and a how-to. Inline CSS/JS, theme-aware via `prefers-color-scheme`, **no external URL in any `src`/`href`** — an external citation is shown as text, never as a link. Read-only: nothing on the page changes a file, and a copied train command carries `--print-prompt`. |
| `tldrx watch list [--run <id>]` | **implemented** | The watcher cards a run produced (spec §2.16), as a table: feature, status (`verified` / `draft`, or `invalid` when the card does not parse), and the first line under its `## Signal` in full — half a metric name identifies nothing. Ends with a count. Read-only. Resolves the named run, else the newest unfinished one, else the newest run of any status — a run whose Watch stage produced cards is usually finished. Exit `0`/`1`/`3`. |
| `tldrx watch check <feature>` | **implemented** | Re-validates one card off disk: every `[src: …]` still resolves, and the stamped `status:` still equals the one its `## Signal` sources earn. Catches the two ways a card rots — the code moved under a citation, or somebody hand-edited `draft` to `verified` over an `absent:` signal. **Exit `1` when it fails**, not `0`: a check that reports a dead citation on stdout and exits `0` is invisible to CI. `3` for an unknown feature (naming the ones that exist). |
| `tldrx hook <name>` | **implemented** | Runs one of the six hook scripts — `dist/hooks/<name>.js` when tldrx is running from `dist/`, `src/hooks/<name>.ts` in a source checkout — and passes stdin, stdout, stderr and the exit code through unchanged. It exists so a committed `settings.json` can say `tldrx hook claim-sources` instead of an absolute path that is wrong on the next machine. An unknown name exits `1` and lists the real ones. |
| `tldrx statusline` | **implemented** | The same thing for `src/hooks/statusline.ts`, which is wired to the `statusLine` **settings key** rather than to a hook event. Always exits `0`. |
| `tldrx tickets sync` | **implemented** | The optional ticket mirror. Reads `.tldrx/process.yml` for `ticket_tool` (`--provider github\|jira` overrides it; `none`, or no `process.yml`, exits `0` with "adapter disabled"), then for every epic and story in `03-plan/` creates-or-updates one remote issue and records `external: {provider, key, url, synced_at}` in the file's front matter. **Idempotent** — a second sync creates nothing and re-uses the stored key. In `ticket_tool.sync: two-way` it also pulls each issue's status string, verbatim, into `external_status:` — and into nothing else. Body = title + acceptance + test plan + the story's file path + the footer `managed by tldrx — edits here are not read back`. Emits one `ticket.synced` event per item. **GitHub** goes through the `gh` CLI (`issue create`/`edit`/`view --json`), so no token is ever handled here; **Jira** through REST v3 with `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` — missing any of them is exit `1` naming all three, with nothing written. `--dry-run` prints the plan and makes zero calls. `--run <id>` `--root <path>`. Exit `0`/`1`/`3`. |
| `tldrx tickets status` | **implemented** | A table of every epic and story: local `status`, `external_status`, the remote key and url, with `!=` marking a divergence and `..` an item never synced. Divergence is compared on **done-ness only** — a remote status string is free-form, and a finer mapping is one nobody configured. Reads two folders and prints; changes nothing. Exit `0`/`1`/`3`. |
| `tldrx replay <run>` | **implemented** | Renders `events.jsonl` over the `run.yml` execution path as a stakeholder narrative on stdout: header (run, scope, status, spent/ceiling), then per phase and stage in event order — start/end, questions asked and answered with who, gate approvals and rejections with their notes, failed checks, budget warnings, cost against ceiling — ending with "Where it stands now" (cursor, pending gate, open questions). Writes nothing. Exit `0`/`3`. |
| `tldrx retro <run> [--apply]` | **implemented** | Writes `tldrx-work/<run>/retro.md` with three sections: **Facts to remember** (facts whose `source.run` is this run, plus any `fact.added` the store is missing), **Practice proposals** (five deterministic heuristics over the log — a stage rejected at its gate, a stage past its `budget_usd`, a stage past `questions.max`, every `check.failed`, every `budget.warned`/`blocked`; each bullet ends in `[src: tldrx-work/<run>/events.jsonl:<line>]`), and **Proposed stages** (`none proposed` unless a rejection note contains `propose stage:`). No model runs. Touches nothing else unless `--apply`, which appends the proposals to `.tldrx/memory/practices.md` under a dated, run-stamped heading — idempotent, so a second `--apply` for the same run appends nothing. Exit `0`/`3`. |

**`--root <path>`** works on every command that touches a workspace — `init`, `map`,
`run new`, `run status`, `next`, `answer`, `interview`, `approve`, `reject`, `expert`,
`replay`, `retro`, `tickets`, `dashboard`. Omitted, they use the nearest `.tldrx/` at or above the cwd.

Non-command pieces:

| Piece | Status | Notes |
|---|---|---|
| Schema validators (12 kinds) | **implemented** | Types plus a `validate()` that checks required keys and enums only. Tested against every shipped template, stage and workflow. |
| Watch phase (spec §2.16, §5) | **implemented** | One `05-watch/watchers/<feature>.md` per shipped feature, run by a **stage executor** keyed on the phase id (`src/core/facilitator/executors/`) rather than by the default one-agent path. A deterministic pre-pass groups **done** stories by epic — one feature per epic, named after the epic's branch slug — then one sub-agent per feature gets that epic's done stories, the **read-only diff of its branch against each repo's `default_branch`**, the `observability`/`deploy` facts and the repos' `gotchas.md`, and nothing else. The framework re-reads each card off disk, validates it with the same parser `claim-sources` uses, and stamps `status: verified` **only when no `absent:` source remains under `## Signal`** — a model that writes `verified` over a signal that does not exist is overruled. `05-watch/handoff.md` is written deterministically from the cards. No done stories is a result, not an error: nothing spawns and the handoff reads `- none [src: absent:03-plan/stories]`. `--prepare`/`--commit` is per feature. |
| Plan/Build schemas (spec §2.13–§2.15) | **implemented** | `stories/<id>.md` and `epics/<id>.md` (YAML front matter + Markdown body) and `waves.yml`. A story's fenced ```` ```dod ```` commands must each equal a `.tldrx/workspace.yml` command **verbatim**, and `status: done` requires `evidence`. `waves.yml` is dependency-ordered: every story's `depends_on` must be in an **earlier** wave — same-wave is an error, since those stories run as parallel agents. The `plan` gate check reads all three together at the Plan gate; `templates/{story.md,epic.md,waves.yml}` ship the shapes. |
| `src/hooks/statusline.ts` | **implemented** | With a live run: `[tldrx] <run> · <PHASE> [▓▓░░░] <done>/<total> > <stage> — <expert> \| <model> ctx:<n>% $<session cost>/$<ceiling>` — the run half from `RunStore`, the model/context/cost half from the documented `statusLine` payload. Falls back to the short `[tldrx] <model> ctx:<n>% $<cost>` when there is no run, and to `[tldrx] no session data` when the payload fields are absent. Never throws, always exits 0. |
| `claim-sources` hook | **implemented** | PreToolUse `Write\|Edit`. Parses the would-be handoff, denies when a bullet under Findings/Decisions/Unknowns/Evidence ledger has no `[src: …]` token, cites a file that does not resolve, **or when one of those four sections holds no list item at all** — a prose-only section is how an unchecked claim used to get written, so an empty one must say `- none [src: absent:<what you looked at>]`. A PostToolUse twin reports the same finding without blocking. |
| `no-re-ask` hook | **implemented** | PreToolUse `Write\|Edit` on `questions.md`. Denies a *new* open question whose subject already has a non-retired `facts.yml` row (same `area`, Jaccard ≥ 0.6 on ≥4-char tokens) and names the fact. |
| `answer-capture` hook | **implemented** | PostToolUse + FileChanged. Writes the answer footer, appends the fact (`kind: answer`, `source.q`) and the `question.answered` event, echoes `tldrx: recorded Q4 → F020`. Never blocks. |
| `dod-gate` hook | **implemented** | PreToolUse `Write\|Edit` on `stories/*.md` that set `status: done`. Re-runs every command in the story's fenced ```` ```dod ```` block from its repo; each must exit 0. The one hook that fails **closed**. |
| `budget-gate` hook | **implemented** | PreToolUse `Bash` on `claude -p …` / `tldrx next`. Denies when the cursor phase cannot afford the stage and `on_exceed: block`; appends `budget.blocked`. The denial names the exact `tldrx budget raise` command, shortfall included — the pilot's hand-edit of the field under-shot the estimate and the retry was refused twice. |
| `session-start` hook | **implemented** | SessionStart. Up to three lines of "where we are" from the same `RunStore` snapshot the status line uses, so the two can never disagree, then up to three of the `tldrx status` report — a headline plus as many pending items as fit. That second block is why a session opening on work that is NOT a run (a proposed split, unanswered setup questions, untrained experts) is no longer greeted with silence. Nothing pending AND no run is still no output at all. |
| Hook failure policy | **implemented** | Every hook but `dod-gate` fails **open**: an internal error exits `0` and prints one `tldrx hook <name>: internal error, allowing — …` line to stderr. Only PreToolUse can deny, and it denies by printing `permissionDecision: deny` and exiting `0` — never by an exit code. |
| Ticket adapter | **implemented** | `src/core/adapters/` — the optional mirror behind `tldrx tickets`. Two providers (`gh` CLI, Jira REST v3), each taking its transport as an argument, so the suite exercises the real argv and the real REST shapes through injected fakes: **no test makes an outbound call or spawns `gh`.** |
| Runtime seam | **implemented** | `src/core/runtime/` — `readStdin`, `spawn`, `readText/writeText/exists/readJson`, `parseYaml/stringifyYaml`, picked at import time by `typeof Bun`. Every other file in `src/` is runtime-agnostic; `grep -rn 'Bun\.' src \| grep -v src/core/runtime/` comes back empty, and a test asserts it. |
| `RunStore` | **implemented** | The one write path for a run: loads and validates `run.yml` + `budget.yml`, recomputes stage costs, phase status, run status and the budget mirror on every save, and refuses to write either file if it would be invalid. `run new`, `answer`, `approve`, `reject` and `next` all write through it. |
| Text parsers + stores | **implemented** | `src/core/text/` (questions.md, handoff.md, the `src` grammar), `src/core/facts/`, `src/core/events/`, `src/core/budget/` — the schemas the hooks enforce. Validating a 256 KB handoff stays under 50 ms. |
| 5 stages, 13 scopes, 13 templates | **read by `run new`** | A scope preset plus its stage files seed the run. Both the draft shape the repo ships and the spec §2.3/§2.4 shape load; a workspace's own `.tldrx/workflows/` and `.tldrx/stages/` win over the shipped defaults. |
| Plugin packaging | **loadable** | `claude --plugin-dir ./plugin` loads the skill and all six live hooks. `claude plugin validate ./plugin` exits `0` (two documented warnings). |

## Claude Code integration

Three ways in, and they do not exclude each other. Pick by how long you want it to
last.

**1 — a one-off session, from a checkout.** No install, nothing written:

```bash
claude --plugin-dir ./plugin      # then type /tldrx:tldrx
```

The plugin loads the facilitator skill and all six hooks for that session only.
Hook commands inside it are resolved through `${CLAUDE_PLUGIN_ROOT}`, so it works
with no global `tldrx` on `PATH` — which is exactly why the plugin keeps that form
and does **not** use `tldrx hook …`.

**2 — a project or a machine, persistently.**

```bash
tldrx install --claude               # this project: ./.claude/  (needs a git repo)
tldrx install --claude --user        # this machine: ~/.claude/
tldrx install --claude --dry-run     # show the plan, write nothing
tldrx install --claude --uninstall   # take exactly it back out
```

It writes one skill file and merges two keys into `settings.json`:

```jsonc
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Write|Edit", "hooks": [{ "type": "command", "command": "tldrx hook claim-sources", "timeout": 15 }] },
      { "matcher": "Write|Edit", "hooks": [{ "type": "command", "command": "tldrx hook no-reask",      "timeout": 15 }] },
      { "matcher": "Write|Edit", "hooks": [{ "type": "command", "command": "tldrx hook dod-gate",      "timeout": 960 }] },
      { "matcher": "Bash",       "hooks": [{ "type": "command", "command": "tldrx hook budget-gate",   "timeout": 15 }] }
    ],
    "PostToolUse": [
      { "matcher": "Write|Edit", "hooks": [{ "type": "command", "command": "tldrx hook answer-capture", "timeout": 15 }] },
      { "matcher": "Write|Edit", "hooks": [{ "type": "command", "command": "tldrx hook claim-sources",  "timeout": 15 }] }
    ],
    "FileChanged":  [{ "hooks": [{ "type": "command", "command": "tldrx hook answer-capture", "timeout": 15 }] }],
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "tldrx hook session-start",  "timeout": 15 }] }]
  },
  "statusLine": { "type": "command", "command": "tldrx statusline" }
}
```

Six scripts, eight handlers, four events — the same set, the same matchers and the
same timeouts as `plugin/hooks/hooks.json`. The only difference is the command
form: `tldrx hook <name>` rather than an absolute path, because this file gets
committed and cloned onto a machine whose checkout is somewhere else. `tldrx hook`
resolves `dist/hooks/<name>.js` (or `src/hooks/<name>.ts` in a source checkout) and
passes stdin, stdout, stderr and the exit code straight through.

What it will not do: touch `permissions`, edit an entry it did not write, overwrite
a `SKILL.md` that has no `<!-- tldrx-managed -->` marker, or replace a `statusLine`
that is somebody else's — it prints how to chain the two instead, and
`--force-statusline` is the override. `settings.json` is copied to
`settings.json.bak-tldrx-<ts>` before the first write, running it twice changes
nothing, and `--uninstall` puts the file back byte-for-byte.

**3 — no install at all.** Nothing here needs Claude Code. Every hook is a script
that reads a JSON payload on stdin and prints a decision, every command is a CLI,
and the whole loop runs from a shell:

```bash
tldrx run new payments --scope feature --budget 5
tldrx next                # headless: spawns `claude -p` itself
tldrx interview           # answer the open questions in the terminal
tldrx approve
```

`tldrx interview` is the terminal end of the Interview step, and it records answers
through the identical code path the `answer-capture` hook uses — so a question
answered in a shell, in an editor, or by Claude Code lands as the same footer, the
same `facts.yml` row and the same two events.

## Live dashboard

`tldrx dashboard` serves the workspace at `http://127.0.0.1:4477` and keeps it in
step with the files: a watcher over `.tldrx/**` and `tldrx-work/**` pushes an SSE
`reload`, and the page re-fetches the model and redraws itself. It is read-only —
three GET routes, no write path, and the only controls are copy-to-clipboard and a
status filter — and it is two separable halves, so a redesign only replaces the
second: `GET /model.json` is one plain JSON document
([`docs/dashboard-model.md`](docs/dashboard-model.md)), and the renderer that draws
it ships with the page and runs in the browser. The page carries that model inline
in a `<script type="application/json">` and draws every view client-side, so
`--static` exports the same document with the same renderer and no server behind
it. The renderer is written in TypeScript against the model's own types and
serialised into the page, which is what keeps `tsc --strict` on the markup.

**It never disagrees with the CLI about what a run needs.** `runs[].waiting` is
`tldrx run status`'s own `{kind, message, questions}`, from the one derivation
both call (`src/core/run/waiting.ts`), and `dependsOn` / `blockedBy` / `runnable`
come from the same `triage.depends_on` resolver `tldrx status` uses
(`src/core/run/dependencies.ts`). Two screens, one answer.

## Ticket mirror

Optional, off by default, and separate from the loop: `tldrx tickets sync` pushes
every epic and story in `03-plan/` out to Jira or GitHub as an issue. It is a
command a human runs — it appears in no stage, and `tldrx next` never calls it, so
the loop cannot come to depend on a tracker being reachable.

Two guard-rails, and the whole design is downstream of them:

1. **Files are the source of truth.** The mirror pushes epics and stories *out*;
   the only thing that comes back *in* is each issue's own status string, written
   to `external_status:`. It never advances `run.yml` — the run is opened
   read-only and never saved.
2. **Filing a ticket is never "done".** The mirror may write exactly two
   front-matter keys, `external:` and `external_status:`. Attempting to move a
   story's `status:` line **throws**, so `external_status: Done` beside
   `status: todo` is a legal state and stays one. Only the DoD hook marks a story
   done — the lesson of a bot that reported `stage=done` to mean "ticket created"
   and misled two people for a day.

```bash
tldrx tickets sync --dry-run     # the plan, and zero calls to anything
tldrx tickets sync               # create-or-update; re-running creates nothing
tldrx tickets status             # local status beside external_status, changes nothing
```

Configured in `.tldrx/process.yml` (`ticket_tool: {kind, project, sync}`); `none`
exits `0`. GitHub goes through the `gh` CLI, so no token is ever handled here;
Jira needs `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, and a missing one is
exit `1` naming all three before anything is written.

## Layout

```
bin/tldrx.ts          entrypoint — parses nothing, decides nothing
scripts/build.ts      bundles bin/ + src/hooks/ into dist/ for node (hooks share one chunk)
src/cli/              command table + one file per command
src/core/runtime/     the Bun/Node seam — the only place `Bun.` appears
src/core/run/         run.yml, budget.yml, the run lifecycle and its gates
src/core/budget/      ceilings, the phase table, and the one sanctioned edit to them
src/core/plan/        epics + stories + waves.yml, checked together at the Plan gate
src/core/dashboard/   model.ts reads the files, render.ts draws them in the browser, server.ts serves them
src/core/distill/     the `--from` AI-DLC importer
src/core/seed/        the `--seed` importer, and `seed triage`/`seed apply` (§6.2)
src/core/answers/     recording an answer — shared by the hook and the CLI
src/core/interview/   the terminal Interview: line reader, prompt, one loop over the answers
src/core/install/     `install --claude` — the settings merge and its exact inverse
src/core/doctor/      the one real subsystem
src/core/schemas/     types + a tiny validate() per file kind
src/core/statusline/  the status line renderer
src/hooks/            seven runnable hook scripts
plugin/               Claude Code plugin packaging (manifest, skill, hooks.json)
stages/<slug>/        stage.yml (contract) + stage.md (handoff template)
workflows/<scope>.yml 13 scope presets
templates/            the file shapes `tldrx init` will write
env.yml               the manifest `tldrx doctor` runs
```

Per project, the framework writes into `.tldrx/` (framework state) and
`tldrx-work/<yymmdd>-<slug>/` (one folder per piece of work). `tldrx init` creates
`.tldrx/`; `tldrx run new` creates the second.

### What to commit

**Both of them.** The files are the state, so `.tldrx/` and `tldrx-work/` belong in
git — the map, the facts, the questions and their answers, `run.yml`, `budget.yml`,
`events.jsonl`, the handoffs, the plan. A teammate who clones the repo gets the run.

The block `tldrx init` appends to `.gitignore` excludes five paths and nothing else,
because those five are machine-local or regenerated:

```
.tldrx/graphify-out/      regenerated by `tldrx map --refresh`
.tldrx/cache/             static dashboard exports, training prompt bundles
.tldrx/worktrees/         real checkouts of branches that ARE committed
tldrx-work/*/.lock        one live pid
tldrx-work/*/.agent/      one in-flight prompt bundle
```

## Requirements

Run `tldrx doctor` — it is the authority, not this list.

**Runtime: Node ≥ 20 or Bun.** Bun builds; either one runs. `bun run build` bundles
`bin/tldrx.ts` and every hook into `dist/` with `--target=node`, and `package.json`
`bin` points at `dist/tldrx.js` — so an installed tldrx needs only Node. Developing
against the sources with `bun bin/tldrx.ts …` keeps working exactly as before.

Required: **bun ≥ 1.3** (to build), **node ≥ 20** (to run the build), **git ≥ 2.30**,
**claude ≥ 2.0**.
Optional: python3 ≥ 3.10 and graphify (the code map), gh (ticket adapter).

The framework never installs anything. `doctor` prints the exact command for your OS
and stops there.

```bash
bun install
bun run doctor
bun test
bun run typecheck
bun run build      # -> dist/tldrx.js + dist/hooks/*.js, runnable by node
```

## Design notes

**Two execution modes, one code path.** `tldrx next` can do the work itself or
supervise someone else doing it, and it judges both the same way. *Headless* —
`tldrx next` — spawns `claude -p --output-format json --json-schema …` through the
runtime seam, with `--allowedTools` limited to the file tools plus one
`Bash(<command>)` grant per command `workspace.yml` declares, and
`--dangerously-skip-permissions` only when you pass `--yolo`. *In-session* —
`tldrx next --prepare` then `--commit` — writes the same prompt bundle to
`tldrx-work/<run>/.agent/<stage>/` and lets the Claude Code session you are already
in dispatch its own sub-agent, which is cheaper because that context is already
warm. From "re-read the declared outputs off disk" onwards the two are literally
the same function: same output validation, same `checks`, same cost roll-up, same
gate. The agent's structured envelope (`{outputs, questions_asked, notes}`) is a
report, never evidence — a file exists or it does not.

Nesting was the open question and it is now measured (2026-08-29): `claude -p`
runs fine from inside a Claude Code Bash tool. What bites is the ceiling, not the
nesting — a cold session pays ~10–26k cache-creation tokens before its first
reply, so a `--max-budget-usd` under about $0.25 fails as `error_max_budget_usd`
before any work happens. `--prepare/--commit` survives because it is cheaper and
because it still works where spawning is disallowed, not because spawning fails.


**Bun to build, Node or Bun to run** (decided 2026-08-28). Every host capability
that differs between the two runtimes — stdin, spawn, file IO, YAML — lives behind
`src/core/runtime/`, which picks its implementation at import time from
`typeof Bun`. Under Bun that is the native `Bun.YAML` / `Bun.spawn` / `Bun.file`;
under Node it is `node:child_process`, `fs/promises` and the `yaml` npm package.

`yaml` is a **devDependency on purpose**: `bun build --target=node` inlines it, so a
published install still resolves zero runtime dependencies. Do not promote it to
`dependencies` — that would reintroduce the install step the framework refuses to
have. Inlining it once per entry point is what made `dist/` 2.4 MB, so the seven
hooks are built with `splitting: true` and share one chunk: entry points of 1.6–4.9 KB
over a 242 KB chunk, `dist/` at 928 KB. `dist/tldrx.js` stays unsplit — one file to
hand to `node`. The invariant that keeps the seam honest is mechanical:

```bash
grep -rn 'Bun\.' src | grep -v src/core/runtime/    # must print nothing
```

`run.yml`, `budget.yml` and `facts.yml` are emitted by hand-written serialisers
rather than a generic YAML writer, because the two runtimes disagree on layout and
these files are committed and diffed. Same input, same bytes, either runtime.

**Claude Code shapes are copied, not remembered.** Every plugin manifest field,
hook event name, skill frontmatter key and statusLine field in this repo was taken
from the official docs during the session that wrote it, and the source URL sits in
a comment next to the shape:

- <https://code.claude.com/docs/en/plugins.md>
- <https://code.claude.com/docs/en/hooks.md>
- <https://code.claude.com/docs/en/skills.md>
- <https://code.claude.com/docs/en/statusline.md>

Anything that could not be confirmed from those pages is marked `TODO(verify)`
rather than guessed. There is exactly one, in `plugin/hooks/hooks.json`: whether
`Task` is the tool name a `PreToolUse` matcher needs in order to see a subagent
spawn. Find it with `grep -rn 'TODO(verify)' .` — the budget gate must not block
until it is confirmed.

`claude plugin validate ./plugin` passes, with two intentional warnings explained
in `plugin/README.md`.

**The status line is not a hook.** `statusLine` is a settings key, and a plugin's
own `settings.json` supports only `agent` and `subagentStatusLine` — so the plugin
cannot install it. `tldrx install --claude` can, because it writes the real
`.claude/settings.json`; loading the plugin instead means wiring it yourself, and
the snippet is in `plugin/README.md`.

**One settings file, two owners.** `install --claude` merges into a file it does
not own, so it identifies its own entries by their command string (`tldrx hook …`,
`tldrx statusline`) — JSON has no comments to mark them with — and the skill by a
`<!-- tldrx-managed -->` line, which Markdown does. Everything else in the file is
copied through untouched, the indent and trailing newline are detected and
reproduced, and `--uninstall` is written as the exact inverse of the merge, so
install-then-uninstall is byte-for-byte reversible. A backup is still taken before
the first write, because "as far as JSON allows" is not "always".

**Exit codes** (spec §3). `0` ok · `1` usage or schema error, or a real check that
ran and failed · `2` refused by a gate · `3` not found · `4` awaiting a human ·
`5` the sub-agent failed · `64` not implemented (`EX_USAGE`). A command that is
not implemented must exit `64` and say so on stderr. As of 0.3.0 every command in
the table above is implemented, so `64` is what an unknown command name gets and
nothing else.

## License

MIT, © 2026 Alan Martinez. This was a placeholder choice made while scaffolding —
change it freely before anything ships.

## Releases and status tags

Install name is **`tldr-experts`**; it installs two commands, **`tldrx`** (short) and `tldr-experts` (same binary).
Unscoped `tldrx` as a *package* name is refused by npm's name-similarity rule (too close to `tsdx`). Versions
0.0.1–0.2.0 were published and then unpublished on 2026-08-29; per npm policy those numbers can never be
reused, so the first version back on the registry is 0.3.0.

| Version | Date | Status | Contains |
|---|---|---|---|
| 0.3.0 | unreleased | `alpha` | expert training with provenance (light/full), per-stage `effort`, `tldrx install --claude`, `tldrx interview`, ticket mirror (`tldrx tickets sync\|status`), measured budget semantics; installs `tldrx` + `tldr-experts` commands |
| 0.2.0 | 2026-08-29 | `alpha` | Build executor (worktree + branch per story, epic branches, DoD gate, reviewer), Watch cards, live dashboard |
| 0.1.0 | 2026-08-29 | `alpha` | greenfield `init --stack` + `run new --seed`, story/epic/waves schemas, `tldrx budget show\|raise`, sections must hold list items |
| 0.0.2 | 2026-08-29 | `alpha` | pilot-driven fixes (source resolution, retry semantics, distill dedupe) |
| 0.0.1 | 2026-08-29 | `alpha` | v0 loop: init, map, doctor, run lifecycle, `next`, six hooks, views |

Status tags: `alpha` = every command real and tested, interfaces may change without notice, one
pilot workspace; `beta` = file formats frozen (`version: 1` schemas only grow), two or more real
workspaces through Build, upgrade path documented; `stable` = 1.0, semver from here on. The tag
of the newest release is the one shown in the badge above.

## How much human is in the loop

Every stage ends at a gate. What you choose is **who closes it**. `human` waits for
`tldrx approve`; `auto` lets the harness close it — but only when all five conditions hold: the
stage's checks pass, its phase has no open question, the spend is inside both the stage and the
phase ceiling, the stage did not fail, and the claim-sources validator (spec §2.8) reports nothing.
Any one of them failing falls straight back to the human gate and says which one and what it
measured. The approval is recorded through the same path a person's is, with `by: auto` and a note
carrying all five values, so `tldrx run status` and `events.jsonl` read identically either way.

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

Override per run with `tldrx run new … --gates <stage,stage>` — **the list is the human gates** —
or `--gates all` / `--gates none`. It is written into `run.yml` as `gates_policy:` at creation, so a
run keeps the policy it was opened with. A `run.yml` from before 0.3.0, or a workflow with no
`gates:` block, is `human` everywhere.

Then let it run: `tldrx run auto` calls `next` until something actually needs you.

```
$ tldrx run auto --max-usd 12 --until watch
01-what/what … done $1.21 · auto-approved
02-how/how … done $2.60 · awaiting human gate
```

`--max-usd` is a ceiling on the loop's total spend, on top of the per-stage ones, checked between
stages. `--until <stage>` stops before running that stage. It is headless only — inside a Claude
Code session `/tldrx` stays one stage per call.

## Budgets — what the numbers mean

Ceilings live in `budget.yml` (per run and per phase) and `stage.yml` (per stage). They gate a stage
*before* it starts and are reconciled *after* from real costs. A single sub-agent call is passed
`--max-budget-usd`, which the Claude CLI applies as a **stop after the current turn, not a hard cap**
— measured: one 10-minute turn spent $5.15 against a $1.50 ceiling. Expect overshoot of up to one turn;
every dollar is recorded in `events.jsonl` / `training.jsonl`. Measured costs so far (Sonnet, Aug 2026):
a What stage ≈ $1.2–1.4; a light expert training over ~20 files ≈ $5; a cold `claude -p` call floors at
≈ $0.25. The lever that acts *before* the money is spent is `--effort` (`low|medium|high|xhigh|max`), set
per stage in `stage.yml` and overridable with `tldrx next --effort` / `tldrx expert train --effort`: cheap
stages run at low/medium effort (Watch `low`, What and Plan `medium`) and only the stages that actually
reason pay for `high` (How, Build).

## Roadmap and changelog

`docs/ROADMAP.md` (what is next) · `CHANGELOG.md` (what shipped) · `docs/spec.md` §7 (open design questions).

## Releasing

**One command: `scripts/release.sh X.Y.Z --tag alpha`.** It is the only sanctioned path — a Claude Code hook denies hand-made `git tag` / `npm publish`, and `publish.yml` re-runs the same checks. Checklist and judgement calls: `docs/RELEASING.md`.


Releases are published by GitHub Actions through npm **trusted publishing** (OIDC — no
tokens, no OTP; provenance attached automatically). Bump `version` in `package.json`,
commit, then `git tag v<version> && git push origin v<version>`. `.github/workflows/publish.yml`
runs typecheck, tests, build, checks the tag matches the version, and publishes. One-time
setup on npmjs.com: package → Settings → Trusted Publisher → GitHub Actions (`ederwii` /
`tldr-experts` / `publish.yml`, configured on the npm package **`tldr-experts`**). The very first publish of a new package name is done by a
human with 2FA (`npm publish --access public --otp=<code>`).
