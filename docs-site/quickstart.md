---
title: Quickstart
---

# Quickstart

Install it, point it at a project, get one stage signed — about five minutes. Every output
below came from running the command; where it is trimmed, it says so.

## Install

```bash
npm i -g tldr-experts     # gives you `tldrx` and `tldr-experts` — the same binary
tldrx doctor              # the authority on what else you need
```

You need **Node 20 or newer** and **Bun 1.3 or newer**; the package is a pre-built
bundle with no runtime dependencies. `doctor` checks the rest — `git`, `claude`, a few
optional extras — and prints the install command for anything missing rather than
installing it. A clean machine ends on `All required tools present. ✓`.

## First, try it for free

```bash
tldrx learn
```

Eight chapters, about fifteen minutes, in a throwaway sandbox with a toy repo and a
stand-in agent. Every command in it is the real one — `init`, `run new`, `next`, `answer`,
`approve`, and a Build that cuts a branch and runs a real definition of done — so nothing
it shows you can drift from the binary. **No API key, no network, $0.00**, and nothing is
written outside its own sandbox directory.

```
1. init — what the framework knows before you tell it anything
2. a question becomes a fact
3. the gate — an approval is a record, not a keystroke
4. build one story — branch, agent, DoD, commit, merge, review
5. when things go wrong — a red DoD, and the way back from it
6. the agent gate — what a signature has to rest on
7. attended — you write the code, the framework still keeps the record
8. money — the ledger, the estimate, and the brake
```

It resumes where you stopped; `--chapter <n>` jumps, `--list` shows progress, `--reset`
starts over. To understand tldrx while touching nothing you own, stop here.

## Then, on your own project

### 1. Set it up

```bash
cd your-project
tldrx init            # deterministic and offline: filesystem and git only, $0.00
tldrx interview --init
```

```
tldrx init — single-repo, 1 repo(s) under /Users/you/acme-api
  acme-api             javascript · confidence high · branch main
  map        6 documents via graphify
  experts    6 seeded at level 0
  questions  4 written to .tldrx/init-questions.md
```

Trimmed there: a `files` roll-up follows `questions` — how many were written, how many
created, and how many were yours and left alone.

`init` writes `.tldrx/`: what it detected, a code map, the six experts above — five role
experts always, a stack expert per language, and a domain expert per top-level source
folder the map found, capped at eight — and the short list of questions detection could
not answer. `interview --init` asks those in the terminal — answer there rather than
editing the file, because the interview is what records each answer as a numbered fact in
`.tldrx/memory/facts.yml`:

```
(3/4) Q3 · Who owns `acme-api`?
      Why asked: ownership cannot be read from the filesystem and nothing is recorded yet
      A) I own it        B) other — write the owner's name below
[A-E · free text · s=skip · q=quit] >  recorded Q3 → F003 (area ownership)
```

### 2. Open a piece of work

```bash
tldrx run new bulk-pricing --scope feature --budget 5
```

```
created tldrx-work/260901-bulk-pricing — scope feature (feature.yml), 5 stage(s), $5.00 ceiling
```

`tldrx run status` then shows the shape of it: five stages, a ceiling per phase, a cursor
on the first one, and which gates are yours — `3 human, 2 auto` for a `feature` run.

### 3. Run the first stage

```bash
tldrx next
```

```
01-what/what done — $0.31 of $4.00 (claim-sources:passed, no-reask:skipped, budget-gate:skipped)
gate pending: tldrx approve
```

::: tip Exit code 4 is not an error
`next` exits `4` — *awaiting a human*. The work is done; the decision is yours. (The second
figure is that stage's own ceiling, not the run's. That output is from the sandbox, where
the agent is a stand-in; on your project the dollar figure is what the model charged.)
:::

Read `tldrx-work/260901-bulk-pricing/01-what/handoff.md`. If the stage asked you
something, `tldrx answer Q1 "a JSON file the build reads"` → `Q1 answered → F001`.

### 4. Sign the gate

```bash
tldrx approve --note "a price change should be a data change, not a code change"
```

```
approved 01-what/what (claim-sources:passed, no-reask:skipped, budget-gate:skipped)
cursor → 02-how/how (ready)
```

`approve` **re-runs the stage's checks against what is on disk**, then records who signed,
when, and your note verbatim in `run.yml`. That note is what the next stage reads. Then
`tldrx next` again, on through Watch.

## Next

- Run it to the next real decision with `tldrx run auto` — [Attended or unattended](/guides/driving).
- What a gate may close on its own — [Gates](/concepts/gates).
- Driving it from Claude Code — [FAQ](/guides/faq#can-i-drive-it-from-claude-code).
- Commit `.tldrx/` and `tldrx-work/` — [the files are the state](/concepts/files-as-state).
