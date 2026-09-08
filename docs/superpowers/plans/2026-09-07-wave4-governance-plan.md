# Wave 4 — governance: a decision record that reads back, a defect that has an owner, a ceiling that answers to a grant — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close #169, #171 and #170 as MECHANISMS rather than habits — an answered decision that records who decided it and what it binds, a contradiction check that raises instead of staying silent, a sanctioned verb that widens a story's surface, a finding no story owns that is named in two documents, and a dollar ceiling that answers to a recorded grant — without moving one committed golden byte.

**Architecture:** Every change is a LEAF plus its call sites. Five new leaves, each taking DATA and never `ctx` and never the session: `answers/reposFromAffects.ts`, `answers/raiseConflict.ts`, `facts/decidedTally.ts`, `build/unownedFindings.ts`, `build/planVsMeasured.ts`, `budget/grant.ts`. Existing derivations are REUSED and never copied: `findDuplicate` (Jaccard), `conflictOf` (stays in `distill.ts`), `parseSrcToken` (the `[src:]` grammar), `inSurface` (path coverage), `renderQuestionBlock` (the canonical §2.7 block), `applyPlanPatch` (the one story writer), `isOpen` (still-owed), `round2`, `spendBasis`. `caps.ts` and `remainingWork.ts` are NOT touched — they are the wave's tripwire.

**Tech Stack:** TypeScript on Bun (tests, build) running under Node ≥ 20 at runtime; `bun:test`; VitePress for the docs site.

**Spec:** `docs/superpowers/specs/2026-09-07-wave4-governance-design.md` (its section 9 records the three owner decisions settled by timeout default — grant = a `budget.yml` row written by `tldrx budget grant`; unowned findings = report only; widening = an operator-only `tldrx story widen`. This plan is written for those defaults; do not re-open them.)

**Base:** worktree `wt-wave4`, branch `feat/wave4-governance`, base = `77dbf29` (`release: 0.10.0`), with the spec commit `8b6890f` on top. **Every file:line below was re-opened and quoted in this worktree at `8b6890f`.** Where the spec's own anchor did not survive that check, the correction is stated in the task and again in `## Notes for the controller`.

**Revision, 2026-09-07** — this plan was revised once, after a pre-flight conflict scan
(`.superpowers/sdd/2026-09-07-wave4-governance-plan/preflight.md`: 2 Critical, 7 Important, 7 Minor)
measured 36 task pairs against the code. Every ruling was applied and **in every case the code or
the spec won over the plan**: three round-trip assertions quoted YAML the emitters do not produce
(they emit plain, unquoted scalars); the red-by-design card string now uses the spec's placeholder
form, which is the only form `boundaryCard` can produce; four `bun test` commands named test files
that do not exist; the `[assumption]` guard was strengthened because the version this plan first
carried was already green for five of eighteen files; two assertions that were green at the base
are now labelled guards and a real failing assertion sits beside them; the grant reconciliation now
distinguishes a phase ceiling from a run ceiling, with a pin that tells them apart; `dist/cli.js`
became `dist/tldrx.js`; a changed handoff sentence is now pinned; and `agent.result`'s `cost_usd` is
recorded as the ENVELOPE field it is. The Minors were anchor drift, four out-of-scope identifiers
in test snippets, and the missing `bun install` this worktree needs before any gate.

## Global Constraints

Copied from `AGENTS.md` and from the spec's section 4; every task's requirements implicitly include this section.

- **Evidence before assertion.** Label a claim `measured` (you ran it), `inferred` (mechanism + evidence) or `assumed`. Never copy a measurement out of a doc or a comment when you can take one.
- **Never quote a CLI command or flag from memory.** `src/cli/helpText.ts` (and `tldrx <cmd> --help` off a real `bun run build`) is the authoritative command surface.
- **Exit codes are never read through a pipe or after a trailing command.** Each gate command on its own line, its own `echo "<name>: $?"` immediately after. The shell here is zsh: no `${PIPESTATUS[0]}`, never name a variable `status`, and **quote every glob** — an unmatched `*.ts` kills the whole run under `nomatch`.
- **Red-first, always.** Every behaviour change starts with a failing test whose VERBATIM red output is kept for the commit message and the issue close. After it goes green, MUTATE the code under test and confirm the test goes red again — both directions where the change has two halves. A test that passed before the fix is a guard, not a proof; label it as one.
- **`version: 1` file formats only grow — and a field is not "added" until the code that WRITES the file carries it.** Every format here is emitted key-by-key by a hand-written emitter, and two have a mapper in front. The mapper/emitter pairs this wave MUST teach, verbatim from spec §4.1:
  - `facts.yml` · `conflicts_with` → **`FactsStore.append` (`src/core/facts/FactsStore.ts:83-101`) and `emitFact` (`src/core/facts/emitFactsYaml.ts:73-104`)**, both of which enumerate keys, so a `NewFact` carrying the field is dropped **with no type error**. Pin: a `NewFact` → `append` → `emitFactsYaml` → `parse` → `validateFactsFile` round-trip test. (Measured correction to the spec: `FactsStore.supersede` is not a second writer — it delegates to `append` at `FactsStore.ts:135`, `const replacement = this.append({ ...input, supersedes: oldId });`. One edit covers both paths; the round-trip test still covers both.)
  - `facts.yml` · `source.decided_by` and `repos` → **no emitter work.** `append` spreads `source` (`FactsStore.ts:92`, `source: { ...input.source }`) and copies `repos` (`:89`); `emitFact` already emits `decided_by` when present (`emitFactsYaml.ts:76-79`).
  - `budget.yml` · `authorized_usd`, `authorized_by`, `authorized_at`, `on_grant_exceed`, `BudgetPhase.authorized_usd` → **`asRunBudget` (`src/core/budget/RunBudget.ts:234-254`) and `emitBudgetYaml` (`src/core/run/emitRunYaml.ts:217-262`)**. The emitter's own comments say why (`emitRunYaml.ts:227-232`): *"`budget raise` rewrites this file through this emitter, so a label that did not round-trip would be ERASED by the one command an operator reaches for when a ceiling binds"* — and `budget raise` is the command being made grant-aware. Pin: `grant` → `raise` → re-read, the grant intact.
  - `run.yml` · `triage.budget_basis` → **`emitRunYaml.ts:167-169`**, which emits `triage:` as a fixed inline mapping of `split` and `depends_on`. Pin: a triaged run.yml round-trips the basis; an untriaged one stays byte-identical.
  - `events.jsonl` · `fact.conflict_raised`, `story.touches_widened`, `budget.granted` → **`EVENT_TYPES` is a CLOSED enum** (`src/core/events/Event.ts:106-124`) and `validateEvent` runs `requireEnum(doc.type, EVENT_TYPES, "type", issues)` at `:157`. A new type must be ADDED to that list. Before each lands, check `renderReplay` and `readReviewLedger` against it and pin that both survive.
- **Never force quoting in an emitter to satisfy a test.** `yamlScalar` emits a PLAIN, unquoted scalar whenever `PLAIN_SAFE` (`/^[A-Za-z][A-Za-z0-9_./-]*$/`, `src/core/facts/emitFactsYaml.ts:11`, and the same pair at `src/core/run/emitRunYaml.ts:16-18`) matches — so `F001`, `api`, `model-guess` and `s.yml` all emit bare. Assert the bytes the emitter actually produces, or assert only the parse-back half. Quoting them to make an assertion pass would change every `repos:` line in every `facts.yml` on disk and break `test/facts-add.test.ts`'s byte pins.
- **Absent-with-reason, never invented.** `decided_by` absent means "not stated", never "owner"; `repos: []` means "no repo was named", never the run's repos; absent `conflicts_with` means "not detected", never "checked and agreed"; absent `authorized_usd` means "no grant recorded", never `$0`; a carried finding with no `[src:]` path is `no-src` and one whose citation names no repo is `unqualified`, and neither is ever counted as `owned`; `overShareSentence` returns **null** rather than a ratio over a figure it does not have.
- **One implementation per derivation.** The leaves this wave adds, and nothing else: `facts/decidedTally.ts` (`decidedTally`), `answers/reposFromAffects.ts` (`reposFromAffects`), `build/unownedFindings.ts` (`ownershipOf` + `unownedFindings`, with `carriedFindings` living in `fixlist.ts` beside its siblings), `build/planVsMeasured.ts` (`overShareSentence`), `budget/grant.ts` (`grantFor` + `wouldExceedGrant`). Each takes DATA, never `ctx` and never the session (AGENTS §12). Two things that are deliberately NOT leaves: the provenance clause (one consumer — it stays inline in `renderFacts`) and `conflictOf` (already one definition and one call site at `distill.ts:160-164`; moving it is scope no issue asked for).
- **Exit-code families, and no condition split across two.** `story widen`'s own refusals are **2**, matching `reopenStory.ts:82-83` (`/** Spec §3: `refused`. Every one of this verb's own refusals is a refusal to act. */ const EXIT_REFUSED = 2;`); **1** only for the subcommand-dispatch error; **3** for an unknown run. `budget grant`/`budget raise`: a bad amount or an unknown phase is **1**; a ceiling above the recorded grant under `on_grant_exceed: block` is **2** (`EXIT_GATE_REFUSED`, `src/cli/exitCodes.ts:19`). `tldrx answer`'s new refusals are all **1**; the contradiction advisory exits **0**.
- **A new flag is not documentation — it is dispatch.** `flagRefusal` (`src/cli/index.ts:187-192`) builds `known` from `declaredFlags(name)` (`helpText.ts:1302-1304`) and refuses anything else with `tldrx <cmd>: unknown flag --<x>`. **So `helpText.ts` must declare every new flag in the SAME task that adds it**, and `test/docs-cli-coverage.test.ts:62` then requires that flag to be named inside that command's own `## \`tldrx <cmd>\`` section of `docs/guide/08-cli-reference.md`. Each implementation task therefore lands its own minimal guide line; Task 10 does the prose, `docs/spec.md`, `docs/dashboard-model.md` and the docs-site EN/ES pair.
- **Hermeticity.** Every spawning test file imports `spawnTestTimeout` from `./fixtures/machineLoad.ts` and calls `setDefaultTimeout(spawnTestTimeout())` at the top; each gets its own temp root; never scan shared tmp. **Measured correction to the spec:** `test/machine-load.test.ts:125` is `expect(spawners.length).toBeGreaterThanOrEqual(40)` and the repo has **75** spawning test files today (`ls test/*.test.ts` filtered on `node:child_process|Bun.spawn|makeBuildWorkspace|makeSandbox` → 75). It is a vacuity floor, not a count: **adding spawning files does not require editing it.** What DOES move is the test total — the `test.each(spawners)` case adds **one test per new spawning file**, which is the "+N is one higher than the tests you wrote" of AGENTS §8. Reconcile that in Task 12; do not hand-wave.
- **EN and ES in lockstep.** Every docs-site page edited in English gets its Spanish twin edited in the same commit. ES is a real translation; sample CLI strings stay in English (owner decision).
- **The current version is never typed into prose.** `test/public-surface-consistency.test.ts` scans `docs-site/` and `README.md`; banned positioning ("lightweight", bare "tool-agnostic", absolute state-coherence claims); the provider sentence is fixed. No README row moves in this wave — the `| <V> | unreleased |` row is `scripts/release.sh`'s own commit.
- **CHANGELOG only in its own task (Task 11).** Nine implementation tasks writing to one file is nine conflicts. One `## 0.11.0 — unreleased` section, one heading per kind; if a sibling has already created it, merge as the UNION.
- **Test cadence, per task.** During the work run only the NAMED test files, plus `bun test test/build-golden.test.ts` and `bun run typecheck`. The FULL `bun test` runs **once per task, at the END**, immediately before the commit, with its exit code on its own line. `bun run build` and `bun run docs:build` run in Task 10 and Task 12.
- **Golden discipline.** `test/build-golden.test.ts` freezes 4 scenarios and 22 artifacts. **Expected across this whole wave: NO golden artifact moves.** Each task states which scenario WOULD move if it did. A golden byte change is a behaviour change: name the artifacts before starting, carry the diff in the commit, or revert. `TLDRX_GOLDEN_UPDATE=1` to make a diff go away is never the answer — a regeneration run fails deliberately (`build-golden.test.ts:130-135`).
- **New out-of-scope bugs → a GitHub issue with the evidence, not a fix in this wave.** One is already known and is Task 12's to file: `tldrx facts add --repo` does not validate its value (`src/cli/commands/facts.ts:97` spreads `repeatedFlag` straight in), so a fact can be scoped to a repo that does not exist and is invisible to `renderFacts`'s filter forever.
- **Commit trailer on every commit in this plan:**

  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  ```

  (Add your own `Claude-Session:` line beneath it if your session has a URL.)
- **`bun install` before the first gate command.** Measured in this worktree: with no `node_modules`, `bun run typecheck` exits **127** (`tsc: command not found`) and `bun test <file>` errors at module resolution — a 127 is not a red test, and reading it as one would be the wrong instrument. Run `bun install` once, read its exit code, and only then start Task 1's Step 2.
- **No release steps.** This plan ends at a green gate and a clean tree. `scripts/merge-wave.sh feat/wave4-governance "<merge message>"` — two arguments — is somebody else's decision.

---

## File Structure

Files created:

| File | Responsibility |
|---|---|
| `src/core/answers/reposFromAffects.ts` | ONE derivation of "which workspace repos does this question's `affects:` name". Keeps an entry only when it IS a repo name, or when its `repo:` prefix is one; reports the rest as unresolved so `[]` is never printed as "no repo was named". |
| `src/core/answers/raiseConflict.ts` | Minting the §2.7 question a detected contradiction raises: `nextQuestionId(runDir)` and `raiseConflictQuestion(...)`, rendered through `renderQuestionBlock` — the canonical authoring renderer. |
| `src/core/facts/decidedTally.ts` | `decidedTally(facts, runId)` → `{owner, driver, notStated}` and the one sentence derived from it. Two readers: the run close and the Build handoff header. |
| `src/core/run/widenStory.ts` | `widenStory(options)` → `{code, lines}` — the operator verb `decisionCards.ts:105` has been pointing at. Mirrors `reopenStory.ts`: runs no agent, spends nothing, moves no cursor. |
| `src/core/build/unownedFindings.ts` | `ownershipOf(finding, declared, repoNames)` → `owned` \| `unowned` \| `unqualified` \| `no-src`, and `unownedFindings(...)`. Repo-then-path, because `inSurface` has no repo in it. |
| `src/core/build/planVsMeasured.ts` | `overShareSentence(ceilingUsd, measuredUsd, stories)` — ONE arithmetic, two feeders (`tldrx cost --stories` off events; the Build handoff off the caps the executor just used). Null when either side is absent. |
| `src/core/budget/grant.ts` | `grantFor(budget, phaseId)` and `wouldExceedGrant(...)`. Separate from `wouldExceed.ts` on purpose: one asks "may this run spend more", the other "may this file hold this ceiling". |
| `test/answer-attribution.test.ts` | The two new `answer` flags, their refusals, the sweep case, the repos precedence, and the repo filter both ways. |
| `test/answer-conflict.test.ts` | The advisory raise, the `conflicts_with` round trip, the negative case, and the honest false-negative pin. |
| `test/story-widen.test.ts` | The verb, both directions of the boundary proof, and the refusal families. |
| `test/unowned-findings.test.ts` | The pure leaf over all four labels, including the repo case. |
| `test/budget-grant.test.ts` | The grant round trip through `raise`, the warn/block fork, and the absent-grant case. |

Files modified (each task names its own list): `src/core/facts/{Fact,FactsStore,emitFactsYaml,validateFactsFile}.ts`, `src/core/answers/{captureAnswers,stampSuperseded}.ts`, `src/core/distill/distill.ts`, `src/core/facilitator/prompt.ts`, `src/core/run/{closeRun,decisionCards,boundary,ship,shipBody,RunFile,emitRunYaml,newRun}.ts`, `src/core/build/{handoff,fixlist,storyFile,phaseCost}.ts`, `src/core/budget/RunBudget.ts`, `src/core/events/Event.ts`, `src/core/replay/renderReplay.ts`, `src/core/dashboard/model.ts`, `src/core/seed/applySplit.ts`, `src/core/facilitator/executors/build.ts` (orchestrator only — it captures values and passes them), `src/cli/commands/{answer,story,budget,cost,run,approve}.ts`, `src/cli/helpText.ts`, `src/core/drive/mandate.ts`, `stages/*/stage.yml` (5, comments only), `workflows/*.yml` (13, comments only), plus tests, `CHANGELOG.md`, `docs/**` and `docs-site/**`.

---

## Task 1: #169 — `tldrx answer` records who decided, and what the decision binds

**Files:**
- Create: `src/core/answers/reposFromAffects.ts`
- Modify: `src/core/answers/captureAnswers.ts` — `CaptureContext` (`:27-35`), the capture loop's fact (`:101-109`, `repos: []` at `:105`), `supersedeAnswer`'s fact (`:249-257`, `repos: [...head.repos]` at `:253`)
- Modify: `src/core/answers/stampSuperseded.ts:155` — `function declaredAffects(block: QuestionBlock): readonly string[] {` becomes `export function …`
- Modify: `src/cli/commands/answer.ts` — `parseArgs(argv, ["run", "root"])` at `:42`; the two `captureAnswers`/`supersedeAnswer` call sites at `:80-86` and `:94-100`; the stdout lines at `:88` and `:106`; the usage string at `:38`
- Modify: `src/hooks/answer-capture.ts:31-37` — the hook's `CaptureContext` gains `repoNames` and NOTHING else
- Modify: `src/cli/helpText.ts` — the `answer` entry at `:579-603` (flags at `:585-593`, notes at `:599-602`)
- Modify: `docs/guide/08-cli-reference.md` — the `## \`tldrx answer\`` section names `--decided-by` and `--repo`
- Modify: `src/core/drive/mandate.ts:295` — `"\`tldrx answer <Qid> \"…\"\` is mine to type."`
- Test: `test/answer-attribution.test.ts` (new), `test/run.test.ts` (`describe("tldrx answer")` at `:536`, its first test at `:549` — read, expect green), `test/hooks.test.ts:418` (the `repos: ["api","lab"]` fixture — read, add a sibling)

**Interfaces:**
- Consumes: `declaredAffects(block: QuestionBlock): readonly string[]` (newly exported from `stampSuperseded.ts`); `loadWorkspace(root).repos: ReadonlyMap<string, string>` (`src/hooks/lib/workspace.ts:62`, `:182`); `FACT_DECIDERS` / `FactDecider` (`src/core/facts/Fact.ts:41-42` — `:44` is `FactRetirement`).
- Produces:
  - `reposFromAffects(affects: readonly string[], repoNames: ReadonlySet<string>): { repos: readonly string[]; unresolved: readonly string[] }`
  - `interface AnswerOverride { readonly decidedBy?: FactDecider; readonly repos?: readonly string[] }` exported from `captureAnswers.ts`
  - `CaptureContext.overrides?: ReadonlyMap<string, AnswerOverride>` and `CaptureContext.repoNames?: ReadonlySet<string>` — both optional, both absent meaning exactly today's behaviour
  - Task 2 adds `conflicts_with` to the same two fact-construction sites; Task 3 reads `source.decided_by` off the file.

### The measured problem

`captureAnswers.ts:105` is `repos: [],` and `:108` is `source: { who: ctx.actor, when: ctx.at, run: ctx.run, q: block.id },` — no `decided_by`. `currentActor()` is `$USER` (`src/hooks/lib/actor.ts:1-5`, whose own docstring calls itself `[assumption]`), so an agent running `tldrx answer` in the owner's shell writes a row byte-identical in provenance to the owner typing it. `renderFacts` (`src/core/facilitator/prompt.ts:411-423`) filters on `fact.repos.length === 0 || fact.repos.some(...)` and appends `· decided by <role>` when present, so both fields are read the moment they are written.

Three mechanical facts that decide the shape:

1. **`answer.ts:42` is `parseArgs(argv, ["run", "root"])`.** A value-taking flag absent from that list is set to `true` and its value falls into `positionals` (`src/cli/argv.ts:48-54`), i.e. straight into the answer text via `words.join(" ")` at `:47`. Without adding both flags there, `--decided-by owner` silently appends `owner` to the recorded answer.
2. **`captureAnswers` SWEEPS.** `answer.ts:93` writes one slot, then `:94` calls `captureAnswers(path, ctx)`, which loops `detectAnswered(doc.blocks)` (`captureAnswers.ts:85`, loop at `:98`) over **every** answered-but-uncaptured block in that file. Flags carried on the context alone would stamp provenance onto questions the operator never named. Hence the per-question `overrides` map.
3. **The `answer-capture` hook cannot honestly say `owner`.** It fires on `PostToolUse` with `tool_name` `Write`/`Edit` — an agent writing the file with its own tool — and on `FileChanged`, a human editing it (`src/hooks/answer-capture.ts:22-26`). So it passes **no** override, and the row it writes carries no decider, which is the documented absence.

### The golden statement

**Expected: no golden byte moves.** All four scenarios carry zero facts — every developer and bundle prompt renders `_No recorded facts match this run's repos._` — and no golden scenario runs `tldrx answer`. The artifacts that WOULD move if this went wrong are the six prompt files (`headless-developer-prompt.md`, `headless-reviewer-prompt.md`, `insession-bundle-prompt.md`, `insession-reviewer-prompt.md`, `rounds-developer-S1-*.md`, `refused-developer-S1-1.md`) — the only place `renderFacts` output is frozen.

- [ ] **Step 1: Write the failing tests**

Create `test/answer-attribution.test.ts`. Model the fixture on `test/facts-add.test.ts:20-52` (which uses `makeRunWorkspace` + `gatedScope` + `createRun`, spawns nothing, and says so in its own header) — read that header before writing yours, and say in yours whether this file spawns. It calls `answerCommand.run(...)` in process, so it does not.

```ts
/**
 * `tldrx answer --decided-by / --repo` — provenance the answer path can state (#169).
 *
 * Until this landed, `captureAnswers.ts:105` wrote `repos: []` and a `source`
 * with no `decided_by`, so a driver's answer and the owner's were byte-identical
 * in provenance and no answered decision ever said what it bound to. The flags
 * are OPTIONAL because the `answer-capture` hook cannot honestly say which of
 * the two wrote the file (`hooks/answer-capture.ts:22-26` fires on an agent's
 * Write AND on a human's FileChanged), so absence stays the common case and is
 * documented as "not stated", never "owner".
 *
 * In process, like `test/facts-add.test.ts`: `answerCommand.run` spawns nothing,
 * so this file is not a machine-load spawner and needs no `spawnTestTimeout`.
 */
import { describe, expect, test, afterEach } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { answerCommand } from "../src/cli/commands/answer.ts";
import { FactsStore } from "../src/core/facts/FactsStore.ts";
import { factsPath } from "../src/hooks/lib/workspace.ts";
import { renderFacts } from "../src/core/facilitator/prompt.ts";
import { reposFromAffects } from "../src/core/answers/reposFromAffects.ts";
// … the workspace helpers `test/facts-add.test.ts` uses; copy its imports verbatim
// rather than inventing names (`makeRunWorkspace`, `gatedScope`, `createRun`).

describe("tldrx answer records who decided, and only for the question it names", () => {
  test("--decided-by lands on the fact the invocation named", async () => {
    const ws = runWorkspace();                       // one run, one open Q1
    writeQuestions(ws, "01-what", block("Q1", "Where does state live?", "data-model"));

    expect(await answerCommand.run(["Q1", "Redis", "--decided-by", "owner", "--root", ws.root])).toBe(0);

    const facts = FactsStore.loadOrEmpty(factsPath(ws.root)).facts;
    expect(facts).toHaveLength(1);
    expect(facts[0]?.source.decided_by).toBe("owner");
  });

  test("the answer text is the answer, not the flag's value", async () => {
    const ws = runWorkspace();
    writeQuestions(ws, "01-what", block("Q1", "Where does state live?", "data-model"));

    await answerCommand.run(["Q1", "Redis", "--decided-by", "driver", "--root", ws.root]);

    // parseArgs's value-flag list is the whole of this: without it, `driver`
    // becomes a positional and `words.join(" ")` records "Redis driver".
    expect(FactsStore.loadOrEmpty(factsPath(ws.root)).facts[0]?.fact)
      .toBe("Where does state live? — Redis");
  });

  test("a second answered block in the same file is recorded with NO decider and NO repos", async () => {
    const ws = runWorkspace();
    // Q2 is filled in by hand BEFORE the command runs — the sweep will capture it.
    writeQuestions(ws, "01-what", [
      block("Q1", "Where does state live?", "data-model"),
      answeredByHand("Q2", "Which currency?", "billing", "EUR"),
    ].join("\n"));

    await answerCommand.run(["Q1", "Redis", "--decided-by", "owner", "--repo", "api", "--root", ws.root]);

    const facts = FactsStore.loadOrEmpty(factsPath(ws.root)).facts;
    const named = facts.find((f) => f.source.q === "Q1");
    const swept = facts.find((f) => f.source.q === "Q2");
    expect(named?.source.decided_by).toBe("owner");
    expect(named?.repos).toEqual(["api"]);
    // The operator named Q1. Stamping Q2 with it would be the same lie the flag exists to stop.
    expect(swept?.source.decided_by).toBeUndefined();
    expect(swept?.repos).toEqual([]);
  });

  test("--decided-by outside the closed set is a usage refusal, and nothing is written", async () => {
    const ws = runWorkspace();
    writeQuestions(ws, "01-what", block("Q1", "Where does state live?", "data-model"));
    const before = readFileSync(factsPath(ws.root), "utf8");

    expect(await answerCommand.run(["Q1", "Redis", "--decided-by", "banana", "--root", ws.root])).toBe(1);
    expect(readFileSync(factsPath(ws.root), "utf8")).toBe(before);
  });

  test("--repo naming no workspace repo is a usage refusal, and nothing is written", async () => {
    const ws = runWorkspace();                        // its workspace.yml declares `api`
    writeQuestions(ws, "01-what", block("Q1", "Where does state live?", "data-model"));
    const before = readFileSync(factsPath(ws.root), "utf8");

    expect(await answerCommand.run(["Q1", "Redis", "--repo", "ghost", "--root", ws.root])).toBe(1);
    expect(readFileSync(factsPath(ws.root), "utf8")).toBe(before);
  });
});

describe("what a decision binds to, and what it does not", () => {
  test("repos precedence: an explicit --repo beats the question's affects:", async () => {
    const ws = runWorkspace();
    writeQuestions(ws, "01-what", blockWithAffects("Q1", "Where?", "data-model", "lab:src/a.ts"));

    await answerCommand.run(["Q1", "Redis", "--repo", "api", "--root", ws.root]);

    expect(FactsStore.loadOrEmpty(factsPath(ws.root)).facts[0]?.repos).toEqual(["api"]);
  });

  test("with no --repo, an affects: entry that names a repo scopes the fact", async () => {
    const ws = runWorkspace();
    writeQuestions(ws, "01-what", blockWithAffects("Q1", "Where?", "data-model", "api:src/db.ts"));

    await answerCommand.run(["Q1", "Redis", "--root", ws.root]);

    expect(FactsStore.loadOrEmpty(factsPath(ws.root)).facts[0]?.repos).toEqual(["api"]);
  });

  test("with neither, repos stays [] — today's behaviour, and it hides nothing", async () => {
    const ws = runWorkspace();
    writeQuestions(ws, "01-what", blockWithAffects("Q1", "Where?", "data-model", "01-what/notes.md"));

    await answerCommand.run(["Q1", "Redis", "--root", ws.root]);

    expect(FactsStore.loadOrEmpty(factsPath(ws.root)).facts[0]?.repos).toEqual([]);
  });

  test("a scoped fact reaches a run that has the repo and is ABSENT from one that does not", () => {
    const scoped = { ...bareFact(), id: "F001", repos: ["api"] };
    expect(renderFacts([scoped], ["api"])).toContain("F001");
    expect(renderFacts([scoped], ["lab"])).toBe("_No recorded facts match this run's repos._");
  });
});

