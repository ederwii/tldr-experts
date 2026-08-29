/**
 * A `.tldrx/init-questions.md` holding the two real process questions.
 *
 * Built from the shipped tables and the shipped renderer, never from hand-typed
 * labels: a test that restates the wording would keep passing after the wording
 * changed, which is exactly the drift these tests exist to catch.
 */
import {
  METHODOLOGY_CHOICES, METHODOLOGY_QUESTION, TICKET_CHOICES, TICKET_QUESTION,
  renderQuestions, type Question,
} from "../../src/core/init/questions.ts";

export const PROCESS_QUESTIONS: readonly Question[] = [
  {
    id: "Q1",
    area: "process",
    question: METHODOLOGY_QUESTION,
    why: "no process model is recorded and none was passed with --process",
    whySrc: "absent:.tldrx/process.yml",
    options: METHODOLOGY_CHOICES.map((choice) => choice.label),
  },
  {
    id: "Q2",
    area: "process",
    question: TICKET_QUESTION,
    why: "no ticket tool is recorded; MCP servers were not probed",
    whySrc: "absent:.tldrx/process.yml",
    options: TICKET_CHOICES.map((choice) => choice.label),
  },
];

export function initQuestionsFile(askedAt = "2026-08-29T09:00:00Z"): string {
  return renderQuestions(PROCESS_QUESTIONS, askedAt);
}

/** The letter that answers `question` with `label` — so a test never hard-codes `C`. */
export function letterFor(questionId: "Q1" | "Q2", label: string): string {
  const question = PROCESS_QUESTIONS.find((entry) => entry.id === questionId);
  const index = question?.options.indexOf(label) ?? -1;
  if (index === -1) throw new Error(`${questionId} does not offer "${label}"`);
  return "ABCDE"[index] ?? "";
}
