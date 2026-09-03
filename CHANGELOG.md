# Changelog

## Unreleased

### Fixed

- **Codex Build reviews rejected before execution (#148).** The Codex spawn boundary
  translates optional schema properties to required nullable values, including nested
  fix-list entries. Claude and attended review schemas stay unchanged. Multiline Codex
  errors are flattened for handoff rendering so a provider failure does not introduce
  uncited continuation lines. Reproduced with published 0.7.0 and codex-cli 0.153.0.

## 0.7.0 — 2026-09-03

### Added

- **Codex is now a second honest automated runner.** Set `TLDRX_AGENT_PROVIDER=codex` to
  run plain `codex exec --json` through the existing facilitator seam; `TLDRX_CODEX_BIN`
  selects a wrapper or pinned executable. The adapter is pinned to a real codex-cli 0.152.0
  JSONL transcript and a real executable stub, preserves thread identity and token usage,
  feeds the existing structured envelopes, runs developers in `workspace-write`, and makes
  Build reviewers mechanically `read-only`. Because Codex exposes neither provider-metered
  USD nor a provider-side USD cap, every Codex turn is recorded `cost_usd: null,
  metered: false`; no Codex prices were added and dollar totals remain lower bounds. Agent
  gate provenance uses the measured Codex thread id as `executed_by.id`. Claude remains the
  byte-identical default. File formats remain `version: 1`; `DASHBOARD_MODEL_VERSION` remains
  `3`.

### Fixed

- **A citation to a file that exists only on the run's unmerged epic branch passed unflagged, or broke,
  depending on whether a temp directory still existed (#140).** Live evidence, run
  `260830-money-and-payments` (aparece-v2, closed 2026-09-03): `retro.md` was committed to `main` carrying
  96 `[src: src/Modules/Payments/…:28]` citations to files that exist on `epic/money-and-payments` and on
  no merged ref. The driver's words: *"cuatro de mis citas apuntaban a archivos que solo existen en el epic.
  Nadie me las señaló."* #16 had made those resolve against the epic WORKTREE
  (`.tldrx/worktrees/<repo>/_epic-<run>-<epic>`), and that is a temp directory, so the same citation had two
  silent answers — measured on `24e9358` with the new fixture:
  - worktree **present** (the state the retro was written in): the whole check detail read
    `1 handoff(s) sourced`, with no mention of the branch the path is only on;
  - worktree **gone** (the state `main` is always in, and the state after cleanup):
    `no such file: src/Modules/Payments/CreateChargeHandler.cs — tried repo \`api\` (api)` — the stage's own
    evidence refused for being true.
- **A `file` src now gets one more chance after every base on disk: the branches the run RECORDED.**
  `run.yml`'s `build.epic_branch` — the same record `tldrx ship` opens its PR from — read as a git blob with
  `git cat-file blob <ref>:<path>` in each declared repo. No worktree, and no retention policy needed for
  this purpose. `cat-file blob` and not `show`: `git show <ref>:<dir>` prints a tree listing and exits 0, so
  `show` would resolve a citation to a directory as though it were a file (measured 2026-09-03: `cat-file blob`
  exits 0 for a blob, 128 for a tree, 128 for a path the ref does not have).
  - **It resolves, and it is NAMED.** A citation whose only home is unmerged is `ok` — refusing it would refuse
    a stage for reporting its own evidence — and the resolution carries the ref, so `claim-sources` prints
    `on unmerged refs: 96 (epic/money-and-payments — unmerged)` in the one detail string the gate, `tldrx next`
    and the run record all read. A reader of `main` is told which branch to look on. A hit on the epic
    worktree is named the same way, so the "passes in silence" half is closed too.
  - **Still refused:** a path on no ref at all (the failure now admits it tried the recorded branches), and a
    cited line past the end of the epic's blob — which names the ref and the length the file has there. Only
    branches `build.epic_branch` records are tried; a branch that merely exists in the repo is not a base.
    An `absent:` src deliberately does NOT reach for the refs: an absence is a claim about where somebody
    looked, and a branch nobody checked out is not somewhere anybody looked.
  - **The blob read is opt-in, and the `claim-sources` hook does not opt in.** It is the one subprocess the
    §2.8 reader spawns, and that hook runs on every PreToolUse write inside the 50 ms budget of spec §0. The
    guard is reachability rather than a cap: `toSrcContext(workspace, runDir)` — the hook's spelling — leaves
    `epicRefs` empty, so no handoff can reach a `spawnSync` from a write. Measured 2026-09-03 on 96 epic-only
    citations: **0.36 ms** on the hook path, **1166 ms** cold on the gate path with all 96 reads paid, **0.36 ms**
    warm (memoised per repo/ref/path, capped at 256 reads per process). `tldrx approve`, the stage/gate
    `claim-sources` check, `tldrx next`'s auto gate, `tldrx watch` and `watch arm` opt in — every one of them a
    boundary that already spawns git.
  - **It behaves like `noted`, not like `unverified`:** it passes the stage and it does not block an auto gate
    (spec §5, condition 5). It is a check that ran and came back true, of a branch nothing has merged.
  - **The auto gate's NOTE carries the ref too.** `claimSourcesCondition` carried `outcome.detail` into its
    note only when the unchecked-absence count was non-zero — #110's rule reading one of the two things that
    detail now holds. So a stage whose handoff cited nothing but the epic and held no absence at all
    auto-signed with a note that read, in full, `claim-sources=passed`. Both counts are consulted now, and
    the branch reaches the sentence a person actually reads when a stage signs itself.
- **A watcher card could cite a path only the unmerged epic has, and say nothing (#143).** The one artefact
  #140's annotation did not reach. `watcherFile.ts` recorded an issue only when a resolution was NOT `ok`,
  and every issue it records makes the card fail — so "true, and true only on `epic/…`" could not be said
  without failing a card that is not wrong. Since `tldrx watch`, `watch arm` and the Watch executor opt into
  the recorded epic refs (`toSrcContext(…, { epicRefs: true })`), such a citation resolved in silence, and a
  card committed to the trunk could point a reader at paths no merged ref has. Measured RED, on a card whose
  four checked sections all cite `epic/money-and-payments`: `watch check` said `ok — verified; every source
  resolves` and `watch list`'s footer said `1 card(s): 1 verified, 0 draft`, neither naming the branch.
  - The card now carries a **separate, non-fatal `epicOnly` list** — the shape `handoff.ts` already uses for
    the same reason, rather than a third `WatcherIssueKind`, because `ok` reads `issues` and nothing else, so
    the annotation cannot fail a card however long it gets.
  - It is printed in the words `claim-sources` already uses at a gate — `on unmerged refs: 4
    (epic/money-and-payments — unmerged)` — beside the card's status in `watch check`, as a footer under the
    `watch list` table, as `unmerged_refs` (plus an `unmerged` count) in `watch list --json`, and on the Watch
    executor's own per-card line, which is where the driver reads a card's status.
  - Three guards say it is not a rubber stamp, and all three were green before the change: a path on a
    **merged** ref gets no annotation, a citation that resolves **nowhere** is still a failing `source` issue,
    and with epic refs **off** — the context the PreToolUse hook builds — nothing resolves and nothing is
    annotated.
- **A run could close with a question nobody ever answered, and nothing said so (#141).** Filed from the
  driver of `260830-money-and-payments` (aparece-v2) as *"D7.6 nunca recibió respuesta ni disparó su
  default"*, labelled INFERRED. **Measured first, and the reported mechanism does not exist:**
  - `D7.6` was never a question. The §2.7 heading grammar is `^## (Q\d{1,6}) · ` — `D7.6` is a
    Definition-of-Done criterion in that run's own seeded documents
    (`docs/domain-design/docs/12-DEFINITION-OF-DONE.md:118-125`). The run's `questions.md` files hold exactly
    three blocks — `Q1`, `Q2`, `Q3` — and every one is `status: answered`.
  - A question **cannot declare** a default. §2.7's metadata keys are `id status area asked_by asked_at` plus
    the optional `affects:`; there is no `default:` and no `timeout:`.
  - **Nothing fires one.** The only thing in the codebase called a default is `tldrx interview
    --yes-to-defaults`, which an operator invokes by hand, takes option A, and is labelled `[assumption]` in
    its own implementation. No timer, no gate and no close applies anything to an open question.

  The fail-open the report was reaching for is real, and narrower guards had hidden it: the auto gate's
  `questions` condition reads only the CURRENT stage's declared file, a human `approve` does not look at
  questions at all, and `closeRun` read `run.yml` and git and nothing else. A question raised in `01-what`
  could age through every later stage, past a signed gate and out of the run in silence. Measured RED, on a
  run cancelled with `Q1` open: `cancelled 260828-demo — 1 stage(s) closed: 01-what/alpha` and not one word
  about the question. **All three close paths** — `tldrx next` closing the last stage, `tldrx approve` signing
  the last gate, `tldrx run cancel` — now name every open block by id, title and file, plus any heading the
  §2.7 parser cannot read (worse than open: the block was never visible to anything). The sentence ends by
  saying that nothing was going to answer them, because that belief is what produced the report. It is a
  report and nothing else: no exit code changes, no close is refused, not one byte is written.

## 0.6.1 — 2026-09-03

### Fixed

- **The Build handoff's `Cost:` header was invocation-scoped, so a re-entered stage reported
  `$0.00` for a phase that had spent `$0.44` (#138).** The sibling of #137's two sections, one
  line higher up, on a document whose own docstring says it "describes the phase, not the
  invocation". `writeHandoff` fed the header `this.spent()` — the sum of the tasks THIS process
  spawned — so a `tldrx next` → `tldrx reject` → `tldrx next` rewrote the same file's
  `Cost: $0.44 of $200.00 ceiling` as `Cost: $0.00`: the second invocation settled nothing,
  spent nothing, and said so about the whole phase. Measured on `f5936d2` with the `TWO_WAVES`
  fixture at `FAKE_BUILD_COST=0.11`.
  - **`FAKE_BUILD_COST=0` is why nobody saw it.** Every other re-entry test in
    `test/build-executor.test.ts` pins the cost to zero, where both writes read `$0.00` and
    agree. The new block does not, and buys the headroom that needs with a $200 stage ceiling —
    the budget gate refuses to RESTART a stage whose estimate no longer fits, so a fixture whose
    stage estimate IS the phase ceiling cannot re-enter once a cent is recorded. Raising the
    default in the shared fixture instead was rejected: it would have rewritten the pinned
    expectations of every re-entry test in the file for a defect one block now covers head-on.
  - **The durable source is `run.yml`'s `stage.cost_usd`**, plus what this invocation has spent
    and not yet handed back (`phaseCostToDate`, exported from `executors/build.ts`). Chosen over
    the `agent.result` events because it is the ledger the budget is derived from AND it
    validates its own arithmetic: `rollUp` recomputes it from `stage.tasks` on every save,
    `rollUpBudget` mirrors it into `budget.yml`, `run status` and the dashboard read it, and
    `validateRunFile` refuses a `run.yml` whose `budget.spent_usd` drifts from the sum of its
    task rows by more than a cent. The events carry the same numbers — every `recordTask` is
    paired with an `agent.result` written from the same task in the same loop — but nothing
    checks that they still do.
  - **Three properties it rests on, verified rather than assumed.** `tldrx reject` does not touch
    the number (it rewrites `status`, `ended_at` and `gate` and nothing else), which answers the
    open question in the issue: a re-run reports the earlier spend, because the money was spent.
    This invocation is not in `run.yml` yet, because `recordExecutorTasks` runs after the
    executor returns — so adding the two cannot double-count, and a re-entry that DOES spend is
    pinned at `$0.22 + $0.11 = $0.33`. And opening the store mid-stage is the shape the executor
    already uses twice, not a new coupling.
  - **`ExecutorOutcome.costUsd` stays invocation-scoped.** It is what the facilitator adds to the
    run budget; a phase-to-date figure there would double-count on every re-entry.
  - **Unreadable is not zero.** No `run.yml`, one that fails schema validation, or a stage id
    that does not resolve gives this invocation's own spend with the reason in brackets — never
    a confident total. A stage that has genuinely spent nothing still reads `$0.00` with no note.

- **That same header was a LOWER BOUND whenever a turn ran in-session, and nothing on the line
  said so (#139).** A host session driving `--prepare` / `--commit` without `--cost-usd` is
  recorded as `cost_usd: null` + `metered: false`, and `rollUp` sums it as nothing — so the phase
  figure is what the METERED turns cost, not what the phase cost. The dashboard has marked
  exactly this case as a `lower bound` since #103 and `tldrx budget show` prints it in words; the
  handoff header was the one cost surface that stayed silent, on the FIRST write as well as a
  re-entry. Filed as *inferred* and **measured before it was fixed**, which is what the issue
  asked for: a fixture driving the real host path — `--prepare`, a `result.json` with no
  `cost_usd`, `--commit` — put one unmetered turn beside one `$0.11` spawn and wrote
  `Cost: $0.11 of $200.00 ceiling`, a bare figure indistinguishable from a fully metered phase.
  - **One derivation, three surfaces.** The counting and the sentence moved out of
    `dashboard/model.ts` into `core/budget/spendBasis.ts`, and the header prints what it returns.
    The dashboard's model imports the page renderer, so the executor could not import IT — and
    fixing the wording in place is how two spellings of one caveat get born, which the issue
    named as the reason not to. Only the SUBJECT differs: a stage-scoped header says "the stage".
    Dashboard output is unchanged.
  - **The counts come from the same rows the sum does** — `run.yml`'s `stage.tasks`, plus this
    invocation's, for the same reason `invocationUsd` is added to the total: `recordExecutorTasks`
    runs after the executor returns, so counting `run.yml` alone would report the first write of a
    host-driven handoff as fully metered.
  - **A fully metered stage keeps its clean line.** `measured` is the one basis with nothing to
    caveat. A turn counts as having produced no dollars if it is `metered: false` OR a metered
    `cost_usd` of exactly `0` — the wider of the two readings, inherited unchanged from #103, so
    the two surfaces cannot classify the same turn differently. It is also the conservative
    direction: #138 and #139 both flattered the number.
  - **Both caveats when both apply.** An unreadable `run.yml` (#138) and an unmetered turn (#139)
    are different facts about the same figure, and the note now carries both rather than one.

- **`test/attempt-cost.test.ts` proved "carries no format refusal" with the bare word
  `REFUSED`, and unrelated prompt prose turned it red (#135).** The thing it means to detect
  is `renderFormatRefusal`'s heading; what it detected was an eight-letter English word,
  anywhere in a ~14 KB document. #133 added one sentence elsewhere in the same prompt that
  happened to use it and the assertion went red over prose that has nothing to do with a
  refusal — a wrong-instrument failure, not a behaviour change.
  - The heading is now exported as `FORMAT_REFUSAL_HEADING` from `src/core/build/review.ts`
    and asserted in place of the word, so the renderer and its test cannot spell it
    differently. Same idiom, and same reason, as `SRC_GRAMMAR_HEADING` and
    `REVIEWER_FOCUS_HEADING`. A test pins that the constant IS the rendered first line.
  - The workaround went with it: `payloadCapLines`' docstring told the next author not to use
    the word. A comment asking people to avoid an English word was never a guard, and the
    prose is free to say `REFUSED` again.
- **03-plan had NO map at all on a single-repo workspace (#136).** Its one map declaration was
  `.tldrx/map/workspace.md`, which `buildMap.ts:83-88` writes only in multi-repo mode — so on
  a single-repo workspace Plan's entire map input resolved to nothing, while all six
  `MAP_DOCS` sat unread under `.tldrx/map/<repo>/`. Measured on a single-repo fixture with a
  real map: `map PRESENT: []`, and the prompt carried no map content whatsoever.
  - Plan now also declares `.tldrx/map/{repo}/commands.md`. This is a GATE, not a preference:
    Plan writes each story's `dod.commands`, the `plan` check validates every one against the
    workspace allowlist and refuses the story when it cannot ("an empty allowlist is not a
    permit", `src/core/schemas/commandAllowlist.ts:33`) — and Plan was shown that allowlist
    nowhere. `.tldrx/workspace.yml` is not one of its inputs, the generic stage prompt renders
    no commands section (only the DEVELOPER prompt does, `prompts.ts:175`), and multi-repo's
    `workspace.md` carries repo name, path, stack, branch and confidence, not commands. The
    map document that mirrors the allowlist (`renderMap.ts:27`) was declared by no stage.
  - **One document, not six.** Plan decomposes a design 02-how has already placed on real
    paths, so architecture stays upstream; six documents per repo on a stage whose job is
    splitting and ordering is the context nobody asked for that the wave-N lesson in
    `seedInputs.ts` is about. Measured cost: +120 B on a 20,777 B prompt, against budgets of
    98,304 (`inputs_max_bytes`) and 163,840 (`prompt_max_bytes`).
  - **Multi-repo semantics are unchanged** — `workspace.md` stays, and stays without `{repo}`.
    Its absence on a single-repo workspace is still SAID rather than performed (#131): there
    is no cross-repo view of one repo, and the `absent:` block reports exactly that.

- **A re-entered Build stage OVERWROTE its own handoff with a degraded reconstruction (#137).**
  `04-build/handoff.md` is rewritten by every `tldrx next` that reaches the end of the stage, and
  its own docstring says it "describes the phase, not the invocation" — but two of its sections
  were fed from what THIS process did. So the second write over a re-entered stage (`tldrx reject`
  then `tldrx next`, or any run whose stories did not all settle at once) replaced true statements
  with false ones. Measured on `340fb91`: an Evidence ledger of two green DoD rows became
  `- no Definition of Done ran [src: absent:03-plan/stories]`, and a Gate row reading
  `(S1, S2 merged)` became `(no story merged)` while `git log epic/e1` carried both merge commits
  throughout. The Gate section is the one a human reads before merging an epic by hand, so this is
  the 2026-08-30 empty-merge defect arriving from the other side; a third section degraded quietly
  with them, Findings losing each story's merged sha to `at (no commit)`.
  - **Reconstructed where the truth is durable.** The row `fromDisk` builds for a story an earlier
    invocation settled now READS its DoD results and its merged commit from `events.jsonl` via
    `readReviewLedger` — the same reader `rereview` already trusts when it declines to re-run a
    DoD, so nothing new is being asserted. The Gate section learns what is on an epic branch from
    both sources instead of one: this process's own merges, plus the stories disk says reached
    `done`, which in this pipeline is a status only a merged story reaches.
  - **Said as absent, with its reason, where it is not.** What a merge CARRIED is counted before
    the merge and stored nowhere, and afterwards cannot be measured at all — a merged story branch
    is an ancestor of the epic either way. Those stories get a third list of their own and a row
    that names the gap and the command that closes it — *S1, S2 merged by an earlier `tldrx next`
    — what each carried was not re-measured here, run `git log epic/e1`*. Folding them into
    `merged` would overclaim; dropping them is what printed `no story merged`. A declared dod
    command whose result is in no event is named the same way against its own log, and the negative
    `- no Definition of Done ran` is now written only when the stories declare no commands.
  - The degraded handoff PASSED the claim-sources check the whole time — it reads citations, not
    truth — so nothing downstream was ever going to catch this. Five tests now pin it.
  - Answered and filed, not fixed: the header's `Cost:` line is invocation-scoped too, so the
    second write reports `$0.00` for a stage that spent `$0.44` (measured). Different seam — the
    number is not in the ledger this fix reads — so it is #138.

- **The `feature` preset declared map inputs without `{repo}`, so 02-how and 03-plan ran with
  no map at all (#131).** `stages/how/stage.yml` asked for `.tldrx/map/architecture.md` and
  `.tldrx/map/conventions.md`. `tldrx init` writes the map PER REPO —
  `.tldrx/map/<repo>/architecture.md`, one folder per repo, six `MAP_DOCS` documents each
  (`src/core/map/buildMap.ts:74-79`) — so nothing on disk could ever answer either
  declaration. They are OPTIONAL inputs, `declaredInputsOf` drops an optional input that is
  not present, and the two stages the map exists FOR were dispatched without it on every
  feature-scope run. 01-what and 05-watch carried the token the whole time, which is why two
  stages of five went wrong quietly for as long as they did.
  - Both paths gain `{repo}`. `03-plan`'s `.tldrx/map/workspace.md` deliberately does NOT:
    it is the one map document written at the map ROOT, and only in multi-repo mode
    (`buildMap.ts:83-88`), so the token would point it at a file that never exists. The
    reasoning is now a comment in the file so the next sweep leaves it alone too.
  - **Swept all thirteen scope presets.** `workflows/*.yml` compose the same five stage files
    and declare no `inputs:` of their own, so `how` was the only offender — and both facts are
    now pinned: one test asserts no shipped stage declares a `MAP_DOCS` document without
    `{repo}` (derived from `MAP_DOCS`, so a seventh document is covered the day it is added),
    another asserts no preset grows stage inputs that would bypass it.
  - **And an absence is now SAID rather than performed.** A declared input that resolves to
    nothing is named twice: as a `### Declared, but not on disk` block in the prompt's
    `## Inputs`, carrying that path's own `[src: absent:<path>]` token so the stage's handoff
    can source a negative claim on it, and as one line on stdout. This is the half that turns
    the next such typo into a first-run report instead of a live incident — a sub-agent that is
    not told what is missing cannot tell "the map says nothing about this" from "I was never
    shown the map", and its handoff records the second as the first.

- **The reviewer prompt described the result envelope in prose beside the schema that defines
  it (#133).** `REVIEW_SCHEMA` is handed to `claude --json-schema` on the spawned path and
  written verbatim into the bundle as `pending.json` → `result_schema` on the host path, so
  both halves of the handshake already answered the same question — and the prompt then
  described the same envelope again, key by key, in the one document a model reads most
  carefully. Two live reviews lost cycles to it, one because the host dictated the shape from
  memory, which is exactly what a prose paraphrase invites.
  - `## Produce` now points at `result_schema` (and at `--json-schema` for a spawn) as the
    single authority and states no field of it. The verdicts moved to their own `## Verdict`
    section, because WHICH verdict to return is judgement and judgement is what the prompt is
    for; #77's `refuted`-needs-a-citation contract is judgement too and is untouched.
  - **The 4096-byte payload cap is now named.** The verdict's prose is copied into a
    `check.passed`/`check.failed` payload, `validateEvent` refuses any payload over
    `MAX_PAYLOAD_BYTES` (`src/core/events/Event.ts:121`) and `EventLog.append` THROWS rather
    than writing a shortened line — so an essay-length verdict does not arrive trimmed, it
    takes the ledger entry down with it. The number is imported into the prompt, never typed,
    so changing the cap changes the promise.
  - Pinned by a test that asserts the prompt REFERENCES rather than RESTATES, off the schema
    itself: every field name in `REVIEW_SCHEMA` — top level and inside a `fixlist` row, minus
    the verdict words — must not appear in the rendered prompt. A field added to the schema is
    covered without anyone remembering to add it here.
- **Pruning a blocked story's worktree destroyed the work inside it (#129).** Measured live
  2026-09-02 on run `260830-money-and-payments` (aparece-v2), reported by the unattended
  driver: a story's Definition of Done failed, the executor settled it `blocked`, and
  `cleanUp` ran `git worktree remove --force` over a tree that still held the developer's
  fix, uncommitted. There was no branch, no stash and no reflog to get it back from. `blocked`
  is precisely the state a human is going to want to inspect, and it was the one state that
  destroyed the evidence first.
  - The invariant, and it has no exceptions in it: **the framework never deletes a worktree
    holding changes that reached no ref.** Before any prune, `settle` commits whatever the
    tree still holds to the STORY branch as
    `wip(<id>): rescued from a story that settled \`blocked\`` — an honest subject naming the
    verdict, the reason in the body, and "nothing reviewed this and nothing merged it" said
    out loud, because a rescue commit that read like a delivery would be #130 in another file.
  - Commit-then-prune rather than never-prune, because *recoverable* has to mean recoverable
    **by sha**: a kept directory survives until the next `run close` or temp sweep, a commit
    on the story branch survives a year. If the commit cannot be made, the worktree is KEPT
    instead and the review log names its path.
  - The sha is recorded where a human looks, not only where a terminal scrolls: a
    `## Uncommitted work rescued` section in `04-build/log/<id>.md`, and a new
    `story.work_rescued` event (§2.9) carrying story, repo, branch, sha and the settled
    status. It is the second event in the enum that records tldrx touching git on the
    operator's behalf, and it is appended only when a commit was really made.
  - `--keep-worktrees`, a story parked at `review`, and a parked developer failure are
    untouched: nothing is about to be deleted on any of those paths, so there is nothing to
    rescue from. A green story rescues nothing either — `commitIfDirty` has already put every
    byte on the branch.
  - Red first, in `test/blocked-prune.test.ts`: on `14f01ec` a blocked story's `s1.txt`
    existed nowhere — `git cat-file -e story/<run>/S1:s1.txt` exited non-zero and the tip of
    the story branch was still `chore: fixture repo`. Five tests, including the
    commit-cannot-be-made path (a `pre-commit` hook that exits 1), which asserts the tree is
    still there with the file in it.

- **The fix list recorded `Resolved: yes` over a fix that did not exist (#130).** Same
  incident, and the driver called it the most dangerous of the four because it fails silently
  and in the wrong direction: `04-build/fixlist/S4-1.md` ended with **`Resolved: yes`** and a
  `result.json` describing the fix in detail, while the code did not contain it — the worktree
  holding it had been pruned (#129) before anything reached a ref. The audit trail said a
  defect was closed while it was alive, and one approval away from carrying the story to
  `done`. Root: the accounting was written from an agent's REPORT rather than from a verified
  code state, which is the one thing this framework refuses everywhere else and had never
  applied to its own bookkeeping.
  - **A close now carries the sha the fix landed as**: the line is `Resolved: yes <sha>`, and
    the sha is CHECKED before a story may settle — it must resolve to a commit in the story's
    repo (`git rev-parse --verify <sha>^{commit}`) and be reachable from the story branch
    (`git merge-base --is-ancestor`). A bare `yes` closes nothing; `isOpen` treats an
    unevidenced claim as an open finding.
  - **The record stops lying about itself.** A claim that does not check out is rewritten in
    place to `Resolved: claimed-unverified — <why>`, keeping the fact that somebody reported a
    fix while withdrawing the assertion that it landed. Three refusals, each named: no commit
    to point at, a sha that is not a commit in the repo, a commit that is not on the branch.
  - One-directional by construction: verification can only move a finding from closed to
    OPEN. Nothing here closes one, and a `Resolved: no` is never touched. Every `Resolved: yes`
    is checked whatever its disposition — a `defer-with-log` claim over a fix that does not
    exist is a smaller problem and the same lie — while only a `fix-now` gates `done`.
  - The artifact teaches the form: its preamble now says `Resolved: yes <sha>`, says a bare
    `yes` closes nothing, and says the sha is checked. So do the router's lines in a
    `--prepare --fixlist` bundle and the block message on a refused `done`.
  - Red first, in `test/fixlist.test.ts`: on `14f01ec` a fix list edited to `Resolved: yes`
    with nothing landed settled the story `status: done`, evidence `commit 3380cca`, over two
    live `fix-now` findings — and `Resolved: yes deadbeefdeadbeef` did the same. Two existing
    tests that encoded the old contract were updated to name a real commit on the story branch;
    they still prove that closing every finding lets the same approve settle `done`.

- **The Build handoff cited a story branch that does not exist (#134).** Any run whose stories
  did not all settle in ONE `tldrx next` — the ordinary shape once a stage is re-entered — got
  a Findings row reading ``done — repo `app`, `story/S1`, merged into `epic/e1` ``, and
  `git show story/S1` fails, because the branch the executor cut and merged is
  `story/<run-id>/S1`. The run id in that name is a deliberate invariant (§"Build branch and
  worktree names carry the run id", after the 2026-08-29 audit and #40); the handoff's
  reconstruction path for a story settled by an earlier invocation had its own copy of the
  formula and the copy predated the invariant.
  - Fixed as **one derivation, not two**: `storyBranchOf(runId, storyId)` in
    `src/core/plan/branchModel.ts` is now the only place the name is written, and all three
    callers — the cut in `openStory`, the reconstruction in `fromDisk`, and the
    `--discard-pending` evidence check on an implicit plan — go through it. A second formula
    that matched would only postpone this; the name is a pure function of two ids that are
    both in scope, exactly like `integrationBranchFor` and `epicWorktreeName`, so there is
    nothing to persist and re-read.
  - **Reporting only, and checked rather than assumed.** `StoryOutcome.branch` has three
    consumers and all three render text: the handoff's `finding()`, the review log's
    `- Branch:` line, and the retro's merge-conflict line. Every git operation and every
    command a host is handed to run — `addWorktree`, `commitsBetween`, the reviewer bundle's
    `diff`, the fix list's `diff` — reads `StoryContext.branch`, which `openStory` cut. No
    ref was resolved from the wrong name, so nothing merged, moved or deleted wrongly; it was
    a wrong name in an audit document.
  - Red first, in `test/build-executor.test.ts`: on `30737a5` a second invocation's handoff
    contained ``story/S1`` where `story/260829-build/S1` was expected, and
    `git rev-parse --verify story/S1` exited 128 (`fatal: Needed a single revision`). The test
    now asserts every `story/…` ref the handoff cites resolves in the repo, and a second one
    asserts the template is written nowhere in the executor.

### Added

- **The Plan prompt now says how to make a `touches` list COMPLETE (#132).** Measured on one
  live run: 3 of 5 stories needed their write surface extended after the fact. S2 could not
  write the failing test its own test plan promised, because the test file was outside
  `touches`. S4 added two enum members and left out the switch sites, so the branch did not
  compile. S8's security criterion read a file the story never declared, so the criterion
  would have passed on nothing. The developers caught all three — at the cost of a round each
  time. Every other rule in `## Output schemas` is generated from a validator, because a
  validator refuses what breaks it and says why; under-declaration breaks no rule at all.
  `["src/thing.ts"]` is a well-formed list, `validateStory` passes it, and the bill arrives
  one stage later at the developer prompt's "change only what `touches` names" and at
  auto-gate condition 7 `boundary`.
  - A `### Completing \`touches\`` sub-section in `renderPlanSchemaContract()`, ~1.3 KB in the
    cached, most-stable part of a prompt whose stage budget is $4: three sweeps, one per real
    failure — its tests · every switch, registration, factory, DI container or barrel a new
    name has to reach · every file a gated criterion reads — plus what omitting one costs, so
    the reason is in the prompt rather than in an issue. The `touches` row of the generated
    table now points at it instead of restating it.
  - Prose on purpose, and the only prose in that file: no compiler runs at Plan time, so
    nothing can compute this list. **Compile simulation stays the escalation path** if the
    checklist measures poorly on the next runs.
  - Red-first in two places: `test/plan-schema-contract.test.ts` pins the three rules and the
    cost statement against the rendered contract, and `test/plan-contract.test.ts` pins them
    against the prompt the real `tldrx next --prepare` bundle writes — a contract that renders
    correctly and is spliced into no prompt is the `templates/story.md` failure again (#48).
    6 red before, green after. `docs/spec.md` §2.13 and the `delivery` expert each carry one
    line pointing at the checklist.
- **The landing page now sells the unattended flow it never mentioned (#128).** Measured at
  `95a39db`: `grep -c 'tldrx drive' docs-site/index.md` returned `0`, and so did its Spanish
  twin — a bare `grep drive` exited `1` on both. `tldrx drive` is the star command for handing
  a run over for the night; it has a guide in each locale and a chapter behind that, and the
  front door had still never named it. The landing walked a reader from `run new` through
  `next` / `approve` / `reject` to `run auto` and stopped, which is where the reader stopped
  too — the one flow that most needs explaining was reachable only by someone who already
  knew to go looking for it.
  - One compact section per locale — "When nobody is watching" / "Cuando nadie está viendo" —
    led by the outcome rather than the flags: hand a run over inside boundaries you wrote
    down, and get the run itself back instead of a summary you have to believe. It shows the
    three-command path (`tldrx init` → `tldrx run new … --attended-by host --gates …` →
    `tldrx drive --unattended`) and links to the guide for the rest.
  - The hero is untouched in both locales, and both pages are pure insertions — no existing
    line was edited.
  - Pinned in `test/public-surface-consistency.test.ts`: each landing must name `tldrx drive`
    and link to its guide. Red on both locales before the change, green after. The pin is on
    the entry point, not the prose — heading, wording and placement stay free to change.

## 0.6.0 — 2026-09-02

### Added

- **A gate record now says which entity evaluated it and under whose authority (#122).**
  Measured 2026-09-02 on run `260902-discovery-pipeline-map`:
  `{"type":"gate.approved","actor":"alanmartinez","payload":{"by":"alanmartinez","note":"agent-gate: evidence=sign by alanmartinez, …"}}`
  — a gate an AGENT evaluated and signed, under authority the owner delegated once at
  `run new --gates what:agent`. Nobody named `alanmartinez` looked at that stage. `by:` is a
  name and never a kind, the agent signs under the operator account it is running as, and six
  months later that record reads as "Alan personally reviewed this". The only trace of the
  delegation was the prose inside `note:` — which nothing parses and any hand-typed
  `--note "agent-gate: …"` can forge.
  - Two additive blocks on `run.yml`'s gate mapping and on the `gate.approved` payload:
    `executed_by: {type: human|agent|auto, id?}` and
    `authority: {type: direct|delegated, policy, authorized_by, source}`. Between them they
    answer the four questions an audit asks — who authorized the decision authority, which
    entity evaluated THIS gate, whether it was a person / an agent / the facilitator, and
    under which policy.
  - **The executor's kind is read off how the gate is being closed, never off the policy.**
    A person may always `approve` an `agent`-gated stage with no flag; that is a human acting
    directly, whatever the stage was set up to allow, and it is recorded as one.
  - **Derived, never guessed.** The policy is the run's own frozen `gates_policy`. The
    authorizer is the actor of the `gate.policy_changed` that last moved that stage's policy,
    or — when nothing moved it — the actor of `run.created`, who froze it at `run new`, and
    `source` names which. When the log says neither, `authorized_by` is `null` and `source` is
    `unrecorded`: the absence is said out loud rather than filled in with a plausible name,
    and the validator refuses a record where those two do not travel together.
  - **`by:` is untouched**, and so is `gate.evidence`. `by` is what the note said, and the
    note is the agent's own claim about itself; rewriting it would be inventing a second one.
    `gate.evidence` says what was checked — not who checked it under whose authority — and
    its `role:` is a job an agent gave itself, not an identity the framework measured.
  - **Old records read exactly as they did.** A gate written before these keys has neither,
    validates, loads, and emits byte-for-byte; every reader falls back to `by`, and so does a
    person who signed as themselves — for them the name is the whole truth. Pinned by test in
    `test/gate-authority.test.ts`.
  - `tldrx run status`, `tldrx replay` and the dashboard render a delegated signature as
    `agent alanmartinez (delegated by alanmartinez, policy: agent)` — one shared renderer,
    `describeGateSignature`, so the three cannot disagree. The dashboard carries its own
    closure-free copy (`dashSignature`) because everything serialised to the browser may close
    over nothing, and the two are asserted to agree case for case, exactly as `dashEscape` is
    against `escapeHtml`. `DASHBOARD_MODEL_VERSION` stays at **3**: additions never bump it.
  - A revoked gate DROPS both. `by: null` says nobody signed it, and an executor left beside
    that would be two contradicting claims about one fact.

- **`tldrx run status` prints a stage's duration and says when a gate was signed with
  words (#120).** `run.yml` has recorded `started_at`, `ended_at` and `gate.note` on every
  stage since `run new` wrote the first one. #118 put all three on the dashboard's
  `StageRowModel` and drew them; `runStatus.ts` built its own record from the same file and
  was not touched, so the page and the CLI disagreed about what is knowable from one file —
  a reader watching a stage that had been running for hours saw no sign of it in the
  terminal. Each gate row (one per stage) now ends with a compact duration and a `✎` on a
  signed note, and `--verbose` adds the two instants behind a duration, the sentence behind
  an absent one, and the note itself.
  - **One subtraction, not two.** `dashDuration` / `dashDurationAbsence` moved out of
    `dashboard/render.ts` into `core/run/duration.ts`, a leaf that imports nothing and that
    both surfaces read — rather than a second implementation of the same arithmetic. They
    keep their `dash` names because `clientRenderer()` serialises the DEFINITION name into
    the page, so a rename would be a `ReferenceError` on the live dashboard rather than a
    build error; both are still closure-free and still serialised.
  - **Still no stored duration, and still no synthesised zero.** A stage with a `started_at`
    and no `ended_at` reads `not ended`, one with the reverse reads `no start`, and two
    timestamps that do not yield a gap read `bad timestamps`. A stage with NEITHER end says
    nothing on the line — it has no clock to account for and its status column already says
    `pending`; printing "not timed" on every row of a fresh run is noise, not honesty, and
    `--verbose` still names that case in full. `note: ""` is not a signature: it reads as
    `null`, is never marked and is never quoted.
  - **`--json` is additive.** `started_at`, `ended_at` and `note` are appended to each gate
    row; every top-level key keeps its position, so a consumer reading `run`, `waiting.kind`
    or `gates[i].by` is untouched. A new test pins the row's key order the way
    `SINGLE_RUN_KEYS` pins the top level's.

- **The docs site's demo dashboard now shows the story grid and the Waves view with
  something in them (#119).** `gen-demo.ts` composed its workspace from two fixtures,
  neither of which had ever reached the Plan phase, so `loadPlan` returned null for all
  eight runs and every plan-shaped rendering on the public page drew its EMPTY state: the
  Waves view said "No waves in this workspace", the story grid drew nothing at all, and
  Plan & build said the Plan phase had written no stories. A demo of a dashboard that
  cannot show two of its own views is a demo of the wrong thing.
  - A **third** synthetic fixture — `test/fixtures/plan/workspace`, one run at Build with
    six stories over two waves, two epics on two repos, a fix round on S2 and two review
    retries on S5 — added to `DEMO_SOURCES` beside the other two. Third rather than an
    edit, because a `03-plan/` dropped into a chain run would move that run's
    `stagesTotal`, `stagesDone` and `percent` (numbers `dashboard-deps.test.ts` reads),
    and `dashboard.test.ts` asserts — correctly — that the views fixture's one run carries
    `plan: null`. Both existing fixtures stay byte-identical.
  - Synthetic like everything else on that page: it lives under `test/fixtures/`, so
    `assertSynthetic` is what permits it to be read at all, and the demo stays
    deterministic (fixed clock, invented root, no machine path).
  - Measured over the composed workspace: 9 runs, 2 experts, 0 unreadable files, 0 skipped
    events, 6 stories across 2 waves, and `run.build` non-null for the first time.

- **A stage now carries when it started, when it ended and what its gate said (#118).**
  `run.yml` has recorded `started_at`, `ended_at` and `gate.note` on every stage since
  `run new` wrote the first one, and `StageRowModel` carried none of the three — so the
  phase timeline (#107) printed neither a duration nor a signature and had to carry a
  paragraph explaining why. Three additive fields, read off the same `run.yml` object the
  row was already built from. `DASHBOARD_MODEL_VERSION` stays at **3**: additions never
  bump it, and no existing field reads differently than it did at v3.
  - **No duration is stored.** A duration is a subtraction, it exists only when both ends
    do, and a model field would have to pick a number for the case where one end is
    missing — `0` is a measurement of zero, and inventing one is exactly the class of
    confident-wrong figure this redesign exists to stop. `dashDuration` does the
    subtraction where it is drawn, and a stage that recorded neither end gets a sentence
    naming *which* end is missing rather than a blank cell reading as "it took no time".
  - **An empty note is an absent one.** `note: ""` is what `run new` writes on a gate
    nobody has signed. It reaches the model as `null` and is not quoted at a reader as if
    it were a signature.
  - The timeline draws the duration beside the cost on each stage's summary row and quotes
    the gate's own words inside its drawer — the two of #107's four asks that could not be
    met before.
- **`tldrx dashboard --serve` pushes only when the page would actually change, and ages
  itself when it would not (#108).** The live server already watched the tree and pushed a
  `reload` per debounced burst; three things were missing, and each one is a different way
  for a live page to lie.
  - **A push per burst is not a push per change.** Every write under `.tldrx/` or
    `tldrx-work/` pushed, including writes to files the model does not read — `--static`
    writes into `.tldrx/cache/`, inside the watched tree, so exporting a page while serving
    one made the served page redraw because it had been photographed. The trigger is still
    the file event; the DECISION is now a rebuild of the model compared against the one the
    page is showing, on a fixed clock so ages do not make every rebuild differ. A digest of
    "the files that matter" was rejected on purpose: that list drifts the moment the model
    reads one more thing, and its failure mode — a dashboard that quietly stops updating —
    is exactly what the comparison cannot do.
  - **Silence is a state the files cannot announce.** Ages, and the `quiet` mark #107 puts
    on half an hour of nothing, are computed against a `now`. With only file-triggered
    pushes a stalled run keeps saying "2m ago" until somebody writes a file: the one state
    worth seeing is the one state the page could not reach. A new `age` event carries a
    timestamp every 25 s, whatever the disk is doing, and doubles as the stream's
    keep-alive — a tick that says something, at the cost of the comment that said nothing.
  - **The ledger is read forward.** `events.jsonl` is append-only, so
    `src/core/dashboard/tail.ts` keeps a byte offset per run and reads only what arrived —
    holding back a line whose newline has not landed, starting over if a ledger shrinks
    under it, and dropping a run's offset when the run goes. That is what lets a `reload`
    carry `{at, appended, runs, added, removed}` and say *three events landed on this run*
    rather than only *something changed*.
  - **`--serve` is a flag now**, and `--serve --static` is a refusal (exit 2) rather than a
    silent pick of one. Serving is still the default.
  - **`listRuns` no longer throws while the disk is being written to.** An entry removed
    between the `readdir` and its `stat`, and a `tldrx-work` that is not a directory, both
    escaped `buildModel` — measured, both reproduced. A live reader asks that question
    while a wave is writing.
  - The live page keeps the reader's FOCUS across a repaint (scroll and open panels were
    already kept), because only a live page redraws when nobody asked, and #107's j/k
    navigation loses its place otherwise. That code is in `liveScript()` alone: the static
    export is byte-identical to what it was before this landed, and a test pins the hash.

- **An answer that overtakes an earlier phase's document now says so on that document
  (#104).** A phase document is a point-in-time snapshot, and an owner answer recorded
  three phases later can flip a design it still asserts. Measured twice on
  `260830-ordering-inventory`: `03-plan/stories/S4.md` promised a `[Theory]` proving an
  inert stock-effect default after F021 established Restock for 5 of 64 pairs and the
  shipped test was a different one; `02-how/design.md` and its handoff said "no
  order_number column is created" after F022 ordered one. Both flips were recorded — in
  `questions.md`, in `facts.yml`, in `retro.md` — and neither was in the file a reader
  opens. The audit's conclusion, "read `04-build/` rather than `03-plan/` for what
  actually shipped", was tribal knowledge nothing on the page taught.
  - **The question already names the document.** §2.7 requires `Why asked:` to end with a
    `[src: …]` token proving the gap is real, and a question raised in Build about a plan
    claim cites that plan claim — that is what the citation is for. So the affected set is
    derived from data the grammar already makes mandatory: every `file` ref pointing at a
    `.md` in an EARLIER phase of the run. No new schema, no new habit. A citation into the
    question's own phase is not a supersession — that is an author reading their own
    half-written page — and an optional `affects:` metadata key names documents explicitly
    for when the honest citation is a source file rather than a document.
  - **A marker, not a reconciliation.** One HTML comment carrying the fact id and one
    blockquote line pointing at `questions.md` and `facts.yml`. Rewriting the stale
    sentence would mean knowing which sentence, and guessing that is how a framework
    starts inventing content. The issue asked for an honest marker; full reconciliation is
    explicitly not required.
  - **Three properties it had to have, each pinned by a test.** Append-only
    (`appendFileSync`; the RED test asserts the phase's own bytes are still the file's
    prefix). Idempotent per fact — the comment carries the id, so the `answer-capture`
    hook firing twice on one edit stamps once, while a *different* fact stacks under the
    first. And invisible to the checks that guard the document: the stamp is deliberately
    not a list item and carries no `[src: …]`, because a bullet appended to a `handoff.md`
    would land inside a §2.8 section where every item must be sourced, and `claim-sources`
    would refuse the very document this makes honest. A stamped handoff validates with the
    same `bulletCount` and the same verdict as before.
  - Both recording paths stamp: a first answer and `tldrx answer … --supersede`. Each
    stamped document appends a `doc.superseded` event (new, closed-set §2.9 type) carrying
    the run-relative path, the fact, the question and whether the document was `cited` or
    named in `affects`; `tldrx replay` renders it. A stamp that cannot be written never
    fails the answer — the decision is recorded and the failure goes to the log as `error`.
- **The dashboard opens on a "Now" strip, and it says what it does not know (#107).** The
  render half of the owner-approved redesign, on top of the model #103 shipped. The runs
  view now leads with one card per **live** run — every run that is neither `done` nor
  `cancelled`, so a run nobody has started and a run nothing can move are both on it, with
  the ones that raise an ask sorted to the front. Each card carries the phase dots, the
  status, the ask in the page's own words with the command that closes it, the spend, and
  how long it has been quiet. It **replaces** the alert stack rather than sitting beside it:
  it is a superset — the same `dashPending` ask, the same `alert__kind` badge, the same
  sentence — over more runs.
  - **A lower bound never gets a bar.** A progress bar is a claim about a denominator, and
    it is honest only when the number over it is the whole of what was spent. On the run
    #103 audited, 30 of 34 turns put nothing in the meter and not one declared a token, so
    `$14.60 of $62.00` under a quarter-full bar was a confident wrong number drawn in the
    one shape a reader cannot argue with. The bar is now reserved for `spend.basis ===
    "measured"`; every other basis gets the metered figure, a **lower bound** mark carrying
    `spend.reason` in its tooltip, and the count of costless turns out of the total — so the
    size of the gap is a number and not an adjective. Host tokens are printed beside the
    dollars and never added to them.
  - **"Quiet" is 30 minutes, and it is the RENDER's threshold.** The model reports
    `ageSeconds` unclamped and bakes in none, which is right — a workspace where a stage
    takes forty minutes and one where it takes forty seconds cannot share a constant. So the
    page picks, in one comparison, in one place, and says so on the reference page. An
    `mtime` reading prints **touched** rather than "last event" (the file was written, which
    is not the run moving) and a ledger dated after the read is named as two clocks
    disagreeing rather than laundered into "0m ago".
  - **The dots are the phases the run's own file declares.** `run new` writes the whole
    workflow up front (`buildPhases`), so a `feature` run really does draw five, what →
    watch, from the moment it exists — and a `docs` run draws what a `docs` run has. Nothing
    is padded to five for the shape of it.
- **Three drill-ins on the run detail, and each one names what it cannot show (#107).** A
  **phase timeline** — a lane per phase with its cost, each stage a `<details>` opening onto
  the gate, its policy, its signer and an agent signature's evidence, with the execution-path
  table moved inside a closed panel rather than drawn twice. A **story grid** — one status
  cell per story, forty of them legible without scrolling, each opening onto the plan file's
  fields, the attempt the ledger last recorded, the free review retries and every reopen. An
  **event stream** — the three timestamped kinds the model carries (operator notes,
  `budget.blocked`, `story.reopened`) in one time order, filterable by kind with the same
  button vocabulary the runs list uses. Reading a note next to the refusal two minutes before
  it is how a person works out why somebody rebased a branch by hand.
  - The absences are printed where the numbers would be. A stage's `started_at`, its
    `ended_at` and a gate's free-text `note` are in `run.yml` and on no field of the
    dashboard model, so the timeline reports no duration and quotes no signature. A story's
    build log and its fix list are files the Build writes and the page does not read. The
    stream says out loud that it is not the ledger — `tldrx replay <run>` is. A blank cell
    reads as "nothing happened", and that is the failure mode this whole redesign is about.
- **A Waves view (#107).** The plan as bars: a row per wave, a bar per story in it, fix
  rounds and free review retries marked on the bar. Gantt-lite and deliberately not a Gantt —
  the axis is the WAVE, because that is the only ordering the files actually assert;
  `StoryModel` carries no start and no end, and an invented x-axis would read as measured. A
  story the plan schedules into no wave gets its own row rather than being dropped.
- **Craft: keyboard reach, tabular money, still one file.** <kbd>j</kbd>/<kbd>k</kbd> move
  between cards and rows, <kbd>enter</kbd> opens the focused one, <kbd>/</kbd> jumps to the
  filters — printed under the filter row, because an undiscoverable shortcut is not a
  feature, and bound only to keys no browser or screen reader already owns. Money and token
  counts are tabular, so a column of cards reads as a column of numbers. The two marks that
  say "this figure is not what it looks like" — `lower bound` and `quiet` — are words, not
  colours, so they survive a greyscale print and a reader who cannot tell amber from citron.
  Both themes still come from `prefers-color-scheme`, the export is still one self-contained
  file with no network reference of any kind, and there is still no framework: vanilla, CSS
  grid, and `<details>`.
  - `DASHBOARD_MODEL_VERSION` does not move. Nothing here reads a file, adds a field or
    changes what one means — it is the drawing half, and the model it draws is #103's
    unchanged.

- **The docs site now SHOWS the dashboard instead of describing it (#106).** A new
  [Live demo](https://ederwii.github.io/tldr-experts/demo) page in both languages frames a
  real `tldrx dashboard --static` export — eight runs, two experts, gates, questions,
  dollars — rendered at build time by `docs-site/scripts/gen-demo.ts` and served from
  `/dashboard-demo/index.html`. It is the shipped `buildModel` and the shipped
  `renderDashboard`, not a screenshot: change the renderer and the page on the website
  changes on the next deploy, which the workflow's `paths` filter now guarantees by
  redeploying on any change under `src/core/dashboard/` or the two fixtures behind it.
  - **The data is synthetic, and that is enforced rather than promised.** The generator
    composes its workspace from `test/fixtures/views/` (one detailed run — handoff, open
    questions, budget ledger, events, two trained experts) and `test/fixtures/chain/` (seven
    more, carrying every status a reader should learn to recognise and the dependency edges
    between them). `assertSynthetic()` resolves every source path and refuses anything
    outside `test/fixtures/` — including the framework's own checkout, which IS a tldrx
    workspace and is where a careless default would land. The page is public and permanent;
    a real run read here would publish a client's domain, and it would look like it worked.
  - **Two things the first build got wrong, both caught by the tests that were written
    first.** `model.root` is DRAWN on the page, so the export carried the build machine's
    temp directory (`/var/folders/…/tldrx-demo-AUfHya/`) into a public document and changed
    on every build; the demo now renders with the root it is about, and a test asserts no
    path from the building machine appears anywhere on the page. And `public/demo/` collided
    with `docs-site/demo.md` — `cleanUrls` builds that as `demo.html`, so a site holding both
    asks GitHub Pages to guess what `/demo` means. The export moved to `/dashboard-demo/`.
  - **One banner, and it is additive by construction.** A reader arriving from a search
    result has none of the page's framing, so the export carries one line saying the numbers
    are invented. Strip it and the bytes are identical to what the CLI writes — asserted, so
    the demo cannot drift into being a mock-up of the command instead of a run of it. It
    links nowhere: the export fetches nothing, and that is the property that lets it sit on a
    static site at all.
  - The docs workflow now installs the ROOT dependencies too. Module resolution for the
    dashboard's `yaml` import walks up from `src/`, where `docs-site/node_modules` is not on
    the path — without that step bun quietly auto-installs the package at build time, which
    is an undeclared network fetch. Measured 2026-09-02: `import "yaml"` from `src/` fails
    outright once the root `node_modules` is gone.

- **The run headline shows BOTH economies, or says why it cannot (#103).** A cold
  adversarial audit of a real host-attended run (`260830-ordering-inventory`,
  aparece-v2, 2026-09-02) found every ledger surface reconciling to a perfect 0.00 delta
  at **$14.60** — `run.yml` `spent_usd`, the `events.jsonl` sum, the stage sums, the task
  sums and the `budget.yml` phase sums — over 34 turns of which **4** carried money. The
  run's own watch gate note puts the real figure at "about 81 dollars". The framework was
  not mis-metering; the front page was lying by omission, and the auditor's verdict line
  was "they should re-derive the cost". This is that re-derivation, as a REPORTING change
  and not a metering one.
  - `Run.spend` carries the metered dollars, the turns the meter could not see, and what
    was declared about them. **Both spellings of "this turn cost nothing" are counted**:
    the `cost_usd: null` + `metered: false` one the model already knew (14 of that run's
    turns), and the flat `cost_usd: 0.00` written by an executor turn a host session drove
    (16 more), which reads as a measurement of zero and is not one. `unmeteredTasks` keeps
    its exact old meaning and `zeroCostTasks` is a second count beside it — a file that
    says `0.00` is not re-labelled, it is counted.
  - **What is not in the files is named `absent`, never guessed.** `spend.basis` is one of
    `measured` / `declared` / `partial` / `absent`, and `spend.reason` says which in a
    sentence carrying the CLI's own words ("the metered total is a LOWER BOUND, not a
    total"), so the page and `tldrx budget show` cannot word the same fact two ways. No
    price table is consulted, no token is converted to a dollar, and no estimate is
    synthesised from stage prices or turn counts. The audited run is the `absent` case:
    all 920,641 of its declared tokens sit on turns that ALSO carried dollars, so they
    describe none of the 30 turns that carried none.
  - The run detail's `spent` row now names the whole gap. It used to read "+ 14 unmetered
    turns (in-session)" beside $14.60 — 14 of the 30 turns that put nothing in the meter.
- **A run says when it last moved (`lastEventAt`, `lastEventFrom`, `ageSeconds`).** The
  `ts` of the last line of `events.jsonl`, falling back to the file's mtime when nothing
  in it parses — and `lastEventFrom` NAMES which of the two, because an mtime is the
  weaker fact: the file was touched, which is not the same as the run moving. `ageSeconds`
  is a measurement with no threshold in it; nothing in the model decides what "stale"
  means. It is not clamped either, so a ledger written after `now` reports a negative age
  rather than a comfortable zero. The mtime is carried on `LoadedRun` by the reader that
  already opens the path, so the ledger is still read exactly once per run.
- **`Run.nextAction` — who is waited on right now, where, and what closes it.** `waiting`
  answers that as prose, and a card that wanted the command in a button had to regex the
  sentence. This is the same answer pre-split, and **nothing in it is a second
  derivation**: `kind` and `message` are `waiting`'s verbatim, `command` and
  `alternatives` are the backticked spans read OUT OF that message, and `waitingOn`
  applies `isMovable` — the framework's own definition of "a human could move it right
  now" — in the same precedence `dashPending` already uses. `unknown` is the honest fifth
  value: a `blocked` run with no sibling named has a `run.yml` recording no cursor, and
  the model will not guess who fixes that.

`DASHBOARD_MODEL_VERSION` stays at **3**. Five additions, nothing removed, and no existing
field reads differently: `spentUsd` is still the same `run.yml` key holding the same
number, and has meant "METERED dollars, a lower bound when `unmeteredTasks > 0`" since v3.
A consumer that read it as a total was wrong before this wave and is wrong by exactly the
same amount after it; what changed is that the page now says how big the bound is.

- **`scripts/merge-wave.sh` now gates the documentation site too (#114).** The wave ran
  typecheck, `bun test`, `build` and the runtime-seam grep, pushed, and left the site to
  `.github/workflows/docs.yml` — *after* the merge. That is a build with two failure modes
  the test suite cannot see: `ignoreDeadLinks: false` in `docs-site/.vitepress/config.mts`
  is deliberate, so a page somebody moved breaks it, and `docs-site/package.json` runs
  `gen-changelog.ts` and `gen-demo.ts` before VitePress, either of which can throw on input
  no test feeds it. Both used to land on `main` GREEN and go red as a failed **deploy** —
  `main` broken and the published site stale, the worst of both. `bun run docs:build` is now
  the fifth gate, on the same tree as the other four, and a red one is `docs=1` in the FAIL
  line and nothing pushed.
  - **It blocks, and the cost is why that was affordable.** Measured 2026-09-02 on this
    repo, warm: 4 s wall — VitePress 2.91 s plus a `bun install --frozen-lockfile` in
    `docs-site/` that installs 126 cached packages in 165 ms — against a wave whose
    `bun test` alone is ~440 s. `git status --porcelain` is empty before AND after it, so
    the new gate cannot leave dirt that fails the NEXT wave's dirty-tree guard: everything
    it writes (`.vitepress/dist/`, `.vitepress/cache/`, `reference/changelog.md`,
    `public/`) was already ignored.

- **A surprised merge-wave assertion now prints the logs the script kept (#115, instrumentation
  only — the flake is NOT fixed).** CI run 33653699970 (`b64950d`) caught one failure in 3161:
  run A of the #44 concurrency test exiting 2 — *merge conflict* — in a sandbox whose only
  merge adds a file nothing else touches. It could not be diagnosed, because merge-wave keeps
  a red run's logs on purpose and `afterEach` deletes the sandbox they live in first. The
  concurrency tests now assert through `expectExit`, which on any unexpected code raises the
  exit, stdout, stderr **and every file in the `mw-<pid>` directory the script kept**,
  `merge.log` first — the artifact #115 asked for. The next occurrence arrives explained.
  - **What the search ruled out, so nobody repeats it.** Measured 2026-09-02 on macOS,
    git 2.50.1: a truncated or empty `reference-transaction` hook does NOT fail a ref update
    (both exit 0), and 800 real commits against 4000 concurrent `merge-guard.sh --install`
    rewrites produced 0 failures — so the non-atomic hook install is not the cause. No test
    in the suite sets `MW_LOCK_*`, so cross-file env contamination is not either. The one
    mechanism that reproduces exit 2 exactly is the guard REFUSING (`fatal: ref updates
    aborted by hook` → merge-wave's conflict branch), which needs the lock to carry a live
    owner and a token that is not the merging run's. 40 runs of `test/merge-wave.test.ts`
    four-way concurrent under 20 CPU spinners did not produce it.

- **A drift guard over the public surfaces (#121).** `test/public-surface-consistency.test.ts`
  fails when the README, the docs site (both locales), `env.yml` and `package.json` stop
  agreeing with each other. It reads files off disk, spawns nothing and touches no network,
  and every failure names the file and line to go fix. It checks that no page states the
  current version as a literal (it must be interpolated), that every release-shaped literal
  left in the prose is a version we deliberately cite as history, that the README release
  table leads with `package.json`'s version, that the docs config derives the version rather
  than hardcoding it, that `env.yml` does not require Bun, that no quickstart tells a reader
  they need Bun to run tldrx, and that no surface carries a claim we have retired.
  - Red-first, against the tree as it stood: 6 of 10 assertions failed, one per real defect.
  - `scripts/release-check.sh` already compared `package.json`, `plugin.json`, `CHANGELOG.md`
    and the README table — but only at release time, when the drift has already shipped. This
    runs on every PR through `ci.yml`.

### Changed

- The staleness field is spelled `lastEventFrom`, not `lastEventSource`. The model is
  embedded in the static page verbatim, and one of this repo's oldest guards is that the
  exported page contains no `EventSource` — a static export must make no network call. A
  field named `lastEventSource` puts that substring in every page and makes a JSON key
  indistinguishable from the live-reload script the guard exists to catch. The guard is
  right; the name was wrong.

### Fixed

- **`validateEnv` now enforces the two `env.yml` rules §2.10 designed, and §2.10 stops
  designing the third (#126).** The spec stated four validation rules as fact; the schema
  enforced none. #125 removed one with its field and reworded the rest into "designed and not
  yet enforced" — honest, and it settled nothing.
  - **Ids are unique across `tools`**, and the message says what a duplicate costs rather
    than that it is untidy: `runDoctor` iterates `tools` and probes each entry, so a repeated
    id ran the same `check` twice and printed two rows for one tool. Reported at
    `tools[i].id`, naming where the id was first declared. A non-string id gets its type
    error and no uniqueness complaint on top of it.
  - **At most 64 tools**, `MAX_ENV_TOOLS`, interpolated into the message rather than typed
    into it (gh #38). Nothing bounded the file before; `env.yml` declares 7.
  - **The metacharacter rule is DELETED from the spec, not implemented.** "`check` free of
    `; && | > \`" was not a missing check but a disagreement about what `check` is:
    `ToolChecker.check` runs `runtime.spawn("sh", ["-c", tool.check])`, so every `check` in
    every manifest that ever shipped has been executed BY a shell, and §2.10's own
    `[assumption]` depends on it — `check: "test -n \"$VAR\""` is nothing without a shell to
    expand `$VAR`. Enforcing it would have been a behaviour change that broke the manifest's
    idiom in order to defend an owner against a file they wrote, committed and reviewed like
    code, running on their own machine as themselves. §2.10 now says what `check` is instead,
    and `test/env-validation.test.ts` pins that a metacharacter-bearing `check` validates AND
    that the runtime really shells out — measured through `ToolChecker`, not read off the
    source. The `result:` / `checked_at` prose is untouched: still designed, still not built,
    still says so.

- **The status line's gate counter is `machine:N`, and counts every gate a machine closed
  (#127).** `runSnapshot` computed it with `gate.by === "auto"` — the selector #124 had just
  removed from `tldrx status` — so an agent-signed gate was invisible on the one line an
  operator actually watches. Measured on the #122 fixture after `runNext` closed an `agent`
  gate: `gate.by=alanmartinez executed_by={"type":"agent","id":"alanmartinez"}` and
  `autoGates=0`. A run whose only closed gate was signed by an agent showed no segment at all.
  - **The label moved with the selector.** Widening the count and keeping `auto:` would have
    replaced one untrue number with an untrue name: `auto` is a specific actor in this system
    (`AUTO_GATE_ACTOR`), not a synonym for "the machine", and reusing it for the superset is
    the exact ambiguity that hid the agent case the first time. `machine` is the word
    `tldrx status` already uses one screen away — "N gate(s) closed by a machine, not by a
    person" — so the glance and the report are now in one vocabulary.
  - **One selector, in one place.** `closedByMachine` moved out of `status/runItems.ts` into
    `core/run/gateAuthority.ts`, beside `describeGateSignature`, and both surfaces read it.
    The report and the line answer the same question about the same field, and had already
    drifted once: #124 fixed one copy, and #127 was the other copy, still saying `auto`.
  - **The tolerant reader still claims nothing it cannot see.** It does not parse gates, its
    `0` means "cannot see", and it renders as no segment — never as "no machine signed
    anything". Pinned.
  - Three rendered assertions changed, each because the rendering did:
    `test/attended.test.ts` (`0/2 att auto:2 stale:1` → `machine:2`) and two in
    `test/revoke.test.ts`. `test/statusline.test.ts` never asserted the segment.

- **`docs/spec.md` §2.10 documented an `env.yml` field that does not exist, and two values
  that were stale (#125).** The example carried `version_re: "([0-9]+\\.[0-9]+\\.[0-9]+)"` on
  both of its tools. There is no such field: `src/core/schemas/env.ts` requires
  `["id", "required", "check", "install"]` and knows `min_version`, and extraction is
  `extractVersion` in `src/core/doctor/version.ts` — "the first dotted numeric run in
  stdout+stderr", one extractor for every tool, exactly as `env.yml`'s own header comment
  has always said. It was designed and then dropped, and the spec kept teaching it. Nothing
  reads `docs/spec.md` at runtime, so the cost was paid by a contributor who copied the
  example; the two stale values were `min_version: "1.1.0"` for Bun (the manifest has said
  `1.3.0` since native `Bun.YAML`) and `required: true` for Bun, which `ab90a71` (#121) had
  just disproved — the published package runs on Node alone.
  - Two more defects the sweep turned up in the same twenty lines, both measured: the
    example's top-level `checked_at:` and its per-tool `result: {found, version, ok, checked_at}`
    are written by nothing. `runDoctor` builds a `DoctorReport` and returns it, and
    `ENV_MANIFEST_PATH` has exactly two readers and no writer. That design is kept and now
    says so in prose ("designed, not built") instead of being shown as a file `doctor`
    produces. `Required in v0: git, bun, claude` became the measured set — `node`, `git`,
    `claude` required; `bun`, `python3`, `graphify`, `gh` optional.
  - **The example is now asserted rather than proofread**, which is the part that stops it
    happening a fourth time on the same line. Three assertions in
    `test/public-surface-consistency.test.ts` (#121's drift guard, extended): it must satisfy
    the same `validateEnv` `loadEnvManifest` runs on the real file; it may use no key the real
    `env.yml` does not use; and it must carry the real manifest's own `required`, `check` and
    `min_version` for every tool it names. `purpose` is deliberately not compared — an
    illustration is allowed to abbreviate it, and to be an excerpt of two tools out of seven.
    RED first, against the unedited spec: the field rule named all five invented keys and the
    value rule named both stale values.
  - The §2.10 Validation paragraph claimed four rules `validateEnv` does not implement. Three
    are now marked as designed and not yet enforced rather than stated as fact; the fourth
    (`check` free of shell metacharacters) is filed separately, because `ToolChecker` runs
    `sh -c <check>` and honouring the rule would be a change of behaviour, not a check to add.

- **A revoked gate no longer records what its withdrawn signature rested on (#123).**
  `revoke` reset an approved gate to `pending` and nulled `by` and `at`, but spread
  `gate.evidence` straight through, so the same mapping said *nobody has signed this gate*
  (`status: pending`, `by: null`) and *here is what the signature rested on*
  (`evidence: {path: …, verdict: sign, sampled: 7, of: 34}`). Both cannot be true, and
  `tldrx replay` — which renders the evidence block off `run.yml`, not off the events — drew
  the counts of a withdrawn signature under a gate whose own closing section said
  `Pending gate: alpha is waiting for tldrx approve`. #122 had already cleared `executed_by`
  and `authority` on a revoke for exactly this reason and deliberately left this one call
  open.
  - **Everything that described the signature now leaves the mapping together**: `by`, `at`,
    `executed_by`, `authority` and `evidence`. A revoked gate is back to the five keys a
    pending gate has always had, byte for byte.
  - **Moved, not destroyed.** `run.yml` is STATE — the resume point, read as a description of
    how things are now. `events.jsonl` is HISTORY — append-only, read as a description of what
    happened. The contradiction was a state contradiction, so the pointer leaves the gate; and
    because an audit framework does not delete history, the withdrawn `evidence` block is
    written onto the `gate.revoked` event, beside the `signed_by`/`signed_at` it already
    carried and the envelope's own actor and timestamp — who took it back, and when. The
    committed note never moves from `<phase>/gate-evidence/<stage>.md`, and `tldrx reject`
    now says so on the way out rather than leaving an operator to guess that a cleared
    pointer was not a deleted file.
  - A `revoked:` trail kept ON the gate was the alternative. It was refused because it grows:
    a gate may be approved, revoked, re-approved and revoked again, so the state file would
    accumulate a list of withdrawn signatures — which is what the append-only log is for —
    and every reader would have to learn a "withdrawn" mode for a block whose only truthful
    reading in `run.yml` is "current".
  - **`gate.revoked` is narrated by `tldrx replay` for the first time.** It was in the event
    set and in no narrative: `bullet()` had no case for it, so it fell to `default: return
    null` and a replay of a run whose approval had been taken back showed the approval and
    nothing after it. Evidence moved somewhere no reader looks is evidence deleted, so that
    line is part of this fix — it names both parties, the stale count, what the signature had
    rested on and that the note is still on disk.
  - `evidence` is written on the event **only when there was one**, so every `gate.revoked`
    for a human or auto gate is shape-identical to the ones written before this. Old records
    are untouched in both directions: an approved gate carrying `evidence` and none of #122's
    blocks validates, loads and emits byte-for-byte, and revoking one clears its evidence by
    the same single rule. Pinned in `test/revoke-evidence.test.ts`.

- **`tldrx status` now reports an AGENT-signed gate as machine-signed (#124).**
  `machineSignedDetails` is the report whose whole job is naming the gates a machine closed,
  so a person can take one back, and its selector was `gate.by === "auto"`. That catches every
  facilitator-closed gate and no agent-closed one: an `agent` gate records the evidence note's
  `by:`, which is the OPERATOR account the agent was running as — a person's name. Measured on
  run `260902-discovery-pipeline-map` (the record in #122) that gate reads `by: alanmartinez`,
  so the report counted it as human-signed and never offered the revoke. That is the inverse of
  what the report is for, on the one closure kind where the recorded name is not the entity
  that did the checking.
  - The selector is now `gate.executed_by.type !== "human"`, with `by === "auto"` kept as the
    **union member** rather than replaced: a gate signed before #122 has no `executed_by`, and
    there the old heuristic is the only signal there is. It asks `!== "human"` rather than
    naming `agent` and `auto`, because listing the machines by name is exactly how the `agent`
    case went missing the first time.
  - **The wording changed with it.** "N gate(s) signed `by: auto`, not by a person" was true of
    the facilitator and false of an agent gate, where the record *does* carry a person's name.
    The line now reads `N gate(s) closed by a machine, not by a person — <phase>/<stage> signed
    by <signature>, …`, rendering each signature through `describeGateSignature` — the one
    renderer `run status`, `replay` and the dashboard already share, so a fourth reading of one
    fact cannot drift from the other three, and a record with no `executed_by` still prints the
    bare `by` it always printed. A second line, present only when an agent gate is among them,
    says that an `agent` gate is signed under the operator account the agent ran as, so the
    name on it is not the entity that did the checking.
  - **The executor's kind, never the policy.** A person approving an `agent`-gated stage with
    no flag is a human acting directly and is still not reported. Pinned, with the legacy
    fallback and the negative cases, in `test/machine-signed-gates.test.ts`.
  - The statusline's counter was the same selector on a second surface, and was left alone
    here because it is a different label. Filed as #127, and fixed below: it is `machine:N`
    now, off this same `closedByMachine`.

- **The merge-wave suite no longer plants its #95 fixture at a machine-global path (#113).**
  `b8d1fcb` gave each invocation a private `$TMPDIR`, so a run's own log root stopped being
  a shared namespace — and the fixture that plants a *foreign* wave's kept log kept writing
  to the constant `mw-999999` in the machine's tmpdir. Every concurrent copy of
  `test/merge-wave.test.ts` planted that one directory and, in its `finally`, deleted it, so
  the first process to finish removed the directory its siblings were still about to assert
  on. Measured 2026-09-02 at `965eb54`, four concurrent runs of that file: **9 failures in
  12** targeted runs and **5 in 8** whole-file runs, every one of them
  `expect(existsSync(foreign)).toBe(true)` receiving false. After the fix, on the same box
  and the same load: **0 in 12** and **0 in 8**.
  - The plant is still `mw-<pid>`, still directly in the shared tmpdir — both load-bearing,
    because a regression to the pre-#95 machine-global scan has to keep finding it — but the
    pid is now derived from the planting process's own, in `test/fixtures/foreignWaveLog.ts`.
    It is a fixture module rather than an inline helper so the guard can be a two-PROCESS
    measurement: a child imports the same function and prints the path it would choose, and
    the test asserts the two differ. A test that asks one process whether its own name is
    unique can only ever say yes.

- **`merge-wave.sh` no longer executes a file anything can rewrite underneath it (#117).**
  Bash reads a script incrementally and seeks back into it for each next command; it does
  not snapshot. `git merge --no-ff` sits about a third of the way through `merge-wave.sh`,
  and everything that makes a wave honest lives after that byte — the four gates, the
  `HEAD moved` assertion, the fast-forward check, the push, and the summary line. Measured
  on `GNU bash 3.2.57(1)-release (arm64-apple-darwin25)`: a ~24 KB script rewritten IN PLACE
  while it slept printed its head, lost its tail, and **exited 0**. Silently stopping early
  and reporting success is exactly the failure this script exists to prevent, aimed at
  itself. Reproduced as a wave: with the typecheck gate truncating `scripts/merge-wave.sh`,
  the run merged, ran ONE of three gates, pushed nothing, printed nothing, and exited 0.
  - **The script now re-execs itself from a private snapshot before it does anything.**
    `exec` keeps the pid, so a caller's timeout, `kill`, `$$`, the lock's owner line and
    `$LOGS` all still name the same process; the copy lives in this run's own `$TMPDIR`
    under an `mw-*` name, so #95's leak assertions double as its cleanup check. The
    re-entry flag is an ARGV sentinel rather than an environment variable on purpose: the
    `bun test` gate runs this repo's own merge-wave suite, which spawns the script again,
    and an exported flag would have let an outer wave switch off the inner ones' protection.
  - **Why the live merges of #113/#114 survived, and why that is not a defence.** `git
    merge` unlinks and recreates a changed file rather than truncating it — measured on git
    2.50.1, a merge that shrank a tracked file moved it from inode `192824934` to
    `192824958` — so the running shell kept reading the ORIGINAL bytes off the now-unlinked
    inode. That is how merge `481540d` printed `typecheck/build/seam clean` while
    `git show 481540d:scripts/merge-wave.sh` already ended in `typecheck/build/docs/seam
    clean`: two versions, both intact, in the same second. The merge path was safe only for
    as long as git keeps replacing rather than truncating — an implementation detail of
    somebody else's program, load-bearing for this script's honesty, and nothing here would
    have noticed it changing.

- **An interrupted merge wave no longer leaves an ungated commit on `main` for the next
  sibling to push under its own gate result (#116).** Measured live 2026-09-02 while merging
  #109/#110 in the shared checkout: the caller's own 10-minute timeout sent `SIGTERM` at
  minute 10 of an ~8-minute gate run. The `TERM` trap handed back the lock and the marker
  and touched nothing else, so `main` sat for ~15 minutes on a merge commit that no gate
  ever finished and no lock, marker or log advertised — `git status` clean, `.git/merge-wave.lock`
  gone, no `merge-wave.sh` running. All three existing defences are silent on it by
  construction: the lock had been released, the tree was clean, and
  `git merge-base --is-ancestor origin/main HEAD` PASSES for the next wave, because
  origin/main genuinely is an ancestor of the orphan. So the sibling merged on top, gated
  the pair, and published both under one summary line naming only itself. Nobody lied; the
  gate record was simply attached to the wrong tree — the mirror image of the #44 race, and
  about the run that is *dead* rather than the one still alive.
  - **The wave now owns its merge commit until the push.** `merge-wave.sh` records `main`'s
    sha before `git merge --no-ff`, and `unwind` puts it back on every path that does not
    publish: the `INT`/`TERM` traps, a red gate, a failed push. Deliberately narrow on three
    counts — it undoes only the sha *this* run created, only while that sha is still `HEAD`
    (so a third party's commit landing on top, the exit-5 case, is left for a human instead
    of being discarded), and only before `PUSHED=1`. It also runs *before* the lock is
    released, while this invocation still matches the lock token, so the #89 ref guard waves
    it through rather than vetoing the repair.
  - **A red gate rewinds too.** It used to report "main left at merge commit `<sha>`", which
    is the same landmine by another route: the branch still holds every byte of the work and
    the merge is one command away, while the kept log directory is the real inspection
    surface. The summary line now names the sha it rewound off `main`.
  - **And a wave refuses to start on a `main` that is ahead of origin/main — exit 8, naming
    the commits.** `SIGKILL` and a power cut run no trap at all, so the unwind alone cannot
    close the hole. `HEAD`, not `refs/heads/main`, because `HEAD` is what gets merged into
    and what `HEAD:main` pushes; behind or diverged is still the fast-forward check's job at
    the push. Six tests in `test/merge-wave.test.ts` pin it, including the end-to-end repro:
    a wave killed mid-gate, then a sibling wave whose `origin/main` must not contain the
    dead run's commit.

- **A docs-scope story bundle is no longer handed to a developer with nothing to write, no
  requirements it can open, and its core acceptance criterion deleted (#111).**
  All three were repaired BY HAND by the unattended driver of `260902-discovery-pipeline-map`
  on 2026-09-02, and all three reproduce from one fixture: a real `run new --scope docs
  --seed <root document>` where the seed is the run's source of truth, lives at the workspace
  root, and the story's repo is a sibling directory.
  - **`touches` was empty.** It was built from what `01-what/handoff.md` CITES with a repo
    prefix, and that could only ever find files already on disk — so a run whose whole output
    is a document nobody has written yet got `touches: []`, while the developer prompt tells
    the sub-agent that a change outside `touches` is a plan deviation. The story was forbidden
    to do the one thing it existed for. `touches` now also carries the documents the run's own
    brief NAMES — `## Decisions` and `01-what/success-metrics.md` — including a path with no
    file behind it yet, which `prompts.ts` has always rendered as "(does not exist yet — this
    story creates it)". Two ways in and no third: the repo has the file, or the path has a
    directory and the repo has that directory; a bare dotted word in prose (`Node.js`) is
    refused. Every addition is written into `notes:`, and a `touches` that is still empty now
    says so in `notes:` instead of leaving it to a comment on an empty list.
  - **The seed documents were unreachable from the story worktree.** They live at the
    workspace root, are never copied, and need not be inside the story's repo — so the
    handoff's `[src: seeds/….md:5]` resolved to nothing from the worktree and the driver
    rewrote every read to an absolute path. The bundle now CARRIES them: `inputs:` lists the
    run's `--seed` documents (read from `run.yml`'s first stage, where `run new` declares
    them) and the developer prompt inlines their content, resolved through the same
    `resolveDeclared` two-base rule the What stage's own inputs use. Bounded at 64 KB per
    bundle — the same budget the story's touched files spend — and anything that does not fit
    is named in `notes:` rather than dropped in silence.
  - **The acceptance filter deleted the story's core criterion for naming a question id.**
    "All four seed questions (Q1–Q4) have a dedicated section in
    `docs/discovery-pipeline-map.md`" was dropped on the `a question id` signal, leaving the
    story with the "(no `## Decisions` bullet …)" placeholder as its whole Done-when list.
    Naming a question is how a document ABOUT the questions is specified. A bullet that names
    a PRODUCT document now survives every signal — which is what the code comment above that
    list has claimed since it was written, and was not true. Two narrower repairs came with
    it: `questions.md` is matched at a path boundary, so `seeds/pipeline-questions.md` — a
    document the TEAM wrote — is no longer read as the What stage's own output (it had
    emptied `goal:` on the same run); and every signal is now tested against the bullet's
    PROSE, not its `[src: …]` token, because a citation says where a claim was checked and not
    what it is about. New `withoutSrcToken` lives in `text/srcToken.ts`, the one file that may
    hold the grammar (#80).

- **A closed run no longer sets up the operator's next `git pull` to be refused (#102).**
  Measured on aparece-v2, run `260830-ordering-inventory`, 2026-09-02: the run closed at
  `14:14:00Z`; ninety-two seconds later a commit on `epic/ordering-inventory` carried a
  snapshot of the whole live `tldrx-work/<run>/` tree plus `.tldrx/memory/facts.yml`; PR #10
  merged it; the operator's `git pull` was refused over 5 modified and ~40 untracked paths,
  and the recovery was a rebase.
  - **The cause was a gap, not a bad line of code.** tldrx has never had a code path that
    commits `tldrx-work/` to an epic — story commits have excluded the state dirs since
    `stateDirPrefixes` landed, and the offending commit was authored by the operator's agent
    after the close. What the framework did have was a hole: in a `root_is_repo` workspace it
    writes `run.yml`, `events.jsonl`, `budget.yml` and every phase document straight into the
    operator's WORKING TREE and left them uncommitted for the length of the run, said nothing
    about them at close, and offered no verb for "the run is over, commit its docs". So an
    agent invented one, and half the time invented it onto the epic.
  - **The close now commits that state itself.** `closeRun` — one home for the policy, the
    same three callers `closeRunWorktrees` had (`tldrx next`, `tldrx approve`, `tldrx run
    cancel`) — commits `tldrx-work/<run>/` and `.tldrx/memory/` in the workspace checkout, on
    the branch that checkout is on, and prints one line saying where they went. New
    `commitPathsOnly` is the inverse of `commitAll`: `git commit -- <pathspec>`, so a
    `README.md` the operator had STAGED is still staged and still uncommitted afterwards.
    Two paths refuse rather than guess — a checkout sitting on the run's own epic branch
    (`on-epic`) and a detached HEAD — and both report instead of failing the close. It never
    pushes; spec §5 is unchanged.
  - **`tldrx ship` refuses an epic that carries the framework's own state**, names the paths,
    and prints the two-command repair (`git checkout <base> -- tldrx-work .tldrx` then a
    commit — a forward commit, never a rebase). This is the last point tldrx holds the wheel
    before a PR, and the diff is three-dot so a trunk that gained run state after the epic was
    cut does not read as the epic carrying it. A `git diff` that fails answers "nothing here":
    a probe that could not tell must never turn into a refusal.
  - **Every `*.bak` tldrx writes is gitignored, at any depth.** `tldrx-work/*/*.bak` reached
    one level and missed `tldrx-work/<run>/04-build/preflight.yml.bak`, which
    `git check-ignore` matched against the block's own `!tldrx-work/**` re-include — measured,
    and it was swept into the aparece-v2 rescue commit. Now `tldrx-work/**/*.bak` and
    `.tldrx/**/*.bak`. Existing workspaces pick the block up on the next `tldrx init` (it is a
    marked block, so re-running it is idempotent); until then the close excludes `*.bak` from
    its own pathspec, so the one write path that could have committed them does not.
- **A 1M-context model is no longer sized at 200k because of how its name was spelled
  (#112).** Measured at `d1d9c3f`: `priceFor("claude-sonnet-4-5-20250929[1m]")` returned the
  `sonnet` row and `contextTokensFor` therefore answered **200,000, not 1,000,000**. The
  cause was that `[1m]` was carried inside a row's id, so `name.includes("sonnet[1m]")`
  could only ever match the bare alias — and the suite could not see it, because the one pin
  that existed (`priceFor("opus[1m]")`) used exactly that convenient spelling while the
  repo's own fixtures use the dated form (`claude-fable-5[1m]`). It fed `run estimate` and
  the context ledger, which decides when a stage is near its window.
  - **`[1m]` is now matched as a MARKER on a name, separately from the family**, so
    `sonnet[1m]` and `claude-sonnet-4-5-20250929[1m]` land on the same row. A `[1m]` row is
    offered only to a name that carries the marker, so a dated spelling WITHOUT it is not
    promoted: `claude-opus-4-5-20251101` still resolves to `opus`/200k.
  - **A family the table prices answers for its own windows.** haiku has no `[1m]` row
    because there is no 1M haiku, and its 200k is the one MEASURED number in the file — a
    marker does not overrule it, so `claude-haiku-4-5-20251001[1m]` stays 200k.
  - **A family the table does NOT price gets the window its name declares.**
    `contextTokensFor("claude-fable-5[1m]")` is 1,000,000 rather than a silent 200k default.
    No fable price row was invented: `priceFor` still returns null for it, so nothing quotes
    a price for a model this table cannot price — only the sizing changed.
  - No USD figure moved. The `[1m]` rows already priced identically to their 200k siblings;
    this was never a billing bug, and `tldrx cost` reads `total_cost_usd` off the CLI.
- **A stage with nothing to ask can close its own auto gate again (#109).** `questionsCondition`
  read zero parsed question blocks as one thing when it is really three. *Unreadable* — the
  2026-08-29 failure, where a stage wrote `### Q1 — …` from the old template and four questions
  were swallowed — is still refused, by id. *Missing* — a `questions.md` the stage declared as an
  output and never wrote — is still refused, and now says so in its own words
  (`questions.md is a declared output of this stage and was never written — an absent file is not
  an answer`) instead of sending the reader to a template for a file that does not exist.
  *Present, readable, and raising nothing* — the GOOD case — now SATISFIES the condition. Measured
  live 2026-09-02 on run `260902-discovery-pipeline-map`: every clean stage was paying for the
  2026-08-29 bug, because the state an auto gate exists to close over was indistinguishable from
  the state it exists to refuse.
- **`absent:` has ONE semantic, and both checkers share it (#110, absorbing #105).** Two live
  failures in the same week, in opposite directions, out of the same resolution: `claim-sources`
  PASSED `- none [src: absent:04-build/log]` over a directory holding seven files, while the auto
  gate REFUSED `absent:.tldrx/memory/facts.yml` — "I searched, there is no recorded fact", which is
  the spec's own spelling of an empty section. Both were `unverified`, which one checker read as
  "fine" and the other as "stop".
  - **`absent:<path>` now resolves against the same bases a `file` src does** (workspace root, run
    directory, named repo, epic worktrees), and accepts `repo:path`. That is the mechanism behind
    #105: it used to try the workspace root and nothing else, so a run-relative
    `absent:04-build/log` never even saw the directory it named and reported an absence it had
    never looked for.
  - **A fourth outcome, `noted`.** No such path, an empty file, an empty directory ⇒ `ok`, the
    absence is literal. The path exists with content and no needle ⇒ `noted`: legal, never fatal,
    never blocking — and never silent. It is counted and named BY PATH in the `claim-sources`
    detail (`unchecked absence: 2 (04-build/log, .tldrx/memory/facts.yml)`) and therefore in the
    auto-gate note, so the two can no longer disagree about the same file.
  - **`absent:<path>#<needle>` makes an absence checkable.** Say what you searched for and the
    checker searches for it: not found is a *verified* `ok`, found is a REFUSAL that names the line
    (`` `30 days` IS at docs/retention.md:3 — that is a presence, not an absence ``). It is the
    upgrade path out of `noted`, and the first form in which an absence over a file with content is
    ever actually checked.

- **The docs site advertised a version we had already shipped past (#121).** The hero said
  0.4.0 in four places — `index.md`, `guides/faq.md` and both Spanish mirrors — while npm
  served 0.5.0. Hand-bumping it would have bought one release; the number is now read at
  build time instead, by `docs-site/version.ts`, from `package.json` (the field npm
  publishes) and the README release table (the row `release-check.sh` already refuses to
  release without). `config.mts` hands both to the pages through `themeConfig`, on the root
  and on each locale, and the pages interpolate. `version.ts` throws rather than guesses: a
  docs build that cannot tell which version it is describing fails, instead of quietly
  publishing `undefined`. The "0.4.0 was the first beta" sentences stay — that is history,
  and it is still true — but they now read as history.

- **Three surfaces disagreed about whether Bun is needed to run tldrx (#121).** `env.yml`
  declared `bun` `required: true`, and `DoctorReport.healthy` is "no required tool is
  missing", so `tldrx doctor` exited 1 on machines where tldrx was installed and working.
  The docs site's quickstart said you need "Node 20 **and** Bun 1.3"; the README and
  `docs/guide/01-quick-start.md` said an installed tldrx needs only Node. The README was
  right, and the code says so: `node dist/tldrx.js --version` prints the version and exits 0
  with no Bun involved, because `src/core/runtime/index.ts` picks its implementation off
  `typeof Bun` at import time and `nodeRuntime.ts` is complete — `bun build --target=node`
  inlines the `yaml` package, so a published install resolves zero runtime dependencies.
  - `bun` is now `required: false` in `env.yml`, still declared and still carrying its 1.3.0
    floor, with the measurement recorded beside the flag. It remains genuinely required to
    build the bundle, to run the test suite, and to run the hooks straight from a clone
    (`plugin/hooks/hooks.json` spawns `bun`); an `install --claude` wiring goes through
    `tldrx hook <name>`, which is the Node bundle.
  - Every surface now separates *running the published package* from *building and
    contributing*, in the same words: both quickstarts, the README, `01-quick-start.md` and
    `09-troubleshooting.md`.

- **The landing page claimed an absolute the implementation cannot guarantee (#121).** It
  told readers that because the files are the state, nothing could get out of step with
  anything — in the same week that #116 and #117 shipped precisely because state can. It now
  says what is defensible and still worth saying: the canonical state is on disk,
  inspectable, diffable, committable, recoverable. Mirrored in Spanish.

- **Provider wording tightened to what we can show (#121).** "Tool-agnostic" was an
  unqualified claim about software with one working runner. The README and `docs/concept.md`
  now say the workflow and the persisted state format are provider-independent, and that the
  automated runner currently supports Claude Code. The docs site made no stronger claim; it
  was swept and needed no change.

## 0.5.0 — 2026-09-02

### Added

- **The dashboard answers the five questions #85 left open (#93).** Each needed a decision
  rather than a patch, and each was taken the CONSERVATIVE way: render what the files
  already say, invent no interaction the page does not already have, and let nothing on a
  read-only page run anything. Every choice below is a **maintainer call, subject to owner
  review** — they are listed on the issue.
  - **The Watchers tab draws the cards.** `05-watch/watchers/*.md` is read into the model as
    the seven fields `Watcher` really declares — `id`, `epic`, `title`, `stories`, `repos`,
    `status`, plus the optional `owner` (#70) — and the tab prints them instead of printing
    the shape it wished it had. A `draft` card also carries **why**: the `absent:` sources it
    cites under `## Signal`, which is the card's own rule for not being `verified`. The
    reading is deliberately the SMALL one — the model resolves no `[src: …]`, calls no
    `parseWatcherCard` and computes no `CardChecklist`, because that re-checks every citation
    against today's working tree and would make a read-only dashboard the only screen in the
    product that runs something. `tldrx watch check` stays the thing that checks, and the
    page says so. A `verified` stamp over an `absent:` Signal is shown as what it is rather
    than silently corrected: `watch check` re-stamps cards, and a viewer that disagreed with
    the file would be a third opinion.
  - **A `draft` card raises no attention card.** The page's rule — an alert means a run is
    waiting on a PERSON right now, derived once in `waiting.ts` — is unchanged. An
    uninstrumented signal is a fact about coverage that stays true until somebody
    instruments it, and it belongs in a panel the way `budget.blocked` does.
  - **Preflight refusals leave their rows on the page.** `04-build/preflight.yml` is read the
    same way `budget.yml` is: read-only, additive, and through the reader that never throws.
    A new **Base gates** section names each of the workspace's own gate commands, the repo
    and base it ran on, its exit code and its `ok`/`failed`/`unmeasured` status — so a Build
    that refused to start is no longer a stage that went backwards for no visible reason.
    The alternative on the issue was to emit an EVENT instead; that is the bigger, better
    change and it is not this one, because the owner's #85 decision covered the two files
    that already existed and an event is a new write on a refusal path. Reading the file it
    already writes is the same doctrine one step further. Red rows are drawn as rows, not as
    alerts, for the same reason `budget.blocked` is.
  - **`keep_worktrees` is one line on the run detail**, and only when it is set (#16). The
    key is written only when true, so drawing `false` would put a row on every run in the
    workspace saying what all of them do. `RunDocument` projects it tolerantly: anything that
    is not the boolean `true` is not a promise to keep the worktrees.
  - **A cancelled run says who closed it, when, and why.** All three facts already travelled
    on `waiting.message` (#86); the run detail printed the status chip and dropped them. It
    is one `kv` row carrying that sentence — not a second derivation, so the page cannot word
    it differently from `tldrx run status`.
  - **An annotated run wears a marker in the runs list** — one ✎ glyph with the note count in
    its `title`, nothing more. #85 §1 asked for it and the wave declined to invent it. This
    is the smallest thing that is true: no column, no badge count, no new sort key, and the
    notes themselves stay on the run detail where they were. Explicitly **provisional** — a
    count in a row is a design decision, and the first person with a real opinion about that
    list should replace it.
  - **`DASHBOARD_MODEL_VERSION` stays at 3.** `watch`, `preflight` and `keepWorktrees` are
    three additions and nothing was removed; no existing field reads differently than it did
    at v3. The argument for bumping is that `docs/dashboard-model.md` promised, under *What
    is NOT in it*, that two named files were unread, and that promise is now void — but a
    documented absence is not a field, and the number is for fields.

- **The dashboard reads `budget.yml` and `events.jsonl` (#85).** The audit that filed the issue
  found five gaps with one root: `buildModel()` read `run.yml`, the phase artefacts, the Plan
  artefacts and the expert files, and nothing else — so five facts a reader went looking for were
  nowhere on the page, each because it lives only in one of those two files. The owner's decision
  (2026-09-02) was that the model may read both, read-only and additive. All five are now drawn.
  - **Operator notes** (`tldrx note`, #46) get their own section on the run detail, with the actor,
    the stage or phase, and the time. **All of them**, not the last three: `tldrx run status` caps
    at three because a terminal has a bottom, and a run detail page does not.
  - **Free review retries** (#78/#79) and the **attempt** each story is on. Both are event-only —
    the story file carries `status` and `evidence` and no counters — so a story that burned both
    attempts and was granted two free re-prompts read on disk exactly like one nobody had touched.
    The plan table gains an `attempts` column (`1 of 2`, against the model's new `maxAttempts`), and
    a **Reopens & retries** section shows the `story.reopened` arcs with their `fix`/`attempts`
    reason and the operator's note. A reopen written before the `reason` key existed reads as
    `attempts`, which is the only kind that existed, rather than as a blank.
  - **`budget.blocked`** occurrences are listed with the phase, both economies' numbers, and — for a
    dollar refusal — the exact `tldrx budget raise` command, short-by rounding included, pinned by a
    test against `raiseCommand` because the renderer is serialised into the page and cannot import
    it. Deliberately **not** an attention card: the page's rule is that an alert means a run is
    waiting on a person NOW, and a refusal in the log is not evidence of that.
  - **The `$0.00 of $25.00` progress bar on a host run is fixed properly.** A run whose `budget.yml`
    says `economy: host-tokens` is not priced in dollars at all, so `ceiling_usd` governs nothing
    and the bar stated a fraction of a denominator that does not apply. Such a run now reads in
    TOKENS on both screens — the runs list and the run detail share one `dashSpendText`, because
    suppressing the bar alone would leave the words `$0.00 of $25.00` making the claim the bar
    was — metered against `ceiling_host_tokens`, the ceiling those tokens really are judged
    against, which exists in no other file. A **Budget** panel carries the per-phase ceilings, `on_exceed`,
    `warn_at_pct`, `on_host_tokens_exceed` and the per-phase economy. An unset phase economy is
    reported as *inherits*, never as a choice somebody made.
  - **`DASHBOARD_MODEL_VERSION` stays at 3**, and the issue asked. Eight fields were added and none
    removed. `spentUsd` was the one with a case to answer — a consumer reading it alone is
    demonstrably wrong about a host-attended run now that the ceiling can sit beside it — but it is
    computed from the same `run.yml` key, holds the same number, and has meant "METERED dollars, a
    lower bound when `unmeteredTasks > 0`" since v3 put `unmeteredTasks` and `hostTokens` next to it.
    A field that gained neighbours did not change meaning.
  - **Neither file is opened by the model**, and the ledger is walked **once per run**. `loadRunResult`
    already parsed both for every run and this file had been discarding them, so the page costs the
    reads it always did; the per-story facts come out of one pass rather than from
    `readReviewLedger`, which re-reads the whole ledger per story and would have made a forty-story
    plan forty passes over a file already in memory.
  - **Absence and damage stay graceful.** No `budget.yml` and no `events.jsonl` renders exactly as
    before, with none of the new sections. An unparseable `budget.yml` costs the panel and nothing
    else. A torn ledger line costs that line and **says so** on the page, because "no operator notes"
    over a damaged ledger is the same lie by omission an unlisted corrupt `run.yml` was.
  - Fixed on the way: an event with **no `payload` key at all** parses fine through the tolerant
    `EventLog.readAll`, and reading `payload.story` off it threw a `TypeError` out of `buildModel`
    and killed the live server for the whole workspace. `TldrxEvent.payload` is typed non-optional;
    the type is a claim about `validateEvent`'s output, not about what is in the file.

- **The `tldrx drive` mandate carries its own preflight (#84).** Launching a cold unattended
  session took SIX hand-run commands before the mandate could be pasted at all — `tldrx run
  attend host`, then `tldrx run gates set` five times. Every one of them is a precondition of
  the discipline the mandate exists to transfer, so an owner typing them by hand was doing the
  driver's job for it, and a mandate that assumes its own preconditions only works where
  somebody has already been careful. Both modes now open with a **`## Before anything: the
  preflight`** section, ahead of the roles, that establishes attendedness (`tldrx run status
  <run>`), the gate policy (`--json`, stage by stage) and `budget.yml` — and makes the driver
  **state the ceiling it will honour** before the first turn. Any one it cannot establish is a
  **refusal to start** that names the command that failed, because a driver that starts anyway
  has spent money on a run whose gates it may not close.
  - The two modes differ here exactly as they differ at the gate. `--unattended` may SET what
    it finds wrong: `tldrx run attend host <run>`, and `tldrx run gates set <stage>:agent
    --note "…"` for a stage the owner delegated, over a note **quoting the owner's own
    delegation from the launch message** — so the policy change is signed by the owner's words
    rather than the driver's judgement. `--attended` gets the mirror and may not: gates stay
    human there, so it checks attendedness and the budget, reports a stage that is not `human`
    where it was expected, and moves nothing. A test asserts the attended text contains no
    `gates set <stage>:agent` at all.
  - The `<run>` substitution (#75) covers the new lines like every other, `<stage>` untouched:
    the pinned occurrence count moves from 5/7 to **7 attended / 10 unattended**.
  - Both mandates stay inside `MANDATE_MAX_LINES` (119 unattended, 116 attended), paid for out
    of the header, the driving block and the unattended gate. The sections that make the
    document worth pasting — the three-role spine, evidence discipline, parking, review
    calibration by stakes and budget honesty — are untouched.

- **The retro aggregate has consumers: `--json`, the reviewer prompt, and a workspace taxonomy
  (#74).** `tldrx retro --all` (#64) produced exactly the dataset that issue asked for — finding
  class × count × runs × one cited example — and nothing read it. The reader existed; the loop it
  was meant to close was open at the far end. Three seams close it.
  - **`tldrx retro --all --json`** — a stable machine shape: `{version, root, runs, contributed,
    deduped, classes, trends[{cls, count, runs, example{run, kind, text, src}}], findings[]}`. A
    deliberate projection rather than a dump of the internal type, with its key sets asserted
    literally by a test, so adding a field is a visible act and renaming one bumps `version`.
    `--json` belongs to `--all` alone: closing one run WRITES a file and has nothing to parse, so
    `retro --json` on its own is a refusal rather than a stringified sentence.
  - **The adversarial reviewer is fed the workspace's top three classes** before it reads the
    diff, so a review starts from what this team keeps getting wrong instead of rediscovering
    `test-cannot-fail` on its own, run after run. Computed by the same `mineAll` over the same
    workspace, so what the reviewer is told is exactly the top of what `tldrx retro --all` prints.
    Additive and absent-safe in every direction — no runs, no findings, nothing but `other`, or a
    broken taxonomy file, and there is no section at all, not a heading and not a blank line.
    `other` is never offered: it names no defect to look for. Mined once per `tldrx next`
    invocation, so a wave of six stories pays for it once and every reviewer in that invocation
    gets the same prior. The section says out loud that it is a PRIOR and not a checklist — a
    reviewer handed three defect classes and no framing finds three defect classes.
  - **`.tldrx/memory/finding-classes.yml`** adds classes for defects the seven built-in ones do
    not name (`version: 1`, `classes:` of `{name, rules}`, 1–16 each, rules compiled
    case-insensitively). Extensions are tried AFTER every built-in rule and before `other`, so a
    workspace class can only ever claim a finding the built-ins left unclassified — which is what
    keeps an unbounded taxonomy testable, and leaves every shipped fixture immune to whatever a
    workspace writes. A file that will not load is a REFUSAL naming the file, the class and the
    rule — including a rule such as `.*` that matches every text and would swallow the taxonomy —
    never a silent fallback, because a rule its author believes is running and is not would make
    every count a lie. The Build reviewer never fails on it: a refusal costs the prior and prints
    one line, so no story loses an attempt to a YAML typo.

- **`CONTRIBUTING.md`, and a section an outside contributor can build a model provider from
  (#27 companion).** #27 (a generic model-provider layer) was closed as parked, not rejected:
  `TLDRX_CLAUDE_BIN` covers today's needs and a provider layer with no second provider is
  speculation. So the seam is written down instead. The new file covers the contribution loop,
  the four gates and what CI actually runs, the red-first rules (including "a test that cannot
  fail is worse than no test", with the shipped example of one that could), and a
  **Contributing a model-provider config** section: what `TLDRX_CLAUDE_BIN` does and does not
  buy, `buildClaudeArgs`' exact command surface, the `stream-json` transcript contract
  `AgentStream` parses and the two behaviours an adapter most easily breaks (the read cap and
  the cost ledger), the result-envelope requirement with its fail-closed rule, and the five
  test files a PR would have to touch. Linked from the README.

- **`tldrx questions cards [<run>]` — a parked question, as something to decide (#59).** Measured
  on run `260830-ordering-inventory`, 2026-09-01: the host parked four product questions with
  notes and reported them in its tl;dr. The owner's live words were *"cuales preguntas? no las
  veo? por que no me guió por las preguntas Claude?"* — they were on disk, they were in
  `tldrx questions <run>`, and the count was in the summary. None of that PRESENTED them. Counted
  is not asked, and the gap was never the data; it was the arc from parked to answerable.
  - **Three slots, each a refusal.** Two lines of context (which run and file the question is
    parked in, who asked it, when, in what area) so a card pasted into chat stands up away from
    the terminal. The question's OWN `Why asked:` note verbatim, `[src: …]` included — the slot
    for what the binding docs already decide, quoted rather than summarised; a note that cites
    nothing is FLAGGED as somebody's recollection, and a question parked with no note says so.
    The file's lettered options verbatim, or a loud `NEEDS OPTIONS` marker when it carries none,
    because manufacturing A/B/C would be answering the question in the act of asking it.
  - **A reader, and only a reader** (owner decision 2026-09-01: no interactive loop in v1). It
    opens no run, spawns nothing, records no fact, and a test asserts `questions.md` is
    byte-identical across a render. Answers still flow through `tldrx answer`, and every card
    prints the exact line to type. It does not extend the §2.7 grammar: every field on a card is
    one the existing parser already produces.
  - **No open question is a sentence and an exit 0** — and two silences are told apart, because
    "this run never parked anything" and "everything here is answered" send a reader to different
    places.

- **`tldrx watch arm --run <id>` — the merge detector that fires the post-merge checklist (#69).**
  `watch check` (#65) answers *"what do I check now?"*. Nothing answered *"the PR just merged, go
  and check it"* — the half that happens without a human remembering, which matters because the
  failure #65 was filed about IS a memory failure: the owner's own CD gap, a merged branch read as
  a deployed one, cost 19 destroyed records. v1 would not have caught it either, because nobody
  ran it.
  - **A bounded FOREGROUND poller, not a daemon** (owner decision 2026-09-01: no GitHub Actions in
    v1). It reads the branch Build cut from `run.yml` — through the same `pickBranch`/`findRepos`
    `tldrx ship` uses, now exported, so the two verbs cannot disagree about which branch a run
    shipped — asks `gh pr view <branch> --json state,mergedAt` per repo, and prints the same
    checklist the moment every PR for that branch has merged. **Three independent bounds**: a hard
    deadline (`--timeout`, default 3600s, max 86400), a floor on the interval (`--interval`,
    default 60s, under 10 REFUSED rather than quietly raised), and a poll cap that holds even if
    the clock does not move.
  - **Every refusal is a sentence, and they are different sentences.** No epic branch ⇒ `ship`
    cannot have run. No PR for the branch ⇒ either `ship` has not run or the branch was never
    pushed, with both commands printed. A PR `CLOSED` without merging ⇒ stop now, because waiting
    for it could only ever time out. A window that expires ⇒ exit `4` and the command that
    re-arms it.
  - **It never pushes, opens or merges anything**, and `--execute` is deliberately not offered: an
    hour-old poller must not start running the workspace's build commands the instant a merge
    lands. Re-running a recorded command stays an explicit, typed decision.
  - **No test in this suite runs the real `gh` or touches a network.** The unit cases drive a
    recording fake transport; the one end-to-end case puts a stub `gh` first on `PATH`. The clock
    and the sleep are injected, so a test covering a one-hour timeout finishes in milliseconds.

- **`tldrx plan schema` — the story/epic/waves contract, printed for a human (#71).** #48 deleted
  `templates/story.md` and `templates/epic.md`, rightly: nothing read them, so nothing kept them
  honest. But they were answering a real question — what shape does a story file take? — and after
  #48 the only reader of the generated contract was `checkContracts.ts`, which splices it into the
  Plan stage's prompt. The shape existed for the agent and not for the person writing a story by
  hand, reviewing one an agent wrote, or debugging a `plan` check refusal.
  - **The same bytes the agent gets.** `plan schema` renders `renderPlanSchemaContract()` verbatim,
    generated from the validators the check runs, so it cannot become the second source of truth
    the templates were. `--story`, `--epic` and `--waves` print one example on its own; at most one
    of them, because two would make the answer ambiguous. A test copies the printed story example
    straight into `validateStoryFile` and asserts it comes back clean.
  - **The one verb in `plan` that resolves nothing.** No workspace, no run, no disk, no spend — the
    question comes before any of that exists, and is often asked from outside a workspace entirely.


- **`tldrx drive [--attended|--unattended]` — the host/driver mandate, shipped (#63).** Every elite
  run of 2026-08-31/09-01 was driven by a session carrying a hand-written playbook, and that playbook
  was the framework's real quality floor. It lived in the owner's chat pastes, so a third party
  inherited the CLI and rediscovered the discipline — or did not. It is now plain text the package
  prints, versioned with the package, for a human to paste into the driving session or read before
  they start.
  - **What it carries**: the three-role protocol (developer sub-agent → a FRESH adversarial reviewer,
    never the author → the host verifying BOTH in the code, not in their reports); evidence
    discipline (measured / inferred / assumed labelled in the same sentence as the claim, exit codes
    never read through a pipe, verification from the source, remote shas via `git ls-remote`);
    parking product questions with what the docs already decide, because an open question is never a
    licence to ship an unguarded write; review calibration by stakes, so a security-bearing story
    gets the strongest reviewer; and budget honesty — declare a turn once, state a floor when the
    records are incomplete.
  - **Two modes, one spine.** The disciplines are identical — they are about how a claim is made,
    not about who is watching. What differs is the GATE (`--unattended` signs over a validated
    evidence note with `tldrx approve --as-agent`; `--attended` never signs and hands the decision
    over) and DRIVING (who spawns). Each mode is bounded at 120 lines, asserted by a test: a mandate
    long enough to skim is one nobody follows.
  - **A mode is required and never guessed** (exit `1`), the same refusal `tldrx run attend` makes.
    Handing an attended session the unattended text tells it to sign gates that were never its to
    sign. It needs no workspace, opens no run, spawns nothing and writes nothing.

- **`tldrx retro --all` — cross-run mining of what keeps catching you (#64).** Each run left gold
  nobody aggregated: a reviewer's verdict and findings in `04-build/log/<story>.md`, a fix list with
  a disposition per finding, `retro.md`'s `## Build feedback`, and the reason a person typed when
  they reopened a story. Across the first six real runs the same finding CLASSES kept coming back,
  and nothing read more than one run at a time.
  - **A trends table**: finding class × count × how many runs it appeared in × one example with the
    `[src: …]` that lets a reader go and check it.
  - **Seven classes, in a documented precedence**: `test-cannot-fail`, `missing-negative-control`,
    `unreachable-structure`, `stale-comment`, `authorization-not-widened`, `schema-drift`, `other`.
    Classification is ordered keyword rules over the finding text — no model, no scoring, no
    threshold — so the same tree always produces the same table and a rule that misfires can be
    pointed at. The rules are tested against fixtures in the shape the real artefacts carry.
  - **Zero new state.** It writes nothing anywhere: no `retro.md`, no `practices.md`, no cache.
    A test asserts the workspace is byte-identical across the call.
  - **Absence is never an error.** A run with no Build phase, no retro, no events log or an
    unreadable one contributes what it has and is still counted; an empty workspace is an empty
    answer at exit `0`. A repeat of one finding WITHIN a run is collapsed (`retro.md` quotes the fix
    list verbatim); the same finding in two runs is two occurrences, which is the point. A `refuted`
    fix-list finding is read and dropped — ranking a class by disproven findings would make the
    table a report on the reviewer.
  - `--all` is refused (exit `1`) alongside a `<run-id>` or `--apply`, before a file is opened: each
    asks for the opposite of what `--all` does.
- **`tldrx watch check` is the post-merge checklist (#65, owner decision 2026-09-01: manual command
  first, `gh` detector later).** `tldrx ship` opens the PR carrying the handoff and the watcher card
  lists the signals that would prove the feature works — and nothing joined the two, so
  "merged ≠ deployed ≠ verified" stayed a thing a person had to remember. Remembered wrongly once, it
  destroyed 19 records. `watch check` now reads the run's cards under `05-watch/watchers/` and prints
  each card's `## Signal` items as a numbered checklist with `## Where`, the baseline, what broken
  looks like, and the Query block, so there is one screen to work through after a merge.
  - **A feature id is now OPTIONAL.** `tldrx watch check` checks every card in the run — the shape a
    CI job wants; `tldrx watch check <feature>` scopes it to one and still prints the citation
    verdict `check` always printed. The citation re-check is unchanged and still exits 1 on a dead
    `[src: …]`.
  - **Owners are DERIVED, never invented.** The watcher schema has no `owner:` key and adding one
    would have been a key nothing writes (the #48 defect again). The owner of a signal here is the
    repo its own citation names — `[src: api:src/Leaderboard.cs:64]` says `api` — and an item that
    cites no repo says so rather than borrowing the card's.
  - **Runnable means the card AND the workspace say so.** Only a `$ <cmd> → exit <n>` source whose
    command `.tldrx/workspace.yml` declares, in a repo the item or the card names unambiguously, is
    offered. `--execute` (off by default) re-runs exactly those, through `runDeclaredCommand` — the
    same allowlist, argv-never-a-shell and timeout the stage `cmd` check uses, extracted rather than
    copied — and reports the exit each gets NOW against the exit the card recorded. That is the one
    thing in the framework that catches a card whose `$ … → exit 0` has quietly become an exit 1:
    `resolveSrc` checks a `cmd` source's MEMBERSHIP and takes the exit code on the agent's word.
  - **A `## Query` block is never runnable.** It is KQL or SQL for the console named under
    `## Where`, which tldrx has neither credentials nor a client for, so it is reproduced with its
    fence language and marked print-only.
  - **Three refusals, told apart because they need different actions.** No `05-watch/` at all ("its
    Watch stage never ran"), a Watch stage that wrote no card ("no story reached `done`"), and a
    `draft` card — which is not a failure but an answer: the card's own `absent:` sources are quoted
    back as what to instrument. The two empty cases exit 3, never 0; a green meaning "I read no
    cards" is the failure this command exists to stop.

- **Evals v1 — five golden-transcript evals, one per stage (#26, owner decision 2026-09-01: small
  v1 now).** The suite proved the harness; nothing proved a STAGE. `test/evals/` now runs each of
  What, How, Plan, Build and Watch through the real facilitator against the scripted stand-in agent
  and asserts that stage's output CONTRACT. About 5 seconds on top of `bun test`.
  - **One stage at a time, not a chain.** Stages are sequential — Plan cannot run until How's gate
    is signed — so playing four stages to reach the fifth would make every eval depend on the ones
    before it, and a regression in What would turn all five red without any of them saying why.
    Each eval instead opens its own run on a workflow preset holding exactly one stage, which needs
    no new code: `workflowPath` already prefers `.tldrx/workflows/<scope>.yml` over the shipped
    presets, and `normalisePhase` already takes the phase folder from the stage's own `phase:`
    rather than from its position. Whatever the stage genuinely reads — a plan for Build, a done
    story for Watch — is seeded onto the disk by the scenario.
  - **Built on `learn`'s machinery, not beside it.** The stand-in `claude`
    (`src/core/learn/agentScript.ts`, `learnAgent.ts`) and the toy-repo sandbox are reused as they
    are; the real CLI is unreachable by the same two doors `learn` closes. No production code
    changed for this.
  - **Contract, not snapshot.** Nothing compares bytes. The evals assert what the FRAMEWORK
    computes: the declared outputs read back off `gate.requested`, the `checks:` outcomes and their
    computed detail (`checkPlan`'s branch-model line), the artifacts re-parsed with the framework's
    OWN validators (`validateQuestions`, `parseWatcherCard`), and the side effects a stage exists
    for — a branch cut, the story's `dod` block re-run and its exit code recorded, a `--no-ff` merge
    into the epic branch with `main` untouched, and a watcher card's status COMPUTED as `verified`
    when the scenario's front matter claimed `draft`.
  - **A check that is `skipped` for any reason other than being write-time-only now fails an eval.**
    `runCheck` falls through to `unknown check id '<x>'`, which is what a renamed or deleted check
    looks like from outside — and it would otherwise read as a pass.
  - **`EVALS` is load-bearing, not bookkeeping.** A coverage test asserts it names every stage
    under `stages/`, so a sixth stage shipping without an eval turns the suite red and says which
    one is missing.
  - **Every eval was watched failing before it was trusted.** One sabotage each, listed with its
    symptom in `test/evals/README.md`; the Plan one is the shape to aim for — nothing crashed, every
    count still matched, and dropping a cross-epic `depends_on` was still caught because the derived
    branch model changed. The same file says how to add a sixth eval, and what v1 deliberately does
    not cover: failure paths, the agent gate, attended runs, and prompt QUALITY, which needs a real
    model and a judge.

- **`tldrx story reopen <id> --for-fix --note "<defect>"` — a sanctioned fix round on a `done` story
  (#58, owner decision 2026-09-01).** Measured on `260829-scoring-leaderboard`: S11's adversarial
  review found a real defect (linkEmail succeeds, setDisplayName fails, the account is permanently
  linked and the score never claimable). It was accepted, small and well understood — and the story
  was already `done`, so the only choices were rejecting the whole Build stage, which destroys
  fourteen good stories' closure, or fixing it outside the story machinery, which leaves an
  epic-level commit with no story provenance. `done` → fix round was the missing arc.
  - **No attempt is consumed.** The mechanism is the one that was already there: `story.reopened` is a
    reset boundary the review ledger reads, so the approve that closed the story stops counting and
    the fix runs as attempt 1 of 2 — with both turns available to it.
  - **The same DoD and the same reviewer.** The story goes back to `todo` and the Build pipeline picks
    it up unchanged; a fix a reviewer refuses twice blocks, exactly as the original would have.
    Nothing is waved through because a human asked for it.
  - **It cannot relitigate scope.** The `--note` names a defect, and `status:` is the ONLY line the
    verb moves on the story file — the acceptance criteria the reviewer will judge against are the
    ones that were already there.
  - **One open fix round per story.** It opens on a `story.reopened` carrying the new `reason: fix`
    and closes when the story is `done` again; a second `--for-fix` while one is open is refused,
    naming who opened it and with which defect. The bound is read from `events.jsonl`
    (`ReviewLedger.fixRound`), so it holds across processes.
  - Refused when the story is **not** `done` (an unfinished story is the plain verb's job), when
    `--note` is missing, and on that second round. `reason` is written on every `story.reopened` now —
    `fix` or `attempts` — and an event without it predates the key and is an `attempts` reopen, the
    only kind that existed.
  - The plain verb's `done` refusal now points at `--for-fix` beside `reject --stage`.

### Changed

- **tldrx is no longer sold as "lightweight" (owner decision, 2026-09-02).** The word survived from
  the concept doc, where it was true of a proposal. What it now describes is five stages, a
  machine-enforced `[src: …]` grammar that refuses a write it cannot resolve, an adversarial
  reviewer that is never the author, a dual-economy budget ledger, and a written trail from `run
  new` to `retro`, held up by a suite that measured 3093 tests across 108 files on 2026-09-02. One line replaces it everywhere, so
  the npm page, the binary's own `--help`, the plugin manifest, the README and both landing pages
  say the same thing: **an evidence-first, file-based AI development framework: five stages, a gate
  on every one, and every claim cited or refused.**
  - Changed in `package.json`, `src/cli/commands/help.ts` (the first line of `tldrx --help`),
    `plugin/.claude-plugin/plugin.json`, `plugin/skills/tldrx/SKILL.md`, `docs/concept.md`,
    `README.md`, and the docs site's `description`, hero and Spanish mirror.
  - **The status tag moved with it, because it was already stale.** 0.4.0 shipped as `beta`
    (`CHANGELOG.md`, `README.md` release table) while the badge, the README preamble, the binary,
    the plugin manifest, the site's "Where this is" section, both site footers and the generated
    release-notes preamble all still said `alpha`. They say `beta` now. The site's beta bar is
    stated as CLEARED rather than as being worked through, which is what the release table has
    claimed since 0.4.0.
  - `docs/RELEASING.md` gains the thing that made this drift invisible: the `status-…` badge is a
    hardcoded shields.io URL and does **not** update on its own, unlike the npm and CI badges
    beside it. The README's own release paragraph now shows `--tag beta`, because `release.sh`
    writes `alpha` when `--tag` is omitted.

- **A watcher card may name a HUMAN owner — optional, per item, never invented (#70).**
  `watch check` derived an owner from each item's own citation: `[src: api:src/Leaderboard.cs:64]`
  → `api`. That was right for v1 and stays the fallback, but it answers a different question from
  the one #70 asked — which repo EMITS a signal is not who gets paged when it stops.
  - **Additive, in both halves.** An optional front-matter `owner:` (validated only when present,
    so every card already on disk still validates) and an optional `(owner: <name>)` annotation on
    an individual item, placed BEFORE its `[src: …]` token because §2.8 makes that token the last
    thing on the line. Resolution is item → card → repo-derived, and the printed line says WHICH
    it is showing: `owner: alice (declared on the item)` versus the pre-#70 `owner: api`, left
    byte-identical for every card that declares nothing.
  - **Filled from the ledger that already names owners, or not at all.** `tldrx init` parks
    "Who owns `<repo>`?" as an `ownership` question and the answer lands in
    `.tldrx/memory/facts.yml`. The Watch prompt was inlining `observability` and `deploy` facts
    only, so a sub-agent asked for an owner had no honest source and would have invented one;
    `ownership` is now inlined, and the brief says the name may come from nowhere else.
  - **A lost name is an error, not an absence.** `(owner: )` is a card that TRIED to name somebody
    and lost it, so it is a shape issue on the card rather than a silent fall-through to the repo
    — which is the exact substitution the issue is about.

- **`docs/guide/08-cli-reference.md` documents `note` and `ship` (#72).** Every command in `COMMANDS`
  had a `## tldrx <cmd>` heading except three; #55 wrote `plan`'s, and these are the other two —
  `ship` being the command that opens the PR at the end of a run, and `note` how an operator records
  something against a stage. `DOCUMENTED_SUBCOMMANDS` in `test/cli.test.ts` grew to cover them, which
  is what keeps each of these gaps a red test rather than a note. Only `hook` is left out, and
  deliberately: its seven scripts are documented as the one `<script>` slot `USAGE_SPELLINGS` already
  records as a spelling.

- **`tldrx watch`'s one-line summary says checklist.** It read "List and re-check the watcher cards a
  run produced", which described half of what `watch check` is for and disagreed with the `--help`
  text #65 updated.

- **`tldrx ship` opens one PR PER REPO when the branch is in more than one (#66, owner decision
  2026-09-01).** Since #57 a chained multi-repo run cuts ONE integration branch, `epic/<run-id>`,
  with the same name in every repo — so `ship` found it in several, every time, by construction, and
  refused with `pass one: --repo <name>`. The last step of every such run was typing the same command
  once per repo and remembering which ones had already gone through.
  - Same handoff as the body of every PR, the repo name in the title, and every URL listed at the
    end. Each PR opens against **that repo's own** `default_branch`.
  - **One repo is byte-identical**, down to the four lines it prints and the number of processes it
    spawns: the `gh pr list` probe below exists for the multi-repo case and never runs when there is
    only one. The single-repo lines are asserted as exact strings, not substrings — "we did not
    change the common case" is not a claim a `toContain` can make.
  - **A partial failure names both sides.** PR 2 of 3 failing still opens PR 3, and the report lists
    the repos that succeeded with their URLs and the repos that failed with the reason (exit `2`).
    Aborting on the first failure would leave a half-shipped run and no statement of which half.
  - **Re-running is safe.** Before creating, each repo is asked whether an open PR for the branch
    already exists (`gh pr list --head`); one that has is skipped and listed. So the fix for a
    partial failure is `tldrx ship` again and nothing else. A `gh` that fails or answers with
    non-JSON is treated as "there is none", so a transient error can never silently turn a real ship
    into a skip.
  - `--repo` still narrows to exactly one, and `ship` still never pushes: an unpushed branch in one
    repo is that repo's failure line, naming its `git push`, while the other repos' PRs still open.

### Fixed

- **A training pass with nothing to read is no longer paid for (#101).** `runTraining` had
  exactly one "nothing to work on, refuse before the money" check and it guarded one half of one
  mode: `nothingToMineRefusal` fires only for a ROLE expert with zero minable runs. The CODE pass
  was pushed unconditionally and nothing ever looked at `selection.inlined.length`, so an expert
  whose `## Domain` matched no file on disk spawned a sub-agent, was shown no code at all, and
  wrote a knowledge file about nothing at full price. Measured on the training fixture before the
  fix, with a domain of `src/does-not-exist/`: **`{ code: 0, costUsd: 0.37, wroteKnowledge: true }`**
  — a successful run, priced, from zero input. Live cost, from #94's thread: two near-empty
  trainings at $0.82 each whose "code sweeps found nothing in-domain".
  - **The choice, named: SKIP a dead pass, REFUSE only when none survives.** That is
    `nothingToMineRefusal`'s own idiom — refuse when there is nothing to train from — without
    denying a `--mode full` run that still has one real pass. The skipped pass's reason goes to
    stderr before the money, exactly like the #96 pre-start line, and rides back in
    `TrainOutcome.warnings`; `--prepare` prints it too, and its `N sub-agent(s)` line was already
    derived from the surviving passes so it stays honest by construction.
  - **`roleTraining.ts:79`'s uncovered arm is closed.** Its guard reads
    `if (!isRole || minedFiles > 0) return null`, so a NON-role `--mode full` run against zero
    minable runs was never refused: it spawned a second sub-agent to write
    `- none [src: absent:tldrx-work]` — no evidence, no level, full price. That case is now a
    skip. The role case keeps its own, better-worded refusal untouched, because its runs pass is
    the only pass it has.
  - **It is NOT the #96/#98 preflight and does not touch it.** Underfunded and empty are different
    refusals with different remedies, so they are different checks that never consult each other.
    In particular a skipped pass does not re-divide the ceiling: the share `trainPreflight` priced
    and printed is what the surviving sub-agent gets, and the skipped one is simply not spent.
  - **Exit `1`, deliberately.** `2` is this codebase's MONEY refusal (the `MIN_TRAIN_USD` floor and
    the #96 preflight). Every "you asked for something with nothing behind it" refusal in
    `expert train` is `1` — `missingAreaRefusal`, `lightModeRefusal`, and `nothingToMineRefusal`,
    this check's literal sibling, which `test/training.test.ts` pins as "refused (exit 1)".
  - **One doc correction found while checking that.** `docs/guide/08-cli-reference.md` claimed
    `--mode light` on a role expert exits `2`. It exits `1`: `lightModeRefusal` returns
    `EXIT_USAGE`, and `src/cli/exitCodes.ts` defines `EXIT_USAGE = 1`.

- **`expert create` now yields an expert that can actually be trained, and states the `## Domain`
  grammar it will be read under (#94).** Live 2026-09-02: `tldrx expert create discoverer` printed
  *"no areas — every level starts at 0"*, and `tldrx expert train discoverer --area discoverer`
  answered *"has no area (areas: none)"*. Neither sentence said HOW to add one; no flag or
  subcommand existed; the sanctioned path — a block in `competencies.yml` — was discoverable only
  by reading the source. Then the same gap cost money twice more: the hand-written `## Domain`
  bullets came out WORKSPACE-relative (`Scavtopia.Workflows/src/…`) because nothing documents the
  grammar, so **a $2.10 full training earned zero evidence — all 13 of its code citations read
  `outside domain`** — plus two near-empty $0.82 runs whose code sweeps found nothing in domain.
  - **`--area <id>` seeds the first competency area, and `--title <text>` names it.** The title is
    not decoration: light mode greps the words of the area title to choose which files the expert
    is shown (`training/selectFiles.ts`), so `create` prints the default title it chose and names
    `--title`. An area id obeys the same slug rule the expert name does — it is a filename
    (`knowledge/<area>.md`) and half of a copy-pasteable `--area` argument.
  - **Both refusals name the FILE and print the block.** `expert train` on a missing area now
    answers with `.tldrx/experts/<name>/competencies.yml` and the five keys to paste (`id`,
    `title`, `level: 0`, `train_prompt`, `evidence: []`), from one helper both the CLI and
    `runTraining` use, so the two paths cannot drift. `create` with no area says the same thing.
  - **`create` writes the front-matter `repos:`**, read off `.tldrx/workspace.yml` (`repos: []`
    when there is none, rather than a guess). `expert.md` had no such key at all, so a
    hand-created expert declared nothing about which repos its `## Domain` bullets are relative
    to — and that is exactly the thing the bullets are relative to.
  - **The created `expert.md` states the grammar in its own `## Domain` section**: bullets are
    repo-RELATIVE with no repo prefix, a whole-repo claim is `` - repo `api` ``, citations arrive
    as `repo:path:line` so `api:src/Checkout/Cart.cs:12` is matched by `` `src/Checkout/` `` and
    **not** by `` `api/src/Checkout/` ``. It is written as prose, deliberately: a worked example
    written as a BULLET would itself be parsed as a declared domain path, and an expert that
    silently claims `api/src/Checkout` puts every real citation outside its own domain — the bug,
    not the fix. Pinned by a test that the created file still parses to zero domain paths.
  - **The `outside domain` warning names the grammar FIRST** when the cited path would match with
    one leading segment dropped from either side — the bullet carrying a repo prefix it should
    not, or the citation being workspace-relative where a `repo:path:line` was wanted. It says the
    measured fact (`X` without its first segment DOES contain this path), not a diagnosis.
  - **And naming another expert no longer reads as exclusivity.** *"train that expert on it
    instead"* was measured false: overlap between domains is legal, and the hint fires whenever
    this expert's own paths miss. It now reads *"also declares a domain that contains it, so it
    may be the better home for this one (overlap is legal: this fired because none of `<expert>`'s
    own paths match)"*.
  - **`init/loadWorkspaceFile.ts` reads `.tldrx/workspace.yml`'s name from `core/paths.ts`**
    (`PROJECT_WORKSPACE_FILE`, the constant #92 added) instead of from `init/runInit.ts`;
    `runInit` keeps exporting `WORKSPACE_FILE` under that name, aliased to the same string, so no
    import site changed. `loadWorkspaceFile` is the small leaf several commands read the repo list
    through, and taking that one constant off `runInit` dragged the whole of `init` — detection,
    map providers, the MCP probe — into every module that read it: `dist/hooks/session-start.js`
    went 37,937 → 54,467 bytes and blew the 50 KB entry-point cap `test/build.test.ts` enforces.
    It is back to 37,937.
  - Documented in `docs/spec.md` §2.3 and §2.8, `docs/guide/04-experts.md`,
    `docs/guide/08-cli-reference.md`, `docs/guide/09-troubleshooting.md` and both docs-site expert
    guides — the grammar had never been written down anywhere outside `expertDomain.ts`.

- **`release.sh` ran the gate AFTER pushing the release commit to `main` (#100).** The order was
  commit → push `main` → `release-check.sh` → tag → push tag, so every red item the gate has —
  tests, typecheck, build, the `Bun.*` seam grep, "tag already exists", "already on npm", "tree
  not clean" — landed a `release: X.Y.Z` commit on `origin/main` carrying a **dated** CHANGELOG
  heading and a **dated** README row, with no tag behind it. That is precisely the half-released
  state checklist item 4 exists to prevent, and it costs a revert commit on `main` or a
  hand-repaired CHANGELOG to undo. The order is now commit → **gate** → push `main` → tag → push
  tag: a red gate leaves `origin/main`, the tags and npm untouched, the whole of the damage is one
  local commit, and the script says so and prints the one command that drops it.
  - **The gate did not have to be weakened to move it.** Of its items only "in sync with
    `origin/main`" assumes the push already happened; run against an unpushed release commit it
    would be permanently red, which is the trap in the naive reorder. `release-check.sh` takes a
    new `--pre-push` that restates that one item as **"`origin/main` is HEAD's parent"** — the same
    assertion (nobody moved `main` under you, nothing but the release commit is unpushed) for a
    tree that has not pushed yet, and one notch stronger, since it also refuses a second unpushed
    commit. Items 1–3 already needed the edits, which exist by then; "working tree clean", "on
    main", "tag does not exist", "not on npm", typecheck, tests, build and the seam grep are
    untouched and all still run. **No flag, no default, no CI path changed**: bare
    `release-check.sh` (the `release-gate-hook.sh` PreToolUse deny) and `--ci` (publish.yml)
    behave exactly as before, and there is a test for each.
  - **`sed -i ''` was macOS-only**, which is why this path had never had a test: measured against
    GNU sed 4.9 in `debian:stable-slim`, `sed -i '' -E …` exits **2** with `sed: can't read
    s/^## …/: No such file or directory`, so `release.sh` could not run on the ubuntu CI runner at
    all. Both substitutions now go through a temp file outside the tree and are `cat` back (inode,
    mode and a clean working tree preserved) — byte-identical output on BSD sed, and it runs on
    GNU sed, which is what lets `test/release-gate-order.test.ts` hold the ordering in CI. The new
    file runs the real two scripts against a real bare "origin" with only `bun` and `npm` stubbed,
    and reads the ordering off the shas the gate actually ran against: pre-fix, HEAD and
    `origin/main` were EQUAL at gate time; now they differ by the release commit.

- **The prose was validated against the binary, top to bottom, and a lot of it was false.**
  The last docs QA (3ee3723) was a release ago; `watch check`/`watch arm`, `update` and
  its notice, the `drive` preflight, `plan schema`, `questions cards`, `story reopen --for-fix`,
  the host-token economy and the dashboard's new sources have all landed since. Every claim in
  `README.md`, all thirteen English pages, all thirteen Spanish pages and `CONTRIBUTING.md` was
  cold-read for lies first, then checked against `tldrx <cmd> --help` and the source. What was
  found was not drift at the edges — most of it was load-bearing.
  - **A flag that does not exist.** The README's cost section explained what `--max-budget-usd`
    does. That is the flag tldrx passes DOWN to `claude`, not one a user may type: `tldrx next
    --max-budget-usd 5` answers `unknown flag`. The user-facing flag is `--max-usd`.
  - **"Every run-targeting command exits `2`" was wrong twice**, in the README, the CLI reference
    and the FAQ. `tldrx cost` refuses at exit **1** (`cost.ts` returns `EXIT_USAGE`, and its own
    `--help` never lists a 2), and `tldrx run status` does not refuse at all — it lists every open
    run and exits **0**, which is the whole point of it, since it is the screen you read to find
    the id the others are asking for. All three pages also named five commands as taking a
    positional `<run>`; the real split is that most take either form, `replay` and `retro` take
    the positional only (`--run` there is an unknown flag, measured), and seven take `--run` only.
  - **A documented command that silently creates a directory where you asked for a file.**
    `tldrx dashboard --static --out ./somewhere/page.html` was in the reference. `--out` is a
    directory and the filename is not negotiable (`writeStatic.ts` joins `index.html` and
    `mkdirSync`s the path), so that line makes a directory literally named `page.html`.
  - **A required tool the Quickstart did not name.** `env.yml` declares four `required: true`
    tools; the install page named Node, `git` and `claude` and never mentioned **Bun ≥ 1.3**, so a
    reader who followed it exactly got `tldrx doctor` exit 1 and no explanation.
  - **The `tldrx learn` chapter list was stale AND swapped** on both language Quickstarts: 6 and 7
    are `the agent gate` and `attended`, and the pages had two other titles in the other order —
    so `--chapter 7` sent a reader looking for the agent gate to the wrong chapter.
  - **Counts that had grown.** The `.gitignore` block `init` writes excludes **eight** paths, not
    the five the README listed. The `[src: …]` grammar has **eight** kinds, not the seven the
    evidence table showed — `aidlc:` was missing while the page's own next paragraph said
    "eight". The What, How and Plan stages each declare `questions.md` as an output and Plan also
    declares `budget.yml`; the stages table showed none of them, which matters because the auto
    gate is measured on exactly that file. `tldrx init` seeds **three** kinds of expert — role,
    stack and **domain** — and both expert sections said two.
  - **Twelve `workflows/*.yml` said the auto gate has "the five spec §5 conditions"** and listed
    five. `evaluateAutoGate` has had **seven** since the stories and boundary conditions landed.
  - **The `tldrx drive` mandate's preflight (#84) was absent from every page that enumerates what
    the mandate carries**, in both languages, and the English driving guide still taught the
    three-command recipe the preflight replaced.
  - **`CONTRIBUTING.md` overstated the ref guard and understated the lock.** The guard refuses a
    ref move while ANOTHER invocation holds the lock — the holding run's own git children carry
    `MW_LOCK_TOKEN` and pass, which is what lets the wave commit and push through its own guard;
    as written it would have refused the merge it exists to protect. `merge-wave.sh`'s seven exit
    codes were documented nowhere, in a file whose own rule is to read exit codes. The lock's wait
    is bounded (`MW_LOCK_WAIT_S`, default 3600 s, then exit 6) and `CLAUDE.md` implied it was not.
  - **The Bun/Node seam rule was stated more broadly than it is enforced**, in `CONTRIBUTING.md`,
    `CLAUDE.md` and `docs/RELEASING.md`: the grep scans `src` only, and `scripts/build.ts` calls
    `Bun.build` for a living. A contributor reading it literally files a bug against the build.
  - **`publish.yml` does not "run the same check".** `release-check.sh --ci` skips items 4 and 5
    entirely; the seam check runs in no CI workflow at all. Said plainly now, in both the README
    and `docs/RELEASING.md`.
  - **Four translated strings that had to stay English** in the Spanish mirror: two `--note`
    samples, the `## Qn · Title` heading the §2.7 parser matches on, and `$0.00 of $25.00`, which
    is what the dashboard actually renders.
  - Fixed on the way: the `0.5.0` CHANGELOG section had grown **two `### Fixed` groups** and had
    two additions (Evals v1, `story reopen --for-fix`) filed under `### Removed` — an artefact of
    unioning sibling branches. One group per kind now, in the order `0.3.0` used, with every entry
    byte-identical and only the duplicate heading gone.
  - Two defects found while checking and **filed rather than fixed**, both outside this pass:
    [#99](https://github.com/ederwii/tldr-experts/issues/99) `test/merge-wave.test.ts` asserts over
    a shared `TMPDIR`, so a sibling process fails it (measured: red under load, green alone, and
    green for the full suite with no sibling), and
    [#100](https://github.com/ederwii/tldr-experts/issues/100) `release.sh` pushes the release
    commit to `main` before it runs `release-check.sh`.

- **`expert train` says what it is about to spend, on which model, BEFORE it spends it (#96).**
  Live 2026-09-02: `tldrx expert train discoverer --area discoverer --mode full` inherited the
  claude CLI's last-used model — `fable-5`, a premium tier — and ran against the default ceiling.
  Full mode splits that ceiling between its two sub-agents, so the code pass was handed $1.00. It
  died with `Reached maximum budget ($1)` at 54 s, **$1.31 spent and recorded, nothing written to
  `competencies.yml`.** Three defaults compounded and not one of them was said out loud.
  - **A pre-start line names the model, its tier, and where the name came from** — `--model`,
    `$ANTHROPIC_MODEL`, or a `model:` key in `.claude/settings.local.json` /
    `.claude/settings.json` / `~/.claude/settings.json`: `model claude-fable-5[1m] (premium,
    inherited from your claude CLI via ~/.claude/settings.json) — pass --model to override ·
    --mode full · $3.00 across 2 sub-agent(s), $1.50 each`. When nothing on the box says which
    model the CLI will pick, the line says THAT rather than inventing a tier.
  - **A refusal — exit `2`, nothing spawned, nothing spent — when the share cannot fit and the
    ceiling is the DEFAULT one.** The test is arithmetic, not a category: does the money one
    sub-agent gets reach what one pass on that tier costs? Measured full trainings run
    **$1.21–$1.60 end to end on a mid model** (two `training.jsonl` lines on `aparece-platform`,
    `docs/audits/2026-08-29/experts-knowledge.md` §E, plus the top of the band in #96), so one
    pass is ~$0.70 mid and ~$1.76 premium (opus lists at 2.5x sonnet). Full mode's $1.50 a pass
    does not reach it. The refusal names both remedies — `--model sonnet`, or `--max-usd <n>`.
  - **An explicit `--max-usd` is never refused.** The operator looked at the number; that is the
    whole decision this check exists to ask for. It warns in one line and proceeds.
  - **The full-mode default `--max-usd` is now $3.00**, up from the $2.00 light mode still uses,
    because full mode pays for two sub-agent passes and the one repair round a rejected knowledge
    file earns comes out of the same share. $1.50 a pass is ~2x the measured per-pass midpoint.
    Deliberately not scaled higher for a premium model: `--max-budget-usd` is a stop after the
    turn, not a cap (spec §2.6.1 — a $1.50 ceiling has realised $5.15), so a bigger default cannot
    make a premium turn affordable, only more expensive to lose. `budget-gate` prices `--mode
    full` at $3.00 to match.
  - Salvaging the partial evidence a budget death throws away is a design call and was NOT built;
    the question is asked on #96.

- **`expert train --prepare` carries that check into the bundle (#98).** The check above was wired
  to the spawning path only, and `--prepare` spawns nothing — but it writes the ceiling into
  `pending.json` (`max_budget_usd: 1.50`) and into the prompt text (`Ceiling for this sub-agent:
  $1.50`), and a host session then spends against it. Measured on `b5d59c5`: a full `--prepare` with
  a premium model inherited from `~/.claude/settings.json` printed `$1.50 ceiling each`, returned
  `preflight: null`, and wrote two bundles saying `model: null` — the same trap, one command later,
  on the host's money.
  - The model line and any warning now go to **stdout with the prepared block** and into an optional
    **`preflight`** key on each bundle's `pending.json`. Absent when there is no warning, so an
    unremarkable bundle stays byte-identical to the one this command has always written.
  - **What it may CLAIM differs by half.** Headless, tldrx spawns `claude` with no `--model`, so the
    CLI's default is a prediction about a process this code starts: the refusal stands. On
    `--prepare` an **explicit `--model`** is an instruction written into the bundle and is refused
    the same way (exit `2`, no bundle written); an **inherited** model only warns, naming both
    remedies — refusing a bundle over a settings-file key, for a session tldrx does not control,
    would be asserting more than is known. `--commit` says nothing: that money is already spent.

- **`test/merge-wave.test.ts` no longer fails a wave over another wave's log directory (#95, #97).**
  `merge-wave.sh` writes its logs to `${TMPDIR:-/tmp}/mw-$$`, and the test that asserts a green run
  cleans up after itself diffed a listing of the machine's SHARED tmpdir. Every wave on the box
  writes there — this file's other tests, every sibling agent's wave, and the real merge wave whose
  `bun test` is running this very file — so the assertion was about ONE run's cleanup and measured
  the whole machine. It went red twice on trees whose diff touches neither the script nor its tests:
  **#95**, on a sibling's DELIBERATELY KEPT red-wave log (`mw-35458`, carrying another run's
  `poison.txt` merge — merge-wave keeps a failed run's logs on purpose, "every FAIL above names the
  directory it kept"); and **#97**, on a CONCURRENT invocation's LIVE `mw-15412`, twelve minutes into
  #90's wave, with `main` left at an unpushed merge commit. Both cost a full re-gate, and the same
  trees passed standalone.
  - **Every invocation now gets a private `$TMPDIR` inside its own sandbox**, so "did THIS run clean
    up after itself" has an answer that does not depend on what else the box is doing. Per
    invocation, not per sandbox: this file deliberately runs two waves at once. The scan is read only
    after the run has exited, so anything left in that root is a genuine leftover and no liveness
    rule has to be guessed at — a concurrent wave's live `mw-<pid>` is, correctly, invisible from
    there.
  - **What the test asserts about merge-wave is unchanged.** A green run that stops removing its log
    directory still fails it, and a red run that stops keeping the one it names still fails it — both
    re-measured by mutating `scripts/merge-wave.sh` and watching the assertions fire.
  - **A red run's kept logs now leave with the sandbox.** They were being written to the machine's
    tmpdir and never removed — 1300 `mw-*` directories had accumulated there by the time #95 was
    filed, including the one it tripped on.

- **A story's first attempt is dispatched at what the plan priced it, not at that figure halved
  again (#91).** `03-plan/budget.yml` has been read since 2026-08-30, but the price it carries was
  divided by the worst case ONE story can be asked for — `MAX_ATTEMPTS × (1 + REVIEWER_SHARE)` =
  2.5 — before a single attempt had run. Measured on run `260901-leaderboard-v2` (finding F-4):
  Delivery priced S2 at $2.10 of a $3.85 Build stage and the developer was dispatched under
  **$0.84**. A deliberately-atomic large story starved on the one attempt that mattered while
  trivial ones carried slack, and the plan's own measured pricing — the whole point of writing the
  file — was thrown away in the arithmetic that read it.
  - **`developerPriceDivisor(attempt)`** now decides it. Attempt 1 is the pass Delivery priced and
    gets `price / (1 + REVIEWER_SHARE)` — the whole price less the reviewer's derived quarter, so
    S2's ceiling goes $0.84 → **$1.68**. Attempt 2 is a contingency nobody priced and keeps the
    pre-#91 figure, `price / (MAX_ATTEMPTS × (1 + REVIEWER_SHARE))`. No attempt is ever handed less
    than it was handed before.
  - **The even split is untouched.** A plan with no `budget.yml`, one that does not validate, one
    priced in `host-tokens`, and any story the plan did not name all still get
    `stage / (stories × attempts × 1.25)`, pinned by tests that were green before this change and
    are green after it.
  - **What this costs, stated.** The worst case one PRICED story can be asked for goes from
    `0.8 × price` to `1.2 × price`. The phase ceiling is metered once, at stage entry —
    `runNext.runExecutor` skips the brake while a stage is `running` — so nothing re-checks the
    envelope between two spawns of the same headless `runAll`; that is the window
    `REVIEWER_FLOOR_USD` already opens by design. `priceScale` still holds the sum of the declared
    prices inside the stage, and `remainingWork` still clamps the brake's estimate to the stage's
    own price, so the brake can never refuse more often than it used to. The measured REMAINDER of
    a story's price would be tighter on the second attempt, and is recoverable (`agent.result`
    carries `key` = the story id and a row-level `cost_usd`) — it is not read, because the
    budget-gate hook's `remainingWork` would have to read the same ledger on its hot path to stay
    in step, and the worst case is `0.8 + 0.4` either way.
  - **`remainingWork` mirrors the schedule, turn by turn.** `RemainingStory` gains
    `developerCapsUsd` — one cap per turn still to dispatch, in the order they run — because
    `cap × turns` stopped being the truth. The turns still to run are the LAST of the story's run
    of attempts, so a story with one attempt behind it is priced as the attempt 2 it is about to
    become. `renderRemainingWork` prints `dev $1.20 ×2` while the turns cost the same and
    `dev $3.60 + $1.80` once they do not, so the total on the line still adds up. A test asserts
    the mirrored divisor equals the executor's own, as it already did for the three constants.

- **The merge lock now has something to say about raw git in the shared checkout (#89).** The
  lock serialises merge-wave INVOCATIONS; it never serialised git. Measured 2026-09-02: while
  agent A's gates were running, agent B typed `git reset --hard origin/main` into the same
  shared checkout — reflog `reset: moving to origin/main` — and A's merge commit stopped being
  reachable from `main` mid-gate. #44's gated-HEAD assertion fired for the first time in anger
  and refused to push. The aftermath was caught; the damage was not prevented.
  - **`scripts/merge-guard.sh`, installed as a `reference-transaction` hook on every
    merge-wave run.** That is the only hook git will let abort work in progress: it fires for
    every reference update and, in its `prepared` state alone, aborts the whole transaction on
    a non-zero exit. Measured on git 2.50.1 with the guard refusing — `git reset --hard`,
    `git checkout -B main`, `git merge --no-ff`, `git commit` (including `--no-verify`, which
    does **not** bypass it) and `git update-ref` all exit 128 with `fatal: ref updates aborted
    by hook`, and **the ref does not move**. There is no pre-reset, pre-checkout or
    pre-merge-anything hook; this is the strongest mechanism git offers without a daemon.
  - **Where the line honestly lies, because it is not where it looks.** `git reset --hard`
    writes the WORKING TREE before it opens any ref transaction — measured: the file content
    had already changed to the target commit's while HEAD still pointed at the old one. So the
    guard saves the **commit**, which is what #89 lost, and cannot save the checked-out files;
    a wave whose worktree is clobbered mid-gate still gates a tree nobody meant it to, and its
    gated-HEAD assertion will not fire, because HEAD is exactly where it left it. `git merge`
    is the better case — refused before the worktree is touched at all. And a hook in a
    checkout is bypassable by anyone willing to: `git -c core.hooksPath=…`, deleting the hook,
    or exporting `MW_LOCK_TOKEN`. It is built against accidents, not intent.
  - **The lock is the sentinel; the marker is what that lock looks like to a human.**
    `merge-wave.sh` writes `.MERGE-WAVE-IN-PROGRESS` at the root of the shared checkout naming
    the branch, the owning pid and host, and the way back in. Gitignored, so a wave cannot trip
    its own dirty-tree guard; removed by `release()` on every path out, INT and TERM traps
    included. The guard keys on the LOCK rather than on the marker, because only the lock
    carries an owner and only an owner can be tested for death — a SIGKILLed wave must not
    leave a file behind that wedges the checkout.
  - **Scope, so an agent's own work is never in the way.** In the shared checkout every ref
    update is refused while a foreign wave holds the lock. From a linked worktree only
    `refs/heads/main` is — refs live in the common dir, so `git update-ref refs/heads/main`
    typed in a worktree destroys the wave just as thoroughly (measured: it succeeds, unguarded).
    The holder's own git is recognised by an exported token written inside the lock, so
    merge-wave cannot deadlock itself, and a lock whose owner is dead is ignored exactly as the
    waiting loop already ignores it — `scripts/merge-lock.sh` is that one vocabulary, shared by
    writer and guard so the two cannot drift apart.
  - **The state name git passes is not portable, and assuming it was shipped a red CI.** macOS
    git 2.50.1 calls the abortable state `prepared`; the Linux runner's git calls it something
    else (`fatal: in 'preparing' phase, update aborted by the reference-transaction hook`, run
    33589554234 on `e0e76a2`). The guard's `*)` arm printed a usage error and exited 2, so on
    that machine every ref update in every sandbox was refused and the whole merge-wave suite
    went red at once while macOS stayed green — #49's failure shape exactly. It now recognises
    `committed` and `aborted` and treats **everything else** as the prepare state, which cannot
    repeat the blanket refusal: git honours the exit code in the prepare state only, so an
    unrecognised name is either handled correctly or ignored. The test asks git which states it
    passes rather than hardcoding them, and additionally probes the names this machine does NOT
    use — the only way the portability property is testable anywhere.

  - **And the convention it only approximates is now written down**, verbatim and identically,
    in `CONTRIBUTING.md` and `CLAUDE.md`: agents touch the shared checkout ONLY through
    `scripts/merge-wave.sh`, every other piece of work happens in their own worktree, and never
    `git reset --hard` or `git checkout -B main` in the shared checkout. A test asserts both
    files still say it.

- **A cancelled run is no longer told to retry itself (#86).** `tldrx run cancel` is the way to
  close a run whose stage FAILED — that is the case `run.cancelled` exists for, and it is a
  run-level field precisely so the stages keep their failure, "which is history, not state".
  `deriveRunStatus` read that decision first; `waitingFor` could not read it at all. It is typed
  against `WaitingRun`, the smallest shape both `RunFile` and the dashboard's tolerantly-read
  `RunDocument` satisfy, and that shape had `cursor` and `phases` and nothing else — so the answer
  came from the status of the stage at the cursor, which a cancellation deliberately leaves
  `failed`. A run somebody had closed reported `waiting.kind: failed` and
  `"… FAILED — retry: \`tldrx next\`"`, counted as movable, and could wear `← next` on the
  dashboard. Both screens, because both have read the same derivation since #60.
  - `WaitingRun` grows an optional `cancelled`, `RunDocument` projects it, and `waitingFor` reads
    it FIRST — before the cursor checks, in the same order and for the same reason
    `deriveRunStatus` does. A ninth waiting kind, `cancelled`, joins `WAITING_KINDS`; it is not in
    `MOVABLE_KINDS`, so `tldrx status` stops offering the run and the dashboard raises no card.
  - The message names **who closed it, when, and their note** — three facts that were dropped
    everywhere, on the one screen that exists to say what a run needs. It offers no command:
    `tldrx next` on a cancelled run already advances nothing, and printing it is what made an
    operator think there was something left to do.

- **An out-of-order `--commit` no longer leaves a `stage.started` behind (#87).** `runExecutor`
  stamped the stage `running` and appended `stage.started` on its way in, before the executor had
  had a chance to say anything. #82 restores the stage's STATUS when that executor turns out to be
  refusing a sequencing mistake, so `run.yml` comes back byte for byte — but `events.jsonl` is
  append-only truth and the line could not be unwritten. The live run `260901-leaderboard-v2` left
  one at 2026-09-02T00:36:37Z: a `stage.started` with no matching `stage.done` or `stage.failed`,
  which `renderReplay` and anything counting starts read as a start. A `--commit` never STARTS a
  stage — it settles a cycle a `--prepare` started, and on the ordinary commit the stage is
  already `running` and no event was emitted anyway — so it no longer emits one at all. The
  `markRunning` STAMP stays, keeping the original `started_at`, so a `--commit` that does settle a
  cycle on a stage something demoted still finishes through. The refusal now precedes the event by
  construction: there is no event. Pinned by measuring the WHOLE log, not a `stage.started` count.

- **An unreadable `result.json` is refused like an absent one, loudly (#88).** Owner decision,
  2026-09-02. #82 split `PendingError` into `absent` (the host has not written the file) and
  `unreadable` (the host wrote it and got it wrong), and left the second failing the stage. But
  nothing was attempted there either — no sub-agent ran, no cent moved, no branch changed — and
  the fix is the same single command: rewrite the file, run `tldrx next --commit` again. Failing
  it actively OBSTRUCTED that fix, because it demoted the stage out of `running`, and the
  phase-budget gate is skipped exactly when a stage is `running` — which is how #82's live run
  took a `budget.blocked` it had not earned. A host that fat-fingers its JSON paid the same tax.
  It is #79's model — FORM never costs an attempt, CONTENT/WORK always does — applied to run
  state.
  - Corruption does not pass silently. Both call sites in `build.ts` now go through one door that
    appends a typed **`result.unreadable`** event naming the run-dir-relative path, the parser's
    own message, the role (`developer` or `reviewer`) and the story, and the refusal line says
    which file to rewrite and which command to run. It is the only thing a sequencing refusal ever
    writes; `run.yml` still comes back byte for byte, and `tldrx replay` renders the line.
  - `parseReview`'s fail-closed rule is untouched and is a different, harsher contract: it governs
    an envelope that PARSES and is not a valid verdict (unreadable ⇒ `changes`, never `approve`).
    A file that does not parse at all never reaches it.

- **Watch READS the branch it diffs off `run.yml`; it used to derive one (#90).** The watch stage
  diffed `feature.epic?.branch` — the `branch:` an epic file DECLARES, written at Plan time before a
  line of code exists. Under the integration branch model (#57) the Build executor deliberately
  ignores that value: every epic's stories merge into one `epic/<run-slug>` branch and the epic
  stays in the plan as a label. So on `260901-leaderboard-v2` the prompt told BOTH watchers,
  verbatim, that `epic/leaderboard-v2-api` *"does not resolve in scavtopia-workflows. Treat this
  feature's code as UNSEEN — cite `absent:` rather than guessing at what it emits"* — about a branch
  nothing had ever cut, while `build.epic_branch` recorded the real one three lines away in the same
  run. An obedient watcher would have written an all-`absent:` card, and **that card PASSES
  `claim-sources`**, because an `absent:` citation resolves by construction. Confident, validated,
  useless coverage; caught only because the host's brief carried the real branch independently.
  - **The branch now comes from the run's record and nowhere else** (`core/watch/recordedBranch.ts`).
    `branch_model: integration` → the run's one recorded branch, for every feature. `per-epic`, and
    every run written before `branch_model` existed → the recorded LIST, with the epic's declaration
    used *only as a key into it*. A declaration is never returned as a branch: either it is in the
    record and the record's entry is what is returned, or the answer is "unrecorded".
  - **A branch the record CLAIMS and the repo cannot find is now a refusal**, not an instruction.
    It is the run contradicting itself, so the stage refuses before anything spawns (`refused`, so
    the stage goes back to `ready`), naming the recorded value, the feature and the repo, and saying
    what fixes it. The treat-as-UNSEEN instruction survives for the one honest case — the record
    names no branch at all — where the prompt now cites `build.epic_branch` rather than a name it
    made up. The two absences used to render as the same sentence.
  - Thirteen tests, red first (6 red / 6 green before, 13 green after): the derivation reproduced
    under both branch models (the prompt's branch lines asserted byte for byte against
    `build.epic_branch`), the loud path in both `headless` and `--prepare`, `--commit` deliberately
    NOT refusing a turn that is already paid for, and the honest absence.

- **A recorded `default_branch` that does not resolve is incoherent state too (#92).** #90 taught
  Watch to tell a run that recorded NO branch (honest) from a branch its own `build.epic_branch`
  claims and the repo cannot find (incoherent, refused). It left the third case alone: the BASE of
  the same diff. `.tldrx/workspace.yml` declares `default_branch: main` for a repo where `main` does
  not resolve, and the prompt rendered *"`main`, the `default_branch` of api, does not resolve
  there. Treat this feature's code as UNSEEN — cite `absent:` rather than guessing at what it
  emits"* — inviting the same all-`absent:` card that passes `claim-sources` and covers nothing.
  Narrower blast radius than #90 (a misdetected or renamed default branch, not an every-run
  derivation), same shape: **a value the workspace RECORDS that the repo cannot find.**
  - **Watch refuses at `--prepare` and headless**, naming the repo, the recorded value and
    `.tldrx/workspace.yml`, and saying that the value was DETECTED from that repo — so a repo with
    no such branch means the record has gone stale (a rename, a fresh clone with only remote
    branches, a misdetection). `epicDiff` carries it as `baseMissing`, the sibling of #90's
    `branchMissing`, and checks the base FIRST: a base that is not there voids every diff in that
    repo rather than emptying one, so there is nothing to learn by asking about the branch. On
    `--commit` it stays tolerant, the same call #90 made — those cards are already paid for.
  - **`tldrx doctor` reports it**, which is where the issue asked whether it belonged, and the
    answer is yes: this is a workspace RECORDING something false, and `doctor` is the one command
    whose job is what this machine and this workspace actually have. One
    `git rev-parse --verify --quiet` per declared repo, nothing fetched or written. A **warning**
    that never moves the exit code — `healthy` is about the TOOLS this machine has, and a repo can
    legitimately be mid-clone or mid-rename on a developer's box; a `doctor` that exits 1 for that
    is a `doctor` people stop running. A repo that is not on disk, has no `default_branch` recorded,
    or is not a git repo is reported as SKIPPED with its reason, never folded into "all resolve".
  - **`boundary` has the gap and deliberately keeps its verdict — measured, not assumed.** It does
    diff `<default_branch>...<epic_branch>` (`boundary.ts`, `base:` read from `workspace.yml`;
    changing the record from `main` to `trunk` changes the target's `base` byte for byte), and an
    unresolvable base came back `{ok: true, detail: "n/a (nothing could be diffed: \`trunk\` does not
    resolve in app)"}` — the gate passes GREEN and stops measuring for as long as the record is
    wrong. It is **not** made to refuse: it spawns nothing and writes nothing, so the fault costs it
    a measurement rather than producing a false one, and `boundary.ts`'s own contract is that it
    "must not refuse a gate for a reason that has nothing to do with the boundary" — one stale
    record would otherwise brick every Build gate in the workspace. What changed is the WORDING: its
    two absences used to be the same sentence (`` `<ref>` does not resolve in <repo> ``), so a
    merged-and-deleted epic branch (nothing to fix) read exactly like a stale `default_branch`
    (`n/a` until someone fixes it). The base's reason now names the record and points at
    `tldrx doctor`; the branch's is untouched.
  - `.tldrx/workspace.yml` is spelled once, in `paths.ts`, now that three operator-facing messages
    tell someone to go and edit it.
  - Fifteen tests, red first (8 red / 7 green before, 15 green after), including the verbatim
    pre-fix string captured off the real prompt, the `--commit` tolerance, doctor's warning level
    asserted through `runDoctor` end to end, and the boundary determination pinned on all four
    counts — that it reads `default_branch`, that it stays `ok`, that its reason now names the
    record, and that a missing epic branch keeps its own wording.

- **The dashboard says the framework's CURRENT vocabulary, not 0.2.0's.** The live page
  shipped in 0.2.0 and has had one change since; the framework has had a great many. An audit of
  `src/core/dashboard/` against today's `run.yml` and `waiting.ts` found seven words the files use
  and the page dropped. A page that drops a word does not look wrong — it looks finished, which is
  worse, and every one of these was measured on a rendered fixture before it was fixed.
  - **`prepared` and `running` rendered as "nothing".** `waitingFor` has had eight kinds since the
    2026-08-29 audit; the WAITING ON column named five and fell through to `nothing — <status>` for
    the rest. So a host-attended run with a `--prepare` bundle on disk — the entire attended loop —
    said it was waiting on nothing while `isMovable` had it wearing `← next` on the same row. Every
    kind now prints `waiting.message`, which is the sentence the CLI already prints, and `prepared`
    joins gate/answer/failed as a card: it is a run waiting on a person.
  - **An `agent` gate was counted as a human one.** The execution-path eyebrow read
    `N human, M auto`, so a run opened `--gates what:agent,plan:agent,build:agent` reported as
    all-human — the exact opposite of what it was set up to do, in the one number that eyebrow
    exists to give. It now counts all three, the same arithmetic `renderGates` does.
  - **Nothing showed what an agent gate was signed over.** `run.yml` records the verdict, the
    sample, what resolved and what was refuted, and the run-relative path of the COMMITTED evidence
    note; the model dropped the whole block, so `agent by reviewer` and `human by alan` read as the
    same kind of fact. A human signature is a name and a person accountable for it. An agent's is a
    name and nothing, unless what it checked is beside it. Now `path[].gateEvidence`, printed under
    the signer — the path as text, never a link.
  - **`$0.00 spent` on a run whose turns a host session paid for.** `spentUsd` is metered dollars
    and the meter drew it as the whole story: the exact failure `unmeteredNote` exists to stop the
    CLI making, made in a progress bar. `attendedBy`, `unmeteredTasks` and `hostTokens` now ride the
    model, the card prints `attended: host` in the CLI's own words, and the two currencies are shown
    side by side and never added — there is no exchange rate between a metered dollar and a host token.
  - **`build.branch_model` (#57) and the epic branches were invisible** in a section headed
    *Plan & build*. A chained plan on one integration branch and independent per-epic branches drew
    the identical table. A null model is reported as unrecorded, never guessed at as `per-epic`.
  - **A `stale` stage looked finished.** A stage left behind by `tldrx reject --stage` wears
    `done` with its outputs still on disk, derived from a decision that has been withdrawn. It now
    wears a `stale` chip too.
  - **The page claimed it read `events.jsonl`.** It never has (measured: nothing in `model.ts` or
    `loadPhaseArtefacts` opens the ledger). That sentence is why a reader could not tell an empty
    ledger from an unread one, so the *How to use it* tab now says which files it reads, that the
    ledger is not among them, and which commands do read it. The Watchers tab, which existed
    precisely to be honest about a gap, printed an invented card shape whose field names matched
    none of the seven `Watcher` actually carries; it now prints the real one and names
    `tldrx watch list`.
  - **`review` was grey.** A `PLAN_STATUSES` value the page's tone function had never heard of, so
    a story in review landed in the same colour as one nobody had started.
  - **The test that should have caught all of this asserted the opposite.** `WAITING_KINDS` is now a
    value rather than a bare type union, and the chain fixture's coverage test names the three kinds
    it cannot hold instead of claiming it covers every kind — the claim that let `prepared` go
    unrendered for months. `modelVersion` stays at `3`: every model change here is an ADDITION, and
    the rule in `model.ts` is that only a removal or a change of meaning bumps it.
  - **What the same audit found and did NOT fix is #85**, because each of it is a decision rather
    than a patch: reading `events.jsonl` (operator notes, story attempts and reopens), reading
    `budget.yml` (per-phase ceilings, `on_exceed`, whether `next` is affordable), reading the
    watcher cards, and surfacing a preflight refusal. #86 is a separate bug the audit turned up in
    `run/waiting.ts` — a cancelled run is offered a retry — which both screens share.

- **The #80 guard's kind sweep could not tell a regex literal in CODE from one quoted in a
  COMMENT (#83).** The marker half of that guard has a discriminator and says why: a `[` inside a
  regex opens a character class, so code that matches the `[src:` marker must spell it `\[src`
  while prose writes `[src: …]` bare. The kind half had no equivalent, because prose quoting a
  regex LITERAL copies it character for character — there is no signature inside `/^F\d{3,6}$/`
  that a real production has and a quoted one lacks. #81 paid the tax: the doc comment explaining
  which two literals had just been DELETED tripped the sweep in the very file that had stopped
  classifying, and had to be reworded to name the shapes without writing them.
  - **The discriminator is the line's ROLE, not its characters.** A line that is comment prose —
    a whole-line `//`, a block opener, or one of its `*` continuation lines — is not a
    classification, and the sweep now reads the file with those lines removed.
  - **Line-local, holding no state, and that is the design rather than a shortcut.** #80's own
    first attempt reached for a lexer and was bitten twice: eleven offenders that were all doc
    comments, then five more that were template literals nested inside interpolations once
    comments and strings were stripped. This predicate never looks inside a string, so an
    unclosed `/**` in a prompt cannot unbalance it and blind the sweep to the code below —
    asserted, not assumed. What it cannot lex it keeps: a shape quoted in a trailing comment
    after code is still read as code, so this half still fails CLOSED.
  - **Measured in both directions on the real tree, not only on fixtures.** Re-injecting #81's
    exact doc comment into `validateFactsFile.ts` leaves the sweep green; injecting two real
    productions as CODE into the same file turns it red with `validateFactsFile.ts classifies
    answer, fact` — the identical message #81 saw for prose. The sweep is also no longer
    vacuous by assumption: a test pins the kinds the canonical grammar itself trips
    (`answer`, `cmd`, `fact`) and the six productions the deleted `core/map/srcToken.ts`
    carried, so a production that stops matching anything becomes visible rather than silent.
  - **What it removed, measured over the tree.** 28 files matched at least one production
    before, 20 after; the 8 that stopped matching were doc comments mentioning `→ exit` and
    nothing else — each one production away from #81's surprise red. No file lost a
    classification: the most kinds any file decides is still 3, and it is still `srcToken.ts`.

- **A handshake called in the wrong ORDER no longer fails the stage and the run (#82).** On the
  live run `260901-leaderboard-v2` (2026-09-02T00:36Z) the driver ran `tldrx next --commit
  --review` while no reviewer bundle was out. The framework said exactly the right thing — "no
  reviewer bundle is out — run `tldrx next --prepare --review` first" — and then emitted
  `stage.failed` twice and flipped the run to `status: failed`, so a mistyped command needed an
  explicit recovery. Nothing had been attempted: no spawn, no cent, no branch, no story moved.
  Same family as #78/#79 (form vs work), applied to state transitions instead of attempts.
  - **Five refusals are reclassified**, all of them the handshake asked for by the wrong end:
    `--commit --review` with no reviewer bundle out; `--commit` with no story `in_progress`;
    `--prepare --review` over a story whose developer half has not run; and either `--commit`
    before its `result.json` has been written. Each now exits `1`, names the command that fixes
    it, and leaves `run.yml` byte for byte as it was — no `stage.failed`, no status moved, no
    task recorded, no cent metered.
  - **This is the behaviour the framework already had one layer over.** A single-agent stage sent
    `--commit` before its `--prepare` has always returned exit `1` and touched nothing
    (`commitStage`). Build was the outlier because Build owns its own middle, so its refusals came
    back as `ok: false` and `runNext` could only read that as a failed stage. The fix gives Build
    the same door rather than inventing a second contract.
  - **`sequencing` is a second flag, not a widening of `refused`.** `refused` sends the stage back
    to `ready`, which is right for a precondition an operator must go and fix — a dirty repo, a
    red base tree — because the cycle cannot continue. A sequencing refusal is a cycle that is
    perfectly fine, held by the wrong end: the bundle is still out and sending the stage back to
    `ready` would throw away the state the next command needs. Honoured only when the outcome
    carries no tasks, no cost and no epic claim, so a refusal that spent something still records
    it; defaulting to "record it" is the direction a mistake here is recoverable in.
  - **The bug had a price, and it was the budget brake.** `runExecutor` skips the phase-budget
    gate exactly when a stage is already `running`, because a Build stage hands out one story per
    `--prepare`/`--commit` cycle. Failing the stage demoted it out of `running`, so the next
    `--prepare` was priced as a fresh stage start: on the live run that was a `budget.blocked`
    ten seconds after the refusal, $2.66 left against a re-charged $4.32 estimate, for money
    already partly spent. Reproduced in the fixture and pinned.
  - **`PendingError` carries a typed `kind`** — `absent` (the file was never written; a step of
    the handshake) vs `unreadable` (somebody wrote it and got it wrong; still a failure). Typed
    rather than matched on the message, for the reason #79 gave: a caller reading the words breaks
    the moment the message improves.
  - Genuine failures are untouched and pinned: a red Definition of Done still blocks its story, a
    reviewer that dies is still recorded as a failed check, and a plan that cannot be loaded is
    still `stage.failed` with a `failed` run. Two existing pins moved deliberately, both of them
    asserting the old exit `5` of a pure sequencing refusal.

- **`facts.yml` ids and citable ids were two spellings of one shape; now they are one constant
  (#81).** `src/core/facts/validateFactsFile.ts` defined its own `F` and `Q` id patterns, agreeing
  with `SRC_PATTERNS.fact` / `.answer` character for character, with nothing asserting that they
  must. Found while fixing #80 and filed rather than fixed there, because it is not #80's defect:
  the `[src: …]` token grammar has exactly one reader now, and what was duplicated here is the id
  SHAPE that grammar happens to share with the facts file, reached by a different reader answering
  a different question — which is why #80's kind sweep allowlisted the file rather than folding it in.
  - **They must agree, and the DIRECTION is what makes it load-bearing.** One string makes one
    trip: `formatFactId` mints `F102`, `validateFactsFile` admits it into `.tldrx/memory/facts.yml`,
    and `classifySrc` reads that same `F102` back out of a `[src: F102]` token for `knowledgeFile`
    to resolve against the store. So every id the facts file accepts must be citable, or a fact
    exists that cannot be cited and is invisible to every reader downstream of it. Nothing in that
    pipeline ever runs both readers on the same string, so the drift would have been silent. (The
    other direction is merely untidy: a citable id no facts file holds is caught later, as a
    citation that resolves to nothing.)
  - **Derived, not merely asserted.** `validateFactsFile.ts` imports `SRC_PATTERNS.fact` and
    `.answer` — the same publication surface `srcGrammarContract.ts` already generates the
    documented grammar from — so there is one spelling rather than two that match. The #80
    allowlist entry is deleted along with the need for it, and that sweep now covers the file like
    any other; an exemption that has stopped being needed is one that will some day cover something
    it was never granted for.
  - **A behavioural guard too, because sharing a constant only holds while nobody re-types a
    literal.** The kind sweep needs TWO productions in one file before it fires, so a single
    respelled `F` shape slips straight past it — measured by sabotage, not assumed.
    `test/map-citations.test.ts` now runs both readers over a table of ids spanning both digit
    boundaries and compares their verdicts; loosening either shape by one digit turns it red with
    `F12: facts.yml holds it but the grammar refuses it`.
  - **One drift had already happened, in prose.** The `source.q` refusal read `expected ^Q\d+$ or
    null` while the reader ran `^Q\d{1,6}$` — the shape's third spelling, telling an author a
    seven-digit question id was acceptable and then refusing it. Both refusal messages are now
    generated from the pattern they enforce, so neither can drift from its reader again.
- **The docs site said 0.3.1, named a flag that does not exist, and told readers to hand-write
  a mandate the CLI now prints.** A cold read of every page against `tldrx <cmd> --help`, EN and
  ES. Three claims were false rather than merely stale: the version, printed on six pages, was two
  releases behind what `npm i -g tldr-experts` installs; `--max-budget-usd` was named as a `tldrx
  next` flag in both budget pages, but it is what tldrx passes down to `claude` and `tldrx next
  --max-budget-usd 3` exits `1` on an unknown flag; and `guides/driving` said "there is no keyword
  for the third part — the mandate is prose you write" three weeks after `tldrx drive
  --attended|--unattended` shipped to print exactly that, versioned with the package. Also
  corrected: the hero claimed a gate you own at the end of *each* stage, where `feature` ships two
  `auto` ones; the quickstart said "five role experts" one line under output reading `experts 6
  seeded`, and reported `$0.31 of $4.00` on a run opened at `$5.00` without saying the second
  figure is the stage's ceiling.
- **The site covered none of the last release's commands, and the Spanish mirror had fallen a
  release behind the English one.** Added across both languages: `story reopen --for-fix`,
  `questions lint`, `retro --all --json`, `watch check --execute`, `update_check: off`, `seed
  answer`, exit `130`, `budget.yml`'s `ceiling_host_tokens` / `on_host_tokens_exceed` (the host
  economy was documented as unboundable), the integration-branch model for chained epics (#57),
  a FAQ entry for `tldrx update` and the version notice, and a link to `CONTRIBUTING.md`. The ES
  CLI reference was additionally missing `update`, `drive`, `retro --all` and `plan schema`
  outright. `reference/cli` no longer pins a version number that goes stale every release. The
  Spanish pages' code comments were half-translated; terminal output stays English, the docs
  author's own `#` comments do not.

- **`tldrx map --check` ran a SECOND, divergent `[src: …]` grammar; there is one grammar now
  (#80).** `src/core/map/srcToken.ts` was not a thin wrapper over the claim-sources reader — it was
  a parallel set of regexes, and they disagreed on five axes: its `file` pattern
  (`[^\s:]+`) refused a path containing a colon, its answer pattern (`^Q\d+$`) had no digit cap,
  its token pattern was **global** so a citation written mid-sentence counted as one, it stripped no
  trailing backtick or full stop before matching, and it had never heard of `aidlc:`. So a citation
  `claim-sources` accepted could be reported by `map --check` as a problem, and one it refused could
  be reported as fine — the "two readers of one question drift, and the looser one wins the argument
  at the wrong moment" hazard `core/text/handoff.ts` is written against. It also carried #77's
  defect on its own path, printing the symptoms `bullet has no [src: …] token` and
  `unparseable src token` and nothing else.
  - **The parser is deleted, not wrapped.** `checkCitations` calls `parseSrcToken`,
    `diagnoseSrcToken` and `describeSrcFailure` from `src/core/text/srcToken.ts`, so every `map
    --check` grammar failure gets the #77 treatment by construction: the rule id, the rule in its
    own words, the line as written, and a line that would have passed. `CitationProblem` gained a
    `rule` field, so a caller can tell "you wrote it wrong" from "it has drifted" without parsing
    prose. `srcToken(srcs)` — the BUILDER, which had no equivalent on the canonical side — moved
    across rather than went, and now joins on the same `SRC_SEPARATOR` the reader splits on.
    `isBullet` stayed behind in `checkCitations.ts`: it is about DOCUMENTS, and mixing the two is
    what the deleted file got wrong.
  - **The migration hazard was measured before the switch, not asserted after it.** Both grammars
    were run over every `.tldrx/map/**` document and init handoff in the two real workspaces
    available — **39 documents, 692 lines, 435 of them carrying a citation** — and they disagreed on
    **zero** lines: no multi-token line, no non-bullet citation, and not one token that failed to end
    its line. The axes where they *would* differ are pinned as a table in
    `test/map-citations.test.ts`. Unification is **stricter** on six shapes (a mid-line token, a
    `..` in a path, a 7-digit `Q`, a 4-digit exit code, a backwards line range, a line number of
    zero) and **looser** on five that the old reader wrongly refused (a path containing a colon, an
    `aidlc:…#Q<n>` src, a `cmd` whose command holds a backtick, an `absent:` path with a space, a
    token wrapped in backticks). An `aidlc:` citation used to be misread as repo `aidlc` and
    reported as an unknown repo; it is a kind now.
  - **A guard makes re-adding a copy go red** (#48's lesson: deleting one file does not stop a
    second). Two halves, both on the SHAPE rather than the file name — no file outside the canonical
    grammar and two documented non-parsers may hold a regex that matches the `[src:` marker, and no
    file outside it may classify two or more src KINDS. The guard is proven against the deleted
    file's own two regexes rather than assumed. It also turned up a real second copy of the fact and
    question id shapes in `validateFactsFile.ts`, filed as #81 rather than fixed here.
  - **`map --check`'s summary counts the two failures separately.** A citation that does not parse
    never reached the filesystem, so folding it into "N of M citations do not resolve" reported a
    denominator it was never in — and, when every problem was a grammar one, printed "3 of 0".

- **A `[src: …]` rejection now states the RULE it enforced, and the grammar is published where the
  writers read it (#77).** Run `260830-ordering-inventory` lost **three story attempts** to one
  message. Three review envelopes were refused with "no `[src: …]`" — the SYMPTOM — while all three
  carried a citation. The host guessed the grammar twice, got it wrong twice, and finally opened
  `dist/tldrx.js` to extract three rules that were written down nowhere a writer could read them:
  the token must END its line (`TRAILING_TOKEN_RE` is anchored), a `]` **inside** the token
  truncates the match (`[^\]]*`), and a `cmd` source needs the real `→`, never ASCII `->`.
  - **Every rejection on the path names its rule, quotes the line, and shows a corrected one.**
    `SRC_RULES` (`src/core/text/srcToken.ts`) is fifteen rules, each with the pattern that enforces
    it and a worked `bad`/`good` pair; `diagnoseSrcToken` maps a failure onto exactly one. The hook
    denies, the gate's `claim-sources` detail, `parseFixFindings`' `refuted` refusal and every
    `classifySrc` error now carry the id. The deny messages take the document text and quote the
    offending line back — naming `L14` and stopping there is what sent the host looking.
  - **The grammar is GENERATED and spliced into the prompt** (`renderSrcGrammarContract`), following
    the #35 precedent: kinds from `SRC_KINDS`, patterns from `SRC_PATTERNS` printed `.source` and
    all, rules and examples from `SRC_RULES`, the four-section rules from the same constants
    `handoff.ts` enforces. It reaches the writers through the check-contracts registry (every stage
    declaring `claim-sources` over a `.md` output), the Watch executor — which read `stage.md`
    raw and so was the one writer never given any contract — and the reviewer prompt, whose
    `refuted` verdict is held to this grammar and was never told what it is.
  - **The trap is behavioural, not textual.** `test/src-grammar.test.ts` pushes every documented
    `bad` back through `diagnoseSrcToken` and every `good` through `parseSrcToken`. Loosen a regex
    without updating its rule and the suite goes red; a doc that has stopped being true cannot ship
    quietly. It caught one bug on its first run: `RegExp.source` re-escapes non-ASCII, so
    `CMD_RE.source` spells the arrow as a `\u`-escape — the contract would have documented "use the
    real `→`" with the arrow itself written as an escape sequence. `readableSource` decodes it.
  - Not changed: what the parser ACCEPTS. Tolerating `->` is a product decision and stays open
    as #77's item 3.
- **A grammar-rejected review envelope no longer consumes a story ATTEMPT (#78).** Measured on run
  `260830-ordering-inventory` (2026-09-01): stories S2, S3 and S5 each recorded
  `check: review · verdict: changes · attempt: 1` over a summary beginning *"I would sign this:
  every named acceptance criterion is met"*. Those were `fixlist` envelopes refused by the
  **claim-sources** check — a `refuted` finding whose `[src: …]` sat mid-line, where §2.8's
  end-anchored parser cannot see it — and each was charged to the story as a failure of its WORK.
  Three of the run's attempts went on formatting. A malformed envelope is a fault in the reviewer's
  *report*; conflating the instrument with the result is what this fixes.
  - **The framework asks again, for free.** A refusal the claim-sources check raised re-prompts the
    same reviewer for a corrected envelope, carrying what was refused verbatim under
    `## Your previous envelope was REFUSED`. **Bounded at two** per envelope round (owner decision,
    2026-09-01): the third refusal is recorded as the ordinary `changes` and costs the attempt, so a
    reviewer that cannot write the grammar at all still settles instead of looping free. The bound
    resets when a verdict is finally counted — it is per envelope round, not per story.
  - **Both doors, one rule.** A spawned reviewer re-prompts itself in-process;
    `tldrx next --commit --review` leaves the bundle out with the refusal spliced into its
    `prompt.md`, bins the refused `result.json` and settles nothing. Attempt accounting must not
    depend on which door a verdict came through, so both go through the same predicate.
  - **Auditable, because it is bookkeeping.** Each free round appends one `story.review_retried`
    (§2.9) carrying the story, the attempt it did **not** spend, which retry it was, the bound, and
    the refusal. `readReviewLedger` counts them, which is how the bound survives a fresh
    `tldrx next` and the one-envelope-per-process host handshake alike. Each re-prompt is a real
    metered turn and gets its own task row: it costs the story no attempt, never no money.
  - **Scope guard, pinned by test.** Only the claim-sources grammar — *widened to every
    envelope-FORMAT refusal by #79 below, in the same release.* A verdict's CONTENT and a red DoD
    keep exactly the cost they had.
  - **The message is #77's, inherited rather than copied.** The re-prompt carries the refusals
    verbatim and points at the `Citation grammar` section #77 splices into the
    same prompt, so the reviewer is told which rule it broke, on which line, with a corrected
    example — and there is no second copy of the grammar to keep in step. The classifier
    is a typed INDEX over `problems`, not a second list, precisely so #78 could not end up
    string-matching the text #77 was rewriting.

- **Every envelope-FORMAT refusal gets that same free round, not just the citation (#79).** #78 drew
  its scope at the claim-sources check because that is what the evidence named, and filed the rest.
  But `parseFixFindings` refuses an envelope for five other shapes — a `fixlist` that is missing,
  not an array or empty; a row that is not an object; a row with no `finding` text; a row with no
  valid `disposition` — and `parseReview` refuses a sixth, a verdict WORD outside the enum (#36).
  Every one of them is a fault in how the reviewer wrote its *report*, exactly the argument #78 made,
  and every one of them still cost the story an attempt. Owner decision (2026-09-01, on the issue):
  all of it, **one mental model — FORM never costs an attempt, CONTENT/WORK always does.**
  - **Nothing about the mechanism changed.** Same bound (two per envelope round, the third is the
    ordinary `changes`), same counter, same `story.review_retried` event, same two doors, same
    per-turn metering. #79 widened *what earns a correction* and touched nothing else.
  - **The verdict WORD (#36) is now free too, and #36's message is unchanged.** A reviewer that
    writes `sign` — the gate vocabulary — said nothing wrong about the diff; it reached for a word
    the story enum does not have. It is told so, by name, and asked again. `Review.formatProblems`
    is the union of the fix-list index and that verdict fault, because it is also what the corrected
    envelope's prompt is rendered from: a refusal missing from it is one the reviewer is never told
    about.
  - **The guard is the INDEX, which is what survives the next widening.** `ParsedFixlist.format`
    stays a typed subset of `problems`, built one push site at a time through a single
    `refuseFormat` helper — never a second list of strings, and never "everything `parseFixFindings`
    said". The free round is granted only when the index claims **every** reason the envelope was
    refused, so a refusal about the WORK added later costs the attempt until somebody deliberately
    indexes it as form. Defaulting to *costs* is the direction a mistake is recoverable in.
  - **A non-empty `findings[]` is deliberately NOT the content signal**, though it is the obvious
    candidate. Measured across the nine `aparece-v2` runs (2026-09-01): all 25 recorded review logs
    carry a non-empty `findings[]` and all 25 are `approve` — the one verdict whose own prompt line
    says *"Empty on `approve`"*. Reviewers use it as a narrative evidence log whatever the verdict,
    so gating on it would have made the free round almost never fire and quietly narrowed #78 as
    well. A judgement about the work is caught where it is actually stated: a declared `changes`
    raises no format refusal at all, so it costs its attempt.
  - **Nine tests red first**, each newly-free class proven to re-prompt without spending an attempt
    and to record the event, plus the bound re-proven on a shape refusal. #78's CONTENT and DoD pins
    are unchanged and still green.

- **`merge-wave.sh` no longer leaves a conflicted tree behind, wedging every queued sibling (#76).**
  On a merge conflict the script exited `2` **without** `git merge --abort`, and the `EXIT` trap
  then released the lock. The conflicted index survived that handover, so the next queued
  invocation acquired the lock, failed its dirty-tree guard and exited `1` `FAIL dirty tree` having
  merged nothing — and so did every one after it, until a human ran the abort by hand. Observed
  live 2026-09-01 by two agents: a sibling's abandoned merge left `UU CHANGELOG.md` plus 14 staged
  paths in the shared checkout, and cluster L's first merge-wave returned `1` with nothing merged.
  Under the concurrent multi-cluster pattern, one conflict wedged every other cluster.
  - **Collect, then abort** — the order `mergeNoFf` already uses one directory over
    (`src/core/build/git.ts:314-326`). The agent still learns exactly which files conflicted and
    still has to rebase and retry; the checkout it hands back is the one it was given. This is the
    same class of hazard the lock was written for: state from one invocation leaking into the next.
  - **The refusal now names what is dirty.** `FAIL dirty tree` alone accused the caller of leaving
    junk in their own checkout when, inside the lock, the likeliest cause is another run's residue
    in the shared one. It now says so and lists the paths.
  - Proved by a repro that runs the real script against a real conflicting merge and asserts
    `git status --porcelain` is empty afterwards, `MERGE_HEAD` is gone, `HEAD` has not moved, the
    lock is released, and a second invocation merges instead of being refused.

- **The built-CLI dashboard test no longer gates a stale `dist/` (#73).** `beforeAll` read
  `if (existsSync(DIST)) return`, so the tests ran against whatever `dist/tldrx.js` happened to be
  lying around — locally, a build from before the working-tree changes the run was checking.
  Measured 2026-09-01 while fixing #60: the guard served a binary built at 14:43, and the model
  version assertion read `Expected: 3, Received: 2`. That is the lucky direction; the same staleness
  hiding a regression is silent, and `bun run build` is a separate later step in both
  `scripts/merge-wave.sh` and CI. CI was safe only by accident — a fresh checkout has no `dist/` —
  which means the guard only ever applied where it did harm.
  - **Always rebuild, and the number is the reason.** `bun scripts/build.ts` costs 199 ms cold and
    55–59 ms warm on the reference machine (3 runs, 2026-09-01) against a ~420 s suite: under 0.05%.
    A stamp of `src/` would cost more to keep honest than it saves, and `test/build.test.ts:78`
    already built unconditionally — this file was the exception.
  - A new assertion pins the property rather than the mechanism: `dist/tldrx.js` may not predate the
    newest file under `src/`, `scripts/build.ts` or `package.json`.

- **`tldrx drive` fills the mandate's `<run>` in (#75).** The mandate's every command read
  `tldrx next --prepare <run>`, and the header told the reader to find-replace — 7 occurrences
  unattended, 5 attended (measured; the issue estimated ~8), by hand, at the exact moment somebody
  is trying to start a run. One occurrence missed sends a session at the wrong run.
  - **An id, or the one open run.** `tldrx drive --unattended <run>` or `--run <id>` (the positional
    wins, `ship`'s order) substitutes **textually and never validates** — an id naming no run is the
    operator's typo to notice, and the command stays the one thing in the CLI that runs anywhere.
    With no id, the ONE open run of the current workspace is used.
  - **It refuses to guess between two.** Where `RunStore.resolve` would call it ambiguous, drive
    declines to substitute, leaves `<run>` standing and names the ids on stderr — a mandate silently
    aimed at the wrong run is the bug being fixed, not a smaller version of it. No workspace, no
    runs, an unreadable `tldrx-work/`: all keep the placeholder and still exit `0`.

- **`tldrx status` no longer calls a RUNNING run "cannot start yet" (#60).** Verbatim from
  aparece-v2, 2026-09-01: `run 260830-ordering-inventory (…) cannot start yet — it was proposed to
  follow money-and-payments` / `at 04-build / build · run status running · waiting: prepared` /
  `blocked by money-and-payments — it is pending`. The run was building, with S1 verified minutes
  earlier. `triage.depends_on` is an order a split PROPOSED before either run existed, and it was
  out-ranking what the run was observably doing.
  - **Observed state outranks proposed order.** One rule, in the resolver both screens read
    (`src/core/run/dependencies.ts`): a run that has left `pending` has started, and a proposal
    cannot un-start it. `hasStarted` is the one definition — `pending` is the only status a run that
    has never run a stage can wear, because runs are created with every stage `pending` and every
    path to any other value goes through a stage that was `running`.
  - **The proposal becomes a footnote, not the headline.** A started run renders its own cursor and
    waiting kind, gains back the command it was denied, and carries
    `proposed to follow <run> — started anyway` as a secondary line. `blocked by` is now reserved
    for a run that really cannot move — one that has not started. A run that has NOT started is
    unchanged: same words, same withheld command.
  - **It gets the `← next` slot back.** The ordering hint had demoted the only run with work in
    flight and pointed the owner at the sibling that had not begun. `runnable` is now
    `movable && (started || nothing outstanding)`.
  - **`prepared` and `running` get their own summary lines.** Both used to fall through to
    "is blocked at <phase>/<stage>" — the same wrong word, one layer down.
  - **The dashboard was making the identical claim** about the same shape and is fixed with it:
    fixture run `charlie` is `awaiting_gate` behind a `pending` sibling, and the page said
    "blocked by bravo" while suppressing the gate alert for a signature a person could give right
    then. `DASHBOARD_MODEL_VERSION` → **3**: `blockedBy` is unchanged and still records the
    proposal, the new `runs[].started` says whether it still holds anything back, and `runnable`
    reads `true` for that one shape where it read `false`.

- **A cost/token declaration on a story commit now attaches to the build task (#68).** Measured on
  two live runs: the leaderboard host declared $2.25 on a story commit and `tldrx cost` kept
  04-build at $0.00 — "the declaration didn't attach to the build task the way it did for
  what/how/plan" — and ordering 260830 showed the same shape. The run's recorded build spend was a
  floor, budget arithmetic ran blind on the most expensive phase, and ~8M host tokens were invisible.
  - **The seam, not the accounting.** `ExecutorContext` never carried `--cost-usd`/`--tokens`, so
    Build's `commit()` could only read the envelope's own `cost_usd` and wrote
    `round2(result.cost_usd ?? 0)` — a METERED `$0.00`. It now resolves
    `options.costUsd ?? result.cost_usd`, which is exactly what `commitStage` does for what/how/plan,
    and the declared tokens ride onto the task row and the `agent.result` payload the cost report
    reads. The reviewer half (`--commit --review`) takes the same precedence.
  - **Nothing declared is UNMETERED, not $0.00.** `cost_usd: null` + `metered: false`, the spelling
    every other host turn already gets, because `$0.00` is a measurement and a false one.
  - **Backward-safe.** A declaration is never allowed to overwrite a measurement — an envelope that
    reports its own cost still wins over nothing declared — and no recorded zero is rewritten. Only
    new declarations attach.

- **`onStderrLine` on the runtime seam, so progress prints before the verdict it produced (#67).**
  `SpawnOptions` had `onStdoutLine` and nothing for the other stream, so stderr — where every tldrx
  UI writes its progress — could only be handed back as one string at exit. `tldrx learn` printed
  `01-what/what done — $0.31 of $4.00` and only THEN the `[00:00] writing …` lines that produced it.
  - Implemented in **both** `bunRuntime.ts` and `nodeRuntime.ts`, with the same contract
    `onStdoutLine` already has: the full text still accumulates in `SpawnResult.stderr`, a trailing
    partial line is delivered at close, and omitting the callback leaves the buffered path
    byte-for-byte as it was. Node gets its own `LineSplitter` per stream — one shared buffer would
    splice a half-written stdout line onto the front of a stderr line.
  - **The learn workaround is deleted**, per the instructions it carried since phase 1:
    `realStepRunner` passes the callback and `playChapter` no longer writes `result.stderr` after the
    step. Measured by playing chapter 2 by hand on both checkouts: the summary was at line 107 with
    its progress lines at 109-124, and is now at 123 with them at 105-121.
  - The tests turn on TIMING, not content: a buffered implementation could hand the same lines to the
    same callback by splitting at exit, so the line is required to arrive while the spawn's promise
    is still pending.

- **`tldrx plan` has a section in the CLI reference (#55).** `docs/guide/08-cli-reference.md` had no
  `## tldrx plan` heading at all, so `sync-dod` — the one mechanical repair for stories whose dod
  block a `workspace.yml` edit orphaned — was undocumented. The section states the four per-line
  outcomes, the git-history ancestry, the `.md.bak`, and that it runs no agent and moves no cursor.
  The #54 docs-coverage test is widened from `run` to `run` and `plan`, and now also asserts the
  heading rather than a passing mention. It is still a scoped list rather than a generalisation over
  every command: `hook`'s seven scripts are a deliberate spelling, and `note` and `ship` have the
  same gap #55 was about (filed separately).

- **`tldrx update`, and a one-line notice when a newer version exists (#62, owner decision
  2026-09-01: on by default, with an opt-out).** The owner installed 0.4.0 on a second machine and
  found there was no way to ask the tool to update itself, and no way to be told a newer one existed.
  - **`tldrx update` is `npm i -g tldr-experts@latest`, run for you**, plus the part a wrapper does
    not give you: the CHANGELOG between the version you had and the version you now have.
  - **The new version is READ BACK from what npm installed** —
    `$(npm root -g)/tldr-experts/package.json`, with the delta taken from the `CHANGELOG.md` beside
    it. The process printing that line is the OLD build and cannot know what the new one is; when the
    read-back fails it says so and prints no changelog rather than inventing one.
  - **The notice never touches the network on the hot path.** A command reads
    `~/.tldrx/version-check.json` and nothing else. The registry call happens in a DETACHED child
    (`stdio: "ignore"`, `unref()`) spawned after the output is written, and its answer is for the
    NEXT invocation. Cached for 24 h; silent on any network failure, on a body that is not the JSON
    it asked for, and on a home directory it cannot write.
  - **Never in `--json`, never during a hook, never off a terminal.** `tldrx hook` and
    `tldrx statusline` are suppressed by name (spec §0: a hook is deterministic), `--json` anywhere
    in argv is suppressed, a non-TTY stdout is suppressed, and so is CI. The line itself goes to
    stderr, so no command's stdout changes shape.
  - One line, in the issue's own wording: `tldr-experts 0.5.0 available (you have 0.4.0) — tldrx
    update`. Asserted as an exact string, because "roughly this sentence" is how one line becomes
    three.
  - **Opt out** with `TLDRX_UPDATE_CHECK=off` for a shell (spelled like `TLDRX_UI` and
    `TLDRX_CLAUDE_BIN`; `0`, `false`, `no` and `never` also work), or `update_check: off` in
    `~/.tldrx/config.yml` for the machine. A config file that does not parse is not an opt-out and
    not a crash.

- **`budget.yml` no longer adds host tokens to dollars (#61, owner decision 2026-09-01).**
  `validateRunBudget` summed EVERY phase ceiling and compared the total to `ceiling_usd` — but since
  the `economy:` label landed, a phase priced in `host-tokens` carries a host-session token allowance
  and not money. A realistic allowance therefore made a valid file invalid
  (`phase ceilings sum to 200018 > ceiling_usd 25`), and it did so in the one check that fails
  **closed**: `RunStore.open` threw, and the budget-gate hook then denied every spawn on the run.
  - **Separate ceilings, per economy.** `ceiling_usd` stays dollars-only and a new optional
    `ceiling_host_tokens` — at the run level and per phase — is the host-token allowance. The two are
    never added and never converted: there is no exchange rate here, and inventing one would be a
    guess about a price, which is the whole reason the label exists.
  - **The sum runs once per economy.** Σ the `metered-usd` phases against `ceiling_usd`; Σ the
    `host-tokens` phases against `ceiling_host_tokens`. The dollar half is byte-identical arithmetic
    with the same refusal in the same words.
  - **Additive, and absence changes nothing.** With no `ceiling_host_tokens` declared, the token sum
    has nothing to compare against and is not checked — deliberately the lax side, since the only
    other number on the run is dollars. The compat bar is the live `260830-ordering-inventory`
    budget.yml, mid-Build in another workspace while this was written and asserted verbatim in
    `test/economy.test.ts`: it validates, its phase sum of exactly 62.00 against a 62.00 ceiling still
    passes, one cent more is still refused in the same words, and every phase still reads
    `metered-usd` with no token ceiling.
  - `hostTokenCeiling` (f353d8d, #22b) prefers the new field and **still falls back to `ceiling_usd`**,
    because the files written before it existed put the allowance in that one unlabelled scalar and
    they are still on disk. The emitter round-trips both, so `budget raise` cannot erase a token
    ceiling it rewrites past.
  - The workaround the issue documented is gone: `test/hooks.test.ts` and `test/economy.test.ts` no
    longer raise the run ceiling to `60000`/`100000` — dollar figures that meant nothing — to let a
    token phase validate.
  - **`RunStore.ceilingsToWrite` now carries a phase's `economy` and `ceiling_host_tokens` from disk**
    beside its `ceiling_usd`. That seam re-reads CEILINGS before every save so a raise landing
    mid-stage is not clobbered by the copy the process opened with — and a phase's ceiling is three
    fields, not one. Preserving the number without the label would have been the worse half of both:
    a token allowance kept on a phase this reader had been told is priced in dollars, where
    `hostTokenCeiling` can no longer see it. For a file with no labels and no token ceilings — every
    budget.yml on disk today, the live one included — all three are identical on both sides and the
    save writes exactly what it always wrote.

### Removed

- **`templates/story.md` and `templates/epic.md` are deleted (#48, owner decision 2026-09-01,
  option (a)).** They stated the Plan front-matter schema, shipped in the npm package, and
  `grep -rn 'story\.md' src/` found nothing that read either one. Since 3ae0ce9 the live copy is
  generated: `src/core/plan/schemaContract.ts` builds the story, the epic and `waves.yml` from
  `STORY_KEYS` / `EPIC_KEYS` / `PLAN_STATUSES` / the `MAX_*` constants and splices them into the Plan
  prompt. The drift guard 7ac298c added held the two files to that contract; deleting them removes
  the second copy instead of maintaining it.
  - **The consumers were tests, and they now generate.** `test/plan.test.ts` and
    `test/plan-schema-contract.test.ts` were the only readers; both take the story and the epic from
    `planContractExamples()`. Nothing in `src/`, `stages/`, `workflows/`, `plugin/` or `docs/` read
    either file, and `run new` never copied them.
  - **`templates` stays in `package.json` → `files`.** The directory still ships eleven templates
    that ARE read at runtime — `templates/expert.md` and `templates/experts/<role>.md` are read by
    `createExpert.ts` and `roleExperts.ts` in an installed package — so removing the entry would
    break `tldrx expert create` to delete two files that no longer exist.
  - **The drift guard changed meaning and kept its teeth.** It now asserts the GENERATED story and
    epic validate through `validateStoryFile` / `validateEpicFile` with keys equal to `STORY_KEYS` /
    `EPIC_KEYS` in order, that neither file is back on disk, and that no OTHER shipped template has
    grown the same front matter under a new name. Proven, not assumed: setting the example's
    `status:` to `wip` turns 4 tests red, and renaming `test_plan` in the generator turns 6 red.

## 0.4.0 — 2026-09-01

### Changed

- **Dependent epics share ONE integration branch (#57, owner decision 2026-09-01, option (a)).**
  One-branch-per-epic assumes the epics are independent. Run `260829-scoring-leaderboard` planned
  E2 (the API) with E3 and E4 (mobile) consuming it, and a downstream story's base — cut from its
  own epic branch, itself cut from `main` — could not see the upstream epic's merged work. It broke
  twice, and both times the host fast-forwarded the EPIC branches by hand: cross-epic surgery done
  with a feature built for stale STORY bases (design §F.2), which collapses branches the owner may
  have meant to merge separately. A run whose epics form a dependency chain now cuts a single
  integration branch and the epics become labels.
  - **Detected at PLAN time, from what the plan already says.** A story whose `depends_on` names a
    story in another epic IS the chain. `validatePlan` reports the cross-epic edges it read
    (`PlanReport.epicChain`, deduplicated per epic pair), and the `plan` gate check states the branch
    model in its passing detail — `epics form a chain (E3→E2, E4→E2) → single integration branch
    \`epic/<run-id>\`` or `independent epics → one branch each`. The owner never discovers it
    mid-Build, which is the half of #57 that was not about branches at all.
  - **`epic/<run-id>`, not a new namespace.** `EPIC_BRANCH_RE`, `watch`'s feature-slug extraction,
    `ship`, `boundary` and the `--reuse-epic` guard are all keyed on the `epic/` prefix; an
    `integration/…` branch would have changed every one of them to buy a word. The run id IS in the
    name — unlike an ordinary epic branch, which is deliberately unscoped because an epic is the unit
    a team merges — because an integration branch belongs to one run by definition.
  - **One run-scoped epic worktree**, `_epic-<run>-integration`, because git will not check one branch
    out in two worktrees. It is picked up by the `_epic-<run>-` prefix that the §2.8 src resolver and
    the run-close cleanup (#16) already enumerate, so the lifetime decision from that change holds.
  - **Backward-safe by an ABSENT key.** The Build executor records what it used in `run.yml`
    (`build.branch_model: per-epic | integration`, additive and optional). A run.yml that names
    branches and no model predates the key — the three closed runs, and any run mid-flight — and stays
    `per-epic`, so it resumes on the branches it already cut rather than being re-pointed at one that
    was never cut. A model, once written, is never rewritten.
  - **Nothing else moved.** The dirty-tree refusal, the foreign-epic refusal and `--reuse-epic`, the
    gated HEAD, `git merge --no-ff` into the epic worktree, and the story-base fast-forward all behave
    exactly as before; only WHICH branch they name changes. `tldrx ship` needed no change: a chained
    run claims one branch, so it opens one PR with no `--branch`, and an unchained multi-epic run still
    asks which.
  - The acceptance test is the leaderboard shape, passing: S1 in E1 writes a file, S2 in E2 depends on
    it, and S2's worktree holds that file with **no `story.base_fastforwarded` event** — the base was
    right when the developer was dispatched, not repaired afterwards. Red before the change (`Expected:
    true, Received: false`).

- **An epic worktree now lives for the RUN's lifetime, not the Build stage's (#16, owner decision
  2026-09-01, option (a)).** The shipped half of #16 made a `file` src resolve against
  `.tldrx/worktrees/<repo>/_epic-<run>-<epic>` before the working tree — and then `BuildSession.finish()`
  removed that directory before the Build handoff was even written, so unless the operator had typed
  `--keep-worktrees` a later Watch stage had nothing to resolve against and the fix bit only under a flag.
  Cleanup moves to run CLOSE, which is what the checkout actually belongs to.
  - **Watch citing epic-only code works by default.** Proved end to end rather than by construction:
    `test/build-executor.test.ts` runs the real pipeline, then resolves a `[src: app:s1.txt:1]` against a
    file the test first shows is committed on `epic/e1` and absent from the working tree.
  - **Every close path takes them**, because a run does not only close one way: `tldrx next` closing the
    last stage, `tldrx approve` signing the last gate, and `tldrx run cancel`. Without the last two the
    change would have traded one leak for another — a cancelled run's checkouts used to be gone already,
    because Build removed them on the way past.
  - **`--keep-worktrees` keeps its meaning, one scope wider**: survive even the run close. It is
    remembered on the run as `keep_worktrees:` (additive and optional; absent means clean up, which is
    what every existing run.yml meant) because the flag is typed on the `tldrx next` that BUILDS and the
    run is usually closed by a different command in a different process.
  - Story worktrees are untouched: still removed the moment a story reaches `done` or `blocked`.

- **The budget gate's three open policy questions are answered (#22, owner decision 2026-09-01).**
  bb6204b wired the DATA — both economies, `attended_by`, `runSpend` — and deliberately changed no
  verdict. These are the verdicts.
  - **(a) An `attended_by: host` run is INFORMED, never DENIED, on metered dollars.** `tldrx next` on
    such a run spawns nothing, so the estimate the gate was refusing against is spend that provably will
    not happen. Both the PreToolUse hook and `tldrx next`'s own brake now say every number they would
    have refused with, plus both economies, and allow. The event is `budget.warned`, not `budget.blocked`:
    nothing was blocked, and recording a block that did not happen is the exact failure #22 was filed
    about.
  - **(b) A `host-tokens` ceiling is soft-enforced.** Under that economy the ceiling NUMBER is a
    host-session token allowance, so accumulated declared `tokens:` against it is the one comparison in
    the gate whose two sides share a unit. Crossing it WARNS and still allows. It stops only under the
    explicit opt-in **`on_host_tokens_exceed: block`** in `budget.yml` — an enum beside `on_exceed`,
    defaulting to `warn`, so every file written before the key existed keeps the behaviour it had. The
    refusal never offers `tldrx budget raise`, which moves dollars and would send the operator at the
    wrong number. (a) beats (b): the opt-in still never denies an attended run.
  - **(c) `remainingWork` zeroes the developer share on an attended run**, mirroring `economy:
    host-tokens`, because it is the same fact — the host session pays for those turns. Attendedness and
    the phase economy were independent, so an attended run on a `metered-usd` phase still counted
    developer turns against money this framework will never spend, on the brake and in `run estimate`
    alike. Reviewer floors are untouched in both cases.

### Added

- **The documentation site speaks Spanish (`docs-site/es/`, phase 2).** All twelve English pages are
  now mirrored under `/es/` at the same paths and translated into es-MX developer Spanish, and
  `locales.es.themeConfig` carries the Spanish sidebar, nav, edit link and page chrome (outline,
  prev/next, search modal, footer) rather than English chrome around Spanish prose. The placeholder
  that phase 1 left at `/es/` is replaced by the translated landing page.
  - **tldrx's own vocabulary stays in English where it is an identifier.** The stage names
    (`What → How → Plan → Build → Watch`), `run`, `story`, `DoD`, `scope`, `handoff` and `workspace`
    are the things you type or the files on disk, so they are not translated; each is glossed once in
    Spanish where it first appears. `gate` is the one exception — it renders as **compuerta**, because
    the phase-1 placeholder had already shipped that word to the live site.
  - **Code blocks and command output are verbatim English** — a translated transcript would be a
    transcript of a command nobody ran. The narration around them is translated.
  - **Anchors were verified against the rendered HTML, not assumed**, because dead-link checking does
    not see them. That mattered here: VitePress's slugifier strips accents but *keeps* `¿`, so
    `## ¿Cómo lo detengo?` becomes `id="¿como-lo-detengo"`. The one heading that is linked to carries
    an explicit `{#puedo-manejarlo-desde-claude-code}`. A sweep of the built site resolves all 5
    anchor links across its 26 pages, 0 broken.
  - **Release notes are deliberately not translated**: the page is generated from `CHANGELOG.md` at
    build time, so a Spanish copy would drift. The `/es/` sidebar links the English page and says so.

- **A public documentation site, written for people who have never seen tldrx (`docs-site/`, phase 1).**
  A VitePress site deployed to GitHub Pages by `.github/workflows/docs.yml` on any push to `main` that
  touches `docs-site/` or `CHANGELOG.md`. Twelve short English pages — a landing page, a Quickstart, one
  page per concept (the five stages, files-as-state, gates, evidence, budgets), four guides and a
  condensed CLI overview — plus a generated changelog and a Spanish placeholder. None of them is pasted
  from `docs/`, which stays the agent-facing reference. Every command
  and every block of output on the Quickstart was produced by running the real binary; nothing on the
  site documents a flag that `--help` does not.
  - **The changelog page is generated, never copied.** `docs-site/scripts/gen-changelog.ts` reads this
    file at build time and emits one line per entry, so a release note reaches the website without
    anybody maintaining a second copy of it. The generated page is gitignored for the same reason.
  - VitePress dead-link checking is left ON and the build is green with it — proven by a probe, not
    assumed: a deliberate link to a missing page failed the build with `1 dead link(s) found`. (Anchors
    are NOT checked by it, so `#fragment` targets were verified against the rendered HTML by hand.)
  - i18n is wired now, with the English content at the root and a Spanish placeholder under `/es/`, so
    phase 2 is a matter of adding files rather than restructuring the site.
  - `docs-site/` is excluded from the npm package (it is not in `files:`) and from `tsc --noEmit` (the
    root tsconfig includes only `bin`, `src`, `test`) — measured: `npm pack --dry-run` still lists 52
    files and none of them is under `docs-site/`.

- **`tldrx learn` chapters 3-8 — the whole loop, played (#30, phase 2).** The tutorial now runs end to
  end in about five seconds of real commands: **3** the gate (`approve --note`, and the record it writes
  in `run.yml`), **4** one story built for real (How's `auto` gate closing itself over its seven
  conditions, Plan's human gate, then a Build that cuts `epic/bulk-pricing`, spawns a developer in a
  worktree, re-runs the story's `npm run test` DoD, commits, merges and spawns a reviewer), **5** a
  genuinely red DoD and the three commands back from it (`story reopen`, `reject`, `budget raise`),
  **6** an `agent` gate closed by `approve --as-agent` over a structured evidence note, **7**
  `run attend host`, the refusal a bare `next` then gives, and the `next --prepare` / `next --commit`
  pair actually run, **8** `cost --all`, `run estimate`, and the budget brake refusing a stage the
  phase can no longer afford.
  - Chapter 4's DoD is real, chapter 5's failure is real: the story's test script is `exit 0` until a
    developer replaces it with a `node` test that then catches a wrong number — so the tutorial teaches
    "a green DoD over an empty test proves nothing" by letting it happen rather than by saying it.
  - Chapter 5 opens a second run, so `{run}` and `{runDir}` now expand in a step's `command` as well as
    in a turn's writes, and mean **the newest run that is still open** — the same set `resolveRun` picks
    from, so the placeholder and the CLI cannot disagree about which run a command means.
  - Chapter 4's `prepare()` commits what `init` left untracked, because the Build executor refuses to
    cut a branch from a dirty tree (measured: `?? .gitignore, ?? CLAUDE.md`, exit 2) — and the narration
    teaches that refusal instead of hiding it.
  - **Fixed: the toy repo now carries its own git identity.** Chapter 4's Build commits through the
    framework's own executor, with whatever identity the machine has — so on a box with no global
    `user.email` (a fresh laptop, a container, `ubuntu-latest`) `git commit` failed with `Author identity
    unknown` and the chapter died three commands in. `makeSandbox` writes `user.email`, `user.name` and
    `commit.gpgsign=false` into the sandbox repo's own config, on every open, so an older sandbox is
    repaired too. The test pins it with `user.useConfigOnly` rather than an empty global config: git
    guesses an identity from gecos and hostname and only fails where it cannot, so an empty config
    passes on a laptop and fails in a container — which is exactly how this reached CI.

- **`tldrx learn` — a playable sandbox tutorial that runs the REAL commands (#30, phase 1 of 3).**
  A tutorial that runs the shipped binary can never drift from the shipped behaviour: every output the
  learner reads is produced by the code, not written down by a doc author. `tldrx learn` scaffolds a
  throwaway workspace (a four-file git repo with a `test` script that exits 0), then narrates, shows the
  exact command, waits for Enter and RUNS it — `tldrx init`, `run new`, `next`, `answer` are the real
  ones, against that sandbox.
  - **Chapters 1 and 2 ship playable**: init (read the `workspace.yml` detection actually produced) and
    the What stage (a question comes back, `tldrx answer` records it, it becomes `F001` in
    `.tldrx/memory/facts.yml`). Chapters 3-8 from the issue are phase 2 and are DATA plus one
    `assert()` — see the contract in `src/core/learn/Chapter.ts`.
  - **It cannot spend money, by construction rather than by convention.** The sandbox writes its own
    `claude` stand-in, names it in `TLDRX_CLAUDE_BIN` and puts it first on the child `PATH`, so neither
    the spawn seam nor a bare `claude` on `PATH` can reach the real CLI. `test/learn.test.ts` proves it
    the only way worth proving: it plants a booby-trapped `claude` that writes a marker file, plays both
    chapters, and asserts the marker is absent AND the chapters completed — because a tutorial that
    spawned nothing would pass a marker check for the wrong reason.
  - **It cannot touch your work.** Everything is written under the sandbox directory (`~/.tldrx-learn`
    by default, `--sandbox` to move it), and a sandbox that would sit inside a real tldrx workspace is
    refused before a byte is written.
  - **Files as state, like everything else**: `progress.json` in the sandbox is what makes a bare
    `tldrx learn` resume, `--chapter <n>` jump (playing an unfinished prerequisite first), and `--reset`
    start over. With no terminal on stdin the chapters play straight through rather than hanging at the
    first prompt.
  - The stand-in agent is scripted per chapter and is **fail-closed**: a prompt no turn matches exits 1
    and names the turns it did have, so a hole in the tutorial is a loud failure rather than an
    improvised answer. The `stream-json` writer moved from `test/fixtures/fakeStream.ts` to
    `src/core/facilitator/fakeTranscript.ts` — beside `agentEvents.ts`, which reads that format — so the
    tutorial's stand-in and the four test fakes cannot drift apart. The fixture re-exports it.

- **`tldrx note <run> [--stage <id>] "text"` — an honest carrier for an operator annotation, at the
  moment it happened (#46).** Measured on `260829-scoring-leaderboard` (2026-09-01): a host performed an
  owner-delegated mechanical resync of eight story dod blocks, was asked to note it in the run log, and
  could not — `events.jsonl` is append-only and tool-owned, so the only carriers were a FUTURE gate note
  (late, and keyed to a decision the note is not about) or a `reject` (destructive). The session ended up
  hanging the context off an unrelated `story.reopened`.
  - **One event, and nothing else.** It appends a single `operator_note` line carrying actor, timestamp,
    optional stage and the text. It does not go through `RunStore.save()`, which would rewrite `updated_at`
    and re-derive every status for an annotation that changed no state: `test/operator-note.test.ts`
    compares `run.yml` and `budget.yml` **byte for byte** across the call, because "safe to reach for
    mid-run" is the whole of what makes the verb usable.
  - **Every refusal writes nothing.** An unknown run (exit 3), a stage this run does not have (exit 2), an
    empty note (exit 1) and a lone argument that turns out to name a run all refuse before the log is
    opened. The last one is the trap worth naming: `tldrx note 260829-x` is a half-typed command, not a
    note whose entire content is a run id, and recording it would be the one outcome nobody wanted.
  - **Visible afterwards.** `tldrx run status` prints the last three (with `tldrx replay` named when there
    are more), `--json` carries them as `operator_notes`, and `tldrx replay` narrates every one in place.

- **`tldrx run gates set <stage>:<policy> --note "…"` — the signed upgrade path for a frozen
  `gates_policy` (#14).** The policy is resolved at `run new` and frozen into `run.yml` by design, and that
  default is not taken back here. What it left with no door at all, found on the 2026-08-30/31 unattended
  pilots: a run created BEFORE the `agent` policy existed can never use `approve --as-agent`, and `run.yml`
  is hand-edit-forbidden (spec §1) — so the only move was to abandon the run.
  - **Built like `story reopen`, because it is the same kind of act:** a person overruling state the machine
    is holding. A `--note` is required; ONE stage per invocation (a list would let a second change ride on
    the first one's signature); the entry must be QUALIFIED, because under `--gates` a bare `plan` means
    `human` and a signature must not rest on a default; and a no-op is refused rather than recorded.
  - **One `gate.policy_changed` event** carries the phase, who signed it, the old and the new value, and the
    note. A run with no `gates_policy:` at all gets the FULL map written — every stage explicitly, with the
    one change applied — because a partial map would quietly claim its other stages had been decided too.
  - It changes who may CLOSE a gate from then on. Gates already signed are untouched, and nothing re-reads
    the policy of a closed one.

- **`tldrx ship` — open a PR from the run's epic branch, with the handoff as the body (#15).** The loop
  ended at "merge by hand": a finished epic sat on `epic/<slug>`, the document explaining it sat in
  `<run>/<phase>/handoff.md`, and nothing carried either one to a PR.
  - **It never pushes.** `core/build/git.ts` has no `git push` wrapper on purpose (spec §5), and this verb
    keeps that rule rather than being the exception to it: a branch the remote has not seen is a refusal
    that names the exact `git -C … push -u` command. Publishing a branch is a decision, and it stays the
    operator's.
  - **It never writes to the run** — no event, no gate, no cursor, no money — and it does not mirror
    tickets: `tldrx tickets sync` already is that verb, holds the `process.yml` contract and appends
    `ticket.synced`. A second, thinner mirror inside `ship` would give the workspace two answers to "is this
    story mirrored", so `ship` names it as the next step instead.
  - **Clean refusals, in a sentence:** no epic branch, no handoff, no `gh`, no remote, an unpushed branch,
    several epic branches with no `--branch`, a branch the run did not cut. The body goes to `gh` as
    `--body-file`, never as an argument, so a long handoff cannot overflow an argv limit.
  - Both external binaries go through one narrow transport that takes a cwd — the same idea as
    `adapters/transport.ts`, and the only way to ASSERT the argument shape of a command the suite must not
    run. The unit tests drive a recording fake; the one end-to-end test puts a STUB `gh` first on PATH in a
    throwaway workspace with a throwaway bare `origin`. The real `gh` is never invoked by a test.

- **`TLDRX_CLAUDE_BIN` — point the sub-agent spawn at a different binary (#27, minimal slice).**
  `spawnAgent` hardcoded `claude`, so a pinned install, a wrapper that adds a proxy or credentials,
  and a stand-in in a sandbox all required patching source. The variable replaces the executable
  NAME and nothing else — the argv is still Claude Code's, so what it points at has to speak
  `-p --output-format stream-json --json-schema` — and blank or whitespace counts as unset. Honoured
  everywhere the CLI is spawned: `spawnAgent`, the `--dry-run` command line (`describeSpawn`) and
  `claude mcp list` (`McpProbe`). `tldrx doctor` deliberately still checks `claude --version`,
  because `env.yml` declares that string. Documented under **Environment variables** in the CLI
  reference. This is not the provider abstraction #27 asks for; #27 stays open for it.

- **A drift guard on `templates/story.md` and `templates/epic.md` (#48).**
  Both ship in the npm package, both state the Plan front-matter schema, and **nothing in `src/`
  reads either one** — a second copy of a contract whose first copy is computed from `STORY_KEYS`
  and `EPIC_KEYS`. Add a required key and `schemaContract.ts` stops compiling while the templates
  say nothing; a human then opens one, writes a story the check refuses, and the framework looks
  broken. They now go through `validateStoryFile` / `validateEpicFile` — the very checks the stage
  gates on — with their key sets asserted equal to `STORY_KEYS` / `EPIC_KEYS` in order, and the
  status enum each spells out in a comment asserted equal to `PLAN_STATUSES`. Proven to have teeth:
  renaming one key and staling one enum comment turns three tests red. Whether the files should be
  generated or deleted is a packaging decision and is left open on #48.

- **The merge-wave sandbox is built under a hostile `init.defaultBranch` (#49).**
  `test/merge-wave.test.ts` names every repo `main`, and CI run 33459567355 failed in the test's
  own setup — `git push -q origin main` → `src refspec main does not match any` — on a runner whose
  default branch is not `main`. `f1ffe56` had already fixed it (`-b main` on both inits,
  `--branch main` on the clone), but nothing EXERCISED the fix: on a `main`-defaulting host,
  removing the treatment changes nothing. The sandbox now pins `init.defaultBranch: trunk` for
  every git command it builds itself with, the clone asserts it is on `main` rather than
  discovering it five lines later, and two tests pin the mechanism — untreated reproduces the CI
  error verbatim, treated does not.

- **The Plan prompt now STATES the schema the `plan` check enforces, generated from the check itself (#35, #38).**
  `stages/plan/stage.md` named the output filenames — `stories/<id>.md`, `epics/<epic>.md`, `waves.yml` — and
  said nothing about their shape, so a fresh agent learned it by having a paid attempt refused. Measured twice
  in two days: on `260831-hardening-d1` the plan sub-agent followed the rendered bundle faithfully and wrote
  seven stories as plain markdown (`no YAML front matter — the file must open with ---`), and on
  `260829-scoring-leaderboard` it wrote a 1,009-character acceptance item against a `MAX_ITEM_CHARS = 512`
  cap that appeared in no file it could read. Both attempts were consumed, correctly and uselessly.
  - **Generated, not copied.** `src/core/plan/schemaContract.ts` renders a `## Output schemas` section from
    `STORY_KEYS`, `EPIC_KEYS`, `PLAN_STATUSES` and the six `MAX_*` constants — the same definitions
    `validateStory`, `validateEpic` and `validateWaves` read. `Record<StoryKey, Field>` is load-bearing:
    add a key to a schema and the file stops compiling until the new key has a value and a rule. The worked
    examples it ships are run through `validatePlan` itself in the tests, so the contract the prompt states
    and the contract the check enforces are provably the same one. This repo already had the other kind:
    `templates/story.md` carries the schema correctly and `grep -rn 'story\.md' src/` finds nothing that
    reads it.
  - **Only where the check runs.** `applyCheckContracts` splices it under an H2 the framework owns, for a
    stage that declares `checks: [plan]` AND writes `waves.yml` — the same predicate `checkPlan` skips on,
    now shared (`writesPlanArtefacts`). A What or How prompt is byte-identical to before. It goes into
    `stage.md` rather than after the inputs because `prompt.ts` orders the document most-stable-first for
    the prompt cache, and a section computed from constants is exactly as stable as the stage body.
  - **~4.2 KB against a $4 stage.** The alternative it replaces is a refused attempt per fresh workspace.

- **`tldrx plan sync-dod` — the mechanical repair for dod blocks an edited `workspace.yml` orphaned (#42).**
  A story's ```dod block may only name commands `workspace.yml` declares, byte for byte, and that rule is not
  relaxed by a byte here — it is what stops a data file from running an arbitrary command as you. What it
  lacked was an inverse. Measured live 2026-08-31 on `260829-scoring-leaderboard`: fixing `workspace.yml`
  (a filtered `test:`, `lint:` deleted) instantly invalidated the dod blocks of **8 approved stories**, and
  the only recoveries were hand-editing agent-approved artefacts or re-running the whole Plan stage — a paid
  turn to change two lines in eight files, churning thirteen correct stories on the way.
  - **Evidence, not similarity.** The ancestry comes from git's history of `.tldrx/workspace.yml`: a line a
    previous version declared under a role the current file still has becomes that role's current command; a
    line whose role is gone is dropped; a line the current file already declares is left alone; and a line no
    version ever declared — or one two roles once shared and now disagree on — is **flagged, its story left
    byte-identical**, and the command exits `2`. Guessing at a rename by string shape is the one thing this
    must not do. In a workspace with no git history there are no ancestors, so everything non-current is
    flagged.
  - **It touches nothing else.** Front matter, prose, blank lines and the fences come back byte-identical;
    only the command lines inside the fence move. The previous version is kept at `<story>.md.bak`
    (`writeAtomic`), the summary is a per-story diff, `--dry-run` prints it and writes nothing, and the result
    is validated by the same plan check the drift came from. Stories that CAN be synced still are — one
    undecidable line is not a veto on the other seven files.
  - **The drift message now names the remedy.** "`<cmd>` is not one of .tldrx/workspace.yml's commands — a
    story may not invent one" gained a second sentence pointing at `tldrx plan sync-dod`. Only for a STORY:
    a stage's `cmd:` is a line a human wrote, and `sync-dod` does not touch stage files.

- **`tldrx answer <Qn> "…" --supersede` — the verb for reversing a decision already on record.**
  Found live 2026-08-31: an owner reversed an answered decision after the risk behind it was
  refuted, and `tldrx answer` refused ("Q1 is not an open question") because an answer is
  recorded once. `superseded_by` had been in the §2.5 schema since the first draft with **no
  command that wrote it**, so the only route was a hand edit of `facts.yml` — and a hand edit
  that left `superseded_by: null` left the reversed decision inside `FactsStore.active`, which
  every stage reads as never-re-ask truth. The next run would have reinstated the call the owner
  had just taken back.
  - **The verb.** Valid only on an ANSWERED question (on an open one it exits `1` and says to
    answer it normally; without the flag an answered one still exits `3`, now naming
    `--supersede`). It appends a new fact carrying the whole new answer with the same `area` and
    `repos` and ordinary provenance, sets the old fact's `superseded_by` and the new one's
    `supersedes` — both halves, through `FactsStore.supersede`, under the workspace lock, so the
    reciprocity rule cannot be broken — and never edits a byte of the old fact's text. Reversing
    twice supersedes the SECOND fact: the chain is walked to its head, so it stays single-link.
  - **The questions block is appended to, not rewritten.** The original `[Answer]:` line and its
    footer stand; a superseding answer line and a `reanswered_by | reanswered_at | fact |
    supersedes` footer go under them. `status:` stays `answered`, because it is.
  - **Every reader that feeds a decision now skips a superseded fact.** This was half the work
    and none of it was new code: `superseded_by` had a writer for the first time, and six readers
    had been filtering on retirement alone. `isLive` (`core/facts/Fact.ts`) is now the one
    predicate behind `FactsStore.active` (no-re-ask, `tldrx run new --from` de-duplication),
    `findDuplicate`, `renderFacts` (the `{{facts}}` section of **every** prepared prompt),
    `renderWatchFacts`, `runFacts` (the implicit plan's "this run's answers") and `relevantFacts`
    (the training miner). One test had pinned the old behaviour in words — "a
    superseded-but-not-retired row stays visible" — and that was the bug, not the rule.
  - **History readers still show it, labelled.** `tldrx replay` renders the new `fact.superseded`
    event as its own line — the one moment the workspace's durable memory changes its mind was
    the one moment replay could not narrate — and `tldrx retro` lists the old fact with
    `(superseded by F<n>)` beside it.

### Fixed

- **`tldrx learn` — the cold-player QA round (#30).** A first-time player played all eight chapters
  and returned SHIP-with-fixlist. Everything they found is fixed or recorded:
  - **Chapter 8 no longer lies about the brake.** It said "the phase has already spent its Watch
    money" while the tool printed `$1.89 left … estimate is $2.00`. The real mechanism is that a
    re-run is priced at the stage's WHOLE declared `budget_usd`, never at what a second attempt might
    add — so a stage that has spent anything can no longer afford itself. The chapter now says that,
    quotes both figures, and `assert()`s them against the `budget.blocked` event so the numbers cannot
    drift away from the sentence.
  - **Chapter 1 no longer promises something chapter 2 does not deliver.** `--no-interview` skips
    *init's* setup interview, which no chapter covers; the forward reference is gone and the debrief
    now sends the learner to `.tldrx/init-handoff.md`, where measured/inferred/assumed and
    `[src: …]` / `absent:` actually live.
  - **`tldrx learn --chapter <n>` refuses a chapter that is already played**, up front and by name,
    instead of narrating it and then dying mid-chapter on `run new: … already exists` (exit 1,
    measured). The refusal names `--reset` and the chapter a bare `learn` would resume at.
  - **The tutorial has a door out.** The ending now names the first four commands to type on a real
    repo — `tldrx init` (with the warning that it runs an interview by default), `run new --scope
    hotfix`, `next`, and `tldrx ship`.
  - **Chapter 7 RUNS `next --prepare` and `next --commit`** against the feature run's Watch stage
    instead of describing them in a debrief. Chapters 6 and 7 swapped for it: the attended chapter
    addresses the feature run through `{run}`, so the hotfix run has to be signed off first.
  - **Every non-zero exit code is printed** (`→ exit 4`), so the code chapter 2 teaches is a thing
    the learner reads rather than a thing they are told. Chapter 5 now also demonstrates the exit-2
    refusal a bare `next` gives with two runs open, and names the two run-id spellings.
  - Jargon defined at first use — expert, level 0, the `claim-sources` / `no-reask` / `budget-gate`
    bracket, `boundary`, `[src: …]`, `absent:`, economy, §2.11 — and the `expert … has no evidence`
    nudge explained once instead of repeating unexplained nine times.
  - Known and NOT fixed: a step's stderr (where the agent stream lives) is buffered and printed after
    its stdout, so a summary can appear before the stream that produced it. Interleaving needs an
    `onStderrLine` on the runtime seam and in both implementations; documented in `engine.ts`.

- **`tldrx cost` no longer claims "two economies" over one (#56).** The `(no total: two economies, no
  exchange rate)` footnote was unconditional, so a run whose every attempt was metered in dollars was
  told no total could be printed. It is printed only when both economies are actually present.

- **The README's "Not on npm yet" warning was false and told readers not to run the install line
  directly underneath it.** The package IS published: `npm view tldr-experts version` → `0.3.1`,
  exit 0. The warning is removed rather than re-dated — the npm badge at the top of the README
  already shows the live version, so nothing in its place can go stale the same way. The
  `npm i -g tldr-experts` line it was contradicting is unchanged.

- **The site's own home page linked an anchor that does not exist.** The hero's "Try it offline,
  free" button pointed at `/quickstart#try-the-whole-thing-first-for-free`, but the heading renders
  as `id="first-try-it-for-free"` — verified against the LIVE page, not just a local build. Dead-link
  checking never saw it because VitePress does not check fragments. Repointed, and a sweep of the
  built site now resolves every anchor link it emits.

- **`tickets sync`, `tickets status` and `budget show` took a run id as a positional that neither
  their `usage` nor their `--help` declared (#53).** Measured at `7ac298c`:
  `tldrx tickets status zzz-positional-probe` and `tldrx budget show zzz-positional-probe` both reach the
  run resolver and exit `3` with `no run 'zzz-positional-probe'`, so both forms have always been
  supported. The mechanism is the same in each: the subcommand word is consumed by the dispatcher
  (`tickets.ts:53`, `budget.ts:32`) before `stringFlag(args, "run") ?? args.positionals[0]` runs
  (`tickets.ts:246`, `budget.ts:48`), so `positionals[0]` is a run id by then.
  - **The capability is DECLARED, not removed.** `usage` now reads `tldrx tickets sync [<run>] …`,
    `tldrx tickets status [<run>] …` and `tldrx budget show [<run>] …`, and both help entries gain the
    `[<run>]` arg every other run-scoped command already carries. Nothing about what the CLI accepts
    changed.
  - **This is the axis #51's guard cannot see.** That guard compares the registry to the usage; here the
    registry itself was narrower than the code, and where both are silent both are green. The new check
    in `test/cli.test.ts` is a hand-written list — nothing derives a positional from source — but its
    BEHAVIOURAL half spawns the real CLI against a throwaway workspace, so it also goes red if the
    capability is ever removed, which is the direction a tidy-up of the arg parsing would break it in.

- **`tldrx run gates set` was documented nowhere in `docs/` (#54).** `grep -rn "gates set" docs/` returned
  nothing at `7ac298c`, so the CLI reference — the page a reader lands on from the README — described
  seven of `tldrx run`'s eight subcommands. It matters more than an ordinary docs gap because `gates set`
  is the ONLY sanctioned way to move a `gates_policy` that `run new` froze, and the situation it exists for
  (a run opened before the `agent` policy existed, which can otherwise never use `approve --as-agent`) is
  one an operator hits mid-run and searches the docs for. What they found was "abandon the run".
  - Documented in all three places the question gets asked from: the `tldrx run` usage block and a new
    prose entry in `docs/guide/08-cli-reference.md`; a **Moving a frozen policy** section in
    `docs/guide/03-runs-and-gates.md`, right under the paragraph that explains the freeze, with the
    `--gate-agent` disclaimer further down now linking to it; and `docs/spec.md`, both in §2.2's
    `gates_policy` row and as its own §CLI row (exits `0,1,2,3`, each measured).
  - Every copy carries the two facts a usage line cannot: **`--note` is mandatory**, and the change
    appends one **`gate.policy_changed`** event with the actor, the moment, the note and the old→new
    value — the whole audit trail for a mutation nobody would otherwise go looking for.
  - Guarded: `test/cli.test.ts` now asserts the CLI reference names every subcommand in
    `runCommand.subcommands`, plus `gate.policy_changed` by name. Scoped to `run` on purpose —
    `plan sync-dod` has no section on that page at all (a separate gap, unfiled), and `hook`'s seven
    scripts are deliberately documented as one `<script>` slot.

- **The epic file duplicated every story's status, and nothing ever updated the copy (#50).**
  Measured on `260829-scoring-leaderboard` (2026-09-01): `03-plan/epics/E1.md` listed S1, S2 and S3 as
  `todo` in its `## Stories` table while `03-plan/stories/S1.md` said `done` (merged at `0a50660`,
  `task.done` in `events.jsonl` at 23:46:11Z) and S2 said `in_progress`. Nothing had lied — nothing had
  written, either. Fixed by **removing the copy**, not by adding a second writer, and the repo already
  drew that line for the one field it does maintain: the epic's front-matter `status:` is DERIVED and
  written by `BuildExecutor.updateEpicStatus` (`build.ts:2552`) from the story files. A copy with a
  writer is a cache; a copy without one is a lie waiting to be read.
  - **Nothing parsed the table.** `validateEpicFile` is front matter only ("the front matter is the whole
    schema", `schemas/epic.ts:69`), `adapters/body.ts:50` mirrors an epic to a ticket as a bare list of
    ids with no status, and the dashboard reads the front matter. A writer would have been maintaining a
    document with no reader.
  - **Both copies of the shape are fixed, not just the visible one.** `templates/epic.md` now points at
    `03-plan/stories/<id>.md` instead of tabulating it, and the GENERATED contract the Plan sub-agent
    reads (`schemaContract.ts`, spliced into the stage prompt) now says "Do NOT restate a story's status,
    repo or `depends_on`" — without that, the next Plan agent invents the table again, which is how it
    got there.
  - `test/plan-schema-contract.test.ts` runs the issue's acceptance: build a plan from the shipped
    templates, flip S1 to `done` through `updateStoryFront` (the writer the Build executor uses), then
    grep the epic. Any `S<n>` + status word on one line of the epic body is a claim, and the claim set
    must be empty.

- **Seven `usage` strings were narrower than the same command's `--help` (#51, after #25).**
  `usage` is what a BAD invocation prints — `run.ts:85`, `questions.ts:38`, `tickets.ts:60`, `gate.ts:44`
  and three more write `<cmd>.usage` to stderr — so it is the string an operator reads at the exact
  moment they got the invocation wrong, and it was hiding flags the code accepts. Widened: `run attend`,
  `run status`, `run estimate`, `run auto`, `run unlock` and `run cancel` now show `[--run <id>]`
  (all six read `args.positionals[0] ?? stringFlag(args, "run")`); `tldrx next` shows it too
  (`next.ts:48`); and `tldrx questions lint` shows the `[<run>]` positional it has always taken
  (`questions.ts:49`, and `docs/guide/08-cli-reference.md` had been documenting it for longer than the
  CLI admitted it).
  - **The guard is subcommand-aware, and that is not gold-plating.** A plain
    `usage.includes("--run")` calls `run` CLEAN, because the new `run gates set` line names `--run` —
    measured, the naive check saw **one of run's seven gaps**. `test/cli.test.ts` scopes a flag that
    declares a `sub:` to that subcommand's block of the usage, and falls back to the whole string for a
    `sub:` that is a MODE rather than a word in argv (`dashboard --out {sub: "static"}`, which the first
    draft reported as a gap it is not).
  - **Three of the seven were spelling, not gaps, and are allowlisted with the reason:** `seed`'s
    `<Qid> "<text>"`, `watch`'s `check <feature>` and `hook`'s enumerated script names all say the same
    thing more specifically than the registry's general name. A fourth, `run`'s
    `<stage>:<human|auto|agent>`, is the same case. The allowlist is itself checked: every entry must
    still name a declared flag or arg, so a rename turns an exemption red instead of silent.
  - **`tickets --dry-run` was left OUT on purpose.** `tickets sync` previews by default and `--apply` is
    the write; advertising `--dry-run` would imply the opposite, and `test/money-safety.test.ts:319`
    asserts its absence. Recorded in the allowlist as a decision rather than papered over as a gap.

- **A literal ESC byte in `McpProbe.ts`'s ANSI regex (#52).** `src/core/doctor/McpProbe.ts:11` wrote a raw
  `0x1b` where `\x1b` was meant, so the source read `/<ESC>\[[0-9;]*m/g` and a reader — in a diff, in a
  review, in a terminal, in most editors — saw `/\[[0-9;]*m/g`, a different and wrong-looking regex that
  someone tidying is one keystroke from breaking `tldrx doctor --mcp` with. **Not the #47 hazard**, and
  worth saying: ESC does not trip the binary-file heuristic, and the file was always visible to a grep.
  Behaviour is byte-identical, and `.source` is the wrong instrument for proving that (it returns the
  literal as written, so the two spellings differ there while compiling to the same matcher) — so
  `test/doctor.test.ts` compares the shipped `stripAnsi` against a reference rebuilt from the old
  literal-ESC form over a nine-line corpus, 4 of which change. `test/source-hygiene.test.ts` now flags a
  raw ESC as well as a NUL: measured across all 479 `.ts` files under `src/`, `test/`, `bin/` and
  `scripts/`, `McpProbe.ts` held the only one, so the check has no false positives to trade against.

- **A stray NUL byte made two source files invisible to every grep-based sweep (#47).**
  `test/cli.test.ts` carried one literal `0x00`, so `file(1)` called it `data` and `grep -I` —
  ripgrep and ugrep too — dropped it SILENTLY, exit 0, no message. Measured on `origin/main`:
  `grep -lI -E 'node:child_process|Bun\.spawn' test/*.ts` returned **36 files with `cli.test.ts`
  absent**, though it calls `Bun.spawn` on line 32. That is how it missed #43's load-aware timeout
  and then timed out at 5004 ms on the very merge that was fixing timeouts. Writing the guard found
  a **second** one nobody had reported — `src/core/text/srcToken.ts:711`, a NUL used as a cache-key
  separator, which hid that file from every `src/` sweep (367 of 368 `.ts` files visible). Both are
  now the two-character escape `\0`: identical at runtime, ordinary text on disk. Post-fix the same
  sweep finds `cli.test.ts` and all 368 `src/` files. `test/source-hygiene.test.ts` walks `src/`,
  `test/`, `bin/` and `scripts/` and fails on any NUL, with the offender named at `path:line`.

- **The five wave-5 docs-pass nits, each a sentence nothing was checking (#25).**
  - **`boundary.ts` promised an exclusion is "never silent" and dropped state paths without a
    word** — `BoundarySurface.excluded` was populated and read by nothing. Every verdict that has a
    surface now names what was excluded, green and red alike, including the case where the
    exclusion was ALL there was and the run therefore reported "declares no surface".
  - **The precondition refusal asserted "the stage is still `ready`" without looking.** It reports
    the status `run.yml` actually holds. Bigger than filed: on a FRESH run the stage at the cursor
    is `pending`, not `ready`, so the old sentence was wrong in the ordinary case as well as on the
    retry of a `failed` stage.
  - **The agent-gate fallthrough printed its label twice** — `boundary: boundary=…`, because every
    condition detail was prefixed with its own id including the two that have a trigger of their
    own. Only the generic `condition` trigger keeps the prefix; alone it names nothing.
  - **`dispatchNotes.ts` documented `.agent/04-build/build/S5/…`**, one phase segment more than
    `dispatchNotesPath` builds. The example is now asserted equal to the path the code produces.
  - **Two usage strings were narrower than their own `--help`**: `tldrx gate template` omitted the
    positional `[<run>]` it accepts, and `run new` spelled `--gates <a,b|all|none>` where the help
    says `<a,b|a:agent|all|none>`.

- **`tldrx next --dry-run` spawns nothing. It used to cost $0.42 a go (#17).** The flag ran the
  stage for real — one `claude -p`, one `agent.spawned`, one `agent.result`, the cost on the
  ledger — and only reverted the non-handoff FILES afterwards. Measured on the 2026-08-30 pilot;
  `tldrx next --help` had said "Spawns nothing and writes nothing" the whole time, so this is the
  code catching up to the promise rather than the promise being watered down to the code.
  - **What it does now.** It assembles the prompt, prices it, and stops: the expert bundle, the
    context ledger, the prompt size, the declared outputs, and the **exact `claude -p` argv** it
    would have run (with the `--json-schema` blob elided as `<envelope-schema>`, rendered from
    `buildClaudeArgs` itself so the printed command cannot drift from the real one). Then the two
    commands that would actually dispatch it. Exit `0`.
  - **Nothing is written either.** No prompt bundle and no `pending.json`, so a dry run cannot
    leave a `--commit` looking at a turn that never happened; the stage keeps its status and the
    ledger keeps its zero. `dry_run_allowed: false` still refuses (Build sets it: a stage that cuts
    branches and fans out per-story sub-agents has no ONE dispatch to describe).
  - **On an attended run it is still refused at exit `4`** — but for the right reason now. It costs
    nothing; it describes a dispatch the framework never makes there, and `--prepare` writes the
    bundle the host is going to carry. The message said "it spawns a real sub-agent" and no longer
    lies.

- **A precondition gets its own clock, not the stage's 900–1800 s (#20).** `preconditions:`
  inherited `timeout_s`, so one hung command — `docker info` against a dead daemon is the measured
  case — could hold a run for half an hour: exactly the waste the feature exists to prevent, taken
  by the guard instead of by the attempt. Each precondition now gets **60 s** by default
  (`PRECONDITION_TIMEOUT_S`), overridable per entry with `timeout_s: <n>`, refused at load if that
  is not a number `> 0`. A timeout is a red precondition like any other — exit `2`, nothing
  written, nothing spawned, the stage where it was — and its message names the precondition, its
  own timeout and the knob that changes it, rather than the stage's. `CommandRun` gained
  `timedOut` so a timeout can be told from a refusal or a wrong exit code without reading prose.

- **The budget gate can see host-token spend and attendedness (#22).** The tolerant reader the
  `budget-gate` hook and the status line share (`hooks/lib/runFile.ts`) skipped `tasks[]` and
  `attended_by:` entirely. So a run whose turns a host session paid for reported `$0.00` metered
  and nothing else, and `runSnapshot`'s tolerant path hard-coded `attendedByHost: false` with a
  comment admitting it meant "cannot see". `RunView` now carries `attended_by` and each task's
  `cost_usd` / `metered` / `tokens`; `runSpend` derives the metered dollars, the declared host
  tokens and the uncosted turns; `renderRunEconomies` renders the one line that says a dollar
  figure is a lower bound. The gate appends it to a `host-tokens` phase's stderr note and to a
  refusal, and `budget.blocked` records `economy`, `attended_by`, `metered_usd`, `host_tokens` and
  `unmetered_tasks`. **No verdict changed**: a dollar ceiling still governs dollars, the two
  currencies are still never converted, and a plain metered run's refusal is byte-identical.

- **The `max_reads` flake was a real race, not a slow test (#24).** A chunk boundary is not a line
  boundary: `LineSplitter` hands every complete line in one chunk to the read counter
  synchronously, so when the OS coalesced the sub-agent's writes — which is what a loaded CI box
  does — reads 4..20 were counted in the same tick as read 3, long before the `SIGKILL` just
  ordered could land. `agent.result.payload.reads` was therefore a function of scheduling, and the
  assertion pinning it to the cap cost two retries in one night. The counter now stops the moment
  the cap fires, so what is recorded is the number of reads the cap ALLOWED. Pinned by a fixture
  that makes the coalescing deterministic (`FAKE_CLAUDE_READS_BURST=1` — every read pair in one
  write): pre-fix that reported 20 reads against a cap of 3.

- **One over-cap list item no longer cascades into false "S<id> has no file" errors (#37).**
  `validatePlan` resolves cross-file references out of the set of stories that PARSED, so a story file that
  failed its own validation was indistinguishable from one that was never written. Measured on the
  `260829-scoring-leaderboard` session: `acceptance[3]` in `S8.md` was 1,009 characters against the 512 cap,
  and the check reported three errors of which one was real — the other two said `S8 has no file in stories/`
  about a file that was 5,794 bytes on disk. The operator only avoided a wasted pass by re-deriving the cause
  from the validator source; an agent reading that message goes hunting for a missing file or rewrites
  `waves.yml`.
  - A reference to a story or epic whose FILE EXISTS is never reported as missing. It now reads
    `S8 is unresolved because stories/S8.md failed validation — that file exists; fix the errors reported
    against it and this one goes with them`, carries `cascade: true` on the `PlanIssue`, and covers the
    id-mismatch case (`stories/S8.md declares id \`S9\``) as well as the invalid-file case. The epic side —
    a story pointing at an epic whose own file did not validate — had the identical bug and the identical fix.
  - `describePlanIssues` orders root violations ahead of cascades. Its window is three issues wide, so one
    real defect cascading into four references could otherwise spend the whole window on consequences and
    never name the cause.
  - A story that is genuinely absent still reports `has no file`, with no cascade flag.

- **A refused list value now names the cap it broke, at the cap's current value (#38).**
  The constants were interpolated already but the sentence was not self-describing: `513 characters exceeds
  the 512 cap` did not say the cap is per-item or that splitting the item is the fix. Now
  `513 characters exceeds the 512-character cap on one list item — split it into several items` and
  `65 items exceeds the 64-item cap`, both still derived from `MAX_ITEM_CHARS` / the list's own `max`, and
  the same constants are what the Plan prompt states up front.

- **The merge itself is now serialised, and a gate can no longer describe a tree it is not pushing
  (#44).** `scripts/merge-wave.sh` merges, gates and pushes in ONE shared checkout and took no lock.
  Measured on the pre-fix script with two concurrent invocations against a real sandbox repo: run A
  gated `7afcc0e` (its own merge) at `typecheck` and `fadc923` (the OTHER run's merge, landed
  mid-gate) at `build`, then printed `OK fadc923 … pushed`. Both runs reported the same sha and
  both exited 0 — a green report over a tree neither had finished gating. With a red change in the
  other branch the same interleaving hands agent A a `FAIL build=1` for code it never wrote, which
  is what was actually observed live 2026-08-31 (`2184` tests counted where the branch had `2181`).
  - **A lock, held from before the dirty-tree check through the push.** `mkdir` on
    `.git/merge-wave.lock` — atomic on macOS and Linux, where `flock(1)` is not on stock macOS, and
    in `git rev-parse --git-common-dir` so the lock can never be dirt in the tree it guards — and
    not `$R/.git`, which in a linked worktree is a FILE that `mkdir` can never turn into a lock. A second invocation WAITS,
    saying so on stderr (`merge-wave: waiting for another merge in this checkout (owner: …)`) so the
    single summary line on stdout stays a single line. Waiting is bounded (`MW_LOCK_WAIT_S`, default
    3600 → exit `6`), and a lock whose owner is a dead pid on this host, or older than
    `MW_LOCK_STALE_S`, is broken open — after re-reading the owner line, so two waiters cannot tear
    down a lock a third has just taken. An interrupted run hands the lock back on its way out: an
    untrapped signal kills bash WITHOUT running its `EXIT` trap, so `INT` and `TERM` are trapped too. No
    path through the wait loop is free of the budget, including the break-open one: a lock that
    cannot be created or removed now fails in under a second instead of spinning forever.
  - **And an assertion that does not depend on the lock.** Between the last gate and the push, HEAD
    must still be the commit the gates ran against; if it moved, nothing is pushed and the script
    exits `5` saying which sha it gated and which one is there now. The lock prevents the race; this
    makes pushing an ungated HEAD impossible even for someone who bypasses the lock. The pre-fix
    script, given the same mid-gate commit, pushed it and reported `OK`.
  - **It pushes the commit it gated, not the `main` ref.** `git push origin main` publishes
    `refs/heads/main` whatever HEAD is — and a red gate leaves `main` sitting on an ungated merge
    commit by design, so the next run from a detached or repaired HEAD would have published THAT.
    The push is `HEAD:main` now, and a pre-flight refuses (exit `7`) when the gated commit is not a
    fast-forward of `origin/main` rather than letting the server's rejection be the first news.
  - Gate logs moved from the fixed `/tmp/mw-*.log` to a per-invocation `${TMPDIR}/mw-<pid>/`, and the
    FAIL lines name the directory. Two runs in two clones on one box shared those files.

- **The test suite no longer goes red because the machine was busy (#43).** On an untouched
  `origin/main`, `bun test` reported `2155 pass · 5 fail` while the same two files alone reported
  `91 pass · 0 fail`: four tests that spawn a REAL `git` expiring on bun's 5000 ms default, and one
  50 ms performance budget measured at 66.4 ms, with three `tldrx` runs and two other agents sharing
  the box. Because `merge-wave.sh` refuses to push on any test failure, that red is indistinguishable
  from a regression at the exact moment a merge is decided, and the natural response — re-run until
  green — is how a real regression eventually gets pushed.
  - **The clock moved; no assertion did.** `test/fixtures/machineLoad.ts` measures the machine
    (1-minute run-queue per core, floored at 1 and capped at 8) and hands out budgets from it. All
    **42** test files that spawn a real process — `git`, `bun`, the CLI — now open with
    `setDefaultTimeout(spawnTestTimeout())`: 30 s idle, scaled by load, still a hang detector. How
    long a process takes to start is a property of the machine, not of the code, so a fixed budget on
    such a test measures the box. A test enumerates those files and fails if a new one skips the
    budget. Serialising the suite would not have helped: `bun test` already runs files sequentially
    in one process (verified — a `setDefaultTimeout` in one file does not reach the next, and a 5.5 s
    test in that next file still expired at 5000 ms). The contention is other processes on the box,
    which only a load-aware budget can see.
  - **The first version of that list was a `grep -l`, and it lied.** It returned 14 files and silently
    omitted `cli.test.ts`, whose "every command's help lists an exit table" then timed out at 5004 ms
    on the merge that was fixing timeouts. Cause: one stray NUL byte at `test/cli.test.ts:366` makes
    the file `data` to `file(1)`, and grep drops binary files under `-I` without a word. The list is
    built by READING every file now, and `cli.test.ts` is asserted to be in it. Filed as #47.
  - **The one real performance budget keeps its teeth.** `handoff` on 256 KB is now the floor of
    three runs against `perfBudgetMs(50)`, which on an idle machine is 50 — the identical assertion.
    A stall inflates some runs and never the floor, and a function that genuinely takes 120 ms still
    fails, which is itself a test.

- **`npm pack` output no longer refuses the next agent's merge (#45).** `tldr-experts-<version>.tgz`
  was not ignored, and the dirty-tree guard refuses on ANY porcelain line, untracked included — so a
  pack artifact left by a release check blocked the merge of whoever came next, someone who did not
  create the file and could not know whether deleting it was safe. `*.tgz` is ignored now. The guard
  is deliberately unchanged: an untracked file is still dirt, and a test holds it to that.

- **`claim-sources` reports every problem it found, over every declared `.md` output — and a
  `file` src resolves against this run's epic worktree.** Four issues, one code path (#33, #34,
  #23, #16), all four measured on the 2026-08-30/31 unattended pilot runs.
  - **It reported ONE problem** (#33). `checkClaimSources` returned on the first file, the first
    category and `unresolved[0]`, so a 226-bullet cap breach sat invisible behind a single bad
    file path: fixing the visible one and re-running would have bought the next one at the price
    of a full paid pass. Every file and every category is reported now, as a per-file summary
    (`<file>: 3 unsourced bullet(s) on line(s) …; 2 unresolvable source(s) — …`), with file-level
    problems such as the cap breach listed FIRST so 200 line numbers cannot bury them. Up to six
    of a category are named and the rest become `(+N more)` — the same convention
    `describeKnowledgeIssues` uses, and necessary because a check's `detail` is rendered inside
    one-line summaries (`autoGate`, `next`).
  - **It looked at ONE file** (#34). The filter was `endsWith("handoff.md")`, so the identical
    violation refused the stage when it was written in `handoff.md` and passed in silence when it
    was written in `design.md`, `contracts.md` or `scope.md` beside it — the pilot's pass-3
    violation was caught only because it happened to be in the handoff. Every declared `.md`
    output is read now, by both the gate check and the write-time hook: the four-section rule for
    the files that ARE handoffs, and `validateCitations` for the ones that are not. That second
    rule is deliberately narrower — a bullet with no citation is prose, but a `[src: …]` that WAS
    written must parse, must resolve, and must obey `$ … → exit n` belonging only to an
    `Evidence ledger`. A declared non-handoff output that was never written is still not a
    failure; that is the `--commit` gap check's job.
  - **The execution-claim validator reads the verb** (#23). `\bexit \d` missed "exits 0", which
    is how a trainer writing normal English says it, so the claim slipped through the grammar the
    rule exists to enforce while "exit 0" three words away was refused. Conjugation, an optional
    "with", and the `code`/`status` spellings all match now; the digit is still required, so "the
    exit path is documented" and "the exchange refuses an empty code" stay prose.
  - **A `file` src resolves against this run's epic worktree** (#16). The Build phase commits
    onto an epic branch and deliberately does not merge it, so a Watch-stage handoff ABOUT that
    work had every `repo:src/…` citation refused for naming code the working tree does not have
    yet — the stage's own evidence was rejected for being true. `.tldrx/worktrees/<repo>/_epic-<run>-<epic>`
    is now a resolution base, tried before the working tree, for both the hook and the gate; the
    path convention has one home (`core/paths.ts`) that the Build executor writes and the §2.8
    resolver reads. Resolution also no longer stops at the first base where the file EXISTS but
    is too short — a file truncated on the epic branch would otherwise deny a claim about the
    line it still has on `main`. **Still open** (commented on #16): the epic worktree is removed
    at the end of Build unless `--keep-worktrees`, so the default Watch stage has no tree on disk
    to resolve against. Closing that means reading blobs out of the epic branch inside a hook
    whose budget is 50 ms, or keeping epic worktrees for the life of the run — a design call, not
    a mechanical one.

- **The Build DoD is a DELTA gate again: the base tree is checked before any story is charged (#41).**
  A dod block proves one thing — *this story did not break the tree* — and nothing checked that the tree was
  unbroken to begin with. Measured live 2026-08-31 on `260829-scoring-leaderboard`: of the three commands
  `workspace.yml` declared, **two already failed on pristine main** — a bare `dotnet test` ran two `Live`-trait
  tests that call paid Azure AI and that the repo's own CI excludes, and `dotnet format --verify-no-changes`
  flagged 336 files in a repo whose CI never gates format at all. All 15 stories in the plan would have blocked
  identically, each having spent a developer turn, and each told the operator the STORY was red.
  - **Pre-flight at Build entry.** After the dirty-tree and foreign-epic refusals and before anything is
    dispatched, every dod command the pending stories name is run once against the untouched base tree. A
    non-zero exit refuses the stage (exit `2`, back to `ready`) naming the command, its exit code and the repo,
    with no attempt spent and nothing charged.
  - **In the repo's own checkout, not a fresh worktree.** That is the tree a human means by "the base": it has
    the installed dependencies and tool state that make the command mean what the team thinks it means. A
    pristine worktree would fail half the world's repos for want of `node_modules` and turn a safety net into
    an outage.
  - **Paid for once.** Results go to `04-build/preflight.yml` — files are the state — keyed by repo, command and
    the base sha, and are read back by every later invocation of the run. A missing or unreadable cache is a
    question, never a fault: a run that entered Build on an older binary measures lazily rather than erroring.
  - **Attribution.** When a story's DoD does go red, the cached base result decides whose fault it is. A command
    red on the base too halts the build with the same workspace-config error rather than blocking the story and
    consuming its attempt. A command the gate declined to run is recorded `unmeasured` and excuses nothing.

- **The review handshake no longer swallows an unrecognized verdict, nor drops structured
  findings.** Measured on `260831-hardening-d1` / S1 (2026-08-31). Two verdict grammars coexist
  — gate evidence is `sign | sign-with-fixlist | refuse`, a story review is
  `approve | fixlist | changes` — and the host-facing hint named neither, saying only "write
  {verdict, summary, findings}". The host wrote `sign`. `parseReview` fail-closed it to `changes`,
  correctly and **silently**: a clean fix-list verification round read as a second `changes`, the
  story went `blocked`, and a `story reopen` cycle was the only way to record the verdict that
  had been meant all along. Separately, `findings` was filtered with `typeof f === "string"`, so
  the attempt-1 adversarial reviewer's seven `{severity, file, line, claim, evidence, fix}`
  objects were dropped whole — the verdict survived, the evidence it rested on did not.
  - **The contract is now stated where the host reads it.** Both `--commit --review` hints name
    the enum: `verdict is one of approve | fixlist | changes, NOT the `sign`/`refuse` gate
    vocabulary`.
  - **The downgrade is announced.** Fail-closed is unchanged — an unreadable verdict is still
    `changes`, never `approve` — but a verdict outside the enum now comes back on
    `Review.verdictProblem` ("the reviewer's verdict `sign` is not approve|fixlist|changes —
    recorded as `changes`"), is printed by the executor on the one path both doors pass through,
    and rides in `findings` so the review log and the next attempt's `## Previous attempt` both
    carry it. A DECLARED `fixlist` that fell short is untouched: `fixlistProblems` already says
    that one out loud, and two sentences for one downgrade would read as two faults.
  - **Structured findings are rendered, never dropped.** An object becomes
    `[severity] file:line — claim · evidence: … · fix: …`; a shape nothing recognizes is kept as
    JSON; a `findings` that is not an array is kept as one finding. An unreadable finding in the
    log beats a finding that is not in the log.

- **A project stage override that supplies only `stage.yml` no longer swaps the stage body for an
  empty one.** Reported from the 260829-scoring-leaderboard driver session (2026-08-31) and
  reproduced here: `stage.md` was resolved by string-substituting `stage.yml` in the path the
  preset had already picked, so creating `.tldrx/stages/plan/stage.yml` to tune one key moved the
  BODY lookup into a directory that had none — and the miss was read as an empty string. The
  context ledger printed `stage 1 B` where it had been 4.9 KB; the sub-agent would have been
  dispatched with the inputs, the experts and the rejection note and **zero** stage instructions,
  and nothing refused. `stageMdPath` now resolves per FILE, not per directory: the override's own
  `stage.md` wins, else the packaged one is inherited, and a stage with no body anywhere is a
  named `StageBodyError` rather than a silent empty prompt. Both readers — `next --prepare` and
  the Watch executor — go through it.

- **`approve --as-agent`'s refusal now names the route that works on the run in front of you.**
  It pointed only at `--gates <stage>:agent`, which is chosen at `run new` and frozen there — so
  the one suggestion meant recreating a run already in flight. It now leads with the delegated
  approve: read the agent's evidence note yourself and sign as you, `tldrx approve --note
  "delegated: <agent> reviewed this, evidence at <path>"`, which keeps the gate's policy and puts
  the provenance on the record. Found across the 2026-08-30/31 unattended pilots.

- **`budget raise <phase> <usd>` help said `<usd>` was "the new ceiling"; the source adds it.**
  `raiseBudget` computes `ceiling_usd + amount` (`raiseBudget.ts:83`), so an operator following
  the help over-raised — measured live on the scavtopia leaderboard run, a "$5.40 new ceiling"
  command would have set $8.00. The arithmetic is what live runs depend on and is untouched; the
  words move. `<usd>` is now "how much to ADD to that phase's ceiling — a delta, not a new
  ceiling", with a note spelling out the $10 + $25 = $35 case and pointing at `budget show`, which
  already prints the correctly-sized command.

- **`tldrx run new --from` stores an imported answer's own words, not a letter pointing at a file
  it does not own.** AI-DLC records a chosen option as `[Answer]: C`, and the import stored
  "<question> — C" verbatim; two facts became unreadable once aidlc was uninstalled and the source
  file went with it (2026-08-30/31 pilots). The interview flow has always resolved a letter to the
  option's text before recording (`interview/reply.ts:32-37`), and the import now does the same:
  `parseAidlcQuestions` reads the lettered options (uppercase, and a space required after the
  punctuation, so `- E.g. …` stays prose) and `answerText` resolves the answer against them; a
  letter with no option behind it is stored as typed rather than invented. Conflict detection is
  unchanged by the longer text: it keys on the QUESTION, as `hooks/no-reask.ts:54` already does,
  because `findDuplicate` is Jaccard over tokens and therefore length-sensitive — the same
  contradiction scored 0.78 against a bare letter and ~0.22 against the answer written out.

- **A second run's stories no longer merge into ANOTHER run's epic branch.** Measured live
  2026-08-31 on two concurrent runs: `260831-hardening-d1` reported S1, S2 and S6 all
  "merged into `epic/hardening-d1` (N commits carried)", and `epic/hardening-d1` was still
  sitting at its base with **zero** story commits — all three merges had landed on
  `epic/d1-tenancy-identity-customers`, a CLOSED previous run's branch. Nothing failed; the
  run closed green with an empty epic, and it surfaced only because a later story measured
  `git merge-base` and found the dependency it had been promised was missing.
  - **The cause was one missing run id.** `openEpicWorktree` built the epic worktree's disk
    path as `_epic-<epic id>`, and every plan names its first epic `E1`. The second run's
    `existsSync` therefore hit the FIRST run's directory, `addWorktree` was skipped, and
    `git merge --no-ff` ran inside a checkout of a foreign epic branch. The in-memory map was
    keyed correctly (`repo:epicBranch`) — only the path collided, and only across processes.
    Every progress line renders `story.epicBranch`, so the messages were right about where the
    merge was *meant* to go for as long as the bytes went somewhere else.
  - **The path now carries the run**: `_epic-<run id>-<epic id>`, the same shape the STORY
    worktree was given after the 2026-08-29 audit found the identical class of bug one level
    down. That fix never reached the epic worktree, which is the worse half — a story worktree
    collision means two sub-agents editing one file, an epic worktree collision is a merge.
  - **And a reuse on the wrong branch now refuses.** Every reuse of an epic worktree — the
    remembered path and the one found on disk — asserts its checked-out branch is the story's
    epic branch first (`assertWorktreeOn`, `core/build/git.ts`). A mismatch throws
    `WorktreeBranchMismatchError` naming both branches and the directory, and fails the stage.
    It never re-points the worktree and never merges anyway. Path scoping makes the collision
    impossible; this makes it impossible to repeat *silently*.

- **A `--note` with a blank line in it no longer destroys `run.yml`.** Measured 2026-08-31 on the
  live `260829-scoring-leaderboard` run: `tldrx reject --note "<two paragraphs>"` wrote the note
  into the gate's flow mapping with LITERAL newlines inside a double-quoted scalar, which is not
  YAML — the `yaml` package answered `Missing closing " quote at line 57` and Bun's parser
  `Unexpected character` — and from that moment **every** command on the run failed. There was no
  repair verb, so the operator had to hand-edit a file the docs forbid editing, and the next save
  re-emitted the same string and broke it again at the same line, taking `run.yml.bak` with it.
  Four changes, each closing one part of the loop:
  - **The emitter escapes, at the one place every field goes through.** `yamlScalar`
    (`core/facts/emitFactsYaml.ts`) escaped `\` and `"` and nothing else; it now emits via
    `JSON.stringify`, whose string grammar is a strict subset of YAML 1.2's double-quoted scalar —
    the escaping this repo already trusted in `adapters/external.ts` and `build/storyFile.ts`.
    Because every YAML this framework hand-emits routes strings through that one helper, the fix
    reaches **all** of them at once: gate notes (`approve`, `reject`, `revoke`), `cancelled.note`,
    task `error` and `stopped_by`, gate `evidence`, run `title`/`scope`, `facts.yml` fact text and
    retirement reasons, and `split.yml` goals, claims, questions and answers. Verified against
    **both** parsers behind the runtime seam. Existing files do not churn: over every code point
    from U+0020 to U+FFFF the new escaping and the old produce identical bytes (63,456 checked, 0
    differ), so only the values that were already corrupt change shape.
  - **A file already broken this way heals itself on load.** `parseYamlRepairing` (`core/yaml.ts`)
    re-escapes raw control characters trapped inside a double-quoted scalar, re-parses, and accepts
    the result only if it parses — otherwise the parser's ORIGINAL error is thrown, because a
    repair that cannot be verified is not offered. `RunStore.open` then rewrites the mended file
    through the fixed emitter and says so on stderr. A one-time hand repair was never enough: the
    old emitter re-corrupted the file on the next save, so `emit(load(x))` had to be made stable.
  - **Every state write keeps one step back.** `RunStore` and `FactsStore` had grown a
    byte-identical private copy of temp-plus-rename each; both now call one
    `core/fs/writeAtomic.ts`, which additionally copies the version it is about to replace to
    `<file>.bak`. Atomicity only ever guaranteed a WHOLE file, never a good one. The copy is taken
    before the rename, so the live file is never absent for an instant and a torn backup can only
    ever cost a backup. `tldrx init` now adds `tldrx-work/*/*.bak` and `.tldrx/memory/*.bak` to the
    managed `.gitignore` block.
  - **A `run.yml` beyond mechanical repair fails honestly, and takes nothing else down with it.**
    The error names the file, quotes the parser verbatim, says that every command on the run reads
    that file first, and points at `run.yml.bak` — while stating plainly that using it is a MANUAL
    decision tldrx will not make. Separately, one corrupt `run.yml` used to throw a raw
    `YAMLParseError` out of `buildModel` and kill `tldrx dashboard` for the whole workspace;
    `loadRunResult` (`core/replay/loadRun.ts`) now distinguishes missing from unreadable, and the
    dashboard lists the run as **unreadable** with the parse error beside it and renders every
    other run as normal.

### Changed

- **The docs now say, at the top of both places a reader starts, that `run attend host` is a LOCK
  and `run auto` is an ENGINE.** Grounding: on 2026-08-31 the framework's own author — who had read
  the chapter — ran `tldrx run attend host <run>` expecting it to drive the whole run by itself,
  and then asked whether `attend` and `auto` compose. They do not, and the code has always said so
  (`runAuto.ts:108` refuses `run auto` on an attended run at exit `1`, before the event log is
  opened; `runNext.ts:659` exits `4` on a bare `next` and names the `--prepare` command). The docs
  took too long to say it.
  - **README gains "Trying it: three ways to run"**, immediately after Quick start: a three-row
    table of who executes each turn, what a turn costs, and where each mode stops; one scenario
    line each (`run auto` for a small run you would watch anyway and for CI/cron — the only mode
    with no session behind it; `attend host` when a session is already open and cost or quality
    matters; `attend host` + a mandate for overnight); and the two-command recipe with a verbatim
    example **mandate prompt**.
  - **`docs/guide/10-unattended-mode.md` leads with the same disambiguation** — a blockquoted
    lock-vs-engine table above the chapter's opening paragraph, so a skimmer cannot make that
    mistake — and gains a `### The mandate` section carrying the prompt verbatim, tying its four
    legitimate interrupts back to the `questions` / `budget-event` / `boundary` fallthroughs the
    framework already enforces, and to the fact that no `git push` wrapper exists in the Build
    executor (`src/core/build/git.ts:13`) and the developer prompt says "Do not push"
    (`src/core/build/prompts.ts:180`).
  - **`tldrx run --help` says it too.** `run` had notes for `status`, `estimate`, `unlock` and
    `cancel` and none for the pair that actually confuses people. It now leads with one note per
    mode — "a LOCK, not an engine" / "an ENGINE, not a lock", each naming the other's refusal — and
    the `<host|--none>` argument line says the framework will not spawn on the run again. Help text
    only; no behaviour, no flag and no exit code moved.

- **`tldrx run estimate` is remaining-work aware (#21).** It priced the next stage from token medians while
  the budget brake separately computed what that stage still had to pay for — two models, one question, and
  the one people read was the one that never shrank. A Build stage with five of six stories done was still
  quoted the number the Plan wrote before any of them ran, which is the figure that made a pilot operator
  move money twice for work the run could already afford.
  - It now calls **the same `remainingWork()`** the brake and `budget show`'s `est.` column call, with the
    same inputs, and reports it beside the token estimate: done stories excluded, blocked ones named, the
    arithmetic shown. A test asserts the two numbers are identical rather than merely similar.
  - It also rolls the run up: `still to run: N stage(s) … $X priced`, with terminal stages excluded and the
    cursor stage narrowed by the plan when the plan knew better. `--json` carries both as `remaining` and
    `runRemaining`.
  - The token half is untouched. The input side is still measured off the same assembly `next` builds, and
    the cache/output medians still say which sample they came from — that half was never the complaint.

## 0.3.1 — 2026-08-31

**Unattended mode.** Twelve of the entries below are one feature: a run a **host session**
drives end to end, and a gate an **agent** may close over a check it wrote down. `attended_by: host`
stops the framework spawning on a run at all; `economy: host-tokens` stops a ceiling that is not
dollars from buying a metered spawn; the dispatch-notes slot gives the host the one place to add
what the bundle cannot know; `next --prepare/--commit --review` makes the Build reviewer the
second delegable role, so one review is done once; the `fixlist` verdict gives a review that
SIGNS somewhere to put its findings, for one bounded round that costs no attempt;
`gates_policy: agent` closes a gate on the seven auto conditions **plus** a boundary check, a
budget-event check and a validated evidence note, and falls through to a person on a question, a
moved ceiling, work nobody scoped, or its own refusal — rendered as a decision card rather than
a dashboard. Three smaller pieces stop a turn being wasted before it starts: `preconditions:`
on a stage, a story branch fast-forwarded onto its epic before dispatch, and a budget brake that
counts the work that is LEFT rather than the price the stage was written at. Two measurements
from 2026-08-30 are the whole argument: **$9.95** of spawns that died on caps a Plan agent had
priced in host tokens, and a framework reviewer that spawned beside a host already reading the
same diff. New chapter: `docs/guide/10-unattended-mode.md`. Every part is additive — a run with
none of these behaves byte-identically to the release before them.

### Added

- **A story branch that has fallen behind its epic is fast-forwarded before a developer is
  dispatched onto it.** Measured 2026-08-30 on `260830-tenancy-identity-customers`: S3 was
  reopened, `story reopen` keeps its branch by design, and that branch still sat at the S1-era
  epic tip while the epic had since gained S2 and S5. S3's handlers needed S2's contract, so a
  dispatch on that base would not have compiled. The host fast-forwarded by hand before
  dispatching. That is the one case this automates.

  ```
  · S3: fast-forwarded `story/260830-tenancy/S3` to `epic/tenancy` — 2 commit(s), b5a2474 → ae9c8dd
  ```
  - **Where.** Inside `openStory`, which is the one place a story worktree is opened, and only
    on the two openings that are about to put a DEVELOPER on the branch: the headless pipeline
    and `tldrx next --prepare`. The review openings (`--prepare --review`, `--commit --review`,
    an errored review re-run) and `--commit` measure nothing and move nothing — a fast-forward
    there would drag other stories' commits onto a branch whose whole meaning is "what this
    story built", for a base nobody is about to compile against.
  - **The requeue case, which fires far more often than the reopen one.** A `changes` verdict
    merges the story into its epic and then hands it a second attempt; before this, attempt 2
    was dispatched onto attempt 1's base. It now starts on the current epic tip.
  - **A diverged branch is warned about, never resolved.** Commits on both sides is the second
    live case — a dead spawn's partial commit on a stale base, where no fast-forward existed
    and the host preserved the partial on a backup branch and re-pointed the story branch by
    hand. Which of two histories survives is a decision, so the framework does not make it: it
    names both counts, both shas, and the two options, changes nothing, and lets the dispatch
    proceed on the old base — saying, in as many words, which base that is.
  - **A dirty worktree is left alone**, whatever the topology says. It is the operator's.
  - **Never a rebase.** Rewriting a branch a developer has already committed to is the class of
    move the run-id-in-branch-name fix (2026-08-29 audit §B) exists to prevent. The only write
    is `git merge --ff-only`, which refuses rather than inventing a merge commit. Measured
    2026-08-31 against a real repository, which is what the design asked to verify before
    building: blocked by a file in the way it exits non-zero and leaves HEAD and the file
    exactly as they were — atomic-or-nothing, so a failed fast-forward needs no repair, only a
    line saying it did not happen.
  - **`story.base_fastforwarded`** joins the closed §2.9 event set — the only event in it that
    records tldrx moving a ref. It carries `story`, `repo`, `branch`, `base`, `from`, `to` and
    `commits`, `tldrx replay` narrates it, and it is appended ONLY when the ref actually moved:
    a divergent or dirty branch produces a warning and no event, because nothing happened.
  - **An up-to-date branch is silent** and emits nothing, so a run with nothing to say about
    its bases is what it was before.
  - `tldrx story reopen` is unchanged: it still runs no git command, spends nothing and touches
    no branch. The detection belongs where a worktree is being opened anyway and where the
    operator is about to dispatch.

- **Decision cards — the shape an interrupt takes when a run stops for a person.** Measured
  2026-08-30: an unattended run stopped on two owner questions, and the host did NOT show the
  owner the dashboard or the `2 open question(s) in 01-what/questions.md` line the framework
  actually prints. It hand-composed, in chat, the question, the options and a recommendation
  with one line of why. The owner answered both in seconds. The card is what made the
  interrupt cheap; hand-composing it is what the framework was making the host pay for.

  ```
  DECISION — 260830-tenancy · 01-what/what
  Q2 · Should an existing customer's tenant be inferred or asked for?
    Why asked: no tenant column on the customer aggregate [src: absent:api:src/.../Customer.cs]
    A) infer from the invoice email domain — no new UI, wrong for resellers
    B) ask once at first login — one screen, correct for everyone
    C) other — write it below
  Recommends B — one screen, correct for everyone [src: 01-what/handoff.md:22]
    tldrx answer Q2 "…" --run 260830-tenancy
  ```
  - **Pure rendering of things that already exist.** The question, its `Why asked:` line and
    its lettered options come out of `questions.md` through the **§2.7 parser** — the
    questions grammar is not touched, and a block the parser cannot read does not appear on a
    card any more than it appears anywhere else. The `Recommends` line comes out of the
    evidence note's optional `recommend: [{q, option, why, src}]` array, which the evidence
    grammar already validates.
  - **A question with no recommendation gets no line.** Never a manufactured one and never a
    placeholder: the whole value of that line is that an agent stood behind it with a
    citation.
  - **One renderer, three surfaces.** `tldrx run auto --gate-agent` at the stop;
    `tldrx next`'s agent-gate fallthrough, where the card is **appended** to the fallthrough
    list so nothing that reads those lines today loses a byte; and `tldrx status`, where a run
    waiting on answers now shows the card rather than `open questions: Q1, Q2`.
  - **A card per fallthrough kind.** Budget and boundary get their own card over the same
    frame — the measured fact, then the commands (`widen the scope …` / `approve` / `reject`
    for a boundary; the phase's two numbers plus `budget show` for a budget event) — and every
    other reason an agent gate fell through is carried as one gate card naming its reasons.
  - **`--gate-agent` is rendering only.** It does not upgrade any stage to
    `gates_policy: agent`: a run keeps the policy it was opened with, and a flag that could
    raise one at stop time would make the frozen policy decorative. On an
    `attended_by: host` run it changes nothing — `run auto` is still refused at exit `1`
    before the event log is opened, and nothing spawns.
  - **Nothing else moves.** `tldrx answer`, `questions.md`, the live dashboard and every exit
    code are unchanged, and `run auto` without the flag prints exactly the block it always did.
- **The budget brake counts the work that is LEFT, not the price the stage was written at.**
  Measured 2026-08-31 on `260830-tenancy-identity-customers`: four of seven stories done, one
  mid-attempt-2, two blocked, and the entire remaining metered cost a developer share and a
  reviewer floor — **$2.50**. The brake compared the phase's remaining dollars against
  `stage.budget_usd`, **$18.00**, a number written before a single story ran and never
  revised. It refused the stage twice and the host ran `budget raise --take-from` twice, for
  money nothing was going to spend.

  For a Build stage with a plan on disk, `tldrx next`'s refusal, the `budget-gate` hook and
  `tldrx budget show`'s `est.` column now all use one figure computed by one function: `Σ`
  over the unsettled stories of the caps the executor would actually hand out — the
  `03-plan/budget.yml` price through the same scale/share arithmetic, the developer and
  reviewer shares, the `$1.00` reviewer floor, and the attempts each story has left.
  - **The refusal shows its arithmetic**: `remaining work: S4 dev $1.50 + reviewer $1.00 =
    $2.50`, under a line naming how many stories are done and what the stage's static
    estimate was. A number an operator cannot take apart is one they cannot argue with, and
    `$18.00` cited nothing.
  - **`blocked` costs $0.00**, and the blocked ids are named rather than quietly dropped: the
    executor dispatches a blocked story only after `tldrx story reopen`, which is a human
    decision and which legitimately raises the figure again.
  - **A story at `review` has already paid the developer turn under review.** Only a `changes`
    verdict buys another one.
  - **Under `economy: host-tokens` the developer turns are $0.00** — the host session pays for
    them — while the reviewer floors stay, because outside attended mode `reviewAndSettle`
    still spawns a metered reviewer and that floor is real money.
  - **It can only NARROW.** The figure is capped at `stage.budget_usd`, so this brake can
    never refuse more often than it did before; the reviewer floor can otherwise lift a naive
    sum past the ceiling. Asserted in both directions, across a spread of plan shapes, because
    a brake that loosened by accident is the failure to fear here.
  - **`budget.blocked` gains `estimate_basis: plan|static`** and, on the plan basis,
    `static_estimate_usd`, `stories_done` and `stories_total`.
  - **With no plan on disk, and outside Build, every path is byte-identical**, wording
    included: the estimate is `budget_usd` and the message still reads `the stage estimate
    is $X`.

- **`preconditions:` on a stage — the check that runs before the money does.** A stage may
  declare operational facts that must hold before it is worth dispatching at all:

  ```yaml
  preconditions:
    - {id: docker, repo: api, command: "docker compose ps", expect_exit: 0}
  ```

  The grounding is measured, 2026-08-30: before dispatching a Build story the host checked
  the Docker daemon and the .NET SDK **by hand**, because a story has two attempts, an agent
  cannot debug its way out of a daemon that is down, and the whole turn would have been spent
  proving it. That check took about a second and protected an attempt worth dollars.
  - **Same allowlist rule as a `cmd` check and a story's `` ```dod `` block — and now literally the
    same function.** Only a command byte-equal to one `.tldrx/workspace.yml` declares runs,
    argv-split, never through a shell. The comparison and both refusal sentences moved to
    `schemas/commandAllowlist.ts`, so the three sites can no longer drift into three readings
    of one rule. It is enforced **at load**: a stage naming an undeclared command never
    becomes a runnable stage, so `tldrx run new` over it refuses too.
  - **Red ⇒ refused, exit `2`, having spent nothing.** The id and the command's own exit code
    are named, the stage is left exactly where it was (`ready`), no bundle is written and
    nothing is spawned. The list stops at the first red one.
  - **`--prepare` runs them no less than headless** — a bundle written for a host whose Docker
    is down is the same wasted attempt as a spawn into one. `--commit` never runs them: it
    settles a turn that already happened.
  - **Every run is on the record**: one `check.passed` / `check.failed` event with
    `kind: precondition`, carrying the repo, the command, the exit code and the duration, and
    one operator line — `· precondition: docker compose ps → exit 0 (1.2s)`.
  - **A stage that declares none is byte-identical**: no event, no line, no shipped stage file
    changed. `[assumption]` — per stage, not per story; a per-story precondition is a real
    want and is deliberately not designed here.
- **The `fixlist` verdict, its artifact and its router — the review that SIGNS and still has
  findings.** Measured 2026-08-31, driving `260830-tenancy-identity-customers` by hand: the
  reviewer signed story S5 — every acceptance criterion met, zero scope violations — and in the
  same breath named three real correctness/security defects the criteria never covered (a
  concurrent double-confirm minting two sessions, a non-atomic confirm, a false security comment
  beside a non-constant-time compare). S1 and S3 went the same way that night. Binary
  `approve`/`changes` has nowhere to put those: `approve` throws them away, `changes` spends the
  story's one requeue on a diff nobody faulted. So all three loops were run in chat — number the
  findings, decide fix-now vs defer-with-log, route them to the author, re-verify — and none of
  it reached a file. This is that loop, as a verdict and an artifact.
  - **`fixlist` settles the story at `review` and spends NO attempt.** The requeue counter counts
    verdicts that FAULTED the diff, and a signature is not one. `04-build/fixlist/<story>-<n>.md`
    is written beside it by the EXECUTOR, never by the reviewer — which holds no write tool, the
    same reason the review log is written there. Numbered `## <n> · <finding> [<severity>]`
    sections, each with `Where:`, `Disposition:` and `Resolved:`.
  - **A disposition ROUTES a finding; `Resolved:` CLOSES it.** Two questions, two fields, because
    one field cannot answer the first once the second is true. `fix-now` · `defer-with-log` ·
    `refuted` · `out-of-scope`, and **`refuted` must carry an `[src: …]`** in its `where` or
    `detail`, through the §2.8 grammar and the §2.8 parser — a reviewer's verdict is a claim like
    every other, and that night's host disproved one by grepping both sides before acting on it.
    A fix list with an uncited `refuted` is refused whole and the verdict falls to `changes`.
  - **The router: `tldrx next --prepare --fixlist <path>`.** The open findings land under
    `## Fix list` in the DEVELOPER's prompt, numbered, with their `Do NOT` lines verbatim — a
    bound the reviewer put on a fix is worth as much as the fix. `pending.json` gains
    `fixlist: {path, round, findings, open}` and `resume_session`, the prior turn's `session_id`,
    so the host can resume that sub-agent rather than pay to rebuild its context. **The framework
    resumes nothing itself** — `spawnAgent` has no `--resume` — so the bundle carries the fix list
    and the merged commit and hands the id back to the party that can act on it. Omit the flag and
    the latest still-open round is carried by itself, the same courtesy `--prepare` already
    extends to a story waiting on a review.
  - **One round per story, and the second is refused out loud.** A free round that could be taken
    twice is a story that never has to settle. A second `fixlist` is read as `changes` — which
    costs the attempt the first one did not — the refusal names the round already on disk, and the
    SECOND reviewer's prompt withdraws the verdict rather than offering one the executor would
    then refuse. `story reopen` resets the count with every other one in the review ledger.
  - **A story cannot settle `done` over an open `fix-now`.** An `approve` there settles `blocked`
    and the reason names the file, the finding's number and its heading, plus the two ways to
    close it. The check reads the FILE, not the envelope that produced it: the file is the state,
    and a host closes a finding by writing `Resolved: yes` in it or re-routing its `Disposition:`.
    That edit is the host's — §B.2's third role — because the author works in a story worktree of
    another repo and its own prompt forbids writing outside it.
  - **Fail-closed, unchanged and asserted.** A `verdict: "fixlist"` whose `fixlist[]` is missing,
    empty or unreadable is `changes`, never a free round and never `approve`. Both economies reach
    the same code: the host writes the envelope into the review bundle, or a spawned reviewer
    returns it — `REVIEW_SCHEMA` gained the verdict and the optional array, and `parseReview`
    narrows both.
  - `defer-with-log` findings are appended to `retro.md`'s `## Build feedback` as the artifact is
    written — the existing second writer with its existing verbatim dedup — so a deferred defect
    reaches the owner through a channel that already exists rather than a new one.

- **`tldrx next --prepare --review` / `--commit --review` — the reviewer is the second
  delegable role.** A Build story has two sub-agents and only the developer was ever
  delegable; the reviewer was the FRAMEWORK's spawn in both modes, which on a host-driven
  run buys a second reading of a diff the host is already reading, and a bill nobody
  budgeted. Now it rides the same handshake, one directory down:
  `.agent/<stage>/<story>/review/{prompt.md,pending.json,result.json}` — nested so a
  reviewer bundle can never be read as a developer one.
  - **`--prepare --review` writes the bundle and spawns nothing.** `prompt.md` is what a
    spawned reviewer would have been sent, from the same renderer. `pending.json` carries
    `role: reviewer`, `result_schema` (the reviewer's `--json-schema` envelope, verbatim,
    so the host needs no source to know the shape), and a `review:` block with the diff
    command, the merged commit, the attempt and the **DoD results recovered from
    `events.jsonl`** — the DoD is not re-run, and the prompt says so.
  - **`--commit --review` settles it through the existing seam.** The envelope goes through
    the same `parseReview` with the same fail-closed rule (unreadable ⇒ `changes`, never
    `approve`) and the same `reviewAndSettle`: `approve` ⇒ `done` with its evidence,
    `changes` ⇒ one requeue then `blocked`, `MAX_ATTEMPTS` and the requeue counter
    untouched. A host that never writes `result.json` has produced no verdict and spends
    no attempt.
  - **The trail says whose review it was.** No `agent.spawned`; a `task.started` with
    `role: reviewer, mode: prepare` instead. The `check: review` event carries
    `source: host` (written only for a host review, so the spawned path's payload is
    unchanged byte for byte), and the task row is `cost_usd: null, metered: false` unless
    the envelope declares `cost_usd` / `tokens`.
  - **On `attended_by: host` the framework never calls `spawnReviewer` at all.** Half B
    merges the story and hands the review over, so a full attended story cycle emits zero
    `agent.spawned`. Outside attended mode `--review` is opt-in and the headless reviewer
    is unchanged.

### Changed

- **`tldrx next --prepare` on a story awaiting review now writes the reviewer bundle
  instead of spawning a reviewer.** It used to spawn a metered one — which is the single
  thing `--prepare` exists not to do. Measured 2026-08-31 on the live
  `260830-tenancy-identity-customers`: story S3's reviewer died at its $1.00 cap, the
  story parked at `review`, and the `--prepare` that was supposed to rescue it spawned a
  replacement that a two-minute host timeout then killed mid-read. The story is still
  parked at `review` afterwards, its attempt still unspent, and the verdict is the host's
  to write. Headless `tldrx next` still re-runs the review by spawning, unchanged.
- **`tldrx next`'s `attended_by: host` refusal names `--commit --review`** when the stage
  is holding a reviewer bundle. It named `--commit`, which is the wrong half: that door
  reads the DEVELOPER's `result.json` and re-runs a pipeline that has already merged.
- **`--discard-pending` bins the reviewer bundle too**, alongside the developer bundles it
  already binned — a stale review `result.json` would otherwise be read by the next
  `--commit --review` as a verdict on work it never saw.

- **`tldrx init` says what it is doing while it does it** — a live line per step, in the
  same `--ui scene|compact|plain|off` view family as the agent progress view, on stderr.
  It used to print NOTHING until it was finished. Measured 2026-08-30 on a five-repo
  workspace: **36.0 s of total silence** with the default `--provider auto` against
  **1.3 s** with `--provider static` — so ~97% of the wait is `graphify update` running
  once per repo inside `buildMap`, and the command looked hung for all of it.
  - **Ten steps announce themselves**: detecting repos, building the code map, writing
    `workspace.yml`, planning the interview, seeding experts, reading conventions, writing
    `process.yml`/`facts.yml`, `init-questions.md`, `init-handoff.md`, and the `.gitignore`
    + `CLAUDE.md` blocks. `--mcp` adds an eleventh, because it health-checks every server.
  - **The slow ones name the repo they are inside.** `detecting repos` reports each repo
    with its stack, confidence and default branch as detection finishes it; the map step
    reports `<repo> — 6 documents via graphify` per repo. The wait is now legible instead
    of merely long.
  - **A terminal gets a spinner, colour and an in-place rewrite; a pipe gets plain lines.**
    A finished step is printed once and never touched again, so it survives in scrollback
    after the command exits — a step list is a HISTORY, not a picture of a moment, which is
    why this is not `ui/driver.ts` with a different renderer. In `plain` a step still open
    after 5 s says `still <label> — 12 s`, because there is no spinner there to prove the
    process is alive.
  - **A schoolhouse** (`core/ui/campus.ts`) is painted above the steps in `scene` mode,
    drawn in the same hand as the classroom the agent view renders — `init` is the survey
    that happens before the school opens.
  - **`--quiet`** turns the live view off and keeps the report. **`--ui <mode>`** works on
    `init` exactly as it does on `next`, `run auto` and `expert train`, and a bad value is
    a usage error raised before any work is done.
- **`core/ui/color.ts`** — the framework's first ANSI palette, resolved per STREAM rather
  than per process. `tldrx init > report.txt` on a terminal has a piped stdout and a TTY
  stderr: the live lines are still worth colouring and the file must still be plain text.
  `palette(false)` is the identity for every ink, so a renderer never branches on colour
  and the uncoloured path stays byte-for-byte deterministic in a test. `FORCE_COLOR` beats
  `NO_COLOR` beats `CI` beats the stream.

- **The dispatch-notes slot** — `.agent/<stage>/dispatch-notes.md`, and for a Build story
  `.agent/<stage>/<story>/dispatch-notes.md`: the one place a HOST can add context to a
  prompt the framework generated. Measured over one full run of
  `260830-tenancy-identity-customers`, 2026-08-30, EVERY stage needed host-added context the
  bundle lacked — a deferred decision at What, non-inlined seed docs and a staleness warning
  at How, the owner's answers at Plan, "Docker is up" at Build — and the host had exactly two
  places to put any of it, neither of which is one: `stage.md` is the framework's file,
  shared by every run of that workflow, and an edit to `prompt.md` is thrown away by the next
  `--prepare`.
  - **Rendered under `## Dispatch notes`, between `## Inputs` and `## Previous attempt`.**
    Behind the expert blocks on purpose: the slot is the most volatile thing in the document
    — a human writes it between one cycle and the next — and a per-cycle file ahead of the
    largest stable section would pay the cache-WRITE price on every stage. The same position
    in the Build developer prompt, directly under `## Inputs`, because that is where the
    brief ends and `## Investigate` step 1 tells the developer the files above ARE the brief.
  - **Absent ⇒ nothing changes, byte for byte.** No section, no `dispatch_notes` key in
    `pending.json`, `0 B` in the context ledger. Asserted by adding the file, re-preparing,
    removing it, re-preparing, and comparing the two prompts byte for byte.
  - **Capped at 8 KB, and never free.** The stage's file and the story's file feed ONE slot,
    spent stage-file-first, so neither can quietly double the budget; the overflow is named
    in the prompt, on stdout, and in `pending.json`
    (`dispatch_notes: {bytes, truncated, max_bytes, sources[]}`). The rendered section's
    bytes are charged to the context ledger and count against `prompt_max_bytes` like
    everything else — asserted with a ceiling the prompt clears without notes and breaks
    with them. The byte cut never splits a character in half.
  - **Context, never configuration.** The framework does not parse it, does not substitute
    `{{placeholders}}` in it, does not require `[src: …]` tokens on it, and it cannot change
    a declared input, an output, a check or a cap. The section says all of that to the
    sub-agent in its own preamble, because a note that reads like an instruction is otherwise
    indistinguishable from the stage's own rules.
  - **Survives `--discard-pending`.** The flag bins `pending.json`, `result.json` and
    `result.raw.json`; the notes are an INPUT to the rendering that is about to be redone,
    not an output of the one being binned.
  - **Per-cycle scratch, deliberately.** `.agent/` is gitignored, and that is the whole
    point: a caveat that must outlive the cycle is a FACT, and `.tldrx/memory/facts.yml` is
    the durable channel that already reaches every prompt with attribution behind it. Two
    durable channels for the same thing would make neither authoritative.
- **`attended_by: host` — a run a host session drives, that the framework never spawns on.**
  One optional top-level key in `run.yml`, set at creation with `tldrx run new --attended-by host`
  or flipped later with `tldrx run attend host` / `tldrx run attend --none`. The finding it is
  built for is one sentence of field notes from 2026-08-30: a bare `tldrx next` on a Build stage
  runs the WHOLE remaining headless pipeline — every wave, every story, as paid spawns — when the
  host wanted one re-review. Six of six of those spawns then died on `Reached maximum budget` at
  caps a Plan agent had authored assuming host-billed sub-agents. $9.95, nothing delivered. The
  affordance was missing at the RUN level: `--prepare`/`--commit` is a decision per invocation,
  and nothing on the run could say "this one is being driven by a host session".
  - **A bare `tldrx next` exits `4` and names the exact command** the stage is waiting for —
    `--prepare` when it is ready, `--commit` when a bundle is already out. Four, not two: the run
    is not refusing the work, it is waiting on the host to take a turn, which is the same shape as
    waiting at a gate and the code `run auto` already stops cleanly on. The refusal is the first
    thing in `runStage` — ahead of the budget gate, ahead of reading an input, ahead of assembling
    a prompt — so nothing is billed and nothing is written.
  - **`--dry-run` is refused with it, and the message says why.** `--dry-run` is `mode: headless`:
    it spawns a real sub-agent and the turn is billed, and only the non-handoff FILES are reverted
    afterwards. That is measured, not read — one `agent.spawned`, one `agent.result`, the cost on
    the ledger. The CLI reference said "Spawns nothing, writes nothing" and a comment in
    `next.ts` said the same; both were wrong and both are corrected here.
  - **`tldrx run auto` is refused at exit `1`**, before the event log is opened, so nothing is
    written. A loop whose whole job is calling `next` headless has nothing to do on a run where
    `next` headless is a refusal.
  - **Three layers, because "nothing spawns" is a promise about money.** `runNext` refuses; every
    executor (`build`, `watch`) refuses a headless context with `refused: true`, so the stage goes
    back to `ready` rather than being marked failed; and `spawnAgent` itself throws while an
    attended run is in flight. The third is what makes "no run path can reach a spawn" a property
    rather than a claim about three `if`s — a fourth call site is always one merge away.
  - **`tldrx run attend` is deliberately small**: it sets one field, appends one `run.attended`
    event carrying the new value and the old, and touches no stage, no output, no branch and no
    money. `--none` REMOVES the key rather than blanking it, because `attended_by: null` is not a
    legal value. A direction is required and never guessed (exit `1`); setting what is already set
    appends nothing, since a decision nobody made does not belong in the log; a `done` or
    `cancelled` run is refused (exit `2`).
  - **`tldrx run status` prints `attended: host`** and the status line gains an `att` marker
    beside `auto:N` / `stale:N`, leading them because it is the one that changes what `tldrx next`
    will do. `--json` gains `attended_by`, appended after `unmetered_tasks` so every existing key
    keeps its position.
  - **Additive, and asserted as such.** Absent — which is every run.yml written before this — the
    framework may spawn and every path is what it was: the two-stage headless fixture's event
    sequence is asserted against the one captured from `main` at `dae1d07`, event for event, and
    an ordinary run.yml never mentions the key. A value the reader does not understand is a schema
    error rather than a silent downgrade to "spawn anyway"; `requireKeys` ignores unknown top-level
    keys, so an older binary reading a run.yml with `attended_by` still validates it — but it will
    DROP the key on its next save, since `emitRunYaml` only writes what it knows.
  - Out of scope on purpose: `tldrx expert train` and `tldrx seed triage --propose` spawn outside a
    run and are untouched. `attended_by` is a property of a run.
- **`economy: metered-usd | host-tokens` on `budget.yml`** — a price gets a currency, and a
  headless spawn under a ceiling that is not money is refused before it spends. Measured
  2026-08-30 on `260830-tenancy-identity-customers`: the Plan agent priced the run assuming
  HOST-billed sub-agents — turns the host session pays for, which this process never meters
  and which are ~free to the run — and the executor then enforced those figures as dollar
  ceilings on METERED spawns. Six spawns of six died on `Reached maximum budget`, each
  having spent real money to get there: **$9.95**, for nothing. The money model was a single
  scalar with no unit on it and no way to say *"this number is not dollars."*
  - **One optional key, three places**: the run level of `budget.yml`, any `phases[]` entry
    of it (which overrides the run), and the root of `03-plan/budget.yml`, so a Plan agent
    can say which economy it was pricing in. Resolution is phase-then-run.
  - **`tldrx next` refuses a headless spawn on a `host-tokens` phase — exit 2, above prompt
    assembly, before a byte is written or a cent is spent.** The message names the number,
    the unit, and both ways out (`tldrx next --prepare`, or re-label and re-price the
    phase). `--prepare` / `--commit` are untouched: the in-session handshake is exactly
    where a host-billed turn belongs.
  - **The two are never converted into one another.** There is no exchange rate here and
    inventing one would be a guess about a price. The budget-gate hook does not deny on such
    a phase (there is no dollar ceiling to enforce, and it says so on stderr), the auto
    gate's money condition reads `n/a (host-tokens economy)` rather than comparing a spend
    in dollars to a ceiling in tokens, and `tldrx run estimate` prices the stage in TOKENS
    with no dollar figure at all.
  - **A `03-plan/budget.yml` priced in `host-tokens` contributes no story caps.** Its
    numbers are not dollars, so the Build executor falls back to the uniform share it used
    before plan prices were read at all — and says so on stderr, through the advisory seam
    that already existed for an unusable plan budget.
  - **An unknown value is REFUSED, never defaulted to dollars** — a unit nothing here
    understands is not one it may quietly read as money. An empty `economy:` key, and an
    absent one, both mean `metered-usd`.
  - **`tldrx budget raise` no longer erases what it rewrites past.** The label round-trips
    through the same emitter the raise goes through; a raise that dropped it would turn a
    token budget back into dollars silently, from the one command an operator reaches for
    when a ceiling binds.
  - **Absent label ⇒ byte-identical behaviour**, asserted: an unlabelled `budget.yml` emits
    no `economy:` line, an unlabelled headless stage still spawns, and every existing budget
    test passes untouched.

- **`tldrx story reopen <id> --note "<why>"`** — one Build story, given another run of
  developer attempts, by a person. The third verb of the family that landed 2026-08-30 and
  the only one a HUMAN signs: the other two stop the machine reading a transport failure
  as a judgement, and this one is for when the machine read the run correctly and the
  owner disagrees. Found on `260830-tenancy-identity-customers`, where story S3 sat
  `blocked` after two GENUINE `changes` verdicts (its developers ran and committed nothing;
  both reviewers correctly refused an empty diff) — no rescue applied and none should have,
  but S3 gates wave 3 and the owner had decided it ships. The only reopening verb was
  `tldrx reject --stage`, which acts on a STAGE, and hand-editing `run.yml` or a story file
  is forbidden by design.
  - **The note is required** — a reopen with no reason is not actionable — and one
    `story.reopened` is appended carrying the actor, the note, the status the story came
    from, its wave, and how many verdicts the closed run of attempts consumed.
  - **The story goes back to `todo` and its attempt counter restarts at 1 of 2.** Nothing
    is erased to make that true: `story.reopened` is a RESET BOUNDARY that
    `readReviewLedger` reads, so verdicts before it stop counting while every event stays
    in `events.jsonl` for `replay`, `cost` and `retro`. The full reset is the honest
    choice precisely because the history survives it — "you get two more turns" is what
    overruling a block means, and a half-reset would be a number nobody could explain from
    the record.
  - **It runs no agent, spends nothing, deletes nothing and refunds nothing.** The story's
    BRANCH is what carries the last developer's commits forward and it is untouched; the
    worktree is left exactly as the build left it (kept at `review`, already removed for a
    `blocked` story) and is reopened from the branch when the next turn needs it.
  - **It does not make the stage runnable, and does not pretend to.** Sending a stage back
    is `reject`'s own signed decision, so the output names the command that fits where the
    Build stage actually is: `tldrx next` when it is ready, `tldrx reject --note` at a
    pending gate, `tldrx reject --stage` over a signed one.
  - Refuses with exit 2, saying why: an id the plan does not have (naming the ones it
    does); a `done` story, because undoing finished work is a decision about the stage and
    belongs to `reject --stage`; a `todo` story, which is already pending; and a missing
    `--note`. An unknown run id is still exit 3.
  - `tldrx replay` narrates it (`story S3 REOPENED by alan — back to \`todo\` from
    \`blocked\` — "…"`), and the Build stage says so in one line, with the note, when it
    picks the story up. A reopened story is byte-identical on disk to a never-started one,
    and a narrative that showed two `changes` verdicts and then a third developer turn with
    nothing in between would read as the framework losing count.
- **`--parallel <n>` on `tldrx next` and `tldrx run auto`** — how many stories of ONE
  build wave run at once. `waves.yml` already puts every dependency in an earlier wave, so
  a wave's stories are independent by construction. Also settable per scope as
  `build: {parallel: N}` at the top of a workflow, or per stage as `parallel:` in
  `stage.yml`; the flag beats the workflow, which beats the stage file. **The default is 1
  and at 1 the executor takes exactly the path it always did** — verified byte-identical on
  the event sequence against `main`, not asserted. Above 1 the wave runs in two halves:
  developer + DoD + commit concurrently, then merge + reviewer serially in the wave's
  LISTED order, so the epic branch reads the same whatever order the machine finished in.
  The reviewer half is serial for a reason and not only the merge: a reviewer reads
  `git diff <epic>...<story>`, whose merge base moves every time another story merges into
  that epic. A red story does not cancel its siblings, but the wave ends `failed` and the
  next wave does not start. Ctrl-C/SIGTERM kills every live child, not the first.
  Budgets are untouched: the stage ceiling was already divided by
  `stories x attempts x (developer + reviewer)`, so N at once costs what N in a row cost.
- The live view gives each running story its own column — `S1 reading … · S2 $ dotnet
  test …` — in the scene, the compact one-liner and `--ui plain`. A lane leaves the line
  when its sub-agent finishes. With nothing parallel the view is what it always was.

- **`gates_policy: agent` — a gate an agent may close, over a check it wrote down.** The third
  answer to "who closes a gate", beside `human` (waits) and `auto` (the harness signs when seven
  measured conditions hold). Measured 2026-08-30 on `260830-tenancy-identity-customers`: the host
  ran a defined checklist at every gate and typed it into `approve --note "<free text>"`, where
  nothing validated it, `replay` could not render it, and `run.yml` recorded a person's name for a
  check a sub-agent had made. The evidence note (above) was the artefact; this is the gate.
  - **Strictly stronger than an auto gate, never a cheaper one.** Three things, not one: every
    one of the seven `auto` conditions unchanged and unweakened (including the `boundary`
    condition landed alongside it), PLUS no budget decision in this stage's window, PLUS an
    evidence note that parses, sources every bullet, and whose verdict is `sign`.
  - **The budget requirement is an EVENT, not an arithmetic.** A `budget.raised` or
    `budget.blocked` in `events.jsonl` at or after the stage's `started_at` falls the gate to a
    person even when the spend is comfortably under the ceiling. Condition 3 already compares
    numbers; what it cannot see is that somebody *raised* the ceiling to let this stage through,
    and a decision made to unblock a stage may not then be signed off by the machine that was
    blocked. Asserted in both directions on one fixture: the same gate closes without the event
    and falls through with it, with nothing else changed.
  - **The same door, so the trail reads the same.** A closing agent gate goes through `approve`:
    the checks are re-run off disk, `gate.by` records the note's `by:`, one ordinary
    `gate.approved` is appended, and the cursor advances. `AUTO_GATE_ACTOR` is untouched —
    `by: auto` still means "the facilitator closed it with no note but its own conditions".
  - **The note is COPIED into the run tree**, at `<phase>/gate-evidence/<stage>.md`, and that
    copy is what `gate.evidence.path` points at. `.agent/` is gitignored by spec §1, and a gate
    whose evidence lives only in a gitignored directory is a gate nobody can audit from a clone.
    A copy, not a move: the scratch original stays where the agent left it.
  - **Four fallthroughs are named in their own right**, because a person's next move differs for
    each: `questions` (a decision nobody has made), `budget-event` (a ceiling somebody moved),
    `boundary` (work nobody scoped) and `refusal` (the note's verdict is `refuse` or
    `sign-with-fixlist` — the agent doing its job, not failing at it). Any other failing condition
    reports as `condition`, a missing or broken note as `evidence`. Each is tested in isolation:
    a report that fired three at once would not answer "which of these stopped it", which is the
    first question anybody asks.
  - **`tldrx approve --as-agent [--evidence <path>]`** is the same decision taken by hand, and it
    splits the two refusals apart by exit code. **Exit 2** is "this note is broken" — fix the
    file, nothing was signed. **Exit 4** is "a person decides": the note parsed perfectly and its
    verdict is not `sign`. **Exit 1** is `--as-agent` on a stage whose policy is not `agent`: a
    run keeps the policy it was opened with, and a flag that could upgrade one at approve time
    would make the frozen policy decorative.
  - **A person may always overrule it.** A plain `tldrx approve` on an agent-gated stage works
    exactly as it does anywhere else, is recorded as the person, and writes no `evidence` key. An
    agent gate is one an agent MAY close, never one a person may not.
  - **`tldrx replay` renders the check**, not just the signature: who signed, how many files they
    read, how many citations they spot-checked and what those resolved to, how many touched paths
    they audited and how many were outside the surface, and the path to the note. Rendered from
    the note's FRONT MATTER and from `run.yml` — never from its prose, which would change the
    narrative every time somebody rephrased a sentence. A note that has gone missing is SAID to
    be missing rather than invented, and the counts `run.yml` recorded still stand.
  - **`--gates` gains a qualified form**: `--gates plan:agent,build:agent`. A bare entry still
    means `human`, so every invocation anybody has already typed means exactly what it meant. An
    unknown policy is its own usage error, distinct from an unknown stage.
  - **Additive, and asserted as such.** No shipped scope uses `agent`; it arrives via
    `--gates`, or a fork's own workflow file, and never by default. An absent `gates_policy`
    entry still reads as `human`. A gate with no `evidence` emits no key at all, so every
    `run.yml` written before this round-trips byte-for-byte through a save — asserted by
    comparing the emitter's output against the file on disk. The gate mapping never rejected an
    unknown key (measured against the reader that predates this), so a `run.yml` carrying
    `gate.evidence` still validates on an older binary; a `gates_policy` naming `agent` there
    fails loudly instead, which is the right failure — a policy the reader does not understand is
    not one it may downgrade to "sign it anyway".
  - **The emitter had to be extended, not worked around.** `emitRunYaml`'s `gate()` wrote exactly
    five keys as a flow mapping, so a sixth held in memory would have been dropped, silently, by
    the next save. 47 new tests.

- **The gate evidence note** — `.agent/<stage>/evidence.md`, plus `tldrx gate template` to
  write the blank form. This is the artefact half of the `agent` gate (design §A): a third
  answer to "who closes a gate", between `human` (waits) and `auto` (the harness signs when
  seven measured conditions hold). Measured 2026-08-30 on
  `260830-tenancy-identity-customers`: the host ran a defined checklist at every gate and
  typed `approve --note "<evidence>"` by hand, into a free-text field where nothing validated
  it and `replay` could not render it. There was no value meaning *"an agent checked it,
  showed its work, and is accountable for the check"*, so there was nowhere to put the check.
  - **Front matter is the machine half, the body is the human half** — the §2.13 story
    pattern, reused rather than reinvented. Required keys: `version gate role by at verdict
    read citations touches diff_vs_stories`; `caveats` and `recommend` are optional and
    default to `[]`. Four H2 sections in order — `Read` · `Citations checked` ·
    `Touches audited` · `Verdict` — each with at least one list item.
  - **Every bullet goes through the EXISTING §2.8 resolver.** Not a second grammar and not a
    second checker: `srcToken.ts` tokenizes and resolves, and the section rule is
    `handoff.ts`'s, lifted into a shared `validateSections` that `validateHandoff` now calls
    too. Two readers of "is this bullet sourced" drift, and the looser one would win the
    argument at exactly the moment a gate is being signed. A checklist whose own claims are
    unsourced is what `claim-sources` exists to refuse, and an evidence note is a claim about
    a claim.
  - **`unverified` REFUSES here, unlike in a handoff.** A citation nothing could check does
    not fail a stage (spec §2.8) but it is precisely what stops an AUTO gate closing (spec
    §5, condition 5). An agent gate is strictly stronger than an auto gate, never a cheaper
    one, so a `doc:` URL nothing in the workspace names cannot be what a signature rests on.
  - **Seven refusals, each with its own message and its own `kind`**, so a caller routes on
    the reason rather than on a string: unreadable or incomplete front matter · a missing
    section or one holding only prose · a bullet with no `src` token or one that does not
    resolve · `sampled > of` or `resolved + refuted > sampled` · `sampled: 0` with citations
    on record · a verdict that is not `sign` · a `gate:` naming a stage other than the one at
    the cursor. `verdict` is the kind that means "a person decides" rather than "this note is
    broken" — `sign-with-fixlist` and `refuse` fall to a human by design, and the verdict
    space is three because a reviewer can meet every acceptance criterion and still have
    found three real defects nobody wrote a criterion for.
  - **`tldrx gate template` fills what a tool can COUNT and leaves every judgement blank**:
    the gate at the cursor, the time, how many citations the §2.8 resolver found across the
    stage's declared outputs (patterns like `03-plan/stories/<id>.md` included), and how many
    touched paths the plan declares. The blank form deliberately does not validate — a
    template that parsed clean out of the box would be a signature nobody had to earn — and
    it writes no `[src: …]` anywhere, the same rule `questions lint --fix` follows. It spends
    nothing, spawns nothing, approves nothing and moves no cursor; an evidence note already on
    disk is left alone (exit `2`) unless `--force` says otherwise.
  - `validateEvidence(text, srcContext, {gate})` is the function `approve --as-agent` will
    call before it records anything. Nothing in this change signs a gate, reads a
    `gates_policy`, or writes into the run tree: the artefact layer lands first, on purpose.

- **Auto-gate condition 7, `boundary` — the stage stayed inside the surface the run declared.**
  The other six ask whether the artefact is sound and whether the work finished. None of them
  asks the question a reviewer asks first: *is this the work we scoped?* Measured 2026-08-30
  on `260830-tenancy-identity-customers` — the host ran this check BY HAND at every gate,
  because the framework ran it nowhere ("touches outside What boundary is NOT checked
  anywhere"), and that run's own S3 review surfaced the shape it was worried about: a
  Platform-layer file edited by a module story.
  - **The surface** is the union of every `file:`-kind `[src: …]` citation in
    `01-what/handoff.md` and `02-how/handoff.md`, and every `touches:` entry of every story
    under `03-plan/stories/` — or of `04-build/implicit-plan.yml` when the scope skipped Plan.
    A directory entry covers everything beneath it, which is how a story declares the files it
    is about to create and the forced companions (a lockfile, a generated client) that come
    with them. The citation half reuses `citedRepoPaths`, the derivation the implicit plan
    already builds `touches:` from — the same §2.8 tokenizer, not a second one.
  - **The measurement** is `git diff --name-only <default_branch>...<epic_branch>`, once per
    repo the plan's epics name, through the Build phase's existing git seam. Nothing is
    checked out, fetched or written, and the epic's own `branch:` is what is diffed — the ref
    `openStory` actually cut, not one re-derived here.
  - **Offending paths are NAMED**, up to eight then `+N more`, prefixed with their repo:
    `boundary=2 changed path(s), 1 outside the surface: app:platform/Auth.cs; work outside the
    declared surface is a boundary change — a human decides whether to widen the scope`.
    "1 path outside the surface" is not something anybody can act on.
  - **A human may still approve over it**, and that is the whole point: widening a boundary is
    a decision, and the framework has no basis for making it. Work nobody scoped is often the
    right work.
  - **It never refuses on an absence.** Outside Build, with no epic branch cut yet, with no
    repo on disk, with no plan, or on a run whose What cited no repo path at all, it is `n/a`
    **with the reason in the note** — a condition that could not measure must not report that
    it measured zero. Same shape as condition 6's `n/a (not a build stage)`.
  - **`tldrx-work/`, `.tldrx/` and `.agent/` are excluded from BOTH sides**, through the same
    `isStatePath` filter the implicit-plan derivation already applies. A handoff cites the
    run's own state as evidence, and in a `root_is_repo: true` workspace the state sits inside
    the product repo — neither is a boundary question.
  - **A bare citation widens the surface rather than shrinking it.** `file := [repo ":"] path
    ":" line` makes the repo prefix optional, and `citedRepoPaths` skips the bare form because
    it feeds a developer prompt, where a wrong guess puts another repo's file in front of an
    agent. Here the risk is inverted — an unattributable citation would manufacture a false
    refusal — so a bare path is admitted to every repo's surface. A check that refuses wrongly
    is a check that gets turned off.

### Changed

- **The init report is coloured and carries a roll-up.** Repo names, confidence
  (green/yellow/red), the counts and the `created`/`kept` verbs are inked, and a new
  `files N written · N created · N kept` line answers "how much of this run was
  regenerated, how much is new, and how much was mine and left alone" without reading the
  per-file list. `stripAnsi(coloured) === uncoloured`, asserted.
- `detectWorkspace` and `buildMap` take optional progress callbacks. Both default to
  doing nothing, so `tldrx map` and every other existing caller behave exactly as before.
- `tldrx init` now writes progress bytes to stderr like every other long-running command,
  so the two `build.test.ts` cases that spawn it to exercise the node seam pass `--quiet`.
  Their `stderr === ""` assertion is how a REAL warning gets noticed, and it still is.
- **`tldrx cost` is organised by ECONOMY, and prints no grand total.** `STAGE · ECONOMY ·
  MEASURED · DECLARED`, one footer per economy, and a third line for attempts that reported
  neither — no row spans both columns and nothing adds a dollar to a token. A footer that
  printed `$1.70` under a run which had also burned 1.5M host tokens is the sentence the
  label exists to stop. `--json` carries `economy` on every stage row and the set of
  economies on the run. Attempt lines are unchanged, all four token counters included, and a
  declared `--tokens` figure past a million now reads `~1.2M` rather than `~1200.0k`.

- `tldrx doctor` prints where the framework's own files are: a `framework <path>` line
  naming the installed package that ships `stages/`, `workflows/` and `templates/`, and
  saying that a project's overrides live in `.tldrx/stages/` and `.tldrx/workflows/`. The
  `/tldrx` skill says the same in two lines. Measured 2026-08-30: a real session spent
  1m22s on `find / -name build -type d -path "*stages*"` because nothing printed it.

### Fixed

- **A trainer that `cd`s no longer writes its knowledge file into a different git repo.**
  Measured 2026-08-31 on `~/scavtopia` (five repos, ten `expert train --mode light` runs): the
  `mcp` run was rejected with `mcp.md.partial was never written`, and the file had been written —
  46 lines, 9,567 bytes, complete and usable — to
  `whiteboard/.tldrx/experts/mcp/knowledge/mcp.md.partial`. The sub-agent ran
  `cd <workspace>/whiteboard` to execute that repo's declared gate command, then wrote the
  RELATIVE path the prompt had given it, and the path resolved against the repo it had `cd`'d
  into. Three costs from the one bug: **$1.23 charged for work that was finished and then
  orphaned**, a parasitic `.tldrx/` tree left inside an unrelated git repo (`git -C whiteboard
  status` → `?? .tldrx/`), and **no repair round possible** — the missing-file branch returns
  before the repair check, so this failure mode was unrecoverable by construction even with
  budget left. Fixed at both ends.
  - **Prevention: the prompt now states an ABSOLUTE output path**, workspace-root-resolved, and
    says why — "If you `cd` into a repo to run its gate command, a relative path then resolves
    against THAT repo … and throws the whole paid run away. That is measured, not hypothetical."
    Both training prompts carry it, and so does the repair round's target, for the same reason.
  - **Recovery: when the file is missing, the declared repo roots are probed** for the stray
    relative write before "never written" is said. A file found there is moved back and validated
    exactly as if it had landed correctly — recovery is not a pass, the same `parseKnowledgeFile`
    still judges it, and a recovered file that fails can still be repaired because the probe runs
    ABOVE the repair round.
  - **The note is honest and names the mess.** `recovered: the trainer wrote to
    whiteboard/.tldrx/… , inside the `whiteboard` repo — a relative `.tldrx/…` path resolves
    against whatever directory it had `cd`'d into.` The empty parasitic directories are removed
    on the way out; a directory holding anything else is **left in place and named**, with the
    `git -C <repo> status` to run, because a tool that deletes inside a repo it was never asked
    to touch is a worse bug than the one it is fixing. A repo carrying its own
    `.tldrx/workspace.yml` is skipped entirely — that file may belong to a nested workspace, and
    taking it would be theft rather than recovery.
  - When no stray is found the verdict is unchanged and now says where it looked.

- **A rejected training run records WHICH problems, not just how many.**
  Measured 2026-08-31: `components` failed with 12 problems for $1.02, and `training.jsonl` — the
  durable record — held only the string `"…does not validate — 12 problem(s)"`. The twelve went
  to stdout, where five of them were printed and the rest elided as `(+7 more)`. Anyone who had
  not captured stdout, which is anyone running this normally, could not tell why a $1.02 run
  failed. The list is now persisted twice.
  - **On the ledger**: `check.failed.payload` carries `problems` (the rendered per-problem
    lines), `problems_total`, `errors`, and `task`. The list is fitted to the record's 4 KB
    payload cap and reports `problems_omitted` when it does not fit — an append that THROWS on
    an oversize payload would take the cost line down with the reasons, which is the opposite of
    the point. The repair round's own `check.failed` carries what it sent back, so "what did the
    repair actually fix" is answerable later.
  - **In the file**: `<area>.rejected.md` now opens with a `# REJECTED` header — expert/area,
    mode, timestamp, dollars spent, error and warning counts, and every problem, uncapped —
    above the trainer's bytes exactly as written, separated by a rule. A quarantine with no
    verdict (a sub-agent that died, a rollback) gets no header: there were no reasons to state
    and inventing them would be inventing the reason.

- **`## Sources` is now taught as prose with the refused shape shown.** Same batch: four of the
  five problems the `components` report printed are one mistake four times — `L34 Sources: no
  [src: …] token`, `L35`, `L36`, `L37`. The trainer had written the recap as a bulleted list.
  The prompt already said "**Sources** — prose", and a writer who reads that as a style note
  writes bullets, because bullets are what the other four sections take. The rule it collides
  with is genuinely file-wide — `parseKnowledgeFile` requires a `[src: …]` token on EVERY list
  item in every declared section, recap included, and an unsourced one is an error that rejects
  the file whole. Both prompts now show the accepted prose next to the refused bullets, the same
  move the execution-claim rule makes. Whether an unsourced recap bullet should be a warning
  rather than an error is a real question and is deliberately NOT settled here.

- **A rejected knowledge file gets ONE repair round before the money is thrown away.**
  Measured 2026-08-30 on `~/scavtopia`: `tldrx expert train dotnet-stack --area dotnet --mode
  light` spent **$1.69**, the trainer wrote `knowledge/dotnet.md.partial`, and the validator
  refused it for **two** bullets that asserted an execution (`exit 0`) and cited a file line.
  The file went to `dotnet.rejected.md`, nothing reached `competencies.yml`, the status did not
  move — $1.69 for zero evidence, over a mistake the checker could name in one line and the
  writer could have fixed in one edit. `expert train` now hands those exact problems back to the
  same trainer for one more turn before anything is quarantined.
  - **A fresh spawn carrying the ORIGINAL prompt**, not a resumed session: `spawnAgent` has no
    `--resume` and the session id is captured for the ledger only. Appending to the original
    prompt is what keeps the repair possible at all — the citations to be fixed point into files
    that were inlined in that prompt and nowhere else — and the byte-identical prefix reads the
    cache the first turn paid to create. The appended `# REPAIR ROUND` section carries the
    numbered verdict, the rejected file with a line-number gutter whose numbers are the `L<n>`
    numbers in the verdict, and the reminder that deleting an offending bullet is a legal fix.
  - **One round, and the gate does not move.** The repaired file goes through the same
    `parseKnowledgeFile`, same shape, same scope. A second failure rejects exactly as the first
    used to, quarantines the same way, and returns the same exit `5`. An unsourced claim still
    cannot become evidence; it has simply been told once that it is unsourced.
  - **Paid out of `--max-usd`, never on top of it.** The repair turn's ceiling is
    `min(this sub-agent's share, whatever is left of the run's ceiling)`. Below the `$0.25`
    floor it does not spawn and says so — a cold `claude -p` that dies on
    `error_max_budget_usd` before its first reply costs money and produces nothing.
  - **The operator is told while it happens**, so an extra sub-agent never spends silently:
    `repairing: 3 problem(s) sent back to the trainer — one round, $0.31 of the ceiling left`,
    then either `repaired: the second file validates` or `the repaired file does not validate
    either (2 problem(s)) — one round is all there is`. Both turns land in `training.jsonl`; the
    repair as `task: "code:repair"`, `repair: true`, with the number of problems it was sent.
  - Not on `--commit`: there the sub-agent belongs to the host session and this process spawned
    nothing, so repairing is running `--commit` again. Not for a file that was never written —
    there is no verdict to send back.

- **The execution-claim rule is now TAUGHT, with an example and a counter-example.** The same
  $1.69 run is the evidence that stating it once in a paragraph does not work. Both training
  prompts — the spawned one and `--print-prompt` — now give the four literal shapes the checker
  looks for (`exit <n>`, `<n>/<n> passed`, `build is green`, and the bare word `measured` in the
  sentence itself), one conforming line, one refused line, and why the refused one is refused: a
  `workspace.yml` line DECLARES a command and is not a record of running it. Two further gaps
  closed: **not making the claim** is named as the other legal answer (the trainer that failed
  had no command in reach of the sentence it was writing, so "run it and cite it" was not
  actionable), and the `(measured)` **annotation** is explicitly exempted — §2.3 asks for it on
  every bullet, `\bmeasured\b` is one of the patterns, and nothing had ever told a writer that
  `claimCheck` strips the annotation before it looks. The runs-mode prompt never stated the rule
  at all, though the validator has always applied it to both files; it does now.

- **`duplicate src` is documented as non-fatal, and the rejection report stops implying
  otherwise.** It always was a warning — one call site, one `severity: "warning"`, one validation
  path for both shapes — but the report did not say which lines were fatal and the headline
  counted warnings as problems, so the same $1.69 run read as "3 problems" when only 2 rejected
  it and the third was a duplicate that costs one bullet its evidence row. `describeKnowledgeIssues`
  now lists errors first, prefixes warnings with `warning:` exactly as `knowledgeWarnings` does,
  and the headline counts errors only (new `knowledgeErrors`). The reason it is a warning is
  recorded where the message is emitted: "earns no second row" is a statement about scoring, not
  about honesty, and throwing away every other finding in a file over a repeated citation is not
  rigour.

- **A developer that FAILED is no longer recorded as a consumed attempt.** The
  developer-side sibling of the reviewer fix below, found by the same run on 2026-08-30.
  Five developer spawns on `260830-tenancy-identity-customers` died with
  `Reached maximum budget ($0.30 | $0.40 | $0.50 | $0.90 | $1.50)` before delivering
  anything the pipeline could see, and every one was settled as the story `blocked` —
  terminal in-run — so six of seven stories were reported as tried and failed when five of
  them had never been tried. A failed developer spawn now puts the story back at the status
  it held BEFORE the attempt (`todo`, or `review` when a reviewer had asked for changes),
  keeps its worktree, spends no attempt, and stops the in-process loop rather than buying
  the same error twice. Its `check.failed` carries `check: "developer"`,
  `status: "error"` and the error verbatim as `detail`; the review log, the operator line
  and `retro.md` all say the developer **FAILED**, never that anything was reviewed. The
  next `tldrx next` — headless or `--prepare` — offers the story again as a fresh developer
  run at the **same attempt number**. A developer that RAN and produced work its DoD faulted
  is a different thing entirely and still blocks, unchanged, as do two `changes` verdicts.
- **Runs recorded by the old code pick those stories back up.** A `blocked` story whose last
  attempt recorded no commit, no check of any kind and no reviewer — the only trace the old
  code left, the error itself having gone to `run.yml` alone — is read as the errored spawn
  it was and offered again, with `S2 was blocked by a developer that FAILED (…) — that was
  never an attempt, so it is offered again`. It is paired with the story's own plan, because
  a story with an empty dod block blocks with exactly the same event shape and that block is
  a plan bug. Measured read-only against the live run: `tldrx next --prepare` now offers
  **S2** and, after it, S5, S4, S6 and S7 — while S3, which was blocked by two genuine
  `changes` verdicts, stays blocked.
- **The auto gate will not sign a Build stage whose stories are not all `done`.** Its five
  conditions were all about the ARTEFACT — citations, questions, money, status — and none of
  them looked at what the stage was for. On the live run all five held while six of seven
  stories sat `blocked` and the epic branch carried one story's work, and the gate signed the
  stage, then signed it again after a human revoked it. A sixth condition now reads the story
  statuses where they live, refuses with `stories=1 of 7 done — S2:blocked, S3:blocked, …`
  and falls through to the human gate. A person may still approve over blocked stories —
  what is worth shipping is their judgement — and outside the Build phase the condition is
  measured as `n/a` and always holds.
- **A merge that moved nothing is no longer called "merged".** `git merge --no-ff` of a
  branch that is already an ancestor exits 0 and says "Already up to date", and the handoff's
  Gate section rendered that as landed work: on the live run it read
  `(S1, S3, S5, S4, S7 merged)` when the epic tip carried only S1's commits. The executor now
  counts what the merge is about to move BEFORE it moves it — afterwards it cannot, because a
  merged branch is an ancestor either way — and the Gate line, the story Finding and the
  review log all say “added nothing — identical to `epic/x`” for a count of zero.
- **A reviewer that FAILED is no longer recorded as a reviewer that asked for changes.**
  Found live 2026-08-30 by the first `feature`-scope run to reach Build: the headless
  reviewer of a 39-file, +1879-line story was given $0.26, died mid-read with
  `Reached maximum budget ($0.26)`, and the executor wrote that transport error down as
  `verdict: "changes"`. That single line spent the story's one requeue, sent a fresh
  developer at code nobody had faulted, and would have blocked the story after a second
  reviewer hit the same wall — with **zero review ever performed**. A failed reviewer now
  settles the story at `review` with `verdict: "error"`: the attempt counter is untouched
  (only a real verdict spends it), the `check.failed` event carries the error as its
  `detail` plus `verdict: "error"` so no ledger counts it as changes-requested, and every
  operator-facing line, the review log and `retro.md` all say the reviewer **FAILED**.
  Fail-closed is unchanged — an unfinished review is still never an approval. Inventing the
  verdict is what stopped.
- **`tldrx next` on a story whose review errored re-runs only the REVIEW.** The diff is
  already committed and merged and its DoD went green, so there is nothing for a developer
  to redo. Both doors do it: the headless path and `tldrx next --prepare`, which used to
  hand the host session a full "attempt 2" developer bundle. The commit and the DoD results
  come back out of `events.jsonl`, so the resumed reviewer sees the same proof the first one
  did — including on the live run, where a `task.started` for the attempt that was never owed
  sits AFTER the DoD it did not run, and must not erase it. Runs recorded by the OLD code resume too — a `verdict: "changes"` whose `detail` is
  one of the framework's own transport errors is read as the failure it was, including a
  story already left at `in_progress` by a wrongly-prepared attempt 2.
- **The Build executor reads `03-plan/budget.yml`.** The Plan writes a per-story price map,
  the Plan gate validates it, and until now **nothing read it**: the executor split its
  stage into equal shares, so the story priced at $4.75 and the one priced at $0.75 both got
  $1.03. A priced story now gets `price / (attempts x (developer + reviewer))` as its
  developer ceiling and a quarter of that as its reviewer's; an unpriced one keeps the
  uniform share; prices adding up to more than the stage are scaled down proportionally. A
  `budget.yml` that will not parse or validate is an advisory on stderr, never a refused
  build.
- **A reviewer is never given less than $1.00.** Whatever the arithmetic says, clamped by
  what the stage has left and by `per_agent_max_usd`. A reviewer that cannot finish reading
  the diff approves nothing and blocks nothing — it converts the entire developer turn
  beside it into a story stuck at `review`, which is what $0.26 did on 2026-08-30.
- **`tldrx cost` no longer prints `0 in · 0 out · 0 cache write · 0 cache read` for a turn
  the host declared tokens for.** `tldrx next --commit --tokens 342527` writes that number
  onto the task row and the `agent.result` payload, and the cost view ignored it. It now
  renders as `~342.5k declared (host session)`, kept apart from the four measured counters
  rather than folded into them: nobody measured those, and four zeroes claim the turn used
  no tokens.
- **A stage whose declared outputs are a SHAPE no longer fails while the files sit next to
  the error.** Found live 2026-08-30 by the first `feature`-scope run to reach Plan: the
  stage wrote `03-plan/epics/E1.md` and `03-plan/stories/S1.md`..`S7.md`, and
  `tldrx next --commit` refused it with "`03-plan/epics/<epic>.md` was declared as an output
  but does not exist on disk; `03-plan/stories/<id>.md` was declared as an output but does
  not exist on disk". Plan cannot name its outputs — it does not know how many stories there
  will be until it has written them — so `stage.yml` declares the shape, and every
  filesystem call was asking `existsSync` about a path with a literal `<id>` in it.
  A declared path holding an angle-bracket token is now a **pattern**: it matches any file
  in that directory with the pattern's fixed prefix and suffix, resolved against the run dir
  and then the workspace root, in the same "first base wins" order everything else uses.
  The fix is in `paths.ts`, at the seam, not in the validator: `present`/`missing` count a
  pattern by its matches (so a stage taking `stories/<id>.md` as an INPUT gets past the gap
  check), the prompt is handed the concrete files rather than the shape, the previous-attempt
  inline shows every one of them, and `--dry-run` reverts each file it matched and names it.
  `{repo}` expansion is untouched and still runs first, so `{repo}` and a token compose.
  Plain paths behave exactly as before, down to the wording of their failure.
- A pattern output that matches nothing now fails honestly — "`03-plan/stories/<id>.md` was
  declared as an output but **no file matches it on disk**", rather than claiming a file
  nobody ever named was looked for and not found. Its `sections:` contract binds **every**
  matched file, and the failure names the concrete file that broke it, not the shape.
- **`tldrx run estimate` prices cache traffic, which is where the money actually goes.**
  Measured 2026-08-30 on a real workspace: a What stage was estimated at **$0.33** and the
  one comparable real attempt cost **$1.70** — **5x**. That attempt's ledger says why: 56
  input · 29.0k output · **166.3k cache write** · **3,747.1k cache read**. The estimate
  multiplied input and output only, so it was adding up the two columns the money was not in.
  Both cache counters had been on every `agent.result` since wave N and `modelPrices.ts` had
  carried the multipliers the whole time — nothing needed new data, only arithmetic that used
  it. The estimate now prices four terms: measured prompt tokens at the input rate, plus the
  **median** cache write (**1.25x** input), cache read (**0.1x** input) and output of past
  attempts at the same stage id, falling back to attempts at any stage and **naming which
  sample it used**. It prints the breakdown —
  `input ~189 · cache write ~166k · cache read ~3,747k · output ~29k → ~$1.46` — and keeps
  saying "ESTIMATE" in words. With no history the old behaviour stands (it refuses to guess
  the output half) and it now says `cache traffic not modelled — first attempt of this kind`
  rather than pricing a silent zero. The input and cache-write terms overlap on a cold first
  turn, so a first attempt leans high; that is stated in the output's own honesty line, not
  corrected away.
- **`tldrx cost` shows the cache write / cache read columns on every attempt line**, not only
  on stage and run totals, and no longer hides them on a stage that ran once — previously an
  attempt line carried cost, task and model and nothing about where the money went.

- **tldrx state survives the project's own `.gitignore` rules, and `doctor` detects a rule
  that shadows it.** Found by a real user 2026-08-30: their repo carried the stock .NET
  `[Ll]og/` ignore, which swallowed `tldrx-work/<run>/04-build/log/S1.md` — the Build phase's
  per-story review log, which spec §1 marks committed and the handoff cites as
  `[src: 04-build/log/<id>.md:1]`. Nothing errored; the file was written, `git status` stayed
  quiet, and a teammate's clone never got it. `init`'s managed block only ever ADDED ignores,
  so any pre-existing project rule (`log/`, `docs/`, a `*.yml` in a subdir) could hide state
  and nothing noticed. The block now opens with `!tldrx-work/`, `!tldrx-work/**`, `!.tldrx/`
  and `!.tldrx/**` — the bare pair and the `**` pair are both needed, because gitignore cannot
  re-include a file whose parent directory is excluded — and the framework's own ignores follow
  AFTER them, since a later pattern wins. Measured with `git check-ignore -v` against a repo
  carrying `[Ll]og/`, not asserted from memory: the story log comes back not-ignored while the
  product's `Logs/build.log`, `tldrx-work/*/.lock` and `.tldrx/cache/` stay ignored. Re-running
  `init` upgrades a block written before this in place, markers and neighbouring rules kept.
- **`tldrx doctor` now says when a rule outside that block is still hiding state.** It runs
  `git check-ignore --verbose --no-index -z` over four paths that must be tracked — the newest
  run's `run.yml` and `events.jsonl`, a synthetic `04-build/log/` probe, and
  `.tldrx/memory/facts.yml` — and prints each offender with the rule's own `file:line:pattern`,
  so a `.git/info/exclude` or a nested `.gitignore` is named too. A warning: it never moves the
  exit code, which is about the tools this machine has. `--json` gains `gitignoreShadow`, where
  `null` means no workspace was scanned rather than nothing found.
- **The `## Inputs` preamble no longer claims files the budget dropped.** Measured on a
  real Build prompt, 2026-08-30: 9 of 15 declared inputs were inlined, the other 6 carried
  "It exists on disk; do not guess at its content" — and the preamble above them still read
  "Their full content is inlined below, so there is nothing to open and nothing else to
  find." The two documents the run existed to edit were among the six. The preamble is now
  conditional in every prompt that has one (stage prompts and the developer prompt share one
  renderer): with everything inlined it is the sentence it always was; with anything dropped
  it is `Inlined below: <n> of <m> declared inputs.` followed by "The rest exist on disk —
  READ them at the listed paths before relying on them; do not guess: <list>".
- **A touched path the story's worktree cannot read is flagged as such.** The developer works
  in a worktree of the story branch, so a path that exists in the repo but is not committed
  at that branch is unreadable there — and `existsSync(worktree/path)` called it a file the
  story creates. Build now asks git (`git cat-file -e <branch>:<path>`) and marks it `NOT in
  this worktree — its content is only what the handoff quotes`, plus one stderr line per
  path: `warning: input <path> is not committed, so the story worktree cannot read it`. A
  path that exists nowhere is still "does not exist yet — this story creates it".
- **The story's own goal wins the developer prompt's inline budget.** `touches` was spent in
  list order, so on that same run `AGENTS.md` — cited once in passing — was inlined whole
  and the two documents the goal named were in the dropped tail. Touched paths the story's
  `goal`, acceptance criteria, test plan or title NAME now sort first into the 64 KB; a brief
  that names nothing changes no order at all.
- **The developer is told to run an acceptance criterion's embedded pattern BEFORE it
  edits.** Found on a real run's second Build of 2026-08-30: a derived criterion carried a
  literal grep (`` Pending `DECISIONS-NEEDED.md` # ``, backticks included) and the markers
  it was meant to count had been written three different ways, so it reported 0 against two
  files that still held five real markers — the in-session driver only caught it by
  measuring the inventory by hand. The developer prompt's `## Investigate` list now carries
  the rule verbatim: validate the pattern against the current tree first; a criterion that
  reports zero while the goal says the work exists is broken, so measure the real inventory,
  use THAT as the completion test, and record the discrepancy in the handoff. The criterion
  text itself stays data the story may not edit. `stages/build/stage.md` says so too.
- **The implicit story no longer `touches` tldrx's own state.** `touches` is derived from
  every repo path the What handoff cites, and a handoff cites state as evidence: measured
  2026-08-30, 13 touched paths of which three were `run.yml`, a `.tldrx/triage/**/split.yml`
  and a `.agent/**/prompt.md`. The developer prompt inlines every touched path and calls a
  change outside `touches` a plan deviation, so those three read as permission to rewrite
  the run's own bookkeeping. Anything with `tldrx-work`, `.tldrx` or `.agent` as a path
  segment is now dropped from `touches` and recorded in `notes:` as `excluded <path> from
  touches: tldrx state is never story-writable`. Product documents are untouched.
- **A document your answer settles now joins the implicit story's `touches`.** Measured on a
  real run, 2026-08-30: the run existed to settle six ADRs, the owner answered all six, and
  the one thing the story could not edit was `ADR-D013-DELIVERY-ZONE-GEOMETRY.md` — the What
  handoff never cited the file, `touches` is built from what the handoff cites, and the
  developer prompt says a change outside `touches` is a plan deviation. The plan's own
  `notes:` said so: "F010 settle no touched document". Build now reads the mapping rule
  backwards as well — a file whose name carries a decision key (`ADR-D013-*.md`,
  `decision-7.md`) that a fact of this run names is added, searched for beside the
  already-touched files first and then across the repo, under the same ≤24 cap — and writes
  `added <path> to touches: settled by F<n>` into `notes:`. A document no fact names is
  never added.
- **The developer gets the WHOLE answer.** `.tldrx/memory/facts.yml` capped a fact at 300
  chars and `captureAnswers` writes one as `"<question> — <answer>"`, so on that same run all
  six answers were cut and four lost the clause naming the ADR they settle — including the
  words "Accepts ADR-D009 as written." The cap is now 2000 (spec §2.5; the bound only moved
  outwards, so every facts.yml already on disk stays valid), a cut fact ends in ` …` and
  carries `truncated: true`, `01-what/questions.md` is a declared input of the implicit story
  and is inlined into the prompt, and each apply-bullet quotes the full `[Answer]:` text and
  cites both the fact and the line it came from: `[src: F010; 01-what/questions.md:82]`.
- **The implicit story's goal is the work, not the What's stale scoping.** With answered facts
  the `goal:` list holds nothing but the apply-bullets, and the What handoff's Decisions move
  to a `context:` list rendered under `## Context (from the What stage)` — after the objective,
  labelled background, explicitly not a task. Before this, a run opened to get six decisions
  answered told its developer, as its stated goal, "Out of scope: selecting an answer on the
  owner's behalf … every relevant ADR is status `proposed`". The plan note now names the facts
  the story is for (`… applies the run's answered decisions (F005–F010) …`). With no answers
  nothing moves: the What's decisions are still the goal.
- **`tldrx next --prepare --discard-pending` re-derives an implicit plan**, instead of
  re-rendering the same story. The flag was handled only for stages with no executor, so on
  Build it did nothing at all: `04-build/implicit-plan.yml` is written once and read forever
  after, and re-preparing could not pick up a fix. It now bins the bundle's `pending.json`,
  `result.json` and `result.raw.json`, derives the plan again from the handoff and the answers
  as they stand, and prepares a fresh bundle — reusing this run's own epic branch and story
  worktree rather than re-cutting or refusing them. It refuses to rewind a plan something has
  been built off (recorded evidence, a settled story, or a commit on `story/<run>/S1` beyond
  the epic) and prints which of those stopped it.
- **The dirty-tree check ignores tldrx's own state (`tldrx-work/`, `.tldrx/`).** In a
  `root_is_repo: true` workspace the framework's state lives INSIDE the product repo, so
  Build refused the files it had just written itself. Measured 2026-08-30: `tldrx next
  --prepare 260830-decisions-gate` exited 2 with `repo \`aparece-v2\` has 4 uncommitted
  change(s) on \`main\``, and all four were tldrx's — `run.yml` and `events.jsonl` (rewritten
  on every `next`), `.lock` (the run lock) and `04-build/` (the implicit plan written seconds
  earlier). A user's uncommitted answers under `tldrx-work/` blocked it the same way, though
  those are committed on the user's cadence, not as a precondition of Build. Product dirt
  still refuses exactly as before — same message, same fix — and the message now lists only
  product paths; when the only dirt was state, one line says how many files were excused. A
  story commit excludes the same two paths by pathspec: a story worktree is a checkout of the
  same repo, so `git add -A` could otherwise sweep the run folder into the diff a reviewer
  reads (measured: it did). Multi-repo workspaces, whose state is a sibling of the repos
  rather than inside them, are untouched.
- **A scope that skips the Plan phase can Build.** `docs`, `hotfix`, `performance`,
  `prototype` and `security-patch` all list `build` in `stages:` and `plan` in `skips:`, and
  every one of them was a dead end: `stages/build/stage.yml` declares `03-plan/waves.yml` as
  an input and the executor's first act was to load `03-plan/`, so a real `docs` run parked
  at `04-build (ready)` could only fail its own Build stage with `03-plan/ does not
  validate — stories/: the Plan wrote no stories`. Build now writes the one story that
  decision implies into `04-build/implicit-plan.yml`, deterministically and with no model
  involved: title from `run.yml`, `goal` from `01-what/handoff.md` § Decisions verbatim
  (`[src: …]` tokens kept), `acceptance` from `01-what/success-metrics.md`, `touches` from
  the repo paths that handoff CITES and that exist (≤24, first-cited order, a citation with
  no repo prefix skipped rather than guessed at), `dod` from the commands `workspace.yml`
  declares for the roles the scope calls for, and `budget_usd` from the Build stage ceiling.
  A real `03-plan/` always wins. `tldrx next` prints one line naming the reason, and
  `tldrx run status` prints `plan: implicit (scope skips Plan)` so a synthesised plan never
  reads like one a person approved. The plan carries the work **forward**: bullets whose
  subject is the What stage's own deliverable are dropped on five literal signals
  (`questions.md`, `### Q`, an `01-what/` path, a question id, the run's-questions
  vocabulary) with every drop and its signal recorded in the story's `notes:`, every
  live fact stamped with this run adds
  `Apply <fact> to the touched files [src: F<n>]` to `goal`, and `acceptance` gains a check
  that each document one of those facts settles — the fact's text mentions that file's ADR
  id or decision number — no longer reads `Status: proposed`. A mapping that cannot be
  derived is reported in the story's `notes:` and falls back to "apply every listed fact;
  leave a one-line note per file saying which fact changed it", never to a guess. A fact
  cut at §2.5's 300-char cap is matched against the full `[Answer]:` behind it in
  `01-what/questions.md`: measured on a real run, `captureAnswers` had sliced the ADR
  clause off four of six facts, so 2 of 6 mapped on the stored text and 6 of 6 map with
  the answer. The grep in that criterion is complete or names `notes:` wholesale — a
  `(+1 more)` inside a command is something a person pastes and reads wrong. The
  developer prompt states plainly that Plan was skipped and this story applies the run's
  answered decisions.
- **`skips:` in a workflow is read rather than decorative.** The schema declared the key and
  the loader dropped it, so nothing could tell "the Plan phase has not run yet" from "no Plan
  phase was ever going to run" — a distinction that cannot be made from disk, since both look
  like an absent `03-plan/`. `WorkflowPreset.skips` now carries it down to `StageSpec`.
- **A DoD command is looked up by its `workspace.yml` KEY, not by matching the command text.**
  Measured on a real .NET workspace: `lint: dotnet format --verify-no-changes` has no "lint"
  anywhere in the string, so a text match silently found nothing and would have handed a docs
  run an empty Definition of Done. `WorkspaceContext.commandRoles` keeps the keys.
- Build's declared `03-plan/…` inputs are treated as satisfied when the scope skips Plan, and
  **only** those: every other missing input is still exit 1.

### Verified, not changed

- **`tldrx expert train` already exits nonzero when a training fails.** The 2026-08-31 batch
  report measured shell `EXIT=0` on all ten invocations, including the three that failed their
  check — but nine of those ten ran on a build that predates this one (`dist/tldrx.js` was
  rewritten mid-batch at 05:40Z). On the current source the code path is intact:
  `runTraining` returns `EXIT_AGENT_FAILED` (5), `expert train` returns `outcome.code`,
  `dispatch` returns it, and `bin/tldrx.ts` does `process.exit(await dispatch(...))`. Now pinned
  by three tests that drive the REAL CLI as a subprocess with a fake `claude` on PATH and assert
  the PROCESS exit code — one for a file that does not validate, one for a file that was never
  written, one for the passing case — because "`runTraining` returns 5" and "the process exits
  5" are two different claims. Falsified before being trusted: making `expert train` return
  `EXIT_OK` breaks two of the three.


- **The walk already skips vendored and generated trees**, and always did: `SKIPPED_DIRS`
  in `detect/walk.ts` covers `node_modules`, `dist`, `build`, `out`, `bin`, `obj`,
  `target`, `.venv`, `Pods`, `.next`, `.expo`, `coverage` and more, plus every
  dot-directory below the root, and it is honoured by `walkFiles` (so by `countCodeFiles`
  and `readSourceTree`) and by `findRepos`. There are now tests that say so: a fixture with
  a `.ts` file planted in each of those trees, and a real git repo inside `node_modules`
  that must not be reported as a workspace member. The slow part of `init` was never the
  walk — it is `graphify update`, once per repo.

## 0.3.0 — 2026-08-30

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