describe("reposFromAffects — what it keeps, and what it refuses to guess", () => {
  const repos = new Set(["api", "lab"]);

  test("a bare repo name and a repo:path prefix both resolve; nothing else does", () => {
    expect(reposFromAffects(["api", "lab:src/db.ts"], repos).repos).toEqual(["api", "lab"]);
  });

  test("an unqualified path contributes nothing, and is not reported as an error", () => {
    // `implicitPlan.ts:1349-1351`: a citation with no repo prefix is skipped
    // rather than guessed at — the run may have several repos.
    const out = reposFromAffects(["01-what/notes.md", "src/db.ts"], repos);
    expect(out.repos).toEqual([]);
    expect(out.unresolved).toEqual([]);
  });

  test("a repo:path whose prefix names no repo is NAMED, so [] never reads as 'no repo was named'", () => {
    const out = reposFromAffects(["ghost:src/db.ts"], repos);
    expect(out.repos).toEqual([]);
    expect(out.unresolved).toEqual(["ghost:src/db.ts"]);
  });
});
```

Write the four small helpers (`runWorkspace`, `writeQuestions`, `block`, `blockWithAffects`, `answeredByHand`, `bareFact`) against the shapes in `test/facts-add.test.ts` and `test/run.test.ts:537-546` (that QUESTIONS constant is the §2.7 block shape to copy: `## Q1 · <title>` then `<!-- id: Q1 | status: open | area: <area> | asked_by: product | asked_at: <ts> -->`, a `Why asked:` line, options, `[Answer]:`). `affects:` is an extra metadata key: `… | asked_at: <ts> | affects: api:src/db.ts -->`.

- [ ] **Step 2: Run them and keep the RED verbatim**

```
bun test test/answer-attribution.test.ts
```
Expected: FAIL. The first failure is a module-resolution error — `Cannot find module '../src/core/answers/reposFromAffects.ts'`. Comment out the `reposFromAffects` import and describe block and re-run to get the behavioural REDs too: `--decided-by` unknown flag (exit `1` from `flagRefusal`, so `toBe(0)` receives `1`), and `expect(received).toBe(expected)` with `received: undefined, expected: "owner"`. **Paste all of it verbatim into the commit message.**

- [ ] **Step 3: Write the `reposFromAffects` leaf**

Create `src/core/answers/reposFromAffects.ts`:

```ts
/**
 * Which workspace repos an answered question's `affects:` names — ONE derivation.
 *
 * `affects:` has two disjoint readers and this is the second one. `affectedDocs`
 * (`stampSuperseded.ts:100-125`) takes the run-relative `.md` documents an answer
 * overtook; this takes the repo names. An existing `affects:` line full of
 * document paths keeps meaning exactly what it meant, and each reader takes only
 * what it understands.
 *
 * An entry counts when it IS a declared repo name, or when the half before its
 * first `:` is one — the `repo:path` production of the `[src: …]` grammar.
 * Everything else contributes NOTHING, and the reason is the framework's own
 * (`implicitPlan.ts:1349-1351`): "A citation with no repo prefix is skipped
 * rather than guessed at — the run may have several repos, and a wrong guess
 * would put another repo's file in front of an agent told it may edit only this
 * one."
 *
 * A `repo:path` whose prefix matched nothing is NOT silently dropped: it comes
 * back in `unresolved` so the caller can name it. `repos: []` recorded after a
 * `ghost:src/db.ts` would read as "no repo was named" when one WAS named and was
 * wrong, and that is the dangerous direction.
 */
export interface AffectsRepos {
  /** Declared repo names, de-duplicated, in the order they were named. */
  readonly repos: readonly string[];
  /** `repo:path` entries whose prefix is not a declared repo — named, never guessed at. */
  readonly unresolved: readonly string[];
}

export function reposFromAffects(
  affects: readonly string[],
  repoNames: ReadonlySet<string>,
): AffectsRepos {
  const repos: string[] = [];
  const unresolved: string[] = [];
  for (const raw of affects) {
    const entry = raw.trim();
    if (entry === "") continue;
    if (repoNames.has(entry)) {
      if (!repos.includes(entry)) repos.push(entry);
      continue;
    }
    const colon = entry.indexOf(":");
    if (colon <= 0) continue;            // an unqualified path: nothing, and no complaint
    const prefix = entry.slice(0, colon);
    if (repoNames.has(prefix)) {
      if (!repos.includes(prefix)) repos.push(prefix);
      continue;
    }
    unresolved.push(entry);
  }
  return { repos, unresolved };
}
```

- [ ] **Step 4: Export `declaredAffects`, and teach `captureAnswers` the overrides**

In `src/core/answers/stampSuperseded.ts:155`, change

```ts
/** `affects: a.md, b.md` off the block's §2.7 metadata, or nothing. */
function declaredAffects(block: QuestionBlock): readonly string[] {
```

to

```ts
/**
 * `affects: a.md, b.md` off the block's §2.7 metadata, or nothing.
 *
 * Exported since #169 so the key has exactly ONE parse with two disjoint
 * consumers: `affectedDocs` above takes the run-relative `.md` documents, and
 * `answers/reposFromAffects.ts` takes the repo names.
 */
export function declaredAffects(block: QuestionBlock): readonly string[] {
```

In `src/core/answers/captureAnswers.ts`, add beside `CaptureContext` (`:27-35`):

```ts
/**
 * Provenance the INVOCATION named, for ONE question.
 *
 * Per-question and never per-context, because `captureAnswers` sweeps every
 * answered-but-uncaptured block in the file (`detectAnswered`, the loop below) —
 * including one a human filled in by hand before the command ran. Stamping those
 * with what the operator said about a different question is the same lie the
 * flags exist to prevent.
 */
export interface AnswerOverride {
  readonly decidedBy?: FactDecider;
  /** Explicit `--repo` values. Wins over the question's `affects:`. */
  readonly repos?: readonly string[];
}
```

and two optional fields on `CaptureContext`:

```ts
  /**
   * Keyed by question id. A block not in the map is recorded exactly as it was
   * before this key existed — which is what the `answer-capture` hook passes,
   * because it cannot tell an agent's Write from a human's edit.
   */
  readonly overrides?: ReadonlyMap<string, AnswerOverride>;
  /**
   * Declared workspace repo names, for resolving a question's `affects:`.
   * Absent means no `affects:` entry can be resolved, so `repos` stays `[]` —
   * exactly today's behaviour, and it hides nothing.
   */
  readonly repoNames?: ReadonlySet<string>;
```

Import `type FactDecider` from `../facts/Fact.ts`, `declaredAffects` from `./stampSuperseded.ts` and `reposFromAffects` from `./reposFromAffects.ts`.

Inside the capture loop, immediately after `const truncated = …` (`:100`), and before `store.append`:

```ts
      const override = ctx.overrides?.get(block.id);
      const named = reposFromAffects(declaredAffects(block), ctx.repoNames ?? new Set());
      const repos = override?.repos ?? named.repos;
```

then replace `repos: [],` (`:105`) with `repos,` and `source: { who: ctx.actor, when: ctx.at, run: ctx.run, q: block.id },` (`:108`) with:

```ts
        source: {
          who: ctx.actor, when: ctx.at, run: ctx.run, q: block.id,
          // Absent means "not stated", never "owner" (`Fact.ts:36`). Only an
          // invocation that NAMED this question can state it.
          ...(override?.decidedBy === undefined ? {} : { decided_by: override.decidedBy }),
        },
```

Widen `CapturedAnswer` so the command can report what it could not resolve:

```ts
export interface CapturedAnswer {
  readonly q: string;
  readonly fact: string;
  readonly answer: string;
  readonly area: string;
  /** `affects:` entries shaped `repo:path` whose prefix names no workspace repo. */
  readonly unresolvedAffects: readonly string[];
}
```

and push `unresolvedAffects: named.unresolved` where `captured.push({ … })` is today.

In `supersedeAnswer`, do the identical three edits over its own block (`:249-257`): the `override` lookup keyed on `block.id`, `repos: override?.repos ?? [...head.repos]` in place of `repos: [...head.repos]` (a supersession is a new decision and may legitimately rescope; with no `--repo` it keeps inheriting), and the same conditional `decided_by` spread on `source`. Add `unresolvedAffects` to `SupersededAnswer` too, fed the same way.

- [ ] **Step 5: Add the flags to the command, and refuse before writing**

In `src/cli/commands/answer.ts`, change `:38` and `:42`:

```ts
  usage: "tldrx answer <Qid> <text> [--supersede] [--decided-by <who>] [--repo <name>] [--run <id>] [--root <path>]",
```
```ts
      const args = parseArgs(argv, ["run", "root", "decided-by", "repo"]);
```

After `const root = workspaceRootFrom(args);` (`:50`), before anything is written:

```ts
      // Validated BEFORE the write, both of them, because a fact scoped to a repo
      // that does not exist is invisible to `renderFacts`'s filter forever and a
      // decider outside the closed set is a row `validateFactsFile` would refuse
      // on the next read. The argument is `facts add --run`'s, transplanted:
      // asking for provenance by name and getting nothing instead is worse than
      // not asking.
      const decidedBy = stringFlag(args, "decided-by");
      if (decidedBy !== undefined && !(FACT_DECIDERS as readonly string[]).includes(decidedBy)) {
        throw new UsageError(
          `--decided-by expects one of ${FACT_DECIDERS.join(", ")}, got '${decidedBy}'`,
        );
      }
      const repoNames = new Set(loadWorkspace(root).repos.keys());
      const wantedRepos = repeatedFlag(args, "repo");
      for (const repo of wantedRepos) {
        if (!repoNames.has(repo)) {
          throw new UsageError(
            `--repo ${repo} is not a repo in this workspace — it has ${[...repoNames].join(", ")}`,
          );
        }
      }
      const overrides = new Map<string, AnswerOverride>([[qid, {
        ...(decidedBy === undefined ? {} : { decidedBy: decidedBy as FactDecider }),
        ...(wantedRepos.length === 0 ? {} : { repos: wantedRepos }),
      }]]);
```

Pass `overrides` and `repoNames` into BOTH the `supersedeAnswer` context (`:80-86`) and the `captureAnswers` context (`:94-100`).

Then say the absence out loud. After `process.stdout.write(\`${qid} answered → …\`)` (`:106`) add:

```ts
      if (decidedBy === undefined) {
        // Absent-with-reason: the REASON cannot live in the row (a second field
        // would just re-derive `decided_by !== undefined`, and could contradict
        // it), so it is said where a person can act on it.
        process.stdout.write(
          `  no decider recorded — this invocation passed no --decided-by, so the fact says `
          + `"not stated", which is never read as "owner"\n`,
        );
      }
      for (const entry of recorded.unresolvedAffects) {
        process.stdout.write(
          `  affects: ${entry} names no repo in this workspace — it scoped nothing\n`,
        );
      }
```

Add the same two blocks to the `--supersede` branch after its stdout line at `:88` — **reading `done`, not `recorded`**: `recorded` exists only on the capture path (`answer.ts:101`), and the supersede branch's variable is `done` (`:80`), so `SupersededAnswer` is the interface that has to carry `unresolvedAffects` and `conflict` there. New imports: `repeatedFlag` from `../argv.ts`, `FACT_DECIDERS`/`type FactDecider` from `../../core/facts/Fact.ts`, `type AnswerOverride` from `../../core/answers/captureAnswers.ts`, `loadWorkspace` from `../../hooks/lib/workspace.ts`.

In `src/hooks/answer-capture.ts:31-37`, add `repoNames: new Set(loadWorkspace(location.root).repos.keys()),` to the context and **nothing else** — no `overrides`. Put the reason in a comment there: PostToolUse fires on an agent's own `Write`/`Edit` as well as on a human's `FileChanged`, so this hook cannot say which of the two answered, and it says nothing rather than guessing.

- [ ] **Step 6: Declare the flags — this is dispatch, not documentation**

In `src/cli/helpText.ts`, inside the `answer` entry's `flags` array (`:585-593`), after the `supersede` flag:

```ts
      {
        name: "decided-by",
        arg: "<who>",
        meaning: "Who decided, as against who typed it. OPTIONAL here, and required on `facts add`: this command is also driven by the answer-capture hook, which fires on an agent's own Write and on a human's edit and so cannot honestly say either. Absent means “not stated”, never “owner”, and the command says so on stdout.",
        values: FACT_DECIDERS,
      },
      {
        name: "repo",
        arg: "<name>",
        meaning: "Scope the answered fact to one repo, so every {{facts}} block outside it stops carrying a decision that was never about it. Repeatable. A name no repo in workspace.yml answers to is refused before anything is written.",
        repeatable: true,
      },
```

and add one note to `notes` (`:599-602`):

```ts
      "Without `--repo`, the fact is scoped by the question's own `affects:` when an entry there names a repo (`api` or `api:src/db.ts`), and by nothing otherwise — `repos: []` means “no repo was named”, never “every repo”. An `affects:` entry that looks like `repo:path` and matches no repo is named on stdout rather than dropped in silence.",
```

`FACT_DECIDERS` is already imported at `helpText.ts:25`.

In `docs/guide/08-cli-reference.md`, the `## \`tldrx answer\`` section must NAME `--decided-by` and `--repo` — `test/docs-cli-coverage.test.ts:62` reads that file and that section only. One sentence each is enough here; Task 10 writes the prose.

- [ ] **Step 7: Correct the mandate's parking line**

`src/core/drive/mandate.ts:295` currently reads:

```
"`tldrx answer <Qid> \"…\"` is mine to type.",
```

Make it:

```
"`tldrx answer <Qid> \"…\" --decided-by owner` is mine to type; if you ever answer on my behalf it is",
"`--decided-by driver`, and it is recorded as yours.",
```

That is the same rule `mandate.ts:347-348` already states for `facts add`, now stated for the verb the parking block actually names.

- [ ] **Step 8: Run the named tests**

```
bun test test/answer-attribution.test.ts
```
Expected: PASS, 0 fail.
```
bun test test/run.test.ts test/hooks.test.ts test/facts-add.test.ts test/text.test.ts
```
Expected: PASS. `test/run.test.ts:549` asserts with `toMatchObject` on `{kind, confidence, area}` and is additive-safe; `test/facts-add.test.ts:338` (the byte-identical absent case) stays green by construction, because nothing in `renderFacts` changed.

Add the `test/hooks.test.ts` sibling now, beside the `repos: ["api","lab"]` fixture at `:418`: an answered fact scoped to `api` is in the `{{facts}}` block of a run whose repos include `api`, and absent from one whose do not. Two assertions, both directions.

- [ ] **Step 9: Prove the guards have teeth, in both directions**

Mutate `repos: override?.repos ?? named.repos` back to `repos: []` in `captureAnswers` — the precedence tests and the `affects:` test must go RED. Revert. Then mutate the `decided_by` spread to unconditional `decided_by: "owner"` — the sweep test must go RED (`swept?.source.decided_by` would be `"owner"`). Revert. Keep both REDs.

- [ ] **Step 10: Golden, then the full gate, then commit**

```
bun test test/build-golden.test.ts
echo "golden: $?"
```
Expected: `0`, 4 pass. If any artifact is named, STOP — this task must not reach a prompt.

```
bun run typecheck
echo "typecheck: $?"
```
```
bun test
echo "test: $?"
```
Expected: `0` for both.

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(answer): a recorded answer says who decided it and what it binds (#169)

`captureAnswers.ts:105` wrote `repos: []` and a `source` with no `decided_by`,
and `currentActor()` is `$USER` — so an agent answering in the owner's shell
produced a row byte-identical in provenance to the owner typing it, and no
answered decision ever recorded the surface it bound to. `tldrx answer` now
takes `--decided-by` and a repeatable `--repo`, both validated BEFORE anything
is written (a decider outside FACT_DECIDERS, or a repo workspace.yml does not
declare, is exit 1 with nothing on disk).

Both flags bind to the question the invocation NAMED and to nothing else.
`captureAnswers` sweeps every answered-but-uncaptured block in the file,
including one a human filled in by hand before the command ran, so the
provenance travels as a per-question `overrides` map rather than on the context:
a swept block is recorded exactly as it was before this change. The
`answer-capture` hook passes no overrides at all and the reason is in the file —
PostToolUse fires on an agent's own Write and on a human's FileChanged, and
telling those apart would be an inference written into an audit record.

Absent stays absent, with its reason said where a person can act on it: no
second field re-derives `decided_by !== undefined`, and `tldrx answer` prints
that the fact was recorded with no decider because the invocation passed none.
`repos` is populated only from explicit signals — `--repo`, else an `affects:`
entry that names a repo — so nothing narrows silently; an `affects:` entry
shaped `repo:path` that matches no repo is NAMED on stdout, because `[]` after
one of those would read as "no repo was named" when one was.

`affects:` now has ONE parse with two disjoint consumers: `affectedDocs` takes
the `.md` documents, `reposFromAffects` takes the repo names.

No golden byte moves: every scenario renders `_No recorded facts match this
run's repos._` and no scenario runs `tldrx answer`.

RED kept:
<paste Step 2 verbatim>

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: #169 — the contradiction check runs on the answer path, and its record round-trips

**Files:**
- Create: `src/core/answers/raiseConflict.ts`
- Modify: `src/core/facts/Fact.ts` — the `Fact` interface, after `truncated?` (`:60-69`)
- Modify: `src/core/facts/FactsStore.ts:83-101` — `append`, whose last line today is `...(cut || input.truncated === true ? { truncated: true as const } : {}),` (`:97`)
- Modify: `src/core/facts/emitFactsYaml.ts:73-104` — `emitFact`, after `if (fact.truncated === true) lines.push(\`${inner}truncated: true\`);` (`:94`)
- Modify: `src/core/facts/validateFactsFile.ts` — after the `truncated` block (`:105-109`)
- Modify: `src/core/facilitator/prompt.ts:411-422` — `renderFacts`'s one rendered line
- Modify: `src/core/distill/distill.ts:160-164` — `conflictOf`'s parameter type only
- Modify: `src/core/answers/captureAnswers.ts` — both fact-construction sites, and the post-write raise
- Modify: `src/core/events/Event.ts:106-124` — `EVENT_TYPES` gains `"fact.conflict_raised"`
- Modify: `src/core/replay/renderReplay.ts:125-215` — one `case` in `bullet`'s switch
- Modify: `src/cli/commands/answer.ts` — the stdout line that names the raised question
- Test: `test/answer-conflict.test.ts` (new), `test/facts-add.test.ts` (the round-trip pin + a `conflicts_with` render assertion), `test/distill.test.ts:147` / `:286` (read, expect green), `test/text.test.ts:579` (read, untouched), `test/replay.test.ts` (read, expect green)

**Interfaces:**
- Consumes: `conflictOf` (`distill.ts:163`, `findDuplicate(claim.match, claim.area, facts, CONFLICT_THRESHOLD)` with `CONFLICT_THRESHOLD = 0.6` at `:17`); `FactsStore.active` (`FactsStore.ts:69`); `renderQuestionBlock` (`src/core/text/questions.ts:243`, *"Canonical §2.7 rendering — used when authoring a block, not when rewriting one"*); `parseQuestions` (`:122`); `AnswerOverride` from Task 1.
- Produces:
  - `Fact.conflicts_with?: readonly string[]` — optional, emitted only when non-empty
  - `nextQuestionId(runDir: string): string`
  - `raiseConflictQuestion(args: RaiseConflictArgs): RaisedConflict` where `RaisedConflict = { q: string; fact: string; conflictsWith: string; score: number }`
  - `CapturedAnswer.conflict?: RaisedConflict` (and the same on `SupersededAnswer`), which the CLI prints
  - the `fact.conflict_raised` event type, which Task 4's replay case and every ledger reader must tolerate

### The measured problem

`conflictOf` has exactly **one** call site — `distill.ts:81`, inside `keep()`. `grep -rn 'findDuplicate\|conflictOf' src/` finds nothing under `src/core/answers/`. So two answers that disagree are both appended, both `isLive`, and both handed to the next sub-agent through `renderFacts` with nothing saying they disagree.

**What the check catches, and what it does not — measured, because the difference decides whether ask (3) is served.** `conflictOf` → `findDuplicate(claim.match, claim.area, facts, 0.6)`; `findDuplicate` (`src/core/facts/findDuplicate.ts:42-60`) **skips every fact whose `area` differs** (`:52`) and scores `jaccard(tokenize(<the new question's title>), tokenize(<the existing fact's whole "title — answer" text>))`.

- It **catches** a question in the SAME area re-answered differently without `--supersede`. Nothing checks that today.
- It **does not catch** #169's motivating case — three *different* questions whose *answers* are incompatible, not necessarily in one area. No threshold moves that: lowering it manufactures false positives without acquiring the semantic link.
- **So ask (3) is PARTLY served, and the test suite says so** rather than letting a reader take "the contradiction check now runs" to mean more than it does.

**The false-positive rate is not measured and this plan does not pretend otherwise.** No labelled corpus exists in this repo (demo fixtures are synthetic by `assertSynthetic`). The protocol, written down now so it is not reinvented: replay every `question.answered` event in a real workspace's `events.jsonl` through the check against the `facts.yml` state at that moment, and have a human label each raise; **precision** — raises a human agrees are real contradictions, over all raises — is the number. Until it exists, the check may gate nothing. Put that paragraph in the new test file's header.

**Correction to the spec, measured.** Spec §3.1 says the raised block is minted "through the existing renderer `renderQuestions` (`distill/renderDistill.ts:143`)". It cannot be: `renderQuestions(runId, phase, at, conflicts)` renders a WHOLE file — it opens `# Questions — <phase> — run <id>` and numbers ids `Q${i + 1}` from 1 (`renderDistill.ts:149-151`), so appending its output to an existing `questions.md` duplicates the H1 and collides with the existing `Q1`. The canonical single-block renderer is `renderQuestionBlock` (`questions.ts:243`), whose own docstring says it is "used when authoring a block". This task uses that one. See `## Notes for the controller`.

### The golden statement

**Expected: no golden byte moves.** No golden scenario runs `tldrx answer`, so `fact.conflict_raised` never fires and no `conflicts_with` is ever rendered; the four scenarios carry zero facts. The artifacts that WOULD move if the renderer changed for the ABSENT case are the six prompt files; the ones that would move if a new event fired in Build are `headless-events.txt`, `insession-events.txt`, `rounds-events.txt`, `refused-events.txt`.

- [ ] **Step 1: Write the failing tests**

