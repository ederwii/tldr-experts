# Changelog

## 0.3.0 — unreleased

### Stars are earned by measuring, not only by reading

- **Level ladder: ≥4 needs a `run` evidence row, 5 needs two kinds + 20 weighted
  (fifth threshold 12 → 20).** Measured 2026-08-29 on a real workspace: an expert
  holding 15 `code` + 2 `test` rows — all written the same afternoon by one reading
  session, no command ever executed — computed **5/5**. Reading is evidence that code
  says something; only a run is evidence that it does it. The §2.6 formula now applies
  five steps in a fixed order: thresholds `[0.5, 1.5, 3, 6, 20]` → staleness cap (≤2
  when the newest row is over 180 d) → **run cap** (≤3 when the area has no `kind: run`
  row) → **top-rung kinds check** (level 5 needs ≥2 distinct kinds, else 4) → distinct-
  source cap. A `run` row is necessary, not sufficient: one alone is `W = 1.0`, level 1.
  **Experts trained by reading alone now cap at 3; run `tldrx expert recompute` to see
  the new levels.** The `--print-prompt` training prompt now says so and gives the row
  shape for a command — `{kind: run, src: "$ <cmd> → exit <n>", at: …}`, one row per
  command with its exit code. (This entry originally ended "the headless light-mode
  prompt says the opposite, and honestly: it is a reading task that may not run
  anything, so it tops out at 3." That was not honest, it was a bug — see *Light-mode
  training can reach level 4* below.)

### Three bugs an in-session training walked into

All three were measured on a real workspace (2026-08-29) before they were fixed,
and all three are the same shape: something the tool refused to do, silently.

- **`--print-prompt` told everyone they had no repos.** `expert train … --print-prompt`
  handed `loadWorkspaceFile` the `.tldrx/` directory, but that function joins
  `.tldrx/workspace.yml` onto its argument — so it looked for
  `<root>/.tldrx/.tldrx/workspace.yml`, threw, and a bare `catch` turned the failure
  into an empty list. Every printed prompt on every real workspace said "none declared
  in `.tldrx/workspace.yml` — run `tldrx init` first", including on workspaces with
  repos declared. It now names them, `tldrx map` and `tldrx expert` agree about what
  that function takes, and a genuine read failure prints
  `warning: could not read .tldrx/workspace.yml: <reason>` on stderr instead of
  disappearing. The headless training path never had the bug — it reads the file
  through `loadWorkspace(root)`, which joins correctly.
- **`kind: test` was dropped without a word.** The evidence kinds were `code`, `run`,
  `doc`, `answer`; the train prompt said to write `{kind, src, at}` and never said
  which kinds exist; a session wrote two `kind: test` rows for two test-file citations
  and both vanished on read, so `expert list` printed 15 evidence over a file holding
  17 and computed the level from the 15. **`test` is now a first-class kind at weight
  1.0**, the same as `code` — a test read or run is a direct observation of behaviour.
  The prompt now lists all five kinds with a one-line meaning each (rendered from a
  total record, so adding a kind without explaining it will not compile). And an
  unrecognised kind is never silent again: `expert list` (stderr, so it survives
  `--json`), the dashboard model (a warning line) and training's merge all report
  `warning: <expert>/<area>: N evidence row(s) ignored — unknown kind '<x>'
  (allowed: code, run, test, doc, answer)`.
- **`tldrx expert recompute [<name>] [--json]`** — new. Only the headless/`--commit`
  training path ever wrote a `level`, so a human who pasted the printed prompt into
  their own session (a supported path) ended with `level: 0` on disk while the §2.6
  formula computed 5, and `expert list` and the dashboard warned about the
  disagreement forever with nothing but a text editor to settle it. `recompute`
  recomputes and writes `level` for every area of one expert, or of every expert when
  no name is given, reusing the training path's reader and serializer so the file
  shape is identical. One line per area — `name/area: level 0 → 5 (17 evidence)` or
  `level 5 unchanged (17 evidence)`. Idempotent: a second run re-serializes to the
  same bytes and writes nothing. It does **not** touch `status` or `last_trained` —
  it is arithmetic over evidence already on disk, not a training run — and spawns
  nothing. Exit `3` for an unknown expert. The drift warning now names it as the
  remedy, and the printed prompt ends by telling the session to run it.

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

### Light-mode training can reach level 4

- **A cited command is now a `run` evidence row.** `codeEvidence` mapped `file`→`code`,
  `doc`→`doc` and `fact`→`answer` and dropped every `cmd` ref on the floor, so a
  sub-agent that ran the suite and cited `[src: $ npm test → exit 0]` earned nothing for
  it. Set against the run cap shipped above — no `kind: run` row means `level =
  min(level, 3)` — that made `tldrx expert train --mode light` structurally incapable of
  exceeding 3, whatever it measured. The ladder and the harness disagreed and the
  harness was wrong: spec §2.6's "where evidence comes from" table has always said a
  `run` row is written when a knowledge file cites a command that was executed. One row
  per distinct command **and exit code**; a command `.tldrx/workspace.yml` does not
  declare is rejected exactly as before, and takes the whole knowledge file with it.
- **The training prompt no longer forbids what the tool allows.** It said "do not run
  anything" while `allowedTools` already granted a `Bash(<command>)` for every command
  in `workspace.yml` — the instruction won, so no training run ever executed anything.
  It now names those commands verbatim (from the same list that becomes the grant, so
  the two cannot drift), forbids everything else — no installs, no ad-hoc shell, no
  product-code edits — and says that citing `[src: $ <cmd> → exit <n>]` is the only way
  the expert earns a `run` row. Where `workspace.yml` declares no command there is no
  `Bash` grant at all, and the prompt says so: no `run` row is reachable in that
  workspace and level 3 is the honest ceiling.
- **An evidence `src` is validated against its `kind`, both directions.** Nothing
  checked before, so `{kind: run, src: "the tests pass"}` counted as a run — one row's
  difference between level 3 and level 4. The §2.8 grammar now decides, through the same
  `classifySrc` the `claim-sources` hook uses: `code`↔`file`, `run`↔`cmd` or a
  `tldrx-work/…` artefact, `test`↔`file` or `cmd`, `doc`↔`https`, `answer`↔`F<n>`.
  **Reading** warns and drops, through the channel unknown kinds already used —
  `warning: <expert>/<area>: N evidence row(s) ignored — malformed src '<x>'` /
  `— kind 'run' needs a … src` — because a `competencies.yml` may have been hand-edited.
  **Writing** refuses outright (exit 1): everything reaching it was derived by the
  framework from a knowledge file the framework already validated, so a bad row there is
  a bug, and a bug that writes itself into the star chart is a bug nobody finds.
  A hand-written `run` row that really is a command is accepted and counts, as before.
### Seed triage — a big seed is several runs, not one expensive one

- **`tldrx seed triage <path>` counts a seed before anyone pays for it.** Free,
  offline, no LLM: it collects the documents with exactly the `--seed` rules and
  writes `inventory.md` + `inventory.json` — per document, its size in tokens, its
  headings, which other seed documents it links to *or names by filename*, its
  `Status:` line, its open markers (`TODO`/`TBD`/`open question`/`??`), and whether
  it is **code-derived**. That last flag is the only judgement in the file and it
  resolves before it counts: a document is code-derived when ≥ 8 distinct path-like,
  non-documentation tokens it cites are **real files** under the workspace root or a
  repo in `workspace.yml`. Citing `src/Foo.cs` proves nothing; citing eight paths
  that all exist means the code says the same thing and the model can read it
  instead. Ends in one verdict line that names the next command. Threshold:
  `--threshold-tokens`, else `seed_triage.threshold_tokens` in `workspace.yml`
  (new, optional, validated), else 20,000.
