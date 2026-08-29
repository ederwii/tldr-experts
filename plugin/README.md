# tldrx — Claude Code plugin packaging

Load it for development straight from this directory:

```bash
claude --plugin-dir ./plugin
```

Then type `/tldrx:tldrx`. (Plugin skills are always namespaced `/<plugin>:<skill>`.)

## What is wired

| Path | What it is |
|---|---|
| `.claude-plugin/plugin.json` | Manifest: `name`, `description`, `version`, `author`. |
| `skills/tldrx/SKILL.md` | The facilitator. `disable-model-invocation: true` — only you can invoke it, and its body costs nothing until you do. |
| `hooks/hooks.json` | Six hook handlers on five events. **All inert**: each reads stdin, logs to stderr, exits 0 (allow). |
| `agents/` | Deliberately empty — experts are generated per project. |

Shapes were copied from the official docs, with the source URL recorded next to
each one:

- https://code.claude.com/docs/en/plugins.md
- https://code.claude.com/docs/en/hooks.md
- https://code.claude.com/docs/en/skills.md
- https://code.claude.com/docs/en/statusline.md

## The status line is not a hook

`statusLine` is a **settings key**, not a hook event, and a plugin's own
`settings.json` supports only `agent` and `subagentStatusLine` — so the plugin
cannot install it for you. Add this to your `~/.claude/settings.json` or the
project's `.claude/settings.json` yourself:

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
