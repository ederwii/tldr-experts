/**
 * Nothing is written without being validated first.
 *
 * Two layers, on purpose:
 *  1. the SHIPPED validators in `src/core/schemas/` run against a projection of
 *     each document onto the shape they know (the v0 skeleton predates spec v0
 *     and still uses `schema_version` / `mode: single|multi`), so the existing
 *     registry really does check the data we write; `[assumption]`
 *  2. the spec §2.1 / §2.12 rules the skeleton does not encode yet — the repo
 *     name pattern, path containment, and the "single argv, auditable" rule for
 *     commands — are checked here.
 */
import { validate, type ValidationIssue, type ValidationResult } from "../schemas/index.ts";
import { isSingleArgvCommand } from "../detect/commands.ts";
import { CONFIDENCE_LEVELS } from "../detect/types.ts";
import type { WorkspaceDocument } from "./workspaceDocument.ts";
import type { ProcessDocument } from "./processDocument.ts";
import type { CompetenciesDocument } from "./competenciesDocument.ts";

const REPO_NAME_RE = /^[a-z0-9-]{1,32}$/;

export function validateWorkspaceDocument(doc: WorkspaceDocument): ValidationResult {
  const issues: ValidationIssue[] = [...validate("workspace", {
    schema_version: doc.version,
    mode: doc.mode === "multi-repo" ? "multi" : "single",
    root: doc.root,
    repos: doc.repos,
  }).issues];

  const names = new Set<string>();
  doc.repos.forEach((repo, index) => {
    const path = `repos[${index}]`;
    if (!REPO_NAME_RE.test(repo.name)) {
      issues.push({ path: `${path}.name`, message: `must match ${REPO_NAME_RE.source}` });
    }
    if (names.has(repo.name)) issues.push({ path: `${path}.name`, message: "duplicate repo name" });
    names.add(repo.name);

    if (repo.path.includes("..") || repo.path.startsWith("/")) {
      issues.push({ path: `${path}.path`, message: "must be relative and inside the root" });
    }
    if (!(CONFIDENCE_LEVELS as readonly string[]).includes(repo.confidence)) {
      issues.push({ path: `${path}.confidence`, message: `expected one of ${CONFIDENCE_LEVELS.join(" | ")}` });
    }
    for (const [slot, command] of Object.entries(repo.commands)) {
      if (command === null) continue;
      if (!isSingleArgvCommand(command)) {
        issues.push({ path: `${path}.commands.${slot}`, message: "must be a single argv (no & ; | > `)" });
      }
    }
  });
  return { ok: issues.length === 0, issues };
}

export function validateProcessDocument(doc: ProcessDocument): ValidationResult {
  const issues: ValidationIssue[] = [...validate("process", {
    schema_version: doc.version,
    methodology: doc.methodology,
    ticket_tool: doc.ticket_tool.kind,
    story_granularity: doc.story_granularity,
    approvers: doc.approvers,
    definition_of_done: doc.dod.add,
  }).issues];

  if (doc.approvers.length === 0) {
    issues.push({ path: "approvers", message: "must name at least one approver" });
  }
  if (doc.methodology === "scrum" && doc.cadence.sprint_length_days === null) {
    issues.push({ path: "cadence.sprint_length_days", message: "required when methodology is scrum" });
  }
  if (doc.ticket_tool.kind !== "none" && doc.ticket_tool.project === null) {
    issues.push({ path: "ticket_tool.project", message: "required unless ticket_tool.kind is none" });
  }
  return { ok: issues.length === 0, issues };
}

export function validateCompetenciesDocument(doc: CompetenciesDocument): ValidationResult {
  return validate("competencies", {
    schema_version: doc.version,
    expert: doc.expert,
    areas: doc.areas.map((area) => ({
      area: area.id,
      level: area.level,
      evidence: area.evidence.map((item) => item.src),
    })),
  });
}

export function formatIssues(label: string, result: ValidationResult): string {
  return [`${label} failed validation:`, ...result.issues.map((issue) =>
    `  ${issue.path === "" ? "(root)" : issue.path}: ${issue.message}`)].join("\n");
}
