/**
 * `.tldrx/workspace.yml`, shaped by spec §2.1.
 *
 * Note the drift from the v0 skeleton validator in `src/core/schemas/workspace.ts`:
 * the spec says `version: 1` and `mode: single-repo|multi-repo`, the skeleton
 * says `schema_version` and `single|multi`. The spec is the source of truth for
 * what is written; `validateEmitted.ts` projects the document onto the skeleton
 * shape so the shipped validator still runs against the same data. `[assumption]`
 *
 * `provider` and `root` are additions the spec table does not list: `provider`
 * because spec §5 decision (b) requires recording which map provider ran, and
 * `root` because `.tldrx/` may live outside the tree it describes.
 */
import { type DetectedRepo, type DetectedWorkspace } from "../detect/types.ts";
import type { McpServer } from "../doctor/McpProbe.ts";

export interface WorkspaceRepoDocument {
  readonly name: string;
  readonly path: string;
  readonly default_branch: string;
  readonly stack: readonly string[];
  readonly package_manager: string | null;
  readonly commands: Readonly<Record<string, string | null>>;
  readonly ci: readonly string[];
  readonly confidence: string;
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
}

export function buildWorkspaceDocument(input: BuildWorkspaceInput): WorkspaceDocument {
  return {
    version: 1,
    mode: input.workspace.mode,
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
    ci: repo.ci,
    confidence: repo.confidence,
  };
}
