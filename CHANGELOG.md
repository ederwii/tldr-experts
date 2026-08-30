# Changelog

## 0.3.0 — unreleased

Every measurement below was taken on a real workspace on 2026-08-29 unless another date is
given. A claim with no measurement behind it is marked `[assumption]` where it appears in the
code.

### Added

**Commands**

- `tldrx status [--json]` — one report of everything in the workspace waiting on a human, in
  the order the sources block each other: open init questions, every `split.yml` still
  `status: proposed`, every open run with the exact command it needs, and every expert a stage
  will load with zero evidence. `--json` gives `{root, pending, items[], advice[]}`; `items`
  are the blockers, `advice` blocks nothing. Deterministic and read-only; exits `0` whatever
  it finds, `3` only when there is no `.tldrx/` at all. Runs are dependency-aware: one whose
  `triage.depends_on` sibling is not `done` shows `blocked by <slug>` and is offered no
  command, and the first runnable one is marked `← next`. A run folder that does not validate
  gets its own item rather than vanishing.
- `tldrx expert train <name> --area <a> [--mode light|full]` — training runs. It used to print
  a prompt and exit `64`. A deterministic pre-pass picks the files (map domains, graphify
  communities, a bounded keyword grep; capped at 40 files / 96 KB with everything over the cap
  named as "not read"); one sub-agent writes `knowledge/<area>.md`; the framework re-reads it
  off disk and validates it with the same parser the `claim-sources` hook uses; evidence is
  **derived** from the citations, never asserted. `--mode full` adds a second sub-agent mining
  `tldrx-work/**/{handoff,retro}.md` — Claude Code transcripts are deliberately out of scope,
  they carry no citation anything can re-resolve. `--max-usd` (default `$2.00`), `--model`,
  `--effort`, `--yolo`, `--prepare`/`--commit`, `--print-prompt`.
- `tldrx expert recompute [<name>] [--json]` — recomputes `areas[].level` from the evidence
  already on disk. Only the headless/`--commit` path ever wrote a level, so a human who pasted
  the `--print-prompt` prompt into their own session ended with `level: 0` while the formula
  computed 5, and nothing could settle it. Idempotent; touches neither `status` nor
  `last_trained`; spawns nothing.
- `tldrx install --claude` — writes the facilitator into a real `.claude/` without the plugin
  and without `init`: the skill file (marker `<!-- tldrx-managed -->`, `disable-model-invocation`
  intact) plus a merge of two `settings.json` keys — the six hooks as eight handlers on four
  events, each `tldrx hook <name>`, and `statusLine`. `--project` (default; refuses outside a
  git repo) `--user` `--skill-only` `--no-hooks` `--no-statusline` `--force-statusline`
  `--uninstall` `--dry-run`.
- `tldrx hook <name>` and `tldrx statusline` — run one hook script (`dist/hooks/<name>.js`, or
  `src/hooks/<name>.ts` in a source checkout), passing stdin, stdout, stderr and the exit code
  through unchanged. That is what lets a *committed* `settings.json` name a hook without an
  absolute path. The plugin keeps `${CLAUDE_PLUGIN_ROOT}`, because it has to work for someone
  who cloned the repo and installed nothing.
- `tldrx interview [--run <id>] [--init] [--yes-to-defaults]` — the Interview step in a
  terminal, recording through the same `src/core/answers/` path as `tldrx answer` and the
  `answer-capture` hook. It never answers for you: end of input, `s` and `q` all leave the
  question `status: open`, and a letter the question does not offer is reported and skipped.
  Piped stdin is one answer per line.
- `tldrx run auto [<run>]` — the headless loop: `next` until a human gate or open question
  (`4`), a failure (`5`), a budget refusal (`2`), `--until <stage>` reached or the run finished
  (`0`). Holds no state, so killing it leaves a run `tldrx next` picks up unchanged.
  `--max-usd` is a ceiling on the LOOP's total spend, checked *between* stages.
- `tldrx run unlock [<run>] [--force]` and `tldrx run cancel [<run>] --note <t> [--force]` —
  the two ways out of a stuck run, with new `run.unlocked` / `run.cancelled` events and an
  additive `cancelled: {by, at, note}` on `run.yml` (which is what lets a FAILED run be closed
  without overwriting the failure on its stages). Nothing is deleted; `tldrx replay` still
  reads the whole thing.
- `tldrx cost [<run>] [--all] [--json]` — what was actually spent, read off `agent.result`
  events and nothing else. Per attempt, per stage, per run. All four token counters, both
  prompt-cache halves included.
- `tldrx run estimate [<run>] [--json]` — the only command that guesses, and it says so. The
  input half is measured (the same prompt assembly and ledger `next` uses); the output half is
  the median output tokens of past attempts at that stage id, and with no history it prints no
  estimate. Prices and context windows live in one dated `[assumption]` file,
  `src/core/budget/modelPrices.ts`.
- `tldrx questions lint [--run <id>] [--fix] [--area <a>]` — names every `questions.md` block
  the §2.7 parser cannot see and exits `2`. `--fix` converts the prose form
  (`### Qn — …` / `**Answer:**`) into the grammar **without changing a word**; it does not
  invent the `[src: …]` token §2.7 wants, it lists the blocks that still need one.
- `tldrx reject --stage <phase>/<stage> --note <t>` — revokes an approval already given,
  whoever signed it. The cursor moves back, one new `gate.revoked` event carries `signed_by`,
  and later stages that had run are marked `stale: true` (additive, cleared when the stage
  re-runs). It is the one verb that may reopen a FINISHED run.
