---
# Written to tldrx-work/<run>/03-plan/stories/<id>.md. Spec §2.13.
#
# The front matter is the machine-read half: `dod-gate` and `tldrx approve` read
# it, and the Build phase cuts `story/<id>` from the epic branch on the strength
# of it. Everything below the closing `---` is for the human who picks this up
# cold — except the fenced ```dod block, which is executed, not read.
version: 1
id: S1
epic: E1
title: "Materialise the leaderboard read model"
repo: example
status: todo                 # todo | in_progress | review | done | blocked
depends_on: []               # story ids that must be DONE first, e.g. [S2]
touches:
  - "src/features/leaderboard/"
acceptance:
  - "Top-50 ranks render from the materialised view, newest hunt first"
  - "A hunt completed while the page is open moves the player within one refresh"
test_plan:
  - "Unit: rank ordering with ties, empty table, single player"
  - "Integration: HuntCompleted refreshes the view"
evidence: []                 # filled by Build — commands run, files written, PR
---

# S1 · Materialise the leaderboard read model

> One repo, one branch, one Definition of Done. If this story needs a change in a
> second repo, that is a second story with `depends_on` pointing here.

## Context

Why this story exists, in two or three sentences, each ending in a `[src: …]`
token. Read it as the only briefing the Build agent gets.

## Acceptance criteria

Restate the front matter's `acceptance` list here in prose if it helps a reader;
the front matter is what is checked.

## Definition of done

**Every command below must equal a `.tldrx/workspace.yml` command verbatim** — a
story may not invent one — and every one of them must exit `0` before `status:`
may be written as `done`. `dod-gate` re-runs them; your word for it is not evidence.

```dod
npm run test
npm run lint
```

## Evidence

Filled by Build. One bullet per proof, each ending in a `[src: …]` token — a
command source (`$ npm run test → exit 0`) belongs here.
