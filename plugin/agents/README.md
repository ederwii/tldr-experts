# Agents

**Nothing ships here.**

Experts in tldr-experts are *generated per project* by `tldrx init` (concept §4.5):
one stack expertise per language/framework detected, one domain expert per detected
domain. They are written to the project's `.tldrx/experts/<name>/` as a pair of
files:

```
.tldrx/experts/<name>/
  expert.md          role, domain, how to reason, what to cite
  competencies.yml   {area, level 0-5, evidence: [...], last_trained}
  knowledge/*.md     trained material, with file:line provenance (v1.1)
```

A shipped `agents/*.md` here would be the opposite of that: a fixed cast of
personas that knows nothing about your code. If a stage needs a persona, it names
it in `stage.yml` and the facilitator loads the generated file.

See `templates/expert.md` and `templates/competencies.yml` for the shapes
`tldrx init` will write.
