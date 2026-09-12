---
title: Operating a run unattended
---

# Operating a run unattended

"Unattended" here does not mean *nobody decides anything*. It means **nobody has to be
watching a terminal** for the run to keep moving, and the moments that genuinely need a
person reach that person wherever they are — instead of scrolling past in a window nobody
has open.

Four things are still a person's, always: a new product decision, a budget ceiling going
up, work that leaves the boundary the What cited, and the final merge. The whole design
here is about making those four reachable in seconds, not about removing them.

## The two ways to drive a run

**A host session — `tldrx run attend host`.** A lock, not an engine: it sets one field on
the run and from then on the framework never spawns on it. Every turn is a
`tldrx next --prepare` / `tldrx next --commit` handshake with a session you drive, so you
get that session's judgement and its own tools, and it can already reach you because you
are talking to it. What you give up is the metering — those turns are billed to your
session, not measured per stage — and the parallelism: a host session drives one turn at a
time. This is the mode [`tldrx drive`](/guides/driving#overnight-with-the-checking-kept)
writes a mandate for.

**The engine — `tldrx run auto`.** A headless loop that calls `next` over and over,
spawning a metered sub-agent stage after stage. You get a per-stage USD meter, an enforced
model, and stories inside one build wave running in parallel. What it does not have is a
way to reach anybody: it announces an open question or a gate by exiting `4` and printing
to **stdout**. Everything below is how you give it one.

The two do not compose, and mixing them is refused rather than guessed at: `run auto` on a
run marked `attended_by: host` exits `1`, before the event log is opened.

## Declaring the hook

One optional block in `.tldrx/workspace.yml`. A workspace without it notifies nothing and
behaves exactly as it did before the key existed.

```yaml
notify:
  command: "bin/notify-owner"          # a single argv line, like `commands:` — no shell is opened
  events: [question.raised, gate.requested, run.failed]   # optional; omitted means every kind
  timeout_s: 30                        # optional; one invocation's ceiling
```

- **`command` is argv, never a shell line.** It is split and executed directly, exactly
  like every other command a workspace declares, and a bare shell metacharacter
  (`|`, `&`, `;`, `<`, `>`, `$`, backtick, parens, braces, `*`, `?`, `~`) is **refused**
  rather than shelled. If you need a pipeline, put it in a script and declare the script.
  The payload never touches the command line either — a question's own title could
  otherwise become shell syntax.
- **`events` filters by kind.** Omitting it means *every* kind, deliberately: someone who
  declared a command wants to hear about the run, and a default that silently subscribed to
  nothing would be a configured hook that never fires and never says why. An unknown kind is
  a validation error.
- **`timeout_s` bounds one invocation** (30 seconds by default). A notifier is a message,
  not a job.
- **A failing notifier never changes the run.** A command that will not split, a binary
  that is not there, a non-zero exit, a timeout — each is written down as a `notify.failed`
  event carrying the reason and then dropped. "The owner was not told, and here is why" is a
  fact about the run; "the side channel was down, so the run failed" would make a side
  channel load-bearing. A delivered one is `notify.sent`, with the kind, the child's exit
  code and its duration. Both cost `$0.00`.

`tldrx init` writes the block **commented out**, with a line saying what it is for. It does
not guess a command: who gets woken up is not a thing to detect.

## The payload

One JSON object on **stdin**, `version: 1`, with the same nine top-level keys every time:
`version`, `kind`, `at`, `run`, `root`, `stage`, `summary`, `command`, `detail`.

`summary` is one paragraph written to be read on a lock screen. `command` is the exact line
to type, run id already in it — or `null`, honestly, when there is nothing to do; an
invented next command would be the framework guessing at an intention. `stage` is
`<phase>/<stage>`, or `null` when the notification is about the run as a whole. `root` is
the absolute workspace root, because a script is not otherwise told where the run lives.
`detail` is per-kind and always an object.

### `question.raised` — the one the whole feature exists for

```json
{
  "version": 1,
  "kind": "question.raised",
  "at": "2026-09-07T18:20:04.117Z",
  "run": "260907-checkout",
  "root": "/Users/alan/code/checkout",
  "stage": "01-what/what",
  "summary": "260907-checkout stopped at 01-what/what on 1 open question(s): Q1 · Should an abandoned hunt count toward the leaderboard?. The run is parked until one is answered; nothing is being spent while it waits.",
  "command": "tldrx answer Q1 \"…\" --run 260907-checkout",
  "detail": {
    "questions": [
      {
        "id": "Q1",
        "title": "Should an abandoned hunt count toward the leaderboard?",
        "why_asked": "no rule for abandoned hunts exists in memory [src: absent:.tldrx/memory/facts.yml]",
        "options": [
          { "letter": "A", "text": "count them" },
          { "letter": "B", "text": "drop them" }
        ],
        "recommendation": { "option": "B", "why": "matches how players talk about it", "src": "01-what/handoff.md:22" },
        "answer_command": "tldrx answer Q1 \"…\" --run 260907-checkout"
      }
    ]
  }
}
```

The top-level `command` is the **first** question's answer command — a payload has one
`command` slot, and questions are answered one at a time. A script that wants to render a
button per question reads `detail.questions[]`. The options arrive as `{letter, text}`
rather than a rendered `A) …` line, so building buttons out of them does not mean
re-parsing a string the framework had already parsed.

`recommendation` comes from one of two places, and it is `null` when neither carried one —
never a manufactured one. An `agent` gate's evidence note (`recommend:`) wins; otherwise the
question block's own optional `Recommended:` line does, which the asking stage writes:

```
- A) count them
- B) drop them

Recommended: B — matches how players talk about it [src: 01-what/handoff.md:22]

[Answer]:
```

That line exists because only an `agent` gate ever writes a note, so questions parked at an
`auto` gate used to arrive with no guidance at all — while the stage that raised them was the
one thing in the run that knew the trade-off. A `Recommended:` line the parser cannot read is
ignored, never refused: it is guidance, so a typo costs the guidance and not the gate.

### What you will see when an `auto` gate is waiting

Two things changed in the order and content of what reaches you, and both are about an `auto`
gate held only by open questions:

- **The questions arrive first, and the gate may not arrive at all.** When the ONLY thing
  holding an auto gate is its open questions, the gate is downstream of them rather than a
  second ask — so `question.raised` is delivered first and the `gate.requested` notification
  is held back. You get "here is what to decide", not "sign this" followed by "and here is
  why". The `gate.requested` EVENT is still appended to the run's log either way; only the
  notification waits.
- **The gate closes itself once you answer.** Under `--wait-gates`, each poll re-runs the
  seven auto conditions, and the moment every one holds the loop signs the gate through the
  same `tldrx approve` door and carries on to the next stage. So the sequence you actually
  see is: the questions, your answers from your phone, and then `stage.done` for the NEXT
  stage. No approve tap at all.
- **What releases the held-back gate is its conditions, not its status.** With `--wait-answers`
  on as well, your answers land while the loop is polling for them — and what the loop asks
  next is not "is the gate still pending" (it is, for one more poll) but "does anything still
  hold it, and is there a `--wait-gates` that will sign it". If the gate is about to close
  itself, nothing is sent and the run prints `not asking for a signature on <stage> — every
  auto-gate condition holds and --wait-gates signs it on the next poll`. If something DOES
  still hold it, the notification goes out worded from that same re-measurement, so its
  summary and its `holding` field describe one instant.

If something OTHER than the questions is holding the gate — an unverified citation, a stage
over its ceiling — both notifications go out, questions first, and the gate's summary names
the condition: *"…is waiting at an auto gate that did not close by itself — a person signs
it. It is held by: claim-sources=1 unverified citation(s) — …"*. Before this, that sentence
said only "did not close by itself" and named nothing.

**A Build gate names the story outcomes.** Whoever signs it — `human`, `agent` or `auto` — the
Build gate's notification says what the stage actually delivered before it says what it cost:

> *"260909-scoring finished 04-build/build for $1.78 and is waiting at a human gate — a person
> signs it. It has 0 of 3 stories delivered, S1 blocked (npm run test exited 127…), S2 not
> started.
> Nothing runs after it until the gate is approved or rejected."*

The counts and the first blocked story's own reason ride on the `gate.requested` payload as
`stories`, `blocked_story` and `blocked_reason`, so a script can route on them. **What is
HOLDING the gate rides there too, as a field**: `holding` is `questions`, `stories` or `none` —
the same branch the `command` above was chosen by, said once as data so an adapter never has to
sniff it off the prefix of a CLI string. And where the gate can name what has to change in its
own words, it also carries `continue_command` — `tldrx reject --run <id> --and-continue --note
"…"`, the one-tap *"redo it this way and carry on"* — with `continue_note`, the note derived
from the blocked story and the handoff's reason for it. That pair is ABSENT at a gate held by
open questions (approving or refusing is the one thing that must not happen before they are
answered), at a gate held by nothing mechanical (the reason to refuse a judgement is in your
head, not on disk), and at a gate whose blocked story recorded no reason. A rejection's note
becomes the next turn's prompt, so a canned *"rejected from Slack"* would satisfy the flag and
hand the re-run an empty instruction: no button is better than a button that says nothing. The reason is
the handoff's own sentence, never a paraphrase. Two real runs were approved from a phone over
a summary that said `$1.78` and one green check while every story was blocked — the counting
existed and ran for `auto` gates alone.

**And the run's own end says it too.** A run whose Build delivered nothing does not reach you
as a plain `done`: `run.finished` reads *"…the loop finished with exit 0 (ok), $1.78 spent by
this loop. The run: nothing delivered: 0 of 3 stories; S1 — npm run test exited 127."* The
same sentence is on `run.yml` as `outcome:`, in `tldrx run status`, on the dashboard and in the
`tldrx ship` PR body — and `tldrx ship` refuses such a run outright rather than opening a PR
whose "What shipped" section is empty.

**And a run can end in the PR itself.** Open it with `--ship merge` (or `pr`, or `push`) and
the moment `run auto` sees the run read `done` it runs `tldrx ship` for you: the epic branch is
pushed, the PR opens with the body above, and under `merge` GitHub's auto-merge is armed so the
repo's own checks decide — a PR that reports no check at all is left open, and `run.finished`
then reads `merge: absent — no checks to wait on` beside the `pr_url`. Absent the flag, the
loop ends where it always did. The gates are unchanged by it: a run that goes from `run new` to
a merged PR with nobody in the loop is `--gates none --ship merge`, said in full, and
`run.yml` carries both decisions.

### `status` — the heartbeat

```json
{
  "version": 1,
  "kind": "status",
  "at": "2026-09-07T18:30:04.002Z",
  "run": "260907-checkout",
  "root": "/Users/alan/code/checkout",
  "stage": "02-how/design",
  "summary": "260907-checkout is still running at 02-how/design. Nothing is waiting on you — this is the periodic heartbeat `--notify-every` asked for.",
  "command": "tldrx run status 260907-checkout",
  "detail": { "status_text": "…what `tldrx run status` prints, verbatim…", "waiting_on": [] }
}
```

When `waiting_on` is **not** empty the heartbeat changes what it says: it names the open
questions and its `command` becomes the literal `tldrx answer` line. A heartbeat that went
on saying "nothing is waiting on you" while the run sat on somebody's answer would be worse
than silence, because a heartbeat is believed. Parked-ness is decided by the same predicate
`--wait-answers` polls and `next` parks on, never a second opinion.

A run parked on a **gate** had exactly the same hole, and it is closed the same way. While a
signature is pending the payload grows two keys:

```json
"detail": {
  "status_text": "…what `tldrx run status` prints, verbatim…",
  "waiting_on": [],
  "waiting_on_gate": "01-what/what",
  "gate_policy": "human"
}
```

…the summary says the run is waiting for a person to sign that stage, and `command` becomes the
one line that CLEARS it — the same mapping `gate.requested` uses, over the same reading of the
run: `tldrx answer <id>` while the gate also has open questions, `tldrx run status <id>` while a
Build gate still has unfinished stories, `tldrx approve --run <id>` when the signature really is
the only thing missing. A gate held by
five unanswered questions used to hand over `approve` and repeat it every interval, and two
Build gates were approved by mistake in one evening over unbuilt stories. `waiting_on_gate` is a **sibling** of `waiting_on`, not a member
of it: an adapter maps every id in `waiting_on` to `tldrx answer <id>`, and a stage id there
would make it build a command nobody can type. Both keys are **absent** when no gate is
pending, so an adapter written before this existed sees the payload it always saw.

### The nine kinds

The enum is closed — a kind that arrives from nowhere is a branch nobody wrote — so a
`switch` on `kind` with a `default` is a complete adapter.

| kind | fires when | `command` carries | `detail` |
|---|---|---|---|
| `question.raised` | the loop parked on an open question | the first question's `tldrx answer` line | `questions[]` — `id`, `title`, `why_asked`, `options[]` as `{letter, text}`, `recommendation` (`option`, `why`, `src`) or `null`, `answer_command` |
| `question.timeout` | `--wait-answers` lapsed and the loop is about to exit `4` | the same answer line | the same `questions[]`, plus `waited_ms` |
| `question.auto_answered` | the loop took a question's own `Recommended:` option under `questions_policy: recommended` — it asks for nothing | the `tldrx answer … --supersede` line that reverses it | `question` (`id`, `title`, `file`), `pick` (`letter`, `text`), `alternatives[]`, `why`, `fact`, `decided_by: agent-default`, `supersede_command` |
| `gate.requested` | a stage finished and a person must sign it — **deferred, and possibly never sent, when an `auto` gate is held only by open questions** | the line that clears the gate: `tldrx answer <id>` with questions open, `tldrx run status <id>` over unfinished stories, `tldrx approve --run <id>` when nothing mechanical is outstanding | `cost_usd`, `approve_command`, `reject_command`, `gate_policy`, `holding` (`questions` \| `stories` \| `none`), and one of `held_by` (an `auto` gate's failing conditions) / `signer_held` (an `agent` signer's reasons) — absent when nothing looked. Plus `continue_command` + `continue_note`, together or not at all, only where the gate can name what has to change |
| `gate.timeout` | `--wait-gates` lapsed and the loop is about to exit `4` | the same approve line | `approve_command`, `reject_command`, `gate_policy`, `waited_ms`, and `cost_usd` only when this loop is the one that saw the gate raised |
| `stage.done` | a stage finished and the loop moved on | `null` — the loop is already running the next stage | `cost_usd` |
| `run.finished` | the loop ended with exit `0` | `null` | `exit_code`, `exit_family`, `spent_usd` |
| `run.failed` | the loop ended with any non-zero exit, refusals included | `tldrx run status <id>` | `exit_code`, `exit_family`, `spent_usd` |
| `budget.warned` | a ceiling is close | `tldrx budget show --run <id>` | `spent_usd`, `ceiling_usd` |
| `status` | every `--notify-every <duration>` while the loop runs | `tldrx run status <id>`, or the answer line when parked on a question, or — at a gate — the same line that clears it | `status_text` — what `tldrx run status` prints, verbatim — `waiting_on`, the blocking open question ids (`[]` when none), and `waiting_on_gate` + `gate_policy` only while a gate is pending |

**A truncated input rides in the summary, and adds no kind.** When a stage's `inputs_max_bytes`
could not fit a declared input whole, the `stage.done`, `run.failed` and `status` summaries end
with one extra sentence — *"1 input truncated: facts.yml 169 KB → 87 KB (cap 96 KB)."* — so the
`switch` you already wrote keeps working, and you learn that a sub-agent read a prefix rather
than the file while the run is still going rather than from `.agent/<stage>/prompt.md` after it
failed.

`exit_family` is the exit code in words, so a notification on a phone says *"refused — a
budget ceiling or a gate said no"* rather than *"exit 2"*. The questions, their options and
their recommendation are the **same card** `run auto --gate-agent` prints, so a
notification and a terminal can never disagree about what was asked.

## An adapter, in about thirty lines

The framework ships no integration with any messaging service, and it is not going to. Who
reaches you is different for every workspace, and a built-in integration would be this
framework deciding whose product everybody's run depends on — one operator's setup becoming
a dependency of everyone else's. The console is the default because it is the one surface
every run has; anything past that is yours, and tldrx defers to it without knowing what it
is.

So the adapter is the piece you own. Node, no dependencies, no framework knowledge beyond
the payload:

```js
#!/usr/bin/env node
// bin/notify-owner — reads one notify payload on stdin.

// Replace this with whatever reaches you: an HTTP POST, an email, a ticket, a phone.
async function sendToMyChannel(title, body, action) {
  console.log([title, body, action].filter(Boolean).join("\n"));
}

let raw = "";
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", async () => {
  const p = JSON.parse(raw);
  const action = p.command ? `Run this to unblock it:\n${p.command}` : null;

  switch (p.kind) {
    case "question.raised":
    case "question.timeout":
      // Every question, with its options and its own answer command.
      for (const q of p.detail.questions) {
        const options = q.options.map((o) => `${o.letter}) ${o.text}`).join("\n");
        await sendToMyChannel(`${p.run} · ${q.id}: ${q.title}`, `${options}\n\n${q.why_asked}`, q.answer_command);
      }
      break;
    case "gate.requested":
    case "gate.timeout":
    case "budget.warned":
    case "run.failed":
      await sendToMyChannel(`${p.run} · ${p.kind}`, p.summary, action);
      break;
    default: // stage.done, run.finished, status — reports, nothing to type
      await sendToMyChannel(`${p.run} · ${p.kind}`, p.summary, action);
  }
});
```

