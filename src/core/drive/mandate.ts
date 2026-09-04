/**
 * The host/driver mandate (issue #63) — the discipline the first real runs were
 * driven by, shipped as text instead of retyped from chat.
 *
 * Every elite run of 2026-08-31/09-01 was driven by a session carrying a
 * hand-written playbook, and that playbook was the framework's real quality
 * floor: the three-role protocol, evidence labelled by how it was come by,
 * product questions parked rather than decided, the reviewer calibrated to the
 * stakes, and the cost declared once and honestly. None of it lived in the
 * package, so a third party inherited the CLI and rediscovered the discipline —
 * or did not.
 *
 * Four rules hold this file up:
 *
 *   - **Preconditions ARE the discipline.** The mandate establishes its own before it
 *     asks for anything (#84): a text that assumes attendedness, a gate policy and a
 *     budget were arranged for it by hand only works where somebody was already being
 *     careful, which is the failure it exists to prevent.
 *
 *   - **It is a MANDATE, not a manual.** It says what the driver must DO and what
 *     it may not decide. The commands appear only where the instruction is
 *     meaningless without them; `tldrx <cmd> --help` and
 *     `docs/guide/10-unattended-mode.md` remain the authority on the machinery,
 *     and this text says so rather than growing a second copy of it.
 *   - **Two modes, one spine.** The disciplines are identical in both — they are
 *     about how a claim is made, not about who is watching. What differs is the
 *     GATE (who may sign) and DRIVING (who spawns), and only those two sections,
 *     so the difference between the modes is visible rather than diffused.
 *   - **It is versioned with the package.** The header carries the framework
 *     version it was printed by, so a mandate pasted into a session six months
 *     from now can be told from the one that shipped with it.
 *
 * `MANDATE_MAX_LINES` is a real bound, asserted by the tests. A mandate long
 * enough to skim is one nobody follows, and the failure mode of prose in a prompt
 * is that it loses to recency — so the budget is part of the artifact.
 *
 * The bound moved ONCE, from 120 to 140, and this is the reason: the text had four
 * instructions to STOP and not one to continue. Measured 2026-09-04 over the eight
 * runs of the aparece-v2 workspace — 26 `budget.raised`, 26 `question.answered`,
 * and an owner who had to type "sigue con todas desatendido, no esperes por mi"
 * INSIDE an unattended run to restart a session the mandate had correctly halted.
 * A prompt that licenses stopping four times and never says "keep going" produces
 * exactly that, and no amount of brevity fixes it. See `continuation()`.
 */

export const DRIVE_MODES = ["attended", "unattended"] as const;
export type DriveMode = (typeof DRIVE_MODES)[number];

/** Each mode's text must fit in this, and the tests hold it to it. */
export const MANDATE_MAX_LINES = 140;

/**
 * The bound for a `--tldr` mandate, which carries one section the others do not.
 *
 * Deliberately a SECOND constant rather than a bigger first one. The reporting
 * contract is ~23 lines of prompt paid once, and what it buys is a session that
 * stops writing prose on every turn for the rest of the run — measured on the
 * aparece-v2 workspace, 133,689 B of operator notes and 99,689 B of gate evidence
 * that no prompt ever reads back. Letting the standard mandate drift to fit it
 * would spend the skimmability budget of every run to pay for the terse one.
 */
export const MANDATE_TLDR_MAX_LINES = 165;

const RULE = "-".repeat(78);

/** What the mandate writes where a run id belongs, when it has none to write. */
export const RUN_PLACEHOLDER = "<run>";

/**
 * The mandate for one mode, as plain text with no trailing newline — the caller
 * adds exactly one, so the line count a test asserts is the line count a reader
 * sees.
 *
 * `run` fills in every `<run>` (#75). It is applied TEXTUALLY, at the end, over
 * the finished document: there is no second list of the places an id appears, so
 * a command added to the mandate later cannot be forgotten here. Omitted, every
 * occurrence stays as it is and the header keeps its find-replace instruction —
 * the behaviour before #75, unchanged.
 *
 * Deterministic either way: nothing is read from disk, no workspace is needed,
 * and the same arguments always produce the same bytes.
 */
export function renderMandate(mode: DriveMode, version: string, run?: string, tldr = false): string {
  const text = [...header(mode, version, run, tldr), ...preflight(mode), ...roles(), ...evidence(),
    ...continuation(mode), ...parking(), ...calibration(), ...budget(), ...reporting(tldr),
    ...driving(mode), ...gate(mode)].join("\n").trimEnd();
  return run === undefined ? text : text.replaceAll(RUN_PLACEHOLDER, run);
}

