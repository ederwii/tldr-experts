verdict: merge
reviewed-by: fresh reviewer sub-agent, claude-sonnet-5, dispatched by session tldr-experts-4a
against: c54fad3

## Scope

15 files, +1101/-128. `gateSigner.ts` (new, 170 lines) and `evidenceScope.ts` (new,
94 lines, a content-neutral extraction of `countCitations`/`countDeclaredTouches`
out of `src/cli/commands/gate.ts` — diffed byte-for-byte, no behaviour change).
`runNext.ts` gains the signer call site inside `finishStage`'s `approve` branch.
`agentGate.ts`, `gates.ts`, `gateAuthority.ts`, `RunFile.ts` are UNCHANGED —
verified via `git diff --stat`, none of the four appear.

## What I confirmed correct (measured, not assumed)

- **One validator, one door.** `evaluateAgentGate` (unchanged) and `approve`
  (unchanged, `src/core/run/gates.ts:72`) are the exact functions
  `approve --as-agent` uses (`src/cli/commands/approve.ts:76`). The signer
  (`runNext.ts:2437-2603`, function `signGate`) writes a file and calls the same
  two; there is no second implementation.
- **Ordering.** The signer runs at `runNext.ts:1772`
  (`agent.evidence === null && options.mode === "headless"`), strictly before
  `mapStage(... "awaiting_gate" ...)` and the single `gate.requested` append at
  `runNext.ts:1782`. One `gate.requested` per gate either way; its `cost_usd` is
  `spentNow()` (`runNext.ts:1709`), computed AFTER the signer's task row lands, so
  the stage's `budget` auto-condition sees the signer's own spend and can refuse a
  stage the signer's turn tipped over its ceiling — the implementer's stated
  design, verified in code.
- **Actor attribution is not a lie.** The note's `by:` and `approve`'s recorded
  `actor` are the human `$USER` (`currentActor()`), same as the pre-existing
  `gate template` convention — looks alarming in isolation, but issue #122
  (`gateAuthority.ts`, unchanged, untouched by this diff) already separates "whose
  name is on the note" from "what kind of entity acted": `executed_by.type` is
  derived from `signedWithEvidence`, independent of `by`, and lands `"agent"`
  whichever door produced the evidence. Not a finding.
- **Codex sandbox pin (§10) intact.** `spawnAgent.ts:224`:
  `request.role === "reviewer" ? "read-only" : "workspace-write"` — `gate-signer`
  falls to `workspace-write`, narrowed by `GATE_SIGNER_TOOLS`
  (`gateSigner.ts:54`, no `Edit`), exactly as claimed; the reviewer pin is the one
  value untouched.
- **Write scope.** `Write` is not path-scoped by the provider (true of
  `REVIEWER_TOOLS`'s precedent too), but a rogue write to a stage's own declared
  output would be caught: `approve` re-runs the stage's checks off disk before
  recording anything (`gates.ts` — unchanged), so a signer that corrupted an
  output it was supposed to have already validated fails the check and falls to
  a person rather than closing silently.
- **Hermetic fixture.** `fakeClaude.ts` diff routes through the one shared
  `fakeTranscript.ts` emitter (AGENTS.md §8), discriminating stage-turn vs.
  signer-turn by prompt content via new env vars only.
- **Mode guard.** `options.mode === "headless"` fires for a bare `tldrx next` too
  (`next.ts`'s `resolveMode` defaults there absent `--prepare`/`--commit`), not
  only inside `run auto`'s loop. Docs match: `docs/spec.md` says "`next` (headless
  only)"; the docs-site/helpText additions frame it under `run auto` because
  that's the page's/section's scope, not because the code is narrower — no
  mismatch.
- **Docs/CHANGELOG.** EN/ES lockstep verified (`docs-site/guides` and
  `docs-site/es/guides`, same structure and content). `#197`'s `--wait-gates`
  wording corrected in `helpText.ts`, `docs-site/guides/unattended-operation.md`,
  and its ES counterpart — three places, matching the claim.

## Recommended follow-up (not a blocker for this merge)

**Evidence-note staleness across a reject+rerun cycle** — PLAUSIBLE, not
reproduced live. `signGate` only runs when `agent.evidence === null`
(`runNext.ts:1772`); an EXISTING note is never regenerated. `tldrx reject`
(`src/core/run/gates.ts:226-246`) sends an `awaiting_gate` stage back to `ready`
without touching `.agent/<stage>/evidence.md` ("nothing is deleted", by design,
per its own docstring) so `next` re-runs the stage and overwrites its declared
outputs while the OLD note sits untouched. If that note's evidence already read
`verdict: sign` (held only by an unrelated auto-condition — a budget event, an
open question — not by the evidence itself) and the blocking condition later
clears, the re-evaluation on the SECOND attempt would auto-approve over the
FIRST attempt's note without ever re-deriving it against the new outputs. This
mechanism (`evaluateAgentGate` re-reading whatever note is on disk) predates
this diff and is identical for a human-authored note via `gate template`; this
diff does not introduce or worsen it, and the new tests
(`test/gate-signer.test.ts:316`, "one signer per note, ever") only cover the
happy-path reuse across advancing stages, not a reject-then-rerun. Recommend
filing a tracked issue against `evaluateAgentGate`/`approve` for a
freshness/staleness check (e.g. hash or mtime of declared outputs recorded in
the note and compared at evaluation time) rather than blocking this PR, since
the gap is shared infrastructure this change does not touch.

## Gates run

- `bun run typecheck` — exit 0
- `bun test test/gate-signer.test.ts test/notify-hook.test.ts test/gates.test.ts`
  — 97 pass, 0 fail, exit 0
- `bun test test/agent-gate.test.ts test/evidence.test.ts test/reported-nits.test.ts test/review-handshake.test.ts`
  (other files touching the touched surface) — 114 pass, 0 fail, exit 0