Create `test/answer-conflict.test.ts` (in process, like Task 1's file — say so in the header, with the false-positive protocol paragraph above):

```ts
describe("a contradicting answer RAISES — it never refuses", () => {
  test("the answer stands, exit 0, and a §2.7 question names both facts", async () => {
    const ws = runWorkspace();
    // F001 already on record, same area, and the new question's title overlaps
    // its text well past Jaccard 0.6.
    seedFact(ws, { id: "F001", area: "data-model", fact: "Where does leaderboard state live? — Redis" });
    writeQuestions(ws, "01-what", block("Q1", "Where does leaderboard state live?", "data-model"));

    expect(await answerCommand.run(["Q1", "Postgres", "--root", ws.root])).toBe(0);

    const facts = FactsStore.loadOrEmpty(factsPath(ws.root)).facts;
    const fresh = facts.find((f) => f.source.q === "Q1");
    expect(fresh?.fact).toContain("Postgres");            // the answer STANDS
    expect(fresh?.conflicts_with).toEqual(["F001"]);

    const raised = parseQuestions(readFileSync(questionsPath(ws, "01-what"), "utf8")).blocks;
    const q2 = raised.find((b) => b.id === "Q2");
    expect(q2, "a new question block was minted").toBeDefined();
    expect(q2?.metadata?.status).toBe("open");
    expect(q2?.metadata?.area).toBe("data-model");
    expect(q2?.title).toContain("F001");
    expect(q2?.whyAsked ?? "").toContain(fresh?.id ?? "");
  });

  test("the id does not collide with the ids already in the file", async () => {
    // `locateQuestion` (answer.ts:120-126) scans every phase for a qid, so a
    // duplicate id across two files makes the wrong block answerable.
    const ws = runWorkspace();
    seedFact(ws, { id: "F001", area: "data-model", fact: "Where does leaderboard state live? — Redis" });
    writeQuestions(ws, "01-what", block("Q1", "Where does leaderboard state live?", "data-model"));
    writeQuestions(ws, "02-how", block("Q7", "Unrelated", "delivery"));

    await answerCommand.run(["Q1", "Postgres", "--root", ws.root]);

    const ids = parseQuestions(readFileSync(questionsPath(ws, "01-what"), "utf8")).blocks.map((b) => b.id);
    expect(ids).toContain("Q8");
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("one fact.conflict_raised event, with both ids and the score", async () => {
    const ws = runWorkspace();
    seedFact(ws, { id: "F001", area: "data-model", fact: "Where does leaderboard state live? — Redis" });
    writeQuestions(ws, "01-what", block("Q1", "Where does leaderboard state live?", "data-model"));

    await answerCommand.run(["Q1", "Postgres", "--root", ws.root]);

    const raised = eventsOf(ws).filter((e) => e.type === "fact.conflict_raised");
    expect(raised).toHaveLength(1);
    expect(raised[0]?.payload).toMatchObject({ conflicts_with: "F001", q: "Q1" });
    expect(typeof raised[0]?.payload.score).toBe("number");
  });

  test("an IDENTICAL answer is agreement, and raises nothing", async () => {
    // `conflictOf`'s own rule (`distill.ts:163`): identical text is agreement,
    // not contradiction.
    const ws = runWorkspace();
    seedFact(ws, { id: "F001", area: "data-model", fact: "Where does leaderboard state live? — Redis" });
    writeQuestions(ws, "01-what", block("Q1", "Where does leaderboard state live?", "data-model"));

    await answerCommand.run(["Q1", "Redis", "--root", ws.root]);

    expect(FactsStore.loadOrEmpty(factsPath(ws.root)).facts.find((f) => f.source.q === "Q1")?.conflicts_with)
      .toBeUndefined();
    expect(eventsOf(ws).some((e) => e.type === "fact.conflict_raised")).toBe(false);
  });

  test("the limit is a recorded property, not a surprise: differently-titled answers in two areas raise nothing", () => {
    // #169's own transcript is three DIFFERENT questions whose ANSWERS
    // contradict (F030 token revocation, F031 "exactly ONE token", F033
    // cancel_account is reversible). `findDuplicate` skips a fact whose `area`
    // differs (`findDuplicate.ts:52`) and scores the new QUESTION's title
    // against the old fact's text — so this check cannot see them, and no
    // threshold makes it. Ask (3) is partly served, and this is the pin that
    // keeps that honest.
    const facts = [
      liveFact({ id: "F030", area: "auth", fact: "May a token be revoked? — yes, at any time" }),
      liveFact({ id: "F031", area: "auth", fact: "How many tokens per account? — exactly one" }),
    ];
    expect(conflictOf({ match: "Is cancel_account reversible?", area: "billing", text: "no" }, facts)).toBeNull();
  });
});

describe("conflicts_with survives the round trip — the one C2 exists for", () => {
  test("append → emit → parse → validate keeps the field", () => {
    const ws = runWorkspace();                                   // the file's own fixture
    const store = FactsStore.loadOrEmpty(factsPath(ws.root));
    const written = store.append({
      fact: "A — B", area: "data-model", repos: [], kind: "answer", confidence: "stated",
      conflicts_with: ["F001"],
      source: { who: "t", when: "2026-09-07T00:00:00Z", run: null, q: null },
    });
    expect(written.conflicts_with).toEqual(["F001"]);            // `append` did not drop it

    const text = emitFactsYaml({ version: 1, facts: [written] });
    // UNQUOTED, and asserted that way deliberately: `yamlScalar` emits a PLAIN
    // scalar whenever PLAIN_SAFE matches (`emitFactsYaml.ts:11`), and `F001`
    // does. Forcing quotes in the emitter to make an assertion pass would change
    // the bytes of every `repos:` line in every facts.yml on disk.
    expect(text).toContain("conflicts_with: [F001]");              // `emitFact` wrote it

    const parsed = parseYaml(text);
    expect(validateFactsFile(parsed).ok).toBe(true);
    expect(asFactsFile(parsed).facts[0]?.conflicts_with).toEqual(["F001"]);
  });

  test("a row without it is byte-identical to one written before the key existed", () => {
    const plain = { /* the same fact, no conflicts_with */ };
    expect(emitFactsYaml({ version: 1, facts: [plain] })).not.toContain("conflicts_with");
  });
});
```

And in `test/facts-add.test.ts`, add one assertion to the `renderFacts` describe (`:337`), beside the two that exist:

```ts
  test("conflicts_with is named in the prompt, so a reader handed both is told they disagree", () => {
    const f = fact({ id: "F002", fact: "State lives in Postgres.", confidence: "stated" });
    expect(renderFacts([{ ...f, conflicts_with: ["F001"] }], []))
      .toBe("- [F002] State lives in Postgres. (billing · stated) · conflicts with F001");
  });
```

`test/facts-add.test.ts:338` ("a fact with no `decided_by` renders byte-identically") must stay green — read it and confirm; it is a guard here, not a proof.

- [ ] **Step 2: Run them and keep the RED verbatim**

```
bun test test/answer-conflict.test.ts test/facts-add.test.ts
```
Expected: FAIL. The round-trip test fails at `expect(written.conflicts_with).toEqual(["F001"])` with `received: undefined` — **this is the whole point of that test: `append` constructs the row key-by-key, so a `NewFact` carrying the field is dropped with NO TypeScript error and every other test in this issue would still pass.** The raise tests fail with `expect(q2, "a new question block was minted").toBeDefined()` → `received: undefined`. Paste it all.

- [ ] **Step 3: Grow the schema, the store, the emitter and the validator — in that order**

`src/core/facts/Fact.ts`, after `truncated?: boolean` (`:69`), inside `interface Fact`:

```ts
  /**
   * Facts this one was DETECTED to contradict when it was recorded (#169).
   *
   * Additive and optional, written only when non-empty — the `truncated` rule
   * above, for the same reason: a `conflicts_with: []` on every row is noise in
   * a diff nobody asked for, and it would also read as "checked and agreed".
   * Absent means the check found nothing, never that two facts were compared and
   * reconciled: the check is lexical (`conflictOf` — Jaccard ≥ 0.6 within one
   * `area`) and cannot see two differently-titled answers that disagree.
   */
  readonly conflicts_with?: readonly string[];
```

`src/core/facts/FactsStore.ts`, in `append`, immediately after the `truncated` spread (`:97`):

```ts
      // Same rule as `truncated`: written only when there is something to say.
      // This store builds the row key-by-key, so a `NewFact` carrying the field
      // and no line here is dropped with no type error at all.
      ...(input.conflicts_with !== undefined && input.conflicts_with.length > 0
        ? { conflicts_with: [...input.conflicts_with] }
        : {}),
```

`supersede` needs no edit: it delegates (`:135`, `const replacement = this.append({ ...input, supersedes: oldId });`) — say that in the commit, because the spec expected two writers.

`src/core/facts/emitFactsYaml.ts`, in `emitFact`, directly after the `truncated` push (`:94`) and BEFORE the `retired` branch:

```ts
  // Written only when non-empty, for `truncated`'s reason and one more: an
  // emitted `conflicts_with: []` would claim a check ran and cleared the row.
  if (fact.conflicts_with !== undefined && fact.conflicts_with.length > 0) {
    lines.push(`${inner}conflicts_with: ${inlineList(fact.conflicts_with)}`);
  }
```

`src/core/facts/validateFactsFile.ts`, after the `truncated` block (`:105-109`):

```ts
    // Additive, so absence is fine and only a wrong shape is an issue — a row
    // written before the field existed must keep validating. An EMPTY list is
    // refused rather than tolerated: on disk it would say a check ran and found
    // nothing, which is exactly what absence must not be read as.
    if (row.conflicts_with !== undefined) {
      if (requireArray(row.conflicts_with, `${path}.conflicts_with`, issues)) {
        const links = row.conflicts_with as unknown[];
        if (links.length === 0) {
          issues.push({
            path: `${path}.conflicts_with`,
            message: "expected at least one fact id, or the key absent",
          });
        }
        links.forEach((id, i) => requireString(id, `${path}.conflicts_with[${i}]`, issues));
      }
    }
```

`requireArray` and `requireString` are already imported (`validateFactsFile.ts:7-10`).

`src/core/facilitator/prompt.ts`, in `renderFacts`'s `.map` (`:417-421`):

```ts
      const decidedBy = fact.source.decided_by === undefined ? "" : ` · decided by ${fact.source.decided_by}`;
      // Detected contradictions, named — a prompt handed both facts is told they
      // disagree instead of being left to pick one.
      const conflicts = fact.conflicts_with === undefined || fact.conflicts_with.length === 0
        ? ""
        : ` · conflicts with ${fact.conflicts_with.join(", ")}`;
      return `- [${fact.id}] ${fact.fact} (${fact.area} · ${fact.confidence})${decidedBy}${conflicts}`;
```

Extend the docstring above it with one sentence saying `conflicts_with` is rendered here and that absence means "not detected".

- [ ] **Step 4: Narrow `conflictOf`'s parameter, and move nothing**

`src/core/distill/distill.ts:160-164`. Keep the function where it is — one definition, and moving it is scope no issue asked for. Change only the parameter type and extend the docstring:

```ts
/**
 * A claim contradicts a fact when they are about the same `area`, overlap at
 * Jaccard ≥ 0.6, and are not the same sentence (spec §6 / §4's re-ask rule reused).
 * Identical text is agreement, not contradiction — it is imported and left alone.
 *
 * The parameter is STRUCTURAL rather than `ImportedClaim` so the answer path can
 * call it without minting one: `{match, area, text}` is everything it reads, and
 * `ImportedClaim` satisfies it, so every existing caller compiles unchanged.
 * What it can and cannot see is measured in `test/answer-conflict.test.ts` —
 * `findDuplicate` skips a differing `area` and scores the QUESTION's title
 * against the fact's whole text.
 */
export function conflictOf(
  claim: { readonly match: string; readonly area: string; readonly text: string },
  facts: readonly Fact[],
): DuplicateHit | null {
```

- [ ] **Step 5: Write the raise leaf**

Create `src/core/answers/raiseConflict.ts`:

```ts
/**
 * The §2.7 question a detected contradiction raises (#169).
 *
 * It RAISES; it never refuses. The answer stands, the command exits 0, and the
 * disagreement becomes a block a person can answer — the issue's own words,
 * "Raise, do not refuse". A refusal here could deadlock an unattended run over a
 * lexical near-match nobody has measured a false-positive rate for.
 *
 * The block is rendered through `renderQuestionBlock` (`text/questions.ts:243`),
 * which is the canonical §2.7 authoring renderer and the ONE implementation of
 * the block. `renderDistill.renderQuestions` is deliberately NOT used: it renders
 * a whole FILE, opening with an H1 and numbering ids from `Q1`, so appending its
 * output to a file that already has a Q1 would mint a duplicate id — and
 * `answer.ts`'s `locateQuestion` scans every phase for an id, so a duplicate
 * makes the wrong block answerable.
 *
 * Ids are minted across the WHOLE run, not the file, for that same reason.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseQuestions, renderQuestionBlock } from "../text/questions.ts";
import { QUESTION_PHASES } from "../run/questionCards.ts";

export interface RaisedConflict {
  /** The id of the question this raised. */
  readonly q: string;
  /** The fact just recorded. */
  readonly fact: string;
  /** The fact it was detected to contradict. */
  readonly conflictsWith: string;
  readonly score: number;
}

export interface RaiseConflictArgs {
  readonly runDir: string;
  /** The `questions.md` the answered block lives in — the block is appended here. */
  readonly questionsPath: string;
  readonly area: string;
  readonly askedBy: string;
  readonly at: string;
  readonly newFactId: string;
  readonly oldFactId: string;
  readonly oldFactText: string;
  readonly score: number;
  /** The question whose answer triggered this. */
  readonly answeredQ: string;
}

/**
 * The next free `Qn` across every phase's `questions.md` in the run.
 *
 * Run-wide, not per file: `answer.ts:120-126` resolves an id by scanning every
 * phase and taking the first hit, so two files sharing an id make one of them
 * unanswerable.
 */
export function nextQuestionId(runDir: string): string {
  let highest = 0;
  for (const phase of QUESTION_PHASES) {
    const path = join(runDir, phase, "questions.md");
    if (!existsSync(path)) continue;
    let blocks;
    try {
      blocks = parseQuestions(readFileSync(path, "utf8")).blocks;
    } catch {
      continue;   // an unreadable file cannot lend us an id; it is reported elsewhere
    }
    for (const block of blocks) {
      const n = Number.parseInt(block.id.slice(1), 10);
      if (Number.isFinite(n) && n > highest) highest = n;
    }
  }
  return `Q${String(highest + 1)}`;
}

export function raiseConflictQuestion(args: RaiseConflictArgs): RaisedConflict {
  const id = nextQuestionId(args.runDir);
  const block = renderQuestionBlock({
    id,
    title: `Which is right about ${args.area}: ${args.newFactId} or ${args.oldFactId}?`,
    metadata: {
      id, status: "open", area: args.area, asked_by: args.askedBy, asked_at: args.at, extra: [],
    },
    metadataIndex: -1,
    whyAsked:
      `answering ${args.answeredQ} recorded ${args.newFactId}, which overlaps ${args.oldFactId} `
      + `at Jaccard ${args.score.toFixed(2)} in the same area and says something different — `
      + `${args.oldFactId}: "${args.oldFactText}" [src: ${args.oldFactId}]`,
    whySrc: null,
    options: [
      { letter: "A", text: `${args.newFactId} is right — supersede ${args.oldFactId}` },
      { letter: "B", text: `${args.oldFactId} is right — supersede ${args.newFactId}` },
      { letter: "C", text: "Both are partly right — write the correction below" },
    ],
    answer: "",
    answerIndex: -1,
    footer: null,
    startLine: -1,
    lines: [],
  });
  appendFileSync(args.questionsPath, `\n${block}\n`, "utf8");
  return { q: id, fact: args.newFactId, conflictsWith: args.oldFactId, score: args.score };
}
```

Check `QuestionOption`'s and `QuestionMetadata`'s exact field names in `src/core/text/questions.ts:18-32` before writing this — copy them, do not infer them.

- [ ] **Step 6: Wire it into both answer paths**

In `captureAnswers.ts`, inside `FactsStore.update`, immediately before `store.append`:

```ts
      // Advisory (#169). It RAISES and never refuses, so it runs before the
      // append only to get the link onto the row being written — the answer
      // stands either way. `conflictOf` is the one implementation and the
      // threshold is its own constant; a second number here would be a second
      // derivation of "these two disagree".
      const clash = conflictOf({ match: block.title, area, text: block.answer }, store.active);
```

then add `...(clash === null ? {} : { conflicts_with: [clash.fact.id] }),` to the `store.append({...})` object, and record the pair for after the write:

```ts
      if (clash !== null) clashes.push({ block, factId: fact.id, hit: clash });
```

with `const clashes: { block: QuestionBlock; factId: string; hit: DuplicateHit }[] = [];` declared beside `recorded` (`:92`).

After `writeFileSync(questionsPath, serializeQuestions(doc), "utf8")` (`:133`) — the raise must come after, because it appends to the same file:

```ts
  const raised = new Map<string, RaisedConflict>();
  for (const clash of clashes) {
    const conflict = raiseConflictQuestion({
      runDir: ctx.runDir,
      questionsPath,
      area: clash.block.metadata?.area ?? "unscoped",
      askedBy: ctx.actor,
      at: ctx.at,
      newFactId: clash.factId,
      oldFactId: clash.hit.fact.id,
      oldFactText: clash.hit.fact.fact,
      score: clash.hit.score,
      answeredQ: clash.block.id,
    });
    raised.set(clash.block.id, conflict);
    log.tryAppend({
      ts: ctx.at, run: ctx.run, stage: null, type: "fact.conflict_raised", actor: ctx.actor, cost_usd: 0,
      payload: { fact: clash.factId, conflicts_with: clash.hit.fact.id, score: clash.hit.score, q: clash.block.id },
    });
  }
```

and put `conflict: raised.get(...)` onto each `CapturedAnswer` (widen the interface with `readonly conflict?: RaisedConflict;`). Because `captured.push` happens inside the lock and the raise after it, build the returned array from `recorded`/`clashes` after the loop, or map over `captured` — whichever keeps the function readable; do not compute the conflict twice.

Do the same in `supersedeAnswer`, with one difference stated in a comment: a supersession names the fact it replaces, so `conflictOf` runs against `store.active` **after** the head is resolved and a hit on the very fact being superseded is not a contradiction — skip `clash.fact.id === head.id`.

- [ ] **Step 7: Open the event enum, and give replay a line**

`src/core/events/Event.ts:119` — the `"fact.added", "fact.retired", "fact.superseded", "doc.superseded",` line becomes:

```ts
  "fact.added", "fact.retired", "fact.superseded", "fact.conflict_raised", "doc.superseded",
```

`src/core/replay/renderReplay.ts`, in `bullet`'s switch beside `case "fact.superseded"` (`:196`):

```ts
    case "fact.conflict_raised":
      return `${prefix}fact ${text(payload.fact)} contradicts ${text(payload.conflicts_with)} `
        + `(Jaccard ${text(payload.score)}) — raised as ${q || "a question"}`;
```

**Why a case rather than nothing:** `bullet` ends in `default: return null` (`renderReplay.ts:215`), so an unlisted type renders no line at all. An honesty guard that is invisible in `tldrx replay` is a weak guard. Same treatment for the other two new types in Tasks 3 and 7. Read `readReviewLedger` (`src/core/build/reviewLedger.ts:133`, whose type matching is at `:189-241`) and confirm it matches on `story.reopened` / `story.review_retried` / `task.started` / `agent.spawned` / `task.done` and ignores everything else — an unknown type reaches no branch there. Add one assertion in `test/answer-conflict.test.ts` that a run carrying the new event still replays and still reads its ledger.

- [ ] **Step 8: Say it on stdout**

In `src/cli/commands/answer.ts`, after the success line, before the "no decider" note:

```ts
      if (recorded.conflict !== undefined) {
        process.stdout.write(
          `  ${recorded.conflict.fact} contradicts ${recorded.conflict.conflictsWith} `
          + `(Jaccard ${recorded.conflict.score.toFixed(2)}) — raised as ${recorded.conflict.q}. `
          + `The answer stands; nothing was refused.\n`,
        );
      }
```

- [ ] **Step 9: Run the named tests, then prove teeth**

```
bun test test/answer-conflict.test.ts test/facts-add.test.ts test/distill.test.ts test/text.test.ts test/replay.test.ts
```
Expected: PASS. `test/distill.test.ts:147` and `:286` stay green — `conflictOf` neither moved nor changed behaviour; `test/text.test.ts:579` (`findDuplicate`, Jaccard ≥ 0.6) is untouched.

Teeth, both directions: delete the `conflicts_with` line from `emitFact` — the round-trip test goes RED at the `toContain` while `append`'s own assertion still passes, which is exactly the drop this pin exists to catch. Revert. Then make `raiseConflictQuestion` reuse `Q${1}` — the id-collision test goes RED. Revert. Keep both.

- [ ] **Step 10: Golden, full gate, commit**

```
bun test test/build-golden.test.ts
echo "golden: $?"
```
```
bun run typecheck
echo "typecheck: $?"
```
```
bun test
echo "test: $?"
```
Expected: `0`, `0`, `0`.

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(answer): the contradiction check runs on the answer path, and raises (#169)

`conflictOf` existed with exactly one call site — `distill.ts:81` — so two
answers that disagree were both appended, both live, and both handed to the next
sub-agent with nothing saying so. It now runs on both answer paths at its own
`CONFLICT_THRESHOLD` (the same constant; a second number would be a second
derivation of "these two disagree"). On a hit the answer STANDS and the command
exits 0: a §2.7 question is minted naming both facts, the new fact carries
`conflicts_with`, `renderFacts` appends `· conflicts with F031`, and one
`fact.conflict_raised` is appended. It raises; it never refuses.

What it catches, measured: the same question answered a second time,
differently, in the same area, without `--supersede`. What it does NOT catch,
also measured and pinned by a test: #169's own transcript — three differently
titled answers that contradict semantically, across areas. `findDuplicate` skips
a differing area and scores the question's TITLE against the fact's text, and no
threshold changes that. Ask (3) is partly served and the suite says so; the
false-positive rate is unmeasured and the protocol for measuring one is written
into the test file, because until that number exists this check may gate nothing.

`conflicts_with` round-trips, which is not free: `FactsStore.append` builds the
row key-by-key, so the field was dropped with NO type error until the line was
added, and `emitFact` enumerates every emitted key. Both learned it, `supersede`
needed nothing (it delegates to `append`), and the pin is a
NewFact → append → emit → parse → validate test. An empty list is refused rather
than tolerated: on disk it would claim a check ran and cleared the row.

`renderQuestions` was NOT used to mint the block, against the spec's suggestion
and for a measured reason: it renders a whole FILE with its own H1 and numbers
ids from Q1, so appending it to a file with a Q1 mints a duplicate — and
`locateQuestion` scans every phase for an id. `renderQuestionBlock`, the
canonical §2.7 authoring renderer, is what the leaf calls, and ids are minted
run-wide.

`fact.conflict_raised` is a THIRD entry in a closed enum (`EVENT_TYPES`), so it
was added there, and `renderReplay` gained a case rather than falling to its
`default: return null` — an honesty guard invisible in replay is a weak one.

No golden byte moves: no scenario runs `tldrx answer`, and all four carry zero
facts.

RED kept:
<paste Step 2 verbatim>

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: #169 — the close and the Build handoff say how many decisions name a decider

**Files:**
- Create: `src/core/facts/decidedTally.ts`
- Modify: `src/core/run/closeRun.ts` — `RunCloseOutcome` (`:116-125`), `closeRun` (`:130-144`), beside `describeOpenQuestions` (`:198-205`)
- Modify: `src/core/facilitator/runNext.ts:1746`, `src/cli/commands/run.ts:444`, `src/cli/commands/approve.ts:101` — the three close routes that print `describeOpenQuestions(closed.openQuestions)`
- Modify: `src/core/build/handoff.ts` — `BuildHandoffParts` (`:56-85`) and the header line (`:93-95`)
- Modify: `src/core/facilitator/executors/build.ts:2303-2314` — the `renderBuildHandoff({...})` call
- Test: `test/close-open-questions.test.ts` (the `:125` test — **red by design is claimed by the spec and is NOT true**; see below), `test/build-executor.test.ts` and `test/ship.test.ts` — **measured: those two are the only files in `test/` that import `renderBuildHandoff`**, and there is no `test/build-handoff.test.ts`

**Interfaces:**
- Consumes: `FactsStore.loadOrEmpty(factsPath(root)).facts` (`src/hooks/lib/workspace.ts:360`); `Fact.source.run` and `Fact.source.decided_by` (`Fact.ts:26-42`).
- Produces:
  - `decidedTally(facts: readonly Fact[], runId: string): { readonly owner: number; readonly driver: number; readonly notStated: number }`
  - `describeDecidedTally(tally: DecidedTally): string | null` — null when the run recorded no facts at all
  - `RunCloseOutcome.decided: DecidedTally`
  - `BuildHandoffParts.decidedNote?: string | null`

### The measured problem

`closeRun.ts:52-60` still carries the #141 finding verbatim — §2.7 has no `default:` and no `timeout:`, and *"Nothing ages a question into an answer."* The close reports SILENCE (`describeOpenQuestions`, `:198-205`) but says nothing about the decisions that WERE made and by whom. `decided_by` is now written by the answer path (Task 1) and by `facts add`, and absent on everything else — so a count of the three states is derivable and is the honest report.

`notStated` is simply `source.decided_by === undefined`. **The absence IS the count**, which is the whole reason no `decided_by_basis` field exists: `basis: "stated"` would be exactly `decided_by !== undefined`, a second unvalidated derivation that a row could contradict.

**Correction to the spec, measured.** Spec §3.1 and §4.4 list `test/close-open-questions.test.ts:125` among "exactly three" pins that go red by design. It does not: that test ("the sentence names them AND refuses the belief that a default was coming") asserts only `toContain` — `"Q1"`, `"01-what/questions.md"`, `"Which currency?"`, `"no default"`, `"--yes-to-defaults"` — so a NEW sentence beside it changes nothing it looks at. The tally is a separate export precisely because `describeOpenQuestions` returns `null` when nothing is open (`:199`) and the tally must print on a run that answered everything. So this task's red comes from its OWN new tests, and the red-by-design set for the wave is **two**: `test/decision-cards.test.ts:314` (Task 4) and `test/docs-cli-coverage.test.ts:62` (whenever a flag is declared before its guide line lands, inside a task). See `## Notes for the controller`.

### The golden statement

**Expected: no golden byte moves.** The sentence lands in the Build handoff **header** and in the close report. `grep -rn "Cost: " test/fixtures/build/golden/` returns no match (exit 1) — the handoff is not a golden artifact — and no golden scenario closes a run. It must never reach a prompt: if it did, all six prompt artifacts move.

- [ ] **Step 1: Write the failing tests**

Add to `test/close-open-questions.test.ts` a new describe (it already has the workspace helpers):

```ts
describe("#169 — the close says how many of this run's decisions name a decider", () => {
  test("owner, driver and not-stated are counted, and absence is the count", () => {
    const facts = [
      liveFact({ id: "F001", source: { ...src("R"), decided_by: "owner" } }),
      liveFact({ id: "F002", source: { ...src("R"), decided_by: "driver" } }),
      liveFact({ id: "F003", source: src("R") }),                 // nothing said
      liveFact({ id: "F004", source: src("OTHER-RUN") }),         // another run's
    ];
    expect(decidedTally(facts, "R")).toEqual({ owner: 1, driver: 1, notStated: 1 });
  });

  test("the sentence names all three and claims no timeout mechanism", () => {
    const said = describeDecidedTally({ owner: 1, driver: 2, notStated: 3 }) ?? "";
    expect(said).toContain("6");
    expect(said).toContain("3");
    // It must not imply a default fired: nothing ages a question into an answer
    // (`closeRun.ts:52-60`), and a row with no decider says "not stated".
    expect(said).toContain("not stated");
    expect(said).not.toContain("default");
  });

  test("a run that recorded no facts says nothing rather than a confident zero", () => {
    expect(describeDecidedTally({ owner: 0, driver: 0, notStated: 0 })).toBeNull();
  });

  test("closing a run carries the tally, and changes no exit code", async () => {
    const ws = workspace();
    seedFact(ws, { id: "F001", run: ws.runId, decided_by: "owner" });
    const closed = await close(ws);
    expect(closed.decided).toEqual({ owner: 1, driver: 0, notStated: 0 });
  });
});
```

And in `test/build-executor.test.ts` — the `renderBuildHandoff` home — one test: `renderBuildHandoff` with `decidedNote: "3 decision(s) recorded: 1 owner, 0 driver, 2 not stated"` puts it on the header line after the cost, and with `decidedNote: null` the header is byte-identical to today's.

- [ ] **Step 2: Run them and keep the RED verbatim**

```
bun test test/close-open-questions.test.ts
```
Expected: FAIL — `Cannot find module '../src/core/facts/decidedTally.ts'`. Paste it.

- [ ] **Step 3: Write the leaf**

Create `src/core/facts/decidedTally.ts`:

```ts
/**
 * How many of a run's recorded decisions name who decided them (#169 ask 4).
 *
 * It is a REPORT, on the standing precedent of the #141 close sentence
 * (`closeRun.ts:72-75`): it changes no exit code, blocks no close and writes not
 * one byte. It never claims a timeout-default mechanism exists — there is none
 * (`closeRun.ts:52-60`, measured: §2.7 declares no `default:` and no `timeout:`).
 * It says how many of this run's facts name a decider and how many do not.
 *
 * `notStated` is `source.decided_by === undefined`, and that is the whole
 * argument against a second field: a `decided_by_basis` would re-derive exactly
 * this, could contradict the row it sits on, and could not carry the REASON a
 * particular row has none — only prose can, and `tldrx answer` prints it.
 */
import { type Fact } from "./Fact.ts";

export interface DecidedTally {
  readonly owner: number;
  readonly driver: number;
  /** No `decided_by` on the row. "Not stated", never "owner". */
  readonly notStated: number;
}

export function decidedTally(facts: readonly Fact[], runId: string): DecidedTally {
  let owner = 0;
  let driver = 0;
  let notStated = 0;
  for (const fact of facts) {
    if (fact.source.run !== runId) continue;
    if (fact.source.decided_by === "owner") owner += 1;
    else if (fact.source.decided_by === "driver") driver += 1;
    else notStated += 1;
  }
  return { owner, driver, notStated };
}

/** The one sentence both readers print, or null when this run recorded nothing. */
export function describeDecidedTally(tally: DecidedTally): string | null {
  const total = tally.owner + tally.driver + tally.notStated;
  if (total === 0) return null;
  return `${String(total)} decision(s) recorded on this run: ${String(tally.owner)} owner, `
    + `${String(tally.driver)} driver, ${String(tally.notStated)} not stated. `
    + "A row with no decider says \"not stated\" — it is never read as the owner's.";
}
```

- [ ] **Step 4: Carry it on the close, and print it on all three routes**

`closeRun.ts`: add `readonly decided: DecidedTally;` to `RunCloseOutcome` with a docstring saying it is a report; in `closeRun`, beside `const openQuestions = collectOpenQuestions(runDir);`:

```ts
  // Read from the same file every prompt reads, before the state commit, for the
  // same reason the questions are: the report describes the run as it was asked
  // about. Nothing here writes.
  const decided = decidedTally(FactsStore.loadOrEmpty(factsPath(root)).facts, runId);
```

and return it. Then at each of the three printers — `runNext.ts:1746`, `run.ts:444`, `approve.ts:101` — add the sibling line immediately after the existing `asked` handling, in that file's own idiom:

```ts
  const decided = describeDecidedTally(closed.decided);
  if (decided !== null) lines.push(decided);
```

Read each call site first: `approve.ts:101` guards on `outcome.closed === null`, so the tally is derived inside the same guard.

- [ ] **Step 5: Put it on the Build handoff header**

`src/core/build/handoff.ts`, in `BuildHandoffParts` after `costNote` (`:69`):

```ts
  /**
   * How many of this run's recorded decisions name a decider (#169) — the same
   * sentence the close prints, on the header rather than as a `## Decisions`
   * bullet. Deliberately the header: every list item in a §2.8 section must
   * carry a `[src: …]` token or `claim-sources` refuses the document, and a
   * count over a whole file has no one line to cite.
   *
   * Absent or null means the run recorded no facts, and the header says nothing.
   */
  readonly decidedNote?: string | null;
```

and in the header line (`:93-95`), after the cost clause and before ` · ${parts.at}`:

```ts
      `${parts.costNote == null ? "" : ` (${parts.costNote})`}` +
      `${parts.decidedNote == null ? "" : ` · ${parts.decidedNote}`} · ${parts.at}`,
```

In `build.ts:2303-2314`, add `decidedNote: describeDecidedTally(decidedTally(FactsStore.loadOrEmpty(factsPath(this.ctx.root)).facts, this.ctx.runId)),` to the object. The executor stays an orchestrator: it reads a value and passes it; no derivation is added here. Confirm `this.ctx` carries `root` and `runId` — if it does not, thread the value in from where the facts are already loaded for `renderFacts` (`build.ts:302`, `:2546`) rather than adding a second load.

- [ ] **Step 6: Run the named tests, prove teeth, gate and commit**

```
bun test test/close-open-questions.test.ts test/build-executor.test.ts test/ship.test.ts test/facts-add.test.ts
```
Expected: PASS. `:125` is a GUARD here, not a proof — it stays green because it asserts only `toContain`.

Teeth: change `if (fact.source.run !== runId) continue;` to count every fact — the four-fact test goes RED on `owner: 1` vs another run's row. Revert.

```
bun test test/build-golden.test.ts
echo "golden: $?"
```
```
bun run typecheck
echo "typecheck: $?"
```
```
bun test
echo "test: $?"
```
Expected: `0`, `0`, `0`.

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(close): a run close and the Build handoff say who decided (#169)

The #141 report says what nobody answered. Nothing said what WAS decided, or by
whom — so `decidedTally` counts this run's facts into owner / driver / not
stated and one sentence is printed by the close's three routes and put on the
Build handoff header beside `Cost:`. `notStated` is `decided_by === undefined`:
the absence IS the count, which is exactly why no `decided_by_basis` field
exists — it would re-derive this, could contradict the row it sits on, and could
not carry the reason a row has none.

It is a REPORT, on `closeRun.ts:72-75`'s standing precedent: no exit code moves,
no close is blocked, not one byte is written. It never claims a timeout default
exists, because none does.

It is on the handoff HEADER rather than in `## Decisions` deliberately: every
bullet in a §2.8 section must carry a `[src: …]` token or `claim-sources`
refuses the document, and a count over a whole file has no line to cite.

Correction to the spec, measured: `test/close-open-questions.test.ts:125` was
listed as red-by-design and is not — it asserts only `toContain`, so a new
sentence beside it changes nothing it reads. The red here is this change's own
new tests.

No golden byte moves — `grep -rn "Cost: " test/fixtures/build/golden/` returns
no match; the handoff is not a golden artifact and no scenario closes a run.

RED kept:
<paste Step 2 verbatim>

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: #171 — `tldrx story widen`, the verb the card has been pointing at

**Files:**
- Create: `src/core/run/widenStory.ts`
- Modify: `src/core/build/storyFile.ts` — `StoryPatch` (`:17-21`), `applyPlanPatch` (`:48-53`), a `replaceTouches` beside `replaceEvidence` (`:68-79`)
- Modify: `src/cli/commands/story.ts` — the docstring (`:1-18`), `usage` (`:32`), the dispatch (`:35-39`)
- Modify: `src/core/run/decisionCards.ts:105` — `"widen the scope: add the path to a story's \`touches:\`, or cite it in a handoff, then re-run the stage",`
- Modify: `src/core/events/Event.ts:114` — `"story.reopened", "story.base_fastforwarded", …` gains `"story.touches_widened"`
- Modify: `src/core/replay/renderReplay.ts` — one `case`
- Modify: `src/cli/helpText.ts` — the `story` entry (`:731-761`): `subcommands: ["reopen", "widen"]` at `:732`, flags scoped with `sub:`, no new exit code (`:753` already declares `EXIT_GATE_REFUSED`)
- Modify: `docs/guide/08-cli-reference.md` — the `## \`tldrx story\`` section names `--path` and the `widen` subcommand
- Test: `test/story-widen.test.ts` (new, **spawning** — it needs a real Build workspace for the boundary proof), `test/decision-cards.test.ts:314` (**red by design**), `test/story-reopen.test.ts:409` (read, stays green), `test/boundary.test.ts:266` (read; the widen proof is a sibling in the new file), `test/plan-schema-contract.test.ts:101` / `:210` (read, stay green)

**Interfaces:**
- Consumes: `updateStoryFront` / `applyPlanPatch` (`storyFile.ts:30`, `:48`); `updateImplicitPlan` (`src/core/build/implicitPlan.ts`); `buildProgress`, `RunStore.resolve`, `ambiguousRunLines`, `validateEvent` — all as `reopenStory.ts:99-260` uses them; `MAX_TOUCHES = 128` (`src/core/schemas/planCommon.ts:39`).
- Produces: `StoryPatch.touches?: readonly string[]`; `widenStory(options: WidenOptions): WidenOutcome` with `WidenOptions = {root, storyId, paths, note, runId?, actor, at}` and `WidenOutcome = {code: number, lines: readonly string[]}`; the `story.touches_widened` event with payload `{story, paths, note, before, after}`.

### The measured problem

`decisionCards.ts:105` tells the operator to *"add the path to a story's `touches:`"* while `story.ts:8-9` says *"`run.yml` and the story files are the state (spec §1) and hand-editing them is forbidden by design."* `StoryPatch` has exactly two keys (`storyFile.ts:17-21`) and `tldrx story` exactly one subcommand (`story.ts:36`). No TS function writes a `touches:` line.

**No format change.** `touches` is already required, non-empty and capped at 128 (`schemas/story.ts:35`, `:66-69`); appending changes a value. `STORY_KEYS` is untouched, so `test/plan-schema-contract.test.ts:101`/`:210` stay green. The RECORD of the widening is the additive part: a new event type.

**The gate needs no change.** `deriveSurface` reads story `touches:` off disk at evaluation time (`boundary.ts:262-268` via `storyTouches` at `:189`), so a widened story makes auto-gate condition 7 pass on the next evaluation with zero boundary code touched.

**Statuses.** `todo`, `in_progress`, `review` and `blocked` may be widened. A `done` story **refuses**, naming `tldrx story reopen <id> --for-fix`: a done story has evidence written against the surface it declared, and widening it afterwards would make the record say the plan declared something it did not.

**Exit family: 2.** `reopenStory.ts:82-83` is `/** Spec §3: \`refused\`. Every one of this verb's own refusals is a refusal to act. */ const EXIT_REFUSED = 2;` and `refuse()` (`:362-364`) returns it for the empty id, the missing note, the unknown story, the `done` story and the ambiguous run. `test/story-reopen.test.ts:371` is titled *"an unknown run id is not found (3), not refused (2)"*; `:395-400` asserts `toBe(2)`; the only **1** is the dispatch error at `story.ts:38`, pinned at `:409-414`. Widen matches its sibling.

### The golden statement

**Expected: no golden byte moves.** The verb never fires in the four scenarios, so `story.touches_widened` never appears and no story file in a fixture is widened. The artifacts that WOULD move if this leaked into the Build path are `*-run-tasks.txt` and `*-events.txt`.

- [ ] **Step 1: Write the failing tests**

Create `test/story-widen.test.ts`. It spawns (it uses the Build workspace fixture for the boundary proof), so its header carries:

```ts
import { setDefaultTimeout } from "bun:test";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";
setDefaultTimeout(spawnTestTimeout());
```

Model the arc on `test/story-reopen.test.ts:520`'s `--for-fix` describe and the boundary fixture in `test/boundary.test.ts:266`.

```ts
describe("tldrx story widen — the sanctioned way to grow a story's surface", () => {
  test("the path lands in touches:, and the front matter is otherwise byte-identical", () => {
    const ws = planWorkspace();                       // S1 touches ["src/in.ts"]
    const before = readFileSync(storyPath(ws, "S1"), "utf8");

    const out = widenStory({ ...base(ws), storyId: "S1", paths: ["platform/Auth.cs"], note: "the defect is here" });

    expect(out.code).toBe(0);
    const after = readFileSync(storyPath(ws, "S1"), "utf8");
    expect(touchesOf(after)).toEqual(["src/in.ts", "platform/Auth.cs"]);
    // Surgical, like `evidence`: nothing else in the file moves.
    expect(bodyOf(after)).toBe(bodyOf(before));
    expect(statusOf(after)).toBe(statusOf(before));
  });

  test("it is recorded: story.touches_widened carries before, after and the note", () => {
    const ws = planWorkspace();
    widenStory({ ...base(ws), storyId: "S1", paths: ["platform/Auth.cs"], note: "the defect is here" });
    const [event] = eventsOf(ws).filter((e) => e.type === "story.touches_widened");
    expect(event?.payload).toMatchObject({
      story: "S1", paths: ["platform/Auth.cs"],
      before: ["src/in.ts"], after: ["src/in.ts", "platform/Auth.cs"],
      note: "the defect is here",
    });
  });

  test("a widened story turns the boundary refusal into a pass", async () => {
    // The other half of `test/boundary.test.ts:266` ("a path nobody scoped
    // refuses the gate and is NAMED"): declare it, and the same run passes.
    const ws = buildWorkspace(DECLARED);
    process.env.FAKE_BUILD_WRITE = JSON.stringify({
      S1: { "src/in.ts": "export const after = 2;\n", "platform/Auth.cs": "// nobody scoped this\n" },
    });
    const refused = await next(ws);
    expect(refused.outcome.lines.join("\n")).toContain("outside the surface");

    widenStory({ ...base(ws), storyId: "S1", paths: ["platform/Auth.cs"], note: "the defect is here" });

    const again = await evaluateBoundaryFor(ws);
    expect(again.outside).toEqual([]);
  });
});

describe("what widen refuses, and with which code", () => {
  test("a done story is refused (2) and the refusal names --for-fix", () => {
    const ws = planWorkspace({ S1: "done" });
    const out = widenStory({ ...base(ws), storyId: "S1", paths: ["a.ts"], note: "n" });
    expect(out.code).toBe(2);
    expect(out.lines.join("\n")).toContain("--for-fix");
  });

  test("an unknown story, a missing --note and a path already declared are each 2", () => {
    const ws = planWorkspace();
    expect(widenStory({ ...base(ws), storyId: "S9", paths: ["a.ts"], note: "n" }).code).toBe(2);
    expect(widenStory({ ...base(ws), storyId: "S1", paths: ["a.ts"], note: "" }).code).toBe(2);
    expect(widenStory({ ...base(ws), storyId: "S1", paths: ["src/in.ts"], note: "n" }).code).toBe(2);
  });

  test("more than MAX_TOUCHES entries is refused (2), and nothing is written", () => {
    const ws = planWorkspace();
    const before = readFileSync(storyPath(ws, "S1"), "utf8");
    const many = Array.from({ length: 200 }, (_, i) => `src/f${String(i)}.ts`);
    expect(widenStory({ ...base(ws), storyId: "S1", paths: many, note: "n" }).code).toBe(2);
    expect(readFileSync(storyPath(ws, "S1"), "utf8")).toBe(before);
  });

  test("an unknown run is NOT FOUND (3), not refused (2)", () => {
    const ws = planWorkspace();
    expect(widenStory({ ...base(ws), storyId: "S1", paths: ["a.ts"], note: "n", runId: "nope" }).code).toBe(3);
  });

  test("through the command: a subcommand that is neither reopen nor widen is a usage error (1)", async () => {
    expect(await storyCommand.run(["unblock", "S1"])).toBe(1);
  });
});
```

Also change `test/decision-cards.test.ts:314` **now**, to the exact string the card will print, and keep its RED:

```ts
      "  tldrx story widen <id> <path> --note \"<why>\" — or cite the path in a handoff, then re-run the stage",
```

A PLACEHOLDER, and not a real story id, because `boundaryCard(ctx: CardContext, detail: string)` (`decisionCards.ts:96-110`) holds `runId`/`phaseId`/`stageId` and one opaque detail string — there is no story id and no path in scope, and it must not scrape one out of `detail` (`decisionCards.ts:88-95`: *"a second parser over a string the first one built is how two readings of one fact start"*). This is the form spec §3.2 states, and it is byte-for-byte what Step 5 writes into `decisionCards.ts:105`.

- [ ] **Step 2: Run them and keep the RED verbatim**

```
bun test test/story-widen.test.ts test/decision-cards.test.ts
```
Expected: FAIL — `Cannot find module '../src/core/run/widenStory.ts'`, plus `test/decision-cards.test.ts`'s `toEqual` diff showing the old advice line against the new one. **That second RED is the red-by-design one; keep it verbatim.**

- [ ] **Step 3: Teach the one story writer a third key**

`src/core/build/storyFile.ts`:

```ts
export interface StoryPatch {
  readonly status?: PlanStatus;
  /** Replaces the whole list. Spec §2.13: required non-empty at `status: done`. */
  readonly evidence?: readonly string[];
  /**
   * Replaces the whole list, exactly as `evidence` does (#171). `touches` is
   * already required, non-empty and capped at MAX_TOUCHES, so this changes a
   * VALUE and no schema: `STORY_KEYS` is untouched. It lives here, and not in a
   * second writer, so the story file and `04-build/implicit-plan.yml` cannot
   * disagree about what a widened list looks like.
   */
  readonly touches?: readonly string[];
}
```

```ts
const TOUCHES_RE = /^touches\s*:/;
```

```ts
export function applyPlanPatch(input: readonly string[], patch: StoryPatch): string[] {
  let lines = [...input];
  if (patch.status !== undefined) lines = replaceStatus(lines, patch.status);
  if (patch.evidence !== undefined) lines = replaceEvidence(lines, patch.evidence);
  if (patch.touches !== undefined) lines = replaceTouches(lines, patch.touches);
  return lines;
}
```

`replaceTouches` is `replaceEvidence` (`:68-79`) with `TOUCHES_RE`, `"touches"` in the error, and NO empty-inline branch — `touches` may not be empty, so an empty list is a programming error:

```ts
/**
 * Rewrite `touches:` and the block of list items under it. Unlike `evidence`,
 * there is no `[]` shape: spec §2.13 requires a non-empty list, so an empty one
 * is refused here rather than written and refused later by the validator.
 */
function replaceTouches(lines: readonly string[], touches: readonly string[]): string[] {
  if (touches.length === 0) throw new StoryWriteError("a story's `touches:` may not be empty");
  const out = [...lines];
  const at = out.findIndex((line) => TOUCHES_RE.test(line));
  if (at === -1) throw new StoryWriteError("the story front matter has no `touches:` key");
  let end = at + 1;
  while (end < out.length && LIST_ITEM_RE.test(out[end] ?? "")) end++;
  out.splice(at, end - at, "touches:", ...touches.map((item) => `  - ${quote(item)}`));
  return out;
}
```

- [ ] **Step 4: Write the verb**

Create `src/core/run/widenStory.ts` by reading `src/core/run/reopenStory.ts` end to end and mirroring it: same `EXIT_OK`/`EXIT_REFUSED = 2`/`EXIT_NOT_FOUND = 3` constants with the same docstring, same `RunStore.resolve` → ambiguous/none handling (`:118-130`), same `buildProgress` lookup, same implicit-vs-real path choice (`:208-213`), the same *validate-the-event-before-writing-the-file* order and reason (`:215-247`), and the same `refuse()` helper. Its own rules:

```ts
/**
 * The states a story may be widened FROM.
 *
 * `done` is absent and that is the point: a done story has evidence written
 * against the surface it DECLARED, and widening it afterwards would make the
 * record say the plan declared something it did not — an audit record lying in
 * the dangerous direction (AGENTS §7). The way through is #58's
 * `tldrx story reopen <id> --for-fix`, and the refusal names it.
 */
const WIDENABLE: ReadonlySet<string> = new Set(["todo", "in_progress", "review", "blocked"]);
```

Refusals, all **2**: empty id; empty `--note`; `paths` empty; a `done` story (naming `--for-fix`); a status not in `WIDENABLE`; an unknown story; a path already in `touches` (widening to what is already declared records a widening that did not happen); `before.length + added.length > MAX_TOUCHES`; a file that is not on disk; a `StoryWriteError`. Unknown run: **3**. Ambiguous run: **2**, via `ambiguousRunLines`, exactly as `reopenStory.ts:120-121` does it.

The event:

```ts
    payload: {
      story: id,
      paths: [...added],
      note: options.note,
      before: [...before],
      after: [...after],
    },
```

Success lines say what changed and what did not: the story's status is untouched, no attempt is consumed, nothing is spawned, and the boundary gate re-derives the surface off disk on its next evaluation.

- [ ] **Step 5: Dispatch, help, guide, card, event, replay**

`src/cli/commands/story.ts`: usage becomes

```ts
  usage:
    "tldrx story reopen <id> --note <text> [--for-fix] [--run <id>] [--root <path>]\n" +
    "       tldrx story widen <id> <path>… --note <text> [--run <id>] [--root <path>]",
```

dispatch gains `if (sub === "widen") return storyWiden(rest);` and the refusal becomes `` `tldrx story: expected \`reopen\` or \`widen\`\n${storyCommand.usage}\n` ``. `storyWiden` mirrors `storyReopen` (`:47-66`) — same `VALUE_FLAGS`, same stdout/stderr split, `paths: args.positionals.slice(1)`.

Extend the file's docstring: two subcommands now, and `widen` is the verb `decisionCards.ts:105` had been pointing at while `story.ts:8-9` forbade the hand edit it described.

`helpText.ts`, the `story` entry: `subcommands: ["reopen", "widen"]`; scope the existing `note` flag with `sub: "reopen"` and add a `widen`-scoped one (its meaning is different — it is WHY the surface grew); add the `<path>…` arg; add two notes (which statuses may be widened and why `done` may not; that it runs no agent, spends nothing and moves no cursor, and that the boundary gate re-reads `touches:` off disk so the next evaluation simply passes). No exit change — `:753` already declares `EXIT_GATE_REFUSED`, and it is there *because* reopen's refusals are 2.

`docs/guide/08-cli-reference.md`: the `## \`tldrx story\`` section names `widen` and every flag it declares (`test/docs-cli-coverage.test.ts:62`).

`decisionCards.ts:105`: replace the forbidden-hand-edit line with

```ts
      "tldrx story widen <id> <path> --note \"<why>\" — or cite the path in a handoff, then re-run the stage",
```

— byte-for-byte what Step 1 put into `test/decision-cards.test.ts:314`, minus the two-space indent `renderDecisionCard` adds.

`Event.ts:114`: `"story.reopened", "story.base_fastforwarded", "story.review_retried", "story.work_rescued",` gains `"story.touches_widened"`.

`renderReplay.ts`, beside `case "story.reopened"` (`:158`):

```ts
    case "story.touches_widened":
      return `${prefix}${text(payload.story)} touches widened by ${actor}: `
        + `+${text(payload.paths)}${note(payload.note)}`;
```

- [ ] **Step 6: Run the named tests, prove teeth, gate and commit**

```
bun test test/story-widen.test.ts test/decision-cards.test.ts test/story-reopen.test.ts test/boundary.test.ts test/plan-schema-contract.test.ts test/build-executor.test.ts test/replay.test.ts
```
Expected: PASS. `test/story-reopen.test.ts:409` stays green (`unblock` is still unknown, and it asserts only the code); `test/plan-schema-contract.test.ts:101`/`:210` stay green (no story key added).

Teeth: change `WIDENABLE` to include `"done"` — the done-story test goes RED. Revert. Then drop the `patch.touches` line from `applyPlanPatch` — the first test goes RED while the event test still passes, which is why both exist. Revert.

```
bun test test/build-golden.test.ts
echo "golden: $?"
```
```
bun run typecheck
echo "typecheck: $?"
```
```
bun test
echo "test: $?"
```
Expected: `0`, `0`, `0`.

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(story): `tldrx story widen` — the verb the boundary card was pointing at (#171)

`decisionCards.ts:105` told the operator to "add the path to a story's
`touches:`" while `story.ts:8-9` says hand-editing the story files is forbidden
by design — the framework's only sanctioned remedy for a defect in an undeclared
file was an edit its own CLI refuses. `tldrx story widen <id> <path>… --note`
is that remedy: an operator verb beside `reopen`, running no agent, spending
nothing, moving no cursor, and now NAMED by the card.

No format change. `touches` is already required, non-empty and capped at 128, so
appending changes a value; `STORY_KEYS` is untouched and the plan-contract pins
stay green. The record of the widening is the additive part — a
`story.touches_widened` event carrying before, after, the paths and the note, so
the surface never grows silently. `StoryPatch` gains a third key and
`applyPlanPatch` a third replacement, so the story file and
`04-build/implicit-plan.yml` cannot disagree about what a widened list looks
like — one writer, as that file already argues.

A `done` story REFUSES, and the refusal names `--for-fix`: a done story has
evidence written against the surface it declared, and widening it afterwards
would make the record say the plan declared something it did not.

Every one of the verb's own refusals is exit 2, matching `reopenStory.ts:82`'s
own words — "every one of this verb's refusals is a refusal to act" — and its
pins at `test/story-reopen.test.ts:371` and `:395-400`. 3 for an unknown run, and
1 stays exactly where it was: the subcommand-dispatch error.

The gate needed nothing: `deriveSurface` reads `touches:` off disk at evaluation
time, so a widened story simply passes on the next evaluation. The new test
proves both directions of `test/boundary.test.ts:266`.

`test/decision-cards.test.ts:314` went red BY DESIGN — it pins the advice string
verbatim, and the advice now names a real command.

No golden byte moves: the verb fires in no scenario.

RED kept:
<paste Step 2 verbatim, including the decision-cards toEqual diff>

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: #171 — `carriedFindings` and `ownershipOf`, the two predicates

**Files:**
- Create: `src/core/build/unownedFindings.ts`
- Modify: `src/core/build/fixlist.ts` — `carriedFindings` beside `openFindings` (`:111-113`) and `unevidencedClaims` (`:122-124`)
- Test: `test/unowned-findings.test.ts` (new, **pure leaf — spawns nothing**), `test/fixlist.test.ts` (a `carriedFindings` describe; `:259`, `:388`, `:539`, `:575`, `:585` are read and stay green)

**Interfaces:**
- Consumes: `FixFinding` (`fixlist.ts:64-97`); `isOpen` (`:107-109`, unchanged); `parseSrcToken(line, repos?)` (`src/core/text/srcToken.ts:495`) whose `kind: "file"` ref carries `repo: string | null` and `path` (`:28`); `inSurface(changed, surface)` (`src/core/run/boundary.ts:152-160`).
- Produces:
  - `carriedFindings(findings: readonly FixFinding[]): readonly FixFinding[]`
  - `type Ownership = "owned" | "unowned" | "unqualified" | "no-src"`
  - `interface DeclaredSurface { readonly story: string; readonly repo: string; readonly touches: readonly string[] }` — **note the field is `story`, while `ShipStory` (`ship.ts:890-896`) calls the same value `id`, so every caller maps: `stories.map((s) => ({ story: s.id, repo: s.repo, touches: s.touches }))`. Structural typing will NOT accept a `ShipStory[]` here.**
  - `ownershipOf(finding: FixFinding, declared: readonly DeclaredSurface[], repoNames: ReadonlySet<string>): Ownership`
  - `interface UnownedRow { readonly finding: FixFinding; readonly ownership: Exclude<Ownership, "owned">; readonly reason: string }`
  - `unownedFindings(carried, declared, repoNames): readonly UnownedRow[]` — Task 6's three surfaces all read THIS and nothing else.

### The measured problem

`isOpen` is `disposition === "fix-now" && !(resolved && resolvedSha !== null)` (`fixlist.ts:107-109`) and it also gates a story reaching `done` (`test/fixlist.test.ts:388-389`). A `defer-with-log` finding — the disposition #171's own transcript used — escapes it entirely, so it is invisible in the PR body and in the gate, and its only destination is `retro.md` (`fixlist.ts:737-751`).

**Two predicates, deliberately.** `fixlist.ts:22-24` already states the principle: *"A disposition ROUTES a finding; `Resolved:` CLOSES it. They are two questions … one field cannot answer both"*, and the file already carries a second predicate beside `isOpen` for exactly this reason (`unevidencedClaims`, `:122-124`). "Still owed" and "carried forward" are two questions. **`isOpen` is NOT widened**: doing so would also change what blocks a story from `done`, which is a much bigger behaviour change than a PR body.

**Ownership is repo-then-path, because `inSurface` has no repo in it.** `inSurface(changed, surface)` compares normalised path STRINGS (`boundary.ts:152-160`); `deriveSurface` never uses it repo-blind — it keys the surface by repo (`add(story.repo, path, …)`, `:262-268`) and keeps unqualified citations in their own bucket (`:255-257`). `ship.ts:893` states the same house rule for the same data: *"`repo:` — the repo its `touches:` are relative to, and the only one they answer for."* Without the repo half, a finding at `api:src/db.ts` would read as owned by a `lab` story declaring `src/db.ts` — and a false "owned" is the dangerous direction.

**No new disposition and no stored field.** A fifth disposition would make a 0.11 fix list unreadable by 0.10 (`parseFixFindings` refuses an unknown one by design, `test/fixlist.test.ts:575`), and a `FixFinding.owner` would change the rendered artifact's bytes and the round-trip pin (`:585`) for information the reader already has. `04-build/fixlist/*.md` is byte-unchanged both ways.

### The golden statement

**Expected: no golden byte moves.** This task adds two pure predicates and changes no renderer. `renderFixlistSection` — whose output `rounds-developer-S1-2.md` freezes (`fixlist.ts:687`) — is NOT touched. No scenario carries a `defer-with-log` finding at all: the only `defer-with-log` strings in the golden are reviewer-prompt boilerplate (`*-reviewer-*.md:92-93`).

- [ ] **Step 1: Write the failing tests**

Create `test/unowned-findings.test.ts` (no spawning; say so in the header):

```ts
const REPOS = new Set(["api", "lab"]);
const DECLARED = [
  { story: "S1", repo: "api", touches: ["src/Billing"] },
  { story: "S2", repo: "lab", touches: ["src/db.ts"] },
];
const carried = (where: string): FixFinding => finding({ disposition: "defer-with-log", where, resolved: false });

describe("ownershipOf — four labels, three of them absent-with-reason", () => {
  test("a repo-qualified path inside a same-repo story's touches is OWNED", () => {
    expect(ownershipOf(carried("[src: api:src/Billing/Ledger.cs:12]"), DECLARED, REPOS)).toBe("owned");
  });

  test("a repo-qualified path no same-repo story covers is UNOWNED — the reportable case", () => {
    expect(ownershipOf(carried("[src: api:platform/Auth.cs:3]"), DECLARED, REPOS)).toBe("unowned");
  });

  test("the REPO half is load-bearing: api:src/db.ts is not owned by a lab story declaring src/db.ts", () => {
    // `inSurface` compares path strings and has no repo in it; `touches:`
    // answers for exactly one repo (`ship.ts:893`). A false "owned" is the
    // dangerous direction.
    expect(ownershipOf(carried("[src: api:src/db.ts:1]"), DECLARED, REPOS)).toBe("unowned");
  });

  test("a citation that names no repo is UNQUALIFIED — neither owned nor unowned", () => {
    // `implicitPlan.ts:1349-1351`: skipped rather than guessed at.
    expect(ownershipOf(carried("[src: src/db.ts:1]"), DECLARED, REPOS)).toBe("unqualified");
  });

  test("a `where:` with no [src: …] token at all is NO-SRC", () => {
    expect(ownershipOf(carried("somewhere in the billing module"), DECLARED, REPOS)).toBe("no-src");
  });

  test("a repo prefix naming no workspace repo is unqualified, not owned", () => {
    expect(ownershipOf(carried("[src: ghost:src/db.ts:1]"), DECLARED, REPOS)).toBe("unqualified");
  });
});

describe("unownedFindings — every non-owned row carries its reason", () => {
  test("owned rows are dropped; the other three come back with a sentence each", () => {
    const rows = unownedFindings(
      [carried("[src: api:src/Billing/Ledger.cs:1]"),
       carried("[src: api:platform/Auth.cs:1]"),
       carried("[src: src/db.ts:1]"),
       carried("no citation")],
      DECLARED, REPOS,
    );
    expect(rows.map((r) => r.ownership)).toEqual(["unowned", "unqualified", "no-src"]);
    for (const row of rows) expect(row.reason.length).toBeGreaterThan(0);
    expect(rows[1]?.reason).toContain("names no repo");
    expect(rows[2]?.reason).toContain("no `[src:");
  });

  test("no declared surface at all makes every repo-qualified finding unowned, not owned", () => {
    expect(unownedFindings([carried("[src: api:src/x.ts:1]")], [], REPOS)[0]?.ownership).toBe("unowned");
  });
});
```

And in `test/fixlist.test.ts`, beside the `isOpen` tests:

```ts
describe("carriedFindings — 'carried forward' is not 'still owed'", () => {
  test("an unresolved defer-with-log is carried; a fix-now is not", () => {
    const deferred = finding({ disposition: "defer-with-log", resolved: false });
    const owed = finding({ disposition: "fix-now", resolved: false });
    expect(carriedFindings([deferred, owed])).toEqual([deferred]);
    expect(openFindings([deferred, owed])).toEqual([owed]);   // isOpen is UNCHANGED
  });

  test("a defer-with-log closed by an EVIDENCED claim is not carried", () => {
    const closed = finding({ disposition: "defer-with-log", resolved: true, resolvedSha: "abc1234" });
    expect(carriedFindings([closed])).toEqual([]);
  });

  test("a bare `Resolved: yes` with no sha is still carried — #130's clause, reused", () => {
    const bare = finding({ disposition: "defer-with-log", resolved: true, resolvedSha: null });
    expect(carriedFindings([bare])).toEqual([bare]);
  });
});
```

- [ ] **Step 2: Run them and keep the RED verbatim**

```
bun test test/unowned-findings.test.ts test/fixlist.test.ts
```
Expected: FAIL — `Cannot find module '../src/core/build/unownedFindings.ts'` and, in `test/fixlist.test.ts`, `carriedFindings is not a function` / an import error. Paste both.

- [ ] **Step 3: Add the second predicate, beside its siblings**

`src/core/build/fixlist.ts`, after `openFindings` (`:111-113`):

```ts
/**
 * A finding CARRIED FORWARD: `defer-with-log`, and not closed by an evidenced claim.
 *
 * A second predicate rather than a widening of `isOpen`, and this file already
 * argues why at the top: a disposition ROUTES a finding, `Resolved:` CLOSES it,
 * and they are two questions. "Still owed" gates a story reaching `done`
 * (`isOpen`); "carried forward" does not gate anything — it is a defect the
 * story deliberately did not fix, which somebody outside the story has to own.
 * Widening `isOpen` to cover it would silently change what blocks `done`.
 *
 * The `resolvedSha !== null` half is #130's clause reused verbatim: a bare
 * `Resolved: yes` closes nothing.
 */