Then `chmod +x bin/notify-owner` and declare it. The loop closes when a person reads that
message and runs the command it carried — `tldrx answer Q1 "B — rankings are global" --run
260907-checkout`, from a laptop, a phone over SSH, or a button in your own script that
shells out on their behalf. It is an ordinary `tldrx answer`; under the default
`questions_policy` the loop never answers its own question.

The exception is opt-in, per stage, and recorded. Measured on two headless runs (2026-09-12):
9 of the 10 questions the owner was stopped for carried a `Recommended:` line the asking agent
had written. `run new --questions none` (every stage `recommended`), or
`--questions plan,build` (those two stay human), or later `tldrx run questions set
what:recommended --note "…"`, lets the loop take that recommendation itself the moment the
stage parks: it goes through the same `tldrx answer` path, the fact carries
`decided_by: agent-default` with `alternatives` (the options not taken) and `recommended_why`,
and you get one `question.auto_answered` per answer — no `question.raised` for it — whose
`command` is the `--supersede` line that reverses it. A question with no `Recommended:` line,
or tagged `irreversible: true` / `money: true` in its metadata, stops the loop for you exactly
as before.

## Running it

```bash
tldrx run auto 260907-checkout --notify-every 10m --wait-answers 4h --wait-gates 4h --retry-failed 2 --until-done
```