- `tldrx seed triage <path>` — free, offline, no LLM: `inventory.md` + `inventory.json` with
  per-document tokens, headings, cross-links, `Status:`, open markers, and a **code-derived**
  flag set when ≥ 8 distinct path-like tokens it cites resolve to real files. Threshold:
  `--threshold-tokens`, else the new optional `seed_triage.threshold_tokens` in
  `workspace.yml`, else 20,000. Both directions of that heuristic were measured on a real
  design folder (31 files, ~66k tokens): a 152 KB legacy inventory document cites **294**
  distinct path-like tokens and **0** resolve — that repo is a rewrite and those paths belong to
  the system it replaced — so it is *not* flagged, where a rule that counted citations instead
  of resolving them would have called it code-derived and been wrong; `ADR-D005-ORDERING.md`,
  written against the current tree, cites 12 and **8 resolve**, so it *is*. An earlier reading
  the same afternoon said 24 files / ~44k tokens: the folder gained seven ADRs between the two
  runs, which is why the verdict is printed rather than remembered.
- `tldrx seed triage <path> --propose` — ONE sub-agent (effort `low`, `--max-usd 1.00`) that
  proposes a split and **never creates a run**. The answer is validated against *this*
  workspace before a byte is written; failure is whole (exit `5`, no `split.yml`, raw answer
  kept).
- `tldrx seed answer <split.yml> <Qid> "<text>"` — records a decision beside the question. The
  key is human-owned: the propose schema still refuses it, so a model can never write one.
- `tldrx seed apply <split.yml> [--dry-run]` — the human gate. Refuses anything not
  `status: proposed`, revalidates the file you were invited to edit, and creates the runs in
  topological order through the same `createRun` that `run new` calls.
- `tldrx tickets sync|status` — the optional ticket mirror (off unless `process.yml` names a
  `ticket_tool.kind`). GitHub through the `gh` CLI so no token is handled here; Jira through
  REST v3 with `JIRA_BASE_URL`/`JIRA_EMAIL`/`JIRA_API_TOKEN`, a missing one being exit `1`
  naming all three *before* `03-plan/` is read. Both providers take their transport as an
  argument, so **no test in this repo makes an outbound call or spawns `gh`**. New
  `ticket.synced` event (`stage: null`, `cost_usd: 0` — no model ran, and a mirror is not a
  stage).
- `tldrx <command> --help` now answers the question: a one-line description, the positional
  arguments, every flag with its meaning and — where the set is closed — its values, one or two
  real invocations, and the exit codes that command can return with what each means. One
  registry, `src/cli/helpText.ts`, read by the renderer, the argv guard and a drift test.
  Closed sets are imported from where they are enforced (`EFFORT_LEVELS`, `UI_MODES`, the
  `workflows/*.yml` stems on disk), so a help screen cannot offer a value the validator
  refuses. `tldrx --help` gains the same exit table as a legend.

**Gates, money and safety**

- **Gate policy is data.** `workflows/<scope>.yml` carries `gates:` (stage id → `human|auto`);
  `tldrx run new … --gates <a,b|all|none>` overrides it and **names the HUMAN gates**; the
  resolved map is frozen into `run.yml` as an additive `gates_policy:`. Absence means `human`
  everywhere. Shipped defaults keep at least one human gate in every scope.
- **An `auto` gate closes only when it can show its work** — five conditions, all measured off
  files that already exist, all evaluated even after one fails: checks pass, no open question
  in the phase, spend inside the stage and phase ceilings, the stage did not end `failed`, and
  the §2.8 claim-sources validator reports nothing (zero refused **and** zero unverified). The
  §2.8 check runs whether or not the stage listed it under `checks:`. Approval goes through the
  SAME path a person's does, lands `by: auto`, and writes a note carrying every value. No new
  event type was invented: `gate.approved` gained `by`.
- `effort:` in `stage.yml` and `--effort <low|medium|high|xhigh|max>` on the command line — the
  cost lever `--max-budget-usd` is not, because the budget flag can only end a turn already in
  flight. Shipped stage defaults, all `[assumption]`: what `medium`, how `high`, plan `medium`,
  build `high`, watch `low`. Recorded on `agent.spawned`/`agent.result` and every
  `training.jsonl` line, so cost-per-effort becomes measurable rather than arguable.
- **A context ledger, and `prompt_max_bytes` as a refusal.** `--prepare` and `--dry-run` print
  bytes per section and `pending.json` carries the same under `context:`. Over
  `prompt_max_bytes` (default 160 KB, `--prompt-max-bytes` to override) the stage exits `2`
  before anything spawns, naming the biggest sections and the key that shrinks each. The
  model's context window is only ever a stderr warning at 80% — it and the bytes-per-token
  ratio are both `[assumption]`, and refusing on two stacked assumptions would block work the
  framework could have done.
- **`max_reads` — the brake `--max-budget-usd` is not.** Completed `Read`/`Glob`/`Grep` calls
  are counted off the stream that is already arriving (no second model call, no extra tokens)
  and the process tree is killed at the ceiling: 120 for what/how/plan, 200 build, 60 watch;
  `--max-reads` to override. The attempt records `stopped_by: max_reads`, written only when a
  cap bit, and the live view shows `reads 37/120`.
- `tldrx next --commit --cost-usd <n> [--tokens <n>]` — so a host session can declare what its
  own sub-agent cost. Without it the task is `cost_usd: null, metered: false`.
- New `budget.raised` event with before/after for both ceilings, the actor and an optional
  `--note`; `--take-from <phase>` moves money instead of adding it, refusing to cut a donor
  below what it has already spent.
- `map.refreshed` is finally emitted — providers, document count, repo count — recorded against
  the newest OPEN run, and the command says which. It had been in the §2.9 enum and the replay
  renderer since v0 with nothing emitting it.
- `src/cli/signals.ts` — SIGINT/SIGTERM kill the sub-agent's whole process tree, record a
  partial `agent.result` carrying `cost_usd: null` and `stopped_by: "signal"`, demote `running`
  → `ready`, release the lock, restore the cursor and exit `130`. A second signal exits at
  once. A `--prepare` bundle with nothing spawned is left alone.