function header(mode: DriveMode, version: string, run?: string, tldr = false): readonly string[] {
  return [
    `tldrx drive — session mandate · ${mode}${tldr ? " · tldr" : ""} · tldrx ${version}`,
    "",
    // With an id there is nothing left to find-replace, so saying so would be a
    // false instruction — and the reader has one fewer thing to get wrong.
    ...(run === undefined
      ? [
        "Paste everything below the rule into the session that will drive the run, replacing <run>",
        "with its id. Discipline, not manual: `tldrx <cmd> --help`, docs/guide/10-unattended-mode.md.",
      ]
      : [
        `Paste everything below the rule into the session that will drive run ${run}.`,
        "Discipline, not manual: `tldrx <cmd> --help`, docs/guide/10-unattended-mode.md.",
      ]),
    "",
    RULE,
    "",
    ...(mode === "unattended"
      ? [
        "You are my unattended verification gate on run <run>, until its last gate. Nobody is watching:",
        "that is not permission to go faster — it is why every claim below stays checkable tomorrow.",
      ]
      : [
        "You are driving run <run> with me at the keyboard: I read what you tell me, and I sign every",
        "gate. Make each of my decisions a five-second one, because you already did the checking.",
      ]),
    "",
  ];
}

/**
 * The preflight (#84) — the FIRST section, because a mandate that assumes its own
 * preconditions only works when somebody has already been careful.
 *
 * Measured on a cold start (2026-09-02): launching an unattended run took SIX
 * hand-run commands before the mandate could be pasted at all — `run attend host`,
 * then `run gates set` five times. Every one is a precondition of the discipline
 * this text exists to transfer, so an owner typing them is doing the driver's job.
 * The mandate now establishes them, and REFUSES to start where it cannot.
 *
 * The modes differ here exactly as they differ at the gate. The unattended driver
 * may MOVE a stage to `agent` — over a note quoting the owner's own delegation, so
 * the change is signed by the owner's words and not the driver's judgement. The
 * attended one may not: there every gate is the owner's, and a driver that moved
 * one would be taking the signature away rather than earning it.
 */
function preflight(mode: DriveMode): readonly string[] {
  if (mode === "unattended") {
    return [
      "## Before anything: the preflight",
      "",
      "Preconditions ARE the discipline — establish them yourself, do not make me hand-run them.",
      "`tldrx run status <run>` shows attendedness and the ceiling; `--json` adds the gate policy:",
      "- ATTENDED: `attended_by: host` per my economy instruction; else `tldrx run attend host <run>`.",
      "- GATES: every stage I delegated must read `agent`. Move each one that does not with",
      "  `tldrx run gates set <stage>:agent --note \"…\"`, quoting MY delegation from the launch message.",
      "- BUDGET: `tldrx-work/<run>/budget.yml` exists. State the ceiling you will honour, in dollars.",
      "",
      "Any one of the three you cannot establish: REFUSE to start, name the command that failed,",
      "and put it to me as a guided question — a strict blocker is asked, never gone quiet on.",
      "",
    ];
  }
  return [
    "## Before anything: the preflight",
    "",
    "Preconditions ARE the discipline — check them before you ask me for anything. Read",
    "`tldrx run status <run>`, which shows attendedness and the ceiling, and then:",
    "- ATTENDED: say which way `attended_by` reads, and drive that way for the whole run.",
    "- GATES: mine, and they stay mine. This mandate moves no gate policy: if a stage is not",
    "  `human` where I expected it, stop and tell me rather than working around it.",
    "- BUDGET: `tldrx-work/<run>/budget.yml` exists. State the ceiling you will honour, in dollars.",
    "",
    "Either check you cannot establish: REFUSE to start, and name the command that failed.",
    "",
  ];
}

function roles(): readonly string[] {
  return [
    "## Three roles, and none of them is the other two",
    "",
    "1. DEVELOPER — a sub-agent you dispatch with the prepared bundle. It works in the story's",
    "   own worktree and writes nowhere else.",
    "2. REVIEWER — a FRESH, read-only sub-agent over the diff. Never the author, never the",
    "   author's session, never a re-read of the author's own report. Its job is to find what",
    "   the developer got wrong.",
    "3. HOST — you. You verify BOTH, in the code, not in their reports. \"Done\" and \"approved\"",
    "   are two claims, and the tree is the only thing that settles either.",
    "",
    "A reviewer that agrees with everything cost money and bought nothing. Two consecutive",
    "sign-with-no-findings is a signal about the reviewer: say so, and check it is reading the",
    "diff at all before you trust a third.",
    "",
  ];
}

