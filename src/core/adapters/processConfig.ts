/**
 * Reading `ticket_tool` out of `.tldrx/process.yml`.
 *
 * Two shapes exist on disk today and this reader accepts both, deliberately:
 *
 *  - the **spec §2.12 shape**, which is what `tldrx init` actually writes
 *    (`src/core/init/processDocument.ts`): `ticket_tool: {kind, project, board, sync}`;
 *  - the **flat draft shape** that `templates/process.yml` ships and that
 *    `src/core/schemas/process.ts` validates: `ticket_tool: jira` + `project_key`.
 *
 * `[assumption]` — reconciling those two into one shape is a change to the init
 * writer and to `test/schemas.test.ts`, neither of which this wave owns, so the
 * reader tolerates both rather than breaking whichever it did not pick.
 *
 * The adapter is DISABLED unless this file says otherwise. An MCP server being
 * connected is a suggestion, not consent (concept v0.2, guard-rail 1).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseYaml } from "../yaml.ts";
import { PROJECT_FRAMEWORK_DIR } from "../paths.ts";
import { TICKET_SYNC_MODES, type TicketSyncMode } from "../schemas/process.ts";

export const PROCESS_FILE = "process.yml";

export interface TicketToolConfig {
  /** `jira | github | linear | none`, verbatim from the file. */
  readonly kind: string;
  readonly project: string | null;
  readonly board: string | null;
  readonly sync: TicketSyncMode;
  /** Absolute path the config was read from, or null when there is no file. */
  readonly path: string | null;
}

export const DISABLED: TicketToolConfig = {
  kind: "none", project: null, board: null, sync: "mirror-out", path: null,
};

export function processPath(root: string): string {
  return join(root, PROJECT_FRAMEWORK_DIR, PROCESS_FILE);
}

/**
 * Read the ticket-tool config. A missing or unparseable `process.yml` means the
 * adapter is off — never a crash, and never a guess at a project key.
 */
export function readTicketToolConfig(root: string): TicketToolConfig {
  const path = processPath(root);
  if (!existsSync(path)) return DISABLED;
  let doc: unknown;
  try {
    doc = parseYaml(readFileSync(path, "utf8"));
  } catch {
    return { ...DISABLED, path };
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return { ...DISABLED, path };
  const record = doc as Record<string, unknown>;
  const tool = record.ticket_tool;

  if (typeof tool === "string") {
    // Flat draft shape.
    return {
      kind: tool,
      project: text(record.project_key),
      board: text(record.board_id),
      sync: syncMode(record.ticket_sync),
      path,
    };
  }
  if (typeof tool === "object" && tool !== null && !Array.isArray(tool)) {
    const nested = tool as Record<string, unknown>;
    return {
      kind: text(nested.kind) ?? "none",
      project: text(nested.project),
      board: text(nested.board),
      sync: syncMode(nested.sync),
      path,
    };
  }
  return { ...DISABLED, path };
}

function text(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value;
  return null;
}

/** An unknown or absent mode falls back to `mirror-out` — the safer of the two. */
function syncMode(value: unknown): TicketSyncMode {
  if (typeof value === "string" && (TICKET_SYNC_MODES as readonly string[]).includes(value)) {
    return value as TicketSyncMode;
  }
  return "mirror-out";
}
