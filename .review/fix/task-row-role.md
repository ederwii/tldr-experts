verdict: merge
reviewed-by: Claude Sonnet 5 (fresh reviewer, re-review after rebase)
against: d432d70

Content (tasks[].role, validator, spec row, golden fixtures) was reviewed in full against
1c9e594 and verdict was merge: golden verified by parsing all 4 files, additivity proven by
stripping every `role:` from a real run.yml and re-validating, one derivation confirmed, red
proven by reverting the non-test diff. That verdict stands unchanged; this pass covers only
the rebase delta.

Rebase delta: `git range-diff 1c9e594...d432d70` shows the fix commit itself is untouched —
the only change is where the CHANGELOG hunk lands, because #236 landed on main first and
already owns the `### Fixed` header this branch used to add. Every non-overlapping file
(build.ts, executors/index.ts, runNext.ts, emitRunYaml.ts, build-executor.test.ts, all four
golden fixtures) diffs byte-identical to its pre-rebase form.

Auto-merge audit (the actual risk: #234 and #236 both touch RunFile.ts, docs/spec.md, and
CHANGELOG.md — three files, not two; found by diffing each branch's file list against the
shared base c0f5f9f rather than trusting the stated pair):

- RunFile.ts: disjoint edits — #234 adds `RunTask.role` + validator check around line
  171-190/900-906; #236's `RunBudgetMirror` doc comment sits at line 331+. `git diff
  origin/main...d432d70 -- src/core/run/RunFile.ts` shows exactly #234's hunks and nothing
  from #236, confirming #236's content already on origin/main is untouched and both coexist.
- docs/spec.md: clean coexistence — #236's `budget.{ceiling_usd,...}` row (line 198) intact;
  #234's `tasks[].expert`/`tasks[].role` rows (214-215) added cleanly; the shared validation
  summary sentence (line 229) merged both branches' additive-key lists (`banked_before_refusal`,
  `dedupe` from #236's era, `role` from #234) into one sentence, not two, no orphan half-edit.
- CHANGELOG.md: `## 0.16.2 — unreleased` has exactly one `### Added` (#243) and one `### Fixed`
  (#236 then #234, 2 bullets) — verified by parsing headings with awk, not by eye. No conflict
  markers anywhere in the tree (grepped CHANGELOG.md, docs/spec.md, RunFile.ts).

Golden fixtures: `test/fixtures/build/golden/*-run-tasks.txt` diff (origin/main...d432d70)
identical to the pre-rebase diff — #236 never touches goldens, confirmed rather than assumed.

Ran (no pipes, exit codes read directly): `bun run typecheck` → 0; `bun test
test/build-executor.test.ts` → 134 pass / 0 fail, exit 0; `bun test test/build-golden.test.ts`
→ 4 pass / 0 fail, exit 0; `bun test test/resumability.test.ts` → 45 pass / 0 fail, exit 0.
