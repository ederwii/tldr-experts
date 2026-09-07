# Wave 4 — governance: a decision record that reads back, a defect that has an owner, a ceiling that answers to a grant

Status: scoped 2026-09-07 (fourth of the hardening waves). Branch `feat/wave4-governance` off
`77dbf29` (`release: 0.10.0`). Release target: the next MINOR — every change here grows a
`version: 1` format or a CLI surface. Issues: **#169** (decision record), **#171** (unowned
defects), **#170** (budget reconciliation). Fact file:
`scratchpad/wave4-facts.md` (every file:line below re-read at `77dbf29`).

Three PENDING owner decisions are marked in place: `[PENDING owner: grant shape]` (section 3.3),
`[PENDING owner: who widens]` (section 3.2), `[PENDING owner: block vs report]` (section 3.2). Each carries the
default this spec is written for and a paragraph per alternative, so the plan can switch without a
rewrite.

---

## 1. Summary

The framework records decisions, defects and ceilings, and reads none of them back as a record.
`facts.yml` cannot say whether an owner or an agent decided, cannot say what a decision binds to,
and never compares a new answer against the ones already signed — so three contradictory Musts sat
live and only an agent's chat-channel discipline caught them (#169). A defect found at Build in a
file no story declared belongs to nobody, and the framework's own advice for it is a hand edit the
CLI forbids (#171). And a dollar ceiling is written in three places with no connection to the one
place an owner said what they would pay, so a forbidden ceiling gets seeded and enforced (#170).

This wave makes each of those three a mechanism rather than a habit, and refuses to make any of
them a guess:

- **#169** — `tldrx answer` learns an optional `--decided-by`, and a fact that does not carry one
  says so in its own row rather than letting silence read as the owner. `repos` is populated from
  what the question actually named, never from the run's repo list. The contradiction check that
  already exists (`conflictOf`) runs on the answer path as an **advisory**: it raises a §2.7
  question and links the two facts; it never refuses.
- **#171** — `tldrx story widen` becomes the sanctioned verb `decisionCards.ts:105` has been
  pointing at, a carried finding gets a second clearly-named predicate beside `isOpen`, and a
  finding no story's `touches` covers is named in the gate's card and the PR body instead of dying
  in a watcher card.
- **#170** — a grant becomes a recorded number with a fact id behind it, and writing a ceiling
  above it warns or (opt-in) refuses. The preset shares are **labelled**, not recalibrated, and a
  measured per-story report is added so a later recalibration has a corpus to come from.

Under the defaults specified here, nothing recalibrates money arithmetic, adds an auto-gate
condition, or moves a golden byte. Only one PENDING alternative — blocking the Build gate on an
unowned finding (section 3.2) — would change that, and it says so where it is offered.

## 2. Goals / Non-goals

### Goals

1. A decision's provenance is recorded or its absence is named — never inferred from context.
2. A decision names its surface when the question named one, and stays workspace-wide when it did
   not.
3. Two signed decisions that disagree produce a question, in the file, without an agent choosing to
   notice.
4. A defect in an undeclared file has a sanctioned, recorded remedy and a visible home.
5. A ceiling can be reconciled against an authorization, and the reconciliation says which fact
   authorized it.
6. Every unmeasured money literal in the shipped presets is labelled as the assumption it is, and
   the measurement that would replace it is obtainable from a command.

### Non-goals, each with the measured reason

| Not doing | Why |
|---|---|
| A third `FACT_DECIDERS` value (`agent-default`) | Ruling #169 Q2. Nothing can write it: `closeRun.ts:52-60` still carries the measured finding that spec §2.7 has no `default:` and no `timeout:` and that **nothing ages a question into an answer**. A schema promise about a mechanism that does not exist is the `superseded_by` failure (`Fact.ts:96-104`) — it sat unwritten while every reader served reversed decisions. |
| Recalibrating `stages/*/stage.yml` or `workflows/*.yml` literals | Ruling #170 Q4. `tldrx init` copies no `stages/` into `.tldrx/` (measured: `grep -rn 'stages' src/core/init/` → one doc-comment hit) and `workflowPreset.stagePath` (`:119-125`) prefers a local override else the shipped file — so editing a shipped literal moves the ceiling of **every workspace that never wrote an override**. There is no calibration corpus in this repo. |
| Any change to `src/core/build/caps.ts` or `src/core/budget/remainingWork.ts` | They are a deliberate, pinned mirror (`caps.ts:1-11`, `test/remaining-work.test.ts:139`), and their arithmetic is what freezes `$3.20` in `headless-developer-prompt.md:109` and `"max_budget_usd":3.2` in `headless-events.txt` `#03`. Touching them is how this wave would move golden bytes. |
| A fifth fix-list disposition (`unowned`) | Ruling #171 Q2. `parseFixFindings` refuses an unknown disposition **by design** (`test/fixlist.test.ts:575`), so a fix list written by 0.11 would be unreadable by 0.10 — and the property is derivable from the four that exist. |
| `FixFinding.owner` as a stored field | It is derived, not authored. Storing it changes the rendered artifact's bytes and the round-trip pin (`test/fixlist.test.ts:585`) for no information the reader did not already have. |
| Populating `repos` on the distill importer path (`distill.ts:119`) | No explicit signal exists there — an imported claim names no repo and carries no flag. Inventing one binds a repo nobody named. |
| A grant check on `tldrx run new --budget` / `tldrx seed apply` | Under the default grant shape a grant lives in a run's own `budget.yml`, and neither of those has a run yet. See section 3.3's PENDING note — under the "structured fact" alternative this comes back. |
| An eighth auto-gate condition | Under the defaults, neither #170 nor #171 adds one. `test/gates.test.ts:362` (`toHaveLength(7)`) stays green, and only ONE issue may ever renumber it in a single wave. |

### One deviation, stated up front, with its evidence

Ruling #169 Q1 says "the Slack answer-capture hook passes `owner` explicitly (it knows a human
answered)". **The in-repo `answer-capture` hook cannot honestly do that** `[measured]`:
`src/hooks/answer-capture.ts:22-24` fires on `PostToolUse` with `tool_name` `Write`/`Edit` — which
is *an agent writing the file with its own tool* — **and** on `FileChanged`, which is a human
editing it. Passing `owner` from that hook would attribute an agent's write to the owner, and
telling the two apart from `hook_event_name` is precisely the inference Q1 refused as option (c).

So: **the hook passes nothing**, and the row it writes carries the absent-with-reason marker (section 3.1)
naming the hook as the reason. An external capture path that knows a human answered — a Slack
bridge calling the CLI on the owner's behalf — passes `--decided-by owner` on the command line,
which the optional flag supports with no framework change. This deviation is worth the controller's
explicit acknowledgement; it does not block the design.

---

## 3. Design per issue

### 3.1 — #169: the decision record reads back

#### Data shapes (`.tldrx/memory/facts.yml`, spec §2.5, `version: 1`)

| Key | Status | Absent means | Writer sites that must learn it |
|---|---|---|---|
| `source.decided_by?: "owner" \| "driver"` | **already exists** — `Fact.ts:30-42`, validated `validateFactsFile.ts:94-98`, emitted `emitFactsYaml.ts:73-88`, rendered `prompt.ts:411-423`. The change is that the answer path starts WRITING it. | "not stated", never "owner" — the field's own docstring, `Fact.ts:36` | **none** — `FactsStore.append` spreads `source` wholesale (`FactsStore.ts:93`) and `emitFact` already emits `decided_by` when present (`emitFactsYaml.ts:76-79`) |
| `conflicts_with?: readonly string[]` | **NEW**, optional, top level on `Fact` beside `supersedes` | no contradiction was **detected** — never "checked and agreed" | **both, and neither is optional work.** `FactsStore.append` (`FactsStore.ts:83-101`) builds the row key-by-key, so a `conflicts_with` handed in on a `NewFact` is dropped **with no type error** (the object is constructed, so nothing flags the excess). `FactsStore.supersede` takes the same path. `emitFact` (`emitFactsYaml.ts:73-104`) enumerates every emitted key and needs a line of its own. |
| `repos` | **no schema change** — already required, already a string list | "no repo was named", never "every repo" | none — `append` copies `repos` already (`FactsStore.ts:88`) |

**Why `decided_by_basis` is NOT in that table.** An earlier draft added
`source.decided_by_basis: "stated" | "not-stated"` to carry the absence explicitly. It is dropped,
and dropping it is the honest choice: `decided_by`'s own docstring already fixes what absence means
(`Fact.ts:36`, *"Absent means 'not stated', never 'owner'."*), so `basis: "stated"` would be exactly
`decided_by !== undefined` — a second, unvalidated derivation of a fact the row already states, and
one a row could contradict (`decided_by: "owner"` beside `basis: "not-stated"` is an audit record
lying in the dangerous direction, AGENTS §7). A two-value enum also cannot carry the *reason* the
ruling asks for; only prose can. So: **absence IS the record**, its single meaning is documented in
spec §2.5 and on the docs-site evidence page, and the reason a particular row has none is said where
a person can act on it — `tldrx answer` prints, on stdout, that the fact was recorded with no
decider and that the invocation passed no `--decided-by`. Nothing in `renderFacts` changes for the
absent case, which is why `test/facts-add.test.ts:338`'s byte pin stays green by construction rather
than by argument.

**Typing shape, and which precedent it copies.** `conflicts_with` is `?: readonly string[]`,
optional and emitted only when non-empty — the `truncated?: boolean` precedent in the same file
(`Fact.ts:60-69`, emitted at `emitFactsYaml.ts:96` *"Written only when it is true. A
`truncated: false` on every row … is noise in a diff nobody asked for"*). It deliberately does NOT
copy `RunBudget`'s required-and-nullable shape: that one exists because `budget.yml` has a mapper
(`asRunBudget`) to collapse missing-vs-null into a default, and `facts.yml` has none —
`asFactsFile` is a bare cast (`validateFactsFile.ts:143-146`). One shape per file, each named.

Validation copies the `decided_by` precedent verbatim (`validateFactsFile.ts:92-99`): absence is
fine, only a wrong shape is an issue, so every existing row keeps validating. `requireKeys` checks
required keys only and ignores extras (`validation.ts:102-113`), so an additive key is tolerated by
default — which is exactly why it is validated **explicitly** when present rather than left to that
tolerance.

#### Commands

- `tldrx answer <Qid> <text> [--decided-by owner|driver] [--repo <name>]…` — both optional,
  `--repo` repeatable (matching `facts add --repo`, `facts.ts:97`). `--decided-by` outside
  `FACT_DECIDERS`, or `--repo` naming no workspace repo, is a usage refusal (**exit 1**) before
  anything is written.
- **Both flags must be added to `parseArgs(argv, ["run", "root"])` (`answer.ts:42`).** Mechanical
  and load-bearing: a value-taking flag absent from that list is set to `true` and its value falls
  into `positionals` (`argv.ts:48-54`), i.e. straight into the answer text via
  `words.join(" ")` (`answer.ts:47`). Without this line the flags silently corrupt the recorded
  answer.
- **The flags bind to the question named in that invocation, and to nothing else.** `answer.ts`
  calls `writeAnswerSlot(path, qid, text)` and then `captureAnswers(path, ctx)`, which sweeps
  **every** answered-but-uncaptured block in that `questions.md` (`captureAnswers.ts:84-88`, loop at
  `:97`) and appends a fact per block — including one a human filled in by hand before the command
  ran. Carrying the flags on `CaptureContext` would therefore stamp provenance onto questions the
  operator never named, which is the same lie the flags exist to prevent. So `CaptureContext` gains
  `overrides?: ReadonlyMap<string, {decidedBy?: FactDecider; repos?: readonly string[]}>` keyed by
  question id, and a block not in that map is recorded exactly as it is today. The `answer-capture`
  hook passes no overrides at all, which is the deviation in section 2 made mechanical.
- **A flag with no question to bind to is refused.** The `--supersede` path names one block, so it
  takes the overrides too; but if a future invocation ever carries a flag while naming no id, it
  exits **1** with the sentence *"--decided-by names no question: pass it with the `<Qid>` whose
  answer it describes"*. An unnamed question is never stamped, and the refusal says why.
- `tldrx facts add --decided-by` stays **required**. The two flags differ on purpose and the help
  must say so: `facts add` is a human minting a fact and can always answer the question;
  `tldrx answer` is also driven by a hook that cannot.
- `src/core/drive/mandate.ts` — the line that tells a driver how to record a decision
  (`mandate.ts:347-348`) already spells `--decided-by driver`; the parking block's
  "`tldrx answer <Qid> \"…\"` is mine to type" (`:295`) gains the driver spelling so that a driver
  that does answer on the owner's behalf records itself, not the owner.

#### Derivations, and every consumer

| Derivation | Leaf (one implementation) | Consumers |
|---|---|---|
| the provenance clause a reader sees | **no new leaf** — it stays inline in `renderFacts` (`prompt.ts:411-423`), which its own docstring already calls "the ONE place a prompt sees it". Measured: `grep -rn 'decided_by\|decidedBy' src/core/retro/` returns **no match**, so there is exactly one consumer today and a second file for one caller is not what AGENTS §7 asks for. Extract it when a second surface needs it. | `renderFacts` |
| "these two disagree" | `conflictOf` **stays where it is**, `distill.ts:160-164`. Measured: there is already exactly one definition and one call site (`:81`), so AGENTS §7 requires no move, and moving it would be scope no issue asked for. Its parameter narrows to a structural `{match, area, text}` — which `ImportedClaim` already satisfies, so `distill.ts` compiles unchanged — and the answer path imports it from there. Extract it only if the import proves to drag weight onto the CLI path, and say so with the measurement. | `distill.keep()` (`distill.ts:81`), `captureAnswers`, `supersedeAnswer` |
| the `affects:` metadata parse | `declaredAffects` — **exported** from its current private home (`stampSuperseded.ts:154`) so there is ONE parse of the key | `affectedDocs` (`stampSuperseded.ts:123`), `reposFromAffects` |
| `affects:` entries → workspace repo names | `src/core/answers/reposFromAffects.ts` (**NEW**) | `captureAnswers`, `supersedeAnswer` |
| the per-run decider tally and its sentence | `src/core/facts/decidedTally.ts` (**NEW**) | `closeRun`'s close report, the Build handoff header |
| Jaccard duplicate/conflict matching | `src/core/facts/findDuplicate.ts:42-60` (**unchanged**) | all four existing callers, plus `conflictOf` |

**`repos`, precisely.** Precedence: explicit `--repo` wins; else what the question's `affects:`
names; else `[]`, exactly as today. `reposFromAffects(affects, repoNames)` keeps an entry **only**
when it is exactly a declared workspace repo name, or when the substring before its first `:` is
one (the `repo:path` half of the `[src: …]` file production). Everything else — a bare document
path, an unqualified file path — contributes nothing, and the reason is the framework's own, at
`implicitPlan.ts:1349-1351`: *"A citation with no repo prefix is skipped rather than guessed at —
the run may have several repos, and a wrong guess would put another repo's file in front of an
agent told it may edit only this one."*

Three consequences to say out loud rather than discover:

1. `affects:` today names **run-relative `.md` documents** (`affectedDocs` filters to `.md` inside
   the run dir, `stampSuperseded.ts:111`) `[measured]`. So on existing question blocks the
   `affects:` branch will usually yield **nothing**, and `--repo` is the mechanism that actually
   fires on the F032 case. That is the honest cost of ruling Q3(b) and it is accepted: an empty
   `repos` is today's behaviour and it hides nothing.
2. The two consumers of `affects:` are **disjoint**, not a redefinition: `affectedDocs` reads the
   document subset, `reposFromAffects` reads the repo-name subset, and an existing `affects:` line
   full of document paths keeps meaning exactly what it meant. Spec §2.7's doc line grows to say the key
   may also name a repo, and that each reader takes only what it understands. An `affects:` entry
   shaped `repo:path` whose prefix names **no** workspace repo is dropped like any other unqualified
   entry — but it is not silent: `tldrx answer` names it on stdout as an entry it could not resolve,
   because `[]` recorded after a `lab:src/x.ts` that matched nothing would read as "no repo was
   named" when a repo *was* named and was wrong.
3. `--repo` naming no repo in `workspace.yml` is **refused** (exit 1) before anything is written.
   The argument is the repo's own, transplanted from `facts add --run` (`helpText.ts`, `facts`
   entry): *asking for provenance by name and getting nothing instead is worse than not asking* —
   and a fact scoped to a repo that does not exist is invisible to `renderFacts`'s filter forever.
   **`facts add --repo` does NOT validate today** (`facts.ts:97` spreads `repeatedFlag` straight
   in) `[measured]`; that is an out-of-scope bug found while reading, and it gets a GitHub issue
   with this evidence rather than a fix in this wave (AGENTS §1).

**Supersede.** `supersedeAnswer` keeps inheriting `[...head.repos]` (`captureAnswers.ts:253`) when
no `--repo` is passed; with `--repo` the new fact carries exactly what was named, because a
supersession is a new decision and may legitimately rescope.

#### The contradiction check (advisory)

On both answer paths, before the fact is appended, `conflictOf({match: block.title, area, text},
store.active)` runs at the existing `CONFLICT_THRESHOLD` = 0.6 (`distill.ts:17`) — **the same
constant, not a second number**, because a second threshold would be a second derivation of "these
two disagree".

**What this detects, and what it does not — measured, because the difference decides whether ask (3)
is served.** `conflictOf` calls `findDuplicate(claim.match, claim.area, facts, 0.6)`
(`distill.ts:161`), and `findDuplicate` (`findDuplicate.ts:42-60`) **skips every fact whose `area`
differs** (`:52`) and scores `jaccard(tokenize(<the new question's title>), tokenize(<the existing
fact's whole "title — answer" text>))`.

- **It catches**: a new answer, in the SAME `area`, whose question title overlaps an existing fact's
  text at ≥ 0.6 — i.e. *the same question answered a second time, differently, without
  `--supersede`*. That is a real failure mode with a real remedy, and nothing checks it today.
- **It does NOT catch issue #169's motivating case.** F030 (token revocation), F031 ("exactly ONE
  token") and F033 (cancel_account is reversible) are three **different** questions whose **answers**
  are mutually incompatible, and they need not share an `area`. Their titles will not reach Jaccard
  0.6 against each other's fact text, and no threshold moves that: lowering it manufactures false
  positives without acquiring the semantic link, and comparing across areas multiplies them against
  a corpus nobody has labelled. Scoring `match` against the fact's *answer* instead of the title
  would be a second derivation needing its own argument, and it would still be lexical.
- **Therefore ask (3) is PARTLY served, and this spec says so rather than implying otherwise.** The
  mechanism the issue asks to invoke genuinely runs on the answer path, and it closes the
  re-answered-question hole. The three-fact case needs a semantic comparison the framework has no
  measured way to make; it is filed as its own issue with the transcript as evidence, not promised
  here. The false-negative is stated beside the false-positive protocol below because AGENTS §1 asks
  for the negative case, and a check sold as catching #169's own transcript would be the exact
  over-claim this wave exists to remove.

On a hit:

- the answer **stands** and the command exits `EXIT_OK`. It raises; it never refuses. (Ruling Q4/Q5;
  the issue's own words: *"Raise, do not refuse"*.)
- a §2.7 question block is minted in the same phase's `questions.md`, through the existing renderer
  `renderQuestions` (`distill/renderDistill.ts:143`) — one implementation of the block — naming both
  facts and citing them.
- the new fact carries `conflicts_with: [<hit fact id>]`, and `renderFacts` appends
  `· conflicts with F031` when present, so a prompt handed both is told they disagree.
- one `fact.conflict_raised` event, payload `{fact, conflicts_with, score, q}`.
- `tldrx answer` prints the raised question id and says the answer stands.

**The false-positive rate is not measured, and this spec does not pretend otherwise.** No labelled
corpus exists in this repo (demo fixtures are synthetic by `assertSynthetic`, AGENTS §8). The protocol for
measuring one later, written down now so it is not reinvented: replay every `question.answered`
event in a real workspace's `events.jsonl` through the check against the `facts.yml` state at that
moment, and have a human label each raise. **Precision** — raises a human agrees are real
contradictions, over all raises — is the number; recall counted without labels is not a result.
Until that number exists, the check may not gate anything.

#### Ask (4): say what the record cannot say

`decidedTally(facts, runId)` → `{owner, driver, notStated}` over facts whose `source.run` is this
run, where `notStated` is simply `source.decided_by === undefined` — the absence IS the count, which
is the whole reason no basis field is needed. ONE sentence is derived from it, printed by exactly
two surfaces:

- `closeRun`'s close report, beside the #141 silence sentence (`closeRun.ts:62-75`);
- the Build handoff **header line** (`build/handoff.ts:92-95`), beside `Cost:` — deliberately the
  header and not a `## Decisions` bullet, because every list item in a §2.8 section must carry a
  `[src: …]` token or `claim-sources` refuses the document (`stampSuperseded.ts:84-90` makes the
  same argument for the same reason).

It is a **report**: it changes no exit code, blocks no close and writes not one byte of state —
`closeRun.ts:72-75`'s standing precedent. It never claims a timeout-default mechanism exists; it
says how many of this run's recorded decisions name a decider and how many do not, and it stays
out of every prompt, which is what keeps the golden still (section 5).

#### Refusals and exit codes (#169)

| Condition | Code |
|---|---|
| `--decided-by` outside `FACT_DECIDERS`; `--repo` naming no workspace repo | **1** `EXIT_USAGE` — "you asked for something impossible" |
| a provenance flag carried by an invocation that names no question id | **1** `EXIT_USAGE` — an unnamed question is never stamped |
| a contradiction is detected | **0** — advisory, by ruling Q5 |
| the question is not open / not found (unchanged) | 3 `EXIT_NOT_FOUND` |

`tldrx answer`'s existing families are 0 / 1 / 3 (`answer.ts`, `exits: [EXIT_OK, EXIT_USAGE,
EXIT_NOT_FOUND]` in `helpText.ts`) and this wave adds no fourth: every new condition is a usage
refusal, and the advisory raises without changing the code.

#### Tests (#169) — red-first, verbatim RED kept, mutated both ways

Existing pins and what happens to each:

- `test/facts-add.test.ts:338` "a fact with no `decided_by` renders byte-identically to before the
  field existed" — **stays green by construction**, not by argument: nothing in `renderFacts` changes
  for a fact that carries no decider (the basis field is dropped, I2). A **new** assertion covers a
  row carrying `conflicts_with`, whose clause is the only renderer change.
- **A new round-trip pin, and it is the one C2 exists for**: a `NewFact` carrying `conflicts_with`
  goes through `FactsStore.append` → `emitFactsYaml` → `parse` → `validateFactsFile` and comes back
  with the field intact. Without it, `append`'s key-by-key construction drops the field with **no
  type error** and every other test in this issue still passes.
- `test/facts-add.test.ts:362` "a value outside owner/driver is rejected" — **stays green**, and is
  named here so nobody flips it: `FACT_DECIDERS` does not grow (ruling Q2).
- `test/facts-add.test.ts:160` "attribution is recorded, and a driver default is never cited as the
  owner's" — the pin the answer path must now satisfy too; a sibling test is added for it.
- `test/run.test.ts:536` (`tldrx answer`) and the `--supersede` describe at `:627` with its test at
  `:666` — `toMatchObject` on `{kind, confidence, area}`, additive-safe; they go red only if
  answering starts refusing, which it must not. (An earlier draft cited `:634`, which is fixture
  prose — corrected.)
- `test/distill.test.ts:147` / `:286` — **stay green**; `conflictOf` neither moves nor changes
  behaviour (M9), it only gains a second caller.
- `test/text.test.ts:579` (`findDuplicate`, Jaccard ≥ 0.6) — untouched.
- `test/hooks.test.ts:418` — the `repos: ["api","lab"]` fixture; a sibling proves an answered fact
  scoped to `api` reaches a run with `api` and is **absent** from one without.
- `test/close-open-questions.test.ts:125` — **red by design**: the close sentence gains the tally
  clause.

New files: `test/answer-attribution.test.ts` (both flags; the refusals; **the sweep case — a second
answered block in the same file is recorded with NO decider and NO repos while the named one carries
both**; repos precedence; both directions of the repo filter) and `test/answer-conflict.test.ts`
(raise + link + event + `EXIT_OK`; the negative case, that an identical answer is agreement and
raises nothing — `conflictOf`'s own rule at `distill.ts:157`; and **a test that pins the false
negative honestly**: three differently-titled answers in two areas raise nothing, so the limit is a
recorded property rather than a surprise). Both spawn; both `setDefaultTimeout(spawnTestTimeout())` and both add a row to
`test/machine-load.test.ts`'s `spawners` list, whose floor at `:125` rises accordingly.

#### Docs (#169), EN and ES in lockstep

`docs/spec.md` §2.5 (line 509) — `conflicts_with`, that the answer path now writes `decided_by`, and
what the ABSENCE of `decided_by` means (the record the dropped basis field would have duplicated);
**and the writer-count fix**: §2.5's opening says "Two writers"; there are four (`captureAnswers`,
`supersedeAnswer`, `facts add`, the distill importer at `newRun.ts:373`) — all under the workspace
lock, so the safety claim holds and only the count is wrong `[measured]`. That drift is fixed
in-wave while `facts add --repo`'s missing validation is filed as an issue, and the difference is
deliberate: the "Two writers" line sits inside the very §2.5 paragraph this change rewrites, so
leaving it wrong would ship a known-false sentence in edited text, whereas `facts add` is a command
this wave does not touch.
§2.7 (806) — the raised-conflict block, and that `affects:` may name a repo.
§2.9 (1079) — `fact.conflict_raised`. §3 (1690) — the new `answer` flags.
`docs/guide/08-cli-reference.md` — the only docs file `docs-cli-coverage` actually reads
(`:59-72`, `guideSection` over that file); every declared flag must be named in its own command's
section. `docs-site/concepts/evidence.md` **+ `docs-site/es/concepts/evidence.md`** — the natural
home for "a decision names who decided it, or says it does not".
`src/cli/helpText.ts` — the `answer` entry (`:579`) gains both flags, the note about why
`facts add --decided-by` stays required, and no new exit code. Two distinct docs-site surfaces, and
the spec means both: the **curated, committed** `docs-site/reference/cli.md` + its `es/` twin are
hand-written and part of this change; the **generated** `cli-flags` pages come from `helpText.ts`
via `docs-site/scripts/gen-cli.ts` and are **never hand-edited**.

#### Size (#169)

~12–16 files, ~14–18 new tests, +2 new spawning test files.

---

### 3.2 — #171: a defect in an undeclared file gets an owner

#### `tldrx story widen` — the verb the card already points at  `[PENDING owner: who widens]`

**Default (specified here): an OPERATOR verb only.** `tldrx story reopen` describes itself as an
operator verb (`story.ts:1`) and this joins that family.

Data shape — **no format change at all.** `touches` is already required, non-empty and capped at
`MAX_TOUCHES = 128` (`schemas/story.ts:35,66-69`, `planCommon.ts:39`); appending to it changes a
value. `STORY_KEYS` is untouched, so `test/plan-schema-contract.test.ts:101` and `:210` ("the story
example's keys ARE `STORY_KEYS`, in order") stay green.

- `StoryPatch` gains a third key, `touches?: readonly string[]` — replaces the whole list, exactly
  as `evidence` does (`storyFile.ts:17-21`). `applyPlanPatch` gains `replaceTouches` beside
  `replaceStatus`/`replaceEvidence` (`:48-53`), so the story file and
  `04-build/implicit-plan.yml` cannot disagree about what a widened list looks like — the
  one-writer argument at `storyFile.ts:39-46`.
- `src/core/run/widenStory.ts` (**NEW**) mirrors `reopenStory.ts`: it takes DATA
  (`{root, storyId, paths, note, runId, actor, at}`), returns `{code, lines}`, runs no agent,
  spends nothing and moves no cursor.
- `src/cli/commands/story.ts` — `subcommands` becomes `reopen` and `widen`; the usage string and
  `helpText`'s `subcommands: ["reopen"]` both change (public surfaces, AGENTS §9).
- **`src/core/run/decisionCards.ts:105`** — the advice line stops naming a forbidden hand edit and
  names the verb: `tldrx story widen <id> <path> --note "<why>"`. This is a user-visible string and
  ships in the same commit as the verb.

**Which statuses may be widened, and why.** `todo`, `in_progress`, `review` and `blocked` may. A
`done` story **refuses**, and the refusal names `tldrx story reopen <id> --for-fix` (#58) as the
way: a done story has evidence written against the surface it declared, and widening it afterwards
would make the record say the plan declared something it did not. That is the audit-record rule in
AGENTS §7, not a convenience.

**The gate needs no change.** `deriveSurface` reads story `touches:` off disk at evaluation time
(`boundary.ts:262-268` via `storyTouches`) `[measured]`, so a widened story makes auto-gate
condition 7 pass on the next evaluation with zero boundary code touched.
`test/boundary.test.ts:88` ("the union of the What's citations and the plan's `touches:`") stays
green; a new test proves a widen turns `test/boundary.test.ts:266`'s named refusal into a pass.

**Honesty guard.** The widening is an event, so the surface never grows silently:
`story.touches_widened`, payload `{story, paths, note, before, after}`.

> **Correction to the fact file, measured.** The fact file §3.5 records `[inferred]` that a new event type is
> "additive by construction, readers ignore unknown types". **It is not.** `EVENT_TYPES` is a closed
> enum (`src/core/events/Event.ts:106-124`) and `validateEvent` runs `requireEnum(doc.type,
> EVENT_TYPES, …)` at `:157` `[measured]`. A new type must be ADDED to that list. That is additive
> in the direction the AGENTS §7 invariant is about — new code reads every old record unchanged — and it is
> the same move every existing type made; it is **not** backward-readable by an older `tldrx`, which
> was never promised for events. Before either new event lands, `renderReplay` and
> `readReviewLedger` are checked against it and a test pins that both survive it.

`[PENDING owner: who widens]` — **alternatives, one paragraph each.**
*(a) An agent may widen, with a recorded event.* The Build executor calls the same leaf with the
agent as `actor`. Cost: the plan's surface becomes self-modifying mid-run, so auto-gate condition 7
can no longer refuse a path the agent itself added — which makes the boundary card the ONLY thing
left that tells a human, and the card must then name every widening recorded for the run,
unconditionally. That is the middle path the fact file calls "probably the right answer", and it is
also squarely the family AGENTS §7 warns about ("the agent widened its own surface and then signed the
boundary gate"), which is why it needs the owner rather than this spec.
*(b) A fix-round story created at Build time.* Materially bigger: a story no wave declared, so
`waves.yml`, `buildProgress` and auto-gate condition 6 ("every story reached done") all have to
learn about it, and `MAX_STORIES_PER_WAVE` applies. The repo's closest precedent, #58 `--for-fix`,
chose to REUSE the story machinery rather than build a container — which is the argument for the
default.

#### Carried and unowned findings  `[PENDING owner: block vs report]`

**Two predicates, deliberately, because they answer two questions.** `fixlist.ts:22-24` already
states the principle ("A disposition ROUTES a finding; `Resolved:` CLOSES it … one field cannot
answer both"), and the file already carries a second predicate beside `isOpen` for exactly this
reason (`unevidencedClaims`, `fixlist.ts:122-124`) `[measured]`.

- `isOpen` — **unchanged.** `disposition === "fix-now" && !(resolved && resolvedSha !== null)`
  (`fixlist.ts:107-109`). It also gates a story reaching `done` (`test/fixlist.test.ts:389`), which
  is why ruling Q4 refused to widen it.
- `carriedFindings(findings)` (**NEW**, in `fixlist.ts` beside its siblings) —
  `disposition === "defer-with-log" && !(resolved && resolvedSha !== null)`. "Carried forward",
  not "still owed".
- **`ownershipOf` — the ONE leaf, and it is repo-aware.** `src/core/build/unownedFindings.ts`
  (**NEW**) exports `ownershipOf(finding, declared, repoNames)` → one of four labels, and
  `unownedFindings(carried, declared, repoNames)` filtering on it. It takes DATA — the carried rows,
  `readonly {story, repo, touches}[]`, and the workspace repo-name set — never `ctx` and never the
  session (AGENTS §12). It reuses the two derivations that exist and copies neither: `parseSrcToken`
  (`src/core/text/srcToken.ts`, the ONE `[src:]` grammar, AGENTS §7) to get the ref out of `where:`,
  and `inSurface` (`boundary.ts:152`, the ONE path-coverage predicate) to test one path against one
  story's list. Its own leaf, so `fixlist.ts` never imports `boundary.ts`.
- **Ownership is repo-then-path, because `inSurface` has no repo in it.** `inSurface(changed,
  surface)` compares normalised path **strings** (`boundary.ts:152-160`); `deriveSurface` never uses
  it repo-blind — it keys the surface by repo (`add(story.repo, path, …)`, `:262-268`) and keeps
  unqualified citations in their own bucket (`:255-257`). A `[src:]` file ref carries
  `repo: string | null` (`srcToken.ts:28`) and `parseSrcToken(line, repos)` needs the repo-name set
  to resolve a `repo:` prefix at all. So a finding is **owned** only by a story whose `repo` equals
  the ref's repo AND whose `touches` covers the path. `ship.ts:596` already states this house rule
  for the same data — *"it answers for ONE repo. `touches:` is a repo-relative path list"*. Without
  the repo half, a finding at `api:src/db.ts` would read as owned by a `lab` story declaring
  `src/db.ts`, and a false "owned" is the dangerous direction.
- **Four labels, three of them absent-with-reason.** `owned` · `unowned` (a repo-qualified path no
  same-repo story's `touches` covers — the reportable case) · `unqualified` (the ref names no repo:
  *skipped rather than guessed at*, `implicitPlan.ts:1349-1351`, so it is neither owned nor unowned)
  · `no-src` (`where:` carries no `[src: …]` token at all, so nothing can be checked against it).
  `unqualified` and `no-src` are reported **with their reason** and are never counted as owned.
- **No new disposition and no new stored field**, so `04-build/fixlist/*.md` is byte-unchanged and
  `test/fixlist.test.ts:539/:575/:585` stay green.

**One leaf, every surface — including `ship`.** The rows are computed by `ownershipOf` and handed
on; no surface re-derives them. `ship` is the case that needs saying, because it runs in its own
process: it already reads each story's `id`, `status`, `repo` and `touches` into `ShipStory`
(`ship.ts:890-896`, populated at `:963`) for the `.tldrx` state refusal, so it has exactly the
`declared` argument the leaf wants and calls the leaf — it does **not** compute its own
carried-findings set. Nothing re-scrapes a string another parser built, which is
`decisionCards.ts:88-95`'s rule: *"a second parser over a string the first one built is how two
readings of one fact start."*

**Default (specified here): report only — and the report must land where a PASSING gate shows it.**

This is the part an earlier draft got wrong, so it is stated with its measurement. A decision card
is **not** available on the path this issue is about: all three `renderDecisionCard` call sites are
conditioned on the gate falling to a person — `runNext.ts:1660-1677` inside the *"this gate falls to
a person"* branch returning `EXIT_AWAITING_HUMAN`, `runAuto.ts:200` (`if (options.gateAgent !== true
|| outcome.code !== EXIT_AWAITING_HUMAN) return indented;`), and `runItems.ts:130` (`questionsCard`
only) — and `cardForTriggers` returns `null` when `triggers.length === 0` and otherwise exactly ONE
card by priority (`decisionCards.ts:142-164`). Under the default there is no eighth auto-gate
condition, so an unowned finding raises no trigger: **on a clean auto gate no card is printed at
all**. Issue #171's own measurement is *"The run signed all five gates with a known defect on
board"* — the gates passed. So:

1. **The Build handoff, in `## Unknowns`** — the primary surface, and the one the reviewer, the gate
   and `ship` all already read. `renderBuildHandoff` takes the rows on `BuildHandoffParts` and emits
   one bullet per carried finding that is `unowned`, plus one per `unqualified`/`no-src` row with
   its reason, each ending in `[src: tldrx-work/<run>/<fixlist rel>:1]`. **Not a fifth H2 section**,
   deliberately: `missingSections` requires the four in order but tolerates extras
   (`text/handoff.ts:213-225`), while `validateSections` only checks bullets *inside the required
   four* (`:441`, `BULLET_RULE` at `:262`) — so a fifth section's claims would be the one part of the
   document nothing validates, which is precisely the hole §2.8 exists to close (`handoff.ts:10-15`).
   `## Unknowns` is also where it belongs by meaning: it already holds "this needs a human". The
   `MAX_BULLETS` cap applies; beyond it the rows are summarised with a count and the fix-list
   citation.

   **Shipped differently, and deliberately (measured, 2026-09-07):** the citation is
   `[src: <fixlist rel>:1]`, RUN-RELATIVE, not `[src: tldrx-work/<run>/<fixlist rel>:1]`. The
   `## Unknowns` bullets already on that page cite the run-relative path (`build/handoff.ts`,
   `` `[src: ${o.reviewRel}:1]` ``) and `pathBases` resolves a bare `file` path against the
   workspace root first and the run directory second, so both spellings resolve — but one document
   carrying two spellings of one citation is worse than one disagreeing with this sentence. The
   reason is recorded beside the code, in `carriedBullets`' own docstring.
2. **The PR body** — `shipBody` gains `carriedFindings: readonly OpenFindingRow[]` and a
   `## Carried findings` section. The rows come from the shared leaf, called by `ship.ts` with the
   `ShipStory` surface it already has (`ship.ts:890-896`, `:963`), not from a second predicate
   applied in `ship`. `shipBody` still parses no fix list and still decides nothing — its own rule at
   `shipBody.ts:22-31`.
3. **The decision card — only when a card already fires.** When some other trigger sends the gate to
   a person, `boundaryCard`'s detail gains the unowned rows so the person deciding sees them. It is
   an addition to a card that was going to print, never the reason one prints, and it is explicitly
   **not** the operator's first sight of the finding.
4. **`retro.md`** — unchanged. `fixlistRetroLines` already writes one bullet per `defer-with-log`
   (`fixlist.ts:737-751`); this adds destinations, it does not add a second writer.

`[PENDING owner: block vs report]` — **alternatives, one paragraph each.** Read the default with its
real limit in view: under "report only" the finding is *shown* — in the handoff and in the PR body —
but nothing *stops*, and on a gate that passes cleanly there is no decision card, so an operator who
reads neither document sees nothing. That is the honest statement of what the owner is choosing
between.
*(a) Block `tldrx ship`.* An unowned finding becomes a state refusal in `ship`, exit **2**
(`EXIT_GATE_REFUSED`), matching the #167 refusal that shipped in 0.10.0 — which means it needs the
same thing #167 needed: a sanctioned move that answers it (here, `tldrx story widen` plus a fix, or
an explicit operator override), or an unattended run parks at the PR with no way through. Design
cost: one refusal path in `ship.ts`, one test file, and the refusal's message must name the move.
*(b) Block the Build auto-gate.* An eighth condition in `evaluateAutoGate` (`autoGate.ts:73-82`);
`test/gates.test.ts:362` renumbers from 7 to 8 **by design**, with the verbatim RED kept. Design
cost: every `auto` gate in every workspace can now stop on a defect the run itself cannot fix, so an
unattended run parks — which is what would actually have stopped the live defect shipping, and is
why this is the sharpest fork in the wave. If it is chosen, **only #171 may touch the condition
count in this wave**, and #170 must not.

#### Refusals and exit codes (#171)

| Condition | Code |
|---|---|
| **every one of the verb's own refusals** — unknown story; a `done` story; missing `--note`; a path already declared; a path outside the story's repo; `MAX_TOUCHES` exceeded; an ambiguous run | **2** `EXIT_REFUSED` |
| unknown run | **3** `EXIT_NOT_FOUND` |
| a subcommand that is neither `reopen` nor `widen` | **1** `EXIT_USAGE` — the dispatch error in `story.ts:38`, the only 1 this command has |

An earlier draft put the verb's refusals in family 1 and justified it as "widening a surface is not
a gate decision". **That was wrong, and the lines it cited refute it.** `reopenStory.ts:82-83`
declares `const EXIT_REFUSED = 2` under the docstring *"Spec §3: `refused`. Every one of this verb's
own refusals is a refusal to act."*, and `refuse()` (`:362-364`) returns that 2 for the empty id
(`:101`), the missing note (`:106-108`), the unknown story, the `done` story, the `todo` story and
the ambiguous run (`:121`). It is pinned twice: `test/story-reopen.test.ts:371` is titled *"an
unknown run id is not found (3), not refused (2)"*, and `:395-400` asserts `expect(code).toBe(2)` for
a `done`-story refusal through `storyCommand.run`. The only **1** in the command is the
subcommand-dispatch error, pinned at `:409-414`. `helpText.ts:753` already declares
`EXIT_GATE_REFUSED` for `story` **because reopen's refusals are 2**, not because of run ambiguity.
Splitting `widen` into family 1 beside `reopen`'s 2 would be exactly the thing AGENTS §7 forbids —
one class of refusal in two families inside one command. `widen` matches its sibling: **2**.

#### Tests (#171)

- `test/decision-cards.test.ts:314` — **red by design**: it pins the exact advice string, and the
  boundary card's advice line now names the verb.
- `test/docs-cli-coverage.test.ts` — **only `:62` can go red for a docs reason.** Measured: the guide
  loop (`:59-72`) is the one place that reads a file, `guideSection(command.name)` over
  `docs/guide/08-cli-reference.md`. The site tests at `:78`/`:83` sit inside
  `describe("the generated site reference…")`, which builds `renderCliReference(locale)` **in memory
  from `HELP_ENTRIES`** (`:74-76`) — they go green the moment `helpText.ts` declares the flag with a
  meaning, and `:78` matches on command *names* (`## \`tldrx ${name}\``), so a new *subcommand* of
  `story` never moves it at all. An earlier draft called all three "guaranteed red"; that was wrong.
  What actually pins the hand-written docs is `:62` plus `docs:build` (`ignoreDeadLinks: false`) and
  human review of the EN/ES pair.
- `test/story-reopen.test.ts:409` "a subcommand that is not `reopen` is a usage error" — stays green
  (`unblock` is still unknown, and the test asserts only the exit code), but `story.ts:32`'s usage
  string is a public surface and changes. (`:378` is the enclosing `describe`, not the test —
  corrected.)
- `test/story-reopen.test.ts:520` (the `--for-fix` arc: 7 direct tests plus a nested describe of 4)
  — the precedent the new tests are modelled on, untouched.
- `test/fixlist.test.ts:259` "`defer-with-log` reaches the owner through retro.md, `fix-now` does
  not" — **stays green**: retro is unchanged and the PR body is an additional destination.
- `test/fixlist.test.ts:388` (an approve is blocked over an open `fix-now`) — stays green: `isOpen`
  is untouched.
- `test/ship.test.ts:333` "open fix-list findings are listed, and come from fixlist.ts" — stays
  green; `:404` (the absent-case pin) gains a sibling for "no carried findings leaves the section
  out rather than asserting an empty one".
- `test/boundary.test.ts:88` stays green; `:266` gains the widen-then-pass proof.
- `test/plan-schema-contract.test.ts:101/:210` stay green — no story key added.
- `test/gates.test.ts:362` stays at **7** under the default.

New: `test/story-widen.test.ts` (spawning; red-first both directions — a widen makes the boundary
pass, and a widen that is not recorded still refuses; plus the refusal family, asserting **2** for a
`done` story and **1** only for an unknown subcommand) and `test/unowned-findings.test.ts` (a pure
leaf test over all four labels, and **the repo case explicitly**: a finding at `api:src/db.ts` is
NOT owned by a `lab` story declaring `src/db.ts`). +1 `machine-load` row for the spawning one.

#### Docs (#171), EN and ES in lockstep

`docs/spec.md` §2.13 (1387) — `touches:` may be amended, by what, and never on a `done` story;
§2.9 (1079) — `story.touches_widened`; §3 (1690) — the new subcommand.
`docs/guide/03-runs-and-gates.md`, `docs/guide/08-cli-reference.md`.
`docs-site/concepts/gates.md` **+ `es/`**, `docs-site/guides/driving.md` **+ `es/`**.
`src/cli/helpText.ts` — the `story` entry (`:731`): `subcommands: ["reopen","widen"]`, flags
scoped with `sub: "widen"`, no new exit code (the entry already declares `EXIT_GATE_REFUSED`, and
widen's refusals are that same 2). **`docs/spec.md` §2.8 (line 906)** — the handoff's `## Unknowns`
now also carries carried/unowned findings, each `[src: …]`-cited like every other bullet in the four
sections; the section list itself does not change. `docs/dashboard-model.md` only if the model
surfaces a widening or an unowned finding; `DASHBOARD_MODEL_VERSION` stays **3** (additions never
bump it — the doc's own rule at line 87).

#### Size (#171)

~12–16 files (C3 added `src/core/build/handoff.ts` and its parts interface to the list), ~15–21 new
tests, +1 new spawning test file (+1 non-spawning leaf test).

---

### 3.3 — #170: a ceiling that answers to a grant  `[PENDING owner: grant shape]`

**Default (specified here): a `budget.yml` row written by its own verb — one money ledger.**

#### Data shapes (`budget.yml`, spec §2.11, `version: 1`)

`ceiling_host_tokens` (`RunBudget.ts:91-108`) is the repo's best worked example of an additive money
field, and it is copied END TO END — docstring, typing, mapper, emitter — not just its prose.

**The shape is required-and-nullable, not optional** — that is what `ceiling_host_tokens` actually
is, and an earlier draft copied its docstring while getting its typing wrong. `RunBudget`'s
`ceiling_host_tokens: number | null` (`:108`) and `on_host_tokens_exceed: OnHostTokensExceed` (`:90`)
are **required in the interface**; tolerance lives in the validator (checked only when present and
non-null), the default lives in the mapper `asRunBudget` (`:244-245`), and the emitter writes the
line only when it is not the default. `?: T | null` would create three states — missing, null, value
— with no stated difference between the first two and no mapper to collapse them.

| Key | Type | Absent (in the file) means | Mapper + emitter that must learn it |
|---|---|---|---|
| `authorized_usd` | `number \| null` | **no grant recorded; nothing is reconciled.** The LAX side, deliberately — absent must never read as `$0`, which would brick every run on disk. That is the `RunBudget.ts:103-107` argument, one domain over. | `asRunBudget` (`RunBudget.ts:234-254`) defaults it to `null`; `emitBudgetYaml` (`emitRunYaml.ts:217-261`) writes the line only when non-null |
| `authorized_by` | `string \| null` — the fact id (`F031`) | no decision is cited, so nothing is a grant. A grant that cannot name a decision is not recorded at all. | same pair |
| `authorized_at` | `string \| null` RFC3339 | unknown | same pair |
| `on_grant_exceed` | `OnGrantExceed` (`ON_GRANT_EXCEED = ["warn","block"]`), default **`warn`** | what this file did before the key existed: say so, never stop | `asRunBudget` defaults it to `DEFAULT_ON_GRANT_EXCEED`; `emitBudgetYaml` writes it only when it is not the default |
| `BudgetPhase.authorized_usd` | `number \| null` | this phase declares no grant of its own; the run's grant governs | `asRunBudget`'s phase map (`:246-252`); the phase's inline mapping in `emitBudgetYaml` |

**This is C2's sharpest case and it is not optional work.** `emitBudgetYaml` enumerates keys and
carries three comments saying exactly why: *"`budget raise` rewrites this file through this emitter,
so a label that did not round-trip would be ERASED by the one command an operator reaches for when a
ceiling binds"* (`emitRunYaml.ts:227-232`, and again at `:233-240` and `:241-247`). `budget raise` is
the command being made grant-aware. **Unless the mapper and the emitter both learn these keys, the
first `budget raise` after a grant erases the grant it just reconciled against** — and every unit
test of the reconciliation would still pass. A round-trip test (`grant` → `raise` → re-read, the
grant intact) is the pin, and it is required, not optional.

**`on_grant_exceed` is never `on_exceed`** (ruling Q2). `on_exceed` governs **spending past a
ceiling**; `on_grant_exceed` governs **writing a ceiling above what the owner authorized**. The
argument is `ON_HOST_TOKENS_EXCEED`'s, at `RunBudget.ts:19-22`: a run that blocks on dollars has
said nothing about whether a different lever should stop the framework, and inferring one from the
other enforces a ceiling nobody asked for.

Also, in `run.yml` (spec §2.2) — ask (2)'s honest half, which needs no grant at all:
`triage.budget_basis?: "model-guess" | "owner-grant" | "preset"`. Same C2 discipline:
`emitRunYaml.ts:167-169` emits `triage:` as a fixed inline mapping of `split` and `depends_on`, so
the emitter must learn the third key (written only when present, so a `run new` run.yml stays
byte-identical) and a round-trip test must pin it. `applySplit` writes
`"model-guess"`, because that is measurably what `triagePrompt.ts:249` produces ("`budget_usd` is a
guess … S ≈ $10, M ≈ $25, L ≈ $50") and `splitFile.ts:213-215` validates only "finite and > 0".
Absent = every existing run. `RunFile.ts:565` validates `triage`'s required keys with `requireKeys`,
which ignores extras (`validation.ts:102-113`) — so the new key is validated explicitly when
present, the `decided_by` pattern.

#### Commands

- `tldrx budget grant <usd> --fact <F> [--phase <p>] [--run <id>] [--note <text>]` (**NEW**).
  `--fact` is required — a grant with no decision behind it is a number nobody said. `--phase`
  absent means the run ceiling, which is the common case. It writes through the same emitter and
  validator every other `budget.yml` write uses and appends a `budget.granted` event (an
  `EVENT_TYPES` addition — see the correction in section 3.2).
- `tldrx budget raise` — before the write, reconciles the RESULTING ceiling against the grant.
- `tldrx cost --stories` (**NEW flag**) — per-story measured cost beside the **ceiling that story's
  spawn was given**, and the ratio. Both figures come from `events.jsonl` and nothing else, which is
  `cost.ts:3`'s invariant in its own words (*"Reads `events.jsonl` and nothing else."*) alongside
  `:4-6`'s *"nothing here multiplies a token count by a price"*. Measured: `agent.result` payloads
  carry `key: "S1"` and the row's `cost_usd`, and `agent.spawned` carries
  `{story, role, max_budget_usd}` — both verified in the golden stream
  (`test/fixtures/build/golden/rounds-events.txt:4` and `:20`). So the whole report is derivable
  without touching `run.yml`, the plan or a price table.

  **And it must be named for what it is: a CEILING, not "the plan's share".** Measured, and it
  matters because the issue's 5.8× is the number in question: no plan document carries a per-story
  dollar figure at all — `STORY_KEYS` is `version, id, epic, title, repo, status, depends_on,
  touches, acceptance, test_plan, evidence` (`schemas/story.ts:41-44`), with no budget key. The
  figure a story is measured against is the one the executor computed and handed the spawn
  (`caps.ts` `developerCap`/`reviewerCap`, surfaced as `agent.spawned.max_budget_usd`). So the report
  says *"S1 measured $2.27 against the $0.39 ceiling its spawn was given — 5.8×"*, and never invents
  a plan figure that does not exist. This changes no ceiling: it is the calibration INPUT the
  recalibration issue will need, and the reason that issue can be filed with a corpus instead of an
  argument.

#### Derivations

| Derivation | Leaf | Consumers |
|---|---|---|
| the grant that governs | `src/core/budget/grant.ts` → `grantFor(budget, phaseId)` → `{usd, factId, level: "phase" \| "run"} \| null` | `budget grant`, `budget raise`, `budget show` |
| ceiling-vs-grant | same leaf → `wouldExceedGrant(...)` → `{exceeds, blocked, grant, sentence}` | the same three |
| measured-vs-ceiling per-story ratio | `src/core/build/planVsMeasured.ts` → `overShareSentence(ceilingUsd, measuredUsd, stories)`, **null when either side is absent** — one arithmetic, two feeders, neither of which reads a price table: `cost --stories` feeds it from `agent.spawned.max_budget_usd` + `agent.result.cost_usd` (events only, `cost.ts:3` intact), and the Build handoff feeds it from the caps the executor just used and the turns it just ran | `phaseCostToDate`'s note (→ the Build handoff header); `tldrx cost --stories` |
| spend-vs-ceiling | `wouldExceed.ts:38-57` (**unchanged**) | unchanged |
| cap arithmetic | `caps.ts` + its pinned mirror `remainingWork.ts` | **UNTOUCHED** |
| `round2` | `caps.ts:122-125` (**unchanged**) | everything new that rounds money |

`grant.ts` is a separate leaf from `wouldExceed.ts` on purpose, and its header will say so: one asks
"may this run spend more", the other asks "may this file hold this ceiling". They are two questions
and one function cannot answer both without losing the first.

**Ask (4) — the "N× over" report** goes on the Build handoff's cost line (ruling Q5), where the
executor holds the caps it just applied, so the sentence there compares against the same ceiling
`cost --stories` reads out of the events:
`phaseCostToDate` already returns `{usd, note}` and the note already carries the spend-basis caveat
(`phaseCost.ts`, `phaseCostToDate`'s `note`); `overShareSentence` adds one clause to it. Its single reader is the Build
handoff header (`build/handoff.ts:94`) `[measured]` — `phaseCostToDate`'s only call sites are
`build.ts:2300` and its re-export at `:2997`. **Not a new event** (the only option with golden-byte
risk) and never in a prompt.

**Ask (3) — the preset shares are labelled, not moved.** Each `budget_usd:` in `stages/*/stage.yml`
(five: `what` 4 `:15`, `how` 6 `:15`, `plan` 4 `:14`, `build` 9 `:23`, `watch` 2 `:25` — all five
re-verified) and each `default_budget_usd:` in `workflows/*.yml` (thirteen) gains an `[assumption]`
comment naming what the number is and what it is not, with the measured counter-evidence beside it
(a story measured $2.27 against a $0.39 share — 5.8×). Today those files carry `[assumption]`
comments about `effort:` and **none about the money** `[measured]`, so the issue's "at minimum" is
literally unmet. Comments only: zero behaviour change, and no literal moves (see section 2's non-goals).

#### Refusals and exit codes (#170) — and why this is not one condition in two families

| Condition | Code |
|---|---|
| `budget raise`: bad amount, unknown phase, donor cut below spend | **1** `EXIT_USAGE` — unchanged, pinned by `test/budget-ux.test.ts:268` |
| `budget grant`: bad amount, unknown phase, `--fact` naming no live fact | **1** `EXIT_USAGE` |
| `budget raise` / `grant`: the resulting ceiling exceeds the recorded grant AND `on_grant_exceed: block` | **2** `EXIT_GATE_REFUSED` |
| several runs open (unchanged) | **2**, via `resolveRunOrExplain` |

Ruling Q3, stated so it cannot be read as a split: **these are two different conditions, each wholly
inside one family.** "You typed banana" is a usage error; "the owner forbade this ceiling" is a
money/gate refusal, which is what AGENTS §7 reserves 2 for and what #167 moved `tldrx ship`'s state
refusal into in 0.10.0. Supporting measurement: `budget`'s help entry already declares
`exits: [EXIT_OK, EXIT_USAGE, EXIT_GATE_REFUSED, EXIT_NOT_FOUND]` — because `resolveRunOrExplain`
already returns 2 — so the command's exit surface does not grow, only a new reason for a code it
already has.

#### `[PENDING owner: grant shape]` — what changes under each alternative

*Default, specified above: a `budget.yml` row + `tldrx budget grant`.* One money ledger; `facts.yml`
stays prose-shaped exactly as it is; the reconciliation is entirely inside `src/core/budget/`. Its
one real limitation, stated rather than hidden: a grant recorded on a run cannot reconcile
`tldrx run new --budget` or `tldrx seed apply`, because neither has a run yet — so the seeded-ceiling
half of the issue is served only by `triage.budget_basis`, not by a refusal.

*Alternative A — a structured fact.* `Fact` grows an `amount_usd?: number` (or `kind` grows
`"budget"`, which is a closed 3-value enum at `Fact.ts:3-4` and a bigger schema decision), and
`captureAnswers` mints it when the answer carries an amount. What changes: the grant becomes
**workspace-level and outlives the run**, so `run new --budget` and `seed apply` CAN be reconciled —
which is the half the default cannot reach — at the cost of a new fact shape, a hard dependency on
#169 landing first, and money recorded in two places. `budget.yml` would then carry only a cached
`authorized_by` pointer, not the amount.

*Alternative B — label and report only.* No new verb, no new `budget.yml` key, no refusal: the
preset `[assumption]` labels, `triage.budget_basis`, `tldrx cost --stories` and the N× cost-line
clause ship, and the reconciliation is filed as its own issue. That is roughly 40% of the work and
loses ask (1) entirely — the framework would still write a ceiling the owner forbade, it would just
say the number was a guess.

*Refused outright, in any shape:* parsing an amount out of an answered fact's prose. A regex over
free text deciding whether to refuse a spend is "reading the label, not the code", and the label is
somebody's claim.

#### Tests (#170)

- `test/remaining-work.test.ts:138-147` "the cap constants are mirrored, not guessed" — **stays
  green**, because nothing it mirrors moves. A red here means the change grew beyond this spec.
- `test/money-safety.test.ts:400` (M9, the phase-ceiling arithmetic) — **stays green**; no share
  recalibration.
- `test/money-safety.test.ts:72` (M6, "a REFUSED raise appends nothing", asserting
  `expect(code).not.toBe(0)`) — **stays green**; it is lenient about the family.
- `test/budget-ux.test.ts:134-180` (six validation tests) and `:261` ("a bad amount is a usage
  error, and nothing is written", exit **1**) — **stay green**. The grant refusal is a seventh path,
  with its own test asserting **2**.
- `test/seed-triage.test.ts:278` — extended for `triage.budget_basis`; the absent case pinned.
- `test/gates.test.ts:335-362` — **stays at 7**; #170 adds no condition.
- `test/economy.test.ts`, `test/token-economy.test.ts`, `test/attempt-cost.test.ts`,
  `test/estimate-remaining.test.ts` — second-order, expected green; run them and read the code.

New: `test/budget-grant.test.ts` (spawning; red-first both directions — a raise inside the grant
succeeds, a raise above it warns under `warn` and refuses with **2** under `block`, and an absent
grant reconciles nothing and refuses nothing). +1 `machine-load` row.

#### Docs (#170), EN and ES in lockstep

`docs/spec.md` §2.11 (1253) — the four grant keys; §2.2 (132) — `triage.budget_basis`; §6.2 (3273) —
the split's basis; §2.9 (1079) — `budget.granted`; §3 (1690) — the new verb and flag.
`docs/dashboard-model.md` — the `Run.budget` row (line 147) enumerates every `budget.yml` field the
model projects, so a projected grant key belongs there; `DASHBOARD_MODEL_VERSION` stays **3**.
`docs/guide/06-budgets-and-cost.md`, `docs/guide/08-cli-reference.md`.
`docs-site/concepts/budgets.md` **+ `es/`**, `docs-site/guides/budgets.md` **+ `es/`**.
`src/cli/helpText.ts` — the `budget` entry (`:906`): `subcommands: ["show","raise","grant"]`,
the new flags scoped with `sub:`, and a note naming which refusal is 1 and which is 2; the `cost`
entry for `--stories`.

#### Size (#170)

~14–20 files — of which **18 are comment-only** (5 stage presets + 13 workflows) — ~15–22 new tests,
+1 new spawning test file.

---

## 4. Cross-cutting invariants

### 4.1 `version: 1` formats only grow — every file, every field

**A field is not "added" until the code that WRITES the file carries it.** Every format in this tree
is emitted key-by-key by a hand-written emitter, and two of the three have a mapper in front of them
— so a new key declared in an interface, validated, and never emitted is dropped on the next write
with no type error and no failing test. That is why the last column exists, and it is the column an
implementer must satisfy before claiming a field is done.

| File (spec §) | New / changed | Absent means | Old records | Mapper + emitter that MUST learn it, and the pin |
|---|---|---|---|---|
| `.tldrx/memory/facts.yml` (§2.5) | `source.decided_by` — **existing field, newly written by the answer path** | "not stated", never "owner" | load unchanged | none — `append` spreads `source` (`FactsStore.ts:93`), `emitFact` already emits it (`emitFactsYaml.ts:76-79`) |
| " | `conflicts_with?: readonly string[]` — NEW optional | no contradiction was **detected** | load unchanged | **`FactsStore.append` + `FactsStore.supersede` (`FactsStore.ts:83-101`) and `emitFact` (`emitFactsYaml.ts:73-104`)** — both enumerate keys; a `NewFact` carrying the field is dropped with no type error. Pin: a `NewFact` → append → emit → parse → validate round-trip test. |
| " | `repos` — **no schema change**, newly populated from explicit signals | "no repo was named" | load unchanged | none — `append` copies `repos` (`:88`) |
| `tldrx-work/<run>/budget.yml` (§2.11) | `authorized_usd`, `authorized_by`, `authorized_at`, `on_grant_exceed` (default `warn`), `BudgetPhase.authorized_usd` — **required-and-nullable**, the `ceiling_host_tokens` shape | no grant recorded; nothing reconciled — **the lax side** | load unchanged | **`asRunBudget` (`RunBudget.ts:234-254`) and `emitBudgetYaml` (`emitRunYaml.ts:217-261`)** — the emitter's own comments (`:227-232`, `:233-240`, `:241-247`) say a key that does not round-trip is **ERASED by `budget raise`**, which is the command being made grant-aware. Pin: `grant` → `raise` → re-read, grant intact. |
| `tldrx-work/<run>/run.yml` (§2.2) | `triage.budget_basis?` — NEW optional | what every existing run means | load unchanged | **`emitRunYaml.ts:167-169`**, which emits `triage:` as a fixed inline mapping. Pin: a triaged run.yml round-trips the basis; an untriaged one stays byte-identical. |
| `tldrx-work/<run>/events.jsonl` (§2.9) | `story.touches_widened`, `fact.conflict_raised`, `budget.granted` — **three additions to the closed `EVENT_TYPES` enum** (`Event.ts:106-124`) | — | every existing event still validates; see the correction in section 3.2 | `EVENT_TYPES` itself; `validateEvent` refuses an unlisted type (`:157`). Pin: `renderReplay` and `readReviewLedger` survive each new type. |
| `03-plan/stories/<id>.md` (§2.13) | **no schema change** — `touches` is a value | — | unchanged; `STORY_KEYS` untouched | `applyPlanPatch` gains `replaceTouches` (`storyFile.ts:48-53`) — the one story writer, shared with the implicit plan |
| `04-build/implicit-plan.yml` | **no schema change** — same writer | — | unchanged | same `applyPlanPatch` |
| `04-build/fixlist/*.md` | **nothing at all** — no fifth disposition, no new rendered field | — | byte-compatible both ways | none, deliberately |
| `DASHBOARD_MODEL_VERSION` | stays **3** — additions never bump it | — | — | — |

Nothing here becomes required *in the file*, and no absent value acquires a new meaning. (The budget
keys are required in the TypeScript interface and defaulted by the mapper, which is how
`ceiling_host_tokens` reconciles those two sentences: a file without them loads and means "no
grant".) The two changes that would have broken the invariant — making `authorized_usd` a required
FILE key, and letting a missing grant refuse — are named in section 2 as non-goals.

### 4.2 Absent-with-reason, everywhere a value can be missing

| Missing value | What is recorded instead |
|---|---|
| who decided | `decided_by` is simply absent, and absence has exactly ONE documented meaning — "not stated", never "owner" (`Fact.ts:36`, spec §2.5, the docs-site evidence page). The REASON is said where a person can act on it: `tldrx answer` prints that the fact was recorded with no decider because the invocation passed no `--decided-by`. No second field re-derives it (I2). |
| the repos a decision binds | `[]` — "no repo was named", never the run's repos |
| whether a fact contradicts another | absent `conflicts_with` means "not detected", never "checked and agreed" |
| an owner's authorization | absent `authorized_usd` means "no grant recorded", never `$0` |
| where a seeded budget came from | absent `triage.budget_basis` means what every existing run means; present, it says `model-guess` because that is measurably what produced it |
| a carried finding's path | two distinct labels, each with its sentence: `no-src` (*"`where:` names no `[src: …]` path"*) and `unqualified` (*"the citation names no repo, and a repo is not guessed at"*). Neither is ever counted as owned. |
| a repo for an `affects:` entry | an entry that names no workspace repo contributes nothing, and an entry shaped `repo:path` whose prefix matched nothing is NAMED on stdout — so `[]` is never reported as "no repo was named" when one was named and was wrong |
| a measured-vs-ceiling ratio | `overShareSentence` returns **null**; the cost line says nothing rather than a ratio over a figure it does not have |

### 4.3 One implementation per derivation

Every new derivation that more than one surface needs gets a named leaf — and the one that has a
single consumer today deliberately does NOT, because a second file for one caller is not what the
rule asks for. Every consumer is listed in the per-issue tables above (sections 3.1, 3.2 and 3.3). Consolidated,
the leaves this wave adds are `facts/decidedTally.ts`, `answers/reposFromAffects.ts`,
`build/unownedFindings.ts` (`ownershipOf` + `unownedFindings`), `build/planVsMeasured.ts` and
`budget/grant.ts`. Every one takes DATA, not `ctx` and not the session (AGENTS §12). Two things that
an earlier draft made leaves and this one does not: the provenance clause (one consumer, stays in
`renderFacts`) and `conflictOf` (already one implementation at `distill.ts:160-164`, so moving it is
scope no issue asked for — M9).

**The one that carries the most weight is `ownershipOf`**, because three surfaces read it — the Build
handoff's `## Unknowns`, the PR body, and a decision card when one already fires — and `ship` runs in
a separate process. `ship` calls the leaf with the `ShipStory` rows it already has
(`ship.ts:890-896`, `:963`); it does not apply a predicate of its own. One derivation, three
readers, no second computation (I4).

Reused rather than copied — and this is where a second copy would most easily creep in:
`findDuplicate.ts:42-60` (Jaccard), `conflictOf` (`distill.ts:160-164`), `text/srcToken.ts` (the
`[src:]` grammar), `boundary.ts:152` (`inSurface` — path-vs-declared-entry, wrapped by
`ownershipOf`'s repo test rather than used bare), `distill/renderDistill.ts:143`
(`renderQuestions`), `storyFile.applyPlanPatch` (the one story writer), `fixlist.isOpen`
(still-owed), `caps.ts:122-125` (`round2`), `spendBasis.ts` (the lower-bound sentence).
`declaredAffects` becomes exported so that the `affects:` key has ONE parse with two disjoint
consumers.

### 4.4 Red-first

Every behaviour change starts with a failing test whose verbatim RED output is kept, and the code
under test is mutated to confirm the new test goes red **in both directions** where the change has
two halves. A test that passed before the fix is a guard, and is labelled as one. The pins that go
red **by design** are exactly three: `test/decision-cards.test.ts:314` (the card names a real verb),
`test/close-open-questions.test.ts:125` (the close sentence grows), and
`test/docs-cli-coverage.test.ts:62` — and that last one for a narrower reason than an earlier draft
claimed. Measured: `:62` is the only assertion in that file that reads a document
(`guideSection` over `docs/guide/08-cli-reference.md`, `:59-72`); the site tests at `:78`/`:83`
render `HELP_ENTRIES` **in memory** (`:74-76`), so they go green as soon as `helpText.ts` declares
each flag with a meaning, and `:78` matches command names only, so a new subcommand never moves it.
What pins the hand-written EN/ES pages is `:62`, `docs:build` with `ignoreDeadLinks: false`, and
review — not a test that can fail for their absence. Every other existing pin named in sections
3.1/3.2/3.3 is expected **green**, and a red one means the change is bigger than this spec says.

### 4.5 Gates and test discipline

`bun run typecheck` · `bun test` · `bun run build` · `bun run docs:build` · the
`Bun.*`-under-`src/`-outside-`src/core/runtime/` grep. Each run without a pipe, each exit code read
on its own line — `cmd | tail` eats the code and `${PIPESTATUS[0]}` is a bashism the zsh here does
not have. Every new spawning test file gets a private `$TMPDIR` per invocation, imports
`spawnTestTimeout` from `./fixtures/machineLoad.ts` and calls `setDefaultTimeout(spawnTestTimeout())`
— and adds a row to `test/machine-load.test.ts`'s `spawners` list, whose floor at `:125`
(`toBeGreaterThanOrEqual(40)`) rises with it. Four new spawning files are planned; **reconcile the
count, do not hand-wave**.

---

## 5. Golden guard statement

**Expected: no golden artifact moves in this wave.** `test/build-golden.test.ts` freezes four
scenarios and 22 artifacts — the spawned developer prompt, the spawned reviewer prompt, the
`--prepare` bundle's prompt, the ordered events with their payload keys AND values, `run.yml`'s task
rows, and the exit codes (`build-golden.test.ts:4-7`). Measured basis for the claim, per issue:

- **#169 — no.** All four scenarios carry **zero facts**: every developer and bundle prompt renders
  `_No recorded facts match this run's repos._` (measured: six hits across
  `test/fixtures/build/golden/`, all the empty-case sentence; `grep -rl "decided by"` over the
  golden returns **no match**, exit 1). So `decided_by`, `conflicts_with` and the repo filter never
  render there. The contradiction check runs on the `tldrx answer` path, which no golden scenario
  exercises. Ask (4)'s sentence lands in the Build handoff **header** and the close report, and
  `grep -rn "Cost: " test/fixtures/build/golden/` returns **no match** (exit 1) — the handoff is not
  a golden artifact.
- **#171 — no.** The widen verb never fires in the four scenarios, so `story.touches_widened` never
  appears. `renderFixlistSection` — whose output `rounds-developer-S1-2.md` freezes
  (`fixlist.ts:687`, called at `build.ts:2581`) — is **not changed**. The carried/unowned rows go to
  the Build handoff's `## Unknowns`, the PR body, and a card only when one already fires: the
  handoff is not a golden artifact, `ship` runs in no golden scenario, and decision cards are
  rendered to stdout by `runNext.ts:1677`, `runAuto.ts:206` and `status/runItems.ts:130`
  `[measured]`, never into an event or a prompt. No scenario carries a `defer-with-log` finding at
  all — the only `defer-with-log` strings in the golden are reviewer-prompt boilerplate
  (`*-reviewer-*.md:92-93`), so nothing in the fixtures can produce a carried row.
- **#170 — no.** No cap arithmetic moves, no stage literal moves, and no new event fires in a golden
  scenario. The frozen values that a cap change WOULD move, stated completely rather than by one
  example: `$3.20` appears in **three** prompt artifacts (`headless-developer-prompt.md:109`,
  `insession-bundle-prompt.md:109`, `refused-developer-S1-1.md:110`), and `max_budget_usd` appears in
  `headless-events.txt` `#03`, `refused-events.txt:4` and four times in `rounds-events.txt` (at 1.6
  and 1.0) — plus `gate.requested`'s frozen `keys=[checks,cost_usd,outputs,phase]`, which a new
  payload key would break. All of them stand because nothing in this wave touches `caps.ts`. (The
  fixture also writes its own `.tldrx/stages/build/stage.yml` at `budget_usd: 8`
  (`test/fixtures/build/workspace.ts:282-297`), so it would not read a shipped literal even if one
  moved.)

**If a golden byte does move, the change is wrong until proven otherwise.** The only sanctioned path
is the wave-2 rule the file states itself: name the affected artifacts BEFORE starting, carry the
golden diff in the commit as evidence, and say which bytes changed and why. `TLDRX_GOLDEN_UPDATE=1`
to make a diff go away is never the answer — and a regeneration run fails deliberately
(`build-golden.test.ts:130-135`) precisely so it cannot become one.

---

## 6. Order and coupling

**#169 → #171 → #170**, with the fact file §4.2 reasons.

1. **#169 first.** It is the only one already half-shipped: `decided_by` exists, is validated, is
   emitted and is rendered, and only the answer path fails to write it — so completing it is the
   smallest change with the largest reach. It is also the one that keeps #170's options open: a
   grant has nothing structured to reconcile against until an owner's authorization can be a
   structured decision, and if `[PENDING owner: grant shape]` resolves to Alternative A, #170
   depends on #169 outright. Under the default it does not, and the ordering costs nothing.
2. **#171 second.** Genuinely independent of #169 — different files, different formats, no shared
   derivation — so it can be built in a sibling worktree and merged in either order. It goes before
   #170 because its sharpest fork is a controller decision rather than a discovery, and because it
   must be the only issue that could ever touch `autoGate.ts`'s condition count.
3. **#170 last.** The widest (14–20 files), the only one that could move golden bytes through
   arithmetic rather than prose (it does not, because `caps.ts` is out of scope), and the one whose
   most contentious half has no calibration corpus in this repo.

Shared files, and how the collision is avoided rather than merged:

| File | #169 | #171 | #170 | Discipline |
|---|---|---|---|---|
| `src/core/run/decisionCards.ts` | — | ✅ `:105`'s advice line + unowned rows on `boundaryCard`'s detail | — | **Only #171 touches it under this design** — #169's tally goes to the handoff header and the close, #170's ratio to the cost line. The three-way collision the fact file predicted does not happen. Note the card is a *secondary* surface here (C3): it fires only when the gate already falls to a person. |
| `src/core/run/autoGate.ts` | — | only if `[PENDING owner: block vs report]` = block | — | Nobody, under the defaults. `test/gates.test.ts:362` may be renumbered **once per wave, by one issue**. |
| `src/core/build/handoff.ts` | ✅ a `Decisions:` clause on the header line (`:92-95`) | ✅ the carried/unowned bullets in `## Unknowns`, plus the rows on `BuildHandoffParts` (C3 moved them here from the card) | ✅ extends `costNote` on the same header line | **A genuine three-way collision, and the only one this wave has.** Two of the three touch the same header line and are different fields on it; #171 touches a different region (the `## Unknowns` block and the parts interface). Land in wave order — #169's clause, then #171's section, then #170 rebases its `costNote` extension onto both — and never in parallel. |
| `src/cli/helpText.ts` | ✅ `answer` | ✅ `story` | ✅ `budget`, `cost` | Mechanical, conflict-prone, gated by `docs-cli-coverage`. |
| `src/core/events/Event.ts` (`EVENT_TYPES`) | ✅ +1 | ✅ +1 | ✅ +1 | Three one-line additions to one list; resolve as the union. |
| `CHANGELOG.md` | ✅ | ✅ | ✅ | New `## 0.11.0 — unreleased` heading (the top section today is `## 0.10.0 — 2026-09-07`, dated and immutable). Conflicts resolve as the **UNION** of both sides — one section per version, one heading per kind. |
| `docs/spec.md` | §2.5, §2.7, §2.9, §3 | §2.9, §2.13, §3 | §2.2, §2.9, §2.11, §6.2, §3 | Mostly disjoint; §2.9 and §3 are shared and resolve as the union. |
| `src/core/build/fixlist.ts` + `src/core/run/ship.ts` | — | ✅ `carriedFindings`; `ship` calls the shared leaf | — | #171 only. `ship` gains no predicate of its own (I4). |
| `README.md` | — | — | — | **No row moves in these three changes.** Named because AGENTS §5 lists the README status/release tables as part of a change and AGENTS §6 makes the `\| <V> \| unreleased \|` row a release precondition — but that row is added by `scripts/release.sh`'s own commit, not here. Measured: `test/public-surface-consistency.test.ts:163-173` returns early while README's top row equals `package.json`, so this is a convention note, not a red gate. |
| `test/machine-load.test.ts` | +2 | +1 | +1 | The floor at `:125` rises by four. Reconcile the number in the commit that adds the last file. |

---

## 7. Open decisions

Three, each blocking a section rather than the wave. Each has a default this spec is written for; if
a default is confirmed, delete the marker and the alternatives paragraph in the same change.

1. **`[PENDING owner: grant shape]`** — section 3.3. *Default:* a `budget.yml` row written by
   `tldrx budget grant <usd> --fact <F> [--phase <p>]`, one money ledger. *Alternatives:* a
   structured fact (reaches `run new` and `seed apply`, depends on #169, records money twice); label
   and report only (~40% of the work, loses ask 1). *Refused in any shape:* a regex over an answered
   fact's prose. **Two of the three PENDINGs can invalidate a section rather than a paragraph** —
   this one, and (2)'s alternative (b).
2. **`[PENDING owner: who widens]`** — section 3.2. *Default:* operator-only `tldrx story widen <id>
   <path> --note`. *Alternatives:* an agent may widen with a recorded event (then the boundary card
   MUST name every widening, because condition 7 can no longer refuse); or a fix-round story created
   at Build time. **That second alternative discards the whole first half of section 3.2** —
   `story widen`, `StoryPatch.touches`, `widenStory.ts`, the `decisionCards.ts:105` line, the exit
   table and `test/story-widen.test.ts` all go — and replaces it with a story no wave declared, so
   `waves.yml`, `buildProgress` and auto-gate condition 6 ("every story reached done") must all learn
   about it, under `MAX_STORIES_PER_WAVE`. It is given here as a cost paragraph rather than a design
   precisely because designing it is the ~1.5-2× of work the fact file estimated; if the owner leans
   that way, it wants its own scoping pass before the plan, not a paragraph.
3. **`[PENDING owner: block vs report]`** — section 3.2. *Default:* report only — the Build handoff's
   `## Unknowns` and the PR body (**not** a decision card, which does not render on a passing gate;
   see C3 in section 3.2). The default's real limit: the finding is shown in two documents and
   nothing stops. *Alternatives:* block `tldrx ship` (exit **2**, and it needs a sanctioned move that
   answers it or an unattended run parks at the PR); block the Build auto-gate (an eighth condition,
   `test/gates.test.ts:362` renumbers by design, and every `auto` gate in every workspace can then
   stop on a defect the run cannot fix — which is what would actually have stopped the live defect
   shipping).

One further item that is **not** a PENDING but wants an explicit acknowledgement: the
`answer-capture` hook deviation in section 2, with its measurement.

---

## 8. Risks

1. **The `repos` change narrows what `{{facts}}` shows every sub-agent** — the hottest path in the
   framework (`renderFacts`, `prompt.ts:412-414`, read by the Build and Watch executors, `runNext`,
   the training miner and the no-re-ask hook). Mitigated by populating only from explicit signals —
   a flag, or an `affects:` entry that names a repo — so nothing narrows silently. It still needs a
   test **both ways**: present in a run that has the repo, absent from one that does not.
2. **The `affects:` half of ruling Q3 will rarely fire.** `affects:` names run-relative `.md`
   documents today `[measured]`, so on real question blocks it yields no repos and `--repo` is the
   mechanism that reaches the F032 case. Named here so it is not discovered as a surprise after the
   change ships.
3. **The advisory check does not catch #169's own transcript.** Measured in section 3.1: `conflictOf`
   compares a question TITLE against a fact's text, within one `area`, at Jaccard 0.6 — so it catches
   a question re-answered differently and cannot catch three differently-titled answers that
   contradict semantically. Ask (3) is therefore partly served, the limit is pinned by a test, and
   the remainder is filed rather than promised. The risk is that a reader takes "the contradiction
   check now runs" to mean more than it does; that is why the limit is stated three times.
4. **The `answer-capture` hook cannot honestly say `owner`** — section 2's deviation, accepted as the
   ruling. If the owner intended a different, external hook, the design is unchanged: that caller
   passes the flag.
5. **A new key can be declared, validated, documented and still silently dropped.** Every one of
   these formats is emitted key-by-key by hand, and two have a mapper in front; `budget.yml` is the
   dangerous one, because the emitter's own comments say a key that does not round-trip is erased by
   `budget raise` — the very command being made grant-aware. Section 4.1's last column and its
   round-trip pins exist for this, and an implementer who satisfies the type checker without them
   ships a grant that survives exactly until the first raise.
6. **Three new event types go into a CLOSED enum**, and the fact file's inference that readers
   tolerate unknown types is **wrong** (`Event.ts:157`, measured). Before any of them lands,
   `renderReplay` and `readReviewLedger` are checked and a test pins that both survive the new type.
7. **The advisory contradiction check has no measured false-positive rate either.** Every raise costs
   a human a read of a §2.7 block. If it is noisy it will be switched off rather than tuned — which
   is why the measurement protocol is written into section 3.1 now and why the check may gate
   nothing until the number exists.
8. **`caps.ts` is the wave's tripwire.** Any pull toward changing share arithmetic reddens
   `test/remaining-work.test.ts:139` and moves `$3.20` in the golden. A red there is the design
   telling you the change is bigger than this spec — stop and re-scope, do not follow it.
9. **`test/machine-load.test.ts`'s spawner floor rises by four.** Reconcile it in the same commit as
   the last new test file; a hand-wave here is how a spawning test file silently gets a fixed 5000 ms
   budget and starts measuring the box.

---

## 9. Decisions applied (controller note, 2026-09-07)

The three `[PENDING owner …]` questions were put to the owner in Slack with a 45-minute timeout and
settled by **timeout default** (`authority: system-default` — the bridge's own record, not an owner
decision): grant shape = a `budget.yml` row; unowned findings = report only; who widens = the
operator only. The plan is written for these defaults. The owner can revert any of the three; each
alternative's cost is stated in its section, and the second alternative of "who widens" wants its own
scoping pass before a plan, as section 7 says.
