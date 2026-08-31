# 9 — Troubleshooting

Every entry here is a message the tool actually prints, and the move that clears it.

## Install

**`npm i -g tldr-experts` → `E404 Unpublished`.** Every published version was unpublished on
2026-08-29 and there is no `v0.3.0` tag yet, so nothing is on the registry. Clone the repo and
`bun link`, or call `bun <repo>/bin/tldrx.ts <command>`. Cutting the release is
`scripts/release.sh 0.3.0 --tag alpha` — see [`docs/RELEASING.md`](../RELEASING.md).

**`tldrx doctor` exits 1.** A **required** tool is missing or below its `min_version`
(bun ≥ 1.3, node ≥ 20, git ≥ 2.30, claude ≥ 2.0). An optional tool — python3, graphify, gh —
is reported and never fatal. `doctor` prints the exact install command for your OS; the
framework never installs anything itself.

**`tldrx doctor` says `Gitignore shadow: N of 4 probed state paths are IGNORED`.** A rule in
your project's own `.gitignore` is hiding files tldrx expects you to commit — classically a
.NET repo's `[Ll]og/`, which swallows `tldrx-work/<run>/04-build/log/<story>.md`. The line
names the rule as `<file>:<line>:<pattern>`. Re-run `tldrx init`: its managed block re-includes
`tldrx-work/**` and `.tldrx/**`. If the rule lives somewhere `init` does not write — a nested
`.gitignore`, `.git/info/exclude`, your global excludesfile — delete or narrow it there.

**`<file>: schema_version is deprecated — say version: 1`.** The pre-spec spelling. The file
still loads for one more release, the warning is printed once per process, and `tldrx doctor`
lists every file still on the old key. Change `schema_version: 0` to `version: 1`.

## "Nothing happens" / "there is no run"

**`tldrx next` exits 3 with a report above it.** There is no open run. The report is
`tldrx status` — it lists everything on disk that is waiting on you. Open work with
`tldrx run new <slug> --scope <s>`, or answer what it names.

**`tldrx status` exits 3.** There is no `.tldrx/` at or above the cwd. Run `tldrx init`, or
pass `--root <path>`.

**A fresh `tldrx status` lists experts you did not ask about.** They are under `Also:`, not
numbered, and not counted in `pending` — an untrained expert degrades a stage's output, it
does not block one. `tldrx expert list` shows them all; training one is
[4 — Experts](04-experts.md).

## Ambiguity and locks

**`tldrx <cmd>: N runs are open — pass one:`, exit 2.** That means "you left off the id", not
"it broke". Pass a positional `<run>` on `next`, `run status`, `run estimate`, `run auto`,
`run unlock`, `run cancel`, `cost`, `replay` and `retro`; `--run <id>` on the rest.
`tldrx run status` with several open lists them and exits `0` — that is the screen to read.

**`stage is running (pid N) — wait, or `tldrx run unlock <id>` if it died`.** A live lock. If
the pid really is gone (or was recycled by an unrelated process), `tldrx run unlock` removes
the lock and demotes the stage back to `ready`. A genuinely live holder needs `--force` — "the
pid was recycled" and "a colleague is running the stage right now" look identical from here,
and only one of them is safe.

**`a --prepare bundle is waiting`, exit 2.** A stage was left `running` by a `--prepare`
nobody committed. `--prepare` releases the lock on purpose, because the host session runs the
prompt. Three ways out, and the message names all three: run the prompt and
`tldrx next --commit <id>`; `tldrx reject --run <id> --note …` to discard it; or
`tldrx next --discard-pending` to bin the bundle and run the stage again. Re-spawning without
one of those would throw away a sub-agent turn the run has already paid for.

**`tldrx run unlock` says there is no lock.** Then the lock was not the problem. The message
points at the real state — usually an uncommitted `--prepare` bundle, which is not a lock.

**A run you have given up on keeps making every id-less command ambiguous.**
`tldrx run cancel <id> --note "<why>"`. `cancelled` is terminal, so `tldrx status` and every
id-less command stop seeing it, and nothing is deleted.

