---
title: FAQ for the impatient
---

<script setup>
// The version and maturity tag come from package.json and the README release table at
// build time (docs-site/version.ts), so this page cannot lag a release.
import { useData } from 'vitepress'
const { theme } = useData()
</script>

# FAQ for the impatient

## What is the shortest way to understand this?

`tldrx learn`. Eight chapters, fifteen minutes, a throwaway sandbox, no API key, $0.00,
and every command in it is the real binary.

## Can I drive it from Claude Code?

Yes, and it is the nicer way.

```bash
tldrx install --claude    # writes .claude/skills/tldrx/, merges the hooks and status line
```

Then type **`/tldrx`** in that project. It runs `tldrx status`, finds what is already
waiting on you — unanswered setup questions, a run sitting at a gate, an expert no stage
can lean on yet — and walks you through one item at a time, asking every decision that is
yours and running only the mechanical steps.

You do not need Claude Code. Every command is a CLI and every hook is a script that reads
JSON on stdin. `tldrx install --claude --uninstall` removes exactly what it wrote.

## Will it commit? Will it push?

Build commits — on a branch of its own, per story, merged into an epic branch. **It never
pushes.** The epic branch waits for you, and the final merge is yours. `tldrx ship` opens
a PR from it when you want one.

## What does a run actually cost?

A `feature` run defaults to a $25 ceiling; a `spike` to $6. On one real workspace a What
stage measured $1.20–1.40. Nothing is charged until you run a stage, and
`tldrx next --dry-run` shows you the prompt and the ceiling without spawning anything. See
[Budgets and estimates](/guides/budgets).

## Is my code sent anywhere?

`tldrx init`, `run new`, `answer`, `approve`, `status`, `cost` and `learn` are offline —
filesystem and git only. `tldrx next` sends an assembled prompt to the model, like any
other AI coding tool. What is in that prompt is not a mystery: `tldrx next --prepare`
writes it to a file and prints its byte-by-byte breakdown before anything is spawned.

## How do I keep it up to date?

`tldrx update` — it is `npm i -g tldr-experts@latest` run for you, and it prints the
CHANGELOG between the version you had and the one you now have, read back from what npm
installed rather than assumed. Any command also tells you in one line when a newer version
exists: the registry is never called on the hot path, the answer is cached for a day, and
it never appears in `--json` output or inside a hook. `TLDRX_UPDATE_CHECK=off` silences it
for one shell, `update_check: off` in `~/.tldrx/config.yml` for the machine.

## How do I stop it?

Ctrl-C. It kills the sub-agent's whole process tree, records a partial result with
`cost_usd: null` and `stopped_by: signal`, puts the stage back to `ready`, releases the
lock and exits `130`. Run `tldrx next` again and it retries that stage.

If a command died badly and left a lock behind: `tldrx run unlock`.

## It said "3 runs are open — pass one" and refused

That is working. With several runs open and no id, a run-targeting command lists them and
refuses rather than guessing which one you meant — exit `2`, except `cost`, which refuses
at `1`. `run status` is the one that does not refuse: it lists them and exits `0`, so it is
where you go to find the id. Pass the id.

## What if I disagree with what it did?

```bash
tldrx reject --note "…"                    # send this stage back; the note reaches the next attempt
tldrx reject --stage 02-how/how --note "…" # revoke an approval already given
tldrx story reopen S3 --note "…"           # just this one build story
tldrx story reopen S3 --for-fix --note "…" # one named defect in a story already done
tldrx run cancel --note "superseded"       # close the run for good; nothing is deleted
```

## What do the exit codes mean?

| | |
|---|---|
| `0` | ok |
| `1` | usage or schema error, or a check ran and failed |
| `2` | refused — a gate said no, or it will not guess between several runs |
| `3` | not found — no workspace, no run, no card by that name |
| `4` | **awaiting a human** — the stage ran and stopped at its gate. Not a failure. |
| `5` | the sub-agent failed |
| `130` | Ctrl-C — the sub-agent was killed and the stage is back to `ready` |

## Do I have to commit `.tldrx/` and `tldrx-work/`?

Yes — that is the design. [The files are the state](/concepts/files-as-state), so a
teammate who clones the repo gets the run.

## Is it ready?

**{{ theme.tldrxStatus }}, {{ theme.tldrxVersion }}.** Every command is real and tested; `tldrx --help` on your machine is the
authority, not this site. Releases through 0.3.1 were `alpha`; 0.4.0 was the first `beta`, and
the bar for it has been cleared: frozen file formats, two or more real workspaces taken
through Build, and a documented upgrade path.

## Can I contribute?

[`CONTRIBUTING.md`](https://github.com/ederwii/tldr-experts/blob/main/CONTRIBUTING.md) has
the loop a change goes through, the four gates and what CI actually runs, the red-first
test rules, and the seam an outside model provider would plug into.

## Something is refusing and I do not know why

`tldrx status` says what is waiting on you and prints the command for each. Beyond that,
[9 — Troubleshooting](https://github.com/ederwii/tldr-experts/blob/main/docs/guide/09-troubleshooting.md)
lists every refusal the framework can emit and the move that clears it.