- **`--propose` is one cheap model pass and creates nothing.** One sub-agent, effort
  `low`, `--max-usd 1.00`, spawned the way `next` and `expert train` spawn theirs —
  same `--json-schema`, same `--prepare`/`--commit` handshake, same bundle. The
  prompt carries the inventory and the documents under a 120 KB budget: everything
  whole if it fits, otherwise the small ones whole plus **complete heading lists and
  a 2 KB prefix** for the rest, with every truncation named and byte-counted, because
  a model that thinks it read a 152 KB design document and read 2 KB of it will
  propose a split with great confidence. The answer is validated against *this*
  workspace before a byte is written — scope against the workflows on disk, seeds
  against the inventory, slugs against `run new`'s own regex, `depends_on` for
  cycles, and every `why[].src` against a `seed:<rel>#<heading>` / `seed:<rel>:<line>`
  grammar that is deliberately **not** part of §2.8 (widening the handoff's `[src: …]`
  rule to cover documents no run has yet would loosen the one check that keeps
  handoffs honest). Failure is whole: exit `5`, no `split.yml`, raw answer kept.
- **`tldrx seed apply <split.yml>` is the gate, and it is a separate command on
  purpose.** "The model proposed it" and "we are doing it" must not be the same
  event. Apply refuses anything that is not `status: proposed`, revalidates the file
  a human was invited to edit, and creates each run in topological order through the
  same `createRun` that `tldrx run new` calls. `--dry-run` prints the exact
  `tldrx run new …` lines. If a run directory already exists it **stops there**,
  exit `1`, naming the collision *and* the runs already created and left in place —
  partial application is a real state and pretending otherwise is how people lose
  work.
- **`--seed` is repeatable** (`--seed a.md --seed docs/`): merged, deduped, re-sorted,
  with the 50-file cap applied to the merged set rather than per argument. One
  occurrence is byte-for-byte what it always was. This is what lets apply hand each
  run its own subset.
- **`run new --seed` hints, on stderr.** Over the threshold or over 10 files it adds
  one line naming `tldrx seed triage`. stderr, never stdout — a chat bridge parses
  stdout, and a note is not a result.
- **`run.yml` gains an optional `triage: {split, depends_on}` block**, written only by
  `seed apply`. Absent everywhere else, so an untriaged `run.yml` is byte-identical to
  what it was.
- Measured on a real design folder (`~/aparece-v2/docs/domain-design`, 2026-08-29
  16:25 local): `seed: 31 files, ~66k tokens — above the 20k threshold`. Both sides
  of the code-derived heuristic fired correctly on it. The 152 KB legacy inventory
  document cites **294** distinct path-like tokens and **0** of them resolve — that
  repo is a rewrite and those paths belong to the system it replaced — so it is
  *not* flagged; a rule that counted citations instead of resolving them would have
  called it code-derived and been wrong. `ADR-D005-ORDERING.md`, written against the
  current tree, cites 12 and **8 resolve** (`src/Aparece.Platform/Outbox/OutboxMessage.cs`
  and friends), so it *is*. An earlier reading the same afternoon said 24 files /
  ~44k tokens; the folder gained seven ADRs between the two runs, which is what a
  live design folder does and why the verdict is printed rather than remembered.
### Training now reaches the work it was paid for

- **A stage prompt carries what its experts LEARNED, not only who they are.**
  Measured 2026-08-29 on a fixture whose `product` expert held a validated
  `knowledge/loyalty.md` and a level-3 area: `tldrx next --prepare` produced a
  **1,493-byte** prompt holding three `expert.md` bodies, **zero** occurrences of
  the string "knowledge", zero stars, and none of the expert's 646 bytes of
  findings. `tldrx expert train` wrote a level; nothing that did the work ever read
  it. Each loaded expert now carries, after its `expert.md` body, its **star chart**
  (one line per area, computed from evidence — §2.6) and its **knowledge files**,
  most-recently-trained area first by the file's own `trained_at`, never an mtime.
  Same fixture after: **4,758 bytes**, both areas' findings inlined with their
  citations. The prompt states that the `[src: …]` tokens on those bullets already
  resolved when the knowledge was accepted and may be **reused verbatim as
  evidence** — otherwise the sub-agent re-derives what it was just handed.
- **A per-expert byte budget, `expert_knowledge_bytes:` in `stage.yml`** (spec §2.3),
  default **64 KB**, one knob and no second one. Truncation cuts at an **H2
  boundary** — half a bullet is a claim with its citation torn off — and appends an
  explicit `… N more findings in .tldrx/experts/<name>/knowledge/<area>.md`. A file
  whose first section already blows the budget is named, not half-inlined.
- **Domain experts load without a stage naming them.** Spec §2.3 gave two rules
  (`experts:` and `stack_experts:`), and neither can reach an expert `init` seeded
  from THIS workspace's folders. Worse, the names the shipped stage files use —
  `domain`, `stack`, `architect`, `delivery`, `operations` — are names `init` never
  writes (`planExperts.ts` seeds `product`, `<lang>-stack` and one per source
  folder), and `loadExpertBodies` skipped every one of them in silence. A third rule:
  a `kind: domain` expert whose front-matter `repos:` or `## Domain` paths intersect
  the run's repos or its cited paths is loaded too, path matches ranked first, capped
  at 8, deduped, deterministic. A stage naming an expert that does not exist now says
  `expert domain — NOT LOADED: no .tldrx/experts/domain/ in this workspace`.
- **You can see what the sub-agent was given.** `tldrx next --prepare` / `--dry-run`
  prints one line per expert — `expert product (stage) — expert.md 280 B, knowledge
  1.1 KB over 2 areas`, plus `truncated` when it bit — and `pending.json` gains an
  `experts:` array with the same numbers, the reason each loaded, and its knowledge
  file paths. `tldrx expert list` gains a `loaded by: what (named), how (stack)` line
  per expert, derived from the same selection rule, so "trained and never loaded"
  stops being invisible.
- **A stub expert says so, once, on stderr.** An expert loaded with zero evidence in
  every area earns `note: expert <name> has no evidence — \`tldrx expert train <name>
  --area <area>\` before this stage would help`. It never blocks and never changes an
  exit code; `--prepare`'s stdout stays parseable.
- `tldrx expert train` now inlines the expert's own prior knowledge too, so a second
  training run can see what the first one found instead of rediscovering it and
  writing a second copy of the same finding.

### Auto gates: humans where judgement is needed, the harness everywhere else

Every stage still ENDS at a gate — nothing is skipped, `gate.requested` is still
appended, the run still stops. What is new is that a gate can say **who closes it**.

- **Gate policy is data.** Each `workflows/<scope>.yml` carries `gates:` — stage id ->
  `human | auto` — and `tldrx run new … --gates <stage,stage|all|none>` overrides it
  (the list is the HUMAN gates; an unknown stage refuses to create the run). The
  resolved map is frozen into `run.yml` as an additive optional `gates_policy:`, so a
  run keeps the policy it was opened with even after the workflow file changes.
  **Absence means `human` everywhere**: a `run.yml` from before this key, a workflow
  with no `gates:` block, a stage the map does not name. Shipped defaults keep at least
  one human gate in every scope — `feature` is what=human, how=auto, plan=human,
  build=auto, watch=human; `docs` `spike` `prototype` `upgrade` are auto except their
  last stage; `hotfix` `security-patch` `migration` add build=human. `--gates none` is
  the only way to get an all-auto run, and it is a thing you type on purpose. Spec §2.4's
  `gates.collapse` stays reserved and is skipped by the parser rather than read as a
  stage id.