export function carriedFindings(findings: readonly FixFinding[]): readonly FixFinding[] {
  return findings.filter(
    (f) => f.disposition === "defer-with-log" && !(f.resolved && f.resolvedSha !== null),
  );
}
```

- [ ] **Step 4: Write the ownership leaf**

Create `src/core/build/unownedFindings.ts`:

```ts
/**
 * Which carried findings no story's declared surface covers (#171).
 *
 * The ONE implementation of that judgement. Three surfaces read it — the Build
 * handoff's `## Unknowns`, `tldrx ship`'s PR body, and a decision card when one
 * already fires — and `ship` runs in its own process, so it calls this leaf with
 * the story rows it already holds rather than applying a predicate of its own.
 * Nothing re-scrapes a string another parser built (`decisionCards.ts:88-95`).
 *
 * It takes DATA — the carried rows, the declared surfaces, the workspace repo
 * names — and never `ctx`, never the session. It reuses two derivations and
 * copies neither: `parseSrcToken` (the ONE `[src:]` grammar) to get the ref out
 * of `where:`, and `inSurface` (the ONE path-coverage predicate) to test one path
 * against one story's list. Its own file, so `fixlist.ts` never imports
 * `boundary.ts`.
 *
 * OWNERSHIP IS REPO-THEN-PATH. `inSurface` compares normalised path strings and
 * has no repo in it; `deriveSurface` never uses it repo-blind (it keys the
 * surface by repo, `boundary.ts:262-268`), and `touches:` answers for exactly one
 * repo (`ship.ts:893`). Without the repo half a finding at `api:src/db.ts` would
 * read as owned by a `lab` story declaring `src/db.ts` — and a false "owned" is
 * the dangerous direction.
 */
