# Review — story S1 — run 260829-build

## Role

You are the reviewer. You read; you do not write. Your verdict decides whether this
story is done, so it is the only thing you are asked for.

## Objective

Judge the diff of `story/260829-build/S1` against the acceptance criteria of **S1 · First story** and the conventions below.

Read the diff with, from this working directory:

    git diff epic/e1...story/260829-build/S1

## Acceptance criteria

- S1 exists and the suite is green

## Definition of Done — already re-run by the facilitator

- `npm run test` → exit 0

Do not re-run them. They passed; that is why you are being asked.

## Conventions

<!-- .tldrx/conventions/shared.md -->
# Shared conventions

- Done means proven.

## The story

````markdown
---
version: 1
id: S1
epic: E1
title: "First story"
repo: app
status: todo
depends_on: []
touches: ["s1.txt"]
acceptance:
  - "S1 exists and the suite is green"
test_plan:
  - "Unit: the S1 file is written"
evidence: []
---

# S1 · First story

## Context

Written by the fixture. [src: 03-plan/waves.yml:1]

## Definition of done

```dod
npm run test
```

## Evidence

Filled by Build.
````

## Produce

Return the result envelope and nothing else. Its SHAPE is deliberately NOT described
here, and it must not be reconstructed from memory: the authority is the JSON schema
this handshake already carries — `result_schema` in the `pending.json` beside this
prompt when a host is dispatching you, and the `--json-schema` you were spawned with
when the framework is. Read it there and satisfy it verbatim.

One bound the schema cannot state: everything you write is copied into a single
`events.jsonl` payload, and a payload over 4096 bytes is not trimmed — it is
thrown out whole, and the reasons for your verdict go with it. Two or three
sentences of prose per point, and this never comes up.

## Verdict

Which verdict to return is the judgement you are here for — the schema says what the
envelope looks like, and nothing about which of these is true.

- `approve` — every acceptance criterion is met by the diff and the conventions hold.
- `changes` — something is missing, wrong or unconventional. It costs a whole second
  attempt, so ask only for what the acceptance criteria or the conventions require.
- `fixlist` — you would sign, AND you found defects the acceptance criteria never
  covered. Costs the story no attempt, and there is exactly one such round. The schema
  has a slot for each defect and for how it is to be treated: `fix-now` is this story's
  own correctness and blocks `done`, `defer-with-log` is real but somebody else's call,
  `out-of-scope` is neither, and `refuted` says the defect is not one. A `refuted` defect
  MUST carry an `[src: …]` citation proving it wrong — your verdict is a claim like any
  other. Anything the author must NOT do about a defect belongs in the schema's slot for it.

## Rules

- Judge the DIFF, not the repository. Pre-existing problems are not this story's.
- You have no write tool. Do not attempt to edit, commit or fix anything.

## Citation grammar — `[src: …]`

`claim-sources` reads every `.md` this stage declares, at WRITE time (a hook that refuses
the edit) and again at the gate. What follows is GENERATED from that reader's own patterns
and constants, so it is the grammar itself, not a description of it.

### The token

A citation is `[src: <src>]` — the marker, a colon, ONE space, the sources, `]`. Several
sources are joined by `; ` inside one token. The reader matches it with

    /\[src: ([^\]]*)\]$/

Two things follow from that regex, and they are what cost run `260830-ordering-inventory`
three attempts:

- the `$` anchor means the token must be the **last thing on the line**. A `[src: …]` written
  mid-sentence is not seen at all — the line reads as an unsourced claim.
- `[^\]]*` means a `]` **inside** the token ends it early and the match fails. A citation that
  quotes an array or a list loses its whole token.

