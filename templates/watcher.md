---
# Written to tldrx-work/<run>/05-watch/watchers/<feature>.md. Spec §2.16.
#
# One card per SHIPPED feature — one per epic whose stories reached `status: done`.
# Everything on it is derived from what Build actually instrumented. A signal that
# would be nice to have is not a signal; it is an `absent:` source and a `draft`
# card that names what to instrument.
version: 1
id: leaderboard              # = the file name (leaderboard.md); [a-z0-9-]
epic: E1                     # the epic this feature was built on
title: "Player leaderboard"
stories: [S1, S3]            # the DONE stories the card was written from
repos: [api, lab]
status: draft                # draft | verified — verified only when Signal has no `absent:` source
---

# leaderboard · Player leaderboard

> How anyone would know this still works next month. Every list item under Signal,
> Where, Healthy baseline and Looks broken when ends with a [src: …] token, and
> that token points at the BUILT code — `<repo>:<path>:<line>` — at an `F<n>` fact,
> or, when the code emits nothing at all, at `absent:<what you looked at>`.

## Signal

> The log line, metric or event that proves the feature works. Not "we should log
> X" — the line that is in the code, at the line it is on.

- `leaderboard.refreshed` is written on every view refresh [src: api:src/Leaderboard/RefreshHandler.cs:64]
- No counter exists for a refresh that finds zero rows — add one before this is watchable [src: absent:api/src/Leaderboard]

## Where

> The dashboard, log stream, table or query console this is read in.

- Application Insights → `traces`, filtered to the message above [src: F014]

## Healthy baseline

> A measured number and when it was taken. A guess belongs in Looks broken when as
> an assumption, or nowhere.

- 12–40 refreshes/hour during business hours, measured 2026-08-29 [src: F015]

## Looks broken when

> What the same signal looks like on the bad day, concretely enough to alert on.

- Zero refreshes for 30 minutes while hunts are still completing [src: api:src/Leaderboard/RefreshHandler.cs:64]

## Query

> Copy-paste, in the query language of the place named under Where. One fenced
> block, run once before it is written down.

```kql
traces
| where message == "leaderboard.refreshed"
| summarize count() by bin(timestamp, 1h)
```

## Sources

> Everything cited above, once, with what it establishes. Free prose is allowed
> here; the four checked sections above are the ones that must hold sourced items.

- `RefreshHandler.cs:64` is the only place the event is emitted.
- No dashboard exists yet; the query above is what a dashboard would run.
