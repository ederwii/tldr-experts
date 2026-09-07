/** `tldrx answer` — Answer an open interview question
 *
 * Spec §3. The terminal counterpart of the `answer-capture` hook, and literally the
 * same code path (`src/core/answers/`): fill the `[Answer]:` slot, then flip the
 * status, append the footer, append the fact with its provenance, and append the
 * `question.answered` + `fact.added` events. The questions file is the contract;
 * the channel — editor or terminal — is not.
 *
 * `--supersede` is the same command pointed the other way: an owner REVERSING a
 * decision this question already recorded. Without it, answering an answered
 * question is refused, and that refusal is right — an answer is recorded once.
 * With it, the old fact keeps its text and gains `superseded_by`, a new fact
 * carries the new answer, and both the questions block and `events.jsonl` gain a
 * line. Measured 2026-08-31: `superseded_by` had been in the §2.5 schema from the
 * first draft with no command that wrote it, so the only way to reverse a
 * decision was a hand edit — and a hand edit that left `superseded_by: null` left
 * the reversed decision in `FactsStore.active`, which is never-re-ask truth.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "../Command.ts";
import { EXIT_NOT_FOUND, EXIT_OK, EXIT_USAGE } from "../exitCodes.ts";
import { boolFlag, parseArgs, repeatedFlag, stringFlag, UsageError } from "../argv.ts";
import { workspaceRootFrom } from "../workspace.ts";
import { fail } from "../report.ts";
import { RunStore } from "../../core/run/RunStore.ts";
import { isResolved, resolveRunOrExplain } from "../resolveRun.ts";
import {
  captureAnswers, supersedeAnswer, unresolvedEntries, writeAnswerSlot, type AnswerOverride,
} from "../../core/answers/captureAnswers.ts";
import { FACT_DECIDERS, type FactDecider } from "../../core/facts/Fact.ts";
import { uniqueRepos } from "../../core/answers/reposFromAffects.ts";
import { loadWorkspace } from "../../hooks/lib/workspace.ts";
import { currentActor, nowRfc3339 } from "../../hooks/lib/actor.ts";
import { parseQuestions, type QuestionBlock } from "../../core/text/questions.ts";
import { readFileSync } from "node:fs";

const QUESTION_ID_RE = /^Q\d{1,6}$/;

export const answerCommand: Command = {
  name: "answer",
  summary: "Answer an open interview question",
  usage: "tldrx answer <Qid> <text> [--supersede] [--decided-by <who>] [--repo <name>] [--run <id>] [--root <path>]",
  implemented: true,
  async run(argv: readonly string[]): Promise<number> {
    try {
      const args = parseArgs(argv, ["run", "root", "decided-by", "repo"]);
      const [qid, ...words] = args.positionals;
      if (qid === undefined || !QUESTION_ID_RE.test(qid)) {
        throw new UsageError("answer needs a question id: `tldrx answer Q4 \"the answer\"`");
      }
      const text = words.join(" ").trim();
      if (text === "") throw new UsageError(`answer ${qid} needs the answer text`);

      const root = workspaceRootFrom(args);

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
      const wantedRepos = uniqueRepos(repeatedFlag(args, "repo"));
      for (const repo of wantedRepos) {
        if (!repoNames.has(repo)) {
          // A workspace with no declared repos is its own sentence: "— it has "
          // with nothing after it reads as a truncated message, not as an answer.
          throw new UsageError(
            `--repo ${repo} is not a repo in this workspace — `
            + (repoNames.size === 0
              ? "this workspace declares no repos"
              : `it has ${[...repoNames].join(", ")}`),
          );
        }
      }
      const overrides = new Map<string, AnswerOverride>([[qid, {
        ...(decidedBy === undefined ? {} : { decidedBy: decidedBy as FactDecider }),
        ...(wantedRepos.length === 0 ? {} : { repos: wantedRepos }),
      }]]);

      const wanted = stringFlag(args, "run");
      const resolved = resolveRunOrExplain("tldrx answer", root, wanted);
      if (!isResolved(resolved)) return resolved.exit;
      const store = resolved.store;

      const supersede = boolFlag(args, "supersede");
      const found = locateQuestion(store, qid, supersede ? "answered" : "open");
      if (found === null) {
        // Two different mistakes, and saying which one it is saves a round trip:
        // `--supersede` on a question nobody has answered yet has nothing to
        // reverse, and a plain answer on an answered one is the refusal that has
        // always stood — now with the way through named.
        const other = locateQuestion(store, qid, supersede ? "open" : "answered");
        if (other !== null) {
          process.stderr.write(supersede
            ? `tldrx answer: ${qid} is open — nothing to supersede. Answer it normally: `
              + `\`tldrx answer ${qid} "…"\`\n`
            : `tldrx answer: ${qid} is already answered in run ${store.runId}. To REVERSE that `
              + `decision, pass --supersede — it keeps the old fact and records a new one.\n`);
          return supersede ? EXIT_USAGE : EXIT_NOT_FOUND;
        }
        process.stderr.write(
          `tldrx answer: ${qid} is not ${supersede ? "an answered" : "an open"} question in run ${store.runId}\n`,
        );
        return EXIT_NOT_FOUND;
      }
      const { path } = found;

      if (supersede) {
        const done = supersedeAnswer(path, qid, text, {
          root,
          runDir: store.runDir,
          run: store.runId,
          actor: currentActor(),
          at: nowRfc3339(),
          overrides,
          repoNames,
        });
        process.stdout.write(
          `${qid} superseded → ${done.fact} replaces ${done.supersedes} (area ${done.area}) in ${path}\n`,
        );
        sayWhatWasNotStated(decidedBy, [done]);
        return EXIT_OK;
      }

      writeAnswerSlot(path, qid, text);
      const captured = captureAnswers(path, {
        root,
        runDir: store.runDir,
        run: store.runId,
        actor: currentActor(),
        at: nowRfc3339(),
        overrides,
        repoNames,
      });
      const recorded = captured.find((c) => c.q === qid);
      if (recorded === undefined) {
        process.stderr.write(`tldrx answer: ${qid} was written but not captured — check ${path}\n`);
        return EXIT_USAGE;
      }
      process.stdout.write(`${qid} answered → ${recorded.fact} (area ${recorded.area}) in ${path}\n`);
      // EVERY block this invocation captured, not just `recorded` — the sweep's
      // blocks have unresolved entries too, and they are the reader's only clue.
      sayWhatWasNotStated(decidedBy, captured);
      return EXIT_OK;
    } catch (error) {
      return fail("answer", error);
    }
  },
};

/**
 * Say, on stdout, what this invocation did NOT state — absent-with-reason.
 *
 * The reason a fact carries no decider cannot live in the row: a second field
 * would only re-derive `decided_by !== undefined`, and could contradict it. So
 * it is said where a person can act on it, in the same breath as the fact id.
 *
 * The same goes for an `affects:` entry shaped `repo:path` that matched no repo:
 * `repos: []` after one of those would read as "no repo was named" when one WAS
 * named and was wrong.
 *
 * It takes EVERY block the invocation captured, not just the one it named. A
 * `tldrx answer` sweeps every answered-but-uncaptured block in the file, and
 * until fix round 1 the swept ones had their unresolved entries computed and
 * dropped — while `helpText.ts` and the guide both promised they were named.
 * Every line carries its question id, so "which row is this about" is never
 * inferred from position.
 */
function sayWhatWasNotStated(
  decidedBy: string | undefined,
  captured: readonly { readonly q: string; readonly unresolvedAffects: readonly string[] }[],
): void {
  if (decidedBy === undefined) {
    process.stdout.write(
      `  no decider recorded — this invocation passed no --decided-by, so the fact says `
      + `"not stated", which is never read as "owner"\n`,
    );
  }
  for (const entry of unresolvedEntries(captured)) {
    process.stdout.write(`  ${entry}\n`);
  }
}

/** The phase questions.md that holds `qid` in `status`, with the block, or null. */
function locateQuestion(
  store: RunStore,
  qid: string,
  status: string,
): { path: string; block: QuestionBlock } | null {
  for (const phase of store.run.phases) {
    const path = join(store.runDir, phase.id, "questions.md");
    if (!existsSync(path)) continue;
    const block = parseQuestions(readFileSync(path, "utf8")).blocks.find((b) => b.id === qid);
    if (block !== undefined && block.metadata?.status === status) return { path, block };
  }
  return null;
}
