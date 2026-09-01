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

```bash
npm i -g tldr-experts     # installs `tldrx` (short) and `tldr-experts` (same binary)
cd your-project
tldrx doctor              # check the environment — it is the authority, not a list in a README
tldrx init                # detect repos, map the code, write .tldrx/, ask only the gaps
tldrx install --claude    # write the skill, hooks and status line into ./.claude/
```

Later: **`tldrx update`** pulls the newest published version and prints the CHANGELOG between the
one you had and the one you now have. Any command will tell you, in one line, when there is a newer
one — off the hot path, cached for a day, silent when it cannot reach the registry, and never in
`--json` output or during a hook. Turn it off with `TLDRX_UPDATE_CHECK=off`.

**Never used it before?** `tldrx learn` teaches the loop by running it: eight chapters, ~15 minutes,
in a throwaway sandbox with a toy repo and a stand-in agent. Every command in it is the real one —
`init`, `run new`, `next`, `approve`, a Build that cuts a branch and runs a real DoD — so nothing it
shows you can drift from what the binary does, and it costs $0.00 and touches nothing you own.

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

## Trying it: three ways to run

`tldrx run auto` and `tldrx run attend host` read like two speeds of the same thing. They are
opposites and they do not compose. **`auto` is an engine, not a lock**: a headless loop in which
the *framework* spawns a metered sub-agent, stage after stage. **`attend host` is a lock, not an
engine**: it sets one field, spends nothing and runs no stage, and from then on the framework never
spawns on that run — every turn is a `--prepare` / `--commit` handshake with a session you drive.
`run auto` on an attended run is refused outright (exit `1`); a bare `tldrx next` there exits `4`
and names the `--prepare` command instead.

| | who executes each turn | what a turn costs | where it stops |
|---|---|---|---|
| `tldrx run auto` | the framework — `claude -p`, spawned stage after stage | metered per spawn, rolled up by `tldrx cost` | the first human gate or open question (`4`), stage failure (`5`), ceiling (`2`) |
| `tldrx run attend host`, driven from a session | your session's own sub-agents | host-billed; the framework records `cost_usd: null, metered: false` | every turn — `--prepare` writes the bundle, `--commit` settles it |
| the same, under a **mandate** | your session's own sub-agents | host-billed | a new product decision, a ceiling raise, a boundary exit — nothing else |

- **A small run you were going to watch anyway** → `run auto`. One command, and it stops the moment it needs you.
- **A Claude Code session already open, and you care about cost or quality** → `run attend host`, driven from it: the context is warm, the turns are host-billed, and the framework writes the Build reviewer's bundle rather than spawning a second reader beside one you are already paying for.
- **Overnight, hands off, and you still want the adversarial check** → `run attend host` plus a mandate, below.
- **CI or cron** → `run auto`. It is the only one of the three with no session behind it.

### Overnight, with the checking kept

Two commands and a prompt — and the prompt now ships with the package:

```bash
tldrx drive --unattended        # print the mandate; paste it into the session that drives the run
tldrx drive --attended          # the same disciplines, but every gate stays yours to sign
```

`tldrx drive` needs no workspace, opens no run and writes nothing: it prints the discipline the
first real runs were driven by — the three-role protocol (developer → a **fresh** adversarial
reviewer, never the author → the host verifying both in the code, not in their reports), evidence
labelled `measured` / `inferred` / `assumed`, product questions parked rather than decided, the
reviewer calibrated to the story's stakes, and the cost declared once. The two modes differ in
exactly two places: who drives the turns, and who may close a gate.

The rest of this section is what that mandate says, in the shape you would type it by hand.

```bash
tldrx run new payments --scope feature --budget 25 \
  --attended-by host --gates what:agent,plan:agent,build:agent,watch:agent
tldrx run attend host 260101-payments      # or flip a run that is already open
```

`--gates` **replaces the workflow's gates wholesale**, and a stage you leave out of the list becomes
`auto` — so name every gate you want signed. Then, in the session, the mandate:

> Act as my unattended verification gate on run `260101-payments`, until it reaches its last gate.
>
> Drive every stage yourself — `tldrx next --prepare 260101-payments`, then
> `tldrx next --commit 260101-payments` — dispatching your own sub-agents for the turns. The
> framework must never spawn.
>
> For every build story, run an INDEPENDENT adversarial review through the `--review` handshake:
> `tldrx next --prepare --review`, one read-only sub-agent over the diff, then
> `tldrx next --commit --review`. Its job is to find what the developer got wrong, not to agree
> with it.
>
> Approve a gate only after you have checked it yourself — that the citations resolve, that every
> touched path is one this run declared, and that the diff matches the stories it claims to
> implement — and write that check down as evidence: `tldrx gate template`, fill it in, then
> `tldrx approve --as-agent`.
>
> Interrupt me ONLY for a new product decision, a budget-ceiling raise, or work that has to go
> outside the declared boundary. Everything else you decide, and log.
>
> Never push. The final merge is mine.

The whole chapter — the three switches, what "never spawns" is enforced by, the review handshake,
the fix list, the evidence note and the four fallthroughs:
[10 Unattended mode](docs/guide/10-unattended-mode.md).

## How much human is in the loop

