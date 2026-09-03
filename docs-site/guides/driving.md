---
title: Attended or unattended
---

# Attended or unattended

There are three ways to run a stage, and the difference is one question: **who spawns the
sub-agent?**

## The three ways

| | who runs each turn | what it costs | where it stops |
|---|---|---|---|
| `tldrx next` / `tldrx run auto` | the framework spawns Claude Code, or Codex when selected | Claude: metered USD; Codex: unmetered tokens | the first human gate or open question |
| `tldrx run attend host`, driven from a Claude Code session | that session's own sub-agents | billed to your session | every turn — you drive it |
| the same, plus the `tldrx drive` mandate | that session's own sub-agents | billed to your session | only a real decision |

`run auto` and `run attend host` read like two speeds of the same thing. They are
opposites, and they do not compose.

- **`run auto` is an engine.** It calls `next` over and over, headless, spawning a sub-agent
  stage after stage. Claude turns carry provider-metered USD; Codex turns carry measured tokens
  and remain explicitly unmetered in dollars.
- **`run attend host` is a lock.** It sets one field, spends nothing, runs no stage. From
  then on the framework never spawns on that run — every turn is a
  `tldrx next --prepare` / `tldrx next --commit` handshake with a session you drive.

Mixing them is refused rather than guessed at: `run auto` on an attended run exits `1`, and
a bare `tldrx next` there exits `4` and prints the `--prepare` command you meant.

## Which to pick

- **A small run you were going to watch anyway** → `tldrx run auto`. One command, and it
  stops the moment it needs you.
- **A Claude Code session already open, and you care about cost or quality** →
  `run attend host`, driven from it. The context is already warm, so the turns are cheaper,
  and the framework writes the reviewer's bundle rather than spawning a second reader
  beside the one you are already paying for.
- **CI or cron** → `run auto`. It is the only one of the three with no session behind it.

## Hands off with `run auto`

```bash
tldrx run auto --max-usd 12 --until build
```

```
01-what/what … done $1.21 · auto-approved
02-how/how … done $2.60 · awaiting human gate
```

It stops at a human gate or an open question (exit `4`), a stage failure (`5`), a budget
refusal (`2`), or `--until <stage>`. It holds no state — every iteration re-reads
`run.yml` — so killing it leaves a run that `tldrx next` picks up unchanged. `--max-usd` is
checked *between* stages, so it can overshoot by at most one stage's share.

`--gate-agent` changes only what it prints when it stops: a **decision card** — the
question, its options, the recommendation if there was one, and the single command to type
— instead of the usual status block.

## Overnight, with the checking kept

The demanding case: nobody is watching, and you still want an adversarial review. Two
commands, and the second one writes the mandate.

```bash
tldrx run new payments --scope feature --budget 25 \
  --attended-by host --gates what:agent,plan:agent,build:agent,watch:agent
tldrx drive --unattended 260101-payments    # the mandate — paste it into the session
```

A run that is already open needs neither flag set in advance. The unattended mandate's
preflight establishes both itself — `tldrx run attend host <run>` for attendedness, and
`tldrx run gates set <stage>:agent` for each stage you delegated, over a note quoting your
own delegation so the change is signed by your words rather than the driver's judgement.

`tldrx drive` prints plain text for the session that will drive the run. It opens with the
**preflight**: attendedness, gate policy, and a `budget.yml` whose ceiling the driver has to
state in dollars. Where it cannot establish one of the three it refuses to start and names
the command that failed — preconditions being the discipline, not the setup for it. Then
the three-role protocol — a developer sub-agent, then a **fresh** read-only reviewer that
is never the author, then you, verifying both in the code rather than in their reports —
the evidence discipline (label every claim *measured* / *inferred* / *assumed*; never let a
pipe eat an exit code; ask the remote about the remote), what to park rather than decide,
how hard to review a story given its stakes, and what a signature has to rest on.

It is versioned with the package, so it cannot drift from the binary the way a playbook
pasted out of someone's chat history does. It needs no workspace, opens no run, spawns
nothing and writes nothing. `--attended` prints the other mandate, for when you are at the
keyboard closing every gate yourself; its preflight reads the same three and moves none of
them, because a driver that reset a gate there would be taking your signature rather than
earning it. Given a run id it fills every `<run>` slot in at once; given none it uses the
one open run, and where the CLI would refuse to choose between two it leaves the
placeholder rather than aim a mandate at the wrong run.

`--gates` replaces the scope's gates wholesale, so name every stage you want signed —
anything you leave out becomes `auto`. `tldrx run attend --none <run>` hands the run back
to the framework.

The full chapter, including what "never spawns" is enforced by and the four ways an agent
gate falls through to a person:
[10 — Unattended mode](https://github.com/ederwii/tldr-experts/blob/main/docs/guide/10-unattended-mode.md).
