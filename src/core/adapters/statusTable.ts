/**
 * `tldrx tickets status` — local `status` beside `external_status`, and nothing
 * else happens.
 *
 * It reads two folders and prints. No transport, no network, no write: the whole
 * point is to answer "has the board drifted from the files?" without letting the
 * answer change either one.
 *
 * Comparing the two honestly is the only judgement here. A remote status string
 * is free-form (`OPEN`, `Done`, `In Progress`, `Selected for Development`), so
 * the comparison is deliberately coarse: **done-ness only**. Anything finer would
 * be inventing a mapping nobody configured.
 */
import type { PlanStatus } from "../schemas/planCommon.ts";
import type { MirrorItem } from "./collect.ts";

/**
 * `[assumption]` — remote statuses counted as finished. Jira's default workflow
 * ends in `Done`; GitHub reports `CLOSED`; the rest are the names teams most
 * often rename those to. A status outside this set is treated as not-done.
 */
export const DONE_LIKE = ["done", "closed", "resolved", "complete", "completed", "shipped"] as const;

export function isRemoteDone(status: string): boolean {
  return (DONE_LIKE as readonly string[]).includes(status.trim().toLowerCase());
}

export function isLocalDone(status: PlanStatus): boolean {
  return status === "done";
}

export type Divergence = "aligned" | "diverged" | "unsynced";

export function divergenceOf(item: MirrorItem): Divergence {
  if (item.external === null) return "unsynced";
  if (item.externalStatus === null) return "aligned";
  return isLocalDone(item.localStatus) === isRemoteDone(item.externalStatus) ? "aligned" : "diverged";
}

export interface StatusRow {
  readonly id: string;
  readonly kind: string;
  readonly local: string;
  readonly external: string;
  readonly key: string;
  readonly url: string;
  readonly divergence: Divergence;
}

export function statusRows(items: readonly MirrorItem[]): readonly StatusRow[] {
  return items.map((item) => ({
    id: item.id,
    kind: item.kind,
    local: item.localStatus,
    external: item.externalStatus ?? "—",
    key: item.external?.key ?? "—",
    url: item.external?.url ?? "—",
    divergence: divergenceOf(item),
  }));
}

const HEADERS = ["", "ID", "KIND", "LOCAL", "EXTERNAL", "KEY", "URL"] as const;

/** A marker column first, so a diverged row is findable without reading the table. */
export function renderStatusTable(rows: readonly StatusRow[]): string {
  if (rows.length === 0) {
    return "No epics or stories in 03-plan/ — nothing to compare.";
  }
  const body = rows.map((row) => [marker(row.divergence), row.id, row.kind, row.local, row.external, row.key, row.url]);
  const widths = HEADERS.map((header, i) =>
    Math.max(header.length, ...body.map((cells) => (cells[i] ?? "").length)));

  const line = (cells: readonly string[]): string =>
    cells.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join("  ").trimEnd();

  const diverged = rows.filter((row) => row.divergence === "diverged").length;
  const unsynced = rows.filter((row) => row.divergence === "unsynced").length;

  return [
    line(HEADERS),
    line(widths.map((width) => "-".repeat(width))),
    ...body.map(line),
    "",
    `${rows.length} mirrored item(s) · ${diverged} diverged · ${unsynced} never synced`,
    "This view changes nothing — `status` is the file's, `external_status` is the tool's.",
  ].join("\n");
}

function marker(divergence: Divergence): string {
  if (divergence === "diverged") return "!=";
  if (divergence === "unsynced") return "..";
  return "";
}
