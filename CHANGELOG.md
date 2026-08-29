# Changelog

## 0.3.0 — unreleased

- **`tldrx interview --init` now applies the two process answers.** They used to land in `facts.yml` and nowhere else, so a workspace could answer "GitHub Issues" and still have `ticket_tool.kind: none` on disk. The interview now writes `.tldrx/process.yml`: `methodology`, and `ticket_tool.kind` (`jira` / `github` / `linear` / `none`) — for GitHub it fills `ticket_tool.project` with `owner/repo` read from the git remote when it can, otherwise it prints a note; for Jira it prints a note to set the project key by hand; "other" leaves the file untouched. One summary line at the end says which happened — `process.yml: methodology=none, ticket_tool=github (owner/repo)` or `process.yml: unchanged`. The two process questions are reordered so option **A** is "None — …" for both, which makes `--yes-to-defaults` a real default there rather than a guess. It is still a guess on the ownership and dead-code questions, and it still answers for the human, so it stays a human's flag: the README and the `/tldrx` skill both now say not to pass it on somebody's behalf.
- **Several runs can be open at once, and ambiguity is refused rather than guessed.** With more than one open run and no explicit id, every run-targeting command — `next`, `answer`, `approve`, `reject`, `budget`, `interview --run`, `tickets`, `watch`, `retro`, `replay`, `dashboard` — exits `2` and prints `tldrx <cmd>: N runs are open — pass one:` with one line per run. Selectors: positional `<run>` on `next` and `run status`, `--run <id>` on the rest. `tldrx run status` with several open prints a table of them all and exits `0`; `--json` returns `{ "runs": [...] }`, and the single-run shape is unchanged when exactly one is open. `tldrx run new` prints a notice when others are already open. Hooks never block on the ambiguity and the status line appends `(+N open)` — a refusal that reaches a `PreToolUse` decision would stop work the human never asked to stop. `tldrx tickets status` also validates `process.yml` **before** the no-run check, so a broken adapter config is reported as a config error rather than as "no run".
- **Docs caught up with the code.** The `/tldrx` skill's "PRE-ALPHA — some commands are still stubs and exit 64" warning was false: `grep -rn "implemented: false" src/cli/commands/` comes back empty. It now says alpha, points at `tldrx --help` as the authority, and writes down three things a real session spent five minutes reverse-engineering out of `dist/tldrx.js`: exit `3` from `tldrx run status` means no run exists (ask the human, then `tldrx run new <slug> --scope <s>`, with the scope names listed) rather than invent one; init questions are answered with `tldrx interview --init`, which on a non-TTY stdin reads **one line per question** (`printf 'A\nB\nA\nA\n' | tldrx interview --init`, the letter picking the option at that position); and `--yes-to-defaults` answers for the human. The skill and the README also now say plainly that `.tldrx/` and `tldrx-work/` are **committed** — `tldrx init` gitignores exactly five machine-local paths (`.tldrx/graphify-out/`, `.tldrx/cache/`, `.tldrx/worktrees/`, `tldrx-work/*/.lock`, `tldrx-work/*/.agent/`) and everything else is the state. `tldrx install --claude` needed no change: it copies `plugin/skills/tldrx/SKILL.md` off disk at install time (`PLUGIN_DIR`, shipped via the `plugin` entry in `package.json` `files`), and `dist/` embeds no second copy.
- **The dashboard is redesigned, and now draws in the browser.** New design system vendored into `styles.ts` (paper/ink tokens, one loud accent spent only on the two states that need a human), and five views behind a hash route — runs, run detail, experts, watchers, how-to — replacing the single long document. Citations are first-class: `[src: …]` in a handoff renders as a reference chip and `[assumption]`/`[inference]` as a flag, marked in the DOM so the model's `handoffHtml` is styled and never re-parsed.
- **Where the rendering happens changed; what guards it did not.** The page ships the model inline in a `<script type="application/json">` and draws every view client-side, so `--static` is the same document with no server behind it. `render.ts` stays TypeScript against `DashboardModel` — `tsc --strict` is still on the markup, which is the whole reason the views did not move into a script string — and still reaches the page through `clientRenderer()`, so every `dash*` function stays closure-free. The byte-for-byte test now evaluates the serialised source in an empty scope and renders every view through it, comparing against the typed original.
- **Re-rendering keeps the reader's place.** Handoff panel ids are derived from run + phase rather than render order, so a `reload` two seconds later restores the open panel and the scroll offset instead of snapping to the top. Verified live: the model re-fetched and the read timestamp advanced while scroll, route, open panel and all 180 citation marks survived.
- Read-only is now tested for what it means rather than for the absence of `<button>`: no form, no `fetch` in a static export, and every button on the page carries `data-copy`/`data-filter`/`data-sort` and nothing else. A copied train command still carries `--print-prompt`, so the one command the page hands over prints a prompt instead of running training.
- Two fixes to the design as drawn: a path row is marked "waiting" only when the run is actually stopped at that stage (every downstream gate also reads `pending`, which had painted four rows of five as an alert), and the competency radar's viewBox was widened and its axis labels clipped to fit — `scavtopia-infrastructure` is 24 characters and used to overflow the chart. Both measured in a browser, the second with `getBBox()` against the viewBox for 3–6 axes.
- **`tldrx tickets` — the optional ticket mirror (concept v0.2 addendum).** `sync` pushes every epic and story in `03-plan/` out to Jira or GitHub as an issue and records `external: {provider, key, url, synced_at}` `[assumption: field name]` in the file's front matter; `status` prints local `status` beside `external_status` and changes nothing. Idempotent — a second sync creates nothing and re-uses the stored key. Off unless `.tldrx/process.yml` says `ticket_tool.kind: jira|github`; `none` (or no `process.yml`) exits `0` with "adapter disabled".
- **The two guard-rails are code, not prose.** *Files are the source of truth*: a provider is exactly `write(input, key)` and `readStatus(key)` — there is no method that returns a `PlanStatus`, so remote state has no shape it could take on the way to a story's `status:`. *Filing a ticket is never "done"*: `applyExternal` rebuilds the front matter from the original lines and **throws** if the patch would move the `status:` line, and the run is opened read-only (`RunStore.save()` is never called), so the cursor, the gate and the budget are unreachable. `external_status: Done` beside `status: todo` is a legal, expected state.
- **`ticket_tool.sync` now means something.** `mirror-out` pushes and reads nothing back; `two-way` also pulls each issue's status string, **verbatim**, into `external_status:` and into nothing else. The "two-way" name is generous: the second direction is one opaque string into one front-matter key.
- **Providers, and the reason no test calls one.** GitHub goes through the `gh` CLI (`issue create` / `issue edit` / `issue view --json state,url,number`), so the adapter never handles a token; Jira through REST v3 with `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` (missing any ⇒ exit `1` naming all three, **before** `03-plan/` is read, so a failed preflight leaves nothing half-written). Both take their transport as a constructor argument, so the suite exercises the real argv and the real REST paths through injected fakes — **no test in this repo makes an outbound call or spawns `gh`**, and `--dry-run` is asserted to make zero transport calls.
- New event type `ticket.synced` in the §2.9 closed enum and its validator: one per mirrored item, `stage: null` and `cost_usd: 0`, because no model ran and a mirror is not a stage.
- Docs: spec §5.1 "Ticket mirror", the `ticket_tool.sync` semantics table in §2.12, two `tldrx tickets` rows in the §3 CLI surface, README command rows and a "Ticket mirror" section, `ticket_sync` documented in `templates/process.yml`.

