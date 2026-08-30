/**
 * `.tldrx/init-questions.md` — the Interview step (concept §4.4), in the exact
 * §2.7 block format.
 *
 * Only real gaps become questions. Every question is TEMPLATED from something
 * detection could not establish, and its `Why asked:` line ends with the token
 * that proves the gap is real — an `absent:` path, or the file that stops short
 * of answering it. Nothing here is invented to look thorough.
 *
 * `init` writes the file and stops. Capturing answers is the answer-capture
 * hook's job, not this command's.
 */
import { srcToken } from "../map/srcToken.ts";
import { gapSrc } from "../detect/gapSrc.ts";
import { isGreenfield } from "../detect/greenfield.ts";
import { STACK_CHOICES } from "./stackChoices.ts";
import type { Methodology, TicketTool } from "../schemas/process.ts";
import type { DetectedWorkspace } from "../detect/types.ts";
import type { McpServer } from "../doctor/McpProbe.ts";

export const QUESTIONS_FILE = ".tldrx/init-questions.md";
export const MAX_QUESTIONS = 12;
const LETTERS = ["A", "B", "C", "D", "E"] as const;

export interface Question {
  readonly id: string;
  readonly area: string;
  readonly question: string;
  readonly why: string;
  /** `src` payload proving the gap. */
  readonly whySrc: string;
  /** 2–5 options; the last one is normally free text. */
  readonly options: readonly string[];
}

export interface QuestionInput {
  readonly workspace: DetectedWorkspace;
  /** True when `--process` already settled the methodology. */
  readonly processGiven: boolean;
  readonly mcpServers: readonly McpServer[];
  /** True when `--stack` already settled the intended stack. */
  readonly stackGiven?: boolean;
}

/**
 * The two process questions, and what each offered option settles in
 * `.tldrx/process.yml`.
 *
 * The tables are the single source of truth for BOTH directions: `planQuestions`
 * renders the labels, and `applyProcessAnswers` maps a recorded answer back to a
 * `methodology:` / `ticket_tool.kind:` value. Keeping them in one place is what
 * stops the rendered wording and the mapping from drifting apart.
 *
 * `None` is deliberately option **A** in both. `--yes-to-defaults` takes option A
 * (`interview/reply.ts`), and the default a machine picks must be the one that
 * commits the team to nothing — a real user was handed `scrum` + `jira` by a flag
 * whose whole point was "do not decide for me". `other` stays last: it is free
 * text, so it maps to nothing and leaves the file alone.
 */
export const METHODOLOGY_QUESTION = "How does this team plan work?";
export const TICKET_QUESTION = "Which ticket tool should stories mirror out to?";

export interface ProcessChoice<T> {
  readonly label: string;
  /** The `process.yml` value this option settles, or `null` for free text. */
  readonly value: T | null;
}

export const METHODOLOGY_CHOICES: readonly ProcessChoice<Methodology>[] = [
  { label: "None — a plain ordered list of stories", value: "none" },
  { label: "Scrum — fixed-length sprints", value: "scrum" },
  { label: "Kanban — continuous flow with a WIP limit", value: "kanban" },
  { label: "Shape Up — appetite-driven cycles", value: "shape-up" },
  { label: "other — write it below", value: null },
];

export const TICKET_CHOICES: readonly ProcessChoice<TicketTool>[] = [
  { label: "None — files are the only record", value: "none" },
  { label: "Jira — write the project key below", value: "jira" },
  { label: "GitHub Issues", value: "github" },
  { label: "Linear", value: "linear" },
  { label: "other — write it below", value: null },
];

