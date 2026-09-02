---
title: Dashboard
---

# Dashboard

`tldrx dashboard` draws the workspace as one web page. It is **read-only**: there is no
button on it that changes a file, because a dashboard that can launch work is a second
source of truth competing with the files.

```bash
tldrx dashboard              # a live server on 127.0.0.1, redrawing as files change
tldrx dashboard --static     # write one self-contained index.html and stop
tldrx dashboard --static --out ./somewhere/page.html
```

The live server watches the workspace and pushes a reload when a file underneath it
changes. The static export is one file with the CSS, the JavaScript and the data inlined —
no network reference of any kind, so it renders identically offline and leaks nothing about
who opened it. Both are the same document; only the watching differs.

## What it shows

| View | What is on it |
|---|---|
| Runs | Every run, its status, phase progress, spend, and **what it is waiting on**. The one a human could pick up next wears `← next`, the same marker `tldrx status` prints. |
| One run | The execution path stage by stage — expert, model, cost, gate, who signs it and who signed — plus the handoffs, the open questions, the plan and the branches the Build cut. |
| Experts | Competency levels **recomputed from evidence at read time**, never the number stored on disk, with the evidence behind each one. |
| Watchers | Not yet: watcher cards are written by the Watch phase and the model does not read them, so the tab says so rather than inventing a card. Use `tldrx watch list`. |
| How to use it | The terminal loop, as copy-paste commands. |

Four states raise an alert, because each is a run waiting on a **person**: an open
question, a pending gate, a failed stage, and a `--prepare` bundle waiting to be run and
committed. `ready` and `done` are states of the work, not asks.

## The money it shows is metered money

A run driven by a host session (`tldrx run attend host`) spends no metered dollars — its
turns are billed to that session. Such a run reads `$0.00` against its ceiling, and that is
a true statement about what tldrx measured and a false one about what the run cost. So the
page prints the other currency beside it: host tokens declared with `--tokens`, and how many
turns nobody costed at all. The two are never added together — there is no exchange rate.

::: info It does not read `events.jsonl`
Everything that lives only in the ledger is absent from this page: operator notes
(`tldrx note`), per-attempt costs, story reopens, review retries. `tldrx replay <run>` and
`tldrx run status` read the ledger.
:::

## It cannot disagree with the CLI

"What is this run waiting on" is derived **once**, in `src/core/run/waiting.ts`, and both
`tldrx run status` and this page call it. They used to answer separately, and a brand-new
run rendered as "waiting at a gate" here while the CLI called it `ready` — every stage's
gate reads `pending` on a run nobody has started, because that is the value the field is
born with.

## For a designer

The page is two files and one seam: something reads the workspace into a plain JSON
document, and something else draws it. Fetch `GET /model.json` from the running server and
you have all of it — no build step, no framework, no markup to reverse-engineer. The shape
is documented in
[the dashboard model](https://github.com/ederwii/tldr-experts/blob/main/docs/dashboard-model.md),
and `modelVersion` goes up only when a field is **removed or changes meaning**; adding one
never bumps it.
