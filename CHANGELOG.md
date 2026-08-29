# Changelog

## 0.2.0 — 2026-08-29

### The Build phase executes

`tldrx next` on `04-build` used to do what every other phase does: assemble one
prompt, spawn one sub-agent, validate its files. That is the wrong shape for a
phase whose work is a dozen agents in a dozen worktrees, so `04-build` now selects
a **wave executor**.

- **`waves.yml` is the schedule.** Wave by wave, story by story: resolve the
  story's repo from `workspace.yml`, ensure `epic/<slug>` exists off the repo's
  `default_branch`, open a worktree at `.tldrx/worktrees/<repo>/<story-id>` on
  `story/<id>`, and spawn ONE developer sub-agent with its cwd inside it.
- **Done means proven.** After the agent, the facilitator re-runs the story's
  fenced ```dod block **in that worktree** — the same runner `dod-gate` uses — and
  every command must exit 0. Then it commits anything the agent left uncommitted
  as `feat(<story-id>): <title>`, merges `story/<id>` into the epic with
  `--no-ff`, and hands the diff to a **read-only reviewer** (`Read`, `Grep`,
  `Glob`, `Bash(git diff *)`). A story reaches `done` only on DoD green **and** an
  approval, and its `evidence:` is written from what was measured: `$ <cmd> →
  exit 0` per command, the commit sha, the review path.
- **A failure costs one story, not the wave.** A red DoD or a merge conflict
  blocks that story — the merge is aborted so the epic branch stays usable, and
  the conflicting paths are recorded as its evidence — and the wave carries on.
- **A reviewer's `changes` requeues the story once**, with the review rendered
  under `## Previous attempt` in the next prompt. A second `changes` blocks it.
- **Nothing ships.** No `git push` is run and no allowance grants one; no epic is
  merged into a default branch. The phase ends at a human gate that lists the epic
  branches ready to merge, per repo.
- **Safety.** A repo with uncommitted changes is refused **before** anything is
  cut, naming the files and the fix (exit `2`, the stage stays `ready`).
  `--dry-run` is refused outright: branches and commits are not revertible by a
  flag. Worktrees are removed when a story reaches `done` or `blocked`, unless
  `--keep-worktrees`.
- **`04-build/handoff.md` is generated, not asked for.** The executor holds the
  exit codes and the merge results, so it writes the four §2.8 sections itself:
  Findings cite `04-build/log/<story-id>.md`, the Evidence ledger is the dod
  commands as `[src: $ <cmd> → exit <n>]`. One review log per story, always —
  including a story blocked before a reviewer ran, so every citation resolves.
- **`run status` grows a Build line:** `04-build  W1 [S1 done, S2 review]
  W2 [S3 todo]` with per-story cost, read from the story files and the ledger.
  A one-stage phase holding a dozen sub-agents cannot say anything with a
  stage-level progress bar.
- **In-session:** `--prepare` bundles the NEXT pending story into
  `.agent/<stage>/<story-id>/` (one story per cycle) and `--commit` continues that
  story's pipeline from the DoD step.

### The executor plug-in point

`src/core/facilitator/executors/` is a map from **phase id** to executor; a phase
with no entry keeps the single-agent path. Everything either side — the lock, the
cursor, the budget gate, `run.yml`'s tasks, the outputs re-read off disk, the
checks and the gate — stays in `runNext.ts`, because an executor that could move
the cursor would be a second facilitator. An executor may force a human gate
(Build does) and may refuse without failing the stage (a dirty repo).

### Money

A stage's budget is split by the sub-agents an executor actually runs:
`min(stage budget ÷ stories, per_agent_max_usd, --max-usd)` for a developer, a
quarter of that share for its reviewer. The budget gate guards *starting* a stage,
so a mid-pipeline `--prepare` cycle is not charged the whole estimate again.
### `tldrx dashboard` — a live, read-only local server