- **An `auto` gate closes only when it can show its work.** Five conditions, all
  measured off files that already exist: the stage's declared checks pass, the phase's
  `questions.md` has no open block, the spend is inside both the stage ceiling and the
  phase ceiling, the stage did not end `failed`, and the §2.8 claim-sources validator
  reports nothing. That last one is run **whether or not the stage listed it under
  `checks:`** — a stage file that forgot to list it must not thereby buy itself a
  cheaper gate. All five are evaluated even after one fails, because "which one stopped
  it" is the first question anybody asks. The approval goes through the SAME `approve`
  path a person uses (checks re-run off disk), lands `by: auto` and `at` on the gate,
  and writes a note carrying every value: `auto-gate: checks=claim-sources:passed;
  questions=0 open; budget=$0.42 of $6.00 stage, phase 01-what $0.42 of $6.00;
  status=awaiting_gate; claim-sources=passed`. The existing `gate.approved` event now
  carries `by` in its payload; **no new event type was invented**. Any condition failing
  falls back to the human gate exactly as before — exit 4 — and prints which one and
  what it measured. `next` still runs exactly one stage per invocation.
- **`tldrx run auto [<run>] [--max-usd <n>] [--until <stage>] [--model <m>]
  [--effort <level>] [--yolo]`** is the loop: `next`, over and over, until a human gate
  or an open question (exit 4), a failure (exit 5), a budget refusal (exit 2), `--until`
  reached or the run finished (exit 0). It holds no state — every iteration re-reads
  `run.yml` — so killing it leaves a run `tldrx next` picks up unchanged. One stdout
  line per stage, derived from the events each invocation appended rather than from the
  cursor, so a `skip_if` stage gets its own line instead of being swallowed:
  `01-what/what … done $1.21 · auto-approved`. `--max-usd` is a ceiling on the LOOP's
  total spend on top of every stage's own, checked **between** stages — a turn already
  in flight is never cut off, so it can overshoot by at most one stage's share, and the
  message says so. `--until <stage>` stops **before** running that stage. Headless only:
  `--prepare`/`--commit` stay per stage, because they are a handshake with a host
  session and a loop that stopped after every `--prepare` would be `next` with extra
  words.
- **`tldrx run status` says who signs what.** A `gates` block on the terminal screen
  (`gates   1 human, 1 auto` then one line per stage: `01-what/what  human  approved by
  alan` / `02-how/how  auto  approved by auto`), printed for every run including an
  all-`human` one — an answer that only appears once you have opted in is an answer
  nobody finds. `--json` gains two additive keys, `gates_policy` (every stage filled in;
  an old run.yml reports all `human`) and `gates` (one row per stage carrying `by`); every
  existing key keeps its position. The dashboard model gains `gateBy` alongside the
  unchanged `gate` string.
### The experts the stage files ask for now exist

- **`tldrx init` seeds five ROLE experts: `product`, `architect`, `delivery`,
  `developer`, `operations`.** These are the names the shipped stage files have
  always listed, and `init` seeded only the first: measured 2026-08-29 on a real
  workspace (`~/aparece-v2`), whose `.tldrx/experts/` held `product`,
  `dotnet-stack` and seven domain experts, four of the five resolved to nothing
  and every How, Plan, Build and Watch run printed `expert <name> — NOT LOADED`.
  A role expert's subject is the WORKFLOW, not a folder — what its stage is
  accountable for, what it must refuse, what it cites, what it hands over — so
  its body ships as an editable file at **`templates/experts/<role>.md`** and is
  copied in once, front matter and H1 filled, every other byte left alone.
  `kind: role` keeps it out of the domain-match rule: a role loads because a
  stage named it, and for no other reason. Seeding is additive — an existing
  workspace gains the four new folders on the next `init` and keeps every
  `expert.md` it already had, byte-for-byte.
- **`tldrx expert create <name> --role <slug>`** writes the same seed on demand,
  from the same template. A slug the framework ships no template for falls back
  to the generic `templates/expert.md` with `kind: role`, and the CLI says which
  of the two it used — "a role expert" and "an empty folder wearing a role's
  name" are otherwise identical from the outside. `--domain` and `--stack` are
  unchanged.
- **The placeholders `domain` and `stack` are retired from the shipped
  `experts:` lists.** Neither was ever an expert NAME: `stack_experts: true`
  already loads `<lang>-stack` for the run's repos, and a `kind: domain` expert
  is picked by the paths the run cites. A forked or older stage file that still
  lists them keeps working and gets ONE note — `experts: domain/stack are
  selected by rule, not by name` — instead of a NOT LOADED line on every stage
  of every run. That line is the one that matters when a real name is
  misspelled, and an operator who sees it every time stops reading it.
- **`tldrx expert train <role> --mode light` is refused (exit 1) before anything
  is spawned or spent.** Light mode's pre-pass is a keyword grep over the
  expert's repos, seeded from the area id — right for `checkout`, wrong for
  `architect`: either nothing scores and one paid sub-agent writes four
  `absent:` sections that earn no evidence, or something scores because the file
  happens to contain the word. `--mode full` on a role expert runs the runs pass
  ALONE (one sub-agent, the whole ceiling as its share) over
  `tldrx-work/<run>/**/{handoff,retro}.md`, which is the record of how this
  workflow actually ran. Full mode with no matching run is refused the same way:
  a sub-agent spawned to write `- none [src: absent:tldrx-work]` costs real
  money to learn what the deterministic pre-pass already knew. A seeded role
  area's `train_prompt` therefore says `--mode full`.

### Open Claude Code, type `/tldrx`, and it already knows what is waiting

The question this answers, in the owner's words: "can I just open Claude, type
`/tldrx`, and have it find the pending work by itself and guide me through it?"
The answer was no. With no run open, `tldrx run status` exits 3 and the skill could
only ask "what do you want to open?" — while the pending work sat on disk in four
places nothing read as one list.

- **`tldrx status [--json]`** — one report of everything waiting on a human in this
  workspace, in the order the sources block each other: open questions in
  `.tldrx/init-questions.md`; every `.tldrx/triage/*/split.yml` still
  `status: proposed`, with its runs, its unanswered `questions`, the seed documents
  whose own `Status:` line still says `proposed` and any `DECISIONS*.md`; every open
  run with the exact command it needs; and every expert a stage will load that has
  zero evidence. Each item is `[n] <one sentence> → <exact command>`, and `--json`
  gives `{root, pending, items[]}` with `{kind, summary, command, details}` per item.
  Deterministic and read-only — no model, no network, nothing written — and it
  **exits 0 whatever it finds**, because it is a report and "nothing pending" is a
  complete answer. Exit `3` means only that there is no `.tldrx/` here.
- **Runs are dependency-aware.** A run created by `tldrx seed apply` records
  `triage.depends_on`; a run whose dependency is not `done` shows `blocked by
  <slug>` and is offered NO command, however loudly its own cursor says `ready`. The
  first run that is unblocked and actionable is marked `← next`, and only that one
  is offered `tldrx run auto`.
- **An ADR's status is read from the document, not from the cached inventory.** A
  status recorded at triage time keeps reporting a decision as open for exactly as
  long as the decision took to make. Related: **`statusOf` now recognises a bulleted
  status line.** Measured 2026-08-29 on a real workspace — thirteen ADRs, every one
  of them writing `- Status: proposed — owner decision pending`, and the inventory
  reported `adrStatus: null` for all thirteen. The field whose whole job is "is this
  document still current" answered "no idea" for the commonest form there is.
- **A run folder that does not validate gets its own item.** `RunStore.findOpen`
  skipping it is right for every command that ACTS on a run and wrong for a report
  that promises "this is everything" — the alternative was printing `nothing
  pending` at a workspace that visibly holds a run.
- **`tldrx next` with no run open prints the report first**, then its unchanged
  exit-3 line. That refusal always said what was missing and never what to do
  instead.
