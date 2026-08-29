/**
 * Applying the install interview's two process answers to `.tldrx/process.yml`.
 *
 * Before this, `tldrx interview --init` recorded "we use Kanban, mirror to GitHub"
 * as a `facts.yml` row and nothing else: the file `tldrx tickets` reads
 * (`adapters/processConfig.ts`) still said `methodology: none` / `kind: none`, so
 * the answer was written down and then ignored. An answer that changes nothing is
 * worse than no question — it reads as a decision the tool took and did not honour.
 *
 * Three rules the implementation is built around:
 *
 *  1. **Only an offered option decides anything.** A recorded answer is matched
 *     against the label tables in `questions.ts`; free text ("other") maps to
 *     nothing, leaves the file untouched, and prints a note telling the human which
 *     key to set. Guessing `methodology` out of prose would put an invented value
 *     in the one file that is meant to be data, never an assumption (spec §2.12).
 *  2. **Preserve everything else.** The file is parsed, two keys are patched, and
 *     it is re-serialised — `cadence`, `approvers`, `dod`, `source` and any hand
 *     added key survive, and the leading comment header is carried over verbatim.
 *     Both shapes on disk are handled: the nested §2.12 shape that `init` writes,
 *     and the flat draft in `templates/process.yml`. Which one is on disk is
 *     preserved; this is not the place to reconcile them (spec §14 open item).
 *  3. **Idempotent.** Nothing is written when the bytes would not change, so a
 *     second interview over the same answers is a no-op, and a hand-formatted file
 *     is never reflowed for nothing.
 *
 * `[assumption]` — `ticket_tool.kind: jira` is written with `project: null`, which
 * `validateEmitted.validateProcessDocument` would reject ("project required unless
 * kind is none"). The alternative is refusing the answer the human just gave. The
 * note says which key to fill, and `tldrx tickets sync` refuses by name until it is
 * — a loud, recoverable gap rather than a silently dropped decision. The values
 * this module writes are otherwise checked against the shipped enums before any
 * write (`assertEnum` below), so a bad `methodology` can never reach disk.
 */
import { existsSync, readFileSync } from "node:fs";
import { parseQuestions } from "../text/questions.ts";
import { parseYaml, stringifyYaml } from "../yaml.ts";
import { runtime } from "../runtime/index.ts";
import { processPath } from "../adapters/processConfig.ts";
import { METHODOLOGIES, TICKET_TOOLS, type Methodology, type TicketTool } from "../schemas/process.ts";
import {
  METHODOLOGY_CHOICES, METHODOLOGY_QUESTION, TICKET_CHOICES, TICKET_QUESTION, type ProcessChoice,
} from "./questions.ts";
import {
  buildProcessDocument, DEFAULT_SPRINT_LENGTH_DAYS, DEFAULT_WIP_LIMIT, PROCESS_HEADER,
} from "./processDocument.ts";
import { gitUserName } from "./gitUserName.ts";
import { resolveGithubProject } from "./githubProject.ts";
import { endWithNewline } from "./writeFile.ts";
import type { CapturedAnswer } from "../answers/captureAnswers.ts";
import type { CommandRunner } from "../detect/CommandRunner.ts";

export class ProcessAnswerError extends Error {}

/** The two answers, verbatim as they were recorded. `null` = not answered here. */
export interface ProcessAnswers {
  readonly methodology: string | null;
  readonly ticketTool: string | null;
  /** The question id that settled the methodology, for `source.q` on a created file. */
  readonly questionId: string | null;
}

export const NO_PROCESS_ANSWERS: ProcessAnswers = {
  methodology: null, ticketTool: null, questionId: null,
};

export function hasProcessAnswer(answers: ProcessAnswers): boolean {
  return answers.methodology !== null || answers.ticketTool !== null;
}

/**
 * Pick the process answers out of what the interview just recorded.
 *
 * Matched on the question TITLE rather than on the answer text, because "other"
 * is arbitrary prose and still has to be attributed to the right question in
 * order to print the right note.
 */