## Gates and citations

**`N unsourced bullet(s)`.** Every bullet under Findings / Decisions / Unknowns / Evidence
ledger must end in a `[src: …]` token, and each of those four sections must hold at least one
list item — a genuinely empty one is written `- none [src: absent:<what you looked at>]`, and
a prose-only section is refused.

**`malformed citation on line N`** is a different message and needs different advice: the line
*tried* to cite and the token could not be parsed. A token wrapped in backticks or brackets,
or followed by a full stop, is fine; words after the `]` are not.

**A citation resolves to nothing.** `F<n>` must be a live (non-retired) row in `facts.yml`,
`Q<n>` a question this run actually asked, `graph:<node>` a node in the graph or a token named
in `.tldrx/map/`, and `absent:` may only source a **negative** claim. `tldrx map --check`
re-resolves every citation in the map and the init handoff.

**An auto gate did not close and the note says `unverified`.** Something could not be checked
offline: an https doc nothing in the workspace names, an `absent:` over a file that exists, a
`cmd` with no `workspace.yml` commands to check against. It never fails a stage; it stops the
auto gate and hands the decision to you.

**An auto gate signed something it should not have.**
`tldrx reject --stage <phase>/<stage> --note "…"`. The stage goes back to `ready` with your
note, the cursor follows it, and later stages that had run are marked `stale` — their files
stay on disk and stop counting as current.

**Everything downstream says "0 open questions" but the stage clearly asked some.** The
`questions.md` grammar is a parser's, not a style: a heading that misses `## Qn · Title` is
read as ABSENT, not as half-read. `tldrx questions lint` names every block the parser cannot
see and exits `2`; `tldrx questions lint --fix` converts the prose form
(`### Qn — …` / `**Answer:**`) into the grammar **without changing a word**. `tldrx next
--commit` refuses such a file with exit `5`.

## Money

**`tldrx next` exits 2 with a `tldrx budget raise …` command in the message.** The cursor
phase cannot afford the stage's estimate. The command in the message already has the shortfall
computed and rounded up to the cent. `--take-from <phase>` moves the money instead of raising
the run's total.

**A `--max-usd` was passed and far more was spent.** `--max-budget-usd` is a **stop after the
current turn, not a hard cap** — measured: a `--max-usd 1.5` training call was killed *after*
`total_cost_usd: 5.15325` on a single 597-second turn. Size the prompt for the money you are
willing to lose. The lever that acts before the money is `--effort`; the brake that acts
during it is `--max-reads`.

**`tldrx expert train` exits 2 before spawning.** The ceiling is below the **$0.25 floor**. A
cold `claude -p` pays 10–26k cache-creation tokens before its first reply, so a ceiling under
the floor buys a failed spawn, not a saving. (Or: `--mode light` on a role expert, which is
refused rather than paid for.)

**`budget show` says `spent` is a lower bound / a task reads `unmetered (in-session)`.** An
in-session `--commit` sub-agent was billed to the host session and has no meter of its own.
Declare it with `tldrx next --commit --cost-usd <n>` when you know it. `$0.00` would be a
measurement, and a false one — never guess a number to make the report look tidy.

**A stage cost more than `tldrx run estimate` said.** `estimate` is the one command that
guesses and says so: the input half is measured bytes; cache write, cache read and output are
medians of past attempts at that stage id (or, failing that, at any stage — it names which);
and prices plus the cache multipliers are a dated `[assumption]`. `tldrx cost` is the measured
answer. If the gap is several-fold, read the breakdown line: before 2026-08-30 cache traffic
was not priced at all, which made a $1.70 stage estimate at $0.33.

## Stages and prompts

**Exit 2, "the prompt is N bytes and prompt_max_bytes is M".** The refusal lands *before* a
cent is spent, and it names the biggest sections and the key that shrinks each: lower
`inputs_max_bytes`, lower `knowledge_max_bytes`, narrow the stage's `experts:` list, or raise
`prompt_max_bytes` deliberately. `tldrx next --prepare` prints the same ledger without
spawning.

**Exit 2, "refusing to dispatch <phase>/<stage> — precondition `<id>` is red".** The stage
declared a `preconditions:` entry and the command came back with the wrong exit code. Nothing
was written and nothing was spawned: fix the environment (start the daemon, install the SDK)
and run the same command again. `--prepare` is refused the same way — a bundle written for a
host whose Docker is down is the same wasted attempt as a spawn into one. `--commit` never
re-checks: it settles a turn that already happened.

**A `preconditions:` command is refused when the stage LOADS.** Same rule as `dod` below: only
a command **byte-equal** to one in `.tldrx/workspace.yml` runs, argv-split with no shell. The
refusal is at load rather than at run time, so a stage naming an undeclared command cannot open
a run at all.

**A declared input was truncated.** `inputs_max_bytes` ran out. The message names the file and
its size. Either raise the key or split the seed with `tldrx seed triage`.

**`stopped after N reads: the stage's max_reads is <cap>`.** The read cap bit. Raise
`max_reads` in the stage file, or `--max-reads <n>` for one run. A stopped stage is a FAILED
stage — it did not finish — so `tldrx next` again retries it.

**`expert <name> — NOT LOADED: no .tldrx/experts/<name>/ in this workspace`.** A stage names an
expert that does not exist. `tldrx expert create <name> …`, or fix the name. If the name is
`domain` or `stack` you get one note instead: those were never expert names — they are the
`stack_experts` and domain-match rules, and they load by rule, not by name.

**`tldrx expert list` warns that a stored level disagrees with the computed one.**
`tldrx expert recompute <name>`. It happens when a human pasted a `--print-prompt` prompt into
their own session: only the headless / `--commit` path ever wrote a level.