- **`.tldrx/.lock`, a workspace lock held across read-modify-write.** Two processes appending to
  `facts.yml` each computed `max(id) + 1`, each got `F001`, and the second save erased the
  first fact outright. `FactsStore.update` holds the lock across load → append → save, and
  `run new` holds it across its whole creation.
- Two new waiting kinds, `running` and `prepared`, so a stage killed between `--prepare` and
  `--commit` is no longer reported as `ready` and re-spawned. `tldrx next` refuses to re-spawn
  over a bundle (exit `2`) naming all three ways out; `--discard-pending` is the explicit "bin
  it and run it again". Phases with an executor are exempt — Build stays `running` across
  cycles by design.

**Experts**

- **A stage prompt now carries what its experts LEARNED, not only who they are.** Each loaded
  expert contributes its `expert.md` body, its **star chart** (one line per area, computed from
  evidence) and its **knowledge files**, most-recently-trained first by the file's own
  `trained_at`, never an mtime. The prompt states that those `[src: …]` tokens already resolved
  when the knowledge was accepted and may be reused verbatim as evidence. Measured on a fixture:
  **1,493 bytes → 4,758 bytes**, with both areas' findings inlined.
- **A third expert-loading rule.** `experts:` and `stack_experts:` could not reach an expert
  `init` seeded from this workspace's own folders. Now a `kind: domain` expert whose
  front-matter `repos:` or `## Domain` paths intersect the run's repos or cited paths is loaded
  too — path matches ranked first, capped at 8, deduped, deterministic. A `repos:` match only
  counts in a workspace declaring two or more repos, because in a single-repo workspace it
  selects everybody. Rank is a score: a direct path match is 10, a path within 2 hops in
  `graphify-out/<repo>/graph.json` is 1, scores add, and score 0 means body only. The graph walk
  is undirected, bounded, and degrades to an empty set on a missing or unparseable graph
  (measured: 298 neighbour paths in 14 ms over a 5,091,949-byte graph).
- **`tldrx init` seeds five ROLE experts** — `product`, `architect`, `delivery`, `developer`,
  `operations`, the names the shipped stage files have always listed and of which `init` seeded
  only the first. A role expert's subject is the workflow, so its body ships as an editable
  `templates/experts/<role>.md`, copied in once and yours after that. `kind: role` keeps it out
  of the domain-match rule. Seeding is additive: an existing workspace gains the four missing
  folders and keeps every `expert.md` it had, byte-for-byte. `tldrx expert create <name> --role
  <slug>` writes the same seed on demand, and says which template it used.
- `.tldrx/experts/<name>/training.jsonl` (spec §2.6.1) — the §2.9 envelope with `run` replaced
  by `expert` and `stage` by `area`, because training outlives every run. A REFUSED run still
  writes its `agent.result`: money spent is recorded whether or not the knowledge was kept.
- `kind: test` is a first-class evidence kind at weight 1.0, the same as `code` — a test read or
  run is a direct observation of behaviour.
- `tldrx expert list` gains total **evidence** and per-area **levels** columns, an ASCII star
  chart, and a `loaded by: what (named), how (stack)` line per expert derived from the same
  selection rule `next` runs — so "trained and never loaded" stops being invisible. `--json`
  gains `evidence_count`.
- `tldrx next --prepare` prints one line per loaded expert with its bytes, plus `truncated` and
  `NOT LOADED` where they apply, and `pending.json` gains an `experts:` array with the same
  numbers, the reason each loaded and its knowledge file paths. An expert with zero evidence
  anywhere earns one **stderr** note naming its train command — never a block.

**Knowledge that has to be worth something**

- **A citation must sustain its claim, not only resolve.** Making every `src` resolvable is a
  check on the citation and says nothing about the sentence. An **execution claim** now needs a
  command src — `execution claim needs a '$ <cmd> → exit <n>' src, not a file line` — because a
  real `knowledge/aparece-api.md` asserted `dotnet build` exit 0, "measured, exit code captured
  unpiped", citing `.tldrx/workspace.yml:19`: the line that *declares* the command. It claimed
  "78/78 passed, exit 0" citing a line of the test script. Every citation resolved; none was
  evidence anything ran. The rule reads prose paragraphs as well as bullets, because that header
  IS a paragraph and its tokens sit mid-line where a line-anchored parser never looks. Measured
  after: 7 refusals on that file, 1 on `aparece-platform`, 0 on the third.
- **Three warnings that cost a citation its evidence row without rejecting the file:**
  `paraphrase` (the bullet is ≥ 90% a verbatim substring of the ±3-line neighbourhood of the
  line it cites), `outside domain` (the path is outside the expert's own `## Domain` — and the
  expert whose domain does contain it is named), and `duplicate src` (already on record for this
  expert). None of them is a lie; they are ways of being worth nothing, and the honest response
  is a level that does not move. Measured on the real corpus: 57 outside-domain and 7 duplicate
  warnings across 248 bullets.
- **`## Sources` earns nothing.** It was 41 of 107 bullets in one real knowledge file and 18 of
  56 in another, every one re-citing a source cited above it. It is still validated like any
  other section; it just derives no evidence, and `countFindings` stops counting it.
- **A bullet may carry its own confidence** — ending in `(measured)` / `(inferred)` /
  `(assumed)`, or leading with `*measured* —`, the other spelling the real corpus uses — parsed
  onto the evidence row as `confidence:`. Both spellings are stripped before the execution rule
  matches: inside the annotation the word is a LABEL, and refusing a file for obeying §2.3's own
  "say which of measured / inferred / assumed each claim is" would be the rule being wrong.
