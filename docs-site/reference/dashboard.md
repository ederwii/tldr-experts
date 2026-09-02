---
title: Dashboard
---

# Dashboard

There is a [live demo of this page](/demo) on this site, rendered from synthetic fixture
data on every deploy.

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
| Runs | The **Now strip** first — one card per live run, with its phase dots, the ask, the spend and how long it has been quiet — then every run as a row: status, phase progress, spend, and **what it is waiting on**. The one a human could pick up next wears `← next`, the same marker `tldrx status` prints. |
| Waves | The plan as bars: a row per wave, a bar per story in it, so parallelism and fix rounds are visible at a glance. There is **no time axis** — the model carries no start or end per story, and an invented one would read as measured. |
| One run | The **phase timeline** — a lane per phase, each stage opening onto its cost, its gate and who signed it (the same path is still there as a table, one click away) — the **story grid**, a status cell per story that opens onto what the plan file and the ledger say about it, and the **event stream**, every timestamped fact the model carries in one order, filterable by kind. Plus the execution path stage by stage — expert, model, cost, gate, who signs it and who signed — plus the handoffs, the open questions, the plan and the branches the Build cut. From the ledger: the **operator notes** somebody left with `tldrx note`, each story's attempt and the free review retries it was granted, the reopens and their reasons, and every moment the budget brake refused a stage. From `budget.yml`: the per-phase ceilings, the levers, and the **host-token allowance**. From `04-build/preflight.yml`: the **base gates** — what each of the workspace's own gate commands did on the untouched tree, so a Build that refused to start is not a stage that went backwards for no reason. Plus, when they are set, why a run was **cancelled** (who, when, the note) and whether its epic **worktrees are kept**. |
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

## The Now strip answers three questions

Is a **human** waited on right now, is anything **broken or quiet**, and what has it
**cost**. One card per live run — live meaning every run that is neither `done` nor
`cancelled`, so a run nobody has started and a run nothing can move are both on it. The
cards that raise an ask sort to the front.

Three of its decisions are worth knowing, because each could have gone the other way:

- **A lower bound never gets a bar.** A progress bar is a claim about a denominator, and it
  is honest only when the number over it is the whole of what was spent. When
  `spend.basis` is anything but `measured` — when turns went by that put nothing in the
  meter — the card shows the metered figure with a **lower bound** mark and *no bar*, plus
  how many of how many turns were costless. The full sentence, the model's own, is in the
  mark's tooltip and on the run detail.
- **"Quiet" is 30 minutes, and that is the page's line, not the model's.** The model
  reports `ageSeconds` and deliberately bakes in no threshold. Half an hour with nothing on
  the ledger is either a person who has not been asked or a process that died, so the age
  goes bold and wears a `quiet` mark. An `mtime` reading says **touched** rather than "last
  event" — the file was written, which is not the same as the run moving — and a ledger
  dated *after* the read is named as two clocks disagreeing rather than laundered into a
  freshness claim.
- **The dots are the phases the run's own `run.yml` declares.** `run new` writes the whole
  workflow up front, so a `feature` run really does draw five, what → watch. A workflow
  that declares three draws three. Nothing is padded to five for the shape of it.

## Keyboard

Everything is a link, a button or a `<details>`, so Tab and Enter work with no help.
On top of that: <kbd>j</kbd> / <kbd>k</kbd> move between cards and rows, <kbd>enter</kbd>
opens the focused one, and <kbd>/</kbd> jumps to the filters. They are printed under the
filter row — an undiscoverable shortcut is not a feature.

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
spawns, the checks — is `tldrx replay <run>`'s job. The run detail's **event stream** puts
the three kinds the model *does* read (operator notes, budget refusals, story reopens) into
one time order, and says on the page that it is not the log.
:::

::: info What the page cannot show, and names instead
A stage's `started_at`, its `ended_at` and a gate's free-text `note` are in `run.yml` and
are not on the dashboard model, so the phase timeline reports no duration and quotes no
signature — it says so where the numbers would be. A story's build log and its fix list are
files the Build writes and the page does not read; the story grid says that too. A blank
cell reads as "nothing happened", which is the class of confident-wrong figure this page is
built to avoid.
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
