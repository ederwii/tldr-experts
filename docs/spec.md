# Spec v0 — file-based AI development workflow framework

Source of truth: `framework-concept-v0.md` (v0 body, v0.1 addendum, Appendix A). Brand `tldr-experts`, CLI `tldrx` (decided 2026-08-28); harness
TypeScript on Bun; host Claude Code. Covers the v0 skeleton and the schema shapes v1 extends without breaking.

- `[assumption]` = the concept doc is silent; the simplest option was taken. Only Claude Code capabilities listed in
  Appendix A are relied on; claims about hook stdin shape, matcher syntax or settings wiring beyond it are marked.
- **Validation budget:** every schema is bounded so a Bun hook can read+parse+validate in <50 ms — one file, no
  cross-file resolution, no network, no globbing; ≤256 KB, ≤2000 nodes, nesting ≤6, anchored non-backtracking regexes.
  `events.jsonl` validates only the appended line. Every DATA schema — the files a workspace or a run owns, listed in
  §2 — opens with `version: 1`; an unknown version ⇒ exit 1. The stage and workflow libraries (`stages/*/stage.yml`,
  `workflows/*.yml`) carry no version key: they are the framework's own configuration, versioned with the package.
  **Deprecated:** `schema_version:` was the pre-spec spelling, and seven templates printed `schema_version: 0` while
  `tldrx init` was already writing `version: 1`. A file still saying it LOADS for one more release, prints
  `<file>: schema_version is deprecated — say version: 1` on stderr the first time it is read in a process, and is
  listed by `tldrx doctor`. Nothing writes it any more.

## 1. Directory layout

`[c]` committed · `[g]` gitignored. One `.tldrx/` per workspace root, always (v0.1 addendum).

```
<workspace-root>/                    # itself a git repo (docs-only root is fine)
├─ .gitignore [c] · CLAUDE.md [c]    # ~10-line pointer to tldrx = the only ambient footprint
├─ .claude/ settings.json [c] · settings.local.json [g] · plugin loaded via `claude --plugin-dir` (Appendix A)
├─ .tldrx/
│  ├─ config.yml [c] · workspace.yml §2.1 [c] · env.yml §2.10 [c]
│  ├─ map/ workspace.md [c] · <repo>/{architecture,domains,conventions,commands,hotspots,gotchas}.md [c]
│  ├─ graphify-out/ [g]              # graph.json, GRAPH_REPORT.md, graph.html
│  ├─ memory/ facts.yml §2.5 [c] · practices.md [c]
│  ├─ conventions/ shared.md [c] · <repo>.md [c]
│  ├─ experts/<name>/ expert.md [c] · competencies.yml §2.6 [c] · knowledge/*.md [c]
│  ├─ stages/<slug>/ stage.yml + stage.md §2.3 [c] · stages/proposed/<slug>/ [c]
│  ├─ workflows/<scope>.yml §2.4 [c]
│  └─ cache/ [g]                     # map digests, doctor probe cache, distill temp
├─ tldrx-work/<yymmdd>-<slug>/          # one run
│  ├─ run.yml §2.2 [c] · budget.yml §2.11 [c] · events.jsonl §2.9 [c] · retro.md [c]
│  ├─ .lock [g] · .agent/ [g]        # single-writer guard; raw `claude -p` json + transcripts
│  ├─ <phase>/  gate-evidence/<stage>.md [c]   # the §2.17 note an `agent` gate was closed over
│  ├─ 01-what/  handoff.md questions.md intent.md scope.md success-metrics.md [c]
│  ├─ 02-how/   handoff.md questions.md design.md contracts.md risks.md test-strategy.md [c]
│  ├─ 03-plan/  handoff.md waves.yml §2.15 · epics/<id>.md §2.14 · stories/<id>.md §2.13 [c]
│  ├─ 04-build/ handoff.md log/<story-id>.md fixlist/<story-id>-<round>.md [c]
│  └─ 05-watch/ handoff.md watchers/<feature>.md [c]
└─ <repo-a>/ <repo-b>/ …             # sibling product repos; init writes nothing into them
```

`init` writes an idempotent `# >>> tldrx >>>` … `# <<< tldrx <<<` block into `.gitignore`, in this order: first the
negations `!tldrx-work/`, `!tldrx-work/**`, `!.tldrx/`, `!.tldrx/**`, which re-include the `[c]` state above against a
rule the project already had (a stock `[Ll]og/` swallows `04-build/log/<story-id>.md`, and nothing errors when it does);
then `.tldrx/graphify-out/`, `.tldrx/cache/`, `.tldrx/worktrees/`, `tldrx-work/*/.lock`, `tldrx-work/*/.agent/` and
`.claude/settings.json.bak-tldrx-*`, which must come AFTER the negations because a later pattern beats an earlier one.
`tldrx doctor` asks `git check-ignore` about a sample of the `[c]` paths and names any rule still shadowing one — a
warning, never a blocker. Single-repo mode: same tree rooted at the repo, `map/self/`,
no `map/workspace.md`. Multi-repo: `repos` are the child git repos, never written to by the root install.

## 2. File schemas

### 2.1 `.tldrx/workspace.yml`

Detection result of `tldrx init`: which repos exist, their stack, and the **only** commands the DoD gate and map are
allowed to run.

```yaml
version: 1
mode: multi-repo
root_is_repo: true
detected_at: 2026-08-28T14:02:11Z
detected_by: "tldrx 0.1.0"
repos:
  - {name: api, path: Scavtopia.Workflows, default_branch: main, stack: [dotnet], package_manager: nuget,
     commands: {build: "dotnet build", test: "dotnet test", lint: "dotnet format --verify-no-changes",
                typecheck: null, run: "dotnet run --project src/Scavtopia.Api"},
     ci: [".github/workflows/deploy.yml"], confidence: high}
  - {name: lab, path: scavtopia-lab, default_branch: main, stack: [typescript, react, vite], package_manager: npm,
     commands: {build: "npm run build", test: "npm run test", lint: "npm run lint",
                typecheck: "npm run typecheck", run: "npm run dev"}, ci: [], confidence: medium}
contracts:
  - {id: C1, title: "API surface change requires SDK regeneration",
     when: {repo: api, paths: ["src/Scavtopia.Contracts/**", "src/Scavtopia.Api/**/*Controller.cs"]},
     then: [{repo: lab, command: "npm run generate:api"}]}
```

| Field | Type | Req | Meaning |
|---|---|---|---|
| `mode` / `root_is_repo` | `single-repo\|multi-repo\|greenfield` / bool | y | Detection outcome (child git repos ⇒ multi); **`greenfield`** = single-repo with ZERO code files, i.e. nothing built yet `[assumption]`; is the root itself a repo |
| `detected_at` / `detected_by` | RFC3339 / str | y | Last detection, CLI version |
| `repos[].name` | `^[a-z0-9-]{1,32}$` | y | Stable key used by `run.yml`, stories, `map/<repo>/` |
| `repos[].path` | rel path | y | Inside root, no `..`; `.` in single-repo mode |
| `repos[].default_branch` / `.stack` / `.package_manager` | str / str[] / str\|null | y | Epic-branch base; detected languages (may be empty); `npm`, `nuget`, `pip`, … |
| `repos[].commands.{build,test,lint,typecheck,run}` | str\|null | y (all keys) | Run from `path`; `null` = unavailable |
| `repos[].ci` | rel path[] | n | CI definition files found |
| `repos[].confidence` | `high\|medium\|low` | y | `low` forces an interview question at init |
| `contracts[].{id,title,when,then}` | `^C\d+$` / str / {repo,paths[]} / [{repo,command}] | y | Cross-repo obligation: source repo + globs ⇒ dependent commands auto-spawned at Plan time |
| `mcp_servers[].{name,transport,status,checked_at}` | str / str / `connected\|auth_required\|failed` / RFC3339 | n | Cached parse of `claude mcp list` (slow: runs health checks) — used only to *suggest* `process.yml ticket_tool`, never to act |

**Validation.** `name` unique; `path` exists, relative, inside root; enums as above; commands non-empty when non-null
and free of `&& ; | > \`` (single argv, auditable); contract repos resolve; ≤64 repos, ≤128 contracts.

**Greenfield.** `mode: greenfield` is a specialisation of `single-repo`, not a fourth workspace shape: one repo, no child
repos, and **no code file** in it. "Code file" is decided by extension against one fixed set shared with the map
(`src/core/detect/codeFiles.ts` — `.ts .tsx .js .jsx .mjs .cjs .cs .py .go .rs .java .kt .swift .rb .php .scala .c .h
.cpp .hpp .sql .sh .razor .vue .svelte`), walked with the same bounded walk that skips `.git`, `node_modules`, build
output and vendored trees. Docs, manifests, lockfiles and CI YAML are **not** code: a repo of nothing but
`requirements.md` is greenfield. Consequences: `map/<repo>/architecture.md` says there is no architecture yet and cites
`absent:<repo path>` rather than describing an empty tree; `init` asks which stack the project *will* use (or takes
`--stack`); and the seeded stack experts come from that answer instead of from a manifest. `[assumption]` — the spec
table above lists two modes; the third is additive and projects onto `single` for any reader that knows only two.

### 2.2 `tldrx-work/<run>/run.yml`

The execution path and the only resume point. Written by the facilitator alone; read by the dashboard, statusline,
`run status` and the gate hooks.

```yaml
version: 1
run: 260828-leaderboard
title: "Player leaderboard"
scope: feature
workflow: feature
repos: [api, lab, mobile]
created_at: 2026-08-28T09:04:00Z
updated_at: 2026-08-28T14:31:52Z
status: awaiting_gate
cursor: {phase: 02-how, stage: contracts, task: null}
budget: {ceiling_usd: 25.0, spent_usd: 3.75, per_agent_max_usd: 3.0}
gates_policy: {intent: human, contracts: auto, plan: human, build: auto, watch: human}
# attended_by: host      # optional; absent means the framework may spawn
phases:
  - id: 01-what
    status: done
    stages:
      - {id: intent, status: done, expert: product, model: sonnet, budget_usd: 2.0, cost_usd: 1.14,
         started_at: 2026-08-28T09:04:10Z, ended_at: 2026-08-28T09:19:44Z,
         inputs: [".tldrx/map/workspace.md", ".tldrx/memory/facts.yml"], outputs: ["01-what/intent.md", "01-what/handoff.md"],
         gate: {type: approve, status: approved, by: alan, at: 2026-08-28T09:41:02Z, note: ""},
         tasks: [{id: t1, status: done, expert: product, model: sonnet, cost_usd: 1.14, error: null,
                  session_id: "c9f1a2b0-1f2e-4c3d-9a10-6b7c8d9e0f11", started_at: 2026-08-28T09:04:12Z,
                  ended_at: 2026-08-28T09:18:03Z, outputs: ["01-what/intent.md"]}]}
  - id: 02-how
    status: awaiting_gate
    stages:
      - {id: contracts, status: awaiting_gate, expert: architect, model: sonnet, budget_usd: 3.0, cost_usd: 2.61,
         started_at: 2026-08-28T13:50:00Z, ended_at: 2026-08-28T14:31:40Z,
         inputs: ["01-what/intent.md", "01-what/scope.md", ".tldrx/map/api/architecture.md"],
         outputs: ["02-how/contracts.md", "02-how/handoff.md", "02-how/questions.md"],
         gate: {type: approve, status: pending, by: null, at: null, note: ""},
         tasks: [{id: t1, status: done, expert: architect, model: sonnet, cost_usd: 2.61, error: null,
                  session_id: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d", started_at: 2026-08-28T13:50:02Z,
                  ended_at: 2026-08-28T14:29:58Z, outputs: ["02-how/contracts.md", "02-how/handoff.md"]}]}
```

**Status enum** (one enum, all three levels): `pending` `ready` `running` `awaiting_answer` `awaiting_gate` `blocked`
`done` `failed` `skipped` `cancelled`. Terminal: `done` `failed` `skipped` `cancelled`. Run status = status of the
stage at `cursor`, or `done` when every phase is terminal.

| Field | Type | Req | Meaning |
|---|---|---|---|
| `run` | `^\d{6}-[a-z0-9-]{1,40}$` | y | Run id = folder name |
| `scope` / `workflow` / `repos` | slug / slug / slug[] | y | Scope asked for; workflow file used; repos in play |
| `status` | status enum | y | Derived, recomputed on every write |
| `cursor` | {phase, stage, task\|null} | y | **Resume pointer**: the unit `next` acts on |
| `budget.{ceiling_usd,spent_usd,per_agent_max_usd}` | number | y | Mirror of `budget.yml`; `spent_usd` = Σ task cost |
| `phases[].id` | `^0[1-5]-[a-z]+$` | y | Phase folder name |
| `stages[].id` / `.expert` / `.model` | slug / slug\|null / str | y | Stage file, expert folder, model pin |
| `stages[].budget_usd` / `.cost_usd` / `.started_at` / `.ended_at` | number ≥0 / RFC3339\|null | y | Ceiling, actual from `total_cost_usd`, wall clock |
| `stages[].inputs` / `.outputs` | rel path[] | y | Declared inputs; files produced |
| `stages[].gate` | {type, status, by, at, note} | y | `type` `approve\|checks\|auto`; `status` `pending\|approved\|rejected\|n-a`; `by` is `auto` on a gate the facilitator closed, and the note's `by:` on one an `agent` policy closed |
| `stages[].gate.evidence` | {path, role, verdict, sampled, of, resolved, refuted, outside_surface} | n | **Additive.** Present only on a gate an `agent` policy closed (§5). `path` is run-relative and points at the COMMITTED copy of the §2.17 note, `<phase>/gate-evidence/<stage>.md`; the counts are the note's own. Absent on every gate a person or the facilitator closed, and on every run.yml written before this key existed — the gate mapping has never rejected an unknown key, so the two directions cross without a shim. Emitted only when present |
| `attended_by` | `host` | n | **Additive.** Who DRIVES the run. Absent (the default, and every run.yml written before this key) ⇒ the framework may spawn. `host` ⇒ a host session is doing the turns: `tldrx next` refuses the headless mode with exit 4 naming the `--prepare` command, every executor exposes prepare/commit only, `run auto` is refused at the CLI (exit 1), and no run path can reach `spawnAgent`. Set at creation with `run new --attended-by host` or flipped later with `run attend`; emitted only when set |
| `gates_policy` | {stage: `human\|auto\|agent`} | n | **Who** closes each gate. Resolved from §2.4 `gates:` and `run new --gates` at creation and frozen here, so the run keeps the policy it was opened with. `tldrx run gates set <stage>:<policy> --note <text>` is the ONLY sanctioned way to move it afterwards — one stage, a required note, one `gate.policy_changed` event carrying actor, moment, note and old→new. Absent, or a stage it does not name ⇒ `human`. `agent` (§5) is the third value: every `auto` condition PLUS a §2.17 evidence note that signs |
| `stages[].stale` | bool | n | **Additive.** `true` when an EARLIER stage's gate was revoked after this one ran (§5). Its outputs stay on disk; nothing may treat them as current. Cleared when the stage runs again; emitted only when `true` |
| `tasks[].id` / `.status` | `^t\d+$` / enum | y | One sub-agent invocation |
| `tasks[].cost_usd` | number ≥0 \| `null` | y | `null` = **unmetered**: an in-session `--commit` turn nobody declared a cost for. Contributes nothing to any sum, so `spent_usd` is then a LOWER BOUND, and every report says so |
| `tasks[].metered` | bool | n | **Additive.** `false` iff `cost_usd` is `null`; absent means metered. The two always travel together, and a `null` cost without it is a schema error |
| `tasks[].tokens` | number | n | **Additive.** What `tldrx next --commit --tokens <n>` declared, when the host knew |
| `tasks[].session_id` / `.error` | str\|null | y | Session from `claude -p --output-format json`; one-line reason when `failed` |

**Validation.** Ids unique within parent; `cursor` resolves; ≤1 `running` stage (single-writer); `|spent_usd −
Σ tasks.cost_usd| ≤ 0.01` (a `null` cost contributes 0); `started_at ≤ ended_at`; `approved` needs `by`+`at`; a `null`
`cost_usd` needs `metered: false`; every `gates_policy` value is `human\|auto\|agent` and every key names a stage in the file; a `gate.evidence`, when present, is complete and its `role`/`verdict` are §2.17 values;
`attended_by`, when present, is `host` — a value the reader does not understand is a schema error, never a silent
downgrade to "spawn anyway";
≤5 phases, ≤40 stages, ≤200 tasks.

### 2.3 `.tldrx/stages/<slug>/stage.yml` + `stage.md`

A stage is a folder: `stage.yml` is the contract the facilitator executes, `stage.md` the prompt body. Add a folder, list it in a workflow, done.

```yaml
version: 1
id: contracts
title: "API, DTO and event contracts"
phase: 02-how
experts: [architect]
stack_experts: true
knowledge_max_bytes: 49152
inputs_max_bytes: 98304
prompt_max_bytes: 163840
max_reads: 120
model: sonnet
effort: high
budget_usd: 3.0
timeout_s: 900
dry_run_allowed: true
inputs: {required: ["01-what/intent.md", "01-what/scope.md"],
         optional: [".tldrx/map/{repo}/architecture.md", ".tldrx/memory/facts.yml"]}
outputs:
  - {path: "02-how/contracts.md", sections: [Contracts, Compatibility, Open]}
  - {path: "02-how/handoff.md", sections: [Findings, Decisions, Unknowns, "Evidence ledger"]}
questions: {path: "02-how/questions.md", max: 8}
gate: {type: approve, approvers: 1}
checks: [{id: claim-sources, on: post-write}, {id: schema, on: post-write},
         {id: cmd, on: post-write, repo: api, command: "dotnet build", expect_exit: 0}]
preconditions: [{id: docker, repo: api, command: "docker compose ps", expect_exit: 0}]
```

| Field | Type | Req | Meaning |
|---|---|---|---|
| `id` / `title` / `phase` | slug / str / `^0[1-5]-` | y | Identity and owning phase |
| `experts` | slug[] | y | Expert folders loaded; empty ⇒ facilitator runs it inline |
| `stack_experts` / `model` | bool / str | n (`true`) / y | Also load stack expertise for `run.repos`; per-stage model pin (Appendix A) |
| `knowledge_max_bytes` | int ≥0 | n (49152) | **Total** ceiling on inlined **trained knowledge**, shared by every loaded expert (§5, "Expert composition"). The retired `expert_knowledge_bytes` is still read, as the same total. Per stage and nowhere else: a Watch card and a Build story want different amounts and one workspace-wide number cannot be right for both |

**What training is asked to put in that budget (2026-08-29).** The prompt `tldrx expert train` spawns — and the one
`--print-prompt` renders — states one criterion, and it is the same sentence in both: *a finding is something a model
could not re-derive by reading that one file once*. Cross-file contradictions, dead paths, defaults that differ from
their docstrings, absences written as a negative claim with an `absent:` source, and measured commands. Restating a
docstring is not a finding. The prompt used to say the opposite — "Citing the same file twelve times is worth one
row; reading twelve files is worth twelve" — which described the old formula accurately and taught the wrong thing;
§2.6 now weighs a cross-file finding double and derives nothing from a paraphrase. Light mode's file selection is
bounded by the expert's own `## Domain`: only files inside it are scored, read or inlined, so the run stops paying
for files whose citations §2.6 would refuse to count.
| `inputs_max_bytes` | int ≥0 | n (98304) | Shared ceiling on the CONTENT of every declared input, spent in declaration order and filled BEFORE the experts get anything (§5, "One budget, inputs first") |
| `prompt_max_bytes` | int ≥0 | n (163840) | The whole prompt's ceiling. Over it the stage is **refused** (exit 2) before a sub-agent is spawned (§5, "The context ledger"). `--prompt-max-bytes <n>` overrides it for one invocation |
| `max_reads` | int ≥0 | n (120 · build 200 · watch 60) | How many `Read`/`Glob`/`Grep` calls the sub-agent may complete before it is stopped (§5, "The read cap"). `--max-reads <n>` overrides it for one invocation |
| `effort` | `low\|medium\|high\|xhigh\|max` | n (unset) | Passed to the sub-agent as `--effort`. **Unset ⇒ the flag is not passed at all** and the CLI uses its own default |
| `budget_usd` | number >0 | y | Stage ceiling and the sub-agent's `--max-budget-usd` share |
| `timeout_s` / `dry_run_allowed` | int >0 / bool | n (900 / `true`) | Wall clock for sub-agent and `cmd` checks `[assumption]`; `dry_run_allowed: false` refuses `--dry-run` on this stage |
| `inputs.required` / `.optional` | path[] | y / n | **The only files the sub-agent gets**; `{repo}` expands per repo |
| `inputs.seed` | bool | n (`false`) | Also give this stage **the run's seed documents**, whatever `run new --seed` recorded for it in `run.yml` (§6.1) `[assumption]` |
| `outputs[].path` / `.sections` | rel path / str[] | y | File written; H2 headings that must exist and be non-empty |
| `questions` | {path, max} | n | Interview file and question cap |
| `gate.type` / `.approvers` | `approve\|checks\|auto` / int ≥1 | y / n (1) | Human stop / checks only / no stop |
| `checks[].id` / `.on` | `claim-sources\|schema\|cmd\|dod` / `pre-write\|post-write` | y | Built-in check id and when it runs |
| `checks[].repo` / `.command` / `.expect_exit` | slug / str / int | y for `cmd` | Command must equal a `workspace.yml` command verbatim |
| `preconditions[].id` / `.repo` / `.command` / `.expect_exit` / `.timeout_s` | str / str / str / int / int >0 | the LIST is n (≤10); within an entry `id` `repo` `command` are **required**, `expect_exit` is optional (**default `0`**) and `timeout_s` is optional (**default 60**, NOT the stage's `timeout_s`) | An OPERATIONAL fact that must hold **before** the stage is dispatched (§5). Same verbatim-allowlist rule as a `cmd` check; **refused at load** if the command is not one `workspace.yml` declares, or if `timeout_s` is not a number >0. `id` and `repo` are validated as strings, not as slugs |

**Validation.** `id` = folder name; `budget_usd` ≤ the phase ceiling; `cmd` **and `preconditions`** commands must match
`workspace.yml` (no arbitrary shell from a stage file) — one comparison, one function, shared with a story's
`` ```dod `` block; expert folders are checked by `doctor`, not the write hook; ≤20 inputs,
≤10 outputs, ≤10 checks, ≤10 preconditions. The 20-input cap counts seed documents too — `run new --seed` stops declaring at 20, and the
facilitator stops inlining at 20.

**`preconditions:` — the check that runs before the money does.** `checks:` and `preconditions:` are the same shape
under the same allowlist rule, and differ only in WHEN. A check runs after the stage produced something and judges the
output; a precondition runs before a byte is written or a cent is spent and judges the ENVIRONMENT. The grounding is
measured, 2026-08-30: a host hand-checked the Docker daemon and the .NET SDK before dispatching a Build story, because
a story has two attempts, an agent cannot debug its way out of a daemon that is down, and the whole turn would have
been spent proving it. That check took about a second.

A red precondition is **refused**, not failed: exit `2`, the id and the command's own exit code named, the stage left
exactly as it was (`ready`), nothing written and nothing spawned. The list stops at the first red one — the ones after
it never run. They fire on `--prepare` no less than headless (a bundle written for a host whose Docker is down is the
same wasted attempt) and never on `--commit`, which settles a turn that already happened. Each run appends one event —
`check.passed` / `check.failed` with `kind: precondition`, carrying the command, its exit code and its duration — and
prints one operator line: `· precondition: docker compose ps → exit 0 (1.2s)`. A stage declaring none emits neither.

**Its own clock (issue #20).** A precondition is killed after `timeout_s` seconds — its own if it declares one,
otherwise **60**. It never inherits the stage's `timeout_s`, which ships at 900 and reaches 1800 on Build: a single hung
`docker info` could then hold a run for half an hour, which is the exact waste this feature exists to prevent, moved
from the attempt to the guard in front of it. A timeout is a red precondition like any other — exit `2`, nothing spent —
and its message names the precondition, its own timeout, and the knob that changes it.

The allowlist half is enforced **at load**: a stage whose precondition names a command `.tldrx/workspace.yml` does not
declare never becomes a runnable stage, so `tldrx run new` over it refuses too. `[assumption]` — preconditions are per
STAGE, not per story. A per-story precondition (one story needs Postgres, another does not) is a real want and is
deliberately not designed here; it can be added later as story front matter without changing this shape.

**`effort` — the cost lever `budget_usd` is not.** `--max-budget-usd` STOPS a sub-agent after the turn it is already in;
it cannot make a turn cheaper. Measured 2026-08-29: a 597 s training turn spent **$5.15 against a $1.50 ceiling** and
was only then killed. `--effort` changes what the turn costs while it is being taken, which is the only lever that acts
*before* the money is spent. So the two are set together and mean different things: `budget_usd` is what the stage may
lose, `effort` is how hard it thinks per turn. The five levels are exactly what `claude --help` prints for `--effort`
("Effort level for the current session (low, medium, high, xhigh, max)", read 2026-08-29); an unknown level is refused
by the loader rather than dropped, because a silently-ignored `effort` spends at the default and looks like a saving.
`tldrx next --effort <level>` and `tldrx expert train --effort <level>` override the stage file for one invocation, and
the level chosen is written to `agent.spawned`/`agent.result` (and `training.jsonl`) beside the cost, so cost per level
becomes a measurement rather than an argument. Shipped defaults — all `[assumption]`, none measured yet: what `medium`
· how `high` · plan `medium` · build `high` · watch `low`, and `medium` for a training run. The rule behind them is
that a stage which *reasons* (How, Build) buys effort and a stage which *transcribes* what an upstream pass already
decided (Watch) does not.

**`inputs.seed`.** A stage cannot name the run's seed documents: they differ per run. So it opts in
(`inputs: {seed: true, …}`) and the facilitator reads the list off `run.yml` — the entries `run new --seed` added to
that stage's `inputs` beyond what the stage file declares. An unseeded run simply has none, and the stage runs from its
ordinary inputs. This replaces the What stage's old placeholder input, the literal string
`"<free text, a PRD, any document, or a Jira epic>"`, which was prose no code could act on: measured 2026-08-29, a
seeded What prompt inlined zero of the documents it was started from. `[assumption]` — the v0 skeleton validator still
requires `inputs` to be an array (`src/core/schemas/stage.ts`), so the shipped `stages/what/stage.yml` writes the same
flag as a top-level `seed: true` beside an array `inputs:`; the loader accepts both spellings.

**Path patterns — `<token>` in a declared path.** A stage that cannot know its own filenames declares the SHAPE:
Plan's `outputs:` carry `epics/<epic>.md` and `stories/<id>.md`, because how many stories there are is what the stage
is being run to decide. A declared path holding an angle-bracket token is a **pattern**, and it matches any FILE in
that directory with the pattern's fixed prefix and suffix (`stories/<id>.md` matches `stories/S1.md`, not
`stories/notes.txt` and not a directory named `S1.md`). It is resolved against the same bases in the same order as any
other declared path — the run dir first, then the workspace root — and the first base that matches anything wins. A
token may appear in a directory segment, in which case the walk branches. Hidden entries are never swept in by a bare
token. Applied everywhere a declared path meets the disk, not only at validation: **as an output**, a pattern is
satisfied by ≥1 match and its `sections:` bind EVERY match, and zero matches fail as *"declared as an output but no
file matches it on disk"* — never as "does not exist", which would name a file nobody declared; **as an input**, a
pattern counts as present when ≥1 file matches (the §5 required-input gap is reported as the pattern, since the
declaration is what went unanswered) and the prompt is handed the concrete files, not the shape; and `--dry-run`
names the declared pattern, since on a dry run no file exists yet to resolve it against. `{repo}` is NOT a pattern — it expands off `run.repos` before anything reads the
disk (§2.3) — but the two compose: `{repo}` expands first and each result is then matched. Measured 2026-08-30: the
first `feature` run to reach Plan wrote one epic and seven stories and was failed by a literal `existsSync` on
`03-plan/stories/<id>.md`.

**Which experts a stage actually loads.** Three rules, applied in this order, deduped, and the order is the order they
appear in the prompt:

1. **`experts:`** — every name in the list that has a folder. A name with no `.tldrx/experts/<name>/` is **reported**
   (`expert <name> — NOT LOADED: no .tldrx/experts/<name>/ in this workspace`), not skipped in silence. This mattered
   because the SHIPPED stage files named `domain`, `stack`, `architect`, `delivery`, `operations` and `developer` and
   `tldrx init` seeded none but `product`. Measured 2026-08-29 on a fixture: the What stage's `experts: [product,
   domain]` loaded one of the two and said nothing about the other; and on `~/aparece-v2`, a real workspace,
   `architect`, `delivery`, `developer` and `operations` had no folder at all. Both halves of that gap are closed —
   `init` seeds the five **role experts** (below), and `domain`/`stack` are retired from the shipped lists. The two
   retired names are still ACCEPTED in a forked or older stage file: they are ignored with one note,
   `experts: domain/stack are selected by rule, not by name`, rather than reported missing on every run — a
   NOT LOADED line an operator sees every time is a line they stop reading, and it is the line that matters when a
   real name is misspelled. A workspace that really does have a `.tldrx/experts/domain/` folder loads it by name; only
   a name with no folder can be legacy (`src/core/experts/selectExperts.ts`, `LEGACY_STAGE_EXPERTS`).
2. **`stack_experts: true`** — `<language>-stack` for each language of each repo in `run.repos`.
3. **Domain match `[assumption]`** — an expert whose `expert.md` declares `kind: domain` and whose `## Domain`
   bullets name a path containing one of the run's cited paths (its declared inputs and seed documents; for the Build
   and Watch executors, the story's `touches:`), **or** whose path is within **2 hops** of a cited one in
   `graphify-out/<repo>/graph.json`, **or** — only in a workspace that declares **two or more repos** — whose
   front-matter `repos:` intersects `run.repos`. This rule exists because a stage file is written once for every
   workspace and cannot know that THIS one has a `checkout` domain expert that has read the code the run touches.

   Rank is a **score**: a direct path match is worth 10, a graph neighbour 1, and scores add, so an expert that owns
   two cited paths outranks one that owns one. Ties break by name; capped at **8** — the same cap `init` puts on
   seeded domain experts — with the overflow named rather than dropped. An expert whose score is **0** loads (where
   the repo rule still applies) but is marked `relevant: false` and earns **none** of the shared knowledge budget:
   its `expert.md` body only.

   The repo half is conditional because measurement said so. On `~/aparece-v2` (`mode: single-repo`, 2026-08-29) a
   What prompt loaded nine experts, **eight of them by `repos:` alone**; they contributed 52% of 159,575 bytes and
   not one had read a file the run cited. In a single-repo workspace `repos:` selects everybody, which is the same as
   selecting nobody — it just costs more. After the change the same prompt loads two experts and is 85,676 bytes.

An expert is never loaded twice however many rules pick it, and the first rule that picks it owns the reason recorded
in `pending.json`.

**Role experts.** Five names, seeded unconditionally by `tldrx init` and named by rule 1 of the shipped stage files:

| Expert | Stage(s) that name it | Its subject |
|---|---|---|
| `product` | what | the problem, the scope's OUT list, measurable success |
| `architect` | how, plan | design placed on real files, contracts, risk |
| `delivery` | plan | stories a stranger could start, dependency waves, budget |
| `developer` | build | one story, its DoD, the evidence it leaves |
| `operations` | watch | what a shipped feature emits, and its healthy baseline |

A role expert's front matter is `kind: role`, which keeps it out of rule 3: a role loads because a stage NAMED it and
for no other reason. Its subject is the WORKFLOW rather than a folder of code — what its stage is accountable for, what
it must refuse, what it may cite, what it hands to the next stage — so its body is not generated from detection, which
knows nothing about any of that. It ships as an editable Markdown file at **`templates/experts/<role>.md`** and is
copied into `.tldrx/experts/<role>/expert.md` once; the front matter (`name`, `kind`, `created_by`, `created_at`,
`repos`) and the H1 are filled in, and every other byte of the prose is left alone, on the first `init` and on every one
after it. Editing the template changes what future workspaces get; editing the copy changes this one.

Seeding is **additive and idempotent**. Each file is offered to `createIfAbsent` on its own, so a workspace seeded
before role experts existed gains the missing folders on the next `init` and keeps every `expert.md` and
`competencies.yml` it already had, byte-for-byte. `tldrx expert create <name> --role <slug>` writes the same seed on
demand and is open-world: a slug the framework ships no template for falls back to the generic `templates/expert.md`
with `kind: role`, and the CLI says which of the two it used.

A seeded role expert gets ONE competency area at level 0 with no evidence, named for the role — except `product`, which
keeps the area id `init` has always given it, the project's own slug, because it is the one role whose subject has a
real name this workspace knows. That area's `train_prompt` says `--mode full`, and so does §2.6's, because **light mode
is refused for a role expert** (exit 1, nothing spawned, nothing spent). Light mode's whole pre-pass is a keyword grep
over the expert's repos seeded from the area id, which is right for `checkout` and wrong for `architect`: either
nothing scores and one paid sub-agent writes four `absent:` sections that earn no evidence, or something scores because
it contains the word. `--mode full` on a role expert runs the runs pass ALONE — one sub-agent, the whole ceiling as its
share — over `tldrx-work/<run>/**/{handoff,retro}.md`, which IS a role's domain. Full mode with no matching run is
refused the same way, for the same reason (`src/core/training/roleTraining.ts`).

**`stage.md` required sections** (H2, in this order; concatenated into the sub-agent prompt): `## Role` ·
`## Objective` (done-when, testable) · `## Inputs` (auto-rendered list — read nothing else) · `## Investigate` (ordered
steps, tools allowed) · `## Produce` (output files + section skeletons) · `## Rules` (citation duty, conventions,
banned moves) · `## Questions` (what may and may not be asked) · `## Stop`. Placeholders `{{run}} {{repos}} {{inputs}}
{{facts}} {{conventions}} {{budget_usd}}` are substituted by the facilitator, never by the model.

### 2.4 `.tldrx/workflows/<scope>.yml`

A scope preset: which stages run, at what depth, default budget, DoD deltas. The facilitator hard-codes no scope.

```yaml
version: 1
name: bugfix
title: "Fix a specific defect"
depth: minimal
default_budget_usd: 8.0
gates: {reproduce: auto, root-cause: human, minimal-design: auto, plan-stories: human, build: auto, regression-watcher: human}
questions: {suppress_areas: [market, ux]}
dod: {add: ["A test failed before the fix and passes after [src: $ dotnet test → exit 0]"], remove: ["UX review sign-off"]}
stages:
  - {id: reproduce, phase: 01-what, budget_usd: 1.5}
  - {id: root-cause, phase: 01-what, budget_usd: 2.0}
  - {id: minimal-design, phase: 02-how, budget_usd: 1.0, skip_if: "stories<=1"}
  - {id: plan-stories, phase: 03-plan, budget_usd: 1.0}
  - {id: build, phase: 04-build, budget_usd: 2.0}
  - {id: regression-watcher, phase: 05-watch, budget_usd: 0.5}
```

| Field | Type | Req | Meaning |
|---|---|---|---|
| `name` / `title` | slug / str | y | `name` = filename stem = `run.scope` |
| `depth` | `minimal\|standard\|deep` | y | Investigation effort; budget multiplier 0.5 / 1.0 / 2.0 `[assumption]` |
| `default_budget_usd` | number >0 | y | Run ceiling when `run new` gives none |
| `gates` | {stage: `human\|auto\|agent`} | n | Who closes each stage's gate. A stage the map does not name is `human`. The key `collapse` is **reserved** (`true` ⇒ one gate at run end; not implemented) and is skipped rather than read as a stage id |
| `questions.suppress_areas` / `dod.add` / `dod.remove` | slug[] / str[] / str[] | n | Areas this scope must not ask about; deltas over the default DoD |
| `stages[].id` / `.phase` | slug / `^0[1-5]-` | y | Stage folder; file order = execution order |
| `stages[].budget_usd` | number >0 | n | Overrides `stage.yml` |
| `stages[].skip_if` | str | n | `^(stories\|repos\|questions)(<=\|>=\|==\|<\|>)\d{1,4}$` `[assumption]` |
| `skips` | slug[] | n | Stages this scope deliberately does NOT run, so the omission is on record. **Read, not decorative:** Build asks it (below) |
| `<stage>.parallel` | int ≥1 | n | How many units of that stage may run at once — for `build`, stories per wave (§5). `--parallel` overrides it; absent ⇒ `stage.yml`'s `parallel:`, then 1 |

**Validation.** `name` = filename stem; stage ids unique and present in `.tldrx/stages/`; Σ `budget_usd` ≤
`default_budget_usd`; `skip_if` matches the pattern above; every `gates` key (other than `collapse`) names a stage
this workflow lists and every value is `human\|auto`; ≤40 stages.

**Shipped defaults.** Every scope keeps at least one human gate — the framework has no all-auto preset, and
`--gates none` is the only way to get one.

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

`retro` runs no stage from `stages/`, so it has no gate to place.

**`skips:` is read (2026-08-29).** It used to be declared by the schema and dropped by the loader, so "docs skips
Plan" was a sentence in a file rather than a fact anything could act on — and five scopes (`docs`, `hotfix`,
`performance`, `prototype`, `security-patch`) list `build` in `stages` and `plan` in `skips`, reached Build with no
`03-plan/`, and could only fail their own Build stage. `WorkflowPreset.skips` now carries the list down to
`StageSpec`, which is how Build tells "the Plan phase has not run YET" from "no Plan phase was ever going to run".
The distinction cannot be made from disk: both look like an absent `03-plan/`.

**`retro.md` has two writers (2026-08-29).** `tldrx retro` renders the document; the **Build executor** appends
`## Build feedback` to it as each story settles, deterministically and with no model involved — every reviewer
`changes` verdict, every DoD command that failed on the first attempt, every merge conflict, and (read back off
`events.jsonl` at the top of the next Build run, since they happen between invocations) every gate a person rejected
and every approval revoked, with its note and what it staled. Appends are deduped verbatim, so re-running converges;
`tldrx retro` carries the section forward rather than overwriting it. Every bullet cites the story's review log or
the `events.jsonl` line, so a knowledge file mined from it inherits a citation that still resolves.

This is the only path by which a gate reaches an expert. Role experts train from
`tldrx-work/<run>/**/{handoff,retro}.md` and nothing else (§2.6); measured 2026-08-29, all five sat at level 0
because `retro.md` existed only when a human happened to type `tldrx retro`.

### 2.5 `.tldrx/memory/facts.yml`

Durable, provenanced answers, read before any question is posed. Append-mostly: superseded or retired, never edited.

```yaml
version: 1
facts:
  - {id: F007, fact: "Backend CD is manual — deploy.yml is workflow_dispatch only; merged is not shipped.",
     area: deploy, repos: [api], kind: answer, confidence: measured,
     source: {who: alan, when: 2026-07-28T18:02:00Z, run: 260727-leaderboard, q: Q3},
     supersedes: null, superseded_by: F019, retired: null}
  - {id: F019, fact: "Backend deploys run via deploy.yml (workflow_dispatch); lab auto-deploys on merge.",
     area: deploy, repos: [api, lab], kind: answer, confidence: measured,
     source: {who: alan, when: 2026-08-14T10:11:00Z, run: 260814-envs, q: Q1},
     supersedes: F007, superseded_by: null, retired: {at: null, by: null, reason: null}}
```

| Field | Type | Req | Meaning |
|---|---|---|---|
| `id` | `^F\d{3,6}$` | y | Immutable; cited as `[src: F019]` |
| `fact` | str ≤2000 | y | One assertion, present tense, no hedging |
| `truncated` | bool\|absent | n | The text is the head of a longer answer, cut at the cap. Absent means "not known to be cut" |
| `area` / `repos` | slug / slug[] | y | Matching key for the no-re-ask hook; scope (empty = workspace-wide) |
| `kind` / `confidence` | `answer\|observed\|derived` / `measured\|inferred\|stated` | y | Human answer, check output or stage conclusion; evidence class |
| `source.who` / `.when` | str / RFC3339 | y | Human id or expert slug; capture time |
| `source.run` / `.q` | run id\|`init` / `^Q\d+$`\|null | y | Where learned; originating question |
| `supersedes` / `superseded_by` | fact id\|null | y | Single-link chain, reciprocal. Written by `tldrx answer <Qn> "…" --supersede` (§3), which walks to the head of the chain, so repeated reversal stays single-link |
| `retired` | {at, by, reason}\|null | y | Ignored by no-re-ask, kept for replay |

**Live means neither retired nor superseded.** `isLive` (`src/core/facts/Fact.ts`) is the predicate EVERY reader that
feeds a decision filters on: the no-re-ask hook, `findDuplicate`, the `{{facts}}` section of every prepared prompt,
the Watch stage's facts input, the implicit plan's "this run's answers", and the training miner. History readers —
`tldrx replay`, `tldrx retro` — deliberately do not: a superseded fact is SHOWN there, labelled `(superseded by F<n>)`.
Until 2026-08-31 every reader filtered on retirement alone, which was safe only while nothing wrote `superseded_by`.

**Validation.** Ids unique and ascending; supersede links reciprocal and resolvable within this file; no fact both
superseded and retired; ≤5000 facts (beyond that `tldrx` shards by `area`). `truncated` is optional and additive: a row
written before it existed still validates, and only a non-boolean value is an issue.

**The cap was 300 until 2026-08-30.** `captureAnswers` writes a fact as `"<question> — <answer>"`, so 300 cut a real
answer mid-clause: on the aparece run every one of six was cut, and four lost the very words — "Accepts ADR-D009 as
written." — naming the document the answer settles, which is what the Build phase downstream matches on. 2000 is still
a cap (a fact is one assertion, not a document) and the bound only moved outwards, so every file already on disk stays
valid. When it still cuts, it cuts visibly: the text ends ` …` and the row carries `truncated: true`. The whole answer
is never only here — `<phase>/questions.md` keeps it under `[Answer]:` — which is why §5's implicit plan quotes THAT
and cites its line.

### 2.6 `.tldrx/experts/<name>/competencies.yml`

What an expert credibly knows, computed from evidence, never self-declared. Rendered as the star chart.

```yaml
version: 1
expert: dotnet-stack
status: in-use
last_trained: 2026-08-20T11:00:00Z
areas:
  - {id: ef-core, title: "EF Core mapping and migrations", level: 3,
     train_prompt: "tldrx expert train dotnet-stack --area ef-core --mode light",
     evidence: [{kind: code, src: "api:src/Scavtopia.Infrastructure/Persistence/AppDbContext.cs:41", at: 2026-08-20,
                 cross: true, confidence: inferred},
                {kind: run, src: "tldrx-work/260812-scores/04-build/log/S3.md:9", at: 2026-08-12},
                {kind: doc, src: "https://learn.microsoft.com/ef/core/modeling/", at: 2026-06-02},
                {kind: answer, src: "F019", at: 2026-08-14}]}
```

| Field | Type | Req | Meaning |
|---|---|---|---|
| `expert` / `status` | slug / `created\|training\|in-use\|inactive` | y | Folder name; lifecycle |
| `last_trained` | RFC3339\|null | y | Last training run |
| `areas[].id` / `.title` | slug / str | y | Competency area (`oauth`, `google-maps-sdk`, …) |
| `areas[].level` | int 0–5 | y | **Computed**; a hand-edited value is overwritten on next write |
| `areas[].train_prompt` | str | y | Copy-paste command shown in the dashboard |
| `areas[].evidence[].{kind,src,at}` | `code\|run\|test\|doc\|answer` / src token (§2.8) / `YYYY-MM-DD` | y | Evidence class, citation (must satisfy the grammar), date produced |
| `areas[].evidence[].cross` | bool | n | The bullet this row came from cited **two or more distinct files**. Weighs double |
| `areas[].evidence[].confidence` | `measured\|inferred\|assumed` | n | The bullet's own annotation. `assumed` weighs half |

**Level formula** (deterministic, integer table). Per evidence item aged `d` days:
`recency = max(0.25, 1 - d/365)`; `weight = code 1.0 · run 1.0 · test 1.0 · answer 0.8 · doc 0.5`, **× 2 when the row
is `cross: true`** and **× 0.5 when it is `confidence: assumed`**; `W = Σ recency·weight`.

The four steps run **in this order**, and the order is part of the rule:

1. **Thresholds.** `level = 0 if W<0.5 · 1 if <1.5 · 2 if <3 · 3 if <6 · 4 if <20 · else 5`.
2. **Run cap.** No `kind: run` row in the area ⇒ `level = min(level, 3)`.
3. **Top-rung kinds check.** `level == 5` with fewer than 2 distinct `kind` values ⇒ `level = 4`.
4. **Distinct-source cap.** `level ≤ count(distinct src)`.

**Why recency decays instead of stepping (2026-08-29).** There used to be a fifth step, a staleness cap that pinned
any area whose newest row was over 180 days old at level 2, and a four-band recency table underneath it. Both were
cliffs: an expert trained on day 179 and the same expert on day 181 knew identical things and the ladder reported 4
and 2. Knowledge fades; it does not expire on a Tuesday. One continuous factor replaces both, floored at 0.25 so a
year-old reading is worth a quarter of a fresh one rather than nothing.

**Why a cross-file finding counts double.** Breadth of FILES was the only thing the old formula measured, and the
training prompt said so in as many words ("reading twelve files is worth twelve") — a Goodhart instruction that got
the expected result. A model can re-derive anything a single file says by reading that file. What it cannot re-derive
is the relationship between two of them: a default that contradicts its docstring, a caller passing a key the callee
never registers, a path nothing reaches. A row derived from a bullet citing two or more distinct files is that kind
of finding, and it is the only shape of evidence weighted above its kind. `confidence: assumed` is the mirror image:
a hypothesis with a citation attached is half a row.

**Why the top two rungs are gated on a measurement.** Reading a file is evidence that code SAYS something; running a
command is evidence that it DOES it. Measured 2026-08-29 on a real workspace: `aparece-api` held 15 `code` + 2 `test`
rows, every one written the same afternoon by one reading session, nothing ever executed — and the ladder as it then
stood computed **5/5**, the top of the chart, for an expert that had never run a thing in the repo it spoke for. So
level 4 now requires at least one `run` row — a command actually executed, cited with the §2.8 `cmd` production
`$ <cmd> → exit <n>` — and level 5 requires, on top of that, a body of work broad enough to span two evidence kinds
and heavy enough to clear `W ≥ 20` (the fifth threshold, raised from 12 for the same reason: at 12 one afternoon of
reading reached the ceiling).

Worked example, all evidence fresh (recency 1.0), all `src` distinct:

| Evidence | W | Thresholds | Run cap | Kinds | Sources | **Level** |
|---|---|---|---|---|---|---|
| 15 `code` + 2 `test` | 17.0 | 4 | → **3** | 2 | 17 | **3** |
| … plus one `run` (`$ dotnet test → exit 0`) | 18.0 | 4 | passes | 3 | 18 | **4** |
| … plus one fresh `doc` and two more files read | 20.5 | 5 | passes | 4 | 21 | **5** |
| 8 `code` + 1 `run`, all 400 d old (recency 0.25) | 2.25 | 2 | passes | 2 | 9 | **2** |

`run` is necessary, not sufficient: one `run` row alone is `W = 1.0`, which is level 1. And the caps still outrank it —
25 readings of one line plus one `run` is two distinct sources, so level 2.

**Validation.** `level` equals the formula output (recomputed at write; mismatch rejected); every `src` matches the
grammar; ≤60 areas, ≤50 evidence items per area. Every area's level is recomputed on **every** write, not only the
trained one — that is what makes a hand-edited number temporary.

**Contradiction guard.** `tldrx expert list` also prints one **stderr** line per `file:line` that two or more experts
cite with bullets whose normalised texts differ:
`warning: shared citation <file:line> by <a>,<b> — check for contradiction`. It resolves nothing, deliberately —
deciding which expert is right is not something a deterministic tool can do, and guessing would be worse than the
silence it replaces. Identical sentences are agreement, not contradiction, and are not reported. Measured 2026-08-29:
16 files on one workspace were cited by two trained experts each and nothing anywhere compared what the two said.

**An unrecognised `kind`, or a `src` that does not fit its `kind`, is refused out loud.** Three refusals, one channel —
stderr or a dashboard warning line, always in the shape `warning: <expert>/<area>: N evidence row(s) ignored — <why>`:

| `<why>` | When |
|---|---|
| `unknown kind '<x>' (allowed: code, run, test, doc, answer)` | `kind` is not one of the five |
| `malformed src '<x>'` | `src` does not parse as a §2.8 `src` at all |
| `kind '<k>' needs a <form> src` | `src` parses, but as the wrong class for that `kind` |

The classes: `code` ⇒ `file`; `run` ⇒ `cmd`, or a `file` under `tldrx-work/`; `test` ⇒ `file` or `cmd`; `doc` ⇒ `doc`;
`answer` ⇒ `fact`. Measured 2026-08-29: an in-session training wrote two `kind: test` rows, both were dropped without a
message, and `expert list` printed 15 evidence over a file holding 17. A reader that silently discards data makes every
count downstream of it a claim rather than a measurement. And until the `src` classes were checked, `{kind: run, src:
"the tests pass"}` counted as a run — which, under the run cap above, is the whole difference between level 3 and level
4. **On the way IN the rule is harder than a warning:** `tldrx expert train` REFUSES to write a row whose `src` does not
fit its `kind` (exit 1). A reader is judging a file a human may have hand-edited; a writer is judging what the framework
itself derived, so a bad row there is a bug, not bad input.

**Where evidence comes from.** Only `tldrx expert train` writes it, and it is DERIVED from a knowledge file's
citations rather than asserted by the sub-agent that wrote them:

| Kind | Written when | `src` |
|---|---|---|
| `code` | the knowledge file cites a line in a repo | the FIRST citation of that file, `repo:path:line` — one row per distinct **file**, so twelve readings of one file are worth one row and the §2.6 distinct-source cap stays meaningful |
| `run` | `from-runs-<area>.md` cites a past run's handoff or retro, or a knowledge file cites a command that was executed | `tldrx-work/<run>/<file>:<line>`, or `$ <cmd> → exit <n>` — one row per command, exit code included |
| `test` | a knowledge file cites a test that was read or run | `repo:path:line`, or `$ cmd → exit n` for a test run |
| `answer` | either file cites a recorded fact | `F<n>` |
| `doc` | the knowledge file cites an `https://` URL | the URL |

**Where a `run` row comes from.** From a command the expert actually executed, cited in its knowledge file as the §2.8
`cmd` production `$ <cmd> → exit <n>`, and from nothing else that a light run can do. Both training paths reach it: the
headless/`--commit` path DERIVES the row from the citation when it re-reads the knowledge file off disk, and a session
driven by `--print-prompt` writes the row by hand, where `tldrx expert recompute` counts it like any other. The command must be one
`.tldrx/workspace.yml` declares — that is the §2.8 resolver rule for every `cmd` src, not a training-specific one, and
an undeclared command fails the knowledge file whole. It is also exactly the set the sub-agent is granted as
`Bash(<command>)` tools and the set its prompt names, so the permission, the instruction and the evidence rule are one
list. A workspace that declares no command grants no `Bash` at all: no `run` row is reachable there, and the run cap
holds every area of it at level 3. Full mode additionally mints `run` rows from `from-runs-<area>.md` citations into
past runs (`tldrx-work/<run>/<file>:<line>`) — decisions that were made while something was actually being built.

`absent:` sources are legal in a knowledge file and produce **no** evidence: "I looked here and there is nothing" is a
finding, not a measurement. A knowledge file is accepted or rejected **whole** — one unsourced item, one cited line
past the end of its file, or one execution claim sourced to a file (below), and nothing is written: no evidence, no
level change, no status change, and the file is moved to `<area>.rejected.md` so it cannot be mistaken for accepted
knowledge.

**A citation must SUSTAIN the claim, not only resolve (2026-08-29).** §2.8's resolver answers "does this line exist";
it cannot answer "is this line evidence for that sentence". Four rules close the gap. One is a **refusal**, and it
rejects the file:

| Rule | Message | When |
|---|---|---|
| execution claim | `execution claim needs a '$ <cmd> → exit <n>' src, not a file line` | the claim asserts a RESULT — `exit <n>`, `N/M passed`, "the build is green", or the word "measured" in the sentence itself — and no `cmd` src is attached |

Three are **warnings**: they cost that citation its evidence row and leave the file accepted, because none of them is
a lie — they are ways of being worth nothing, and the honest response to worth nothing is a level that does not move:

| Rule | Message contains | When |
|---|---|---|
| paraphrase | `paraphrase` | the bullet is ≥90% a verbatim substring of the ±3-line neighbourhood of the line it cites, normalised |
| domain | `outside domain` | the cited path is outside the expert's own `## Domain`; the expert whose domain does contain it is named |
| dedup | `duplicate src` | the same `src` is already on record in this expert, here or in another of its areas |

And `## Sources` derives **no** evidence at all. It is a recap — one line per citation already made above — so counting
it buys a second row for one reading. Measured 2026-08-29 on a real corpus: it was 41 of 107 bullets in one trained
file and 18 of 56 in another, every one of them re-citing something cited above.

**Why the execution rule exists, measured.** The header of a real `knowledge/aparece-api.md` asserts ``dotnet build``
exit 0, "measured, exit code captured unpiped", citing `.tldrx/workspace.yml:19` — the line that DECLARES
`build: dotnet build`. It claims "78/78 passed, exit 0" citing a line of the test script. Every citation resolves.
None of them is evidence that anything ran. The rule is applied to prose paragraphs as well as bullets, because that
header is a paragraph and its tokens sit mid-line, where a line-anchored parser never looks.

**The confidence annotation.** A bullet may carry `(measured)` / `(inferred)` / `(assumed)` before its token, or the
leading `*measured* —` form; both spellings appear in the real corpus and both are parsed onto the row as
`confidence:`. The annotation is stripped before the execution rule matches — inside it the word is a LABEL, and
refusing a file for obeying §2.3's "say which of measured / inferred / assumed each claim is" would be the rule being
wrong, not the file.

### 2.6.1 `.tldrx/experts/<name>/training.jsonl`