/** The gaps, in a fixed order so question ids are stable across runs. */
export function planQuestions(input: QuestionInput): Question[] {
  const questions: Omit<Question, "id">[] = [];

  // Greenfield first: on a workspace with no code, these two answers decide what
  // gets seeded and what the first run reads. Everything below them is about a
  // codebase that does not exist yet.
  if (isGreenfield(input.workspace)) {
    const repo = input.workspace.repos[0];
    if (repo !== undefined && input.stackGiven !== true) {
      questions.push({
        area: "stack",
        question: "Which stack will this project use?",
        why: "no code file and no build manifest exist in this workspace, so the stack cannot be detected",
        whySrc: gapSrc(repo),
        options: [
          ...STACK_CHOICES.map((choice) => choice.label),
          "other — write it below (e.g. `rust`, `java`, `kotlin`, or several, comma-separated)",
        ],
      });
    }
    questions.push({
      area: "requirements",
      question: "Which single document is the source of requirements?",
      why: "there is no code to read, so the first run has nothing to distil unless a document is named",
      whySrc: "absent:.tldrx/memory/facts.yml",
      options: [
        "There is no document yet — the run will start from a description instead",
        "other — write the path below, then start the run with "
          + "`tldrx run new <slug> --seed <path>`",
      ],
    });
  }

  if (!input.processGiven) {
    questions.push({
      area: "process",
      question: METHODOLOGY_QUESTION,
      why: "no process model is recorded and none was passed with --process",
      whySrc: "absent:.tldrx/process.yml",
      options: METHODOLOGY_CHOICES.map((choice) => choice.label),
    });
    questions.push({
      area: "process",
      question: TICKET_QUESTION,
      why: ticketWhy(input.mcpServers),
      whySrc: "absent:.tldrx/process.yml",
      options: ticketOptions(input.mcpServers),
    });
  }

  for (const repo of input.workspace.repos) {
    if (repo.confidence !== "low") continue;
    questions.push({
      area: "commands",
      question: `How is \`${repo.name}\` built and tested?`,
      why: `detection found no build manifest or scripts in \`${repo.path}\`, so its commands are unknown`,
      whySrc: gapSrc(repo),
      options: [
        "There is no build or test for this repo — treat it as docs/config only",
        "other — write the exact commands below, one per line",
      ],
    });
  }

  for (const repo of input.workspace.repos) {
    questions.push({
      area: "ownership",
      question: `Who owns \`${repo.name}\`?`,
      why: "ownership cannot be read from the filesystem and nothing is recorded yet",
      whySrc: "absent:.tldrx/memory/facts.yml",
      options: ["I own it", "other — write the owner's name below"],
    });
  }

  questions.push({
    area: "dead-code",
    question: "Which paths are dead code that experts should ignore?",
    why: "the map lists every source folder it found; it cannot tell which ones are abandoned",
    whySrc: "absent:.tldrx/memory/facts.yml",
    options: ["None that I know of", "other — write the paths below, one per line"],
  });

  return questions.slice(0, MAX_QUESTIONS).map((question, index) => ({ ...question, id: `Q${index + 1}` }));
}

export function renderQuestions(questions: readonly Question[], askedAt: string): string {
  const lines: string[] = [
    "# Questions — init — workspace install",
    "",
    "> Every question below exists because something could NOT be detected; the `Why asked:`",
    "> line cites the gap. Answer them with `tldrx interview --init`, which records each",
    "> answer as a fact and writes `.tldrx/process.yml`. Typing after `[Answer]:` here fills",
    "> the slot but records NEITHER — nothing watches this file. Answer any subset;",
    "> unanswered questions stay open and the workspace still works.",
    "",
  ];

  for (const question of questions) {
    lines.push(`## ${question.id} · ${question.question}`);
    lines.push(
      `<!-- id: ${question.id} | status: open | area: ${question.area} | asked_by: facilitator | asked_at: ${askedAt} -->`,
    );
    lines.push(`Why asked: ${question.why} ${srcToken([question.whySrc])}`);
    lines.push("");
    question.options.slice(0, LETTERS.length).forEach((option, index) => {
      lines.push(`- ${LETTERS[index]}) ${option}`);
    });
    lines.push("");
    lines.push("[Answer]:");
    lines.push("");
  }
  return lines.join("\n");
}

function ticketWhy(servers: readonly McpServer[]): string {
  const suggestion = suggestTicketTool(servers);
  return suggestion === null
    ? "no ticket tool is recorded; MCP servers were not probed (`--mcp` is off by default)"
    : `an MCP server for ${suggestion} is connected, which is a suggestion and not a decision`;
}

/**
 * The offered labels, in table order, with the MCP hint appended to the one it
 * points at. The hint is a suffix and never a reorder: `--yes-to-defaults` must
 * keep landing on `None`, whatever happens to be connected.
 */
function ticketOptions(servers: readonly McpServer[]): string[] {
  const suggestion = suggestTicketTool(servers);
  return TICKET_CHOICES.map(({ label }) =>
    suggestion !== null && label.toLowerCase().startsWith(suggestion)
      ? `${label} (MCP server connected)`
      : label);
}

/** Which ticket tool the connected MCP servers hint at. Suggestion only (concept v0.2). */
export function suggestTicketTool(servers: readonly McpServer[]): string | null {
  for (const [needle, tool] of [["atlassian", "jira"], ["jira", "jira"], ["github", "github"], ["linear", "linear"]] as const) {
    if (servers.some((server) => server.name.toLowerCase().includes(needle))) return tool;
  }
  return null;
}
