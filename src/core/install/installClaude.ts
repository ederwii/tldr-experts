/**
 * `tldrx install --claude` — put the facilitator skill, the six hooks and the
 * status line into a real `.claude/`, without a plugin and without `init`.
 *
 * Why this exists (Alan, 2026-08-29): the skill must be installable independently
 * of `tldrx init`. `--plugin-dir ./plugin` is a per-session flag and needs the
 * checkout; `init` is about a *workspace*, not about the editor. This command is
 * the third door: a persistent project or user setup, written into files Claude
 * Code already reads.
 *
 * The whole command is a PLAN and an APPLY. `planInstall` reads, decides and
 * computes every byte that would be written; `applyInstall` writes them. `--dry-run`
 * is therefore not a second code path that might disagree — it is the same plan,
 * printed and thrown away.
 *
 * Two things it will not do, ever: touch `permissions` (that is the user's blast
 * radius, not ours), and overwrite a file it does not own (a `SKILL.md` with no
 * marker, a foreign `statusLine`).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import {
  parseSettings, serializeSettings, type ClaudeSettings, type SettingsFormat,
} from "./ClaudeSettings.ts";
import { mergeSettings, unmergeSettings, type StatusLineOutcome } from "./mergeSettings.ts";
import { HOOK_SCRIPTS, MANAGED_HOOKS, STATUSLINE_COMMAND } from "./managedEntries.ts";
import { isManagedSkill, managedSkill, SKILL_RELATIVE } from "./skillFile.ts";

export class InstallError extends Error {}

export type InstallScope = "project" | "user";

export interface InstallOptions {
  readonly scope: InstallScope;
  /** Workspace root for `--project`. Must be a git repo (spec: cwd = workspace root). */
  readonly cwd: string;
  readonly home: string;
  readonly skill: boolean;
  readonly hooks: boolean;
  readonly statusline: boolean;
  readonly forceStatusline: boolean;
  readonly uninstall: boolean;
  /** Absolute path of `plugin/skills/tldrx/SKILL.md` — the source of truth. */
  readonly pluginSkill: string;
  /** Stamp for the backup filename, so a test can pin it. */
  readonly at: string;
}

export type ChangeAction = "write" | "delete" | "unchanged" | "absent";

export interface FileChange {
  readonly path: string;
  readonly action: ChangeAction;
  /** Present for `write`. */
  readonly content?: string;
}

export interface InstallPlan {
  readonly claudeDir: string;
  readonly options: InstallOptions;
  readonly changes: readonly FileChange[];
  /** `settings.json.bak-tldrx-<ts>` when settings.json exists and will change. */
  readonly backup: { readonly path: string; readonly content: string } | null;
  readonly skill: ChangeAction;
  readonly addedHooks: readonly string[];
  readonly keptHooks: readonly string[];
  readonly removedHooks: readonly string[];
  readonly statusLine: StatusLineOutcome | "removed" | "not-ours";
  readonly foreignStatusLine: string | null;
}

export function claudeDirFor(options: InstallOptions): string {
  return join(options.scope === "user" ? options.home : options.cwd, ".claude");
}