`dashboard` without `--static` used to exit `64`. It now serves.

- **Three GET routes on `127.0.0.1`**, default port `4477` (`--port <n>`,
  `--port 0` for any free one, `--open` to launch a browser): `/` is the page,
  `/model.json` is the model it was drawn from, `/events` is a Server-Sent Events
  stream. Nothing else is answered, and anything that is not a `GET` gets `405` —
  a dashboard that can change state is a second source of truth competing with
  the files (concept §12).
- **A watcher over `.tldrx/**` and `tldrx-work/**`**, debounced 300 ms, pushes a
  `reload` event; the page re-fetches the model and redraws. Recursive `fs.watch`
  where the platform has it, an mtime sweep where it does not — an untested
  fallback is a dashboard that quietly stops being live, so both paths are
  covered by the same test.
- **`node:http` and `node:fs`, nothing else.** No framework, no runtime
  dependency, and the built `dist/tldrx.js` serves under plain `node` — proven by
  a test that runs it, not by inspection.
- Ctrl-C closes the listener and the watcher and exits `0`. A directory with no
  `.tldrx/` gets a page that says which two commands fix that, and fills itself in
  when one of them is run.

### Model and renderer are now separate things

The rendering layer is meant to be replaced by a designer, so it stopped being
entangled with the reading layer.

- **`src/core/dashboard/model.ts` produces one plain JSON `DashboardModel`** from
  the files — runs, execution path, handoffs, open questions, experts with levels
  recomputed from evidence, the FAQ as data, and the Plan's stories/epics/waves
  when a run has written them. It survives a JSON round trip unchanged, and a test
  pins the field NAMES rather than the markup. Documented field by field in
  `docs/dashboard-model.md`.
- **`src/core/dashboard/render.ts` is the only markup in the product.** The static
  export renders on the server; the live page redraws in the browser — with the
  *same functions*, serialised into the page by `clientRenderer()`. A test
  evaluates that serialised source in an empty scope and demands byte-identical
  output, so a template function that closes over a module constant fails there
  instead of as a blank page in someone's browser.
- `--static` is unchanged in what it shows, and gained the plan block.
### Watch: one watcher card per shipped feature

The phase that answers "how would anyone know this still works next month?" — and
refuses to answer it aspirationally.

- **`05-watch/watchers/<feature>.md`** (spec §2.16, `templates/watcher.md`): front
  matter (`version`, `id`, `epic`, `title`, `stories`, `repos`, `status`) plus
  `## Signal` · `## Where` · `## Healthy baseline` · `## Looks broken when` ·
  `## Query` (fenced, copy-paste) · `## Sources`. Every list item in the first four
  ends with a `[src: …]` token, checked by the **same parser `claim-sources` uses**.
- **`status` is computed, never claimed.** `verified` only when no `absent:` source
  remains under `## Signal`; otherwise `draft`, and the card says what to
  instrument. The executor re-reads the card off disk and rewrites the line, so a
  sub-agent that stamps its own work `verified` is overruled.
- **The Watch executor** (`src/core/facilitator/executors/`, a map from phase id to
  executor). A deterministic pre-pass groups **done** stories by epic — one feature
  per epic, named after the epic's branch slug. Then one sub-agent per feature,
  handed that epic's done stories, the **read-only diff of its branch against each
  repo's `default_branch`** (through the runtime seam; nothing checks out or
  fetches), the `observability`/`deploy` facts and the repos' `gotchas.md`, and
  nothing else. The diff is what landed; `touches:` was written before the code
  existed. `05-watch/handoff.md` is then written deterministically from the cards.
- **No done stories is a result, not an error.** The stage completes, spawns
  nothing, spends nothing, and its handoff reads `- none [src: absent:03-plan/stories]`.
- **`--prepare`/`--commit` is per feature**: one
  `.agent/<stage>/<feature>/{prompt.md,pending.json,result.json}` each.
