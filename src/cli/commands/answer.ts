/** `tldrx answer` — Answer an open interview question
 *
 * Spec §3. The terminal counterpart of the `answer-capture` hook, and literally the
 * same code path (`src/core/answers/`): fill the `[Answer]:` slot, then flip the
 * status, append the footer, append the fact with its provenance, and append the
 * `question.answered` + `fact.added` events. The questions file is the contract;
 * the channel — editor or terminal — is not.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "../Command.ts";
import { EXIT_NOT_FOUND, EXIT_OK, EXIT_USAGE } from "../exitCodes.ts";
import { parseArgs, stringFlag, UsageError } from "../argv.ts";
import { workspaceRootFrom } from "../workspace.ts";
import { fail } from "../report.ts";
import { RunStore } from "../../core/run/RunStore.ts";
import { captureAnswers, writeAnswerSlot } from "../../core/answers/captureAnswers.ts";
import { currentActor, nowRfc3339 } from "../../hooks/lib/actor.ts";
import { parseQuestions } from "../../core/text/questions.ts";
import { readFileSync } from "node:fs";

const QUESTION_ID_RE = /^Q\d{1,6}$/;

export const answerCommand: Command = {
  name: "answer",
  summary: "Answer an open interview question",
  usage: "tldrx answer <Qid> <text> [--run <id>] [--root <path>]",
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
      const store = RunStore.find(root, wanted);
      if (store === null) {
        process.stderr.write(
          `tldrx answer: ${wanted === undefined ? "no non-terminal run" : `no run '${wanted}'`} in tldrx-work/\n`,
        );
        return EXIT_NOT_FOUND;
      }

      const path = locateQuestion(store, qid);
      if (path === null) {
        process.stderr.write(`tldrx answer: ${qid} is not an open question in run ${store.runId}\n`);
        return EXIT_NOT_FOUND;
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

/** The phase questions.md that holds `qid` as an OPEN block, or null. */
function locateQuestion(store: RunStore, qid: string): string | null {
  for (const phase of store.run.phases) {
    const path = join(store.runDir, phase.id, "questions.md");
    if (!existsSync(path)) continue;
    const block = parseQuestions(readFileSync(path, "utf8")).blocks.find((b) => b.id === qid);
    if (block !== undefined && block.metadata?.status === "open") return path;
  }
  return null;
}
