# Handoff — 01-what / what — run 260901-scoreboard
Stage: what · Expert: product · Model: sonnet · Cost: $2.40 of $1.00 ceiling · 2026-09-01T11:40:00Z

Background reading: [the ranking API notes](https://developers.example.com/ranking) and the
`.tldrx/map/api/domains.md` entry for hunts.

## Findings

- Hunt completion already emits a HuntCompleted domain event [src: api:src/Hunts/Hunt.cs:184]
- The lab SDK is generated, so a DTO change is a two-repo change [src: F007]

## Decisions

- Rankings are global rather than per tenant [src: Q1]

## Unknowns

- Retention period for historical rankings [src: absent:.tldrx/memory/facts.yml]

## Evidence ledger

- The API project builds clean [src: $ dotnet build → exit 0]
