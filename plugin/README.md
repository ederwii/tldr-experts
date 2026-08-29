# tldrx — Claude Code plugin packaging

Load it for development straight from this directory:

```bash
claude --plugin-dir ./plugin
```

Then type `/tldrx:tldrx`. (Plugin skills are always namespaced `/<plugin>:<skill>`.)

## Or install it, and skip the flag

`--plugin-dir` lasts one session and needs this checkout. For a project or a
machine that should just have it:

```bash
tldrx install --claude          # ./.claude/   (this project; needs a git repo)
tldrx install --claude --user   # ~/.claude/   (this machine)
```

That writes the same skill and the same six hooks into a real `.claude/`, plus the
status line this plugin cannot install (see below). It is idempotent, it never
touches `permissions`, and `--uninstall` takes exactly it back out. The README's
[Claude Code integration](../README.md#claude-code-integration) section has the
settings fragment it writes.

**The two wirings differ in one thing only: how a hook is named.** The plugin
spawns `bun ${CLAUDE_PLUGIN_ROOT}/../src/hooks/<name>.ts`, and it keeps doing that
on purpose — a plugin must work for someone who cloned the repo and installed
nothing, so it cannot depend on a global `tldrx`. The installed `settings.json`
uses `tldrx hook <name>` instead, because that file gets committed and cloned onto
a machine whose checkout is somewhere else, where an absolute path is simply wrong.
Same scripts, same matchers, same timeouts, same decisions.

## What is wired

| Path | What it is |
|---|---|
| `.claude-plugin/plugin.json` | Manifest: `name`, `description`, `version`, `author`. |
| `skills/tldrx/SKILL.md` | The facilitator. `disable-model-invocation: true` — only you can invoke it, and its body costs nothing until you do. |
| `hooks/hooks.json` | Eight handlers over six hook scripts on four events. **All live** — see the table below. |
| `agents/` | Deliberately empty — experts are generated per project. |

## The hooks

| Script | Event(s) | Matcher | What it does |
|---|---|---|---|
| `claim-sources.ts` | PreToolUse, PostToolUse | `Write\|Edit` | Computes the **would-be** content (Write: `content`; Edit: `old_string`→`new_string` applied to the file on disk) and, when it is a handoff under `tldrx-work/`, denies unless every `- ` bullet under Findings / Decisions / Unknowns / Evidence ledger ends with a resolvable `[src: …]` token (spec §2.8). On PostToolUse the same check can only report, so it emits `additionalContext`. |
| `no-reask.ts` | PreToolUse | `Write\|Edit` | On `questions.md`: for each question the file does not already carry, denies when a non-retired `facts.yml` row in the same `area` scores Jaccard ≥ 0.6 over ≥4-char tokens, and names the fact. |
| `answer-capture.ts` | PostToolUse, FileChanged | `Write\|Edit` / none | For every block that is `status: open` with a non-empty `[Answer]:`, writes the answer footer, appends a `facts.yml` row (`kind: answer`, `source.q`) plus `question.answered` and `fact.added` events, and echoes `tldrx: recorded Q4 → F020`. Never blocks. |
| `dod-gate.ts` | PreToolUse | `Write\|Edit` | On a `stories/*.md` write that sets `status: done`: re-runs every command in the story's fenced ```` ```dod ```` block from the repo named by `repo:` (resolved through `workspace.yml`), each within `timeout_s` (default 900). Denies unless all exit 0, or if the block is missing. |
| `budget-gate.ts` | PreToolUse | `Bash` | On a command matching `^(claude -p\|tldrx next)`: resolves the run (`--run`, the cwd, or the newest non-terminal `run.yml`), and denies when the cursor phase cannot afford the stage's `budget_usd` and `on_exceed: block`. Appends `budget.blocked`. |
| `session-start.ts` | SessionStart | none | Up to three lines of "where we are" via `additionalContext`. Silent when there is no non-terminal run. |

**Two rules the whole set obeys.** Only PreToolUse can block, and it blocks by
printing `{"hookSpecificOutput": {"hookEventName": "PreToolUse",
"permissionDecision": "deny", "permissionDecisionReason": "…"}}` and exiting `0` —
an exit code never denies here. And every hook except `dod-gate` fails **open**: an
internal error exits `0` and writes one line to stderr
(`tldrx hook <name>: internal error, allowing — …`). `dod-gate` fails **closed**
once it has identified the write as a story being marked done, because an unproven
story must stay not-done.

The `matcher` on the `FileChanged` entry is deliberately omitted: matcher support
for that event is not in the verified docs, so the script filters on the path
itself. The `budget-gate` matcher is `Bash`, not `Task` — the money is spent by a
shell command whose estimate is in `tool_input.command`, and nothing in the
verified docs says a subagent spawn arrives with a budget to check.

Shapes were copied from the official docs, with the source URL recorded next to
each one:

- https://code.claude.com/docs/en/plugins.md
- https://code.claude.com/docs/en/hooks.md
- https://code.claude.com/docs/en/skills.md
- https://code.claude.com/docs/en/statusline.md

## The status line is not a hook

`statusLine` is a **settings key**, not a hook event, and a plugin's own
`settings.json` supports only `agent` and `subagentStatusLine` — so the plugin
cannot install it for you. `tldrx install --claude` can, because it writes the real
settings file; it puts in `{"type": "command", "command": "tldrx statusline"}`, and
leaves any status line that is not tldrx's alone. If you are loading the plugin
instead, add this to your `~/.claude/settings.json` or the project's
`.claude/settings.json` yourself:

```json
{
  "statusLine": {
    "type": "command",
    "command": "bun /absolute/path/to/tldr-experts/src/hooks/statusline.ts",
    "padding": 2
  }
}
```

It renders `[tldrx] <model> ctx:<n>% $<cost>` from the fields Claude Code already
measures, and `[tldrx] no session data` when they are absent. The richer line from
the concept doc (run id, phase, progress bar, budget ceiling) needs `run.yml`,
which v0 does not write yet — so it is not rendered rather than faked.

## Known `claude plugin validate` warnings

`claude plugin validate ./plugin` exits 0 with two warnings. Both are deliberate:

1. **`$doc: Unknown field '$doc'`** — JSON has no comments, and this repo's rule is
   that every Claude Code shape carries its source URL beside it. The validator
   itself confirms the field is *ignored at load time*, so it costs nothing.
2. **`agents/README.md: No frontmatter block found`** — the directory holds
   documentation, not an agent. Adding frontmatter would register a fake agent
   named `README`, which is worse than a warning. Experts are generated per project
   by `tldrx init`; nothing belongs here.
