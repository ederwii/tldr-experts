<!-- schema: draft -->
<!-- Stage template: build (phase 4). -->
<!--
  READ THIS FIRST: unlike every other stage, this file is NOT the prompt.

  `04-build` is run by the wave executor (spec §5, "Build executor"), which builds
  its own per-story developer prompt and per-story reviewer prompt from the Plan
  artefacts, and writes `04-build/handoff.md` itself. Editing this file changes the
  documentation of the phase, not what the sub-agents are told. The prompts live in
  `src/core/build/prompts.ts`; the pipeline lives in
  `src/core/facilitator/executors/build.ts`.
-->

# Build — what the phase does

## Role

The facilitator is the contractor here, not an author. It hands each story to a
developer sub-agent, proves the result, and merges it — and it writes the handoff
from what it measured rather than asking anyone to summarise it.

## Objective

Turn `03-plan/waves.yml` into merged code on epic branches, one story at a time,
in wave order. Done-when: every scheduled story is `done` (DoD green, reviewer
approved, evidence written into its front matter) or `blocked` with a reason a
human can act on, and every epic branch is left ready to merge **by hand**.

## Inputs

`03-plan/waves.yml`, `03-plan/stories/<id>.md`, `03-plan/epics/<id>.md`, the
workspace conventions, and — per story — the content of every path its `touches`
list names, read from that story's own worktree.

## Investigate

Per story, in `waves.yml` order:

1. resolve the story's repo from `workspace.yml`, and refuse the whole phase if
   that repo's tree is dirty;
2. ensure `epic/<slug>` exists, cut from the repo's `default_branch`;
3. open a worktree at `.tldrx/worktrees/<repo>/<story-id>` on `story/<id>`;
4. spawn ONE developer sub-agent with cwd = that worktree.

## Produce

- `04-build/log/<story-id>.md` — the review log, one per story touched
- `04-build/handoff.md` — Findings per story, Evidence ledger of dod commands
- `03-plan/stories/<id>.md` — `status:` and `evidence:` written back
- `epic/<slug>` branches, merged from `story/<id>`, **never pushed**

## Rules

- Done means proven: the ```dod block is re-run by the facilitator, in the story's
  worktree, and every command must exit 0. A sub-agent's own "it works" is not
  evidence and is never recorded as any.
- A reviewer's `changes` requeues the story ONCE, with the review under
  `## Previous attempt`. A second `changes` blocks it.
- An acceptance criterion that embeds a literal command or pattern is validated BEFORE
  the edit — run against the current tree first, and a criterion that reports zero while
  the goal says the work exists is broken, so the real inventory becomes the completion
  test and the discrepancy goes in the handoff (the criterion text is not the story's to
  edit). The developer prompt carries this rule verbatim.
- A DoD failure or a merge conflict blocks that story only — the wave carries on.
- Nothing pushes. No epic is merged into a default branch.

## Questions

None. The Interview happened in What and How; a story that still needs a human
answer is a Plan bug, and it surfaces here as `blocked`.

## Stop

At the gate. `tldrx approve` after merging the epic branches, or
`tldrx reject --note "…"` to send the phase back.
