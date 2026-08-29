/**
 * How one question looks in a terminal.
 *
 * The `Why asked:` line is not decoration and is never trimmed away: it is the
 * evidence that the question is a real gap and not the framework padding an
 * interview (concept §1.2, spec §2.7). If a question cannot say why it exists,
 * that shows here.
 */
import type { QuestionBlock } from "../text/questions.ts";

export const PROMPT_SUFFIX = "[A-E · free text · s=skip · q=quit] > ";

export function renderQuestion(block: QuestionBlock, index: number, total: number): string {
  const lines = [
    "",
    `(${index}/${total}) ${block.id} · ${block.title}`,
  ];
  if (block.whyAsked !== null) lines.push(`      Why asked: ${block.whyAsked}`);
  for (const option of block.options) lines.push(`      ${option.letter}) ${option.text}`);
  lines.push("");
  return `${lines.join("\n")}${PROMPT_SUFFIX}`;
}

/** The two commands that come next, printed however the interview ended. */
export function renderNextSteps(hasRun: boolean): string {
  return hasRun
    ? "\nNext: `tldrx next` to run the next stage · `tldrx run status` for where the run is.\n"
    : "\nNext: `tldrx run new <slug> --scope feature` to open a run · `tldrx run status` once it exists.\n";
}
