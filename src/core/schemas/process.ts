/**
 * Schema for `.tldrx/process.yml` — the team's process model as DATA, never assumed
 * (concept v0.2 addendum). Changing methodology = editing one file.
 */
import {
  asDocument, requireArray, requireEnum, requireKeys,
  result, type ValidationIssue, type ValidationResult,
} from "./validation.ts";

export const METHODOLOGIES = ["scrum", "kanban", "shape-up", "none"] as const;
export type Methodology = (typeof METHODOLOGIES)[number];

export const TICKET_TOOLS = ["jira", "github", "linear", "none"] as const;
export type TicketTool = (typeof TICKET_TOOLS)[number];

export const STORY_GRANULARITIES = ["hours", "days"] as const;
export type StoryGranularity = (typeof STORY_GRANULARITIES)[number];

export interface ProcessModel {
  readonly schema_version: number;
  readonly methodology: Methodology;
  readonly ticket_tool: TicketTool;
  readonly story_granularity: StoryGranularity;
  readonly approvers: readonly string[];
  readonly definition_of_done: readonly string[];
  readonly cadence?: string | null;
  readonly wip_limit?: number | null;
  readonly sprint_length?: string | null;
  readonly project_key?: string | null;
  readonly board_id?: string | null;
}

export function validateProcess(input: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  const doc = asDocument(input, issues);
  if (!doc) return result(issues);

  requireKeys(
    doc,
    ["schema_version", "methodology", "ticket_tool", "story_granularity", "approvers", "definition_of_done"],
    "",
    issues,
  );
  requireEnum(doc.methodology, METHODOLOGIES, "methodology", issues);
  requireEnum(doc.ticket_tool, TICKET_TOOLS, "ticket_tool", issues);
  requireEnum(doc.story_granularity, STORY_GRANULARITIES, "story_granularity", issues);
  requireArray(doc.approvers, "approvers", issues);
  requireArray(doc.definition_of_done, "definition_of_done", issues);
  return result(issues);
}
