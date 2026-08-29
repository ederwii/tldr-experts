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
| `tldrx expert <list\|create\|train>` | stub → exit 64 | |
| `tldrx dashboard` | stub → exit 64 | |
| `tldrx replay` | stub → exit 64 | |
| `tldrx retro` | stub → exit 64 | |

Non-command pieces:

| Piece | Status | Notes |
|---|---|---|
| Schema validators (9 kinds) | **implemented** | Types plus a `validate()` that checks required keys and enums only. Tested against every shipped template, stage and workflow. |
| `src/hooks/statusline.ts` | **implemented** | Renders `[tldrx] <model> ctx:<n>% $<cost>` from the documented `statusLine` payload; `[tldrx] no session data` when the fields are absent. |
| The other six hooks | **wired, inert** | Each reads stdin, logs `tldrx hook <name>: not implemented (allow)` to stderr, and exits `0`. **None of them can block.** A hook that blocks on a rule it does not enforce is worse than no hook. |
| 5 stages, 13 scopes, 10 templates | **shipped as data** | Nothing reads them yet except the tests. |
| Plugin packaging | **loadable** | `claude --plugin-dir ./plugin` loads the skill and the inert hooks. |

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
