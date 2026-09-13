verdict: merge
reviewed-by: three passes by separate sonnet reviewer sub-agents (none wrote the code) — at 3149145, at the tightened f8cb142, and at this final narrowed 87fc9c1
against: 87fc9c1

## What ships

When a developer is refused a command the workspace never declared, the recorded reason
now names the OPERATOR's cure: add a `commands:` slot whose value is exactly `<tool
subcommand>`. That information existed at the moment of failure and was thrown away.

The field case this comes from (the peer session's measurement of its own run, not mine):
four developers died and two reviews ran over about three hours on a story that was
undoable from minute one. The fourth developer wrote *"dotnet ef is not grantable… No
code changes made this round"* — it knew, said so in plain words, and the system paid for
a fifth. This turns those four into one.

## What was REMOVED before merging, and why that is the point of this record

The branch also carried a Plan-time reader that warned when acceptance-criteria PROSE
named an undeclared command. It was measured twice, in opposite directions:

- Loose (`3149145`): ordinary backticked phrases — `user profile`, `retry later`,
  `clear cache` — produced warnings. The first reviewer called this a quality finding;
  I made it blocking, because a warning that fires on ordinary phrasing trains the
  operator to ignore it, and then it is worth less than nothing.
- Tightened (`f8cb142`): the second reviewer ran both revisions and found the tightening
  had silenced **the issue's own motivating case** — `dotnet ef migrations add Tenancy`
  in the workspace the issue itself describes — while a false fire survived from the
  other side (`dotnet handles retries` where `dotnet build` is declared).

When one adjustment breaks the half the opposite adjustment fixes, the problem is usually
the question and not the dial. So the prose reader came out (`plan/validatePlan.ts`,
`plan/index.ts`, `run/checks.ts` and `docs/spec.md` are byte-identical to `ba43abe` —
verified by diff, not by claim) and the open question was filed as **#290** carrying both
measurements VERBATIM plus three untried directions, so the next attempt starts past our
two turns instead of repeating them.

My own part in that: I pushed the tightening without seeing where it led. The
implementer's words for it are worth keeping — *"I had been adjusting the dial instead of
questioning the reading."*

## Measured on the final tree

- **The cure is exact and never a guess**, all three cases run by the reviewer rather
  than read: `dotnet ef migrations add Tenancy` → slot `dotnet ef`; `sha256sum s1.txt` →
  slot `sha256sum`, never the story's filename; `git status` → classified `verb`, never
  blamed on `commands:`, because git verbs come from `DEVELOPER_GIT_VERBS` and sending an
  operator to add a `commands:` slot for git would be a confident wrong instruction.
- **#278's sentences are byte-identical where nothing is declared** (§12): the retry-path
  call site passes no `declared` and classifies exactly as it did.
- **`undeclared` is structurally unreachable from #278's retry** — confirmed again on this
  tree. A kind that could enter the retry path would pay a turn for a story that can never
  work, which is this issue's own failure made worse.
- **One implementation** (§7): `grantsCommand`/`slotForCommand` live only in
  `developerGrants.ts`, beside `DEVELOPER_GIT_VERBS`.
- **Mutations**: forcing the new kind to `unknown` reddens 7; stripping the cure reddens 8
  across the executor's records. Tree clean after both.
- **Patch is correct**: nothing changes a command's, schema's or hook's behaviour — a
  refusal blocks identically and only its recorded reason gained content. The bullet moved
  from `### Added` to `### Fixed` when the scope narrowed, matching #278, the same
  mechanism. `## 0.19.0` byte-identical; no README release-table row.
- No golden moved; EN and ES carry only the new paragraphs, with no half-sentence left
  behind by the removed warning.

## Also corrected on the record

The implementer's first report gave mutation counts (4 and 1) measured against an earlier
test file; the reviewer measured 5 and 7, and the implementer re-measured and corrected
itself rather than defending the numbers. The counts in this record are the final ones.

## Not verified

Nothing here was exercised on a live `tldrx run auto`; the evidence is the suite and the
peer session's field measurements, cited as theirs.