- **SessionStart says what is pending, not only where a run is.** The hook returned
  early when there was no run, so a workspace holding a proposed split, four
  unanswered setup questions and five untrained experts greeted its next session
  with silence. It now appends up to three lines of the same report after the three
  it always printed. Still non-blocking, still fails open; nothing pending AND no
  run is still no output at all.
- **The `/tldrx` skill is "status → guide".** Step 1 is always `tldrx status
  --json`; it then walks the items one at a time, in order, in plain language,
  asking when the decision is the human's (init answers, split edits, ADRs, gates,
  questions) and acting when the step is mechanical (`seed apply --dry-run`,
  `next --prepare` … `--commit`, `answer`, `approve`), re-running `tldrx status`
  after each. It states the ceiling and asks before anything that spends. 199 → 149
  lines.

### A decision on a split proposal now has somewhere to live

- **`tldrx seed answer <split.yml> <Qid> "<text>"`.** A split's runs could always be
  edited and its exclusions deleted; its `questions:` were the one part with nowhere
  to put the reply, so the answer lived in someone's head until `apply` created runs
  that did not reflect it. The `answer:` key is additive and human-owned — the
  propose schema still refuses it, so a model can never write one, while the
  validator carries it through, because `apply` re-validates the file a human edited
  and a validator that dropped the key would erase every recorded answer. The file
  is parsed, validated and re-emitted whole rather than patched, so `emitSplitYaml`
  stays the only writer of the format.
- **`seed apply` lists unanswered questions on stderr.** A warning, never a refusal:
  applying anyway is a legitimate call, staying silent about it is not.

### Something to look at while it works

- **`claude` is spawned with `--output-format stream-json --verbose`, and the JSONL
  is parsed as it arrives.** Verified against ONE real, measured call
  (`claude` 2.1.251, 2026-08-29, $0.0567426): `--verbose` is required — without it
  `stream-json` in print mode refuses before spending anything — and `--json-schema`
  coexists with it, the last `result` event carrying `structured_output` exactly as
  the single-blob format did. So the validation path is unchanged; only the transport
  is. `resolveResultDoc` reads EITHER format (whole-buffer JSON first, then the last
  `type: "result"` line), so an older `claude` and a pretty-printed blob both still
  work. The runtime seam grew `SpawnOptions.onStdoutLine` on both implementations;
  the buffered read is untouched when no callback is passed.
- **A progress view, on by default, on the four commands that make you wait.**
  `tldrx next`, `tldrx run auto`, `tldrx expert train` and
  `tldrx seed triage --propose` now show what the sub-agent is doing instead of
  sitting silent for minutes. `scene` is a classroom — a blackboard with the last six
  summaries, a wall clock whose hand is the elapsed second hand, a student who moves
  while a tool runs, a teacher who blinks and repeats the model's first sentence;
  `compact` is one line rewritten in place; `plain` is `[03:41] reading src/Foo.cs`.
  `--ui scene|compact|plain|off` or `TLDRX_UI`, `auto` by default: scene on a terminal
  at least 72x20, compact on a smaller one, plain in a pipe or under `NO_COLOR`/`CI`.
  `--prepare`, `--commit` and `--dry-run` spawn nothing and show nothing.
- **Every summary is free.** `reading src/Foo.cs`, `$ dotnet test → running` then
  `→ ok (12 s)`, `grep "Outbox"`, `writing 01-what/handoff.md`, `asked Q1: …`,
  `$0.42 so far · 3m10s` — all derived from bytes the sub-agent was already sending.
  No second model call, no summary agent. The dollar figure is what has been
  RECORDED, never an estimate: `claude` reports cost when a turn finishes, so a
  single stage reads `$0.00` until its result lands and a `run auto` loop climbs
  stage by stage.
- **stdout is never written to, and the cursor always comes back.** Every progress
  byte goes to stderr — asserted end-to-end, through the real CLI, by comparing
  stdout with the view on and off. The cursor is restored on a normal exit, on a
  thrown error and on Ctrl-C. The redraw itself is checked by replaying the driver's
  escape stream through a terminal model and comparing the reconstructed screen with
  the frame `render()` describes, which is the only way an off-by-one in a
  cursor-up/clear-line loop shows up in a test.
### The dashboard stopped disagreeing with the CLI

- **A run nobody has started is `ready`, not "waiting at a gate".** The model
  derived `pendingGate` from the stage GATE OBJECTS — the first stage whose
  `gate.status` is `pending` — which on a fresh run is every stage, because
  `pending` is the value the field is born with. Measured on a real workspace of
  eight freshly applied runs: the page drew **8 red "stage what is waiting at a
  gate / waiting on a human" cards** while `tldrx run status --json` said
  `waiting: {kind: "ready"}` for all eight. The derivation moved to
  `src/core/run/waiting.ts`, typed structurally so both the strict `RunFile` and
  the dashboard's tolerantly-read `RunDocument` can call it, and the page now
  carries `runs[].waiting` — the CLI's own `{kind, message, questions}`. Same
  workspace after: **0 cards**, 0 mismatches across all eight runs.
  `pendingGate`/`pendingQuestion` survive one release as documented aliases,
  non-null only for `gate` / `answer` respectively. A test asserts kind AND
  message parity, run by run, over a fixture covering every waiting kind.
- **Only a gate, a question or a failure raises an alert.** `ready` now reads
  "ready — `tldrx next <id>`" in the WAITING ON column instead of the blank
  "nothing" that made a startable run look finished; a run waiting behind a
  sibling raises nothing at all, which is the call `tldrx status` already made
  when it printed no command for a blocked run.

### The dashboard knows what has to come first

- **`triage.depends_on` reaches the page.** Wave J taught `tldrx status` that a
  run whose dependency has not finished is not the one to work on; the dashboard
  had none of it and listed eight runs newest-first with no hint that seven
  could not start. The rules moved to `src/core/run/dependencies.ts` — one pure
  function, no imports — and `status/runItems.ts` was rewritten onto it rather
  than a second copy being written. Runs gain `dependsOn` (slugs resolved to run
  ids), `blockedBy` (the ones not `done`) and `runnable`; the workspace gains
  `order` (topological, runnable first, then newest-updated) and `chains`.
- **ORDER is the default sort, and there is a dependency chain block.** The
  first runnable run wears the same `← next` marker the CLI prints, a blocked
  run says `blocked by <slug>`, and the chains draw as text with done runs
  ticked and the runnable one highlighted. Chains are root-to-leaf PATHS, not a
  flattened topological order, so every arrow is a real edge and a fork prints
  one line per branch.
- **An attention line mirrors `tldrx status`.** On the eight-run workspace:
  `1 run ready (tldrx next 260830-decisions-gate) · 7 blocked · 0 waiting on
  you`. Counted off the model, disjoint by construction.

### A gate now says who signs it, and who did

- **`gates_policy` and `gate.by` are drawn.** Wave G resolved the policy into
  `run.yml` and put the closer in the model as `gateBy`; `render.ts` never drew
  either, so a gate the facilitator closed and one a person signed looked
  identical on the page, and "which of these will stop for me" had no answer
  anywhere on it. Stage rows carry `gatePolicy`, the execution path gains a
  `signed by` column, and the section counts them the way the CLI does —
  "run.yml order · 1 human, 1 auto". Absence still reads as `human`.

### The CLI stops being silent about its own surface