function evidence(): readonly string[] {
  return [
    "## Evidence discipline",
    "",
    "- Label every claim, in the same sentence as the claim: measured (I ran it) · inferred",
    "  (mechanism plus evidence, could be wrong) · assumed (I do not know).",
    "- Never let a pipe eat an exit code. `cmd | tail && commit` reports the tail's status, not",
    "  the command's. Run the gate, then read `$?`, then decide.",
    "- Verify from the source, not from your own output. After a write, read it back from the",
    "  file, the API or the database. Your script printing \"ok\" is not proof it landed.",
    "- Ask the remote about the remote: `git ls-remote origin <ref>` for a sha, never a local",
    "  ref that may be days stale. Merged is not deployed, and green locally is not green in CI.",
    "- State the negative case with its denominator. \"0 of 263 rows, 24 of them eligible\" beats",
    "  \"it seems broken\".",
    "- Check that the instrument can see the thing before you trust the number it gives you.",
    "- When something contradicts a claim you already made, correct it in place and say you were",
    "  wrong. Early and out loud is the cheap version of that.",
    "",
  ];
}

/**
 * The rule the mandate did not have — and the whole reason the bound moved.
 *
 * Unattended only, and it is the governing sentence of that mode: the framework
 * already refuses to spawn, so the ONLY thing that can end a run early is the
 * session deciding to. Measured over the eight driven runs of the aparece-v2
 * workspace on 2026-09-04, the old text contained four instructions to stop
 * (the preflight refusal, "do nothing yet", the budget "and wait", and the
 * four-item interrupt list) and zero instructions to continue — `grep -ic
 * "continue|keep going|proceed|do not stop|resume"` over this file returned 0.
 * A session obeying it exactly halts at the first ambiguity, which is what
 * happened: the owner had to type "yes, extend S8's touches when you get there —
 * keep going" and later "sigue con todas desatendido, no esperes por mi" into
 * runs that were supposed to need neither.
 *
 * The definition of "strict" is the load-bearing half. Without it, "blocker"
 * means "something I would like an answer about", and every question is one. A
 * blocker that leaves another story, wave or stage runnable is a question to
 * park, not a stop — so the text makes the driver NAME the unblocked work before
 * it is allowed to call anything strict.
 */
function continuation(mode: DriveMode): readonly string[] {
  if (mode !== "unattended") return [];
  return [
    "## Do not stop",
    "",
    "Stopping is the failure this mandate exists to prevent, and \"I had a question\" is not one.",
    "Halt only on a STRICT blocker: one where no remaining turn can proceed until I answer. Before",
    "you call one strict, name the work it does NOT block — the next story, wave, stage or review —",
    "and go do that first. Everything short of that you park as below, or decide and log; then",
    "carry on. If you are truly blocked on every front, that is one line and a guided question, not",
    "silence.",
    "",
  ];
}

/**
 * Parking, in the shape an owner can answer in seconds — and WITHOUT the halt the
 * old text licensed.
 *
 * Two things were wrong here and both were measured on the aparece-v2 runs.
 *
 * The first was the sentence "if the only safe version is `do nothing yet`, do
 * nothing yet and park it". It is true about the WRITE and was read as true about
 * the RUN: a session that hit one product question stopped the whole run rather
 * than the one path the question blocked. Not shipping an unguarded write is not
 * the same as not shipping anything, and the text now says which it means.
 *
 * The second was the shape. "State the question in one sentence" gets an open
 * prompt, and an open prompt cannot be answered from a phone at midnight. The §2.7
 * grammar already wants 2–5 lettered options; the mandate now wants the same, plus
 * the option the driver would take. That last line is what makes the question
 * answerable with one letter, and it is the thing run 260830-billing-entitlements
 * invented for itself on 2026-09-04 because the mandate did not ask for it.
 *
 * The CHANNEL stays out of the framework, deliberately. The default is the console,
 * because that is the one surface every driver has; anything else — a chat bridge,
 * a pager, a bot — is named in the owner's launch message and the mandate defers to
 * it without knowing what it is. A framework that hard-codes one operator's chat
 * tool has made that operator's setup a dependency of everybody's run.
 *
 * The last line is the one that keeps the record honest: a default the driver takes
 * because no answer came is the DRIVER's decision, recorded as the driver's, and may
 * never be cited back as the owner's. That distinction was drawn by hand at
 * `260830-billing-entitlements` 2026-09-04T08:00:45Z ("NOT Alan's decision, and must
 * never be cited as one") and is now part of the text.
 */
