# Questions — 02-how — run 260828-leaderboard

## Q4 · Where does leaderboard state live?
<!-- id: Q4 | status: open | area: data-model | asked_by: architect | asked_at: 2026-08-28T14:02:11Z -->
Why asked: no ranking store exists in the map [src: absent:.tldrx/map/api/domains.md]

- A) New Postgres table, recomputed on hunt completion
- B) Redis sorted set
- C) other — write it below

[Answer]:

## Q5 · Is per-tenant isolation required for rankings?
<!-- id: Q5 | status: answered | area: multi-tenancy | asked_by: architect | asked_at: 2026-08-28T14:02:11Z -->
Why asked: Place.TenantId is nullable [src: api:src/Hunt.cs:5]

- A) Yes, per tenant
- B) No, global

[Answer]: B — rankings are global, same as Places
<!-- answered_by: alan | answered_at: 2026-08-28T15:10:03Z | fact: F021 -->
