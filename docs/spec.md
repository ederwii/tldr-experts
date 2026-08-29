# Spec v0 — file-based AI development workflow framework

Source of truth: `framework-concept-v0.md` (v0 body, v0.1 addendum, Appendix A). Brand `tldr-experts`, CLI `tldrx` (decided 2026-08-28); harness
TypeScript on Bun; host Claude Code. Covers the v0 skeleton and the schema shapes v1 extends without breaking.

- `[assumption]` = the concept doc is silent; the simplest option was taken. Only Claude Code capabilities listed in
  Appendix A are relied on; claims about hook stdin shape, matcher syntax or settings wiring beyond it are marked.
- **Validation budget:** every schema is bounded so a Bun hook can read+parse+validate in <50 ms — one file, no
  cross-file resolution, no network, no globbing; ≤256 KB, ≤2000 nodes, nesting ≤6, anchored non-backtracking regexes.
  `events.jsonl` validates only the appended line. Every schema's first key is `version: 1`; unknown version ⇒ exit 1.

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
│  ├─ 01-what/  handoff.md questions.md intent.md scope.md success-metrics.md [c]
│  ├─ 02-how/   handoff.md questions.md design.md contracts.md risks.md test-strategy.md [c]
│  ├─ 03-plan/  handoff.md waves.yml epics/<id>.md stories/<id>.md [c]
│  ├─ 04-build/ handoff.md log/<story-id>.md [c]
│  └─ 05-watch/ handoff.md watchers/<feature>.md [c]
└─ <repo-a>/ <repo-b>/ …             # sibling product repos; init writes nothing into them
```

`init` appends `.tldrx/graphify-out/`, `.tldrx/cache/`, `tldrx-work/*/.lock`, `tldrx-work/*/.agent/` to `.gitignore` inside an
idempotent `# >>> tldrx >>>` … `# <<< tldrx <<<` block. Single-repo mode: same tree rooted at the repo, `map/self/`,
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
| `stages[].gate` | {type, status, by, at, note} | y | `type` `approve\|checks\|auto`; `status` `pending\|approved\|rejected\|n-a` |
| `tasks[].id` / `.status` | `^t\d+$` / enum | y | One sub-agent invocation |
| `tasks[].session_id` / `.error` | str\|null | y | Session from `claude -p --output-format json`; one-line reason when `failed` |

**Validation.** Ids unique within parent; `cursor` resolves; ≤1 `running` stage (single-writer); `|spent_usd −
Σ tasks.cost_usd| ≤ 0.01`; `started_at ≤ ended_at`; `approved` needs `by`+`at`; ≤5 phases, ≤40 stages, ≤200 tasks.

### 2.3 `.tldrx/stages/<slug>/stage.yml` + `stage.md`

A stage is a folder: `stage.yml` is the contract the facilitator executes, `stage.md` the prompt body. Add a folder, list it in a workflow, done.

```yaml
version: 1
id: contracts
title: "API, DTO and event contracts"
phase: 02-how
experts: [architect]
stack_experts: true
model: sonnet
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
```

| Field | Type | Req | Meaning |
|---|---|---|---|
| `id` / `title` / `phase` | slug / str / `^0[1-5]-` | y | Identity and owning phase |
| `experts` | slug[] | y | Expert folders loaded; empty ⇒ facilitator runs it inline |
| `stack_experts` / `model` | bool / str | n (`true`) / y | Also load stack expertise for `run.repos`; per-stage model pin (Appendix A) |
| `budget_usd` | number >0 | y | Stage ceiling and the sub-agent's `--max-budget-usd` share |
| `timeout_s` / `dry_run_allowed` | int >0 / bool | n (900 / `true`) | Wall clock for sub-agent and `cmd` checks `[assumption]`; `--dry-run` writes the handoff only |
| `inputs.required` / `.optional` | path[] | y / n | **The only files the sub-agent gets**; `{repo}` expands per repo |
| `inputs.seed` | bool | n (`false`) | Also give this stage **the run's seed documents**, whatever `run new --seed` recorded for it in `run.yml` (§6.1) `[assumption]` |
| `outputs[].path` / `.sections` | rel path / str[] | y | File written; H2 headings that must exist and be non-empty |
| `questions` | {path, max} | n | Interview file and question cap |
| `gate.type` / `.approvers` | `approve\|checks\|auto` / int ≥1 | y / n (1) | Human stop / checks only / no stop |
| `checks[].id` / `.on` | `claim-sources\|schema\|cmd\|dod` / `pre-write\|post-write` | y | Built-in check id and when it runs |
| `checks[].repo` / `.command` / `.expect_exit` | slug / str / int | y for `cmd` | Command must equal a `workspace.yml` command verbatim |

