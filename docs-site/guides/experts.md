---
title: Experts
---

# Experts

An expert is a folder of context that gets pasted into a stage's prompt. The rules around
what may go in it are the interesting part.

`tldrx init` seeds them for you and never asks. How many depends on what detection found —
here, one language and no source folder the map read as a domain:

```
expert            status   last_trained  areas  evidence  levels
----------------  -------  ------------  -----  --------  ------
architect         created  never         1      0         0
delivery          created  never         1      0         0
developer         created  never         1      0         0
javascript-stack  created  never         1      0         0
operations        created  never         1      0         0
product           created  never         1      0         0

architect — created
  loaded by: how (named), plan (named)
  architect  ☆☆☆☆☆ 0  (no evidence)
```

Three kinds are seeded. Five **role experts**, always — `product` for What, `architect`
for How and Plan, `delivery` for Plan, `developer` for Build, `operations` for Watch; the
stage files name them, so they do not depend on detection. Then one **stack expert** per
language, detected or declared — two languages means two of them, which is why the count
above is a floor and not a rule. Then one **domain expert** per top-level source folder the
map read as a domain, capped at eight so a large monorepo does not produce fifty stubs
nobody trains. The repo above had none to seed; a real codebase usually does.

Every one of them starts at level 0, and an expert at level 0 is not broken: it contributes
its role description and nothing else.

## What is inside one

```
.tldrx/experts/billing/
  expert.md              the role, the domain it owns, and its citation rules — a human wrote this
  competencies.yml       one line per area, computed from evidence, never self-declared
  knowledge/money.md     what training found, every bullet with a source
```

The star chart is the honest bit:

```
ef-core  ★★★☆☆ 3  (17 evidence, newest 2026-08-20)
```

**A level moves because a file was cited, never because an agent said it learned
something.** Nothing an expert claims about itself changes its number.

## Which experts a stage loads

Three rules, and only three:

1. the stage names it (`experts:` in `stage.yml`);
2. it is the `<language>-stack` expert for one of the run's repos;
3. it is a **domain** expert whose declared paths the run actually cites — or that sits
   within two hops of a cited path in the code graph.

`tldrx expert list` prints a `loaded by:` line for each — `how (named), plan (named)` —
so an expert that is trained and that no stage will ever load stops being invisible.

All the loaded experts share **one** 48 KB knowledge budget, split by how relevant each is
to this run, rather than getting a budget each. Files the stage declared as inputs are
filled first: an input the stage asked for outranks reference material nobody asked for.

## Training one

```bash
tldrx expert create billing --area money --title "Invoicing, proration and refunds"
tldrx expert train billing --area money --mode light --print-prompt   # free: prints and stops
tldrx expert train billing --area money --mode light
```

`--mode light` reads the code. `--mode full` mines finished runs' handoffs; role experts
only train `full`, because their subject is the workflow rather than a folder of code.

Two things make the result trustworthy:

- **No model chooses what to read.** A deterministic pre-pass picks the files from the code
  map, the graph, and a bounded keyword search — capped at 40 files and 96 KB, with
  everything over the cap **listed by name as "not read"**, so a sub-agent cannot describe
  a file it was never shown.
- **The expert's declared domain is a hard boundary.** A citation outside it earns no
  evidence for that expert, however true it is. The `## Domain` bullets in `expert.md` are
  paths **relative to a repo**, with no repo prefix — `` - `src/Checkout/` ``, never
  `` - `api/src/Checkout/` `` — because a citation arrives as `repo:path:line` and only the
  path half is matched. `create` writes that rule, and the front matter `repos:`, into the
  file it creates.

An expert with no area cannot be trained at all, which is why `--area` is above: without one,
`expert train` refuses and names the block to add to `competencies.yml`.

`tldrx expert recompute` re-derives every level from the evidence on disk.

## Do you need to?

No. An untrained expert earns one note on stderr naming its train command, and never blocks
anything or changes an exit code. Training is what you do when a stage keeps re-deriving
the same thing about your codebase — trained knowledge is already sourced, so the next
stage can reuse it verbatim instead of paying to rediscover it.

Full detail: [4 — Experts](https://github.com/ederwii/tldr-experts/blob/main/docs/guide/04-experts.md).