Every stage ends at a gate; what you choose is **who closes it**. `human` waits for `tldrx approve`.
`auto` lets the harness close it, and only when all **seven** conditions hold: the stage's checks pass,
its phase has no open question, the spend is inside both the stage and phase ceilings, the stage did not
fail, the claim-sources validator reports nothing — and, on a Build stage, every story in the plan
reached `done` **and** the epic branch changed nothing the run never declared it would touch. Any one
failing falls back to the human gate and says which one and what it measured.

`agent` is the third policy, and the strongest: those same seven, plus no budget decision taken while
the stage ran, plus a validated **evidence note** the agent signed — a checklist whose own bullets each
carry a `[src: …]` that resolves. It arrives by choice (`--gates plan:agent`), never by default, and it
falls through to a person on an open question, a moved ceiling, work outside the declared boundary, or
its own refusal. See [10 Unattended mode](docs/guide/10-unattended-mode.md).

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

`--parallel <n>` on `next` / `run auto` builds that many of a wave's stories at once
(merges still land in the wave's listed order; default 1 is unchanged).

A scope with `—` under `plan` does not run the Plan phase, and Build writes the one story that
decision implies (`04-build/implicit-plan.yml`) from your What handoff rather than refusing;
`run status` says `plan: implicit (scope skips Plan)`. A `03-plan/` you write yourself always wins.

Those are the shipped defaults, and every scope keeps at least one human gate. Override per run with
`--gates <stage,stage>` — **the list is the human gates** — or `--gates all|none`. When the machine
signs something it should not have, `tldrx reject --stage <phase>/<stage> --note "…"` revokes it, moves
the cursor back and marks the later stages `stale`. When it is one BUILD STORY you disagree with — a
story two reviewers refused, which is terminal for the rest of the run —
`tldrx story reopen <id> --note "…"` gives that one story another run of attempts and nothing else.
When you fix `.tldrx/workspace.yml` mid-run and the approved stories still cite the old command strings,
`tldrx plan sync-dod` rewrites just their dod lines — renames followed, removed commands dropped, and
anything with no ancestor in the file's history flagged rather than guessed at.
What an auto gate cannot do: [`docs/guide/03-runs-and-gates.md`](docs/guide/03-runs-and-gates.md).

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

`tldrx retro --all` goes the other way: it reads **every** run in the workspace and prints one
table of what keeps catching you — finding class × count × how many runs × one example with its
citation — mined from the review logs, the fix lists, `retro.md` and the `story.reopened` reasons.
Strictly read-only: it writes nothing, anywhere.

## What to commit

**Both `.tldrx/` and `tldrx-work/`.** The files are the state — the map, the facts, the questions and
their answers, `run.yml`, `budget.yml`, `events.jsonl`, the handoffs, the plan — so a teammate who clones
the repo gets the run. The block `tldrx init` appends to `.gitignore` excludes five paths and nothing
else, because those five are machine-local or regenerated: `.tldrx/graphify-out/`, `.tldrx/cache/`,
`.tldrx/worktrees/`, `tldrx-work/*/.lock`, `tldrx-work/*/.agent/`.

## Documentation

**[The documentation site](https://ederwii.github.io/tldr-experts/)** is the place to start if you have
never used this: a landing page, a Quickstart and one short page per concept, written for a reader
rather than for an agent. Source in [`docs-site/`](docs-site/).

The reference guide, in `docs/guide/`: [1 Quick start](docs/guide/01-quick-start.md) ·
[2 The loop](docs/guide/02-the-loop.md) (the four steps, what a stage file controls, the two execution modes) ·
[3 Runs and gates](docs/guide/03-runs-and-gates.md) (`run new`→`retro`, gate policy, `run auto`, unlock/cancel, dashboard, tickets) ·
[4 Experts](docs/guide/04-experts.md) (loading rules, role experts, training, levels) ·
[5 Seeds and triage](docs/guide/05-seeds-and-triage.md) (`--seed`, `--from`, splitting a big seed) ·
[6 Budgets and cost](docs/guide/06-budgets-and-cost.md) · [7 Claude Code](docs/guide/07-claude-code.md) (plugin, hooks, `/tldrx`) ·
[8 CLI reference](docs/guide/08-cli-reference.md) (every command, flag and exit code) ·
[9 Troubleshooting](docs/guide/09-troubleshooting.md) (every refusal, and the move that clears it) ·
[10 Unattended mode](docs/guide/10-unattended-mode.md) (`attended_by: host`, `gates_policy: agent`, the
review handshake, the fix list, decision cards).
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
| 0.4.0 | 2026-09-01 | `beta` | FIRST BETA — 40-issue hardening burn (DoD pre-flight + `plan sync-dod`, merge-wave lock + gated-HEAD, load-aware tests, claim-sources across all outputs), `tldrx learn` 8-chapter sandbox tutorial (cold-player QA), `tldrx ship` / `tldrx note` / `run gates set`, budget policies + dual-economy wiring, single integration branch for chained epics, epic worktrees live to run close, bilingual docs site |
| 0.3.1 | 2026-08-31 | `alpha` | Unattended mode (gates_policy agent, review handshake, fixlist, decision cards, dual economy), 6 contact fixes from the first feature-scope runs, colored init, training repair round |
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
