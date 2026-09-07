/**
 * `.tldrx/workspace.yml`, shaped by spec §2.1.
 *
 * Note the drift from the v0 skeleton validator in `src/core/schemas/workspace.ts`:
 * the spec says `mode: single-repo|multi-repo`, the skeleton says
 * `single|multi`. The spec is the source of truth for what is written;
 * `validateEmitted.ts` projects the document onto the skeleton shape so the
 * shipped validator still runs against the same data. `[assumption]` The version
 * key no longer drifts: since 2026-08-29 both say `version: 1`.
 *
 * `provider` and `root` are additions the spec table does not list: `provider`
 * because spec §5 decision (b) requires recording which map provider ran, and
 * `root` because `.tldrx/` may live outside the tree it describes.
 *
 * `mode` takes a third value the spec table does not list — `greenfield`, when the
 * single repo holds no code file at all (`detect/greenfield.ts`). It is a
 * specialisation of `single-repo`, and `validateEmitted.ts` projects it onto the
 * skeleton's `single` so the shipped validator still runs. `[assumption]`
 */
import { type DetectedRepo, type DetectedWorkspace } from "../detect/types.ts";
import type { CommandProbe } from "../detect/probeCommands.ts";
import { workspaceMode } from "../detect/greenfield.ts";
import type { DetectedOverlay } from "../detect/overlays.ts";
import type { DetectedSkill } from "../detect/skills.ts";
import type { McpServer } from "../doctor/McpProbe.ts";
import { stringifyYaml } from "../yaml.ts";

export interface WorkspaceRepoDocument {
  readonly name: string;
  readonly path: string;
  readonly default_branch: string;
  readonly stack: readonly string[];
  readonly package_manager: string | null;
  readonly commands: Readonly<Record<string, string | null>>;
  /**
   * `command_probes:` — what `init` MEASURED about each command above (#168).
   *
   * Additive and optional: absent when nothing was probed, and every reader that
   * never heard of the key is unaffected. It is not an allowlist and it permits
   * nothing — `commands` above is still the only thing the DoD gate may run.
   */
  readonly command_probes?: Readonly<Record<string, CommandProbe>>;
  readonly ci: readonly string[];
  readonly overlays: readonly DetectedOverlay[];
  readonly skills: readonly DetectedSkill[];
  readonly confidence: string;
}

/** `stack_packs:` — the one stack-packs switch (stack packs design §4.3). Absent means off. */
export interface StackPacksDocument {
  readonly enabled: boolean;
  readonly enabled_at: string | null;
}

export interface WorkspaceDocument {
  readonly version: 1;
  readonly mode: string;
  readonly root_is_repo: boolean;
  readonly root: string;
  readonly detected_at: string;
  readonly detected_by: string;
  readonly provider: string;
  readonly repos: readonly WorkspaceRepoDocument[];
  readonly contracts: readonly unknown[];
  readonly mcp_servers: readonly McpServerDocument[];
  readonly stack_packs?: StackPacksDocument;
}

export interface McpServerDocument {
  readonly name: string;
  readonly transport: string;
  readonly status: string;
  readonly checked_at: string;
}

export interface BuildWorkspaceInput {
  readonly workspace: DetectedWorkspace;
  /** `.` when `.tldrx/` sits at the root it describes, else an absolute path. */
  readonly root: string;
  readonly detectedAt: string;
  readonly cliVersion: string;
  readonly provider: string;
  readonly mcpServers: readonly McpServer[];
  /** Carried forward from the file being regenerated; null when it never had one. */
  readonly stackPacks?: StackPacksDocument | null;
}

export function buildWorkspaceDocument(input: BuildWorkspaceInput): WorkspaceDocument {
  return {
    version: 1,
    mode: workspaceMode(input.workspace),
    root_is_repo: input.workspace.rootIsRepo,
    root: input.root,
    detected_at: input.detectedAt,
    detected_by: `tldrx ${input.cliVersion}`,
    provider: input.provider,
    repos: input.workspace.repos.map(toRepoDocument),
    contracts: [],
    mcp_servers: input.mcpServers.map((server) => ({
      name: server.name,
      transport: server.transport,
      status: server.status,
      checked_at: input.detectedAt,
    })),
    ...(input.stackPacks === undefined || input.stackPacks === null ? {} : { stack_packs: input.stackPacks }),
  };
}

function toRepoDocument(repo: DetectedRepo): WorkspaceRepoDocument {
  return {
    name: repo.name,
    path: repo.path,
    default_branch: repo.defaultBranch,
    stack: repo.stack,
    package_manager: repo.packageManager,
    commands: {
      build: repo.commands.build,
      test: repo.commands.test,
      lint: repo.commands.lint,
      typecheck: repo.commands.typecheck,
      run: repo.commands.run,
    },
    // Only when there is something to say. A workspace detected without probing
    // writes no key at all, rather than a row of confident nothing.
    ...(Object.keys(repo.commandProbes).length === 0 ? {} : { command_probes: repo.commandProbes }),
    ci: repo.ci,
    overlays: repo.overlays.map((item) => ({ id: item.id, evidence: item.evidence })),
    skills: repo.skills.map((item) => ({
      name: item.name, description: item.description, path: item.path, tracked: item.tracked,
    })),
    confidence: repo.confidence,
  };
}

/** The comment `tldrx init` puts above the YAML — spelled once, for every writer of this file. */
export const WORKSPACE_FILE_HEADER =
  "# Written by `tldrx init` (spec §2.1). Detection result: which repos exist, their\n"
  + "# stack, and the ONLY commands the DoD gate and the map may run. Regenerated on\n"
  + "# every `tldrx init`; hand edits to detected values are overwritten.\n";

export function renderWorkspaceFile(document: unknown): string {
  return WORKSPACE_FILE_HEADER + stringifyYaml(document);
}
