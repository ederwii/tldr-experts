# tldr-experts

**Pre-alpha. Most of it does not work yet.** This repo is a skeleton: a command
table, three real commands (`doctor`, `init`, `map`), and the file shapes everything
else will be built against. Every unimplemented command exits `64` and says so.
Nothing here prints success for work it did not do.

A lightweight, file-based AI development workflow. Open source, tool-agnostic in
design, piloted on Claude Code.

> **One loop, five phases, everything on disk.**
> Every phase is the same loop — *Investigate → Handoff → Interview → Gate* — run by
> a facilitator that only ever reads and writes files. The files ARE the state, the
> dashboard, the resume point, and the memory.

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
| `tldrx --help` | **implemented** | Lists every command and marks the stubs with `*`. |
| `tldrx doctor` | **implemented** | Reads `env.yml`, runs each tool's `check` command, prints a table. Exit `0` when every required tool is present and meets its `min_version`, else `1`. `--mcp` also runs `claude mcp list` (slow — live health checks per server; off by default). |
| `tldrx init` | **implemented** | Detects repos/stack/commands → `.tldrx/workspace.yml` (spec §2.1), builds `.tldrx/map/<repo>/{architecture,domains,conventions,commands,hotspots,gotchas}.md` + `map/workspace.md`, writes `.tldrx/init-handoff.md` (§2.8) and `.tldrx/init-questions.md` (§2.7, only real gaps), seeds experts at level 0 (§2.6), writes `conventions/`, `process.yml` (§2.12) and an empty `facts.yml`, and appends a marked block to `.gitignore` and `CLAUDE.md`. Deterministic: filesystem + `git` only, no LLM and no network. Re-running regenerates detection output and **keeps** `facts.yml`, `experts/`, `process.yml`, `conventions/*.md` and an answered questions file. Flags: `--root <path>` `--out <path>` `--no-interview` `--process <scrum\|kanban\|shape-up\|none>` `--mcp` `--provider <auto\|graphify\|static>`. Exit `0`/`1`. |
| `tldrx run <new\|status>` | stub → exit 64 | |
| `tldrx next` | stub → exit 64 | |
| `tldrx answer` | stub → exit 64 | |
| `tldrx approve` | stub → exit 64 | |
| `tldrx reject` | stub → exit 64 | |
| `tldrx map [--refresh\|--check]` | **implemented** | `--refresh` re-detects and rewrites `.tldrx/map/**`. `--check` resolves every `[src: <repo:>path:line]` citation in the map and the init handoff against the filesystem — exit `0` when they all land, `1` with the offending document, line and reason when they do not. Map providers: `graphify` when the binary is on PATH (runs only `graphify --version` and `graphify update <path> --no-cluster`, both documented, no LLM), otherwise `static` (file tree, manifests, 90-day `git log --numstat` churn, largest files). Which one ran is recorded as `provider:` in `workspace.yml`. |
| `tldrx expert <list\|create\|train>` | **implemented** (read-only) | `list` prints a table plus an ASCII star chart per expert, **recomputing every level from evidence** with the §2.6 formula and warning when the stored number disagrees; `--json` for the same data, `--root <path>` to point elsewhere. `create <name> [--domain <slug>] [--stack <lang>]` writes `.tldrx/experts/<name>/{expert.md,competencies.yml}` at status `created` with zero areas (one per flag given, level 0, no evidence) and **refuses to overwrite** an existing expert (exit `1`). `train <name> --area <a> [--mode light\|full] --print-prompt` prints a deterministic copy-paste prompt built from `expert.md`, the area and `workspace.yml`; without `--print-prompt` it exits `64` (running training is v1.1). Exit `0`/`1`/`64`. |
| `tldrx dashboard --static [--out <dir>]` | **implemented** (`--static` only) | Generates one self-contained `index.html` (default `.tldrx/cache/dashboard/`) with the runs list (status, phase progress, spent/ceiling, pending gate or question), run detail (execution path table, handoffs rendered to HTML, open questions with options), experts (status, inline SVG star chart, train prompts) and a how-to. Inline CSS/JS, theme-aware via `prefers-color-scheme`, **no external URL in any `src`/`href`** — an external citation is shown as text, never as a link. Read-only: no control on the page changes anything. Without `--static` it exits `64` (the live server is v1). |
| `tldrx replay <run>` | **implemented** | Renders `events.jsonl` over the `run.yml` execution path as a stakeholder narrative on stdout: header (run, scope, status, spent/ceiling), then per phase and stage in event order — start/end, questions asked and answered with who, gate approvals and rejections with their notes, failed checks, budget warnings, cost against ceiling — ending with "Where it stands now" (cursor, pending gate, open questions). Writes nothing. Exit `0`/`3`. |
| `tldrx retro <run> [--apply]` | **implemented** | Writes `tldrx-work/<run>/retro.md` with three sections: **Facts to remember** (facts whose `source.run` is this run, plus any `fact.added` the store is missing), **Practice proposals** (five deterministic heuristics over the log — a stage rejected at its gate, a stage past its `budget_usd`, a stage past `questions.max`, every `check.failed`, every `budget.warned`/`blocked`; each bullet ends in `[src: tldrx-work/<run>/events.jsonl:<line>]`), and **Proposed stages** (`none proposed` unless a rejection note contains `propose stage:`). No model runs. Touches nothing else unless `--apply`, which appends the proposals to `.tldrx/memory/practices.md` under a dated, run-stamped heading — idempotent, so a second `--apply` for the same run appends nothing. Exit `0`/`3`. |