export function collectProcessAnswers(
  questionsPath: string,
  answered: readonly CapturedAnswer[],
): ProcessAnswers {
  if (answered.length === 0 || !existsSync(questionsPath)) return NO_PROCESS_ANSWERS;
  const titles = new Map(
    parseQuestions(readFileSync(questionsPath, "utf8")).blocks.map((block) => [block.id, block.title]),
  );
  const find = (title: string): CapturedAnswer | undefined =>
    answered.find((answer) => titles.get(answer.q) === title);
  const methodology = find(METHODOLOGY_QUESTION);
  const ticket = find(TICKET_QUESTION);
  return {
    methodology: methodology?.answer ?? null,
    ticketTool: ticket?.answer ?? null,
    questionId: methodology?.q ?? ticket?.q ?? null,
  };
}

/**
 * Which offered option an answer is, or `null` for free text.
 *
 * A label may carry the ` (MCP server connected)` suffix `ticketOptions` appends,
 * so the comparison is "the label, or the label followed by a parenthesis".
 */
export function matchChoice<T>(answer: string, choices: readonly ProcessChoice<T>[]): T | null {
  const text = answer.trim();
  for (const choice of choices) {
    if (choice.value === null) continue;
    if (text === choice.label || text.startsWith(`${choice.label} (`)) return choice.value;
  }
  return null;
}

export interface ApplyProcessInput {
  readonly root: string;
  readonly answers: ProcessAnswers;
  readonly runner: CommandRunner;
  /** RFC3339. Only used when `process.yml` has to be created. */
  readonly when: string;
}

export interface ApplyProcessResult {
  /** True when bytes were written. False means the file already said this. */
  readonly changed: boolean;
  readonly created: boolean;
  readonly path: string;
  readonly methodology: Methodology | null;
  readonly ticketTool: TicketTool | null;
  readonly project: string | null;
  /** One line per thing the human still has to do by hand. */
  readonly notes: readonly string[];
}

export async function applyProcessAnswers(input: ApplyProcessInput): Promise<ApplyProcessResult> {
  const path = processPath(input.root);
  const notes: string[] = [];
  const { methodology: rawMethodology, ticketTool: rawTicket } = input.answers;

  const methodology = rawMethodology === null ? null : matchChoice(rawMethodology, METHODOLOGY_CHOICES);
  const ticketTool = rawTicket === null ? null : matchChoice(rawTicket, TICKET_CHOICES);

  if (rawMethodology !== null && methodology === null) {
    notes.push(
      `methodology was left as it is — "${rawMethodology}" is free text, not one of the offered `
      + "options. Set `methodology:` in .tldrx/process.yml by hand "
      + `(${METHODOLOGIES.join(" | ")}).`,
    );
  }
  if (rawTicket !== null && ticketTool === null) {
    notes.push(
      `ticket_tool was left as it is — "${rawTicket}" is free text, not one of the offered `
      + "options. Set `ticket_tool.kind:` in .tldrx/process.yml by hand "
      + `(${TICKET_TOOLS.join(" | ")}).`,
    );
  }

  const project = await resolveProject(input, ticketTool, notes);

  if (methodology === null && ticketTool === null) {
    return { changed: false, created: false, path, methodology, ticketTool, project, notes };
  }
  assertEnum(methodology, METHODOLOGIES, "methodology");
  assertEnum(ticketTool, TICKET_TOOLS, "ticket_tool.kind");

  const before = existsSync(path) ? readFileSync(path, "utf8") : null;
  const seed = before ?? PROCESS_HEADER + stringifyYaml(buildProcessDocument({
    methodology: null,
    approver: await gitUserName(input.runner, input.root),
    when: input.when,
    questionId: input.answers.questionId,
  }));
  const after = patchProcessFile(seed, { methodology, ticketTool, project });

  if (before !== null && after === before) {
    return { changed: false, created: false, path, methodology, ticketTool, project, notes };
  }
  await runtime.writeText(path, after);
  return { changed: true, created: before === null, path, methodology, ticketTool, project, notes };
}

async function resolveProject(
  input: ApplyProcessInput,
  ticketTool: TicketTool | null,
  notes: string[],
): Promise<string | null> {
  if (ticketTool === "jira") {
    notes.push("set ticket_tool.project (Jira project key) in .tldrx/process.yml");
    return null;
  }
  if (ticketTool === "linear") {
    notes.push(
      "set ticket_tool.project in .tldrx/process.yml — `linear` is in the enum but has no "
      + "adapter in this build, so `tldrx tickets sync` will exit 1 and say so.",
    );
    return null;
  }
  if (ticketTool !== "github") return null;

  const found = await resolveGithubProject(input.root, input.runner);
  if (found.project !== null) return found.project;
  notes.push(
    "set ticket_tool.project (`owner/repo`) in .tldrx/process.yml — no GitHub `origin` remote "
    + `was found${found.rejected.length === 0 ? "" : ` (read: ${found.rejected.join(", ")})`}.`,
  );
  return null;
}

