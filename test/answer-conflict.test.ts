/**
 * The contradiction check on the ANSWER path — it raises, it never refuses (#169).
 *
 * `conflictOf` had exactly one call site before this — `distill.ts:81`, inside
 * `keep()` — so two answers that disagreed were both appended, both live, and both
 * handed to the next sub-agent through `renderFacts` with nothing saying they
 * disagree. It now runs on both answer paths at its own `CONFLICT_THRESHOLD`.
 *
 * ## What this check can see, and what it cannot — measured, not asserted
 *
 * `conflictOf` → `findDuplicate(claim.match, claim.area, facts, 0.6)`, and
 * `findDuplicate` SKIPS every fact whose `area` differs (the `fact.area !== area`
 * guard — named rather than line-numbered, because that anchor drifted inside the
 * very commit that first wrote it), then scores
 * `jaccard(tokenize(<the new question's title>), tokenize(<the existing fact's
 * whole text>))`. So it catches a question in the SAME area answered a second
 * time, differently, without `--supersede`. It does NOT catch #169's own
 * motivating transcript — three DIFFERENTLY titled answers whose contents are
 * incompatible, not necessarily in one area. No threshold moves that: lowering it
 * manufactures false positives without acquiring the semantic link. Ask (3) is
 * PARTLY served, and TWO limit pins in the first describe keep that honest. Two,
 * because the #169-transcript one is NOT sensitive to the area skip — its top
 * score is 0.167, so deleting the skip leaves it green (measured, fix round 1) —
 * and the second one overlaps well past 0.6 across two areas, so it is null for
 * the area reason and only that one.
 *
 * ## Exactly what this check does, and does not, stop — corrected in fix round 1
 *
 * `tldrx answer` refuses nothing and exits 0 on both paths. The question it mints
 * carries `advisory: true` (§2.7, additive; a tolerant read makes an absent key
 * "not advisory"), and `autoGate`'s `questions` condition SKIPS advisory blocks —
 * so an unattended run is NOT stopped at the next gate by a lexical near-match
 * whose false-positive rate nobody has measured. It is not silent either: the
 * gate's own detail names how many advisory questions it did not count, and the
 * run close still lists them (`collectOpenQuestions`), so a person sees the
 * disagreement. That is the whole of what it does.
 *
 * Before fix round 1 the block was an ordinary open question and DID flip that
 * gate condition, so "it gates nothing" was an overclaim about shipped behaviour.
 * The pins below are what make the sentence true rather than aspirational.
 *
 * ## The false-positive rate is NOT measured, and this file does not pretend it is
 *
 * No labelled corpus exists in this repo (demo fixtures are synthetic by
 * `assertSynthetic`). The protocol, written down now so it is not reinvented:
 * replay every `question.answered` event in a real workspace's `events.jsonl`
 * through the check against the `facts.yml` state at that moment, and have a human
 * label each raise; PRECISION — raises a human agrees are real contradictions,
 * over all raises — is the number. Until that number exists, nothing downstream
 * may promote this advisory into a gate.
 *
 * In process, like `test/answer-attribution.test.ts`: `answerCommand.run` spawns
 * nothing, so this file is not a machine-load spawner and needs no
 * `spawnTestTimeout`. The helpers below start no process either.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { answerCommand } from "../src/cli/commands/answer.ts";
import { FactsStore } from "../src/core/facts/FactsStore.ts";
import { factsPath } from "../src/hooks/lib/workspace.ts";
import { emitFactsYaml } from "../src/core/facts/emitFactsYaml.ts";
import { asFactsFile, validateFactsFile } from "../src/core/facts/validateFactsFile.ts";
import { parseYaml } from "../src/core/yaml.ts";
import type { Fact } from "../src/core/facts/Fact.ts";
import { conflictOf, CONFLICT_THRESHOLD } from "../src/core/distill/distill.ts";
import { parseQuestions, validateQuestions } from "../src/core/text/questions.ts";
import { EventLog } from "../src/core/events/EventLog.ts";
import { validateEvent } from "../src/core/events/Event.ts";
import { loadRun, renderReplay } from "../src/core/replay/index.ts";
import { readReviewLedger } from "../src/core/build/reviewLedger.ts";
import { collectOpenQuestions, describeOpenQuestions } from "../src/core/run/closeRun.ts";
import { RAISED_BY } from "../src/core/answers/raiseConflict.ts";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";
import { createRun } from "../src/core/run/newRun.ts";
import { gatedScope, makeRunWorkspace, type TempRunWorkspace } from "./fixtures/tempRunWorkspace.ts";

let workspaces: TempRunWorkspace[] = [];
afterEach(() => {
  for (const ws of workspaces) ws.dispose();
  workspaces = [];
});

interface AnswerWorkspace {
  readonly root: string;
  readonly runDir: string;
  readonly runId: string;
}

/** One workspace (repos `api` and `lab`), one real open run with an `01-what` phase. */
function runWorkspace(): AnswerWorkspace {
  const made = makeRunWorkspace({ files: gatedScope("true") });
  workspaces.push(made);
  const created = createRun({
    root: made.root, slug: "conflicts", title: "conflicts", scope: "gated", budgetUsd: 5,
    actor: "alan", now: new Date("2026-09-07T09:00:00Z"),
  });
  return { root: made.root, runDir: created.runDir, runId: created.runId };
}

