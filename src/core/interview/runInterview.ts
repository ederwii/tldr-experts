/**
 * The interview loop: ask the open questions of one `questions.md`, in order.
 *
 * The recording is NOT re-implemented here. Every answer goes through
 * `writeAnswerSlot` + `captureAnswers` — literally the functions `tldrx answer`
 * and the `answer-capture` hook call — so a question answered in the terminal, in
 * an editor, or by Claude Code writing the file lands as the same footer, the same
 * `facts.yml` row and the same two events. Spec §2.7 calls the questions file the
 * contract and the channel not the contract; this is a third channel over the same
 * contract.
 *
 * The loop stops on `q`, and on end of input. Neither is a failure: an unanswered
 * question stays `status: open` and the run stays exactly where it was.
 */
import { existsSync, readFileSync } from "node:fs";
import { captureAnswers, writeAnswerSlot, type CaptureContext, type CapturedAnswer } from "../answers/captureAnswers.ts";
import { openBlocks, parseQuestions } from "../text/questions.ts";
import { defaultReply, interpret } from "./reply.ts";
import { renderQuestion } from "./renderQuestion.ts";
import type { LineReader } from "./lineReader.ts";

export class InterviewError extends Error {}

export interface InterviewOptions {
  readonly questionsPath: string;
  /** Answer every question with its option A instead of reading stdin. */
  readonly yesToDefaults: boolean;
  readonly ctx: CaptureContext;
  readonly reader: LineReader;
  readonly out: (text: string) => void;
}

export interface InterviewResult {
  readonly open: number;
  readonly answered: readonly CapturedAnswer[];
  readonly skipped: number;
  /** True when the human typed `q`. */
  readonly quit: boolean;
  /** True when stdin ran out before the last question. */
  readonly exhausted: boolean;
}

export function runInterview(options: InterviewOptions): Promise<InterviewResult> {
  return interview(options);
}

async function interview(options: InterviewOptions): Promise<InterviewResult> {
  const { questionsPath, out, ctx } = options;
  if (!existsSync(questionsPath)) throw new InterviewError(`no questions file at ${questionsPath}`);

  const blocks = openBlocks(parseQuestions(readFileSync(questionsPath, "utf8")).blocks);
  const answered: CapturedAnswer[] = [];
  let skipped = 0;
  let quit = false;
  let exhausted = false;

  for (const [index, block] of blocks.entries()) {
    out(renderQuestion(block, index + 1, blocks.length));
    const reply = options.yesToDefaults
      ? defaultReply(block)
      : interpret(await options.reader.next(), block);

    if (reply.kind === "eof") { exhausted = true; out("\n"); break; }
    if (reply.kind === "quit") { quit = true; out("\n"); break; }
    if (reply.kind === "skip") { skipped++; out(options.yesToDefaults ? "(no options — skipped)\n" : "\n"); continue; }
    if (reply.kind === "unknown-option") {
      skipped++;
      const letters = block.options.map((o) => o.letter).join("/");
      out(`\n  ${block.id} offers no option ${reply.letter} (only ${letters}) — skipped, nothing recorded.\n`);
      continue;
    }

    // Piped stdin does not echo, so the answer line ends here either way.
    out(options.yesToDefaults ? `${reply.option ?? "?"}\n` : "\n");
    writeAnswerSlot(questionsPath, block.id, reply.text);
    const captured = captureAnswers(questionsPath, ctx);
    const mine = captured.find((c) => c.q === block.id);
    if (mine === undefined) {
      throw new InterviewError(`${block.id} was written to ${questionsPath} but not captured — check the file`);
    }
    answered.push(mine);
    out(`  recorded ${mine.q} → ${mine.fact} (area ${mine.area})\n`);
  }

  return { open: blocks.length, answered, skipped, quit, exhausted };
}

/** The closing line: what happened, in one sentence. */
export function renderInterviewSummary(result: InterviewResult): string {
  if (result.open === 0) return "No open questions.\n";
  const left = result.open - result.answered.length;
  const why = result.quit ? " (quit)" : result.exhausted ? " (input ended)" : "";
  return `${result.answered.length} of ${result.open} answered, ${left} still open${why}.\n`;
}
