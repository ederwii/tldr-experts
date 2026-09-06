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

## Stack packs

A `<language>-stack` expert starts as a stub with nothing stack-specific in it. Turn the
**stack packs** on and it gets a shipped body — TypeScript, JavaScript, Python or .NET — plus
one **overlay** for every framework your manifests prove. Thirteen ship: `react`,
`next-app-router`, `vite-react-spa`, `expo-router`, `node-express`, `prisma`,
`aspnet-minimal-apis`, `aspnet-controllers`, `mediatr-cqrs`, `efcore-npgsql`, `fastapi`,
`sqlalchemy-alembic` and `postgres-testcontainers`.

```bash
tldrx expert packs enable     # one switch, off by default
tldrx expert packs status     # overlays with their evidence, skills, each body's state
tldrx expert packs disable    # removes the overlays; bodies and knowledge stay
```

Overlays are read out of `package.json`, the `.csproj` files and `Directory.Packages.props`,
`pyproject.toml` or a `requirements*.txt` — never out of the language name, because two
projects in the same language can be built on opposite architectures. Each one detected is
written into `workspace.yml` with the line that proved it, whether the switch is on or not:
detection is a measurement, and the switch only decides whether the files get written.

A pack is interrogative. Its **Checks** are questions asked of every diff, each with a
`verify:` hint for what to open or run; its **Defaults** apply only where your repo is silent,
and each one names the signal that overrides it. Your repo's own conventions win — a pack that
argued with them would be worse than no pack. The Build reviewer sees no expert bodies at all,
so it is handed those Checks under a heading that says exactly that.

The body is yours the moment you touch it. `enable` replaces it only while it is still the stub
`init` seeded; an edited body is kept, and the command tells you which one it left alone. The
overlays are the framework's: rewritten on every `enable` and every `init`, removed by
`disable`. `knowledge/` is never touched by any of it.

Your project's own skills (`.claude/skills/*/SKILL.md`) are named to the developer too, switch
or no switch, each with the path to its `SKILL.md`: the harness runs a skill, and tldrx only
says it is there. One that git does not track is flagged, because a story worktree carries
tracked files only.

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
