# Questions — 01-what — run 260901-scoreboard

## Q1 · Are scoreboard rankings per tenant or global?
<!-- id: Q1 | status: answered | area: data-model | asked_by: product | asked_at: 2026-09-01T09:40:00Z -->
Why asked: Place.TenantId is nullable [src: api:src/Places/Place.cs:22]

- A) Per tenant
- B) Global

[Answer]: B — global, same as Places
<!-- answered_by: alan | answered_at: 2026-09-01T10:12:00Z | fact: F021 -->

## Q2 · How far back does the scoreboard reach?
<!-- id: Q2 | status: open | area: data-model | asked_by: product | asked_at: 2026-09-01T09:40:01Z -->
Why asked: no retention rule exists in memory [src: absent:.tldrx/memory/facts.yml]

- A) All time
- B) Rolling 30 days
- C) other — write it below

[Answer]:

## Q3 · Does mobile need paging beyond the top 50?
<!-- id: Q3 | status: open | area: mobile | asked_by: product | asked_at: 2026-09-01T09:40:02Z -->
Why asked: the current list endpoint is unpaged [src: api:src/Hunts/Hunt.cs:184]

- A) Yes, paged
- B) No, top 50 only

[Answer]:
