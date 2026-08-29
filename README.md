# tldr-experts

**Status: pre-alpha 0.0.1 — the v0 loop is complete; the Build/Watch phases and
expert training are v1.** Every command in the table below is implemented and
verified by running it. Nothing here prints success for work it did not do: a
command that cannot do the thing exits non-zero and says which thing.

A lightweight, file-based AI development workflow. Open source, tool-agnostic in
design, piloted on Claude Code.

> **One loop, five phases, everything on disk.**
> Every phase is the same loop — *Investigate → Handoff → Interview → Gate* — run by
> a facilitator that only ever reads and writes files. The files ARE the state, the
> dashboard, the resume point, and the memory.

## Quick start

```bash
npm i -g tldr-experts          # or, without installing: npx tldr-experts doctor
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

## The loop, in five lines

```bash
tldrx init                 # detect the workspace, map the code, ask only the gaps
tldrx run new --scope X    # open a piece of work
tldrx next                 # run the next stage; it stops at a gate
tldrx answer / approve     # answer the unknowns, approve the gate
tldrx retro                # close the run and keep what was learned
```

## What actually works today

| Command | Status | Notes |
|---|---|---|
| `tldrx --version` | **implemented** | Prints `0.0.1`, read from `package.json`. |
| `tldrx --help` | **implemented** | Lists every command with its one-line summary. The `* = not implemented` legend is printed only when a command actually carries the mark — in 0.0.1 none do. `tldrx <command> --help` prints that command's usage and exits `0` **without needing a workspace**. |
| `tldrx doctor` | **implemented** | Reads `env.yml`, runs each tool's `check` command, prints a table. Exit `0` when every required tool is present and meets its `min_version`, else `1`. `--mcp` also runs `claude mcp list` (slow — live health checks per server; off by default). |
| `tldrx init` | **implemented** | Detects repos/stack/commands → `.tldrx/workspace.yml` (spec §2.1), builds `.tldrx/map/<repo>/{architecture,domains,conventions,commands,hotspots,gotchas}.md` + `map/workspace.md`, writes `.tldrx/init-handoff.md` (§2.8) and `.tldrx/init-questions.md` (§2.7, only real gaps), seeds experts at level 0 (§2.6), writes `conventions/`, `process.yml` (§2.12) and an empty `facts.yml`, and appends a marked block to `.gitignore` and `CLAUDE.md`. Deterministic: filesystem + `git` only, no LLM and no network. Re-running regenerates detection output and **keeps** `facts.yml`, `experts/`, `process.yml`, `conventions/*.md` and an answered questions file. Always seeds a `product` expert (the What stage names one). **Greenfield** — a single repo with zero code files (`detect/codeFiles.ts` defines the extension set) — is recorded as `mode: greenfield`, said out loud in `architecture.md` with an `absent:` source rather than described as an architecture, and asks two extra questions: which stack the project will use, and which document holds the requirements. Flags: `--root <path>` `--out <path>` `--no-interview` `--process <scrum\|kanban\|shape-up\|none>` `--stack <ts,dotnet,python,go,rust,…>` `--mcp` `--provider <auto\|graphify\|static>`. Exit `0`/`1`. |
| `tldrx next [<run>]` | **implemented** | The facilitator (spec §5). Takes `.lock` (a live pid refuses with `2`; a dead one demotes the crashed `running` stage back to `ready`), resolves the cursor, honours `awaiting_gate`/`awaiting_answer` (exit `4`), evaluates `skip_if`, refuses a stage the phase budget cannot cover (exit `2` + `budget.blocked`), checks required inputs exist (exit `1`), assembles the prompt, spawns one sub-agent, then re-reads every declared output **off disk**, re-runs the stage's `checks`, rolls the cost into `run.yml`+`budget.yml` and either requests the gate (exit `4`) or advances the cursor (exit `0`). A failure is exit `5`, and the cost is recorded, never refunded. Run again on a `failed` stage and it **retries that stage** — spec §5: `stage.failed` never advances the cursor. Flags: `--dry-run --prepare --commit --model --max-usd --yolo --root`. |
| `tldrx next --dry-run` | **implemented** | Runs the stage, keeps `handoff.md`, reverts every other declared output, records `stage.skipped`. Refused when the stage sets `dry_run_allowed: false`. |
| `tldrx next --prepare` / `--commit` | **implemented** | In-session mode. `--prepare` writes `.agent/<stage>/{prompt.md,pending.json}` and prints three lines of instructions; `--commit` reads `.agent/<stage>/result.json` and continues down the identical validation path. |
| `tldrx map [--refresh\|--check]` | **implemented** | `--refresh` re-detects and rewrites `.tldrx/map/**`. `--check` resolves every `[src: <repo:>path:line]` citation in the map and the init handoff against the filesystem — exit `0` when they all land, `1` with the offending document, line and reason when they do not. Map providers: `graphify` when the binary is on PATH (runs only `graphify --version` and `graphify update <path> --no-cluster`, both documented, no LLM), otherwise `static` (file tree, manifests, 90-day `git log --numstat` churn, largest files). Which one ran is recorded as `provider:` in `workspace.yml`. |
| `tldrx run new <slug>` | **implemented** | Seeds `tldrx-work/<yymmdd>-<slug>/` from `workflows/<scope>.yml` + each `stages/<id>/stage.yml`: `run.yml`, `budget.yml`, `events.jsonl` and the phase folders. Per-phase ceilings are proportional to the stages' `budget_usd`, scaled to `--budget` (or the preset default). Flags: `--title --scope --budget --repos --from --seed` (`--from` and `--seed` are mutually exclusive). Writes to a temp dir and renames, so a validation failure leaves nothing behind. Exit `0`/`1`. |
| `tldrx run new --from <dir>` | **implemented** | The §6 AI-DLC distill. Reads only the listed files, turns every bullet/paragraph under a heading into a Finding tagged `[src: aidlc:<file>:<line>]` and every answered `## Q<n>.` block into a fact plus a Finding tagged `[src: aidlc:<file>#Q<n>]`. Unanswered blocks and ceremony stages are dropped; a claim contradicting a non-retired fact becomes a question in `01-what/questions.md`. A claim that **agrees** with a fact already held (same area, Jaccard ≥ 0.9) reuses it rather than appending a second copy, so importing the same folder twice leaves `facts.yml` byte-identical. Deterministic — no LLM, no network. |
| `tldrx run new --seed <file\|dir>` | **implemented** | The §6.1 generic document import — one `.md`/`.txt` file, or a directory of them (recursive, sorted, ≤50 files, ≤2 MB each; larger or unreadable ones are skipped **and named**, PDFs and Word files are out of scope). Copies nothing: the originals stay where they are and every claim cites them as `[src: <path>:<line>]`. Writes `01-what/seed-index.md` (what was read, how big, what was skipped) and `01-what/handoff.md` whose Findings are every heading, bullet and paragraph of the seed, and whose Unknowns are the What outputs no seed heading covers (`intent`/`scope`/`success-metrics`/`open-questions`, matched by heading, no model involved). Adds the documents to the What stage's **declared inputs** in `run.yml`, so `tldrx next` inlines them into the prompt (`stage.yml` opts in with `seed: true`; over the 64 KB inline budget the index plus a labelled prefix goes in and the prompt says so). Deterministic — no LLM, no network. |
| `tldrx run status [<run>]` | **implemented** | Run id, scope, cursor, a progress bar per phase, budget spent/ceiling, **per-attempt cost for the cursor stage** (`attempts: 2 · $1.39 + $1.21`, from `agent.result` events — a stage's total cannot tell one $2.60 attempt from two $1.30 ones), and the pending question or gate. A **failed** stage is never counted as progress: the bar takes `✗` in its first cell (`[✗░░░░] 0/1 stages · failed: <reason>`) and the waiting line offers both ways out — `retry: tldrx next` · `or: tldrx reject --note`. Newest unfinished run when omitted (a failed run still counts as unfinished). `--json` for the same view as data. Exit `0`/`3`. |
| `tldrx answer <Qid> <text>` | **implemented** | The terminal half of `answer-capture`, sharing its code path (`src/core/answers/`): fills the `[Answer]:` slot, flips the status, writes the footer, appends the fact and the `question.answered` + `fact.added` events, and prints the fact id. Exit `0`/`1`/`3`. |
| `tldrx approve` | **implemented** | Only when the cursor stage is `awaiting_gate`. **Re-runs** the stage's `checks` against what is on disk — `claim-sources` and `schema` via the validators, `cmd` for real (and only a command `workspace.yml` declares verbatim). On a pass: gate approved with `by`/`at`, stage `done`, cursor advances to the next stage as `ready`. Exit `2` naming the failing check otherwise. |
| `tldrx budget show [<run>]` | **implemented** | The money in one screen: run ceiling/spent/left, then a row per phase with its ceiling, spent, remaining, the next stage it would run, **that stage's own estimate**, and whether `tldrx next` would be blocked there. When it would be, it prints the exact command that unblocks it with the shortfall already computed and rounded **up** to the cent. `--json` for the same view as data. Exit `0`/`1`/`3`. |
| `tldrx budget raise <phase> <usd>` | **implemented** | The one sanctioned edit to `budget.yml`, validated before it writes: `Σ phase ceilings ≤ ceiling_usd` (spec §2.11) holds on the way out, and `--take-from <phase>` moves the money instead of adding it — refusing to cut a donor below what it has already spent. The output says which happened: the money moved, or the **run** ceiling grew. Writes `budget.yml` through `RunStore` and mirrors the ceiling into `run.yml`. Exit `0`/`1`/`3`. |
| `tldrx reject --note <t>` | **implemented** | Records the note on the gate and sends the stage back to `ready`. Valid on a stage that is `awaiting_gate` **or** `failed` — spec §5 lists both as the operator's moves after a failure. The note reaches the next attempt: `next` renders it, with the previous failure, under a `## Previous attempt` heading in the prompt. Exit `0`/`2`/`3`. |
| `tldrx expert <list\|create\|train>` | **implemented** (read-only) | `list` prints a table plus an ASCII star chart per expert, **recomputing every level from evidence** with the §2.6 formula and warning when the stored number disagrees; `--json` for the same data, `--root <path>` to point elsewhere. `create <name> [--domain <slug>] [--stack <lang>]` writes `.tldrx/experts/<name>/{expert.md,competencies.yml}` at status `created` with zero areas (one per flag given, level 0, no evidence) and **refuses to overwrite** an existing expert (exit `1`). `train <name> --area <a> [--mode light\|full] --print-prompt` prints a deterministic copy-paste prompt built from `expert.md`, the area and `workspace.yml`; without `--print-prompt` it exits `64` (running training is v1.1). Exit `0`/`1`/`64`. |
| `tldrx dashboard --static [--out <dir>]` | **implemented** (`--static` only) | Generates one self-contained `index.html` (default `.tldrx/cache/dashboard/`) with the runs list (status, phase progress, spent/ceiling, pending gate or question), run detail (execution path table, handoffs rendered to HTML, open questions with options), experts (status, inline SVG star chart, train prompts) and a how-to. Inline CSS/JS, theme-aware via `prefers-color-scheme`, **no external URL in any `src`/`href`** — an external citation is shown as text, never as a link. Read-only: no control on the page changes anything. Without `--static` it exits `64` (the live server is v1). |
| `tldrx replay <run>` | **implemented** | Renders `events.jsonl` over the `run.yml` execution path as a stakeholder narrative on stdout: header (run, scope, status, spent/ceiling), then per phase and stage in event order — start/end, questions asked and answered with who, gate approvals and rejections with their notes, failed checks, budget warnings, cost against ceiling — ending with "Where it stands now" (cursor, pending gate, open questions). Writes nothing. Exit `0`/`3`. |
| `tldrx retro <run> [--apply]` | **implemented** | Writes `tldrx-work/<run>/retro.md` with three sections: **Facts to remember** (facts whose `source.run` is this run, plus any `fact.added` the store is missing), **Practice proposals** (five deterministic heuristics over the log — a stage rejected at its gate, a stage past its `budget_usd`, a stage past `questions.max`, every `check.failed`, every `budget.warned`/`blocked`; each bullet ends in `[src: tldrx-work/<run>/events.jsonl:<line>]`), and **Proposed stages** (`none proposed` unless a rejection note contains `propose stage:`). No model runs. Touches nothing else unless `--apply`, which appends the proposals to `.tldrx/memory/practices.md` under a dated, run-stamped heading — idempotent, so a second `--apply` for the same run appends nothing. Exit `0`/`3`. |

**`--root <path>`** works on every command that touches a workspace — `init`, `map`,
`run new`, `run status`, `next`, `answer`, `approve`, `reject`, `expert`, `replay`,
`retro`, `dashboard`. Omitted, they use the nearest `.tldrx/` at or above the cwd.

Non-command pieces:

| Piece | Status | Notes |
|---|---|---|
| Schema validators (12 kinds) | **implemented** | Types plus a `validate()` that checks required keys and enums only. Tested against every shipped template, stage and workflow. |
| Plan/Build schemas (spec §2.13–§2.15) | **implemented** | `stories/<id>.md` and `epics/<id>.md` (YAML front matter + Markdown body) and `waves.yml`. A story's fenced ```` ```dod ```` commands must each equal a `.tldrx/workspace.yml` command **verbatim**, and `status: done` requires `evidence`. `waves.yml` is dependency-ordered: every story's `depends_on` must be in an **earlier** wave — same-wave is an error, since those stories run as parallel agents. The `plan` gate check reads all three together at the Plan gate; `templates/{story.md,epic.md,waves.yml}` ship the shapes. |
| `src/hooks/statusline.ts` | **implemented** | With a live run: `[tldrx] <run> · <PHASE> [▓▓░░░] <done>/<total> > <stage> — <expert> \| <model> ctx:<n>% $<session cost>/$<ceiling>` — the run half from `RunStore`, the model/context/cost half from the documented `statusLine` payload. Falls back to the short `[tldrx] <model> ctx:<n>% $<cost>` when there is no run, and to `[tldrx] no session data` when the payload fields are absent. Never throws, always exits 0. |
| `claim-sources` hook | **implemented** | PreToolUse `Write\|Edit`. Parses the would-be handoff, denies when a bullet under Findings/Decisions/Unknowns/Evidence ledger has no `[src: …]` token, cites a file that does not resolve, **or when one of those four sections holds no list item at all** — a prose-only section is how an unchecked claim used to get written, so an empty one must say `- none [src: absent:<what you looked at>]`. A PostToolUse twin reports the same finding without blocking. |
| `no-re-ask` hook | **implemented** | PreToolUse `Write\|Edit` on `questions.md`. Denies a *new* open question whose subject already has a non-retired `facts.yml` row (same `area`, Jaccard ≥ 0.6 on ≥4-char tokens) and names the fact. |
| `answer-capture` hook | **implemented** | PostToolUse + FileChanged. Writes the answer footer, appends the fact (`kind: answer`, `source.q`) and the `question.answered` event, echoes `tldrx: recorded Q4 → F020`. Never blocks. |
| `dod-gate` hook | **implemented** | PreToolUse `Write\|Edit` on `stories/*.md` that set `status: done`. Re-runs every command in the story's fenced ```` ```dod ```` block from its repo; each must exit 0. The one hook that fails **closed**. |
| `budget-gate` hook | **implemented** | PreToolUse `Bash` on `claude -p …` / `tldrx next`. Denies when the cursor phase cannot afford the stage and `on_exceed: block`; appends `budget.blocked`. The denial names the exact `tldrx budget raise` command, shortfall included — the pilot's hand-edit of the field under-shot the estimate and the retry was refused twice. |
| `session-start` hook | **implemented** | SessionStart. Up to three lines of "where we are" from the same `RunStore` snapshot the status line uses, so the two can never disagree; silent when there is no run. |
| Hook failure policy | **implemented** | Every hook but `dod-gate` fails **open**: an internal error exits `0` and prints one `tldrx hook <name>: internal error, allowing — …` line to stderr. Only PreToolUse can deny, and it denies by printing `permissionDecision: deny` and exiting `0` — never by an exit code. |
| Runtime seam | **implemented** | `src/core/runtime/` — `readStdin`, `spawn`, `readText/writeText/exists/readJson`, `parseYaml/stringifyYaml`, picked at import time by `typeof Bun`. Every other file in `src/` is runtime-agnostic; `grep -rn 'Bun\.' src \| grep -v src/core/runtime/` comes back empty, and a test asserts it. |
| `RunStore` | **implemented** | The one write path for a run: loads and validates `run.yml` + `budget.yml`, recomputes stage costs, phase status, run status and the budget mirror on every save, and refuses to write either file if it would be invalid. `run new`, `answer`, `approve`, `reject` and `next` all write through it. |
| Text parsers + stores | **implemented** | `src/core/text/` (questions.md, handoff.md, the `src` grammar), `src/core/facts/`, `src/core/events/`, `src/core/budget/` — the schemas the hooks enforce. Validating a 256 KB handoff stays under 50 ms. |
| 5 stages, 13 scopes, 13 templates | **read by `run new`** | A scope preset plus its stage files seed the run. Both the draft shape the repo ships and the spec §2.3/§2.4 shape load; a workspace's own `.tldrx/workflows/` and `.tldrx/stages/` win over the shipped defaults. |
| Plugin packaging | **loadable** | `claude --plugin-dir ./plugin` loads the skill and all six live hooks. `claude plugin validate ./plugin` exits `0` (two documented warnings). |

## Layout

```
bin/tldrx.ts          entrypoint — parses nothing, decides nothing
scripts/build.ts      bundles bin/ + src/hooks/ into dist/ for node (hooks share one chunk)
src/cli/              command table + one file per command
src/core/runtime/     the Bun/Node seam — the only place `Bun.` appears
src/core/run/         run.yml, budget.yml, the run lifecycle and its gates
src/core/budget/      ceilings, the phase table, and the one sanctioned edit to them
src/core/plan/        epics + stories + waves.yml, checked together at the Plan gate
src/core/distill/     the `--from` AI-DLC importer
src/core/seed/        the `--seed` generic document importer
src/core/answers/     recording an answer — shared by the hook and the CLI
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
cannot install it. Wire it yourself; the snippet is in `plugin/README.md`.

**Exit codes** (spec §3). `0` ok · `1` usage or schema error, or a real check that
ran and failed · `2` refused by a gate · `3` not found · `4` awaiting a human ·
`5` the sub-agent failed · `64` not implemented (`EX_USAGE`). A command that is
not implemented must exit `64` and say so on stderr; in 0.0.1 the only two are
`expert train` without `--print-prompt` and `dashboard` without `--static`.

## License

MIT, © 2026 Alan Martinez. This was a placeholder choice made while scaffolding —
change it freely before anything ships.

## Roadmap and changelog

`docs/ROADMAP.md` (what is next) · `CHANGELOG.md` (what shipped) · `docs/spec.md` §7 (open design questions).

## Releasing

Releases are published by GitHub Actions through npm **trusted publishing** (OIDC — no
tokens, no OTP; provenance attached automatically). Bump `version` in `package.json`,
commit, then `git tag v<version> && git push origin v<version>`. `.github/workflows/publish.yml`
runs typecheck, tests, build, checks the tag matches the version, and publishes. One-time
setup on npmjs.com: package → Settings → Trusted Publisher → GitHub Actions (`ederwii` /
`tldr-experts` / `publish.yml`). The very first publish of a new package name is done by a
human with 2FA (`npm publish --access public --otp=<code>`).
