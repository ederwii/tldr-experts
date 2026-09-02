# 1 — Quick start

## Install

> **Not on npm yet.** Every published version was unpublished on 2026-08-29
> (`npm view tldr-experts version` → `E404 Unpublished`) and there is no `v0.3.0`
> tag, so the `npm i -g` line below 404s until `scripts/release.sh 0.3.0` is run.
> Until then: clone the repo and `bun link`, or call `bun <repo>/bin/tldrx.ts <command>`.

```bash
npm i -g tldr-experts     # installs `tldrx` (short) and `tldr-experts` (same binary)
tldrx doctor              # check the local environment first — it is the authority
```

**Runtime: Node ≥ 20 or Bun.** The published package is a pre-built bundle with zero
runtime dependencies, so an installed `tldrx` needs only Node. Bun is required to
*build* from source, not to run it.

Required, per `env.yml`: **node ≥ 20** (runs the published build), **git ≥ 2.30**,
**claude ≥ 2.0**. Optional: **bun ≥ 1.3** — needed only to build from source, run the test
suite, or run the hooks straight from a clone — plus python3 ≥ 3.10 and graphify (the code
map), and gh (the ticket mirror). The framework never installs anything — `doctor` prints the
exact command for your OS and stops there.

## Set the workspace up

```bash
cd your-project
tldrx init                 # detect repos, map the code, write .tldrx/, ask only the gaps
tldrx interview --init     # answer what detection could not
```

`init` is deterministic and offline: filesystem and git only, no model, no network. It
writes `.tldrx/workspace.yml`, the code map under `.tldrx/map/`, `.tldrx/init-handoff.md`,
`.tldrx/init-questions.md` (only real gaps), `process.yml`, an empty `facts.yml`, and it
seeds the five role experts. Re-running regenerates the detection output and keeps
`facts.yml`, `experts/`, `process.yml`, `conventions/*.md` and an answered questions file.

Answer the init questions with `tldrx interview --init`, **not** by editing the file:
the interview is what writes the footer, the `facts.yml` row, the two events and
`.tldrx/process.yml`. A hand-typed answer in `.tldrx/init-questions.md` fills the slot
and records none of that (`answer-capture` returns early outside `tldrx-work/`).

Piped stdin is one line per question, in file order — a single letter `A`–`E` picks that
option, other text is recorded verbatim, a blank line or `s` skips, `q` stops:

```bash
printf 'A\nB\nA\nA\n' | tldrx interview --init
```

`--yes-to-defaults` answers **every** question with its first option. For the two process
questions that first option is "None", a real default; for the ownership and dead-code
questions it is a guess about somebody else's project. It is a flag for a human in a
hurry, not one an agent gets to pass on their behalf.

## Two ways to drive it

### From Claude Code

```bash
tldrx install --claude     # writes .claude/skills/tldrx/SKILL.md + merges hooks + statusLine
```

Then open Claude Code in that project and type **`/tldrx`**. It runs `tldrx status`,
finds what is already waiting on you — setup questions nobody answered, a proposed split
nobody decided, a run waiting on a gate, an expert no stage can lean on yet — and walks
you through it one item at a time, asking you every decision that is yours and running
only the steps that are mechanical. See [7 — Claude Code](07-claude-code.md).

### From a terminal

Nothing here needs Claude Code. Every hook is a script that reads a JSON payload on
stdin and prints a decision; every command is a CLI.

```bash
tldrx run new payments --scope feature --budget 5   # open a piece of work
tldrx next                                          # run the next stage; stops at a gate
tldrx run status                                    # where it is, what it is waiting on, what it cost
tldrx answer Q1 "the answer"                        # answer what it asked
tldrx approve                                       # re-runs the stage's checks, then advances
```

With a big document to work from, seed the run instead of typing the intent:

```bash
tldrx run new payments --scope feature --seed docs/payments/
tldrx run auto                                      # next, over and over, until you are needed
```

`run auto` is headless only, and it stops at the first human gate, open question, failure
or budget refusal. See [3 — Runs and gates](03-runs-and-gates.md) and
[5 — Seeds and triage](05-seeds-and-triage.md).

## What it writes

`.tldrx/` is framework state; `tldrx-work/<yymmdd>-<slug>/` is one folder per piece of
work. **Commit both** — see [2 — The loop](02-the-loop.md#what-to-commit).