function parking(): readonly string[] {
  return [
    "## Park product questions as GUIDED ones; do not decide them, and do not halt for them",
    "",
    "A product decision is not yours to make — and it is not a reason to stop the run. Park it",
    "the same turn you hit it, then carry on down every path it does not block:",
    "",
    "- the question in one sentence, and exactly what it blocks — and what it does NOT;",
    "- 2–5 lettered options, each with its consequence. Never an open prompt;",
    "- what the docs and the run's own facts ALREADY decide, cited, so I pick between real options;",
    "- the option you would take and why, and what you will do if no answer reaches you;",
    "- the smallest guarded thing you can ship without the answer — or say there is none.",
    "",
    "Ask on the console, unless my launch message named another channel; then use that one and say",
    "so. An answer I never gave is not my decision: if you act on your own default, record it as",
    "YOURS in those words, and never cite it back to me as mine.",
    "",
    "An open question is never a licence to ship an unguarded write — but not shipping the write is",
    "not the same as not shipping anything. `tldrx note <run> \"…\"` records the moment;",
    "`tldrx answer <Qid> \"…\"` is mine to type.",
    "",
  ];
}

/**
 * `--tldr` — the reporting contract, for a run whose trail nobody will read.
 *
 * It exists because of a measurement and a habit. The measurement, taken over the
 * ten runs of the aparece-v2 workspace on 2026-09-04: of ~4.0 MB the runs wrote,
 * 2.16 MB is trail, and the majority of that trail is never read by anything. All
 * 261 declared stage `inputs:` across those runs contain ZERO occurrences of
 * `handoff.md`, `retro.md` or `gate-evidence` — they are written at output-token
 * cost for a human who, on these runs, was never going to open them. Operator
 * notes alone are 133,689 B, one run's share being 76,382 B of prose no prompt
 * reads back.
 *
 * The habit is the other half: the owner kept typing "tl;dr, what is going on,
 * remaining work, percentages" into a session that had just written six paragraphs
 * about it. `tldrx run status` already prints exactly that — phases, percentages,
 * spend against the ceiling, what is next — so the contract points at the command
 * rather than asking for the same content in sentences.
 *
 * What it may NOT do is stop the handoff being written. `claim-sources` is
 * condition 5 of the seven `auto` conditions and `autoGate.ts` runs it whether or
 * not a stage declared it as a check, so a run with no handoff cannot close an
 * `auto` or `agent` gate and every gate falls to the person this mode exists to
 * leave alone. The contract therefore asks for a handoff trimmed of PROSE and
 * never of citations, and says why in the text — a sub-agent that trims the wrong
 * half fails the validator and costs the gate.
 *
 * Both modes get it. Terse output is orthogonal to who signs, and an owner at the
 * keyboard may want the status block instead of the essay just as much.
 */
function reporting(tldr: boolean): readonly string[] {
  if (!tldr) return [];
  return [
    "## Report terse; do not narrate",
    "",
    "I am not reading this session for its prose, so write none. After every `--commit` and at",
    "every gate, show me two things and nothing else:",
    "",
    "1. what `tldrx run status <run>` prints — it already carries the phases, the percentages, the",
    "   spend against the ceiling and what is next. Do not retype any of it in words.",
    "2. at most three bullets of DELTA since the last one: what landed, what is next, what was",
    "   deferred or decided. Three is a cap, not a target.",
    "",
    "Free text is for two things only: a strict blocker's guided question, and a correction to",
    "something you already told me. Not a recap of a sub-agent's report, not a summary of a diff I",
    "can read myself, not the status block again in sentences.",
    "",
    "Write no `tldrx note` on this run. Nobody will audit it, and no prompt ever reads one back — a",
    "fact that must outlive the turn is `tldrx facts add`, which every later prompt DOES read.",
    "",
    "Brief every sub-agent to keep its handoff minimal: the sections and the `[src: …]` citations",
    "`claim-sources` validates, and nothing past them. Trim the prose, never the citations — the",
    "handoff is a gate input, and one that fails the validator costs the gate you need to close.",
    "",
    "Same for the evidence note: the four H2 sections, the counts you actually measured, and",
    "`caveats: []` when there are none. It is a signature, not a report.",
    "",
  ];
}

