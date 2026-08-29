/**
 * `.tldrx/process.yml`, shaped by spec §2.12.
 *
 * The process model is data, never an assumption: `methodology` is whatever
 * `--process` said, or `none` with `source.q` pointing at the interview question
 * that will settle it. `ticket_tool.kind` stays `none` until a human confirms a
 * project key — an MCP server being connected is a suggestion, not consent
 * (concept v0.2, guard-rail 1).
 *
 * `--process scrum` seeds a 14-day sprint because spec §2.12 requires
 * `sprint_length_days` whenever the methodology is scrum; nobody said 14.
 * `[assumption]` — the interview corrects it.
 */
import type { Methodology } from "../schemas/process.ts";

/**
 * The header every writer of this file puts on it, so a hand-opened `process.yml`
 * says who wrote it and why — `init` when it creates the file, and the interview
 * when it has to create one that init never wrote.
 */
export const PROCESS_HEADER =
  "# Written by `tldrx init` (spec §2.12). The team's way of working as DATA, never\n"
  + "# assumed. Changing methodology means editing this file and nothing else.\n";

/** `[assumption]` — spec §2.12 requires a sprint length under scrum; nobody said 14. */
export const DEFAULT_SPRINT_LENGTH_DAYS = 14;
/** `[assumption]` — kanban needs a WIP limit to render a board; nobody said 3. */
export const DEFAULT_WIP_LIMIT = 3;

export interface ProcessDocument {
  readonly version: 1;
  readonly methodology: Methodology;
  readonly cadence: {
    readonly sprint_length_days: number | null;
    readonly wip_limit: number | null;
    readonly review_day: string | null;
  };
  readonly ticket_tool: {
    readonly kind: string;
    readonly project: string | null;
    readonly board: string | null;
    readonly sync: string;
  };
  readonly story_granularity: string;
  readonly approvers: readonly string[];
  readonly dod: { readonly add: readonly string[]; readonly remove: readonly string[] };
  readonly source: {
    readonly who: string;
    readonly when: string;
    readonly run: string;
    readonly q: string | null;
  };
}

export interface BuildProcessInput {
  readonly methodology: Methodology | null;
  readonly approver: string;
  readonly when: string;
  /** Interview question that will settle the methodology, when there is one. */
  readonly questionId: string | null;
}

export function buildProcessDocument(input: BuildProcessInput): ProcessDocument {
  const methodology: Methodology = input.methodology ?? "none";
  return {
    version: 1,
    methodology,
    cadence: {
      sprint_length_days: methodology === "scrum" ? DEFAULT_SPRINT_LENGTH_DAYS : null,
      wip_limit: methodology === "kanban" ? DEFAULT_WIP_LIMIT : null,
      review_day: null,
    },
    ticket_tool: { kind: "none", project: null, board: null, sync: "mirror-out" },
    story_granularity: "days",
    approvers: [input.approver],
    dod: { add: [], remove: [] },
    source: {
      who: input.methodology === null ? "tldrx-init" : input.approver,
      when: input.when,
      run: "init",
      q: input.questionId,
    },
  };
}