- **`tldrx watch list [--run <id>]`** — feature, status and Signal line per card.
  **`tldrx watch check <feature>`** — re-resolves one card's citations and
  re-computes its status, and **exits 1 when either fails**, so CI can see it. It
  catches both ways a card rots: the code moved under a citation, or somebody
  hand-edited `draft` to `verified`.


## 0.1.0 — 2026-08-29

### Greenfield: a project with no code yet

Measured on a temp repo holding only `requirements.md` (2026-08-29): `init` seeded
zero experts, and `run new` had no way to be handed the document — so the What
stage would have ideated from nothing.

- **`tldrx init` names the case.** A single repo with zero code files is recorded
  as `mode: greenfield` in `workspace.yml`, and `map/<repo>/architecture.md` says
  so with an `absent:` source instead of describing an empty tree as an
  architecture. "Code file" is one rule, by extension, shared with the map
  (`src/core/detect/codeFiles.ts`).
- **`init` always seeds a `product` expert** — the What stage names one, so a
  workspace without it handed that stage a prompt with no expert body at all.
- **`init --stack ts,dotnet,python,go,rust,…`** seeds a `<lang>-stack` expert per
  declared language when there is no manifest to detect one from. Without it the
  greenfield interview asks *"Which stack will this project use?"* (fixed list plus
  free text) and *"Which single document is the source of requirements?"*.

### `tldrx run new --seed <file|dir>` — import any document

- Takes one `.md`/`.txt` file or a directory of them (recursive, sorted, ≤50 files,
  ≤2 MB each; anything larger is skipped **and named**). PDFs and Word files are
  out of scope and say so. Distinct from `--from`, which stays AI-DLC-specific;
  passing both is an error.
- **Copies nothing.** The originals stay where the team keeps them and every claim
  cites them as `[src: <path>:<line>]`, workspace-relative.
- Writes `01-what/seed-index.md` (documents, sizes, skips, warnings) and
  `01-what/handoff.md` whose Findings are every heading, bullet and paragraph of
  the seed. Unknowns are deterministic: the What outputs
  (`intent`/`scope`/`success-metrics`/`open-questions`) that no seed heading
  matches.
- The seed documents are added to the What stage's **declared inputs** in
  `run.yml`, so `tldrx next` inlines their content into the prompt. `stage.yml`
  opts in with `seed: true` (§2.3 `inputs.seed` is accepted too); over the 64 KB
  inline budget the index plus a labelled prefix is inlined and the prompt says
  what was cut. Input count is capped at §2.3's 20.

**Plan/Build schemas (spec §2.13–§2.15).** `03-plan/stories/<id>.md`, `03-plan/epics/<id>.md` and
`03-plan/waves.yml` now have a shape, templates and validators — the last of spec §7's schema open items.

- Story front matter: `id` `epic` `title` `repo` `status` `depends_on` `touches` `acceptance` `test_plan` `evidence`,
  plus the fenced `` ```dod `` block. **Every dod command must equal a `.tldrx/workspace.yml` command verbatim** — a story
  is data, and data does not get to invent a shell command. **`status: done` requires `evidence`**: done means proven.
- Epic front matter: `id` `title` `repos` `stories` `branch: epic/<slug>` `status`. A story belongs to exactly one
  epic, and the story ↔ epic reference must agree in both directions.
- `waves.yml`: `waves: [{id: W1, stories: [S1, S2]}, …]`, ids ascending because file order is execution order, and the
  rule the shape cannot enforce alone — **every story's `depends_on` must be in an earlier wave**. A dependency inside
  the *same* wave is an error, not a warning: those two stories would go to parallel agents that overwrite each other.
- New `plan` gate check reads all three together at the Plan gate (`tldrx approve`), which is the only place the
  cross-file rules can be checked. `dod-gate` keeps its line scanner — a gate that only ran when the front matter
  parsed would let a malformed story write `status: done` unchecked — but now shares one `` ```dod `` parser with the schema.
