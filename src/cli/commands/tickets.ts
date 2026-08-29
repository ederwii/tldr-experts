/**
 * `tldrx tickets` — the optional ticket mirror (concept v0.2 addendum).
 *
 * Two subcommands, and neither of them advances anything:
 *
 *   `sync`   mirrors every epic and story in `03-plan/` out to the configured
 *            tool, then (in `two-way` mode) pulls each issue's status back into
 *            `external_status`. It writes exactly two front-matter keys per file
 *            and appends one `ticket.synced` event per item.
 *   `status` prints local `status` beside `external_status` and changes nothing.
 *
 * The run is opened READ-ONLY: `RunStore.save()` is never called, so `run.yml`,
 * the cursor and the gate are untouched by construction. A story's `status:` is
 * likewise unreachable from here — `applyExternal` refuses a patch that moves it.
 *
 * Nothing is written before the provider is fully resolved. A `none` ticket tool
 * exits `0` ("adapter disabled"); a missing Jira credential exits `1` naming the
 * three environment variables, before `03-plan/` has even been read.
 */
import { join } from "node:path";
import type { Command } from "../Command.ts";
import { EXIT_OK, EXIT_USAGE } from "../exitCodes.ts";
import { boolFlag, parseArgs, stringFlag, UsageError, type ParsedArgs } from "../argv.ts";
import { workspaceRootFrom } from "../workspace.ts";
import { fail } from "../report.ts";
import { RunStore } from "../../core/run/RunStore.ts";
import { isResolved, resolveRunOrExplain, type RunOrExit } from "../resolveRun.ts";
import { nowRfc3339, currentActor } from "../../hooks/lib/actor.ts";
import {
  collectMirrorItems, createGithubProvider, PLAN_PHASE, createJiraProvider, isTicketProviderKind,
  readTicketToolConfig, realCommandTransport, realHttpTransport, renderStatusTable,
  resolveJiraCredentials, statusRows, syncTickets, TicketAdapterError,
  type TicketProvider, type TicketToolConfig, type SyncOutcome,
} from "../../core/adapters/index.ts";

const VALUE_FLAGS = ["run", "root", "provider"];

/** How the config file is named on screen, matching `disabledMessage` below. */
const PROCESS_YML = ".tldrx/process.yml";

export const ticketsCommand: Command = {
  name: "tickets",
  summary: "Mirror the plan's epics and stories to a ticket tool (files stay the source of truth)",
  usage:
    "tldrx tickets sync [--run <id>] [--dry-run] [--provider github|jira] [--root <path>]\n"
    + "       tldrx tickets status [--run <id>] [--root <path>]",
  subcommands: ["sync", "status"],
  implemented: true,
  async run(argv: readonly string[]): Promise<number> {
    const [sub, ...rest] = argv;
    switch (sub) {
      case "sync":
        return ticketsSync(rest);
      case "status":
        return ticketsStatus(rest);
      default:
        process.stderr.write(`tldrx tickets: expected \`sync\` or \`status\`\n${ticketsCommand.usage}\n`);
        return EXIT_USAGE;
    }
  },
};

// --- sync -------------------------------------------------------------------

async function ticketsSync(argv: readonly string[]): Promise<number> {
  try {
    const args = parseArgs(argv, VALUE_FLAGS);
    const root = workspaceRootFrom(args);
    const config = readTicketToolConfig(root);

    const kind = resolveKind(args, config);
    if (kind === null) {
      process.stdout.write(`${disabledMessage(config)}\n`);
      return EXIT_OK;
    }

    const resolved = openRun(args, root);
    if (!isResolved(resolved)) return resolved.exit;
    const store = resolved.store;

    // Resolved before anything is read from 03-plan/ and before any write.
    const provider = buildProvider(kind, config);

    const outcome = await syncTickets({
      planDir: join(store.runDir, PLAN_PHASE),
      runId: store.runId,
      provider,
      sync: config.sync,
      dryRun: boolFlag(args, "dry-run"),
      now: nowRfc3339,
    });

    if (!outcome.dryRun) recordEvents(store, provider, outcome);
    process.stdout.write(`${renderSync(store.runId, provider, config, outcome)}\n`);
    return EXIT_OK;
  } catch (error) {
    return fail("tickets sync", error);
  }
}