All three flags take a **duration**: `30s`, `10m`, `2h`, or a bare number of seconds. A value
that is not a duration is refused with exit `1`.

- **`--notify-every <duration>`** adds the periodic `status` payload. Off by default, and it
  does nothing at all unless a `notify:` command is declared. It exists because the period
  when you most want to know a run is alive is the twenty minutes it is inside one stage.
- **`--wait-answers <duration>`** changes where the loop stops on a QUESTION. Instead of
  exiting `4` the moment a stage parks on one, it polls the run's question files for that
  long and **resumes by itself** if somebody answers. Nothing is spent while it waits. When
  the wait lapses it sends one `question.timeout` and then **exits `4`** with the same lines
  it always did — the run is intact, nothing was lost, and `tldrx run auto` picks it up
  again once the question is answered.
- **`--wait-gates <duration>`** does the same for a GATE, the other half of exit `4`. It is
  a sibling flag rather than a wider `--wait-answers` because the two parks are closed by
  different verbs: `tldrx answer` for one, `tldrx approve` / `tldrx reject` for the other,
  and calling a signature an "answer" would be the flag name lying about what you did.
  Approve inside the window and the loop carries on to the next stage; reject and it stops,
  printing your note; let it lapse and it sends one `gate.timeout` and exits `4`. Nothing is
  spent while it polls.

  A rejection is two different acts under one verb, and the rejection says which one it is
  rather than the loop guessing. A bare `tldrx reject` means *stop, I will look* and ends the
  loop, as it always has: resuming would re-spend the stage on a decision you have not been
  shown the result of. `tldrx reject --and-continue` means *redo it this way and carry on* —
  the stage goes back to `ready` with your note exactly the same way, and the loop re-runs it
  instead of exiting, which is what relaunching by hand used to do. Nothing infers this from
  the words of your note.

  It waits FOR a signature and produces one only where the run already said it could: an
  `auto` gate is re-evaluated on every poll and signed the moment its seven conditions hold
  (below). For `human` and `agent` it produces none — and by the time it is waiting on an
  agent gate, the engine's own signer has already had its turn (below), so what is left to
  wait for is a PERSON. Approving an agent-policy gate yourself is a recorded override and is always
  allowed. The heartbeat and the `gate.requested` payload both name the policy, so you know
  which of the two you are doing.

