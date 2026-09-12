verdict: merge
reviewed-by: Claude Sonnet 5 (fresh pre-merge reviewer)
against: 76feca7

## Scope

Diff `origin/main...76feca7`: `src/core/notify/notifications.ts` (`gateHolding`,
`clearingCommand` now switches on it, `holding`/`continue_command`/`continue_note` added to
`gate.requested`), `src/core/run/decisionCards.ts` (`continueCommand`), `src/core/run/runOutcome.ts`
(`continueNote`), tests, docs, CHANGELOG.

## Findings, against the six concrete risks asked for

1. **Invented note (Important risk, not found).** `continueNote` returns `null` (key omitted,
   never `""`/`null` value) whenever `firstBlocked === null` or `firstBlocked.reason ===
   REASON_NOT_RECORDED` (`runOutcome.ts:223-227`). Tested directly: "unfinished but nothing
   BLOCKED" and "blocked story with no recorded reason" both assert `continue_command` absent
   (`test/gate-notification-command.test.ts`). CONFIRMED — ran the file, both cases pass and
   assert `not.toHaveProperty`, not just a truthy check.
2. **Partial presence.** Both keys are added by one spread: `...(note === null ? {} : {
   continue_command: ..., continue_note: note })` (`notifications.ts:326`) — mechanically
   atomic, no path can emit one without the other. CONFIRMED by reading the code; no test
   constructs the pathological case, but the code shape makes it structurally unreachable.
3. **Quoting/injection.** `continueCommand` never interpolates the handoff's free text into the
   command string — the command always carries the literal, unsubstituted placeholder `"…"`
   (`decisionCards.ts:281`), identical to the pre-existing `answerCommand` convention. The real
   reason text only ever appears in the separate `continue_note` field, which nothing in this
   repo splices into a shell string. PLAUSIBLE risk, out of this diff's control: an out-of-repo
   adapter that naively does `continue_command.replace("…", continue_note)` and execs the result
   would be newly exposed to the AGENTS.md §12 trap (a `"` in the handoff reason breaks the
   quoting, a backtick/`$(...)` survives double quotes) — no test in this repo builds or executes
   that substitution, so it can't be run here, and it is exactly the same shape of risk the
   existing `blocked_reason` field already carries unescaped. Flagging as a **doc gap**, not a
   blocking defect: the docs (`docs/spec.md`, `unattended-operation.md`) should say explicitly
   that a consumer substituting `continue_note` into `continue_command`'s hole must shell-quote
   it, the same way they'd already need to for a human-typed `--note`.
4. **Single derivation (§7).** `clearingCommand` now `switch`es on `gateHolding(...)` instead of
   re-deriving the questions/stories/none branch inline — read at
   `notifications.ts:183-193` vs `notifications.ts:203-208`. One derivation, not two. CONFIRMED
   by reading.
5. **`--stage` never in `continue_command`.** `continueCommand` is a fixed template with no
   `--stage` token anywhere, and `reject.ts:51-57` independently refuses `--and-continue` +
   `--stage` regardless. CONFIRMED (test "the continue command carries the substitutable
   placeholder, not prose" asserts `.not.toContain("--stage")`, plus read of `reject.ts`).
6. **Absent-with-reason.** Verified serialization mechanics, not just the TS type: `holding` is
   always a plain key (no conditional), and `continue_command`/`continue_note` are added via
   object-spread of `{}` vs a two-key object — spreading `{}` adds no key at all, so the JSON/YAML
   emitted genuinely omits the key rather than writing `null`. Same pattern already used for
   `held_by`/`signer_held`/`gateStoriesPayload` elsewhere in the same function. CONFIRMED by
   reading the spread and by the passing "keys are ABSENT, not empty" test
   (`Object.keys(payload.detail)).not.toContain("continue_command")`).

## Test discipline (§8)

- One assertion (`expect(payload.detail.continue_note).toBe(continueNote(view))`) compares
  production output to the same function's own output — a guard, not a proof by itself — but it
  is immediately followed by two independent `toContain("S6")` / `toContain("dotnet test exited
  2")` checks on the actual literal content, which can fail. Not a blocking issue.
- No test exercises a handoff reason containing a double quote, backtick or `$(...)` through
  `continueNote`/`continue_note` end-to-end. Given finding 3 is a documentation gap rather than a
  live vulnerability in this repo (nothing here execs the substituted string), not blocking, but
  worth a follow-up issue if the owner's adapter does that substitution.

## What was run

- `bun test test/gate-notification-command.test.ts` → 16 pass, 0 fail, exit 0 (captured as its
  own line, not through a pipe).
- `bun run typecheck` → exit 0.
- No other test file in the diff's touch set (`test/run-outcome.test.ts` references
  `gateNotification` but not `holding`/`continue_*`, and `src/core/facilitator/runAuto.ts`
  calls `gateNotification` without reading the new fields) — left to the wave's full gate run,
  per instructions.

## Verdict rationale

No Important defect against the six named risks: the note can't be invented, the pair can't
split, `--stage` can't leak in, absence is a real missing key, and `holding` is one derivation.
The injection concern is real in shape but not introduced as an executable bug by this diff —
it's a documentation gap for downstream adapters, tracked here rather than blocking the merge.
