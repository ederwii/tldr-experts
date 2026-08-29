# Constraint Register — Scavtopia Scoring & Leaderboard

Constraints governing the Phase 1 build defined in
`../intent-capture/intent-statement.md` and informed by
`../market-research/build-vs-buy.md`.

## Technical Constraints

| ID | Constraint | Source |
|----|-----------|--------|
| TC-1 | Build into the existing .NET Clean-Architecture backend and PostgreSQL; no new service or datastore. | [Q2] |
| TC-2 | Scoring must derive from existing hunt events where they exist; the per-target share needs a new client→server signal. | [Q1] |
| TC-3 | Leaderboards are windowed queries over timestamped score-event rows (Week + All-Time); a running counter is insufficient. | [Q2] [desc] |
| TC-4 | Account-at-finish must integrate with existing auth (mobile Firebase, Lab Auth0); passwordless display-name + email claim. | [Q3] |
| TC-5 | Point values are stamped on the score event at play time so recalibration applies forward only (per the brief). | [desc] |

## Organizational Constraints

| ID | Constraint | Source |
|----|-----------|--------|
| OC-1 | No hard budget or timeline constraint recorded; standard roadmap delivery, no change freeze. | [Q5] |
| OC-2 | Decisions are made collaboratively by the three-person team (Jay/product, Alan/dev, Will/founder). | [Q5] |

## Regulatory & Privacy Constraints

| ID | Constraint | Source |
|----|-----------|--------|
| RC-1 | GDPR/CCPA personal-data handling applies to email + display name (lawful basis, DSAR/access, erasure, retention). | [Q4] |
| RC-2 | Public leaderboard displays player display names to all (top 10 visible to non-account holders) — requires consent/notice at account creation. | [Q4] [desc] |
| RC-3 | Data retention: weekly board data retained for a defined analytics period; personal bests persist until deleted (per brief) — retention policy to be defined. | [Q4] [desc] |
| RC-4 | Minors + public ranking is an open concern to confirm (age handling). | [Q4] |
| RC-5 | No PCI (score cannot be purchased) and no HIPAA apply. | [Q4] |
| RC-6 | Identity is display-name-only, no social graph, no real names (privacy stance). | [desc] |

## Assumptions & Open Questions

- The existing Azure/PostgreSQL platform is the deployment target; no new
  infrastructure constraint identified at this stage. [assumption]
