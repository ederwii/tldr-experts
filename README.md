# tldr-experts

[![npm](https://img.shields.io/npm/v/tldr-experts?label=npm%20tldr-experts)](https://www.npmjs.com/package/tldr-experts) [![ci](https://github.com/ederwii/tldr-experts/actions/workflows/ci.yml/badge.svg)](https://github.com/ederwii/tldr-experts/actions/workflows/ci.yml) ![status](https://img.shields.io/badge/status-alpha-orange)

**A lightweight, file-based AI development workflow.** Open source, tool-agnostic in design, piloted on Claude Code. **Alpha:** every command is implemented and verified by running it; interfaces may change without notice, and `tldrx --help` is the authoritative surface.

One loop — *Investigate → Handoff → Interview → Gate* — five phases, **what · how · plan · build ·
watch**, one stage per command, each stopping at a gate you own; the files ARE the state, the
dashboard, the resume point and the memory. Every claim a stage writes carries a `[src: …]` token
that must resolve against a real file, fact or question, or the write is refused; every dollar is
recorded from what the model reported, never estimated. Nothing prints success for work it did not
do: a command that cannot do the thing exits non-zero and says which thing.

## Quick start

> **Not on npm yet.** Every published version was unpublished on 2026-08-29 (`npm view tldr-experts
> version` → `E404 Unpublished`) and there is no `v0.3.0` tag, so the `npm i -g` line 404s until
> `scripts/release.sh 0.3.0` is run. Until then: clone and `bun link`, or `bun <repo>/bin/tldrx.ts <cmd>`.

```bash
npm i -g tldr-experts     # installs `tldrx` (short) and `tldr-experts` (same binary)
cd your-project
tldrx doctor              # check the environment — it is the authority, not a list in a README
tldrx init                # detect repos, map the code, write .tldrx/, ask only the gaps
tldrx install --claude    # write the skill, hooks and status line into ./.claude/
```

Then open Claude Code there and type **`/tldrx`**. It runs `tldrx status`, finds what is already
waiting on you — unanswered setup questions, a proposed split nobody decided, a run waiting on a gate,
an expert no stage can lean on yet — and walks you through it one item at a time, asking every decision
that is yours and running only the mechanical steps. Or drive it from a shell, with no Claude Code:

```bash
tldrx run new payments --scope feature --seed docs/payments/ --budget 25
tldrx run auto            # `next`, over and over, until something actually needs you
```

**Runtime: Node ≥ 20 or Bun** — the published package is a pre-built bundle with zero runtime
dependencies, so an installed `tldrx` needs only Node; Bun builds it. Full walkthrough:
[`docs/guide/01-quick-start.md`](docs/guide/01-quick-start.md).

## How much human is in the loop

Every stage ends at a gate; what you choose is **who closes it**. `human` waits for `tldrx approve`.
`auto` lets the harness close it, and only when all five conditions hold: the stage's checks pass, its
phase has no open question, the spend is inside both the stage and phase ceilings, the stage did not
fail, and the claim-sources validator reports nothing. Any one failing falls back to the human gate
and says which one and what it measured.

| Scope | what | how | plan | build | watch |
|---|---|---|---|---|---|
| `feature` `bugfix` `integration` `refactor` | human | auto | human | auto | human |
| `performance` | human | auto | — | auto | human |
| `docs` | auto | — | — | human | — |
| `spike` | auto | human | — | — | — |
| `prototype` | auto | auto | — | human | — |
| `upgrade` | auto | — | auto | auto | human |
| `hotfix` | auto | — | — | human | human |
| `security-patch` | auto | auto | — | human | human |
| `migration` | auto | auto | auto | human | human |

A scope with `—` under `plan` does not run the Plan phase, and Build writes the one story that
decision implies (`04-build/implicit-plan.yml`) from your What handoff rather than refusing;
`run status` says `plan: implicit (scope skips Plan)`. A `03-plan/` you write yourself always wins.

Those are the shipped defaults, and every scope keeps at least one human gate. Override per run with
`--gates <stage,stage>` — **the list is the human gates** — or `--gates all|none`. When the machine
signs something it should not have, `tldrx reject --stage <phase>/<stage> --note "…"` revokes it, moves
the cursor back and marks the later stages `stale`. What an auto gate cannot do:
[`docs/guide/03-runs-and-gates.md`](docs/guide/03-runs-and-gates.md).

## What you see while it runs

A stage can take four minutes. `tldrx next`, `run auto`, `expert train` and
`seed triage --propose` show a classroom on stderr. Captured at 80x24, mid-stage:

```
+----------------------------------------------+      .---.
| what · 260829-tenancy · attempt 1            |    /       \
+----------------------------------------------+   |    ·    |
| reading api/src/Outbox.cs                    |    \ \     /
| grep "Outbox"                                |      '---'
| The tenancy boundary is the row filter, not… |      03:41
| $ dotnet test tests/Unit → running           |
|   → ok (12 s)                                |
| writing tldrx-work/260829-tenancy/01-what/h… |
+----------------------------------------------+

     ,-----.            .-------.
    ( ##### )           | o   o |
     '--|--'            |   -   |
     /  |  |            '---+---'
  __/  [~]  \__        __/     \__
 |_____________|      |___________|
   ||       ||         ||       ||

  $0.00 of $6.00 · Ctrl-C stops after this turn
```

Nothing on that screen costs anything: every line is derived from the `stream-json` events `claude`
was already sending — no second model call, no summary agent — and the dollar figure is what has
been **recorded**, never an estimate. `--ui scene|compact|plain|off` (`auto` by default); stdout is
byte-identical with it on or off.

## Cost control

Four things bound what a stage costs, and only two act before the money.
`tldrx next --prepare` prints the context ledger, so what you are about to pay for is visible
first:

```
context 83.7 KB of 160.0 KB (~23.8k tok, 12% of sonnet's ~200.0k window)
  stage 3.7 KB · inputs 77.3 KB · experts 2.7 KB (bodies 2.5 KB, knowledge 250 B)
  input docs/domain-design/DECISIONS-NEEDED.md 15.1 KB
```

Over `prompt_max_bytes` the stage is **refused** (exit 2) before anything spawns; `max_reads` stops
the sub-agent at a read ceiling; `--effort` changes what a turn costs. What `--max-budget-usd` does is
end a run *after* the turn it is already in — measured, one turn spent **$5.15** against a **$1.50**
ceiling — so size the prompt for the money you are willing to lose. Afterwards `tldrx cost [--all]` adds up what was actually charged, per attempt, per stage, per
run, read off `agent.result` events and nothing else. Retries are never merged — a retry is
exactly the money you are looking for — and work whose cost this process never saw is UNMETERED,
never $0.00. `tldrx run estimate` is the only command that guesses, and says so in words.
Details: [`docs/guide/06-budgets-and-cost.md`](docs/guide/06-budgets-and-cost.md).

## Several runs

With several runs open and no id, every run-targeting command **refuses rather than guessing**,
exits `2`, and lists them — `tldrx next: 3 runs are open — pass one:`. That means "you left off
the id", not "it broke". Pass a positional `<run>` on `next`, `run status`, `cost`, `replay` and
`retro`; `--run <id>` on the rest. `tldrx run status` with several open lists them all, exit `0`.

## What to commit

**Both `.tldrx/` and `tldrx-work/`.** The files are the state — the map, the facts, the questions and
their answers, `run.yml`, `budget.yml`, `events.jsonl`, the handoffs, the plan — so a teammate who clones
the repo gets the run. The block `tldrx init` appends to `.gitignore` excludes five paths and nothing
else, because those five are machine-local or regenerated: `.tldrx/graphify-out/`, `.tldrx/cache/`,
`.tldrx/worktrees/`, `tldrx-work/*/.lock`, `tldrx-work/*/.agent/`.

## Documentation

The guide, in `docs/guide/`: [1 Quick start](docs/guide/01-quick-start.md) ·
[2 The loop](docs/guide/02-the-loop.md) (the four steps, what a stage file controls, the two execution modes) ·
[3 Runs and gates](docs/guide/03-runs-and-gates.md) (`run new`→`retro`, gate policy, `run auto`, unlock/cancel, dashboard, tickets) ·
[4 Experts](docs/guide/04-experts.md) (loading rules, role experts, training, levels) ·
[5 Seeds and triage](docs/guide/05-seeds-and-triage.md) (`--seed`, `--from`, splitting a big seed) ·
[6 Budgets and cost](docs/guide/06-budgets-and-cost.md) · [7 Claude Code](docs/guide/07-claude-code.md) (plugin, hooks, `/tldrx`) ·
[8 CLI reference](docs/guide/08-cli-reference.md) (every command, flag and exit code) ·
[9 Troubleshooting](docs/guide/09-troubleshooting.md) (every refusal, and the move that clears it).
Design docs: [`docs/concept.md`](docs/concept.md) (why) · [`docs/spec.md`](docs/spec.md) (the schemas, and §7's
open decisions) · [`docs/ROADMAP.md`](docs/ROADMAP.md) (next) · [`CHANGELOG.md`](CHANGELOG.md) (shipped) ·
[`docs/dashboard-model.md`](docs/dashboard-model.md).

## Releases and status tags

Install name is **`tldr-experts`**; it installs two commands, **`tldrx`** (short) and `tldr-experts` (same binary).
Unscoped `tldrx` as a *package* name is refused by npm's name-similarity rule (too close to `tsdx`). Versions 0.0.1–0.2.0
were published then unpublished on 2026-08-29; per npm policy those numbers can never be reused, so the first version
back on the registry is 0.3.0.

| Version | Date | Status | Contains |
|---|---|---|---|
| 0.3.0 | 2026-08-30 | `alpha` | expert training with provenance, auto gates with an undo, `tldrx status`, seed triage, the token economy (context ledger, `max_reads`, `cost`, `estimate`), `install --claude`, `interview`, the ticket mirror, `--help` with flags and exit codes |
| 0.2.0 | 2026-08-29 | `alpha` | Build executor (worktree + branch per story, epic branches, DoD gate, reviewer), Watch cards, live dashboard |
| 0.1.0 | 2026-08-29 | `alpha` | greenfield `init --stack` + `run new --seed`, story/epic/waves schemas, `tldrx budget show\|raise`, sections must hold list items |
| 0.0.2 | 2026-08-29 | `alpha` | pilot-driven fixes (source resolution, retry semantics, distill dedupe) |
| 0.0.1 | 2026-08-29 | `alpha` | v0 loop: init, map, doctor, run lifecycle, `next`, six hooks, views |

Status tags: `alpha` = every command real and tested, interfaces may change without notice, one pilot workspace;
`beta` = file formats frozen (`version: 1` schemas only grow), two or more real workspaces through Build, upgrade
path documented; `stable` = 1.0, semver from here on. The badge above shows the newest release's tag.

## Releasing

**One command: `scripts/release.sh X.Y.Z --tag alpha`.** It is the only sanctioned path — a Claude Code hook denies hand-made `git tag` / `npm publish`, and `publish.yml` re-runs the same checks. Checklist and judgement calls: `docs/RELEASING.md`.

MIT, © 2026 Alan Martinez — a placeholder made while scaffolding; change it freely before anything ships.
