/**
 * Schema for `tldrx-work/<run>/03-plan/stories/<id>.md` (spec §2.13).
 *
 * A story is the unit the Build phase picks up cold: one repo, one branch, one
 * Definition of Done that a hook can re-run. The machine-read half is the YAML
 * front matter; the ```dod block in the body is the other half, and it is the one
 * `dod-gate` executes before it will let `status: done` be written.
 *
 * Two rules here are worth their own sentence:
 *   - **A dod command must equal a `workspace.yml` command verbatim.** A story is
 *     data, and data does not get to invent a shell command (same rule spec §2.3
 *     puts on a stage's `cmd` check).
 *   - **`status: done` requires `evidence`.** Done means proven; a done story with
 *     an empty evidence list is an assertion.
 */
import {
  asDocument, requireEnum, requireKeys, result,
  type ValidationIssue, type ValidationResult,
} from "./validation.ts";
import {
  EPIC_ID_RE, MAX_TOUCHES, PLAN_STATUSES, REPO_NAME_RE, STORY_ID_RE,
  requirePattern, requireStringList, requireText, requireVersion1, type PlanStatus,
} from "./planCommon.ts";
import { parseFrontMatter } from "./frontMatter.ts";

export interface Story {
  readonly version: number;
  readonly id: string;
  readonly epic: string;
  readonly title: string;
  readonly repo: string;
  readonly status: PlanStatus;
  readonly depends_on: readonly string[];
  readonly touches: readonly string[];
  readonly acceptance: readonly string[];
  readonly test_plan: readonly string[];
  readonly evidence: readonly string[];
}

export const STORY_KEYS = [
  "version", "id", "epic", "title", "repo", "status",
  "depends_on", "touches", "acceptance", "test_plan", "evidence",
] as const;

/** The front matter only. Fast: required keys, enums, id shapes, list caps. */
export function validateStory(input: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  const doc = asDocument(input, issues);
  if (!doc) return result(issues);

  requireKeys(doc, STORY_KEYS, "", issues);
  requireVersion1(doc, issues);
  requirePattern(doc.id, STORY_ID_RE, "a story id like `S3`", "id", issues);
  requirePattern(doc.epic, EPIC_ID_RE, "an epic id like `E1`", "epic", issues);
  requireText(doc.title, "title", issues);
  requirePattern(doc.repo, REPO_NAME_RE, "a workspace.yml repo name", "repo", issues);
  requireEnum(doc.status, PLAN_STATUSES, "status", issues);

  const depends = requireStringList(doc.depends_on, "depends_on", issues, {
    pattern: STORY_ID_RE, patternName: "a story id like `S3`", unique: true,
  });
  if (typeof doc.id === "string" && depends.includes(doc.id)) {
    issues.push({ path: "depends_on", message: `\`${doc.id}\` cannot depend on itself` });
  }
  requireStringList(doc.touches, "touches", issues, { nonEmpty: true, max: MAX_TOUCHES });
  for (const [i, path] of (Array.isArray(doc.touches) ? doc.touches : []).entries()) {
    if (typeof path === "string" && path.includes("..")) {
      issues.push({ path: `touches[${i}]`, message: "`..` is not allowed in a touched path" });
    }
  }
  requireStringList(doc.acceptance, "acceptance", issues, { nonEmpty: true });
  requireStringList(doc.test_plan, "test_plan", issues, { nonEmpty: true });
  const evidence = requireStringList(doc.evidence, "evidence", issues);

  if (doc.status === "done" && Array.isArray(doc.evidence) && evidence.length === 0) {
    issues.push({
      path: "evidence",
      message: "a story at `status: done` must carry evidence — done means proven, not asserted",
    });
  }
  return result(issues);
}

export function asStory(input: unknown): Story {
  const doc = input as Partial<Story>;
  return {
    version: doc.version ?? 1,
    id: doc.id ?? "",
    epic: doc.epic ?? "",
    title: doc.title ?? "",
    repo: doc.repo ?? "",
    status: doc.status ?? "todo",
    depends_on: doc.depends_on ?? [],
    touches: doc.touches ?? [],
    acceptance: doc.acceptance ?? [],
    test_plan: doc.test_plan ?? [],
    evidence: doc.evidence ?? [],
  };
}