import { type FixFinding } from "./fixlist.ts";
import { parseSrcToken } from "../text/srcToken.ts";
import { inSurface } from "../run/boundary.ts";

/** `owned` and three ways of not being ownable, each with a reason. */
export type Ownership = "owned" | "unowned" | "unqualified" | "no-src";

/**
 * One story's declared surface — the three things `ship.ts`'s `ShipStory`
 * already holds, under this leaf's own names. `ShipStory` calls the first one
 * `id`, so every caller maps rather than passing the array through: structural
 * typing does not rename a field.
 */
export interface DeclaredSurface {
  readonly story: string;
  /** The repo its `touches:` are relative to, and the only one they answer for. */
  readonly repo: string;
  readonly touches: readonly string[];
}

export interface UnownedRow {
  readonly finding: FixFinding;
  readonly ownership: Exclude<Ownership, "owned">;
  /** Why this one could not be given an owner. Never blank, never inferred. */
  readonly reason: string;
}

const REASONS: Readonly<Record<Exclude<Ownership, "owned">, string>> = {
  unowned: "no story declares this path in the repo it names",
  unqualified: "the citation names no repo, and a repo is not guessed at",
  "no-src": "`where:` carries no `[src: …]` path, so nothing can be checked against it",
};

export function ownershipOf(
  finding: FixFinding,
  declared: readonly DeclaredSurface[],
  repoNames: ReadonlySet<string>,
): Ownership {
  const token = parseSrcToken(finding.where, repoNames);
  const file = token?.refs.find((ref) => ref.kind === "file") ?? null;
  if (file === null) return "no-src";
  if (file.repo === null) return "unqualified";
  const owned = declared.some((story) => story.repo === file.repo && inSurface(file.path, story.touches));
  return owned ? "owned" : "unowned";
}

export function unownedFindings(
  carried: readonly FixFinding[],
  declared: readonly DeclaredSurface[],
  repoNames: ReadonlySet<string>,
): readonly UnownedRow[] {
  const rows: UnownedRow[] = [];
  for (const finding of carried) {
    const ownership = ownershipOf(finding, declared, repoNames);
    if (ownership === "owned") continue;
    rows.push({ finding, ownership, reason: REASONS[ownership] });
  }
  return rows;
}
```

Before writing it, open `src/core/text/srcToken.ts:28` and confirm the `kind: "file"` member's field names (`repo`, `path`) and that `parseSrcToken` returns `{raw, refs, errors}` — narrow with a type guard the way `boundary.ts` does at `:178` rather than casting.

- [ ] **Step 5: Run the named tests, prove teeth, gate and commit**

```
bun test test/unowned-findings.test.ts test/fixlist.test.ts test/boundary.test.ts test/text.test.ts
```
Expected: PASS. `test/fixlist.test.ts:259`, `:388`, `:539`, `:575` and `:585` all stay green — `isOpen`, `DISPOSITIONS`, the parser and the round trip are untouched.

Teeth: drop `story.repo === file.repo` from `ownershipOf` — the "REPO half is load-bearing" test goes RED with `"owned"` where `"unowned"` was expected. Revert. Then change `carriedFindings`'s `resolvedSha !== null` to `f.resolved` — the bare-`Resolved: yes` test goes RED. Revert.

```
bun test test/build-golden.test.ts
echo "golden: $?"
```
```
bun run typecheck
echo "typecheck: $?"
```
```
bun test
echo "test: $?"
```
Expected: `0`, `0`, `0`.

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(build): two predicates for two questions — carried, and unowned (#171)

A `defer-with-log` finding escaped every reader except retro.md: `isOpen` is
`fix-now` only, and it also gates a story reaching `done`, so widening it to
cover deferred defects would have changed what blocks a story — a far bigger
behaviour change than the PR body this is for. So `carriedFindings` is a SECOND
predicate beside `isOpen` and `unevidencedClaims`, which is what this file
already argues for: a disposition ROUTES a finding, `Resolved:` CLOSES it, and
one field cannot answer both. #130's clause is reused verbatim — a bare
`Resolved: yes` closes nothing.

`ownershipOf` is the ONE implementation of "does any story own this defect", and
it is REPO-THEN-PATH. `inSurface` compares path strings and has no repo in it;
`deriveSurface` never uses it repo-blind, and `touches:` answers for exactly one
repo. Without the repo half a finding at `api:src/db.ts` would read as owned by
a `lab` story declaring `src/db.ts`, and a false "owned" is the dangerous
direction. It takes DATA — carried rows, declared surfaces, repo names — never
ctx and never the session, and it reuses `parseSrcToken` and `inSurface` rather
than copying either, in its own file so `fixlist.ts` never imports `boundary.ts`.

Four labels, three of them absent-with-reason: `unowned` (the reportable case),
`unqualified` (the citation names no repo, and a repo is not guessed at) and
`no-src` (`where:` carries no citation). Neither of the last two is ever counted
as owned.

No fifth disposition and no stored `owner` field: an unknown disposition is
refused by design, so a fix list written by 0.11 would be unreadable by 0.10,
and a stored owner would change the artifact's bytes for information the reader
already has. `04-build/fixlist/*.md` is byte-unchanged both ways.

No golden byte moves: two pure predicates, no renderer touched, and no scenario
carries a defer-with-log finding at all.

RED kept:
<paste Step 2 verbatim>

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: #171 — carried and unowned findings reach the handoff, the PR body and the card

**Files:**
- Modify: `src/core/build/handoff.ts` — `BuildHandoffParts` (`:56-85`) and the `## Unknowns` block (`:109-115`, and ~10 lines lower once Task 3's header clause has landed)
- Modify: `src/core/facilitator/executors/build.ts` — the `renderBuildHandoff({...})` call (`:2303-2314`); the fix lists it already reads (`fixlistFor`) and the story surfaces it already holds
- Modify: `src/core/run/shipBody.ts` — `ShipBodyParts` (`:44-53`) and the section after `## Open findings` (`:88-99`)
- Modify: `src/core/run/ship.ts` — `writeShipBody` (`:853-870`), a `carriedFor` beside `openFixFindings` (`:993-1006`)
- Modify: `src/core/run/decisionCards.ts` — `boundaryCard` (`:96-110`) takes an optional extra detail
- Test: `test/ship.test.ts` (a `## Carried findings` describe beside `:333`; the absent-case sibling beside `:404`), `test/build-executor.test.ts` (the `renderBuildHandoff` home — measured: it and `test/ship.test.ts` are the only importers; there is no `test/build-handoff.test.ts`), `test/decision-cards.test.ts` (the two-arg call at `:310` stays green)

**Interfaces:**
- Consumes: `carriedFindings`, `unownedFindings`, `UnownedRow`, `DeclaredSurface` (Task 5); `latestFixlist` (`fixlist.ts:642`); `ShipStory` (`ship.ts:890-896`, populated at `:963`) — mapped to `DeclaredSurface` with `{story: s.id, repo: s.repo, touches: s.touches}`, because the leaf's field is `story` and `ShipStory`'s is `id`; `OpenFindingRow` (`shipBody.ts:38-42`).
- Produces: `BuildHandoffParts.carried?: readonly CarriedRow[]` where `CarriedRow = { rel: string; row: UnownedRow }`; `ShipBodyParts.carriedFindings: readonly CarriedRow[]`; `boundaryCard(ctx, detail, extra?: readonly string[])`.

### The measured problem, and where the report can actually land

Under the ruled default — **report only** — there is no eighth auto-gate condition, so an unowned finding raises no trigger. And a decision card is **not available on the path this issue is about**: all three `renderDecisionCard` call sites are conditioned on the gate falling to a person (`runNext.ts:1660-1677` inside the *"this gate falls to a person"* branch returning `EXIT_AWAITING_HUMAN`; `runAuto.ts:200`, `if (options.gateAgent !== true || outcome.code !== EXIT_AWAITING_HUMAN) return indented;`; `runItems.ts:130`, `questionsCard` only), and `cardForTriggers` returns `null` when `triggers.length === 0` and otherwise exactly ONE card by priority (`decisionCards.ts:142-164`). #171's own measurement is *"The run signed all five gates with a known defect on board"* — **the gates passed, so no card printed.**

So the report lands where a PASSING gate still shows it:

1. **The Build handoff's `## Unknowns`** — the primary surface, and the one the reviewer, the gate and `ship` all already read. **Not a fifth H2 section**: `missingSections` requires the four in order but tolerates extras (`text/handoff.ts:213-225`) while `validateSections` (`:387`) only checks bullets *inside the required four* (`BULLET_RULE` at `:261`, the cap check at `:443`) — so a fifth section's claims would be the one part of the document nothing validates, which is the hole §2.8 exists to close. `## Unknowns` is also where it belongs by meaning: it already holds "this needs a human". `MAX_BULLETS` is 200 (`text/handoff.ts:345`); beyond the cap, summarise with a count and the fix-list citation.
2. **The PR body** — `shipBody` gains a `## Carried findings` section fed from the shared leaf.
3. **The decision card — only when a card already fires.** `boundaryCard`'s detail gains the rows so the person deciding sees them. An addition to a card that was going to print, never the reason one prints.
4. **`retro.md` — unchanged.** `fixlistRetroLines` already writes one bullet per `defer-with-log` (`fixlist.ts:737-751`); this adds destinations, not a second writer.

**One deviation from the spec, measured.** Spec §3.2 says each bullet ends `[src: tldrx-work/<run>/<fixlist rel>:1]`. The existing `## Unknowns` bullets cite the RUN-RELATIVE path (`handoff.ts:114`, `` `[src: ${o.reviewRel}:1]` ``), and `pathBases` resolves a `[src:]` file path against the workspace root first and the run dir second (`srcToken.ts:1087`). This follows the existing convention — `[src: ${row.rel}:1]` — so one document does not carry two spellings of the same citation.

### The golden statement

**Expected: no golden byte moves.** No scenario carries a `defer-with-log` finding, so no carried row exists to render; the handoff is not a golden artifact; `ship` runs in no scenario; cards are rendered to stdout (`runNext.ts:1677`, `runAuto.ts:206`, `runItems.ts:130`), never into an event or a prompt. The artifact that WOULD move if `renderFixlistSection` were touched — and it must not be — is `rounds-developer-S1-2.md`.

- [ ] **Step 1: Write the failing tests**

In `test/ship.test.ts`, beside `:333`:

```ts
test("carried findings nobody's story owns are listed, and come from the shared leaf", async () => {
  const ws = workspace();
  readyToShip(ws);                                     // S1 · repo api · touches ["src/in.ts"]
  writeFixlistFixture(ws, "S1", [
    { disposition: "defer-with-log", finding: "the token is logged", where: "[src: api:platform/Auth.cs:3]" },
  ]);

  const transport = healthy();
  await ship(ws, transport);
  const body = bodyOf(transport);

  expect(body).toContain("## Carried findings");
  expect(body).toContain("the token is logged");
  expect(body).toContain("no story declares this path in the repo it names");
});

test("a carried finding a story DOES own is not listed — the section is about ownership", async () => {
  const ws = workspace();
  readyToShip(ws);
  writeFixlistFixture(ws, "S1", [
    { disposition: "defer-with-log", finding: "a nit inside the surface", where: "[src: api:src/in.ts:1]" },
  ]);

  const transport = healthy();
  await ship(ws, transport);
  expect(bodyOf(transport)).not.toContain("## Carried findings");
});

test("no carried findings leaves the section out rather than asserting an empty one", async () => {
  const ws = workspace();
  readyToShip(ws);

  const transport = healthy();
  await ship(ws, transport);
  expect(bodyOf(transport)).not.toContain("## Carried findings");
});
```

In `test/build-executor.test.ts`:

```ts
test("an unowned carried finding is a `## Unknowns` bullet with its reason and its citation", () => {
  const text = renderBuildHandoff(parts({
    carried: [{ rel: "04-build/fixlist/S1-1.md", row: {
      finding: finding({ finding: "the token is logged" }),
      ownership: "unowned", reason: "no story declares this path in the repo it names",
    } }],
  }));
  const unknowns = sectionOf(text, "Unknowns");
  expect(unknowns).toContain("the token is logged");
  expect(unknowns).toContain("no story declares this path");
  expect(unknowns).toContain("[src: 04-build/fixlist/S1-1.md:1]");
  // Not a fifth section: `validateSections` only checks bullets inside the four.
  expect(text).not.toContain("## Carried findings");
});

test("absent behaves exactly as empty — the field adds no state of its own", () => {
  // A GUARD, not a proof: both sides go through the new code, so it cannot catch
  // a changed "none" sentence. The test below is the one that can.
  expect(renderBuildHandoff(parts({}))).toBe(renderBuildHandoff(parts({ carried: [] })));
});

test("with nothing owed and nothing carried, the `none` bullet says BOTH, verbatim", () => {
  // The sentence is user-visible, it is not in any golden artifact, and nothing
  // pinned it before (measured: `grep -rn "every scheduled story reached" test/`
  // returns no hit — the only occurrence is `src/core/build/handoff.ts:110`). A
  // document that says "nothing needs a human" while listing something that does
  // is worse than one that says neither, so the new wording is pinned literally.
  const text = renderBuildHandoff(parts({ outcomes: [doneStory()], carried: [] }));
  expect(sectionOf(text, "Unknowns")).toContain(
    "- none — every scheduled story reached `done` and no carried finding is unowned "
    + "[src: absent:04-build/log]",
  );
});

test("beyond MAX_BULLETS the rows are summarised with a count and the citation, never dropped", () => {
  const many = Array.from({ length: 250 }, () => carriedRow());
  const text = renderBuildHandoff(parts({ carried: many }));
  expect(validateHandoff(text).ok).toBe(true);
  expect(text).toContain("250");
});
```

- [ ] **Step 2: Run them and keep the RED verbatim**

```
bun test test/ship.test.ts test/build-executor.test.ts
```
Expected: FAIL — `expect(received).toContain("## Carried findings")` over a body that has no such section, and an excess-property / missing-property TypeScript error on `carried` in the handoff parts. Paste it.

- [ ] **Step 3: The handoff's `## Unknowns`**

`src/core/build/handoff.ts` — add to `BuildHandoffParts`:

```ts
/** One carried finding no story's declared surface covers, with the fix list it is in. */
export interface CarriedRow {
  /** Run-relative path of the fix list — the same spelling every other bullet cites. */
  readonly rel: string;
  readonly row: UnownedRow;
}
```
```ts
  /**
   * Carried findings (`defer-with-log`, unresolved) that no story's `touches:`
   * covers, computed by `build/unownedFindings.ts` and HANDED here — this file
   * parses no fix list and applies no predicate of its own.
   *
   * They go in `## Unknowns` and not in a fifth section on purpose:
   * `validateSections` only checks bullets inside the four required sections
   * (`text/handoff.ts:387`), so a fifth section's claims would be the one part of
   * the document nothing validates. `## Unknowns` is also where they belong —
   * it already holds "this needs a human".
   *
   * Absent or empty leaves the section byte-identical to before this existed.
   */
  readonly carried?: readonly CarriedRow[];
```

and in the `## Unknowns` block (`:109-115`), append after the existing `notDone` mapping — noting that the "none" line must now consider both lists:

```ts
    ...(notDone.length === 0 && (parts.carried ?? []).length === 0
      ? [`- none — every scheduled story reached \`done\` and no carried finding is unowned [src: absent:04-build/log]`]
      : []),
    ...notDone.map((o) =>
      `- ${o.id} is \`${o.status}\` and needs a human: ${o.reason ?? "see the review"} [src: ${o.reviewRel}:1]`),
    ...carriedBullets(parts.carried ?? []),
```

with a small local `carriedBullets` that renders one bullet per row —

```
- a carried finding nobody's story owns: <finding> [<severity>] — <reason> [src: <rel>:1]
```

— and, past a cap chosen so the document stays under `MAX_BULLETS` (200, `text/handoff.ts:345`) alongside everything else, one summarising bullet naming the count and citing the first fix list. **Never drop a row silently.**

- [ ] **Step 4: Feed it from the executor, which stays an orchestrator**

In `build.ts`, where the handoff is written (`:2303`), build the rows from what the executor already holds — the fix list per story (its existing `fixlistFor` reader) and the story surfaces (`repo` + `touches` off the plan it already loaded) — and pass them:

```ts
      carried: this.carriedRows(),
```

`carriedRows()` calls `carriedFindings(latest.findings)` then `unownedFindings(carried, declared, repoNames)` and maps to `{rel, row}`. It computes nothing itself: both predicates live in their leaves. If the executor does not already hold the workspace repo names, take them from the same place `renderFacts` gets the run's repos rather than loading a second copy.

- [ ] **Step 5: The PR body**

`shipBody.ts` — add `readonly carriedFindings: readonly CarriedRow[];` to `ShipBodyParts` with a docstring saying the rows come from `build/unownedFindings.ts` and are never re-derived here, and after the `## Open findings` block (`:88-99`):

```ts
  if (parts.carriedFindings.length > 0) {
    lines.push(
      "## Carried findings",
      "",
      "Reviewer findings this run deliberately did NOT fix (`defer-with-log`), whose path no",
      "story's `touches:` covers — so no story could have closed them:",
      "",
      ...parts.carriedFindings.map((row) =>
        `- ${String(row.row.finding.n)} · ${row.row.finding.finding} [${row.row.finding.severity}] — `
        + `${row.row.reason} — \`${row.rel}\``),
      "",
    );
  }
