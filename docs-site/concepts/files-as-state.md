---
title: The files are the state
---

# The files are the state

Most tools keep their state somewhere you cannot see and give you a summary. tldrx has no
somewhere else. What it writes into your repo **is** the state: it re-reads those files at
the start of every command to decide what to do next.

That has three practical consequences.

1. **You can read it.** No log to enable, no database to query. `cat` the file.
2. **You can fix it.** A stage that got the wrong idea is a file you edit and re-run.
3. **You can share it.** Commit the directories and a teammate who clones the repo gets the
   run — the questions, the answers, the plan, the money spent, the approvals.

## Two directories

```
.tldrx/                          # what the tool knows about your project
  workspace.yml                  # repos, stacks, branches, the commands it may run
  map/                           # the code map, one folder per repo
  memory/facts.yml               # every answer you have ever given, numbered
  experts/                       # who the stages lean on, and what they have learned
  conventions/                   # how this repo is written

tldrx-work/260901-bulk-pricing/  # one folder per piece of work
  run.yml                        # the cursor, the gates, the costs — the resume point
  budget.yml                     # ceilings, per run and per phase
  events.jsonl                   # append-only log of everything that happened
  01-what/ … 05-watch/           # one folder per stage, holding its output files
```

## The three that matter

**`run.yml`** is where the run is and what it is waiting on. The cursor, one entry per
stage with its model, ceiling, actual cost, and its gate:

```yaml
cursor: {phase: "01-what", stage: what, task: null}
budget: {ceiling_usd: 5.00, spent_usd: 0.00, per_agent_max_usd: 1.80}
gates_policy: {what: human, how: auto, plan: human, build: auto, watch: human}
```

It is the *only* resume point. `tldrx run auto` holds nothing in memory — every iteration
re-reads this file — so killing it mid-run leaves a run that `tldrx next` picks up
unchanged.

**`.tldrx/memory/facts.yml`** is your answers. Every question you answer becomes a
numbered fact with who said it, when, and which question it came from. Before any stage
asks you something, this file is searched — re-asking a question already recorded here is
treated as a bug in the framework, not a quirk. Facts are superseded or retired, never
edited in place.

**`events.jsonl`** is one JSON object per line, append-only, in the order things happened:

```json
{"ts":"2026-09-01T17:06:05Z","run":"260901-bulk-pricing","type":"run.created","actor":"alanmartinez","cost_usd":0,…}
```

It is the source for `tldrx cost`, `tldrx replay` (the run as a narrative) and `tldrx retro`.

## Commit both

`.tldrx/` and `tldrx-work/` belong in git. `tldrx init` appends a short block to your
`.gitignore` excluding only what is machine-local or regenerated — the graph cache, live
lock files, the in-flight prompt bundle, `.bak` files. Everything else is meant to be
reviewed in a pull request like any other change.

The same block starts by *re-including* `.tldrx/**` and `tldrx-work/**`, because rules your
repo already had can hide them by accident — a .NET project's `[Ll]og/` swallows
`04-build/log/<story>.md` and git says nothing about it. `tldrx doctor` checks four of
these paths with `git check-ignore` and names any rule still hiding one.

Every one of these files opens with `version: 1`. Schemas only ever grow.
