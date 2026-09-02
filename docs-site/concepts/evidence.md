---
title: Evidence
---

# Evidence

The failure mode of an AI writing about your codebase is the confident paragraph about
code nobody opened. tldrx's answer is mechanical: **a claim without a source is not
written down.**

Every bullet a stage writes into its handoff has to end with a source token. If one does
not, the stage is refused — before the gate, not after.

```markdown
## Findings
- Hunt completion already emits a HuntCompleted event [src: api:src/Hunts/Hunt.cs:184]
- The lab SDK is generated, so a DTO change is a two-repo change [src: F003]

## Unknowns
- Retention period for historical rankings [src: absent:.tldrx/memory/facts.yml]

## Evidence ledger
- Contract project builds clean [src: $ dotnet build → exit 0]
```

## The kinds of source

| Looks like | Means |
|---|---|
| `api:src/Hunts/Hunt.cs:184` | a file and a line — the file must exist and the line must be in range |
| `F003` | an answer you gave, from `.tldrx/memory/facts.yml` |
| `Q6` | a question asked in this run |
| `$ dotnet build → exit 0` | a command that was run — only commands your `workspace.yml` declares, and only in the Evidence ledger |
| `https://…` | a document; `http://` is rejected |
| `graph:<node>` | a node in the code map |
| `absent:path/to/file` | *we looked here and found nothing* |
| `aidlc:intents/260821/design.md:14` | a line in the AI-DLC intent folder a `run new --from` distilled — or `#Q3`, one of its answered questions. Recorded, never resolved: that folder sits outside the workspace and may be gone by the time anyone reads the handoff |

`absent:` is the one that makes honesty cheap. "There is no retry policy" is a claim, and
this is how it gets sourced. It is refused on a **positive** claim outside the `Unknowns`
section — you cannot cite an empty directory as proof that something exists.

## Three outcomes, not two

Each source resolves to `ok`, `refused`, or `unverified`.

- **refused** — the file does not exist, the line is out of range, the fact id is not in
  `facts.yml`, the command is not one your workspace declared. The stage fails.
- **unverified** — nobody could check it. There is no `facts.yml` yet; the workspace
  declares no commands; nothing in the workspace cites that URL. This is **not** a lie and
  it does not fail the stage — but it does stop an [auto gate](/concepts/gates) from
  closing, because a citation nothing can check is exactly the one a person should read.

This distinction was earned. Before it existed, six of the eight kinds returned `ok`
unconditionally, and a handoff citing an invented fact id, an invented question and an
invented graph node to assert *"we removed the auth check from /admin"* validated clean,
closed its own auto gate, and advanced the cursor. That was a measured probe, not a
hypothetical.

## What the checker will and will not tell you

It checks that the citation **resolves**. Whether the cited line actually supports the
sentence is a separate question, and a human at a gate is still the one answering it. The
checker's job is to make the cheap failures impossible so your attention goes to the
expensive ones.

Two small rules worth knowing, both from real refusals:

- The token must be the **last thing** on the line. Trailing punctuation is fine; wrapping
  the citation in backticks is not — a real first run was refused with "9 unsourced
  bullets" when all nine carried a citation inside backticks. That case now reports
  *malformed citation* instead, because the two need different advice.
- A section with nothing in it is written as `- none [src: absent:<what was looked at>]`,
  never as a prose sentence. "No unknowns that we can see" is precisely the claim that most
  needs a source.

## The same rule applies to money

Every dollar `tldrx cost` prints was reported by the model provider and read off an event
in the run's log. No token count is ever multiplied by a price. Work whose cost was never
observed is reported as `UNMETERED`, not as `$0.00` — a missing number and a free turn are
different claims. See [budgets](/concepts/budgets).

The grammar, the resolution rules and every refusal are specified in
[`docs/spec.md` §2.8](https://github.com/ederwii/tldr-experts/blob/main/docs/spec.md).