```

`ship.ts` — add a `carriedFor(store, stories)` beside `openFixFindings` (`:993-1006`), built the same way (same `phaseDirs` walk, same one-story-once guard, same `latestFixlist`), but calling `carriedFindings` + `unownedFindings` with the `ShipStory` rows it already has (`:963` populates `{id, status, repo, touches}`), **mapped** to the leaf's shape — `stories.map((s) => ({ story: s.id, repo: s.repo, touches: s.touches }))`, because the leaf's field is `story` and `ShipStory`'s is `id` — and the workspace repo names. Its docstring says explicitly: `ship` applies no predicate of its own; the leaf is the one implementation, and `ship` calls it because it runs in a separate process, not because it has a second opinion. Pass the rows into `renderShipBody` at `:860-867`.

- [ ] **Step 6: The card, only when one already fires**

`decisionCards.ts`:

```ts
export function boundaryCard(ctx: CardContext, detail: string, extra: readonly string[] = []): DecisionCard {
```
```ts
    detail: [detail, ...extra],
```

Extend its docstring: the extra lines are carried findings nobody's story owns, HANDED in — this card still scrapes nothing. The default `[]` keeps `test/decision-cards.test.ts:310`'s two-argument call green. Pass the rows at the `cardForTriggers` call site only where they are already in hand; if they are not, leave the card unchanged and say so in the commit — **the card is a secondary surface here and must never become the reason a gate stops.**

- [ ] **Step 7: Run the named tests, prove teeth, gate and commit**

```
bun test test/ship.test.ts test/build-executor.test.ts test/decision-cards.test.ts test/fixlist.test.ts test/handoff-sections.test.ts
```
Expected: PASS. `test/ship.test.ts:333` and `:404` stay green (`isOpen` untouched, `## Open findings` unchanged); `test/fixlist.test.ts:259` stays green (retro is unchanged and the PR body is an ADDITIONAL destination).

Teeth: make `carriedFor` use `openFindings` instead of `carriedFindings` — the first ship test goes RED. Revert. Then make the handoff's "none" line ignore `parts.carried` — the byte-identical test still passes but the unowned-bullet test goes RED on a document claiming nothing needs a human while listing something that does. Revert.

```
bun test test/build-golden.test.ts
echo "golden: $?"
```
```
bun run typecheck
echo "typecheck: $?"
```
```
bun test
echo "test: $?"
```
Expected: `0`, `0`, `0`.

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(build): a finding no story owns is named in the handoff and the PR body (#171)

Under the ruled default this REPORTS; nothing stops. So it had to land where a
PASSING gate still shows it, and the measurement decided where: all three
`renderDecisionCard` call sites are conditioned on the gate falling to a person,
and `cardForTriggers` returns null with no triggers — #171's own transcript is a
run that SIGNED all five gates with the defect on board, so no card printed at
all. The destinations are therefore the Build handoff's `## Unknowns` and the PR
body, with the card as a secondary surface that gains the rows only when some
other trigger was already going to print one.

`## Unknowns` and not a fifth H2 section, deliberately: `missingSections`
tolerates extras but `validateSections` only checks bullets inside the four
required sections, so a fifth section's claims would be the one part of the
document nothing validates — precisely the hole §2.8 exists to close. And
`## Unknowns` is where they belong by meaning: it already holds "this needs a
human". Past the bullet cap the rows are summarised with a count and the
fix-list citation; none is ever dropped.

One derivation, three readers: the rows are computed by
`build/unownedFindings.ts` and HANDED to each surface. `ship` runs in its own
process, so it calls the leaf with the ShipStory rows it already holds — it
gains no predicate of its own, and nothing re-scrapes a string another parser
built.

Deviation from the spec, measured and deliberate: the bullets cite
`[src: <run-relative fixlist>:1]`, matching the citation spelling every other
`## Unknowns` bullet already uses, rather than the `tldrx-work/<run>/…` prefix
the spec suggested — one document should not carry two spellings of one citation.

retro.md is unchanged: `fixlistRetroLines` already writes one bullet per
`defer-with-log`, and this adds destinations, not a second writer.

No golden byte moves: no scenario carries a defer-with-log finding, the handoff
is not a golden artifact, `ship` runs in no scenario, and cards go to stdout.
`renderFixlistSection` — whose output `rounds-developer-S1-2.md` freezes — was
not touched.

RED kept:
<paste Step 2 verbatim>

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: #170 — a grant is a recorded number, and a ceiling answers to it

**Files:**
- Create: `src/core/budget/grant.ts`
- Modify: `src/core/budget/RunBudget.ts` — `BudgetPhase` (`:62-74`), `RunBudget` (`:76-110`), `validateRunBudget` (`:132-232`), `asRunBudget` (`:234-254`)
- Modify: `src/core/run/emitRunYaml.ts:217-262` — `emitBudgetYaml`, its conditional lines (`:227-248`) and the phase mapping (`:250-259`)
- Modify: `src/core/run/newRun.ts:216-239` — the ONE construction site of a `RunBudget` and its `BudgetPhase` literals
- Modify: `src/cli/commands/budget.ts` — the dispatch (`:32-41`), `budgetRaise` (`:61-121`), a new `budgetGrant`
- Modify: `src/core/events/Event.ts:118` — `"budget.warned", "budget.blocked", "budget.raised",` gains `"budget.granted"`
- Modify: `src/core/replay/renderReplay.ts` — one `case`
- Modify: `src/core/dashboard/model.ts` — `BudgetModel` (`:194-210`), `BudgetPhaseModel` (`:170-180`), the projection (`:1330-1345`)
- Modify: `src/cli/helpText.ts` — the `budget` entry (`:906-932`)
- Modify: `docs/guide/08-cli-reference.md` — the `## \`tldrx budget\`` section names `grant`, `--fact` and `--on-exceed`
- Test: `test/budget-grant.test.ts` (new, **spawning** — it drives the real CLI like `test/budget-ux.test.ts`), `test/budget-ux.test.ts` (`:134-180` and `:261` read, stay green), `test/money-safety.test.ts` (`:72`, `:400` read, stay green), `test/remaining-work.test.ts:138-147` (**read and expect green — a red here means the change grew beyond this plan; stop and re-scope**), `test/dashboard*.test.ts`

**Interfaces:**
- Consumes: `RunBudget`, `BudgetPhase`, `totalSpent` (`src/core/budget/wouldExceed.ts`); `raiseBudget` (`raiseBudget.ts:46-108`) and its `RaiseOutcome.runCeilingAfter` / `phaseCeilingAfter`; `FactsStore.loadOrEmpty` + `isLive` for `--fact` validation; `EXIT_GATE_REFUSED` (`src/cli/exitCodes.ts:19`).
- Produces:
  - `ON_GRANT_EXCEED = ["warn", "block"] as const`, `type OnGrantExceed`, `DEFAULT_ON_GRANT_EXCEED: OnGrantExceed = "warn"`
  - `RunBudget.authorized_usd: number | null`, `.authorized_by: string | null`, `.authorized_at: string | null`, `.on_grant_exceed: OnGrantExceed`; `BudgetPhase.authorized_usd: number | null`
  - `grantFor(budget: RunBudget, phaseId?: string | null): { usd: number; factId: string; level: "phase" | "run" } | null`
  - `wouldExceedGrant(budget: RunBudget, phaseId: string | null, resultingCeilingUsd: number): { exceeds: boolean; blocked: boolean; grant: Grant | null; sentence: string | null }`
  - the `budget.granted` event

### The measured problem

Three places write a dollar ceiling — the preset (`newRun.ts:432-455`), a triage split's guess (`applySplit.ts:207`, `"--budget", run.budget_usd.toFixed(2)`), and `budget.yml` — and one place records what the owner said they would pay (an answered fact). `grep -rn 'facts\|FactsStore\|grant\|authoriz\|reconcil' src/core/budget/ src/cli/commands/budget.ts src/cli/commands/cost.ts` returns **zero functional hits**. Nothing connects them.

**The shape is required-and-nullable, not optional**, because that is what the precedent actually is: `RunBudget.ceiling_host_tokens: number | null` (`:108`) and `on_host_tokens_exceed: OnHostTokensExceed` (`:90`) are **required in the interface**; tolerance lives in the validator (checked only when present and non-null, `:157-163`), the default lives in `asRunBudget` (`:244-245`), and the emitter writes the line only when it is not the default. `?: T | null` would create three states — missing, null, value — with no stated difference between the first two and no mapper to collapse them.

**`on_grant_exceed` is never `on_exceed`.** `on_exceed` governs SPENDING past a ceiling; `on_grant_exceed` governs WRITING a ceiling above what the owner authorized. The argument is `ON_HOST_TOKENS_EXCEED`'s own, at `RunBudget.ts:19-22`: a run that blocks on dollars has said nothing about whether a different lever should stop the framework.

**This is the sharpest round-trip case in the wave, and it is not optional work.** `emitBudgetYaml` enumerates keys and says why three times (`emitRunYaml.ts:227-232`): *"`budget raise` rewrites this file through this emitter, so a label that did not round-trip would be ERASED by the one command an operator reaches for when a ceiling binds."* `budget raise` is the command being made grant-aware. **Unless `asRunBudget` and `emitBudgetYaml` both learn these keys, the first `budget raise` after a grant erases the grant it just reconciled against — and every unit test of the reconciliation would still pass.**

**Exit families, and why this is not one condition in two.** `budget grant` / `budget raise` keep **1** for a bad amount, an unknown phase, a `--fact` naming no live fact — "you typed something impossible". The resulting ceiling exceeding the recorded grant under `on_grant_exceed: block` is **2** (`EXIT_GATE_REFUSED`) — "the owner forbade this ceiling", which is what AGENTS §7 reserves 2 for and what #167 moved `tldrx ship`'s state refusal into. Two different conditions, each wholly inside one family. `budget`'s help entry already declares `exits: [EXIT_OK, EXIT_USAGE, EXIT_GATE_REFUSED, EXIT_NOT_FOUND]` (`:928`), so the exit surface does not grow — only a new reason for a code it already has.

**Out of scope, and it is the wave's tripwire:** `src/core/build/caps.ts` and `src/core/budget/remainingWork.ts`. They are a deliberate pinned mirror (`caps.ts:1-11`, `test/remaining-work.test.ts:139`) and their arithmetic is what freezes `$3.20` in three prompt artifacts and `max_budget_usd` in four event files. Any pull toward changing share arithmetic means the change is bigger than this plan: **stop and re-scope.**

### The golden statement

**Expected: no golden byte moves.** No cap arithmetic moves, no stage literal moves, and `budget.granted` fires in no scenario. The frozen values a cap change WOULD move, stated completely: `$3.20` in `headless-developer-prompt.md:109`, `insession-bundle-prompt.md:109` and `refused-developer-S1-1.md:110`; `max_budget_usd` in `headless-events.txt` `#03`, `refused-events.txt:4`, **five lines of `rounds-events.txt`** and one line of `insession-events.txt` (measured; an earlier draft said four and omitted `insession`); plus `gate.requested`'s frozen `keys=[checks,cost_usd,outputs,phase]`, which any new payload key would break.

- [ ] **Step 1: Write the failing tests**

Create `test/budget-grant.test.ts`, modelled on `test/budget-ux.test.ts` (it drives the real CLI, so it spawns — carry `setDefaultTimeout(spawnTestTimeout())`):

```ts
describe("tldrx budget grant — a ceiling that answers to a decision", () => {
  test("the grant is recorded with the fact behind it, and survives a re-read", async () => {
    const ws = await runWithFact("F001");                     // one run, F001 live in facts.yml
    expect((await tldrx(ws.root, "budget", "grant", "40", "--fact", "F001")).code).toBe(0);
    const budget = loadBudgetFile(onlyRunDir(ws.root));
    expect(budget.authorized_usd).toBe(40);
    expect(budget.authorized_by).toBe("F001");
    expect(budget.authorized_at).not.toBeNull();
  });

  test("THE PIN: a grant survives `budget raise`, which rewrites the file through the emitter", async () => {
    // `emitRunYaml.ts:227-232` says it: a key that does not round-trip is ERASED
    // by the one command an operator reaches for when a ceiling binds — and that
    // command is this one. Without the emitter line, every other test here still
    // passes and the grant is gone after the first raise.
    const ws = await runWithFact("F001");
    await tldrx(ws.root, "budget", "grant", "40", "--fact", "F001");
    expect((await tldrx(ws.root, "budget", "raise", "01-what", "0.50", "--take-from", "05-watch")).code).toBe(0);
    const budget = loadBudgetFile(onlyRunDir(ws.root));
    expect(budget.authorized_usd).toBe(40);
    expect(budget.authorized_by).toBe("F001");
  });

  test("under the default (warn), a ceiling above the grant is WARNED and written", async () => {
    const ws = await runWithFact("F001");                     // run ceiling $10
    await tldrx(ws.root, "budget", "grant", "10", "--fact", "F001");
    const raised = await tldrx(ws.root, "budget", "raise", "04-build", "20");
    expect(raised.code).toBe(0);
    expect(raised.stdout).toContain("F001");
    expect(raised.stdout.toLowerCase()).toContain("authorized");
    expect(loadBudgetFile(onlyRunDir(ws.root)).ceiling_usd).toBeGreaterThan(10);
  });

  test("under `block`, the same raise is REFUSED with 2, and nothing is written", async () => {
    const ws = await runWithFact("F001");
    await tldrx(ws.root, "budget", "grant", "10", "--fact", "F001", "--on-exceed", "block");
    const runDir = onlyRunDir(ws.root);
    const before = readFileSync(join(runDir, "budget.yml"), "utf8");

    const refused = await tldrx(ws.root, "budget", "raise", "04-build", "20");

    expect(refused.code).toBe(2);                              // money/gate, not usage
    expect(refused.stdout).toBe("");
    expect(readFileSync(join(runDir, "budget.yml"), "utf8")).toBe(before);
  });

  test("with NO grant recorded, nothing is reconciled and nothing is refused", async () => {
    // Absent is the LAX side, deliberately: `$0` would brick every run on disk.
    const ws = await runWithFact("F001");
    expect((await tldrx(ws.root, "budget", "raise", "04-build", "20")).code).toBe(0);
    expect(loadBudgetFile(onlyRunDir(ws.root)).authorized_usd).toBeNull();
  });

  test("a --fact naming no live fact is a usage error (1), and nothing is written", async () => {
    const ws = await runWithFact("F001");
    const runDir = onlyRunDir(ws.root);
    const before = readFileSync(join(runDir, "budget.yml"), "utf8");
    const bad = await tldrx(ws.root, "budget", "grant", "40", "--fact", "F404");
    expect(bad.code).toBe(1);
    expect(readFileSync(join(runDir, "budget.yml"), "utf8")).toBe(before);
  });

  test("grant with no --fact at all is a usage error: a grant with no decision behind it is a number nobody said", async () => {
    const ws = await runWithFact("F001");
    expect((await tldrx(ws.root, "budget", "grant", "40")).code).toBe(1);
  });

  test("a phase grant governs its phase and the run grant governs the rest", async () => {
    const ws = await runWithFact("F001");
    await tldrx(ws.root, "budget", "grant", "5", "--fact", "F001", "--phase", "04-build", "--on-exceed", "block");
    expect((await tldrx(ws.root, "budget", "raise", "04-build", "20")).code).toBe(2);
    expect((await tldrx(ws.root, "budget", "raise", "01-what", "0.50", "--take-from", "05-watch")).code).toBe(0);
  });

  test("a phase grant is measured against the PHASE ceiling, not the run's", async () => {
    // The pin that tells the two branches apart. `04-build` is granted $5 and
    // sits at $4; raising it by $0.50 keeps the PHASE at $4.50 — inside its
    // grant — while the RUN ceiling ends well above $5. A reconciliation that
    // compared `runCeilingAfter` against the phase grant would refuse this, and
    // every other test in this file would still pass.
    const ws = await runWithFact("F001");                     // run ceiling $10
    await tldrx(ws.root, "budget", "grant", "5", "--fact", "F001", "--phase", "04-build", "--on-exceed", "block");
    const raised = await tldrx(ws.root, "budget", "raise", "04-build", "0.50");
    expect(raised.code).toBe(0);
    expect(loadBudgetFile(onlyRunDir(ws.root)).phases.find((p) => p.id === "04-build")?.ceiling_usd)
      .toBeCloseTo(4.5, 2);
  });

  test("a budget.granted event is appended, with the fact and the amount", async () => {
    const ws = await runWithFact("F001");
    await tldrx(ws.root, "budget", "grant", "40", "--fact", "F001");
    const [event] = eventsOf(ws).filter((e) => e.type === "budget.granted");
    expect(event?.payload).toMatchObject({ amount_usd: 40, fact: "F001", phase: null });
  });

  test("a budget.yml written before these keys existed still loads, and means no grant", () => {
    const legacy = asRunBudget(parseYaml(LEGACY_BUDGET_YML));   // no authorized_* keys at all
    expect(validateRunBudget(parseYaml(LEGACY_BUDGET_YML)).ok).toBe(true);
    expect(legacy.authorized_usd).toBeNull();
    expect(legacy.on_grant_exceed).toBe("warn");
  });

  test("a file with no grant is emitted byte-identically to before the keys existed", () => {
    expect(emitBudgetYaml(asRunBudget(parseYaml(LEGACY_BUDGET_YML)))).toBe(LEGACY_BUDGET_YML);
  });
});
```

- [ ] **Step 2: Run them and keep the RED verbatim**

```
bun test test/budget-grant.test.ts
```
Expected: FAIL — `tldrx budget: expected \`show\` or \`raise\`` on stderr with exit `1` where `0` was expected, and `expect(received).toBe(expected)` with `received: undefined, expected: 40`. Paste it.

- [ ] **Step 3: Grow the schema — interface, validator, mapper, emitter, in that order**

`RunBudget.ts`, beside `ON_HOST_TOKENS_EXCEED` (`:24-28`):

```ts
/**
 * What happens when a ceiling is WRITTEN above what the owner authorized (#170).
 *
 * Never `on_exceed`, and the argument is `ON_HOST_TOKENS_EXCEED`'s one domain
 * over: `on_exceed` governs SPENDING past a ceiling, this governs WRITING one
 * the owner forbade. A run that blocks on dollars has said nothing about
 * whether a ceiling above an authorization should be refused, and inferring one
 * from the other enforces a policy nobody asked for.
 *
 * `warn` is the default because it is what this file did before the key existed:
 * say so, never stop. `block` is the explicit opt-in.
 */
export const ON_GRANT_EXCEED = ["warn", "block"] as const;
export type OnGrantExceed = (typeof ON_GRANT_EXCEED)[number];
export const DEFAULT_ON_GRANT_EXCEED: OnGrantExceed = "warn";
```

`BudgetPhase` gains:

```ts
  /**
   * This phase's own authorization, or null when it declares none — in which
   * case the RUN's grant governs it. Null, never 0: 0 is a ceiling nothing could
   * ever fit, and absent must never read as "the owner authorized nothing".
   */
  readonly authorized_usd: number | null;
```

`RunBudget` gains the four, each with a docstring in `ceiling_host_tokens`'s voice (`:91-108`) and each saying what absence means:

```ts
  /**
   * What the owner AUTHORIZED for this run, or null when no grant is recorded.
   *
   * ADDITIVE. Absent — every budget.yml on disk — means "no grant recorded, and
   * nothing is reconciled". That is deliberately the LAX side: absent read as
   * `$0` would refuse every raise on every existing run, which is exactly the
   * argument `ceiling_host_tokens` won one domain over.
   */
  readonly authorized_usd: number | null;
  /**
   * The fact id the grant cites (`F031`), or null. A grant that cannot name a
   * decision is not recorded at all — `budget grant` refuses without `--fact`.
   */
  readonly authorized_by: string | null;
  /** RFC3339, or null when unknown. */
  readonly authorized_at: string | null;
  /** Whether a ceiling above the grant warns or refuses. Absent means `warn`. */
  readonly on_grant_exceed: OnGrantExceed;
```

`validateRunBudget` — copy the `ceiling_host_tokens` / `on_host_tokens_exceed` blocks verbatim in shape (`:154-163`): checked only when present and non-null, `requireNumber` for the two amounts, `requireString` for `authorized_by`, `requireEnum(doc.on_grant_exceed, ON_GRANT_EXCEED, …)`. Inside the phase loop, the same for `phase.authorized_usd`. Every existing file keeps validating. **Do not add a sum rule**: a phase grant is not required to fit the run grant, because they answer two different questions and inventing an arithmetic between them would be a rule nobody stated.

`asRunBudget` (`:234-254`) — `authorized_usd: doc.authorized_usd ?? null,` and siblings, `on_grant_exceed: doc.on_grant_exceed ?? DEFAULT_ON_GRANT_EXCEED,`, and `authorized_usd: phase.authorized_usd ?? null,` inside the phase map.

`emitBudgetYaml` (`:217-262`) — three conditional lines beside the existing three, each carrying the same comment those do (a key that does not round-trip is erased by `budget raise`):

```ts
    ...(budget.authorized_usd === null ? [] : [`authorized_usd: ${money(budget.authorized_usd)}`]),
    ...(budget.authorized_by === null ? [] : [`authorized_by: ${yamlScalar(budget.authorized_by)}`]),
    ...(budget.authorized_at === null ? [] : [`authorized_at: ${yamlScalar(budget.authorized_at)}`]),
    ...(budget.on_grant_exceed === DEFAULT_ON_GRANT_EXCEED
      ? []
      : [`on_grant_exceed: ${yamlScalar(budget.on_grant_exceed)}`]),
```

and in the phase mapping (`:250-259`), a `grant` fragment beside `economy` and `hostTokens`, appended only when non-null.

`newRun.ts:216-239` — the one construction site. Add `authorized_usd: null, authorized_by: null, authorized_at: null, on_grant_exceed: DEFAULT_ON_GRANT_EXCEED,` to the run object and `authorized_usd: null,` to each phase, each with the one-line reason: a new run carries no grant, and null is not 0.

- [ ] **Step 4: Write the grant leaf**

Create `src/core/budget/grant.ts`:

```ts
/**
 * Reconciling a CEILING against what the owner AUTHORIZED (#170).
 *
 * A separate leaf from `wouldExceed.ts` on purpose, and the header says so
 * because the two are one word apart: `wouldExceed` asks "may this run spend
 * more"; this asks "may this file hold this ceiling". They are two questions and
 * one function cannot answer both without losing the first.
 *
 * Absence is the LAX side, everywhere: no grant recorded means nothing is
 * reconciled and nothing is refused. `$0` is never inferred from silence.
 */
import { type RunBudget, type OnGrantExceed } from "./RunBudget.ts";

export interface Grant {
  readonly usd: number;
  /** The fact the grant cites. A grant with no decision behind it is not recorded. */
  readonly factId: string;
  readonly level: "phase" | "run";
}

/**
 * The grant governing `phaseId`: the phase's own, else the run's, else null.
 *
 * Phase-then-run and never anything cleverer — the same precedence `economyFor`
 * uses one file over (`RunBudget.ts:112-125`), for the same reason.
 */
export function grantFor(budget: RunBudget, phaseId?: string | null): Grant | null {
  if (phaseId !== undefined && phaseId !== null) {
    const phase = budget.phases.find((p) => p.id === phaseId);
    if (phase?.authorized_usd != null && budget.authorized_by !== null) {
      return { usd: phase.authorized_usd, factId: budget.authorized_by, level: "phase" };
    }
  }
  if (budget.authorized_usd === null || budget.authorized_by === null) return null;
  return { usd: budget.authorized_usd, factId: budget.authorized_by, level: "run" };
}

export interface GrantVerdict {
  readonly exceeds: boolean;
  /** True only when it exceeds AND the file says `block`. */
  readonly blocked: boolean;
  readonly grant: Grant | null;
  /** What to print. Null when there is no grant, because there is nothing to say. */
  readonly sentence: string | null;
}

export function wouldExceedGrant(
  budget: RunBudget,
  phaseId: string | null,
  resultingCeilingUsd: number,
): GrantVerdict {
  const grant = grantFor(budget, phaseId);
  if (grant === null) {
    return { exceeds: false, blocked: false, grant: null, sentence: null };
  }
  const exceeds = resultingCeilingUsd > grant.usd + 1e-9;
  const policy: OnGrantExceed = budget.on_grant_exceed;
  if (!exceeds) return { exceeds: false, blocked: false, grant, sentence: null };
  return {
    exceeds: true,
    blocked: policy === "block",
    grant,
    sentence:
      `$${resultingCeilingUsd.toFixed(2)} is above the $${grant.usd.toFixed(2)} authorized `
      + `by ${grant.factId} (${grant.level} grant)`
      + (policy === "block" ? " — refused; raise the grant first, or record a new decision." : "."),
  };
}
```

- [ ] **Step 5: The verb, and the grant-aware raise**

`src/cli/commands/budget.ts` — `VALUE_FLAGS` gains `"fact"`, `"phase"` and `"on-exceed"`; the dispatch gains `case "grant": return budgetGrant(rest);` and the default message becomes `` expected `show`, `raise` or `grant` ``; `usage` gains the third line.

`budgetGrant` mirrors `budgetRaise` (`:61-121`): parse, validate, resolve the run, mutate, append the event BEFORE the save, print. Its own rules:

- the amount parses the same way `budgetRaise` does (`:69-72`) — a bad one is `UsageError` → **1**;
- `--fact` is required and must name a LIVE fact in `.tldrx/memory/facts.yml` — otherwise `UsageError` → **1**, with the sentence saying that a grant with no decision behind it is a number nobody said;
- `--phase` absent means the run ceiling — the common case; **`--phase` present still writes the run-level `authorized_by` and `authorized_at`**, because `grantFor`'s phase branch reads `phase.authorized_usd != null && budget.authorized_by !== null` — a phase amount with no fact id beside it resolves to no grant at all, which is a recorded number that silently governs nothing;
- `--on-exceed` (values `ON_GRANT_EXCEED`) sets `on_grant_exceed`; absent leaves it as it was;
- if the CURRENT ceiling already exceeds the grant being recorded, print the `wouldExceedGrant` sentence — recording a grant never rewrites a ceiling, and it never refuses (there is nothing to refuse: the money is already committed);
- append `budget.granted` with `{amount_usd, fact, phase, note, ceiling_usd}` before `store.save()`, exactly as `budget raise` does at `:89-107`, so a grant that fails validation leaves no event claiming it happened.

In `budgetRaise`, immediately after `raiseBudget(...)` returns and **before** `store.mutateBudget(...)` (`:77-82`):

```ts
    // The RESULTING ceiling, against what the owner authorized — checked before
    // anything is written, so a refusal leaves budget.yml byte-identical.
    //
    // TWO BRANCHES, and they are not interchangeable. `grantFor` prefers a PHASE
    // grant when the phase declares one, and a phase grant governs that phase's
    // ceiling — not the run's. `--take-from` is the case that separates them: it
    // moves money between phases and leaves the run ceiling exactly where it was,
    // so measuring a phase grant against `runCeilingAfter` would refuse a move
    // that changed nothing the grant is about. Written out rather than folded
    // into one expression, because the wrong one is invisible in a diff.
    const phaseGrant = grantFor(store.budget, phaseId);
    const verdict = phaseGrant !== null && phaseGrant.level === "phase"
      ? wouldExceedGrant(store.budget, phaseId, outcome.phaseCeilingAfter)
      : wouldExceedGrant(store.budget, null, outcome.runCeilingAfter);
    if (verdict.blocked) {
      process.stderr.write(`tldrx budget raise: ${verdict.sentence ?? ""}\n`);
      return EXIT_GATE_REFUSED;
    }
```

and after the success write, `if (verdict.sentence !== null) lines.push(verdict.sentence);` so a `warn` says so on stdout. Import `EXIT_GATE_REFUSED` (`:12` currently imports `EXIT_OK, EXIT_USAGE`) and `grantFor` + `wouldExceedGrant` from `../../core/budget/grant.ts`.

That is the whole of the phase-vs-run reconciliation, and Step 1's last test is the pin the one-expression version fails.

- [ ] **Step 6: Event, replay, dashboard, help, guide**

`Event.ts:118`: `"budget.warned", "budget.blocked", "budget.raised", "budget.granted",`.

`renderReplay.ts`, beside `case "budget.blocked"` (`:190`):

```ts
    case "budget.granted":
      return `${prefix}budget granted: ${money(Number(payload.amount_usd ?? 0))} authorized by `
        + `${text(payload.fact)}${payload.phase == null ? "" : ` for ${text(payload.phase)}`}`;
```

`dashboard/model.ts`: `BudgetModel` gains `authorizedUsd: number | null`, `authorizedBy: string | null` and `onGrantExceed: string` (never null — absence reads as `warn`, resolved here so the renderer does not re-derive a default the enforcement path owns, which is the argument `onHostTokensExceed` already makes at `:203-206`); `BudgetPhaseModel` gains `authorizedUsd: number | null`; the projection (`:1330-1345`) reads them off `budget`. **`DASHBOARD_MODEL_VERSION` stays 3** — additions never bump it, and no existing field's meaning moves. A recorded grant the run's own page cannot see would be exactly the written-but-never-read-back failure this wave exists to kill.

`helpText.ts`, the `budget` entry: `subcommands: ["show", "raise", "grant"]`; an `<usd>` arg meaning for `grant` (a CEILING the owner authorized, not a delta — say it, because `raise` next door is a delta); flags `fact` (`sub: "grant"`, required), `phase` (`sub: "grant"`), `on-exceed` (`sub: "grant"`, `values: ON_GRANT_EXCEED`); and a note naming **which refusal is 1 and which is 2**: a bad amount or a `--fact` naming no live fact is a usage error; a ceiling above the recorded grant under `on_grant_exceed: block` is a gate refusal. No new exit code — the entry already declares both.

`docs/guide/08-cli-reference.md`: the `## \`tldrx budget\`` section names `grant`, `--fact`, `--phase` and `--on-exceed`.

- [ ] **Step 7: Run the named tests, prove teeth, gate and commit**

```
bun test test/budget-grant.test.ts test/budget-ux.test.ts test/money-safety.test.ts test/remaining-work.test.ts test/dashboard.test.ts test/replay.test.ts
```
Expected: PASS. `test/budget-ux.test.ts:134-180` and `:261` stay green (the grant refusal is a seventh path, with its own test asserting 2); `test/money-safety.test.ts:72` and `:400` stay green; **`test/remaining-work.test.ts:138-147` stays green because nothing it mirrors moved — a red there means the change grew beyond this plan, so stop and re-scope rather than following it.**

Teeth, and the important one first: **delete the four `authorized_*` lines from `emitBudgetYaml`** — every test except "a grant survives `budget raise`" still passes, and that one goes RED. That is the whole reason the pin exists; keep its RED. Revert. Then change `wouldExceedGrant`'s `grant === null` early return to `exceeds: true` — the "no grant recorded" test goes RED. Revert.

```
bun test test/build-golden.test.ts
echo "golden: $?"
```
```
bun run typecheck
echo "typecheck: $?"
```
```
bun test
echo "test: $?"
```
Expected: `0`, `0`, `0`.

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(budget): a ceiling answers to a recorded grant (#170)

Three places wrote a dollar ceiling and one place recorded what the owner said
they would pay, and no code path connected them — `grep` over `src/core/budget/`
for grant/authoriz/reconcil returned zero functional hits. `budget.yml` now
carries `authorized_usd`, `authorized_by` (the fact id), `authorized_at` and
`on_grant_exceed`, written by `tldrx budget grant <usd> --fact <F> [--phase <p>]`,
and `budget raise` reconciles the RESULTING ceiling against them before it writes.

Required-and-nullable in the interface, tolerant in the validator, defaulted in
`asRunBudget`, conditional in the emitter — `ceiling_host_tokens`'s shape copied
end to end rather than just its docstring. `?: T | null` would have made three
states with no stated difference between two of them.

Absence is the LAX side and it is stated on every key: no grant recorded means
nothing is reconciled and nothing is refused. Absent read as $0 would refuse
every raise on every run on disk.

`on_grant_exceed` is deliberately NOT `on_exceed`: one governs spending past a
ceiling, the other governs writing a ceiling the owner forbade, and a run that
blocks on dollars has said nothing about the second.

THE PIN THAT MATTERS: a grant survives `budget raise`. `emitBudgetYaml`
enumerates keys and its own comments say a key that does not round-trip is
ERASED by the one command an operator reaches for when a ceiling binds — and
that command is this one. With the emitter lines removed, every other test here
still passes and the grant is gone after the first raise. That test is the
difference between a recorded grant and a promise.

Exit families, and they are two conditions rather than one split: a bad amount
or a `--fact` naming no live fact is 1; a ceiling above the grant under
`on_grant_exceed: block` is 2, matching #167's move of `tldrx ship`'s state
refusal. `budget` already declared both codes, so its exit surface does not grow.

`caps.ts` and `remainingWork.ts` were not touched, and `test/remaining-work.test.ts`
stayed green — that pin is the tripwire that says a share-arithmetic change has
crept in. No golden byte moves: no cap arithmetic, no stage literal, and
`budget.granted` fires in no scenario.

The dashboard projects the grant (DASHBOARD_MODEL_VERSION stays 3 — additions
never bump it): a recorded grant the run's own page cannot see would be the same
written-never-read failure this wave exists to remove.

RED kept:
<paste Step 2 verbatim>

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: #170 — `triage.budget_basis`, and the preset literals labelled as the assumptions they are

**Files:**
- Modify: `src/core/run/RunFile.ts` — `RunTriage` (`:311-316`), the `triage` validation (`:563-575`, `requireKeys(doc.triage, ["split", "depends_on"], …)` at `:565`)
- Modify: `src/core/run/emitRunYaml.ts:167-169` — the fixed inline `triage:` mapping
- Modify: `src/core/run/newRun.ts:76`, `:207` — `options.triage` passes straight through
- Modify: `src/core/seed/applySplit.ts:137` — `triage: { split: splitRef, depends_on: run.depends_on },`
- Modify: `stages/what/stage.yml:15`, `stages/how/stage.yml:15`, `stages/plan/stage.yml:14`, `stages/build/stage.yml:23`, `stages/watch/stage.yml:25` — comments only
- Modify: `workflows/*.yml` × 13, each `default_budget_usd:` on line 14 — comments only
- Test: `test/seed-triage.test.ts` (the validation describe at `:278`); `test/state-corruption.test.ts` for the `run.yml` round trip — **measured: `:282` is `expect(emitRunYaml(second.run)).toBe(first)`, the byte pin; there is no `test/run-file.test.ts`**; and `test/schemas.test.ts`, `test/stage-override.test.ts`, `test/preset-map-inputs.test.ts`, `test/plan-contract.test.ts`, `test/build-implicit-plan.test.ts` — the five that read the shipped preset files, run after the comment edit

**Interfaces:**
- Consumes: `requireKeys` (`src/core/schemas/validation.ts:102-113`, which checks required keys and ignores extras), `requireEnum`.
- Produces: `RunTriage.budget_basis?: "model-guess" | "owner-grant" | "preset"`, and `TRIAGE_BUDGET_BASES` as the closed set it is validated against.

### The measured problem

`triagePrompt.ts:249` tells the model, verbatim: `` `- \`budget_usd\` is a guess at what the run will cost. S ≈ $10, M ≈ $25, L ≈ $50.` ``; `splitFile.ts:213-215` accepts any finite `> 0`; and `applySplit.ts:207` passes it into `run new --budget` as `run.budget_usd.toFixed(2)`. The number that ends up enforcing every spawn in the run is measurably a guess, and nothing on disk says so.

The stage and workflow literals carry `[assumption]` comments about `effort:` (`stages/build/stage.yml:20-22`, `stages/what/stage.yml:11-14`) and **none about the money** — so #170 ask (3)'s "at minimum, label them" is literally unmet.

**The literals are NOT moved.** `tldrx init` copies no `stages/` into `.tldrx/` (`grep -rn 'stages' src/core/init/` → one doc-comment hit) and `workflowPreset.stagePath` (`:119-125`) prefers a local override else the shipped file — so editing a shipped literal moves the ceiling of **every workspace that never wrote an override**, and this repo holds no calibration corpus to derive a new number from. Task 9 ships the command that produces one; the recalibration is filed as its own issue in Task 12.

### The golden statement

**Expected: no golden byte moves.** Comments in `stages/`/`workflows/` cannot reach the fixtures at all: `test/fixtures/build/workspace.ts:282-297` writes the fixture's OWN `.tldrx/stages/build/stage.yml` at `budget_usd: 8` and its own workflow at `default_budget_usd: 8`, so the golden never reads a shipped literal. `triage.budget_basis` is emitted only when present and no golden scenario is triaged, so `run.yml` is byte-identical — the artifacts that WOULD move otherwise are `*-run-tasks.txt`.

- [ ] **Step 1: Write the failing tests**

In `test/seed-triage.test.ts`, in the validation describe (`:278`):

```ts
test("an applied split records that its budget was a model's guess", () => {
  const ws = seedWorkspace();
  applySplit(goodProposal(), { root: ws.root, actor: "t", now: NOW });
  const run = loadRun(onlyRunDir(ws.root));
  expect(run.triage?.budget_basis).toBe("model-guess");
});

test("a run created by `run new` has no basis at all — absent means what every existing run means", () => {
  const ws = seedWorkspace();
  createRun({ root: ws.root, slug: "plain", /* … */ });
  expect(loadRun(onlyRunDir(ws.root)).triage).toBeUndefined();
});
```

In `test/state-corruption.test.ts`, beside its existing `emitRunYaml` byte pin (`:282`):

```ts
test("triage.budget_basis round-trips through the emitter", () => {
  const run = { ...triagedRun(), triage: { split: "s.yml", depends_on: [], budget_basis: "model-guess" } };
  const text = emitRunYaml(run);
  // Unquoted: `yamlScalar` emits a plain scalar when PLAIN_SAFE matches
  // (`emitRunYaml.ts:16-18`), and `model-guess` does. Never force quoting in an
  // emitter to satisfy a test.
  expect(text).toContain("budget_basis: model-guess");
  expect(validateRunFile(parseYaml(text)).ok).toBe(true);
  expect(asRunFile(parseYaml(text)).triage?.budget_basis).toBe("model-guess");
});

test("a triaged run WITHOUT a basis is emitted byte-identically to before the key existed", () => {
  const run = { ...triagedRun(), triage: { split: "s.yml", depends_on: [] } };
  expect(emitRunYaml(run)).toContain("triage: {split: s.yml, depends_on: []}");
});

test("a value outside the closed set is refused", () => {
  const doc = parseYaml(emitRunYaml(triagedRun()));
  (doc as any).triage = { split: "s.yml", depends_on: [], budget_basis: "vibes" };
  expect(validateRunFile(doc).ok).toBe(false);
});
```

And one test that the money literals now say what they are — assert the marker, never a bare English word:

```ts
test("every shipped money literal carries an [assumption] label ON the money (#170 ask 3)", () => {
  // The marker is asserted by its EXACT TEXT, inside the contiguous comment block
  // immediately above the key — not by a lookback window. Measured at the base: a
  // six-line window is already GREEN for all five `stages/*/stage.yml`, because it
  // catches the `effort:` [assumption] comments those files already carry
  // (`stages/what/stage.yml:11` against `budget_usd:` at `:15`), and a guard that
  // passes before the change is not a guard. Measured too: the line IMMEDIATELY
  // above every one of the eighteen money keys is another key (`effort:` in the
  // five stages, `depth:` in the thirteen workflows), so the label has to be a
  // comment block written directly above the key and nowhere else.
  for (const file of [...stageFiles(), ...workflowFiles()]) {
    const lines = readFileSync(file, "utf8").split("\n");
    const key = lines.findIndex((l) => /^(budget_usd|default_budget_usd)\s*:/.test(l));
    expect(key, `${file} declares a money literal`).toBeGreaterThan(0);
    const marker = (lines[key] ?? "").startsWith("default_budget_usd")
      ? "`default_budget_usd` [assumption]"
      : "`budget_usd` [assumption]";
    const block: string[] = [];
    for (let i = key - 1; i >= 0 && (lines[i] ?? "").trimStart().startsWith("#"); i--) {
      block.unshift(lines[i] ?? "");
    }
    expect(block.join("\n"), `${file} labels its money literal`).toContain(marker);
  }
});
```

Put that test in `test/schemas.test.ts` or wherever the shipped presets are already read — do not create a file for it.

- [ ] **Step 2: Run them and keep the RED verbatim**

```
bun test test/seed-triage.test.ts test/schemas.test.ts
```
Expected: FAIL — `expect(received).toBe(expected)` with `received: undefined, expected: "model-guess"`, and **18** failures of the form `expect(received).toContain("\`budget_usd\` [assumption]")` / `…("\`default_budget_usd\` [assumption]")`, one per preset file. Paste a representative slice plus the count.

**Both numbers, so the count is not mistaken for drift.** 18 is the RED for the predicate written above, and it is measured: `grep -rn 'budget_usd\` \[assumption\]' stages workflows` returns **0** hits today. The pre-flight scan measured **13** for the plan's earlier six-line-window predicate — 5 of the 18 already passed, because that window reached the `effort:` labels — and that is exactly why the predicate was replaced rather than the number corrected. If your run reports 13, you are running the old predicate.

- [ ] **Step 3: The additive key, its validator and its emitter**

`RunFile.ts`, in `RunTriage` (`:311-316`):

```ts
/** Where a triaged run's `--budget` figure came from. */
export const TRIAGE_BUDGET_BASES = ["model-guess", "owner-grant", "preset"] as const;
export type TriageBudgetBasis = (typeof TRIAGE_BUDGET_BASES)[number];
```
```ts
  /**
   * What produced this run's ceiling (#170), or absent — which is what every
   * run written before this key existed means.
   *
   * `applySplit` writes `model-guess` because that is measurably what produced
   * it: `triagePrompt.ts:249` tells the model "`budget_usd` is a guess … S ≈ $10,
   * M ≈ $25, L ≈ $50", and `splitFile.ts:213-215` validates only "finite and > 0".
   * A ceiling that enforces every spawn in the run should say when it was a guess.
   */
  readonly budget_basis?: TriageBudgetBasis;
```

Validation (`:563-575`) — `requireKeys` checks required keys and ignores extras (`validation.ts:102-113`), so the new key is validated EXPLICITLY when present, the `decided_by` pattern:

```ts
      // Optional and additive: absence is what every existing run means, and only
      // a value this reader does not understand is an issue.
      if (doc.triage.budget_basis !== undefined) {
        requireEnum(doc.triage.budget_basis, TRIAGE_BUDGET_BASES, "triage.budget_basis", issues);
      }
```

`emitRunYaml.ts:167-169`:

```ts
  if (run.triage !== undefined) {
    // Emitted only when it is set, so a run.yml written before this key existed
    // round-trips byte-for-byte — the same rule `triage` itself and
    // `build.branch_model` follow two lines down.
    const basis = run.triage.budget_basis === undefined
      ? ""
      : `, budget_basis: ${yamlScalar(run.triage.budget_basis)}`;
    lines.push(
      `triage: {split: ${yamlScalar(run.triage.split)}, depends_on: ${inlineList(run.triage.depends_on)}${basis}}`,
    );
  }
```

`applySplit.ts:137`: `triage: { split: splitRef, depends_on: run.depends_on, budget_basis: "model-guess" },`. `newRun.ts:207` spreads `options.triage` wholesale, so nothing there changes — confirm that by reading `:76` and `:207` rather than assuming it.

- [ ] **Step 4: Label the eighteen literals — comments only, no number moves**

In each of the five `stages/*/stage.yml`, immediately above the `budget_usd:` line, in that file's own comment voice:

```yaml
# `budget_usd` [assumption]: a scoped guess, never a measurement. No calibration
# corpus exists in this repo, and the one measurement we do have runs the other
# way — a story measured $2.27 against the $0.39 ceiling its spawn was given
# (5.8x). `tldrx cost --stories` is the command that produces the corpus a
# recalibration would need. Changing this number moves the ceiling of every
# workspace that never wrote a `.tldrx/stages/<id>/stage.yml` override.
```

and in each of the thirteen `workflows/*.yml`, above `default_budget_usd:` on line 14, the same label sized to a workflow (`default_budget_usd` is the whole run, split across the stages by `planBudget`). **Nothing but comments changes. If a single digit moves, revert — the non-goal is explicit.**

- [ ] **Step 5: Run the named tests, prove teeth, gate and commit**

```
bun test test/seed-triage.test.ts test/schemas.test.ts test/stage-override.test.ts test/preset-map-inputs.test.ts test/plan-contract.test.ts test/build-implicit-plan.test.ts test/state-corruption.test.ts
```
Expected: PASS. The five preset readers parse YAML, so comments are invisible to them — but run them, because "comments are ignored" is a claim about a parser and this repo's rule is to check the instrument.

```bash
git diff --stat -- stages workflows
```
Expected: 18 files changed, insertions only, **0 deletions**. A deletion means a literal moved: revert it.

Teeth: drop the `basis` fragment from `emitRunYaml` — the round-trip test goes RED while the `applySplit` test still passes, which is the drop this pin catches. Revert.

```
bun test test/build-golden.test.ts
echo "golden: $?"
```
```
bun run typecheck
echo "typecheck: $?"
```
```
bun test
echo "test: $?"
```
Expected: `0`, `0`, `0`.

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(run): a seeded ceiling says it was a guess, and the presets say so too (#170)

`triagePrompt.ts:249` tells the model in as many words that `budget_usd` is a
guess (S ≈ $10, M ≈ $25, L ≈ $50), `splitFile.ts:213-215` validates only
"finite and > 0", and `applySplit.ts:207` hands it to `run new --budget` where it
becomes the ceiling enforcing every spawn in the run. Nothing on disk said any of
that. `run.yml`'s `triage` block now carries an optional `budget_basis`, written
`model-guess` by `applySplit` because that is measurably what produced it.

Additive, emitted only when present, so a run.yml written before the key
round-trips byte-for-byte; validated explicitly when present because
`requireKeys` ignores extras; absent means what every existing run means.

The eighteen shipped money literals — five `stages/*/stage.yml`, thirteen
`workflows/*.yml` — gain `[assumption]` comments naming what the number is and
what it is not, with the measured counter-evidence beside them (a story measured
$2.27 against a $0.39 ceiling, 5.8x). They carried `[assumption]` labels about
`effort:` and none about the money, so the issue's "at minimum" was literally
unmet.

NOT recalibrated, and the reason is measured: `tldrx init` copies no `stages/`
into `.tldrx/` and `workflowPreset` prefers a local override else the shipped
file, so moving a literal moves the ceiling of every workspace that never wrote
an override — and this repo holds no corpus to derive a new number from.
`git diff --stat -- stages workflows` is insertions only, 0 deletions.

No golden byte moves: the fixture writes its own stage.yml and workflow
(`test/fixtures/build/workspace.ts:282-297`), so it never reads a shipped
literal, and no scenario is triaged.

RED kept:
<paste Step 2 verbatim>

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: #170 — `tldrx cost --stories`, and the N× clause on the Build handoff's cost line

**Files:**
- Create: `src/core/build/planVsMeasured.ts`
- Modify: `src/core/budget/costView.ts` — a `buildStoryCost(runDir)` + `renderStoryCost` beside `buildRunCost` (`:122`) and `renderRunCost` (`:265`)
- Modify: `src/cli/commands/cost.ts` — `usage` (`:26`), the `--stories` branch (beside `--all` at `:42-48`)
- Modify: `src/core/build/phaseCost.ts` — `PhaseCost.note`, `phaseCostToDate`'s signature (`:102-108`) and its two returns (`:155-163`)
- Modify: `src/core/facilitator/executors/build.ts:2300-2302` — the `phaseCostToDate(...)` call
- Modify: `src/cli/helpText.ts` — the `cost` entry (`:934-963`)
- Modify: `docs/guide/08-cli-reference.md` — the `## \`tldrx cost\`` section names `--stories`
- Test: `test/economy.test.ts` and `test/token-economy.test.ts` — **measured: those two are the only files that import `buildRunCost`/`renderRunCost`; there is no `test/cost.test.ts`** — plus `test/build-executor.test.ts`, which is the only file that imports `phaseCostToDate` AND `renderBuildHandoff`

**Interfaces:**
- Consumes: `agent.spawned` payloads carrying `{story, role, max_budget_usd}`, and `agent.result` rows whose story key is the payload's `key` and whose dollars are the **ENVELOPE's `cost_usd`** — measured in the committed golden stream, where `rounds-events.txt` `#19` reads `agent.result … cost_usd=0.1 keys=[effort,key,model,outputs,phase,session_id,task]`: `cost_usd` is NOT a payload key. `costView.toAttempt` (`:188-198`) is the precedent — it reads `event.cost_usd` and gates on `payload.metered !== false`. `round2` (`caps.ts:122-125`).
- Produces:
  - `overShareSentence(ceilingUsd: number | null, measuredUsd: number | null, stories: number): string | null`
  - `buildStoryCost(runDir): { rows: readonly StoryCostRow[]; note: string | null } | null` where `StoryCostRow = { story: string; ceilingUsd: number | null; measuredUsd: number | null; ratio: number | null }`
  - `PhaseCostTurn` unchanged; `phaseCostToDate(..., stories?: readonly StorySpend[])` with `StorySpend = { ceilingUsd: number | null; measuredUsd: number | null }`

### The measured problem, and the name that matters

Ask (4) wants the framework to say when a story cost N× what it was given. Two things had to be settled first, and both are measured:

1. **`tldrx cost` reads `events.jsonl` and nothing else** (`cost.ts:3`, its own words) and *"nothing here multiplies a token count by a price"* (`:4-6`). Both sides of the ratio are IN the events: `agent.spawned` carries `max_budget_usd` and `agent.result` carries `key` and `cost_usd`. So the report is derivable without touching `run.yml`, the plan, or a price table, and `cost.ts:3` stays true.
2. **It is a CEILING, not "the plan's share", and the report must say so.** `STORY_KEYS` is `version, id, epic, title, repo, status, depends_on, touches, acceptance, test_plan, evidence` (`src/core/schemas/story.ts:41-44`) — **no budget key at all**. No plan document carries a per-story dollar figure. The figure a story is measured against is the one the executor computed and handed the spawn (`caps.ts` `developerCap`/`reviewerCap`, surfaced as `agent.spawned.max_budget_usd`). So the sentence is *"S1 measured $2.27 against the $0.39 ceiling its spawn was given — 5.8×"*, and it never invents a plan figure that does not exist.

This changes no ceiling. It is the calibration INPUT the recalibration issue will need, and the reason that issue can be filed with a corpus instead of an argument.

**`caps.ts` is still out of scope.** This reads what the caps produced; it does not compute a cap.

### The golden statement

**Expected: no golden byte moves.** `overShareSentence` lands on `phaseCostToDate`'s `note`, whose single reader is the Build handoff header (`build/handoff.ts:94`; `phaseCostToDate`'s only call sites are `build.ts:2300` and its re-export at `:2997`) — and `grep -rn "Cost: " test/fixtures/build/golden/` returns no match, so the handoff is not a golden artifact. **Not a new event** — that is the only option with golden-byte risk — and never in a prompt.

- [ ] **Step 1: Write the failing tests**

```ts
describe("overShareSentence — one arithmetic, and null when a side is missing", () => {
  test("it names the ceiling, the measurement and the ratio, and calls the ceiling a ceiling", () => {
    const said = overShareSentence(0.39, 2.27, 1) ?? "";
    expect(said).toContain("2.27");
    expect(said).toContain("0.39");
    expect(said).toContain("5.8");
    expect(said).toContain("ceiling");
    // No plan document carries a per-story dollar figure (`STORY_KEYS`), so the
    // sentence must never imply one.
    expect(said).not.toContain("plan");
  });

  test("under the ceiling it says nothing — a caveat on every header is one nobody reads", () => {
    expect(overShareSentence(5, 1, 1)).toBeNull();
  });

  test("either side absent is null, never a ratio over a figure it does not have", () => {
    expect(overShareSentence(null, 2.27, 1)).toBeNull();
    expect(overShareSentence(0.39, null, 1)).toBeNull();
    expect(overShareSentence(0, 2.27, 1)).toBeNull();
  });
});

describe("tldrx cost --stories", () => {
  test("per story: measured, the ceiling its spawn was given, and the ratio — off events only", async () => {
    const ws = await runWithEvents([
      spawned({ payload: { story: "S1", role: "developer", max_budget_usd: 0.39 } }),
      // `cost_usd` on the ENVELOPE, not in the payload — that is where it lives
      // in the real stream, and a fixture built the other way would go green
      // against a reader that sums nothing.
      result({ cost_usd: 2.27, payload: { key: "S1" } }),
    ]);
    const out = await tldrx(ws.root, "cost", "--stories");
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("S1");
    expect(out.stdout).toContain("2.27");
    expect(out.stdout).toContain("0.39");
    expect(out.stdout).toContain("5.8");
  });

  test("a story with no spawned ceiling is reported as absent, not as a zero", async () => {
    const ws = await runWithEvents([result({ cost_usd: 1.0, payload: { key: "S2" } })]);
    const out = await tldrx(ws.root, "cost", "--stories");
    expect(out.stdout).toContain("S2");
    expect(out.stdout.toLowerCase()).toContain("not recorded");
    expect(out.stdout).not.toContain("$0.00");
  });

  test("a run with no story spawns at all says so rather than printing an empty table", async () => {
    const ws = await runWithEvents([]);
    expect((await tldrx(ws.root, "cost", "--stories")).stdout.toLowerCase()).toContain("no story");
  });
});

// THE failing assertion for this task's handoff half: it goes through the real
// path — `phaseCostToDate`'s `note`, which is what `build.ts:2308` hands to
// `renderBuildHandoff` as `costNote`. The two `renderBuildHandoff` assertions
// below are GUARDS: both are already green at the base (`handoff.ts:95` renders
// ` (${costNote})`, and the check is `== null`, so `parts({})` already equals
// `parts({costNote: null})`), so neither can fail for the reason this task
// exists — assert against behaviour, not against the constant that produced it.
test("phaseCostToDate's note carries the over-ceiling clause when the stories overran", () => {
  const ws = stageWithSpend();                          // one story, $2.27 metered
  const cost = phaseCostToDate(ws.runDir, "04-build", "build", 0, [], [
    { ceilingUsd: 0.39, measuredUsd: 2.27 },
  ]);
  expect(cost.note ?? "").toContain("5.8");
  expect(cost.note ?? "").toContain("ceiling");
});

test("and says nothing when the stories fit — no clause, and the fully-metered stage keeps its clean line", () => {
  const ws = stageWithSpend();
  expect(phaseCostToDate(ws.runDir, "04-build", "build", 0, [], [
    { ceilingUsd: 5, measuredUsd: 1 },
  ]).note).toBeNull();
});

test("GUARD (green before this change): a note reaches the handoff header, and a null one changes nothing", () => {
  expect(renderBuildHandoff(parts({ costNote: "5.8x over" }))).toContain("5.8x over");
  expect(renderBuildHandoff(parts({ costNote: null }))).toBe(renderBuildHandoff(parts({})));
});
```

- [ ] **Step 2: Run them and keep the RED verbatim**

```
bun test test/economy.test.ts test/build-executor.test.ts
```
Expected: FAIL — `Cannot find module '../src/core/build/planVsMeasured.ts'`, and `tldrx cost: unknown flag --stories (see \`tldrx cost --help\`)` with exit `1` where `0` was expected. That second one is `flagRefusal` doing its job and is worth keeping in the message: it is the proof that declaring a flag in `helpText.ts` is dispatch, not documentation.

- [ ] **Step 3: Write the arithmetic leaf**

Create `src/core/build/planVsMeasured.ts`:

```ts
/**
 * What a story cost against the ceiling its spawn was given (#170 ask 4).
 *
 * ONE arithmetic, two feeders, and neither reads a price table: `tldrx cost
 * --stories` feeds it from `agent.spawned.max_budget_usd` and
 * `agent.result.cost_usd` (events only, so `cost.ts:3`'s "reads events.jsonl and
 * nothing else" stays true), and the Build handoff feeds it from the caps the
 * executor just used and the turns it just ran.
 *
 * IT IS A CEILING, NOT "THE PLAN'S SHARE", and the sentence says so. Measured:
 * `STORY_KEYS` is `version, id, epic, title, repo, status, depends_on, touches,
 * acceptance, test_plan, evidence` — no plan document carries a per-story dollar
 * figure at all. The figure a story is measured against is the one the executor
 * computed and handed the spawn. Calling it "the plan's share" would invent a
 * number no file holds, which is the whole failure #170 is about.
 *
 * Null when either side is absent, or the ceiling is not positive: a ratio over
 * a figure this cannot see is exactly the confident-zero this repo refuses.
 * A run inside its ceiling gets nothing — `measured` is the basis with nothing
 * to say, and a caveat on every header is a caveat nobody reads.
 */
import { round2 } from "./caps.ts";

export function overShareSentence(
  ceilingUsd: number | null,
  measuredUsd: number | null,
  stories: number,
): string | null {
  if (ceilingUsd === null || measuredUsd === null) return null;
  if (!(ceilingUsd > 0) || !(measuredUsd > 0)) return null;
  const ratio = measuredUsd / ceilingUsd;
  if (ratio <= 1) return null;
  const over = stories === 1 ? "1 story" : `${String(stories)} stories`;
  return `${over} measured $${round2(measuredUsd).toFixed(2)} against the `
    + `$${round2(ceilingUsd).toFixed(2)} ceiling their spawns were given — ${ratio.toFixed(1)}x`;
}
```

- [ ] **Step 4: The report, off events and nothing else**

In `src/core/budget/costView.ts`, beside `buildRunCost` (`:122`), add `buildStoryCost(runDir)`: read the same event stream `buildRunCost` reads, take `max_budget_usd` off each `agent.spawned` payload keyed by its `story`, and sum the money **through `toAttempt`'s precedent** (`:188-198`) — the **envelope's** `event.cost_usd`, keyed by the `agent.result` payload's `key`, with `payload.metered !== false` deciding whether the row counts at all. Return one row per story with `ceilingUsd`, `measuredUsd` and `ratio` — each `number | null`. **Summing `payload.cost_usd` would produce `0` for exactly the metered rows this report exists for**: measured, `cost_usd` is an envelope field and appears in no `agent.result` payload key list in the golden stream. An UNMETERED turn contributes `null`, never `0` — `toAttempt` already draws that line and this must not redraw it. A story that spawned but reported no cost, or reported a cost with no spawn, gets a `null` on that side and the renderer says **"not recorded"** with the reason, never `$0.00`. `renderStoryCost` prints the table plus the `overShareSentence` total; with no story rows at all it says so in a sentence. Read `toAttempt` (`:188`) and `renderRunCost` (`:265`) first and follow their idiom exactly — the existing file already distinguishes UNMETERED from zero and that distinction must survive.

In `src/cli/commands/cost.ts`, add the branch beside `--all` (`:42-48`), before the run resolution (a story report is per-run, so it goes after `RunStore.resolve` — read the surrounding code and put it where the store is in hand), and extend `usage` (`:26`).

- [ ] **Step 5: The clause on the cost line**

`src/core/build/phaseCost.ts` — add an optional final parameter and thread it into both returns:

```ts
/** One story's ceiling-vs-measured, as much of it as the cost line reads. */
export interface StorySpend {
  readonly ceilingUsd: number | null;
  readonly measuredUsd: number | null;
}
```
```ts
export function phaseCostToDate<T extends PhaseCostTurn>(
  runDir: string,
  phaseId: string,
  stageId: string,
  invocationUsd: number,
  invocationTurns: readonly T[] = [],
  stories: readonly StorySpend[] = [],
): PhaseCost {
```

At both `return` sites (`:155-163`), fold the clause into `note` beside the spend-basis caveat, keeping the existing rule that a fully-metered stage with nothing to say gets `null`:

```ts
  // One clause, from the ONE arithmetic. Absent when either side is missing or
  // the stories fit — the same discipline `bound` follows above.
  const over = overShareSentence(
    sumOrNull(stories.map((s) => s.ceilingUsd)),
    sumOrNull(stories.map((s) => s.measuredUsd)),
    stories.length,
  );
  const note = [bound, over].filter((part) => part !== null).join("; ") || null;
```

`sumOrNull` returns null when the list is empty or any entry is null — an absent side must not be summed as zero. Write it in this file, next to the only thing that uses it.

In `build.ts:2300-2302`, pass the executor's own rows: the caps it applied per story and the turns it ran for them. **The executor stays an orchestrator** — it hands data over; the arithmetic is in the leaf.

- [ ] **Step 6: Help, guide, then run the named tests, teeth, gate and commit**

`helpText.ts`, the `cost` entry: a `stories` flag (`arg: null`) whose meaning names the CEILING explicitly — *"per story: what it measurably cost, beside the ceiling its spawn was given (`agent.spawned.max_budget_usd`), and the ratio. Off `events.jsonl` only; no plan document carries a per-story dollar figure, so none is invented."* — and one note saying this changes no ceiling and is the input a recalibration would need. `docs/guide/08-cli-reference.md`: the `## \`tldrx cost\`` section names `--stories`.

```
bun test test/economy.test.ts test/token-economy.test.ts test/attempt-cost.test.ts test/estimate-remaining.test.ts test/build-executor.test.ts test/money-safety.test.ts test/remaining-work.test.ts
```
Expected: PASS. The four economy/estimate files are second-order — run them and READ the code, do not assume.

Teeth: make `overShareSentence` return a ratio when `ceilingUsd` is null — the absent test goes RED with a sentence over a figure it does not have. Revert.

```
bun test test/build-golden.test.ts
echo "golden: $?"
```
```
bun run typecheck
echo "typecheck: $?"
```
```
bun test
echo "test: $?"
```
Expected: `0`, `0`, `0`.

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(cost): what a story cost against the ceiling its spawn was given (#170)

The recalibration #170 asks for has no corpus in this repo. This is the command
that produces one: `tldrx cost --stories` reports, per story, what it measurably
cost, the ceiling its spawn was given, and the ratio — and one clause with the
same arithmetic lands on the Build handoff's cost line.

Both sides come off `events.jsonl` and nothing else, so `cost.ts:3`'s own
invariant survives intact: `agent.spawned` carries `max_budget_usd` and
`agent.result` carries `key` and `cost_usd`, both verified in the committed
golden stream. Nothing multiplies a token count by a price.

It is named for what it IS — a CEILING, not "the plan's share". Measured:
`STORY_KEYS` has no budget key, so no plan document carries a per-story dollar
figure at all, and the figure a story is measured against is the one the
executor computed and handed the spawn. Calling it a plan share would invent a
number no file holds, which is the failure this issue is about.

Absent-with-reason throughout: `overShareSentence` returns null when either side
is missing or the stories fit, and a story that spawned with no recorded cost is
"not recorded", never $0.00.

It changes no ceiling, and `caps.ts` was not touched — this reads what the caps
produced. Not a new event either: the clause goes on `phaseCostToDate`'s note,
whose only reader is the Build handoff header, and `grep -rn "Cost: "` over the
golden returns no match. No golden byte moves.

RED kept:
<paste Step 2 verbatim, including the `unknown flag --stories` refusal — it is
the proof that declaring a flag in helpText.ts is dispatch, not documentation>

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Docs — EN and ES in lockstep

**Files:**
- Modify: `docs/spec.md` — **§2.2** (`:132`), **§2.5** (`:509`), **§2.7** (`:806`), **§2.8** (`:906`), **§2.9** (`:1079`), **§2.11** (`:1253`), **§2.13** (`:1387`), **§3** (`:1690`), **§6.2** (`:3273`) — every line number re-verified in this worktree
- Modify: `docs/dashboard-model.md` — the `Run.budget` row (`:147`), which enumerates every `budget.yml` field the model projects
- Modify: `docs/guide/03-runs-and-gates.md`, `docs/guide/06-budgets-and-cost.md`, `docs/guide/08-cli-reference.md`
- Modify: `docs-site/concepts/evidence.md` **+ `docs-site/es/concepts/evidence.md`**
- Modify: `docs-site/concepts/gates.md` **+ `docs-site/es/concepts/gates.md`**
- Modify: `docs-site/concepts/budgets.md` **+ `docs-site/es/concepts/budgets.md`**
- Modify: `docs-site/guides/driving.md` **+ `docs-site/es/guides/driving.md`**
- Modify: `docs-site/guides/budgets.md` **+ `docs-site/es/guides/budgets.md`**
- Modify: `docs-site/reference/cli.md` **+ `docs-site/es/reference/cli.md`** — the curated, hand-written tour
- Modify: `src/cli/helpText.ts` — the four `notes` arrays, now that the commands are built and can be quoted
- Test: `test/public-surface-consistency.test.ts`, `test/docs-cli-coverage.test.ts`

**Interfaces:** none; this task adds no code.

**Never hand-edit** `docs-site/**/cli-flags.md` — those pages are GENERATED from `helpText.ts` by `docs-site/scripts/gen-cli.ts` at build time and are untracked. The curated `reference/cli.md` pair IS committed and IS part of this change.

- [ ] **Step 1: Read the surface rules before writing a word**

```
bun test test/public-surface-consistency.test.ts
echo "surface: $?"
```
Expected: `0`. Then READ the file. What it enforces and this task must not break: **the current version is never typed into prose** (the site derives it from `package.json`); banned positioning — "lightweight", bare "tool-agnostic", absolute state-coherence claims; runtime requirements distinguish running (Node ≥ 20) from building/contributing (Bun); the landing must name `tldrx drive`; the provider sentence is fixed: *"The workflow and persisted state format are provider-independent. The automated runner supports Claude Code and Codex."*

- [ ] **Step 2: `docs/spec.md`, section by section**

- **§2.5** (`:509`, `.tldrx/memory/facts.yml`): `conflicts_with` — optional, written only when non-empty, absent meaning "no contradiction was DETECTED", never "checked and agreed", with the check's measured limit stated (lexical, same `area`, question title vs fact text). That the ANSWER path now writes `source.decided_by`, and that its absence has exactly ONE meaning — "not stated", never "owner" — with the reason a given row has none said by `tldrx answer` on stdout rather than by a second field. **And fix the writer count**: the opening paragraph says "Two writers"; there are four (`captureAnswers`, `supersedeAnswer`, `facts add`, the distill importer at `newRun.ts:373`), all under the workspace lock, so the safety claim holds and only the count is wrong. Fixed in-wave because the sentence sits inside the very paragraph this change rewrites; `facts add --repo`'s missing validation is filed instead (Task 12) because that is a command this wave does not touch.
- **§2.7** (`:806`): the block a detected conflict raises, and that `affects:` may name a repo (`api` or `api:src/db.ts`) — with each reader taking only what it understands, so an existing `affects:` line full of document paths keeps meaning exactly what it meant.
- **§2.8** (`:906`): `## Unknowns` now also carries carried findings no story owns, each `[src: …]`-cited like every other bullet in the four sections. **The section list itself does not change**, and say why: `validateSections` only checks bullets inside the four required sections, so a fifth section's claims would be the one part of the document nothing validates.
- **§2.9** (`:1079`): `fact.conflict_raised` `{fact, conflicts_with, score, q}`, `story.touches_widened` `{story, paths, note, before, after}`, `budget.granted` `{amount_usd, fact, phase, note, ceiling_usd}` — and the standing fact that `EVENT_TYPES` is a closed enum, so a reader older than an event refuses it rather than ignoring it.
- **§2.11** (`:1253`): the four grant keys plus `BudgetPhase.authorized_usd` — required-and-nullable, defaulted by `asRunBudget`, emitted only when set, absent meaning "no grant recorded" and never `$0`. Say explicitly that `on_grant_exceed` is not `on_exceed` and why.
- **§2.2** (`:132`): `triage.budget_basis` — optional, absent meaning what every existing run means, `model-guess` written by `seed apply` because that is measurably what produced the figure.
- **§2.13** (`:1387`): `touches:` may be amended, by `tldrx story widen`, never on a `done` story, and the amendment is recorded as an event. No key is added to the front matter.
- **§6.2** (`:3273`): the split's basis.
- **§3** (`:1690`): `tldrx story widen`; `tldrx budget grant`; `tldrx answer --decided-by/--repo`; `tldrx cost --stories`; and the exit families — widen's own refusals are 2, the grant refusal is 2, a bad amount is 1, `answer`'s new refusals are 1.

Every claim in these paragraphs is `measured` against the code you just wrote — cite the file, not this plan.

- [ ] **Step 3: `docs/dashboard-model.md`**

Extend the `Run.budget` row (`:147`) with `authorizedUsd` (number \| null), `authorizedBy` (string \| null — the fact id) and `onGrantExceed` (`"warn"` \| `"block"`, never null; absence reads as `warn`), and `authorizedUsd` on `BudgetPhase`. State that **`DASHBOARD_MODEL_VERSION` stays 3** — additions never bump it (the doc's own rule at `:87`) — and that no existing field's meaning moved.

- [ ] **Step 4: `src/cli/helpText.ts` notes — verified against the BUILT binary, never from memory**

```
bun run build
echo "build: $?"
```
then read the real output of each:

```
node dist/tldrx.js answer --help
node dist/tldrx.js story --help
node dist/tldrx.js budget --help
node dist/tldrx.js cost --help
```

(**`dist/tldrx.js`, measured**: `package.json`'s `bin` maps to it and `scripts/build.ts:10` says `dist/tldrx.js <- bin/tldrx.ts`. There is no `dist/cli.js`. Re-check both before running, because quoting a command from memory is exactly what AGENTS §1 forbids — this line was wrong in an earlier draft for that reason.) Quote **the output**, not your recollection of it, when writing:

- `answer` — why `--decided-by` is optional here and required on `facts add` (the hook cannot honestly say either); what absence means; that the contradiction check RAISES and never refuses, and what it can and cannot see.
- `story` — which statuses may be widened, why `done` refuses and what answers it (`--for-fix`); that widen runs no agent, spends nothing, moves no cursor; that the boundary gate re-reads `touches:` off disk, so the next evaluation simply passes.
- `budget` — that `grant` records a CEILING the owner authorized (against `raise`, which is a delta); that `--fact` is required because a grant with no decision behind it is a number nobody said; **which refusal is 1 and which is 2**; that absent means nothing is reconciled.
- `cost` — `--stories` reports against the CEILING the spawn was given, off events only, and changes no ceiling.

- [ ] **Step 5: The guide pages and the docs-site twins**

`docs/guide/08-cli-reference.md` already names every new flag (each implementation task landed its own line — `test/docs-cli-coverage.test.ts:62` required it). Now write the prose around them in that page's voice.

`docs/guide/03-runs-and-gates.md`: the boundary gate's remedy is a verb now, and a carried finding nobody owns is named in the handoff and the PR.
`docs/guide/06-budgets-and-cost.md`: grants, `on_grant_exceed`, `cost --stories`, and that the preset numbers are labelled assumptions rather than measurements.

Then the five docs-site pairs, EN and ES in lockstep, ES a real translation and not a copy (sample CLI strings stay in English):

| EN | ES | What it gains |
|---|---|---|
| `docs-site/concepts/evidence.md` | `docs-site/es/concepts/evidence.md` | a decision names who decided it, or says it does not; a contradiction becomes a question rather than two live facts |
| `docs-site/concepts/gates.md` | `docs-site/es/concepts/gates.md` | `tldrx story widen` as the sanctioned way past a boundary refusal; a finding no story owns is reported, not blocking |
| `docs-site/concepts/budgets.md` | `docs-site/es/concepts/budgets.md` | a grant, and the difference between spending past a ceiling and writing one |
| `docs-site/guides/driving.md` | `docs-site/es/guides/driving.md` | a driver records its own decisions as the driver's |
| `docs-site/guides/budgets.md` | `docs-site/es/guides/budgets.md` | `budget grant`, `cost --stories`, and the labelled presets |
| `docs-site/reference/cli.md` | `docs-site/es/reference/cli.md` | the curated tour's rows for the new verb and flags |

- [ ] **Step 6: Gate**

```
bun test test/public-surface-consistency.test.ts test/docs-cli-coverage.test.ts
echo "surface+cli: $?"
```
```
bun run docs:build
echo "docs: $?"
```
```
git status --porcelain
echo "status lines: $(git status --porcelain | wc -l | tr -d ' ')"
```
Expected: `0`; `0` (`ignoreDeadLinks: false` is deliberate — a moved page or a throwing generator fails here rather than at deploy); and nothing beyond your own edits (`docs:build` leaves the tree clean).

```
bun test
echo "test: $?"
```
Expected: `0`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
docs: wave 4's governance surfaces, EN and ES (#169 #171 #170)

spec §2.5 gains `conflicts_with`, says that the answer path now writes
`decided_by` and fixes its own writer count from two to four (all four are under
the workspace lock, so only the count was wrong); §2.7 gains the raised-conflict
block and says `affects:` may name a repo; §2.8 says `## Unknowns` also carries
carried findings, and why they are not a fifth section; §2.9 gains three event
types and the standing fact that EVENT_TYPES is closed; §2.11 gains the four
grant keys with what absence means and why `on_grant_exceed` is not `on_exceed`;
§2.2 gains `triage.budget_basis`; §2.13 says `touches:` may be amended, by what,
and never on a done story; §3 gains the verb, the flags and the exit families.

`docs/dashboard-model.md` gains the projected grant fields;
DASHBOARD_MODEL_VERSION stays 3, because additions never bump it and no existing
field's meaning moved.

Every `helpText.ts` note was written against the BUILT `--help` output, not from
memory. docs-site EN and ES in lockstep across five pairs plus the curated CLI
reference; the generated cli-flags pages were not touched.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: CHANGELOG

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Check what the top section is, rather than assuming**

```
head -6 CHANGELOG.md
```
Expected at this base (measured): the first section is `## 0.10.0 — 2026-09-07`, DATED and therefore IMMUTABLE. **If a `## <version> — unreleased` heading already exists** — a sibling merged one while this branch was open — do NOT add a second: merge your bullets into its `### Fixed` / `### Added` / `### Changed` groups under the UNION rule. Every bullet from both sides survives; one section per version, one heading per kind. A duplicate `### Fixed` group has shipped here before and must not again.

- [ ] **Step 2: Write the section**

Insert directly under `# Changelog`, above `## 0.10.0`. **`0.11.0`**, a MINOR, because CLI surfaces and `version: 1` formats GROW: a new subcommand, a new verb, four new flags, `conflicts_with`, four `budget.yml` keys, `triage.budget_basis` and three event types.

Read three existing entries first — they explain the FAILURE, not the diff. Each bullet: the measured failure, then the fix, then the compatibility statement where a format grew.

```markdown
## 0.11.0 — unreleased

### Fixed

- **An answered decision now says who decided it, and what it binds to.** … (#169)
- **Two signed facts that disagree produce a question, without an agent choosing to notice.** … (#169)
- **A defect in a file no story declared has a sanctioned remedy and a visible home.** … (#171)

### Added

- **`tldrx story widen` — the verb the boundary card had been pointing at** while the CLI forbade the hand edit it described. … (#171)
- **`tldrx budget grant` — a ceiling that answers to a recorded authorization.** … (#170)
- **`tldrx cost --stories` — what a story cost against the ceiling its spawn was given.** … (#170)
- **A run close and the Build handoff say how many of a run's decisions name a decider.** … (#169)

### Changed

- **The shipped stage and workflow money literals are labelled `[assumption]`**, and deliberately NOT recalibrated: `tldrx init` copies no `stages/` into `.tldrx/`, so moving one moves the ceiling of every workspace that never wrote an override, and this repo holds no corpus to derive a new number from. `tldrx cost --stories` is the command that produces one. (#170)
```

- [ ] **Step 3: Verify and commit**

```
bun run docs:build
echo "docs: $?"
```
Expected: `0` — the site regenerates its changelog page from this file, so a malformed heading fails here.

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): 0.11.0 — unreleased, the wave 4 governance changes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 12: The full gate, on its own lines

**Files:** none.

- [ ] **Step 1: Run every gate, each exit code on its own line**

```bash
bun install
echo "install: $?"
```
(Expected `0`. Without it `bun run typecheck` exits **127** — `tsc: command not found` — and a 127 read as a gate result is the wrong instrument, not a red gate.)

```bash
bun run typecheck
echo "typecheck: $?"
```
```bash
bun test
echo "test: $?"
```
```bash
bun run build
echo "build: $?"
```
```bash
bun run docs:build
echo "docs: $?"
```
```bash
grep -rn 'Bun\.' src | grep -v src/core/runtime/
echo "seam hits: $(grep -rn 'Bun\.' src | grep -v src/core/runtime/ | wc -l | tr -d ' ')"
```

Expected: `0` for the first four; `0` seam hits. Never read one of these through a pipe or after another command — a pipe eats the exit code, and `cmd; git log; echo $?` reports `git log`'s.

- [ ] **Step 2: Prove the golden did not move — the wave's central claim**

```bash
git diff --stat 8b6890f -- test/fixtures/build/golden/
echo "golden diff lines: $(git diff --stat 8b6890f -- test/fixtures/build/golden/ | wc -l | tr -d ' ')"
```
Expected: **0 lines.** This wave claimed, per issue and per task, that no golden artifact moves. Any file listed here is an unexplained behaviour change: find it, and either explain it in a commit that names the artifact and the bytes, or revert it. `TLDRX_GOLDEN_UPDATE=1` is never the answer.

```bash
git status --porcelain
echo "status lines: $(git status --porcelain | wc -l | tr -d ' ')"
```
Expected: 0.

- [ ] **Step 3: Reconcile the test delta, and the spawner count, measured at both ends**

```bash
bun test 2>&1 | tail -5
```
Read the `N pass` line. Then measure the base, in a second worktree so nothing here moves:

```bash
git worktree add /tmp/wave4-base 8b6890f
```
```bash
cd /tmp/wave4-base && bun test 2>&1 | tail -5
```

The delta must equal the tests this plan adds **plus one `test.each` row per NEW spawning test file**. Measure the spawner count at both ends rather than predicting it:

```bash
ls test/*.test.ts | while read -r f; do if grep -qE 'node:child_process|Bun\.spawn|makeBuildWorkspace|makeSandbox' "$f"; then echo "$f"; fi; done | wc -l
```
Expected at the base: **75**. Two of this plan's five new test files spawn (`test/story-widen.test.ts`, `test/budget-grant.test.ts`); three do not (`test/answer-attribution.test.ts`, `test/answer-conflict.test.ts`, `test/unowned-findings.test.ts`). So the expected end count is **77**, and `test/machine-load.test.ts:125`'s floor of 40 is untouched — it is a vacuity guard, not a count. **If your files spawn differently from that, reconcile the number; do not hand-wave it, and do not edit the floor to make a number fit.**

State both ends, measured, in whatever close is written for these issues. **No test file beyond the five in the File Structure table is created by this plan** — every other assertion lands in a file that already exists (`test/build-executor.test.ts`, `test/ship.test.ts`, `test/economy.test.ts`, `test/state-corruption.test.ts`, `test/close-open-questions.test.ts`, `test/fixlist.test.ts`, `test/schemas.test.ts`) — so the 75 → 77 arithmetic above is complete. If you find yourself creating a sixth, add it to the File Structure table and re-derive this number before you run it.

- [ ] **Step 4: File the out-of-scope bug found while reading**

```bash
gh issue create --title "\`tldrx facts add --repo\` does not validate its value, so a fact can be scoped to a repo that does not exist" --body "$(cat <<'EOF'
**Measured** at `77dbf29`. `src/cli/commands/facts.ts:97` spreads `repeatedFlag(args, "repo")` straight into the new fact:

    repos: [...repeatedFlag(args, "repo")],

Nothing checks the value against `.tldrx/workspace.yml`. A fact recorded with `--repo ghots` is valid, saved, and then **invisible forever**: `renderFacts` filters on `fact.repos.length === 0 || fact.repos.some((r) => repos.includes(r))` (`src/core/facilitator/prompt.ts:412-414`), so a fact scoped to a repo no run has matches nothing and is silently absent from every prompt.

The command already makes exactly this argument for a different flag — `--run <id>` naming no run is exit 3 *"before anything is written"*, because *"asking for provenance by name and getting nothing instead is worse than not asking"* (`src/cli/helpText.ts`, the `facts` entry's notes).

`tldrx answer --repo` (#169, wave 4) validates against `loadWorkspace(root).repos` and refuses with exit 1 before writing. `facts add` should match its sibling.

Found while implementing #169; deliberately not fixed there — `facts add` is a command that change does not touch (AGENTS §1).
EOF
)"
```

- [ ] **Step 5: Stop**

No tag, no `npm publish`, no `scripts/release.sh` — the PreToolUse release gate will deny them anyway, and that is working as intended. The branch is ready for `scripts/merge-wave.sh feat/wave4-governance "<merge message>"` — **two arguments** — and that is somebody's decision, not this plan's.

---

## Self-Review

**Spec coverage.** §3.1 (#169) → Tasks 1, 2 and 3: the two flags and their refusals (T1), `repos` from explicit signals only with `reposFromAffects` as the leaf (T1), the deviation about the hook made mechanical (T1), the advisory check with its measured limit and its unmeasured false-positive rate (T2), `conflicts_with` with the round-trip pin C2 asked for (T2), `decidedTally` on the close and the handoff header (T3), and the explicit non-goal of a third `FACT_DECIDERS` value (nowhere — `FACT_DECIDERS` is not touched, and `test/facts-add.test.ts:363` — the test inside the `:362` describe — is named as staying green). §3.2 (#171) → Tasks 4, 5 and 6: the operator-only verb with its `done` refusal and its 2/3/1 exit table (T4), the two predicates and the repo-aware `ownershipOf` with four labels (T5), the three destinations with the card demoted to secondary and the measured reason (T6), and no fifth disposition, no stored `owner`, no eighth auto-gate condition anywhere. §3.3 (#170) → Tasks 7, 8 and 9: the required-and-nullable grant keys with mapper AND emitter AND the `grant` → `raise` pin (T7), `on_grant_exceed` separate from `on_exceed` (T7), the 1-vs-2 exit table stated as two conditions rather than one split (T7), `triage.budget_basis` (T8), the eighteen `[assumption]` labels with no literal moved (T8), `cost --stories` named for the ceiling it reads (T9), the N× clause on the cost line and not in an event (T9), and `caps.ts`/`remainingWork.ts` untouched with `test/remaining-work.test.ts` named as the tripwire in T7 and T9. §4.1 → Global Constraints' mapper/emitter table, and a round-trip pin in T2, T7 and T8. §4.2 → the absent-with-reason list in Global Constraints, and a test for every entry. §4.3 → the five leaves, each named with its consumers. §4.4 → red-first in every task, with the red-by-design set corrected from three to two and the correction argued. §4.5 → the cadence rule, and T12's measured spawner reconciliation. §5 → a golden statement per task and the whole-wave proof in T12 Step 2. §6 → the task order is the spec's (#169 → #171 → #170), and the `build/handoff.ts` collision is sequenced: T3 adds the header clause, T6 the `## Unknowns` block, T9 extends the note through `phaseCost.ts` rather than the handoff. §7's three PENDINGs are resolved to the defaults section 9 records, and no alternative is implemented.

**Re-review after the pre-flight revision, over the changed tasks only (1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12).** Spec coverage is unchanged by the revision — no requirement moved, and no task lost a step. Placeholder scan: the two hedges the scan found are gone (Task 4 no longer says "read `boundaryCard` before choosing"; Task 7 no longer states the reconciliation twice, once in code and once contradicting it in prose), and no new "TBD"/"or whichever file" phrasing was introduced — every `bun test` command now names a file that exists at the base, measured. Type consistency across the changed tasks: `DeclaredSurface.story` is now stated as a RENAME of `ShipStory.id` in all three places it is mentioned (T5's Interfaces, T5's leaf docstring, T6's `ship` prose), so no caller passes the array through unmapped; `phaseCostToDate(runDir, phaseId, stageId, invocationUsd, invocationTurns, stories)` is called with six arguments in T9's new test and declared with six in T9's Step 5; `grantFor`/`wouldExceedGrant` are both imported where T7 Step 5 now uses them; `StorySpend {ceilingUsd, measuredUsd}` is the shape T9's test passes and the shape its leaf reads. Red-first, re-checked task by task: every task now has at least one assertion that is red at the base for the reason the task exists — T9's was the one that did not (both its handoff assertions were already green) and it now asserts through `phaseCostToDate`'s `note`; T6's changed "none" sentence had nothing pinning it and now has a literal pin; T8's guard was already green for five of eighteen files and now asserts the marker text.

**Where the plan meets the code awkwardly, stated rather than smoothed over.** All six are also in `## Notes for the controller` with a proposed resolution: `renderQuestions` cannot mint an appended block; `test/close-open-questions.test.ts:125` cannot go red as claimed; the machine-load floor does not move; `FactsStore.supersede` is not a second writer; the `## Unknowns` citation spelling follows the file's existing convention rather than the spec's; and `overShareSentence`'s third argument had no stated shape.

**Type consistency.** `CarriedRow` is `{rel, row: UnownedRow}` in Tasks 5, 6 and nowhere else; `DeclaredSurface` is `{story, repo, touches}` and is exactly what `ship.ts:963` already builds; `Grant` is `{usd, factId, level}` in Task 7's leaf and its two consumers; `AnswerOverride` is `{decidedBy?, repos?}` in Tasks 1 and 2; `StorySpend` is `{ceilingUsd, measuredUsd}` in Task 9's two feeders; `DecidedTally` is `{owner, driver, notStated}` in Task 3's three readers. `carriedFindings` lives in `fixlist.ts` (beside its siblings) and `unownedFindings` in its own file — they are never confused for one another.

---

## Notes for the controller

Six places where the spec could not be turned into an unambiguous step, each with the measurement and my proposed resolution. All six are implemented as proposed in the tasks above; each is cheap to reverse.

1. **`renderQuestions` cannot mint the raised block (spec §3.1, "through the existing renderer `renderQuestions` (`distill/renderDistill.ts:143`)").** Measured: `renderQuestions(runId, phase, at, conflicts)` renders a WHOLE FILE — it opens `# Questions — <phase> — run <id>` (`renderDistill.ts:149`) and numbers ids `Q${i + 1}` from 1 (`:151`). Appending its output to an existing `questions.md` duplicates the H1 and mints a duplicate `Q1`, and `answer.ts`'s `locateQuestion` (`:120-126`) resolves an id by scanning every phase and taking the first hit — so a duplicate makes the wrong block answerable. **Proposed and implemented:** the new `raiseConflict.ts` leaf renders through `renderQuestionBlock` (`src/core/text/questions.ts:243`), whose own docstring is *"Canonical §2.7 rendering — used when authoring a block, not when rewriting one"*, and mints ids run-wide (`nextQuestionId`). No second block grammar is created; `renderQuestions` is untouched.

2. **`test/close-open-questions.test.ts:125` cannot go red as the spec claims.** Measured: that test asserts only `toContain` (`"Q1"`, the path, the title, `"no default"`, `"--yes-to-defaults"`), so a new sentence printed beside it changes nothing it reads. And `describeOpenQuestions` returns `null` when nothing is open (`closeRun.ts:199`), while the tally must print on a run that answered everything. **Proposed and implemented:** `describeDecidedTally` is a sibling export with its own tests, `:125` is named as a GUARD, and the wave's red-by-design set is **two**, not three: `test/decision-cards.test.ts:314` (Task 4) and `test/docs-cli-coverage.test.ts:62` (inside whichever task declares a flag before its guide line lands).

3. **`test/machine-load.test.ts`'s floor does not rise.** Measured: `:125` is `expect(spawners.length).toBeGreaterThanOrEqual(40)` and the repo has **75** spawning test files. It is a vacuity guard, not a count, so adding four (this plan adds two) leaves it green untouched. The spec's "the floor at `:125` rises by four" would have had the implementer editing an assertion that did not need editing. **Proposed and implemented:** the real obligation is stated instead — each new spawning file imports `machineLoad.ts` and calls `setDefaultTimeout(spawnTestTimeout())`, and each adds ONE `test.each` row to the suite total, which Task 12 reconciles by measuring both ends.

4. **`FactsStore.supersede` is not a second writer of `conflicts_with`.** Measured: `FactsStore.ts:135` is `const replacement = this.append({ ...input, supersedes: oldId });` — supersede delegates. The spec said "both, and neither is optional work". **Proposed and implemented:** one edit in `append`, and the round-trip test still exercises both paths so the delegation cannot silently change.

5. **The `## Unknowns` citation spelling.** Spec §3.2 says each new bullet ends `[src: tldrx-work/<run>/<fixlist rel>:1]`. Measured: the existing `## Unknowns` bullets cite the RUN-RELATIVE path (`build/handoff.ts:112`, `` `[src: ${o.reviewRel}:1]` ``), and `pathBases` resolves a `[src:]` file path against the workspace root first and the run dir second, so both resolve. **Proposed and implemented:** follow the file's existing convention, so one document does not carry two spellings of one citation. Reverse it by changing one template string in Task 6 Step 3.

6. **`overShareSentence`'s third argument had no stated shape.** Spec §3.3 gives `overShareSentence(ceilingUsd, measuredUsd, stories)` without saying what `stories` is. **Proposed and implemented:** `stories: number` — how many stories the two totals cover, used only for the sentence's plural, with the two amounts as SUMS over those stories and `null` returned when either sum cannot be formed (any missing side, or a non-positive ceiling). If the controller intended per-story rows instead, the leaf takes a row list and returns the worst ratio — one signature change in Task 9 Step 3 and its two feeders.

7. **Task 8's expected RED is 18, not the 13 the pre-flight scan named.** The scan measured 13 against the plan's ORIGINAL six-line-window predicate (5 of the 18 files already passed, because that window reached the `effort:` `[assumption]` comments) and ruled that the predicate be strengthened AND the count corrected to 13. Those two halves cannot both hold: with the strengthened predicate — the exact marker text `` `budget_usd` [assumption] `` inside the contiguous comment block immediately above the key — **all eighteen fail**, measured (`grep -rn 'budget_usd\` \[assumption\]' stages workflows` → 0 hits, and the line immediately above every one of the eighteen money keys is another key: `effort:` in the five stages, `depth:` in the thirteen workflows). **Proposed and implemented:** keep the strengthened predicate, since a guard already green for five of eighteen files is the thing the finding was about, and state BOTH numbers in the step so a reviewer seeing 13 knows they are running the old predicate. Reverse it by restoring the six-line window, at the cost of the guard.

Two further items the controller should acknowledge rather than decide:

- **The `answer-capture` hook deviation** (spec §2). The in-repo hook fires on `PostToolUse` with `tool_name` `Write`/`Edit` — an agent writing the file with its own tool — **and** on `FileChanged`, a human editing it (`src/hooks/answer-capture.ts:22-26`). It therefore passes **no** `--decided-by`, and the row it writes carries none. An external capture path that KNOWS a human answered (a Slack bridge calling the CLI on the owner's behalf) passes the flag on the command line, which the optional flag supports with no framework change.
- **The dashboard projects the grant** (three fields on `BudgetModel`, one on `BudgetPhaseModel`, `DASHBOARD_MODEL_VERSION` unchanged at 3). The spec left this as "only if the model surfaces a grant key". I chose to surface it: a recorded grant the run's own page cannot see is the same written-but-never-read-back failure this wave exists to remove. Dropping it removes ~6 lines in Task 7 Step 6 and the `docs/dashboard-model.md` row in Task 10 Step 3.
