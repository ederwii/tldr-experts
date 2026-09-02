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
tldrx dashboard --static --out ./somewhere/   # --out names a directory, not a file
```

The live server watches the workspace and pushes a reload when a file underneath it
changes. The static export is one file with the CSS, the JavaScript and the data inlined —
no network reference of any kind, so it renders identically offline and leaks nothing about
who opened it. `--out` names the directory to write into, which is created if it is not
there; the page inside it is always called `index.html`. Both are the same document; only
the watching differs.

## What it shows

| View | What is on it |
|---|---|
| Runs | Every run, its status, phase progress, spend, and **what it is waiting on**. The one a human could pick up next wears `← next`, the same marker `tldrx status` prints. |
| One run | The execution path stage by stage — expert, model, cost, gate, who signs it and who signed — plus the handoffs, the open questions, the plan and the branches the Build cut. From the ledger: the **operator notes** somebody left with `tldrx note`, each story's attempt and the free review retries it was granted, the reopens and their reasons, and every moment the budget brake refused a stage. From `budget.yml`: the per-phase ceilings, the levers, and the **host-token allowance**. From `04-build/preflight.yml`: the **base gates** — what each of the workspace's own gate commands did on the untouched tree, so a Build that refused to start is not a stage that went backwards for no reason. Plus, when they are set, why a run was **cancelled** (who, when, the note) and whether its epic **worktrees are kept**. |
| Experts | Competency levels **recomputed from evidence at read time**, never the number stored on disk, with the evidence behind each one. |
| Watchers | One card per shipped feature, read from `05-watch/watchers/*.md`: what to watch, who owns it, the epic and stories behind it, and — on a `draft` — the `absent:` citations that say exactly what is not instrumented yet. The page **reads** the cards; it does not re-check them against today's code. That is `tldrx watch check`. |
| How to use | The terminal loop, as copy-paste commands. |

Four states raise an alert, because each is a run waiting on a **person**: an open
question, a pending gate, a failed stage, and a `--prepare` bundle waiting to be run and
committed. `ready` and `done` are states of the work, not asks.

Nothing else raises one, and that is a rule rather than an oversight. A `draft` watcher, a
red base gate and a past budget refusal are all drawn as panels: each is true for as long as
nobody fixes it, and none of them is a run waiting on you right now. An alert that means
"someone should look at this eventually" is an alert people stop reading.

Runs with operator notes wear a small ✎ in the runs list, with the count in its tooltip —
the notes themselves stay on the run detail. It is deliberately the smallest marker that is
true, and it is provisional: the list is a list, and a count in a row is a design decision
nobody has made yet.

## The money it shows is metered money

A run driven by a host session (`tldrx run attend host`) spends no metered dollars — its
turns are billed to that session. Such a run reads `$0.00` against its ceiling, and that is
a true statement about what tldrx measured and a false one about what the run cost. So the
page prints the other currency beside it: host tokens declared with `--tokens`, and how many
turns nobody costed at all. The two are never added together — there is no exchange rate.

And when `budget.yml` prices the run in `host-tokens`, the page stops quoting dollars at it
entirely — in the runs list and on the run detail alike. `ceiling_usd` governs nothing there,
so `$0.00 of $25.00`, bar or words, would be a confident statement about a denominator that
does not apply. The spend reads in tokens, against `ceiling_host_tokens` — the ceiling those
tokens really are judged against, which lives in `budget.yml` and in no other file.

::: info What is still only in `tldrx replay`
The page reads the ledger, but not all of it: the narrative — per-attempt costs, the agent
spawns, the checks, the order things happened in — is `tldrx replay <run>`'s job.
:::

::: info The page reads. It does not check.
Every file it opens, it opens read-only, and it re-derives nothing the files already decide.
A watcher card is the clearest case: `tldrx watch check` proves each `[src: …]` on a card
still points at real code, and the dashboard does not — it prints the `status` the card
carries and the `absent:` sources the card cites, side by side. A `verified` stamp sitting
over an `absent:` signal is shown as what it is, a stale stamp, rather than quietly
corrected by a third opinion.
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