- **`tldrx <command> --help` answers the question.** It printed the usage line
  and stopped: no flag meanings, no allowed values, no examples, no exit codes.
  `--scope <s>` did not say there are thirteen of them and the error for a wrong
  one did not list them either. A new registry, `src/cli/helpText.ts`, carries a
  one-line description, the positional arguments, every flag with its meaning and
  — where the set is closed — its values, one or two real invocations, and the
  exit codes that command can return with what each one means. Closed sets are
  imported from where they are enforced (`EFFORT_LEVELS`, `UI_MODES`, and the
  `workflows/*.yml` stems read off disk) rather than retyped, so a help screen
  cannot offer a value the validator refuses. `tldrx --help` gains the same table
  as a legend. `<cmd> --help` still needs no workspace.
- **An unknown flag is refused instead of ignored.** `tldrx status --nope` exited
  `0`: the parser recorded it, nothing asked for it, and the command ran with its
  defaults having been told something it dropped. The guard lives in the
  dispatcher, driven by the registry, so it covers the commands that never used
  `parseArgs` (`replay`, `retro`, `map`, `init`) too, and it scans argv exactly
  the way `parseArgs` does so a VALUE that looks like a flag is not mistaken for
  one. `hook` and `statusline` forward their argv to a hook script and are judged
  not at all. A test re-derives every flag each command READS from its source and
  fails if the registry does not declare it.
- **`--json` is supported or it is an error.** It had three behaviours:
  supported, accepted-and-ignored (`doctor`, `watch list`, `tickets status`), and
  refused (`map --check`). `doctor --json` and `watch list --json` now print the
  data — both already had it structured and were throwing it away at the last
  step — and everywhere else passing it is `1` with `--json is not supported by
  <cmd>`. `doctor`'s `mcp: null` means NOT PROBED; "no servers" is a different
  claim and does not share its shape. `watch list --json` is built from the same
  `statusOf` the table uses, asserted by running both and matching them.
- **`tldrx status` stops counting advice as work.** A freshly initialised
  workspace printed seven numbered items, five of them seeded experts at level 0
  repeating the same sentence, under a headline that made a new workspace read as
  a stuck one. They collapse into one uncounted line under the blockers —
  `Also: 3 expert(s) a stage will load have no evidence yet → tldrx expert list`
  — with the trainable ones named and one runnable example. A role expert with no
  handoff to mine is counted and named there and offered no command, because a
  command the tool would refuse is worse than an honest "not yet".
  `WorkspaceStatus.items` now means BLOCKERS and `pending` counts only those;
  `--json` keeps `items` shape-identical and adds `advice` beside it.
- **`init` points at the command that records the answer.** `init.ts` said "then
  answer `.tldrx/init-questions.md`" and the file's own header said to write after
  `[Answer]:`. Measured: the `answer-capture` hook returns early unless the path
  has a `tldrx-work` segment (`answer-capture.ts:27-28` → `locateWork`), so a
  hand-typed answer there records no fact, logs no event, and never reaches
  `applyProcess`, which is what writes `.tldrx/process.yml`. Both now name
  `tldrx interview --init`. The `[Answer]:` slot text stays — `captureAnswers`
  and `tldrx answer` read and write it.
- **Exit codes are visible from outside.** One table, defined in
  `src/cli/exitCodes.ts`, printed by `tldrx --help`, listed per command by
  `<cmd> --help`, and written once in the README (with a test that the three
  agree). An unknown COMMAND now exits `1`, not `64`: `64` means "on the roadmap,
  not built", which a mistyped word has no business claiming. It is reserved and
  currently unreachable — no command in this build is a stub, and that is
  asserted.
- **`tldrx replay`'s usage stops requiring an id it does not require.** With no
  id it narrates the newest run and refuses (exit `2`) only when several are
  open, which is the rule every other run-taking command follows.
- **`stages/how/stage.yml` loses its decorative `gate.requires:`.** Three
  acceptance criteria that nothing read: `normaliseGate`
  (`src/core/run/workflowPreset.ts:216-231`) reads only `.type`, `validateStage`
  (`src/core/schemas/stage.ts:72-76`) checks only `gate.type`, and no other file
  in the repo touches the key. The same dead key still sits in `what`, `plan`,
  `build` and `watch`, and `StageGate.requires` is still declared and still
  unread — out of this change's scope, and named here so it is not rediscovered.
- **README and ROADMAP stop claiming a release that has not happened.** Every
  published version was unpublished on 2026-08-29 (`npm view tldr-experts
  version` → `E404 Unpublished`) and there is no `v0.3.0` tag, so both `npm i -g`
  lines say so and keep the commands. ROADMAP's four "shipped in 0.3.0" become
  "on main, unreleased (0.3.0 pending tag)". `dashboard` is off the README's
  "refuses on ambiguity" list: it draws every run in the workspace, so it has no
  single run to be ambiguous about.
### A torn line no longer costs you the history

- **`EventLog.read` skips an unparseable line instead of throwing.** Measured in
  the 2026-08-29 resumability audit: `events.jsonl` is appended line by line, so a
  process killed mid-write leaves half an object on the last line — and `read()`
  ran that through a bare `JSON.parse`, so `tldrx replay` printed
  "events.jsonl could not be read" and exit 0 for a ledger whose first four hundred
  lines were perfectly good. Tolerant readers already existed in `run/attempts.ts`
  and the Build executor; the shared one now agrees with them. Skips are counted,
  not swallowed: `readAll()` returns `{events, lines, skipped}`, `read()` says
  `1 line skipped (unparseable — a torn write)` once per file on stderr, and
  `tldrx replay` prints the same note above the narrative. Line numbers now come
  from the reader, so a torn line no longer shifts every `L<n>` after it.

### The two files every run shares now have a lock over them

- **`.tldrx/.lock`, held across the read-modify-write.** Measured 2026-08-29: two
  processes appending to `.tldrx/memory/facts.yml` each computed the next id as
  `max(id) + 1`, each got `F001`, and the second save erased the first fact
  outright. The per-run `.lock` never covered this — it guards one run, and
  `facts.yml` belongs to all of them. The new workspace lock is the same shape
  (a pid file, `kill(pid, 0)` for staleness, a dead holder taken over) and is
  re-entrant within a process, and `FactsStore.update(path, fn)` holds it across
  load → append → save. A two-process test that provably overlaps now mints
  `F001` and `F002`; with the lock disabled it mints `F001` twice. `tldrx run new`
  holds the same lock across its WHOLE creation, because `--from` mints fact ids,
  writes them into the run's `fact.added` events, and only then writes the file
  back — a read-modify-write with a wide middle.
- **`budget.yml` ceilings are re-read before every write.** A `budget raise` that
  landed while a stage was in flight was silently reverted when that stage saved,
  because the in-flight `RunStore` wrote back the ceilings it had read minutes
  earlier. `RunStore.save` now takes the ceilings from disk unless this store
  deliberately changed them (`mutateBudget`, which is what `raise` uses) and
  contributes only the actuals it rolled up.
- **`run.yml` and `budget.yml` are written temp + `rename`.** A `writeFileSync`
  killed halfway left a truncated run file; a rename is atomic within a
  filesystem, so a reader gets the whole old file or the whole new one. Same move
  `run new` already made for the run directory.

### `running` stopped meaning "ready", and a stuck run has a way out

- **Two new waiting kinds, `running` and `prepared`.** A stage killed between
  `tldrx next --prepare` and `--commit` is left `running` with NO lock — `--prepare`
  releases it on purpose, because the host session runs the prompt. Every reader
  called that `ready` and offered `tldrx next`, which re-spawned the stage and
  binned a sub-agent turn the run had already paid for. `waitingFor` now separates
  the three things `running` can mean: a live lock (`stage is running (pid N) —
  wait, or \`tldrx run unlock <id>\` if it died`), an uncommitted bundle
  (`a --prepare bundle is waiting — run the prompt and \`tldrx next --commit
  <id>\`, or \`tldrx reject --run <id> --note …\` to discard`), and a crash with
  neither. `tldrx run status`, `tldrx status` and the dashboard all follow, because
  all three read the one derivation.