Non-command pieces:

| Piece | Status | Notes |
|---|---|---|
| Schema validators (9 kinds) | **implemented** | Types plus a `validate()` that checks required keys and enums only. Tested against every shipped template, stage and workflow. |
| `src/hooks/statusline.ts` | **implemented** | Renders `[tldrx] <model> ctx:<n>% $<cost>` from the documented `statusLine` payload; `[tldrx] no session data` when the fields are absent. |
| `claim-sources` hook | **implemented** | PreToolUse `Write\|Edit`. Parses the would-be handoff, denies when a bullet under Findings/Decisions/Unknowns/Evidence ledger has no `[src: …]` token or cites a file that does not resolve. A PostToolUse twin reports the same finding without blocking. |
| `no-re-ask` hook | **implemented** | PreToolUse `Write\|Edit` on `questions.md`. Denies a *new* open question whose subject already has a non-retired `facts.yml` row (same `area`, Jaccard ≥ 0.6 on ≥4-char tokens) and names the fact. |
| `answer-capture` hook | **implemented** | PostToolUse + FileChanged. Writes the answer footer, appends the fact (`kind: answer`, `source.q`) and the `question.answered` event, echoes `tldrx: recorded Q4 → F020`. Never blocks. |
| `dod-gate` hook | **implemented** | PreToolUse `Write\|Edit` on `stories/*.md` that set `status: done`. Re-runs every command in the story's fenced ```` ```dod ```` block from its repo; each must exit 0. The one hook that fails **closed**. |
| `budget-gate` hook | **implemented** | PreToolUse `Bash` on `claude -p …` / `tldrx next`. Denies when the cursor phase cannot afford the stage and `on_exceed: block`; appends `budget.blocked`. |
| `session-start` hook | **implemented** | SessionStart. Up to three lines of "where we are" from the newest non-terminal `run.yml`; silent when there is no run. |
| Hook failure policy | **implemented** | Every hook but `dod-gate` fails **open**: an internal error exits `0` and prints one `tldrx hook <name>: internal error, allowing — …` line to stderr. Only PreToolUse can deny, and it denies by printing `permissionDecision: deny` and exiting `0` — never by an exit code. |
| Text parsers + stores | **implemented** | `src/core/text/` (questions.md, handoff.md, the `src` grammar), `src/core/facts/`, `src/core/events/`, `src/core/budget/` — the schemas the hooks enforce. Validating a 256 KB handoff stays under 50 ms. |
| 5 stages, 13 scopes, 10 templates | **shipped as data** | Nothing reads them yet except the tests. |
| Plugin packaging | **loadable** | `claude --plugin-dir ./plugin` loads the skill and all six live hooks. `claude plugin validate ./plugin` exits `0` (two documented warnings). |

## Layout

```
bin/tldrx.ts          entrypoint — parses nothing, decides nothing
src/cli/              command table + one file per command
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
`.tldrx/`; `tldrx-work/` waits on `tldrx run new`.

## Requirements

Run `tldrx doctor` — it is the authority, not this list.

Required: **bun ≥ 1.3**, **node ≥ 18**, **git ≥ 2.30**, **claude ≥ 2.0**.
Optional: python3 ≥ 3.10 and graphify (the code map), gh (ticket adapter).

The framework never installs anything. `doctor` prints the exact command for your OS
and stops there.

```bash
bun install
bun run doctor
bun test
bun run typecheck
```

## Design notes

**YAML: `Bun.YAML`, no dependency.** Bun 1.3.14 ships `Bun.YAML.parse` and
`Bun.YAML.stringify` natively (verified with `bun -e` on 1.3.14 before choosing),
so the `yaml` npm package was **not** added. The framework has zero runtime
dependencies; `typescript` and `@types/bun` are dev-only. All YAML access goes
through `src/core/yaml.ts` — if this ever has to run off Bun, that one file changes.

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

**Exit codes.** `0` success · `1` a real check ran and failed (only `doctor` uses
this) · `64` usage error or not implemented (`EX_USAGE`).

## License

MIT, © 2026 Alan Martinez. This was a placeholder choice made while scaffolding —
change it freely before anything ships.