- Templates: `templates/story.md`, `templates/epic.md`, `templates/waves.yml`.

**Budget UX.** Measured in the pilot: a retry was refused twice because the phase ceiling had been sized for exactly
one attempt, and nothing put "what is left" next to "what the next stage costs".

- `tldrx budget show [<run>] [--json]` — a phase table of ceiling, spent, remaining, the next stage and its own
  estimate, and whether `tldrx next` would be blocked there.
- `tldrx budget raise <phase> <usd> [--take-from <phase>]` — the one sanctioned edit to `budget.yml`, validated before
  it writes: Σ phase ceilings ≤ run ceiling holds on the way out, a `--take-from` donor can never be cut below what it
  has already spent, and the output says out loud whether the run ceiling grew or the money merely moved.
- Both `budget.blocked` messages (the hook and `tldrx next`) now name **the exact command**, with the shortfall
  computed and rounded **up** to the cent, instead of naming the field to hand-edit.
- `run status` shows per-attempt cost for the cursor stage — `attempts: 2 · $1.39 + $1.21` — read from `agent.result`
  events. A stage's total `cost_usd` cannot tell one $2.60 attempt from two $1.30 ones, and only the second says
  whether a retry fits.

**Checked sections must contain items (spec §2.8).** Findings / Decisions / Unknowns / Evidence ledger must each hold
at least one list item; a section that is present but carries only prose is now a validation error. A genuinely empty
section is written `- none [src: absent:<what was looked at>]`. This closes the way an unsourced claim used to get
written anyway: a paragraph carries no bullet for the checker to look at, so "no unknowns that we can see" validated
clean. The parser, the `claim-sources` hook, the facilitator's post-stage check and `tldrx approve` share one parser
and all four now refuse it. The Evidence ledger in the shipped stage templates is a list rather than a table (a table
holds no list items), and both deterministic renderers — the `--from` distill and the `--seed` import — write
`- none [src: absent:…]` where they used to write an italic paragraph, so a `run new` cannot produce a handoff its own
validator would reject. **Outstanding:** `stages/what/stage.md` still ships the table and the old `## Rules` block; it
was owned by a concurrent branch when this landed.

All notable changes to tldr-experts. Dates are the day the work landed on `main`.

## 0.0.2 — 2026-08-29

Fixes found by the first real pilot (scavtopia, `--from` an AI-DLC intent, What stage):

- `claim-sources`: bare `path:line` sources now resolve against the workspace root, then the run directory, then a repo dir (a run-relative `01-what/intent.md:12` was reported as missing).
- Handoff parser: wrapped bullets (token on an indented continuation line) and ordered items (`1.` / `1)` at column 0) are validated like `- ` bullets; the facilitator check, `approve` and the hook share one parser.
- `next` retries a `failed` cursor stage instead of walking past it; `run status` renders failed stages; `reject --note` works from `failed` and the note reaches the next prompt under `## Previous attempt`.
- `run new --from` no longer duplicates facts on re-import.
- `--root` on every run-scoped command; `<cmd> --help` works without a workspace.
- Stage prompts carry the citation grammar and the no-re-ask rule.
- Hook bundles split into one shared chunk (`dist/` 2.4 MB → 0.9 MB); CI build step is honest; tag-driven trusted-publishing release workflow.

## 0.0.1 — 2026-08-29

First published version. Pre-alpha: the v0 loop runs end to end, and the parts
that do not exist yet exit `64` and say so rather than pretending.

### What is implemented

- **`tldrx init`** — detects repos, stack, package manager, default branch and
  build/test commands from the filesystem and `git` alone (no LLM, no network);
  writes `.tldrx/workspace.yml`, the code map under `.tldrx/map/**`, the init
  handoff, an interview containing only the real gaps, seeded experts at level 0,
  `conventions/`, `process.yml` and an empty `facts.yml`, plus a marked block in
  `.gitignore` and `CLAUDE.md`. Re-running keeps everything a human authored.
