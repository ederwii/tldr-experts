# Changelog

## 0.1.0 — unreleased

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

All notable changes to tldr-experts. Dates are the day the work landed on `main`.

## 0.0.2 — unreleased

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