- **`tldrx expert list` warns on a shared citation** — `warning: shared citation <file:line> by
  <a>,<b> — check for contradiction`, on stderr, when two experts cite one line with bullets
  whose normalised texts differ. 16 files on the real workspace were cited by two trained
  experts each and nothing compared what the two said. It resolves nothing on purpose: deciding
  which expert is right is not something a deterministic tool can do.
- **The Build executor writes `retro.md` as the run goes.** Role experts train from
  `tldrx-work/<run>/**/{handoff,retro}.md` and nothing else, and all five sat at level 0 because
  `retro.md` existed only when a human typed `tldrx retro`. Build now appends `## Build
  feedback` as each story settles — every reviewer `changes` verdict and finding, every DoD
  command that failed on the first attempt with its exit code, every merge conflict, and (read
  back off `events.jsonl`, since they happen between invocations) every gate rejected and every
  approval revoked, with its note and what it staled. Deterministic, deduped verbatim, every
  bullet carrying a `[src: …]` into the review log or the events line. `tldrx retro` carries the
  section forward instead of overwriting it.

**Dashboard**

- Redesigned, and it now draws in the browser: the model rides inline in a
  `<script type="application/json">` and every view is rendered client-side, so `--static` is
  the same document with no server behind it. Five views behind a hash route — runs, run
  detail, experts, watchers, how-to. `render.ts` stays TypeScript against `DashboardModel`, so
  `tsc --strict` is still on the markup.
- Citations are first-class: `[src: …]` renders as a reference chip and `[assumption]` /
  `[inference]` as a flag, marked in the DOM so the model's `handoffHtml` is styled and never
  re-parsed.
- `runs[].waiting` is the CLI's own `{kind, message, questions}` from one shared derivation
  (`src/core/run/waiting.ts`), and `dependsOn` / `blockedBy` / `runnable` / `order` / `chains`
  come from the same `triage.depends_on` resolver `tldrx status` uses
  (`src/core/run/dependencies.ts`). Two screens, one answer.
- ORDER is the default sort; the first runnable run wears the same `← next` marker the CLI
  prints; chains draw as root-to-leaf PATHS, so every arrow is a real edge. An attention line
  mirrors `tldrx status`.
- Stage rows carry `gatePolicy`, the execution path gains a `signed by` column, and the section
  counts them the way the CLI does.
- The server checks `Host`. A request that does not name `127.0.0.1`, `localhost`, `::1` or the
  host it was told to bind gets 403 before the method check — binding loopback is necessary,
  not sufficient, when a page on a name the attacker owns can point a browser at 127.0.0.1.
  Only the name is compared, never the port, so `ssh -L` and container port maps keep working.

**Build**

- Story branches are `story/<run-id>/<story-id>` and their worktrees
  `.tldrx/worktrees/<repo>/<run-id>-<story-id>`, so two runs of one plan cannot collide.
- An `epic/<slug>` branch this run did not cut is refused (exit `2`, nothing spent) unless
  `tldrx next --reuse-epic`. What the run cut or adopted is recorded as `build.epic_branch`.

### Changed

- **The level ladder weighs findings, not files.** `W = Σ (recency × weight)` with
  `recency = max(0.25, 1 - ageDays/365)`, `weight = code 1.0 · run 1.0 · test 1.0 · answer 0.8 ·
  doc 0.5`, **× 2** when the row is `cross: true` (a finding tying two or more distinct files
  together) and **× 0.5** when `confidence: assumed`. Thresholds `[0.5, 1.5, 3, 6, 20]` (the
  fifth was 12), then three caps in order: no `kind: run` row ⇒ `min(level, 3)`; level 5 needs
  ≥ 2 distinct kinds, else 4; `level ≤ count(distinct src)`. Three things changed here at once,
  and **levels move: run `tldrx expert recompute` after upgrading.**
  - *Reading alone now caps at 3.* Measured: an expert holding 15 `code` + 2 `test` rows, all
    written the same afternoon by one reading session with no command ever executed, computed
    **5/5**. Reading is evidence that code *says* something; only a run is evidence that it
    *does* it. A `run` row is necessary, not sufficient: one alone is `W = 1.0`, level 1.
  - *Recency decays continuously and the 180-day staleness cap is gone.* It was a cliff: an
    expert trained on day 179 and the same expert on day 181 knew identical things and the
    ladder reported 4 and 2. Knowledge fades; it does not expire on a Tuesday. One continuous
    factor, floored at 0.25 so a year-old reading is worth a quarter of a fresh one rather than
    nothing, replaces both the four-band table and the cap.
  - *A cross-file finding counts double, an `assumed` one half.* `cross:` and `confidence:` are
    additive `evidence[]` fields derived from the bullet, never asserted; a row written before
    they existed carries neither and computes as it always did. A model can re-derive anything
    one file says by reading it; what it cannot re-derive is the relationship between two.
- **The training prompt asks for value, not coverage.** It used to say "Citing the same file
  twelve times is worth one row; reading twelve files is worth twelve" — an accurate description
  of the old formula, and a Goodhart instruction. Both prompts (the spawned one and
  `--print-prompt`) now carry the same criterion word for word: a finding is something a model
  could not re-derive by reading that one file once — cross-file contradictions, dead paths,
  defaults that differ from their docstrings, absences written as a negative claim, measured
  commands. Restating a docstring is not a finding.
- **Light mode's file selection is bounded by `## Domain`.** Only files inside the expert's
  declared folders are scored, read or inlined; every file inside them is a candidate even when
  it greps for nothing. Bounding the input is cheaper than warning about the output.
