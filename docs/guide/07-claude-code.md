# 7 — Claude Code

Three ways in, and they do not exclude each other. Pick by how long you want it to last.

## 1 — a one-off session, from a checkout

No install, nothing written:

```bash
claude --plugin-dir ./plugin      # then type /tldrx:tldrx
```

The plugin loads the facilitator skill and all six hooks for that session only. Hook commands
inside it are resolved through `${CLAUDE_PLUGIN_ROOT}`, so it works with no global `tldrx` on
`PATH` — which is exactly why the plugin keeps that form and does **not** use
`tldrx hook …`. `claude plugin validate ./plugin` exits `0`, with two intentional warnings
explained in `plugin/README.md`.

## 2 — a project or a machine, persistently

```bash
tldrx install --claude               # this project: ./.claude/  (needs a git repo)
tldrx install --claude --user        # this machine: ~/.claude/
tldrx install --claude --dry-run     # show the plan, write nothing
tldrx install --claude --uninstall   # take exactly it back out
```

It writes one skill file — `.claude/skills/tldrx/SKILL.md`, a copy of
`plugin/skills/tldrx/SKILL.md` with `disable-model-invocation: true` intact, stamped
`<!-- tldrx-managed -->` — and **merges** two keys into `.claude/settings.json`:

```jsonc
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Write|Edit", "hooks": [{ "type": "command", "command": "tldrx hook claim-sources", "timeout": 15 }] },
      { "matcher": "Write|Edit", "hooks": [{ "type": "command", "command": "tldrx hook no-reask",      "timeout": 15 }] },
      { "matcher": "Write|Edit", "hooks": [{ "type": "command", "command": "tldrx hook dod-gate",      "timeout": 960 }] },
      { "matcher": "Bash",       "hooks": [{ "type": "command", "command": "tldrx hook budget-gate",   "timeout": 15 }] }
    ],
    "PostToolUse": [
      { "matcher": "Write|Edit", "hooks": [{ "type": "command", "command": "tldrx hook answer-capture", "timeout": 15 }] },
      { "matcher": "Write|Edit", "hooks": [{ "type": "command", "command": "tldrx hook claim-sources",  "timeout": 15 }] }
    ],
    "FileChanged":  [{ "hooks": [{ "type": "command", "command": "tldrx hook answer-capture", "timeout": 15 }] }],
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "tldrx hook session-start",  "timeout": 15 }] }]
  },
  "statusLine": { "type": "command", "command": "tldrx statusline" }
}
```

Six scripts, eight handlers, four events — the same set, the same matchers and the same
timeouts as `plugin/hooks/hooks.json`. The only difference is the command form:
`tldrx hook <name>` rather than an absolute path, because this file gets committed and cloned
onto a machine whose checkout is somewhere else. `tldrx hook` resolves `dist/hooks/<name>.js`
(or `src/hooks/<name>.ts` in a source checkout) and passes stdin, stdout, stderr and the exit
code straight through.

**What it will not do:** touch `permissions`, edit an entry it did not write, overwrite a
`SKILL.md` that has no `<!-- tldrx-managed -->` marker (exit `1`), or replace a `statusLine`
that is somebody else's — it prints how to chain the two instead, and `--force-statusline` is
the override. `settings.json` is copied to `settings.json.bak-tldrx-<ts>` before the first
write. Running it twice changes nothing, and `--uninstall` puts the file back byte-for-byte.

Other flags: `--project` (the default; refuses outside a git repo) `--skill-only`
`--no-hooks` `--no-statusline`.

## 3 — no install at all

