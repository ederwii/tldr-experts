verdict: merge
reviewed-by: fresh reviewer sub-agent, claude-sonnet-5, dispatched by session tldr-experts-4a
against: 7e58dc1

Findings (no Critical/Important):

- Paths (the main hunt target): `runNext.ts` builds the preamble's `outputs` via
  `expandAll(spec.planned.outputs, store.run.repos).map((declared) => relative(options.root,
  resolveDeclared(declared, ctx)))` — the SAME `resolveDeclared`/`PathContext` that
  `validateOutputs.ts` uses for the real "was declared as an output but does not exist on disk"
  check, and the same `options.root` used as `cwd` at the two spawn call sites (runNext.ts:559,
  657). `watch.ts`'s preamble uses `relative(ctx.root, join(ctx.runDir, watcherRelPath(...)))`,
  the same `watcherRelPath` its own verification code already used (lines 182/245), against
  `ctx.root`, which is also its spawn `cwd` (line 151). Confirmed by reading, not fixture
  inference — this is one derivation reused, not a second copy.
- Plan's pattern outputs (`stories/<id>.md`) are printed literally in the preamble, per the
  documented design choice in `renderStagePreamble`'s docstring. Checked `stages/plan/stage.md`:
  it already uses the identical `<id>`/`<epic>` bracket notation in its own Produce section, so
  the preamble's notation is consistent with what the agent already reads, not a foreign shape.
- All stage kinds (what/how/plan) share the single `assemblePrompt` call site (runNext.ts:511);
  no second prompt-assembly path exists. `--prepare` writes the same assembled prompt to its
  bundle (mode branch at line 616 is downstream of the same `assemblePrompt` call), so a cursor/
  host reviewing `prompt.md` sees the same imperative. Build's developer/reviewer prompts
  (`src/core/build/prompts.ts`) never import `renderParts`/`buildPrompt` — grepped, confirmed —
  matching the "golden untouched" claim; `build-golden.test.ts` passed.
- Marker/hook: `session-start.ts`'s early return under `isSubagentEnv()` falls through to
  `runHook`'s `allow()`, which is a silent `process.exit(0)` — the exact same shape every other
  early return in that hook already uses (e.g. `root === null`). No malformed hook response.
  Suppressed content is only the "N runs open" / workspace pending report, both human-orientation
  material; `facts` reach the sub-agent independently via `renderFacts` inside the main prompt,
  so nothing a sub-agent needs is lost.
- Questions protocol: preamble's "record it in `questions.md`, in the shape the template gives"
  defers to the stage template rather than inventing new grammar; `envelope.ts`'s
  `questions_asked: readonly string[]` and the existing §2.7 `questions.md` grammar are
  untouched and uncontradicted.
- Context ledger: preamble bytes are charged to the existing `stage` group (own row, no new
  group/field shape change) — correctly counts toward `prompt_max_bytes` refusal since it is
  real prompt weight. No `DASHBOARD_MODEL_VERSION` bump needed or made (additive `kind` value
  only, matches house invariant).
- Test loosening: `test/facilitator.test.ts`'s `/context \d+ B of /` → `/context [\d.]+ (B|KB)
  of /` is offset by a NEW, more specific pin added in the same edit —
  `expect(said).toContain("stage preamble ")` — so specificity was not net-lost. Reason for the
  unit change (prompt crossed 1 KB) is stated in a comment.
- `test/machine-load.test.ts`'s spawning-file guard (line ~116) is a dynamic `readdirSync` scan,
  not a hand-maintained list; `stage-preamble.test.ts` already calls
  `setDefaultTimeout(spawnTestTimeout(30_000))` at its top, so it self-satisfies the guard — full
  suite run below includes and passes this check.
- `docs-site/scripts/gen-cli.ts` env-var row: name `TLDRX_SUBAGENT` and description match
  `subagent.ts`'s actual export and behaviour.
- `docs/spec.md` prompt-order block and CHANGELOG `## 0.13.1 — unreleased` entries match the
  code and comments verbatim (66,452 B / $0.29 / 5,007→13,180 B figures are internally
  consistent across CHANGELOG, prompt.ts docstring, and stage-preamble.test.ts's own docstring).

Gates run (worktree, TMPDIR=/tmp/rv1):
- `bun run typecheck` → exit 0
- `bun test test/stage-preamble.test.ts test/facilitator.test.ts test/build-golden.test.ts` →
  60 pass, 0 fail, exit 0
- `bun test` (full suite) → 4203 pass, 0 fail, exit 0
- `bun run build` → exit 0
- `bun run docs:build` → exit 0
- `grep -rn "Bun\." src --include="*.ts" | grep -v "src/core/runtime/"` → no matches (seam clean)

No Critical or Important findings. Merge.
