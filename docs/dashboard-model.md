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
| `modelVersion` | number | `3` today. `1 → 2`: `pendingQuestion` and `pendingGate` became aliases of `waiting` and no longer report an open question, or a gate object, that the run is not actually stopped on. `2 → 3` (#60): `runnable` reads `true` for a run that has STARTED and was proposed to follow an unfinished sibling — a proposal recorded before either run existed cannot un-start a running run. Additions never bump it. |
| `generatedAt` | string | ISO-8601, to the second, when the files were read. |
| `root` | string | Absolute path of the workspace that was read. |
| `workspace` | string | Its basename — what the page calls itself. |
| `workspaceFound` | boolean | `false` when there is no `.tldrx/` at `root`. The page says so instead of looking empty. |
| `live` | boolean | `true` when the watching server produced it, `false` for a static export. |
| `maxLevel` | number | Highest competency level (spec §2.6), so a renderer never hard-codes it. |
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
| `stagesTotal` / `stagesDone` | number | `done`/`failed`/`skipped`/`cancelled` count as done. |
| `percent` | number | 0–100, rounded. |
| `waiting` | `Waiting` | **What this run is waiting on.** The one field to read. |
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
| `filter` | string | Lowercased haystack for a text filter over the run list. |

### `Waiting`

`kind` — one of `gate` | `answer` | `ready` | `done` | `blocked` | `failed` |
`running` | `prepared` (the list is `WAITING_KINDS` in
`src/core/run/waiting.ts`) — plus `message` (a whole sentence, already worded for
a reader, carrying the command to run) and `questions` (open question ids in the
cursor phase, when it is waiting on answers).

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
`run.yml` `stage.budget_usd`; the model does not read `budget.yml`, whose
ceilings are per phase), `gate` (string \| null, e.g. `"approve: pending"`),
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
  `wave` (string \| null — the wave that schedules it, null when none does).
- **Epic**: `id`, `title`, `branch`, `status`, `stories` (`string[]`).
- **Wave**: `id`, `stories` (`string[]`). File order is execution order.

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

`events.jsonl` is **not read**. Everything that lives only in the ledger is
therefore absent: operator notes (`tldrx note`), per-attempt costs, story
reopens, review retries, budget refusals. `tldrx replay <run>` and `tldrx run
status` read the ledger; this page does not, and says so on the *How to use it*
tab rather than letting an empty section read as an empty ledger.

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
