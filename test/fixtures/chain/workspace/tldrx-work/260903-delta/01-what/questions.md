# Questions — 01-what — run 260903-delta

## Q1 · How far back does the retention window reach?
<!-- id: Q1 | status: open | area: data-model | asked_by: product | asked_at: 2026-09-03T09:40:00Z -->
Why asked: no retention rule exists in memory [src: absent:.tldrx/memory/facts.yml]

- A) 30 days
- B) All time

[Answer]:

## Q2 · Per tenant, or global?
<!-- id: Q2 | status: open | area: data-model | asked_by: product | asked_at: 2026-09-03T09:40:01Z -->
Why asked: it decides the partition key [src: api:src/Ledger/Entry.cs:14]

- A) Per tenant
- B) Global

[Answer]:
