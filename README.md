# tldr-experts

[![npm](https://img.shields.io/npm/v/tldr-experts?label=npm%20tldr-experts)](https://www.npmjs.com/package/tldr-experts) [![ci](https://github.com/ederwii/tldr-experts/actions/workflows/ci.yml/badge.svg)](https://github.com/ederwii/tldr-experts/actions/workflows/ci.yml) ![status](https://img.shields.io/badge/status-beta-blue)

**An evidence-first, file-based AI development framework: five stages, a gate on every one, and every claim cited or refused.** Open source. The workflow and the persisted state format are provider-independent; the automated runner currently supports Claude Code and Codex. **Beta:** every command is implemented and verified by running it, the `version: 1` file formats only grow from here, and `tldrx --help` is the authoritative command surface.

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

**To run it: Node ≥ 20, and nothing else** — the published package is a pre-built bundle with
zero runtime dependencies, and `dist/` is a Node bundle (Bun runs it too, if you have it).
**To build or contribute: Bun ≥ 1.3**, which compiles that bundle and runs the test suite.
`tldrx doctor` is the authority on the rest. Full walkthrough:
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
| `tldrx run auto` | the framework — Claude Code by default, or `codex exec` when selected | Claude reports metered USD; Codex reports tokens and is unmetered in dollars | the first human gate or open question (`4`), stage failure (`5`), ceiling (`2`) |
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
tldrx drive --unattended --tldr # essentials only, for a run whose trail you will not read
```

`tldrx drive` needs no workspace, opens no run and writes nothing: it prints the discipline the
first real runs were driven by — the three-role protocol (developer → a **fresh** adversarial
reviewer, never the author → the host verifying both in the code, not in their reports), evidence
labelled `measured` / `inferred` / `assumed`, product questions parked as **guided** ones rather
than decided, the reviewer calibrated to the story's stakes, and the cost declared once. The two
modes differ in exactly two places: who drives the turns, and who may close a gate.

**The unattended mandate leads with `## Do not stop`.** A run only ends early because the session
decides to, so the text defines the one thing that may end it — a strict blocker, where no
remaining turn can proceed until you answer — and makes the driver name the work a blocker does
*not* block before it may halt for it. Everything short of that is parked as a guided question
(lettered options, the option the driver would take, asked on the console unless your launch
message names another channel) and the run carries on down every path the question does not block.

**`--tldr` is for the runs you will not audit.** The session reports what `tldrx run status`
already prints — phases, percentages, spend against the ceiling, what is next — plus at most three
bullets of delta, and stops narrating. It also drops the half of the trail nothing consumes:
measured across ten real runs, of ~4.0 MB written 2.16 MB is trail, and all 261 declared stage
`inputs:` contain **zero** references to `handoff.md`, `retro.md` or `gate-evidence`. It is a
reporting contract, not a quality setting — the evidence discipline and the gate checks are
untouched, and handoffs keep their citations because `claim-sources` gates on them.

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

`--parallel <n>` on `next` / `run auto` builds that many of a wave's stories at once. The
shipped Build stage declares `parallel: 2`, so a workspace that overrides nothing already runs
two lanes; the code fallback stays 1, for a stage file that says nothing. Merges still land in
the wave's listed order whatever the number is.

A scope with `—` under `plan` does not run the Plan phase, and Build writes the one story that
decision implies (`04-build/implicit-plan.yml`) from your What handoff rather than refusing;
`run status` says `plan: implicit (scope skips Plan)`. A `03-plan/` you write yourself always wins.

Those are the shipped defaults, and every scope keeps at least one human gate. Override per run with
`--gates <stage,stage>` — **the list is the human gates** — or `--gates all|none`. When the machine
signs something it should not have, `tldrx reject --stage <phase>/<stage> --note "…"` revokes it, moves
the cursor back and marks the later stages `stale`. When it is one BUILD STORY you disagree with — a
story two reviewers refused, which is terminal for the rest of the run —
`tldrx story reopen <id> --note "…"` gives that one story another run of attempts and nothing else;
for one named defect in a story already `done`, `--for-fix` opens a fix round instead — no attempt
consumed, the same DoD and the same reviewer, one open round at a time.
To move who may close a gate after `run new` froze it, `tldrx run gates set <stage>:<policy> --note "…"`
is the only sanctioned way, and it records the old→new value with your reason.
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
the sub-agent at a read ceiling; `--effort` changes what a turn costs. What `--max-usd` does is
end a run *after* the turn it is already in — measured, one turn spent **$5.15** against a **$1.50**
ceiling — so size the prompt for the money you are willing to lose. Afterwards `tldrx cost [--all]` adds up what was actually charged, per attempt, per stage, per
run, read off `agent.result` events and nothing else. Retries are never merged — a retry is
exactly the money you are looking for — and work whose cost this process never saw is UNMETERED,
never $0.00. `tldrx run estimate` is the only command that guesses, and says so in words.
Details: [`docs/guide/06-budgets-and-cost.md`](docs/guide/06-budgets-and-cost.md).

## Several runs

With several runs open and no id, a run-targeting command **refuses rather than guessing** and
lists them — `tldrx next: 3 runs are open — pass one:`. That means "you left off the id", not "it
broke". Two of them refuse differently and it is worth knowing which: `tldrx run status` is not a
refusal at all — it lists every open run and exits `0`, and it is the screen you read to find the
id the others want — and `tldrx cost` refuses at exit `1`, not `2`.

Most run-targeting commands take the id either way, a positional `<run>` or `--run <id>`: `next`,
`cost`, `note`, `gate template`, `questions`, `budget show`, `ship`, `tickets`, and `run attend` ·
`status` · `estimate` · `auto` · `unlock` · `cancel`. `replay` and `retro` take the positional only
— `--run` there is an unknown flag. `approve`, `reject`, `answer`, `interview`, `plan`,
`story reopen`, `facts add`, `watch` and `run gates set` take `--run <id>` only.

`tldrx retro --all` goes the other way: it reads **every** run in the workspace and prints one
table of what keeps catching you — finding class × count × how many runs × one example with its
citation — mined from the review logs, the fix lists, `retro.md` and the `story.reopened` reasons.
Strictly read-only: it writes nothing, anywhere.

## What to commit

**Both `.tldrx/` and `tldrx-work/`.** The files are the state — the map, the facts, the questions and
their answers, `run.yml`, `budget.yml`, `events.jsonl`, the handoffs, the plan — so a teammate who clones
the repo gets the run. The block `tldrx init` appends to `.gitignore` excludes eight paths and nothing
else, because those eight are machine-local, regenerated, or a backup git already holds the history
of: `.tldrx/graphify-out/`, `.tldrx/cache/`, `.tldrx/worktrees/`, `tldrx-work/*/.lock`,
`tldrx-work/*/.agent/`, `tldrx-work/**/*.bak`, `.tldrx/**/*.bak` and
`.claude/settings.json.bak-tldrx-*`.

**You do not have to commit them by hand.** Closing a run — `tldrx approve` on the last gate,
`tldrx next`, or `tldrx run cancel` — commits `tldrx-work/<run>/` and `.tldrx/memory/` in the
workspace checkout, on the branch that checkout is on, and prints one line saying where they went.
Only those paths: anything else you had staged is still staged afterwards. It is deliberately never
the epic branch — an epic under review carries feature code, and run state on it collides with the
same live files in your working tree the moment the PR merges, which is why `tldrx ship` refuses an
epic that carries any (#102).

## Documentation

**[The documentation site](https://ederwii.github.io/tldr-experts/)** is the place to start if you have
never used this: a landing page, a Quickstart and one short page per concept, written for a reader
rather than for an agent. Source in [`docs-site/`](docs-site/). It carries a
**[live demo of `tldrx dashboard`](https://ederwii.github.io/tldr-experts/demo)** — a real export,
rendered from the test suite's synthetic fixtures on every deploy, so you can see what the tool
draws before installing anything.

The reference guide, in `docs/guide/`: [1 Quick start](docs/guide/01-quick-start.md) ·
[2 The loop](docs/guide/02-the-loop.md) (the four steps, what a stage file controls, the two execution modes) ·
[3 Runs and gates](docs/guide/03-runs-and-gates.md) (`run new`→`retro`, gate policy, `run auto`, unlock/cancel, dashboard, tickets) ·
[4 Experts](docs/guide/04-experts.md) (loading rules, role experts, stack packs, training, levels) ·
[5 Seeds and triage](docs/guide/05-seeds-and-triage.md) (`--seed`, `--from`, splitting a big seed) ·
[6 Budgets and cost](docs/guide/06-budgets-and-cost.md) · [7 Claude Code](docs/guide/07-claude-code.md) (plugin, hooks, `/tldrx`) ·
[8 CLI reference](docs/guide/08-cli-reference.md) (every command, flag and exit code) ·
[9 Troubleshooting](docs/guide/09-troubleshooting.md) (every refusal, and the move that clears it) ·
[10 Unattended mode](docs/guide/10-unattended-mode.md) (`attended_by: host`, `gates_policy: agent`, the
review handshake, the fix list, decision cards).
Design docs: [`docs/concept.md`](docs/concept.md) (why) · [`docs/spec.md`](docs/spec.md) (the schemas, and §7's
open decisions) · [`docs/ROADMAP.md`](docs/ROADMAP.md) (next) · [`CHANGELOG.md`](CHANGELOG.md) (shipped) ·
[`docs/dashboard-model.md`](docs/dashboard-model.md).

Contributing: **[`CONTRIBUTING.md`](CONTRIBUTING.md)** — the loop a change goes through, the four gates
and what CI actually runs, the red-first test rules, and
[how to contribute a model-provider config](CONTRIBUTING.md#contributing-a-model-provider-config)
(the `TLDRX_CLAUDE_BIN` seam, the `stream-json` transcript contract, and what a generic provider
would have to supply).

## Releases and status tags

Install name is **`tldr-experts`**; it installs two commands, **`tldrx`** (short) and `tldr-experts` (same binary).
Unscoped `tldrx` as a *package* name is refused by npm's name-similarity rule (too close to `tsdx`). Versions 0.0.1–0.2.0
were published then unpublished on 2026-08-29; per npm policy those numbers can never be reused, so the first version
back on the registry is 0.3.0.

| Version | Date | Status | Contains |
|---|---|---|---|
| 0.16.1 | 2026-09-12 | `beta` | five things the framework knew and did not say, or said wrong — four of them found by using it rather than by reading it: a red base pre-flight now KEEPS its output, so a refusal that blocks every story in a Build names the failing test and cites the file, where it used to record only the last line of stdout — measured 2026-09-10, a stage refused with `tail: "Test run completed with non-success exit code: 2"` while the cause, `DockerUnavailableException`, sat on line 12 of 163,702 lines the run had already captured and thrown away, so diagnosing a refusal the framework had itself measured meant re-running the workspace's test command by hand; it now routes through the same seam #211 built for a story's DoD, which had been naming its failing test correctly all along on the same command, the same day, in the same repo — the path with the SMALLER blast radius was the legible one; a gate notification now offers the command that CLEARS it rather than always `tldrx approve` — questions open give `tldrx answer <id>`, unfinished stories give `tldrx run status`, and `approve` is offered only when nothing mechanical is outstanding, after an owner approved a Build gate by mistake twice in one evening over unbuilt stories, each time from a phone, each time needing a revoke, while a ten-minute heartbeat repeated `Run: tldrx approve` seven times under a sentence that correctly named the five open questions holding it; `tldrx reject --and-continue` lets a rejection mean "redo it this way and carry on" instead of ending the run — the loop resumed after an approve and stopped after a reject, so the button meaning "there is still work to do" was the one that stopped the work and only a terminal could revive it; five real rejections that night all meant continue, five cost a manual relaunch, and a bare `tldrx reject` still writes a byte-identical `run.yml` and stops exactly as before; the expert-recompute fixture anchors its evidence dates to a `now` it can move, so `bun test` stops going red by the calendar — pristine `main` was red at the exact sha of the published 0.16.0 with no commit in between, and a clock moved one year forward reddened FIVE cases, not the one that had already fired; and `test/merge-wave.test.ts`'s concurrency failure, documented as a known flake since #115 and carrying a written licence to re-run it, was never one: `merge-guard.sh` rewrote `.git/hooks/reference-transaction` IN PLACE while a sibling wave's `git merge` was exec'ing it — ETXTBSY on Linux at 31% under contention, benign on macOS, which is why it was green locally and red in CI, and why a same-sha re-run failed 2 for 2 rather than passing; the hook is now written to a temp file and RENAMED into place, the refusal that used to borrow `2`/`merge conflict` for a hook abort now says what it was and exits 11, and AGENTS.md §4 withdraws the re-run licence for those two cases while naming the interrupted-merge case (#237) as still open and undiagnosed — because "all real" for a whole file costs the same as "all flake", in the other direction |
| 0.16.0 | 2026-09-11 | `beta` | an unattended run can now clear the one kind of failure it was stopping on, and a gate that refuses says why it refused: measured 2026-09-10 on a real unattended `run auto`, the loop drove itself through what → how → plan and signed all three `auto` gates by itself, and still needed a person four times — three of those were content or money decisions a loop must not make, and the fourth was a plan that failed its own check by five characters over a cap, where a person relaunched the same command and the next attempt fixed the two files and passed, so the loop stopped on the one failure it could have cleared; `tldrx run auto --retry-failed <n>` now runs a failed stage again at most `n` times in a row, bounding exit `5` and nothing else — a usage error (`1`), a money refusal (`2`) and an awaiting-human park (`4`) are each attempted ONCE however large `n` is, because a phase ceiling means a human decides about money and a retry would turn that sentence into a delay — only CONSECUTIVE failures count since what is bounded is "this run is stuck" and not "this run has ever failed", a retry SPENDS as a fresh metered stage under the same phase ceiling and the same `--max-usd`, `0` is the default and a default invocation's lines are byte-identical to what they were, and when the bound is spent the loop stops on the failure's own exit `5` and says the count LAST, so the sentence that reaches a phone is what the loop tried and not a bare number; and an `auto` gate that REFUSES now writes down the verdict its note was always designed to carry — a gate sat pending ~40 minutes while `run status` and `--verbose` named no condition at all, and the reason surfaced only when a person guessed at the `tldrx approve` the status line suggested, which is the one route nobody unattended is going to take — recording all seven conditions WITH THEIR VALUES on the still-`pending` gate, since a note that dropped the passing ones would answer "was it the money" with the same silence, and naming the holding ids on the gate row and on the `waiting` line; it writes only over a `pending` gate, so a gate a person has since signed keeps THEIR words, and only when the verdict would change, so a four-hour `--wait-gates` poll writes once per distinct verdict rather than thousands of times — and that test and that write are a compare-and-set under the workspace lock, because pre-merge review reproduced, with two real processes, a check-then-act over an earlier snapshot erasing a concurrent `approve` outright, and the poll runs every two seconds precisely while a person is deciding |
| 0.15.0 | 2026-09-10 | `beta` | defaults for the models actually running today, and records that name what happened: measured 2026-09-07/09 across three real workspaces, the first engine-driven run of each was ended by a calibration rather than by the work — a `how` turn and two Build developer turns killed at a 900 s per-turn clock while Opus turns on real repositories run 15-50 minutes, a 202 KB prompt refused by a ceiling whose own message called it "29% of a 200k window", and a 169 KB `facts.yml` sliced to 96 KB on its way into a design turn that then died. So a turn gets two hours (`timeout_s` 900 → 7200), a prompt 400 KB and inputs 256 KB, a phase ceiling holds every attempt its stages may take so the first retry of a stage that spent anything is no longer refused by arithmetic — `warn_at_pct` still measured against one attempt's share, so the warning still arrives before the money — and the four numbers that were calibrations rather than invariants (`attempts`, `fixlist_rounds`, `reviewer_share`, `gate_signer_share`) became optional `stage.yml` keys, refused by name out of range instead of clamped, absent meaning today's constant byte for byte, with `tldrx run auto --prompt-max-bytes` and `--max-reads` for the unattended run that would otherwise need a file edit to get past one refusal; a story's Definition of Done now runs with its dependencies installed — the `install:` slot has sat unread in `templates/workspace.yml` since the beginning and now runs in every fresh story worktree through the same allowlist-and-argv runner, recorded with its own exit code and duration, blocking the story rather than paying a turn to discover it — an exit 127 is reported as a named absent binary and not as a red test, a declared command may be run WITH ARGUMENTS (the exact `Bash(npm run test)` grant matched nothing the developer actually typed, so its own 127 was first seen by the gate, after the turn was paid for), and every DoD check says which tree it ran in; the Build gate now names story outcomes on every policy and not only `auto` — two runs approved from a phone printed `run is done` over zero stories delivered — `run.yml` records an additive `outcome:` written once by all three commands that close a run and rendered by six surfaces, and `tldrx ship` refuses with exit 1 instead of opening a PR over nothing; a red DoD keeps its real failure — the last 200 lines on disk (gitignored, since a tail can carry a secret), up to five failure-looking lines as the detail rather than the last `DeprecationWarning` on stderr, the failing line cited at the line it starts on, and the next attempt told it was the check and not a reviewer; a watcher card may honestly say `Query: none — <reason> [src: …]`, earned only over a card whose own `## Signal` cites `absent:` and refused like any unsourced item otherwise, after a stage spent real money writing the honest answer and was refused for it; a truncated input is told to the OWNER at spawn and not only to the sub-agent, a turn killed on timeout keeps the usage it had already streamed and never a price; and the maintain skill says which sha a review record must cite — the code head — a rule that cost a wave and was written down nowhere an agent reads |
| 0.14.3 | 2026-09-10 | `beta` | foreign uncommitted work no longer stops a Build, and the dashboard flake that blocked four merges in two days has a root cause: the dirty-tree guard used to count every `git status --porcelain` entry and refuse, offering only "commit it" or "stash it" — neither of which an agent may take with another person's files — and measured across three real workspaces on 0.14.2, every first engine-driven run reaching Build stopped at `04-build`, over seed docs, a data export and one untracked note; the dirt is now classified, `own` and `overlapping` refusing or passing exactly as before while everything `foreign` is set aside with a pathspec-limited `git stash push` as the LAST step before the epic branch is cut, recorded as `worktree.foreign_work_aside` and given back with `--index` on every exit path, success or failure, nothing ever deleted and nothing force-popped, a repo mid-merge, rebase, cherry-pick or bisect refused outright because that state has no clean undo, and a pop git refuses said as the stage's last line and carried into the handoff and the notification; the refusal's printed remedy is now the SAME string the engine runs, limited to the paths it listed and relaunching by mode, after an owner ran the pathspec-less line exactly as printed and it swept the run's own records under `tldrx-work/<run>/` into the stash until `tldrx next` answered `no run`; every path handed to git for a write is `:(literal)` and `git status` is read with `-z`, since a glob pathspec moved the neighbouring `x.txt` for a file called `[x].txt`; and the dashboard's live tests stop racing a typed millisecond — five consecutive runs of the two files went red 3 times, at 5084.27 / 5108.01 / 5256.49 ms against a hard-coded 5000 under load averages 65–107 on 14 cores — every deadline now deriving from one `eventWaitMs()` helper that scales like every other budget, with `test/machine-load.test.ts` refusing a hard-coded deadline in either file so it cannot come back at somebody's merge, while that measurement surfaced the product half: `watchWorkspace` armed its mtime sweep only in `poll` mode, so a dropped FSEvents notification left a live dashboard silently stale for the life of the process — measured with `fseventsd` at 98–115% CPU, directory events that never arrived AT ALL at 82,556 ms and 113,942 ms — and the sweep now runs in watch mode too, at 2 s, so a dropped notification is bounded rather than fatal |
| 0.14.2 | 2026-09-09 | `beta` | every citation check starts from a fresh view of `questions.md` and `facts.yml`: `srcToken.ts` memoised both indexes at module scope and nothing outside `test/` ever dropped them, so in `tldrx run auto` — one Node process for a whole run — the FIRST citation resolved anywhere froze the view every later stage was then judged against; measured on three real unattended workspaces at 0.14.1, a `how` stage refused with `no such question Q2 … declared: Q1` over questions it had itself written minutes earlier, and another refused over `145 live fact(s)` when `facts.yml` held 148, the three extra written by the owner's answers two seconds before the stage started — roughly $11 of paid turns thrown away for ids that were real the whole time; the indexes are now refreshed inside `toSrcContext`, the one place a citation context is built and a place every caller reaches exactly once per check, gate or hook, so a document's forty citations still read `facts.yml` once while nothing survives the check that read it |
| 0.14.1 | 2026-09-09 | `beta` | an auto gate that says what holds it and closes itself, and three derivations cut to one: measured on a real workspace at 0.14.0, the first `run auto --wait-answers 4h --wait-gates 4h` with a notify hook finished its What stage for $1.98 with every declared check green and told the owner *"waiting at a auto gate that did not close by itself — a person signs it"* — no reason, because `evaluateAutoGate` had computed exactly that sentence into a stdout line nobody was watching while `gate.requested` was appended a hundred lines BEFORE the verdict existed; the verdict is now taken one statement earlier and `why`/`held_by` ride the event to the phone (present only for an `auto` policy, since `held_by: []` on a `human` gate would read as "checked, and nothing held it"), the questions that hold a gate are notified BEFORE the gate downstream of them so the owner stops being told to sign a thing before being told what it is, and an `auto` gate whose only blocker was an open question stops permanently degrading into a `human` one — each poll re-runs the seven conditions off disk and signs through the same `approve` door `next` uses, never for `human` and never for `agent`, a person's `approve` or `reject` still landing first; a question can carry its own `Recommended: <letter> — <why> [src: …]`, parsed tolerantly so an older note reads as not recorded rather than refusing; `tldrx facts add --repo <name>` is now checked against `workspace.yml` through the ONE leaf `answer --repo` already refused on, because the unvalidated flag wrote `repos: [ghost]` at exit 0 and every prompt or filter keyed on a real repo name was then silently blind to that fact; the five phase ids are written out in one file instead of three — `PHASE_IDS`, `QUESTION_PHASES`, and an inline literal walked by `questions lint` that `QUESTION_PHASES`' own doc comment claimed could not exist — pinned from both ends, because an identical second copy and a copy that has already drifted redden different guards and neither alone is enough; a training test stops running on bun's fixed 5000 ms after a spawn probe, validated first against a file the heuristic already claimed (87 spawns recorded, so the instrument can see the thing), found it spawning three real children unclaimed by any marker, with the 14 further unclaimed files filed rather than fixed; and `release-check.sh` refuses a rewritten released section — every dated heading whose tag is present must equal `git show vX.Y.Z:CHANGELOG.md` byte for byte, three sections having drifted with nothing checking, and an amendment recorded in `CHANGELOG.amendments` must still contain the tag's section as an ordered subsequence and may only add lines that exist verbatim in its source sha, after a reviewer proved the first version of that check happily passed an invented bullet |
| 0.14.0 | 2026-09-09 | `beta` | an `agent` gate the engine can actually close, and three computations of the same answer cut to one: `gates_policy: agent` named who MAY sign a gate but nothing in the engine produced the evidence note it is signed over — measured on 0.13.1, an owner ran `tldrx run gates set what:agent`, was told "an agent may now close it", and the loop stopped at the next gate anyway with exit 4 — so `run auto` now spawns one bounded **gate signer** when a stage's checks pass under an `agent` policy: the stage's own model and effort, a quarter of its per-agent ceiling, a tool allowance that reads anything and writes exactly one file, and a prompt carrying the stage's declared outputs, the seven `auto` conditions as measured and the §2.8 skeleton `gate template` itself renders — the note going through the UNCHANGED `approve --as-agent` path, so a refusal, a note that does not validate, a signer that wrote nothing and a signer that died are one outcome, pending for a person with the reason named on stdout and now in the `gate.requested` summary, and there is no flag to turn it on because an `agent` policy is already the owner's recorded decision; the turn is recorded like any other (`role: gate-signer`, a `run.yml` task row, a row in `tldrx cost`) and taken BEFORE the stage moves to `awaiting_gate`, because the other order had a person sign the gate the engine was mid-signing, three runs out of three; and the suite stops being run three times per change — the pre-merge reviewer now runs only the test files that cover its diff plus `typecheck`, never the full `bun test`, since the wave re-runs every gate on the MERGED tree anyway, `publish.yml` refuses unless `ci` has a `success` run for the same sha instead of recomputing typecheck/tests/build (~87 min/week of runner time, with a `cancelled` ci run failing by name and the remedy), `ci` cancels a run a newer push has already superseded (25 of 122 push runs began under 10 minutes apart), the docs deploy finally fires on `src/cli/helpText.ts` so a help-registry change stops deploying nothing while the published CLI reference goes stale, and `AGENTS.md` §2 now says out loud that a slash in a branch name is a directory, which is what the review-record gate builds |
| 0.13.1 | 2026-09-08 | `beta` | a stage prompt that opens by saying what to do: every stage prompt now leads with a generated brief — who the reader is, which stage of which run, that the template below is to be FILLED, the exact path of every declared output, and that a question goes in the questions file rather than back to an operator who is not there — because on a real workspace at 0.13.0 a What sub-agent read its 66,452-byte prompt, found no request in it, wrote none of its six declared outputs and asked what to do, $0.29 spent; the brief is generated from the same `outputs:` list `pending.json` records, so it cannot name a path the commit will not look for, and the failure was never a regression — the spliced citation grammar grew the stage section 5,007 B → 13,180 B and the missing instruction was finally outnumbered; and the `N runs are open` nudge, the one imperative-shaped sentence in that agent's window and the one it duly answered, stops reaching sub-agents at all — `spawnAgent` marks every child it spawns and `session-start` emits nothing when it sees the marker, an absent marker still being a human's session and behaving exactly as before |
| 0.13.0 | 2026-09-08 | `beta` | evidence a role expert can actually earn, and a review that leaves a record: `--mode full`'s runs pass mines `tldrx-work/**` while the domain gate judged every citation it produced against folders of code — measured at four role experts, **$9.47 and one evidence row**, and unfixable from the workspace because the single spelling the matcher would reach is the one `domainPaths()` drops — so the gate now treats the run record as in-domain for the file mined FROM it, scoped to the pass and never to the expert's `kind:` (a light file citing a handoff is still out of domain and still says so), two shipped role templates stop declaring `.tldrx/map/**` and `.tldrx/map/{repo}/gotchas.md` paths that matched nothing at all, and a pass that validated, spent money and earned zero rows now prints `the level did not move — $X.XX bought 0 evidence row(s)` with its reasons carried into `check.passed` instead of a silent ledger; `tldrx expert rescore` recovers what was already bought for $0 by re-reading `knowledge/*.md` under today's rules, dating rows by the knowledge file's own `trained_at` and never by the clock, with `rescored_at` additive beside `at` — its ABSENCE keeping the meaning every existing row had — and one `evidence.rescored` line per file it actually moved, so a free re-derivation can never be read as a paid turn; `scripts/merge-wave.sh` refuses a branch carrying no `.review/<branch>.md` with **exit 10**, its own code because `2` in that script is already "merge conflict", a stale record refusing rather than warning and staleness measured as "the code moved" rather than "the sha differs", since committing the record moves the head past exactly the sha it names; and the mutation check moves from the reviewer, whose allowance is `Read`/`Grep`/`Glob`/`Bash(git diff *)` and holds no pen, to the developer's contract that can run it, leaving the reviewer the read it can actually perform |
| 0.12.0 | 2026-09-08 | `beta` | records that can be attributed and spans that were actually measured: the reviewer can be pinned to its own model and effort per role (`reviewer:`) and per story stakes (`reviewer_by_stakes:`, keyed on a story's new optional `stakes:` enum), resolved field by field under `--model`/`--effort` and shipping NO opus default — because there is no evidence yet that a stronger reviewer finds more, only the record that lets the evidence accumulate: every verdict now names the model that produced it, a host review reading `basis: host-declared` off its own flags and a host that declared nothing reading `not recorded` rather than the bundle's suggestion; `run.yml` gains `created_with` and `last_written_by` beside the file format's own `version: 1`, and `agent.spawned`/`agent.result` carry `tldrx_version`, so a run that outlived an upgrade carries both ends of the range that drove it; a task row carries `duration_ms` that never travels without `duration_basis` — `spawned` is the wall clock around the sub-agent's process, `prepare-to-commit` is a ceiling that includes the host's own time — and `tldrx cost` shows a duration per attempt and a per-stage sum that names a mixed basis instead of adding two different quantities, with a pre-existing row reading `not recorded` and never `0s`; no surface prints a bare `$0.00` over work nobody metered — one implementation writes `≥ $12.40 (7 tasks unmetered)` or `not measured: 9 in-session tasks, 0 metered` across `run status`, `budget show`, the dashboard, `replay`, `run auto`, the Build handoff and every notification, and `budget.yml` gains `unmetered_tasks` and `spent_basis`; the surface a story actually changed is measured off its own diff over the range the reviewer was shown and appended as one `story.touches_widened` with `basis: "measured"` beside what was declared, advisory and never rewriting the operator's `touches:`; and a `maintain` skill encodes the maintenance circuit twelve hand-run waves actually measured — reproduce an issue on current `origin/main` before touching anything, a fresh reviewer before `merge-wave.sh` and not after, at most 3 issues and 2 implementers a cycle — pinned by a test that every command and `§N` it cites resolves |
| 0.11.1 | 2026-09-08 | `beta` | operating a run when nobody is watching: the drive mandate now names the host's own context as the costliest instrument and tells the driver what to READ back — a sub-agent's outcome from its `result.json` and the ledger, never its transcript, each sub-agent briefed to report its turn in ten lines, and a cited file re-opened to VERIFY at a gate rather than re-read for a claim already made — paid for inside the unchanged line budgets rather than appended; `.tldrx/workspace.yml` takes one optional `notify:` block whose command is handed a `version: 1` JSON object on stdin at each moment a person is needed (an open question with its options, its recommendation and the literal `tldrx answer` line; a gate with its approve line; a finished or failed run with what its exit code's family means; a budget warning with both numbers), split to argv and never shelled, with a notifier that will not split, is not there, exits non-zero or hangs recorded as `notify.failed` instead of failing the run; `tldrx run auto --wait-answers <duration>` polls the question files and resumes when the answer lands instead of exiting 4 the moment a stage parks, and `--notify-every <duration>` sends a timer-driven heartbeat that reminds rather than reassures while a run is parked; and a new EN+ES guide page walks the whole unattended loop — host mode versus the engine, the payload keys, a dependency-free Node adapter, a first-run checklist and the four ways it silently does nothing — naming no messaging service, by the same reasoning the mandate has always given |
| 0.11.0 | 2026-09-08 | `beta` | governance that leaves a record: every answer says who decided it and what repo it binds, an advisory contradiction check raises a question that never stops a run and states its own limit, the close and the Build handoff count decided vs not-stated; `tldrx story widen` is the sanctioned way to grow a story's surface (a done story needs `reopen --for-fix` first) and a defect no story owns is named in the handoff, the PR body and the boundary card instead of absorbed; a budget grant is a recorded number in `budget.yml` that survives every writer, `budget raise` warns or refuses against it, presets are labelled as the assumptions they are, `triage.budget_basis` says where a figure came from and `tldrx cost --stories` measures each story against the ceiling its spawn was given, honest about lower bounds |
| 0.10.0 | 2026-09-07 | `beta` | the mechanical blockers measured in real runs, fixed: a refused DoD command is recorded as refused (never a fabricated exit 126) in the event, the handoff, the review and retro logs, and the readers that used to recover it as green; the dirty-tree refusal prints the exact stash and pop commands and its true reason; the reviewer diffs the epic as it was before the merge (`epic_base` recorded on the story and the bundle) instead of an empty range; `tldrx init` probes each declared command once and records `command_probes` beside a `commands:` allowlist it never guesses; `tldrx ship` opens a PR whose body describes the change and its known defects, with the handoff folded underneath, and a state refusal that honours settled stories' declared touches; reviewer turns carry their token split and the spend basis reads it, so a whole provider no longer reads as absent |
| 0.9.2 | 2026-09-07 | `beta` | the Build executor decomposed: 4,351 lines became an orchestrator plus eight modules under src/core/build/ (review ledger and phase cost, money caps, the DoD runner with its preflight cache, worktrees and epic-branch claims, the reviewer bundle and review round) — a pure refactor proven byte-for-byte by a golden guard over prompts, ordered events, run.yml rows and exit codes across three scenarios; no behaviour changed, every remaining hardening fix now lands in a file a reviewer can hold |
| 0.9.1 | 2026-09-06 | `beta` | records and money that do not lie: a turn without a provider USD figure is unmetered, never a metered $0.00; a refusal no longer discards the turn's cost (banked first, deduped only against marked rows); an event over the 4096-byte cap spills its text beside the run and names it instead of losing every row of the invocation; preflight rows carry `command_hash` and their own `checked_at`, so a cached red is re-probed when the command changed, after 30 minutes, or under --prepare; the fix list writes back git's canonical 40-hex sha; `tldrx facts add` exists with owner/driver attribution rendered in prompts; run.yml rows carry the provider's token split only when reported |
| 0.9.0 | 2026-09-06 | `beta` | opt-in stack packs: four language pack bodies and thirteen framework overlays detected from manifests, interrogative by default (Defaults yield to any repo signal, Checks are questions with `verify:` hints), behind one per-project switch (`tldrx expert packs enable`) that materialises into `.tldrx/experts/<lang>-stack/` without touching trained knowledge; the Build reviewer gets `## Stack checks (the repo's own conventions win)`; every stage names the project's `.claude/skills` and the developer may invoke them; workspace.yml records overlays with evidence and skills with a tracked flag, `version: 1` unchanged |
| 0.8.0 | 2026-09-04 | `beta` | the unattended mandate learns to keep going: a `## Do not stop` section that defines the one thing allowed to end a run early (a strict blocker, named against the work it does not block), product questions parked as **guided** ones with lettered options and a pre-declared fallback, and a budget stop that asks instead of halting — written against 26 `budget.raised` and 26 `question.answered` events on a real ten-run workspace where the owner had to re-authorise "unattended" mid-run. Plus `tldrx drive --tldr`: a reporting contract for runs nobody will audit — the `run status` block plus three bullets of delta, no operator notes, minimal gate evidence, handoffs trimmed of prose but never of the citations `claim-sources` gates on. The ask channel stays the console and the framework names no chat vendor |
| 0.7.0 | 2026-09-03 | `beta` | Codex as a second honest automated runner: recorded JSONL contract, structured envelopes, role-based sandboxes, token/session provenance, and explicitly unmetered USD accounting; Claude remains the default and the pilot harness. Also absorbs the citation-honesty work previously staged as 0.6.2: a `file` src resolves against the branches the run RECORDED and NAMES the unmerged ref instead of passing in silence or breaking with the temp dir (#140), watcher cards name it the same way (#143), and every run close reports the questions nobody answered (#141) |
| 0.6.1 | 2026-09-03 | `beta` | dogfooding fixes from the first fully-unattended runs: blocked stories never lose uncommitted work (rescue commits + `story.work_rescued`), a fix is only Resolved with a reachable sha, re-entered stages reconstruct their handoff from the ledger instead of degrading it, the Cost header reports the phase and names its lower bound (shared `spendBasis`), feature presets resolve their per-repo maps, Plan sees the command allowlist its gate enforces, the landing sells the unattended flow |
| 0.6.0 | 2026-09-02 | `beta` | the dashboard suite — a "Now" hero strip, `--serve` live refresh, stage durations and gate notes on page and CLI, and a public demo generated from fixtures; honest dual-economy spend (metered + host, lower-bound named); gate provenance — `executed_by` + `authority` so a delegated signature never reads as a personal one, machine-signed reporting fixed; ONE `absent:` semantic shared by claim-sources and the auto gate; superseded stamps when an owner answer flips an earlier phase doc; run close commits its state and `ship` refuses a state-carrying epic; merge-wave gates `docs:build`, survives interruption and self-rewrite; a public-surface drift guard; env.yml validation (unique ids, tool cap) |
| 0.5.0 | 2026-09-02 | `beta` | `tldrx drive` and its own preflight, `watch check` / `watch arm`, `questions cards`, `plan schema`, `retro --all` (with its findings fed back into every reviewer prompt) and `story reopen --for-fix`; `tldrx update` plus a cached newer-version notice; the dashboard reads `budget.yml` and `events.jsonl` — operator notes, reopens and retries, the per-phase budget panel, and a host-attended run metered in tokens against `ceiling_host_tokens`; a rejected review envelope no longer burns a story attempt; `ship` opens one PR per repo; merge-wave lock + ref guard; five golden-transcript evals, one per stage; `CONTRIBUTING.md` and a model-provider contract |
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

**One command: `scripts/release.sh X.Y.Z --tag beta`.** The tag is not optional in practice: omit
`--tag` and the script writes `alpha`, which is no longer this project's status. It is the only
sanctioned path — a Claude Code hook denies hand-made `git tag` / `npm publish`, and `publish.yml`
runs `release-check.sh --ci` (the file checks only) and refuses to publish unless the `ci`
workflow is already green for that exact sha.
Checklist and judgement calls: `docs/RELEASING.md`.

MIT, © 2026 Alan Martinez — a placeholder made while scaffolding; change it freely before anything ships.