**Validation.** `id` = folder name; `budget_usd` ≤ the phase ceiling; `cmd` commands must match `workspace.yml` (no
arbitrary shell from a stage file); expert folders are checked by `doctor`, not the write hook; ≤20 inputs,
≤10 outputs, ≤10 checks. The 20-input cap counts seed documents too — `run new --seed` stops declaring at 20, and the
facilitator stops inlining at 20.

**`inputs.seed`.** A stage cannot name the run's seed documents: they differ per run. So it opts in
(`inputs: {seed: true, …}`) and the facilitator reads the list off `run.yml` — the entries `run new --seed` added to
that stage's `inputs` beyond what the stage file declares. An unseeded run simply has none, and the stage runs from its
ordinary inputs. This replaces the What stage's old placeholder input, the literal string
`"<free text, a PRD, any document, or a Jira epic>"`, which was prose no code could act on: measured 2026-08-29, a
seeded What prompt inlined zero of the documents it was started from. `[assumption]` — the v0 skeleton validator still
requires `inputs` to be an array (`src/core/schemas/stage.ts`), so the shipped `stages/what/stage.yml` writes the same
flag as a top-level `seed: true` beside an array `inputs:`; the loader accepts both spellings.

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
gates: {collapse: false}
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
| `default_budget_usd` / `gates.collapse` | number >0 / bool | y / n (false) | Run ceiling when `run new` gives none; `true` ⇒ one gate at run end (hotfix) |
| `questions.suppress_areas` / `dod.add` / `dod.remove` | slug[] / str[] / str[] | n | Areas this scope must not ask about; deltas over the default DoD |
| `stages[].id` / `.phase` | slug / `^0[1-5]-` | y | Stage folder; file order = execution order |
| `stages[].budget_usd` | number >0 | n | Overrides `stage.yml` |
| `stages[].skip_if` | str | n | `^(stories\|repos\|questions)(<=\|>=\|==\|<\|>)\d{1,4}$` `[assumption]` |

**Validation.** `name` = filename stem; stage ids unique and present in `.tldrx/stages/`; Σ `budget_usd` ≤
`default_budget_usd`; `skip_if` matches the pattern above; ≤40 stages.

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
| `fact` | str ≤300 | y | One assertion, present tense, no hedging |
| `area` / `repos` | slug / slug[] | y | Matching key for the no-re-ask hook; scope (empty = workspace-wide) |
| `kind` / `confidence` | `answer\|observed\|derived` / `measured\|inferred\|stated` | y | Human answer, check output or stage conclusion; evidence class |
| `source.who` / `.when` | str / RFC3339 | y | Human id or expert slug; capture time |
| `source.run` / `.q` | run id\|`init` / `^Q\d+$`\|null | y | Where learned; originating question |
| `supersedes` / `superseded_by` | fact id\|null | y | Single-link chain, reciprocal |
| `retired` | {at, by, reason}\|null | y | Ignored by no-re-ask, kept for replay |