The cost and provenance ledger of every training run, append-only, one JSON object per line. `[assumption]` — §2.9's
`events.jsonl` is **run-scoped** (its envelope requires a `run` id, it lives inside `tldrx-work/<run>/`, and `run
status` / `replay` / `retro` / the dashboard all read it as one run's history). Training belongs to an EXPERT and
outlives every run, so it gets its own file beside the expert, with §2.9's exact envelope shape — seven keys, closed
`type` set, append enforced by comparing file byte length before and after — and `run` replaced by `expert`, `stage` by
`area`.

```json
{"ts":"2026-09-01T12:00:00Z","expert":"dotnet-stack","area":"ef-core","type":"agent.result","actor":"alan","cost_usd":1.02,"payload":{"task":"code","mode":"light","model":"sonnet","session_id":"…","max_budget_usd":2.00,"outputs":["knowledge/ef-core.md"],"usage":{"input_tokens":184203,"output_tokens":9114},"ok":true}}
{"ts":"2026-09-01T12:00:00Z","expert":"dotnet-stack","area":"ef-core","type":"check.passed","actor":"alan","cost_usd":0,"payload":{"mode":"light","evidence_added":7,"evidence_total":7,"level_before":0,"level_after":3,"cost_usd":1.02}}
```

`type` ∈ `agent.spawned` `agent.result` `check.passed` `check.failed`. A run that is REFUSED still writes its
`agent.result`: money spent is recorded whether or not the knowledge was kept (spec §5, "never rolls back cost").

**`--max-budget-usd` is a stop, not a cap — measured.** Pilot smoke, 2026-08-29,
`tldrx expert train typescript-stack --area typescript --mode light --max-usd 1.5` over
mobile + scavtopia-lab: the sub-agent was killed with `subtype: error_max_budget_usd`,
`errors: ["Reached maximum budget ($1.5)"]` — after `total_cost_usd: 5.15325` on a single
turn (`num_turns: 1`, 597 s, 105,698 cache-creation + 60,548 output tokens on a 1M-context
model). The flag ends the run once a turn's cost is known; it cannot end a turn already in
flight, so on a large-context model the realised spend can exceed the ceiling several times
over. Size a training prompt for the money you are willing to lose, not the ceiling you
passed. The run itself behaved correctly: a non-zero `claude` exit is a failed run, so
nothing reached `competencies.yml`, the ledger recorded the $5.15, and the knowledge file
the agent had already written was quarantined rather than left where an accepted one lives
(it would in fact have validated — 111 sourced items, 21 distinct files, level 5).

### 2.7 `tldrx-work/<run>/<phase>/questions.md`

The Interview artefact and human interface of the loop; only unknowns become questions. The file is the contract, the
channel (terminal in v0, chat bridge later) is not.

```markdown
# Questions — 02-how — run 260828-leaderboard

## Q4 · Where does leaderboard state live?
<!-- id: Q4 | status: open | area: data-model | asked_by: architect | asked_at: 2026-08-28T14:02:11Z -->
Why asked: no ranking store exists in the map [src: absent:.tldrx/map/api/domains.md]

- A) New Postgres table, recomputed on hunt completion
- B) Redis sorted set
- C) other — write it below

[Answer]:

## Q5 · Is per-tenant isolation required for rankings?
<!-- id: Q5 | status: answered | area: multi-tenancy | asked_by: architect | asked_at: 2026-08-28T14:02:11Z -->
Why asked: Place.TenantId is nullable [src: api:src/Scavtopia.Domain/Places/Place.cs:22]

- A) Yes, per tenant
- B) No, global

[Answer]: B — rankings are global, same as Places
<!-- answered_by: alan | answered_at: 2026-08-28T15:10:03Z | fact: F021 -->
```

| Element | Rule |
|---|---|
| Heading | `^## (Q\d+) · (.+)$` — id then a one-sentence question |
| Metadata comment | HTML comment, pipe-separated; keys `id status area asked_by asked_at` all required; `status` ∈ `open\|answered\|withdrawn` |
| `Why asked:` line | Required; must end with a `[src: …]` token (§2.8) — proves the gap is real |
| Options | 2–5 bullets `- X) text`, letters A–E in order; the last may be free text |
| `[Answer]:` slot | Exactly one per block, on its own line |
| Answer footer | HTML comment written by the hook: `answered_by`, `answered_at`, `fact` |

**Answer detection (hook).** A block is answered iff its metadata says `status: open` **and** the line matching
`^\[Answer\]:[ \t]*(\S.*)$` inside it has a non-empty capture. The hook flips `status: answered` and appends the footer,
a `facts.yml` entry (`kind: answer`, `source.q: Q4`) and a `question.answered` event, storing the text verbatim.

**Validation.** Ids unique and ascending; block count ≤ `stage.yml questions.max`; all six elements present; ≤40 lines
per block.

**The grammar is a parser's, not a style (2026-08-29).** The heading regex is exact — `^## (Q\d+) · (.+)$`, `·` being
U+00B7 — and a block that misses it is not half-read, it is read as **absent**. Measured: a stage followed
`templates/questions.md`, which taught `### Q1 — …` and `**Answer:**`, the parser found zero blocks, the auto gate
recorded "0 open questions" as satisfied and signed itself over four unanswered ones. Three things now stop that:

- `templates/questions.md` IS the grammar, with one complete worked example, and the same block is inlined into every
  `stage.md` that may write questions.
- **`tldrx questions lint [--run <id>] [--fix]`** reports every heading matching `#{2,4}\s*Q\d+` that the parser cannot
  read and exits `2`; `--fix` converts the prose form to the grammar **without changing a word** — title, `Why asked:`,
  every option and any answer already typed come across verbatim, and an unlettered `- Other:` keeps its text as the
  next letter. It does **not** invent the `[src: …]` token §2.7 wants on `Why asked:` — the prose form had no such
  rule, and a tool that manufactures a citation to satisfy a validator is producing the exact thing §2.8 exists to
  stop. The converted blocks that still need one are listed by id.
- A stage whose `stage.yml outputs:` names a `questions.md` cannot close an **auto** gate over one that is unreadable or
  holds zero parseable blocks (§5, condition 2), and `tldrx next --commit` refuses such a file with exit `5`.

### 2.8 `tldrx-work/<run>/<phase>/handoff.md` + the `src` grammar

One handoff per stage: what was found, decided, still unknown, and the ledger a reviewer can re-run. **Every bullet in
all four sections ends with a `[src: …]` token**, and **each of the four sections holds at least one list item** — a
section with genuinely nothing in it is written as `- none [src: absent:<what was looked at>]`, never as prose.

```markdown
# Handoff — 02-how / contracts — run 260828-leaderboard
Stage: contracts · Expert: architect · Model: sonnet · Cost: $2.61 of $3.00 ceiling · 2026-08-28T14:31:40Z

## Findings
- Hunt completion already emits a HuntCompleted domain event [src: api:src/Scavtopia.Domain/Hunts/Hunt.cs:184]
- The lab SDK is generated, so a DTO change is a two-repo change [src: F003]

## Decisions
- Leaderboard reads come from a materialised view refreshed on HuntCompleted [src: Q4]
- No new auth policy; existing Auth0Only covers it [src: api:src/Scavtopia.Api/Program.cs:96]

## Unknowns
- Retention period for historical rankings [src: absent:.tldrx/memory/facts.yml]
- Whether mobile needs paging beyond top-50 [src: Q6]

## Evidence ledger
- Contract project builds clean [src: $ dotnet build → exit 0]
- Vendor rate limits confirmed [src: https://developers.example.com/limits]
```

A section with nothing in it still carries one item, and that item names what was checked:

```markdown
## Unknowns
- none [src: absent:.tldrx/memory/facts.yml]
```

```
token  := "[src: " src ("; " src)* "]"
src    := file | doc | ans | fact | cmd | graph | absent
file   := [repo ":"] path ":" line ["-" line]      # repo ∈ workspace.yml names
doc    := "https://" nonspace+                     # http:// rejected
ans    := "Q" digit+                               # a question in this run
fact   := "F" digit{3,6}                           # facts.yml id
cmd    := "$ " command " → exit " digit+           # command must exist in workspace.yml
graph  := "graph:" nodeid                          # a graphify node id
absent := "absent:" path                           # looked here, found nothing
```

**Validation.** The four sections present in that order; each holding **at least one list item** — a section that is
present but carries only prose is an error, because a paragraph offers the checker nothing to check and "no unknowns
that we can see" is exactly the claim that most needs a source; **every list item** inside them ends with a valid token —
`- item`, `1. item` and `1) item` all count, and an item runs to the next line that starts at column 0, so a
soft-wrapped citation on an indented continuation line still counts. An ordered marker is only a marker at column 0
(`…global since` / `  2019. That has not changed` is one wrapped item, not two). `file` paths exist with the line in
range; `cmd` tokens only in `Evidence ledger`; `doc` requires https; ≤200 items.

**A token may be followed by punctuation, and only by punctuation.** It must be the LAST semantic element of the line;
closing quotes, backticks, brackets and a terminal `.` / `,` / `;` / `!` / `?` after the `]` are ignored. Measured
2026-08-29: a real user's first `tldrx next` was refused with "9 unsourced bullet(s)" when all nine carried a citation
wrapped in backticks. A line holding a `[src:` marker the parser cannot read is now reported as a **malformed
citation**, not as an unsourced bullet — the two need different advice.

**Three outcomes, not two (2026-08-29).** Every `src` kind is resolved, and each resolution is `ok`, `refused` or
`unverified`:

| kind | resolved against | `refused` when | `unverified` when |
|---|---|---|---|
| `file` | workspace root / run dir / repo | no such file, or the line is out of range | — |
| `cmd` | `workspace.yml` `commands:` | not one of them, or cited outside `Evidence ledger` | the workspace declares no commands |
| `fact` | `.tldrx/memory/facts.yml` | no such id, or the fact is **retired** | there is no facts.yml |
| `answer` | every `questions.md` in the run | no block with that id | the caller passed no run dir |
| `graph` | `graphify-out/graph.json`, else `map/**` | not a node id, and not a token in the map | neither source exists |
| `doc` | URLs named by the run's artefacts, `map/**`, expert `knowledge/**` | — (never fetched, so never disproved) | nothing in the workspace cites it |
| `absent` | the path, plus the claim's own wording | the claim is POSITIVE and the section is not `Unknowns` | the path EXISTS (the absence is about its contents) |
| `aidlc` | nothing | — | — (provenance for a `--from` distill; §6) |

An `unverified` citation **does not fail a stage** — it is not a lie, it is a check nobody could run. It does stop an
**auto** gate from closing (§5, condition 5), because a citation nothing can check is exactly the one a person should
look at. Before this, six of the eight kinds returned ok unconditionally, and a handoff citing `F999`, `Q42`,
`graph:i-made-this-up` and `absent:ops/backup.yml` to assert "we removed the auth check from /admin" validated clean,
closed its own auto gate and advanced the cursor (measured probe, 2026-08-29).

`## Unknowns` is exempt from the `absent:` negative-claim rule, because that heading IS the negation: the example above
(`- Retention period for historical rankings [src: absent:…]`) reads as a positive noun phrase and means "we do not
know it".

**Resolving is not sustaining.** Every outcome above is a fact about the CITATION. Whether the citation supports the
SENTENCE is a separate question, and §2.6 answers it for knowledge files: a claim that asserts a result needs the
`cmd` production and is refused with a `file` line under it, a bullet that restates the line it cites earns no
evidence, and a citation outside the expert's declared `## Domain` earns none for that expert. Handoffs are not
subject to those rules today — `claim-sources` still judges a handoff bullet on resolution alone — and that asymmetry
is deliberate for now: a knowledge file becomes a LEVEL, which is a number other stages read as authority, while a
handoff is read by a person at a gate.

**Resolving a `file` src.** A `repo:path` resolves inside that repo, and an absolute path is taken as written. A bare
`path` is tried against three bases, in order — **first existing wins**: (a) the workspace root; (b) the run directory of
the handoff being validated (`tldrx-work/<run>/`, so a stage may cite its own outputs as `01-what/intent.md:1`); (c) only
when the path starts with a known repo name followed by `/`, that repo's directory with the name stripped —
`api/src/Hunt.cs` is a spelling of `api:src/Hunt.cs`. The line range is checked against whichever file resolved, and a
failure names every base it tried. `tldrx next`, `tldrx approve` and the `claim-sources` hook resolve identically: all
three are handed the run directory of the file they are judging.

### 2.9 `tldrx-work/<run>/events.jsonl`

Append-only audit log: with `run.yml` the dashboard's only data source, the cost ledger, and the `replay`/`retro` input.

**Type enum:** `run.created` `run.closed` `run.unlocked` `run.cancelled` `run.attended` `phase.started` `phase.done` `stage.started` `stage.done` `stage.failed`
`stage.skipped` `task.started` `task.done` `agent.spawned` `agent.result` `question.asked` `question.answered`
`gate.requested` `gate.approved` `gate.rejected` `gate.revoked` `story.reopened` `story.base_fastforwarded` `story.review_retried`
`check.passed` `check.failed` `budget.warned`
`budget.blocked` `budget.raised` `fact.added` `fact.retired` `fact.superseded` `map.refreshed` `ticket.synced` `error`. Closed set: an
unknown type is a validation error.

**`gate.revoked` and `budget.raised` were added 2026-08-29.** Both name a moment the log could not previously describe.
`gate.revoked` is `tldrx reject --stage <phase>/<stage>` taking an approval back (§5, "Revoking an approval"); its
payload carries `signed_by` — `auto` or a person — plus the `staled` list. `budget.raised` is `tldrx budget raise`,
which until then rewrote `budget.yml` and appended nothing at all: the one sanctioned way to move a ceiling was the one
act with no record. Its payload carries `phase`, `amount_usd`, `take_from`, before/after for both the phase and the run
ceiling, and the operator's `--note`.

**`run.created` carries `attended_by`** when `run new --attended-by host` set it, beside the fields it already carried;
absent on every other run, so an ordinary `run.created` is what it was.

**`run.attended` was added 2026-08-30.** It is `tldrx run attend`, flipping §2.2's `attended_by` on an open run. Its
payload carries `attended_by` (the new value, `host` or `null`) and `was` (the old one); `stage` on the envelope is
`null` and `cost_usd` is `0`, because the operator acted outside a stage run and it spends nothing. A no-op — setting
what is already set — appends NOTHING: a decision nobody made does not belong in the log.

**`story.reopened` was added 2026-08-30.** It is `tldrx story reopen <id> --note "…"` — a person giving ONE Build story
another run of developer attempts (§5, "Reopening a story"). Its payload carries `story`, `wave`, `from_status`,
`to_status`, `verdicts` (how many the closed run of attempts consumed), `reason` and the `note`; `stage` on the envelope is
`null`, because the operator acted outside a stage run. **`reason` was added 2026-09-01 (#61's sibling, #58)**: `fix` for
a FIX ROUND — `--for-fix`, a `done` story reopened to land one named defect, consuming no attempt and passing the same
DoD and the same reviewer — and `attempts` for the original verb. An event with no `reason` predates the key and is an
`attempts` reopen, the only kind that existed. A fix round opens on that event and closes when the story is `done`
again; one story may have exactly one open at a time. It is also the one event in the enum that is a **reset
boundary**: the Build executor's review ledger restarts every count at it, so verdicts recorded before it stop counting
against the reopened story. Nothing is rewritten to achieve that — the earlier events are all still in the file and
still read by `replay`, `cost` and `retro`.

**`story.base_fastforwarded` was added 2026-08-31.** It is the only event in the enum that records tldrx **moving a
ref**: a story branch that sat behind its epic tip, brought up to it before a developer was dispatched onto it (§5,
"Resolve and cut"). Its payload carries `phase`, `story`, `repo`, `branch`, `base` (the epic branch), `from` and `to`
(short shas) and `commits` (how many the move carried). It is appended ONLY when the ref actually moved — a divergent
or dirty branch is warned about on stdout and changed by nothing, so it has no event, because nothing happened. A
branch tldrx moves without saying so would be the framework editing the operator's git state silently.

**`story.review_retried` was added 2026-09-01 (#78, widened by #79).** It is the one event in the enum whose subject is
something that did NOT happen: a story's attempt was not spent. A review envelope refused for its **FORMAT** is a fault
in the reviewer's REPORT, not a fault in the diff, so Build asks for a corrected envelope instead of recording a
`changes` verdict against one of the story's two attempts (owner decisions, 2026-09-01, measured on
`260830-ordering-inventory`, where three envelopes cost three attempts). Its payload carries `phase`, `story`,
`attempt` (the one it did not spend), `retry`, `max_retries` and `detail` (the refusal verbatim). The bound is read
back off these events, so it survives a fresh `tldrx next` and the one-envelope-per-process host handshake alike; the
count resets at any recorded review verdict — including an errored one — because it is a bound per envelope round, not
per story. The refusal after the bound is recorded as the ordinary `check.failed` · `verdict: changes` it always was,
and costs the attempt.

**Scope — one rule: FORM never costs an attempt, CONTENT/WORK always does.** #78 shipped this for the claim-sources
grammar alone; #79 widened it to every envelope-FORMAT refusal, because they are the same kind of fault and two
economies for one kind of fault is a rule nobody can hold. Free and bounded: a `refuted` finding whose `[src: …]` does
not parse, a `fixlist` that is missing, not an array or empty, a row that is not an object, a row with no `finding`
text, a row with no valid `disposition`, and a verdict WORD outside the enum (#36 — its message is unchanged, only its
price). Still costs the attempt, unchanged: a verdict's CONTENT, a red DoD, a second fix-list round refused by its own
bound, a reviewer that never answered — and **any refusal the format index does not claim.** That last one is the
guard: the free round is granted only when every reason the envelope was refused is indexed as form
(`isFormatRejection`), so a future refusal about the WORK costs the attempt until somebody deliberately says otherwise.

```json
{"ts":"2026-08-28T14:29:58Z","run":"260828-leaderboard","stage":"contracts","type":"agent.result","actor":"architect","cost_usd":2.61,"payload":{"phase":"02-how","task":"t1","session_id":"1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d","model":"sonnet","outputs":["02-how/contracts.md"],"usage":{"input_tokens":184203,"output_tokens":9114}}}
{"ts":"2026-08-28T15:10:03Z","run":"260828-leaderboard","stage":"contracts","type":"question.answered","actor":"alan","cost_usd":0,"payload":{"q":"Q5","answer":"B — rankings are global, same as Places","fact":"F021"}}
```

| Field | Type | Req | Meaning |
|---|---|---|---|
| `ts` | RFC3339 UTC | y | Event time; lines non-decreasing in `ts` |
| `run` / `stage` | run id / slug\|`null` | y | Owning run (= folder name); `null` for run-level events |
| `type` | type enum | y | Closed set above |
| `actor` | str | y | Human id, expert slug, `facilitator`, or `hook:<id>` |
| `cost_usd` | number ≥0 | y | `0` when not a spend event; sums to `run.budget.spent_usd` |
| `payload` | object ≤4 KB | y | Free-form; object nesting ≤3 |

**Validation (appended line only).** One-line JSON ≤8 KB; exactly these seven keys; `type` in enum; append-only
enforced by comparing file byte length before/after — a write that shortens the file is rejected.

**Reading is tolerant, and says so.** A reader SKIPS any non-empty line that does not parse and keeps going — a
process killed between the `{` and the `\n` leaves a torn last line, and one torn byte must not cost the other
four hundred events. Skipped lines are COUNTED, never silent: `tldrx replay` prints `events.jsonl: 1 line skipped
(unparseable — a torn write)` and the shared reader says the same once per file on stderr. Only the WRITE path
validates; a reader that refused a bad line would be the same outage in a different place.

### 2.10 `.tldrx/env.yml`

Tool manifest for `tldrx doctor`. The framework never installs anything: `doctor` probes, prints the exact install
command, and records the result here.

```yaml
version: 1
checked_at: 2026-08-28T08:12:00Z
tools:
  - {id: bun, required: true, check: "bun --version", version_re: "([0-9]+\\.[0-9]+\\.[0-9]+)", min_version: "1.1.0",
     install: {macos: "curl -fsSL https://bun.sh/install | bash", linux: "curl -fsSL https://bun.sh/install | bash",
               windows: "npm install -g bun"},
     result: {found: true, version: "1.2.4", ok: true, checked_at: 2026-08-28T08:12:00Z}}
  - {id: graphify, required: false, check: "graphify --version", version_re: "([0-9]+\\.[0-9]+\\.[0-9]+)",
     min_version: "0.8.0", install: {macos: "pip install graphify", linux: "pip install graphify",
                                     windows: "pip install graphify"},
     result: {found: false, version: null, ok: false, checked_at: 2026-08-28T08:12:00Z}}
```

| Field | Type | Req | Meaning |
|---|---|---|---|
| `tools[].id` / `.required` | slug / bool | y | Unique tool key; `false` ⇒ degrade gracefully, `doctor` warns only |
| `check` | str | y | Probe command; single argv, no shell metacharacters |
| `version_re` / `min_version` | regex / semver\|null | y | Exactly one capture group; compared segment by segment, numerically |
| `install.{macos,linux,windows}` | str | y | Printed, never executed |
| `result` | {found, version, ok, checked_at} | n | Written by `doctor`; absent before first run |

**Validation.** Ids unique; `check` free of `; && | > \``; `version_re` compiles with one group; ≤64 tools. Required in
v0: `git`, `bun`, `claude`; optional `graphify`, `gh`, and env vars `CONTEXT7_API_KEY` / `GEMINI_API_KEY` as tools with
`check: "test -n \"$VAR\""` `[assumption]`.

### 2.11 `tldrx-work/<run>/budget.yml`

The ceiling the facilitator refuses to exceed. Actuals are rolled up from `events.jsonl` and mirrored into `run.yml`.

```yaml
version: 1
run: 260828-leaderboard
ceiling_usd: 25.0
per_agent_max_usd: 3.0
warn_at_pct: 80
on_exceed: block
phases: [{id: 01-what, ceiling_usd: 4.0, spent_usd: 1.14}, {id: 02-how, ceiling_usd: 7.0, spent_usd: 2.61},
         {id: 03-plan, ceiling_usd: 4.0, spent_usd: 0.0}, {id: 04-build, ceiling_usd: 8.0, spent_usd: 0.0},
         {id: 05-watch, ceiling_usd: 2.0, spent_usd: 0.0}]
```

| Field | Type | Req | Meaning |
|---|---|---|---|
| `run` / `ceiling_usd` | run id / number >0 | y | Owning run; hard run ceiling |
| `per_agent_max_usd` | number >0 | y | Passed as `--max-budget-usd` per sub-agent (Appendix A) |
| `warn_at_pct` | int 1–99 | n (80) | Emits `budget.warned` once per phase `[assumption]` |
| `on_exceed` | `block\|warn` | y | `block` ⇒ the budget-gate hook denies the spawn |
| `economy` | `metered-usd\|host-tokens` | n (`metered-usd`) | **What the numbers here are denominated in.** Run level; a phase may override it |
| `on_host_tokens_exceed` | `warn\|block` | n (`warn`) | What crossing a HOST-TOKEN ceiling does. `block` is the explicit opt-in |
| `ceiling_host_tokens` | number ≥0 | n | **The run's host-token allowance** — the ceiling `ceiling_usd` is not. Separate economy, separate ceiling |
| `phases[].{id,ceiling_usd,spent_usd}` | slug / number ≥0 | y | Per-phase ceiling and rolled-up actual |
| `phases[].economy` | `metered-usd\|host-tokens` | n (inherit) | This phase's own economy |
| `phases[].ceiling_host_tokens` | number ≥0 | n | This phase's host-token allowance, read only under `economy: host-tokens` |

**Validation.** Every phase id appears in `run.yml`; `spent_usd ≤ ceiling_usd` per phase unless `on_exceed: warn`; ≤5
phases. An `economy` naming a value this reader does not know is REFUSED, never defaulted to dollars — a unit nothing
here understands is not one it may quietly read as money. Absence, and an empty `economy:` key, both mean
`metered-usd`.

**The phase-ceiling sum runs ONCE PER ECONOMY (#61, 2026-09-01).** Σ ceilings of the `metered-usd` phases ≤
`ceiling_usd`; Σ host-token allowances of the `host-tokens` phases ≤ `ceiling_host_tokens`. Dollars and host tokens are
never added and never converted — there is no exchange rate here, and inventing one would be a guess about a price. The
token sum is checked only when `ceiling_host_tokens` is declared: a file that names no token allowance has said nothing
to compare a token total against, and the other number on the run is dollars. Under `economy: host-tokens` a phase's
allowance is `ceiling_host_tokens` when it has one and `ceiling_usd` otherwise — the compat reading, for files written
before the field existed, where the one unlabelled scalar WAS the token allowance.

**The two economies.** Measured 2026-08-30 on `260830-tenancy-identity-customers`: the Plan agent priced the run
assuming HOST-billed sub-agents — turns the host session pays for, which this process never meters and which are
~free to the run — and the executor then enforced those figures as dollar ceilings on METERED spawns. Six spawns of
six died on `Reached maximum budget`, each having spent real money to get there: **$9.95**. The money model was a
single scalar with no unit on it and had no way to say *"this number is not dollars."* Now it does:

| | `metered-usd` (the default) | `host-tokens` |
|---|---|---|
| the number means | dollars a spawn may spend | a host-billed budget in units nobody here meters |
| `--max-budget-usd` on a spawn | the cap, as today | **never derived from it** |
| `tldrx next` headless | spawns | **refuses, exit 2, before spending** (§5) |
| `tldrx next --prepare` / `--commit` (incl. `--review`) | runs | runs — this is where a host-billed turn belongs |
| budget-gate hook | denies on `spent + estimate > ceiling` | never denies; says so on stderr, **with the token spend** |
| auto-gate condition 3 | as today | `n/a (host-tokens economy)`, recorded in the note |
| `run.yml` `spent_usd` | Σ metered costs | stays 0 — an in-session turn reports no cost to roll up |
| `tldrx run estimate` | priced in USD | priced in TOKENS, labelled, never converted |

The two are **never converted into one another**. There is no exchange rate here, and inventing one would be a guess
about a price — which is the whole reason the label exists. `tldrx budget raise` rewrites this file through the same
emitter, and the label round-trips: a raise that erased it would turn a token budget back into dollars silently.

**Budget semantics — measured 2026-08-29.** `claude -p --max-budget-usd` is a *stop after the current turn*, not a
hard cap: a single long turn ran 597 s and spent **$5.15 against a $1.50 ceiling** (`error_max_budget_usd`, 105 k
cache-creation + 60 k output tokens) before the CLI stopped it. Therefore: the phase/run ceilings in `budget.yml`
are enforced *before* a spawn (the gate) and reconciled *after* it (actuals), and a single spawn can overshoot its
share by the cost of one turn. Keep prompts small (the inline caps exist for this reason), prefer several short
stages over one long one, and treat `per_agent_max_usd` as "the most we intend to spend", not "the most that can be
spent". Every overshoot is recorded (`agent.result`, `training.jsonl`), never hidden.

### 2.12 `.tldrx/process.yml`

The team's way of working, captured at the install interview (or `--process`), never assumed. The Plan phase renders
epics/stories/waves into this shape; experts read it like `conventions.md`.

```yaml
version: 1
methodology: kanban            # scrum | kanban | shape-up | none
cadence: {sprint_length_days: null, wip_limit: 3, review_day: null}
ticket_tool: {kind: jira, project: APP, board: null, sync: mirror-out}   # kind: jira | github | linear | none
story_granularity: days        # hours | days
approvers: [alan]
dod: {add: [], remove: []}
source: {who: alan, when: 2026-08-28T16:40:00Z, run: init, q: Q2}
```

| Field | Type | Req | Meaning |
|---|---|---|---|
| `methodology` | enum above | y | Drives the Plan renderer (sprints / flow board / plain list) |
| `cadence.*` | int\|null | n | Only the keys the methodology uses |
| `ticket_tool.kind` / `.project` / `.board` | enum / str\|null / str\|null | y / n / n | `none` disables the adapter |
| `ticket_tool.sync` | `mirror-out\|two-way` | n (`mirror-out`) | Files stay the source of truth; `two-way` pulls `external_status` only — **never advances `run.yml`, never marks a story done** |
| `story_granularity` / `approvers` | enum / str[] | y | Story sizing target; who may `approve` |
| `dod.add` / `.remove` | str[] | n | Team-level DoD deltas (scope deltas apply on top) |
| `source` | provenance (as §2.5) | y | Which interview answer produced this file |

**Validation.** Enums; `sprint_length_days` required iff `methodology: scrum`; `ticket_tool.project` required unless
`kind: none`; `approvers` non-empty.

**Where the values come from.** The install interview (§2.7, `.tldrx/init-questions.md`) asks two `area: process`
questions, and `tldrx interview --init` applies their answers to this file — recording them only as facts would leave
`tldrx tickets` (§5.1) reading `kind: none` after a human had said otherwise. `None` is option **A** in both, because
`--yes-to-defaults` takes option A and a default a machine picks must commit the team to nothing.

| Answer | Written |
|---|---|
| `None` / `Scrum` / `Kanban` / `Shape Up` | `methodology: none\|scrum\|kanban\|shape-up`, plus `cadence.sprint_length_days` (scrum) or `cadence.wip_limit` (kanban) when that key is still null |
| `None` / `Jira` / `GitHub Issues` / `Linear` | `ticket_tool.kind` |
| `GitHub Issues` | `ticket_tool.project` = `owner/repo`, parsed from `git remote get-url origin` of the root, else of the first `workspace.yml` repo with a GitHub remote. No GitHub remote ⇒ `project` is left unset and a note says so |
| `Jira` | `ticket_tool.project` is **not** guessed; a note names the key to set |
| `other` / free text | nothing is written; the answer stays a fact and a note names the key to set by hand |

Every other key, the file's key order and its leading comment header survive; nothing is written when the bytes would
not change, so re-answering the same way is a no-op. `[assumption]` — `kind: jira` is applied with `project` still
null, which the validation rule above rejects. Refusing the answer the human just gave is worse: the note says which
key to fill and `tldrx tickets sync` refuses by name until it is filled.

**`ticket_tool.sync`, in full** — this is the field `tldrx tickets` (§5.1) acts on, and it has exactly two values:

| Value | Out | In | Never |
|---|---|---|---|
| `mirror-out` (default) | Creates/updates one remote issue per epic and story; writes `external:` into the file | nothing at all | — |
| `two-way` | The same push | Reads each issue's status and writes it, VERBATIM, to `external_status:` | advances `run.yml`, changes `status:`, marks anything done |

"Two-way" is a deliberate misnomer for what a reader might expect: the second direction is **one opaque string into one
front-matter key**, and no more. `external_status: Done` and `status: todo` in the same file is a legal, expected state —
`tldrx tickets status` is the command that shows you the pair, and it is your job, not the adapter's, to decide which is
right. `ticket_tool.project` is the GitHub `owner/repo` or the Jira project key; `kind: none` means the adapter never
runs, and an absent `process.yml` means the same thing.

`ticket_tool.kind: linear` is in the enum and has **no adapter in this build** — `tldrx tickets sync` exits `1` and says
so rather than silently doing nothing.

### 2.13 `tldrx-work/<run>/03-plan/stories/<id>.md`

The unit the Build phase picks up cold: one repo, one branch, one Definition of Done a hook can re-run. The
machine-read half is a YAML front-matter block; the body is prose plus the fenced ```dod block, which is executed
rather than read.

````markdown
---
version: 1
id: S3
epic: E1
title: "Leaderboard read model"
repo: lab
status: todo
depends_on: [S1]
touches: ["src/features/leaderboard/", "src/services/generated/"]
acceptance:
  - "Top-50 ranks render from the materialised view, newest hunt first"
  - "A hunt completed while the page is open moves the player within one refresh"
test_plan:
  - "Unit: rank ordering with ties, empty table, single player"
  - "Integration: HuntCompleted refreshes the view"
evidence: []
---

# S3 · Leaderboard read model

## Context
Why this story exists, sourced. [src: 02-how/contracts.md:14]

## Definition of done

```dod
npm run test
npm run lint
```

## Evidence
Filled by Build, one bullet per proof. [src: $ npm run test → exit 0]
````

| Field | Type | Req | Meaning |
|---|---|---|---|
| `version` | `1` | y | Spec §0: unknown version ⇒ exit 1 |
| `id` | `^S\d{1,4}$` | y | Story id; **must equal the file name** (`S3` ⇒ `S3.md`) |
| `epic` | `^E\d{1,4}$` | y | The epic whose branch this story merges into; that epic must list this story back |
| `title` | str ≤512 | y | One line, human |
| `repo` | `^[a-z0-9-]{1,32}$` | y | A `workspace.yml` repo name — the worktree's repo and the DoD's cwd |
| `status` | `todo\|in_progress\|review\|done\|blocked` | y | The line `dod-gate` watches for `done` |
| `depends_on` | `S<n>[]` (≤64, unique) | y | Stories that must be done first; may not contain this story. `waves.yml` must place every one of them in an earlier wave |
| `touches` | rel path[] (≥1, ≤128) | y | Files/dirs this story is expected to change; no `..`. Two stories in one wave touching the same path is a plan smell, not a schema error |
| `acceptance` | str[] (≥1, ≤64) | y | What must be true for a human to accept it |
| `test_plan` | str[] (≥1, ≤64) | y | How it will be proven, before it is written |
| `evidence` | str[] (≤64) | y | Filled by Build. **Required non-empty when `status: done`** — done means proven, not asserted. May cite `04-build/fixlist/<id>-<n>.md` beside the review log when the story went through a fix-list round |
| ` ```dod ` block | fenced, ≥1 command | y | Each line must equal a `workspace.yml` command **verbatim**; `dod-gate` re-runs all of them from `repo` and every one must exit `0`. Editing `workspace.yml` therefore orphans every approved story that cited the old string — `tldrx plan sync-dod` is the mechanical repair, and the drift message names it |

**Validation.** Front matter present and parseable; keys and enums as above; `id` matches the file name; `depends_on`
free of self-reference and duplicates; every ` ```dod ` command in `workspace.yml` (skipped when there are no commands to
check against, same `[assumption]` as a `cmd` source). `[assumption]` — the wave brief names the five story states and
is silent on granularity caps, so the list caps above are chosen in the spirit of §0's bounded-file rule.

### 2.14 `tldrx-work/<run>/03-plan/epics/<id>.md`

A branch and a list of stories. Concept §9: `epic/<epic>` ← `story/<id>` worktrees; a story merges to its epic on
green, and the epic merges to main after integration tests and a human gate.

```markdown
---
version: 1
id: E1
title: "Player leaderboard"
repos: [api, lab]
stories: [S1, S2, S3]
branch: epic/leaderboard
status: todo
---

# E1 · Player leaderboard
```

| Field | Type | Req | Meaning |
|---|---|---|---|
| `version` | `1` | y | As §0 |
| `id` | `^E\d{1,4}$` | y | Epic id; must equal the file name |
| `title` | str ≤512 | y | One line, human |
| `repos` | repo name[] (≥1, unique) | y | Every repo its stories touch — an epic may span repos, a story may not |
| `stories` | `S<n>[]` (≥1, unique) | y | The stories on this branch; each must have a file, and each must name this epic back |
| `branch` | `^epic/[a-z0-9][a-z0-9-]{0,48}$` | y | Cut from the repo's `default_branch`; story worktrees branch off it. **Ignored when the run's epics form a dependency chain** — see below |
| `status` | same enum as §2.13 | y | `[assumption]` — an epic reuses the story states rather than inventing a second vocabulary |

**Validation.** As above, plus: a story belongs to exactly one epic, and the story ↔ epic reference agrees in both
directions.

**Branch model (issue #57, owner decision 2026-09-01, option (a)).** If any story's `depends_on` names a story in
ANOTHER epic, the epics form a dependency chain and the run cuts ONE integration branch — `epic/<run-id>`, forced into
the same `^epic/…$` shape — into which every story merges; the epics remain labels and groupings and their own
`branch:` is not cut. Otherwise it is one branch per epic, exactly as the table says. The `plan` check states which,
in its passing detail, so the branch model is known before Build starts. The Build executor records what it used in
`run.yml` (`build.branch_model: per-epic | integration`, additive and optional); a run whose `run.yml` names branches
but no model predates the key and stays `per-epic`, so it resumes on the branches it already cut.

### 2.15 `tldrx-work/<run>/03-plan/waves.yml`

The execution order, and the only file that says what may run at the same time.

```yaml
version: 1
waves:
  - {id: W1, stories: [S1, S2]}
  - {id: W2, stories: [S3]}
```

| Field | Type | Req | Meaning |
|---|---|---|---|
| `version` | `1` | y | As §0 |
| `waves[].id` | `^W\d{1,3}$` | y | Unique, and **ascending in file order** — the file order is the execution order |
| `waves[].stories` | `S<n>[]` (≥1, ≤32) | y | Run in parallel, one worktree each; a story appears in exactly one wave |

**Validation.** Shape as above (≤32 waves, ≤200 scheduled stories); every scheduled story has a file, and every story
file is scheduled; and the rule the shape cannot enforce alone — **every story's `depends_on` must be in an EARLIER
wave**. A dependency in the *same* wave is an error, not a warning: those two stories would be handed to parallel
agents that overwrite each other. Concept §9: "wave N+1 starts only when wave N's epic branch is green."

**Where it is enforced.** `tldrx approve` re-runs the `plan` check at the Plan gate, which reads all three artefacts
together — the only place the cross-file rules can be checked, since each file on its own is well formed.

### 2.16 `tldrx-work/<run>/05-watch/watchers/<feature>.md`

One card per shipped feature: the signal that proves it works, where it is read, the healthy baseline, what broken looks
like, and a copy-paste query. Concept §10: **generated from what Build actually instrumented — not aspirational.** A
watcher describing a log line somebody meant to add is worse than no watcher, because it reads as coverage and the first
person to trust it is on call.

````markdown
---
version: 1
id: leaderboard
epic: E1
title: "Player leaderboard"
stories: [S1, S3]
repos: [api, lab]
status: draft
---

# leaderboard · Player leaderboard

## Signal
- `leaderboard.refreshed` is written on every refresh [src: api:src/Leaderboard/RefreshHandler.cs:64]
- No counter exists for a refresh that finds zero rows — add one [src: absent:api/src/Leaderboard]

## Where
- Application Insights → `traces`, filtered to the message above [src: F014]

## Healthy baseline
- 12–40 refreshes/hour in business hours, measured 2026-08-29 [src: F015]

## Looks broken when
- Zero refreshes for 30 minutes while hunts are still completing [src: api:src/Leaderboard/RefreshHandler.cs:64]

## Query

```kql
traces | where message == "leaderboard.refreshed" | summarize count() by bin(timestamp, 1h)
```

## Sources
`RefreshHandler.cs:64` is the only place the event is emitted.
````

| Field | Type | Req | Meaning |
|---|---|---|---|
| `version` | `1` | y | Spec §0: unknown version ⇒ exit 1 |
| `id` | `^[a-z0-9][a-z0-9-]{0,48}$` | y | Feature id; **must equal the file name** (`leaderboard` ⇒ `leaderboard.md`). Taken from the epic's `branch:` slug (`epic/leaderboard`), else the lowercased epic id |
| `epic` | `^E\d{1,4}$` | y | The epic this feature was built on — one feature per epic (§2.14) |
| `title` | str ≤512 | y | One line, human |
| `stories` | `S<n>[]` (≥1, unique) | y | The **done** stories the card was written from (§2.13) |
| `repos` | repo name[] (≥1, unique) | y | Every repo the feature touched |
| `owner` | str ≤512 | **n** | Who to ask about this feature. The default for its items; an item may override with `(owner: <name>)`. Absent ⇒ `watch check` names the repo the item's citation points at, as it always did |
| `status` | `draft\|verified` | y | **Set by the framework, never by the model** — see below |
| H2 sections | `Signal` · `Where` · `Healthy baseline` · `Looks broken when` · `Query` · `Sources` | y | In that order |

**The four checked sections.** Every list item under `Signal`, `Where`, `Healthy baseline` and `Looks broken when` ends
with a §2.8 `[src: …]` token, validated by the **same parser** `claim-sources` uses — a card checked by a second reader
would drift from the rule the hook enforces, and the drift would show up as a card that passes `watch check` and is
denied on write. Three source kinds carry the weight here: `<repo>:<path>:<line>` for a line in the code that was
actually built, `F<n>` for a recorded fact, and `absent:<path>` for "the code emits nothing here". `[assumption]` — a
`$ <cmd> → exit <n>` source is legal **anywhere on a card**, unlike in a handoff (§2.8 confines it to the Evidence
ledger): a card has no claims/ledger split, every section on it is evidence about a running system, and "the baseline is
40/hour `[src: $ … → exit 0]`" is the most honest form that claim takes.

**An owner is optional and never invented (gh #70).** `watch check` used to answer "who owns this signal" by deriving
a repo from the item's own citation — `[src: api:src/Leaderboard.cs:64]` → `api` — which answers *which repo emits it*
rather than *who gets paged when it stops*. A card may now say: the front-matter `owner:` above, or `(owner: <name>)` on
an individual item, written **before** its `[src: …]` token because §2.8 makes that token the last thing on the line.
Resolution is item → card → repo-derived, and the printed line says which of the three it is showing. Both forms are
optional and validated only when present, so every card written before this key existed still validates and still prints
exactly what it printed before. The Watch prompt inlines `ownership` facts (§2.5) for the same reason the rest of the
card is inlined: a sub-agent asked for a name with no source for one would invent it. `(owner: )` with an empty name is
a **shape** issue, not an absence — it is a card that tried to name somebody and lost the name, and falling through to
the repo would be the exact substitution this rule exists to stop.

**`status` is computed, not claimed.** `verified` iff **no `absent:` source remains under `## Signal`**; otherwise
`draft`, and the card says what to instrument. The executor re-reads the card off disk and rewrites the one line, so a
sub-agent that stamps its own work `verified` changes nothing. `tldrx watch check <feature>` re-runs both halves — every
citation still resolves, and the stamped status still equals the one the Signal sources earn — which is how a card
hand-edited to `verified`, or one whose code has moved since, is caught months after the run closed.

**`Query`** must hold a fenced block; a described query is not a copy-paste query. **`Sources`** is prose — each citation
above, once, with what it establishes.

**Validation.** Front matter present and parseable; keys, ids and enums as above; `id` equals the file name; the six
sections present in order; each of the four checked sections holding at least one list item, and every item in them
ending with a token that parses and resolves. Issues are reported in two kinds: `shape` (the card is malformed — the
stage fails) and `source` (a citation does not resolve — usually the code moving under an old card, which is what
`watch check` exists to find).

### 2.17 `tldrx-work/<run>/.agent/<stage>/evidence.md`

The gate **evidence note**: the artefact an `agent` gate is closed over. Front matter is the machine half (what
`run status` and `replay` read); the body is the human half (what the §2.8 rule validates) — the §2.13 story pattern,
reused rather than reinvented. Scratch, beside `prompt.md`, and therefore gitignored (§1); the copy that gets committed
is the one `approve` makes into the run tree, because a gate whose evidence lives only in a gitignored directory is a
gate nobody can audit from a clone.

````markdown
---
version: 1
gate: 03-plan/plan
role: agent
by: fable
at: 2026-08-30T22:14:03Z
verdict: sign                 # sign | sign-with-fixlist | refuse
read: ["03-plan/waves.yml", "03-plan/epics/E1.md", "03-plan/stories/S1.md"]
citations: {sampled: 7, of: 34, resolved: 7, refuted: 0}
touches: {audited: 13, outside_surface: 0, new_areas: ["src/features/tenancy/"]}
diff_vs_stories: matches      # matches | diverges | n-a
caveats: ["read-only mandate — no DoD command was run by this reviewer"]
recommend: []
---

# Gate evidence — 03-plan/plan

## Read
- every story file and `waves.yml` [src: 03-plan/waves.yml:1]

## Citations checked
- 7 of 34 spot-checked, 7 resolved, 0 refuted [src: 03-plan/stories/S3.md:14]

## Touches audited
- 13 touched paths, all inside the What-cited surface [src: 01-what/handoff.md:12]

## Verdict
- SIGN — every dependency is in an earlier wave [src: $ tldrx questions lint --run 260830-tenancy → exit 0]
````

| Field | Type | Req | Meaning |
|---|---|---|---|
| `version` | `1` | y | Spec §0: unknown version ⇒ exit 1 |
| `gate` | `<phase>/<stage>` | y | The gate this note is evidence for. A note naming another stage is refused — that is a note pasted from somewhere else |
| `role` | `agent` | y | What KIND of signature this is. `by:` says who; a reader tells a person, the facilitator (`by: auto`) and an agent apart with one field each |
| `by` | str | y | The actor |
| `at` | RFC3339 | y | When it was written |
| `verdict` | `sign\|sign-with-fixlist\|refuse` | y | **Only `sign` closes the gate.** The other two are the note saying a human decides |
| `read` | str[] | y | The files actually opened |
| `citations` | `{sampled, of, resolved, refuted}` | y | Whole numbers ≥ 0. The spot-check, and what it found |
| `touches` | `{audited, outside_surface, new_areas[]}` | y | The touched-path audit |
| `diff_vs_stories` | `matches\|diverges\|n-a` | y | `n-a` outside Build, where there is no story set to diff against |
| `caveats` | str[] | n | What the reviewer's mandate stopped it checking. Defaults to `[]` |
| `recommend` | `{q, option, why, src}[]` | n | A recommendation per open question, for a decision card. Defaults to `[]`; never invented |
| H2 sections | `Read` · `Citations checked` · `Touches audited` · `Verdict` | y | In that order, each with **at least one list item** |

**Every list item ends with a valid §2.8 `[src: …]` token that resolves**, checked by the **same** tokenizer, the same
resolver and the same section rule `claim-sources` runs — never a second reader, which would drift, and the looser of the
two would win the argument at exactly the moment a gate is being signed. A checklist whose own claims are unsourced is
what §2.8 exists to refuse, and an evidence note is a claim about a claim.

**`unverified` refuses here**, unlike in a handoff. A citation nothing could check does not fail a stage (§2.8) but it is
exactly what stops an AUTO gate closing (§5, condition 5); an agent gate is strictly stronger than an auto gate, never a
cheaper one, so it cannot rest on a source nobody was able to verify.

**Validation** (each with its own message): front matter present, parseable and complete · the four sections present, in
order, each holding a list item · every list item sourced and resolving · `citations.sampled <= citations.of` and
`resolved + refuted <= sampled` · not `sampled: 0` while `of > 0` — "I checked none of them" is not a check ·
`verdict: sign` · `gate:` equal to the stage at the cursor.

**`tldrx gate template`** writes the blank form, filling only what a tool can COUNT or already knows — `version`,
`gate`, `role: agent`, `by` (the current actor, which becomes `gate.by` if the note is signed), `at`, `citations.of`,
`touches.audited`, and empty `caveats` / `recommend` — and leaving `verdict` and `diff_vs_stories` blank. It writes no
citation of its own (the literal string `[src: …]` appears once, inside the italic guidance under `## Read`, never as a
list item), and what it writes deliberately does **not** validate: a template that parsed clean out of the box would be a signature nobody had
to earn. It spends nothing, spawns nothing, approves nothing and moves no cursor.

## 3. CLI surface

Exit codes: `0` ok · `1` usage/schema error · `2` refused by a gate · `3` not found · `4` awaiting human · `5` agent failed.

| Command | Reads | Writes | Exit |
|---|---|---|---|
| `tldrx init [--stack <a,b>]` | cwd tree, git dirs, package/build files, `env.yml` | `workspace.yml` (incl. `mode: greenfield`), `map/**`, `conventions/**`, `experts/*/` (always a `product`, one `<lang>-stack` per detected **or declared** language), `facts.yml`, `.gitignore`, `CLAUDE.md` pointer | 0,1 |
| `tldrx doctor [--mcp] [--json]` | `env.yml`, `workspace.yml`, `.tldrx/stages/**`, `.claude/settings.json`, plus a shallow scan of `.tldrx/**` + `tldrx-work/*/{run,budget}.yml` for the deprecated `schema_version:` key, plus `git check-ignore` over four `[c]` state paths | `env.yml.result`, `cache/doctor.json` | 0,1 |
| `tldrx install --claude [--project\|--user] [--skill-only] [--no-hooks] [--no-statusline] [--force-statusline] [--uninstall] [--dry-run]` | `plugin/skills/tldrx/SKILL.md`, the target `.claude/settings.json` | `.claude/skills/tldrx/SKILL.md` (marked `<!-- tldrx-managed -->`), `.claude/settings.json` (the §4 hooks as `tldrx hook <name>` + `statusLine`), `settings.json.bak-tldrx-<ts>` | 0,1 |
| `tldrx status [--json]` | `.tldrx/init-questions.md`, `.tldrx/triage/*/{split.yml,inventory.json}` and the seed documents those name, `tldrx-work/*/run.yml` (incl. `triage.depends_on`), `.tldrx/experts/**`, every `stage.yml` | nothing (stdout) | 0,3 |
| `tldrx run new [--from <path>\|--seed <path> ...] [--scope <s>] [--budget <usd>] [--gates <a,b\|a:agent\|all\|none>] [--attended-by host]` | `workflows/<s>.yml`, `workspace.yml`, `facts.yml`, the `--from` source (§6) or the `--seed` documents (§6.1) | `tldrx-work/<run>/{run.yml,budget.yml,events.jsonl,01-what/*}` incl. the resolved `gates_policy`; `--seed` also writes `01-what/seed-index.md` and declares the documents as What inputs. **`--seed` is repeatable** (§6.2): every occurrence is collected, merged, deduped and re-sorted, and the §6.1 caps apply to the merged set; one occurrence behaves exactly as before. A seed over the threshold or over 10 files adds one **stderr** note naming `tldrx seed triage`. `--gates` LISTS THE HUMAN GATES (`all` = every stage human, `none` = every stage auto); an entry may be QUALIFIED as `<stage>:<policy>` (`plan:agent`) and a bare entry still means `human`, so every existing invocation means what it meant; an unknown stage or an unknown policy is a usage error and no run is created. `--attended-by host` freezes §2.2's `attended_by` into the run: the framework will not spawn on it. Any other value is a usage error and no run is created | 0,1 |
| `tldrx seed triage <path> [--out <dir>] [--json] [--threshold-tokens <n>]` | the `--seed` documents (§6.1 rules), `workspace.yml` (repos + `seed_triage.threshold_tokens`) | `<out>/inventory.md`, `<out>/inventory.json` (default `<out>` = `.tldrx/triage/<yymmdd>-<slug>/`) | 0,1,3 |
| `tldrx seed triage <path> --propose [--model <m>] [--effort <l>] [--max-usd <n>] [--prepare\|--commit] [--yolo]` | the same, plus `workflows/*.yml` for the legal scopes | `<out>/{inventory.md,inventory.json,split.yml,split.md}`, `<out>/.agent/propose/*`; **never** a run | 0,1,2,5 |
| `tldrx seed answer <split.yml> <Qid> "<text>"` | `split.yml`, `inventory.json` beside it, `workflows/*.yml` | `split.yml` (that question's `answer:`), and `split.md` when it exists | 0,1,3 |
| `tldrx seed apply <split.yml> [--dry-run]` | `split.yml`, `inventory.json` beside it, `workflows/*.yml` | one `tldrx-work/<run>/` per proposed run (via `run new`'s own path) each with a `triage:` block, and `split.yml` rewritten to `status: applied`. Questions with no `answer:` are listed on **stderr** as a warning — never a refusal | 0,1,3 |
| `tldrx run attend <host\|--none> [<run>]` | `run.yml` | `run.yml`'s `attended_by` (§2.2), `events.jsonl` (`run.attended`, carrying the new value and the old). Nothing else: no agent, no cost, no stage moved, no branch touched. `--none` REMOVES the key rather than blanking it — `null` is not a legal value. A direction is required and is never guessed (exit 1); setting what is already set is a silent no-op; a `done` or `cancelled` run is refused (exit 2) | 0,1,2,3 |
| `tldrx run status [<run>]` | `run.yml`, `events.jsonl` | nothing (stdout) | 0,3 |
| `tldrx next [<run>] [--dry-run] [--prepare\|--commit] [--review] [--fixlist <path>] [--parallel <n>] [--prompt-max-bytes <n>] [--max-reads <n>] [--commit --cost-usd <n>] [--tokens <n>]` | `run.yml`, `stage.yml`, `stage.md`, `expert.md`, declared inputs, `graphify-out/<repo>/graph.json` | stage outputs, `run.yml`, `events.jsonl`. `--cost-usd` is the in-session turn's DECLARED cost (§2.2); with none the task is `cost_usd: null, metered: false`. Both flags are `--commit`-only — headless reconciles a real `total_cost_usd` and a flag must not overwrite a measurement. On a run marked `attended_by: host` (§2.2) the headless mode — `--dry-run` included, which spawns nothing (issue #17) but describes a dispatch this run never makes — is refused with **exit 4** before the budget gate, before an input is read and before a prompt is assembled; the message names the exact half of the handshake the stage is waiting for | 0,2,3,4,5 |
| `tldrx cost [<run>] [--run <id>] [--all] [--json]` | every run's `events.jsonl` (+ `run.yml` for the title) | nothing (stdout) | 0,1,3 |
| `tldrx run estimate [<run>] [--json]` | everything `next --prepare` reads, plus every run's `events.jsonl` for cache-write / cache-read / output history | nothing (stdout) | 0,1,3 |
| `tldrx run gates set <stage>:<human\|auto\|agent> --note <text> [<run>]` | `run.yml` | `run.yml`'s §2.2 `gates_policy` and `events.jsonl` (`gate.policy_changed`, carrying actor, moment, note and old→new). The ONLY sanctioned way to move a frozen `gates_policy`; `run.yml` stays hand-edit-forbidden (§1). ONE `<stage>:<policy>` per invocation — a comma list is refused, and the entry must name its policy outright, since under `--gates` a bare stage means `human` and a signature must not rest on a default. An empty or missing `--note` is refused, as is a no-op (`human` → `human`). A run whose `run.yml` has no `gates_policy` at all gets the FULL map written, every stage explicit, with the one change applied. Gates already signed are untouched | 0,1,2,3 |
| `tldrx run auto [<run>] [--max-usd <n>] [--until <stage>] [--model <m>] [--effort <l>] [--parallel <n>] [--gate-agent] [--yolo]` | everything `next` reads, once per stage | everything `next` writes. Refused with **exit 1** on a run marked `attended_by: host`, before the event log is opened so nothing is written: this loop's whole job is calling `next` headless, and on such a run that is a refusal. `--gate-agent` is RENDERING ONLY (§5, "Decision cards"): when the loop stops for a person at exit 4 it prints a decision card in place of the ordinary stop block, and it never upgrades a stage's frozen `gates_policy` | 0,1,2,3,4,5 |
| `tldrx answer <Qid> <text> [--supersede] [--run <id>]` | `questions.md`, `facts.yml` | `questions.md`, `facts.yml`, `events.jsonl`. `--supersede` is the only writer of `superseded_by`: valid only on an **answered** question, it appends a fact carrying the new answer, sets the old fact's `superseded_by`, appends a superseding `[Answer …]:` line plus a footer to the block, and appends `fact.added` + `fact.superseded`. Without it an answered question is refused (3); with it an **open** one is refused (1) | 0,1,2,3 |
| `tldrx interview [--run <id>\|--init] [--yes-to-defaults]` | the cursor phase's `questions.md` (or `.tldrx/init-questions.md`), `run.yml`, `.tldrx/process.yml`, `workspace.yml`, `git remote get-url origin` | the same three files `answer` writes, one per answer recorded; with `--init`, also `.tldrx/process.yml` (§2.12) when a process answer settles `methodology` or `ticket_tool.kind` | 0,1,2,3 |
| `tldrx approve [--run <id>] [--note] [--as-agent] [--evidence <path>]` | `run.yml`, stage outputs, stage checks; with `--as-agent` also `.agent/<stage>/evidence.md` (§2.17) | `run.yml` gate, `events.jsonl`; with `--as-agent` also `<phase>/gate-evidence/<stage>.md` and `gate.evidence`. `--as-agent` is refused (1) unless the stage's policy is `agent`; `--evidence` without `--as-agent` is refused (1) — a note nobody signs with is not evidence for anything; a broken note is 2, a note whose verdict is not `sign` is 4, and nothing is signed in either case | 0,1,2,3,4 |
| `tldrx gate template [--run <id>] [--force]` | `run.yml`, the cursor stage's declared outputs, `03-plan/stories/<id>.md` or `04-build/implicit-plan.yml` | `.agent/<stage>/evidence.md` (§2.17). Nothing else: no gate, no cursor, no event, no cost. An existing note is left alone (exit 2) unless `--force` | 0,1,2,3 |
| `tldrx reject [--run <id>] --note <text> [--stage <phase>/<stage>]` | `run.yml` | `run.yml` gate, `events.jsonl`, stage status ⇒ `ready`. With `--stage` it REVOKES an approval already given (§5): `gate.revoked`, the cursor moves back, later stages that had run are marked `stale: true`, nothing is deleted. `--stage` may target a FINISHED run | 0,2,3 |
| `tldrx story reopen <id> [--run <id>] --note <text> [--for-fix]` | `03-plan/waves.yml` + `03-plan/stories/<id>.md` (or `04-build/implicit-plan.yml`), `events.jsonl` | that story file's `status:` ⇒ `todo`, `events.jsonl` (`story.reopened`). Nothing else: no agent, no cost, no stage moved, no worktree or branch touched, and no line of the story but `status:`. Refuses (2) an unknown story id, a `done` story (that is `reject --stage`, or `--for-fix`), a `todo` story, and a missing `--note`. With `--for-fix` it opens a FIX ROUND on a `done` story instead (`reason: fix`, no attempt consumed, same DoD + reviewer), refusing (2) a story that is NOT done, a missing `--note`, and a story that already has a fix round open | 0,1,2,3 |
| `tldrx questions lint [--run <id>] [--fix] [--area <a>]` | every `<phase>/questions.md` in the run | nothing, or those files rewritten to the §2.7 grammar with `--fix` (no wording changed) | 0,2,3 |
| `tldrx questions cards [<run>] [--run <id>]` | every `<phase>/questions.md` in the run | **nothing** (stdout cards). One printable decision card per OPEN question: two lines of context, the block's own `Why asked:` note verbatim with its `[src: …]` — flagged when it cites nothing, and named as absent when there is no note — and the block's lettered options, or a `NEEDS OPTIONS` marker when it has none, since manufacturing them would answer the question in the act of asking it. Answers still flow through `tldrx answer`, whose command every card prints. No open question is a sentence and an exit 0 | 0,1,3 |
| `tldrx budget show [<run>] [--run <id>] [--json]` | `run.yml`, `budget.yml` | nothing (stdout) | 0,1,2,3 |
| `tldrx budget raise <phase> <usd> [--run <id>] [--take-from <phase>] [--note <text>]` | `run.yml`, `budget.yml` | `budget.yml` ceilings, `run.yml` ceiling mirror, `events.jsonl` (`budget.raised`, with before/after/actor/note) | 0,1,2,3 |
| `tldrx map --refresh` | `workspace.yml`, repos, `graphify-out/` | `map/**`, `graphify-out/`, `events.jsonl` | 0,1 |
| `tldrx map --check` | `map/**` citations, filesystem | `cache/map-drift.json` (stdout report) | 0,1 |
| `tldrx expert list` | `experts/*/competencies.yml`, `experts/*/knowledge/*.md` | nothing (stdout star chart; stderr warnings) | 0 |
| `tldrx expert create <name>` | `workspace.yml`, `map/**` | `experts/<name>/{expert.md,competencies.yml}` | 0,1 |
| `tldrx expert train <name> --area <a> [--mode light\|full] [--max-usd <n>] [--model <m>] [--prepare\|--commit] [--print-prompt]` | `expert.md`, `competencies.yml`, `map/<repo>/domains.md`, `graphify-out/<repo>/graph.json`, repo code, `tldrx-work/**/{handoff,retro}.md`, `facts.yml` | `knowledge/<area>.md` (+ `knowledge/from-runs-<area>.md` in full mode), `competencies.yml`, `training.jsonl` (§2.6.1) | 0,1,2,3,5 |
| `tldrx expert recompute [<name>] [--json]` | `experts/*/competencies.yml` | `competencies.yml` (`areas[].level` only) | 0,1,3 |
| `tldrx dashboard [--static]` | `tldrx-work/**`, `.tldrx/**` (watch) | nothing, or `dist/` with `--static` | 0,1 |
| `tldrx watch list [--run <id>]` | `05-watch/watchers/*.md`, `workspace.yml` | nothing (stdout table) | 0,1,2,3 |
| `tldrx watch check <feature> [--run <id>]` | one card, the files it cites | nothing (stdout report) | 0,1,2,3 |
| `tldrx watch arm [--interval <s>] [--timeout <s>] [--branch <b>] [--repo <r>] [--run <id>]` | `run.yml` (`build.epic_branch`), `workspace.yml`, `gh pr view <branch> --json state,mergedAt` per repo, then everything `watch check` reads | **nothing** (stdout: the `watch check` checklist, once every PR for the branch has merged). A BOUNDED FOREGROUND poller, not a daemon: three independent bounds — the `--timeout` deadline (default 3600s, max 86400), the `--interval` floor (default 60s; under 10 REFUSED rather than clamped) and a poll cap that holds if the clock does not move. It never pushes, opens or merges anything, and never offers `--execute`. No epic branch, no PR for the branch, and a PR CLOSED without merging are refusals (2); an expired window is 4, with the command that re-arms it | 0,1,2,3,4 |
| `tldrx tickets sync [--run <id>] [--apply] [--provider github\|jira]` | `process.yml`, `run.yml`, `03-plan/{epics,stories}/*.md` | **Nothing without `--apply`** — preview is the default, because this is the one verb that reaches a third party. With it: `external:` + `external_status:` in those files, `events.jsonl` (`ticket.synced`), the remote issues. `--provider` picks between CONFIGURED providers and cannot switch on a workspace set to `kind: none` | 0,1,2,3 |
| `tldrx tickets status [--run <id>]` | `process.yml` **first**, then the same files | nothing (stdout table) | 0,1,2,3 |
| `tldrx replay [<run>]` | `events.jsonl`, handoffs | nothing (stdout narrative) | 0,1,2,3 |
| `tldrx retro [<run>] [--apply]` | `run.yml`, `events.jsonl`, handoffs, the Build executor's `## Build feedback` section | `retro.md`, `stages/proposed/**`, `practices.md` proposals | 0,1,2,3 |
| `tldrx retro --all` | EVERY `tldrx-work/<run>/`: `04-build/log/*.md` (a `changes` verdict and its `## Findings`), `04-build/fixlist/*.md` (dispositions; a `refuted` finding is read and dropped), `retro.md` (`## Build feedback`, `## Practice proposals`), `events.jsonl` (`story.reopened` reasons) | **Nothing.** Zero new state: no `retro.md`, no `practices.md`, no cache. stdout is the trends table — finding class × count × how many runs × one example with its `[src: …]`. Classification is ordered keyword rules, no model. A run missing any source contributes what it has; an empty workspace is exit `0`. Refused (1) with a `<run>` id or with `--apply` — each asks for the opposite of `--all` | 0,1 |
| `tldrx drive <--attended\|--unattended>` | nothing — no workspace, no run, no file | nothing. stdout is the session mandate for the driver of a run: a preflight that establishes the run's attendedness, gate policy and `budget.yml` before anything else and REFUSES to start where it cannot, naming the command that failed; then the three-role protocol, evidence discipline, parking, review calibration by stakes and budget honesty, plus the preflight, gate and prepare/commit sections that differ between the two modes — `--unattended` may move a delegated stage to `agent` over a cited note, `--attended` may move nothing. Versioned with the package. A mode is required and never guessed | 0,1 |
| `tldrx hook <name>` | stdin (the hook payload) | whatever the hook writes — stdout, stderr and the exit code are the script's, unchanged | the script's |
| `tldrx statusline` | stdin (the statusLine payload) | one line on stdout | 0 |

`tldrx dashboard` (live) binds loopback AND checks the `Host` header: a request whose host is not `127.0.0.1`, `localhost`, `::1` or the host it was explicitly bound to is answered `403` before a route is chosen. Loopback alone does not keep a browser out — a page can point a name it owns at `127.0.0.1` (DNS rebinding) and the socket still looks local. The port is not checked, so a tunnel or a container port map still works.

### 3.1 Several runs open at once

`tldrx run new` allows a second open run on purpose — each carries its own
`budget.yml`, `events.jsonl` and epic branch, and parking one piece of work to
start another is a normal week. What is not allowed any more is **guessing which
one a command meant**. A run is "open" when its status is neither `done` nor
`cancelled`; a `failed` run is open, because it is exactly the one about to be
retried or rejected.

Resolution, for every command in the table above:

| Situation | What happens |
|---|---|
| an explicit `<run>` / `--run <id>` | that run, always — never ambiguous |
| exactly one open run, no id | that run — unchanged from before |
| no open run, no id | `no non-terminal run in tldrx-work/`, exit `3` — unchanged |
| several open runs, no id | **refused, exit `2`**, every candidate named |

The refusal is one shape, on stderr, for every command:

```
tldrx approve: 2 runs are open — pass one:
  260829-beta   awaiting_gate  02-how/contracts  gate
  260829-alpha  pending        01-what/what      ready
```

`  <id>  <status>  <phase/stage cursor>  <waiting kind>`, newest first, columns
padded to the widest value. Nothing is read, written or advanced on that path —
in particular `tldrx next` refuses **before** it spawns anything.

Two commands are deliberately exempt:

- **`tldrx run status`** with no id and several open prints a table of them all
  and exits `0`. It is the screen you read to find the id every other command
  wants, so refusing there would be a locked door with the key behind it.
- **`tldrx dashboard`** already renders every run in the workspace, so ambiguity
  is not a question it can be asked.

`tldrx run new` still creates the run and adds one stderr line:

```
note: 2 other run(s) open — pass a run id to next/answer/approve/… from now on
```

#### `run status` output shapes

With **one** open run (or an explicit id), both the table and `--json` are
exactly what they have always been — `--json` is one top-level `RunStatusView`
object with the keys `run, title, scope, workflow, repos, status, cursor,
phases, budget, attempts, build, waiting`.

With **several** open and no id:

```
2 runs are open — `tldrx run status <id>` for one of them

RUN           STATUS         CURSOR            WAITING  SPENT/CEILING
260829-beta   awaiting_gate  02-how/contracts  gate     $3.75 / $25.00
260829-alpha  pending        01-what/what      ready    $0.00 / $25.00

Every command that changes a run needs one of these ids: `tldrx next <id>`, …
```

and `--json` wraps the same per-run objects, unchanged, in one key:

```json
{ "runs": [ { "run": "260829-beta", "…": "…" }, { "run": "260829-alpha", "…": "…" } ] }
```

A consumer that reads a single run's JSON (`waiting.kind`, `waiting.questions`)
therefore keeps working untouched as long as it passes a run id, and can detect
the multi-run answer by the absence of a top-level `run`.

### 3.2 `tldrx status` — what is pending in this workspace

`run status` answers "where is this run". Nothing answered "what is waiting on me
here", so a session that opened with no run could only ask the human what they
wanted to do — while the answer sat on disk in four places nobody read as one
list. `tldrx status` reads those four, in the order they block each other:

| # | kind | source | the command it names |
|---|---|---|---|
| 1 | `init-questions` | open blocks in `.tldrx/init-questions.md` | `tldrx interview --init` |
| 2 | `seed-split` | every `.tldrx/triage/*/split.yml` at `status: proposed` — its runs, its unanswered `questions`, the seed documents whose own `Status:` line still says `proposed`, and any seed file named `DECISIONS*.md`; **and every one at `status: applying`**, which is an apply that stopped partway: it names the runs it created, the ones it did not, and how to reset | `tldrx seed apply <path> --dry-run` |
| 3 | `run` | `RunStore.findOpen`, plus one item for any run folder that does not validate | `tldrx next <id>` / `tldrx answer <Qid> "…" --run <id>` / `tldrx approve --run <id>` |
| 4 | `expert` | experts `stageCoverage` says a stage will load, with zero evidence in every area | `tldrx expert train <name> --area <a> --mode <light\|full> --print-prompt` |
| 5 | `none` | nothing pending | — |

Each item renders as `[n] <one sentence> → <exact command>` with indented details,
and `--json` returns `{root, pending, items[]}` where every item is
`{kind, summary, command, details}` — the shape the `/tldrx` skill walks.

Four rules the table cannot carry:

- **Runs are dependency-aware.** `triage.depends_on` (§2.2) names sibling SLUGS;
  each is matched to the newest run whose id ends `-<slug>`. A run whose dependency
  is not `done` shows `blocked by <slug>` and is offered NO command, however loudly
  its cursor says `ready`. The first run that is unblocked and actionable is marked
  `← next`, and only that one is offered `tldrx run auto`.
- **An ADR's status is read from the DOCUMENT**, not from `inventory.json`'s cached
  `adrStatus`. The inventory supplies the document list — it is what the proposal
  was made from — but a status cached at triage time would keep reporting a
  decision as open for exactly as long as the decision took to make. A `Status:`
  line is recognised with or without a leading list marker (`- Status: proposed`).
- **A role expert with nothing to mine gets no command.** Role experts train in
  `--mode full` from `tldrx-work/**/{handoff,retro}.md` (§2.6); with none on disk
  the item says so and offers nothing, because a command the tool would refuse is
  worse than an honest "not yet". Expert items are capped at five plus one
  overflow row naming the rest.
- **It is a report, so it exits 0 whatever it finds.** "Nothing pending" is a
  complete answer. Exit `3` means there is no `.tldrx/` at all. Nothing is written,
  nothing is spawned, no cursor moves. `tldrx next` with no run open prints this
  report before its own exit-3 line, with the exit code unchanged.


## 4. Hooks (Claude Code)

Shipped in the plugin's `hooks/hooks.json` (`{"hooks": {"<Event>": [{"matcher": "Write|Edit", "hooks": [...]}]}}`,
scripts referenced via `${CLAUDE_PLUGIN_ROOT}`). **Verified payloads** (code.claude.com/docs/en/hooks.md, 2026-08-28):
PreToolUse stdin = `session_id, cwd, hook_event_name, tool_name, tool_input, tool_use_id` — for Write `tool_input.content`,
for Edit `tool_input.old_string/new_string`, path in `tool_input.file_path`; PostToolUse adds `tool_result`;
Stop adds `last_assistant_message`. **Only PreToolUse can block**, by printing
`{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "…"}}`
(exit 0). PostToolUse can only feed back (`additionalContext` / `systemMessage`). Consequence: every gating hook below
is PreToolUse and validates the **would-be** file (Write: `content`; Edit: `old_string→new_string` applied to the file on
disk). All but `DoD-gate` finish in <50 ms.

**Two hooks fail CLOSED, not one (2026-08-29).** `DoD-gate` always did. `budget-gate` now does too, once it has
identified the command as a spender inside a tldrx workspace: an unreadable `run.yml` or `budget.yml` DENIES and names
the file. It used to allow on all of those, which is fail-open on the one hook whose entire job is refusing to spend —
"cannot read the budget" and "the budget is fine" are not the same answer. It still allows silently when the command
spends nothing or there is no `.tldrx/` at all: those are correct negatives, not failures.

**Two ways the same six scripts get wired.** The plugin spawns them by path (`bun ${CLAUDE_PLUGIN_ROOT}/../src/hooks/<name>.ts`), because it has to work for someone who cloned the repo and installed nothing. A `settings.json` written by `tldrx install --claude` (§3) cannot use that variable and must not hard-code an absolute path into a committed file, so it goes through the CLI: `tldrx hook <name>` and `tldrx statusline`, which resolve `dist/hooks/<name>.js` or `src/hooks/<name>.ts` and pass stdin, stdout, stderr and the exit code through unchanged. Same scripts, same matchers, same decisions.

| Hook | Event | Trigger | Decision logic | Effect |
|---|---|---|---|---|
| `claim-sources` | PreToolUse (`Write\|Edit`) | `tool_input.file_path` matches `tldrx-work/**/*.md` | Compute the would-be content; parse the four handoff sections; each must hold at least one list item, and each list item must end with a valid `src` token (§2.8); `file` sources must resolve against the workspace root, the run dir, or a named repo | Denies (JSON) listing offending line numbers; a PostToolUse twin re-checks and feeds back only |
| `no-re-ask` | PreToolUse (`Write\|Edit`) | `tool_input.file_path` matches `tldrx-work/**/questions.md` | Tokenise each new question heading + `area`; compare against LIVE `facts.yml` rows (neither retired nor superseded); Jaccard ≥ 0.6 on ≥4-char tokens ⇒ hit `[assumption]` | Denies the write, names the matching fact |
| `answer-capture` | PostToolUse + FileChanged | `tldrx-work/**/questions.md` | Find blocks with `status: open` and a non-empty `[Answer]:` capture | Never blocks; writes footer + `facts.yml` + `question.answered`; echoes one line to stdout as context |
| `DoD-gate` | PreToolUse (`Write\|Edit`) | would-be content of `tldrx-work/**/stories/*.md` sets `status: done` | Re-run every command in the story's fenced ```dod block, in its repo, with `stage.yml timeout_s`; all must exit 0. **Only a command byte-equal to a `workspace.yml` command runs, argv-split with no shell** | Denies if any command fails, is not on the allowlist, needs a shell, or the block is missing (this hook is not <50 ms by design) |
| `budget-gate` | PreToolUse (`Bash`) | `tool_input.command` matching `^(claude -p\|tldrx next\|tldrx run auto\|tldrx expert train\|tldrx seed triage)` | `spent + estimate > phase ceiling` (or run ceiling) and `on_exceed: block`. Estimate: the **remaining work** for `next` (below); `--max-usd` else the same figure for `run auto`; $2.00 / $1.00 defaults for `train` / `triage` | Denies the spawn; appends `budget.blocked` |
| `session-start-status` | SessionStart | always | Read the newest non-terminal `run.yml`; when several are open, list them all first. Then build the `tldrx status` report (§3) | Never blocks; injects a 3-line "where we are" via `additionalContext`, then up to 3 lines of the pending report — a headline plus as many items as fit. Nothing pending AND no run ⇒ no output at all |
| `statusline` | statusLine | always | Render from the statusLine JSON + `run.yml` | Output only |

Exact block messages (`permissionDecisionReason`, verbatim):

```
[tldrx] claim-sources: 3 unsourced bullet(s) in tldrx-work/260828-leaderboard/02-how/handoff.md — L14, L22, L31.
Every bullet under Findings/Decisions/Unknowns/Evidence ledger must end with [src: <repo:path:line> | https://… |
Q<n> | F<n> | $ <cmd> → exit <n> | graph:<node> | absent:<path>]. Add the source or delete the claim.
[tldrx] no-re-ask: Q4 "Where does leaderboard state live?" is already answered by F019 (alan, 2026-08-14, run
260814-envs): "Backend deploys run via deploy.yml…". Cite it as [src: F019] instead of asking.
If the fact is stale, set its `retired: {at, by, reason}` in .tldrx/memory/facts.yml first, then re-write the question.
[tldrx] DoD-gate: story S3 cannot be marked done — `npm run test` in repo lab exited 1 (expected 0).
Command output tail: 4 failing tests in src/features/leaderboard/__tests__/rank.test.ts.
Fix the code or the story's dod block; done means proven, not asserted.
[tldrx] budget-gate: refusing to start stage "contracts" — phase 02-how has $0.61 left of $7.00 and the stage
estimate is $3.00. Run `tldrx budget raise 02-how 2.39 --run 260828-leaderboard` (add `--take-from <phase>` to move
the money instead of adding it), lower budget_usd in .tldrx/stages/contracts/stage.yml, or set on_exceed: warn.
[tldrx] claim-sources: 1 checked section(s) in tldrx-work/260828-leaderboard/02-how/handoff.md contain no list
items — "Unknowns" (L18). Findings/Decisions/Unknowns/Evidence ledger must each hold at least one sourced item;
prose alone is not a claim anything can check. If there is genuinely nothing, say so as an item:
`- none [src: absent:<what you looked at>]`.
```

**The estimate is the REMAINING work, not the stage's price (2026-08-31).** For a Build stage with a plan on disk,
the figure both this hook and `tldrx next`'s own brake compare against is `Σ` over the stories that have not settled of
the caps the executor would actually hand out — the `03-plan/budget.yml` price run through the same scale/share
arithmetic, the developer and reviewer shares, `REVIEWER_FLOOR_USD`, and the attempts each story has left. Everywhere
else — outside Build, and for a Build stage with no plan — it is `stage.budget_usd`, unchanged.

Measured on `260830-tenancy-identity-customers`: four of seven stories done, one mid-attempt-2, two blocked. The stage
was priced at **$18.00**; the brake demanded all $18.00 on every cycle and refused twice, and the host raised the
ceiling twice for money nothing was going to spend. The remaining work was **$2.50**.

Four rules, each load-bearing: a `blocked` story costs $0 (only `tldrx story reopen` — a human decision — re-queues it,
and doing so raises the figure again, which the message says); a story at `review` has already paid the developer turn
under review; under `economy: host-tokens` the developer turns are $0 and the reviewer floors are not; and the result is
**capped at `stage.budget_usd`**, so this is strictly a NARROWING and can never refuse more often than it used to.
`budget.blocked` carries `estimate_basis: plan|static` and, on the plan basis, `static_estimate_usd`, `stories_done` and
`stories_total`. The refusal prints the sum term by term — `remaining work: S4 dev $1.50 + reviewer $1.00 = $2.50` — and
`tldrx budget show`'s `est.` column is computed by the same function, so the two cannot disagree.

**Both economies, and who is driving (issue #22).** The hook reads its run through the tolerant reader
(`hooks/lib/runFile.ts`), and that reader skipped `tasks[]` and `attended_by:` entirely — so a run whose turns a host
session paid for reported `$0.00` metered and nothing else, and neither the hook nor the status line could tell "nobody
spent anything" from "I did not look". The view now carries `attended_by`, and each task's `cost_usd` / `metered` /
`tokens`, from which `runSpend` derives the metered dollars, the declared host tokens and the count of turns nobody
costed.

What that changes is what the gate SAYS, never what it decides. A dollar ceiling still governs dollars only, the two
currencies are still never converted, and a plain metered run's refusal is byte-identical to what it always was. When
there IS a second currency or an uncosted turn, one line is appended — *"spend so far: $0.00 metered + 12000 host tokens
+ 1 unmetered turn (attended_by: host …). The dollar figure is METERED spend only"* — and `budget.blocked` records
`economy`, `attended_by`, `metered_usd`, `host_tokens` and `unmetered_tasks` beside the dollar figures.

**The policy, decided 2026-09-01 (issue #22).** Three answers, and they are the only things here that move a verdict:

  1. **An `attended_by: host` run is never DENIED on metered dollars.** `tldrx next` on such a run spawns nothing, so
     the dollar estimate a refusal is measured against is spend that provably will not happen. The gate says every
     number it would have refused with, plus both economies, and allows. The event it writes is `budget.warned` —
     nothing was blocked, and a ledger that records a block that did not happen is the failure #22 was filed about.
  2. **A `host-tokens` ceiling is soft-enforced.** Under that economy the ceiling NUMBER is a host-session token
     allowance, so declared `tokens:` against it is the one comparison here whose two sides share a unit. Crossing it
     WARNS. It stops only under the explicit opt-in `on_host_tokens_exceed: block` in `budget.yml` — an enum beside
     `on_exceed`, defaulting to `warn`, so every file written before the key existed keeps the behaviour it had. A
     token ceiling never denies an attended run: (1) beats (2).
  3. **`remainingWork` zeroes the developer share on an attended run**, exactly as `economy: host-tokens` already did,
     because it is the same fact — the host session pays for those turns. Reviewer floors are untouched in both cases:
     outside attended mode `reviewAndSettle` still spawns a metered reviewer, and over-estimating is the safe direction.

The budget-gate message names the **command** rather than the field it edits. Measured, 2026-08-29 pilot: told to
"raise phases[02-how].ceiling_usd", the operator hand-edited it to a number that did not cover the estimate, and the
retry was refused a second time. `tldrx budget raise` computes the shortfall and rounds it **up** to the cent.

Statusline renderer uses `model.display_name`, `cost.total_cost_usd`, `context_window.used_percentage`,
`worktree.branch`, `session_id` from the statusLine JSON (Appendix A) plus `run`, `cursor`, phase progress and
`budget.ceiling_usd` from `run.yml`, and prints:
`[tldrx] 260828-leaderboard · 02-HOW [▓▓░░░] 2/5 > contracts — architect | Sonnet ctx:16% $3.75/$25`
Up to three markers sit between the stage count and the `>`, in this order and only when each is true: **`att`** (the
run is `attended_by: host`), `auto:N` and `stale:N`.

With several runs open (§3.1) the status line still shows ONE run — the newest open one — with a marker for the
others: `[tldrx] 260828-leaderboard (+1 open) · 02-HOW …`. No hook refuses on ambiguity. `claim-sources`,
`no-re-ask` and `DoD-gate` resolve the run from `tool_input.file_path` and are unaffected by construction;
`budget-gate` judges a Bash command with no file to go on, so it keeps its order — `--run <id>` in the command,
then the run the `cwd` sits inside, then the newest open run — because a gate that stopped gating the moment a
second run existed would be worse than one that picks.

## 5. Facilitator algorithm (`tldrx next`)

```
next(run, dry_run):
  acquire(tldrx-work/<run>/.lock)                     else exit 2 "another next is running"
  r = load_validate(run.yml); b = load_validate(budget.yml)
  if r.status in {done, cancelled}: exit 0
  st = resolve(r.cursor)                           # the stage the cursor points at
  if st.status == awaiting_gate: exit 4 "gate pending: tldrx approve"
  if st.status == awaiting_answer: exit 4 if unanswered(questions.md) else st.status = ready
  sy = load_validate(.tldrx/stages/<st.id>/stage.yml)
  if sy.skip_if holds: append(stage.skipped); advance_cursor(); return next(run, dry_run)
  if r.attended_by == host and mode == headless: exit 4   # §2.2; FIRST, before every line below
  if b.economy(st.phase) == host-tokens and mode == headless: exit 2   # §2.11: that ceiling is not dollars
  for p in sy.preconditions:                       # §2.3; skipped entirely on --commit
     res = sh(argv(p.command), cwd=repo(p.repo), timeout=p.timeout_s or 60)
                                                   # allowlisted verbatim, never a shell;
                                                   # its OWN clock, never sy.timeout_s (issue #20)
     append(check.passed|check.failed, kind=precondition)
     if res.exit != p.expect_exit: exit 2          # REFUSED: nothing written, nothing spawned, st.status unchanged
  if b.economy(st.phase) == host-tokens: append(budget.warned once); skip the money gate
  elif b.phase(st).remaining < sy.budget_usd and b.on_exceed == block: append(budget.blocked); exit 2
  if any(!exists(i) for i in sy.inputs.required): exit 1
  inputs = sy.inputs.required + present(sy.inputs.optional)          # ONLY these files
  prompt = render(stage.md, {run, repos, inputs, facts: grep(facts.yml, sy.area/r.repos), conventions,
           budget_usd}) + concat(expert_block(e) for e in select_experts(sy, r))
           + dispatch_notes(.agent/<st.id>/dispatch-notes.md, +/<story>/ on build)   # §5 prompt order
  if dry_run: print(bundle, prompt bytes, declared outputs, the claude argv); exit 0
                                                   # SPAWNS NOTHING, WRITES NOTHING (issue #17)
  st.status = running; write(run.yml); append(stage.started)
  for task in tasks_of(sy):                        # 1 per output group; parallel iff independent
     append(agent.spawned)
     res = sh(claude -p --output-format json --model <sy.model> [--worktree]
              --max-budget-usd <min(task_share, b.per_agent_max_usd)> <<< prompt + task)
     record(task, res.total_cost_usd, res.session_id, res.usage); append(agent.result, cost)
     if res.exit != 0 or res.is_error: goto FAIL
  for out in sy.outputs: if !exists(out.path) or !has_sections(out): goto FAIL  # re-read from disk;
                                                                                # a <token> path matches ≥1 file (§2.3)
  for c in sy.checks: run(c); append(check.passed|check.failed); if failed: goto FAIL
  st.cost_usd = Σ tasks; roll_up(b); st.status = done
  if sy.gate.type == approve: st.status = awaiting_gate; append(gate.requested); write; exit 4
  advance_cursor(); write(run.yml); append(stage.done); exit 0
FAIL: st.status = failed; st.error = first_error; write(run.yml); append(stage.failed); exit 5
```

**Expert composition (§2.3, §2.6).** `select_experts` is the three-rule selection in §2.3 — `experts:`, then
`stack_experts`, then a domain match — deduped, in that order. Each selected expert contributes ONE block, and the
parts of that block are in this exact order:

```
---
<!-- expert: <name> -->
<expert.md, verbatim, front matter included>

### Competencies
<one star-chart line per area: `<area>  ★★★☆☆ 3  (17 evidence, newest 2026-08-20)`>

### Trained knowledge
<the sentence that says the `[src: …]` tokens below are reusable as evidence>

<!-- knowledge: .tldrx/experts/<name>/knowledge/<area>.md · trained <ts> -->
<that file's BODY, front matter stripped>
```

**Prompt order — most stable first.** The pieces are concatenated in exactly this order:

```
<stage.md, substituted, with `## Inputs`, `## Dispatch notes` and `## Previous attempt` CUT OUT>
<expert block 1> … <expert block N>
## Inputs
<the declared inputs' content>
## Dispatch notes
<the host's own context for this cycle — omitted when there is none>
## Previous attempt
<the retry note, and the refused outputs>
```

This is a COST decision, not a layout one. A prompt cache keys on the longest PREFIX two calls share; a cache write
is billed at 1.25x an input token and a cache read at 0.1x. The experts used to be emitted LAST, behind the
declared inputs — so the largest and most stable section of the prompt sat behind the section that changes at every
stage, and paid the write price every time. Measured 2026-08-29 on `~/aparece-v2`: 159,575 B, of which 52% was expert
bodies and knowledge and 45% declared inputs, in that order.

**Measured 2026-08-29, two real `claude` 2.1.251 calls, back to back, same 40,715-byte prompt, `--model haiku`,
separate processes and separate sessions:**

| Call | `cache_creation_input_tokens` | `cache_read_input_tokens` | `total_cost_usd` |
|---|---|---|---|
| 1 | 37,059 | 0 | $0.074982 |
| 2 | 0 | 37,059 | $0.004550 |

So `claude -p` caches **across processes**, not only within a session, and the second call cost **16.5x less** than
the first. That is what makes the order worth changing: `run auto`, a retry, and every later stage of the same run
re-send a prefix that is now read rather than written. `[assumption]` — the cache's lifetime is not measured here,
only that a second call moments later hit it.

Both counters are recorded on `agent.result` beside `input_tokens` and `output_tokens`, so the claim above stays a
measurement rather than an argument. Note the ratio while reading them: 40,715 prompt bytes billed as 37,059 cached
tokens, because the CLI's own system prompt, tool definitions and `CLAUDE.md` are in the cached prefix too. The
`~3.6 bytes/token` figure the context ledger prints applies to the tldrx prompt ALONE and under-states the billed
input; it is an `[assumption]` for sizing, never for billing.

**One budget, inputs first.** Two independent ceilings are not a ceiling. The seed documents used to share 64 KB
and EACH loaded expert had its own 64 KB of trained knowledge, so they never competed: on `~/aparece-v2` the seed
budget dropped `ADR-D013-DELIVERY-ZONE-GEOMETRY.md` (5,863 B) whole — the sixth of the six decisions the run existed
to settle — while 70,923 B of unrequested expert knowledge went in untouched. There is now one allocation, in
priority order:

1. the **declared inputs** are filled first, in declaration order (required, then present optional, then the run's
   seed), out of `inputs_max_bytes` (§2.3, default 98304). `seed-index.md` is exempt.
2. the **experts** then share `knowledge_max_bytes` (§2.3, default 49152) between them, split by rank and never per
   expert, with whatever one does not spend carried forward to the next.

A declared input that still does not fit is NAMED — with its size and the key that raises the budget — on stdout, in
`pending.json`, and on the page itself, because "some documents were truncated" is a sentence nobody can act on.

**And the preamble says so.** `## Inputs` opens with "These files are the ONLY ones you may read … there is nothing to
open and nothing else to find" only when every declared input actually reached the page; when the budget dropped one it
opens instead with `Inlined below: <n> of <m> declared inputs`, tells the sub-agent to READ the rest at the paths listed
there, and names them — a preamble that contradicts the blocks under it is believed over them. In the Build phase a
touched path is additionally checked against the story branch (`git cat-file -e <branch>:<path>`): one that exists in the
repo but is not committed there is flagged `NOT in this worktree — its content is only what the handoff quotes` with a
matching stderr warning at `--prepare`, and the 64 KB touched-file budget is spent in priority order, the paths the
story's `goal`, acceptance criteria, test plan or title NAME going in before the ones something merely cited.

**The dispatch-notes slot.** `.agent/<stage>/dispatch-notes.md` — and for a Build story
`.agent/<stage>/<story>/dispatch-notes.md` — is the one place a HOST may add context to a prompt the framework
generated. It is rendered under `## Dispatch notes`, between `## Inputs` and `## Previous attempt`, and omitted
entirely when the file does not exist: an absent file leaves the prompt byte-identical. The two files feed **one**
slot, capped at **8 KB** shared between them and spent stage-file-first, with any overflow named in the prompt, on
stdout and in `pending.json` (`dispatch_notes: {bytes, truncated, max_bytes, sources[]}`); the rendered section's
bytes are charged to the context ledger and count against `prompt_max_bytes` like everything else.

It is **context, never configuration**: the framework does not parse it, does not substitute `{{placeholders}}` in
it, does not require `[src: …]` tokens on it, and it may not change a declared input, an output, a check or a cap.
It survives `--discard-pending` — the flag bins `pending.json`, `result.json` and `result.raw.json`, and the notes
are an INPUT to the rendering that is about to be redone rather than an output of the one being binned. It lives in
`.agent/`, which is gitignored (§1), because it is **per-cycle** scratch: a caveat that must outlive the cycle is a
fact, and `.tldrx/memory/facts.yml` is the durable channel that already reaches every prompt with attribution
behind it.

**The context ledger.** `--prepare` and `--dry-run` print bytes per section — stage (and its `## Questions`), each
declared input, each expert's body and knowledge, the dispatch notes, the previous attempt — and `pending.json` carries
the same numbers under `context:` (the dispatch-notes row is `dispatch_notes_bytes`, and reads `0 B` when the file is
absent). `prompt_max_bytes` (§2.3, default 163840) is a **refusal**: over it `next` exits `2` before a
sub-agent is spawned, names the biggest sections, and prints the key or command that shrinks each one — the same
shape as the §2.11 money gate. The model's context window is only ever a **stderr warning** at 80%, never a refusal,
because both the window and the bytes-per-token ratio are `[assumption]` (`src/core/budget/modelPrices.ts`) and
refusing on two stacked assumptions blocks work the framework could have done.

**The read cap.** `--max-budget-usd` STOPS a sub-agent after the turn it is already in (measured: $5.15 against a
$1.50 ceiling); `--effort` changes what a turn costs but not how many there are. Neither bounds EXPLORATION, and the
sub-agent holds `Read`, `Glob` and `Grep`. `max_reads` (§2.3) does: completed `Read`/`Glob`/`Grep` calls are counted
off the stream that is already arriving — no second model call, no extra tokens — and at the ceiling the process tree
is killed. Counting completions is what makes the stop land after the current tool rather than inside one. The
attempt records `stopped_by: max_reads` in `run.yml` (written ONLY when a cap bit, so an ordinary run.yml is
unchanged), `agent.result` carries `reads`/`max_reads`/`stopped_by`, and the live view shows `reads 37/120`.

**Attempt reuse.** Attempt 2 after a rejection receives the declared outputs that exist on disk, inlined under
`### Previous attempt — edit, do not restart`, capped at 32 KB shared across them, with anything past the cap named.
It used to receive the error and the note and nothing else, so a stage rejected over one missing section paid
full price to rewrite four documents from a blank page.

**Order and budget.** Knowledge files come most-recently-trained first, by each file's own `trained_at:` front matter
— never an mtime, because a `git clone` rewrites every mtime in the tree and an order that changes when you clone the
repo is not an order; files with no `trained_at` sort last by name, so the sequence is total. The running total is
capped at `knowledge_max_bytes` **in total across every loaded expert** (§2.3, default 49152), counting
knowledge-file bytes only, not the framing prose. The total is split by relevance rank — harmonically, so the top
expert gets the largest slice — and an expert scored `relevant: false` gets none of it. When a file does not fit, it is cut at an **H2 boundary** and the cut is declared on the page:
`… N more findings in .tldrx/experts/<name>/knowledge/<area>.md`. When not even its first section fits, nothing of it
is inlined and the marker says so with the file's size. There is no partial section, because half a `## Gotchas` reads
to the next reader as a whole one, and no partial bullet, because a bullet without its `[src: …]` is a claim with its
citation torn off. The knowledge file's own front matter is dropped and its `trained_at` moved into the comment: a
`---` fence inside the prompt is one of the expert separators above, and a boundary that means two things is not one.

**Why the citations are stated to be reusable.** A knowledge file is accepted whole or not at all (§2.6), and
acceptance means every `[src: …]` on it resolved against a real file — and, since 2026-08-29, that no bullet on it
claims a result it cannot source to a command (§2.6, "a citation must SUSTAIN the claim"). So they are proof already, and the block says
so — otherwise a sub-agent that may only read its declared inputs would either re-derive what it was just handed or
decline to cite it. Measured 2026-08-29 before this existed: a prepared What prompt on a workspace with a trained,
level-3 expert was 1,493 bytes and contained zero of that expert's 646 bytes of findings, zero stars, and not one
occurrence of the word "knowledge".

**Visibility.** `--prepare` and `--dry-run` print one line per loaded expert — name, reason, `expert.md` bytes,
knowledge bytes, and `truncated` when the budget bit — and `pending.json` carries the same as an `experts:` array.
An expert loaded with **zero** evidence in every area produces one **stderr** line, `note: expert <name> has no
evidence — \`tldrx expert train <name> --area <area>\` before this stage would help`. It never blocks and never changes
an exit code; stdout stays parseable for the host session.

**Who closes a gate.** Every stage still ENDS at a gate: `gate.requested` is appended, the stage sits at
`awaiting_gate`, and nothing is skipped. What §2.2's `gates_policy` decides is **who closes it**. `human` waits for
`tldrx approve` — unchanged, exit `4`. `auto` lets the facilitator close it, and only when **all seven** of these
hold, measured off files that already exist. `agent` is the third and strongest: the same seven, plus two more
requirements, below.

| # | Condition | Measured from |
|---|---|---|
| 1 | the stage's declared `checks` all pass | the outcomes `next` just produced |
| 2 | zero open questions in that phase, **and the file could be read** | `<phase>/questions.md`, blocks at `status: open` |
| 3 | spend ≤ the stage ceiling AND the phase ceiling — or `n/a (host-tokens economy)` when the phase is not priced in dollars (§2.11) | `run.yml` `stages[].budget_usd`, `budget.yml` `phases[]`, `budget.yml` `economy` |
| 4 | the stage did not end `failed` | `run.yml` `stages[].status` |
| 5 | the §2.8 validator reports **zero refused AND zero unverified** | the stage's `handoff.md` outputs |
| 6 | **Build only:** every story in the plan is `done` | `03-plan/stories/<id>.md` `status:`, or the implicit plan |
| 7 | **Build only:** the epic branch changed nothing outside the declared surface | `git diff --name-only <default_branch>...<epic_branch>` vs the What/How `file:` citations + the plan's `touches:` |

(6) was added on 2026-08-30, and it is the one condition about what the stage was FOR rather than about its
artefact. Measured on run `260830-tenancy-identity-customers`: six of seven stories settled `blocked`, the epic
branch carried one story's work, and the gate signed the stage — then signed it again after a human revoked it —
because `claim-sources` passed, `questions` was empty and the spend was under the ceiling. Every measured condition
was true and the stage had not been built. A HUMAN may still approve over blocked stories: deciding what is worth
shipping is a judgement, and it is theirs. Outside the Build phase the condition is measured as `n/a` and always
holds — `03-plan/waves.yml` exists while the Plan stage is gating too, and every story is `todo` at that moment by
design.

**(7) `boundary`** was added on 2026-08-31 and is the other condition about the WORK rather than the artefact: was
this the work we scoped? The **surface** is the union of every `file:`-kind `[src: …]` citation in
`01-what/handoff.md` and `02-how/handoff.md` (§2.8's grammar, the same tokenizer) and every `touches:` entry of every
story under `03-plan/stories/` — or of `04-build/implicit-plan.yml` when the scope skipped Plan (§2.13). A directory
entry covers everything beneath it, which is how a story declares the files it is about to create and the forced
companions (a lockfile, a generated client) that come with them. The **measurement** is
`git diff --name-only <default_branch>...<epic_branch>`, once per repo the plan's epics name, through the Build
phase's existing git seam: nothing is checked out, fetched or written. Every changed path outside the surface is
NAMED — at most eight, then `+N more` — never reduced to a count, and the condition fails with
`work outside the declared surface is a boundary change — a human decides whether to widen the scope`. Measured
2026-08-30 on run `260830-tenancy-identity-customers`: the host ran exactly this check by hand at every gate, because
the framework ran it nowhere.

The condition deliberately does **not** judge whether the change was right, does not read the diff, and does not fail
on a path a story declared and did not touch — under-delivery is what the DoD and the reviewer are for. Paths with a
`tldrx-work/`, `.tldrx/` or `.agent/` segment are excluded from BOTH sides (the `isStatePath` filter §2.13's implicit
plan already applies): tldrx's own state is never a boundary question, and in a `root_is_repo: true` workspace it sits
inside the product repo. It never refuses on an absence — outside Build, with no epic branch cut, with no repo on
disk, with no plan, or on a run that declared no surface at all, it is measured as `n/a` **with the reason in the
note**, because a condition that could not measure must not report that it measured zero.

Two of the others were tightened on 2026-08-29, both because an auto gate could be closed by SILENCE:

- **(2) "zero open" is only an answer when the file was readable.** When the stage's `stage.yml outputs:` names a
  `questions.md`, a file the §2.7 parser cannot read — or one that parses to zero blocks — does NOT satisfy the
  condition. The gate falls to a human with the reason
  `questions.md has no parseable question (expected `## Qn · …` + metadata line) — see template`, naming the ids it
  could not see. `tldrx next --commit` refuses the same file outright with exit `5`, while the host session that wrote
  it is still there to fix it. A stage that merely *may* ask (a `questions:` cap with no such output) is unaffected:
  asking nothing is its right.
- **(5) `unverified` counts.** A citation that is well formed and could not be checked from disk — an https doc nothing
  in the workspace names, an `absent:` over a file that exists, a `cmd` with no `workspace.yml` commands to check
  against — passes the stage and blocks the auto gate. See the §2.8 outcome table.

**`agent` gates.** A gate an agent may close, and only over a check it wrote down. It is **strictly stronger** than
an auto gate, never a cheaper one — three things must hold, not one:

1. **all seven `auto` conditions**, unchanged and unweakened, evaluated exactly as above;
2. **no budget decision in this stage's window** — no `budget.raised` and no `budget.blocked` in `events.jsonl` at or
   after the stage's `started_at`. Deliberately an EVENT and not an arithmetic: condition 3 already compares spend
   against the ceiling, and what it cannot see is that a person *raised* the ceiling to let this stage through. A
   decision made to unblock a stage may not then be signed off by the machine that was blocked;
3. **a §2.17 evidence note that signs** — present at `.agent/<stage>/evidence.md`, parsing, every bullet sourced and
   resolving, its arithmetic consistent, its `gate:` equal to the stage at the cursor, and its `verdict: sign`.

All three ⇒ the gate is closed **through the same `approve` path a person uses**: the checks are re-run off disk, the
note is copied to `<phase>/gate-evidence/<stage>.md` (committed — a gate whose evidence lives only in a gitignored
directory is one nobody can audit from a clone), `gate.by` records the note's `by:`, `gate.evidence` records the
headline counts and the path, and one ordinary `gate.approved` is appended carrying `role: agent` and that path.
`AUTO_GATE_ACTOR` is untouched: `by: auto` still means "the facilitator closed it with no note but its own conditions".

Anything else ⇒ **exit `4`, the gate stays open, and every reason is named**. Four of those reasons are called out in
their own right, because a person's next move differs for each: `questions` (a decision nobody has made), `budget-event`
(a ceiling somebody moved), `boundary` (work nobody scoped), and `refusal` (the note's verdict is `refuse` or
`sign-with-fixlist` — the agent doing its job, not failing at it). Any other failing condition is reported as
`condition`, and a note that is missing or broken as `evidence`.

`tldrx approve --as-agent [--evidence <path>]` is the same decision taken by hand: it validates the note, records it
the same way, and refuses on a stage whose policy is not `agent` (exit `1`) — a run keeps the policy it was opened
with, and a flag that could upgrade one at approve time would make the frozen policy decorative. A **broken** note is
exit `2` ("fix the file"); a **refusing** note is exit `4` ("a person decides"). A person may always `approve` an
agent-gated stage with no flag at all: that is an override, it is recorded as a person, and an agent gate is one an
agent MAY close, never one a person may not.

**Decision cards.** When a run stops for a person, the interrupt may be rendered as a CARD rather than as the ordinary
stop block: the decision, its options, an agent's recommendation if one was offered, and the command that settles it.
It is **rendering only** — no exit code, no gate, no question and no grammar changes, and `--gate-agent` never upgrades
a stage's frozen `gates_policy`.

Four kinds, chosen in this precedence: `questions` · `boundary` · `budget` · `gate`. A `questions` card is built from
the §2.7 parser's own blocks (id, title, the `Why asked:` line with its `src`, the lettered options) plus, per
question, the optional `recommend: [{q, option, why, src}]` entry of the §2.17 evidence note. **A question with no
recommendation renders without that line** — never a manufactured one, because the whole value of the line is that an
agent stood behind it with a citation. The other three kinds render a headline, measured detail lines and the commands
that settle them; `boundary` leads with widening the scope, `budget` leads with `tldrx budget show`.

The frame: `DECISION — <run> · <phase>/<stage>` on its own line; a question as `<Qid> · <title>` at column 0 with its
`Why asked:`, its options and its `tldrx answer` command indented two spaces; the `Recommends <Letter> — <why>
[src: …]` line at **column 0**, deliberately, so it does not read as one of the options. Questions are separated by a
blank line.

Three surfaces, one renderer, and they differ in placement: `tldrx run auto --gate-agent` **replaces** the stop block
with the card at exit 4; `tldrx next` on an agent-gate fallthrough **appends** it below `gate pending: tldrx approve`
after a blank line, so nothing that reads those lines today loses a byte; and `tldrx status` shows it for a run whose
`waiting` is an answer.

**The budget condition and unmetered turns.** An in-session `--commit` with no declared cost records
`cost_usd: null, metered: false` (§2.2), and such a turn contributes nothing to any sum. The auto gate's note NAMES
them (`…, 2 unmetered task(s) not counted`) but does **not** refuse on that alone: in-session is the mode where the
host is already watching its own spend, and blocking every auto gate on the absence of a number the host chose not to
pass would make `--commit` unusable. What it must never do is read as "$0.00 — under ceiling, verified".

**Revoking an approval.** `tldrx reject --stage <phase>/<stage> --note "…"` takes back a gate that is already
`approved`, whoever signed it. The stage returns to `ready` with the note on its gate, the cursor moves back to it, and
one `gate.revoked` is appended carrying `signed_by` (`auto` or a person) and the list of later stages now marked
`stale: true`. Those stages' outputs stay on disk — they cost money and are usually mostly right — but nothing may
treat them as current; running a stage again clears its own flag. No cost is refunded and no task is deleted. `--stage`
is also the one verb allowed to target a run that has already FINISHED, because reopening one is its whole purpose.
Before this, `approve()` moved the cursor in the same transaction that signed the gate and `reject` only ever looked at
the cursor, so a fabricated handoff that auto-approved itself could not be undone at all (measured, 2026-08-29).

**Reopening a story.** `tldrx story reopen <id> --note "…"` gives ONE Build story another run of developer attempts.
`reject --stage` is the STAGE-level move and cannot express this: a story that two reviewers refused is `blocked`,
which is terminal for the rest of the run, and an owner who has decided it ships anyway had no verb at all (measured
2026-08-30 on `260830-tenancy-identity-customers`, story S3 — two genuine `changes` verdicts, both attempts really
consumed, and S3 gates wave 3). The note is required. The story's `status:` goes to `todo`, one `story.reopened` is
appended with the actor, the note, the prior status and the verdict count it closes, and **the attempt counter restarts
at 1 of `MAX_ATTEMPTS`** because `readReviewLedger` treats the event as a reset boundary. Nothing is erased: every
earlier attempt stays in `events.jsonl`. It runs no agent, spends nothing, deletes nothing, refunds nothing and moves
no stage — the story's branch, which carries the last developer's commits, is untouched, and sending the Build stage
back remains `reject`'s own signed decision. Reopenable states are `blocked`, `review` and `in_progress`; `done`
refuses, because undoing finished work is a decision about the stage.

**`by: auto` where people look.** An auto-signed gate is named in `tldrx status` — with the `tldrx reject --stage …`
that undoes it — and the status line carries `att`, `auto:N` and `stale:N`. It reached `run.yml`, the event log and
`run status` before this, and none of those is a glance.

(5) overlaps (1) on purpose and is run **whether or not the stage listed `claim-sources` under `checks:`** — a
stage file that forgot to list it must not thereby buy itself a cheaper gate. All seven are evaluated even after one
fails, because "which one stopped it" is the first question anybody asks.

The approval goes through the SAME `approve` path a person uses: the checks are re-run off disk, `by: auto` and
`at` land on the gate, the note records all seven conditions with their measured values
(`auto-gate: checks=claim-sources:passed; questions=0 open; budget=$0.42 of $6.00 stage, phase 01-what $0.42 of
$6.00; status=awaiting_gate; claim-sources=passed; stories=n/a (not a build stage); boundary=n/a (not a build
stage)`), and the existing
`gate.approved` event is appended with `by`
in its payload. No new event type. Any condition failing falls back to the human gate exactly as before — exit `4`
— and the message names the condition and what it measured. An executor that FORCES `gate: approve` (Build) still
forces the gate; the policy decides who signs it.

`next` still runs exactly ONE stage per invocation. An auto-approved gate advances the cursor and stops; the loop
is `run auto` below.

**`tldrx run auto`** — the headless loop. It calls `next` repeatedly and its whole job is knowing when to stop: a
human gate or an open question (`4`), a failure (`5`), a budget refusal (`2`), `--until <stage>` reached or the run
finished (`0`). It holds no state — every iteration re-reads `run.yml` — so killing it leaves a run `tldrx next`
picks up unchanged. One stdout line per stage, derived from the events the invocation appended:

```
01-what/what … done $1.21 · auto-approved
02-how/how … done $2.60 · awaiting human gate
03-plan/plan … skipped (skip_if: stories<=1)
04-build/build … failed: check `plan` failed: story S2 has no dod block
```

`--max-usd` is a ceiling on THIS LOOP's total spend, on top of every stage's own, and is checked **between**
stages: a turn already in flight is never cut off, so the loop can overshoot by at most one stage's share.
`--until <stage>` stops **before** running that stage. Headless only — `--prepare`/`--commit` stay per stage,
because they are a handshake with a host session and a loop that stopped after every `--prepare` would be `next`
with extra words.

**Decisions (2026-08-28).** (a) Stage artefacts are Markdown validated by hooks (human-readable handoffs); the
sub-agent's *result envelope* is structured via `--json-schema` (`{outputs: [], questions_asked: [], notes: ""}`) so
`next` parses deterministically. (b) Map providers: `graphify` first; when absent, `map --refresh` falls back to a
`static` provider (git log, file tree, package manifests) and records `provider:` in `workspace.yml` — the framework
degrades, never installs. (c) Parallelism: v0 runs tasks sequentially; v1 runs independent stories of one wave in
parallel, one worktree per story.

**Streaming and the progress view (2026-08-29).** The spawn is
`claude -p --output-format stream-json --verbose` rather than `--output-format json`.
Two things were measured on `claude` 2.1.251 before the change, on one real call:
`--verbose` is REQUIRED with `stream-json` in print mode (without it the CLI refuses
before spending anything), and `--json-schema` still works — the last `result` event
carries `structured_output` byte-identically to what the single-blob format returned,
so decision (a) above is untouched and `next` parses the envelope exactly as before.
The JSONL is also read as it arrives and derived into a typed event stream (`start`,
`tool`, `tool-done`, `text`, `question`, `cost`, `done`, `error`), from which a
human-readable line is produced with NO extra model call: `reading src/Foo.cs`,
`$ dotnet test → running`, `→ ok (12 s)`, `asked Q1: …`. Four commands render it —
`next`, `run auto`, `expert train`, `seed triage --propose` — in one of three modes
(`--ui scene|compact|plain|off`, or `TLDRX_UI`; `auto` by default: `scene` on a
terminal at least 72x20, `compact` on a smaller one, `plain` in a pipe or under
`NO_COLOR`/`CI`). Every byte of it goes to **stderr**; stdout is byte-identical with
the view on and off, because that is what the chat bridge and every `--json` consumer
read. A `result` cannot be resolved from a stream, or from a single blob an older
`claude` printed, or from neither — in which case the run fails exactly as it did
before, with the process's own first line of stderr in the message.

**Two execution modes (same files, same validation).** *Headless*: `tldrx next` spawns `claude -p` itself — for
terminals, CI and chat bridges. *In-session*: when the user is already inside Claude Code, the `/tldrx` skill runs
`tldrx next --prepare` (writes the prompt bundle + declared inputs to `.agent/prompt.md`), Claude Code dispatches the
sub-agent with its own Agent tool, then `tldrx next --commit` validates outputs, checks, cost and gates exactly as the
headless path does. A nested `claude -p` from inside a Claude Code Bash tool is **verified working** (2026-08-29, see
§7); the in-session mode exists because it is cheaper and because it is the only mode that survives where spawning is
disallowed, not because spawning fails.

**Stage executors.** Two phases are not shaped like "one sub-agent, one set of declared files", and for those the step
between *prompt assembled* and *outputs validated* is replaced by a **stage executor**, chosen from a map keyed on the
**phase id** (`src/core/facilitator/executors/`). A phase with no entry keeps the default path. Everything either side —
the lock, the cursor, the budget gate, `run.yml`, the checks, the gate — stays in `next`, because an executor that could
move the cursor would be a second facilitator.

**Build executor** (`04-build`, concept §9). `waves.yml` is the schedule and a **story is the unit**; the pipeline over
one story never varies:

1. **Resolve and cut.** The story's `repo:` must be a `workspace.yml` name (a story is data, and data does not get to
   name a directory); `epic/<slug>` is ensured off that repo's `default_branch`; a worktree is opened at
   `.tldrx/worktrees/<repo>/<run-id>-<story-id>` on `story/<run-id>/<id>`, cut from the epic branch (both names carry
   the run id — see the paragraph on run-scoped names below). Every git call goes through the
   runtime seam with a cwd inside a declared repo, and there is deliberately **no `push` wrapper** anywhere in the phase.

   **A branch that already exists is checked out as it stands — and then measured against the epic tip (2026-08-31).**
   `story reopen` keeps a branch by design, and a requeued attempt keeps one too, so a story is regularly opened onto a
   base the epic has moved past. Only the opening that is about to put a DEVELOPER on the branch may move it — the
   headless pipeline and `--prepare`; the review and `--commit` openings measure nothing and move nothing. Three states:

   | State | What happens |
   |---|---|
   | the branch is an ancestor of the epic tip and the worktree is clean | **fast-forwarded** (`git merge --ff-only`), one line naming both shas and the count, and one `story.base_fastforwarded` (§2.9) |
   | commits on both sides | **warn, change nothing** — both counts, both shas, and the operator's two options (merge in the worktree, or preserve the divergent commits on a backup branch and re-point). The dispatch proceeds on the old base and the line says so |
   | the worktree is dirty | **warn, change nothing** — a dirty tree is the operator's |
   | already at the tip | silent, and no event |

   **Never a rebase.** Rewriting a branch a developer has already committed to is the class of move the
   run-id-in-branch-name rule exists to prevent, and which of two divergent histories survives is a decision, not a
   default. Measured 2026-08-31: `git merge --ff-only` blocked by a file in the way exits non-zero and leaves HEAD and
   the file exactly as they were, so a failed fast-forward needs no repair — only a line saying it did not happen.
2. **One developer sub-agent**, cwd = that worktree, handed the story file, its epic's summary and the CONTENT of every
   path the story `touches` (≤24 files, ≤64 KB `[assumption]`, missing paths named as "this story creates it").
   `--allowedTools` is the file tools + `Bash(<each command THAT repo declares>)` + `Bash(git add *)` +
   `Bash(git commit *)` — narrower than the default allowance, which is every repo's commands, and wider by exactly the
   two verbs that make a commit. Its ceiling is `min(stage budget ÷ stories, per_agent_max_usd, --max-usd)`.
   A developer that **FAILED** — a spawn error, a timeout, an exhausted `--max-budget-usd` — delivered nothing, and a
   turn that never ran is not an attempt: the story is put back at the status it held BEFORE the attempt (`todo`, or
   `review` when a reviewer had asked for changes), its attempt number unspent and its worktree kept, and the next
   `tldrx next` — headless or `--prepare` — offers it again as a fresh developer run at the same attempt number. Its
   `check.failed` carries `check: "developer"`, `status: "error"` and the error as `detail`. Measured 2026-08-30 on
   `260830-tenancy-identity-customers`: five spawns died on `Reached maximum budget (…)` and each was recorded as the
   story `blocked` — terminal in-run — so six of seven stories were reported as tried and failed when five of them had
   never been tried. A developer that RAN and produced work its DoD faulted is a different thing and still blocks.
3. **The Definition of Done, re-run by the facilitator** in that worktree, through the same runner `dod-gate` uses. All
   commands must exit 0.

   **A DoD is a DELTA gate, so the base tree is checked first (2026-08-31).** At Build entry — after the dirty-tree and
   foreign-epic refusals, before a story is dispatched or charged — every dod command the pending stories name is run
   ONCE against the untouched base tree, in the repo's own checkout (the tree that has the installed dependencies; a
   pristine worktree would fail for want of them and turn this into an outage). A non-zero exit is a **workspace-config
   error**: Build refuses with exit 2, naming the command, its exit code and the repo, and no story attempt is spent.
   Results are written to `04-build/preflight.yml` (files are the state) and read back by later invocations, so a
   resumed run never re-pays for them; a command the gate declines to run at all is recorded `unmeasured` and refuses
   nothing. When a story's DoD then fails, the cached base result decides ATTRIBUTION: a command red on the base too
   halts the build with the same config error instead of blocking the story. Measured on `260829-scoring-leaderboard`:
   two of three declared commands already failed on pristine main — one of them running paid `Live` AI tests the repo's
   own CI excludes — so all 15 stories would have blocked identically, each having spent a developer turn on it. Then anything still uncommitted is committed as `feat(<story-id>): <title>` — the agent may
   have committed already, and either way the sha is read back with `rev-parse`.
4. **Merge into the epic**, `git merge --no-ff` inside a worktree checked out on the epic branch. On conflict the merge
   is **aborted** — so the epic branch is exactly as the previous story left it and the wave can continue — the
   conflicting paths are read from `diff --diff-filter=U`, and the story is `blocked` with them as its `evidence:`.
   How many commits the merge is about to move is counted BEFORE it happens (`rev-list --count <epic>..<story>`),
   because afterwards it cannot be: a merged story branch is an ancestor of the epic either way. A count of **0** is a
   merge that moved nothing — git exits 0 and says "Already up to date" — and the handoff says so rather than calling
   it merged (measured 2026-08-30: a Gate section listed four such branches as merged work).
5. **A reviewer sub-agent**, read-only (`Read`, `Grep`, `Glob`, `Bash(git diff *)`), judging the story diff against the
   acceptance criteria and the conventions. `[assumption]` — the brief says the reviewer writes
   `04-build/log/<story-id>.md` and that its tools are read-only, which cannot both hold; the judgement is the model's
   (returned through a `--json-schema` envelope: `verdict`, `summary`, `findings`) and the **log is written by the
   executor**. A verdict that cannot be parsed is `changes`, never `approve` — the reviewer ANSWERED and its answer is
   unreadable. A reviewer that never answered at all is different and is recorded as `verdict: "error"`: a spawn
   failure, a timeout or an exhausted `--max-budget-usd` is a transport outcome, not a judgement of the diff, and
   writing one down as `changes` spends a requeue on code nobody faulted (measured 2026-08-30, $0.26 died mid-read on a
   39-file story). Its `check.failed` carries the error as `detail` so a ledger can tell the two apart.
   A third verdict, **`fixlist`**, is the one the other two could not express: the reviewer would SIGN and it found
   defects the acceptance criteria never covered (measured 2026-08-31 on S5 of `260830-tenancy-identity-customers` —
   every criterion met, zero scope violations, and a concurrent double-confirm minting two sessions). It is granted
   only when the envelope carries a readable `fixlist[]` — `{n, severity, finding, where, disposition, detail,
   do_not[]}` — and a declared one this cannot read falls to `changes` like any other unreadable envelope, because an
   unreadable review must not buy the third VERDICT. It may buy a bounded free CORRECTION, which is a different thing
   and is #78/#79 below: the round is granted on a fix list somebody can read, and on nothing else. See "the fix list"
   below.
6. **`done` requires DoD green AND `approve`**, and writes the proof into the story's own front matter: `$ <cmd> →
   exit 0` per dod command, `commit <sha>`, and the review path. A `changes` verdict sets the story `review` and
   requeues it **once**, with the review rendered under `## Previous attempt`; a second `changes` blocks it. An
   `error` verdict also parks the story at `review` but spends **no** attempt: the diff is committed, merged and
   DoD-green, so the next `tldrx next` re-runs the **review alone**, recovering the commit and the DoD results from
   `events.jsonl`. A `fixlist` verdict likewise parks it at `review` and spends **no** attempt — nothing about the diff
   was faulted — and writes `04-build/fixlist/<story-id>-<round>.md` beside it. Only a verdict that FAULTED the diff
   consumes the requeue. Headless re-runs it by spawning; `--prepare` writes the
   reviewer bundle for the host and stops (see "the second delegable role" below).

   **A FORMAT-refused envelope is re-prompted, not charged (#78, #79).** An envelope Build cannot read falls to
   `changes` as above — but that is a fault in the reviewer's REPORT, not in the diff, and charging the story one of
   its two attempts for it conflates the instrument with the result (measured 2026-09-01 on
   `260830-ordering-inventory`: S2, S3 and S5 each lost an attempt to it, over summaries beginning "I would sign
   this"). Build instead asks the SAME reviewer for a corrected envelope, carrying every refusal verbatim — #77 made
   the citation ones name the rule broken, quote the line written and show a corrected one — under
   `## Your previous envelope was REFUSED`, and records one `story.review_retried` (§2.9) per free round. Bounded at
   **two** per envelope round: the third refusal is the ordinary `changes` and costs the attempt, so a reviewer that
   cannot write a readable envelope still settles. Both doors go through it — a spawn re-prompts itself;
   `--commit --review` leaves the bundle out with the refusal spliced into its `prompt.md`, moves the refused
   `result.json` aside as `result.refused-<n>.json`, and settles nothing. Each re-prompt is a real metered turn and
   appears as its own task row: it costs the story no ATTEMPT, never no money.

   **The rule is FORM versus WORK, and §2.9 lists both sides.** #78 shipped it for the claim-sources grammar alone and
   filed the rest; the owner's #79 decision (2026-09-01) widened it to every envelope-FORMAT refusal — a missing or
   non-array `fixlist`, an empty one, a row that is not an object, a row with no `finding` text, a row with no valid
   `disposition`, and a verdict WORD outside the enum (#36 keeps its message; only its price changed). A verdict's
   CONTENT, a red DoD, a second fix-list round refused by its own bound, and any refusal the format index does not
   claim all keep the cost they had.

**Blast radius is one story.** A red DoD, a merge conflict or a failed sub-agent blocks that story only; the epic
carries on with the next, and so does the wave. **The phase never ships:** no epic is merged into a default branch, so
the stage forces `gate: approve` whatever the stage file says, and the handoff lists the epic branches ready to merge
per repo. `04-build/handoff.md` is written by the executor from what it measured — Findings cite
`[src: 04-build/log/<story-id>.md:1]` (one log per story touched, so every citation resolves), the Evidence ledger is
the dod commands as `[src: $ <cmd> → exit <n>]`. **Those logs are committed state** (§1 `[c]`), which is why the `.gitignore`
block re-includes `tldrx-work/**` before it ignores anything: a project rule that hides them costs the run its record of
what the reviewer said, and says nothing while it does.

**Safety.** A repo with uncommitted changes on the branch an epic would be cut from is refused **before** anything is
cut (exit `2`, the stage stays `ready`, the message names the files and the fix) — counting PRODUCT paths only, since
under `root_is_repo: true` the framework's own `tldrx-work/` and `.tldrx/` live inside that repo and this very command
rewrites them (`run.yml`, `events.jsonl`, `.lock`, the phase folder it just wrote), so the check would refuse itself and
would make a user's uncommitted answers a precondition of Build; a story commit excludes those two paths by pathspec for
the same reason, and the multi-repo shape, whose state is a sibling of the repos, is untouched. `--dry-run` is refused outright (`dry_run_allowed: false`), since a
stage that cuts branches and fans out per-story sub-agents has no ONE dispatch to describe. STORY worktrees are removed when a story reaches `done` or
`blocked` — never on `review`, whose second attempt continues in the same tree — unless `--keep-worktrees`. The EPIC
worktree outlives the stage: it is removed when the RUN closes, not when Build finishes (issue #16, owner decision
2026-09-01). A later Watch stage cites code that is committed on the epic branch and deliberately not merged, and §2.8
can only resolve such a `src` against a checkout that is still on disk; cleaning up at the end of Build put it beyond
reach before the Build handoff was even written. Every close path takes them — `tldrx next` closing the last stage,
`tldrx approve` signing the last gate, `tldrx run cancel` — and `--keep-worktrees`, remembered on the run as
`keep_worktrees:`, means "survive even that".

**The implicit plan — a scope that SKIPS Plan can still Build (2026-08-29).** When the run's workflow names `plan` in
its `skips:` (§2.4) **and** there is no `03-plan/waves.yml` on disk, the executor synthesises one story rather than
refusing. A real `03-plan/` always wins: if the file is there it is executed, whatever `skips:` says, because somebody
wrote it on purpose. The synthesis is deterministic and asks no model — every line is copied from a file the run
already wrote, into `04-build/implicit-plan.yml`:

| Field | Where it comes from |
|---|---|
| `title` | `run.yml`'s `title:` |
| `goal` | With NO answered fact: `01-what/handoff.md` § Decisions, bullets verbatim, `[src: …]` tokens kept, **minus** the What's own deliverable (below). With answers: nothing but `Apply <the whole answer> to the touched files [src: F<n>; 01-what/questions.md:<line>]`, one per answered fact of this run |
| `acceptance` | `01-what/success-metrics.md`'s list items, verbatim, same subtraction — **plus** the settled-documents criterion (below). Empty ⇒ `goal`; both empty ⇒ one line saying the title is the whole brief |
| `notes` | the fact→document mapping that was derived, and every gap in it |
| `context` | the What's § Decisions, when the run HAS answers — background for the work, never instructions. Empty otherwise, because then they are the goal |
| `touches` | the repo paths `01-what/handoff.md` CITES that exist inside a repo `workspace.yml` declares, first-cited order, **plus** the documents this run's answers settle by name (below), ≤24. A citation with no repo prefix is skipped rather than guessed at |
| `inputs` | `01-what/questions.md`, when the run wrote one — inlined into the developer prompt, since a run artefact can never arrive through `touches` |
| `repo` | the run repo those citations name most; ties and no citations fall back to `run.repos` order |
| `dod` | the commands `workspace.yml` declares for the ROLES this scope calls for — `docs`: `lint`; `spike`/`prototype`: none; everything else: `build`, `test`. Looked up by the **key** the human wrote, never matched against the command text (`lint: dotnet format --verify-no-changes` has no "lint" in it) |
| `budget_usd` | the Build stage's own ceiling, as scaled into `run.yml` |
| `branch` | `epic/<run-id slugged into `EPIC_BRANCH_RE`>` |

**The plan carries the work FORWARD.** Measured on the aparece run: the What handoff's Decisions and its success
metrics describe what the WHAT stage had to produce — "one `questions.md` block per decision", "the question count
matches the decision count". Copied straight into Build they would tell a developer to write a file the run already
has. So:

- **Bullets whose subject is the What's own deliverable are dropped** from `goal` and `acceptance`, on five LITERAL
  signals — `questions.md`, `### Q`, any `01-what/` path, a question id (`Q1`, `Q1–Q6`), and the run's-questions
  vocabulary (`every question …`, `each question's …`). Measured on the aparece run: the first two caught three of six
  bullets and left three criteria about `01-what/questions.md`'s contents that never name the file; the other three
  signals are exactly what those three say instead. **Every dropped bullet is written into `notes:`** with the signal
  that fired and its opening 90 characters — a filter whose mistakes are invisible is a filter nobody can correct,
  and with the drop on the record the rule can afford to be decisive. A bullet about `04-build/`, or about a file the
  story touches, matches no signal and survives.
- **The answers become the work, and they are the ONLY thing in `goal`.** Every live fact in
  `.tldrx/memory/facts.yml` whose `source.run` is THIS run is an answer a human gave at one of its gates. Each one adds
  `Apply <the whole answer> to the touched files [src: F<n>; 01-what/questions.md:<line of the [Answer]: slot>]`, and
  with any such fact present the What's Decisions move out of `goal` into `context:`. Measured on the aparece run of
  2026-08-30: those bullets read "Out of scope: selecting an answer on the owner's behalf … every relevant ADR is
  status `proposed`", which is the opposite of the job the answers had just created, and they were the story's whole
  stated goal. `context:` is rendered in the developer prompt under `## Context (from the What stage)`, after the
  objective, labelled background and explicitly not a task; the prompt's plan note names the facts
  (`… applies the run's answered decisions (F005–F010) …`) so the two lists cannot be confused.
- **The bullet quotes the WHOLE answer**, read back from `01-what/questions.md`, not the row in `facts.yml` — a fact
  is capped and a developer handed "Accepts ADR-D009 as writt" has a sentence that stops before it says anything. The
  questions file is DECLARED as an input of the implicit story and inlined into the prompt (it cannot arrive through
  `touches`, which resolves inside the story's worktree), and each bullet cites the line its words came from, so the
  quote is checkable rather than trusted.
- **`acceptance` gains the settled-documents criterion.** A fact *settles* a touched document when its text mentions
  that file's ADR id (`ADR-D008`, or the bare `D008`) or its `decision <n>` — a claim anyone can re-check by reading
  the two strings. **Every fact is matched against the full `[Answer]:` behind it as well as its own text**, read from
  `01-what/questions.md` by the fact's `source.q` or by the question block's footer `fact:` id. `captureAnswers`
  builds a fact as `"<question> — <answer>"` and cuts at §2.5's cap, so on the aparece run four of six lost the very
  clause naming the ADR they settle: 2 of 6 mapped on the stored text, 6 of 6 with the answer. Both halves are
  matched, never the answer alone — a fact carrying a key its answer does not must keep matching on it — and the
  concatenation is unconditional: gating it on "the stored text hit the cap" tied the mapping to the cap's exact
  value, so raising §2.5's cap on 2026-08-30 would have switched the fallback off for every 300-char fact already on
  disk. Adding the answer can never match less than the fact alone, so the gate bought nothing. A leading document
  number (`13-OPEN-DECISIONS.md`) is deliberately **not** a decision number. With a mapping: ``every touched document whose decision is settled by a fact of this run no longer reads
  `Status: proposed` — `grep -c 'Status: proposed' <paths>` → 0 for the ones a fact decides [src: F<n>…]``, whose path
  list is COMPLETE or replaced wholesale by "the N documents listed under `notes:`" — a `(+1 more)` inside a command
  is something a person pastes, runs, and reads the wrong answer from. With
  anything left over — an unmapped file, an unmapped fact, or no mapping at all — it also (or only) gets the generic
  `apply every listed fact; leave a one-line note per file saying which fact changed it [src: F<n>…]`. `notes:` names
  every derived pair, every unmapped file and every unmapped fact, so a partial mapping is visible rather than implied.
- **A document a fact settles joins `touches`, even when the What never cited it.** Measured on the aparece run of
  2026-08-30: F010 decided ADR-D013 and the handoff never named the file, so `touches` left it out — and the developer
  prompt says "A change outside `touches` is a plan deviation", so the run's one story could not do the thing the run
  was for; the plan's own `notes:` said "F010 settle no touched document". The search is the SAME mapping rule read
  backwards — a file whose name carries a decision key (`ADR-D013-*.md`, `decision-7.md`) that some fact of this run
  names — looked for in the directories `touches` already holds, then breadth-first over the repo, capped at the same
  ≤24 and never adding a document no fact names. Every addition is written into `notes:` as
  `added <path> to touches: settled by F<n> (its text mentions \`<key>\`)`, and the acceptance grep then lists it like
  any other mapped document.
- **tldrx's own state never reaches `touches`.** A handoff cites `tldrx-work/…`, `.tldrx/…` and `.agent/…` as
  EVIDENCE, and `touches` is built from what the handoff cites — so on the aparece run of 2026-08-30 three of thirteen
  touched paths were `run.yml`, a triage `split.yml` and an agent bundle's `prompt.md`, handed to a sub-agent that is
  told a change outside `touches` is a plan deviation. Any path with `tldrx-work`, `.tldrx` or `.agent` as one of its
  segments is dropped, with `excluded <path> from touches: tldrx state is never story-writable` written into `notes:`.
- **The developer prompt says where the story came from**: "Plan was skipped by the scope; this single story applies
  the run's answered decisions to the files it touches." No design document is going to say it, because none was written.

**`tldrx next --prepare --discard-pending` DERIVES THE PLAN AGAIN.** The bundle is a rendering of the plan, so binning
the bundle and keeping the plan re-hands the developer the same story — which is what a real operator got on
2026-08-30, because `loadImplicitPlan` writes the file once and reads it forever after. On a Build stage running off
an implicit plan the flag now: bins the bundle's `pending.json`, `result.json` and `result.raw.json` (the stale result
is the one that matters — a later `--commit` would read it as this cycle's); re-derives `implicit-plan.yml` from the
handoff, the metrics and the answers as they stand NOW; and prepares a fresh bundle. The run's own `epic/<slug>`
branch and story worktree are REUSED, not re-cut and not refused: `run.yml`'s `build.epic_branch` says this run
claimed them. It re-derives only while nothing has been built off the plan — `evidence: []`, a `status:` that is not
`done`/`blocked`, and `git rev-list --count <epic>..<story>` = 0 — and when one of those fails it keeps the file and
prints which one.

The file is also the story's STATE: its top-level `status:` and `evidence:` are what the executor writes back, patched
by the same two surgical edits a `stories/<id>.md` gets. The story then runs the ordinary pipeline — worktree,
`story/<run>/S1` off the epic, developer, DoD, merge, read-only reviewer, human gate — because a docs edit is a code
edit. One line goes to stdout (`implicit plan: Plan skipped by scope 'docs' — one story S1 (…)`) and `run status`
prints `plan: implicit (scope skips Plan)`, so a synthesised plan never reads like one a person approved.

**An implicit story with NO dod command is green.** A planned story with an empty ```dod block blocks — that is a Plan
bug, and done means proven. An implicit one is the framework reporting accurately that this scope has nothing to run
(`spike`/`prototype` declare no DoD by design; a `docs` repo may have no lint command), and failing it would move the
dead end one step later instead of removing it. The reviewer still runs and the human gate still stands. `evidence:`
is still real: the commit sha and the review log.

Build's declared input `03-plan/waves.yml` is treated as satisfied by the implicit plan, and so is anything else under
`03-plan/` — that is the phase the scope skipped. **Every other missing input is still exit 1**: skipping Plan is not
an excuse for a missing `.tldrx/conventions/shared.md`.

**Parallel within a wave — `--parallel N`, default 1 (2026-08-30).** `waves.yml` guarantees a dependency is in an
EARLIER wave, so the stories of one wave are independent by construction and may run at once. The number is resolved
`--parallel` > the workflow's `<stage>: {parallel: N}` (§2.4) > `stage.yml`'s `parallel:` > 1, refused rather than
clamped at the CLI when it is not a whole number ≥ 1, and clamped in the executor to `[1, MAX_STORIES_PER_WAVE]`.
`run auto --parallel N` passes it to every `next` it makes.

At **N = 1 the executor takes the path it always did**, story by story — measured byte-identical on the event
sequence, because "the default does not change" is not a claim to make loosely. Above 1 the wave runs in two halves:

- **A, concurrently, ≤ N at a time**: worktree → developer → DoD → commit. A story that goes red does NOT cancel its
  siblings — killing four running sub-agents because a fifth failed throws away turns already paid for.
- **B, serially, in the wave's LISTED order**: merge → reviewer → `done`/`blocked`. Serial for the merge, and also for
  the reviewer: a reviewer reads `git diff <epic>...<story>`, whose merge base MOVES every time another story merges
  into that epic, so two concurrent reviewers would be judging diffs that changed under them.

Consequences the implementation commits to: the epic's commit order is the file's order, not the finish order; a
conflict takes the existing `--abort` path and blocks that story alone; a wave with any blocked story ends `failed`
and the NEXT WAVE IS NOT STARTED, since its stories may depend on what this one did not land (the sequential path is
unchanged here and still carries on — N = 1 is v1's behaviour, not a new rule); Ctrl-C/SIGTERM kills every live child,
because `killAllChildren` signals the whole registry and each spawn registers its own pid.

**The budget does not change.** `worstCaseShares` is already `stories × MAX_ATTEMPTS × (1 + REVIEWER_SHARE)` across
the whole plan, so the sum of every cap the executor can hand out is ≤ the stage ceiling however the attempts fall —
and however many of them are in flight at the same moment. Running concurrently spends the same money faster, never
more of it.

**Per-story prices, since 2026-08-30.** That uniform share is the FALLBACK. When
`03-plan/budget.yml` takes the same optional `economy:` key at its root, so a Plan agent can say which economy it
was pricing in — the thing 2026-08-30's Plan agent could not say and was then held to. A plan priced in
`host-tokens` contributes **no** dollar caps: its numbers are not dollars, the executor falls back to the uniform
share it used before plan prices were read at all, and it says so in one line rather than spending a token figure as
money.

`03-plan/budget.yml` prices a story in its `per_phase_usd:` map — which the Plan writes and the Plan gate validates,
and which nothing read until this date — that story's developer cap is `price ÷ (MAX_ATTEMPTS × (1 + REVIEWER_SHARE))`
and its reviewer's a `REVIEWER_SHARE` of that. Prices summing to more than the stage are scaled down proportionally, so
the plan's ratio survives and the total cannot escape the ceiling; an unparseable or invalid file is an advisory on
stderr and the uniform split. Measured before it: a seven-story plan pricing S1 at $4.75 and S2 at $0.75 gave both
$1.03. **The reviewer also has a floor** (`REVIEWER_FLOOR_USD`, $1.00), clamped by what the stage has left and by
`per_agent_max_usd`. The floor is the one place the "every worst case sums inside the ceiling" property is knowingly
given up: a reviewer that cannot finish reading the diff judges nothing and wastes the developer turn beside it, and
`budget.yml`'s gate is what actually stops a stage that runs out.

**One activity line per lane.** Every event a Build sub-agent publishes carries its story id as a `lane`, so the
scene, the compact one-liner and `--ui plain` show `S1 reading … · S2 $ dotnet test …` rather than interleaving two
streams into one. A lane disappears from the line when its agent finishes. With one lane — every run that did not ask
for parallelism — the view is byte-for-byte what it was.

`--prepare`/`--commit` is **per story** and stays sequential whatever `--parallel` says: `--prepare` bundles the next
pending story into `.agent/<stage>/<story-id>/`, marks it `in_progress` (the file is how `--commit` finds it again),
and stops; `--commit` picks that story's pipeline up at the DoD step and prepares nothing. The host session
dispatches its own sub-agent, and this side has no way to know how many it is willing to run.

**The REVIEWER is the second delegable role: `next --prepare --review` / `--commit --review`.** Same handshake, one
directory down — `.agent/<stage>/<story-id>/review/{prompt.md,pending.json,result.json}`, nested so a reviewer bundle
can never be read as a developer one. `--prepare --review` writes the prompt a spawned reviewer would have been sent
(the same renderer), plus `role: reviewer`, `result_schema` (the reviewer's `--json-schema` envelope, verbatim, so the
host needs no source to know the shape) and a `review:` block carrying the diff command, the merged commit, the
attempt and the **DoD results recovered from `events.jsonl`** — and it **spawns nothing**. `--commit --review` reads
that `result.json` as the envelope, narrows it with the SAME fail-closed parser (unreadable ⇒ `changes`, never
`approve`), and settles the story through the same code a spawned verdict goes through: `approve` ⇒ `done`, `changes`
⇒ one requeue then `blocked`, attempt accounting untouched. A host that never writes `result.json` has produced no
verdict and spends no attempt. The turn is recorded `cost_usd: null, metered: false` (a `cost_usd`/`tokens` in the
envelope declares it), the `check: review` event carries `source: host`, and **no `agent.spawned` is emitted** — a
`task.started` with `role: reviewer, mode: prepare` is. A settled handshake removes the bundle; its presence is what
says a review is outstanding, and `--discard-pending` bins it like any other.

Two things route into it without the flag. A story **waiting on a review** — its last reviewer errored, or its review
is already out with the host — gets its reviewer bundle from a bare `tldrx next --prepare`, because a `--prepare` that
spawns is not a `--prepare` (measured 2026-08-31: the re-review path spawned a metered reviewer under `--prepare` and
a host timeout killed it mid-read). And on a run marked **`attended_by: host`** the executor never calls the reviewer
spawn at all: half B merges the story and hands the review over, so one review is done once, by the session that is
already reading the diff. Outside attended mode the headless reviewer is unchanged and `--review` is opt-in.

**The fix list — `04-build/fixlist/<story-id>-<round>.md` `[c]`.** The artefact of the third verdict, written by the
EXECUTOR from the envelope (the reviewer holds no write tool, the same reason the review log is written here). Its
shape: a heading, the round's own facts (verdict, attempt, diff command, commit), then one
`## <n> · <finding>␣␣[<severity>]` section per finding — **two spaces** before the bracket — carrying `Where:`
(the literal `(not stated)` when the envelope gave none), `Disposition:` and `Resolved:`. The disposition is written
and **read back bolded**: `Disposition: **fix-now**`. A host editing the file closes a finding with `Resolved: yes` or
re-routes it by changing the value between those asterisks; a `Disposition:` line without them does not parse, and the
finding it belongs to is dropped rather than half-read.

- **Four dispositions**, and each is a decision somebody made rather than a fact about the code: `fix-now` (this
  story's own correctness), `defer-with-log` (real, somebody else's call), `refuted` (the reviewer was wrong),
  `out-of-scope`. A **`refuted` finding must carry a `[src: …]`** in its `where` or `detail`, in the §2.8 grammar and
  through the §2.8 parser — a reviewer's verdict is a claim like every other one, and tonight's host disproved one by
  grepping both sides before acting on it. A fix list with a `refuted` finding and no citation is refused whole, and
  the verdict falls to `changes`.
- **A disposition ROUTES a finding; `Resolved:` CLOSES it.** Two questions, two fields. `defer-with-log` findings are
  appended to `retro.md`'s `## Build feedback` as they are written — the existing second writer with its existing
  verbatim dedup — so a deferred defect reaches the owner through a channel that already exists.
- **One round per story** (`MAX_FIXLIST_ROUNDS`, reset by `story reopen` like every other count in the review ledger).
  A free round that could be taken twice is a story that never has to settle, so a second `fixlist` is refused out
  loud and read as `changes` — which costs the attempt the first one did not — and the SECOND reviewer's prompt
  withdraws the verdict rather than offering one the executor would refuse.
- **A story cannot settle `done` while a `fix-now` finding is open.** It settles `blocked` instead, and the reason
  names the file, the finding's number and its heading. The check is against the FILE, not the envelope that produced
  it: the file is the state, and a host closes a finding there by writing `Resolved: yes` or re-routing its
  `Disposition:`.
- **The router: `tldrx next --prepare --fixlist <path>`.** Re-prepares the AUTHOR's bundle with the open findings under
  `## Fix list` in the developer prompt — numbered, with their `Do NOT` lines verbatim — and carries the prior turn's
  `session_id` in `pending.json` as `resume_session` so the host can resume that sub-agent rather than pay to rebuild
  its context. **The framework resumes nothing itself**: `spawnAgent` has no `--resume`, and the key is a fact handed
  back to the party that can act on it. `pending.json` also gains `fixlist: {path, round, findings, open}`. Omit the
  flag and the latest round on disk with anything still open is carried by itself, the same courtesy `--prepare`
  already extends to a story waiting on a review; the flag is for naming a different file, and it refuses one that is
  not this story's.

**Watch executor** (`05-watch`, spec §2.16). In order:

1. **A deterministic pre-pass.** Read `03-plan/stories/*.md`, keep the ones at `status: done`, group them by their
   `epic:`. One feature per epic, named after the epic's `branch:` slug. No model is asked which features shipped,
   because the files already say — and a story at `done` is the only assertion in the workspace that something landed.
2. **One sub-agent per feature**, operations expert plus the stack experts of that feature's repos, handed exactly four
   things and nothing else: the done stories of that ONE epic (front matter `touches`, `evidence`), the **read-only diff
   of the epic branch against each repo's `default_branch`** (through the runtime seam — `rev-parse`, `diff --stat`,
   `--name-status`, `--unified`; nothing checks out or fetches), the non-retired facts tagged area `observability` or
   `deploy`, and `.tldrx/map/<repo>/gotchas.md`. The diff is what landed; a story's `touches:` was written before the
   code existed and is an intention. Where they disagree, the diff is the evidence. `[assumption]` — the patch is
   truncated at 24 KB per repo and the prompt says so; a repo that cannot be diffed is stated as an absence, never as a
   silent empty diff, which would read as "nothing was instrumented".
3. **Validation and the status stamp**, done by the framework off disk: sections, tokens and citations via the shared
   handoff parser, then `status: verified` written only when no `absent:` source remains under `## Signal`.
4. **`05-watch/handoff.md`, written deterministically** — Findings are one line per card with its status, each sourced
   `[src: 05-watch/watchers/<f>.md:1]`. The cards are the model's work; the handoff is arithmetic over them, because a
   model asked to summarise its own cards is free to describe a `draft` one as coverage.

`--prepare`/`--commit` is **per feature**: each gets its own `.agent/<stage>/<feature>/{prompt.md,pending.json,result.json}`,
so the host session dispatches N sub-agents with the same isolation the headless path gives them. `[assumption]` — the
agent ceiling is the stage share divided N ways with a **$0.25 floor**, because §7 measured a cold `claude -p` paying
10–26k cache-creation tokens before its first reply: a share under that is a failed spawn, not a saving.

**No done stories is a result, not an error.** The stage completes, spawns nothing, spends nothing, and writes a handoff
whose four sections each read `- none [src: absent:03-plan/stories]`. `watchers/<feature>.md` is deliberately **not** in
the stage's `outputs:` — a declared output is re-read by name (above), and these have no name until the pre-pass has run.

**Two locks, and what each one guards.** `tldrx-work/<run>/.lock` is the single-writer guard on ONE run — a pid file,
taken by `next`, stale when `kill(pid, 0)` says the holder is gone. `.tldrx/.lock` is the workspace lock, and it guards
the files SEVERAL runs share: `.tldrx/memory/facts.yml` and each run's `budget.yml`. It is taken for the DURATION of a
read-modify-write, not just the write — `facts.yml` mints its next id as `max(id) + 1` off the file, so two appenders
that both read before either wrote would both mint `F001` and the second save would erase the first fact. Same pid
rule, same stale rule, and re-entrant within a process. Both files are written temp + `rename`, so a reader sees the
whole old file or the whole new one, never a truncated middle. And `budget.yml`'s **ceilings are re-read from disk
before every write**: a writer that did not deliberately change them contributes only actuals, so a `budget raise` that
lands while a stage is in flight is no longer reverted by that stage's save.

**`running` is three states, not one.** A stage that says `running` means one of three different things, and every
reader has to tell them apart or it will offer the wrong command:

| On disk | What it is | What is offered |
|---|---|---|
| `.lock` held by a LIVE pid | a `next` is working right now | wait, or `tldrx run unlock <id>` if that pid is gone |
| no lock, `.agent/<stage>/pending.json` | a `--prepare` bundle nobody committed | `tldrx next --commit <id>`, or `tldrx reject --run <id> --note …` |
| no lock, no bundle | a crash between the `running` stamp and the spawn | `tldrx next` — it demotes to `ready` and re-runs |

The middle row is the one cut with no lock behind it: `--prepare` releases the lock on purpose, because the host
session — not `tldrx` — runs the prompt. `tldrx next` **refuses** (exit `2`) rather than re-spawn a stage in that
state, because a re-spawn discards a sub-agent turn the run has already been billed for; `--discard-pending` is the
explicit way to bin the bundle and run it again. A phase with an executor is exempt: it stays `running` across
`--prepare`/`--commit` cycles by design (one story per cycle) and owns its own bundles.

**Build branch and worktree names carry the run id.** A story branch is `story/<run-id>/<story-id>` and its worktree
is `.tldrx/worktrees/<repo>/<run-id>-<story-id>`. Without the run id, four runs of one plan all cut `story/S1`; the
second found it already there, `git worktree add` checked it out as it stood, and one run's commits landed on
another's branch — and the fourth walked into the third's LIVE worktree, two sub-agents editing the same files
(measured 2026-08-29). The **epic** branch stays `epic/<slug>`, because an epic is the unit a team merges and a run id
in its name would be worse. Collision there is made DELIBERATE instead: a Build stage refuses to start when
`epic/<slug>` already exists and this run's `run.yml` `build.epic_branch` (optional, additive, §2.2) does not claim
it — `--reuse-epic` is the word that says "stack on it anyway", and either way the branch is recorded as claimed from
then on, so the run's own second invocation is never refused its own branch.

The epic **worktree** is a different object from the epic branch, and it carries the run id for the same reason the
story worktree does: it is `.tldrx/worktrees/<repo>/_epic-<run-id>-<epic-id>`. It was `_epic-<epic-id>` until
2026-08-31, and since every plan names its first epic `E1`, two runs computed the same path — the second found the
first's directory, skipped `git worktree add`, and ran `git merge --no-ff` inside a checkout of ANOTHER run's epic
branch. It never failed: every progress line renders the story's own `epic_branch`, so three stories reported
"merged into `epic/hardening-d1`" while that branch stayed empty and the commits landed on a closed run's epic. On
top of the path, **every reuse of an epic worktree asserts its checked-out branch is the story's epic branch** and
refuses by name when it is not (§5, `WorktreeBranchMismatchError`); it never re-points the worktree and never merges
anyway. The path makes the collision impossible, the assertion makes it impossible to repeat silently.

**Interrupt path (SIGINT / SIGTERM).** A sub-agent is spawned DETACHED — it has to be, or a timeout has no process
group to kill — and a detached child never receives the terminal's Ctrl-C. So the CLI installs one handler
(`src/cli/signals.ts`) and it does four things, in this order: **(1)** kill every spawned child's whole process tree,
stopping the spend before anything else can fail; **(2)** record a PARTIAL `agent.result` on the attempt that was
killed — the envelope's `cost_usd` is `0` because the schema requires a number, and the payload carries
`cost_usd: null` with `stopped_by: "signal"`, because a turn cut in half has no knowable cost and writing `0` would
be a claim; **(3)** demote the `running` stage back to `ready` and release the run's `.lock`; **(4)** exit `130`.
A second signal during that exits immediately. A stage holding an uncommitted `--prepare` bundle is left `running` on
purpose — that work is waiting for a human, not for a process. And a command that owns its own shutdown (`dashboard`,
`watch`) keeps it: with no sub-agent to kill and no run to close, the handler stands aside.

**Getting unstuck.** Two commands, neither of which spends anything:

- **`tldrx run unlock [<run>] [--force]`** removes a `.lock` whose pid is dead, demotes any `running` stage back to
  `ready`, and appends `run.unlocked`. A LIVE holder needs `--force` — "the pid was recycled" and "a colleague is
  running the stage" look identical from here, and only one of them is safe. Without `--force` it exits `2` and names
  the pid.
- **`tldrx run cancel [<run>] --note <text> [--force]`** closes a run for good: every non-terminal stage becomes
  `cancelled`, the decision is recorded on the run itself (`cancelled: {by, at, note}` — optional and additive, §2.2)
  and `run.cancelled` is appended. It refuses while a live lock holds the run unless `--force`. The run-level field is
  what makes the status `cancelled` even when every stage is already terminal — the run people most want to close is
  one whose stage FAILED, and there is no way to say "cancelled" through its stages without overwriting that failure.
  Nothing is deleted: stages, outputs, events and money spent stay on disk and `tldrx replay <id>` still reads them.
  A `cancelled` run is finished (§3.1), so `tldrx status` and every id-less command stop seeing it.

**Resume path.** State lives only in files, so resume = run `next` again: the cursor points at the first non-terminal
stage, a `running` left by a crash is demoted to `ready` when `.lock` holds a dead pid, and partial outputs are
overwritten (stages are idempotent by contract). A task that failed mid-stage may instead be resumed with
`claude --resume <session_id>` when `tasks[].session_id` is set (Appendix A) `[assumption: only for `failed` tasks]`.

**Failure path.** `stage.failed` never advances the cursor and never rolls back cost — money spent is recorded. The
operator's options are `next` (retry, re-spending), `reject --note` (send the stage back to `ready` with the note fed
into the next prompt), or editing the stage inputs by hand and re-running.

### 5.1 Ticket mirror (`tldrx tickets`)

The optional adapter from the concept's v0.2 addendum. It is **not part of the facilitator loop** — it is a separate
command a human runs, it appears in no `stage.yml`, and `tldrx next` never calls it. That separation is the design:
the loop cannot come to depend on a tracker being reachable.

**The two guard-rails, and where each is enforced.**

1. **Files are the source of truth.** `03-plan/epics/*.md` and `03-plan/stories/*.md` are mirrored *out*; the only
   thing that comes back *in* is each issue's own status string, written to `external_status:`. Enforced in
   `src/core/adapters/types.ts`: a provider is exactly `write(input, key)` and `readStatus(key)`. There is no method
   that returns a `PlanStatus`, so remote state has no shape it could take on the way to a story's `status:` field.
2. **Filing a ticket is never "done".** `applyExternal` rebuilds the front matter from the original lines and
   **throws** if the patch would move the `status:` line — the mirror can write `external:` and `external_status:` and
   nothing else. `run.yml` is opened read-only (`RunStore.save()` is never called), so the cursor, the gate and the
   budget are unreachable from this command. Only the DoD hook marks a story done.

**`tldrx tickets sync [--run <id>] [--dry-run] [--provider github|jira]`**

Provider defaults to `process.yml ticket_tool.kind`; `none` (or no `process.yml`) exits `0` with "adapter disabled".
For each epic and then each story, in id order:

1. **Render.** Title is `<id> · <title>`. Body is the title, the story's `acceptance`, its `test_plan` (an epic mirrors
   its `stories:` list instead `[assumption]`), the run-relative path of the file it came from, and a footer line:
   `managed by tldrx — edits here are not read back`. Regenerated every sync, which is why the footer says so.
2. **Create or update.** `external:` absent (or written by a different provider `[assumption]`) ⇒ create; otherwise
   update the stored key. **Idempotent**: a second sync creates nothing and re-uses the key.
3. **Pull, in `two-way` only.** The issue's status string, verbatim, into `external_status:`.
4. **Record.** `external: {provider, key, url, synced_at}` `[assumption: field name]` into the front matter, and one
   `ticket.synced` event (§2.9) per item — `stage: null`, `cost_usd: 0`, since no model ran and a mirror is not a stage.

`--dry-run` prints the same plan and makes **zero** transport calls. A missing credential is caught before `03-plan/` is
read, so a failed preflight leaves nothing half-written.

**Providers.** GitHub goes through the `gh` CLI (`issue create` / `issue edit` / `issue view --json state,url,number`),
so the adapter never handles a token — `gh` already holds the user's auth, and `owner/repo` comes from
`ticket_tool.project`. Jira goes through REST v3 (`POST`/`PUT`/`GET /rest/api/3/issue`) with `JIRA_BASE_URL`,
`JIRA_EMAIL` and `JIRA_API_TOKEN`; missing any of them is exit `1` naming all three, nothing written. Issue type is
`Task` for a story and `Epic` for an epic `[assumption]`, and the body is posted as ADF paragraphs because v3's
`description` is not a string.

Both providers take their transport as an argument (`src/core/adapters/transport.ts`), which is how the suite exercises
the real argv and the real REST shapes without a network: **no test in this repo makes an outbound call or spawns `gh`.**
The HTTP transport is a thin wrapper over the global `fetch` rather than a new method on the §runtime seam, which
offers `spawn` but no HTTP.

**`tldrx tickets status [--run <id>]`**

A table — id, kind, local `status`, `external_status`, remote key and url — with a marker column: `!=` when the two
disagree, `..` when the item has never been synced. It reads two folders and prints. No transport, no write.
Divergence is compared on **done-ness only** (`done`/`closed`/`resolved`/`complete`/`completed`/`shipped`
`[assumption]`): a remote status string is free-form, and a finer comparison would be a mapping nobody configured.

## 6. `--from` distill (importing an AI-DLC intent folder)

`tldrx run new --from <aidlc-intent-dir> [--scope feature]` runs a read-only distill before the run exists.

- **Read:** `intent-statement.md`, `scope-document.md`, `feasibility-assessment.md`, `constraint-register.md`,
  `raid-log.md`, `wireframes.md`, `user-flow.md`, and every answered `*-questions.md` block.
- **Ignored:** market-research, team-formation and approval-handoff ceremony, `aidlc-state.md`, `audit/**`, `memory.md`,
  unanswered question blocks, and anything not in the read list.
- **Source tags:** `[src: aidlc:<file>#Q<n>]` for an answered question, `[src: aidlc:<file>:<line>]` for prose — the
  §2.8 `file` production with a literal `aidlc:` prefix `[assumption]`.
- **Dropped, not imported:** claims whose source line cannot be located in the read set; unanswered blocks; claims
  contradicting a non-retired `facts.yml` row (reported as a conflict and turned into a question in `01-what`).
- **Written:** `01-what/intent.md`, `01-what/scope.md` (distilled prose with tags), `01-what/handoff.md` (Findings =
  imported claims, Unknowns = gaps), and one `fact.added` per imported answer (`kind: answer`, `confidence: stated`).
  The What stage then runs normally, asking only about the gaps.
- **Pilot note:** the leaderboard intent lives inside the docker volume `brainer_brainer-aidlc` at
  `/aidlc-ws/aidlc/spaces/default/intents/260823-scoring-leaderboard`; `docker cp` it to the host before `--from`.

## 6.1 `--seed` import (any document)

`tldrx run new --seed <file|dir> [--scope feature]` is the generic sibling of `--from`: it knows nothing about AI-DLC,
only that a document is Markdown or plain text. Passing both is refused — they write the same `01-what/handoff.md`.
`[assumption]` — the concept doc described no generic importer, so the shape below is this spec's own.

- **Read:** one `.md`/`.txt` file, or every `.md`/`.txt` under a directory, recursive and sorted by path (so two imports
  of the same tree are byte-identical). Bounds: ≤50 files, ≤2 MB per file; the same bounded walk as the map skips
  `.git`, `node_modules`, build output and vendored trees. Anything over a bound is **skipped and named** in
  `seed-index.md`, the handoff's Evidence ledger and on stdout.
- **Not read:** PDF, Word, and every other binary document. A named `.pdf` is an error saying so; ones found inside a
  directory are counted in a warning. Extraction needs a parser, a dependency and a class of silent-corruption bugs
  this framework does not want.
- **Copies nothing.** The originals stay where the team keeps them. The seed path must resolve INSIDE the workspace
  root (tried against the root, then the CWD — first existing wins), because the handoff cites it as
  `[src: <path>:<line>]` and §2.8 resolves a bare `file` src against the root.
- **Source tags:** `[src: <workspace-relative path>:<line>]` — the plain §2.8 `file` production, no prefix. A reviewer
  opens the line the claim came from.
- **Written:** `01-what/seed-index.md` (each document with size and line count, plus Skipped and Warnings sections) and
  `01-what/handoff.md`: Findings = every bullet and paragraph under a heading, plus any heading with nothing under it
  (a heading followed by a *deeper* heading is a container, not an empty section); Decisions = which of the four What
  outputs the seed covers and under which heading; Unknowns = the ones it does not.
- **Unknowns are deterministic.** Each What output (`intent.md`, `scope.md`, `success-metrics.md`,
  `open-questions.md`) has a fixed heading pattern; an output is uncovered when no heading anywhere in the seed matches
  it. Headings only — no prose is interpreted and no model is asked. `[assumption]` — the patterns.
- **No facts are appended.** A document is stated content, not a human answering a question; §2.5 provenance would be a
  lie. `--from` appends facts only for *answered* question blocks, and a seed has none.
- **Declared inputs:** the documents and `seed-index.md` are added to the What stage's `inputs` in `run.yml`, capped at
  §2.3's 20. The stage opts in with `inputs.seed: true`, and `tldrx next` inlines their content into `## Inputs` —
  which is what makes "read nothing else" true rather than aspirational. Over a 64 KB inline budget `[assumption]`,
  `seed-index.md` and a labelled prefix are inlined and the prompt states what was cut; nothing is presented as whole
  when it is not.

## 6.2 Seed triage (`tldrx seed triage` / `tldrx seed apply`)

A seed can be too big for one run. `--seed docs/` on a 25-document design folder makes a single run that pays for
44k tokens of context at every stage of a five-stage workflow, and produces one branch for what was several pieces of
work. Triage is the answer: **count it, propose a split, let a human decide, then create the runs.** Three commands,
and the boundaries between them are the design — the free one never spends, the paid one never creates, and the one
that creates never asks a model. `[assumption]` — the concept doc described no triage, so the shape below is this spec's own.

### The deterministic pass — `tldrx seed triage <path>`

Free, offline, no LLM. Collects the seed with **exactly** the §6.1 rules (`.md`/`.txt`, ≤50 files, ≤2 MB each, depth 8,
same skipped directories, same skip list) and writes `<out>/inventory.md` + `<out>/inventory.json`. Per document:

| Field | How it is decided |
|---|---|
| `rel`, `bytes`, `lines` | off the file |
| `tokens` | `ceil(bytes / 4)` — crude on purpose; it decides "split or not", and 15% either way never changes that |
| `h1`, `h2` | lines matching `^# ` / `^## ` |
| `references` | other seed documents this one points at: a Markdown link whose target resolves to one, **or** a bare mention of its filename |
| `status` | the first `Status:` line's first word, lower-cased — `**Status:** Superseded by ADR-7` ⇒ `superseded` |
| `open_markers` | occurrences of `TODO`, `TBD`, `open question` (case-insensitive) and `??` |
| `code_derived` | distinct path-like, **non-documentation** tokens the document cites, and how many **resolve to a real file** under the workspace root or a repo in `workspace.yml`. `likely` at ≥ 8 `[assumption]` |

`code_derived` is the only judgement, and it is conservative by construction: citing `src/Foo.cs` proves nothing, but
citing eight paths that all exist is a document transcribing code a model can open for itself, and paying for it as
seed is paying twice. Documentation extensions (`.md .txt .markdown .rst .adoc .pdf .doc .docx`) never count — a design
doc linking its siblings is a *reference*, which is already its own column. At most 500 candidate tokens per document
are examined, so the `stat()` cost is bounded.

Then totals and one verdict line, which always names the next command:

```
seed: 25 files, ~44k tokens — above the 20k threshold; run `tldrx seed triage docs/domain-design --propose`
seed: 3 files, ~2k tokens — under the 20k threshold; `tldrx run new --seed docs` will do
```

**Threshold.** `--threshold-tokens <n>` wins; else `seed_triage.threshold_tokens` in `.tldrx/workspace.yml` (additive,
optional, validated as a positive number); else **20,000** `[assumption]`. `--out` defaults to
`.tldrx/triage/<yymmdd>-<basename-slug>/`. `--json` puts `inventory.json`'s bytes on stdout.

**The hint.** `tldrx run new --seed` prints one line on **stderr** — never stdout, which a chat bridge parses — when the
collected seed is over the threshold **or** over 10 files `[assumption]`:

```
note: seed is 25 files / ~44k tokens — `tldrx seed triage docs/domain-design` can propose a split
```

### The model pass — `tldrx seed triage <path> --propose`

ONE sub-agent, spawned exactly as §5 spawns a stage's: same `spawnAgent`, same `--json-schema`, same three execution
modes over the same `.agent/<stage>/` bundle. Defaults: effort `low`, `--max-usd 1.00`, and **no `--model` flag at all**
unless `--model` is given — the CLI's own default applies, which is what `tldrx next` leaves in place for a stage with
no pin. Modes: headless spawns `claude -p`; `--prepare` writes `<out>/.agent/propose/{prompt.md,pending.json}` and
stops; `--commit` reads that directory's `result.json`, taking the proposal from its `proposal` key.

**The prompt** carries the inventory and the documents themselves, under a **120 KB** byte budget `[assumption]`. If
everything fits, everything goes in whole. If not, a quarter of the budget is reserved for digests, small documents are
inlined whole (ascending by size, so the budget buys the most documents it can), and each remaining document gets its
**complete heading list** plus a 2 KB prefix while the reserve lasts. Every truncation is named in the prompt with its
real byte count — a model that thinks it read a 152 KB document and read 2 KB of it will propose a split with great
confidence.

**The output**, validated before anything is written:

```
{ shared_context: [rel], exclude: [{path, reason}],
  runs: [{slug, scope, goal, seeds: [rel], depends_on: [slug], size: "S"|"M"|"L", budget_usd, why: [{claim, src}]}],
  questions: [{id, text, options?}] }
```

| Rule | Checked against |
|---|---|
| `scope` | the workflow stems on disk — `.tldrx/workflows/*.yml` + the shipped `workflows/*.yml`, the two places `run new` looks |
| `seeds`, `shared_context`, `exclude[].path` | the inventory's rel paths, exactly |
| `slug` | `^[a-z0-9][a-z0-9-]{0,39}$`, unique in the proposal (the same regex `run new` uses) |
| `depends_on` | slugs in this proposal, no self-reference, **acyclic** |
| `size`, `budget_usd` | `S\|M\|L`; a number > 0 |
| `why[].src` | the `seed:` grammar below, naming a document in the inventory; a `:line` past the file's end is refused |
| `questions[].id` | `^Q\d{1,6}$` |
| count | ≤ 20 runs, ≥ 1 run, ≥ 1 `why` per run |

Failure is **whole**: exit `5`, nothing written to `split.yml`, the raw answer kept at
`<out>/.agent/propose/result.raw.json`. Half a split is worse than none, because the half that survived looks
authoritative.

#### The `seed:` src grammar

```
seedsrc := "seed:" rel ("#" heading | ":" line)
```

Used by `split.yml`'s `why[].src` and **nowhere else**. It is deliberately not part of §2.8: a handoff's `[src: …]` is
resolved against files that exist inside a run, and a triage claim is about documents no run has yet. Widening §2.8 to
cover that would loosen the one check that keeps handoffs honest. `#` is matched before `:`, so a heading may contain a
colon.

#### `<out>/split.yml`

```yaml
version: 1
status: proposed          # proposed | applied — `apply` acts on `proposed` only
source: docs/domain-design
created_at: 2026-08-30T09:00:00Z
shared_context: ["docs/domain-design/README.md"]
exclude:
  - {path: "docs/domain-design/SOURCE-INVENTORY.md", reason: "code-derived: 40 paths resolve under api/"}
runs:
  - slug: core-entities
    scope: feature
    goal: "Accounts, businesses and locations"
    size: M
    budget_usd: 25.00
    seeds: ["docs/domain-design/docs/03-TENANCY.md"]
    depends_on: []
    why:
      - {claim: "Tenancy bounds every other aggregate", src: "seed:docs/domain-design/docs/03-TENANCY.md#Accounts"}
questions: [{id: Q1, text: "Which currency rounding rule?", options: ["banker's", "half-up"]}]
```

`split.md` is the same content for a human: a table of runs, dependencies as a list, the questions, and the excludes
with their reasons.

**Budget.** `--max-usd` is gated *before* the spawn (below a **$0.25** floor it is refused with exit `2`, because a
cold `claude -p` pays 10–26k cache-creation tokens before its first reply) and reconciled *after* from the real
`total_cost_usd`. As everywhere else in this framework: **`--max-budget-usd` is a stop-after-turn, not a cap.** It
cannot end a turn already in flight, so a run can and does close above its ceiling; the reconciliation says so out
loud. Size the prompt for what you are willing to lose.

`--propose` **never creates a run.**

### The gate — `tldrx seed apply <split.yml>`

The human gate is that you ran this command. Refused unless `status: proposed`. The proposal is validated **again**
here — `split.yml` is a file a human is invited to edit, and an edited scope or a hand-added cycle must be refused by
the command that acts on it. The rel-path universe comes from `inventory.json` beside the split when it is there, and
from the split's own paths when it is not.

Runs are created in **topological order**, stable within a level (among runs whose dependencies are placed, the one
listed first goes first), each through the same `createRun` `tldrx run new` calls, with `--scope`, `--budget` and
`shared_context + seeds` as the repeated `--seed`. Each created `run.yml` gains one optional, additive block:

```yaml
triage: {split: ".tldrx/triage/260830-domain-design/split.yml", depends_on: ["core-entities"]}
```

Absent on every run `run new` creates, so an untriaged `run.yml` is byte-identical to what it was before this section
existed. `run status` does not mention it.

Output: one line per run —

```
created 260830-billing (feature, 4 seeds, depends on: core-entities)
```

— then `split.yml` is rewritten with `status: applied`, `applied_at` and `created_runs`. Because several runs are now
open, §3.1's reminder goes to stderr.

`--dry-run` prints the exact `tldrx run new …` lines, in order, and writes nothing (exit `0`).

**Partial application is a real state and is said out loud.** If a run's directory already exists the apply stops
there, exit `1`, naming the collision *and* the runs already created and left in place; `split.yml` stays `proposed`,
because it describes work that has not all happened. Deleting those run dirs is the operator's call, not the tool's.


## 7. Open decisions

Still open, each with the line that proves it is:

- `process.yml` exists in two shapes: the nested §2.12 form that `init` writes and the flat draft in
  `templates/process.yml` (`ticket_tool: none`, `project_key`, `ticket_sync` as top-level keys); readers tolerate both.
  Reconcile to §2.12 (touches `init` and `test/schemas.test.ts`).
- Whether `.tldrx/` is one root install or also allowed per sub-repo simultaneously (spec assumes root-only in v0).
- Conflict policy when a new answer contradicts a fact **detected by the tool** (auto-supersede vs. always ask). v0
  always asks: `--from` turns a contradiction into a question. What is settled since 2026-08-31 is the case where a
  PERSON reverses their own recorded decision — `tldrx answer <Qn> "…" --supersede` (§3) is the caller
  `FactsStore.supersede` used to lack.
- Retro-proposed stages: acceptance UX and whether they may alter shipped `workflows/*.yml`. `retro` writes the
  proposals and `--apply` appends them to `.tldrx/memory/practices.md` (`src/core/retro/applyPractices.ts`); nothing in
  `src/` reads that file back.
- Multi-approver / enterprise gate packs: out of scope for v0, shape undecided. §5's gate policy is one signer per
  stage, `human` or `auto`.

**Closed since the first draft.** Story/epic/wave file schemas are §2.13–§2.15 (2026-08-30). `dod-gate` still reads
`status:`, `repo:` and the fenced ` ```dod ` block by **line scanning** rather than through the schema, on purpose: a
gate that only ran when the front matter parsed would let a malformed story write `status: done` unchecked. The two
share one ` ```dod ` parser so they cannot disagree about what the block contains.

Ticket adapter direction, and which of Jira/GitHub ships first: **both ship**, and the direction is a field. §2.12's
`ticket_tool.sync` has exactly two values — `mirror-out` pushes and reads nothing back, `two-way` also pulls each
issue's status string verbatim into `external_status:` and into nothing else. §5.1 is the command; `src/core/adapters/`
holds a `gh`-CLI provider and a Jira REST v3 provider, each taking its transport as an argument.

Nested `claude -p` — measured 2026-08-29 (macOS, Claude Code 2.1.x): it works, and the
ceiling was the real constraint, not the nesting. A cold session pays ~10–26k cache-creation tokens before its first
reply, so any `--max-budget-usd` under about $0.25 fails as `error_max_budget_usd` before work starts. At $1.00 the same
call returns `pong` for $0.222; a real `tldrx next --max-usd 0.10` on a one-stage fixture closed at $0.06 on haiku.
`--prepare/--commit` stays because it is *cheaper* and because it is the only mode that works where spawning is
disallowed — not because spawning fails. The narrative version is in README § Design notes.