Nothing here needs Claude Code. Every hook is a script that reads a JSON payload on stdin and
prints a decision, every command is a CLI, and the whole loop runs from a shell — see
[1 — Quick start](01-quick-start.md#from-a-terminal).

`tldrx interview` is the terminal end of the Interview step, and it records answers through
the identical code path the `answer-capture` hook uses — so a question answered in a shell,
in an editor, or by Claude Code lands as the same footer, the same `facts.yml` row and the
same two events.

## What `/tldrx` does

`/tldrx` is **status, then guide**. Step 1 is always `tldrx status --json`; the skill then
walks the items one at a time, in order, in plain language, asking when the decision is the
human's (init answers, split edits, ADRs, gates, questions) and acting when the step is
mechanical (`seed apply --dry-run`, `next --prepare` … `--commit`, `answer`, `approve`),
re-running `tldrx status` after each. It states the ceiling and asks before anything that
spends, and it never closes a gate itself.

`tldrx status --json` returns `{root, pending, items[], advice[]}`. `items` are the
**blockers**, in the order the sources block each other; `advice` is things worth doing that
block nothing (today, only the untrained-experts line), kept out of `pending` because a
headline that counts advice as work makes a workspace that is merely new look broken.

## Adding your own context to a prompt

Every so often the bundle is missing something only you know: a decision that was deferred, a
seed doc that did not get inlined, an answer the owner gave in chat, or "Docker is up". Write
it into `tldrx-work/<run>/.agent/<stage>/dispatch-notes.md`, beside `prompt.md`, and the next
run of that stage renders it into the prompt under `## Dispatch notes`, between `## Inputs`
and `## Previous attempt`. **Every mode reads it**, not only `--prepare`: a note left for a
headless stage is as much a caveat as one left for a bundle you dispatch yourself. For a
Build story the per-story file is `.agent/<stage>/<story>/dispatch-notes.md`, and when both
exist the stage's file is rendered first.

The two places you might reach for instead are both wrong: `stage.md` belongs to the
framework and is shared by every run of that workflow, and an edit to `prompt.md` is thrown
away by the next `--prepare`.

Three things to know about it:

- **It is context, not configuration.** Nothing in it can change your declared inputs, your
  outputs, the checks, or a budget. The section says so to the sub-agent, in as many words.
- **It is capped at 8 KB** (8,192 B), one budget shared across both files and spent
  stage-first. Over that it is cut, and the cut is named in the prompt, on stdout
  (`cut at the 8,192 B dispatch-notes cap — …`) and in `pending.json`'s
  `dispatch_notes: {bytes, truncated, max_bytes, sources}`. It counts against
  `prompt_max_bytes` like every other section, and shows in the context ledger as
  `dispatch notes`.
- **It is per-cycle scratch.** `.agent/` is gitignored, and the file survives
  `--discard-pending` but nothing else. Anything that should outlive this cycle belongs in
  `.tldrx/memory/facts.yml` (`tldrx facts add`), which reaches *every* prompt with
  attribution behind it.

Leave the file out and the prompt is byte-identical to what it always was.

**One stage per `/tldrx` call.** When a run's remaining gates are mostly `auto` and nobody
needs to watch, `tldrx run auto <id>` is the headless loop — but it spawns its own sessions,
so it belongs in a terminal, not inside the session.

Everything on this page is one session's half of the story. The whole shape — who may sign
what, the four fallthroughs, and one story's cycle end to end — is
[10 — Unattended mode](10-unattended-mode.md).

## Attended mode — a run this session is driving

`--prepare`/`--commit` is a decision per invocation. **`attended_by: host`** is the same
decision made once, about the run:

```
tldrx run new checkout-v2 --scope feature --attended-by host   # from the start
tldrx run attend host                                          # or later, on an open run
tldrx run attend --none                                        # and back again
```

It is worth setting the moment a host session starts doing the turns, because the failure it
prevents is expensive and silent. Measured 2026-08-30: a bare `tldrx next` on a Build stage
ran the whole remaining plan — every wave, every story — as paid spawns when the host wanted
one re-review, and six of six of those spawns then died on `Reached maximum budget` at caps a
Plan agent had written assuming host-billed sub-agents. $9.95, nothing delivered.

On an attended run:

- **`tldrx next` with no `--prepare`/`--commit` exits `4`** and names the exact command the
  stage is waiting for. Nothing is billed, nothing is written. `4` and not `2` because the run
  is not refusing the work — it is waiting on you, the same shape as waiting at a gate.
- **`--dry-run` is refused with it.** Not for money — since issue #17 `--dry-run` spawns
  nothing anywhere — but because it describes a dispatch the framework never makes on an
  attended run. `--prepare` writes the bundle you are going to carry.
- **`tldrx run auto` is refused** at exit `1`, before it writes anything.
- **Nothing can reach a spawn.** Each executor exposes prepare/commit only, and `spawnAgent`
  itself throws on an attended run. Three layers, because "nothing spawns" is a promise about
  money and one `if` is not a promise.

`tldrx run status` prints `attended: host` and the status line carries an `att` marker, so a
session that has forgotten which mode it is in can see it without asking. Everything else is
unchanged — the bundle, `result.json`, `--cost-usd`/`--tokens`, the lock, the cursor, the gates.

### The review is a turn too

A Build story has two sub-agents, and the second one is a reviewer reading the story's diff. On
an attended run that review is yours as well — the framework spawning its own reader beside a
session that is already reading the diff is two reviews for one review, and a bill nobody
budgeted (measured 2026-08-30: the host's deeper review had already finished before the
framework's $0.26 one even started).

So the reviewer rides the same handshake, one directory down:

```
tldrx next --commit                 # DoD, commit, merge — then the review bundle is written
                                    # into .agent/<stage>/<story>/review/ and it STOPS
#   … you dispatch one read-only sub-agent with that prompt.md …
tldrx next --commit --review        # its {verdict, summary, findings} settles the story
```

`--prepare --review` writes that bundle on demand, and a bare `--prepare` writes it by itself
whenever a story is waiting on a review — including the case this exists for: a story stuck at
`review` because the framework's own reviewer died at its cap. That path used to spawn a
replacement reviewer under `--prepare`, which is the one thing `--prepare` must never do.

What the bundle hands you: the reviewer's `prompt.md` (the same one a spawn gets), the diff
command and the merged commit, the DoD results already re-run by the framework — do not re-run
them — and `result_schema`, the exact envelope your sub-agent must return. Write it to
`review/result.json`, optionally with `cost_usd` / `tokens` beside it; without a `cost_usd` the
turn is recorded `cost_usd: null, metered: false`, which is what a host-billed turn is.

**Read the shape out of `result_schema`; do not type it from memory.** It is the single
statement of the envelope, the prompt points at it rather than paraphrasing it, and the one
review that lost a cycle to this had a host that dictated the keys from recollection. The one
thing the schema cannot say, and the prompt does: the verdict's prose ends up in an
`events.jsonl` payload, and a payload over **4096 bytes is refused whole** — not truncated.

Everything downstream is the ordinary path: `approve` finishes the story with its evidence,
`changes` requeues it once and blocks it the second time, and an envelope that cannot be read
is `changes` — never `approve`. A review you never write costs the story no attempt at all.

### When you would sign and still have findings

The verdict for that is `fixlist`, and it exists because the other two throw the findings away.
Measured 2026-08-31 on a real story: the reviewer signed — every acceptance criterion met, zero
scope violations — and named three real defects the criteria never covered. `approve` loses
them; `changes` spends the story's one requeue on a diff nobody faulted.

Write it like any other verdict, with the findings beside it:

```json
{
  "verdict": "fixlist",
  "summary": "signed — every criterion is met, and three defects the criteria never covered",
  "findings": [],
  "fixlist": [
    {"n": 1, "severity": "high", "finding": "Concurrent double-confirm mints two sessions",
     "where": "`src/Auth/ConfirmOtp.cs:74` [src: lab:src/Auth/ConfirmOtp.cs:74]",
     "disposition": "fix-now",
     "detail": "Two requests carrying the same code both mint a session.",
     "do_not": ["add a lockout policy; that is a product decision (see 3)"]},
    {"n": 3, "severity": "medium", "finding": "No OTP attempt limiter",
     "disposition": "defer-with-log", "detail": "A lockout policy is a product call."}
  ]
}
```

What happens next:

- The framework writes **`04-build/fixlist/<story>-<round>.md`** — one
  `## <n> · <finding>␣␣[<severity>]` section per finding (two spaces before the bracket), each
  carrying a `Where:`, a `Disposition: **<value>**` and a `Resolved: no` — and the story parks
  at `review` having spent **no attempt**. `defer-with-log` findings are appended to
  `retro.md`'s `## Build feedback` on the way past.
- The next **`tldrx next --prepare`** carries that file back to the author: the open findings
  land under `## Fix list` in the developer prompt with their `Do NOT` lines verbatim, and
  `pending.json` gains `fixlist: {path, round, findings, open}` plus `resume_session` — the
  prior turn's `session_id`, so you can resume that sub-agent instead of paying to rebuild its
  context. Both keys appear **only** on a fix-list round; an ordinary developer `--prepare` has
  neither. The framework resumes nothing itself; it hands you the id it recorded.
  `--fixlist <path>` names a different file, and refuses one that is not this story's.
- **You disposition it.** A `fix-now` finding keeps the story out of `done`: an `approve` over
  an open one settles `blocked` and names it. Close each in the file as the fix lands
  (`Resolved: yes`) or re-route its `Disposition:` — **keep the value bolded**
  (`Disposition: **defer-with-log**`), because that is how the file is read back: a line
  without the asterisks drops its finding rather than half-reading it. That edit is yours — the
  author works in a story worktree of another repo and its own prompt forbids writing outside
  it.
- **There is exactly one such round.** A second `fixlist` on the same story is refused out loud
  and read as `changes`, which costs the attempt the first one did not — and the second
  reviewer's prompt says the verdict is unavailable rather than offering one that would be
  refused.

Two rules are worth knowing before you use it. `refuted` is the one disposition that
contradicts its own finding, so it **must** carry an `[src: …]` citation proving the finding
wrong — a reviewer's verdict is a claim like any other. And a `fixlist` verdict whose
`fixlist[]` is missing, empty or unreadable is `changes`, not a free round: fail-closed, the
same rule the rest of the envelope has.

## The hooks

| Hook | Event | What it does |
|---|---|---|
| `claim-sources` | PreToolUse `Write\|Edit` (+ a PostToolUse twin) | Denies a handoff bullet with no `[src: …]`, or one citing something that does not resolve, or a Findings/Decisions/Unknowns/Evidence-ledger section holding no list item at all |
| `no-re-ask` | PreToolUse `Write\|Edit` on `questions.md` | Denies a *new* open question whose subject already has a non-retired `facts.yml` row (same area, Jaccard ≥ 0.6 on ≥4-char tokens) and names the fact |
| `answer-capture` | PostToolUse + FileChanged | Writes the answer footer, appends the fact and the `question.answered` event, echoes `tldrx: recorded Q4 → F020`. Never blocks |
| `dod-gate` | PreToolUse `Write\|Edit` on `stories/*.md` setting `status: done` | Re-runs every command in the story's fenced ` ```dod ` block from its repo; each must exit 0 |
| `budget-gate` | PreToolUse `Bash` | Denies a spending command the cursor phase cannot afford; names the exact `budget raise` |
| `session-start` | SessionStart | Up to three lines of "where we are" plus up to three of the `tldrx status` report |

**`claim-sources` resolves every `src` kind**, not just `file` and `cmd`: `F<n>` must be a
live row in `facts.yml`, `Q<n>` a question this run asked, `graph:<node>` a node in the graph
or a token named in `.tldrx/map/`, and `absent:` may only source a negative claim (`## Unknowns`
is exempt — that heading IS the negation). What cannot be checked offline is a third outcome,
**`unverified`**: it passes the stage and stops an auto gate. A token wrapped in backticks or
brackets, or followed by a full stop, still counts; a line that tried to cite and failed is
reported as a **malformed citation**, not as an unsourced bullet.

**`dod-gate` executes strings a model wrote, as you** — so the allowlist is the whole control.
Only a command **byte-equal** to one in `workspace.yml` runs at all, argv-split with no shell;
an empty `commands:` permits nothing, and a command needing a shell is refused rather than
shelled. It is one of the two hooks that fail **closed**.

**Hook failure policy.** Every hook but `dod-gate` fails **open** on an internal error: it
exits `0` and prints one `tldrx hook <name>: internal error, allowing — …` line to stderr
(`src/hooks/lib/decide.ts`). `budget-gate` adds one deliberate closed case on top of that —
an unreadable `run.yml` or `budget.yml` inside a workspace **denies** and names the file,
because "cannot read the budget" is not "the budget is fine". Only PreToolUse can deny, and
it denies by printing `permissionDecision: deny` and exiting `0` — never by an exit code.

## The status line

`statusLine` is a settings key, not a hook, and a plugin's own `settings.json` supports only
`agent` and `subagentStatusLine` — so the plugin cannot install it. `tldrx install --claude`
can, because it writes the real `.claude/settings.json`; loading the plugin instead means
wiring it yourself, and the snippet is in `plugin/README.md`.

With a live run it prints:

```
[tldrx] <run> · <PHASE> [▓▓░░░] <done>/<total> > <stage> — <expert> | <model> ctx:<n>% $<session cost>/$<ceiling>
```

Three markers can appear after the stage count, and only when they are true: **`att`** (the
run is `attended_by: host` — the framework will not spawn on it), **`machine:N`** (N gates a
machine closed — the facilitator's and an agent's alike, never one a person signed) and
**`stale:N`** (stages whose approval was revoked).
With none of them the line is exactly what it always was.

The run half comes from `RunStore`, the model/context/cost half from the documented
`statusLine` payload. It falls back to `[tldrx] <model> ctx:<n>% $<cost>` when there is no
run, and to `[tldrx] no session data` when the payload fields are absent. It never throws and
always exits 0.