// --- status -----------------------------------------------------------------

function ticketsStatus(argv: readonly string[]): number {
  try {
    const args = parseArgs(argv, VALUE_FLAGS);
    const root = workspaceRootFrom(args);

    // The config comes FIRST, and it is printed whether or not a run exists.
    // Before this, `tickets status` in a workspace with no run exited 3 without
    // ever opening process.yml, so a ticket_tool that could never sync — a kind
    // with no adapter, a missing project — stayed invisible until someone
    // created a run and tried to sync it.
    const config = readTicketToolConfig(root);
    process.stdout.write(`${describeTicketTool(config).join("\n")}\n`);

    const resolved = openRun(args, root);
    if (!isResolved(resolved)) return resolved.exit;
    const store = resolved.store;

    const collected = collectMirrorItems(join(store.runDir, PLAN_PHASE), store.runId);
    const lines = [
      `tickets · run ${store.runId} · ticket_tool ${config.kind}${config.project === null ? "" : ` (${config.project})`}`,
      "",
      renderStatusTable(statusRows(collected.items)),
    ];
    for (const skipped of collected.skipped) lines.push(`skipped ${skipped}`);
    process.stdout.write(`${lines.join("\n")}\n`);
    return EXIT_OK;
  } catch (error) {
    return fail("tickets status", error);
  }
}

/**
 * What process.yml says, and whether `tickets sync` could act on it.
 *
 * Reports; it does not refuse. `status` reads nothing and calls nothing, so a
 * broken ticket_tool is a finding here, not a failure — the exit code stays the
 * one the run lookup produces. The wording of each problem matches the error
 * `sync` would raise for it, so the two screens never describe it differently.
 */
function describeTicketTool(config: TicketToolConfig): readonly string[] {
  const where = config.path === null ? `no ${PROCESS_YML}` : config.path;
  const project = config.project === null ? "" : ` (${config.project})`;
  const lines = [`ticket_tool ${config.kind}${project} · sync ${config.sync} · ${where}`];

  if (config.kind === "none") {
    lines.push(
      config.path === null
        ? `no ${PROCESS_YML}, so no ticket tool is configured — \`tldrx tickets sync\` is a no-op.`
        : `ticket_tool.kind is none — \`tldrx tickets sync\` is a no-op.`,
    );
    return lines;
  }
  if (!isTicketProviderKind(config.kind)) {
    lines.push(
      `warning: kind '${config.kind}' has no adapter — this build ships github and jira. `
      + "`tldrx tickets sync` will refuse until it is one of those, or none.",
    );
    return lines;
  }
  if (config.project === null) {
    lines.push(
      `warning: ticket_tool.project is required for the ${config.kind} provider `
      + `(${config.kind === "github" ? "`owner/repo`" : "the Jira project key"}). `
      + "`tldrx tickets sync` will refuse until it is set.",
    );
  }
  return lines;
}

// --- wiring -----------------------------------------------------------------

/** `--provider` wins over `process.yml`; `null` means the adapter is off. */
function resolveKind(args: ParsedArgs, config: TicketToolConfig): "github" | "jira" | null {
  const flag = stringFlag(args, "provider");
  if (flag !== undefined) {
    if (!isTicketProviderKind(flag)) {
      throw new UsageError(`--provider expects github or jira, got '${flag}'`);
    }
    return flag;
  }
  if (config.kind === "none") return null;
  if (!isTicketProviderKind(config.kind)) {
    throw new UsageError(
      `process.yml ticket_tool.kind is '${config.kind}', which has no adapter — `
      + "this build ships github and jira. Set it to one of those, or to none.",
    );
  }
  return config.kind;
}