Closing punctuation may follow the `]` — a trailing backtick, quote, paren or full stop is
fine, because the reader strips this off the end first. WORDS after it are not.

    [`'"’”»)\s.,;:!?]+$

### The sources

| kind | shape | a token that parses |
| --- | --- | --- |
| `file` | `[repo:]path:line[-line]` | `[src: api:src/Selector.ts:241]` |
| `doc` | `https://` + a non-space URL | `[src: https://example.com/spec]` |
| `answer` | `Q<n>` (^Q\d{1,6}$) | `[src: Q3]` |
| `fact` | `F<nnn>` (^F\d{3,6}$) | `[src: F102]` |
| `cmd` | `$ <command> → exit <n>` (^\$ (.+) → exit (\d{1,3})$) | `[src: $ bun test → exit 0]` |
| `graph` | `graph:<node id>` | `[src: graph:hunt-engine]` |
| `absent` | `absent:<the path you looked at>` — add `#<what you searched for>` to have it CHECKED | `[src: absent:docs/retention.md#retention]` |
| `aidlc` | `aidlc:<file>:<line>` or `aidlc:<file>#Q<n>` (^(.+):(\d{1,9})$) | `[src: aidlc:intents/260821/design.md:14]` |

### The rules, and what each one refuses

Every rejection you can get on this path names one of these ids. Under each one: the pattern
that enforces it, a line the reader refuses, and the same claim written so it passes.

**`trailing-position`** — the `[src: …]` token is the LAST thing on the line — a citation written mid-sentence is invisible to the reader, which anchors the token to end-of-line.

    enforced by: \[src: ([^\]]*)\]$   ·   [`'"’”»)\s.,;:!?]+$
    refused:     - it drops places [src: api:src/Sel.ts:2] before ranking
    accepted:    - it drops places before ranking [src: api:src/Sel.ts:2]

**`no-bracket-inside`** — no `]` anywhere INSIDE the token — the reader stops at the first one, so a quoted list or an array in the citation truncates the match and the whole token is lost.

    enforced by: \[src: ([^\]]*)\]$
    refused:     - four pids skipped [src: api:src/Sweep.ts:88 (pids: [119,120])]
    accepted:    - four pids skipped, 119 and 120 among them [src: api:src/Sweep.ts:88]

**`marker-spelling`** — the token opens with `[src: ` — the marker, a colon and ONE space; `[src:x]` is not a token.

    enforced by: \[src: ([^\]]*)\]$
    refused:     - hints are synchronous [src:api:src/Hints.ts:12]
    accepted:    - hints are synchronous [src: api:src/Hints.ts:12]

**`empty-token`** — a token names at least one source — `[src: ]` cites nothing and is refused like an uncited claim.

    enforced by: \[src: ([^\]]*)\]$
    refused:     - no retention policy is recorded [src: ]
    accepted:    - no retention policy is recorded [src: absent:docs/retention.md]

**`empty-source`** — sources inside one token are joined by `; ` and none of them may be empty.

    enforced by: ; 
    refused:     - two things happened [src: api:src/A.ts:1; ]
    accepted:    - two things happened [src: api:src/A.ts:1; api:src/B.ts:2]

**`cmd-arrow`** — a command source reads `$ <command> → exit <n>` with the REAL arrow → (U+2192) — ASCII `->` is not the arrow and is refused.

    enforced by: ^\$ (.+) → exit (\d{1,3})$
    refused:     - the suite is green [src: $ bun test -> exit 0]
    accepted:    - the suite is green [src: $ bun test → exit 0]

**`doc-https`** — a `doc` source is `https://` followed by a non-space URL — `http://` is refused.

    enforced by: https://
    refused:     - the SDK is generated from the spec [src: http://example.com/spec]
    accepted:    - the SDK is generated from the spec [src: https://example.com/spec]

**`file-shape`** — a `file` source is `[repo:]path:line[-line]` — a path with no line number cites a file, not a fact.

    enforced by: ^\d{1,9}$   ·   ^(\d{1,9})-(\d{1,9})$
    refused:     - the API binds to all interfaces [src: src/Program.cs]
    accepted:    - the API binds to all interfaces [src: src/Program.cs:41]

**`line-range`** — what follows the LAST `:` is a line number or a `line-line` range, and the range ascends.

    enforced by: ^\d{1,9}$   ·   ^(\d{1,9})-(\d{1,9})$
    refused:     - the handler validates the token [src: api:src/Auth.ts:12-x]
    accepted:    - the handler validates the token [src: api:src/Auth.ts:12-18]

**`line-number`** — line numbers are 1-based — there is no line 0.

    enforced by: ^\d{1,9}$
    refused:     - the file opens with a fence [src: api:src/Auth.ts:0]
    accepted:    - the file opens with a fence [src: api:src/Auth.ts:1]

**`no-parent-dir`** — `..` is not allowed in a source path — cite from the repo root, not from where you stood.

    enforced by: ..
    refused:     - the config lives one level up [src: api:../shared/config.ts:3]
    accepted:    - the config lives one level up [src: api:shared/config.ts:3]

**`id-shape`** — an answer is `Q<n>` (^Q\d{1,6}$) and a fact is `F<nnn>` (^F\d{3,6}$).

    enforced by: ^Q\d{1,6}$   ·   ^F\d{3,6}$
    refused:     - the owner picked option (a) [src: Q]
    accepted:    - the owner picked option (a) [src: Q3]

**`graph-node`** — `graph:` carries a non-empty node id with no spaces in it.

    enforced by: graph:
    refused:     - the hunt module owns selection [src: graph:]
    accepted:    - the hunt module owns selection [src: graph:hunt-engine]

**`absent-path`** — `absent:` carries the path you looked at — an absence names what was checked or it is not evidence.

    enforced by: absent:
    refused:     - no retention policy is recorded [src: absent:]
    accepted:    - no retention policy is recorded [src: absent:docs/retention.md]

**`absent-needle`** — `absent:<path>#<needle>` carries the words you searched for — `#` with nothing after it says you searched for nothing.

    enforced by: absent:   ·   #
    refused:     - no retention policy is recorded [src: absent:docs/retention.md#]
    accepted:    - no retention policy is recorded [src: absent:docs/retention.md#retention]

**`aidlc-shape`** — an `aidlc` source is `aidlc:<file>:<line>` or `aidlc:<file>#Q<n>`.

    enforced by: ^(.+):(\d{1,9})$   ·   ^(.+)#(Q\d{1,6})$
    refused:     - the intent named two personas [src: aidlc:intents/260821/design.md]
    accepted:    - the intent named two personas [src: aidlc:intents/260821/design.md:14]

### The document rules

A `handoff.md` carries four H2 sections, in this order: Findings, Decisions, Unknowns, Evidence ledger.

- every list item under Findings / Decisions / Unknowns / Evidence ledger ends with a `[src: …]` token.
- each of Findings / Decisions / Unknowns / Evidence ledger holds at least one list item — prose alone is not a claim. A section with genuinely nothing in it is written as one item:
  `- none [src: absent:<what you looked at>]`.
- a handoff carries at most 200 list items across the four sections — beyond that cap it is a document, not a handoff.
- `$ <command> → exit <n>` is legal in `Evidence ledger` and nowhere else, and the
  command must be one of `.tldrx/workspace.yml`'s, verbatim.

Every OTHER `.md` this stage declares carries only the second half of that: a bullet may be
prose, but a `[src: …]` it does write must parse by the rules above and must resolve.

A soft-wrapped bullet is joined before it is read, so the token may sit on the continuation
line — the rule is about the ITEM's last element, not the file's line width.

## Stop

Return the envelope and stop.
