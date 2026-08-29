# Concept v0 — a lightweight, file-based AI development workflow

Name: **tldr-experts** — CLI `tldrx` (decided 2026-08-28). Open source, tool-agnostic, Claude Code pilot.

Everything below is a proposal. Platform facts it relies on are in Appendix A (verified from official docs by research agents); nothing else is verified.

---

## 0. The one-line reframing

> **One loop, five phases, everything on disk.**
> Every phase is the same loop — *Investigate → Handoff → Interview → Gate* — run by a
> facilitator that only ever reads and writes files. The files ARE the state, the
> dashboard, the resume point, and the memory.

This is the thing AI-DLC has 33 stages, 16 hooks and 14 agents to approximate. The loop
is the primitive; phases are just the loop with different inputs, outputs and experts.

## 1. Principles (the non-negotiables)

1. **Deterministic harness, evidence-gated model.** An LLM cannot be made deterministic.
   What *can* be: state transitions, file schemas, what gets loaded, what counts as done.
   So: the harness is code (small CLI + hooks); the model only fills templates and must
   cite evidence for every claim (`file:line`, doc URL, or `Q<n>` answer id). A claim
   without a source is rejected by a hook, not by a prose rule.
2. **Never ask what you already know.** Before any question is posed, the facilitator
   greps `memory/facts.yml`. Re-asking a known fact is a *test failure* of the framework.
3. **Non-intrusive.** Ambient footprint in a project = one CLAUDE.md pointer (~10 lines),
   one statusline, one SessionStart hook that prints "where we are". Everything else
   loads only when `/tldrx …` is invoked.
4. **Best practices, not a pattern.** Conventions are *discovered* at install, merged
   with sane defaults (tests per story, one class per file, low cyclomatic complexity,
   reusable over clever), written to `conventions.md`, and enforced at Execute time.
5. **Budget is a first-class input.** Every phase/stage has a ceiling; the facilitator
   refuses to start work it cannot afford.
6. **Read-only dashboard, file-backed.** Nothing is launched from the UI. It renders
   what the framework writes.

## 2. The loop (the only primitive)

```
Investigate  → expert/sub-agents read code, docs, memory; write findings WITH sources
Handoff      → one .md per stage: what was found, what was decided, what is unknown
Interview    → ONLY the unknowns become questions (A/B/C + free text); answers are
               captured to facts.yml by a hook, with provenance (who/when/run)
Gate         → human approves / requests changes; recorded in run.yml + events.jsonl
```

Same loop at install, at every phase, and inside Execute per story (where "Interview"
usually has zero questions and "Gate" is tests-green + review).

## 3. The five phases

| # | Phase | Input | Output (files) | Default experts |
|---|---|---|---|---|
| 1 | **What** | a phrase, a PRD, any doc, a Jira epic | `intent.md`, `scope.md` (in/out, MoSCoW), `success-metrics.md`, `open-questions.md` | product, domain expert(s) |
| 2 | **How** | phase-1 files + code map | `design.md` (placed on real files/modules), `contracts.md` (APIs/DTOs/events), `risks.md`, `test-strategy.md` | architect, domain expert(s), stack experts |
| 3 | **Plan** | phase-2 files | `epics/<epic>.md`, `stories/<id>.md` (AC + test plan + touched files), `waves.yml` (dependency-ordered batches), `budget.yml` | delivery, architect |
| 4 | **Execute** | waves.yml | per story: branch, commits, tests, `stories/<id>.md` updated with evidence; per epic: epic branch + integration test log | developer (+ stack experts), reviewer |
| 5 | **Observe** | shipped stories | `watchers/<feature>.md`: signal that proves it works, where to look, what "broken" looks like, alert/query snippets | operations |

Phase 1 must accept "start from a phrase" **and** "start from a document" — the
investigate step reads the doc, extracts claims + gaps, and asks only about the gaps.

## 4. Install / onboard (`/tldrx init`)

Runs the loop once against the whole workspace:

1. **Detect**: repos (incl. sibling git repos), languages, frameworks, build/test/lint
   commands, CI, package managers. Written to `workspace.yml`.