function calibration(): readonly string[] {
  return [
    "## Calibrate the review to the stakes",
    "",
    "Rank each story before you brief its reviewer, and put the rank in the brief — a reviewer",
    "told \"this touches auth\" reads differently from one told nothing:",
    "",
    "- SECURITY-BEARING (auth, tenancy, money, deletion — anything that widens what a caller can",
    "  reach): the strongest reviewer you have, highest effort, briefed to hunt for the",
    "  authorization that did NOT widen with the new scope. Re-read its verdict yourself.",
    "- CORRECTNESS-BEARING (schema, migrations, concurrency, retries): a full review, plus one",
    "  check the reviewer cannot do for you — that a test can fail. Break the line it covers and",
    "  watch it go red.",
    "- COSMETIC: an ordinary review. Do not spend a security reviewer on a label.",
    "",
  ];
}

function budget(): readonly string[] {
  return [
    "## Budget honesty",
    "",
    "- Declare a turn's cost ONCE, at commit time: `--cost-usd <n>` and `--tokens <n>`. Declare",
    "  nothing and it is recorded `cost_usd: null, metered: false`, which is honest; a guessed",
    "  $0.00 is a measurement, and a false one.",
    "- When the records are incomplete, report a floor and say it is one — \"at least $4.10 across",
    "  the 6 turns that reported\" — never a total that reads as complete.",
    "- A ceiling raise is my decision: do not raise one, and do not route around one. That is not",
    "  a reason to halt the run — ask it as a guided question, say what the remaining work costs,",
    "  and keep spending what the ceiling still funds. Stop only when the next turn has none left.",
    "",
  ];
}

function driving(mode: DriveMode): readonly string[] {
  if (mode === "unattended") {
    return [
      "## Driving the turns",
      "",
      "The run is `attended_by: host`. The framework must never spawn on it; every turn is yours:",
      "",
      "    tldrx next --prepare <run>            # bundle, preconditions, dispatch notes",
      "    … dispatch ONE sub-agent with the bundle's prompt.md, write its result.json …",
      "    tldrx next --commit <run> --cost-usd <n> --tokens <n>",
      "    tldrx next --prepare --review <run>   # the reviewer's bundle: read-only, fresh agent",
      "    tldrx next --commit  --review <run>",
      "",
      "A bare `tldrx next` exits 4 here, and `tldrx run auto` is refused — the refusal is the point.",
      "",
    ];
  }
  return [
    "## Driving the turns",
    "",
    "Say which way you are driving before you start, and do not switch mid-run:",
    "",
    "    tldrx next <run>                      # the framework spawns and stops at the gate",
    "    tldrx next --prepare / --commit <run> # you dispatch the sub-agent and declare the cost",
    "",
    "Show me the stop reason every time it stops, in its own words. Exit 4 is a gate or an open",
    "question — a normal end to a stage that worked, not a failure to explain away.",
    "",
  ];
}

function gate(mode: DriveMode): readonly string[] {
  if (mode === "unattended") {
    return [
      "## The gate",
      "",
      "Sign only what you checked yourself, and write the check down:",
      "",
      "    tldrx gate template                   # the blank evidence note; it signs nothing",
      "    … fill Read · Citations checked · Touches audited · Verdict …",
      "    tldrx approve --as-agent",
      "",
      "Three things must be true before you sign, and each is one you DID, not one you were told:",
      "- every `[src: …]` you sampled resolves — you opened that file at that line;",
      "- every changed path is one this run declared (the What/How citations plus the stories'",
      "  `touches:`) — read the diff's path list, do not take the count on trust;",
      "- the diff implements the stories it claims to, and nothing else.",
      "",
      "`refuse` and `sign-with-fixlist` are real verdicts — use them. A note that signs everything",
      "is a rubber stamp the framework will believe.",
      "",
      "Interrupt me ONLY for a STRICT blocker — a new product decision, a ceiling raise, or work",
      "outside the declared boundary that nothing else can proceed around — and always as the",
      "guided question above, never as a bare halt. Everything else you decide, and log.",
      "Never push — the final merge is mine.",
      "",
    ];
  }
  return [
    "## The gate",
    "",
    "You do not sign. Every gate is mine — and that is not permission to skip the checking, it",
    "is the reason to do it before I look:",
    "",
    "- run the check anyway: citations resolve, every changed path was declared, the diff",
    "  matches the stories it claims to implement;",
    "- write it into `tldrx gate template`'s note and tell me the path, so my signature has",
    "  something behind it;",
    "- hand me one sentence and one command:",
    "",
    "    tldrx approve --note \"…\"",
    "    tldrx reject  --note \"…\"",
    "",
    "Say \"I would sign, because …\" or \"I would refuse, because …\" and then stop. Never approve",
    "on my behalf, and never tell me a gate is clean because its checks are green: the checks are",
    "measured conditions, and the judgement beside them is mine.",
    "",
    "Never push. The final merge is mine.",
    "",
  ];
}