## Who closes a gate under the engine

Three policies, three different things happen when a stage finishes:

- **`human`** — the loop stops and a person signs it: `tldrx approve`, or `tldrx reject
  --note "…"`. With `--wait-gates` the loop waits for that signature instead of exiting on
  the spot.
- **`agent`** — the engine spawns one bounded **gate signer** of its own: the stage's model
  and effort, a quarter of the stage's per-agent ceiling, allowed to read anything and to
  write exactly one file, `.agent/<stage>/evidence.md`. That note then goes through the
  ordinary `tldrx approve --as-agent` path — the same validator a person's note goes
  through. `verdict: sign` with every condition holding and every claim carrying a
  `[src: …]` closes the gate under the note's own `by:`, and the loop walks on. Anything
  else — `refuse`, `sign-with-fixlist`, a note that does not validate, a signer that wrote
  nothing — leaves the gate pending for you, with the reasons on the `gate.requested`
  payload. The turn is recorded as `agent.spawned` / `agent.result` with `role: gate-signer`
  and appears in `tldrx cost`. There is no flag: `gates_policy: agent` is already your
  recorded decision that an agent may close it.
- **`auto`** — no signer and no note: seven measured conditions, and the gate closes only if
  all seven hold. Otherwise it falls to a person with the failing ones named, on the
  `gate.requested` payload's `held_by` as well as on stdout. And it keeps the offer open:
  under `--wait-gates` the seven are re-measured on every poll, so a gate held by an open
  question closes itself as soon as the question is answered. Only `auto` — the run already
  granted that authority — and your own `approve` or `reject` overrides it at any moment.