- Documented, from measurement: `--max-budget-usd` stops after the current turn (a training call spent $5.15 against $1.50); budgets gate before and reconcile after, overshoot ≤ one turn.
- **`effort:` on a stage, `--effort <level>` on the command line** — the cost lever `--max-budget-usd` is not: the budget flag can only end a turn already in flight, `--effort` changes what that turn costs. Optional `effort: low|medium|high|xhigh|max` in `stage.yml` (unset ⇒ the flag is never passed, behaviour unchanged; an unknown level is refused, not dropped), overridable per invocation by `tldrx next --effort` and `tldrx expert train --effort` (training defaults to `medium`). Shipped stage defaults, all `[assumption]`: what `medium`, how `high`, plan `medium`, build `high`, watch `low`. The level is recorded on `agent.spawned`/`agent.result` and on every `training.jsonl` line beside the cost, so cost-per-effort becomes measurable rather than arguable.
### Expert training runs

`tldrx expert train <name> --area <a> [--mode light|full]` used to print a prompt
and exit `64`. It now runs, and the design is built around one rule: **a level
moves because a file was cited, never because an agent said it learned
something.**

- **A deterministic pre-pass picks the files.** No model is asked what to read.
  `.tldrx/map/<repo>/domains.md`, graphify communities when the graph has any, and
  a bounded keyword grep over the expert's repos (the area id and the words of its
  title) — capped at **40 files / 96 KB**, with everything over the cap listed by
  name as "not read" so a sub-agent cannot describe a file it was never shown. The
  grep and the graph decide whether a file is about the AREA; the map only
  re-ranks what already matched.
