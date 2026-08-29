/**
 * `.tldrx/conventions/shared.md` and `.tldrx/conventions/<repo>.md`.
 *
 * Two different kinds of document, deliberately:
 *  - `shared.md` holds DEFAULTS — how this team wants to work. They are choices,
 *    not observations, so they carry no citations and claim none.
 *  - `<repo>.md` holds what the repo's own tooling enforces, and every line of it
 *    cites the config file that does the enforcing.
 */
import { srcToken } from "../map/srcToken.ts";
import { COMMAND_SLOTS, type DetectedRepo } from "../detect/types.ts";
import { gapSrc } from "../detect/gapSrc.ts";
import type { ConventionSignal } from "../map/conventionSignals.ts";

export const CONVENTIONS_DIR = ".tldrx/conventions";

export function renderSharedConventions(): string {
  return [
    "# Shared conventions",
    "",
    "> Defaults written by `tldrx init`. These are the team's CHOICES, not detected facts,",
    "> so they carry no citations. Edit freely — `init` never overwrites this file.",
    "",
    "## Definition of work",
    "",
    "- A story is not done until a test covers its behaviour and the suite passes.",
    "- Done means proven. Filing a ticket, opening a PR and merging are not done.",
    "- If a claim has no source, it is not a finding — it is an unknown.",
    "",
    "## Code",
    "",
    "- One class, record, interface or enum per file, named after the thing it defines.",
    "- Small functions with early returns; nesting deeper than two levels is a refactor.",
    "- Keep cyclomatic complexity low — a function you cannot describe in one sentence is two functions.",
    "- Reusable over clever: boring code that is read twice beats clever code written once.",
    "- Delete dead code instead of commenting it out; git remembers.",
    "- No unexplained magic values — name them or cite where they came from.",
    "",
    "## Change",
    "",
    "- Run the repo's own gate (`build`, `test`, `lint`, `typecheck` from `workspace.yml`) before claiming green.",
    "- Check exit codes explicitly; a pipe or a grep between you and a failure hides it.",
    "- One concern per commit, and a message that says why rather than what.",
    "",
  ].join("\n");
}

export function renderRepoConventions(
  repo: DetectedRepo,
  signals: readonly ConventionSignal[],
): string {
  const lines: string[] = [
    `# Conventions — ${repo.name}`,
    "",
    "> Detected by `tldrx init` from the config files in this repo. Every bullet cites the",
    "> file that enforces it. A convention nothing enforces does not belong here — put it in",
    "> `shared.md` and say it is a choice.",
    "",
    "## Enforced by tooling",
    "",
  ];

  if (signals.length === 0) {
    lines.push(`- No linter, formatter or editor config found in this repo ${srcToken([`absent:${repo.path}`])}`);
  }
  for (const signal of signals) {
    lines.push(`- ${signal.what} ${srcToken([`${repo.name}:${signal.path}:${signal.line}`])}`);
  }

  lines.push("", "## Gate commands", "");
  const known = COMMAND_SLOTS.filter((slot) => repo.commands[slot] !== null);
  if (known.length === 0) {
    lines.push(
      "- No commands were detected — nothing may be run in this repo until someone says what "
      + srcToken([gapSrc(repo)]),
    );
  }
  for (const slot of known) {
    lines.push(`- \`${slot}\`: \`${repo.commands[slot] ?? ""}\` ${srcToken([".tldrx/workspace.yml:1"])}`);
  }
  lines.push("");
  return lines.join("\n");
}
