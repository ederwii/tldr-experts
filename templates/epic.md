---
# Written to tldrx-work/<run>/03-plan/epics/<id>.md. Spec §2.14.
#
# An epic is a branch and a list of stories. `epic/<slug>` is cut from the repo's
# default_branch; each story's worktree branches off it and merges back on green;
# the epic merges to main after integration tests and a human gate (concept §9).
version: 1
id: E1
title: "Player leaderboard"
repos:
  - example
stories:
  - S1
branch: epic/leaderboard
status: todo                 # todo | in_progress | review | done | blocked
---

# E1 · Player leaderboard

## Why

What this epic is for, sourced. Two or three sentences.

## Stories

| Story | Repo | Depends on | Status |
|---|---|---|---|
| S1 | example | — | todo |

## Integration test

What has to be true across the stories before this branch merges to main — the
thing no single story can prove on its own.

## Gate

Blocked on: **human approval**, after the integration test is green. Recorded in
`run.yml` and `events.jsonl`; nothing merges before it is.