- **One shared knowledge budget, declared inputs first.** `inputs_max_bytes` (default 96 KB) is
  spent on every declared input in declaration order; the loaded experts then share
  `knowledge_max_bytes` (default 48 KB) **in total**, split by rank, never one budget each. The
  retired `expert_knowledge_bytes` is still read, as the same total — a per-expert cap scales
  with a number nobody set, which is how 64 KB became 83,523 measured bytes. Truncation cuts at
  an H2 boundary and appends `… N more findings in …`; a file whose first section already blows
  the budget is named, not half-inlined. Measured on one real stage: `01-what/what` prepared a
  **159,575-byte** prompt — 45% declared inputs, 52% expert bodies and knowledge, eight of its
  nine experts loaded because they shared a repo with the run and not one had read a file the
  run cited — and the 64 KB seed budget had dropped `ADR-D013-DELIVERY-ZONE-GEOMETRY.md`
  (5,863 B) whole, the sixth of the six decisions the run existed to settle, while 70,923 B of
  unrequested knowledge went in untouched. The same prompt is now **85,676 bytes**, loads two
  experts, and contains ADR-D013 in full.
- **The prompt is ordered for the cache**: `stage.md`, expert blocks, `## Inputs`,
  `## Previous attempt` — most stable to least. Measured, two real `claude` 2.1.251 calls, the
  same 40,715-byte prompt, separate processes and sessions: call 1 wrote 37,059 cache tokens
  and cost **$0.074982**; call 2 read all 37,059 back and cost **$0.004550** — 16.5x less.
  `cache_creation_input_tokens` and `cache_read_input_tokens` are now parsed, published on the
  `cost` event and written to `agent.result`.
- **Attempt 2 gets the refused draft.** The declared outputs that exist on disk are inlined
  under `### Previous attempt — edit, do not restart`, capped at 32 KB shared across them.
  Before this, a stage rejected over one missing section paid full price to rewrite four
  documents from a blank page.
- **`claude` is spawned with `--output-format stream-json --verbose`** and the JSONL is parsed
  as it arrives. Verified against one real measured call: `--verbose` is required (without it
  `stream-json` in print mode refuses before spending anything) and `--json-schema` coexists
  with it, the last `result` event carrying `structured_output` exactly as the single-blob
  format did. `resolveResultDoc` reads EITHER format, so an older `claude` still works.
- **A progress view, on by default, on the four commands that make you wait** — `next`,
  `run auto`, `expert train`, `seed triage --propose`. `--ui scene|compact|plain|off` or
  `TLDRX_UI`, `auto` by default. Every summary is derived from bytes the sub-agent was already
  sending: no second model call, no summary agent. **stdout is never written to** — asserted
  end-to-end by comparing stdout with the view on and off — and the cursor is restored on a
  normal exit, a thrown error and Ctrl-C. `--prepare`, `--commit` and `--dry-run` spawn nothing
  and show nothing.
- **Ambiguity is refused rather than guessed.** With more than one open run and no explicit id,
  every run-targeting command exits `2` and lists the candidates. Selectors: positional `<run>`
  on `next` and `run status`, `--run <id>` on the rest. `tldrx run status` with several open
  prints a table and exits `0`; `--json` returns `{ "runs": [...] }`, and the single-run shape
  is unchanged when exactly one is open. Hooks never block on the ambiguity — a refusal
  reaching a `PreToolUse` decision would stop work the human never asked to stop — and the
  status line appends `(+N open)`.
- **An unknown flag is refused instead of ignored.** `tldrx status --nope` exited `0` having
  run with its defaults after being told something it dropped. The guard lives in the
  dispatcher, driven by the help registry, so it covers the commands that never used
  `parseArgs` too, and it scans argv the way `parseArgs` does so a VALUE that looks like a flag
  is not mistaken for one. `hook` and `statusline` forward their argv and are judged not at all.
- **`--json` is supported or it is an error.** It had three behaviours: supported,
  accepted-and-ignored (`doctor`, `watch list`, `tickets status`) and refused (`map --check`).
  `doctor --json` and `watch list --json` now print the data they already had structured;
  everywhere else it is exit `1` with `--json is not supported by <cmd>`. `doctor`'s
  `mcp: null` means NOT PROBED — "no servers" is a different claim.
- **An unknown COMMAND exits `1`, not `64`.** `64` means "on the roadmap, not built", which a
  mistyped word has no business claiming. It is reserved and currently unreachable, and that is
  asserted.
- **`tldrx status` stops counting advice as work.** A freshly initialised workspace printed
  seven numbered items, five of them seeded experts at level 0 repeating the same sentence.
  They collapse into one uncounted line under the blockers, with the trainable ones named and
  one runnable example. `WorkspaceStatus.items` now means BLOCKERS and `pending` counts only
  those; `--json` keeps `items` shape-identical and adds `advice` beside it.
- **`tldrx replay`'s usage stops requiring an id it does not require.** With no id it narrates
  the newest run and refuses (exit `2`) only when several are open.
- **`tldrx tickets sync` previews by default; `--apply` writes.** It is the only verb that
  reaches a third party, and a destructive default on the one networked command is backwards.
  `--provider` no longer switches on a workspace set to `ticket_tool.kind: none` — it picks
  between configured providers, and the config is not a flag's to override.
- **`ticket_tool.sync` means something**: `mirror-out` pushes and reads nothing back;
  `two-way` also pulls each issue's status string, **verbatim**, into `external_status:` and
  into nothing else. The name is generous — the second direction is one opaque string into one
  front-matter key.
- **`version: 1` is the key; `schema_version:` is deprecated for one release.** The spec said
  `version: 1` from the first draft and `tldrx init` has always written it, yet seven skeleton
  validators demanded `schema_version` and seven templates printed `schema_version: 0` — so the
  shipped validators rejected the tool's own output (5 of 5 real files failed on that key; 0 do
  now). One `requireVersion` is the rule everywhere. A file still on the old key LOADS, prints
  `<file>: schema_version is deprecated — say version: 1` on stderr once per process, and is
  listed by `tldrx doctor`. `templates/*.yml` and `env.yml` now say `version: 1`.