- **`tldrx next` refuses to re-spawn over a bundle** (exit 2), naming all three
  ways out; `--discard-pending` is the explicit "bin it and run it again". Phases
  with an executor are exempt — Build stays `running` across cycles by design.
- **`tldrx run unlock [<run>] [--force]`.** A `.lock` whose pid had been RECYCLED
  by an unrelated process was permanent: `kill(pid, 0)` said alive, `next` exited
  2 forever, and the fix was knowing to delete a gitignored file by hand. Unlock
  removes a dead holder's lock, demotes `running` → `ready`, and appends
  `run.unlocked`. A live holder needs `--force`.
- **`tldrx run cancel [<run>] --note <text> [--force]`.** `cancelled` was a status
  in the schema with nothing that could write it, so a run you had given up on
  stayed open forever and made every id-less command ambiguous. Cancel closes it,
  appends `run.cancelled`, and records the decision on the run
  (`cancelled: {by, at, note}`, optional and additive) — which is what lets a
  FAILED run be closed without overwriting the failure on its stages. Nothing is
  deleted; `tldrx replay` still reads the whole thing.

### Ctrl-C now stops the sub-agent, not just tldrx

- **SIGINT/SIGTERM kill the agent's whole process tree, record the attempt, and
  unlock.** Measured 2026-08-29: there was no signal handler on the run path at
  all. A sub-agent is spawned detached (a timeout needs a process group to kill),
  so the terminal's Ctrl-C never reached it — it kept running with `ppid 1`, kept
  billing against its `--max-budget-usd`, and because a stage's cost is only
  written after the spawn returns, not a cent of it appeared in `events.jsonl`.
  The run was left `running` behind a `.lock` whose pid no longer existed.
  `src/cli/signals.ts` (one line from `index.ts`) now kills the tree first, then
  records a partial `agent.result` carrying `cost_usd: null` and
  `stopped_by: "signal"` — unknown, said out loud, rather than a `$0.00` that
  would read as free — demotes `running` → `ready`, releases the lock, restores
  the terminal cursor and exits 130. A second signal exits at once.
- **A `--prepare` bundle is left alone.** If nothing was spawned and an
  uncommitted bundle is on disk, the stage stays `running` and the message points
  at `tldrx next --commit`: that work is waiting for a human, not a process.
- **`dashboard` and `watch` keep their own Ctrl-C.** With no sub-agent to kill and
  no run to close, the handler stands aside and their exit-0 shutdown still wins.

### Build branches and worktrees name their run

- **`story/<run-id>/<story-id>`, and `.tldrx/worktrees/<repo>/<run-id>-<story-id>`.**
  Measured 2026-08-29: four runs of one plan all cut `story/S1`. The second found
  it already there, `git worktree add` checked it out as it stood, and one run's
  commits landed on another's branch — and the fourth reused the third's LIVE
  worktree, so two sub-agents were editing the same files at the same time.
  Neither name can collide now.
- **An `epic/<slug>` this run did not cut is refused** (exit 2, `refused` — the
  stage goes back to `ready` and nothing is spent), unless `tldrx next
  --reuse-epic`. The epic branch keeps its plain name on purpose — it is the unit
  a team merges — so instead of making collision impossible this makes it
  deliberate. What a run cut or adopted is recorded in `run.yml` as
  `build.epic_branch` (optional, additive), which is how its own next invocation
  tells its branch from someone else's.

### `map --refresh` finally leaves a trace

- **`map.refreshed` is emitted.** It has been in the §2.9 type enum and in the
  replay renderer since v0 and nothing ever emitted it (measured 2026-08-29), so
  the one command that rewrites every expert's evidence base left no record
  anywhere — whether a claim in a handoff predated a refresh or came after it was
  unanswerable. It now carries the providers that ran, the document count and the
  repo count. The map is workspace-level and `events.jsonl` is per run, so it is
  recorded against the newest OPEN run and the command SAYS which; with no open
  run there is nowhere to put it, which is not an error.

### A job stopped halfway now looks stopped halfway

- **`seed apply` writes `status: applying` before the loop.** It creates N runs
  one at a time; a crash at run 3 of 8 left `split.yml` still reading `proposed`,
  so `tldrx status` said "nothing has been created yet" with three run
  directories sitting next to it. The file now moves to `applying` before the
  first run and grows `created_runs` after each one, and `tldrx status` reports
  `tldrx seed apply … stopped at run 3 of 8` with what was created, what was not,
  and how to reset it.
- **`seed triage --propose` writes its `.agent/` bundle in headless mode too.**
  It was a `--prepare`-only artefact, so an interrupted propose left nothing but
  `inventory.*` and the only offer was to pay for the whole proposal again. The
  prompt and `pending.json` are now on disk before anything is spawned.
- **`expert train` writes `knowledge/<area>.md.partial` and renames on
  validation.** A knowledge file is INLINED into every later prompt for its area
  and the inliner globs `knowledge/*.md`, so a training run killed halfway left a
  torn, unvalidated file at exactly the name that gets read as if it were whole.
  The sub-agent now writes the partial; the framework renames it onto the real
  name only after the file validates, and a leftover partial is quarantined as
  `.rejected.md` rather than left. `.md.partial` never matches `*.md`, so nothing
  half-written can be inlined at all.

### The token economy — what a prompt costs, and who decided

Measured 2026-08-29 on `~/aparece-v2`, run `260830-decisions-gate`, stage `01-what/what`:
one prepared prompt was **159,575 bytes**. 45% was declared inputs, 52% was expert
bodies and trained knowledge, and eight of the nine experts had loaded because they
shared a repo with the run — not one of them had read a file the run cited. The
64 KB seed budget had dropped `ADR-D013-DELIVERY-ZONE-GEOMETRY.md` (5,863 B) whole,
the sixth of the six decisions the run existed to settle, while 70,923 B of
unrequested knowledge went in untouched. The same prompt is now **85,676 bytes**,
loads two experts, and contains ADR-D013 in full.

- **Cache-friendly prompt order.** The pieces are now emitted most-stable to
  least-stable: `stage.md`, expert blocks, `## Inputs`, `## Previous attempt`. Both
  facilitator-owned sections are cut out of `stage.md` wherever its author put them
  and re-emitted at the tail, so a spec-shaped stage file yields exactly one
  `## Inputs`, at the end. **Measured, two real `claude` 2.1.251 calls, same
  40,715-byte prompt, separate processes and separate sessions:** call 1 wrote
  37,059 cache tokens, read 0, cost **$0.074982**; call 2 wrote 0, read 37,059, cost
  **$0.004550** — 16.5x less. `claude -p` caches across processes, not only within a
  session, which is what makes the order worth changing for `run auto` and retries.
  `cache_creation_input_tokens` and `cache_read_input_tokens` are now parsed,
  published on the `cost` event and written to `agent.result`, so this stays a
  measurement.
- **One shared budget, declared inputs first.** `inputs_max_bytes` (stage.yml,
  default 96 KB) is spent on every declared input in declaration order; the experts
  then share `knowledge_max_bytes` (default 48 KB) **in total**, split by rank,
  never one budget each. The retired `expert_knowledge_bytes` is still read, as the
  same total — a per-expert cap scales with a number nobody set, which is how 64 KB
  became 83,523 measured bytes and, at twelve experts, would pass the context window
  of the model the Watch stage pins. An input that still does not fit is named, with
  its size and the key that fixes it, on stdout AND on the page.