- **One sub-agent**, the expert plus its stack experts plus the conventions, reads
  only what was inlined — with a line-number gutter, because a citation whose line
  is outside its file is rejected — and writes
  `.tldrx/experts/<name>/knowledge/<area>.md` with `## Invariants`,
  `## Entry points`, `## Business rules`, `## Gotchas`, `## Sources`.
- **The framework re-reads that file off disk** and validates it with the SAME
  parser the `claim-sources` hook uses, so a knowledge file cannot pass here and be
  denied on write. Every list item must end in a `[src: …]` token; `absent:` is a
  legal finding ("I looked and there is nothing") and earns no evidence.
- **Evidence is derived, not asserted:** one `code` row per **distinct cited
  file** (twelve readings of one file are worth one row, which is what keeps the
  §2.6 distinct-source cap meaningful), `doc` for an https URL, `answer` for
  `F<n>`. Then every area's level is recomputed by the §2.6 formula — not just the
  trained one — the expert goes to `status: in-use`, and `last_trained` is stamped.
- **Rejection is whole.** One unsourced item, or one line past the end of its file,
  and nothing is written: no evidence, no level change, no status change. Any
  knowledge file that was already accepted is restored byte-for-byte, and the
  rejected one is moved to `<area>.rejected.md` so it cannot be mistaken for
  accepted knowledge. Exit `5`.
- **`--mode full`** adds a second sub-agent that mines
  `tldrx-work/**/{handoff,retro}.md` from runs whose repos overlap this expert's,
  plus `facts.yml` rows matching its area or repos, into
  `knowledge/from-runs-<area>.md` — `run` and `answer` evidence. **Claude Code
  transcripts are deliberately out of scope:** they carry no citation anything can
  re-resolve, so mining one would put an unfalsifiable claim into
  `competencies.yml`.
- **Money.** `--max-usd` (default `$2.00`) reaches the sub-agent as
  `--max-budget-usd`, split between full mode's two agents. Below the **$0.25
  floor** it refuses with exit `2` **before reading anything** — a cold `claude -p`
  pays 10–26k cache-creation tokens before its first reply, so a ceiling under the
  floor is a failed spawn, not a saving.
- **`--prepare` / `--commit`**, the same handshake `tldrx next` has, so a Claude
  Code session runs training without a nested spawn. One bundle per sub-agent under
  `.tldrx/cache/training/<expert>/<area>/.agent/<task>/`.
- **`--print-prompt` is unchanged.** It still prints the copy-paste prompt and
  spawns nothing.

### Measured: `--max-budget-usd` is a stop, not a cap

Pilot smoke, 2026-08-29, `--max-usd 1.5` over mobile + scavtopia-lab: the sub-agent
was killed with `error_max_budget_usd` ("Reached maximum budget ($1.5)") **after**
`total_cost_usd: 5.15325`, on a single turn (597 s, 105,698 cache-creation +
60,548 output tokens, 1M-context model). The flag ends a run once a turn's cost is
known; it cannot end a turn already in flight. Size a training prompt for the money
you are willing to lose, not the ceiling you passed. The pipeline itself held: a
non-zero `claude` exit is a failed run, so nothing reached `competencies.yml`, the
$5.15 was recorded in `training.jsonl`, and the knowledge file the agent had
already finished writing was **quarantined** rather than left where an accepted one
lives — it would in fact have validated (111 sourced items, 21 distinct files,
level 5), which is exactly why leaving it there would have been the dangerous
outcome.

