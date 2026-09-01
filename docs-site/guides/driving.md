---
title: Attended or unattended
---

# Attended or unattended

There are three ways to run a stage, and the difference is one question: **who spawns the
sub-agent?**

## The three ways

| | who runs each turn | what it costs | where it stops |
|---|---|---|---|
| `tldrx next` / `tldrx run auto` | the framework spawns `claude -p` | metered per turn | the first human gate or open question |
| `tldrx run attend host`, driven from a Claude Code session | that session's own sub-agents | billed to your session | every turn — you drive it |
| the same, plus a written mandate | that session's own sub-agents | billed to your session | only a real decision |

`run auto` and `run attend host` read like two speeds of the same thing. They are
opposites, and they do not compose.

- **`run auto` is an engine.** It calls `next` over and over, headless, spawning a metered
  sub-agent stage after stage.
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
commands and a prompt. There is no keyword for the third part — the mandate is prose you
write.

```bash
tldrx run new payments --scope feature --budget 25 \
  --attended-by host --gates what:agent,plan:agent,build:agent,watch:agent
tldrx run attend host 260101-payments      # or flip a run that is already open
```

Then, in the session, tell it what it may and may not decide. The shape that works:

> Drive every stage yourself — `tldrx next --prepare <run>` and `tldrx next --commit <run>`
> — dispatching your own sub-agents. The framework must never spawn.
>
> For every build story, run an independent adversarial review through the `--review`
> handshake: `tldrx next --prepare --review`, one read-only sub-agent over the diff, then
> `tldrx next --commit --review`. Its job is to find what the developer got wrong.
>
> Approve a gate only after checking it yourself — that the citations resolve, that every
> touched path is one this run declared, that the diff matches the stories it claims to
> implement — and write that check down: `tldrx gate template`, fill it in, then
> `tldrx approve --as-agent`.
>
> Interrupt me only for a new product decision, a budget-ceiling raise, or work that has to
> go outside the declared boundary. Everything else you decide, and log.
>
> Never push. The final merge is mine.

`--gates` replaces the scope's gates wholesale, so name every stage you want signed —
anything you leave out becomes `auto`. `tldrx run attend --none <run>` hands the run back
to the framework.

The full chapter, including what "never spawns" is enforced by and the four ways an agent
gate falls through to a person:
[10 — Unattended mode](https://github.com/ederwii/tldr-experts/blob/main/docs/guide/10-unattended-mode.md).
