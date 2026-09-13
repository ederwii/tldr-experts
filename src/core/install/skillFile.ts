/**
 * `.claude/skills/tldrx/SKILL.md` — the facilitator, installed without the plugin.
 *
 * Project skills live at `.claude/skills/<name>/SKILL.md` and user skills at
 * `~/.claude/skills/<name>/SKILL.md` (verified from code.claude.com/docs, 2026-08-28),
 * so the only difference between `--project` and `--user` is which root we prefix.
 *
 * The body is a copy of `plugin/skills/tldrx/SKILL.md` with one line added: a
 * `<!-- tldrx-managed -->` marker directly under the frontmatter. JSON has no
 * comments and that is why `settings.json` is matched on command strings — Markdown
 * does, so here the marker is the ownership test, and it is a strict one. An
 * existing `SKILL.md` without it is somebody's own file: install refuses rather
 * than overwrite, and uninstall leaves it alone.
 *
 * `disable-model-invocation: true` comes along in the frontmatter unchanged. That
 * is the non-intrusive requirement (concept §1.3) — the skill's body stays out of
 * context until a human types `/tldrx`.
 */

export const SKILL_MARKER = "<!-- tldrx-managed -->";

/** Where the facilitator skill goes, relative to `.claude/`. */
export const SKILL_RELATIVE = "skills/tldrx/SKILL.md";

/**
 * Where the PLANNING skill goes (#291) — `tldrx-plan`, installed beside the
 * facilitator by the same command, under the same marker and the same
 * foreign-file rule. Two skills, one ownership test: a `SKILL.md` at either path
 * without the marker is somebody's own file.
 */
export const PLAN_SKILL_RELATIVE = "skills/tldrx-plan/SKILL.md";

/** One managed skill: where it is installed, and where its source lives in `plugin/`. */
export interface ManagedSkill {
  /** Relative to `.claude/` on install and to `plugin/` as the source — the same path. */
  readonly relative: string;
  /** Word used in the install summary. */
  readonly label: string;
}

/** Every skill `tldrx install --claude` owns, in summary order. */
export const MANAGED_SKILLS: readonly ManagedSkill[] = [
  { relative: SKILL_RELATIVE, label: "skill" },
  { relative: PLAN_SKILL_RELATIVE, label: "skill" },
];

/**
 * The plugin's SKILL.md with the marker inserted under the frontmatter, plus one
 * line saying where it came from. Idempotent: text that already carries the marker
 * is returned unchanged, so re-installing after an upgrade compares equal when the
 * source has not moved.
 */
export function managedSkill(source: string): string {
  if (source.includes(SKILL_MARKER)) return source;
  const block = [
    SKILL_MARKER,
    "<!-- Installed by `tldrx install --claude`. Edits are overwritten on the next",
    "     install; delete the marker line above to make this file your own. -->",
  ].join("\n");
  const end = frontmatterEnd(source);
  if (end === -1) return `${block}\n\n${source}`;
  return `${source.slice(0, end)}${block}\n${source.slice(end)}`;
}

export function isManagedSkill(text: string): boolean {
  return text.includes(SKILL_MARKER);
}

/** Index just past the closing `---` line of the frontmatter, or -1. */
function frontmatterEnd(text: string): number {
  if (!text.startsWith("---\n")) return -1;
  const close = text.indexOf("\n---\n", 3);
  return close === -1 ? -1 : close + "\n---\n".length;
}
