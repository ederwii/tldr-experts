# The dashboard model

`tldrx dashboard` reads the workspace into **one plain JSON document** and then
draws it. Those are two steps and two files, on purpose:

| Step | File | What it does |
|---|---|---|
| read | `src/core/dashboard/model.ts` | files → `DashboardModel` |
| draw | `src/core/dashboard/render.ts` | `DashboardModel` → HTML, in the browser |

**The drawing happens client-side, and only client-side.** Both commands emit the
same document: an empty `<main>`, the model inline in a
`<script type="application/json" id="model-data">`, and the renderer beside it.
`tldrx dashboard --static` writes that file and stops. The live server serves it
at `GET /`, the model alone at `GET /model.json`, and pushes a `reload` when a
file changes; the page re-fetches the model and redraws itself. There is exactly
one template in the product and exactly one place it runs.

`render.ts` is TypeScript so `tsc --strict` holds the markup to the types below —
rename a field here and the build breaks rather than a panel silently going
blank. It reaches the page through `Function.prototype.toString()`
(`clientRenderer()`), which is why every `dash*` function is closure-free: it may
touch nothing but its own arguments, its own locals and the others in the set.
`test/dashboard-render.test.ts` evaluates that serialised source in an empty scope
and demands it render byte-identically to the typed original.

**This is the seam a redesign replaces.** Anyone rebuilding the rendering layer
targets the shape below; nothing here needs the current markup, the current CSS,
or a build step. Fetch `GET /model.json` from the running server and you have all
of it.

## Rules the model keeps

- **JSON only.** Strings, numbers, booleans, `null`, arrays, plain objects. It
  survives `JSON.parse(JSON.stringify(model))` unchanged, and a test says so.
- **Absent is `null`, never missing.** A field that has no value is present and
  null, so a consumer never has to distinguish "not set" from "not supported".
- **`modelVersion` goes up only when a field is removed or changes meaning.**
  Adding a field does not bump it.
- **No markup, with one exception.** `phases[].handoffHtml` is a handoff's
  Markdown already converted to HTML (headings, lists, inline code) with external
  links demoted to visible text — the page must contain no fetchable URL. Style
  it; do not re-parse it.
- **Read-only.** Nothing in the model is a command, an action, or an id you can
  POST back. There is no write path.

## Top level

