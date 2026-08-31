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
import { boolFlag, parseArgs, stringFlag, UsageError } from "../argv.ts";
import { workspaceRootFrom } from "../workspace.ts";
import { fail } from "../report.ts";
import { RunStore } from "../../core/run/RunStore.ts";
import { isResolved, resolveRunOrExplain } from "../resolveRun.ts";
import { captureAnswers, supersedeAnswer, writeAnswerSlot } from "../../core/answers/captureAnswers.ts";
import { currentActor, nowRfc3339 } from "../../hooks/lib/actor.ts";
import { parseQuestions, type QuestionBlock } from "../../core/text/questions.ts";
import { readFileSync } from "node:fs";

const QUESTION_ID_RE = /^Q\d{1,6}$/;

export const answerCommand: Command = {
  name: "answer",
  summary: "Answer an open interview question",
  usage: "tldrx answer <Qid> <text> [--supersede] [--run <id>] [--root <path>]",
  subcommands: [],
  implemented: true,
  async run(argv: readonly string[]): Promise<number> {
    try {
      const args = parseArgs(argv, ["run", "root"]);
      const [qid, ...words] = args.positionals;
      if (qid === undefined || !QUESTION_ID_RE.test(qid)) {
        throw new UsageError("answer needs a question id: `tldrx answer Q4 \"the answer\"`");
      }
      const text = words.join(" ").trim();
      if (text === "") throw new UsageError(`answer ${qid} needs the answer text`);

      const root = workspaceRootFrom(args);
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
        });
        process.stdout.write(
          `${qid} superseded → ${done.fact} replaces ${done.supersedes} (area ${done.area}) in ${path}\n`,
        );
        return EXIT_OK;
      }

      writeAnswerSlot(path, qid, text);
      const captured = captureAnswers(path, {
        root,
        runDir: store.runDir,
        run: store.runId,
        actor: currentActor(),
        at: nowRfc3339(),
      });
      const recorded = captured.find((c) => c.q === qid);
      if (recorded === undefined) {
        process.stderr.write(`tldrx answer: ${qid} was written but not captured — check ${path}\n`);
        return EXIT_USAGE;
      }
      process.stdout.write(`${qid} answered → ${recorded.fact} (area ${recorded.area}) in ${path}\n`);
      return EXIT_OK;
    } catch (error) {
      return fail("answer", error);
    }
  },
};

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