- **The DoD gate no longer runs an un-allowlisted command.** `runDodCommand` handed the model's
  own string to `/bin/sh -c` and the hook ships enabled by default with a 960 s timeout: a
  story saying `dod: rm -rf ~` ran it the moment someone marked the story done. A command must
  now be byte-equal to a `workspace.yml` command and is spawned argv-split with **no shell**; a
  bare metacharacter refuses. An EMPTY `commands:` now refuses every dod entry instead of
  permitting anything.
- **`budget-gate` covers every spender and fails CLOSED.** It matched `^(claude -p|tldrx next)`
  only, so `run auto` — the one command that can spend a whole run in one invocation — plus
  `expert train` and `seed triage --propose` walked straight past it. All five are matched and
  priced, and an unreadable `run.yml`/`budget.yml` now denies and names the file: "cannot read
  the budget" is not "the budget is fine". It still allows silently outside a workspace.
- **`--yolo` no longer reaches the reviewer.** `--dangerously-skip-permissions` was passed to
  the read-only reviewer sub-agent, which was the one whose read-only-ness was the point. The
  developer still gets it; that one is meant to write.
- **Unmetered is not zero.** An in-session `--commit` with no declared cost recorded `$0.00`,
  so a ledger could read "$0.00 spent" after real money had gone. Such a task is now
  `cost_usd: null` + `metered: false` (a null cost without the flag is a schema error). Sums
  treat it as nothing, and every report says so: `budget show` and `run status` render
  `unmetered (in-session)` and call `spent` a LOWER BOUND.
- **Build cannot charge 2.5x its phase, and Watch's floor cannot exceed its ceiling.** Build's
  shares are divided by the worst case — stories × attempts × (1 + reviewer share) — instead of
  by story count. Watch refuses BEFORE spawning when N features cannot each get the $0.25 spawn
  floor inside the ceiling, naming the `budget raise` that fits.
- `run.yml` and `budget.yml` are written temp + `rename`, and `budget.yml` ceilings are re-read
  from disk before every write unless this store deliberately changed them — a `budget raise`
  that landed while a stage was in flight used to be silently reverted when that stage saved.
- `EventLog.read` skips an unparseable line instead of throwing. `events.jsonl` is appended line
  by line, so a process killed mid-write leaves half an object on the last line, and `replay`
  reported "events.jsonl could not be read" for a ledger whose first four hundred lines were
  good. Skips are counted, not swallowed: `readAll()` returns `{events, lines, skipped}` and the
  note is printed once per file. Line numbers now come from the reader, so a torn line no longer
  shifts every `L<n>` after it.
- A job stopped halfway now looks stopped halfway: `seed apply` writes `status: applying` before
  the loop and grows `created_runs` after each run; `seed triage --propose` writes its `.agent/`
  bundle in headless mode too; `expert train` writes `knowledge/<area>.md.partial` and renames
  it onto the real name only after the file validates (`.md.partial` never matches `*.md`, so
  nothing half-written can be inlined).
- `tldrx init` and `.tldrx/init-questions.md` both point at `tldrx interview --init`. Measured:
  the `answer-capture` hook returns early unless the path has a `tldrx-work` segment, so a
  hand-typed answer in the init questions file records no fact, logs no event, and never reaches
  the code that writes `process.yml`. The `[Answer]:` slot text stays — `captureAnswers` and
  `tldrx answer` read and write it.
- `tldrx interview --init` applies the two process answers to `.tldrx/process.yml`
  (`methodology`, `ticket_tool.kind`, and for GitHub the `owner/repo` from the git remote), and
  ends with one line saying which happened. The two process questions are reordered so option
  **A** is "None" for both, which makes `--yes-to-defaults` a real default there rather than a
  guess. It remains a guess on the ownership and dead-code questions, so it stays a human's
  flag.
- `tldrx tickets status` validates `process.yml` **before** the no-run check, so a broken
  adapter config is reported as a config error rather than as "no run".
- The SessionStart hook appends up to three lines of the `tldrx status` report after the three
  it always printed, so a session opening on work that is NOT a run — a proposed split,
  unanswered setup questions, untrained experts — is no longer greeted with silence. Nothing
  pending AND no run is still no output at all.
- `--seed` is repeatable: several are merged, deduped and re-sorted, with the 50-file cap
  applied to the merged set rather than per argument. One occurrence is byte-for-byte what it
  always was. `run new --seed` also prints one **stderr** note over the threshold or over 10
  files, naming `tldrx seed triage`.
- `run.yml` gains an optional `triage: {split, depends_on}` block, written only by `seed apply`
  and absent everywhere else.
- The `/tldrx` skill is "status → guide": step 1 is always `tldrx status --json`, then it walks
  the items one at a time, asking when the decision is the human's and acting when the step is
  mechanical, re-running `tldrx status` after each. 199 → 149 lines.
- Package `tldr-experts` now installs two commands, `tldrx` and `tldr-experts`. (Unscoped
  `tldrx` as a package name is refused by npm's similarity rule; 0.0.1–0.2.0 were unpublished
  on 2026-08-29 and their numbers can never be reused, so this is the first version back on the
  registry.) README gains a release table with defined status tags, and npm/CI badges.
- `.claude/settings.json.bak-tldrx-*` is gitignored — `install --claude` backs the file up
  before merging into it, and that backup was the one thing the framework writes that nothing
  ignored.

