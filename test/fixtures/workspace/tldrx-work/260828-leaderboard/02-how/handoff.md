# Handoff — 02-how / contracts — run 260828-leaderboard
Stage: contracts · Expert: architect · Model: sonnet · Cost: $2.61 of $3.00 ceiling · 2026-08-28T14:31:40Z

## Findings
- Hunt completion already emits a HuntCompleted domain event [src: api:src/Hunt.cs:8]
- The lab SDK is generated, so a DTO change is a two-repo change [src: F019]

## Decisions
- Leaderboard reads come from a materialised view refreshed on HuntCompleted [src: Q4]
- Rank rows are keyed by player id [src: lab:src/rank.ts:2]

## Unknowns
- Retention period for historical rankings [src: absent:.tldrx/memory/facts.yml]
- Whether mobile needs paging beyond top-50 [src: Q4]

## Evidence ledger
- Contract project builds clean [src: $ dotnet build → exit 0]
- Vendor rate limits confirmed [src: https://developers.example.com/limits]