2. **Map** (code knowledge base): run the code-map tool (graphify — see Appendix A)
   and produce the human/AI-readable set:
   `map/architecture.md`, `map/domains.md`, `map/conventions.md`, `map/commands.md`,
   `map/hotspots.md` (high-churn/high-complexity), `map/gotchas.md` (from git log +
   comments). Every bullet cites a path.
3. **Handoff**: `install-handoff.md` — what was found, confidence per area, what could
   not be inferred (owners, dead code, prod facts, business rules).
4. **Interview** (optional, user can skip): only the gaps. Answers → `memory/facts.yml`.
5. **Seed experts**: one *stack expertise* per language/framework found (shared by all
   experts), one *domain expert* per detected domain, status `created`.
6. **Write conventions**: defaults + discovered.

Re-runnable; `--refresh` runs graphify `--update` (incremental; multi-repo via `merge-graphs`) and drift-checks every `map/*.md` citation against the filesystem.

## 5. Project layout (files are the API)

```
<workspace>/
  .tldrx/                          # framework, gitignored where machine-local
    workspace.yml               # detected repos/stack/commands
    map/                        # code knowledge base (§4)
    memory/
      facts.yml                 # durable facts: {id, fact, source: {who, when, run, q}}
      practices.md              # how-we-work rules learned from retros
    experts/<name>/
      expert.md                 # role, domain, how to reason, what to cite
      competencies.yml          # {area, level 0-5, evidence: [...], last_trained}
      knowledge/*.md            # trained material with provenance
    stages/<slug>/              # customizable stage library
      stage.md                  # prompt/template
      stage.yml                 # inputs, outputs, gate, checks, budget, experts
    workflows/<name>.yml        # which stages, in which order (default: the 5 phases)
  tldrx-work/<yymmdd>-<slug>/      # one folder per piece of work (committed)
    run.yml                     # THE execution path: phases→stages→tasks, status, agent,
                                # model, cost, inputs, outputs, timestamps, budget
    events.jsonl                # append-only log (gate, question, answer, cost, error)
    01-what/  02-how/  03-plan/  04-execute/  05-observe/
      handoff.md  questions.md  <artifacts>
    retro.md                    # written at close; may propose new stages
```

`run.yml` + `events.jsonl` are the dashboard's only data source and the resume point.

## 6. Experts

**v1 (minimal, ships with init):** experts are *files* (`expert.md` + `competencies.yml`).
Status: `created → training → in-use → inactive`. The facilitator loads an expert only
when a stage's `stage.yml` names it.

**v1.1 (training):**
- *Light*: targeted reverse-engineering of the expert's domain (business rules, invariants,
  entry points) → `knowledge/*.md` with `file:line` provenance.
- *Full*: light + mining past sessions: "From the last N active dev days in <domain>,
  which recurring decisions/patterns should become standard practice?" → proposals the
  user accepts into `knowledge/` or `practices.md`.
- *Areas of expertise*: `competencies.yml` entries (e.g. `oauth`, `google-maps-sdk`).
  Level is **computed** from evidence count + recency, never self-declared. Star chart =
  this file rendered. Each area exposes a copy-paste "train me on X" prompt.
- *Stack expertise* (from install) is shared by every expert by default.

## 7. Facilitator and agents

- `/tldrx` is the facilitator: reads `run.yml`, decides the next stage, spawns one
  sub-agent per task (expert prompt + stage prompt + only the files that stage declares),
  writes results back to files, updates `run.yml`/`events.jsonl`, stops at gates.
- Sub-agents are stateless by design; everything they learn goes to files before they end.
- Model policy lives in `stage.yml` (`model: opus|sonnet|…`), so cost is tunable per stage.
- Interaction channel is pluggable: terminal (v1), chat bridge (Pumble/Slack) later —
  the questions file is the contract, not the channel.

## 8. Determinism & anti-hallucination toolkit (what is actually enforceable)

| Mechanism | How |
|---|---|
| Claim sources | PostToolUse hook on `tldrx-work/**/*.md`: every bullet in Findings/Decisions must carry `[src: …]`; else the write is rejected with the offending lines |
| No re-ask | PreToolUse hook on `questions.md` writes: reject a question whose subject matches a `facts.yml` entry |
| Done means proven | A story cannot move to `done` unless `stories/<id>.md` contains a fenced command block **and** the hook re-ran it with exit 0 (test + lint + typecheck from `map/commands.md`) |
| Live docs | Context7 MCP (library docs) + WebFetch of official docs, required for any claim about an external API; cite URL |
| Verify from source | Stage checks re-read outputs from disk/DB/API, never trust the agent's own "ok" |
| Schema validation | `run.yml`, `stage.yml`, `facts.yml`, `competencies.yml` validated on every write |
| Cost ledger | Sub-agents run via `claude -p --output-format json`; `total_cost_usd` + `usage` + `session_id` are recorded into `events.jsonl`. Interactive sessions read `cost.total_cost_usd` from the statusLine payload |
| Budget gate | Refuse stage start if `remaining < estimate`; every sub-agent launched with `--max-budget-usd <its share>` so a runaway agent cannot eat the phase |

## 9. Execute phase details

- `waves.yml`: stories grouped by dependency; wave N+1 starts only when wave N's epic
  branch is green.
- Branching: `epic/<epic>` ← `story/<id>` worktrees. Story merges to epic on green; epic
  merges to main after integration tests + human gate.
- Definition of Done per story: AC met with evidence, unit tests added and green, lint +
  typecheck green, conventions check, reviewer sub-agent sign-off, `stories/<id>.md` updated.
- Parallelism: independent stories in the same wave run as parallel sub-agents in separate
  worktrees.

## 10. Observability (phase 5, concrete)

`watchers/<feature>.md` per shipped feature: the log line / metric / query that proves it
works, where it lives, the "healthy" baseline, what "broken" looks like, and a copy-paste
query. Generated from what Execute actually instrumented — not aspirational.

## 11. Budget & live metrics

- `budget.yml` per run: ceiling per phase; actuals rolled up from `events.jsonl`.
- Statusline (Claude Code native `statusLine`) rendering:
  `[fw] <run> · <PHASE> [▓▓░░] 2/5 > <stage> — <expert> | <model> ctx:16% $4.92 / $25`
  All fields available natively: `model.display_name`, `cost.total_cost_usd`, `context_window.used_percentage`, `context_window.total_input/output_tokens`, `worktree.branch` (Appendix A).

## 12. Dashboard (read-only)

- Tiny Bun server: watches `tldrx-work/**` + `.tldrx/**`, serves a single-page UI, pushes
  changes over SSE → auto-refresh. No writes, no launch buttons.
- Views: open runs + status/phase/budget; run detail (execution path from `run.yml`,
  handoffs rendered, questions pending); experts (status + star chart + "train me"
  prompts); FAQ / how-to with copy-paste prompts to start or continue any run.
- Static export (`fw dashboard --static`) for sharing a snapshot.

## 13. Learning loop

- Answers → `facts.yml` (with who/when/run). Facts are re-used across runs and projects.
- Retro at run close: `retro.md` with 3 sections — what to remember (→ facts), how to work
  differently (→ practices.md), what stage to add/change (→ `stages/proposed/`).
- Proposed stages are inert until the user accepts them.

## 14. Customization

- A stage is a folder; a workflow is a yml listing stages. Add a folder, list it, done.
- Templates and defaults (conventions, DoD, question style) are overridable per project.
- Stack/domain experts and stages can be shared as plain folders (no registry needed).

## 15. Extras worth adding (my additions)

1. **Doc mode**: `fw doc <question>` — answer from `map/` + code with citations, no run.
2. **Drift check**: `fw map --check` — flags map entries whose cited paths no longer exist.
3. **Dry run**: any stage with `--dry-run` produces the handoff without writing decisions.
4. **Replay**: `fw replay <run>` renders `events.jsonl` as a narrative (stakeholder view).
5. **Import**: `fw run new --from <PRD|Jira epic|aidlc intent folder>` — the leaderboard
   ideation pack becomes the pilot's phase-1 input without redoing 38 questions.
6. **Ticket sync (optional adapter)**: epics/stories mirrored to Jira/GitHub issues.
7. **Session cost cap per sub-agent** as well as per phase (a runaway agent should not
   eat the phase budget).

## 16. Delivery slices

- **v0 (skeleton)**: `fw init` (detect + map + handoff + interview), `run.yml` +
  `events.jsonl`, facilitator skill, phases 1–3, statusline, claim-sources hook, no-re-ask
  hook. Dashboard = static render.
- **v1**: Execute with worktrees/epic branches/waves + DoD hook, Observe, budget gate,
  live dashboard, retro loop.
- **v1.1**: expert training (light/full), competencies + star chart, ticket adapter,
  chat channel adapter.

## 17. Open questions (decision-changing)

1. Repo name/location and license (new sibling repo outside scavtopia?).
2. Pilot: dogfood on scavtopia (3 repos, Azure) with the leaderboard pack as the phase-1
   input — or a smaller single-repo project first?
3. Experts in v0 as "files only", training deferred to v1.1 — acceptable?
4. Harness language: TypeScript on Bun (matches what you already run) — confirm.
5. Interaction: terminal-only for v0; Pumble bridge as a later adapter — confirm.

---

## Appendix A — Verified primitives (reported by research agents from official docs; URLs inline)

**Claude Code** (code.claude.com/docs — statusline, hooks-guide, headless, skills, sub-agents, plugins, worktrees, memory):
- `statusLine` stdin JSON carries `model`, `cost.total_cost_usd`, `context_window.used_percentage` + token totals, `worktree`, `session_id` → the live metrics line needs no custom accounting.
- Hooks: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, SubagentStart/Stop, Stop, FileChanged, WorktreeCreate/Remove, PreCompact, SessionEnd (and more). Exit code 2 blocks; PreToolUse can `deny`; stdout / `additionalContext` injects context → claim-sources, no-re-ask and DoD gates are all buildable as hooks.
- `claude -p --output-format json` returns `total_cost_usd`, `usage`, `session_id`; `--resume` works headless; `--max-budget-usd` exists → per-agent cost caps are native.
- Skills: `disable-model-invocation: true` = loaded only on explicit `/tldrx …` → the non-intrusive requirement is native.
- Subagents: `model:` pin (e.g. opus) and `isolation: worktree`; native `--worktree` / `EnterWorktree`.
- Plugins: `.claude-plugin/plugin.json` + `skills/ agents/ hooks/ .mcp.json`; install with `--plugin-dir` → the framework ships as one plugin.
- Memory: files only (`~/.claude/projects/<repo>/memory/`), no API → our `facts.yml` is the right layer.
- Hook payloads (hooks.md, verified 2026-08-28): PreToolUse gets `tool_name`, `tool_input` (`file_path`, `content` |
  `old_string`/`new_string`), `tool_use_id`; PostToolUse adds `tool_result`; Stop adds `last_assistant_message`.
  **Only PreToolUse can block** (JSON `permissionDecision: deny`); PostToolUse is feedback-only. Matchers: literal
  `Write|Edit`, regex when special chars present, file globs like `Edit(*.md)`. Plugin `hooks/hooks.json` shape
  `{hooks: {Event: [{matcher, hooks: [...]}]}}`; scripts via `${CLAUDE_PLUGIN_ROOT}`.

**graphify** (v0.8.37, installed locally; `~/.claude/skills/graphify/`):
- Deterministic tree-sitter AST extraction for code (no LLM tokens for code-only corpora); C#, TS, JS, Python… supported.
- Outputs `graphify-out/graph.json` (nodes/edges with `EXTRACTED|INFERRED|AMBIGUOUS` confidence), `GRAPH_REPORT.md`, `graph.html`.
- Incremental `--update`, post-commit hook, `--watch`; multi-repo via `merge-graphs` (node tagged with `repo`).
- Agent-callable: `--mcp` exposes `query_graph, get_neighbors, shortest_path, god_nodes, graph_stats`; `affected` gives reverse impact.
- Does NOT produce: build/test commands, conventions/layer rules, domain boundaries, deploy reality → `fw init` still writes `map/*.md`. Query matching is substring-based (no synonyms). Extraction quality on this repo: not yet run.

**Context7**: declared by AI-DLC's shipped `.mcp.json` (`https://mcp.context7.com/mcp`), not installed in this workspace. Whether AI-DLC stages actually call it: not verified.

---

# v0.1 addendum — decisions (2026-08-28) and additions