**An expert trained on a lot of files still shows 3 stars.** No `kind: run` evidence row: the
run cap is `min(level, 3)` for an area where nothing was ever executed. Where `workspace.yml`
declares no command there is no `Bash` grant at all, and 3 is the honest ceiling in that
workspace. See [4 — Experts](04-experts.md#how-a-level-is-computed).

**`warning: <expert>/<area>: N evidence row(s) ignored — unknown kind '<x>'`.** The five kinds
are `code` `run` `test` `doc` `answer`. The warning goes to stderr, so it survives `--json` and
a redirect.

**`execution claim needs a '$ <cmd> → exit <n>' src, not a file line`.** A bullet asserting a
result — "exit 0", "78/78 passed", "the build is green" — cited a file rather than the command.
Citing the line of `workspace.yml` that *declares* the command is not evidence anything ran.
Cite the run: `[src: $ dotnet build → exit 0]`.

**A knowledge bullet was accepted but earned no evidence.** One of three warnings fired:
`paraphrase` (the bullet is ≥ 90% a verbatim substring of the ±3 lines around what it cites),
`outside domain` (the path is outside this expert's `## Domain` — the warning names the expert
that does own it; train that one), or `duplicate src` (this expert already has that source on
record, in any area). Bullets under `## Sources` earn nothing by design. See
[4 — Experts](04-experts.md#what-earns-a-place-on-a-knowledge-file).

**`warning: shared citation <file:line> by <a>,<b> — check for contradiction`.** Two experts
cite the same line with bullets that say different things. It resolves nothing on purpose —
deciding which expert is right is not something a deterministic tool can do. Read both and fix
the one that is wrong.

**Levels changed after upgrading and nobody trained anything.** Expected: the ladder's fifth
threshold moved 12 → 20, the run cap was added, the 180-day staleness cap was replaced by
continuous decay, and cross-file findings now weigh double. `tldrx expert recompute` writes the
new numbers; `tldrx expert list` warns until you do.

## Build

**A story is blocked with a red DoD or a merge conflict.** The wave carries on and the story is
blocked with its evidence recorded (the failing command and its exit code, or the conflicting
paths, with the merge aborted). Fix it and re-run the stage.

**A story sits at `review` and the log says the reviewer FAILED.** That is not a request for
changes — the reviewer never returned a verdict at all (a spawn error, a timeout, or its
`--max-budget-usd` running out mid-read). The story's diff is already committed and merged,
its DoD went green, and the only thing missing is the review. So the attempt counter is NOT
spent, and the next `tldrx next` (or `tldrx next --prepare`) re-runs **only the review** —
never a second developer turn. If it keeps dying at the same ceiling, the reviewer is too
poor for the diff: price the story higher in `03-plan/budget.yml`, or raise the stage with
`tldrx budget raise 04-build <n>`.

**A story went back to `todo` (or `review`) and the log says the DEVELOPER failed.** Same
shape, other half of the pipeline: the developer sub-agent never delivered — a spawn error, a
timeout, or `--max-budget-usd` running out before it wrote anything. A turn that never ran is
not an attempt, so the story is put back exactly where it was, its attempt number unspent and
its worktree kept, and the next `tldrx next` (or `tldrx next --prepare`) offers it again as a
fresh developer run at the SAME attempt number. Before 2026-08-30 it was recorded as
`blocked`, which is terminal in-run: one errored spawn ended the story. If it keeps dying at
the same ceiling, price the story higher in `03-plan/budget.yml` or raise the stage with
`tldrx budget raise 04-build <n>`. A developer that RAN and produced work its DoD faulted is
a different thing and still blocks.

**A run from before 2026-08-30 has stories `blocked` that never really ran.** They are picked
back up automatically: a `blocked` story whose last attempt recorded no commit, no check and
no reviewer is read as the errored spawn it was, and `tldrx next` says
`S2 was blocked by a developer that FAILED (…) — that was never an attempt, so it is offered
again`. A story blocked by a red DoD, a merge conflict or two `changes` verdicts is left
exactly where it is.

**`auto gate not taken — stories=1 of 7 done — S2:blocked, …`.** A Build stage does not sign
its own gate while any story is unfinished. Approve it yourself if half the epic is what you
mean to ship (`tldrx approve --note "…"`), or fix the stories and run the stage again.

**`refused: an epic/<slug> branch exists that this run did not cut`, exit 2.** The epic branch
keeps its plain name on purpose — it is the unit a team merges — so instead of making collision
impossible, adopting one is made deliberate: `tldrx next --reuse-epic`.

**The build stage refuses before cutting anything.** The repo is dirty. Commit or stash first.

**A `dod` command is refused.** Only a command **byte-equal** to one in
`.tldrx/workspace.yml` runs at all, argv-split with no shell. This hook executes strings a
model wrote, as you, so the allowlist is the whole control: an empty `commands:` permits
nothing, and a command needing a shell must be declared as exactly that
(`sh -c "…"`), not shelled on its behalf.

## Other

**`tldrx replay` says a line was skipped.** `events.jsonl` is appended line by line, so a
process killed mid-write leaves half an object on the last line. The reader skips it, counts
it, and says `1 line skipped (unparseable — a torn write)` — the other four hundred lines are
still read.

**The dashboard returns 403.** The request's `Host` was not `127.0.0.1`, `localhost`, `::1` or
the host it was told to bind. Only the name is compared, never the port, so `ssh -L` and
container port maps keep working.

**Ctrl-C left something behind.** It should not: SIGINT/SIGTERM kill the sub-agent's whole
process tree, record a partial `agent.result` with `cost_usd: null` and
`stopped_by: "signal"`, demote the stage to `ready`, release the `.lock`, restore the cursor
and exit `130`. If a `--prepare` bundle was on disk and nothing had been spawned, the stage is
deliberately left `running` and the message points at `tldrx next --commit`.

**`bun dist/tldrx.js` and `node dist/tldrx.js` disagree about a character.** Fixed:
`scripts/build.ts` strips the `// @bun` marker from every emitted file, and a test runs the
built bundle under both runtimes and compares bytes. If you see it again, you are on a stale
`dist/` — `bun run build`.
