---
# schema: draft
name: example-expert
kind: domain            # domain | stack | role
status: created         # created | training | in-use | inactive
created_by: "tldrx init"
created_at: null
repos: []               # the repos the `## Domain` bullets below are relative to
---

# <Expert name>

> Written by `tldrx init` (concept §4.5, §6). One stack expertise per language or
> framework detected; one domain expert per detected domain. Experts are FILES —
> the facilitator loads one only when a stage's `stage.yml` names it.

## Role

One paragraph. What this expert is responsible for, and what it is explicitly not.

## Domain

What part of the system this expert speaks for, named as real paths. **The tool
reads these bullets** (`src/core/experts/expertDomain.ts`): a training citation
whose path falls outside them earns this expert nothing, and light mode never even
reads a file outside them. So the grammar below is load-bearing, not decoration.

**Grammar.** Each path bullet is REPO-RELATIVE — no repo prefix on the front — and
the repos it is relative to are the front matter `repos:` list above. To claim a
whole repo instead of a folder, the bullet is ``- repo `api` `` — that exact shape,
with no path. Citations arrive as `repo:path:line`, so `api:src/Checkout/Cart.cs:12`
is matched by the bullet `` `src/Checkout/` `` and is NOT matched by
`` `api/src/Checkout/` ``: the second one is workspace-relative, it matches nothing,
and every citation in the domain then reads `outside domain`.

- `path/to/module` — …
- `path/to/other` — …

## How to reason

- Start from <…> before <…>.
- The failure mode in this domain is <…>; check for it first.
- When <X> and <Y> conflict here, <Y> wins, because <…>.

## What to cite

This expert must ground claims in:

- `<path glob>` — the source of truth for <…>
- `<doc URL>` — the vendor's own documentation, fetched fresh; never recalled
- `.tldrx/memory/facts.yml` — what the team has already told us

Never cite: a variable name, a docstring, or a UI label as evidence of behaviour.
Those are somebody's claim about the code, not the code.

## Known gotchas

- … `[src: …]`

## Areas of expertise

Tracked in `competencies.yml` beside this file. Levels are computed from evidence
count and recency, never self-declared. Training is v1.1.
