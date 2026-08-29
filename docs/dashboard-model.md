# The dashboard model

`tldrx dashboard` reads the workspace into **one plain JSON document** and then
draws it. Those are two steps and two files, on purpose:

| Step | File | What it does |
|---|---|---|
| read | `src/core/dashboard/model.ts` | files → `DashboardModel` |
| draw | `src/core/dashboard/render.ts` | `DashboardModel` → HTML |

`tldrx dashboard --static` runs both and writes the result. The live server runs
both for `GET /`, serves the model alone at `GET /model.json`, and re-runs the
draw step in the browser when a file changes — with the *same* functions, shipped
into the page by `clientRenderer()`. There is exactly one template in the product.

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
| `modelVersion` | number | `1` today. |
| `generatedAt` | string | ISO-8601, to the second, when the files were read. |
| `root` | string | Absolute path of the workspace that was read. |
| `workspace` | string | Its basename — what the page calls itself. |
| `workspaceFound` | boolean | `false` when there is no `.tldrx/` at `root`. The page says so instead of looking empty. |
| `live` | boolean | `true` when the watching server produced it, `false` for a static export. |
| `maxLevel` | number | Highest competency level (spec §2.6), so a renderer never hard-codes it. |
| `runs` | `Run[]` | Newest first (run ids are date-prefixed). |
| `experts` | `Expert[]` | Alphabetical. |
| `faq` | `FaqEntry[]` | The how-to, as data. |

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
| `spentUsd` / `ceilingUsd` | number \| null | Dollars. Format them; the model does not. |
| `stagesTotal` / `stagesDone` | number | `done`/`failed`/`skipped`/`cancelled` count as done. |
| `percent` | number | 0–100, rounded. |
| `pendingGate` | string \| null | Stage id of the gate the run waits on. |
| `pendingQuestion` | string \| null | `"<Qid> · <title>"` of the first open question. |
| `path` | `Stage[]` | The execution path, in `run.yml` order. |
| `phases` | `Phase[]` | Per phase: its handoff and its open questions. |
| `plan` | `Plan` \| null | Stories, epics and waves, when the Plan phase wrote them. |
| `filter` | string | Lowercased haystack for a text filter over the run list. |

### `Stage` (a row of `run.path`)

`phase`, `id`, `status`, `expert` (string \| null), `model` (string \| null),
`costUsd` (number), `budgetUsd` (number \| null), `gate` (string \| null, e.g.
`"approve: pending"`).

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

## Serving it

```
GET /            the page
GET /model.json  this document
GET /events      Server-Sent Events; one `reload` per debounced file change
```

All three are GET, on `127.0.0.1` only. A `reload` event carries an ISO timestamp
as its data and means "re-fetch `/model.json`" — nothing more.