/** Nearest ancestor of `start` holding a `.git` (directory or worktree file). */
export function findGitRoot(start: string): string | null {
  let current = start;
  for (let i = 0; i < 64; i++) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

export function planInstall(options: InstallOptions): InstallPlan {
  if (options.scope === "project" && findGitRoot(options.cwd) === null) {
    throw new InstallError(
      `${options.cwd} is not inside a git repository — a project install writes a committed`
      + " .claude/, so it refuses to guess a root. Use --user for a machine-wide install.",
    );
  }
  const claudeDir = claudeDirFor(options);
  const settingsPath = join(claudeDir, "settings.json");
  const skillPath = join(claudeDir, SKILL_RELATIVE);

  const changes: FileChange[] = [];
  const skill = options.skill
    ? (options.uninstall ? planSkillRemoval(skillPath, changes) : planSkillWrite(options, skillPath, changes))
    : "absent";

  const before = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : null;
  const loaded = parseSettings(before, settingsPath);
  const wantsSettings = options.hooks || options.statusline;

  let next: ClaudeSettings = loaded.settings;
  let addedHooks: readonly string[] = [];
  let keptHooks: readonly string[] = [];
  let removedHooks: readonly string[] = [];
  let statusLine: InstallPlan["statusLine"] = "off";
  let foreignStatusLine: string | null = null;

  if (wantsSettings && options.uninstall) {
    const result = unmergeSettings(loaded.settings);
    next = result.settings;
    removedHooks = options.hooks ? result.removedHooks : [];
    if (!options.hooks) next = loaded.settings; // --no-hooks on an uninstall: leave them
    statusLine = result.removedStatusLine && options.statusline ? "removed" : "not-ours";
    if (!options.statusline) next = reattachStatusLine(next, loaded.settings);
  } else if (wantsSettings) {
    const result = mergeSettings(loaded.settings, {
      hooks: options.hooks,
      statusline: options.statusline,
      forceStatusline: options.forceStatusline,
    });
    next = result.settings;
    addedHooks = result.addedHooks;
    keptHooks = result.keptHooks;
    statusLine = result.statusLine;
    foreignStatusLine = result.foreignStatusLine;
  }

  let backup: InstallPlan["backup"] = null;
  if (wantsSettings) {
    const text = renderSettings(next, loaded.format, before);
    if (text === before) {
      changes.push({ path: settingsPath, action: "unchanged" });
    } else if (text === null) {
      changes.push({ path: settingsPath, action: "absent" });
    } else {
      changes.push({ path: settingsPath, action: "write", content: text });
      if (before !== null) backup = { path: freeBackupPath(settingsPath, options.at), content: before };
    }
  }

  return {
    claudeDir, options, changes, backup, skill,
    addedHooks, keptHooks, removedHooks, statusLine, foreignStatusLine,
  };
}

/** Write every planned change. Returns the paths touched, in order. */
export function applyInstall(plan: InstallPlan): readonly string[] {
  const touched: string[] = [];
  if (plan.backup !== null) {
    mkdirSync(dirname(plan.backup.path), { recursive: true });
    writeFileSync(plan.backup.path, plan.backup.content, "utf8");
    touched.push(plan.backup.path);
  }
  for (const change of plan.changes) {
    if (change.action === "write" && change.content !== undefined) {
      mkdirSync(dirname(change.path), { recursive: true });
      writeFileSync(change.path, change.content, "utf8");
      touched.push(change.path);
    } else if (change.action === "delete") {
      rmSync(change.path, { force: true });
      pruneEmpty(dirname(change.path), plan.claudeDir);
      touched.push(change.path);
    }
  }
  return touched;
}

/** The 4–6 line report. Same text for `--dry-run`, which simply does not apply. */
export function renderInstallSummary(plan: InstallPlan, dryRun: boolean): string {
  const { options } = plan;
  const mode = options.uninstall ? " --uninstall" : "";
  const dry = dryRun ? " (dry run — nothing written)" : "";
  const lines = [`tldrx install --claude --${options.scope}${mode}${dry} → ${plan.claudeDir}`];

  if (options.skill) {
    lines.push(`  skill       ${SKILL_RELATIVE} — ${skillWord(plan.skill)}`);
  }
  if (options.hooks) lines.push(`  hooks       settings.json — ${hooksWord(plan)}`);
  if (options.statusline) lines.push(`  statusline  settings.json — ${statusWord(plan)}`);
  if (plan.backup !== null) lines.push(`  backup      ${short(plan.backup.path, plan.claudeDir)}`);

  lines.push(
    options.uninstall
      ? "Restart Claude Code to drop them."
      : "Restart Claude Code to load them; `tldrx doctor` checks the rest.",
  );
  return `${lines.join("\n")}\n`;
}

/** Advice printed when someone else's status line is already installed. */
export function chainStatusLineHint(foreign: string | null): string {
  const existing = foreign ?? "your existing command";
  return [
    `.claude/settings.json already has a statusLine (\`${existing}\`) that is not tldrx's — leaving it alone.`,
    "To run both, point statusLine at a script of your own that calls each and joins the output:",
    `  ${existing} ; printf ' | ' ; tldrx statusline`,
    "or re-run with --force-statusline to replace it.",
  ].join("\n");
}

function planSkillWrite(options: InstallOptions, skillPath: string, changes: FileChange[]): ChangeAction {
  if (!existsSync(options.pluginSkill)) {
    throw new InstallError(`no skill to install at ${options.pluginSkill} — is this a complete tldrx install?`);
  }
  const wanted = managedSkill(readFileSync(options.pluginSkill, "utf8"));
  if (existsSync(skillPath)) {
    const current = readFileSync(skillPath, "utf8");
    if (!isManagedSkill(current)) {
      throw new InstallError(
        `${skillPath} exists and is not tldrx-managed (no \`<!-- tldrx-managed -->\` marker)`
        + " — refusing to overwrite it. Move it aside, or add the marker line to adopt it.",
      );
    }
    if (current === wanted) {
      changes.push({ path: skillPath, action: "unchanged" });
      return "unchanged";
    }
  }
  changes.push({ path: skillPath, action: "write", content: wanted });
  return "write";
}

function planSkillRemoval(skillPath: string, changes: FileChange[]): ChangeAction {
  if (!existsSync(skillPath)) {
    changes.push({ path: skillPath, action: "absent" });
    return "absent";
  }
  if (!isManagedSkill(readFileSync(skillPath, "utf8"))) {
    changes.push({ path: skillPath, action: "unchanged" });
    return "unchanged";
  }
  changes.push({ path: skillPath, action: "delete" });
  return "delete";
}

/**
 * The bytes to write, or null when there is nothing to write at all (no settings
 * file before, and nothing of ours to put in one).
 */
function renderSettings(settings: ClaudeSettings, format: SettingsFormat, before: string | null): string | null {
  if (before === null && Object.keys(settings).length === 0) return null;
  return serializeSettings(settings, format);
}

/** Put back a statusLine that `--no-statusline` said not to touch. */
function reattachStatusLine(next: ClaudeSettings, original: ClaudeSettings): ClaudeSettings {
  if (original.statusLine === undefined) return next;
  return { ...next, statusLine: original.statusLine };
}

/** Remove now-empty directories up to (but never including) `.claude/`. */
function pruneEmpty(dir: string, stopAt: string): void {
  let current = dir;
  while (current.startsWith(stopAt + sep) && current !== stopAt) {
    try {
      if (readdirSync(current).length > 0) return;
      rmdirSync(current);
    } catch {
      return;
    }
    current = dirname(current);
  }
}

function skillWord(action: ChangeAction): string {
  return action === "write" ? "written"
    : action === "delete" ? "removed"
    : action === "unchanged" ? "already current"
    : "not present";
}

function hooksWord(plan: InstallPlan): string {
  if (plan.options.uninstall) {
    return plan.removedHooks.length === 0
      ? "no tldrx handlers to remove"
      : `${plan.removedHooks.length} handler(s) removed`;
  }
  return `${HOOK_SCRIPTS.length} hooks / ${MANAGED_HOOKS.length} handlers`
    + ` (${plan.addedHooks.length} added, ${plan.keptHooks.length} already there)`;
}

function statusWord(plan: InstallPlan): string {
  switch (plan.statusLine) {
    case "set": return `statusLine → \`${STATUSLINE_COMMAND}\` (set)`;
    case "replaced": return `statusLine → \`${STATUSLINE_COMMAND}\` (replaced \`${plan.foreignStatusLine ?? "?"}\`)`;
    case "already-ours": return `statusLine → \`${STATUSLINE_COMMAND}\` (already set)`;
    case "skipped-foreign": return `left \`${plan.foreignStatusLine ?? "?"}\` alone — see the note below`;
    case "removed": return "statusLine removed";
    case "not-ours": return "statusLine is not tldrx's — left alone";
    default: return "not touched";
  }
}

function short(path: string, claudeDir: string): string {
  const rel = relative(claudeDir, path);
  return rel.startsWith("..") ? path : rel;
}

/** `2026-08-29T10:15:00Z` -> `20260829T101500Z`, which is filename-safe. */
function stamp(at: string): string {
  return at.replace(/[-:]/g, "");
}

/**
 * A backup name nothing is using yet. Timestamps are second-resolution, so an
 * install and its uninstall a moment later would otherwise write the same name —
 * and the second write would replace the ORIGINAL file with the installed one,
 * which is the exact content a backup exists to protect. A suffix is added instead.
 */
function freeBackupPath(settingsPath: string, at: string): string {
  const base = `${settingsPath}.bak-tldrx-${stamp(at)}`;
  if (!existsSync(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`;
    if (!existsSync(candidate)) return candidate;
  }
  return `${base}-${process.pid}`;
}
