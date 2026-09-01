# Contributing to tldr-experts

Alpha-to-beta software, one maintainer, and a test suite that is the only reason any of it can
be changed quickly. Everything below is downstream of one rule:

> **A claim nobody ran the check for is a guess.** Every gate here exists so a pull request
> carries evidence rather than confidence.

- [Getting set up](#getting-set-up)
- [The loop a change goes through](#the-loop-a-change-goes-through)
- [Tests: red first, and a test that can fail](#tests-red-first-and-a-test-that-can-fail)
- [The gates, and what CI actually runs](#the-gates-and-what-ci-actually-runs)
- [Conventions worth knowing before you write code](#conventions-worth-knowing-before-you-write-code)
- [Contributing a model-provider config](#contributing-a-model-provider-config)
- [Filing an issue](#filing-an-issue)

## Getting set up

```bash
git clone https://github.com/<you>/tldr-experts && cd tldr-experts
bun install                 # bun >= 1.3.0; the package also RUNS on node >= 20
bun run typecheck           # tsc --noEmit
bun test                    # the whole suite
bun run build               # bundles bin/ + src/hooks/ into dist/
bun bin/tldrx.ts --help     # run the CLI from source, no install
```

Never `npm link` or install the package globally to try a change — run `bun bin/tldrx.ts …`
from the checkout. A globally installed copy is a second version of the code that will
disagree with your working tree at the worst possible moment.

## The loop a change goes through

1. **Open an issue first** for anything bigger than a typo, or comment on the one you are
   taking. Scope gets decided in the issue, not in review.
2. **Fork, then branch off `main`.** One branch per issue; the branch name is yours.
3. **Write the failing test first** (below), then the code.
4. **Run the gates** — all four, without pipes, reading exit codes (below).
5. **Update the docs in the same commit.** `CHANGELOG.md` under `## <next> — unreleased`,
   the relevant page in `docs/guide/`, `docs/spec.md` when a schema or a command changes,
   and `README.md`'s tables when a release moves. A change that lands without its docs is a
   change the next person cannot find.
6. **Open the PR against `main`**, and say in the body what you measured: the before/after
   test counts, the commands you ran, and the exit codes. Link the issue.
7. CI runs on the PR. Green CI with **zero checks listed is not green** — check the list is
   non-empty before believing it.

Maintainers merge internal wave branches with `scripts/merge-wave.sh`, which takes a lock on
the shared checkout and re-runs every gate before pushing. That script is for the maintainer's
own multi-agent workflow; a fork's PR does not use it, and you do not need it.

Releases are `scripts/release.sh X.Y.Z --tag <alpha|beta|stable>` and nothing else — a
PreToolUse hook denies hand-made `git tag` and `npm publish`. See `docs/RELEASING.md`.

## Tests: red first, and a test that can fail

`test/*.test.ts`, one file per behaviour, `bun:test`. Shared fixtures live in
`test/fixtures/` (`test/fixtures/build/workspace.ts` builds a real git repo with a fake
`claude` on `PATH`; `test/fixtures/machineLoad.ts` scales timeouts with measured load rather
than pinning a millisecond count).

Three rules, and every one of them is a finding class this project's own retros keep
producing — run `tldrx retro --all` in a workspace to see them ranked:

- **Write the test before the code and watch it fail.** Paste the failure into the PR. A
  test written after the code passes for reasons nobody checked.
- **A test that cannot fail is worse than no test.** If the assertion would still pass with
  the implementation line deleted, it is measuring the test. `test/model-provider.test.ts`
  is the shape to copy: it points `TLDRX_CLAUDE_BIN` at a real script and asserts the script
  RAN, because reading `claudeBin()` back would have passed with the spawn still hardcoded.
- **Assert the negative too.** A feature that adds a section to a prompt needs a test that
  the section is absent when it should be — presence alone cannot catch a section that is
  always there.

Fixtures should be the shapes the code really produces. Where a test needs a review log or a
fix list, render it the way `src/core/build/review.ts` and `src/core/build/fixlist.ts` do; a
classifier tested against invented text is tested against itself.

## The gates, and what CI actually runs

`.github/workflows/ci.yml` runs, on every push to `main` and every pull request:

```bash
bun install --frozen-lockfile
bun run typecheck                                   # must exit 0
bun test                                            # must exit 0
bun run build                                       # must exit 0 — it is not conditional
```

Locally, run the same four things plus the seam invariant, each on its own line so no pipe
can eat an exit code:

```bash
bun run typecheck; echo "tc=$?"
bun test;          echo "test=$?"
bun run build;     echo "build=$?"
grep -rn 'Bun\.' src | grep -v src/core/runtime/    # must print NOTHING
```

That last one is the Bun/Node seam: the package is built with Bun and must **run** on Node,
so every host capability that differs between the two — spawn, stdin, file IO, YAML — lives
behind `src/core/runtime/`. A `Bun.` anywhere else is a runtime crash for half the users.

`bun run build` is deliberately unconditional in CI: it once swallowed its own exit code
behind an `if`, and a red build passed.

## Conventions worth knowing before you write code

- **One exported concept per file**, named after it. Commands live in
  `src/cli/commands/<name>.ts`; the flag registry (help text, exit codes, whether `--json` is
  legal) is `src/cli/helpText.ts` and is the single source of truth for both.
- **A refusal is a feature.** Bad input gets a message naming the file, the field and what
  is wrong with it, on stderr, with the documented exit code — never a stack trace, never a
  silent fallback. Exit codes are in `src/cli/exitCodes.ts`.
- **Absence is not an error.** A missing optional file means "nothing to add", not a failure.
- **Comments say why, not what**, and a comment that no longer describes the code beside it
  is a defect in its own right.
- **Every claim in an artefact carries `[src: <path>:<line>]`.** That grammar is the spine of
  the whole framework; if you produce output that asserts something about a repo, cite it.
- **Data files open with `version: 1`** and grow rather than change meaning.

## Contributing a model-provider config

**Status: [#27](https://github.com/ederwii/tldr-experts/issues/27) is closed as parked, not
rejected.** The full provider layer waits for real demand for a second model provider — but
the seam is described here precisely enough to build against, and a credible PR is the demand.
Open an issue referencing #27 before you start, so scope is agreed once rather than in review.

### What exists today

One environment variable, shipped in `5e0f845`:

- **`TLDRX_CLAUDE_BIN`** replaces the executable **name** that a sub-agent spawn runs.
  Default `claude`, taken off `PATH`. Blank or whitespace counts as unset. Read on every call
  rather than captured at import, so a late `export` and a test that sets it are both obeyed
  — `claudeBin()`, `src/core/facilitator/spawnAgent.ts:37-56`.
- Honoured everywhere the CLI is spawned: `spawnAgent` (`spawnAgent.ts:201`), the `--dry-run`
  command line via `describeSpawn` (`spawnAgent.ts:173`), and `claude mcp list` in
  `src/core/doctor/McpProbe.ts:52`.
- **`tldrx doctor` is deliberately not covered.** It checks `claude --version` because
  `env.yml` declares that string, and rewriting a manifest command is the provider layer's
  job, not this variable's.
- Tests: `test/model-provider.test.ts`.

**What it does not buy.** The argv is still Claude Code's argv, so whatever the variable
points at has to speak it. It buys a pinned install, a wrapper that adds a proxy or
credentials, and a stub in a sandbox. It buys nothing toward a stage targeting a genuinely
different provider: no per-stage provider selection, no argv translation, no capability
negotiation, no envelope adapter.

### The seam you would build against

Everything a provider has to satisfy is in **two files**, and both were written from one real,
measured `claude` call rather than from documentation:

**1. The spawn — `src/core/facilitator/spawnAgent.ts`.** `buildClaudeArgs()`
(`spawnAgent.ts:142`) is the entire command surface. Today it emits, in this order:

```
-p --output-format stream-json --verbose
[--model <m>] [--effort <low|medium|high|xhigh|max>]
--max-budget-usd <n.nn>
--json-schema <json>
--allowedTools <Read,Write,Edit,Glob,Grep,Bash(<cmd>),…>
[--dangerously-skip-permissions]
```

The prompt goes in on **stdin**, not argv — a stage prompt is tens of kilobytes. Two measured
facts constrain any replacement: `--verbose` is mandatory alongside `stream-json` in print
mode (without it the CLI refuses before spending anything), and `--json-schema` coexists with
`stream-json` (the final `result` event carries `structured_output` exactly as the
single-blob format did).

**2. The transcript — `src/core/facilitator/agentEvents.ts`.** `AgentStream.push(line)` turns
each JSONL line into the typed `AgentEvent` union the rest of the framework reacts to:
`start`, `tool`, `tool-done`, `text`, `question`, `cost`, `done`, `error`. Only these fields
are read: `type`, `subtype`, `message.content[].type`, `tool_use.id`,
`tool_result.tool_use_id`, `timestamp`, `structured_output`, `total_cost_usd`, `usage`,
`is_error`, `session_id`, `result`, `errors`. A line that does not parse, or a shape nobody
recognises, is **dropped** — the stream is a progress view and may never be the reason a
stage fails.

Two behaviours downstream depend on the event stream being real, and are the ones an adapter
most easily breaks: the **read cap** (`src/core/facilitator/readCap.ts`) counts completed
`Read`/`Grep`/`Glob` events and aborts the child at the ceiling, and the **cost ledger**
(`usage` and `total_cost_usd`) is what every budget in the framework is enforced against. An
adapter that reports no usage silently disables the budget.

A working reference implementation of the emitting side already ships:
`src/core/facilitator/fakeTranscript.ts` (`claudeOutput()`, `toolPairLines()`), used by the
four test fakes and by `tldrx learn`'s sandbox agent. It sits beside `agentEvents.ts`
on purpose — writer and reader are a matched pair, and drift between them is the only bug
either can have.

### What a generic provider config would need

A credible PR would supply, at minimum:

1. **A command template.** Where a provider is declared (`env.yml` is the existing manifest;
   a per-workspace override is a design question, not a settled one), plus how a stage
   selects one. It must express: the binary, a fixed argv prefix, and how the framework's
   own parameters — model, effort, budget ceiling, tool allowance, output schema — map onto
   that provider's flags, including the case where a provider has **no** equivalent. A budget
   ceiling that silently becomes a no-op is worse than a refusal to run.
2. **A transcript adapter.** Provider stdout → `AgentEvent[]`, satisfying the same contract
   `AgentStream` does: unknown shapes dropped, never thrown; `tool`/`tool-done` paired so the
   read cap can count; `cost` carrying real usage or explicitly declaring it unavailable, so
   the budget can refuse rather than pretend.
3. **A result envelope.** The framework parses `structured_output` against
   `ENVELOPE_SCHEMA` (`src/core/facilitator/envelope.ts`) and, for reviews,
   `REVIEW_SCHEMA` (`src/core/build/prompts.ts`). A provider without native structured output
   needs a documented, fail-CLOSED extraction: an envelope that cannot be read is a failure,
   never a permissive default. Note that `parseReview` already treats an unreadable verdict as
   `changes`, never `approve` — hold that line.
4. **`tldrx doctor` coverage.** `env.yml` declares the version-probe command; a second
   provider needs its own, or a stated reason it has none.
5. **Tests**, in `test/` next to the existing ones:
   - `test/model-provider.test.ts` — extend it. It already proves an override reaches the
     real spawn; the same standard applies to a provider config.
   - `test/agent-stream.test.ts` — the transcript contract. Add your adapter's fixtures here.
   - `test/agent-gate.test.ts`, `test/money-safety.test.ts` — the read cap and the budget,
     the two things an adapter can silently disable.
   - A fake for your provider modelled on `test/fixtures/build/fakeClaude.ts`, emitting
     through a sibling of `fakeTranscript.ts` so writer and reader stay a matched pair.

Keep the default path byte-identical. A workspace that names no provider must produce exactly
the argv and exactly the behaviour it produces today; that is the property to assert first,
and the one a reviewer will look for.

## Filing an issue

Say what you measured. A bug report that carries the command, its exit code, the output and
the version (`tldrx version`) is a bug that gets fixed; one that carries an impression is a
conversation. If you found it through `tldrx doctor`, paste that too.

MIT, © 2026 Alan Martinez.
