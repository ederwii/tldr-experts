/**
 * `tldrx seed answer <split.yml> <Qid> "<text>"` — record a decision on a proposal.
 *
 * A `split.yml` could always be edited: delete a run you disagree with, change a
 * scope, move a seed. Its `questions:` were the one part with nowhere to put the
 * reply — the model asked, a human read, and the answer lived in someone's head
 * until `seed apply` created runs that did not reflect it. This writes it down,
 * beside the question, in the file the split already is.
 *
 * The file is parsed, validated and re-emitted whole rather than patched in place:
 * `emitSplitYaml` is the only writer of this format, and a targeted line edit
 * would be a second one that drifts. A file that does not validate is refused
 * BEFORE anything is written, so an answer never turns a readable proposal into
 * an unreadable one.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseYaml } from "../yaml.ts";
import { splitUniverse } from "./applySplit.ts";
import {
  emitSplitYaml, knownScopes, readSplitFile, renderSplitMarkdown, validateProposal,
  SplitError, SPLIT_MD, type SplitFile, type SplitQuestion,
} from "./splitFile.ts";

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_NOT_FOUND = 3;

export interface AnswerSplitOptions {
  readonly root: string;
  /** `<split.yml>` as typed; a relative path resolves against the CWD. */
  readonly splitPath: string;
  readonly id: string;
  readonly text: string;
}

export interface AnswerSplitOutcome {
  readonly code: number;
  readonly lines: readonly string[];
}

export function answerSplitQuestion(options: AnswerSplitOptions): AnswerSplitOutcome {
  const trimmed = options.text.trim();
  if (trimmed === "") return { code: EXIT_USAGE, lines: ["the answer is empty — nothing was written"] };

  const path = isAbsolute(options.splitPath) ? options.splitPath : resolve(process.cwd(), options.splitPath);
  if (!existsSync(path)) return { code: EXIT_NOT_FOUND, lines: [`no such file: ${options.splitPath}`] };

  let file: SplitFile;
  try {
    file = readSplitFile(parseYaml(readFileSync(path, "utf8")));
  } catch (error) {
    return { code: EXIT_USAGE, lines: [error instanceof SplitError ? error.message : message(error)] };
  }

  const validation = validateProposal(file, {
    rels: splitUniverse(path, file),
    scopes: knownScopes(options.root),
  });
  if (!validation.ok || validation.proposal === null) {
    return {
      code: EXIT_USAGE,
      lines: [
        `${options.splitPath} does not validate — ${String(validation.issues.length)} problem(s); nothing was written`,
        ...validation.issues.map((issue) => `  ${issue}`),
      ],
    };
  }

  const questions = validation.proposal.questions;
  const target = questions.find((question) => question.id === options.id);
  if (target === undefined) {
    return {
      code: EXIT_NOT_FOUND,
      lines: [
        `${options.splitPath} has no question '${options.id}'`,
        questions.length === 0
          ? "  it asks no questions at all"
          : `  it asks: ${questions.map((question) => question.id).join(", ")}`,
      ],
    };
  }
  const previous = target.answer;

  const answered: SplitFile = {
    ...file,
    ...validation.proposal,
    questions: questions.map((question): SplitQuestion =>
      question.id === options.id ? { ...question, answer: trimmed } : question),
  };
  writeFileSync(path, emitSplitYaml(answered), "utf8");
  const markdown = join(dirname(path), SPLIT_MD);
  if (existsSync(markdown)) {
    writeFileSync(markdown, renderSplitMarkdown(answered, reference(options.root, dirname(path))), "utf8");
  }

  const open = answered.questions.filter((question) => question.answer === undefined).length;
  return {
    code: EXIT_OK,
    lines: [
      `${options.id} answered in ${options.splitPath}: ${trimmed}`,
      ...(previous === undefined ? [] : [`  it previously said: ${previous}`]),
      open === 0
        ? "every question on this split is answered — edit the runs if the answers change them, then `tldrx seed apply`"
        : `${String(open)} question(s) still open on this split`,
    ],
  };
}

/** Workspace-relative when the file is inside the root, absolute when it is not. */
function reference(root: string, path: string): string {
  const rel = relative(root, path);
  return rel === "" || rel.startsWith("..") ? path : rel.split("\\").join("/");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