- **A context ledger, and `prompt_max_bytes` as a refusal.** `--prepare` and
  `--dry-run` print bytes per section and `pending.json` carries the same under
  `context:`. Over `prompt_max_bytes` (default 160 KB, `--prompt-max-bytes` to
  override) the stage exits **2** before anything spawns, naming the biggest sections
  and the key or command that shrinks each. The model's context window is only ever a
  stderr warning at 80%: both it and the bytes-per-token ratio are `[assumption]`,
  and refusing on two stacked assumptions blocks work the framework could have done.
- **Experts load by relevance, not by co-residence.** A `repos:` match is only
  evidence in a workspace that declares two or more repos. Rank is a score — a direct
  `## Domain` path match is worth 10, a path within 2 hops of a cited one in
  `graphify-out/<repo>/graph.json` is worth 1, and scores add. Score 0 means body
  only, no knowledge. The graph walk is undirected, bounded, and degrades to an empty
  set on a missing or unparseable graph (measured on the 5,091,949-byte aparece
  graph: 298 neighbour paths in 14 ms).
- **`max_reads` — the brake `--max-budget-usd` is not.** Completed `Read`/`Glob`/
  `Grep` calls are counted off the stream that is already arriving (no second model
  call, no extra tokens) and the process tree is killed at the ceiling: 120 for
  what/how/plan, 200 build, 60 watch, `--max-reads` to override. Counting completions
  is what makes the stop land after the current tool rather than inside one. The
  attempt records `stopped_by: max_reads` — written only when a cap bit, so an
  ordinary `run.yml` is unchanged — `agent.result` carries `reads`/`max_reads`/
  `stopped_by`, and the live view shows `reads 37/120`.
- **Attempt 2 gets the refused draft.** The declared outputs that exist on disk are
  inlined under `### Previous attempt — edit, do not restart`, capped at 32 KB shared
  across them, anything past it named. Before this, a stage rejected over one missing
  section paid full price to rewrite four documents from a blank page.
- **`tldrx cost [<run>|--all] [--json]`** adds up what was actually charged, per
  attempt, per stage, per run — every dollar one the CLI reported, nothing multiplied
  by a price here. Attempts are never merged; unmetered work is counted apart and
  reported as unknown rather than summed as $0.00.
- **`tldrx run estimate [<run>]`** is the one command that guesses, and says so: the
  next stage's prompt is assembled by the same code `next` uses and weighed by the
  same ledger (measured), and the output half is the median output tokens of past
  attempts at that stage id in this workspace (with no history, no estimate). Prices
  and context windows live in one dated `[assumption]` file,
  `src/core/budget/modelPrices.ts`.

### A gate that can be closed by silence is not a gate

The 2026-08-29 gates/money/safety audit (`docs/audits/2026-08-29/gates-money-safety.md`)
scored 6/10, and every item below is one of its measured findings. The engineering
was sound — no shell in the adapters, no `push` wrapper, the dashboard on loopback,
`install` never touching `permissions` — the failure was in what the barriers MEANT.