**Validation.** Ids unique and ascending; supersede links reciprocal and resolvable within this file; no fact both
superseded and retired; ≤5000 facts (beyond that `tldrx` shards by `area`).

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
     evidence: [{kind: code, src: "api:src/Scavtopia.Infrastructure/Persistence/AppDbContext.cs:41", at: 2026-08-20},
                {kind: run, src: "tldrx-work/260812-scores/04-build/log/S3.md", at: 2026-08-12},
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
| `areas[].evidence[].{kind,src,at}` | `code\|run\|doc\|answer` / src token (§2.8) / `YYYY-MM-DD` | y | Evidence class, citation (must satisfy the grammar), date produced |

**Level formula** (deterministic, integer table). Per evidence item aged `d` days: `recency = 1.0 (d≤30) · 0.6 (≤90) ·
0.3 (≤365) · 0.1 (else)`; `weight = code 1.0 · run 1.0 · answer 0.8 · doc 0.5`; `W = Σ recency·weight`.
`level = 0 if W<0.5 · 1 if <1.5 · 2 if <3 · 3 if <6 · 4 if <12 · else 5`. **Staleness cap:** newest evidence older than
180 d ⇒ `level = min(level, 2)`. **Distinct-source cap:** `level ≤ count(distinct src)`.

**Validation.** `level` equals the formula output (recomputed at write; mismatch rejected); every `src` matches the
grammar; ≤60 areas, ≤50 evidence items per area.

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

### 2.8 `tldrx-work/<run>/<phase>/handoff.md` + the `src` grammar

One handoff per stage: what was found, decided, still unknown, and the ledger a reviewer can re-run. **Every bullet in
all four sections ends with a `[src: …]` token.**

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

**Validation.** The four sections present in that order; **every list item** inside them ends with a valid token —
`- item`, `1. item` and `1) item` all count, and an item runs to the next line that starts at column 0, so a
soft-wrapped citation on an indented continuation line still counts. An ordered marker is only a marker at column 0
(`…global since` / `  2019. That has not changed` is one wrapped item, not two). `file` paths exist with the line in
range; `cmd` tokens only in `Evidence ledger`; `doc` requires https; ≤200 items.

**Resolving a `file` src.** A `repo:path` resolves inside that repo, and an absolute path is taken as written. A bare
`path` is tried against three bases, in order — **first existing wins**: (a) the workspace root; (b) the run directory of
the handoff being validated (`tldrx-work/<run>/`, so a stage may cite its own outputs as `01-what/intent.md:1`); (c) only
when the path starts with a known repo name followed by `/`, that repo's directory with the name stripped —
`api/src/Hunt.cs` is a spelling of `api:src/Hunt.cs`. The line range is checked against whichever file resolved, and a
failure names every base it tried. `tldrx next`, `tldrx approve` and the `claim-sources` hook resolve identically: all
three are handed the run directory of the file they are judging.

### 2.9 `tldrx-work/<run>/events.jsonl`

Append-only audit log: with `run.yml` the dashboard's only data source, the cost ledger, and the `replay`/`retro` input.

**Type enum:** `run.created` `run.closed` `phase.started` `phase.done` `stage.started` `stage.done` `stage.failed`
`stage.skipped` `task.started` `task.done` `agent.spawned` `agent.result` `question.asked` `question.answered`
`gate.requested` `gate.approved` `gate.rejected` `check.passed` `check.failed` `budget.warned` `budget.blocked`
`fact.added` `fact.retired` `map.refreshed` `error`. Closed set: an unknown type is a validation error.

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
| `phases[].{id,ceiling_usd,spent_usd}` | slug / number ≥0 | y | Per-phase ceiling and rolled-up actual |

**Validation.** Σ phase ceilings ≤ `ceiling_usd`; every phase id appears in `run.yml`; `spent_usd ≤ ceiling_usd` per
phase unless `on_exceed: warn`; ≤5 phases.

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

## 3. CLI surface

Exit codes: `0` ok · `1` usage/schema error · `2` refused by a gate · `3` not found · `4` awaiting human · `5` agent failed.

| Command | Reads | Writes | Exit |
|---|---|---|---|
| `tldrx init [--stack <a,b>]` | cwd tree, git dirs, package/build files, `env.yml` | `workspace.yml` (incl. `mode: greenfield`), `map/**`, `conventions/**`, `experts/*/` (always a `product`, one `<lang>-stack` per detected **or declared** language), `facts.yml`, `.gitignore`, `CLAUDE.md` pointer | 0,1 |
| `tldrx doctor` | `env.yml`, `workspace.yml`, `.tldrx/stages/**`, `.claude/settings.json` | `env.yml.result`, `cache/doctor.json` | 0,1 |
| `tldrx run new [--from <path>\|--seed <path>] [--scope <s>] [--budget <usd>]` | `workflows/<s>.yml`, `workspace.yml`, `facts.yml`, the `--from` source (§6) or the `--seed` documents (§6.1) | `tldrx-work/<run>/{run.yml,budget.yml,events.jsonl,01-what/*}`; `--seed` also writes `01-what/seed-index.md` and declares the documents as What inputs | 0,1 |
| `tldrx run status [<run>]` | `run.yml`, `events.jsonl` | nothing (stdout) | 0,3 |
| `tldrx next [<run>] [--dry-run]` | `run.yml`, `stage.yml`, `stage.md`, `expert.md`, declared inputs | stage outputs, `run.yml`, `events.jsonl` | 0,2,4,5 |
| `tldrx answer <Qid> <text>` | `questions.md`, `facts.yml` | `questions.md`, `facts.yml`, `events.jsonl` | 0,1,3 |
| `tldrx approve [<run>] [--note]` | `run.yml`, stage outputs, stage checks | `run.yml` gate, `events.jsonl` | 0,2,3 |
| `tldrx reject [<run>] --note <text>` | `run.yml` | `run.yml` gate, `events.jsonl`, stage status ⇒ `ready` | 0,3 |
| `tldrx map --refresh` | `workspace.yml`, repos, `graphify-out/` | `map/**`, `graphify-out/`, `events.jsonl` | 0,1 |
| `tldrx map --check` | `map/**` citations, filesystem | `cache/map-drift.json` (stdout report) | 0,1 |
| `tldrx expert list` | `experts/*/competencies.yml` | nothing (stdout star chart) | 0 |
| `tldrx expert create <name>` | `workspace.yml`, `map/**` | `experts/<name>/{expert.md,competencies.yml}` | 0,1 |
| `tldrx expert train <name> [--area <a>] [--mode light\|full]` | `expert.md`, repo code, past runs | `knowledge/*.md`, `competencies.yml`, `events.jsonl` | 0,1,5 |
| `tldrx dashboard [--static]` | `tldrx-work/**`, `.tldrx/**` (watch) | nothing, or `dist/` with `--static` | 0,1 |
| `tldrx replay <run>` | `events.jsonl`, handoffs | nothing (stdout narrative) | 0,3 |
| `tldrx retro <run>` | `run.yml`, `events.jsonl`, handoffs | `retro.md`, `stages/proposed/**`, `practices.md` proposals | 0,3 |

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

| Hook | Event | Trigger | Decision logic | Effect |
|---|---|---|---|---|
| `claim-sources` | PreToolUse (`Write\|Edit`) | `tool_input.file_path` matches `tldrx-work/**/*.md` | Compute the would-be content; parse the four handoff sections; each list item must end with a valid `src` token (§2.8); `file` sources must resolve against the workspace root, the run dir, or a named repo | Denies (JSON) listing offending line numbers; a PostToolUse twin re-checks and feeds back only |
| `no-re-ask` | PreToolUse (`Write\|Edit`) | `tool_input.file_path` matches `tldrx-work/**/questions.md` | Tokenise each new question heading + `area`; compare against non-retired `facts.yml` rows; Jaccard ≥ 0.6 on ≥4-char tokens ⇒ hit `[assumption]` | Denies the write, names the matching fact |
| `answer-capture` | PostToolUse + FileChanged | `tldrx-work/**/questions.md` | Find blocks with `status: open` and a non-empty `[Answer]:` capture | Never blocks; writes footer + `facts.yml` + `question.answered`; echoes one line to stdout as context |
| `DoD-gate` | PreToolUse (`Write\|Edit`) | would-be content of `tldrx-work/**/stories/*.md` sets `status: done` | Re-run every command in the story's fenced ```dod block, in its repo, with `stage.yml timeout_s`; all must exit 0 | Denies if any command fails or the block is missing (this hook is not <50 ms by design) |
| `budget-gate` | PreToolUse (`Bash`) | `tool_input.command` matching `^(claude -p|tldrx next)` | `spent + estimate > phase ceiling` (or run ceiling) and `on_exceed: block` | Denies the spawn; appends `budget.blocked` |
| `session-start-status` | SessionStart | always | Read the newest non-terminal `run.yml` | Never blocks; injects a 3-line "where we are" via `additionalContext` |
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
estimate is $3.00. Raise phases[02-how].ceiling_usd in budget.yml, lower budget_usd in
.tldrx/stages/contracts/stage.yml, or set on_exceed: warn.
```

Statusline renderer uses `model.display_name`, `cost.total_cost_usd`, `context_window.used_percentage`,
`worktree.branch`, `session_id` from the statusLine JSON (Appendix A) plus `run`, `cursor`, phase progress and
`budget.ceiling_usd` from `run.yml`, and prints:
`[tldrx] 260828-leaderboard · 02-HOW [▓▓░░░] 2/5 > contracts — architect | Sonnet ctx:16% $3.75/$25`

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
  if b.phase(st).remaining < sy.budget_usd and b.on_exceed == block: append(budget.blocked); exit 2
  if any(!exists(i) for i in sy.inputs.required): exit 1
  inputs = sy.inputs.required + present(sy.inputs.optional)          # ONLY these files
  prompt = render(stage.md, {run, repos, inputs, facts: grep(facts.yml, sy.area/r.repos), conventions,
           budget_usd}) + concat(expert.md for sy.experts) + stack_experts(r.repos)
  st.status = running; write(run.yml); append(stage.started)
  for task in tasks_of(sy):                        # 1 per output group; parallel iff independent
     append(agent.spawned)
     res = sh(claude -p --output-format json --model <sy.model> [--worktree]
              --max-budget-usd <min(task_share, b.per_agent_max_usd)> <<< prompt + task)
     record(task, res.total_cost_usd, res.session_id, res.usage); append(agent.result, cost)
     if res.exit != 0 or res.is_error: goto FAIL
  for out in sy.outputs: if !exists(out.path) or !has_sections(out): goto FAIL  # re-read from disk
  for c in sy.checks: run(c); append(check.passed|check.failed); if failed: goto FAIL
  if dry_run: revert non-handoff outputs; append(stage.skipped); exit 0
  st.cost_usd = Σ tasks; roll_up(b); st.status = done
  if sy.gate.type == approve: st.status = awaiting_gate; append(gate.requested); write; exit 4
  advance_cursor(); write(run.yml); append(stage.done); exit 0
FAIL: st.status = failed; st.error = first_error; write(run.yml); append(stage.failed); exit 5
```

**Decisions (2026-08-28).** (a) Stage artefacts are Markdown validated by hooks (human-readable handoffs); the
sub-agent's *result envelope* is structured via `--json-schema` (`{outputs: [], questions_asked: [], notes: ""}`) so
`next` parses deterministically. (b) Map providers: `graphify` first; when absent, `map --refresh` falls back to a
`static` provider (git log, file tree, package manifests) and records `provider:` in `workspace.yml` — the framework
degrades, never installs. (c) Parallelism: v0 runs tasks sequentially; v1 runs independent stories of one wave in
parallel, one worktree per story.

**Two execution modes (same files, same validation).** *Headless*: `tldrx next` spawns `claude -p` itself — for
terminals, CI and chat bridges. *In-session*: when the user is already inside Claude Code, the `/tldrx` skill runs
`tldrx next --prepare` (writes the prompt bundle + declared inputs to `.agent/prompt.md`), Claude Code dispatches the
sub-agent with its own Agent tool, then `tldrx next --commit` validates outputs, checks, cost and gates exactly as the
headless path does. A nested `claude -p` from inside a Claude Code Bash tool is **verified working** (2026-08-29, see
§7); the in-session mode exists because it is cheaper and because it is the only mode that survives where spawning is
disallowed, not because spawning fails.

**Resume path.** State lives only in files, so resume = run `next` again: the cursor points at the first non-terminal
stage, a `running` left by a crash is demoted to `ready` when `.lock` holds a dead pid, and partial outputs are
overwritten (stages are idempotent by contract). A task that failed mid-stage may instead be resumed with
`claude --resume <session_id>` when `tasks[].session_id` is set (Appendix A) `[assumption: only for `failed` tasks]`.

**Failure path.** `stage.failed` never advances the cursor and never rolls back cost — money spent is recorded. The
operator's options are `next` (retry, re-spending), `reject --note` (send the stage back to `ready` with the note fed
into the next prompt), or editing the stage inputs by hand and re-running.

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
`[assumption]` — the spec had no generic importer; this is wave 4B.

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

