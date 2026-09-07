---
title: Gates and who closes them
---

# Gates and who closes them

Every stage ends at a gate. A gate is a stop: nothing after it runs until it is closed.
That part never changes. What you choose per stage is **who is allowed to close it**.

There are three policies.

## `human` — you sign it

The stage ends, `tldrx next` exits `4` (*awaiting a human*), and the run waits.

```bash
tldrx approve --note "why this is right"
tldrx reject  --note "contracts.md does not name the events"
```

`approve` is not a rubber stamp. It **re-runs the stage's checks against what is on disk
right now** — schema validation, the source checker, and any shell command your
`workspace.yml` declared, run for real. If one fails, it exits `2` and names it. Only then
does it record who signed, when, and your note verbatim in `run.yml`, and move the cursor.

`reject --note` sends the stage back to `ready`. Your note is not filed away: the next
attempt gets it, with the previous failure, under `## Previous attempt` in its prompt, and
the files it already wrote are inlined so attempt 2 edits rather than starts over.

## `auto` — the tool may close it, if it can show its work

An `auto` gate is not a skipped gate. The harness closes it only when **seven** things hold
at once, and it prints all seven either way:

```
auto-gate: checks=claim-sources:passed,no-reask:skipped,budget-gate:skipped; questions=0 open;
budget=$0.44 of $6.00 stage, phase 02-how $0.44 of $6.00; status=awaiting_gate;
claim-sources=passed; stories=n/a (not a build stage); boundary=n/a (not a build stage)
```

1. the stage's own checks passed;
2. its phase has no open question;
3. spend is inside the stage ceiling;
4. spend is inside the phase ceiling;
5. the stage did not fail;
6. every claim it wrote resolved to a real source ([evidence](/concepts/evidence));
7. on a Build stage only — every story reached `done`, **and** the epic branch changed
   nothing the run never declared it would touch.

Any one of them failing falls back to the human gate and says which one, and what it
measured. A citation that nothing could check does not fail the stage, but it does stop an
auto gate — that is exactly the line a person should look at.

### Getting past the boundary: `tldrx story widen`

The seventh condition is the one you will meet most. A story had to change a path the plan
never scoped, so the gate refuses and names the paths. Work nobody scoped is often the right
work — and saying so is a decision, with a verb:

```bash
tldrx story widen S3 platform/Auth.cs --note "the tenancy check the story is for lives here too"
```

It adds the paths to that story's `touches:` and records the amendment — the paths, your note,
and the list before and after — so a declared surface never grows silently. It runs no agent,
spends nothing, consumes no attempt and moves no cursor. The gate needs no help from it: the
boundary condition re-reads `touches:` off disk, so the next evaluation of the same run, the
same branch and the same diff simply stops counting that path as outside the surface.

A story that is already `done` refuses — its evidence was written against the surface it
declared — and that is the common case here, because a Build gate that refuses on the boundary
has usually finished its stories. Reopen it first:

```bash
tldrx story reopen S3 --for-fix --note "the tenancy check misses the Platform path"
tldrx story widen  S3 platform/Auth.cs --note "…"
```

The decision card prints both commands, in that order.

### A finding no story owns is reported, not blocking

A reviewer may mark a finding *real, and not this story's to fix*. If the file it cites falls
outside every story's declared surface, nobody has been handed it. That row is now named in the
Build handoff's `## Unknowns`, in the `tldrx ship` PR body, and on the decision card when the
gate was already stopping for something else — each with the reason it could not be attributed,
which may be that no story declares that path, that the citation names no repo (and a repo is
never guessed at), or that the finding cites no path at all. A story file that could not be read
is named too, because an unread story takes its findings out of the report with it. None of it
blocks a gate: it is a report, and it is an addition to a card that was going to print anyway.

## `agent` — an agent may sign, over written evidence

The strongest policy, and it never arrives by default. Those same seven conditions, plus
no budget decision taken while the stage ran, plus a **signed evidence note** — a checklist
whose every bullet carries a source that resolves, validated by the same machinery that
checks the stage's own output.

```bash
tldrx gate template          # writes the skeleton note to fill in
tldrx approve --as-agent     # validates it, then signs
```

It falls through to a person on an open question, a moved ceiling, work outside the
declared boundary, or the agent's own refusal to sign. A person may always approve an
agent-gated stage with no flag at all — that override is recorded as a person, and it is
the point of the split: an agent gate is one an agent *may* close, never one you may not.

## Choosing the policy

Each scope ships defaults, and every scope keeps at least one human gate. `feature` is
`what: human, how: auto, plan: human, build: auto, watch: human`.

```bash
tldrx run new pay --gates what,plan,build           # the list IS the human gates
tldrx run new pay --gates plan:agent,build:agent    # qualified: name the policy outright
tldrx run new pay --gates all                       # or: none
```

`--gates` **replaces** the scope's gates wholesale — a stage you leave off the list becomes
`auto`, so name every gate you want signed.

The policy is frozen when the run is created. Changing it later is deliberate and leaves a
record:

```bash
tldrx run gates set build:human --note "the owner wants to read every merge from here"
```

## Undoing a signature

When something got signed that should not have been:

```bash
tldrx reject --stage 02-how/how --note "the auto gate signed over four open questions"
```

The cursor moves back to that stage, a `gate.revoked` event records who had signed, and
later stages that already ran are marked `stale` — their files stay on disk and stop
counting as current. Nothing is deleted, and no cost is refunded.

When it is one *build story* you disagree with, `tldrx story reopen <id> --note "…"` gives
that story another run of attempts and touches nothing else. A story already `done` refuses
that — undoing finished work is a decision about the stage — but one named defect in it
opens a **fix round**: `tldrx story reopen S11 --for-fix --note "which defect"`. No attempt
is consumed, the fix passes the same definition of done and the same reviewer, the
acceptance criteria are not touched, and only one round may be open at a time. It exists so
that an accepted defect does not cost every other story in the stage its closure.