- **`tldrx map --refresh | --check`** — rebuilds the map, or resolves every
  `[src: …]` citation in it against the filesystem and exits `1` naming the ones
  that no longer land. Providers: `graphify` when it is on PATH, otherwise a
  static provider (file tree, manifests, 90-day git churn).
- **`tldrx doctor`** — runs every check in `env.yml` and prints the table. Exit
  `0` only when every required tool meets its `min_version`. `--mcp` adds live
  MCP health checks.
- **The run lifecycle** — `run new <slug>` seeds `tldrx-work/<yymmdd>-<slug>/`
  from a scope preset and its stage files, with per-phase budget ceilings scaled
  to `--budget`; `run status` renders the execution path, the money and what the
  run is waiting on; `answer`, `approve` and `reject` are the human half.
  `approve` re-runs the stage's declared checks against what is on disk before it
  will advance anything.
- **`run new --from <dir>`** — the AI-DLC distill: reads a listed set of files
  from an intent folder, turns each bullet into a sourced Finding and each
  answered question into a fact, drops the unanswered, and turns a claim that
  contradicts a non-retired fact into a question rather than overwriting it.
  Deterministic; no model runs.
- **`tldrx next`, in two execution modes** — headless (`tldrx next` spawns
  `claude -p` itself) and in-session (`--prepare` writes the prompt bundle, the
  host Claude Code session dispatches its own sub-agent, `--commit` picks it up).
  From "re-read the declared outputs off disk" onwards both are the same code:
  same validation, same checks, same cost roll-up, same gate. `--dry-run` keeps
  the handoff and reverts the rest.
- **Six hooks** — `claim-sources` (a handoff bullet without a resolvable `[src:]`
  is denied), `no-re-ask` (a question `facts.yml` already answers is denied),
  `answer-capture` (records the answer, the fact and the event), `dod-gate`
  (re-runs a story's `dod` block; the one hook that fails closed), `budget-gate`
  and `session-start`. Everything but `dod-gate` fails open.
- **`tldrx expert list | create | train --print-prompt`** — experts are files.
  `list` recomputes every level from evidence before printing it and warns when
  the stored number disagrees.
- **`tldrx replay`** — `events.jsonl` rendered as a stakeholder narrative.
- **`tldrx retro [--apply]`** — five deterministic heuristics over the event log,
  each citing the line that proves it; `--apply` appends the proposals to
  `practices.md`, idempotently.
- **`tldrx dashboard --static`** — one self-contained `index.html`, no external
  request in any `src`/`href`.
- **Runtime: Node ≥ 20 or Bun.** Every capability that differs between the two
  lives behind `src/core/runtime/`; a test asserts no `Bun.` call site survives
  outside it. The published bundle inlines its one devDependency, so an install
  resolves zero runtime dependencies.

### What is NOT implemented

- **Build and Watch phase execution.** The stages, their contracts and the story
  and wave file shapes exist; running them does not. Story/epic/`waves.yml`
  schemas are still an open decision.
- **Expert training.** `expert train` prints the prompt to paste and exits `64`
  without `--print-prompt`. Running the training loop, and writing the resulting
  `knowledge/*.md` and levels back, is v1.1.
- **The live dashboard.** `dashboard` without `--static` exits `64`. The watching
  server is v1.
- **The ticket adapter.** No Jira or GitHub integration ships. Direction
  (mirror-only vs two-way) and which one lands first are undecided.
- **Parallel execution.** v0 runs one stage at a time, one task at a time.

### Notes

- `tldrx <command> --help` prints usage and exits `0` without needing a
  workspace. `--root <path>` works on every command that touches one.
- A `failed` stage is not progress and not the end: `run status` renders it as a
  failure, `tldrx next` retries it, and `reject --note` sends it back to `ready`
  with the note fed into the next prompt.
