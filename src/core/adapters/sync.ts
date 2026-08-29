/**
 * The mirror itself: `03-plan/` out to the tool, `external_status` back in.
 *
 * What this function is allowed to write is the whole design:
 *   - the remote issue (created or updated), and
 *   - two front-matter keys, `external` and `external_status`.
 *
 * What it is NOT allowed to touch, ever: `run.yml`, a story's `status:`, an
 * epic's `status:`, `waves.yml`, the gate, the cursor. It takes no `RunStore` and
 * imports nothing that can write one — the restriction is structural, not a
 * promise. Guard-rail 2 is re-checked one layer down as well: `applyExternal`
 * throws if a patch would move the `status:` line.
 *
 * `--dry-run` returns the same plan and calls the transport ZERO times, which is
 * asserted by a test that counts calls on a fake.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { applyExternal } from "./external.ts";
import { collectMirrorItems, type CollectResult, type MirrorItem } from "./collect.ts";
import { TicketAdapterError, type ExternalRef, type TicketProvider } from "./types.ts";
import type { TicketSyncMode } from "../schemas/process.ts";

export type SyncAction = "create" | "update";

export interface SyncResult {
  readonly item: MirrorItem;
  readonly action: SyncAction;
  /** Null on a dry run — nothing was created, so there is no identity to report. */
  readonly ref: ExternalRef | null;
  /** The remote status pulled in, or null (dry run, `mirror-out`, or none reported). */
  readonly externalStatus: string | null;
  /** True when the story/epic file on disk was rewritten. */
  readonly wrote: boolean;
}

export interface SyncOptions {
  /** The run's `03-plan/`. */
  readonly planDir: string;
  readonly runId: string;
  readonly provider: TicketProvider;
  /** `mirror-out` pushes only; `two-way` also pulls `external_status`. */
  readonly sync: TicketSyncMode;
  readonly dryRun: boolean;
  /** RFC3339 UTC stamp for `synced_at`. Injected so a test can assert the value. */
  readonly now: () => string;
}

export interface SyncOutcome {
  readonly results: readonly SyncResult[];
  readonly skipped: readonly string[];
  readonly created: number;
  readonly updated: number;
  readonly dryRun: boolean;
}

export function planSync(options: Pick<SyncOptions, "planDir" | "runId" | "provider">): {
  readonly collected: CollectResult;
  readonly actions: ReadonlyMap<string, SyncAction>;
} {
  const collected = collectMirrorItems(options.planDir, options.runId);
  const actions = new Map<string, SyncAction>();
  for (const item of collected.items) actions.set(item.path, actionFor(item, options.provider));
  return { collected, actions };
}

/**
 * `[assumption]` — an `external:` block written by a DIFFERENT provider is treated
 * as absent, so switching `ticket_tool.kind` files fresh issues in the new tool
 * and re-keys the file. The alternative (refusing) would leave a team that
 * migrated tools with no way forward but hand-editing every story.
 */
function actionFor(item: MirrorItem, provider: TicketProvider): SyncAction {
  const external = item.external;
  if (external === null) return "create";
  return external.provider === provider.kind ? "update" : "create";
}

export async function syncTickets(options: SyncOptions): Promise<SyncOutcome> {
  const { collected, actions } = planSync(options);
  const results: SyncResult[] = [];
  let created = 0;
  let updated = 0;

  for (const item of collected.items) {
    const action = actions.get(item.path) ?? "create";
    if (action === "create") created++;
    else updated++;

    if (options.dryRun) {
      results.push({ item, action, ref: null, externalStatus: null, wrote: false });
      continue;
    }

    const existingKey = action === "update" && item.external !== null ? item.external.key : null;
    const identity = await options.provider.write(
      { kind: item.kind, id: item.id, title: item.issueTitle, body: item.issueBody },
      existingKey,
    );
    const ref: ExternalRef = {
      provider: options.provider.kind,
      key: identity.key,
      url: identity.url,
      synced_at: options.now(),
    };

    const externalStatus = options.sync === "two-way"
      ? await options.provider.readStatus(identity.key)
      : null;

    writeBack(item, ref, externalStatus, options.sync);
    results.push({ item, action, ref, externalStatus, wrote: true });
  }

  return { results, skipped: collected.skipped, created, updated, dryRun: options.dryRun };
}

/**
 * The only disk write in this module. Re-reads the file rather than reusing the
 * text collected earlier, so a story edited while a long sync ran keeps the human's
 * edit and gains only the two mirror keys.
 */
function writeBack(
  item: MirrorItem,
  ref: ExternalRef,
  externalStatus: string | null,
  sync: TicketSyncMode,
): void {
  const before = readFileSync(item.path, "utf8");
  const after = applyExternal(before, {
    external: ref,
    // `mirror-out` reads nothing back, so it must not clear a status a previous
    // `two-way` sync recorded; `two-way` writes exactly what the remote said.
    ...(sync === "two-way" ? { externalStatus } : {}),
  });
  if (after === before) return;
  writeFileSync(item.path, after, "utf8");
}

export { TicketAdapterError };
