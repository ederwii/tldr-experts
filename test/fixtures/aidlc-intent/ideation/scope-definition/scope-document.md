# Scope Document — Scavtopia Scoring & Leaderboard (Phase 1)

Defines the in/out boundary for the Phase 1 build, refining
`../intent-capture/intent-statement.md` and respecting
`../feasibility/feasibility-assessment.md` and
`../feasibility/constraint-register.md`.

## In Scope (Phase 1)

**MVP core (must-have):**
- Scoring engine — computes hunt score from the baseline formula
  `(target points + hint tier + shares + completion bonus) × speed modifier`,
  with per-account replay dedup keyed on target, and point values stamped on the
  score event at play time. [desc] [Q1]
- Score-event persistence — timestamped event rows (per-target and per-hunt) that
  all boards query; city stamped on the event from day one (not surfaced yet). [desc] [Q1]
- Score board — the cumulative points board over the **Week** period. [Q1]
- Account-at-finish claim flow — passwordless display-name + email claim that
  posts the just-finished hunt's result; integrates with existing auth. [Q1] [Q4]

**Should-have (same build, sequenced after the core):**
- Targets board and Hunts board. [Q1] [desc]
- All-Time period across all boards. [Q1]
- Player's own rank always visible (even outside top 10). [desc]
- Finish-screen rank + near-miss context line. [Q4]
- Soft "save your score" prompt; ghost rank + top-10 qualifying prompt. [Q4]
- Per-target share signal (new client→server event) + the +10 share bonus. [desc] [feasibility-assessment]
- Spectator visibility — top 10 visible to non-account holders. [desc]

**Could-have:**
- Lightweight server-side integrity checks (implausible speed, impossible
  sequences) that silently exclude flagged scores. [Q6-feasibility]

## Out of Scope (Phase 1)

- Later phases entirely: Discoveries (2), Challenge Mode (3), Escape Room (4),
  Mission Packs (5). [intent-statement] [Q5]
- Span and difficulty scoring multipliers. [Q5] [intent-statement]
- "Best Run" (highest single-hunt) board. [Q5]
- Extra periods (Month, Today). [Q5]
- Geographic/city boards surfaced to players (city is stamped on the event now,
  but no city-scoped board ships). [Q5] [desc]
- Crew Hunt / friends mode; badges, recognition, archives, placement rewards. [Q5]

## Sequencing Approach

Risk-first: the two feasibility unknowns — verifying which scoring events exist
server-side, and the account-at-finish auth integration — are sequenced earliest
(as a spike / verification) before boards are built on top. [Q2]
[feasibility-assessment]

## Value Stream (capability → outcome)

- Score-event capture + scoring engine → a comparable score exists per hunt →
  enables every board and the headline account-conversion hook. [Q1]
- Score board (Week) + own-rank → players see standing → weekly retention. [Q3-intent]
- Account-at-finish claim → anonymous → registered → account-conversion (headline
  metric). [Q4] [intent-statement]
- Completion bonus weighting → finishing rewarded → lower abandonment. [desc]

## Assumptions & Open Questions

- Numeric success-metric thresholds remain deferred to requirements. [assumption]
- Retention/consent/retention-window policy for public display is deferred to
  requirements (per the constraint register). [assumption]
