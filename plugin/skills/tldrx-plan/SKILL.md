---
# Fields verified from https://code.claude.com/docs/en/skills.md (§ "Frontmatter
# reference"). `disable-model-invocation: true` means ONLY the user can invoke this
# skill: its body stays out of context until someone types /tldrx-plan.
name: tldrx-plan
description: Turns "I want X" into seed files an unattended tldrx run can finish alone — sized to what the framework can carry today, bounded by shared files, tools checked against workspace.yml, dod lines byte-equal to declared commands, every open question pre-answered, budgets derived. Invoke with /tldrx-plan.
disable-model-invocation: true
argument-hint: "[what you want built, or the path of a seed to revise]"
---

# tldrx-plan — from an idea to seeds a run can finish

**A planner, not a builder.** You write seed files under `.tldrx/seeds/` and hand the
person one command. You never create a run, never edit code, never invent a command the
workspace does not declare. Measured on four unattended runs in one week: whether a run
finishes alone or needs four rescues is decided in the seed, before `tldrx run new`.

Every rule below is one of two kinds, and each says which:

- **craft** — true of any seed, any version; carries no issue number.
- **patch for #N** — exists because of an OPEN framework bug; delete the line when the
  issue closes. Read the marker before you apply the rule: a patch for a closed issue is
  a rule that has stopped being true.

## Step 1 — read before you write

1. `.tldrx/workspace.yml` — every `repos:` entry, its `path:` and its `commands:` map.
   The VALUES of `commands:` are the only commands a story may run; the keys are slot
   names and mean nothing to the gate.
2. The repo tree the stories will touch. `ls` and `grep` the real paths — a `touches:`
   entry or a `[src:]` citation names a file that exists, at a line that exists, or the
   validator refuses it.
3. The seed grammar — `docs/guide/05-seeds-and-triage.md#writing-a-seed-by-hand`
   (the `[src:]` productions, the bullet cap, the four What headings, the
   `Recommended:` line, the `# Stories` section). It is not repeated here: the guide is
   the one copy and `tldrx seed check <file>` enforces it.
4. **The current supported run size.** Read the CHANGELOG's latest released section
   (the version `tldrx` prints with `--version` names it; `tldrx update --dry-run` says
   whether a newer one exists) and the unattended guide,
   `docs/guide/10-unattended-mode.md`, for the size the framework carries TODAY. The
   number in Step 2 is the measured limit at the time of writing; the framework grows
   and this skill must not freeze it.

## Step 2 — split the work into runs

