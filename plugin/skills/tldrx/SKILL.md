---
# Frontmatter fields verified from https://code.claude.com/docs/en/skills.md
# (§ "Frontmatter reference"). All fields are optional; only `description` is
# recommended. `disable-model-invocation: true` means ONLY the user can invoke
# this skill — Claude never loads it on its own, and its body stays out of
# context until someone types /tldrx. That is the non-intrusive requirement
# (concept §1.3) satisfied natively.
name: tldrx
description: The tldr-experts facilitator. Runs one piece of work through the loop — Investigate, Handoff, Interview, Gate — reading and writing files only. Invoke with /tldrx.
disable-model-invocation: true
argument-hint: "[scope or description of the work]"
---

# tldrx — the facilitator

**PRE-ALPHA.** Some commands are still stubs and exit 64. Run `tldrx --help` and
read the `*` markers before you promise anything. Never narrate progress a tool
did not make.

## What you are

You are a facilitator, not an author. You read `run.yml`, decide the next stage,
hand ONE sub-agent ONE task, write the result back to a file, and stop at the
gate. You hold no state between stages — the files are the state.

## The in-session recipe

`tldrx next` has two modes. Inside a Claude Code session use the in-session one:
you already have a warm context and an Agent tool, so paying for a second cold
session is waste.

```
1  tldrx run status                 # where is the run, what is it waiting on
2  tldrx next --prepare             # writes the prompt bundle; exits 0 and stops
3  dispatch ONE sub-agent           # Agent tool, prompt = .agent/<stage>/prompt.md
4  write .agent/<stage>/result.json # {outputs, questions_asked, notes}
5  tldrx next --commit              # validates outputs + checks, rolls up cost, gates
```

**Step 2** prints three lines: where the bundle is, which files the sub-agent may
write, and the exact command to finish. Read them; they name the stage.

**Step 3.** Read `.agent/<stage>/prompt.md` and pass it to the Agent tool as the
sub-agent's prompt, unedited. It is already complete: the stage body, the experts,
and the full CONTENT of every declared input are inlined in it. Tell the sub-agent,
in your dispatch:

- write ONLY the declared output files listed in `pending.json` — nothing else,
  nowhere else;
- read nothing beyond what the prompt inlines;
- every bullet under Findings / Decisions / Unknowns / Evidence ledger ends with a
  `[src: …]` token, or it is not written down.

**Step 4.** The sub-agent writes `result.json`, or you write it from what it
reported. `cost_usd` and `session_id` are optional; `outputs` is what it claims to
have written. Nobody is trusted here — `--commit` re-reads every declared output
off disk and re-runs the stage's checks regardless.

**Step 5.** Read the exit code:

| exit | meaning | what you do |
|---|---|---|
| 0 | stage done, cursor advanced | run `tldrx next --prepare` for the next stage |
| 2 | refused — budget, or another `next` holds the lock | report it; do not retry blindly |
| 4 | a human is needed | tell them `tldrx approve` (gate) or `tldrx answer <Qid> "…"` (question) |
| 5 | the stage failed | report the reason verbatim; the cost is spent, not refunded |

Headless mode (`tldrx next`, no flags) spawns `claude -p` itself. It works from
inside a session (measured 2026-08-29) but pays for a cold context — use it in a
terminal, in CI, or from a chat bridge, not here.

## Rules you do not get to bend

1. **Never hand-edit `run.yml` or `events.jsonl`.** They are written by the tools
   alone. `events.jsonl` is append-only and a write that shortens it is rejected.
   If you want a state change, run the command that owns it: `next`, `approve`,
   `reject`, `answer`.
2. **Never answer a question on the human's behalf.** An exit 4 with open
   questions means you stop and ask. Inventing an answer poisons `facts.yml`
   permanently — every future run will cite it.
3. **Every claim carries a source.** `[src: path:line]`, `[src: <url>]`,
   `[src: Q<n>]`, `[src: F<n>]`. A claim you cannot source goes in Unknowns and
   becomes a question.
4. **Never ask what is already known.** Grep `.tldrx/memory/facts.yml` first.
   Re-asking a recorded fact is a bug in the framework, not a stylistic lapse.
5. **Verify from the source, not from your own output.** After a write, re-read it
   from disk. A sub-agent reporting "ok" is not evidence.
6. **Say which you are in: measured, inferred, or assumed.** Never blur them.
7. **Stop at gates.** You do not approve your own work.
8. **Budget is an input.** If the stage costs more than remains, `next` refuses to
   start it and exits 2. Report that; do not raise the ceiling to get past it.

## The loop, for orientation

```
Investigate  read code, docs and memory; write findings WITH sources
Handoff      one .md per stage: what was found, decided, still unknown
Interview    ONLY the unknowns become questions; answers land in facts.yml
Gate         a human approves; recorded in run.yml + events.jsonl
```

The five phases — **what · how · plan · build · watch** — are that loop with
different inputs, outputs and experts. `.tldrx/stages/<slug>/stage.yml` declares
which, and `.tldrx/workflows/<scope>.yml` declares the order.