- **Documented, from measurement: `--max-budget-usd` is a stop, not a cap.** `--max-usd 1.5`
  over two repos: the sub-agent was killed with `error_max_budget_usd` ("Reached maximum budget
  ($1.5)") **after** `total_cost_usd: 5.15325`, on a single turn (597 s, 105,698 cache-creation
  + 60,548 output tokens, 1M-context model). The flag ends a run once a turn's cost is known; it
  cannot end a turn already in flight. Budgets gate before and reconcile after, and overshoot is
  bounded by one turn. The pipeline itself held: a non-zero `claude` exit is a failed run, so
  nothing reached `competencies.yml`, the $5.15 was recorded in `training.jsonl`, and the
  knowledge file the agent had already finished writing was **quarantined** — it would in fact
  have validated (111 sourced items, 21 distinct files, level 5), which is exactly why leaving
  it where an accepted one lives would have been the dangerous outcome.
- **Documented, from measurement: nested `claude -p` works; the ceiling was the constraint.** A
  cold session pays ~10–26k cache-creation tokens before its first reply, so any
  `--max-budget-usd` under about $0.25 fails as `error_max_budget_usd` before work starts. That
  is why every spawn has a $0.25 floor and refuses below it. `--prepare`/`--commit` survives
  because it is *cheaper* and because it works where spawning is disallowed — not because
  spawning fails.

### Fixed

- **`claim-sources` verified six `src` kinds it used to wave through.** Measured probe: a
  handoff citing `[src: F999]`, `[src: Q42]`, `[src: graph:i-made-this-up]` and
  `[src: absent:ops/backup.yml]` to assert "we removed the auth check from /admin" validated
  CLEAN, closed its own auto gate and advanced the cursor — `resolveSrc` returned `ok` by
  default for six of eight kinds. Now `F<n>` must be a live (non-retired) row in `facts.yml`,
  `Q<n>` a question this run actually asked, `graph:<node>` a node in the graph or a token named
  in `.tldrx/map/`, and `absent:` may only source a NEGATIVE claim (`## Unknowns` is exempt —
  that heading IS the negation). A third outcome, **`unverified`**, sits between ok and refused
  for what cannot be checked offline; it never fails a stage, it stops an auto gate.
- **A `[src: …]` wrapped in backticks is a citation, not a missing one.** `TRAILING_TOKEN_RE`
  was anchored to end-of-line, so `` `[src: x]` ``, `[src: x].` and `([src: x])` all read as
  unsourced. A real user's first `tldrx next` was refused with "9 unsourced bullet(s)" when all
  nine carried citations — $0.40 spent to be told the work had no evidence. Closing quotes,
  brackets and terminal punctuation after the `]` are now ignored; words after it still are not.
  A line that TRIED to cite gets `malformed citation on line N`, not `unsourced bullet` — the
  two need different advice.
- **An auto gate can no longer be closed by silence.** Three ways it could be: condition 5
  counted only refusals, so an unverifiable citation passed (it is now zero refused AND zero
  unverified); a stage that declared `questions.md` as an output and wrote one the §2.7 parser
  could not read had "0 open questions" recorded as satisfied — a real stage wrote
  `### Q1 — …` / `**Answer:**`, copied faithfully from this repo's own `templates/questions.md`,
  and the gate signed itself over four unanswered questions (unreadable or empty now falls to
  the human gate naming the ids it could not see, and `next --commit` refuses the same file with
  exit `5`); and `templates/questions.md` IS the grammar now, with one worked example, inlined
  into every `stage.md` that may write questions.
- **An approval could not be revoked.** `approve()` moves the cursor in the same transaction
  that signs the gate, and `reject` only ever looked at the cursor, so the probe above met
  `REJECT REFUSED: nothing to reject`. A machine that can sign but cannot be overruled is not a
  gate — hence `reject --stage` above.
- **`--print-prompt` told everyone they had no repos.** `expert train … --print-prompt` handed
  `loadWorkspaceFile` the `.tldrx/` directory, but that function joins `.tldrx/workspace.yml`
  onto its argument — so it looked for `<root>/.tldrx/.tldrx/workspace.yml`, threw, and a bare
  `catch` turned the failure into an empty list. Every printed prompt on every real workspace
  said "none declared … run `tldrx init` first". It names them now, `tldrx map` and
  `tldrx expert` agree about what that function takes, and a genuine read failure prints a
  warning on stderr instead of disappearing. The headless path never had the bug.
- **`kind: test` was dropped without a word.** The evidence kinds were `code`, `run`, `doc`,
  `answer`; the train prompt said to write `{kind, src, at}` and never said which kinds exist; a
  session wrote two `kind: test` rows and both vanished on read, so `expert list` printed 15
  evidence over a file holding 17. `test` is a first-class kind now, the prompt lists all five
  with a one-line meaning each (rendered from a total record, so adding a kind without
  explaining it will not compile), and an unrecognised kind is never silent again — `expert
  list` (stderr, so it survives `--json`), the dashboard model and training's merge all report
  `N evidence row(s) ignored — unknown kind '<x>'`.
- **Light-mode training was structurally incapable of exceeding level 3.** `codeEvidence`
  dropped every `cmd` ref on the floor, so a sub-agent that ran the suite and cited
  `[src: $ npm test → exit 0]` earned nothing for it — and the new run cap then held it at 3
  whatever it measured. One `run` row per distinct command **and exit code** now. The training
  prompt also said "do not run anything" while `allowedTools` already granted a
  `Bash(<command>)` per `workspace.yml` command; it now names those commands verbatim from the
  same list that becomes the grant, forbids everything else, and says that citing
  `[src: $ <cmd> → exit <n>]` is the only way the expert earns a `run` row.
- **An evidence `src` is validated against its `kind`, both directions.** Nothing checked
  before, so `{kind: run, src: "the tests pass"}` counted as a run — one row's difference
  between level 3 and level 4. The §2.8 grammar decides now, through the same `classifySrc` the
  `claim-sources` hook uses. Reading warns and drops (a `competencies.yml` may have been
  hand-edited); writing refuses outright, because everything reaching it was derived by the
  framework from a file the framework already validated.