export interface ProcessPatch {
  readonly methodology: Methodology | null;
  readonly ticketTool: TicketTool | null;
  readonly project: string | null;
}

/**
 * Patch the two keys in the text of a `process.yml`, keeping its leading comment
 * header, its key order and every other key. A file that does not parse as a YAML
 * mapping is returned unchanged — never truncated into a "valid" one.
 */
export function patchProcessFile(text: string, patch: ProcessPatch): string {
  const split = splitHeader(text);
  let document: unknown;
  try {
    document = parseYaml(split.body);
  } catch {
    return text;
  }
  if (typeof document !== "object" || document === null || Array.isArray(document)) return text;

  const record = { ...(document as Record<string, unknown>) };
  if (patch.methodology !== null) applyMethodology(record, patch.methodology);
  if (patch.ticketTool !== null) applyTicketTool(record, patch.ticketTool, patch.project);
  return endWithNewline(split.header + stringifyYaml(record));
}

/** Methodology, plus the cadence key it makes required — the same defaults `init` seeds. */
function applyMethodology(record: Record<string, unknown>, methodology: Methodology): void {
  record.methodology = methodology;
  const cadence = record.cadence;
  if (typeof cadence !== "object" || cadence === null || Array.isArray(cadence)) return;
  const next = { ...(cadence as Record<string, unknown>) };
  if (methodology === "scrum" && next.sprint_length_days == null) {
    next.sprint_length_days = DEFAULT_SPRINT_LENGTH_DAYS;
  }
  if (methodology === "kanban" && next.wip_limit == null) next.wip_limit = DEFAULT_WIP_LIMIT;
  record.cadence = next;
}

/**
 * Both shapes `adapters/processConfig.ts` reads: the nested §2.12 `ticket_tool:
 * {kind, project, …}` and the flat draft `ticket_tool: jira` + `project_key:`.
 * A project is only written when one is known — `jira` keeps whatever key is
 * already there rather than having it blanked by an interview answer.
 */
function applyTicketTool(
  record: Record<string, unknown>,
  kind: TicketTool,
  project: string | null,
): void {
  const tool = record.ticket_tool;
  if (typeof tool === "object" && tool !== null && !Array.isArray(tool)) {
    const next = { ...(tool as Record<string, unknown>) };
    next.kind = kind;
    if (project !== null) next.project = project;
    record.ticket_tool = next;
    return;
  }
  record.ticket_tool = kind;
  if (project !== null) record.project_key = project;
}

/** The contiguous run of comment and blank lines at the top, kept verbatim. */
function splitHeader(text: string): { header: string; body: string } {
  const lines = text.split("\n");
  let at = 0;
  while (at < lines.length && (lines[at]?.trim() === "" || lines[at]?.trimStart().startsWith("#"))) at++;
  if (at === 0) return { header: "", body: text };
  return { header: `${lines.slice(0, at).join("\n")}\n`, body: lines.slice(at).join("\n") };
}

function assertEnum<T extends string>(
  value: T | null,
  allowed: readonly T[],
  label: string,
): void {
  if (value === null) return;
  if (!allowed.includes(value)) {
    throw new ProcessAnswerError(
      `refusing to write process.yml ${label}: '${value}' is not one of ${allowed.join(" | ")}`,
    );
  }
}

/** The closing line: what the file now says, or that it was already saying it. */
export function renderProcessApply(result: ApplyProcessResult): string {
  const lines: string[] = [];
  if (!result.changed) {
    lines.push("process.yml: unchanged");
  } else {
    const parts: string[] = [];
    if (result.methodology !== null) parts.push(`methodology=${result.methodology}`);
    if (result.ticketTool !== null) {
      parts.push(`ticket_tool=${result.ticketTool}${result.project === null ? "" : ` (${result.project})`}`);
    }
    lines.push(`process.yml${result.created ? " (created)" : ""}: ${parts.join(", ")}`);
  }
  for (const note of result.notes) lines.push(`  note: ${note}`);
  return `${lines.join("\n")}\n`;
}