Both wait flags may be given together — that is the shape of a fully unattended launch:
`--wait-answers 4h --wait-gates 4h`.

## Retrying a stage that failed

`--retry-failed <n>` is the one flag here that is a COUNT, not a duration: how many times in
a row the loop may run a **failed** stage again before it stops. `0` is the default, and it
is what every invocation before this got — one attempt, then exit `5`.

A retry is the same `tldrx next` you would have typed. The stage is on disk as `failed` with
its reason recorded, and the next attempt's prompt is told what the last one did — which is
why this is worth automating at all: measured on a real unattended run, a plan that failed a
check by five characters passed on the very next attempt, with no new instruction from
anybody.

Three things bound it, and all three matter:

- **It bounds exit `5` and nothing else.** A usage error (`1`), a money refusal (`2`) and an
  awaiting-human park (`4`) are attempted once however large `n` is. Each is a decision you
  own — a phase ceiling especially, which means *a human decides about money*, and a retry
  would turn that sentence into a delay.
- **Only consecutive failures count.** A stage that succeeds puts the count back to zero, so
  a long run with one recoverable failure per phase never exhausts a small bound. What is
  being bounded is "this run is stuck", not "this run has ever failed".
- **A retry spends.** It is a fresh metered stage under the same phase ceiling and the same
  `--max-usd`. When the bound is spent the loop stops on the failure's own exit `5`, and the
  last line says the count — `3 consecutive stage failures at 03-plan/plan …` — so the
  `run.failed` payload on your phone says the loop tried, rather than a bare `5`.

