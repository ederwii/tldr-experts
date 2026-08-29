# Pilot runbook — full loop, unattended, in a fresh session

Purpose: exercise What → How → Plan → Build → Watch for real, on a THROWAWAY clone, with a
hard budget, answering interview questions with defaults and approving gates automatically.
This tests the *mechanics* (spawns, files, gates, branches, DoD), not human judgement.
Do it in a fresh Claude Code session (this needs no prior context) — paste the block below.

```
You are running the tldrx pilot runbook (docs/plans/pilot-runbook.md in ~/tldr-experts).
1. git clone <repo> /tmp/tldrx-pilot/<name> && cd there (never the real checkout).
2. tldrx doctor; tldrx init --no-interview [--stack …]; tldrx install --claude --project --skill-only.
3. tldrx run new pilot --seed <requirements.md> --scope feature --budget <USD>  (start with 20).
4. Loop until status is done|blocked or budget is exhausted:
   - tldrx next            (headless; report exit code and the last 3 lines every time)
   - if awaiting_answer:   tldrx interview --yes-to-defaults   (piped defaults; never invent facts)
   - if awaiting_gate:     read the stage handoff, then tldrx approve --note "pilot auto-approve"
   - if failed:            tldrx run status; if the failure is a framework bug, STOP and report;
                           if it is a budget gate, tldrx budget raise <phase> <usd> once, then retry.
5. After Build: list branches/worktrees created, DoD results per story, reviewer verdicts.
6. Write /tmp/tldrx-pilot/<name>/PILOT-REPORT.md: per stage → exit code, cost, attempts, files
   written, every failure verbatim, and a "bugs to file" list with file:line hints from the tldrx
   source (~/tldr-experts/src). Total cost from `tldrx run status`.
Rules: never push; never edit run.yml; never exceed the run ceiling except one budget raise per
phase; report measured numbers only.
```
