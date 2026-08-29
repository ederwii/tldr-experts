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
}

/** The gaps, in a fixed order so question ids are stable across runs. */
export function planQuestions(input: QuestionInput): Question[] {
  const questions: Omit<Question, "id">[] = [];

  if (!input.processGiven) {
    questions.push({
      area: "process",
      question: "How does this team plan work?",
      why: "no process model is recorded and none was passed with --process",
      whySrc: "absent:.tldrx/process.yml",
      options: [
        "Scrum — fixed-length sprints",
        "Kanban — continuous flow with a WIP limit",
        "Shape Up — appetite-driven cycles",
        "None — a plain ordered list of stories",
        "other — write it below",
      ],
    });
    questions.push({
      area: "process",
      question: "Which ticket tool should stories mirror out to?",
      why: ticketWhy(input.mcpServers),
      whySrc: "absent:.tldrx/process.yml",
      options: [...ticketOptions(input.mcpServers), "None — files are the only record", "other — write it below"],
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
    "> line cites the gap. Answer any subset by writing after `[Answer]:` — unanswered",
    "> questions stay open and the workspace still works.",
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

function ticketOptions(servers: readonly McpServer[]): string[] {
  const suggestion = suggestTicketTool(servers);
  const options = ["Jira — write the project key below", "GitHub Issues", "Linear"];
  if (suggestion === null) return options;
  return options.map((option) =>
    option.toLowerCase().startsWith(suggestion) ? `${option} (MCP server connected)` : option);
}

/** Which ticket tool the connected MCP servers hint at. Suggestion only (concept v0.2). */
export function suggestTicketTool(servers: readonly McpServer[]): string | null {
  for (const [needle, tool] of [["atlassian", "jira"], ["jira", "jira"], ["github", "github"], ["linear", "linear"]] as const) {
    if (servers.some((server) => server.name.toLowerCase().includes(needle))) return tool;
  }
  return null;
}