The maximum is `3`; anything higher is refused by name with exit `1`.

Exit `4` is not a failure. It is "awaiting a person", and with the hook declared the person
has already been told. Every other way the loop can end is what the next flag is for.

## Relaunching the loop itself

`--until-done [<n>]` is the bound OUTSIDE the loop, where `--retry-failed` is the one inside
it: how many times the same process may relaunch the loop after an exit it can do nothing
else with. Bare means `5`, the cap; `0` is the default and is one launch, exactly what every
invocation before it got.

The measurement behind it: on one 28-hour unattended run, five exits the loop could do
nothing with — a thrown error that reached the shell as a bare `1` with nothing on the
ledger, a stage failure past the retry bound, refusals whose remedy was the same command
typed again — and each one was a person reading it and typing `tldrx run auto` again. It was
18 hours before a story ran.

So after an exit `5` past `--retry-failed`, an exit `1`, or an exit `2` with no money behind
it, the loop is run again from the same process. Every relaunch is a `run.relaunched` event
carrying the exit it recovered from, the attempt and the bound, and `run.finished` /
`run.failed` reach your hook once, from the last attempt. Three things it never relaunches
over:

- **A person's exit `4`.** An open question or a pending gate is yours; `--wait-answers` and
  `--wait-gates` are the flags that wait for you.
