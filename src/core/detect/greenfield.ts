/**
 * Greenfield: a workspace with nothing built yet.
 *
 * Spec §2.1 has two modes, `single-repo` and `multi-repo`, and both assume there
 * is code to map. A brand-new project has a git repo, maybe a requirements
 * document, and no source at all — and `init` has to say so rather than emit six
 * map documents describing an empty tree as if it were an architecture.
 *
 * The rule is deterministic and narrow:
 *
 *   greenfield  ⇔  the workspace is single-repo AND that repo holds zero code
 *                  files (`codeFiles.ts` defines "code file")
 *
 * Single-repo only, on purpose: a root with child repos is a workspace whose code
 * lives in the children, so the root having no code of its own says nothing.
 * `[assumption]` — the spec names no third mode; `greenfield` is a specialisation
 * of `single-repo` and the shipped validator projects it back onto `single`.
 */
import type { DetectedWorkspace } from "./types.ts";

export function isGreenfield(workspace: DetectedWorkspace): boolean {
  if (workspace.mode !== "single-repo") return false;
  if (workspace.repos.length !== 1) return false;
  return (workspace.repos[0]?.codeFiles ?? 0) === 0;
}

/** What `workspace.yml mode:` records for this detection (spec §2.1 + greenfield). */
export function workspaceMode(workspace: DetectedWorkspace): string {
  return isGreenfield(workspace) ? "greenfield" : workspace.mode;
}
