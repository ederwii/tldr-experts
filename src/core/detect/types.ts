/**
 * The detection vocabulary. One shape per thing `tldrx init` can observe about a
 * workspace, plus the evidence that observation rests on.
 *
 * Evidence discipline (spec §2.8): nothing in here is a conclusion without a
 * `src` token behind it. `Evidence.src` is that token's payload, not prose.
 */

export const WORKSPACE_MODES = ["single-repo", "multi-repo"] as const;
export type DetectedMode = (typeof WORKSPACE_MODES)[number];

export const CONFIDENCE_LEVELS = ["high", "medium", "low"] as const;
export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

/** The five command slots `workspace.yml` declares for every repo (spec §2.1). */
export const COMMAND_SLOTS = ["build", "test", "lint", "typecheck", "run"] as const;
export type CommandSlot = (typeof COMMAND_SLOTS)[number];

export type RepoCommands = Readonly<Record<CommandSlot, string | null>>;

/**
 * One observation with its citation. `src` is the inner text of a `[src: …]`
 * token: `path:line`, `absent:path` or `$ cmd → exit n`.
 */
export interface Evidence {
  readonly claim: string;
  /** Citation payload, repo-relative for `file` sources (the repo prefix is added at render time). */
  readonly src: string;
  /** When true the src is workspace-relative and must NOT be prefixed with the repo name. */
  readonly workspaceScoped?: boolean;
}

export interface DetectedRepo {
  readonly name: string;
  /** Workspace-root-relative. `.` in single-repo mode. */
  readonly path: string;
  /** Absolute path on this machine; never written to a file. */
  readonly absPath: string;
  readonly defaultBranch: string;
  readonly stack: readonly string[];
  /** Languages only (frameworks excluded) — the stack experts init seeds. */
  readonly languages: readonly string[];
  readonly packageManager: string | null;
  /** Repo-relative build manifests that produced the stack; empty when none was found. */
  readonly manifests: readonly string[];
  /** How many CODE files this repo holds (`detect/codeFiles.ts`); `0` ⇒ greenfield. */
  readonly codeFiles: number;
  readonly commands: RepoCommands;
  readonly ci: readonly string[];
  readonly confidence: Confidence;
  readonly evidence: readonly Evidence[];
}

export interface DetectedWorkspace {
  readonly mode: DetectedMode;
  readonly rootIsRepo: boolean;
  /** Absolute path of the workspace root that was scanned. */
  readonly root: string;
  readonly repos: readonly DetectedRepo[];
  readonly evidence: readonly Evidence[];
}