- **Money.** A `budget.blocked` names `remaining_usd < estimate_usd`, and nothing in-process
  moves that ceiling — the stop line says the two figures, and `tldrx budget raise` is yours.
  The loop's own `--max-usd` spans every relaunch rather than resetting with each one.
- **The same last line twice.** A refusal that repeats verbatim is not one a relaunch moves;
  one relaunch proves it, and the loop stops rather than hammering it.

Put the run id before the flag, or write `--until-done=3`: a bare `--until-done` followed
by a run id reads the id as its number and refuses it, by name.

The two things you gain over host mode are worth naming, because they are what the
notification buys back:

- **Parallelism.** `--parallel <n>` sets how many stories of one build wave run at once.
  `waves.yml` already guarantees a dependency is in an earlier wave, so a wave's stories are
  independent by construction. The shipped build stage declares `parallel: 2`, so two at a
  time is what a workspace overriding nothing gets.
- **The meter.** Every spawned turn is measured per stage and per attempt.
  `tldrx cost` prints what the work actually cost, `tldrx cost --stories` puts each story
  beside the ceiling its spawn was given, and a ceiling that is getting close arrives as a
  `budget.warned` notification with both numbers in it.

## A first-run checklist

1. **Declare `install:`** in `.tldrx/workspace.yml`, for every repo whose test command needs
   installed dependencies. A Build story runs in a fresh `git worktree`: it has your tracked
   files and nothing else — no `node_modules`, no virtualenv, no restored packages, and none
   of your checkout's. tldrx runs the declared installer there before the developer and
   records it as its own check with an exit code and a duration. Without it, the story's DoD
   exits `127` and blocks, having already paid for a turn; the message names the absent
   binary and this slot, and the framework guesses no installer for you.

   **And it is checked once, at Build entry, before a developer is paid.** tldrx opens one
   throwaway worktree of the base sha, runs your `install:` in it, and then checks that each
   declared Definition-of-Done command's binary actually resolves in that tree — never the
   suite, which the entry pre-flight already runs in your checkout. If it cannot, Build refuses
   with exit 2 naming the exact path or binary, before anything is dispatched or charged. The
   commonest cause is a script the repo never committed: an `install: ./install.sh` whose file
   is absent from `git ls-files` is refused on sight, with the `git add` that fixes it, because
   a worktree carries tracked files only. A Definition-of-Done command that names something the
   install CREATES — `node_modules/.bin/vitest` and friends — is fine and is not refused: the
   check runs after your install, in that tree.

   ```yaml
   repos:
     - name: app
       commands:
         install: "npm ci"      # pnpm install --frozen-lockfile, uv sync, dotnet restore, …
         test: "npm run test"
   ```
2. **Declare `test_fast`** in `.tldrx/workspace.yml` — the fast subset the Build developer
   iterates on. It is not a Definition of Done command; the DoD re-runs `test:`.
3. **Write the adapter and declare it** under `notify:`. Start with every kind — narrow
   `events:` later, once you know which ones you actually want waking you.
4. **Dry-run the adapter by hand**, before any run depends on it:

   ```bash
   echo '{"version":1,"kind":"status","at":"2026-01-01T00:00:00Z","run":"demo","root":"'"$PWD"'","stage":null,"summary":"hello","command":null,"detail":{"status_text":"hello","waiting_on":[]}}' | bin/notify-owner
   ```

   If that does not reach you, nothing will.
5. **Launch with a short interval first** — `--notify-every 60s` for one stage — so you find
   out the hook works while you are still at the keyboard. Then raise it.
