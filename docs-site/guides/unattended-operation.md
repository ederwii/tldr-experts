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

…the summary says the run is waiting for a person to sign that stage, and `command` becomes
`tldrx approve --run <id>`. `waiting_on_gate` is a **sibling** of `waiting_on`, not a member
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
| `gate.requested` | a stage finished and a person must sign it | `tldrx approve --run <id>` | `cost_usd`, `approve_command`, `reject_command`, `gate_policy` |
| `gate.timeout` | `--wait-gates` lapsed and the loop is about to exit `4` | the same approve line | `approve_command`, `reject_command`, `gate_policy`, `waited_ms`, and `cost_usd` only when this loop is the one that saw the gate raised |
| `stage.done` | a stage finished and the loop moved on | `null` — the loop is already running the next stage | `cost_usd` |
| `run.finished` | the loop ended with exit `0` | `null` | `exit_code`, `exit_family`, `spent_usd` |
| `run.failed` | the loop ended with any non-zero exit, refusals included | `tldrx run status <id>` | `exit_code`, `exit_family`, `spent_usd` |
| `budget.warned` | a ceiling is close | `tldrx budget show --run <id>` | `spent_usd`, `ceiling_usd` |
| `status` | every `--notify-every <duration>` while the loop runs | `tldrx run status <id>`, or the answer line when parked on a question, or the approve line when parked on a gate | `status_text` — what `tldrx run status` prints, verbatim — `waiting_on`, the blocking open question ids (`[]` when none), and `waiting_on_gate` + `gate_policy` only while a gate is pending |

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
shells out on their behalf. It is an ordinary `tldrx answer`; the loop never answers its own
question.

## Running it

```bash
tldrx run auto 260907-checkout --notify-every 10m --wait-answers 4h --wait-gates 4h
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

  It waits FOR a signature and never produces one. There is no engine-side signing in this
  loop, so a stage on `gates_policy: agent` stops it exactly as a `human` one does, and
  `--wait-gates` then waits for an agent to sign that gate over an evidence note — or for
  you to approve it yourself, which is a recorded override and is always allowed. The
  heartbeat and the `gate.requested` payload both name the policy, so you know which of the
  two you are doing.

Both wait flags may be given together — that is the shape of a fully unattended launch:
`--wait-answers 4h --wait-gates 4h`.

Exit `4` is not a failure. It is "awaiting a person", and with the hook declared the person
has already been told; what is left is your outer relaunch loop, which is yours to write.

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

1. **Declare `test_fast`** in `.tldrx/workspace.yml` — the fast subset the Build developer
   iterates on. It is not a Definition of Done command; the DoD re-runs `test:`.
2. **Write the adapter and declare it** under `notify:`. Start with every kind — narrow
   `events:` later, once you know which ones you actually want waking you.
3. **Dry-run the adapter by hand**, before any run depends on it:

   ```bash
   echo '{"version":1,"kind":"status","at":"2026-01-01T00:00:00Z","run":"demo","root":"'"$PWD"'","stage":null,"summary":"hello","command":null,"detail":{"status_text":"hello","waiting_on":[]}}' | bin/notify-owner
   ```

   If that does not reach you, nothing will.
4. **Launch with a short interval first** — `--notify-every 60s` for one stage — so you find
   out the hook works while you are still at the keyboard. Then raise it.
5. **Watch `tldrx run status`** for the run's own view, and `tldrx replay <run>` for the
   event log as a narrative, `notify.sent` / `notify.failed` included.

## Troubleshooting

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
