# Feasibility & Constraint Analysis — Questions

## Sources

- [desc] Initial description: "Build the Scavtopia Scoring & Leaderboard System. The product brief is at \"aidlc-seeds/Scavtopia Scoring & Leaderboard System.md\" in this workspace — read it first and treat it as the seed for this workflow."
- [scope] Workflow-selected scope: `feature`.

> Grounded in the existing Scavtopia stack (per the repo's root CLAUDE.md): .NET 10 backend on Azure, PostgreSQL 16, Azure App Insights, mobile on Firebase auth, Lab on Auth0. This feature is built into that existing product. Consumed context: intent statement + market research (`../intent-capture/`, `../market-research/`).

## Q1. Which existing hunt events can the scoring engine draw from, and what's missing?

Scoring needs: target found, hint tier (highest hint revealed), share (per target), hunt completion, and completion time. The backend already handles target-found, hint fetches (levels 1–3), and hunt completion; the brief notes a share is client-side and can't be verified.

- A. Confirmed — target-found, hint level, and completion already exist server-side; only the per-target "share" tap needs a new client→server signal (a fire-and-forget event). Score computed server-side at completion.
- B. As A, but I'm not sure hint level is persisted per target — flag it to verify in domain design.
- C. Not sure which events exist — treat all scoring inputs as "to verify against the backend" during design.
- X. Other (please specify)

[Answer]: C

## Q2. Confirm the technical approach: build into the existing backend?

- A. Yes — add scoring as new domain entities + a score event table + leaderboard queries inside the existing .NET/Clean-Architecture backend and PostgreSQL; no new service or datastore. (Matches the build-in-house call.)
- B. Yes to in-house, but leaderboard reads may need a cache (e.g. Redis/sorted sets) if query load is high — flag for NFR/design.
- C. Not yet decided — evaluate in domain/NFR design.
- X. Other (please specify)

[Answer]: A

## Q3. How does the account-at-finish claim flow work, given existing auth?

The brief specifies display name + email + magic link (passwordless), score held locally and posted on account creation within a window. Mobile currently uses Firebase (anonymous); Lab uses Auth0.

- A. Reuse Firebase — upgrade the anonymous mobile user to an email/passwordless (magic-link) Firebase account at the finish line; score posts on link completion. No new auth system.
- B. Introduce a dedicated magic-link flow separate from Firebase/Auth0.
- C. Not sure — flag auth-integration approach for design; treat as a known feasibility risk.
- X. Other (please specify)

[Answer]: C

## Q4. What regulatory / privacy constraints apply?

Personal data in Phase 1: display name + email (accounts), plus location-derived scores. No payments touch score (score can't be purchased). Public boards show display names (top 10 visible to all).

- A. Treat GDPR/CCPA personal-data handling (email, display name, DSAR/erasure, retention) and public-display consent as applicable constraints; no PCI (no payment in score), no HIPAA. Minors: flag age/public-ranking as a risk to confirm.
- B. As A, but the team already has a privacy/data-handling baseline this must conform to (I'll note it).
- C. Not identified — capture as open compliance risk for requirements.
- X. Other (please specify)

[Answer]: A

## Q5. What are the budget, timeline, and organizational constraints?

- A. No hard budget/timeline constraints to record now; standard roadmap delivery, no change freeze — defer sizing to delivery planning.
- B. There is a target timeline or milestone I should record (I'll specify).
- C. Not identified.
- X. Other (please specify)

[Answer]: A

## Q6. How much anti-cheat / integrity is feasible for Phase 1?

The brief says flagged scores simply don't appear (no player penalty), detecting implausible movement, GPS spoofing, impossible target sequences.

- A. Phase 1 does lightweight, server-side plausibility checks (implausible speed between targets, impossible sequences) and excludes flagged scores from boards; deep anti-spoofing is deferred. Capture as a constraint + RAID risk.
- B. Defer all anti-cheat to a later phase — Phase 1 posts all scores; flag the integrity gap as an accepted risk.
- C. Not sure — treat anti-cheat depth as an open design question.
- X. Other (please specify)

[Answer]: A

## Consolidated Summary Confirmation

- Looks correct
- Request changes

[Answer]: Looks correct