function disabledMessage(config: TicketToolConfig): string {
  return config.path === null
    ? "adapter disabled — no .tldrx/process.yml, so no ticket tool is configured. Nothing was read or written."
    : "adapter disabled — process.yml has ticket_tool.kind: none. Nothing was read or written.";
}

function buildProvider(kind: "github" | "jira", config: TicketToolConfig): TicketProvider {
  const project = config.project;
  if (project === null) {
    throw new TicketAdapterError(
      `process.yml ticket_tool.project is required for the ${kind} provider `
      + `(${kind === "github" ? "`owner/repo`" : "the Jira project key"}). Nothing was written.`,
    );
  }
  if (kind === "github") {
    return createGithubProvider({ transport: realCommandTransport(), repo: project });
  }
  const credentials = resolveJiraCredentials(process.env);
  if (!credentials.ok) throw new TicketAdapterError(credentials.message);
  return createJiraProvider({
    transport: realHttpTransport(),
    credentials: credentials.credentials,
    project,
  });
}

/** The store, or the exit code to return — 3 for no run, 2 when several are open. */
function openRun(args: ParsedArgs, root: string): RunOrExit {
  return resolveRunOrExplain("tldrx tickets", root, stringFlag(args, "run") ?? args.positionals[0]);
}

/**
 * One `ticket.synced` per mirrored item. `cost_usd: 0` — no model ran — and
 * `stage: null`, because a mirror is not a stage and must not be attributed to
 * whichever one the cursor happens to be sitting on.
 */
function recordEvents(store: RunStore, provider: TicketProvider, outcome: SyncOutcome): void {
  const actor = currentActor();
  for (const result of outcome.results) {
    if (result.ref === null) continue;
    store.events.tryAppend({
      ts: nowRfc3339(),
      run: store.runId,
      stage: null,
      type: "ticket.synced",
      actor,
      cost_usd: 0,
      payload: {
        kind: result.item.kind,
        id: result.item.id,
        action: result.action,
        provider: provider.kind,
        key: result.ref.key,
        url: result.ref.url,
        external_status: result.externalStatus,
        file: `${PLAN_PHASE}/${result.item.rel}`,
      },
    });
  }
}

function renderSync(
  runId: string,
  provider: TicketProvider,
  config: TicketToolConfig,
  outcome: SyncOutcome,
): string {
  const head = outcome.dryRun
    ? `tickets sync --dry-run · run ${runId} · ${provider.kind} (${config.project ?? "?"}) · nothing was called`
    : `tickets sync · run ${runId} · ${provider.kind} (${config.project ?? "?"}) · sync ${config.sync}`;
  const lines = [head, ""];

  if (outcome.results.length === 0) {
    lines.push(`no epics or stories in ${PLAN_PHASE}/ — nothing to mirror`);
  }
  for (const result of outcome.results) {
    const verb = outcome.dryRun ? `would ${result.action}` : result.action === "create" ? "created" : "updated";
    const where = result.ref === null ? "" : ` -> ${result.ref.key} ${result.ref.url}`;
    const pulled = result.externalStatus === null ? "" : ` · external_status: ${result.externalStatus}`;
    lines.push(`${result.item.id.padEnd(4)} ${result.item.kind.padEnd(5)} ${verb}${where}${pulled}`);
  }
  for (const skipped of outcome.skipped) lines.push(`skipped ${skipped}`);

  lines.push(
    "",
    `${outcome.created} to create · ${outcome.updated} to update`,
    outcome.dryRun
      ? "Dry run: no issue was created or edited, and no file was changed."
      : "Files are the source of truth: only `external` and `external_status` were written. "
        + "No story status changed, and the run did not advance.",
  );
  return lines.join("\n");
}