## 7. Open decisions

- Whether `.tldrx/` is one root install or also allowed per sub-repo simultaneously (spec assumes root-only in v0).
- Story/epic file schemas (`stories/<id>.md`, `epics/<id>.md`, `waves.yml`) — v1 Execute, not specified here. The DoD
  gate reads `status:`, `repo:` and the fenced ```dod block by line scanning precisely because the shape is not settled.
- Conflict policy when a new answer contradicts a fact (auto-supersede vs. always ask). v0 always asks: `--from` turns a
  contradiction into a question and `FactsStore.supersede` is only ever called by hand.
- Retro-proposed stages: acceptance UX and whether they may alter shipped `workflows/*.yml`. `retro` writes the proposals
  and `--apply` appends them to `practices.md`; nothing consumes them yet.
- Ticket adapter direction (mirror-only vs. two-way) and which of Jira/GitHub ships first.
- Multi-approver / enterprise gate packs: out of scope for v0, shape undecided.

**Closed since the first draft.** Nested `claude -p` — measured 2026-08-29 (macOS, Claude Code 2.1.x): it works, and the
ceiling was the real constraint, not the nesting. A cold session pays ~10–26k cache-creation tokens before its first
reply, so any `--max-budget-usd` under about $0.25 fails as `error_max_budget_usd` before work starts. At $1.00 the same
call returns `pong` for $0.222; a real `tldrx next --max-usd 0.10` on a one-stage fixture closed at $0.06 on haiku.
`--prepare/--commit` stays because it is *cheaper* and because it is the only mode that works where spawning is
disallowed — not because spawning fails. The narrative version is in README § Design notes.