/** A fact already on record, written through the real store so the bytes are real. */
function seedFact(ws: AnswerWorkspace, input: { area: string; fact: string }): Fact {
  return FactsStore.update(factsPath(ws.root), (store) => store.append({
    fact: input.fact,
    area: input.area,
    repos: [],
    kind: "answer",
    confidence: "stated",
    source: { who: "alan", when: "2026-09-06T09:00:00Z", run: null, q: "Q9" },
  }));
}

function questionsPathOf(ws: AnswerWorkspace, phase: string): string {
  return join(ws.runDir, phase, "questions.md");
}

function writeQuestions(ws: AnswerWorkspace, phase: string, body: string): void {
  const dir = join(ws.runDir, phase);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "questions.md"), `# Questions — ${phase} — run conflicts\n\n${body}`, "utf8");
}

/** The §2.7 block shape `test/answer-attribution.test.ts:64-74` uses, slot empty. */
function block(id: string, title: string, area: string): string {
  return `## ${id} · ${title}
<!-- id: ${id} | status: open | area: ${area} | asked_by: product | asked_at: 2026-09-07T09:00:00Z -->
Why asked: nothing in the map answers it [src: absent:.tldrx/map/domains.md]

- A) One way
- B) The other

[Answer]:
`;
}

function eventsOf(ws: AnswerWorkspace): readonly { type: string; payload: Record<string, unknown> }[] {
  return EventLog.forRun(ws.runDir).read();
}

/** A minimal live `Fact`, for the calls that need facts and no workspace. */
function liveFact(overrides: Pick<Fact, "id" | "fact"> & Partial<Fact>): Fact {
  return {
    area: "billing",
    repos: [],
    kind: "answer",
    confidence: "stated",
    source: { who: "alan", when: "2026-09-06T09:00:00Z", run: null, q: null },
    supersedes: null,
    superseded_by: null,
    retired: null,
    ...overrides,
  };
}

/** Every `.ts` under a directory, recursively — for the one-spelling shape test. */
function sourceFiles(dir: string): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(path));
    else if (entry.name.endsWith(".ts")) found.push(path);
  }
  return found.sort();
}

/** Swap stdout for a buffer; returns a reader that restores it. */
function capture(): () => string {
  const original = process.stdout.write.bind(process.stdout);
  let buffer = "";
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    buffer += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stdout.write;
  return () => {
    process.stdout.write = original;
    return buffer;
  };
}

describe("a contradicting answer RAISES — it never refuses", () => {
  test("the answer stands, exit 0, and a §2.7 question names both facts", async () => {
    const ws = runWorkspace();
    // F001 already on record, same area, and the new question's title overlaps
    // its text well past Jaccard 0.6.
    seedFact(ws, { area: "data-model", fact: "Where does leaderboard state live? — Redis" });
    writeQuestions(ws, "01-what", block("Q1", "Where does leaderboard state live?", "data-model"));

    const read = capture();
    expect(await answerCommand.run(["Q1", "Postgres", "--root", ws.root])).toBe(0);
    const out = read();

    const facts = FactsStore.loadOrEmpty(factsPath(ws.root)).facts;
    const fresh = facts.find((f) => f.source.q === "Q1");
    expect(fresh?.fact).toContain("Postgres");            // the answer STANDS
    expect(fresh?.conflicts_with).toEqual(["F001"]);

    const doc = parseQuestions(readFileSync(questionsPathOf(ws, "01-what"), "utf8"));
    // §2.7-valid, not merely parseable: a raised block `questions lint` refuses
    // would put the file it was appended to into a state a gate reports.
    expect(validateQuestions(doc)).toEqual([]);
    const raised = doc.blocks;
    const q2 = raised.find((b) => b.id === "Q2");
    expect(q2, "a new question block was minted").toBeDefined();
    expect(q2?.metadata?.status).toBe("open");
    expect(q2?.metadata?.area).toBe("data-model");
    expect(q2?.title).toContain("F001");
    expect(q2?.whyAsked ?? "").toContain(fresh?.id ?? "");
    // TLDRX asked this, not the person who answered Q1. `renderDistill.ts:155`
    // writes `asked_by: distill` and `init/questions.ts` writes `asked_by:
    // facilitator` for the same reason: `questionCards.ts` puts this value
    // straight onto the decision card as the asker, so the operator's own name
    // here shows them as having asked a question they never asked.
    expect(q2?.metadata?.asked_by).toBe(RAISED_BY);
    // Additive §2.7 key. It is what stops the raise from flipping an auto gate.
    expect(q2?.metadata?.extra).toContainEqual(["advisory", "true"]);
    // The sentence a person is asked to act on must be TRUE. The score compares
    // this question's TITLE with the old fact's WHOLE TEXT, so it can read 1.00
    // while the two say different things — "overlaps F001" full stop would be a
    // sentence that contradicts its own next clause.
    expect(q2?.whyAsked ?? "").toContain("overlaps F001's text at Jaccard 0.83 on the question's wording");

    // The operator line says what happened AND states the limit honestly: nothing
    // was refused, and the check is lexical.
    expect(out).toContain(`${fresh?.id ?? ""} contradicts F001`);
    expect(out).toContain("The answer stands; nothing was refused.");
  });

  test("the id does not collide with the ids already in the file", async () => {
    // `locateQuestion` (`answer.ts:193-205`) scans every phase of the run for a
    // qid, so a duplicate id across two files makes the wrong block answerable.
    const ws = runWorkspace();
    seedFact(ws, { area: "data-model", fact: "Where does leaderboard state live? — Redis" });
    writeQuestions(ws, "01-what", block("Q1", "Where does leaderboard state live?", "data-model"));
    writeQuestions(ws, "02-how", block("Q7", "Unrelated", "delivery"));

    const read = capture();
    await answerCommand.run(["Q1", "Postgres", "--root", ws.root]);
    read();

    const ids = parseQuestions(readFileSync(questionsPathOf(ws, "01-what"), "utf8")).blocks.map((b) => b.id);
    expect(ids).toContain("Q8");
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("one fact.conflict_raised event, with both ids and the score", async () => {
    const ws = runWorkspace();
    seedFact(ws, { area: "data-model", fact: "Where does leaderboard state live? — Redis" });
    writeQuestions(ws, "01-what", block("Q1", "Where does leaderboard state live?", "data-model"));

    const read = capture();
    await answerCommand.run(["Q1", "Postgres", "--root", ws.root]);
    read();

    const raised = eventsOf(ws).filter((e) => e.type === "fact.conflict_raised");
    expect(raised).toHaveLength(1);
    // `raised` is the question this MINTED; `q` is the question that was
    // ANSWERED. They are different ids and the log has to carry both — without
    // `raised`, `events.jsonl` cannot answer "which question did this raise"
    // and only the questions.md prose can, by re-deriving it.
    expect(raised[0]?.payload).toMatchObject({ conflicts_with: "F001", q: "Q1", raised: "Q2" });
    expect(typeof raised[0]?.payload.score).toBe("number");
  });

  test("an IDENTICAL answer is agreement, and raises nothing", async () => {
    // `conflictOf`'s own rule (`distill.ts`): identical text is agreement, not
    // contradiction. The text compared is the FACT text — `"<title> — <answer>"`,
    // exactly what `distill.ts:103` builds for an answered question — so an
    // answer that reproduces the recorded one lands on that rule.
    const ws = runWorkspace();
    seedFact(ws, { area: "data-model", fact: "Where does leaderboard state live? — Redis" });
    writeQuestions(ws, "01-what", block("Q1", "Where does leaderboard state live?", "data-model"));

    const read = capture();
    await answerCommand.run(["Q1", "Redis", "--root", ws.root]);
    const out = read();

    expect(FactsStore.loadOrEmpty(factsPath(ws.root)).facts.find((f) => f.source.q === "Q1")?.conflicts_with)
      .toBeUndefined();
    expect(eventsOf(ws).some((e) => e.type === "fact.conflict_raised")).toBe(false);
    expect(out).not.toContain("nothing was refused");
    // And no block was minted: the file still holds exactly the one question.
    expect(parseQuestions(readFileSync(questionsPathOf(ws, "01-what"), "utf8")).blocks).toHaveLength(1);
  });

  test("--supersede does not raise against the very fact it replaces", async () => {
    // A supersession NAMES the fact it reverses, so a hit on that fact is the
    // reversal itself, not a contradiction. Without the `head.id` skip every
    // `--supersede` would mint a question asking which of the two is right.
    const ws = runWorkspace();
    writeQuestions(ws, "01-what", block("Q1", "Where does leaderboard state live?", "data-model"));

    const read = capture();
    await answerCommand.run(["Q1", "Redis", "--root", ws.root]);
    expect(await answerCommand.run(["Q1", "Postgres", "--supersede", "--root", ws.root])).toBe(0);
    read();

    const facts = FactsStore.loadOrEmpty(factsPath(ws.root)).facts;
    expect(facts.find((f) => f.supersedes === "F001")?.conflicts_with).toBeUndefined();
    expect(eventsOf(ws).some((e) => e.type === "fact.conflict_raised")).toBe(false);
    expect(parseQuestions(readFileSync(questionsPathOf(ws, "01-what"), "utf8")).blocks).toHaveLength(1);
  });

  test("--supersede still raises against a THIRD live fact that also disagrees", async () => {
    // The head is excluded from the CANDIDATE SET, not filtered out of the
    // result. `findDuplicate` returns the single best hit, and the head is the
    // top hit essentially every time (it is the fact this question already
    // wrote) — so filtering the result discarded every third-fact clash that
    // scored below it. Measured in review: `BEST HIT: F002 0.83 / AFTER SHIPPED
    // SKIP: null — the real clash with F001 is DROPPED`.
    const ws = runWorkspace();
    seedFact(ws, { area: "data-model", fact: "Where does leaderboard state live? — Redis" });
    writeQuestions(ws, "01-what", block("Q1", "Where does leaderboard state live?", "data-model"));

    const read = capture();
    await answerCommand.run(["Q1", "Postgres", "--root", ws.root]);      // F002, clashes with F001
    expect(await answerCommand.run(["Q1", "Memcached", "--supersede", "--root", ws.root])).toBe(0);
    read();

    const facts = FactsStore.loadOrEmpty(factsPath(ws.root)).facts;
    const replacement = facts.find((f) => f.supersedes === "F002");
    // F002 is the head and is not a contradiction. F001 is still live, still in
    // the same area, still clears the threshold, and still disagrees.
    expect(replacement?.conflicts_with).toEqual(["F001"]);
    const raisedOnSupersede = eventsOf(ws).filter((e) => e.type === "fact.conflict_raised");
    expect(raisedOnSupersede).toHaveLength(2);
    expect(raisedOnSupersede[1]?.payload).toMatchObject({ conflicts_with: "F001", raised: "Q3" });
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

  test("the area skip is what makes that null — a claim that DOES overlap past 0.6 is still skipped", () => {
    // The case above is the honest headline, and it is NOT sensitive to the
    // mechanism its comment credits: measured in review, its top score is 0.167,
    // so deleting `findDuplicate`'s `fact.area !== area` guard leaves it green.
    // This one is null for the area reason and ONLY the area reason, and the
    // positive control on the next line is what proves that: identical inputs,
    // one field changed, and the score is well past the threshold.
    const facts = [liveFact({
      id: "F001", area: "data-model", fact: "Where does leaderboard state live? — Redis",
    })];
    const claim = { match: "Where does leaderboard state live?", text: "Postgres" };

    expect(conflictOf({ ...claim, area: "billing" }, facts)).toBeNull();
    const control = conflictOf({ ...claim, area: "data-model" }, facts);
    expect(control?.fact.id).toBe("F001");
    expect(control?.score).toBeGreaterThanOrEqual(CONFLICT_THRESHOLD);
  });
});

describe("advisory: the raise mints an open question that does not stop an unattended run", () => {
  test("the run close still LISTS it, so the disagreement is never silent", async () => {
    const ws = runWorkspace();
    seedFact(ws, { area: "data-model", fact: "Where does leaderboard state live? — Redis" });
    writeQuestions(ws, "01-what", block("Q1", "Where does leaderboard state live?", "data-model"));

    const read = capture();
    await answerCommand.run(["Q1", "Postgres", "--root", ws.root]);
    read();

    // `collectOpenQuestions` is the close's reader and is deliberately NOT
    // advisory-aware: skipping a gate is not the same as hiding a question, and
    // a person reading a close must see what the machine chose not to stop for.
    const open = collectOpenQuestions(ws.runDir);
    expect(open.map((q) => q.id)).toContain("Q2");
    expect(describeOpenQuestions(open) ?? "").toContain("Q2");
  });
});

describe("one spelling of the Jaccard score — the property, not the docstring's claim", () => {
  test("no file outside findDuplicate.ts renders a score with its own toFixed", () => {
    // `formatJaccard` was extracted with a docstring claiming ONE spelling while
    // `renderDistill.ts` — the sibling that mints the very same `Why asked:`
    // sentence off the very same `conflictOf` derivation — still spelled its
    // own. A comment claiming a property the repo does not have is the failure
    // AGENTS §1 names, so the claim is a test now. Scoped to `score.toFixed`
    // deliberately: the 100-odd other `toFixed(2)` calls in `src/` are MONEY,
    // which is a different derivation with its own formatter.
    const offenders = sourceFiles(join(FRAMEWORK_ROOT, "src"))
      .filter((file) => /\bscore\.toFixed\(/i.test(readFileSync(file, "utf8")))
      .map((file) => file.slice(FRAMEWORK_ROOT.length + 1));
    expect(offenders).toEqual(["src/core/facts/findDuplicate.ts"]);
  });
});

describe("the new event type is carried by every reader that walks the log", () => {
  test("replay renders a line for it, and readReviewLedger walks straight past it", async () => {
    const ws = runWorkspace();
    seedFact(ws, { area: "data-model", fact: "Where does leaderboard state live? — Redis" });
    writeQuestions(ws, "01-what", block("Q1", "Where does leaderboard state live?", "data-model"));

    const read = capture();
    await answerCommand.run(["Q1", "Postgres", "--root", ws.root]);
    read();

    // `bullet` ends in `default: return null` (`renderReplay.ts`), so a type with
    // no case renders NO line at all — an honesty guard invisible in `tldrx
    // replay` is a weak guard.
    const loaded = loadRun(ws.root, ws.runId);
    expect(loaded, "the run loads").not.toBeNull();
    const narrative = renderReplay(loaded!);
    // The WHOLE clause, both ids. `toContain("contradicts F001")` alone was
    // structurally incapable of seeing that the line named the ANSWERED question
    // as the one raised — the narrative said "raised as Q1" while Q1 is answered
    // two lines above it, so a reader following it concluded the raise went
    // nowhere.
    expect(narrative).toContain("fact F002 contradicts F001 (Jaccard 0.83) — answering Q1 raised Q2");

    // `readReviewLedger` filters on `payload.story` before it matches on type
    // (`reviewLedger.ts:180`), so an event carrying no story reaches no branch.
    // The pin: a story ledger written AFTER the new event still reads.
    const log = EventLog.forRun(ws.runDir);
    log.tryAppend({
      ts: "2026-09-07T10:00:00Z", run: ws.runId, stage: null, type: "task.started",
      actor: "alan", cost_usd: 0, payload: { story: "S1" },
    });
    log.tryAppend({
      ts: "2026-09-07T10:05:00Z", run: ws.runId, stage: null, type: "task.done",
      actor: "alan", cost_usd: 0, payload: { story: "S1", commit: "abc1234" },
    });
    expect(readReviewLedger(ws.runDir, "S1").commit).toBe("abc1234");
  });

  test("the envelope validates, because EVENT_TYPES is a CLOSED enum", () => {
    // `validateEvent` is the gate, and it is asserted DIRECTLY: `EventLog.read()`
    // would be the wrong instrument — it runs a bare `JSON.parse` per line
    // (`EventLog.ts:112`) and validates nothing, so it reads back an event of any
    // type at all and this assertion would pass with `EVENT_TYPES` untouched.
    // `EventLog.append` is what refuses (`EventLog.ts:35-39`), and `tryAppend`
    // swallows that refusal — which is why an unlisted type is dropped in silence.
    expect(validateEvent({
      ts: "2026-09-07T09:00:00Z", run: "260907-conflicts", stage: null, type: "fact.conflict_raised",
      actor: "alan", cost_usd: 0, payload: { fact: "F002", conflicts_with: "F001", score: 0.83, q: "Q1" },
    }).ok).toBe(true);
    // Both directions: a type genuinely outside the set is still refused, so the
    // assertion above is about this type and not about the enum having gone open.
    expect(validateEvent({
      ts: "2026-09-07T09:00:00Z", run: "260907-conflicts", stage: null, type: "fact.not_a_type",
      actor: "alan", cost_usd: 0, payload: {},
    }).ok).toBe(false);
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
    const plain = liveFact({ id: "F001", fact: "A — B", area: "data-model" });
    const emitted = emitFactsYaml({ version: 1, facts: [plain] });
    expect(emitted).not.toContain("conflicts_with");
    // An EMPTY list emits nothing either — on disk it would claim a check ran and
    // cleared the row, which is exactly what absence must not be read as.
    expect(emitFactsYaml({ version: 1, facts: [{ ...plain, conflicts_with: [] }] })).toBe(emitted);
  });

  test("a facts.yml written before the key existed still validates, and an empty list does not", () => {
    const row = {
      id: "F001", fact: "A — B", area: "data-model", repos: [], kind: "answer",
      confidence: "stated", source: { who: "t", when: "2026-09-07T00:00:00Z", run: null, q: null },
      supersedes: null, superseded_by: null, retired: null,
    };
    expect(validateFactsFile({ version: 1, facts: [row] }).ok).toBe(true);

    const empty = validateFactsFile({ version: 1, facts: [{ ...row, conflicts_with: [] }] });
    expect(empty.ok).toBe(false);
    expect(empty.issues).toContainEqual({
      path: "facts[0].conflicts_with",
      message: "expected at least one fact id, or the key absent",
    });

    const wrong = validateFactsFile({ version: 1, facts: [{ ...row, conflicts_with: [7] }] });
    expect(wrong.ok).toBe(false);
    expect(wrong.issues.some((i) => i.path === "facts[0].conflicts_with[0]")).toBe(true);
  });
});