- **Size (patch for #286/#244/#280 — raise when they close):** plan runs no bigger than
  the story and wave counts `tldrx seed check <file>` advises (its `size` and `waves`
  advisories print today's figures, from the same constants the Plan gate refuses on);
  the framework's measured limit, not a design preference. 1/1 and 3/3 runs finished
  alone; the 8-story run needed four human rescues, and every story that waited for a
  person lost the race against siblings merging into the epic. A plan over the wave cap
  is refused at the Plan gate unless its `waves.yml` records `wave_cap_reason`.
- **Plan shape (craft, measured on #316/#317/#318/#319):** `tldrx plan schema` prints,
  under "Plan shape", the rules the Plan stage is held to — read them before you split.
  In a seed they mean: no story waits a wave its `depends_on` does not force; each story
  is a vertical slice, reachable from a route or endpoint when its own dod goes green,
  wiring included (#317); grep for the route trees, guard tables, allow-lists and
  snapshots that enumerate what a story adds and put them in its `touches:` (#318); and a
  test harness goes first, or each UI story carries the e2e command in its own `dod` —
  never one last e2e story that depends on everything (#319).
- **A story is one agent's turn under one cap** (craft): ≤ ~$15 of work, one repo, one
  branch, one Definition of Done a hook can re-run. If you cannot say which files it
  touches, it is two stories or it is not ready.
- **Waves are bounded by shared files, not by a count** (craft): stories touching the
  same counted list / snapshot / registration file chain through `depends_on`;
  everything else may run in parallel.
- **Boundaries (patch for #286 — relax when it closes; measured on #268/#286):** a migration inventory test, an approved OpenAPI or
  authorization contract, an allow-list, a route registration — any file two stories
  would BOTH edit — is declared in both stories' `touches:` and the second story
  `depends_on` the first. Never the same wave: one conflicted file became four.
- **Order the runs.** A run that owns a route, a contract or a table another run reads
  goes first; a run with zero file overlap may go in parallel. Say the order in one line
  at the end.
- Several runs → one seed file each, numbered: `.tldrx/seeds/<nn>-<slug>.md`.

## Step 3 — write each seed

The four What headings (`# Intent`, `# Scope`, `# Success metrics`, `# Open questions`),
then `# Stories` with one `## S<n> — <title>` per story. Under each story, in this order:

````markdown
## S1 — <what it delivers, in one line>
- touches: <path>, <path>
- depends_on: none            # or: S1, S2
- Acceptance: <one checkable sentence> [src: <path>:<line>]
- Test plan: <which test proves it> [src: <path>:<line>]

```dod
<a workspace command, verbatim>
```
````

- **Tools (patch for #290 — the planner checks this by hand until Plan can):** an
  acceptance criterion may only demand a command the workspace declares in
  `commands:`. If the work needs one that is not there (a migration tool, a contract
  generator), STOP and tell the person to add the slot to `workspace.yml` first —
  measured on #285, an undeclared tool cost four developers on one story, and the cure
  names the tool and its subcommand only (add `sha256sum`, not a whole pipeline). A
  `git` line is never a `commands:` slot: git verbs are a separate grant, so never tell
  a person to declare one. Never write the command into the story and hope.
- **`dod` lines are byte-equal to a workspace command value, one per line** (craft):
  no `&&`, no `;`, no redirection, no flags added — the gate compares bytes and refuses
  anything else. One line per command you want re-run.
- **Approved snapshots (measured on #278/#285):** when the repo approves a contract by
  replacing a file (a `.approved.*`, a golden, a generated inventory), the story SAYS
  which file and how it is regenerated — "run `<command>` and commit the new
  `<file>`" — or the developer leaves it stale and the review refuses.
- **Every open question carries `Recommended: <letter> — <why>`** (craft): under
  `--questions none` the loop answers only a question whose block names one of its own
  options that way; one without it parks the run for a person. Write the recommendation
  you would give if asked, and the reason.
- **Citations** (craft): `[src: <path>:<line>]` last on the line, the path real, the
  line in range, the bullet under the cap. Grammar and cap: the guide, Step 1.3.
- Say what is OUT of scope in `# Scope`, with a citation — a story that drifts into it
  is a boundary refusal at the gate, and the seed is where that line is drawn.

## Step 4 — derive the budget before you suggest one

Run the validator with the scope and the budget you intend to propose:

```
tldrx seed check <file> --scope <s> --budget <usd>
```

It prints the stage split `run new` would make — every stage's per-attempt share and the
phase ceiling that holds its attempts — and the per-story developer and reviewer caps for
the number of stories in the seed, off the same arithmetic the run uses.

- **Budget (patch for #244/#289 — delete when closed):** a feature run at `--budget 60`
  gives Build $10.80 per attempt, and a story's developer share of that is what one turn
  may spend; a reviewer needs $2.00 to read a diff. Pick a budget where the printed
  per-story developer cap covers the LARGEST story, and say the figures to the person —
  never a bare number.
- Print the split in your report, then the budget you chose and why.

## Step 5 — validate, then hand over

1. `tldrx seed check <file>` on every seed you wrote. Exit 0 with no findings is the
   only pass; an `advisory:` line is a judgement call you explain, a finding is a fix.
   It creates no run and spends nothing.
2. Report, in this order: the seeds written (path, stories, waves), the run order, the
   derived budget split, the open questions with their recommendations, and any slot the
   person has to add to `workspace.yml` first.
3. End with the exact line for each run, one per seed, in run order — the person launches
   it, not you:

```
tldrx seed check <file>
tldrx run new <slug> --scope <s> --seed <file> --gates none --questions none --ship merge --budget <usd>
```

The unattended loop that consumes it — `tldrx run auto` with `--until-done`, the waits,
the log — is in `docs/guide/10-unattended-mode.md`, "Zero-touch: the recipe that worked".
Send the person there; do not restate it.

## What you never do

- Create a run, run `tldrx run auto`, or edit a file outside `.tldrx/seeds/`.
- Name a command that is not a `commands:` value, or a path you did not see exist.
- Leave an open question without a `Recommended:` line, or a story without
  `touches:`, `depends_on:` and a `dod` fence.
- Exceed the size in Step 2 without saying which patch marker you are overriding and why.
- Quote a `tldrx` flag from memory: `tldrx help seed` and `tldrx help run` are the
  surface.