6. **Watch `tldrx run status`** for the run's own view, and `tldrx replay <run>` for the
   event log as a narrative, `notify.sent` / `notify.failed` included.

## Troubleshooting

**A story blocked on `exit 127`, "command not found".** The tests never ran: the story's
worktree did not have the binary. Declare `install:` (item 1 above) and tldrx installs the
dependencies there before the developer. The check that failed carries `tree: "worktree"`, so
it can be told apart from the Build-entry pre-flight, which runs the same command in your own
checkout — where the dependencies already are, which is why it can be green minutes earlier. Since
the Build-entry worktree probe this should now be rare: the same absence is normally refused
once, at entry, before any turn is paid for.

**The developer says "This command requires approval to run".** Fixed in gh #209: every
declared command is now granted both exactly and with trailing arguments, so a developer can
run `npm run test -- one/file.test.ts` while it works instead of only the bare command.

**The notifier is never called.** Three usual causes, in the order they cost the least to
check. The `events:` list does not name the kind you were expecting — remove the key
entirely to subscribe to everything. The command is not executable, or is not on the path
the run resolves it from — `bin/notify-owner` is relative to the workspace root, and it
needs its executable bit. Or the command line contains a shell metacharacter and was
refused rather than shelled: move the pipeline into a script and declare the script.

**A malformed `notify:` block reads as no block at all.** The reader will not produce a
hook the validator would reject, so a broken block notifies nothing rather than spawning
something unchecked. `tldrx doctor` is where a bad block is reported.

**`notify.failed` in `events.jsonl`.** The event carries the reason in words — needs a
shell, could not be started, no such executable, timed out after N ms and was killed, or
`exit <n>` with a tail of the child's output. Read it with `tldrx replay <run>`. Whatever
it says, the run's own outcome is unchanged.

**`--wait-answers` lapsed.** You get one `question.timeout` carrying `waited_ms` and the
same `questions[]`, and then exit `4`. Answer the question and start the loop again;
nothing was lost and nothing was spent while it waited.

**`--wait-gates` lapsed.** You get one `gate.timeout` carrying `waited_ms`, the approve and
reject lines and the gate's policy, and then exit `4`. Sign or reject the gate and start the
loop again. If the gate is on `gates_policy: agent` and you expected the run to carry on by
itself: it will not — the loop signs nothing, and an `agent` gate says who MAY sign, not
that anything has.

**A dirty checkout no longer stops the run.** The Build entry classifies every uncommitted
path instead of counting it. Anything under `tldrx-work/`, `.tldrx/` or `.agent/`
is the framework's own state and is ignored; a dirty path a pending story declares in its
`touches:`, or a submodule, still refuses with exit `2`; everything else is **set aside** in a
pathspec-limited `git stash push` before the epic branch is cut, and popped back when the stage
ends. Both moments are on the log (`worktree.foreign_work_aside`,
`worktree.foreign_work_restored`) and nothing is ever deleted or force-popped. If git refuses
the pop — because the tree changed that path meanwhile — the stage's LAST line, the handoff's
`## Unknowns` and the `stage.done` / `run.finished` notification all say
`foreign work NOT restored`, with the stash and the literal command to take it back. The run's
exit code does not move for it.

**A repo in the middle of a merge or rebase refuses (exit `2`).** That state has no clean undo,
so nothing is stashed into it. Finish or abort the operation and start the loop again.

**The run is refused with exit `1`.** `run auto` will not run on a run marked
`attended_by: host` — a lock and an engine are alternatives, never layers. Hand the run
back to the framework with `tldrx run attend --none <run>`, or drive it from a session
instead. (`tldrx run attend host <run>` is the other direction.)

**A budget refusal (exit `2`).** `--max-usd` is checked *between* stages, so the loop can
overshoot by at most one stage's share. `tldrx budget show` says what is left; raising a
ceiling is a person's decision, and there is no flag that makes it not one.

---

The conceptual half — why `attend` and `auto` are opposites, and the mandate for driving a
run from a session — is in [Attended or unattended](/guides/driving). The full chapter,
including the four ways an agent gate falls through to a person, is
[10 — Unattended mode](https://github.com/ederwii/tldr-experts/blob/main/docs/guide/10-unattended-mode.md).