- **`claim-sources` verifies six `src` kinds it used to wave through.** Measured
  probe: a handoff citing `[src: F999]`, `[src: Q42]`, `[src: graph:i-made-this-up]`
  and `[src: absent:ops/backup.yml]` to assert "we removed the auth check from
  /admin" validated CLEAN, closed its own auto gate and advanced the cursor.
  `resolveSrc` returned `ok` by default for `fact`, `answer`, `graph`, `doc`,
  `absent` and `aidlc` — six of eight kinds were shields. Now `F<n>` must be a live
  (non-retired) row in `facts.yml`, `Q<n>` a question this run actually asked,
  `graph:<node>` a node in `graphify-out/graph.json` or a token named in
  `.tldrx/map/`, and `absent:` may only source a NEGATIVE claim (`## Unknowns` is
  exempt — that heading IS the negation, and it is the spec's own example). A third
  outcome, **`unverified`**, sits between ok and refused for what cannot be checked
  offline: an https doc no input/map/knowledge file cites, an `absent:` over a file
  that exists, a `cmd` with no `workspace.yml` commands to check against. It never
  fails a stage; it stops an auto gate. The repo's own fixture used the shield
  pattern the audit named, and cites real files now.
- **A `[src: …]` wrapped in backticks is a citation, not a missing one.** From the
  same day's UX audit: `TRAILING_TOKEN_RE` was anchored to end-of-line, so
  `` `[src: x]` ``, `[src: x].` and `([src: x])` all read as unsourced. A real
  user's first `tldrx next` was refused with "9 unsourced bullet(s)" when all nine
  carried citations; $0.40 spent to be told the work had no evidence. Closing
  quotes, brackets and terminal punctuation after the `]` are now ignored; words
  after it still are not. A line that TRIED to cite gets `malformed citation on
  line N`, not `unsourced bullet` — the two need different advice.
- **An auto gate can no longer be closed by silence.** Three ways it could be.
  (a) condition 5 counted only refusals, so an unverifiable citation passed; it is
  now zero refused AND zero unverified. (b) A stage that DECLARES `questions.md` as
  an output and writes one the §2.7 parser cannot read had "0 open questions"
  recorded as satisfied — a real stage wrote `### Q1 — …` / `**Answer:**`, copied
  faithfully from this repo's own `templates/questions.md`, and the gate signed
  itself over four unanswered questions. Unreadable or empty now falls to the human
  gate naming the ids it could not see, and `next --commit` refuses the same file
  with exit `5`. (c) `templates/questions.md` IS the grammar now, with one worked
  example, and the grammar is inlined into every `stage.md` that may write
  questions.
- **New: `tldrx questions lint [--run <id>] [--fix]`.** Without `--fix` it names
  every block the parser cannot see and exits `2`; with it, it converts the prose
  form and **changes not one word** — title, `Why asked:`, every option and any
  answer already typed come across verbatim, and an unlettered `- Other:` keeps its
  text as the next letter. It does not invent the `[src: …]` token §2.7 wants on
  `Why asked:`: a tool that manufactures a citation to satisfy a validator is
  producing the exact thing the entry above exists to stop. It lists the blocks
  that still need one instead.
- **An approval can be revoked: `tldrx reject --stage <phase>/<stage> --note "…"`.**
  Before this an approval was final — `approve()` moves the cursor in the same
  transaction that signs the gate, and `reject` only ever looked at the cursor, so
  the probe above met `REJECT REFUSED: nothing to reject: 02-how/beta is 'ready'`.
  A machine that can sign but cannot be overruled is not a gate. Revoking sends the
  stage back to `ready` with the note, moves the cursor to it, and appends one
  **`gate.revoked`** (new event type) carrying `signed_by`. Later stages that had
  run are marked **`stale: true`** (additive; cleared when the stage re-runs): their
  outputs stay on disk — they cost money and are usually mostly right — but nothing
  treats them as current. `--stage` is also the one verb allowed to reopen a
  FINISHED run.
- **`by: auto` is visible where people look.** It reached `run.yml`, the event log
  and `run status`, and none of those is a glance. `tldrx status` now names every
  auto-signed gate with the command that undoes it, and the status line carries
  `auto:N` / `stale:N`.
- **The DoD gate no longer runs an un-allowlisted command.** `runDodCommand` handed
  the model's own string to `/bin/sh -c`, `dod-gate` never consulted an allowlist,
  and the hook ships enabled by default as PreToolUse with a 960 s timeout: a story
  saying `dod: rm -rf ~` ran it the moment someone marked the story done. A command
  must now be byte-equal to a `workspace.yml` command and is spawned argv-split with
  **no shell**; a bare metacharacter refuses (a quoted argument is fine, so a team
  that wants `sh -c "…"` declares exactly that). The schema half moved with it: an
  EMPTY `commands:` now refuses every dod entry instead of permitting anything. The
  old rule reasoned by analogy with `resolveSrc`'s `cmd` source, and the analogy does
  not hold — a citation describes something that already ran; a dod block is a list
  of things about to be run as you.
- **`--yolo` no longer reaches the reviewer.** `--dangerously-skip-permissions` was
  passed to the read-only reviewer sub-agent, which was the one whose read-only-ness
  was the point. The developer still gets it; that one is meant to write.
- **`budget-gate` covers every spender, and fails CLOSED.** It matched
  `^(claude -p|tldrx next)` only, so `tldrx run auto` — a loop of up to 96 stages,
  the one command that can spend a whole run in one invocation — plus `expert train`
  ($2.00 a call) and `seed triage --propose` ($1.00) walked straight past it. And it
  allowed on every unreadable budget, which is fail-open on the hook whose entire job
  is refusing to spend. Both fixed: the five commands are matched and priced
  (`--max-usd` else the run ceiling for `run auto`; the documented defaults for the
  other two), and an unreadable `run.yml`/`budget.yml` denies and names the file. It
  still allows silently outside a workspace, or for a command that spends nothing.
- **`budget raise` leaves a record.** It rewrote `budget.yml` and appended nothing at
  all — the one sanctioned way to move a ceiling was the one act with no trace. New
  event type **`budget.raised`**, with before/after for both ceilings, the actor, and
  an optional `--note`.
- **Unmetered is not zero.** An in-session `--commit` with no declared cost recorded
  `$0.00`, so a run's ledger could read "$0.00 spent" after real money had gone. That
  is a measurement, and a false one. Such a task is now `cost_usd: null` +
  `metered: false` (both additive; a null cost without the flag is a schema error).
  Sums treat it as nothing — the only honest arithmetic — and every report says so:
  `budget show` and `run status` render `unmetered (in-session)` and call `spent` a
  LOWER BOUND, and the auto gate's note names the uncounted turns. New:
  `tldrx next --commit --cost-usd <n> [--tokens <n>]` so a host can declare it.
- **`tickets sync` previews by default; `--apply` writes.** It is the only verb that
  reaches a third party — it creates and edits issues in someone's tracker — and a
  destructive default on the one networked command is backwards. `--provider` no
  longer switches on a workspace set to `ticket_tool.kind: none`; it picks between
  configured providers, and the config is not a flag's to override.
- **Build cannot charge 2.5x its phase, and Watch's floor cannot exceed its
  ceiling.** Build's shares are now divided by the worst case — stories x attempts x
  (1 + reviewer share) — instead of by story count, so every cap it can hand out sums
  inside the stage budget however the attempts fall. Watch refuses BEFORE spawning
  when N features cannot each get the $0.25 spawn floor inside the ceiling, naming
  the `budget raise` that fits: splitting further would just buy N failures.
- **`.claude/settings.json.bak-tldrx-*` is ignored.** `install --claude` backs
  settings.json up before merging into it; the backup is a full copy of a file that
  may hold local values, and it was the one thing the framework writes that nothing
  ignored. Now in the init gitignore block and in this repo's own.

### A citation has to sustain its claim, not only resolve

Everything below was measured against the three knowledge files a real training run
produced on a real workspace (`~/aparece-v2`, 2026-08-29). Wave M made every `src`
resolvable; that is a check on the citation and says nothing about the sentence.

- **An execution claim needs a command src, and a file line under one is refused:**
  `execution claim needs a '$ <cmd> → exit <n>' src, not a file line`. The header of
  the real `knowledge/aparece-api.md` asserts `` dotnet build `` exit 0, "measured,
  exit code captured unpiped", citing `.tldrx/workspace.yml:19` — the line that
  DECLARES `build: dotnet build`. It claims "78/78 passed, exit 0" citing a line of
  the test script. Every citation resolves; none is evidence anything ran. The rule
  reads prose paragraphs as well as bullets, because that header IS a paragraph and
  its tokens sit mid-line where a line-anchored parser never looks. Measured after:
  7 refusals on that file, 1 on `aparece-platform`, 0 on the third.
- **Three warnings that cost a citation its evidence without rejecting the file:**
  `paraphrase` (the bullet is ≥90% a verbatim substring of the ±3-line neighbourhood
  of the line it cites), `outside domain` (the path is outside the expert's own
  `## Domain` — and the expert whose domain does contain it is named), and
  `duplicate src` (already on record for this expert). None of them is a lie; they
  are ways of being worth nothing, and the honest response is a level that does not
  move. Measured on the real corpus: 57 outside-domain and 7 duplicate warnings
  across 248 bullets.
- **`## Sources` earns nothing.** It was 41 of 107 bullets in one real file and 18 of
  56 in another, every one re-citing a source cited above it. It is still validated
  like any other section; it just derives no evidence, and `countFindings` stops
  counting it as a finding.
- **A bullet may end in `(measured)` / `(inferred)` / `(assumed)`** — or lead with
  `*measured* —`, the other spelling the real corpus uses — and it is parsed onto the
  evidence row as `confidence:`. Both spellings are stripped before the execution rule
  matches: inside the annotation the word is a LABEL, and refusing a file for obeying
  §2.3's own "say which of measured / inferred / assumed each claim is" would be the
  rule being wrong, not the file.
- **Light mode's file selection is bounded by `## Domain`.** Only files inside the
  expert's declared folders are scored, read or inlined; every file inside them is a
  candidate even when it greps for nothing. Bounding the input is cheaper than warning
  about the output.

### The ladder weighs findings, not files

- **Recency decays continuously — `max(0.25, 1 - ageDays/365)` — and the 180-day
  staleness cap is gone.** It was a cliff: an expert trained on day 179 and the same
  expert on day 181 knew identical things and the ladder reported 4 and 2. Knowledge
  fades; it does not expire on a Tuesday. The four remaining steps are thresholds →
  run cap → top-rung kinds → distinct-source cap. **Levels move on this change: run
  `tldrx expert recompute` to see the new numbers.**
- **A cross-file finding weighs double, an `assumed` one weighs half.** Both are
  additive `evidence[]` fields (`cross: true`, `confidence:`) derived from the bullet,
  never asserted; a row written before they existed carries neither and computes as it
  always did. A model can re-derive anything one file says by reading it; what it
  cannot re-derive is the relationship between two.
- **The training prompt asks for value, not coverage.** It used to say "Citing the
  same file twelve times is worth one row; reading twelve files is worth twelve" — an
  accurate description of the old formula and a Goodhart instruction. Both prompts (the
  spawned one and `--print-prompt`) now carry the same criterion word for word: a
  finding is something a model could not re-derive by reading that one file once —
  cross-file contradictions, dead paths, defaults that differ from their docstrings,
  absences written as a negative claim, measured commands. Restating a docstring is
  not a finding.

### The gates finally reach the experts

- **The Build executor writes `retro.md` as the run goes.** Role experts train from
  `tldrx-work/<run>/**/{handoff,retro}.md` and nothing else, and all five sat at
  level 0 because `retro.md` existed only when a human typed `tldrx retro`. Build now
  appends `## Build feedback` as each story settles — every reviewer `changes` verdict
  and finding, every DoD command that failed on the first attempt with its exit code,
  every merge conflict, and (read back off `events.jsonl`, since they happen between
  invocations) every gate rejected and every approval revoked, with its note and what
  it staled. Deterministic, deduped verbatim, every bullet carrying a `[src: …]` into
  the review log or the events line. `tldrx retro` carries the section forward instead
  of overwriting it.
- **`tldrx expert list` warns on a shared citation:**
  `warning: shared citation <file:line> by <a>,<b> — check for contradiction`, on
  stderr, when two experts cite one line with bullets whose normalised texts differ.
  16 files on the real workspace were cited by two trained experts each and nothing
  compared what the two said. It resolves nothing on purpose — deciding which expert
  is right is not something a deterministic tool can do.

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
