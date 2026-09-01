/**
 * `tldrx plan sync-dod` — carrying an edited `workspace.yml` into the dod blocks
 * of stories that are already approved.
 *
 * The rule this serves is NOT relaxed here and must never be: a story's ```dod
 * block may only name commands `workspace.yml` declares, byte for byte, because
 * a data file does not get to invent a command that will be run as the user
 * (`commandAllowlist.ts`). What the rule lacked was an inverse. Measured live on
 * `260829-scoring-leaderboard` (2026-08-31): fixing workspace.yml — a filtered
 * `test:`, `lint:` deleted — instantly orphaned the dod blocks of **8 approved
 * stories**, and the two recoveries on offer were hand-editing agent-approved
 * artefacts (a provenance smell) or re-running the whole Plan stage to change two
 * lines in eight files (a paid turn that churns thirteen correct stories).
 *
 * So this rewrite is mechanical, evidence-led, and refuses to guess:
 *
 *   - a line the CURRENT workspace still declares is left exactly alone;
 *   - a line a PREVIOUS version declared under a role the current file still has
 *     becomes that role's current command (a rename, followed);
 *   - a line whose role is gone is DROPPED (a command removed);
 *   - a line no version ever declared is FLAGGED, and its story is not written at
 *     all — that is real drift, and inventing an ancestor for it is the one thing
 *     this must not do;
 *   - a line whose ancestry is ambiguous (two roles once shared it, and they now
 *     disagree) is flagged for the same reason.
 *
 * Nothing outside the command lines moves: the front matter, the prose, the
 * blank lines and the fences come back byte-identical, and the result is handed
 * to the SAME plan check the drift came from.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DOD_FENCE_CLOSE_RE, DOD_FENCE_OPEN_RE, parseDodBlock } from "../schemas/story.ts";
import { SYNC_DOD_COMMAND } from "../schemas/commandAllowlist.ts";
import { readStory } from "../../hooks/lib/story.ts";
import { rolesThatNamed, type CommandHistory } from "./workspaceHistory.ts";
import { STORIES_DIR } from "./validatePlan.ts";

export { SYNC_DOD_COMMAND };

/** One dod line, resolved. `to: null` is a command the workspace no longer has. */
export interface DodChange {
  readonly from: string;
  readonly to: string | null;
  /** The `workspace.yml` key the substitution was read off. */
  readonly role: string;
}

/** One dod line this refuses to touch, and the reason in one sentence. */
export interface DodProblem {
  readonly command: string;
  readonly why: string;
}

export interface StorySync {
  readonly id: string;
  /** Absolute path of the story file. */
  readonly path: string;
  /** Run-relative-ish path, for the summary. */
  readonly rel: string;
  readonly repo: string;
  readonly changes: readonly DodChange[];
  readonly problems: readonly DodProblem[];
  /** The file as it would be written, or null when nothing is to be written. */
  readonly text: string | null;
}

export interface SyncReport {
  readonly stories: readonly StorySync[];
  /** Stories with a rewrite to apply. */
  readonly changed: readonly StorySync[];
  /** Stories left untouched because a line has no ancestor. */
  readonly flagged: readonly StorySync[];
}

export interface SyncInput {
  /** The run's `03-plan/` directory. */
  readonly planDir: string;
  /** `workspace.commandRoles` — `repo -> {role -> command}` as it is TODAY. */
  readonly current: ReadonlyMap<string, ReadonlyMap<string, string>>;
  readonly history: CommandHistory;
}

export function planSyncDod(input: SyncInput): SyncReport {
  const dir = join(input.planDir, STORIES_DIR);
  const stories: StorySync[] = [];
  if (existsSync(dir)) {
    for (const name of readdirSync(dir).filter((entry) => entry.endsWith(".md")).sort()) {
      stories.push(syncOne(join(dir, name), name, input));
    }
  }
  return {
    stories,
    changed: stories.filter((story) => story.text !== null),
    flagged: stories.filter((story) => story.problems.length > 0),
  };
}