- **The stage files named experts that `init` never seeds.** Measured on a real workspace whose
  `.tldrx/experts/` held `product`, `dotnet-stack` and seven domain experts: four of the five
  role names resolved to nothing and every How, Plan, Build and Watch run printed
  `expert <name> — NOT LOADED`. Fixed by seeding the five roles; a stage naming an expert that
  genuinely does not exist still says so.
- **A run nobody has started is `ready`, not "waiting at a gate".** The dashboard model derived
  `pendingGate` from the stage gate objects — the first whose `gate.status` is `pending`, which
  on a fresh run is every stage, because `pending` is the value the field is born with.
  Measured on eight freshly applied runs: the page drew **8 red "waiting on a human" cards**
  while `tldrx run status --json` said `waiting: {kind: "ready"}` for all eight. **0 cards
  after.** `pendingGate`/`pendingQuestion` survive one release as documented aliases.
- Only a gate, a question or a failure raises an alert on the page: `ready` reads
  "ready — `tldrx next <id>`" in the WAITING ON column instead of the blank "nothing" that made
  a startable run look finished, and a run waiting behind a sibling raises nothing at all.
- Re-rendering the dashboard keeps the reader's place: handoff panel ids are derived from run +
  phase rather than render order, so a `reload` restores the open panel and the scroll offset.
  Verified live — scroll, route, open panel and all 180 citation marks survived.
- A dashboard path row is marked "waiting" only when the run is actually stopped at that stage
  (every downstream gate also reads `pending`, which had painted four rows of five as an alert),
  and the competency radar's viewBox was widened and its axis labels clipped to fit — a
  24-character area name used to overflow the chart.
- **An ADR's status is read from the document, not from the cached inventory**, and `statusOf`
  recognises a bulleted status line. Measured: thirteen ADRs, every one of them writing
  `- Status: proposed — owner decision pending`, and the inventory reported `adrStatus: null`
  for all thirteen. The field whose whole job is "is this document still current" answered "no
  idea" for the commonest form there is.
- **A recycled pid made a `.lock` permanent.** `kill(pid, 0)` said alive forever, `next` exited
  `2` forever, and the fix was knowing to delete a gitignored file by hand — hence
  `run unlock`. And `cancelled` was a status in the schema with nothing that could write it, so
  a run you had given up on stayed open forever and made every id-less command ambiguous —
  hence `run cancel`.
- **Ctrl-C did not reach the sub-agent.** There was no signal handler on the run path at all.
  A sub-agent is spawned detached (a timeout needs a process group to kill), so the terminal's
  Ctrl-C never reached it: it kept running with `ppid 1`, kept billing against its
  `--max-budget-usd`, and because a stage's cost is only written after the spawn returns, not a
  cent of it appeared in `events.jsonl`. `dashboard` and `watch` keep their own exit-0 shutdown.
- **Four runs of one plan all cut `story/S1`.** The second found the branch already there,
  `git worktree add` checked it out as it stood, and one run's commits landed on another's
  branch — and the fourth reused the third's LIVE worktree, so two sub-agents were editing the
  same files at the same time. Neither name can collide now.
- **`bun dist/tldrx.js` printed `Â·` where `node dist/tldrx.js` printed `·`.** The bundle was
  correct UTF-8 all along; the `// @bun` header `bun build` emits tells the Bun *runtime*
  "already transpiled, load raw", and on bun 1.3.14 that path decodes the file
  byte-per-character. `scripts/build.ts` strips the marker from every emitted file, and `cmp` on
  the two runs is exit 0 — measured cost, ~4 ms per Bun start over ten `--version` runs. A test
  runs the built bundle under both and compares bytes.
- `bun test` no longer prints `fatal: Needed a single revision` twice: `execFileSync` inherits
  the child's stderr, and the two assertions that prove Build cut no branch leaked git's
  complaint into every run. The assertions are unchanged and still rest on the exit code.
- **The `/tldrx` skill's "PRE-ALPHA — some commands are still stubs and exit 64" warning was
  false** (`grep -rn "implemented: false" src/cli/commands/` comes back empty). It says alpha
  now, points at `tldrx --help` as the authority, and writes down three things a real session
  spent five minutes reverse-engineering out of `dist/tldrx.js`. The skill and the README also
  say plainly that `.tldrx/` and `tldrx-work/` are **committed**, and that `init` gitignores
  exactly five machine-local paths.
- README and ROADMAP stop claiming a release that has not happened: both `npm i -g` lines say
  so and keep the commands, and ROADMAP's four "shipped in 0.3.0" become "on main, unreleased
  (0.3.0 pending tag)". `dashboard` is off the README's "refuses on ambiguity" list — it draws
  every run in the workspace, so it has no single run to be ambiguous about.

### Removed

- **`gate.requires:` — from all five shipped stage files and from `StageGate`.** Nineteen
  acceptance sentences that no gate enforced and no agent ever read: `normaliseGate`
  (`src/core/run/workflowPreset.ts:216-231`) takes `.type`, `validateStage`
  (`src/core/schemas/stage.ts:72-76`) checks `gate.type`, and the prompt ships `stage.md`, never
  `stage.yml`. Removed from the type only — the validator never inspected the key, so a stage
  library that still declares it keeps validating. The enforcement that IS real is `checks:`.
- **The placeholders `domain` and `stack` from the shipped `experts:` lists.** Neither was ever
  an expert NAME: `stack_experts: true` already loads `<lang>-stack` for the run's repos, and a
  `kind: domain` expert is picked by the paths the run cites. A forked or older stage file that
  still lists them keeps working and gets ONE note — `experts: domain/stack are selected by
  rule, not by name` — instead of a NOT LOADED line on every stage of every run. That line is
  the one that matters when a real name is misspelled, and an operator who sees it every time
  stops reading it.

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