// --- the ```dod block -------------------------------------------------------

export interface DodBlock {
  readonly present: boolean;
  /** Non-blank, non-comment lines inside the fence, in order. */
  readonly commands: readonly string[];
}

const FENCE_OPEN_RE = /^\s*```+\s*dod\s*$/i;
const FENCE_CLOSE_RE = /^\s*```+\s*$/;

/**
 * The fenced ```dod block, by line scanning. Shared by `dod-gate` and the Plan
 * schema check so the two can never disagree about what the block contains.
 */
export function parseDodBlock(text: string): DodBlock {
  const commands: string[] = [];
  let present = false;
  let inside = false;
  for (const line of text.split("\n")) {
    if (inside) {
      if (FENCE_CLOSE_RE.test(line)) {
        inside = false;
        continue;
      }
      const command = line.trim();
      if (command !== "" && !command.startsWith("#")) commands.push(command);
      continue;
    }
    if (FENCE_OPEN_RE.test(line)) {
      present = true;
      inside = true;
    }
  }
  return { present, commands };
}

/**
 * Every dod command must be a `workspace.yml` command, verbatim.
 *
 * The old `[assumption]` here was that an EMPTY allowlist means "skip the rule",
 * by analogy with `resolveSrc`'s `cmd` source. The 2026-08-29 audit measured what
 * that analogy costs: `dod-gate` is installed as a default PreToolUse hook with a
 * 960 s timeout and runs each command through `/bin/sh -c`, so in a workspace with
 * no `commands:` — a fresh `tldrx init`, a repo whose detection found none — a
 * story saying `dod: rm -rf ~` was legal at plan time and executed at done time.
 *
 * An empty allowlist now REFUSES every command instead. The two cases are not
 * alike: a `cmd` citation is a claim about something that already ran, and this
 * is a list of things about to be run as the user.
 */
export function validateStoryDod(
  dod: DodBlock,
  allowed: ReadonlySet<string>,
  base = "dod",
): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!dod.present) {
    issues.push({ path: base, message: "no fenced ```dod block — the gate has nothing to re-run" });
    return issues;
  }
  if (dod.commands.length === 0) {
    issues.push({ path: base, message: "the ```dod block is empty — done means proven, not asserted" });
    return issues;
  }
  if (allowed.size === 0) {
    dod.commands.forEach((command, i) => {
      issues.push({ path: `${base}[${i}]`, message: noAllowlistMessage(command) });
    });
    return issues;
  }
  dod.commands.forEach((command, i) => {
    if (allowed.has(command)) return;
    issues.push({
      path: `${base}[${i}]`,
      message: `\`${command}\` is not one of .tldrx/workspace.yml's commands — a story may not invent one`,
    });
  });
  return issues;
}

/** Shared by the schema and the hook, so the two never word the refusal differently. */
export function noAllowlistMessage(command: string): string {
  return `\`${command}\` cannot be allowed: .tldrx/workspace.yml declares no commands, so there is `
    + "nothing to check it against. Add the command under the repo's `commands:` — a dod block is run "
    + "for real, as you, and an empty allowlist is not a permit.";
}

export interface StoryFile {
  readonly story: Story | null;
  readonly dod: DodBlock;
  readonly validation: ValidationResult;
}

/** Read one `stories/<id>.md`: front matter + dod block, validated together. */
export function validateStoryFile(text: string, allowed: ReadonlySet<string> = new Set()): StoryFile {
  const parsed = parseFrontMatter(text);
  const dod = parseDodBlock(parsed.frontMatter.body);
  if (parsed.issue !== null) {
    return { story: null, dod, validation: result([parsed.issue]) };
  }
  const front = validateStory(parsed.doc);
  const issues = [...front.issues, ...validateStoryDod(dod, allowed)];
  return {
    story: front.ok ? asStory(parsed.doc) : null,
    dod,
    validation: result(issues),
  };
}
