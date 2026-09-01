# Evals — one golden-transcript eval per stage

Issue [#26](https://github.com/ederwii/tldr-experts/issues/26) asks for a suite
that regression-tests the framework's own prompts and stages, "rather than judged
by eye". This directory is **v1**: five evals, one for each stage of the loop —
What, How, Plan, Build, Watch. They run as part of `bun test`, and so as part of
CI. They add about **5 seconds**.

| file | what it holds |
|---|---|
| `harness.ts` | how one stage is made runnable on its own, and what comes back |
| `scenarios.ts` | the five fixed scenarios — the disk before, the script during |
| `evals.test.ts` | the assertions: one `describe` per stage |

## The idea

`tldrx learn` (#30) already proved the machinery: run the **real** commands
against a **scripted stand-in `claude`** (`src/core/learn/agentScript.ts`,
`learnAgent.ts`) inside a throwaway toy repo (`src/core/learn/sandbox.ts`). An
eval is that rig pointed at one stage instead of at a tutorial chapter.

Stages are a chain — Plan cannot run until How's gate is signed — so playing the
chain to reach stage N would make every eval depend on the four before it, and a
regression in What would turn all five red without any of them saying why.
Instead **each eval opens its own run on a workflow preset containing exactly one
stage**. Two facts make that work:

- `workflowPath` (`src/core/run/workflowPreset.ts:112`) reads
  `.tldrx/workflows/<scope>.yml` **before** the shipped `workflows/`, so a preset
  written into the synthetic workspace is all it takes;
- `normalisePhase` (same file) takes the phase folder from the stage's own
  `phase:` number rather than from its position, so a lone `stages: [plan]` still
  writes into `03-plan/`.

Anything upstream that a stage genuinely **reads** — a plan for Build, a done
story for Watch — is seeded onto the disk by the scenario. Anything it does not
read is deliberately absent.

## What an eval may assert

These are **contract** evals, not snapshot diffs. Nothing here compares bytes: a
prompt reworded must not turn this file red, and a grammar tightened must.

The stand-in writes what the scenario tells it to, so asserting an artifact's
prose would only assert the fixture. What is really under test is what the
**framework** does with it, and there are four kinds of that:

1. **Declaration.** The stage still declares the outputs it declares, and
   `validateOutputs` re-reads every one off disk. Read the list back out of the
   `gate.requested` event rather than trusting the stage file.
2. **Checks.** The stage's `checks:` ran and passed, and their `detail` is a
   sentence the framework *computed* — `checkPlan`'s branch-model line, say —
   never anything the model wrote. A check that is `skipped` for any reason other
   than being in `WRITE_TIME_ONLY` is a failure: that is what a renamed or
   deleted check looks like from out here.
3. **Parsers.** The artifacts parse under the framework's **own** validators —
   `validateQuestions`, `parseHandoff`, `parseWatcherCard` — imported, never
   re-implemented. A grammar that moves takes the eval with it.
4. **Side effects.** The things a stage exists for: a branch cut, a DoD re-run, a
   merge into the epic branch, a story's measured evidence, a card's *computed*
   status, an event trail.

And one that costs nothing extra: a turn is chosen by what the **prompt** says
(`agentScript.ts:selectTurn`). Every scenario matches on a stage template's H1 —
`# What — handoff`, `# Plan — handoff`. Delete or reword that heading and no turn
matches, the stand-in fails closed, and the eval goes red. That is the prompt
half of #26.

### The trap to avoid

An assertion that passes when the parser found **nothing** is not an assertion.
`validateQuestions` over a document it could not read returns *no issues* — which
is exactly how four real questions once went unseen and a gate auto-closed on the
silence (`src/core/text/questions.ts:96`). Assert the count first, then the
validity. The same rule applies anywhere a validator's happy path and its blind
path look alike.

## Proving an eval can fail

An eval nobody has ever seen red is a decoration. Each of the five was checked by
sabotaging its scenario, watching it fail, and reverting. Edit `scenarios.ts`,
run one eval with `bun test test/evals/evals.test.ts -t "<part of its name>"`,
then put it back:

| eval | sabotage | what goes red |
|---|---|---|
| What | `## Q1 · …` → `## Q1 - …` | the parser sees no question: `blocks.length` is 0 |
| How | cite `src/pricing.ts:99` in `design.md` | `claim-sources` fails the stage — it reads *every* declared `.md` (#34) |
| Plan | drop S3's `dependsOn: ["S1"]` | the stage still passes, but the derived model becomes `independent epics → one branch each` |
| Build | reviewer `verdict: "changes"` | the story is retried, so the DoD runs twice and never reaches `done` |
| Watch | a `[src: absent:…]` under `## Signal` | the card is stamped `draft`, not `verified` |

The Plan one is the shape to aim for: nothing crashed, every count still
matched, and the eval caught the *semantic* change anyway.

## Adding eval #6

1. **Write the scenario** in `scenarios.ts`: a `StageEval` naming the stage, its
   phase folder, anything to `seed` onto disk first, and the `turns` the stand-in
   will play. Match each turn on the stage template's **full H1** — `# How` alone
   fires on every prompt in the framework, because every `expert.md` has a
   `## How to reason` heading.
2. **Add it to `EVALS`** at the bottom of the file. This is not bookkeeping: a
   coverage test asserts that `EVALS` names every stage under `stages/`, so a sixth
   stage shipping without an eval turns the suite red and says so.
3. **Write the `describe`** in `evals.test.ts`. Start with
   `expectStageContract(run, "<stage>", "<phase>", [<its checks>])` — that is the
   part every stage owes — then assert what makes *this* stage different, using
   the four kinds above.
4. **Sabotage it and watch it fail**, then revert. Add the row to the table.

Things that will bite:

- Source tokens must **resolve**. `src/pricing.ts` in the toy repo is four lines
  long, so a citation of line 5 fails the stage.
- `absent:<path>` may only source a **negative** claim — `no`, `not`, `nothing`,
  `none` — unless it sits under `## Unknowns`, which is exempt
  (`src/core/text/srcToken.ts:442`).
- A stage turn's working directory is the **workspace root**, so its outputs need
  the `{runDir}/` prefix. A Build turn's is the story's **worktree**, so its paths
  are plain repo paths with no prefix.
- A `dod` command must match a `workspace.yml` command **byte for byte**.
- `{run}` and `{runDir}` expand in a turn's paths, its contents, and the seed —
  the run id does not exist until `run new` has run.

## What v1 does not cover

Named so nobody mistakes the floor for the ceiling; #26 stays open for these:

- **One golden path per stage.** No eval yet for a stage that *fails* — a red
  DoD, a refused gate, a budget brake. The sabotage table is the manual version.
- **The agent gate**, `--prepare`/`--commit`, attended runs, and `run auto`.
- **Prompt quality.** These evals prove a prompt still carries its heading and
  its contract, not that it still elicits good work. That needs a real model and
  a judge, which is a different suite with a different budget.
- **Multi-repo and multi-story fan-out.** Every scenario here is one repo, and
  Build is one story deep.
