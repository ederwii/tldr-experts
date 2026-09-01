---
title: CLI overview
---

# CLI overview

The authority is your own machine: `tldrx --help`, and `tldrx <command> --help` for one
command's flags, allowed values, examples and exit codes. This page is a map of the
surface, not a copy of it.

Every command below was checked against `tldrx 0.3.1`. For the exhaustive version — every
flag, every refusal — see
[8 — CLI reference](https://github.com/ederwii/tldr-experts/blob/main/docs/guide/08-cli-reference.md)
in the repo.

## The five you will actually type

```bash
tldrx init                  # detect the workspace, map the code, ask only the gaps
tldrx run new <slug> --scope feature --budget 25
tldrx next                  # run the next stage; it stops at a gate
tldrx answer Q1 "…"         # answer what it asked
tldrx approve --note "…"    # sign the gate; the checks are re-run first
```

## Setting up

| Command | Does |
|---|---|
| `tldrx doctor` | Check the local environment. The authority on what is required. |
| `tldrx init` | Detect repos, build the code map, write `.tldrx/`, list the gaps. Offline. |
| `tldrx interview --init` | Answer the setup questions in the terminal. |
| `tldrx install --claude` | Write the `/tldrx` skill, hooks and status line into `.claude/`. |
| `tldrx learn` | The playable sandbox tutorial. No key, no network, $0.00. |
| `tldrx update` | `npm i -g tldr-experts@latest`, plus the CHANGELOG between the version you had and the one you now have. Any command tells you, in one line, when a newer one exists — off the hot path, cached, silent on failure, never in `--json` or a hook. `TLDRX_UPDATE_CHECK=off` turns it off. |
| `tldrx status` | Everything in this workspace waiting on a human, and the command for each. |

## Driving a run

| Command | Does |
|---|---|
| `tldrx run new <slug>` | Open a piece of work. `--scope`, `--budget`, `--seed`, `--gates`, `--attended-by host`. |
| `tldrx run status [<run>]` | Where it is, what it is waiting on, what it cost. `--json`. |
| `tldrx next [<run>]` | Run the next stage. `--dry-run`, `--prepare`/`--commit`, `--review`, `--effort`, `--max-reads`. |
| `tldrx run auto [<run>]` | Call `next` repeatedly until something needs you. `--max-usd`, `--until`, `--parallel`. |
| `tldrx run attend host \| --none` | Hand the run to a host session, or take it back. |
| `tldrx run estimate` | The one command that guesses. It says `ESTIMATE`. |
| `tldrx run unlock` / `run cancel` | Clear a stale lock; close a run for good. |

## Deciding

| Command | Does |
|---|---|
| `tldrx approve` | Sign the gate. `--note`, `--as-agent`, `--evidence`. |
| `tldrx reject --note "…"` | Send the stage back; `--stage <phase>/<stage>` revokes a signature. |
| `tldrx gate template` | Write the skeleton evidence note an agent gate is signed over. |
| `tldrx run gates set <stage>:<policy> --note "…"` | The only sanctioned way to change gate policy after `run new`. |
| `tldrx questions cards` | The run's OPEN questions as printable decision cards — context, what the docs already decide, the options. Reads only. |
| `tldrx answer <Qid> "…"` | Record an answer as a numbered fact. `--supersede` reverses one. |
| `tldrx interview` | Answer a run's open questions in the terminal. |
| `tldrx story reopen <id> --note "…"` | Give one build story another run of attempts. |

## Money

| Command | Does |
|---|---|
| `tldrx cost [<run>]` | What was actually charged, per attempt. `--all`, `--json`. |
| `tldrx budget show` | What the run may still spend. |
| `tldrx budget raise <phase> <usd>` | Move a ceiling. `--take-from <phase>`, `--note`. |

## Knowledge, output and the rest

| Command | Does |
|---|---|
| `tldrx map --refresh \| --check` | Rebuild the code map, or check it against the code for drift. |
| `tldrx expert list \| create \| train \| recompute` | See [Experts](/guides/experts). |
| `tldrx seed triage` / `seed apply` | Split a big document into several runs. |
| `tldrx watch list \| check [<feature>]` | The watcher cards a run produced: listed, or printed as the post-merge checklist and re-checked against the code now. |
| `tldrx watch arm` | Wait for the run's shipped PR to merge, then print that checklist. A bounded foreground poller over `gh pr view` — not a daemon. |
| `tldrx plan sync-dod \| schema` | Repair story definitions of done after editing `workspace.yml`, or print the story/epic/waves contract the `plan` check enforces. |
| `tldrx dashboard` | Watch the workspace live in a browser, or export one static page. |
| `tldrx replay [<run>]` | The run's event log as a narrative. |
| `tldrx retro` | Close a run and capture what was learned. |
| `tldrx retro --all` | Read-only across EVERY run: which finding classes keep catching you, with counts and one cited example each. Writes nothing. |
| `tldrx drive --attended \| --unattended [<run>]` | Print the session mandate for driving a run — the three-role protocol, evidence discipline, parking, review calibration and budget honesty. Fills every `<run>` in from the id, or from the one open run. Needs no workspace. |
| `tldrx ship` | Open a PR from the epic branch, with the handoff as the body — one PR per repo when the branch is in several, listed at the end. Re-running skips a repo whose PR is already open. |
| `tldrx tickets` | Mirror epics and stories to a ticket tool. Files stay the source of truth. |
| `tldrx note <run> "…"` | Record one operator annotation, changing nothing else. |

## Exit codes

| | |
|---|---|
| `0` | ok |
| `1` | usage or schema error, or a check ran and failed |
| `2` | refused — a gate said no, or several runs are open and it will not guess |
| `3` | not found — no workspace, no run, no card by that name |
| `4` | **awaiting a human** — the stage ran and stopped at its gate |
| `5` | the sub-agent failed |

Which of these a given command can return is listed by `tldrx <command> --help`.

## Two conventions that apply almost everywhere

- **It never guesses which run you meant.** With several open and no id, a run-targeting
  command exits `2` and lists them. Pass a positional `<run>` on `next`, `run status`,
  `cost`, `replay` and `retro`; `--run <id>` on the rest.
- **Progress output goes to stderr, always.** `--ui scene|compact|plain|off` (default
  `auto`) changes what you see while a sub-agent runs; stdout is byte-identical either way,
  so `tldrx run status --json | jq` is unaffected.
