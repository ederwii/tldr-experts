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

**One stage per `/tldrx` call.** When a run's remaining gates are mostly `auto` and nobody
needs to watch, `tldrx run auto <id>` is the headless loop — but it spawns its own sessions,
so it belongs in a terminal, not inside the session.

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

The run half comes from `RunStore`, the model/context/cost half from the documented
`statusLine` payload. It falls back to `[tldrx] <model> ctx:<n>% $<cost>` when there is no
run, and to `[tldrx] no session data` when the payload fields are absent. It never throws and
always exits 0.