## Decisions taken
- New repo outside scavtopia. License TBD (MIT suggested). Harness: TypeScript on Bun.
- Pilot: dogfood on scavtopia; phase-1 input = the leaderboard ideation pack, **distilled**.
- Experts are files-only in v0; training/star chart in v1.1.
- Terminal-only in v0; chat bridge (Pumble) as a later channel adapter.

## Naming (evidence: `npm view` + `gh search repos`, 2026-08-28)
| Candidate | npm | GitHub | Note |
|---|---|---|---|
| `tldr` | taken (tldr-pages client, v3.5.0) | — | CLI verb collides with a very popular tool → avoid as the command |
| `tldx` | free | brandonyoungdev/tldx ★1.9k | popular repo already uses it |
| `tldrx` | free | tldrx/tldrx ★6 | minor collision |
| `tldr-experts` | free | none found | clean |
| `xperts` | free | none exact | clean, generic |
| `tldrai` | free | 3 zero-star repos | mostly clean |
| `tl-dr` | free | not checked | — |
| `aix` | taken | — | avoid |

Suggestion: brand = **tldr-experts** (or **tldrai**), CLI verb = something short and free (`tldx`
is the nicest to type but shares a name with a 1.9k★ repo; `tlx`, `tde`, `xp` not checked yet).
Phase verbs read well either way: `tldrx what · how · plan · build · watch`.

## Pilot import without the noise
`tldrx run new --from <aidlc intent dir>` runs a **distill** step: reads only
`intent-statement.md`, `scope-document.md`, `feasibility-assessment.md`, `constraint-register.md`,
`raid-log.md`, `wireframes.md`, `user-flow.md` and the *answered* `*-questions.md`; ignores
market-research / team-formation ceremony. Every extracted claim keeps `[src: <file>#Q<n>]`;
claims without a source are dropped, not imported. The What-phase handoff then lists the gaps.

## Workspace model — single repo AND multi-repo root
- `init` runs at a **root**. Detection: if the cwd contains child dirs that are git repos →
  multi-repo workspace (repos = those children); else if cwd is a git repo → single repo.
- One `.tldrx/` at the root, always. Shared across repos: `memory/`, `experts/`, `stages/`,
  `workflows/`, `conventions/shared.md`. Per repo: `map/<repo>/`, `conventions/<repo>.md`,
  `commands.yml` entries keyed by repo. Cross-repo contracts (e.g. "API change ⇒ regenerate
  SDK in mobile + lab") live in `map/workspace.md` and are enforced at Plan time (a story
  touching a contract auto-spawns the dependent stories).
- Stories carry a `repo:` field; worktrees/epic branches are created **per repo**.
- Recommendation: the root should itself be a git repo (docs-only is fine — scavtopia already
  does this) so `.tldrx/` and `tldrx-work/` are versioned and Claude Code memory keys correctly.
- A repo that is also used standalone just runs `init` in its own folder; nothing is
  injected into sub-repos by the root install.

## Scopes = workflow presets (`workflows/<scope>.yml`)
A scope biases the facilitator: which stages run, depth, default budget, DoD deltas.

| Scope | Runs | Skips / changes |
|---|---|---|
| `feature` (default) | What → How → Plan → Build → Watch | — |
| `bugfix` | What = reproduce + root cause (from a report/log) → How (minimal) → Plan (usually 1 story) → Build → Watch (regression watcher) | market/UX questions |
| `hotfix` | 10-line handoff → Build → Watch → **mandatory retro** | What/How docs, gates collapse to one |
| `migration` (runtime/framework/dependency/data) | What = inventory + compatibility matrix → How = strategy (big-bang vs strangler) → Plan waves by module → Build → Watch | — |
| `upgrade` | subset of migration for a single dependency bump; highly automatable | How |
| `refactor` / `tech-debt` | What = evidence of pain (hotspots, churn×complexity) → How → Plan → Build with behaviour-preserving tests as the gate | Watch optional |
| `spike` / `research` | Investigate → Handoff (decision memo); time- and budget-boxed | Plan/Build/Watch |
| `performance` | What = **measured** baseline → How → Build → Watch = before/after | — |
| `security-patch` | CVE → affected surface (graphify `affected`) → patch → verify | What/How compressed |
| `integration` (external API) | What incl. vendor-doc verification (Context7/WebFetch) → How = contracts + auth → Build → Watch on vendor calls | — |
| `docs` / `onboarding` | Investigate → write docs; gate = a human reads them | Build/Watch |
| `prototype` | throwaway; conventions gate off; explicit "not for prod" marker | Watch, DoD tests |
| `retro` (meta) | reads a finished run; proposes facts/practices/stages | everything else |