function syncOne(path: string, name: string, input: SyncInput): StorySync {
  const text = readFileSync(path, "utf8");
  const id = name.replace(/\.md$/, "");
  const rel = `${STORIES_DIR}/${name}`;
  // The hook's line scanner, not the schema: a story whose front matter does not
  // parse still has a `repo:` and still has a dod block, and it is exactly the
  // kind of file that needs resyncing rather than a second complaint.
  const repo = readStory(text).repo ?? "";
  const dod = parseDodBlock(text);
  const empty: StorySync = { id, path, rel, repo, changes: [], problems: [], text: null };
  if (!dod.present || dod.commands.length === 0) return empty;

  const roles = input.current.get(repo) ?? new Map<string, string>();
  const declared = new Set(roles.values());
  const changes: DodChange[] = [];
  const problems: DodProblem[] = [];
  const replacements: (string | null)[] = [];
  const kept = new Set<string>();

  for (const command of dod.commands) {
    if (declared.has(command)) {
      // Already current. A duplicate of a line already kept still collapses —
      // two substitutions can land on the same command.
      replacements.push(kept.has(command) ? null : command);
      kept.add(command);
      continue;
    }
    const ancestors = rolesThatNamed(input.history, repo, command);
    if (ancestors.length === 0) {
      problems.push({
        command,
        why: `no version of .tldrx/workspace.yml has ever declared it for repo \`${repo}\` — `
          + "that is real drift, not a rename, so it is left for a human to decide",
      });
      replacements.push(command);
      continue;
    }
    const outcomes = new Set(ancestors.map((role) => roles.get(role) ?? null));
    if (outcomes.size > 1) {
      problems.push({
        command,
        why: `it was declared under ${ancestors.map((role) => `\`${role}\``).join(" and ")}, `
          + "which no longer name the same command — the substitution is ambiguous",
      });
      replacements.push(command);
      continue;
    }
    const role = ancestors[0] ?? "";
    const next = [...outcomes][0] ?? null;
    changes.push({ from: command, to: next, role });
    if (next === null || kept.has(next)) {
      replacements.push(null);
      continue;
    }
    kept.add(next);
    replacements.push(next);
  }

  if (problems.length > 0) return { id, path, rel, repo, changes, problems, text: null };
  if (kept.size === 0) {
    return {
      id,
      path,
      rel,
      repo,
      changes,
      problems: [{
        command: dod.commands.join(", "),
        why: "every command it names has been removed from workspace.yml — a story with an empty dod "
          + "block can prove nothing, so this one needs a decision, not a rewrite",
      }],
      text: null,
    };
  }
  if (changes.length === 0) return empty;

  const rewritten = rewriteDodBlock(text, replacements);
  return { id, path, rel, repo, changes, problems, text: rewritten === text ? null : rewritten };
}

/**
 * Replace the i-th COMMAND line of the ```dod block with `replacements[i]`, or
 * remove the line when that is null.
 *
 * Everything else is pushed through untouched, so the file that comes back
 * differs from the file that went in only on the lines this was asked to change.
 * Blank lines and `#` comments inside the fence are not commands (the parser
 * skips them) and are not counted or rewritten here either.
 */
export function rewriteDodBlock(text: string, replacements: readonly (string | null)[]): string {
  const out: string[] = [];
  let inside = false;
  let index = 0;
  for (const line of text.split("\n")) {
    if (!inside) {
      out.push(line);
      if (DOD_FENCE_OPEN_RE.test(line)) inside = true;
      continue;
    }
    if (DOD_FENCE_CLOSE_RE.test(line)) {
      inside = false;
      out.push(line);
      continue;
    }
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      out.push(line);
      continue;
    }
    const next = replacements[index];
    index += 1;
    if (next === undefined) {
      out.push(line);
      continue;
    }
    if (next === null) continue;
    out.push(`${line.slice(0, line.length - line.trimStart().length)}${next}`);
  }
  return out.join("\n");
}

/** The per-story diff summary, one block per story that moved or was flagged. */
export function renderSyncReport(report: SyncReport, dryRun: boolean): readonly string[] {
  const lines: string[] = [];
  for (const story of report.stories) {
    if (story.changes.length === 0 && story.problems.length === 0) continue;
    lines.push(`${story.id} (${story.rel}, repo ${story.repo})`);
    for (const change of story.changes) {
      lines.push(change.to === null
        ? `  - ${change.from}      [\`${change.role}:\` is no longer declared — dropped]`
        : `  - ${change.from}\n  + ${change.to}      [\`${change.role}:\`]`);
    }
    for (const problem of story.problems) {
      lines.push(`  ! ${problem.command} — ${problem.why}`);
    }
  }
  const changed = report.changed.length;
  const flagged = report.flagged.length;
  if (lines.length === 0) {
    lines.push("every story's dod block already names the commands workspace.yml declares — nothing to do.");
    return lines;
  }
  lines.push("");
  lines.push(dryRun
    ? `--dry-run: ${String(changed)} story(ies) would be rewritten, ${String(flagged)} flagged. Nothing was written.`
    : `${String(changed)} story(ies) rewritten, ${String(flagged)} flagged and left untouched.`);
  if (flagged > 0) {
    lines.push(
      "A flagged line has no ancestor in workspace.yml's history, so it is not a rename this can follow. "
      + "Decide it by hand: declare the command under the repo's `commands:`, or reopen the story.",
    );
  }
  return lines;
}