### `training.jsonl` (spec §2.6.1)

Every run appends to `.tldrx/experts/<name>/training.jsonl`: §2.9's envelope shape
— seven keys, closed `type` set, append-only enforced by byte length — with `run`
replaced by `expert` and `stage` by `area`. `events.jsonl` is run-scoped and
training outlives every run, so it gets its own ledger beside the expert. A
REFUSED run still writes its `agent.result`: money spent is recorded whether or not
the knowledge was kept.

### Seen from outside

`tldrx expert list` grows two columns — total **evidence** and the per-area
**levels** — and `--json` grows `evidence_count`. The dashboard model needed no
change: it already recomputes levels from evidence, so the star chart moves the
moment `competencies.yml` does.

### Claude Code integration without the plugin

- **`tldrx install --claude`** writes the facilitator into a real `.claude/` —
  `--project` (default, refuses outside a git repo) or `--user`. It copies
  `plugin/skills/tldrx/SKILL.md` to `.claude/skills/tldrx/SKILL.md` with
  `disable-model-invocation: true` intact and a `<!-- tldrx-managed -->` marker, and
  **merges** into `.claude/settings.json`: the six hooks as eight handlers on four
  events (the same matchers and timeouts as `plugin/hooks/hooks.json`, each command
  `tldrx hook <name>`) plus `statusLine: {type: "command", command: "tldrx statusline"}`.
- **It is idempotent and reversible.** A second run leaves `settings.json` and
  `SKILL.md` byte-identical; `--uninstall` removes exactly the entries it added and
  restores the file byte-for-byte. `settings.json` is copied to
  `settings.json.bak-tldrx-<ts>` before the first write, and a same-second second
  backup gets a suffix rather than overwriting the first.
- **It refuses rather than clobbers.** A `SKILL.md` without the marker is somebody
  else's (exit `1`, nothing written). A `statusLine` that is not ours is left alone
  and the command prints how to chain the two — `--force-statusline` is the
  override. `permissions` is never touched, and no entry we did not write is edited.
  Flags: `--skill-only` `--no-hooks` `--no-statusline` `--dry-run`.
- **`tldrx hook <name>` and `tldrx statusline`** run one hook script —
  `dist/hooks/<name>.js` when tldrx is running from `dist/`, `src/hooks/<name>.ts`
  in a source checkout — passing stdin, stdout, stderr and the exit code through
  unchanged. That is what lets a *committed* `settings.json` name a hook without an
  absolute path. The plugin deliberately keeps `${CLAUDE_PLUGIN_ROOT}`, because it
  has to work for someone who cloned the repo and installed nothing; both forms are
  documented.

### The Interview step, in a terminal

- **`tldrx interview`** walks the open questions of the cursor phase's
  `questions.md` (or `.tldrx/init-questions.md` with `--init`), showing each one's
  `Why asked:` line and options, and reads a letter `A`–`E`, free text, `s` to skip
  or `q` to stop. Every answer is recorded through the **same** `src/core/answers/`
  path as `tldrx answer` and the `answer-capture` hook — footer, `facts.yml` row,
  `question.answered` + `fact.added` — so the channel is interchangeable and the
  record is not (spec §7: the questions file is the contract, not the channel).
- **It never answers for you.** End of input, `s` and `q` all leave the question
  `status: open`, and a letter the question does not offer is reported and skipped
  rather than recorded as the literal letter. `--yes-to-defaults` takes option A.
  Piped stdin works, one answer per line.

### Packaging

- **Package name stays `tldr-experts`**; it now installs two commands, `tldrx` and `tldr-experts`. (Unscoped `tldrx` as a package name is refused by npm's similarity rule; 0.0.1–0.2.0 were unpublished on 2026-08-29 and their numbers can never be reused, so this is the first version back on the registry.)
- README: release table with status tags (`alpha`/`beta`/`stable` defined) and npm/CI badges.

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