Adding a scope = adding one yml; the facilitator never hard-codes a scope.

## Local dev environment manifest — yes, justified
Known dependencies already: Node (Claude Code), Bun (harness), Python ≥3.10 + `graphify`
(pip; tree-sitter wheels), git, optional `gh`, optional `CONTEXT7_API_KEY`, optional
`GEMINI_API_KEY` (graphify's doc pass). That is enough for:
- `env.yml`: each tool with `required|optional`, `check:` command, `min_version`, per-OS
  `install:` hint. **The framework never installs anything itself** — `tldrx doctor` runs the
  checks and prints the exact commands.
- Optional generators: `.mise.toml` (tool version pinning), `devcontainer.json`, `Brewfile` —
  candidates, not verified this session.

## Tool candidates beyond graphify/Context7 (status = verified this session or candidate)
| Need | Tool | Status |
|---|---|---|
| Deterministic convention rules (one class per file, banned patterns) | ast-grep (YAML rules) | candidate |
| Cyclomatic complexity across languages (the "low CC" gate) | lizard | candidate |
| Fast LOC/complexity per language for `map/hotspots.md` | scc | candidate |
| Hotspots = churn × complexity | `git log --numstat` script (no dependency) | no dep |
| Pack a domain's code as expert-training input | repomix | candidate |
| Git-level gates mirroring the DoD (outside Claude) | lefthook or pre-commit | candidate |
| Diagrams in handoffs, rendered by the dashboard | Mermaid | no dep |
| Deterministic sub-agent results | `claude -p --json-schema` structured output | verified (Appendix A) |
| Ticket adapter | Atlassian MCP (present here) / GitHub `gh` | present |
| UI verification during Build | Claude-in-Chrome / Playwright | present |
| Library docs, no hallucinated APIs | Context7 MCP | declared by AI-DLC, not installed |

`tldrx doctor` is where "candidate" becomes "verified": it checks the binary, prints the version, and records it in `env.yml`.

## Audience
Built for startups / small teams by default (one approver, budget-conscious, terminal-first).
Enterprise concerns (compliance, change boards) are optional stage packs, never defaults.

## v0.2 addendum — name, process model, ticket adapters (2026-08-28)

**Name decided:** brand/repo `tldr-experts`, CLI `tldrx`; npm package `tldrx` (renamed from `tldr-experts` on 2026-08-29 — the install name should be the command name). Framework dir `.tldrx/`, runs in `tldrx-work/`.

### Process model is data, not a rule (`.tldrx/process.yml`)
Identified during the install interview (or `--process` flag), never assumed:
- `methodology: scrum | kanban | shape-up | none` (+ `cadence`, `wip_limit`, `sprint_length`)
- `ticket_tool: jira | github | linear | none` (+ project key, board id)
- `definition_of_done` overrides, `story_granularity` (hours/days), `approvers`
The **Plan** phase renders the same epics/stories/waves into the team's shape: sprints for
scrum, a flow board with WIP limits for kanban, a plain ordered list for "none". Experts read
`process.yml` the same way they read `conventions.md`. Changing methodology = editing one file.

### MCP detection → optional ticket adapter (not too much, with two guard-rails)
- `tldrx init` / `doctor --mcp` reads `claude mcp list` (verified 2026-08-28: real command,
  parseable `name: <transport> - <status>` lines, but runs health checks — ~30 s when a server
  times out — so run it once and cache into `workspace.yml`; `.mcp.json` is the fast path).
- If an Atlassian / GitHub / Linear server is present and connected → suggest
  `ticket_tool` in `process.yml`. Suggestion only; the user confirms in the interview.
- Guard-rail 1: **files are the source of truth**. The adapter mirrors epics/stories *out* to
  the tool and pulls external status *in* as `external_status`; it never advances `run.yml`.
- Guard-rail 2: **filing a ticket is never "done"** (the brainer lesson: `stage=done` meant
  "ticket created" and misled two people for a day). Only the DoD hook can mark a story done.
