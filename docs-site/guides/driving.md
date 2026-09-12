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

## Telling somebody: the notify hook

`run auto` stops for a person by printing to **stdout**, and stdout is in a terminal nobody is
watching. That is why unattended runs get abandoned for host-driven ones — and trading a metered
budget, an enforced model and parallel stories for a notification is a bad trade.

So `.tldrx/workspace.yml` may declare **one command** the run tells a person through:

```yaml
notify:
  command: "bin/notify-owner"
  events: [question.raised, gate.requested, run.failed]   # optional; omitted = every kind
```

tldrx names no chat tool. Which service reaches you is a decision about your life, not about a
build system. What the framework knows is *when* a person is needed and *exactly what to type*.

The command is split to argv and run directly — never through a shell, exactly like every other
command the workspace declares — and the payload arrives on **stdin** as one `version: 1` JSON
object: the kind, the run, a one-paragraph `summary` written to be read on a lock screen, and
`command`, the exact line to type with the run id already in it. An open question carries its
options and its recommendation; a gate carries the approve line; a finished run carries its exit
code and what that code's family means.

**A notifier never changes a run.** A missing binary, a non-zero exit, a hang — each is written
down as a `notify.failed` event with the reason, and the loop carries on with the exit code it
already had.

```bash
tldrx run auto --notify-every 10m --wait-answers 4h --wait-gates 4h
```

`--notify-every` adds a periodic `status` payload carrying what `tldrx run status` prints — a
heartbeat, asking for nothing while the run is moving. Over a run **parked** on an open
question — or on a **gate** waiting for your signature — it says so and repeats the literal
command, because a heartbeat that kept saying nothing is waiting on you would be worse than
silence. `--wait-answers` and `--wait-gates` are the two flags that change where the loop stops,
one for each half of exit `4`: instead of exiting at an open question it polls for an answer and
**resumes if you give one**, and instead of exiting at a pending gate it polls for a signature
and **resumes if somebody signs**, stopping with your note if you reject — or carrying on with
it when the rejection said `--and-continue`. A `gate.requested` payload names which of those the
gate is even about: `holding` says whether it is held by open questions, by unfinished stories or
by nothing mechanical, and a gate that can name what has to change carries the `--and-continue`
line ready to fire. Both exit `4` unchanged
when the wait lapses. Nothing is spent while either waits, and the loop closes nothing of its
own — it never signs its own gate, an `agent` policy included, and under the default
`questions_policy` it never answers its own question. The one exception is opt-in and recorded:
`run new --questions <stage:recommended,…|none>` lets the loop take a question's own
`Recommended:` option, through the same `tldrx answer` path, as `decided_by: agent-default`
with the alternatives on the fact and a `question.auto_answered` to your hook — and a question
with no recommendation, or tagged `irreversible: true` / `money: true`, still stops for you.

The operating half of this — the full payload per kind, an adapter skeleton you can paste,
a first-run checklist and what to check when nothing arrives — is
[Operating a run unattended](/guides/unattended-operation).

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

**A driver records its own decisions as the driver's.** An answer you never gave is not your
decision, and the mandate says so in those words: `tldrx answer <Qid> "…" --decided-by owner`
is yours to type, and a driver that answers on your behalf writes `--decided-by driver` — the
fact then says *driver* wherever it is quoted back, and it is never cited to you as yours. The
same rule already governed `tldrx facts add`, which requires the flag outright. Where the
driver is parking a question rather than answering it, `tldrx note <run> "…"` records the
moment and decides nothing.

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