| Field | Type | Meaning |
|---|---|---|
| `modelVersion` | number | `3` today. `1 → 2`: `pendingQuestion` and `pendingGate` became aliases of `waiting` and no longer report an open question, or a gate object, that the run is not actually stopped on. `2 → 3` (#60): `runnable` reads `true` for a run that has STARTED and was proposed to follow an unfinished sibling — a proposal recorded before either run existed cannot un-start a running run. Additions never bump it, and #85 is the case that tested the rule: it gave the model two new files and eight new fields and stayed at **3**. `spentUsd` was the field with a case to answer, because a consumer reading it alone is demonstrably wrong about a host-attended run now that the page can show the token ceiling beside it — but it is computed from the same `run.yml` key, holds the same number, and has meant "METERED dollars, a lower bound when `unmeteredTasks > 0`" since v3. A field that gained NEIGHBOURS did not change meaning. #93 stayed at **3** again and by the same rule: `watch`, `preflight` and `keepWorktrees` are three more additions, and nothing that already existed reads differently than it did at v3 — the argument the other way is that this doc used to promise, under *What is NOT in it*, that two named files were unread, and that promise is now void. But a documented absence is not a field, and no field's meaning moved. #103 stays at **3** for the third time: `spend`, `nextAction`, `lastEventAt`, `lastEventFrom` and `ageSeconds` are five additions, and the field with a case to answer is `spentUsd` again. It is not answered any differently: it is still the same `run.yml` key, still the same number, and still "METERED dollars, a lower bound when `unmeteredTasks > 0`". What changed is that the page now says out loud how big that bound is. A consumer that read it as a total was wrong before this wave and is wrong by exactly the same amount after it. |
| `generatedAt` | string | ISO-8601, to the second, when the files were read. |
| `root` | string | Absolute path of the workspace that was read. |
| `workspace` | string | Its basename — what the page calls itself. |
| `workspaceFound` | boolean | `false` when there is no `.tldrx/` at `root`. The page says so instead of looking empty. |
| `live` | boolean | `true` when the watching server produced it, `false` for a static export. |
| `maxLevel` | number | Highest competency level (spec §2.6), so a renderer never hard-codes it. |
| `maxAttempts` | number | Attempts a Build story gets before it blocks (`MAX_ATTEMPTS`), so a renderer never hard-codes it either. It travels as data for a mechanical reason: the `dash*` functions are serialised into the page and run there closure-free, so a constant one referenced by name would be a `ReferenceError` in the browser. |
| `runs` | `Run[]` | Newest first (run ids are date-prefixed). |
| `order` | `string[]` | Every run id in the order a human should work through them — topological on `dependsOn`, runnable first, then newest-updated. The head is the run to do next. `runs` stays newest-first, so a renderer can offer either. |
| `chains` | `string[][]` | Root-to-leaf dependency paths, for an `A → B → C` rendering. |
| `experts` | `Expert[]` | Alphabetical. |
| `faq` | `FaqEntry[]` | The how-to, as data. |

### `chains`

Every arrow is a real `depends_on` edge, so a fork prints **one chain per
branch** rather than one flattened topological order implying a sequence nobody
asked for. Chains of one are omitted (a run with no dependants and no
dependencies is not a chain), and the list is capped at `MAX_CHAINS` so a dense
graph cannot blow the page up. A dependency that names a slug with no run in
this workspace is not an edge, so its dependent appears as a root — `blockedBy`
still carries the slug, which is where that fact belongs.

## `Run`

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Run folder name, e.g. `260901-scoreboard`. |
| `title` | string | May be `""`. |
| `scope` / `workflow` | string | From `run.yml`. May be `""`. |
| `repos` | `string[]` | Repos the run touches. |
| `status` | string | `run.yml` status, e.g. `awaiting_gate`. |
| `updatedAt` | string \| null | ISO-8601. |
| `cursor` | string \| null | `"<phase> / <stage>"`. |
| `spentUsd` / `ceilingUsd` | number \| null | Dollars. Format them; the model does not. `spentUsd` is METERED spend and is a **lower bound** whenever `unmeteredTasks > 0` — read the three fields below with it. |
| `attendedBy` | string \| null | `"host"` when a host session drives the turns (`run.yml` `attended_by`), null when the framework may spawn. |
| `unmeteredTasks` | number | Turns whose cost nobody declared (`cost_usd: null`, in-session `--commit`). |
| `hostTokens` | number | Host-session tokens declared with `--tokens`. A **different currency** — never add it to dollars, there is no exchange rate. |
| `spend` | `Spend` | **Both economies in one record, with the half nobody metered named rather than implied** (#103). The three fields above are unchanged; this is the one that says how much of the run they can see. See below. |
| `lastEventAt` | string \| null | ISO-8601. When anything last happened: the `ts` of the **last line** of `events.jsonl`, or the file's mtime when nothing in it parses. Null when there is no ledger at all. |
| `lastEventFrom` | string | Which of the two: `"event"` \| `"mtime"` \| `"none"`. Named, because an mtime is a **weaker fact** — the file was touched, which is not the same as the run moving. |
| `ageSeconds` | number \| null | Seconds between `lastEventAt` and the model's `now`. Null when there is no timestamp. **No threshold is baked in** — nothing here decides what "stale" means. Not clamped either: a ledger written after `now` reports a negative age. |
| `stagesTotal` / `stagesDone` | number | `done`/`failed`/`skipped`/`cancelled` count as done. |
| `percent` | number | 0–100, rounded. |
| `waiting` | `Waiting` | **What this run is waiting on.** The one field to read. |
| `nextAction` | `NextAction` | `waiting`, taken apart into the pieces a card renders: who, where, and the command. A **projection** of `waiting`, never a second derivation. See below. |
| `pendingGate` | string \| null | Stage id of the gate the run waits on. **Derived alias** of `waiting` — see below. |
| `pendingQuestion` | string \| null | `"<Qid> · <title>"` of the question the run stopped for. **Derived alias** of `waiting`. |
| `dependsOn` | `string[]` | Runs this one was proposed to follow (`run.yml` `triage.depends_on`), resolved from slugs to run ids. A slug with no run in this workspace keeps its raw slug. |
| `blockedBy` | `string[]` | The subset of `dependsOn` that is not `done`. Empty means nothing blocks it. |
| `started` | boolean | This run has left `pending` — work has observably begun (#60). Read it with `blockedBy`. |
| `runnable` | boolean | Nothing that still applies blocks it **and** a human could move it right now. |
| `path` | `Stage[]` | The execution path, in `run.yml` order. |
| `phases` | `Phase[]` | Per phase: its handoff and its open questions. |
| `plan` | `Plan` \| null | Stories, epics and waves, when the Plan phase wrote them. |
| `build` | `Build` \| null | What the Build cut on disk (`run.yml` `build`): `branchModel` (`"per-epic"` \| `"integration"` \| null when the run predates the key — which is **not** the same as `per-epic`) and `epicBranches` (`string[]`). Null until a Build stage cuts or adopts a branch. |
| `watch` | `Watch` \| null | **The Watch phase's watcher cards** (#93) — null when the run has written none, which is every run before its Watch phase. `phase` (the folder they were found in, e.g. `05-watch`), `watchers` (`Watcher[]`, below) and `unreadable` (`string[]` — card files that are there and do not parse, named rather than dropped). Attached to the RUN because that is where the files live. |
| `preflight` | `Preflight` \| null | **`04-build/preflight.yml`** (#93) — what the workspace's own gate commands did on the UNTOUCHED base tree, or null when there is no file and null when it does not parse. `checkedAt` (string, `""` when the file recorded none) and `rows` (`PreflightRow[]`, below). This is the only file the model opens that `loadRunResult` had not already read. |
| `keepWorktrees` | boolean | `--keep-worktrees` was asked for and remembered (`run.yml` `keep_worktrees`, #16): the run's epic worktrees survive it closing. `false` on nearly every run — the key is written only when true, so an absent key and `false` are the same fact. |
| `budget` | `Budget` \| null | **`budget.yml`** (#85) — null when there is none, and null when the file does not parse. Distinct from `spentUsd`/`ceilingUsd`, which come from the run.yml MIRROR. Fields: `ceilingUsd`, `perAgentMaxUsd`, `warnAtPct`, `onExceed` (each number/string \| null), `economy` (`"metered-usd"` \| `"host-tokens"` — never null; a file with no key means `metered-usd`), `onHostTokensExceed` (`"warn"` \| `"block"` — never null; absence means `warn`), `ceilingHostTokens` (number \| null — **the ceiling `hostTokens` is judged against**, and the reason a host-attended run's dollar meter could not tell the truth without this file), and `phases` (`BudgetPhase[]`). |
| `notes` | `Note[]` | Operator notes off the ledger, oldest first (#46): `ts`, `actor`, `stage` (string \| null), `phase` (string \| null), `note`. **All of them** — `tldrx run status` caps at three because a terminal has a bottom; a run detail page does not. |
| `budgetBlocks` | `BudgetBlock[]` | Every `budget.blocked` on the ledger, oldest first. **History, not a state**: the ceiling may have been raised since, so this raises no attention card. `ts`, `stage`, `phase`, `economy` (`"metered-usd"` unless the event says otherwise), `remainingUsd`, `estimateUsd`, `hostTokens`, `ceilingTokens` (each number \| null — a dollar refusal carries the first two, a host-token refusal the last two, and they are never added), `reason` (string \| null). |
| `eventsError` | string \| null | Set when `events.jsonl` is on disk and could not be read at all. Carried so the page never renders "no operator notes" over an unreadable ledger. |
| `eventsSkipped` | number | Non-empty ledger lines that did not parse — a torn write. Shown, never swallowed. |
| `filter` | string | Lowercased haystack for a text filter over the run list. |

### `Waiting`

`kind` — one of `gate` | `answer` | `ready` | `done` | `blocked` | `failed` |
`running` | `prepared` | `cancelled` (the list is `WAITING_KINDS` in
`src/core/run/waiting.ts`) — plus `message` (a whole sentence, already worded for
a reader, carrying the command to run) and `questions` (open question ids in the
cursor phase, when it is waiting on answers).

`cancelled` is the one whose `message` carries facts that are nowhere else on the
model: **who** closed the run, **when**, and **why** (`run.yml` `cancelled.by` /
`.at` / `.note`, gh #86). A renderer that prints only the status chip drops all
three, which is what the run detail did until #93. Print the `message`.

The last two are the ones a renderer forgets. `running` means a live `next`
holds the run's `.lock`. `prepared` means a `--prepare` bundle is on disk and
nothing holds the run: the host session has to run the prompt and come back
through `tldrx next --commit`. **`prepared` is in `MOVABLE_KINDS`** — such a run
can wear `← next` — so a renderer that has no branch for it offers a run as the
next move and then says it is waiting on nothing.

**This is `tldrx run status`'s own answer, not a second derivation.** Both
screens call `waitingFor` in `src/core/run/waiting.ts`, so the page cannot
disagree with the CLI about what a run needs. It is derived from the STATUS of
the stage the cursor sits on, never from the gate objects: `awaiting_gate` is
the status a stage wears while a gate holds it, and a `gate.status: pending` on
a stage nobody has run yet is just the initial value of a field. Reading the
gates instead is what made a brand-new run render as "waiting at a gate".

`pendingGate` is non-null only when `kind` is `gate`; `pendingQuestion` only
when `kind` is `answer`. They are kept for one release for templates that
already read them — **new code should read `waiting`.** Open questions in a
phase that was already approved still appear under `phases[].questions`; they
are simply not what the run is waiting on.

### `NextAction`

`waiting` answers the question as prose. A card that wants the command in a
button, the stage in a subtitle and the actor in a chip had to regex that
sentence to get them — and a renderer that parses a sentence is a renderer that
will one day parse it wrong. So the same answer arrives pre-split:

| Field | Type | Meaning |
|---|---|---|
| `kind` | string | `waiting.kind`, **verbatim**. One of `WAITING_KINDS`. |
| `waitingOn` | string | Who has to move: `"person"` \| `"process"` \| `"run"` \| `"nobody"` \| `"unknown"`. |
| `phase` / `stage` | string \| null | Where the waiting is, from `run.yml`'s cursor. Null on the kinds that do not point at a stage. |
| `command` | string \| null | The command that closes it: the **first backticked span** of `message`, verbatim. Null when the sentence offers none. |
| `alternatives` | `string[]` | The remaining backticked spans, in order — `tldrx reject`, and its kind. |
| `message` | string | `waiting.message`, **verbatim**. |

**Nothing here decides anything twice.** `kind` and `message` are copies,
`command` and `alternatives` are read OUT OF that message rather than rebuilt
beside it, and `waitingOn` applies `isMovable` — the framework's own definition
of "a human could move it right now" — rather than a second opinion about it.

`waitingOn` resolves in this order, which is the order `dashPending` already
applies: a run that has **not started** and was proposed to follow an unfinished
sibling is `"run"`, whatever its own stage says (an alert nobody can act on is
the noise that makes the others ignorable); then `isMovable` gives `"person"`;
`running` is a `"process"` holding the lock; `done` and `cancelled` wait on
`"nobody"`. `"unknown"` is the honest fifth — a `blocked` run with no sibling
named is one whose `run.yml` records no cursor, or a cursor that resolves to
nothing. Somebody has to fix that file, and the model will not guess who.

`phase`/`stage` are null on `done`, `cancelled` and `blocked`. The cursor still
names a stage on the first two; nothing is waiting there, and printing the last
stage a finished run touched answers a question nobody asked.

### `Spend`

Both economies of one run, and an explicit account of the half nobody metered.

`spentUsd` is a sum of dollars this process watched. On a **host-attended** run
that number reconciles perfectly against every other ledger surface and is still
nowhere near what the run cost. Measured on `260830-ordering-inventory`
(aparece-v2, audited 2026-09-02): `run.yml` `spent_usd`, the `events.jsonl` sum,
the stage sums, the task sums and the `budget.yml` phase sums **all agree at
$14.60**, over 34 turns of which **4** carried money. The run's own watch gate
note puts the real figure at "about 81 dollars across 34 sub-agent turns". The
framework was not mis-metering; the front page was lying by omission.

| Field | Type | Meaning |
|---|---|---|
| `meteredUsd` | number \| null | The metered dollars — the same number as `spentUsd`, restated so this record reads alone. |
| `totalTasks` | number | Every task on the run, across every stage. |
| `unmeteredTasks` | number | Turns whose cost nobody declared. Byte-for-byte the rule `Run.unmeteredTasks` has always used. |
| `zeroCostTasks` | number | Turns recorded as **metered** at exactly `$0.00`. |
| `costlessTasks` | number | `unmeteredTasks + zeroCostTasks` — every turn that put nothing in the meter. |
| `hostTokens` | number | Tokens declared with `--tokens` across **all** turns — the same number as `Run.hostTokens`. |
| `costlessTokens` | number | The subset declared **by a costless turn** — the only host-side figure the dollars do not already cover. |
| `silentTasks` | number | Costless turns that declared nothing at all: no dollars, no tokens. |
| `basis` | string | `"measured"` \| `"declared"` \| `"partial"` \| `"absent"`. |
| `reason` | string | `basis` as a whole sentence, already worded for a reader. |

**Both spellings of "this turn cost nothing" are counted, and neither is
overruled.** The model already knew `cost_usd: null` + `metered: false`
(`runNext.commitStage`). It did not know the other one: a flat `cost_usd: 0.00`
written by an executor turn a host session drove, which is what **16 of that
run's 34 turns** wear and which reads as a measurement of zero. `unmeteredTasks`
keeps its exact old meaning — it counted 14 of those 30 turns and still does —
and `zeroCostTasks` is a second count beside it. A file that says `0.00` is not
re-labelled here; it is counted.

**`basis` says how much of the host side is actually derivable:**

- `measured` — no turn was costless. The metered figure is the whole of it.
- `declared` — every costless turn declared its tokens. Complete, in the other
  currency.
- `partial` — some declared, some did not. A lower bound in both currencies.
- `absent` — costless turns exist and **not one of them declared anything**. The
  host-side figure is not in the files, and no number here pretends it is. The
  audited run is this case: all 920,641 of its declared tokens sit on turns that
  also carried dollars, so they describe none of the 30 turns that carried none.

`reason` carries the framework's own phrase — "the metered total is a **LOWER
BOUND**, not a total", the wording `tldrx budget show` prints for the identical
fact — so the two screens cannot word it two ways. It is counts only: the model
does not format money.

Suggested rendering: `gate`, `answer`, `failed` and `prepared` are the four
kinds that raise an attention card — each is a run waiting on a person. `ready`
and `done` are states of the work, not asks. Every other kind should still print
its `message`: it is a whole sentence and it is what the CLI prints. A run with
a non-empty `blockedBy` **that has not started** should say what it is behind; a
run that has started should say what it is doing, with the proposal as a note
beside it (#60).

### `Stage` (a row of `run.path`)

`phase`, `id`, `status`, `expert` (string \| null), `model` (string \| null),
`costUsd` (number), `budgetUsd` (number \| null — the stage's own ceiling from
`run.yml` `stage.budget_usd`, which is per STAGE; `budget.yml`'s ceilings are per
phase and reach the model as `run.budget`), `gate` (string \| null, e.g.
`"approve: pending"`),
`gateBy` (string \| null — `auto` when the facilitator closed it, the operator's
name when a person did, null while it is open), `gatePolicy` (`"human"` |
`"auto"` | `"agent"` — who is MEANT to sign it, spec §2.2 `gates_policy`;
absence reads as `human`), `gateEvidence` (below), and `stale` (boolean — true
when an EARLIER stage's gate was revoked after this one ran; its outputs are
still on disk and still look current).

### `GateEvidence`

Non-null only on a gate an `agent` policy closed (design §A.5): `path` (the
run-relative path of the COMMITTED note under `<phase>/gate-evidence/` — text,
never a link), `role`, `verdict`, and the counts `sampled`, `of`, `resolved`,
`refuted`, `outsideSurface` (each number \| null). A human signature is a name
and a person who is accountable for it; an agent's is a name and nothing, unless
what it checked is shown beside it.

### `Phase`

`id`, `status`, `handoffHtml` (string \| null — see the exception above),
`questions` (`Question[]`, open ones only).

### `Question`

`id`, `title`, `whyAsked` (string \| null), `options` (`{ letter, text }[]`),
`answerCommand` — the exact terminal command that answers it. Render it as text;
it is not a button, and the dashboard has no write path.

### `Plan`

`phase` (the folder it was found in, e.g. `03-plan`), `stories`, `epics`,
`waves`, `unreadable` (file names that are present but do not parse — shown, not
swallowed).

- **Story**: `id`, `epic`, `title`, `repo`, `status`, `dependsOn` (`string[]`),
  `wave` (string \| null — the wave that schedules it, null when none does), and
  three facts that live only in `events.jsonl` because the story file has no
  counters (#85 §2, §5): `attempt` (number \| null — the attempt the LAST
  `task.started` recorded; null means nobody has picked it up, and is never a
  coerced `0`; read against `maxAttempts`), `reviewRetries` (number — how many
  review envelopes were refused on their FORMAT and asked for again, each costing
  the story no attempt), and `reopens` (`StoryReopen[]`, below).
- **Epic**: `id`, `title`, `branch`, `status`, `stories` (`string[]`).
- **Wave**: `id`, `stories` (`string[]`). File order is execution order.
### `BudgetPhase` (a row of `run.budget.phases`)

`id`, `ceilingUsd` (number \| null), `spentUsd` (number \| null), `economy`
(string \| null — **null means INHERIT the run's**, which is a different
statement from "this phase chose `metered-usd`"), `ceilingHostTokens` (number \|
null — this phase's own host-token allowance, #61).

### `Plan` types, continued

- **StoryReopen**: `ts`, `actor`, `reason` (`"fix"` \| `"attempts"`), `note`,
  `fromStatus` (string \| null), `verdicts` (number \| null — what the closed run
  of attempts consumed). A `story.reopened` written before the `reason` key
  existed reads as `attempts`, which is the only kind that existed; it is
  resolved here rather than reported as a blank.

### `Watcher` (a row of `run.watch.watchers`)

`id` (the feature id, also the file name stem), `epic`, `title`, `stories`
(`string[]`), `repos` (`string[]`), `status` (`"draft"` | `"verified"`, **as
written on the card**), `owner` (string | null — optional since #70), `absent`
(`string[]`) and `path` (run-relative, **text, never a link** — the page fetches
nothing).

`absent` is the card's own account of why it is a draft: the `absent:<path>`
sources cited under `## Signal`, verbatim and in file order. A card is
`verified` only when nothing under Signal cites one — that rule lives in
`src/core/watch/watcherFile.ts` and the model does not re-run it.

**What this is deliberately not.** `tldrx watch check` computes a
`CardChecklist` by re-resolving every `[src: …]` on the card against today's
working tree. The model does none of that: it reads the front matter through
`validateWatcher` and the body through `parseHandoff`, both of which are string
parsing and open nothing. Reading an `absent:` token back is not the same act as
checking it. So a `verified` stamp sitting over an `absent:` Signal is shown as
what it is — a stale stamp — rather than silently corrected, because `watch
check` is the thing that re-stamps and a viewer that disagreed with the file
would be a third opinion.

A `draft` card raises **no attention card**. The page's rule is that an alert
means a run is waiting on a person right now, derived once in `waiting.ts`; an
uninstrumented signal is a fact about coverage, and it belongs in a panel the way
`budgetBlocks` does.

### `PreflightRow` (a row of `run.preflight.rows`)

`repo`, `command` (byte-identical to the `.tldrx/workspace.yml` command — the
join key everywhere), `baseRef` (the repo's `default_branch`), `baseSha` (short
sha when git had an answer, `""` when it did not), `exitCode` (number),
`timedOut` (boolean), `status` (`"ok"` | `"failed"` | `"unmeasured"`) and `tail`
(the last meaningful line of the output).

`unmeasured` is a third case and **not** a synonym for either of the other two:
the gate declined to run the command at all, so nothing is known about the base
and nothing may be inferred from it.

Why it is on the page at all: a story's `dod` block is a **delta** gate, and it
proves nothing if the base tree was already red. `preflight.ts` measures the base
once per run and refuses to enter Build when a base command fails — it prints to
stdout, rolls the stage back to `ready`, writes this file, and emits **no event
and no `run.yml` field**. From the page the stage simply went backwards for no
visible reason (#85 §5). Drawn as rows, never as an alert, for the same reason
`budgetBlocks` is: the workspace may have been fixed since, and nothing
re-measures on render.

## `Expert`

`name`, `status`, `lastTrained` (string \| null), `warnings` (`string[]`, already
worded for a reader — a stored level disagreeing with the computed one),
`error` (string \| null, when `competencies.yml` is missing or unreadable), and
`areas`:

`id`, `title`, `level` (recomputed from evidence at read time — **this is what to
show**), `storedLevel` (number \| null — what was on disk; never show it as the
level), `evidenceCount`, `newestEvidence` (`YYYY-MM-DD` \| null), `trainPrompt`.

## `FaqEntry`

`heading` and `commands` (`string[]`). Copy-paste terminal commands, in order.

## What is NOT in it

`budget.yml` and `events.jsonl` **are** read, since #85. What the ledger gives
the model is deliberately narrow: operator notes (`tldrx note`), each story's
current attempt, the free review retries it was granted, story reopens and their
reasons, and every `budget.blocked`. What it does **not** give is the narrative —
per-attempt costs, the agent spawns, the check results, the order things happened
in. That is `tldrx replay <run>`, and the *How to use it* tab says so.

`04-build/preflight.yml` and `05-watch/watchers/*.md` **are** read too, since
#93 — the same doctrine, one step further: read-only, additive, tolerant. Each
was a design question rather than a patch, and each was answered the small way.
A preflight refusal leaves its base-gate rows on the page and emits nothing new.
A watcher card is read the way the file reads and **never re-checked**: the model
resolves no `[src: …]`, calls no `parseWatcherCard`, and computes no
`CardChecklist`. `tldrx watch check` remains the only thing that re-checks a card
against today's code, and the page says so.

Since #103 the model reads one more thing about `events.jsonl`, and it is not a
line of it: the file's **mtime**, carried on `LoadedRun` by the reader that
already opens the path, as the fallback behind `lastEventAt`. The ledger is
still read exactly once per run and still only through what `loadRunResult`
parsed. `lastEventFrom` says which of the two answers you are looking at,
because an mtime is the weaker fact.

What is still not here:

- **The narrative.** Per-attempt costs, agent spawns, check results, the order
  things happened in — `tldrx replay <run>`.
- **Any dollar figure nobody declared.** `spend` counts the turns the meter
  could not see and reports what was declared about them. It runs no price
  table, converts no token to a dollar, and synthesises no estimate from stage
  prices or turn counts. Where nothing was declared, `basis` is `absent` and the
  number is missing on purpose — a guess about a price is exactly what the front
  page was already making, in the other direction.
- **Any threshold.** `ageSeconds` is a measurement. Nothing in the model decides
  what "stale" means, which run is abandoned, or when a budget is alarming; a
  renderer is free to, and owns the call.
- **Any verdict the files do not already carry.** The model reports a card's
  `status` and its `absent:` citations side by side; it does not re-decide which
  is right.
- **Any write path.** Nothing in the model is a command, an action, or an id you
  can POST back. `nextAction.command` is **text** — the sentence `waiting.ts`
  already wrote, split for a button. Nothing on this page runs it.

## Serving it

```
GET /            the page
GET /model.json  this document
GET /events      Server-Sent Events; one `reload` per debounced file change
```

All three are GET, on `127.0.0.1` only. A `reload` event carries an ISO timestamp
as its data and means "re-fetch `/model.json`" — nothing more. The page redraws in
place: scroll position and any open handoff panel survive, because panel ids are
derived from the run and the phase rather than from render order.
